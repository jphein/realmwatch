# Autodiscovery Engine Phase 1 — Core + First Plugins

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core discovery engine and two initial plugins (systemd, Docker) that discover services/containers on topology hosts and auto-link them to existing map nodes.

**Architecture:** New core module `discovery_engine.py` manages a provider registry, scan orchestration via ThreadPoolExecutor, entity linking (ID/hostname/IP match), and DB persistence. Plugins register discovery providers via `PluginContext.register_discovery_provider()`. The engine exposes `/discovery` API endpoints and a `discovery` SSE event type. Two initial plugins prove the model: systemd (local + SSH) and Docker (SSH).

**Tech Stack:** Python 3.12, stdlib threading/concurrent.futures, SQLite (realm.db), existing plugin system (plugin_context.py, plugin_loader.py, plugin_registry.py), esbuild frontend build.

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md`

**Depends on:** Plugin system (implemented), pre-cleanup commit `eb98c31`.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `discovery_engine.py` | SubEntity model, DiscoveryProvider dataclass, DiscoveryEngine class (provider registry, scan orchestrator, entity linker, node enricher, stale cleanup), HostAccess class |
| `plugins/discovery/plugin.json` | Manifest for the discovery dashboard companion plugin (registers API endpoints, SSE source, status provider) |
| `plugins/discovery/plugin.py` | Setup: registers `/discovery` endpoints, SSE source, node enricher. Thin wrapper that delegates to discovery_engine |
| `plugins/systemd/plugin.json` | Manifest for systemd discovery plugin |
| `plugins/systemd/plugin.py` | Registers systemd discovery provider, implements `discover_systemd()` |
| `plugins/docker-discovery/plugin.json` | Manifest for Docker discovery plugin (named `docker-discovery` to avoid confusion with Docker itself) |
| `plugins/docker-discovery/plugin.py` | Registers Docker discovery provider, implements `discover_docker()` |

### Modified Files

| File | Changes |
|------|---------|
| `plugin_context.py` | Add `register_discovery_provider()` method |
| `plugin_registry.py` | Add `DiscoveryProvider` dataclass, provider storage, `get_discovery_providers()` |
| `realm_db.py` | Add `sub_entities`, `discovery_links`, `discovery_capabilities` tables + CRUD functions |
| `map_server.py` | Import and start discovery engine after plugin load |

---

## Task 1: Database Tables for Discovery

**Files:**
- Modify: `realm_db.py`

- [ ] **Step 1: Add table creation to `init()`**

In `realm_db.py`, add these tables after the existing `CREATE TABLE` statements in `init()`:

```python
        CREATE TABLE IF NOT EXISTS sub_entities (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            host_node_id TEXT NOT NULL,
            status TEXT DEFAULT 'unknown',
            metadata TEXT DEFAULT '{}',
            linked_node_id TEXT,
            provider TEXT NOT NULL,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            link_type TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sub_entities_host ON sub_entities(host_node_id);
        CREATE INDEX IF NOT EXISTS idx_sub_entities_linked ON sub_entities(linked_node_id);
        CREATE INDEX IF NOT EXISTS idx_sub_entities_provider ON sub_entities(provider);

        CREATE TABLE IF NOT EXISTS discovery_links (
            sub_entity_id TEXT PRIMARY KEY,
            linked_node_id TEXT NOT NULL,
            created REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS discovery_capabilities (
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            available INTEGER DEFAULT 1,
            last_checked REAL,
            error TEXT,
            PRIMARY KEY (node_id, provider)
        );
```

- [ ] **Step 2: Add CRUD functions for sub_entities**

Add to `realm_db.py`:

```python
def get_sub_entities(host_node_id=None, provider=None, linked_node_id=None):
    """Query sub-entities with optional filters."""
    c = _conn()
    sql = "SELECT * FROM sub_entities WHERE 1=1"
    params = []
    if host_node_id:
        sql += " AND host_node_id = ?"
        params.append(host_node_id)
    if provider:
        sql += " AND provider = ?"
        params.append(provider)
    if linked_node_id:
        sql += " AND linked_node_id = ?"
        params.append(linked_node_id)
    rows = c.execute(sql, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["metadata"] = json.loads(d["metadata"]) if d["metadata"] else {}
        result.append(d)
    return result


def upsert_sub_entity(entity):
    """Insert or update a sub-entity. entity is a dict with at minimum: id, type, name, host_node_id, status, provider."""
    c = _conn()
    now = time.time()
    existing = c.execute("SELECT first_seen FROM sub_entities WHERE id = ?", (entity["id"],)).fetchone()
    first_seen = existing["first_seen"] if existing else now
    metadata = json.dumps(entity.get("metadata", {}))
    c.execute("""INSERT OR REPLACE INTO sub_entities
        (id, type, name, host_node_id, status, metadata, linked_node_id, provider, first_seen, last_seen, link_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (entity["id"], entity["type"], entity["name"], entity["host_node_id"],
         entity.get("status", "unknown"), metadata, entity.get("linked_node_id"),
         entity["provider"], first_seen, now, entity.get("link_type")))
    c.commit()


def upsert_sub_entities_batch(entities):
    """Batch upsert sub-entities. More efficient than individual calls."""
    c = _conn()
    now = time.time()
    for entity in entities:
        existing = c.execute("SELECT first_seen FROM sub_entities WHERE id = ?", (entity["id"],)).fetchone()
        first_seen = existing["first_seen"] if existing else now
        metadata = json.dumps(entity.get("metadata", {}))
        c.execute("""INSERT OR REPLACE INTO sub_entities
            (id, type, name, host_node_id, status, metadata, linked_node_id, provider, first_seen, last_seen, link_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (entity["id"], entity["type"], entity["name"], entity["host_node_id"],
             entity.get("status", "unknown"), metadata, entity.get("linked_node_id"),
             entity["provider"], first_seen, now, entity.get("link_type")))
    c.commit()


def delete_sub_entity(entity_id):
    """Delete a sub-entity by ID."""
    c = _conn()
    c.execute("DELETE FROM sub_entities WHERE id = ?", (entity_id,))
    c.execute("DELETE FROM discovery_links WHERE sub_entity_id = ?", (entity_id,))
    c.commit()


def cleanup_stale_sub_entities(stale_hours=24, dead_days=7, manual_days=30):
    """Mark unseen entities as stale, delete very old ones."""
    c = _conn()
    now = time.time()
    stale_cutoff = now - (stale_hours * 3600)
    dead_cutoff = now - (dead_days * 86400)
    manual_cutoff = now - (manual_days * 86400)
    # Mark stale
    c.execute("UPDATE sub_entities SET status = 'stale' WHERE last_seen < ? AND status != 'stale'",
              (stale_cutoff,))
    # Delete very old non-manual entities
    c.execute("DELETE FROM sub_entities WHERE last_seen < ? AND link_type != 'manual'",
              (dead_cutoff,))
    # Delete very old manual entities
    c.execute("DELETE FROM sub_entities WHERE last_seen < ? AND link_type = 'manual'",
              (manual_cutoff,))
    c.commit()


def get_discovery_link(sub_entity_id):
    """Get manual link override for a sub-entity."""
    c = _conn()
    row = c.execute("SELECT * FROM discovery_links WHERE sub_entity_id = ?",
                    (sub_entity_id,)).fetchone()
    return dict(row) if row else None


def set_discovery_link(sub_entity_id, linked_node_id):
    """Set a manual link between sub-entity and topology node."""
    c = _conn()
    now = time.time()
    c.execute("INSERT OR REPLACE INTO discovery_links (sub_entity_id, linked_node_id, created) VALUES (?, ?, ?)",
              (sub_entity_id, linked_node_id, now))
    c.execute("UPDATE sub_entities SET linked_node_id = ?, link_type = 'manual' WHERE id = ?",
              (linked_node_id, sub_entity_id))
    c.commit()


def delete_discovery_link(sub_entity_id):
    """Remove a manual link."""
    c = _conn()
    c.execute("DELETE FROM discovery_links WHERE sub_entity_id = ?", (sub_entity_id,))
    c.execute("UPDATE sub_entities SET linked_node_id = NULL, link_type = NULL WHERE id = ? AND link_type = 'manual'",
              (sub_entity_id,))
    c.commit()


def get_discovery_capabilities(node_id=None):
    """Get discovery capabilities, optionally filtered by node."""
    c = _conn()
    if node_id:
        rows = c.execute("SELECT * FROM discovery_capabilities WHERE node_id = ?", (node_id,)).fetchall()
    else:
        rows = c.execute("SELECT * FROM discovery_capabilities").fetchall()
    return [dict(r) for r in rows]


def set_discovery_capability(node_id, provider, available, error=None):
    """Record whether a provider can reach a specific node."""
    c = _conn()
    c.execute("""INSERT OR REPLACE INTO discovery_capabilities
        (node_id, provider, available, last_checked, error) VALUES (?, ?, ?, ?, ?)""",
        (node_id, provider, 1 if available else 0, time.time(), error))
    c.commit()
```

- [ ] **Step 3: Verify tables create correctly**

Run: `venv/bin/python3 -c "import realm_db; realm_db.init(); c = realm_db._conn(); print([r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()])"`

Expected: list includes `sub_entities`, `discovery_links`, `discovery_capabilities`

- [ ] **Step 4: Commit**

```bash
git add realm_db.py
git commit -m "feat(discovery): add sub_entities, discovery_links, capabilities tables + CRUD"
```

---

## Task 2: Discovery Engine Core

**Files:**
- Create: `discovery_engine.py`

- [ ] **Step 1: Create discovery_engine.py with SubEntity, DiscoveryProvider, HostAccess, and DiscoveryEngine**

```python
"""Discovery engine — provider registry, scan orchestration, entity linking.

Central module that plugins register discovery providers with. Runs a background
ThreadPoolExecutor to scan hosts, link discovered sub-entities to topology nodes,
and persist results to realm.db.
"""

import dataclasses
import json
import logging
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import realm_db

log = logging.getLogger(__name__)

# ── Role-based provider defaults ──
ROLE_PROVIDERS = {
    "server": ["docker", "systemd", "netdata"],
    "nas": ["docker", "systemd"],
    "vm": ["systemd", "netdata"],
    "hypervisor": ["docker", "kvm", "systemd", "netdata"],
    "router": ["snmp", "netdata"],
    "switch": ["snmp"],
    "ap": ["snmp"],
    "desktop": ["systemd"],
    "laptop": [],
    "ups": ["snmp"],
    "printer": ["snmp"],
    "bridge": ["snmp"],
}


@dataclasses.dataclass
class SubEntity:
    """A discovered sub-entity (container, VM, service, etc.)."""
    id: str
    type: str
    name: str
    host_node_id: str
    status: str = "unknown"
    metadata: dict = dataclasses.field(default_factory=dict)
    linked_node_id: str | None = None
    last_seen: float = 0.0
    provider: str = ""
    link_type: str | None = None

    def to_dict(self):
        return {
            "id": self.id, "type": self.type, "name": self.name,
            "host_node_id": self.host_node_id, "status": self.status,
            "metadata": self.metadata, "linked_node_id": self.linked_node_id,
            "provider": self.provider, "last_seen": self.last_seen,
            "link_type": self.link_type,
        }


@dataclasses.dataclass
class DiscoveryProvider:
    """A registered discovery provider from a plugin."""
    name: str
    roles: list[str]
    discover_fn: callable  # fn(node_id, node_data, host_access, engine) -> list[SubEntity]
    interval: int = 60
    entity_types: list[str] = dataclasses.field(default_factory=list)
    priority: int = 50
    plugin: str = ""


class HostAccess:
    """Provides access methods for a specific host node."""

    _ssh_cache = {}  # {node_id: (available, timestamp)}
    _SSH_CACHE_TTL = 300  # 5 minutes

    def __init__(self, node_id, node_data):
        self.node_id = node_id
        self.ip = node_data.get("ip")
        self.hostname = node_data.get("hostname", node_id)
        self._discovery_config = node_data.get("discovery", {})

    @property
    def ssh_user(self):
        return self._discovery_config.get("ssh_user", "root")

    @property
    def ssh_target(self):
        """SSH target string (user@host or just host)."""
        user = self.ssh_user
        host = self.ip or self.hostname
        if not host:
            return None
        return f"{user}@{host}" if user != "root" else f"root@{host}"

    def ssh(self, command, timeout=10):
        """Execute command via SSH. Returns (stdout, stderr, returncode)."""
        target = self.ssh_target
        if not target:
            return ("", "No SSH target for node", 1)
        try:
            result = subprocess.run(
                ["ssh", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
                 "-o", "BatchMode=yes", target, command],
                capture_output=True, text=True, timeout=timeout
            )
            return (result.stdout, result.stderr, result.returncode)
        except subprocess.TimeoutExpired:
            return ("", f"SSH timeout ({timeout}s)", 124)
        except Exception as e:
            return ("", str(e), 1)

    def ssh_available(self):
        """Check if SSH is reachable (cached for 5 minutes)."""
        now = time.time()
        cached = self._ssh_cache.get(self.node_id)
        if cached and (now - cached[1]) < self._SSH_CACHE_TTL:
            return cached[0]
        stdout, stderr, rc = self.ssh("echo ok", timeout=5)
        available = rc == 0
        self._ssh_cache[self.node_id] = (available, now)
        return available

    def http_get(self, port, path="/", timeout=5):
        """HTTP GET to host:port/path. Returns response dict or None."""
        import httpx
        url = f"http://{self.ip}:{port}{path}"
        try:
            resp = httpx.get(url, timeout=timeout, verify=False)
            return {"status": resp.status_code, "body": resp.text, "headers": dict(resp.headers)}
        except Exception:
            return None


class DiscoveryEngine:
    """Central discovery orchestrator."""

    def __init__(self):
        self._providers: list[DiscoveryProvider] = []
        self._providers_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=20, thread_name_prefix="discovery")
        self._running = False
        self._last_scan: dict[str, float] = {}  # {provider_name: last_scan_timestamp}
        self._sub_entities: dict[str, SubEntity] = {}  # {entity_id: SubEntity} in-memory cache
        self._lock = threading.Lock()

    def register_provider(self, provider: DiscoveryProvider):
        """Register a discovery provider."""
        with self._providers_lock:
            # Replace existing provider with same name
            self._providers = [p for p in self._providers if p.name != provider.name]
            self._providers.append(provider)
            self._providers.sort(key=lambda p: p.priority)
        log.info("Discovery provider registered: %s (roles=%s, interval=%ds, priority=%d)",
                 provider.name, provider.roles, provider.interval, provider.priority)

    def get_providers(self):
        """Return snapshot of registered providers."""
        with self._providers_lock:
            return list(self._providers)

    def get_sub_entities(self, host_node_id=None):
        """Get sub-entities, optionally filtered by host."""
        with self._lock:
            if host_node_id:
                return [e.to_dict() for e in self._sub_entities.values()
                        if e.host_node_id == host_node_id]
            return [e.to_dict() for e in self._sub_entities.values()]

    def get_sub_entities_for_linked_node(self, node_id):
        """Get sub-entities linked to a specific topology node."""
        with self._lock:
            return [e.to_dict() for e in self._sub_entities.values()
                    if e.linked_node_id == node_id]

    # ── Entity Linker ──

    def _link_entity(self, entity, topo_nodes):
        """Try to auto-link a sub-entity to an existing topology node."""
        # 1. Manual override
        manual = realm_db.get_discovery_link(entity.id)
        if manual:
            entity.linked_node_id = manual["linked_node_id"]
            entity.link_type = "manual"
            return

        node_by_id = {n.get("id", ""): n for n in topo_nodes}
        node_by_ip = {}
        for n in topo_nodes:
            ip = n.get("ip")
            if ip:
                node_by_ip[ip] = n

        # Strip common suffixes for matching
        clean_name = entity.name.lower()
        for suffix in (".service", ".local", ".lan"):
            if clean_name.endswith(suffix):
                clean_name = clean_name[:-len(suffix)]

        # 2. Exact node_id match
        if clean_name in node_by_id:
            entity.linked_node_id = clean_name
            entity.link_type = "auto"
            return

        # 3. Hostname/alias match
        for n in topo_nodes:
            hostname = (n.get("hostname") or "").lower()
            aliases = [a.lower() for a in n.get("aliases", [])]
            if clean_name == hostname or clean_name in aliases:
                entity.linked_node_id = n["id"]
                entity.link_type = "auto"
                return

        # 4. IP match
        entity_ip = entity.metadata.get("ip")
        if entity_ip and entity_ip in node_by_ip:
            entity.linked_node_id = node_by_ip[entity_ip]["id"]
            entity.link_type = "auto"
            return

    # ── Scan Orchestration ──

    def _get_eligible_nodes(self, provider, topo_nodes):
        """Get nodes eligible for this provider based on role and config."""
        eligible = []
        for node in topo_nodes:
            node_id = node.get("id", "")
            role = node.get("role", "unknown")
            discovery_config = node.get("discovery", {})

            # Explicit provider list overrides role defaults
            explicit = discovery_config.get("providers")
            if explicit is not None:
                if provider.name in explicit:
                    eligible.append(node)
                continue

            # Check if specific provider is disabled
            if discovery_config.get(provider.name) is False:
                continue

            # Role-based default
            role_defaults = ROLE_PROVIDERS.get(role, [])
            if provider.name in role_defaults:
                eligible.append(node)

        return eligible

    def _run_scan_cycle(self):
        """Execute one scan cycle — check due providers, dispatch to thread pool."""
        now = time.time()
        topo = realm_db.get_topology()
        topo_nodes = topo.get("nodes", [])

        with self._providers_lock:
            providers = list(self._providers)

        for provider in providers:
            last = self._last_scan.get(provider.name, 0)
            if now - last < provider.interval:
                continue

            self._last_scan[provider.name] = now
            eligible = self._get_eligible_nodes(provider, topo_nodes)
            if not eligible:
                continue

            # Submit discovery calls to thread pool
            futures = {}
            for node in eligible:
                host = HostAccess(node["id"], node)
                future = self._pool.submit(
                    self._safe_discover, provider, node["id"], node, host, topo_nodes
                )
                futures[future] = node["id"]

            # Collect results
            for future in as_completed(futures, timeout=60):
                node_id = futures[future]
                try:
                    entities = future.result(timeout=5)
                    if entities:
                        self._process_results(entities, topo_nodes, provider.name)
                except Exception:
                    log.debug("Discovery %s failed for %s", provider.name, node_id, exc_info=True)
                    realm_db.set_discovery_capability(node_id, provider.name, False,
                                                      error="scan failed")

    def _safe_discover(self, provider, node_id, node_data, host_access, topo_nodes):
        """Call provider's discover_fn with error handling."""
        try:
            return provider.discover_fn(node_id, node_data, host_access, self)
        except Exception as e:
            log.warning("Discovery provider %s error on %s: %s",
                        provider.name, node_id, e)
            return []

    def _process_results(self, entities, topo_nodes, provider_name):
        """Process discovered entities — link, deduplicate, persist."""
        for entity in entities:
            if not isinstance(entity, SubEntity):
                continue
            entity.last_seen = time.time()
            entity.provider = provider_name

            # Run entity linker
            self._link_entity(entity, topo_nodes)

            # Update in-memory cache
            with self._lock:
                self._sub_entities[entity.id] = entity

        # Batch persist
        realm_db.upsert_sub_entities_batch([e.to_dict() for e in entities if isinstance(e, SubEntity)])

    # ── Node Enricher ──

    def enrich_node(self, node_id, node_data):
        """Node enricher — called by plugin system for each node during status build."""
        with self._lock:
            host_entities = [e for e in self._sub_entities.values()
                            if e.host_node_id == node_id]
            linked_entities = [e for e in self._sub_entities.values()
                              if e.linked_node_id == node_id]

        result = {}

        # Host node enrichment: "8 containers, 2 VMs, 1 failed"
        if host_entities:
            by_type = {}
            failed_count = 0
            for e in host_entities:
                by_type[e.type] = by_type.get(e.type, 0) + 1
                if e.status in ("failed", "stopped"):
                    failed_count += 1
            parts = []
            type_labels = {"container": "containers", "vm": "VMs", "service": "services"}
            for t, count in sorted(by_type.items()):
                label = type_labels.get(t, t)
                parts.append(f"{count} {label}")
            sublabel = ", ".join(parts)
            if failed_count:
                sublabel += f", {failed_count} failed"
            result["sublabel"] = sublabel
            result["meta"] = {f"discovery:{t}": c for t, c in by_type.items()}
            if failed_count:
                result["status_class"] = "warning"

        # Linked node enrichment: "container on disks | running"
        if linked_entities:
            e = linked_entities[0]  # primary link
            type_label = {"container": "container", "vm": "VM", "service": "service"}.get(e.type, e.type)
            result["sublabel"] = f"{type_label} on {e.host_node_id} | {e.status}"
            result["meta"] = {
                "discovery:type": e.type, "discovery:host": e.host_node_id,
                "discovery:status": e.status, "discovery:provider": e.provider,
            }
            result["meta"].update({f"discovery:{k}": v for k, v in e.metadata.items()})
            if e.status == "failed":
                result["status_class"] = "critical"
            elif e.status == "stopped":
                result["status_class"] = "warning"

        return result if result else None

    # ── Lifecycle ──

    def _scan_loop(self):
        """Background scan loop — runs every 10s."""
        while self._running:
            try:
                self._run_scan_cycle()
            except Exception:
                log.error("Discovery scan cycle error", exc_info=True)
            time.sleep(10)

    def start(self):
        """Start the background scan loop."""
        if self._running:
            return
        # Load persisted sub-entities into memory cache
        for entity_dict in realm_db.get_sub_entities():
            entity = SubEntity(**{k: entity_dict[k] for k in SubEntity.__dataclass_fields__
                                  if k in entity_dict})
            self._sub_entities[entity.id] = entity
        log.info("Discovery engine loaded %d persisted sub-entities", len(self._sub_entities))

        self._running = True
        t = threading.Thread(target=self._scan_loop, daemon=True, name="discovery-engine")
        t.start()
        log.info("Discovery engine started with %d providers", len(self._providers))

    def stop(self):
        self._running = False
        self._pool.shutdown(wait=False)

    # ── SSE Data ──

    def get_sse_data(self):
        """Returns discovery data for SSE broadcast."""
        with self._lock:
            by_host = {}
            for e in self._sub_entities.values():
                host = e.host_node_id
                if host not in by_host:
                    by_host[host] = []
                by_host[host].append({
                    "id": e.id, "type": e.type, "name": e.name,
                    "status": e.status, "linked_node_id": e.linked_node_id,
                })
            total = len(self._sub_entities)
            running = sum(1 for e in self._sub_entities.values() if e.status == "running")
            stopped = sum(1 for e in self._sub_entities.values() if e.status == "stopped")
            failed = sum(1 for e in self._sub_entities.values() if e.status == "failed")
        return {
            "sub_entities": by_host,
            "summary": {"total": total, "running": running, "stopped": stopped, "failed": failed},
        }
```

- [ ] **Step 2: Verify it imports cleanly**

Run: `venv/bin/python3 -c "import discovery_engine; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add discovery_engine.py
git commit -m "feat(discovery): add core discovery engine — SubEntity, HostAccess, entity linker, scan orchestrator"
```

---

## Task 3: Plugin System Integration

**Files:**
- Modify: `plugin_registry.py`
- Modify: `plugin_context.py`

- [ ] **Step 1: Add DiscoveryProvider to plugin_registry.py**

Import at the top of `plugin_registry.py`:

```python
from discovery_engine import DiscoveryProvider
```

Add to `PluginRegistry.__init__`:

```python
        self._discovery_providers: list[DiscoveryProvider] = []
```

Add methods:

```python
    def register_discovery_provider(self, provider: DiscoveryProvider):
        """Register a discovery provider."""
        self._discovery_providers.append(provider)

    def get_discovery_providers(self) -> list[DiscoveryProvider]:
        """All registered discovery providers."""
        return list(self._discovery_providers)
```

- [ ] **Step 2: Add register_discovery_provider to PluginContext**

Add to `plugin_context.py` in the `PluginContext` class, in the `# ── Registration ──` section:

```python
    def register_discovery_provider(self, name, roles, discover_fn, interval=60,
                                     entity_types=None, priority=50):
        """Register a discovery provider with the engine.

        Args:
            name: Provider name (e.g., 'docker', 'systemd').
            roles: Node roles this provider scans (e.g., ['server', 'nas']).
            discover_fn: Callable(node_id, node_data, host_access, engine) -> list[SubEntity].
            interval: Seconds between scans (default 60).
            entity_types: What this provider discovers (e.g., ['container']).
            priority: Scan order (lower = earlier, default 50).
        """
        from discovery_engine import DiscoveryProvider
        provider = DiscoveryProvider(
            name=name, roles=roles, discover_fn=discover_fn,
            interval=interval, entity_types=entity_types or [],
            priority=priority, plugin=self.name,
        )
        self._registry.register_discovery_provider(provider)
        self._logger.info("Registered discovery provider: %s (roles=%s)", name, roles)
```

- [ ] **Step 3: Verify import chain works**

Run: `venv/bin/python3 -c "from plugin_context import PluginContext; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add plugin_registry.py plugin_context.py
git commit -m "feat(discovery): add register_discovery_provider to plugin system"
```

---

## Task 4: Discovery Companion Plugin (API + SSE)

**Files:**
- Create: `plugins/discovery/plugin.json`
- Create: `plugins/discovery/plugin.py`
- Modify: `map_server.py` (start engine)

- [ ] **Step 1: Create plugin manifest**

`plugins/discovery/plugin.json`:

```json
{
  "name": "discovery",
  "version": "1.0.0",
  "type": "integrated",
  "description": "Discovery engine companion — registers API endpoints, SSE source, and node enricher for the autodiscovery system.",
  "fantasy_name": "Realm Surveyors",
  "icon": "\ud83d\udd0d",

  "python": {
    "module": "plugin",
    "entry": "setup"
  },

  "endpoints": [],
  "sse_types": ["discovery"]
}
```

- [ ] **Step 2: Create plugin.py**

`plugins/discovery/plugin.py`:

```python
"""Discovery companion plugin — wires the discovery engine into the plugin system.

Registers:
- API endpoints: /discovery, /discovery/<node_id>, /discovery/links, /discovery/providers,
  /discovery/link, /discovery/unlink, /discovery/scan
- SSE source: 'discovery' event type
- Node enricher: discovery-based sublabels and status
- Status provider: discovery summary in status blob
"""

import json

# The engine instance is set by map_server.py before plugin load
_engine = None


def _h_get_discovery(req, params):
    """GET /discovery — all sub-entities grouped by host."""
    return req.respond(_engine.get_sse_data())


def _h_get_discovery_node(req, params):
    """GET /discovery/<node_id> — sub-entities for a specific host."""
    node_id = params.get("node_id", "")
    entities = _engine.get_sub_entities(host_node_id=node_id)
    # Also include entities linked TO this node
    linked = _engine.get_sub_entities_for_linked_node(node_id)
    return req.respond({"host_entities": entities, "linked_entities": linked})


def _h_get_discovery_providers(req, params):
    """GET /discovery/providers — registered providers."""
    providers = _engine.get_providers()
    return req.respond([{
        "name": p.name, "roles": p.roles, "interval": p.interval,
        "entity_types": p.entity_types, "priority": p.priority, "plugin": p.plugin,
    } for p in providers])


def _h_get_discovery_links(req, params):
    """GET /discovery/links — all entity links."""
    import realm_db
    entities = realm_db.get_sub_entities()
    links = [{"sub_entity_id": e["id"], "linked_node_id": e["linked_node_id"],
              "link_type": e.get("link_type")}
             for e in entities if e.get("linked_node_id")]
    return req.respond(links)


def _h_post_discovery_link(req, params):
    """POST /discovery/link — create manual link."""
    import realm_db
    data = req.json()
    sub_id = data.get("sub_entity_id", "")
    node_id = data.get("node_id", "")
    if not sub_id or not node_id:
        return req.respond({"error": "sub_entity_id and node_id required"}, 400)
    realm_db.set_discovery_link(sub_id, node_id)
    return req.respond({"ok": True})


def _h_post_discovery_unlink(req, params):
    """POST /discovery/unlink — remove manual link."""
    import realm_db
    data = req.json()
    sub_id = data.get("sub_entity_id", "")
    if not sub_id:
        return req.respond({"error": "sub_entity_id required"}, 400)
    realm_db.delete_discovery_link(sub_id)
    return req.respond({"ok": True})


def _h_post_discovery_scan(req, params):
    """POST /discovery/scan — trigger immediate scan."""
    data = req.json()
    provider_name = data.get("provider", "all")
    # Force next scan cycle to run this provider immediately
    if provider_name == "all":
        _engine._last_scan.clear()
    else:
        _engine._last_scan.pop(provider_name, None)
    return req.respond({"ok": True, "message": f"Scan triggered for {provider_name}"})


def _discovery_status_provider():
    """Status provider — discovery summary in the status blob."""
    data = _engine.get_sse_data()
    return {"discovery": data["summary"]}


def setup(ctx):
    global _engine
    from discovery_engine import DiscoveryEngine

    # Get or create the engine singleton (map_server may have already created it)
    import map_server
    if hasattr(map_server, '_discovery_engine'):
        _engine = map_server._discovery_engine
    else:
        _engine = DiscoveryEngine()
        map_server._discovery_engine = _engine

    # Register API endpoints
    ctx.register_endpoint("GET", "/discovery", _h_get_discovery, raw_path=True)
    ctx.register_endpoint("GET", "/discovery/providers", _h_get_discovery_providers, raw_path=True)
    ctx.register_endpoint("GET", "/discovery/links", _h_get_discovery_links, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/link", _h_post_discovery_link, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/unlink", _h_post_discovery_unlink, raw_path=True)
    ctx.register_endpoint("POST", "/discovery/scan", _h_post_discovery_scan, raw_path=True)

    # Parameterized route for /discovery/<node_id>
    ctx.register_endpoint("GET", "/discovery/<node_id>", _h_get_discovery_node, raw_path=True)

    # SSE source
    ctx.register_sse_source("discovery", _engine.get_sse_data, interval=30, burst=True, burst_priority=6)

    # Node enricher (priority 35 — between WLED and WiFi)
    ctx.register_node_enricher(_engine.enrich_node, priority=35)

    # Status provider
    ctx.register_status_provider(_discovery_status_provider)

    # Expose API for other plugins
    ctx.expose_api({
        "get_sub_entities": _engine.get_sub_entities,
        "get_providers": _engine.get_providers,
        "get_sse_data": _engine.get_sse_data,
    })

    ctx.log("Realm Surveyors active — discovery engine companion loaded")
```

- [ ] **Step 3: Wire engine startup into map_server.py**

Add after the plugin loader section (after `_sse_broker.start()`):

```python
    # ── Discovery engine startup ──
    from discovery_engine import DiscoveryEngine
    if not hasattr(map_server, '_discovery_engine'):
        _discovery_engine = DiscoveryEngine()
    else:
        _discovery_engine = map_server._discovery_engine
    # Register all providers from plugins
    for provider in _plugin_registry.get_discovery_providers():
        _discovery_engine.register_provider(provider)
    _discovery_engine.start()
    map_server._discovery_engine = _discovery_engine
    print(f"Discovery engine started with {len(_discovery_engine.get_providers())} provider(s)")
```

Add `import map_server` to the `if __name__ == "__main__"` block context (it's the module itself, so use `import sys; map_server = sys.modules[__name__]`):

Actually, since map_server.py is the main module, use `sys.modules[__name__]` or just set it as a module-level variable. Simplest approach — add near the top of map_server.py after existing globals:

```python
_discovery_engine = None  # Set during startup
```

Then in the `__main__` block, after `_sse_broker.start()`:

```python
    # ── Discovery engine startup ──
    import discovery_engine as _de_mod
    _discovery_engine = _de_mod.DiscoveryEngine()
    for provider in _plugin_registry.get_discovery_providers():
        _discovery_engine.register_provider(provider)
    _discovery_engine.start()
    print(f"Discovery engine started with {len(_discovery_engine.get_providers())} provider(s)")
```

And update the discovery plugin to access it from map_server module:

In `plugins/discovery/plugin.py`, change the engine access to:
```python
    # The engine is created by map_server and accessible as a module-level var
    import sys
    ms = sys.modules.get('__main__')
    if ms and hasattr(ms, '_discovery_engine') and ms._discovery_engine:
        _engine = ms._discovery_engine
    else:
        _engine = DiscoveryEngine()
```

- [ ] **Step 4: Verify server starts cleanly**

Run: `venv/bin/python3 -c "import map_server; print('Import OK')"` (just checks imports, doesn't start server)

- [ ] **Step 5: Commit**

```bash
git add plugins/discovery/plugin.json plugins/discovery/plugin.py map_server.py
git commit -m "feat(discovery): add companion plugin with API endpoints, SSE source, node enricher"
```

---

## Task 5: Systemd Discovery Plugin

**Files:**
- Create: `plugins/systemd/plugin.json`
- Create: `plugins/systemd/plugin.py`

- [ ] **Step 1: Create plugin manifest**

`plugins/systemd/plugin.json`:

```json
{
  "name": "systemd",
  "version": "1.0.0",
  "type": "integrated",
  "description": "Systemd service discovery — finds interesting services on Linux hosts via SSH or local D-Bus.",
  "fantasy_name": "Runic Services",
  "icon": "\u2699\ufe0f",

  "python": {
    "module": "plugin",
    "entry": "setup"
  },

  "depends_on": ["discovery"]
}
```

- [ ] **Step 2: Create plugin.py**

`plugins/systemd/plugin.py`:

```python
"""Systemd discovery plugin — discovers interesting services on Linux hosts.

"Interesting" = failed/degraded units + port-listening services + user-level units + watch list.
Excludes noisy system units (systemd-*, snapd.*, getty@*, etc.).
"""

import json
import logging

from discovery_engine import SubEntity

log = logging.getLogger(__name__)

# Units to always exclude (noisy system services)
_EXCLUDE_PATTERNS = [
    "systemd-", "snapd.", "getty@", "user@", "session-", "snap.", "dbus.",
    "polkit", "accounts-daemon", "networkd-dispatcher", "unattended-upgrades",
    "packagekit", "udisks2", "upower", "thermald", "kerneloops",
    "whoopsie", "apport", "plymouth", "cloud-", "lvm2-",
]

# Known active states that mean "running"
_ACTIVE_STATES = {"active", "activating", "reloading"}


def _is_excluded(unit_name):
    """Check if a unit name matches any exclusion pattern."""
    for pattern in _EXCLUDE_PATTERNS:
        if unit_name.startswith(pattern):
            return True
    return False


def _parse_systemctl_json(output):
    """Parse systemctl --output=json output. Returns list of unit dicts."""
    try:
        units = json.loads(output)
        if isinstance(units, list):
            return units
    except (json.JSONDecodeError, TypeError):
        pass
    return []


def discover_systemd(node_id, node_data, host, engine):
    """Discover interesting systemd services on a host."""
    discovery_config = node_data.get("discovery", {})

    # Check if this is the local machine
    import socket
    is_local = (host.ip in ("127.0.0.1", "localhost") or
                host.hostname == socket.gethostname() or
                node_id in ("forge", "katana"))

    # Get system-level services
    if is_local:
        import subprocess
        result = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--output=json"],
            capture_output=True, text=True, timeout=10
        )
        system_out = result.stdout if result.returncode == 0 else ""
        # Also get user-level services
        result_user = subprocess.run(
            ["systemctl", "--user", "list-units", "--type=service", "--all", "--output=json"],
            capture_output=True, text=True, timeout=10
        )
        user_out = result_user.stdout if result_user.returncode == 0 else ""
    else:
        if not host.ssh_available():
            return []
        system_out, _, rc = host.ssh(
            "systemctl list-units --type=service --all --output=json", timeout=15)
        if rc != 0:
            return []
        user_out, _, _ = host.ssh(
            "systemctl --user list-units --type=service --all --output=json", timeout=15)

    entities = []
    watch_list = set(discovery_config.get("systemd_watch", []))

    for output, is_user in [(system_out, False), (user_out, True)]:
        units = _parse_systemctl_json(output)
        for unit in units:
            name = unit.get("unit", "")
            if not name.endswith(".service"):
                continue

            active = unit.get("active", "")
            sub_state = unit.get("sub", "")
            load = unit.get("load", "")

            # Filter: interesting services only
            is_failed = active == "failed"
            is_watched = name in watch_list or name.replace(".service", "") in watch_list
            is_interesting = is_failed or is_watched or is_user

            if not is_interesting and _is_excluded(name):
                continue

            # Skip inactive system services that aren't failed or watched
            if not is_interesting and active not in _ACTIVE_STATES:
                continue

            # Map status
            if is_failed:
                status = "failed"
            elif active in _ACTIVE_STATES:
                status = "running"
            else:
                status = "stopped"

            entity = SubEntity(
                id=f"systemd:{node_id}:{name}",
                type="service",
                name=name,
                host_node_id=node_id,
                status=status,
                metadata={
                    "active_state": active,
                    "sub_state": sub_state,
                    "load_state": load,
                    "user": is_user,
                    "description": unit.get("description", ""),
                },
            )
            entities.append(entity)

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="systemd",
        roles=["server", "nas", "vm", "hypervisor", "desktop"],
        discover_fn=discover_systemd,
        interval=60,
        entity_types=["service"],
        priority=20,
    )
    ctx.log("Runic Services active — systemd discovery provider registered")
```

- [ ] **Step 3: Test locally**

Run: `venv/bin/python3 -c "
from plugins.systemd.plugin import discover_systemd
from discovery_engine import HostAccess
host = HostAccess('forge', {'ip': '127.0.0.1', 'hostname': 'forge'})
results = discover_systemd('forge', {'ip': '127.0.0.1', 'hostname': 'forge'}, host, None)
print(f'Found {len(results)} services')
for r in results[:5]:
    print(f'  {r.name}: {r.status}')
"`

Expected: List of discovered services (realm-map-server, oracle-daemon, etc.)

- [ ] **Step 4: Commit**

```bash
git add plugins/systemd/plugin.json plugins/systemd/plugin.py
git commit -m "feat(discovery): add systemd plugin — discovers services on Linux hosts"
```

---

## Task 6: Docker Discovery Plugin

**Files:**
- Create: `plugins/docker-discovery/plugin.json`
- Create: `plugins/docker-discovery/plugin.py`

- [ ] **Step 1: Create plugin manifest**

`plugins/docker-discovery/plugin.json`:

```json
{
  "name": "docker-discovery",
  "version": "1.0.0",
  "type": "integrated",
  "description": "Docker container discovery — finds containers on hosts via SSH.",
  "fantasy_name": "Iron Golem Foundry",
  "icon": "\ud83d\udce6",

  "python": {
    "module": "plugin",
    "entry": "setup"
  },

  "depends_on": ["discovery"]
}
```

- [ ] **Step 2: Create plugin.py**

`plugins/docker-discovery/plugin.py`:

```python
"""Docker discovery plugin — discovers containers on hosts via SSH.

Uses `docker ps --format json` + `docker stats --no-stream --format json` over SSH.
No Docker SDK needed, no exposed Docker socket, works with Podman too.
"""

import json
import logging

from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _parse_docker_ps(output):
    """Parse `docker ps -a --format json` output (one JSON object per line)."""
    containers = []
    for line in output.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            containers.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return containers


def _parse_docker_stats(output):
    """Parse `docker stats --no-stream --format json` output."""
    stats = {}
    for line in output.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            s = json.loads(line)
            name = s.get("Name", "")
            if name:
                stats[name] = s
        except json.JSONDecodeError:
            continue
    return stats


def discover_docker(node_id, node_data, host, engine):
    """Discover Docker containers on a host via SSH."""
    if not host.ssh_available():
        return []

    # Get container list
    ps_out, ps_err, ps_rc = host.ssh(
        "docker ps -a --format json", timeout=15)
    if ps_rc != 0:
        # Docker might not be installed — record capability
        import realm_db
        realm_db.set_discovery_capability(node_id, "docker", False,
                                           error=ps_err[:200] if ps_err else "docker not available")
        return []

    containers = _parse_docker_ps(ps_out)
    if not containers:
        return []

    # Get stats for running containers
    stats_out, _, _ = host.ssh(
        "docker stats --no-stream --format json", timeout=15)
    stats = _parse_docker_stats(stats_out) if stats_out else {}

    entities = []
    for c in containers:
        name = c.get("Names", "")
        state = c.get("State", "unknown").lower()
        image = c.get("Image", "")
        ports = c.get("Ports", "")
        created = c.get("CreatedAt", "")

        # Map Docker state to our status
        if state == "running":
            status = "running"
        elif state in ("exited", "dead"):
            status = "stopped"
        elif state in ("paused", "restarting"):
            status = state
        else:
            status = "unknown"

        metadata = {
            "image": image,
            "ports": ports,
            "created": created,
            "state": state,
            "status_text": c.get("Status", ""),
        }

        # Add stats if available
        container_stats = stats.get(name, {})
        if container_stats:
            metadata["cpu_percent"] = container_stats.get("CPUPerc", "")
            metadata["memory"] = container_stats.get("MemUsage", "")
            metadata["memory_percent"] = container_stats.get("MemPerc", "")
            metadata["net_io"] = container_stats.get("NetIO", "")
            metadata["block_io"] = container_stats.get("BlockIO", "")

        # Try to extract compose project
        label_out, _, _ = host.ssh(
            f"docker inspect --format '{{{{index .Config.Labels \"com.docker.compose.project\"}}}}' {name}",
            timeout=5)
        compose_project = label_out.strip() if label_out else ""
        if compose_project:
            metadata["compose_project"] = compose_project

        entity = SubEntity(
            id=f"docker:{node_id}:{name}",
            type="container",
            name=name,
            host_node_id=node_id,
            status=status,
            metadata=metadata,
        )
        entities.append(entity)

    import realm_db
    realm_db.set_discovery_capability(node_id, "docker", True)
    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="docker",
        roles=["server", "nas", "hypervisor"],
        discover_fn=discover_docker,
        interval=60,
        entity_types=["container"],
        priority=10,
    )
    ctx.log("Iron Golem Foundry active — Docker discovery provider registered")
```

- [ ] **Step 3: Commit**

```bash
git add plugins/docker-discovery/plugin.json plugins/docker-discovery/plugin.py
git commit -m "feat(discovery): add Docker plugin — discovers containers via SSH"
```

---

## Task 7: Integration Test — Start Server and Verify

- [ ] **Step 1: Start map_server and verify discovery engine initializes**

Run: `timeout 10 venv/bin/python3 map_server.py 2>&1 | head -20`

Expected output should include:
- `Discovery engine started with 2 provider(s)` (systemd + docker)
- No import errors or tracebacks

- [ ] **Step 2: Test API endpoints**

```bash
curl -s http://localhost/discovery | python3 -m json.tool | head -20
curl -s http://localhost/discovery/providers | python3 -m json.tool
curl -s http://localhost/discovery/forge | python3 -m json.tool | head -20
```

Expected: JSON responses with sub-entities (at least systemd services from local machine), provider list showing systemd + docker.

- [ ] **Step 3: Verify entity linking**

Check if any discovered services auto-linked to topology nodes:

```bash
curl -s http://localhost/discovery/links | python3 -m json.tool
```

Expected: Some auto links (e.g., realm-map-server.service may link if there's a matching node).

- [ ] **Step 4: Test manual link**

```bash
curl -s -X POST http://localhost/discovery/link \
  -H "Content-Type: application/json" \
  -d '{"sub_entity_id": "systemd:forge:realm-map-server.service", "node_id": "realmwatch"}'
curl -s http://localhost/discovery/links | python3 -m json.tool
```

- [ ] **Step 5: Verify SSE includes discovery events**

```bash
curl -s -N http://localhost/sse 2>&1 | head -30
```

Expected: Should include `event: discovery` with sub-entity data.

- [ ] **Step 6: Final commit**

```bash
git add -A  # Only if all files are reviewed
git commit -m "feat(discovery): Phase 1 complete — core engine + systemd + Docker plugins"
```

---

## What's Next (Future Plans)

After Phase 1 is validated:

- **Phase 2 plan:** Existing plugin upgrades (collectd, wled, ha, firewall, events, latency, scan)
- **Phase 3 plan:** Infrastructure discovery (nmap, SNMP, KVM, Caddy)
- **Phase 4 plan:** Health monitoring (health checks, game servers, Netdata)
- **Phase 5 plan:** Inventory (GitHub, projects, manual)
- **Phase 6 plan:** WiFi migration
- **Phase 7 plan:** Frontend (Vassals tab, discovery dashboard, linked node indicators)

Each phase gets its own plan document when we're ready to implement it.
