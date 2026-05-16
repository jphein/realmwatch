"""Ansible War Room plugin — playbook execution and infrastructure management.

On-demand plugin: no persistent daemon. Runs ansible-playbook as subprocess
when triggered, streams output via SSE, stores results in plugin DB.
"""

import asyncio
import json
import logging
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

log = logging.getLogger("plugin.ansible")

# Module-level state (set during setup)
_ctx = None
_runs_table = None
_active_runs = {}  # run_id -> {"process", "output", "status", "started", ...}
_active_runs_lock = threading.Lock()


def setup(ctx):
    """Plugin entry point — called by plugin_loader with PluginContext."""
    global _ctx, _runs_table

    _ctx = ctx

    # Create runs history table
    _runs_table = ctx.db.create_table("runs", """
        id TEXT PRIMARY KEY,
        playbook TEXT NOT NULL,
        targets TEXT NOT NULL,
        check_mode INTEGER DEFAULT 1,
        status TEXT DEFAULT 'pending',
        started_at REAL,
        finished_at REAL,
        exit_code INTEGER,
        output TEXT DEFAULT '',
        triggered_by TEXT DEFAULT 'user'
    """)

    # Register SSE source for live run output
    ctx.register_sse_source("ansible", _get_sse_data, interval=3, burst=False)

    # Register node enricher for managed status
    ctx.register_node_enricher(_enrich_node, priority=70)

    ctx.log("War Room plugin initialized")


# ── SSE Source ──

def _get_sse_data():
    """Return current run state for SSE broadcast."""
    with _active_runs_lock:
        if not _active_runs:
            return None
        runs = {}
        for rid, run in _active_runs.items():
            runs[rid] = {
                "id": rid,
                "playbook": run["playbook"],
                "status": run["status"],
                "output_lines": run["output"][-50:],  # last 50 lines
                "started": run["started"],
            }
        return {"active_runs": runs}


# ── Node Enricher ──

def _enrich_node(node_id, node_data):
    """Add managed status badge to nodes with recent runs."""
    rows = _ctx.db.query(
        f"SELECT status, finished_at FROM {_runs_table} "
        f"WHERE targets LIKE ? ORDER BY finished_at DESC LIMIT 1",
        (f"%{node_id}%",)
    )
    if not rows:
        return None

    last = rows[0]
    status = last["status"]
    badge = None
    if status == "success":
        badge = {"icon": "\u2694", "color": "#80e8a0", "tooltip": "Managed — last run succeeded"}
    elif status == "failed":
        badge = {"icon": "\u2694", "color": "#ff9090", "tooltip": "Managed — last run failed"}
    elif status == "running":
        badge = {"icon": "\u2694", "color": "#f0c060", "tooltip": "Managed — run in progress"}

    if badge:
        return {"badge": badge}
    return None


# ── Endpoint Handlers ──

def handle_inventory(req, params):
    """GET /plugins/ansible/inventory — topology nodes grouped by VLAN/role."""
    topo = _ctx.get_topology()
    nodes = topo.get("nodes", [])

    # Group by VLAN (region/group) and role
    by_vlan = {}
    for node in nodes:
        vlan = node.get("group", node.get("region", "ungrouped"))
        if vlan not in by_vlan:
            by_vlan[vlan] = []

        ip = node.get("ip", "")
        node_type = node.get("type", "unknown")

        # Determine if node is SSH-reachable (has IP and isn't a switch/ap without management)
        reachable = bool(ip) and node_type not in ("cloud", "service", "virtual")

        by_vlan[vlan].append({
            "id": node.get("id", ""),
            "label": node.get("label", node.get("id", "")),
            "ip": ip,
            "type": node_type,
            "os": _guess_os(node),
            "reachable": reachable,
        })

    # Sort groups and nodes within groups
    inventory = {}
    for vlan in sorted(by_vlan.keys()):
        inventory[vlan] = sorted(by_vlan[vlan], key=lambda n: n.get("label", ""))

    req.respond({"inventory": inventory})


def _guess_os(node):
    """Determine OS for ansible grouping.

    Source-of-truth order:
      1. Explicit node.data.os (written by `realm discover-os` via SSH
         to /etc/os-release — authoritative). Returns the os-release ID
         field directly: "ubuntu", "debian", "openwrt", "alpine", etc.
      2. Heuristic from label/type (legacy; only when discover-os hasn't
         touched this node).
    """
    explicit = (node.get("os") or "").strip().lower()
    if explicit:
        return explicit

    label = (node.get("label", "") + " " + node.get("id", "")).lower()
    node_type = node.get("type", "").lower()

    if "openwrt" in label or node_type in ("router", "ap", "access_point"):
        return "openwrt"
    if "ubuntu" in label or "linux" in label or node_type in ("server", "desktop", "workstation"):
        return "ubuntu"
    if "windows" in label:
        return "windows"
    if "esxi" in label or "proxmox" in label:
        return "hypervisor"
    return "unknown"


def handle_playbooks(req, params):
    """GET /plugins/ansible/playbooks — list available playbooks."""
    playbooks_dir = Path(_ctx.data_dir) / _ctx.config.get("playbooks_dir", "playbooks")

    playbooks = []
    if playbooks_dir.is_dir():
        for f in sorted(playbooks_dir.iterdir()):
            if f.suffix in (".yml", ".yaml") and f.is_file():
                try:
                    content = f.read_text()
                except OSError:
                    content = ""

                # Extract name from first line comment or filename
                name = f.stem.replace("-", " ").replace("_", " ").title()
                description = ""
                for line in content.split("\n"):
                    line = line.strip()
                    if line.startswith("#") and not description:
                        description = line.lstrip("# ").strip()
                        break

                playbooks.append({
                    "filename": f.name,
                    "name": name,
                    "description": description,
                    "content": content,
                    "size": len(content),
                })

    req.respond({"playbooks": playbooks})


def handle_run(req, params):
    """POST /plugins/ansible/run — execute a playbook."""
    data = req.json()
    playbook = data.get("playbook", "")
    targets = data.get("targets", [])
    check_mode = data.get("check_mode", _ctx.config.get("check_mode_default", True))
    extra_vars = data.get("extra_vars", {})

    if not playbook:
        req.respond({"error": "No playbook specified"}, status=400)
        return
    if not targets:
        req.respond({"error": "No targets specified"}, status=400)
        return

    # Validate playbook exists
    playbooks_dir = Path(_ctx.data_dir) / _ctx.config.get("playbooks_dir", "playbooks")
    playbook_path = playbooks_dir / playbook
    if not playbook_path.is_file():
        req.respond({"error": f"Playbook not found: {playbook}"}, status=404)
        return

    # Resolve playbook path (prevent directory traversal)
    try:
        resolved = playbook_path.resolve()
        if not str(resolved).startswith(str(playbooks_dir.resolve())):
            req.respond({"error": "Invalid playbook path"}, status=400)
            return
    except (OSError, ValueError):
        req.respond({"error": "Invalid playbook path"}, status=400)
        return

    # Generate run ID
    run_id = str(uuid.uuid4())[:8]

    # Build inventory string (comma-separated IPs)
    target_ips = []
    topo = _ctx.get_topology()
    node_map = {n["id"]: n for n in topo.get("nodes", [])}
    target_labels = []

    for t in targets:
        node = node_map.get(t, {})
        ip = node.get("ip", t)
        if ip:
            target_ips.append(ip)
            target_labels.append(node.get("label", t))

    if not target_ips:
        req.respond({"error": "No reachable targets"}, status=400)
        return

    # Record in DB
    now = time.time()
    _ctx.db.execute(
        f"INSERT INTO {_runs_table} (id, playbook, targets, check_mode, status, started_at) "
        f"VALUES (?, ?, ?, ?, 'running', ?)",
        (run_id, playbook, json.dumps(targets), 1 if check_mode else 0, now)
    )

    # Start execution in background thread
    t = threading.Thread(
        target=_execute_playbook,
        args=(run_id, str(resolved), target_ips, check_mode, extra_vars),
        daemon=True,
        name=f"ansible-run-{run_id}",
    )
    t.start()

    # Push realm event
    mode_str = "dry run" if check_mode else "LIVE"
    _ctx.push_event("ansible", {
        "subtype": "run_started",
        "run_id": run_id,
        "playbook": playbook,
        "targets": target_labels,
        "check_mode": check_mode,
        "message": f"War Room: executing {playbook} ({mode_str}) on {len(target_labels)} node(s)",
    })

    req.respond({
        "run_id": run_id,
        "status": "running",
        "playbook": playbook,
        "targets": target_labels,
        "check_mode": check_mode,
    })


def _execute_playbook(run_id, playbook_path, target_ips, check_mode, extra_vars):
    """Run ansible-playbook in subprocess, capture output line by line."""
    inventory = ",".join(target_ips) + ","  # trailing comma for single-host inventory

    cmd = [
        "ansible-playbook",
        playbook_path,
        "-i", inventory,
        "--forks", "10",
    ]

    if check_mode:
        cmd.append("--check")

    if extra_vars:
        cmd.extend(["--extra-vars", json.dumps(extra_vars)])

    # Track in active runs
    with _active_runs_lock:
        _active_runs[run_id] = {
            "playbook": os.path.basename(playbook_path),
            "status": "running",
            "output": [],
            "started": time.time(),
            "process": None,
        }

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "ANSIBLE_FORCE_COLOR": "0", "ANSIBLE_NOCOLOR": "1"},
        )

        with _active_runs_lock:
            if run_id in _active_runs:
                _active_runs[run_id]["process"] = proc

        # Stream output line by line
        output_lines = []
        for line in proc.stdout:
            line = line.rstrip("\n")
            output_lines.append(line)
            with _active_runs_lock:
                if run_id in _active_runs:
                    _active_runs[run_id]["output"].append(line)

        proc.wait()
        exit_code = proc.returncode
        status = "success" if exit_code == 0 else "failed"

    except FileNotFoundError:
        output_lines = ["ERROR: ansible-playbook not found. Is Ansible installed?"]
        exit_code = 127
        status = "failed"
    except Exception as e:
        output_lines = [f"ERROR: {e}"]
        exit_code = 1
        status = "failed"

    # Update DB
    full_output = "\n".join(output_lines)
    _ctx.db.execute(
        f"UPDATE {_runs_table} SET status=?, finished_at=?, exit_code=?, output=? WHERE id=?",
        (status, time.time(), exit_code, full_output, run_id)
    )

    # Update active run then remove after brief delay (let SSE pick it up)
    with _active_runs_lock:
        if run_id in _active_runs:
            _active_runs[run_id]["status"] = status

    # Push completion event
    _ctx.push_event("ansible", {
        "subtype": "run_complete",
        "run_id": run_id,
        "status": status,
        "exit_code": exit_code,
        "message": f"War Room: {os.path.basename(playbook_path)} — {status} (exit {exit_code})",
    })

    # Remove from active runs after a delay so frontend gets final state
    def _cleanup():
        time.sleep(10)
        with _active_runs_lock:
            _active_runs.pop(run_id, None)

    threading.Thread(target=_cleanup, daemon=True).start()

    log.info("Run %s finished: %s (exit %d)", run_id, status, exit_code)


def handle_runs(req, params):
    """GET /plugins/ansible/runs — run history."""
    query_params = req.query_params
    limit = int(query_params.get("limit", "20"))
    limit = min(limit, 100)

    rows = _ctx.db.query(
        f"SELECT id, playbook, targets, check_mode, status, started_at, finished_at, exit_code "
        f"FROM {_runs_table} ORDER BY started_at DESC LIMIT ?",
        (limit,)
    )

    runs = []
    for row in rows:
        targets = row.get("targets", "[]")
        try:
            targets = json.loads(targets)
        except (json.JSONDecodeError, TypeError):
            targets = []

        runs.append({
            "id": row["id"],
            "playbook": row["playbook"],
            "targets": targets,
            "check_mode": bool(row.get("check_mode", 1)),
            "status": row["status"],
            "started_at": row.get("started_at"),
            "finished_at": row.get("finished_at"),
            "exit_code": row.get("exit_code"),
        })

    # Also include active runs
    with _active_runs_lock:
        active = []
        for rid, run in _active_runs.items():
            active.append({
                "id": rid,
                "playbook": run["playbook"],
                "status": run["status"],
                "started": run["started"],
                "output_tail": run["output"][-10:],
            })

    req.respond({"runs": runs, "active": active})


def handle_ai(req, params):
    """POST /plugins/ansible/ai — AI-assisted playbook suggestions."""
    data = req.json()
    message = data.get("message", "")
    if not message:
        req.respond({"error": "No message provided"}, status=400)
        return

    # Build context from topology and playbook state
    topo = _ctx.get_topology()
    node_count = len(topo.get("nodes", []))
    node_types = {}
    for n in topo.get("nodes", []):
        t = n.get("type", "unknown")
        node_types[t] = node_types.get(t, 0) + 1

    # Get recent runs
    recent_runs = _ctx.db.query(
        f"SELECT playbook, status, started_at FROM {_runs_table} "
        f"ORDER BY started_at DESC LIMIT 5"
    )

    # Get available playbooks
    playbooks_dir = Path(_ctx.data_dir) / _ctx.config.get("playbooks_dir", "playbooks")
    available = []
    if playbooks_dir.is_dir():
        available = [f.name for f in playbooks_dir.iterdir() if f.suffix in (".yml", ".yaml")]

    context = (
        f"Realm infrastructure: {node_count} nodes. "
        f"Types: {json.dumps(node_types)}. "
        f"Available playbooks: {', '.join(available) or 'none'}. "
        f"Recent runs: {json.dumps(recent_runs) if recent_runs else 'none'}. "
        f"The user is managing a homelab with Ubuntu servers, OpenWrt routers/APs, "
        f"and various network devices across 12 VLANs."
    )

    # Use chat_bridge for AI
    try:
        import chat_bridge
        loop = asyncio.new_event_loop()
        result = loop.run_until_complete(
            chat_bridge.chat(
                message,
                session_name="ansible-war-room",
                extra_context=context,
            )
        )
        loop.close()

        if result.get("error"):
            req.respond({"error": result["error"]}, status=500)
        else:
            req.respond({
                "response": result.get("response", ""),
                "model": result.get("model", ""),
                "latency_ms": result.get("latency_ms", 0),
            })
    except Exception as e:
        log.error("AI assist error: %s", e, exc_info=True)
        req.respond({"error": str(e)}, status=500)
