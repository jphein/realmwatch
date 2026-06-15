#!/usr/bin/env bash
# realm-maintenance — schedule/cancel/inspect maintenance windows.
#
# Wraps POST /maintenance/windows with ergonomic flags for the common
# "mute this host for the next 2 hours" case. The declarative plugin
# CLI (plugin.json cli.verbs) handles list/active/check/cancel; this
# Method-A wrapper adds `schedule` which the declarative form can't
# easily express (computing ends_at from a duration string).

set -euo pipefail

REALM_HELP_SUMMARY="Schedule, list, and cancel maintenance windows (mute alerts during planned downtime)"
REALM_SUBCOMMANDS="schedule
list
active
check
cancel"

realm::help() {
  cat <<'EOF'
realm maintenance — schedule maintenance windows

USAGE:
  realm maintenance schedule <pattern> --for <DURATION> [--name "..."]
                              [--starts-in <DURATION>] [--recur RECUR]
  realm maintenance list
  realm maintenance active
  realm maintenance check <node>
  realm maintenance cancel <id>

PATTERNS:
  <node-id>              exact match: e.g. familiar
  '<glob>'               fnmatch glob: e.g. north-*, *.firewall
  role:<role>            every host with this role: role:server
  tag:<tag>              every host carrying this tag: tag:nas

DURATION FORMATS:
  30m, 2h, 1d, 1h30m   suffix-based. m=minutes, h=hours, d=days.

EXAMPLES:
  # Mute familiar for the next 2 hours (apt upgrade + reboot)
  realm maintenance schedule familiar --for 2h --name "kernel upgrade"

  # Mute every router for a 90-minute ISP outage starting now
  realm maintenance schedule 'role:router' --for 90m --name "ISP swap"

  # Mute the NAS overnight (8 hours, starts in 30 minutes)
  realm maintenance schedule disks --for 8h --starts-in 30m --name "RAID rebuild"

  # Weekly maintenance: every Tuesday 02:00 for 1 hour
  realm maintenance schedule '*' --for 1h --recur weekly --name "weekly maintenance"
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

# Parse durations like 2h, 30m, 1d, 1h30m → seconds
_parse_duration() {
  local input="$1"
  local total=0
  while [[ "$input" =~ ^([0-9]+)([smhd])(.*)$ ]]; do
    local n="${BASH_REMATCH[1]}"
    local u="${BASH_REMATCH[2]}"
    input="${BASH_REMATCH[3]}"
    case "$u" in
      s) total=$((total + n)) ;;
      m) total=$((total + n * 60)) ;;
      h) total=$((total + n * 3600)) ;;
      d) total=$((total + n * 86400)) ;;
    esac
  done
  if [[ -n "$input" ]]; then
    echo "0"
    return 1
  fi
  echo "$total"
}

sub="${1:-list}"
shift || true

case "$sub" in
  schedule)
    [[ $# -ge 1 ]] || realm::die "usage: realm maintenance schedule <pattern> --for DUR" 2
    pattern="$1"; shift
    duration_s=""; starts_in_s=0; name=""; recur="once"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --for)
          duration_s=$(_parse_duration "$2") || realm::die "invalid duration: $2" 2
          shift 2 ;;
        --for=*)
          duration_s=$(_parse_duration "${1#*=}") || realm::die "invalid duration: ${1#*=}" 2
          shift ;;
        --starts-in)
          starts_in_s=$(_parse_duration "$2") || realm::die "invalid duration: $2" 2
          shift 2 ;;
        --starts-in=*)
          starts_in_s=$(_parse_duration "${1#*=}") || realm::die "invalid duration: ${1#*=}" 2
          shift ;;
        --name) name="$2"; shift 2 ;;
        --name=*) name="${1#*=}"; shift ;;
        --recur) recur="$2"; shift 2 ;;
        --recur=*) recur="${1#*=}"; shift ;;
        *) realm::die "unknown arg: $1" 2 ;;
      esac
    done
    [[ -z "$duration_s" || "$duration_s" -eq 0 ]] && realm::die "--for DURATION is required (e.g. 2h, 30m)" 2

    starts_at=$(($(date +%s) + starts_in_s))
    ends_at=$((starts_at + duration_s))

    body=$(jq -n \
      --arg name "$name" \
      --arg pattern "$pattern" \
      --argjson starts_at "$starts_at" \
      --argjson ends_at "$ends_at" \
      --arg recur "$recur" \
      '{name:$name, node_pattern:$pattern, starts_at:$starts_at, ends_at:$ends_at, recur:$recur, enabled:true}')

    response=$(realm::api_post /maintenance/windows "$body")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s\n' "$response"
    else
      wid=$(printf '%s' "$response" | jq -r '.id // .error')
      printf '%s scheduled: %s\n' "$wid" "$pattern"
      printf '  starts: %s\n' "$(date -d @$starts_at +'%Y-%m-%d %H:%M:%S')"
      printf '  ends:   %s\n' "$(date -d @$ends_at +'%Y-%m-%d %H:%M:%S')"
      printf '  recur:  %s\n' "$recur"
      [[ -n "$name" ]] && printf '  name:   %s\n' "$name"
      printf '\nCancel with: realm maintenance cancel %s\n' "$wid"
    fi
    ;;
  list|active|check|cancel)
    # Forward to the declarative plugin handler — same flow as `realm <plugin>`
    # would route. We re-exec realm-plugin.sh with the maintenance plugin name.
    handler="$(dirname "${BASH_SOURCE[0]}")/realm-plugin.sh"
    if [[ -x "$handler" ]]; then
      exec "$handler" maintenance "$sub" "$@"
    fi
    realm::die "realm-plugin handler missing; can't forward $sub" 1  # internal error, not auth
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
