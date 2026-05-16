# `realm` CLI — First-Rate Unified Interface

> **Status:** Draft
> **Date:** 2026-05-16
> **Phase:** Post-Phase 1 (depends on plugin system already in place)

## Goal

Expose **every** realmwatch capability — core HTTP endpoints, 33 plugins, 3 daemons, fleet ops scripts — through a single, ergonomic, git-style CLI named `realm`. JP's stated intent: this becomes the primary daily interface to the system.

The output of this design is a thin dispatcher, a small set of shared Bash libraries, a uniform plugin CLI contract, and a working installation flow — not a monolithic rewrite.

## Architecture

### Dispatch model: git-style

`realm` is a ~50-line Bash wrapper. When the user types `realm foo bar`, the dispatcher resolves `foo` in this order and execs the first match:

1. **Core executable** — `$REALM_EXEC_PATH/realm-foo` (defaults to `<repo>/scripts/cli/`). This is where the hand-written subcommands live (`realm-status`, `realm-quest`, `realm-discovery`, …).
2. **Plugin CLI** — `<repo>/plugins/foo/cli` if it exists and is executable. Plugins can ship CLI handlers in any language.
3. **`$PATH` fallback** — `realm-foo` on the user's `$PATH`. Allows third-party / personal extensions without touching the repo.
4. **HTTP fallback** — if `foo` looks like a known HTTP endpoint root (queried once from `/debug` and cached in `~/.cache/realm/endpoints.json`), generic `realm-api` handles it.

Anything resolved gets `bar …` as `$@`. The dispatcher does **not** parse subcommand args — that's each subcommand's job.

### Why git's model and not a monolith

- Subcommands stay independently runnable. `scripts/cli/realm-health.sh` works whether called as `realm health` or directly.
- Adding a new command is "drop a file." No registry, no rebuild, no dispatcher edit.
- Plugin authors get a first-class CLI hook without learning a framework.
- Completion + help index are dynamic — they query the live filesystem, not a checked-in table.

### Why not Cobra/urfave-cli in Go

Already debated. Bash stays. Future migration to Go is a separate decision; the per-subcommand executable model is language-agnostic, so the contract survives a rewrite.

## Directory Layout

```
realmwatch/
├── scripts/
│   ├── realm                       # NEW — dispatcher (~50 LOC bash)
│   ├── cli/                        # NEW — core subcommand executables
│   │   ├── realm-status.sh
│   │   ├── realm-topology.sh
│   │   ├── realm-quest.sh
│   │   ├── realm-persona.sh
│   │   ├── realm-config.sh
│   │   ├── realm-settings.sh
│   │   ├── realm-discovery.sh
│   │   ├── realm-alerting.sh
│   │   ├── realm-watch.sh          # SSE tail (realm watch)
│   │   ├── realm-event.sh          # POST /event
│   │   ├── realm-ping.sh
│   │   ├── realm-wol.sh
│   │   ├── realm-ssh.sh
│   │   ├── realm-resolve.sh
│   │   ├── realm-plugins.sh
│   │   ├── realm-skills.sh
│   │   ├── realm-agents.sh
│   │   ├── realm-hooks.sh
│   │   ├── realm-debug.sh
│   │   ├── realm-player.sh
│   │   ├── realm-fleet.sh          # wraps existing ap-* scripts
│   │   ├── realm-oracle.sh         # wraps oracle_daemon.py
│   │   ├── realm-herald.sh         # wraps realm_herald.py
│   │   ├── realm-launcher.sh       # wraps realm_launcher.py
│   │   ├── realm-completion.sh     # emit bash/zsh completion
│   │   ├── realm-version.sh        # sigil-formatted version line
│   │   └── realm-help.sh           # render help index
│   ├── lib/
│   │   ├── fleet.sh                # EXISTING — fleet inventory
│   │   ├── realm-cli.sh            # NEW — sources colors/args/http/output/config
│   │   ├── colors.sh               # NEW — extracted color codes + NO_COLOR
│   │   ├── args.sh                 # NEW — argument parsing
│   │   ├── http.sh                 # NEW — curl wrapper + retry + json
│   │   ├── output.sh               # NEW — table/json/kv formatters
│   │   └── config.sh               # NEW — XDG config loader
│   ├── realm-health.sh             # EXISTING — kept as-is, dispatcher routes to it
│   ├── realm-update.sh             # EXISTING — kept as-is
│   ├── ap-*.sh                     # EXISTING — wrapped by realm-fleet.sh
│   └── setup-*.sh                  # EXISTING — wrapped by realm-setup.sh
└── plugins/<name>/cli              # NEW (optional) — per-plugin CLI handler
```

**Migration discipline.** The eight existing scripts that already work (`realm-health`, `realm-update`, `ap-*`, `setup-*`) are NOT rewritten. The new dispatcher routes to them; new wrappers like `realm-fleet.sh` invoke them. Worst-case rollback is `rm scripts/realm`.

## Shared Library Contract

### `lib/realm-cli.sh` — the umbrella

Each subcommand starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
```

`realm-cli.sh` sources `colors.sh`, `args.sh`, `http.sh`, `output.sh`, `config.sh`, and `fleet.sh`. One include for the whole API.

### `lib/colors.sh`

Matches the existing convention exactly (per the conventions extract): single-letter vars `G R Y C N`, plus extended `C_*` set for monitor-style scripts. Adds a one-time detection block:

```bash
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]] || [[ "${REALM_NO_COLOR:-}" = "1" ]]; then
  G=''; R=''; Y=''; C=''; N=''
  C_RESET=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_ORANGE=''
  C_RED=''; C_BOLD=''; C_CYAN=''
fi
```

`--no-color` flag handling lives in `args.sh` — it sets `REALM_NO_COLOR=1` *before* sourcing `colors.sh`. (Subcommands source in order: args first, then the lib umbrella.)

### `lib/args.sh`

Exports `realm::parse_common` which consumes the global flags and strips them from `$@`, then hands the remainder back as a positional array. Common flags handled centrally:

| Flag | Purpose | Result |
|------|---------|--------|
| `-h`, `--help` | Print help and exit 0 | calls `realm::help` then exits |
| `--version` | Print sigil version line, exit 0 | calls `realm::version` then exits |
| `-v`, `--verbose` | Verbose mode | `REALM_VERBOSE=1` |
| `-q`, `--quiet` | Suppress non-error output | `REALM_QUIET=1` |
| `--no-color` | Disable ANSI color | `REALM_NO_COLOR=1` |
| `--json` | Machine output | `REALM_OUTPUT=json` |
| `--dry-run` | Preview mode | `REALM_DRY_RUN=1` |
| `--host URL` | Override realm host | `REALM_HOST=URL` |
| `--one-line-help` | Hidden, used by dispatcher index | prints one line from `REALM_HELP_SUMMARY`, exits 0 |
| `--list-commands` | Hidden, dispatcher only | dispatcher prints command list |
| `--` | Stop parsing | rest forwarded as-is |

Subcommands declare a `REALM_HELP_SUMMARY="…"` at the top and a `realm::help` function. The args lib reads both. The argument parser supports both `--flag value` and `--flag=value` (battle-tested manual pattern per web research).

### `lib/http.sh`

Thin curl wrapper with consistent behavior:

```bash
realm::api_get  PATH [QUERYSTRING]    # GET, prints body
realm::api_post PATH JSON_BODY        # POST, prints body
realm::api_put  PATH JSON_BODY        # PUT
realm::api_delete PATH                # DELETE
realm::api_sse  PATH [FILTER]         # stream SSE, line-by-line
```

Standard semantics:
- Base URL from `$REALM_HOST` (default `http://localhost`).
- Retries once on transient failure (connect-refused, 5xx). Hard fail otherwise.
- Maps HTTP status to exit codes: 0 success, 3 network/connection, 4 auth/config, 5 server-side error, 22 ≥ 4xx-client (mirrors curl).
- Honors `REALM_DRY_RUN=1` by printing the would-be curl command and returning 0 without executing.
- Honors `REALM_VERBOSE=1` by echoing the curl command to stderr.

Output is raw stdout; formatters live in `output.sh`. Callers compose:

```bash
realm::api_get /status | realm::fmt_table .nodes
```

### `lib/output.sh`

Three formatters keyed on `REALM_OUTPUT`:

| Function | `human` (default) | `json` |
|----------|-------------------|--------|
| `realm::fmt_table JQ_FILTER` | pretty ASCII table | raw JSON, jq-extracted |
| `realm::fmt_kv JQ_FILTER` | colored key=value pairs | raw JSON |
| `realm::fmt_event` | colored line with timestamp + type | raw event JSON |

Implementation uses `jq` for filtering (already a project dep — many scripts curl pipe through jq). Table rendering uses `column -t -s$'\t'` after jq tab-formats — no `tabulate` dependency.

### `lib/config.sh`

Loads, in clig.dev precedence (lowest → highest):

1. Built-in defaults (`REALM_HOST=http://localhost`, `REALM_PORT=80`, ...).
2. `~/.config/realm/config.sh` if it exists. Shell-sourceable, sets `REALM_*` vars.
3. `./.realm.conf` in CWD if it exists. Project-local overrides.
4. `REALM_*` env vars already in environment.
5. Flags (already applied by `args.sh` to env before this runs).

Same env vars work for cross-language consumers — Go services in the realm read `REALM_HOST` etc. from environment.

XDG paths used:
- Config: `$XDG_CONFIG_HOME/realm/` → `~/.config/realm/`
- State: `$XDG_STATE_HOME/realm/` → `~/.local/state/realm/`
- Cache: `$XDG_CACHE_HOME/realm/` → `~/.cache/realm/`

`config.sh` also exposes:
```bash
realm::state_dir   # echos XDG state path (mkdir -p'd)
realm::cache_dir   # ditto
realm::config_dir  # ditto
```

## Plugin CLI Contract

The first-rate plugin extension story. Two equivalent ways for a plugin to add CLI:

### Method A — `plugins/<name>/cli` executable

If `plugins/<name>/cli` exists and is executable, `realm <name> …` execs it with `$@`. The plugin owns its subcommand entirely — any language.

Required contract on the executable:
- `cli --one-line-help` prints a single line: `"<one-line description>"`. Used by `realm` (no args) to build the index.
- `cli --list-subcommands` prints one subcommand verb per line. Used by completion.
- `cli --help` prints full help.

This matches the davidmoreno/commands pattern documented in the web research.

### Method B — `plugin.json` declaration (lighter-weight)

For plugins whose only "CLI" is wrapping their own HTTP endpoints, add to `plugin.json`:

```json
{
  "cli": {
    "summary": "Manage alerting channels and rules",
    "verbs": [
      {"name": "status",   "method": "GET",  "path": "/alerting/status"},
      {"name": "channels", "method": "GET",  "path": "/alerting/channels"},
      {"name": "rules",    "method": "GET",  "path": "/alerting/rules"},
      {"name": "test",     "method": "POST", "path": "/alerting/channels/test", "body": "name=$1"}
    ]
  }
}
```

The `plugin_loader` reads `cli.verbs` at server startup and writes a generated manifest to `~/.cache/realm/plugin-cli.json`. The generic `realm-plugin` handler reads that and dispatches via `lib/http.sh`. Same UX, zero per-plugin code for HTTP-pass-through plugins.

**Precedence**: if both Method A and Method B are present, Method A wins. The dispatcher logs a warning in verbose mode.

## Output, Color, Error Discipline (clig.dev)

Encoded once in the libs, never re-litigated in subcommands:

- **stdout = data.** Pipeable. JSON when `--json`, table/kv otherwise.
- **stderr = chatter.** Progress, info, warnings, errors. Verbose-only output gated by `[[ -n ${REALM_VERBOSE:-} ]]`.
- **Color**: disabled when `NO_COLOR` set non-empty, when stdout is not a tty, or when `--no-color` passed. Detection happens once in `colors.sh`.
- **Exit codes**:
  - `0` success
  - `1` general failure (catch-all, with a colored stderr message)
  - `2` usage error (bad flag, missing arg)
  - `3` network / connection refused / DNS
  - `4` config / missing env / unauthorized
  - `5` server-side error (HTTP 5xx)
  - `127` unknown subcommand (matches shell convention)
- **Trap handler**: every subcommand traps EXIT with `realm::cleanup_temp` — removes any tmpfiles. SIGINT is handled gracefully (cleanup runs, exit 130).
- **Error messages** always tell the user what they could try next:
  ```
  ✘ realm: cannot reach http://localhost (connection refused)
    Is map_server.py running? Try: realm health
  ```

## Versioning (realm-sigil tie-in)

`realm --version` prints a single sigil-format line, matching the project standard:

```
realm 0.4.2 (forge: stormcaller-9d7e4f1, built 2026-05-16T14:22:03Z)
```

Implementation:
- `make cli-install` runs `git rev-parse --short HEAD` and writes a `scripts/cli/.realm-version` file alongside the executables. The lib reads that at runtime, no git tree required.
- `realm version --all` rolls up: queries `/api/version` on the local server, plus reads sibling-service `/api/version` (oracle, coin, portal) if reachable. Shows whether the suite is in sync.
- Subcommands inherit `--version` from `args.sh` automatically.

## Completion

`realm completion bash` and `realm completion zsh` print scripts to stdout. Standard install path:
```
realm completion bash > ~/.local/share/bash-completion/completions/realm
realm completion zsh  > ~/.local/share/zsh/site-functions/_realm
```

Both scripts call `realm --list-commands` at runtime to enumerate top-level subcommands. For per-subcommand completion, they call `realm <sub> --list-subcommands` if the subcommand supports it (most do, via `args.sh`).

Adding a new `realm-foo` requires zero completion regeneration.

## Cross-Project Health

`realm health` (existing `realm-health.sh`) is extended to:

1. Keep all existing checks (local realmwatch process + port + DB + tokens).
2. Add a sibling-services section that walks a configured list of HTTP URLs and queries `/api/version` on each. Status: REACHABLE (green), DRIFTED (yellow, version doesn't match), UNREACHABLE (red).
3. Sibling URLs come from `~/.config/realm/health.conf` (a simple newline-separated list), with built-in defaults for the local-known set (coin, oracle, portal, status, deploy).

Output structure unchanged for `--quiet`; the sibling section appears between `realm-map-server` and the existing tokens block. With `--json`, returns a structured doc with one entry per service.

## Installation

`Makefile` adds three targets:

```make
cli-install:
	@mkdir -p $(HOME)/.local/bin
	@ln -sf $(CURDIR)/scripts/realm $(HOME)/.local/bin/realm
	@for f in scripts/cli/realm-*.sh; do \
	  name=$$(basename $$f .sh); \
	  ln -sf $(CURDIR)/$$f $(HOME)/.local/bin/$$name; \
	done
	@$(CURDIR)/scripts/realm completion bash > $(HOME)/.local/share/bash-completion/completions/realm
	@$(CURDIR)/scripts/realm completion zsh  > $(HOME)/.local/share/zsh/site-functions/_realm
	@git rev-parse --short HEAD > $(CURDIR)/scripts/cli/.realm-version
	@echo "Installed realm CLI to ~/.local/bin/. Open a new shell to load completion."

cli-uninstall:
	@rm -f $(HOME)/.local/bin/realm $(HOME)/.local/bin/realm-*
	@rm -f $(HOME)/.local/share/bash-completion/completions/realm
	@rm -f $(HOME)/.local/share/zsh/site-functions/_realm

cli-doctor:
	@$(CURDIR)/scripts/realm version --all || true
	@command -v realm >/dev/null && echo "✓ realm on PATH" || echo "✘ realm not on PATH"
	@type _realm >/dev/null 2>&1 && echo "✓ completion loaded" || echo "✘ completion not loaded (open new shell)"
```

No sudo. Symlinks update on every `git pull` automatically. Removal is clean.

## Command Map (initial set — phase 1 ship)

The full map is in `scratch/cli-survey/surface.md`. Phase-1 ship prioritizes JP's top-10 daily commands and the foundation pieces:

| Phase 1 (ship first) | Notes |
|----------------------|-------|
| `realm` | dispatcher + index |
| `realm help`, `realm <sub> --help` | self-doc |
| `realm version` | sigil version line |
| `realm completion bash\|zsh` | completion emitter |
| `realm status` | GET /status, table view |
| `realm watch [--filter TYPE]` | SSE tail |
| `realm topology` | GET /topology |
| `realm quest list\|create\|complete\|delete` | quest CRUD |
| `realm persona list\|get\|set` | persona CRUD |
| `realm discovery list\|providers\|scan` | discovery basics |
| `realm alerting status\|channels\|rules` | alerting basics |
| `realm plugins list\|toggle` | plugin mgmt |
| `realm config get\|set` | config CRUD |
| `realm ping [host]`, `realm wol <node>` | quick ops |
| `realm event post <type> <text>` | inject events |
| `realm debug` | dump |
| `realm health` (extended) | cross-project health |
| `realm fleet audit\|migrate-ssid\|add-vlan` | wraps existing ap-* |

| Phase 2 (incremental) | Notes |
|-----------------------|-------|
| `realm-plugin` generic Method-B handler | enables `plugin.json` cli declarations |
| `realm oracle\|herald\|launcher` daemon wrappers | systemd ergonomics |
| `realm settings` (read/write/unset) | per-plugin settings |
| `realm skills`, `realm agents`, `realm hooks` | registry browsing |
| `realm api <method> <path>` | raw HTTP escape hatch |
| `realm tldr <cmd>` | quick examples for the top-10 |

| Phase 3 (polish) | Notes |
|------------------|-------|
| Plugin-side Method-A `cli` files for the 5 chattiest plugins | richer per-plugin UX |
| Man pages via `ronn` from `docs/cli/*.md` | nice-to-have |
| Per-host config (`~/.config/realm/hosts/<name>.sh`) | switch between local/remote realms |

## Migration & Risk

- **Backward compatibility**: existing scripts (`realm-health.sh`, `realm-update.sh`, `ap-*.sh`, `setup-*.sh`) keep their current paths and behaviour. New wrappers call them. Removing the `realm` dispatcher leaves the system in its current state.
- **Worktree**: build on `worktree-cli-first-rate`, merge to master after smoke test.
- **Smoke test plan**: install on local host (`make cli-install`), exercise the phase-1 command list against the live `:80` server, verify `--json` output parses with `jq`, verify completion enumerates after new-shell.
- **Risk**: plugin Method-B (`plugin.json` cli) requires `plugin_loader.py` changes. If those slip phase 1, the dispatcher still works — plugins just get exposed via Phase 1 hand-written `realm-<name>.sh` wrappers in `scripts/cli/`.

## Out of Scope

- Rewriting any plugin's existing HTTP handler in Bash. The CLI is a *client* of the existing API surface.
- TUI / curses dashboards. Line-oriented only.
- Authentication. Realmwatch HTTP is unauthenticated on the LAN; the CLI inherits that posture.
- Plugin marketplace / discovery beyond the local filesystem.
- Cross-shell support beyond bash + zsh. Fish completion is a phase-3 stretch.

## Success Criteria

- JP types `realm status` from any shell and gets a colored summary in <250 ms.
- `realm <tab><tab>` lists every subcommand discoverably.
- `realm watch --filter discovery` tails new entities in real time.
- A new plugin author adds `cli` to their plugin and gets a working subcommand without touching the dispatcher.
- The 21 fleet/setup scripts under `scripts/` are reachable via `realm fleet` and `realm setup`.
- `realm health` reports green when local + all sibling-service `/api/version` endpoints answer.
- `make cli-install` works on a freshly cloned realmwatch with no sudo.
