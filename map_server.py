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
import node_roles
import realm_db

engine = RealmEngine()
PORT = int(os.environ.get("REALM_PORT", 80))
_server_start_time = time.time()
_server_start_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
MAP_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONAS_FILE = os.path.join(MAP_DIR, "personas.json")
TOPOLOGY_FILE = os.path.join(MAP_DIR, "topology.json")
_CHAT_CONFIG = os.path.expanduser("~/.config/azure-chat-assistant/config.json")
_SPEECH_CONFIG = os.path.expanduser("~/.config/speech-to-cli/config.json")
_discovery_engine = None  # Set during startup

# ── game.db write-back helpers ──
import sqlite3 as _sql
from realm_text import real_home as _real_home
_GAME_DB = str(_real_home() / ".realmwatch" / "game.db")

def _generate_ulid():
    """Generate a ULID (26 chars, Crockford base32). Matches os.realm.watch format."""
    _ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    t = int(time.time() * 1000)
    ts = ""
    for _ in range(10):
        ts = _ENC[t & 0x1F] + ts
        t >>= 5
    rand = ""
    for b in os.urandom(10):
        rand += _ENC[b & 0x1F] + _ENC[(b >> 5) & 0x1F]
    return ts + rand[:16]

def _game_db_rw():
    """Open game.db for read-write access."""
    conn = _sql.connect(_GAME_DB, timeout=10)
    conn.row_factory = _sql.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def _game_level_info(total_xp, level):
    """Derive level stats matching the frontend's updateDockHUD expectations.
    Uses game.db formula: level N requires sum(100*i for i in range(1, N)) total XP."""
    xp_level_start = sum(100 * i for i in range(1, level))
    xp_next_total = sum(100 * i for i in range(1, level + 1))
    xp_next = xp_next_total - xp_level_start  # XP needed for this level span
    xp_in_level = total_xp - xp_level_start
    return {
        "level": level, "xp": total_xp,
        "xp_next": xp_next, "xp_in_level": xp_in_level,
        "xp_level_start": xp_level_start,
        "gold": 0, "gems": 0,
    }


def _validate_ip(ip):
    """Validate dotted-quad IPv4 address."""
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    return all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)

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

# ── Sublabel host lookup cache ──
_sublabel_host_map = {"map": {}, "topo_mtime": 0, "collectd_keys": frozenset()}
_sublabel_host_lock = threading.Lock()


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


def _get_fleet_api():
    """Look up the lexicon plugin's exposed API, or None if not loaded.

    Falls back across module instances the same way push_event() does, since
    `import map_server` after `python map_server.py` can create a second
    module object with _plugin_registry still None.
    """
    registry = _plugin_registry
    if registry is None:
        import sys as _sys
        for mod_name in ("__main__", "map_server"):
            mod = _sys.modules.get(mod_name)
            if mod is not None and getattr(mod, "_plugin_registry", None) is not None:
                registry = mod._plugin_registry
                break
    if registry is None:
        return None
    return registry.get_plugin_api("lexicon")


def _join_fleet_into_nodes(nodes, fleet_api):
    """Replace identity fields (label, role, realm, kind) with values from fleet catalog.

    nodes is the list of dicts the topology endpoint builds (each has at minimum
    'id' and may have 'data' nested dict). fleet_api is the dict exposed by the
    lexicon plugin (with 'resolve', 'list', 'loaded' keys), or None if the plugin
    isn't loaded.
    """
    if not fleet_api or not fleet_api.get("loaded"):
        return nodes
    resolve = fleet_api["resolve"]
    out = []
    for node in nodes:
        fid = (node.get("data") or {}).get("fleet_id") or node.get("fleet_id")
        entry = resolve(fid) if fid else None
        if entry is None:
            out.append(node)
            continue
        merged = dict(node)
        merged.setdefault("data", {})
        merged["label"] = entry.current_name
        merged["fleet_id"] = entry.fleet_id
        if entry.realm:
            merged["realm"] = entry.realm
        if entry.role:
            merged["role"] = entry.role
        if entry.kind:
            merged["kind"] = entry.kind
        out.append(merged)
    return out


def _enrich_node_types(nodes):
    """Fill each node's `type` from node_roles enrichment when it lacks one.

    Most stored nodes have `type: null` because node_roles computes the role at
    render time and never persists it (#98) — which breaks type-based CLI
    filters and ansible inventory grouping. This makes the enriched
    classification queryable on GET /topology (and the SSE topology event)
    without reimplementing enrichment (reuses node_roles.get_role) and without
    clobbering any explicit structural type already set on a node (e.g. "core",
    "infra", "bridge"). Non-destructive: only empty/missing `type` is filled,
    and only changed nodes are shallow-copied so the cached topology dict is
    never mutated.
    """
    out = []
    for node in nodes:
        nid = node.get("id")
        if node.get("type") or not nid:
            out.append(node)
            continue
        try:
            role = node_roles.get_role(nid, node)
        except Exception:
            out.append(node)
            continue
        if not role:
            out.append(node)
            continue
        merged = dict(node)
        merged["type"] = role
        out.append(merged)
    return out


def _resolve_node_id(node_id_or_name, plugin_registry):
    """Resolve any string (current_name, prior_name, fleet_id) to current node_id.
    Returns the input unchanged if no fleet entry matches (backward-compat)."""
    fleet_api = plugin_registry.get_plugin_api("lexicon") if plugin_registry else None
    if not fleet_api or not fleet_api.get("loaded"):
        return node_id_or_name
    entry = fleet_api["resolve"](node_id_or_name)
    if entry is None:
        return node_id_or_name
    return entry.current_name


def _save_personas(data):
    for node_id, pdata in data.items():
        realm_db.set_persona(node_id, pdata)
    # Write-through to JSON for oracle_daemon and other readers
    with open(PERSONAS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def push_event(event):
    """Store an event, then dispatch to subscribed plugin handlers.

    When `python map_server.py` is run directly, this module is loaded as
    `__main__` and assigns `_plugin_registry` in the bottom-of-file block.
    But if anything later does `import map_server`, Python creates a SECOND
    module object with `_plugin_registry = None` (the default). To survive
    that case, look up the registry on whichever module instance actually
    holds the loaded plugins.
    """
    stored = realm_db.push_event(event)
    registry = _plugin_registry
    if registry is None:
        # Fall back to whichever copy of this module has the registry set.
        import sys
        for mod_name in ("__main__", "map_server"):
            mod = sys.modules.get(mod_name)
            if mod is not None and getattr(mod, "_plugin_registry", None) is not None:
                registry = mod._plugin_registry
                break
    if registry is not None:
        etype = stored.get("type", "")
        if etype:
            try:
                registry.fire_event(etype, stored)
            except Exception as e:
                print(f"[push_event] fire_event failed for type={etype}: {e}", flush=True)
    return stored


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

    # Collect node enrichers from plugin registry (discovery, ansible, etc.)
    enrichers = []
    if _plugin_registry:
        enrichers = _plugin_registry.get_node_enrichers()

    for n in topo_nodes:
        nid = n["id"]
        ip = n.get("ip", "")

        # Plugin node enrichers (discovery, ansible — priority-sorted)
        enriched = None
        for enricher_fn, _plugin_name, _priority in enrichers:
            try:
                result = enricher_fn(nid, n)
                if result and "sublabel" in result:
                    enriched = result
                    break  # First enricher with a sublabel wins
            except Exception:
                pass
        if enriched:
            sublabels[nid] = enriched["sublabel"]
            continue

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
    """Build the full status blob (internal, always fresh).

    Plugin status providers (ha, wled, collectd, wifi) are merged in by the
    plugin registry after load_plugins() — see __main__ block.
    """
    status = engine.get_status()
    status["tailscale"] = engine.get_tailscale_status()
    status["adult"] = engine.adult_observation(status)
    status["host"] = engine.get_host_config()
    topo_nodes = _load_topology().get("nodes", [])
    status["roles"] = {n["id"]: node_roles.get_role(n["id"], n) for n in topo_nodes}
    status["groups"] = node_roles.get_ha_map()
    # Merge plugin status providers (collectd, ha, wled, wifi, etc.)
    if _plugin_registry:
        for provider_fn, plugin_name in _plugin_registry.get_status_providers():
            try:
                extra = provider_fn()
                if isinstance(extra, dict):
                    status.update(extra)
            except Exception:
                pass
    # Update latency prober with current WiFi clients (via plugin API)
    if _plugin_registry:
        lat_api = _plugin_registry.get_plugin_api("latency")
        if lat_api and "set_wifi_nodes" in lat_api:
            lat_api["set_wifi_nodes"](status.get("wifi", {}))
    # Pre-compute sublabels (saves client hostname matching + string formatting)
    status["sublabels"] = _compute_sublabels(status, topo_nodes)
    # Core-host IPs resolved from fleet.yaml — replaces hardcoded IPs in src/node-status.js.
    # Any name that doesn't resolve maps to None; frontend handles gracefully.
    try:
        import realm_fleet
        status["core_hosts"] = {
            name: realm_fleet.host_ip(name)
            for name in ("katana", "gatekeeper", "oracle", "ha")
        }
    except Exception:
        status["core_hosts"] = {}
    # Discovery entity counts per host node
    if _discovery_engine:
        status["discovery_counts"] = _discovery_engine.get_entity_counts_by_host()
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


from sse_broker import SSEBroker, SSESource
_sse_broker = SSEBroker(build_status)

# All SSE sources (energy, latency, firewall, wifi) now register via plugins.
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


def _h_get_quests_legacy(req, params):
    """Legacy: read quests from realm.db. Unused — see _h_get_api_quests."""
    return realm_db.get_quests()

def _h_get_events(req, params):
    qp = req.query_params
    since = float(qp.get("since", 0) or 0)
    limit = int(qp.get("limit", 0) or 0)
    unacked_only = qp.get("ack", "").lower() in ("false", "0", "no")
    # `type` filter: comma-separated list, e.g. ?type=speech,alert. The CLI
    # exposes this via `realm event list --type speech` (and --kind alias).
    # Until this was added, the param was accepted but silently ignored —
    # callers got the full unfiltered stream regardless of --type. Match
    # case-insensitively so ?type=Alert and ?type=alert behave the same,
    # consistent with the `ack` param's lower() handling above.
    type_filter = qp.get("type", "").strip()
    type_set = {t.strip().lower() for t in type_filter.split(",") if t.strip()} if type_filter else None
    events = get_events_since(since)
    if type_set is not None:
        events = [e for e in events if str(e.get("type", "")).lower() in type_set]
    if unacked_only:
        events = [e for e in events if not e.get("ack_at") and not e.get("closed_at")]
    if limit > 0:
        events = events[-limit:]
    return events


def _h_post_event_ack(req, params):
    """POST /events/<id>/ack — acknowledge an event. Body: {by, note}."""
    event_id = int(params.get("id", 0))
    if not event_id:
        return {"error": "missing event id"}
    body = req.json() or {}
    updated = realm_db.ack_event(event_id, body.get("by", ""), body.get("note", ""))
    if not updated:
        return {"error": "event not found or already acked"}
    return updated


def _h_post_event_close(req, params):
    """POST /events/<id>/close — close an event (resolution)."""
    event_id = int(params.get("id", 0))
    if not event_id:
        return {"error": "missing event id"}
    updated = realm_db.close_event(event_id)
    if not updated:
        return {"error": "event not found or already closed"}
    return updated


def _h_get_roles(req, params):
    """GET /roles — every role definition + template + which nodes are in it."""
    import node_roles
    roles = node_roles.get_all_roles()
    by_role = node_roles.get_nodes_by_role()
    out = {}
    for name, role in roles.items():
        out[name] = {
            **role,
            "nodes": by_role.get(name, []),
            "node_count": len(by_role.get(name, [])),
        }
    return out


def _h_get_role_by_name(req, params):
    """GET /roles/<name> — one role with template + member nodes."""
    import node_roles
    name = params.get("name", "")
    roles = node_roles.get_all_roles()
    if name not in roles:
        return {"error": f"no such role: {name}"}
    by_role = node_roles.get_nodes_by_role()
    return {
        **roles[name],
        "name": name,
        "nodes": by_role.get(name, []),
        "node_count": len(by_role.get(name, [])),
    }


def _h_get_discovery_prototypes(req, params):
    """GET /discovery/prototypes — every entity-type prototype declared
    in plugin manifests. Zabbix-inspired LLD surface (issue #6).
    """
    if _plugin_registry is None:
        return []
    return _plugin_registry.get_discovery_prototypes()


def _h_get_macros(req, params):
    """GET /macros?node=<id>&role=<r>&scope=<all|host|role|global>."""
    from plugins.alerting import macros
    qp = req.query_params
    return macros.list_macros(
        scope=qp.get("scope", "all"),
        node_id=qp.get("node", ""),
        role=qp.get("role", ""),
    )


def _h_get_macro_explain(req, params):
    """GET /macros/<name>/explain?node=<id>&role=<r>."""
    from plugins.alerting import macros
    name = params.get("name", "")
    qp = req.query_params
    return macros.explain(name, node_id=qp.get("node", ""), role=qp.get("role", ""))


def _h_post_macro(req, params):
    """POST /macros/<name> body={value, scope, node?, role?}."""
    from plugins.alerting import macros
    name = params.get("name", "")
    body = req.json() or {}
    try:
        macros.set_macro(
            name,
            body.get("value"),
            scope=body.get("scope", "global"),
            node_id=body.get("node", ""),
            role=body.get("role", ""),
        )
        return {"ok": True, "name": name}
    except ValueError as e:
        return {"error": str(e)}


def _h_delete_macro(req, params):
    """DELETE /macros/<name>?scope=<>&node=<>&role=<>."""
    from plugins.alerting import macros
    name = params.get("name", "")
    qp = req.query_params
    try:
        macros.delete_macro(
            name,
            scope=qp.get("scope", "global"),
            node_id=qp.get("node", ""),
            role=qp.get("role", ""),
        )
        return {"ok": True}
    except ValueError as e:
        return {"error": str(e)}

def _h_get_personas(req, params):
    return _load_personas()

def _h_get_topology(req, params):
    topo = _load_topology()
    fleet_api = _get_fleet_api()
    if fleet_api and fleet_api.get("loaded"):
        # Don't mutate the cached topology dict — shallow copy and replace nodes.
        topo = dict(topo)
        topo["nodes"] = _join_fleet_into_nodes(topo.get("nodes", []), fleet_api)
    # Ensure every node carries a non-null `type` reflecting node_roles
    # enrichment so type-based CLI filters / ansible grouping work (#98).
    # Shallow-copy guards the cached dict when no fleet join ran above.
    topo = dict(topo)
    topo["nodes"] = _enrich_node_types(topo.get("nodes", []))
    return topo

def _h_get_ping_ip(req, params):
    ip = params.get("ip", "")
    if not _validate_ip(ip):
        req.respond({"ok": False, "ip": ip, "error": "Invalid IP"}, 400)
        return None
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

def _h_get_observation(req, params):
    status = engine.get_status()
    return {
        "observation": engine.adult_observation(status),
        "status": status,
    }

def _h_get_player(req, params):
    return realm_db.get_player_stats()

def _h_get_hud(req, params):
    """Return game HUD data for the GNOME Shell extension."""
    import sqlite3 as _sql
    db_path = os.path.expanduser("~/.realmwatch/game.db")
    if not os.path.exists(db_path):
        return {
            "player": None, "quest": None,
            "threats": {"count": 0, "max_severity": 0},
            "realm": {"entities": 0, "events_24h": 0, "quests_active": 0},
        }

    conn = _sql.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    conn.row_factory = _sql.Row

    # Player
    player = None
    row = conn.execute("SELECT * FROM players LIMIT 1").fetchone()
    if row:
        level = row["level"]
        xp = row["total_xp"]
        xp_current = sum(100 * i for i in range(1, level))
        xp_next = sum(100 * i for i in range(1, level + 1))
        span = xp_next - xp_current
        progress = (xp - xp_current) / span if span > 0 else 0.0
        player = {
            "name": row["player_name"] or "Warden",
            "class": row["player_class"] or "watcher",
            "level": level, "xp": xp,
            "xp_next_level": xp_next,
            "xp_progress": round(min(1.0, max(0.0, progress)), 2),
        }

    # Active quest (highest severity parent quest, with progress)
    quest = None
    qrow = conn.execute(
        "SELECT quest_id, title, technical_label, status, severity FROM quests "
        "WHERE status IN ('created','active') AND parent_quest_id IS NULL "
        "ORDER BY severity DESC, created_ts DESC LIMIT 1"
    ).fetchone()
    if qrow:
        # Count sub-quest progress
        subs = conn.execute(
            "SELECT COUNT(*) as total FROM quests WHERE parent_quest_id=?",
            (qrow["quest_id"],)).fetchone()["total"]
        done = 0
        if subs > 0:
            done = conn.execute(
                "SELECT COUNT(*) FROM quests WHERE parent_quest_id=? AND status='resolved'",
                (qrow["quest_id"],)).fetchone()[0]
        quest = {"title": qrow["title"], "technical_label": qrow["technical_label"],
                 "status": qrow["status"], "severity": qrow["severity"],
                 "steps_done": done, "steps_total": subs}

    # Top quests for HUD quest list (up to 5, parent quests only)
    quests = []
    for qr in conn.execute(
        "SELECT quest_id, title, technical_label, status, severity, xp_reward FROM quests "
        "WHERE status IN ('created','active') AND parent_quest_id IS NULL "
        "ORDER BY severity DESC, created_ts DESC LIMIT 5"
    ).fetchall():
        quests.append({
            "id": qr["quest_id"], "title": qr["title"],
            "technical_label": qr["technical_label"],
            "status": qr["status"], "severity": qr["severity"],
            "xp": qr["xp_reward"],
        })

    # Threats (last 24h, severity >= 3)
    day_ago = int((time.time() - 86400) * 1000)
    threat_types = ('port_scan','brute_force','dns_poisoning','firewall_block','ddos','unknown_device')
    ph = ','.join('?' for _ in threat_types)
    trow = conn.execute(
        f"SELECT COUNT(*) as cnt, MAX(severity) as max_sev FROM events "
        f"WHERE severity >= 3 AND timestamp_observed > ? AND event_type IN ({ph})",
        (day_ago, *threat_types)).fetchone()
    threats = {"count": trow["cnt"] or 0, "max_severity": trow["max_sev"] or 0}

    # Realm summary
    entities = conn.execute("SELECT COUNT(*) FROM entities WHERE status='active'").fetchone()[0]
    events_24h = conn.execute("SELECT COUNT(*) FROM events WHERE timestamp_observed > ?", (day_ago,)).fetchone()[0]
    quests_active = conn.execute("SELECT COUNT(*) FROM quests WHERE status IN ('created','active') AND parent_quest_id IS NULL").fetchone()[0]

    conn.close()

    # Node counts by category
    status_data = build_status()
    astral_nodes = {}
    collectd_hosts = {}
    wifi_clients = {}
    if isinstance(status_data, dict):
        astral_nodes = status_data.get("astral", {}).get("nodes", {})
        collectd_hosts = status_data.get("collectd", {})
        wifi_clients = status_data.get("wifi", {})
    # Split online into wifi vs wired
    online_keys = {k for k, v in astral_nodes.items() if v}
    wifi_lower = {k.lower().replace("-", "") for k in wifi_clients}
    wifi_online = 0
    wired_online = 0
    for k in online_keys:
        if k.lower().replace("-", "") in wifi_lower or k.startswith("_unknown"):
            wifi_online += 1
        else:
            wired_online += 1

    # Deduplicate collectd hosts (katana, katana.lan, katana.ts.net are same host)
    seen_hosts = set()
    services_up = 0
    for k, v in collectd_hosts.items():
        if not isinstance(v, dict) or v.get("load_1") is None:
            continue
        base = k.split(".")[0].lower()
        if base not in seen_hosts:
            seen_hosts.add(base)
            services_up += 1

    # Resource nodes
    resources = {}
    for rkey in ("forge", "mana", "essence"):
        rv = status_data.get(rkey, {}) if isinstance(status_data, dict) else {}
        if isinstance(rv, dict) and rv.get("usage") is not None:
            resources[rkey] = {"usage": rv["usage"]}
            if rkey == "forge":
                resources[rkey]["temp"] = rv.get("temp")
                gpu = rv.get("gpu", {})
                if isinstance(gpu, dict):
                    resources[rkey]["gpu_temp"] = gpu.get("temp")
                    resources[rkey]["gpu_load"] = gpu.get("load")

    # Storage from collectd — all mount points, deduplicated by size across hosts
    storage = []
    seen_hosts = set()
    seen_sizes = set()  # (total_gb rounded) to dedupe NFS mounts seen from multiple hosts
    for host, cdata in sorted(collectd_hosts.items()):
        if not isinstance(cdata, dict):
            continue
        base = host.split(".")[0].lower()
        if base in seen_hosts:
            continue
        seen_hosts.add(base)
        host_disks = cdata.get("disks", [])
        if host_disks:
            for disk in host_disks:
                tgb = round(disk.get("total_gb", 0), 0)
                if tgb < 1:
                    continue
                size_key = int(tgb)
                if size_key in seen_sizes and disk["mount"] != "/":
                    continue  # skip NFS duplicate
                seen_sizes.add(size_key)
                storage.append({
                    "host": base, "mount": disk["mount"],
                    "pct": disk["pct"], "total_gb": tgb,
                })
        elif cdata.get("disk_pct") is not None:
            tgb = round(cdata.get("disk_total_gb", 0), 0)
            storage.append({
                "host": base, "mount": "/",
                "pct": cdata["disk_pct"], "total_gb": tgb,
            })
            seen_sizes.add(int(tgb))
    resources["storage"] = storage

    # Network throughput (katana main interface)
    katana_cd = collectd_hosts.get("katana", {})
    ifaces = katana_cd.get("interfaces", {}) if isinstance(katana_cd, dict) else {}
    eth = ifaces.get("enp5s0", {})
    if eth:
        resources["network"] = {
            "eth_rx_mbps": round(eth.get("rx_bps", 0) * 8 / 1000000, 2),
            "eth_tx_mbps": round(eth.get("tx_bps", 0) * 8 / 1000000, 2),
        }
    # WAN from astral
    astral_data = status_data.get("astral", {}) if isinstance(status_data, dict) else {}
    wan_bps = astral_data.get("traffic", 0)
    if wan_bps and "network" in resources:
        resources["network"]["wan_mbps"] = round(wan_bps * 8 / 1000000, 2)

    # Gatekeeper data
    gk_cd = collectd_hosts.get("gatekeeper", {}) if isinstance(collectd_hosts, dict) else {}
    gk_ifaces = gk_cd.get("interfaces", {}) if isinstance(gk_cd, dict) else {}
    gatekeeper = {
        "uptime_days": round(gk_cd.get("uptime", 0) / 86400, 1) if isinstance(gk_cd, dict) else 0,
        "load": gk_cd.get("load_1", 0) if isinstance(gk_cd, dict) else 0,
        "dhcp_leases": gk_cd.get("dhcp_leases", 0) if isinstance(gk_cd, dict) else 0,
        "conntrack": gk_cd.get("conntrack", 0) if isinstance(gk_cd, dict) else 0,
        "temp": gk_cd.get("temp", 0) if isinstance(gk_cd, dict) else 0,
        "ping_wan": gk_cd.get("ping", {}).get("8.8.8.8", 0) if isinstance(gk_cd, dict) else 0,
    }
    # WAN interface (fiber)
    wan = gk_ifaces.get("fiber", {})
    if wan:
        gatekeeper["wan_rx_mbps"] = round(wan.get("rx_bps", 0) * 8 / 1000000, 2)
        gatekeeper["wan_tx_mbps"] = round(wan.get("tx_bps", 0) * 8 / 1000000, 2)
    # VLAN traffic
    vlans = {}
    vlan_defs = [
        ("br-lan",    0,  "LAN"),
        ("br-lan.3",  3,  "Guest"),
        ("br-lan.4",  4,  "Quarantine"),
        ("br-lan.6",  6,  "Admin"),
        ("br-lan.7",  7,  "Cameras"),
        ("br-lan.8",  8,  "Kids"),
        ("br-lan.9",  9,  "Gaming"),
        ("br-lan.10", 10, "IoT"),
        ("br-lan.11", 11, "Family"),
        ("br-lan.20", 20, "Servers"),
        ("br-lan.38", 38, "WireGuard"),
    ]
    for iface, vid, name in vlan_defs:
        data = gk_ifaces.get(iface, {})
        rx = round(data.get("rx_bps", 0) * 8 / 1000000, 2) if data else 0
        tx = round(data.get("tx_bps", 0) * 8 / 1000000, 2) if data else 0
        vlans[name] = {"id": vid, "rx_mbps": rx, "tx_mbps": tx}
    gatekeeper["vlans"] = vlans
    # VPN
    vpn = gk_ifaces.get("wireguardgig", {})
    if vpn:
        gatekeeper["vpn_rx_mbps"] = round(vpn.get("rx_bps", 0) * 8 / 1000000, 2)
        gatekeeper["vpn_tx_mbps"] = round(vpn.get("tx_bps", 0) * 8 / 1000000, 2)
    # NFT counters from astral
    nft = astral_data.get("nft", {}) if isinstance(astral_data, dict) else {}
    if nft:
        gatekeeper["nft"] = {k: round(v / 1000000, 1) for k, v in nft.items()}  # MB

    return {
        "player": player, "quest": quest, "quests": quests, "threats": threats,
        "gatekeeper": gatekeeper,
        "realm": {
            "entities": entities, "events_24h": events_24h,
            "quests_active": quests_active,
            "wifi_online": wifi_online,
            "wired_online": wired_online,
            "services_up": services_up,
            "resources": resources,
        },
    }

# NOTE (Wave 4 cleanup, 2026-05-19):
# `_h_get_api_quests`, `_h_post_quest_create`, `_h_post_quest_update`,
# `_h_post_quest_delete`, and `_h_post_player_reward` below all back the
# legacy `realm quest` CLI surface (/quests, /quest-create, /quest-update,
# /quest-delete, /player/reward). They write directly against
# ~/.realmwatch/game.db and predate the move of `quest_forge` into
# `plugins/quests/`. The plugin already implements every code path needed
# (list, create, update via `transition_quest`, archive, sub-quest cascade).
#
# TODO: migrate these handlers into `plugins/quests/` in v0.6 so the core
# router can shrink. The current registrations at the bottom of this file
# (`_route_table.add("GET", "/quests", _h_get_api_quests)`, etc.) live at
# PRIORITY_CORE — a future plugin would either shadow them via raw_path
# with `priority=PRIORITY_CORE - 1` or this file would delegate to
# `ctx.get_plugin_api("quests")`. Until then the CLI keeps its current
# contract; see Morpheus's Wave 2 findings for the full migration plan.
def _h_get_api_quests(req, params):
    """Return quests from game.db (quest-forge) shaped for the quest-log UI."""
    import sqlite3 as _sql
    db_path = _GAME_DB
    if not os.path.exists(db_path):
        return []

    conn = _sql.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    conn.row_factory = _sql.Row
    conn.execute("PRAGMA busy_timeout=5000")

    try:
        rows = conn.execute(
            "SELECT quest_id, title, description, parent_quest_id, node, status, "
            "actions_json, sort_order, xp_reward, created_ts, resolved_ts "
            "FROM quests ORDER BY sort_order, created_ts"
        ).fetchall()
    except _sql.OperationalError:
        conn.close()
        return []

    # Map quest-forge status to UI status
    _ACTIVE = frozenset(("detected", "correlated", "created", "active"))
    _COMPLETED = frozenset(("resolved", "debriefed", "rewarded"))

    quests = []
    by_id = {}
    for r in rows:
        status = r["status"]
        if status == "archived":
            continue
        ui_status = "active" if status in _ACTIVE else "completed"

        actions = []
        if r["actions_json"]:
            try:
                actions = json.loads(r["actions_json"])
            except (json.JSONDecodeError, TypeError):
                pass

        q = {
            "id": r["quest_id"],
            "title": r["title"],
            "description": r["description"],
            "parent_id": r["parent_quest_id"],
            "node": r["node"],
            "status": ui_status,
            "actions": actions,
            "sort_order": r["sort_order"] or 0,
            "created_at": r["created_ts"] / 1000 if r["created_ts"] else None,
            "completed_at": r["resolved_ts"] / 1000 if r["resolved_ts"] else None,
            "rewards": {"xp": r["xp_reward"]} if r["xp_reward"] else None,
            "children": [],
        }
        by_id[q["id"]] = q
        if q["parent_id"] and q["parent_id"] in by_id:
            by_id[q["parent_id"]]["children"].append(q)
        else:
            quests.append(q)

    # Re-parent orphans whose parent appeared before them
    orphans = [q for q in quests if q["parent_id"]]
    for o in orphans:
        if o["parent_id"] in by_id:
            quests.remove(o)
            by_id[o["parent_id"]]["children"].append(o)

    conn.close()
    return quests


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
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                return s.connect_ex((host, port)) == 0
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
    disabled = realm_db.get_settings("plugins") or {}
    plugins = []
    if _plugin_registry:
        for p in _plugin_registry.get_all_plugins():
            info = {"name": p.name, "version": p.version, "type": p.plugin_type,
                    "description": p.description, "fantasy_name": p.fantasy_name,
                    "icon": p.icon, "status": p.status,
                    "enabled": disabled.get(p.name) != "disabled"}
            if p.status != "disabled":
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
    return plugins

def _h_get_sse_sources(req, params):
    """List registered SSE sources."""
    sources = _sse_broker.get_sources()
    return {"sources": [
        {"name": s.name, "event_type": s.event_type,
         "interval": s.interval_seconds, "burst": s.burst,
         "burst_priority": s.burst_priority}
        for s in sources
    ]}

def _h_post_plugin_toggle(req, params):
    """Toggle a plugin enabled/disabled. Requires restart to take effect."""
    data = req.json()
    name = data.get("name", "")
    if not name:
        req.respond({"error": "Missing plugin name"}, 400)
        return
    enabled = data.get("enabled", True)
    if enabled:
        # Remove the disabled marker
        realm_db.delete_setting("plugins", name)
    else:
        realm_db.set_settings("plugins", {name: "disabled"})
    return {"ok": True, "name": name, "enabled": enabled, "restart_required": True}


# ── POST Route Handlers ──

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
        raw_key = update.get("node")
        if not raw_key:
            req.respond({"error": "missing 'node' key"}, 400)
            return None
        # Fleet-resolve so prior_names and fleet_ids hit the canonical persona row.
        node_key = _resolve_node_id(raw_key, _plugin_registry)
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
    """Archive a quest in game.db (forward-only lifecycle)."""
    try:
        data = req.json()
        quest_id = data.get("id", "")
        text = data.get("text", "")
        if not quest_id and not text:
            req.respond({"error": "missing id or text"}, 400)
            return None
        conn = _game_db_rw()
        if quest_id:
            # Archive this quest and all children
            now_ms = int(time.time() * 1000)
            ids = [r[0] for r in conn.execute(
                """WITH RECURSIVE tree(qid) AS (
                       SELECT quest_id FROM quests WHERE quest_id = ?
                       UNION ALL
                       SELECT q.quest_id FROM quests q JOIN tree t ON q.parent_quest_id = t.qid
                   ) SELECT qid FROM tree""", (quest_id,)).fetchall()]
            for qid in ids:
                row = conn.execute("SELECT status FROM quests WHERE quest_id=?", (qid,)).fetchone()
                if row and row["status"] != "archived":
                    prev = row["status"]
                    conn.execute("UPDATE quests SET status='archived', archived_ts=? WHERE quest_id=?",
                                 (now_ms, qid))
                    conn.execute(
                        "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) VALUES (?,?,?,?,?)",
                        (qid, prev, "archived", now_ms, "map_ui"))
            conn.commit()
            conn.close()
            return {"deleted": len(ids)}
        elif text:
            # Legacy: delete by text — fall back to realm_db
            conn.close()
            deleted = realm_db.delete_quest_by_text(text)
            return {"deleted": deleted}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_quest_update(req, params):
    """Update quest status in game.db. Maps frontend statuses to game lifecycle."""
    try:
        data = req.json()
        quest_id = data.get("id", "")
        status = data.get("status", "")
        if not quest_id or not status:
            req.respond({"error": "missing id or status"}, 400)
            return None

        # Map frontend status → game.db lifecycle state
        _STATUS_MAP = {"completed": "resolved", "active": "active"}
        game_status = _STATUS_MAP.get(status, status)

        conn = _game_db_rw()
        row = conn.execute("SELECT quest_id, status FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        if not row:
            conn.close()
            req.respond({"error": "quest not found"}, 404)
            return None

        _QUEST_STATES = ["detected", "correlated", "created", "active", "resolved", "debriefed", "rewarded", "archived"]
        current_idx = _QUEST_STATES.index(row["status"]) if row["status"] in _QUEST_STATES else 0
        new_idx = _QUEST_STATES.index(game_status) if game_status in _QUEST_STATES else -1

        if new_idx <= current_idx:
            # Can't go backwards — return success silently (frontend handles visual toggle)
            conn.close()
            return {"ok": True, "id": quest_id, "status": status}

        now_ms = int(time.time() * 1000)
        conn.execute("UPDATE quests SET status=? WHERE quest_id=?", (game_status, quest_id))
        # Set timestamp field if it exists
        ts_col = f"{game_status}_ts"
        cols = [c[1] for c in conn.execute("PRAGMA table_info(quests)").fetchall()]
        if ts_col in cols:
            conn.execute(f"UPDATE quests SET {ts_col}=? WHERE quest_id=?", (now_ms, quest_id))
        conn.execute(
            "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) VALUES (?,?,?,?,?)",
            (quest_id, row["status"], game_status, now_ms, "map_ui"))
        conn.commit()
        conn.close()
        return {"ok": True, "id": quest_id, "status": status}
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_player_reward(req, params):
    """Grant XP reward in game.db. Deduplicates by source:id."""
    try:
        data = req.json()
        source = data.get("source", "")
        source_id = data.get("id", "")
        if source not in ("quest", "sub", "event") or not source_id:
            req.respond({"error": "missing or invalid source/id"}, 400)
            return None

        conn = _game_db_rw()

        # Determine XP amount from quest's xp_reward or defaults
        xp_amount = 0
        if source in ("quest", "sub"):
            qrow = conn.execute("SELECT xp_reward, parent_quest_id FROM quests WHERE quest_id=?",
                                (source_id,)).fetchone()
            if qrow:
                if source == "sub" or qrow["parent_quest_id"]:
                    # Sub-quest: fraction of reward (25%)
                    xp_amount = max(1, (qrow["xp_reward"] or 100) // 4)
                else:
                    xp_amount = qrow["xp_reward"] or 100
            else:
                xp_amount = 50 if source == "sub" else 200
        else:
            # Event rewards — small fixed amount
            xp_amount = 15

        # Dedup key: source:source_id
        dedup_key = f"reward:{source}:{source_id}"
        player_id = "default"
        now_ms = int(time.time() * 1000)

        # Check idempotency via xp_events
        existing = conn.execute(
            "SELECT xp_event_id FROM xp_events WHERE player_id=? AND source_type=? AND quest_id=?",
            (player_id, f"reward_{source}", source_id)).fetchone()

        if existing:
            # Already granted — return current stats without granting
            player = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
            conn.close()
            if not player:
                return {"granted": False, "reward": {"xp": 0, "gold": 0, "gems": 0},
                        "level": 1, "level_up": False, "xp": 0, "gold": 0, "gems": 0,
                        "xp_next": 100, "xp_in_level": 0}
            lvl = _game_level_info(player["total_xp"], player["level"])
            return {"granted": False, **lvl}

        # Ensure player exists
        player = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
        if not player:
            conn.execute(
                "INSERT OR IGNORE INTO players (player_id, player_name, player_class, total_xp, level, created_ts, last_active_ts, schema_version) "
                "VALUES (?,?,?,0,1,?,?,1)", (player_id, "Warden", "watcher", now_ms, now_ms))
            conn.commit()
            player = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()

        old_xp = player["total_xp"]
        old_level = player["level"]

        # Insert XP event (inline ULID generation — no cross-project import)
        xp_eid = _generate_ulid()
        conn.execute(
            "INSERT INTO xp_events (xp_event_id, player_id, quest_id, source_type, xp_amount, granted_ts, replay_flag) "
            "VALUES (?,?,?,?,?,?,0)",
            (xp_eid, player_id, source_id, f"reward_{source}", xp_amount, now_ms))

        # Update player XP
        new_xp = old_xp + xp_amount
        conn.execute("UPDATE players SET total_xp=?, last_active_ts=? WHERE player_id=?",
                     (new_xp, now_ms, player_id))

        # Recalculate level: level N requires sum(100*i for i in range(1, N)) total XP
        new_level = 1
        while sum(100 * i for i in range(1, new_level + 1)) <= new_xp:
            new_level += 1
        if new_level != old_level:
            conn.execute("UPDATE players SET level=? WHERE player_id=?", (new_level, player_id))

        # If source is quest, transition to "rewarded"
        if source == "quest":
            qrow = conn.execute("SELECT status FROM quests WHERE quest_id=?", (source_id,)).fetchone()
            if qrow and qrow["status"] not in ("rewarded", "archived"):
                prev = qrow["status"]
                conn.execute("UPDATE quests SET status='rewarded', rewarded_ts=? WHERE quest_id=?",
                             (now_ms, source_id))
                conn.execute(
                    "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) VALUES (?,?,?,?,?)",
                    (source_id, prev, "rewarded", now_ms, "map_ui"))

        conn.commit()
        conn.close()

        level_up = new_level > old_level
        lvl = _game_level_info(new_xp, new_level)
        return {
            "ok": True, "granted": True,
            "reward": {"xp": xp_amount, "gold": 0, "gems": 0},
            "level_up": level_up, "old_level": old_level, "new_level": new_level,
            **lvl,
        }
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None

def _h_post_quest_create(req, params):
    """Create a quest in game.db (quest-forge schema)."""
    try:
        data = req.json()
        title = data.get("title", "").strip()
        if not title:
            req.respond({"error": "missing title"}, 400)
            return None

        quest_id = data.get("id") or _generate_ulid()
        now_ms = int(time.time() * 1000)
        quest_type = data.get("quest_type", "manual")
        dedupe_key = data.get("dedupe_key") or f"manual:{quest_id}"
        conn = _game_db_rw()
        conn.execute(
            """INSERT INTO quests
            (quest_id, quest_type, title, description, dedupe_key,
             parent_quest_id, node, status, actions_json,
             sort_order, xp_reward, created_ts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (quest_id, quest_type, title, data.get("description", ""),
             dedupe_key, data.get("parent_id"), data.get("node"),
             data.get("status", "created"),
             json.dumps(data.get("actions", [])),
             data.get("sort_order", 0),
             data.get("xp_reward", 0),
             now_ms))
        conn.commit()
        conn.close()
        return {"ok": True, "id": quest_id}
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

# NOTE: Wake-on-LAN moved to plugins/wol/ (Slumber Ward) on 2026-06-03.
# That plugin re-registers POST /wol (raw_path) plus sleep/doctor/status.

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
        raw_id = data.get("id", "").strip()
        if not raw_id:
            req.respond({"error": "missing 'id'"}, 400)
            return None
        # Fleet-resolve so prior_names and fleet_ids land on the canonical node_id.
        node_id = _resolve_node_id(raw_id, _plugin_registry)
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
        return {"ok": True, "resolved_id": node_id}
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
            ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
             "-o", "BatchMode=yes", host, command],
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


# ── Cloud Status Proxy (OpenClaw) ──
_cloud_status_cache = {"data": None, "ts": 0}
_cloud_status_lock = threading.Lock()
_CLOUD_STATUS_URL = "http://100.69.161.127:8080/status.json"
_CLOUD_STATUS_TTL = 60  # seconds

def _h_get_cloud_status(req, params):
    """Proxy openclaw status.json via Tailscale with 60s cache."""
    now = time.time()
    with _cloud_status_lock:
        if _cloud_status_cache["data"] is not None and (now - _cloud_status_cache["ts"]) < _CLOUD_STATUS_TTL:
            return _cloud_status_cache["data"]
    try:
        import urllib.request
        with urllib.request.urlopen(_CLOUD_STATUS_URL, timeout=10) as resp:
            data = json.loads(resp.read())
        with _cloud_status_lock:
            _cloud_status_cache["data"] = data
            _cloud_status_cache["ts"] = time.time()
        return data
    except Exception as e:
        print(f"Cloud status fetch error: {e}")
        # Return stale data if available
        with _cloud_status_lock:
            if _cloud_status_cache["data"] is not None:
                return _cloud_status_cache["data"]
        return {"error": str(e)}


def _h_get_api_version(req, params):
    """Serve /api/version using realm-sigil contract."""
    import platform, socket
    try:
        hash_ = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=MAP_DIR).stdout.strip() or "dev"
        branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, cwd=MAP_DIR).stdout.strip() or "unknown"
        dirty = subprocess.run(["git", "diff", "--quiet"],
            capture_output=True, cwd=MAP_DIR).returncode != 0
    except Exception:
        hash_, branch, dirty = "dev", "unknown", False

    import sys as _sys
    _sys.path.insert(0, os.path.expanduser("~/Projects/realm-sigil/python"))
    from realm_sigil import version_dict
    _sys.path.pop(0)

    return version_dict(
        "realmwatch", "Fantasy homelab network monitor", "fantasy",
        "https://github.com/jphein/realmwatch",
        hash=hash_, branch=branch, dirty=dirty,
        built=_server_start_iso, started=_server_start_iso,
        uptime=int(time.time() - _server_start_time),
        runtime=f"python{_sys.version_info.major}.{_sys.version_info.minor}.{_sys.version_info.micro}",
        os_info=f"{_sys.platform}/{platform.machine()}",
        host=socket.gethostname(), pid=os.getpid(),
    )


# ── Register All Core Routes ──

_route_table.add("GET", "/status", _h_get_status)
_route_table.add("GET", "/quests", _h_get_api_quests)
_route_table.add("GET", "/api/quests", _h_get_api_quests)
_route_table.add("GET", "/events", _h_get_events)
_route_table.add("POST", "/events/<id>/ack", _h_post_event_ack)
_route_table.add("POST", "/events/<id>/close", _h_post_event_close)
_route_table.add("GET", "/roles", _h_get_roles)
_route_table.add("GET", "/roles/<name>", _h_get_role_by_name)
_route_table.add("GET", "/discovery/prototypes", _h_get_discovery_prototypes)
_route_table.add("GET", "/macros", _h_get_macros)
_route_table.add("GET", "/macros/<name>/explain", _h_get_macro_explain)
_route_table.add("POST", "/macros/<name>", _h_post_macro)
_route_table.add("DELETE", "/macros/<name>", _h_delete_macro)
_route_table.add("GET", "/personas", _h_get_personas)
_route_table.add("GET", "/topology", _h_get_topology)
_route_table.add("GET", "/ping/<ip>", _h_get_ping_ip)
_route_table.add("GET", "/server-info", _h_get_server_info)
_route_table.add("GET", "/config", _h_get_config)
_route_table.add("GET", "/settings", _h_get_settings)
_route_table.add("GET", "/observation", _h_get_observation)
_route_table.add("GET", "/player", _h_get_player)
_route_table.add("GET", "/api/hud", _h_get_hud)
_route_table.add("GET", "/ping", _h_get_ping)
_route_table.add("GET", "/resolve-url", _h_get_resolve_url)
_route_table.add("GET", "/debug", _h_get_debug)
_route_table.add("GET", "/scripts", _h_get_scripts)
_route_table.add("GET", "/reset", _h_get_reset)
_route_table.add("GET", "/skills", _h_get_skills)
_route_table.add("GET", "/claude-md", _h_get_claude_md)
_route_table.add("GET", "/agents", _h_get_agents)
_route_table.add("GET", "/hooks", _h_get_hooks)
_route_table.add("GET", "/plugins", _h_get_plugins)
_route_table.add("GET", "/plugins/", _h_get_plugins)
_route_table.add("GET", "/sse/sources", _h_get_sse_sources)
_route_table.add("GET", "/api/cloud-status", _h_get_cloud_status)
_route_table.add("GET", "/api/version", _h_get_api_version)

_route_table.add("POST", "/plugins/toggle", _h_post_plugin_toggle)
_route_table.add("POST", "/event", _h_post_event)
_route_table.add("POST", "/personas", _h_post_personas)
_route_table.add("POST", "/quest-delete", _h_post_quest_delete)
_route_table.add("POST", "/quest-update", _h_post_quest_update)
_route_table.add("POST", "/player/reward", _h_post_player_reward)
_route_table.add("POST", "/quest-create", _h_post_quest_create)
_route_table.add("POST", "/config", _h_post_config)
_route_table.add("POST", "/settings", _h_post_settings)
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
                # Set socket write timeout so half-open connections don't hang forever
                self.connection.settimeout(30)
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                _sse_broker.client_wrote(client_q)
                while True:
                    try:
                        event_type, payload, event_id = client_q.get(timeout=15)
                        self.wfile.write(f"id: {event_id}\nevent: {event_type}\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                        _sse_broker.client_wrote(client_q)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        _sse_broker.client_wrote(client_q)
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

    # ── Backfill enriched node `type` into the DB (#98) ──
    # node_roles classifies nodes at render time but never persisted it, so
    # stored nodes had `type: null` — breaking type-based CLI filters and
    # ansible grouping. Persist the enriched role onto each node that lacks a
    # type. This is additive: `type` is a JSON key inside nodes.data (no schema
    # change). "unknown" is skipped so unidentified nodes stay open to future
    # enrichment instead of freezing; GET /topology still fills them live.
    try:
        _type_backfill = []
        for _node in realm_db.get_nodes():
            if _node.get("type"):
                continue
            _nid = _node.get("id")
            if not _nid:
                continue
            _role = node_roles.get_role(_nid, _node)
            if not _role or _role == "unknown":
                continue
            _node = dict(_node)
            _node["type"] = _role
            _type_backfill.append((_nid, _node))
        if _type_backfill:
            realm_db.set_nodes_batch(_type_backfill)
            # Keep topology.json in sync with the DB — it's the write-through
            # mirror (same pattern as the POST /node|/connections|/topology
            # handlers and ap_scanner) and is read directly by the latency
            # prober / engine ping list. Only rewritten when the backfill
            # actually changed rows, so converged startups cause no churn.
            realm_db.save_topology_json(TOPOLOGY_FILE)
            print(f"Backfilled enriched type onto {len(_type_backfill)} node(s) (#98)")
    except Exception as _e:
        print(f"[#98] node type backfill skipped: {_e}")

    # ── Housekeeping ──
    realm_db.cleanup_old_events()

    # ── Discovery engine (create before plugins so companion plugin finds it) ──
    import discovery_engine as _de_mod
    _discovery_engine = _de_mod.DiscoveryEngine()

    # ── Plugin system startup ──
    # All bridges (HA, WLED, WiFi, firewall, collectd, events, chat, notion, codex, herald)
    # are now loaded as plugins. Latency prober is also started by its plugin.
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

    # ── Fleet catalog SSE join (Phase 5) ──
    # Wire the topology transformer so SSE topology events get the same
    # label/realm/role/kind merge that GET /topology applies.
    def _sse_topology_transformer(topo):
        out = topo
        fleet_api = _get_fleet_api()
        if fleet_api and fleet_api.get("loaded"):
            out = dict(topo)
            out["nodes"] = _join_fleet_into_nodes(topo.get("nodes", []), fleet_api)
        # Mirror GET /topology: emit non-null enriched `type` over SSE too so
        # HTTP and stream stay consistent (#98).
        out = dict(out)
        out["nodes"] = _enrich_node_types(out.get("nodes", []))
        return out
    _sse_broker.topology_transformer = _sse_topology_transformer

    _sse_broker.start()

    # ── Discovery engine startup (register providers from plugins, start scan loop) ──
    for provider in _plugin_registry.get_discovery_providers():
        _discovery_engine.register_provider(provider)
    _discovery_engine.start()
    print(f"Discovery engine started with {len(_discovery_engine.get_providers())} provider(s)")

    server = ThreadingHTTPServer(("", PORT), RealmHandler)

    def _shutdown(sig, frame):
        print("Shutting down realm map server...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("Realm map server stopped.")
