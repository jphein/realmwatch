"""Game server discovery plugin — Arena Watcher.

Discovers game server status on configured nodes. Supports Minecraft Bedrock
(UDP ping protocol) and Terraria (TCP connect check).
Only activates for nodes with discovery.game_servers config.
"""

import logging
import socket
import struct
from discovery_engine import SubEntity

log = logging.getLogger(__name__)


def _ping_bedrock(host, port, timeout=5):
    """Minecraft Bedrock server ping via UDP unconnected ping."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    # Raknet unconnected ping
    packet = (
        b"\x01"  # ID_UNCONNECTED_PING
        + struct.pack(">q", 0)  # client timestamp
        + b"\x00\xff\xff\x00\xfe\xfe\xfe\xfe\xfd\xfd\xfd\xfd\x12\x34\x56\x78"  # magic
    )
    try:
        sock.sendto(packet, (host, port))
        data, _ = sock.recvfrom(4096)
        # Response starts at byte 35, fields separated by ';'
        payload = data[35:].decode("utf-8", errors="replace")
        fields = payload.split(";")
        return {
            "edition": fields[0] if len(fields) > 0 else "",
            "motd": fields[1] if len(fields) > 1 else "",
            "protocol": fields[2] if len(fields) > 2 else "",
            "version": fields[3] if len(fields) > 3 else "",
            "players_online": int(fields[4]) if len(fields) > 4 and fields[4].isdigit() else 0,
            "max_players": int(fields[5]) if len(fields) > 5 and fields[5].isdigit() else 0,
            "server_name": fields[7] if len(fields) > 7 else "",
            "gamemode": fields[8] if len(fields) > 8 else "",
        }
    except socket.timeout:
        return None
    except Exception as e:
        log.debug("Bedrock ping failed for %s:%d: %s", host, port, e)
        return None
    finally:
        sock.close()


def _check_tcp(host, port, timeout=5):
    """Simple TCP connect check."""
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.close()
        return True
    except Exception:
        return False


def discover_game_servers(node_id, node_data, host_access, engine):
    """Discover game servers on configured nodes."""
    servers = node_data.get("discovery", {}).get("game_servers", [])
    if not servers:
        return []

    host = host_access.ip
    if not host:
        return []

    entities = []
    for srv in servers:
        game = srv.get("game", "unknown")
        port = srv.get("port", 0)
        name = srv.get("name", "")
        if not port:
            continue

        if game == "minecraft_bedrock":
            result = _ping_bedrock(host, port)
            status = "running" if result else "offline"
            display_name = name or f"Minecraft Bedrock :{port}"
            metadata = {"game": game, "port": port}
            if result:
                metadata.update(result)
                if result.get("players_online", 0) > 0:
                    display_name += f" ({result['players_online']}/{result['max_players']})"
            entities.append(SubEntity(
                id=f"game:{node_id}:bedrock-{port}",
                type="game_server",
                name=display_name,
                host_node_id=node_id,
                status=status,
                metadata=metadata,
            ))

        elif game == "terraria":
            up = _check_tcp(host, port)
            status = "running" if up else "offline"
            entities.append(SubEntity(
                id=f"game:{node_id}:terraria-{port}",
                type="game_server",
                name=name or f"Terraria :{port}",
                host_node_id=node_id,
                status=status,
                metadata={"game": game, "port": port},
            ))

        else:
            # Generic TCP check for unknown game types
            up = _check_tcp(host, port)
            status = "running" if up else "offline"
            entities.append(SubEntity(
                id=f"game:{node_id}:{game}-{port}",
                type="game_server",
                name=name or f"{game} :{port}",
                host_node_id=node_id,
                status=status,
                metadata={"game": game, "port": port},
            ))

    return entities


def setup(ctx):
    # Game servers only activate on nodes with explicit config
    # Use broad roles but discover_game_servers returns [] if no config
    from discovery_engine import ROLE_PROVIDERS
    all_roles = list(ROLE_PROVIDERS.keys())

    ctx.register_discovery_provider(
        name="game-servers",
        roles=all_roles,
        discover_fn=discover_game_servers,
        interval=60,
        entity_types=["game_server"],
        priority=75,
    )
    ctx.log("Arena Watcher active — game server monitoring registered (interval=60s)")
