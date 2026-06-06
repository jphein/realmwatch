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


def _ensure_plugins_namespace(plugins_dir: Path) -> None:
    """Register `plugins` as a synthetic namespace package rooted at plugins/.

    Mirrors plugin_loader._ensure_plugins_namespace() so that a plugin's
    `mcp_tools.py` can be imported as `plugins.<name>.mcp_tools` and its
    package-relative imports (`from . import server`, `from .server import …`)
    resolve correctly. Without this every relative-import plugin would raise
    "attempted relative import with no known parent package" and be skipped.
    """
    import importlib.machinery
    import importlib.util
    if "plugins" in sys.modules:
        return
    spec = importlib.machinery.ModuleSpec("plugins", loader=None, is_package=True)
    spec.submodule_search_locations = [str(plugins_dir)]
    pkg = importlib.util.module_from_spec(spec)
    pkg.__path__ = [str(plugins_dir)]
    sys.modules["plugins"] = pkg


def _import_plugin_mcp_tools(name: str, mt: Path, plugins_dir: Path):
    """Import plugins/<name>/mcp_tools.py as `plugins.<name>.mcp_tools`.

    Sets up the `plugins.<name>` package and `__package__` so the module's
    relative imports attach to the right namespace (the same idiom
    plugin_loader uses), then returns the loaded module.
    """
    import importlib.machinery
    import importlib.util

    _ensure_plugins_namespace(plugins_dir)
    pkg_name = f"plugins.{name}"
    if pkg_name not in sys.modules:
        pkg_spec = importlib.machinery.ModuleSpec(pkg_name, loader=None, is_package=True)
        pkg_spec.submodule_search_locations = [str(mt.parent)]
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        pkg_mod.__path__ = [str(mt.parent)]
        sys.modules[pkg_name] = pkg_mod

    mod_name = f"{pkg_name}.mcp_tools"
    spec = importlib.util.spec_from_file_location(
        mod_name, mt, submodule_search_locations=[str(mt.parent)]
    )
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = pkg_name  # so `from . import server` resolves
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _register_plugin_tools(mcp) -> list[str]:
    """Discover each plugin's mcp_tools.py and register its MCP_TOOLS.

    Wave 1.5 auto-aggregation (issue #84): scans plugins/<name>/mcp_tools.py
    for an MCP_TOOLS list of (name, fn, desc) tuples and registers each on the
    conduit alongside the core tools — no manual wiring. Each plugin import is
    isolated in try/except, so one broken or optional plugin (e.g. a backend
    whose dependency is missing) is logged to stderr and skipped without
    taking down the conduit.
    """
    plugins_dir = _THIS_DIR.parent
    names: list[str] = []
    for mt in sorted(plugins_dir.glob("*/mcp_tools.py")):
        plugin_name = mt.parent.name
        if plugin_name == "mcp":
            continue
        try:
            mod = _import_plugin_mcp_tools(plugin_name, mt, plugins_dir)
            if mod is None:
                print(f"[mcp] skipped {plugin_name}/mcp_tools.py: no module spec", file=sys.stderr)
                continue
            entries = getattr(mod, "MCP_TOOLS", None) or getattr(mod, "TOOLS", None) or []
            for entry in entries:
                if isinstance(entry, tuple) and len(entry) >= 2:
                    name, fn = entry[0], entry[1]
                    desc = entry[2] if len(entry) > 2 else (fn.__doc__ or "")
                    mcp.tool(name=name, description=desc)(fn)
                    names.append(name)
        except Exception as e:  # noqa: BLE001 — never let one plugin break the conduit
            print(f"[mcp] skipped {plugin_name}/mcp_tools.py: {e}", file=sys.stderr)
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
