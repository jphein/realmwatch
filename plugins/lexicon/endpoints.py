"""HTTP handlers for /fleet/* — read and mutating paths."""

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
    """Wire fleet endpoints (read + mutating)."""

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

    def rename_handler(req, params):
        body = req.json() or {}
        fleet_id = body.get("fleet_id")
        new_name = body.get("new_name")
        reason = body.get("reason")
        if not fleet_id or not new_name:
            return req.respond(
                {"error": "fleet_id and new_name required"}, status=400
            )
        try:
            catalog.rename(fleet_id, new_name, reason=reason)
        except KeyError as e:
            return req.respond({"error": str(e)}, status=404)
        except ValueError as e:
            return req.respond({"error": str(e)}, status=400)
        catalog.save()

        entry = catalog._by_id.get(fleet_id)
        # The just-appended prior name carries the old current_name.
        from_name = (
            entry.prior_names[-1].name if entry and entry.prior_names else None
        )
        ctx.push_event("realm-event", {
            "kind": "fleet.renamed",
            "fleet_id": fleet_id,
            "from": from_name,
            "to": new_name,
        })
        ctx.push_event("plugin-broadcast", {
            "type": "fleet-update",
            "changed_fleet_ids": [fleet_id],
        })
        return req.respond({
            "ok": True,
            "fleet_id": fleet_id,
            "current_name": new_name,
        })

    ctx.register_endpoint("GET", "/fleet/list", list_handler, raw_path=True)
    ctx.register_endpoint("GET", "/fleet/resolve/<name>", resolve_handler, raw_path=True)
    ctx.register_endpoint("POST", "/fleet/rename", rename_handler, raw_path=True)
