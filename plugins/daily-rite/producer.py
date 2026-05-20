"""The Watcher's Daily Rite — morning briefing producer.

Migrated from os.realm.watch/servers/plugins/daily_rite.py 2026-05-19.

Queries the (sidecar) game.db at ~/.realmwatch/game.db for overnight
activity, pending quests, and player state, then composes a briefing
string. The plugin layer chooses *when* to fire it (timer or on-demand
endpoint), and decides what to do with the briefing (speak, notify, push
realm event).

Per the wave-2 briefing the game.db stays where it is for now — each
plugin opens its own short-lived connection. If the DB or required
tables are missing this module returns a graceful empty/default state.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import time
from pathlib import Path

from realm_text import real_home


# Game DB lives in the invoking user's home — sidecar approach for wave 2.
DEFAULT_DB_PATH = str(real_home() / ".realmwatch" / "game.db")


# XP curve: total XP required to reach level N is sum(100*i for i in 1..N-1).
# Copied from os.realm.watch/servers/shared/models.py so the producer has no
# cross-repo import dependency.
def xp_for_level(level: int) -> int:
    """Total XP required to reach the given level."""
    return sum(100 * i for i in range(1, level))


def _get_connection(db_path: str) -> sqlite3.Connection | None:
    """Open a read-only-ish connection to the game DB, or None if unavailable."""
    if not Path(db_path).exists():
        return None
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        return conn
    except sqlite3.Error:
        return None


def _safe_count(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> int:
    """Run a SELECT COUNT(*) style query, return 0 on any error (missing table, etc)."""
    try:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def query_realm_state(db_path: str = DEFAULT_DB_PATH) -> dict:
    """Gather realm metrics from the game database. Returns a dict with
    safe defaults if the DB or any table is missing."""
    default = {
        "total_events": 0,
        "overnight_events": 0,
        "overnight_severe": 0,
        "entity_count": 0,
        "active_quests": 0,
        "unrewarded_quests": 0,
        "total_quests": 0,
        "player_name": "Watcher",
        "total_xp": 0,
        "level": 1,
        "xp_to_next": 100,
        "active_threats": 0,
        "db_available": False,
    }

    conn = _get_connection(db_path)
    if conn is None:
        return default

    try:
        now = int(time.time())
        twelve_hours_ago = now - (12 * 3600)
        # os.realm.watch uses millisecond timestamps in the events table.
        twelve_hours_ago_ms = twelve_hours_ago * 1000

        state = dict(default)
        state["db_available"] = True
        state["total_events"] = _safe_count(conn, "SELECT COUNT(*) FROM events")
        state["overnight_events"] = _safe_count(
            conn,
            "SELECT COUNT(*) FROM events WHERE timestamp_observed >= ?",
            (twelve_hours_ago_ms,),
        )
        state["overnight_severe"] = _safe_count(
            conn,
            "SELECT COUNT(*) FROM events WHERE timestamp_observed >= ? AND severity >= 2",
            (twelve_hours_ago_ms,),
        )
        state["entity_count"] = _safe_count(
            conn, "SELECT COUNT(*) FROM entities WHERE status = 'active'"
        )
        state["active_quests"] = _safe_count(
            conn, "SELECT COUNT(*) FROM quests WHERE status = 'active'"
        )
        state["unrewarded_quests"] = _safe_count(
            conn, "SELECT COUNT(*) FROM quests WHERE status = 'resolved'"
        )
        state["total_quests"] = _safe_count(conn, "SELECT COUNT(*) FROM quests")
        state["active_threats"] = _safe_count(
            conn, "SELECT COUNT(*) FROM actions WHERE result_status = 'pending'"
        )

        # Player state — wrapped in try because the players table is owned
        # by realm_engine and may not exist on a fresh setup.
        try:
            player = conn.execute(
                "SELECT player_name, total_xp, level FROM players WHERE player_id = 'default'"
            ).fetchone()
            if player:
                player_name = player["player_name"] or "Watcher"
                total_xp = int(player["total_xp"] or 0)
                level = int(player["level"] or 1)
                next_level_xp = xp_for_level(level + 1)
                state["player_name"] = player_name
                state["total_xp"] = total_xp
                state["level"] = level
                state["xp_to_next"] = max(0, next_level_xp - total_xp)
        except sqlite3.Error:
            pass

        return state
    finally:
        conn.close()


def build_briefing(state: dict) -> str:
    """Compose the morning briefing message from a realm-state dict."""
    parts: list[str] = []

    parts.append(f"Good morning, {state['player_name']}.")
    parts.append(
        f"You are level {state['level']} with {state['total_xp']} experience. "
        f"{state['xp_to_next']} until next level."
    )

    if state["overnight_severe"] > 0:
        parts.append(
            f"Overnight: {state['overnight_events']} events detected, "
            f"{state['overnight_severe']} of notable severity."
        )
    elif state["overnight_events"] > 0:
        parts.append(f"Overnight: {state['overnight_events']} events, all routine.")
    else:
        parts.append("The realm was quiet overnight.")

    if state["active_quests"] > 0:
        s = "s" if state["active_quests"] != 1 else ""
        parts.append(f"{state['active_quests']} active quest{s} await your attention.")
    if state["unrewarded_quests"] > 0:
        s = "s" if state["unrewarded_quests"] != 1 else ""
        parts.append(f"{state['unrewarded_quests']} resolved quest{s} await rewards.")

    if state["active_threats"] > 0:
        s = "s" if state["active_threats"] != 1 else ""
        parts.append(f"{state['active_threats']} pending threat{s} require assessment.")

    parts.append(
        f"The realm holds {state['entity_count']} entities across "
        f"{state['total_events']} recorded events."
    )

    if not state.get("db_available"):
        parts.append("(The game chronicle is sealed — running on default state.)")

    parts.append("May your watch be vigilant.")

    return " ".join(parts)


# ── Side-effect helpers (speech, notification, sound) ──
# All best-effort: any failure is silently swallowed so the rite still
# completes and the realm event still fires.

def speak(message: str) -> bool:
    """Speak via gnome-speaks D-Bus service. Returns True on success."""
    try:
        result = subprocess.run(
            [
                "dbus-send", "--session",
                "--dest=org.gnome.Speaks",
                "--print-reply",
                "/org/gnome/Speaks",
                "org.gnome.Speaks.Speak",
                f"string:{message}",
            ],
            timeout=30,
            capture_output=True,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def notify(title: str, body: str) -> bool:
    """Send a desktop notification via notify-send. Returns True on success."""
    try:
        result = subprocess.run(
            ["notify-send", "--app-name=RealmWatch", title, body],
            timeout=10,
            capture_output=True,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def play_chime() -> bool:
    """Play the morning rite sound chime. Returns True if chime was launched."""
    chime_script = str(real_home() / ".realmwatch" / "sounds" / "play.sh")
    if not os.path.isfile(chime_script):
        return False
    try:
        subprocess.Popen([chime_script, "quest_complete"])
        return True
    except (FileNotFoundError, OSError):
        return False


def run_daily_rite(db_path: str = DEFAULT_DB_PATH,
                   do_speak: bool = True,
                   do_notify: bool = True,
                   do_chime: bool = True) -> dict:
    """Execute the daily morning rite. Returns a dict with the briefing text
    and the side-effect results."""
    state = query_realm_state(db_path)
    briefing = build_briefing(state)

    result = {
        "briefing": briefing,
        "state": state,
        "chimed": False,
        "spoke": False,
        "notified": False,
    }
    if do_chime:
        result["chimed"] = play_chime()
    if do_speak:
        result["spoke"] = speak(briefing)
    if do_notify:
        result["notified"] = notify("The Watcher's Daily Rite", briefing)

    return result
