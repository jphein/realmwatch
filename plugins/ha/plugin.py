"""HA plugin — Home Assistant bridge + energy data.

Starts the HA bridge daemon thread (entity states, device enrichment) and
provides the /energy endpoint and SSE source for solar/battery/grid data.

Delegates all HA polling to ha_bridge.py. Energy data is fetched directly
from HA REST API with a 30s TTL cache (same logic as map_server._get_energy_data).
"""

import json
import os
import ssl
import threading
import time
import urllib.request

import ha_bridge

# ── Energy data cache (ported from map_server.py) ──
_energy_cache = {"data": None, "ts": 0}
_energy_cache_lock = threading.Lock()
_ENERGY_TTL = 30  # seconds


def _get_energy_data():
    """Fetch energy-related data from HA REST API (30s TTL cache)."""
    now = time.time()
    with _energy_cache_lock:
        if _energy_cache["data"] is not None and (now - _energy_cache["ts"]) < _ENERGY_TTL:
            return _energy_cache["data"]

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
        "solar_kw": num("sensor.pv_power"),
        "solar_today_kwh": num("sensor.today_s_pv_generation"),
        "solar_total_kwh": num("sensor.total_pv_generation"),
        "battery_soc": num("sensor.battery_state_of_charge"),
        "battery_power": num("sensor.battery_power"),
        "battery_voltage": num("sensor.battery_voltage"),
        "grid_power": num("sensor.grid_power"),
        "grid_import_kwh": num("sensor.total_energy_import"),
        "grid_export_kwh": num("sensor.total_energy_export"),
        "house_load": num("sensor.house_consumption"),
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


# ── Endpoint handler ──

def handle_energy(req, params):
    """GET /energy endpoint handler."""
    req.respond(_get_energy_data())


# ── Plugin entry point ──

def setup(ctx):
    """Plugin setup — start HA bridge, register SSE source and status provider."""

    # Start HA bridge daemon thread
    ha_bridge.start_ha_bridge()

    # Register SSE source for energy data (30s, burst with priority 3)
    ctx.register_sse_source(
        event_type="energy",
        getter_fn=_get_energy_data,
        interval=30,
        burst=True,
        burst_priority=3,
    )

    # Register status provider so build_status() includes HA states
    ctx.register_status_provider(ha_bridge.get_ha_states)

    # Expose public API for other plugins
    ctx.expose_api({
        "get_ha_states": ha_bridge.get_ha_states,
        "get_device_enrichment": ha_bridge.get_device_enrichment,
        "call_service": ha_bridge.call_service,
        "poll_once": ha_bridge.poll_once,
        "get_energy_data": _get_energy_data,
    })

    ctx.log("Crystal Bridge started (HA bridge + energy)")
