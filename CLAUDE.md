# LitRPG Network — Claude Code Brief

Personal homelab project. Fantasy-themed network monitor + AI voice assistant.
Single machine, local dev. Most of this is already built and working.

## Rules
- engine.py is the single source of truth for all logic — never duplicate it
- topology.json is the single source of truth for nodes/connections (in .claudeignore — use MCP tools to query, don't read directly)
- personas.json managed via MCP configure_persona (in .claudeignore)
- realm.db is live data — never drop tables or delete
- realm-map.js is BUILT output — edit src/*.js then `npm run build`
- server.py is stable — bug fixes and tool additions only, never restructure
- gateway.py is a proxy only — no logic of its own
- Wrap existing MCP servers via create_proxy() before ever rewriting them
- streamable-http transport for new FastMCP servers (SSE is legacy in 3.0)
- azure-ai-inference SDK deprecated May 2026 — use openai SDK instead

## Build
```bash
npm run build              # esbuild src/main.js → realm-map.js
./venv/bin/python3 server.py   # MCP stdio server (requires venv)
python3 map_server.py          # HTTP :8777 frontend
python3 oracle_daemon.py --no-voice  # AI oracle daemon
```

## Files
| File | Role | Notes |
|------|------|-------|
| server.py | MCP stdio (19 tools) | Manages map_server + herald procs |
| engine.py | LitRPGEngine core | Single source of truth |
| map_server.py | HTTP :8777 | /status /events /topology /config /scan /ssh /latency /firewall |
| sse_broker.py | SSE event stream | Pushes collectd + latency + events to browser |
| realm_db.py | SQLite (realm.db) | Settings, events, personas, topology, notion |
| oracle_daemon.py | AI oracle daemon | Polls events, calls Azure AI o1/o4-mini |
| realm_herald.py | Voice daemon | TTS announcements, notification layer |
| collectd_reader.py | RRD metrics | /var/lib/collectd (20 hosts), ping/drop/stddev |
| collectd_listener.py | Live metrics | Collectd intake |
| ha_bridge.py | Home Assistant | REST poll bridge, entity→node sublabels |
| firewall_parser.py | nftables parser | Parses gatekeeper nft JSON, zone→VLAN mapping |
| latency_prober.py | fping prober | Background latency + subnet estimation |
| ap_scanner.py | WiFi scanner | MAC + hostname identity, roaming, auto unknown nodes |
| event_generator.py | Event synthesis | Fantasy-themed event generation |
| node_roles.py | Node role config | HA entity→node mapping, role definitions |
| notion_sync.py | Notion sync | Todo → quest events |
| codex_sync.py | Codex sync | Notion lore database |
| wled_bridge.py | WLED control | LED strip integration |
| chat_bridge.py | Chat bridge | Azure chat session management |
| traffic_precompute.py | Traffic calc | Precomputes traffic stats from collectd |
| realm-map.html | Frontend HTML | Spellbook, codex, quest log, panels |
| realm-map.css | Frontend styles | ~4300 lines |
| src/main.js | Entry point | Import order: topology then app |
| src/app.js | Frontend main | UI init, spellbook, panels, SSE, firewall |
| src/panel-manager.js | Panel system | Drag, dock, seal modes, formations, anchors |
| src/config.js | Constants | World dimensions, perf tiers |
| src/topology.js | Rendering | Node/connection rendering, tips, 90s auto-refresh |
| src/utils.js | Helpers | Format bytes, rates, percentages |
| scripts/ | Setup scripts | Bedrock, Vertex, provider switcher |

## Frontend Panels
firewall, quest-log, codex, node-info, energy, latency, traffic, chat
Seal modes: dock (bottom tray), anchored (draggable runes), conjured (orbit constellation), hidden
Panel manager settings: auto-snap, show-anchors (toggles in Spellbook Enchant tab)

## Architecture
```
CLI agents (Claude Code / Gemini / Copilot)
  → stdio → server.py → LitRPGEngine → realm_db

Browser (realm-map.html)
  → HTTP → map_server.py :8777
    GET  /status /topology /config /settings /energy /personas /debug
    GET  /latency /firewall /scan /scan/status /scan/wifi /chat/sessions
    POST /event /chat/clear /personas /config /settings /node /connections
    POST /topology /ssh /wol /notion-complete /reset
    SSE  /events (collectd rates, latency, map events)

Future: gateway.py (FastMCP) → mounts realm + chat + speech on :8001

Daemons: oracle_daemon.py, realm_herald.py (independent)
Data:    collectd → collectd_reader/listener → realm_db → SSE
         ha_bridge → Home Assistant REST → node sublabels
         ap_scanner → WiFi SSH → realm_db
         latency_prober → fping → SSE
         firewall_parser → gatekeeper nft SSH → /firewall (60s cache)
Config:  ~/.config/azure-chat-assistant/config.json
         ~/.config/speech-to-cli/config.json
         personas.json (oracle model, voice, prompts)
```

## Network
- Gatekeeper (OpenWrt): fw4 zones → VLANs: admin→6, iot→8, lan→10, family→11
- HP switch at 10.0.6.103
- SSH hop: katana → gatekeeper for nft/router commands

## Todo: gateway.py
FastMCP `create_proxy()` + `mount()` — one HTTP port, all 3 MCP servers:
```python
gateway = FastMCP("Realm Gateway")
gateway.mount(create_proxy("server.py"), namespace="realm")
gateway.mount(create_proxy({...azure-chat-assistant...}), namespace="chat")
gateway.mount(create_proxy({...speech-to-cli...}), namespace="speech")
gateway.run(transport="streamable-http", host="0.0.0.0", port=8001)
```

## Todo: Frontend chat + speech
Plain fetch + vanilla JS in existing src/ modules. No frameworks.
```
src/chat.js    # fetch → gateway :8001 chat_* tools
src/speech.js  # fetch → gateway :8001 speech_* tools, Web Audio
```
