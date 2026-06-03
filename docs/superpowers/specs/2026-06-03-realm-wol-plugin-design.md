# WoL / Power-Management Plugin for Realmwatch — Design

**Date:** 2026-06-03
**Status:** spec, awaiting implementation plan
**Origin:** Wake-on-LAN currently lives inline in core (`map_server.py:_h_post_wol` + a button in `src/node-controls.js`) — against the thin-core/fat-plugins principle. JP asked to extract it into a real `plugins/wol/` plugin **and** add the inverse capability (remote *sleep*), building on a 2026-06-02 session where we proved WoL works on the headless `familiar` host from **S3 suspend** (ACPI-armed wake) but **not** from S5 poweroff (BIOS-gated, unreachable without a display). See `familiar.realm.watch` memory `reference-familiar-wol-s3`.

## 1. Goal

A self-contained power-management plugin that can **wake** (WoL magic packet) and **slumber** (S3 suspend over SSH) fleet hosts from the realm, with real **power-state awareness** (distinguishing *slumbering* from *dark/off* — the distinction a bare ping can't make), exposed across four surfaces (per-node map control, dedicated panel, CLI verbs, MCP tool), and woven into the fantasy/RPG layer (themed events, codex lore, XP). Core gets thinner: the inline `/wol` logic moves into the plugin.

## 2. Current state

- `map_server.py:_h_post_wol` (≈ lines 1545–1595) — wake sender. Accepts `target` (raw MAC, or fleet `current_name`/`prior_name`/`fleet_id`) or legacy `mac`; resolves a MAC via `realm_fleet.host()` (requires `fleet_id` starting `mac:`); builds the magic packet (`b'\xff'*6 + mac*16`); sends to the limited broadcast `255.255.255.255:9` **and** the directed subnet broadcast (`x.y.z.255`) when a `directed_ip`/`ops_ip` is known. Route registered at `map_server.py:1849`.
- `src/node-controls.js` — per-node "Send Magic Packet" button (`data-action="wol"`, posts `{mac, ip}` to `/wol`).
- **No** `plugins/wol/`. No sleep, no power-state, no MCP tool, no game-layer events.

## 3. Architecture

```
plugins/wol/                         (type: integrated, depends_on: ["latency"])
  plugin.json    manifest: panel + endpoints + cli.verbs + depends_on
  plugin.py      setup(ctx): register endpoints, status provider, node enricher,
                 background reachability watcher, expose_api, loose RPG wiring
  power_ops.py   pure logic: send_magic_packet(mac, ip) · suspend_host(name)
                 · check_wol(name) [doctor] · arm_wol(name) [optional]
                 · power_state(name) · resolve_target(raw) -> (mac, name, ip)
  mcp_tools.py   MCP_TOOLS = [(name, fn, desc), ...] -> wol_wake / wol_sleep / wol_status
  panel.html/js/css   "Slumber Ward" 🌙 — fleet hosts, live power state, wake/slumber

core edits:
  map_server.py        remove _h_post_wol + its route (plugin re-registers POST /wol)
  src/node-controls.js add slumber button + power-state reflect; npm run build

Loose (runtime, optional via ctx.get_plugin_api, guarded `if api:`):
  latency      reachability  (REQUIRED dep — get_latency_map)
  progression  grant_xp / grant_achievement
  codex        add_journal_entry / chronicle_*
  quests       (optional hook)
```

**Why a hard dep on `latency` but soft on the game layer:** reachability is the backbone of the power-state model and `latency` is always loaded; the RPG plugins are optional and `get_plugin_api` returns `None` safely when absent.

## 4. Surfaces & endpoints

| Surface | Mechanism |
|---|---|
| **Wake** | `POST /wol` via `ctx.register_endpoint("POST", "/wol", h_wol, raw_path=True)` — identical contract to today (MAC / fleet-id resolution, limited + directed broadcast). Frontend parity preserved. |
| **Sleep** | `POST /plugins/wol/sleep` `{target}` → SSH the privileged command `sudo -n systemd-run --no-block systemctl suspend` over realmwatch's **existing** SSH path (the same one the `/ssh/<ip>/reboot` action uses to gain privilege — root login or passwordless `sudo`; the plan resolves which by reading the reboot handler). `systemd-run --no-block` so SSH returns cleanly instead of dying with the host (lesson from the familiar session, where we ran `sudo systemd-run --no-block systemctl suspend` as `jp`). |
| **Status** | `GET /plugins/wol/status` → `[{host, fleet_id, ip, state, reachable, last_action, last_action_ts}]` for every WoL-managed host. |
| **Doctor** | `GET /plugins/wol/doctor?target=` → per-host readiness: SSH reachable? privilege OK? **WoL armed (`sudo -n ethtool <iface>` → `Wake-on: g`)?** Optional `POST /plugins/wol/arm` re-arms (`sudo -n ethtool -s <iface> wol g` + `sudo -n nmcli … 802-3-ethernet.wake-on-lan magic` when NM-managed). All ethtool/nmcli calls need root, obtained via the same privileged SSH path as Sleep. |
| **CLI** | `plugin.json` `cli.verbs`: `show` (→ status), `wake` (→ /wol), `sleep` (→ /plugins/wol/sleep), `doctor` (→ /plugins/wol/doctor). The cli plugin runs declared verbs via their HTTP endpoint — no Python registration. |
| **MCP** | `mcp_tools.py` → `wol_status`, `wol_wake(target)`, `wol_sleep(target)`. `wol_wake`/`wol_sleep` tagged mutating (aligns with the `ssh_run`/`fleet_rename` ACL roadmap). |
| **Map** | per-node wake + slumber buttons in `node-controls.js`; a 🌙 badge/sublabel on slumbering nodes via `ctx.register_node_enricher`. |

## 5. Power-state model

Per host, derived from `latency` reachability + an **intent log**:

| State | Condition |
|---|---|
| **awake** | reachable (`host in latency_api["get_latency_map"]()`) |
| **slumbering** 🌙 | unreachable **and** latest log row is a successful `sleep` within `sleep_ttl_seconds` |
| **waking** | a `wake` was issued and the host is not yet reachable (short transient TTL, e.g. 120 s) |
| **dark** | unreachable, no recent sleep/wake intent (off / crashed / unknown) |

`power_ops.power_state(name)` computes this. A background watcher (`ctx.start_background_thread`, ~20 s) tracks reachability **edges** and emits events + RPG hooks on transition (so an externally-rebooted host that comes back also fires "awakens").

## 6. Data model

**Settings** (namespace `plugin:wol`, via `ctx.db.get_setting`/`set_setting`):
- `sleepable: list[str]` — fleet `current_name`s opted in for remote sleep (seed `["familiar"]`). Sleep is consequential, so it's **opt-in per host**.
- `sleep_ttl_seconds: int` — slumbering-intent window (default `21600`, 6 h).
- `iface_overrides: dict[str,str]` — optional per-host NIC name for doctor/arm (else auto-detect via `ip -o route get`).

**Intent log** (`ctx.db.create_table("power_log", …)` → `plugin_wol_power_log`):
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT,
host TEXT NOT NULL,        -- fleet current_name
fleet_id TEXT,             -- mac:...
action TEXT NOT NULL,      -- 'wake' | 'sleep'
result TEXT NOT NULL,      -- 'ok' | 'error'
detail TEXT,               -- packet info / error / ssh stderr
actor TEXT,                -- 'map' | 'panel' | 'cli' | 'mcp'
ts REAL NOT NULL           -- epoch seconds
```

## 7. Data flow & RPG hooks

1. **Wake**: surface → `POST /wol` → `power_ops.send_magic_packet` → log `wake`. Watcher sees `dark/slumbering → awake` → `ctx.push_event("realm-event", {kind:"speech"/"highlight", node, text:"*<name> awakens* ⚡"})` → `progression.grant_xp(...)`, `codex.add_journal_entry(...)` (each `if api:`).
2. **Sleep**: surface → `POST /plugins/wol/sleep` → **doctor pre-check** (armed + reachable) → `ssh_run` suspend → log `sleep`. Watcher sees `awake → slumbering` → themed "*<name> slips into slumber* 🌙" event + XP + codex chronicle.
3. **Status/SSE**: `ctx.register_status_provider(lambda: {"wol": {...power states...}})` so the map badges nodes live; the panel polls `GET /plugins/wol/status`.

Event subtypes are namespaced (`wol.slumber`, `wol.wake`) so `quests`/`codex` can subscribe via `ctx.on_event` without guessing.

## 8. Safety / error handling

- **Don't-strand-a-host rule (baked in):** `/sleep` returns **`403`** if the host isn't in `sleepable`, and **`409`** if doctor reports WoL not armed (`Wake-on: g` absent) or SSH unreachable — we never suspend a host we can't wake.
- UI `confirm()` on slumber (mirrors the existing reboot control). CLI `sleep` echoes the target.
- `ssh_run` failures surfaced verbatim (`{ok, stdout, stderr, code}`); a suspend that returns non-zero is logged `error` and reported.
- Idempotent no-ops: waking a reachable host / sleeping an unreachable host → `200` with an explanatory message, no action.
- Cross-VLAN wake relies on the directed-subnet broadcast the existing sender already does; the realm host must be able to reach that broadcast (documented limitation).
- No hardcoded home paths; SSH as root via BatchMode (key-based); no secrets in code.

## 9. Core changes

- **Remove** `_h_post_wol` and its `_route_table.add("POST", "/wol", …)` from `map_server.py`. The plugin re-registers the identical path with `raw_path=True`. Net behavior unchanged for existing callers.
- **`src/node-controls.js`**: add a `data-action="sleep"` slumber button (shown when host ∈ `sleepable` and reachable) and reflect power state on the control; rebuild with `npm run build` (it's bundled output).

## 10. Testing (realmwatch has no test framework — validate by running)

1. `make dev` — clean load, plugin appears in load log, no import errors.
2. `curl -s localhost/debug | python3 -m json.tool` — `/wol` and `/plugins/wol/*` registered.
3. `curl -X POST localhost/wol -d '{"target":"<mac>"}'` — wake parity with the old core path.
4. `curl -s localhost/plugins/wol/status` — derived power states.
5. **End-to-end on `familiar`** (real host, ground truth from the helper scripts + memory): `doctor` → `sleep` → confirm `slumbering` → `wake` → confirm `awake`.
6. `npm run build`; open `realm-map.html` — per-node control + Slumber Ward panel render; node badges slumbering hosts.
7. Launch the Astral Conduit (`.venv/bin/python3 plugins/mcp/launcher.py`) — `wol_*` tools listed.

## 11. Out of scope (v1)

- Scheduling / quiet-hours auto-sleep (a later automation layer).
- Hibernate (S4) / true cold-off (S5) — blocked on per-host swap + BIOS; the familiar memory documents why.
- Per-tool MCP ACL enforcement (tracked in the MCP roadmap; we only *tag* mutating tools now).
