"""WiFi plugin — Aether Towers.

Wraps ap_scanner to provide WiFi scanning, AP client lists, signal data,
LLDP ethernet topology, and SSE wifi events via the plugin system.
Also registers as a discovery provider, surfacing WiFi clients as SubEntities.
"""

import logging
import ap_scanner
import realm_db
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def discover_wifi(node_id, node_data, host_access, engine):
    """Create SubEntities from existing WiFi scan data.

    Two sources:
    1. get_wifi_signal() — known nodes with signal data (resolved to topology)
    2. get_last_scan()["unknown"] — unresolved WiFi/DHCP clients (replaces
       the old _unknown_* auto-node creation in ap_scanner)
    """
    entities = []
    seen_macs = set()

    # Known nodes with signal data
    wifi_data = ap_scanner.get_wifi_signal()
    if wifi_data:
        for nid, info in wifi_data.items():
            mac = info.get("mac", "")
            if not mac:
                continue
            seen_macs.add(mac)
            ap = info.get("ap", "")
            signal = info.get("signal", 0)
            hostname = info.get("hostname", "")
            ip = info.get("ip", "")
            entities.append(SubEntity(
                id=f"wifi:{ap}:{mac}",
                type="wifi_client",
                name=hostname or f"device-{mac[-8:].replace(':', '')}",
                host_node_id=ap or "unknown-ap",
                status="connected",
                metadata={
                    "mac": mac,
                    "ip": ip,
                    "signal_dbm": signal,
                    "ap": ap,
                    "hostname": hostname,
                    "band": info.get("band", ""),
                    "node_id": nid,
                },
            ))

    # Unknown clients — not resolved to topology nodes
    scan = ap_scanner.get_last_scan() or {}
    for client in scan.get("unknown", []):
        mac = client.get("mac", "")
        if not mac or mac in seen_macs:
            continue
        seen_macs.add(mac)
        ap = client.get("ap", "")
        hostname = client.get("hostname") or ""
        ip = client.get("ip") or ""
        entities.append(SubEntity(
            id=f"wifi:{ap}:{mac}",
            type="wifi_client",
            name=hostname or f"device-{mac[-8:].replace(':', '')}",
            host_node_id=ap or "unknown-ap",
            status="connected",
            metadata={
                "mac": mac,
                "ip": ip,
                "ap": ap,
                "hostname": hostname,
                "unresolved": True,
            },
        ))

    return entities


def _get_wifi_sse_data():
    """SSE source getter — returns AP info for wifi event."""
    return ap_scanner.get_ap_info()


def handle_scan(req, params):
    """GET /scan — trigger a WiFi AP scan."""
    req.respond(ap_scanner.scan_and_update())
    return None


def handle_scan_status(req, params):
    """GET /scan/status — last scan result."""
    return ap_scanner.get_last_scan()


def handle_scan_lldp(req, params):
    """GET /scan/lldp — LLDP ethernet topology."""
    links = ap_scanner.detect_ethernet_topology()
    topo = realm_db.get_topology()
    auto_switches = [n for n in topo.get("nodes", []) if n.get("_auto_switch")]
    return {
        "links": len(links),
        "switches": len(auto_switches),
        "connections": [
            {"from": l["from_node"], "to": l["to_node"],
             "type": l.get("protocol", "lldp")}
            for l in links
        ],
        "cliques": [n["id"] for n in auto_switches],
    }


def handle_scan_wifi(req, params):
    """GET /scan/wifi — WiFi signal data."""
    return ap_scanner.get_wifi_signal()


def handle_wifi_aps(req, params):
    """GET /wifi/aps — per-AP client lists."""
    return ap_scanner.get_ap_info()


def setup(ctx):
    """Plugin setup — wire ap_scanner callbacks, start scanner, register SSE."""

    # Wire ap_scanner event callback to push realm events
    def _push_event_wrapper(event):
        ctx.push_event(event.get("type", "wifi"), event)

    ap_scanner._event_callback = _push_event_wrapper

    # Wire topology refresh callback
    def _topo_callback():
        from sse_broker import SSEBroker
        # Use the broker's send_event via the registry
        topo = realm_db.get_topology()
        # The plugin context doesn't expose direct SSE send, so we push a
        # topology-change event that the core handles
        ctx._sse_broker.send_event("topology", topo)

    ap_scanner._topo_callback = _topo_callback

    # Start the background scanner thread
    ap_scanner.start_background_scanner()

    # Register SSE source (wifi AP data, 120s interval, no burst — may be slow)
    ctx.register_sse_source(
        event_type="wifi",
        getter_fn=_get_wifi_sse_data,
        interval=120,
        burst=False,
    )

    # Register status provider so build_status() includes wifi signal data
    ctx.register_status_provider(lambda: {"wifi": ap_scanner.get_wifi_signal()})

    # Expose public API for other plugins
    ctx.expose_api({
        "get_wifi_signal": ap_scanner.get_wifi_signal,
        "get_ap_info": ap_scanner.get_ap_info,
        "get_last_scan": ap_scanner.get_last_scan,
        "scan_and_update": ap_scanner.scan_and_update,
        "detect_ethernet_topology": ap_scanner.detect_ethernet_topology,
    })

    # Register WiFi as discovery provider (reads existing scan data)
    ctx.register_discovery_provider(
        name="wifi-clients",
        roles=[],  # global — reads existing ap_scanner data
        discover_fn=discover_wifi,
        interval=90,
        entity_types=["wifi_client"],
        priority=25,
    )

    ctx.log("Aether Towers WiFi scanner started + discovery provider registered")
