---
layout: default
title: Realmwatch — fantasy homelab monitor
---

# Realmwatch

A fantasy-themed homelab network monitor that turns your infrastructure into a
hand-painted realm map. Every host is a node on the SVG canvas with a fantasy
name, a persona, and a voice.

> 12 VLANs · 130+ nodes · 33 plugins · one unified CLI · an AI oracle ·
> a herald daemon · a Zabbix-class alerting pipeline — all from a single
> Linux box.

[Get started](getting-started.html){: .btn}
&nbsp;[Architecture](architecture.html){: .btn}
&nbsp;[Plugins](plugins.html){: .btn}
&nbsp;[CLI reference](cli.html){: .btn}
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
- **Plugin system** — 33 plugins under `plugins/<name>/`, each with a
  `plugin.json` manifest. Drop-in. Topological-sorted dependencies. Hooks
  for endpoints, SSE sources, node enrichers, discovery providers, and CLI
  verbs.
- **Unified `realm` CLI** — git-style dispatcher. Type `realm watch` and
  tail SSE events; `realm topology` for a table view; `realm alerting why
  oracle` to explain why an alert was suppressed.
- **Auto-OS discovery + Netdata fleet rollout** — one command probes every
  reachable node via SSH, writes back `os` / `os_version` / `tags`, and
  installs the Netdata agent on every Ubuntu host via Ansible.
- **Trigger-dependency alert suppression** — Zabbix-style. When a node's
  upstream gateway is already in trouble, child-node alerts are dropped at
  dispatch time. No more alert storms.
- **Event acknowledgement workflow** — ack / close / comment. Subsequent
  matching alerts are suppressed while a human owns the problem.
- **AI oracle** — Azure o4-mini. Polls the events table for queries, posts
  responses back. Optional Azure TTS for voice. Sister herald daemon
  narrates interesting nodes with themed personas.

---

## Screenshots

> **TODO** — screenshots pending. The SVG map is the visual hook.

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
                 │                                  │
                 ▼                                  ▼
   Independent daemons                  Discovery providers
   oracle_daemon · herald · launcher    netdata · snmp · docker · kvm ·
                                        systemd · nmap · ha · caddy · …
```

[Read the deeper architecture writeup →](architecture.html)

---

## Quick start

```bash
git clone https://github.com/jphein/realmwatch.git
cd realmwatch

make install        # pip + npm
make build          # esbuild → realm-map.js
make dev            # python3 map_server.py — :80 + SSE + plugins

# In another shell
make cli-install    # symlinks realm into ~/.local/bin (no sudo)
realm status
realm watch
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

## Project docs in the repo

- [README](https://github.com/jphein/realmwatch/blob/master/README.md)
- [CHANGELOG](https://github.com/jphein/realmwatch/blob/master/CHANGELOG.md)
- [CONTRIBUTING](https://github.com/jphein/realmwatch/blob/master/CONTRIBUTING.md)
- [Plugin guide](https://github.com/jphein/realmwatch/blob/master/plugins/README.md)
- [Issue tracker / roadmap](https://github.com/jphein/realmwatch/issues)
