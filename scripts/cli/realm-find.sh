#!/usr/bin/env bash
# realm-find — universal fuzzy search across fleet, personas, quests,
# events, and sub-entities. Ranking: exact > prefix > substring, with a
# slight alias penalty. Tie-break by kind (fleet > persona > quest >
# sub-entity > event) so high-signal sources outrank noisy ones. Paired
# with `realm resolve` (name→IP) and `realm show` (drill-down).

set -euo pipefail

REALM_HELP_SUMMARY="Ranked fuzzy search across fleet/persona/quest/event/sub-entity"
realm::help() {
  cat <<'EOF'
realm find — ranked fuzzy search across all realm data

USAGE:
  realm find <query> [--kind K] [--limit N] [--json]

SEARCHES (graceful skip on 404):
  fleet       /fleet/list          current_name, prior_names, fleet_id, vendor, notes
  persona     /personas            key, name, title, voice
  quest       /plugins/quests/list title, node, status, technical_label
  event       /events?limit=200    text/msg, node, type
  sub-entity  /discovery           name, type, id

OPTIONS:
  --kind K     Restrict to one of fleet|persona|quest|event|sub-entity
  --limit N    Cap result count (default 20)
  --json       Emit results as {query, matches: [...]} JSON
  --no-color   Suppress ANSI color (also via NO_COLOR=1)

RANKING: exact=100, prefix=75, substring=50, alias=60 (capped).
Tie-breaker: fleet > persona > quest > sub-entity > event.
Exit codes: 0 matches, 1 none, 2 usage, 3 server unreachable.

EXAMPLES:
  realm find katana
  realm find ollama --kind event
  realm find katana --json | jq '.matches[0]'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

QUERY=""
KIND=""
LIMIT=20
i=1
args=( "$@" )
while (( i <= $# )); do
  arg="${args[$((i-1))]}"
  case "$arg" in
    --kind=*)  KIND="${arg#*=}" ;;
    --kind)    i=$((i+1)); KIND="${args[$((i-1))]:-}" ;;
    --limit=*) LIMIT="${arg#*=}" ;;
    --limit)   i=$((i+1)); LIMIT="${args[$((i-1))]:-20}" ;;
    -*)        ;;
    *)         [[ -z "$QUERY" ]] && QUERY="$arg" ;;
  esac
  i=$((i+1))
done

[[ -n "$QUERY" ]] || realm::die "usage: realm find <query> [--kind K] [--limit N] [--json]" 2
[[ "$LIMIT" =~ ^[1-9][0-9]*$ ]] || realm::die "--limit must be a positive integer" 2

case "$KIND" in
  ""|fleet|persona|quest|event|sub-entity) ;;
  *) realm::die "--kind must be one of: fleet, persona, quest, event, sub-entity" 2 ;;
esac

realm::api_reachable || realm::die_unreachable

# ---- gather (404 / non-JSON → graceful empty default) ----------------------
want() { [[ -z "$KIND" || "$KIND" = "$1" ]]; }
ensure() { jq -e "$2" >/dev/null 2>&1 <<<"$1" && printf '%s' "$1" || printf '%s' "$3"; }

FLEET="[]"; PERSONAS="{}"; QUESTS="[]"; EVENTS="[]"; DISCOVERY='{"sub_entities":{}}'
want fleet      && FLEET=$(ensure     "$(realm::api_get /fleet/list 2>/dev/null | jq '.entries // []' 2>/dev/null || echo '[]')" 'type=="array"' '[]')
want persona    && PERSONAS=$(ensure  "$(realm::api_get /personas 2>/dev/null || echo '{}')"                                     'type=="object"' '{}')
want quest      && QUESTS=$(ensure    "$(realm::api_get '/plugins/quests/list?limit=200' 2>/dev/null || echo '[]')"              'type=="array"' '[]')
want event      && EVENTS=$(ensure    "$(realm::api_get '/events?limit=200' 2>/dev/null || echo '[]')"                           'type=="array"' '[]')
want sub-entity && DISCOVERY=$(ensure "$(realm::api_get /discovery 2>/dev/null || echo '{"sub_entities":{}}')"                   '.sub_entities | type=="object"' '{"sub_entities":{}}')

# ---- score in a single jq program -------------------------------------------
# Streams {kind, score, name, context}, then sorts by (kind, -score) and caps.
# --slurpfile (vs --argjson) keeps each payload off argv so /discovery's
# 200 KiB+ JSON doesn't trip MAX_ARG_STRLEN (128 KiB on Linux).

_tmp=$(mktemp -d); trap 'rm -rf "$_tmp"' EXIT
printf '%s' "$FLEET"     > "$_tmp/fleet.json"
printf '%s' "$PERSONAS"  > "$_tmp/personas.json"
printf '%s' "$QUESTS"    > "$_tmp/quests.json"
printf '%s' "$EVENTS"    > "$_tmp/events.json"
printf '%s' "$DISCOVERY" > "$_tmp/discovery.json"

MATCHES=$(jq -nc \
  --arg q "$QUERY" \
  --slurpfile sf_fleet     "$_tmp/fleet.json" \
  --slurpfile sf_personas  "$_tmp/personas.json" \
  --slurpfile sf_quests    "$_tmp/quests.json" \
  --slurpfile sf_events    "$_tmp/events.json" \
  --slurpfile sf_discovery "$_tmp/discovery.json" \
  '
  # --slurpfile wraps each input in a 1-element array; unwrap here.
  ($sf_fleet[0]) as $fleet | ($sf_personas[0]) as $personas
  | ($sf_quests[0]) as $quests | ($sf_events[0]) as $events
  | ($sf_discovery[0]) as $discovery
  | ($q | ascii_downcase) as $q_lower |
  # Case-insensitive score; 0 means no match.
  def score(s):
    if s == null or s == "" then 0
    else
      (s | tostring | ascii_downcase) as $h
      | if   $h == $q_lower             then 100
        elif ($h | startswith($q_lower)) then 75
        elif ($h | contains($q_lower))   then 50
        else 0 end
    end;

  def best_score($candidates):
    [$candidates[] | score(.)] | max // 0;

  # --- fleet ---
  ( $fleet[]
    | . as $e
    | (best_score([$e.current_name, $e.fleet_id, $e.vendor, $e.notes])) as $direct
    | (best_score([$e.prior_names[]?.name // ""])) as $alias_raw
    | (if $alias_raw > 0 then ([$alias_raw, 60] | min) else 0 end) as $alias
    | ([$direct, $alias] | max) as $s
    | select($s > 0)
    | {
        kind: "fleet",
        score: $s,
        name: ($e.current_name // $e.fleet_id // "?"),
        context: ([
          ($e.ops_ip // empty),
          ($e.category // $e.kind // empty),
          (if $e.status == "curated" then "curated"
           elif $e.status then "(\($e.status))"
           else empty end),
          (if $alias > $direct then "alias→\($e.current_name)" else empty end)
        ] | map(select(. != null and . != "")) | join(" · "))
      }),
  # --- persona ---
  ( $personas
    | to_entries[]
    | .key as $k
    | .value as $v
    | (best_score([$k, $v.name, $v.title, $v.voice])) as $s
    | select($s > 0)
    | {
        kind: "persona",
        score: $s,
        name: $k,
        context: ([$v.title, $v.voice]
          | map(select(. != null and . != ""))
          | join(" · "))
      }),
  # --- quest ---
  ( $quests[]?
    | . as $quest
    | (best_score([$quest.title, $quest.node, $quest.status, $quest.technical_label])) as $s
    | select($s > 0)
    | {
        kind: "quest",
        score: $s,
        name: ($quest.title // $quest.quest_id // "?"),
        context: ([$quest.node, $quest.status]
          | map(select(. != null and . != ""))
          | join(" · "))
      }),
  # --- event (newest-first as returned by /events) ---
  ( $events[]?
    | . as $ev
    | (best_score([$ev.text, $ev.msg, $ev.node, $ev.type])) as $s
    | select($s > 0)
    | {
        kind: "event",
        score: $s,
        name: ($ev.type // "event"),
        context: ([
          (if ($ev.ts | type) == "number"
            then ($ev.ts | strftime("%H:%M:%S")) else empty end),
          ($ev.node // empty),
          ((($ev.text // $ev.msg // "") | tostring)[:80])
        ] | map(select(. != null and . != "")) | join("  "))
      }),
  # --- sub-entity ---
  ( $discovery.sub_entities
    | to_entries[]?
    | .key as $host
    | .value as $entities
    | $entities[]?
    | . as $e
    | (best_score([$e.name, $e.type, $e.id])) as $s
    | select($s > 0)
    | {
        kind: "sub-entity",
        score: $s,
        name: ($e.name // $e.id // "?"),
        context: ([
          ($e.type // empty),
          ($e.status // empty),
          ("on \($host)")
        ] | map(select(. != null and . != "")) | join(" · "))
      }
  )

  ' \
  | jq -sc --argjson lim "$LIMIT" '
      sort_by([(-.score), ({"fleet":1,"persona":2,"quest":3,"sub-entity":4,"event":5}[.kind] // 9)])
      | .[:$lim]
    ')

COUNT=$(echo "$MATCHES" | jq 'length')

# ---- JSON output ------------------------------------------------------------

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -nc --arg q "$QUERY" --argjson m "$MATCHES" '{query:$q, matches:$m}'
  [[ "$COUNT" -eq 0 ]] && exit 1 || exit 0
fi

# ---- pretty output ----------------------------------------------------------

if [[ "$COUNT" -eq 0 ]]; then
  realm::warn "no matches for \"$QUERY\""
  exit 1
fi

realm::print_section "Realm matches for \"$QUERY\""

# Render: KIND  ●●●●  name  · context
# Score buckets: 100→4 dots, 75→3, 60→3, 50→2, else 1.
echo "$MATCHES" | jq -r '
  .[] |
  ( if .score >= 100 then "●●●●"
    elif .score >= 75 then "●●●○"
    elif .score >= 60 then "●●●○"
    elif .score >= 50 then "●●○○"
    else "●○○○" end ) as $dots
  | "\(.kind)\t\($dots)\t\(.name)\t\(.context // "")"
' | column -t -s $'\t'
