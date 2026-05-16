#!/usr/bin/env bash
# Manual update runner for the Scroll of Patch Runes plugin.
#
# Usage:
#   ./scripts/realm-update.sh                 # interactive: check all, then prompt to upgrade
#   ./scripts/realm-update.sh list            # list known sources
#   ./scripts/realm-update.sh check [source]  # check all, or one source
#   ./scripts/realm-update.sh run   [source]  # upgrade all, or one source (no prompt)
#   ./scripts/realm-update.sh -h | --help
#
# Description:
#   Thin CLI wrapper over plugins/system-updates/sources.py. Reuses the same
#   source definitions, commands, parsers, and lock groups as the web panel,
#   so CLI and browser stay in sync.
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/realm-update"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
( ls -1t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +11 | xargs -r rm -- ) || true

# python3 -u keeps stdout unbuffered so streaming subprocess lines appear live
# through the tee; pipefail (set above) propagates python's exit code.
python3 -u plugins/system-updates/cli.py "$@" 2>&1 | tee "$LOG"
