#!/usr/bin/env bash
# realm-plugin — generic CLI handler for plugins that declare CLI verbs in
# plugin.json. Used internally by the dispatcher; rarely invoked directly.
#
# A plugin opts into the CLI by adding a `cli` section to its plugin.json:
#
#   "cli": {
#     "summary": "Manage system updates",
#     "verbs": [
#       { "name": "list",    "method": "GET",    "path": "/updates" },
#       { "name": "history", "method": "GET",    "path": "/updates/history" },
#       { "name": "check",   "method": "POST",   "path": "/updates/check",
#         "body": {} },
#       { "name": "run",     "method": "POST",   "path": "/updates/run/<source>",
#         "args": ["source"] },
#       { "name": "table",   "method": "GET",    "path": "/updates",
#         "table": "(.sources // [])[] | [.name, .version, .ready]" }
#     ]
#   }
#
# Direct invocation forms (used by the dispatcher):
#
#   realm-plugin <plugin> --one-line-help        # print plugin summary
#   realm-plugin <plugin> --list-subcommands     # newline verbs
#   realm-plugin <plugin> --help                 # render help from manifest
#   realm-plugin <plugin> <verb> [args...]       # execute a verb
#
# Field semantics:
#   - name        verb name (e.g., "list", "check", "run")
#   - method      HTTP verb (GET, POST, PUT, DELETE)
#   - path        URL path with optional <placeholder>s
#   - args        ordered positional arg names that fill <placeholder>s
#                 (defaults to inferring from <...> tokens in path)
#   - body        default JSON body for POST/PUT. May be a literal object
#                 or a string with positional substitutions like "$1"
#   - table       jq filter used to format the response as a table
#                 (rows tab-separated; header is added if "header" field present)
#   - header      optional array of column names for the table

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"

# We bypass parse_common's auto-help because we need to dispatch help from the
# manifest, not from a hard-coded function. We still want the common flags
# applied (color, host, json), so handle them inline.

[[ $# -ge 1 ]] || { echo "realm-plugin: missing plugin name" >&2; exit 2; }

plugin="$1"; shift

# Locate the plugin manifest
_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
_repo_dir="$(cd "$(dirname "$_self")/../.." && pwd)"
manifest="$_repo_dir/plugins/$plugin/plugin.json"

if [[ ! -f "$manifest" ]]; then
  realm::die "no such plugin: $plugin (looked in $manifest)" 127
fi

# Read CLI section
cli_summary=$(jq -r '.cli.summary // .description // ""' "$manifest")
cli_verbs=$(jq -r '.cli.verbs // [] | map(.name) | .[]' "$manifest" 2>/dev/null)

if [[ -z "$cli_verbs" ]]; then
  realm::die "plugin '$plugin' has no .cli.verbs in plugin.json" 4
fi

# Handle dispatcher hooks
case "${1:-}" in
  --one-line-help)
    printf '%s\n' "$cli_summary"
    exit 0
    ;;
  --list-subcommands)
    printf '%s\n' "$cli_verbs"
    exit 0
    ;;
  ""|--help|-h|help)
    # Render help from the manifest
    icon=$(jq -r '.icon // ""' "$manifest")
    fantasy=$(jq -r '.fantasy_name // .name' "$manifest")
    printf '%srealm %s%s — %s\n\n' "$W" "$plugin" "$N" "$cli_summary"
    [[ -n "$fantasy" && "$fantasy" != "$plugin" ]] && \
      printf '  %s%s%s "%s"\n\n' "$D" "$icon" "$N" "$fantasy"
    printf '%sUSAGE%s\n' "$W" "$N"
    printf '  realm %s <verb> [args...]\n\n' "$plugin"
    printf '%sVERBS%s\n' "$W" "$N"
    jq -r '.cli.verbs // [] | .[] |
      "  \(.name)\t\(.method // "GET")\t\(.path // "-")\t\(.summary // "")"
    ' "$manifest" | column -t -s $'\t' | sed 's/^/  /'
    printf '\n%sFLAGS%s\n' "$W" "$N"
    printf '  --json        Print raw JSON response\n'
    printf '  --dry-run     Preview HTTP call without sending\n'
    printf '  --host URL    Override realm host\n'
    exit 0
    ;;
esac

verb="$1"; shift

# Look up the verb spec
verb_spec=$(jq -c --arg v "$verb" '.cli.verbs[] | select(.name == $v)' "$manifest")
if [[ -z "$verb_spec" || "$verb_spec" = "null" ]]; then
  realm::die "plugin '$plugin' has no verb '$verb' (try: realm $plugin --help)" 2
fi

# Parse common flags from the remaining args; rest become positionals
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Extract verb fields
method=$(printf '%s' "$verb_spec" | jq -r '.method // "GET"')
path=$(printf '%s' "$verb_spec" | jq -r '.path // ""')
body_tmpl=$(printf '%s' "$verb_spec" | jq -r '.body // empty')
table_filter=$(printf '%s' "$verb_spec" | jq -r '.table // empty')
header=$(printf '%s' "$verb_spec" | jq -r '(.header // []) | join("\t")')
arg_names=$(printf '%s' "$verb_spec" | jq -r '(.args // []) | .[]')

# Substitute <placeholder> tokens in the path. If `args` is declared, consume
# positionals in that order. Otherwise, consume in the order placeholders
# appear in the path.
declare -A path_vars=()

if [[ -n "$arg_names" ]]; then
  i=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if [[ $i -lt $# ]]; then
      eval "v=\${$((i+1))}"
      path_vars["$name"]="$v"
      i=$((i+1))
    else
      realm::die "verb '$verb' requires argument: $name" 2
    fi
  done <<< "$arg_names"
  # Shift consumed args off so $@ is what's left
  shift $i || true
else
  # Auto-fill from positionals in placeholder order
  while [[ "$path" == *"<"*">"* ]]; do
    placeholder=$(printf '%s' "$path" | grep -oE '<[a-zA-Z_][a-zA-Z0-9_]*>' | head -1)
    [[ -z "$placeholder" ]] && break
    name="${placeholder#<}"; name="${name%>}"
    if [[ $# -lt 1 ]]; then
      realm::die "verb '$verb' requires argument: $name (for $placeholder)" 2
    fi
    path_vars["$name"]="$1"
    shift
    # Replace just the first occurrence so we keep iterating cleanly
    path="${path//$placeholder/__PLACEHOLDER_${name}__}"
  done
  # Restore placeholder markers to actual values
  for name in "${!path_vars[@]}"; do
    path="${path//__PLACEHOLDER_${name}__/${path_vars[$name]}}"
  done
fi

# Now $@ holds remaining args. Used by body substitution if needed.

# Apply path substitution if --args mode was used (path_vars filled but path not yet substituted)
for name in "${!path_vars[@]}"; do
  path="${path//<$name>/${path_vars[$name]}}"
done

realm::api_reachable || realm::die_unreachable

# Build the request body. If body is a JSON object literal in the manifest,
# use it directly. If body is a string containing $1/$2 etc., substitute
# remaining positionals.
final_body=""
if [[ -n "$body_tmpl" ]]; then
  # Check if it's a JSON literal (object/array) or a string template
  if printf '%s' "$body_tmpl" | jq -e . >/dev/null 2>&1; then
    final_body="$body_tmpl"
  else
    # String template — substitute $1, $2, etc.
    final_body="$body_tmpl"
    i=1
    for v in "$@"; do
      final_body="${final_body//\$$i/$v}"
      i=$((i+1))
    done
  fi
fi

# Issue the request
case "$method" in
  GET)
    resp="$(realm::api_get "$path")"
    ;;
  POST)
    resp="$(realm::api_post "$path" "${final_body:-{\}}")"
    ;;
  PUT)
    resp="$(realm::api_put "$path" "${final_body:-{\}}")"
    ;;
  DELETE)
    resp="$(realm::api_delete "$path")"
    ;;
  *)
    realm::die "unsupported method in manifest: $method" 4
    ;;
esac

# Render response
if [[ "$REALM_OUTPUT" = "json" ]] || [[ -z "$table_filter" ]]; then
  printf '%s\n' "$resp"
else
  # Build a header line from the verb spec, prepend it to the jq filter output
  if [[ -n "$header" ]]; then
    {
      printf '%s\n' "$header"
      printf '%s' "$resp" | jq -r "$table_filter | @tsv" 2>/dev/null
    } | column -t -s$'\t'
  else
    printf '%s' "$resp" | jq -r "$table_filter | @tsv" 2>/dev/null | column -t -s$'\t'
  fi
fi
