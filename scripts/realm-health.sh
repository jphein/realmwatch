#!/usr/bin/env bash
# Backwards-compat shim. Logic moved to scripts/cli/realm-health.sh under the
# unified `realm <sub>` dispatcher (closes #47). Kept at the old path so the
# Makefile target (`make health`) and the muscle-memory invocation
# `./scripts/realm-health.sh` keep working.
set -euo pipefail
_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}")"
exec "$(dirname "$_self")/realm" health "$@"
