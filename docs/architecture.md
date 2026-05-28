---
layout: default
title: Architecture
---

# Architecture

Two design rules carry most of the weight in realmwatch.

> **Thin core, fat plugins.** The bundled frontend is a rendering engine.
> Every domain feature is a plugin. The core grows only for rendering or
> infrastructure changes.

> **`engine.py` is the single source of truth.** All realm logic — sensor
> readings, Tailscale mesh, nft counters, fantasy translations — lives
> there. Other files call into it; never duplicate it.

Everything below explains how those two rules play out.

---

## System diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│ Browser — realm-map.html                                               │
│   ├── src/*.js → esbuild IIFE bundle (realm-map.js)                    │
│   │   panel-manager · map-view · topology · terrain · effects ·        │
│   │   traffic · quest-log · spellbook · node-controls · node-status ·  │
│   │   app · plugin-api · winbox-wm · layout · persona-editor           │
│   └── plugins/<name>/panel.{js,html,css} loaded at runtime             │
│                                                                        │
│   SSE consumer dispatches typed events through `plugin-broadcast` to   │
│   plugin panels via `window.RealmAPI`.                                 │
└────────────────────────────────────────────────────────────────────────┘
                                 │ HTTP + SSE
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ map_server.py :80     (stdlib http.server + ThreadingMixIn)            │
│                                                                        │
│   route_table.py — path → handler dispatch                             │
│                                                                        │
│   plugin_loader.py — scans plugins/, validates manifests, sorts        │
│                       depends_on, calls setup(ctx) for each            │
│   plugin_context.py — the PluginContext API exposed to setup()         │
│   plugin_registry.py — running registry of loaded plugins              │
│                                                                        │
│   sse_broker.py — hash-deduped fanout + burst replay on connect        │
│                                                                        │
│   engine.py + node_roles.py — sensors, mesh, fantasy translations      │
│   discovery_engine.py — provider registry, sub-entity linking          │
│   realm_db.py — SQLite WAL, 12 tables, settings/events/personas/…      │
│                                                                        │
│   chat_bridge.py — Azure AI chat (session-based, shared DB)            │
└────────────────────────────────────────────────────────────────────────┘
                 │                                  │
                 ▼                                  ▼
   Independent daemons                  Discovery providers
   (separate processes, opt-in)         (per-host, pluggable)
   ─────────────────────                ────────────────────
   oracle_daemon.py                     netdata · snmp · docker · kvm ·
   realm_herald.py                      systemd · nmap · ha · caddy ·
   realm_launcher.py :8899              github · projects · manual · …
```

---

## The plugin system

The structural truth of realmwatch. 47 plugins today. Every domain feature
is one.

### Lifecycle

`plugin_loader.py` runs at server startup:

1. **Scan.** Walks `plugins/`, finds every directory containing a
   `plugin.json`.
2. **Validate manifests.** Required fields: `name`, `version`, `type`.
   Name must match the directory.
3. **Topological sort on `depends_on`.** Refuses to start on cycles or
   missing dependencies.
4. **Import.** Loads `<plugin>/plugin.py` and calls `setup(ctx)` with a
   `PluginContext`.
5. **Register.** Endpoints, SSE sources, enrichers, discovery providers,
   and background threads land in `plugin_registry.py`.

The dispatcher in `route_table.py` consults the registry on every request.
No hot reload — plugin changes need a server restart.

### `PluginContext` (the `ctx` argument)

Exposed to every `setup(ctx)`:

| Hook | Purpose |
|---|---|
| `ctx.endpoint(path, method=…)` | Register HTTP handler |
| `ctx.sse_source(event_type, interval, source_fn)` | Register a hash-deduped SSE feeder |
| `ctx.enrich_node(fn)` | Add fields to a node's status payload |
| `ctx.register_discovery_provider(provider)` | Supply a discovery provider |
| `ctx.broadcast(event_type, payload)` | Push a typed SSE event |
| `ctx.thread(target=…, name=…)` | Start a tracked daemon thread |
| `ctx.db` | `RealmDB` handle for shared SQLite state |
| `ctx.logger` | Plugin-namespaced Python logger |

### Plugin types

| Type | Lifecycle | Status |
|---|---|---|
| `integrated` | In-process; `setup(ctx)` called at boot | The only type currently exercised |
| `standalone` | Separate systemd process; HTTP API | Reserved in schema, no plugin uses it |
| `on-demand` | Subprocess on user action | Reserved, no plugin uses it |

### Method A vs Method B CLI

Plugins can expose CLI verbs two ways:

- **Method A** — drop an executable at `plugins/<name>/cli`. Any language.
  Must respond to `--one-line-help`, `--list-subcommands`, `--help`. The
  dispatcher execs it with the remaining args.
- **Method B** — add `cli.verbs` to `plugin.json`. The generic `realm-plugin`
  handler reads the manifest at request time and proxies HTTP through
  `scripts/lib/http.sh`. Zero per-plugin code for HTTP-pass-through plugins.

If both exist for the same plugin, Method A wins.

---

## The frontend bundle

`src/main.js` is the esbuild entry point. The bundle (`realm-map.js`,
IIFE, ES2020, sourcemaps) carries:

- **Panel system** (`panel-manager.js`, ~2,600 lines). Dock, anchored,
  conjured, hidden-seal modes; drag-to-reposition; formations (saved
  groupings).
- **Map view** (`map-view.js`, ~1,400 lines). Pan/zoom, touch handling,
  node drag, deferred rendering, Z-index marshalling for the world globe.
- **Topology renderer** (`topology.js`). SVG nodes + connections, refresh
  driven by the SSE `topology` event, not a timer.
- **Terrain compositor** (`terrain.js`). Biome terrain + heightmap
  contour rendering. Marching squares run in a web worker
  (`topo-worker.js`).
- **Traffic animator** (`traffic.js`). Connection SVG dash animation
  driven by the `traffic` SSE event.
- **Quest log** (`quest-log.js`). Speech bubbles, event rendering,
  bubble-follow-node positioning.
- **Spellbook** (`spellbook.js`). Search index + enchant tab.
- **Node controls** (`node-controls.js`). SSH terminal, WoL, WLED, per-node
  shell / chat / control surfaces.
- **Plugin API** (`plugin-api.js`). `window.RealmAPI` — SSE hooks, panel
  registration, event bus. The contract plugin panels code against.

Web workers (not bundled — edit directly):

- `layout-worker.js` — force-directed + BFS tree + VLAN cluster layout.
- `topo-worker.js` — heightmap stamping, marching-squares → SVG contours.

---

## The SSE broker

`sse_broker.py` is the live data spine. Hash-deduped — only pushes on change.

### Event types

| Event | Frequency | Content |
|---|---|---|
| `status` | 10s | Sensors, collectd, WiFi, HA, sublabels |
| `traffic` | 5s | Per-node traffic intensity (log scale) |
| `topology` | 60s | Full topology (nodes + connections + regions) |
| `energy` | 30s | Solar, battery, grid (HA) |
| `latency` | 30s | Pre-grouped latency by VLAN |
| `firewall` | 60s | Parsed nftables (cached) |
| `wifi` | 120s | AP client lists, signal data |
| `plugin-broadcast` | live | Plugin-dispatched events, routed via `dispatchPluginSSE` in `app.js` |
| `realm-event` | live | Individual realm events (speech, alert, highlight, quest) |

### Initial burst

On connect, the broker replays in this order: `topology → traffic → energy
→ latency → recent events → status`. New clients render a full map without
waiting for the next tick.

---

## Discovery engine

`discovery_engine.py` orchestrates plugin-registered providers to discover
sub-entities per host.

### Role-based defaults

| Role | Providers |
|---|---|
| `server` | docker, systemd, netdata |
| `nas` | docker, systemd |
| `vm` | systemd, netdata |
| `hypervisor` | docker, kvm, systemd, netdata |
| `router` | snmp, netdata |
| `switch` / `ap` | snmp |
| `desktop` / `laptop` | systemd, netdata |

A new node gets the right discovery treatment automatically based on its role.

### Tables

| Table | Purpose |
|---|---|
| `sub_entities` | Discovered things (containers, VMs, services, ports) |
| `discovery_links` | Edges from sub-entities to topology nodes |
| `discovery_capabilities` | Provider capability declarations |

Sub-entities flow back to the topology node's `vassals` tab, the discovery
count badge on the map, and the Realm Surveyors dashboard.

### HostAccess

A reachability cache shared by providers. Fed by `fping`. Avoids hammering
unreachable hosts every poll cycle.

---

## The alerting pipeline

`plugins/alerting/` runs the rule engine + 6 channel adapters (desktop, SSE
toast, voice, email, webhook, Pushover). New as of v0.4:

### Trigger-dependency suppression (`dependencies.py`)

- `walk_upstream(db, node_id, max_depth=5)` — BFS through topology
  connections, direction-agnostic (realm's `from_node` / `to_node` aren't
  reliably oriented), filtered to `UPSTREAM_TYPES = {core, infra, router,
  switch, tower, bridge}`.
- `has_recent_problem(db, node, lookback_seconds=120)` — queries the
  universal events table for failed/critical events. Catches problem
  signals from any plugin, not just alerting itself.
- `find_blocking_ancestor` — short-circuits on first failing ancestor.
- `explain(node)` — full chain walk + status. Powers `realm alerting why
  <node>`.
- 200-entry in-memory audit ring of every suppression decision.

### Event acknowledgement

Four columns on `events`: `ack_at`, `ack_by`, `ack_note`, `closed_at`.
A matching alert arriving after an ack is dropped in the dispatch pipeline
(`status='ack_suppressed'`, `error='acked_by:<name>'`).

```
POST /events/<id>/ack    {"by":"jp","note":"on it"}
POST /events/<id>/close  {"by":"jp"}
POST /events/<id>/comment {"by":"jp","text":"…"}
GET  /events?ack=false
```

---

## Maintenance windows

`plugins/maintenance/` registers scheduled windows that mute downstream
consumers of realm events. While a window is active for a node, the
alerting plugin drops matching events (`status='maintenance_suppressed'`)
and the herald daemon skips that node when picking voices. Recurring,
one-shot, or pattern-based (`*-router`, `ap-*`).

```
POST /maintenance/windows  {"name":"kernel reboot","node_pattern":"katana","starts_at":…,"ends_at":…,"recur":"once"}
GET  /maintenance/active
GET  /maintenance/check/<node>
```

---

## Onboarding pipeline

Two plugins introduced in v0.4 form an opt-in onboarding pipeline for hosts
that aren't already in `topology.json`.

1. **`agent-register`** — The Heralds' Gate. A new host runs a one-line
   install script (`GET /register/install.sh`) that:
   - registers itself (`POST /register/agents` with hostname, IP, OS, OUI),
   - starts a periodic heartbeat (`POST /register/heartbeat`).
   The registration is durable in `realm.db`; last-seen time drives the
   liveness signal.

2. **`discovery-actions`** — The Onboarding Sigils. A list of declarative
   match-then-act rules:

   ```yaml
   - id: openwrt-ap
     match:
       oui_prefix: ["00:90:4C", "C4:6E:1F"]   # Belkin / Linksys OUIs
     act:
       role: ap
       tags: [wireless, openwrt, infra]
   ```

   Rules fire at discovery time (whether the source is `agent-register`, an
   nmap sweep, or a manual entry). `realm discovery-actions test <node>`
   previews matches without writing.

Together: a host runs one curl, lands in `nodes` with the right `role` and
`tags`, and the discovery engine picks the matching providers automatically.

---

## Low-Level Discovery (discovery prototypes)

Closing the loop on the discovery engine: plugins declare prototypes in
`plugin.json` once, and `plugin_registry.get_discovery_prototypes()`
aggregates them across the fleet. A prototype is a template — sublabel,
fantasy text, alert clauses — with `{{#MACRO}}` placeholders that resolve
per discovered instance.

```jsonc
// plugins/docker-discovery/plugin.json
"discovery_prototypes": [{
  "entity_type": "container",
  "sublabel":    "{{#NAME}} • {{#STATE}}",
  "fantasy_template": "Iron Golem '{{#NAME}}'",
  "alert_on": [
    {"when": "{{#STATE}} in ['exited','dead']",
     "severity": "warning",
     "text_template": "The Iron Golem '{{#NAME}}' has fallen silent in {{#HOST}}"},
    {"when": "{{#STATE}} == 'restarting' and {{#RESTART_COUNT}} > 5",
     "severity": "critical",
     "text_template": "The Iron Golem '{{#NAME}}' shudders and crashes in {{#HOST}} ({{#RESTART_COUNT}} restarts)"}
  ]
}]
```

Shipped pilots: `docker-discovery` (containers) and `netdata` (netdata
hosts). Exposed as `GET /discovery/prototypes` and surfaced through
`realm discovery prototypes`.

---

## Database

`realm.db` (SQLite WAL). 12 tables:

| Table | Purpose |
|---|---|
| `settings` | Key-value per namespace |
| `events` | Timestamped realm events (plus ack/close since v0.4) |
| `personas` | Per-node persona data |
| `nodes` | Topology nodes with positions, `os`, `os_version`, `tags` |
| `connections` | Node-to-node connections |
| `regions` | Biome map regions |
| `quests` | Quest log |
| `notion_synced` | Notion sync state |
| `wifi_scans` | WiFi scan history |
| `sub_entities` | Discovery-engine sub-entities |
| `discovery_links` | Edges between sub-entities and topology nodes |
| `discovery_capabilities` | Provider capability declarations |

`topology.json` is a downstream artifact regenerated from `nodes` /
`connections`. It is gitignored — query through the HTTP API.

---

## Key design decisions

- **Thin core, fat plugins.**
- **`engine.py` is the single source of truth.**
- **Server-side sublabels.** Pre-computed in `map_server.py`; the browser
  renders ready-made strings.
- **Hash-based SSE dedup.** Broadcast only on change.
- **Topology refresh is SSE-driven**, not timer-based.
- **Web workers** for layout and terrain contour computation.
- **6-signal enrichment pipeline** identifies unknown devices via OUI, port
  probe, HA `device_tracker`, LLDP, DHCP, hostname heuristics.
- **Write-through** for personas and config — DB + JSON files.
- **No hot reload.** Plugin changes need a restart.
- **Daemons are off by default.** systemd is opt-in.
- **Fantasy theming is core.** Maintain the aesthetic in user-facing code.

---

## Where to look in the source

| File | Lines | Role |
|---|---:|---|
| `map_server.py` | ~1,900 | HTTP :80, route dispatch, plugin wiring, static |
| `realm_launcher.py` | ~1,200 | Port 8899 — branch portal, map_server restart |
| `realm_db.py` | ~1,200 | SQLite WAL — 12 tables, ack columns, settings/events/etc. |
| `node_roles.py` | ~950 | 30+ role defs, 6-signal enrichment, OUI lookup |
| `discovery_engine.py` | ~660 | Provider registry, scan orchestration, sub-entity linking |
| `engine.py` | ~450 | RealmEngine — sensors, Tailscale mesh, nft counters |
| `plugin_loader.py` | ~370 | Discovery, manifest validation, topo-sort, lifecycle |
| `plugin_context.py` | ~360 | The `PluginContext` API |
| `sse_broker.py` | ~320 | Hash-deduped SSE fanout + burst replay |
| `realm_herald.py` | ~320 | Voice daemon — themed templates, speech events |
| `oracle_daemon.py` | ~300 | AI oracle — polls events, calls Azure AI |
| `chat_bridge.py` | ~290 | Azure AI chat (session-based, shared DB) |
| `plugin_registry.py` | ~200 | Running registry of plugins/panels/endpoints |
| `route_table.py` | ~140 | Path → handler table |
