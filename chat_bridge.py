#!/usr/bin/env python3
"""Chat bridge — Azure AI chat integration for the realm map.

Provides session-based chat with o4-mini, maintaining context about nodes.
Uses the same session DB as azure-chat-assistant MCP server for shared sessions.
"""

import hashlib
import httpx
import json
import os
import sqlite3
import time
from openai import AsyncAzureOpenAI
import realm_db

# Config
CONFIG_DIR = os.path.expanduser("~/.config/azure-chat-assistant")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")
SESSION_DB_PATH = os.path.join(CONFIG_DIR, "sessions.db")
DEFAULT_MODEL = "o4-mini"
TIMEOUT = 60

# In-memory response cache
_cache = {}
CACHE_MAX = 100

# Cached Azure AI client (avoids creating httpx connection pool per request)
_ai_client = None
_ai_client_key = None  # (endpoint, api_key) tuple to detect config changes

# Default session for realm map
DEFAULT_SESSION = "realm-chat"


def _init_session_db():
    """Initialize session DB if needed (same schema as azure-chat-assistant)."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with sqlite3.connect(SESSION_DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                name TEXT PRIMARY KEY,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_name TEXT,
                role TEXT,
                content TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_name) REFERENCES sessions(name) ON DELETE CASCADE
            )
        """)
        conn.execute("INSERT OR IGNORE INTO sessions (name) VALUES (?)", (DEFAULT_SESSION,))


def _load_config():
    """Load config from azure-chat-assistant config file."""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
    return {}


def _get_api_key():
    """Get API key from env or config file."""
    env_key = os.environ.get("AZURE_AI_API_KEY", "")
    if env_key:
        return env_key
    return _load_config().get("api_key", "")


def _get_endpoint():
    """Get endpoint from env or config file."""
    env_ep = os.environ.get("AZURE_AI_ENDPOINT", "")
    if env_ep:
        return env_ep
    return _load_config().get("endpoint", "https://aiserviceswcd.services.ai.azure.com")


def get_session_history(session_name=None):
    """Get chat history for a session from DB (shared with azure-chat-assistant)."""
    _init_session_db()
    session = session_name or DEFAULT_SESSION
    try:
        with sqlite3.connect(SESSION_DB_PATH) as conn:
            cursor = conn.execute(
                "SELECT role, content FROM messages WHERE session_name = ? ORDER BY id ASC",
                (session,)
            )
            return [{"role": r, "content": c} for r, c in cursor.fetchall()]
    except Exception:
        return []


def add_to_history(session_name, role, content):
    """Add a message to session history."""
    _init_session_db()
    session = session_name or DEFAULT_SESSION
    try:
        with sqlite3.connect(SESSION_DB_PATH) as conn:
            # Ensure session exists
            conn.execute("INSERT OR IGNORE INTO sessions (name) VALUES (?)", (session,))
            conn.execute(
                "INSERT INTO messages (session_name, role, content) VALUES (?, ?, ?)",
                (session, role, content)
            )
    except Exception:
        pass


def clear_session(session_name=None):
    """Clear a session's history."""
    _init_session_db()
    session = session_name or DEFAULT_SESSION
    try:
        with sqlite3.connect(SESSION_DB_PATH) as conn:
            conn.execute("DELETE FROM messages WHERE session_name = ?", (session,))
    except Exception:
        pass


def list_sessions():
    """List all chat sessions."""
    _init_session_db()
    try:
        with sqlite3.connect(SESSION_DB_PATH) as conn:
            cursor = conn.execute("SELECT name FROM sessions ORDER BY created_at DESC")
            return [r[0] for r in cursor.fetchall()]
    except Exception:
        return []


def build_node_context(node_id):
    """Build context about a node for the chat."""
    node = realm_db.get_node(node_id)
    if not node:
        return f"Node '{node_id}' not found in topology."

    persona = realm_db.get_persona(node_id)

    ctx_parts = [f"Node: {node.get('label', node_id)}"]
    if node.get("sublabel"):
        ctx_parts.append(f"Details: {node['sublabel']}")
    if node.get("ip"):
        ctx_parts.append(f"IP: {node['ip']}")
    if node.get("type"):
        ctx_parts.append(f"Type: {node['type']}")
    if node.get("mac"):
        ctx_parts.append(f"MAC: {node['mac']}")

    if persona:
        if persona.get("name"):
            ctx_parts.append(f"Persona: {persona['name']}")
        if persona.get("title"):
            ctx_parts.append(f"Title: {persona['title']}")
        if persona.get("hints"):
            ctx_parts.append(f"Character hints: {', '.join(persona['hints'])}")

    return " | ".join(ctx_parts)


def build_system_prompt(node_id=None, extra_context=None):
    """Build system prompt with realm and node context."""
    base = """You are an AI assistant embedded in a fantasy-themed network monitoring system called "The Realm".
The Realm visualizes a home network as a magical kingdom with nodes as locations/characters.
Speak in a helpful but slightly mystical tone. Keep responses concise (2-3 sentences unless asked for detail)."""

    parts = [base]

    if node_id:
        node_ctx = build_node_context(node_id)
        parts.append(f"\nContext about the node being discussed:\n{node_ctx}")

    if extra_context:
        parts.append(f"\nAdditional context:\n{extra_context}")

    return "\n".join(parts)


async def chat(message, node_id=None, session_name=None, extra_context=None):
    """Send a chat message and get a response.

    Args:
        message: User message
        node_id: Optional node ID for context
        session_name: Optional session name (default: realm-chat)
        extra_context: Optional additional context string

    Returns:
        dict with 'response', 'model', 'latency_ms', 'error' (if any)
    """
    global _cache

    session = session_name or DEFAULT_SESSION
    api_key = _get_api_key()
    endpoint = _get_endpoint()

    if not api_key:
        return {"error": "No Azure API key configured", "response": None}

    # Build messages
    system_prompt = build_system_prompt(node_id, extra_context)
    history = get_session_history(session)

    messages = [{"role": "developer", "content": system_prompt}]  # o4-mini uses developer role

    # Add history (last 10 turns = 20 messages)
    for msg in history[-20:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": message})

    # Check cache
    msg_hash = hashlib.md5(json.dumps(messages, separators=(',', ':')).encode()).hexdigest()
    cache_key = f"{DEFAULT_MODEL}:{msg_hash}"

    if cache_key in _cache:
        cached = _cache[cache_key]
        return {
            "response": cached["response"],
            "model": DEFAULT_MODEL,
            "latency_ms": 0,
            "cached": True
        }

    # Reuse cached client (avoids leaking httpx connection pools per request)
    global _ai_client, _ai_client_key
    key = (endpoint, api_key)
    if _ai_client is None or _ai_client_key != key:
        _ai_client = AsyncAzureOpenAI(
            azure_endpoint=endpoint,
            api_key=api_key,
            api_version="2024-12-01-preview",
        )
        _ai_client_key = key
    client = _ai_client

    start = time.time()
    try:
        response = await client.chat.completions.create(
            model=DEFAULT_MODEL,
            messages=messages,
            max_completion_tokens=500,
        )
        latency = int((time.time() - start) * 1000)
        content = response.choices[0].message.content or ""

        if not content:
            return {"error": "Empty response from model", "response": None}

        # Cache and save to history
        _cache[cache_key] = {"response": content, "ts": time.time()}
        if len(_cache) > CACHE_MAX:
            # Remove oldest entries
            sorted_keys = sorted(_cache.keys(), key=lambda k: _cache[k].get("ts", 0))
            for k in sorted_keys[:20]:
                del _cache[k]

        add_to_history(session, "user", message)
        add_to_history(session, "assistant", content)

        return {
            "response": content,
            "model": DEFAULT_MODEL,
            "latency_ms": latency,
            "cached": False
        }

    except httpx.TimeoutException:
        return {"error": f"Request timed out after {TIMEOUT}s", "response": None}
    except Exception as e:
        return {"error": str(e), "response": None}


# For testing
if __name__ == "__main__":
    import asyncio
    realm_db.init()

    async def test():
        result = await chat("What is the status of the realm?", node_id="katana")
        print(json.dumps(result, indent=2))

    asyncio.run(test())
