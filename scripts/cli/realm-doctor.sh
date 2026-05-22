#!/usr/bin/env bash
# realm-doctor — comprehensive diagnostic. Validates every load-bearing piece
# of the realm and reports actionable PASS/WARN/FAIL hints.
#
# Designed to be the FIRST command you run when something feels off. Output is
# scannable in 10 seconds; each line is one check with a one-line hint on fail.
#
# Exit codes:
#   0 = all checks passed (some WARN allowed)
#   1 = one or more FAIL
#   2 = usage error

set -euo pipefail

REALM_HELP_SUMMARY="Diagnose realm health — server, fleet, lexicon, plugins, env, reachability"
realm::help() {
  cat <<'EOF'
realm doctor — comprehensive diagnostic for the realm

USAGE:
  realm doctor [--quick] [--verbose] [--json]

OPTIONS:
  -h, --help    Show this help
  --quick       Skip slow checks (no ping sweep, no SSH probes)
  --verbose     Show detail lines under each check
  --json        Emit a JSON array of check objects (for piping)

WHAT IT CHECKS:
  - realm server reachable (HTTP, /status, /fleet/list, core_hosts populated)
  - .venv healthy (.venv/bin/python3 + all required deps importable)
  - fleet.yaml loadable + validates + lexicon library importable
  - plugins loaded (any failed imports?)
  - DB integrity (realm.db exists + WAL mode)
  - env vars set (HA_TOKEN, AZURE_AI_API_KEY, NOTION_TOKEN)
  - core hosts reachable (gatekeeper, ha, katana, oracle — quick ping)
  - disk pressure on local host + gatekeeper (warn ≥75%, fail ≥90%)
  - open events count

EXAMPLES:
  realm doctor              # full diagnostic
  realm doctor --quick      # skip the network probes
  realm doctor --json | jq '.[] | select(.status=="fail")'
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

QUICK=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --quick)   QUICK=1 ;;
    --verbose) VERBOSE=1 ;;
  esac
done

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_self")/../.." && pwd)"

declare -a JSON_LINES=()
FAIL_COUNT=0
WARN_COUNT=0
PASS_COUNT=0

emit() {
  local status="$1" name="$2" hint="${3:-}"
  case "$status" in
    pass) PASS_COUNT=$((PASS_COUNT + 1)); [[ "$REALM_OUTPUT" != "json" ]] && realm::status_ok "$name" ;;
    warn) WARN_COUNT=$((WARN_COUNT + 1)); [[ "$REALM_OUTPUT" != "json" ]] && realm::status_warn "$name" ;;
    fail) FAIL_COUNT=$((FAIL_COUNT + 1)); [[ "$REALM_OUTPUT" != "json" ]] && realm::status_fail "$name" ;;
  esac
  if [[ "$REALM_OUTPUT" != "json" && -n "$hint" && ( "$VERBOSE" -eq 1 || "$status" != "pass" ) ]]; then
    echo "      $hint"
  fi
  if [[ "$REALM_OUTPUT" = "json" ]]; then
    JSON_LINES+=("$(jq -nc --arg s "$status" --arg n "$name" --arg h "$hint" '{status:$s, name:$n, hint:$h}')")
  fi
}

section() {
  [[ "$REALM_OUTPUT" != "json" ]] && realm::print_section "$1"
}

# 1. realm server
section "Realm server"
if realm::api_reachable; then
  emit pass "HTTP server reachable at ${REALM_HOST:-http://localhost}"
  if ts=$(realm::api_get /status 2>/dev/null) && [[ -n "$ts" ]]; then
    n=$(echo "$ts" | jq -r '.astral.nodes | length // empty' 2>/dev/null)
    if [[ -n "$n" && "$n" != "null" ]]; then
      emit pass "/status payload OK ($n astral nodes tracked)"
    else
      emit warn "/status returned no astral.nodes block" "plugin status providers may have failed"
    fi
  else
    emit fail "/status fetch failed" "server is up but /status returned nothing"
  fi
  if fc=$(realm::api_get /fleet/list 2>/dev/null) && cnt=$(echo "$fc" | jq -r '.count' 2>/dev/null) && [[ "$cnt" =~ ^[0-9]+$ ]]; then
    emit pass "/fleet/list returns $cnt entries"
  else
    emit fail "/fleet/list unreachable" "lexicon plugin may not be loaded — check realm debug for plugin failures"
  fi
  ch=$(echo "${ts:-}" | jq -r '.core_hosts | to_entries | map(select(.value != null)) | length // 0' 2>/dev/null)
  if [[ "$ch" =~ ^[0-9]+$ && "$ch" -gt 0 ]]; then
    emit pass "/status.core_hosts populated ($ch core IPs resolved from fleet.yaml)"
  else
    emit warn "/status.core_hosts empty" "fleet.yaml may not be loadable from server context"
  fi
else
  emit fail "realm server unreachable at ${REALM_HOST:-http://localhost}" "start it: cd $REALM_HOME && make dev"
fi

# 2. .venv health
section "Python environment"
if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
  pyver=$("$REALM_HOME/.venv/bin/python3" --version 2>&1)
  emit pass ".venv/bin/python3 present ($pyver)"
  if "$REALM_HOME/.venv/bin/python3" -c "import httpx, psutil, notion_client, openai, dotenv, ruamel.yaml" 2>/dev/null; then
    emit pass "all required deps importable"
  else
    missing=$("$REALM_HOME/.venv/bin/python3" -c "
import importlib
for m in ('httpx', 'psutil', 'notion_client', 'openai', 'dotenv', 'ruamel.yaml'):
    try: importlib.import_module(m)
    except ImportError: print(m, end=' ')
" 2>/dev/null)
    emit fail "missing deps: $missing" "cd $REALM_HOME && make install"
  fi
else
  emit fail ".venv/bin/python3 missing" "cd $REALM_HOME && make install (uv sync)"
fi

# 3. fleet.yaml + lexicon
section "Fleet catalog"
if [[ -f "$REALM_HOME/fleet.yaml" ]]; then
  size=$(wc -c < "$REALM_HOME/fleet.yaml")
  emit pass "fleet.yaml present (${size} bytes)"
  if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
    if out=$("$REALM_HOME/.venv/bin/python3" -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
from lexicon import load_fleet_catalog
cat = load_fleet_catalog('$REALM_HOME/fleet.yaml')
curated = sum(1 for e in cat.entries if e.status == 'curated')
tentative = sum(1 for e in cat.entries if e.status == 'tentative')
retired = sum(1 for e in cat.entries if e.status == 'retired')
categorized = sum(1 for e in cat.entries if e.category)
print(f'{len(cat.entries)}|{curated}|{tentative}|{retired}|{categorized}')
" 2>/dev/null); then
      IFS='|' read -r total curated tentative retired categorized <<< "$out"
      emit pass "lexicon validates: $total entries ($curated curated, $tentative tentative, $retired retired)"
      if [[ "$categorized" -gt 0 ]]; then
        emit pass "$categorized entries categorized (drive fleet.sh bash arrays)"
      else
        emit warn "no entries have category set" "scripts that source fleet.sh will see empty arrays"
      fi
    else
      emit fail "lexicon failed to load fleet.yaml" "check yaml syntax: yamllint $REALM_HOME/fleet.yaml"
    fi
  fi
else
  emit fail "fleet.yaml missing" "run scripts/migrate-fleet.py --apply"
fi

# 4. plugins (count from /plugins; failures from server log)
section "Plugins"
if realm::api_reachable; then
  if pl=$(realm::api_get /plugins 2>/dev/null); then
    loaded=$(echo "$pl" | jq -r 'if type=="array" then length else (.plugins // [] | length) end' 2>/dev/null)
    if [[ "$loaded" =~ ^[0-9]+$ && "$loaded" -gt 0 ]]; then
      emit pass "$loaded plugins loaded"
    else
      emit warn "no plugins loaded?" "GET /plugins returned empty"
    fi
  else
    emit warn "/plugins endpoint unreachable" "older server build may not have it"
  fi
fi

# 5. DB
section "Database"
if [[ -f "$REALM_HOME/realm.db" ]]; then
  size_mb=$(du -m "$REALM_HOME/realm.db" | cut -f1)
  emit pass "realm.db present (${size_mb} MB)"
  if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
    if out=$("$REALM_HOME/.venv/bin/python3" -c "
import sqlite3
db = sqlite3.connect('$REALM_HOME/realm.db')
mode = db.execute('PRAGMA journal_mode').fetchone()[0]
nc = db.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]
ec = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
print(f'{mode}|{nc}|{ec}')
" 2>/dev/null); then
      IFS='|' read -r mode nodes events <<< "$out"
      if [[ "$mode" = "wal" ]]; then emit pass "WAL mode active"; else emit warn "journal mode = $mode" "should be wal"; fi
      emit pass "$nodes topology nodes, $events events"
    fi
  fi
else
  emit fail "realm.db missing" "first run of map_server.py creates it"
fi

# 6. env
section "Environment"
for var in HA_TOKEN AZURE_AI_API_KEY NOTION_TOKEN; do
  val=""
  if [[ -f "$REALM_HOME/.env" ]] && grep -q "^${var}=" "$REALM_HOME/.env"; then
    val=$(grep "^${var}=" "$REALM_HOME/.env" | head -1 | cut -d= -f2-)
  fi
  [[ -z "$val" ]] && val="${!var:-}"
  if [[ -n "$val" ]]; then
    emit pass "$var set ($(echo -n "$val" | wc -c) chars)"
  else
    emit warn "$var not set" "feature gated on this token will be disabled"
  fi
done

# 7. core host reachability
if [[ "$QUICK" -eq 0 ]]; then
  section "Core host reachability"
  if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
    while IFS='|' read -r name ip; do
      if [[ -z "$ip" || "$ip" = "None" ]]; then
        emit warn "$name has no ops_ip" "set ops_ip on its fleet.yaml entry"
        continue
      fi
      if ping -c 1 -W 1 -q "$ip" >/dev/null 2>&1; then
        emit pass "$name ($ip) pings"
      else
        emit fail "$name ($ip) not pinging" "host may be down or STP-blocked"
      fi
    done < <("$REALM_HOME/.venv/bin/python3" -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
import realm_fleet
for name in ('gatekeeper', 'katana', 'ha', 'oracle'):
    e = realm_fleet.host(name)
    if e: print(f'{name}|{e.ops_ip or \"None\"}')
" 2>/dev/null)
  fi
fi

# 8. disk pressure (skipped under --quick because the gatekeeper probe SSHes)
if [[ "$QUICK" -eq 0 ]]; then
  section "Disk pressure"
  # Each check parses `df -P -k <mount>` and grabs the "Use%" field. We use
  # POSIX-mode df (`-P`) because the default output line-wraps when the
  # device name is long, breaking the `NR==2` parse. -k forces 1KB blocks
  # so the column positions stay predictable across busybox + GNU df.
  _check_disk() {
    local label="$1" pct_raw="$2"
    # Strip trailing % and validate as integer.
    local pct="${pct_raw%\%}"
    if ! [[ "$pct" =~ ^[0-9]+$ ]]; then
      emit warn "$label disk: couldn't parse usage" "got: $pct_raw"
      return
    fi
    if   (( pct >= 90 )); then
      emit fail "$label disk ${pct}%" "free up space (uv/pip/journal/go-build caches usually have the most)"
    elif (( pct >= 75 )); then
      emit warn "$label disk ${pct}%" "still room but headed up — consider cache cleanup"
    else
      emit pass "$label disk ${pct}%"
    fi
  }
  # Local host (where realm doctor runs).
  local_pct=$(df -P -k / 2>/dev/null | awk 'NR==2 {print $5}')
  _check_disk "local /" "${local_pct:-?}"
  # Gatekeeper (firewall — full / there breaks dhcp + logs).
  if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
    gk_ip=$("$REALM_HOME/.venv/bin/python3" -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
import realm_fleet
e = realm_fleet.host('gatekeeper')
print(e.ops_ip if e and e.ops_ip else '')
" 2>/dev/null)
    if [[ -n "$gk_ip" ]]; then
      gk_pct=$(ssh -o ConnectTimeout=4 -o BatchMode=yes "root@$gk_ip" \
                 "df -P -k / 2>/dev/null | awk 'NR==2 {print \$5}'" 2>/dev/null)
      if [[ -n "$gk_pct" ]]; then
        _check_disk "gatekeeper /" "$gk_pct"
      else
        emit warn "gatekeeper disk: SSH unreachable" "skipped — host or key auth not available"
      fi
    fi
  fi
fi

# 9. recent events (the /events endpoint returns a flat array; no status filter)
section "Recent events"
if realm::api_reachable; then
  if ev=$(realm::api_get "/events?limit=50" 2>/dev/null); then
    total=$(echo "$ev" | jq -r 'if type=="array" then length else 0 end' 2>/dev/null)
    if [[ "$total" =~ ^[0-9]+$ && "$total" -gt 0 ]]; then
      # count last-hour
      now=$(date +%s)
      hour_ago=$((now - 3600))
      recent=$(echo "$ev" | jq -r --argjson t "$hour_ago" '[.[] | select(.ts >= $t)] | length' 2>/dev/null)
      emit pass "$total recent events ($recent in last hour)"
    else
      emit pass "no events"
    fi
  fi
fi

# summary
total=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))
if [[ "$REALM_OUTPUT" = "json" ]]; then
  printf '['
  if [[ ${#JSON_LINES[@]} -gt 0 ]]; then
    IFS=,; printf '%s' "${JSON_LINES[*]}"; unset IFS
  fi
  printf ']\n'
else
  echo
  if [[ "$FAIL_COUNT" -gt 0 ]]; then
    realm::status_fail "$FAIL_COUNT fail · $WARN_COUNT warn · $PASS_COUNT pass  ($total checks)"
  elif [[ "$WARN_COUNT" -gt 0 ]]; then
    realm::status_warn "$WARN_COUNT warn · $PASS_COUNT pass  ($total checks)"
  else
    realm::status_ok "$PASS_COUNT pass  ($total checks)"
  fi
fi

[[ "$FAIL_COUNT" -eq 0 ]]
