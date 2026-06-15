"""NUT/UPS plugin — Ward of the Battery (Issue #114).

The electrical-side mirror of the netdata per-host RAPL feed (#107/#108):
where Oracle Sight reports per-host CPU/GPU silicon draw, the Ward of the
Battery reports *whole-system / wall* power as seen by the UPSes that protect
the fleet, and links each UPS to the host(s) it powers.

Two NUT transports, auto-detected per host:

  * **Linux hosts** (Ubuntu servers — disks, familiar, nodered): upsd binds to
    localhost and config lives in /etc/nut/. Read over `host_access.ssh`:
      - `upsc -l`  / `upsc <ups>`            — UPS vars
      - `sudo -n cat /etc/nut/upsmon.conf`   — the MONITOR graph
    Hosts need discovery.ssh_user set to the fleet user (root is denied;
    see fleet.yaml jp@disks).

  * **OpenWrt hosts** (north-closet, gatekeeper, …): config is UCI, not
    /etc/nut, and upsd binds to a LAN address (so a *local* `upsc` is refused).
    Read UCI over SSH (root@) for the served UPSes + listen address, then read
    the live vars over the **NUT TCP protocol** (LIST UPS / LIST VAR, port 3493)
    directly from the map-server host — no `upsc` client required anywhere.

Aggregate watts = `ups.realpower` if the device reports it, else
`ups.load%/100 × ups.realpower.nominal`. A disconnected driver (no parseable
vars) or an unreachable upsd is reported with status + watts=None — never
crashes the discovery thread (per the #108 review: guard every response).

Surfaces (mirroring #108): GET /ups-power, status blob key `ups_power` (10s),
expose_api, a node enricher lighting the IP-less `ups` topology nodes,
GET /plugins/nut/doctor, and GET/POST /ups-topology. Aggregate UPS watts are a
*separate* key from #108's per-host RAPL — wall vs silicon, no double-count.
"""

import json
import logging
import re
import socket
import threading
import time

import realm_db
from discovery_engine import SubEntity

log = logging.getLogger(__name__)

_NS = "plugin:nut"
NUT_TCP_PORT = 3493

# NUT instance name (lowercased) -> topology `ups` node id. Operator-overridable
# via the `ups_alias` plugin setting. NUT names don't equal topology ids:
# apcupsmini1≈APCUPSMINI1 (case), and apcpro1000 has no node (intended `essence`).
# b750 / apcpro1300 have no topology node yet -> left unaliased (still surfaced).
_DEFAULT_ALIAS = {
    "apcpro1000": "essence",
    "apcupsmini1": "apcupsmini1",
    "mobileups": "mobileups",
}

# Roles whose hosts may serve a UPS — injected into discovery_engine's
# ROLE_PROVIDERS at setup() so the per-node provider is eligible without a core
# edit. Includes OpenWrt host roles (router/ap/switch/firewall/gateway).
_NUT_HOST_ROLES = ("server", "nas", "vm", "hypervisor", "desktop", "laptop",
                   "router", "ap", "switch", "firewall", "gateway")

_UPS_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# ── Per-UPS cache (single source feeding /ups-power, status, API, enricher) ──
_ups_cache = {}      # ups_name(lower) -> record dict
_monitor_map = {}    # ups_name(lower) -> set(node_ids whose upsmon MONITORs it)
_host_monitors = {}  # node_id -> [{ups, host, type}]    (for doctor)
_host_serves = {}    # node_id -> [ups_name, …]          (for doctor)
_lock = threading.Lock()
_UPS_TTL = 200  # seconds (>2 discovery intervals of 90s)


# ── Parsing / compute helpers (all guarded) ──

def _parse_upsc(text):
    """Parse `upsc` / NUT `key: value` output into a dict. Non-str -> {}."""
    out = {}
    if not isinstance(text, str):
        return out
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k = k.strip()
        if k:
            out[k] = v.strip()
    return out


def _f(vars_, key):
    v = vars_.get(key)
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _compute_watts(vars_):
    """realpower if present, else load%/100 × realpower.nominal, else None."""
    rp = _f(vars_, "ups.realpower")
    if rp is not None:
        return round(rp, 1)
    load = _f(vars_, "ups.load")
    nominal = _f(vars_, "ups.realpower.nominal")
    if load is not None and nominal is not None:
        return round(load / 100.0 * nominal, 1)
    return None


def _parse_monitor_lines(text):
    """Parse upsmon.conf `MONITOR <ups>@<host> …` lines. Non-str -> []."""
    edges = []
    if not isinstance(text, str):
        return edges
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or not s.upper().startswith("MONITOR"):
            continue
        parts = s.split()
        if len(parts) < 2 or "@" not in parts[1]:
            continue
        ups, _, host = parts[1].partition("@")
        edges.append({"ups": ups, "host": host or "localhost",
                      "type": parts[-1] if len(parts) >= 6 else ""})
    return edges


# ── NUT TCP client (for OpenWrt / network-served upsd; no upsc needed) ──

def _nut_tcp_query(addr, port, command, timeout=4):
    """Send one NUT protocol command, read until END/ERR. Returns text or None."""
    try:
        with socket.create_connection((addr, port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall((command + "\n").encode())
            buf = b""
            # Single-line replies (e.g. ERR) won't contain "END "; cap the read.
            while b"\nEND " not in buf and not buf.startswith(b"ERR ") and len(buf) < 1_000_000:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
            return buf.decode(errors="replace")
    except (OSError, socket.timeout):
        return None


def _nut_list_ups_tcp(addr, port):
    """`LIST UPS` -> [ups_name, …]. Empty list on failure/unreachable."""
    text = _nut_tcp_query(addr, port, "LIST UPS")
    if not text:
        return []
    names = []
    for line in text.splitlines():
        m = re.match(r'^UPS\s+(\S+)\s', line.strip())
        if m and _UPS_NAME_RE.match(m.group(1)):
            names.append(m.group(1))
    return names


def _nut_list_vars_tcp(addr, port, ups):
    """`LIST VAR <ups>` -> {var: value}. {} on failure."""
    text = _nut_tcp_query(addr, port, f"LIST VAR {ups}")
    out = {}
    if not text:
        return out
    for line in text.splitlines():
        m = re.match(r'^VAR\s+\S+\s+(\S+)\s+"(.*)"\s*$', line.strip())
        if m:
            out[m.group(1)] = m.group(2)
    return out


# ── OpenWrt UCI parsing ──

def _parse_uci_nut_server(text):
    """Parse `uci show nut_server` -> (ups_names, listen_addr, listen_port).

    UPS sections are `nut_server.<NAME>=driver` (skipping driver_global/upsd).
    Listen address from `nut_server.@listen_address[0].address/.port`.
    """
    if not isinstance(text, str):
        return [], None, NUT_TCP_PORT
    ups_names, addr, port = [], None, NUT_TCP_PORT
    for line in text.splitlines():
        line = line.strip()
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip().strip("'\"")
        # `nut_server.b750=driver`  (a served UPS section)
        m = re.match(r"^nut_server\.([A-Za-z0-9._-]+)$", key)
        if m and val == "driver":
            name = m.group(1)
            if name not in ("driver_global", "upsd") and _UPS_NAME_RE.match(name):
                ups_names.append(name)
        elif key.endswith(".address") and "listen_address" in key:
            addr = val or addr
        elif key.endswith(".port") and "listen_address" in key:
            try:
                port = int(val)
            except (ValueError, TypeError):
                pass
    return ups_names, addr, port


# ── Settings ──

def _ups_alias():
    override = realm_db.get_setting(_NS, "ups_alias", None)
    alias = dict(_DEFAULT_ALIAS)
    if isinstance(override, dict):
        alias.update({str(k).lower(): v for k, v in override.items()})
    return alias


def _get_ups_topology():
    v = realm_db.get_setting(_NS, "ups_topology", {})
    return v if isinstance(v, dict) else {}


def _set_ups_topology(mapping):
    realm_db.set_settings(_NS, {"ups_topology": mapping})


# ── Shared record/sub-entity builder ──

def _record_ups(ups, vars_, node_id, node_ip, now, alias, *, unreachable=False, source="nut"):
    """Build + cache a UPS record, write the alias link, return a SubEntity."""
    connected = "ups.status" in vars_ or "device.model" in vars_ or "ups.model" in vars_
    if unreachable:
        healthy, status, watts = False, "unreachable", None
    elif connected:
        healthy, status, watts = True, (vars_.get("ups.status") or "unknown"), _compute_watts(vars_)
    else:
        healthy, status, watts = False, "DISCONNECTED", None

    ups_node = alias.get(ups.lower())
    with _lock:
        monitored_by = sorted(_monitor_map.get(ups.lower(), set()))
    rec = {
        "name": ups,
        "status": status,
        "load_pct": _f(vars_, "ups.load"),
        "watts": watts,
        "realpower_nominal_w": _f(vars_, "ups.realpower.nominal"),
        "battery_charge": _f(vars_, "battery.charge"),
        "runtime_s": _f(vars_, "battery.runtime"),
        "model": vars_.get("device.model") or vars_.get("ups.model") or "",
        "healthy": healthy,
        "served_by": node_id,
        "served_by_ip": node_ip,
        "source": source,             # "nut" (ssh/upsc) | "nut-tcp" (openwrt)
        "monitored_by": monitored_by,
        "ups_node": ups_node,
        "ts": now,
    }
    with _lock:
        _ups_cache[ups.lower()] = rec

    ent_id = f"nut:{ups.lower()}"
    if ups_node:
        existing = realm_db.get_discovery_link(ent_id)
        if not existing or existing.get("linked_node_id") != ups_node:
            realm_db.set_discovery_link(ent_id, ups_node)

    return SubEntity(
        id=ent_id,
        type="nut_ups",
        name=ups,
        host_node_id=node_id,
        status="running" if healthy else "stale",
        metadata={k: rec[k] for k in (
            "status", "load_pct", "watts", "realpower_nominal_w", "battery_charge",
            "runtime_s", "model", "healthy", "served_by", "source", "monitored_by",
            "ups_node")},
    )


# ── Per-host discovery branches ──

def _discover_openwrt(node_id, node_data, host_access, now, alias):
    """OpenWrt: UCI for the served UPSes + listen address, NUT TCP for the vars."""
    uci_out, _, uci_rc = host_access.ssh("uci show nut_server 2>/dev/null", timeout=10)
    if uci_rc != 0 or not isinstance(uci_out, str) or not uci_out.strip():
        return None  # not an OpenWrt NUT host — let the caller try the Linux path

    ups_names, addr, port = _parse_uci_nut_server(uci_out)
    if not ups_names:
        return []
    addr = addr or node_data.get("ip")  # fall back to the node IP if UCI lacked one

    # Best-effort monitor graph (north-closet has none; format varies).
    mon_out, _, mon_rc = host_access.ssh("uci show nut_monitor 2>/dev/null", timeout=10)
    if mon_rc == 0 and isinstance(mon_out, str):
        mon_ups = re.findall(r"nut_monitor\.\S+\.ups='?([A-Za-z0-9._-]+)'?", mon_out)
        edges = [{"ups": u, "host": addr or node_id, "type": ""} for u in mon_ups]
        with _lock:
            _host_monitors[node_id] = edges
            for u in mon_ups:
                _monitor_map.setdefault(u.lower(), set()).add(node_id)
    with _lock:
        _host_serves[node_id] = list(ups_names)

    entities = []
    for ups in ups_names:
        vars_ = _nut_list_vars_tcp(addr, port, ups) if addr else {}
        unreachable = not vars_  # TCP refused / mgmt-VLAN-bound / timeout
        entities.append(_record_ups(ups, vars_, node_id, node_data.get("ip"), now,
                                     alias, unreachable=unreachable, source="nut-tcp"))
    return entities


def _discover_linux(node_id, node_data, host_access, now, alias):
    """Linux: localhost-bound upsd read via `upsc` over SSH + /etc/nut/upsmon.conf."""
    out, _, rc = host_access.ssh("upsc -l", timeout=10)
    if rc != 0 or not isinstance(out, str) or not out.strip():
        return []

    ups_names = [u.strip() for u in out.splitlines()
                 if u.strip() and "@" not in u and _UPS_NAME_RE.match(u.strip())]
    if not ups_names:
        return []

    mon_out, _, mon_rc = host_access.ssh(
        "sudo -n cat /etc/nut/upsmon.conf 2>/dev/null", timeout=10)
    monitor_edges = _parse_monitor_lines(mon_out) if mon_rc == 0 else []
    with _lock:
        _host_monitors[node_id] = monitor_edges
        _host_serves[node_id] = list(ups_names)
        for e in monitor_edges:
            _monitor_map.setdefault(e["ups"].lower(), set()).add(node_id)

    entities = []
    for ups in ups_names:
        sout, _, _ = host_access.ssh(f"upsc {ups}", timeout=10)
        vars_ = _parse_upsc(sout)
        entities.append(_record_ups(ups, vars_, node_id, node_data.get("ip"), now,
                                     alias, source="nut"))
    return entities


def discover_nut(node_id, node_data, host_access, engine):
    """Read NUT UPS data from a fleet host — OpenWrt (UCI+TCP) or Linux (ssh upsc)."""
    if not host_access.ssh_available():
        return []
    now = time.time()
    alias = _ups_alias()
    # OpenWrt branch first; it returns None when nut_server UCI is absent, in
    # which case we fall through to the Linux /etc/nut path.
    ow = _discover_openwrt(node_id, node_data, host_access, now, alias)
    if ow is not None:
        return ow
    return _discover_linux(node_id, node_data, host_access, now, alias)


# ── Snapshot / feed ──

_PUBLIC_FIELDS = ("name", "status", "load_pct", "watts", "realpower_nominal_w",
                  "battery_charge", "runtime_s", "model", "healthy", "served_by",
                  "served_by_ip", "source", "monitored_by", "ups_node", "ts")


def _ups_power_snapshot():
    """Fresh {ups_name: {…, powers:[host_node_ids]}}; stale entries dropped."""
    now = time.time()
    topo = _get_ups_topology()
    out = {}
    with _lock:
        recs = list(_ups_cache.items())
    for ups_l, rec in recs:
        if now - rec.get("ts", 0) > _UPS_TTL:
            continue
        entry = {k: rec.get(k) for k in _PUBLIC_FIELDS}
        declared = topo.get(rec["ups_node"]) if rec.get("ups_node") else None
        if not declared and rec.get("served_by"):
            declared = [rec["served_by"]]  # auto serve-edge fallback
        entry["powers"] = declared or []
        out[ups_l] = entry
    return out


def _get_ups_watts(ups_name):
    rec = _ups_power_snapshot().get((ups_name or "").lower())
    return rec.get("watts") if rec else None


def _doctor():
    """Diagnose NUT: disconnected/uncabled drivers, unreachable upsd, upsmon mismatches."""
    issues = []
    with _lock:
        cache = dict(_ups_cache)
        host_mon = {k: list(v) for k, v in _host_monitors.items()}
        host_srv = {k: list(v) for k, v in _host_serves.items()}

    for rec in cache.values():
        if rec.get("healthy"):
            continue
        if rec.get("status") == "unreachable":
            issues.append({"severity": "warning", "host": rec.get("served_by"),
                           "ups": rec.get("name"),
                           "issue": f"{rec.get('name')} upsd unreachable from the map server "
                                    f"(listens off-LAN?) — watts unavailable"})
        else:
            issues.append({"severity": "warning", "host": rec.get("served_by"),
                           "ups": rec.get("name"),
                           "issue": f"NUT driver for {rec.get('name')} not connected "
                                    f"(configured, no cable / USB absent) — watts unavailable"})

    # A host that MONITORs <ups>@localhost it does not itself serve = config bug.
    for node_id, mons in host_mon.items():
        served = {s.lower() for s in host_srv.get(node_id, [])}
        for e in mons:
            if e["host"] in ("localhost", node_id) and e["ups"].lower() not in served:
                issues.append({"severity": "error", "host": node_id, "ups": e["ups"],
                               "issue": (f"upsmon MONITORs {e['ups']}@{e['host']} but this host "
                                         f"serves {sorted(served) or 'no UPS'} — name mismatch")})

    return {"ok": not issues, "issues": issues, "checked": len(cache)}


# ── Node enricher: light up the IP-less `ups` topology nodes ──

def _enrich_ups_node(node_id, node_data):
    snap = _ups_power_snapshot()
    rec = next((r for r in snap.values() if r.get("ups_node") == node_id), None)
    if not rec:
        return None
    if rec.get("healthy"):
        parts = [rec.get("status") or "?"]
        if rec.get("battery_charge") is not None:
            parts.append(f"{int(rec['battery_charge'])}%")
        if rec.get("watts") is not None:
            parts.append(f"{rec['watts']:.0f}W")
        return {"sublabel": " · ".join(parts), "badge": "\U0001f50b"}
    return {"sublabel": "⚠ driver offline", "badge": "\U0001f50b", "status_class": "ups-offline"}


# ── HTTP handlers ──

def handle_ups_power(req, params):
    """GET /ups-power — live UPS load/watts + host linkage for every reachable UPS."""
    req.respond(_ups_power_snapshot())


def handle_doctor(req, params):
    """GET /plugins/nut/doctor — NUT health diagnosis."""
    req.respond(_doctor())


def handle_ups_topology(req, params):
    """GET/POST /ups-topology — read or declare the {ups_node:[hosts]} powers map."""
    if req.method == "POST":
        body = req.json()
        mapping = body.get("ups_topology", body) if isinstance(body, dict) else None
        if not isinstance(mapping, dict):
            return req.respond({"error": "expected {ups_node: [host_node_ids]}"}, 400)
        clean = {str(k): [str(h) for h in v] for k, v in mapping.items() if isinstance(v, list)}
        _set_ups_topology(clean)
        return req.respond({"ok": True, "ups_topology": clean})
    return req.respond(_get_ups_topology())


# ── Status provider ──

def _ups_power_status_provider():
    return {"ups_power": _ups_power_snapshot()}


def setup(ctx):
    # Make the per-node provider eligible on NUT-host roles without a core edit:
    # inject "nut" into discovery_engine.ROLE_PROVIDERS at load (idempotent).
    try:
        import discovery_engine
        for role in _NUT_HOST_ROLES:
            provs = discovery_engine.ROLE_PROVIDERS.setdefault(role, [])
            if "nut" not in provs:
                provs.append("nut")
    except Exception:
        ctx.log("nut: could not register role providers (non-fatal)")

    ctx.register_discovery_provider(
        name="nut",
        roles=list(_NUT_HOST_ROLES),
        discover_fn=discover_nut,
        interval=90,
        entity_types=["nut_ups"],
        priority=35,
    )

    ctx.register_status_provider(_ups_power_status_provider)
    # Priority 30 — below the discovery enricher (35) so a live UPS reading wins
    # over the generic "N infrastructure" count on the `ups` node. Returns None
    # for every non-UPS node, so it never shadows other sublabels.
    ctx.register_node_enricher(_enrich_ups_node, priority=30)
    ctx.expose_api({
        "get_ups_power": _ups_power_snapshot,
        "get_ups_watts": _get_ups_watts,
        "get_ups_topology": _get_ups_topology,
        "doctor": _doctor,
    })

    ctx.log("Ward of the Battery active — NUT/UPS discovery (Linux ssh + OpenWrt "
            "UCI/TCP) + power feed (/ups-power, status.ups_power)")
