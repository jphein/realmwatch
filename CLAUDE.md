<!-- claude-md-version: cd87c3f | updated: 2026-04-28 -->
# Realmwatch — Claude Code Brief

Fantasy-themed homelab network monitor + game engine + MCP platform.
Visualizes 12 VLANs, 130+ nodes, collectd metrics, firewall rules, WiFi
roaming, Home Assistant devices, and energy data on an interactive SVG
map with high-fantasy theming. Includes an RPG layer (XP, skills, quests,
combat-ward, codex) absorbed from os.realm.watch in May 2026, plus a
FastMCP server that exposes realmwatch's runtime to Claude Code. Single
machine, local dev.

The plugin system is the structural truth: the bundled core is mostly a
rendering engine, and **50 plugins** under `plugins/<name>/` carry the
feature surface. For the full architecture, plugin catalog, and source
tree see `README.md`. This file is the working brief for Claude — rules,
environment, and gotchas.

**Scope boundary:** realmwatch owns everything that touches network
events, fantasy translation, game state, or MCP tools. `os.realm.watch`
is now **OS-layer only** (GNOME extension, theme watcher, desktop
integration) — do not put new event producers or game logic there.

## Rules

- `engine.py` is the single source of truth for sensor/translation logic — never
  duplicate it
- `topology.json` is the single source of truth for nodes/connections (in
  `.claudeignore` — query via `realm topology` / the HTTP API, don't read directly)
- `personas.json` is managed via `POST /personas` (in `.claudeignore`)
- `realm.db` is live data — never drop tables or delete rows
- `realm-map.js` is BUILT output — edit `src/*.js` then `npm run build`
- `map_server.py` is the standalone HTTP server — endpoint registration runs
  through plugin loaders, but the router itself lives here
- New features should be plugins (`plugins/<name>/plugin.json` + `plugin.py`).
  Only grow the core bundle for rendering or infrastructure changes.
- openai SDK (2.29.0) for Azure AI — azure-ai-inference SDK migration is complete
- `fleet.yaml` is identity-of-record for all nodes — JP-specific, gitignored.
  Mutations go through `/fleet/rename`, `/fleet/replace`, `/fleet/promote`,
  or direct file edits (mtime-poll hot-reloads ~2s). `topology.json` (in
  `realm.db`), `personas.json`, and `realm-local.json` reference nodes by
  `fleet_id`, not by current_name.
- `~/.realmwatch/game.db` is the RPG sidecar — owned by `plugins/realm-engine/`,
  read/written by `progression`, `quests`, `combat-ward`, `codex`. Resolve
  the path via `realm_text.real_home()` (handles sudo) — never hardcode
  `~/.realmwatch/...` literally. `REALM_GAME_DB` env var overrides.
- `realm_text.py` at the repo root is the canonical home for shared utility
  helpers: `sanitize_hostname()`, `sanitize_log_line()`, `sanitize_banner()`,
  `ulid()`, and `real_home()` (the sudo-aware home resolver). Plugins that
  need any of these import from `realm_text` — never duplicate the
  implementations.
- Cross-plugin coupling is **loose**. Use `ctx.expose_api({...})` to publish
  your plugin's API, `ctx.get_plugin_api("<name>")` to consume another's
  (returns `None` if not loaded), and `ctx.on_event(type, fn)` /
  `ctx.push_event(...)` for fire-and-forget pub-sub. Never `import` from
  another plugin's module path.
- The diagnose/fix/retrieve verb trinity is `brief` / `doctor` / `logs` /
  `show` / `fix`. Plugins exposing CLI verbs should reach for these names
  before inventing new ones — operators have muscle memory across the realm.
- **`realm <verb>` is the front-door for realm operations** — prefer it over
  raw `curl`. It wraps the HTTP API (`map_server.py :80`) with hostname
  sanitization, `--json` machine-readable output, `--dry-run`, and a
  consistent exit-code contract (0 ok · 3 network · 4 auth · 5 server ·
  22 client). Drop to raw `curl` only for endpoints the CLI doesn't cover yet.
  - **Capability discovery:** bare `realm` (or `realm --list-commands`) is the
    agent entrypoint — it lists every available subcommand. `realm <cmd> --json`
    yields structured, machine-readable output.
  - **Preview before you mutate.** Before any mutating realm op, preview it via
    that command's documented safety flag — usually `--dry-run`, but some
    commands (`zones`, `update-all`) are dry-run-by-default and require
    `--commit` to execute. Check `--help` rather than assuming one idiom.

## Tech Stack

- **Python 3.12** (uv-managed venv at `./.venv/`, lockfile `uv.lock`): stdlib
  `http.server` + ThreadingMixIn, psutil, openai (Azure AI), httpx, notion-client,
  python-dotenv, ruamel.yaml. Bootstrap: `make install` (uv sync) — falls back
  to pip + requirements.txt if uv isn't on PATH. Direct deps in `pyproject.toml`.
- **JavaScript**: vanilla ES2020 modules, bundled by esbuild 0.27.3 (IIFE),
  WinBox window manager (runtime, not bundled)
- **Database**: SQLite (`realm.db`) with WAL mode — 12 tables: settings, events,
  personas, nodes, connections, regions, quests, notion_synced, wifi_scans,
  sub_entities, discovery_links, discovery_capabilities
- **Data sources**: collectd RRD (`/var/lib/collectd/rrd/`), collectd UDP
  (port 25826), Home Assistant REST API, SSH to OpenWrt APs, fping latency
  probing, nftables JSON parsing, WLED HTTP API, Notion API, Netdata REST
  (replacing collectd progressively)
- **Frontend**: SPA SVG map app — no frameworks, plain fetch + ES modules.
  Plugins inject `panel.html/js/css` at server start; no hot reload.

## Quick Start

```bash
make install              # uv sync (reads pyproject.toml + uv.lock) + npm install
make build                # esbuild src/main.js → realm-map.js (minified IIFE)
make dev                  # .venv/bin/python3 map_server.py — canonical foreground

# Optional daemons (off by default — opt-in per use)
make oracle               # .venv/bin/python3 oracle_daemon.py --no-voice
make herald               # .venv/bin/python3 realm_herald.py

# Dev loop
npm run watch             # esbuild watch mode (non-minified, auto-rebuild)
make health               # ./scripts/realm-health.sh
make clean                # remove __pycache__, .pyc, node_modules/.cache
make deploy               # copies wifi-guide.html, report-card.html → realm-portal
```

### systemd (optional)

All services are off by default. To enable a service for unattended operation:

```bash
cp systemd/*.service systemd/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now realm-map-server   # opt in per-unit
```

Six services + one timer ship in `systemd/`: `realm-map-server`,
`realm-launcher`, `oracle-daemon`, `realm-herald`, `realm-theme-watcher`,
and `realm-update-all` (+ its `realm-update-all.timer`). `realm-theme-watcher`
is desktop-theming (independent of the map server); `realm-map-server` and
`realm-launcher` are typically enabled for unattended operation. The rest are
opt-in per-unit.

## Architecture (summary)

```
Browser (realm-map.html)
  bundled core (src/*.js → realm-map.js) for rendering, panels, SVG, SSE
  plugin panels loaded at runtime from /plugins/<name>/panel.{html,js,css}
       │ HTTP + SSE
       ▼
map_server.py :80
  ├── route_table.py — path → handler dispatch
  ├── plugin_loader.py / plugin_context.py / plugin_registry.py
  │     scans plugins/, validates manifests, topo-sorts depends_on,
  │     calls setup(ctx) which can register endpoints / SSE sources /
  │     enrichers / discovery providers / background threads
  ├── sse_broker.py — hash-deduped fanout
  ├── engine.py + node_roles.py — sensors, mesh, fantasy translations
  └── discovery_engine.py — provider registry, sub-entity linking

Independent processes (off by default):
  oracle_daemon.py · realm_herald.py · realm_launcher.py (:8899)
```

**Core principle: thin core, fat plugins.** Every domain feature (census,
latency, firewall, wifi, scan, skills, debug, herald, chat, system-updates,
quests, progression, combat-ward, codex, mcp, …) is a plugin under
`plugins/<name>/`.

## Game layer (absorbed from os.realm.watch — May 2026)

Five plugins form an RPG layer on top of the monitor:

| Plugin | Owns | Subscribes to | Exposes via expose_api |
|---|---|---|---|
| `realm-engine` | `game.db` (events, entities, players); wraps `push_event` | `(all events flow in)` | `realm_status`, `ingest_event`, `get_profile`, `list_entities`, `get_entity`, `mcp_tools` |
| `progression` | `players`, `xp_events`, `skill_trees`, `player_skills`, `achievements` | `xp.grant` | `grant_xp`, `get_level_info`, `unlock_skill`, `grant_achievement`, `check_achievements`, `mcp_tools` |
| `quests` | `quests`, `quest_event_links`, `quest_state_log` (game.db); also writes legacy `realm.db.quests` table | `alert`, `system`, `discovery`, `speech`, `quest` (severity≥2) | `generate_quest_from_event`, `list_quests`, `accept_quest`, `complete_quest`, `mcp_tools` |
| `combat-ward` | `actions`, `action_policy_log`, `bestiary_entries`, `ward_templates` | `port_scan`, `brute_force`, `dns_poisoning`, `firewall_block`, `ddos`, `unknown_device`, `cpu_spike`, `memory_critical` | `propose_action`, `approve_action`, `execute_action`, `update_bestiary`, `defense_report`, `mcp_tools` |
| `codex` | `codex_entries`, `node_lore`, `chronicles`, `journal_entries` | `xp.grant`, `level.up`, `achievement.unlocked`, `quest.completed` | `get_codex_entry`, `get_node_lore`, `set_node_lore`, `get_chronicles`, `add_journal_entry`, `chronicle_*` helpers, `mcp_tools` |

The game DB is a **sidecar** — separate from `realm.db`. Plugin schemas are
declared `CREATE TABLE IF NOT EXISTS`, so multiple plugins safely co-load
the same tables (Wave 4 may unify ownership). Don't try to merge into
`realm.db` — that's a v0.6 decision.

## MCP server (plugins/mcp/)

In-tree MCP server, fantasy name "The Astral Conduit". Stdio (default) plus an opt-in SSE/HTTP transport.

- **Launcher:** `plugins/mcp/launcher.py` — run via
  `.venv/bin/python3 plugins/mcp/launcher.py` from any cwd. FastMCP banner
  on stderr; tool list logged to stderr; protocol on stdin/stdout.
- **Transport:** `REALM_MCP_TRANSPORT` selects `stdio` (default), `sse`, or
  `http`; HTTP modes serve at `REALM_MCP_HOST:REALM_MCP_PORT` (default
  `127.0.0.1:8765`) on `/mcp/sse`. Connect over SSE with
  `claude mcp add --transport sse realm http://127.0.0.1:8765/mcp/sse`.
- **In-process plugin:** `plugins/mcp/plugin.py` only registers `/mcp/info`
  diagnostic + logs the launcher path. Does NOT start a server in-process
  (would compete for stdin with map_server).
- **Tool registry:** `plugins/mcp/tools.py` holds the core tools; each plugin
  ships a `mcp_tools.py` (`MCP_TOOLS` list) which the launcher **auto-aggregates**
  at startup (guarded imports — a broken plugin can't crash the conduit). ~48
  tools register today across core + codex/combat-ward/progression/wol/palace/quests.
- **Connecting Claude Code:**
  `claude mcp add realmwatch /home/jp/Projects/realmwatch/plugins/mcp/launcher.py`
  (or hand-edit `~/.claude/mcp.json`).
- **Per-tool ACLs:** mutating tools (17 — `ssh_run`, `fleet_rename`, `wol_*`,
  `grant_*`, `cast_ward`, …) can be gated. Enforcement is OFF by default
  (existing usage unaffected); set `REALM_MCP_GATE_MUTATING=1` and allowlist via
  `REALM_MCP_ALLOW` (comma list / `*`) or `~/.realmwatch/mcp-acl.json`
  `{"allow":[...]}`. Read tools are always allowed.

## Source Files (current line counts)

### Python — core (not a plugin)

| File | Lines | Role |
|------|------:|------|
| map_server.py | 1827 | HTTP :80 server, route dispatch, plugin wiring, static files |
| realm_launcher.py | 1187 | Port 8899 — branch portal, map_server restart |
| realm_db.py | 1088 | SQLite — 12 tables, settings, events, personas, topology, quests, scans, sub-entities |
| node_roles.py | 946 | 30+ role defs, 6-signal enrichment pipeline, OUI lookup |
| discovery_engine.py | 658 | Provider registry, scan orchestration, sub-entity linking |
| engine.py | 454 | RealmEngine — sensors, Tailscale mesh, nft counters, fantasy translations |
| plugin_loader.py | 374 | Discovery, manifest validation, topo-sort, lifecycle |
| plugin_context.py | 357 | The `PluginContext` API exposed to `setup(ctx)` |
| sse_broker.py | 316 | Hash-deduped SSE fanout + burst replay |
| realm_herald.py | 315 | Voice daemon — picks interesting nodes, themed templates, speech events |
| oracle_daemon.py | 303 | AI oracle daemon — polls events, calls Azure AI |
| chat_bridge.py | 290 | Azure AI chat, session-based, shared DB with cloud-chat-assistant |
| plugin_registry.py | 198 | Registry of loaded plugins, panels, endpoints |
| route_table.py | 141 | Path → handler table |

Per-plugin backends (`ha_bridge.py`, `ap_scanner.py`, `collectd_reader.py`,
`collectd_listener.py`, `firewall_parser.py`, `latency_prober.py`,
`event_generator.py`, `notion_sync.py`, `codex_sync.py`, `wled_bridge.py`,
`traffic_precompute.py`) still live at repo root and are imported by their
respective plugins. **Migration into plugin dirs is in progress** —
documented as intent in README; not done.

`realm_text.py` (at repo root) is the canonical home for shared helpers:
`sanitize_hostname`, `sanitize_log_line`, `sanitize_banner`, `ulid`, and
`real_home` (the sudo-aware home resolver). Game-layer plugins land here
post-migration — `_real_home()` helpers in `plugins/lexicon/`, `plugins/mcp/`,
`plugins/realm-engine/`, `plugins/progression/`, `plugins/quests/`,
`plugins/combat-ward/`, and `plugins/codex/` are pending dedup into
`realm_text.real_home()`.

### Frontend — bundled core (`src/`)

| File | Lines | Role |
|------|------:|------|
| panel-manager.js | 2593 | Panel system — dock, anchored, conjured, hidden-seal, drag, formations |
| map-view.js | 1357 | Pan/zoom, touch, node drag, deferred rendering, globe Z-index |
| node-controls.js | 1075 | SSH terminal, WoL, WLED, per-node shell / chat / controls |
| layout.js | 912 | Panel layout/settings, save/restore, formations |
| quest-log.js | 906 | Speech bubbles, event rendering, bubble positions |
| spellbook.js | 761 | Search index, filter, enchant tab |
| topology.js | 744 | Node/connection SVG rendering, SSE-driven refresh |
| app.js | 553 | Coordinator — SSE dispatch (incl. `plugin-broadcast`), module wiring |
| persona-editor.js | 526 | Properties / stats tabs, voice selector |
| effects.js | 510 | Motes, sparkles, FPS loop |
| terrain.js | 488 | Biome terrain / heightmap contour rendering (worker offload) |
| node-status.js | 452 | Tooltip content, node sublabels, status update cycle |
| traffic.js | 331 | Connection SVG dash animation |
| winbox-wm.js | 312 | WinBox window manager integration |
| plugin-api.js | 205 | `window.RealmAPI` — plugin hooks for SSE, panels, events |
| main.js | 90 | Entry point, loading stages |
| panels.js | 50 | Gauges (leftover after plugin extraction) |
| utils.js / config.js | 34 / 37 | Helpers, constants (world 4800×3300) |

`debug.js`, `theme-forest.js`, `skills.js`, and `scan.js` were extracted into
`plugins/debug/`, `plugins/forest-theme/`, `plugins/skills/`, and
`plugins/scan/` respectively — they are no longer in `src/`.

### Workers (NOT bundled — edit directly)

- `layout-worker.js` — force-directed + BFS tree + VLAN cluster layout
- `topo-worker.js` — heightmap stamping, marching squares → SVG contours

### HTML / CSS

- `realm-map.html` — SVG canvas, panel templates, spellbook
- `realm-map.css` — panel themes, seal modes, animations
- `splash.html`, `wifi-guide.html`, `report-card.html` — public pages

## API Endpoints

For the live registered set use `GET /debug` (table counts + endpoint catalogue
exposed by the debug plugin). Highlights below are the core router only;
plugins add more on load.

### GET (selected)

`/`, `/realm-map.html`, `/codex/`, `/plugins/<name>/panel.*` (static);
`/status`, `/topology`, `/config`, `/settings`, `/personas`, `/energy`,
`/latency`, `/firewall`, `/quests`, `/events`, `/collectd`, `/observation`,
`/player`, `/debug`, `/scan`, `/scan/status`, `/scan/lldp`, `/scan/wifi`,
`/wifi/aps`, `/ping/<ip>`, `/server-info`, `/notion-sync`, `/codex-sync`,
`/herald`, `/chat/sessions`, `/chat/history`, `/scripts`, `/skills`,
`/claude-md`, `/agents`, `/hooks`, `/resolve-url`, `/reset`, `/sse`.

### POST (selected)

`/chat`, `/chat/clear`, `/event`, `/personas`, `/config`, `/settings`,
`/node`, `/connections`, `/topology`, `/quest-create`, `/quest-update`,
`/quest-delete`, `/player/reward`, `/notion-complete`, `/ssh`, `/wol`,
`/wled/<node_id>/state`, `/skills`, `/claude-md`.

## SSE Event Types (`/sse`)

| Event | Frequency | Content |
|-------|-----------|---------|
| `status` | 10s | Sensors, collectd, WiFi, HA, sublabels |
| `traffic` | 5s | Per-node traffic intensity (log scale) |
| `topology` | 60s | Full topology |
| `energy` | 30s | Solar, battery, grid (HA) |
| `latency` | 30s | Pre-grouped latency by VLAN |
| `firewall` | 60s | Parsed nftables (cached) |
| `wifi` | 120s | AP client lists, signal data |
| `plugin-broadcast` | live | Plugin-dispatched events (routed via `dispatchPluginSSE` in `app.js`) |
| `realm-event` | live | Individual realm events (speech, alert, highlight, quest) |

Initial burst on connect: `topology → traffic → energy → latency → recent
events → status`. Hash-based dedup — only pushes on change.

## Environment Variables

See `.env.example`. `map_server.py` auto-loads `.env` on startup.

| Variable | Required | Default | Used by |
|----------|----------|---------|---------|
| `HA_TOKEN` | Yes (for HA) | — | ha plugin |
| `HA_URL` | No | `https://10.0.6.108:8123` | ha plugin |
| `NOTION_TOKEN` | Yes (for quests/codex) | — | notion + codex plugins |
| `NOTION_DATABASE_ID` | Yes (for quests) | — | notion plugin |
| `AZURE_AI_API_KEY` | Yes (for chat/oracle) | — | chat_bridge.py + oracle_daemon.py |
| `AZURE_AI_ENDPOINT` | Yes (for chat/oracle) | — | chat_bridge.py + oracle_daemon.py |
| `AZURE_SPEECH_KEY` | No | — | oracle_daemon.py |
| `AZURE_SPEECH_REGION` | No | — | oracle_daemon.py |
| `REALM_PORT` | No | `80` | map_server.py |
| `REALM_DOMAIN` | No | — | map_server.py |

## Build System

esbuild bundles `src/main.js` → `realm-map.js` (IIFE, ES2020, sourcemaps).

- `npm run build` — minified + splash to dist/
- `npm run watch` — watch mode, non-minified
- Injects `__REALM_VERSION__` — magic name from git hash
- Web Workers (`layout-worker.js`, `topo-worker.js`) are NOT bundled — edit directly
- Plugin frontend assets are loaded directly from `plugins/<name>/panel.{js,html,css}`
  at runtime — they are NOT part of the esbuild bundle

## Database Schema (`realm.db`)

| Table | Purpose |
|-------|---------|
| `settings` | Key-value per namespace |
| `events` | Timestamped realm events |
| `personas` | Per-node persona data |
| `nodes` | Topology nodes with positions |
| `connections` | Node-to-node connections |
| `regions` | 7 biome map regions |
| `quests` | Quest log |
| `notion_synced` | Notion sync state |
| `wifi_scans` | WiFi scan history |
| `sub_entities` | Discovery-engine sub-entities |
| `discovery_links` | Edges between sub-entities and topology nodes |
| `discovery_capabilities` | Provider capability declarations |

## Specs Not Yet Implemented

Things documented as part of the project's contract but not exercised yet —
flag these clearly when working in adjacent areas:

| Spec | Status | Notes |
|------|--------|-------|
| Plugin `<name>.service` systemd files | unused | `plugins/README.md` shows `.service` as part of the plugin file structure; no plugin currently ships one |
| `standalone` plugin type | spec only | Listed in the type table; integrated is the only lifecycle currently exercised |
| `on-demand` plugin type | spec only | Same — reserved but unused |
| Per-plugin backend migration | in progress | Backends like `ha_bridge.py` still live at repo root |
| VLAN 9 (VPN Exit, WireGuard) | planned | Marked "planned" in README VLAN registry |

## Key Design Decisions

- **Thin core, fat plugins.** Every domain feature is a plugin.
- **`engine.py` is the single source of truth.** Never duplicate its logic.
- **Server-side sublabels.** Pre-computed in `map_server.py`, browser renders ready-made strings.
- **Hash-based SSE dedup.** Only broadcasts on change.
- **Topology refresh is SSE-driven**, not timer-based.
- **Web Workers** for layout and terrain contour computation.
- **6-signal enrichment pipeline** identifies unknown devices (OUI, port probe, HA device_tracker, LLDP, DHCP, hostname heuristics).
- **Write-through pattern** for personas/config — DB + JSON files.
- **No hot reload.** Plugin changes require a server restart.
- **Daemons are off by default.** Foreground via `make dev`; systemd is opt-in.
- **Fantasy theming is core** — maintain the aesthetic when touching frontend code.
- **MCP server is in-tree** at `plugins/mcp/` (fantasy name "The Astral Conduit").
  Launcher is `plugins/mcp/launcher.py` (FastMCP stdio). Each plugin can ship
  a `mcp_tools.py` (a `MCP_TOOLS` list of `(name, fn, description)` tuples);
  the conduit aggregates them at launch. Connect Claude Code via
  `claude mcp add realmwatch ~/Projects/realmwatch/plugins/mcp/launcher.py`.

## Testing

No test framework. Validate by running:

- `make dev` (or `.venv/bin/python3 map_server.py`) — check for import/startup errors AND plugin load log
- Open http://localhost/realm-map.html — verify panels render, SSE stream live, interactions work
- `curl -s http://localhost/status | python3 -m json.tool` — verify API
- `curl -s http://localhost/debug | python3 -m json.tool` — see registered plugins/endpoints
- `make health` — quick health check
