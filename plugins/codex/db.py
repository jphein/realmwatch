"""Plugin-local game DB connection helper for the codex plugin.

Ported from os.realm.watch/servers/shared/db.py — only the tables the
codex plugin owns (codex_entries, node_lore, chronicles, journal_entries)
plus FK-target stubs so a fresh game.db can bootstrap without crashing.

Realm-engine's plugin/db.py also creates these tables. CREATE IF NOT EXISTS
makes whichever plugin loads first the no-op for the other — Wave 4 will
dedupe.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Final

from realm_text import real_home

DEFAULT_DB_PATH: Final[str] = str(real_home() / ".realmwatch" / "game.db")


# Codex-owned schema (plus FK-target stubs).
_SCHEMA_SQL = """
-- FK-target stub: entities (owned by realm-engine plugin).
CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,
    canonical_name TEXT,
    entity_type TEXT NOT NULL DEFAULT 'unknown',
    identity_confidence INTEGER NOT NULL DEFAULT 0,
    first_seen_ts INTEGER NOT NULL DEFAULT 0,
    last_seen_ts INTEGER NOT NULL DEFAULT 0,
    user_label TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
);

-- FK-target stub: events (owned by realm-engine plugin).
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
);

-- FK-target stubs: players + quests (owned by progression + quest-forge).
CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS quests (
    quest_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1
);

-- Codex entries (owner: codex / lore-keeper).
CREATE TABLE IF NOT EXISTS codex_entries (
    codex_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    fantasy_name TEXT NOT NULL,
    technical_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    lore_text TEXT,
    technical_text TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_codex_category ON codex_entries(category);

-- Node lore (owner: codex / lore-keeper).
CREATE TABLE IF NOT EXISTS node_lore (
    lore_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL UNIQUE,
    backstory TEXT,
    personality TEXT,
    notable_events_json TEXT DEFAULT '[]',
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);

-- Chronicles (owner: codex / lore-keeper).
CREATE TABLE IF NOT EXISTS chronicles (
    chronicle_id TEXT PRIMARY KEY,
    event_id TEXT,
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,
    chronicle_date INTEGER NOT NULL,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(event_id)
);
CREATE INDEX IF NOT EXISTS idx_chronicles_date ON chronicles(chronicle_date);

-- Journal entries (owner: codex / lore-keeper).
CREATE TABLE IF NOT EXISTS journal_entries (
    journal_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    entity_id TEXT,
    quest_id TEXT,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id),
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_journal_player ON journal_entries(player_id);
CREATE INDEX IF NOT EXISTS idx_journal_type ON journal_entries(entry_type);
"""


def create_database(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create codex's tables in the game DB. Idempotent."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA_SQL)
    conn.commit()
    conn.close()


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Return a sqlite3 connection with row_factory + foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
