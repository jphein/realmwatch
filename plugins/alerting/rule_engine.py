"""Rule engine — matches events to notification channels.

Rules are ordered by priority, first-match-wins. Each rule specifies:
- conditions: event_types, severity, node_pattern
- channels: list of channel names to fire
- cooldown: seconds before same event can fire on same channel again
"""

import fnmatch
import logging
import time
import threading

log = logging.getLogger(__name__)

# ── Severity Detection ──

def detect_severity(event):
    """Compute severity from event data."""
    color = event.get("color", "")
    status = event.get("status", "")
    event_type = event.get("type", "")

    if color == "#ff4040" or status == "failed":
        return "critical"
    if color == "#ffaa00" or status == "stopped":
        return "warning"
    if event_type == "alert":
        return "warning"
    return "info"


# ── Cooldown Tracker ──

class CooldownTracker:
    """Track per-event-per-channel cooldowns."""

    def __init__(self):
        self._times = {}  # (event_key, channel) -> last_fire_ts
        self._lock = threading.Lock()

    def _event_key(self, event):
        """Generate a dedup key for an event."""
        return (event.get("type", ""), event.get("node", ""), event.get("text", "")[:50])

    def can_fire(self, event, channel, cooldown_seconds):
        """Check if this event can fire on this channel (not in cooldown)."""
        key = (self._event_key(event), channel)
        now = time.time()
        with self._lock:
            last = self._times.get(key, 0)
            if now - last < cooldown_seconds:
                return False
            self._times[key] = now
            return True

    def cleanup(self, max_age=3600):
        """Remove expired entries."""
        cutoff = time.time() - max_age
        with self._lock:
            self._times = {k: v for k, v in self._times.items() if v > cutoff}


# ── Rule Matching ──

DEFAULT_RULES = [
    {
        "id": "default-critical",
        "name": "Critical alerts → all channels",
        "enabled": True,
        "priority": 1,
        "conditions": {"event_types": ["alert"], "severity": ["critical"], "node_pattern": "*"},
        "channels": ["email", "webhook", "desktop", "voice", "pushover"],
        "cooldown": 300,
    },
    {
        "id": "default-warning",
        "name": "Warnings → local + webhook",
        "enabled": True,
        "priority": 2,
        "conditions": {"event_types": ["alert"], "severity": ["warning"], "node_pattern": "*"},
        "channels": ["desktop", "webhook", "voice"],
        "cooldown": 300,
    },
    {
        "id": "default-discovery-fail",
        "name": "Discovery failures → desktop + webhook",
        "enabled": True,
        "priority": 3,
        "conditions": {"event_types": ["discovery"], "severity": ["critical", "warning"], "node_pattern": "*"},
        "channels": ["desktop", "webhook"],
        "cooldown": 600,
    },
    {
        "id": "default-ha",
        "name": "HA state changes → toast",
        "enabled": True,
        "priority": 4,
        "conditions": {"event_types": ["speech"], "severity": ["info"], "node_pattern": "ha"},
        "channels": ["sse_toast"],
        "cooldown": 60,
    },
    {
        "id": "default-catchall",
        "name": "Everything else → toast",
        "enabled": True,
        "priority": 5,
        "conditions": {"event_types": ["*"], "severity": ["*"], "node_pattern": "*"},
        "channels": ["sse_toast"],
        "cooldown": 30,
    },
]


def match_rule(event, rule, severity):
    """Check if an event matches a rule's conditions.

    Supported conditions:
      event_types: list of event type strings, or ["*"] for any
      severity:    list of severity strings, or ["*"] for any
      node_pattern: fnmatch glob against event.node ("*" = any)
      roles:        list of role names; matches if event.node's role is in
                    the list (Zabbix-inspired, issue #3). Falls back to
                    node_pattern when the role registry isn't available.
      tags:         list of tag strings; matches if event.node carries any
                    of these tags
    """
    if not rule.get("enabled", True):
        return False

    cond = rule.get("conditions", {})

    # Event type match
    event_types = cond.get("event_types", ["*"])
    if "*" not in event_types and event.get("type", "") not in event_types:
        return False

    # Severity match
    severities = cond.get("severity", ["*"])
    if "*" not in severities and severity not in severities:
        return False

    # Node pattern match (fnmatch glob)
    node_pattern = cond.get("node_pattern", "*")
    if node_pattern != "*":
        node = event.get("node", "")
        if not fnmatch.fnmatch(node, node_pattern):
            return False

    # Role match (Zabbix-inspired, issue #3): rule fires only on hosts with
    # one of the listed roles. Role lookup uses node_roles which consults
    # node.data.os, _role, OUI hints, etc.
    roles = cond.get("roles", [])
    if roles:
        node_id = event.get("node", "")
        if not node_id:
            return False
        try:
            import node_roles
            import realm_db
            # Need the node's full data dict, not just the id, so role
            # inference can use OS/type/MAC. realm_db.get_nodes() is cached
            # via the WAL-mode SQLite layer; this isn't a hot loop.
            nodes_by_id = {n.get("id", ""): n for n in realm_db.get_nodes()}
            node_data = nodes_by_id.get(node_id, {"id": node_id})
            actual_role = node_roles.get_role(node_id, node_data)
            if actual_role not in roles:
                return False
        except Exception:
            # If anything goes wrong looking up the role, fail open: match
            # rather than silently drop alerts. Failures get logged elsewhere.
            log.warning("role lookup failed for %s; matching rule conservatively", node_id)

    # Tag match: rule fires if the node carries any of the listed tags
    tags = cond.get("tags", [])
    if tags:
        node_id = event.get("node", "")
        if not node_id:
            return False
        try:
            import realm_db
            nodes_by_id = {n.get("id", ""): n for n in realm_db.get_nodes()}
            node_tags = nodes_by_id.get(node_id, {}).get("tags", []) or []
            if not any(t in node_tags for t in tags):
                return False
        except Exception:
            log.warning("tag lookup failed for %s; matching rule conservatively", node_id)

    return True


def evaluate(event, rules):
    """Evaluate event against rules. Returns (matched_rule, channels, cooldown) or (None, [], 0).

    First-match-wins on the sorted rule list.
    """
    severity = detect_severity(event)

    # Sort by priority (lower = higher priority)
    sorted_rules = sorted(rules, key=lambda r: r.get("priority", 999))

    for rule in sorted_rules:
        if match_rule(event, rule, severity):
            return rule, rule.get("channels", []), rule.get("cooldown", 300)

    return None, [], 0
