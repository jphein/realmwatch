"""combat-ward MCP tool registry.

Five tools ported verbatim from os.realm.watch/servers/combat_ward/mcp.py.
Tuples are (name, callable, description) so the mcp plugin (Wave 1.5 wiring)
can register them with the FastMCP server without per-plugin glue code.
"""
from __future__ import annotations

from . import server


def _active_threats(limit: int = 20) -> list[dict]:
    """List recent threat events in the realm (severity >= 3)."""
    return server.get_active_threats(limit=limit)


def _cast_ward(
    action_type: str,
    entity_id: str | None = None,
    quest_id: str | None = None,
    action_class: str = "suggest",
    target_ip: str | None = None,
) -> dict:
    """Propose a defensive ward. Policy-checked before recording."""
    return server.propose_action(
        entity_id=entity_id,
        quest_id=quest_id,
        action_type=action_type,
        action_class=action_class,
        target_ip=target_ip,
    )


def _encounter_status(quest_id: str | None = None) -> list[dict]:
    """Get active threat encounters and their defense actions."""
    return server.get_encounter_status(quest_id=quest_id)


def _bestiary(threat_type: str | None = None):
    """Look up the realm bestiary — catalog of encountered threats."""
    return server.get_bestiary(threat_type=threat_type)


def _defense_report() -> dict:
    """Realm defense summary: wards, encounters, threat level."""
    return server.defense_report()


MCP_TOOLS = [
    ("active_threats", _active_threats,
     "List recent threat events in the realm (severity >= 3)."),
    ("cast_ward", _cast_ward,
     "Propose a defensive ward. Policy-checked before recording."),
    ("encounter_status", _encounter_status,
     "Get active threat encounters and their defense actions."),
    ("bestiary", _bestiary,
     "Look up the realm bestiary — catalog of encountered threats."),
    ("defense_report", _defense_report,
     "Realm defense summary: wards, encounters, threat level."),
]
