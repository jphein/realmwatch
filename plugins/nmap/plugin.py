"""nmap discovery plugin — network scan with service/OS detection.

Scans topology node IPs for open ports, service versions, and OS fingerprints.
Heavy scan — 10 minute interval, low priority (runs last).
"""

import logging
import nmap
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def discover_nmap(node_id, node_data, host_access, engine):
    """Scan a single node with nmap for open ports and services."""
    if not host_access.ip:
        return []

    # Skip localhost
    if host_access.ip in ("127.0.0.1", "::1"):
        return []

    scanner = nmap.PortScanner()
    try:
        # Fast service version scan, skip OS detection (requires root)
        scanner.scan(host_access.ip, arguments="-sV --open -T4 --top-ports 100", timeout=30)
    except nmap.PortScannerError as e:
        log.debug("nmap scan failed for %s: %s", node_id, e)
        return []
    except Exception as e:
        log.debug("nmap error for %s: %s", node_id, e)
        return []

    if host_access.ip not in scanner.all_hosts():
        return []

    host = scanner[host_access.ip]
    services = {}
    open_ports = []

    for proto in host.all_protocols():
        for port in sorted(host[proto].keys()):
            svc = host[proto][port]
            if svc.get("state") == "open":
                open_ports.append(port)
                services[str(port)] = {
                    "name": svc.get("name", ""),
                    "product": svc.get("product", ""),
                    "version": svc.get("version", ""),
                    "extrainfo": svc.get("extrainfo", ""),
                }

    if not open_ports:
        return []

    # Build port summary for sublabel
    port_summary = ", ".join(
        f"{p}/{services[str(p)]['name']}" if services.get(str(p), {}).get("name") else str(p)
        for p in open_ports[:8]
    )
    if len(open_ports) > 8:
        port_summary += f" +{len(open_ports) - 8} more"

    return [SubEntity(
        id=f"nmap:{node_id}",
        type="nmap_scan",
        name=f"{node_id} scan",
        host_node_id=node_id,
        status="running",
        metadata={
            "open_ports": open_ports,
            "services": services,
            "port_count": len(open_ports),
            "port_summary": port_summary,
            "scan_args": "-sV --open -T4 --top-ports 100",
        },
    )]


def setup(ctx):
    # Import ROLE_PROVIDERS to scan all role types
    from discovery_engine import ROLE_PROVIDERS
    all_roles = list(ROLE_PROVIDERS.keys())

    ctx.register_discovery_provider(
        name="nmap",
        roles=all_roles,  # scan everything with a role
        discover_fn=discover_nmap,
        interval=600,  # 10 minutes (heavy scan)
        entity_types=["nmap_scan"],
        priority=90,  # run last
    )
    ctx.log("The Far Sight active — nmap network scanner registered (interval=600s)")
