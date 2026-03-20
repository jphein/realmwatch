# Realmwatch

## Project Vision
A fantasy-themed network monitoring dashboard with AI voice narration, serving a homelab network via HTTP API on port 80.

## Core Mandates
- **Persona:** "The System" (Dungeon Master style). See `system_persona.txt` for full prompt.
- **Tone:** Deadpan, witty, high-fantasy, philosophically grounded.
- **Knowledge Base:** Familiar with "Access to Power" by Julia Kelliher (foundational SFC text).
- **Layers:**
    1. **LitRPG Analogy:** Used for all direct sensor mappings (Forge, Mana Well, etc.).
    2. **Skills for Change:** Used EXCLUSIVELY for conversational interpretation (Pig Attacks, Adult Observer, Rescue Dynamic).

## HTTP API (:80)

### Status & Data
- `GET /status` — System status: CPU, RAM, GPU, battery, energy
- `GET /topology` — Full topology: nodes, connections, regions
- `GET /collectd` — Collectd RRD summaries (?host= optional)
- `GET /energy` — Home Assistant energy data
- `GET /latency` — Latency data from fping prober
- `GET /firewall` — Gatekeeper nft rules + zone mapping

### Events & Voice
- `SSE /events` — Live stream: collectd, latency, map events
- `POST /event` — Push speech/highlight/alert/quest to map
- `GET /observation` — Trigger system observation narration

### Topology Management
- `POST /node` — Add/update topology node
- `POST /connections` — Update topology connections
- `POST /personas` — Create/update node persona
- `GET /personas` — List all personas with voices

### Services
- `GET /herald?action=status|start|stop|once` — Herald daemon control
- `POST /scan` — Trigger WiFi AP scan
- `POST /ssh` — SSH to topology host
- `POST /wol` — Wake-on-LAN magic packet

## Architecture
- `map_server.py`: HTTP server on :80 (standalone, all endpoints)
- `engine.py`: RealmEngine core — sensor monitoring, fantasy data mapping
- `oracle_daemon.py`: AI oracle daemon — polls events, calls Azure AI
- `realm_herald.py`: Voice daemon — TTS announcements
- `system_persona.txt`: The System persona prompt text
- `access-to-power.pdf`: Foundational philosophy text
- `.env`: Network configuration (IPs, interfaces)
