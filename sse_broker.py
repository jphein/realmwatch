"""SSE broker -- background data collection, change detection, client push.

Manages a set of connected SSE clients (thread-safe queue per client).
A single background thread collects data from existing sources, hashes for
changes, and pushes typed events only when data differs.
"""

import hashlib
import json
import queue
import threading
import time

import realm_db
from traffic_precompute import compute_traffic


class SSEBroker:
    def __init__(self, status_fn, energy_fn):
        """Initialize broker.

        Args:
            status_fn: callable returning the full status dict (map_server.build_status)
            energy_fn: callable returning energy data dict (map_server._get_energy_data)
        """
        self._status_fn = status_fn
        self._energy_fn = energy_fn
        self._clients = []  # list of queue.Queue
        self._lock = threading.Lock()
        self._hashes = {}  # {event_type: last_hash}
        self._last_event_ts = 0.0
        self._running = False

    def add_client(self):
        """Register a new SSE client. Returns a Queue that receives (event_type, data_json) tuples."""
        q = queue.Queue(maxsize=200)
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

    def _broadcast(self, event_type, data):
        """Send an event to all connected clients."""
        payload = json.dumps(data, separators=(',', ':'))
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

    def _hash(self, data):
        """Fast hash of JSON-serializable data for change detection."""
        return hashlib.md5(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:12]

    def _check_and_push(self, event_type, data):
        """Push event only if data hash changed."""
        h = self._hash(data)
        if h != self._hashes.get(event_type):
            self._hashes[event_type] = h
            self._broadcast(event_type, data)
            return True
        return False

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

                # -- Events: every tick (last, so structural data gets priority) --
                events = realm_db.get_events_since(self._last_event_ts)
                for evt in events:
                    self._last_event_ts = max(self._last_event_ts, evt.get("ts", 0))
                    self._broadcast("realm-event", evt)

            except Exception as e:
                print(f"SSE broker error: {e}")

            tick += 1
            time.sleep(5)

    def start(self):
        """Start the background collection thread."""
        if self._running:
            return
        self._running = True
        self._last_event_ts = time.time() - 600  # Catch up last 10 min of events on start
        t = threading.Thread(target=self._collect_loop, daemon=True, name="sse-broker")
        t.start()

    def stop(self):
        self._running = False
