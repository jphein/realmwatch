"""Firewall plugin — Ward Stones.

Wraps firewall_parser to provide parsed nftables data from gatekeeper,
zone/VLAN mapping, suggestions, and SSE firewall events.
"""

import firewall_parser
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

    ctx.log("Ward Stones firewall parser registered (interval=60s)")
