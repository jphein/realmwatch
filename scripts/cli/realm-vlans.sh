#!/usr/bin/env bash
# realm-vlans — show the realm's VLAN registry.
#
# The registry lives in gitignored vlans.yaml at the repo root and is loaded
# by firewall_parser.py at import time. This CLI reads it via the same code
# path the map_server uses (no HTTP needed), so it works whether the server
# is running or not.
set -euo pipefail

REALM_HELP_SUMMARY="Show or rename VLANs in the realm's VLAN registry"
REALM_SUBCOMMANDS="list
show
active
rename"

realm::help() {
  cat <<'EOF'
realm vlans — show or rename VLANs

USAGE:
  realm vlans [SUBCOMMAND]

SUBCOMMANDS:
  list                          Show every VLAN (default)
  show <id|label>               Show details for one VLAN (resolves prior names)
  active                        List only currently-active VLANs
  rename <id> <new-label>       Rename a VLAN's label; old label
                                preserved in prior_names

OPTIONS:
  --json                        Emit raw JSON (list/show only)
  --reason "..."                Annotate a rename with the operator reason

EXAMPLES:
  realm vlans
  realm vlans show 10
  realm vlans show IoT                                   # finds VLAN 10 via prior name
  realm vlans active
  realm vlans rename 10 Cameras --reason "repurposed"
  realm vlans --json | jq '.[] | select(.type == "wan")'

NOTES:
  Registry lives in gitignored vlans.yaml. Rename mutates the file
  through lexicon.VLANCatalog — same identity-authority path
  realm_fleet uses for hosts. After a rename, restart map_server to
  refresh the live firewall panel.
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Emit the full registry as a JSON array sorted by VLAN ID.
_emit_registry_json() {
  "$REALM_PYTHON" - <<'PY'
import json, sys
try:
    import firewall_parser as fp
except Exception as e:
    print(json.dumps({"error": f"firewall_parser load failed: {e}"}), file=sys.stderr)
    sys.exit(3)
rows = []
for vid in sorted(fp.VLANS):
    info = fp.VLANS[vid]
    rows.append({
        "id": vid,
        "label": info.get("label", ""),
        "type": info.get("type", ""),
        "status": info.get("status", ""),
        "zone": fp.VLAN_ZONE.get(vid, ""),
        "icon": info.get("icon", ""),
        "desc": info.get("desc", ""),
    })
print(json.dumps(rows))
PY
}

sub="${1:-list}"
shift || true

case "$sub" in
  list|active)
    raw=$(_emit_registry_json)
    if [[ "$sub" == "active" ]]; then
      raw=$(printf '%s' "$raw" | jq '[.[] | select(.status == "active")]')
    fi
    printf '%s' "$raw" | realm::fmt_table '
      (["ID","LABEL","TYPE","STATUS","ZONE","DESC"] | @tsv),
      (.[]
        | [
            (.id | tostring),
            (if .icon != "" then "\(.icon) \(.label)" else .label end),
            .type,
            .status,
            (if .zone == "" then "-" else .zone end),
            .desc
          ] | @tsv)
    '
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "missing VLAN id or label (e.g. realm vlans show 10)" 2
    target="$1"
    # Resolve label → id via lexicon (handles prior_names).
    if ! [[ "$target" =~ ^[0-9]+$ ]]; then
      target=$("$REALM_PYTHON" -c "
import sys, realm_vlans
e = realm_vlans.resolve('$target'.replace(chr(39), ''))
sys.stdout.write(str(e.vlan_id) if e else '')
") || realm::die "lookup failed" 3
      [[ -n "$target" ]] || realm::die "no VLAN matches that label" 1
    fi
    raw=$(_emit_registry_json)
    match=$(printf '%s' "$raw" | jq --argjson id "$target" '.[] | select(.id == $id)')
    if [[ -z "$match" || "$match" == "null" ]]; then
      realm::die "no VLAN with id $target" 1
    fi
    printf '%s' "$match" | realm::fmt_kv
    ;;
  rename)
    # Parse: realm vlans rename <id> <new-label> [--reason "..."]
    [[ $# -ge 2 ]] || realm::die "usage: realm vlans rename <id> <new-label> [--reason TEXT]" 2
    vid="$1"; shift
    new_label="$1"; shift
    [[ "$vid" =~ ^[0-9]+$ ]] || realm::die "VLAN id must be numeric" 2
    [[ -n "$new_label" ]] || realm::die "new label must be non-empty" 2
    reason=""
    while (( $# > 0 )); do
      case "$1" in
        --reason)
          [[ $# -ge 2 ]] || realm::die "--reason requires a value" 2
          reason="$2"; shift 2 ;;
        --reason=*) reason="${1#--reason=}"; shift ;;
        *) realm::die "unknown flag: $1" 2 ;;
      esac
    done

    # Delegate to lexicon.VLANCatalog via the shim. Errors bubble back with
    # a non-zero exit code from python.
    if ! "$REALM_PYTHON" - "$vid" "$new_label" "$reason" <<'PY'
import sys
import realm_vlans
vid = int(sys.argv[1])
new_label = sys.argv[2]
reason = sys.argv[3] or None
try:
    old = realm_vlans.get(vid)
    if old is None:
        print(f"error: no VLAN with id {vid}", file=sys.stderr)
        sys.exit(1)
    old_label = old.label
    realm_vlans.rename(vid, new_label, reason=reason)
    print(f"renamed VLAN {vid}: {old_label!r} -> {new_label!r}")
    if reason:
        print(f"  reason: {reason}")
    print("  (vlans.yaml updated; restart map_server to refresh the live panel)")
except Exception as e:
    print(f"error: {e}", file=sys.stderr)
    sys.exit(1)
PY
    then
      exit $?
    fi
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
