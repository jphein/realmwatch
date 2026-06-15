"""Unified SQLite storage for the Realm — settings, events, personas, topology."""

import atexit
import json
import logging
import os
import sqlite3
import threading
import time

log = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "realm.db")
_local = threading.local()
_all_connections = []  # list of (thread_id, conn)
_all_connections_lock = threading.Lock()


def _conn():
    """Thread-local connection (SQLite doesn't allow cross-thread sharing)."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH, timeout=5)
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.execute("PRAGMA busy_timeout=10000")
        _local.conn.row_factory = sqlite3.Row
        with _all_connections_lock:
            _all_connections.append((threading.current_thread().ident, _local.conn))
    return _local.conn


def _prune_dead_connections():
    """Close connections from threads that no longer exist."""
    alive_ids = {t.ident for t in threading.enumerate()}
    with _all_connections_lock:
        still_alive = []
        for tid, conn in _all_connections:
            if tid in alive_ids:
                still_alive.append((tid, conn))
            else:
                try:
                    conn.close()
                except Exception:
                    pass
        pruned = len(_all_connections) - len(still_alive)
        _all_connections[:] = still_alive
    if pruned:
        log.debug("Pruned %d dead-thread DB connections (%d remaining)", pruned, len(still_alive))
    return pruned


def _cleanup_connections():
    """Close all tracked connections and checkpoint WAL on shutdown."""
    with _all_connections_lock:
        for _tid, conn in _all_connections:
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
        _all_connections.clear()


atexit.register(_cleanup_connections)


def init():
    """Create tables if they don't exist."""
    c = _conn()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS settings (
            namespace TEXT NOT NULL,
            key       TEXT NOT NULL,
            value     TEXT,
            PRIMARY KEY (namespace, key)
        );
        CREATE TABLE IF NOT EXISTS events (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            ts   REAL NOT NULL,
            type TEXT,
            data TEXT
        );
        CREATE TABLE IF NOT EXISTS personas (
            node_id TEXT PRIMARY KEY,
            data    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nodes (
            node_id TEXT PRIMARY KEY,
            x       REAL NOT NULL DEFAULT 0,
            y       REAL NOT NULL DEFAULT 0,
            data    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            from_node TEXT NOT NULL,
            to_node   TEXT NOT NULL,
            type      TEXT,
            vlan      INTEGER,
            data      TEXT
        );
        CREATE TABLE IF NOT EXISTS regions (
            region_id TEXT PRIMARY KEY,
            data      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notion_synced (
            notion_id TEXT PRIMARY KEY,
            synced_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wifi_scans (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        REAL NOT NULL,
            data      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quests (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            description TEXT,
            parent_id   TEXT,
            node        TEXT,
            status      TEXT NOT NULL DEFAULT 'active',
            actions     TEXT,
            sort_order  INTEGER DEFAULT 0,
            created_at  REAL,
            completed_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
        CREATE INDEX IF NOT EXISTS idx_conn_from ON connections(from_node);
        CREATE INDEX IF NOT EXISTS idx_conn_to ON connections(to_node);
        CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_id);

        CREATE TABLE IF NOT EXISTS sub_entities (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            host_node_id TEXT NOT NULL,
            status TEXT DEFAULT 'unknown',
            metadata TEXT DEFAULT '{}',
            linked_node_id TEXT,
            provider TEXT NOT NULL,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            link_type TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sub_entities_host ON sub_entities(host_node_id);
        CREATE INDEX IF NOT EXISTS idx_sub_entities_linked ON sub_entities(linked_node_id);
        CREATE INDEX IF NOT EXISTS idx_sub_entities_provider ON sub_entities(provider);

        CREATE TABLE IF NOT EXISTS discovery_links (
            sub_entity_id TEXT PRIMARY KEY,
            linked_node_id TEXT NOT NULL,
            created REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS discovery_capabilities (
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            available INTEGER DEFAULT 1,
            last_checked REAL,
            error TEXT,
            PRIMARY KEY (node_id, provider)
        );
    """)
    c.commit()
    # Migration: add rewards column to quests (idempotent)
    try:
        c.execute("ALTER TABLE quests ADD COLUMN rewards TEXT")
        c.commit()
    except Exception:
        pass  # Column already exists

    # Migration: event acknowledgement columns (Zabbix issue #8)
    for col, ddl in [
        ("ack_at",   "ALTER TABLE events ADD COLUMN ack_at REAL"),
        ("ack_by",   "ALTER TABLE events ADD COLUMN ack_by TEXT"),
        ("ack_note", "ALTER TABLE events ADD COLUMN ack_note TEXT"),
        ("closed_at","ALTER TABLE events ADD COLUMN closed_at REAL"),
    ]:
        try:
            c.execute(ddl)
            c.commit()
        except Exception:
            pass  # Column already exists

    # Migration: link_type on discovery_links (#116) — distinguish operator
    # 'manual' overrides from auto-resolved provider links (e.g. 'ha-device').
    # Existing rows default to 'manual', preserving prior override semantics.
    try:
        c.execute("ALTER TABLE discovery_links ADD COLUMN link_type TEXT DEFAULT 'manual'")
        c.commit()
    except Exception:
        pass  # Column already exists

    # Prune old events and stale reward dedup entries on startup
    prune_events()


def prune_events(max_age_days=30, max_rows=10000):
    """Delete old events and stale reward dedup entries."""
    c = _conn()
    cutoff = time.time() - (max_age_days * 86400)

    # Delete events older than max_age_days
    c.execute("DELETE FROM events WHERE ts < ?", (cutoff,))

    # If still over max_rows, delete oldest until at max_rows
    count = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    if count > max_rows:
        c.execute("""DELETE FROM events WHERE id IN (
            SELECT id FROM events ORDER BY ts ASC LIMIT ?
        )""", (count - max_rows,))

    # Clean up reward dedup entries older than 90 days.
    # Values are stored as JSON-encoded grant timestamps (floats).
    # Legacy entries stored as JSON "true" are treated as expired.
    reward_cutoff = time.time() - (90 * 86400)
    c.execute("""DELETE FROM settings
        WHERE namespace = 'player_rewards'
        AND (
            (TYPEOF(CAST(value AS REAL)) = 'real' AND CAST(value AS REAL) > 0 AND CAST(value AS REAL) < ?)
            OR value = 'true'
        )""", (reward_cutoff,))

    c.commit()


# ── Settings ──

def get_settings(namespace=None):
    """Get settings. If namespace given, return {key: value} for that namespace.
    If None, return {namespace: {key: value}} for all."""
    c = _conn()
    if namespace:
        rows = c.execute("SELECT key, value FROM settings WHERE namespace=?", (namespace,)).fetchall()
        out = {}
        for r in rows:
            try:
                out[r["key"]] = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                out[r["key"]] = r["value"]
        return out
    else:
        rows = c.execute("SELECT namespace, key, value FROM settings").fetchall()
        out = {}
        for r in rows:
            ns = r["namespace"]
            if ns not in out:
                out[ns] = {}
            try:
                out[ns][r["key"]] = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                out[ns][r["key"]] = r["value"]
        return out


def set_settings(namespace, updates):
    """Upsert key/value pairs into a namespace."""
    c = _conn()
    for k, v in updates.items():
        val = json.dumps(v) if not isinstance(v, str) else json.dumps(v)
        c.execute("INSERT OR REPLACE INTO settings (namespace, key, value) VALUES (?, ?, ?)",
                  (namespace, k, val))
    c.commit()


def get_setting(namespace, key, default=None):
    c = _conn()
    row = c.execute("SELECT value FROM settings WHERE namespace=? AND key=?",
                    (namespace, key)).fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except (json.JSONDecodeError, TypeError):
        return row["value"]


def delete_setting(namespace, key):
    """Delete a single setting by namespace and key."""
    c = _conn()
    c.execute("DELETE FROM settings WHERE namespace=? AND key=?", (namespace, key))
    c.commit()


# ── Events ──

_DEDUP_WINDOW = 300  # suppress identical node+type+text within 5 minutes
_dedup_cache = {}    # {(node, type, text): timestamp}

def push_event(event):
    """Store an event. Returns event dict with db id injected.
    Deduplicates: skips if same node+type+text was stored in last 5 minutes.
    Quest-type events also auto-create a structured quest card."""
    event["ts"] = time.time()
    now = event["ts"]

    # Dedup: skip if identical event seen recently
    node = event.get("node", "")
    text = event.get("text", "")
    etype = event.get("type", "")
    if node and text:
        key = (node, etype, text)
        last = _dedup_cache.get(key, 0)
        if now - last < _DEDUP_WINDOW:
            return event  # duplicate, skip
        _dedup_cache[key] = now
        # Prune stale cache entries periodically
        if len(_dedup_cache) > 500:
            stale = [k for k, ts in _dedup_cache.items() if now - ts > _DEDUP_WINDOW]
            for k in stale:
                del _dedup_cache[k]

    c = _conn()
    cur = c.execute("INSERT INTO events (ts, type, data) VALUES (?, ?, ?)",
                    (now, etype, json.dumps(event)))
    c.commit()
    event["id"] = cur.lastrowid

    # Auto-create structured quest card for quest-type events
    if etype == "quest" and text:
        _auto_create_quest(event)

    return event


def _auto_create_quest(event):
    """Parse a quest event's text into a structured quest card."""
    import re
    text = event["text"]
    node = event.get("node", "katana")

    # Split "Title — description" or "Title - description"
    m = re.split(r"\s*[—–]\s*", text, maxsplit=1)
    title = m[0].strip() if m else text[:60]
    description = m[1].strip() if len(m) > 1 else ""

    # Generate stable ID from title
    quest_id = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40]

    # Skip if quest with this ID already exists
    if get_quest(quest_id):
        return

    actions = [{"type": "pan", "node": node, "label": "View Node"}]
    quest = {
        "id": quest_id,
        "title": title,
        "description": description,
        "node": node,
        "status": "active",
        "sort_order": 0,
        "actions": actions,
        "created_at": event.get("ts", time.time()),
    }
    upsert_quest(quest)


def get_events_since(since_ts):
    """Read events newer than since_ts. Merges ack/close columns into each event dict."""
    c = _conn()
    rows = c.execute(
        """SELECT id, data, ack_at, ack_by, ack_note, closed_at
           FROM events WHERE ts > ? ORDER BY ts""",
        (since_ts,),
    ).fetchall()
    out = []
    for r in rows:
        try:
            evt = json.loads(r["data"])
            evt["id"] = r["id"]
            # Surface ack/close state alongside the original event payload so
            # the alerting hook and the UI both see one consistent view.
            if r["ack_at"]:
                evt["ack_at"] = r["ack_at"]
                evt["ack_by"] = r["ack_by"] or ""
                evt["ack_note"] = r["ack_note"] or ""
            if r["closed_at"]:
                evt["closed_at"] = r["closed_at"]
            out.append(evt)
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def ack_event(event_id, ack_by="", note=""):
    """Acknowledge an event. Returns updated event dict or None if not found."""
    c = _conn()
    cur = c.execute(
        "UPDATE events SET ack_at = ?, ack_by = ?, ack_note = ? WHERE id = ? AND ack_at IS NULL",
        (time.time(), ack_by, note, event_id),
    )
    c.commit()
    if cur.rowcount == 0:
        return None
    return _get_event_by_id(event_id)


def close_event(event_id):
    """Close an event (resolution). Returns updated event dict or None."""
    c = _conn()
    cur = c.execute(
        "UPDATE events SET closed_at = ? WHERE id = ? AND closed_at IS NULL",
        (time.time(), event_id),
    )
    c.commit()
    if cur.rowcount == 0:
        return None
    return _get_event_by_id(event_id)


def get_unacked_events(event_types=None, lookback_seconds=86400):
    """Return events that are not yet acknowledged and not yet closed.

    Defaults: last 24h. Filter by event_types if provided.
    """
    c = _conn()
    cutoff = time.time() - lookback_seconds
    query = """SELECT id, data, ack_at, closed_at
               FROM events
               WHERE ts > ? AND ack_at IS NULL AND closed_at IS NULL"""
    params = [cutoff]
    if event_types:
        placeholders = ",".join("?" * len(event_types))
        query += f" AND type IN ({placeholders})"
        params.extend(event_types)
    query += " ORDER BY ts DESC"
    rows = c.execute(query, params).fetchall()
    out = []
    for r in rows:
        try:
            evt = json.loads(r["data"])
            evt["id"] = r["id"]
            out.append(evt)
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def find_recent_acked_event(event_type, node, text_prefix, lookback_seconds=3600):
    """Look up the most recent acked-but-not-closed event matching (type, node, text prefix).

    Used by the alerting pipeline to decide whether a new event should be
    suppressed because a human already acked the matching condition.
    """
    c = _conn()
    cutoff = time.time() - lookback_seconds
    rows = c.execute(
        """SELECT id, data, ack_at, ack_by FROM events
           WHERE ts > ? AND type = ? AND ack_at IS NOT NULL AND closed_at IS NULL
             AND json_extract(data, '$.node') = ?
             AND substr(COALESCE(json_extract(data, '$.text'), ''), 1, 50) = substr(?, 1, 50)
           ORDER BY ts DESC LIMIT 1""",
        (cutoff, event_type, node, text_prefix),
    ).fetchall()
    if not rows:
        return None
    r = rows[0]
    try:
        evt = json.loads(r["data"])
        evt["id"] = r["id"]
        evt["ack_at"] = r["ack_at"]
        evt["ack_by"] = r["ack_by"] or ""
        return evt
    except (json.JSONDecodeError, TypeError):
        return None


def _get_event_by_id(event_id):
    """Internal: fetch one event by id with all columns merged."""
    c = _conn()
    rows = c.execute(
        """SELECT id, data, ack_at, ack_by, ack_note, closed_at
           FROM events WHERE id = ?""",
        (event_id,),
    ).fetchall()
    if not rows:
        return None
    r = rows[0]
    try:
        evt = json.loads(r["data"])
        evt["id"] = r["id"]
        if r["ack_at"]:
            evt["ack_at"] = r["ack_at"]
            evt["ack_by"] = r["ack_by"] or ""
            evt["ack_note"] = r["ack_note"] or ""
        if r["closed_at"]:
            evt["closed_at"] = r["closed_at"]
        return evt
    except (json.JSONDecodeError, TypeError):
        return None


def cleanup_old_events(max_age_days=30, max_rows=50000):
    """Delete events older than max_age_days, keeping at most max_rows.
    Called at startup and periodically to prevent unbounded growth."""
    c = _conn()
    cutoff = time.time() - (max_age_days * 86400)
    # Delete by age
    c.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
    # If still over max_rows, keep only the newest
    count = c.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    if count > max_rows:
        c.execute("""DELETE FROM events WHERE id NOT IN (
            SELECT id FROM events ORDER BY ts DESC LIMIT ?)""", (max_rows,))
    deleted = c.total_changes
    c.commit()
    if deleted:
        log.info("Event cleanup: removed %d old events (kept %d days / %d max rows)",
                 deleted, max_age_days, max_rows)
    return deleted


def get_quests():
    """Return all quests as a nested tree (main quests with children)."""
    c = _conn()
    rows = c.execute("SELECT * FROM quests ORDER BY sort_order, created_at").fetchall()
    quests = []
    by_id = {}
    for r in rows:
        q = {
            "id": r["id"], "title": r["title"], "description": r["description"],
            "parent_id": r["parent_id"], "node": r["node"], "status": r["status"],
            "sort_order": r["sort_order"],
            "actions": json.loads(r["actions"]) if r["actions"] else [],
            "created_at": r["created_at"], "completed_at": r["completed_at"],
            "rewards": json.loads(r["rewards"]) if r["rewards"] else None,
            "children": [],
        }
        by_id[q["id"]] = q
        if q["parent_id"] and q["parent_id"] in by_id:
            by_id[q["parent_id"]]["children"].append(q)
        else:
            quests.append(q)
    # Re-parent any children that appeared before their parent
    orphans = [q for q in quests if q["parent_id"]]
    for o in orphans:
        if o["parent_id"] in by_id:
            quests.remove(o)
            by_id[o["parent_id"]]["children"].append(o)
    return quests


def get_quest(quest_id):
    """Return a single quest by ID."""
    c = _conn()
    r = c.execute("SELECT * FROM quests WHERE id = ?", (quest_id,)).fetchone()
    if not r:
        return None
    return {
        "id": r["id"], "title": r["title"], "description": r["description"],
        "parent_id": r["parent_id"], "node": r["node"], "status": r["status"],
        "sort_order": r["sort_order"],
        "actions": json.loads(r["actions"]) if r["actions"] else [],
        "created_at": r["created_at"], "completed_at": r["completed_at"],
        "rewards": json.loads(r["rewards"]) if r["rewards"] else None,
    }


def upsert_quest(quest):
    """Insert or update a quest."""
    c = _conn()
    c.execute("""INSERT OR REPLACE INTO quests
        (id, title, description, parent_id, node, status, actions, sort_order, created_at, completed_at, rewards)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
        quest["id"], quest["title"], quest.get("description"),
        quest.get("parent_id"), quest.get("node"),
        quest.get("status", "active"),
        json.dumps(quest.get("actions", [])),
        quest.get("sort_order", 0),
        quest.get("created_at", time.time()),
        quest.get("completed_at"),
        json.dumps(quest["rewards"]) if quest.get("rewards") else None,
    ))
    c.commit()


def update_quest_status(quest_id, status):
    """Update quest status. Returns True if found."""
    c = _conn()
    completed_at = time.time() if status == "completed" else None
    r = c.execute("UPDATE quests SET status = ?, completed_at = ? WHERE id = ?",
                  (status, completed_at, quest_id))
    c.commit()
    return r.rowcount > 0


def delete_quest(quest_id):
    """Delete a quest and all its descendants in one statement."""
    c = _conn()
    cur = c.execute("""
        DELETE FROM quests WHERE id IN (
            WITH RECURSIVE tree(id) AS (
                SELECT id FROM quests WHERE id = ?
                UNION ALL
                SELECT q.id FROM quests q JOIN tree t ON q.parent_id = t.id
            )
            SELECT id FROM tree
        )""", (quest_id,))
    c.commit()
    return cur.rowcount


def delete_quest_by_text(quest_text):
    """Legacy: delete quest events from events table by text."""
    c = _conn()
    rows = c.execute("SELECT id, data FROM events WHERE type = 'quest'").fetchall()
    deleted = 0
    for r in rows:
        data = json.loads(r["data"])
        if data.get("text") == quest_text:
            c.execute("DELETE FROM events WHERE id = ?", (r["id"],))
            deleted += 1
    c.commit()
    return deleted


# ── Player Rewards ──

_REWARD_TIERS = {
    "quest":                 {"xp": 200, "gold": 50, "gems": 5},
    "sub":                   {"xp": 50,  "gold": 10, "gems": 1},
    "event_alert":           {"xp": 15,  "gold": 5,  "gems": 0},
    "event_oracle_response": {"xp": 20,  "gold": 8,  "gems": 1},
    "event_default":         {"xp": 5,   "gold": 2,  "gems": 0},
}


def calc_level(total_xp):
    """Derive level info from total XP. Threshold N->N+1 = floor(N * 100 * 1.5^(N-1))."""
    level = 1
    cumulative = 0
    while True:
        threshold = int(level * 100 * (1.5 ** (level - 1)))
        if cumulative + threshold > total_xp:
            return {
                "level": level,
                "xp_next": threshold,
                "xp_in_level": total_xp - cumulative,
                "xp_level_start": cumulative,
            }
        cumulative += threshold
        level += 1


def get_player_stats():
    """Return current player stats with derived level info."""
    data = get_settings("player")
    xp = data.get("xp", 0)
    gold = data.get("gold", 0)
    gems = data.get("gems", 0)
    lvl = calc_level(xp)
    return {"xp": xp, "gold": gold, "gems": gems, **lvl}


def _get_reward_for(source, source_id):
    """Determine reward amounts based on source type and id."""
    if source == "quest":
        quest = get_quest(source_id)
        if quest and quest.get("rewards"):
            return quest["rewards"]
        return _REWARD_TIERS["quest"]
    elif source == "sub":
        quest = get_quest(source_id)
        if quest and quest.get("parent_id"):
            parent = get_quest(quest["parent_id"])
            if parent and parent.get("rewards") and isinstance(parent["rewards"], dict) and parent["rewards"].get("sub"):
                return parent["rewards"]["sub"]
        return _REWARD_TIERS["sub"]
    elif source == "event":
        c = _conn()
        row = c.execute("SELECT data FROM events WHERE id = ?", (source_id,)).fetchone()
        if row:
            try:
                evt = json.loads(row["data"])
                etype = evt.get("type", "")
                tier_key = f"event_{etype}" if f"event_{etype}" in _REWARD_TIERS else "event_default"
                return _REWARD_TIERS[tier_key]
            except (json.JSONDecodeError, TypeError):
                pass
        return _REWARD_TIERS["event_default"]
    return {"xp": 0, "gold": 0, "gems": 0}


def grant_reward(source, source_id):
    """Grant a reward. Deduplicates by source:source_id in player_rewards namespace.
    Uses INSERT OR IGNORE + rowcount to avoid TOCTOU race on the dedup key."""
    dedup_key = f"{source}:{source_id}"
    reward = _get_reward_for(source, source_id)
    xp = max(0, reward.get("xp", 0))
    gold = max(0, reward.get("gold", 0))
    gems = max(0, reward.get("gems", 0))

    c = _conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        # Atomic dedup: INSERT OR IGNORE returns rowcount=0 if key already existed
        ts_val = json.dumps(time.time())
        cur = c.execute(
            "INSERT OR IGNORE INTO settings (namespace, key, value) VALUES (?, ?, ?)",
            ("player_rewards", dedup_key, ts_val))

        if cur.rowcount == 0:
            # Duplicate — key already existed
            c.execute("COMMIT")
            stats = get_player_stats()
            return {"granted": False, **stats}

        # Read current stats and apply reward within the same transaction
        row = c.execute(
            "SELECT key, value FROM settings WHERE namespace = 'player'").fetchall()
        data = {}
        for r in row:
            try:
                data[r["key"]] = json.loads(r["value"])
            except (json.JSONDecodeError, TypeError):
                data[r["key"]] = r["value"]

        old_xp = data.get("xp", 0)
        new_xp = old_xp + xp
        new_gold = data.get("gold", 0) + gold
        new_gems = data.get("gems", 0) + gems

        for k, v in {"xp": new_xp, "gold": new_gold, "gems": new_gems}.items():
            c.execute(
                "INSERT OR REPLACE INTO settings (namespace, key, value) VALUES (?, ?, ?)",
                ("player", k, json.dumps(v)))

        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise

    old_level = calc_level(old_xp)["level"]
    new_lvl = calc_level(new_xp)

    return {
        "granted": True,
        "reward": {"xp": xp, "gold": gold, "gems": gems},
        "level_up": new_lvl["level"] > old_level,
        "old_level": old_level,
        "new_level": new_lvl["level"],
        "xp": new_xp, "gold": new_gold, "gems": new_gems,
        **new_lvl,
    }


# ── Personas ──

def get_personas():
    c = _conn()
    rows = c.execute("SELECT node_id, data FROM personas").fetchall()
    out = {}
    for r in rows:
        try:
            out[r["node_id"]] = json.loads(r["data"])
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def get_persona(node_id):
    c = _conn()
    row = c.execute("SELECT data FROM personas WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return None
    try:
        return json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        return None


def set_persona(node_id, data):
    c = _conn()
    c.execute("INSERT OR REPLACE INTO personas (node_id, data) VALUES (?, ?)",
              (node_id, json.dumps(data)))
    c.commit()


def delete_persona(node_id):
    c = _conn()
    c.execute("DELETE FROM personas WHERE node_id=?", (node_id,))
    c.commit()


# ── Migration: import existing JSON files into DB ──

def migrate_personas(personas_file):
    """Import personas.json into DB if personas table is empty."""
    c = _conn()
    count = c.execute("SELECT COUNT(*) FROM personas").fetchone()[0]
    if count > 0:
        return  # already migrated
    if not os.path.exists(personas_file):
        return
    try:
        with open(personas_file) as f:
            data = json.load(f)
        for node_id, pdata in data.items():
            set_persona(node_id, pdata)
        print(f"  Migrated {len(data)} personas to DB")
    except (OSError, json.JSONDecodeError) as e:
        print(f"  Persona migration failed: {e}")


def migrate_config(namespace, config_file, safe_keys=None):
    """Import a JSON config file into settings if namespace is empty."""
    c = _conn()
    count = c.execute("SELECT COUNT(*) FROM settings WHERE namespace=?", (namespace,)).fetchone()[0]
    if count > 0:
        return
    if not os.path.exists(config_file):
        return
    try:
        with open(config_file) as f:
            cfg = json.load(f)
        updates = {}
        for k, v in cfg.items():
            if safe_keys is None or k in safe_keys:
                updates[k] = v
        if updates:
            set_settings(namespace, updates)
            print(f"  Migrated {len(updates)} keys to DB [{namespace}]")
    except (OSError, json.JSONDecodeError) as e:
        print(f"  Config migration failed [{namespace}]: {e}")


# ── Topology: nodes, connections, regions ──

def get_nodes():
    c = _conn()
    rows = c.execute("SELECT node_id, data FROM nodes").fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["data"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def get_node(node_id):
    c = _conn()
    row = c.execute("SELECT data FROM nodes WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return None
    try:
        return json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        return None


def set_node(node_id, data):
    """Upsert a node. data is the full node dict (must include 'id', 'x', 'y')."""
    c = _conn()
    c.execute("INSERT OR REPLACE INTO nodes (node_id, x, y, data) VALUES (?, ?, ?, ?)",
              (node_id, data.get("x", 0), data.get("y", 0), json.dumps(data)))
    c.commit()


def set_nodes_batch(nodes):
    """Upsert multiple nodes in a single transaction.
    nodes: list of (node_id, data_dict) tuples.
    """
    c = _conn()
    c.execute("BEGIN")
    try:
        for node_id, data in nodes:
            c.execute("INSERT OR REPLACE INTO nodes (node_id, x, y, data) VALUES (?, ?, ?, ?)",
                      (node_id, data.get("x", 0), data.get("y", 0), json.dumps(data)))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


def update_node_position(node_id, x, y):
    """Update just the position of a node."""
    c = _conn()
    row = c.execute("SELECT data FROM nodes WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return
    try:
        data = json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        data = {}
    data["x"] = x
    data["y"] = y
    c.execute("UPDATE nodes SET x=?, y=?, data=? WHERE node_id=?",
              (x, y, json.dumps(data), node_id))
    c.commit()


def update_node(node_id, updates):
    """Merge updates into an existing node."""
    c = _conn()
    row = c.execute("SELECT data FROM nodes WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return None
    data = json.loads(row["data"])
    data.update(updates)
    x = data.get("x", 0)
    y = data.get("y", 0)
    c.execute("UPDATE nodes SET x=?, y=?, data=? WHERE node_id=?",
              (x, y, json.dumps(data), node_id))
    c.commit()
    return data


def delete_node(node_id):
    c = _conn()
    c.execute("DELETE FROM nodes WHERE node_id=?", (node_id,))
    c.execute("DELETE FROM connections WHERE from_node=? OR to_node=?", (node_id, node_id))
    c.commit()


def get_connections():
    c = _conn()
    rows = c.execute("SELECT data FROM connections ORDER BY id").fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["data"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def set_connections(conns):
    """Replace all connections."""
    c = _conn()
    c.execute("DELETE FROM connections")
    for conn in conns:
        c.execute("INSERT INTO connections (from_node, to_node, type, vlan, data) VALUES (?, ?, ?, ?, ?)",
                  (conn.get("from", ""), conn.get("to", ""),
                   conn.get("type"), conn.get("vlan"),
                   json.dumps(conn)))
    c.commit()


def add_connection(conn):
    c = _conn()
    c.execute("INSERT INTO connections (from_node, to_node, type, vlan, data) VALUES (?, ?, ?, ?, ?)",
              (conn.get("from", ""), conn.get("to", ""),
               conn.get("type"), conn.get("vlan"),
               json.dumps(conn)))
    c.commit()


def delete_connection(from_node, to_node):
    c = _conn()
    c.execute("DELETE FROM connections WHERE (from_node=? AND to_node=?) OR (from_node=? AND to_node=?)",
              (from_node, to_node, to_node, from_node))
    c.commit()


def get_regions():
    c = _conn()
    rows = c.execute("SELECT data FROM regions").fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["data"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return out


def set_regions(regions):
    c = _conn()
    c.execute("DELETE FROM regions")
    for reg in regions:
        rid = reg.get("id", reg.get("name", ""))
        c.execute("INSERT INTO regions (region_id, data) VALUES (?, ?)",
                  (rid, json.dumps(reg)))
    c.commit()


def get_topology():
    """Return full topology dict from DB (same shape as topology.json)."""
    return {
        "nodes": get_nodes(),
        "connections": get_connections(),
        "regions": get_regions(),
    }


def save_topology_json(path):
    """Write-through: dump current DB topology to JSON file."""
    topo = get_topology()
    with open(path, "w") as f:
        json.dump(topo, f, indent=2)


# ── Migration: topology.json → DB ──

def migrate_topology(topo_file):
    """Import topology.json into DB if nodes table is empty."""
    c = _conn()
    count = c.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    if count > 0:
        return  # already migrated
    if not os.path.exists(topo_file):
        return
    try:
        with open(topo_file) as f:
            topo = json.load(f)
        for node in topo.get("nodes", []):
            nid = node.get("id", "")
            if nid:
                set_node(nid, node)
        conns = topo.get("connections", [])
        if conns:
            set_connections(conns)
        regions = topo.get("regions", [])
        if regions:
            set_regions(regions)
        nc = len(topo.get("nodes", []))
        cc = len(conns)
        rc = len(regions)
        print(f"  Migrated topology to DB: {nc} nodes, {cc} connections, {rc} regions")
    except (OSError, json.JSONDecodeError) as e:
        print(f"  Topology migration failed: {e}")


# ── Notion synced IDs ──

def get_notion_synced():
    """Return set of already-synced Notion page IDs."""
    c = _conn()
    rows = c.execute("SELECT notion_id FROM notion_synced").fetchall()
    return {r["notion_id"] for r in rows}


def add_notion_synced(notion_id):
    c = _conn()
    c.execute("INSERT OR IGNORE INTO notion_synced (notion_id, synced_at) VALUES (?, ?)",
              (notion_id, time.time()))
    c.commit()


def remove_notion_synced(notion_id):
    c = _conn()
    c.execute("DELETE FROM notion_synced WHERE notion_id=?", (notion_id,))
    c.commit()


def clear_notion_synced():
    c = _conn()
    c.execute("DELETE FROM notion_synced")
    c.commit()


# ── WiFi scan data ──

def save_wifi_scan(data):
    """Persist latest WiFi scan results.
    Uses BEGIN IMMEDIATE so readers see old or new data, never empty."""
    c = _conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        c.execute("DELETE FROM wifi_scans")
        c.execute("INSERT INTO wifi_scans (ts, data) VALUES (?, ?)",
                  (time.time(), json.dumps(data)))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


def get_wifi_scan():
    """Get last WiFi scan results, or empty dict."""
    c = _conn()
    row = c.execute("SELECT data FROM wifi_scans ORDER BY ts DESC LIMIT 1").fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["data"])
    except (json.JSONDecodeError, TypeError):
        return {}


# ── Bulk topology update (for ap_scanner) ──

def update_topology_connections(topo_connections):
    """Replace all connections from a full topology dict (used by ap_scanner)."""
    set_connections(topo_connections)


def update_node_fields(node_id, updates):
    """Update specific fields on a node (e.g. ip, sublabel after DHCP change)."""
    return update_node(node_id, updates)


# ── Sub-entities (discovery) ──

def get_sub_entities(host_node_id=None, provider=None, linked_node_id=None):
    """Query sub-entities with optional filters."""
    c = _conn()
    sql = "SELECT * FROM sub_entities WHERE 1=1"
    params = []
    if host_node_id:
        sql += " AND host_node_id = ?"
        params.append(host_node_id)
    if provider:
        sql += " AND provider = ?"
        params.append(provider)
    if linked_node_id:
        sql += " AND linked_node_id = ?"
        params.append(linked_node_id)
    rows = c.execute(sql, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["metadata"] = json.loads(d["metadata"]) if d["metadata"] else {}
        result.append(d)
    return result


def upsert_sub_entity(entity):
    """Insert or update a sub-entity. entity is a dict with at minimum: id, type, name, host_node_id, status, provider."""
    c = _conn()
    now = time.time()
    existing = c.execute("SELECT first_seen FROM sub_entities WHERE id = ?", (entity["id"],)).fetchone()
    first_seen = existing["first_seen"] if existing else now
    metadata = json.dumps(entity.get("metadata", {}))
    c.execute("""INSERT OR REPLACE INTO sub_entities
        (id, type, name, host_node_id, status, metadata, linked_node_id, provider, first_seen, last_seen, link_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (entity["id"], entity["type"], entity["name"], entity["host_node_id"],
         entity.get("status", "unknown"), metadata, entity.get("linked_node_id"),
         entity["provider"], first_seen, now, entity.get("link_type")))
    c.commit()


def upsert_sub_entities_batch(entities):
    """Batch upsert sub-entities. More efficient than individual calls."""
    c = _conn()
    now = time.time()
    for entity in entities:
        existing = c.execute("SELECT first_seen FROM sub_entities WHERE id = ?", (entity["id"],)).fetchone()
        first_seen = existing["first_seen"] if existing else now
        metadata = json.dumps(entity.get("metadata", {}))
        c.execute("""INSERT OR REPLACE INTO sub_entities
            (id, type, name, host_node_id, status, metadata, linked_node_id, provider, first_seen, last_seen, link_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (entity["id"], entity["type"], entity["name"], entity["host_node_id"],
             entity.get("status", "unknown"), metadata, entity.get("linked_node_id"),
             entity["provider"], first_seen, now, entity.get("link_type")))
    c.commit()


def delete_sub_entity(entity_id):
    """Delete a sub-entity by ID."""
    c = _conn()
    c.execute("DELETE FROM sub_entities WHERE id = ?", (entity_id,))
    c.execute("DELETE FROM discovery_links WHERE sub_entity_id = ?", (entity_id,))
    c.commit()


def cleanup_stale_sub_entities(stale_hours=24, dead_days=7, manual_days=30):
    """Mark unseen entities as stale, delete very old ones."""
    c = _conn()
    now = time.time()
    stale_cutoff = now - (stale_hours * 3600)
    dead_cutoff = now - (dead_days * 86400)
    manual_cutoff = now - (manual_days * 86400)
    # Mark stale
    c.execute("UPDATE sub_entities SET status = 'stale' WHERE last_seen < ? AND status != 'stale'",
              (stale_cutoff,))
    # Delete very old non-manual entities
    c.execute("DELETE FROM sub_entities WHERE last_seen < ? AND link_type != 'manual'",
              (dead_cutoff,))
    # Delete very old manual entities
    c.execute("DELETE FROM sub_entities WHERE last_seen < ? AND link_type = 'manual'",
              (manual_cutoff,))
    c.commit()


# ── Discovery links ──

def get_discovery_link(sub_entity_id):
    """Get manual link override for a sub-entity."""
    c = _conn()
    row = c.execute("SELECT * FROM discovery_links WHERE sub_entity_id = ?",
                    (sub_entity_id,)).fetchone()
    return dict(row) if row else None


def set_discovery_link(sub_entity_id, linked_node_id, link_type="manual"):
    """Set a link between a sub-entity and a topology node.

    Defaults to a 'manual' operator override — authoritative, wins over auto
    resolution in the discovery engine's linker. Providers that auto-resolve
    links (e.g. the HA plugin's device→node linking, #116) pass their own
    link_type so the linker and cleanup logic can tell the two apart.
    """
    c = _conn()
    now = time.time()
    c.execute("INSERT OR REPLACE INTO discovery_links (sub_entity_id, linked_node_id, created, link_type) VALUES (?, ?, ?, ?)",
              (sub_entity_id, linked_node_id, now, link_type))
    c.execute("UPDATE sub_entities SET linked_node_id = ?, link_type = ? WHERE id = ?",
              (linked_node_id, link_type, sub_entity_id))
    c.commit()


def delete_discovery_link(sub_entity_id):
    """Remove a manual link."""
    c = _conn()
    c.execute("DELETE FROM discovery_links WHERE sub_entity_id = ?", (sub_entity_id,))
    c.execute("UPDATE sub_entities SET linked_node_id = NULL, link_type = NULL WHERE id = ? AND link_type = 'manual'",
              (sub_entity_id,))
    c.commit()


def get_manual_discovery_link_ids():
    """Return the set of sub_entity_ids that carry an operator 'manual' link.

    Auto-resolving providers consult this to avoid clobbering manual overrides
    (#116). Rows predating the link_type migration default to 'manual'.
    """
    c = _conn()
    rows = c.execute(
        "SELECT sub_entity_id FROM discovery_links WHERE COALESCE(link_type,'manual')='manual'"
    ).fetchall()
    return {r["sub_entity_id"] for r in rows}


def sync_auto_discovery_links(pairs, link_type, id_prefix):
    """Replace all auto links of `link_type` whose sub_entity_id starts with
    `id_prefix` with `pairs` ([(sub_entity_id, linked_node_id), ...]).

    Lets a provider persist its auto-resolved device→node links each scan
    without leaving stale rows behind when a device stops resolving (#116).

    Safety (per CLAUDE.md "realm.db is live data — never delete rows"): only
    DERIVED auto links are touched. The DELETE is scoped to the caller's own
    `link_type`, so operator 'manual' overrides (and other providers' links)
    are never removed — and `link_type='manual'` is rejected outright. As a
    second guard, sub_entity_ids that currently hold a manual override are
    excluded from the reinsert so an INSERT OR REPLACE can't overwrite one on a
    primary-key collision (covers the case where a caller's manual filter
    failed). The whole delete+reinsert runs in a SINGLE transaction (`with c:`
    commits on success / rolls back on error) so a failure can never leave
    links half-removed. These auto links are recomputed every discovery scan
    cycle, so the next sync is itself the rollback path — they self-restore.
    """
    if link_type == "manual":
        raise ValueError("sync_auto_discovery_links refuses link_type='manual' "
                         "(reserved for operator overrides)")
    c = _conn()
    now = time.time()
    with c:  # atomic: commit on success, rollback on any error
        c.execute("DELETE FROM discovery_links WHERE link_type=? AND sub_entity_id LIKE ?",
                  (link_type, id_prefix + "%"))
        protected = {r["sub_entity_id"] for r in c.execute(
            "SELECT sub_entity_id FROM discovery_links WHERE COALESCE(link_type,'manual')='manual'"
        ).fetchall()}
        rows = [(sid, nid, now, link_type) for sid, nid in pairs
                if sid and nid and sid not in protected]
        if rows:
            c.executemany(
                "INSERT OR REPLACE INTO discovery_links (sub_entity_id, linked_node_id, created, link_type) VALUES (?, ?, ?, ?)",
                rows)


# ── Discovery capabilities ──

def get_discovery_capabilities(node_id=None):
    """Get discovery capabilities, optionally filtered by node."""
    c = _conn()
    if node_id:
        rows = c.execute("SELECT * FROM discovery_capabilities WHERE node_id = ?", (node_id,)).fetchall()
    else:
        rows = c.execute("SELECT * FROM discovery_capabilities").fetchall()
    return [dict(r) for r in rows]


def set_discovery_capability(node_id, provider, available, error=None):
    """Record whether a provider can reach a specific node."""
    c = _conn()
    c.execute("""INSERT OR REPLACE INTO discovery_capabilities
        (node_id, provider, available, last_checked, error) VALUES (?, ?, ?, ?, ?)""",
        (node_id, provider, 1 if available else 0, time.time(), error))
    c.commit()
