#!/usr/bin/env bash
# realm-plugins — list or toggle realm plugins
set -euo pipefail

REALM_HELP_SUMMARY="List or toggle realm plugins"
realm::help() {
  cat <<'EOF'
realm plugins — list or toggle realm plugins

USAGE:
  realm plugins <SUBCOMMAND>

SUBCOMMANDS:
  list             List all plugins (default)
  toggle <name>    Enable or disable a plugin
  show <name>      Show details for one plugin

EXAMPLES:
  realm plugins list
  realm plugins toggle alerting
  realm plugins show discovery
EOF
  realm::help_flags
}

REALM_SUBCOMMANDS="list
toggle
show"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::api_get /plugins \
      | realm::fmt_table '
          (["NAME","TYPE","ENABLED","PANEL","DEPENDS"] | @tsv),
          ((if type == "array" then . else .plugins // [] end)[]
            | [
                .name // "-",
                .type // "integrated",
                ((.enabled // true) | tostring),
                ((.has_panel // false) | tostring),
                ((.depends_on // []) | join(","))
              ] | @tsv)
        '
    ;;
  toggle)
    [[ $# -ge 1 ]] || realm::die "missing plugin name" 2
    body=$(jq -n --arg n "$1" '{name:$n}')
    realm::api_post /plugins/toggle "$body"
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "missing plugin name" 2
    realm::api_get /plugins \
      | jq --arg n "$1" '(if type == "array" then . else .plugins // [] end) | map(select(.name == $n)) | .[0]' \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
