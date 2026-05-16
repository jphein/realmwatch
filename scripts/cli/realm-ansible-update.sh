#!/usr/bin/env bash
# realm-ansible-update — keep every Ubuntu host on the realm up to date.
#
# Resolves the host list (config file > inventory auto-detect), posts the
# update-ubuntu.yml playbook to the ansible plugin, and polls until the run
# completes.
#
# Host source of truth, in precedence order:
#   1. --hosts a,b,c        (flag, comma-separated host IDs)
#   2. ~/.config/realm/ubuntu-hosts.conf  (one host id per line; # comments OK)
#   3. ansible plugin auto-detect: inventory entries with os=="ubuntu" && reachable
#
# Flags:
#   --check        Pass --check to ansible (dry-run mode)
#   --hosts LIST   Comma-separated host IDs (overrides config + inventory)
#   --playbook P   Playbook to run (default: update-ubuntu.yml)
#   --no-wait      Fire and forget; don't poll for completion
#   --json         Print raw run record (post + final state) instead of pretty output
#
# Exit codes: 0 ok, 2 usage, 3 unreachable, 4 no hosts found, 5 run failed.

set -euo pipefail

REALM_HELP_SUMMARY="Run Ansible update playbook against every Ubuntu host in the realm"
REALM_SUBCOMMANDS=""

realm::help() {
  cat <<'EOF'
realm ansible-update — run update-ubuntu.yml on every Ubuntu host

USAGE:
  realm ansible-update [OPTIONS]

OPTIONS:
  --check                Run with --check (Ansible dry-run mode; no changes)
  --hosts a,b,c          Override target list (comma-separated host IDs)
  --playbook NAME        Playbook to run (default: update-ubuntu.yml)
  --no-wait              Fire and forget; do not poll for completion
  --json                 Print raw JSON
  --host URL             Override realm host

HOST RESOLUTION (in order):
  1. --hosts flag        Explicit override
  2. ~/.config/realm/ubuntu-hosts.conf   One host ID per line, # comments ok
  3. Inventory auto      os=="ubuntu" && reachable (often empty — needs persona OS tagging)

EXAMPLES:
  # Dry-run against the config-listed hosts
  realm ansible-update --check

  # Live run against a specific subset
  realm ansible-update --hosts katana,game,nodered

  # JSON output (for scripts)
  realm ansible-update --check --json | jq

EXIT CODES:
  0  ok
  2  usage error
  3  realm server unreachable
  4  no hosts to update (config empty AND inventory found none)
  5  playbook run failed
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

CHECK_MODE=false
HOSTS_OVERRIDE=""
PLAYBOOK="update-ubuntu.yml"
NO_WAIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)        CHECK_MODE=true; shift ;;
    --hosts)        HOSTS_OVERRIDE="$2"; shift 2 ;;
    --hosts=*)      HOSTS_OVERRIDE="${1#*=}"; shift ;;
    --playbook)     PLAYBOOK="$2"; shift 2 ;;
    --playbook=*)   PLAYBOOK="${1#*=}"; shift ;;
    --no-wait)      NO_WAIT=1; shift ;;
    *)              realm::die "unknown arg: $1" 2 ;;
  esac
done

realm::api_reachable || realm::die_unreachable

# `--dry-run` here gates the playbook submission, NOT the read-only
# inventory fetch we need to resolve targets. Save and clear so reads work.
LOCAL_DRY_RUN="${REALM_DRY_RUN:-}"
REALM_DRY_RUN=""

# ── resolve host list ─────────────────────────────────────────────
declare -a HOSTS=()

if [[ -n "$HOSTS_OVERRIDE" ]]; then
  IFS=',' read -ra HOSTS <<< "$HOSTS_OVERRIDE"
  realm::verbose "Using --hosts override: ${HOSTS[*]}"
else
  conf="$(realm::config_dir)/ubuntu-hosts.conf"
  if [[ -f "$conf" ]]; then
    realm::verbose "Reading host list from $conf"
    while IFS= read -r line; do
      line="${line%%#*}"           # strip inline comments
      line="${line//[[:space:]]/}" # trim all whitespace
      [[ -z "$line" ]] && continue
      HOSTS+=("$line")
    done < "$conf"
  fi
  if [[ ${#HOSTS[@]} -eq 0 ]]; then
    realm::verbose "Config empty — trying inventory auto-detect (os=='ubuntu' && reachable)"
    while IFS= read -r id; do
      [[ -z "$id" ]] && continue
      HOSTS+=("$id")
    done < <(
      realm::api_get /plugins/ansible/inventory 2>/dev/null \
        | jq -r '.inventory | to_entries[] | .value[] | select(.os == "ubuntu" and .reachable) | .id'
    )
  fi
fi

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  printf '%s✘ realm-ansible-update:%s no Ubuntu hosts found.\n' "$R" "$N" >&2
  printf '\n%sFix one of these:%s\n' "$W" "$N" >&2
  printf '  1. Create %s with host IDs, one per line:\n' "$(realm::config_dir)/ubuntu-hosts.conf" >&2
  printf '       katana\n       game\n       nodered\n' >&2
  printf '  2. Pass --hosts katana,game,nodered\n' >&2
  printf '  3. Tag inventory nodes via personas with explicit OS\n' >&2
  exit 4
fi

# ── build the playbook run payload ───────────────────────────────
targets_json=$(printf '%s\n' "${HOSTS[@]}" | jq -R . | jq -s .)
body=$(jq -n \
  --arg playbook "$PLAYBOOK" \
  --argjson targets "$targets_json" \
  --argjson check "$([[ "$CHECK_MODE" = true ]] && echo true || echo false)" \
  '{playbook: $playbook, targets: $targets, check_mode: $check}')

if [[ "$CHECK_MODE" = true ]]; then
  realm::say "Dry-run (--check): $PLAYBOOK against ${#HOSTS[@]} host(s)"
else
  realm::say "LIVE run: $PLAYBOOK against ${#HOSTS[@]} host(s)"
fi
realm::verbose "Targets: ${HOSTS[*]}"
realm::verbose "Body: $body"

# ── kick off the run ─────────────────────────────────────────────
if [[ -n "$LOCAL_DRY_RUN" ]]; then
  printf 'REALM DRY-RUN: would POST /plugins/ansible/run\n  body: %s\n' "$body" >&2
  exit 0
fi

run_resp=$(realm::api_post /plugins/ansible/run "$body")
run_id=$(printf '%s' "$run_resp" | jq -r '.run_id // empty')

if [[ -z "$run_id" ]]; then
  realm::warn "no run_id in response — playbook may not have started"
  printf '%s\n' "$run_resp"
  exit 5
fi

realm::say "Started run $run_id"

if [[ -n "$NO_WAIT" ]]; then
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    printf '%s\n' "$run_resp"
  fi
  exit 0
fi

# ── poll for completion via GET /plugins/ansible/runs ─────────────
realm::say "Polling for completion (Ctrl-C to detach; the run continues server-side)..."
final_status=""
final_exit=""
deadline=$(( $(date +%s) + 1800 ))  # 30 min cap

while [[ $(date +%s) -lt $deadline ]]; do
  sleep 3
  runs=$(realm::api_get /plugins/ansible/runs "?limit=20" 2>/dev/null) || continue
  state=$(printf '%s' "$runs" \
    | jq -r --arg id "$run_id" '
        (.runs // .) as $rs
        | ($rs[] | select(.id == $id)) // empty
        | "\(.status // "?")\t\(.exit_code // "")"
      ')
  if [[ -z "$state" ]]; then
    realm::verbose "run not visible yet..."
    continue
  fi
  status="${state%%$'\t'*}"
  exit_code="${state##*$'\t'}"
  realm::verbose "status=$status exit=$exit_code"
  case "$status" in
    running|queued|"") continue ;;
    *) final_status="$status"; final_exit="$exit_code"; break ;;
  esac
done

if [[ -z "$final_status" ]]; then
  realm::warn "polling timeout — run is still going. Check: realm ansible runs"
  exit 0
fi

if [[ "$REALM_OUTPUT" = "json" ]]; then
  printf '%s' "$runs" | jq --arg id "$run_id" '(.runs // .)[] | select(.id == $id)'
else
  realm::print_section "Result"
  realm::print_kv "run_id"   "$run_id"
  realm::print_kv "status"   "$final_status"
  realm::print_kv "exit"     "$final_exit"
  realm::print_kv "playbook" "$PLAYBOOK"
  realm::print_kv "hosts"    "${HOSTS[*]}"
fi

case "$final_status" in
  success|complete|completed) exit 0 ;;
  *) exit 5 ;;
esac
