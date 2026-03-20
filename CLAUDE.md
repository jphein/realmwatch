# Realmwatch — Claude Code Brief

Personal homelab project. Realmwatch: fantasy-themed network monitor + AI voice assistant.
Single machine, local dev. Most of this is already built and working.

## Rules
- engine.py is the single source of truth for all logic — never duplicate it
- topology.json is the single source of truth for nodes/connections (in .claudeignore — use HTTP API to query, don't read directly)
- personas.json managed via POST /personas (in .claudeignore)
- realm.db is live data — never drop tables or delete
- realm-map.js is BUILT output — edit src/*.js then `npm run build`
- map_server.py is the standalone HTTP server — all endpoints live here
- azure-ai-inference SDK deprecated May 2026 — use openai SDK instead

## Build
```bash
npm run build              # esbuild src/main.js → realm-map.js
python3 map_server.py          # HTTP :8777 (standalone, all endpoints)
python3 oracle_daemon.py --no-voice  # AI oracle daemon
```

## Files
| File | Role | Notes |
|------|------|-------|
| engine.py | RealmEngine core | Single source of truth |
| map_server.py | HTTP :8777 | All endpoints, herald management |
| sse_broker.py | SSE event stream | Pushes collectd + latency + events to browser |
| realm_db.py | SQLite (realm.db) | Settings, events, personas, topology, notion |
| oracle_daemon.py | AI oracle daemon | Polls events, calls Azure AI o1/o4-mini |
| realm_herald.py | Voice daemon | TTS announcements, notification layer |
| collectd_reader.py | RRD metrics | /var/lib/collectd (20 hosts), ping/drop/stddev |
| collectd_listener.py | Live metrics | Collectd intake |
| ha_bridge.py | Home Assistant | REST poll bridge, device registry, entity→node sublabels |
| firewall_parser.py | nftables parser | Parses gatekeeper nft JSON, zone→VLAN mapping |
| latency_prober.py | fping prober | Background latency + subnet estimation |
| ap_scanner.py | WiFi scanner | MAC + hostname identity, roaming, LLDP, auto unknown nodes |
| event_generator.py | Event synthesis | Fantasy-themed event generation |
| node_roles.py | Node role config | 6-signal enrichment pipeline, role definitions |
| notion_sync.py | Notion sync | Todo → quest events |
| codex_sync.py | Codex sync | Notion lore database |
| wled_bridge.py | WLED control | LED strip integration |
| chat_bridge.py | Chat bridge | Azure chat session management |
| traffic_precompute.py | Traffic calc | Precomputes traffic stats from collectd |
| system_persona.txt | Persona prompt | The System persona text (Access to Power) |
| splash.html | Splash page | realm.watch landing page, links to realm-map.html |
| realm-map.html | Frontend HTML | Spellbook, codex, quest log, panels |
| realm-map.css | Frontend styles | ~4300 lines |
| src/main.js | Entry point | Import order: topology then app |
| src/app.js | Frontend main | UI init, spellbook, panels, SSE, firewall |
| src/panel-manager.js | Panel system | Drag, dock, seal modes, formations, anchors |
| src/config.js | Constants | World dimensions, perf tiers |
| src/topology.js | Rendering | Node/connection rendering, tips, 90s auto-refresh |
| src/utils.js | Helpers | Format bytes, rates, percentages |
| scripts/ | Setup + ops scripts | Bedrock/Vertex/provider switcher, AP audit/migrate/VLAN/firewall, realm-health |

## Navigation

| Task | File |
|------|------|
| Speech bubbles / quest events | src/quest-log.js |
| Tooltip content or node sublabels | src/node-status.js |
| Pan/zoom, touch, node drag | src/map-view.js |
| Traffic animation / connection SVG | src/traffic.js |
| Latency / firewall / WiFi / census panels | src/panels.js |
| Persona editor (properties/stats tabs) | src/persona-editor.js |
| Node control/group/shell/chat | src/node-controls.js |
| Spellbook controls / realm search | src/spellbook.js |
| Panel layout / settings / drag | src/layout.js |
| Biome terrain / heightmap | src/terrain.js |
| Motes / sparkles / FPS loop | src/effects.js |
| Debug panel / herald / arcane config | src/debug.js |
| Survey Glass scan runner panel | src/scan.js (existing) |
| SSE connection / event dispatch | src/app.js (residual) |

## Frontend Panels
firewall, quest-log, codex, node-info, energy, latency, traffic, chat
Seal modes: dock (bottom tray), anchored (draggable runes), conjured (orbit constellation), hidden
Panel manager settings: auto-snap, show-anchors (toggles in Spellbook Enchant tab)

## Architecture
```
Browser (realm-map.html)
  → HTTP → map_server.py :8777
    GET  / (splash.html) /realm-map.html (main app)
    GET  /status /topology /config /settings /energy /personas /debug
    GET  /latency /firewall /scan /scan/status /scan/wifi /chat/sessions
    GET  /collectd /observation /herald
    POST /event /chat/clear /personas /config /settings /node /connections
    POST /topology /ssh /wol /notion-complete /reset
    SSE  /events (collectd rates, latency, map events)

CLI agents (Claude Code / Gemini / Copilot)
  → HTTP → map_server.py :8777 (same endpoints)

Daemons: oracle_daemon.py, realm_herald.py (independent)
Data:    collectd → collectd_reader/listener → realm_db → SSE
         ha_bridge → Home Assistant REST + device registry → node sublabels
         ap_scanner → WiFi SSH + LLDP → realm_db
         latency_prober → fping → SSE
         firewall_parser → gatekeeper nft SSH → /firewall (30s cache)
Config:  ~/.config/azure-chat-assistant/config.json
         ~/.config/speech-to-cli/config.json
         personas.json (oracle model, voice, prompts)
```

## Domain
- **realm.watch** — primary domain, Cloudflare Registrar + DNS
- Zone ID: b38f6724fe14bd6d3c7ee325d567a704
- API token in `.env` as `CF_API_TOKEN` / `CF_ACCOUNT_ID`
- Manage DNS: `curl -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records`

## Network
- Gatekeeper (OpenWrt): fw4 zones → VLANs: admin→6, iot→8, lan→10, family→11
- HP switch at 10.0.6.103
- SSH hop: katana → gatekeeper for nft/router commands

## Todo: Frontend chat + speech
Plain fetch + vanilla JS in existing src/ modules. No frameworks.
```
src/chat.js    # fetch → :8777 chat endpoints
src/speech.js  # fetch → speech-to-cli, Web Audio
```
