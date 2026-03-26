"""Chat plugin — Azure AI chat integration for the realm map.

Delegates to chat_bridge for session-based chat with o4-mini.
Provides /chat, /chat/clear, /chat/sessions, /chat/history endpoints.
"""

import asyncio
import json
import threading

import chat_bridge

# Module-level asyncio event loop (avoids creating/destroying per request)
_async_loop = asyncio.new_event_loop()


def _start_async_loop():
    asyncio.set_event_loop(_async_loop)
    _async_loop.run_forever()


_async_thread = threading.Thread(target=_start_async_loop, daemon=True)
_async_thread.start()

# Set by setup()
_push_event = None


def handle_chat(req, params):
    """POST /chat — send a chat message, get an AI response."""
    try:
        data = req.json()
        message = data.get("message", "").strip()
        if not message:
            req.respond({"error": "Missing 'message'"}, 400)
            return None
        node_id = data.get("node")
        session = data.get("session")
        extra_context = data.get("context")
        future = asyncio.run_coroutine_threadsafe(
            chat_bridge.chat(message, node_id, session, extra_context),
            _async_loop,
        )
        result = future.result(timeout=120)
        if result.get("error"):
            req.respond(result, 500)
            return None
        response_text = result.get("response") or ""
        if _push_event:
            _push_event({
                "type": "oracle_query",
                "node": node_id or "scrying-pool",
                "text": message[:100] + ("..." if len(message) > 100 else ""),
            })
            if response_text:
                _push_event({
                    "type": "oracle_response",
                    "node": node_id or "scrying-pool",
                    "text": response_text[:200] + ("..." if len(response_text) > 200 else ""),
                })
        return result
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None


def handle_chat_clear(req, params):
    """POST /chat/clear — clear a chat session's history."""
    try:
        data = req.json()
        chat_bridge.clear_session(data.get("session"))
        return {"ok": True}
    except (json.JSONDecodeError, KeyError) as e:
        req.respond({"error": str(e)}, 400)
        return None


def handle_sessions(req, params):
    """GET /chat/sessions — list all chat sessions."""
    sessions = chat_bridge.list_sessions()
    return {"sessions": sessions, "current": chat_bridge.DEFAULT_SESSION}


def handle_history(req, params):
    """GET /chat/history — get chat history for a session."""
    qp = req.query_params
    session = qp.get("session")
    history = chat_bridge.get_session_history(session)
    return {"history": history, "session": session or chat_bridge.DEFAULT_SESSION}


def setup(ctx):
    """Plugin setup — store push_event reference, expose chat API."""
    global _push_event
    _push_event = ctx._push_event

    ctx.expose_api({
        "chat": chat_bridge.chat,
        "list_sessions": chat_bridge.list_sessions,
        "get_session_history": chat_bridge.get_session_history,
        "clear_session": chat_bridge.clear_session,
    })

    ctx.log("Oracle Link chat bridge active")
