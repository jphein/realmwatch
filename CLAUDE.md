# Realmwatch — Claude Code Brief

Fantasy-themed homelab network monitor + AI voice assistant. Visualizes 12 VLANs, 130+ nodes, collectd metrics, firewall rules, WiFi roaming, Home Assistant devices, and energy data on an interactive SVG map with high-fantasy theming. Single machine, local dev. Most of this is already built and working.

## Rules

- engine.py is the single source of truth for all logic — never duplicate it
- topology.json is the single source of truth for nodes/connections (in .claudeignore — use HTTP API to query, don't read directly)
- personas.json managed via POST /personas (in .claudeignore)
- realm.db is live data — never drop tables or delete
- realm-map.js is BUILT output — edit src/*.js then `npm run build`
- map_server.py is the standalone HTTP server — all endpoints live here
- openai SDK (2.29.0) for Azure AI — azure-ai-inference SDK migration is complete

## Tech Stack

- **Python 3.12** (venv at `./venv/`): stdlib `http.server` + ThreadingMixIn, psutil, openai, httpx, notion-client, python-dotenv
- **JavaScript**: vanilla ES2020 modules, bundled by esbuild 0.27.3 (IIFE format)
- **Database**: SQLite (realm.db) with WAL mode — settings, events, personas, topology, quests, WiFi scans
- **Data sources**: collectd RRD (`/var/lib/collectd/rrd/`), collectd UDP (port 25826), Home Assistant REST API, SSH to OpenWrt APs, fping latency probing, nftables JSON parsing, WLED HTTP API, Notion API
- **Frontend**: Single-page SVG map app — no frameworks, no React, no build-time CSS — plain fetch + vanilla JS

## Quick Start

```bash
make install              # pip install -r requirements.txt && npm install
npm run build             # esbuild src/main.js → realm-map.js (minified IIFE)
npm run watch             # watch mode (non-minified, auto-rebuild)
python3 map_server.py     # HTTP :80 (all endpoints + background daemons)
python3 oracle_daemon.py --no-voice   # AI oracle
python3 realm_herald.py               # Voice herald

# Makefile shortcuts
make dev                  # python3 map_server.py
make build                # npm run build
make oracle               # python3 oracle_daemon.py --no-voice
make herald               # python3 realm_herald.py
make health               # ./scripts/realm-health.sh
make clean                # remove __pycache__, .pyc, node_modules/.cache
```

### systemd

```bash
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now realm-map-server
```

Three service files in `systemd/`: `realm-map-server.service`, `oracle-daemon.service`, `realm-herald.service`.

## Architecture

```
Browser (realm-map.html)
  → HTTP → map_server.py :80
    Static: / (splash.html) /realm-map.html (main app) /codex/ (lore wiki)
    API:   GET + POST endpoints (see full list below)
    SSE:   /sse (status, traffic, energy, latency, firewall, wifi, topology, events)

Background threads (started by map_server.py on boot):
  SSEBroker       — 5s collect loop, hash-dedup, push to all connected browsers
  ap_scanner      — 90s WiFi scan cycle (SSH to APs + gatekeeper DHCP)
  ha_bridge       — 30s Home Assistant entity state poll
  wled_bridge     — 30s WLED device poll
  event_generator — 120s threshold monitoring (CPU, memory, disk, temp, load)
  latency_prober  — 30s fping batch probe (all wired topology nodes)

Independent daemons:
  oracle_daemon.py  — polls /events for oracle_query, calls Azure AI, posts responses
  realm_herald.py   — picks 2 interesting nodes per round, posts themed speech events
  realm_launcher.py — port 8899, branch-switching portal + map_server restart

Data flow:
  collectd RRD → collectd_reader.py → /status, /collectd
  collectd UDP :25826 → collectd_listener.py → live metrics for remote hosts
  Home Assistant REST → ha_bridge.py → node sublabels, device enrichment
  gatekeeper SSH → ap_scanner.py → WiFi signal, DHCP identity, LLDP topology
  gatekeeper SSH → firewall_parser.py → nftables zone/VLAN data (30s cache)
  fping → latency_prober.py → per-node RTT map
  Notion API → notion_sync.py → quest events
  Notion API → codex_sync.py → lore database
```

## Source Files

### Python (backend)

| File | Lines | Role |
|------|------:|------|
| map_server.py | 1373 | HTTP :80 server — all endpoints, herald management, SSE wiring, static file serving |
| ap_scanner.py | 1246 | WiFi scanner — SSH to APs, DHCP identity, LLDP topology, unknown node auto-creation |
| realm_launcher.py | 1161 | Realm launcher — port 8899, branch switching portal, map_server restart/status |
| node_roles.py | 946 | Node role config — 30+ roles, 6-signal enrichment pipeline, OUI lookup |
| realm_db.py | 867 | SQLite — settings, events, personas, topology, quests, WiFi scans, player XP |
| ha_bridge.py | 626 | Home Assistant bridge — REST poll, entity→node sublabels, device enrichment |
| engine.py | 454 | RealmEngine core — psutil sensors, Tailscale mesh, nft counters, fantasy translations |
| firewall_parser.py | 365 | nftables parser — gatekeeper JSON, zone→VLAN mapping, suggestions |
| collectd_reader.py | 317 | RRD reader — load, memory, uptime, interfaces, ping, disk, swap, processes |
| realm_herald.py | 314 | Voice daemon — picks interesting nodes, themed templates, speech events |
| latency_prober.py | 292 | fping prober — batch-pings wired nodes every 30s |
| chat_bridge.py | 281 | Azure AI chat — session-based, shared DB with azure-chat-assistant MCP |
| oracle_daemon.py | 271 | AI oracle daemon — polls for queries, calls Azure AI, posts speech responses |
| event_generator.py | 266 | Event synthesis — collectd/HA thresholds, fantasy-themed alerts with cooldown |
| collectd_listener.py | 266 | Live metrics — UDP 25826 binary protocol parser |
| sse_broker.py | 246 | SSE event stream — hash-based change detection, client push with burst replay |
| notion_sync.py | 178 | Notion sync — Today todos → quest events |
| wled_bridge.py | 161 | WLED control — polls devices, set state via /json |
| generate-icons.py | 113 | Icon generation |
| traffic_precompute.py | 107 | Traffic calc — hostname matching, log-scale intensity |
| codex_sync.py | 104 | Codex sync — Notion lore database |

### JavaScript (frontend — src/)

| File | Lines | Role |
|------|------:|------|
| panel-manager.js | 2345 | Panel system — dock/anchored/conjured/hidden seal modes, drag, formations |
| map-view.js | 1360 | Pan/zoom, touch, node drag — deferred rendering, globe Z-index |
| layout.js | 895 | Panel layout/settings — save/restore, formation system |
| quest-log.js | 895 | Speech bubbles / quest events — event rendering, bubble positions |
| node-controls.js | 868 | Node control/group/shell/chat — SSH terminal, WoL, WLED |
| spellbook.js | 757 | Spellbook controls / realm search — search index, filter, enchant tab |
| topology.js | 737 | Node/connection SVG rendering — tips, SSE-driven refresh |
| debug.js | 593 | Debug panel / herald / arcane config |
| persona-editor.js | 513 | Persona editor — properties/stats tabs, voice selector |
| panels.js | 502 | Latency / firewall / WiFi / census / energy panels |
| terrain.js | 488 | Biome terrain / heightmap — contour rendering with worker offload |
| skills.js | 479 | Arcane Codex panel — Skills, CLAUDE.md viewer, Hooks, Agents |
| effects.js | 469 | Motes / sparkles / FPS loop — particle system |
| node-status.js | 427 | Tooltip content / node sublabels — status update cycle |
| scan.js | 408 | Survey Glass scan runner — AP WiFi scan, LLDP scan |
| app.js | 325 | App coordinator — SSE dispatch, module wiring |
| theme-forest.js | 302 | Enchanted Forest theme — ambient particles |
| traffic.js | 297 | Traffic animation — connection SVG dash animation |
| main.js | 90 | Entry point — loading screen stages |
| config.js | 37 | Constants — world dimensions (4800x3300), perf tiers |
| utils.js | 34 | Helpers — scale labels, format bytes/rates |

### Workers / HTML / CSS

| File | Lines | Role |
|------|------:|------|
| layout-worker.js | 1239 | Web Worker — force-directed + BFS tree + VLAN cluster layout |
| topo-worker.js | 161 | Web Worker — heightmap stamping, marching squares → SVG contours |
| realm-map.html | 1829 | Frontend HTML — SVG canvas, panel templates, spellbook |
| realm-map.css | 9084 | Frontend styles — panel themes, seal modes, animations |
| splash.html | 836 | Splash page — realm.watch landing |
| wifi-guide.html | 695 | WiFi troubleshooting guide |

## API Endpoints

### GET

| Path | Description |
|------|-------------|
| `/` | Splash page |
| `/realm-map.html` | Main map app |
| `/status` | Full status blob (5s TTL cache) |
| `/topology` | Nodes, connections, regions |
| `/config` | Chat + speech + oracle settings |
| `/settings` | UI settings |
| `/energy` | HA energy data (30s TTL) |
| `/personas` | All persona data |
| `/latency` | fping RTT map |
| `/firewall` | Parsed nftables (30s SSH cache) |
| `/quests` | Quest log data |
| `/events?since=&limit=` | Events since timestamp |
| `/collectd?host=` | collectd summaries |
| `/observation` | Adult Observer analysis |
| `/player` | Player stats — XP, level, achievements |
| `/debug` | DB table counts, size, scan timestamps |
| `/scan` | Trigger WiFi AP scan |
| `/scan/status` | Last scan result |
| `/scan/lldp` | LLDP ethernet topology |
| `/scan/wifi` | WiFi signal data |
| `/wifi/aps` | Per-AP client lists |
| `/ping/<ip>` | Ping specific IP |
| `/ping` | Server timestamp |
| `/server-info` | Server metadata |
| `/notion-sync?force=1` | Trigger Notion quest sync |
| `/codex-sync?force=1` | Trigger codex sync |
| `/codex/` | Lore wiki |
| `/herald?action=` | Herald control (status/start/stop/once) |
| `/chat/sessions` | List chat sessions |
| `/chat/history?session=` | Chat history |
| `/scripts` | List scripts/ with descriptions |
| `/skills` | List .claude/skills/ |
| `/claude-md` | CLAUDE.md as JSON |
| `/agents` | List agent definitions |
| `/hooks` | Settings.json hooks |
| `/resolve-url?hostname=&ip=` | Probe for best reachable URL |
| `/reset` | Clear settings + redirect |
| `/sse` | SSE event stream |

### POST

| Path | Description |
|------|-------------|
| `/chat` | Send chat message → Azure AI |
| `/chat/clear` | Clear chat session |
| `/event` | Push realm event |
| `/personas` | Update persona |
| `/config` | Update config |
| `/settings` | Save UI settings |
| `/node` | Create/update/delete node |
| `/connections` | Replace all connections |
| `/topology` | Bulk update |
| `/quest-create` | Create quest |
| `/quest-update` | Update quest status |
| `/quest-delete` | Delete quest |
| `/player/reward` | Grant XP reward |
| `/notion-complete` | Complete Notion todo |
| `/ssh` | Remote SSH command |
| `/wol` | Wake-on-LAN |
| `/wled/<node_id>/state` | WLED control |
| `/skills` | Save a skill |
| `/claude-md` | Save CLAUDE.md |

## SSE Event Types

| Event | Frequency | Content |
|-------|-----------|---------|
| `status` | 10s | Sensors, collectd, WiFi, HA, sublabels |
| `traffic` | 5s | Per-node traffic intensity |
| `topology` | 60s | Full topology |
| `energy` | 30s | Solar, battery, grid |
| `latency` | 30s | Pre-grouped latency data |
| `firewall` | 60s | Parsed nftables |
| `wifi` | 120s | AP client lists and signal data |
| `realm-event` | live | Individual events |

Initial burst on connect: topology → traffic → energy → latency → recent events → status.

## Environment Variables

See `.env.example`. map_server.py auto-loads `.env` on startup.

| Variable | Required | Default | Used by |
|----------|----------|---------|---------|
| `HA_TOKEN` | Yes (for HA) | — | ha_bridge.py |
| `HA_URL` | No | `https://10.0.6.108:8123` | ha_bridge.py |
| `NOTION_TOKEN` | Yes (for quests) | — | notion_sync.py, codex_sync.py |
| `NOTION_DATABASE_ID` | Yes (for quests) | — | notion_sync.py |
| `AZURE_AI_API_KEY` | Yes (for chat) | — | chat_bridge.py |
| `AZURE_AI_ENDPOINT` | Yes (for chat) | — | chat_bridge.py |
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

## Database Schema (realm.db)

| Table | Purpose |
|-------|---------|
| settings | Key-value per namespace |
| events | Timestamped events |
| personas | Per-node persona data |
| nodes | Topology nodes with positions |
| connections | Node-to-node connections |
| regions | Map regions (7 biome groupings) |
| quests | Quest log |
| notion_synced | Notion sync state |
| wifi_scans | WiFi scan history |

## Key Design Decisions

- **No MCP server in this project.** MCP refs in requirements.txt are for the separate lit-rpg-fantasy-voice server.
- **Server-side sublabels.** Pre-computed in map_server.py, browser gets ready-to-render strings.
- **Hash-based SSE dedup.** Only broadcasts when data changes.
- **Topology refresh is SSE-driven**, not timer-based.
- **Web Workers** for layout and terrain computation.
- **6-signal enrichment pipeline** identifies unknown devices.
- **Write-through pattern** for personas/config (DB + JSON files).
- **Fantasy theming is core** — maintain the aesthetic when touching frontend code.

## Testing

No test framework. Validate by running:
- `python3 map_server.py` — check for import/startup errors
- Open http://localhost/realm-map.html — verify panels, SSE, interactions
- `curl http://localhost/status | python3 -m json.tool` — verify API
- `make health` — quick health check
