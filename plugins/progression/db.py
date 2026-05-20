"""Plugin-local game DB connection helper.

Migrated from os.realm.watch/servers/shared/db.py — only the bits the
progression plugin actually needs:

- DEFAULT_DB_PATH (~/.realmwatch/game.db sidecar)
- get_connection() — sqlite3 connection with row_factory + foreign keys
- create_database() — idempotent schema creation for the tables progression
  owns (plus the related tables it reads: quests, entities)

Wave 4 will dedupe with plugins/realm-engine/db.py (Somnus's port). For
now, both plugins can carry their own copies — `CREATE TABLE IF NOT EXISTS`
makes setup idempotent regardless of who runs first.
"""
from __future__ import annotations

import os
import sqlite3
from typing import Final

from realm_text import real_home

DEFAULT_DB_PATH: Final[str] = str(real_home() / ".realmwatch" / "game.db")


# Progression-owned schema (plus foreign-key targets it references).
# Subset of the full Truth Model v1 schema. Other plugins layer in their
# own CREATE TABLE statements for their owned tables.
_SCHEMA_SQL = """
-- Foreign-key target stubs (owned by realm-engine plugin, but we need the
-- table to exist for our FKs to validate during fresh-DB startup).
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

-- quest-forge owns this table; we only read it (achievement counters,
-- quest title lookup). CREATE-IF-NOT-EXISTS lets progression bootstrap
-- a clean DB without crashing on FK resolution.
CREATE TABLE IF NOT EXISTS quests (
    quest_id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    schema_version INTEGER NOT NULL DEFAULT 1
);

-- Players (owner: progression)
CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    player_name TEXT,
    player_class TEXT DEFAULT 'watcher',
    created_ts INTEGER NOT NULL,
    last_active_ts INTEGER,
    total_xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS xp_events (
    xp_event_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    quest_id TEXT,
    source_type TEXT,
    xp_amount INTEGER NOT NULL,
    granted_ts INTEGER NOT NULL,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    UNIQUE(player_id, quest_id, source_type),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_xp_player ON xp_events(player_id);

CREATE TABLE IF NOT EXISTS skill_trees (
    skill_id TEXT PRIMARY KEY,
    tree TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    unlock_level INTEGER DEFAULT 1,
    parent_skill_id TEXT
);

CREATE TABLE IF NOT EXISTS player_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    unlocked_ts INTEGER NOT NULL,
    UNIQUE(player_id, skill_id),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (skill_id) REFERENCES skill_trees(skill_id)
);

CREATE TABLE IF NOT EXISTS achievements (
    achievement_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    xp_reward INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_ts INTEGER NOT NULL,
    UNIQUE(player_id, achievement_id),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (achievement_id) REFERENCES achievements(achievement_id)
);
"""

# Seed: skill tree nodes + achievement catalogue. Verbatim port from
# os.realm.watch/servers/shared/db.py — INSERT OR IGNORE makes it safe to
# rerun.
_SEED_SQL = """
-- Networking tree
INSERT OR IGNORE INTO skill_trees VALUES ('net_dns', 'networking', 'DNS Mastery', 'Understand the naming stones', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('net_vlan', 'networking', 'VLAN Architect', 'Map the realm boundaries', 3, 'net_dns');
INSERT OR IGNORE INTO skill_trees VALUES ('net_routing', 'networking', 'Routing Sage', 'Navigate the realm paths', 5, 'net_vlan');
INSERT OR IGNORE INTO skill_trees VALUES ('net_dhcp', 'networking', 'DHCP Whisperer', 'Hear the address oracle', 2, 'net_dns');
INSERT OR IGNORE INTO skill_trees VALUES ('net_subnet', 'networking', 'Subnet Sculptor', 'Shape the realm geography', 7, 'net_routing');

-- Security tree
INSERT OR IGNORE INTO skill_trees VALUES ('sec_ward', 'security', 'Ward Weaver', 'Craft basic protections', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('sec_threat', 'security', 'Threat Hunter', 'Track shadow probes', 3, 'sec_ward');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_cipher', 'security', 'Cipher Knight', 'Master encryption wards', 5, 'sec_threat');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_shadow', 'security', 'Shadow Watcher', 'See through deception', 7, 'sec_cipher');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_arcane', 'security', 'Arcane Defender', 'Ultimate realm protection', 10, 'sec_shadow');

-- Systems tree
INSERT OR IGNORE INTO skill_trees VALUES ('sys_process', 'systems', 'Process Tamer', 'Control the realm workers', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('sys_metric', 'systems', 'Metric Seer', 'Read the realm vitals', 2, 'sys_process');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_service', 'systems', 'Service Binder', 'Bind realm daemons', 4, 'sys_metric');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_disk', 'systems', 'Disk Warden', 'Guard the archives', 6, 'sys_service');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_auto', 'systems', 'Automation Mage', 'Enchant recurring tasks', 8, 'sys_disk');

-- Arcana tree
INSERT OR IGNORE INTO skill_trees VALUES ('arc_agent', 'arcana', 'Agent Caller', 'Summon AI companions', 2, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('arc_mcp', 'arcana', 'MCP Crafter', 'Build tool servers', 5, 'arc_agent');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_hook', 'arcana', 'Hook Weaver', 'Set realm triggers', 7, 'arc_mcp');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_skill', 'arcana', 'Skill Forger', 'Create game verbs', 9, 'arc_hook');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_realm', 'arcana', 'Realm Architect', 'Reshape the world itself', 12, 'arc_skill');

-- Achievements
INSERT OR IGNORE INTO achievements VALUES ('first_quest', 'First Steps', 'Complete your first quest', 100);
INSERT OR IGNORE INTO achievements VALUES ('cartographer', 'The Cartographer', 'Discover and name 5 nodes', 250);
INSERT OR IGNORE INTO achievements VALUES ('first_blood', 'First Blood', 'Block your first threat', 200);
INSERT OR IGNORE INTO achievements VALUES ('whisperer', 'The Whisperer', 'Complete a voice-only session', 150);
INSERT OR IGNORE INTO achievements VALUES ('patrol_5', 'Diligent Watcher', 'Complete 5 daily patrols', 300);
INSERT OR IGNORE INTO achievements VALUES ('level_3', 'Apprentice Watcher', 'Reach level 3', 150);
INSERT OR IGNORE INTO achievements VALUES ('level_5', 'Realm Scout', 'Reach level 5', 500);
INSERT OR IGNORE INTO achievements VALUES ('level_10', 'Ward Keeper', 'Reach level 10', 1000);
INSERT OR IGNORE INTO achievements VALUES ('quest_10', 'Seasoned Adventurer', 'Complete 10 quests', 200);
INSERT OR IGNORE INTO achievements VALUES ('quest_25', 'Questmaster', 'Complete 25 quests', 500);
INSERT OR IGNORE INTO achievements VALUES ('quest_50', 'Legend of the Realm', 'Complete 50 quests', 1000);
INSERT OR IGNORE INTO achievements VALUES ('architect', 'The Architect', 'Write a custom MCP server', 2000);
"""


def create_database(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create progression's tables in the game DB. Idempotent (CREATE IF NOT EXISTS)."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(_SCHEMA_SQL)
    conn.executescript(_SEED_SQL)
    conn.commit()
    conn.close()


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Return a sqlite3 connection with row_factory + foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
