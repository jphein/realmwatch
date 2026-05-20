"""Combat-ward DB helper — shares game.db with realm-engine.

The schema for actions, action_policy_log, ward_templates, and bestiary_entries
is owned by realm-engine (which seeds the default ward templates + bestiary).
This module only opens a connection; it does NOT re-create tables. If you
boot combat-ward without realm-engine, the tables won't exist and combat-ward
endpoints will return an error — that's by design (depends_on: ["realm-engine"]
gates this in plugin_loader).

Path resolution honours SUDO_USER so `make dev` running as root for port 80
still finds JP's game.db at /home/jp/.realmwatch/game.db.
"""
from __future__ import annotations

import os
import sqlite3

from realm_text import real_home


DEFAULT_DB_PATH = os.environ.get(
    "REALM_GAME_DB",
    str(real_home() / ".realmwatch" / "game.db"),
)


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Connect to game.db with row_factory and foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
