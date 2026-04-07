"""WLED plugin — LED device bridge and control API.

Starts the WLED bridge daemon thread (device polling) and provides
the POST /wled/<node_id>/state endpoint for controlling WLED devices.

Delegates all WLED logic to wled_bridge.py.
"""

import wled_bridge
from discovery_engine import SubEntity


def handle_wled_state(req, params):
    """POST /wled/<node_id>/state endpoint handler."""
    try:
        data = req.json()
        result = wled_bridge.set_wled_state(
            params.get("node_id", ""),
            on=data.get("on"),
            brightness=data.get("bri"),
            effect=data.get("fx"),
        )
        req.respond(result)
    except Exception as e:
        req.respond({"error": str(e)}, 500)
    return None


def discover_wled(node_id, node_data, host_access, engine):
    """Discover WLED device info via HTTP JSON API."""
    resp = host_access.http_get(80, "/json/info")
    if not resp or resp.get("status") != 200:
        return []
    import json as _json
    try:
        info = _json.loads(resp["body"])
    except (ValueError, KeyError):
        return []
    return [SubEntity(
        id=f"wled:{node_id}",
        type="wled_device",
        name=info.get("name", node_id),
        host_node_id=node_id,
        status="running",
        metadata={
            "leds": info.get("leds", {}).get("count", 0),
            "firmware": info.get("ver", "unknown"),
            "brand": info.get("brand", "WLED"),
            "mac": info.get("mac", ""),
        },
    )]


def setup(ctx):
    """Plugin setup — start WLED bridge, register status provider."""

    # Start WLED bridge daemon thread
    wled_bridge.start_wled_bridge()

    # Register status provider so build_status() includes WLED states
    ctx.register_status_provider(wled_bridge.get_wled_states)

    # Expose public API for other plugins
    ctx.expose_api({
        "get_wled_states": wled_bridge.get_wled_states,
        "set_wled_state": wled_bridge.set_wled_state,
    })

    # Register WLED as a discovery provider
    ctx.register_discovery_provider(
        name="wled", roles=["wled", "iot"],
        discover_fn=discover_wled, interval=60,
        entity_types=["wled_device"], priority=40,
    )

    ctx.log("Prismatic Lights started (WLED bridge)")
