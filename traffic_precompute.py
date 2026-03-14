"""Pre-compute per-node traffic intensity from collectd data.

Moves hostname matching, best-interface selection, and log-scale
intensity computation from the browser to the server.
"""

import math
from collectd_reader import get_all_summaries


def _match_host(collectd, node_id):
    """Match a topology node ID to a collectd hostname.

    Tries: exact match, then prefix match (hostname.domain.tld -> hostname),
    then fuzzy match (ignoring hyphens/underscores).
    Mirrors the logic in app.js getNodeTraffic().
    """
    key = node_id.lower()
    # Exact
    if node_id in collectd:
        return collectd[node_id]
    # Prefix
    for k, v in collectd.items():
        if k.lower().split('.')[0] == key:
            return v
    # Fuzzy
    norm = key.replace('-', '').replace('_', '')
    for v in collectd.values():
        h = (v.get('hostname') or '').lower().replace('-', '').replace('_', '')
        if h == norm:
            return v
    return None


def _best_interface(host_data):
    """Pick the busiest interface (highest rx+tx). Returns (rx, tx, total) or None."""
    ifaces = host_data.get('interfaces')
    if not ifaces:
        return None
    best_rx, best_tx, best_total = 0, 0, 0
    for iface in ifaces.values():
        rx = iface.get('rx_bps', 0) or 0
        tx = iface.get('tx_bps', 0) or 0
        total = rx + tx
        if total > best_total:
            best_rx, best_tx, best_total = rx, tx, total
    if best_total == 0:
        return None
    return best_rx, best_tx, best_total


def compute_traffic(topology_nodes):
    """Compute per-node traffic from current collectd data.

    Returns {node_id: {"rx": float, "tx": float, "total": float, "intensity": float}}
    for all nodes that have traffic data.
    """
    collectd = get_all_summaries()
    result = {}
    for node in topology_nodes:
        nid = node["id"]
        host = _match_host(collectd, nid)
        if not host:
            continue
        best = _best_interface(host)
        if not best:
            continue
        rx, tx, total = best
        # Raw log-scale intensity: 0->1 mapped over 1 KB/s -> 10 MB/s
        # Matches app.js: Math.max(0, Math.min(1, (Math.log10(total + 1) - 3) / 4))
        raw = max(0.0, min(1.0, (math.log10(total + 1) - 3) / 4))
        result[nid] = {"rx": round(rx, 1), "tx": round(tx, 1),
                       "total": round(total, 1), "intensity": round(raw, 4)}
    return result
