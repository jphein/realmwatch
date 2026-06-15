#!/usr/bin/env bash
# realm-discovery — explore discovery engine entities & relations
set -euo pipefail

REALM_HELP_SUMMARY="List discovered entities, providers, links; trigger scans"
realm::help() {
  cat <<'EOF'
realm discovery — explore discovery engine entities & relations

USAGE:
  realm discovery <SUBCOMMAND> [args]

SUBCOMMANDS:
  list                       List all discovered entities
  providers                  List active discovery provider plugins
  links                      Show relationship graph (manual + auto)
  show <node_id>             Show details for one node
  scan [--provider TYPE]     Trigger a discovery scan
  scan-aps [--subnet CIDR]   Sweep subnet for OpenWrt boxes not yet
       [--include-known]     in fleet.yaml — prints ready-to-paste
                             `realm fleet add` commands for each
  link <a> <b>               Create a manual link between two entities
  unlink <a> <b>             Remove a manual link
  manual                     List manual entries
  manual add <name>          Add a manual entry
  manual delete <name>       Remove a manual entry
  manual tags                Show available tags
  prototypes                 List discovery prototypes (LLD templates)
  entities --type T          Filter entities by type

EXAMPLES:
  realm discovery list
  realm discovery providers
  realm discovery scan
  realm discovery scan --provider snmp
  realm discovery link katana ubox0
  realm discovery prototypes
  realm discovery entities --type netdata_host
EOF
  realm::help_flags
}

REALM_SUBCOMMANDS="list
providers
links
show
scan
scan-aps
link
unlink
manual
prototypes
entities"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# scan-aps runs its own SSH probes against the network and does not need
# map_server — skip the reachability gate when that's the subcommand.
if [[ "${1:-}" != "scan-aps" ]]; then
  realm::api_reachable || realm::die_unreachable
fi

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::api_get /discovery \
      | realm::fmt_table '
          (["ID","NAME","TYPE","PROVIDER"] | @tsv),
          (.entities // . | (if type == "array" then . else to_entries | map(.value + {id: .key}) end)[]
            | [.id // "-", .name // "-", .type // "-", .provider // "-"] | @tsv)
        '
    ;;
  providers)
    realm::api_get /discovery/providers \
      | realm::fmt_table '
          (["NAME","CAPABILITIES","ACTIVE"] | @tsv),
          ((if type == "array" then . else to_entries | map(.value + {name: .key}) end)[]
            | [.name // "-", ((.capabilities // []) | join(",")), ((.active // true) | tostring)] | @tsv)
        '
    ;;
  links)
    realm::api_get /discovery/links \
      | realm::fmt_table '
          (["FROM","TO","KIND"] | @tsv),
          ((if type == "array" then . else .links // [] end)[]
            | [.from // .source // "?", .to // .target // "?", .kind // .type // "-"] | @tsv)
        '
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "missing node id" 2
    realm::api_get "/discovery/$1" \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  scan)
    provider=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --provider) provider="$2"; shift 2 ;;
        --provider=*) provider="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    if [[ -n "$provider" ]]; then
      body=$(jq -n --arg p "$provider" '{provider:$p}')
    else
      body='{}'
    fi
    realm::say "Triggering discovery scan..."
    realm::api_post /discovery/scan "$body"
    ;;
  scan-aps)
    exec "$(dirname "${BASH_SOURCE[0]}")/realm-discovery-scan-aps.sh" "$@"
    ;;
  link)
    [[ $# -ge 2 ]] || realm::die "usage: realm discovery link <a> <b>" 2
    body=$(jq -n --arg a "$1" --arg b "$2" '{from:$a, to:$b}')
    realm::api_post /discovery/link "$body"
    ;;
  unlink)
    [[ $# -ge 2 ]] || realm::die "usage: realm discovery unlink <a> <b>" 2
    body=$(jq -n --arg a "$1" --arg b "$2" '{from:$a, to:$b}')
    realm::api_post /discovery/unlink "$body"
    ;;
  manual)
    msub="${1:-list}"
    shift || true
    case "$msub" in
      list|"")
        realm::api_get /discovery/manual \
          | realm::fmt_table '
              (["NAME","TYPE","TAGS"] | @tsv),
              ((if type == "array" then . else .entries // [] end)[]
                | [.name // "-", .type // "-", ((.tags // []) | join(","))] | @tsv)
            '
        ;;
      add)
        [[ $# -ge 1 ]] || realm::die "missing entry name" 2
        body=$(jq -n --arg n "$1" '{name:$n}')
        realm::api_post /discovery/manual "$body"
        ;;
      delete)
        [[ $# -ge 1 ]] || realm::die "missing entry name" 2
        realm::api_delete /discovery/manual "?name=$1"
        ;;
      tags)
        realm::api_get /discovery/manual/tags
        ;;
      *)
        realm::die "unknown manual subcommand: $msub" 2
        ;;
    esac
    ;;
  prototypes)
    realm::api_get /discovery/prototypes \
      | realm::fmt_table '
          (["TYPE","PROVIDER","SUBLABEL","ALERTS"] | @tsv),
          ((if type == "array" then . else [] end)[]
            | [
                .entity_type // "-",
                .plugin // "-",
                (.sublabel // "-"),
                ((.alert_on // []) | length | tostring)
              ] | @tsv)
        '
    ;;
  entities)
    type_filter=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --type) type_filter="$2"; shift 2 ;;
        --type=*) type_filter="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    response=$(realm::api_get /discovery)
    # /discovery returns {sub_entities: {host: [entity, ...]}, summary: {...}}
    # Flatten + filter by entity_type
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s' "$response" | jq --arg t "$type_filter" '
        [.sub_entities // {} | to_entries[]
          | .key as $host
          | .value[] | . + {host_node_id: $host}]
        | (if $t == "" then . else map(select(.type == $t)) end)'
    else
      printf '%s' "$response" | jq -r --arg t "$type_filter" '
        [.sub_entities // {} | to_entries[]
          | .key as $host
          | .value[] | . + {host_node_id: $host}]
        | (if $t == "" then . else map(select(.type == $t)) end)
        | (["ID","TYPE","NAME","HOST","STATUS"] | @tsv),
          (.[] | [.id // "-", .type // "-", .name // "-", .host_node_id // "-", .status // "-"] | @tsv)
        ' | column -t -s$'\t'
    fi
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
