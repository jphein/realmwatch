# WoL / Power-Management Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extract realmwatch's inline `/wol` wake sender into a self-contained `plugins/wol/` plugin and add remote S3 sleep, power-state awareness, four surfaces (map/panel/CLI/MCP), and loose RPG hooks.

**Architecture:** New `integrated` plugin `depends_on: ["latency"]`. Pure logic in `power_ops.py`; wiring in `plugin.py:setup(ctx)`; manifest declares panel + CLI verbs; `mcp_tools.py` exposes MCP tools. The core `_h_post_wol` is removed and `POST /wol` re-registered by the plugin (`raw_path=True`) for byte-identical frontend behavior. Game-layer coupling is runtime-only via `ctx.get_plugin_api`, guarded `if api:`.

**Tech Stack:** Python 3.12 stdlib (`socket`, `subprocess`), realmwatch PluginContext API, `realm_fleet` resolver, SQLite via `ctx.db`, vanilla ES2020 + esbuild for the frontend.

**Testing note:** realmwatch has **no test framework** (per its CLAUDE.md — "validate by running"). So "verify" steps run `make dev`, `curl`, the MCP launcher, and an end-to-end check against the real `familiar` host, rather than unit tests. Commit after each task.

**SSH model:** The realm host (katana in dev) reaches targets with key-based SSH + passwordless sudo (the katana→familiar path proven on 2026-06-02). Privileged commands run as `ssh <target> "sudo -n <cmd>"` where `<target>` is the fleet `current_name` (ssh-config alias) falling back to `ops_ip`. Matches the manual `ssh familiar 'sudo systemd-run --no-block systemctl suspend'` we validated.

---

## File Structure

```
plugins/wol/
  plugin.json     manifest: panel, cli.verbs, depends_on (NO endpoints[] — registered in code)
  plugin.py       setup(ctx): register endpoints, status provider, node enricher, watcher, expose_api, RPG
  power_ops.py    resolve_target · send_magic_packet · suspend_host · check_wol · arm_wol · power_state · ssh_priv
  mcp_tools.py    MCP_TOOLS = [(name, fn, desc), ...]
  panel.html      Slumber Ward markup
  panel.js        fetch /plugins/wol/status, render host rows, wake/slumber buttons
  panel.css       fantasy theming
map_server.py     REMOVE _h_post_wol (1545-1605) + route (1849)
src/node-controls.js   add slumber button + power-state reflect (then npm run build)
```

---

### Task 1: Scaffold the plugin so it loads

**Files:**
- Create: `plugins/wol/plugin.json`
- Create: `plugins/wol/plugin.py`

- [ ] **Step 1: Write `plugins/wol/plugin.json`**

```json
{
  "name": "wol",
  "version": "1.0.0",
  "type": "integrated",
  "description": "Wake-on-LAN + remote S3 sleep with power-state awareness for fleet hosts.",
  "fantasy_name": "Slumber Ward",
  "icon": "🌙",
  "python": { "module": "plugin", "entry": "setup" },
  "depends_on": ["latency"],
  "panel": {
    "id": "wol-panel",
    "name": "Slumber Ward",
    "html": "panel.html",
    "js": "panel.js",
    "css": "panel.css",
    "anchor": "se",
    "priority": 18
  },
  "cli": {
    "summary": "Wake / slumber fleet hosts and inspect power state",
    "verbs": [
      { "name": "show",   "summary": "List WoL-managed hosts + power state", "method": "GET",  "path": "/plugins/wol/status" },
      { "name": "doctor", "summary": "Check a host's WoL readiness",         "method": "GET",  "path": "/plugins/wol/doctor" },
      { "name": "wake",   "summary": "Send a magic packet to a host",        "method": "POST", "path": "/wol" },
      { "name": "sleep",  "summary": "Suspend a host to S3 (must be sleepable + WoL-armed)", "method": "POST", "path": "/plugins/wol/sleep" }
    ]
  }
}
```

- [ ] **Step 2: Write a minimal `plugins/wol/plugin.py`**

```python
"""Slumber Ward — Wake-on-LAN + remote S3 sleep + power-state awareness."""

def setup(ctx):
    ctx.log("Slumber Ward (wol) loaded")
```

- [ ] **Step 3: Verify it loads**

Run: `.venv/bin/python3 map_server.py` (Ctrl-C after startup) — or `make dev`.
Expected: startup log contains `Slumber Ward (wol) loaded` and no traceback.

- [ ] **Step 4: Verify registry sees it**

Run: `curl -s localhost/debug | python3 -m json.tool | grep -i wol`
Expected: the `wol` plugin appears in the registered-plugins list.

- [ ] **Step 5: Commit**

```bash
git add plugins/wol/plugin.json plugins/wol/plugin.py
git commit -m "feat(wol): scaffold Slumber Ward plugin"
```

---

### Task 2: Port the wake sender into the plugin; remove it from core

**Files:**
- Create: `plugins/wol/power_ops.py`
- Modify: `plugins/wol/plugin.py`
- Modify: `map_server.py` (remove `_h_post_wol` 1545-1605 and route at 1849)

- [ ] **Step 1: Write `plugins/wol/power_ops.py` with target resolution + sender**

```python
"""Pure power-management logic — no HTTP, no ctx. Importable + testable by hand."""
import socket
import subprocess

SSH_OPTS = ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes"]


def normalize_mac(s: str):
    n = s.replace(":", "").replace("-", "").lower()
    if len(n) == 12 and all(c in "0123456789abcdef" for c in n):
        return n
    return None


def resolve_target(raw: str):
    """raw -> (mac_hex, resolved_name|None, directed_ip|None). Raises ValueError on failure."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("missing target (mac or node id)")
    mac = normalize_mac(raw)
    if mac is not None:
        return mac, None, None
    import realm_fleet
    entry = realm_fleet.host(raw)
    if entry is None:
        raise ValueError(f"{raw!r} is not a valid MAC and not a known fleet host")
    if not entry.fleet_id.startswith("mac:"):
        raise ValueError(f"fleet entry {entry.current_name!r} has a non-MAC fleet_id "
                         f"({entry.fleet_id!r}); WoL needs a MAC")
    mac = normalize_mac(entry.fleet_id.split(":", 1)[1])
    if mac is None:
        raise ValueError(f"fleet entry {entry.current_name!r} has malformed MAC")
    directed_ip = getattr(entry, "ops_ip", None)
    return mac, entry.current_name, directed_ip


def send_magic_packet(mac_hex: str, directed_ip: str | None = None) -> dict:
    """Send the magic packet to the limited broadcast + (if known) the directed subnet broadcast."""
    magic = b"\xff" * 6 + bytes.fromhex(mac_hex) * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        # 255.255.255.255 = IPv4 limited broadcast (RFC 1122 §3.2.1.3) — a protocol
        # constant, not a host. The x.y.z.255 directed broadcast reaches the target's /24.
        sock.sendto(magic, ("255.255.255.255", 9))
        if directed_ip:
            parts = directed_ip.rsplit(".", 1)
            if len(parts) == 2:
                sock.sendto(magic, (parts[0] + ".255", 9))
    return {"ok": True, "mac": mac_hex, "sent": True, "directed_ip": directed_ip}
```

- [ ] **Step 2: Register `POST /wol` in `plugin.py:setup(ctx)`**

```python
"""Slumber Ward — Wake-on-LAN + remote S3 sleep + power-state awareness."""
from . import power_ops  # if relative import fails under the loader, use `import power_ops`


def _h_wol(req, params):
    try:
        data = req.json()
        raw = (data.get("target") or data.get("mac") or "")
        mac, name, directed_ip = power_ops.resolve_target(raw)
        if data.get("ip"):
            directed_ip = data["ip"]
        result = power_ops.send_magic_packet(mac, directed_ip)
        if name:
            result["resolved_name"] = name
        return result
    except ValueError as e:
        req.respond({"error": str(e)}, 400)
        return None
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


def setup(ctx):
    ctx.register_endpoint("POST", "/wol", _h_wol, raw_path=True)
    ctx.log("Slumber Ward (wol) loaded")
```

NOTE: realmwatch plugins are imported as top-level modules (the loader adds the plugin dir to `sys.path`). If `from . import power_ops` raises, change it to `import power_ops`. Verify in Step 5 which one the loader accepts; keep the working form.

- [ ] **Step 3: Remove the core handler + route**

Delete `def _h_post_wol(...)` (map_server.py lines ~1545-1605) and the line `_route_table.add("POST", "/wol", _h_post_wol)` (~1849).

- [ ] **Step 4: Verify core no longer defines it**

Run: `grep -n "_h_post_wol\|\"/wol\"" map_server.py`
Expected: no matches.

- [ ] **Step 5: Verify wake parity end-to-end**

Run: `make dev`, then in another shell:
`curl -s -X POST localhost/wol -H 'Content-Type: application/json' -d '{"target":"familiar"}' | python3 -m json.tool`
Expected: `{"ok": true, "mac": "04d9f5fa1ee0", "sent": true, "resolved_name": "familiar", ...}` (no traceback; plugin handled it). Also confirm `import power_ops` vs `from . import power_ops` — fix whichever the load log rejected.

- [ ] **Step 6: Commit**

```bash
git add plugins/wol/power_ops.py plugins/wol/plugin.py map_server.py
git commit -m "feat(wol): move wake sender into plugin, remove from core"
```

---

### Task 3: Remote sleep with the don't-strand-a-host gate

**Files:**
- Modify: `plugins/wol/power_ops.py` (add `ssh_priv`, `detect_iface`, `check_wol`, `suspend_host`)
- Modify: `plugins/wol/plugin.py` (sleepable settings, `POST /plugins/wol/sleep`, `GET /plugins/wol/doctor`)

- [ ] **Step 1: Add SSH + doctor + suspend helpers to `power_ops.py`**

```python
def _ssh_target(name: str) -> str:
    """Prefer the fleet current_name (ssh-config alias); fall back to ops_ip."""
    import realm_fleet
    entry = realm_fleet.host(name)
    if entry is None:
        return name
    return entry.current_name or getattr(entry, "ops_ip", None) or name


def ssh_priv(name: str, command: str, timeout: int = 15) -> dict:
    """Run `sudo -n <command>` on the host via key-based SSH. Returns {ok, stdout, stderr, code}."""
    target = _ssh_target(name)
    try:
        proc = subprocess.run(
            ["ssh", *SSH_OPTS, target, f"sudo -n {command}"],
            capture_output=True, text=True, timeout=max(1, min(timeout, 60)),
        )
        return {"ok": proc.returncode == 0, "stdout": proc.stdout,
                "stderr": proc.stderr, "code": proc.returncode, "target": target}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stderr": f"ssh timeout after {timeout}s", "code": 124, "target": target}
    except FileNotFoundError:
        return {"ok": False, "stderr": "ssh binary not found", "code": 127, "target": target}


def detect_iface(name: str, iface_overrides: dict | None = None) -> str | None:
    """Primary NIC of the host (the one holding the default route)."""
    if iface_overrides and name in iface_overrides:
        return iface_overrides[name]
    r = ssh_priv(name, "sh -c 'ip -o route show default | awk \\'{print $5; exit}\\''")
    if r["ok"] and r["stdout"].strip():
        return r["stdout"].strip()
    return None


def check_wol(name: str, iface_overrides: dict | None = None) -> dict:
    """Doctor: is the host reachable via SSH and is WoL armed (Wake-on: g)?"""
    iface = detect_iface(name, iface_overrides)
    if iface is None:
        return {"ok": False, "ssh": False, "armed": False, "reason": "ssh/iface detection failed"}
    r = ssh_priv(name, f"ethtool {iface}")
    if not r["ok"]:
        return {"ok": False, "ssh": True, "iface": iface, "armed": False, "reason": r["stderr"].strip()}
    armed = False
    for line in r["stdout"].splitlines():
        if "Wake-on:" in line:
            armed = line.split("Wake-on:")[1].strip() == "g"
    return {"ok": armed, "ssh": True, "iface": iface, "armed": armed}


def suspend_host(name: str) -> dict:
    """Suspend to S3 via detached systemd-run so SSH returns cleanly."""
    return ssh_priv(name, "systemd-run --no-block systemctl suspend")
```

- [ ] **Step 2: Add sleepable settings + sleep/doctor endpoints in `plugin.py`**

In `setup(ctx)` add a seeded settings default and register two endpoints:

```python
    # --- settings: which hosts may be remotely slept (opt-in, consequential) ---
    if ctx.db.get_setting("sleepable", None) is None:
        ctx.db.set_setting("sleepable", ["familiar"])
        ctx.db.set_setting("sleep_ttl_seconds", 21600)
        ctx.db.set_setting("iface_overrides", {})

    ctx.register_endpoint("GET", "/plugins/wol/doctor", _h_doctor)
    ctx.register_endpoint("POST", "/plugins/wol/sleep", _h_sleep)
```

Handlers (module level):

```python
def _h_doctor(req, params):
    name = (params.get("target") or [""])[0] if isinstance(params.get("target"), list) else params.get("target", "")
    if not name:
        req.respond({"error": "missing 'target'"}, 400); return None
    overrides = req.ctx.db.get_setting("iface_overrides", {})
    return power_ops.check_wol(name, overrides)


def _h_sleep(req, params):
    try:
        data = req.json()
        name = (data.get("target") or "").strip()
        if not name:
            req.respond({"error": "missing 'target'"}, 400); return None
        sleepable = req.ctx.db.get_setting("sleepable", [])
        if name not in sleepable:
            req.respond({"error": f"{name!r} is not in the sleepable allow-list", "code": "not_sleepable"}, 403)
            return None
        doctor = power_ops.check_wol(name, req.ctx.db.get_setting("iface_overrides", {}))
        if not doctor.get("armed"):
            req.respond({"error": f"refusing to sleep {name!r}: WoL not armed ({doctor.get('reason','')})",
                         "code": "not_armed", "doctor": doctor}, 409)
            return None
        res = power_ops.suspend_host(name)
        req.ctx._wol_log(name, "sleep", "ok" if res["ok"] else "error", res.get("stderr") or "", "api")
        if not res["ok"]:
            req.respond({"error": "suspend command failed", "detail": res}, 502); return None
        return {"ok": True, "slept": name, "detail": res}
    except Exception as e:
        req.respond({"error": str(e)}, 500); return None
```

NOTE: `req.ctx` access — confirm the PluginRequest exposes `ctx`. If not, capture `ctx` in a closure (define `_h_sleep`/`_h_doctor` *inside* `setup` so they close over `ctx`), and replace `req.ctx` with `ctx`. The `_wol_log` helper is added in Task 4; for this task, stub it as `lambda *a: None` on ctx or omit the log line until Task 4.

- [ ] **Step 3: Verify doctor against familiar**

Run: `make dev`, then `curl -s 'localhost/plugins/wol/doctor?target=familiar' | python3 -m json.tool`
Expected: `{"ok": true, "ssh": true, "iface": "enp5s0", "armed": true}` (WoL was persistently armed on familiar on 2026-06-02 via NetworkManager).

- [ ] **Step 4: Verify the gate rejects a non-sleepable host**

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost/plugins/wol/sleep -d '{"target":"gatekeeper"}'`
Expected: `403`.

- [ ] **Step 5: Verify end-to-end sleep on familiar**

Run: `curl -s -X POST localhost/plugins/wol/sleep -d '{"target":"familiar"}' | python3 -m json.tool`
Expected: `{"ok": true, "slept": "familiar", ...}`. Confirm familiar stops pinging within ~20s (`ping -c1 familiar` fails). Then wake it: `curl -s -X POST localhost/wol -d '{"target":"familiar"}'` and confirm it returns (`ping familiar`).

- [ ] **Step 6: Commit**

```bash
git add plugins/wol/power_ops.py plugins/wol/plugin.py
git commit -m "feat(wol): remote S3 sleep with armed+sleepable gate (don't-strand-a-host)"
```

---

### Task 4: Power-state model — intent log, status, watcher, map badge

**Files:**
- Modify: `plugins/wol/power_ops.py` (add `power_state`)
- Modify: `plugins/wol/plugin.py` (power_log table, `_wol_log`, `GET /plugins/wol/status`, status provider, node enricher, background watcher)

- [ ] **Step 1: Add `power_state` to `power_ops.py`**

```python
import time


def power_state(name: str, reachable: bool, last_sleep_ts: float | None,
                last_wake_ts: float | None, sleep_ttl: int) -> str:
    now = time.time()
    if reachable:
        return "awake"
    if last_sleep_ts and (now - last_sleep_ts) < sleep_ttl:
        return "slumbering"
    if last_wake_ts and (now - last_wake_ts) < 120:
        return "waking"
    return "dark"
```

- [ ] **Step 2: Create the intent log + `_wol_log` + status, in `setup(ctx)`**

```python
    ctx.db.create_table("power_log",
        "id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, fleet_id TEXT, "
        "action TEXT NOT NULL, result TEXT NOT NULL, detail TEXT, actor TEXT, ts REAL NOT NULL")

    def _wol_log(host, action, result, detail, actor):
        ctx.db.execute(
            "INSERT INTO plugin_wol_power_log (host, action, result, detail, actor, ts) "
            "VALUES (?, ?, ?, ?, ?, ?)", (host, action, result, detail, actor, time.time()))
    ctx._wol_log = _wol_log

    def _last_action_ts(host, action):
        rows = ctx.db.query(
            "SELECT ts FROM plugin_wol_power_log WHERE host=? AND action=? AND result='ok' "
            "ORDER BY ts DESC LIMIT 1", (host, action))
        return rows[0]["ts"] if rows else None

    def _managed_hosts():
        """WoL-capable fleet hosts = curated entries with a mac: fleet_id."""
        import realm_fleet
        cat = realm_fleet._catalog()
        if not cat:
            return []
        return [e for e in cat.entries
                if e.status == "curated" and e.fleet_id.startswith("mac:")]

    def _reachable(name):
        api = ctx.get_plugin_api("latency")
        if not api:
            return False
        return name in api["get_latency_map"]()

    def _status():
        ttl = ctx.db.get_setting("sleep_ttl_seconds", 21600)
        sleepable = ctx.db.get_setting("sleepable", [])
        out = []
        for e in _managed_hosts():
            n = e.current_name
            reachable = _reachable(n)
            state = power_ops.power_state(n, reachable, _last_action_ts(n, "sleep"),
                                          _last_action_ts(n, "wake"), ttl)
            out.append({"host": n, "fleet_id": e.fleet_id, "ip": getattr(e, "ops_ip", None),
                        "state": state, "reachable": reachable, "sleepable": n in sleepable})
        return out
    ctx._wol_status = _status

    ctx.register_endpoint("GET", "/plugins/wol/status", lambda req, params: {"hosts": _status()})
    ctx.register_status_provider(lambda: {"wol": {h["host"]: h["state"] for h in _status()}})
```

NOTE: with closures defined inside `setup`, also move `_h_sleep`/`_h_doctor`/`_h_wol` inside `setup` (or keep them module-level and reach state via `ctx` stored on a module global). Pick one structure and keep it consistent. The cleanest: define all handlers inside `setup` so they close over `ctx`, `power_ops`, `_wol_log`, `_status`. Update the sleep handler's log call to `_wol_log(name, "sleep", ...)` and the wake handler to `_wol_log(name, "wake", ...)`.

- [ ] **Step 3: Add wake logging**

In the wake handler, after a successful send, call `_wol_log(name or raw, "wake", "ok", mac, "api")`.

- [ ] **Step 4: Add the reachability-edge watcher (themed events come in Task 5)**

```python
    _last_state = {}

    def _watch():
        for h in _status():
            prev = _last_state.get(h["host"])
            cur = h["state"]
            if prev is not None and prev != cur:
                ctx.push_event("realm-event", {
                    "kind": "highlight", "node": h["host"],
                    "subtype": f"wol.{cur}", "text": f"{h['host']}: {prev} → {cur}"})
            _last_state[h["host"]] = cur
    ctx.start_background_thread(_watch, interval=20, name="wol-watch")
```

- [ ] **Step 5: Add a 🌙 node enricher for slumbering hosts**

```python
    def _enrich(node_id, node_data):
        st = ctx.db  # noqa — placeholder to show scope; use cached statuses
        for h in _status():
            if h["host"] == node_id and h["state"] == "slumbering":
                return {"badge": "🌙", "sublabel": "slumbering", "status_class": "wol-slumber"}
        return None
    ctx.register_node_enricher(_enrich, priority=40)
```

(If `_status()` per-enrich-call is too heavy, cache the last `_watch()` result in a dict and read that. Acceptable for a ~130-node map at enrich frequency; optimize only if the load log shows lag.)

- [ ] **Step 6: Verify status + slumber detection**

Run: `make dev`. `curl -s localhost/plugins/wol/status | python3 -m json.tool` → every mac: fleet host with a `state`. Sleep familiar (Task 3 Step 5), wait ~20s, re-curl → `familiar` shows `"state": "slumbering"`. Wake it → returns to `"awake"`.

- [ ] **Step 7: Commit**

```bash
git add plugins/wol/power_ops.py plugins/wol/plugin.py
git commit -m "feat(wol): power-state model (slumbering vs dark), status, watcher, map badge"
```

---

### Task 5: Loose RPG hooks (events + codex + XP)

**Files:**
- Modify: `plugins/wol/plugin.py` (themed events + guarded game-layer calls in `_watch`)

- [ ] **Step 1: Replace the plain watcher event with themed events + RPG hooks**

```python
    _THEMES = {
        "slumbering": ("speech", "🌙 {host} slips into slumber."),
        "awake":      ("speech", "⚡ {host} awakens."),
        "dark":       ("alert",  "🕯️ {host} has gone dark."),
    }

    def _watch():
        prog = ctx.get_plugin_api("progression")
        codex = ctx.get_plugin_api("codex")
        for h in _status():
            host, cur, prev = h["host"], h["state"], _last_state.get(h["host"])
            if prev is not None and prev != cur and cur in _THEMES:
                kind, tmpl = _THEMES[cur]
                ctx.push_event("realm-event", {"kind": kind, "node": host,
                    "subtype": f"wol.{cur}", "text": tmpl.format(host=host)})
                if cur in ("slumbering", "awake"):
                    if prog:
                        try: prog["grant_xp"](host, 5, f"wol.{cur}")
                        except Exception as e: ctx.log(f"wol xp hook failed: {e}")
                    if codex:
                        try: codex["add_journal_entry"](f"{host} entered state {cur}")
                        except Exception as e: ctx.log(f"wol codex hook failed: {e}")
            _last_state[host] = cur
    ctx.start_background_thread(_watch, interval=20, name="wol-watch")
```

NOTE: confirm the exact `progression`/`codex` API method names + signatures from their `expose_api` (`grant_xp`, `add_journal_entry`) before relying on them — read `plugins/progression/plugin.py` and `plugins/codex/plugin.py`. If signatures differ, adapt the call; keep the `try/except` so a game-layer change never breaks power control.

- [ ] **Step 2: Verify events fire**

Run: `make dev` with the map open (`localhost/realm-map.html`). Sleep then wake familiar; expect a 🌙 "slips into slumber" then ⚡ "awakens" speech bubble. Check `curl -s localhost/events | python3 -m json.tool | grep wol` for the `wol.*` subtypes. If `progression`/`codex` are loaded, confirm no hook errors in the load log.

- [ ] **Step 3: Commit**

```bash
git add plugins/wol/plugin.py
git commit -m "feat(wol): themed slumber/wake events + loose XP/codex hooks"
```

---

### Task 6: MCP tools

**Files:**
- Create: `plugins/wol/mcp_tools.py`

- [ ] **Step 1: Write `mcp_tools.py`**

```python
"""MCP tools for the Astral Conduit — wake/sleep/status of fleet hosts."""
import urllib.request
import json

_BASE = "http://localhost:80"


def _post(path, body):
    req = urllib.request.Request(_BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _get(path):
    with urllib.request.urlopen(_BASE + path, timeout=20) as r:
        return json.loads(r.read())


def wol_status() -> dict:
    """Power state of all WoL-managed fleet hosts (awake/slumbering/waking/dark)."""
    return _get("/plugins/wol/status")


def wol_wake(target: str) -> dict:
    """Send a Wake-on-LAN magic packet. target = MAC or fleet name/id."""
    return _post("/wol", {"target": target})


def wol_sleep(target: str) -> dict:
    """Suspend a sleepable, WoL-armed fleet host to S3. target = fleet name/id."""
    return _post("/plugins/wol/sleep", {"target": target})


MCP_TOOLS = [
    ("wol_status", wol_status, "Power state of all WoL-managed fleet hosts."),
    ("wol_wake", wol_wake, "Wake a host via WoL magic packet (mutating)."),
    ("wol_sleep", wol_sleep, "Suspend a sleepable host to S3 (mutating)."),
]
TOOLS = MCP_TOOLS
```

- [ ] **Step 2: Verify the Conduit lists them**

Run: `.venv/bin/python3 plugins/mcp/launcher.py` (Ctrl-C after the banner).
Expected: stderr tool list includes `wol_status`, `wol_wake`, `wol_sleep`.

- [ ] **Step 3: Commit**

```bash
git add plugins/wol/mcp_tools.py
git commit -m "feat(wol): MCP tools (wol_status/wake/sleep) for the Astral Conduit"
```

---

### Task 7: Dedicated panel (Slumber Ward)

**Files:**
- Create: `plugins/wol/panel.html`, `plugins/wol/panel.js`, `plugins/wol/panel.css`

- [ ] **Step 1: `panel.html`** — a host table the JS fills.

```html
<div id="wol-panel-body">
  <div class="wol-head"><span>Slumber Ward</span> <button id="wol-refresh">↻</button></div>
  <table class="wol-table"><thead><tr><th>Host</th><th>State</th><th>Actions</th></tr></thead>
  <tbody id="wol-rows"></tbody></table>
  <div id="wol-status" class="wol-status"></div>
</div>
```

- [ ] **Step 2: `panel.js`** — fetch status, render rows, wire wake/slumber.

```javascript
const ICON = { awake: "⚡", slumbering: "🌙", waking: "…", dark: "🕯️" };
async function wolRefresh() {
  const r = await fetch("/plugins/wol/status").then(x => x.json());
  const tb = document.getElementById("wol-rows"); tb.innerHTML = "";
  for (const h of (r.hosts || [])) {
    const tr = document.createElement("tr");
    const wake = `<button data-act="wake" data-h="${h.host}">Wake</button>`;
    const sleep = h.sleepable ? `<button data-act="sleep" data-h="${h.host}">Slumber</button>` : "";
    tr.innerHTML = `<td>${h.host}</td><td>${ICON[h.state]||""} ${h.state}</td><td>${wake}${sleep}</td>`;
    tb.appendChild(tr);
  }
}
document.getElementById("wol-panel-body").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const act = b.dataset.act, host = b.dataset.h;
  if (act === "sleep" && !confirm(`Slumber ${host}? It will suspend to S3.`)) return;
  const path = act === "wake" ? "/wol" : "/plugins/wol/sleep";
  document.getElementById("wol-status").textContent = `${act}…`;
  const res = await fetch(path, {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({target: host})}).then(x => x.json()).catch(err => ({error:String(err)}));
  document.getElementById("wol-status").textContent = res.error ? `✗ ${res.error}` : `✓ ${act} ${host}`;
  setTimeout(wolRefresh, 2000);
});
document.getElementById("wol-refresh").addEventListener("click", wolRefresh);
wolRefresh(); setInterval(wolRefresh, 30000);
```

- [ ] **Step 3: `panel.css`** — themed to match the realm (dark parchment + moon accent). Keep it short; mirror an existing panel's variables (read `plugins/wifi/panel.css` for the palette/classes and reuse the same custom properties).

- [ ] **Step 4: Verify the panel renders**

Run: `make dev`, open `localhost/realm-map.html`, open the Slumber Ward panel. Expect host rows with state icons + Wake/Slumber buttons; Slumber shows a confirm; actions update the status line.

- [ ] **Step 5: Commit**

```bash
git add plugins/wol/panel.html plugins/wol/panel.js plugins/wol/panel.css
git commit -m "feat(wol): Slumber Ward panel"
```

---

### Task 8: Per-node map control (wake + slumber)

**Files:**
- Modify: `src/node-controls.js` (the WoL control block ~163-167 and the action switch ~546)

- [ ] **Step 1: Add a slumber button next to the existing wake button (~line 167)**

Where the WoL control is built, add a sibling button (only meaningful for hosts with a MAC):

```javascript
        <button class="pe-control-btn" data-action="wol" data-mac="${topoNode.mac}" data-ip="${topoNode.ip}">Send Magic Packet</button>
        <button class="pe-control-btn" data-action="sleep" data-name="${topoNode.name || topoNode.id}">Slumber</button>
```

- [ ] **Step 2: Handle the `sleep` action in the switch (~line 546, beside `case 'wol'`)**

```javascript
      case 'sleep': {
        if (!confirm(`Slumber ${nodeKey}? It will suspend to S3 (wake it with the magic packet).`)) {
          statusEl.textContent = 'Cancelled'; statusEl.style.color = '#a89870'; return;
        }
        endpoint = `/plugins/wol/sleep`;
        body = { target: el.dataset.name };
        break;
      }
```

- [ ] **Step 3: Rebuild the bundle**

Run: `npm run build`
Expected: esbuild completes, `realm-map.js` regenerated, no errors.

- [ ] **Step 4: Verify in the map**

Run: `make dev`, open `localhost/realm-map.html`, open a node with a MAC (e.g. familiar). Expect both "Send Magic Packet" and "Slumber" buttons; Slumber confirms then POSTs `/plugins/wol/sleep`.

- [ ] **Step 5: Commit**

```bash
git add src/node-controls.js realm-map.js realm-map.js.map
git commit -m "feat(wol): per-node Slumber control in node-controls"
```

---

### Task 9: Full integration validation + ship

- [ ] **Step 1: Clean load + endpoint catalogue**

Run: `make dev`; `curl -s localhost/debug | python3 -m json.tool` → confirm `wol` plugin + `/wol`, `/plugins/wol/status`, `/plugins/wol/sleep`, `/plugins/wol/doctor` all registered. No tracebacks in the load log.

- [ ] **Step 2: End-to-end on familiar (the real ground truth)**

1. `curl 'localhost/plugins/wol/doctor?target=familiar'` → `armed: true`.
2. `curl -X POST localhost/plugins/wol/sleep -d '{"target":"familiar"}'` → ok; `ping familiar` fails within ~20s; status → `slumbering`; a 🌙 event fires.
3. `curl -X POST localhost/wol -d '{"target":"familiar"}'` → ok; `ping familiar` returns; status → `awake`; ⚡ event fires.

- [ ] **Step 3: MCP + panel + map smoke**

Conduit lists `wol_*`; Slumber Ward panel renders; per-node Slumber button works.

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/wol-power-plugin
gh pr create --title "feat(wol): Slumber Ward — WoL + remote S3 sleep plugin" --body "<summary + spec link>"
git checkout master
```

---

## Self-Review

**Spec coverage:** §1 goal → Tasks 1-8. §4 surfaces: wake (T2), sleep (T3), status (T4), doctor (T3), CLI (T1 manifest + endpoints exist by T4), MCP (T6), map (T8), panel (T7). §5 power-state → T4. §6 data model (settings + power_log) → T3/T4. §7 data flow + RPG → T4/T5. §8 safety (403/409 gate, confirm, idempotency) → T3/T8. §9 core changes → T2 (remove) + T8 (node-controls). §10 testing → T9. All covered.

**Placeholder scan:** No TBD/TODO. The two NOTES (relative-vs-absolute import; `req.ctx` vs closure; exact progression/codex signatures) are explicit decision points with the resolution method stated, not deferred work — acceptable.

**Type/name consistency:** `resolve_target`→(mac, name, directed_ip) used consistently; `_wol_log(host, action, result, detail, actor)` matches the `power_log` columns; `power_state(...)` args match the call site; `_status()` row keys (`host/fleet_id/ip/state/reachable/sleepable`) match panel.js + enricher reads. Table name `plugin_wol_power_log` matches the `create_table("power_log", …)` prefix convention.

**Open verification items folded into steps:** (a) plugin import form, (b) `req.ctx` availability vs closures, (c) progression/codex method names. Each is validated by a run step, not assumed.
