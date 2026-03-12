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
| server.py | MCP stdio (16 tools) | Manages map_server + herald procs |
| engine.py | LitRPGEngine core | Single source of truth |
| map_server.py | HTTP :8777 | /status /events /topology /config /scan /ssh |
| realm_db.py | SQLite (realm.db) | Settings, events, personas, topology, notion |
| oracle_daemon.py | AI oracle daemon | Polls events, calls Azure AI o1/o4-mini |
| realm_herald.py | Voice daemon | TTS announcements, notification layer |
| collectd_reader.py | RRD metrics | /var/lib/collectd (20 hosts) |
| collectd_listener.py | Live metrics | Collectd intake |
| ha_bridge.py | Home Assistant | REST bridge (2036 entities) |
| ap_scanner.py | WiFi scanner | MAC + hostname identity, roaming, auto unknown nodes |
| notion_sync.py | Notion sync | Todo → quest events |
| codex_sync.py | Codex sync | Notion lore database |
| realm-map.html | Frontend HTML | Spellbook, codex, quest log, panels |
| realm-map.css | Frontend styles | 2290 lines |
| src/main.js | Entry point | Import order: topology then app |
| src/app.js | Frontend main | UI init, spellbook, panels, events |
| src/config.js | Constants | World dimensions, perf tiers |
| src/topology.js | Rendering | Node/connection rendering, tips, 90s auto-refresh |
| src/utils.js | Helpers | Format bytes, rates, percentages |
| scripts/ | Setup scripts | Bedrock, Vertex, provider switcher |

## Architecture
```
CLI agents (Claude Code / Gemini / Copilot)
  → stdio → server.py → LitRPGEngine → realm_db

Browser (realm-map.html + future chat/speech)
  → HTTP → gateway.py (FastMCP) → mounts all 3 stdio servers

Daemons: oracle_daemon.py, realm_herald.py (independent)
Data:    collectd → collectd_reader/listener → realm_db
         ha_bridge → Home Assistant REST → realm_db
         ap_scanner → WiFi SSH → realm_db
Config:  ~/.config/azure-chat-assistant/config.json
         ~/.config/speech-to-cli/config.json
         personas.json (oracle model, voice, prompts)
```

## Todo: gateway.py
FastMCP `create_proxy()` + `mount()` — one HTTP port, all 3 MCP servers:
```python
gateway = FastMCP("Realm Gateway")
gateway.mount(create_proxy("server.py"), namespace="realm")
gateway.mount(create_proxy({...azure-chat-assistant...}), namespace="chat")
gateway.mount(create_proxy({...speech-to-cli...}), namespace="speech")
gateway.run(transport="streamable-http", host="0.0.0.0", port=8001)
```
- Needs FastMCP 3.0+ (`pip install fastmcp`)
- Dev: `fastmcp run gateway.py --reload --transport streamable-http --port 8001`
- Browser tools get namespace prefixes: `realm_get_system_status`, `chat_chat`, etc.

## Todo: Frontend chat + speech
Plain fetch + vanilla JS in existing src/ modules. No frameworks — keep it simple.
```
src/chat.js    # fetch → gateway :8001 chat_* tools, append responses to DOM
src/speech.js  # fetch → gateway :8001 speech_* tools, Web Audio for playback
```
Considered Datastar (hypermedia/SSE) but overkill for 2-3 panels.
Considered React but wrong fit — map is game-like (vanilla JS), panels are too simple.
Considered Gun.js for sync but single-user/single-server, no peer conflict to solve.
