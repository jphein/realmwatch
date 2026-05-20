"""Progression business logic — XP grants, levels, skill trees, achievements.

Ported from os.realm.watch/servers/progression/server.py.

Wave 2 migration notes:
- `from servers.shared.ulid import ulid` → `from realm_text import ulid`
  (realm_text.py lives at the realmwatch repo root, Reverie wave 1.)
- `from servers.shared.db ...` → `from .db ...` (plugin-local).
- `from servers.shared.models ...` → `from .models ...` (plugin-local).
- `from servers.shared.chronicle_hooks ...` → loose-coupled via the
  `_codex_api` dict injected by `plugin.setup(ctx)`. Codex absorbed
  lore-keeper in Wave 3; if codex isn't loaded the chronicle calls are
  silently dropped and the XP/level path stays functional.

Owns tables: players, xp_events, skill_trees, player_skills, achievements,
player_achievements. Reads: quests (quest_forge), entities (realm-engine).
"""
from __future__ import annotations

import time
from typing import Callable, Optional

from realm_text import ulid

from .db import DEFAULT_DB_PATH, get_connection
from .models import level_from_xp, xp_for_level


# ── Loose coupling to codex for chronicle entries ────────────────────────────
# plugin.setup() wires this to ctx.get_plugin_api("codex"), which exposes
# chronicle_xp_granted / chronicle_level_up / chronicle_achievement_unlocked
# (codex absorbed lore-keeper during the Wave 3 os.realm.watch migration).

_codex_api: Optional[dict] = None


def set_codex_api(api: Optional[dict]) -> None:
    """Wired by plugin.setup() once the registry is populated."""
    global _codex_api
    _codex_api = api


# Back-compat shim for any external caller that still imports the old name.
set_lore_keeper_api = set_codex_api


def _chronicle_xp_granted(db_path: str, amount: int, quest_title: str, source_type: str) -> None:
    if not _codex_api:
        return
    fn = _codex_api.get("chronicle_xp_granted")
    if not fn:
        return
    try:
        fn(db_path=db_path, amount=amount, quest_title=quest_title, source_type=source_type)
    except Exception as e:  # pragma: no cover — chronicle is best-effort
        print(f"[progression] chronicle_xp_granted failed: {e}")


def _chronicle_level_up(db_path: str, player_name: str, new_level: int) -> None:
    if not _codex_api:
        return
    fn = _codex_api.get("chronicle_level_up")
    if not fn:
        return
    try:
        fn(db_path=db_path, player_name=player_name, new_level=new_level)
    except Exception as e:  # pragma: no cover
        print(f"[progression] chronicle_level_up failed: {e}")


def _chronicle_achievement_unlocked(db_path: str, achievement_name: str) -> None:
    if not _codex_api:
        return
    fn = _codex_api.get("chronicle_achievement_unlocked")
    if not fn:
        return
    try:
        fn(db_path=db_path, achievement_name=achievement_name)
    except Exception as e:  # pragma: no cover
        print(f"[progression] chronicle_achievement_unlocked failed: {e}")


# ── Core XP path ─────────────────────────────────────────────────────────────

def grant_xp(
    db_path: str = DEFAULT_DB_PATH,
    player_id: str = "default",
    amount: int = 0,
    source_type: Optional[str] = None,
    quest_id: Optional[str] = None,
    replay: bool = False,
) -> dict:
    """Grant XP to a player. Idempotent per (player, quest, source_type). Returns updated player."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)

    # Check idempotency
    if quest_id and source_type:
        existing = conn.execute(
            "SELECT xp_event_id FROM xp_events WHERE player_id=? AND quest_id=? AND source_type=?",
            (player_id, quest_id, source_type)).fetchone()
        if existing:
            row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
            conn.close()
            return dict(row) if row else {}

    # Replay events skip xp_events insert to avoid FK on fake quest_ids
    if replay:
        row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
        conn.close()
        return dict(row) if row else {}

    # Insert XP event
    conn.execute("""INSERT INTO xp_events (xp_event_id, player_id, quest_id, source_type, xp_amount, granted_ts, replay_flag)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""",
                 (ulid(), player_id, quest_id, source_type, amount, now_ms, 1 if replay else 0))

    # Only increase total_xp for non-replay events
    if not replay:
        conn.execute("UPDATE players SET total_xp = total_xp + ?, last_active_ts = ? WHERE player_id = ?",
                     (amount, now_ms, player_id))

    conn.commit()

    # Recalculate level
    row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    if not row:
        conn.close()
        return {}
    old_level = row["level"]
    new_level = level_from_xp(row["total_xp"])
    if new_level != old_level:
        conn.execute("UPDATE players SET level=? WHERE player_id=?", (new_level, player_id))
        conn.commit()
        row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()

    conn.close()

    # Chronicle hooks (skip for replay events)
    if not replay and amount > 0:
        # Look up quest title if available
        quest_title = ""
        if quest_id:
            quest_conn = get_connection(db_path)
            qrow = quest_conn.execute("SELECT title FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
            quest_conn.close()
            quest_title = qrow["title"] if qrow else ""
        _chronicle_xp_granted(db_path, amount=amount, quest_title=quest_title,
                              source_type=source_type or "")
        if new_level != old_level:
            player_name = (row["player_name"] if row["player_name"] else "The Watcher")
            _chronicle_level_up(db_path, player_name=player_name, new_level=new_level)

    # Auto-check achievements after XP/level change (skip replay and achievement-source to avoid loops)
    if not replay and source_type != "achievement":
        check_achievements(db_path, player_id)
        # Auto-unlock skills when player levels up
        if new_level != old_level:
            check_skill_unlocks(db_path, player_id)

    return dict(row)


def ensure_player(db_path: str = DEFAULT_DB_PATH, player_id: str = "default",
                  player_name: Optional[str] = None) -> dict:
    """Upsert a player row. Returns the player record."""
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    if row:
        conn.close()
        return dict(row)
    now_ms = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO players (player_id, player_name, created_ts, last_active_ts) VALUES (?, ?, ?, ?)",
        (player_id, player_name, now_ms, now_ms),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    conn.close()
    return dict(row) if row else {}


def get_level_info(db_path: str = DEFAULT_DB_PATH, player_id: str = "default") -> dict:
    """Get detailed level/XP info for a player."""
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    conn.close()
    if not row:
        return {"error": "Player not found", "player_id": player_id}
    current_level = row["level"]
    current_xp = row["total_xp"]
    next_level_xp = xp_for_level(current_level + 1)
    return {
        "level": current_level,
        "total_xp": current_xp,
        "xp_to_next": next_level_xp - current_xp,
        "next_level_at": next_level_xp,
        "player_name": row["player_name"],
        "player_class": row["player_class"],
    }


def get_skill_tree(db_path: str = DEFAULT_DB_PATH, tree: str = "networking") -> list[dict]:
    """Get all skills in a skill tree."""
    conn = get_connection(db_path)
    rows = conn.execute("SELECT * FROM skill_trees WHERE tree=? ORDER BY unlock_level", (tree,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def list_player_skills(db_path: str = DEFAULT_DB_PATH, player_id: str = "default") -> list[dict]:
    """Return all skills a player has unlocked, joined with skill_trees metadata."""
    conn = get_connection(db_path)
    rows = conn.execute(
        """SELECT ps.skill_id, ps.unlocked_ts, st.tree, st.name, st.description, st.unlock_level
             FROM player_skills ps
             JOIN skill_trees st ON st.skill_id = ps.skill_id
            WHERE ps.player_id = ?
            ORDER BY ps.unlocked_ts""",
        (player_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def unlock_skill(db_path: str = DEFAULT_DB_PATH, player_id: str = "default", skill_id: str = "") -> dict:
    """Unlock a skill for a player. Checks level requirement."""
    conn = get_connection(db_path)
    now_ms = int(time.time() * 1000)

    # Check if already unlocked
    existing = conn.execute("SELECT id FROM player_skills WHERE player_id=? AND skill_id=?",
                            (player_id, skill_id)).fetchone()
    if existing:
        conn.close()
        return {"already_unlocked": True, "skill_id": skill_id}

    # Check level requirement
    skill = conn.execute("SELECT * FROM skill_trees WHERE skill_id=?", (skill_id,)).fetchone()
    if not skill:
        conn.close()
        return {"error": f"Unknown skill: {skill_id}"}

    player = conn.execute("SELECT level FROM players WHERE player_id=?", (player_id,)).fetchone()
    if not player or player["level"] < skill["unlock_level"]:
        conn.close()
        return {"error": f"Level {skill['unlock_level']} required, currently {player['level'] if player else 0}"}

    # Check prerequisite
    if skill["parent_skill_id"]:
        parent = conn.execute("SELECT id FROM player_skills WHERE player_id=? AND skill_id=?",
                              (player_id, skill["parent_skill_id"])).fetchone()
        if not parent:
            conn.close()
            return {"error": f"Prerequisite skill '{skill['parent_skill_id']}' not unlocked"}

    conn.execute("INSERT INTO player_skills (player_id, skill_id, unlocked_ts) VALUES (?,?,?)",
                 (player_id, skill_id, now_ms))
    conn.commit()
    conn.close()
    return {"unlocked": True, "skill_id": skill_id, "name": skill["name"]}


def grant_achievement(db_path: str = DEFAULT_DB_PATH, player_id: str = "default", achievement_id: str = "") -> dict:
    """Grant an achievement. Idempotent. Awards XP if first time."""
    conn = get_connection(db_path)

    existing = conn.execute("SELECT id FROM player_achievements WHERE player_id=? AND achievement_id=?",
                            (player_id, achievement_id)).fetchone()
    if existing:
        conn.close()
        return {"already_unlocked": True, "achievement_id": achievement_id}

    achievement = conn.execute("SELECT * FROM achievements WHERE achievement_id=?", (achievement_id,)).fetchone()
    if not achievement:
        conn.close()
        return {"error": f"Unknown achievement: {achievement_id}"}

    now_ms = int(time.time() * 1000)
    conn.execute("INSERT INTO player_achievements (player_id, achievement_id, unlocked_ts) VALUES (?,?,?)",
                 (player_id, achievement_id, now_ms))
    conn.commit()
    conn.close()

    # Award XP for achievement
    xp_result: dict = {}
    if achievement["xp_reward"] > 0:
        xp_result = grant_xp(db_path, player_id, achievement["xp_reward"],
                             source_type="achievement")

    # Chronicle the achievement
    _chronicle_achievement_unlocked(db_path, achievement_name=achievement["name"])

    return {"unlocked": True, "achievement_id": achievement_id,
            "name": achievement["name"], "xp_awarded": achievement["xp_reward"],
            "total_xp": xp_result.get("total_xp", 0)}


def check_achievements(db_path: str = DEFAULT_DB_PATH, player_id: str = "default") -> list[dict]:
    """Check all achievement conditions and grant any newly earned ones.

    Returns a list of newly granted achievements.
    """
    conn = get_connection(db_path)

    # Get player state
    player = conn.execute("SELECT * FROM players WHERE player_id=?", (player_id,)).fetchone()
    if not player:
        conn.close()
        return []

    level = player["level"]

    # Get already-unlocked achievement IDs
    unlocked = {r["achievement_id"] for r in
                conn.execute("SELECT achievement_id FROM player_achievements WHERE player_id=?",
                             (player_id,)).fetchall()}

    # Count completed quests (resolved or later in lifecycle).
    # quests table is owned by quest-forge plugin; we tolerate it being
    # empty or missing the status column on a fresh game.db.
    completed_statuses = ("resolved", "debriefed", "rewarded", "archived")
    placeholders = ",".join("?" for _ in completed_statuses)
    try:
        quest_count = conn.execute(
            f"SELECT COUNT(*) as c FROM quests WHERE status IN ({placeholders})",
            completed_statuses).fetchone()["c"]
    except Exception:
        quest_count = 0

    # Count named entities (user_label set). entities table owned by
    # realm-engine plugin; tolerate absence.
    try:
        named_entities = conn.execute(
            "SELECT COUNT(*) as c FROM entities WHERE user_label IS NOT NULL AND user_label != ''").fetchone()["c"]
    except Exception:
        named_entities = 0

    conn.close()

    # Define auto-checkable conditions: achievement_id -> condition
    conditions = {
        "first_quest": quest_count >= 1,
        "quest_10": quest_count >= 10,
        "quest_25": quest_count >= 25,
        "quest_50": quest_count >= 50,
        "level_3": level >= 3,
        "level_5": level >= 5,
        "level_10": level >= 10,
        "cartographer": named_entities >= 5,
    }

    granted = []
    for achievement_id, condition in conditions.items():
        if achievement_id not in unlocked and condition:
            result = grant_achievement(db_path, player_id, achievement_id)
            if result.get("unlocked"):
                granted.append(result)

    return granted


def check_skill_unlocks(db_path: str = DEFAULT_DB_PATH, player_id: str = "default") -> list[dict]:
    """Auto-unlock all skills the player qualifies for by level and prerequisites.

    Iterates until no more skills can be unlocked (handles prerequisite chains).
    Returns a list of newly unlocked skills.
    """
    newly_unlocked = []
    # Loop to handle chains: unlocking A may enable B which enables C
    while True:
        conn = get_connection(db_path)
        player = conn.execute("SELECT level FROM players WHERE player_id=?", (player_id,)).fetchone()
        if not player:
            conn.close()
            break

        level = player["level"]
        unlocked_ids = {r["skill_id"] for r in
                        conn.execute("SELECT skill_id FROM player_skills WHERE player_id=?",
                                     (player_id,)).fetchall()}

        # Find skills eligible: level met, not yet unlocked, prerequisite unlocked (or no prerequisite)
        candidates = conn.execute(
            "SELECT * FROM skill_trees WHERE unlock_level <= ? ORDER BY unlock_level",
            (level,)).fetchall()
        conn.close()

        batch = []
        for skill in candidates:
            sid = skill["skill_id"]
            if sid in unlocked_ids:
                continue
            parent = skill["parent_skill_id"]
            if parent and parent not in unlocked_ids:
                continue
            batch.append(skill)

        if not batch:
            break

        for skill in batch:
            result = unlock_skill(db_path, player_id, skill["skill_id"])
            if result.get("unlocked"):
                newly_unlocked.append(result)

    return newly_unlocked
