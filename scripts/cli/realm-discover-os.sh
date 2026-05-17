#!/usr/bin/env bash
# realm-discover-os — SSH-probe every reachable node and write OS info to
# nodes.data.os so the rest of the realm CLI (especially `realm
# ansible-update`) can target by OS without a config file.
#
# Mechanism:
#   ssh -o ConnectTimeout=3 root@<ip> 'cat /etc/os-release'
# (Then jp@<ip> on failure — see SSH_USERS below.)
#
# Parses ID= and VERSION_ID= from os-release and POSTs back to /node, which
# updates the topology row's data JSON in-place.
#
# Flags:
#   --hosts a,b,c        Only probe these host IDs (default: every reachable node)
#   --types t1,t2        Only probe nodes of these types (default: core,infra,device,server,workstation,tower)
#   --user u1,u2         SSH usernames to try, comma-separated (default: root,jp,ubuntu,pi)
#   --forks N            Concurrent probes (default: 20)
#   --dry-run            Show what would be probed; don't ssh or write back
#   --json               Print per-host results as JSON
#
# Exit codes: 0 ok (≥1 host probed), 2 usage, 3 realm unreachable, 4 no targets, 5 zero probes succeeded

set -euo pipefail

REALM_HELP_SUMMARY="Probe reachable nodes via SSH and write OS info back to topology"

realm::help() {
  cat <<'EOF'
realm discover-os — probe every reachable node and store its OS

USAGE:
  realm discover-os [OPTIONS]

OPTIONS:
  --hosts a,b,c        Only probe these host IDs
  --types t1,t2        Only probe nodes of these types
                       (default: core,infra,device,server,workstation,tower)
  --user u1,u2         SSH usernames to try in order
                       (default: root,jp,ubuntu,pi)
  --forks N            Concurrent SSH probes (default: 20)
  --dry-run            Show what would be probed; don't ssh or write
  --json               Per-host results as JSON
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
  realm discover-os --types core,infra           # narrower probe
  realm discover-os --dry-run                    # preview targets
  realm discover-os --json | jq                  # machine output
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

HOSTS_FILTER=""
TYPES_FILTER="core,infra,device,server,workstation,tower"
SSH_USERS_RAW="root,jp,ubuntu,pi"
FORKS=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)    HOSTS_FILTER="$2"; shift 2 ;;
    --hosts=*)  HOSTS_FILTER="${1#*=}"; shift ;;
    --types)    TYPES_FILTER="$2"; shift 2 ;;
    --types=*)  TYPES_FILTER="${1#*=}"; shift ;;
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
tmp_targets=$(mktemp); trap 'rm -f "$tmp_targets"' EXIT

if [[ -n "$HOSTS_FILTER" ]]; then
  # User-supplied: each must have an IP from the topology
  IFS=',' read -ra requested <<< "$HOSTS_FILTER"
  for id in "${requested[@]}"; do
    ip=$(realm::api_get /topology | jq -r --arg id "$id" '.nodes[] | select(.id == $id) | .ip // ""')
    [[ -n "$ip" ]] && printf '%s\t%s\n' "$id" "$ip" >> "$tmp_targets" \
      || realm::warn "no IP for host: $id (skipping)"
  done
else
  # Filter topology by --types
  realm::api_get /topology \
    | jq -r --arg types "$TYPES_FILTER" '
        ($types | split(",")) as $tt
        | .nodes[]
        | select((.type // "" | IN($tt[])) and (.ip // "") != "")
        | "\(.id)\t\(.ip)"
      ' > "$tmp_targets"
fi

target_count=$(wc -l < "$tmp_targets")
if [[ "$target_count" -eq 0 ]]; then
  realm::die "no targets to probe (types: $TYPES_FILTER)" 4
fi

realm::say "Probing $target_count host(s) with $FORKS concurrent SSH connections"

if [[ -n "$LOCAL_DRY_RUN" ]]; then
  realm::print_section "Dry-run — targets that would be probed:"
  while IFS=$'\t' read -r id ip; do realm::print_kv "$id" "$ip"; done < "$tmp_targets"
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
declare -a ubuntu_hosts=()
declare -a other_hosts=()
declare -a failed_hosts=()

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq_results=$(mktemp)
  trap 'rm -f "$tmp_targets" "$results" "$jq_results"' EXIT
fi

while IFS=$'\t' read -r status id ip os_id os_ver os_pretty; do
  if [[ "$status" = "OK" ]]; then
    ok_count=$((ok_count+1))
    [[ "$os_id" = "ubuntu" ]] && ubuntu_hosts+=("$id") || other_hosts+=("$id ($os_id)")
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
if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -s . "$jq_results"
  exit 0
fi

realm::print_section "Summary"
realm::print_kv "probed"      "$target_count"
realm::print_kv "successful"  "$ok_count"
realm::print_kv "failed"      "$fail_count"
realm::print_kv "ubuntu"      "${#ubuntu_hosts[@]} (${ubuntu_hosts[*]+${ubuntu_hosts[*]}})"
[[ ${#other_hosts[@]} -gt 0 ]] && realm::print_kv "other_os" "${other_hosts[*]}"

if [[ "$ok_count" -eq 0 ]]; then
  realm::warn "Zero hosts responded — check SSH key setup and --user list"
  exit 5
fi

exit 0
