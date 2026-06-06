#!/usr/bin/env bash
# realm-wol — Wake-on-LAN, remote S3 sleep, and power state (the Slumber Ward)
#
# This script intentionally OWNS `realm wol` (the dispatcher resolves core
# scripts in scripts/cli before plugin CLIs). It dispatches to the wol plugin's
# endpoints so the verbs work despite the plugin's declarative cli.verbs being
# shadowed. Bare `realm wol <host|mac>` stays back-compatible = wake.
set -euo pipefail

REALM_HELP_SUMMARY="Wake / slumber fleet hosts and inspect power state"
realm::help() {
  cat <<'EOF'
realm wol — Wake-on-LAN, remote S3 sleep, and power state (Slumber Ward)

USAGE:
  realm wol [wake] <node_id|mac>   send a Wake-on-LAN magic packet (default verb)
  realm wol sleep <host>           suspend a WoL-armed host to S3 (refused if not armed)
  realm wol arm <host>             arm Wake-on-LAN on the host's NIC (ethtool wol g)
  realm wol doctor <host>          check a host's WoL readiness (SSH + ethtool 'Wake-on: g')
  realm wol show                   list WoL-managed hosts and their power state

OPTIONS:
  --json                           Emit the raw API response as JSON
  --dry-run                        Preview the call without sending (mutating verbs)

EXAMPLES:
  realm wol katana                 # wake (back-compat)
  realm wol wake katana
  realm wol sleep familiar
  realm wol doctor familiar
  realm wol show
  realm wol show --json | jq '.hosts[]'
  realm wol wake katana --json --dry-run
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

[[ $# -ge 1 ]] || realm::die "usage: realm wol [wake|sleep|arm|doctor|show] <host>" 2

realm::api_reachable || realm::die_unreachable

# Format a POST/mutation response. In --json mode the raw API JSON passes
# through; under --dry-run (no body returned) we synthesize a JSON object so an
# agent still gets valid JSON describing the intended action. Human mode pretty-
# prints via fmt_kv (the DRY-RUN preview already went to stderr from realm::_run).
_emit_action() {
  local action="$1" target="$2" resp="$3"
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    if [[ -z "$resp" ]]; then
      jq -n --arg target "$target" --arg action "$action" \
        '{target:$target, action:$action, dry_run:true, status:"not-sent"}'
    else
      printf '%s' "$resp" | realm::fmt_kv
    fi
  else
    [[ -n "$resp" ]] && printf '%s' "$resp" | realm::fmt_kv
  fi
}

# Wake a target by posting to the raw /wol endpoint.
_wol_wake() {
  local resp
  resp=$(realm::api_post /wol "$(jq -n --arg target "$1" '{target:$target}')")
  _emit_action wake "$1" "$resp"
}

case "$1" in
  show)
    realm::api_get /plugins/wol/status | realm::fmt_table '
      ["HOST","STATE","REACHABLE","SLEEPABLE","WAKE_CAPABLE","IP"],
      (.hosts[]? | [
        .host,
        (.state // "?"),
        (.reachable | tostring),
        (.sleepable | tostring),
        (.wake_capable | tostring),
        (.ip // "-")
      ]) | @tsv'
    ;;
  doctor)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol doctor <host>" 2
    realm::api_get "/plugins/wol/doctor?target=$(printf '%s' "$1" | jq -Rr @uri)" \
      | realm::fmt_kv
    ;;
  sleep)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol sleep <host>" 2
    resp=$(realm::api_post /plugins/wol/sleep "$(jq -n --arg target "$1" '{target:$target}')")
    _emit_action sleep "$1" "$resp"
    ;;
  arm)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol arm <host>" 2
    resp=$(realm::api_post /plugins/wol/arm "$(jq -n --arg target "$1" '{target:$target}')")
    _emit_action arm "$1" "$resp"
    ;;
  wake)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol wake <node_id|mac>" 2
    _wol_wake "$1"
    ;;
  *)
    # Back-compat: bare `realm wol <node_id|mac>` = wake.
    _wol_wake "$1"
    ;;
esac
