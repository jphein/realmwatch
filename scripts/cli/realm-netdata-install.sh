#!/usr/bin/env bash
# realm-netdata-install — install the Netdata agent on every Ubuntu host in
# the realm (or a subset).
#
# Mechanism:
#   Runs plugins/ansible/playbooks/install-netdata.yml via the ansible plugin's
#   /plugins/ansible/run endpoint. The playbook is idempotent: hosts that
#   already have netdata running just get a status report.
#
# After install: each host serves Netdata's REST API on :19999. The realmwatch
# netdata plugin discovers them on its next scan and registers a
# `netdata_host` sub-entity with os_name, kernel, charts_count, alarms, etc.
#
# Flags:
#   --hosts a,b,c   Override target list (default: every Ubuntu host in inventory)
#   --no-wait       Submit + return; don't poll for completion
#   --json          Print raw run record
#
# Exit codes: 0 ok, 2 usage, 3 unreachable, 4 no targets, 5 run failed.

set -euo pipefail

REALM_HELP_SUMMARY="Install the Netdata agent on every Ubuntu host (idempotent)"

realm::help() {
  cat <<'EOF'
realm netdata-install — install Netdata agent on Ubuntu hosts

USAGE:
  realm netdata-install [OPTIONS]

OPTIONS:
  --hosts a,b,c   Override the Ubuntu host list (default: every Ubuntu host
                  in the inventory, per `realm discover-os`)
  --no-wait       Fire-and-forget; don't poll
  --json          Raw JSON output
  --host URL      Override realm host

WHAT IT DOES:
  Runs install-netdata.yml against each target. The playbook:
    1. Skips hosts that already serve netdata on :19999 (idempotent)
    2. Installs via the official kickstart.sh installer (--stable-channel)
    3. Enables the systemd service
    4. Waits for :19999 to respond before declaring success

AFTER INSTALL:
  The realmwatch `netdata` plugin auto-discovers agents on its next scan
  (~30s) and registers `netdata_host` sub-entities with OS, kernel, chart
  count, and active alarms. Check with:
    realm discovery list | grep netdata
    realm api GET /discovery | jq '.entities[] | select(.type == "netdata_host")'

EXAMPLES:
  realm netdata-install                  # every Ubuntu host
  realm netdata-install --hosts familiar # one host
  realm netdata-install --no-wait        # background install
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

HOSTS_OVERRIDE=""
NO_WAIT=""
PLAYBOOK="install-netdata.yml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)        HOSTS_OVERRIDE="$2"; shift 2 ;;
    --hosts=*)      HOSTS_OVERRIDE="${1#*=}"; shift ;;
    --no-wait)      NO_WAIT=1; shift ;;
    *)              realm::die "unknown arg: $1" 2 ;;
  esac
done

realm::api_reachable || realm::die_unreachable

# `--dry-run` here gates the playbook submission, NOT the read-only
# inventory fetch we need to resolve targets. Save and clear so reads work.
LOCAL_DRY_RUN="${REALM_DRY_RUN:-}"
REALM_DRY_RUN=""

# ── resolve host list ─────────────────────────────────────────
declare -a HOSTS=()

if [[ -n "$HOSTS_OVERRIDE" ]]; then
  IFS=',' read -ra HOSTS <<< "$HOSTS_OVERRIDE"
else
  # Use the inventory's os field (populated by `realm discover-os`)
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    HOSTS+=("$id")
  done < <(
    realm::api_get /plugins/ansible/inventory \
      | jq -r '.inventory | to_entries[] | .value[] | select(.os == "ubuntu" and .reachable) | .id'
  )
fi

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  printf '%s✘ realm-netdata-install:%s no Ubuntu hosts found.\n' "$R" "$N" >&2
  printf '\n%sFix:%s run %srealm discover-os%s first, or pass --hosts a,b,c.\n' "$W" "$N" "$C" "$N" >&2
  exit 4
fi

realm::say "Installing Netdata on ${#HOSTS[@]} host(s): ${HOSTS[*]}"

# ── build + submit ────────────────────────────────────────────
targets_json=$(printf '%s\n' "${HOSTS[@]}" | jq -R . | jq -s .)
body=$(jq -n \
  --arg playbook "$PLAYBOOK" \
  --argjson targets "$targets_json" \
  '{playbook: $playbook, targets: $targets, check_mode: false}')

if [[ -n "$LOCAL_DRY_RUN" ]]; then
  printf 'DRY-RUN: would POST /plugins/ansible/run\n  body: %s\n' "$body" >&2
  exit 0
fi

run_resp=$(realm::api_post /plugins/ansible/run "$body")
run_id=$(printf '%s' "$run_resp" | jq -r '.run_id // empty')

if [[ -z "$run_id" ]]; then
  realm::warn "no run_id in response"
  printf '%s\n' "$run_resp"
  exit 5
fi

realm::say "Started run $run_id"

if [[ -n "$NO_WAIT" ]]; then
  [[ "$REALM_OUTPUT" = "json" ]] && printf '%s\n' "$run_resp"
  exit 0
fi

# ── poll (longer timeout — kickstart takes ~2-5 min per host) ──
realm::say "Polling for completion (kickstart takes ~3-5 min per host)..."
final_status=""
final_exit=""
deadline=$(( $(date +%s) + 3600 ))  # 1h cap (5 min × 12 forks)

while [[ $(date +%s) -lt $deadline ]]; do
  sleep 5
  runs=$(realm::api_get /plugins/ansible/runs "?limit=20" 2>/dev/null) || continue
  state=$(printf '%s' "$runs" \
    | jq -r --arg id "$run_id" '
        (.runs // .) as $rs
        | ($rs[] | select(.id == $id)) // empty
        | "\(.status // "?")\t\(.exit_code // "")"
      ')
  [[ -z "$state" ]] && continue
  status="${state%%$'\t'*}"
  exit_code="${state##*$'\t'}"
  case "$status" in
    running|queued|"") realm::verbose "still running..."; continue ;;
    *) final_status="$status"; final_exit="$exit_code"; break ;;
  esac
done

if [[ -z "$final_status" ]]; then
  realm::warn "polling timeout — check: realm ansible runs"
  exit 0
fi

if [[ "$REALM_OUTPUT" = "json" ]]; then
  printf '%s' "$runs" | jq --arg id "$run_id" '(.runs // .)[] | select(.id == $id)'
else
  realm::print_section "Result"
  realm::print_kv "run_id"   "$run_id"
  realm::print_kv "status"   "$final_status"
  realm::print_kv "exit"     "$final_exit"
  realm::print_kv "hosts"    "${HOSTS[*]}"
  if [[ "$final_status" = "success" ]]; then
    realm::say ""
    realm::say "Next: realmwatch netdata plugin will discover the new agents on its next scan."
    realm::say "      Check: realm api GET /discovery | jq '.[] | select(.type == \"netdata_host\")'"
  fi
fi

case "$final_status" in
  success|complete|completed) exit 0 ;;
  *) exit 5 ;;
esac
