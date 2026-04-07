# Autodiscovery Phase 3 — Infrastructure Discovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four new infrastructure discovery plugins — nmap (broad network sweep + OS fingerprinting), SNMP (switch ports, interface counters, device inventory), KVM (libvirt VMs), and Caddy (reverse proxy domain→backend mappings).

**Depends on:** Phase 1 (core engine), Phase 2 (existing plugins unified)

**Estimated tasks:** 4

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (sections: nmap, SNMP, KVM, Caddy plugins)

---

## File Structure

| File | Changes |
|------|---------|
| `plugins/nmap/plugin.json` | New — manifest for nmap discovery plugin |
| `plugins/nmap/plugin.py` | New — nmap scan, service/OS detection, unknown host flagging |
| `plugins/snmp/plugin.json` | New — manifest for SNMP discovery plugin |
| `plugins/snmp/plugin.py` | New — interface status, MAC tables, system info via Net-SNMP CLI |
| `plugins/kvm/plugin.json` | New — manifest for KVM discovery plugin |
| `plugins/kvm/plugin.py` | New — virsh commands for VM discovery |
| `plugins/caddy/plugin.json` | New — manifest for Caddy discovery plugin |
| `plugins/caddy/plugin.py` | New — Caddyfile/admin API parsing for reverse proxy routes |
| `requirements.txt` | Add `python-nmap>=0.7` |
| `discovery_engine.py` | Add SNMP methods to HostAccess (snmp_get, snmp_walk, snmp_table) |

---

## Task 1: nmap Plugin ("The Far Sight")

**Files:** `plugins/nmap/plugin.json`, `plugins/nmap/plugin.py`, `requirements.txt`

**Description:** Broad network sweep using python-nmap. Scans all topology node IPs with `-sV -O --open -T4` to discover open ports, service versions, and OS fingerprints. Results feed the enrichment pipeline (superseding signal 4's primitive TCP probe). Unknown IPs found by nmap are flagged as candidates for auto-creation. Heavy scan — 10 minute interval.

**System requirement:** `apt install nmap`

**Key code:**

```python
import nmap

def discover_nmap(node_id, node_data, host_access, engine):
    """Scan a single node with nmap for open ports, services, OS."""
    if not host_access.ip:
        return []
    scanner = nmap.PortScanner()
    try:
        scanner.scan(host_access.ip, arguments="-sV -O --open -T4", timeout=30)
    except nmap.PortScannerError:
        return []
    if host_access.ip not in scanner.all_hosts():
        return []
    host = scanner[host_access.ip]
    services = {}
    open_ports = []
    for proto in host.all_protocols():
        for port in host[proto].keys():
            svc = host[proto][port]
            if svc["state"] == "open":
                open_ports.append(port)
                services[str(port)] = {
                    "name": svc.get("name", ""),
                    "product": svc.get("product", ""),
                    "version": svc.get("version", ""),
                }
    os_match = ""
    os_accuracy = 0
    if "osmatch" in host and host["osmatch"]:
        os_match = host["osmatch"][0].get("name", "")
        os_accuracy = int(host["osmatch"][0].get("accuracy", 0))
    return [SubEntity(
        id=f"nmap:{host_access.ip}:scan",
        type="nmap_scan",
        name=f"{node_id} scan",
        host_node_id=node_id,
        status="up",
        metadata={
            "os_match": os_match, "os_accuracy": os_accuracy,
            "open_ports": open_ports, "services": services,
        },
    )]

# setup(ctx):
ctx.register_discovery_provider(
    name="nmap", roles=list(ROLE_PROVIDERS.keys()),  # scan everything
    discover_fn=discover_nmap, interval=600,
    entity_types=["nmap_scan"], priority=90,  # run last (heaviest)
)
```

**Plugin manifest (`plugin.json`):**
```json
{
    "name": "nmap",
    "display_name": "The Far Sight",
    "description": "Network scan — open ports, service versions, OS fingerprinting",
    "version": "1.0.0",
    "dependencies": ["discovery"]
}
```

- [ ] Step 1: Add `python-nmap>=0.7` to requirements.txt, `pip install`
- [ ] Step 2: Create `plugins/nmap/plugin.json`
- [ ] Step 3: Implement `plugins/nmap/plugin.py` with `discover_nmap()`
- [ ] Step 4: Test — scan a known host, verify SubEntity in `/discovery`
- [ ] Step 5: Commit

---

## Task 2: SNMP Plugin ("Crystal Resonance")

**Files:** `plugins/snmp/plugin.json`, `plugins/snmp/plugin.py`, `discovery_engine.py`

**Description:** Discover SNMP-managed device data — interfaces, port status, MAC tables, system info. Uses Net-SNMP CLI tools (snmpwalk, snmpget, snmptable) via subprocess, same shell-out pattern as fping/SSH. Key feature: MAC address tables from switches enable physical topology discovery (which port is each device plugged into).

**System requirements:** `apt install snmp snmp-mibs-downloader`

**Key code — HostAccess SNMP methods (add to discovery_engine.py):**

```python
def snmp_get(self, oid, community="public", version=2):
    """SNMP GET via snmpget CLI."""
    host = self.ip or self.hostname
    cmd = ["snmpget", f"-v{version}", "-c", community, "-Oqv", host, oid]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 else None
    except: return None

def snmp_walk(self, oid, community="public", version=2):
    """SNMP WALK via snmpwalk CLI. Returns list of (oid, value) tuples."""
    host = self.ip or self.hostname
    cmd = ["snmpwalk", f"-v{version}", "-c", community, "-Oqn", host, oid]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0: return []
        pairs = []
        for line in result.stdout.strip().split("\n"):
            if " " in line:
                o, v = line.split(" ", 1)
                pairs.append((o.strip(), v.strip()))
        return pairs
    except: return []
```

**Key code — SNMP discovery:**

```python
def discover_snmp(node_id, node_data, host_access, engine):
    """Discover interfaces, MAC table, system info via SNMP."""
    community = node_data.get("discovery", {}).get("snmp_community", "public")
    # System info
    sys_descr = host_access.snmp_get("SNMPv2-MIB::sysDescr.0", community)
    sys_name = host_access.snmp_get("SNMPv2-MIB::sysName.0", community)
    if not sys_descr:
        return []  # SNMP not responding
    entities = []
    # Interface table
    if_names = host_access.snmp_walk("IF-MIB::ifDescr", community)
    if_statuses = host_access.snmp_walk("IF-MIB::ifOperStatus", community)
    if_speeds = host_access.snmp_walk("IF-MIB::ifSpeed", community)
    for i, (oid, name) in enumerate(if_names):
        idx = oid.rsplit(".", 1)[-1]
        status = dict(if_statuses).get(f".1.3.6.1.2.1.2.2.1.8.{idx}", "unknown")
        speed = dict(if_speeds).get(f".1.3.6.1.2.1.2.2.1.5.{idx}", "0")
        entities.append(SubEntity(
            id=f"snmp:{node_id}:port-{idx}",
            type="snmp_port",
            name=f"Port {idx} ({name})",
            host_node_id=node_id,
            status="up" if "up" in status else "down",
            metadata={"ifIndex": int(idx), "ifSpeed": int(speed), "ifDescr": name},
        ))
    # MAC address table for physical topology
    mac_entries = host_access.snmp_walk("BRIDGE-MIB::dot1dTpFdbAddress", community)
    # ... cross-reference MACs with known node MACs for port mapping
    return entities
```

- [ ] Step 1: Add SNMP methods (snmp_get, snmp_walk, snmp_table) to HostAccess
- [ ] Step 2: Create `plugins/snmp/plugin.json`
- [ ] Step 3: Implement `plugins/snmp/plugin.py` — interfaces, system info, MAC table
- [ ] Step 4: Test against hp-switch (10.0.6.103) — verify port SubEntities
- [ ] Step 5: Add MAC-to-port cross-reference for physical topology
- [ ] Step 6: Commit

---

## Task 3: KVM Plugin ("Ethereal Planes")

**Files:** `plugins/kvm/plugin.json`, `plugins/kvm/plugin.py`

**Description:** Discover KVM/libvirt VMs on hypervisor hosts via SSH + virsh commands. Lists all VMs, their state (running/shut off/paused), vCPU/memory allocation, disk size, and IP addresses. Auto-links VMs to existing topology nodes by name match.

**Key code:**

```python
def discover_kvm(node_id, node_data, host_access, engine):
    """Discover KVM VMs via virsh."""
    if not host_access.ssh_available():
        return []
    stdout, _, rc = host_access.ssh("virsh list --all --name", timeout=10)
    if rc != 0:
        return []
    entities = []
    for vm_name in stdout.strip().split("\n"):
        vm_name = vm_name.strip()
        if not vm_name:
            continue
        # Get VM info
        info_out, _, _ = host_access.ssh(f"virsh dominfo {vm_name}", timeout=10)
        info = _parse_virsh_info(info_out)  # parse key: value lines
        # Get IP if running
        ip = None
        if info.get("State") == "running":
            ip_out, _, _ = host_access.ssh(f"virsh domifaddr {vm_name}", timeout=10)
            ip = _parse_virsh_ip(ip_out)
        status_map = {"running": "running", "shut off": "stopped", "paused": "paused"}
        entities.append(SubEntity(
            id=f"kvm:{node_id}:{vm_name}",
            type="vm",
            name=vm_name,
            host_node_id=node_id,
            status=status_map.get(info.get("State", ""), "unknown"),
            metadata={
                "vcpus": int(info.get("CPU(s)", 0)),
                "memory_mb": int(info.get("Max memory", "0").split()[0]) // 1024,
                "autostart": info.get("Autostart") == "enable",
                "ip": ip,
            },
        ))
    return entities

def _parse_virsh_info(output):
    """Parse 'virsh dominfo' key-value output."""
    result = {}
    for line in output.strip().split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            result[k.strip()] = v.strip()
    return result
```

- [ ] Step 1: Create `plugins/kvm/plugin.json`
- [ ] Step 2: Implement `plugins/kvm/plugin.py` with virsh discovery + info parsing
- [ ] Step 3: Test against ubox0 (known hypervisor with ha-vm, realm-portal, etc.)
- [ ] Step 4: Verify VM→topology node auto-linking (ha-vm → home-assistant, etc.)
- [ ] Step 5: Commit

---

## Task 4: Caddy Plugin ("Gate Warden")

**Files:** `plugins/caddy/plugin.json`, `plugins/caddy/plugin.py`

**Description:** Discover Caddy reverse proxy configurations — which domains route to which backends. Uses SSH to read Caddyfile or queries the Caddy admin API (localhost:2019). Each domain→backend mapping becomes a `reverse_proxy` SubEntity. Backend IPs auto-link to topology nodes via the entity linker. Auto-activates on nodes where systemd or Docker discovery found Caddy running.

**Key code:**

```python
def discover_caddy(node_id, node_data, host_access, engine):
    """Discover Caddy reverse proxy routes."""
    # Try admin API first (faster, structured)
    resp = host_access.http_get(2019, "/config/apps/http/servers")
    routes = []
    if resp and resp["status"] == 200:
        routes = _parse_admin_api(resp["body"])
    else:
        # Fall back to Caddyfile via SSH
        stdout, _, rc = host_access.ssh("cat /etc/caddy/Caddyfile", timeout=10)
        if rc == 0:
            routes = _parse_caddyfile(stdout)
        else:
            # Try Docker exec for containerized Caddy
            stdout, _, rc = host_access.ssh(
                "docker exec caddy cat /etc/caddy/Caddyfile", timeout=10)
            if rc == 0:
                routes = _parse_caddyfile(stdout)
    entities = []
    for domain, backend in routes:
        entities.append(SubEntity(
            id=f"caddy:{node_id}:{domain}",
            type="reverse_proxy",
            name=f"{domain} → {backend}",
            host_node_id=node_id,
            status="running",
            metadata={
                "domain": domain,
                "backend": backend,
                "tls": not domain.startswith("http://"),
            },
        ))
    return entities

def _parse_caddyfile(content):
    """Parse Caddyfile for domain→backend mappings. Returns [(domain, backend)]."""
    routes = []
    lines = content.split("\n")
    current_domain = None
    for line in lines:
        line = line.strip()
        # Domain block: "vault.jphe.in {"
        if line and not line.startswith("#") and line.endswith("{"):
            current_domain = line.rstrip(" {").strip()
        elif current_domain and "reverse_proxy" in line:
            parts = line.split()
            if len(parts) >= 2:
                backend = parts[-1]
                routes.append((current_domain, backend))
            current_domain = None
    return routes
```

**Auto-activation:** This plugin shouldn't use role-based dispatch. Instead, after Phase 2's systemd/Docker scans run, check for `caddy.service` or a `caddy` container in discovery results. If found on a node, add that node to Caddy's scan targets. This can be done via a post-scan hook or by querying the engine in `discover_caddy`.

- [ ] Step 1: Create `plugins/caddy/plugin.json`
- [ ] Step 2: Implement `plugins/caddy/plugin.py` — admin API + Caddyfile parsing
- [ ] Step 3: Test against disks (Docker Caddy) and ubox0 (systemd Caddy)
- [ ] Step 4: Verify backend→node auto-linking (e.g., "10.0.6.134:8080" → realm-portal)
- [ ] Step 5: Commit

---

## What's Next

Phase 4 adds health monitoring plugins — HTTP endpoint health, TCP/UDP ports, realm-sigil version polling, game server status, and Netdata agent discovery. These replace the manual checks in status.realm.watch.
