# Autodiscovery Engine Design Spec

**Date:** 2026-04-07
**Status:** Draft
**Author:** JP + Claude
**Depends on:** Plugin System (2026-03-24 spec, already implemented)

## Overview

A universal discovery layer in realmwatch that expands what the realm can see. Today, realmwatch discovers WiFi clients via AP scanning and enriches unknowns via the 6-signal pipeline. This spec adds discovery of Docker containers, KVM/libvirt VMs, systemd services, SNMP-managed devices, and Netdata-monitored hosts — all through a plugin-based architecture with a shared core engine.

Realmwatch **is** the discovery engine. No external tools (Uptime Kuma, Gatus) — the realm learns about everything and exposes it through its existing `/status` API and SSE stream.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Core module + discovery plugins | Discovery orchestration (scheduling, dedup, entity linking) is fundamental enough to live in core, like the SSE broker |
| Host dispatch | Role-based defaults with per-node overrides | Leverages existing node_roles.py; `server` role auto-gets Docker+systemd, `switch` gets SNMP, etc. |
| Sub-entity display | Enrichment by default, promote to topology node | Keeps map clean; containers/VMs/services appear in host detail panel unless explicitly promoted or auto-linked to existing nodes |
| Entity linking | Auto-match by ID/hostname/IP, manual override | Existing topology nodes (e.g., `jellyfin`) auto-gain container health when Docker plugin finds a matching container |
| Remote access | SSH primary, API where available | AP scanner already proves SSH works; Docker API and Netdata REST supplement where available |
| collectd | Keep as-is | Existing, working, no reason to remove. Netdata supplements rather than replaces for now |
| SNMP | Direct polling via pysnmp | Lightweight, no external daemon needed |
| Systemd filtering | Auto-detect interesting + manual watch list | Surface port-listening, user-level, and failed units; allow per-node pinned services |
| Scan scheduling | Per-provider intervals, staggered | Heavy scans (SNMP walk, Docker inspect) run less frequently than lightweight checks |

## Core Module: `discovery_engine.py`

New file in the project root (alongside `engine.py`, `sse_broker.py`). Loaded by `map_server.py` at startup, after plugin loader runs.

### Discovery Provider Registration

Plugins register providers via a new `PluginContext` method:

```python
ctx.register_discovery_provider(
    name="docker",
    roles=["server", "nas", "hypervisor"],  # node roles this provider scans
    discover_fn=discover_docker,             # fn(node_id, node_data, host_access, engine) -> list[SubEntity]
    interval=60,                             # seconds between full scans
    entity_types=["container"],              # what it discovers
    priority=10,                             # scan order (lower = earlier)
)
```

The engine maintains a registry of providers. `PluginContext` gets this one new method; everything else uses existing plugin APIs (`register_status_provider`, `register_sse_source`, etc.).

The `engine` parameter gives providers read access to other providers' results — the health plugin uses this to find endpoints discovered by Docker/Caddy/systemd plugins. Providers that don't need cross-provider data can ignore it.

### SubEntity Model

```python
@dataclasses.dataclass
class SubEntity:
    id: str                     # unique: "docker:<host>:<container_name>" or "systemd:<host>:<unit>"
    type: str                   # container, vm, service, snmp_device, snmp_port, netdata_host
    name: str                   # human-readable: "jellyfin", "caddy.service", "GigabitEthernet0/1"
    host_node_id: str           # parent node in topology
    status: str                 # running, stopped, failed, unknown, unreachable
    metadata: dict              # plugin-specific (image, ports, unit_file, ifSpeed, etc.)
    linked_node_id: str | None  # auto-matched or manually linked topology node
    last_seen: float            # timestamp of last discovery
    provider: str               # which plugin discovered this
```

### Entity Linker

The core value — connecting discovered sub-entities to existing topology nodes.

**Auto-linking priority (first match wins):**

1. **Manual override** — stored in `discovery_links` table, set via API or UI. Takes absolute precedence.
2. **Exact node_id match** — sub-entity name equals a `node_id` in topology (e.g., Docker container named `jellyfin` matches node `jellyfin`).
3. **Hostname/alias match** — node's `hostname` field or `aliases` array matches the sub-entity name. Case-insensitive, strips common suffixes (`.service`, `.local`).
4. **IP match** — sub-entity exposes an IP (Docker published port, VM IP) that matches a topology node's `ip` field.
5. **Fuzzy name match** — Levenshtein distance < 3 between sub-entity name and node_id. Only applied to high-confidence entity types (containers, VMs), not services. Requires confirmation before persisting.

**When linked, the topology node gains:**
- `discovery.status` — live status from the sub-entity (running/stopped/failed)
- `discovery.host` — parent host node_id (e.g., jellyfin's host is disks)
- `discovery.type` — container, vm, service
- `discovery.metadata` — plugin-specific data (image tag, memory usage, etc.)
- `discovery.provider` — which plugin found it

This data is available in the status blob and as node enrichment (sublabel, badge).

**Unlinked sub-entities** remain visible as enrichment data on their host node (e.g., "8 containers, 2 VMs" in the detail panel), and are available for manual promotion or linking.

### Host Access Layer

Abstraction for reaching remote hosts, used by all discovery providers.

```python
class HostAccess:
    """Provides access methods for a specific host node."""

    def __init__(self, node_id, node_data):
        self.node_id = node_id
        self.ip = node_data.get("ip")
        self.hostname = node_data.get("hostname", node_id)
        self._access_config = node_data.get("discovery", {})

    def ssh(self, command, timeout=10):
        """Execute command via SSH. Returns (stdout, stderr, returncode).
        Uses the same SSH patterns as ap_scanner (key auth, known_hosts)."""

    def ssh_available(self):
        """Check if SSH is reachable (cached, re-probed every 5 minutes)."""

    def http_get(self, port, path, timeout=5):
        """HTTP GET to host:port/path. Returns response dict or None."""

    def http_available(self, port):
        """Check if HTTP port is reachable (cached)."""

    def snmp_get(self, oid, community="public", version=2):
        """SNMP GET. Returns value or None."""

    def snmp_walk(self, oid, community="public", version=2):
        """SNMP WALK. Returns list of (oid, value) tuples."""

    def snmp_available(self):
        """Check if SNMP port 161 is reachable (cached)."""
```

`HostAccess` is created per-node by the engine and passed to discovery providers. Providers don't need to manage connections — just call `host.ssh("docker ps --format json")`.

**Access config** lives in the node's topology data under `"discovery"`:

```json
{
  "id": "disks",
  "ip": "10.0.6.120",
  "role": "server",
  "discovery": {
    "ssh_user": "jp",
    "docker": "ssh",
    "systemd": "ssh",
    "snmp_community": "public"
  }
}
```

Most of this is inferred from role defaults and doesn't need to be set manually.

### Role-Based Dispatch

Default provider mappings by node role:

| Role | Default Providers | Rationale |
|------|-------------------|-----------|
| `server` | docker, systemd, netdata | Linux servers typically run containers and services |
| `nas` | docker, systemd | NAS boxes often run Docker (Synology, TrueNAS, or bare Linux like disks) |
| `vm` | systemd, netdata | VMs are Linux guests — monitor their services |
| `hypervisor` | docker, kvm, systemd, netdata | Hosts running VMs |
| `router` | snmp, netdata | Network gear with SNMP |
| `switch` | snmp | Managed switches — port status, MAC tables, interface counters |
| `ap` | snmp | APs already handled by wifi plugin for WiFi; SNMP adds hardware/interface data |
| `desktop` | systemd | User workstations |
| `laptop` | (none) | Transient — don't scan by default |
| `ups` | snmp | UPS battery/load via SNMP |
| `printer` | snmp | Printer status via SNMP |
| `bridge` | snmp | WiFi bridges — interface status |

**Special providers** (not role-based, configured per-node):
- `caddy` — auto-detected on nodes running Caddy (via systemd or Docker discovery)
- `health` — auto-activated for any node with discovered endpoints (HTTP, TCP, UDP)
- `game-servers` — only on nodes with `discovery.game_servers` config

**Override per-node** via the `discovery` field in topology data:
- `"discovery": {"providers": ["docker", "snmp"]}` — explicit provider list
- `"discovery": {"providers": []}` — disable all discovery for this node
- `"discovery": {"docker": false}` — disable specific provider

### Scan Orchestration

The engine runs a background thread (started by `map_server.py`) that:

1. Every tick (10s), checks which providers are due to run based on their `interval`
2. Groups nodes by provider (all Docker-eligible nodes scanned in one batch)
3. Calls each provider's `discover_fn` per-node
4. Deduplicates results (same sub-entity from multiple providers → first wins by priority)
5. Runs entity linker on new/changed sub-entities
6. Stores results in `sub_entities` table
7. Pushes `discovery` SSE event if data changed (hash-based dedup like existing SSE)

**Staggering:** Heavy providers (SNMP walk, Docker inspect) offset their start by a few seconds to avoid slamming the network simultaneously.

**Error handling:** If a provider fails for a specific host, log the error, mark that host as `unreachable` for that provider, and back off (double the interval, capped at 10 minutes). Reset on next success.

## Storage

### New Tables in realm.db

```sql
-- Discovered sub-entities (containers, VMs, services, SNMP ports, etc.)
CREATE TABLE IF NOT EXISTS sub_entities (
    id TEXT PRIMARY KEY,           -- "docker:disks:jellyfin"
    type TEXT NOT NULL,            -- container, vm, service, snmp_device, snmp_port
    name TEXT NOT NULL,            -- human-readable name
    host_node_id TEXT NOT NULL,    -- parent topology node
    status TEXT DEFAULT 'unknown', -- running, stopped, failed, unknown, unreachable
    metadata TEXT DEFAULT '{}',    -- JSON blob, plugin-specific
    linked_node_id TEXT,           -- matched topology node (NULL = unlinked)
    provider TEXT NOT NULL,        -- discovery plugin name
    first_seen REAL NOT NULL,      -- epoch timestamp
    last_seen REAL NOT NULL,       -- epoch timestamp
    link_type TEXT                 -- auto, manual, promoted (how the link was made)
);

-- Manual entity link overrides
CREATE TABLE IF NOT EXISTS discovery_links (
    sub_entity_id TEXT PRIMARY KEY,
    linked_node_id TEXT NOT NULL,
    created REAL NOT NULL
);

-- Per-node discovery capability cache
CREATE TABLE IF NOT EXISTS discovery_capabilities (
    node_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    available INTEGER DEFAULT 1,  -- 1 = available, 0 = unavailable
    last_checked REAL,
    error TEXT,
    PRIMARY KEY (node_id, provider)
);
```

### Stale Entity Cleanup

Sub-entities not seen for 24 hours get marked `status = 'stale'`. After 7 days unseen, they're deleted. This handles containers that get removed, VMs that get destroyed, etc. Manually linked entities are preserved longer (30 days) to avoid breaking intentional mappings.

## API Endpoints

All endpoints live on the discovery engine core, registered at startup (not via a plugin).

### GET Endpoints

| Path | Description |
|------|-------------|
| `/discovery` | All sub-entities, grouped by host node |
| `/discovery/<node_id>` | Sub-entities for a specific host |
| `/discovery/links` | All entity links (auto + manual) |
| `/discovery/providers` | Registered providers and their status |
| `/discovery/capabilities` | Per-node capability matrix |

### POST Endpoints

| Path | Description |
|------|-------------|
| `/discovery/link` | Create/update manual entity link: `{"sub_entity_id": "...", "node_id": "..."}` |
| `/discovery/unlink` | Remove a manual link: `{"sub_entity_id": "..."}` |
| `/discovery/promote` | Promote sub-entity to topology node: `{"sub_entity_id": "..."}` — creates a new node linked to the sub-entity |
| `/discovery/scan` | Trigger immediate scan: `{"provider": "docker", "node_id": "disks"}` or `{"provider": "all"}` |
| `/discovery/configure` | Set per-node discovery config: `{"node_id": "...", "discovery": {...}}` |

## SSE Integration

New `discovery` event type, pushed when sub-entity data changes:

```json
{
  "event": "discovery",
  "data": {
    "sub_entities": {
      "disks": [
        {"id": "docker:disks:jellyfin", "type": "container", "name": "jellyfin", "status": "running", "linked_node_id": "jellyfin"},
        {"id": "docker:disks:navidrome", "type": "container", "name": "navidrome", "status": "running", "linked_node_id": "navidrome"},
        {"id": "systemd:disks:caddy", "type": "service", "name": "caddy.service", "status": "running", "linked_node_id": null}
      ],
      "forge": [
        {"id": "systemd:forge:realm-map-server", "type": "service", "name": "realm-map-server.service", "status": "running", "linked_node_id": null},
        {"id": "docker:forge:ollama", "type": "container", "name": "ollama", "status": "running", "linked_node_id": null}
      ]
    },
    "summary": {"total": 42, "running": 38, "stopped": 3, "failed": 1}
  }
}
```

Included in initial SSE burst (burst_priority=6, after energy/latency, before status).

## Node Enrichment

The discovery engine registers a node enricher (priority 35, between WLED and WiFi):

**For host nodes** (nodes with sub-entities):
- **Sublabel:** `"8 containers, 2 VMs, 1 failed"` (only if no higher-priority sublabel)
- **Badge:** warning/critical if any sub-entity is failed/stopped unexpectedly
- **Meta:** `{"discovery:containers": 8, "discovery:vms": 2, "discovery:services_failed": 1}`

**For linked nodes** (nodes matched to a sub-entity):
- **Sublabel:** `"container on disks | running"` or `"VM on ubox0 | 2 vCPU, 4GB"`
- **Badge:** status indicator (green/red/yellow dot)
- **Meta:** `{"discovery:type": "container", "discovery:host": "disks", "discovery:status": "running"}`

## Discovery Plugins

Each plugin is a standard realmwatch plugin (`plugins/<name>/plugin.json` + `plugin.py`) that registers a discovery provider in its `setup()`. The plugin can also register panels, endpoints, SSE sources, and enrichers as usual.

### Plugin: `docker` ("Iron Golem Foundry")

**Discovers:** Docker containers on hosts with Docker installed.

**Access method:** SSH (`docker ps --format json` + `docker inspect`) or Docker API (TCP 2375/2376).

**SubEntity output:**
```python
SubEntity(
    id="docker:disks:jellyfin",
    type="container",
    name="jellyfin",
    host_node_id="disks",
    status="running",  # running, exited, paused, restarting, dead
    metadata={
        "image": "jellyfin/jellyfin:latest",
        "ports": ["8096/tcp"],
        "created": "2026-03-15T...",
        "health": "healthy",
        "memory_mb": 512,
        "cpu_percent": 2.1,
        "restart_policy": "unless-stopped",
        "compose_project": "mediaserver",
    },
)
```

**Scan interval:** 60 seconds.

**Config:**
- `docker_api`: `"ssh"` (default) or `"api"` (TCP socket)
- `docker_api_port`: 2375 (default)

### Plugin: `kvm` ("Ethereal Planes")

**Discovers:** KVM/libvirt VMs on hypervisor hosts.

**Access method:** SSH (`virsh list --all`, `virsh dominfo <vm>`, `virsh domifaddr <vm>`).

**SubEntity output:**
```python
SubEntity(
    id="kvm:ubox0:ha-vm",
    type="vm",
    name="ha-vm",
    host_node_id="ubox0",
    status="running",  # running, shut off, paused, crashed
    metadata={
        "vcpus": 2,
        "memory_mb": 4096,
        "disk_gb": 32,
        "ip": "10.0.6.108",
        "os_type": "hvm",
        "autostart": True,
    },
)
```

**Scan interval:** 120 seconds.

### Plugin: `systemd` ("Runic Services")

**Discovers:** Interesting systemd units on Linux hosts.

**Access method:** SSH (`systemctl list-units --type=service --output=json`) or local D-Bus.

**"Interesting" filter logic:**
1. **Failed/degraded units** — always surface (this is the primary health signal)
2. **Port-listening units** — services bound to a network port (cross-ref with `ss -tlnp`)
3. **User-level units** — `systemctl --user` units (realm services, custom daemons)
4. **Watch list** — per-node pinned services stored in node's `discovery.systemd_watch` config
5. **Exclude list** — noisy system units excluded by default: `systemd-*`, `snapd.*`, `getty@*`, `user@*`, etc.

**SubEntity output:**
```python
SubEntity(
    id="systemd:forge:realm-map-server",
    type="service",
    name="realm-map-server.service",
    host_node_id="forge",
    status="running",  # running, stopped, failed, activating
    metadata={
        "description": "Realm Map Server",
        "active_state": "active",
        "sub_state": "running",
        "memory_mb": 245,
        "cpu_seconds": 1823.4,
        "restart_count": 0,
        "listening_ports": [80],
        "user": True,  # user-level unit
    },
)
```

**Scan interval:** 60 seconds.

### Plugin: `snmp` ("Crystal Resonance")

**Discovers:** SNMP-managed device data — interfaces, port status, MAC tables, system info.

**Access method:** pysnmp library (SNMPv2c default, v3 optional per-node).

**MIBs polled:**
- **IF-MIB** — interface status, speed, counters (ifOperStatus, ifInOctets, ifOutOctets, ifSpeed)
- **BRIDGE-MIB / Q-BRIDGE-MIB** — MAC address table (which MAC on which port → physical topology)
- **SNMPv2-MIB** — sysDescr, sysName, sysUpTime, sysLocation
- **HOST-RESOURCES-MIB** — CPU, memory, storage (where supported)
- **UPS-MIB** — battery status, load, runtime (for UPS devices)
- **Printer-MIB** — toner levels, page counts (for printers)

**SubEntity output (interface example):**
```python
SubEntity(
    id="snmp:hp-switch:port-1",
    type="snmp_port",
    name="Port 1 (GigabitEthernet0/1)",
    host_node_id="hp-switch",
    status="up",  # up, down, testing, dormant
    metadata={
        "ifIndex": 1,
        "ifSpeed": 1000000000,
        "ifOperStatus": "up",
        "ifAdminStatus": "up",
        "ifInOctets": 123456789,
        "ifOutOctets": 987654321,
        "connected_macs": ["aa:bb:cc:dd:ee:ff"],
        "vlan": 6,
    },
)
```

**Physical topology discovery:** The MAC address table from switches cross-references with known node MACs to build a switch-port-to-device mapping. This is a major feature — it answers "which physical port is each device plugged into?"

**Scan interval:** 120 seconds (interface status), 300 seconds (full SNMP walk).

**Config:**
- `community`: SNMP community string (default: `"public"`)
- `version`: 2 or 3 (default: 2)
- `snmpv3_user`, `snmpv3_auth`, `snmpv3_priv`: v3 credentials (optional)

### Plugin: `netdata` ("Oracle Sight")

**Discovers:** Netdata-monitored hosts via REST API. Supplements collectd with richer metrics.

**Access method:** HTTP GET to Netdata agent (`http://<host>:19999/api/v1/...`).

**Already spec'd** in the plugin system design (2026-03-24). Key additions for the discovery engine:

- Registers as a discovery provider (not just a metrics source)
- Discovers which charts/collectors are active per host → surfaces as capabilities
- Cross-references with collectd: if both monitor a host, Netdata takes priority for metrics, collectd stays as fallback

**SubEntity output:**
```python
SubEntity(
    id="netdata:forge:agent",
    type="netdata_host",
    name="forge",
    host_node_id="forge",
    status="running",
    metadata={
        "version": "1.44.0",
        "os": "Ubuntu 24.04",
        "collectors": ["cpu", "mem", "disk", "net", "docker", "systemd"],
        "charts_count": 342,
        "alarms_critical": 0,
        "alarms_warning": 1,
    },
)
```

**Scan interval:** 30 seconds (lightweight `/api/v1/info`), 300 seconds (full chart enumeration).

### Plugin: `caddy` ("Gate Warden")

**Discovers:** Caddy reverse proxy configurations — which domains route to which backends.

**Access method:** SSH (`caddy fmt --config /etc/caddy/Caddyfile` or Docker exec for containerized Caddy) + Caddy admin API (`http://localhost:2019/config/`).

**Why:** status.realm.watch manually tracks 14 Caddy domain→backend mappings across 2 hosts (ubox0 systemd Caddy, disks Docker Caddy). The discovery engine should learn these automatically.

**SubEntity output:**
```python
SubEntity(
    id="caddy:ubox0:realm.watch",
    type="reverse_proxy",
    name="realm.watch → 10.0.6.134:8080",
    host_node_id="ubox0",
    status="running",  # healthy (backend reachable) or degraded (backend unreachable)
    metadata={
        "domain": "realm.watch",
        "backend": "10.0.6.134:8080",
        "tls": True,
        "backend_node_id": "realm-portal",  # auto-linked via IP match
    },
)
```

**Scan interval:** 300 seconds (Caddy configs change rarely).

**Role mapping:** Nodes with Caddy installed (detected via systemd or Docker) auto-get this provider.

### Plugin: `health` ("Watchtower Beacon")

**Discovers:** HTTP endpoint health and TCP/UDP port availability. Replaces the manual health/port checks in status.realm.watch.

**Access method:** httpx for HTTP, socket for TCP/UDP.

**What it checks:**
1. **HTTP health** — GET request, expect 200. For nodes with known web endpoints (derived from Caddy backends, Docker published ports, or manual config).
2. **TCP port** — socket connect, expect accept. For nodes with known listening ports.
3. **UDP port** — send probe packet, check for response (best-effort). For game servers and specific services.
4. **realm-sigil version** — GET `/api/version` or `/version.json`, parse response. For nodes with realm-sigil endpoints.

**SubEntity output (HTTP health example):**
```python
SubEntity(
    id="health:disks:https-jellyfin.jphe.in",
    type="http_health",
    name="jellyfin.jphe.in",
    host_node_id="disks",
    status="healthy",  # healthy, degraded, unreachable
    metadata={
        "url": "https://jellyfin.jphe.in",
        "status_code": 200,
        "response_ms": 45,
        "tls_expiry": "2026-09-15",
        "version": {"name": "Forge Ember", "hash": "abc1234"},  # realm-sigil data if present
    },
)
```

**SubEntity output (TCP port example):**
```python
SubEntity(
    id="health:realm-portal:tcp-8080",
    type="tcp_port",
    name="realm-portal:8080",
    host_node_id="realm-portal",
    status="open",  # open, closed, filtered
    metadata={
        "port": 8080,
        "response_ms": 3,
    },
)
```

**Smart endpoint discovery:** Instead of a manual URL list, the health plugin auto-discovers what to check:
- **From Caddy plugin** — every reverse proxy domain gets an HTTP health check
- **From Docker plugin** — every published port gets a TCP check; HTTP ports get health checks
- **From systemd plugin** — every port-listening service gets a TCP check
- **From topology** — nodes with `url` field get HTTP health checks
- **External services** — nodes representing cloud-hosted services (Vercel, GCP, OCI — e.g., dreamspace, artcards, techempower, jphein.com, openclaw) get HTTP health checks via their public URL in topology metadata
- **Manual additions** — per-node `discovery.health_endpoints` config for anything not auto-discovered

**Scan interval:** 30 seconds (HTTP/TCP), 60 seconds (UDP), 300 seconds (version checks).

**Config:**
- `timeout_ms`: HTTP/TCP timeout (default: 5000)
- `check_tls_expiry`: Poll TLS cert expiry dates (default: true)

### Plugin: `game-servers` ("Arena Watcher")

**Discovers:** Game server status on remote hosts. Specific to JP's setup with terra2 Azure VM.

**Access method:** Protocol-specific queries (Minecraft Bedrock ping, Terraria status).

**Why:** status.realm.watch tracks 3 Minecraft Bedrock servers and 1 Terraria server on terra2 (20.228.117.200). These are external (Azure) but still part of the realm.

**SubEntity output:**
```python
SubEntity(
    id="game:terra2:mc-bedrock-19132",
    type="game_server",
    name="terra2 Minecraft Bedrock",
    host_node_id="terra2",
    status="running",  # running, offline
    metadata={
        "game": "minecraft_bedrock",
        "port": 19132,
        "players_online": 2,
        "max_players": 10,
        "version": "1.21.0",
        "motd": "terra2",
    },
)
```

**Scan interval:** 60 seconds.

**Note:** This plugin only activates for nodes explicitly configured with `discovery.game_servers`. It doesn't scan broadly.

## Frontend Integration

### Host Detail Panel Enhancement

When clicking a host node that has sub-entities, the existing node detail panel gains a **"Vassals"** tab (or section) showing:

- List of containers/VMs/services with status indicators
- Click to expand → metadata details
- Link/unlink buttons for matching to topology nodes
- "Promote" button to create a new topology node from a sub-entity

### Linked Node Indicators

Topology nodes that are linked to sub-entities show:
- A small host-badge icon indicating their parent (e.g., a container icon next to "jellyfin" with "disks" as tooltip)
- Status color from the discovery engine (green = running, red = failed, gray = stopped)

### Discovery Dashboard Panel ("Realm Surveyors")

A new plugin panel showing the discovery engine overview:
- Provider status (running, last scan time, error count)
- Per-host capability matrix (which providers scan which hosts)
- Unlinked sub-entities needing attention
- Recent discovery events (new container found, VM stopped, service failed)

This is a standard plugin panel registered by the discovery engine's companion plugin.

## Dependencies

### Python Packages (add to requirements.txt)

| Package | Version | Used By |
|---------|---------|---------|
| `pysnmp-lextudio` | >=6.0 | SNMP plugin — pure Python SNMPv2c/v3 |
| `pyasn1` | (dep of pysnmp) | ASN.1 encoding |

No other new dependencies. Docker discovery uses SSH + JSON parsing (stdlib). KVM uses SSH + virsh (stdlib). Systemd uses SSH + systemctl (stdlib). Netdata uses httpx (already in requirements.txt).

### System Requirements

- **pysnmp** needs no system packages (pure Python)
- **SSH access** to target hosts (already required for AP scanning)
- **Docker** must be installed on target hosts for Docker discovery (engine detects presence)
- **virsh** must be installed on hypervisor hosts for KVM discovery (engine detects presence)

## Build Order

**Phase 1 — Core + first plugins (entity linking is the key feature):**
1. **Core discovery engine** (`discovery_engine.py`) — SubEntity model, provider registry, entity linker, host access layer, scan orchestrator, DB tables, API endpoints, SSE integration, node enricher
2. **PluginContext extension** — add `register_discovery_provider()` method
3. **systemd plugin** — easiest to test (local machine first, then SSH)
4. **Docker plugin** — high value (disks runs media stack, 14 containers in status.realm.watch)

**Phase 2 — Infrastructure discovery:**
5. **SNMP plugin** — switch port mapping, interface counters, device inventory
6. **KVM plugin** — VMs on ubox0 and nodered (8 guests in status.realm.watch)
7. **Caddy plugin** — reverse proxy mapping (14 domain→backend mappings across 2 hosts)

**Phase 3 — Health & monitoring (replaces status.realm.watch manual checks):**
8. **Health plugin** — HTTP health, TCP/UDP ports, realm-sigil versions, TLS expiry
9. **Game servers plugin** — Minecraft Bedrock + Terraria on terra2
10. **Netdata plugin** — supplements collectd

**Phase 4 — Frontend:**
11. **Frontend: Vassals tab** — sub-entity display in node detail panel
12. **Frontend: Discovery dashboard panel** — overview panel
13. **Frontend: Linked node indicators** — badges and status on map nodes

## Relationship to status.realm.watch

The autodiscovery engine subsumes most of what status.realm.watch tracks manually in `checks.json`:

| status.realm.watch Check | Autodiscovery Plugin | Notes |
|--------------------------|---------------------|-------|
| Ping checks (23 hosts) | Existing latency prober | Already covered |
| Docker containers (14 on disks) | Docker plugin | Full coverage |
| KVM hosts (2) + guests (8) | KVM plugin | Full coverage |
| Caddy reverse proxies (2 hosts, 14 domains) | Caddy plugin | Full coverage |
| HTTP health checks (23 endpoints) | Health plugin | Auto-discovered from Caddy/Docker |
| TCP port checks (8) | Health plugin | Auto-discovered from systemd/Docker |
| UDP port checks (3) + game servers (4) | Game servers plugin | terra2 specific |
| API version checks (14) | Health plugin | realm-sigil polling |
| Intermittent nodes (9) | Existing topology metadata | Already covered |

**Goal:** Once the autodiscovery engine is complete, status.realm.watch can read from realmwatch's `/discovery` and `/status` APIs instead of maintaining its own `checks.json`. The checks become auto-discovered rather than manually configured.

## Out of Scope

- **Automatic node creation from discovery** — sub-entities don't auto-become topology nodes. Promotion is always explicit (or via entity linking to existing nodes).
- **mDNS/Bonjour discovery** — could be a future plugin but not in this spec.
- **UPnP/SSDP** — same, future plugin.
- **Reverse DNS** — could supplement entity linking but not core to this spec.
- **Netdata installation/provisioning** — the plugin assumes Netdata agents are already installed on target hosts.
- **SNMP trap receiver** — only polling, not trap-based alerting.
- **External cloud monitoring** — Vercel/GCP/Azure hosted sites (dreamscape, artcards, techempower, jphein.com, jewelrycycle) are checked by the health plugin via HTTP but not "discovered" — their URLs come from topology node metadata.
- **Replacing status.realm.watch** — this spec makes realmwatch the data source, but status.realm.watch may still be the public-facing status page consuming that data.
