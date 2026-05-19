#!/usr/bin/env bash
# realm-show — single-command host investigation. The "tell me everything about
# this thing" verb. Aggregates fleet entry, topology, persona, recent events,
# sub-entities, and reachability into one scannable screen.

set -euo pipefail

REALM_HELP_SUMMARY="One-command host investigation — fleet+topology+persona+events+ping"
realm::help() {
  cat <<'EOF'
realm show — tell me everything about this host

USAGE:
  realm show <name> [--no-ping] [--events N] [--json]

ARGS:
  name              Anything the fleet resolver knows: current_name,
                    prior_names, fleet_id.

OPTIONS:
  --no-ping         Skip reachability check (saves ~1s)
  --events N        Show last N events for this node (default: 5)
  --json            Emit aggregated record as JSON

EXAMPLES:
  realm show katana
  realm show gst308t-office          # via prior_names → east-tree-trunk
  realm show east-switch --json | jq .topology.mac
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

NAME=""
NO_PING=0
EVENTS_N=5
i=1
args=( "$@" )
while (( i <= $# )); do
  arg="${args[$((i-1))]}"
  case "$arg" in
    --no-ping)  NO_PING=1 ;;
    --events)   i=$((i+1)); EVENTS_N="${args[$((i-1))]:-5}" ;;
    -*)         ;;
    *)          [[ -z "$NAME" ]] && NAME="$arg" ;;
  esac
  i=$((i+1))
done

[[ -n "$NAME" ]] || realm::die "usage: realm show <name>" 2
realm::api_reachable || realm::die_unreachable

# 1. Resolve via fleet
FLEET=$(realm::api_get "/fleet/resolve/$(printf '%s' "$NAME" | jq -Rr @uri)" 2>/dev/null || echo '{"error":"not found"}')
FLEET_ENTRY=$(echo "$FLEET" | jq '.entry // null')
CURRENT_NAME=$(echo "$FLEET_ENTRY" | jq -r '.current_name // empty')
FLEET_ID=$(echo "$FLEET_ENTRY" | jq -r '.fleet_id // empty')
CANONICAL="${CURRENT_NAME:-$NAME}"

# 2. Topology data
TOPO_NODE=$(realm::api_get /topology 2>/dev/null \
  | jq --arg n "$CANONICAL" --arg fid "$FLEET_ID" \
       '.nodes[]? | select(.id == $n or .fleet_id == $fid or ($fid != "" and (.data // {}).fleet_id == $fid))' \
  | jq -s '.[0] // null')

# 3. Persona
PERSONAS=$(realm::api_get /personas 2>/dev/null || echo "{}")
PERSONA=$(echo "$PERSONAS" | jq --arg fid "$FLEET_ID" --arg n "$CANONICAL" \
  '.[$fid] // .[$n] // null')

# 4. Recent events
EVENTS=$(realm::api_get "/events?limit=200" 2>/dev/null || echo "[]")
NODE_EVENTS=$(echo "$EVENTS" | jq --arg n "$CANONICAL" --argjson lim "$EVENTS_N" \
  '[.[]? | select(.node == $n)] | .[:$lim]')

# 5. Sub-entities
SUB=$(realm::api_get "/discovery/sub-entities?host=$(printf '%s' "$CANONICAL" | jq -Rr @uri)" 2>/dev/null || echo '{"host_entities":[],"linked_entities":[]}')

# 6. Online
STATUS=$(realm::api_get /status 2>/dev/null || echo "{}")
ONLINE=$(echo "$STATUS" | jq --arg n "$CANONICAL" '.astral.nodes[$n] // null')

# 7. Ping
PING_RESULT=""
IP=$(echo "$FLEET_ENTRY" | jq -r '.ops_ip // empty')
[[ -z "$IP" ]] && IP=$(echo "$TOPO_NODE" | jq -r '.ip // empty')
if [[ "$NO_PING" -eq 0 && -n "$IP" ]]; then
  if ping_out=$(ping -c 1 -W 1 -q "$IP" 2>&1); then
    rtt=$(echo "$ping_out" | grep -oE 'min/avg/max[^ ]+ = [0-9.]+' | grep -oE '[0-9.]+$' || echo "?")
    PING_RESULT="ok ${rtt}ms"
  else
    PING_RESULT="UNREACHABLE"
  fi
fi

# --- JSON output ---
if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -nc \
    --arg name "$NAME" \
    --argjson fleet "$FLEET_ENTRY" \
    --argjson topology "${TOPO_NODE:-null}" \
    --argjson persona "${PERSONA:-null}" \
    --argjson events "$NODE_EVENTS" \
    --argjson sub "$SUB" \
    --argjson online "${ONLINE:-null}" \
    --arg ip "$IP" \
    --arg ping "$PING_RESULT" \
    '{
      query: $name,
      canonical_name: ($fleet.current_name // null),
      fleet: $fleet,
      topology: $topology,
      persona: $persona,
      online: $online,
      ip: $ip,
      ping: $ping,
      events: $events,
      sub_entities: $sub
    }'
  exit 0
fi

# --- pretty ---
realm::print_section "Identity"
if [[ -z "$FLEET_ID" && "$(echo "$TOPO_NODE" | jq -r 'if . == null then "" else .id end')" = "" ]]; then
  realm::warn "no fleet entry and no topology node match for '$NAME'"
  exit 4
fi
realm::print_kv "Query" "$NAME"
[[ -n "$CURRENT_NAME" ]] && realm::print_kv "Canonical name" "$CURRENT_NAME"
[[ -n "$FLEET_ID" ]] && realm::print_kv "Fleet ID" "$FLEET_ID"
priors=$(echo "$FLEET_ENTRY" | jq -r '[.prior_names[]?.name] | join(", ")')
[[ -n "$priors" && "$priors" != "null" ]] && realm::print_kv "Prior names" "$priors"
cat_=$(echo "$FLEET_ENTRY" | jq -r '.category // empty'); [[ -n "$cat_" ]] && realm::print_kv "Category" "$cat_"
realm_=$(echo "$FLEET_ENTRY" | jq -r '.realm // empty'); [[ -n "$realm_" ]] && realm::print_kv "Realm" "$realm_"
vendor=$(echo "$FLEET_ENTRY" | jq -r '.vendor // empty'); [[ -n "$vendor" ]] && realm::print_kv "Vendor" "$vendor"
notes=$(echo "$FLEET_ENTRY" | jq -r '.notes // empty'); [[ -n "$notes" ]] && realm::print_kv "Notes" "$notes"

realm::print_section "Network"
ops_ip=$(echo "$FLEET_ENTRY" | jq -r '.ops_ip // empty')
topo_ip=$(echo "$TOPO_NODE" | jq -r '.ip // empty')
topo_mac=$(echo "$TOPO_NODE" | jq -r '.mac // empty')
[[ -n "$ops_ip" ]] && realm::print_kv "ops_ip (fleet)" "$ops_ip"
[[ -n "$topo_ip" && "$topo_ip" != "$ops_ip" ]] && realm::print_kv "live IP" "$topo_ip"
[[ -n "$topo_mac" ]] && realm::print_kv "MAC" "$topo_mac"
topo_type=$(echo "$TOPO_NODE" | jq -r '.type // .kind // empty'); [[ -n "$topo_type" ]] && realm::print_kv "Type" "$topo_type"
topo_role=$(echo "$TOPO_NODE" | jq -r '._role // .role // empty'); [[ -n "$topo_role" ]] && realm::print_kv "Role" "$topo_role"

realm::print_section "Status"
if [[ "$ONLINE" = "true" ]]; then realm::status_ok "online (astral.nodes)"
elif [[ "$ONLINE" = "false" ]]; then realm::status_fail "OFFLINE (astral.nodes)"
else realm::status_warn "no astral.nodes entry"; fi
if [[ -n "$PING_RESULT" ]]; then
  case "$PING_RESULT" in
    ok*) realm::status_ok  "ping $IP — $PING_RESULT" ;;
    UN*) realm::status_fail "ping $IP — $PING_RESULT" ;;
  esac
fi

if [[ "$PERSONA" != "null" && -n "$PERSONA" ]]; then
  realm::print_section "Persona"
  pname=$(echo "$PERSONA"  | jq -r '.name // empty')
  ptitle=$(echo "$PERSONA" | jq -r '.title // empty')
  pvoice=$(echo "$PERSONA" | jq -r '.voice // empty')
  psys=$(echo "$PERSONA"   | jq -r '.system_prompt // empty')
  [[ -n "$pname"  ]] && realm::print_kv "Name" "$pname"
  [[ -n "$ptitle" ]] && realm::print_kv "Title" "$ptitle"
  [[ -n "$pvoice" ]] && realm::print_kv "Voice" "$pvoice"
  [[ -n "$psys"   ]] && realm::print_kv "Prompt" "$(echo "$psys" | head -c 120)…"
fi

host_n=$(echo "$SUB" | jq -r '.host_entities | length // 0')
link_n=$(echo "$SUB" | jq -r '.linked_entities | length // 0')
if [[ "$host_n" -gt 0 || "$link_n" -gt 0 ]]; then
  realm::print_section "Sub-entities ($host_n hosted, $link_n linked)"
  echo "$SUB" | jq -r '.host_entities[]? | "  - \(.kind // "?")  \(.name // .id // .key)"' | head -10
fi

ev_n=$(echo "$NODE_EVENTS" | jq 'length')
if [[ "$ev_n" -gt 0 ]]; then
  realm::print_section "Recent events ($ev_n shown)"
  echo "$NODE_EVENTS" | jq -r '.[] | "  \(.ts | strftime("%m-%d %H:%M:%S"))  [\(.type // "event")]  \(.text // .msg // .)"'
else
  realm::print_section "Recent events"
  echo "  (none touching this node in last 200 events)"
fi
