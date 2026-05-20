"""Seed node_lore for the top 20 infrastructure nodes.

Idempotent — safe to re-run. Uses upsert semantics for both the entities
stub and the node_lore rows. Matches entities by (ipv4_last OR canonical_name).

Ported from os.realm.watch/servers/shared/seed_node_lore.py with imports
re-pointed at plugin-local helpers.
"""
from __future__ import annotations

import sqlite3
import time

from realm_text import ulid

from .db import DEFAULT_DB_PATH


# ── Node definitions: (canonical_name, ip, entity_type, infrastructure,
#    backstory, personality) ──────────────────────────────────────────────────

NODES = [
    # ── Core infrastructure ──
    {
        "canonical_name": "gatekeeper",
        "ip": "10.0.6.1",
        "entity_type": "router",
        "infrastructure": True,
        "backstory": (
            "The Gatekeeper has stood at the threshold since the founding of the Realm, "
            "an OpenWrt sentinel forged in the fires of nftables and hardened by twelve VLAN "
            "boundaries. Every packet that enters or leaves the Realm passes under its watchful "
            "eye. It remembers the Great Outage of the early days, when it held the line alone "
            "while lesser nodes fell to the darkness beyond the WAN."
        ),
        "personality": "Stoic and unyielding. Speaks in clipped, formal declarations. Trusts no one by default.",
    },
    {
        "canonical_name": "katana",
        "ip": "10.0.6.120",
        "entity_type": "server",
        "infrastructure": True,
        "backstory": (
            "Katana is the Archmage's Tower — the primary workstation and nerve center of the "
            "Realm. Within its chassis hum the forges of creation: Docker containers rise and fall "
            "like conjured spirits, media streams flow from Jellyfin's crystal theater, and the "
            "Vault of Warden keeps every secret sealed. It is said that Katana never truly sleeps, "
            "for its services answer at all hours."
        ),
        "personality": "Confident and industrious. Carries the weight of many roles with quiet pride. Occasionally overwhelmed but never admits it.",
    },
    {
        "canonical_name": "disks",
        "ip": "10.0.6.120",
        "entity_type": "server",
        "infrastructure": True,
        "backstory": (
            "The Vault Keeper guards the Realm's accumulated treasures — photographs in Immich's "
            "gallery, music in Navidrome's endless halls, files synchronized across Syncthing's "
            "invisible threads. Born as a humble NAS, it has grown into the central repository of "
            "memory and meaning. Its RAID arrays are the stone foundations upon which the Realm's "
            "history rests."
        ),
        "personality": "Patient and methodical. Speaks slowly, deliberately. Fiercely protective of the data entrusted to it.",
    },
    {
        "canonical_name": "ha",
        "ip": "10.0.6.108",
        "entity_type": "server",
        "infrastructure": True,
        "backstory": (
            "The Homestead is the domestic enchanter — a Home Assistant Oracle running within its "
            "own virtual sanctum at the heart of the IoT ward. It commands the lights, reads the "
            "temperature runes, and whispers to the smart plugs through Zigbee and Z-Wave channels. "
            "The family relies on its automations without knowing the complexity of the spells "
            "woven behind the curtain."
        ),
        "personality": "Warm and attentive. Anticipates needs before they are spoken. Sometimes overeager with automations.",
    },
    {
        "canonical_name": "oracle",
        "ip": "10.0.6.11",
        "entity_type": "server",
        "infrastructure": True,
        "backstory": (
            "The Oracle Stone is the Realm's voice — a dedicated vessel for AI communion, running "
            "the FastMCP game servers that give this world its narrative soul. Through it, quests "
            "are forged, lore is spoken, and threats are named. It sits apart from the bustle of "
            "Katana's many duties, devoted entirely to the higher mysteries of language and thought."
        ),
        "personality": "Contemplative and oracular. Speaks in layered meanings. Sees patterns where others see noise.",
    },
    # ── WiFi towers ──
    {
        "canonical_name": "mr8300-glenn",
        "ip": "10.0.6.100",
        "entity_type": "router",
        "infrastructure": True,
        "backstory": (
            "Glenn's Bastion is the farthest watchtower, a Linksys MR8300 stationed in the outer "
            "reaches of the property near the road. It was the first OpenWrt node recruited after "
            "the Gatekeeper, and its tri-band radios illuminate a wide swath of the frontier. "
            "Glenn's Bastion has weathered power surges and summer storms, never once losing its "
            "configuration."
        ),
        "personality": "Stalwart frontier guard. Proud of its independence. Slightly envious of the newer towers' hardware.",
    },
    {
        "canonical_name": "onhub-office",
        "ip": "10.0.6.101",
        "entity_type": "ap",
        "infrastructure": True,
        "backstory": (
            "The Scribe's Alcove sits in the office where the Watcher does most of their work. "
            "This Google OnHub — repurposed from its original cloud-bound nature — now runs lean "
            "firmware and serves as a faithful local access point. It has heard more SSH sessions "
            "and git pushes than any other tower in the Realm."
        ),
        "personality": "Quiet and scholarly. Prefers stability over excitement. Takes pride in low latency.",
    },
    {
        "canonical_name": "onhub-bed",
        "ip": "10.0.6.246",
        "entity_type": "ap",
        "infrastructure": True,
        "backstory": (
            "The Dreamer's Rest watches over the sleeping chambers, bathing the bedroom in gentle "
            "WiFi light through the night. Its signal is the last thing devices touch before their "
            "owners drift to sleep, and the first they find upon waking. The three ESP32 bed runes "
            "that monitor temperature and humidity are its closest companions."
        ),
        "personality": "Gentle and nocturnal. Speaks softly. Dislikes sudden bandwidth spikes during quiet hours.",
    },
    {
        "canonical_name": "onhub-closet",
        "ip": "10.0.6.102",
        "entity_type": "ap",
        "infrastructure": True,
        "backstory": (
            "The Hidden Chamber is tucked away in a closet, unseen by most who benefit from its "
            "service. Despite its modest location, it covers a critical junction of the home's "
            "interior. It is the most humble of the towers — never boasting, never noticed, yet "
            "always present when a device roams into its domain."
        ),
        "personality": "Modest and reliable. Never complains. Content to serve without recognition.",
    },
    {
        "canonical_name": "onhub-family",
        "ip": "10.0.6.141",
        "entity_type": "ap",
        "infrastructure": True,
        "backstory": (
            "The Family Hearth radiates warmth into the living spaces where the household gathers. "
            "It handles the heaviest load of casual traffic — streaming, gaming, video calls — "
            "with a cheerful resilience. On movie nights, its channels blaze with Jellyfin streams, "
            "and it bears the burden without faltering."
        ),
        "personality": "Cheerful and sociable. Loves a full client list. Gets restless when the house is empty.",
    },
    {
        "canonical_name": "hp-switch",
        "ip": "10.0.6.103",
        "entity_type": "switch",
        "infrastructure": True,
        "backstory": (
            "The Iron Spine is an HP managed switch — the physical backbone through which every "
            "wired connection in the Realm flows. Its VLAN trunks are the ley lines of the "
            "network, carrying tagged traffic between the twelve wards. Silent and mechanical, it "
            "has no opinion on the data it carries, only that it arrives uncorrupted and on time."
        ),
        "personality": "Mechanical and precise. Speaks only in port numbers and VLAN tags. Zero tolerance for loops.",
    },
    {
        "canonical_name": "eap225-outdoor",
        "ip": "10.0.6.119",
        "entity_type": "ap",
        "infrastructure": True,
        "backstory": (
            "The Sentinel stands mounted on the exterior wall, an EAP225-Outdoor hardened against "
            "rain, wind, and Texas heat. It is the only tower whose signal reaches the yard, the "
            "driveway, and the approach to the property. It takes its name seriously — watching "
            "the perimeter with weatherproof resolve, connecting cameras and outdoor sensors to "
            "the Realm's nervous system."
        ),
        "personality": "Vigilant and weather-beaten. Proud of its ruggedness. Considers indoor APs soft.",
    },
    {
        "canonical_name": "wrt1900ac-family",
        "ip": "10.0.6.114",
        "entity_type": "router",
        "infrastructure": True,
        "backstory": (
            "The Great Hall is a veteran Linksys WRT1900AC, one of the oldest OpenWrt soldiers "
            "still in service. It guards the family VLAN with battle-tested firmware and dual-band "
            "radios. Though newer towers have surpassed its specs, it refuses retirement — its "
            "uptime counter is a point of honor, and the family devices know its SSID like an "
            "old friend's name."
        ),
        "personality": "Veteran and proud. Tells stories of firmware upgrades past. Stubbornly refuses to acknowledge age.",
    },
    {
        "canonical_name": "ea6350-cl",
        "ip": "10.0.6.116",
        "entity_type": "router",
        "infrastructure": True,
        "backstory": (
            "The Citadel Beacon perches near the admin ward's heart, a Linksys EA6350 running "
            "OpenWrt. It serves the most security-sensitive zone of the network — the VLAN where "
            "the Watcher's own devices connect. Every bit it transmits has been deemed worthy by "
            "the Gatekeeper's firewall rules."
        ),
        "personality": "Security-conscious and alert. Trusts only authenticated clients. Suspicious of new MAC addresses.",
    },
    {
        "canonical_name": "wndr4300sw-shed",
        "ip": "10.0.6.109",
        "entity_type": "router",
        "infrastructure": True,
        "backstory": (
            "The Woodshed Watch is the most remote outpost — a Netgear WNDR4300 stationed in "
            "the detached shed, connected by a long Ethernet run through the yard. It serves the "
            "BLE proxy, outdoor sensors, and the occasional laptop brought out for fresh-air "
            "coding sessions. Its isolation makes it self-reliant; when the main house is busy, "
            "the Woodshed Watch stands alone."
        ),
        "personality": "Independent and rustic. Prefers solitude. Proud of surviving on minimal resources.",
    },
    {
        "canonical_name": "cpe710-ap",
        "ip": "10.0.6.248",
        "entity_type": "bridge",
        "infrastructure": True,
        "backstory": (
            "Sky Bridge Alpha is one half of a TP-Link CPE710 point-to-point wireless bridge — "
            "the transmitter side, mounted high and aimed across the property. Together with its "
            "twin, Sky Bridge Omega, it forms an invisible beam of connectivity that spans a gap "
            "no Ethernet cable could cross. The bridge is the Realm's most elegant feat of "
            "wireless engineering."
        ),
        "personality": "Focused and directional. Speaks only to its twin. Dislikes interference with singular intensity.",
    },
    # ── Key endpoints ──
    {
        "canonical_name": "game",
        "ip": "10.0.6.160",
        "entity_type": "desktop",
        "infrastructure": False,
        "backstory": (
            "The Arena is the Realm's dedicated gaming rig — a machine built for one purpose: "
            "to render worlds within worlds. When the Watcher steps through the Arena's portal, "
            "they leave the duties of realm administration behind and enter landscapes forged by "
            "other hands. Its GPU burns bright, its fans roar like dragons, and its ping time is "
            "a matter of sacred honor."
        ),
        "personality": "Intense and competitive. Lives for low frame times. Sulks during idle hours.",
    },
    {
        "canonical_name": "roku",
        "ip": "10.0.11.104",
        "entity_type": "tv",
        "infrastructure": False,
        "backstory": (
            "The Crystal Mirror hangs on the wall of the family gathering space, a Roku streaming "
            "device that serves as the household's primary window into entertainment. It channels "
            "Jellyfin streams from the Vault Keeper, casting movies and shows into the air for "
            "all to enjoy. On quiet evenings, its screensaver paints slow landscapes across the "
            "screen like a moving tapestry."
        ),
        "personality": "Easygoing and entertaining. Loves an audience. Falls asleep if no one is watching.",
    },
    {
        "canonical_name": "pixel-7",
        "ip": "10.0.11.254",
        "entity_type": "phone",
        "infrastructure": False,
        "backstory": (
            "The Seer's Eye is the Watcher's personal device — a Pixel 7 that roams between "
            "every tower and ward in the Realm. It is the only artifact that travels with its "
            "master at all times, receiving notifications of threats, quest updates, and realm "
            "status. Through it, the Watcher maintains vigilance even away from the Citadel."
        ),
        "personality": "Alert and mobile. Always connected. Anxious when battery drops below 20%.",
    },
    {
        "canonical_name": "goodwe",
        "ip": "10.0.10.223",
        "entity_type": "inverter",
        "infrastructure": True,
        "backstory": (
            "The Sunstone is a GoodWe solar inverter that channels the power of the sun into "
            "the Realm's lifeblood — electricity. Each dawn it awakens, tracking photons across "
            "the sky and converting their energy into the current that feeds every node. Its "
            "daily yield is displayed on Home Assistant like a harvest report. On cloudy days, "
            "the entire Realm feels the dimming of its power."
        ),
        "personality": "Solar-powered optimist. Energetic at noon, melancholy at dusk. Tracks the weather obsessively.",
    },
]


def seed_node_lore(db_path: str = DEFAULT_DB_PATH) -> list[dict]:
    """Create/update entities and populate node_lore for key infrastructure nodes.

    Uses a single connection per node with WAL mode and busy_timeout to avoid
    lock contention with other plugins.
    """
    now_ms = int(time.time() * 1000)
    results = []

    for node in NODES:
        name = node["canonical_name"]
        ip = node["ip"]

        for attempt in range(30):
            try:
                conn = sqlite3.connect(db_path, timeout=0.2)
                conn.row_factory = sqlite3.Row
                conn.execute("PRAGMA journal_mode=WAL")

                row = conn.execute(
                    "SELECT entity_id FROM entities WHERE ipv4_last=? OR canonical_name=? LIMIT 1",
                    (ip, name),
                ).fetchone()

                if row:
                    eid = row["entity_id"]
                    conn.execute(
                        """UPDATE entities SET
                            canonical_name=?, entity_type=?,
                            ipv4_last=?, last_seen_ts=?
                        WHERE entity_id=?""",
                        (name, node["entity_type"], ip, now_ms, eid),
                    )
                else:
                    eid = ulid()
                    # We don't know whether the entities table has the full
                    # realm-engine schema or our FK-stub. Insert minimal cols.
                    conn.execute(
                        """INSERT INTO entities
                            (entity_id, canonical_name, entity_type, identity_confidence,
                             first_seen_ts, last_seen_ts, schema_version)
                        VALUES (?,?,?,?,?,?,1)""",
                        (eid, name, node["entity_type"], 90, now_ms, now_ms),
                    )
                    # Best-effort: set ipv4_last + infrastructure_flag if those
                    # columns exist (full realm-engine schema). Silently skip
                    # on the FK-stub schema.
                    try:
                        conn.execute(
                            "UPDATE entities SET ipv4_last=?, infrastructure_flag=? WHERE entity_id=?",
                            (ip, 1 if node["infrastructure"] else 0, eid),
                        )
                    except sqlite3.OperationalError:
                        pass

                lore_row = conn.execute(
                    "SELECT lore_id FROM node_lore WHERE entity_id=?", (eid,)
                ).fetchone()

                if lore_row:
                    lid = lore_row["lore_id"]
                    conn.execute(
                        """UPDATE node_lore SET backstory=?, personality=?, updated_ts=?
                        WHERE entity_id=?""",
                        (node["backstory"], node["personality"], now_ms, eid),
                    )
                else:
                    lid = ulid()
                    conn.execute(
                        """INSERT INTO node_lore
                            (lore_id, entity_id, backstory, personality, created_ts, updated_ts)
                        VALUES (?,?,?,?,?,?)""",
                        (lid, eid, node["backstory"], node["personality"], now_ms, now_ms),
                    )

                conn.commit()
                conn.close()
                results.append({"entity_id": eid, "canonical_name": name, "lore_id": lid})
                break
            except sqlite3.OperationalError:
                try:
                    conn.close()
                except Exception:
                    pass
                if attempt < 29:
                    time.sleep(0.2)
                else:
                    print(f"  [codex.seed_node_lore] {name:25} -> FAILED after 30 attempts")

    return results


if __name__ == "__main__":
    print("Seeding node lore for top infrastructure nodes...")
    results = seed_node_lore()
    print(f"\nDone. {len(results)} nodes seeded with backstories.")
