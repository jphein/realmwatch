"""Collectd plugin — RRD reader + live UDP listener + Census status provider.

Wraps collectd_reader (historical RRD data) and collectd_listener (live UDP
metrics) into the plugin system. Registers a status provider so collectd
summaries are included in the SSE status blob, and exposes the /collectd
endpoint for per-host or all-host queries.
"""

import collectd_reader
import collectd_listener


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

    ctx.log("Scrying Stones active — RRD reader + UDP listener started")
