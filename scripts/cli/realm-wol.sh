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

USAGE (wake/sleep/arm/doctor take one or more hosts):
  realm wol [wake] <node_id|mac>...  send a Wake-on-LAN magic packet (default verb)
  realm wol sleep <host>...          suspend a WoL-armed host to S3 (refused if unknown,
                                     not allow-listed, or not armed)
  realm wol arm <host>...            arm Wake-on-LAN on the host's NIC (ethtool wol g;
                                     refused on wireless NICs — nothing to wake)
  realm wol doctor <host>...         check WoL readiness (SSH + wired-vs-wifi + 'Wake-on: g')
  realm wol show                     list WoL-managed hosts and their power state

OPTIONS:
  --json                           Emit the raw API response as JSON
  --dry-run                        Preview the call without sending (mutating verbs)

EXAMPLES:
  realm wol katana                 # wake (back-compat)
  realm wol wake gpu0 gpu1         # multi-target: one packet each
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
  local resp rc=0
  resp=$(realm::api_post /wol "$(jq -n --arg target "$1" '{target:$target}')") || rc=$?
  _emit_action wake "$1" "$resp"
  return "$rc"
}

_wol_sleep() {
  local resp rc=0
  resp=$(realm::api_post /plugins/wol/sleep "$(jq -n --arg target "$1" '{target:$target}')") || rc=$?
  _emit_action sleep "$1" "$resp"
  return "$rc"
}

_wol_arm() {
  local resp rc=0
  resp=$(realm::api_post /plugins/wol/arm "$(jq -n --arg target "$1" '{target:$target}')") || rc=$?
  _emit_action arm "$1" "$resp"
  return "$rc"
}

_wol_doctor() {
  local out rc=0
  out=$(realm::api_get "/plugins/wol/doctor?target=$(printf '%s' "$1" | jq -Rr @uri)") || rc=$?
  [[ -n "$out" ]] && printf '%s' "$out" | realm::fmt_kv
  return "$rc"
}

# Run a per-host action over every argument. Prints a `── host ──` header when
# more than one target was given (human mode only — headers would corrupt
# --json output), keeps going after a failure, and returns the FIRST non-zero
# code once every target has been attempted. Exists because `realm wol wake
# gpu0 gpu1` used to silently drop every argument after the first (2026-08-16)
# — partial work must neither be invisible nor read as total success.
_for_targets() {
  local action="$1"; shift
  local rc=0 s t
  for t in "$@"; do
    [[ $# -gt 1 && "$REALM_OUTPUT" != "json" ]] && printf '── %s ──\n' "$t"
    s=0; "$action" "$t" || s=$?
    [[ $rc -eq 0 && $s -ne 0 ]] && rc=$s
    true
  done
  return "$rc"
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
    [[ $# -ge 1 ]] || realm::die "usage: realm wol doctor <host>..." 2
    _for_targets _wol_doctor "$@"
    ;;
  sleep)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol sleep <host>..." 2
    _for_targets _wol_sleep "$@"
    ;;
  arm)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol arm <host>..." 2
    _for_targets _wol_arm "$@"
    ;;
  wake)
    shift
    [[ $# -ge 1 ]] || realm::die "usage: realm wol wake <node_id|mac>..." 2
    _for_targets _wol_wake "$@"
    ;;
  *)
    # Back-compat: bare `realm wol <node_id|mac>...` = wake.
    _for_targets _wol_wake "$@"
    ;;
esac
