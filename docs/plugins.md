---
layout: default
title: Plugin catalog
---

# Plugin catalog

36 plugins. Every domain feature in realmwatch is one. Each lives under
`plugins/<name>/` with a `plugin.json` manifest. The loader topologically
sorts on `depends_on` and calls `setup(ctx)` for every integrated plugin.

> **How to add one →** [Contributing guide]({{ '/CONTRIBUTING.html' | relative_url }})
> ·
> [`plugins/README.md`](https://github.com/jphein/realmwatch/blob/master/plugins/README.md)

---

## UI panels

Plugins that ship a `panel.html / panel.js / panel.css` and surface a
dockable panel in the realm-map UI.

| Plugin | Fantasy name | Icon | What it does |
|---|---|:--:|---|
| `census` | Realm Census | ⚑ | Grouped node list with live online/offline status from SSE. The default "what's in the realm" panel. |
| `chat` | Oracle Link | 💬 | Session-based Azure AI chat. Context-aware — chat about a node and the bridge knows which node you mean. o4-mini by default. |
| `codex` | Lore Archives | 📚 | Notion-synced lore wiki served at `/codex/`. Architecture entries, runbooks, bestiary. |
| `debug` | Arcane Mirror | 🔮 | Filterable debug panel, Arcane Grimoire API catalogue, Scrying Terminal command interface. The "what's actually happening" view. |
| `plugin-manager` | Enchantment Registry | 📜 | Lists loaded plugins, their endpoints, SSE sources, panels. Health view for the plugin ecosystem. |
| `scan` | Survey Glass | 🔭 | On-demand triggers for WiFi/LLDP/firewall/oracle/discovery scans. The button you press when you don't want to wait for the next poll. |
| `skills` | Inscription Codex | ✎ | Browse and edit Claude Code Skills, CLAUDE.md, Hooks, Agents. |
| `system-updates` | Scroll of Patch Runes | 📜 | Tracks pending updates across APT, Snap, Flatpak, mise, brew, npm, pip-user, firmware (fwupd), and AI CLI tools. Verification module: L1 advisory, L2 quarantine, L3 script diff. |
| `projects` | The Scholar's Archive | 📚 | Local `~/Projects/` inventory — git status, stack detection, sigil version checks. |

---

## Data bridges

Plugins that talk to an external data source and feed it into the realm.

| Plugin | Fantasy name | Icon | What it does |
|---|---|:--:|---|
| `collectd` | Scrying Stones | 📊 | Collectd RRD reader (`/var/lib/collectd/rrd/`) + live UDP listener (port 25826). Powers per-host metric summaries and the Realm Census panel. |
| `firewall` | Ward Stones | 🛡️ | nftables JSON parser via gatekeeper. Maps zones to VLANs, surfaces suggestions, reads per-zone counters. |
| `ha` | Crystal Bridge | 🏠 | Home Assistant REST poll — entity states, device registry, energy (solar/battery/grid). Used by the energy SSE event. |
| `latency` | Arcane Pulse | 🏸 | Background fping batch prober — every 30s for wired nodes, RTT pre-grouped by VLAN. |
| `wifi` | Aether Towers | 📡 | SSH to APs, runs `iwinfo` for clients, parses DHCP lease files for identity, captures LLDP for topology, captures signal data for the WiFi heatmap. |
| `wled` | Prismatic Lights | 💡 | WLED HTTP polling + control. Read state, change effects/colours from a node panel. |
| `notion` | Quest Portals | 📜 | Notion API — pulls Today todos as quest events, marks completed, syncs codex entries. |
| `netdata` | Oracle Sight | 🕮 | Netdata agent REST — `/api/v1/info`, charts, alarms, collectors. Replaces collectd progressively. |
| `caddy` | Gate Warden | 🚧 | Reverse proxy route discovery — reads Caddyfile or the admin API, maps `domain → backend`. |
| `health` | Watchtower Beacon | 🚨 | HTTP / TCP / TLS expiry checks + realm-sigil version probes. Cross-project health for the realm.watch family. |
| `alerting` | Herald's Watch | 📢 | Routes realm events to channels (desktop, SSE toast, voice, email, webhook, Pushover). Owns trigger-dependency suppression and the rule engine. |

---

## Discovery providers

Plugins that register a discovery provider with the autodiscovery engine and
emit `sub_entities` linked back to topology nodes. Sub-entities show on the
node's Vassals tab and as discovery count badges on the map.

| Plugin | Scans / discovers |
|---|---|
| `discovery` | Companion plugin — registers the engine's API endpoints, SSE source, and node enricher. The "engine itself as a plugin." |
| `docker-discovery` | Docker containers on hosts via SSH |
| `kvm` | KVM/libvirt VMs on hypervisors via `virsh` |
| `systemd` | Interesting systemd services via SSH or local D-Bus |
| `snmp` | Switch ports, interface status, MAC tables, system info. SNMPv2c + SNMPv3 (auth+priv). |
| `nmap` | Open ports, service versions, OS fingerprinting |
| `github` | Repos, CI status, PRs via `gh` CLI |
| `projects` | Local `~/Projects/` inventory, git status, stack detection |
| `manual` | Static infrastructure entries — relationships, tags, bookmarks. The "Chronicler's Quill." |

Role-based provider defaults from `discovery_engine.py`:

| Role | Default providers |
|---|---|
| `server` | docker, systemd, netdata |
| `nas` | docker, systemd |
| `vm` | systemd, netdata |
| `hypervisor` | docker, kvm, systemd, netdata |
| `router` | snmp, netdata |
| `switch` / `ap` | snmp |
| `desktop` / `laptop` | systemd, netdata |

A new node gets the right discovery treatment automatically based on its role.

---

## Daemons, effects, and services

| Plugin | Fantasy name | Icon | What it does |
|---|---|:--:|---|
| `herald` | Town Crier | 📯 | Manages the realm-herald subprocess — picks interesting nodes, applies themed templates, emits speech events. |
| `events` | Sentinel Wards | ⚡ | Event generator — monitors collectd metrics and Home Assistant states, fires fantasy-themed alerts when thresholds are crossed. |
| `ansible` | War Room | ⚔️ | Ansible playbook execution + AI-assisted infrastructure operations. Owns `update-ubuntu.yml` and `install-netdata.yml`. |
| `forest-theme` | Enchanted Canopy | 🌿 | Ambient particle system on the map — wisps, butterflies, fireflies, leaves, sparkles, fog. Purely cosmetic. |
| `game-servers` | Arena Watcher | 🎮 | Minecraft Bedrock UDP ping + Terraria TCP check. Surfaces server status as node sublabels. |

---

## Infrastructure / operations

The freshly-bound Zabbix-class spells. Each shipped in v0.4 and slots into
the alerting + discovery pipelines.

| Plugin | Fantasy name | Icon | What it does |
|---|---|:--:|---|
| `maintenance` | Veiled Hours | 🔨 | Scheduled maintenance windows. While a window is active, both the alerting pipeline and the herald daemon fall silent for the matching nodes. Recurring, one-shot, by node pattern or by role. |
| `agent-register` | The Heralds' Gate | 🚪 | Active agent self-registration. New hosts run a one-line install script that announces themselves and starts a heartbeat. Metadata (OS, OUI, hostname) drives automatic role and tag assignment. |
| `discovery-actions` | The Onboarding Sigils | 🪄 | Declarative auto-classification rules. *If OUI matches OpenWrt, then role=ap, then add tag wireless.* Evaluated at discovery time. Preview-only test mode (`realm discovery-actions test`) before live writes. |

---

## Plugins with declarative CLI verbs (Method B)

The CLI dispatcher reads `cli.verbs` from `plugin.json` and proxies HTTP
through `scripts/lib/http.sh`. These plugins ship a working `realm <plugin>`
command without any per-plugin CLI code.

| Plugin | Verbs |
|---|---|
| `wifi` | `aps`, `clients`, `lldp`, `status`, `scan` |
| `ansible` | `inventory`, `playbooks`, `runs`, `run`, `run-check`, `ai` |
| `chat` | `ask`, `sessions`, `history`, `clear` |
| `collectd` | `show` |
| `latency` | `show` |
| `firewall` | `show` |
| `ha` | `energy` |
| `herald` | `status` |
| `notion` | `sync`, `complete` |
| `system-updates` | `list`, `inventory`, `history`, `check`, `check-one`, `run`, `run-one`, `cancel`, `approve`, `skip` |
| `maintenance` | `list`, `active`, `check`, `cancel` |
| `agent-register` | `list`, `show`, `install-script`, `forget` |
| `discovery-actions` | `list`, `test`, `apply`, `delete` |

---

## Specs not yet implemented

Documented in the plugin contract but no plugin currently exercises them.
Flag clearly when working in adjacent areas:

| Spec | Status |
|---|---|
| Per-plugin `<name>.service` systemd unit | Listed in the plugin file structure; no plugin currently ships one. |
| `standalone` plugin type | Reserved in the schema; no plugin uses it. |
| `on-demand` plugin type | Reserved; no plugin uses it. |
| Per-plugin backend migration | In progress — backends like `ha_bridge.py`, `ap_scanner.py` still live at repo root and are imported by their plugins. |
