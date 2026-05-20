#!/usr/bin/env bash
# realm-zones — manage fw4 zone names on the realm's firewall device.
#
# Zones are loaded from gitignored zones.yaml via lexicon.ZoneCatalog.
# `realm zones list` and `show` are read-only catalog lookups.
# `realm zones rename` is the heavy lift: defaults to a DRY-RUN that prints
# every uci/fw4 command and yaml mutation that would happen; pass --commit
# to actually execute (with uci export backup beforehand, roll back on any
# failure).
set -euo pipefail

REALM_HELP_SUMMARY="Manage fw4 zone names on the firewall (list, show, rename)"
REALM_SUBCOMMANDS="list
show
rename"

realm::help() {
  cat <<'EOF'
realm zones — manage fw4/nftables zone names on the firewall device

USAGE:
  realm zones [SUBCOMMAND]

SUBCOMMANDS:
  list                              Show every zone (default)
  show <name>                       Show details for one zone (resolves prior names)
  rename <old> <new> [--reason T]   Rename a zone — catalog + uci + fw4 reload
                                    (dry-run by default; --commit to execute)

OPTIONS:
  --json                            Emit raw JSON (list/show only)
  --reason "..."                    Annotate a rename
  --commit                          Actually execute rename (default: dry-run)
  --host HOST                       Override SSH target (default: catalog's host=)
  --no-vlans-update                 Don't propagate the rename into vlans.yaml

EXAMPLES:
  realm zones                                      # list
  realm zones show home                            # resolves prior names
  realm zones rename lan cameras --reason "match VLAN 10"
                                                   # dry-run: prints the plan
  realm zones rename lan cameras --reason "..." --commit
                                                   # actually does it

NOTES:
  rename's plan: backup uci → mutate every reference (name, src, dest in
  zone/forwarding/redirect/rule) → fw4 check + fw4 reload → update
  zones.yaml prior_names → update vlans.yaml `zone:` references → on any
  failure: uci import the backup and fw4 reload.
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Emit the catalog as JSON.
_emit_zones_json() {
  "$REALM_PYTHON" - <<'PY'
import json, sys
try:
    import realm_zones
except Exception as e:
    print(json.dumps({"error": f"realm_zones load failed: {e}"}), file=sys.stderr)
    sys.exit(3)
rows = []
for e in realm_zones.all_entries():
    rows.append({
        "current_name": e.current_name,
        "type": e.type or "",
        "notes": e.notes or "",
        "prior_names": [{"name": p.name, "retired_on": p.retired_on, "reason": p.reason} for p in e.prior_names],
    })
out = {"host": (realm_zones.catalog().host if realm_zones.catalog() else None), "zones": rows}
print(json.dumps(out))
PY
}

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    raw=$(_emit_zones_json)
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s' "$raw"
    else
      printf '%s' "$raw" | jq -r '"host: \(.host // "?")"'
      printf '%s' "$raw" | jq -r '.zones | (["NAME","TYPE","PRIORS","NOTES"] | @tsv),
        (.[] | [
          .current_name,
          (if .type == "" then "-" else .type end),
          (if (.prior_names | length) == 0 then "-" else (.prior_names | map(.name) | join(",")) end),
          (.notes // "")
        ] | @tsv)' | column -t -s $'\t'
    fi
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "missing zone name (e.g. realm zones show lan)" 2
    target="$1"
    match=$("$REALM_PYTHON" - "$target" <<'PY'
import json, sys
import realm_zones
e = realm_zones.resolve(sys.argv[1])
if not e:
    sys.exit(0)
print(json.dumps({
    "current_name": e.current_name,
    "type": e.type or "",
    "notes": e.notes or "",
    "prior_names": [{"name": p.name, "retired_on": p.retired_on, "reason": p.reason} for p in e.prior_names],
}))
PY
)
    [[ -n "$match" ]] || realm::die "no zone resolves to $target" 1
    printf '%s' "$match" | realm::fmt_kv
    ;;
  rename)
    [[ $# -ge 2 ]] || realm::die "usage: realm zones rename <old> <new> [--reason T] [--commit]" 2
    old_name="$1"; shift
    new_name="$1"; shift
    [[ -n "$old_name" && -n "$new_name" ]] || realm::die "old and new names must be non-empty" 2

    commit=0
    reason=""
    host_override=""
    no_vlans_update=0
    while (( $# > 0 )); do
      case "$1" in
        --commit) commit=1; shift ;;
        --reason)
          [[ $# -ge 2 ]] || realm::die "--reason requires a value" 2
          reason="$2"; shift 2 ;;
        --reason=*) reason="${1#--reason=}"; shift ;;
        --host)
          [[ $# -ge 2 ]] || realm::die "--host requires a value" 2
          host_override="$2"; shift 2 ;;
        --no-vlans-update) no_vlans_update=1; shift ;;
        *) realm::die "unknown flag: $1" 2 ;;
      esac
    done

    # Delegate the full plan + execution to a python helper. It computes the
    # uci commands, SSHes to gatekeeper if --commit, updates yaml files, and
    # rolls back on failure.
    "$REALM_PYTHON" - "$old_name" "$new_name" "$reason" "$commit" "$host_override" "$no_vlans_update" <<'PY' || exit $?
import sys
import subprocess
import shlex
import datetime
from pathlib import Path

import realm_zones
import realm_vlans

old_name, new_name, reason, commit_str, host_override, no_vlans_str = sys.argv[1:7]
commit = commit_str == "1"
no_vlans_update = no_vlans_str == "1"

cat = realm_zones.catalog()
if cat is None:
    print("error: zone catalog unavailable", file=sys.stderr)
    sys.exit(3)

target = cat.resolve(old_name)
if target is None:
    print(f"error: no zone named {old_name!r} (current or prior)", file=sys.stderr)
    sys.exit(1)
if target.current_name != old_name:
    print(f"note: {old_name!r} is a prior name for live zone {target.current_name!r}", file=sys.stderr)
    old_name = target.current_name

if new_name == old_name:
    print(f"noop: zone {old_name!r} already has that name")
    sys.exit(0)

host = host_override or cat.host
if not host:
    print("error: catalog has no host= and --host not given", file=sys.stderr)
    sys.exit(2)

# Discover every uci reference to old_name on the firewall.
ssh_cmd = ["ssh", f"root@{host}", "uci show firewall"]
try:
    uci_out = subprocess.run(ssh_cmd, check=True, capture_output=True, text=True).stdout
except subprocess.CalledProcessError as e:
    print(f"error: ssh to {host} failed: {e.stderr.strip()}", file=sys.stderr)
    sys.exit(3)

# A reference looks like firewall.@zone[N].name='lan' or firewall.@forwarding[N].src='lan'.
# Mutations apply to the right-hand-side of these assignments where the value matches old_name.
import re
ref_re = re.compile(r"^(firewall\.@\w+\[\d+\]\.(?:name|src|dest|device|network))='([^']*)'$", re.M)
matches = [(m.group(1), m.group(2)) for m in ref_re.finditer(uci_out)]
# We rename ONLY name/src/dest references that equal old_name. `network` and
# `device` happen to reference UCI network interfaces which share names with
# zones by convention but are a separate namespace — leave those alone.
to_rename = [(key, val) for (key, val) in matches
             if val == old_name and key.split('.')[-1] in {"name", "src", "dest"}]

if not to_rename:
    print(f"error: no firewall references to {old_name!r} found on {host}", file=sys.stderr)
    sys.exit(1)

print(f"plan: rename fw4 zone {old_name!r} → {new_name!r} on host {host}")
print(f"  reason: {reason or '(none provided)'}")
print(f"  references to update ({len(to_rename)}):")
for key, _ in to_rename:
    print(f"    uci set {key}='{new_name}'")
print("  uci commit firewall")
print("  fw4 check && fw4 reload")
print(f"  zones.yaml: prior_names entry for {old_name!r}")
if not no_vlans_update:
    vcat = realm_vlans.catalog()
    affected = [e.vlan_id for e in (vcat.entries if vcat else []) if e.__dict__.get("zone") == old_name or getattr(e, "zone", None) == old_name]
    if affected:
        print(f"  vlans.yaml: update VLAN(s) {affected} zone {old_name!r} → {new_name!r}")
    else:
        print("  vlans.yaml: no entries reference this zone")

backup_name = f"/tmp/gatekeeper-firewall-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.conf"
print(f"  backup: gatekeeper saves uci export to {backup_name} (copied home if --commit)")

if not commit:
    print()
    print("DRY-RUN: re-run with --commit to apply.")
    sys.exit(0)

# ---- COMMIT PATH -----------------------------------------------------------
print()
print("--- committing ---")

# 1. Backup uci on gatekeeper.
print(f"[1/5] backup uci → {backup_name}")
subprocess.run(["ssh", f"root@{host}", f"uci export firewall > {shlex.quote(backup_name)}"], check=True)
local_backup = Path(f"/tmp/gatekeeper-firewall-backup-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.conf")
subprocess.run(["scp", f"root@{host}:{backup_name}", str(local_backup)], check=True, capture_output=True)
print(f"      local copy: {local_backup}")

# 2. Apply uci set + commit.
print(f"[2/5] uci set every reference + commit")
set_cmds = " && ".join(
    f"uci set {shlex.quote(key)}='{new_name}'" for key, _ in to_rename
)
try:
    subprocess.run(
        ["ssh", f"root@{host}", f"{set_cmds} && uci commit firewall"],
        check=True, capture_output=True, text=True,
    )
except subprocess.CalledProcessError as e:
    print(f"error during uci set: {e.stderr.strip()}", file=sys.stderr)
    print("attempting rollback (uci import backup)...", file=sys.stderr)
    subprocess.run(["ssh", f"root@{host}", f"uci import firewall < {shlex.quote(backup_name)} && uci commit firewall && fw4 reload"], check=False)
    sys.exit(4)

# 3. fw4 check + reload.
print(f"[3/5] fw4 check && fw4 reload")
try:
    subprocess.run(
        ["ssh", f"root@{host}", "fw4 check && fw4 reload"],
        check=True, capture_output=True, text=True,
    )
except subprocess.CalledProcessError as e:
    print(f"error during fw4 check/reload: {e.stderr.strip()}", file=sys.stderr)
    print("rolling back via uci import + fw4 reload...", file=sys.stderr)
    subprocess.run(["ssh", f"root@{host}", f"uci import firewall < {shlex.quote(backup_name)} && uci commit firewall && fw4 reload"], check=False)
    sys.exit(5)

# 4. Update zones.yaml.
print(f"[4/5] update zones.yaml")
try:
    realm_zones.rename(old_name, new_name, reason=reason)
except Exception as e:
    print(f"warning: zones.yaml update failed ({e}); firewall is already renamed", file=sys.stderr)
    sys.exit(6)

# 5. Update vlans.yaml.
if not no_vlans_update:
    print(f"[5/5] update vlans.yaml zone references")
    vcat = realm_vlans.catalog()
    if vcat is not None:
        changed = []
        for e in vcat.entries:
            zone = getattr(e, "zone", None)
            if zone == old_name:
                e.zone = new_name
                changed.append(e.vlan_id)
        if changed:
            vcat.save()
            realm_vlans.invalidate()
            print(f"      updated VLAN(s): {changed}")
        else:
            print(f"      no VLAN entries reference {old_name!r}")
else:
    print(f"[5/5] vlans.yaml update skipped (--no-vlans-update)")

print()
print(f"✓ renamed fw4 zone {old_name!r} → {new_name!r}")
print(f"  backup saved: {local_backup}")
PY
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
