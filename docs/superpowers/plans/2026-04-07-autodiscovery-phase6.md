# Autodiscovery Phase 6 — WiFi Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the WiFi plugin (ap_scanner) to the discovery provider model. This is the most complex upgrade because WiFi currently does its own node CRUD — creating `_unknown_<mac>` nodes directly in topology, doing custom MAC fuzzy matching, and managing stale cleanup independently.

**Depends on:** Phase 1 (core engine), Phase 2 (existing plugins unified — especially entity linker)

**Estimated tasks:** 4

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (section "wifi → Discovery Provider")

---

## File Structure

| File | Changes |
|------|---------|
| `plugins/wifi/plugin.py` | Major refactor — register as discovery provider, output SubEntities instead of direct topology mutations |
| `ap_scanner.py` | Retain scan logic (SSH to APs, DHCP leases, LLDP), refactor output to return SubEntity-compatible data |
| `discovery_engine.py` | Ensure entity linker handles WiFi MAC matching (replaces ap_scanner's custom fuzzy match) |
| `realm_db.py` | Migration helper: convert existing `_unknown_*` nodes to SubEntities |

---

## Task 1: Refactor ap_scanner Output Format

**Files:** `ap_scanner.py`

**Description:** The core WiFi scan logic (SSH to APs, parse `iwinfo assoclist`, query gatekeeper DHCP, run LLDP scans) stays intact — it works well. Refactor the output to return structured dicts suitable for SubEntity creation instead of directly calling topology mutation functions. The scan functions should return `[{mac, ap, signal, hostname, ip, ...}]` without side effects.

**Key changes:**

```python
# Before (current): directly creates/updates topology nodes
def _process_client(mac, ap_name, signal, ...):
    node_id = _find_or_create_node(mac, hostname)
    realm_db.update_node(node_id, ...)

# After: return structured data, let caller create SubEntities
def _process_client(mac, ap_name, signal, ...):
    return {
        "mac": mac,
        "ap": ap_name,
        "signal_dbm": signal,
        "hostname": hostname,
        "ip": ip,
        "vendor": oui_lookup(mac),
        "band": band,  # 2.4/5 GHz
    }

def scan_all_aps():
    """Run full AP scan cycle. Returns list of client dicts."""
    clients = []
    for ap in get_ap_list():
        raw = _ssh_iwinfo_assoclist(ap)
        for mac, signal in _parse_assoclist(raw):
            client = _process_client(mac, ap, signal, ...)
            clients.append(client)
    return clients
```

**Important:** Don't break existing functionality during the refactor. The scan loop currently runs independently — introduce the new return-value path alongside the old mutation path, then switch over in Task 2.

- [ ] Step 1: Add return-value versions of scan functions alongside existing ones
- [ ] Step 2: Verify existing WiFi display still works
- [ ] Step 3: Commit intermediary refactor

---

## Task 2: Register WiFi as Discovery Provider

**Files:** `plugins/wifi/plugin.py`

**Description:** Register WiFi as a discovery provider. Each WiFi client becomes a SubEntity: `SubEntity(id="wifi:<ap>:<mac>", type="wifi_client", ...)`. The scan loop uses refactored ap_scanner output from Task 1. Entity linker replaces the custom MAC fuzzy matching with the same auto-link logic used by all providers.

**Key code:**

```python
from discovery_engine import SubEntity

def discover_wifi(node_id, node_data, host_access, engine):
    """Discover WiFi clients by scanning all APs."""
    from ap_scanner import scan_all_aps
    clients = scan_all_aps()
    entities = []
    for client in clients:
        mac = client["mac"]
        ap = client["ap"]
        entities.append(SubEntity(
            id=f"wifi:{ap}:{mac}",
            type="wifi_client",
            name=client.get("hostname") or f"unknown-{mac[-8:]}",
            host_node_id=ap,  # AP is the parent
            status="connected",
            metadata={
                "mac": mac,
                "ip": client.get("ip"),
                "signal_dbm": client.get("signal_dbm"),
                "vendor": client.get("vendor"),
                "band": client.get("band"),
                "hostname": client.get("hostname"),
            },
        ))
    return entities

# In setup(ctx):
ctx.register_discovery_provider(
    name="wifi", roles=["ap"],
    discover_fn=discover_wifi, interval=90,
    entity_types=["wifi_client"], priority=20,
)
```

**Entity linking for WiFi:** The entity linker needs MAC-based matching (in addition to existing name/hostname/IP match). Add to the linker:

```python
# In _link_entity, after IP match (step 4):
# 5. MAC match — for WiFi clients
entity_mac = entity.metadata.get("mac", "").lower()
if entity_mac:
    for n in topo_nodes:
        node_mac = (n.get("mac") or "").lower()
        if node_mac and node_mac == entity_mac:
            entity.linked_node_id = n["id"]
            entity.link_type = "auto"
            return
```

- [ ] Step 1: Implement `discover_wifi()` using refactored ap_scanner
- [ ] Step 2: Add MAC-based matching to entity linker
- [ ] Step 3: Register as discovery provider
- [ ] Step 4: Test — verify WiFi clients appear as SubEntities with correct AP parent
- [ ] Step 5: Verify entity linker matches known devices (phones, laptops, etc.)
- [ ] Step 6: Commit

---

## Task 3: Migrate Auto-Node Creation to Promote Flow

**Files:** `plugins/wifi/plugin.py`, `discovery_engine.py`, `realm_db.py`

**Description:** Currently, ap_scanner creates `_unknown_<mac>` topology nodes directly for unrecognized WiFi clients. Move this to the discovery engine's promote flow — unlinked WiFi SubEntities stay as sub-entities on their AP node. Unknown devices surface in the discovery dashboard for manual review. The `POST /discovery/promote` endpoint (from Phase 1) handles promotion to topology node when the user decides.

**Migration steps:**

1. **Convert existing `_unknown_*` nodes to SubEntities.** Write a one-time migration that:
   - Finds all topology nodes matching `_unknown_*` pattern
   - Creates corresponding WiFi SubEntities from their data (MAC, IP, etc.)
   - Links the SubEntity to the existing topology node (so nothing breaks visually)
   - Logs the migration count

2. **Remove auto-node creation from ap_scanner.** The `_find_or_create_node()` function that creates `_unknown_<mac>` topology nodes is no longer needed — SubEntities handle this.

3. **Add promote UI hint.** When the frontend shows unlinked WiFi SubEntities, include a "Promote to map node" action.

**Key migration code:**

```python
def migrate_unknown_wifi_nodes():
    """One-time migration: convert _unknown_* nodes to WiFi SubEntities."""
    topo = realm_db.get_topology()
    count = 0
    for node in topo.get("nodes", []):
        if not node["id"].startswith("_unknown_"):
            continue
        mac = node.get("mac", node["id"].replace("_unknown_", ""))
        entity = {
            "id": f"wifi:migrated:{mac}",
            "type": "wifi_client",
            "name": node.get("hostname") or node["id"],
            "host_node_id": node.get("ap", "unknown-ap"),
            "status": "connected",
            "metadata": {
                "mac": mac,
                "ip": node.get("ip"),
                "vendor": node.get("vendor"),
                "migrated_from": node["id"],
            },
            "linked_node_id": node["id"],
            "link_type": "auto",
            "provider": "wifi",
        }
        realm_db.upsert_sub_entity(entity)
        count += 1
    log.info("Migrated %d _unknown_* nodes to WiFi SubEntities", count)
```

- [ ] Step 1: Write migration function for `_unknown_*` nodes
- [ ] Step 2: Run migration, verify SubEntities created with correct links
- [ ] Step 3: Remove auto-node creation from ap_scanner
- [ ] Step 4: Verify existing `_unknown_*` nodes still display correctly (via linked SubEntity)
- [ ] Step 5: Commit

---

## Task 4: Migrate Stale Cleanup

**Files:** `plugins/wifi/plugin.py`, `ap_scanner.py`

**Description:** ap_scanner currently does its own stale cleanup — removing WiFi nodes not seen for 7 days. This is now handled by the discovery engine's standard stale entity cleanup (Task 1 of Phase 1 established this: 24h → stale, 7d → deleted, 30d for manual links). Remove the WiFi-specific cleanup code and verify the engine's cleanup covers WiFi SubEntities correctly.

**Key changes:**

- Remove the stale cleanup timer/function from ap_scanner
- Verify `cleanup_stale_sub_entities()` in realm_db handles WiFi entities (it should — same table)
- WiFi SubEntities that go unseen for 24h get marked stale (device left the network)
- After 7 days unseen, they're deleted
- Manually linked WiFi devices (family phones, known laptops) use the 30-day TTL

**Test scenario:**
1. A WiFi client connects → SubEntity created, status "connected"
2. Client disconnects → next scan doesn't find it, `last_seen` stops updating
3. After 24h → engine marks it "stale"
4. After 7d → engine deletes it (unless manually linked)

- [ ] Step 1: Remove stale cleanup code from ap_scanner
- [ ] Step 2: Verify engine stale cleanup handles WiFi SubEntities
- [ ] Step 3: Test the stale lifecycle (can accelerate by temporarily lowering thresholds)
- [ ] Step 4: Commit

---

## What's Next

Phase 7 builds the frontend — Vassals tab in the node detail panel, discovery dashboard panel, and linked node indicators on the map.
