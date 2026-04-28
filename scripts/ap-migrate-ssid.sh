#!/usr/bin/env bash
# Migrate an SSID to a different OpenWrt network interface across all APs.
#
# Usage:
#   ./scripts/ap-migrate-ssid.sh --ssid "roam" --network family
#   ./scripts/ap-migrate-ssid.sh --ssid "roam" --network family --ap ap-closet
#   ./scripts/ap-migrate-ssid.sh --ssid "goodwe" --network iot --ap ap-shed
#   ./scripts/ap-migrate-ssid.sh --dry-run --ssid "roam" --network family
#
# Description:
#   Finds every wifi-iface with the given SSID on each AP, changes its
#   'network' UCI option to the target network, commits, and runs `wifi reload`.
#   Skips APs where the SSID is not present or already on the correct network.
#   --dry-run shows what would change without making any modifications.
#   Without --ap, runs across all 12 APs (in series, not parallel).
#
# Requires: ssh key auth to APs (root@<ip>)
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

# AP names match /etc/config/system on each AP (verified 2026-04-28).
# TODO: extract this array to scripts/lib/aps.sh and source from all
# AP scripts (currently duplicated in 4 places).
declare -A APS=(
  [ap-east-1]="10.0.6.100"           # linksys mr8300
  [center]="10.0.6.101"        # tplink onhub
  [ap-closet]="10.0.6.102"        # asus onhub
  [ap-woodshed]="10.0.6.105"      # extreme-networks ws-ap3825i
  [ap-shed]="10.0.6.109"          # netgear wndr4300sw
  [ap-pump]="10.0.6.111"     # tplink onhub
  [ap-path]="10.0.6.114"          # linksys wrt1900ac-v1
  [ap-cabin]="10.0.6.116"      # linksys ea6350v3
  [ap-deck]="10.0.6.119"          # tplink eap225-outdoor-v1
  [ap-south-1]="10.0.6.135"          # linksys ea6350v3
  [ap-east-2]="10.0.6.141"  # tplink onhub
  [ap-north-1]="10.0.6.246"       # asus onhub
)

SSID=""
NETWORK=""
TARGET_AP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssid) SSID="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --ap) TARGET_AP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$SSID" ] || [ -z "$NETWORK" ]; then
  echo "Usage: $0 --ssid <SSID> --network <network_name> [--ap <ap_name>] [--dry-run]"
  echo ""
  echo "Examples:"
  echo "  $0 --ssid roam --network family           # all APs"
  echo "  $0 --ssid goodwe --network iot --ap ap-shed"
  echo "  $0 --dry-run --ssid roam --network family  # preview only"
  exit 1
fi

migrate_ap() {
  local name="$1" ip="$2"

  if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$ip" true 2>/dev/null; then
    echo -e "  ${R}SKIP${N} $name ($ip) — unreachable"
    return
  fi

  # Find matching SSID wifi-iface sections
  local matches
  matches=$(ssh -o ConnectTimeout=5 "root@$ip" "
    for iface in \$(uci show wireless 2>/dev/null | grep '=wifi-iface' | cut -d= -f1 | cut -d. -f2); do
      ssid=\$(uci -q get wireless.\$iface.ssid)
      if [ \"\$ssid\" = '$SSID' ]; then
        cur_net=\$(uci -q get wireless.\$iface.network)
        echo \"\$iface|\$cur_net\"
      fi
    done
  " 2>/dev/null)

  if [ -z "$matches" ]; then
    echo -e "  ${Y}SKIP${N} $name — SSID '$SSID' not found"
    return
  fi

  while IFS='|' read -r iface cur_net; do
    if [ "$cur_net" = "$NETWORK" ]; then
      echo -e "  ${G}OK${N}   $name — $iface already on '$NETWORK'"
      continue
    fi

    if $DRY_RUN; then
      echo -e "  ${Y}WOULD${N} $name — $iface: '$cur_net' → '$NETWORK'"
    else
      echo -en "  ${C}FLIP${N} $name — $iface: '$cur_net' → '$NETWORK' ... "
      ssh -o ConnectTimeout=5 "root@$ip" "
        uci set wireless.$iface.network='$NETWORK'
        uci commit wireless
        wifi reload
      " 2>/dev/null
      echo -e "${G}done${N}"
    fi
  done <<< "$matches"
}

echo -e "${C}=== SSID Migration: '$SSID' → network '$NETWORK' ===${N}"
$DRY_RUN && echo -e "${Y}DRY RUN — no changes will be made${N}"
echo ""

if [ -n "$TARGET_AP" ]; then
  ip="${APS[$TARGET_AP]:-$TARGET_AP}"
  migrate_ap "$TARGET_AP" "$ip"
else
  # Parallel: fire all APs at once for minimal roaming gap
  echo -e "${Y}Migrating across all APs...${N}"
  for name in $(echo "${!APS[@]}" | tr ' ' '\n' | sort); do
    migrate_ap "$name" "${APS[$name]}"
  done
fi

echo -e "\n${C}=== Done ===${N}"
