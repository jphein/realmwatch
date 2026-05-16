#!/usr/bin/env bash
# realm-ping — connectivity check via realm API
set -euo pipefail

REALM_HELP_SUMMARY="Ping a host through the realm server"
realm::help() {
  cat <<'EOF'
realm ping — connectivity check via the realm server's HTTP API

USAGE:
  realm ping [IP]

ARGUMENTS:
  IP    Host or IP to ping (server-side fping). If omitted, runs a general
        latency check via GET /ping.

EXAMPLES:
  realm ping
  realm ping 10.0.6.108
  realm ping katana --json
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

if [[ $# -ge 1 ]]; then
  realm::api_get "/ping/$1" \
    | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
else
  realm::api_get /ping \
    | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
fi
