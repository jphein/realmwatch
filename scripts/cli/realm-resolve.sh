#!/usr/bin/env bash
# realm-resolve — resolve URL/host via realm server
set -euo pipefail

REALM_HELP_SUMMARY="Resolve a URL or hostname through the realm server"
realm::help() {
  cat <<'EOF'
realm resolve — resolve a URL or host via the realm server

USAGE:
  realm resolve <url|host>

EXAMPLES:
  realm resolve realm.watch
  realm resolve https://example.com
EOF
  realm::help_flags
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 1 ]] || realm::die "usage: realm resolve <url|host>" 2

realm::api_reachable || realm::die_unreachable

realm::api_get /resolve-url "?url=$1" \
  | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
