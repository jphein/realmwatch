#!/usr/bin/env python3
"""Parse nftables JSON ruleset into structured zone/VLAN data for the firewall panel.

Called by map_server's /firewall endpoint: map_server SSH-hops to gatekeeper,
runs `nft -j list ruleset`, then passes the JSON here to parse. Results are
cached for CACHE_TTL seconds so repeated browser polls don't re-SSH.

Data flow:
  map_server → SSH → gatekeeper `nft -j list ruleset`
  → parse_nft_json(raw_json)
  → {zones, wan, vlans, suggestions, ts}
  → update_cache() → get_cached() → /firewall HTTP response

Threading:
  _lock guards _cache / _cache_ts. Cache reads (get_cached) and writes
  (update_cache) are the only shared state; parse_nft_json is pure.

Configuration:
  _CACHE_TTL = 30.0  # seconds

VLAN registry (VLANS dict):
  Mapping of VLAN IDs with label, type, status, description. Loaded at
  import time from gitignored vlans.yaml (see vlans.yaml.example for the
  schema). Exported to the frontend for the full VLAN table display.

fw4 zone-name quirk:
  Some realms have fw4 zone names that don't match their human VLAN
  meaning (e.g. a zone literally named "lan" carrying IoT traffic).
  vlans.yaml encodes the mismatch via the per-entry `zone:` key, so the
  parser stays zone-name-agnostic.

Per-zone output fields:
  counters:    accept_bytes/pkts, reject_bytes/pkts
  dns_redirect: True if dstnat_{zone} has a redirect rule
  dns_queries: packet count of redirected DNS queries
  blocked_ips: [{ip, pkts, bytes}] — IPs blocked to WAN
  can_reach:   [zone_name, ...] — zones this zone can forward to

Suggestions (firewall_parser._generate_suggestions):
  Rule-based analysis across all zones. Flags missing DNS redirects,
  inter-VLAN access leaks, inactive block rules, WAN redundancy gaps.

Public API (imported by map_server):
  parse_nft_json(raw_json)  -> dict | None
  get_cached()              -> dict | None
  update_cache(parsed)
  VLANS                     # full VLAN registry dict
  ZONE_VLAN                 # fw4 zone name → VLAN ID
"""

import json
import os
import sys
import time
import threading

# ── VLAN registry — loaded from gitignored vlans.yaml ──
# JP-specific data (labels, zones, statuses) lives in vlans.yaml at the repo
# root. The schema and a starter example live in vlans.yaml.example. If
# vlans.yaml is missing the firewall plugin still loads, but VLANS / ZONE_VLAN
# are empty and the /firewall response will report no VLAN metadata.
#
# The fw4 zone-name quirk (e.g. on gatekeeper the "lan" zone is actually IoT
# VLAN 10) is encoded per-entry via the optional `zone:` key — `ZONE_VLAN`
# is derived from yaml entries that declare one.

_VLANS_YAML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vlans.yaml")


def _load_vlan_registry(path=_VLANS_YAML):
    """Load (VLANS, ZONE_VLAN, _REPORT_ZONES, _WAN_ZONES) from vlans.yaml.

    On any failure returns empty structures and prints a warning to stderr —
    the firewall plugin can still load, the VLAN table just stays empty.
    """
    try:
        from ruamel.yaml import YAML
    except ImportError:
        print("[firewall_parser] ruamel.yaml not installed; VLAN registry empty", file=sys.stderr)
        return {}, {}, (), ()
    if not os.path.exists(path):
        print(f"[firewall_parser] {path} missing; copy vlans.yaml.example to vlans.yaml", file=sys.stderr)
        return {}, {}, (), ()
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = YAML(typ="safe").load(f) or {}
    except Exception as e:
        print(f"[firewall_parser] failed to parse {path}: {e}", file=sys.stderr)
        return {}, {}, (), ()

    raw = doc.get("vlans", {}) or {}
    vlans = {}
    zone_vlan = {}
    for vid, entry in raw.items():
        try:
            vid_int = int(vid)
        except (TypeError, ValueError):
            continue
        entry = dict(entry or {})
        zone = entry.pop("zone", None)
        vlans[vid_int] = {
            "label": entry.get("label", f"VLAN {vid_int}"),
            "type": entry.get("type", "lan"),
            "status": entry.get("status", "active"),
            "desc": entry.get("desc", ""),
            "icon": entry.get("icon", ""),
        }
        if zone:
            zone_vlan[zone] = vid_int

    for wan_zone in doc.get("wan_zones", []) or []:
        zone_vlan.setdefault(wan_zone, None)

    report_zones = tuple(
        z for z, v in zone_vlan.items()
        if v is not None
        and vlans.get(v, {}).get("type") == "lan"
        and vlans.get(v, {}).get("status") == "active"
    )
    wan_zones = tuple(z for z, v in zone_vlan.items() if v is None)
    return vlans, zone_vlan, report_zones, wan_zones


VLANS, ZONE_VLAN, _REPORT_ZONES, _WAN_ZONES = _load_vlan_registry()

# Reverse: VLAN ID → fw4 zone name (only LAN-side entries)
VLAN_ZONE = {v: k for k, v in ZONE_VLAN.items() if v is not None}

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
