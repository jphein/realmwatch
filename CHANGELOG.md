# Changelog

All notable changes to Realmwatch are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions are unreleased — no git tags yet. Buckets below group commit history
by feature epoch using commit author dates.

---

## [Unreleased]

Most recent work since the v0.4 epoch. Items here will fold into the next
tagged release.

- Documentation polish for the unified `realm` CLI and the plugin system.
- Public-release docs scaffold: `README.md`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, GitHub Pages site under `docs/`.

---

## [0.4.0] — Zabbix-class operations (2026-05-16)

The "stop getting paged for the same outage twice" epoch. Trigger
dependencies, event acknowledgement, role templates, user macros, and the
`node.tags` primitive — most gated by closed issues from the
`zabbix-inspired` label.

### Added

- **Trigger dependencies — suppress child alerts when parent is down**
  (`28b424b`, closes #5). When an event arrives from a node whose upstream
  infrastructure (gateway, switch, core, router, bridge, tower) is already in
  a problem state, the alert is suppressed instead of dispatched. Eliminates
  the alert storm where every VLAN behind a downed gatekeeper produces its
  own offline notification. Implementation in
  `plugins/alerting/dependencies.py`: direction-agnostic BFS through
  topology, 200-entry audit ring, `realm alerting why <node>` for the
  explain command.
- **Event acknowledgement workflow** (`fae26ec`, closes #8). New endpoints
  `POST /events/<id>/ack`, `POST /events/<id>/close`, `POST /events/<id>/comment`
  and a `GET /events?ack=false` filter. A matching alert arriving after an
  ack is dropped in the dispatch pipeline (`status='ack_suppressed'`
  in event history). Four idempotent `ALTER TABLE` columns added:
  `ack_at`, `ack_by`, `ack_note`, `closed_at`. Exposed via
  `realm event ack | close | comment | list --open-unacked`.
- **Role templates** (`a26f1a8`, closes #3). Roles become typed bundles in
  `node_roles.ROLE_TEMPLATES` that bind alerting rules, discovery providers,
  default tags, and sublabel formats. Alerting rule conditions gain `roles`
  and `tags` — rules now match on role or tag in addition to event type,
  severity, and node pattern. Templates ship for router, ap, switch, bridge,
  server, nas, vm, hypervisor, desktop, laptop, camera, wled, sensor, ups,
  printer.
- **User macros** (`a50b6ce`, closes #7). Alerting rule values can carry
  `{$NAME}` tokens that resolve per-event against a host → role → global
  scope chain. One template, per-host overrides, no rule duplication. New
  `plugins/alerting/macros.py`, new `realm macro set|get|delete|list|explain`
  subcommand.
- **`node.tags` primitive** (`bd913d4`). Additive lowercase-kebab-case
  string array stored alongside `os`. `discover-os` writes a derived tag
  set on every successful probe (`ubuntu`, `linux`, `debian-family`, `apt`,
  …). Powers fleet-wide queries like "every host with apt" or "every
  debian-family box." New `realm tags` subcommand for CRUD.
- **Desktop / laptop Netdata coverage** — discovery now treats workstation-
  and laptop-class roles as Netdata candidates.

### Changed

- `realm_db.events` table now has acknowledgement columns; schema migration
  is idempotent on startup.

---

## [0.3.0] — Unified `realm` CLI (2026-05-16)

Eight commits in one weekend that turned realmwatch from "many scripts" into
"one verb."

### Added

- **`realm` dispatcher** (`c65975c`) — git-style, ~315 lines of Bash. Resolves
  `realm <sub>` against `scripts/cli/realm-<sub>`, `plugins/<sub>/cli`, and
  `$PATH` (plus a Method-B `plugin.json` lookup). No registry, no rebuild,
  no dispatcher edit to add a command.
- **Shared lib (`scripts/lib/`)** — `colors.sh`, `args.sh`, `http.sh`,
  `output.sh`, `config.sh`, `realm-cli.sh` umbrella. clig.dev conventions:
  stdout=data / stderr=chatter, `NO_COLOR` + isatty detection, distinct exit
  codes (2/3/4/5), `--help` / `--version` / `--json` / `--dry-run` /
  `--verbose` / `--quiet` / `--host` / `--no-color` handled centrally.
- **20 core subcommands** (`c65975c`): `status`, `watch`, `topology`,
  `quest`, `persona`, `discovery`, `alerting`, `plugins`, `config`,
  `settings`, `ping`, `wol`, `ssh`, `event`, `debug`, `api`, `fleet`,
  `version`, `resolve`, `player`.
- **Declarative plugin CLI verbs (Method B)** (`d0d7d01`, `9737771`). Add
  `cli.verbs` to `plugin.json`; the generic handler proxies HTTP through
  `lib/http.sh`. No per-plugin code. Adopted by `wifi`, `ansible`, `chat`,
  `collectd`, `latency`, `firewall`, `ha`, `herald`, `notion`,
  `system-updates`.
- **Auto-OS discovery** (`cb22736`). `realm discover-os` SSHes concurrently
  to every reachable node (20 forks, 3s timeout, ~15s for 50 hosts), reads
  `/etc/os-release`, parses `ID` + `VERSION_ID` + `PRETTY_NAME`, POSTs back
  to `/node`. Default user list: `root,jp,ubuntu,pi`.
- **Netdata fleet rollout** (`cb22736`). `realm netdata-install` runs the
  new `install-netdata.yml` playbook (official kickstart, `--stable-channel`,
  `--disable-telemetry`, idempotent, skips if `:19999` already responds).
- **DKMS + fwupd safety** (`cb22736`). `update-ubuntu.yml` now captures
  `dkms status` after apt upgrade and fails the play on any non-`installed`
  module. Catches the silent "kernel upgraded but NVIDIA didn't rebuild"
  landmine. fwupdmgr metadata sync + pending-update listing.
- **Daily update orchestration** (`2936b7f`). `realm update-all` two-stage:
  katana via system-updates plugin, then Ubuntu fleet via Ansible.
  `make update-all-install` drops a systemd user timer firing daily ~03:00.
- **Bash + zsh completion** — `realm completion bash` / `zsh` emit scripts
  that enumerate live commands via `realm --list-commands`.
- **`make cli-install` / `cli-uninstall` / `cli-doctor`** — symlinks the
  dispatcher and every `realm-*` into `~/.local/bin/`, installs completion,
  stamps a `.realm-version` file. No sudo. Updates on every `git pull`.

### Design

- Full design doc: `docs/superpowers/specs/2026-05-16-realm-cli-first-rate-design.md`.

---

## [0.2.0] — System updates plugin (2026-04-18 → 2026-04-30)

The Scroll of Patch Runes — one panel that watches every package manager on a
modern Linux desktop and runs them safely.

### Added

- **`system-updates` plugin** (`01af387`). Tracks pending updates across
  APT, Snap, Flatpak, mise, brew, npm, pip-user, firmware (fwupd), and the
  AI CLI tools (claude, copilot, codex, gemini, droid). Per-source check
  runners, single combined panel.
- **Verification module** (`f3f997a`, `7098400`, `aa322f3`). L1 advisory,
  L2 quarantine, L3 script diff. Wires through CLI and the panel UI.
- **`/api/inventory` endpoint** (`2a51b4e`). Surfaces every installed
  package alongside pending updates. Pipx counted as 12th source.
- **Notifications + run history + daily timer** (`cd87c3f`).
- **Approval endpoints** (`7098400`). Pending updates can be approved /
  skipped / cancelled from the panel.

### Fixed

- Thread safety on `pending_approvals` (`8860df6`).
- Crash recovery + re-entry guard (`d3d9cd9`).
- pipx → pip-user naming for consistency with source id (`d0909c3`).
- `first_seen` saved on exception path (`d3e4d8e`).
- Realm-update symlink resolution so PATH install works (`5737232`).

### Infrastructure

- **HP V1910 switch runbook + expect scripts** (`b61093e`). Comware-5
  cmdline-mode unlock, port hybrid normalization, LLDP enable. Three
  expect-driven scripts in `scripts/switch/`.
- **SSL deploy reaches the full fleet** (`ef5e800`).
- **Fleet definitions extracted to `scripts/lib/fleet.sh`** (`77151fc`).
- **SNMPv3 (auth+priv) discovery** (`3c3547d`). Per-node config block with
  auth/priv password env-var references — passwords never stored in
  `realm.db` or `topology.json`.
- **Switch tempmon + multi-host runner** (`17baaba`).
- **`realm-update.sh` logs every run** to `~/.local/state/realm-update/`
  (`fe6906d`).

---

## [0.1.0] — Plugin system + alerting + discovery (2026-03-24 → 2026-04-08)

The architectural turning point. The bundled core moved into `src/`; every
domain feature became a plugin under `plugins/`.

### Added

- **Plugin system** (`2026-03-24 to 2026-03-27`). `plugin_loader.py`,
  `plugin_registry.py`, `plugin_context.py`. Manifest validation, dependency
  topological sort, lifecycle hooks. 22 initial plugins extracted from the
  monolith.
- **Alerting plugin** (2026-04-07). Rule engine + 6 channel adapters
  (desktop, SSE toast, voice, email, webhook, Pushover). 10 API endpoints,
  rule seeding, settings panel.
- **Autodiscovery engine** (2026-04-07). `discovery_engine.py` —
  SubEntity model, HostAccess reachability cache fed by fping, entity linker,
  scan orchestrator. Three new tables: `sub_entities`, `discovery_links`,
  `discovery_capabilities`.
- **9 discovery providers** registered in one day (2026-04-07): `docker`,
  `kvm`, `systemd`, `snmp`, `nmap`, `caddy`, `netdata`, `health`, `github`,
  `projects`, `manual`, plus core providers re-cast as discovery sources
  (`collectd`, `wled`, `firewall`, `ha`, `wifi`).
- **Survey Glass scan panel** (`c25e825`). Manual triggers for WiFi,
  LLDP, firewall, oracle, and discovery scans.
- **Realm Surveyors dashboard** (`d06a708`) + Vassals tab on node detail
  (`a0bb213`) + discovery-count badges on map nodes (`609e303`).
- **Fantasy-themed discovery alerts** (`3c850d8`) on subscription changes.
- **WiFi unknown-node migration to SubEntity model** (`e360baf`).

### Architecture

- `src/` esbuild bundle for the frontend core (modularized 2026-03-11 in
  `32cc80d`). Plugins inject `panel.{html,js,css}` at runtime.
- Web Workers for layout (`layout-worker.js`) and terrain heightmap
  (`topo-worker.js`).
- Hash-deduped SSE broker with burst replay on connect.

---

## [0.0.x] — Pre-plugin epoch (2026-03-09 → 2026-03-23)

The original monolith. SVG map, panels, ley lines, oracle, herald, WLED,
HA bridge, AP scanner, collectd reader, Notion sync, Tailscale enrichment,
unified SQLite DB — all in one repo, mostly in one file.

### Added (selected)

- Initial realm map with ~130 nodes across 12 VLANs (`8856620`).
- Topology extraction to `topology.json` (`497434a`).
- AP scanner with MAC-based node identity (`b233cf5`, `2391873`).
- Notion-backed quest sync (`29375f6`) and codex (`7d41f02`).
- HA bridge, oracle daemon, Magic Morph search, node tooltips (`d4fd873`).
- Unified SQLite DB for all realm state (`890a4f7`).
- esbuild + ES modules + Web Worker for layout (`32cc80d`).
- SSE broker + `/sse` endpoint replacing polling (`9049ab3`, `d4f8dac`,
  `74a1240`).
- Latency-aware layout modes (`fa14399`).
- WLED bridge + node roles + control tab + HA cross-reference (`84eb4ff`).
- Quest reward / player XP system (March 2026).
- UI overhaul + panel manager (March 2026).

[Unreleased]: https://github.com/jphein/realmwatch/compare/master...HEAD
