# Autodiscovery Phase 4 — Health Monitoring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add health monitoring plugins — HTTP health, TCP/UDP ports, TLS expiry, realm-sigil versions, game server status, and Netdata agent discovery. These replace the manual checks in status.realm.watch with auto-discovered endpoints.

**Depends on:** Phase 1 (core engine), Phase 3 (Caddy/Docker/systemd provide endpoints to check)

**Estimated tasks:** 3

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (sections: health, game-servers, netdata plugins)

---

## File Structure

| File | Changes |
|------|---------|
| `plugins/health/plugin.json` | New — manifest for health monitoring plugin |
| `plugins/health/plugin.py` | New — HTTP, TCP, UDP, TLS, realm-sigil checks |
| `plugins/game-servers/plugin.json` | New — manifest for game server plugin |
| `plugins/game-servers/plugin.py` | New — Minecraft Bedrock + Terraria status |
| `plugins/netdata/plugin.json` | New — manifest for Netdata agent plugin |
| `plugins/netdata/plugin.py` | New — Netdata REST API discovery |

---

## Task 1: Health Plugin ("Watchtower Beacon")

**Files:** `plugins/health/plugin.json`, `plugins/health/plugin.py`

**Description:** The core health monitoring plugin. Instead of a manual URL list, it auto-discovers what to check from other discovery providers' results. Caddy reverse proxy domains get HTTP health checks. Docker published ports get TCP checks. Systemd listening ports get TCP checks. Topology nodes with `url` fields get HTTP checks. External service nodes (Vercel, GCP, etc.) get HTTP checks via public URL. Manual additions via `discovery.health_endpoints` config.

**This is the plugin that subsumes status.realm.watch's checks.json.**

**Key code — endpoint auto-discovery:**

```python
def _discover_endpoints(engine):
    """Auto-discover health check endpoints from other providers' results."""
    endpoints = []
    for entity in engine.get_sub_entities():
        if entity["type"] == "reverse_proxy":
            # Caddy domain → HTTP health check
            domain = entity["metadata"].get("domain", "")
            scheme = "https" if entity["metadata"].get("tls") else "http"
            endpoints.append({
                "type": "http", "url": f"{scheme}://{domain}",
                "host_node_id": entity["host_node_id"],
                "source": f"caddy:{entity['id']}",
            })
        elif entity["type"] == "container":
            # Docker published ports → TCP checks
            for port_str in entity["metadata"].get("ports", []):
                port = int(port_str.split("/")[0])
                endpoints.append({
                    "type": "tcp", "host": entity["metadata"].get("ip", ""),
                    "port": port, "host_node_id": entity["host_node_id"],
                    "source": f"docker:{entity['id']}",
                })
        elif entity["type"] == "service":
            # Systemd listening ports → TCP checks
            for port in entity["metadata"].get("listening_ports", []):
                endpoints.append({
                    "type": "tcp", "host": "", "port": port,
                    "host_node_id": entity["host_node_id"],
                    "source": f"systemd:{entity['id']}",
                })
    return endpoints
```

**Key code — health checks:**

```python
import httpx, socket, ssl, datetime

def _check_http(url, timeout_ms=5000):
    """HTTP health check. Returns SubEntity-ready dict."""
    try:
        resp = httpx.get(url, timeout=timeout_ms/1000, verify=False, follow_redirects=True)
        status = "healthy" if resp.status_code < 400 else "degraded"
        result = {"status_code": resp.status_code, "response_ms": int(resp.elapsed.total_seconds()*1000)}
        # Check for realm-sigil version
        if "/api/version" not in url:
            try:
                ver = httpx.get(url.rstrip("/") + "/api/version", timeout=3, verify=False)
                if ver.status_code == 200:
                    result["version"] = ver.json()
            except: pass
        return status, result
    except Exception as e:
        return "unreachable", {"error": str(e)}

def _check_tcp(host, port, timeout_ms=5000):
    """TCP port check."""
    try:
        sock = socket.create_connection((host, port), timeout=timeout_ms/1000)
        sock.close()
        return "open", {"port": port, "response_ms": 0}  # TODO: measure time
    except:
        return "closed", {"port": port}

def _check_tls_expiry(hostname, port=443):
    """Check TLS certificate expiry date."""
    try:
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(socket.socket(), server_hostname=hostname) as s:
            s.settimeout(5)
            s.connect((hostname, port))
            cert = s.getpeercert()
            expiry = datetime.datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z")
            return expiry.isoformat()
    except:
        return None
```

**Key code — main discover function:**

```python
def discover_health(node_id, node_data, host_access, engine):
    """Run health checks for auto-discovered and manual endpoints."""
    entities = []
    endpoints = _discover_endpoints(engine)
    # Also add manual endpoints from node config
    manual = node_data.get("discovery", {}).get("health_endpoints", [])
    for ep in manual:
        endpoints.append({**ep, "host_node_id": node_id, "source": "manual"})
    # Also check node URL if present
    url = node_data.get("url")
    if url:
        endpoints.append({"type": "http", "url": url, "host_node_id": node_id, "source": "topology"})

    for ep in endpoints:
        if ep.get("host_node_id") != node_id:
            continue  # only check endpoints belonging to this node
        if ep["type"] == "http":
            status, meta = _check_http(ep["url"])
            tls_expiry = _check_tls_expiry(ep["url"].split("//")[1].split("/")[0]) if ep["url"].startswith("https") else None
            if tls_expiry:
                meta["tls_expiry"] = tls_expiry
            meta["url"] = ep["url"]
            entities.append(SubEntity(
                id=f"health:{node_id}:{ep['type']}-{ep['url'].split('//')[1].split('/')[0]}",
                type="http_health", name=ep["url"].split("//")[1].split("/")[0],
                host_node_id=node_id, status=status, metadata=meta,
            ))
        elif ep["type"] == "tcp":
            host = ep.get("host") or host_access.ip
            status, meta = _check_tcp(host, ep["port"])
            entities.append(SubEntity(
                id=f"health:{node_id}:tcp-{ep['port']}",
                type="tcp_port", name=f"{node_id}:{ep['port']}",
                host_node_id=node_id, status=status, metadata=meta,
            ))
    return entities
```

**Scan intervals:** 30s for HTTP/TCP, 300s for version/TLS checks. Use two providers or a fast/slow split within the discover function.

- [ ] Step 1: Create `plugins/health/plugin.json`
- [ ] Step 2: Implement endpoint auto-discovery from other providers
- [ ] Step 3: Implement HTTP, TCP, TLS, realm-sigil health checks
- [ ] Step 4: Register as discovery provider with cross-provider engine access
- [ ] Step 5: Test — verify auto-discovered Caddy domains get checked
- [ ] Step 6: Compare coverage with status.realm.watch checks.json
- [ ] Step 7: Commit

---

## Task 2: Game Servers Plugin ("Arena Watcher")

**Files:** `plugins/game-servers/plugin.json`, `plugins/game-servers/plugin.py`

**Description:** Discover game server status on configured nodes. Specific to JP's setup: 3 Minecraft Bedrock servers (ports 19132, 8888, 8890) and 1 Terraria server on terra2 (20.228.117.200). Uses protocol-specific queries — Minecraft Bedrock uses UDP ping packets, Terraria uses TCP status. Only activates for nodes with `discovery.game_servers` config.

**Key code:**

```python
import socket, struct

def _ping_bedrock(host, port, timeout=5):
    """Minecraft Bedrock server ping via UDP."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    # Unconnected ping packet (Bedrock protocol)
    packet = b"\x01" + struct.pack(">q", 0) + b"\x00\xff\xff\x00\xfe\xfe\xfe\xfe\xfd\xfd\xfd\xfd\x12\x34\x56\x78"
    try:
        sock.sendto(packet, (host, port))
        data, _ = sock.recvfrom(4096)
        # Parse response: fields separated by ';'
        fields = data[35:].decode("utf-8", errors="replace").split(";")
        return {
            "motd": fields[1] if len(fields) > 1 else "",
            "version": fields[3] if len(fields) > 3 else "",
            "players_online": int(fields[4]) if len(fields) > 4 else 0,
            "max_players": int(fields[5]) if len(fields) > 5 else 0,
        }
    except: return None
    finally: sock.close()

def discover_game_servers(node_id, node_data, host_access, engine):
    """Discover game servers on configured nodes."""
    servers = node_data.get("discovery", {}).get("game_servers", [])
    entities = []
    for srv in servers:
        game = srv.get("game", "unknown")
        port = srv.get("port", 0)
        host = host_access.ip
        if game == "minecraft_bedrock":
            result = _ping_bedrock(host, port)
            status = "running" if result else "offline"
            entities.append(SubEntity(
                id=f"game:{node_id}:mc-bedrock-{port}",
                type="game_server", name=f"{node_id} Minecraft Bedrock",
                host_node_id=node_id, status=status,
                metadata={"game": game, "port": port, **(result or {})},
            ))
        elif game == "terraria":
            # TCP connect check
            try:
                s = socket.create_connection((host, port), timeout=5); s.close()
                status = "running"
            except: status = "offline"
            entities.append(SubEntity(
                id=f"game:{node_id}:terraria-{port}",
                type="game_server", name=f"{node_id} Terraria",
                host_node_id=node_id, status=status,
                metadata={"game": game, "port": port},
            ))
    return entities
```

**Node config example:**
```json
{
    "id": "terra2", "ip": "20.228.117.200",
    "discovery": {
        "game_servers": [
            {"game": "minecraft_bedrock", "port": 19132},
            {"game": "minecraft_bedrock", "port": 8888},
            {"game": "minecraft_bedrock", "port": 8890}
        ]
    }
}
```

- [ ] Step 1: Create `plugins/game-servers/plugin.json`
- [ ] Step 2: Implement Bedrock UDP ping and Terraria TCP check
- [ ] Step 3: Register as discovery provider (no role-based dispatch — config-only)
- [ ] Step 4: Test against terra2
- [ ] Step 5: Commit

---

## Task 3: Netdata Plugin ("Oracle Sight")

**Files:** `plugins/netdata/plugin.json`, `plugins/netdata/plugin.py`

**Description:** Discover Netdata agent instances via REST API. Supplements collectd with richer metrics. Polls `/api/v1/info` (lightweight, 30s) for agent status and `/api/v1/charts` (heavier, 300s) for chart enumeration. Cross-references with collectd — if both monitor a host, Netdata takes sublabel priority. Also discovers which collectors are active per host.

**Key code:**

```python
def discover_netdata(node_id, node_data, host_access, engine):
    """Discover Netdata agent via REST API."""
    resp = host_access.http_get(19999, "/api/v1/info")
    if not resp or resp["status"] != 200:
        return []
    import json
    info = json.loads(resp["body"])
    collectors = [c.get("plugin", "") for c in info.get("collectors", [])]
    unique_collectors = list(set(c for c in collectors if c))
    entity = SubEntity(
        id=f"netdata:{node_id}:agent",
        type="netdata_host",
        name=node_id,
        host_node_id=node_id,
        status="running",
        metadata={
            "version": info.get("version", ""),
            "os": info.get("os_name", ""),
            "collectors": unique_collectors,
            "alarms_critical": info.get("alarms", {}).get("critical", 0),
            "alarms_warning": info.get("alarms", {}).get("warning", 0),
        },
    )
    # Optionally get chart count (heavier)
    charts_resp = host_access.http_get(19999, "/api/v1/charts")
    if charts_resp and charts_resp["status"] == 200:
        charts = json.loads(charts_resp["body"])
        entity.metadata["charts_count"] = len(charts.get("charts", {}))
    return [entity]

# setup(ctx):
ctx.register_discovery_provider(
    name="netdata", roles=["server", "vm", "hypervisor", "desktop", "router"],
    discover_fn=discover_netdata, interval=30,
    entity_types=["netdata_host"], priority=30,
)
# Also register node enricher for Netdata sublabels (priority above collectd)
```

- [ ] Step 1: Create `plugins/netdata/plugin.json`
- [ ] Step 2: Implement `discover_netdata()` with info + charts API calls
- [ ] Step 3: Register as discovery provider + node enricher
- [ ] Step 4: Test against forge (local Netdata) and any remote hosts
- [ ] Step 5: Commit

---

## What's Next

Phase 5 adds inventory and code awareness — GitHub repos, local project directories, and a manual entry plugin for non-discoverable infrastructure.
