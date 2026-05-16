#!/usr/bin/env bash
# realm-persona — manage node personas
set -euo pipefail

REALM_HELP_SUMMARY="List or update node personas"
realm::help() {
  cat <<'EOF'
realm persona — manage node personas

USAGE:
  realm persona <SUBCOMMAND> [args]

SUBCOMMANDS:
  list                          List all personas
  get <node_id>                 Show one persona
  set <node_id> <field> <value> Set a single persona field

EXAMPLES:
  realm persona list
  realm persona get gatekeeper
  realm persona set katana voice "Storyteller"
EOF
}

REALM_SUBCOMMANDS="list
get
set"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::api_get /personas \
      | realm::fmt_table '
          (["NODE","NAME","ROLE","VOICE"] | @tsv),
          (to_entries[] | [.key, (.value.name // "-"), (.value.role // "-"), (.value.voice // "-")] | @tsv)
        '
    ;;
  get)
    [[ $# -ge 1 ]] || realm::die "missing node id" 2
    realm::api_get /personas | jq --arg id "$1" '.[$id] // empty' \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  set)
    [[ $# -ge 3 ]] || realm::die "usage: realm persona set <node_id> <field> <value>" 2
    id="$1"; field="$2"; value="$3"
    # Fetch full personas, modify the one entry, post back
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    realm::api_get /personas > "$tmp"
    body=$(jq --arg id "$id" --arg f "$field" --arg v "$value" \
      '. as $p | .[$id] = (($p[$id] // {}) + {($f): $v})' "$tmp")
    realm::api_post /personas "$body"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
