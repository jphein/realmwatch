"""Quest data model — dataclass + state machine constants.

Migrated from os.realm.watch/servers/shared/models.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# Quest lifecycle states (forward-only)
QUEST_STATES = ["detected", "correlated", "created", "active", "resolved",
                "debriefed", "rewarded", "archived"]


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
    parent_quest_id: Optional[str] = None
    actions_json: str = "[]"
    node: Optional[str] = None
    sort_order: int = 0
    schema_version: int = 1

    def can_transition_to(self, new_state: str) -> bool:
        """Check if transition is valid (forward-only)."""
        if new_state not in QUEST_STATES:
            return False
        current_idx = QUEST_STATES.index(self.status)
        new_idx = QUEST_STATES.index(new_state)
        return new_idx > current_idx
