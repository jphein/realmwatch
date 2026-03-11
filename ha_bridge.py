#!/usr/bin/env python3
"""Home Assistant bridge — polls HA REST API, maps entities to topology nodes."""

import json
import os
import re
import ssl
import threading
import time
import urllib.request

HA_URL = os.environ.get("HA_URL", "https://10.0.6.108:8123")
HA_TOKEN = os.environ.get("HA_TOKEN", "")
POLL_INTERVAL = 30

_cache = {"ts": 0, "nodes": {}, "entity_count": 0}
_lock = threading.Lock()

# SSL context for self-signed cert
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


def _fetch_states():
    """GET /api/states → list of entity state dicts."""
    if not HA_TOKEN:
        return []
    req = urllib.request.Request(
        f"{HA_URL}/api/states",
        headers={"Authorization": f"Bearer {HA_TOKEN}"},
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        print(f"[HA Bridge] Fetch error: {e}")
        return []


def _call_service(domain, service, entity_id, data=None):
    """POST /api/services/{domain}/{service}."""
    payload = {"entity_id": entity_id}
    if data:
        payload.update(data)
    req = urllib.request.Request(
        f"{HA_URL}/api/services/{domain}/{service}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {HA_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx, timeout=10)
        return {"ok": True, "status": resp.status}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Entity → Node mapping ──────────────────────────────────────────

def _st(states, eid):
    """Get state value for an entity_id, or None."""
    e = states.get(eid)
    return e["state"] if e else None


def _num(states, eid, default=None):
    """Get numeric state value."""
    v = _st(states, eid)
    if v is None or v in ("unavailable", "unknown"):
        return default
    try:
        return float(v)
    except (ValueError, TypeError):
        return default


def _attr(states, eid, key, default=None):
    """Get an attribute from an entity."""
    e = states.get(eid)
    if not e:
        return default
    return e.get("attributes", {}).get(key, default)


def _climate_label(states):
    """Thermostat cluster: avg temp, how many heating."""
    eids = [
        "climate.kitchen_thermostat",
        "climate.bedroom_thermostat",
        "climate.bathroom_thermostat",
        "climate.laundry_thermostat_2",
        "climate.pumphouse_thermostat",
    ]
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
        return "Offline"
    avg = sum(temps) / len(temps)
    return f"{avg:.0f}°F avg \u2022 {active}/{len(eids)} active"


def _solar_label(states):
    """Solar inverter: current power + daily energy."""
    kw = _num(states, "sensor.goodwe_kw")
    grid_w_in = _num(states, "sensor.6000w_inverter_grid_watts_in")
    w_out = _num(states, "sensor.6000winverter_geninverter_watts_out")
    batt_v = _num(states, "sensor.6000w_inverter_battery_voltage")

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
    return " \u2022 ".join(parts) if parts else "Offline"


def _camera_label(states):
    """Camera cluster: count recording/idle."""
    eids = [
        "camera.uproad", "camera.car", "camera.nap",
        "camera.10_0_10_88", "camera.10_0_10_133", "camera.10_0_8_106",
    ]
    total = 0
    active = 0
    for eid in eids:
        s = _st(states, eid)
        if s and s != "unavailable":
            total += 1
            if s != "idle":
                active += 1
    return f"\u25cf {total} cameras \u2022 {active} recording" if total else "Offline"


def _speaker_label(states):
    """Speaker cluster: playing status."""
    eids = [
        "media_player.nesthuba011", "media_player.nesthub0db6",
        "media_player.shed_speaker", "media_player.bed_speaker",
        "media_player.pumphouse_speaker", "media_player.counter",
        "media_player.kitchen_stereo", "media_player.bathroom_speaker",
        "media_player.laundry_speaker",
    ]
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
    return f"{total} speakers \u2022 Idle"


def _wled_label(states, light_eid, ip_eid=None):
    """Single WLED strip."""
    s = _st(states, light_eid)
    if not s or s == "unavailable":
        return "Offline"
    if s == "off":
        return "\u25cb Off"
    effect = _attr(states, light_eid, "effect", "Solid")
    brightness = _attr(states, light_eid, "brightness")
    bri_pct = f"{int(brightness / 2.55)}%" if brightness else ""
    return f"On \u2022 {effect}" + (f" \u2022 {bri_pct}" if bri_pct else "")


def _phone_label(states, prefix):
    """Phone: battery + charging status."""
    batt = _num(states, f"sensor.{prefix}_battery_level")
    charging = _st(states, f"binary_sensor.{prefix}_is_charging")
    if batt is None:
        return None
    icon = "\u26a1" if charging == "on" else "\U0001f50b"
    return f"{icon} {batt:.0f}%"


def _fan_label(states, eid):
    """Fan/dehumidifier/purifier."""
    s = _st(states, eid)
    if not s or s == "unavailable":
        return "Offline"
    return "On" if s == "on" else "Off"


def _ha_self_label(states, entity_count):
    """HA system info."""
    load = _num(states, "sensor.system_monitor_load_1m")
    cpu = _num(states, "sensor.system_monitor_processor_use")
    mem = _num(states, "sensor.system_monitor_memory_free")
    parts = [f"HA \u2022 {entity_count} entities"]
    if load is not None:
        parts.append(f"Load {load:.1f}")
    if cpu is not None:
        parts.append(f"CPU {cpu:.0f}%")
    return " \u2022 ".join(parts)


def _switch_cluster_label(states, eids):
    """Smart switch/plug cluster: on count + total."""
    on = 0
    total = 0
    for eid in eids:
        s = _st(states, eid)
        if s and s != "unavailable":
            total += 1
            if s == "on":
                on += 1
    return f"{on}/{total} on"


# ── Main mapping logic ──────────────────────────────────────────

# Switch entity IDs for smart plugs (excluding LEDs, child locks, etc.)
KASA_SWITCHES = [
    "switch.computer",
    "switch.clamp_construction_light",
    "switch.construction_light_1",
    "switch.kitchen_christmas_lights",
    "switch.christmas_tree_socket_1",    # left railing lights
    "switch.christmas_tree_socket_1_2",  # shed fan
    "switch.color_christmas_lights_switch_1",  # upper yurt
]


def _build_node_states(all_states, entity_count):
    """Map HA entities to topology node sublabels."""
    # Index by entity_id for fast lookup
    states = {s["entity_id"]: s for s in all_states}

    nodes = {}

    # Thermostats
    label = _climate_label(states)
    if label:
        nodes["nest-circle"] = {"sublabel": label, "source": "ha"}

    # Solar
    label = _solar_label(states)
    if label:
        nodes["goodwe"] = {"sublabel": label, "source": "ha"}

    # Cameras
    label = _camera_label(states)
    if label:
        nodes["watchers"] = {"sublabel": label, "source": "ha"}
        nodes["hikcams"] = {"sublabel": label, "source": "ha"}

    # Speakers
    label = _speaker_label(states)
    if label:
        nodes["voice-stones"] = {"sublabel": label, "source": "ha"}
        nodes["google-home"] = {"sublabel": label, "source": "ha"}

    # WLED
    label = _wled_label(states, "light.mamastrip", "sensor.mamastrip_ip")
    if label:
        nodes["wled-main"] = {"sublabel": label, "source": "ha"}
    label = _wled_label(states, "light.claqi", "sensor.claqi_ip")
    if label:
        nodes["wled-aqi"] = {"sublabel": label, "source": "ha"}

    # Smart plugs
    label = _switch_cluster_label(states, KASA_SWITCHES)
    if label:
        nodes["kasa-spirits"] = {"sublabel": label, "source": "ha"}
        nodes["smart-plugs"] = {"sublabel": label, "source": "ha"}

    # Fans
    for node_id, eid in [("bed-air", "fan.air_purifier")]:
        label = _fan_label(states, eid)
        if label:
            nodes[node_id] = {"sublabel": f"Purifier {label}", "source": "ha"}

    # Phone battery
    label = _phone_label(states, "flipz3")
    if label:
        nodes["flip3"] = {"sublabel": label, "source": "ha"}

    # HA itself
    label = _ha_self_label(states, entity_count)
    if label:
        nodes["ha"] = {"sublabel": label, "source": "ha"}

    return nodes


# ── Public API ──────────────────────────────────────────

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
                print(f"[HA Bridge] Polled {_cache['entity_count']} entities → {n} nodes")
        except Exception as e:
            print(f"[HA Bridge] Error: {e}")
        time.sleep(POLL_INTERVAL)


def start_ha_bridge():
    """Start the HA bridge as a daemon thread."""
    if not HA_TOKEN:
        print("[HA Bridge] No HA_TOKEN set, skipping")
        return None
    t = threading.Thread(target=_poll_loop, daemon=True)
    t.start()
    print(f"[HA Bridge] Started (interval={POLL_INTERVAL}s, url={HA_URL})")
    return t
