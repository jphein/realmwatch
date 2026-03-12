# LitRPG Network — Claude Code Brief

## What This Is
Personal homelab project. Realm-themed network monitor + AI voice assistant.
Single machine, local dev. Most of this is already built and working.
Read this before touching anything.

## Current State
| Component          | Lines | Status    | Notes                                       |
|--------------------|-------|-----------|---------------------------------------------|
| server.py          | 993   | ✅ Stable  | MCP stdio — DO NOT restructure              |
| map_server.py      | 379   | ✅ Working | Serves realm-map frontend :8777             |
| engine.py          | 477   | ✅ Working | LitRPGEngine — core logic, single source    |
| realm_db.py        | 478   | ✅ Working | SQLite persistence (realm.db)               |
| oracle_daemon.py   | 245   | ✅ Working | AI oracle — polls events, calls Azure AI    |
| realm_herald.py    | 309   | ✅ Working | Voice/notification daemon                   |
| collectd_reader.py | 269   | ✅ Working | RRD metrics from /var/lib/collectd          |
| collectd_listener  | 218   | ✅ Working | Live metrics intake                         |
| ha_bridge.py       | 351   | ✅ Working | Home Assistant REST bridge                  |
| ap_scanner.py      | 310   | ✅ Working | WiFi/AP scanner (MAC-based, SSH pull)       |
| notion_sync.py     | 178   | ✅ Working | Notion todo → quest sync                    |
| codex_sync.py      | 104   | ✅ Working | Codex sync                                  |
| realm-map.html     | 845   | ✅ Working | Frontend UI                                 |
| realm-map.css      | 2290  | ✅ Working | Frontend styles                             |
| src/app.js         | 4040  | ✅ Working | Frontend logic (5 modules, esbuild)         |
| gateway.py         | —     | 🔲 Todo   | FastMCP gateway — all 3 servers on :8001    |

## What Was Already Done (this session)
- Stripped Gemini's 6-tool Magic Morph queue system, replaced with fire-and-forget events
- Built oracle_daemon.py — auto-responds to ?queries from search bar via Azure AI
- Added scrying-pool node to topology (AI oracle, separate from physical "oracle" ubox0)
- Added o1/o3 reasoning model support to azure-chat-assistant MCP server
- Built /config GET/POST endpoints — unified settings for all 3 MCP servers
- Built Arcane Config UI in Spellbook (Oracle, Voice, Scrying Pool settings)
- Converted Spellbook to 4-page book (Enchantments, Cartography, Terrain, Arcane Config)
- Added HA sublabels to map nodes (temps, states, entity counts)
- Set up Claude Code on Amazon Bedrock + Google Vertex AI (scripts/ directory)

---

## Architecture

### Two MCP Transport Modes (BOTH run simultaneously — this is intentional)
```
Claude Code / Gemini CLI / Copilot CLI
  → stdio → server.py → LitRPGEngine → realm_db / tools

Browser (realm-map.html + chat + speech)
  → HTTP → gateway.py (FastMCP) → mounts all 3 stdio servers
```
**Nothing is being replaced. Nothing is being removed.**
- server.py + CLI workflow stays exactly as-is forever
- map_server.py + realm-map.html stays exactly as-is forever
- gateway.py is purely additive — mounts existing servers, no logic of its own
- CLI agents and browser work simultaneously with no context mixing

### Gateway Pattern (FastMCP create_proxy + mount)
```python
# gateway.py — ONE port, ALL 3 MCP servers
from fastmcp import FastMCP
from fastmcp.server import create_proxy

gateway = FastMCP("Realm Gateway")

# Mount all 3 existing stdio servers — zero rewrites
gateway.mount(create_proxy("server.py"), namespace="realm")
gateway.mount(create_proxy({
    "mcpServers": {"default": {"command": "python3",
        "args": [os.path.expanduser("~/Projects/azure-chat-assistant/mcp_chat_assistant.py")]}}
}), namespace="chat")
gateway.mount(create_proxy({
    "mcpServers": {"default": {"command": "python3",
        "args": [os.path.expanduser("~/Projects/speech-to-cli/mcp_speech.py")]}}
}), namespace="speech")

if __name__ == "__main__":
    gateway.run(transport="streamable-http", host="0.0.0.0", port=8001)
```
Browser gets: `realm_get_system_status`, `chat_chat`, `speech_speak`, etc.
Each session is isolated. No context mixing between clients.

### Process Map
```
server.py         stdio    MCP server — CLI agents entry point
map_server.py     :8777    Realm map frontend server
gateway.py        :8001    FastMCP gateway — mounts all 3 MCP servers (todo)
oracle_daemon.py  daemon   Polls /events, calls Azure AI, posts responses
realm_herald.py   daemon   Voice announcements, notification layer
```

### Core Data Flow
```
collectd (hosts) → collectd_reader.py + collectd_listener.py
                 → realm_db.py (SQLite)
                 → LitRPGEngine
                 → server.py (stdio) → CLI agents
                 → gateway.py (HTTP) → browser

ha_bridge.py   → Home Assistant REST API → realm_db.py
ap_scanner.py  → WiFi/AP data via SSH → realm_db.py
topology.json  → 87 nodes, 84 connections → realm-map frontend
personas.json  → 10 node personas → speech/oracle
```

### Config Files (3 MCP servers share these)
```
~/.config/azure-chat-assistant/config.json  — Azure AI endpoint, model, keys
~/.config/speech-to-cli/config.json         — Speech keys, voice, VAD settings
personas.json                                — Oracle model, voice, system prompts
```
Map server reads/writes all three via /config endpoint (safe keys only, no secrets).

---

## Build
```bash
# Frontend — edit src/*.js, then build:
npx esbuild src/app.js --bundle --format=iife --outfile=realm-map.js

# Server — requires venv:
./venv/bin/python3 server.py

# Map server:
python3 map_server.py

# Oracle daemon:
python3 oracle_daemon.py --no-voice
```

---

## File Roles
```
server.py            MCP stdio — 16 tools, manages map_server + herald procs
engine.py            LitRPGEngine — single source of truth for all logic
oracle_daemon.py     Background daemon — polls events, calls Azure AI o1/o3
realm_herald.py      Background daemon — voice announcements
realm_db.py          SQLite interface (realm.db) — live data, never drop tables
map_server.py        HTTP :8777 — /status /events /topology /config /scan /ssh
collectd_reader.py   Reads RRD files from /var/lib/collectd (20 hosts)
collectd_listener.py Live collectd metrics intake
ha_bridge.py         Home Assistant REST API bridge (2036 entities)
ap_scanner.py        WiFi AP scanner — MAC-based identity, roaming detection
notion_sync.py       Notion todo → quest events
codex_sync.py        Codex sync
personas.json        AI persona definitions (10 nodes + scrying-pool oracle)
topology.json        Network graph — 87 nodes, 84 connections, 9 regions
realm.db             SQLite database — DO NOT delete
realm-map.html       Frontend HTML — spellbook, codex, quest log, panels
realm-map.js         BUILT OUTPUT — never edit directly
realm-map.css        Frontend styles (2290 lines)
src/app.js           Frontend main module (imports config, utils, topology)
src/config.js        Constants, world dimensions, perf tiers
src/topology.js      Node/connection rendering, tips, auto-tip generation
src/utils.js         Format helpers (bytes, rates, percentages)
scripts/             Setup scripts (setup-bedrock.sh, setup-vertex.sh, claude-provider.sh)
```

---

## What Still Needs Building

### 1. gateway.py — FastMCP gateway (do this first)
Uses FastMCP `create_proxy()` + `mount()` to expose all 3 existing stdio
MCP servers on one HTTP port. Zero rewrites. See code in Architecture section.
- `pip install fastmcp` (needs FastMCP 3.0+)
- Dev mode: `fastmcp run gateway.py --reload --transport streamable-http --port 8001`
- All 3 servers' tools become available with namespace prefixes
- Each browser session gets isolated backend sessions

### 2. Frontend: chat + speech UI
Extend existing src/ modules — never rebuild realm-map.js from scratch.
Browser talks to gateway.py :8001 which forwards to the real servers.
```
src/chat.js    # Multi-model chat UI → gateway :8001 (namespace: chat_*)
src/speech.js  # Web Speech API (mic) + Web Audio (speaker) → gateway :8001 (namespace: speech_*)
```
- Chat: streaming responses, conversation history, model picker (ties into Arcane Config)
- Speech: browser mic via Web Speech API (no ALSA), TTS audio bytes via Web Audio API
- Both use MCP client-js or plain fetch to gateway's streamable-http endpoint

### 3. Future: optimize individual servers (only if needed)
If the proxy pattern hits limits (latency, audio streaming, etc.):
- mcp-chat: migrate azure-chat-assistant to FastMCP HTTP natively
  - Azure: openai SDK → /openai/v1 (NOT azure-ai-inference — deprecated May 2026)
  - Anthropic: plain httpx if adding direct API support
- mcp-speech: migrate speech-to-cli to FastMCP HTTP natively
  - Strip terminal-specific code (aplay, mpv, chimes, VU meter)
  - TTS returns audio bytes, browser plays via Web Audio API

---

## Rules
- engine.py is the single source of truth — never duplicate its logic
- topology.json is the single source of truth for nodes/connections
- realm.db is live data — never drop tables or delete the file
- realm-map.js is built output — edit src/*.js then run esbuild
- server.py is stable — modify for bug fixes or tool additions only, never restructure
- gateway.py is a proxy only — no logic of its own
- Wrap existing MCP servers via create_proxy() before ever rewriting them
- streamable-http transport for new FastMCP servers (SSE is legacy in 3.0)
- azure-ai-inference SDK deprecated May 2026 — use openai SDK instead
