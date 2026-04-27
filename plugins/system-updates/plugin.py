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


def handle_get_inventory(req, params):
    """GET /api/inventory[?since=<unix-ts>] — slim projection for non-UI consumers.

    Designed for the Claude SessionStart hook at
    ~/.claude/hooks/package-inventory.sh. Returns outdated counts and
    last_check timestamps without the full panel state shape.
    """
    from sources import get_inventory
    since_raw = params.get("_query", {}).get("since", "0")
    try:
        since = float(since_raw)
    except (TypeError, ValueError):
        since = 0.0
    req.respond(get_inventory(since=since))


def handle_get_history(req, params):
    """GET /updates/history[?source=<id>&type=check|update&limit=N] — recent runs.

    Returns the last ``limit`` (default 50) runs newest-first. Optionally
    narrowed by source and/or run_type. Used to render a "Last 10 runs"
    sub-panel in the UI and answer "when did this last succeed?" questions.
    """
    from history import get
    q = params.get("_query", {})
    source_id = q.get("source") or None
    run_type = q.get("type") or None
    try:
        limit = max(1, min(int(q.get("limit", 50)), 500))
    except (TypeError, ValueError):
        limit = 50
    req.respond({"runs": get(source_id=source_id, run_type=run_type, limit=limit)})


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


def _extract_pkg(req, params):
    """Pull the ``pkg`` name from a JSON body or ``?pkg=`` query param.

    Body approach is preferred (clean for scoped npm names like
    ``@scope/name`` — no URL-encoding gotchas) but the query-string
    fallback keeps the endpoint easy to exercise from curl.
    """
    body = req.json() or {}
    pkg = body.get("pkg") if isinstance(body, dict) else None
    if not pkg:
        pkg = params.get("_query", {}).get("pkg")
    return pkg or ""


def handle_approve_one(req, params):
    """POST /updates/approve/<source> — approve a pending script diff.

    Body: ``{"pkg": "<name>"}``. Kicks off the single-package install.
    """
    from runner import approve_package
    source_id = params.get("source", "")
    pkg = _extract_pkg(req, params)
    if not pkg:
        req.respond({"error": "missing 'pkg' in body or query"}, status=400)
        return
    ok = approve_package(source_id, pkg,
                         push_event_fn=_ctx.push_event if _ctx else None)
    if ok:
        req.respond({"status": "approved", "pkg": pkg})
    else:
        req.respond({"error": f"No pending approval for {pkg} on {source_id}"},
                    status=404)


def handle_skip_one(req, params):
    """DELETE /updates/approve/<source> — skip a pending script diff.

    Body: ``{"pkg": "<name>"}``. Adds (pkg, from, to) to skip_list and
    removes the pending entry. Does NOT kick off an install.
    """
    from runner import skip_package
    source_id = params.get("source", "")
    pkg = _extract_pkg(req, params)
    if not pkg:
        req.respond({"error": "missing 'pkg' in body or query"}, status=400)
        return
    ok = skip_package(source_id, pkg)
    if ok:
        req.respond({"status": "skipped", "pkg": pkg})
    else:
        req.respond({"error": f"No pending approval for {pkg} on {source_id}"},
                    status=404)


def setup(ctx):
    """Plugin entry point."""
    global _ctx
    _ctx = ctx

    from runner import init
    init(push_fn=lambda: None)  # SSE getter handles data; broker polls it

    # Idempotent — creates the system_updates_runs table if missing.
    try:
        from history import init as history_init
        history_init()
    except Exception as exc:
        ctx.log("system-updates: history.init failed: %s", exc)

    ctx.register_sse_source(
        event_type="updates",
        getter_fn=_get_sse_data,
        interval=60,
        burst=True,
        burst_priority=8,
    )

    ctx.log("Scroll of Patch Runes active — %d update sources registered",
            len(__import__("sources").SOURCES))
