#!/usr/bin/env bash
# Backwards-compat shim. Real logic lives in scripts/cli/realm-update.sh,
# resolved through the `realm` dispatcher. Kept here so cron jobs, systemd
# units, and muscle memory (`./scripts/realm-update.sh ...`) keep working.
#
# XDG normalization stays in the shim so the dispatcher (and every child it
# spawns) inherits sane values even when Wave terminal injects empty XDG
# vars. See scripts/cli/realm-update.sh for the full rationale.
set -euo pipefail

[ -z "${XDG_CACHE_HOME:-}" ]  && export XDG_CACHE_HOME="$HOME/.cache"
[ -z "${XDG_CONFIG_HOME:-}" ] && export XDG_CONFIG_HOME="$HOME/.config"
[ -z "${XDG_DATA_HOME:-}" ]   && export XDG_DATA_HOME="$HOME/.local/share"

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}")"
exec "$(dirname "$_self")/realm" update "$@"
