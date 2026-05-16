#!/usr/bin/env bash
# Quick health check — processes, ports, database, environment tokens, and
# sibling realm.watch services.
#
# Usage:
#   ./scripts/realm-health.sh
#   ./scripts/realm-health.sh --no-siblings   # skip sibling-service checks
#   ./scripts/realm-health.sh --one-line-help # for realm dispatcher index
#
# Description:
#   Checks each Realm service with pgrep, verifies :80 is responding,
#   inspects realm.db size and row counts (if sqlite3 is available), shows
#   whether required API tokens (NOTION_TOKEN, HA_TOKEN, AZURE_API_KEY) are
#   set in the current environment, and pings sibling realm.watch services
#   (status, oracle, coin, portal, deploy) via their /api/version endpoint.
#   Sibling URL overrides come from ~/.config/realm/siblings.conf
#   (lines of NAME=URL).
set -euo pipefail

# Dispatcher integration: print a one-line summary then exit.
if [[ "${1:-}" = "--one-line-help" ]]; then
  echo "Check realm services, ports, DB, env, and sibling realm.watch hosts"
  exit 0
fi

SKIP_SIBLINGS=""
if [[ "${1:-}" = "--no-siblings" ]]; then
  SKIP_SIBLINGS=1
  shift
fi

cd "$(dirname "$0")/.."

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

# Honor NO_COLOR + non-tty per clig.dev
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]]; then
  G=''; R=''; Y=''; C=''; N=''
fi

check_proc() {
  if pgrep -f "$1" >/dev/null 2>&1; then
    printf "  ${G}UP${N}  %s\n" "$2"
  else
    printf "  ${R}DOWN${N}  %s\n" "$2"
  fi
}

check_port() {
  if curl -sf --max-time 2 "http://localhost:$1$3" >/dev/null 2>&1; then
    printf "  ${G}OK${N}  :%s %s\n" "$1" "$2"
  else
    printf "  ${R}--${N}  :%s %s\n" "$1" "$2"
  fi
}

echo -e "${C}=== Realm Health ===${N}"
echo ""
echo -e "${Y}Processes:${N}"
check_proc "map_server.py" "map_server.py (HTTP frontend)"
check_proc "oracle_daemon" "oracle_daemon.py (AI oracle)"
check_proc "realm_herald" "realm_herald.py (voice daemon)"
check_proc "ap_scanner" "ap_scanner.py (WiFi scanner)"
check_proc "collectd_listener" "collectd_listener.py (metrics)"

echo ""
echo -e "${Y}Ports:${N}"
check_port 80 "map_server" "/status"

echo ""
echo -e "${Y}Database:${N}"
if [ -f realm.db ]; then
  SIZE=$(du -h realm.db | cut -f1)
  if command -v sqlite3 >/dev/null 2>&1; then
    EVENTS=$(sqlite3 realm.db "SELECT COUNT(*) FROM events" 2>/dev/null || echo "?")
    NODES=$(sqlite3 realm.db "SELECT COUNT(*) FROM nodes" 2>/dev/null || echo "?")
    printf "  ${G}OK${N}  realm.db (%s, %s events, %s nodes)\n" "$SIZE" "$EVENTS" "$NODES"
  else
    printf "  ${G}OK${N}  realm.db (%s, sqlite3 CLI not installed)\n" "$SIZE"
  fi
else
  printf "  ${R}MISSING${N}  realm.db\n"
fi

echo ""
echo -e "${Y}Environment:${N}"
[ -n "${NOTION_TOKEN:-}" ] && printf "  ${G}SET${N}  NOTION_TOKEN\n" || printf "  ${R}--${N}  NOTION_TOKEN\n"
[ -n "${HA_TOKEN:-}" ] && printf "  ${G}SET${N}  HA_TOKEN\n" || printf "  ${R}--${N}  HA_TOKEN\n"
[ -n "${AZURE_API_KEY:-}" ] && printf "  ${G}SET${N}  AZURE_API_KEY\n" || printf "  ${R}--${N}  AZURE_API_KEY\n"

# Sibling realm.watch services — query /api/version on each. URLs default to
# the canonical public hostnames; override per-host in ~/.config/realm/siblings.conf
# (one NAME=URL per line).
if [[ -z "$SKIP_SIBLINGS" ]]; then
  echo ""
  echo -e "${Y}Siblings:${N}"
  declare -A SIBLINGS=(
    [status]="https://status.realm.watch"
    [coin]="https://coin.realm.watch"
    [oracle]="https://oracle.realm.watch"
    [portal]="https://portal.realm.watch"
    [deploy]="https://deploy.realm.watch"
  )
  sib_conf="${XDG_CONFIG_HOME:-$HOME/.config}/realm/siblings.conf"
  if [[ -f "$sib_conf" ]]; then
    while IFS='=' read -r k v; do
      [[ -z "$k" || "$k" = \#* ]] && continue
      SIBLINGS["$k"]="$v"
    done < "$sib_conf"
  fi
  # Iterate in sorted name order. `set -e` is in effect so every step that
  # might fail (curl, jq) is explicitly tolerated with `|| true`.
  for name in $(echo "${!SIBLINGS[@]}" | tr ' ' '\n' | sort); do
    url="${SIBLINGS[$name]}"
    resp=$(curl -sf --max-time 2 "$url/api/version" 2>/dev/null || true)
    if [[ -z "$resp" ]]; then
      printf "  ${R}--${N}  %-10s %s (unreachable)\n" "$name" "$url"
      continue
    fi
    # Verify it's actually JSON; if not, the service is up but doesn't speak
    # the /api/version contract (e.g., a static frontend like bestiary).
    if ! command -v jq >/dev/null 2>&1; then
      printf "  ${G}OK${N}  %-10s %s\n" "$name" "$url"
      continue
    fi
    if ! echo "$resp" | jq -e . >/dev/null 2>&1; then
      printf "  ${Y}??${N}  %-10s %s (responds, but no JSON /api/version)\n" "$name" "$url"
      continue
    fi
    v=$(echo "$resp" | jq -r '.name // .version // "?"' 2>/dev/null || echo "?")
    h=$(echo "$resp" | jq -r '.hash // .commit // "?"' 2>/dev/null || echo "?")
    printf "  ${G}OK${N}  %-10s %s (%s)\n" "$name" "$v" "$h"
  done
fi
echo ""
