"""Netdata discovery plugin — Oracle Sight.

Discovers Netdata agent instances via REST API. Polls /api/v1/info for
agent status and /api/v1/charts for chart enumeration.
"""

import json
import logging
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def discover_netdata(node_id, node_data, host_access, engine):
    """Discover Netdata agent via REST API."""
    resp = host_access.http_get(19999, "/api/v1/info")
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

    # Get chart count (lightweight call)
    charts_resp = host_access.http_get(19999, "/api/v1/charts")
    if charts_resp and charts_resp.get("status") == 200:
        try:
            charts_data = json.loads(charts_resp["body"])
            metadata["charts_count"] = len(charts_data.get("charts", {}))
        except (json.JSONDecodeError, KeyError):
            pass

    return [SubEntity(
        id=f"netdata:{node_id}",
        type="netdata_host",
        name=info.get("hostname", node_id),
        host_node_id=node_id,
        status=status,
        metadata=metadata,
    )]


def setup(ctx):
    ctx.register_discovery_provider(
        name="netdata",
        roles=["server", "vm", "hypervisor", "desktop", "router"],
        discover_fn=discover_netdata,
        interval=30,
        entity_types=["netdata_host"],
        priority=30,
    )
    ctx.log("Oracle Sight active — Netdata agent discovery registered (interval=30s)")
