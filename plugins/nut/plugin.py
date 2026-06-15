"""NUT/UPS plugin — Ward of the Battery (Issue #114).

The electrical-side mirror of the netdata per-host RAPL feed (#107/#108):
where Oracle Sight reports per-host CPU/GPU silicon draw, the Ward of the
Battery reports *whole-system / wall* power as seen by the UPSes that protect
the fleet, and links each UPS to the host(s) it powers.

Data source: Network UPS Tools (NUT). upsd binds to localhost on each serving
host and the map-server host has no `upsc` client, so we read over
`host_access.ssh` (passwordless SSH as the fleet user — see discovery
`ssh_user`, e.g. `jp`):
  - `upsc -l`            — enumerate UPSes served by that host's upsd
  - `upsc <ups>`         — ups.status / ups.load / ups.realpower[.nominal] /
                           battery.charge / battery.runtime / device.model
  - `sudo -n cat /etc/nut/upsmon.conf` — the `MONITOR <ups>@<host>` graph

Aggregate watts = `ups.realpower` if the device reports it, else
`ups.load%/100 × ups.realpower.nominal`. A disconnected driver (no parseable
vars) is reported with status + watts=None — never crashes the discovery
thread (per the #108 review: guard every parsed response).

Surfaces (mirroring #108):
  - GET /ups-power            — {ups: {status, load_pct, watts, …, powers:[hosts]}}
  - status blob key `ups_power` (10s) via register_status_provider
  - expose_api(get_ups_power, get_ups_watts, get_ups_topology)
  - a node enricher that finally lights up the IP-less `ups` topology nodes
  - GET /plugins/nut/doctor   — flags disconnected drivers + upsmon mismatches
  - GET/POST /ups-topology    — declared "this UPS powers hosts X,Y,Z" map

Aggregate UPS watts are deliberately a *separate* key from #108's per-host
RAPL — different scope (wall vs silicon), do not double-count.
"""

import json
import logging
import re
import threading
import time

import realm_db
from discovery_engine import SubEntity

log = logging.getLogger(__name__)

# Settings namespace (operator-declared powers map lives here).
_NS = "plugin:nut"

# NUT instance name (lowercased) -> topology `ups` node id.
# NUT names don't equal topology ids: apcupsmini1≈APCUPSMINI1 (case), and
# apcpro1000 has no node of its own (intended as `essence`). Operator-overridable
# via the `ups_alias` plugin setting.
_DEFAULT_ALIAS = {
    "apcpro1000": "essence",
    "apcupsmini1": "apcupsmini1",
    "mobileups": "mobileups",
}

# Only these characters are allowed in a UPS name we feed to a shell command.
_UPS_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# ── Per-UPS cache (the single source feeding /ups-power, status, API) ──
# ups_name(lower) -> record dict. Written by the discovery thread, read by the
# endpoint/status/API/enricher. Mirrors netdata's _power_cache pattern.
_ups_cache = {}
_monitor_map = {}   # ups_name(lower) -> set(node_ids whose upsmon MONITORs it)
_host_monitors = {}  # node_id -> [{ups, host, type}]   (for doctor)
_host_serves = {}    # node_id -> [ups_name, …]          (for doctor)
_lock = threading.Lock()
# UPS data older than this ages out of the feed (>2 discovery intervals of 60s).
_UPS_TTL = 150  # seconds


# ── Parsing helpers (all guarded — a flaky agent must never crash discovery) ──

def _parse_upsc(text):
    """Parse `upsc` `key: value` output into a dict. Non-str -> {}."""
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
    """Float value for `key` in a upsc var dict, or None."""
    v = vars_.get(key)
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _compute_watts(vars_):
    """Aggregate watts: realpower if present, else load%/100 × realpower.nominal."""
    rp = _f(vars_, "ups.realpower")
    if rp is not None:
        return round(rp, 1)
    load = _f(vars_, "ups.load")
    nominal = _f(vars_, "ups.realpower.nominal")
    if load is not None and nominal is not None:
        return round(load / 100.0 * nominal, 1)
    return None


def _parse_monitor_lines(text):
    """Parse `MONITOR <ups>@<host> <pv> <user> <pass> <master|slave>` lines.

    Returns [{ups, host, type}], skipping comments/garbage. Non-str -> [].
    """
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


# ── Settings: operator-declared powers map + alias overrides ──

def _ups_alias():
    override = realm_db.get_setting(_NS, "ups_alias", None)
    alias = dict(_DEFAULT_ALIAS)
    if isinstance(override, dict):
        alias.update({str(k).lower(): v for k, v in override.items()})
    return alias


def _get_ups_topology():
    """Declared {ups_node: [host_node_ids]} membership map."""
    v = realm_db.get_setting(_NS, "ups_topology", {})
    return v if isinstance(v, dict) else {}


def _set_ups_topology(mapping):
    realm_db.set_settings(_NS, {"ups_topology": mapping})


# ── Discovery provider ──

def discover_nut(node_id, node_data, host_access, engine):
    """Read NUT UPS data + monitor graph from a fleet host via SSH."""
    # ssh_available() does an fping + `ssh echo ok` probe (cached). Nodes need
    # discovery.ssh_user set to the fleet user (e.g. jp) — root is denied on the
    # Ubuntu hosts. Unreachable / no-NUT hosts simply yield nothing.
    if not host_access.ssh_available():
        return []

    out, _, rc = host_access.ssh("upsc -l", timeout=10)
    if rc != 0 or not isinstance(out, str) or not out.strip():
        return []  # NUT client absent or no UPSes here

    ups_names = [u.strip() for u in out.splitlines()
                 if u.strip() and "@" not in u and _UPS_NAME_RE.match(u.strip())]
    if not ups_names:
        return []

    # Harvest the upsmon MONITOR graph (needs sudo; non-fatal if unavailable).
    mon_out, _, mon_rc = host_access.ssh(
        "sudo -n cat /etc/nut/upsmon.conf 2>/dev/null", timeout=10)
    monitor_edges = _parse_monitor_lines(mon_out) if mon_rc == 0 else []

    alias = _ups_alias()
    now = time.time()
    entities = []

    with _lock:
        _host_monitors[node_id] = monitor_edges
        _host_serves[node_id] = list(ups_names)
        # This host monitors these UPSes (self-loops, by NUT convention "powered by").
        for e in monitor_edges:
            _monitor_map.setdefault(e["ups"].lower(), set()).add(node_id)

    for ups in ups_names:
        sout, serr, _ = host_access.ssh(f"upsc {ups}", timeout=10)
        vars_ = _parse_upsc(sout)
        # A connected driver reports ups.status (or at least a model). Anything
        # else (e.g. "Error: Driver not connected" on stderr) is a dead driver.
        connected = "ups.status" in vars_ or "device.model" in vars_ or "ups.model" in vars_
        ups_node = alias.get(ups.lower())

        if connected:
            healthy = True
            status = vars_.get("ups.status") or "unknown"
            watts = _compute_watts(vars_)
        else:
            healthy = False
            status = (serr or "").strip().splitlines()[-1] if (serr or "").strip() else "driver not connected"
            # Normalise the common case to a short token.
            if "not connected" in status.lower():
                status = "DISCONNECTED"
            watts = None

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
            "served_by_ip": node_data.get("ip"),
            "monitored_by": monitored_by,
            "ups_node": ups_node,
            "ts": now,
        }
        with _lock:
            _ups_cache[ups.lower()] = rec

        # Link the nut_ups sub-entity to its topology `ups` node via the alias
        # map — this resolves both the empty ups-node stats and the HA-orphaned
        # telemetry. set_discovery_link is a manual-override link (wins in the
        # auto-linker); only (re)write it when it would change.
        ent_id = f"nut:{ups.lower()}"
        if ups_node:
            existing = realm_db.get_discovery_link(ent_id)
            if not existing or existing.get("linked_node_id") != ups_node:
                realm_db.set_discovery_link(ent_id, ups_node)

        entities.append(SubEntity(
            id=ent_id,
            type="nut_ups",
            name=ups,
            host_node_id=node_id,           # the NUT host that serves this UPS
            status="running" if healthy else "stale",
            metadata={
                "status": status,
                "load_pct": rec["load_pct"],
                "watts": watts,
                "realpower_nominal_w": rec["realpower_nominal_w"],
                "battery_charge": rec["battery_charge"],
                "runtime_s": rec["runtime_s"],
                "model": rec["model"],
                "healthy": healthy,
                "served_by": node_id,
                "monitored_by": monitored_by,
                "ups_node": ups_node,
            },
        ))

    return entities


# ── Snapshot / feed ──

_PUBLIC_FIELDS = ("name", "status", "load_pct", "watts", "realpower_nominal_w",
                  "battery_charge", "runtime_s", "model", "healthy",
                  "served_by", "served_by_ip", "monitored_by", "ups_node", "ts")


def _ups_power_snapshot():
    """Fresh {ups_name: {…, powers:[host_node_ids]}}; stale entries dropped.

    `powers` = the operator-declared membership for this UPS's topology node,
    falling back to the auto-seeded serve-edge ([serving host]).
    """
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
    """Latest watts for one UPS (or None) — for the exposed plugin API."""
    rec = _ups_power_snapshot().get((ups_name or "").lower())
    return rec.get("watts") if rec else None


def _doctor():
    """Diagnose NUT health: disconnected drivers + upsmon name mismatches."""
    issues = []
    with _lock:
        cache = dict(_ups_cache)
        host_mon = {k: list(v) for k, v in _host_monitors.items()}
        host_srv = {k: list(v) for k, v in _host_serves.items()}

    for ups_l, rec in cache.items():
        if not rec.get("healthy"):
            issues.append({
                "severity": "warning",
                "host": rec.get("served_by"),
                "ups": rec.get("name"),
                "issue": f"NUT driver for {rec.get('name')} not connected (watts unavailable)",
            })

    # A host that MONITORs <ups>@localhost it does not itself serve = config bug
    # (e.g. familiar: MONITOR APCBU1400@localhost but upsd serves MOBILEUPS).
    for node_id, mons in host_mon.items():
        served = {s.lower() for s in host_srv.get(node_id, [])}
        for e in mons:
            if e["host"] in ("localhost", node_id) and e["ups"].lower() not in served:
                issues.append({
                    "severity": "error",
                    "host": node_id,
                    "ups": e["ups"],
                    "issue": (f"upsmon MONITORs {e['ups']}@{e['host']} but this host "
                              f"serves {sorted(served) or 'no UPS'} — name mismatch"),
                })

    return {"ok": not issues, "issues": issues, "checked": len(cache)}


# ── Node enricher: light up the IP-less `ups` topology nodes ──

def _enrich_ups_node(node_id, node_data):
    """Give `ups` topology nodes a live sublabel from NUT (they have no IP, so
    the core sublabel pipeline otherwise skips them)."""
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
    return {"sublabel": "⚠ driver offline", "badge": "\U0001f50b",
            "status_class": "ups-offline"}


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
        # Coerce to {str: [str,…]}, ignore junk.
        clean = {}
        for k, v in mapping.items():
            if isinstance(v, list):
                clean[str(k)] = [str(h) for h in v]
        _set_ups_topology(clean)
        return req.respond({"ok": True, "ups_topology": clean})
    return req.respond(_get_ups_topology())


# ── Status provider ──

def _ups_power_status_provider():
    """Fold UPS power into the 10s status blob under `ups_power`."""
    return {"ups_power": _ups_power_snapshot()}


def setup(ctx):
    # Discovery runs on NUT-HOST roles (where upsd/upsc live), NOT the `ups`
    # role — ups nodes have no IP and run nothing. Hosts need discovery.ssh_user
    # set to the fleet user (root is denied on Ubuntu); see fleet.yaml (jp@disks).
    ctx.register_discovery_provider(
        name="nut",
        roles=["server", "nas", "vm", "hypervisor", "desktop", "router"],
        discover_fn=discover_nut,
        interval=60,
        entity_types=["nut_ups"],
        priority=35,
    )

    # First-class UPS power feed (mirror of #108's /host-power). The GET
    # endpoints are wired from the manifest `endpoints` block.
    ctx.register_status_provider(_ups_power_status_provider)
    # Priority 30 — below the discovery enricher (35) so a live UPS reading wins
    # over the generic "N infrastructure" sub-entity count on the `ups` node.
    # Returns None for every non-UPS node, so it never shadows other sublabels.
    ctx.register_node_enricher(_enrich_ups_node, priority=30)
    ctx.expose_api({
        "get_ups_power": _ups_power_snapshot,
        "get_ups_watts": _get_ups_watts,
        "get_ups_topology": _get_ups_topology,
        "doctor": _doctor,
    })

    ctx.log("Ward of the Battery active — NUT/UPS discovery + power feed "
            "(/ups-power, status.ups_power)")
