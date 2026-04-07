# Autodiscovery Phase 2 — Existing Plugin Upgrades

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade all existing plugins (collectd, wled, ha, firewall, events, latency, scan) to feed the unified SubEntity discovery model, so the discovery dashboard and entity linker work across all data sources — not just new plugins.

**Depends on:** Phase 1 (core engine, systemd + Docker plugins working)

**Estimated tasks:** 7

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (section "Existing Plugin Upgrades")

---

## File Structure

| File | Changes |
|------|---------|
| `plugins/collectd/plugin.py` | Add `register_discovery_provider` call, implement `discover_collectd()` |
| `plugins/wled/plugin.py` | Add `register_discovery_provider` call, implement `discover_wled()` |
| `plugins/ha/plugin.py` | Add `register_discovery_provider` call, implement `discover_ha()`, migrate entity_map to discovery_links |
| `plugins/firewall/plugin.py` | Add `register_discovery_provider` call, implement `discover_firewall()` |
| `plugins/events/plugin.py` | Subscribe to `discovery_change` events, generate themed realm events |
| `plugins/latency/plugin.py` | Feed HostAccess reachability cache from fping results |
| `plugins/scan/plugin.py` | Add discovery scan buttons to the scan panel |
| `discovery_engine.py` | Add `on_event()` subscription mechanism and `reachability_cache` API |

---

## Task 1: collectd → Discovery Provider

**Files:** `plugins/collectd/plugin.py`

**Description:** Register collectd as a discovery provider that surfaces each monitored host as a `collectd_host` SubEntity. Scan the RRD directory (`/var/lib/collectd/rrd/`) for host folders, and for each, create a SubEntity with metadata about available plugins (cpu, memory, disk, etc.) and last-update timestamp. The entity linker auto-matches RRD hostnames to topology nodes.

**Key code:**

```python
def discover_collectd(node_id, node_data, host_access, engine):
    """Discover collectd hosts from RRD directories."""
    import os, time
    rrd_base = "/var/lib/collectd/rrd/"
    entities = []
    if not os.path.isdir(rrd_base):
        return entities
    for hostname in os.listdir(rrd_base):
        host_dir = os.path.join(rrd_base, hostname)
        if not os.path.isdir(host_dir):
            continue
        plugins = [d for d in os.listdir(host_dir) if os.path.isdir(os.path.join(host_dir, d))]
        mtime = max(os.path.getmtime(os.path.join(host_dir, p)) for p in plugins) if plugins else 0
        entities.append(SubEntity(
            id=f"collectd:{hostname}",
            type="collectd_host",
            name=hostname,
            host_node_id=hostname,  # entity linker will resolve
            status="running" if (time.time() - mtime) < 300 else "stale",
            metadata={"plugins": plugins, "last_update": mtime},
        ))
    return entities

# In setup(ctx):
ctx.register_discovery_provider(
    name="collectd", roles=[], discover_fn=discover_collectd,
    interval=120, entity_types=["collectd_host"], priority=60,
)
```

**Note:** This provider is special — it scans local RRD files, not remote hosts. The `roles=[]` means it runs once globally, not per-node. The engine needs to support a "global" provider mode (no role filtering, called once with `node_id="local"` or similar). If not already implemented in Phase 1, add a `global_provider` flag to `DiscoveryProvider`.

- [ ] Step 1: Add global provider support to `discovery_engine.py` if not present
- [ ] Step 2: Implement `discover_collectd()` and register in `setup()`
- [ ] Step 3: Test — verify collectd hosts appear in `/discovery`
- [ ] Step 4: Commit

---

## Task 2: wled → Discovery Provider

**Files:** `plugins/wled/plugin.py`

**Description:** Register WLED as a discovery provider. The existing WLED poll loop already probes devices via HTTP — add SubEntity creation alongside the existing sublabel/control logic. Each WLED device becomes a `wled_device` SubEntity with LED count, firmware version, effect info.

**Key code:**

```python
def discover_wled(node_id, node_data, host_access, engine):
    """Discover WLED device info via HTTP JSON API."""
    resp = host_access.http_get(80, "/json/info")
    if not resp or resp["status"] != 200:
        return []
    import json
    info = json.loads(resp["body"])
    return [SubEntity(
        id=f"wled:{node_id}",
        type="wled_device",
        name=info.get("name", node_id),
        host_node_id=node_id,
        status="running",
        metadata={
            "leds": info.get("leds", {}).get("count", 0),
            "firmware": info.get("ver", "unknown"),
            "brand": info.get("brand", "WLED"),
            "mac": info.get("mac", ""),
        },
    )]

# In setup(ctx):
ctx.register_discovery_provider(
    name="wled", roles=["wled", "iot"],
    discover_fn=discover_wled, interval=60,
    entity_types=["wled_device"], priority=40,
)
```

- [ ] Step 1: Implement `discover_wled()` and register in `setup()`
- [ ] Step 2: Ensure existing sublabel/control logic continues to work alongside
- [ ] Step 3: Test — verify WLED devices appear in `/discovery`
- [ ] Step 4: Commit

---

## Task 3: ha → Discovery Provider

**Files:** `plugins/ha/plugin.py`, `realm_db.py` (migration helper)

**Description:** Register Home Assistant as a discovery provider. HA devices from the device registry become `ha_device` SubEntities. The existing `entity_map` table in realm.db that maps HA entities to topology nodes should be migrated to discovery links (`discovery_links` table). Sublabel generation stays as a node enricher — only the discovery/linking data changes.

**Key code:**

```python
def discover_ha(node_id, node_data, host_access, engine):
    """Discover HA devices from device registry."""
    # node_id here is the HA host itself, but we discover devices across the network
    import httpx, os
    ha_url = os.getenv("HA_URL", "https://10.0.6.108:8123")
    ha_token = os.getenv("HA_TOKEN")
    if not ha_token:
        return []
    headers = {"Authorization": f"Bearer {ha_token}"}
    resp = httpx.get(f"{ha_url}/api/devices", headers=headers, verify=False, timeout=10)
    if resp.status_code != 200:
        return []
    entities = []
    for dev in resp.json():
        entities.append(SubEntity(
            id=f"ha:{dev['id']}",
            type="ha_device",
            name=dev.get("name_by_user") or dev.get("name", dev["id"]),
            host_node_id="home-assistant",  # HA is the parent
            status="running",
            metadata={
                "manufacturer": dev.get("manufacturer"),
                "model": dev.get("model"),
                "area": dev.get("area_id"),
                "identifiers": dev.get("identifiers", []),
            },
        ))
    return entities
```

**Migration:** On first run, read `entity_map` entries and create corresponding `discovery_links`. Log the migration count.

- [ ] Step 1: Implement `discover_ha()` and register in `setup()`
- [ ] Step 2: Add one-time entity_map → discovery_links migration
- [ ] Step 3: Verify HA sublabels still work (enricher is unchanged)
- [ ] Step 4: Test — verify HA devices appear in `/discovery`
- [ ] Step 5: Commit

---

## Task 4: firewall → Discovery Provider

**Files:** `plugins/firewall/plugin.py`

**Description:** Register the firewall parser as a discovery provider. Firewall zones become SubEntities on the gatekeeper node, with metadata about VLANs, interface bindings, and rule counts. Rule suggestions surface as discovery annotations.

**Key code:**

```python
def discover_firewall(node_id, node_data, host_access, engine):
    """Discover firewall zones from nftables."""
    # Uses existing firewall_parser.get_firewall_data()
    from firewall_parser import get_firewall_data
    fw = get_firewall_data()
    if not fw or "zones" not in fw:
        return []
    entities = []
    for zone_name, zone_data in fw.get("zones", {}).items():
        entities.append(SubEntity(
            id=f"fw:zone:{zone_name}",
            type="firewall_zone",
            name=zone_name,
            host_node_id="gatekeeper",
            status="active",
            metadata={
                "vlan": zone_data.get("vlan"),
                "interfaces": zone_data.get("interfaces", []),
                "rule_count": len(zone_data.get("rules", [])),
            },
        ))
    return entities
```

- [ ] Step 1: Implement `discover_firewall()` and register in `setup()`
- [ ] Step 2: Test — verify zones appear as SubEntities on gatekeeper
- [ ] Step 3: Commit

---

## Task 5: events → Subscribe to Discovery Changes

**Files:** `plugins/events/plugin.py`, `discovery_engine.py`

**Description:** Add an event subscription mechanism to the discovery engine (`on_event("discovery_change", handler)`). The events plugin subscribes to discovery state changes and generates fantasy-themed realm events with the same cooldown logic as existing threshold events. Examples: "The Iron Golem 'jellyfin' has fallen silent" (container stopped), "A new presence stirs in the Forge" (unknown container found).

**Key changes to discovery_engine.py:**

```python
# Add to DiscoveryEngine.__init__:
self._event_subscribers = []

def on_event(self, callback):
    """Subscribe to discovery change events. callback(event_type, entity, old_status)"""
    self._event_subscribers.append(callback)

# In _process_results, after updating cache:
old = self._sub_entities.get(entity.id)
old_status = old.status if old else None
# ... update cache ...
if old_status and old_status != entity.status:
    for cb in self._event_subscribers:
        try: cb("status_change", entity, old_status)
        except: pass
elif not old:
    for cb in self._event_subscribers:
        try: cb("new_entity", entity, None)
        except: pass
```

**Key event templates:**

| Trigger | Template |
|---------|----------|
| Container stopped | "The Iron Golem '{name}' has fallen silent in {host}" |
| Service failed | "The Runic Ward '{name}' on {host} has shattered" |
| New container | "A new construct stirs in {host}: {name}" |
| VM crashed | "The Ethereal Plane '{name}' has collapsed on {host}" |
| Host unreachable | "The beacon of {host} has gone dark" |

- [ ] Step 1: Add `on_event()` mechanism to `discovery_engine.py`
- [ ] Step 2: Emit events in `_process_results` for status changes and new entities
- [ ] Step 3: Subscribe in events plugin, generate themed realm events with cooldowns
- [ ] Step 4: Test — stop a container, verify realm event fires
- [ ] Step 5: Commit

---

## Task 6: latency → Feed HostAccess Reachability

**Files:** `plugins/latency/plugin.py`, `discovery_engine.py`

**Description:** The latency prober already runs fping every 30s against all wired nodes. Instead of the discovery engine separately probing SSH/SNMP reachability, expose the fping results as a reachability cache that HostAccess can consult. If fping says a host is unreachable, HostAccess skips SSH/SNMP probes entirely — saving timeout waits.

**Key changes:**

```python
# In discovery_engine.py, add to HostAccess:
_reachability_cache = {}  # {ip: (reachable: bool, rtt_ms: float, timestamp)}

@classmethod
def update_reachability(cls, ip, reachable, rtt_ms=None):
    cls._reachability_cache[ip] = (reachable, rtt_ms, time.time())

def is_reachable(self):
    """Check fping cache before attempting SSH/SNMP."""
    cached = self._reachability_cache.get(self.ip)
    if cached and (time.time() - cached[2]) < 60:
        return cached[0]
    return True  # assume reachable if no data

# In ssh_available(), prepend:
if not self.is_reachable():
    return False
```

```python
# In latency plugin, after fping results:
from discovery_engine import HostAccess
for ip, rtt in results.items():
    HostAccess.update_reachability(ip, rtt is not None, rtt)
```

- [ ] Step 1: Add `_reachability_cache` and `update_reachability()` to HostAccess
- [ ] Step 2: Gate `ssh_available()` and `snmp_available()` on reachability
- [ ] Step 3: Feed fping results into the cache from latency plugin
- [ ] Step 4: Test — verify unreachable hosts skip SSH attempts
- [ ] Step 5: Commit

---

## Task 7: scan → Unified Scan Trigger

**Files:** `plugins/scan/plugin.py`, `src/scan.js`

**Description:** Add discovery scan controls to the existing Survey Glass scan panel. A "Run Full Discovery" button triggers `POST /discovery/scan {"provider": "all"}`. Per-provider scan buttons (Docker, systemd, SNMP) allow targeted scans. Show provider status (last scan time, entity count) alongside existing WiFi/LLDP scan status.

**Key frontend additions (src/scan.js):**

```javascript
// Add to scan panel HTML template:
// <div class="discovery-scan-section">
//   <h3>Discovery Scans</h3>
//   <button data-provider="all">Run Full Discovery</button>
//   <button data-provider="docker">Docker</button>
//   <button data-provider="systemd">Systemd</button>
//   ... per registered provider
//   <div class="provider-status"></div>
// </div>

// Add click handler:
async function triggerDiscoveryScan(provider) {
    const resp = await fetch('/discovery/scan', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({provider}),
    });
    // Update status display
}
```

**Backend:** The `/discovery/scan` endpoint already exists from Phase 1. The scan plugin just needs to add UI controls that call it.

- [ ] Step 1: Add discovery scan section to scan panel HTML in `realm-map.html`
- [ ] Step 2: Add scan trigger and status display to `src/scan.js`
- [ ] Step 3: Build with `npm run build`
- [ ] Step 4: Test — click buttons, verify scans trigger
- [ ] Step 5: Commit

---

## What's Next

Phase 3 adds infrastructure discovery plugins — nmap (broad network sweep), SNMP (switch port mapping), KVM (VM discovery), and Caddy (reverse proxy mapping). These are all new plugins that follow the same registration pattern established in Phases 1-2.
