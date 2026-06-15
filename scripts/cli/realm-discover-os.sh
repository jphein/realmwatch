#!/usr/bin/env bash
# realm-discover-os — SSH-probe every reachable node and write OS info to
# nodes.data.os so the rest of the realm CLI (especially `realm
# ansible-update`) can target by OS without a config file.
#
# Mechanism:
#   ssh -o ConnectTimeout=3 jp@<ip> 'cat /etc/os-release'
# (Then the remaining SSH_USERS on failure — see SSH_USERS below.)
#
# Parses ID= and VERSION_ID= from os-release and POSTs back to /node, which
# updates the topology row's data JSON in-place.
#
# Target selection:
#   Bare `realm discover-os` probes EVERY reachable node with a non-empty IP.
#   The stored topology never persists `.type` (it is computed at render-time
#   in node_roles.py — issue #98), so we no longer gate the default target list
#   on `.type`. `--types` is honored when given and falls back gracefully to
#   "all IP-bearing" if it matches zero nodes (forward-compatible once #98
#   persists `.type`; it also matches the computed `._role` so it is useful
#   today). `--hosts` always wins when supplied.
#
# Flags:
#   --hosts a,b,c        Only probe these host IDs (default: every reachable node)
#   --types t1,t2        Only probe nodes whose .type or ._role is in this list
#                        (default: unset → probe all reachable IP-bearing nodes)
#   --user u1,u2         SSH usernames to try, comma-separated (default: jp,root,ubuntu,pi)
#   --forks N            Concurrent probes (default: 20)
#   --dry-run            Show what would be probed; don't ssh or write back
#   --json               Print results + coverage as JSON
#
# Exit codes: 0 ok (≥1 host probed), 2 usage, 3 realm unreachable,
#             4 no IP-bearing nodes in topology, 5 zero probes succeeded

set -euo pipefail

REALM_HELP_SUMMARY="Probe reachable nodes via SSH and write OS info back to topology"

realm::help() {
  cat <<'EOF'
realm discover-os — probe every reachable node and store its OS

USAGE:
  realm discover-os [OPTIONS]

OPTIONS:
  --hosts a,b,c        Only probe these host IDs
  --types t1,t2        Only probe nodes whose .type or ._role is in this list.
                       Omit to probe every reachable IP-bearing node (the
                       default). Falls back to "all reachable" if a given
                       filter matches zero nodes.
  --user u1,u2         SSH usernames to try in order
                       (default: jp,root,ubuntu,pi — jp is the working
                       account on this fleet, so it is tried first)
  --forks N            Concurrent SSH probes (default: 20)
  --dry-run            Show what would be probed; don't ssh or write
  --json               Results + coverage summary as JSON
  --quiet              Suppress per-host output (show summary only)

WHAT IT WRITES:
  POST /node {"id": "...", "os": "ubuntu", "os_version": "24.04",
              "os_pretty": "Ubuntu 24.04.4 LTS"}

AFTER RUNNING:
  realm ansible inventory --json | jq '...os'    show real OS per host
  realm ansible-update                            auto-targets every ubuntu host

EXAMPLES:
  realm discover-os                              # probe everything reachable
  realm discover-os --hosts familiar,nodered     # just those
  realm discover-os --types server,router        # narrower probe (by role/type)
  realm discover-os --dry-run                    # preview targets + coverage
  realm discover-os --json | jq                  # machine output
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

HOSTS_FILTER=""
TYPES_FILTER=""
TYPES_EXPLICIT=""
# jp first: it's the working account across this fleet, so trying it first
# avoids a wasted ConnectTimeout on the majority of hosts. root stays in the
# list for OpenWrt APs/routers/switches that only have a root login.
#
# TODO (issue #96, future): Tailscale fallback. Some hosts are only reachable
# on the tailnet, not their stored LAN IP. When a LAN probe fails we could
# retry via `ssh <user>@<magicdns-name>` or the node's tailscale IP (the
# `tailscale` role nodes in topology hint at which hosts are tailnet-joined).
# Left as a follow-up so this fix stays scoped to target selection + coverage.
SSH_USERS_RAW="jp,root,ubuntu,pi"
FORKS=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)    HOSTS_FILTER="$2"; shift 2 ;;
    --hosts=*)  HOSTS_FILTER="${1#*=}"; shift ;;
    --types)    TYPES_FILTER="$2"; TYPES_EXPLICIT=1; shift 2 ;;
    --types=*)  TYPES_FILTER="${1#*=}"; TYPES_EXPLICIT=1; shift ;;
    --user)     SSH_USERS_RAW="$2"; shift 2 ;;
    --user=*)   SSH_USERS_RAW="${1#*=}"; shift ;;
    --forks)    FORKS="$2"; shift 2 ;;
    --forks=*)  FORKS="${1#*=}"; shift ;;
    *)          realm::die "unknown arg: $1" 2 ;;
  esac
done

realm::api_reachable || realm::die_unreachable

# `--dry-run` for this script gates SSH probes and writebacks, NOT the
# read-only topology fetch we need to build the target list. Capture the
# global flag for our own use, then clear it so realm::api_get works.
LOCAL_DRY_RUN="${REALM_DRY_RUN:-}"
REALM_DRY_RUN=""

# ─── build target list ───────────────────────────────────────────
# Fetch topology ONCE and reuse it for every selection mode (the old code
# re-fetched /topology per --hosts entry).
tmp_targets=$(mktemp); trap 'rm -f "$tmp_targets"' EXIT
topo_json=$(realm::api_get /topology) || realm::die "failed to fetch /topology" 5

# Total reachable IP-bearing nodes — the denominator for coverage reporting.
total_ip_nodes=$(printf '%s' "$topo_json" \
  | jq '[.nodes[] | select((.ip // "") != "")] | length' 2>/dev/null || echo 0)

SELECTION=""

if [[ -n "$HOSTS_FILTER" ]]; then
  # User-supplied host IDs: each must have an IP in the topology.
  IFS=',' read -ra requested <<< "$HOSTS_FILTER"
  for id in "${requested[@]}"; do
    ip=$(printf '%s' "$topo_json" \
      | jq -r --arg id "$id" '.nodes[] | select(.id == $id) | .ip // ""' | head -1)
    if [[ -n "$ip" ]]; then
      printf '%s\t%s\n' "$id" "$ip" >> "$tmp_targets"
    else
      realm::warn "no IP for host: $id (skipping)"
    fi
  done
  SELECTION="hosts: $HOSTS_FILTER"
elif [[ -n "$TYPES_EXPLICIT" ]]; then
  # Scope by --types. Match the persisted .type (null until #98 lands) OR the
  # computed ._role, so the filter is useful today AND forward-compatible.
  printf '%s' "$topo_json" \
    | jq -r --arg types "$TYPES_FILTER" '
        ($types | ascii_downcase | split(",")) as $tt
        | .nodes[]
        | ((.type  // "") | ascii_downcase) as $t
        | ((._role // "") | ascii_downcase) as $r
        | select(($t | IN($tt[])) or ($r | IN($tt[])))
        | select((.ip // "") != "")
        | "\(.id)\t\(.ip)"
      ' > "$tmp_targets"
  if [[ ! -s "$tmp_targets" ]]; then
    # Graceful fallback: don't dead-end on a filter that matches nothing
    # (e.g. .type is null and no ._role matched). Probe everything reachable.
    realm::warn "--types '$TYPES_FILTER' matched 0 nodes; falling back to all reachable IP-bearing nodes"
    printf '%s' "$topo_json" \
      | jq -r '.nodes[] | select((.ip // "") != "") | "\(.id)\t\(.ip)"' > "$tmp_targets"
    SELECTION="all IP-bearing (--types '$TYPES_FILTER' matched 0)"
  else
    SELECTION="types: $TYPES_FILTER"
  fi
else
  # Default: every reachable node with a non-empty IP.
  printf '%s' "$topo_json" \
    | jq -r '.nodes[] | select((.ip // "") != "") | "\(.id)\t\(.ip)"' > "$tmp_targets"
  SELECTION="all IP-bearing nodes"
fi

target_count=$(wc -l < "$tmp_targets")
if [[ "$target_count" -eq 0 ]]; then
  # With the all-IP fallback this only fires when topology truly has no
  # IP-bearing nodes (or an explicit --hosts list resolved to none).
  realm::die "no targets to probe ($SELECTION; $total_ip_nodes IP-bearing nodes in topology)" 4
fi

realm::say "Probing $target_count of $total_ip_nodes IP-bearing host(s) with $FORKS concurrent SSH connections [$SELECTION]"

if [[ -n "$LOCAL_DRY_RUN" ]]; then
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    jq -n \
      --arg sel "$SELECTION" \
      --argjson probed "$target_count" \
      --argjson total "$total_ip_nodes" \
      --rawfile t "$tmp_targets" \
      '{dry_run: true, selection: $sel, probed: $probed, ip_bearing_total: $total,
        targets: ($t | rtrimstr("\n") | split("\n")
                  | map(select(length > 0) | split("\t") | {id: .[0], ip: .[1]}))}'
  else
    realm::print_section "Dry-run — targets that would be probed:"
    while IFS=$'\t' read -r id ip; do realm::print_kv "$id" "$ip"; done < "$tmp_targets"
    realm::print_section "Coverage"
    realm::print_kv "selection"         "$SELECTION"
    realm::print_kv "would probe"       "$target_count"
    realm::print_kv "ip-bearing total"  "$total_ip_nodes"
  fi
  exit 0
fi

# ─── probe function used by xargs ──────────────────────────────
IFS=',' read -ra SSH_USERS <<< "$SSH_USERS_RAW"
export REALM_API
export SSH_USERS_RAW

probe_one() {
  local id="$1"
  local ip="$2"
  local IFS=','
  local users=($SSH_USERS_RAW)
  local os_release="" user_used=""

  for u in "${users[@]}"; do
    os_release=$(ssh -o ConnectTimeout=3 \
                     -o StrictHostKeyChecking=no \
                     -o BatchMode=yes \
                     -o LogLevel=ERROR \
                     "$u@$ip" 'cat /etc/os-release 2>/dev/null' 2>/dev/null) || os_release=""
    if [[ -n "$os_release" ]]; then
      user_used="$u"
      break
    fi
  done

  if [[ -z "$os_release" ]]; then
    printf 'FAIL\t%s\t%s\t\t\t\n' "$id" "$ip"
    return 0
  fi

  # Parse ID, VERSION_ID, PRETTY_NAME from /etc/os-release
  local os_id os_ver os_pretty
  os_id=$(printf '%s\n' "$os_release"      | awk -F= '/^ID=/      {gsub(/"/,"",$2); print $2}' | head -1)
  os_ver=$(printf '%s\n' "$os_release"     | awk -F= '/^VERSION_ID=/ {gsub(/"/,"",$2); print $2}' | head -1)
  os_pretty=$(printf '%s\n' "$os_release"  | awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2); print $2}' | head -1)

  printf 'OK\t%s\t%s\t%s\t%s\t%s\n' "$id" "$ip" "$os_id" "$os_ver" "$os_pretty"
}
export -f probe_one

# ─── run probes in parallel via xargs ────────────────────────
results=$(mktemp); trap 'rm -f "$tmp_targets" "$results"' EXIT

# Each row "id<TAB>ip" → run probe_one
awk -F'\t' '{print $1 " " $2}' "$tmp_targets" \
  | xargs -P "$FORKS" -I{} bash -c 'probe_one $1' _ {} \
  > "$results" 2>/dev/null || true

# ─── apply results: POST /node for each OK, summarize ───────
ok_count=0
fail_count=0
declare -a failed_hosts=()
declare -A os_counts=()   # os_id → count, for the OS breakdown

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq_results=$(mktemp)
  trap 'rm -f "$tmp_targets" "$results" "$jq_results"' EXIT
fi

while IFS=$'\t' read -r status id ip os_id os_ver os_pretty; do
  if [[ "$status" = "OK" ]]; then
    ok_count=$((ok_count+1))
    os_key="${os_id:-unknown}"
    os_counts["$os_key"]=$(( ${os_counts["$os_key"]:-0} + 1 ))
    # Build heuristic-friendly tag set alongside the typed os field.
    # Tags are additive, lowercase, kebab-case — meant for `realm` filters and
    # plugin heuristics. Fantasy `label` stays untouched for display.
    declare -a node_tags=("$os_id" "linux")
    [[ -n "$os_ver" ]] && node_tags+=("$os_id-$os_ver")
    # Family tags so future filters like "all debian-family hosts" are cheap
    case "$os_id" in
      ubuntu|debian|mint|pop) node_tags+=("debian-family" "apt") ;;
      rhel|centos|rocky|alma|fedora) node_tags+=("redhat-family" "dnf") ;;
      alpine) node_tags+=("alpine-family" "apk") ;;
      openwrt) node_tags+=("openwrt-family" "opkg") ;;
    esac
    tags_json=$(printf '%s\n' "${node_tags[@]}" | jq -R . | jq -s . -c)
    # POST back to topology
    body=$(jq -n \
      --arg id "$id" \
      --arg os "$os_id" \
      --arg ver "$os_ver" \
      --arg pretty "$os_pretty" \
      --argjson tags "$tags_json" \
      '{id:$id, os:$os, os_version:$ver, os_pretty:$pretty, tags:$tags}')
    realm::api_post /node "$body" > /dev/null 2>&1 || realm::warn "POST /node failed for $id"
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s\n' "$body" >> "$jq_results"
    elif [[ -z "${REALM_QUIET:-}" ]]; then
      realm::status_ok "$(printf '%-20s %-15s %s' "$id" "$ip" "$os_pretty")"
    fi
  else
    fail_count=$((fail_count+1))
    failed_hosts+=("$id ($ip)")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '{"id":"%s","ip":"%s","status":"unreachable"}\n' "$id" "$ip" >> "$jq_results"
    elif [[ -z "${REALM_QUIET:-}" ]]; then
      realm::status_fail "$(printf '%-20s %-15s %s' "$id" "$ip" "ssh unreachable")"
    fi
  fi
done < "$results"

# ─── summary ──────────────────────────────────────────────────
# Build the OS breakdown JSON object (dynamic keys → assemble via jq).
os_breakdown_json='{}'
if [[ ${#os_counts[@]} -gt 0 ]]; then
  os_breakdown_json=$(
    for k in "${!os_counts[@]}"; do printf '%s\t%s\n' "$k" "${os_counts[$k]}"; done \
      | jq -Rn '[inputs | split("\t") | {key: .[0], value: (.[1] | tonumber)}] | from_entries')
fi

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -s \
    --arg sel "$SELECTION" \
    --argjson probed "$target_count" \
    --argjson reachable "$ok_count" \
    --argjson unreachable "$fail_count" \
    --argjson total "$total_ip_nodes" \
    --argjson os "$os_breakdown_json" \
    '{selection: $sel, probed: $probed, reachable: $reachable, unreachable: $unreachable,
      ip_bearing_total: $total, os_breakdown: $os, results: .}' \
    "$jq_results"
  exit 0
fi

realm::print_section "Summary"
realm::print_kv "selection"    "$SELECTION"
realm::print_kv "probed"       "$target_count of $total_ip_nodes IP-bearing"
realm::print_kv "reachable"    "$ok_count"
realm::print_kv "unreachable"  "$fail_count"

if [[ ${#os_counts[@]} -gt 0 ]]; then
  realm::print_section "OS breakdown"
  while IFS=$'\t' read -r osname osn; do
    realm::print_kv "$osname" "$osn"
  done < <(for k in "${!os_counts[@]}"; do printf '%s\t%s\n' "$k" "${os_counts[$k]}"; done | sort)
fi

# Unreachable host IDs are listed only under --verbose — 40+ SSH-unreachable
# nodes is normal on this fleet, so the default summary stays the count.
if [[ "$fail_count" -gt 0 && -n "${REALM_VERBOSE:-}" ]]; then
  realm::print_section "Unreachable hosts ($fail_count)"
  for h in "${failed_hosts[@]}"; do realm::print_kv "·" "$h"; done
fi

if [[ "$ok_count" -eq 0 ]]; then
  realm::warn "Zero hosts responded — check SSH key setup and --user list (tried: $SSH_USERS_RAW)"
  exit 5
fi

exit 0
