"""The Quest Forge plugin — auto-generates quests from realm events.

Migrated from os.realm.watch/servers/quest_forge/ during the Wave 2
os.realm.watch → realmwatch consolidation (2026-05-19).

Scope notes (read before extending):

- The `realm quest` CLI hits `/quests`, `/quest-create`, `/quest-update`,
  `/quest-delete` — those handlers live in `map_server.py` today and write
  directly to `~/.realmwatch/game.db`. We do NOT re-register conflicting
  raw_path endpoints here; map_server is the core route table and would
  shadow plugin raw_path routes anyway (PRIORITY_CORE < PRIORITY_RAW_PATH).

- What this plugin owns:
    1. The quest-generation engine (templates, sub-quests, throttle).
    2. An event subscriber that auto-creates quests when interesting
       realmwatch events fire (severity >= 2).
    3. A `/plugins/quests/*` namespaced endpoint surface for visibility +
       direct generate calls (useful for debugging and the MCP plugin).
    4. MCP tool registrations via `mcp_tools.MCP_TOOLS`.

- Future (post Wave 2):
    The map_server `_h_get_api_quests` / `_h_post_quest_*` handlers should
    move into this plugin so the core can shrink. Doing it now would risk
    breaking the live `realm quest` CLI mid-wave — deferred to wave 3+.
"""

from __future__ import annotations

import json

from . import db as quest_db
from . import server as quest_server
from .throttle import clear_cooldowns


# Realmwatch event types that the existing core also routes through fire_event.
# We listen on a permissive set — the throttle + severity gate filter further.
_EVENT_TYPES_OF_INTEREST = (
    "alert",
    "system",
    "discovery",
    "speech",
    "quest",
)


def setup(ctx):
    """Plugin setup — bootstrap schema, wire event subscription, expose API."""
    db_path = quest_db.DEFAULT_DB_PATH

    # Ensure quest tables exist (idempotent). game.db is shared with map_server
    # which already creates the tables — this is belt-and-suspenders for
    # fresh installs that load the plugin before map_server's bootstrap.
    try:
        quest_db.create_database(db_path)
    except Exception as e:  # pragma: no cover - first-run failure logged but non-fatal
        print(f"[quests] WARN: could not bootstrap game.db at {db_path}: {e}")

    def _on_event(event):
        """Try to mint a quest from any sufficiently severe realm event."""
        try:
            severity = int(event.get("severity") or 0)
        except (TypeError, ValueError):
            severity = 0
        if severity < 2:
            return
        try:
            row = quest_server.generate_quest_from_event_dict(event, db_path=db_path)
        except Exception as e:
            print(f"[quests] generation error for event {event.get('id')}: {e}")
            return
        if row:
            print(f"[quests] forged: {row.get('title')!r} "
                  f"(severity={severity}, node={event.get('node')!r})")
            # Broadcast to the SSE bus so the UI can refresh the quest log.
            try:
                ctx.push_event("plugin-broadcast", {
                    "kind": "quest-created",
                    "quest_id": row.get("quest_id"),
                    "title": row.get("title"),
                })
            except Exception:
                pass

    for evt_type in _EVENT_TYPES_OF_INTEREST:
        ctx.on_event(evt_type, _on_event)

    # ── Plugin-namespaced endpoints (for /debug visibility and MCP fallback) ──
    # These live under /plugins/quests/ — they don't conflict with the
    # CLI-facing /quests endpoints in map_server.

    def _list_handler(req, params):
        status = (params.get("_query") or {}).get("status")
        try:
            limit = int((params.get("_query") or {}).get("limit", "50"))
        except ValueError:
            limit = 50
        return quest_server.list_quests(db_path=db_path, status=status, limit=limit)

    def _get_handler(req, params):
        # Path param strips the /plugins/quests/get/<quest_id> prefix.
        # Using a distinct /get/ segment keeps this from shadowing list/stats
        # via the wildcard (the route_table prefers raw_path over namespaced
        # at equal specificity, so /plugins/quests/<quest_id> would otherwise
        # eat /plugins/quests/list as quest_id="list").
        quest_id = params.get("quest_id", "")
        result = quest_server.get_quest(db_path=db_path, quest_id=quest_id)
        if result is None:
            req.respond({"error": "not found"}, 404)
            return None
        return result

    def _generate_handler(req, params):
        try:
            body = req.json() or {}
        except Exception:
            body = {}
        # Accept either {event: {...full event dict...}} or {event_id: "..."}.
        evt = body.get("event")
        if isinstance(evt, dict):
            row = quest_server.generate_quest_from_event_dict(evt, db_path=db_path)
        else:
            event_id = body.get("event_id", "")
            row = quest_server.generate_quest_from_event(
                db_path=db_path, event_id=event_id)
        return {"ok": row is not None, "quest": row}

    def _accept_handler(req, params):
        return quest_server.activate_quest(db_path=db_path, quest_id=params.get("quest_id", ""))

    def _complete_handler(req, params):
        row = quest_server.get_quest(
            db_path=db_path, quest_id=params.get("quest_id", ""))
        if row is None:
            req.respond({"error": "not found"}, 404)
            return None
        # If it's a sub-quest, use the cascading completer.
        if row.get("parent_quest_id"):
            return quest_server.complete_sub_quest(
                db_path=db_path, quest_id=params.get("quest_id", ""))
        return quest_server.resolve_quest(
            db_path=db_path, quest_id=params.get("quest_id", ""))

    def _stats_handler(req, params):
        """Plugin diagnostic — exposed at /plugins/quests/stats."""
        conn = quest_db.get_connection(db_path)
        try:
            counts = {}
            for state in ("created", "active", "resolved", "rewarded", "archived"):
                counts[state] = conn.execute(
                    "SELECT COUNT(*) FROM quests WHERE status=?",
                    (state,)).fetchone()[0]
            total = conn.execute("SELECT COUNT(*) FROM quests").fetchone()[0]
        finally:
            conn.close()
        return {
            "db_path": db_path,
            "total_quests": total,
            "by_status": counts,
            "template_count": len(quest_server._TEMPLATES),
        }

    ctx.register_endpoint("GET", "list", _list_handler)
    ctx.register_endpoint("GET", "stats", _stats_handler)
    # Use /get/<quest_id> rather than /<quest_id> to avoid shadowing list/stats.
    ctx.register_endpoint("GET", "get/<quest_id>", _get_handler)
    ctx.register_endpoint("POST", "generate", _generate_handler)
    ctx.register_endpoint("POST", "accept/<quest_id>", _accept_handler)
    ctx.register_endpoint("POST", "complete/<quest_id>", _complete_handler)

    # ── Public API for other plugins ──
    ctx.expose_api({
        "generate_from_event_dict": lambda evt: quest_server.generate_quest_from_event_dict(
            evt, db_path=db_path),
        "generate_from_event_id": lambda eid: quest_server.generate_quest_from_event(
            db_path=db_path, event_id=eid),
        "list": lambda **kw: quest_server.list_quests(db_path=db_path, **kw),
        "get": lambda quest_id: quest_server.get_quest(db_path=db_path, quest_id=quest_id),
        "activate": lambda quest_id: quest_server.activate_quest(
            db_path=db_path, quest_id=quest_id),
        "resolve": lambda quest_id: quest_server.resolve_quest(
            db_path=db_path, quest_id=quest_id),
        "complete_sub": lambda quest_id: quest_server.complete_sub_quest(
            db_path=db_path, quest_id=quest_id),
        "create_sub": lambda parent, title, **kw: quest_server.create_sub_quest(
            db_path=db_path, parent_quest_id=parent, title=title, **kw),
        "clear_cooldowns": clear_cooldowns,
        "db_path": db_path,
    })

    ctx.log(f"Quest Forge ready — game.db at {db_path}, "
            f"{len(quest_server._TEMPLATES)} templates loaded, "
            f"subscribed to {len(_EVENT_TYPES_OF_INTEREST)} event types")
    print(f"[quests] The Quest Forge online — "
          f"{len(quest_server._TEMPLATES)} templates, db={db_path}")
