#!/usr/bin/env python3
"""Background AP scanner — detects WiFi client roaming and updates topology connections.

Node identity resolution order:
  1. MAC match — topology node has a "mac" field matching the client MAC
  2. IP match  — DHCP lease IP matches a topology node's "ip" field
When a MAC-matched node's IP has changed, the topology is auto-updated.
Unknown MACs (not matching any node) are tracked in scan results.
"""

import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

TOPOLOGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "topology.json")
SSH_OPTS = ["-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=no"]
GATEKEEPER = "10.0.6.1"
SCAN_INTERVAL = 90  # seconds

# Connection types that represent WiFi links (eligible for roaming updates)
WIFI_CONN_TYPES = {"active"}

_last_scan = {"ts": 0, "ap_clients": {}, "leases": 0, "unknown": []}
_lock = threading.Lock()


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


def _get_ap_clients(ap_ip):
    """Get wireless client MACs from an AP → set of lowercase MACs."""
    raw = _ssh(ap_ip, "for i in $(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1); do iwinfo $i assoclist 2>/dev/null; done")
    return set(re.findall(r'([0-9A-Fa-f:]{17})', raw.lower()))


def _load_topo():
    with open(TOPOLOGY_FILE) as f:
        return json.load(f)


def _save_topo(topo):
    with open(TOPOLOGY_FILE, "w") as f:
        json.dump(topo, f, indent=2)


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
    ap_clients = {}  # ap_node_id → set of MACs

    with ThreadPoolExecutor(max_workers=len(ap_nodes) + 1) as pool:
        lease_future = pool.submit(_get_dhcp_leases)
        ap_futures = {}
        for node_id, ip in ap_nodes.items():
            ap_futures[pool.submit(_get_ap_clients, ip)] = node_id

        leases = lease_future.result()
        for future in as_completed(ap_futures):
            node_id = ap_futures[future]
            ap_clients[node_id] = future.result()

    # Build MAC→AP map
    mac_to_ap = {}
    for ap_id, macs in ap_clients.items():
        for mac in macs:
            mac_to_ap[mac] = ap_id

    # --- Node identity resolution ---
    # Priority 1: MAC field in topology (stable, survives IP changes)
    mac_to_node = {}   # mac → node_id
    node_by_id = {}    # node_id → node dict ref
    for n in topo["nodes"]:
        node_by_id[n["id"]] = n
        node_mac = n.get("mac", "").lower()
        if node_mac:
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

    # --- Auto-update IPs for MAC-matched nodes ---
    ip_updates = []
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

    if changes or ip_updates:
        _save_topo(topo)

    with _lock:
        _last_scan["ts"] = time.time()
        _last_scan["ap_clients"] = {k: len(v) for k, v in ap_clients.items()}
        _last_scan["leases"] = len(leases)
        _last_scan["unknown"] = unknown

    return {
        "scanned": len(ap_nodes),
        "leases": len(leases),
        "changes": changes,
        "ip_updates": ip_updates,
        "unknown": unknown,
    }


def get_last_scan():
    with _lock:
        return dict(_last_scan)


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
                print(f"[AP Scanner] {len(unk)} unknown clients on WiFi")
        except Exception as e:
            print(f"[AP Scanner] Error: {e}")
        time.sleep(SCAN_INTERVAL)


def start_background_scanner():
    """Start the scanner as a daemon thread."""
    t = threading.Thread(target=_scanner_loop, daemon=True)
    t.start()
    print(f"[AP Scanner] Started (interval={SCAN_INTERVAL}s)")
    return t
