"""Seed historical chronicles for major realm milestones.

Run once to populate the chronicles table with founding events.
Idempotent — checks for existing entries by title before inserting.

Ported from os.realm.watch/servers/shared/seed_chronicles.py.
"""
from __future__ import annotations

import time

from realm_text import ulid

from .db import DEFAULT_DB_PATH, get_connection


# Historical milestones with approximate timestamps (epoch-relative day offsets)
_FOUNDING_CHRONICLES = [
    {
        "title": "The Founding of the Realm",
        "narrative": "On this day, the five pillars of RealmWatch OS were raised: "
                     "realm-engine, quest-forge, progression, lore-keeper, and combat-ward. "
                     "The Truth Model v1 was inscribed, and the game loop began to turn.",
        "epoch_offset_days": -3,
    },
    {
        "title": "Phase 0 — The Game Loop Awakens",
        "narrative": "Realm-engine, progression, and quest-forge came online. "
                     "Events flowed from realmwatch into quests, XP was granted, "
                     "levels calculated. The replay harness proved the loop sound. "
                     "41 agents labored across 8 teams to raise the foundations.",
        "epoch_offset_days": -3,
    },
    {
        "title": "Phase 1 — Lore and Combat",
        "narrative": "The lore-keeper opened its codex, filling it with knowledge of "
                     "protocols, services, and architecture. Combat-ward began monitoring "
                     "threats, casting wards, and tracking the bestiary. Skills /cast, "
                     "/defend, /summon, /lore, /forge, and /oracle were forged.",
        "epoch_offset_days": -3,
    },
    {
        "title": "Phase 2 — The Desktop Awakens",
        "narrative": "The Realm HUD materialized as a GNOME Shell extension — "
                     "floating overlay with XP bars, active quest, and threat counts. "
                     "Plymouth, GDM, and GRUB were themed in realm gold on void. "
                     "A live wallpaper script brought the realm map to the desktop.",
        "epoch_offset_days": -2,
    },
    {
        "title": "Phase 3 — The ISO Forged",
        "narrative": "RealmWatch OS was distilled into a bootable ISO via Cubic. "
                     "Eight projects bundled into /opt/realmwatch/, systemd units wired, "
                     "first-boot experience crafted with character creation and realm discovery.",
        "epoch_offset_days": -2,
    },
    {
        "title": "Phase 4 — Parallel Realms",
        "narrative": "LTSP thin clients, KVM-VDI virtual machines, and PXE boot menus "
                     "opened portals to parallel realms: Shadow Realm (Kali), Mirror Realm "
                     "(Android), Outer Realm (Windows 11), and Hearthstone (Home Assistant). "
                     "The /summon skill gained the power to conjure VM realms.",
        "epoch_offset_days": -2,
    },
    {
        "title": "Phase 5 — The Unified Gate",
        "narrative": "Authelia SSO unified authentication across eight services. "
                     "One login to rule all doors — Immich, Jellyfin, Navidrome, "
                     "Outline, Nextcloud, Home Assistant, Syncthing, and the realm portal. "
                     "Ten citizens of the realm now carry a single key.",
        "epoch_offset_days": -1,
    },
    {
        "title": "The Chronicles Begin",
        "narrative": "The lore-keeper gained the power of auto-chronicle — "
                     "quest completions, XP grants, level ascensions, and achievements "
                     "now inscribe themselves into the historical record. "
                     "No deed shall pass unrecorded.",
        "epoch_offset_days": 0,
    },
]


def seed_chronicles(db_path: str = DEFAULT_DB_PATH) -> list[dict]:
    """Insert founding chronicles if they don't already exist (matched by title)."""
    conn = get_connection(db_path)
    created = []
    base_ts = int(time.time() * 1000)
    one_day_ms = 86400 * 1000

    for i, entry in enumerate(_FOUNDING_CHRONICLES):
        existing = conn.execute(
            "SELECT chronicle_id FROM chronicles WHERE title=?",
            (entry["title"],),
        ).fetchone()
        if existing:
            continue

        chronicle_ts = base_ts + (entry["epoch_offset_days"] * one_day_ms) + (i * 1000)
        cid = ulid()
        conn.execute(
            """INSERT INTO chronicles
                (chronicle_id, event_id, title, narrative, chronicle_date, created_ts)
            VALUES (?,?,?,?,?,?)""",
            (cid, None, entry["title"], entry["narrative"], chronicle_ts, base_ts),
        )
        created.append({"chronicle_id": cid, "title": entry["title"]})

    conn.commit()
    conn.close()
    return created


if __name__ == "__main__":
    results = seed_chronicles()
    if results:
        print(f"Seeded {len(results)} chronicles:")
        for r in results:
            print(f"  - {r['title']}")
    else:
        print("All chronicles already exist.")
