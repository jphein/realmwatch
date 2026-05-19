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


def main() -> None:
    mcp = FastMCP("realm")
    registered = tools.register_all(mcp)
    print(
        f"[mcp] registered {len(registered)} tools — "
        + ", ".join(t["name"] for t in registered),
        file=sys.stderr,
    )
    # FastMCP defaults to stdio when run() is called without a transport arg.
    mcp.run()


if __name__ == "__main__":
    main()
