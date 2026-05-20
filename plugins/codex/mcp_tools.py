"""MCP tools exposed by the codex plugin.

Per Wave 2 convention: each tool is a tuple of (name, fn, description).
The mcp plugin's Wave 1.5 follow-up will wire these into plugins/mcp/tools.py
automatically. For now this file is the registry of intent.

These are the five tools previously exposed by os.realm.watch's lore-keeper
FastMCP server (servers/lore_keeper/mcp.py).
"""
from __future__ import annotations

from typing import Optional

from .server import (
    add_journal_entry,
    get_chronicles,
    get_codex_entry,
    get_journal,
    get_node_lore,
    set_node_lore,
)


def lookup_lore_tool(codex_id: Optional[str] = None,
                     category: Optional[str] = None) -> dict | list[dict]:
    """Look up the realm codex. By ID for one entry, by category for a group, or no args for all."""
    return get_codex_entry(codex_id=codex_id, category=category)


def node_lore_tool(entity_id: str,
                   backstory: Optional[str] = None,
                   personality: Optional[str] = None) -> dict:
    """Get or set lore for a realm node. Pass backstory to create/update."""
    if backstory:
        return set_node_lore(entity_id=entity_id, backstory=backstory,
                             personality=personality)
    found = get_node_lore(entity_id=entity_id)
    return found if found is not None else {"error": "No lore found for this entity"}


def chronicles_tool(limit: int = 20) -> list[dict]:
    """Read the realm chronicles — historical event narratives, newest first."""
    return get_chronicles(limit=limit)


def journal_tool(player_id: str = "default",
                 entry_type: Optional[str] = None,
                 limit: int = 20) -> list[dict]:
    """Read the player's discovery journal."""
    return get_journal(player_id=player_id, entry_type=entry_type, limit=limit)


def add_journal_tool(player_id: str = "default",
                     entry_type: str = "observation",
                     title: str = "",
                     content: str = "") -> dict:
    """Add an entry to the player's discovery journal."""
    return add_journal_entry(player_id=player_id, entry_type=entry_type,
                             title=title, content=content)


# Registry consumed by plugins/mcp/tools.py (Wave 4 wiring).
# Tuple shape: (tool_name, callable, one-line description).
TOOLS: list[tuple] = [
    ("lookup_lore", lookup_lore_tool,
     "Look up the realm codex (by id, by category, or all)."),
    ("node_lore", node_lore_tool,
     "Get or set per-entity backstory + personality."),
    ("chronicles", chronicles_tool,
     "Read recent chronicles (historical event narratives)."),
    ("journal", journal_tool,
     "Read a player's discovery journal."),
    ("add_journal", add_journal_tool,
     "Append an entry to a player's discovery journal."),
]
