#!/usr/bin/env bash
# realm-vlans — show the realm's VLAN registry.
#
# The registry lives in gitignored vlans.yaml at the repo root and is loaded
# by firewall_parser.py at import time. This CLI reads it via the same code
# path the map_server uses (no HTTP needed), so it works whether the server
# is running or not.
set -euo pipefail

REALM_HELP_SUMMARY="Show the VLAN registry (id, label, type, status, zone, desc)"
REALM_SUBCOMMANDS="list
show
active"

realm::help() {
  cat <<'EOF'
realm vlans — show the VLAN registry

USAGE:
  realm vlans [SUBCOMMAND]

SUBCOMMANDS:
  list             Show every VLAN (default)
  show <id>        Show details for one VLAN
  active           List only currently-active VLANs

OPTIONS:
  --json           Emit raw JSON (also via realm --json vlans)

EXAMPLES:
  realm vlans
  realm vlans show 10
  realm vlans active
  realm vlans --json | jq '.[] | select(.type == "wan")'

NOTES:
  The registry is loaded from vlans.yaml (gitignored). Edit by hand;
  the map_server picks up changes on restart. See vlans.yaml.example
  for the schema.
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
    [[ $# -ge 1 ]] || realm::die "missing VLAN id (e.g. realm vlans show 10)" 2
    target="$1"
    [[ "$target" =~ ^[0-9]+$ ]] || realm::die "VLAN id must be numeric" 2
    raw=$(_emit_registry_json)
    match=$(printf '%s' "$raw" | jq --argjson id "$target" '.[] | select(.id == $id)')
    if [[ -z "$match" || "$match" == "null" ]]; then
      realm::die "no VLAN with id $target" 1
    fi
    printf '%s' "$match" | realm::fmt_kv
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
