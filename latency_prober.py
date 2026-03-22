"""Background latency prober — batch-pings wired node IPs from katana.

Runs fping against all wired topology nodes every PROBE_INTERVAL seconds and
produces a {node_id: rtt_ms} map consumed by the map server and SSE broker.
WiFi nodes are excluded (their latency is estimated from SNR data instead).
Falls back to sequential ping if fping is not installed.

Data flow:
  topology.json (IPs) → fping batch probe → {ip: rtt_ms}
  → {node_id: rtt_ms}  [atomic reference swap]
  → get_latency_map() / get_latency_grouped() / estimate_latency()

Threading:
  _probe_loop() runs in a daemon thread started by start().
  _latency_map is replaced atomically (dict reference swap) — no lock needed
  for reads; writes happen only in the probe thread.

Configuration:
  _PROBE_INTERVAL  = 30    # seconds between probe rounds
  _FPING_TIMEOUT   = 500   # ms per-host timeout for fping

WiFi exclusion:
  set_wifi_nodes(wifi_dict) is called by sse_broker to keep the WiFi node set
  current so they are skipped from fping probing.

Latency estimation (estimate_latency):
  Both WiFi same AP   →  10 ms
  Both WiFi diff APs  →  25 ms
  One WiFi            →  SNR-based wifi_ms + wired RTT
  Both wired same /24 →  max(rtt_a, rtt_b)   (same switch)
  Both wired cross-subnet → rtt_a + rtt_b

Public API (imported by map_server, sse_broker):
  start()                           # start background probe thread
  stop()                            # signal thread to exit
  set_wifi_nodes(wifi_dict)         # update WiFi exclusion set
  get_latency_map()                 -> {node_id: rtt_ms}
  get_latency_grouped(topo_nodes)   -> {summary, groups}
  estimate_latency(a, b, wifi_map)  -> float | None
  get_subnet(node_id)               -> int | None
"""

import json
import os
import re
import subprocess
import threading
import time

_TOPOLOGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "topology.json")
_FPING_TIMEOUT = 500  # ms
_PROBE_INTERVAL = 30  # seconds

# Module-level state (thread-safe via reference replacement)
_latency_map = {}      # {node_id: rtt_ms}
_ip_to_node = {}       # {ip: node_id}
_node_to_ip = {}       # {node_id: ip}
_wired_ips = []        # list of IPs to probe (excludes WiFi)
_running = False
_wifi_nodes = set()    # updated externally via set_wifi_nodes()


def set_wifi_nodes(wifi_dict):
    """Called by map_server/sse_broker to update the set of WiFi node IDs.
    wifi_dict: {hostname: {ap, signal, snr, ...}} from status.wifi
    """
    global _wifi_nodes
    _wifi_nodes = set(wifi_dict.keys()) if wifi_dict else set()


def _load_topology():
    """Load node IPs from topology.json, filtering out WiFi clients."""
    global _ip_to_node, _node_to_ip, _wired_ips
    try:
        with open(_TOPOLOGY_FILE) as f:
            topo = json.load(f)
        ip_map = {}
        node_map = {}
        for n in topo.get("nodes", []):
            ip = n.get("ip")
            nid = n["id"]
            if not ip or ip.endswith(".x"):
                continue
            # Skip WiFi clients
            if nid in _wifi_nodes:
                continue
            ip_map[ip] = nid
            node_map[nid] = ip
        _ip_to_node = ip_map
        _node_to_ip = node_map
        _wired_ips = list(ip_map.keys())
    except Exception as e:
        print(f"latency_prober: topology load error: {e}", flush=True)


def _probe_fping():
    """Run fping against all wired IPs, return {ip: rtt_ms}."""
    if not _wired_ips:
        return {}
    try:
        result = subprocess.run(
            ["fping", "-c1", "-t", str(_FPING_TIMEOUT), "-q"] + _wired_ips,
            capture_output=True, text=True, timeout=10
        )
        # fping outputs to stderr: "10.0.6.1 : xmt/rcv/%loss = 1/1/0%, min/avg/max = 0.12/0.12/0.12"
        latencies = {}
        for line in result.stderr.splitlines():
            m = re.match(r'^(\S+)\s+:.*min/avg/max\s*=\s*[\d.]+/([\d.]+)/[\d.]+', line)
            if m:
                latencies[m.group(1)] = round(float(m.group(2)), 2)
        return latencies
    except FileNotFoundError:
        return _probe_ping_fallback()
    except (subprocess.TimeoutExpired, OSError):
        return {}


def _probe_ping_fallback():
    """Sequential ping fallback if fping is not installed."""
    latencies = {}
    for ip in _wired_ips[:30]:  # cap at 30 to avoid taking forever
        try:
            result = subprocess.run(
                ["ping", "-c", "1", "-W", "1", ip],
                capture_output=True, text=True, timeout=3
            )
            for line in result.stdout.splitlines():
                m = re.search(r'time[=<]([\d.]+)', line)
                if m:
                    latencies[ip] = round(float(m.group(1)), 2)
                    break
        except (subprocess.TimeoutExpired, OSError):
            pass
    return latencies


_last_probe_ts = 0.0  # epoch of last successful probe (for health checks)


def _probe_loop():
    """Background thread: reload topology + probe every PROBE_INTERVAL seconds."""
    global _latency_map, _last_probe_ts
    while _running:
        try:
            _load_topology()
            ip_latencies = _probe_fping()
            # Convert {ip: rtt} → {node_id: rtt}
            new_map = {}
            for ip, rtt in ip_latencies.items():
                nid = _ip_to_node.get(ip)
                if nid:
                    new_map[nid] = rtt
            _latency_map = new_map  # atomic reference swap
            _last_probe_ts = time.time()
        except Exception as e:
            print(f"latency_prober: probe error: {e}", flush=True)
        time.sleep(_PROBE_INTERVAL)


def get_latency_map():
    """Return current {node_id: rtt_ms} map. Thread-safe (reads atomic reference)."""
    return _latency_map


def get_last_probe_ts():
    """Return epoch timestamp of last successful probe, or 0 if never probed."""
    return _last_probe_ts


def get_latency_grouped(topo_nodes=None):
    """Return pre-sorted, pre-grouped latency data for the client.

    Returns {summary: {count, avg, max}, groups: [{name, entries: [{id, rtt, label, icon, hue, pct}]}]}
    Eliminates client-side sort, VLAN grouping, and hue calculation.
    """
    lmap = _latency_map
    if not lmap:
        return None

    # Build node lookup from topology
    node_info = {}
    if topo_nodes:
        for n in topo_nodes:
            node_info[n["id"]] = {"label": n.get("label", n["id"]), "icon": n.get("icon", "?"), "ip": n.get("ip", "")}

    # Sort all entries by RTT
    sorted_entries = sorted(lmap.items(), key=lambda x: x[1])
    max_rtt = sorted_entries[-1][1] if sorted_entries else 1
    avg_rtt = sum(v for _, v in sorted_entries) / len(sorted_entries)

    # Group by VLAN
    vlan_groups = {}
    ts_entries = []
    other_entries = []

    for nid, rtt in sorted_entries:
        info = node_info.get(nid, {"label": nid, "icon": "?", "ip": ""})
        ip = info.get("ip") or _node_to_ip.get(nid, "")
        hue = max(0, 120 - rtt * 4)  # green→red
        pct = min(rtt / max(max_rtt, 0.01) * 100, 100)
        entry = {"id": nid, "rtt": rtt, "label": info["label"], "icon": info["icon"],
                 "hue": round(hue, 1), "pct": round(pct, 1)}

        if nid.startswith("ts-"):
            ts_entries.append(entry)
        elif ip:
            parts = ip.split(".")
            if len(parts) == 4:
                vlan = int(parts[2])
                vlan_groups.setdefault(vlan, []).append(entry)
            else:
                other_entries.append(entry)
        else:
            other_entries.append(entry)

    VLAN_NAMES = {6: "The Citadel", 8: "Guest Marches", 10: "Enchanted Quarters", 11: "Family Hearth"}
    VLAN_ORDER = [6, 8, 10, 11]

    groups = []
    for vlan in VLAN_ORDER:
        if vlan in vlan_groups:
            groups.append({"name": VLAN_NAMES.get(vlan, f"VLAN {vlan}"), "entries": vlan_groups[vlan]})
    for vlan in sorted(vlan_groups.keys()):
        if vlan not in VLAN_ORDER:
            groups.append({"name": f"VLAN {vlan}", "entries": vlan_groups[vlan]})
    if ts_entries:
        groups.append({"name": "Tailscale", "entries": ts_entries})
    if other_entries:
        groups.append({"name": "Other", "entries": other_entries})

    return {
        "summary": {"count": len(sorted_entries), "avg": round(avg_rtt, 1), "max": round(max_rtt, 1)},
        "groups": groups,
    }


def get_subnet(node_id):
    """Return VLAN number from node IP (3rd octet), or None."""
    ip = _node_to_ip.get(node_id)
    if not ip:
        return None
    parts = ip.split(".")
    if len(parts) == 4:
        return int(parts[2])
    return None


def estimate_latency(a, b, wifi_map=None):
    """Estimate latency between two nodes in ms.

    Uses measured RTT from katana as base, with heuristics for
    same-subnet, cross-subnet, and WiFi nodes.
    """
    rtt_a = _latency_map.get(a)
    rtt_b = _latency_map.get(b)
    wifi_map = wifi_map or {}

    a_wifi = a in _wifi_nodes or a in wifi_map
    b_wifi = b in _wifi_nodes or b in wifi_map

    # Both WiFi on same AP
    if a_wifi and b_wifi:
        ap_a = wifi_map.get(a, {}).get("ap")
        ap_b = wifi_map.get(b, {}).get("ap")
        if ap_a and ap_a == ap_b:
            return 10.0
        return 25.0  # different APs

    # One WiFi: use SNR-based estimate
    if a_wifi or b_wifi:
        wifi_node = a if a_wifi else b
        wired_rtt = rtt_b if a_wifi else rtt_a
        snr = wifi_map.get(wifi_node, {}).get("snr", 30)
        wifi_ms = max(5, min(40, 5 + (60 - snr) * 0.5))
        return wifi_ms + (wired_rtt or 0.5)

    # Both wired
    if rtt_a is None and rtt_b is None:
        return None  # no data
    if rtt_a is None:
        return rtt_b
    if rtt_b is None:
        return rtt_a

    sub_a = get_subnet(a)
    sub_b = get_subnet(b)
    if sub_a and sub_b and sub_a == sub_b:
        return max(rtt_a, rtt_b)  # same switch
    return rtt_a + rtt_b  # cross-subnet


def start():
    """Start the background probing thread."""
    global _running
    if _running:
        return
    _running = True
    t = threading.Thread(target=_probe_loop, daemon=True, name="latency-prober")
    t.start()


def stop():
    global _running
    _running = False
