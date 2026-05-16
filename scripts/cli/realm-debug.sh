#!/usr/bin/env bash
# realm-debug — dump debug info from the realm server
set -euo pipefail

REALM_HELP_SUMMARY="Dump realm server debug info (tables, endpoints, plugin state)"
realm::help() {
  cat <<'EOF'
realm debug — dump realm server debug info

USAGE:
  realm debug [SECTION]

SECTIONS:
  (none)         Full debug dump
  tables         Just DB table row counts
  endpoints      Just registered HTTP endpoints
  plugins        Just plugin registry

EXAMPLES:
  realm debug
  realm debug endpoints
  realm debug --json | jq '.endpoints | length'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

section="${1:-}"

case "$section" in
  "")
    realm::api_get /debug \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then
          cat
        else
          jq '. | {tables: (.tables // {}), endpoints_count: ((.endpoints // []) | length), plugins_count: ((.plugins // []) | length)}' \
            | realm::fmt_kv
        fi
    ;;
  tables)
    realm::api_get /debug | jq '.tables // {}' | realm::fmt_kv
    ;;
  endpoints)
    realm::api_get /debug \
      | realm::fmt_table '
          (["METHOD","PATH","ORIGIN"] | @tsv),
          ((.endpoints // [])[] | [(.method // "GET"), (.path // "?"), (.origin // .plugin // "core")] | @tsv)
        '
    ;;
  plugins)
    realm::api_get /debug \
      | realm::fmt_table '
          (["NAME","TYPE","ENABLED"] | @tsv),
          ((.plugins // [])[] | [.name // "?", (.type // "-"), ((.enabled // true) | tostring)] | @tsv)
        '
    ;;
  *)
    realm::die "unknown section: $section" 2
    ;;
esac
