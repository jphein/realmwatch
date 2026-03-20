# Realmwatch

A live, interactive fantasy-themed network monitor for a homelab infrastructure.
Hardware sensors, network nodes, and system metrics are mapped to high-fantasy
archetypes. AI oracle and TTS personas give each node a voice.

## Architecture

```
Browser (realm-map.html)
  pan/zoom map, speech bubbles, quest log, codex, panels, chat
       |
       |  HTTP polls + SSE stream
       v
  map_server.py  :80
  ├── GET  /status /topology /config /settings /energy /personas /debug
  ├── GET  /latency /firewall /scan /scan/wifi /collectd /observation
  ├── GET  /chat/sessions /herald
  ├── POST /event /chat/clear /personas /config /settings /node
  ├── POST /connections /topology /ssh /wol /notion-complete /reset
  └── SSE  /events  (collectd rates, latency, map events — live push)
       |
       +── engine.py           RealmEngine — single source of truth for all logic
       +── realm_db.py         SQLite (realm.db) — nodes, events, settings, personas
       +── sse_broker.py       SSE event stream — collectd + latency + events
       |
  Background scanners (daemon threads, started by map_server):
       +── ap_scanner.py       WiFi roaming, DHCP identity, LLDP topology  [90s]
       +── ha_bridge.py        Home Assistant entity states → node sublabels [30s]
       +── latency_prober.py   fping batch probe of wired nodes              [30s]
       +── collectd_listener.py  UDP 25826 — live collectd push packets
       |
  On-demand (called per-request):
       +── collectd_reader.py  RRD file reader (/var/lib/collectd/rrd)       [5s cache]
       +── firewall_parser.py  nft JSON parser — zone/VLAN data              [30s cache]
       +── node_roles.py       6-signal device enrichment pipeline
       +── traffic_precompute.py  log-scale traffic intensity computation

Independent daemons (separate processes):
  oracle_daemon.py    AI oracle — polls events, calls Azure AI o1/o4-mini
  realm_herald.py     Voice daemon — TTS announcements via speech-to-cli
```

## Components

| File | Role |
|------|------|
| `engine.py` | RealmEngine core — single source of truth for all logic |
| `map_server.py` | HTTP :80 — all endpoints, scanner lifecycle, herald management |
| `sse_broker.py` | SSE event stream — pushes collectd rates, latency, map events |
| `realm_db.py` | SQLite (realm.db) — settings, events, personas, topology, notion |
| `oracle_daemon.py` | AI oracle daemon — polls events, calls Azure AI |
| `realm_herald.py` | Voice daemon — TTS announcements, notification layer |
| `ap_scanner.py` | WiFi scanner — MAC/IP/hostname identity, roaming, LLDP, auto unknown nodes |
| `collectd_reader.py` | RRD file reader — per-host summaries from /var/lib/collectd/rrd |
| `collectd_listener.py` | UDP 25826 listener — live collectd binary protocol parser |
| `ha_bridge.py` | Home Assistant bridge — REST poll, entity states → node sublabels |
| `firewall_parser.py` | nftables parser — gatekeeper nft JSON, zone→VLAN mapping |
| `latency_prober.py` | fping prober — background latency + subnet estimation |
| `node_roles.py` | Node role config — 6-signal enrichment pipeline, role definitions |
| `traffic_precompute.py` | Traffic calc — log-scale intensity, tier, direction flags |
| `collectd_reader.py` | RRD file reader — per-host summaries, 5s cache |
| `event_generator.py` | Event synthesis — fantasy-themed event generation |
| `notion_sync.py` | Notion sync — Todo → quest events |
| `codex_sync.py` | Codex sync — Notion lore database |
| `wled_bridge.py` | WLED control — LED strip integration |
| `chat_bridge.py` | Chat bridge — Azure chat session management |
| `realm-map.html` | Frontend HTML — spellbook, codex, quest log, panels |
| `realm-map.css` | Frontend styles (~4300 lines) |
| `src/main.js` | Frontend entry point — import order: topology then app |
| `src/app.js` | Frontend main — UI init, spellbook, panels, SSE, firewall |
| `src/topology.js` | Rendering — node/connection rendering, tips, 90s auto-refresh |
| `src/panel-manager.js` | Panel system — drag, dock, seal modes, formations, anchors |
| `src/config.js` | Constants — world dimensions, perf tiers |
| `src/utils.js` | Helpers — format bytes, rates, percentages |

> **Build:** `npm run build` — esbuild `src/main.js` → `realm-map.js` (built output, do not edit directly)

## HTTP API (:80)

| Endpoint | Description |
|----------|-------------|
| `GET /status` | Full system status — collectd, latency, WiFi signal, HA states, energy |
| `GET /topology` | Topology JSON — nodes, connections, regions |
| `GET /config` | Frontend config and current settings |
| `GET /settings` | User settings (sliders, toggles, layout) |
| `GET /energy` | Energy/power data |
| `GET /personas` | All node persona configs |
| `GET /collectd` | Collectd RRD summaries (`?host=` optional) |
| `GET /latency` | Pre-grouped latency data by VLAN |
| `GET /firewall` | Parsed nft firewall data — zones, counters, suggestions |
| `GET /scan` | Latest AP scan result — clients, roaming, unknown nodes |
| `GET /scan/status` | Scan daemon status |
| `GET /scan/wifi` | Per-node WiFi signal data from last scan |
| `GET /observation` | Trigger oracle observation narration |
| `GET /herald` | Herald status/control (`?action=status\|start\|stop\|once`) |
| `GET /chat/sessions` | Active chat sessions |
| `GET /debug` | Internal debug info |
| `SSE /events` | Live event stream — collectd rates, latency, speech/alert/highlight |
| `POST /event` | Push event to map (speech bubble / alert / highlight / quest) |
| `POST /chat/clear` | Clear chat history |
| `POST /personas` | Create or update node persona |
| `POST /config` | Update frontend config |
| `POST /settings` | Update user settings |
| `POST /node` | Create or update a node |
| `POST /connections` | Update topology connections |
| `POST /topology` | Replace full topology |
| `POST /ssh` | SSH command to a topology host |
| `POST /wol` | Wake-on-LAN for a node |
| `POST /notion-complete` | Mark a Notion todo as complete |
| `POST /reset` | Reset realm state |

## Backend Scanners

| Script | What it scans | Interval | Key output |
|--------|--------------|----------|------------|
| `ap_scanner.py` | APs via SSH (iwinfo), gatekeeper DHCP leases, lldpctl | 90s | roaming changes, WiFi signal map, unknown nodes, LLDP topo |
| `ha_bridge.py` | Home Assistant /api/states + device registry | 30s | node sublabels, device MAC/IP enrichment index |
| `latency_prober.py` | All wired nodes via fping | 30s | {node_id: rtt_ms} map |
| `collectd_listener.py` | UDP 25826 (collectd push) | continuous | live host metrics |
| `collectd_reader.py` | /var/lib/collectd/rrd files | on-demand (5s cache) | load, mem, iface rates, ping, thermal |
| `firewall_parser.py` | nft JSON from gatekeeper (via map_server SSH) | on-demand (30s cache) | zone counters, blocked IPs, DNS redirect, suggestions |
| `node_roles.py` | OUI lookup, port probe, HA device_tracker, LLDP | on new device | role, icon, label, persona |
| `traffic_precompute.py` | collectd_reader summaries | on-demand | log-scale intensity, tier, direction, animation flags |

## Bash Scripts

### Infrastructure setup (run once per host)
| Script | What it does |
|--------|-------------|
| `scripts/setup-collectd-openwrt.sh` | Install collectd + lldpd on OpenWrt APs (`--all` for all 12) |
| `scripts/setup-collectd.sh` | Install collectd on Ubuntu/Debian hosts (pipe via SSH) |
| `setup-collectd.sh` | Same as above (root copy for backward-compatible pipe usage) |
| `setup-collectd-ap.sh` | Deploy WiFi client exec plugin to APs (after setup-collectd-openwrt) |
| `collectd-wifi-clients.sh` | The exec plugin itself — deployed to /usr/local/bin on each AP |

### AP operations (day-to-day)
| Script | What it does |
|--------|-------------|
| `scripts/ap-audit.sh` | Dump SSID→network, VLAN system, interfaces, collectd status for all APs |
| `scripts/ap-migrate-ssid.sh` | Move an SSID to a different network across all APs (`--dry-run` supported) |
| `scripts/ap-add-vlan.sh` | Add a VLAN to one AP — auto-detects DSA vs swconfig (`--dry-run`) |
| `scripts/ap-firewall-check.sh` | Audit gatekeeper fw4 zones, forwarding rules, custom rules |

### Claude Code provider setup
| Script | What it does |
|--------|-------------|
| `scripts/setup-bedrock.sh` | One-time: install AWS CLI, configure credentials, write ~/.bashrc env vars |
| `scripts/setup-vertex.sh` | One-time: install gcloud, auth, select project, enable Vertex AI API |
| `scripts/claude-provider.sh` | **Source this** to switch between `bedrock`/`vertex`/`direct` |

### Utilities
| Script | What it does |
|--------|-------------|
| `scripts/realm-health.sh` | Color-coded status: processes, :80, realm.db, env tokens |
| `scripts/reset-camera.sh` | USB reset for Razer Kiyo Pro when it hangs (UVC -71/-110 errors) |

## VLAN Registry

| VLAN | Label | fw4 Zone | Status | Description |
|------|-------|----------|--------|-------------|
| 6 | Admin | admin | active | Servers, management, infrastructure |
| 7 | Test Lab | — | active | Testing and experimentation |
| 8 | Guest | iot* | active | Guest WiFi, isolated from all wards |
| 9 | VPN Exit | vpn | planned | WireGuard tunnel to gig exit node |
| 10 | IoT | lan* | active | Smart devices, sensors, automations |
| 11 | Family | family | active | Personal devices, phones, laptops |
| 38 | Treelink WAN | wan | active | Primary internet — fiber + WiFi backup |
| 3 | Backup WAN | — | standby | Emergency DSL/cellular backup |

> **Note:** fw4 zone names are counterintuitive on gatekeeper — `lan`=IoT/VLAN10, `iot`=Guest/VLAN8.

## Quick Start

```bash
# Terminal 1: Map server (starts all background scanners)
python3 map_server.py

# Terminal 2: AI oracle (optional)
python3 oracle_daemon.py --no-voice

# Terminal 3: Voice daemon (optional)
python3 realm_herald.py

# Frontend
http://localhost:80
```

Required env vars:
```bash
export HA_TOKEN="..."          # Home Assistant long-lived access token
export NOTION_TOKEN="..."      # Notion integration token (for quest sync)
export AZURE_API_KEY="..."     # Azure AI for oracle + TTS
```

## Network

- **12 APs** across LAN (OnHub, EA6350, MR8300, EAP225, WNDR4300, woodshed)
- **20+ collectd hosts** pushing metrics to katana:25826 via RRD
- **VLANs**: 10.0.6.x (Admin), 10.0.8.x (Guest), 10.0.10.x (IoT), 10.0.11.x (Family)
- **Tailscale mesh** for remote node visibility
- **Gatekeeper** (OpenWrt, 10.0.6.1): fw4 firewall, DHCP, nftables
- **Katana** (10.0.6.129): this machine, runs all Realm services
