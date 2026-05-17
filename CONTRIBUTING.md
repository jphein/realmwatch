# Contributing to Realmwatch

Welcome to the realm. This guide covers the three most common ways to
contribute: adding a plugin, adding a `realm` CLI subcommand, and submitting
a pull request.

If something here is unclear, [open an issue](https://github.com/jphein/realmwatch/issues/new)
— that itself counts as a contribution.

---

## Ground rules

- **Be honest about scope.** Small recoverable commits. One concern per
  commit. Conventional Commit style: `feat:`, `fix:`, `refactor:`, `docs:`,
  `chore:`, `perf:`, `test:`.
- **The fantasy theming is part of the contract.** Every node has a fantasy
  name; every plugin has a `fantasy_name` and `icon`; alerts read like
  prophecy fragments. Keep that voice. Technical sections stay technical;
  user-facing text stays themed.
- **`engine.py` is the single source of truth.** All sensor / mesh / nft /
  fantasy-translation logic lives there. Other files call into it; never
  duplicate it.
- **`topology.json` and `personas.json` are downstream artifacts.** They get
  regenerated from `realm.db`. Edit through the API (`POST /node`,
  `POST /personas`, `realm persona set …`).
- **`realm.db` is live data.** Never drop tables. Idempotent `ALTER` only.
- **`realm-map.js` is built output.** Edit `src/*.js`, then `npm run build`.
- **No hot reload.** Plugin changes need a `map_server.py` restart.

---

## Set up a dev environment

```bash
git clone https://github.com/jphein/realmwatch.git
cd realmwatch

make install      # pip install -r requirements.txt && npm install
make build        # esbuild → realm-map.js
make dev          # python3 map_server.py (foreground, :80)

# In another shell
make cli-install  # symlinks realm into ~/.local/bin (no sudo)
make cli-doctor   # verify PATH, completion, jq/curl/column, server reach
```

Python 3.12 is the target. Node is only needed for `esbuild` and the
`winbox` runtime dependency. There is no pytest suite — see [Testing
your change](#testing-your-change) below for the live-server validation
flow.

---

## Add a plugin

Plugins live under `plugins/<name>/`. The minimum viable plugin is two
files:

```
plugins/myplugin/
  plugin.json       # manifest (required)
  plugin.py         # setup(ctx) entry point (required for `integrated`)
```

### `plugin.json`

```json
{
  "name": "myplugin",
  "version": "0.1.0",
  "type": "integrated",
  "description": "Short technical sentence — what the plugin does.",
  "fantasy_name": "The Loremaster",
  "icon": "📖",

  "python": {
    "module": "plugin",
    "entry": "setup"
  },

  "depends_on": [],
  "endpoints": ["/myplugin/status"],
  "sse_types": []
}
```

Required fields: `name` (must match the directory), `version`, `type`. The
loader topologically sorts on `depends_on` and refuses to start if a cycle
exists or a dependency is missing.

### `plugin.py`

```python
"""My plugin — does the thing."""

def setup(ctx):
    """Register endpoints, SSE sources, enrichers, providers, threads."""
    log = ctx.logger

    @ctx.endpoint("/myplugin/status", method="GET")
    def status(req):
        return {"ok": True, "thing": ctx.db.get_setting("myplugin", "thing")}

    log.info("Loremaster ready")
```

The `PluginContext` (`plugin_context.py`) exposes:

- `ctx.endpoint(path, method=...)` — register HTTP handler.
- `ctx.sse_source(event_type, interval, source_fn)` — register an SSE
  feeder. The broker hash-dedupes; emit on every call.
- `ctx.enrich_node(fn)` — callback to add fields to a node's status payload.
- `ctx.register_discovery_provider(provider)` — supply a discovery provider
  (see `discovery_engine.py` for the protocol).
- `ctx.db` — `RealmDB` handle, read/write to settings, events, nodes, etc.
- `ctx.logger` — Python logger, namespaced to the plugin.
- `ctx.broadcast(event_type, payload)` — push a typed SSE event.
- `ctx.thread(target=..., name=...)` — start a daemon thread that the
  loader tracks.

### Optional panel files

Drop any of these and the loader picks them up automatically. They're served
under `/plugins/<name>/panel.{html,js,css}`.

- `panel.html` — fragment injected into the page.
- `panel.js` — runs at panel-mount time. `window.RealmAPI` exposes SSE
  hooks, panel registration, and the event bus (see
  `src/plugin-api.js`).
- `panel.css` — scoped to the panel by convention; namespace your class
  names.

### Restart and verify

```bash
# Restart map_server (no hot reload)
make dev

# Verify the plugin loaded
curl -s http://localhost/debug | jq '.plugins.myplugin'

# Hit your endpoint
curl -s http://localhost/myplugin/status | jq .
```

For deeper detail see [`plugins/README.md`](plugins/README.md) and the
[plugin system design spec](docs/superpowers/specs/2026-03-24-plugin-system-design.md).

---

## Add a `realm` CLI subcommand

Two ways. Pick whichever fits.

### Method A — drop an executable

If your plugin needs more than HTTP pass-through, ship an executable at
`plugins/<name>/cli` in any language. The dispatcher execs it with the
remaining args.

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$(readlink -f "$0")")/../../scripts/lib/realm-cli.sh"

# Required contract — used by the dispatcher index and completion.
REALM_HELP_SUMMARY="My plugin — does the thing"

case "${1:-}" in
  --one-line-help)   printf '%s\n' "$REALM_HELP_SUMMARY"; exit 0 ;;
  --list-subcommands) printf 'show\nrun\n'; exit 0 ;;
  --help|-h)         realm::help_block; exit 0 ;;
  show)              realm::api_get /myplugin/status | realm::fmt_kv . ;;
  run)               realm::api_post /myplugin/run '{}' | realm::fmt_kv . ;;
  *)                 echo "Unknown subcommand: $1" >&2; exit 2 ;;
esac
```

The `realm-cli.sh` umbrella sources `colors`, `args`, `http`, `output`,
`config`, `fleet`. One include for the whole shared lib.

### Method B — declare verbs in `plugin.json` (no code)

For plugins whose CLI is just "wrap my HTTP endpoints":

```json
{
  "cli": {
    "summary": "My plugin — does the thing",
    "verbs": [
      {"name": "status", "method": "GET",  "path": "/myplugin/status"},
      {"name": "run",    "method": "POST", "path": "/myplugin/run"},
      {"name": "test",   "method": "POST", "path": "/myplugin/test",
       "body": "name=$1&force=true"}
    ]
  }
}
```

The generic `realm-plugin.sh` handler reads `cli.verbs` and dispatches via
`scripts/lib/http.sh`. Body templates support `$1`, `$2`, etc. as positional
args. Same UX as Method A, zero per-plugin code.

If both Method A and Method B exist for the same plugin, Method A wins.

### Add a core subcommand

If the verb doesn't belong to any one plugin, add it to
`scripts/cli/realm-<verb>.sh`. Same contract as Method A. The Makefile's
`cli-install` target picks it up automatically.

Verify with `realm <tab><tab>` after a new shell. No completion regeneration
needed.

---

## Testing your change

There's no pytest suite. Validate by running and observing:

```bash
make build                # if you touched src/*.js
make dev                  # restart the server
curl -s http://localhost/status | jq .       # core endpoint
curl -s http://localhost/debug  | jq .       # plugins + endpoints
curl -s http://localhost/myplugin/status     # your new endpoint
make health                                   # color-coded service check
make cli-doctor                               # if you touched the CLI
realm watch                                   # tail SSE events live

# In the browser
xdg-open http://localhost/realm-map.html      # panels render, SSE live
```

For frontend changes, watch the esbuild bundle:

```bash
npm run watch    # non-minified, auto-rebuild on src/*.js change
```

---

## Pull request flow

1. **Branch** from `master`:
   ```bash
   git checkout -b feat/my-thing
   ```
   Branch naming: `<type>/<short-description>` — `feat/`, `fix/`,
   `refactor/`, `docs/`, `chore/`.

2. **Commit** in small, focused chunks. Conventional Commit subject lines:
   ```
   feat(plugin-name): add the thing
   fix(alerting): suppress duplicate ack notifications
   refactor(cli): extract realm::http_get to lib/
   docs: add CONTRIBUTING.md
   ```

3. **Before pushing**, run:
   ```bash
   make build          # if src/*.js changed
   make cli-doctor     # if the CLI changed
   make health         # one final smoke
   ```

4. **Open a PR**:
   ```bash
   gh pr create --title "feat: add the thing" --body "$(cat <<EOF
   ## Summary
   - One bullet per major change

   ## Test plan
   - [ ] Concrete things you verified
   EOF
   )"
   ```

5. **Address review feedback** with new commits — don't rewrite published
   history. Force-push is reserved for the rare amend-before-push case.

---

## Issues and labels

[GitHub issues](https://github.com/jphein/realmwatch/issues) is the canonical
roadmap. Labels in use:

| Label | Meaning |
|---|---|
| `enhancement` | New feature or capability |
| `ux` | User-facing polish, ergonomics |
| `zabbix-inspired` | Capability borrowed from Zabbix's playbook |
| `public-release` | Blocks or improves the public-release experience |

Filing an issue is encouraged. Even "this docs section confused me" is a
useful issue.

---

## Code of conduct

> **TODO** — a `CODE_OF_CONDUCT.md` (Contributor Covenant) is on the
> public-release todo list. Until then: be kind, assume good faith, leave
> the realm better than you found it.

---

## License

> **TODO** — no `LICENSE` file yet. Until one is added, "all rights
> reserved" applies. Recommended additions are MIT (simple, permissive,
> homelab-friendly) or Apache-2.0 (if patent grants matter).
