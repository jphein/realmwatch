# Realmwatch Plugins

Drop-in extensions for Realmwatch. Each plugin lives in its own subdirectory.
**47 plugins** ship today, covering UI panels, data bridges, discovery,
infrastructure, the game layer (XP / quests / wards / codex), and an MCP
server.

## Structure

```
plugins/
  <plugin-name>/
    plugin.json          # Manifest (required)
    plugin.py            # Python entry point (required for `integrated` plugins)
    panel.html           # Panel template fragment (optional)
    panel.js             # Frontend code (optional)
    panel.css            # Styles (optional)
    mcp_tools.py         # MCP tool registry (optional — for plugins/mcp/ to aggregate)
    cli                  # Method-A CLI executable (optional)
    db.py / server.py    # Plugin-local backend (recommended for non-trivial plugins)
    <name>.service       # systemd unit template (spec only — see below)
    requirements.txt     # Additional pip dependencies (optional)
```

## Plugin Types

- **integrated** — runs inside map_server process (background threads, SSE, enrichment).
  This is the only lifecycle exercised today; all 47 current plugins are integrated.
- **standalone** *(spec only)* — separate systemd process, communicates via HTTP API.
  Reserved in the manifest schema; no plugin uses this type yet.
- **on-demand** *(spec only)* — invoked by user action, runs as subprocess.
  Reserved; no plugin uses this type yet.

## Creating a Plugin

1. Create a directory under `plugins/` with your plugin name.
2. Add a `plugin.json` manifest. Minimal shape:

   ```json
   {
     "name": "my-plugin",
     "version": "0.1.0",
     "type": "integrated",
     "description": "What this plugin does",
     "fantasy_name": "The Foo Bar",
     "icon": "🜂",
     "priority": 50,
     "depends_on": [],
     "python": { "module": "plugin", "entry": "setup" }
   }
   ```

3. Implement `setup(ctx)` in `plugin.py` — receives a `PluginContext`.
4. Restart map_server to load (no hot reload).

See `plugins/lexicon/`, `plugins/mcp/`, and any of the game-layer plugins
(`realm-engine`, `progression`, `quests`, `combat-ward`, `codex`) for
production reference shapes.

## Patterns established by the May 2026 absorption wave

These patterns were established when realmwatch absorbed os.realm.watch's
RPG layer. Follow them for any new plugin.

### Use `raw_path=True` for endpoints outside `/plugins/<name>/`

By default, `ctx.register_endpoint("/foo", handler)` mounts at
`/plugins/<name>/foo`. If your plugin needs to register at the URL root —
e.g. `/codex-sync`, `/combat-ward/threats`, `/progression/player` — set
`raw_path=True` and the dispatcher uses your path verbatim:

```python
ctx.register_endpoint(
    "GET", "/combat-ward/threats",
    handle_threats,
    raw_path=True,
)
```

The priority for raw_path endpoints is `PRIORITY_RAW_PATH=10` — they will
NOT shadow core map_server handlers (priority 0). To override a core
handler you must register with `priority=PRIORITY_CORE` (rare; needs
justification).

### Loose coupling — `expose_api` / `get_plugin_api`

Plugins talk to each other through the context, not imports:

```python
# In plugin.py setup() — publish your API:
ctx.expose_api({
    "grant_xp": grant_xp,
    "get_level_info": get_level_info,
    "mcp_tools": MCP_TOOLS,
})

# In another plugin — consume:
prog = ctx.get_plugin_api("progression")
if prog:
    prog["grant_xp"](player_id="default", amount=50, source_type="manual")
```

`get_plugin_api()` returns `None` if the target plugin isn't loaded —
**always guard your call**. For chronicle-style ambient hooks, the
recommended pattern is **lazy resolution per call** rather than caching
the API reference at setup time (avoids load-order pitfalls).

### Event bus — `on_event` / `push_event`

For pub-sub patterns (XP grants, threat alerts, quest completions), use
the realm-event bus instead of plugin-to-plugin function calls:

```python
# Subscribe (in setup()):
ctx.on_event("xp.grant", _handle_xp_grant)
ctx.on_event("port_scan", _handle_port_scan)

# Emit (anywhere):
ctx.push_event(type="xp.grant", amount=100, source_type="quest", quest_id=qid)
```

Dispatch keys off the **event `type` field** (not the SSE channel name).
`realm-event` is the SSE channel, NOT a subscribable event type. If you
want every event, wrap `map_server.push_event` (see `plugins/realm-engine/`)
or subscribe to each type you care about explicitly.

### Game DB pattern — `~/.realmwatch/game.db`

The RPG layer (realm-engine, progression, quests, combat-ward, codex)
shares a sidecar SQLite at `~/.realmwatch/game.db`. Conventions:

1. **Path resolution.** Always use `realm_text.real_home()` to resolve the
   home dir — `os.path.expanduser("~")` returns `/root` under sudo, which
   is wrong on every map_server install. The plugin-local pattern is:

   ```python
   from realm_text import real_home
   DB_PATH = real_home() / ".realmwatch" / "game.db"
   ```

   Override via `REALM_GAME_DB` env var if needed (tests, isolated worktrees).

2. **Schema bootstrap.** Declare `CREATE TABLE IF NOT EXISTS` in your
   plugin's `db.py`. Multiple plugins can safely declare the same table —
   first loader wins, subsequent loaders are no-ops. Don't seed data
   another plugin already seeds (e.g. `realm-engine` seeds codex entries;
   don't double-seed in `codex/`).

3. **Connection per call.** Open `sqlite3.connect()` per query, set
   `row_factory = sqlite3.Row`, close when done. WAL mode is set once by
   whoever creates the DB first; subsequent opens inherit it.

4. **FK target stubs.** If your plugin FK-references a table owned by
   another plugin (e.g. progression's `players` FKs to `entities`),
   declare a minimal stub `CREATE TABLE IF NOT EXISTS entities (...)` in
   your own `db.py` so a fresh game.db can boot in any plugin load order.

### Plugin-loader sys.modules caching gotcha

The plugin loader imports `plugin.py` via `importlib.util.spec_from_file_location`
without registering the plugin dir as a package, so `from . import sibling`
fails. The naive workaround — `sys.path.insert(plugin_dir); import sibling` —
**caches the first sibling under the bare name** (e.g. `producer`), and the
second plugin to do the same import silently gets the wrong module.

The fix: when loading a sibling module from `plugin.py`, use
`spec_from_file_location` with a **unique** spec name:

```python
import importlib.util, sys
from pathlib import Path

def _load_sibling(name):
    """Load a sibling module under a uniquely-namespaced key."""
    spec_name = f"plugins.my_plugin.{name}"
    if spec_name in sys.modules:
        return sys.modules[spec_name]
    spec = importlib.util.spec_from_file_location(
        spec_name,
        Path(__file__).parent / f"{name}.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec_name] = mod
    spec.loader.exec_module(mod)
    return mod

producer = _load_sibling("producer")
```

This pattern is now copy-pasted into every plugin with siblings (Aether
hit the bug first in Wave 2). Wave 4 will likely lift it into a shared
helper.

### MCP tools — `mcp_tools.py`

Plugins that want to expose MCP tools declare a `MCP_TOOLS` list of
`(name, function, description)` tuples in `plugins/<name>/mcp_tools.py`:

```python
def grant_xp_tool(player_id: str = "default", amount: int = 50,
                  source_type: str = "manual") -> dict:
    """Grant XP to a player. Returns updated player state."""
    return _grant_xp(player_id, amount, source_type=source_type)

MCP_TOOLS = [
    ("grant_xp", grant_xp_tool, "Grant XP to a player"),
    ("get_level_info", _level_info, "Read level + XP-to-next for a player"),
]
```

The `plugins/mcp/` plugin (The Astral Conduit) iterates loaded plugins'
`mcp_tools` (exposed via `ctx.expose_api({"mcp_tools": MCP_TOOLS, ...})`)
and registers them with FastMCP at launcher start.

### `ctx.log()` vs `print()`

`ctx.log()` routes to the plugin registry's log buffer — useful for the
`/debug` plugin to surface, but **does not** print to stdout/stderr. For
visible diagnostics during boot or background work, use `print(...)`
directly (it goes to map_server's stdout). Convention is
`print(f"[{plugin_name}] message")`.

### DOM-built UI for panels (no innerHTML)

If your plugin ships a `panel.html` / `panel.js`, follow the rest of the
core: build DOM with `document.createElement()`, set `textContent` (never
`innerHTML`) for any value that could carry user/wire data. Helps avoid
XSS surprises when the panel renders alerts, hostnames, or event text.

## CLI: Method A vs Method B

A plugin can expose `realm` subcommands two ways. Pick whichever fits.

- **Method A — drop an executable** at `plugins/<name>/cli`. Any language.
  Must respond to `--one-line-help`, `--list-subcommands`, `--help`. The
  dispatcher execs it with the remaining args. Use when your CLI needs
  logic beyond HTTP pass-through.
- **Method B — declare verbs in `plugin.json`**. Add a `cli.verbs[]` array
  with `name`, `method`, `path`, optional `args`, `body`. The generic
  `realm-plugin.sh` handler reads the manifest and proxies HTTP through
  `scripts/lib/http.sh`. Zero per-plugin code. Used by `agent-register`,
  `ansible`, `chat`, `collectd`, `discovery-actions`, `firewall`, `ha`,
  `herald`, `latency`, `maintenance`, `notion`, `system-updates`, `wifi`.

If both exist for the same plugin, Method A wins.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md#add-a-realm-cli-subcommand) for
the full guide.

## No Hot Reload

Plugin changes require a server restart. No hot reload is supported.

## Specs Not Yet Implemented

| Spec | Status |
|------|--------|
| Per-plugin `<name>.service` systemd unit | Listed in the structure above; **no plugin currently ships one**. The unit files in `../systemd/` are core, not plugin-shipped. |
| `standalone` plugin type | Reserved — no plugin uses it |
| `on-demand` plugin type | Reserved — no plugin uses it |
| Shared `real_home()` helper | Wave 4 work — currently duplicated across `lexicon/`, `mcp/`, `realm-engine/`, `progression/`, `quests/`, `combat-ward/`, `codex/`. Slated to land in `realm_text.real_home()` at the repo root. |
| Plugin-loader sibling-import helper | Wave 4 work — the `_load_sibling()` pattern (see above) is copy-pasted across plugins with siblings. |
| MCP tool auto-aggregation | Wave 1.5 follow-up — currently each plugin declares `mcp_tools.py`, but `plugins/mcp/tools.py` doesn't yet iterate `ctx.get_plugin_api(...)["mcp_tools"]` automatically. |
