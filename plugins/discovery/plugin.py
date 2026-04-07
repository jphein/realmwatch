"""Discovery companion plugin — wires the discovery engine into the plugin system.

Registers:
- API endpoints: /discovery, /discovery/<node_id>, /discovery/links, /discovery/providers,
  /discovery/link, /discovery/unlink, /discovery/scan
- SSE source: 'discovery' event type
- Node enricher: discovery-based sublabels and status
- Status provider: discovery summary in status blob
"""

import json

# The engine instance is set during setup
_engine = None


def _h_get_discovery(req, params):
    """GET /discovery — all sub-entities grouped by host."""
    return req.respond(_engine.get_sse_data())


def _h_get_discovery_node(req, params):
    """GET /discovery/<node_id> — sub-entities for a specific host."""
    node_id = params.get("node_id", "")
    entities = _engine.get_sub_entities(host_node_id=node_id)
    # Also include entities linked TO this node
    linked = _engine.get_sub_entities_for_linked_node(node_id)
    return req.respond({"host_entities": entities, "linked_entities": linked})


def _h_get_discovery_providers(req, params):
    """GET /discovery/providers — registered providers."""
    providers = _engine.get_providers()
    return req.respond([{
        "name": p.name, "roles": p.roles, "interval": p.interval,
        "entity_types": p.entity_types, "priority": p.priority, "plugin": p.plugin,
    } for p in providers])


def _h_get_discovery_links(req, params):
    """GET /discovery/links — all entity links."""
    import realm_db
    entities = realm_db.get_sub_entities()
    links = [{"sub_entity_id": e["id"], "linked_node_id": e["linked_node_id"],
              "link_type": e.get("link_type")}
             for e in entities if e.get("linked_node_id")]
    return req.respond(links)


def _h_post_discovery_link(req, params):
    """POST /discovery/link — create manual link."""
    import realm_db
    data = req.json()
    sub_id = data.get("sub_entity_id", "")
    node_id = data.get("node_id", "")
    if not sub_id or not node_id:
        return req.respond({"error": "sub_entity_id and node_id required"}, 400)
    realm_db.set_discovery_link(sub_id, node_id)
    return req.respond({"ok": True})


def _h_post_discovery_unlink(req, params):
    """POST /discovery/unlink — remove manual link."""
    import realm_db
    data = req.json()
    sub_id = data.get("sub_entity_id", "")
    if not sub_id:
        return req.respond({"error": "sub_entity_id required"}, 400)
    realm_db.delete_discovery_link(sub_id)
    return req.respond({"ok": True})


def _h_post_discovery_scan(req, params):
    """POST /discovery/scan — trigger immediate scan."""
    data = req.json()
    provider_name = data.get("provider", "all")
    # Force next scan cycle to run this provider immediately
    if provider_name == "all":
        _engine._last_scan.clear()
    else:
        _engine._last_scan.pop(provider_name, None)
    return req.respond({"ok": True, "message": f"Scan triggered for {provider_name}"})


def _discovery_status_provider():
    """Status provider — discovery summary in the status blob."""
    data = _engine.get_sse_data()
    return {"discovery": data["summary"]}


def setup(ctx):
    global _engine
    from discovery_engine import DiscoveryEngine

    # Get or create the engine singleton
    import sys
    ms = sys.modules.get('__main__')
    if ms and hasattr(ms, '_discovery_engine') and ms._discovery_engine:
        _engine = ms._discovery_engine
    else:
        _engine = DiscoveryEngine()

    # Register API endpoints
    ctx.register_endpoint("GET", "/discovery", _h_get_discovery, raw_path=True)
    ctx.register_endpoint("GET", "/discovery/providers", _h_get_discovery_providers, raw_path=True)
    ctx.register_endpoint("GET", "/discovery/links", _h_get_discovery_links, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/link", _h_post_discovery_link, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/unlink", _h_post_discovery_unlink, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/scan", _h_post_discovery_scan, raw_path=True)

    # Parameterized route for /discovery/<node_id>
    ctx.register_endpoint("GET", "/discovery/<node_id>", _h_get_discovery_node, raw_path=True)

    # SSE source
    ctx.register_sse_source("discovery", _engine.get_sse_data, interval=30, burst=True, burst_priority=6)

    # Node enricher (priority 35 — between WLED and WiFi)
    ctx.register_node_enricher(_engine.enrich_node, priority=35)

    # Status provider
    ctx.register_status_provider(_discovery_status_provider)

    # Expose API for other plugins
    ctx.expose_api({
        "get_sub_entities": _engine.get_sub_entities,
        "get_providers": _engine.get_providers,
        "get_sse_data": _engine.get_sse_data,
    })

    ctx.log("Realm Surveyors active — discovery engine companion loaded")
