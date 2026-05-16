#!/usr/bin/env bash
# realm-config — read/write realm server-side config
set -euo pipefail

REALM_HELP_SUMMARY="Read or write realm server-side config"
realm::help() {
  cat <<'EOF'
realm config — read or write realm server-side config

USAGE:
  realm config <SUBCOMMAND>

SUBCOMMANDS:
  get [key]          Print full config or one key
  set <key> <value>  Set one key

EXAMPLES:
  realm config get
  realm config get theme
  realm config set theme forest
EOF
}

REALM_SUBCOMMANDS="get
set"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-get}"
shift || true

case "$sub" in
  get)
    if [[ $# -ge 1 ]]; then
      realm::api_get /config | jq --arg k "$1" '.[$k] // empty'
    else
      realm::api_get /config \
        | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    fi
    ;;
  set)
    [[ $# -ge 2 ]] || realm::die "usage: realm config set <key> <value>" 2
    body=$(jq -n --arg k "$1" --arg v "$2" '{($k): $v}')
    realm::api_post /config "$body"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
