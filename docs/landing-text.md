---
layout: default
title: Realmwatch — fantasy homelab monitor
---

# Realmwatch

A fantasy-themed homelab network monitor that turns your infrastructure into a
hand-painted realm map. Every host is a node on the SVG canvas with a fantasy
name, a persona, and a voice. As of May 2026 it also carries an RPG layer —
quests, progression, combat-ward, codex — and ships an in-tree MCP server,
the Astral Conduit, that Claude Code can attach to.

> 12 VLANs · 130+ nodes · 50 plugins · one unified CLI with 60+ verbs · an
> AI oracle · a herald daemon · a Zabbix-class alerting pipeline · an RPG
> game layer · an MCP server · adaptive Wave Terminal dashboards — all from
> a single Linux box.

[Get started](getting-started.html){: .btn}
&nbsp;[Architecture](architecture.html){: .btn}
&nbsp;[Plugins](plugins.html){: .btn}
&nbsp;[CLI reference](cli.html){: .btn}
&nbsp;[Wave Terminal](wave.html){: .btn}
&nbsp;[Source on GitHub](https://github.com/jphein/realmwatch){: .btn}

---

## The pitch

Most network monitors render collectd, Netdata, SNMP, and Home Assistant into
spark lines. Realmwatch renders them into a treasure map. A failing UPS becomes
a Ward losing its sigil. A roaming phone becomes a familiar slipping between
towers. A firewall counter becomes a dragon at the gate.

Underneath the theming sits a serious operational toolkit:

- **Live SVG topology** — pan/zoom canvas, animated traffic, terrain
  contours, biome regions, drag-to-arrange layout. Web workers offload
  the heavy work.
- **Plugin system** — 50 plugins under `plugins/<name>/`, each with a
  `plugin.json` manifest. Drop-in. Topological-sorted dependencies. Hooks
  for endpoints, SSE sources, node enrichers, discovery providers, and CLI
  verbs.
- **Unified `realm` CLI** — git-style dispatcher with 60+ verbs. Type
  `realm watch` and tail SSE events; `realm topology` for a table view;
  `realm alerting why oracle` to explain why an alert was suppressed;
  `realm wave install` to spawn live Wave Terminal dashboards.
- **Auto-OS discovery + Netdata fleet rollout** — one command probes every
  reachable node via SSH, writes back `os` / `os_version` / `tags`, and
  installs the Netdata agent on every Ubuntu host via Ansible.
- **Trigger-dependency alert suppression** — Zabbix-style. When a node's
  upstream gateway is already in trouble, child-node alerts are dropped at
  dispatch time. No more alert storms.
- **Event acknowledgement workflow** — ack / close / comment. Subsequent
  matching alerts are suppressed while a human owns the problem.
- **Maintenance windows** — schedule a Veiled Hour and both the alerting
  pipeline and the herald daemon fall silent for the matching nodes.
  Recurring, one-shot, or by pattern.
- **Active agent registration** — new hosts run a one-line install script,
  announce themselves to the realm, and heartbeat thereafter. Discovery
  actions auto-classify them on arrival.
- **Discovery actions** — declarative *if OUI matches OpenWrt then role=ap*
  rules that fire at discovery time. New hosts walk into the realm and
  emerge already classified.
- **User macros** — `{$DISK_FULL_PCT}` tokens in alerting rules resolve
  per-event against a host → role → global scope chain. One template,
  per-host overrides.
- **Role templates** — 30+ typed node roles with default discovery
  providers, default sublabel format, and default tag set bundled together.
  New hosts inherit the right treatment automatically.
- **AI oracle** — Azure o4-mini. Polls the events table for queries, posts
  responses back. Optional Azure TTS for voice. Sister herald daemon
  narrates interesting nodes with themed personas.
- **RPG game layer** *(absorbed from os.realm.watch, May 2026)* — five
  plugins, one sidecar SQLite at `~/.realmwatch/game.db`. `realm-engine`
  ingests events; `progression` grants XP, levels, skills, achievements;
  `quests` turns alerts into accept/complete quests; `combat-ward` proposes
  and gates defensive actions against intrusions; `codex` writes node lore
  and chronicles. Every event in the realm becomes XP for the operator.
- **MCP server — the Astral Conduit** — in-tree FastMCP server at
  `plugins/mcp/launcher.py`. Claude Code attaches with one command and
  gains ~48 tools across realm status, fleet ops, quests, combat-ward,
  codex, and progression. Stdio by default; SSE on `/mcp/sse`
  now live.
- **Wave Terminal dashboards (Tide Singers)** — `realm wave install`
  spawns adaptive ANSI TUIs as Wave blocks: WAN bandwidth (gatekeeper
  br-lan.38), palace-daemon health, live journal tail. Each TUI resizes
  cleanly and goes red-bordered when its source goes quiet.

---

## Screenshots

The SVG map is the visual hook. Captured by `make screenshots` (Playwright
against a running `map_server.py` — see
[`docs/screenshots/`](https://github.com/jphein/realmwatch/tree/master/docs/screenshots)
for prereqs).

| File | What it shows |
|---|---|
| `01-realm-map-full.png` | Full realm map at zoom-out — the treasure-map view |
| `02-realm-map-zoom.png` | Mid-zoom showing nodes, regions, traffic ley lines |
| `03-node-panel.png` | Node detail panel — stats, persona, controls |
| `04-scan-panel.png` | Survey Glass scan panel mid-discovery |
| `05-system-updates.png` | Scroll of Patch Runes — pending updates per source |

---

## At a glance

```
┌────────────────────────────────────────────────────────────────────────┐
│ Browser — realm-map.html (SVG canvas, dockable panels, SSE consumer)   │
└────────────────────────────────────────────────────────────────────────┘
                                 │ HTTP + SSE
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ map_server.py :80     (stdlib http.server + ThreadingMixIn)            │
│   ├── Core:    engine · realm_db · sse_broker · discovery_engine       │
│   └── Plugins: plugin_loader · plugin_context · plugin_registry        │
│                  → setup(ctx) for every integrated plugin              │
└────────────────────────────────────────────────────────────────────────┘
                 │                  │                  │
                 ▼                  ▼                  ▼
   Independent daemons     Discovery providers    Game-layer plugins
   oracle_daemon ·         netdata · snmp ·       realm-engine ·
   herald · launcher       docker · kvm ·         progression ·
                           systemd · nmap · ha    quests · combat-ward
                           caddy · …              codex
                                                  + plugins/mcp/
                                                    (Astral Conduit, FastMCP)
```

[Read the deeper architecture writeup →](architecture.html)

---

## Quick start

```bash
git clone https://github.com/jphein/realmwatch.git
cd realmwatch

make install        # uv sync + npm
make build          # esbuild → realm-map.js
make dev            # python3 map_server.py — :80 + SSE + plugins

# In another shell
make cli-install    # symlinks realm into ~/.local/bin (no sudo)
realm status
realm watch

# Optional: attach Claude Code to the Astral Conduit (MCP)
claude mcp add realmwatch ~/Projects/realmwatch/plugins/mcp/launcher.py
```

Open <http://localhost/realm-map.html>. Panels render, SSE streams live, every
plugin's UI loads from `/plugins/<name>/panel.{html,js,css}` at runtime.

[Full getting-started guide →](getting-started.html)

---

## Site map

- **[Getting started](getting-started.html)** — install, first run, daemons,
  systemd, daily update timer.
- **[Architecture](architecture.html)** — server, plugin system, SSE broker,
  discovery engine, web workers, key design decisions.
- **[Plugin catalog](plugins.html)** — every plugin, fantasy name, icon,
  what it does, what it integrates.
- **[CLI reference](cli.html)** — every `realm` subcommand, every flag, every
  exit code, completion install.
- **[Wave Terminal dashboards](wave.html)** — Tide Singers — adaptive ANSI
  TUIs as Wave blocks.

## Project docs in the repo

- [README](https://github.com/jphein/realmwatch/blob/master/README.md)
- [CHANGELOG](https://github.com/jphein/realmwatch/blob/master/CHANGELOG.md)
- [CONTRIBUTING](https://github.com/jphein/realmwatch/blob/master/CONTRIBUTING.md)
- [Plugin guide](https://github.com/jphein/realmwatch/blob/master/plugins/README.md)
- [Issue tracker / roadmap](https://github.com/jphein/realmwatch/issues)
