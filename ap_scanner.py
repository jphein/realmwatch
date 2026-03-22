#!/usr/bin/env python3
"""Background AP scanner — WiFi roaming, DHCP identity, LLDP ethernet topology.

Runs scan_and_update() every SCAN_INTERVAL seconds (driven by map_server).
Parallel-SSHes to all tower-type nodes in topology to collect iwinfo assoclists
and DHCP leases, then reconciles results against the topology.

Data flow:
  SSH → gatekeeper /tmp/dhcp.leases + `uci show dhcp` (static leases)
  SSH → each AP  `iwinfo <iface> assoclist`   → {mac: signal_data}
  SSH → each AP  `lldpctl -f json`            → LLDP neighbor list (every 7 cycles)
  → identity resolution → roaming detection → unknown node auto-creation
  → realm_db / topology.json write-through → SSE push

Threading:
  scan_and_update() is called from map_server's background scan thread.
  All SSH calls within a scan run in a ThreadPoolExecutor (one worker per AP).
  _last_scan dict is protected by _lock; reference is replaced atomically
  after each scan. _event_callback and _topo_callback are set once at startup.

Configuration:
  SCAN_INTERVAL          = 90    # seconds between full scans
  ETHERNET_DETECT_INTERVAL = 7   # scan cycles between LLDP runs (~10 min)
  OFFLINE_THRESHOLD      = 120   # seconds before a node is declared offline
  SSH_OPTS               = ["-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no"]
  GATEKEEPER             = "10.0.6.1"

Node identity resolution (3 priorities):
  Priority 1 — MAC field  : node has a 'mac' field matching the seen MAC.
               Only trusted if the MAC is currently visible on an AP (prevents
               stale DHCP leases from hijacking identity).
  Priority 2 — IP match   : DHCP lease IP matches a node's 'ip' field.
               Fallback for nodes without a stored MAC.
  Priority 3 — Hostname   : DHCP hostname fuzzy-matches a node ID.
               Handles Android MAC randomization — hostname is stable even as
               the MAC rotates. Auto-updates the node's 'mac' field on match.

Unknown node auto-creation:
  Every MAC seen on WiFi (or in DHCP leases) that doesn't resolve to a topology
  node gets a _unknown_<mac> node created automatically. node_roles.enrich_unknown_node()
  runs the 6-signal pipeline to assign icon, label, role, and persona.
  Nodes persist until manually deleted; offline ones are kept with _last_seen.
  Denied MACs (realm.db scanner.denied_macs) and cluster member MACs are skipped.

LLDP ethernet topology detection (detect_ethernet_topology):
  Run every ETHERNET_DETECT_INTERVAL scan cycles. SSH to each AP, run lldpctl,
  parse neighbor data, match remote names/IPs to topology nodes, deduplicate
  bidirectional links, filter false positives from switch flooding.
  CDP on uplink ports is discarded; LLDP uplink-to-uplink requires bidirectional
  confirmation. Results are used to update 'trunk' connection types.

Public API (imported by map_server):
  scan_and_update()        -> summary dict
  get_last_scan()          -> last scan result dict
  get_wifi_signal()        -> {node_id: {ap, signal, snr, tx_rate, rx_rate}}
  detect_ethernet_topology() -> [{from_node, from_port, to_node, to_port}]
  get_lldp_info(mac, ip, hostname) -> dict

Callbacks (set by map_server at startup):
  _event_callback(evt)    push SSE event (speech/alert/highlight)
  _topo_callback()        push topology refresh to browser
"""

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import realm_db
import node_roles

TOPOLOGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "topology.json")
SSH_OPTS = ["-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no"]
GATEKEEPER = "10.0.6.1"
SCAN_INTERVAL = 90  # seconds

# Connection types that represent WiFi links (eligible for roaming updates)
WIFI_CONN_TYPES = {"active"}
# Connection type for auto-detected ethernet links
ETHERNET_CONN_TYPE = "trunk"
# How often to run ethernet topology detection (in scan cycles, ~90s each)
ETHERNET_DETECT_INTERVAL = 7  # ~every 10 minutes
_ethernet_tick = 0

_last_scan = realm_db.get_wifi_scan() or {"ts": 0, "ap_clients": {}, "leases": 0, "unknown": [], "wifi": {}}
_lock = threading.Lock()
_event_callback = None  # set by map_server to push_event
_topo_callback = None   # set by map_server to push topology via SSE

# Track node online/offline state across scans
_node_online_state = {}  # node_id → {"online": bool, "last_seen": ts, "ap": ap_id}
OFFLINE_THRESHOLD = 300  # 5 minutes without seeing = offline

# Roam debounce: suppress repeat speech events for the same device/AP pair
_last_roam = {}  # node_id → {"from_ap": str, "to_ap": str, "ts": float}
ROAM_DEBOUNCE = 300  # 5 minutes — silence re-announcements for flip-flopping devices

# Evict stale entries from _last_roam and _node_online_state after this long
_DICT_EVICTION_AGE = 86400  # 24 hours
_last_eviction_ts = 0.0

def _evict_stale_dicts():
    """Remove entries older than 24 hours from _last_roam and _node_online_state.
    Called at most once per hour to avoid overhead on every scan cycle."""
    global _last_eviction_ts
    now = time.time()
    if now - _last_eviction_ts < 3600:  # run at most once per hour
        return
    _last_eviction_ts = now
    cutoff = now - _DICT_EVICTION_AGE
    for node_id in list(_last_roam):
        if _last_roam[node_id].get("ts", 0) < cutoff:
            del _last_roam[node_id]
    for node_id in list(_node_online_state):
        if _node_online_state[node_id].get("last_seen", 0) < cutoff:
            del _node_online_state[node_id]


# LLDP neighbor cache for enrichment lookups
_lldp_cache = {"by_mac": {}, "by_ip": {}, "by_name": {}}

# Regex for parsing iwinfo assoclist output
_MAC_RE = re.compile(r'^([0-9A-Fa-f:]{17})\s+(-?\d+)\s+dBm\s*/\s*(-?\d+)\s+dBm\s+\(SNR\s+(\d+)\)', re.MULTILINE)
_RX_RE = re.compile(r'RX:\s+([\d.]+)\s+MBit/s.*?(\d+)\s+Pkts')
_TX_RE = re.compile(r'TX:\s+([\d.]+)\s+MBit/s.*?(\d+)\s+Pkts')


def _get_ssh_pass():
    """Get OpenWrt SSH password from env var or Bitwarden vault."""
    pw = os.environ.get("OPENWRT_SSH_PASS")
    if pw:
        return pw
    try:
        r = subprocess.run(
            ["bw", "get", "password", "gatekeeper-openwrt"],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return ""


def _ssh(host, cmd, timeout=8):
    """Run SSH command, return stdout or empty string on failure."""
    pw = _get_ssh_pass()
    if not pw:
        return ""
    try:
        r = subprocess.run(
            ["sshpass", "-p", pw, "ssh"] + SSH_OPTS + [f"root@{host}", cmd],
            capture_output=True, text=True, timeout=timeout
        )
        return r.stdout if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return ""


def _get_dhcp_leases():
    """Fetch DHCP leases from gatekeeper → {mac: (ip, hostname)}."""
    raw = _ssh(GATEKEEPER, "cat /tmp/dhcp.leases")
    leases = {}
    for line in raw.strip().splitlines():
        parts = line.split()
        if len(parts) >= 4:
            mac = parts[1].lower()
            leases[mac] = (parts[2], parts[3])
    return leases


def _get_static_dhcp_leases():
    """Fetch static DHCP host entries from gatekeeper UCI config.
    Returns {mac: (ip, hostname)} — includes offline devices absent from /tmp/dhcp.leases.
    """
    raw = _ssh(GATEKEEPER, "uci show dhcp 2>/dev/null | grep -E '\\.(mac|ip|name)='")
    if not raw:
        return {}
    entries = {}
    for line in raw.strip().splitlines():
        m = re.match(r'dhcp\.([\w]+)\.(mac|ip|name)=\'(.+?)\'', line)
        if not m:
            continue
        key, field, val = m.group(1), m.group(2), m.group(3)
        entries.setdefault(key, {})[field] = val
    result = {}
    for entry in entries.values():
        mac = entry.get("mac", "").lower()
        ip = entry.get("ip", "")
        name = entry.get("name", "")
        if mac and ip:
            result[mac] = (ip, name or ip)
    return result


def _get_ap_clients_with_signal(ap_ip):
    """Get wireless clients with signal data from an AP.
    Returns: {mac: {signal, noise, snr, tx_rate, rx_rate, tx_pkts, rx_pkts, ssid}}
    """
    # Print SSID marker before each interface's assoclist so we can tag clients
    raw = _ssh(ap_ip,
        "for i in $(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1); do "
        'ssid=$(iwinfo $i info 2>/dev/null | grep ESSID | sed \'s/.*ESSID: "//;s/".*//\');'
        " echo \"__IFACE__ $i $ssid\";"
        " iwinfo $i assoclist 2>/dev/null; done")
    clients = {}
    current_ssid = ""
    last_mac = None
    # Split into lines, track current SSID from __IFACE__ markers
    for line in raw.splitlines():
        if line.startswith("__IFACE__"):
            parts = line.split(None, 2)
            current_ssid = parts[2] if len(parts) > 2 else ""
            last_mac = None
            continue
        mac_m = _MAC_RE.search(line)
        if mac_m:
            mac = mac_m.group(1).lower()
            clients[mac] = {
                "signal": int(mac_m.group(2)),
                "noise": int(mac_m.group(3)),
                "snr": int(mac_m.group(4)),
                "ssid": current_ssid,
            }
            last_mac = mac
        elif last_mac and last_mac in clients:
            # Parse RX/TX from continuation lines
            rx_m = _RX_RE.search(line)
            if rx_m:
                clients[last_mac]["rx_rate"] = float(rx_m.group(1))
                clients[last_mac]["rx_pkts"] = int(rx_m.group(2))
            tx_m = _TX_RE.search(line)
            if tx_m:
                clients[last_mac]["tx_rate"] = float(tx_m.group(1))
                clients[last_mac]["tx_pkts"] = int(tx_m.group(2))
    return clients


def _fire_event(event_type, node_id, text, color=None, **extra):
    """Helper to fire an event via callback."""
    if not _event_callback:
        return
    evt = {"type": event_type, "node": node_id, "text": text}
    if color:
        evt["color"] = color
    evt.update(extra)
    _event_callback(evt)


def _load_topo():
    return realm_db.get_topology()


def _save_topo(topo):
    # Write all nodes in a single transaction, then connections + JSON write-through
    batch = [(node["id"], node) for node in topo.get("nodes", []) if node.get("id")]
    if batch:
        realm_db.set_nodes_batch(batch)
    realm_db.set_connections(topo.get("connections", []))
    realm_db.save_topology_json(TOPOLOGY_FILE)


def _update_tip_ip(node, new_ip):
    """Keep tip stats IP in sync with node IP."""
    tip = node.get("tip")
    if not tip or not isinstance(tip.get("stats"), list):
        return
    for s in tip["stats"]:
        if isinstance(s, list) and len(s) >= 2 and s[0] == "IP":
            s[1] = new_ip
            return


def scan_and_update():
    """Scan all APs, detect roaming, update topology connections. Returns change summary."""
    _evict_stale_dicts()
    topo = _load_topo()

    # Build AP list from topology (tower nodes with IPs that are APs)
    ap_nodes = {}  # node_id → ip
    for n in topo["nodes"]:
        if n.get("type") == "tower" and n.get("ip"):
            ap_nodes[n["id"]] = n["ip"]

    if not ap_nodes:
        return {"scanned": 0, "changes": [], "ip_updates": [], "unknown": []}

    # Parallel scan: DHCP leases + all APs at once
    leases = {}
    ap_clients = {}  # ap_node_id → {mac: {signal data}}

    with ThreadPoolExecutor(max_workers=len(ap_nodes) + 2) as pool:
        lease_future = pool.submit(_get_dhcp_leases)
        static_lease_future = pool.submit(_get_static_dhcp_leases)
        ap_futures = {}
        for node_id, ip in ap_nodes.items():
            ap_futures[pool.submit(_get_ap_clients_with_signal, ip)] = node_id

        leases = lease_future.result()
        # Merge static leases — adds offline devices absent from /tmp/dhcp.leases
        for mac, (ip, hostname) in static_lease_future.result().items():
            if mac not in leases:
                leases[mac] = (ip, hostname)
        for future in as_completed(ap_futures):
            node_id = ap_futures[future]
            ap_clients[node_id] = future.result()

    # Build MAC→AP map — when a device is visible to multiple APs,
    # prefer the one with the strongest signal (avoids non-deterministic
    # flip-flopping from ThreadPool completion order).
    mac_to_ap = {}
    _mac_best_signal = {}
    for ap_id, clients in ap_clients.items():
        for mac, info in clients.items():
            sig = info.get("signal", -100) if isinstance(info, dict) else -100
            if mac not in mac_to_ap or sig > _mac_best_signal.get(mac, -100):
                mac_to_ap[mac] = ap_id
                _mac_best_signal[mac] = sig

    # --- Node identity resolution ---
    # Priority 1: MAC field in topology (stable, survives IP changes)
    # Only trust MACs actually seen on APs — stale DHCP leases with old MACs are ignored
    mac_to_node = {}   # mac → node_id
    node_by_id = {}    # node_id → node dict ref
    for n in topo["nodes"]:
        node_by_id[n["id"]] = n
        node_mac = n.get("mac", "").lower()
        if node_mac:
            # If this MAC is visible on an AP, trust it. If not, skip it
            # so hostname matching (Priority 3) can adopt the new MAC.
            if node_mac in mac_to_ap:
                mac_to_node[node_mac] = n["id"]

    # Priority 2: IP match via DHCP leases (fallback for nodes without mac field)
    ip_to_node = {}
    for n in topo["nodes"]:
        ip = n.get("ip", "")
        if not ip:
            m = re.search(r'(\d+\.\d+\.\d+\.\d+)', n.get("sublabel", ""))
            if m:
                ip = m.group(1)
        if ip:
            ip_to_node[ip] = n["id"]

    for mac, (ip, _hostname) in leases.items():
        if mac not in mac_to_node and ip in ip_to_node:
            mac_to_node[mac] = ip_to_node[ip]

    ip_updates = []

    # Priority 3: Hostname match — if DHCP hostname matches a node ID, auto-adopt the MAC
    # Handles Android MAC randomization: hostname stays stable, MAC rotates
    _hostname_to_node = {}
    for n in topo["nodes"]:
        # Normalize node ID for matching (e.g. "flip3" matches "Jeffrey-s-Z-Flip3")
        _hostname_to_node[n["id"].lower()] = n["id"]
    for mac, (ip, hostname) in leases.items():
        if mac in mac_to_node:
            continue
        if not hostname or hostname == "*":
            continue
        # Normalize hostname: lowercase, strip common prefixes/suffixes
        hn = hostname.lower().replace("-", "").replace("_", "").replace(" ", "")
        for node_key, node_id in _hostname_to_node.items():
            nk = node_key.replace("-", "").replace("_", "")
            if nk in hn or hn in nk:
                node = node_by_id[node_id]
                old_mac = node.get("mac", "")
                if old_mac and old_mac.lower() == mac:
                    break  # already correct
                # Auto-adopt: update the node's MAC to the current one
                node["mac"] = mac
                mac_to_node[mac] = node_id
                # Update IP too if changed
                if node.get("ip") and node["ip"] != ip:
                    old_ip = node["ip"]
                    node["ip"] = ip
                    _update_tip_ip(node, ip)
                    if old_ip in node.get("sublabel", ""):
                        node["sublabel"] = node["sublabel"].replace(old_ip, ip)
                    ip_updates.append({"node": node_id, "old_ip": old_ip, "new_ip": ip})
                if old_mac:
                    print(f"[AP Scanner] MAC rotated: {node_id} {old_mac} → {mac} (hostname match: {hostname})")
                    if _event_callback:
                        _event_callback({
                            "type": "speech",
                            "node": node_id,
                            "text": f"{node.get('label', node_id)} re-identified (MAC rotated).",
                            "color": "rgba(160,200,255,0.6)",
                        })
                break

    # --- Auto-update IPs and persist DHCP hostnames for MAC-matched nodes ---
    for mac, (lease_ip, lease_hostname) in leases.items():
        node_id = mac_to_node.get(mac)
        if not node_id:
            continue
        node = node_by_id.get(node_id)
        if not node:
            continue
        # Only update if this node has a mac field (intentional MAC-based identity)
        if not node.get("mac"):
            continue
        # Persist DHCP hostname on the node (real device identity)
        if lease_hostname and lease_hostname != "*" and node.get("_hostname") != lease_hostname:
            node["_hostname"] = lease_hostname
            realm_db.update_node(node_id, {"_hostname": lease_hostname})
        current_ip = node.get("ip", "")
        if current_ip and current_ip != lease_ip:
            node["ip"] = lease_ip
            _update_tip_ip(node, lease_ip)
            # Update sublabel if it contains the old IP
            if current_ip in node.get("sublabel", ""):
                node["sublabel"] = node["sublabel"].replace(current_ip, lease_ip)
            ip_updates.append({"node": node_id, "old_ip": current_ip, "new_ip": lease_ip})
            # Fire event for IP change
            node_label = node.get("label", node_id)
            _fire_event(
                "speech", node_id,
                f"{node_label} received new address: {lease_ip}",
                color="#c0c0ff",
                old_ip=current_ip, new_ip=lease_ip
            )

    # --- Find current AP connections per node ---
    node_ap_conn = {}  # node_id → (connection_index, current_ap_node_id)
    for i, c in enumerate(topo["connections"]):
        if c.get("type") not in WIFI_CONN_TYPES:
            continue
        from_id, to_id = c["from"], c["to"]
        if to_id in ap_nodes:
            node_ap_conn[from_id] = (i, to_id)
        elif from_id in ap_nodes:
            node_ap_conn[to_id] = (i, from_id)

    # --- Detect roaming ---
    changes = []
    for mac, ap_id in mac_to_ap.items():
        node_id = mac_to_node.get(mac)
        if not node_id:
            continue
        if node_id in node_ap_conn:
            conn_idx, current_ap = node_ap_conn[node_id]
            if current_ap != ap_id:
                conn = topo["connections"][conn_idx]
                old_ap = current_ap
                if conn["to"] in ap_nodes:
                    conn["to"] = ap_id
                else:
                    conn["from"] = ap_id
                changes.append({"node": node_id, "from_ap": old_ap, "to_ap": ap_id})

                # Fire speech event on the device that roamed (debounced)
                node_label = node_by_id.get(node_id, {}).get("label", node_id)
                ap_label = node_by_id.get(ap_id, {}).get("label", ap_id)
                old_ap_label = node_by_id.get(old_ap, {}).get("label", old_ap)
                # Get signal strength if available
                mac = node_by_id.get(node_id, {}).get("mac", "").lower()
                sig_info = ap_clients.get(ap_id, {}).get(mac, {})
                signal = sig_info.get("signal")
                signal_str = f" (signal: {signal} dBm)" if signal else ""
                # Suppress repeat events for flip-flopping devices (same AP pair in either direction)
                now = time.time()
                last = _last_roam.get(node_id, {})
                last_pair = frozenset((last.get("from_ap"), last.get("to_ap")))
                is_bounce = (
                    last_pair == frozenset((old_ap, ap_id))
                    and now - last.get("ts", 0) < ROAM_DEBOUNCE
                )
                _last_roam[node_id] = {"from_ap": old_ap, "to_ap": ap_id, "ts": now}
                if not is_bounce:
                    _fire_event(
                        "speech", node_id,
                        f"Roamed from {old_ap_label} to {ap_label}.{signal_str}",
                        color="#a0d0ff",
                        from_ap=old_ap, to_ap=ap_id, signal=signal
                    )

    # --- Track unknown MACs (on WiFi but not in topology) ---
    unknown = []
    for mac, ap_id in mac_to_ap.items():
        if mac not in mac_to_node:
            lease_info = leases.get(mac)
            unknown.append({
                "mac": mac,
                "ap": ap_id,
                "ip": lease_info[0] if lease_info else None,
                "hostname": lease_info[1] if lease_info else None,
            })

    # --- Auto-create/update unknown nodes on the map ---
    # All unknown MACs get a node (nameless devices use OUI vendor for label).
    # Nodes persist even when offline — only removed manually.
    # Skip MACs absorbed into cluster members + denied MACs (transient devices).
    _skip_macs = set()
    for n in topo["nodes"]:
        for m in n.get("members", []):
            mac_str = m.get("mac", "")
            if mac_str:
                _skip_macs.add(mac_str.lower().replace(":", ""))
    # Load denied MACs list (transient/randomized devices we don't want re-added)
    _denied = realm_db.get_setting("scanner", "denied_macs") or ""
    for mac_str in _denied.split(","):
        mac_str = mac_str.strip().lower().replace(":", "")
        if mac_str:
            _skip_macs.add(mac_str)
    UNKNOWN_BASE_X, UNKNOWN_BASE_Y = 2300, 750  # right side of map
    UNKNOWN_COLS = 6
    existing_auto = {n["id"]: n for n in topo["nodes"] if n.get("_auto")}
    seen_auto = set()
    auto_added = 0
    for i, u in enumerate(unknown):
        hostname = u.get("hostname") or "*"
        mac = u["mac"]
        mac_clean = mac.replace(":", "").lower()
        if mac_clean in _skip_macs:
            continue  # absorbed into a cluster's members
        node_id = f"_unknown_{mac_clean}"
        seen_auto.add(node_id)
        if node_id not in existing_auto:
            col, row = i % UNKNOWN_COLS, i // UNKNOWN_COLS
            x = UNKNOWN_BASE_X + col * 70
            y = UNKNOWN_BASE_Y + row * 50
            # Auto-enrich: role, icon, label, persona from MAC/hostname/OUI
            hn = hostname if hostname != "*" else None
            enriched, persona = node_roles.enrich_unknown_node(
                node_id, mac, hn, u.get("ip"))
            new_node = {
                "id": node_id, "type": "device", "_auto": True,
                "x": x, "y": y,
                "ip": u.get("ip", ""),
                "mac": mac,
                "_last_seen": time.time(),
                **enriched,
            }
            topo["nodes"].append(new_node)
            realm_db.set_node(node_id, new_node)
            if not realm_db.get_persona(node_id):
                realm_db.set_persona(node_id, persona)
            conn = {"from": node_id, "to": u["ap"], "type": "active"}
            topo["connections"].append(conn)
            auto_added += 1
            # Fire alert on the new node itself
            alert_name = hn or "Unknown Traveler"
            _fire_event(
                "alert", node_id,
                f"A new presence emerges: {alert_name} ({u.get('ip', 'no IP')})",
                color="#ffcc00",
                mac=mac, hostname=alert_name, ip=u.get("ip")
            )
        else:
            # Update last-seen timestamp and IP for existing auto-nodes
            existing = existing_auto[node_id]
            existing["_last_seen"] = time.time()
            if u.get("ip") and existing.get("ip") != u["ip"]:
                existing["ip"] = u["ip"]
            realm_db.set_node(node_id, existing)

    if auto_added:
        print(f"[AP Scanner] Added {auto_added} new auto-nodes")

    # --- Auto-create nodes for wired DHCP devices not yet in topology ---
    # Covers cameras, wired switches, servers, etc. that never appear in iwinfo.
    # Static leases (merged above) also catch offline devices like cam3.
    WIRED_BASE_X = UNKNOWN_BASE_X + 500
    wired_added = 0
    wired_idx = 0
    for mac, (ip, hostname) in leases.items():
        if mac in mac_to_node:
            continue  # already resolves to a topology node
        if mac in mac_to_ap:
            continue  # already handled as WiFi unknown above
        mac_clean = mac.replace(":", "").lower()
        if mac_clean in _skip_macs:
            continue
        node_id = f"_unknown_{mac_clean}"
        seen_auto.add(node_id)
        if node_id in existing_auto:
            existing = existing_auto[node_id]
            existing["_last_seen"] = time.time()
            if ip and existing.get("ip") != ip:
                existing["ip"] = ip
            realm_db.set_node(node_id, existing)
        else:
            hn = hostname if hostname and hostname != "*" else None
            enriched, persona = node_roles.enrich_unknown_node(node_id, mac, hn, ip)
            col = wired_idx % UNKNOWN_COLS
            row = wired_idx // UNKNOWN_COLS
            new_node = {
                "id": node_id, "type": "device", "_auto": True,
                "x": WIRED_BASE_X + col * 70,
                "y": UNKNOWN_BASE_Y + row * 50,
                "ip": ip,
                "mac": mac,
                "_last_seen": time.time(),
                "_wired": True,
                **enriched,
            }
            topo["nodes"].append(new_node)
            realm_db.set_node(node_id, new_node)
            if not realm_db.get_persona(node_id):
                realm_db.set_persona(node_id, persona)
            wired_added += 1
            alert_name = hn or "Unknown Wired Device"
            _fire_event(
                "alert", node_id,
                f"Wired presence detected: {alert_name} ({ip})",
                color="#ffcc00",
                mac=mac, hostname=alert_name, ip=ip,
            )
        wired_idx += 1
    if wired_added:
        print(f"[AP Scanner] Added {wired_added} new wired auto-nodes")

    # Events for newly discovered nodes are fired inline during node creation
    # above (inside the `if node_id not in existing_auto` block).

    # --- Enrich existing auto-nodes that lack role/icon data ---
    enriched_count = 0
    for n in topo["nodes"]:
        if not n.get("_auto"):
            continue
        if n.get("_role"):
            continue  # already enriched
        mac = n.get("mac", "")
        if not mac:
            continue
        hostname = n.get("label", "")
        ip = n.get("ip", "")
        enriched, persona = node_roles.enrich_unknown_node(
            n["id"], mac, hostname, ip)
        # Merge enriched data into existing node (preserve position)
        n.update(enriched)
        realm_db.set_node(n["id"], n)
        if not realm_db.get_persona(n["id"]):
            realm_db.set_persona(n["id"], persona)
        enriched_count += 1
    if enriched_count:
        print(f"[AP Scanner] Enriched {enriched_count} existing nodes with role/icon data")

    # --- Build per-node WiFi signal data ---
    wifi = {}  # node_id → {ap, signal, snr, tx_rate, rx_rate}
    now = time.time()
    nodes_seen_this_scan = set()

    for mac, ap_id in mac_to_ap.items():
        node_id = mac_to_node.get(mac)
        if not node_id:
            continue
        nodes_seen_this_scan.add(node_id)
        info = ap_clients.get(ap_id, {}).get(mac, {})
        if info:
            wifi[node_id] = {"ap": ap_id, **info}

    # --- Track online/offline state changes ---
    online_events = []
    offline_events = []

    for node_id in nodes_seen_this_scan:
        prev = _node_online_state.get(node_id)
        node = node_by_id.get(node_id, {})
        node_label = node.get("label", node_id)
        ap_id = mac_to_ap.get(node.get("mac", "").lower())
        ap_label = node_by_id.get(ap_id, {}).get("label", ap_id) if ap_id else "the realm"

        if prev is None or not prev.get("online"):
            # Node just came online (first seen or was offline)
            if prev is not None:
                # Was offline, now back
                offline_duration = now - prev.get("last_seen", now)
                if offline_duration > 60:  # Only announce if was offline > 1 min
                    mins = int(offline_duration / 60)
                    _fire_event(
                        "speech", node_id,
                        f"Returned after {mins}m away.",
                        color="#80ff80"
                    )
                    online_events.append(node_id)

        _node_online_state[node_id] = {"online": True, "last_seen": now, "ap": ap_id}

    # Check for nodes that went offline
    for node_id, state in list(_node_online_state.items()):
        if node_id in nodes_seen_this_scan:
            continue
        if not state.get("online"):
            continue
        # Node was online but not seen this scan
        time_since = now - state.get("last_seen", now)
        if time_since > OFFLINE_THRESHOLD:
            node = node_by_id.get(node_id, {})
            node_label = node.get("label", node_id)
            last_ap = state.get("ap")
            ap_label = node_by_id.get(last_ap, {}).get("label", "unknown") if last_ap else "the realm"
            _fire_event(
                "speech", node_id,
                f"Departed from {ap_label}.",
                color="#ffa080"
            )
            _node_online_state[node_id]["online"] = False
            offline_events.append(node_id)

    if changes or ip_updates or auto_added or wired_added or enriched_count:
        _save_topo(topo)
        # Push topology immediately so browser has new nodes before alert events arrive
        if _topo_callback:
            _topo_callback()

    with _lock:
        _last_scan["ts"] = time.time()
        _last_scan["ap_clients"] = {k: len(v) for k, v in ap_clients.items()}
        _last_scan["leases"] = len(leases)
        _last_scan["unknown"] = unknown
        _last_scan["wifi"] = wifi
    # Persist to DB so data survives restarts
    realm_db.save_wifi_scan(_last_scan)

    return {
        "scanned": len(ap_nodes),
        "leases": len(leases),
        "changes": changes,
        "ip_updates": ip_updates,
        "unknown": unknown,
        "wifi_clients": len(wifi),
    }


def get_last_scan():
    with _lock:
        return dict(_last_scan)


def get_wifi_signal():
    """Get per-node WiFi signal data from last scan."""
    with _lock:
        return dict(_last_scan.get("wifi", {}))


def get_lldp_info(mac=None, ip=None, hostname=None):
    """Look up LLDP neighbor data by MAC, IP, or hostname.

    Returns dict with remote_name, remote_port, seen_by, protocol,
    or empty dict if no match.
    """
    if mac:
        info = _lldp_cache.get("by_mac", {}).get(mac.lower())
        if info:
            return dict(info)
    if ip:
        info = _lldp_cache.get("by_ip", {}).get(ip)
        if info:
            return dict(info)
    if hostname:
        info = _lldp_cache.get("by_name", {}).get(hostname.lower())
        if info:
            return dict(info)
    return {}


# ── Ethernet topology detection via LLDP ──

def _get_lldp_neighbors(ap_ip):
    """Fetch LLDP/CDP neighbors from an AP via lldpctl JSON output.
    Returns list of {local_port, remote_name, remote_port, remote_ip, remote_mac, protocol}.

    lldpctl JSON structure:
      lldp.interface = [{local_port: {via, chassis: {remote_hostname: {id, descr, mgmt-ip}}, port: {descr}}}]
    The chassis dict key IS the remote hostname.
    """
    raw = _ssh(ap_ip, "lldpctl -f json 2>/dev/null", timeout=5)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    neighbors = []
    lldp = data.get("lldp", {})
    ifaces = lldp.get("interface", {})
    # Can be list of single-key dicts or a dict
    if isinstance(ifaces, dict):
        iface_items = list(ifaces.items())
    elif isinstance(ifaces, list):
        iface_items = []
        for entry in ifaces:
            if isinstance(entry, dict):
                iface_items.extend(entry.items())
    else:
        return []

    for local_port, info in iface_items:
        entries = info if isinstance(info, list) else [info]
        for entry in entries:
            chassis = entry.get("chassis", {})
            port = entry.get("port", {})
            via = entry.get("via", "LLDP")

            # Chassis dict key is the remote hostname (e.g., "woodshed", "CPE710")
            remote_name = ""
            remote_mac = ""
            remote_ip = ""
            for hostname, cdata in chassis.items():
                if not isinstance(cdata, dict):
                    continue
                remote_name = hostname
                # MAC from id field
                cid = cdata.get("id", {})
                if isinstance(cid, dict) and cid.get("type") == "mac":
                    remote_mac = cid.get("value", "")
                # Management IP — string or list (may include IPv6)
                mgmt = cdata.get("mgmt-ip", "")
                if isinstance(mgmt, str) and "." in mgmt:
                    remote_ip = mgmt
                elif isinstance(mgmt, list):
                    for m in mgmt:
                        if isinstance(m, str) and "." in m:
                            remote_ip = m
                            break
                break  # only one chassis entry per neighbor

            # Remote port description
            remote_port = ""
            if isinstance(port, dict):
                remote_port = port.get("descr", "")
                if not remote_port:
                    pid = port.get("id", {})
                    if isinstance(pid, dict):
                        remote_port = pid.get("value", "")

            if remote_name:
                neighbors.append({
                    "local_port": local_port,
                    "remote_name": remote_name,
                    "remote_port": remote_port,
                    "remote_ip": remote_ip,
                    "remote_mac": remote_mac,
                    "protocol": via,
                })
    return neighbors


def detect_ethernet_topology():
    """Scan all APs for LLDP neighbors and update trunk connections in topology.
    Returns list of detected links: [{from_node, from_port, to_node, to_port}].
    """
    topo = _load_topo()
    ap_nodes = {}
    node_by_ip = {}
    node_by_name = {}
    for n in topo["nodes"]:
        if n.get("type") == "tower" and n.get("ip"):
            ap_nodes[n["id"]] = n["ip"]
        ip = n.get("ip", "")
        if ip:
            node_by_ip[ip] = n["id"]
        # Index by hostname patterns for matching LLDP SysName
        nid = n["id"].lower()
        node_by_name[nid] = n["id"]
        # Also index without suffixes (e.g., "wrt1900ac-family" → "wrt1900ac")
        for sep in ("-", "_"):
            if sep in nid:
                node_by_name[nid.split(sep)[0]] = n["id"]

    if not ap_nodes:
        return []

    # Parallel LLDP collection from all APs
    all_neighbors = {}  # ap_node_id → [neighbor_dicts]
    with ThreadPoolExecutor(max_workers=len(ap_nodes)) as pool:
        futures = {}
        for node_id, ip in ap_nodes.items():
            futures[pool.submit(_get_lldp_neighbors, ip)] = node_id
        for future in as_completed(futures):
            node_id = futures[future]
            try:
                result = future.result()
                if result:
                    all_neighbors[node_id] = result
            except Exception:
                pass

    if not all_neighbors:
        return []

    # Cache LLDP data for enrichment lookups
    by_mac = {}
    by_ip = {}
    by_name = {}
    for ap_id, neighbors in all_neighbors.items():
        for nb in neighbors:
            info = {
                "seen_by": ap_id,
                "local_port": nb["local_port"],
                "remote_name": nb["remote_name"],
                "remote_port": nb["remote_port"],
                "remote_ip": nb["remote_ip"],
                "remote_mac": nb["remote_mac"],
                "protocol": nb["protocol"],
            }
            if nb["remote_mac"]:
                by_mac[nb["remote_mac"].lower()] = info
            if nb["remote_ip"]:
                by_ip[nb["remote_ip"]] = info
            if nb["remote_name"]:
                by_name[nb["remote_name"].lower()] = info
    _lldp_cache["by_mac"] = by_mac
    _lldp_cache["by_ip"] = by_ip
    _lldp_cache["by_name"] = by_name

    # Build detected links (deduplicated)
    detected = []  # {from_node, from_port, to_node, to_port, protocol}
    seen_pairs = set()

    for ap_id, neighbors in all_neighbors.items():
        for nb in neighbors:
            # Resolve remote to a known node.
            # Name match runs first for CDPv1 (CDP system-name is reliable hostname;
            # the CDP management IP may be from any VLAN and can collide with client IPs).
            # IP match runs first for LLDP (LLDP chassis-ID is often a MAC, not hostname).
            remote_node = None
            rname = nb["remote_name"].lower().strip() if nb["remote_name"] else ""

            def _name_match(rname):
                if not rname or len(rname) < 3:  # skip short/empty names ("id", etc.)
                    return None
                if rname in node_by_name:
                    return node_by_name[rname]
                # Fuzzy: require minimum length and both strings must be substantial
                for pattern, nid in node_by_name.items():
                    if len(pattern) >= 4 and (pattern in rname or rname in pattern):
                        return nid
                return None

            if nb["protocol"] != "LLDP":
                # CDPv1: name first, then IP as fallback
                remote_node = _name_match(rname)
                if not remote_node and nb["remote_ip"] and nb["remote_ip"] in node_by_ip:
                    remote_node = node_by_ip[nb["remote_ip"]]
            else:
                # LLDP: IP first (chassis-ID may be MAC not name), then name
                if nb["remote_ip"] and nb["remote_ip"] in node_by_ip:
                    remote_node = node_by_ip[nb["remote_ip"]]
                if not remote_node:
                    remote_node = _name_match(rname)

            if not remote_node or remote_node == ap_id:
                continue

            # Deduplicate (A→B == B→A)
            pair = tuple(sorted([ap_id, remote_node]))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)

            detected.append({
                "from_node": ap_id,
                "from_port": nb["local_port"],
                "to_node": remote_node,
                "to_port": nb["remote_port"],
                "protocol": nb["protocol"],
            })

    if not detected:
        return []

    pre_filter_detected = list(detected)  # save before reliable filter (for clique detection)

    # Filter out false direct-connection links caused by switches forwarding
    # L2 discovery frames.  Rules:
    #  - Non-uplink local port (lan1-8, etc.) = direct wired connection → always keep.
    #  - CDP on an uplink port = switch-broadcast, unreliable → skip.
    #  - LLDP uplink-to-uplink: keep only if we see it bidirectionally (both ends report
    #    the same pair), which proves it is a direct cable, not switch flooding.
    UPLINK_PORTS = {"wan", "eth0", "eth1", "br0"}
    # Build bidirectional LLDP pairs for uplink-to-uplink validation
    lldp_uplink_pairs = set()
    for link in detected:
        if link["protocol"] == "LLDP":
            from_up = link["from_port"] in UPLINK_PORTS
            to_up = link["to_port"] in UPLINK_PORTS
            if from_up and to_up:
                lldp_uplink_pairs.add(tuple(sorted([link["from_node"], link["to_node"]])))
    reliable = []
    for link in detected:
        from_is_uplink = link["from_port"] in UPLINK_PORTS
        to_is_uplink = link["to_port"] in UPLINK_PORTS
        if not from_is_uplink:
            # Non-uplink local port → definite direct connection
            reliable.append(link)
        elif link["protocol"] != "LLDP":
            # CDP on an uplink = switch-broadcast, skip
            continue
        elif from_is_uplink and to_is_uplink:
            # LLDP uplink↔uplink: keep only if seen bidirectionally
            pair = tuple(sorted([link["from_node"], link["to_node"]]))
            if pair in lldp_uplink_pairs:
                reliable.append(link)
        else:
            # LLDP, from is uplink but to is not — keep
            reliable.append(link)
    # Deduplicate after bidirectional expansion
    seen_reliable = set()
    deduped = []
    for link in reliable:
        pair = tuple(sorted([link["from_node"], link["to_node"]]))
        if pair not in seen_reliable:
            seen_reliable.add(pair)
            deduped.append(link)
    detected = deduped

    if not detected:
        return []

    # Update topology: remove old auto-detected trunk connections, add new ones
    existing_conns = topo.get("connections", [])
    # Keep all non-LLDP connections
    kept = [c for c in existing_conns if not c.get("_lldp")]

    # Build a map of node → set of neighbours in existing (manual) topology
    # so we can skip auto-detected links between nodes that already share a
    # common switch parent (unmanaged switches forward LLDP, making all ports
    # appear directly connected even when they're not).
    manual_neighbours = {}
    for c in kept:
        manual_neighbours.setdefault(c["from"], set()).add(c["to"])
        manual_neighbours.setdefault(c["to"], set()).add(c["from"])

    def _share_common_parent(a, b):
        return bool(manual_neighbours.get(a, set()) & manual_neighbours.get(b, set()))

    # Add detected links (skip pairs that already share a common switch parent)
    for link in detected:
        a, b = link["from_node"], link["to_node"]
        if _share_common_parent(a, b):
            print(f"[AP Scanner] LLDP: skipping {a}↔{b} (share common parent — unmanaged switch)")
            continue
        label = f"{link['from_port']}↔{link['to_port']}" if link["from_port"] and link["to_port"] else ""
        kept.append({
            "from": a,
            "to": b,
            "type": ETHERNET_CONN_TYPE,
            "label": label,
            "_lldp": True,
        })

    # ── Unmanaged switch clique detection ──
    # When 3+ nodes all see each other in the pre-filter LLDP/CDP data (full clique),
    # but share no existing direct topology connections or common parents, an unmanaged
    # switch is bridging them.  Auto-create a synthetic infra node to represent it.
    if len(pre_filter_detected) >= 3:
        clique_adj = {}
        for link in pre_filter_detected:
            a, b = link["from_node"], link["to_node"]
            clique_adj.setdefault(a, set()).add(b)
            clique_adj.setdefault(b, set()).add(a)

        def _find_cliques_bk():
            """Bron-Kerbosch: returns all maximal cliques of size >= 3."""
            cliques_found = []
            def _bk(R, P, X):
                if not P and not X:
                    if len(R) >= 3:
                        cliques_found.append(frozenset(R))
                    return
                if not P:
                    return
                u = max(P | X, key=lambda v: len(clique_adj.get(v, set()) & P))
                for v in P - clique_adj.get(u, set()):
                    _bk(R | {v}, P & clique_adj.get(v, set()), X & clique_adj.get(v, set()))
                    P = P - {v}
                    X = X | {v}
            _bk(set(), set(clique_adj.keys()), set())
            return cliques_found

        existing_direct = {tuple(sorted([c["from"], c["to"]])) for c in kept}
        node_pos = {n["id"]: (n.get("x", 0), n.get("y", 0)) for n in topo["nodes"]}

        for clique in _find_cliques_bk():
            members = sorted(clique)
            pairs = [tuple(sorted([members[i], members[j]]))
                     for i in range(len(members))
                     for j in range(i + 1, len(members))]
            # Skip if any pair is already directly wired
            if any(p in existing_direct for p in pairs):
                continue
            # Skip if any pair shares a common parent (already-known switch)
            if any(_share_common_parent(p[0], p[1]) for p in pairs):
                continue
            sw_id = f"_auto_switch_{hashlib.md5(','.join(members).encode()).hexdigest()[:8]}"
            if not any(n["id"] == sw_id for n in topo["nodes"]):
                avg_x = int(sum(node_pos.get(m, (0, 0))[0] for m in members) / len(members))
                avg_y = int(sum(node_pos.get(m, (0, 0))[1] for m in members) / len(members))
                sw_node = {
                    "id": sw_id,
                    "label": "Unmanaged Switch",
                    "type": "infra",
                    "x": avg_x,
                    "y": avg_y,
                    "_auto_switch": True,
                }
                topo["nodes"].append(sw_node)
                realm_db.set_node(sw_id, sw_node)
                print(f"[AP Scanner] LLDP clique: new unmanaged switch {sw_id} → {members}")
            for m in members:
                p = tuple(sorted([m, sw_id]))
                if p not in existing_direct:
                    kept.append({
                        "from": m,
                        "to": sw_id,
                        "type": ETHERNET_CONN_TYPE,
                        "_lldp": True,
                        "_auto_switch": sw_id,
                    })
                    existing_direct.add(p)

    realm_db.set_connections(kept)
    realm_db.save_topology_json(TOPOLOGY_FILE)
    print(f"[AP Scanner] LLDP: detected {len(detected)} ethernet links")
    for link in detected:
        print(f"  {link['from_node']}:{link['from_port']} ↔ {link['to_node']}:{link['to_port']} ({link['protocol']})")

    return detected


def _scanner_loop():
    """Background loop — runs scan_and_update every SCAN_INTERVAL seconds."""
    global _ethernet_tick
    while True:
        try:
            result = scan_and_update()
            for ch in result.get("changes", []):
                print(f"[AP Scanner] {ch['node']} roamed: {ch['from_ap']} → {ch['to_ap']}")
            for u in result.get("ip_updates", []):
                print(f"[AP Scanner] {u['node']} IP changed: {u['old_ip']} → {u['new_ip']}")
            unk = result.get("unknown", [])
            if unk:
                print(f"[AP Scanner] {len(unk)} unknown clients, {result.get('wifi_clients', 0)} with signal data")

            # Ethernet topology via LLDP — less frequent
            _ethernet_tick += 1
            if _ethernet_tick % ETHERNET_DETECT_INTERVAL == 1:  # first scan + every ~10min
                try:
                    detect_ethernet_topology()
                except Exception as e:
                    print(f"[AP Scanner] LLDP error: {e}")

        except Exception as e:
            import traceback
            print(f"[AP Scanner] Error: {e}")
            traceback.print_exc()
        time.sleep(SCAN_INTERVAL)


# ── WiFi AP Info (SSIDs + VLANs) ──
_ap_info_cache = {"ts": 0, "aps": {}}
AP_INFO_TTL = 120  # seconds

def _get_ap_ssids(ap_ip):
    """Get SSIDs and their network/VLAN from an AP via iwinfo + uci."""
    # iwinfo gives us: interface → ESSID, channel, mode
    raw = _ssh(ap_ip, "iwinfo 2>/dev/null | grep -E 'ESSID|Channel|Mode'")
    # uci gives us: interface → network zone (maps to VLAN)
    uci_raw = _ssh(ap_ip, "for i in $(uci show wireless 2>/dev/null | grep '.device=' | sed 's/.*\\[//;s/\\].*//' | sort -u); do "
                          "ssid=$(uci -q get wireless.@wifi-iface[$i].ssid); "
                          "net=$(uci -q get wireless.@wifi-iface[$i].network); "
                          "disabled=$(uci -q get wireless.@wifi-iface[$i].disabled); "
                          "echo \"idx=$i ssid=$ssid network=$net disabled=$disabled\"; "
                          "done")
    ssids = []
    # Parse uci output (more reliable for SSID→network mapping)
    for line in uci_raw.strip().splitlines():
        parts = dict(p.split("=", 1) for p in line.split() if "=" in p)
        if parts.get("disabled") == "1":
            continue
        ssid = parts.get("ssid", "")
        network = parts.get("network", "")
        if ssid:
            ssids.append({"ssid": ssid, "network": network})
    # Fallback: parse iwinfo if uci gave nothing
    if not ssids and raw:
        for line in raw.strip().splitlines():
            m = re.search(r'ESSID:\s+"(.+?)"', line)
            if m:
                ssids.append({"ssid": m.group(1), "network": ""})
    return ssids


# VLAN zone→number mapping (matches firewall_parser)
_ZONE_VLAN = {"admin": 6, "lan": 10, "iot": 8, "family": 11, "guest": 11, "wan": 0}

def get_ap_info():
    """Return AP info with SSIDs and VLANs. Cached for AP_INFO_TTL seconds."""
    now = time.time()
    if now - _ap_info_cache["ts"] < AP_INFO_TTL and _ap_info_cache["aps"]:
        return _ap_info_cache["aps"]

    topo = _load_topo()
    ap_nodes = {}
    for n in topo["nodes"]:
        if n.get("type") == "tower" and n.get("ip"):
            ap_nodes[n["id"]] = {"ip": n["ip"], "label": n.get("label", n["id"])}

    if not ap_nodes:
        return {}

    # Parallel SSH to all APs for SSID info
    results = {}
    with ThreadPoolExecutor(max_workers=len(ap_nodes)) as pool:
        futures = {}
        for node_id, info in ap_nodes.items():
            futures[pool.submit(_get_ap_ssids, info["ip"])] = node_id
        for future in as_completed(futures):
            node_id = futures[future]
            try:
                ssid_list = future.result()
            except Exception:
                ssid_list = []
            # Resolve network names to VLAN numbers
            for s in ssid_list:
                net = s.get("network", "").lower()
                s["vlan"] = _ZONE_VLAN.get(net, None)
            info = ap_nodes[node_id]
            # Get client count from last scan
            cc = _last_scan.get("ap_clients", {}).get(node_id, 0)
            client_count = cc if isinstance(cc, int) else len(cc)
            results[node_id] = {
                "label": info["label"],
                "ip": info["ip"],
                "ssids": ssid_list,
                "clients": client_count,
            }

    _ap_info_cache["ts"] = now
    _ap_info_cache["aps"] = results
    return results


def start_background_scanner():
    """Start the scanner as a daemon thread."""
    t = threading.Thread(target=_scanner_loop, daemon=True)
    t.start()
    print(f"[AP Scanner] Started (interval={SCAN_INTERVAL}s)")
    return t
