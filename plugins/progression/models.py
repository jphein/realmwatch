"""Plugin-local progression dataclasses + level math.

Ported from os.realm.watch/servers/shared/models.py (Player + XpEvent
dataclasses, xp_for_level, level_from_xp). Other plugins (realm-engine,
quest-forge, etc.) carry their own slices of models.py.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


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
# L1=0, L2=100, L3=300, L4=600, L5=1000, L6=1500, L7=2100, L8=2800, L9=3600, L10=4500
def xp_for_level(level: int) -> int:
    """Total XP required to reach a given level."""
    return sum(100 * i for i in range(1, level))


def level_from_xp(total_xp: int) -> int:
    """Calculate level from total XP (quadratic scaling)."""
    level = 1
    while xp_for_level(level + 1) <= total_xp:
        level += 1
    return level
