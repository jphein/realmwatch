"""Codex / lore-keeper business logic — world lore, node backstories, chronicles, journal.

Ported from os.realm.watch/servers/lore_keeper/server.py.

Wave 3 migration notes:
- `from servers.shared.ulid import ulid` -> `from realm_text import ulid`
- `from servers.shared.db import ...` -> `from .db import ...` (plugin-local)

Owns tables: codex_entries, node_lore, chronicles, journal_entries.
Reads: events, entities (read-only references).
"""
from __future__ import annotations

import time
from typing import Optional

from realm_text import ulid

from .db import DEFAULT_DB_PATH, get_connection


# ── Codex entries (world lore wiki) ──────────────────────────────────────────

def get_codex_entry(db_path: str = DEFAULT_DB_PATH,
                    codex_id: Optional[str] = None,
                    category: Optional[str] = None) -> dict | list[dict]:
    """Look up codex entries.

    - codex_id set -> returns the single entry dict, or {"error": ...} if missing.
    - category set -> returns list of entries in that category (sorted by codex_id).
    - no args     -> returns list of ALL entries (sorted by category, codex_id).
    """
    conn = get_connection(db_path)
    if codex_id:
        row = conn.execute(
            "SELECT * FROM codex_entries WHERE codex_id=?", (codex_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else {"error": f"Codex entry '{codex_id}' not found"}

    if category:
        rows = conn.execute(
            "SELECT * FROM codex_entries WHERE category=? ORDER BY codex_id",
            (category,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM codex_entries ORDER BY category, codex_id"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def list_codex_categories(db_path: str = DEFAULT_DB_PATH) -> list[str]:
    """List all distinct codex categories."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT DISTINCT category FROM codex_entries ORDER BY category"
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def upsert_codex_entry(db_path: str = DEFAULT_DB_PATH,
                       codex_id: str = "",
                       category: str = "",
                       fantasy_name: str = "",
                       technical_name: str = "",
                       summary: str = "",
                       lore_text: Optional[str] = None,
                       technical_text: Optional[str] = None) -> dict:
    """Insert or update a codex entry (by codex_id). Returns the persisted row."""
    if not codex_id:
        return {"error": "codex_id required"}
    conn = get_connection(db_path)
    existing = conn.execute(
        "SELECT codex_id FROM codex_entries WHERE codex_id=?", (codex_id,)
    ).fetchone()
    if existing:
        conn.execute(
            """UPDATE codex_entries SET
                category=?, fantasy_name=?, technical_name=?, summary=?,
                lore_text=?, technical_text=?
            WHERE codex_id=?""",
            (category, fantasy_name, technical_name, summary,
             lore_text, technical_text, codex_id),
        )
    else:
        conn.execute(
            """INSERT INTO codex_entries
                (codex_id, category, fantasy_name, technical_name, summary,
                 lore_text, technical_text, schema_version)
            VALUES (?,?,?,?,?,?,?,1)""",
            (codex_id, category, fantasy_name, technical_name, summary,
             lore_text, technical_text),
        )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM codex_entries WHERE codex_id=?", (codex_id,)
    ).fetchone()
    conn.close()
    return dict(row)


# ── Node lore (per-entity backstories) ───────────────────────────────────────

def get_node_lore(db_path: str = DEFAULT_DB_PATH, entity_id: str = "") -> Optional[dict]:
    """Get lore for a specific entity/node, or None if not present."""
    conn = get_connection(db_path)
    row = conn.execute(
        "SELECT * FROM node_lore WHERE entity_id=?", (entity_id,)
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def list_node_lore(db_path: str = DEFAULT_DB_PATH, limit: int = 100) -> list[dict]:
    """List all node lore entries (newest-updated first)."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT * FROM node_lore ORDER BY updated_ts DESC LIMIT ?",
        (max(1, limit),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_node_lore(db_path: str = DEFAULT_DB_PATH,
                  entity_id: str = "",
                  backstory: str = "",
                  personality: Optional[str] = None) -> dict:
    """Upsert lore for a node (by entity_id). Returns the persisted row."""
    if not entity_id:
        return {"error": "entity_id required"}
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    existing = conn.execute(
        "SELECT lore_id FROM node_lore WHERE entity_id=?", (entity_id,)
    ).fetchone()
    if existing:
        updates = {"backstory": backstory, "updated_ts": now_ms}
        if personality is not None:
            updates["personality"] = personality
        set_clause = ", ".join(f"{k}=?" for k in updates)
        conn.execute(
            f"UPDATE node_lore SET {set_clause} WHERE entity_id=?",
            (*updates.values(), entity_id),
        )
    else:
        conn.execute(
            """INSERT INTO node_lore
                (lore_id, entity_id, backstory, personality, created_ts, updated_ts)
            VALUES (?,?,?,?,?,?)""",
            (ulid(), entity_id, backstory, personality, now_ms, now_ms),
        )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM node_lore WHERE entity_id=?", (entity_id,)
    ).fetchone()
    conn.close()
    return dict(row)


# ── Chronicles (historical event narratives) ─────────────────────────────────

def add_chronicle(db_path: str = DEFAULT_DB_PATH,
                  event_id: Optional[str] = None,
                  title: str = "",
                  narrative: str = "") -> dict:
    """Add a chronicle entry. Returns the persisted row."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    cid = ulid()
    conn.execute(
        """INSERT INTO chronicles
            (chronicle_id, event_id, title, narrative, chronicle_date, created_ts)
        VALUES (?,?,?,?,?,?)""",
        (cid, event_id, title, narrative, now_ms, now_ms),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM chronicles WHERE chronicle_id=?", (cid,)
    ).fetchone()
    conn.close()
    return dict(row)


def get_chronicles(db_path: str = DEFAULT_DB_PATH, limit: int = 20) -> list[dict]:
    """Get recent chronicles, newest first (by chronicle_date)."""
    conn = get_connection(db_path)
    rows = conn.execute(
        "SELECT * FROM chronicles ORDER BY chronicle_date DESC LIMIT ?",
        (max(1, limit),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── Player journal (discovery / observation notes) ───────────────────────────

def add_journal_entry(db_path: str = DEFAULT_DB_PATH,
                      player_id: str = "default",
                      entry_type: str = "observation",
                      title: str = "",
                      content: str = "",
                      entity_id: Optional[str] = None,
                      quest_id: Optional[str] = None) -> dict:
    """Add a journal entry. Returns the persisted row."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)
    jid = ulid()
    conn.execute(
        """INSERT INTO journal_entries
            (journal_id, player_id, entry_type, title, content, entity_id, quest_id, created_ts)
        VALUES (?,?,?,?,?,?,?,?)""",
        (jid, player_id, entry_type, title, content, entity_id, quest_id, now_ms),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM journal_entries WHERE journal_id=?", (jid,)
    ).fetchone()
    conn.close()
    return dict(row)


def get_journal(db_path: str = DEFAULT_DB_PATH,
                player_id: str = "default",
                entry_type: Optional[str] = None,
                limit: int = 20) -> list[dict]:
    """Get a player's journal entries, newest first."""
    conn = get_connection(db_path)
    if entry_type:
        rows = conn.execute(
            """SELECT * FROM journal_entries
            WHERE player_id=? AND entry_type=?
            ORDER BY created_ts DESC LIMIT ?""",
            (player_id, entry_type, max(1, limit)),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT * FROM journal_entries
            WHERE player_id=?
            ORDER BY created_ts DESC LIMIT ?""",
            (player_id, max(1, limit)),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]
