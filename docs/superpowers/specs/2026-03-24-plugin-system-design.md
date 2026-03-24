# Realmwatch Plugin System Design Spec

**Date:** 2026-03-24
**Status:** Draft
**Author:** JP + Claude

## Overview

A formal plugin and modding system for Realmwatch that:
- Enables drop-in feature extensions without modifying core code
- Supports three plugin types: integrated (in-process), standalone (systemd), on-demand (invoked)
- Provides full-stack capabilities: backend (Python) + frontend (JS/HTML/CSS) + node enrichment + map overlays
- Extracts all existing optional integrations into plugins, leaving a thin core
- Ships Ansible, Grafana, and Netdata as the first new plugins

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Plugin scope | Full-stack + standalone | Oracle, herald, Ansible, Grafana all run independently |
| Distribution | Directory convention (`plugins/`) | Single machine, local dev — simplest approach |
| Discovery | Pull model (realm scans on startup) | Offline plugins stay visible; no chicken-and-egg |
| Frontend power | Panel + map layer + node enrichment | Required for HA bridge and WLED backporting |
| Backporting | Full extraction of all optional integrations | Plugin API must express everything bridges do |
| Architecture | Hybrid manifest + context API | Manifest for the 80%, Python API for the dynamic 20% |
| Frontend loading | Separate `<script>` tags, not bundled | Drop-in without rebuild; `RealmAPI` global as contract |
| Hot reload | No | Restart map_server to load plugin changes |
| Window manager | Agnostic | `registerPanel()` abstracts underlying WM implementation |
| Security model | Full trust | Local-only project; plugins have full DOM/API access |
| API stability | Break-and-fix | All plugins are local; update all in same commit when API changes |
| Sublabel strategy | Priority-based override (preserves current behavior) | HA > WLED > WiFi > collectd; first enricher with a sublabel wins per node |

## Plugin Types

### Integrated

Runs inside the map_server process as a background thread. For data collection bridges.

- Loaded at server startup via Python import
- Plugin's `setup(ctx)` called with `PluginContext`
- Background threads managed via `ctx.start_background_thread(fn, interval)`
- Data exposed via SSE sources and node enrichers
- Examples: ha-bridge, wled-bridge, latency, firewall, collectd, wifi-scanner, event-generator, notion, chat

### Standalone

Runs as a separate process managed via systemd. For daemons with their own lifecycle.

- Realm discovers via `plugin.json` but doesn't import Python code at startup
- Controlled via `systemctl --user start/stop/status <service>`
- Communicates with realm via HTTP API (push events, read topology)
- Realm shows plugin status (running/stopped) in UI
- Examples: oracle, herald

### On-Demand

No persistent process. Invoked when triggered by user action or schedule.

- Realm discovers via `plugin.json`
- Execution triggered via POST endpoint (e.g., "run playbook")
- Runs in subprocess, streams output via SSE
- Results stored in plugin DB table
- Examples: ansible

## Directory Structure

```
plugins/
  <plugin-name>/
    plugin.json          # Manifest (required)
    plugin.py            # Python entry point (optional for standalone/on-demand)
    panel.html           # Panel template fragment (optional)
    panel.js             # Frontend code (optional)
    panel.css            # Styles (optional)
    <plugin-name>.service  # systemd unit template (optional)
    requirements.txt     # Additional pip dependencies (optional)
    ...                  # Plugin-specific assets
```

## Manifest Schema (plugin.json)

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "type": "integrated",  // "integrated" | "standalone" | "on-demand"
  "description": "Human-readable description",
  "fantasy_name": "Enchanted Name",
  "icon": "emoji or SVG path",

  "python": {
    "module": "plugin",
    "entry": "setup",
    "requirements": []
  },

  "panel": {
    "id": "example-panel",
    "name": "Panel Display Name",
    "anchor": "ne | nw | se | sw | n | s | e | w",
    "priority": 20,
    "html": "panel.html",
    "js": "panel.js",
    "css": "panel.css"
  },

  "endpoints": [
    {
      "method": "GET | POST | DELETE",
      "path": "/relative/path",
      "handler": "function_name",
      "raw_path": false
    }
  ],

  "sse_types": ["event-type-name"],

  "service": "systemd-service-name.service",

  "depends_on": ["other-plugin-name"],

  "config": {
    "key": { "type": "string", "default": "value", "description": "..." }
  }
}
```

**Field notes:**
- `type` determines lifecycle management
- `python.module` is relative to the plugin directory
- `panel` fields are all optional individually; omit `panel` entirely for headless plugins
- `endpoints[].path` is auto-prefixed with `/plugins/<name>/` unless `raw_path: true`
- `sse_types` declares SSE event types this plugin will emit
- `service` is the systemd unit name for standalone plugins
- `depends_on` controls load order; dependent plugins load after their dependencies
- `config` declares configurable settings stored in realm.db

## Core Runtime

### plugin_loader.py

New module responsible for discovery, validation, and lifecycle management.

**Startup sequence** (called from `map_server.py __main__`):

1. Scan `plugins/` directory for subdirectories containing `plugin.json`
2. Parse and validate each manifest against schema
3. Topological sort by `depends_on` (cycles detected and reported as error — involved plugins skipped)
4. For each plugin (in order):
   a. Validate required files exist (referenced HTML, JS, CSS, Python module)
   b. If `python.module` declared: import module, call `entry(ctx)` with `PluginContext`
   c. Register panel metadata for frontend injection
   d. Register endpoint handlers in route table
   e. Register SSE sources with broker
   f. For standalone: register systemctl control
5. Return `PluginRegistry`
6. Log summary: loaded N plugins (X integrated, Y standalone, Z on-demand)

**Error handling:** A failing plugin logs the error and is skipped. Other plugins continue loading. The realm functions with a degraded plugin set rather than refusing to start.

### PluginContext

Passed to each plugin's `setup()` function. Scoped to the plugin.

```python
class PluginContext:
    # Identity
    name: str                          # Plugin name from manifest
    data_dir: Path                     # plugins/<name>/ — plugin's directory
    config: dict                       # Merged config (manifest defaults + DB overrides)

    # Storage
    db: PluginDB                       # Scoped DB access

    # Registration (dynamic — supplements manifest declarations)
    def register_endpoint(method, path, handler)
    def register_sse_source(event_type, getter_fn, interval)
    def register_node_enricher(fn)     # fn(node_id, node_data) -> dict | None
    def register_context_menu_item(label, handler_fn)
    def on_event(event_type, handler_fn)  # React to realm events
    def register_status_provider(fn)   # fn() -> dict (for build_status aggregation)

    # Utilities
    def push_event(type, data)         # Write to events table
    def get_topology()                 # Read current topology
    def get_node(node_id)              # Read single node
    def log(msg, *args)                # Plugin-scoped logging (prefixed with plugin name)
    def start_background_thread(target, interval=None, name=None)  # Managed daemon thread

    # Inter-plugin
    def expose_api(api_dict)           # Expose public API for other plugins
    def get_plugin_api(plugin_name)    # Access another plugin's public API (if exposed)
```

### PluginDB

Scoped database access preventing cross-plugin collision.

- **Settings:** Namespaced as `plugin:<name>` in the existing settings table
  - `ctx.db.get_settings()` → reads `namespace='plugin:<name>'`
  - `ctx.db.set_settings(data)` → writes to `namespace='plugin:<name>'`
- **Custom tables:** Created with `plugin_<name>_` prefix
  - `ctx.db.create_table(table_name, schema)` → creates `plugin_<name>_<table_name>`
  - `ctx.db.execute(sql, params)` → scoped to plugin's tables only
  - `ctx.db.query(sql, params)` → scoped to plugin's tables only
- **Events:** Full access to write events (same as current `push_event`)
- **Read-only access** to core tables (nodes, connections, regions) via `ctx.get_topology()`, `ctx.get_node()`

### PluginRegistry

Queryable by all core components.

```python
class PluginRegistry:
    def get_all_plugins() -> list[PluginInfo]
    def get_plugin(name) -> PluginInfo | None
    def get_endpoints() -> list[Route]
    def get_sse_sources() -> list[SSESource]
    def get_panels() -> list[PanelInfo]
    def get_node_enrichers() -> list[Callable]
    # Map overlays are frontend-only (registered via RealmAPI.registerMapOverlay in JS)
    def get_context_menu_items() -> list[MenuItem]
    def get_status_providers() -> list[Callable]
    def get_plugin_status(name) -> dict  # running/stopped/error + metadata
```

## Endpoint Routing

### RouteTable

Replaces the if/elif chains in `RealmHandler.do_GET()` and `do_POST()`.

```python
class RouteTable:
    def __init__(self):
        self._routes = []  # [(method, pattern, handler, plugin_name)]

    def add(self, method, path, handler, plugin=None):
        """Register a route. Core routes added first (highest priority)."""
        self._routes.append((method, path, handler, plugin))

    def match(self, method, path) -> tuple[Callable, dict] | None:
        """Find matching handler. Returns (handler, path_params) or None."""
        for m, pattern, handler, plugin in self._routes:
            if m == method:
                params = self._match_pattern(pattern, path)
                if params is not None:
                    return handler, params
        return None
```

**Path patterns** support simple parameter extraction:
- `/plugins/ansible/run/<id>` matches `/plugins/ansible/run/42` with `params = {"id": "42"}`
- Exact matches checked before parameterized routes

**Handler signature:**
```python
def handler(req: PluginRequest, params: dict) -> dict | None:
    """Handler receives a wrapper request object and path params.
    Return a dict to send as JSON, or None to indicate already handled."""
    body = req.json()          # parse JSON body
    req.respond({"result": "ok"})  # or return {"result": "ok"}
```

`PluginRequest` wraps `RealmHandler` to expose a clean public API (`json()`, `respond()`, `query_params`, `headers`) without leaking HTTP internals.

**RealmHandler changes:**
```python
def do_GET(self):
    match = _route_table.match("GET", self.path)
    if match:
        handler, params = match
        handler(PluginRequest(self), params)
    elif self.path.startswith("/plugins/"):
        self._serve_plugin_static(self.path)
    else:
        super().do_GET()
```

**Plugin static file serving:** `/plugins/<name>/<file>` serves files from `plugins/<name>/` directory. MIME types inferred from extension. Only serves files within the plugin directory (path traversal prevention).

## SSE Broker Changes

### Registry-Based Sources

The SSE broker's constructor accepts only the core status function. All other data sources register dynamically.

```python
broker = SSEBroker(build_status)

# Core sources (hardcoded — fundamental to realm):
#   status:    every 10s (tick % 2)
#   traffic:   every 5s  (every tick)
#   topology:  every 60s (tick % 12)
#   events:    every 5s  (every tick)

# Plugin sources register via:
broker.register_source(SSESource(
    event_type="energy",
    getter_fn=get_energy_data,
    interval=30,          # seconds
    burst=True,           # include in initial burst to new clients
    burst_priority=3,     # order within burst (lower = earlier)
))
```

### Collect Loop

```python
def _collect_loop(self):
    tick = 0
    while self._running:
        # Core sources (status, traffic, topology, events) — hardcoded

        # Plugin sources — dynamic
        for source in self._plugin_sources:
            tick_interval = source.interval // 5  # convert seconds to ticks
            if tick_interval > 0 and tick % tick_interval == 0:
                try:
                    data = source.getter_fn()
                    if data:
                        self._check_and_push(source.event_type, data)
                except Exception:
                    pass

        tick += 1
        time.sleep(5)
```

### Initial Burst

New SSE client burst sequence becomes:
1. Core: topology → traffic
2. Plugin sources with `burst=True`, ordered by `burst_priority`
3. Core: recent events → status (status last so it includes enrichments)

## Frontend Plugin Integration

### Plugin Loading Sequence

On page load, after core initialization:

1. `app.js` fetches `GET /plugins` → list of active plugins with panel/JS/CSS metadata
2. For each plugin with CSS: inject `<link rel="stylesheet" href="/plugins/<name>/panel.css">`
3. For each plugin with JS: inject `<script src="/plugins/<name>/panel.js">`
4. After all scripts load: call `window.RealmPlugins.<name>.init(window.RealmAPI)` for each
5. Panels appear in panel manager, available in formations

### RealmAPI (window.RealmAPI)

Global API exposed by the core bundle for plugin scripts:

```javascript
window.RealmAPI = {
  // Panel management
  registerPanel(id, { name, icon, anchor, priority, html }),
  removePanel(id),

  // SSE events
  onSSE(eventType, handler),          // Subscribe to SSE event type
  offSSE(eventType, handler),         // Unsubscribe

  // Node enrichment
  registerNodeEnricher(fn),           // fn(nodeId, nodeData) -> {sublabel, badge, ...}
  registerContextMenuItem(label, fn), // fn(nodeId) — right-click on nodes
  registerMapOverlay(renderFn),       // fn(svgLayer) — draw SVG on map

  // Data access (read-only)
  getTopology(),                      // Current topology snapshot
  getNode(nodeId),                    // Single node data
  getLastStatus(),                    // Last status SSE payload

  // Utilities
  fetch(path, opts),                  // Fetch to plugin endpoints (auto-prefixes /plugins/<name>/)
  showToast(message, type),           // Notification toast (info/warning/error)
  openPanel(panelId),                 // Programmatically show a panel
  closePanel(panelId),                // Programmatically hide a panel
  pushEvent(type, data),              // POST to /event
  getPluginConfig(pluginName),        // Read plugin configuration
};
```

### Panel Injection

When `registerPanel()` is called:
1. Create panel DOM element from the plugin's HTML template (fetched via `/plugins/<name>/panel.html`)
2. Wrap in standard panel chrome (header bar, collapse/seal/close buttons, drag handle)
3. Add to panel manager's `PANELS` registry
4. Create dock sigil/rune icon
5. Add to Grand Arcanum formation and make available for custom formations
6. Persist panel state (position, visibility) in localStorage like core panels

Plugin HTML templates are **fragments** — just the panel interior content. The panel manager/WM provides the chrome. This keeps plugins WM-agnostic.

### SSE Dispatch

SSE already supports custom event types natively. If the broker sends:
```
event: ansible
data: {"status": "running", "playbook": "update-all.yml"}
```

Then `RealmAPI.onSSE('ansible', handler)` works automatically via `eventSource.addEventListener('ansible', ...)`. No changes to core SSE dispatch needed.

## Node Enrichment Pipeline

### Enrichment Contract

Each plugin registers a function via `ctx.register_node_enricher()` (Python) or `RealmAPI.registerNodeEnricher()` (JS):

```python
def enrich_node(node_id, node_data):
    """Return enrichment dict or None."""
    return {
        "sublabel": "22C | Cooling",          # Text below node name
        "badge": "thermometer",                # Icon overlay on map node
        "status_class": "warning",             # Visual state: ok | warning | critical
        "context_menu": [                      # Right-click menu items
            {"label": "Set Temperature", "action": "ha-bridge:set-temp", "data": {...}}
        ],
        "meta": {"ha:temperature": 22, ...}    # Structured data (namespaced keys)
    }
```

All fields optional. Return `None` to skip this node.

### Merge Strategy

When multiple plugins enrich the same node:

| Field | Merge Rule |
|-------|------------|
| `sublabel` | **Priority-based override** — first enricher (by plugin load order / `depends_on`) that returns a sublabel wins. This preserves the existing behavior where HA sublabels override WLED which override WiFi. Enrichers declare a `priority` (lower = higher priority, default 50). |
| `badge` | Collect into list (all displayed) |
| `status_class` | Worst wins: `critical > warning > ok` |
| `context_menu` | Merge into single menu, grouped by plugin |
| `meta` | Merge dict (plugin-namespaced keys prevent collision) |

**Why priority-based sublabels:** The existing `_compute_sublabels()` uses early-exit priority ordering (HA wins, then WLED, then WiFi, then collectd). Concatenating all sources would clutter the node display and break the existing UX. The enricher contract adds an optional `priority` field:

```python
def enrich_node(node_id, node_data):
    return {
        "sublabel": "22C | Cooling",
        "sublabel_priority": 10,  # lower = wins; default 50
        ...
    }
```

### Execution

Enrichment runs inside `build_status()` every 10 seconds:

```python
def build_status():
    core_status = engine.get_status()   # psutil, Tailscale, etc.

    # Collect plugin status providers
    for provider in plugin_registry.get_status_providers():
        core_status.update(provider())

    # Run node enrichment chain
    enrichments = {}
    for enricher in plugin_registry.get_node_enrichers():
        for node in topology_nodes:
            result = enricher(node["id"], node)
            if result:
                merge_enrichment(enrichments, node["id"], result)

    core_status["enrichments"] = enrichments
    return core_status
```

Enricher functions must be **fast** (return cached data). I/O happens in the plugin's background thread; the enricher reads the cache.

### Cross-Plugin Data Dependencies in build_status()

The existing `_build_status_fresh()` has cross-module calls (e.g., `latency_prober.set_wifi_nodes(status.get("wifi", {}))`, host lookup building that references multiple modules). These dependencies need explicit resolution during extraction:

1. **Status providers execute in `depends_on` order.** If the latency plugin depends on wifi-scanner, its status provider runs after wifi-scanner's. The status dict accumulates data as providers execute.
2. **Cross-plugin data access via `ctx.get_plugin_api(plugin_name)`.** The latency plugin can call `ctx.get_plugin_api("wifi-scanner").get_wifi_nodes()` to get WiFi data during its status provider execution.
3. **Graceful degradation:** If a dependency plugin isn't loaded or hasn't populated data yet, the accessor returns `None`/empty. Plugins must handle missing data without crashing (same as today — if HA bridge hasn't polled yet, HA sublabels are empty).

## New Plugins

### Ansible Plugin ("War Room")

**Type:** on-demand
**Fantasy name:** War Room

**Panel (three tabs):**

1. **Inventory** — Auto-populated from realm topology. Shows hosts grouped by VLAN/role with OS type (OpenWrt/Ubuntu), SSH status. Hosts are checkable for targeting. Syncs with topology — new nodes appear when discovered.

2. **Playbooks** — File browser for `plugins/ansible/playbooks/`. Editor for writing/editing YAML. Run button targets checked inventory hosts. Live output streaming via SSE during execution. Run history with status and output.

3. **AI Assist** — Contextual AI help via existing Azure AI integration (chat_bridge). The AI receives realm context: topology, node roles, OS types, collectd status, recent failures. Suggests playbooks, explains errors, helps write YAML. Uses chat session system scoped to Ansible.

**Backend:**

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | /inventory | get_inventory | Hosts from topology + SSH probe |
| GET | /playbooks | list_playbooks | List playbook files |
| GET | /playbook?name= | read_playbook | Read playbook YAML |
| POST | /playbook | save_playbook | Create/update playbook |
| POST | /run | run_playbook | Execute against targets |
| GET | /runs | list_runs | Run history |
| GET | /run/<id> | get_run | Run detail + output |
| POST | /ai | ai_suggest | AI with realm context |

**SSE:** `ansible` event type for live run progress.

**Node enrichment:**
- Sublabel: last run status + timestamp ("Updated 2h ago", "Failed: apt lock")
- Badge: checkmark (success), warning (changed), X (failed)
- Context menu: "Run playbook on this host", "View run history"

**Execution model:**
- Playbook runs via `ansible-playbook` subprocess or `ansible-runner` library
- stdout/stderr captured in real-time, pushed via SSE
- Results stored in `plugin_ansible_runs` table

**AI context injection:**
```python
def build_ai_context():
    return {
        "topology": ctx.get_topology(),
        "target_hosts": get_checked_hosts(),
        "host_status": {h: get_collectd_summary(h) for h in targets},
        "current_playbook": editor_content,
        "recent_failures": get_recent_failures(limit=5),
    }
```

**Safety:**
- `--check` (dry run) mode prominent in UI
- OpenWrt kernel package exclusion in default templates
- Auto-inject config backup before OpenWrt runs: `uci export > /tmp/backup-<date>.conf`

### Grafana Plugin ("Scrying Pool")

**Type:** standalone
**Fantasy name:** Scrying Pool

Embeds Grafana dashboards into Realmwatch and provides deep-dive metric visualization that complements the realm map's high-level view.

**Prerequisites:** Grafana running as a service (e.g., `http://localhost:3000`). The plugin doesn't install Grafana — it integrates with an existing instance.

**Panel:**
- Dashboard selector — lists available Grafana dashboards via API
- Embedded dashboard viewer via iframe (Grafana's `allow_embedding=true`)
- Node-linked dashboards — clicking a node can open its host-specific Grafana dashboard
- Time range controls synced with Grafana

**Backend:**

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | /dashboards | list_dashboards | Proxy Grafana API /api/search |
| GET | /dashboard/<uid> | get_dashboard | Proxy Grafana API /api/dashboards/uid/<uid> |
| GET | /embed-url | get_embed_url | Build iframe URL with auth token |
| POST | /config | save_config | Grafana URL, API key, default dashboard |

**Node enrichment:**
- Context menu: "Open in Grafana" — opens host-specific dashboard filtered to that node's hostname
- Meta: Grafana dashboard UIDs associated with each node (via host variable matching)

**Configuration:**
```json
{
  "config": {
    "grafana_url": { "type": "string", "default": "http://localhost:3000" },
    "grafana_api_key": { "type": "string", "default": "" },
    "default_dashboard": { "type": "string", "default": "" },
    "host_variable": { "type": "string", "default": "host", "description": "Grafana template variable name for hostname" }
  }
}
```

**Grafana configuration required:**
- `allow_embedding = true` in grafana.ini
- `cookie_samesite = lax` (or `none` with HTTPS)
- Service account token for API access
- Anonymous auth or auth proxy for iframe embedding

## Backporting Plan

### Extraction Order

Ordered by complexity — each validates progressively harder plugin patterns:

| # | Plugin | Current Module(s) | Pattern Validated |
|---|--------|--------------------|-------------------|
| 1 | latency | latency_prober.py | Background thread + SSE source + panel |
| 2 | firewall | firewall_parser.py | SSH + parse + SSE + panel |
| 3 | ha-bridge | ha_bridge.py | Node enrichment + sublabels + device index |
| 4 | wled-bridge | wled_bridge.py | Node enrichment + bidirectional control (POST) |
| 5 | event-generator | event_generator.py | Event subscription + threshold monitoring |
| 6 | collectd | collectd_reader.py + collectd_listener.py | Core data provider + UDP listener |
| 7 | wifi-scanner | ap_scanner.py | Topology mutations + SSH + DHCP + LLDP |
| 8 | notion | notion_sync.py + codex_sync.py | External API + quest system + codex pages |
| 9 | chat | chat_bridge.py | AI integration + sessions |
| 10 | oracle | oracle_daemon.py | Standalone daemon |
| 11 | herald | realm_herald.py | Standalone daemon |

### What Stays in Core

After full extraction, the core consists of:

- **map_server.py** (~400 lines) — HTTP server, plugin loader, route table, static serving, core routes (/status, /topology, /settings, /plugins)
- **plugin_loader.py** (new) — Discovery, validation, lifecycle, registry
- **sse_broker.py** — SSE infrastructure with registry-based sources
- **realm_db.py** — DB infrastructure, core tables
- **engine.py** — psutil sensors, Tailscale, core status (non-plugin system data)
- **node_roles.py** — Role definitions, base enrichment pipeline
- **traffic_precompute.py** — Traffic calculation (tied to core topology rendering)
- **Frontend core** — Map rendering, pan/zoom, topology SVG, panel manager/WM, effects, terrain, theme

### The Collectd Challenge

Collectd is the hardest backport because `build_status()` depends on collectd data for core status computation. Solution:

The collectd plugin registers as both an SSE source AND a **status provider** via `ctx.register_status_provider(fn)`. Status providers are a special enricher class that feeds data into `build_status()` itself (CPU, memory, load, disk, uptime) rather than into node sublabels. This is the one additional hook beyond standard plugin capabilities.

```python
# In collectd plugin's setup():
def setup(ctx):
    ctx.register_status_provider(get_collectd_status)  # feeds build_status()
    ctx.register_sse_source("collectd", get_collectd_data, interval=10)
    ctx.start_background_thread(rrd_reader_loop, interval=10)
    ctx.start_background_thread(udp_listener, name="collectd-udp")
```

### Netdata Plugin ("Oracle Sight")

**Type:** integrated
**Fantasy name:** Oracle Sight

Replaces or supplements collectd as the metrics collection layer. Queries Netdata agents on each host via REST API instead of parsing RRD files or decoding UDP binary protocol. Eliminates `collectd_reader.py` (317 lines) and `collectd_listener.py` (266 lines).

**Architecture:**
- Netdata agents run on Ubuntu hosts (apt install netdata)
- OpenWrt hosts: either lightweight Netdata package, SNMP polling from Netdata parent, or keep collectd as fallback
- Netdata parent on forge/katana aggregates all agents
- Plugin queries parent's REST API for all host metrics

**Backend:**

| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | /hosts | list_hosts | Netdata-monitored hosts |
| GET | /metrics?host=&chart= | get_metrics | Query specific chart data |
| GET | /charts?host= | list_charts | Available charts per host |
| GET | /alarms | get_alarms | Active Netdata alarms |

**Status provider:** Feeds `build_status()` with per-host CPU, memory, disk, load, uptime, temperatures — same data collectd provides today but via clean REST calls:

```python
def get_host_metrics(hostname):
    """Replace 317 lines of RRD parsing with one HTTP call."""
    resp = httpx.get(f"{NETDATA_URL}/api/v1/data", params={
        "chart": "system.cpu", "after": -10, "points": 1,
        "host": hostname
    })
    return resp.json()
```

**SSE source:** Registers same event types as collectd plugin (backward compatible). Panels that consume collectd SSE data work without changes.

**Node enrichment:**
- Sublabel: live metrics summary (CPU %, memory %, disk %)
- Badge: anomaly indicator when Netdata's ML detects deviation
- Context menu: "Open Netdata dashboard" for the host

**MCP integration (future):**
Netdata v2.6+ implements MCP server. The Oracle daemon could query Netdata MCP directly for root cause analysis: "Why is forge slow?" → queries CPU, process list, disk I/O via MCP → "ffmpeg is using 95% CPU."

**Collection strategy (mixed):**
- **Ubuntu hosts:** Full Netdata agent (apt install netdata)
- **Gatekeeper + larger OpenWrt devices:** Full Netdata agent where storage allows (~15MB)
- **Smaller APs/routers:** SNMP polling from Netdata parent — no agent install, ~100KB for snmpd
- **Managed switch (HP 10.0.6.103):** SNMP polling (native protocol for managed switches)
- All data aggregated at Netdata parent, queried via single REST API

**Migration path:**
1. Install Netdata agents on Ubuntu hosts alongside collectd
2. Install Netdata on gatekeeper and larger OpenWrt devices where flash allows
3. Configure SNMP on smaller OpenWrt devices, Netdata parent polls them
4. Run both collectd and netdata plugins simultaneously
5. Validate netdata output matches collectd output for all hosts
6. Disable collectd plugin, remove collectd agents

**Configuration:**
```json
{
  "config": {
    "netdata_url": { "type": "string", "default": "http://localhost:19999" },
    "parent_url": { "type": "string", "default": "", "description": "Netdata parent URL if using streaming" },
    "poll_interval": { "type": "number", "default": 10 },
    "fallback_to_collectd": { "type": "boolean", "default": true, "description": "Use collectd for hosts without Netdata" }
  }
}
```

## Future Plugin Ideas

| Plugin | Type | Description |
|--------|------|-------------|
| speedtest | on-demand | Periodic internet speed tests with history |
| backup-monitor | integrated | Monitor backup job status across hosts |
| dns-sinkhole | integrated | Pi-hole/AdGuard integration |
| container-monitor | integrated | Docker/Podman container status on hosts |
| tailscale | integrated | Tailscale mesh status (currently in engine.py) |
| uptime-kuma | standalone | Integration with Uptime Kuma monitoring |

## API Endpoint Summary

### Core Endpoints (remain in map_server.py)

| Method | Path | Description |
|--------|------|-------------|
| GET | / | Splash page |
| GET | /realm-map.html | Main map app |
| GET | /status | Aggregated status (core + plugin providers) |
| GET | /topology | Nodes, connections, regions |
| GET | /settings | UI settings |
| GET | /events | Event log |
| GET | /plugins | Plugin registry (for frontend loader) |
| GET | /plugins/<name>/<file> | Plugin static files |
| GET | /plugins/<name>/status | Plugin runtime status |
| POST | /settings | Save UI settings |
| POST | /event | Push realm event |
| POST | /node | Create/update/delete node |
| POST | /connections | Replace all connections |
| POST | /topology | Bulk update |
| POST | /plugins/<name>/start | Start standalone plugin |
| POST | /plugins/<name>/stop | Stop standalone plugin |
| GET | /sse | SSE event stream |

### Plugin Endpoints (registered dynamically)

Auto-prefixed: `/plugins/<name>/...` (unless `raw_path: true` for backcompat).

## Testing Strategy

No test framework in Realmwatch. Validation approach:

1. **Plugin loader unit check:** `python3 -c "from plugin_loader import PluginLoader; PluginLoader('plugins/').discover()"`
2. **Server startup:** `python3 map_server.py` — verify all plugins load without errors
3. **API verification:** `curl http://localhost/plugins | python3 -m json.tool` — all plugins listed
4. **Frontend verification:** Open realm-map.html — plugin panels appear, SSE events flow
5. **Per-plugin checks:** Each backported plugin should produce identical API output to the pre-extraction version
6. **Extraction regression:** Before/after comparison of `/status`, `/latency`, `/firewall` etc. output

## Migration Strategy

The extraction is incremental. At any point during the migration:
- Some features are plugins (loaded from `plugins/`)
- Some features are still monolithic (hardcoded in map_server.py)
- Both coexist — the route table serves both core routes and plugin routes
- SSE broker collects from both hardcoded sources and registered plugin sources
- Enrichment pipeline merges both core sublabels and plugin enrichments

This means each extraction can be done as an independent PR, tested, and merged without disrupting the whole system.

## Plugin Lifecycle

### Startup

```
map_server.py __main__
  → realm_db.init()
  → plugin_loader.discover("plugins/")          # scan, validate manifests
  → plugin_loader.load_all()                     # topological sort, import, setup()
  → _sse_broker = SSEBroker(build_status)        # core SSE
  → plugin_loader.register_sse_sources(broker)   # plugin SSE sources
  → plugin_loader.register_routes(route_table)   # plugin endpoints
  → ThreadingHTTPServer.serve_forever()
```

### Runtime

- **Integrated plugins:** Background threads run continuously. Data exposed via getters.
- **Standalone plugins:** Realm checks systemd status periodically. Start/stop via HTTP endpoints.
- **On-demand plugins:** Dormant until triggered. Execution runs as subprocess with output captured.

### Shutdown

When map_server receives SIGTERM/SIGINT:
1. Plugin loader calls `cleanup()` on each plugin (if defined in plugin module)
2. Background threads terminate (daemon=True, so they die with the process)
3. Standalone plugins continue running independently (managed by systemd)
4. On-demand subprocesses receive SIGTERM

Plugin `cleanup()` hook is optional — only needed for plugins that hold external connections (SSH sessions, WebSocket connections, etc.):

```python
def cleanup():
    """Called on server shutdown. Close external connections."""
    _ssh_connection.close()
```

### Enable/Disable

Plugins can be disabled without removing the directory:
- Add `"enabled": false` to `plugin.json` — loader skips it
- Or: realm settings store a `disabled_plugins` list in DB, togglable via UI

## Security Model

**Full trust, local only.** This is a single-machine homelab project, not a public platform.

- Plugin Python code runs in the same process as map_server with full access
- Plugin JS runs in the same origin with full DOM/API access
- No sandboxing, no capability restrictions, no code signing
- Plugin static file serving includes path traversal prevention (resolved path must be within plugin directory)
- Secret values (API keys, tokens) must go in `.env` or realm.db config overrides, never in `plugin.json` manifests (which are tracked in git)

If Realmwatch is ever open-sourced, a trust/permission model would need to be added. For now, YAGNI.

## Inter-Plugin API

Plugins can expose a public API for other plugins via `ctx.expose_api(api_dict)`:

```python
def setup(ctx):
    # ... plugin initialization ...

    # Expose public API for other plugins
    ctx.expose_api({
        "get_ha_states": get_ha_states,
        "get_device_enrichment": get_device_enrichment,
        "call_service": call_service,
    })
```

Consumers access it via:
```python
ha_api = ctx.get_plugin_api("ha-bridge")
if ha_api:
    states = ha_api["get_ha_states"]()
```

Returns `None` if the target plugin isn't loaded. Consumers must handle this gracefully. This replaces the current pattern of direct module imports between bridges.

## On-Demand Execution Model

For plugins like Ansible that run tasks as subprocesses:

### Execution Flow

1. User triggers run via POST endpoint (e.g., `POST /plugins/ansible/run`)
2. Plugin spawns subprocess (`ansible-playbook` or similar)
3. stdout/stderr captured line-by-line via `subprocess.Popen` with pipes
4. Each output line pushed as SSE event: `event: ansible\ndata: {"run_id": "...", "line": "...", "stream": "stdout"}`
5. On completion, final status event: `event: ansible\ndata: {"run_id": "...", "status": "success|failed", "summary": "..."}`
6. Results stored in plugin DB table for history

### Constraints

- **Concurrency limit:** Configurable per plugin (default: 1 concurrent execution). Additional requests queued or rejected.
- **Timeout:** Configurable per plugin (default: 600s). Subprocess receives SIGTERM on timeout.
- **Cancellation:** `POST /plugins/<name>/cancel/<run_id>` sends SIGTERM to subprocess.
- **Reconnection:** If browser refreshes mid-execution, the SSE reconnect gets the initial burst (which doesn't include live subprocess output). The plugin's GET endpoint for run status shows current output. The live SSE stream resumes for subsequent output lines.

## Frontend Panel Registration (Implementation Note)

The existing `panel-manager.js` has a hard guard at line 2159: `if (!panel || !PANELS[panel.id]) return;` — it rejects panels not in the hardcoded `PANELS` constant.

**Required change:** `PANELS` must become a mutable registry. `RealmAPI.registerPanel()` inserts a new entry into `PANELS` before calling the panel setup logic. The implementation:

1. `PANELS` starts with core panels (as today)
2. `RealmAPI.registerPanel(id, config)` adds to `PANELS` dynamically
3. Panel chrome (header, collapse, seal, drag) is applied by the panel manager/WM — same as core panels
4. Plugin panels participate in formations, dock tray, seal modes identically to core panels
5. Grand Arcanum formation (`visible: Object.keys(PANELS)`) must become dynamic — use a getter or lazy evaluation so plugin panels appear in "summon all"
6. Panel HTML fragments are pre-fetched during the plugin loading sequence (step 2 in Frontend Loading Sequence) before `init()` is called — no async fetch during panel creation

If the WM library migration happens first, `registerPanel()` delegates to the WM's window creation API instead. The plugin contract is the same either way.

## Routing Conflict Resolution

When multiple routes match the same path:

1. **Core routes** are registered first and always win (highest priority)
2. **Plugin routes** are registered in plugin load order (after core)
3. **`raw_path: true` routes** are inserted after core but before namespaced plugin routes
4. **Conflicts are logged** as warnings at startup: "Plugin X route /latency shadows plugin Y route /latency"
5. First match wins (no error, no exception)
6. During backporting transition: backported plugins use `raw_path: true` to keep existing URLs. Once all consumers are updated, switch to namespaced paths.

## SSE Interval Constraints

The SSE broker ticks every 5 seconds. Plugin intervals are rounded to the nearest 5-second boundary:

- Minimum interval: **5 seconds** (1 tick)
- Intervals not divisible by 5 are rounded up: 7s → 10s, 3s → 5s
- Plugins declaring intervals < 5s get a warning at load time and are clamped to 5s
- `tick_interval = max(1, math.ceil(source.interval / 5))`

## PluginDB Scoping

Plugin database access uses **convention + validation**, not SQL parsing:

- `ctx.db.create_table(name, schema)` auto-prefixes table name with `plugin_<name>_`
- `ctx.db.execute(sql, params)` and `ctx.db.query(sql, params)` are **unscoped** — plugins can read core tables (nodes, events, etc.) directly
- **Write protection:** `ctx.db.execute()` rejects INSERT/UPDATE/DELETE on core tables (settings, events, personas, nodes, connections, regions, quests, wifi_scans, notion_synced). Plugins use `ctx.push_event()` and `ctx.get_topology()` for core data access. Backported plugins that need to write to these tables (e.g., wifi-scanner → wifi_scans, notion → notion_synced) use `ctx.db.write_core_table(table, ...)` — an explicit opt-in that documents the dependency.
- This is convention-based trust. A plugin that really wants to can import `realm_db` directly (full trust model). The scoping is guardrails, not jail.

## Map Overlay Contract

`register_map_overlay()` works differently on backend vs frontend:

- **Python (backend):** Not used. Map overlays are frontend-only. Removed from `PluginContext` to avoid confusion.
- **JavaScript (frontend):** `RealmAPI.registerMapOverlay(renderFn)` where `renderFn(svgGroup)` receives an SVG `<g>` element. The plugin appends SVG children to it. Called on each topology refresh.

```javascript
RealmAPI.registerMapOverlay((svgGroup) => {
  // Draw "managed" badges on Ansible-managed nodes
  for (const nodeId of managedNodes) {
    const pos = RealmAPI.getNode(nodeId)?.position;
    if (!pos) continue;
    const badge = document.createElementNS(SVG_NS, 'circle');
    badge.setAttribute('cx', pos.x + 12);
    badge.setAttribute('cy', pos.y - 12);
    badge.setAttribute('r', 4);
    badge.setAttribute('fill', '#4CAF50');
    svgGroup.appendChild(badge);
  }
});
```
