"""HTTP handlers for /fleet/* — read and mutating paths."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict
from datetime import date, datetime
from pathlib import Path


REPO_ROOT = Path(__file__).parent.parent.parent
REPO_PERSONAS = REPO_ROOT / "personas.json"
REPO_REALM_LOCAL = REPO_ROOT / "realm-local.json"
REPO_REALM_DB = REPO_ROOT / "realm.db"


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


def _rekey_json(path: Path, old_key: str, new_key: str) -> None:
    """Rekey a top-level key in a JSON file. Silent no-op if missing."""
    if not path.exists():
        return
    d = json.loads(path.read_text())
    if old_key in d:
        d[new_key] = d.pop(old_key)
        path.write_text(json.dumps(d, indent=2))


def _rekey_json_nested(path: Path, outer_key: str, old_key: str, new_key: str) -> None:
    """Rekey a nested key inside outer_key in a JSON file."""
    if not path.exists():
        return
    d = json.loads(path.read_text())
    inner = d.get(outer_key)
    if isinstance(inner, dict) and old_key in inner:
        inner[new_key] = inner.pop(old_key)
        path.write_text(json.dumps(d, indent=2))


def _rekey_realm_db_topology(db_path: Path, old_fleet_id: str, new_fleet_id: str,
                              ip: str | None = None, vlan: int | None = None) -> None:
    """Find the node row in realm.db that has data.fleet_id == old_fleet_id
    and rewrite it to new_fleet_id (and ip/vlan if provided).
    """
    if not db_path.exists():
        return
    db = sqlite3.connect(db_path)
    try:
        for row in list(db.execute("SELECT node_id, data FROM nodes")):
            data = json.loads(row[1] or "{}")
            if data.get("fleet_id") == old_fleet_id:
                data["fleet_id"] = new_fleet_id
                if ip:
                    data["ip"] = ip
                if vlan is not None:
                    data["vlan"] = vlan
                db.execute("UPDATE nodes SET data = ? WHERE node_id = ?",
                           (json.dumps(data), row[0]))
                break
        db.commit()
    finally:
        db.close()


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

    def replace_handler(req, params):
        body = req.json() or {}
        old = body.get("old") or {}
        new = body.get("new") or {}
        inherit = body.get("inherit") or {}

        if not isinstance(old, dict) or not isinstance(new, dict):
            return req.respond(
                {"error": "old and new must be objects"}, status=400
            )

        new_fleet_id = new.get("fleet_id")
        new_current_name = new.get("current_name")
        if not new_fleet_id or not new_current_name:
            return req.respond(
                {"error": "new.fleet_id and new.current_name required"},
                status=400,
            )

        # Resolve old entry — accept either fleet_id or name.
        old_fleet_id = old.get("fleet_id")
        if old_fleet_id:
            old_entry = catalog._by_id.get(old_fleet_id)
        elif old.get("name"):
            old_entry = catalog.resolve(old["name"])
            old_fleet_id = old_entry.fleet_id if old_entry else None
        else:
            return req.respond(
                {"error": "old.fleet_id or old.name required"}, status=400
            )

        if old_entry is None:
            return req.respond(
                {"error": f"unknown old entry: {old}"}, status=404
            )

        # Build new FleetEntry. Inherit realm/kind/role/vendor from old if
        # not supplied in the body.
        from lexicon.fleet import FleetEntry  # local import — lazy
        new_entry = FleetEntry(
            fleet_id=new_fleet_id,
            current_name=new_current_name,
            realm=new.get("realm", old_entry.realm),
            kind=new.get("kind", old_entry.kind),
            role=new.get("role", old_entry.role),
            vendor=new.get("vendor", old_entry.vendor),
            status=new.get("status", "curated"),
            notes=new.get("notes"),
            first_seen=new.get("first_seen"),
            last_seen=new.get("last_seen"),
        )

        try:
            catalog.retire(
                old_fleet_id,
                new_entry=new_entry,
                retired_on=body.get("retired_on"),
                reason=body.get("reason"),
            )
        except KeyError as e:
            return req.respond({"error": str(e)}, status=404)
        except ValueError as e:
            return req.respond({"error": str(e)}, status=400)

        catalog.save()

        warnings: list[str] = []

        if inherit.get("persona"):
            try:
                _rekey_json(REPO_PERSONAS, old_fleet_id, new_fleet_id)
            except Exception as exc:
                warnings.append(f"persona rekey failed: {exc}")

        if inherit.get("herald_templates"):
            try:
                _rekey_json_nested(
                    REPO_REALM_LOCAL,
                    "herald_node_templates",
                    old_fleet_id,
                    new_fleet_id,
                )
            except Exception as exc:
                warnings.append(f"herald_templates rekey failed: {exc}")

        if inherit.get("position"):
            try:
                _rekey_realm_db_topology(
                    REPO_REALM_DB,
                    old_fleet_id,
                    new_fleet_id,
                    ip=body.get("ip"),
                    vlan=body.get("vlan"),
                )
            except Exception as exc:
                warnings.append(f"position rekey failed: {exc}")

        ctx.push_event("realm-event", {
            "kind": "fleet.replaced",
            "old_fleet_id": old_fleet_id,
            "new_fleet_id": new_fleet_id,
            "retired_on": body.get("retired_on"),
        })
        ctx.push_event("plugin-broadcast", {
            "type": "fleet-update",
            "changed_fleet_ids": [old_fleet_id, new_fleet_id],
        })

        resp = {
            "ok": True,
            "old_fleet_id": old_fleet_id,
            "new_fleet_id": new_fleet_id,
        }
        if warnings:
            resp["warnings"] = warnings
        return req.respond(resp)

    ctx.register_endpoint("GET", "/fleet/list", list_handler, raw_path=True)
    ctx.register_endpoint("GET", "/fleet/resolve/<name>", resolve_handler, raw_path=True)
    ctx.register_endpoint("POST", "/fleet/rename", rename_handler, raw_path=True)
    ctx.register_endpoint("POST", "/fleet/replace", replace_handler, raw_path=True)
