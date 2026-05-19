#!/usr/bin/env bash
# realm-fix — remediation verb. Each target is a small, idempotent operation
# that fixes a known class of issue. Read-only `realm doctor` diagnoses;
# `realm fix <target>` actually does something.
#
# Design: every target is opt-in (`realm fix` with no args lists them).
# Every target prints what it's about to do and confirms unless --yes.

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
  --json            Machine-readable result

EXAMPLES:
  realm fix                              # list available targets
  realm fix dnsmasq                      # interactive prompt → reload
  realm fix dnsmasq --yes                # no prompt
  realm fix fleet-yaml                   # validate + /fleet/reload
  realm fix hot-rebuild                  # npm run build
  realm fix cleanup --dry-run            # preview cleanup
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

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_self")/../.." && pwd)"

# --- target list ---
if [[ -z "$TARGET" ]]; then
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

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 || "$DRY" -eq 1 ]]; then return 0; fi
  printf '%s [y/N] ' "$prompt"
  read -r reply
  [[ "$reply" =~ ^[Yy] ]]
}

do_or_say() {
  if [[ "$DRY" -eq 1 ]]; then
    echo "  [dry-run] would: $*"
  else
    echo "  $*"
    "$@"
  fi
}

case "$TARGET" in
  dnsmasq)
    realm::print_section "Reload dnsmasq on gatekeeper"
    confirm "Reload dnsmasq via SSH to gatekeeper?" || realm::die "aborted" 0
    if [[ "$DRY" -eq 1 ]]; then
      echo "  [dry-run] would: ssh root@gatekeeper '/etc/init.d/dnsmasq reload'"
    else
      ssh -o ConnectTimeout=5 root@gatekeeper "/etc/init.d/dnsmasq reload" \
        && realm::status_ok "reloaded" \
        || realm::status_fail "reload failed"
    fi
    ;;

  fleet-yaml)
    realm::print_section "Validate + reload fleet.yaml"
    # Validate offline first
    if "$REALM_HOME/.venv/bin/python3" -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
from lexicon import load_fleet_catalog
cat = load_fleet_catalog('$REALM_HOME/fleet.yaml')
print(f'validates: {len(cat.entries)} entries')
" 2>&1; then
      :
    else
      realm::status_fail "fleet.yaml does NOT validate — fix the file before reloading"
      exit 1
    fi
    if [[ "$DRY" -eq 1 ]]; then
      echo "  [dry-run] would: POST /fleet/reload"
    else
      if realm::api_reachable; then
        out=$(realm::api_post /fleet/reload '{}' 2>/dev/null)
        cnt=$(echo "$out" | jq -r '.count // empty')
        [[ -n "$cnt" ]] && realm::status_ok "reloaded: $cnt entries" || realm::status_warn "endpoint returned: $out"
      else
        realm::status_warn "server not running — file is valid but no in-process reload triggered"
      fi
    fi
    ;;

  server-restart)
    realm::print_section "Restart realmwatch"
    if systemctl --user is-enabled --quiet realm-map-server.service 2>/dev/null; then
      confirm "Restart realm-map-server.service (user unit)?" || realm::die "aborted" 0
      do_or_say systemctl --user restart realm-map-server.service
      do_or_say sleep 5
      if realm::api_reachable; then
        realm::status_ok "server back up at $(date -u +%H:%M:%S)"
      else
        realm::status_fail "server did not come back; check: journalctl --user -u realm-map-server -n 50"
      fi
    elif systemctl is-enabled --quiet realm-map-server.service 2>/dev/null; then
      confirm "Restart realm-map-server.service (system unit)?" || realm::die "aborted" 0
      do_or_say sudo -n systemctl restart realm-map-server.service
      do_or_say sleep 5
      realm::api_reachable && realm::status_ok "server back up" || realm::status_fail "didn't come back"
    elif pgrep -f "map_server.py" >/dev/null 2>&1; then
      realm::status_warn "no systemd unit enabled — running as foreground (make dev)"
      realm::warn "to restart manually: pkill -f map_server.py && (cd $REALM_HOME && make dev > /tmp/rw.log 2>&1 &)"
    else
      realm::status_fail "no server running and no unit enabled"
    fi
    ;;

  hot-rebuild)
    realm::print_section "Rebuild realm-map.js"
    confirm "Run 'npm run build' in $REALM_HOME?" || realm::die "aborted" 0
    if [[ "$DRY" -eq 1 ]]; then
      echo "  [dry-run] would: cd $REALM_HOME && npm run build"
    else
      ( cd "$REALM_HOME" && npm run build ) && realm::status_ok "rebuilt" || realm::status_fail "build failed"
    fi
    ;;

  permissions)
    realm::print_section "Fix common file permissions"
    targets=()
    [[ -f "$REALM_HOME/.venv/bin/python3" && ! -x "$REALM_HOME/.venv/bin/python3" ]] && targets+=("$REALM_HOME/.venv/bin/python3")
    while IFS= read -r f; do
      [[ ! -x "$f" ]] && targets+=("$f")
    done < <(find "$REALM_HOME/scripts" -name 'realm-*.sh' -o -name 'realm' 2>/dev/null)
    if [[ ${#targets[@]} -eq 0 ]]; then
      realm::status_ok "all permissions look fine"
    else
      echo "  would chmod +x:"
      printf '    %s\n' "${targets[@]}"
      confirm "Apply?" || realm::die "aborted" 0
      do_or_say chmod +x "${targets[@]}"
      realm::status_ok "fixed ${#targets[@]} files"
    fi
    ;;

  cleanup)
    realm::print_section "Cleanup orphaned files"
    pycache_dirs=$(find "$REALM_HOME" -type d -name __pycache__ -not -path '*/node_modules/*' -not -path '*/.venv/*' 2>/dev/null)
    n_pyc=$(echo "$pycache_dirs" | grep -c . || true)
    pyc_files=$(find "$REALM_HOME" -type f -name '*.pyc' -not -path '*/node_modules/*' -not -path '*/.venv/*' 2>/dev/null)
    n_files=$(echo "$pyc_files" | grep -c . || true)
    pid_files=$(find "$REALM_HOME" -maxdepth 2 -type f -name '*.pid' 2>/dev/null)
    n_pids=$(echo "$pid_files" | grep -c . || true)
    echo "  __pycache__ dirs: $n_pyc"
    echo "  .pyc files:       $n_files"
    echo "  .pid files:       $n_pids"
    if [[ "$n_pyc" -eq 0 && "$n_files" -eq 0 && "$n_pids" -eq 0 ]]; then
      realm::status_ok "nothing to clean"
      exit 0
    fi
    confirm "Remove these?" || realm::die "aborted" 0
    if [[ "$DRY" -eq 0 ]]; then
      [[ -n "$pycache_dirs" ]] && echo "$pycache_dirs" | xargs rm -rf
      [[ -n "$pyc_files"    ]] && echo "$pyc_files"    | xargs rm -f
      [[ -n "$pid_files"    ]] && echo "$pid_files"    | xargs rm -f
    fi
    realm::status_ok "cleaned"
    ;;

  *)
    realm::die "unknown target: $TARGET (run 'realm fix' for the list)" 2
    ;;
esac
