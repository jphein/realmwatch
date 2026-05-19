"""The Astral Conduit — MCP server bridge for realmwatch.

This plugin's job inside the realmwatch HTTP process is *minimal*: it
registers a `/mcp/info` diagnostic endpoint that lists the tools an MCP
client would see when it spawned the stdio launcher. The MCP server itself
runs out-of-process — see `plugins/mcp/launcher.py` and the .mcp.json
snippet documented there.

Rationale: realmwatch already owns port 80 and uses a stdlib http.server.
Embedding FastMCP's ASGI app in that loop is awkward; running it stdio-only
via a subprocess that Claude Code launches per session keeps the contracts
simple. SSE transport on `/mcp/sse` is a Wave 2+ follow-up.

Endpoints:
  GET /mcp/info  — diagnostic JSON: launcher path, fastmcp version,
                   registered tool list with categories + summaries.
"""

from __future__ import annotations

import sys
from pathlib import Path


_PLUGIN_DIR = Path(__file__).resolve().parent
_LAUNCHER = _PLUGIN_DIR / "launcher.py"


def _safe_import_tools():
    """Import the tools module lazily so a missing fastmcp doesn't kill
    plugin loading — we still want /mcp/info to respond with a clear error.
    """
    if str(_PLUGIN_DIR) not in sys.path:
        sys.path.insert(0, str(_PLUGIN_DIR))
    try:
        import tools  # type: ignore
        return tools, None
    except Exception as e:  # ImportError, anything from path injection
        return None, f"{type(e).__name__}: {e}"


def _fastmcp_version() -> str | None:
    try:
        import fastmcp
        return getattr(fastmcp, "__version__", "unknown")
    except ImportError:
        return None


def setup(ctx):
    """Register /mcp/info and log the launcher path."""

    tools, tools_err = _safe_import_tools()
    fastmcp_ver = _fastmcp_version()

    def info_handler(req, params):
        if tools is None:
            return req.respond({
                "ok": False,
                "error": tools_err or "tools module failed to import",
                "launcher": str(_LAUNCHER),
                "fastmcp_version": fastmcp_ver,
            }, status=500)

        tool_list = [
            {
                "name": spec["fn"].__name__,
                "category": spec["category"],
                "summary": spec["summary"],
            }
            for spec in tools.TOOLS
        ]
        return req.respond({
            "ok": True,
            "transport": "stdio",
            "launcher": str(_LAUNCHER),
            "fastmcp_version": fastmcp_ver,
            "tool_count": len(tool_list),
            "tools": tool_list,
            "notes": (
                "Run the launcher as an MCP subprocess. Claude Code config: "
                f'{{"command":"<venv>/bin/python3","args":["{_LAUNCHER}"]}}.'
            ),
        })

    ctx.register_endpoint("GET", "/mcp/info", info_handler, raw_path=True)

    if tools is None:
        ctx.log(f"WARN: MCP tools failed to import ({tools_err}); /mcp/info will error")
        return

    if fastmcp_ver is None:
        ctx.log("WARN: fastmcp not installed in the venv; launcher will fail until "
                "`uv pip install fastmcp` is run")
    else:
        ctx.log(f"astral conduit ready — fastmcp {fastmcp_ver}, {len(tools.TOOLS)} tools "
                f"available via {_LAUNCHER}")
