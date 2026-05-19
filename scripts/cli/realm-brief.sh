#!/usr/bin/env bash
# realm-brief — one-screen state overview. The "what's happening right now?"
# command. Reads /status, /events, /fleet/list, /astral and surfaces the
# top-level facts in 15-25 lines of output. No drill-down — for that, use
# the targeted subcommands (realm status, realm event, etc).

set -euo pipefail

REALM_HELP_SUMMARY="One-screen overview: nodes online, recent events, hotspots"
realm::help() {
  cat <<'EOF'
realm brief — one-screen state overview

USAGE:
  realm brief [--json]

WHAT IT SHOWS:
  - Online vs offline node counts (from astral.nodes)
  - Core host reachability (gatekeeper/katana/ha/oracle quick check)
  - Recent events (last 10, with timestamp + node + type)
  - Failing checks if any (e.g. ping fail, plugin failed)
  - Fleet count + tentative entries needing operator promotion

The intended use: SSH'd in, want to know "is anything on fire?" in 10 seconds.

EXAMPLES:
  realm brief
  realm brief --json | jq '.events[] | select(.type == "alert")'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

# Fetch once; reuse
STATUS=$(realm::api_get /status 2>/dev/null || echo "{}")
EVENTS=$(realm::api_get "/events?limit=10" 2>/dev/null || echo "[]")
FLEET=$(realm::api_get /fleet/list 2>/dev/null || echo '{"count":0,"entries":[]}')

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -nc \
    --argjson status "$STATUS" \
    --argjson events "$EVENTS" \
    --argjson fleet "$FLEET" \
    '{
      core_hosts: $status.core_hosts,
      nodes: {
        online: ($status.astral.nodes // {} | to_entries | map(select(.value == true)) | length),
        offline: ($status.astral.nodes // {} | to_entries | map(select(.value == false)) | length),
        total: ($status.astral.nodes // {} | length)
      },
      fleet: {
        total: $fleet.count,
        curated: ($fleet.entries // [] | map(select(.status == "curated")) | length),
        tentative: ($fleet.entries // [] | map(select(.status == "tentative")) | length),
        retired: ($fleet.entries // [] | map(select(.status == "retired")) | length)
      },
      recent_events: $events
    }'
  exit 0
fi

# --- pretty output ---

realm::print_section "Realm"
host="${REALM_HOST:-http://localhost}"
realm::print_kv "Server" "$host"

# core hosts pings
core_ok=$(echo "$STATUS" | jq -r '.core_hosts | to_entries | map(select(.value != null)) | length // 0')
core_total=$(echo "$STATUS" | jq -r '.core_hosts | length // 0')
realm::print_kv "Core hosts" "$core_ok/$core_total resolved from fleet.yaml"

# Astral counts
online=$(echo "$STATUS" | jq -r '.astral.nodes // {} | to_entries | map(select(.value == true)) | length')
offline=$(echo "$STATUS" | jq -r '.astral.nodes // {} | to_entries | map(select(.value == false)) | length')
total_astral=$(echo "$STATUS" | jq -r '.astral.nodes // {} | length')
if [[ "$offline" -gt 0 ]]; then
  realm::print_kv "Astral nodes" "$online online · $offline OFFLINE · $total_astral total"
else
  realm::print_kv "Astral nodes" "$online online · $total_astral total"
fi

# Fleet
fc=$(echo "$FLEET" | jq -r '.count // 0')
tent=$(echo "$FLEET" | jq -r '[.entries[]? | select(.status == "tentative")] | length // 0')
ret=$(echo "$FLEET" | jq -r '[.entries[]? | select(.status == "retired")] | length // 0')
fleet_line="$fc entries"
[[ "$tent" -gt 0 ]] && fleet_line="$fleet_line · $tent tentative (need promote)"
[[ "$ret" -gt 0 ]] && fleet_line="$fleet_line · $ret retired"
realm::print_kv "Fleet" "$fleet_line"

# OFFLINE nodes (named)
if [[ "$offline" -gt 0 ]]; then
  realm::print_section "Offline"
  echo "$STATUS" | jq -r '.astral.nodes // {} | to_entries | map(select(.value == false)) | .[].key' | head -10 | while read -r n; do
    echo "  - $n"
  done
fi

# Recent events
realm::print_section "Recent events"
n=$(echo "$EVENTS" | jq -r 'length // 0')
if [[ "$n" -eq 0 ]]; then
  echo "  (none)"
else
  echo "$EVENTS" | jq -r '.[] | "\(.ts | strftime("%H:%M:%S"))  [\(.type // "event")]  \(.node // "—")  \(.text // .msg // .)"' 2>/dev/null | head -10
fi

# Open quests (if any)
if quests=$(realm::api_get "/quests?status=open" 2>/dev/null); then
  qn=$(echo "$quests" | jq -r 'if type=="array" then length else (.quests // [] | length) end' 2>/dev/null)
  if [[ "$qn" =~ ^[0-9]+$ && "$qn" -gt 0 ]]; then
    realm::print_section "Open quests"
    echo "$quests" | jq -r 'if type=="array" then .[] else .quests[]? end | "  - \(.title // .name) (\(.status // "?"))"' 2>/dev/null | head -5
  fi
fi
