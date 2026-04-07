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
    _reachability_cache = {}  # {ip: (reachable, rtt_ms, timestamp)}
    _REACHABILITY_TTL = 60  # seconds

    @classmethod
    def update_reachability(cls, ip, reachable, rtt_ms=None):
        """Update reachability from external source (e.g., fping)."""
        cls._reachability_cache[ip] = (reachable, rtt_ms, time.time())

    def is_reachable(self):
        """Check fping reachability cache before attempting SSH/SNMP."""
        if not self.ip:
            return True  # no IP, can't check
        cached = self._reachability_cache.get(self.ip)
        if cached and (time.time() - cached[2]) < self._REACHABILITY_TTL:
            return cached[0]
        return True  # assume reachable if no data

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
        # Check fping reachability first
        if not self.is_reachable():
            return False
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

    def snmp_get(self, oid, community="public", version=2):
        """SNMP GET via snmpget CLI. Returns value string or None."""
        host = self.ip or self.hostname
        if not host:
            return None
        cmd = ["snmpget", f"-v{version}", "-c", community, "-Oqv", host, oid]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            return result.stdout.strip() if result.returncode == 0 else None
        except Exception:
            return None

    def snmp_walk(self, oid, community="public", version=2):
        """SNMP WALK via snmpwalk CLI. Returns list of (oid, value) tuples."""
        host = self.ip or self.hostname
        if not host:
            return []
        cmd = ["snmpwalk", f"-v{version}", "-c", community, "-Oqn", host, oid]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                return []
            pairs = []
            for line in result.stdout.strip().split("\n"):
                line = line.strip()
                if not line:
                    continue
                if " " in line:
                    o, v = line.split(" ", 1)
                    pairs.append((o.strip(), v.strip()))
            return pairs
        except Exception:
            return []


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
        self._event_subscribers = []  # list of callback(event_type, entity, old_status)

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

    def on_change(self, callback):
        """Subscribe to discovery change events.

        callback(event_type, entity, old_status) where event_type is
        'status_change' or 'new_entity'.
        """
        self._event_subscribers.append(callback)

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

        # 5. MAC match — for WiFi clients
        entity_mac = (entity.metadata.get("mac") or "").lower()
        if entity_mac:
            for n in topo_nodes:
                node_mac = (n.get("mac") or "").lower()
                if node_mac and node_mac == entity_mac:
                    entity.linked_node_id = n["id"]
                    entity.link_type = "auto"
                    return

    # ── Scan Orchestration ──

    def _get_eligible_nodes(self, provider, topo_nodes):
        """Get nodes eligible for this provider based on role and config."""
        import node_roles
        eligible = []
        for node in topo_nodes:
            node_id = node.get("id", "")
            role = node.get("role") or node_roles.get_role(node_id, node)
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

            # Global providers (roles=[]) run once, not per-node
            if not provider.roles:
                host = HostAccess("local", {"ip": "127.0.0.1", "hostname": "local"})
                future = self._pool.submit(
                    self._safe_discover, provider, "local", {}, host, topo_nodes
                )
                try:
                    entities = future.result(timeout=60)
                    if entities:
                        self._process_results(entities, topo_nodes, provider.name)
                except Exception:
                    log.debug("Global discovery %s failed", provider.name, exc_info=True)
                continue  # Skip per-node logic for global providers

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

            # Detect changes and update cache
            with self._lock:
                old = self._sub_entities.get(entity.id)
                old_status = old.status if old else None
                self._sub_entities[entity.id] = entity

            # Fire change events
            if old_status is None:
                for cb in self._event_subscribers:
                    try:
                        cb("new_entity", entity, None)
                    except Exception:
                        pass
            elif old_status != entity.status:
                for cb in self._event_subscribers:
                    try:
                        cb("status_change", entity, old_status)
                    except Exception:
                        pass

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
