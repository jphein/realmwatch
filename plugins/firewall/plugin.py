"""Firewall plugin — Ward Stones.

Wraps firewall_parser to provide parsed nftables data from gatekeeper,
zone/VLAN mapping, suggestions, and SSE firewall events.
"""

import firewall_parser
from discovery_engine import SubEntity
from engine import RealmEngine

# Module-level engine ref for SSH to gatekeeper
_engine = RealmEngine()


def _get_firewall_data():
    """Get firewall data, refreshing cache via SSH if stale."""
    cached = firewall_parser.get_cached()
    if cached:
        return cached
    raw = _engine._run_router_cmd("nft -j list ruleset")
    if not raw:
        return None
    parsed = firewall_parser.parse_nft_json(raw)
    if parsed:
        firewall_parser.update_cache(parsed)
    return parsed


def _get_firewall_sse_data():
    """SSE source getter — returns cached or fresh firewall data."""
    return _get_firewall_data()


def handle_firewall(req, params):
    """GET /firewall — parsed nftables zone/VLAN data."""
    cached = firewall_parser.get_cached()
    if cached:
        return cached
    raw = _engine._run_router_cmd("nft -j list ruleset")
    if not raw:
        req.respond({"error": "Cannot reach gatekeeper"}, 503)
        return None
    parsed = firewall_parser.parse_nft_json(raw)
    if parsed:
        firewall_parser.update_cache(parsed)
        return parsed
    req.respond({"error": "Failed to parse nft rules"}, 500)
    return None


def discover_firewall(node_id, node_data, host_access, engine):
    """Discover firewall zones from nftables on gatekeeper."""
    from firewall_parser import get_cached
    fw = get_cached()
    if not fw:
        return []

    entities = []
    zones = fw.get("zones", {})
    for zone_name, zone_data in zones.items():
        if isinstance(zone_data, dict):
            interfaces = zone_data.get("interfaces", [])
            vlan = zone_data.get("vlan")
            rule_count = len(zone_data.get("rules", []))
        else:
            interfaces = []
            vlan = None
            rule_count = 0

        entities.append(SubEntity(
            id=f"fw:zone:{zone_name}",
            type="firewall_zone",
            name=zone_name,
            host_node_id="gatekeeper",
            status="running",
            metadata={
                "vlan": vlan,
                "interfaces": interfaces,
                "rule_count": rule_count,
            },
        ))
    return entities


def setup(ctx):
    """Plugin setup — register SSE source and expose API."""

    # Register SSE source (firewall data, 60s interval, no burst — may trigger slow SSH)
    ctx.register_sse_source(
        event_type="firewall",
        getter_fn=_get_firewall_sse_data,
        interval=60,
        burst=False,
    )

    # Expose public API for other plugins
    ctx.expose_api({
        "get_firewall_data": _get_firewall_data,
        "get_cached": firewall_parser.get_cached,
        "parse_nft_json": firewall_parser.parse_nft_json,
        "VLANS": firewall_parser.VLANS,
        "ZONE_VLAN": firewall_parser.ZONE_VLAN,
    })

    # Register firewall zones as a global discovery provider
    ctx.register_discovery_provider(
        name="firewall", roles=[],  # global — parses gatekeeper nftables
        discover_fn=discover_firewall, interval=120,
        entity_types=["firewall_zone"], priority=55,
    )

    ctx.log("Ward Stones firewall parser registered (interval=60s)")
