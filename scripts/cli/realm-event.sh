#!/usr/bin/env bash
# realm-event — push a custom event into the realm
set -euo pipefail

REALM_HELP_SUMMARY="List recent events or post a new custom event"
realm::help() {
  cat <<'EOF'
realm event — list recent events or post a new custom event

USAGE:
  realm event list [--type TYPE] [--limit N]
  realm event post <type> <text> [--node ID] [--color COLOR]

OPTIONS:
  --type TYPE   Filter by event type (list mode)
  --limit N     Max events to show (default 20)
  --node ID     Node to associate with the event (post mode)
  --color COLOR Color override (post mode)

EXAMPLES:
  realm event list
  realm event list --type discovery --limit 50
  realm event post quest "A new path opens"
  realm event post warn "Disk almost full" --node katana --color red
EOF
}

REALM_SUBCOMMANDS="list
post"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    type=""; limit=20
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --type) type="$2"; shift 2 ;;
        --type=*) type="${1#*=}"; shift ;;
        --limit) limit="$2"; shift 2 ;;
        --limit=*) limit="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    qs="?limit=$limit"
    [[ -n "$type" ]] && qs="$qs&type=$type"
    realm::api_get /events "$qs" \
      | realm::fmt_table '
          (["TIME","TYPE","NODE","TEXT"] | @tsv),
          ((if type == "array" then . else .events // [] end)[]
            | [.ts // .timestamp // "-", .type // "-", .node // "-", ((.text // .message // "") | .[0:60])] | @tsv)
        '
    ;;
  post)
    [[ $# -ge 2 ]] || realm::die "usage: realm event post <type> <text> [--node ID] [--color COLOR]" 2
    type="$1"; text="$2"; shift 2
    node=""; color=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --node) node="$2"; shift 2 ;;
        --node=*) node="${1#*=}"; shift ;;
        --color) color="$2"; shift 2 ;;
        --color=*) color="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    body=$(jq -n --arg t "$type" --arg x "$text" --arg n "$node" --arg c "$color" \
      '{type:$t, text:$x} + (if $n != "" then {node:$n} else {} end)
                          + (if $c != "" then {color:$c} else {} end)')
    realm::api_post /event "$body"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
