#!/usr/bin/env bash
# realm-wol — Wake-on-LAN, remote S3 sleep, and power state (the Slumber Ward)
#
# This script intentionally OWNS `realm wol` (the dispatcher resolves core
# scripts in scripts/cli before plugin CLIs). It dispatches to the wol plugin's
# endpoints so the verbs work despite the plugin's declarative cli.verbs being
# shadowed. Bare `realm wol <host|mac>` stays back-compatible = wake.
set -euo pipefail

REALM_HELP_SUMMARY="Wake / slumber fleet hosts and inspect power state"
realm::help() {
  cat <<'EOF'
realm wol — Wake-on-LAN, remote S3 sleep, and power state (Slumber Ward)

USAGE:
  realm wol [wake] <node_id|mac>   send a Wake-on-LAN magic packet (default verb)
  realm wol sleep <host>           suspend a WoL-armed host to S3 (refused if not armed)
  realm wol arm <host>             arm Wake-on-LAN on the host's NIC (ethtool wol g)
  realm wol doctor <host>          check a host's WoL readiness (SSH + ethtool 'Wake-on: g')
  realm wol show                   list WoL-managed hosts and their power state

EXAMPLES:
  realm wol katana                 # wake (back-compat)
  realm wol wake katana
  realm wol sleep familiar
  realm wol doctor familiar
  realm wol show
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 1 ]] || realm::die "usage: realm wol [wake|sleep|arm|doctor|show] <host>" 2

realm::api_reachable || realm::die_unreachable

# Wake a target by posting to the raw /wol endpoint.
_wol_wake() {
  local body; body=$(jq -n --arg target "$1" '{target:$target}')
  realm::api_post /wol "$body"
}

case "$1" in
  show)
    realm::api_get /plugins/wol/status
    ;;
  doctor)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol doctor <host>" 2
    realm::api_get "/plugins/wol/doctor?target=$(printf '%s' "$1" | jq -Rr @uri)"
    ;;
  sleep)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol sleep <host>" 2
    realm::api_post /plugins/wol/sleep "$(jq -n --arg target "$1" '{target:$target}')"
    ;;
  arm)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol arm <host>" 2
    realm::api_post /plugins/wol/arm "$(jq -n --arg target "$1" '{target:$target}')"
    ;;
  wake)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol wake <node_id|mac>" 2
    _wol_wake "$1"
    ;;
  *)
    # Back-compat: bare `realm wol <node_id|mac>` = wake.
    _wol_wake "$1"
    ;;
esac
