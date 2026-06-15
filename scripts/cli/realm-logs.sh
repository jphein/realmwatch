#!/usr/bin/env bash
# realm-logs — tail the realm server logs from wherever it's running.
#
# Auto-detects the source:
#   1. systemd user unit (realm-map-server.service) → journalctl --user
#   2. systemd system unit (same name)              → journalctl
#   3. foreground via `make dev`                    → /tmp/rw.log (the
#                                                     conventional redirect)
#   4. otherwise                                    → tries common scratch logs
#
# With --plugin <name>, filters output to lines that mention that plugin.
# With --since <when>, e.g. "1 hour ago", "yesterday" (systemd journalctl syntax).

set -euo pipefail

REALM_HELP_SUMMARY="Tail realm server logs (auto-detects systemd vs foreground)"
realm::help() {
  cat <<'EOF'
realm logs — tail realm server logs

USAGE:
  realm logs [--follow|-f] [--lines|-n N] [--plugin NAME] [--since WHEN] [--source]

OPTIONS:
  -h, --help          Show this help
  -f, --follow        Follow the log (Ctrl-C to stop)
  -n, --lines N       Print last N lines (default: 50)
  --plugin NAME       Filter for lines mentioning the plugin (case-insensitive)
  --since WHEN        e.g. "1 hour ago", "yesterday" (systemd-style)
  --source            Print which log source was detected, then exit
  --errors            Filter for ERROR/Failed/Traceback lines
  --json              Emit NDJSON: one {source, line} object per log line
  --no-color          Disable color (env: REALM_NO_COLOR=1)

EXAMPLES:
  realm logs                       # last 50 lines of whatever source is active
  realm logs -f                    # follow live
  realm logs -n 200 --plugin ha    # last 200 lines mentioning the ha plugin
  realm logs --errors -n 100       # last 100 lines, ERROR/Traceback only
  realm logs --json | jq -r .line  # machine-readable, then re-extract text
  realm logs --since "10 minutes ago"
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Defaults
FOLLOW=0
LINES=50
PLUGIN=""
SINCE=""
SHOW_SOURCE=0
ERRORS_ONLY=0

# Parse from positional args (realm::parse_common puts unknown flags here)
i=1
args=( "$@" )
while (( i <= $# )); do
  arg="${args[$((i-1))]}"
  case "$arg" in
    -f|--follow)  FOLLOW=1 ;;
    -n|--lines)   i=$((i+1)); LINES="${args[$((i-1))]:-50}" ;;
    --plugin)     i=$((i+1)); PLUGIN="${args[$((i-1))]:-}" ;;
    --since)      i=$((i+1)); SINCE="${args[$((i-1))]:-}" ;;
    --source)     SHOW_SOURCE=1 ;;
    --errors)     ERRORS_ONLY=1 ;;
  esac
  i=$((i+1))
done

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_self")/../.." && pwd)"

# Detect log source. Order matters: prefer systemd if active.
SOURCE=""
JOURNALCTL_ARGS=()

if systemctl --user is-active --quiet realm-map-server.service 2>/dev/null; then
  SOURCE="systemd-user"
  JOURNALCTL_ARGS=(journalctl --user -u realm-map-server.service)
elif systemctl is-active --quiet realm-map-server.service 2>/dev/null; then
  SOURCE="systemd-system"
  JOURNALCTL_ARGS=(sudo -n journalctl -u realm-map-server.service)
elif [[ -f /tmp/rw.log ]] && pgrep -f "python3.*map_server.py" >/dev/null 2>&1; then
  SOURCE="foreground:/tmp/rw.log"
elif [[ -f "$REALM_HOME/logs/realm-map-server.log" ]]; then
  SOURCE="file:$REALM_HOME/logs/realm-map-server.log"
elif [[ -f /tmp/rw.log ]]; then
  SOURCE="stale:/tmp/rw.log"
else
  realm::die "no realm log source found. Server not running, or logs not in a known location.
  expected one of:
    - systemd unit:  realm-map-server.service (user or system)
    - foreground:    \$REALM_HOME runs 'make dev' redirected to /tmp/rw.log
    - app log:       $REALM_HOME/logs/realm-map-server.log

start the server with: cd $REALM_HOME && make dev > /tmp/rw.log 2>&1 &" 3
fi

if [[ "$SHOW_SOURCE" -eq 1 ]]; then
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    jq -nc --arg source "$SOURCE" '{source: $source}'
  else
    echo "$SOURCE"
  fi
  exit 0
fi

# --json honors the flag by emitting NDJSON: one JSON object per log line,
# tagged with the detected source. Human mode passes lines through unchanged.
_emit() {
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    jq -Rc --unbuffered --arg source "$SOURCE" '{source: $source, line: .}'
  else
    cat
  fi
}

# Build filter pipeline
filter_cmd=(cat)
if [[ -n "$PLUGIN" ]]; then
  filter_cmd=(grep -i --line-buffered "$PLUGIN")
fi
if [[ "$ERRORS_ONLY" -eq 1 ]]; then
  if [[ "${filter_cmd[0]}" = "cat" ]]; then
    filter_cmd=(grep -E --line-buffered '(ERROR|Failed|Traceback|Exception|fail)')
  else
    # chain: stay simple, pipe through second grep externally
    :
  fi
fi

# Run the source, routing all output through _emit (NDJSON under --json).
{
case "$SOURCE" in
  systemd-*)
    cmd=( "${JOURNALCTL_ARGS[@]}" -n "$LINES" )
    [[ "$FOLLOW" -eq 1 ]]   && cmd+=( -f )
    [[ -n "$SINCE" ]]       && cmd+=( --since "$SINCE" )
    if [[ "$ERRORS_ONLY" -eq 1 && -n "$PLUGIN" ]]; then
      "${cmd[@]}" | grep -i --line-buffered "$PLUGIN" | grep -E --line-buffered '(ERROR|Failed|Traceback|Exception|fail)'
    elif [[ "$ERRORS_ONLY" -eq 1 ]]; then
      "${cmd[@]}" | grep -E --line-buffered '(ERROR|Failed|Traceback|Exception|fail)'
    elif [[ -n "$PLUGIN" ]]; then
      "${cmd[@]}" | grep -i --line-buffered "$PLUGIN"
    else
      "${cmd[@]}"
    fi
    ;;
  foreground:*|stale:*|file:*)
    log_file="${SOURCE#*:}"
    [[ "${SOURCE%%:*}" = "stale" ]] && realm::warn "log file exists but no map_server.py process running — showing stale content"
    if [[ "$FOLLOW" -eq 1 ]]; then
      if [[ "$ERRORS_ONLY" -eq 1 && -n "$PLUGIN" ]]; then
        tail -n "$LINES" -f "$log_file" | grep -i --line-buffered "$PLUGIN" | grep -E --line-buffered '(ERROR|Failed|Traceback|Exception|fail)'
      elif [[ "$ERRORS_ONLY" -eq 1 ]]; then
        tail -n "$LINES" -f "$log_file" | grep -E --line-buffered '(ERROR|Failed|Traceback|Exception|fail)'
      elif [[ -n "$PLUGIN" ]]; then
        tail -n "$LINES" -f "$log_file" | grep -i --line-buffered "$PLUGIN"
      else
        tail -n "$LINES" -f "$log_file"
      fi
    else
      if [[ "$ERRORS_ONLY" -eq 1 && -n "$PLUGIN" ]]; then
        tail -n "$LINES" "$log_file" | grep -i "$PLUGIN" | grep -E '(ERROR|Failed|Traceback|Exception|fail)' || true
      elif [[ "$ERRORS_ONLY" -eq 1 ]]; then
        tail -n "$LINES" "$log_file" | grep -E '(ERROR|Failed|Traceback|Exception|fail)' || true
      elif [[ -n "$PLUGIN" ]]; then
        tail -n "$LINES" "$log_file" | grep -i "$PLUGIN" || true
      else
        tail -n "$LINES" "$log_file"
      fi
    fi
    ;;
esac
} | _emit
