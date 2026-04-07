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
        """SNMP GET via snmpget CLI. Returns value or None."""

    def snmp_walk(self, oid, community="public", version=2):
        """SNMP WALK via snmpwalk CLI. Returns list of (oid, value) tuples.
        Parses Net-SNMP text output into structured data."""

    def snmp_table(self, oid, community="public", version=2):
        """SNMP TABLE via snmptable CLI. Returns list of row dicts."""

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

The engine uses a `ThreadPoolExecutor(max_workers=20)` with `concurrent.futures.as_completed()` for scan batches. This provides backpressure (won't spawn 130 SSH connections at once), clean timeout control, and structured error handling — an improvement over unbounded daemon threads.

Scan loop (runs in a single coordinator thread):

1. Every tick (10s), checks which providers are due to run based on their `interval`
2. Groups nodes by provider (all Docker-eligible nodes scanned in one batch)
3. Submits `discover_fn` calls to the thread pool, one future per (provider, node) pair
4. Collects results via `as_completed()` with per-future timeout
5. Deduplicates results (same sub-entity from multiple providers → first wins by priority)
6. Runs entity linker on new/changed sub-entities
7. Stores results in `sub_entities` table
8. Pushes `discovery` SSE event if data changed (hash-based dedup like existing SSE)

**Why threading, not asyncio:** map_server.py is synchronous (`http.server` + `ThreadingMixIn`). Grafting an asyncio event loop alongside it requires either running everything through `run_in_executor` (defeating the purpose) or migrating to an async HTTP server (massive rewrite). At homelab scale (30-130 nodes), network I/O is the bottleneck regardless of concurrency model — threading with a pool of 20 workers is more than sufficient.

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

**Access method:** Net-SNMP CLI tools (`snmpwalk`, `snmpget`, `snmptable`) via subprocess. Same pattern as ap_scanner (SSH) and latency_prober (fping) — shell out to battle-tested C tools, parse structured output. Zero Python dependencies, full SNMPv3 support, rock-solid. If high-frequency polling is needed later, upgrade to `pysnmp-lextudio` (the only maintained pure-Python SNMP library with async + SNMPv3).

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

### Plugin: `nmap` ("The Far Sight")

**Discovers:** Open ports, service versions, and OS fingerprints across all topology nodes. This is the broad sweep — protocol-specific plugins (Docker, SNMP, systemd) then go deep on what nmap finds.

**Access method:** `python-nmap` library wrapping the `nmap` CLI. nmap's service probe database is decades of community fingerprinting — we shouldn't replicate it.

**What it does:**
1. **Periodic full scan** — `nmap -sV -O --open` against all topology node IPs (or a configured subnet). Identifies open ports, service names/versions, and OS.
2. **Feed enrichment pipeline** — nmap results are cross-referenced with existing nodes. If nmap detects a Synology NAS running DSM 7.2, that enriches the node's metadata even if no other plugin can reach it.
3. **Discover unknown hosts** — if nmap finds IPs not in topology, they're flagged as candidates for auto-creation (same flow as ap_scanner's unknown node handling).
4. **Supersedes signal 4** — the 6-signal enrichment pipeline's TCP port probe (11 ports, 1.5s timeout) is a primitive version of what nmap does natively. With nmap available, signal 4 can defer to nmap results.

**SubEntity output:**
```python
SubEntity(
    id="nmap:10.0.6.103:scan",
    type="nmap_scan",
    name="hp-switch scan",
    host_node_id="hp-switch",
    status="up",
    metadata={
        "os_match": "HP ProCurve Switch 2920",
        "os_accuracy": 95,
        "open_ports": [22, 80, 161, 443],
        "services": {
            "22": {"name": "ssh", "product": "OpenSSH", "version": "8.9"},
            "80": {"name": "http", "product": "HP Web Management"},
            "161": {"name": "snmp"},
        },
        "scan_time_ms": 3200,
    },
)
```

**Scan interval:** 600 seconds (10 minutes — nmap scans are heavy).

**Config:**
- `scan_args`: Extra nmap arguments (default: `-sV -O --open -T4`)
- `subnets`: Additional subnets to scan beyond topology IPs (default: none)
- `exclude_ips`: IPs to skip (default: none)

**System requirement:** `apt install nmap` (not installed by default).

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

### Plugin: `github` ("The Archive Spire")

**Discovers:** GitHub repositories, their status, and links them to existing topology/project nodes.

**Access method:** `gh` CLI or GitHub REST API (already authenticated via gh credential helper).

**What it tracks:**
- All repos in the `jphein` account (currently 56)
- Per-repo: last commit date, default branch, open PRs, open issues, CI status (last workflow run), public/private, description
- Links repos to topology nodes by matching repo name to node_id (e.g., `portfolio` repo → `portfolio` node)
- Links repos to local `~/Projects/` directories by matching directory name

**SubEntity output:**
```python
SubEntity(
    id="github:jphein:portfolio",
    type="github_repo",
    name="portfolio",
    host_node_id="github",  # meta-node representing GitHub
    status="active",  # active (recent commits), stale (>30d), archived
    metadata={
        "url": "https://github.com/jphein/portfolio",
        "private": True,
        "description": "The Builder's Sanctum — fantasy-themed developer portfolio",
        "default_branch": "main",
        "last_commit": "2026-04-06T...",
        "open_prs": 0,
        "open_issues": 2,
        "ci_status": "success",  # success, failure, pending, none
        "local_path": "/home/jp/Projects/portfolio",
        "has_claude_md": True,
    },
)
```

**Entity linking:** Repos auto-link to topology nodes by name match. When linked, the node gains repo metadata (CI status badge, last commit, open PRs). Repos also link to local project directories for a full "project → code → deployment" chain.

**Scan interval:** 300 seconds (GitHub API is rate-limited, lightweight polling).

**Config:**
- `github_user`: GitHub username (default: from `gh` config)
- `include_forks`: Include forked repos (default: false)

### Plugin: `projects` ("The Scholar's Archive")

**Discovers:** Local project directories in `~/Projects/` — git status, structure, and health.

**Access method:** Local filesystem + git commands.

**What it tracks:**
- All directories in `~/Projects/` (currently 66)
- Per-project: git status (clean/dirty), current branch, last commit, remote URL, has CLAUDE.md, has tests, language/stack detection
- Cross-references with GitHub plugin (local dir ↔ remote repo)
- Cross-references with topology (project dir ↔ running service node)

**SubEntity output:**
```python
SubEntity(
    id="project:realmwatch",
    type="local_project",
    name="realmwatch",
    host_node_id="forge",  # the machine where ~/Projects/ lives
    status="active",  # active (dirty or recent commits), clean, stale
    metadata={
        "path": "/home/jp/Projects/realmwatch",
        "git_dirty": True,
        "branch": "master",
        "last_commit": "2026-04-07T...",
        "remote": "https://github.com/jphein/realmwatch",
        "has_claude_md": True,
        "has_tests": False,
        "stack": ["python", "javascript"],
        "github_repo": "github:jphein:realmwatch",  # cross-link
        "topology_node": "realmwatch",  # cross-link
    },
)
```

**Scan interval:** 120 seconds.

### Plugin: `manual` ("The Chronicler's Quill")

**Discovers:** Nothing — this plugin provides a way to declare static sub-entities, relationships, annotations, and external bookmarks that can't be auto-discovered. It's the catch-all for human knowledge that no scanner can infer.

**Entry types:**

#### 1. Static Infrastructure
Nodes with no management interface — can't SSH, can't SNMP, can't API.

```json
{
    "id": "manual:fiber-gateway",
    "type": "infrastructure",
    "name": "Fiber Gateway",
    "host_node_id": "fiber-gateway",
    "status": "assumed_up",
    "metadata": {
        "description": "AT&T fiber ONT",
        "ip": "108.74.4.89",
        "notes": "No management access, ping only"
    }
}
```

#### 2. Service Declarations
"This node runs X" when no plugin can detect it — services behind VPNs, custom protocols, or devices the engine can't reach.

```json
{
    "id": "manual:terra2:minecraft",
    "type": "service",
    "name": "Minecraft Bedrock Servers",
    "host_node_id": "terra2",
    "status": "running",
    "metadata": {
        "description": "3 Bedrock servers on Azure VM",
        "ports": [19132, 8888, 8890],
        "provider": "azure",
        "url": "https://portal.azure.com/...",
        "notes": "No SSH from LAN, managed via Azure Portal"
    }
}
```

#### 3. Relationship Declarations
Manual parent-child or dependency links that auto-discovery can't infer.

```json
{
    "id": "manual:rel:jellyfin-depends-disks",
    "type": "relationship",
    "name": "jellyfin → disks",
    "host_node_id": "jellyfin",
    "status": "active",
    "metadata": {
        "relationship": "depends_on",
        "target_node_id": "disks",
        "description": "Jellyfin container runs on disks, media stored on NFS mount"
    }
}
```

Relationships surface as connection annotations on the map — dotted lines, dependency arrows, or grouping indicators.

#### 4. Tags and Annotations
Metadata that enriches the map but isn't discoverable — ownership, purpose, grouping, operational notes.

```json
{
    "id": "manual:tag:media-stack",
    "type": "tag",
    "name": "Media Stack",
    "host_node_id": "disks",
    "status": "active",
    "metadata": {
        "tag": "media-stack",
        "members": ["jellyfin", "navidrome", "immich", "syncthing"],
        "owner": "jp",
        "description": "Self-hosted media services on disks"
    }
}
```

```json
{
    "id": "manual:annotation:glenns-gear",
    "type": "annotation",
    "name": "<Owner>'s Equipment",
    "host_node_id": "glenns-bastion",
    "status": "active",
    "metadata": {
        "owner": "glenn",
        "notes": "<Owner> manages his own router and AP configs",
        "members": ["glenns-bastion", "the-hidden-chamber"]
    }
}
```

#### 5. External Bookmarks
Cloud services, SaaS tools, third-party APIs that are part of the realm's operational landscape but have no LAN presence.

```json
{
    "id": "manual:ext:cloudflare",
    "type": "external",
    "name": "Cloudflare",
    "host_node_id": "cloud",
    "status": "active",
    "metadata": {
        "service": "DNS + CDN",
        "domains": ["realm.watch", "jphe.in", "imaginalvision.com"],
        "dashboard": "https://dash.cloudflare.com/",
        "notes": "DNS for all public domains, proxy for some"
    }
}
```

```json
{
    "id": "manual:ext:vercel",
    "type": "external",
    "name": "Vercel",
    "host_node_id": "cloud",
    "status": "active",
    "metadata": {
        "service": "Static hosting",
        "projects": ["artcardsv5", "techempower", "dreamspace"],
        "dashboard": "https://vercel.com/jphein"
    }
}
```

**API:**
- `POST /discovery/manual` — create or update a manual entry
- `DELETE /discovery/manual/<id>` — remove a manual entry
- `GET /discovery/manual` — list all manual entries
- `GET /discovery/manual/tags` — list all tags (for filtering/grouping)

**Scan interval:** None — manual entries don't scan. Status is set explicitly or derived from the latency prober (if the node is pingable). Tags and annotations have no status — they're pure metadata.

**Frontend:** Manual entries are editable from the discovery dashboard panel. Tags can be used as map filters ("show me just the media stack"). Annotations show as tooltips or badges.

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
| `python-nmap` | >=0.7 | nmap plugin — wraps nmap CLI for service/OS detection |

That's it. The design deliberately minimizes Python dependencies:
- **SNMP** → shells out to Net-SNMP CLI tools (same pattern as fping, SSH)
- **Docker** → SSH + `docker ps --format json` (no Docker SDK, no exposed socket)
- **KVM** → SSH + `virsh` commands (stdlib)
- **systemd** → SSH + `systemctl` (stdlib)
- **Netdata** → httpx (already in requirements.txt)
- **GitHub** → `gh` CLI (already installed)

### System Packages (apt install)

| Package | Used By | Notes |
|---------|---------|-------|
| `snmp` | SNMP plugin | Net-SNMP CLI tools (snmpwalk, snmpget, snmptable) |
| `snmp-mibs-downloader` | SNMP plugin | Standard MIB definitions for human-readable OID names |
| `nmap` | nmap plugin | Network scanner for service/OS fingerprinting |

### On Target Hosts (not on the realmwatch server)

- **SSH access** — already required for AP scanning; key auth to most hosts
- **Docker** must be installed on hosts for Docker discovery (engine detects presence)
- **virsh** must be installed on hypervisors for KVM discovery (engine detects presence)
- No agents or packages need to be installed on target hosts for SNMP, systemd, or nmap discovery — all probed remotely

## Build Order

**Phase 1 — Core + first plugins (entity linking is the key feature):**
1. **Core discovery engine** (`discovery_engine.py`) — SubEntity model, provider registry, entity linker, host access layer, scan orchestrator, DB tables, API endpoints, SSE integration, node enricher
2. **PluginContext extension** — add `register_discovery_provider()` method
3. **systemd plugin** — easiest to test (local machine first, then SSH)
4. **Docker plugin** — high value (disks runs media stack, 14 containers in status.realm.watch)

**Phase 2 — Infrastructure discovery:**
5. **nmap plugin** — broad sweep, service/OS fingerprinting, unknown host detection
6. **SNMP plugin** — switch port mapping, interface counters, device inventory (via Net-SNMP CLI)
7. **KVM plugin** — VMs on ubox0 and nodered (8 guests in status.realm.watch)
8. **Caddy plugin** — reverse proxy mapping (14 domain→backend mappings across 2 hosts)

**Phase 3 — Health & monitoring (replaces status.realm.watch manual checks):**
9. **Health plugin** — HTTP health, TCP/UDP ports, realm-sigil versions, TLS expiry
10. **Game servers plugin** — Minecraft Bedrock + Terraria on terra2
11. **Netdata plugin** — supplements collectd

**Phase 4 — Inventory & code (project awareness):**
12. **GitHub plugin** — repo status, CI, PRs, issues for all 56 repos
13. **Projects plugin** — local ~/Projects/ directory inventory, git status, stack detection
14. **Manual plugin** — static entries for non-discoverable nodes

**Phase 5 — Frontend:**
15. **Frontend: Vassals tab** — sub-entity display in node detail panel
16. **Frontend: Discovery dashboard panel** — overview panel
17. **Frontend: Linked node indicators** — badges and status on map nodes

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
- **Vercel/cloud deployment API polling** — health plugin checks HTTP endpoints, but we don't poll Vercel/GCP deployment APIs for build status. Future plugin if needed.
- **Replacing status.realm.watch** — this spec makes realmwatch the data source, but status.realm.watch may still be the public-facing status page consuming that data.
- **WordPress introspection** — WP admin API for plugin/theme status. Health plugin covers HTTP + version checks, which is sufficient.
