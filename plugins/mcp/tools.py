"""MCP tool implementations — wraps realmwatch endpoints as FastMCP tools.

Importable both from the realmwatch process (when /mcp/info diagnostic is
hit) and from a standalone subprocess launched by Claude Code over stdio
(see launcher.py).

Design notes:
- Each tool is a small Python function with a docstring and type hints.
  FastMCP introspects those to generate the JSON schema exposed to clients.
- Returns are JSON-serializable dicts/lists. dataclasses are coerced via
  dataclasses.asdict() before serialization.
- The realmwatch root is added to sys.path here so the launcher can import
  realm_db, realm_fleet, etc. without requiring the caller to set PYTHONPATH.
- Heavy modules (chat_bridge, ap_scanner, alerting DB) are lazy-imported
  inside their tool functions so a missing optional dep can't tank the
  whole MCP server.
"""

from __future__ import annotations

import json
import os
import shlex
import sqlite3
import subprocess
import sys
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


# Repo root = plugins/mcp/tools.py → parent.parent.parent
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Realmwatch root must be on sys.path so realm_text / realm_db / realm_fleet
# import. This file is loaded both by the in-process MCP plugin AND by the
# stdio launcher subprocess — keep the path setup order-safe.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from realm_text import real_home  # noqa: E402


# Path-injection per CLAUDE.md realm-sigil precedent. Lexicon lives outside
# the realmwatch repo, so push it on sys.path before we import.
_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
if _LEXICON_PY.exists() and str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))


# ── Helpers ──

def _json_safe(obj: Any) -> Any:
    """Recursively coerce dataclasses + non-JSON types to JSON-friendly forms."""
    if is_dataclass(obj):
        return _json_safe(asdict(obj))
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    # Fallback: stringify anything exotic (datetime, Path, etc.)
    return str(obj)


def _fleet_catalog():
    """Load (and cache) the FleetCatalog. Returns None if unavailable."""
    import realm_fleet  # local import — sys.path is wired above
    return realm_fleet._catalog()


# ── Read-only tools ──

def realm_status() -> dict:
    """Return the full realm status blob: sensors, traffic, energy, latency, wifi.

    Equivalent to `GET /status` on the realmwatch HTTP server. This delegates
    to map_server.build_status() which is cache-backed (5s TTL).
    """
    import map_server  # heavy — imports engine, ha_bridge, etc.
    return _json_safe(map_server.build_status())


def recent_events(limit: int = 20) -> list[dict]:
    """Return the most recent realm events from realm.db.

    Args:
        limit: Maximum number of events to return (default 20, newest last).
    """
    import realm_db
    events = realm_db.get_events_since(0)  # all events
    if limit > 0:
        events = events[-limit:]
    return _json_safe(events)


def list_nodes(category: str | None = None) -> list[dict]:
    """List topology nodes joined with fleet metadata.

    Args:
        category: Optional fleet category filter (e.g. "server", "ap", "iot").
    """
    import realm_db
    cat = _fleet_catalog()
    fleet_by_id: dict[str, Any] = {}
    if cat is not None:
        for e in cat.entries:
            fleet_by_id[e.fleet_id] = e

    out = []
    for node in realm_db.get_nodes():
        fleet_id = node.get("fleet_id")
        entry = fleet_by_id.get(fleet_id) if fleet_id else None
        if category and entry is not None and entry.category != category:
            continue
        if category and entry is None:
            continue
        merged = dict(node)
        if entry is not None:
            merged["fleet"] = _json_safe(entry)
        out.append(merged)
    return _json_safe(out)


def get_node(name: str) -> dict | None:
    """Resolve a name (current_name, prior_name, fleet_id, or node_id) and
    return the merged topology + fleet entry, or None if not found.
    """
    import realm_db
    import realm_fleet
    # Try fleet resolve first
    entry = realm_fleet.host(name)
    fleet_dict = _json_safe(entry) if entry is not None else None
    fleet_id = entry.fleet_id if entry is not None else None

    # Find the topology node by fleet_id, then by node_id as fallback
    topo_node = None
    if fleet_id:
        for n in realm_db.get_nodes():
            if n.get("fleet_id") == fleet_id:
                topo_node = n
                break
    if topo_node is None:
        topo_node = realm_db.get_node(name)
    if topo_node is None and fleet_dict is None:
        return None
    out = dict(topo_node) if topo_node else {}
    if fleet_dict is not None:
        out["fleet"] = fleet_dict
    return _json_safe(out)


def fleet_list(status: str = "curated") -> list[dict]:
    """List fleet.yaml entries by status (curated, tentative, retired, or 'all').

    Args:
        status: Filter by status. Pass "all" to bypass the filter.
    """
    cat = _fleet_catalog()
    if cat is None:
        return []
    entries = cat.entries
    if status and status != "all":
        entries = [e for e in entries if e.status == status]
    return [_json_safe(e) for e in entries]


def fleet_resolve(name: str) -> dict | None:
    """Resolve a name, alias, prior_name, or fleet_id to a FleetEntry.

    Returns the entry as a dict, or None if not found.
    """
    import realm_fleet
    entry = realm_fleet.host(name)
    return _json_safe(entry) if entry is not None else None


def ping_host(name: str, count: int = 1, timeout: int = 2) -> dict:
    """Ping a fleet host by name and return {ip, latency_ms, ok}.

    Args:
        name: Fleet name, prior_name, fleet_id, or raw IP.
        count: Number of ICMP pings to send (default 1).
        timeout: Per-ping timeout in seconds (default 2).
    """
    import realm_fleet
    entry = realm_fleet.host(name)
    if entry and entry.ops_ip:
        ip = entry.ops_ip
    elif name and (name.replace(".", "").isdigit() or ":" in name):
        ip = name
    else:
        return {"ok": False, "ip": None, "error": f"unknown host: {name!r}"}

    try:
        proc = subprocess.run(
            ["ping", "-c", str(max(1, count)), "-W", str(max(1, timeout)), ip],
            capture_output=True, text=True, timeout=count * timeout + 2,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "ip": ip, "error": "ping timed out"}
    except FileNotFoundError:
        return {"ok": False, "ip": ip, "error": "ping binary not found"}

    if proc.returncode != 0:
        return {"ok": False, "ip": ip, "stderr": proc.stderr.strip()[:200]}

    # Parse "rtt min/avg/max/mdev = 0.123/0.456/..." or "time=0.123 ms"
    latency_ms = None
    for line in proc.stdout.splitlines():
        if "rtt" in line and "=" in line:
            try:
                stats = line.split("=", 1)[1].strip().split()[0]
                latency_ms = float(stats.split("/")[1])
                break
            except (ValueError, IndexError):
                pass
        elif "time=" in line and latency_ms is None:
            try:
                latency_ms = float(line.split("time=", 1)[1].split()[0])
            except (ValueError, IndexError):
                pass
    return {"ok": True, "ip": ip, "latency_ms": latency_ms}


def recent_alerts(limit: int = 20) -> list[dict]:
    """Return recent alert history from the alerting plugin.

    Args:
        limit: Maximum number of alerts to return (newest first).

    Returns an empty list if the alerting plugin's history table doesn't
    exist yet (alerting plugin not yet loaded).
    """
    db_path = REPO_ROOT / "realm.db"
    if not db_path.exists():
        return []
    try:
        c = sqlite3.connect(str(db_path))
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT * FROM plugin_alerting_history ORDER BY ts DESC LIMIT ?",
            (max(1, limit),),
        ).fetchall()
        c.close()
    except sqlite3.OperationalError:
        # Table missing — alerting plugin hasn't initialized.
        return []
    return [dict(r) for r in rows]


def topology() -> dict:
    """Return the full topology blob: {nodes, connections, regions}.

    Equivalent to GET /topology on the realmwatch HTTP server.
    """
    import realm_db
    return _json_safe(realm_db.get_topology())


# ── Mutating tools ──

_SSH_OPTS = ["-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"]


def ssh_run(host: str, command: str, timeout: int = 10, user: str = "root") -> dict:
    """Run a command on a fleet host via SSH and return {stdout, stderr, code}.

    Args:
        host: Fleet name, prior_name, fleet_id, or raw IP.
        command: Shell command to run on the remote host.
        timeout: SSH timeout in seconds (default 10, max 60).
        user: Remote user (default root).

    Notes:
        - Uses BatchMode=yes — requires key-based auth, no password prompt.
        - The command is passed to ssh as a single arg; the remote shell will
          parse it. Standard shell injection rules apply on the remote side.
    """
    import realm_fleet
    timeout = max(1, min(timeout, 60))
    entry = realm_fleet.host(host)
    if entry and entry.ops_ip:
        target = entry.ops_ip
    elif host and (host.replace(".", "").isdigit() or ":" in host):
        target = host
    else:
        return {"ok": False, "stderr": f"unknown host: {host!r}", "code": 127}
    try:
        proc = subprocess.run(
            ["ssh", *_SSH_OPTS, f"{user}@{target}", command],
            capture_output=True, text=True, timeout=timeout,
        )
        return {
            "ok": proc.returncode == 0,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "code": proc.returncode,
            "host": target,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "stderr": f"ssh timeout after {timeout}s", "code": 124, "host": target}
    except FileNotFoundError:
        return {"ok": False, "stderr": "ssh binary not found", "code": 127, "host": target}


def fleet_rename(fleet_id: str, new_name: str, reason: str | None = None) -> dict:
    """Rename a fleet entry. Appends the old current_name to prior_names and
    persists fleet.yaml. Use for retiring an old hostname without changing
    the underlying fleet_id (continuity of persona, topology, herald lines).

    Args:
        fleet_id: The persistent fleet_id (NOT the current_name).
        new_name: The new current_name.
        reason: Optional rename reason (recorded in prior_names entry).
    """
    cat = _fleet_catalog()
    if cat is None:
        return {"ok": False, "error": "fleet catalog not loaded"}
    try:
        cat.rename(fleet_id, new_name, reason=reason)
    except KeyError as e:
        return {"ok": False, "error": f"unknown fleet_id: {e}"}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    cat.save()
    # Reset realm_fleet's process-local cache so subsequent lookups see it.
    import realm_fleet
    realm_fleet.invalidate()
    return {"ok": True, "fleet_id": fleet_id, "current_name": new_name}


def post_event(type: str, node: str, text: str, severity: int = 2) -> dict:
    """Push a realm event to the events table.

    Args:
        type: Event type (e.g. "alert", "speech", "quest", "info").
        node: Node identifier (current_name, fleet_id, or node_id).
        text: Event text shown in the UI / spoken by the herald.
        severity: 0=info, 2=notable, 4=warning, 6=critical (default 2).
    """
    import realm_db
    if not text:
        return {"ok": False, "error": "text is required"}
    event = {
        "type": str(type or "info"),
        "node": str(node or ""),
        "text": str(text),
        "severity": int(severity),
        "source": "mcp",
    }
    stored = realm_db.push_event(event)
    return {"ok": True, "event": _json_safe(stored)}


# ── Tool registry — used both by launcher.py and the /mcp/info endpoint ──

TOOLS: list[dict] = [
    # Read-only
    {"fn": realm_status, "category": "read", "summary": "Full realm status blob (sensors, traffic, energy, wifi)."},
    {"fn": recent_events, "category": "read", "summary": "Recent events from realm.db."},
    {"fn": list_nodes, "category": "read", "summary": "Topology nodes joined with fleet metadata."},
    {"fn": get_node, "category": "read", "summary": "Resolve a name and return merged topology + fleet entry."},
    {"fn": fleet_list, "category": "read", "summary": "Fleet entries filtered by status."},
    {"fn": fleet_resolve, "category": "read", "summary": "Resolve a name/alias/prior_name/fleet_id."},
    {"fn": ping_host, "category": "read", "summary": "Ping a fleet host by name."},
    {"fn": recent_alerts, "category": "read", "summary": "Recent alerts from the alerting plugin's history."},
    {"fn": topology, "category": "read", "summary": "Full topology: {nodes, connections, regions}."},
    # Mutating
    {"fn": ssh_run, "category": "mutate", "summary": "Run a shell command on a fleet host via SSH."},
    {"fn": fleet_rename, "category": "mutate", "summary": "Rename a fleet entry (preserves fleet_id, appends prior_name)."},
    {"fn": post_event, "category": "mutate", "summary": "Push a realm event to the events table."},
]


def register_all(mcp) -> list[dict]:
    """Register every tool in TOOLS on the FastMCP instance.

    Returns a list of {name, category, summary} dicts for diagnostic use.
    """
    registered = []
    for spec in TOOLS:
        fn = spec["fn"]
        mcp.tool()(fn)
        registered.append({
            "name": fn.__name__,
            "category": spec["category"],
            "summary": spec["summary"],
        })
    return registered
