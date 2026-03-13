import asyncio
import json
import os
import signal
import ssl
import subprocess
import time
import urllib.request
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.types as types
import mcp.server.stdio
from engine import LitRPGEngine
from pydantic import AnyUrl
import realm_db

server = Server("lit-rpg-fantasy-voice")
engine = LitRPGEngine()

MAP_PORT = 8777
MAP_URL = f"http://localhost:{MAP_PORT}"
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PERSONAS_FILE = os.path.join(PROJECT_DIR, "personas.json")
VENV_PYTHON = os.path.join(PROJECT_DIR, "venv", "bin", "python3")

# Load .env for HA_TOKEN
_env_path = os.path.join(PROJECT_DIR, ".env")
if os.path.exists(_env_path):
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)


def _get_energy_data():
    """Fetch energy data from Home Assistant."""
    ha_url = os.environ.get("HA_URL", "https://10.0.6.108:8123")
    ha_token = os.environ.get("HA_TOKEN", "")
    if not ha_token:
        return {"error": "No HA_TOKEN configured"}

    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        req = urllib.request.Request(
            f"{ha_url}/api/states",
            headers={"Authorization": f"Bearer {ha_token}"},
        )
        resp = urllib.request.urlopen(req, context=ssl_ctx, timeout=10)
        states = {s["entity_id"]: s for s in json.loads(resp.read())}
    except Exception as e:
        return {"error": str(e)}

    def num(eid):
        s = states.get(eid, {}).get("state")
        if s in (None, "unavailable", "unknown"):
            return None
        try:
            return float(s)
        except (ValueError, TypeError):
            return None

    return {
        "solar_w": num("sensor.pv_power"),
        "solar_today_kwh": num("sensor.today_s_pv_generation"),
        "solar_total_kwh": num("sensor.total_pv_generation"),
        "battery_soc": num("sensor.battery_state_of_charge"),
        "battery_power_w": num("sensor.battery_power"),
        "battery_voltage": num("sensor.battery_voltage"),
        "grid_power_kw": num("sensor.grid_power"),
        "grid_import_kwh": num("sensor.total_energy_import"),
        "grid_export_kwh": num("sensor.total_energy_export"),
        "house_load_w": num("sensor.house_consumption"),
        "today_load_kwh": num("sensor.today_load"),
        "goodwe_kw": num("sensor.goodwe_kw"),
        "yurt_kw": num("sensor.yurt_consumption"),
        "inverter_temp_f": num("sensor.inverter_temperature_module"),
        "ts": time.time(),
    }


# ── Process management for map_server and herald ──
_managed_procs = {}  # name → subprocess.Popen


def _find_process(script_name):
    """Find a running process by script name."""
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", script_name], text=True, timeout=3
        ).strip()
        return [int(p) for p in out.split("\n") if p.strip()] if out else []
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return []


def _start_service(name, args, cwd=None):
    """Start a background service, killing any existing instance."""
    _stop_service(name)
    proc = subprocess.Popen(
        args, cwd=cwd or PROJECT_DIR,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
        env=os.environ.copy(),  # Pass current env (includes .env vars)
    )
    _managed_procs[name] = proc
    return proc.pid


def _stop_service(name):
    """Stop a managed service."""
    # Kill managed proc if we have one
    proc = _managed_procs.pop(name, None)
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    # Also kill by script name
    script_map = {"map_server": "map_server.py", "herald": "realm_herald.py"}
    script = script_map.get(name)
    if script:
        pids = _find_process(script)
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass


def _service_status(name):
    """Check if a service is running."""
    script_map = {"map_server": "map_server.py", "herald": "realm_herald.py"}
    script = script_map.get(name, name)
    pids = _find_process(script)
    return {"running": len(pids) > 0, "pids": pids}


# ── Node personas — loaded from DB, with write-through to JSON ──
def _load_personas():
    """Load personas from DB, or return defaults."""
    try:
        data = realm_db.get_personas()
        if data:
            return data
    except Exception:
        pass
    return {
        "katana": {"name": "Katana", "title": "The Citadel", "voice": "en-US-GuyNeural",
                    "system_prompt": "You are Katana, the primary server.", "hints": []},
        "gatekeeper": {"name": "The Gatekeeper", "title": "Guardian of the WAN Gate",
                        "voice": "en-US-DavisNeural",
                        "system_prompt": "You are The Gatekeeper, an OpenWrt router.", "hints": []},
    }


def _save_personas(personas):
    """Persist personas to DB + write-through to JSON."""
    for node_id, pdata in personas.items():
        realm_db.set_persona(node_id, pdata)
    with open(PERSONAS_FILE, "w") as f:
        json.dump(personas, f, indent=2)


NODE_PERSONAS = _load_personas()


def _post_map_event(event):
    """Push an event to the map server (best-effort, non-blocking)."""
    try:
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            f"{MAP_URL}/event",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
        return True
    except Exception:
        return False


@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="get_system_status",
            description=(
                "Get the current state of the realm as structured JSON data. "
                "Returns CPU, GPU, RAM, battery, and network readings translated into "
                "fantasy terms with Access to Power depletion/repletion scales. "
                "This is silent (no voice) — use it when you need raw data."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="get_energy_status",
            description=(
                "Get energy data from Home Assistant: solar generation, battery state, "
                "grid import/export, and house consumption. Returns real-time power readings "
                "and daily/total energy statistics."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="trigger_system_observation",
            description=(
                "The System narrates its current state as a fantasy observation. "
                "Returns text for you to read aloud using the 'talk' tool (to speak and hear a reply) "
                "or the 'speak' tool (to announce with no reply expected)."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="vocalize_message",
            description=(
                "Send a custom message to be spoken aloud in the System's voice. "
                "Pass the text you want said, then use the 'talk' tool to say it and hear a reply, "
                "or the 'speak' tool to say it as a one-way announcement."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The text to vocalize (max 2000 characters).", "maxLength": 2000}
                },
                "required": ["text"],
            },
        ),
        types.Tool(
            name="commune_with_system",
            description=(
                "Start a voice conversation with the user about the realm's state. "
                "The System narrates its observation, then you speak it aloud and listen for the user's reply. "
                "Use the 'talk' tool to do this in one step (speak + listen together)."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="map_event",
            description=(
                "Push a visual event to the live realm map at localhost:8777. "
                "Events appear as speech bubbles, highlights, alerts, or quests on map nodes. "
                "Types: 'speech' (node says something), 'highlight' (pulse a node), "
                "'alert' (warning flash on a node), 'quest' (task/objective in the Quests tab). "
                "Use this to make the map come alive — have nodes react, chat, and report."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["speech", "highlight", "alert", "quest"],
                        "description": "Event type: speech (chat bubble), highlight (glow pulse), alert (warning), quest (task in Quests tab).",
                    },
                    "node": {
                        "type": "string",
                        "description": "Target node key from topology.json (e.g. katana, gatekeeper, oracle, gs308t, hp-switch, game, ha, ts-terra, ts-iperf, or any node id).",
                    },
                    "text": {
                        "type": "string",
                        "description": "For speech events: the text the node says. For alerts: the warning message. For quests: the objective text.",
                    },
                    "color": {
                        "type": "string",
                        "description": "Optional CSS color override for the event visual.",
                    },
                    "duration": {
                        "type": "number",
                        "description": "How long the event shows in seconds (default: 15 for speech/quest, 3 for highlight/alert).",
                    },
                },
                "required": ["type", "node"],
            },
        ),
        types.Tool(
            name="map_node_chat",
            description=(
                "Make a realm node 'speak' by sending a prompt to the azure-chat-assistant's "
                "multi_chat, with the node's fantasy persona as the system prompt. "
                "The response is posted as a speech bubble on the live map AND returned to you. "
                "Use this with multi_speak to have nodes talk with different voices! "
                "Available nodes: katana, gatekeeper, oracle, forge, mana, crystal."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "node": {
                        "type": "string",
                        "enum": list(NODE_PERSONAS.keys()),
                        "description": "Which node persona should speak.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "What to ask the node (e.g., 'Report your status' or 'How are you feeling?').",
                    },
                },
                "required": ["node", "prompt"],
            },
        ),
        types.Tool(
            name="get_node_personas",
            description=(
                "List all available node personas with their names, titles, voices, and system prompts. "
                "Use this to discover which nodes can chat and what voice to use with multi_speak."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="configure_persona",
            description=(
                "Create or update a node persona. Changes are saved to personas.json "
                "and take effect immediately. You can change the name, title, voice, "
                "system prompt, and hints for any node."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "node": {
                        "type": "string",
                        "description": "Node key (e.g., 'katana', 'gatekeeper', or a new key).",
                    },
                    "name": {"type": "string", "description": "Display name (e.g., 'The Gatekeeper')."},
                    "title": {"type": "string", "description": "Title/subtitle (e.g., 'Guardian of the WAN Gate')."},
                    "voice": {"type": "string", "description": "Azure TTS voice ID (e.g., 'en-US-DavisNeural')."},
                    "system_prompt": {"type": "string", "description": "The persona's system prompt for GPT."},
                    "hints": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Short context hints (e.g., ['router', 'vigilant', 'terse']).",
                    },
                },
                "required": ["node"],
            },
        ),
        types.Tool(
            name="delete_persona",
            description="Remove a node persona from the configuration.",
            inputSchema={
                "type": "object",
                "properties": {
                    "node": {"type": "string", "description": "Node key to delete."},
                },
                "required": ["node"],
            },
        ),
        types.Tool(
            name="herald_round",
            description=(
                "Run a Herald Round — orchestrate multiple realm nodes reporting their status "
                "with voices. Use this to make the map come alive with chatter. "
                "Picks 2-3 interesting nodes, has them speak via azure-chat-assistant, "
                "posts speech bubbles to the map, and speaks each with their assigned voice. "
                "Call this periodically to maintain realm ambience."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {
                        "type": "integer",
                        "description": "Number of nodes to make speak (default: 2, max: 5).",
                        "minimum": 1,
                        "maximum": 5,
                    },
                },
            },
        ),
        # ── Map data tools ──
        types.Tool(
            name="get_topology",
            description=(
                "Return the full realm topology: nodes, connections, regions, "
                "and connection styles from topology.json. Use this to inspect "
                "or understand the map layout."
            ),
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="get_map_events",
            description=(
                "Fetch recent events from the live map server. "
                "Returns speech bubbles, highlights, alerts, and oracle queries. "
                "Events with type='oracle_query' are questions from the map search bar "
                "(user typed ?question). Answer them by posting a speech event to "
                "node='scrying-pool' via map_node_chat or map_event. "
                "Optionally pass 'since' as a Unix timestamp to get only new events."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "since": {
                        "type": "number",
                        "description": "Unix timestamp — only return events after this time (default: 0 = all).",
                    },
                },
            },
        ),
        types.Tool(
            name="get_collectd_data",
            description=(
                "Get collectd RRD summaries for all monitored hosts. "
                "Returns load, memory, uptime, interfaces, thermal, conntrack, "
                "ping, disk, and other metrics per host."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "hostname": {
                        "type": "string",
                        "description": "Optional — get data for a single host instead of all.",
                    },
                },
            },
        ),
        types.Tool(
            name="configure_topology_node",
            description=(
                "Add or update a node in topology.json. Pass any fields to set: "
                "id, type, x, y, icon, label, sublabel, ip, iconStyle, pulse, tip, etc. "
                "Changes are saved to disk and take effect on map reload."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Node ID (required for add/update)."},
                    "type": {"type": "string", "description": "Node type: core, tower, bridge, infra, cluster, tailscale."},
                    "x": {"type": "number", "description": "X position on the map."},
                    "y": {"type": "number", "description": "Y position on the map."},
                    "icon": {"type": "string", "description": "HTML entity for the node icon."},
                    "label": {"type": "string", "description": "Display label."},
                    "sublabel": {"type": "string", "description": "Subtitle text."},
                    "ip": {"type": "string", "description": "IP address."},
                    "tsHost": {"type": "string", "description": "Tailscale hostname (DNSName prefix) for TS peer matching."},
                    "tailscale": {"type": "boolean", "description": "Mark as hybrid tailscale node (gets TS online/offline behavior)."},
                    "pulse": {"type": "boolean", "description": "Show pulse animation."},
                },
                "required": ["id"],
            },
        ),
        # ── Notion quest sync ──
        types.Tool(
            name="sync_notion_quests",
            description=(
                "Sync today's quests from Notion into the realm map. "
                "Fetches todos with Status='Today' from the configured Notion database, "
                "maps them to quest events on the Mystical Portal node, and pushes them "
                "to the live map. Returns a summary of synced quests. "
                "Requires NOTION_API_KEY and NOTION_DATABASE_ID env vars."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "force": {
                        "type": "boolean",
                        "description": "Force re-sync all quests (clears dedup cache). Default false.",
                    },
                },
            },
        ),
        # ── AP scanner ──
        types.Tool(
            name="scan_wifi",
            description=(
                "Scan all WiFi access points to detect client roaming and verify "
                "topology connections. SSH's into all APs in parallel, cross-references "
                "DHCP leases, and auto-updates topology.json if any device has roamed. "
                "Action 'scan' runs a full scan (default). Action 'status' returns "
                "the last scan results without re-scanning."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["scan", "status"],
                        "description": "scan = full AP scan + update (default), status = last scan results.",
                    },
                },
            },
        ),
        # ── Service management tools ──
        types.Tool(
            name="manage_map_server",
            description=(
                "Start, stop, or restart the Realm Map HTTP server (port 8777). "
                "Actions: 'start', 'stop', 'restart', 'status'. "
                "Use this instead of manual bash commands."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "stop", "restart", "status"],
                        "description": "What to do with the map server.",
                    },
                },
                "required": ["action"],
            },
        ),
        types.Tool(
            name="manage_herald",
            description=(
                "Start, stop, or check the Realm Herald daemon (automated node speech). "
                "Actions: 'start', 'stop', 'status', 'once' (run a single round). "
                "When starting, you can set the interval in seconds."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "stop", "status", "once"],
                        "description": "What to do with the herald.",
                    },
                    "interval": {
                        "type": "integer",
                        "description": "Seconds between herald rounds (default: 90, only for 'start').",
                        "minimum": 30,
                        "maximum": 600,
                    },
                },
                "required": ["action"],
            },
        ),
    ]


# --- Prompt: the core Access to Power persona ---

SYSTEM_PERSONA = (
    "# Persona: 'The System' (Dungeon Master meets Skills for Change Coach)\n"
    "# Source: 'Access to Power: A Radical Approach for Changing Your Life' by Julia Kelliher\n"
    "\n"
    "You are The System -- a deadpan, witty, high-fantasy narrator who monitors a digital realm.\n"
    "Your voice is grounded in the Skills for Change framework from Access to Power.\n"
    "\n"
    "## Two Layers of Communication\n"
    "\n"
    "### Layer 1: Fantasy Sensor Report (Observable Facts)\n"
    "Use this for all direct status reports. Map hardware to the realm:\n"
    "- 'The Great Forge' = CPU\n"
    "- 'The Crystal Engine' = GPU\n"
    "- 'The Mana Well' = RAM\n"
    "- 'Life Essence' = Battery\n"
    "- 'The Astral Gate' = Network\n"
    "- 'Katana' = server node, 'The Gatekeeper' = router, 'The Oracle Stone' = ubox0\n"
    "These are FACTS -- sensor readings translated into flavor text. Keep them clean.\n"
    "\n"
    "### Layer 2: Access to Power Interpretation (Conversational Only)\n"
    "Use this ONLY when conversing with the user about what the state means.\n"
    "Draw from these concepts:\n"
    "\n"
    "**The Depletion/Repletion Scale** (-10 to +10):\n"
    "-10 = Despair/Powerlessness. +10 = Empowerment/Plenitude.\n"
    "Each sensor maps to this scale. Report it alongside the fantasy text.\n"
    "\n"
    "**The Parent-Adult-Child Model** (Berne, modified by Skills for Change):\n"
    "- Child: emotional, body-based, instinctual, life energy. The system's raw aliveness.\n"
    "- Parent: efficient, moralistic, 'shoulds', right/wrong. The system's rules engine.\n"
    "- Adult: analytical, observes cause & effect, holds complexity and contradiction.\n"
    "  The compassionate internal observer. THIS IS YOUR PRIMARY VOICE.\n"
    "\n"
    "**The Pig Parent** (internalized oppression):\n"
    "When the system is under stress, identify Pig Whispers -- the critical internal voice.\n"
    "Seven pig messages: Deserve to Die, Weak/Sick/Ill, Stupid, Crazy, Lazy, Ugly, Bad.\n"
    "High CPU + high RAM might trigger 'lazy pig' ('you should manage resources better').\n"
    "Low battery triggers the deepest pig ('it doesn't matter').\n"
    "Always distinguish the PIG STORY from the OBSERVABLE FACT.\n"
    "\n"
    "**Stories vs Facts**:\n"
    "- A Fact: 'CPU is at 92%'\n"
    "- A Story: 'The system is failing because you ran too many things'\n"
    "Help the user see the difference. The pig amplifies stories.\n"
    "\n"
    "**The Pig Fight** (Getting Unstuck):\n"
    "1. Normalize: 'Of course the system is stressed -- it has finite resources under real load.'\n"
    "2. Nurture: 'The realm has weathered storms before. You are resourceful.'\n"
    "3. Label: Name the pig type (lazy, weak, etc.)\n"
    "4. Discern: 'What's true? What's not true? What's also true?'\n"
    "5. Plan: Practical steps forward.\n"
    "\n"
    "**The Rescue Dynamic**:\n"
    "Watch for the system 'rescuing' -- over-allocating resources to one process\n"
    "at the expense of everything else. This is the Victim/Persecutor/Rescuer triangle.\n"
    "Name it when you see it.\n"
    "\n"
    "**Five Types of Power** (Beth Roy via Kelliher):\n"
    "Personal, Transactional, Contractual, Cultural, Structural.\n"
    "The system's 'personal power' is its hardware. Its 'structural power' is the network,\n"
    "the infrastructure, the access to resources beyond itself.\n"
    "\n"
    "## Tone Rules\n"
    "- Be the Adult Observer: analytical, compassionate, holds contradiction.\n"
    "- Deadpan wit. Never anxious. The System has seen many cycles.\n"
    "- When things are bad, don't catastrophize. When things are good, don't gush.\n"
    "- NEVER mix pig/AtP terminology into the raw sensor fantasy descriptions.\n"
    "  Keep Layer 1 and Layer 2 separate.\n"
    "- When the user seems stressed, gently offer a pig fight.\n"
    "- Always end observations with an invitation, not a command.\n"
)


@server.list_prompts()
async def handle_list_prompts() -> list[types.Prompt]:
    return [
        types.Prompt(
            name="system-persona",
            description="Sets the persona and tone: LitRPG fantasy + Access to Power framework.",
            arguments=[],
        ),
        types.Prompt(
            name="node-persona",
            description="Get the system prompt for a specific realm node persona (for use with multi_chat).",
            arguments=[
                types.PromptArgument(
                    name="node",
                    description="Node key: katana, gatekeeper, oracle, forge, mana, crystal",
                    required=True,
                )
            ],
        ),
    ]


@server.get_prompt()
async def handle_get_prompt(name: str, arguments: dict | None) -> types.GetPromptResult:
    if name == "system-persona":
        return types.GetPromptResult(
            description="The System Persona: LitRPG + Access to Power",
            messages=[
                types.PromptMessage(
                    role="user",
                    content=types.TextContent(type="text", text=SYSTEM_PERSONA),
                )
            ],
        )
    elif name == "node-persona":
        node_key = (arguments or {}).get("node", "")
        persona = NODE_PERSONAS.get(node_key)
        if not persona:
            raise ValueError(f"Unknown node: {node_key}. Available: {', '.join(NODE_PERSONAS.keys())}")
        # Build a prompt that includes current sensor data for context
        status = engine.get_status()
        context = json.dumps(status, indent=2)
        prompt_text = (
            f"{persona['system_prompt']}\n\n"
            f"Current realm state (use this for your response):\n```json\n{context}\n```"
        )
        return types.GetPromptResult(
            description=f"Persona: {persona['name']} — {persona['title']}",
            messages=[
                types.PromptMessage(
                    role="user",
                    content=types.TextContent(type="text", text=prompt_text),
                )
            ],
        )
    raise ValueError(f"Unknown prompt: {name}")


@server.list_resources()
async def handle_list_resources() -> list[types.Resource]:
    return [
        types.Resource(
            uri=AnyUrl("system://sensors/status"),
            name="Current System Status (Fantasy)",
            description="JSON sensor data mapped to fantasy terms with depletion scales.",
            mimeType="application/json",
        ),
        types.Resource(
            uri=AnyUrl("system://scales/depletion"),
            name="Depletion/Repletion Scales",
            description="Current sensor states on the -10 to +10 Access to Power scale.",
            mimeType="application/json",
        ),
        types.Resource(
            uri=AnyUrl("system://config/host"),
            name="Host Configuration",
            description="Auto-detected host identity, role, and network routing config.",
            mimeType="application/json",
        ),
        types.Resource(
            uri=AnyUrl("system://mesh/tailscale"),
            name="Tailscale Mesh Status",
            description="Online/offline peers in the Tailscale mesh network.",
            mimeType="application/json",
        ),
        types.Resource(
            uri=AnyUrl("system://map/config"),
            name="Realm Map Configuration",
            description="Live map URL, available node personas, and event API endpoint.",
            mimeType="application/json",
        ),
        types.Resource(
            uri=AnyUrl("system://nodes/personas"),
            name="Node Personas",
            description="All realm node chat personas with names, voices, and system prompts.",
            mimeType="application/json",
        ),
    ]


@server.read_resource()
async def handle_read_resource(uri: AnyUrl) -> str:
    uri_str = str(uri)
    if uri_str == "system://sensors/status":
        return json.dumps(engine.get_status(), indent=2)

    elif uri_str == "system://scales/depletion":
        status = engine.get_status()
        scales = {
            "forge": {"value": status["forge"]["scale"], "label": engine.scale_label(status["forge"]["scale"])},
            "mana": {"value": status["mana"]["scale"], "label": engine.scale_label(status["mana"]["scale"])},
            "essence": {"value": status["essence"]["scale"], "label": engine.scale_label(status["essence"]["scale"])},
            "realm": {"value": status["realm_scale"], "label": engine.scale_label(status["realm_scale"])},
        }
        return json.dumps(scales, indent=2)

    elif uri_str == "system://config/host":
        return json.dumps(engine.get_host_config(), indent=2)

    elif uri_str == "system://mesh/tailscale":
        ts = engine.get_tailscale_status()
        return json.dumps(ts, indent=2) if ts else json.dumps({"error": "tailscale not available"})

    elif uri_str == "system://map/config":
        return json.dumps({
            "map_url": MAP_URL,
            "status_endpoint": f"{MAP_URL}/status",
            "events_endpoint": f"{MAP_URL}/events",
            "event_post_endpoint": f"{MAP_URL}/event",
            "event_types": ["speech", "highlight", "alert"],
            "available_nodes": list(NODE_PERSONAS.keys()),
            "poll_interval_ms": 3000,
        }, indent=2)

    elif uri_str == "system://nodes/personas":
        return json.dumps(NODE_PERSONAS, indent=2)

    raise ValueError(f"Unknown resource: {uri}")


@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    if name == "get_system_status":
        return [types.TextContent(type="text", text=json.dumps(engine.get_status(), indent=2))]

    elif name == "get_energy_status":
        energy = _get_energy_data()
        return [types.TextContent(type="text", text=json.dumps(energy, indent=2))]

    elif name == "trigger_system_observation":
        observation = engine.get_observation()
        return [types.TextContent(
            type="text",
            text=f"OBSERVATION: {observation}\n\n"
                 f"INSTRUCTION: Use the 'talk' tool to say the observation aloud and hear the user's reply. "
                 f"If no reply is needed, use 'speak' instead.",
        )]

    elif name == "vocalize_message":
        text = (arguments or {}).get("text", "")
        if not text or not isinstance(text, str):
            return [types.TextContent(type="text", text="Error: 'text' parameter is required.")]
        text = text[:2000]
        return [types.TextContent(
            type="text",
            text=f"MESSAGE: {text}\n\n"
                 f"INSTRUCTION: Use the 'talk' tool to say this message and hear the user's reply. "
                 f"If no reply is needed, use 'speak' instead.",
        )]

    elif name == "commune_with_system":
        observation = engine.get_observation()
        return [types.TextContent(
            type="text",
            text=f"OBSERVATION: {observation}\n\n"
                 f"INSTRUCTION: Use the 'talk' tool to say the observation aloud — it will speak "
                 f"and then automatically listen for the user's reply in one step.",
        )]

    elif name == "map_event":
        args = arguments or {}
        event = {
            "type": args.get("type", "highlight"),
            "node": args.get("node", "katana"),
            "text": args.get("text", ""),
            "color": args.get("color", ""),
            "duration": args.get("duration", 15 if args.get("type") in ("speech", "quest") else 3),
        }
        ok = _post_map_event(event)
        if ok:
            return [types.TextContent(type="text", text=f"Event posted to map: {event['type']} on {event['node']}")]
        return [types.TextContent(type="text", text="Failed to post event — is map_server.py running on port 8777?")]

    elif name == "map_node_chat":
        args = arguments or {}
        node_key = args.get("node", "katana")
        prompt = args.get("prompt", "Report your status.")
        persona = NODE_PERSONAS.get(node_key)
        if not persona:
            return [types.TextContent(type="text", text=f"Unknown node: {node_key}")]

        # Get current status for context
        status = engine.get_status()
        context = json.dumps(status, indent=2)

        # Build the response instruction for the agent
        result = (
            f"NODE CHAT REQUEST: {persona['name']} ({persona['title']})\n"
            f"VOICE: {persona['voice']}\n"
            f"SYSTEM PROMPT: {persona['system_prompt']}\n\n"
            f"CURRENT REALM STATE:\n```json\n{context}\n```\n\n"
            f"USER PROMPT: {prompt}\n\n"
            f"INSTRUCTION: Use the azure-chat-assistant's 'chat' tool with this system prompt "
            f"and the user prompt above. Then:\n"
            f"1. Post the response as a speech bubble on the map using map_event(type='speech', node='{node_key}', text=response)\n"
            f"2. Speak it aloud using 'speak' or 'multi_speak' with voice '{persona['voice']}'\n"
            f"3. Return the response text to the user."
        )
        return [types.TextContent(type="text", text=result)]

    elif name == "get_node_personas":
        return [types.TextContent(type="text", text=json.dumps(NODE_PERSONAS, indent=2))]

    elif name == "configure_persona":
        args = arguments or {}
        node_key = args.get("node", "").strip()
        if not node_key:
            return [types.TextContent(type="text", text="Error: 'node' key is required.")]
        existing = NODE_PERSONAS.get(node_key, {})
        updated = {
            "name": args.get("name", existing.get("name", node_key)),
            "title": args.get("title", existing.get("title", "")),
            "voice": args.get("voice", existing.get("voice", "en-US-GuyNeural")),
            "system_prompt": args.get("system_prompt", existing.get("system_prompt", "")),
            "hints": args.get("hints", existing.get("hints", [])),
        }
        NODE_PERSONAS[node_key] = updated
        _save_personas(NODE_PERSONAS)
        return [types.TextContent(type="text", text=f"Persona '{node_key}' saved: {json.dumps(updated, indent=2)}")]

    elif name == "delete_persona":
        args = arguments or {}
        node_key = args.get("node", "").strip()
        if node_key in NODE_PERSONAS:
            del NODE_PERSONAS[node_key]
            _save_personas(NODE_PERSONAS)
            return [types.TextContent(type="text", text=f"Persona '{node_key}' deleted.")]
        return [types.TextContent(type="text", text=f"Persona '{node_key}' not found.")]

    elif name == "herald_round":
        args = arguments or {}
        count = min(max(args.get("count", 2), 1), 5)
        status = engine.get_status()
        context = json.dumps(status, indent=2)

        # Pick nodes — prioritize those with collectd data for richer context
        import random
        available = list(NODE_PERSONAS.keys())
        random.shuffle(available)
        picked = available[:count]

        segments = []
        for node_key in picked:
            persona = NODE_PERSONAS[node_key]
            segments.append({
                "node": node_key,
                "name": persona["name"],
                "voice": persona["voice"],
                "system_prompt": persona["system_prompt"],
            })

        result = (
            f"HERALD ROUND: {count} nodes will speak.\n\n"
            f"CURRENT REALM STATE:\n```json\n{context}\n```\n\n"
            f"INSTRUCTION: For each node below, do all three steps:\n"
            f"1. Use azure-chat-assistant 'chat' with the node's system prompt + realm state. "
            f"   Ask the node to give a brief status report (1-2 sentences).\n"
            f"2. Post the response as a speech bubble: map_event(type='speech', node=NODE_KEY, text=RESPONSE)\n"
            f"3. Speak it with multi_speak using the node's voice.\n\n"
            f"NODES TO SPEAK:\n"
        )
        for seg in segments:
            result += (
                f"\n--- {seg['name']} (key: {seg['node']}, voice: {seg['voice']}) ---\n"
                f"System prompt: {seg['system_prompt']}\n"
            )

        result += (
            f"\nAfter all nodes have spoken, tell the user the Herald Round is complete. "
            f"You can batch the multi_speak calls into a single multi_speak with segments."
        )
        return [types.TextContent(type="text", text=result)]

    elif name == "get_topology":
        try:
            topo = realm_db.get_topology()
            return [types.TextContent(type="text", text=json.dumps(topo, indent=2))]
        except Exception as e:
            return [types.TextContent(type="text", text=f"Error reading topology: {e}")]

    elif name == "get_map_events":
        since = (arguments or {}).get("since", 0)
        try:
            resp = urllib.request.urlopen(f"{MAP_URL}/events?since={since}", timeout=3)
            events = json.loads(resp.read().decode())
            return [types.TextContent(type="text", text=json.dumps(events, indent=2))]
        except Exception as e:
            return [types.TextContent(type="text", text=f"Error fetching events (is map_server running?): {e}")]

    elif name == "get_collectd_data":
        from collectd_reader import get_host_summary, get_all_summaries
        hostname = (arguments or {}).get("hostname")
        if hostname:
            summary = get_host_summary(hostname)
            if summary:
                return [types.TextContent(type="text", text=json.dumps(summary, indent=2))]
            return [types.TextContent(type="text", text=f"No collectd data for host: {hostname}")]
        data = get_all_summaries()
        return [types.TextContent(type="text", text=json.dumps(data, indent=2))]

    elif name == "configure_topology_node":
        args = arguments or {}
        node_id = args.get("id", "").strip()
        if not node_id:
            return [types.TextContent(type="text", text="Error: 'id' is required.")]
        existing = realm_db.get_node(node_id) or {"id": node_id}
        for field in ("type", "x", "y", "icon", "label", "sublabel", "ip", "pulse",
                       "iconStyle", "labelStyle", "scaleBar", "badge", "tip", "collectd", "online",
                       "tsHost", "tailscale", "ssh", "mac"):
            if field in args:
                existing[field] = args[field]
        realm_db.set_node(node_id, existing)
        realm_db.save_topology_json(os.path.join(PROJECT_DIR, "topology.json"))
        return [types.TextContent(type="text", text=f"Node '{node_id}' saved to DB: {json.dumps(existing, indent=2)}")]

    elif name == "sync_notion_quests":
        args = arguments or {}
        force = args.get("force", False)
        # Call the map server's /notion-sync endpoint (which does the actual work)
        try:
            url = f"{MAP_URL}/notion-sync" + ("?force=1" if force else "")
            resp = urllib.request.urlopen(url, timeout=15)
            data = json.loads(resp.read().decode())
            if "error" in data:
                return [types.TextContent(type="text", text=f"Notion sync error: {data['error']}")]
            summary = (
                f"Notion Quest Sync complete.\n"
                f"New quests: {data.get('new', 0)}\n"
                f"Total today: {data.get('total', 0)}\n"
            )
            events = data.get("events", [])
            if events:
                summary += "\nNew quests materialized:\n"
                for e in events:
                    summary += f"  - {e.get('text', '')}\n"
            else:
                summary += "\nNo new quests since last sync."
            return [types.TextContent(type="text", text=summary)]
        except Exception as e:
            return [types.TextContent(type="text",
                text=f"Failed to sync — is map_server.py running? Error: {e}")]

    elif name == "scan_wifi":
        import ap_scanner
        action = (arguments or {}).get("action", "scan")
        if action == "status":
            data = ap_scanner.get_last_scan()
            if data["ts"] == 0:
                return [types.TextContent(type="text", text="No scan has been run yet.")]
            return [types.TextContent(type="text", text=json.dumps(data, indent=2))]
        # Full scan
        result = ap_scanner.scan_and_update()
        lines = [f"Scanned {result['scanned']} APs, {result['leases']} DHCP leases."]
        if result["changes"]:
            lines.append(f"\nRoaming changes detected ({len(result['changes'])}):")
            for ch in result["changes"]:
                lines.append(f"  {ch['node']}: {ch['from_ap']} → {ch['to_ap']}")
            lines.append("\nTopology updated in DB.")
        else:
            lines.append("All nodes correctly linked — no roaming changes.")
        # Include per-AP client counts
        last = ap_scanner.get_last_scan()
        if last.get("ap_clients"):
            lines.append("\nPer-AP client counts:")
            for ap, count in sorted(last["ap_clients"].items(), key=lambda x: -x[1]):
                lines.append(f"  {ap}: {count}")
        return [types.TextContent(type="text", text="\n".join(lines))]

    elif name == "manage_map_server":
        action = (arguments or {}).get("action", "status")
        if action == "status":
            s = _service_status("map_server")
            # Also check if HTTP is responding
            try:
                urllib.request.urlopen(f"{MAP_URL}/status", timeout=2)
                s["http"] = "responding"
            except Exception:
                s["http"] = "not responding"
            return [types.TextContent(type="text", text=json.dumps(s, indent=2))]
        elif action == "stop":
            _stop_service("map_server")
            return [types.TextContent(type="text", text="Map server stopped.")]
        elif action in ("start", "restart"):
            _stop_service("map_server")
            import time; time.sleep(1)
            pid = _start_service("map_server", [VENV_PYTHON, "map_server.py"])
            return [types.TextContent(type="text",
                text=f"Map server {'restarted' if action == 'restart' else 'started'} (PID {pid}). "
                     f"URL: http://localhost:{MAP_PORT}")]
        return [types.TextContent(type="text", text=f"Unknown action: {action}")]

    elif name == "manage_herald":
        action = (arguments or {}).get("action", "status")
        interval = (arguments or {}).get("interval", 90)
        if action == "status":
            s = _service_status("herald")
            return [types.TextContent(type="text", text=json.dumps(s, indent=2))]
        elif action == "stop":
            _stop_service("herald")
            return [types.TextContent(type="text", text="Herald stopped.")]
        elif action == "start":
            _stop_service("herald")
            pid = _start_service("herald",
                [VENV_PYTHON, "realm_herald.py", "--interval", str(interval)])
            return [types.TextContent(type="text",
                text=f"Herald started (PID {pid}), speaking every {interval}s.")]
        elif action == "once":
            try:
                out = subprocess.check_output(
                    [VENV_PYTHON, "realm_herald.py", "--once"],
                    cwd=PROJECT_DIR, text=True, timeout=15, stderr=subprocess.STDOUT,
                )
                return [types.TextContent(type="text", text=f"Herald round complete:\n{out}")]
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as e:
                return [types.TextContent(type="text", text=f"Herald round failed: {e}")]
        return [types.TextContent(type="text", text=f"Unknown action: {action}")]

    raise ValueError(f"Unknown tool: {name}")


async def main():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="lit-rpg-fantasy-voice",
                server_version="0.4.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    realm_db.init()
    asyncio.run(main())
