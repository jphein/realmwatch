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

Transport (issue #86): selected by ``REALM_MCP_TRANSPORT``:
    * ``stdio`` (DEFAULT) — speak MCP over stdin/stdout as a subprocess.
    * ``sse`` / ``http`` — serve over HTTP so clients attach over the network
      without spawning a subprocess. Bound to ``REALM_MCP_HOST`` (default
      127.0.0.1) : ``REALM_MCP_PORT`` (default 8765) at path ``/mcp/sse``.
      Connect Claude Code with: ``claude mcp add --transport sse realm \\
      http://127.0.0.1:8765/mcp/sse``.

ACL gating (issue #85): mutating tools are gated by an *opt-in* allowlist —
see ``acl.py``. Enforcement is OFF unless ``REALM_MCP_GATE_MUTATING=1``.
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

import acl  # noqa: E402
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
                    # Opt-in ACL: wrap mutating tools so a gated call returns a
                    # structured error instead of executing (no-op for reads).
                    reg_fn = acl.guard(name, fn)
                    mcp.tool(name=name, description=desc)(reg_fn)
                    names.append(name)
        except Exception as e:  # noqa: BLE001 — never let one plugin break the conduit
            print(f"[mcp] skipped {plugin_name}/mcp_tools.py: {e}", file=sys.stderr)
    return names


def _run_transport(mcp) -> None:
    """Dispatch to the transport selected by REALM_MCP_TRANSPORT.

    Defaults to stdio for backward compatibility. ``sse``/``http`` serve over
    HTTP at REALM_MCP_HOST:REALM_MCP_PORT (default 127.0.0.1:8765) on the
    ``/mcp/sse`` path. FastMCP 3.x accepts "stdio", "sse", "http", and
    "streamable-http"; we keep the SSE-style string per the issue.
    """
    transport = os.environ.get("REALM_MCP_TRANSPORT", "stdio").strip().lower()
    if transport in ("sse", "http", "streamable-http"):
        host = os.environ.get("REALM_MCP_HOST", "127.0.0.1")
        port = int(os.environ.get("REALM_MCP_PORT", "8765"))
        print(
            f"[mcp] transport={transport} — serving on "
            f"http://{host}:{port}/mcp/sse",
            file=sys.stderr,
        )
        mcp.run(transport=transport, host=host, port=port, path="/mcp/sse")
    else:
        # stdio (default): FastMCP speaks MCP over stdin/stdout.
        print("[mcp] transport=stdio", file=sys.stderr)
        mcp.run()


def main() -> None:
    mcp = FastMCP("realm")
    # Install the opt-in ACL gate on mutating tools (no-op for read tools, and
    # fully transparent unless REALM_MCP_GATE_MUTATING=1).
    registered = tools.register_all(mcp, wrap=acl.guard)
    plugin_tool_names = _register_plugin_tools(mcp)
    all_names = [t["name"] for t in registered] + plugin_tool_names
    print(
        f"[mcp] registered {len(all_names)} tools — " + ", ".join(all_names),
        file=sys.stderr,
    )
    print(f"[mcp] {acl.gate_summary()}", file=sys.stderr)
    _run_transport(mcp)


if __name__ == "__main__":
    main()
