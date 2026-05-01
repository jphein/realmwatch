"""SNMP discovery plugin — switch ports, interface status, system info.

Uses Net-SNMP CLI tools (snmpget, snmpwalk) via subprocess.
Discovers interfaces with status and speed on SNMP-capable devices.
"""

import logging
import os
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _v3_creds_from_config(discovery_config):
    """Build v3 credentials dict from a node's discovery config, or None.

    Reads passwords from environment variables named in the config so secrets
    stay in .env, not topology.json. Required keys when snmp_version == 3:
      snmp_user, snmp_auth_env, snmp_priv_env (env var names)
    Optional: snmp_auth_proto (default SHA), snmp_priv_proto (default AES),
              snmp_level (default authPriv)
    """
    if discovery_config.get("snmp_version") != 3:
        return None
    auth_env = discovery_config.get("snmp_auth_env")
    priv_env = discovery_config.get("snmp_priv_env")
    user = discovery_config.get("snmp_user")
    if not (user and auth_env and priv_env):
        log.warning("SNMPv3 config incomplete: need snmp_user/snmp_auth_env/snmp_priv_env")
        return None
    auth_pass = os.environ.get(auth_env, "")
    priv_pass = os.environ.get(priv_env, "")
    if not (auth_pass and priv_pass):
        log.warning("SNMPv3 env vars missing values: %s/%s", auth_env, priv_env)
        return None
    return {
        "user": user,
        "auth_pass": auth_pass,
        "priv_pass": priv_pass,
        "auth_proto": discovery_config.get("snmp_auth_proto", "SHA"),
        "priv_proto": discovery_config.get("snmp_priv_proto", "AES"),
        "level": discovery_config.get("snmp_level", "authPriv"),
    }

# Numeric OIDs (no MIB resolution needed — snmp-mibs-downloader is not installed
# by default on Debian/Ubuntu due to MIB licensing, and symbolic names fail
# silently with "Unknown Object Identifier" returning empty output).
OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0"
OID_SYS_NAME = "1.3.6.1.2.1.1.5.0"
OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0"
OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2"
OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8"
OID_IF_SPEED = "1.3.6.1.2.1.2.2.1.5"
OID_IF_IN_OCTETS = "1.3.6.1.2.1.2.2.1.10"
OID_IF_OUT_OCTETS = "1.3.6.1.2.1.2.2.1.16"


def _parse_walk_index(walk_results):
    """Parse snmpwalk results into {index: value} dict."""
    result = {}
    for oid, value in walk_results:
        # Extract last index from OID: .1.3.6.1.2.1.2.2.1.2.1 -> "1"
        idx = oid.rsplit(".", 1)[-1] if "." in oid else oid
        result[idx] = value
    return result


def discover_snmp(node_id, node_data, host_access, engine):
    """Discover interfaces and system info via SNMP (v2c or v3)."""
    discovery_config = node_data.get("discovery", {})
    version = discovery_config.get("snmp_version", 2)
    community = discovery_config.get("snmp_community", "public")
    v3 = _v3_creds_from_config(discovery_config)
    if version == 3 and not v3:
        import realm_db
        realm_db.set_discovery_capability(node_id, "snmp", False, error="SNMPv3 config invalid")
        return []

    def get(oid):
        return host_access.snmp_get(oid, community=community, version=version, v3=v3)
    def walk(oid):
        return host_access.snmp_walk(oid, community=community, version=version, v3=v3)

    # Probe SNMP availability
    sys_descr = get(OID_SYS_DESCR)
    if not sys_descr:
        import realm_db
        realm_db.set_discovery_capability(node_id, "snmp", False, error="SNMP not responding")
        return []

    sys_name = get(OID_SYS_NAME) or node_id
    sys_uptime = get(OID_SYS_UPTIME) or ""

    # Walk interface table
    if_names = _parse_walk_index(walk(OID_IF_DESCR))
    if_statuses = _parse_walk_index(walk(OID_IF_OPER_STATUS))
    if_speeds = _parse_walk_index(walk(OID_IF_SPEED))

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

        # ifOperStatus per IF-MIB: 1=up, 2=down, 3=testing, 4=unknown,
        # 5=dormant, 6=notPresent, 7=lowerLayerDown. snmpwalk -Oq returns
        # the raw integer when no MIB is loaded; older callers might also
        # see "up(1)" textual form, so accept both.
        status_raw = if_statuses.get(idx, "")
        status = "running" if status_raw.strip() == "1" or "up" in status_raw.lower() else "stopped"

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
