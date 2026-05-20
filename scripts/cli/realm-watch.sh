#!/usr/bin/env bash
# realm-watch — tail the realm SSE event stream
set -euo pipefail

REALM_HELP_SUMMARY="Tail realm events from /sse (live)"
realm::help() {
  cat <<'EOF'
realm watch — tail the realm SSE event stream

USAGE:
  realm watch [--filter TYPE] [--node NAME] [--sources]

OPTIONS:
  -h, --help        Show this help
  --filter TYPE     Show only events of this type (status, traffic, topology,
                    energy, latency, firewall, wifi, plugin-broadcast,
                    realm-event)
  --node NAME       Show only events touching this node. NAME is resolved
                    through /fleet/resolve, so current_name, prior_names,
                    and fleet_id all work. Composes with --filter.
  --sources         List configured SSE sources and exit
  --json            Print raw event JSON lines

EXAMPLES:
  realm watch
  realm watch --filter discovery
  realm watch --node katana
  realm watch --node gs308t                   # prior_name → east-switch
  realm watch --filter realm-event --node katana --json
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"

FILTER=""
NODE=""
SOURCES=""
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter)
      [[ $# -ge 2 ]] || realm::die "--filter requires a value" 2
      FILTER="$2"; shift 2 ;;
    --filter=*)  FILTER="${1#*=}"; shift ;;
    --node)
      [[ $# -ge 2 ]] || realm::die "--node requires a value" 2
      NODE="$2"; shift 2 ;;
    --node=*)    NODE="${1#*=}"; shift ;;
    --sources)   SOURCES=1; shift ;;
    *) realm::die "unknown arg: $1" 2 ;;
  esac
done

# Both --node and --filter pipe events through jq; fail fast with a clear
# error if jq isn't installed, rather than silently dropping every event
# when the subprocess fails inside node_matches/uri-encoding below.
if [[ -n "$NODE" || -n "$FILTER" ]]; then
  command -v jq >/dev/null || realm::die "jq is required for --node and --filter" 2
fi

realm::api_reachable || realm::die_unreachable

# Resolve --node through the fleet so prior_names/fleet_id work. If the
# resolver returns nothing (unknown node), warn but continue — caller may
# legitimately want a node that isn't in the fleet catalog yet.
CANONICAL_NODE=""
if [[ -n "$NODE" ]]; then
  encoded=$(printf '%s' "$NODE" | jq -Rr @uri)
  # Capture exit status separately so we can distinguish "endpoint returned
  # no entry" (200 OK, empty .entry) from "endpoint call failed" (auth,
  # server error, transient network). Both fall back to the literal name,
  # but the warning text should reflect which case we hit.
  resolved=$(realm::api_get "/fleet/resolve/$encoded" 2>/dev/null) && resolve_rc=0 || resolve_rc=$?
  CANONICAL_NODE=$(printf '%s' "$resolved" | jq -r '.entry.current_name // empty' 2>/dev/null || true)
  if [[ -z "$CANONICAL_NODE" ]]; then
    if [[ $resolve_rc -ne 0 ]]; then
      realm::warn "fleet resolve failed for '$NODE' (api error rc=$resolve_rc) — filtering by literal name; prior_names won't apply"
    else
      realm::warn "no entry in fleet for '$NODE' — filtering by that literal name; prior_names won't apply"
    fi
    CANONICAL_NODE="$NODE"
  elif [[ "$CANONICAL_NODE" != "$NODE" ]]; then
    realm::say "Resolved '$NODE' → '$CANONICAL_NODE' (via fleet)"
  fi
fi

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
[[ -n "$CANONICAL_NODE" ]] && realm::say "Node: $CANONICAL_NODE"

# Returns 0 if the JSON payload mentions $CANONICAL_NODE at .node, .data.node,
# or .data.host. Non-objects (e.g. arrays from /traffic) never match — that's
# intentional: per-node filtering only makes sense for object-shaped events.
node_matches() {
  local payload="$1"
  printf '%s' "$payload" | jq -e --arg n "$CANONICAL_NODE" \
    'if type == "object" then
       (.node? == $n) or (.data?.node? == $n) or (.data?.host? == $n)
     else false end' >/dev/null 2>&1
}

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
    if [[ -n "$CANONICAL_NODE" ]] && ! node_matches "$data"; then
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
