#!/usr/bin/env bash
# realm-player — player state (xp, rewards)
set -euo pipefail

REALM_HELP_SUMMARY="Show player state or award rewards"
realm::help() {
  cat <<'EOF'
realm player — player state and rewards

USAGE:
  realm player status
  realm player reward <type> <amount> [--reason TEXT]

EXAMPLES:
  realm player status
  realm player reward xp 50 --reason "Audited the realm"
  realm player reward gold 10
EOF
}

REALM_SUBCOMMANDS="status
reward"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-status}"
shift || true

case "$sub" in
  status)
    realm::api_get /player \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  reward)
    [[ $# -ge 2 ]] || realm::die "usage: realm player reward <type> <amount> [--reason TEXT]" 2
    type="$1"; amount="$2"; shift 2
    reason=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --reason) reason="$2"; shift 2 ;;
        --reason=*) reason="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    body=$(jq -n --arg t "$type" --argjson a "$amount" --arg r "$reason" \
      '{type:$t, amount:$a} + (if $r != "" then {reason:$r} else {} end)')
    realm::api_post /player/reward "$body"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
