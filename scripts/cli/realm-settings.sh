#!/usr/bin/env bash
# realm-settings — per-plugin settings storage
set -euo pipefail

REALM_HELP_SUMMARY="Get/set/unset per-plugin settings stored in the realm DB"
realm::help() {
  cat <<'EOF'
realm settings — manage per-plugin settings in the realm DB

USAGE:
  realm settings [SUBCOMMAND]

SUBCOMMANDS:
  list                                List all settings (default)
  get <plugin> [key]                  Read one or all settings for a plugin
  set <plugin> <key> <value>          Write a setting
  unset <plugin> <key>                Delete a setting

EXAMPLES:
  realm settings list
  realm settings get alerting
  realm settings set discovery scan_interval 30
EOF
}

REALM_SUBCOMMANDS="list
get
set
unset"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::api_get /settings \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then
          cat
        else
          jq -r '
            to_entries[]
            | .key as $ns
            | .value
            | to_entries[]
            | "\($ns)\t\(.key)\t\(.value | tostring)"
          ' 2>/dev/null | (echo -e "NAMESPACE\tKEY\tVALUE"; cat) | column -t -s$'\t'
        fi
    ;;
  get)
    [[ $# -ge 1 ]] || realm::die "missing plugin namespace" 2
    ns="$1"; shift
    if [[ $# -ge 1 ]]; then
      realm::api_get "/settings?namespace=$ns" | jq --arg k "$1" '.[$k] // empty'
    else
      realm::api_get "/settings?namespace=$ns" \
        | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    fi
    ;;
  set)
    [[ $# -ge 3 ]] || realm::die "usage: realm settings set <plugin> <key> <value>" 2
    body=$(jq -n --arg ns "$1" --arg k "$2" --arg v "$3" \
      '{namespace:$ns, key:$k, value:$v}')
    realm::api_post /settings "$body"
    ;;
  unset)
    [[ $# -ge 2 ]] || realm::die "usage: realm settings unset <plugin> <key>" 2
    realm::api_delete /settings "?namespace=$1&key=$2"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
