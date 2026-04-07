"""Health monitoring plugin — Watchtower Beacon.

Auto-discovers endpoints to check from other providers (Caddy domains,
Docker ports, topology URLs) and runs HTTP/TCP/TLS health checks.
"""

import datetime
import logging
import socket
import ssl
import time

import httpx
from discovery_engine import SubEntity

log = logging.getLogger(__name__)

_engine = None


def _check_http(url, timeout=5):
    """HTTP health check. Returns (status, metadata)."""
    try:
        resp = httpx.get(url, timeout=timeout, verify=False, follow_redirects=True)
        status = "healthy" if resp.status_code < 400 else "degraded"
        meta = {
            "status_code": resp.status_code,
            "response_ms": int(resp.elapsed.total_seconds() * 1000),
            "url": url,
        }
        # Try realm-sigil version endpoint
        try:
            base = url.rstrip("/")
            ver_resp = httpx.get(f"{base}/api/version", timeout=3, verify=False)
            if ver_resp.status_code == 200:
                meta["version"] = ver_resp.json()
        except Exception:
            pass
        return status, meta
    except httpx.ConnectError:
        return "unreachable", {"url": url, "error": "connection refused"}
    except httpx.TimeoutException:
        return "unreachable", {"url": url, "error": "timeout"}
    except Exception as e:
        return "unreachable", {"url": url, "error": str(e)[:200]}


def _check_tcp(host, port, timeout=5):
    """TCP port check. Returns (status, metadata)."""
    start = time.time()
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        elapsed_ms = int((time.time() - start) * 1000)
        sock.close()
        return "open", {"port": port, "host": host, "response_ms": elapsed_ms}
    except socket.timeout:
        return "closed", {"port": port, "host": host, "error": "timeout"}
    except ConnectionRefusedError:
        return "closed", {"port": port, "host": host, "error": "refused"}
    except Exception as e:
        return "closed", {"port": port, "host": host, "error": str(e)[:200]}


def _check_tls_expiry(hostname, port=443):
    """Check TLS certificate expiry. Returns ISO date string or None."""
    try:
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(socket.socket(), server_hostname=hostname) as s:
            s.settimeout(5)
            s.connect((hostname, port))
            cert = s.getpeercert()
            expiry_str = cert.get("notAfter", "")
            if expiry_str:
                expiry = datetime.datetime.strptime(expiry_str, "%b %d %H:%M:%S %Y %Z")
                return expiry.isoformat()
    except Exception:
        pass
    return None


def discover_health(node_id, node_data, host_access, engine):
    """Run health checks for a node's endpoints."""
    entities = []

    # Check node URL if present
    url = node_data.get("url")
    if url:
        status, meta = _check_http(url)
        hostname = url.split("//")[1].split("/")[0].split(":")[0] if "//" in url else ""
        if url.startswith("https") and hostname:
            tls_expiry = _check_tls_expiry(hostname)
            if tls_expiry:
                meta["tls_expiry"] = tls_expiry
        entities.append(SubEntity(
            id=f"health:{node_id}:http-{hostname}",
            type="http_health",
            name=hostname or url,
            host_node_id=node_id,
            status=status,
            metadata=meta,
        ))

    # Check manual health endpoints from node config
    manual_endpoints = node_data.get("discovery", {}).get("health_endpoints", [])
    for ep in manual_endpoints:
        if ep.get("type") == "http":
            ep_url = ep.get("url", "")
            if not ep_url:
                continue
            status, meta = _check_http(ep_url)
            hostname = ep_url.split("//")[1].split("/")[0].split(":")[0] if "//" in ep_url else ""
            entities.append(SubEntity(
                id=f"health:{node_id}:http-{hostname}",
                type="http_health",
                name=ep.get("name", hostname),
                host_node_id=node_id,
                status=status,
                metadata=meta,
            ))
        elif ep.get("type") == "tcp":
            host = ep.get("host") or host_access.ip
            port = ep.get("port", 0)
            if not port:
                continue
            status, meta = _check_tcp(host, port)
            entities.append(SubEntity(
                id=f"health:{node_id}:tcp-{port}",
                type="tcp_health",
                name=f"{node_id}:{port}",
                host_node_id=node_id,
                status=status,
                metadata=meta,
            ))

    return entities


def setup(ctx):
    global _engine
    import sys
    ms = sys.modules.get('__main__')
    if ms and hasattr(ms, '_discovery_engine'):
        _engine = ms._discovery_engine

    # Register as discovery provider — scans nodes with URLs or health_endpoints config
    from discovery_engine import ROLE_PROVIDERS
    all_roles = list(ROLE_PROVIDERS.keys())

    ctx.register_discovery_provider(
        name="health",
        roles=all_roles,  # check all nodes
        discover_fn=discover_health,
        interval=60,
        entity_types=["http_health", "tcp_health"],
        priority=80,  # run after other providers
    )

    ctx.log("Watchtower Beacon active — health monitoring registered (interval=60s)")
