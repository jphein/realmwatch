#!/usr/bin/env python3
"""Home Assistant bridge — polls HA REST API, maps entities to topology nodes.

Entity→node mappings stored in realm.db settings (namespace 'ha', key 'entity_map').
Seeded by node_roles.migrate_to_db() on first run.
"""

import json
import os
import ssl
import threading
import time
import urllib.request

import node_roles

HA_URL = os.environ.get("HA_URL", "https://10.0.6.108:8123")
POLL_INTERVAL = 30


def _get_token():
    """Get HA token dynamically (allows .env to load after import)."""
    return os.environ.get("HA_TOKEN", "")

_cache = {"ts": 0, "nodes": {}, "entity_count": 0}
_lock = threading.Lock()

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


def _fetch_states():
    """GET /api/states -> list of entity state dicts."""
    token = _get_token()
    if not token:
        return []
    req = urllib.request.Request(
        f"{HA_URL}/api/states",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        print(f"[HA Bridge] Fetch error: {e}")
        return []


def _call_service(domain, service, entity_id, data=None):
    """POST /api/services/{domain}/{service}."""
    token = _get_token()
    payload = {"entity_id": entity_id}
    if data:
        payload.update(data)
    req = urllib.request.Request(
        f"{HA_URL}/api/services/{domain}/{service}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx, timeout=10)
        return {"ok": True, "status": resp.status}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Entity helpers ──

def _st(states, eid):
    e = states.get(eid)
    return e["state"] if e else None


def _num(states, eid, default=None):
    v = _st(states, eid)
    if v is None or v in ("unavailable", "unknown"):
        return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _attr(states, eid, key, default=None):
    e = states.get(eid)
    if not e:
        return default
    return e.get("attributes", {}).get(key, default)


# ── Label functions (logic stays in code, entity IDs come from config) ──

def _lbl_climate_cluster(states, config, entity_count):
    eids = config.get("entities", [])
    temps = []
    active = 0
    for eid in eids:
        t = _attr(states, eid, "current_temperature")
        if t is not None:
            temps.append(float(t))
        s = _st(states, eid)
        if s and s not in ("off", "unavailable", "unknown"):
            active += 1
    if not temps:
        return None
    avg = sum(temps) / len(temps)
    return f"{avg:.0f}\u00b0F avg \u2022 {active}/{len(eids)} active"


def _lbl_solar(states, config, entity_count):
    ents = config.get("entities", {})
    kw = _num(states, ents.get("kw"))
    batt_v = _num(states, ents.get("batt_v"))
    parts = []
    if kw is not None:
        if kw > 0:
            parts.append(f"\u2600 {kw:.1f}kW generating")
        elif kw < -0.01:
            parts.append(f"{abs(kw):.1f}kW consuming")
        else:
            parts.append("Idle")
    if batt_v is not None:
        parts.append(f"Batt {batt_v:.1f}V")
    return " \u2022 ".join(parts) if parts else None


def _lbl_camera_cluster(states, config, entity_count):
    eids = config.get("entities", [])
    total = 0
    active = 0
    for eid in eids:
        s = _st(states, eid)
        if s and s != "unavailable":
            total += 1
            if s != "idle":
                active += 1
    return f"\u25cf {total} cameras \u2022 {active} recording" if total else None


def _lbl_speaker_cluster(states, config, entity_count):
    eids = config.get("entities", [])
    playing = []
    total = 0
    for eid in eids:
        s = _st(states, eid)
        if s and s != "unavailable":
            total += 1
            if s == "playing":
                name = _attr(states, eid, "friendly_name", eid.split(".")[-1])
                playing.append(name)
    if playing:
        return f"\u266a {len(playing)} playing"
    return f"{total} speakers \u2022 Idle" if total else None


def _lbl_switch_cluster(states, config, entity_count):
    eids = config.get("entities", [])
    on = 0
    total = 0
    for eid in eids:
        s = _st(states, eid)
        if s and s != "unavailable":
            total += 1
            if s == "on":
                on += 1
    return f"{on}/{total} on" if total else None


def _lbl_wled(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    if s == "off":
        return "\u25cb Off"
    effect = _attr(states, eid, "effect", "Solid")
    brightness = _attr(states, eid, "brightness")
    bri_pct = f"{int(brightness / 2.55)}%" if brightness else ""
    return f"On \u2022 {effect}" + (f" \u2022 {bri_pct}" if bri_pct else "")


def _lbl_fan(states, config, entity_count):
    eid = config.get("entity", "")
    prefix = config.get("prefix", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    label = "On" if s == "on" else "Off"
    return f"{prefix} {label}" if prefix else label


def _lbl_vacuum(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    batt_eid = eid.replace("vacuum.", "sensor.") + "_battery"
    batt = _num(states, batt_eid)
    batt_str = f" \u2022 {batt:.0f}%" if batt else ""
    return f"{s.title()}{batt_str}"


def _lbl_ups(states, config, entity_count):
    prefix = config.get("prefix", "")
    status = _st(states, f"sensor.{prefix}_status")
    load = _num(states, f"sensor.{prefix}_load")
    batt = _num(states, f"sensor.{prefix}_battery_charge")
    if not status or status == "unavailable":
        return None
    parts = [status]
    if batt is not None:
        parts.append(f"{batt:.0f}%")
    if load is not None:
        parts.append(f"Load {load:.0f}%")
    return " \u2022 ".join(parts)


def _lbl_dehumidifier(states, config, entity_count):
    eid = config.get("entity", "")
    prefix = config.get("prefix", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    label = "Running" if s == "on" else "Idle"
    return f"{prefix} {label}" if prefix else label


def _lbl_phone(states, config, entity_count):
    prefix = config.get("prefix", "")
    batt = _num(states, f"sensor.{prefix}_battery_level")
    charging = _st(states, f"binary_sensor.{prefix}_is_charging")
    if batt is None:
        return None
    icon = "\u26a1" if charging == "on" else "\U0001f50b"
    return f"{icon} {batt:.0f}%"


def _lbl_media_state(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s in ("unavailable", "unknown"):
        return None
    return s.title()


def _lbl_echo(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if s == "unavailable":
        return "Offline"
    if s and s != "unavailable":
        return "Voice Ready"
    return None


def _lbl_ha_self(states, config, entity_count):
    load = _num(states, "sensor.system_monitor_load_1m")
    cpu = _num(states, "sensor.system_monitor_processor_use")
    parts = [f"HA \u2022 {entity_count} entities"]
    if load is not None:
        parts.append(f"Load {load:.1f}")
    if cpu is not None:
        parts.append(f"CPU {cpu:.0f}%")
    return " \u2022 ".join(parts)


def _lbl_radar(states, config, entity_count):
    prefix = config.get("prefix", "")
    presence = _st(states, f"binary_sensor.{prefix}_presence")
    if presence is None or presence == "unavailable":
        return None
    moving = _st(states, f"binary_sensor.{prefix}_moving_target") == "on"
    still = _st(states, f"binary_sensor.{prefix}_still_target") == "on"
    if presence == "on":
        if moving:
            return "Radar: Motion detected"
        elif still:
            return "Radar: Presence (still)"
        return "Radar: Presence"
    return "Radar: Clear"


def _lbl_lg_appliance(states, config, entity_count):
    prefix = config.get("prefix", "")
    for suffix in ["_state", "_status", ""]:
        s = _st(states, f"sensor.{prefix}{suffix}")
        if s and s not in ("unavailable", "unknown"):
            return s.replace("_", " ").title()
    return None


def _lbl_humidifier(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    humidity = _attr(states, eid, "current_humidity")
    target = _attr(states, eid, "humidity")
    parts = ["On" if s == "on" else "Off"]
    if humidity is not None:
        parts.append(f"{humidity:.0f}%")
    if target is not None and s == "on":
        parts.append(f"\u2192{target:.0f}%")
    return "Humidifier " + " ".join(parts)


def _lbl_rgb(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    lbl = "On" if s == "on" else "Off"
    if s == "on":
        effect = _attr(states, eid, "effect", "")
        if effect:
            lbl += f" \u2022 {effect}"
    return f"RGB {lbl}"


def _lbl_smart_bulb(states, config, entity_count):
    eid = config.get("entity", "")
    s = _st(states, eid)
    if not s or s == "unavailable":
        return None
    return "On" if s == "on" else "Off"


def _lbl_thermostat_single(states, config, entity_count):
    eid = config.get("entity", "")
    t = _attr(states, eid, "current_temperature")
    s = _st(states, eid)
    if t is None:
        return None
    status = "heating" if s not in ("off", "unavailable", "unknown", None) else "idle"
    return f"{t:.0f}\u00b0F \u2022 {status}"


# Dispatch table
_LABEL_FNS = {
    "climate_cluster": _lbl_climate_cluster,
    "solar": _lbl_solar,
    "camera_cluster": _lbl_camera_cluster,
    "speaker_cluster": _lbl_speaker_cluster,
    "switch_cluster": _lbl_switch_cluster,
    "wled": _lbl_wled,
    "fan": _lbl_fan,
    "vacuum": _lbl_vacuum,
    "ups": _lbl_ups,
    "dehumidifier": _lbl_dehumidifier,
    "phone": _lbl_phone,
    "media_state": _lbl_media_state,
    "echo": _lbl_echo,
    "ha_self": _lbl_ha_self,
    "radar": _lbl_radar,
    "lg_appliance": _lbl_lg_appliance,
    "humidifier": _lbl_humidifier,
    "rgb": _lbl_rgb,
    "smart_bulb": _lbl_smart_bulb,
    "thermostat_single": _lbl_thermostat_single,
}


def _build_node_states(all_states, entity_count):
    """Map HA entities to topology node sublabels using DB-backed config."""
    states = {s["entity_id"]: s for s in all_states}
    ha_map = node_roles.get_ha_map()
    nodes = {}

    for node_id, config in ha_map.items():
        fn_name = config.get("fn")
        fn = _LABEL_FNS.get(fn_name)
        if not fn:
            continue
        label = fn(states, config, entity_count)
        if label:
            nodes[node_id] = {"sublabel": label, "source": "ha"}
            for also_id in config.get("also", []):
                nodes[also_id] = {"sublabel": label, "source": "ha"}

    return nodes


# ── Public API ──

def get_ha_states():
    """Get cached node states from last poll."""
    with _lock:
        return dict(_cache.get("nodes", {}))


def poll_once():
    """Run a single poll cycle. Returns node count."""
    all_states = _fetch_states()
    if not all_states:
        return 0
    nodes = _build_node_states(all_states, len(all_states))
    with _lock:
        _cache["ts"] = time.time()
        _cache["nodes"] = nodes
        _cache["entity_count"] = len(all_states)
    return len(nodes)


def call_service(domain, service, entity_id, data=None):
    """Call an HA service (for MCP tool)."""
    return _call_service(domain, service, entity_id, data)


def _poll_loop():
    """Background polling loop."""
    while True:
        try:
            n = poll_once()
            if n:
                print(f"[HA Bridge] Polled {_cache['entity_count']} entities \u2192 {n} nodes")
        except Exception as e:
            print(f"[HA Bridge] Error: {e}")
        time.sleep(POLL_INTERVAL)


def start_ha_bridge():
    """Start the HA bridge as a daemon thread."""
    token = _get_token()
    if not token:
        print("[HA Bridge] No HA_TOKEN set, skipping")
        return None
    poll_once()
    t = threading.Thread(target=_poll_loop, daemon=True)
    t.start()
    print(f"[HA Bridge] Started (interval={POLL_INTERVAL}s, url={HA_URL})")
    return t
