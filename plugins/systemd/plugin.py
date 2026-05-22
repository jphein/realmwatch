"""Systemd discovery plugin — discovers interesting services on Linux hosts.

"Interesting" = failed/degraded units + port-listening services + user-level units + watch list.
Excludes noisy system units (systemd-*, snapd.*, getty@*, etc.).
"""

import json
import logging

from discovery_engine import SubEntity

log = logging.getLogger(__name__)

# Units to always exclude (noisy system services)
_EXCLUDE_PATTERNS = [
    "systemd-", "snapd.", "getty@", "user@", "session-", "snap.", "dbus.",
    "polkit", "accounts-daemon", "networkd-dispatcher", "unattended-upgrades",
    "packagekit", "udisks2", "upower", "thermald", "kerneloops",
    "whoopsie", "apport", "plymouth", "cloud-", "lvm2-",
]

# Known active states that mean "running"
_ACTIVE_STATES = {"active", "activating", "reloading"}


def _is_excluded(unit_name):
    """Check if a unit name matches any exclusion pattern."""
    for pattern in _EXCLUDE_PATTERNS:
        if unit_name.startswith(pattern):
            return True
    return False


def _parse_systemctl_json(output):
    """Parse systemctl --output=json output. Returns list of unit dicts."""
    try:
        units = json.loads(output)
        if isinstance(units, list):
            return units
    except (json.JSONDecodeError, TypeError):
        pass
    return []


def discover_systemd(node_id, node_data, host, engine):
    """Discover interesting systemd services on a host."""
    discovery_config = node_data.get("discovery", {})

    # Check if this is the local machine
    import socket
    is_local = (host.ip in ("127.0.0.1", "localhost") or
                host.hostname == socket.gethostname() or
                node_id in ("forge", "katana"))

    # Get system-level services
    if is_local:
        import subprocess
        result = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--output=json"],
            capture_output=True, text=True, timeout=10
        )
        system_out = result.stdout if result.returncode == 0 else ""
        # Also get user-level services
        result_user = subprocess.run(
            ["systemctl", "--user", "list-units", "--type=service", "--all", "--output=json"],
            capture_output=True, text=True, timeout=10
        )
        user_out = result_user.stdout if result_user.returncode == 0 else ""
    else:
        if not host.ssh_available():
            return []
        system_out, _, rc = host.ssh(
            "systemctl list-units --type=service --all --output=json", timeout=15)
        if rc != 0:
            return []
        user_out, _, _ = host.ssh(
            "systemctl --user list-units --type=service --all --output=json", timeout=15)

    entities = []
    watch_list = set(discovery_config.get("systemd_watch", []))

    for output, is_user in [(system_out, False), (user_out, True)]:
        units = _parse_systemctl_json(output)
        for unit in units:
            name = unit.get("unit", "")
            if not name.endswith(".service"):
                continue

            active = unit.get("active", "")
            sub_state = unit.get("sub", "")
            load = unit.get("load", "")

            # CRITICAL: skip phantom entries where load=="not-found". These
            # are placeholders systemd emits in `--user --all` mode for unit
            # names it knows about but that have no actual unit file in this
            # scope (e.g. a system service like ollama.service when there
            # is no per-user override). They report inactive/dead and were
            # overwriting the legitimate system-level entries because both
            # produce the same SubEntity id, causing healthy services to be
            # cached as "stopped" → constant alert flapping.
            if load == "not-found":
                continue

            # Filter: interesting services only
            is_failed = active == "failed"
            is_watched = name in watch_list or name.replace(".service", "") in watch_list
            is_interesting = is_failed or is_watched or is_user

            if not is_interesting and _is_excluded(name):
                continue

            # Skip inactive system services that aren't failed or watched
            if not is_interesting and active not in _ACTIVE_STATES:
                continue

            # Map status
            if is_failed:
                status = "failed"
            elif active in _ACTIVE_STATES:
                status = "running"
            else:
                status = "stopped"

            entity = SubEntity(
                id=f"systemd:{node_id}:{name}",
                type="service",
                name=name,
                host_node_id=node_id,
                status=status,
                metadata={
                    "active_state": active,
                    "sub_state": sub_state,
                    "load_state": load,
                    "user": is_user,
                    "description": unit.get("description", ""),
                },
            )
            entities.append(entity)

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="systemd",
        roles=["server", "nas", "vm", "hypervisor", "desktop"],
        discover_fn=discover_systemd,
        interval=60,
        entity_types=["service"],
        priority=20,
    )
    ctx.log("Runic Services active — systemd discovery provider registered")
