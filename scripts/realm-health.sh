#!/usr/bin/env bash
# Quick health check — processes, ports, database, and environment tokens.
#
# Usage:
#   ./scripts/realm-health.sh
#
# Description:
#   Checks each Realm service with pgrep, verifies :8777 is responding,
#   inspects realm.db size and row counts (if sqlite3 is available), and
#   shows whether required API tokens (NOTION_TOKEN, HA_TOKEN, AZURE_API_KEY)
#   are set in the current environment. Color-coded output: green=OK, red=down.
set -euo pipefail
cd "$(dirname "$0")/.."

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

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
check_port 8777 "map_server" "/status"

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
echo ""
