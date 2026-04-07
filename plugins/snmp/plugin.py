"""SNMP discovery plugin — switch ports, interface status, system info.

Uses Net-SNMP CLI tools (snmpget, snmpwalk) via subprocess.
Discovers interfaces with status and speed on SNMP-capable devices.
"""

import logging
from discovery_engine import SubEntity

log = logging.getLogger(__name__)

# Common OIDs
OID_SYS_DESCR = "SNMPv2-MIB::sysDescr.0"
OID_SYS_NAME = "SNMPv2-MIB::sysName.0"
OID_SYS_UPTIME = "SNMPv2-MIB::sysUpTime.0"
OID_IF_DESCR = "IF-MIB::ifDescr"
OID_IF_OPER_STATUS = "IF-MIB::ifOperStatus"
OID_IF_SPEED = "IF-MIB::ifSpeed"
OID_IF_IN_OCTETS = "IF-MIB::ifInOctets"
OID_IF_OUT_OCTETS = "IF-MIB::ifOutOctets"


def _parse_walk_index(walk_results):
    """Parse snmpwalk results into {index: value} dict."""
    result = {}
    for oid, value in walk_results:
        # Extract last index from OID: .1.3.6.1.2.1.2.2.1.2.1 -> "1"
        idx = oid.rsplit(".", 1)[-1] if "." in oid else oid
        result[idx] = value
    return result


def discover_snmp(node_id, node_data, host_access, engine):
    """Discover interfaces and system info via SNMP."""
    discovery_config = node_data.get("discovery", {})
    community = discovery_config.get("snmp_community", "public")

    # Probe SNMP availability
    sys_descr = host_access.snmp_get(OID_SYS_DESCR, community)
    if not sys_descr:
        import realm_db
        realm_db.set_discovery_capability(node_id, "snmp", False, error="SNMP not responding")
        return []

    sys_name = host_access.snmp_get(OID_SYS_NAME, community) or node_id
    sys_uptime = host_access.snmp_get(OID_SYS_UPTIME, community) or ""

    # Walk interface table
    if_names = _parse_walk_index(host_access.snmp_walk(OID_IF_DESCR, community))
    if_statuses = _parse_walk_index(host_access.snmp_walk(OID_IF_OPER_STATUS, community))
    if_speeds = _parse_walk_index(host_access.snmp_walk(OID_IF_SPEED, community))

    entities = []

    # System entity
    entities.append(SubEntity(
        id=f"snmp:{node_id}:system",
        type="snmp_system",
        name=sys_name,
        host_node_id=node_id,
        status="running",
        metadata={
            "sys_descr": sys_descr[:200],
            "sys_name": sys_name,
            "uptime": sys_uptime,
            "interface_count": len(if_names),
        },
    ))

    # Interface entities
    for idx, name in if_names.items():
        # Skip loopback and internal interfaces
        if name.lower() in ("lo", "lo0", "null0"):
            continue

        status_raw = if_statuses.get(idx, "unknown")
        status = "running" if "up" in status_raw.lower() else "stopped"

        speed_raw = if_speeds.get(idx, "0")
        try:
            speed_mbps = int(speed_raw) // 1_000_000
        except (ValueError, TypeError):
            speed_mbps = 0

        entities.append(SubEntity(
            id=f"snmp:{node_id}:if-{idx}",
            type="snmp_port",
            name=f"{name}",
            host_node_id=node_id,
            status=status,
            metadata={
                "ifIndex": int(idx),
                "ifSpeed_mbps": speed_mbps,
                "ifDescr": name,
                "ifOperStatus": status_raw,
            },
        ))

    import realm_db
    realm_db.set_discovery_capability(node_id, "snmp", True)
    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="snmp",
        roles=["switch", "router", "ap", "ups", "printer", "bridge"],
        discover_fn=discover_snmp,
        interval=120,
        entity_types=["snmp_system", "snmp_port"],
        priority=30,
    )
    ctx.log("Crystal Resonance active — SNMP discovery registered (interval=120s)")
