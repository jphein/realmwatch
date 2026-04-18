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
cd "$(dirname "$0")/.."

exec python3 plugins/system-updates/cli.py "$@"
