#!/usr/bin/env bash
# realm-tail — live, colored SSE event stream with per-type formatting.
# Pretty sibling of `realm watch`; pipes /sse through scripts/lib/sse-pretty.py.
set -euo pipefail

REALM_HELP_SUMMARY="Live, colored SSE event stream (pretty sibling of realm watch)"
realm::help() {
  cat <<'EOF'
realm tail — live colored SSE event stream

USAGE:
  realm tail [PLUGIN] [--type TYPES] [--since DURATION] [--json] [--no-color]

Each event prints on one line:  HH:MM:SS  [type]  node  message
Color is per event-type (alert=red, speech=cyan, quest=yellow,
discovery=magenta, status=green, …). Disabled when stdout is not a TTY,
NO_COLOR / REALM_NO_COLOR=1 is set, or --no-color is passed.

PLUGIN (positional) filters to events whose .source_system / .plugin /
.source matches the given name.

In --json mode, each event is emitted as one line of newline-delimited
JSON (NDJSON) — the raw event object, with an "event" key naming the SSE
channel if the payload doesn't already carry one. Filters (PLUGIN, --type,
--since backfill) still apply. The status banner goes to stderr, so stdout
stays pure NDJSON and is safe to pipe to jq.

OPTIONS:
  -h, --help          show this help
  --type TYPES        comma-separated event types to keep (alert,quest,…)
  --since DURATION    backfill recent events first (5m, 30s, 1h, 2d)
  --json              emit NDJSON (one raw event object per line)
  --no-color          disable ANSI color

EXAMPLES:
  realm tail
  realm tail --type alert,quest
  realm tail combat-ward
  realm tail --since 5m
  realm tail combat-ward --type alert
  realm tail --json | jq -c 'select(.event == "alert")'

SEE ALSO:
  realm watch    raw SSE tailer, --sources lists registered feeds
  realm logs     server stdout / journalctl — different stream entirely
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-python.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

TYPES=""; SINCE=""; PLUGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)
      [[ $# -ge 2 && -n "${2:-}" ]] || realm::die "--type requires a value" 2
      TYPES="$2"; shift 2 ;;
    --type=*)  TYPES="${1#*=}"; shift ;;
    --since)
      [[ $# -ge 2 && -n "${2:-}" ]] || realm::die "--since requires a value (e.g. 30s, 5m, 1h, 2d)" 2
      SINCE="$2"; shift 2 ;;
    --since=*) SINCE="${1#*=}"; shift ;;
    --*)       realm::die "unknown flag: $1 (try: realm tail --help)" 2 ;;
    *)
      [[ -z "$PLUGIN" ]] || realm::die "too many positional args: only one PLUGIN allowed" 2
      PLUGIN="$1"; shift
      ;;
  esac
done

realm::api_reachable || realm::die_unreachable

_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$_self_dir/../lib/sse-pretty.py"
[[ -f "$HELPER" ]] || realm::die "missing helper: $HELPER" 1  # internal error, not auth

# --since DURATION → backfill via /events?since=<unix-ts>. 5m/30s/1h/2d.
BACKFILL_FILE=""
if [[ -n "$SINCE" ]]; then
  # Validate numeric portion *before* arithmetic expansion. Under set -e,
  # values like `xm` would abort with an arithmetic error instead of our
  # intended usage error; values like `09m` would be parsed as octal and
  # fail on the digit 9. Force base-10 with 10# to avoid the latter.
  case "$SINCE" in
    *s) suffix=s; mult=1 ;;
    *m) suffix=m; mult=60 ;;
    *h) suffix=h; mult=3600 ;;
    *d) suffix=d; mult=86400 ;;
    *[!0-9]*) realm::die "invalid --since (try: 30s, 5m, 1h, 2d)" 2 ;;
    *) suffix=""; mult=1 ;;   # bare integer = seconds
  esac
  num="${SINCE%$suffix}"
  [[ "$num" =~ ^[0-9]+$ ]] || realm::die "invalid --since (try: 30s, 5m, 1h, 2d)" 2
  secs=$(( 10#$num * mult ))
  since_ts=$(( $(date +%s) - secs ))
  BACKFILL_FILE="$(mktemp -t realm-tail-backfill.XXXXXX.json)"
  # limit=0 explicitly opts out of /events' default page size (#126). This
  # request is already bounded — by --since — so the cap meant for unqualified
  # callers would silently trim the far end of a long window (e.g. --since 2d).
  if ! curl --silent --max-time 5 --fail \
        "${REALM_API}/events?since=${since_ts}&limit=0" -o "$BACKFILL_FILE" 2>/dev/null; then
    realm::warn "backfill failed (continuing with live stream only)"
    rm -f "$BACKFILL_FILE"; BACKFILL_FILE=""
  fi
fi

helper_args=()
[[ -n "$TYPES"          ]] && helper_args+=( --type   "$TYPES"  )
[[ -n "$PLUGIN"         ]] && helper_args+=( --plugin "$PLUGIN" )
[[ "${REALM_NO_COLOR:-}" = "1" ]] && helper_args+=( --no-color )
[[ -n "$BACKFILL_FILE"  ]] && helper_args+=( --backfill "$BACKFILL_FILE" )
# --json (REALM_OUTPUT=json, set by realm::parse_common) → NDJSON mode. The
# helper emits one raw event object per line; the banner stays on stderr
# (realm::say) so stdout is pure NDJSON.
[[ "${REALM_OUTPUT:-human}" = "json" ]] && helper_args+=( --json )

banner="Tailing /sse"
[[ "${REALM_OUTPUT:-human}" = "json" ]] && banner="$banner  (NDJSON)"
[[ -n "$PLUGIN" ]] && banner="$banner  plugin=$PLUGIN"
[[ -n "$TYPES"  ]] && banner="$banner  type=$TYPES"
[[ -n "$SINCE"  ]] && banner="$banner  since=$SINCE"
realm::say "$banner — Ctrl-C to stop"

# Use the realmwatch venv python via realm-python.sh helper (style guide).
PYTHON="$REALM_PYTHON"

# Run curl + python as separate jobs joined by a FIFO so the trap has
# direct PIDs to kill (a `|` pipeline hides children under a subshell that
# `pkill -P $$` can't reach). pipefail off around wait so a SIGINT-killed
# curl doesn't trip set -e.
#
# Use mktemp -d (atomic) rather than mktemp -u + mkfifo (TOCTOU race —
# filename is generated but not reserved, so another process could win
# the slot between the two calls). The dir gives us a unique namespace
# for the FIFO and a single rm -rf for cleanup.
#
# Reader is started before writer: open() for read on a FIFO blocks
# until a writer arrives (and vice versa), so both ends synchronise on
# the kernel. Starting python first guarantees no events fall on the
# floor in the window between curl opening the FIFO and python catching up.
FIFO_DIR="$(mktemp -d -t realm-tail.XXXXXX)"
FIFO="$FIFO_DIR/sse"
mkfifo "$FIFO"

cleanup() {
  trap - EXIT INT TERM
  [[ -n "${CURL_PID:-}"   ]] && kill "$CURL_PID"   2>/dev/null || true
  [[ -n "${PYTHON_PID:-}" ]] && kill "$PYTHON_PID" 2>/dev/null || true
  [[ -n "$BACKFILL_FILE" && -f "$BACKFILL_FILE" ]] && rm -f "$BACKFILL_FILE"
  [[ -d "$FIFO_DIR" ]] && rm -rf "$FIFO_DIR"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

# Reader first — blocks on open() until curl opens the writer end.
"$PYTHON" -u "$HELPER" "${helper_args[@]+"${helper_args[@]}"}" < "$FIFO" &
PYTHON_PID=$!
curl --silent --show-error --no-buffer \
     -H 'Accept: text/event-stream' \
     "${REALM_API}/sse" > "$FIFO" &
CURL_PID=$!

set +o pipefail
wait "$PYTHON_PID" 2>/dev/null
py_rc=$?
# After python exits (usually EOF from curl closing the FIFO), reap curl
# too so we can detect server disconnect / DNS / connection failures —
# otherwise python EOFs cleanly and we'd silently report success.
wait "$CURL_PID" 2>/dev/null
curl_rc=$?
set -o pipefail

# Propagate failures: SIGINT (130) wins, else curl failure, else python's rc
if (( py_rc == 130 || curl_rc == 130 )); then
  exit 130
elif (( curl_rc != 0 )); then
  realm::warn "curl ended non-zero (rc=$curl_rc) — server disconnected or unreachable"
  exit "$curl_rc"
else
  exit "$py_rc"
fi
