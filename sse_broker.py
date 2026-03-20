"""SSE broker -- background data collection, change detection, client push.

Manages a set of connected SSE clients (thread-safe queue per client).
A single background thread collects data from existing sources, hashes for
changes, and pushes typed events only when data differs.
"""

import hashlib
import json
import logging
import queue
import threading
import time

import realm_db
from traffic_precompute import compute_traffic

log = logging.getLogger(__name__)


class SSEBroker:
    def __init__(self, status_fn, energy_fn, latency_fn=None,
                 firewall_fn=None, wifi_fn=None):
        """Initialize broker.

        Args:
            status_fn: callable returning the full status dict (map_server.build_status)
            energy_fn: callable returning energy data dict (map_server._get_energy_data)
            latency_fn: callable returning latency map dict (latency_prober.get_latency_map)
            firewall_fn: callable returning firewall parsed dict (firewall_parser)
            wifi_fn: callable returning AP info dict (ap_scanner.get_ap_info)
        """
        self._status_fn = status_fn
        self._energy_fn = energy_fn
        self._latency_fn = latency_fn
        self._firewall_fn = firewall_fn
        self._wifi_fn = wifi_fn
        self._clients = []  # list of queue.Queue
        self._lock = threading.Lock()
        self._hashes = {}  # {event_type: last_hash}
        self._last_event_ts = 0.0
        self._running = False

    def add_client(self):
        """Register a new SSE client. Returns a Queue that receives (event_type, data_json) tuples.
        Sends initial burst of ALL data types so browser is fully populated on connect.

        Order matters: events BEFORE status so browser processes them in restore mode
        (10-min bubble window). Status arrives last, switches to live mode and dismisses
        the loading screen with everything already rendered.
        """
        q = queue.Queue(maxsize=1000)
        _json = lambda d: json.dumps(d, separators=(',', ':'))
        topo_nodes = []

        # ── Topology first (structural data, fast DB read) ──
        try:
            topo = realm_db.get_topology()
            topo_nodes = topo.get("nodes", [])
            q.put_nowait(("topology", _json(topo)))
        except Exception:
            log.warning("SSE burst: failed to send topology", exc_info=True)

        # ── Traffic (RRD reads, reasonably fast) ──
        if topo_nodes:
            try:
                traffic = compute_traffic(topo_nodes)
                if traffic:
                    q.put_nowait(("traffic", _json(traffic)))
            except Exception:
                log.warning("SSE burst: failed to send traffic", exc_info=True)

        # ── Energy ──
        try:
            energy = self._energy_fn()
            if "error" not in energy:
                q.put_nowait(("energy", _json(energy)))
        except Exception:
            log.warning("SSE burst: failed to send energy", exc_info=True)

        # ── Latency (reads cached fping data, fast) ──
        if self._latency_fn:
            try:
                from latency_prober import get_latency_grouped
                grouped = get_latency_grouped(topo_nodes)
                if grouped:
                    q.put_nowait(("latency", _json(grouped)))
            except Exception:
                log.warning("SSE burst: failed to send latency", exc_info=True)

        # ── Firewall + WiFi SKIPPED in burst (may trigger slow SSH) ──
        # These arrive on the regular collect loop (60s / 120s).

        # ── Events BEFORE status (processed in restore mode → 10-min bubble window) ──
        # 15-min window covers BUBBLE_RESTORE_AGE (10 min) with margin.
        # 200-event cap protects queue capacity.
        try:
            recent_events = realm_db.get_events_since(time.time() - 900)
            evt_count = 0
            for evt in recent_events:
                q.put_nowait(("realm-event", _json(evt)))
                evt_count += 1
                if evt_count >= 200:
                    break
        except Exception:
            log.warning("SSE burst: failed to send recent events", exc_info=True)

        # ── Status LAST (flips to live mode + dismisses loading screen) ──
        try:
            status = self._status_fn()
            q.put_nowait(("status", _json(status)))
        except Exception:
            log.warning("SSE burst: failed to send status", exc_info=True)

        with self._lock:
            self._clients.append(q)
        return q

    def remove_client(self, q):
        """Unregister an SSE client."""
        with self._lock:
            try:
                self._clients.remove(q)
            except ValueError:
                pass

    def _broadcast(self, event_type, payload):
        """Send an event to all connected clients.

        Args:
            event_type: SSE event name.
            payload: pre-serialized JSON string ready for the wire.
        """
        dead = []
        with self._lock:
            for q in self._clients:
                try:
                    q.put_nowait((event_type, payload))
                except queue.Full:
                    dead.append(q)
            for q in dead:
                try:
                    self._clients.remove(q)
                except ValueError:
                    pass

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
        payload = json.dumps(data, separators=(',', ':'))
        self._broadcast(event_type, payload)

    def _collect_loop(self):
        """Main background loop -- runs every 5s, checks for changes, pushes events."""
        tick = 0
        topo_nodes = []
        while self._running:
            try:
                # -- Topology: every 12th tick (60s) — first so topo_nodes is populated --
                if tick % 12 == 0:
                    topo = realm_db.get_topology()
                    topo_nodes = topo.get("nodes", [])
                    self._check_and_push("topology", topo)

                # -- Status: every 2nd tick (10s) --
                if tick % 2 == 0:
                    status = self._status_fn()
                    self._check_and_push("status", status)

                # -- Traffic: every tick (5s) --
                if topo_nodes:
                    traffic = compute_traffic(topo_nodes)
                    if traffic:
                        self._check_and_push("traffic", traffic)

                # -- Energy: every 6th tick (30s) --
                if tick % 6 == 0:
                    try:
                        energy = self._energy_fn()
                        if "error" not in energy:
                            self._check_and_push("energy", energy)
                    except Exception:
                        pass

                # -- Latency: every 6th tick (30s) — send pre-grouped data --
                if tick % 6 == 0 and self._latency_fn:
                    try:
                        from latency_prober import get_latency_grouped
                        grouped = get_latency_grouped(topo_nodes)
                        if grouped:
                            self._check_and_push("latency", grouped)
                    except Exception:
                        pass

                # -- Firewall: every 12th tick (60s) — matches previous client poll --
                if tick % 12 == 0 and self._firewall_fn:
                    try:
                        fw = self._firewall_fn()
                        if fw:
                            self._check_and_push("firewall", fw)
                    except Exception:
                        pass

                # -- WiFi APs: every 24th tick (120s) — matches previous client poll --
                if tick % 24 == 0 and self._wifi_fn:
                    try:
                        wifi = self._wifi_fn()
                        if wifi:
                            self._check_and_push("wifi", wifi)
                    except Exception:
                        pass

                # -- Events: every tick (last, so structural data gets priority) --
                events = realm_db.get_events_since(self._last_event_ts)
                for evt in events:
                    self._last_event_ts = max(self._last_event_ts, evt.get("ts", 0))
                    self._broadcast("realm-event", json.dumps(evt, separators=(',', ':')))

            except Exception as e:
                import traceback
                print(f"SSE broker error: {e}")
                traceback.print_exc()

            tick += 1
            time.sleep(5)

    def start(self):
        """Start the background collection thread."""
        if self._running:
            return
        self._running = True
        self._last_event_ts = time.time()  # Only collect NEW events; burst handles replay
        t = threading.Thread(target=self._collect_loop, daemon=True, name="sse-broker")
        t.start()

    def stop(self):
        self._running = False
