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

# Wave terminal (wavesrv) injects XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME
# as empty strings into spawned shells. The XDG basedir spec says empty should
# fall back to the default ($HOME/.cache etc.), but not every tool complies —
# notably, mise path-joins XDG_CACHE_HOME with "mise", yielding a relative dir
# and leaking cache into whatever CWD this script runs from. Normalize before
# any subprocess inherits.
[ -z "${XDG_CACHE_HOME:-}" ] && export XDG_CACHE_HOME="$HOME/.cache"
[ -z "${XDG_CONFIG_HOME:-}" ] && export XDG_CONFIG_HOME="$HOME/.config"
[ -z "${XDG_DATA_HOME:-}" ] && export XDG_DATA_HOME="$HOME/.local/share"

cd "$(dirname "$(realpath "$0")")/.."

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/realm-update"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
( ls -1t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +11 | xargs -r rm -- ) || true

# python3 -u keeps stdout unbuffered so streaming subprocess lines appear live
# through the tee; pipefail (set above) propagates python's exit code.
python3 -u plugins/system-updates/cli.py "$@" 2>&1 | tee "$LOG"
