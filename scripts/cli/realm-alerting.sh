#!/usr/bin/env bash
# realm-alerting — manage the alerting plugin
set -euo pipefail

REALM_HELP_SUMMARY="Manage alerting channels, rules, and history"
realm::help() {
  cat <<'EOF'
realm alerting — manage the alerting plugin

USAGE:
  realm alerting <SUBCOMMAND>

SUBCOMMANDS:
  status                  Show alerting service status
  channels                List notification channels
  channels test <name>    Send a test alert to a channel
  rules                   List alert rules
  history                 Show recent alert deliveries
  history clear           Clear alert history
  why <node>              Explain why <node>'s alerts are or aren't firing
                          (Zabbix-style trigger dependency walk)
  dependencies            Show recent suppression decisions (audit trail)

EXAMPLES:
  realm alerting status
  realm alerting channels
  realm alerting channels test desktop
  realm alerting rules
  realm alerting why familiar         # walks upstream, shows the chain
  realm alerting dependencies         # last hour's suppressions
EOF
  realm::help_flags
}

REALM_SUBCOMMANDS="status
channels
rules
history
why
dependencies"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-status}"
shift || true

case "$sub" in
  status)
    realm::api_get /alerting/status \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  channels)
    csub="${1:-list}"
    shift || true
    case "$csub" in
      list|"")
        realm::api_get /alerting/channels \
          | realm::fmt_table '
              (["NAME","TYPE","ENABLED"] | @tsv),
              ((if type == "array" then . else .channels // [] end)[]
                | [.name // "-", .type // "-", ((.enabled // true) | tostring)] | @tsv)
            '
        ;;
      test)
        [[ $# -ge 1 ]] || realm::die "missing channel name" 2
        body=$(jq -n --arg n "$1" '{name:$n}')
        realm::api_post /alerting/channels/test "$body"
        ;;
      *)
        realm::die "unknown channels subcommand: $csub" 2
        ;;
    esac
    ;;
  rules)
    realm::api_get /alerting/rules \
      | realm::fmt_table '
          (["ID","NAME","PRIORITY","ENABLED"] | @tsv),
          ((if type == "array" then . else .rules // [] end)[]
            | [.id // "-", .name // "-", (.priority // 0 | tostring), ((.enabled // true) | tostring)] | @tsv)
        '
    ;;
  history)
    hsub="${1:-list}"
    shift || true
    case "$hsub" in
      list|"")
        realm::api_get /alerting/history \
          | realm::fmt_table '
              (["TIME","RULE","CHANNEL","STATUS"] | @tsv),
              ((if type == "array" then . else .history // [] end)[]
                | [.ts // .timestamp // "-", .rule // "-", .channel // "-", .status // "-"] | @tsv)
            '
        ;;
      clear)
        realm::api_delete /alerting/history
        ;;
      *)
        realm::die "unknown history subcommand: $hsub" 2
        ;;
    esac
    ;;
  why)
    [[ $# -ge 1 ]] || realm::die "usage: realm alerting why <node>" 2
    response=$(realm::api_get "/alerting/dependencies/why" "?node=$1")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s\n' "$response"
    else
      printf '%s\n' "$response" | jq -r '
        . as $r |
        "Node: \(.node) (self_in_problem: \(.self_in_problem))",
        "Lookback: \(.lookback_seconds)s",
        (if .would_suppress
          then "VERDICT: alerts WOULD be suppressed; blocking ancestor = \(.blocking_ancestor)"
          else "VERDICT: alerts would fire (no ancestor in problem state)"
         end),
        "",
        "Upstream chain:",
        (if (.upstream_chain | length) == 0
          then "  (no upstream connections found in topology)"
          else (.upstream_chain[] | "  \(if .in_problem then "✘" else "✓" end) \(.node)")
         end)
      ' 2>/dev/null
    fi
    ;;
  dependencies)
    realm::api_get /alerting/dependencies \
      | realm::fmt_table '
          (.decisions // [])
          | (["TIME","NODE","EVENT_TYPE","SEVERITY","SUPPRESSED","BLOCKING"] | @tsv),
            (.[]
              | [
                  (.ts | strftime("%H:%M:%S")),
                  .node // "-",
                  .event_type // "-",
                  .severity // "-",
                  (.suppressed | tostring),
                  .blocking_ancestor // "-"
                ]
              | @tsv)
        '
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
