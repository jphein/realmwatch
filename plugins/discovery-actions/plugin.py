"""The Onboarding Sigils — declarative discovery actions.

When a new node appears (via realm discover-os, agent registration, or the
discovery engine spotting it for the first time), action rules evaluate
against the node's metadata and apply operations: assign a role, set tags,
attach discovery providers, write settings.

Zabbix-inspired (issue #10). Replaces the ad-hoc heuristics inside
node_roles.enrich_unknown_node with operator-visible declarative rules.
The heuristics stay as the fallback when no action matches.

Match conditions (any combination, AND-joined):
  subnet:        "10.0.6.0/24"        — IP in this CIDR
  oui_prefix:    "00:11:22"           — MAC OUI matches (case-insensitive)
  hostname_glob: "*-pi-*"             — fnmatch on hostname
  os:            ["ubuntu","debian"]  — node.data.os in list
  tag_any:       ["lab","prod"]       — any of these tags present
  tag_all:       ["linux","apt"]      — all of these tags present
  type:          ["core","infra"]     — node.data.type in list

Operations (each is idempotent):
  set_role:      "router"
  add_tags:      ["managed","lab"]
  remove_tags:   ["unknown"]
  set_settings:  {ns: "auto-onboard", key: "v", value: "..."}
  add_to_region: "north"
"""

import fnmatch
import ipaddress
import json
import logging
import time
import uuid

import realm_db

log = logging.getLogger(__name__)

_ctx = None
_db = None


# ── Default seeded actions (illustrative; operator-editable) ──

_DEFAULT_ACTIONS = [
    {
        "id": "openwrt-by-oui",
        "name": "Auto-tag OpenWrt routers by OUI",
        "enabled": 1,
        "priority": 10,
        "conditions": {
            "oui_prefix": "C8:3A:35,00:0C:43,C0:8B:6F",
            "type": ["tower", "router", "ap"]
        },
        "operations": {
            "add_tags": ["openwrt", "managed-by-realm"],
            "set_role": "ap",
        }
    },
    {
        "id": "ubuntu-fleet-tag",
        "name": "Tag every Ubuntu host as autoupdate-eligible",
        "enabled": 1,
        "priority": 20,
        "conditions": {"os": ["ubuntu", "debian"]},
        "operations": {"add_tags": ["autoupdate"]},
    },
    {
        "id": "raspi-by-hostname",
        "name": "Mark Raspberry Pi hosts",
        "enabled": 1,
        "priority": 30,
        "conditions": {"hostname_glob": "*pi*"},
        "operations": {
            "add_tags": ["raspi", "arm"],
            "set_role": "server",
        },
    },
    {
        "id": "iot-vlan-tag",
        "name": "VLAN-8 nodes get 'iot' tag",
        "enabled": 1,
        "priority": 40,
        "conditions": {"subnet": "10.0.8.0/24"},
        "operations": {"add_tags": ["iot"]},
    },
]


# ── DB ──

def _init_table():
    _db.create_table(
        "actions",
        """
        id          TEXT PRIMARY KEY,
        name        TEXT,
        enabled     INTEGER DEFAULT 1,
        priority    INTEGER DEFAULT 100,
        conditions  TEXT DEFAULT '{}',
        operations  TEXT DEFAULT '{}'
        """,
    )


def _seed_defaults():
    existing = _db.query("SELECT id FROM plugin_discovery_actions_actions")
    if existing:
        return
    for a in _DEFAULT_ACTIONS:
        _db.execute(
            "INSERT INTO plugin_discovery_actions_actions "
            "(id, name, enabled, priority, conditions, operations) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (a["id"], a["name"], a["enabled"], a["priority"],
             json.dumps(a["conditions"]), json.dumps(a["operations"]))
        )
    log.info("Seeded %d default discovery actions", len(_DEFAULT_ACTIONS))


def _list_actions(enabled_only=False):
    where = " WHERE enabled = 1" if enabled_only else ""
    rows = _db.query(
        f"SELECT id, name, enabled, priority, conditions, operations "
        f"FROM plugin_discovery_actions_actions{where} ORDER BY priority"
    )
    out = []
    for r in rows:
        try:
            cond = json.loads(r.get("conditions") or "{}")
        except (json.JSONDecodeError, TypeError):
            cond = {}
        try:
            ops = json.loads(r.get("operations") or "{}")
        except (json.JSONDecodeError, TypeError):
            ops = {}
        out.append({
            "id": r["id"],
            "name": r.get("name") or "",
            "enabled": bool(r.get("enabled", 1)),
            "priority": r.get("priority") or 100,
            "conditions": cond,
            "operations": ops,
            "match_summary": _summarize_conditions(cond),
        })
    return out


def _summarize_conditions(cond: dict) -> str:
    bits = []
    if "subnet" in cond:        bits.append(f"subnet={cond['subnet']}")
    if "oui_prefix" in cond:    bits.append(f"oui={cond['oui_prefix']}")
    if "hostname_glob" in cond: bits.append(f"host~{cond['hostname_glob']}")
    if "os" in cond:            bits.append(f"os∈{cond['os']}")
    if "tag_any" in cond:       bits.append(f"tag_any={cond['tag_any']}")
    if "tag_all" in cond:       bits.append(f"tag_all={cond['tag_all']}")
    if "type" in cond:          bits.append(f"type∈{cond['type']}")
    return ", ".join(bits) or "(no conditions — matches all)"


# ── Condition evaluation ──

def _matches(cond: dict, node: dict) -> bool:
    if not cond:
        return True

    # Subnet
    if "subnet" in cond:
        try:
            net = ipaddress.ip_network(cond["subnet"], strict=False)
            ip = node.get("ip") or ""
            if not ip or ipaddress.ip_address(ip) not in net:
                return False
        except (ValueError, TypeError):
            return False

    # OUI prefix (comma-separated list)
    if "oui_prefix" in cond:
        mac = (node.get("mac") or "").upper().replace("-", ":")
        prefixes = [p.strip().upper().replace("-", ":")
                    for p in cond["oui_prefix"].split(",") if p.strip()]
        if not any(mac.startswith(p) for p in prefixes):
            return False

    # Hostname glob
    if "hostname_glob" in cond:
        hostname = node.get("id") or ""
        if not fnmatch.fnmatch(hostname, cond["hostname_glob"]):
            return False

    # OS list
    if "os" in cond:
        os_id = (node.get("os") or "").lower()
        os_list = [o.lower() for o in (cond["os"] if isinstance(cond["os"], list) else [cond["os"]])]
        if os_id not in os_list:
            return False

    # Tag any
    if "tag_any" in cond:
        node_tags = set(node.get("tags") or [])
        want = set(cond["tag_any"])
        if not (node_tags & want):
            return False

    # Tag all
    if "tag_all" in cond:
        node_tags = set(node.get("tags") or [])
        want = set(cond["tag_all"])
        if not want.issubset(node_tags):
            return False

    # Type list
    if "type" in cond:
        node_type = (node.get("type") or "").lower()
        type_list = [t.lower() for t in (cond["type"] if isinstance(cond["type"], list) else [cond["type"]])]
        if node_type not in type_list:
            return False

    return True


# ── Operation application ──

def _apply_operations(ops: dict, node: dict) -> list[str]:
    """Apply operations to node dict in-place, returning a list of changes."""
    changes = []

    if "set_role" in ops:
        role = ops["set_role"]
        if node.get("_role") != role:
            node["_role"] = role
            changes.append(f"_role={role}")

    if "add_tags" in ops:
        existing = set(node.get("tags") or [])
        new = set(ops["add_tags"])
        merged = existing | new
        if merged != existing:
            node["tags"] = sorted(merged)
            changes.append(f"+tags:{sorted(new - existing)}")

    if "remove_tags" in ops:
        existing = set(node.get("tags") or [])
        rm = set(ops["remove_tags"])
        merged = existing - rm
        if merged != existing:
            node["tags"] = sorted(merged)
            changes.append(f"-tags:{sorted(rm & existing)}")

    if "set_settings" in ops:
        ss = ops["set_settings"]
        ns = ss.get("ns", "auto-onboard")
        key = ss.get("key")
        val = ss.get("value")
        if key:
            realm_db.set_settings(ns, {key: val})
            changes.append(f"settings[{ns}.{key}]={val}")

    if "add_to_region" in ops:
        node["region"] = ops["add_to_region"]
        changes.append(f"region={ops['add_to_region']}")

    return changes


# ── Public API: evaluate against a node ──

def evaluate_node(node_id: str, dry_run: bool = False) -> dict:
    """Evaluate every enabled action against a node. Returns a result dict."""
    node = realm_db.get_node(node_id)
    if not node:
        return {"error": f"no such node: {node_id}"}

    results = []
    cumulative_changes = []
    for action in _list_actions(enabled_only=True):
        matched = _matches(action["conditions"], node)
        entry = {
            "action_id": action["id"],
            "name": action["name"],
            "matched": matched,
            "would_apply": action["operations"] if matched else None,
            "changes": [],
        }
        if matched and not dry_run:
            ch = _apply_operations(action["operations"], node)
            entry["changes"] = ch
            cumulative_changes.extend(ch)
        results.append(entry)

    if not dry_run and cumulative_changes:
        realm_db.set_node(node_id, node)
        log.info("discovery-actions: %s — %d change(s)", node_id, len(cumulative_changes))

    return {
        "node": node_id,
        "dry_run": dry_run,
        "results": results,
        "total_changes": len(cumulative_changes),
    }


# ── Hook: fire on new_entity / status_change → trigger evaluation ──

def _on_new_node_event(event):
    """Subscribed to system events with subtype='agent_registered' and
    discovery events of subtype='new'. When a fresh node appears, evaluate
    discovery actions against it.
    """
    node_id = event.get("node", "")
    subtype = event.get("subtype", "")
    if not node_id:
        return
    if subtype not in ("agent_registered", "new", "discovered"):
        return
    try:
        result = evaluate_node(node_id, dry_run=False)
        if result.get("total_changes", 0) > 0:
            log.info("auto-onboard %s: %d change(s)", node_id, result["total_changes"])
    except Exception:
        log.exception("discovery-actions evaluation failed for %s", node_id)


# ── HTTP handlers ──

def _h_list_actions(req, params):
    return req.respond({"actions": _list_actions()})


def _h_create_action(req, params):
    body = req.json() or {}
    aid = body.get("id") or f"act-{uuid.uuid4().hex[:8]}"
    name = body.get("name") or ""
    enabled = 1 if body.get("enabled", True) else 0
    priority = int(body.get("priority", 100))
    conditions = body.get("conditions") or {}
    operations = body.get("operations") or {}
    _db.execute(
        "INSERT OR REPLACE INTO plugin_discovery_actions_actions "
        "(id, name, enabled, priority, conditions, operations) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (aid, name, enabled, priority, json.dumps(conditions), json.dumps(operations))
    )
    return req.respond({"ok": True, "id": aid})


def _h_delete_action(req, params):
    aid = params.get("id", "")
    _db.execute("DELETE FROM plugin_discovery_actions_actions WHERE id = ?", (aid,))
    return req.respond({"ok": True, "deleted": aid})


def _h_test_node(req, params):
    """GET /discovery/actions/test/<node> — preview without writes."""
    node = params.get("node", "")
    return req.respond(evaluate_node(node, dry_run=True))


def _h_apply_node(req, params):
    """POST /discovery/actions/apply/<node> — re-run live against a node."""
    node = params.get("node", "")
    return req.respond(evaluate_node(node, dry_run=False))


# ── Setup ──

def setup(ctx):
    global _ctx, _db
    _ctx = ctx
    _db = ctx.db
    _init_table()
    _seed_defaults()

    ctx.register_endpoint("GET",    "/discovery/actions",                _h_list_actions,  raw_path=True)
    ctx.register_endpoint("POST",   "/discovery/actions",                _h_create_action, raw_path=True)
    ctx.register_endpoint("DELETE", "/discovery/actions/<id>",           _h_delete_action, raw_path=True)
    ctx.register_endpoint("GET",    "/discovery/actions/test/<node>",    _h_test_node,     raw_path=True)
    ctx.register_endpoint("POST",   "/discovery/actions/apply/<node>",   _h_apply_node,    raw_path=True)

    # Subscribe to events that signal a new/changed node — auto-onboard kicks
    # in when agent-register, discover-os, or the discovery engine spots one.
    ctx.on_event("system", _on_new_node_event)
    ctx.on_event("discovery", _on_new_node_event)

    ctx.log("The Onboarding Sigils are inscribed — discovery actions registered")
