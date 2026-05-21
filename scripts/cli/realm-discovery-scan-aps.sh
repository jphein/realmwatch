#!/usr/bin/env bash
# realm-discovery-scan-aps — sweep a subnet for OpenWrt boxes not in fleet.yaml.
#
# Parallel TCP-22 probe across the subnet, then SSH-fingerprint each responder.
# Cross-references with fleet.yaml via a three-key matcher (MAC, ops_ip, name)
# and dedupes by MAC so a single host on multiple IPs (VRRP VIP + primary IP)
# is reported once. Prints ready-to-paste `realm fleet add` commands for each
# unknown.
#
# Usage:
#   realm discovery scan-aps [--subnet 10.0.6.0/24] [--include-known]
set -euo pipefail

REALM_HELP_SUMMARY="Sweep a subnet for OpenWrt boxes not yet in fleet.yaml"

realm::help() {
  cat <<'EOF'
realm discovery scan-aps — find OpenWrt boxes not yet registered

USAGE:
  realm discovery scan-aps [OPTIONS]

OPTIONS:
  --subnet CIDR        Subnet to sweep. Default: 10.0.6.0/24
                       (must be /22 or smaller for safety)
  --include-known      Also list APs that are already in fleet.yaml
                       (useful for verifying coverage)

WHAT IT DOES:
  1. Parallel TCP-22 probe across the subnet (fast).
  2. SSH-fingerprint each responder: pulls /etc/openwrt_release, br-lan MAC,
     hostname, and model in one round-trip per host.
  3. Classifies as "already in fleet" if any of MAC, ops_ip, or hostname
     matches a fleet.yaml entry. Dedupes by MAC (handles VRRP VIPs).
  4. Prints ready-to-paste `realm fleet add` commands for each unknown.

EXAMPLES:
  realm discovery scan-aps
  realm discovery scan-aps --subnet 10.0.10.0/24
  realm discovery scan-aps --include-known
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Default subnet = the /24 surrounding gatekeeper's ops_ip (i.e. the admin
# VLAN). Resolved via realm_fleet rather than hardcoded so a different host
# layout doesn't require editing this file. Override with --subnet.
subnet=""
include_known=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subnet)
      [[ $# -ge 2 ]] || realm::die "--subnet requires a value" 2
      subnet="$2"; shift 2 ;;
    --subnet=*) subnet="${1#*=}"; shift ;;
    --include-known) include_known=1; shift ;;
    *) realm::die "unknown arg: $1" 2 ;;
  esac
done

"$REALM_PYTHON" - "$subnet" "$include_known" <<'PY' || exit $?
import ipaddress
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

import realm_fleet

subnet_str, include_known_str = sys.argv[1:3]
include_known = include_known_str == "1"

if not subnet_str:
    # Default to the /24 around gatekeeper's ops_ip (the admin VLAN). This
    # keeps the styleguide invariant (no hardcoded subnets) and adapts to
    # different host layouts without editing the script.
    gk_ip = realm_fleet.host_ip("gatekeeper")
    if gk_ip and re.match(r"^\d+\.\d+\.\d+\.\d+$", gk_ip):
        subnet_str = ".".join(gk_ip.split(".")[:3]) + ".0/24"
    else:
        print("error: no --subnet given and could not derive default from "
              "realm_fleet.host_ip('gatekeeper'). Pass --subnet CIDR.",
              file=sys.stderr)
        sys.exit(2)

try:
    net = ipaddress.ip_network(subnet_str, strict=False)
except ValueError as e:
    print(f"error: bad --subnet {subnet_str!r}: {e}", file=sys.stderr)
    sys.exit(2)
if net.num_addresses > 1024:
    print(f"error: subnet too large ({net.num_addresses} addresses); "
          f"use a /22 or smaller for safety", file=sys.stderr)
    sys.exit(2)

# Three-criterion known-set: a probe counts as "known" if its MAC, IP, or
# hostname matches any catalog entry. Needed because (a) APs often have
# several MACs (one per radio) and the br-lan MAC may not match the one
# stored as fleet_id, (b) hosts like gatekeeper use a UUID fleet_id so the
# MAC isn't in fleet_id at all — match by ops_ip instead.
cat = realm_fleet._catalog()
known_macs: set[str] = set()
known_ips: set[str] = set()
known_names: set[str] = set()
if cat is not None:
    for e in cat.entries:
        if e.fleet_id.startswith("mac:"):
            known_macs.add(e.fleet_id.split(":", 1)[1].lower())
        if getattr(e, "ops_ip", None):
            known_ips.add(e.ops_ip)
        known_names.add(e.current_name)
        for p in (e.prior_names or []):
            known_names.add(p.name)

ssh_opts = ["-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no"]

print(f"sweeping {subnet_str} ({net.num_addresses} addresses, "
      f"{'incl known' if include_known else 'unknown only'})...")

# Step 1: parallel TCP-22 probe. ICMP is unreliable on locked-down hosts;
# port 22 RST or accept is a faster + more reliable OpenWrt-shaped probe.
def _tcp22_open(ip: str, timeout: float = 1.0) -> bool:
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, 22))
        s.close()
        return True
    except (socket.timeout, ConnectionRefusedError, OSError):
        return False

candidates: list[str] = []
with ThreadPoolExecutor(max_workers=64) as pool:
    futs = {pool.submit(_tcp22_open, str(ip)): str(ip) for ip in net.hosts()}
    for fut in as_completed(futs):
        if fut.result():
            candidates.append(futs[fut])
candidates.sort(key=lambda s: tuple(int(p) for p in s.split(".")))
print(f"  {len(candidates)} hosts have TCP/22 open")

# Step 2: probe each candidate via SSH (dropbear + openwrt fingerprint).
def _probe(ip: str) -> dict | None:
    p = subprocess.run(
        ["ssh", *ssh_opts, f"root@{ip}",
         "cat /etc/openwrt_release 2>/dev/null; echo ---; "
         "cat /sys/class/net/br-lan/address 2>/dev/null "
         "  || cat /sys/class/net/eth0/address 2>/dev/null; echo ---; "
         "uci -q get system.@system[0].hostname || hostname; echo ---; "
         "cat /tmp/sysinfo/model 2>/dev/null"],
        capture_output=True, text=True, timeout=8,
    )
    if p.returncode != 0:
        return None
    parts = p.stdout.split("---")
    if len(parts) < 4:
        return None
    release, mac, hostname, model = (s.strip() for s in parts[:4])
    if "OpenWrt" not in release and "openwrt" not in release.lower():
        return None
    if not re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", mac.lower()):
        return None
    return {"ip": ip, "mac": mac.lower(), "hostname": hostname or ip,
            "model": model or "(unknown)",
            "release": release.splitlines()[0] if release else "(unknown)"}

probes: list[dict] = []
with ThreadPoolExecutor(max_workers=16) as pool:
    futs = {pool.submit(_probe, ip): ip for ip in candidates}
    for fut in as_completed(futs):
        r = fut.result()
        if r is not None:
            probes.append(r)
probes.sort(key=lambda d: tuple(int(p) for p in d["ip"].split(".")))

def _is_known(p: dict) -> bool:
    return (p["mac"] in known_macs
            or p["ip"] in known_ips
            or p["hostname"] in known_names)

# Dedupe by MAC: if the same MAC appears at multiple IPs (VRRP VIP + primary,
# or a multi-NIC host with several addresses), collapse to one entry.
# Preference: IP that matches a known ops_ip > lowest IP otherwise. This
# keeps the canonical IP that fleet.yaml already knows about.
canonical: dict[str, dict] = {}
for p in probes:
    cur = canonical.get(p["mac"])
    if cur is None:
        canonical[p["mac"]] = p
        continue
    cur_known = cur["ip"] in known_ips
    new_known = p["ip"] in known_ips
    if new_known and not cur_known:
        canonical[p["mac"]] = p
    elif new_known == cur_known:
        if tuple(int(x) for x in p["ip"].split(".")) < tuple(int(x) for x in cur["ip"].split(".")):
            canonical[p["mac"]] = p

probes = list(canonical.values())
probes.sort(key=lambda d: tuple(int(p) for p in d["ip"].split(".")))

unknown = [p for p in probes if not _is_known(p)]
known = [p for p in probes if _is_known(p)]

print()
print(f"OpenWrt boxes found:    {len(probes)}")
print(f"  already in fleet:     {len(known)}")
print(f"  NOT in fleet (new):   {len(unknown)}")
print()

if unknown:
    print("=== New OpenWrt candidates — copy/paste to register ===")
    for p in unknown:
        print(f"  realm fleet add {p['ip']} --name {p['hostname']} --yes  "
              f"# mac={p['mac']} model={p['model']}")
    print()

if include_known and known:
    print("=== Already in fleet (info) ===")
    for p in known:
        print(f"  {p['ip']:<14}  {p['hostname']:<24}  mac={p['mac']}")
PY
