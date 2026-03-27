"""System Updates plugin — Scroll of Patch Runes."""

import os
import sys

# Add plugin directory to sys.path so runner.py and sources.py are importable
_plugin_dir = os.path.dirname(os.path.abspath(__file__))
if _plugin_dir not in sys.path:
    sys.path.insert(0, _plugin_dir)

_ctx = None


def _get_sse_data():
    """SSE getter — returns current state of all sources."""
    from sources import get_all_state
    return get_all_state()


def handle_get_updates(req, params):
    """GET /updates — return all sources' current state."""
    from sources import get_all_state
    req.respond(get_all_state())


def handle_check_all(req, params):
    """POST /updates/check — check all sources for available updates."""
    from runner import check_all
    check_all()
    req.respond({"status": "started"})


def handle_check_one(req, params):
    """POST /updates/check/<source> — check one source."""
    from runner import check_source
    source_id = params.get("source", "")
    ok = check_source(source_id)
    if ok:
        req.respond({"status": "started"})
    else:
        req.respond({"error": f"Unknown source: {source_id}"}, status=404)


def handle_run_all(req, params):
    """POST /updates/run — run all updates."""
    from runner import run_all
    run_all(push_event_fn=_ctx.push_event if _ctx else None)
    req.respond({"status": "started"})


def handle_run_one(req, params):
    """POST /updates/run/<source> — run one source's update."""
    from runner import run_source
    source_id = params.get("source", "")
    ok = run_source(source_id, push_event_fn=_ctx.push_event if _ctx else None)
    if ok:
        req.respond({"status": "started"})
    else:
        req.respond({"error": f"Unknown or already running: {source_id}"}, status=409)


def handle_cancel_one(req, params):
    """DELETE /updates/run/<source> — cancel a running update."""
    from runner import cancel_source
    source_id = params.get("source", "")
    ok = cancel_source(source_id)
    if ok:
        req.respond({"status": "cancelled"})
    else:
        req.respond({"error": f"Source {source_id} is not running"}, status=404)


def setup(ctx):
    """Plugin entry point."""
    global _ctx
    _ctx = ctx

    from runner import init
    init(push_fn=lambda: None)  # SSE getter handles data; broker polls it

    ctx.register_sse_source(
        event_type="updates",
        getter_fn=_get_sse_data,
        interval=60,
        burst=True,
        burst_priority=8,
    )

    ctx.log("Scroll of Patch Runes active — %d update sources registered",
            len(__import__("sources").SOURCES))
