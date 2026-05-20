"""Chronicle hooks — auto-generate chronicle entries from game lifecycle events.

Ported from os.realm.watch/servers/shared/chronicle_hooks.py.

Wave 3 migration notes:
- `from servers.shared.db import DEFAULT_DB_PATH` -> `from .db import DEFAULT_DB_PATH`
- `from servers.lore_keeper.server import add_chronicle` -> `from .server import add_chronicle`

These are exposed via plugin.expose_api() so progression and quest-forge can
call them without a hard import. The contract matches what progression's
server.py expects in _chronicle_*() helpers.
"""
from __future__ import annotations

from typing import Optional

from .db import DEFAULT_DB_PATH
from .server import add_chronicle


def chronicle_quest_completed(db_path: str = DEFAULT_DB_PATH,
                              quest_title: str = "",
                              quest_description: str = "",
                              event_id: Optional[str] = None) -> dict:
    """Record a chronicle when a quest is resolved."""
    summary = (quest_description.split(".")[0].rstrip()
               if quest_description else "details unknown")
    narrative = f"The Watcher resolved {quest_title} — {summary}."
    return add_chronicle(db_path,
                         event_id=event_id,
                         title=f"Quest Complete: {quest_title}",
                         narrative=narrative)


def chronicle_xp_granted(db_path: str = DEFAULT_DB_PATH,
                         amount: int = 0,
                         quest_title: str = "",
                         source_type: str = "") -> dict:
    """Record a chronicle when XP is granted."""
    if quest_title:
        narrative = f"Experience gained: {amount} XP for completing {quest_title}."
    else:
        narrative = f"Experience gained: {amount} XP ({source_type})."
    return add_chronicle(db_path,
                         title=f"+{amount} XP",
                         narrative=narrative)


def chronicle_level_up(db_path: str = DEFAULT_DB_PATH,
                       player_name: str = "The Watcher",
                       new_level: int = 0) -> dict:
    """Record a chronicle when the player levels up."""
    narrative = (f"{player_name} ascended to Level {new_level}. "
                 "New powers stir within the realm.")
    return add_chronicle(db_path,
                         title=f"Level {new_level} Attained",
                         narrative=narrative)


def chronicle_achievement_unlocked(db_path: str = DEFAULT_DB_PATH,
                                   achievement_name: str = "",
                                   player_name: str = "The Watcher") -> dict:
    """Record a chronicle when an achievement is unlocked."""
    narrative = f"{player_name} earned the achievement: {achievement_name}."
    return add_chronicle(db_path,
                         title=f"Achievement: {achievement_name}",
                         narrative=narrative)
