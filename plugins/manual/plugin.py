"""Manual discovery plugin — The Chronicler's Quill.

CRUD API for declaring static sub-entities that can't be auto-discovered.
Supports infrastructure entries, relationships, tags, and bookmarks.
"""

import json
import logging
import time

import realm_db
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _h_list_manual(req, params):
    """GET /discovery/manual — list all manual entries."""
    entries = realm_db.get_sub_entities(provider="manual")
    return req.respond(entries)


def _h_create_manual(req, params):
    """POST /discovery/manual — create or update a manual entry."""
    data = req.json()
    required = ["type", "name", "host_node_id"]
    for field in required:
        if field not in data:
            return req.respond({"error": f"Missing field: {field}"}, 400)

    entry_id = data.get("id", "")
    if not entry_id:
        entry_id = f"manual:{data['host_node_id']}:{data['name'].lower().replace(' ', '-')}"
    elif not entry_id.startswith("manual:"):
        entry_id = f"manual:{entry_id}"

    entity = {
        "id": entry_id,
        "type": data["type"],
        "name": data["name"],
        "host_node_id": data["host_node_id"],
        "status": data.get("status", "active"),
        "metadata": data.get("metadata", {}),
        "provider": "manual",
        "link_type": "manual",
    }
    realm_db.upsert_sub_entity(entity)
    return req.respond({"ok": True, "id": entry_id})


def _h_delete_manual(req, params):
    """DELETE /discovery/manual — delete a manual entry. Pass ?id=xxx."""
    entry_id = req.query_params.get("id", "")
    if not entry_id:
        return req.respond({"error": "id required"}, 400)
    realm_db.delete_sub_entity(entry_id)
    return req.respond({"ok": True})


def _h_get_tags(req, params):
    """GET /discovery/manual/tags — list all tag entries."""
    entries = realm_db.get_sub_entities(provider="manual")
    tags = [e for e in entries if e.get("type") == "tag"]
    return req.respond(tags)


def _seed_defaults():
    """Seed default manual entries for non-discoverable infrastructure."""
    defaults = [
        {
            "id": "manual:fiber-gateway",
            "type": "infrastructure",
            "name": "AT&T Fiber Gateway",
            "host_node_id": "fiber-gateway",
            "status": "active",
            "metadata": {
                "description": "AT&T ONT — no management interface",
                "category": "network",
            },
        },
        {
            "id": "manual:cloud",
            "type": "infrastructure",
            "name": "Cloud Services",
            "host_node_id": "cloud",
            "status": "active",
            "metadata": {
                "description": "Parent node for Cloudflare, Vercel, GitHub, Azure",
                "services": ["cloudflare", "vercel", "github", "azure"],
                "category": "cloud",
            },
        },
    ]

    existing = realm_db.get_sub_entities(provider="manual")
    existing_ids = {e["id"] for e in existing}

    for entry in defaults:
        if entry["id"] not in existing_ids:
            entry["provider"] = "manual"
            entry["link_type"] = "manual"
            realm_db.upsert_sub_entity(entry)
            log.info("Seeded manual entry: %s", entry["id"])


def setup(ctx):
    # Register API endpoints
    ctx.register_endpoint("GET", "/discovery/manual", _h_list_manual, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/manual", _h_create_manual, raw_path=True)
    ctx.register_endpoint("DELETE", "/discovery/manual", _h_delete_manual, raw_path=True)
    ctx.register_endpoint("GET", "/discovery/manual/tags", _h_get_tags, raw_path=True)

    # Seed defaults
    _seed_defaults()

    ctx.log("The Chronicler's Quill active — manual discovery entries + API registered")
