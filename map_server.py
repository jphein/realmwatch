#!/usr/bin/env python3
"""HTTP server for the live realm map — serves status, events, and the map UI."""

import gzip
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
import signal
import subprocess
import threading
import time
import queue
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from engine import RealmEngine
from collectd_reader import get_all_summaries, get_host_summary
import notion_sync
import ap_scanner
import codex_sync
import ha_bridge
import wled_bridge
import node_roles
import realm_db
import event_generator
import chat_bridge
import asyncio
import latency_prober
import firewall_parser

engine = RealmEngine()
PORT = int(os.environ.get("REALM_PORT", 80))
_server_start_time = time.time()
MAP_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONAS_FILE = os.path.join(MAP_DIR, "personas.json")
TOPOLOGY_FILE = os.path.join(MAP_DIR, "topology.json")
VENV_PYTHON = os.path.join(MAP_DIR, "venv", "bin", "python3")
_CHAT_CONFIG = os.path.expanduser("~/.config/azure-chat-assistant/config.json")
_SPEECH_CONFIG = os.path.expanduser("~/.config/speech-to-cli/config.json")

# ── Persistent asyncio event loop (avoids creating/destroying per request) ──
_async_loop = asyncio.new_event_loop()

def _start_async_loop():
    asyncio.set_event_loop(_async_loop)
    _async_loop.run_forever()

_async_thread = threading.Thread(target=_start_async_loop, daemon=True)
_async_thread.start()

# ── Shared thread pool for /resolve-url (avoids creating executor per request) ──
from concurrent.futures import ThreadPoolExecutor
_resolve_pool = ThreadPoolExecutor(max_workers=12)

# ── Gzip cache: (path, mtime) -> compressed bytes ──
_gzip_cache = {}
_gzip_cache_lock = threading.Lock()

# ── Build status TTL cache ──
_status_cache = {"data": None, "ts": 0}
_status_cache_lock = threading.Lock()
_STATUS_TTL = 5  # seconds

# ── Topology mtime cache ──
_topo_cache = {"data": None, "mtime": 0}
_topo_cache_lock = threading.Lock()

# ── Energy data TTL cache ──
_energy_cache = {"data": None, "ts": 0}
_energy_cache_lock = threading.Lock()
_ENERGY_TTL = 30  # seconds

# ── Sublabel host lookup cache ──
_sublabel_host_map = {"map": {}, "topo_mtime": 0, "collectd_keys": frozenset()}
_sublabel_host_lock = threading.Lock()


# ── Herald process management ──
_herald_proc = None


def _herald_start(interval=90):
    """Start the herald daemon as a subprocess."""
    global _herald_proc
    _herald_stop()
    _herald_proc = subprocess.Popen(
        [VENV_PYTHON, "realm_herald.py", "--interval", str(interval)],
        cwd=MAP_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return _herald_proc.pid


def _herald_stop():
    """Stop the herald daemon."""
    global _herald_proc
    if _herald_proc and _herald_proc.poll() is None:
        _herald_proc.terminate()
        try:
            _herald_proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _herald_proc.kill()
    _herald_proc = None
    # Also kill by script name
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "realm_herald.py"], text=True, timeout=3
        ).strip()
        for pid in (int(p) for p in out.split("\n") if p.strip()):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass


def _herald_status():
    """Check herald daemon status."""
    running = _herald_proc is not None and _herald_proc.poll() is None
    pids = []
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "realm_herald.py"], text=True, timeout=3
        ).strip()
        pids = [int(p) for p in out.split("\n") if p.strip()]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass
    return {"running": running or len(pids) > 0, "pids": pids}


def _herald_once():
    """Run a single herald round (blocking, returns output)."""
    try:
        out = subprocess.check_output(
            [VENV_PYTHON, "realm_herald.py", "--once"],
            cwd=MAP_DIR, text=True, timeout=15, stderr=subprocess.STDOUT,
        )
        return {"ok": True, "output": out}
    except subprocess.TimeoutExpired:
        return {"error": "Herald round timed out (15s)"}
    except subprocess.CalledProcessError as e:
        return {"error": f"Herald round failed: {e}"}

# Settings exposed to UI (keys safe to read/write — no secrets)
_CHAT_SAFE_KEYS = {"deployment", "model", "model_type", "max_completion_tokens", "temperature",
                   "reasoning_effort", "default_models", "multi_chat_timeout", "voice"}
_SPEECH_SAFE_KEYS = {"silence_timeout", "talk_silence_timeout", "energy_multiplier", "end_word",
                     "subtitle_color_user", "subtitle_color_tts", "live_subtitles", "voice",
                     "fast_voice", "max_record_seconds", "vu_meter", "chime_ready"}


def _load_personas():
    """Load all personas from DB."""
    try:
        data = realm_db.get_personas()
        if data:
            return data
    except Exception:
        pass
    return {}


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
    """Load topology from DB, with mtime-based caching on the JSON file."""
    try:
        mtime = os.path.getmtime(TOPOLOGY_FILE)
    except OSError:
        mtime = 0
    with _topo_cache_lock:
        if _topo_cache["data"] is not None and _topo_cache["mtime"] == mtime:
            return _topo_cache["data"]
    data = realm_db.get_topology()
    with _topo_cache_lock:
        _topo_cache["data"] = data
        _topo_cache["mtime"] = mtime
    return data


def _get_energy_data():
    """Fetch energy-related data from HA via ha_bridge (30s TTL cache)."""
    now = time.time()
    with _energy_cache_lock:
        if _energy_cache["data"] is not None and (now - _energy_cache["ts"]) < _ENERGY_TTL:
            return _energy_cache["data"]

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

    result = {
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
    with _energy_cache_lock:
        _energy_cache["data"] = result
        _energy_cache["ts"] = now
    return result


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


def _build_host_lookup(topo_nodes, collectd_keys):
    """Build node_id -> collectd_key map for O(1) lookups (cached when topology/collectd keys change)."""
    from traffic_precompute import _match_host
    lookup = {}
    # Build a minimal collectd dict with just the keys for matching
    dummy_collectd = {k: {"hostname": k} for k in collectd_keys}
    for n in topo_nodes:
        nid = n["id"]
        if n.get("collectd") and n["collectd"] in collectd_keys:
            lookup[nid] = n["collectd"]
        else:
            matched = _match_host(dummy_collectd, nid)
            if matched:
                lookup[nid] = matched.get("hostname")
    return lookup


def _get_host_lookup(topo_nodes, collectd):
    """Return cached node_id -> collectd_key map, rebuilding if topology or collectd keys changed."""
    try:
        topo_mtime = os.path.getmtime(TOPOLOGY_FILE)
    except OSError:
        topo_mtime = 0
    cd_keys = frozenset(collectd.keys())
    with _sublabel_host_lock:
        if (_sublabel_host_map["topo_mtime"] == topo_mtime
                and _sublabel_host_map["collectd_keys"] == cd_keys):
            return _sublabel_host_map["map"]
    new_map = _build_host_lookup(topo_nodes, cd_keys)
    with _sublabel_host_lock:
        _sublabel_host_map["map"] = new_map
        _sublabel_host_map["topo_mtime"] = topo_mtime
        _sublabel_host_map["collectd_keys"] = cd_keys
    return new_map


def _compute_sublabels(status, topo_nodes):
    """Pre-compute sublabel text for all nodes — eliminates client-side hostname matching."""
    sublabels = {}
    node_status = status.get("astral", {}).get("nodes", {})
    collectd = status.get("collectd", {})
    ha = status.get("ha", {})
    wifi = status.get("wifi", {})
    wled = status.get("wled", {})

    # Build case-insensitive status lookup (mirrors client findStatusKey)
    status_lower = {k.lower().replace("-", ""): v for k, v in node_status.items()}

    # O(1) host lookup (cached, rebuilt when topology or collectd keys change)
    host_lookup = _get_host_lookup(topo_nodes, collectd)

    for n in topo_nodes:
        nid = n["id"]
        ip = n.get("ip", "")

        # HA sublabels (already pre-computed by ha_bridge)
        ha_info = ha.get(nid)
        if ha_info and ha_info.get("sublabel"):
            sublabels[nid] = ha_info["sublabel"]
            continue

        # WLED state
        wled_info = wled.get(nid)
        if wled_info and wled_info.get("online"):
            sublabels[nid] = f'On \u2022 {wled_info.get("effect", "Solid")}' if wled_info.get("on") else "Off"
            continue

        # WiFi signal
        wifi_info = wifi.get(nid)
        if wifi_info and wifi_info.get("signal") is not None:
            ssid = wifi_info.get("ssid", "")
            ap = wifi_info.get("ap", "")
            sublabels[nid] = f'{wifi_info["signal"]} dBm \u2022 {ssid}' if ssid else f'{wifi_info["signal"]} dBm \u2022 {ap}'
            continue

        if not ip:
            continue

        # Online status
        nid_norm = nid.lower().replace("-", "")
        online = status_lower.get(nid_norm, False)

        # Collectd match: O(1) lookup via cached map
        cd_key = host_lookup.get(nid)
        cd = collectd.get(cd_key) if cd_key else None

        if cd and cd.get("load_1") is not None:
            mem_str = f' \u2022 {cd["mem_pct"]}%' if cd.get("mem_pct") is not None else ""
            sublabels[nid] = f'Load {cd["load_1"]:.2f}{mem_str} \u2022 {ip}'
        else:
            sublabels[nid] = f'{"Online" if online else "Offline"} \u2022 {ip}'

    return sublabels


def _build_status_fresh():
    """Build the full status blob (internal, always fresh)."""
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
    # Update latency prober with current WiFi clients
    latency_prober.set_wifi_nodes(status.get("wifi", {}))
    # Pre-compute sublabels (saves client hostname matching + string formatting)
    status["sublabels"] = _compute_sublabels(status, topo_nodes)
    return status


def build_status():
    """Build the full status blob with 5-second TTL cache."""
    now = time.time()
    with _status_cache_lock:
        if _status_cache["data"] is not None and (now - _status_cache["ts"]) < _STATUS_TTL:
            return _status_cache["data"]
    data = _build_status_fresh()
    with _status_cache_lock:
        _status_cache["data"] = data
        _status_cache["ts"] = time.time()
    return data


def _get_firewall_data():
    """Get firewall data, refreshing cache via SSH if stale."""
    cached = firewall_parser.get_cached()
    if cached:
        return cached
    raw = engine._run_router_cmd("nft -j list ruleset")
    if not raw:
        return None
    parsed = firewall_parser.parse_nft_json(raw)
    if parsed:
        firewall_parser.update_cache(parsed)
    return parsed

from sse_broker import SSEBroker, SSESource
_sse_broker = SSEBroker(build_status)

# Register core data sources that were previously hardcoded in the broker.
# These will be migrated to plugins eventually; for now they register here.
_sse_broker.register_source(SSESource(
    name="energy",
    event_type="energy",
    collect_fn=_get_energy_data,
    interval_seconds=30,
    burst=True,
    burst_priority=3,
    burst_filter=lambda d: "error" not in d,
))

def _collect_latency():
    from latency_prober import get_latency_grouped
    topo_nodes = realm_db.get_topology().get("nodes", [])
    return get_latency_grouped(topo_nodes)

_sse_broker.register_source(SSESource(
    name="latency",
    event_type="latency",
    collect_fn=_collect_latency,
    interval_seconds=30,
    burst=True,
    burst_priority=4,
))

_sse_broker.register_source(SSESource(
    name="firewall",
    event_type="firewall",
    collect_fn=_get_firewall_data,
    interval_seconds=60,
    burst=False,  # May trigger slow SSH — skip in burst
))

_sse_broker.register_source(SSESource(
    name="wifi",
    event_type="wifi",
    collect_fn=ap_scanner.get_ap_info,
    interval_seconds=120,
    burst=False,  # May trigger slow SSH — skip in burst
))

# Plugin system — initialized in __main__ after DB init
_plugin_registry = None


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


# ── Route Table Setup ──
from route_table import RouteTable
from plugin_context import PluginRequest

_route_table = RouteTable()


# ── GET Route Handlers ──
# Each handler takes (req: PluginRequest, params: dict) and returns dict | None.
# Return dict for JSON response, None if handler already sent the response.

def _h_get_status(req, params):
    return build_status()


def _h_get_firewall(req, params):
    cached = firewall_parser.get_cached()
    if cached:
        return cached
    raw = engine._run_router_cmd("nft -j list ruleset")
    if not raw:
        req.respond({"error": "Cannot reach gatekeeper"}, 503)
        return None
    parsed = firewall_parser.parse_nft_json(raw)
    if parsed:
        firewall_parser.update_cache(parsed)
        return parsed
    req.respond({"error": "Failed to parse nft rules"}, 500)
    return None

def _h_get_quests(req, params):
    return realm_db.get_quests()

def _h_get_events(req, params):
    qp = req.query_params
    since = float(qp.get("since", 0) or 0)
    limit = int(qp.get("limit", 0) or 0)
    events = get_events_since(since)
    if limit > 0:
        events = events[-limit:]
    return events

def _h_get_notion_sync(req, params):
    try:
        if "force=1" in req.path:
            notion_sync.force_resync()
        result = notion_sync.sync_to_events()
        if "error" in result:
            req.respond(result, 503)
            return None
        for evt in result.get("events", []):
            push_event(evt)
        return result
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_get_personas(req, params):
    return _load_personas()

def _h_get_topology(req, params):
    return _load_topology()

def _h_get_scan(req, params):
    return ap_scanner.scan_and_update()

def _h_get_scan_status(req, params):
    return ap_scanner.get_last_scan()

def _h_get_scan_lldp(req, params):
    links = ap_scanner.detect_ethernet_topology()
    topo = _load_topology()
    auto_switches = [n for n in topo.get("nodes", []) if n.get("_auto_switch")]
    return {
        "links": len(links),
        "switches": len(auto_switches),
        "connections": [
            {"from": l["from_node"], "to": l["to_node"],
             "type": l.get("protocol", "lldp")}
            for l in links
        ],
        "cliques": [n["id"] for n in auto_switches],
    }

def _h_get_scan_wifi(req, params):
    return ap_scanner.get_wifi_signal()

def _h_get_wifi_aps(req, params):
    return ap_scanner.get_ap_info()

def _h_get_ping_ip(req, params):
    ip = params.get("ip", "")
    try:
        result = subprocess.run(
            ["ping", "-c", "3", "-W", "2", ip],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            for line in result.stdout.split("\n"):
                if "avg" in line.lower() or "rtt" in line.lower():
                    parts = line.split("=")[-1].split("/")
                    if len(parts) >= 2:
                        return {"ok": True, "ip": ip, "rtt_ms": float(parts[1])}
            return {"ok": True, "ip": ip, "rtt_ms": None}
        else:
            return {"ok": False, "ip": ip, "error": "Host unreachable"}
    except Exception as e:
        return {"ok": False, "ip": ip, "error": str(e)}

def _h_get_server_info(req, params):
    import platform
    return {
        "port": PORT,
        "domain": os.environ.get("REALM_DOMAIN", ""),
        "hostname": platform.node(),
        "python": platform.python_version(),
        "pid": os.getpid(),
        "uptime": int(time.time() - _server_start_time),
    }

def _h_get_config(req, params):
    return {
        "chat": realm_db.get_settings("chat"),
        "speech": realm_db.get_settings("speech"),
        "oracle": realm_db.get_persona("scrying-pool") or {},
    }

def _h_get_settings(req, params):
    return realm_db.get_settings("ui")

def _h_get_codex_sync(req, params):
    try:
        force = "force=1" in req.path
        data = codex_sync.get_grouped() if not force else None
        if force:
            codex_sync.fetch_codex(force=True)
            data = codex_sync.get_grouped()
        return data
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_get_codex(req, params):
    req.redirect("/codex/")
    return None

def _h_get_codex_index(req, params):
    codex_path = os.path.join(MAP_DIR, "docs", "codex", "index.html")
    if os.path.isfile(codex_path):
        req._handler.path = "/docs/codex/index.html"
        req._handler._serve_static_gzip()
    else:
        req._handler.send_error(404, "Codex not found")
    return None

def _h_get_energy(req, params):
    return _get_energy_data()

def _h_get_collectd(req, params):
    qp = req.query_params
    hostname = qp.get("host")
    if hostname:
        summary = get_host_summary(hostname)
        return summary or {"error": f"No data for {hostname}"}
    return get_all_summaries()

def _h_get_observation(req, params):
    status = engine.get_status()
    return {
        "observation": engine.adult_observation(status),
        "status": status,
    }

def _h_get_herald(req, params):
    qp = req.query_params
    action = qp.get("action", "status")
    if action == "status":
        return _herald_status()
    elif action == "start":
        interval = int(qp.get("interval", 90))
        pid = _herald_start(interval)
        return {"ok": True, "pid": pid, "interval": interval}
    elif action == "stop":
        _herald_stop()
        return {"ok": True, "stopped": True}
    elif action == "once":
        return _herald_once()
    else:
        req.respond({"error": f"Unknown action: {action}"}, 400)
        return None

def _h_get_player(req, params):
    return realm_db.get_player_stats()

def _h_get_ping(req, params):
    return {"t": time.time()}

def _h_get_resolve_url(req, params):
    import socket, urllib.request, urllib.error, ssl
    qp = req.query_params
    hostname = qp.get("hostname", "").strip()
    ip = qp.get("ip", "").strip()
    if not hostname and not ip:
        req.respond({"error": "need hostname or ip"}, 400)
        return None
    def _tcp_open(host, port, timeout=0.3):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(timeout)
            r = s.connect_ex((host, port))
            s.close()
            return r == 0
        except Exception:
            return False
    def _dns_resolve(name):
        try:
            return socket.gethostbyname(name)
        except socket.gaierror:
            return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    resolved = None
    jphe = f"{hostname}.jphe.in" if hostname else None
    jphe_ip = _dns_resolve(jphe) if jphe else None
    if jphe_ip:
        if _tcp_open(jphe_ip, 443):
            resolved = f"https://{jphe}"
        elif _tcp_open(jphe_ip, 80):
            resolved = f"http://{jphe}"
    if not resolved and ip:
        if _tcp_open(ip, 443):
            resolved = f"https://{hostname}" if hostname else f"https://{ip}"
        elif _tcp_open(ip, 80):
            resolved = f"http://{ip}"
    if not resolved and ip:
        from concurrent.futures import as_completed
        WEB_PORTS = [(8123, "https"), (1880, "http"), (8096, "http"), (4533, "http"),
                     (2283, "http"), (8384, "https"), (8080, "http"), (8443, "https"),
                     (9090, "http"), (3000, "http"), (5000, "http"), (8888, "http")]
        futures = {_resolve_pool.submit(_tcp_open, ip, port): (port, scheme)
                   for port, scheme in WEB_PORTS}
        for fut in as_completed(futures):
            port, scheme = futures[fut]
            if fut.result():
                host = jphe if jphe_ip == ip else ip
                resolved = f"{scheme}://{host}:{port}"
                break
    return {"url": resolved}

def _h_get_debug(req, params):
    c = realm_db._conn()
    _DEBUG_TABLES = frozenset(("settings", "events", "personas", "nodes",
                               "connections", "regions", "notion_synced", "wifi_scans"))
    counts = {}
    for table in _DEBUG_TABLES:
        try:
            counts[table] = c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except Exception:
            counts[table] = -1
    scan = realm_db.get_wifi_scan()
    return {
        "tables": counts,
        "db_path": realm_db.DB_PATH,
        "db_size": os.path.getsize(realm_db.DB_PATH) if os.path.exists(realm_db.DB_PATH) else 0,
        "wifi_scan_ts": scan.get("ts", 0),
        "notion_synced": len(realm_db.get_notion_synced()),
        "settings_ns": list(realm_db.get_settings().keys()),
    }

def _h_get_scripts(req, params):
    scripts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts")
    scripts = []
    if os.path.isdir(scripts_dir):
        for f in sorted(os.listdir(scripts_dir)):
            fp = os.path.join(scripts_dir, f)
            if os.path.isfile(fp) and os.access(fp, os.X_OK):
                desc = ""
                try:
                    with open(fp) as fh:
                        for line in fh:
                            line = line.strip()
                            if line.startswith("#!"):
                                continue
                            if line.startswith("#"):
                                desc = line.lstrip("# ").strip()
                            break
                except Exception:
                    pass
                scripts.append({"name": f, "path": f"scripts/{f}", "description": desc})
    return {"scripts": scripts}

def _h_get_chat_sessions(req, params):
    sessions = chat_bridge.list_sessions()
    return {"sessions": sessions, "current": chat_bridge.DEFAULT_SESSION}

def _h_get_chat_history(req, params):
    qp = req.query_params
    session = qp.get("session")
    history = chat_bridge.get_session_history(session)
    return {"history": history, "session": session or chat_bridge.DEFAULT_SESSION}

def _h_get_reset(req, params):
    realm_db.set_settings("ui", {})
    html = """<!DOCTYPE html><html><head><title>Reset</title></head><body>
<script>
localStorage.removeItem('realm-map-settings-v3');
localStorage.removeItem('realm-panel-formation');
localStorage.removeItem('realm-map-layout');
localStorage.clear();
window.location.href = '/';
</script>
<p>Clearing settings and redirecting...</p>
</body></html>"""
    req.respond_html(html)
    return None

def _h_get_skills(req, params):
    skills_dir = os.path.join(os.path.dirname(__file__), ".claude", "skills")
    result = []
    if os.path.isdir(skills_dir):
        for name in sorted(os.listdir(skills_dir)):
            skill_file = os.path.join(skills_dir, name, "SKILL.md")
            if os.path.isfile(skill_file):
                with open(skill_file, "r") as f:
                    raw = f.read()
                meta = {"name": name, "description": "", "path": f".claude/skills/{name}/SKILL.md", "body": raw}
                if raw.startswith("---"):
                    parts = raw.split("---", 2)
                    if len(parts) >= 3:
                        for line in parts[1].strip().split("\n"):
                            if line.startswith("name:"):
                                meta["name"] = line.split(":", 1)[1].strip()
                            elif line.startswith("description:"):
                                meta["description"] = line.split(":", 1)[1].strip()
                        meta["body"] = parts[2].strip()
                result.append(meta)
    return result

def _h_get_claude_md(req, params):
    claude_md = os.path.join(os.path.dirname(__file__), "CLAUDE.md")
    if os.path.isfile(claude_md):
        with open(claude_md, "r") as f:
            content = f.read()
        return {"content": content, "path": "CLAUDE.md"}
    return {"content": "", "path": "CLAUDE.md"}

def _h_get_agents(req, params):
    result = []
    for base in [os.path.join(os.path.dirname(__file__), ".claude", "agents"),
                 os.path.expanduser("~/.claude/agents")]:
        if not os.path.isdir(base):
            continue
        for fname in sorted(os.listdir(base)):
            if not fname.endswith(".md"):
                continue
            fpath = os.path.join(base, fname)
            with open(fpath, "r") as f:
                raw = f.read()
            agent = {"name": fname.replace(".md", ""), "description": "", "path": fpath, "body": raw}
            if raw.startswith("---"):
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    for line in parts[1].strip().split("\n"):
                        if line.startswith("name:"):
                            agent["name"] = line.split(":", 1)[1].strip()
                        elif line.startswith("description:"):
                            agent["description"] = line.split(":", 1)[1].strip()
                    agent["body"] = parts[2].strip()
            result.append(agent)
    return result

def _h_get_hooks(req, params):
    hooks_file = os.path.join(os.path.dirname(__file__), ".claude", "settings.json")
    result = {"hooks": [], "path": ".claude/settings.json"}
    if os.path.isfile(hooks_file):
        try:
            with open(hooks_file, "r") as f:
                settings = json.load(f)
            for event_type, hooks in settings.get("hooks", {}).items():
                for hook in hooks:
                    result["hooks"].append({
                        "event": event_type,
                        "command": hook.get("command", ""),
                        "matcher": hook.get("matcher", ""),
                    })
        except Exception:
            pass
    return result

def _h_get_plugins(req, params):
    """List loaded plugins with status."""
    plugins = []
    if _plugin_registry:
        for p in _plugin_registry.get_all_plugins():
            info = {"name": p.name, "version": p.version, "type": p.plugin_type,
                    "description": p.description, "fantasy_name": p.fantasy_name,
                    "icon": p.icon, "status": p.status}
            panels = [pnl for pnl in _plugin_registry.get_panels() if pnl.plugin == p.name]
            if panels:
                pnl = panels[0]
                info["panel"] = {"id": pnl.id, "name": pnl.name, "anchor": pnl.anchor,
                                 "priority": pnl.priority,
                                 "html": pnl.html, "js": pnl.js, "css": pnl.css}
            plugins.append(info)
    else:
        # Fallback: scan plugin directories before registry is initialized
        plugins_dir = os.path.join(MAP_DIR, "plugins")
        if os.path.isdir(plugins_dir):
            for name in sorted(os.listdir(plugins_dir)):
                manifest_path = os.path.join(plugins_dir, name, "plugin.json")
                if os.path.isfile(manifest_path):
                    try:
                        with open(manifest_path, "r") as f:
                            manifest = json.load(f)
                        plugins.append({
                            "name": name,
                            "version": manifest.get("version", "0.0.0"),
                            "type": manifest.get("type", "unknown"),
                            "description": manifest.get("description", ""),
                            "fantasy_name": manifest.get("fantasy_name", name),
                            "icon": manifest.get("icon", ""),
                            "status": "discovered",
                        })
                    except Exception:
                        plugins.append({"name": name, "status": "error"})
    return {"plugins": plugins}

def _h_get_sse_sources(req, params):
    """List registered SSE sources."""
    sources = _sse_broker.get_sources()
    return {"sources": [
        {"name": s.name, "event_type": s.event_type,
         "interval": s.interval_seconds, "burst": s.burst,
         "burst_priority": s.burst_priority}
        for s in sources
    ]}


# ── POST Route Handlers ──

def _h_post_chat(req, params):
    try:
        data = req.json()
        message = data.get("message", "").strip()
        if not message:
            req.respond({"error": "Missing 'message'"}, 400)
            return None
        node_id = data.get("node")
        session = data.get("session")
        extra_context = data.get("context")
        future = asyncio.run_coroutine_threadsafe(
            chat_bridge.chat(message, node_id, session, extra_context),
            _async_loop,
        )
        result = future.result(timeout=120)
        if result.get("error"):
            req.respond(result, 500)
            return None
        response_text = result.get("response") or ""
        push_event({
            "type": "oracle_query",
            "node": node_id or "scrying-pool",
            "text": message[:100] + ("..." if len(message) > 100 else ""),
        })
        if response_text:
            push_event({
                "type": "oracle_response",
                "node": node_id or "scrying-pool",
                "text": response_text[:200] + ("..." if len(response_text) > 200 else ""),
            })
        return result
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_chat_clear(req, params):
    try:
        data = req.json()
        chat_bridge.clear_session(data.get("session"))
        return {"ok": True}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_event(req, params):
    try:
        push_event(req.json())
        return {"ok": True}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_personas(req, params):
    try:
        update = req.json()
        node_key = update.get("node")
        if not node_key:
            req.respond({"error": "missing 'node' key"}, 400)
            return None
        if update.get("_delete"):
            realm_db.delete_persona(node_key)
        else:
            existing = realm_db.get_persona(node_key) or {}
            for field in ("name", "title", "voice", "system_prompt", "hints"):
                if field in update:
                    existing[field] = update[field]
            realm_db.set_persona(node_key, existing)
        personas = realm_db.get_personas()
        with open(PERSONAS_FILE, "w") as f:
            json.dump(personas, f, indent=2)
        return {"ok": True, "personas": personas}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_quest_delete(req, params):
    try:
        data = req.json()
        quest_id = data.get("id", "")
        text = data.get("text", "")
        if quest_id:
            deleted = realm_db.delete_quest(quest_id)
        elif text:
            deleted = realm_db.delete_quest_by_text(text)
        else:
            req.respond({"error": "missing id or text"}, 400)
            return None
        return {"deleted": deleted}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_quest_update(req, params):
    try:
        data = req.json()
        quest_id = data.get("id", "")
        status = data.get("status", "")
        if not quest_id or not status:
            req.respond({"error": "missing id or status"}, 400)
            return None
        ok = realm_db.update_quest_status(quest_id, status)
        if ok:
            return {"ok": True, "id": quest_id, "status": status}
        req.respond({"error": "quest not found"}, 404)
        return None
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_player_reward(req, params):
    try:
        data = req.json()
        source = data.get("source", "")
        source_id = data.get("id", "")
        if source not in ("quest", "sub", "event") or not source_id:
            req.respond({"error": "missing or invalid source/id"}, 400)
            return None
        result = realm_db.grant_reward(source, str(source_id))
        result["ok"] = True
        return result
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_quest_create(req, params):
    try:
        quest = req.json()
        if "id" not in quest or "title" not in quest:
            req.respond({"error": "missing id or title"}, 400)
            return None
        realm_db.upsert_quest(quest)
        return {"ok": True, "id": quest["id"]}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_notion_complete(req, params):
    try:
        data = req.json()
        notion_id = data.get("notion_id", "")
        if not notion_id:
            req.respond({"error": "missing notion_id"}, 400)
            return None
        result = notion_sync.complete(notion_id)
        if "error" in result:
            req.respond(result, 503)
            return None
        push_event({
            "type": "system",
            "node": "notion-portal",
            "text": "A quest has been sealed in the archives.",
        })
        return result
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_config(req, params):
    try:
        data = req.json()
        if "chat" in data:
            safe = {k: v for k, v in data["chat"].items() if k in _CHAT_SAFE_KEYS}
            realm_db.set_settings("chat", safe)
            _write_config_file(_CHAT_CONFIG, safe, _CHAT_SAFE_KEYS)
        if "speech" in data:
            safe = {k: v for k, v in data["speech"].items() if k in _SPEECH_SAFE_KEYS}
            realm_db.set_settings("speech", safe)
            _write_config_file(_SPEECH_CONFIG, safe, _SPEECH_SAFE_KEYS)
        if "oracle" in data:
            oracle = realm_db.get_persona("scrying-pool") or {}
            for k in ("model", "reasoning_effort", "voice", "system_prompt"):
                if k in data["oracle"]:
                    oracle[k] = data["oracle"][k]
            realm_db.set_persona("scrying-pool", oracle)
            personas = realm_db.get_personas()
            with open(PERSONAS_FILE, "w") as f:
                json.dump(personas, f, indent=2)
        return {"ok": True}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_settings(req, params):
    try:
        realm_db.set_settings("ui", req.json())
        return {"ok": True}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_wled_state(req, params):
    try:
        data = req.json()
        return wled_bridge.set_wled_state(
            params.get("node_id", ""),
            on=data.get("on"), brightness=data.get("bri"), effect=data.get("fx")
        )
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_wol(req, params):
    try:
        data = req.json()
        mac = data.get("mac", "").replace(":", "").replace("-", "").lower()
        if len(mac) != 12:
            req.respond({"error": "Invalid MAC address"}, 400)
            return None
        mac_bytes = bytes.fromhex(mac)
        magic = b'\xff' * 6 + mac_bytes * 16
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(magic, ("255.255.255.255", 9))
        if data.get("ip"):
            ip_parts = data["ip"].rsplit(".", 1)
            if len(ip_parts) == 2:
                sock.sendto(magic, (ip_parts[0] + ".255", 9))
        sock.close()
        return {"ok": True, "mac": mac, "sent": True}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_connections(req, params):
    try:
        data = req.json()
        conns = data.get("connections")
        if conns is None:
            req.respond({"error": "missing 'connections'"}, 400)
            return None
        realm_db.set_connections(conns)
        realm_db.save_topology_json(TOPOLOGY_FILE)
        return {"ok": True, "count": len(conns)}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_node(req, params):
    try:
        data = req.json()
        node_id = data.get("id", "").strip()
        if not node_id:
            req.respond({"error": "missing 'id'"}, 400)
            return None
        if data.get("_delete"):
            realm_db.delete_node(node_id)
        elif "x" in data and "y" in data and len(data) <= 3:
            realm_db.update_node_position(node_id, data["x"], data["y"])
        else:
            existing = realm_db.get_node(node_id)
            if existing:
                existing.update(data)
                realm_db.set_node(node_id, existing)
            else:
                realm_db.set_node(node_id, data)
        realm_db.save_topology_json(TOPOLOGY_FILE)
        return {"ok": True}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_topology(req, params):
    try:
        data = req.json()
        if "nodes" in data:
            for node in data["nodes"]:
                nid = node.get("id", "")
                if nid:
                    realm_db.set_node(nid, node)
        if "connections" in data:
            realm_db.set_connections(data["connections"])
        if "regions" in data:
            realm_db.set_regions(data["regions"])
        realm_db.save_topology_json(TOPOLOGY_FILE)
        return {"ok": True}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_ssh(req, params):
    try:
        data = req.json()
        host = data.get("host", "")
        command = data.get("command", "")
        topo = _load_topology()
        allowed = {n["ssh"] for n in topo.get("nodes", []) if n.get("ssh")}
        if host not in allowed:
            req.respond({"error": f"Host '{host}' not permitted"}, 403)
            return None
        if not command.strip():
            req.respond({"error": "Empty command"}, 400)
            return None
        result = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no",
             host, command],
            capture_output=True, text=True, timeout=30
        )
        return {
            "output": result.stdout[-50000:] if result.stdout else "",
            "error": result.stderr[-5000:] if result.returncode != 0 else None,
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        req.respond({"error": "Command timed out (30s)"}, 504)
        return None
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None

def _h_post_skills(req, params):
    try:
        data = req.json()
        name = data.get("name", "").strip()
        description = data.get("description", "").strip()
        skill_body = data.get("body", "")
        if not name:
            req.respond({"error": "missing name"}, 400)
            return None
        safe_name = "".join(c for c in name if c.isalnum() or c in "-_").strip("-_")
        if not safe_name:
            req.respond({"error": "invalid name"}, 400)
            return None
        skills_dir = os.path.join(os.path.dirname(__file__), ".claude", "skills", safe_name)
        os.makedirs(skills_dir, exist_ok=True)
        skill_file = os.path.join(skills_dir, "SKILL.md")
        content = f"---\nname: {safe_name}\ndescription: {description}\n---\n\n{skill_body}\n"
        with open(skill_file, "w") as f:
            f.write(content)
        return {"ok": True, "name": safe_name}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_claude_md(req, params):
    try:
        content = req.json().get("content", "")
        claude_md = os.path.join(os.path.dirname(__file__), "CLAUDE.md")
        with open(claude_md, "w") as f:
            f.write(content)
        return {"ok": True}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


# ── DELETE Route Handlers ──

def _h_delete_settings(req, params):
    try:
        realm_db.set_settings("ui", {})
        return {"ok": True}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


# ── Register All Core Routes ──

_route_table.add("GET", "/status", _h_get_status)
_route_table.add("GET", "/firewall", _h_get_firewall)
_route_table.add("GET", "/quests", _h_get_quests)
_route_table.add("GET", "/events", _h_get_events)
_route_table.add("GET", "/notion-sync", _h_get_notion_sync)
_route_table.add("GET", "/personas", _h_get_personas)
_route_table.add("GET", "/topology", _h_get_topology)
_route_table.add("GET", "/scan", _h_get_scan)
_route_table.add("GET", "/scan/status", _h_get_scan_status)
_route_table.add("GET", "/scan/lldp", _h_get_scan_lldp)
_route_table.add("GET", "/scan/wifi", _h_get_scan_wifi)
_route_table.add("GET", "/wifi/aps", _h_get_wifi_aps)
_route_table.add("GET", "/ping/<ip>", _h_get_ping_ip)
_route_table.add("GET", "/server-info", _h_get_server_info)
_route_table.add("GET", "/config", _h_get_config)
_route_table.add("GET", "/settings", _h_get_settings)
_route_table.add("GET", "/codex-sync", _h_get_codex_sync)
_route_table.add("GET", "/codex", _h_get_codex)
_route_table.add("GET", "/codex/", _h_get_codex_index)
_route_table.add("GET", "/energy", _h_get_energy)
_route_table.add("GET", "/collectd", _h_get_collectd)
_route_table.add("GET", "/observation", _h_get_observation)
_route_table.add("GET", "/herald", _h_get_herald)
_route_table.add("GET", "/player", _h_get_player)
_route_table.add("GET", "/ping", _h_get_ping)
_route_table.add("GET", "/resolve-url", _h_get_resolve_url)
_route_table.add("GET", "/debug", _h_get_debug)
_route_table.add("GET", "/scripts", _h_get_scripts)
_route_table.add("GET", "/chat/sessions", _h_get_chat_sessions)
_route_table.add("GET", "/chat/history", _h_get_chat_history)
_route_table.add("GET", "/reset", _h_get_reset)
_route_table.add("GET", "/skills", _h_get_skills)
_route_table.add("GET", "/claude-md", _h_get_claude_md)
_route_table.add("GET", "/agents", _h_get_agents)
_route_table.add("GET", "/hooks", _h_get_hooks)
_route_table.add("GET", "/plugins", _h_get_plugins)
_route_table.add("GET", "/plugins/", _h_get_plugins)
_route_table.add("GET", "/sse/sources", _h_get_sse_sources)

_route_table.add("POST", "/chat", _h_post_chat)
_route_table.add("POST", "/chat/clear", _h_post_chat_clear)
_route_table.add("POST", "/event", _h_post_event)
_route_table.add("POST", "/personas", _h_post_personas)
_route_table.add("POST", "/quest-delete", _h_post_quest_delete)
_route_table.add("POST", "/quest-update", _h_post_quest_update)
_route_table.add("POST", "/player/reward", _h_post_player_reward)
_route_table.add("POST", "/quest-create", _h_post_quest_create)
_route_table.add("POST", "/notion-complete", _h_post_notion_complete)
_route_table.add("POST", "/config", _h_post_config)
_route_table.add("POST", "/settings", _h_post_settings)
_route_table.add("POST", "/wled/<node_id>/state", _h_post_wled_state)
_route_table.add("POST", "/wol", _h_post_wol)
_route_table.add("POST", "/connections", _h_post_connections)
_route_table.add("POST", "/node", _h_post_node)
_route_table.add("POST", "/topology", _h_post_topology)
_route_table.add("POST", "/ssh", _h_post_ssh)
_route_table.add("POST", "/skills", _h_post_skills)
_route_table.add("POST", "/claude-md", _h_post_claude_md)

_route_table.add("DELETE", "/settings", _h_delete_settings)

_route_table.check_conflicts()


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
        # SSE endpoint — requires persistent connection, can't use route table
        if self.path.startswith("/sse") and not self.path.startswith("/sse/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            client_q = _sse_broker.add_client()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event_type, payload = client_q.get(timeout=15)
                        self.wfile.write(f"event: {event_type}\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                _sse_broker.remove_client(client_q)
            return

        # Route table lookup — handles all core + plugin GET endpoints
        match = _route_table.match("GET", self.path)
        if match:
            handler, params = match
            result = handler(PluginRequest(self), params)
            if result is not None:
                self._json_response(result)
            return

        # Plugin static files: /plugins/<name>/<file>
        if self.path.startswith("/plugins/"):
            self._serve_plugin_static(self.path)
            return

        # Static files — serve splash.html as index
        if self.path == '/' or self.path == '/index.html':
            self.path = '/splash.html'
        self._serve_static_gzip()

    _GZIP_TYPES = {'.js', '.css', '.html', '.json', '.svg', '.map'}

    def _serve_static_gzip(self):
        """Serve static files with gzip if client accepts it (mtime-based cache)."""
        path = self.translate_path(self.path)
        ext = os.path.splitext(path)[1].lower()
        accept_gz = 'gzip' in self.headers.get('Accept-Encoding', '')
        if accept_gz and ext in self._GZIP_TYPES and os.path.isfile(path):
            try:
                mtime = os.path.getmtime(path)
                size = os.path.getsize(path)
                cache_key = path
                etag = f'"{int(mtime)}-{size}"'

                # Handle If-None-Match for 304 (static assets only)
                if ext in ('.js', '.css', '.svg'):
                    inm = self.headers.get('If-None-Match', '')
                    if inm == etag:
                        self.send_response(304)
                        self.send_header("ETag", etag)
                        self.send_header("Cache-Control", "no-cache")
                        self.end_headers()
                        return

                # Check gzip cache
                with _gzip_cache_lock:
                    cached = _gzip_cache.get(cache_key)
                    if cached and cached[0] == mtime:
                        compressed = cached[1]
                    else:
                        compressed = None

                if compressed is None:
                    with open(path, 'rb') as f:
                        raw = f.read()
                    compressed = gzip.compress(raw, compresslevel=6)
                    with _gzip_cache_lock:
                        _gzip_cache[cache_key] = (mtime, compressed)

                self.send_response(200)
                ctype = self.guess_type(path)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Content-Length", len(compressed))
                self.send_header("Access-Control-Allow-Origin", "*")
                if ext in ('.js', '.css', '.svg'):
                    self.send_header("ETag", etag)
                self.end_headers()
                self.wfile.write(compressed)
            except Exception:
                super().do_GET()
        else:
            super().do_GET()

    _MIME_TYPES = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.svg': 'image/svg+xml', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.gif': 'image/gif',
        '.woff2': 'font/woff2', '.woff': 'font/woff',
    }

    def _serve_plugin_static(self, url_path):
        """Serve static files from plugin directories with path traversal prevention."""
        # Parse /plugins/<name>/<file_path>
        parts = url_path.split("/", 3)  # ['', 'plugins', 'name', 'file']
        if len(parts) < 4:
            self.send_error(404)
            return

        plugin_name = parts[2]
        file_path = parts[3].split("?")[0]  # strip query string

        # Resolve and verify path stays within plugin directory
        plugins_dir = os.path.join(MAP_DIR, "plugins", plugin_name)
        full_path = os.path.normpath(os.path.join(plugins_dir, file_path))

        if not full_path.startswith(os.path.normpath(plugins_dir)):
            self.send_error(403, "Access denied")
            return

        if not os.path.isfile(full_path):
            self.send_error(404)
            return

        ext = os.path.splitext(full_path)[1].lower()
        content_type = self._MIME_TYPES.get(ext, 'application/octet-stream')

        try:
            with open(full_path, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", len(data))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_error(500)

    def end_headers(self):
        # Default to no-cache (allows ETag/304 revalidation) unless already set
        # Check if Cache-Control was already explicitly sent in this response
        buf = getattr(self, '_headers_buffer', [])
        has_cc = any(b'Cache-Control' in line for line in buf if isinstance(line, bytes))
        if not has_cc:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        # Route table lookup — handles all core + plugin POST endpoints
        match = _route_table.match("POST", self.path)
        if match:
            handler, params = match
            result = handler(PluginRequest(self), params)
            if result is not None:
                self._json_response(result)
            return
        self.send_error(404)

    def do_DELETE(self):
        # Route table lookup — handles all core + plugin DELETE endpoints
        match = _route_table.match("DELETE", self.path)
        if match:
            handler, params = match
            result = handler(PluginRequest(self), params)
            if result is not None:
                self._json_response(result)
            return
        self._json_response({"error": "Not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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
    ap_scanner._topo_callback = lambda: _sse_broker.send_event("topology", realm_db.get_topology())
    ap_scanner.start_background_scanner()
    ha_bridge.start_ha_bridge()
    wled_bridge.start_wled_bridge()
    event_generator.start_event_generator(push_event)
    latency_prober.start()

    # ── Plugin system startup ──
    # Plugins register into the same _route_table that core routes use (defined at module level)
    import plugin_loader
    print("Loading plugins...")
    _plugin_registry = plugin_loader.load_plugins(
        route_table=_route_table,
        push_event_fn=push_event,
        sse_broker=_sse_broker,
    )
    plugin_count = len(_plugin_registry.get_all_plugins())
    if plugin_count:
        print(f"Loaded {plugin_count} plugin(s)")
        # Register plugin SSE sources with the broker
        for source in _plugin_registry.get_sse_sources():
            _sse_broker.register_source(SSESource(
                name=source.plugin or source.event_type,
                event_type=source.event_type,
                collect_fn=source.getter_fn,
                interval_seconds=source.interval,
                burst=source.burst,
                burst_priority=source.burst_priority,
            ))

    _sse_broker.start()
    ThreadingHTTPServer(("", PORT), RealmHandler).serve_forever()
