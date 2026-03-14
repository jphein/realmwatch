#!/usr/bin/env python3
"""Parse nftables JSON ruleset into structured zone/VLAN data for the firewall panel."""

import json
import time
import threading

# Zone → VLAN mapping (OpenWrt fw4 zone names don't match purpose)
ZONE_VLAN = {
    "admin": 6,
    "iot": 8,       # Actually family devices
    "lan": 10,      # Actually IoT devices
    "family": 11,   # Actually guest
    "vpn": 9,
    "wan": None,
    "wanguard": None,
}

# VLAN → human label (matches the UI)
VLAN_LABEL = {6: "Admin", 8: "Family", 10: "IoT", 11: "Guest"}

# Which zones we report on
_REPORT_ZONES = ("admin", "iot", "lan", "family")

_cache = None
_cache_ts = 0
_CACHE_TTL = 30.0
_lock = threading.Lock()


def parse_nft_json(raw_json):
    """Parse nft -j list ruleset output into structured zone data."""
    try:
        data = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
    except (json.JSONDecodeError, TypeError):
        return None

    items = data.get("nftables", [])
    zones = {}

    for zone in _REPORT_ZONES:
        vlan = ZONE_VLAN.get(zone)
        zones[zone] = {
            "zone": zone,
            "vlan": vlan,
            "label": VLAN_LABEL.get(vlan, zone),
            "rules": [],
            "counters": {
                "accept_bytes": 0, "accept_pkts": 0,
                "reject_bytes": 0, "reject_pkts": 0,
            },
            "dns_redirect": False,
            "dns_queries": 0,
            "blocked_ips": [],
            "can_reach": [],
        }

    # Extract rules per chain
    for item in items:
        rule = item.get("rule")
        if not rule:
            continue
        chain = rule.get("chain", "")
        exprs = rule.get("expr", [])

        # Find counter, action, matches in this rule
        counter = None
        action = None
        action_target = None
        matches = []
        for expr in exprs:
            if "counter" in expr:
                counter = expr["counter"]
            for act in ("accept", "drop", "reject", "jump", "goto", "redirect"):
                if act in expr:
                    action = act
                    if isinstance(expr[act], dict):
                        action_target = expr[act].get("target", "")
            if "match" in expr:
                m = expr["match"]
                left = m.get("left", {})
                right = m.get("right", "")
                if isinstance(left, dict):
                    payload = left.get("payload", {})
                    field = payload.get("field", "")
                    proto = payload.get("protocol", "")
                    if field:
                        matches.append({"proto": proto, "field": field, "value": right})

        # Categorize by chain pattern
        for zone in _REPORT_ZONES:
            z = zones[zone]

            # accept_to_{zone} — incoming traffic counter
            if chain == f"accept_to_{zone}" and counter:
                z["counters"]["accept_bytes"] += counter.get("bytes", 0)
                z["counters"]["accept_pkts"] += counter.get("packets", 0)

            # reject_from_{zone} — rejected outbound
            if chain == f"reject_from_{zone}" and counter:
                z["counters"]["reject_bytes"] += counter.get("bytes", 0)
                z["counters"]["reject_pkts"] += counter.get("packets", 0)

            # dstnat_{zone} — DNS redirect detection
            if chain == f"dstnat_{zone}":
                if action == "redirect":
                    z["dns_redirect"] = True
                    if counter:
                        z["dns_queries"] += counter.get("packets", 0)

            # forward_{zone} — blocked IPs and reachability
            if chain == f"forward_{zone}":
                # Blocked IPs (jump to reject_to_wan with specific src IP)
                if action == "jump" and action_target == "reject_to_wan":
                    for m in matches:
                        if m["field"] == "saddr":
                            z["blocked_ips"].append({
                                "ip": m["value"],
                                "pkts": counter.get("packets", 0) if counter else 0,
                                "bytes": counter.get("bytes", 0) if counter else 0,
                            })
                # Reachability (jump to accept_to_*)
                if action == "jump" and action_target and action_target.startswith("accept_to_"):
                    dest = action_target.replace("accept_to_", "")
                    z["can_reach"].append(dest)

            # forward_{zone} accept with no match = default accept in zone
            if chain == f"forward_{zone}" and action == "accept" and not matches:
                pass  # General accept within zone

    # Build WAN counters
    wan = {
        "accept_bytes": 0, "accept_pkts": 0,
        "reject_bytes": 0, "reject_pkts": 0,
    }
    for item in items:
        rule = item.get("rule")
        if not rule:
            continue
        chain = rule.get("chain", "")
        for expr in rule.get("expr", []):
            if "counter" not in expr:
                continue
            c = expr["counter"]
            if chain == "accept_to_wan":
                wan["accept_bytes"] += c.get("bytes", 0)
                wan["accept_pkts"] += c.get("packets", 0)
            if chain == "reject_from_wan":
                wan["reject_bytes"] += c.get("bytes", 0)
                wan["reject_pkts"] += c.get("packets", 0)

    # Generate suggestions for VLAN 10 (zone "lan")
    suggestions = _generate_suggestions(zones)

    return {
        "zones": zones,
        "wan": wan,
        "suggestions": suggestions,
        "ts": time.time(),
    }


def _generate_suggestions(zones):
    """Generate firewall suggestions, focusing on VLAN 10 (IoT)."""
    suggestions = []
    lan = zones.get("lan", {})  # "lan" zone = VLAN 10

    # Check blocked IPs
    blocked = lan.get("blocked_ips", [])
    active_blocks = [b for b in blocked if b["pkts"] > 0]
    inactive_blocks = [b for b in blocked if b["pkts"] == 0]
    if active_blocks:
        ips = ", ".join(b["ip"] for b in active_blocks)
        suggestions.append({
            "severity": "info",
            "zone": "lan",
            "text": f"WAN blocks active for {len(active_blocks)} IPs ({ips}) — cameras isolated from internet",
        })
    if inactive_blocks:
        ips = ", ".join(b["ip"] for b in inactive_blocks)
        suggestions.append({
            "severity": "warn",
            "zone": "lan",
            "text": f"{len(inactive_blocks)} WAN block rules with 0 hits ({ips}) — device may be offline or IP changed",
        })

    # Check reject volume
    reject_pkts = lan.get("counters", {}).get("reject_pkts", 0)
    if reject_pkts > 1_000_000:
        suggestions.append({
            "severity": "warn",
            "zone": "lan",
            "text": f"{reject_pkts:,} rejected input packets — IoT devices aggressively probing the router (likely mDNS/SSDP)",
        })

    # DNS redirect check
    if lan.get("dns_redirect"):
        suggestions.append({
            "severity": "info",
            "zone": "lan",
            "text": f"DNS intercepted — {lan.get('dns_queries', 0):,} queries redirected to router DNS",
        })
    else:
        suggestions.append({
            "severity": "warn",
            "zone": "lan",
            "text": "No DNS redirect — IoT devices can use external DNS, bypassing filtering",
        })

    # Check inter-VLAN access
    can_reach = lan.get("can_reach", [])
    if "admin" in [ZONE_VLAN.get(z) for z in can_reach] or "admin" in can_reach:
        suggestions.append({
            "severity": "critical",
            "zone": "lan",
            "text": "IoT (VLAN 10) can reach Admin (VLAN 6) — consider blocking inter-VLAN access",
        })

    # Check if admin can reach all zones (expected)
    admin = zones.get("admin", {})
    if len(admin.get("can_reach", [])) >= 4:
        suggestions.append({
            "severity": "info",
            "zone": "admin",
            "text": "Admin has full inter-VLAN access — expected for management",
        })

    # Check iot zone (VLAN 8 = family) rejects
    iot = zones.get("iot", {})
    iot_reject = iot.get("counters", {}).get("reject_pkts", 0)
    if iot_reject > 10000:
        suggestions.append({
            "severity": "info",
            "zone": "iot",
            "text": f"Family zone (VLAN 8): {iot_reject:,} rejected packets",
        })

    return suggestions


def get_cached():
    """Return cached firewall data or None if stale."""
    global _cache, _cache_ts
    with _lock:
        if _cache and (time.time() - _cache_ts) < _CACHE_TTL:
            return _cache
    return None


def update_cache(parsed):
    """Update the cache with parsed firewall data."""
    global _cache, _cache_ts
    with _lock:
        _cache = parsed
        _cache_ts = time.time()
