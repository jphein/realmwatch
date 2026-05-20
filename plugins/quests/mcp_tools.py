"""MCP tool registrations for the Quest Forge plugin.

Wave 1.5 will wire MCP_TOOLS into `plugins/mcp/tools.py` automatically.
For now the list lives here in the canonical shape:
    MCP_TOOLS = [(name, fn, description), ...]
"""

from __future__ import annotations

from . import db as quest_db
from . import server as quest_server


_DB_PATH = quest_db.DEFAULT_DB_PATH


def list_quests(status: str | None = None, limit: int = 20) -> list[dict]:
    """List quests from the realm Quest Forge.

    Args:
        status: Optional filter — created, active, resolved, debriefed,
                rewarded, archived.
        limit:  Max rows returned (default 20, newest first).
    """
    return quest_server.list_quests(db_path=_DB_PATH, status=status, limit=limit)


def get_quest(quest_id: str) -> dict | None:
    """Get a single quest by ID from the realm Quest Forge."""
    return quest_server.get_quest(db_path=_DB_PATH, quest_id=quest_id)


def accept_quest(quest_id: str) -> dict:
    """Accept a quest (transition from `created` to `active`)."""
    return quest_server.activate_quest(db_path=_DB_PATH, quest_id=quest_id)


def complete_quest(quest_id: str) -> dict:
    """Mark a quest resolved.

    If the target is a sub-quest, also auto-resolves the parent once all
    siblings are complete.
    """
    row = quest_server.get_quest(db_path=_DB_PATH, quest_id=quest_id)
    if row and row.get("parent_quest_id"):
        return quest_server.complete_sub_quest(db_path=_DB_PATH, quest_id=quest_id)
    return quest_server.resolve_quest(db_path=_DB_PATH, quest_id=quest_id)


def generate_quest_from_event(event_id: str) -> dict | None:
    """Generate a quest from an event row stored in game.db's events table.

    Returns None if below severity threshold (2) or throttled (15 min
    cooldown per event_type + node).
    """
    return quest_server.generate_quest_from_event(db_path=_DB_PATH, event_id=event_id)


# Registry consumed by plugins/mcp/tools.py (per Wave 2 convention).
MCP_TOOLS = [
    ("list_quests", list_quests,
        "List quests from the realm Quest Forge (filter by status, limit count)."),
    ("get_quest", get_quest,
        "Get a single quest by ID from the realm Quest Forge."),
    ("accept_quest", accept_quest,
        "Accept a quest — transitions it from `created` to `active`."),
    ("complete_quest", complete_quest,
        "Mark a quest resolved (cascades to parent if it's a sub-quest)."),
    ("generate_quest_from_event", generate_quest_from_event,
        "Generate a quest from a game.db event row, applying templates + throttle."),
]
