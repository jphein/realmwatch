"""Progression plugin — XP, levels, skill trees, achievements.

Wave 2 migration from os.realm.watch/servers/progression. Backed by the
game sidecar DB at ~/.realmwatch/game.db (not realm.db — that's a v0.6
decision per the Wave 2 briefing).

HTTP surface (raw_path=True):
- GET  /progression/player         — current player's level/XP info
- GET  /progression/skills         — skill trees + which the player has unlocked
- POST /progression/xp             — grant XP (admin/manual)

Event coupling:
- Listens for "xp.grant" plugin events for cross-plugin XP awards.

Inter-plugin coupling:
- Reads the codex plugin's exposed API for chronicle hooks (loose coupling
  via ctx.get_plugin_api). codex (Mistwalker, Wave 3) absorbed lore-keeper
  and now publishes chronicle_xp_granted / chronicle_level_up /
  chronicle_achievement_unlocked under the "codex" plugin name. If codex
  isn't loaded, chronicle calls silently no-op — XP/level path stays
  functional.
- Reads realm-engine's entities table directly for the "cartographer"
  achievement counter. We tolerate the table being absent on a fresh
  game.db (try/except in check_achievements).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Ensure the realmwatch repo root is importable for `realm_text` (lives
# at repo root, ported by Reverie in Wave 1). The plugin loader doesn't
# guarantee sys.path includes the project root for relative-package
# imports beyond the plugin dir itself.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from .db import DEFAULT_DB_PATH, create_database, get_connection  # noqa: E402
from .server import (  # noqa: E402
    check_achievements,
    check_skill_unlocks,
    ensure_player,
    get_level_info,
    get_skill_tree,
    grant_achievement,
    grant_xp,
    list_player_skills,
    set_codex_api,
    unlock_skill,
)


# Where the game DB lives. Override via env for tests.
DB_PATH = os.environ.get("REALM_GAME_DB", DEFAULT_DB_PATH)
DEFAULT_PLAYER_ID = "default"


# ── HTTP handlers ────────────────────────────────────────────────────────────

def _handle_player(req, _params):
    """GET /progression/player — level/XP info + unlocked skills."""
    player_id = (req.query_params.get("player_id") or DEFAULT_PLAYER_ID)
    info = get_level_info(DB_PATH, player_id=player_id)
    info["skills"] = list_player_skills(DB_PATH, player_id=player_id)
    req.respond(info)


def _handle_xp_post(req, _params):
    """POST /progression/xp — grant XP. Body: {player_id, amount, source_type, quest_id}."""
    body = req.json() or {}
    player_id = body.get("player_id") or DEFAULT_PLAYER_ID
    try:
        amount = int(body.get("amount") or 0)
    except (TypeError, ValueError):
        req.respond({"error": "amount must be an integer"}, status=400)
        return
    source_type = body.get("source_type") or "manual"
    quest_id = body.get("quest_id")
    ensure_player(DB_PATH, player_id=player_id)
    result = grant_xp(DB_PATH, player_id=player_id, amount=amount,
                      source_type=source_type, quest_id=quest_id)
    req.respond({"ok": True, "player": result})


def _handle_skills(req, _params):
    """GET /progression/skills?tree=networking — full skill tree + unlock state."""
    tree = req.query_params.get("tree") or "networking"
    player_id = req.query_params.get("player_id") or DEFAULT_PLAYER_ID
    tree_rows = get_skill_tree(DB_PATH, tree=tree)
    unlocked = {s["skill_id"] for s in list_player_skills(DB_PATH, player_id=player_id)}
    for r in tree_rows:
        r["unlocked"] = r["skill_id"] in unlocked
    req.respond({"tree": tree, "skills": tree_rows})


def _handle_unlock_skill(req, _params):
    """POST /progression/unlock_skill — body {player_id, skill_id}."""
    body = req.json() or {}
    player_id = body.get("player_id") or DEFAULT_PLAYER_ID
    skill_id = body.get("skill_id") or ""
    if not skill_id:
        req.respond({"error": "skill_id required"}, status=400)
        return
    result = unlock_skill(DB_PATH, player_id=player_id, skill_id=skill_id)
    status = 200 if (result.get("unlocked") or result.get("already_unlocked")) else 400
    req.respond(result, status=status)


def _handle_grant_achievement(req, _params):
    """POST /progression/grant_achievement — body {player_id, achievement_id}."""
    body = req.json() or {}
    player_id = body.get("player_id") or DEFAULT_PLAYER_ID
    achievement_id = body.get("achievement_id") or ""
    if not achievement_id:
        req.respond({"error": "achievement_id required"}, status=400)
        return
    result = grant_achievement(DB_PATH, player_id=player_id, achievement_id=achievement_id)
    req.respond(result)


# ── Realm-event hook: cross-plugin XP grants ─────────────────────────────────

def _on_xp_grant(event):
    """Handle 'xp.grant' realm events.

    Expected payload:
        {amount: int, source_type: str, quest_id: str?, player_id: str?}
    """
    try:
        amount = int(event.get("amount") or 0)
    except (TypeError, ValueError):
        return
    if amount <= 0:
        return
    player_id = event.get("player_id") or DEFAULT_PLAYER_ID
    source_type = event.get("source_type") or "event"
    quest_id = event.get("quest_id")
    ensure_player(DB_PATH, player_id=player_id)
    grant_xp(DB_PATH, player_id=player_id, amount=amount,
             source_type=source_type, quest_id=quest_id)


# ── setup ─────────────────────────────────────────────────────────────────────

def setup(ctx):
    """Plugin entry point. Called by plugin_loader after manifest validation."""
    # Idempotent schema creation. The realm-engine plugin (Somnus, Wave 2)
    # will create the same overlapping subset; CREATE IF NOT EXISTS makes
    # whichever fires first the no-op for the other.
    create_database(DB_PATH)
    print(f"[progression] game.db ready at {DB_PATH}")

    # Ensure the default player row exists so /progression/player works
    # without callers having to POST first.
    player = ensure_player(DB_PATH, player_id=DEFAULT_PLAYER_ID, player_name="The Watcher")
    print(f"[progression] default player: level={player.get('level')} "
          f"xp={player.get('total_xp')}")

    # Loose-couple to the codex plugin for chronicle hooks. Codex absorbed
    # lore-keeper during the Wave 3 os.realm.watch migration — it now
    # publishes chronicle_xp_granted / chronicle_level_up /
    # chronicle_achievement_unlocked under the "codex" plugin name. If
    # codex isn't loaded the chronicle calls remain silent no-ops.
    codex_api = ctx.get_plugin_api("codex")
    set_codex_api(codex_api)
    if codex_api:
        print("[progression] wired chronicle hooks to codex plugin API")
    else:
        print("[progression] codex not loaded — chronicle hooks no-op")

    # Expose our public API for other plugins (quest-forge in particular
    # will want to call grant_xp() when a quest enters the 'rewarded'
    # state). Loose-coupled, mirrors the lexicon/realm-engine pattern.
    ctx.expose_api({
        "grant_xp": grant_xp,
        "get_level_info": get_level_info,
        "ensure_player": ensure_player,
        "check_achievements": check_achievements,
        "check_skill_unlocks": check_skill_unlocks,
        "grant_achievement": grant_achievement,
        "unlock_skill": unlock_skill,
        "list_player_skills": list_player_skills,
        "get_skill_tree": get_skill_tree,
    })

    # HTTP endpoints — raw_path=True so we mount at /progression/* and
    # not /plugins/progression/* (this preserves the public-facing path
    # shape from os.realm.watch's HTTP layer for downstream skills).
    ctx.register_endpoint("GET", "/progression/player", _handle_player, raw_path=True)
    ctx.register_endpoint("POST", "/progression/xp", _handle_xp_post, raw_path=True)
    ctx.register_endpoint("GET", "/progression/skills", _handle_skills, raw_path=True)
    ctx.register_endpoint("POST", "/progression/unlock_skill", _handle_unlock_skill, raw_path=True)
    ctx.register_endpoint("POST", "/progression/grant_achievement",
                          _handle_grant_achievement, raw_path=True)

    # Realm-event subscription. quest-forge / combat-ward (Wave 3) will
    # fire 'xp.grant' events on quest completion or threat resolution.
    ctx.on_event("xp.grant", _on_xp_grant)

    print("[progression] plugin loaded — 5 endpoints + xp.grant handler")
