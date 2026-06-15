"""Netdata discovery plugin — Oracle Sight.

Discovers Netdata agent instances via REST API and surfaces per-host power
draw on the realm map (Issue #107).

Discovery polls /api/v1/info (agent status) and /api/v1/charts (chart
enumeration), then /api/v1/data for the live Intel-RAPL CPU-package power
chart (Units: Watts) plus any nvidia_smi GPU power-draw charts. The latest
wattage is stashed both as SubEntity metadata and in a module-level cache
that feeds:
  - the GET /host-power endpoint (realm / curl),
  - the 10s status blob (under the `host_power` key), and
  - the exposed plugin API (herald / oracle / codex narration).

This is per-host CPU/GPU draw — distinct from the whole-home solar/grid
data the HA plugin ("Solar Sanctum") provides.
"""

import json
import logging
import threading
import time

from discovery_engine import SubEntity

log = logging.getLogger(__name__)

# Netdata REST API port.
NETDATA_PORT = 19999
# Intel-RAPL package-domain power chart (Units: Watts) — present on Ubuntu
# hosts running a netdata agent with powercap/RAPL support.
RAPL_PACKAGE_CHART = "cpu.powercap_intel_rapl_zone_package-0"

# ── Per-host power cache ──
# node_id -> {"name", "ip", "package_watts", "gpu_watts", "ts"}
#
# discover_netdata() is the single poller (runs every 30s with proper
# host_access); the /host-power endpoint, status provider, and exposed API all
# read this cache. No duplicate polling, no separate background thread.
_power_cache = {}
_power_lock = threading.Lock()
# Drop entries older than ~3 discovery intervals. A host whose agent goes down
# stops refreshing and silently ages out of the feed (graceful — no crash, the
# host is simply omitted).
_POWER_TTL = 95  # seconds


def _latest_chart_value(host_access, chart):
    """Return the latest summed value for a netdata chart, or None.

    Fetches the single most-recent point and sums every dimension column
    (skipping the leading time column) — robust to dimension naming and
    multi-dimension charts. Returns None if the chart/agent is absent or the
    response is malformed, so callers degrade gracefully.
    """
    resp = host_access.http_get(
        NETDATA_PORT,
        f"/api/v1/data?chart={chart}&after=-1&points=1&format=json",
    )
    if not resp or resp.get("status") != 200:
        return None
    try:
        data = json.loads(resp["body"])
    except (json.JSONDecodeError, ValueError, TypeError, KeyError):
        return None
    rows = data.get("data")
    if not rows or not isinstance(rows, list):
        return None
    row = rows[0]
    if not isinstance(row, list):
        return None
    total = 0.0
    seen = False
    for v in row[1:]:  # column 0 is the timestamp
        if isinstance(v, (int, float)):
            total += v
            seen = True
    return total if seen else None


def _fetch_power(host_access, charts_data):
    """Fetch CPU-package + GPU watts for a host. None where a source is absent."""
    package = _latest_chart_value(host_access, RAPL_PACKAGE_CHART)

    gpu = None
    charts = (charts_data or {}).get("charts", {})
    gpu_charts = [
        cid for cid in charts
        if cid.startswith("nvidia_smi.") and cid.endswith("_power_draw")
    ]
    if gpu_charts:
        gpu_total = 0.0
        got = False
        for cid in gpu_charts:
            v = _latest_chart_value(host_access, cid)
            if v is not None:
                gpu_total += v
                got = True
        if got:
            gpu = round(gpu_total, 2)

    return {
        "package_watts": round(package, 2) if package is not None else None,
        "gpu_watts": gpu,
    }


def _host_power_snapshot():
    """Fresh {node_id: {package_watts, gpu_watts, name, ip, ts}} (stale dropped)."""
    now = time.time()
    out = {}
    with _power_lock:
        for nid, rec in _power_cache.items():
            if now - rec["ts"] > _POWER_TTL:
                continue
            out[nid] = {
                "package_watts": rec["package_watts"],
                "gpu_watts": rec["gpu_watts"],
                "name": rec["name"],
                "ip": rec["ip"],
                "ts": rec["ts"],
            }
    return out


def _get_host_watts(node_id):
    """Latest watts for a single host (or None) — for the exposed plugin API."""
    return _host_power_snapshot().get(node_id)


def discover_netdata(node_id, node_data, host_access, engine):
    """Discover Netdata agent via REST API (+ per-host power draw)."""
    resp = host_access.http_get(NETDATA_PORT, "/api/v1/info")
    if not resp or resp.get("status") != 200:
        return []

    try:
        info = json.loads(resp["body"])
    except (json.JSONDecodeError, KeyError):
        return []

    # Extract collector info
    collectors = info.get("collectors", [])
    unique_collectors = sorted(set(
        c.get("plugin", "") for c in collectors if c.get("plugin")
    ))

    # Alarm counts
    alarms = info.get("alarms", {})
    alarms_critical = alarms.get("critical", 0)
    alarms_warning = alarms.get("warning", 0)

    # Determine status from alarms
    if alarms_critical > 0:
        status = "failed"
    elif alarms_warning > 0:
        status = "running"  # running but with warnings
    else:
        status = "running"

    metadata = {
        "version": info.get("version", ""),
        "os": info.get("os_name", ""),
        "kernel": info.get("kernel_name", ""),
        "architecture": info.get("architecture", ""),
        "collectors": unique_collectors,
        "collector_count": len(unique_collectors),
        "alarms_critical": alarms_critical,
        "alarms_warning": alarms_warning,
        "hosts_count": info.get("hosts_count", 1),
        "mirrored_hosts": info.get("mirrored_hosts", []),
    }

    # Get chart list (lightweight call) — also reused for GPU power discovery.
    charts_data = None
    charts_resp = host_access.http_get(NETDATA_PORT, "/api/v1/charts")
    if charts_resp and charts_resp.get("status") == 200:
        try:
            charts_data = json.loads(charts_resp["body"])
            metadata["charts_count"] = len(charts_data.get("charts", {}))
        except (json.JSONDecodeError, KeyError):
            charts_data = None

    # ── Per-host power draw (Issue #107) ──
    # Fetch live CPU-package (+ GPU) watts. Stash on SubEntity metadata and in
    # the module cache that drives /host-power, the status blob, and the API.
    power = _fetch_power(host_access, charts_data)
    if power["package_watts"] is not None:
        metadata["package_watts"] = power["package_watts"]
    if power["gpu_watts"] is not None:
        metadata["gpu_watts"] = power["gpu_watts"]
    if power["package_watts"] is not None or power["gpu_watts"] is not None:
        with _power_lock:
            _power_cache[node_id] = {
                "name": info.get("hostname", node_id),
                "ip": node_data.get("ip"),
                "package_watts": power["package_watts"],
                "gpu_watts": power["gpu_watts"],
                "ts": time.time(),
            }

    return [SubEntity(
        id=f"netdata:{node_id}",
        type="netdata_host",
        name=info.get("hostname", node_id),
        host_node_id=node_id,
        status=status,
        metadata=metadata,
    )]


# ── Endpoint handler ──

def handle_host_power(req, params):
    """GET /host-power — per-host CPU/GPU watts for hosts running netdata.

    Returns {node_id: {package_watts, gpu_watts, name, ip, ts}}. Hosts whose
    netdata agent is down (or lacks a RAPL chart) are simply omitted.
    """
    req.respond(_host_power_snapshot())


# ── Status provider ──

def _host_power_status_provider():
    """Fold per-host watts into the 10s status blob under `host_power`."""
    return {"host_power": _host_power_snapshot()}


def setup(ctx):
    ctx.register_discovery_provider(
        name="netdata",
        roles=["server", "vm", "hypervisor", "desktop", "router"],
        discover_fn=discover_netdata,
        interval=30,
        entity_types=["netdata_host"],
        priority=30,
    )

    # First-class per-host power feed (Issue #107): fold watts into the status
    # blob (drives the panel, rides the 10s status SSE) and expose an API so
    # herald/oracle/codex can narrate "familiar is drawing 27 W."
    # The GET /host-power endpoint is wired from the manifest `endpoints` block.
    ctx.register_status_provider(_host_power_status_provider)
    ctx.expose_api({
        "get_host_power": _host_power_snapshot,
        "get_host_watts": _get_host_watts,
    })

    ctx.log("Oracle Sight active — Netdata discovery + per-host power feed "
            "(/host-power, status.host_power)")
