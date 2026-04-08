"""SSE broker -- background data collection, change detection, client push.

Manages a set of connected SSE clients (thread-safe queue per client).
A single background thread collects data from registered sources, hashes for
changes, and pushes typed events only when data differs.

Sources register via register_source(SSESource) -- core sources are registered
internally at construction for backward compatibility; plugins add their own
sources dynamically before start().
"""

import hashlib
import json
import logging
import math
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import realm_db
from traffic_precompute import compute_traffic

log = logging.getLogger(__name__)

TICK_SECONDS = 5  # Base tick interval for the collect loop


@dataclass
class SSESource:
    """A registered SSE data source.

    Attributes:
        name: Human-readable source identifier (e.g. "energy", "latency").
        event_type: SSE event type string sent to clients.
        collect_fn: Callable returning data dict (or None to skip).
        interval_seconds: How often to collect, in seconds (minimum 5, ceiled to tick).
        burst: Whether to include in initial burst to new clients.
        burst_priority: Order within burst (lower = earlier). Core topology=1,
            traffic=2, plugin sources typically 3-10, events=90, status=99.
        burst_filter: Optional callable(data) -> bool to filter burst data
            (e.g. energy skips if "error" in data).
    """
    name: str
    event_type: str
    collect_fn: Callable
    interval_seconds: int = 30
    burst: bool = False
    burst_priority: int = 50
    burst_filter: Optional[Callable] = None
    # Computed at registration
    _tick_interval: int = field(init=False, default=1)

    def __post_init__(self):
        # Minimum 5s, ceil to nearest tick
        clamped = max(self.interval_seconds, TICK_SECONDS)
        self._tick_interval = math.ceil(clamped / TICK_SECONDS)


class SSEBroker:
    def __init__(self, status_fn):
        """Initialize broker.

        Args:
            status_fn: callable returning the full status dict (map_server.build_status).
                This is the only required source -- all others register via register_source().
        """
        self._status_fn = status_fn
        self._clients = []  # list of queue.Queue
        self._client_ts = {}  # {id(queue): last_successful_write_time}
        self._lock = threading.Lock()
        self._hashes = {}  # {event_type: last_hash}
        self._last_event_ts = 0.0
        self._running = False
        self._sources = []  # list of SSESource (plugin + migrated core sources)
        self._sources_lock = threading.Lock()
        self._event_id = 0  # monotonic SSE event ID

    # ── Source Registration ──

    def register_source(self, source: SSESource):
        """Register a data source for periodic collection and optional burst.

        Must be called before start() for sources to participate in the collect loop.
        Thread-safe for dynamic registration, but sources added after start() will
        only take effect on the next tick.
        """
        source.__post_init__()  # Recompute _tick_interval in case interval was changed
        with self._sources_lock:
            # Replace existing source with same event_type
            self._sources = [s for s in self._sources if s.event_type != source.event_type]
            self._sources.append(source)
        log.info("SSE source registered: %s (event=%s, interval=%ds, burst=%s priority=%d)",
                 source.name, source.event_type, source.interval_seconds,
                 source.burst, source.burst_priority)

    def get_sources(self):
        """Return a snapshot of registered sources (for introspection)."""
        with self._sources_lock:
            return list(self._sources)

    # ── Client Management ──

    def add_client(self):
        """Register a new SSE client. Returns a Queue that receives (event_type, data_json) tuples.
        Sends initial burst of data so browser is fully populated on connect.

        Burst sequence:
        1. Core: topology -> traffic (hardcoded, structural)
        2. Registered sources with burst=True, ordered by burst_priority
        3. Core: recent events -> status (status last = dismisses loading screen)
        """
        q = queue.Queue(maxsize=100)
        _json = lambda d: json.dumps(d, separators=(',', ':'))
        topo_nodes = []

        # ── Phase 1: Topology (structural, always first) ──
        try:
            topo = realm_db.get_topology()
            topo_nodes = topo.get("nodes", [])
            self._event_id += 1
            q.put_nowait(("topology", _json(topo), self._event_id))
        except Exception:
            log.warning("SSE burst: failed to send topology", exc_info=True)

        # ── Phase 1b: Traffic (depends on topo_nodes) ──
        if topo_nodes:
            try:
                traffic = compute_traffic(topo_nodes)
                if traffic:
                    self._event_id += 1
                q.put_nowait(("traffic", _json(traffic), self._event_id))
            except Exception:
                log.warning("SSE burst: failed to send traffic", exc_info=True)

        # ── Phase 2: Registered burst sources, ordered by priority ──
        with self._sources_lock:
            burst_sources = sorted(
                [s for s in self._sources if s.burst],
                key=lambda s: s.burst_priority
            )
        for source in burst_sources:
            try:
                data = source.collect_fn()
                if data is None:
                    continue
                if source.burst_filter and not source.burst_filter(data):
                    continue
                self._event_id += 1
                q.put_nowait((source.event_type, _json(data), self._event_id))
            except Exception:
                log.warning("SSE burst: failed to send %s", source.name, exc_info=True)

        # ── Phase 3a: Events BEFORE status (processed in restore mode) ──
        # 15-min window covers BUBBLE_RESTORE_AGE (10 min) with margin.
        # 200-event cap protects queue capacity.
        try:
            recent_events = realm_db.get_events_since(time.time() - 900)
            evt_count = 0
            for evt in recent_events:
                self._event_id += 1
                q.put_nowait(("realm-event", _json(evt), self._event_id))
                evt_count += 1
                if evt_count >= 200:
                    break
        except Exception:
            log.warning("SSE burst: failed to send recent events", exc_info=True)

        # ── Phase 3b: Status LAST (flips to live mode + dismisses loading screen) ──
        try:
            status = self._status_fn()
            self._event_id += 1
            q.put_nowait(("status", _json(status), self._event_id))
        except Exception:
            log.warning("SSE burst: failed to send status", exc_info=True)

        with self._lock:
            self._clients.append(q)
            self._client_ts[id(q)] = time.time()
        return q

    def remove_client(self, q):
        """Unregister an SSE client."""
        with self._lock:
            try:
                self._clients.remove(q)
            except ValueError:
                pass
            self._client_ts.pop(id(q), None)

    def client_wrote(self, q):
        """Mark a client as having successfully written (called by SSE handler)."""
        with self._lock:
            self._client_ts[id(q)] = time.time()

    # ── Broadcasting ──

    def _broadcast(self, event_type, payload):
        """Send an event to all connected clients.

        Args:
            event_type: SSE event name.
            payload: pre-serialized JSON string ready for the wire.
        """
        self._event_id += 1
        event_id = self._event_id
        dead = []
        now = time.time()
        with self._lock:
            for q in self._clients:
                try:
                    q.put_nowait((event_type, payload, event_id))
                except queue.Full:
                    dead.append(q)
                else:
                    # Evict clients that haven't consumed from their queue in 60s.
                    # This catches half-open TCP connections where wfile.write hangs.
                    last = self._client_ts.get(id(q), now)
                    if now - last > 60:
                        dead.append(q)
            for q in dead:
                try:
                    self._clients.remove(q)
                except ValueError:
                    pass
                self._client_ts.pop(id(q), None)
        if dead:
            log.info("SSE: evicted %d stale client(s), %d active",
                     len(dead), len(self._clients))

    def _check_and_push(self, event_type, data):
        """Serialize once, hash the bytes, broadcast only if changed."""
        payload = json.dumps(data, sort_keys=True, separators=(',', ':'))
        h = hashlib.md5(payload.encode()).hexdigest()[:12]
        if h != self._hashes.get(event_type):
            self._hashes[event_type] = h
            self._broadcast(event_type, payload)
            return True
        return False

    def send_event(self, event_type, data):
        """Public: broadcast an event to all clients immediately."""
        payload = json.dumps(data, separators=(',',':'))
        self._broadcast(event_type, payload)

    # ── Collect Loop ──

    def _collect_loop(self):
        """Main background loop -- runs every 5s, checks for changes, pushes events.

        Core sources (topology, status, traffic, events) are hardcoded here for
        performance and ordering guarantees. Registered sources run after core,
        respecting their configured intervals.
        """
        tick = 0
        topo_nodes = []
        while self._running:
            try:
                # -- Core: Topology every 12th tick (60s) — first so topo_nodes is populated --
                if tick % 12 == 0:
                    topo = realm_db.get_topology()
                    topo_nodes = topo.get("nodes", [])
                    self._check_and_push("topology", topo)
                    # Prune DB connections from dead request-handler threads
                    realm_db._prune_dead_connections()

                # -- Core: Status every 2nd tick (10s) --
                if tick % 2 == 0:
                    status = self._status_fn()
                    self._check_and_push("status", status)

                # -- Core: Traffic every tick (5s) --
                if topo_nodes:
                    traffic = compute_traffic(topo_nodes)
                    if traffic:
                        self._check_and_push("traffic", traffic)

                # -- Registered sources (plugins + migrated core like energy, latency, etc.) --
                with self._sources_lock:
                    sources_snapshot = list(self._sources)
                for source in sources_snapshot:
                    if source._tick_interval > 0 and tick % source._tick_interval == 0:
                        try:
                            data = source.collect_fn()
                            if data:
                                self._check_and_push(source.event_type, data)
                        except Exception:
                            log.debug("SSE source %s collect error", source.name, exc_info=True)

                # -- Core: Events every tick (last, so structural data gets priority) --
                events = realm_db.get_events_since(self._last_event_ts)
                for evt in events:
                    self._last_event_ts = max(self._last_event_ts, evt.get("ts", 0))
                    self._broadcast("realm-event", json.dumps(evt, separators=(',',':')))

            except Exception as e:
                import traceback
                print(f"SSE broker error: {e}")
                traceback.print_exc()

            tick += 1
            time.sleep(TICK_SECONDS)

    def start(self):
        """Start the background collection thread."""
        if self._running:
            return
        self._running = True
        self._last_event_ts = time.time()  # Only collect NEW events; burst handles replay
        log.info("SSE broker starting with %d registered sources", len(self._sources))
        t = threading.Thread(target=self._collect_loop, daemon=True, name="sse-broker")
        t.start()

    def stop(self):
        self._running = False
