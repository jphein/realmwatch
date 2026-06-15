#!/usr/bin/env bash
# check-cli-json — regression guard for issue #101.
#
# Confirms the read subcommands that were silently ignoring --json now emit
# valid machine-readable output. Run against a live map_server on :80.
#
#   ./scripts/check-cli-json.sh            # uses ./scripts/realm
#   REALM=/path/to/realm ./scripts/check-cli-json.sh
#
# Exit 0 = all checks pass; non-zero = a command failed to emit valid JSON.
set -euo pipefail

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
_dir="$(cd "$(dirname "$_self")" && pwd)"
REALM="${REALM:-$_dir/realm}"

fail=0

# Whole-document JSON (object or array) — jq -e . must succeed.
for c in "topology" "tags list" "tags nodes ubuntu"; do
  if $REALM $c --json | jq -e . >/dev/null 2>&1; then
    printf '  ok    realm %s --json\n' "$c"
  else
    printf '  FAIL  realm %s --json (not valid JSON)\n' "$c"
    fail=1
  fi
done

# logs emits NDJSON — every non-empty line must be a JSON object.
if $REALM logs --json -n 5 2>/dev/null \
     | grep . \
     | jq -e 'type=="object"' >/dev/null 2>&1; then
  printf '  ok    realm logs --json (NDJSON)\n'
else
  printf '  FAIL  realm logs --json (not valid NDJSON)\n'
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  printf '\nall --json read commands emit valid JSON\n'
else
  printf '\nsome --json checks failed\n' >&2
fi
exit "$fail"
