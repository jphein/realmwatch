#!/bin/bash
# Single-instance wrapper for switch-tempmon.exp — the V1910 polling feed.
# Auto-kills any prior instance via pidfile so duplicate runs don't double-write
# the log (which would confuse multi-tempmon).
#
# Usage: switch-tempmon-feed.sh [interval_seconds]    default 30
#
# State dir: $XDG_STATE_HOME/realm/switch-fan/  (override via $REALM_STATE_DIR)

set -u
INTERVAL="${1:-30}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${REALM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/realm}/switch-fan"
LOG="$LOG_DIR/tempmon.log"
PIDFILE="$LOG_DIR/feed.pid"
mkdir -p "$LOG_DIR"

if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        kill "$old" 2>/dev/null
        sleep 2
        kill -0 "$old" 2>/dev/null && kill -9 "$old" 2>/dev/null
    fi
fi
echo $$ > "$PIDFILE"

cleanup() { rm -f "$PIDFILE"; }
trap cleanup EXIT INT TERM

exec "$SELF_DIR/switch-tempmon.exp" "$INTERVAL" >> "$LOG" 2>&1
