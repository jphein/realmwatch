#!/usr/bin/env python3
"""HTTP server for the live realm map — serves status, events, and the map UI."""

import json
import os
import subprocess
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from engine import LitRPGEngine
from collectd_reader import get_all_summaries
import notion_sync
import ap_scanner
import codex_sync
import ha_bridge
import realm_db

engine = LitRPGEngine()
PORT = 8777
MAP_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONAS_FILE = os.path.join(MAP_DIR, "personas.json")
TOPOLOGY_FILE = os.path.join(MAP_DIR, "topology.json")
_CHAT_CONFIG = os.path.expanduser("~/.config/azure-chat-assistant/config.json")
_SPEECH_CONFIG = os.path.expanduser("~/.config/speech-to-cli/config.json")

# Settings exposed to UI (keys safe to read/write — no secrets)
_CHAT_SAFE_KEYS = {"deployment", "model", "model_type", "max_completion_tokens", "temperature",
                   "reasoning_effort", "default_models", "multi_chat_timeout", "voice"}
_SPEECH_SAFE_KEYS = {"silence_timeout", "talk_silence_timeout", "energy_multiplier", "end_word",
                     "subtitle_color_user", "subtitle_color_tts", "live_subtitles", "voice",
                     "fast_voice", "max_record_seconds", "vu_meter", "chime_ready"}


def _write_config_file(path, updates, safe_keys):
    """Write-through to JSON config files (MCP servers still read these)."""
    try:
        with open(path) as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        cfg = {}
    for k, v in updates.items():
        if k in safe_keys:
            cfg[k] = v
    with open(path, "w") as f:
        json.dump(cfg, f, indent=4)


def _load_topology():
    """Load topology from DB."""
    return realm_db.get_topology()


def _load_personas():
    return realm_db.get_personas()


def _save_personas(data):
    for node_id, pdata in data.items():
        realm_db.set_persona(node_id, pdata)
    # Write-through to JSON for oracle_daemon and other readers
    with open(PERSONAS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def push_event(event):
    return realm_db.push_event(event)


def get_events_since(since_ts):
    return realm_db.get_events_since(since_ts)


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
            status["wifi"] = ap_scanner.get_wifi_signal()
            status["ha"] = ha_bridge.get_ha_states()
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

        elif self.path.startswith("/notion-sync"):
            try:
                if "force=1" in self.path:
                    notion_sync.force_resync()
                result = notion_sync.sync_to_events()
                if "error" in result:
                    self._json_response(result, 503)
                    return
                for evt in result.get("events", []):
                    push_event(evt)
                self._json_response(result)
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

        elif self.path == "/personas":
            self._json_response(_load_personas())

        elif self.path == "/topology":
            self._json_response(_load_topology())

        elif self.path == "/scan":
            result = ap_scanner.scan_and_update()
            self._json_response(result)

        elif self.path == "/scan/status":
            self._json_response(ap_scanner.get_last_scan())

        elif self.path == "/scan/wifi":
            self._json_response(ap_scanner.get_wifi_signal())

        elif self.path == "/config":
            self._json_response({
                "chat": realm_db.get_settings("chat"),
                "speech": realm_db.get_settings("speech"),
                "oracle": realm_db.get_persona("scrying-pool") or {},
            })

        elif self.path == "/settings":
            # UI settings (sliders, checkboxes, layout, spellbook page)
            self._json_response(realm_db.get_settings("ui"))

        elif self.path.startswith("/codex-sync"):
            try:
                force = "force=1" in self.path
                data = codex_sync.get_grouped() if not force else None
                if force:
                    codex_sync.fetch_codex(force=True)
                    data = codex_sync.get_grouped()
                self._json_response(data)
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

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
                if update.get("_delete"):
                    realm_db.delete_persona(node_key)
                else:
                    existing = realm_db.get_persona(node_key) or {}
                    for field in ("name", "title", "voice", "system_prompt", "hints"):
                        if field in update:
                            existing[field] = update[field]
                    realm_db.set_persona(node_key, existing)
                # Write-through to JSON
                personas = realm_db.get_personas()
                with open(PERSONAS_FILE, "w") as f:
                    json.dump(personas, f, indent=2)
                self._json_response({"ok": True, "personas": personas})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)
        elif self.path == "/notion-complete":
            try:
                req = json.loads(body)
                notion_id = req.get("notion_id", "")
                if not notion_id:
                    self._json_response({"error": "missing notion_id"}, 400)
                    return
                result = notion_sync.complete(notion_id)
                if "error" in result:
                    self._json_response(result, 503)
                    return
                push_event({
                    "type": "system",
                    "node": "notion-portal",
                    "text": "A quest has been sealed in the archives.",
                })
                self._json_response(result)
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

        elif self.path == "/config":
            try:
                req = json.loads(body)
                if "chat" in req:
                    safe = {k: v for k, v in req["chat"].items() if k in _CHAT_SAFE_KEYS}
                    realm_db.set_settings("chat", safe)
                    _write_config_file(_CHAT_CONFIG, safe, _CHAT_SAFE_KEYS)
                if "speech" in req:
                    safe = {k: v for k, v in req["speech"].items() if k in _SPEECH_SAFE_KEYS}
                    realm_db.set_settings("speech", safe)
                    _write_config_file(_SPEECH_CONFIG, safe, _SPEECH_SAFE_KEYS)
                if "oracle" in req:
                    oracle = realm_db.get_persona("scrying-pool") or {}
                    for k in ("model", "reasoning_effort", "voice", "system_prompt"):
                        if k in req["oracle"]:
                            oracle[k] = req["oracle"][k]
                    realm_db.set_persona("scrying-pool", oracle)
                    # Write-through to personas.json
                    personas = realm_db.get_personas()
                    with open(PERSONAS_FILE, "w") as f:
                        json.dump(personas, f, indent=2)
                self._json_response({"ok": True})
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

        elif self.path == "/settings":
            try:
                req = json.loads(body)
                realm_db.set_settings("ui", req)
                self._json_response({"ok": True})
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

        elif self.path == "/connections":
            try:
                req = json.loads(body)
                conns = req.get("connections")
                if conns is None:
                    self._json_response({"error": "missing 'connections'"}, 400)
                    return
                realm_db.set_connections(conns)
                realm_db.save_topology_json(TOPOLOGY_FILE)
                self._json_response({"ok": True, "count": len(conns)})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)

        elif self.path == "/node":
            try:
                req = json.loads(body)
                node_id = req.get("id", "").strip()
                if not node_id:
                    self._json_response({"error": "missing 'id'"}, 400)
                    return
                if req.get("_delete"):
                    realm_db.delete_node(node_id)
                elif "x" in req and "y" in req and len(req) <= 3:
                    realm_db.update_node_position(node_id, req["x"], req["y"])
                else:
                    existing = realm_db.get_node(node_id)
                    if existing:
                        existing.update(req)
                        realm_db.set_node(node_id, existing)
                    else:
                        realm_db.set_node(node_id, req)
                realm_db.save_topology_json(TOPOLOGY_FILE)
                self._json_response({"ok": True})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)

        elif self.path == "/topology":
            try:
                req = json.loads(body)
                if "nodes" in req:
                    for node in req["nodes"]:
                        nid = node.get("id", "")
                        if nid:
                            realm_db.set_node(nid, node)
                if "connections" in req:
                    realm_db.set_connections(req["connections"])
                if "regions" in req:
                    realm_db.set_regions(req["regions"])
                realm_db.save_topology_json(TOPOLOGY_FILE)
                self._json_response({"ok": True})
            except (json.JSONDecodeError, KeyError) as e:
                self._json_response({"error": str(e)}, 400)

        elif self.path == "/ssh":
            try:
                req = json.loads(body)
                host = req.get("host", "")
                command = req.get("command", "")
                # Validate host against topology ssh fields
                topo = _load_topology()
                allowed = {n["ssh"] for n in topo.get("nodes", []) if n.get("ssh")}
                if host not in allowed:
                    self._json_response({"error": f"Host '{host}' not permitted"}, 403)
                    return
                if not command.strip():
                    self._json_response({"error": "Empty command"}, 400)
                    return
                result = subprocess.run(
                    ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
                     host, command],
                    capture_output=True, text=True, timeout=30
                )
                self._json_response({
                    "output": result.stdout[-50000:] if result.stdout else "",
                    "error": result.stderr[-5000:] if result.returncode != 0 else None,
                    "exit_code": result.returncode,
                })
            except subprocess.TimeoutExpired:
                self._json_response({"error": "Command timed out (30s)"}, 504)
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
    print(f"Initializing realm DB...")
    realm_db.init()
    realm_db.migrate_personas(PERSONAS_FILE)
    realm_db.migrate_config("chat", _CHAT_CONFIG, _CHAT_SAFE_KEYS)
    realm_db.migrate_config("speech", _SPEECH_CONFIG, _SPEECH_SAFE_KEYS)
    realm_db.migrate_topology(TOPOLOGY_FILE)
    print(f"collectd RRD: /var/lib/collectd/rrd/")
    ap_scanner._event_callback = push_event
    ap_scanner.start_background_scanner()
    ha_bridge.start_ha_bridge()
    HTTPServer(("", PORT), RealmHandler).serve_forever()
