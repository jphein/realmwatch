#!/usr/bin/env bash
# realm-fleet — wraps existing ap-*.sh and deploy-realm-theme.sh
set -euo pipefail

REALM_HELP_SUMMARY="Manage the OpenWrt fleet (APs, routers, switches)"
realm::help() {
  cat <<'EOF'
realm fleet — manage the OpenWrt fleet

USAGE:
  realm fleet <SUBCOMMAND> [args]

SUBCOMMANDS:
  list                                List all known APs/routers/switches
  audit [ap_name|--all]               Audit SSIDs/VLANs/interfaces
  firewall-check                      Audit gatekeeper fw4 zones/rules
  ap-firewall-audit [ap|--json]       Audit per-AP fw4 vs realm standard
  ap-firewall-standardize <ap|--all> [--commit]
                                      Standardize per-AP fw4 (dry-run default)
  add-vlan --ap N --vlan V --name I   Add a VLAN interface to one AP
  migrate-ssid --ssid S --network N   Reassign an SSID to a network (fleet-wide)
  deploy-theme [ap_name]              Deploy LuCI theme to one AP or fleet
  collectd <ap_name|--all>            Install/refresh collectd on OpenWrt APs

NOTES:
  This is a thin wrapper. Each subcommand passes through to the existing
  scripts/ap-*.sh scripts unchanged. Use --dry-run on destructive commands
  (add-vlan, migrate-ssid) to preview.

EXAMPLES:
  realm fleet list
  realm fleet audit
  realm fleet add-vlan --ap your-ap --vlan 11 --name family --dry-run
  realm fleet migrate-ssid --ssid realm-family --network family --dry-run
EOF
}

REALM_SUBCOMMANDS="list
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

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::print_section "Access Points"
    for name in $(echo "${!APS[@]}" | tr ' ' '\n' | sort); do
      realm::print_kv "$name" "${APS[$name]}"
    done
    realm::print_section "Routers"
    for name in $(echo "${!ROUTERS[@]}" | tr ' ' '\n' | sort); do
      realm::print_kv "$name" "${ROUTERS[$name]}"
    done
    realm::print_section "OpenWrt Switches"
    for name in $(echo "${!SWITCHES_OPENWRT[@]}" | tr ' ' '\n' | sort); do
      realm::print_kv "$name" "${SWITCHES_OPENWRT[$name]}"
    done
    realm::print_section "Vendor Switches"
    for name in $(echo "${!SWITCHES_VENDOR[@]}" | tr ' ' '\n' | sort); do
      realm::print_kv "$name" "${SWITCHES_VENDOR[$name]}"
    done
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
