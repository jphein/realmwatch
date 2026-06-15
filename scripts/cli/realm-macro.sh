#!/usr/bin/env bash
# realm-macro — manage user macros (per-host / per-role / global) used in
# alerting rule expansion. Zabbix-style {$NAME} tokens.
#
# Scope resolution order: host → role → global (first hit wins).

set -euo pipefail

REALM_HELP_SUMMARY="Manage user macros for alerting rule parameterization"
REALM_SUBCOMMANDS="list
get
set
unset
explain"

realm::help() {
  cat <<'EOF'
realm macro — manage user macros for alerting rules

USAGE:
  realm macro list [--node NAME] [--role NAME] [--scope SCOPE]
  realm macro get <NAME> [--node NAME] [--role NAME]
  realm macro set <NAME> <VALUE> [--scope SCOPE] [--node NAME] [--role NAME]
  realm macro unset <NAME> [--scope SCOPE] [--node NAME] [--role NAME]
  realm macro explain <NAME> [--node NAME] [--role NAME]

OPTIONS:
  --scope SCOPE   global (default), host, role
  --node NAME     Target node (required for host scope)
  --role NAME     Target role (required for role scope)

RESOLUTION ORDER (first hit wins):
  1. host:<node_id>    most specific
  2. role:<role>       role default
  3. global            fleet-wide default

USE IN RULES:
  Rule conditions can reference macros as {$NAME}:
    {"threshold": "{$DISK_FULL_PCT}", "node_pattern": "*"}
  Before each rule evaluation, every string value is expanded against the
  event's node scope. Unresolved macros stay as {$NAME} (visible, not
  silently dropped).

EXAMPLES:
  # Default disk threshold for the fleet
  realm macro set DISK_FULL_PCT 80
  # Override for the NAS (it has more headroom)
  realm macro set DISK_FULL_PCT 95 --scope host --node disks
  # All Ubuntu servers get a tighter load threshold
  realm macro set LOAD_HIGH 4.0 --scope role --role server
  # See the resolution chain for one host
  realm macro explain DISK_FULL_PCT --node familiar
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

# Helper: pull --scope/--node/--role from $@
_parse_scope_args() {
  scope="global"; node=""; role=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope) scope="$2"; shift 2 ;;
      --scope=*) scope="${1#*=}"; shift ;;
      --node) node="$2"; shift 2 ;;
      --node=*) node="${1#*=}"; shift ;;
      --role) role="$2"; shift 2 ;;
      --role=*) role="${1#*=}"; shift ;;
      *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
  done
}

case "$sub" in
  list)
    # Default to scope=all so list shows every scope in use
    scope="all"; node=""; role=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --scope) scope="$2"; shift 2 ;;
        --scope=*) scope="${1#*=}"; shift ;;
        --node) node="$2"; shift 2 ;;
        --node=*) node="${1#*=}"; shift ;;
        --role) role="$2"; shift 2 ;;
        --role=*) role="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    qs="?scope=$scope"
    [[ -n "$node" ]] && qs="$qs&node=$node"
    [[ -n "$role" ]] && qs="$qs&role=$role"
    realm::api_get /macros "$qs" \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then
          cat
        else
          jq -r '
            to_entries[]
            | .key as $scope
            | .value
            | to_entries[]
            | "\($scope)\t\(.key)\t\(.value | tostring)"
          ' 2>/dev/null \
          | (echo -e "SCOPE\tNAME\tVALUE"; cat) \
          | column -t -s$'\t'
        fi
    ;;
  get)
    [[ $# -ge 1 ]] || realm::die "usage: realm macro get <NAME> [--node N] [--role R]" 2
    name="$1"; shift
    _parse_scope_args "$@"
    qs=""
    [[ -n "$node" ]] && qs="${qs:+$qs&}node=$node"
    [[ -n "$role" ]] && qs="${qs:+$qs&}role=$role"
    [[ -n "$qs" ]] && qs="?$qs"
    response=$(realm::api_get "/macros/$name/explain" "$qs")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s' "$response" | jq '.value'
    else
      printf '%s' "$response" | jq -r '
        if .value == null then "(unresolved)"
        else "\(.value)  [from \(.resolved_from)]"
        end'
    fi
    ;;
  set)
    [[ $# -ge 2 ]] || realm::die "usage: realm macro set <NAME> <VALUE> [--scope S] [--node N] [--role R]" 2
    name="$1"; value="$2"; shift 2
    _parse_scope_args "$@"
    body=$(jq -n --arg v "$value" --arg s "$scope" --arg n "$node" --arg r "$role" \
      '{value:$v, scope:$s, node:$n, role:$r}')
    response=$(realm::api_post "/macros/$name" "$body")
    if printf '%s' "$response" | jq -e '.error' >/dev/null 2>&1; then
      # arbitrary upstream .error message — generic failure (1), not auth (4)
      realm::die "$(printf '%s' "$response" | jq -r '.error')" 1
    fi
    realm::say "set $name = $value (scope=$scope${node:+ node=$node}${role:+ role=$role})"
    ;;
  unset)
    [[ $# -ge 1 ]] || realm::die "usage: realm macro unset <NAME> [--scope S] [--node N] [--role R]" 2
    name="$1"; shift
    _parse_scope_args "$@"
    qs="?scope=$scope"
    [[ -n "$node" ]] && qs="$qs&node=$node"
    [[ -n "$role" ]] && qs="$qs&role=$role"
    realm::api_delete "/macros/$name" "$qs" > /dev/null
    realm::say "unset $name from scope=$scope${node:+ node=$node}${role:+ role=$role}"
    ;;
  explain)
    [[ $# -ge 1 ]] || realm::die "usage: realm macro explain <NAME> [--node N] [--role R]" 2
    name="$1"; shift
    _parse_scope_args "$@"
    qs=""
    [[ -n "$node" ]] && qs="${qs:+$qs&}node=$node"
    [[ -n "$role" ]] && qs="${qs:+$qs&}role=$role"
    [[ -n "$qs" ]] && qs="?$qs"
    response=$(realm::api_get "/macros/$name/explain" "$qs")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s' "$response"
    else
      printf '%s' "$response" | jq -r '
        "Macro:   \(.name)",
        "Node:    \(if (.node_id // "") == "" then "(none)" else .node_id end)",
        "Role:    \(if (.role // "") == "" then "(none)" else .role end)",
        "",
        "Resolution chain:",
        (.chain[] | "  \(if .present then "✓" else "✗" end) \(.scope)\(if .present then " → \(.value | tostring)" else "" end)"),
        "",
        (if .value == null
          then "Result: unresolved"
          else "Result: \(.value | tostring)  (from \(.resolved_from))"
         end)
      '
    fi
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
