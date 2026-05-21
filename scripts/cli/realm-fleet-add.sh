#!/usr/bin/env bash
# realm-fleet-add — probe a host and append it to fleet.yaml.
#
# Validates the target is reachable, SSH responds with dropbear, and (if
# category=ap) confirms it's running OpenWrt. Pulls the MAC and hostname
# off the device, builds a FleetEntry, and saves fleet.yaml.
#
# Usage: realm fleet add <ip|hostname> [--name N] [--category C] [--realm R] [--yes]
#
# Idempotent: if the MAC already exists in fleet.yaml, prints the existing
# entry and exits 0 without rewriting.
set -euo pipefail

REALM_HELP_SUMMARY="Probe a host and add it to fleet.yaml"

realm::help() {
  cat <<'EOF'
realm fleet add — register a new host with the fleet catalog

USAGE:
  realm fleet add <ip|hostname> [OPTIONS]

ARGUMENTS:
  <ip|hostname>           Where to SSH (must be reachable via key auth)

OPTIONS:
  --name NAME             current_name for the entry. Default: detected hostname.
  --category C            ap | switch_openwrt | switch_vendor | router | host.
                          Default: ap
  --realm R               Realm tag. Default: signal
  --notes TEXT            Free-text notes attached to the entry
  --yes                   Skip the y/n confirmation prompt
  --json                  Output the resulting entry as JSON (after save)

EXAMPLES:
  realm fleet add 10.0.6.115                          # interactive
  realm fleet add north-attic --name north-attic --yes
  realm fleet add 10.0.6.200 --category switch_openwrt --name pump-switch
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

if [[ $# -lt 1 ]]; then
  realm::die "missing target (ip or hostname)" 2
fi

target="$1"; shift
name_override=""
category="ap"
realm_tag="signal"
notes=""
skip_confirm=0
emit_json=0

while (( $# > 0 )); do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || realm::die "--name requires a value" 2
      name_override="$2"; shift 2 ;;
    --name=*) name_override="${1#--name=}"; shift ;;
    --category)
      [[ $# -ge 2 ]] || realm::die "--category requires a value" 2
      category="$2"; shift 2 ;;
    --category=*) category="${1#--category=}"; shift ;;
    --realm)
      [[ $# -ge 2 ]] || realm::die "--realm requires a value" 2
      realm_tag="$2"; shift 2 ;;
    --realm=*) realm_tag="${1#--realm=}"; shift ;;
    --notes)
      [[ $# -ge 2 ]] || realm::die "--notes requires a value" 2
      notes="$2"; shift 2 ;;
    --notes=*) notes="${1#--notes=}"; shift ;;
    --yes|-y) skip_confirm=1; shift ;;
    --json) emit_json=1; shift ;;
    *) realm::die "unknown flag: $1" 2 ;;
  esac
done

# Hand the rest to Python: probe + write + audit.
"$REALM_PYTHON" - "$target" "$name_override" "$category" "$realm_tag" "$notes" "$skip_confirm" "$emit_json" <<'PY' || exit $?
import json
import re
import subprocess
import sys
import datetime
from pathlib import Path

import realm_fleet
from lexicon import FleetEntry, FleetPriorName

target, name_override, category, realm_tag, notes_arg, skip_confirm_str, emit_json_str = sys.argv[1:8]
skip_confirm = skip_confirm_str == "1"
emit_json = emit_json_str == "1"

VALID_CATEGORIES = {"ap", "switch_openwrt", "switch_vendor", "router", "host"}
if category not in VALID_CATEGORIES:
    print(f"error: --category must be one of {sorted(VALID_CATEGORIES)}", file=sys.stderr)
    sys.exit(2)

ssh_opts = ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes"]

def _ssh(host: str, cmd: str) -> tuple[int, str, str]:
    p = subprocess.run(["ssh", *ssh_opts, f"root@{host}", cmd],
                       capture_output=True, text=True, timeout=15)
    return p.returncode, p.stdout.strip(), p.stderr.strip()

print(f"probing {target!r}...")

# 1. SSH reachability + identity probe (single round-trip).
probe_cmd = (
    "echo '---openwrt_release---'; cat /etc/openwrt_release 2>/dev/null; "
    "echo '---mac---'; cat /sys/class/net/br-lan/address 2>/dev/null "
    "  || cat /sys/class/net/eth0/address 2>/dev/null; "
    "echo '---hostname---'; uci -q get system.@system[0].hostname || hostname; "
    "echo '---model---'; cat /tmp/sysinfo/model 2>/dev/null; "
    "echo '---kernel---'; uname -srm"
)
rc, out, err = _ssh(target, probe_cmd)
if rc != 0:
    print(f"error: ssh to {target} failed: {err or '(no stderr)'}", file=sys.stderr)
    sys.exit(3)

sections: dict[str, str] = {}
current = None
buf: list[str] = []
for line in out.splitlines():
    m = re.match(r"^---([a-z_]+)---$", line)
    if m:
        if current is not None:
            sections[current] = "\n".join(buf).strip()
        current = m.group(1); buf = []
    else:
        buf.append(line)
if current is not None:
    sections[current] = "\n".join(buf).strip()

mac = sections.get("mac", "").lower()
if not re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", mac):
    print(f"error: couldn't read MAC from {target} (got {mac!r})", file=sys.stderr)
    sys.exit(4)

hostname = sections.get("hostname", "").strip() or target
openwrt = sections.get("openwrt_release", "")
is_openwrt = "OpenWrt" in openwrt or "openwrt" in openwrt
if category == "ap" and not is_openwrt:
    print(f"error: target {target} (mac={mac}) does not report OpenWrt — "
          f"refuse to register as category=ap. Use --category host or fix the target.",
          file=sys.stderr)
    sys.exit(5)

# 2. Idempotence: bail early if MAC already in catalog.
fleet_id = f"mac:{mac}"
cat = realm_fleet._catalog()
if cat is None:
    print("error: fleet catalog unavailable (lexicon import or fleet.yaml missing)", file=sys.stderr)
    sys.exit(6)
existing = cat.resolve(fleet_id)
if existing is not None:
    print(f"note: {fleet_id} already registered as {existing.current_name!r} "
          f"(category={existing.category}, status={existing.status}) — no change")
    if emit_json:
        print(json.dumps({"already_existed": True, "fleet_id": fleet_id,
                          "current_name": existing.current_name}))
    sys.exit(0)

# 3. Build the new entry.
name = name_override or hostname
if not re.match(r"^[A-Za-z0-9_-]+$", name):
    print(f"error: name {name!r} must match [A-Za-z0-9_-]+", file=sys.stderr)
    sys.exit(7)
today = datetime.date.today().isoformat()
entry = FleetEntry(
    fleet_id=fleet_id,
    current_name=name,
    prior_names=[],
    realm=realm_tag,
    category=category,
    ops_ip=target if re.match(r"^\d+\.\d+\.\d+\.\d+$", target) else None,
    status="curated",
    notes=notes_arg or None,
    first_seen=today,
    last_seen=today,
)

# 4. Show plan + confirm.
print()
print(f"plan: append to {cat.source_path}")
print(f"  fleet_id      {entry.fleet_id}")
print(f"  current_name  {entry.current_name}")
print(f"  category      {entry.category}")
print(f"  realm         {entry.realm}")
print(f"  ops_ip        {entry.ops_ip or '(name-resolved)'}")
print(f"  OS            {openwrt.splitlines()[0] if openwrt else '(unknown)'}")
print(f"  model         {sections.get('model','(unknown)')}")
print(f"  kernel        {sections.get('kernel','(unknown)')}")

if not skip_confirm:
    try:
        ans = input("\nProceed? [y/N] ").strip().lower()
    except EOFError:
        ans = ""
    if ans != "y":
        print("aborted")
        sys.exit(0)

# 5. Append + save.
cat.entries.append(entry)
cat._reindex()
cat.save()
realm_fleet.invalidate()
print(f"\n✓ saved {cat.source_path}")

# 6. If AP, run audit against just this entry (best-effort).
audit_summary = None
if category == "ap":
    print()
    print(f"running audit on {entry.current_name}...")
    audit = subprocess.run(
        ["realm", "fleet", "ap-firewall-audit", entry.current_name, "--json"],
        capture_output=True, text=True, timeout=30,
    )
    audit_summary = audit.stdout.strip() or audit.stderr.strip()
    print(audit_summary[:400])

if emit_json:
    print(json.dumps({
        "fleet_id": entry.fleet_id,
        "current_name": entry.current_name,
        "category": entry.category,
        "ops_ip": entry.ops_ip,
        "saved_to": str(cat.source_path),
    }))
PY
