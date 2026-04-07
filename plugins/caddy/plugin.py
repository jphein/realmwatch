"""Caddy discovery plugin — discovers reverse proxy routes.

Reads Caddyfile or queries Caddy admin API to find domain→backend mappings.
Each route becomes a reverse_proxy SubEntity. Backend IPs auto-link to
topology nodes via the entity linker.
"""

import json
import logging
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _parse_caddyfile(content):
    """Parse Caddyfile for domain→backend mappings. Returns [(domain, backend)]."""
    routes = []
    current_domain = None
    brace_depth = 0

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # Track brace depth
        brace_depth += stripped.count("{") - stripped.count("}")

        # Domain block opener: "vault.jphe.in {" or "vault.jphe.in {"
        if stripped.endswith("{") and brace_depth == 1:
            domain = stripped.rstrip("{ ").strip()
            if domain and not domain.startswith(("@", "handle", "route", "log", "encode")):
                current_domain = domain
                continue

        # reverse_proxy directive
        if current_domain and "reverse_proxy" in stripped:
            parts = stripped.split()
            # Find the backend (last arg that looks like a host:port or URL)
            for part in reversed(parts):
                if part == "reverse_proxy":
                    break
                if ":" in part or part.startswith("http"):
                    routes.append((current_domain, part))
                    break

        # Block close
        if brace_depth == 0:
            current_domain = None

    return routes


def _parse_admin_api(body):
    """Parse Caddy admin API /config/apps/http/servers response."""
    routes = []
    try:
        servers = json.loads(body)
        if isinstance(servers, dict):
            for srv_name, srv in servers.items():
                for route in srv.get("routes", []):
                    # Extract host matchers
                    domains = []
                    for match in route.get("match", []):
                        domains.extend(match.get("host", []))
                    # Extract reverse_proxy handlers
                    for handle_group in route.get("handle", []):
                        if isinstance(handle_group, dict) and handle_group.get("handler") == "reverse_proxy":
                            upstreams = handle_group.get("upstreams", [])
                            for upstream in upstreams:
                                dial = upstream.get("dial", "")
                                for domain in domains:
                                    routes.append((domain, dial))
    except (json.JSONDecodeError, KeyError, TypeError):
        pass
    return routes


def discover_caddy(node_id, node_data, host_access, engine):
    """Discover Caddy reverse proxy routes."""
    routes = []

    # Try admin API first (structured, fast)
    resp = host_access.http_get(2019, "/config/apps/http/servers")
    if resp and resp.get("status") == 200:
        routes = _parse_admin_api(resp["body"])

    if not routes:
        # Try Caddyfile via SSH
        if host_access.ssh_available():
            for path in ["/etc/caddy/Caddyfile", "/config/Caddyfile"]:
                stdout, _, rc = host_access.ssh(f"cat {path}", timeout=10)
                if rc == 0 and stdout.strip():
                    routes = _parse_caddyfile(stdout)
                    break

            if not routes:
                # Try Docker exec for containerized Caddy
                stdout, _, rc = host_access.ssh(
                    "docker exec caddy cat /etc/caddy/Caddyfile", timeout=10)
                if rc == 0 and stdout.strip():
                    routes = _parse_caddyfile(stdout)

    if not routes:
        return []

    entities = []
    for domain, backend in routes:
        entities.append(SubEntity(
            id=f"caddy:{node_id}:{domain}",
            type="reverse_proxy",
            name=f"{domain} → {backend}",
            host_node_id=node_id,
            status="running",
            metadata={
                "domain": domain,
                "backend": backend,
                "tls": not domain.startswith("http://"),
            },
        ))

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="caddy",
        roles=["server", "nas", "vm"],
        discover_fn=discover_caddy,
        interval=300,  # 5 minutes
        entity_types=["reverse_proxy"],
        priority=70,
    )
    ctx.log("Gate Warden active — Caddy reverse proxy discovery registered (interval=300s)")
