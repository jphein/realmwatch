#!/usr/bin/env bash
# realm health — DEPRECATED. Thin shim that forwards to `realm doctor`.
#
# `health` predated the unified CLI contract (lib/realm-cli.sh: --json, shared
# exit codes, dry-run) and `doctor` is the modern, compliant diagnostic. As of
# issue #62 every check `health` performed has been folded into `doctor`
# (daemon liveness + sibling /api/version checks included), so this script just
# prints a one-line deprecation notice and execs doctor with all arguments
# forwarded — `realm health --json`, `--quick`, etc. all still work.
set -euo pipefail

# Dispatcher integration: `scripts/realm` calls every subcommand with
# --one-line-help (1s timeout) to build its command index, and discards
# multi-line output. Handle it here and exit BEFORE exec'ing doctor —
# doctor doesn't implement --one-line-help, so forwarding it would run a full
# diagnostic, get timeout-killed, and drop the index to a legacy fallback.
if [[ "${1:-}" = "--one-line-help" ]]; then
  echo "DEPRECATED alias for 'realm doctor' — runs the full diagnostic"
  exit 0
fi

# One-line deprecation notice to STDERR so it never pollutes `realm health
# --json` stdout (which must stay valid JSON for piping).
echo "realm health is deprecated; forwarding to 'realm doctor'. Use 'realm doctor' directly." >&2

# exec doctor (sibling in the same dir, the way the dispatcher resolves it) so
# its exit code propagates unchanged. All args forwarded.
exec "$(dirname "$0")/realm-doctor.sh" "$@"
