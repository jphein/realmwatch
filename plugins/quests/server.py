"""The Quest Forge — quest generation, lifecycle, hints, debriefs.

Owns: quests, quest_event_links, quest_state_log tables in game.db.

Migrated from os.realm.watch/servers/quest_forge/server.py. Two key
differences from the original:

1. Adapted to be importable as a realmwatch plugin module (no
   `from servers.shared.*` imports). Uses plugin-local db/models/throttle.

2. Provides `generate_quest_from_event_dict()` — the event-driven entry
   point used by the realmwatch event bus. Events arrive as in-memory
   dicts (from `ctx.on_event(...)`), not as DB rows in game.db. The
   original `generate_quest_from_event(event_id)` is kept for cases
   where events do live in game.db (e.g. when migrated via the legacy
   os.realm.watch pipeline).
"""

from __future__ import annotations

import json
import os
import sqlite3
import time

from .db import DEFAULT_DB_PATH, get_connection
from .models import QUEST_STATES
from .throttle import record_event_seen, should_throttle

# ── Auto-generation volume policy (#123) ─────────────────────────────────
#
# Auto-generation was dead from the start (every novel event hit a FOREIGN KEY
# error), so the FK acted as an accidental circuit breaker. Repairing the write
# path without a policy would open a firehose: on measured 7-day traffic, 3,663
# qualifying events across 7 distinct semantic types, and each generated quest
# mints a parent plus three sub-quests. That is ~2,700 rows/day.
#
# Two bounds, both overridable by env var:
#
# MIN_SEVERITY — the two highest-volume streams (cache_bloat and journal_bloat,
#   1,109 events each over 7 days) are severity 2, i.e. routine housekeeping
#   noise. A floor of 3 drops 61% of qualifying traffic and keeps the signal.
#
# DAILY_CAP — a hard backstop counted from game.db, not memory, because the
#   cooldowns in throttle.py are in-process and reset on every restart. Without
#   a durable bound a restart loop would re-burst indefinitely. Counts parent
#   auto_anomaly quests over a rolling 24h; sub-quests ride along with parents.
AUTO_QUEST_MIN_SEVERITY = int(os.environ.get("REALM_QUEST_MIN_SEVERITY", "3"))
AUTO_QUEST_DAILY_CAP = int(os.environ.get("REALM_QUEST_DAILY_CAP", "8"))

# Payload keys carrying the *semantic* event type, in precedence order. The
# transport `type` field is only ever speech / alert / realm-event / system,
# none of which is a template key — so keying quest generation on it meant the
# 17 semantic templates could never match and everything became a generic
# "Realm Disturbance" (#123). realm-optimizer puts the real type in
# `optimizer_event_type`; it is present on 100% of measured qualifying traffic.
# Transport type stays the last resort so nothing regresses to no key at all.
_SEMANTIC_TYPE_KEYS = (
    "optimizer_event_type",
    "subtype",
    "kind",
    "event_subtype",
    "anomaly_type",
)


def quest_discriminator(event: dict) -> str:
    """Pick the type that decides which template and throttle bucket applies.

    Prefers a semantic type from the payload over the transport envelope. This
    is the key both `_TEMPLATES` and the cooldown are looked up by, so it also
    controls how finely distinct problems are allowed to interleave: keying on
    the transport type let a disk alert mask a DNS failure on the same host.
    """
    for key in _SEMANTIC_TYPE_KEYS:
        value = event.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return event.get("type") or event.get("event_type") or ""


def _auto_quests_last_24h(conn) -> int:
    """Count parent auto_anomaly quests minted in the last 24h (durable cap)."""
    cutoff_ms = int((time.time() - 86400) * 1000)
    row = conn.execute(
        "SELECT COUNT(*) FROM quests WHERE quest_type='auto_anomaly' "
        "AND parent_quest_id IS NULL AND created_ts > ?", (cutoff_ms,)).fetchone()
    return row[0] if row else 0

try:
    # realm_text lives at the repo root — it's on sys.path because
    # map_server.py runs from there.
    from realm_text import ulid
except ImportError:  # pragma: no cover - fallback for direct execution
    from uuid import uuid4

    def ulid() -> str:  # type: ignore[misc]
        return uuid4().hex.upper()


# ── Quest templates by event type ────────────────────────────────────────

_TEMPLATES: dict[str, dict] = {
    "cpu_spike": {
        "title": "The Burning Core",
        "technical_label": "CPU saturation on {host}",
        "description": "A fiery disturbance erupts from {host}. The core burns with {value}% intensity. Investigate before the flames spread.",
        "hints": ["Check what processes consume the most CPU", "Use `top` or `htop` to identify the hungry process", "Consider: is this a scheduled job, a runaway process, or a real problem?"],
        "xp_reward": 150,
        "sub_quests": [
            {"title": "Identify the hungry process", "sort_order": 1},
            {"title": "Determine if expected load", "sort_order": 2},
            {"title": "Take action (kill, restart, or accept)", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "port_scan": {
        "title": "Shadow Probe Detected",
        "technical_label": "SYN scan from {source_ip}",
        "description": "Dark scouts probe the realm walls from {source_ip}. Their patterns suggest reconnaissance. Identify the source and assess the threat.",
        "hints": ["Check the source IP — is it internal or external?", "Review firewall logs for scan patterns", "Decide: block, investigate, or monitor?"],
        "xp_reward": 200,
        "sub_quests": [
            {"title": "Identify the source IP origin", "sort_order": 1},
            {"title": "Review firewall logs for scan pattern", "sort_order": 2},
            {"title": "Decide: block, investigate, or monitor", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{source_ip}", "label": "View Source"}],
    },
    "new_device": {
        "title": "A Stranger Arrives",
        "technical_label": "Unknown device on {vlan}",
        "description": "An unfamiliar presence materializes in the realm. Its identity is uncertain. Name it, understand it, decide its fate.",
        "hints": ["Check the MAC address vendor (OUI lookup)", "Scan the device for open ports", "Ask yourself: should this device be here?"],
        "xp_reward": 100,
        "sub_quests": [
            {"title": "Look up MAC vendor (OUI)", "sort_order": 1},
            {"title": "Scan for open ports", "sort_order": 2},
            {"title": "Decide: name and allow, or quarantine", "sort_order": 3},
        ],
        "actions": [],
    },
    "memory_critical": {
        "title": "The Drowning Archives",
        "technical_label": "Memory exhaustion on {host}",
        "description": "The archives of {host} overflow, memories spilling and drowning. Without intervention, the node may fall silent.",
        "hints": ["Check which process uses the most RAM", "Is there a memory leak or just high demand?", "Consider: restart the service, add swap, or scale the workload?"],
        "xp_reward": 175,
        "sub_quests": [
            {"title": "Identify top memory consumer", "sort_order": 1},
            {"title": "Check for memory leak vs high demand", "sort_order": 2},
            {"title": "Take action (restart, add swap, or scale)", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "latency_spike": {
        "title": "The Sluggish Path",
        "technical_label": "High latency to {host} ({value}ms)",
        "description": "The path to {host} grows slow and treacherous. Messages take {value}ms to traverse. Something obstructs the way.",
        "hints": ["Run traceroute to identify where the delay is", "Check if the target host is under load", "Look for packet loss along the path"],
        "xp_reward": 125,
        "sub_quests": [
            {"title": "Run traceroute to locate the bottleneck", "sort_order": 1},
            {"title": "Check target host load", "sort_order": 2},
            {"title": "Look for packet loss along the path", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "brute_force": {
        "title": "The Battering Ram",
        "technical_label": "SSH brute force from {source_ip} ({attempts} attempts)",
        "description": "A relentless assault hammers at the gates. {attempts} attempts to breach {target} from {source_ip}. The sentries must hold.",
        "hints": ["Check which service is being targeted", "Look at fail2ban status — is it already blocking?", "Is the source IP internal or external?"],
        "xp_reward": 200,
        "sub_quests": [
            {"title": "Identify targeted service", "sort_order": 1},
            {"title": "Check fail2ban status", "sort_order": 2},
            {"title": "Determine source origin (internal/external)", "sort_order": 3},
            {"title": "Block or rate-limit the attacker", "sort_order": 4},
        ],
        "actions": [{"type": "pan", "node": "{target}", "label": "View Target"}],
    },
    "dns_poisoning": {
        "title": "Whispering Corruption",
        "technical_label": "DNS cache poisoning targeting {target_domain}",
        "description": "The Naming Stones are corrupted — false whispers redirect {target_domain} to a shadow address.",
        "hints": ["Verify DNS resolution with dig", "Check if the resolver cache is poisoned", "Flush DNS cache and verify authoritative answer"],
        "xp_reward": 250,
        "sub_quests": [
            {"title": "Verify DNS resolution with dig", "sort_order": 1},
            {"title": "Check resolver cache for poisoned entries", "sort_order": 2},
            {"title": "Flush cache and verify authoritative answer", "sort_order": 3},
        ],
        "actions": [],
    },
    "ddos": {
        "title": "The Swarm Descends",
        "technical_label": "DDoS flood from {source} ({packets_per_second} pps)",
        "description": "A deafening swarm floods the realm gates. {packets_per_second} packets per second from {source}.",
        "hints": ["Identify the source — single origin or distributed?", "Check if rate limiting can contain the flood", "Consider upstream filtering if external"],
        "xp_reward": 300,
        "sub_quests": [
            {"title": "Determine single origin or distributed", "sort_order": 1},
            {"title": "Check if rate limiting contains the flood", "sort_order": 2},
            {"title": "Apply upstream filtering if external", "sort_order": 3},
        ],
        "actions": [],
    },
    "unknown_device": {
        "title": "The Shapeshifter",
        "technical_label": "Unknown device {mac} on {vlan}",
        "description": "An entity of uncertain form materializes on {vlan}. MAC {mac} is unknown to the realm.",
        "hints": ["Look up MAC vendor (first 3 octets)", "Scan for open ports", "Check if it matches a known device that changed addresses"],
        "xp_reward": 150,
        "sub_quests": [
            {"title": "Look up MAC vendor (first 3 octets)", "sort_order": 1},
            {"title": "Scan for open ports", "sort_order": 2},
            {"title": "Decide: register, monitor, or quarantine", "sort_order": 3},
        ],
        "actions": [],
    },
    "disk_space_low": {
        "title": "The Overflowing Archives",
        "technical_label": "Disk usage at {percent_used}% ({free_gb}GB free)",
        "description": "The realm archives overflow — only {free_gb}GB remains. If the vaults fill, services will fail.",
        "hints": ["Check large directories: du -sh /*", "Look for log files, old backups, cache dirs", "Consider: pip cache, Docker images, snap, journal"],
        "xp_reward": 125,
        "sub_quests": [
            {"title": "Find largest directories (du -sh)", "sort_order": 1},
            {"title": "Identify stale logs, backups, or caches", "sort_order": 2},
            {"title": "Clean up and verify free space", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "cache_bloat": {
        "title": "The Bloated Archives",
        "technical_label": "{target} cache at {size_mb}MB",
        "description": "The {target} cache has grown fat with old scrolls — {size_mb}MB that serves no purpose.",
        "hints": ["Check cache contents for stale entries", "Safely clear: pip cache purge (for pip)", "Verify no active processes depend on cache"],
        "xp_reward": 100,
        "sub_quests": [
            {"title": "Check cache contents for stale entries", "sort_order": 1},
            {"title": "Clear the cache safely", "sort_order": 2},
            {"title": "Verify no services were affected", "sort_order": 3},
        ],
        "actions": [],
    },
    "journal_bloat": {
        "title": "The Endless Scroll",
        "technical_label": "Systemd journal at {size_mb}MB",
        "description": "The recording scrolls grow unwieldy — {size_mb}MB of journal. Trim the history.",
        "hints": ["journalctl --disk-usage to check", "journalctl --vacuum-size=100M to trim", "Set permanent limit in journald.conf"],
        "xp_reward": 100,
        "sub_quests": [
            {"title": "Check journal disk usage", "sort_order": 1},
            {"title": "Vacuum to target size", "sort_order": 2},
            {"title": "Set permanent size limit in journald.conf", "sort_order": 3},
        ],
        "actions": [],
    },
    # The five semantic types realm-optimizer actually emits above severity 2,
    # added with #123. Until the discriminator fix these were unreachable — and
    # once reachable, none of them had a template, so every quest still came out
    # a generic "Realm Disturbance". Field names below are the real payload keys
    # (verified against 7 days of live events); _SafeDict renders "?" for a miss,
    # so a wrong name degrades quietly instead of raising, which is exactly how
    # this class of bug stays invisible. Voice follows realm-optimizer's own
    # event text so the quest reads like the notification that spawned it.
    "tmp_bloat": {
        "title": "The Tmp Catacombs",
        "technical_label": "{path} at {size_mb}MB on {host}",
        "description": "Detritus piles in the catacombs beneath {host} — {size_mb}MB abandoned in {path}. Clear the crypt before it swallows the disk.",
        "hints": ["Check what's largest: du -sh {path}/* | sort -h | tail", "Files older than 10 days are usually safe to remove", "systemd-tmpfiles --clean applies the configured policy"],
        "xp_reward": 100,
        "sub_quests": [
            {"title": "Identify the largest offenders in the path", "sort_order": 1},
            {"title": "Confirm nothing live still holds them open", "sort_order": 2},
            {"title": "Clear the crypt and set a retention policy", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "swap_pressure": {
        "title": "Shadow Memory Rises",
        "technical_label": "Swap {percent_used}% used on {host} ({used_mb}/{total_mb}MB)",
        "description": "Shadow memory presses on {host} — {percent_used}% of the swap is spoken for. The node still breathes, but it is reaching into the dark to do it.",
        "hints": ["Find the real memory hog first: ps -eo rss,comm --sort=-rss | head", "Swap in use is not itself an emergency — sustained swap *thrashing* is (check si/so in vmstat 1)", "Adding swap treats the symptom; the resident set is the cause"],
        "xp_reward": 150,
        "sub_quests": [
            {"title": "Identify the top resident-memory consumer", "sort_order": 1},
            {"title": "Distinguish steady swap use from active thrashing", "sort_order": 2},
            {"title": "Decide: restart the service, cap it, or add memory", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "high_load": {
        "title": "The Great Burden",
        "technical_label": "Load {load_5min} over {cpu_count} cores on {host}",
        "description": "The burden on {host} is great — a 5-minute load of {load_5min} across {cpu_count} cores, past the {threshold} the realm tolerates. Find what pulls the cart.",
        "hints": ["Load counts runnable AND uninterruptible tasks — high load with idle CPU means I/O wait, not compute", "Compare against core count: {load_5min} over {cpu_count} cores", "top -o %CPU, then iostat if the CPUs look idle"],
        "xp_reward": 150,
        "sub_quests": [
            {"title": "Determine whether this is CPU-bound or I/O-bound", "sort_order": 1},
            {"title": "Identify the process driving it", "sort_order": 2},
            {"title": "Decide: expected workload, or intervene", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "zombie_processes": {
        "title": "The Restless Wraiths",
        "technical_label": "{zombie_count} zombie processes on {host}",
        "description": "{zombie_count} restless wraiths haunt {host} — processes dead but unreaped, waiting on a parent that never called for them.",
        "hints": ["Zombies cost almost nothing individually; a *growing* count means a parent that never wait()s", "Find the parent, not the zombie: ps -eo stat,ppid,pid,comm | awk '$1 ~ /Z/'", "The fix is restarting (or patching) the parent — you cannot kill a zombie"],
        "xp_reward": 125,
        "sub_quests": [
            {"title": "Identify the parent failing to reap", "sort_order": 1},
            {"title": "Check whether the count is stable or climbing", "sort_order": 2},
            {"title": "Restart the parent, or file the bug upstream", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "dns_failure": {
        "title": "The Clouded Sight",
        "technical_label": "DNS resolution failed for {hostname} from {host}",
        "description": "The far-seeing of {host} has clouded — the Naming Stones will not answer for {hostname}. Until sight returns, the realm is half-blind.",
        "hints": ["Separate resolver from network: dig {hostname} vs dig @1.1.1.1 {hostname}", "Check what resolver is actually in use: resolvectl status", "One name failing is a record problem; every name failing is a resolver problem"],
        "xp_reward": 200,
        "sub_quests": [
            {"title": "Determine whether one name or all names fail", "sort_order": 1},
            {"title": "Test an external resolver directly", "sort_order": 2},
            {"title": "Repair the resolver or the record", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
    },
    "shell_extension_crash": {
        "title": "Structural Instability",
        "technical_label": "GNOME Shell extension crash",
        "description": "A tremor ripples through the realm infrastructure. A shell extension has collapsed.",
        "hints": ["Check logs: journalctl /usr/bin/gnome-shell", "Identify which extension crashed", "Try disabling the faulty extension"],
        "xp_reward": 150,
        "sub_quests": [
            {"title": "Check GNOME Shell logs", "sort_order": 1},
            {"title": "Identify the crashed extension", "sort_order": 2},
            {"title": "Disable or fix the faulty extension", "sort_order": 3},
        ],
        "actions": [],
    },
    "shell_segfault": {
        "title": "The Shattering",
        "technical_label": "GNOME Shell segmentation fault",
        "description": "The realm's visual wards shatter. GNOME Shell has crashed and must rebuild.",
        "hints": ["Check coredumpctl for crash details", "Review recently installed extensions", "Consider safe mode: disable all extensions"],
        "xp_reward": 200,
        "sub_quests": [
            {"title": "Check coredumpctl for crash details", "sort_order": 1},
            {"title": "Review recently installed extensions", "sort_order": 2},
            {"title": "Decide: disable extensions or file a bug", "sort_order": 3},
        ],
        "actions": [],
    },
    "vm_started": {
        "title": "Portal Opened",
        "technical_label": "VM {domain} started ({realm_name})",
        "description": "A summoning portal crackles to life — {realm_name} materializes. The realm {domain} is now accessible.",
        "hints": ["Connect via virt-viewer to access the realm", "Check the VM's resource allocation", "Verify network connectivity to the realm"],
        "xp_reward": 50,
        "sub_quests": [
            {"title": "Verify VM is reachable on the network", "sort_order": 1},
            {"title": "Check resource allocation", "sort_order": 2},
        ],
        "actions": [{"type": "pan", "node": "{domain}", "label": "View Realm"}],
    },
    "vm_stopped": {
        "title": "Portal Sealed",
        "technical_label": "VM {domain} stopped ({realm_name})",
        "description": "{realm_name} fades from existence. The portal to {domain} is sealed.",
        "hints": ["Verify the shutdown was intentional", "Check if dependent services need the realm", "Review the realm's final state before dismissal"],
        "xp_reward": 50,
        "sub_quests": [
            {"title": "Verify shutdown was intentional", "sort_order": 1},
            {"title": "Check for dependent services", "sort_order": 2},
        ],
        "actions": [{"type": "pan", "node": "{domain}", "label": "View Realm"}],
    },
    "vm_crashed": {
        "title": "Realm Collapse",
        "technical_label": "VM {domain} crashed ({realm_name})",
        "description": "The fabric of {realm_name} tears apart — {domain} has collapsed without warning. Investigate the catastrophe.",
        "hints": ["Check virsh domblkerror and dmesg for crash cause", "Review VM resource limits — was it starved?", "Attempt to restart: virsh start {domain}"],
        "xp_reward": 200,
        "sub_quests": [
            {"title": "Check virsh domblkerror and dmesg", "sort_order": 1},
            {"title": "Review VM resource limits", "sort_order": 2},
            {"title": "Attempt to restart the realm", "sort_order": 3},
        ],
        "actions": [{"type": "pan", "node": "{domain}", "label": "View Realm"}],
    },
}

_DEFAULT_TEMPLATE = {
    "title": "Realm Disturbance",
    "technical_label": "{event_type} on {host}",
    "description": "Something stirs in the realm. A {event_type} event has been detected. Investigate and report your findings.",
    "hints": ["Check the affected node's status", "Review recent events for context", "Document what you find"],
    "xp_reward": 100,
    "sub_quests": [
        {"title": "Check the affected node's status", "sort_order": 1},
        {"title": "Review recent events for context", "sort_order": 2},
        {"title": "Document findings and decide next steps", "sort_order": 3},
    ],
    "actions": [{"type": "pan", "node": "{host}", "label": "View Node"}],
}


class _SafeDict(dict):
    def __missing__(self, key):
        return "?"


def _insert_quest(
    conn,
    *,
    event_id: str | None,
    entity_id: str | None,
    event_type: str,
    severity: int,
    host: str,
    payload: dict,
) -> dict | None:
    """Shared insertion logic — used by both generate_from_event_dict and
    the legacy generate_from_event(event_id) path.
    """
    template = _TEMPLATES.get(event_type, _DEFAULT_TEMPLATE)
    fmt_vars = _SafeDict({k: str(v) for k, v in {
        "host": host, "event_type": event_type, **payload}.items()})

    title = template["title"]
    tech_label = template["technical_label"].format_map(fmt_vars)
    description = template["description"].format_map(fmt_vars)
    hints = json.dumps(template["hints"])

    actions_raw = template.get("actions", [])
    actions_resolved = []
    for a in actions_raw:
        actions_resolved.append({
            k: (v.format_map(fmt_vars) if isinstance(v, str) else v)
            for k, v in a.items()
        })
    actions_json = json.dumps(actions_resolved)
    node = fmt_vars.get("host", None)

    qid = ulid()
    now_ms = int(time.time() * 1000)
    # dedupe_key keeps the RAW id even when it isn't a resolvable FK. It is a
    # local uniqueness string, not a reference, and a stable per-event key
    # ("quest:realm:194308") dedupes far better than the millisecond timestamp
    # it used to fall back to — that made every retry of the same event look
    # like a brand-new incident.
    dedupe_key = f"quest:{event_id}" if event_id else f"quest:{event_type}:{host}:{now_ms}"

    # quests.source_event_id and quest_event_links.event_id are both FKs into
    # game.db's ULID-keyed `events` table. Realmwatch events live in realm.db
    # under an INTEGER AUTOINCREMENT id, which the caller stringifies to
    # "realm:<int>" — a value that by construction cannot exist in game.db. With
    # PRAGMA foreign_keys=ON that made every INSERT for a novel event raise
    # "FOREIGN KEY constraint failed", so auto-generation never once worked
    # (#123). Resolve the reference before writing it: keep it when the event
    # genuinely lives in game.db, store NULL when it doesn't. The column is
    # nullable, and NULL is the honest answer — the event exists, just in the
    # other store.
    # The OperationalError arm is not defensive padding: this module's own
    # bootstrap (db.py) does not create `events` — realm-engine owns it — so on
    # a fresh install that loads quests first the table genuinely is absent.
    # Unverifiable means unresolvable, which means NULL.
    src_event_id = None
    if event_id:
        try:
            if conn.execute("SELECT 1 FROM events WHERE event_id=?",
                            (event_id,)).fetchone():
                src_event_id = event_id
        except sqlite3.OperationalError:
            src_event_id = None

    existing = conn.execute(
        "SELECT * FROM quests WHERE dedupe_key=?", (dedupe_key,)).fetchone()
    if existing:
        return dict(existing)

    conn.execute("""INSERT INTO quests
        (quest_id, quest_type, source_event_id, entity_id, title, technical_label,
         description, severity, status, hints_json, xp_reward, created_ts, dedupe_key,
         actions_json, node, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
        (qid, "auto_anomaly", src_event_id, entity_id,
         title, tech_label, description, severity,
         "created", hints, template["xp_reward"], now_ms, dedupe_key,
         actions_json, node))

    # Gate the link row on the same resolution. The live table carries
    # FOREIGN KEY (event_id) REFERENCES events(event_id); an unresolvable id
    # would fail here for exactly the same reason, and a link to an event in
    # another database is not a link worth recording.
    if src_event_id:
        conn.execute(
            "INSERT INTO quest_event_links (quest_id, event_id, role) VALUES (?,?,'trigger')",
            (qid, src_event_id))

    conn.execute(
        "INSERT INTO quest_state_log (quest_id, new_state, transition_ts, actor) VALUES (?,?,?,?)",
        (qid, "created", now_ms, "system"))

    conn.commit()

    sub_quests_def = template.get("sub_quests", [])
    for i, sub_def in enumerate(sub_quests_def):
        sub_title = sub_def.get("title", f"Step {i+1}").format_map(fmt_vars)
        sub_node = sub_def.get("node", host)
        sub_sort = sub_def.get("sort_order", i)
        _create_sub_quest_in_conn(conn, qid, sub_title, sub_node, sub_sort, severity)

    row = conn.execute("SELECT * FROM quests WHERE quest_id=?", (qid,)).fetchone()
    return dict(row)


def _create_sub_quest_in_conn(
    conn,
    parent_quest_id: str,
    title: str,
    node: str | None,
    sort_order: int,
    severity: int,
) -> None:
    """Insert a sub-quest using the already-open connection (no commit yet)."""
    parent = conn.execute(
        "SELECT entity_id FROM quests WHERE quest_id=?",
        (parent_quest_id,)).fetchone()
    if not parent:
        return
    qid = ulid()
    now_ms = int(time.time() * 1000)
    dedupe_key = f"sub:{parent_quest_id}:{sort_order}:{title}"
    existing = conn.execute(
        "SELECT 1 FROM quests WHERE dedupe_key=?", (dedupe_key,)).fetchone()
    if existing:
        return
    conn.execute("""INSERT INTO quests
        (quest_id, quest_type, entity_id, title, severity, status, xp_reward,
         created_ts, dedupe_key, parent_quest_id, node, sort_order, schema_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)""",
        (qid, "sub_quest", parent["entity_id"], title, severity,
         "created", 0, now_ms, dedupe_key, parent_quest_id, node, sort_order))
    conn.execute(
        "INSERT INTO quest_state_log (quest_id, new_state, transition_ts, actor) VALUES (?,?,?,?)",
        (qid, "created", now_ms, "system"))
    conn.commit()


# ── Public entry points ───────────────────────────────────────────────────


def generate_quest_from_event_dict(
    event: dict,
    db_path: str = DEFAULT_DB_PATH,
    severity_threshold: int | None = None,
) -> dict | None:
    """Generate a quest from an in-memory event dict.

    This is the entry point realmwatch's event bus uses — events arrive as
    dicts via ctx.on_event(...), not as rows in game.db.

    Event dict shape (realmwatch):
        {type, node, text, severity, source, ts, id, data?, ...}
    The `data` key (or extra top-level keys) is treated as the template
    payload for substitution.

    `severity_threshold` defaults to AUTO_QUEST_MIN_SEVERITY; pass an explicit
    value to override (the manual /plugins/quests/generate path does).
    """
    if severity_threshold is None:
        severity_threshold = AUTO_QUEST_MIN_SEVERITY

    # Semantic type, not the transport envelope — see quest_discriminator.
    event_type = quest_discriminator(event)
    if not event_type:
        return None

    severity = int(event.get("severity") or 0)
    if severity < severity_threshold:
        return None

    host = event.get("node") or event.get("host") or "unknown"
    if should_throttle(db_path, event_type, host):
        return None

    payload = dict(event)
    extra = event.get("data") if isinstance(event.get("data"), dict) else None
    if extra:
        payload.update(extra)
    # Ensure host substitution works
    payload.setdefault("host", host)

    # event_id: realm.db events use an int id; quote-friendly representation
    eid = event.get("event_id")
    if eid is None and "id" in event:
        eid = f"realm:{event['id']}"
    entity_id = event.get("entity_id")

    conn = get_connection(db_path)
    try:
        # Durable volume backstop. Checked here rather than in _insert_quest so
        # the manual generate path and the legacy game.db path stay uncapped —
        # this bounds the *event bus*, which is the only unattended producer.
        if AUTO_QUEST_DAILY_CAP > 0:
            minted = _auto_quests_last_24h(conn)
            if minted >= AUTO_QUEST_DAILY_CAP:
                # Arm the cooldown so a capped realm stops re-entering per event.
                record_event_seen(db_path, event_type, host)
                return None
        result = _insert_quest(
            conn,
            event_id=eid,
            entity_id=entity_id,
            event_type=event_type,
            severity=severity,
            host=host,
            payload=payload,
        )
    finally:
        # Arm the cooldown on every attempt, not only on success. This used to
        # sit behind `if result is not None`, so a failing insert never armed
        # the 15-minute window and each qualifying event retried and re-logged
        # forever — 100 identical FK errors in a 2-hour window (#123). A failure
        # is exactly when a circuit breaker should trip, so no future failure
        # mode can spam the same way. Inside `finally` so it also covers an
        # exception propagating out of _insert_quest.
        record_event_seen(db_path, event_type, host)
        conn.close()

    return result


def generate_quest_from_event(
    db_path: str = DEFAULT_DB_PATH,
    event_id: str = "",
    severity_threshold: int = 2,
) -> dict | None:
    """Generate a quest from an event row stored in game.db.

    Kept for compatibility with the original quest-forge interface. Looks
    the event up in game.db's `events` table, then runs the same template
    expansion as generate_quest_from_event_dict.
    """
    conn = get_connection(db_path)
    try:
        event = conn.execute(
            "SELECT * FROM events WHERE event_id=?", (event_id,)).fetchone()
        if not event:
            return None
        if event["severity"] < severity_threshold:
            return None

        payload = json.loads(event["raw_payload_json"]) if event["raw_payload_json"] else {}
        host = payload.get("host", "unknown")
        event_type = event["event_type"]

        if should_throttle(db_path, event_type, host):
            return None

        result = _insert_quest(
            conn,
            event_id=event_id,
            entity_id=event["entity_id"],
            event_type=event_type,
            severity=event["severity"],
            host=host,
            payload=payload,
        )
    finally:
        conn.close()

    if result is not None:
        record_event_seen(db_path, event_type, host)
    return result


def create_sub_quest(
    db_path: str = DEFAULT_DB_PATH,
    parent_quest_id: str = "",
    title: str = "",
    node: str | None = None,
    sort_order: int = 0,
) -> dict | None:
    """Create a child quest linked to a parent quest."""
    conn = get_connection(db_path)
    try:
        parent = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (parent_quest_id,)).fetchone()
        if not parent:
            return None

        qid = ulid()
        now_ms = int(time.time() * 1000)
        dedupe_key = f"sub:{parent_quest_id}:{sort_order}:{title}"

        existing = conn.execute(
            "SELECT * FROM quests WHERE dedupe_key=?", (dedupe_key,)).fetchone()
        if existing:
            return dict(existing)

        conn.execute("""INSERT INTO quests
            (quest_id, quest_type, entity_id, title, severity, status, xp_reward,
             created_ts, dedupe_key, parent_quest_id, node, sort_order, schema_version)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)""",
            (qid, "sub_quest", parent["entity_id"], title, parent["severity"],
             "created", 0, now_ms, dedupe_key, parent_quest_id, node, sort_order))

        conn.execute(
            "INSERT INTO quest_state_log (quest_id, new_state, transition_ts, actor) VALUES (?,?,?,?)",
            (qid, "created", now_ms, "system"))

        conn.commit()
        row = conn.execute("SELECT * FROM quests WHERE quest_id=?", (qid,)).fetchone()
        return dict(row)
    finally:
        conn.close()


def complete_sub_quest(
    db_path: str = DEFAULT_DB_PATH,
    quest_id: str = "",
) -> dict:
    """Mark a sub-quest as resolved. If all siblings are resolved, auto-resolve the parent."""
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        if not row:
            return {"error": f"Quest {quest_id} not found"}

        if not row["parent_quest_id"]:
            return {"error": f"Quest {quest_id} is not a sub-quest"}

        now_ms = int(time.time() * 1000)
        parent_id = row["parent_quest_id"]

        conn.execute(
            "UPDATE quests SET status='resolved', resolved_ts=? WHERE quest_id=?",
            (now_ms, quest_id))
        conn.execute(
            "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) "
            "VALUES (?,?,?,?,?)",
            (quest_id, row["status"], "resolved", now_ms, "user"))
        conn.commit()

        unresolved = conn.execute(
            "SELECT COUNT(*) as cnt FROM quests WHERE parent_quest_id=? AND status != 'resolved'",
            (parent_id,)).fetchone()["cnt"]

        result = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        result_dict = dict(result)
        result_dict["parent_resolved"] = False

        if unresolved == 0:
            parent = conn.execute(
                "SELECT * FROM quests WHERE quest_id=?", (parent_id,)).fetchone()
            if parent and parent["status"] in ("created", "active"):
                conn.execute(
                    "UPDATE quests SET status='resolved', resolved_ts=? WHERE quest_id=?",
                    (now_ms, parent_id))
                conn.execute(
                    "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) "
                    "VALUES (?,?,?,?,?)",
                    (parent_id, parent["status"], "resolved", now_ms, "system:auto"))
                conn.commit()
                result_dict["parent_resolved"] = True
        return result_dict
    finally:
        conn.close()


def list_quests(
    db_path: str = DEFAULT_DB_PATH,
    status: str | None = None,
    limit: int = 20,
    tree: bool = False,
) -> list[dict]:
    """List quests, optionally filtered by status."""
    conn = get_connection(db_path)
    try:
        if tree:
            if status:
                parents = conn.execute(
                    "SELECT * FROM quests WHERE parent_quest_id IS NULL AND status=? "
                    "ORDER BY created_ts DESC LIMIT ?",
                    (status, limit)).fetchall()
            else:
                parents = conn.execute(
                    "SELECT * FROM quests WHERE parent_quest_id IS NULL "
                    "ORDER BY created_ts DESC LIMIT ?",
                    (limit,)).fetchall()

            result = []
            for p in parents:
                pd = dict(p)
                children = conn.execute(
                    "SELECT * FROM quests WHERE parent_quest_id=? ORDER BY sort_order ASC",
                    (p["quest_id"],)).fetchall()
                pd["children"] = [dict(c) for c in children]
                result.append(pd)
            return result

        if status:
            rows = conn.execute(
                "SELECT * FROM quests WHERE status=? ORDER BY created_ts DESC LIMIT ?",
                (status, limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM quests ORDER BY created_ts DESC LIMIT ?",
                (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_quest(db_path: str = DEFAULT_DB_PATH, quest_id: str = "") -> dict | None:
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def transition_quest(
    db_path: str = DEFAULT_DB_PATH,
    quest_id: str = "",
    new_state: str = "",
    actor: str = "user",
) -> dict:
    """Transition a quest to a new state. Forward-only."""
    conn = get_connection(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        if not row:
            return {"error": f"Quest {quest_id} not found"}

        current_state = row["status"]
        if new_state not in QUEST_STATES:
            return {"error": f"Invalid state: {new_state}"}

        current_idx = QUEST_STATES.index(current_state)
        new_idx = QUEST_STATES.index(new_state)
        if new_idx <= current_idx:
            return {"error": f"Cannot transition backward from '{current_state}' to '{new_state}'"}

        now_ms = int(time.time() * 1000)
        cols = [c[1] for c in conn.execute("PRAGMA table_info(quests)").fetchall()]
        ts_field = f"{new_state}_ts" if f"{new_state}_ts" in cols else None

        conn.execute(
            "UPDATE quests SET status=? WHERE quest_id=?", (new_state, quest_id))
        if ts_field:
            conn.execute(
                f"UPDATE quests SET {ts_field}=? WHERE quest_id=?", (now_ms, quest_id))

        conn.execute(
            "INSERT INTO quest_state_log (quest_id, previous_state, new_state, transition_ts, actor) "
            "VALUES (?,?,?,?,?)",
            (quest_id, current_state, new_state, now_ms, actor))
        conn.commit()

        row = conn.execute(
            "SELECT * FROM quests WHERE quest_id=?", (quest_id,)).fetchone()
        return dict(row)
    finally:
        conn.close()


def activate_quest(db_path: str = DEFAULT_DB_PATH, quest_id: str = "") -> dict:
    return transition_quest(db_path, quest_id, "active", "user")


def resolve_quest(db_path: str = DEFAULT_DB_PATH, quest_id: str = "") -> dict:
    return transition_quest(db_path, quest_id, "resolved", "user")
