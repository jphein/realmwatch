# Realmwatch — Copilot Code Review instructions

When reviewing PRs in `jphein/realmwatch`, follow these conventions.

Read [CLAUDE.md](../CLAUDE.md) and [plugins/README.md](../plugins/README.md)
for full context — they're the load-bearing docs.

## Architecture invariants (flag if violated)

- **No hardcoded hosts.** Resolve via `realm_fleet.host_ip()` (Python) or
  the `$REALM_PYTHON` bash bridge. Literal IPs only allowed in `*.example.*`
  files and docs.
- **No cross-plugin Python imports.** Plugins coordinate via
  `ctx.get_plugin_api`, `ctx.expose_api`, `ctx.on_event`, `ctx.push_event`.
- **`raw_path=True`** on plugin endpoints registered with unprefixed paths.
- **`realm_text.real_home()`** is the canonical sudo-aware home resolver.
  Not `Path.home()`, not `os.path.expanduser`, not bash `~`.
- **No `innerHTML` in `plugin.js` files** — write-hook blocks it. Use DOM
  construction (`createElement` + `textContent`).

## Bash gotchas

- `((x++))` exits 1 when x was 0 under `set -e`. Use `x=$((x + 1))`.
- `[[ -f f ]] && source f` exits 1 when f missing. Append `|| true`.

## Database

- `realm.db` = live state. Never `DROP TABLE` / `DELETE FROM` without
  rationale.
- Game state in `~/.realmwatch/game.db`. Plugins own their tables via
  `CREATE TABLE IF NOT EXISTS`.

## CLI

- Verbs live in `scripts/cli/realm-<verb>.sh`, auto-discovered by the
  dispatcher.
- Source `scripts/lib/realm-cli.sh`. Use `realm::api_get`, `realm::print_*`,
  `realm::status_*`, `realm::die`.
- The verb trinity covers brief/doctor/logs/show/fix/find/tail.

## Skip these review topics

- Fantasy-themed naming — intentional.
- Plugin priority integers — meaningful.
- Missing tests — no test framework in this repo (per `CLAUDE.md`).
- Style nits in established `scripts/lib/` — match what's there.

## Comment style

- Lead with the issue, not preamble.
- Smallest fix that addresses the root cause.
- Quote file:line on architecture flags.
- Group related issues across files.
- Under 4 sentences per comment.
