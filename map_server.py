#!/usr/bin/env python3
"""HTTP server for the live realm map — serves status, events, and the map UI."""

import json
import os
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from engine import LitRPGEngine
from collectd_reader import get_all_summaries

engine = LitRPGEngine()
PORT = 8777
MAP_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONAS_FILE = os.path.join(MAP_DIR, "personas.json")
TOPOLOGY_FILE = os.path.join(MAP_DIR, "topology.json")
_topo_cache = {"data": None, "mtime": 0}


def _load_topology():
    """Load topology.json with mtime-based cache."""
    try:
        mt = os.path.getmtime(TOPOLOGY_FILE)
        if _topo_cache["data"] and mt == _topo_cache["mtime"]:
            return _topo_cache["data"]
        with open(TOPOLOGY_FILE) as f:
            _topo_cache["data"] = json.load(f)
            _topo_cache["mtime"] = mt
            return _topo_cache["data"]
    except (OSError, json.JSONDecodeError):
        return {}


def _load_personas():
    if os.path.exists(PERSONAS_FILE):
        try:
            with open(PERSONAS_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_personas(data):
    with open(PERSONAS_FILE, "w") as f:
        json.dump(data, f, indent=2)

# ── Event queue: agents push events, map polls them ──
_events_lock = threading.Lock()
_events = []       # list of {type, node, text, color, ts, ...}
_MAX_EVENTS = 100  # ring buffer size


def push_event(event):
    event["ts"] = time.time()
    with _events_lock:
        _events.append(event)
        if len(_events) > _MAX_EVENTS:
            _events.pop(0)


def get_events_since(since_ts):
    with _events_lock:
        return [e for e in _events if e["ts"] > since_ts]


class RealmHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=MAP_DIR, **kwargs)

    def _json_response(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/status":
            status = engine.get_status()
            status["tailscale"] = engine.get_tailscale_status()
            status["adult"] = engine.adult_observation(status)
            status["host"] = engine.get_host_config()
            status["collectd"] = get_all_summaries()
            self._json_response(status)

        elif self.path.startswith("/events"):
            since = 0
            if "?" in self.path:
                for param in self.path.split("?", 1)[1].split("&"):
                    if param.startswith("since="):
                        try:
                            since = float(param.split("=", 1)[1])
                        except ValueError:
                            pass
            self._json_response(get_events_since(since))

        elif self.path == "/personas":
            self._json_response(_load_personas())

        elif self.path == "/topology":
            self._json_response(_load_topology())

        elif self.path == "/" or self.path == "":
            self.path = "/realm-map.html"
            super().do_GET()
        else:
            super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if self.path == "/event":
            try:
                event = json.loads(body)
                push_event(event)
                self._json_response({"ok": True})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)

        elif self.path == "/personas":
            try:
                update = json.loads(body)
                node_key = update.get("node")
                if not node_key:
                    self._json_response({"error": "missing 'node' key"}, 400)
                    return
                personas = _load_personas()
                if update.get("_delete"):
                    personas.pop(node_key, None)
                else:
                    existing = personas.get(node_key, {})
                    for field in ("name", "title", "voice", "system_prompt", "hints"):
                        if field in update:
                            existing[field] = update[field]
                    personas[node_key] = existing
                _save_personas(personas)
                self._json_response({"ok": True, "personas": personas})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    print(f"Realm Map: http://localhost:{PORT}")
    print(f"collectd RRD: /var/lib/collectd/rrd/")
    HTTPServer(("", PORT), RealmHandler).serve_forever()
