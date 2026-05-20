#!/usr/bin/env bash
# realm-recall — search the memory palace (palace-daemon → mempalace).
# Sister verb to `realm find` but specifically targets palace memories.

set -euo pipefail

REALM_HELP_SUMMARY="Search the memory palace (semantic recall via palace-daemon)"
realm::help() {
  cat <<'EOF'
realm recall — search the memory palace

USAGE:
  realm recall <query> [--wing W] [--room R] [--limit N] [--hybrid] [--json]

DESCRIPTION:
  Searches palace-daemon (the gateway in front of mempalace, the 273K-drawer
  Postgres+pgvector+AGE memory palace) via the realmwatch palace plugin's
  /palace/search proxy. Returns ranked drawers with title, wing/room, and
  similarity score.

OPTIONS:
  --wing W     Restrict to one wing (project slug — no "wing_" prefix)
  --room R     Restrict to one of: architecture, decisions, problems,
               planning, sessions, references, discoveries
  --limit N    Cap result count (default 10, max 100)
  --hybrid     Use POST /search/hybrid (vector ∪ BM25 ∪ AGE-graph, RRF-fused).
               Heavier but better for keyword-shaped queries.
  --json       Emit raw palace-daemon JSON

EXIT CODES:
  0 matches  1 no matches  2 usage  3 server/realm unreachable
  4 palace-daemon unreachable (realmwatch up, daemon down)

EXAMPLES:
  realm recall "pgvector tuning"
  realm recall "fleet rename" --wing realmwatch --room decisions
  realm recall katana --hybrid --limit 20
  realm recall "the watcher" --json | jq '.results[0]'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

QUERY=""
WING=""
ROOM=""
LIMIT=10
HYBRID=0
i=1
args=( "$@" )
while (( i <= $# )); do
  arg="${args[$((i-1))]}"
  case "$arg" in
    --wing=*)   WING="${arg#*=}" ;;
    --wing)     i=$((i+1)); WING="${args[$((i-1))]:-}" ;;
    --room=*)   ROOM="${arg#*=}" ;;
    --room)     i=$((i+1)); ROOM="${args[$((i-1))]:-}" ;;
    --limit=*)  LIMIT="${arg#*=}" ;;
    --limit)    i=$((i+1)); LIMIT="${args[$((i-1))]:-10}" ;;
    --hybrid)   HYBRID=1 ;;
    -*)         ;;
    *)          [[ -z "$QUERY" ]] && QUERY="$arg" ;;
  esac
  i=$((i+1))
done

[[ -n "$QUERY" ]] || realm::die "usage: realm recall <query> [--wing W] [--room R] [--limit N] [--hybrid] [--json]" 2
[[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || realm::die "--limit must be a positive integer" 2

case "$ROOM" in
  ""|architecture|decisions|problems|planning|sessions|references|discoveries) ;;
  *) realm::die "--room must be one of: architecture, decisions, problems, planning, sessions, references, discoveries" 2 ;;
esac

realm::api_reachable || realm::die_unreachable

# Build the query string: /palace/search?q=<q>&limit=N[&wing=W][&room=R][&hybrid=1]
encode() { printf '%s' "$1" | jq -Rr @uri; }
QS="?q=$(encode "$QUERY")&limit=$LIMIT"
[[ -n "$WING" ]] && QS="${QS}&wing=$(encode "$WING")"
[[ -n "$ROOM" ]] && QS="${QS}&room=$(encode "$ROOM")"
[[ "$HYBRID" -eq 1 ]] && QS="${QS}&hybrid=1"

# Note: realm::api_get exits non-zero on a 502 (palace-daemon down). We
# catch that and surface a clearer error than the generic "client error".
RESPONSE=$(realm::api_get "/palace/search${QS}" 2>/dev/null) || {
  ec=$?
  if [[ "$ec" -eq 5 || "$ec" -eq 22 ]]; then
    realm::die "palace-daemon unreachable (realmwatch is up; the upstream is not)" 4
  fi
  realm::die "search failed (exit $ec)" "$ec"
}

# Surface palace-daemon errors that came back as 200 JSON-with-error.
if echo "$RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
  ERR=$(echo "$RESPONSE" | jq -r '.error')
  realm::die "palace-daemon: $ERR" 4
fi

# --- JSON passthrough ---
if [[ "$REALM_OUTPUT" = "json" ]]; then
  echo "$RESPONSE"
  count=$(echo "$RESPONSE" | jq '(.results // .memories // .items // []) | length')
  [[ "$count" -eq 0 ]] && exit 1 || exit 0
fi

# --- pretty ---
# palace-daemon's response shape varies a bit across versions; coalesce.
RESULTS=$(echo "$RESPONSE" | jq -c '.results // .memories // .items // []')
COUNT=$(echo "$RESULTS" | jq 'length')

if [[ "$COUNT" -eq 0 ]]; then
  realm::warn "no memories matched \"$QUERY\""
  exit 1
fi

realm::print_section "Palace recall for \"$QUERY\" (${COUNT} of ${LIMIT})"

# Render: WING/ROOM  score  title — like find's pattern.
echo "$RESULTS" | jq -r '
  .[] |
  ( (.score // .similarity // 0) | tostring | .[0:5] ) as $score
  | ( (.wing // "?") + "/" + (.room // "?") ) as $loc
  | ( .title // .name // .id // "(untitled)" ) as $title
  | ( .id // .drawer_id // "" ) as $id
  | "\($loc)\t\($score)\t\($title)\t\($id)"
' | column -t -s $'\t'
