#!/usr/bin/env python3
"""Background AP scanner — detects WiFi client roaming and updates topology connections.

Node identity resolution order:
  1. MAC match — topology node has a "mac" field matching the client MAC
  2. IP match  — DHCP lease IP matches a topology node's "ip" field
When a MAC-matched node's IP has changed, the topology is auto-updated.
Unknown MACs (not matching any node) are tracked in scan results.

WiFi signal data (dBm, SNR, TX/RX rates) is collected per-client and
stored in memory for the map server — no collectd exec plugin needed.
"""

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

_last_scan = realm_db.get_wifi_scan() or {"ts": 0, "ap_clients": {}, "leases": 0, "unknown": [], "wifi": {}}
_lock = threading.Lock()
_event_callback = None  # set by map_server to push_event

# Track node online/offline state across scans
_node_online_state = {}  # node_id → {"online": bool, "last_seen": ts, "ap": ap_id}
OFFLINE_THRESHOLD = 300  # 5 minutes without seeing = offline

# Regex for parsing iwinfo assoclist output
_MAC_RE = re.compile(r'^([0-9A-Fa-f:]{17})\s+(-?\d+)\s+dBm\s*/\s*(-?\d+)\s+dBm\s+\(SNR\s+(\d+)\)', re.MULTILINE)
_RX_RE = re.compile(r'RX:\s+([\d.]+)\s+MBit/s.*?(\d+)\s+Pkts')
_TX_RE = re.compile(r'TX:\s+([\d.]+)\s+MBit/s.*?(\d+)\s+Pkts')


def _ssh(host, cmd, timeout=8):
    """Run SSH command, return stdout or empty string on failure."""
    try:
        r = subprocess.run(
            ["sshpass", "-p", "<REDACTED-WIFI-PSK>", "ssh"] + SSH_OPTS + [f"root@{host}", cmd],
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


def _get_ap_clients_with_signal(ap_ip):
    """Get wireless clients with signal data from an AP.
    Returns: {mac: {signal, noise, snr, tx_rate, rx_rate, tx_pkts, rx_pkts}}
    """
    raw = _ssh(ap_ip, "for i in $(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1); do iwinfo $i assoclist 2>/dev/null; done")
    clients = {}
    # Split into per-client blocks (each starts with a MAC line)
    blocks = re.split(r'(?=^[0-9A-Fa-f]{2}:)', raw, flags=re.MULTILINE)
    for block in blocks:
        if not block.strip():
            continue
        mac_m = _MAC_RE.search(block)
        if not mac_m:
            # Try simpler MAC extraction for partial matches
            simple = re.match(r'^([0-9A-Fa-f:]{17})', block)
            if simple:
                clients[simple.group(1).lower()] = {}
            continue
        mac = mac_m.group(1).lower()
        info = {
            "signal": int(mac_m.group(2)),
            "noise": int(mac_m.group(3)),
            "snr": int(mac_m.group(4)),
        }
        rx_m = _RX_RE.search(block)
        if rx_m:
            info["rx_rate"] = float(rx_m.group(1))
            info["rx_pkts"] = int(rx_m.group(2))
        tx_m = _TX_RE.search(block)
        if tx_m:
            info["tx_rate"] = float(tx_m.group(1))
            info["tx_pkts"] = int(tx_m.group(2))
        clients[mac] = info
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
    # Write individual nodes/connections to DB + write-through to JSON
    for node in topo.get("nodes", []):
        nid = node.get("id", "")
        if nid:
            realm_db.set_node(nid, node)
    realm_db.set_connections(topo.get("connections", []))
    realm_db.save_topology_json(TOPOLOGY_FILE)


def scan_and_update():
    """Scan all APs, detect roaming, update topology connections. Returns change summary."""
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

    with ThreadPoolExecutor(max_workers=len(ap_nodes) + 1) as pool:
        lease_future = pool.submit(_get_dhcp_leases)
        ap_futures = {}
        for node_id, ip in ap_nodes.items():
            ap_futures[pool.submit(_get_ap_clients_with_signal, ip)] = node_id

        leases = lease_future.result()
        for future in as_completed(ap_futures):
            node_id = ap_futures[future]
            ap_clients[node_id] = future.result()

    # Build MAC→AP map
    mac_to_ap = {}
    for ap_id, clients in ap_clients.items():
        for mac in clients:
            mac_to_ap[mac] = ap_id

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

    # --- Auto-update IPs for MAC-matched nodes ---
    for mac, (lease_ip, _hostname) in leases.items():
        node_id = mac_to_node.get(mac)
        if not node_id:
            continue
        node = node_by_id.get(node_id)
        if not node:
            continue
        # Only update if this node has a mac field (intentional MAC-based identity)
        if not node.get("mac"):
            continue
        current_ip = node.get("ip", "")
        if current_ip and current_ip != lease_ip:
            node["ip"] = lease_ip
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

                # Fire speech event on the receiving AP with signal info
                node_label = node_by_id.get(node_id, {}).get("label", node_id)
                ap_label = node_by_id.get(ap_id, {}).get("label", ap_id)
                old_ap_label = node_by_id.get(old_ap, {}).get("label", old_ap)
                # Get signal strength if available
                mac = node_by_id.get(node_id, {}).get("mac", "").lower()
                sig_info = ap_clients.get(ap_id, {}).get(mac, {})
                signal = sig_info.get("signal")
                signal_str = f" (signal: {signal} dBm)" if signal else ""
                _fire_event(
                    "speech", ap_id,
                    f"{node_label} roamed from {old_ap_label} to {ap_label}.{signal_str}",
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
    UNKNOWN_BASE_X, UNKNOWN_BASE_Y = 2300, 750  # right side of map
    UNKNOWN_COLS = 6
    existing_auto = {n["id"]: n for n in topo["nodes"] if n.get("_auto")}
    seen_auto = set()
    auto_added = 0
    for i, u in enumerate(unknown):
        hostname = u.get("hostname") or "*"
        mac = u["mac"]
        node_id = f"_unknown_{mac.replace(':', '')}"
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
        else:
            # Update last-seen timestamp and IP for existing auto-nodes
            existing = existing_auto[node_id]
            existing["_last_seen"] = time.time()
            if u.get("ip") and existing.get("ip") != u["ip"]:
                existing["ip"] = u["ip"]
            realm_db.set_node(node_id, existing)

    if auto_added:
        print(f"[AP Scanner] Added {auto_added} new auto-nodes")

    # --- Fire events for newly discovered nodes ---
    for i, u in enumerate(unknown):
        mac = u["mac"]
        node_id = f"_unknown_{mac.replace(':', '')}"
        if node_id not in existing_auto:
            # This is a brand new device!
            ap_label = node_by_id.get(u["ap"], {}).get("label", u["ap"])
            hostname = u.get("hostname") or "Unknown Traveler"
            if hostname == "*":
                hostname = "Unknown Traveler"
            _fire_event(
                "alert", u["ap"],
                f"A new presence emerges: {hostname} ({u.get('ip', 'no IP')})",
                color="#ffcc00",
                mac=mac, hostname=hostname, ip=u.get("ip")
            )

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
                        "speech", ap_id or node_id,
                        f"{node_label} has returned after {mins}m away.",
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
                "speech", last_ap or "gatekeeper",
                f"{node_label} has departed from {ap_label}.",
                color="#ffa080"
            )
            _node_online_state[node_id]["online"] = False
            offline_events.append(node_id)

    if changes or ip_updates or auto_added or enriched_count:
        _save_topo(topo)

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


def _scanner_loop():
    """Background loop — runs scan_and_update every SCAN_INTERVAL seconds."""
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
        except Exception as e:
            print(f"[AP Scanner] Error: {e}")
        time.sleep(SCAN_INTERVAL)


def start_background_scanner():
    """Start the scanner as a daemon thread."""
    t = threading.Thread(target=_scanner_loop, daemon=True)
    t.start()
    print(f"[AP Scanner] Started (interval={SCAN_INTERVAL}s)")
    return t
