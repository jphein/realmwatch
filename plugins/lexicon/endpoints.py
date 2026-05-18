"""HTTP handlers for /fleet/* — read paths."""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime


def _json_safe(obj):
    """Recursively coerce dates to ISO strings so json can encode them."""
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    return obj


def _entry_to_dict(e):
    return _json_safe(asdict(e))


def register(ctx, catalog):
    """Wire read-only fleet endpoints."""

    def list_handler(req, params):
        status_filter = req.query_params.get("status")
        entries = catalog.entries
        if status_filter:
            entries = [e for e in entries if e.status == status_filter]
        return req.respond({
            "count": len(entries),
            "entries": [_entry_to_dict(e) for e in entries],
        })

    def resolve_handler(req, params):
        name = params.get("name", "")
        e = catalog.resolve(name)
        if e is None:
            return req.respond({"error": "not found", "query": name}, status=404)
        return req.respond({"query": name, "entry": _entry_to_dict(e)})

    ctx.register_endpoint("GET", "/fleet/list", list_handler, raw_path=True)
    ctx.register_endpoint("GET", "/fleet/resolve/<name>", resolve_handler, raw_path=True)
