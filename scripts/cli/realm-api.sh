#!/usr/bin/env bash
# realm-api — generic HTTP escape hatch for the realm API
set -euo pipefail

REALM_HELP_SUMMARY="Generic HTTP escape hatch (raw curl wrapper for any endpoint)"
realm::help() {
  cat <<'EOF'
realm api — generic HTTP escape hatch for the realm API

USAGE:
  realm api <METHOD> <PATH> [BODY]

ARGUMENTS:
  METHOD   GET | POST | PUT | DELETE
  PATH     URL path (with leading slash), e.g. /status, /quests
  BODY     JSON body (for POST/PUT)

EXAMPLES:
  realm api GET /status
  realm api GET /quests | jq '.[] | select(.status == "active")'
  realm api POST /event '{"type":"info","text":"hello"}'
  realm api DELETE /alerting/history
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 2 ]] || realm::die "usage: realm api <METHOD> <PATH> [BODY]" 2

method="${1^^}"; shift
path="$1"; shift
body="${1:-}"

realm::api_reachable || realm::die_unreachable

case "$method" in
  GET)    realm::api_get "$path" ;;
  POST)   realm::api_post "$path" "$body" ;;
  PUT)    realm::api_put "$path" "$body" ;;
  DELETE) realm::api_delete "$path" ;;
  *)      realm::die "unsupported method: $method" 2 ;;
esac
