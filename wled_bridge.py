#!/usr/bin/env python3
"""WLED bridge — polls WLED devices for LED strip stats.

Device list derived from topology (nodes with _role=wled and an IP).
"""

import json
import threading
import time
import urllib.request

import realm_db

POLL_INTERVAL = 30
_cache = {"ts": 0, "devices": {}}
_lock = threading.Lock()


def _get_wled_devices():
    """Get WLED device IPs from topology DB (nodes with _role=wled)."""
    devices = {}
    for node in realm_db.get_nodes():
        if node.get("_role") == "wled" and node.get("ip"):
            devices[node["id"]] = node["ip"]
    return devices


def _fetch_wled(ip):
    """GET /json from WLED device."""
    try:
        req = urllib.request.Request(f"http://{ip}/json", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _build_wled_stats(data):
    """Extract stats from WLED JSON response."""
    if not data:
        return None

    state = data.get("state", {})
    info = data.get("info", {})
    effects = data.get("effects", [])

    seg = state.get("seg", [{}])[0]
    fx_id = seg.get("fx", 0)
    effect_name = effects[fx_id] if fx_id < len(effects) else f"Effect {fx_id}"

    uptime_s = info.get("uptime", 0)
    uptime_d = uptime_s // 86400
    uptime_h = (uptime_s % 86400) // 3600

    leds = info.get("leds", {})
    wifi = info.get("wifi", {})

    return {
        "online": True,
        "on": state.get("on", False),
        "brightness": state.get("bri", 0),
        "brightness_pct": round(state.get("bri", 0) / 255 * 100),
        "effect": effect_name,
        "effect_id": fx_id,
        "palette": state.get("ps", 0),
        "led_count": leds.get("count", 0),
        "led_power_mw": leds.get("pwr", 0),
        "led_max_power_mw": leds.get("maxpwr", 0),
        "version": info.get("ver", "?"),
        "name": info.get("name", "WLED"),
        "wifi_rssi": wifi.get("rssi"),
        "wifi_signal": wifi.get("signal"),
        "wifi_channel": wifi.get("channel"),
        "uptime_s": uptime_s,
        "uptime_str": f"{uptime_d}d {uptime_h}h" if uptime_d else f"{uptime_h}h",
        "free_heap": info.get("freeheap"),
        "live_mode": state.get("lor", 0),
    }


def poll_once():
    """Poll all WLED devices once."""
    devices = _get_wled_devices()
    results = {}
    for node_id, ip in devices.items():
        data = _fetch_wled(ip)
        stats = _build_wled_stats(data)
        if stats:
            results[node_id] = stats
        else:
            results[node_id] = {"online": False}

    with _lock:
        _cache["ts"] = time.time()
        _cache["devices"] = results
    return len([d for d in results.values() if d.get("online")])


def get_wled_states():
    """Get cached WLED device states."""
    with _lock:
        return dict(_cache.get("devices", {}))


def _poll_loop():
    """Background polling loop."""
    while True:
        try:
            devices = _get_wled_devices()
            n = poll_once()
            if devices:
                print(f"[WLED Bridge] Polled {len(devices)} devices, {n} online")
        except Exception as e:
            print(f"[WLED Bridge] Error: {e}")
        time.sleep(POLL_INTERVAL)


def start_wled_bridge():
    """Start the WLED bridge as a daemon thread."""
    devices = _get_wled_devices()
    if not devices:
        print("[WLED Bridge] No WLED devices in topology, skipping")
        return None
    poll_once()
    t = threading.Thread(target=_poll_loop, daemon=True)
    t.start()
    print(f"[WLED Bridge] Started (interval={POLL_INTERVAL}s, devices={len(devices)})")
    return t


# ── WLED Control API ──

def set_wled_state(node_id, on=None, brightness=None, effect=None):
    """Set WLED state via API."""
    devices = _get_wled_devices()
    ip = devices.get(node_id)
    if not ip:
        return {"error": f"Unknown WLED device: {node_id}"}

    payload = {}
    if on is not None:
        payload["on"] = on
    if brightness is not None:
        payload["bri"] = min(255, max(0, brightness))
    if effect is not None:
        payload["seg"] = [{"fx": effect}]

    if not payload:
        return {"error": "No state changes specified"}

    try:
        req = urllib.request.Request(
            f"http://{ip}/json/state",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            return {"ok": True, "status": resp.status}
    except Exception as e:
        return {"ok": False, "error": str(e)}
