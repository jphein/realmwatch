#!/usr/bin/env bash
# realm-ssh — execute SSH command via realm API
set -euo pipefail

REALM_HELP_SUMMARY="Run an SSH command through the realm server"
realm::help() {
  cat <<'EOF'
realm ssh — run an SSH command through the realm server

USAGE:
  realm ssh <host> <command...>

NOTES:
  Hits POST /ssh on the realm server. Uses the credentials configured there.
  For direct local SSH, just use the ssh(1) command.

EXAMPLES:
  realm ssh katana uptime
  realm ssh gatekeeper "uci show wireless"
EOF
  realm::help_flags
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 2 ]] || realm::die "usage: realm ssh <host> <command...>" 2

host="$1"; shift
command="$*"

realm::api_reachable || realm::die_unreachable

body=$(jq -n --arg host "$host" --arg cmd "$command" '{host:$host, command:$cmd}')
realm::api_post /ssh "$body" \
  | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else jq -r '.stdout // .output // .'; fi
