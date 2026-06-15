---
layout: default
title: CLI reference
---

# `realm` — the unified CLI

A git-style dispatcher. Type `realm <verb>`. The dispatcher resolves the verb
against four sources and execs the first match.

```
                ┌──────────────────────────────────────────┐
                │  scripts/cli/realm-<verb>                │  ← core hand-written
                ├──────────────────────────────────────────┤
                │  plugins/<verb>/cli                      │  ← Method A (executable)
                ├──────────────────────────────────────────┤
                │  plugins/<verb>/plugin.json (cli.verbs)  │  ← Method B (declarative)
                ├──────────────────────────────────────────┤
                │  realm-<verb> on $PATH                   │  ← third-party / personal
                └──────────────────────────────────────────┘
```

No registry. Adding a new command means dropping a file. Bash + zsh completion
queries the live filesystem.

---

## Install

```bash
make cli-install     # symlinks realm into ~/.local/bin (no sudo)
make cli-doctor      # verify PATH, completion, jq/curl/column, server reach
make cli-uninstall   # clean removal
```

After installing, open a new shell to pick up completion. Then:

```bash
realm                # command index
realm help <cmd>     # full help for one subcommand
realm <tab><tab>     # completion enumerates live commands
```

---

## Global flags

Handled centrally in `scripts/lib/args.sh`. Every subcommand inherits them.

| Flag | Purpose |
|---|---|
| `-h`, `--help` | Print help and exit 0 |
| `--version` | Print sigil-format version line, exit 0 |
| `-v`, `--verbose` | Verbose mode (`REALM_VERBOSE=1`) |
| `-q`, `--quiet` | Suppress non-error output (`REALM_QUIET=1`) |
| `--no-color` | Disable ANSI color (`REALM_NO_COLOR=1`) |
| `--json` | Machine output (`REALM_OUTPUT=json`) |
| `--dry-run` | Preview mode — print would-be operation, exit 0 |
| `--host URL` | Override realm host (`REALM_HOST=URL`) |
| `--` | Stop parsing — rest forwarded as-is |

Hidden flags used by the dispatcher itself:

| Flag | Purpose |
|---|---|
| `--one-line-help` | Subcommand prints one summary line from `REALM_HELP_SUMMARY` |
| `--list-subcommands` | Subcommand prints its verbs, one per line |
| `--list-commands` | Dispatcher prints top-level subcommand names |

---

## Core subcommands

### `realm status`

```text
Show full realm system status.
```

`GET /status`. Sensors, collectd, WiFi, HA, sublabels — a colored table view
in the default human mode. `--json` for machine output.

### `realm watch [--filter TYPE]`

```text
Tail realm events from /sse (live).
```

Streams the SSE event bus line-by-line. `--filter realm-event` to only see
realm events; `--filter discovery` to only see new entities. Useful as a
foreground "what is going on right now" feed.

### `realm topology`

```text
Show network topology (nodes and connections).
```

`GET /topology`. Default view groups nodes by region + role. `--json` for
the raw structure.

### `realm quest list|create|complete|delete`

```text
List, create, update, complete, or delete quests.
```

Quest CRUD. Quests are the gamified todo layer — created by the `events`
plugin on threshold breaches, by Notion sync, or manually.

### `realm persona list|get|set`

```text
List or update node personas.
```

Per-node persona — name, role, archetype, voice, traits. Edits flow
through the write-through pattern (DB + `personas.json`).

### `realm tags list|get|add|remove`

```text
Manage tags on topology nodes (heuristic-friendly labels).
```

`node.tags` is an additive lowercase-kebab-case array stored alongside
`os`. Populated automatically by `realm discover-os` with derived families
(`ubuntu`, `linux`, `debian-family`, `apt`). Lets fleet queries say "every
host with `apt`" or "every `debian-family` box."

### `realm discovery list|providers|scan|prototypes|entities|link|unlink`

```text
List discovered entities, providers, links, prototypes; trigger scans.
```

Discovery engine controls. `scan <provider>` triggers a one-shot scan.
`providers` lists what's registered. `list` shows `sub_entities` with their
parent topology node. **`prototypes`** lists every discovery prototype
declared across plugin manifests — these are the Low-Level-Discovery
templates that materialize per-entity (sublabel, fantasy text, alert
clauses with `{{#MACRO}}` placeholders). **`entities --type T`** filters
the discovered set by type.

```bash
realm discovery prototypes                       # all LLD templates
realm discovery entities --type netdata_host
realm discovery entities --type container        # docker-discovery output
```

### `realm alerting status|channels|rules|why`

```text
Manage alerting channels, rules, and history.
```

- `status` — pipeline state, suppression counts.
- `channels` — configured channels (desktop, SSE toast, voice, email,
  webhook, Pushover).
- `rules` — active rules with their triggers.
- `why <node>` — explain the dependency walk for that node. Says which
  ancestor is blocking, lookback window used, recent problems detected.

### `realm event list|post|ack|close|comment`

```text
List, post, acknowledge, or close events.
```

The event log + the ack workflow.

```bash
realm event post warning "Test event"               # POST /event
realm event list --open-unacked                     # GET /events?ack=false
realm event ack 42 --by jp --note "investigating"   # POST /events/42/ack
realm event close 42                                # POST /events/42/close
realm event comment 42 "rebooted; will monitor"     # POST /events/42/comment
```

A matching alert arriving after an ack is dropped (`status='ack_suppressed'`).

### `realm role list|show|nodes`

```text
Browse role registry: list, show templates, list nodes per role.
```

Role templates bind alerting rules, discovery providers, default tags, and
sublabel formats per node role. Templates ship for router, ap, switch,
bridge, server, nas, vm, hypervisor, desktop, laptop, camera, wled,
sensor, ups, printer.

```bash
realm role list                 # all roles + node counts
realm role show server          # template details: rules, providers, tags
realm role nodes server         # every node assigned this role
```

### `realm macro set|get|delete|list|explain`

```text
Manage user macros for alerting rule parameterization.
```

Alerting rule values can carry `{$NAME}` tokens that resolve per-event
against a host → role → global scope chain. One template, per-host
overrides, no rule duplication.

```bash
realm macro set DISK_FULL_PCT 80                            # global
realm macro set DISK_FULL_PCT 95 --scope host --node familiar
realm macro set LOAD_HIGH 4.0 --scope role --role server
realm macro explain DISK_FULL_PCT --node familiar           → 95 (host)
realm macro explain DISK_FULL_PCT --node gatekeeper         → 80 (global)
```

### `realm plugins list|toggle`

```text
List or toggle realm plugins.
```

Plugin management. `list` shows loaded plugins with version, type, status,
endpoint count. `toggle <name>` flips an enabled flag (effect deferred to
next restart — no hot reload).

### `realm config get|set`

```text
Read or write realm server-side config.
```

Top-level realm config — node defaults, integration toggles. Stored in
`realm.db.settings` under the `core` namespace.

### `realm settings get|set|unset`

```text
Get/set/unset per-plugin settings stored in the realm DB.
```

Per-plugin namespaced settings. Format `<plugin>.<key>`. Used by every
plugin that needs persisted config.

### `realm ping <host>`

`GET /ping/<ip>`. Server-side ping (results coalesced with the latency
plugin).

### `realm wol <node>`

Wake-on-LAN. `POST /wol`. Sends the magic packet via the realm server.

### `realm ssh <node> <cmd>`

`POST /ssh`. Runs a command through the realm SSH endpoint (uses
the node's persisted SSH mapping).

### `realm resolve <url>`

Resolves a URL or hostname through the realm. Useful when DNS varies per
VLAN or per Tailscale routing — surfaces the realm-server's view.

### `realm player`

```text
Show player state or award rewards.
```

The XP / quest reward layer. Surfaces level, XP, completed quests.
`reward <amount> [--reason …]` posts a player reward event.

### `realm debug`

```text
Dump realm server debug info (tables, endpoints, plugin state).
```

`GET /debug`. Tables row counts, registered endpoints, loaded plugins,
SSE sources, recent events. The "what does the server know" dump.

### `realm doctor [--quick] [--json]`

```text
Diagnose realm health — server, fleet, lexicon, plugins, env, reachability.
```

Color-coded checks (or a JSON array of `{section, status, detail}` with
`--json`): processes + daemons, `:80` reachability, `realm.db`, env tokens,
and sibling-service `/api/version` probes (sibling list via
`~/.config/realm/siblings.conf`). `--quick` skips the network probes; exit
code is non-zero only on genuine failures (off-by-default daemons WARN).

### `realm health` — deprecated alias for `realm doctor`

```text
DEPRECATED alias for 'realm doctor' — runs the full diagnostic.
```

`realm health` prints a one-line deprecation notice to stderr and execs
`realm doctor` with all args forwarded (incl. `--json`/`--quick`). Every check
it used to run was folded into `doctor`; use `realm doctor` going forward.

### `realm api <method> <path> [body]`

```text
Generic HTTP escape hatch (raw curl wrapper for any endpoint).
```

The "I haven't written a wrapper yet" escape hatch. Inherits all global
flags (auth, retry, JSON formatting).

```bash
realm api GET  /status | jq '.uptime'
realm api POST /event '{"type":"info","text":"hello"}'
```

### `realm fleet audit|migrate-ssid|add-vlan|firewall-check`

```text
Manage the OpenWrt fleet (APs, routers, switches).
```

Wraps the existing `scripts/ap-*.sh` family. Fleet definitions live in
`scripts/lib/fleet.sh`.

### `realm version [--all]`

```text
Print realm CLI version and (with --all) sibling service versions.
```

Sigil-format version line:

```
realm 0.4.2 (forge: stormcaller-9d7e4f1, built 2026-05-16T14:22:03Z)
```

`--all` rolls up the local server's `/api/version` plus sibling services
(oracle, coin, portal, status, deploy) if configured.

### `realm update [list|check|run]`

```text
Manual update runner (offline; talks directly to the system-updates CLI).
```

Thin Bash wrapper around `plugins/system-updates/cli.py`. Reuses the same
source definitions, commands, parsers, and lock groups as the web panel,
so CLI and browser stay in sync. Works **without** `map_server.py` running
— useful when patching the realm server itself.

```bash
realm update                  # interactive: check all, prompt to upgrade
realm update list             # list known sources
realm update check [src]      # check all, or one source
realm update run   [src]      # upgrade all, or one source (no prompt)
```

Logs go to `$XDG_STATE_HOME/realm-update/run-<YYYYMMDD-HHMMSS>.log` and
the runner keeps the most recent ten.

For server-mediated control (queued runs, history, approval workflow) use
`realm system-updates` (the HTTP plugin) instead.

### `realm completion bash|zsh`

```text
Emit shell completion script.
```

Standard install paths:

```bash
realm completion bash > ~/.local/share/bash-completion/completions/realm
realm completion zsh  > ~/.local/share/zsh/site-functions/_realm
```

`make cli-install` does both. Both scripts call `realm --list-commands` at
runtime — adding a new `realm-foo` requires zero completion regeneration.

---

## Plugin-shipped verbs

These verbs come from `cli.verbs` blocks inside `plugins/<name>/plugin.json`.
The dispatcher reads the manifest at request time and proxies HTTP through
`scripts/lib/http.sh`. No per-plugin Bash needed.

### `realm maintenance list|active|check|cancel`

```text
Manage scheduled maintenance windows.
```

`plugins/maintenance/` — Veiled Hours. While a window is active, alerting and
the herald daemon ignore events for the matching nodes. Useful for planned
downtime, kernel reboots, fleet upgrades.

```bash
realm maintenance list                    # every window, past and future
realm maintenance active                  # only windows currently muting
realm maintenance check oracle            # is this node in a window now?
realm maintenance cancel 7                # delete window id 7
```

Backed by `GET /maintenance/windows`, `GET /maintenance/active`,
`GET /maintenance/check/<node>`, `DELETE /maintenance/windows/<id>`.

### `realm agent-register list|show|install-script|forget`

```text
View self-registered agents and the install-script one-liner.
```

`plugins/agent-register/` — The Heralds' Gate. New hosts curl the
`install-script` endpoint and announce themselves with a heartbeat. Metadata
(OS, OUI, hostname) feeds the discovery-actions pipeline for automatic role
and tag assignment.

```bash
realm agent-register list                 # every agent, last-seen, role, tags
realm agent-register show familiar        # full metadata for one host
realm agent-register install-script       # prints the one-liner
realm agent-register forget familiar      # remove the registration
```

### `realm discovery-actions list|test|apply|delete`

```text
Manage declarative auto-classification rules for newly discovered hosts.
```

`plugins/discovery-actions/` — The Onboarding Sigils. Rules like *"if OUI
matches the OpenWrt range, then set role=ap and add tag wireless"* run at
discovery time. The `test` verb is a dry-run preview — no DB writes.

```bash
realm discovery-actions list              # all configured actions
realm discovery-actions test familiar     # preview what would fire
realm discovery-actions apply familiar    # re-run actions, live writes
realm discovery-actions delete openwrt-ap # remove an action by id
```

### `realm wave bandwidth|palace|daemon|list|install`

```text
Wave Terminal blocks — adaptive monitor TUIs for the realm.
```

`plugins/wave/` — the **Tide Singers**. Three adaptive Python TUIs designed
to live as Wave Terminal blocks: live WAN bandwidth from gatekeeper's
`br-lan.38`, palace-daemon health on familiar (via MCP `mempalace_status`),
and a journal tail of `palace-daemon` over SSH with auto-reconnect. The
underlying scripts have no Wave dependency and will run in any terminal —
the `install` verb is what pairs them with Wave's block system via `wsh`.

```bash
realm wave list                  # show available TUIs
realm wave bandwidth             # run the WAN bandwidth TUI in this terminal
realm wave palace                # run the palace-daemon status TUI
realm wave daemon                # tail palace-daemon journal on familiar
realm wave install               # spawn all three as Wave blocks via wsh
realm wave install bandwidth     # spawn just the WAN block
```

`install` requires `wsh` on PATH (ships with [Wave Terminal](https://www.waveterm.dev/)).
The TUIs adapt to terminal width and height: header fields drop right-to-
left as width shrinks, sparklines stretch to fill, and a long-window 30-second-
bucket pair appears below the live sparklines when the pane is tall enough.

| Env var | Default | Used by |
|---|---|---|
| `PALACE_DAEMON_URL` | `http://familiar:8085` | `palace` |
| `PALACE_API_KEY` | *(auto-fetched over SSH from `familiar:~/.config/palace-daemon/env`)* | `palace` |
| `PALACE_DAEMON_HOST` | `jp@familiar` | `palace` + `daemon` |
| `PALACE_DAEMON_UNIT` | `palace-daemon` | `daemon` |

Full writeup: [Tide Singers — the Wave plugin](wave.html).

### `realm codex entries|node-lore|chronicles|journal`

```text
Lore, chronicles, journal, and node-lore from the codex plugin.
```

Read verbs (`entries`, `node-lore`, `chronicles`, `journal`) plus writes
(`add-entry`, `set-lore`, `add-chronicle`, `add-journal`) over `/codex/*`.

### `realm combat-ward threats|bestiary|encounters|defense-report|wards|propose|approve|execute`

```text
Combat-ward defense — threats, bestiary, encounters, reports, and actions.
```

Read the ward's view (`threats`, `bestiary`, `encounters`, `defense-report`,
`wards`) and drive defense actions (`propose`, `approve`, `execute`) over
`/combat-ward/*`.

### `realm progression player|skills|grant-xp|unlock-skill|grant-achievement`

```text
XP, skill trees, and achievements from the progression plugin.
```

`player`/`skills` read state over `/progression/*`; `grant-xp`,
`unlock-skill`, `grant-achievement` mutate it.

### `realm claude-config skills|claude-md|agents|hooks`

```text
The server's view of Claude Code config (skills, CLAUDE.md, agents, hooks).
```

Reads the `/skills`, `/claude-md`, `/agents`, `/hooks` endpoints —
convenience parity with the filesystem. `--json` for machine output.

---

## Fleet + update orchestration

### `realm discover-os`

```text
Probe reachable nodes via SSH and write OS info back to topology.
```

Concurrent SSH probe — 20 forks, 3s timeout, ~15s for 50 hosts. Reads
`/etc/os-release`, parses `ID` + `VERSION_ID` + `PRETTY_NAME`, POSTs back
to `/node` to persist.

A bare `realm discover-os` probes **every reachable node with a non-empty
IP** — stored topology never persists `.type` (it is computed at render
time, issue #98), so the default target list does not gate on type. `--types`
narrows the set when given, matching either the persisted `.type` (forward
-compatible) or the computed `._role` (e.g. `--types server,router`); a filter
that matches zero nodes falls back to "all reachable" with a warning. `--hosts`
always takes precedence. Tries `--user` values in order (default
`jp,root,ubuntu,pi` — `jp` first, the working account on this fleet).

The summary reports coverage — `probed` / `reachable` / `unreachable` and an
OS breakdown — not just successes (`--json` emits the same as a structured
object; `--verbose` lists unreachable host IDs).

Side effect: also writes `node.tags` — derived family tags (`debian-family`,
`alpine-family`, `openwrt-family`) and package-manager tags (`apt`, `apk`,
`opkg`, `dnf`).

### `realm netdata-install`

```text
Install the Netdata agent on every Ubuntu host (idempotent).
```

Method-A wrapper for `install-netdata.yml`. Auto-targets Ubuntu hosts from
the auto-built inventory. Polls completion (1h cap — kickstart can be
slow). Idempotent — skips hosts where `:19999` already responds.

### `realm ansible-update`

```text
Run an Ansible update playbook against fleet hosts (Ubuntu or OpenWrt).
```

Defaults to `update-ubuntu.yml`. Pass `--playbook update-openwrt.yml` for
the OpenWrt fleet (APs, routers, switch_openwrt).

`update-ubuntu.yml` safety upgrades:
- DKMS verification — captures `dkms status` after apt upgrade, **fails the
  play** if any module is in a non-`installed` state.
- fwupdmgr refresh — syncs LVFS metadata + lists pending firmware
  updates (does not auto-apply).
- Captures `/var/run/reboot-required.pkgs` so the summary lists which
  packages need a reboot.

`update-openwrt.yml` safety contract:
- Drives the device over `ansible.builtin.raw` + Dropbear SSH — no python
  installed on target, no extra flash overhead.
- Always runs `opkg update` + `opkg list-upgradable` (informational).
- `opkg upgrade` is gated behind `--extra-vars do_upgrade=true`. A plain
  run is effectively dry-run for openwrt boxes: it reports what *would*
  upgrade without touching the device.
- Never reboots; surfaces `reboot needed` in the per-host summary when
  opkg output flags it.

For multi-OS rollouts use the unified `realm update --node/--nodes/
--all-nodes` instead — it buckets by OS via `fleet.yaml`'s
`realm_update.os` field (with category-based inference fallback when
the field is absent) and dispatches the matching playbook per bucket.

### `realm ansible upgrade-release --host <name> [--to VERSION]`

```text
Major Ubuntu release upgrade for one host (interactive, via SSH+tmux).
```

For when a host is one release behind (e.g. 22.04 → 24.04 → 24.10) and
needs `do-release-upgrade`, which is interactive and prompt-heavy.
Always one host at a time, always human-in-the-loop.

Flow:
1. Resolves `<name>` via the topology and confirms `node.os == "ubuntu"`.
2. SSHs in and runs `do-release-upgrade -c` (read-only check) — shows the
   offered new release.
3. If `--to <version>` was passed, the offered version must match
   (otherwise the run is aborted).
4. Prompts for explicit `y/N` confirmation. There is no `--yes` flag.
5. Opens a tmux session over SSH (`tmux new-session -A`) so the upgrade
   survives a disconnect — JP can detach and reattach with
   `ssh <user>@<host> ; tmux attach -t <session>`.
6. Emits realm events `ansible/upgrade.started` and
   `ansible/upgrade.completed` for the alerting plugin and the codex.

Out of scope: auto-reboot (host says "reboot required", JP triggers it
with `realm ssh <host> sudo reboot`), bulk fleet release upgrades
(always one host at a time), pre-release / development versions.

Examples:

```bash
# Preview without starting an upgrade
realm ansible upgrade-release --host familiar --check-only

# Interactive upgrade
realm ansible upgrade-release --host familiar

# Pin the target version
realm ansible upgrade-release --host familiar --to 24.04
```

Exit codes: `0` ok, `2` usage, `3` realm unreachable, `4` no such host /
wrong OS, `5` no release available or `--to` mismatch, `6` user declined,
`7` SSH unreachable / upgrade failed.

### `realm update-all`

```text
Two-stage update: katana (system-updates) + Ubuntu fleet (ansible).
```

Katana host first (via the `system-updates` plugin's runner), then the
Ubuntu fleet via Ansible. Posts realm events on start, completion, and
errors. Daily timer via `make update-all-install`.

---

## clig.dev conventions

Encoded once in `scripts/lib/`, never re-litigated in subcommands.

- **stdout = data.** Pipeable. JSON when `--json`; table/kv otherwise.
- **stderr = chatter.** Progress, info, warnings, errors. Verbose-only
  output gated by `REALM_VERBOSE`.
- **Color**: disabled when `NO_COLOR` is set non-empty, when stdout is not
  a tty, or when `--no-color` is passed. Detection happens once in
  `colors.sh`.
- **Exit codes**:
  - `0` success
  - `1` general failure
  - `2` usage error (bad flag, missing arg)
  - `3` network / connection refused / DNS
  - `4` config / missing env / unauthorized
  - `5` server-side error (HTTP 5xx)
  - `127` unknown subcommand (shell convention)
- **Trap handler**: every subcommand traps `EXIT` with `realm::cleanup_temp`.
  `SIGINT` is handled gracefully (cleanup runs, exit 130).
- **Error messages** always tell the user what to try next:
  ```
  ✘ realm: cannot reach http://localhost (connection refused)
    Is map_server.py running? Try: realm health
  ```

---

## Configuration

XDG directories:

- Config: `$XDG_CONFIG_HOME/realm/` → `~/.config/realm/`
- State: `$XDG_STATE_HOME/realm/` → `~/.local/state/realm/`
- Cache: `$XDG_CACHE_HOME/realm/` → `~/.cache/realm/`

Optional `~/.config/realm/config.sh` (shell-sourceable) sets `REALM_*`
variables. A project-local `.realm.conf` in CWD overrides per-directory.
`REALM_*` env vars override files; flags override env.

Same env vars work for cross-language consumers — Go services in the realm
read `REALM_HOST` etc. from environment.

---

## Adding a CLI subcommand

See the [Contributing guide]({{ '/CONTRIBUTING.html' | relative_url }}#add-a-realm-cli-subcommand).
Short version: drop an executable at `plugins/<name>/cli` (Method A) or
add `cli.verbs` to `plugin.json` (Method B). The dispatcher discovers it
on the next invocation — no rebuild.
