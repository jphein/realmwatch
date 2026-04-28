# Realmwatch

A live, interactive fantasy-themed monitor for a homelab. Hardware sensors,
network nodes, system metrics, firewall zones, WiFi roaming, Home Assistant
devices, and energy data are mapped to high-fantasy archetypes on a hand-painted
SVG realm map. An AI oracle, voice herald, and per-node personas give every
device a name, a role, and a voice.

- **Map**: pan/zoom SVG canvas with ~130 nodes across 12 VLANs, animated
  traffic, terrain contours, biome regions, and drag-to-arrange layout.
- **Panels**: 30+ dockable/conjurable panels (census, latency, firewall, WiFi,
  scan, spellbook, quest log, codex, chat, debug) — all delivered by plugins.
- **Voice**: Azure AI oracle for node Q&A; a herald daemon narrates interesting
  events through Azure TTS personas.
- **Plugins**: the whole feature surface is a plugin system. 33 plugins today,
  covering data sources, UI panels, discovery providers, and integrations.
- **Desktop themes**: the Gem Treasury palette extends beyond the web app to
  theme the full GNOME desktop (shell, GTK, terminals, dock, extensions).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser — realm-map.html (SVG canvas, 30+ panels, SSE consumer)     │
│   src/*.js → esbuild IIFE bundle → realm-map.js                     │
│   plugins/<name>/panel.{js,html,css} loaded at runtime              │
└─────────────────────────────────────────────────────────────────────┘
                                │ HTTP + SSE
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ map_server.py :80    (stdlib http.server + ThreadingMixIn)          │
│   ├── Static:  / (splash)  /realm-map.html  /codex/  /plugins/<…>   │
│   ├── API:     /status /topology /personas /settings /events …      │
│   ├── SSE:     /sse  (status, traffic, energy, latency, firewall,   │
│   │                   wifi, topology, plugin-broadcast, events)     │
│   ├── Core:    engine.py  realm_db.py  sse_broker.py                │
│   │            discovery_engine.py  route_table.py  node_roles.py   │
│   └── Plugins: plugin_loader.py  plugin_registry.py  plugin_context │
│                ↓  topological sort on depends_on                    │
│                ↓  setup(ctx) for every integrated plugin            │
│                ↓  hooks: endpoints, SSE sources, enrichers,         │
│                   discovery providers, background threads           │
└─────────────────────────────────────────────────────────────────────┘
                │                              │
                ▼                              ▼
   Independent daemons               Discovery providers
   (separate processes)              (pluggable, per-host)
   ─────────────────────             ────────────────────
   oracle_daemon.py                  netdata · snmp · docker
   realm_herald.py                   kvm · systemd · nmap
   realm_launcher.py :8899           ha · caddy · github · …
```

**Core principle — "thin core, fat plugins":** the bundled frontend is a
rendering engine (panel-manager, map-view, topology, terrain, effects, traffic,
quest-log, spellbook, SVG globe). Every domain panel — census, latency,
firewall, WiFi scan, skills, debug, herald, chat — is a plugin that registers
itself at server start.

**Core principle — "engine.py is the single source of truth":** all realm logic
(sensor readings, Tailscale mesh, nft counters, fantasy translations) lives in
`engine.py`. Other files may call into it, never duplicate it.

---

## Plugin System

The whole backend + UI feature surface is a plugin ecosystem. Plugins live under
`plugins/<name>/` with a `plugin.json` manifest and optional Python, HTML, CSS,
JS, and systemd files.

### Plugin Types

| Type | Lifecycle | Use for |
|------|-----------|---------|
| `integrated` | Loaded in-process by `plugin_loader.py`; `setup(ctx)` called at boot | Data bridges, background scanners, UI panels, discovery providers |
| `standalone` | Separate systemd process; communicates via HTTP | Services that must survive a map_server restart |
| `on-demand` | Invoked by user action as a subprocess | One-shot tools, scripted workflows |

### Loader Contract

`plugin_loader.py` scans `plugins/`, validates each manifest (required fields:
`name`, `version`, `type`; name must match directory), resolves `depends_on` via
topological sort, imports `plugin.py`, and calls `setup(ctx)` with a
`PluginContext`. The context exposes: endpoint registration, SSE source
registration, node enricher hooks, discovery provider registration, shared DB
access, and a per-plugin logger.

### Current Plugins (33)

**UI panels**

| Plugin | Name | Role |
|--------|------|------|
| `census` | Realm Census | Grouped node list with live online/offline status from SSE |
| `chat` | Arcane Dialogue | Session-based Azure AI chat, context-aware node discussions |
| `codex` | Codex | Notion-synced lore wiki served at `/codex/` |
| `debug` | Arcane Mirror + Grimoire + Scrying Terminal | Debug panel, API catalogue, command interface |
| `plugin-manager` | Enchantment Registry | Lists loaded plugins, endpoints, SSE sources, panels |
| `scan` | Survey Glass | On-demand WiFi/LLDP/firewall/oracle triggers |
| `skills` | Inscription Codex | Browse and edit Skills, CLAUDE.md, Hooks, Agents |
| `system-updates` | Scroll of Patch Runes | APT · Snap · Flatpak · mise · brew · npm · pip · firmware · AI CLIs |

**Data bridges**

| Plugin | Role |
|--------|------|
| `collectd` | RRD reader + UDP listener for per-host metric summaries |
| `firewall` | nftables JSON parser — gatekeeper zones, VLAN mapping, counters |
| `ha` | Home Assistant REST poll — entity states, device enrichment, energy |
| `latency` | fping batch prober for wired nodes (30s) |
| `wifi` | SSH to APs — iwinfo clients, DHCP identity, LLDP topology |
| `wled` | WLED HTTP polling + control |
| `notion` | Today todos → quests; archive completed |
| `netdata` | Netdata agent REST — info, charts, alarms, collectors |
| `caddy` | Reverse proxy discovery — Caddyfile / admin API |
| `health` | HTTP/TCP/TLS expiry checks + realm-sigil version probes |
| `alerting` | Realm Herald's Watch — routes events to notification channels |

**Discovery providers** (feed the discovery engine)

| Plugin | Scans |
|--------|-------|
| `discovery` | Companion — registers the engine's API, SSE source, enricher |
| `docker-discovery` | Containers on hosts via SSH |
| `kvm` | KVM/libvirt VMs on hypervisors via `virsh` |
| `systemd` | Interesting services via SSH or local D-Bus |
| `snmp` | Switch ports, interfaces, MAC tables |
| `nmap` | Open ports, service versions, OS fingerprinting |
| `github` | Repos, CI status, PRs via `gh` |
| `projects` | Local `~/Projects/` inventory, git status, stack |
| `manual` | Static infrastructure entries, relationships, tags, bookmarks |

**Daemons / effects / services**

| Plugin | Role |
|--------|------|
| `herald` | Manages the realm-herald subprocess |
| `events` | Threshold monitor — collectd/HA → fantasy-themed alerts |
| `ansible` | Playbook execution / infrastructure management |
| `forest-theme` | Enchanted Forest ambient particle system on the map |
| `game-servers` | Minecraft Bedrock UDP ping, Terraria TCP check |

New features should be plugins. The core bundle should only grow for rendering
or infrastructure changes.

### Specs not yet implemented

A few things are documented as part of the plugin contract but no plugin
currently exercises them. Don't assume "documented" means "battle-tested":

| Spec | Status | Notes |
|------|--------|-------|
| `<plugin>/<name>.service` systemd unit (per `plugins/README.md`) | unused | The plugin file structure allows shipping a unit file; no plugin does today. The 5 unit files in `systemd/` are core, not plugin-shipped. |
| `standalone` plugin type | spec only | Defined in the type table; the integrated lifecycle is what's actually exercised. |
| `on-demand` plugin type | spec only | Same — type is reserved but no plugin uses it. |
| Migrating per-plugin backends into plugin dirs | in progress | Files like `ha_bridge.py`, `ap_scanner.py`, etc. still live at repo root and are imported by their plugins from there. |

---

## Source Tree

### Python — core (not a plugin)

| File | Lines | Role |
|------|------:|------|
| `map_server.py` | 1827 | HTTP :80, endpoint router, plugin wiring, SSE broker, static files |
| `realm_db.py` | 1088 | SQLite — settings, events, personas, nodes, connections, regions, quests, scans, player |
| `engine.py` | 454 | RealmEngine — sensors, Tailscale mesh, nft counters, fantasy translations |
| `plugin_loader.py` | 374 | Discovery, manifest validation, dependency sort, lifecycle |
| `plugin_context.py` | 357 | The `PluginContext` API exposed to `setup(ctx)` |
| `plugin_registry.py` | 198 | Registry of loaded plugins, panels, endpoints |
| `sse_broker.py` | 316 | Hash-deduped SSE fanout + burst replay on connect |
| `node_roles.py` | 946 | 30+ role definitions, 6-signal enrichment pipeline, OUI lookup |
| `realm_launcher.py` | 1187 | Port 8899 — branch-switching portal and map_server restart |
| `oracle_daemon.py` | 303 | Polls events for `oracle_query`, calls Azure AI, posts responses |
| `realm_herald.py` | 315 | Picks interesting nodes, themed templates, speech events |
| `route_table.py` | 141 | Path → handler table |
| `chat_bridge.py` | 290 | Azure AI chat, session-based, shared DB with cloud-chat-assistant |
| `discovery_engine.py` | 658 | Provider registry, scan orchestration, sub-entity linking |

Per-plugin backends (e.g. `ha_bridge.py`, `ap_scanner.py`, `collectd_reader.py`,
`collectd_listener.py`, `firewall_parser.py`, `latency_prober.py`,
`event_generator.py`, `notion_sync.py`, `codex_sync.py`, `wled_bridge.py`,
`traffic_precompute.py`) live at the repo root for now and are invoked by their
respective plugins. The intent is to migrate them into each plugin's directory.

### Frontend — bundled core (`src/`, ~14k lines)

| File | Lines | Role |
|------|------:|------|
| `panel-manager.js` | 2593 | Panel system — dock, anchored, conjured, hidden-seal, drag, formations |
| `map-view.js` | 1357 | Pan/zoom, touch, node drag, deferred rendering, globe Z-index |
| `layout.js` | 912 | Panel layout/settings, save/restore, formations |
| `quest-log.js` | 906 | Speech bubbles, event rendering, bubble positions |
| `node-controls.js` | 1075 | SSH terminal, WoL, WLED, per-node shell / chat / controls |
| `spellbook.js` | 761 | Search index, filter, enchant tab |
| `topology.js` | 744 | Node/connection SVG rendering, SSE-driven refresh |
| `persona-editor.js` | 526 | Properties / stats tabs, voice selector |
| `app.js` | 553 | Coordinator — SSE dispatch (including `plugin-broadcast`), module wiring |
| `effects.js` | 510 | Motes, sparkles, FPS loop |
| `terrain.js` | 488 | Biome terrain / heightmap contour rendering (worker offload) |
| `node-status.js` | 452 | Tooltip content, node sublabels, status update cycle |
| `traffic.js` | 331 | Connection SVG dash animation |
| `winbox-wm.js` | 312 | WinBox window manager integration |
| `plugin-api.js` | 205 | `window.RealmAPI` — plugin hooks for SSE, panels, events |
| `main.js` | 90 | Entry point, loading stages |
| `panels.js` | 50 | Gauges (leftover after plugin extraction) |
| `utils.js` / `config.js` | 34 / 37 | Helpers, constants (world 4800×3300) |

### Workers (not bundled — edit directly)

- `layout-worker.js` — force-directed + BFS tree + VLAN cluster layout
- `topo-worker.js` — heightmap stamping, marching squares → SVG contours

### HTML / CSS

- `realm-map.html` (1552) — SVG canvas, panel templates, spellbook
- `realm-map.css` (7349) — panel themes, seal modes, animations
- `splash.html`, `wifi-guide.html`, `report-card.html` — public pages

### Dependencies

- **Python**: stdlib `http.server`, `psutil`, `openai` (Azure AI),
  `notion-client`, `httpx`, `python-dotenv` — pinned in `requirements.txt`
- **JS**: `esbuild` (dev), `winbox` (runtime window manager) — see `package.json`

---

## HTTP API (:80)

Full endpoint list in `CLAUDE.md`. Highlights:

**GET** `/`, `/realm-map.html`, `/codex/`, `/plugins/<name>/panel.*` (static);
`/status`, `/topology`, `/config`, `/settings`, `/personas`, `/energy`,
`/latency`, `/firewall`, `/quests`, `/events`, `/collectd`, `/observation`,
`/player`, `/debug`, `/scan`, `/scan/status`, `/scan/lldp`, `/scan/wifi`,
`/wifi/aps`, `/ping/<ip>`, `/server-info`, `/notion-sync`, `/codex-sync`,
`/herald`, `/chat/sessions`, `/chat/history`, `/scripts`, `/skills`,
`/claude-md`, `/agents`, `/hooks`, `/resolve-url`, `/reset`, `/sse`.

**POST** `/chat`, `/chat/clear`, `/event`, `/personas`, `/config`, `/settings`,
`/node`, `/connections`, `/topology`, `/quest-create`, `/quest-update`,
`/quest-delete`, `/player/reward`, `/notion-complete`, `/ssh`, `/wol`,
`/wled/<node_id>/state`, `/skills`, `/claude-md`.

Plugins register additional endpoints at load time.

### SSE event stream (`/sse`)

| Event | Frequency | Content |
|-------|-----------|---------|
| `status` | 10s | Sensors, collectd, WiFi, HA, sublabels |
| `traffic` | 5s | Per-node traffic intensity (log scale) |
| `topology` | 60s | Full topology (nodes + connections + regions) |
| `energy` | 30s | Solar, battery, grid (HA) |
| `latency` | 30s | Pre-grouped latency by VLAN |
| `firewall` | 60s | Parsed nftables (cached) |
| `wifi` | 120s | AP client lists, signal data |
| `plugin-broadcast` | live | Plugin-dispatched events (routed in `dispatchPluginSSE`) |
| `realm-event` | live | Individual realm events (speech, alert, highlight, quest) |

Initial burst on connect: `topology → traffic → energy → latency → recent
events → status`. Broker uses hash-based dedup — only pushes on change.

---

## Discovery Engine

`discovery_engine.py` orchestrates plugin-registered providers to autodiscover
sub-entities per host.

Role-based provider defaults:

| Role | Providers |
|------|-----------|
| `server` | docker, systemd, netdata |
| `nas` | docker, systemd |
| `vm` | systemd, netdata |
| `hypervisor` | docker, kvm, systemd, netdata |
| `router` | snmp, netdata |
| `switch` / `ap` | snmp |
| `desktop` | systemd |

Discovered sub-entities link back to topology nodes, persist to `realm.db`, and
flow through SSE. The WiFi scanner's unknown-node flow was migrated to the
SubEntity model in `e360baf`.

---

## Quick Start

```bash
make install              # pip + npm
make build                # esbuild src/main.js → realm-map.js (minified IIFE)
make dev                  # python3 map_server.py (starts all plugins)

# Optional daemons
make oracle               # python3 oracle_daemon.py --no-voice
make herald               # python3 realm_herald.py

# Dev loop
npm run watch             # esbuild watch mode (non-minified)
make health               # color-coded health check
make clean                # drop __pycache__, .pyc, npm cache

# Public pages → realm-portal
make deploy               # copies wifi-guide.html, report-card.html
```

### systemd (optional, opt-in)

The default development path is foreground (`make dev`). systemd is opt-in
for unattended operation — none of the realmwatch services run by default.

```bash
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now realm-map-server   # opt in per-unit
```

Five unit files ship in `systemd/`: `realm-map-server`, `oracle-daemon`,
`realm-herald`, `realm-launcher`, `realm-theme-watcher`. Of these, only
`realm-theme-watcher` is enabled by default on the dev host (it watches
`desktop-themes/` and redeploys on dark/light switch — independent of the
map server).

Other realm-* units you may see in `~/.config/systemd/user/` (`realm-ingest`,
`realm-sse-ingest`, `realm-optimizer`, `realm-daily-rite`,
`realm-system-updates-check` and their timers) come from sibling projects
(`realm-optimizer`, the system-updates plugin's deploy step, etc.) — not from
this repo's `systemd/` directory.

### Environment

Copy `.env.example` → `.env`. `map_server.py` auto-loads it.

| Variable | Required for | Default |
|----------|--------------|---------|
| `HA_TOKEN` | Home Assistant bridge | — |
| `HA_URL` | — | `https://10.0.6.108:8123` |
| `NOTION_TOKEN` | Quest + codex sync | — |
| `NOTION_DATABASE_ID` | Quest sync | — |
| `AZURE_AI_API_KEY` | Chat + oracle | — |
| `AZURE_AI_ENDPOINT` | Chat + oracle | — |
| `AZURE_SPEECH_KEY` / `_REGION` | Oracle TTS | — |
| `REALM_PORT` | — | `80` |
| `REALM_DOMAIN` | — | — |

---

## Database (`realm.db`, SQLite WAL)

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

---

## Scripts

### Infrastructure setup

| Script | What it does |
|--------|--------------|
| `scripts/setup-collectd-openwrt.sh` | Install collectd + lldpd on OpenWrt APs (`--all`) |
| `scripts/setup-collectd.sh` | Install collectd on Ubuntu/Debian hosts |
| `scripts/setup-collectd-katana.sh` | Configure collectd on the katana host |
| `setup-collectd-ap.sh` | Deploy WiFi client exec plugin to APs |
| `collectd-wifi-clients.sh` | The exec plugin itself (installed to `/usr/local/bin`) |
| `scripts/setup-ssl-certs.sh` | Generate and install certs |
| `scripts/enable-port80.sh` | Grant Python `cap_net_bind_service` for port 80 |

### AP operations

| Script | What it does |
|--------|--------------|
| `scripts/ap-audit.sh` | Dump SSIDs, VLANs, interfaces, collectd status for all APs |
| `scripts/ap-migrate-ssid.sh` | Move an SSID to a different network across all APs (`--dry-run`) |
| `scripts/ap-add-vlan.sh` | Add a VLAN to one AP — auto-detects DSA vs swconfig |
| `scripts/ap-firewall-check.sh` | Audit gatekeeper fw4 zones, forwarding, custom rules |

### Switch operations (HP V1910)

Comware 5 needs a hidden cmdline-mode unlock and old SSH ciphers — these
expect-driven scripts handle both. Requires `expect` and `sshpass`. See
`docs/runbooks/hp-v1910.md` for the full guide.

| Script | What it does |
|--------|--------------|
| `scripts/switch/switch-audit.exp` | Read-only state capture: VLANs, port hybrid matrix, MAC table, LLDP neighbors, full running-config |
| `scripts/switch/switch-apply-vlan-normalize.exp` | Normalize ports GE1/0/15-28 to PVID=1, VLAN1 untagged, all real VLANs (3-12, 20, 38) tagged; `save force` |
| `scripts/switch/switch-enable-lldp.exp` | Enable LLDP globally and save (idempotent) |

### Claude Code providers

| Script | What it does |
|--------|--------------|
| `scripts/setup-bedrock.sh` | One-time AWS Bedrock auth + env setup |
| `scripts/setup-vertex.sh` | One-time GCP Vertex AI auth + project select |
| `scripts/claude-provider.sh` | Source to switch between `bedrock` / `vertex` / `direct` |

### Utilities

| Script | What it does |
|--------|--------------|
| `scripts/realm-health.sh` | Color-coded status: processes, :80, realm.db, env tokens |
| `scripts/realm-update.sh` | CLI for the Scroll of Patch Runes plugin — APT/Snap/Flatpak/brew/mise/npm/pip/firmware/AI CLIs |
| `scripts/deploy-realm-theme.sh` | Desktop theme deploy helper |
| `scripts/fix-chrome-ssl.sh` | Drop local CA into Chrome's NSS DB |
| `scripts/reset-camera.sh` | USB reset for Razer Kiyo Pro (UVC -71/-110) |

---

## Desktop Themes (`desktop-themes/`)

The Gem Treasury palette extends beyond the web app to the full GNOME desktop.

```bash
./desktop-themes/deploy.sh all           # deploy everything
./desktop-themes/deploy.sh gnome         # shell theme only
./desktop-themes/deploy.sh gtk           # GTK4 + GTK3
./desktop-themes/deploy.sh kitty|ghostty # terminals
```

| Component | Source | Target |
|-----------|--------|--------|
| GNOME Shell (dark + light) | `gnome-shell/` | `~/.local/share/themes/Realm{,-Light}/` |
| Extension manifest + settings | `gnome-extensions/` | dconf |
| GTK4 / libadwaita | `gtk4/` | `~/.config/gtk-4.0/gtk.css` |
| GTK3 | `gtk3/` | `~/.config/gtk-3.0/gtk.css` |
| Text Editor (GtkSourceView 5) | `gnome-text-editor/` | `~/.local/share/gtksourceview-5/styles/` |
| Kitty | `kitty/` | `~/.config/kitty/kitty.conf` |
| Ghostty + glow shader | `ghostty/` | `~/.config/ghostty/` |
| Brave browser theme | `brave/` | Brave user data |
| Navidrome | `navidrome/` | CSS overlay |

`realm-theme-watcher.service` watches the source dirs and redeploys on change.

---

## Network

- **OpenWrt everywhere** — all 12 APs, firewall, backup router (exception: one
  HP managed switch, two bridges running vendor firmware)
- **Gatekeeper** at `10.0.6.3` (OpenWrt 25.12.2, VRRP master — VIP `10.0.6.1`
  via keepalived). Backup router at `10.0.6.4`.
- **Katana** at `10.0.6.129` — this machine, hosts all realm services
- **HP V1910-24G** at `10.0.6.103` — the realm's only Comware-firmware switch.
  24× Gig + 4× SFP, all ports `link-type hybrid`. Ports GE1/0/15-28 are AP/host
  trunks (PVID=1, VLAN1 untagged dead-end, VLANs 3-12, 20, 38 all tagged) per
  the 2026-04-28 normalization. SSH access requires a hidden cmdline-mode
  unlock — see `docs/runbooks/hp-v1910.md` and `scripts/switch/`.
- **13 VLANs** carried across the switch fabric (1, 3-12, 20, 38) — see
  registry below. fw4 zone names on gatekeeper are counterintuitive
  (`lan` = legacy IoT/VLAN 10, `iot` = Guest+IoT/VLAN 8 after the
  2026-04-27 device migration).
- **Tailscale mesh** for remote-node visibility
- **Netdata** is replacing collectd: full agent on Ubuntu + gatekeeper, SNMP
  polling from the Netdata parent for smaller OpenWrt APs

### VLAN Registry

Source of truth: HP V1910 `display vlan all` (capture via
`scripts/switch/switch-audit.exp`).

| VLAN | Label | fw4 Zone | Status | Description |
|-----:|-------|----------|--------|-------------|
| 1 | Default | — | active | Untagged dead-end on every AP/host trunk; safe drop |
| 3 | DSL | — | standby | Backup WAN (DSL/cellular) |
| 4 | Fiber | — | active | Fiber WAN |
| 5 | Mesh | — | active | Mesh uplink |
| 6 | Admin | admin | active | Servers, management, infrastructure (`10.0.6.0/24`) |
| 7 | Test Lab | — | active | Testing and experimentation |
| 8 | Guest/IoT | iot* | active | Guest + smart-device WiFi (post 2026-04-27 IoT migration) |
| 9 | VPN Exit | vpn | planned | WireGuard tunnel to gig exit node |
| 10 | newlan (legacy IoT) | lan* | drained | Mostly empty after IoT migration to VLAN 8 |
| 11 | Family | family | active | Personal devices |
| 12 | Oasisfiber | — | active | Secondary fiber/peering |
| 20 | Attfiber | — | active | AT&T fiber WAN |
| 38 | Treelink WAN | wan | active | Primary internet — fiber + WiFi backup |

---

## Associated Projects

Realmwatch is the flagship of a family of projects under `~/Projects/`. Each
lives in its own repo; pointers here for discoverability.

| Project | Relationship | Notes |
|---------|-------------|-------|
| **os.realm.watch** | RPG layer over realmwatch — 5 FastMCP game servers | `github.com/jphein/os.realm.watch` |
| **realm-portal** | Front door at `realm.watch` — proxies public pages (`wifi-guide.html`, `report-card.html`) | `make deploy` pushes to `~/Projects/realm-portal/static/` |
| **realm-sigil** | Unified `/api/version` + `version.json` for every realm service | Go / Python / JS; realmwatch emits its sigil from `package.json` + git |
| **status.realm.watch** | Status page that pings each realm service's sigil endpoint | Entries added via `checks.json` |
| **realm-optimizer** | AI optimization advisor — surfaces suggestions as realm quests in realmwatch | Writes to `/quest-create` |
| **realmcoin** | Homelab currency with YNAB integration | Shares the fantasy economy |
| **oracle** (Oracle Sanctum) | Standalone voice-first AI oracle — sister project to the in-realm oracle | Shares Azure AI credentials |
| **gnome-speaks** | D-Bus TTS service used by the herald | Python |
| **speech-to-cli** | MCP speech server used by oracle + herald | Azure TTS/STT |
| **disks** | NAS at `10.0.6.120` — Immich, Jellyfin, Navidrome, Vaultwarden | Appears as realm nodes |

---

## Testing & Validation

No test framework. Validate by:

1. `python3 map_server.py` — check for import / startup errors, plugin load log
2. Open `http://localhost/realm-map.html` — panels render, SSE stream live,
   interactions work
3. `curl -s http://localhost/status | python3 -m json.tool`
4. `make health` — quick health check
5. `curl -s http://localhost/plugins/plugin-manager/panel.html` — plugin
   manifest sanity

---

## Key Design Decisions

- **Thin core, fat plugins.** Every domain feature is a plugin.
- **`engine.py` is the single source of truth.** Never duplicate its logic.
- **Server-side sublabels.** Pre-computed in `map_server.py`; browser renders
  ready-made strings.
- **Hash-based SSE dedup.** Only broadcasts on change.
- **Topology refresh is SSE-driven**, not timer-based.
- **Web workers** for layout and terrain contour computation.
- **6-signal enrichment pipeline** identifies unknown devices via OUI, port
  probe, HA device_tracker, LLDP, DHCP, and hostname heuristics.
- **Write-through** for personas and config — DB + JSON files.
- **Fantasy theming is core.** Maintain the aesthetic when touching anything
  user-facing.
- **No MCP server in this project.** MCP-related code belongs to `os.realm.watch`.
