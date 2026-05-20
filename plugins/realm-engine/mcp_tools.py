"""realm-engine MCP tool exports.

Wave 1.5 follow-up will wire MCP_TOOLS into plugins/mcp/tools.py — for now
this file is the source of truth for the 7 tools the original
os.realm.watch/servers/realm_engine/mcp.py exposed.

Each entry: (name, callable, description).
"""
from __future__ import annotations

from dataclasses import asdict

from . import server


# ── Tool wrappers ────────────────────────────────────────────────────────
# The original mcp.py wrapped server.py functions in thin tool functions
# that don't accept db_path (it's defaulted). We preserve that contract.


def realm_status_tool() -> dict:
    """Get realm overview: event count, entity count, active quests, player level."""
    return server.realm_status()


def get_profile_tool(player_id: str = "default") -> dict:
    """Get or create the player profile."""
    return server.get_profile(player_id=player_id)


def update_profile_tool(
    player_id: str = "default",
    player_name: str | None = None,
    player_class: str | None = None,
) -> dict:
    """Update player profile (name, class)."""
    return server.update_profile(
        player_id=player_id,
        player_name=player_name,
        player_class=player_class,
    )


def list_entities_tool(status: str = "active") -> list[dict]:
    """List all known entities (network devices) in the realm."""
    return server.list_entities(status=status)


def get_entity_tool(entity_id: str) -> dict | None:
    """Get a specific entity by ID."""
    e = server.get_entity(entity_id=entity_id)
    return asdict(e) if e else None


def recent_events_tool(limit: int = 20, min_severity: int = 0) -> list[dict]:
    """Get the most recent realm events.

    Use min_severity to filter noise (0=all, 2+=notable, 4+=threats).
    """
    return server.get_recent_events(limit=limit, min_severity=min_severity)


def ingest_event_tool(
    event_type: str,
    source_system: str = "manual",
    severity: int = 2,
    confidence: int = 70,
    payload: dict | None = None,
) -> dict:
    """Manually ingest a realm event."""
    return server.ingest_event(
        event_type=event_type,
        source_system=source_system,
        severity=severity,
        confidence=confidence,
        payload=payload,
    )


# ── Registry ─────────────────────────────────────────────────────────────

MCP_TOOLS: list[tuple[str, callable, str]] = [
    (
        "realm_status_tool",
        realm_status_tool,
        "Get realm overview: event count, entity count, active quests, player level.",
    ),
    (
        "get_profile_tool",
        get_profile_tool,
        "Get or create the player profile.",
    ),
    (
        "update_profile_tool",
        update_profile_tool,
        "Update player profile (name, class).",
    ),
    (
        "list_entities_tool",
        list_entities_tool,
        "List all known entities (network devices) in the realm.",
    ),
    (
        "get_entity_tool",
        get_entity_tool,
        "Get a specific entity by ID.",
    ),
    (
        "recent_events_tool",
        recent_events_tool,
        "Get the most recent realm events. Use min_severity to filter noise.",
    ),
    (
        "ingest_event_tool",
        ingest_event_tool,
        "Manually ingest a realm event.",
    ),
]
