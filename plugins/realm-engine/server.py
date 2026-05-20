"""realm-engine — Core game state CRUD.

Owns: events, entities, entity_*_history tables in ~/.realmwatch/game.db.
Reads: quests, actions, players (for status summaries).

Migrated from os.realm.watch/servers/realm_engine/server.py 2026-05-19.

Changes from the original:
- Local relative imports (`.db`, `.models`) instead of `servers.shared.*`.
- `ulid()` now comes from realmwatch's `realm_text` module (Wave 1).
- `sanitize_hostname()` comes from `realm_text` too.
- `update_bestiary()` from combat_ward is deferred to Wave 3 — the
  ingestion path no longer calls it (TODO marker preserved below).
- `get_entity()` is now a direct DB query (no entity_resolver dependency).
  This is the Option B fallback per the Wave 2 brief. Wave 3 reconciles.
"""
from __future__ import annotations

import hashlib
import json
import time

from .db import DEFAULT_DB_PATH, create_database, get_connection
from .models import Entity


# ── realm_text wiring ────────────────────────────────────────────────────
# realm_text lives at the realmwatch repo root. It's already on sys.path
# when this plugin is loaded by plugin_loader (which runs from repo root).
def _sanitize_hostname(value):
    try:
        from realm_text import sanitize_hostname
        return sanitize_hostname(value)
    except Exception:
        # Fail-soft: if realm_text isn't importable for any reason, return
        # the value as-is rather than crash the event path.
        return value


def _ulid():
    try:
        from realm_text import ulid as _u
        return _u()
    except Exception:
        # Fallback to a uuid4-derived sortable string. Not strictly ULID,
        # but unique and time-prefixed enough for dedupe to work.
        import uuid
        return f"{int(time.time() * 1000):013x}{uuid.uuid4().hex[:13]}".upper()


# ── Lifecycle ────────────────────────────────────────────────────────────

def ensure_db(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create or migrate the game DB."""
    create_database(db_path)


# ── Status / overview ────────────────────────────────────────────────────

def realm_status(db_path: str = DEFAULT_DB_PATH) -> dict:
    """Get realm overview: event count, entity count, quest summary, player level."""
    conn = get_connection(db_path)
    events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    entities = conn.execute(
        "SELECT COUNT(*) FROM entities WHERE status='active'"
    ).fetchone()[0]
    quests_active = conn.execute(
        "SELECT COUNT(*) FROM quests WHERE status IN ('created','active')"
    ).fetchone()[0]
    player = conn.execute("SELECT * FROM players LIMIT 1").fetchone()
    conn.close()
    return {
        "events": events,
        "entities": entities,
        "quests_active": quests_active,
        "player_level": player["level"] if player else 0,
        "player_xp": player["total_xp"] if player else 0,
    }


# ── Event ingestion ──────────────────────────────────────────────────────

def ingest_event(
    db_path: str = DEFAULT_DB_PATH,
    event_type: str = "",
    source_system: str = "",
    severity: int = 0,
    confidence: int = 50,
    payload: dict | None = None,
    entity_id: str | None = None,
    correlation_id: str | None = None,
    replay: bool = False,
) -> dict:
    """Ingest a realm event. Deduplicates by payload hash."""
    payload = payload or {}
    now_ms = int(time.time() * 1000)

    # Sanitize any hostname/string fields in payload
    for key in ("host", "hostname", "ssid", "banner"):
        if key in payload and isinstance(payload[key], str):
            payload[key] = _sanitize_hostname(payload[key])

    raw_json = json.dumps(payload, sort_keys=True)
    dedupe_key = hashlib.sha256(
        f"{event_type}:{source_system}:{raw_json}".encode()
    ).hexdigest()[:32]

    conn = get_connection(db_path)
    existing = conn.execute(
        "SELECT event_id FROM events WHERE dedupe_key=?", (dedupe_key,)
    ).fetchone()
    if existing:
        conn.close()
        return {"event_id": existing["event_id"], "deduplicated": True}

    eid = _ulid()
    conn.execute(
        """INSERT INTO events
        (event_id, event_type, source_system, entity_id, correlation_id, dedupe_key,
         severity, confidence, timestamp_observed, timestamp_ingested, replay_flag,
         raw_payload_json, normalized_payload_json, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
        (eid, event_type, source_system, entity_id, correlation_id, dedupe_key,
         severity, confidence, now_ms, now_ms, 1 if replay else 0,
         raw_json, raw_json),
    )
    conn.commit()
    conn.close()

    # TODO(Wave 3): when combat_ward lands as plugins/alerting or similar,
    # re-enable bestiary update for severity >= 3 events. Original code:
    #   if not replay and severity >= 3:
    #       update_bestiary(db_path, event_type, severity)

    return {"event_id": eid, "deduplicated": False}


# ── Player profile ───────────────────────────────────────────────────────

def get_profile(db_path: str = DEFAULT_DB_PATH, player_id: str = "default") -> dict:
    """Get or create player profile."""
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    if not row:
        now_ms = int(time.time() * 1000)
        conn.execute(
            """INSERT INTO players (player_id, created_ts, total_xp, level, schema_version)
               VALUES (?, ?, 0, 1, 1)""",
            (player_id, now_ms),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM players WHERE player_id=?", (player_id,)
        ).fetchone()
    conn.close()
    return dict(row)


def update_profile(
    db_path: str = DEFAULT_DB_PATH, player_id: str = "default", **kwargs
) -> dict:
    """Update player profile fields."""
    allowed = {"player_name", "player_class"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not updates:
        return get_profile(db_path, player_id)

    conn = get_connection(db_path)
    set_clause = ", ".join(f"{k}=?" for k in updates)
    conn.execute(
        f"UPDATE players SET {set_clause} WHERE player_id=?",
        (*updates.values(), player_id),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM players WHERE player_id=?", (player_id,)
    ).fetchone()
    conn.close()
    return dict(row)


# ── Entity queries (Option B: direct DB, no entity_resolver) ─────────────

def list_entities(db_path: str = DEFAULT_DB_PATH, status: str = "active") -> list[dict]:
    """List all entities with given status."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT * FROM entities WHERE status=? ORDER BY last_seen_ts DESC",
        (status,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_entity(db_path: str = DEFAULT_DB_PATH, entity_id: str = "") -> Entity | None:
    """Fetch a single entity by ID. Direct DB query — no entity_resolver
    dependency (Option B per Wave 2 brief)."""
    if not entity_id:
        return None
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT * FROM entities WHERE entity_id=?", (entity_id,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    # Coerce row → Entity dataclass (matches models.Entity field set).
    data = dict(row)
    return Entity(**{k: v for k, v in data.items() if k in Entity.__dataclass_fields__})


# ── Recent events ────────────────────────────────────────────────────────

def get_recent_events(
    db_path: str = DEFAULT_DB_PATH, limit: int = 20, min_severity: int = 0
) -> list[dict]:
    """Get most recent events, optionally filtered by minimum severity."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT * FROM events WHERE severity >= ? AND replay_flag = 0 "
        "ORDER BY timestamp_observed DESC LIMIT ?",
        (min_severity, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
