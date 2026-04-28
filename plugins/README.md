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
  This is the only lifecycle exercised today; all 33 current plugins are integrated.
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

## Specs Not Yet Implemented

| Spec | Status |
|------|--------|
| Per-plugin `<name>.service` systemd unit | Listed in the structure above; **no plugin currently ships one**. The unit files in `../systemd/` are core, not plugin-shipped. |
| `standalone` plugin type | Reserved — no plugin uses it |
| `on-demand` plugin type | Reserved — no plugin uses it |
