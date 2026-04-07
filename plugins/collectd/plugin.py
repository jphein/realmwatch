"""Collectd plugin — RRD reader + live UDP listener + Census status provider.

Wraps collectd_reader (historical RRD data) and collectd_listener (live UDP
metrics) into the plugin system. Registers a status provider so collectd
summaries are included in the SSE status blob, and exposes the /collectd
endpoint for per-host or all-host queries.
"""

import collectd_reader
import collectd_listener
from discovery_engine import SubEntity


def handle_collectd(req, params):
    """GET /collectd — return host summary or all summaries."""
    qp = req.query_params
    hostname = qp.get("host")
    if hostname:
        summary = collectd_reader.get_host_summary(hostname)
        return req.respond(summary or {"error": f"No data for {hostname}"})
    return req.respond(collectd_reader.get_all_summaries())


def _collectd_status_provider():
    """Status provider — returns collectd summaries for the status blob."""
    return {"collectd": collectd_reader.get_all_summaries()}


def discover_collectd(node_id, node_data, host_access, engine):
    """Discover collectd hosts from RRD directories."""
    import os
    import time as _time
    rrd_base = "/var/lib/collectd/rrd/"
    entities = []
    if not os.path.isdir(rrd_base):
        return entities
    for hostname in os.listdir(rrd_base):
        host_dir = os.path.join(rrd_base, hostname)
        if not os.path.isdir(host_dir):
            continue
        plugins = [d for d in os.listdir(host_dir) if os.path.isdir(os.path.join(host_dir, d))]
        if not plugins:
            continue
        mtime = max(os.path.getmtime(os.path.join(host_dir, p)) for p in plugins)
        entities.append(SubEntity(
            id=f"collectd:{hostname}",
            type="collectd_host",
            name=hostname,
            host_node_id=hostname,  # entity linker resolves to topology node
            status="running" if (_time.time() - mtime) < 300 else "stale",
            metadata={"plugins": plugins, "last_update": mtime, "plugin_count": len(plugins)},
        ))
    return entities


def setup(ctx):
    """Plugin setup — register status provider, start listener, expose API."""

    # Register status provider so collectd data appears in SSE status blob
    ctx.register_status_provider(_collectd_status_provider)

    # Start the live UDP listener (receives push metrics from remote collectd instances)
    collectd_listener.start_listener()

    # Override RRD base path if configured
    rrd_path = ctx.config.get("rrd_path")
    if rrd_path:
        collectd_reader.RRD_BASE = rrd_path

    # Expose API for other plugins (e.g., event_generator needs get_all_summaries)
    ctx.expose_api({
        "get_all_summaries": collectd_reader.get_all_summaries,
        "get_host_summary": collectd_reader.get_host_summary,
        "get_live_metrics": collectd_listener.get_metrics,
        "get_live_host_summary": collectd_listener.get_host_summary,
    })

    # Register collectd as a global discovery provider (scans local RRD dirs)
    ctx.register_discovery_provider(
        name="collectd", roles=[],  # global provider — runs once, not per-node
        discover_fn=discover_collectd,
        interval=120, entity_types=["collectd_host"], priority=60,
    )

    ctx.log("Scrying Stones active — RRD reader + UDP listener started")
