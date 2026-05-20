"""Data models for the Truth Model v1.

These are transfer objects — not ORM. Each maps to a database table
but construction/persistence is handled by the owning MCP server.
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Event:
    event_id: str
    event_type: str
    source_system: str
    dedupe_key: str
    severity: int
    confidence: int
    timestamp_observed: int
    timestamp_ingested: int
    raw_payload_json: str
    normalized_payload_json: str
    entity_id: Optional[str] = None
    correlation_id: Optional[str] = None
    replay_flag: int = 0
    processed: int = 0
    schema_version: int = 1


@dataclass
class Entity:
    entity_id: str
    entity_type: str
    identity_confidence: int
    first_seen_ts: int
    last_seen_ts: int
    canonical_name: Optional[str] = None
    mac_primary: Optional[str] = None
    ipv4_last: Optional[str] = None
    ipv6_last: Optional[str] = None
    vlan_id: Optional[int] = None
    ap_bssid: Optional[str] = None
    manufacturer: Optional[str] = None
    os_fingerprint: Optional[str] = None
    service_fingerprint: Optional[str] = None
    user_label: Optional[str] = None
    infrastructure_flag: int = 0
    merge_parent_id: Optional[str] = None
    status: str = "active"
    schema_version: int = 1


# Quest lifecycle states (forward-only)
QUEST_STATES = ["detected", "correlated", "created", "active", "resolved", "debriefed", "rewarded", "archived"]


@dataclass
class Quest:
    quest_id: str
    quest_type: str
    title: str
    dedupe_key: str
    created_ts: int
    severity: int = 0
    status: str = "detected"
    source_event_id: Optional[str] = None
    correlation_id: Optional[str] = None
    entity_id: Optional[str] = None
    technical_label: Optional[str] = None
    description: Optional[str] = None
    hints_json: str = "[]"
    debrief_json: Optional[str] = None
    xp_reward: int = 100
    activated_ts: Optional[int] = None
    resolved_ts: Optional[int] = None
    debriefed_ts: Optional[int] = None
    rewarded_ts: Optional[int] = None
    archived_ts: Optional[int] = None
    replay_flag: int = 0
    schema_version: int = 1

    def can_transition_to(self, new_state: str) -> bool:
        """Check if transition is valid (forward-only)."""
        if new_state not in QUEST_STATES:
            return False
        current_idx = QUEST_STATES.index(self.status)
        new_idx = QUEST_STATES.index(new_state)
        return new_idx > current_idx


@dataclass
class Player:
    player_id: str
    created_ts: int
    player_name: Optional[str] = None
    player_class: str = "watcher"
    last_active_ts: Optional[int] = None
    total_xp: int = 0
    level: int = 1
    schema_version: int = 1


@dataclass
class XpEvent:
    xp_event_id: str
    player_id: str
    xp_amount: int
    granted_ts: int
    quest_id: Optional[str] = None
    source_type: Optional[str] = None
    replay_flag: int = 0


# XP required per level: level N requires sum(100 * i for i in range(1, N))
def xp_for_level(level: int) -> int:
    """Total XP required to reach a given level."""
    return sum(100 * i for i in range(1, level))


def level_from_xp(total_xp: int) -> int:
    """Calculate level from total XP."""
    level = 1
    while xp_for_level(level + 1) <= total_xp:
        level += 1
    return level
