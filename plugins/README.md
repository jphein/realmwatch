# Realmwatch Plugins

Drop-in extensions for Realmwatch. Each plugin lives in its own subdirectory.

## Structure

```
plugins/
  <plugin-name>/
    plugin.json          # Manifest (required)
    plugin.py            # Python entry point (required for `integrated` plugins)
    panel.html           # Panel template fragment (optional)
    panel.js             # Frontend code (optional)
    panel.css            # Styles (optional)
    <name>.service       # systemd unit template (spec only — see below)
    requirements.txt     # Additional pip dependencies (optional)
```

## Plugin Types

- **integrated** — runs inside map_server process (background threads, SSE, enrichment).
  This is the only lifecycle exercised today; all 36 current plugins are integrated.
- **standalone** *(spec only)* — separate systemd process, communicates via HTTP API.
  Reserved in the manifest schema; no plugin uses this type yet.
- **on-demand** *(spec only)* — invoked by user action, runs as subprocess.
  Reserved; no plugin uses this type yet.

## Creating a Plugin

1. Create a directory under `plugins/` with your plugin name
2. Add a `plugin.json` manifest (see spec in `docs/superpowers/specs/`)
3. Implement `setup(ctx)` in `plugin.py` — receives a `PluginContext`
4. Restart map_server to load

## No Hot Reload

Plugin changes require a server restart. No hot reload is supported.

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

## Specs Not Yet Implemented

| Spec | Status |
|------|--------|
| Per-plugin `<name>.service` systemd unit | Listed in the structure above; **no plugin currently ships one**. The unit files in `../systemd/` are core, not plugin-shipped. |
| `standalone` plugin type | Reserved — no plugin uses it |
| `on-demand` plugin type | Reserved — no plugin uses it |
