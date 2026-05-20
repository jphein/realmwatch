"""MCP tool wrappers for the progression plugin.

Wave 1.5 follow-up will import MCP_TOOLS into plugins/mcp/tools.py so they
become registered alongside the realmwatch core tools. For now this just
declares the surface so Wave 2 ships a complete plugin.

Each entry is (name, callable, description).
"""
from __future__ import annotations

from .server import (
    get_level_info,
    grant_achievement,
    grant_xp,
    get_skill_tree,
    list_player_skills,
    unlock_skill,
)


# ── Tool wrappers ─────────────────────────────────────────────────────────────
# Default args mirror servers/progression/mcp.py. Names use the `_tool`
# suffix used throughout os.realm.watch's MCP surface to avoid collisions
# with the underlying business functions.

def get_level_info_tool(player_id: str = "default") -> dict:
    """Get player level, XP, and progress to next level."""
    return get_level_info(player_id=player_id)


def grant_xp_tool(player_id: str = "default", amount: int = 0,
                  source_type: str = "manual", quest_id: str | None = None) -> dict:
    """Grant XP to a player. Idempotent per (player, quest, source_type)."""
    return grant_xp(player_id=player_id, amount=amount,
                    source_type=source_type, quest_id=quest_id)


def skill_tree_tool(tree: str = "networking") -> list[dict]:
    """View a skill tree (networking, security, systems, arcana)."""
    return get_skill_tree(tree=tree)


def unlock_skill_tool(player_id: str = "default", skill_id: str = "") -> dict:
    """Unlock a skill. Checks level requirement and prerequisites."""
    return unlock_skill(player_id=player_id, skill_id=skill_id)


def grant_achievement_tool(player_id: str = "default", achievement_id: str = "") -> dict:
    """Grant an achievement to a player. Idempotent, awards XP on first unlock."""
    return grant_achievement(player_id=player_id, achievement_id=achievement_id)


def list_player_skills_tool(player_id: str = "default") -> list[dict]:
    """List all skills a player has unlocked (joined with skill metadata)."""
    return list_player_skills(player_id=player_id)


# Registry consumed by plugins/mcp/tools.py once Wave 1.5 wires per-plugin
# tool collection. Tuple shape: (name, fn, description).
MCP_TOOLS: list[tuple[str, object, str]] = [
    ("get_level_info", get_level_info_tool,
     "Get a player's level, total XP, and progress to next level."),
    ("grant_xp", grant_xp_tool,
     "Grant XP to a player (idempotent per player/quest/source_type pair)."),
    ("skill_tree", skill_tree_tool,
     "View a skill tree (networking | security | systems | arcana)."),
    ("unlock_skill", unlock_skill_tool,
     "Unlock a skill for a player. Checks level + prerequisite gates."),
    ("grant_achievement", grant_achievement_tool,
     "Grant an achievement to a player. Idempotent; awards bonus XP on first unlock."),
    ("list_player_skills", list_player_skills_tool,
     "List skills a player has unlocked, joined with skill metadata."),
]
