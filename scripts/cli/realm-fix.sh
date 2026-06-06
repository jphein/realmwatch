#!/usr/bin/env bash
# realm-fix — remediation verb. Each target is a small, idempotent operation
# that fixes a known class of issue. Read-only `realm doctor` diagnoses;
# `realm fix <target>` actually does something.
#
# Design: every target is opt-in (`realm fix` with no args lists them).
# Every target prints what it's about to do and confirms unless --yes.
#
# --json: each remediation step records a {target, action, status, detail}
# object; the whole run emits a JSON array at the end (mirrors realm doctor).
# Human output is suppressed in json mode so stdout stays valid JSON. Exit
# code is nonzero if any step failed (status "fail").

set -euo pipefail

REALM_HELP_SUMMARY="Run a remediation target (dnsmasq reload, server restart, plugin reload, etc.)"
realm::help() {
  cat <<'EOF'
realm fix — apply a remediation

USAGE:
  realm fix [target] [--yes]

If no target is given, lists available targets.

TARGETS:
  dnsmasq           Reload dnsmasq on gatekeeper (after uci changes)
  fleet-yaml        Re-validate fleet.yaml + hot-reload (POST /fleet/reload)
  server-restart    Restart realmwatch (systemd if enabled, else just warn)
  plugin <name>     Restart the realm server (no in-process plugin reload exists)
  hot-rebuild       npm run build the frontend bundle (after src/ edits)
  permissions       Fix common file-perm issues (.venv exec bits, scripts/cli/*)
  cleanup           Remove orphaned scratch files, dead worktree refs, __pycache__

OPTIONS:
  --yes, -y         Skip the confirmation prompt
  --dry-run         Show what would happen without doing it
  --json            Emit a JSON array of {target, action, status, detail} steps

EXAMPLES:
  realm fix                              # list available targets
  realm fix dnsmasq                      # interactive prompt → reload
  realm fix dnsmasq --yes                # no prompt
  realm fix fleet-yaml                   # validate + /fleet/reload
  realm fix hot-rebuild                  # npm run build
  realm fix cleanup --dry-run            # preview cleanup
  realm fix cleanup --json --yes | jq .  # machine-readable result
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

YES=0
DRY=0
TARGET=""
TARGET_ARG=""
i=1
args=( "$@" )
while (( i <= $# )); do
  arg="${args[$((i-1))]}"
  case "$arg" in
    --yes|-y)   YES=1 ;;
    --dry-run)  DRY=1 ;;
    -*)         ;;
    *)
      if [[ -z "$TARGET" ]]; then
        TARGET="$arg"
      elif [[ -z "$TARGET_ARG" ]]; then
        TARGET_ARG="$arg"
      fi
      ;;
  esac
  i=$((i+1))
done

# --dry-run can arrive either via the common parser (REALM_DRY_RUN) or as a
# raw positional; honor both so dry-run semantics are consistent with the rest
# of the CLI.
[[ -n "${REALM_DRY_RUN:-}" ]] && DRY=1

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_self")/../.." && pwd)"

JSON=0
[[ "$REALM_OUTPUT" = "json" ]] && JSON=1

# --- structured result accumulation ---------------------------------------
# In --json mode every step appends a {target, action, status, detail} object
# to JSON_LINES; FAIL_COUNT drives the exit code. In human mode record() also
# prints the matching status line so behavior is unchanged for operators.
declare -a JSON_LINES=()
FAIL_COUNT=0
WARN_COUNT=0
OK_COUNT=0

# record STATUS ACTION DETAIL
#   STATUS ∈ ok | fail | warn | skip | dry-run
#   ACTION  short description of the step (e.g. "reload dnsmasq")
#   DETAIL  human-readable result/hint (may be empty)
record() {
  local status="$1" action="$2" detail="${3:-}"
  case "$status" in
    ok|dry-run) OK_COUNT=$((OK_COUNT + 1)) ;;
    warn|skip)  WARN_COUNT=$((WARN_COUNT + 1)) ;;
    fail)       FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
  if [[ "$JSON" -eq 1 ]]; then
    JSON_LINES+=("$(jq -nc \
      --arg t "$TARGET" --arg a "$action" --arg s "$status" --arg d "$detail" \
      '{target:$t, action:$a, status:$s, detail:$d}')")
  else
    case "$status" in
      ok)      realm::status_ok   "${detail:-$action}" ;;
      dry-run) echo "  [dry-run] would: $action" ;;
      warn)    realm::status_warn "${detail:-$action}" ;;
      skip)    realm::status_warn "${detail:-$action}" ;;
      fail)    realm::status_fail "${detail:-$action}" ;;
    esac
  fi
}

# section / line — human-only chrome, suppressed entirely in json mode so the
# stdout stream is pure JSON.
section() { [[ "$JSON" -eq 1 ]] || realm::print_section "$1"; }
line()    { [[ "$JSON" -eq 1 ]] || echo "$1"; }

# emit_result — print the accumulated JSON array (json mode only) and return
# the overall success/failure exit code.
emit_result() {
  if [[ "$JSON" -eq 1 ]]; then
    printf '['
    if [[ ${#JSON_LINES[@]} -gt 0 ]]; then
      IFS=,; printf '%s' "${JSON_LINES[*]}"; unset IFS
    fi
    printf ']\n'
  fi
  [[ "$FAIL_COUNT" -eq 0 ]]
}

# --- target list ---
if [[ -z "$TARGET" ]]; then
  if [[ "$JSON" -eq 1 ]]; then
    # No target → nothing was done; emit an empty result array.
    printf '[]\n'
    exit 0
  fi
  cat <<EOF
Available remediation targets:

  dnsmasq           Reload dnsmasq on gatekeeper (after uci changes)
  fleet-yaml        Re-validate fleet.yaml + hot-reload (POST /fleet/reload)
  server-restart    Restart realmwatch (systemd if enabled, else manual hint)
  hot-rebuild       npm run build the frontend bundle
  permissions       Fix common file-perm issues
  cleanup           Remove orphaned scratch files, dead worktrees, __pycache__

Run with: realm fix <target> [--yes]
EOF
  exit 0
fi

# confirm — prompt unless --yes / --dry-run. In --json mode prompting on stdin
# would corrupt the stream and is meaningless for an agent, so an unconfirmed
# json run is treated as requiring --yes.
confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 || "$DRY" -eq 1 ]]; then return 0; fi
  if [[ "$JSON" -eq 1 ]]; then return 1; fi
  printf '%s [y/N] ' "$prompt"
  read -r reply
  [[ "$reply" =~ ^[Yy] ]]
}

case "$TARGET" in
  dnsmasq)
    section "Reload dnsmasq on gatekeeper"
    if ! confirm "Reload dnsmasq via SSH to gatekeeper?"; then
      record skip "reload dnsmasq" "aborted (needs confirmation or --yes)"
      emit_result; exit $?
    fi
    if [[ "$DRY" -eq 1 ]]; then
      record dry-run "ssh root@gatekeeper '/etc/init.d/dnsmasq reload'"
    else
      if ssh -o ConnectTimeout=5 root@gatekeeper "/etc/init.d/dnsmasq reload"; then
        record ok "reload dnsmasq" "reloaded"
      else
        record fail "reload dnsmasq" "reload failed"
      fi
    fi
    ;;

  fleet-yaml)
    section "Validate + reload fleet.yaml"
    # Validate offline first
    if validate_out=$("$REALM_HOME/.venv/bin/python3" -c "
import sys
sys.path.insert(0, '$REALM_HOME')
from realm_text import real_home
sys.path.insert(0, str(real_home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
from lexicon import load_fleet_catalog
cat = load_fleet_catalog('$REALM_HOME/fleet.yaml')
print(f'validates: {len(cat.entries)} entries')
" 2>&1); then
      line "  $validate_out"
      record ok "validate fleet.yaml" "$validate_out"
    else
      record fail "validate fleet.yaml" "fleet.yaml does NOT validate — fix the file before reloading"
      emit_result; exit $?
    fi
    if [[ "$DRY" -eq 1 ]]; then
      record dry-run "POST /fleet/reload"
    else
      if realm::api_reachable; then
        out=$(realm::api_post /fleet/reload '{}' 2>/dev/null)
        cnt=$(echo "$out" | jq -r '.count // empty')
        if [[ -n "$cnt" ]]; then
          record ok "reload fleet.yaml" "reloaded: $cnt entries"
        else
          record warn "reload fleet.yaml" "endpoint returned: $out"
        fi
      else
        record warn "reload fleet.yaml" "server not running — file is valid but no in-process reload triggered"
      fi
    fi
    ;;

  server-restart)
    section "Restart realmwatch"
    if systemctl --user is-enabled --quiet realm-map-server.service 2>/dev/null; then
      if ! confirm "Restart realm-map-server.service (user unit)?"; then
        record skip "restart server (user unit)" "aborted (needs confirmation or --yes)"
        emit_result; exit $?
      fi
      if [[ "$DRY" -eq 1 ]]; then
        record dry-run "systemctl --user restart realm-map-server.service"
      else
        line "  systemctl --user restart realm-map-server.service"
        systemctl --user restart realm-map-server.service
        sleep 5
        if realm::api_reachable; then
          record ok "restart server (user unit)" "server back up at $(date -u +%H:%M:%S)"
        else
          record fail "restart server (user unit)" "server did not come back; check: journalctl --user -u realm-map-server -n 50"
        fi
      fi
    elif systemctl is-enabled --quiet realm-map-server.service 2>/dev/null; then
      if ! confirm "Restart realm-map-server.service (system unit)?"; then
        record skip "restart server (system unit)" "aborted (needs confirmation or --yes)"
        emit_result; exit $?
      fi
      if [[ "$DRY" -eq 1 ]]; then
        record dry-run "sudo -n systemctl restart realm-map-server.service"
      else
        line "  sudo -n systemctl restart realm-map-server.service"
        sudo -n systemctl restart realm-map-server.service
        sleep 5
        if realm::api_reachable; then
          record ok "restart server (system unit)" "server back up"
        else
          record fail "restart server (system unit)" "didn't come back"
        fi
      fi
    elif pgrep -f "map_server.py" >/dev/null 2>&1; then
      record warn "restart server" "no systemd unit enabled — running as foreground (make dev); to restart: pkill -f map_server.py && (cd $REALM_HOME && make dev > /tmp/rw.log 2>&1 &)"
    else
      record fail "restart server" "no server running and no unit enabled"
    fi
    ;;

  hot-rebuild)
    section "Rebuild realm-map.js"
    if ! confirm "Run 'npm run build' in $REALM_HOME?"; then
      record skip "npm run build" "aborted (needs confirmation or --yes)"
      emit_result; exit $?
    fi
    if [[ "$DRY" -eq 1 ]]; then
      record dry-run "cd $REALM_HOME && npm run build"
    else
      if ( cd "$REALM_HOME" && npm run build ); then
        record ok "npm run build" "rebuilt"
      else
        record fail "npm run build" "build failed"
      fi
    fi
    ;;

  permissions)
    section "Fix common file permissions"
    targets=()
    [[ -f "$REALM_HOME/.venv/bin/python3" && ! -x "$REALM_HOME/.venv/bin/python3" ]] && targets+=("$REALM_HOME/.venv/bin/python3")
    while IFS= read -r f; do
      [[ ! -x "$f" ]] && targets+=("$f")
    done < <(find "$REALM_HOME/scripts" -name 'realm-*.sh' -o -name 'realm' 2>/dev/null)
    if [[ ${#targets[@]} -eq 0 ]]; then
      record ok "fix permissions" "all permissions look fine"
    else
      line "  would chmod +x:"
      [[ "$JSON" -eq 1 ]] || printf '    %s\n' "${targets[@]}"
      if ! confirm "Apply?"; then
        record skip "chmod +x ${#targets[@]} files" "aborted (needs confirmation or --yes)"
        emit_result; exit $?
      fi
      if [[ "$DRY" -eq 1 ]]; then
        record dry-run "chmod +x ${#targets[@]} files"
      elif chmod +x "${targets[@]}"; then
        record ok "fix permissions" "fixed ${#targets[@]} files"
      else
        record fail "fix permissions" "chmod failed on one or more files"
      fi
    fi
    ;;

  cleanup)
    section "Cleanup orphaned files"
    pycache_dirs=$(find "$REALM_HOME" -type d -name __pycache__ -not -path '*/node_modules/*' -not -path '*/.venv/*' 2>/dev/null)
    n_pyc=$(echo "$pycache_dirs" | grep -c . || true)
    pyc_files=$(find "$REALM_HOME" -type f -name '*.pyc' -not -path '*/node_modules/*' -not -path '*/.venv/*' 2>/dev/null)
    n_files=$(echo "$pyc_files" | grep -c . || true)
    pid_files=$(find "$REALM_HOME" -maxdepth 2 -type f -name '*.pid' 2>/dev/null)
    n_pids=$(echo "$pid_files" | grep -c . || true)
    line "  __pycache__ dirs: $n_pyc"
    line "  .pyc files:       $n_files"
    line "  .pid files:       $n_pids"
    if [[ "$n_pyc" -eq 0 && "$n_files" -eq 0 && "$n_pids" -eq 0 ]]; then
      record ok "cleanup" "nothing to clean"
      emit_result; exit $?
    fi
    if ! confirm "Remove these?"; then
      record skip "cleanup" "aborted (needs confirmation or --yes)"
      emit_result; exit $?
    fi
    if [[ "$DRY" -eq 1 ]]; then
      record dry-run "remove $n_pyc __pycache__ dirs, $n_files .pyc files, $n_pids .pid files"
    else
      [[ -n "$pycache_dirs" ]] && echo "$pycache_dirs" | xargs rm -rf
      [[ -n "$pyc_files"    ]] && echo "$pyc_files"    | xargs rm -f
      [[ -n "$pid_files"    ]] && echo "$pid_files"    | xargs rm -f
      record ok "cleanup" "cleaned $n_pyc __pycache__ dirs, $n_files .pyc files, $n_pids .pid files"
    fi
    ;;

  *)
    realm::die "unknown target: $TARGET (run 'realm fix' for the list)" 2
    ;;
esac

emit_result
exit $?
