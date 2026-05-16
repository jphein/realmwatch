#!/usr/bin/env bash
# realm-status — show full realm system status
set -euo pipefail

REALM_HELP_SUMMARY="Show full realm system status"
realm::help() {
  cat <<'EOF'
realm status — show full realm system status

USAGE:
  realm status [OPTIONS]

OPTIONS:
  -h, --help     Show this help
  --json         Print raw JSON from GET /status
  --no-color     Disable ANSI color
  --host URL     Override realm host

EXAMPLES:
  realm status
  realm status --json | jq '.sensors'
  realm status --host http://10.0.6.108
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"

realm::api_reachable || realm::die_unreachable

if [[ "$REALM_OUTPUT" = "json" ]]; then
  realm::api_get /status
  exit $?
fi

# Human-readable view: pull the top-level fields and render as sections.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
realm::api_get /status > "$tmp" || realm::die "failed to fetch /status"

realm::print_section "Sensors"
jq -r '
  .sensors // {}
  | to_entries[]
  | "\(.key)\t\(.value)"' "$tmp" 2>/dev/null \
  | while IFS=$'\t' read -r k v; do realm::print_kv "$k" "$v"; done

realm::print_section "WiFi"
jq -r '
  .wifi // {}
  | to_entries[]
  | "\(.key)\t\(.value)"' "$tmp" 2>/dev/null \
  | while IFS=$'\t' read -r k v; do realm::print_kv "$k" "$v"; done

realm::print_section "Home Assistant"
jq -r '
  .ha // {}
  | to_entries[]
  | "\(.key)\t\(.value)"' "$tmp" 2>/dev/null \
  | while IFS=$'\t' read -r k v; do realm::print_kv "$k" "$v"; done

realm::print_section "Sublabels (node count)"
count=$(jq -r '.sublabels // {} | length' "$tmp" 2>/dev/null)
realm::print_kv "nodes_with_sublabels" "$count"
