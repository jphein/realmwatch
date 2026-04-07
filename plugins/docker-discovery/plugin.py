"""Docker discovery plugin — discovers containers on hosts via SSH.

Uses `docker ps --format json` + `docker stats --no-stream --format json` over SSH.
No Docker SDK needed, no exposed Docker socket, works with Podman too.
"""

import json
import logging

from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _parse_docker_ps(output):
    """Parse `docker ps -a --format json` output (one JSON object per line)."""
    containers = []
    for line in output.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            containers.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return containers


def _parse_docker_stats(output):
    """Parse `docker stats --no-stream --format json` output."""
    stats = {}
    for line in output.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            s = json.loads(line)
            name = s.get("Name", "")
            if name:
                stats[name] = s
        except json.JSONDecodeError:
            continue
    return stats


def discover_docker(node_id, node_data, host, engine):
    """Discover Docker containers on a host via SSH."""
    if not host.ssh_available():
        return []

    # Get container list
    ps_out, ps_err, ps_rc = host.ssh(
        "docker ps -a --format json", timeout=15)
    if ps_rc != 0:
        # Docker might not be installed — record capability
        import realm_db
        realm_db.set_discovery_capability(node_id, "docker", False,
                                           error=ps_err[:200] if ps_err else "docker not available")
        return []

    containers = _parse_docker_ps(ps_out)
    if not containers:
        return []

    # Get stats for running containers
    stats_out, _, _ = host.ssh(
        "docker stats --no-stream --format json", timeout=15)
    stats = _parse_docker_stats(stats_out) if stats_out else {}

    entities = []
    for c in containers:
        name = c.get("Names", "")
        state = c.get("State", "unknown").lower()
        image = c.get("Image", "")
        ports = c.get("Ports", "")
        created = c.get("CreatedAt", "")

        # Map Docker state to our status
        if state == "running":
            status = "running"
        elif state in ("exited", "dead"):
            status = "stopped"
        elif state in ("paused", "restarting"):
            status = state
        else:
            status = "unknown"

        metadata = {
            "image": image,
            "ports": ports,
            "created": created,
            "state": state,
            "status_text": c.get("Status", ""),
        }

        # Add stats if available
        container_stats = stats.get(name, {})
        if container_stats:
            metadata["cpu_percent"] = container_stats.get("CPUPerc", "")
            metadata["memory"] = container_stats.get("MemUsage", "")
            metadata["memory_percent"] = container_stats.get("MemPerc", "")
            metadata["net_io"] = container_stats.get("NetIO", "")
            metadata["block_io"] = container_stats.get("BlockIO", "")

        # Try to extract compose project
        label_out, _, _ = host.ssh(
            f"docker inspect --format '{{{{index .Config.Labels \"com.docker.compose.project\"}}}}' {name}",
            timeout=5)
        compose_project = label_out.strip() if label_out else ""
        if compose_project:
            metadata["compose_project"] = compose_project

        entity = SubEntity(
            id=f"docker:{node_id}:{name}",
            type="container",
            name=name,
            host_node_id=node_id,
            status=status,
            metadata=metadata,
        )
        entities.append(entity)

    import realm_db
    realm_db.set_discovery_capability(node_id, "docker", True)
    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="docker",
        roles=["server", "nas", "hypervisor"],
        discover_fn=discover_docker,
        interval=60,
        entity_types=["container"],
        priority=10,
    )
    ctx.log("Iron Golem Foundry active — Docker discovery provider registered")
