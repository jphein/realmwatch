"""game.db connection factory + schema bootstrap for the quests plugin.

Owns: quests, quest_event_links, quest_state_log.

The DB lives at ~/.realmwatch/game.db (sidecar to realm.db). This is the same
DB that map_server.py reads via its /quests, /quest-create, /quest-update,
/quest-delete handlers — the plugin doesn't replace those endpoints, it adds
the auto-generation engine + MCP tools that operate on the same store.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from realm_text import real_home


DEFAULT_DB_PATH = str(real_home() / ".realmwatch" / "game.db")


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS quests (
    quest_id TEXT PRIMARY KEY,
    quest_type TEXT NOT NULL,
    source_event_id TEXT,
    correlation_id TEXT,
    entity_id TEXT,
    title TEXT NOT NULL,
    technical_label TEXT,
    description TEXT,
    severity INTEGER NOT NULL DEFAULT 0 CHECK(severity BETWEEN 0 AND 5),
    status TEXT NOT NULL DEFAULT 'detected',
    hints_json TEXT DEFAULT '[]',
    debrief_json TEXT,
    xp_reward INTEGER NOT NULL DEFAULT 100,
    created_ts INTEGER NOT NULL,
    activated_ts INTEGER,
    resolved_ts INTEGER,
    debriefed_ts INTEGER,
    rewarded_ts INTEGER,
    archived_ts INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    parent_quest_id TEXT REFERENCES quests(quest_id),
    actions_json TEXT DEFAULT '[]',
    node TEXT,
    sort_order INTEGER DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_quests_entity ON quests(entity_id);
CREATE INDEX IF NOT EXISTS idx_quests_status ON quests(status);
CREATE INDEX IF NOT EXISTS idx_quests_corr ON quests(correlation_id);
CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_quest_id);

CREATE TABLE IF NOT EXISTS quest_event_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    role TEXT DEFAULT 'trigger',
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_qel_quest ON quest_event_links(quest_id);

CREATE TABLE IF NOT EXISTS quest_state_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    transition_ts INTEGER NOT NULL,
    actor TEXT DEFAULT 'system',
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_qsl_quest ON quest_state_log(quest_id);
"""


def _migrate_quests_v2(conn: sqlite3.Connection) -> None:
    """Add sub-quest columns if missing (for DBs created before this change)."""
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if "quests" not in tables:
        return
    cols = [r[1] for r in conn.execute("PRAGMA table_info(quests)").fetchall()]
    if "parent_quest_id" not in cols:
        conn.execute(
            "ALTER TABLE quests ADD COLUMN parent_quest_id TEXT REFERENCES quests(quest_id)")
        conn.execute("ALTER TABLE quests ADD COLUMN actions_json TEXT DEFAULT '[]'")
        conn.execute("ALTER TABLE quests ADD COLUMN node TEXT")
        conn.execute("ALTER TABLE quests ADD COLUMN sort_order INTEGER DEFAULT 0")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_quest_id)")
        conn.commit()


def create_database(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create / migrate the game database (quests + lifecycle tables only).

    The full Truth Model schema (events, entities, players, codex, etc.) lives
    in the broader game.db — we only own the quest-related tables here. Other
    plugins / migration scripts seed the rest.
    """
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate_quests_v2(conn)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Get a connection with row_factory and foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
