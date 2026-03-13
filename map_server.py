#!/usr/bin/env python3
"""HTTP server for the live realm map — serves status, events, and the map UI."""

import json
import os

# Load .env file (always override for critical vars like HA_TOKEN)
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip()
                if v:  # Always set if .env has a value
                    os.environ[k] = v
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
import wled_bridge
import node_roles
import realm_db
import event_generator

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


def _get_energy_data():
    """Fetch energy-related data from HA via ha_bridge."""
    import ssl
    import urllib.request

    ha_url = os.environ.get("HA_URL", "https://10.0.6.108:8123")
    ha_token = os.environ.get("HA_TOKEN", "")
    if not ha_token:
        return {"error": "No HA_TOKEN"}

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        req = urllib.request.Request(
            f"{ha_url}/api/states",
            headers={"Authorization": f"Bearer {ha_token}"},
        )
        resp = urllib.request.urlopen(req, context=ssl_ctx, timeout=10)
        states = {s["entity_id"]: s for s in json.loads(resp.read())}
    except Exception as e:
        return {"error": str(e)}

    def num(eid):
        s = states.get(eid, {}).get("state")
        if s in (None, "unavailable", "unknown"):
            return None
        try:
            return float(s)
        except (ValueError, TypeError):
            return None

    return {
        "solar_kw": num("sensor.pv_power"),  # W
        "solar_today_kwh": num("sensor.today_s_pv_generation"),
        "solar_total_kwh": num("sensor.total_pv_generation"),
        "battery_soc": num("sensor.battery_state_of_charge"),
        "battery_power": num("sensor.battery_power"),  # W, negative=charging
        "battery_voltage": num("sensor.battery_voltage"),
        "grid_power": num("sensor.grid_power"),  # kW
        "grid_import_kwh": num("sensor.total_energy_import"),
        "grid_export_kwh": num("sensor.total_energy_export"),
        "house_load": num("sensor.house_consumption"),  # W
        "today_load_kwh": num("sensor.today_load"),
        "goodwe_kw": num("sensor.goodwe_kw"),
        "yurt_kw": num("sensor.yurt_consumption"),
        "inverter_temp_f": num("sensor.inverter_temperature_module"),
        "ts": time.time(),
    }


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
            status["wled"] = wled_bridge.get_wled_states()
            topo_nodes = _load_topology().get("nodes", [])
            status["roles"] = {n["id"]: node_roles.get_role(n["id"], n) for n in topo_nodes}
            status["groups"] = node_roles.get_ha_map()
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

        elif self.path.startswith("/ping/"):
            ip = self.path.split("/ping/", 1)[1].split("?")[0]
            try:
                import subprocess
                result = subprocess.run(
                    ["ping", "-c", "3", "-W", "2", ip],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    # Parse average RTT
                    for line in result.stdout.split("\n"):
                        if "avg" in line.lower() or "rtt" in line.lower():
                            parts = line.split("=")[-1].split("/")
                            if len(parts) >= 2:
                                self._json_response({"ok": True, "ip": ip, "rtt_ms": float(parts[1])})
                                return
                    self._json_response({"ok": True, "ip": ip, "rtt_ms": None})
                else:
                    self._json_response({"ok": False, "ip": ip, "error": "Host unreachable"})
            except Exception as e:
                self._json_response({"ok": False, "ip": ip, "error": str(e)})

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

        elif self.path == "/energy":
            # Fetch energy data from HA
            energy = _get_energy_data()
            self._json_response(energy)

        elif self.path == "/debug":
            c = realm_db._conn()
            counts = {}
            for table in ("settings", "events", "personas", "nodes", "connections",
                          "regions", "notion_synced", "wifi_scans"):
                try:
                    counts[table] = c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                except Exception:
                    counts[table] = -1
            scan = realm_db.get_wifi_scan()
            self._json_response({
                "tables": counts,
                "db_path": realm_db.DB_PATH,
                "db_size": os.path.getsize(realm_db.DB_PATH) if os.path.exists(realm_db.DB_PATH) else 0,
                "wifi_scan_ts": scan.get("ts", 0),
                "notion_synced": len(realm_db.get_notion_synced()),
                "settings_ns": list(realm_db.get_settings().keys()),
            })

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

        elif self.path.startswith("/wled/") and self.path.endswith("/state"):
            # WLED control: POST /wled/{node_id}/state
            try:
                parts = self.path.split("/")
                node_id = parts[2]
                req = json.loads(body)
                result = wled_bridge.set_wled_state(
                    node_id,
                    on=req.get("on"),
                    brightness=req.get("bri"),
                    effect=req.get("fx")
                )
                self._json_response(result)
            except Exception as e:
                self._json_response({"error": str(e)}, 500)

        elif self.path == "/wol":
            # Wake-on-LAN: POST /wol with {mac, ip}
            try:
                req = json.loads(body)
                mac = req.get("mac", "").replace(":", "").replace("-", "").lower()
                if len(mac) != 12:
                    self._json_response({"error": "Invalid MAC address"}, 400)
                    return
                # Build magic packet: 6 x 0xFF + 16 x MAC
                mac_bytes = bytes.fromhex(mac)
                magic = b'\xff' * 6 + mac_bytes * 16
                # Send via UDP broadcast
                import socket
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                # Send to broadcast on port 9
                sock.sendto(magic, ("255.255.255.255", 9))
                # Also send to subnet broadcast if IP provided
                if req.get("ip"):
                    ip_parts = req["ip"].rsplit(".", 1)
                    if len(ip_parts) == 2:
                        subnet_broadcast = ip_parts[0] + ".255"
                        sock.sendto(magic, (subnet_broadcast, 9))
                sock.close()
                self._json_response({"ok": True, "mac": mac, "sent": True})
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
    node_roles.migrate_to_db()
    print(f"collectd RRD: /var/lib/collectd/rrd/")
    ap_scanner._event_callback = push_event
    ap_scanner.start_background_scanner()
    ha_bridge.start_ha_bridge()
    wled_bridge.start_wled_bridge()
    event_generator.start_event_generator(push_event)
    HTTPServer(("", PORT), RealmHandler).serve_forever()
