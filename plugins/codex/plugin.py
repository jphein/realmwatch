"""Codex plugin — the Realm Codex.

Wave 3 expansion: absorbs os.realm.watch's lore-keeper server. The plugin
now owns FOUR responsibilities, layered:

1. Notion sync (legacy) — fetch lore/architecture/reference entries from a
   Notion database and serve them via /codex-sync. Backed by realmwatch's
   repo-root `codex_sync.py` (Notion fetcher, in-memory cache).

2. Codex entries CRUD — world-lore wiki backed by game.db's `codex_entries`
   table (HTTP: /codex/entries).

3. Node lore CRUD — per-entity backstory + personality, game.db `node_lore`
   (HTTP: /codex/node-lore).

4. Chronicles CRUD — historical event narratives, game.db `chronicles`
   (HTTP: /codex/chronicles). Also exposes chronicle hooks via
   ctx.expose_api() so progression / quest-forge can record level-ups,
   XP grants, achievements, and quest completions automatically.

DB layout:
- Legacy: realm.db (Notion sync state lives in-process cache only — no DB).
- New:    game.db (~/.realmwatch/game.db) for codex_entries, node_lore,
          chronicles, journal_entries.

Realm-engine plugin also creates the same game-DB tables. CREATE IF NOT
EXISTS makes the order irrelevant.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure realmwatch repo root is importable so we can pick up
# realm_text (ulid) and the legacy codex_sync module.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Legacy Notion sync (still serving /codex-sync).
import codex_sync  # noqa: E402

# New game-DB lore-keeper logic.
from . import chronicle_hooks  # noqa: E402
from .db import DEFAULT_DB_PATH, create_database  # noqa: E402
from .server import (  # noqa: E402
    add_chronicle,
    add_journal_entry,
    get_chronicles,
    get_codex_entry,
    get_journal,
    get_node_lore,
    list_codex_categories,
    list_node_lore,
    set_node_lore,
    upsert_codex_entry,
)


_MAP_DIR = str(_REPO_ROOT)
DB_PATH = os.environ.get("REALM_GAME_DB", DEFAULT_DB_PATH)
DEFAULT_PLAYER_ID = "default"


# ────────────────────────────────────────────────────────────────────────────
# Legacy Notion-sync handlers (preserved verbatim from pre-Wave-3 codex plugin)
# ────────────────────────────────────────────────────────────────────────────

def handle_codex_sync(req, params):
    """GET /codex-sync — fetch codex entries from Notion, optionally force refresh."""
    try:
        force = "force=1" in req.path
        if force:
            codex_sync.fetch_codex(force=True)
        data = codex_sync.get_grouped()
        return data
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


def handle_codex(req, params):
    """GET /codex — redirect to /codex/."""
    req.redirect("/codex/")
    return None


def handle_codex_index(req, params):
    """GET /codex/ — serve the codex HTML page."""
    codex_path = os.path.join(_MAP_DIR, "docs", "codex", "index.html")
    if os.path.isfile(codex_path):
        req._handler.path = "/docs/codex/index.html"
        req._handler._serve_static_gzip()
    else:
        req._handler.send_error(404, "Codex not found")
    return None


# ────────────────────────────────────────────────────────────────────────────
# New game-DB CRUD handlers (lore-keeper absorbed)
# ────────────────────────────────────────────────────────────────────────────

# ── codex_entries ─────────────────────────────────────────────────────────────

def _handle_entries_get(req, _params):
    """GET /codex/entries[?id=...][&category=...]
    - id     -> single entry
    - category -> filtered list
    - neither -> all entries (plus categories enumeration in the wrapper).
    """
    qp = req.query_params
    codex_id = qp.get("id") or qp.get("codex_id")
    category = qp.get("category")

    if codex_id:
        result = get_codex_entry(DB_PATH, codex_id=codex_id)
        if isinstance(result, dict) and result.get("error"):
            req.respond(result, status=404)
            return
        req.respond({"entry": result})
        return

    entries = get_codex_entry(DB_PATH, category=category)
    req.respond({
        "entries": entries,
        "count": len(entries) if isinstance(entries, list) else 0,
        "categories": list_codex_categories(DB_PATH),
    })


def _handle_entries_post(req, _params):
    """POST /codex/entries — upsert a codex entry.

    Body shape:
        {codex_id, category, fantasy_name, technical_name, summary,
         lore_text?, technical_text?}
    """
    body = req.json() or {}
    codex_id = (body.get("codex_id") or "").strip()
    if not codex_id:
        req.respond({"error": "codex_id is required"}, status=400)
        return
    result = upsert_codex_entry(
        DB_PATH,
        codex_id=codex_id,
        category=body.get("category") or "uncategorized",
        fantasy_name=body.get("fantasy_name") or codex_id,
        technical_name=body.get("technical_name") or codex_id,
        summary=body.get("summary") or "",
        lore_text=body.get("lore_text"),
        technical_text=body.get("technical_text"),
    )
    req.respond({"ok": True, "entry": result})


# ── node_lore ─────────────────────────────────────────────────────────────────

def _handle_node_lore_get(req, _params):
    """GET /codex/node-lore[?entity_id=...]"""
    entity_id = req.query_params.get("entity_id")
    if entity_id:
        lore = get_node_lore(DB_PATH, entity_id=entity_id)
        if lore is None:
            req.respond({"error": "no lore found", "entity_id": entity_id}, status=404)
            return
        req.respond({"lore": lore})
        return
    try:
        limit = max(1, min(int(req.query_params.get("limit") or 100), 1000))
    except (TypeError, ValueError):
        limit = 100
    entries = list_node_lore(DB_PATH, limit=limit)
    req.respond({"lore": entries, "count": len(entries)})


def _handle_node_lore_post(req, _params):
    """POST /codex/node-lore — upsert lore for an entity.

    Body shape: {entity_id, backstory, personality?}
    """
    body = req.json() or {}
    entity_id = (body.get("entity_id") or "").strip()
    backstory = body.get("backstory") or ""
    if not entity_id or not backstory:
        req.respond({"error": "entity_id and backstory are required"}, status=400)
        return
    result = set_node_lore(
        DB_PATH,
        entity_id=entity_id,
        backstory=backstory,
        personality=body.get("personality"),
    )
    req.respond({"ok": True, "lore": result})


# ── chronicles ────────────────────────────────────────────────────────────────

def _handle_chronicles_get(req, _params):
    """GET /codex/chronicles[?limit=N] — recent chronicles, newest first."""
    try:
        limit = max(1, min(int(req.query_params.get("limit") or 20), 500))
    except (TypeError, ValueError):
        limit = 20
    entries = get_chronicles(DB_PATH, limit=limit)
    req.respond({"chronicles": entries, "count": len(entries)})


def _handle_chronicles_post(req, _params):
    """POST /codex/chronicles — add a chronicle.

    Body shape: {title, narrative, event_id?}
    """
    body = req.json() or {}
    title = body.get("title") or ""
    narrative = body.get("narrative") or ""
    if not title or not narrative:
        req.respond({"error": "title and narrative are required"}, status=400)
        return
    result = add_chronicle(
        DB_PATH,
        event_id=body.get("event_id"),
        title=title,
        narrative=narrative,
    )
    req.respond({"ok": True, "chronicle": result})


# ── journal ───────────────────────────────────────────────────────────────────

def _handle_journal_get(req, _params):
    """GET /codex/journal[?player_id=...][&entry_type=...][&limit=N]"""
    qp = req.query_params
    player_id = qp.get("player_id") or DEFAULT_PLAYER_ID
    entry_type = qp.get("entry_type")
    try:
        limit = max(1, min(int(qp.get("limit") or 20), 500))
    except (TypeError, ValueError):
        limit = 20
    entries = get_journal(DB_PATH,
                          player_id=player_id,
                          entry_type=entry_type,
                          limit=limit)
    req.respond({"entries": entries, "count": len(entries),
                 "player_id": player_id})


def _handle_journal_post(req, _params):
    """POST /codex/journal — add a journal entry.

    Body shape: {player_id?, entry_type?, title, content, entity_id?, quest_id?}
    """
    body = req.json() or {}
    title = body.get("title") or ""
    content = body.get("content") or ""
    if not title or not content:
        req.respond({"error": "title and content are required"}, status=400)
        return
    result = add_journal_entry(
        DB_PATH,
        player_id=body.get("player_id") or DEFAULT_PLAYER_ID,
        entry_type=body.get("entry_type") or "observation",
        title=title,
        content=content,
        entity_id=body.get("entity_id"),
        quest_id=body.get("quest_id"),
    )
    req.respond({"ok": True, "entry": result})


# ────────────────────────────────────────────────────────────────────────────
# Realm event hooks — chronicle ambient game events automatically.
# ────────────────────────────────────────────────────────────────────────────

def _on_xp_grant(event):
    """Chronicle XP grants (best-effort; never raise)."""
    try:
        amount = int(event.get("amount") or 0)
        if amount <= 0:
            return
        chronicle_hooks.chronicle_xp_granted(
            DB_PATH,
            amount=amount,
            quest_title=event.get("quest_title") or "",
            source_type=event.get("source_type") or "event",
        )
    except Exception as e:
        print(f"[codex] chronicle_xp_granted failed: {e}")


def _on_level_up(event):
    """Chronicle level-up events."""
    try:
        new_level = int(event.get("new_level") or 0)
        if new_level <= 0:
            return
        chronicle_hooks.chronicle_level_up(
            DB_PATH,
            player_name=event.get("player_name") or "The Watcher",
            new_level=new_level,
        )
    except Exception as e:
        print(f"[codex] chronicle_level_up failed: {e}")


def _on_achievement_unlocked(event):
    """Chronicle achievement unlocks."""
    try:
        name = event.get("achievement_name") or event.get("name") or ""
        if not name:
            return
        chronicle_hooks.chronicle_achievement_unlocked(
            DB_PATH,
            achievement_name=name,
            player_name=event.get("player_name") or "The Watcher",
        )
    except Exception as e:
        print(f"[codex] chronicle_achievement_unlocked failed: {e}")


def _on_quest_completed(event):
    """Chronicle quest completions."""
    try:
        title = event.get("quest_title") or event.get("title") or ""
        if not title:
            return
        chronicle_hooks.chronicle_quest_completed(
            DB_PATH,
            quest_title=title,
            quest_description=event.get("description") or "",
            event_id=event.get("event_id"),
        )
    except Exception as e:
        print(f"[codex] chronicle_quest_completed failed: {e}")


# ────────────────────────────────────────────────────────────────────────────
# setup()
# ────────────────────────────────────────────────────────────────────────────

def setup(ctx):
    """Plugin entry point."""
    # Idempotent schema creation. realm-engine creates the same tables; whichever
    # plugin runs first wins, CREATE IF NOT EXISTS makes the other a no-op.
    try:
        create_database(DB_PATH)
        print(f"[codex] game.db schema ensured at {DB_PATH}")
    except Exception as e:
        print(f"[codex] WARN create_database failed: {e}")

    # ── API exposure ──
    ctx.expose_api({
        # Notion sync (legacy callers — DO NOT remove without coordinating
        # with whoever depends on get_grouped / fetch_codex).
        "fetch_codex": codex_sync.fetch_codex,
        "get_grouped": codex_sync.get_grouped,

        # New world-lore CRUD (game.db).
        "get_codex_entry": get_codex_entry,
        "upsert_codex_entry": upsert_codex_entry,
        "list_codex_categories": list_codex_categories,
        "get_node_lore": get_node_lore,
        "list_node_lore": list_node_lore,
        "set_node_lore": set_node_lore,
        "get_chronicles": get_chronicles,
        "add_chronicle": add_chronicle,
        "get_journal": get_journal,
        "add_journal_entry": add_journal_entry,

        # Chronicle hooks (consumed by progression / quest-forge for loose
        # coupling — names match progression's _chronicle_*() expectations).
        "chronicle_quest_completed": chronicle_hooks.chronicle_quest_completed,
        "chronicle_xp_granted": chronicle_hooks.chronicle_xp_granted,
        "chronicle_level_up": chronicle_hooks.chronicle_level_up,
        "chronicle_achievement_unlocked": chronicle_hooks.chronicle_achievement_unlocked,
    })

    # New HTTP endpoints (raw_path=True so they live at /codex/* not
    # /plugins/codex/*; matches the established lore-keeper public path).
    ctx.register_endpoint("GET",  "/codex/entries",    _handle_entries_get,    raw_path=True)
    ctx.register_endpoint("POST", "/codex/entries",    _handle_entries_post,   raw_path=True)
    ctx.register_endpoint("GET",  "/codex/node-lore",  _handle_node_lore_get,  raw_path=True)
    ctx.register_endpoint("POST", "/codex/node-lore",  _handle_node_lore_post, raw_path=True)
    ctx.register_endpoint("GET",  "/codex/chronicles", _handle_chronicles_get, raw_path=True)
    ctx.register_endpoint("POST", "/codex/chronicles", _handle_chronicles_post, raw_path=True)
    ctx.register_endpoint("GET",  "/codex/journal",    _handle_journal_get,    raw_path=True)
    ctx.register_endpoint("POST", "/codex/journal",    _handle_journal_post,   raw_path=True)

    # Subscribe to ambient realm events so chronicles auto-populate.
    ctx.on_event("xp.grant", _on_xp_grant)
    ctx.on_event("level.up", _on_level_up)
    ctx.on_event("achievement.unlocked", _on_achievement_unlocked)
    ctx.on_event("quest.completed", _on_quest_completed)

    ctx.log("The Codex of Realms — Notion sync + lore-keeper ready")
    print("[codex] plugin loaded — Notion sync + game-DB CRUD + chronicle hooks")
