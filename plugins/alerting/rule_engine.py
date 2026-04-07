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
    """Check if an event matches a rule's conditions."""
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
