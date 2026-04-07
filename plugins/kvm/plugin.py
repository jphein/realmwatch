"""KVM discovery plugin — discovers VMs on hypervisor hosts via virsh.

Uses SSH + virsh commands to list VMs, their state, resource allocation,
and IP addresses. Auto-links VMs to existing topology nodes by name match.
"""

import logging
from discovery_engine import SubEntity

log = logging.getLogger(__name__)

_STATE_MAP = {
    "running": "running",
    "shut off": "stopped",
    "paused": "paused",
    "crashed": "failed",
    "dying": "failed",
    "pmsuspended": "stopped",
}


def _parse_virsh_info(output):
    """Parse 'virsh dominfo' key-value output."""
    result = {}
    for line in output.strip().split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            result[k.strip()] = v.strip()
    return result


def _parse_virsh_ip(output):
    """Parse 'virsh domifaddr' output for first IP."""
    for line in output.strip().split("\n"):
        parts = line.split()
        # Format: Name MAC Protocol Address
        if len(parts) >= 4 and "/" in parts[-1]:
            ip = parts[-1].split("/")[0]
            if ip and not ip.startswith("127."):
                return ip
    return None


def discover_kvm(node_id, node_data, host_access, engine):
    """Discover KVM VMs via virsh."""
    if not host_access.ssh_available():
        return []

    stdout, stderr, rc = host_access.ssh("virsh list --all --name", timeout=10)
    if rc != 0:
        # virsh not available — record capability
        import realm_db
        realm_db.set_discovery_capability(node_id, "kvm", False,
                                           error=stderr[:200] if stderr else "virsh not available")
        return []

    entities = []
    for vm_name in stdout.strip().split("\n"):
        vm_name = vm_name.strip()
        if not vm_name:
            continue

        # Get VM info
        info_out, _, info_rc = host_access.ssh(f"virsh dominfo '{vm_name}'", timeout=10)
        if info_rc != 0:
            continue
        info = _parse_virsh_info(info_out)

        state = info.get("State", "unknown")
        status = _STATE_MAP.get(state, "unknown")

        # Get IP if running
        ip = None
        if status == "running":
            ip_out, _, _ = host_access.ssh(f"virsh domifaddr '{vm_name}'", timeout=10)
            if ip_out:
                ip = _parse_virsh_ip(ip_out)

        # Parse memory (format: "2097152 KiB")
        mem_str = info.get("Max memory", "0 KiB")
        try:
            mem_kb = int(mem_str.split()[0])
            mem_mb = mem_kb // 1024
        except (ValueError, IndexError):
            mem_mb = 0

        metadata = {
            "vcpus": int(info.get("CPU(s)", 0)),
            "memory_mb": mem_mb,
            "autostart": info.get("Autostart", "").strip() == "enable",
            "state": state,
            "uuid": info.get("UUID", ""),
        }
        if ip:
            metadata["ip"] = ip

        entities.append(SubEntity(
            id=f"kvm:{node_id}:{vm_name}",
            type="vm",
            name=vm_name,
            host_node_id=node_id,
            status=status,
            metadata=metadata,
        ))

    if entities:
        import realm_db
        realm_db.set_discovery_capability(node_id, "kvm", True)

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="kvm",
        roles=["hypervisor"],
        discover_fn=discover_kvm,
        interval=120,
        entity_types=["vm"],
        priority=15,
    )
    ctx.log("Ethereal Planes active — KVM VM discovery registered (interval=120s)")
