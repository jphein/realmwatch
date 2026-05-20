"""The Realm Engine plugin — game state, event ingestion, entity queries.

Migrated from os.realm.watch/servers/realm_engine 2026-05-19.

What this plugin does inside realmwatch:
- Opens (and migrates if needed) the game DB at ~/.realmwatch/game.db.
- Subscribes to realmwatch's "realm-event" event bus and ingests each
  matching event into the game DB. This is the in-process replacement
  for the deleted SSE-pull ingest.py.
- Exposes a /realm-engine/info endpoint for diagnostics.
- Publishes its API + MCP tool list via ctx.expose_api() so the mcp plugin
  (Wave 1.5 follow-up) can pick them up.
"""

from __future__ import annotations

import sys
from pathlib import Path

from realm_text import real_home


# Make sure lexicon python lib is importable for downstream (the original
# server.py didn't need this, but adjacent realmwatch utilities do — keep
# the pattern consistent with plugins/lexicon).
_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
if _LEXICON_PY.exists() and str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))

# Make the plugin directory importable as a package (so `from . import ...`
# works inside the modules we ship).
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR.parent))


# Relative imports (this file is loaded as plugins.realm-engine.plugin via
# plugin_loader, so . refers to plugins/realm-engine/).
from . import server  # noqa: E402
from . import mcp_tools  # noqa: E402
from .db import DEFAULT_DB_PATH  # noqa: E402


# Module-level handle on the game DB path — exposed so other plugins can
# point at the same SQLite file (sidecar approach, per WAVE2-BRIEFING).
GAME_DB_PATH = DEFAULT_DB_PATH


def _log(msg: str) -> None:
    """Plugin-prefixed stdout, force-flushed so it survives buffering."""
    print(f"[realm-engine] {msg}", flush=True)


# ── Plugin entry point ───────────────────────────────────────────────────

def setup(ctx):
    """Register event handler + diagnostic endpoint."""

    # 1) Open / migrate the game DB.
    try:
        server.ensure_db(GAME_DB_PATH)
        _log(f"game DB ready at {GAME_DB_PATH}")
    except Exception as e:
        _log(f"ERROR creating game DB at {GAME_DB_PATH}: {e}")
        # Don't bail — the rest of the plugin still has value (the MCP
        # tools will surface the error to the client).

    # 2) Subscribe to the realm-event bus. This replaces the old ingest.py
    #    which used to poll realmwatch's /sse stream from outside the process.
    #
    # NOTE: realmwatch's plugin registry dispatches events by their `type`
    # field (e.g. "alert", "scan", "speech"), NOT by the SSE channel name.
    # "realm-event" is the SSE-side channel name. To mirror the old
    # ingest.py behaviour (every event SSE'd → into game DB), we wrap
    # map_server.push_event so we see every event regardless of type.
    def _ingest(evt: dict) -> None:
        if not isinstance(evt, dict):
            return
        event_type = evt.get("type") or evt.get("event_type") or ""
        if not event_type:
            return
        try:
            server.ingest_event(
                db_path=GAME_DB_PATH,
                event_type=str(event_type),
                source_system=str(
                    evt.get("source") or evt.get("source_system") or "realmwatch"
                ),
                severity=int(evt.get("severity", 0) or 0),
                confidence=int(evt.get("confidence", 70) or 70),
                payload=evt,
                entity_id=evt.get("entity_id"),
                correlation_id=evt.get("correlation_id"),
            )
        except Exception as e:
            # Never let an ingest error tank the event bus.
            _log(f"ingest_event failed for {event_type!r}: {e}")

    # As JP's brief specifies, register on the "realm-event" name. This
    # is a no-op under the current registry but documents intent and
    # remains future-proof if the registry adds SSE-channel routing.
    ctx.on_event("realm-event", _ingest)

    # The functional path: wrap push_event so every persisted event is
    # also ingested into game.db. Idempotent — installing twice is safe
    # (we tag the wrapper).
    #
    # map_server.py is typically loaded as __main__ (when run via
    # `python map_server.py`), but its module object also lives under the
    # name "map_server" if anything imports it later. The HTTP request
    # handler `_h_post_event` looks up `push_event` in its DEFINING
    # module's globals — which is __main__ when run as a script.
    # Therefore we patch every module instance that has a `push_event`
    # attribute, not just the one we can import.
    try:
        _orig_push = None
        _patch_targets = []
        for mod_name in ("__main__", "map_server"):
            mod = sys.modules.get(mod_name)
            if mod is None:
                continue
            fn = getattr(mod, "push_event", None)
            if fn is None:
                continue
            if getattr(fn, "_realm_engine_wrapped", False):
                _orig_push = fn  # already wrapped — reuse
                continue
            if _orig_push is None:
                _orig_push = fn
            _patch_targets.append(mod)

        if _orig_push is None:
            _log("push_event not found on __main__ or map_server — skipping wrap")
        elif not _patch_targets:
            _log("push_event already wrapped on all known modules")
        else:
            def push_event_wrapped(event):
                stored = _orig_push(event)
                try:
                    _ingest(stored if isinstance(stored, dict) else event)
                except Exception as e:
                    _log(f"push_event wrapper ingest error: {e}")
                return stored

            push_event_wrapped._realm_engine_wrapped = True  # type: ignore[attr-defined]
            for mod in _patch_targets:
                setattr(mod, "push_event", push_event_wrapped)
            _log(
                "wrapped push_event on: "
                + ", ".join(getattr(m, "__name__", "?") for m in _patch_targets)
            )
    except Exception as e:
        _log(f"could not wrap push_event: {e}")

    # 3) Expose API for other plugins (especially the mcp plugin in 1.5).
    ctx.expose_api({
        "db_path": GAME_DB_PATH,
        "realm_status": server.realm_status,
        "ingest_event": server.ingest_event,
        "get_profile": server.get_profile,
        "update_profile": server.update_profile,
        "list_entities": server.list_entities,
        "get_entity": server.get_entity,
        "get_recent_events": server.get_recent_events,
        "mcp_tools": mcp_tools.MCP_TOOLS,
    })

    # 4) /realm-engine/info diagnostic endpoint.
    def _info_handler(req, params):
        try:
            status = server.realm_status(GAME_DB_PATH)
        except Exception as e:
            return req.respond({
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "db_path": GAME_DB_PATH,
            }, status=500)
        return req.respond({
            "ok": True,
            "db_path": GAME_DB_PATH,
            "db_exists": os.path.exists(GAME_DB_PATH),
            "status": status,
            "mcp_tools": [t[0] for t in mcp_tools.MCP_TOOLS],
            "notes": (
                "entity resolution: Option B fallback (direct DB get_entity, "
                "no entity_resolver). Reconcile in Wave 3."
            ),
        })

    ctx.register_endpoint("GET", "/realm-engine/info", _info_handler, raw_path=True)
    _log("/realm-engine/info endpoint registered")
