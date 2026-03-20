#!/usr/bin/env python3
"""Oracle Daemon — auto-responds to ?queries from the map search bar.

Polls map_server /events for oracle_query events, generates responses
via Azure AI (reuses azure-chat-assistant config), posts speech events
back to the scrying-pool node, and optionally speaks them aloud.

Usage:
    python3 oracle_daemon.py              # Run with defaults (10s poll)
    python3 oracle_daemon.py --no-voice   # Skip TTS
    python3 oracle_daemon.py --once       # Process pending, then exit
"""

import argparse
import json
import os
import time
import urllib.request
from openai import AzureOpenAI
import realm_db

MAP_URL = "http://localhost:8777"
CHAT_CONFIG_PATH = os.path.expanduser("~/.config/azure-chat-assistant/config.json")
SPEECH_CONFIG_PATH = os.path.expanduser("~/.config/speech-to-cli/config.json")
PERSONAS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "personas.json")

# Module-level Azure client (created once, reused across queries)
_azure_client = None
_azure_client_key = None  # (endpoint, api_key) tuple to detect config changes


def _load_persona():
    """Load scrying-pool persona from DB."""
    try:
        return realm_db.get_persona("scrying-pool") or {}
    except Exception:
        return {}


def _get_system_prompt():
    persona = _load_persona()
    base = persona.get("system_prompt",
        "You are The Scrying Pool, the AI oracle. Answer questions about the realm. "
        "Keep responses to 2-3 sentences. Be poetic but informative.")
    return base + "\n\nYou have access to the current realm state below.\n\n"


def _load_chat_config():
    """Load Azure AI config from DB, falling back to JSON file."""
    try:
        cfg = realm_db.get_settings("chat")
        if cfg:
            return cfg
    except Exception:
        pass
    if os.path.exists(CHAT_CONFIG_PATH):
        with open(CHAT_CONFIG_PATH) as f:
            return json.load(f)
    return {}


def _load_realm_context():
    """Fetch current realm status for context."""
    try:
        with urllib.request.urlopen(f"{MAP_URL}/status", timeout=5) as r:
            status = json.loads(r.read())
        # Trim to essentials to save tokens
        ctx = {}
        if "ha" in status:
            ctx["ha_states"] = {k: v["sublabel"] for k, v in status["ha"].items()}
        if "wifi" in status:
            ctx["wifi_clients"] = status["wifi"]
        astral = status.get("astral", {})
        nodes = astral.get("nodes", {})
        ctx["online_nodes"] = [k for k, v in nodes.items() if v]
        ctx["offline_nodes"] = [k for k, v in nodes.items() if not v]
        if astral.get("nft"):
            ctx["wan_bytes"] = astral["nft"].get("wan", 0)
        ctx["realm_scale"] = status.get("realm_scale", 0)
        forge = status.get("forge", {})
        ctx["cpu_usage"] = forge.get("usage", 0)
        ctx["cpu_temp"] = forge.get("temp")
        mana = status.get("mana", {})
        ctx["ram_usage"] = mana.get("usage", 0)
        return json.dumps(ctx, indent=1)
    except Exception as e:
        return f"(realm status unavailable: {e})"


def _get_azure_client(config):
    """Return a reusable AzureOpenAI client, recreating only if config changes."""
    global _azure_client, _azure_client_key
    endpoint = config.get("endpoint", "")
    api_key = config.get("api_key", "")
    key = (endpoint, api_key)
    if _azure_client is None or _azure_client_key != key:
        _azure_client = AzureOpenAI(
            azure_endpoint=endpoint,
            api_key=api_key,
            api_version="2024-12-01-preview",
        )
        _azure_client_key = key
    return _azure_client


def _call_azure(config, system_prompt, user_message):
    """Call Azure AI chat completion via OpenAI SDK (non-streaming, synchronous)."""
    endpoint = config.get("endpoint", "")
    api_key = config.get("api_key", "")
    persona = _load_persona()
    deployment = persona.get("model", config.get("oracle_model", "o1"))

    if not endpoint or not api_key:
        return "(Oracle cannot connect to the Aether — no Azure AI config found)"

    is_reasoning = any(deployment.startswith(p) for p in ("o1", "o3", "o4"))
    sys_role = "developer" if is_reasoning else "system"

    client = _get_azure_client(config)

    kwargs = {
        "model": deployment,
        "messages": [
            {"role": sys_role, "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "max_completion_tokens": 4096 if is_reasoning else 2048,
    }
    if is_reasoning:
        kwargs["extra_body"] = {"reasoning_effort": persona.get("reasoning_effort", "high")}

    try:
        response = client.chat.completions.create(**kwargs)
        return response.choices[0].message.content.strip()
    except Exception as e:
        return f"(The waters grow cloudy... {e})"


def _post_event(event):
    """POST a speech event to the map server."""
    try:
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            f"{MAP_URL}/event", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=3)
        return True
    except Exception as e:
        print(f"  Failed to post event: {e}")
        return False


def _speak(text, voice="en-US-BrianNeural"):
    """Speak text via Azure Speech TTS (direct API call)."""
    try:
        cfg = {}
        try:
            cfg = realm_db.get_settings("speech") or {}
        except Exception:
            pass
        # Secrets (speech_key, speech_region) may not be in DB — fall back to JSON
        if not cfg.get("speech_key") and os.path.exists(SPEECH_CONFIG_PATH):
            with open(SPEECH_CONFIG_PATH) as f:
                cfg.update(json.load(f))
        key = cfg.get("speech_key", os.environ.get("AZURE_SPEECH_KEY", ""))
        region = cfg.get("speech_region", os.environ.get("AZURE_SPEECH_REGION", ""))
        if not key or not region:
            return

        ssml = (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
            f'<voice name="{voice}">{text}</voice></speak>'
        )
        url = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
        req = urllib.request.Request(url, data=ssml.encode("utf-8"), headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            audio = r.read()

        # Play via aplay or mpv
        import subprocess
        proc = subprocess.Popen(
            ["mpv", "--no-terminal", "--no-video", "-"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        proc.communicate(audio, timeout=30)
    except Exception as e:
        print(f"  TTS failed: {e}")


def oracle_loop(poll_interval=10, use_voice=True, once=False):
    """Main loop: poll for oracle queries and respond."""
    chat_config = _load_chat_config()
    if not chat_config.get("api_key"):
        print("Warning: No Azure AI API key found in chat assistant config")

    last_ts = time.time()  # Only process queries from after daemon starts
    backoff = 0  # Exponential backoff on poll errors (0 = no backoff)
    BACKOFF_BASE = 5
    BACKOFF_MAX = 60
    print(f"Oracle Daemon: polling every {poll_interval}s")
    print(f"  Map server: {MAP_URL}")
    persona = _load_persona()
    print(f"  Azure model: {persona.get('model', 'o1')}")
    print(f"  Reasoning: {persona.get('reasoning_effort', 'high')}")
    print(f"  Voice: {'enabled' if use_voice else 'disabled'}")

    while True:
        try:
            with urllib.request.urlopen(f"{MAP_URL}/events?since={last_ts}", timeout=5) as r:
                events = json.loads(r.read())

            for evt in events:
                if evt.get("type") != "oracle_query":
                    last_ts = max(last_ts, evt.get("ts", 0))
                    continue

                query = evt.get("text", "")
                ts = evt.get("ts", 0)
                last_ts = max(last_ts, ts)

                print(f"\n[Oracle Query] {query}")

                # Build context
                realm_ctx = _load_realm_context()
                system = _get_system_prompt() + f"CURRENT REALM STATE:\n{realm_ctx}"

                # Generate response
                response = _call_azure(chat_config, system, query)
                print(f"  Response: {response}")

                # Post speech event
                _post_event({
                    "type": "oracle_response",
                    "node": "scrying-pool",
                    "text": response,
                    "color": "#e0b0ff",
                })

                # Speak aloud
                if use_voice:
                    voice = _load_persona().get("voice", "en-US-BrianNeural")
                    _speak(response, voice=voice)

            backoff = 0  # Reset on successful poll

        except Exception as e:
            print(f"  Poll error: {e}")
            if backoff == 0:
                backoff = BACKOFF_BASE
            else:
                backoff = min(backoff * 2, BACKOFF_MAX)
            print(f"  Retrying in {backoff}s")

        if once:
            break
        time.sleep(backoff if backoff else poll_interval)


if __name__ == "__main__":
    realm_db.init()
    parser = argparse.ArgumentParser(description="Oracle Daemon — auto-answer map queries")
    parser.add_argument("--interval", type=int, default=10, help="Poll interval in seconds")
    parser.add_argument("--no-voice", action="store_true", help="Disable TTS")
    parser.add_argument("--once", action="store_true", help="Process pending queries and exit")
    args = parser.parse_args()
    oracle_loop(poll_interval=args.interval, use_voice=not args.no_voice, once=args.once)
