#!/usr/bin/env bash
# realm-fleet — wraps existing ap-*.sh and deploy-realm-theme.sh
set -euo pipefail

REALM_HELP_SUMMARY="Manage the OpenWrt fleet (APs, routers, switches)"
realm::help() {
  cat <<'EOF'
realm fleet — manage the OpenWrt fleet

USAGE:
  realm fleet <SUBCOMMAND> [args]

READ SUBCOMMANDS (safe; support --json):
  list                                List all known APs/routers/switches
  audit [ap_name|--all]               Audit SSIDs/VLANs/interfaces
  firewall-check                      Audit gatekeeper fw4 zones/rules
  ap-firewall-audit [ap|--json]       Audit per-AP fw4 vs realm standard

MUTATING SUBCOMMANDS (change config; keep their own safety flags):
  add <ip|hostname> [--name N]        Probe a host (SSH + OpenWrt detect)
       [--category C] [--realm R]     and append it to fleet.yaml
       [--notes T] [--yes] [--json]
  ap-firewall-standardize <ap|--all> [--commit]
                                      Standardize per-AP fw4 (dry-run default)
  add-vlan --ap N --vlan V --name I   Add a VLAN interface to one AP
  migrate-ssid --ssid S --network N   Reassign an SSID to a network (fleet-wide)
  deploy-theme [ap_name]              Deploy LuCI theme to one AP or fleet
  collectd <ap_name|--all>            Install/refresh collectd on OpenWrt APs

OPTIONS:
  --json                              Machine-readable JSON (read subcommands)

NOTES:
  This is a thin wrapper. Most subcommands pass through to the existing
  scripts/ap-*.sh scripts unchanged. Read subcommands emit raw JSON under
  --json; `list` is rendered here, `audit`/`firewall-check`/`ap-firewall-audit`
  inherit their underlying script's output (ap-firewall-audit already speaks
  --json). Use --dry-run / --commit on mutating commands (add-vlan,
  migrate-ssid, ap-firewall-standardize) to preview before changing config.

EXAMPLES:
  realm fleet list
  realm fleet list --json | jq '.aps'
  realm fleet audit
  realm fleet add-vlan --ap your-ap --vlan 11 --name family --dry-run
  realm fleet migrate-ssid --ssid realm-family --network family --dry-run
EOF
}

REALM_SUBCOMMANDS="list
add
audit
firewall-check
ap-firewall-audit
ap-firewall-standardize
add-vlan
migrate-ssid
deploy-theme
collectd"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

_scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# _emit_fleet_json — serialize the four fleet arrays (sourced from the
# gitignored fleet.sh) into a single JSON object: {aps, routers,
# switches_openwrt, switches_vendor}, each a name->IP map. Arrays may be
# entirely unset when fleet.sh is absent (worktrees, fresh clones, CI) —
# `${!ARR[@]}` on an unset name expands to nothing under `set -u`, so each
# section degrades to an empty object rather than erroring.
_emit_fleet_json() {
  {
    printf 'aps\n'
    for name in "${!APS[@]}";              do printf '%s\t%s\n' "$name" "${APS[$name]}"; done
    printf '\037\n'  # group separator between sections
    printf 'routers\n'
    for name in "${!ROUTERS[@]}";          do printf '%s\t%s\n' "$name" "${ROUTERS[$name]}"; done
    printf '\037\n'
    printf 'switches_openwrt\n'
    for name in "${!SWITCHES_OPENWRT[@]}"; do printf '%s\t%s\n' "$name" "${SWITCHES_OPENWRT[$name]}"; done
    printf '\037\n'
    printf 'switches_vendor\n'
    for name in "${!SWITCHES_VENDOR[@]}";  do printf '%s\t%s\n' "$name" "${SWITCHES_VENDOR[$name]}"; done
  } | jq -Rn '
    reduce inputs as $line (
      {sections: {}, key: null};
      if $line == "" then .key = null
      elif .key == null then .key = $line | .sections[$line] = {}
      else
        ($line | split("\t")) as $kv
        | .sections[.key][$kv[0]] = $kv[1]
      end
    )
    | .sections
  '
}

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    raw=$(_emit_fleet_json)
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s\n' "$raw"
    else
      realm::print_section "Access Points"
      printf '%s' "$raw" | jq -r '.aps | to_entries | sort_by(.key)[] | "\(.key)\t\(.value)"' \
        | while IFS=$'\t' read -r name ip; do realm::print_kv "$name" "$ip"; done
      realm::print_section "Routers"
      printf '%s' "$raw" | jq -r '.routers | to_entries | sort_by(.key)[] | "\(.key)\t\(.value)"' \
        | while IFS=$'\t' read -r name ip; do realm::print_kv "$name" "$ip"; done
      realm::print_section "OpenWrt Switches"
      printf '%s' "$raw" | jq -r '.switches_openwrt | to_entries | sort_by(.key)[] | "\(.key)\t\(.value)"' \
        | while IFS=$'\t' read -r name ip; do realm::print_kv "$name" "$ip"; done
      realm::print_section "Vendor Switches"
      printf '%s' "$raw" | jq -r '.switches_vendor | to_entries | sort_by(.key)[] | "\(.key)\t\(.value)"' \
        | while IFS=$'\t' read -r name ip; do realm::print_kv "$name" "$ip"; done
    fi
    ;;
  add)
    exec "$_scripts_dir/cli/realm-fleet-add.sh" "$@"
    ;;
  audit)
    exec "$_scripts_dir/ap-audit.sh" "$@"
    ;;
  firewall-check)
    exec "$_scripts_dir/ap-firewall-check.sh" "$@"
    ;;
  ap-firewall-audit)
    exec "$_scripts_dir/ap-firewall-audit.sh" "$@"
    ;;
  ap-firewall-standardize)
    exec "$_scripts_dir/ap-firewall-standardize.sh" "$@"
    ;;
  add-vlan)
    exec "$_scripts_dir/ap-add-vlan.sh" "$@"
    ;;
  migrate-ssid)
    exec "$_scripts_dir/ap-migrate-ssid.sh" "$@"
    ;;
  deploy-theme)
    exec "$_scripts_dir/deploy-realm-theme.sh" "$@"
    ;;
  collectd)
    exec "$_scripts_dir/setup-collectd-openwrt.sh" "$@"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
