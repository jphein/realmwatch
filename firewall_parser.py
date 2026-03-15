#!/usr/bin/env python3
"""Parse nftables JSON ruleset into structured zone/VLAN data for the firewall panel."""

import json
import time
import threading

# ── Complete VLAN registry ──
# fw4 zone names on gatekeeper are mismatched — map to correct human labels.
# "lan" zone = VLAN 10 (IoT), "iot" zone = VLAN 8 (Guest), "family" zone = VLAN 11 (Family)

VLANS = {
    3:  {"label": "Backup WAN",    "type": "wan",      "status": "standby",  "desc": "Emergency DSL/cellular backup",           "icon": "\U0001F4E1"},
    4:  {"label": "Old Treelink",  "type": "wan",      "status": "deprecated","desc": "Deprecated — replaced by VLAN 38",       "icon": "\U0001F6AB"},
    5:  {"label": "Althea Mesh",   "type": "reserved", "status": "inactive", "desc": "Reserved for Althea mesh network",        "icon": "\U0001F578\uFE0F"},
    6:  {"label": "Admin",         "type": "lan",      "status": "active",   "desc": "Servers, management, infrastructure",     "icon": "\u2694"},
    7:  {"label": "Test Lab",      "type": "lan",      "status": "active",   "desc": "Testing and experimentation",             "icon": "\U0001F9EA"},
    8:  {"label": "Guest",         "type": "lan",      "status": "active",   "desc": "Guest WiFi, isolated from all wards",     "icon": "\U0001F464"},
    9:  {"label": "VPN Exit",      "type": "lan",      "status": "planned",  "desc": "WireGuard tunnel to gig exit node",       "icon": "\U0001F510"},
    10: {"label": "IoT",           "type": "lan",      "status": "active",   "desc": "Smart devices, sensors, automations",     "icon": "\U0001F916"},
    11: {"label": "Family",        "type": "lan",      "status": "active",   "desc": "Personal devices, phones, laptops",       "icon": "\U0001F46A"},
    12: {"label": "Backup Fiber",  "type": "wan",      "status": "reserved", "desc": "Reserved for secondary fiber WAN",        "icon": "\U0001F4A0"},
    20: {"label": "AT&T Fiber",    "type": "wan",      "status": "reserved", "desc": "Reserved for future AT&T fiber",          "icon": "\U0001F4A0"},
    38: {"label": "Treelink WAN",  "type": "wan",      "status": "active",   "desc": "Primary internet — fiber + WiFi backup",  "icon": "\U0001F30D"},
}

# fw4 zone name → VLAN ID (gatekeeper zone names are mismatched)
ZONE_VLAN = {
    "admin":  6,
    "iot":    8,    # fw4 calls it "iot" but it's actually Guest
    "lan":    10,   # fw4 calls it "lan" but it's actually IoT
    "family": 11,   # fw4 calls it "family" — now correct!
    "vpn":    9,
    "wan":    None,
    "wanguard": None,
}

# Reverse: VLAN → fw4 zone name
VLAN_ZONE = {v: k for k, v in ZONE_VLAN.items() if v is not None}

# Which zones we parse nft rules for (only zones with fw4 chains)
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
        vinfo = VLANS.get(vlan, {})
        zones[zone] = {
            "zone": zone,
            "vlan": vlan,
            "label": vinfo.get("label", zone),
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

    suggestions = _generate_suggestions(zones)

    return {
        "zones": zones,
        "wan": wan,
        "vlans": VLANS,  # Full registry for the frontend
        "suggestions": suggestions,
        "ts": time.time(),
    }


def _generate_suggestions(zones):
    """Generate firewall suggestions across all VLANs."""
    suggestions = []

    # ── IoT (VLAN 10, fw4 zone "lan") ──
    lan = zones.get("lan", {})

    blocked = lan.get("blocked_ips", [])
    active_blocks = [b for b in blocked if b["pkts"] > 0]
    inactive_blocks = [b for b in blocked if b["pkts"] == 0]
    if active_blocks:
        ips = ", ".join(b["ip"] for b in active_blocks)
        suggestions.append({
            "severity": "info", "zone": "lan",
            "text": f"WAN blocks active for {len(active_blocks)} IPs ({ips}) — cameras isolated from internet",
        })
    if inactive_blocks:
        ips = ", ".join(b["ip"] for b in inactive_blocks)
        suggestions.append({
            "severity": "warn", "zone": "lan",
            "text": f"{len(inactive_blocks)} WAN block rules with 0 hits ({ips}) — device may be offline or IP changed",
        })

    reject_pkts = lan.get("counters", {}).get("reject_pkts", 0)
    if reject_pkts > 1_000_000:
        suggestions.append({
            "severity": "warn", "zone": "lan",
            "text": f"{reject_pkts:,} rejected input packets — IoT devices aggressively probing the router",
        })

    if lan.get("dns_redirect"):
        suggestions.append({
            "severity": "info", "zone": "lan",
            "text": f"DNS intercepted — {lan.get('dns_queries', 0):,} queries redirected to router DNS",
        })
    else:
        suggestions.append({
            "severity": "warn", "zone": "lan",
            "text": "No DNS redirect on IoT — devices can use external DNS, bypassing filtering",
        })

    # Inter-VLAN access check
    can_reach = lan.get("can_reach", [])
    if "admin" in can_reach:
        suggestions.append({
            "severity": "critical", "zone": "lan",
            "text": "IoT (VLAN 10) can reach Admin (VLAN 6) — consider blocking inter-VLAN access",
        })

    # ── Admin (VLAN 6) ──
    admin = zones.get("admin", {})
    if len(admin.get("can_reach", [])) >= 4:
        suggestions.append({
            "severity": "info", "zone": "admin",
            "text": "Admin has full inter-VLAN access — expected for management",
        })

    # ── Guest (VLAN 8, fw4 zone "iot") ──
    iot = zones.get("iot", {})
    iot_reject = iot.get("counters", {}).get("reject_pkts", 0)
    if iot_reject > 10000:
        suggestions.append({
            "severity": "info", "zone": "iot",
            "text": f"Guest (VLAN 8): {iot_reject:,} rejected packets",
        })
    if not iot.get("dns_redirect"):
        suggestions.append({
            "severity": "warn", "zone": "iot",
            "text": "No DNS redirect on Guest (VLAN 8) — visitors can bypass DNS filtering",
        })
    guest_reach = iot.get("can_reach", [])
    non_wan = [r for r in guest_reach if r not in ("wan", "wanguard")]
    if non_wan:
        labels = {z: VLANS.get(ZONE_VLAN.get(z), {}).get("label", z) for z in non_wan}
        names = ", ".join(labels.values())
        suggestions.append({
            "severity": "warn", "zone": "iot",
            "text": f"Guest (VLAN 8) can reach {names} — should be WAN-only",
        })

    # ── Family (VLAN 11, fw4 zone "family") ──
    family = zones.get("family", {})
    family_reach = family.get("can_reach", [])
    # Family should reach IoT for casting — check it's configured
    if "lan" not in family_reach:
        suggestions.append({
            "severity": "warn", "zone": "family",
            "text": "Family (VLAN 11) cannot reach IoT — casting/AirPlay won't work",
        })

    # ── VLANs needing firewall rules ──
    for vlan_id, vinfo in VLANS.items():
        if vinfo["status"] == "planned":
            suggestions.append({
                "severity": "warn", "zone": VLAN_ZONE.get(vlan_id, f"vlan{vlan_id}"),
                "text": f"{vinfo['label']} (VLAN {vlan_id}) needs fw4 zone and firewall rules configured",
            })
        elif vinfo["status"] == "active" and vinfo["type"] == "lan" and vlan_id not in (6, 8, 10, 11):
            # Active LAN VLAN without known fw4 zone
            if vlan_id not in VLAN_ZONE:
                suggestions.append({
                    "severity": "warn", "zone": f"vlan{vlan_id}",
                    "text": f"{vinfo['label']} (VLAN {vlan_id}) is active but has no fw4 zone — traffic is unfiltered",
                })

    # ── WAN redundancy ──
    wan_vlans = [v for v, info in VLANS.items() if info["type"] == "wan" and info["status"] == "active"]
    if len(wan_vlans) < 2:
        suggestions.append({
            "severity": "info", "zone": "wan",
            "text": "Only one active WAN (VLAN 38) — consider enabling backup WAN (VLAN 3) for mwan3 failover",
        })

    # VLAN 38 dual-link suggestion
    suggestions.append({
        "severity": "info", "zone": "wan",
        "text": "Treelink fiber + WiFi backup share VLAN 38 — split to separate VLANs for mwan3 policy routing",
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
