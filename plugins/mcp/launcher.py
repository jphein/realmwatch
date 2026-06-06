#!/usr/bin/env python3
"""Standalone MCP server entrypoint for realmwatch.

Claude Code (and other MCP clients) launch this as a subprocess and speak
MCP over stdio. The realmwatch HTTP server doesn't need to be running for
read tools to work — they hit realm.db, fleet.yaml, and the lexicon helper
directly. Tools that wrap live engine state (realm_status) require the
modules to import cleanly, but not the HTTP server itself.

Usage (Claude Code .mcp.json):

    {
      "mcpServers": {
        "realm": {
          "command": "/home/jp/Projects/realmwatch/.venv/bin/python3",
          "args": ["/home/jp/Projects/realmwatch/plugins/mcp/launcher.py"]
        }
      }
    }

TODO (Wave 2+): add an SSE transport mode behind /mcp/sse on the realmwatch
HTTP server so clients can attach without spawning a subprocess.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Make `import tools` resolve to the sibling tools.py regardless of cwd.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from fastmcp import FastMCP  # noqa: E402

import tools  # noqa: E402


def _register_plugin_tools(mcp) -> list[str]:
    """Discover each plugin's mcp_tools.py and register its MCP_TOOLS.

    Lightweight stand-in for the pending Wave 1.5 auto-aggregation: scans
    plugins/<name>/mcp_tools.py for an MCP_TOOLS list of (name, fn, desc)
    tuples. Defensive — a plugin whose module fails to import (e.g. ones using
    package-relative imports) is skipped without taking down the conduit.
    """
    import importlib.util
    plugins_dir = _THIS_DIR.parent
    names: list[str] = []
    for mt in sorted(plugins_dir.glob("*/mcp_tools.py")):
        if mt.parent.name == "mcp":
            continue
        try:
            spec = importlib.util.spec_from_file_location(f"_pluginmcp_{mt.parent.name}", mt)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            entries = getattr(mod, "MCP_TOOLS", None) or getattr(mod, "TOOLS", None) or []
            for entry in entries:
                if isinstance(entry, tuple) and len(entry) >= 2:
                    name, fn = entry[0], entry[1]
                    desc = entry[2] if len(entry) > 2 else (fn.__doc__ or "")
                    mcp.tool(name=name, description=desc)(fn)
                    names.append(name)
        except Exception as e:  # noqa: BLE001 — never let one plugin break the conduit
            print(f"[mcp] skipped {mt.parent.name}/mcp_tools.py: {e}", file=sys.stderr)
    return names


def main() -> None:
    mcp = FastMCP("realm")
    registered = tools.register_all(mcp)
    plugin_tool_names = _register_plugin_tools(mcp)
    all_names = [t["name"] for t in registered] + plugin_tool_names
    print(
        f"[mcp] registered {len(all_names)} tools — " + ", ".join(all_names),
        file=sys.stderr,
    )
    # FastMCP defaults to stdio when run() is called without a transport arg.
    mcp.run()


if __name__ == "__main__":
    main()
