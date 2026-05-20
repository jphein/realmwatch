"""MCP tools exposed by the palace plugin.

Per Wave 2 convention: each tool is a ``(name, fn, description)`` tuple.
The mcp plugin's auto-aggregation follow-up picks these up and registers
them on the Astral Conduit at launch.

Five tools:
  palace_search   — semantic search across the palace
  palace_recall   — fetch a single drawer by id
  palace_list     — query-free metadata browse
  palace_deposit  — drop a new memory into the palace (Claude Code-writable)
  palace_health   — liveness + version of palace-daemon

All tools instantiate a fresh PalaceClient via the same URL-resolution
logic used by the plugin itself, so they work in both the in-realmwatch
import path and the standalone stdio launcher path.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

# Make sibling modules importable in both load paths.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

_REPO_ROOT = _THIS_DIR.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from client import PalaceClient  # type: ignore  # noqa: E402


DEFAULT_FALLBACK_URL = "http://disks.jphe.in:8085"


def _resolve_base_url() -> str:
    """Mirror plugin.py's URL resolution (env > fleet > fallback)."""
    env = os.environ.get("PALACE_DAEMON_URL", "").strip()
    if env:
        return env
    try:
        import realm_fleet  # type: ignore
        host_ip = realm_fleet.host_ip("palace-daemon")
        if host_ip:
            if not host_ip.startswith(("http://", "https://")):
                host_ip = f"http://{host_ip}"
            return host_ip
    except Exception:
        pass
    return DEFAULT_FALLBACK_URL


_client: Optional[PalaceClient] = None


def _get_client() -> PalaceClient:
    """Cache one PalaceClient instance per process."""
    global _client
    if _client is None:
        _client = PalaceClient(base_url=_resolve_base_url())
    return _client


def _unwrap(ok: bool, payload):
    """Return payload as-is; on error, return a dict the caller can render."""
    if ok:
        return payload
    if isinstance(payload, dict):
        return payload
    return {"error": str(payload)}


# ── MCP tools ──────────────────────────────────────────────────────────────


def palace_search(query: str, wing: Optional[str] = None,
                  room: Optional[str] = None, limit: int = 10) -> dict:
    """Search the memory palace by semantic similarity.

    Args:
        query: Free-text search query (semantic).
        wing:  Optional wing filter (project slug, e.g., ``"realmwatch"``).
        room:  Optional room filter — one of architecture, decisions,
               problems, planning, sessions, references, discoveries.
        limit: Max results (1-100, default 10).

    Returns palace-daemon's response payload, typically containing
    ``{"results": [...]}`` where each result has ``title``, ``wing``,
    ``room``, ``score``, and ``id`` fields.
    """
    ok, payload = _get_client().search(query, limit=limit, wing=wing, room=room)
    return _unwrap(ok, payload)


def palace_recall(drawer_id: str) -> dict:
    """Recall a single drawer (memory) from the palace by id.

    Args:
        drawer_id: The drawer's unique id from palace-daemon's metadata.

    Returns the drawer's full content (title, body, wing, room, ts, ...)
    or ``{"error": ...}`` on miss.
    """
    ok, payload = _get_client().recall(drawer_id)
    return _unwrap(ok, payload)


def palace_list(wing: Optional[str] = None, room: Optional[str] = None,
                limit: int = 50, offset: int = 0) -> dict:
    """List drawers by wing/room without a query — pure metadata browse.

    Args:
        wing:   Optional wing filter.
        room:   Optional room filter.
        limit:  Max results (1-500, default 50).
        offset: Pagination offset.

    Returns palace-daemon's ``/list`` response.
    """
    ok, payload = _get_client().list_drawers(
        wing=wing, room=room, limit=limit, offset=offset)
    return _unwrap(ok, payload)


def palace_deposit(wing: str, room: str, title: str, body: str = "") -> dict:
    """Deposit a new memory into the palace.

    Args:
        wing:  Wing slug (project name, no ``wing_`` prefix).
        room:  Canonical 7-room taxonomy — one of architecture, decisions,
               problems, planning, sessions, references, discoveries.
        title: One-line title (required).
        body:  Long-form content (optional, indexed for search).

    Returns palace-daemon's deposit response — typically
    ``{"id": "<drawer_id>", "ok": true}`` or ``{"queued": true, ...}``
    if a rebuild is in progress.
    """
    ok, payload = _get_client().deposit(
        wing=wing, room=room, title=title, body=body)
    return _unwrap(ok, payload)


def palace_health() -> dict:
    """Liveness + version of palace-daemon. Returns
    ``{"status": "ok", "version": "1.7.2", ...}`` or an error dict if the
    daemon is unreachable.
    """
    ok, payload = _get_client().health()
    return _unwrap(ok, payload)


# ── Tool registry (Wave 2 shape, picked up by plugins/mcp/) ────────────────

MCP_TOOLS: list[tuple] = [
    ("palace_search", palace_search,
     "Semantic search across the memory palace; optional wing/room filters."),
    ("palace_recall", palace_recall,
     "Recall one drawer by id."),
    ("palace_list", palace_list,
     "Query-free metadata browse by wing/room."),
    ("palace_deposit", palace_deposit,
     "Deposit a new memory (wing, room, title, body) into the palace."),
    ("palace_health", palace_health,
     "palace-daemon liveness + version."),
]

# Compat alias for plugins that follow the codex shape (TOOLS).
TOOLS = MCP_TOOLS
