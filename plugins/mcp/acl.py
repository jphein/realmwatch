"""Per-tool ACL gating for the Astral Conduit (issue #85).

The conduit exposes both read and mutating MCP tools. Mutating tools wrap
live realm state — SSH execution, fleet renames, XP grants, ward casting,
quest transitions, WoL power ops. This module provides an *opt-in* gate so a
deployment can require an explicit allowlist before any mutating tool runs,
without breaking existing stdio usage (enforcement is OFF by default).

Design (decided in Wave 2):
- Tools are classified READ vs MUTATING by name (MUTATING_TOOLS below). Read
  tools are *always* allowed — the gate only ever touches mutating tools.
- Enforcement is OFF unless ``REALM_MCP_GATE_MUTATING=1``. When ON, a mutating
  tool is allowed only if it is listed in either:
    * ``REALM_MCP_ALLOW`` — comma-separated tool names; ``*`` allows all, or
    * ``~/.realmwatch/mcp-acl.json`` — ``{"allow": ["tool_a", "tool_b"]}``
      (``"*"`` in that list also allows all).
- A gated call returns a structured error dict (never raises) so the MCP
  client sees a clean tool result rather than a transport-level failure.

The check runs at *call time*, not import time, so env/config changes between
launches are honoured and a mutating tool's gating never depends on import
ordering. Wrapping preserves ``__name__``/``__doc__``/signature via
``functools.wraps`` so FastMCP's schema introspection is unaffected.
"""

from __future__ import annotations

import functools
import json
import os
import sys
from pathlib import Path
from typing import Callable

# Repo root on sys.path so realm_text.real_home() resolves (sudo-aware home).
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from realm_text import real_home  # noqa: E402


# Canonical set of mutating tool names across the core registry and every
# plugin's mcp_tools.py. Anything NOT in this set is treated as read-only and
# is always allowed. Keep this in sync when a plugin adds a write tool.
MUTATING_TOOLS: frozenset[str] = frozenset({
    # core (plugins/mcp/tools.py)
    "ssh_run",
    "fleet_rename",
    "post_event",
    # realm-engine
    "update_profile_tool",
    "ingest_event_tool",
    # progression
    "grant_xp",
    "unlock_skill",
    "grant_achievement",
    # quests
    "accept_quest",
    "complete_quest",
    "generate_quest_from_event",
    # combat-ward
    "cast_ward",
    # codex (node_lore is get-or-set; add_journal appends)
    "node_lore",
    "add_journal",
    # wol
    "wol_wake",
    "wol_sleep",
    # palace
    "palace_deposit",
})


def is_mutating(name: str) -> bool:
    """True if the named tool mutates realm state."""
    return name in MUTATING_TOOLS


def gating_enabled() -> bool:
    """True when mutating-tool enforcement is switched on via env."""
    return os.environ.get("REALM_MCP_GATE_MUTATING", "") == "1"


def _acl_json_path() -> Path:
    return real_home() / ".realmwatch" / "mcp-acl.json"


def load_allowlist() -> set[str]:
    """Merge the allowlist from REALM_MCP_ALLOW and ~/.realmwatch/mcp-acl.json.

    Returns a set of allowed tool names. ``*`` (from either source) is kept as
    a literal member; :func:`is_allowed` treats it as "allow all".
    """
    allow: set[str] = set()

    env = os.environ.get("REALM_MCP_ALLOW", "")
    for tok in env.split(","):
        tok = tok.strip()
        if tok:
            allow.add(tok)

    path = _acl_json_path()
    try:
        if path.exists():
            data = json.loads(path.read_text())
            for tok in data.get("allow", []) or []:
                tok = str(tok).strip()
                if tok:
                    allow.add(tok)
    except (OSError, ValueError):
        # Malformed/unreadable ACL file → fall back to env-only allowlist.
        pass

    return allow


def is_allowed(name: str, allowlist: set[str] | None = None) -> bool:
    """Whether a tool call is permitted under the current ACL.

    Read tools and (when gating is off) all tools are allowed. When gating is
    on, a mutating tool is allowed only if it (or ``*``) is in the allowlist.
    """
    if not is_mutating(name):
        return True
    if not gating_enabled():
        return True
    allow = load_allowlist() if allowlist is None else allowlist
    return "*" in allow or name in allow


def denied_result(name: str) -> dict:
    """Structured error returned in place of a gated mutating tool's result."""
    return {
        "error": (
            f"tool '{name}' is gated by MCP ACL; allow via REALM_MCP_ALLOW "
            "or mcp-acl.json"
        )
    }


def guard(name: str, fn: Callable) -> Callable:
    """Wrap a mutating tool callable with a call-time ACL check.

    Read tools are returned unchanged (no overhead). For mutating tools the
    wrapper re-evaluates the gate on *every* call so env/config edits between
    calls take effect without restarting the conduit. ``functools.wraps``
    preserves the signature/docstring FastMCP introspects for its schema.
    """
    if not is_mutating(name):
        return fn

    @functools.wraps(fn)
    def _gated(*args, **kwargs):
        if is_allowed(name):
            return fn(*args, **kwargs)
        return denied_result(name)

    return _gated


def gate_summary() -> str:
    """One-line startup log describing the current ACL posture."""
    if not gating_enabled():
        return "MCP ACL: gating OFF"
    allow = load_allowlist()
    n = len(MUTATING_TOOLS)
    if "*" in allow:
        return f"MCP ACL: gating ON — {n} mutating tools, all allowed (*)"
    m = len(allow & MUTATING_TOOLS)
    return f"MCP ACL: gating ON — {n} mutating tools, {m} allowed"
