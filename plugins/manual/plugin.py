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
        # --- Network infrastructure (no management interface) ---
        {
            "id": "manual:fiber-gateway",
            "type": "infrastructure",
            "name": "AT&T Fiber Gateway",
            "host_node_id": "wan",
            "status": "active",
            "metadata": {
                "description": "AT&T ONT — no management interface, fiber handoff",
                "category": "network",
                "model": "BGW320-505",
            },
        },
        {
            "id": "manual:poe-switch",
            "type": "infrastructure",
            "name": "PoE Switch",
            "host_node_id": "poe-switch",
            "status": "active",
            "metadata": {
                "description": "Powers APs and cameras via PoE",
                "category": "network",
            },
        },
        {
            "id": "manual:shed-switch",
            "type": "infrastructure",
            "name": "Shed Network Switch",
            "host_node_id": "shed-switch",
            "status": "active",
            "metadata": {
                "description": "Unmanaged switch in the woodshed",
                "category": "network",
            },
        },
        # --- Cloud services ---
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
        {
            "id": "manual:cloudflare",
            "type": "service",
            "name": "Cloudflare DNS + Tunnel",
            "host_node_id": "cloud",
            "status": "active",
            "metadata": {
                "description": "DNS for realm.watch, jphe.in; Argo tunnels for public services",
                "domain": "realm.watch",
                "category": "cloud",
            },
        },
        {
            "id": "manual:vercel",
            "type": "service",
            "name": "Vercel Hosting",
            "host_node_id": "cloud",
            "status": "active",
            "metadata": {
                "description": "Hosts techempower (Next.js)",
                "category": "cloud",
            },
        },
        {
            "id": "manual:azure-ai",
            "type": "service",
            "name": "Azure AI Services",
            "host_node_id": "cloud",
            "status": "active",
            "metadata": {
                "description": "GPT-4o chat, Azure Speech TTS/STT for oracle + herald",
                "category": "cloud",
            },
        },
        # --- Service dependencies ---
        {
            "id": "manual:rel:jellyfin-disks",
            "type": "relationship",
            "name": "Jellyfin → Disks",
            "host_node_id": "jellyfin",
            "status": "active",
            "metadata": {
                "description": "Jellyfin media library stored on disks NFS shares",
                "target_node": "woodshed",
                "relationship": "depends_on",
                "protocol": "NFS",
            },
        },
        {
            "id": "manual:rel:immich-disks",
            "type": "relationship",
            "name": "Immich → Disks",
            "host_node_id": "immich",
            "status": "active",
            "metadata": {
                "description": "Immich photo library stored on disks NFS shares",
                "target_node": "woodshed",
                "relationship": "depends_on",
                "protocol": "NFS",
            },
        },
        {
            "id": "manual:rel:navidrome-disks",
            "type": "relationship",
            "name": "Navidrome → Disks",
            "host_node_id": "navidrome",
            "status": "active",
            "metadata": {
                "description": "Navidrome music library stored on disks NFS shares",
                "target_node": "woodshed",
                "relationship": "depends_on",
                "protocol": "NFS",
            },
        },
        {
            "id": "manual:rel:ha-mqtt",
            "type": "relationship",
            "name": "Home Assistant → MQTT",
            "host_node_id": "ha",
            "status": "active",
            "metadata": {
                "description": "HA uses MQTT broker for Zigbee2MQTT + ESP devices",
                "relationship": "depends_on",
                "protocol": "MQTT",
            },
        },
        # --- IoT device groups (no individual management) ---
        {
            "id": "manual:kasa-spirits",
            "type": "infrastructure",
            "name": "Kasa Smart Plugs",
            "host_node_id": "kasa-spirits",
            "status": "active",
            "metadata": {
                "description": "TP-Link Kasa smart plugs controlled via HA",
                "count": 4,
                "category": "iot",
            },
        },
        {
            "id": "manual:tuya-sprites",
            "type": "infrastructure",
            "name": "Tuya Smart Devices",
            "host_node_id": "tuya-sprites",
            "status": "active",
            "metadata": {
                "description": "Tuya-based smart devices (bulbs, plugs) via local Tuya",
                "category": "iot",
            },
        },
        {
            "id": "manual:nest-circle",
            "type": "infrastructure",
            "name": "Nest Thermostat Circle",
            "host_node_id": "nest-circle",
            "status": "active",
            "metadata": {
                "description": "Google Nest thermostats managed via HA",
                "category": "iot",
            },
        },
        {
            "id": "manual:voice-stones",
            "type": "infrastructure",
            "name": "Voice Assistants",
            "host_node_id": "voice-stones",
            "status": "active",
            "metadata": {
                "description": "Google Home / Nest speakers for voice control",
                "category": "iot",
            },
        },
        {
            "id": "manual:wandering-golems",
            "type": "infrastructure",
            "name": "Robot Vacuums",
            "host_node_id": "wandering-golems",
            "status": "active",
            "metadata": {
                "description": "Roborock vacuums integrated via HA",
                "category": "iot",
            },
        },
        # --- Solar/energy (no SSH/API) ---
        {
            "id": "manual:goodwe-inverter",
            "type": "infrastructure",
            "name": "GoodWe Solar Inverter",
            "host_node_id": "goodwe",
            "status": "active",
            "metadata": {
                "description": "10kW solar inverter, data via HA SEMS integration",
                "category": "energy",
                "capacity_kw": 10,
            },
        },
        {
            "id": "manual:neocharge",
            "type": "infrastructure",
            "name": "NeoCharge EV Splitter",
            "host_node_id": "neocharge",
            "status": "active",
            "metadata": {
                "description": "Smart 240V circuit splitter for EV charging",
                "category": "energy",
            },
        },
        # --- UPS devices (no network interface) ---
        {
            "id": "manual:apcupsmini1",
            "type": "infrastructure",
            "name": "APC UPS Mini",
            "host_node_id": "apcupsmini1",
            "status": "active",
            "metadata": {
                "description": "Small APC UPS protecting network gear",
                "category": "power",
            },
        },
        {
            "id": "manual:essence",
            "type": "infrastructure",
            "name": "Main UPS",
            "host_node_id": "essence",
            "status": "active",
            "metadata": {
                "description": "Primary UPS for server rack, data via NUT/HA",
                "category": "power",
            },
        },
        # --- ESP sensor network ---
        {
            "id": "manual:esp-swarm",
            "type": "infrastructure",
            "name": "ESP Sensor Swarm",
            "host_node_id": "esp-swarm",
            "status": "active",
            "metadata": {
                "description": "Collection of ESP32/8266 sensors reporting to HA via MQTT",
                "members": ["esp32-a90c10", "esp32-bed1", "esp32-bed2", "esp32-bed3", "shed-ble"],
                "category": "iot",
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
