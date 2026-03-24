"""WLED plugin — LED device bridge and control API.

Starts the WLED bridge daemon thread (device polling) and provides
the POST /wled/<node_id>/state endpoint for controlling WLED devices.

Delegates all WLED logic to wled_bridge.py.
"""

import wled_bridge


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

    ctx.log("Prismatic Lights started (WLED bridge)")
