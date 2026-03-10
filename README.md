# LitRPG Fantasy Voice — The Realm Map

A live interactive fantasy-themed map of an entire digital network infrastructure.
Hardware sensors, network nodes, and system metrics are mapped to high-fantasy
archetypes with voices powered by Azure TTS and GPT personas.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     realm-map.html                       │
│  Live map with 40+ nodes, EtherApe traffic viz,          │
│  speech bubbles, quest log, codex, pan/zoom              │
└────────────────────────┬────────────────────────────────┘
                         │ polls /status, /events
┌────────────────────────┴────────────────────────────────┐
│                    map_server.py                          │
│  HTTP :8777 — serves status JSON, event ring buffer,     │
│  collectd data, and the map HTML                         │
└────────────┬──────────────────────┬─────────────────────┘
             │                      │
┌────────────┴───────┐  ┌──────────┴──────────┐
│    engine.py        │  │ collectd_reader.py   │
│  Sensor engine      │  │ RRD file reader      │
│  Fantasy mapping    │  │ 13+ hosts via        │
│  Scales & personas  │  │ rrdtool lastupdate   │
└────────────────────┘  └─────────────────────┘
```

## Components

| File | Role |
|------|------|
| `server.py` | MCP server — tools, prompts, resources, node personas |
| `engine.py` | Sensor engine — CPU/GPU/RAM/battery/network → fantasy mapping |
| `map_server.py` | HTTP server for the live map (port 8777) |
| `collectd_reader.py` | Reads collectd RRD files from `/var/lib/collectd/rrd/` |
| `collectd_listener.py` | UDP listener for collectd binary protocol (optional) |
| `realm_herald.py` | Background daemon — automated node speech reports |
| `realm-map.html` | The live map — SVG terrain, 40+ nodes, traffic visualization |
| `monitor_3min.py` | Quick monitoring script (3-min log) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_system_status` | Raw sensor data as fantasy-mapped JSON |
| `trigger_system_observation` | The System narrates current state |
| `vocalize_message` | Custom text → voice |
| `commune_with_system` | Voice conversation with The System |
| `map_event` | Push speech/highlight/alert events to the live map |
| `map_node_chat` | Make a node speak with its persona via GPT |
| `get_node_personas` | List all node voices and system prompts |
| `herald_round` | Orchestrate multiple nodes reporting with voices |

## Node Personas

| Node | Name | Voice | Style |
|------|------|-------|-------|
| katana | Katana, The Citadel | GuyNeural | Quiet authority, deadpan |
| gatekeeper | The Gatekeeper | DavisNeural | Vigilant, terse, suspicious |
| oracle | The Oracle Stone | BrianNeural | Riddles and patterns |
| forge | The Great Forge | AndrewNeural | Fiery, thermal pride |
| mana | The Mana Well | JennyNeural | Depth, scarcity awareness |
| crystal | Crystal Engine | AvaNeural | Crystalline precision |
| mr8300-host | <REDACTED> | TonyNeural | Stoic tower pride |
| wrt1900ac-family | The Great Hall | JasonNeural | Warm, gathering place |
| onhub-office | The Scribe's Alcove | EricNeural | Scholarly precision |
| onhub-bed | The Dreamer's Rest | AriaNeural | Soft, peaceful |

## Voice Pipeline

```
map_node_chat(node, prompt)
  → Loads persona + current sensor state
  → Agent calls azure-chat-assistant with persona system prompt
  → Agent posts response as map_event (speech bubble)
  → Agent calls multi_speak with node's Azure voice
  → User hears the node speak with unique personality
```

## EtherApe Traffic Visualization

Connection lines between nodes dynamically respond to collectd interface data:
- **Width**: Proportional to traffic volume (log scale)
- **Brightness**: Higher opacity for busier links
- **Speed**: Faster dash animation for more traffic
- **Flow direction**: Dashes move toward the receiving end
- **Glow**: SVG blur filter at high/med/low traffic tiers
- **Scale slider**: User-adjustable from Subtle to Dramatic

## Quick Start

```bash
# Terminal 1: Map server
python3 map_server.py

# Terminal 2: Herald (optional auto-reporter)
python3 realm_herald.py --interval 90

# Open browser
# http://localhost:8777
```

## Access to Power Framework

Sensor states are mapped to the **Depletion/Repletion Scale** (-10 to +10)
from *Access to Power* by Julia Kelliher. The System's conversational voice
uses the Parent-Adult-Child model, Pig Parent theory, and Stories vs Facts
to interpret system stress through a coaching lens.

## Network

- **22+ nodes** pinged in parallel (APs, bridges, infra, IoT clusters)
- **13+ collectd hosts** pushing metrics via RRD
- **VLANs**: 10.0.6.x (main), 10.0.10.x (IoT), 10.0.11.x, 10.0.8.x
- **Tailscale mesh** for remote peer visibility
