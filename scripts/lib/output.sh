# scripts/lib/output.sh
#
# Output formatters keyed on $REALM_OUTPUT (default "human", or "json").
#
# - realm::fmt_table JQ_FILTER       — JSON in, table (human) or raw JSON (json mode) out
# - realm::fmt_kv    JQ_FILTER       — JSON in, key=value pairs (human) or raw JSON (json mode) out
# - realm::fmt_event                 — colored single line per SSE event (human)
# - realm::print_kv KEY VALUE        — print one key/value pair, color-aware
# - realm::print_section TITLE       — section heading (colored)
# - realm::say MSG                   — chatty info to stderr (suppressed in --quiet)
# - realm::warn MSG                  — yellow warning to stderr
# - realm::die MSG [EXITCODE]        — red error to stderr, exit
#
# Requires jq for JSON manipulation. The realmwatch project already depends on
# jq across other tools.

# realm::_cmd_name — the user-facing command name used as the error/warn
# prefix. Users type `realm topology`, never the internal `realm-topology.sh`
# script filename, so derive the friendly form rather than leaking $0.
#
#   - Honors $REALM_CMD_NAME if a caller set it (the plugin handler sets
#     "realm <plugin>", since one realm-plugin.sh script fronts many plugins).
#   - Otherwise strips the "realm-" prefix and ".sh" suffix from $0 and
#     prefixes "realm ": realm-topology.sh → "realm topology".
#   - The dispatcher itself ($0 = "realm") prints just "realm", matching its
#     own hand-rolled `✘ realm:` branding.
realm::_cmd_name() {
  if [[ -n "${REALM_CMD_NAME:-}" ]]; then
    printf '%s' "$REALM_CMD_NAME"
    return
  fi
  local base="${0##*/}"
  base="${base%.sh}"
  case "$base" in
    realm)   printf 'realm' ;;
    realm-*) printf 'realm %s' "${base#realm-}" ;;
    *)       printf 'realm %s' "$base" ;;
  esac
}

realm::die() {
  local msg="$1"
  local code="${2:-1}"
  printf '%s✘ %s:%s %s\n' "$R" "$(realm::_cmd_name)" "$N" "$msg" >&2
  exit "$code"
}

realm::warn() {
  local msg="$1"
  printf '%s! %s:%s %s\n' "$Y" "$(realm::_cmd_name)" "$N" "$msg" >&2
}

realm::say() {
  [[ -n "${REALM_QUIET:-}" ]] && return 0
  local msg="$1"
  printf '%s%s\n' "$D" "$msg$N" >&2
}

realm::verbose() {
  [[ -z "${REALM_VERBOSE:-}" ]] && return 0
  printf '%s· %s%s\n' "$D" "$1" "$N" >&2
}

realm::print_section() {
  printf '\n%s%s%s\n' "$W" "$1" "$N"
}

realm::print_kv() {
  printf '  %s%-22s%s %s\n' "$D" "$1" "$N" "$2"
}

# realm::fmt_table — pretty-print a JSON array or object as a table.
# Pass a jq filter that yields tab-separated rows; the first row is the header.
# In --json mode, just pass the JSON through.
#
# Example:
#   realm::api_get /quests | realm::fmt_table '
#     ["ID","NAME","STATUS"],
#     (.[] | [.id, .name, .status])
#     | @tsv'
realm::fmt_table() {
  local filter="$1"
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    cat
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    realm::warn "jq not installed; falling back to raw output"
    cat
    return
  fi
  jq -r "$filter" 2>/dev/null | column -t -s $'\t' || {
    realm::warn "JSON parse failed; showing raw"
    cat
  }
}

# realm::fmt_kv — pretty-print a JSON object as colored key=value pairs.
# In --json mode, passes JSON through.
realm::fmt_kv() {
  local filter="${1:-.}"
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    cat
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    cat
    return
  fi
  jq -r "$filter | to_entries[] | \"\(.key)\t\(.value)\"" 2>/dev/null \
    | while IFS=$'\t' read -r k v; do
        realm::print_kv "$k" "$v"
      done
}

# realm::fmt_event — format one SSE line as a colored event row.
# Input lines look like: "event: status\ndata: { ... }\n\n"
# We accept either a raw JSON line or a curl SSE stream; the SSE wrapper
# in realm-watch.sh strips event:/data: prefixes before piping in.
realm::fmt_event() {
  if ! command -v jq >/dev/null 2>&1; then
    cat
    return
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    # Try to parse as JSON; if it fails, print raw
    if echo "$line" | jq -e . >/dev/null 2>&1; then
      local etype color
      etype=$(echo "$line" | jq -r '.type // .event_type // "event"')
      color="$C"
      case "$etype" in
        error|critical) color="$R" ;;
        warn|warning)   color="$Y" ;;
        discovery)      color="$M" ;;
        speech|oracle)  color="$B" ;;
        status|update)  color="$G" ;;
      esac
      local ts; ts=$(echo "$line" | jq -r '.ts // .timestamp // ""')
      local text; text=$(echo "$line" | jq -r '.text // .message // (. | tostring)')
      [[ -n "$ts" ]] && printf '%s%s%s ' "$D" "$ts" "$N"
      printf '%s%s%s %s\n' "$color" "$etype" "$N" "$text"
    else
      printf '%s\n' "$line"
    fi
  done
}

# realm::status_ok / realm::status_fail — single-line PASS/FAIL helpers for
# things like realm health.
realm::status_ok() {
  printf '  %s✓%s %s\n' "$G" "$N" "$1"
}

realm::status_fail() {
  printf '  %s✘%s %s\n' "$R" "$N" "$1"
}

realm::status_warn() {
  printf '  %s!%s %s\n' "$Y" "$N" "$1"
}
