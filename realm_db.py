"""Unified SQLite storage for the Realm — settings, events, personas, topology."""

import json
import os
import sqlite3
import threading
import time

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "realm.db")
_local = threading.local()


def _conn():
    """Thread-local connection (SQLite doesn't allow cross-thread sharing)."""
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(DB_PATH, timeout=5)
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
        _local.conn.row_factory = sqlite3.Row
    return _local.conn


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
        CREATE INDEX IF NOT EXISTS idx_conn_from ON connections(from_node);
        CREATE INDEX IF NOT EXISTS idx_conn_to ON connections(to_node);
        CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_id);
    """)
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


# ── Events ──

def push_event(event):
    """Store an event. All events persist until explicitly deleted."""
    event["ts"] = time.time()
    c = _conn()
    c.execute("INSERT INTO events (ts, type, data) VALUES (?, ?, ?)",
              (event["ts"], event.get("type"), json.dumps(event)))
    c.commit()
    return event


def get_events_since(since_ts):
    c = _conn()
    rows = c.execute("SELECT data FROM events WHERE ts > ? ORDER BY ts", (since_ts,)).fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["data"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return out


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
    }


def upsert_quest(quest):
    """Insert or update a quest."""
    c = _conn()
    c.execute("""INSERT OR REPLACE INTO quests
        (id, title, description, parent_id, node, status, actions, sort_order, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
        quest["id"], quest["title"], quest.get("description"),
        quest.get("parent_id"), quest.get("node"),
        quest.get("status", "active"),
        json.dumps(quest.get("actions", [])),
        quest.get("sort_order", 0),
        quest.get("created_at", time.time()),
        quest.get("completed_at"),
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
    """Delete a quest and its children. Returns count deleted."""
    c = _conn()
    # Delete children first
    children = c.execute("SELECT id FROM quests WHERE parent_id = ?", (quest_id,)).fetchall()
    count = 0
    for child in children:
        count += delete_quest(child["id"])
    c.execute("DELETE FROM quests WHERE id = ?", (quest_id,))
    c.commit()
    return count + 1


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


def update_node_position(node_id, x, y):
    """Update just the position of a node."""
    c = _conn()
    row = c.execute("SELECT data FROM nodes WHERE node_id=?", (node_id,)).fetchone()
    if row is None:
        return
    data = json.loads(row["data"])
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
    """Persist latest WiFi scan results."""
    c = _conn()
    c.execute("DELETE FROM wifi_scans")
    c.execute("INSERT INTO wifi_scans (ts, data) VALUES (?, ?)",
              (time.time(), json.dumps(data)))
    c.commit()


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
