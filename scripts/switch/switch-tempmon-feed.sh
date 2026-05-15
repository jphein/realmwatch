#!/bin/bash
# Single-instance wrapper for switch-tempmon.exp — the V1910 polling feed.
# Auto-kills any prior instance via pidfile so duplicate runs don't double-write
# the log (which would confuse multi-tempmon).
#
# Usage: switch-tempmon-feed.sh [interval_seconds]    default 30

set -u
INTERVAL="${1:-30}"
LOG_DIR="$HOME/.claude/projects/-home-jp/scratch/switch-fan"
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

exec /home/jp/Projects/realmwatch/scripts/switch/switch-tempmon.exp "$INTERVAL" >> "$LOG" 2>&1
