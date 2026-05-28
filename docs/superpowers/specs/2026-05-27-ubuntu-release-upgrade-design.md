# Ubuntu Release Upgrade via `realm` CLI

> **Status:** Implemented
> **Date:** 2026-05-27
> **Issue:** [#11](https://github.com/jphein/realmwatch/issues/11)

## Goal

Support major Ubuntu release upgrades (e.g. 22.04 → 24.04 → 24.10) through
the realm CLI, with appropriate guardrails. `realm ansible-update` runs
`apt safe upgrade` only — release upgrades require `do-release-upgrade`,
which is interactive and prompt-heavy.

## Why not in the daily timer

- `do-release-upgrade` is interactive by default; the
  `-f DistUpgradeViewNonInteractive` view is fragile and can leave hosts
  in inconsistent states.
- Release upgrades typically need a reboot.
- They touch every package, take 15-60 min per host, and can fail in
  interesting ways (third-party repos disabled, `/etc/*` conffile
  conflicts).
- Always human-in-the-loop.

## Surface

```text
realm ansible upgrade-release --host <name> [--to <version>] [OPTIONS]
```

Flow:

1. Resolve `<name>` to a target node via the topology (which mirrors
   `fleet.yaml`). Confirm `node.os == "ubuntu"`.
2. Run `do-release-upgrade -c` on the target via SSH to confirm a new
   release is available.
3. Show JP what version would be installed; prompt for explicit
   confirmation. **No `--yes` flag.**
4. Open a tmux session over SSH (`tmux new-session -A -s ...`) so the
   upgrade survives disconnects and JP can attend prompts interactively.
5. Emit `ansible/upgrade.started` and `ansible/upgrade.completed` realm
   events (with `--no-event` to opt out).

Out of scope (intentionally):

- Auto-reboot after upgrade. Host says "reboot required"; operator
  triggers it manually (`realm ssh <host> sudo reboot`).
- Bulk fleet release upgrades. Always one host at a time.
- Pre-release / development releases (no opt-in for `-d`).

## Architecture decisions

### Method A (executable) over Method B (declarative)

The existing ansible plugin uses Method B — `plugin.json` declares verbs
(`inventory`, `playbooks`, `runs`, `run`, `run-check`, `ai`) that the
generic `realm-plugin.sh` handler dispatches as HTTP calls. That model
doesn't fit a verb that needs:

- SSH probing (read-only, but real shell)
- An interactive confirmation prompt
- An interactive tmux+SSH session for the upgrade itself

So `upgrade-release` is implemented as a real bash script, and the plugin
ships a small `plugins/ansible/cli` shim that:

- Intercepts verbs it owns (`upgrade-release` for now)
- Forwards everything else to `scripts/cli/realm-plugin.sh ansible "$@"`
  so the existing Method B verbs keep working unchanged

This is the path the original CLI design doc anticipated — Method A and
Method B coexist; Method A wins when the file is executable and is
expected to forward unknown verbs.

### `--host` collides with the global `--host URL` flag

The shared `args.sh` reserves `--host` for overriding the realm server
URL. Issue #11 explicitly asks for `--host <name>` to mean the target
fleet host. The script pre-parses its own `--host` and strips it from
`$@` before sourcing `realm-cli.sh`, so both meanings stay reachable
(the realm server override is essentially never needed for this verb,
which runs SSH commands locally and only hits the realm API for
topology + event posting).

### tmux session naming

Session name is `realm-upgrade-<host>-<unix-timestamp>` by default, with
`--tmux-session` to override. `tmux new-session -A` attaches if the
session already exists, so reconnecting after a disconnect is a
no-op-on-the-target.

The remote command pipes `do-release-upgrade` output through `tee` to
`/var/log/realm-upgrade-release.<session>.log` so post-mortem inspection
is possible even if JP detached.

### Event emission

`ansible/upgrade.started` and `ansible/upgrade.completed` are emitted via
`POST /event`. Severity 2 puts them above ambient noise but below true
alerts. The codex picks these up automatically (subscribes to all events
of severity ≥ 2).

## Files

- `plugins/ansible/cli` — Method A shim; routes `upgrade-release` to the
  script, everything else to Method B.
- `plugins/ansible/scripts/upgrade-release.sh` — implementation.
- `docs/cli.md` — verb documentation.

## Future work

- Pre-flight: capture `/etc/apt/sources.list.d/` and `dpkg --get-selections`
  to a realm artifact before the upgrade, so rollback diagnosis is easier.
- Post-upgrade: emit a third event with the `reboot-required.pkgs`
  contents so the alerting plugin can nag until JP reboots.
- A companion `realm ansible reboot --host <name>` verb (also one-host,
  also confirmed) for the post-upgrade step.
- Eventually: surface a "release available" badge on nodes in the SVG map
  by reading the `do-release-upgrade -c` result on a slow timer (out of
  scope here; would live in the ansible plugin's enricher).
