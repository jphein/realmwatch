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
import pwd
import sqlite3


def _real_home() -> str:
    """Resolve the invoking user's real home, even when launched under sudo.

    Matches the same logic in plugins/realm-engine/db.py so both plugins
    open the same SQLite file regardless of whether map_server runs as root.
    """
    for env_var in ("SUDO_USER", "LOGNAME", "USER"):
        user = os.environ.get(env_var)
        if user and user != "root":
            try:
                return pwd.getpwnam(user).pw_dir
            except KeyError:
                continue
    return os.path.expanduser("~")


DEFAULT_DB_PATH = os.environ.get(
    "REALM_GAME_DB",
    os.path.join(_real_home(), ".realmwatch", "game.db"),
)


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Connect to game.db with row_factory and foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
