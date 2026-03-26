# Realmwatch Plugins

Drop-in extensions for Realmwatch. Each plugin lives in its own subdirectory.

## Structure

```
plugins/
  <plugin-name>/
    plugin.json          # Manifest (required)
    plugin.py            # Python entry point (optional for standalone/on-demand)
    panel.html           # Panel template fragment (optional)
    panel.js             # Frontend code (optional)
    panel.css            # Styles (optional)
    <name>.service       # systemd unit template (optional)
    requirements.txt     # Additional pip dependencies (optional)
```

## Plugin Types

- **integrated** — runs inside map_server process (background threads, SSE, enrichment)
- **standalone** — separate systemd process, communicates via HTTP API
- **on-demand** — invoked by user action, runs as subprocess

## Creating a Plugin

1. Create a directory under `plugins/` with your plugin name
2. Add a `plugin.json` manifest (see spec in `docs/superpowers/specs/`)
3. Implement `setup(ctx)` in `plugin.py` — receives a `PluginContext`
4. Restart map_server to load

## No Hot Reload

Plugin changes require a server restart. No hot reload is supported.
