#!/usr/bin/env bash
# realm-wol — Wake-on-LAN
set -euo pipefail

REALM_HELP_SUMMARY="Send Wake-on-LAN packet to a node"
realm::help() {
  cat <<'EOF'
realm wol — send Wake-on-LAN packet to a node

USAGE:
  realm wol <node_id|mac>

EXAMPLES:
  realm wol katana
  realm wol 00:11:22:33:44:55
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 1 ]] || realm::die "usage: realm wol <node_id|mac>" 2

realm::api_reachable || realm::die_unreachable

body=$(jq -n --arg target "$1" '{target:$target}')
realm::api_post /wol "$body"
