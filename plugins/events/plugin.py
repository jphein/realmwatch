"""Events plugin — threshold monitoring via event_generator.

Wraps event_generator into the plugin system. The event generator monitors
collectd metrics and Home Assistant states, firing fantasy-themed alert events
when thresholds are crossed (CPU, memory, disk, temp, load, HA state changes).

Also subscribes to the discovery engine for sub-entity status changes,
generating themed realm events for container/service/device transitions.
"""

import time
import logging

import event_generator

log = logging.getLogger(__name__)

# ── Discovery Event Templates ──

_DISCOVERY_TEMPLATES = {
    ("container", "stopped"): "The Iron Golem '{name}' has fallen silent in {host}",
    ("container", "failed"): "The Iron Golem '{name}' has crumbled in {host}!",
    ("container", "running"): "The Iron Golem '{name}' stirs to life in {host}",
    ("service", "failed"): "The Runic Ward '{name}' on {host} has shattered!",
    ("service", "stopped"): "The Runic Ward '{name}' on {host} fades to silence",
    ("service", "running"): "The Runic Ward '{name}' on {host} blazes anew",
    ("collectd_host", "stale"): "The beacon of {name} has gone dark",
    ("collectd_host", "running"): "The beacon of {name} shines once more",
}

_DISCOVERY_NEW_TEMPLATES = {
    "container": "A new construct stirs in {host}: {name}",
    "service": "A new ward manifests on {host}: {name}",
    "wled_device": "A luminous artifact awakens: {name}",
    "ha_device": "A new presence joins the realm: {name}",
    "firewall_zone": "A new ward boundary forms: {name}",
}

_discovery_cooldown = {}  # entity_id -> last_event_ts
_DISCOVERY_EVENT_COOLDOWN = 300  # 5 minutes


def _on_discovery_change(event_type, entity, old_status):
    """Handle discovery change events — generate themed realm events."""
    now = time.time()

    # Cooldown check
    last = _discovery_cooldown.get(entity.id, 0)
    if now - last < _DISCOVERY_EVENT_COOLDOWN:
        return
    _discovery_cooldown[entity.id] = now

    if event_type == "status_change":
        template = _DISCOVERY_TEMPLATES.get((entity.type, entity.status))
        if not template:
            return
        color = "#ff4040" if entity.status in ("failed",) else "#ffaa00" if entity.status in ("stopped", "stale") else "#80ff80"
        evt_type = "alert" if entity.status == "failed" else "speech"
    elif event_type == "new_entity":
        template = _DISCOVERY_NEW_TEMPLATES.get(entity.type)
        if not template:
            return
        color = "#80c0ff"
        evt_type = "speech"
    else:
        return

    text = template.format(name=entity.name, host=entity.host_node_id)

    if _push_event_fn:
        _push_event_fn({
            "type": evt_type,
            "node": entity.host_node_id,
            "text": text,
            "color": color,
            "entity_id": entity.id,
            "entity_type": entity.type,
            "entity_status": entity.status,
        })

_push_event_fn = None


def setup(ctx):
    """Plugin setup — start event generator with raw push_event passthrough."""

    # event_generator.start_event_generator(callback) expects callback to accept
    # a complete event dict ({type, node, text, color, ...}).
    # ctx._push_event(event_dict) does exactly this — passes the dict through
    # directly. ctx.push_event(event_type, data) would double-wrap the type.
    event_generator.start_event_generator(ctx._push_event)

    ctx.log("Sentinel Wards active — threshold monitoring started (interval=%ds)",
            event_generator.CHECK_INTERVAL)

    global _push_event_fn
    _push_event_fn = ctx._push_event

    # Subscribe to discovery engine changes
    try:
        import sys
        ms = sys.modules.get('__main__')
        if ms and hasattr(ms, '_discovery_engine') and ms._discovery_engine:
            ms._discovery_engine.on_change(_on_discovery_change)
            ctx.log("Subscribed to discovery engine change events")
    except Exception as e:
        ctx.log("Could not subscribe to discovery events: %s", e)
