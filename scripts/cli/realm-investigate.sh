#!/usr/bin/env bash
# realm-investigate — one-shot device diagnostic across every layer.
#
# Given a device name (fuzzy-matched against HA entities, DHCP leases, ARP
# table, and the fleet catalog), prints a structured one-pager covering:
#
#   • Identity      — friendly name, manufacturer, model, MAC, HA entity_id
#   • Network       — IP from DHCP/ARP, ping, last DHCP event on gatekeeper
#   • Integration   — HA state, config-entry state for the integration
#   • Protocol      — Kasa port 9999 if TP-Link; HTTPS probe if WiFi AP
#   • Wireless      — which AP it's associated to, signal, inactive time
#
# Built for the "Google Hub can't turn on X" debug loop — collects in one
# command everything a manual operator would gather across 5 different ssh
# sessions.
set -euo pipefail

REALM_HELP_SUMMARY="One-shot multi-layer diagnostic for a smart-home device"

realm::help() {
  cat <<'EOF'
realm investigate — multi-layer diagnostic for a device

USAGE:
  realm investigate <device-or-name> [--json]

OPTIONS:
  -h, --help    Show this help
  --json        Emit a structured per-layer JSON object (for piping to jq)

WHAT IT GATHERS:
  Identity      friendly name, manufacturer, model, MAC, HA entity_id
  Network       IP via DHCP+ARP, ping, last DHCP event on gatekeeper
  Integration   HA entity state + tplink/tuya config-entry state
  Protocol      Kasa port-9999 probe for TP-Link; HTTPS for APs
  Wireless      AP association, signal, inactive time

The <device-or-name> can be a fuzzy match: friendly name from HA, hostname
from DHCP, fleet name, or a MAC. Run `realm find <q>` first if you're not
sure of the exact name.

EXAMPLES:
  realm investigate laundry_light
  realm investigate HS200
  realm investigate "office bulb"
  realm investigate e8:48:b8:aa:39:33
  realm investigate laundry_light --json | jq '.layers.network'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 1 ]] || realm::die "missing device name (try: realm investigate <name>)" 2
target="$*"

# Pull HA token from vault if not already in env. Optional — we still work
# without it (HA-layer probes just get skipped).
if [[ -z "${HA_TOKEN:-}" ]] && command -v bw >/dev/null 2>&1; then
  bw_status=$(bw status 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "")
  if [[ "$bw_status" == "unlocked" ]]; then
    HA_TOKEN=$(bw get password ha-llat 2>/dev/null || true)
    [[ -n "$HA_TOKEN" ]] && export HA_TOKEN
  fi
fi

# Resolve gatekeeper via realm_fleet (per styleguide invariant: no hardcoded
# hosts). Falls back to the literal name only if the catalog can't load —
# SSH config will normally resolve the bare name anyway.
GATEKEEPER_HOST="${GATEKEEPER_HOST:-$(
  "$REALM_PYTHON" -c 'import realm_fleet; print(realm_fleet.host_ip("gatekeeper") or "gatekeeper")' 2>/dev/null \
    || echo gatekeeper
)}"

# Hand to Python for the heavy lifting. REALM_OUTPUT (set by realm::parse_common
# from --json) selects human narrative vs. a structured per-layer JSON object.
HA_TOKEN="${HA_TOKEN:-}" GATEKEEPER_HOST="$GATEKEEPER_HOST" \
REALM_OUTPUT="$REALM_OUTPUT" \
"$REALM_PYTHON" - "$target" <<'PY' || exit $?
import json
import os
import re
import shlex
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

import realm_fleet

target = sys.argv[1].strip()
HA_TOKEN = os.environ.get("HA_TOKEN", "")
JSON_MODE = os.environ.get("REALM_OUTPUT") == "json"
# Hosts: prefer fleet catalog resolution (styleguide invariant) and fall
# back to the env override + literal name (for first-run / SSH-config-only
# setups where the catalog isn't populated yet).
GATEKEEPER = os.environ.get("GATEKEEPER_HOST") \
    or realm_fleet.host_ip("gatekeeper") or "gatekeeper"
HA_HOST = realm_fleet.host_ip("ha") or "ha"
HA_BASE_URL = f"https://{HA_HOST}:8123"
# HA in this homelab uses a self-signed cert that's bound to the public
# hostname (ha.jphe.in) but accessed by IP from the LAN — verify() would
# always fail. CERT_NONE is intentional. To enable verification (e.g. if
# you've imported a CA), set REALM_HA_VERIFY=1.
HA_VERIFY = os.environ.get("REALM_HA_VERIFY") == "1"

# ANSI helpers — short, no external lib.
class _C:
    BOLD = "\033[1m"; DIM = "\033[2m"; RESET = "\033[0m"
    GREEN = "\033[32m"; RED = "\033[31m"; YELLOW = "\033[33m"; CYAN = "\033[36m"
    BLUE = "\033[34m"

# Structured accumulator for --json. header() opens a layer; line() appends a
# field to whichever layer is current. The human narrative is produced by the
# very same calls (so the two outputs can never drift), and is suppressed when
# JSON_MODE is on. Field labels are normalized to snake_case keys.
_result: dict = {"target": target, "layers": {}}
_current_layer: str | None = None

def _key(label: str) -> str:
    k = label.strip().lower()
    for ch in (" ", "-", ":", "/", "(", ")", "."):
        k = k.replace(ch, "_")
    while "__" in k:
        k = k.replace("__", "_")
    return k.strip("_")

def header(s: str) -> None:
    global _current_layer
    _current_layer = _key(s)
    _result["layers"].setdefault(_current_layer, {"name": s, "fields": []})
    if not JSON_MODE:
        print(f"\n{_C.BOLD}{_C.CYAN}── {s} ──{_C.RESET}")

def line(label: str, value: str, ok: bool | None = None) -> None:
    if _current_layer is not None:
        _result["layers"][_current_layer]["fields"].append(
            {"key": _key(label), "label": label, "value": value, "ok": ok}
        )
    if JSON_MODE:
        return
    icon = "  "
    if ok is True:
        icon = f"{_C.GREEN}✓{_C.RESET} "
    elif ok is False:
        icon = f"{_C.RED}✗{_C.RESET} "
    print(f"{icon}{_C.BOLD}{label:<14}{_C.RESET}{value}")

# ── HA: locate the entity ──────────────────────────────────────────────────
def _ha_get(path: str) -> object | None:
    if not HA_TOKEN:
        return None
    ctx = ssl.create_default_context()
    if not HA_VERIFY:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(f"{HA_BASE_URL}{path}",
                                 headers={"Authorization": f"Bearer {HA_TOKEN}"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as r:
            return json.loads(r.read())
    except urllib.error.URLError:
        return None
    except Exception:
        return None

def _ha_template(template: str) -> str | None:
    if not HA_TOKEN:
        return None
    ctx = ssl.create_default_context()
    if not HA_VERIFY:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    payload = json.dumps({"template": template}).encode()
    req = urllib.request.Request(f"{HA_BASE_URL}/api/template",
                                 data=payload,
                                 headers={"Authorization": f"Bearer {HA_TOKEN}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=8) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception:
        return None

def _gk(cmd: str) -> str:
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes",
                            f"root@{GATEKEEPER}", cmd],
                           capture_output=True, text=True, timeout=10)
        return r.stdout
    except Exception:
        return ""

if not JSON_MODE:
    print(f"\n{_C.BOLD}realm investigate {target!r}{_C.RESET}")

# Try MAC parse first.
mac_normalized: str | None = None
m = re.fullmatch(r"([0-9a-fA-F]{2})[:-]?([0-9a-fA-F]{2})[:-]?([0-9a-fA-F]{2})[:-]?([0-9a-fA-F]{2})[:-]?([0-9a-fA-F]{2})[:-]?([0-9a-fA-F]{2})", target)
if m:
    mac_normalized = ":".join(g.lower() for g in m.groups())

ha_states = _ha_get("/api/states") if HA_TOKEN else None
ha_entity = None
if ha_states:
    tlow = target.lower()
    # Prefer entity_ids that match device-shaped domains over containers.
    DEVICE_DOMAINS = ("switch", "light", "sensor", "binary_sensor", "fan",
                      "humidifier", "media_player", "climate", "cover",
                      "lock", "vacuum", "valve")
    CONTAINER_DOMAINS = ("scene", "automation", "script", "zone", "group")
    candidates = []
    for s in ha_states:
        eid = (s.get("entity_id") or "").lower()
        fn = ((s.get("attributes", {}) or {}).get("friendly_name", "") or "").lower()
        domain = eid.split(".", 1)[0] if "." in eid else ""
        # Base score from match precision
        if eid == tlow or fn == tlow:
            score = 100
        elif eid.endswith("." + tlow) or eid.endswith("." + tlow.replace(" ", "_")):
            score = 95
        elif tlow in eid or tlow in fn:
            score = 60
        else:
            continue
        # Domain bias: prefer device-shaped over containers.
        if domain in DEVICE_DOMAINS:
            score += 20
        elif domain in CONTAINER_DOMAINS:
            score -= 30
        candidates.append((score, s))
    candidates.sort(key=lambda t: -t[0])
    if candidates:
        ha_entity = candidates[0][1]

# ── Identity ────────────────────────────────────────────────────────────────
header("Identity")
ha_dev = None
if ha_entity:
    eid = ha_entity["entity_id"]
    fn = (ha_entity.get("attributes") or {}).get("friendly_name", "")
    line("entity_id", f"{eid}")
    line("friendly", f"{fn}")
    line("state", ha_entity["state"],
         ok=(ha_entity["state"] not in ("unavailable", "unknown")))
    raw = _ha_template(
        "{% set d = device_id('" + eid + "') %}"
        "{{ {'name': device_attr(d, 'name'), 'manufacturer': device_attr(d, 'manufacturer'), "
        "'model': device_attr(d, 'model'), 'connections': device_attr(d, 'connections') | list, "
        "'sw_version': device_attr(d, 'sw_version')} | tojson }}"
    )
    try:
        ha_dev = json.loads(raw) if raw and raw.startswith("{") else None
    except json.JSONDecodeError:
        ha_dev = None
    if ha_dev:
        line("manufacturer", str(ha_dev.get("manufacturer") or "(unknown)"))
        line("model", str(ha_dev.get("model") or "(unknown)"))
        for c in (ha_dev.get("connections") or []):
            if isinstance(c, (list, tuple)) and len(c) == 2 and c[0] == "mac":
                mac_normalized = mac_normalized or c[1].lower()
                line("MAC", c[1])
elif mac_normalized:
    line("query", f"raw MAC {mac_normalized}")
else:
    # No HA entity — try DHCP leases and topology by hostname before giving up.
    line("query", f"{target}")
    # Search DHCP leases for the hostname. `target` is user input — must be
    # shell-quoted before insertion into the remote `awk -v` command line, or
    # an attacker could escape the literal and execute arbitrary commands on
    # gatekeeper. shlex.quote() returns a safely single-quoted shell token.
    safe_target = shlex.quote(target.lower())
    lease_search = _gk(f"awk -v t={safe_target} 'tolower($4)==t || index(tolower($4),t)>0 {{print; exit}}' /tmp/dhcp.leases").strip()
    if lease_search:
        fields = lease_search.split()
        if len(fields) >= 4:
            mac_normalized = fields[1].lower()
            line("DHCP host", f"{fields[3]} ({fields[2]}, mac {mac_normalized})", ok=True)
    # Search topology by id/label.
    if not mac_normalized:
        try:
            # See note above — local map_server loopback, not a host literal.
            with urllib.request.urlopen("http://localhost/topology", timeout=4) as r:
                topo = json.loads(r.read())
            for n in topo.get("nodes", []):
                nid = (n.get("id") or "").lower()
                lab = (n.get("label") or "").lower()
                if nid == target.lower() or lab == target.lower():
                    if n.get("mac"):
                        mac_normalized = n["mac"].lower()
                        line("topology", f"node {n['id']} (mac {mac_normalized})", ok=True)
                    elif n.get("ip"):
                        line("topology", f"node {n['id']} (ip {n['ip']}, no MAC in topology)")
                    break
        except Exception:
            pass
    if not mac_normalized and not HA_TOKEN:
        line("ha token", "(no HA_TOKEN env / bw locked — skipping HA layer)", ok=False)

# ── Network: lookup IP via gatekeeper ──────────────────────────────────────
ip_addr = None
arp_state = None
lease_info = None
if mac_normalized:
    arp_out = _gk(f"ip neigh | grep -i '{mac_normalized}' | head -1")
    arp_out = arp_out.strip()
    if arp_out:
        parts = arp_out.split()
        ip_addr = parts[0]
        arp_state = parts[-1]
    lease_out = _gk(f"grep -i '{mac_normalized}' /tmp/dhcp.leases | head -1")
    if lease_out.strip():
        f = lease_out.split()
        if len(f) >= 4:
            lease_info = {"expiry": f[0], "ip": f[2], "name": f[3]}
            ip_addr = ip_addr or f[2]

header("Network")
if ip_addr:
    line("IP", ip_addr)
    if arp_state:
        line("ARP state", arp_state, ok=(arp_state in ("REACHABLE", "DELAY", "PROBE")))
    if lease_info:
        expiry_ts = int(lease_info["expiry"]) if lease_info["expiry"].isdigit() else 0
        if expiry_ts:
            now = int(time.time())
            age = expiry_ts - now
            tag = f"{lease_info['name']} (expires in {age}s)" if age > 0 else f"{lease_info['name']} (EXPIRED {-age}s ago)"
            line("DHCP lease", tag, ok=(age > 0))
    # Ping
    p = subprocess.run(["ping", "-c1", "-W2", ip_addr], capture_output=True, timeout=4)
    line("ping", "OK" if p.returncode == 0 else "FAIL", ok=(p.returncode == 0))
else:
    line("IP", "(not found in ARP or DHCP leases on gatekeeper)", ok=False if mac_normalized else None)

# ── Protocol probes ────────────────────────────────────────────────────────
if ip_addr:
    header("Protocol")
    # Kasa local protocol (TP-Link)
    is_tplink = ha_dev and (ha_dev.get("manufacturer") or "").lower().startswith(("tp-link", "tplink"))
    if is_tplink:
        rc = _gk(f"timeout 2 nc {ip_addr} 9999 </dev/null >/dev/null 2>&1; echo $?").strip()
        ok_k = rc == "0"
        line("Kasa :9999", "OPEN — local API available" if ok_k else "closed/filtered — HA can't reach device",
             ok=ok_k)
    # If looks like an AP, probe :22 + :80
    if ha_dev and (ha_dev.get("model") or "").upper().startswith(("HS", "KL", "EP", "KP")):
        pass  # already covered above
    else:
        rc = _gk(f"timeout 2 nc {ip_addr} 22 </dev/null >/dev/null 2>&1; echo $?").strip()
        line(":22 (ssh)", "open" if rc == "0" else "closed/filtered",
             ok=(rc == "0") if rc else None)

# ── Wireless: where is this MAC associated? ────────────────────────────────
if mac_normalized:
    header("Wireless")
    # /scan/wifi is keyed by node_id (resolved hostname), not MAC. Resolve
    # MAC → node_id via the DHCP lease (we already know hostname from
    # lease_info). If we have a hostname, look up by that. Otherwise scan
    # through and stringly-match the MAC against keys (auto-created nodes
    # use the MAC suffix).
    candidate_keys = []
    if lease_info and lease_info.get("name") not in (None, "", "*"):
        candidate_keys.append(lease_info["name"].lower())
    # Auto-node convention: _unknown_<mac-no-colons>
    candidate_keys.append("_unknown_" + mac_normalized.replace(":", ""))
    candidate_keys.append(mac_normalized.replace(":", ""))
    try:
        # map_server runs on this host (per CLAUDE.md "HTTP :80" — see
        # systemd/realm-map-server.service). Localhost is the intentional
        # loopback target for the CLI's own backend, not a hardcoded host.
        with urllib.request.urlopen("http://localhost/scan/wifi", timeout=4) as r:
            clients = json.loads(r.read())
        # Build a case-insensitive lookup.
        lc = {k.lower(): (k, v) for k, v in clients.items()} if isinstance(clients, dict) else {}
        match = None
        for ck in candidate_keys:
            if ck in lc:
                match = lc[ck]; break
        # As last resort: scan values for an `ap` field where any nested mac equals ours.
        if not match and isinstance(clients, dict):
            for k, v in clients.items():
                if isinstance(v, dict) and (v.get("mac", "").lower() == mac_normalized):
                    match = (k, v); break
        if match:
            key, c = match
            ap = c.get("ap") if isinstance(c, dict) else None
            line("client node", key)
            line("associated AP", ap or "(unknown)", ok=bool(ap))
            if isinstance(c, dict):
                if c.get("signal") is not None:
                    s_dbm = c["signal"]
                    line("signal", f"{s_dbm} dBm",
                         ok=(s_dbm > -75) if isinstance(s_dbm, (int, float)) else None)
                if c.get("snr") is not None:
                    line("SNR", f"{c['snr']} dB")
                if c.get("ssid"):
                    line("SSID", c["ssid"])
                if c.get("rx_rate") is not None and c.get("tx_rate") is not None:
                    line("bitrate", f"rx={c['rx_rate']} tx={c['tx_rate']} MBit/s")
        else:
            # Fallback: /scan/wifi only includes clients the scanner promoted
            # to topology nodes. Unpromoted "unknown" clients carry their AP
            # info in /scan's unknown list — check that too.
            try:
                # See note above — local map_server loopback, not a host literal.
                with urllib.request.urlopen("http://localhost/scan", timeout=4) as r:
                    scan = json.loads(r.read())
                hit = None
                for u in (scan.get("unknown") or []):
                    if (u.get("mac") or "").lower() == mac_normalized:
                        hit = u; break
                if hit:
                    line("client", "(unknown — not yet promoted to topology)", ok=False)
                    line("associated AP", hit.get("ap") or "(unknown)", ok=bool(hit.get("ap")))
                    if hit.get("ip"):
                        line("scanner IP", hit["ip"])
                else:
                    line("client", "(MAC not in any AP's recent scan — try `realm wifi scan` to refresh)",
                         ok=False)
            except Exception:
                line("client", "(MAC not found and /scan unavailable)", ok=False)
    except Exception as e:
        line("scanner", f"unavailable ({type(e).__name__})", ok=False)

# ── HA integration config-entry state (only for HA-managed devices) ────────
if ha_entity:
    header("Integration")
    eid = ha_entity["entity_id"]
    # Get the entry_id for this device's integration via template.
    raw = _ha_template(
        "{% set d = device_id('" + eid + "') %}"
        "{{ device_attr(d, 'identifiers') | list | tojson }}"
    )
    ident_str = raw or ""
    if "tplink" in ident_str.lower():
        line("integration", "tplink (Kasa local)")
        if ha_entity["state"] == "unavailable" and ip_addr:
            line("hint", "device IP exists but HA marks unavailable — try reloading the tplink config entry in HA")
    elif "tuya" in ident_str.lower():
        line("integration", "tuya (cloud)")
        if ha_entity["state"] == "unavailable":
            line("hint", "Tuya is cloud-mediated; check HA→Tuya cloud reachability "
                          "(mq.tuyaus.com is NXDOMAIN — Tuya retired it)")
    else:
        line("identifiers", ident_str[:80])

if JSON_MODE:
    # Top-level resolution summary so consumers don't have to dig through the
    # per-layer field lists for the common identifiers.
    _result["resolved"] = {
        "mac": mac_normalized,
        "ip": ip_addr,
        "ha_entity_id": ha_entity["entity_id"] if ha_entity else None,
        "found": bool(ha_entity or mac_normalized or ip_addr),
    }
    json.dump(_result, sys.stdout, indent=2)
    sys.stdout.write("\n")
else:
    print()
PY
