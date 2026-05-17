"""Maintenance windows — Veiled Hours.

Schedule planned-downtime windows that silence alerts and herald speech
for matching hosts. Patterns support exact node ids, fnmatch globs, and
the special prefix `role:<name>` to scope by role.

Zabbix-inspired (issue #4).
"""

import fnmatch
import json
import logging
import time
import uuid

import realm_db

log = logging.getLogger(__name__)

_ctx = None
_db = None


# ── DB ──

def _init_table():
    _db.create_table(
        "windows",
        """
        id TEXT PRIMARY KEY,
        name TEXT,
        node_pattern TEXT,
        starts_at REAL,
        ends_at REAL,
        recur TEXT DEFAULT 'once',
        recur_spec TEXT DEFAULT '{}',
        enabled INTEGER DEFAULT 1
        """,
    )


def _list_windows(enabled_only=False):
    where = " WHERE enabled = 1" if enabled_only else ""
    rows = _db.query(
        f"SELECT id, name, node_pattern, starts_at, ends_at, recur, recur_spec, enabled "
        f"FROM plugin_maintenance_windows{where} ORDER BY starts_at"
    )
    out = []
    for r in rows:
        spec = {}
        try:
            spec = json.loads(r.get("recur_spec") or "{}")
        except (json.JSONDecodeError, TypeError):
            pass
        out.append({
            "id": r["id"],
            "name": r.get("name") or "",
            "node_pattern": r.get("node_pattern") or "*",
            "starts_at": r.get("starts_at") or 0,
            "ends_at": r.get("ends_at") or 0,
            "recur": r.get("recur") or "once",
            "recur_spec": spec,
            "enabled": bool(r.get("enabled", 1)),
        })
    return out


# ── Recurrence: is `now` inside a window? ──

def _window_active_now(w, now=None):
    """Return True if `w` is currently in an active interval."""
    now = now if now is not None else time.time()
    if not w.get("enabled", True):
        return False
    recur = w.get("recur", "once")

    start = w.get("starts_at", 0)
    end = w.get("ends_at", 0)
    if end <= start:
        return False

    if recur == "once":
        return start <= now <= end

    # For recurring windows we treat (start, end) as the *first* instance and
    # extrapolate forward. recur_spec.interval_days controls the cadence
    # (default: daily=1, weekly=7, monthly=30).
    spec = w.get("recur_spec") or {}
    interval_days = float(spec.get("interval_days", {
        "daily": 1, "weekly": 7, "monthly": 30,
    }.get(recur, 1)))
    interval_s = interval_days * 86400
    if interval_s <= 0:
        return False

    duration = end - start
    elapsed = now - start
    if elapsed < 0:
        return False
    # Find the most recent instance start
    instance_idx = int(elapsed // interval_s)
    instance_start = start + instance_idx * interval_s
    instance_end = instance_start + duration
    return instance_start <= now <= instance_end


def _node_matches(pattern, node_id, node_role=None):
    """Does this maintenance pattern match a given node?"""
    if not pattern or pattern == "*":
        return True
    if pattern.startswith("role:"):
        return node_role == pattern[len("role:"):]
    if pattern.startswith("tag:"):
        # Tag match — caller should pass node_role only if needed; for tag
        # match we look up node tags from realm_db
        tag = pattern[len("tag:"):]
        node = realm_db.get_node(node_id) or {}
        return tag in (node.get("tags") or [])
    return fnmatch.fnmatch(node_id, pattern)


# ── Public API used by alerting hook + herald ──

def is_in_maintenance(node_id: str) -> dict | None:
    """Return the first active window that covers `node_id`, or None.

    Module-level helper so other plugins / herald can import directly.
    """
    if _db is None:
        return None
    # Look up the node's role for role:<r> patterns
    node_role = None
    try:
        import node_roles
        node = realm_db.get_node(node_id) or {}
        node_role = node_roles.get_role(node_id, node)
    except Exception:
        pass

    for w in _list_windows(enabled_only=True):
        if not _window_active_now(w):
            continue
        if _node_matches(w["node_pattern"], node_id, node_role):
            return w
    return None


# ── HTTP handlers ──

def _h_list_windows(req, params):
    return req.respond({"windows": _list_windows()})


def _h_create_window(req, params):
    """POST /maintenance/windows — schedule a new window.

    Body: {name, node_pattern, starts_at, ends_at, recur, recur_spec, enabled, duration_seconds}
    Either ends_at or (starts_at + duration_seconds) must be present.
    """
    body = req.json() or {}
    name = body.get("name") or ""
    pattern = body.get("node_pattern") or "*"
    starts_at = float(body.get("starts_at") or time.time())
    if "ends_at" in body:
        ends_at = float(body["ends_at"])
    elif "duration_seconds" in body:
        ends_at = starts_at + float(body["duration_seconds"])
    else:
        return req.respond({"error": "missing ends_at or duration_seconds"}, 400)
    recur = body.get("recur") or "once"
    if recur not in ("once", "daily", "weekly", "monthly"):
        return req.respond({"error": f"unknown recur: {recur}"}, 400)
    recur_spec = body.get("recur_spec") or {}
    enabled = 1 if body.get("enabled", True) else 0
    wid = body.get("id") or f"mw-{uuid.uuid4().hex[:8]}"

    _db.execute(
        "INSERT OR REPLACE INTO plugin_maintenance_windows "
        "(id, name, node_pattern, starts_at, ends_at, recur, recur_spec, enabled) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (wid, name, pattern, starts_at, ends_at, recur, json.dumps(recur_spec), enabled),
    )

    log.info("Scheduled maintenance window %s (%s) pattern=%s recur=%s",
             wid, name, pattern, recur)

    return req.respond({
        "id": wid, "name": name, "node_pattern": pattern,
        "starts_at": starts_at, "ends_at": ends_at,
        "recur": recur, "enabled": bool(enabled),
    })


def _h_delete_window(req, params):
    wid = params.get("id", "")
    if not wid:
        return req.respond({"error": "missing id"}, 400)
    _db.execute("DELETE FROM plugin_maintenance_windows WHERE id = ?", (wid,))
    return req.respond({"ok": True, "deleted": wid})


def _h_active_windows(req, params):
    """GET /maintenance/active — windows currently in their active interval."""
    return req.respond([w for w in _list_windows(enabled_only=True) if _window_active_now(w)])


def _h_check_node(req, params):
    """GET /maintenance/check/<node> — is this node currently muted?"""
    node = params.get("node", "")
    if not node:
        return req.respond({"error": "missing node"}, 400)
    window = is_in_maintenance(node)
    return req.respond({
        "node": node,
        "in_maintenance": window is not None,
        "window": window,
    })


# ── Setup ──

def setup(ctx):
    global _ctx, _db
    _ctx = ctx
    _db = ctx.db
    _init_table()

    ctx.register_endpoint("GET",    "/maintenance/windows",     _h_list_windows,   raw_path=True)
    ctx.register_endpoint("POST",   "/maintenance/windows",     _h_create_window,  raw_path=True)
    ctx.register_endpoint("DELETE", "/maintenance/windows/<id>", _h_delete_window, raw_path=True)
    ctx.register_endpoint("GET",    "/maintenance/active",       _h_active_windows, raw_path=True)
    ctx.register_endpoint("GET",    "/maintenance/check/<node>", _h_check_node,     raw_path=True)

    ctx.log("Veiled Hours active — maintenance windows registered")
