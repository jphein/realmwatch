#!/usr/bin/env bash
# realm-topology — show the realm network topology
set -euo pipefail

REALM_HELP_SUMMARY="Show network topology (nodes and connections)"
realm::help() {
  cat <<'EOF'
realm topology — show realm network topology

USAGE:
  realm topology [SUBCOMMAND]

SUBCOMMANDS:
  show         Print topology as a table (default)
  nodes        List just nodes
  connections  List just connections
  raw          Print raw JSON

EXAMPLES:
  realm topology
  realm topology nodes
  realm topology --json | jq '.nodes | length'
EOF
}

REALM_SUBCOMMANDS="show
nodes
connections
raw"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"

set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"
sub="${1:-show}"

realm::api_reachable || realm::die_unreachable

case "$sub" in
  raw|"")
    realm::api_get /topology
    ;;
  show)
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    realm::api_get /topology > "$tmp"
    realm::print_section "Nodes ($(jq -r '.nodes | length' "$tmp"))"
    jq -r '
      (["ID","NAME","ROLE","STATUS"] | @tsv),
      (.nodes[] | [.id, .name // "-", .role // "-", .status // "-"] | @tsv)
    ' "$tmp" 2>/dev/null | column -t -s$'\t' | head -50
    realm::print_section "Connections ($(jq -r '.connections | length' "$tmp"))"
    jq -r '
      (["FROM","TO","TYPE"] | @tsv),
      (.connections[] | [.from // .source // "?", .to // .target // "?", .type // "-"] | @tsv)
    ' "$tmp" 2>/dev/null | column -t -s$'\t' | head -50
    ;;
  nodes)
    realm::api_get /topology \
      | realm::fmt_table '
          (["ID","NAME","ROLE","STATUS"] | @tsv),
          (.nodes[] | [.id, .name // "-", .role // "-", .status // "-"] | @tsv)
        '
    ;;
  connections)
    realm::api_get /topology \
      | realm::fmt_table '
          (["FROM","TO","TYPE"] | @tsv),
          (.connections[] | [.from // .source // "?", .to // .target // "?", .type // "-"] | @tsv)
        '
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
