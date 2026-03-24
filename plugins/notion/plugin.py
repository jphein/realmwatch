"""Notion plugin — syncs Today todos from Notion as quest events.

Delegates to notion_sync for API calls and event generation.
Provides /notion-sync and /notion-complete endpoints.
"""

import notion_sync

# Set by setup()
_push_event = None


def handle_notion_sync(req, params):
    """GET /notion-sync — sync Notion todos, optionally force resync."""
    try:
        if "force=1" in req.path:
            notion_sync.force_resync()
        result = notion_sync.sync_to_events()
        if "error" in result:
            req.respond(result, 503)
            return None
        if _push_event:
            for evt in result.get("events", []):
                _push_event(evt)
        return result
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


def handle_notion_complete(req, params):
    """POST /notion-complete — mark a Notion todo as archived."""
    try:
        data = req.json()
        notion_id = data.get("notion_id", "")
        if not notion_id:
            req.respond({"error": "missing notion_id"}, 400)
            return None
        result = notion_sync.complete(notion_id)
        if "error" in result:
            req.respond(result, 503)
            return None
        if _push_event:
            _push_event({
                "type": "system",
                "node": "notion-portal",
                "text": "A quest has been sealed in the archives.",
            })
        return result
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


def setup(ctx):
    """Plugin setup — store push_event reference, expose notion API."""
    global _push_event
    _push_event = ctx._push_event

    ctx.expose_api({
        "sync_to_events": notion_sync.sync_to_events,
        "fetch_today": notion_sync.fetch_today,
        "complete": notion_sync.complete,
        "force_resync": notion_sync.force_resync,
        "configured": notion_sync.configured,
    })

    ctx.log("Quest Portals notion sync ready")
