# Realmwatch — review style guide for Gemini Code Assist

This guide makes Gemini's reviews actionable in *this* codebase. Generic
"add error handling" suggestions are noise here.

## Architecture invariants (BLOCK on violation)

- **No hardcoded hosts.** IPs and hostnames come from `realm_fleet.host_ip()`
  (Python) or `$REALM_PYTHON` shell-out (bash). Only `*.example.*` files and
  documentation may contain literal IPs.
- **No cross-plugin Python imports.** Plugins coordinate via
  `ctx.get_plugin_api("name")`, `ctx.expose_api({...})`,
  `ctx.on_event(type, fn)`, `ctx.push_event(...)` — never direct imports.
- **`raw_path=True` on plugin endpoints** for unprefixed URLs. Without it
  the route gets namespaced under `/plugins/<name>/...`. If reviewing an
  endpoint registration on an unprefixed path that lacks `raw_path=True`,
  flag it.
- **Sudo-aware home resolution.** The realmwatch HTTP server binds port 80
  and typically runs as root. `Path.home()` returns `/root` there. Use
  `realm_text.real_home()` — not `Path.home()`, not `os.path.expanduser`,
  not bash `~`.
- **`innerHTML` is blocked by a write-hook in plugin.js files.** Panel UI
  builds the DOM with `createElement` + `textContent`. Suggest the DOM
  pattern; don't ask for sanitizer libs.

## Database semantics

- `realm.db` is live state. Never `DROP TABLE`, never `DELETE FROM` without
  a clear rollback path documented in the commit.
- Game state lives in `~/.realmwatch/game.db` (sidecar). Plugins create
  their tables with `CREATE TABLE IF NOT EXISTS`.

## Bash gotchas this codebase has hit repeatedly

- `((COUNT++))` exits 1 under `set -e` when COUNT was 0. Suggest
  `COUNT=$((COUNT + 1))` instead.
- `[[ -f x ]] && source x` exits 1 under `set -e` when x is missing. Always
  append `|| true`.
- `realm_fleet` from bash: shell out via the `scripts/lib/realm-python.sh`
  helper, not by editing PATH.

## CLI verb conventions

- New verb? Add `scripts/cli/realm-<verb>.sh`. The dispatcher auto-finds it.
- Source `scripts/lib/realm-cli.sh` at top; reuse `realm::api_get`,
  `realm::print_section`, `realm::print_kv`, `realm::status_ok|warn|fail`,
  `realm::die`, `realm::die_unreachable`.
- Trinity: `brief / doctor / logs / show / fix / find / tail`. Don't
  propose a 7th unless it answers a distinct operator question.

## What to skip in reviews

- Fantasy-themed names (`The Astral Conduit`, `The Naming Ledger`, etc.).
  Intentional and beloved. Don't suggest renames.
- Plugin manifest `priority` integers — load-order signals, not arbitrary.
- Comments on missing tests — we don't run a test framework in this repo
  (per `CLAUDE.md`). Smoke-tests via `make dev` + `realm doctor` are the
  contract.
- Style nits on bash quoting in helper files — the existing `scripts/lib/`
  is consistent; new code should match what's there.

## Comment style we want from you

- Lead with the issue, not preamble.
- Suggest the *smallest* fix that addresses the root cause.
- Quote the file:line when flagging architecture violations.
- Keep individual comments under 4 sentences.
- Group related issues (e.g. "three callers hardcode the same IP — extract via realm_fleet").
