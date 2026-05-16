#!/usr/bin/env bash
# realm-watch — tail the realm SSE event stream
set -euo pipefail

REALM_HELP_SUMMARY="Tail realm events from /sse (live)"
realm::help() {
  cat <<'EOF'
realm watch — tail the realm SSE event stream

USAGE:
  realm watch [--filter TYPE] [--sources]

OPTIONS:
  -h, --help        Show this help
  --filter TYPE     Show only events of this type (status, traffic, topology,
                    energy, latency, firewall, wifi, plugin-broadcast,
                    realm-event)
  --sources         List configured SSE sources and exit
  --json            Print raw event JSON lines

EXAMPLES:
  realm watch
  realm watch --filter discovery
  realm watch --filter realm-event --json
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"

FILTER=""
SOURCES=""
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter)    FILTER="$2"; shift 2 ;;
    --filter=*)  FILTER="${1#*=}"; shift ;;
    --sources)   SOURCES=1; shift ;;
    *) realm::die "unknown arg: $1" 2 ;;
  esac
done

realm::api_reachable || realm::die_unreachable

if [[ -n "$SOURCES" ]]; then
  realm::api_get /sse/sources \
    | realm::fmt_table '
        .sources // .
        | (["NAME","TYPE","INTERVAL"] | @tsv),
          (.[] | [.name // .id // "?", .type // "?", (.interval // "-" | tostring)] | @tsv)
      '
  exit 0
fi

# Stream SSE. SSE lines look like:
#   event: status
#   data: {"...": ...}
#   <blank>
# We collect data lines and emit them as events with the event type prepended.
realm::say "Tailing /sse — Ctrl-C to stop"
[[ -n "$FILTER" ]] && realm::say "Filter: $FILTER"

current_event=""
realm::api_sse /sse 2>/dev/null | while IFS= read -r line; do
  if [[ "$line" = "event: "* ]]; then
    current_event="${line#event: }"
  elif [[ "$line" = "data: "* ]]; then
    data="${line#data: }"
    [[ -z "$data" ]] && continue
    if [[ -n "$FILTER" && "$current_event" != "$FILTER" ]]; then
      continue
    fi
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '{"event":"%s","data":%s}\n' "$current_event" "$data"
    else
      # Inject event type into the JSON for fmt_event
      printf '{"type":"%s","payload":%s}\n' "$current_event" "$data" \
        | jq -c '. + {type: .type, text: (.payload | tostring | .[0:120])}' 2>/dev/null \
        | realm::fmt_event
    fi
  fi
done
