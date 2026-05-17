#!/usr/bin/env bash
# realm-event — push a custom event into the realm
set -euo pipefail

REALM_HELP_SUMMARY="List, post, acknowledge, or close events"
realm::help() {
  cat <<'EOF'
realm event — list, post, acknowledge, or close realm events

USAGE:
  realm event list [--type TYPE] [--limit N] [--unacked]
  realm event post <type> <text> [--node ID] [--color COLOR]
  realm event ack <id> [--by NAME] [--note "..."]
  realm event close <id>
  realm event unacked [--limit N]

OPTIONS:
  --type TYPE   Filter by event type (list mode)
  --limit N     Max events to show (default 20)
  --unacked     Only show unacked + open events (list mode)
  --node ID     Node to associate with the event (post mode)
  --color COLOR Color override (post mode)
  --by NAME     Acknowledger name (default: $USER)
  --note "..."  Note attached to the ack

EXAMPLES:
  realm event list
  realm event list --unacked --limit 50
  realm event post quest "A new path opens"
  realm event ack 12345 --note "investigating"
  realm event close 12345
  realm event unacked
EOF
}

REALM_SUBCOMMANDS="list
post
ack
close
unacked"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    type=""; limit=20; unacked=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --type) type="$2"; shift 2 ;;
        --type=*) type="${1#*=}"; shift ;;
        --limit) limit="$2"; shift 2 ;;
        --limit=*) limit="${1#*=}"; shift ;;
        --unacked) unacked=1; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    qs="?limit=$limit"
    [[ -n "$type" ]] && qs="$qs&type=$type"
    [[ -n "$unacked" ]] && qs="$qs&ack=false"
    realm::api_get /events "$qs" \
      | realm::fmt_table '
          (["ID","TIME","TYPE","NODE","STATE","TEXT"] | @tsv),
          ((if type == "array" then . else .events // [] end)[]
            | [
                (.id // "-" | tostring),
                .ts // .timestamp // "-",
                .type // "-",
                .node // "-",
                (if .closed_at then "closed"
                 elif .ack_at then "acked"
                 else "open" end),
                ((.text // .message // "") | .[0:50])
              ] | @tsv)
        '
    ;;
  unacked)
    limit=20
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --limit) limit="$2"; shift 2 ;;
        --limit=*) limit="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    realm::api_get /events "?limit=$limit&ack=false" \
      | realm::fmt_table '
          (["ID","TIME","TYPE","NODE","TEXT"] | @tsv),
          ((if type == "array" then . else .events // [] end)[]
            | [(.id // "-" | tostring), .ts // "-", .type // "-", .node // "-",
               ((.text // .message // "") | .[0:60])] | @tsv)
        '
    ;;
  ack)
    [[ $# -ge 1 ]] || realm::die "usage: realm event ack <id> [--by NAME] [--note ...]" 2
    eid="$1"; shift
    by="${USER:-$LOGNAME}"; note=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --by) by="$2"; shift 2 ;;
        --by=*) by="${1#*=}"; shift ;;
        --note) note="$2"; shift 2 ;;
        --note=*) note="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    body=$(jq -n --arg by "$by" --arg note "$note" '{by:$by, note:$note}')
    realm::api_post "/events/$eid/ack" "$body" \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else jq -r '
          if .error then "✘ \(.error)"
          else "✓ event \(.id) acked by \(.ack_by // "?") at \(.ack_at // 0 | tostring)"
            + (if (.ack_note // "") != "" then " — \(.ack_note)" else "" end)
          end'
        fi
    ;;
  close)
    [[ $# -ge 1 ]] || realm::die "usage: realm event close <id>" 2
    realm::api_post "/events/$1/close" "{}" \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else jq -r '
          if .error then "✘ \(.error)"
          else "✓ event \(.id) closed at \(.closed_at // 0 | tostring)"
          end'
        fi
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
