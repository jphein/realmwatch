"""combat-ward — Threat detection, ward management, encounters, bestiary.

Owns: actions, action_policy_log, bestiary_entries, ward_templates rows in game.db.
Reads: events, entities, quests (all owned by realm-engine).

Migrated from os.realm.watch/servers/combat_ward/server.py 2026-05-19. Changes:
- DEFAULT_DB_PATH / get_connection come from the local plugin db helper.
- ulid() comes from realm_text (Reverie's Wave 1 port).
- check_policy() comes from the local plugin policy module.
"""
from __future__ import annotations

import json
import time

from realm_text import ulid

from .db import DEFAULT_DB_PATH, get_connection
from .policy import check_policy


_THREAT_EVENT_TYPES = frozenset({
    "port_scan", "brute_force", "dns_poisoning",
    "firewall_block", "ddos", "unknown_device",
})


def get_active_threats(db_path: str = DEFAULT_DB_PATH, limit: int = 20) -> list[dict]:
    """Get recent threat events (severity >= 3 and threat-related types)."""
    conn = get_connection(db_path)
    placeholders = ",".join("?" for _ in _THREAT_EVENT_TYPES)
    rows = conn.execute(
        f"SELECT * FROM events WHERE severity >= 3 AND event_type IN ({placeholders}) "
        "ORDER BY timestamp_observed DESC LIMIT ?",
        (*_THREAT_EVENT_TYPES, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def propose_action(
    db_path: str = DEFAULT_DB_PATH,
    quest_id: str | None = None,
    entity_id: str | None = None,
    action_type: str = "suggest",
    action_class: str = "suggest",
    target_ip: str | None = None,
    replay: bool = False,
) -> dict:
    """Propose a defensive action. Runs policy check first."""
    allowed, reason = check_policy(
        db_path, action_type, entity_id, action_class, target_ip, replay,
    )

    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    aid = ulid()

    confidence = None
    if entity_id:
        entity = conn.execute(
            "SELECT identity_confidence FROM entities WHERE entity_id=?",
            (entity_id,),
        ).fetchone()
        confidence = entity["identity_confidence"] if entity else None

    conn.execute(
        """INSERT INTO actions
        (action_id, quest_id, entity_id, action_type, action_class,
         policy_allowed, policy_reason, proposed_ts,
         result_status, entity_confidence_at_action, replay_flag, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1)""",
        (aid, quest_id, entity_id, action_type, action_class,
         1 if allowed else 0, reason, now_ms,
         "pending" if allowed else "denied", confidence,
         1 if replay else 0),
    )

    conn.execute(
        """INSERT INTO action_policy_log
        (action_id, rule_id, decision, reason, evaluated_ts)
        VALUES (?,?,?,?,?)""",
        (aid, "hard_constraints", "allow" if allowed else "deny", reason, now_ms),
    )

    conn.commit()
    row = conn.execute("SELECT * FROM actions WHERE action_id=?", (aid,)).fetchone()
    conn.close()
    return dict(row)


def approve_action(db_path: str = DEFAULT_DB_PATH, action_id: str = "") -> dict:
    """Player approves a proposed action."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    row = conn.execute("SELECT * FROM actions WHERE action_id=?",
                       (action_id,)).fetchone()
    if not row:
        conn.close()
        return {"error": f"Action {action_id} not found"}
    if row["result_status"] == "denied":
        conn.close()
        return {"error": "Cannot approve a denied action"}
    if row["result_status"] != "pending":
        conn.close()
        return {"error": f"Action already {row['result_status']}"}

    conn.execute(
        "UPDATE actions SET approved_ts=?, result_status='approved' WHERE action_id=?",
        (now_ms, action_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM actions WHERE action_id=?",
                       (action_id,)).fetchone()
    conn.close()
    return dict(row)


def execute_action(db_path: str = DEFAULT_DB_PATH, action_id: str = "") -> dict:
    """Execute an approved action. V1: records execution without real side effects."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    row = conn.execute("SELECT * FROM actions WHERE action_id=?",
                       (action_id,)).fetchone()
    if not row:
        conn.close()
        return {"error": f"Action {action_id} not found"}
    if row["result_status"] != "approved":
        conn.close()
        return {"error": f"Cannot execute — status is '{row['result_status']}', need 'approved'"}
    if row["replay_flag"]:
        conn.close()
        return {"error": "Replay actions cannot execute real effects"}

    conn.execute(
        "UPDATE actions SET executed_ts=?, result_status='executed', "
        "result_payload_json=? WHERE action_id=?",
        (now_ms, json.dumps({"v1": "simulated"}), action_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM actions WHERE action_id=?",
                       (action_id,)).fetchone()
    conn.close()
    return dict(row)


def get_encounter_status(
    db_path: str = DEFAULT_DB_PATH,
    quest_id: str | None = None,
) -> list[dict]:
    """Get active encounters — threat quests and their associated actions."""
    conn = get_connection(db_path)
    if quest_id:
        rows = conn.execute(
            "SELECT q.*, a.action_id, a.action_type, a.result_status AS action_status "
            "FROM quests q LEFT JOIN actions a ON q.quest_id = a.quest_id "
            "WHERE q.quest_id=?",
            (quest_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT q.*, a.action_id, a.action_type, a.result_status AS action_status "
            "FROM quests q LEFT JOIN actions a ON q.quest_id = a.quest_id "
            "WHERE q.status IN ('created','active') AND q.severity >= 3 "
            "ORDER BY q.created_ts DESC LIMIT 20",
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_bestiary(
    db_path: str = DEFAULT_DB_PATH,
    threat_type: str | None = None,
) -> dict | list[dict]:
    """Look up bestiary entries."""
    conn = get_connection(db_path)
    if threat_type:
        row = conn.execute(
            "SELECT * FROM bestiary_entries WHERE threat_type=?",
            (threat_type,),
        ).fetchone()
        conn.close()
        return dict(row) if row else {"error": f"Unknown threat type: {threat_type}"}
    rows = conn.execute(
        "SELECT * FROM bestiary_entries ORDER BY times_encountered DESC",
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def record_encounter(db_path: str = DEFAULT_DB_PATH, threat_type: str = "") -> dict:
    """Record a threat encounter. Updates bestiary counter and timestamps."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    row = conn.execute(
        "SELECT * FROM bestiary_entries WHERE threat_type=?",
        (threat_type,),
    ).fetchone()
    if not row:
        conn.close()
        return {"error": f"Unknown threat type: {threat_type}"}

    conn.execute(
        "UPDATE bestiary_entries SET times_encountered = times_encountered + 1, "
        "first_encountered_ts = COALESCE(first_encountered_ts, ?) WHERE threat_type=?",
        (now_ms, threat_type),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM bestiary_entries WHERE threat_type=?",
        (threat_type,),
    ).fetchone()
    conn.close()
    return dict(row)


# Event type → bestiary threat_type mapping (includes non-threat event types
# that map to bestiary creatures, e.g. resource exhaustion → swarm)
_EVENT_TO_BESTIARY = {
    "port_scan": "port_scan",
    "brute_force": "brute_force",
    "dns_poisoning": "dns_poisoning",
    "unknown_device": "unknown_device",
    "ddos": "ddos",
    "firewall_block": "port_scan",       # firewall blocks often follow scans
    "cpu_spike": "ddos",                  # resource exhaustion → swarm
    "memory_critical": "ddos",            # resource exhaustion → swarm
}


def update_bestiary(
    db_path: str = DEFAULT_DB_PATH,
    event_type: str = "",
    severity: int = 0,
) -> dict | None:
    """Auto-update bestiary when a threat-level event is ingested.

    Only fires for severity >= 3 events with a known bestiary mapping.
    Returns the updated bestiary entry, or None if no match.
    """
    if severity < 3:
        return None
    threat_type = _EVENT_TO_BESTIARY.get(event_type)
    if not threat_type:
        return None
    return record_encounter(db_path, threat_type)


def get_ward_templates(db_path: str = DEFAULT_DB_PATH) -> list[dict]:
    """List available ward templates."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT * FROM ward_templates ORDER BY severity_min",
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def defense_report(db_path: str = DEFAULT_DB_PATH) -> dict:
    """Realm defense summary: active wards, recent encounters, threat level."""
    conn = get_connection(db_path)
    pending = conn.execute(
        "SELECT COUNT(*) FROM actions WHERE result_status='pending'",
    ).fetchone()[0]
    executed = conn.execute(
        "SELECT COUNT(*) FROM actions WHERE result_status='executed'",
    ).fetchone()[0]
    denied = conn.execute(
        "SELECT COUNT(*) FROM actions WHERE result_status='denied'",
    ).fetchone()[0]

    day_ago = int((time.time() - 86400) * 1000)
    placeholders = ",".join("?" for _ in _THREAT_EVENT_TYPES)
    recent_threats = conn.execute(
        f"SELECT COUNT(*) FROM events WHERE severity >= 3 "
        f"AND timestamp_observed > ? AND event_type IN ({placeholders})",
        (day_ago, *_THREAT_EVENT_TYPES),
    ).fetchone()[0]

    total_encounters = conn.execute(
        "SELECT COALESCE(SUM(times_encountered),0) FROM bestiary_entries",
    ).fetchone()[0]

    conn.close()
    return {
        "actions_pending": pending,
        "actions_executed": executed,
        "actions_denied": denied,
        "threats_last_24h": recent_threats,
        "total_encounters": total_encounters,
    }
