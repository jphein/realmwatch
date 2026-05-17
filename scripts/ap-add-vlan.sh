#!/usr/bin/env bash
# Add a VLAN interface to a single OpenWrt AP (DSA or swconfig, auto-detected).
#
# Usage:
#   ./scripts/ap-add-vlan.sh --ap ap-closet --vlan 11 --name family
#   ./scripts/ap-add-vlan.sh --ap ap-shed --vlan 11 --name family
#   ./scripts/ap-add-vlan.sh --dry-run --ap ap-north-1 --vlan 11 --name family
#
# Description:
#   Detects whether the AP uses DSA (bridge-vlan) or swconfig (switch_vlan)
#   by checking the UCI network config, then runs the appropriate uci commands
#   to add the VLAN. For DSA: adds a bridge-vlan entry and br-lan.<VID> interface.
#   For swconfig: adds a switch_vlan, a bridge device, and a network interface.
#   Port list is copied from VLAN 6 (admin) as a template.
#   Idempotent: exits cleanly if the interface already exists.
#   --dry-run prints the uci commands without executing them.
#
# Requires: ssh key auth to AP (root@<ip>)
# See also: ap-audit.sh to inspect current VLAN config before making changes
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

# shellcheck source=lib/fleet.sh
_FLEET="$(dirname "$0")/lib/fleet.sh"
if [[ ! -f "$_FLEET" ]]; then
  echo "ERROR: $_FLEET missing — copy lib/fleet.sh.example and edit with your inventory" >&2
  exit 4
fi
source "$_FLEET"
unset _FLEET

# swconfig APs use different ethernet ports.
# Note: ap-pump and ap-path are now DSA, not swconfig (migrated
# during 2026-04-28 iot-SSID rollout). ap-shed and ap-east-2
# remain swconfig.
declare -A SWCONFIG_ETH=(
  [center]="eth1"
  [ap-east-2]="eth1"
  [ap-shed]="eth0"
)

AP=""
VLAN=""
IFNAME=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ap) AP="$2"; shift 2 ;;
    --vlan) VLAN="$2"; shift 2 ;;
    --name) IFNAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$AP" ] || [ -z "$VLAN" ] || [ -z "$IFNAME" ]; then
  echo "Usage: $0 --ap <ap_name> --vlan <VID> --name <interface_name> [--dry-run]"
  echo ""
  echo "Auto-detects DSA vs swconfig and uses correct commands."
  echo ""
  echo "Examples:"
  echo "  $0 --ap ap-closet --vlan 11 --name family"
  echo "  $0 --ap ap-shed --vlan 11 --name family"
  echo "  $0 --dry-run --ap ap-north-1 --vlan 11 --name family"
  exit 1
fi

IP="${APS[$AP]:-$AP}"

echo -e "${C}=== Add VLAN $VLAN ($IFNAME) on $AP ($IP) ===${N}"
$DRY_RUN && echo -e "${Y}DRY RUN — no changes will be made${N}"

# Check connectivity
if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$IP" true 2>/dev/null; then
  echo -e "${R}ERROR: $AP ($IP) unreachable${N}"
  exit 1
fi

# Check if interface already exists
EXISTS=$(ssh "root@$IP" "uci -q get network.$IFNAME.device 2>/dev/null || echo ''")
if [ -n "$EXISTS" ]; then
  echo -e "${G}Interface '$IFNAME' already exists (device=$EXISTS)${N}"
  exit 0
fi

# Detect VLAN system
IS_DSA=$(ssh "root@$IP" "uci show network 2>/dev/null | grep -c 'bridge-vlan' || echo 0")

if [ "$IS_DSA" -gt 0 ]; then
  echo -e "  Detected: ${C}DSA${N} (bridge-vlan)"

  # Get existing bridge-vlan ports pattern (copy from VLAN 6 typically)
  PORTS=$(ssh "root@$IP" "
    for bv in \$(uci show network 2>/dev/null | grep '=bridge-vlan' | cut -d= -f1 | cut -d. -f2); do
      vid=\$(uci -q get network.\$bv.vlan)
      if [ \"\$vid\" = '6' ] || [ \"\$vid\" = '1' ]; then
        uci -q get network.\$bv.ports | tr ' ' '\n' | sed 's/:[ut]/:t/g' | tr '\n' ' '
        break
      fi
    done
  ")
  PORTS="${PORTS:-lan1:t wan:t}"  # fallback

  echo -e "  Ports: $PORTS"

  CMDS="
# DSA: Add bridge-vlan for VLAN $VLAN
uci add network bridge-vlan
uci set network.@bridge-vlan[-1].device='br-lan'
uci set network.@bridge-vlan[-1].vlan='$VLAN'
$(for p in $PORTS; do echo "uci add_list network.@bridge-vlan[-1].ports='$p'"; done)

# DSA: Add network interface
uci set network.$IFNAME=interface
uci set network.$IFNAME.device='br-lan.$VLAN'
uci set network.$IFNAME.proto='none'

uci commit network
service network restart
"
else
  echo -e "  Detected: ${Y}swconfig${N} (switch_vlan)"

  ETH_PORT="${SWCONFIG_ETH[$AP]:-eth0}"
  echo -e "  Ethernet port: $ETH_PORT"

  # Get existing switch_vlan ports pattern
  PORTS=$(ssh "root@$IP" "
    for sv in \$(uci show network 2>/dev/null | grep '=switch_vlan' | cut -d= -f1 | cut -d. -f2); do
      ports=\$(uci -q get network.\$sv.ports)
      if [ -n \"\$ports\" ]; then
        echo \"\$ports\"
        break
      fi
    done
  ")
  PORTS="${PORTS:-0t 6t 1t 2t}"  # fallback

  echo -e "  Switch ports: $PORTS"

  CMDS="
# swconfig: Add switch VLAN
uci add network switch_vlan
uci set network.@switch_vlan[-1].device='switch0'
uci set network.@switch_vlan[-1].vlan='$VLAN'
uci set network.@switch_vlan[-1].vid='$VLAN'
uci set network.@switch_vlan[-1].ports='$PORTS'
uci set network.@switch_vlan[-1].description='$IFNAME'

# swconfig: Add bridge device
uci add network device
uci set network.@device[-1].name='br-$IFNAME'
uci set network.@device[-1].type='bridge'
uci add_list network.@device[-1].ports='$ETH_PORT.$VLAN'

# swconfig: Add network interface
uci set network.$IFNAME=interface
uci set network.$IFNAME.device='br-$IFNAME'
uci set network.$IFNAME.proto='none'

uci commit network
service network restart
"
fi

if $DRY_RUN; then
  echo -e "\n${Y}Commands that would run:${N}"
  echo "$CMDS"
else
  echo -e "\n  Applying..."
  ssh "root@$IP" "$CMDS" 2>/dev/null
  echo -e "  ${G}Done!${N} Verifying..."

  # Verify
  sleep 2
  CHECK=$(ssh -o ConnectTimeout=5 "root@$IP" "uci -q get network.$IFNAME.device 2>/dev/null || echo 'NOT FOUND'")
  echo -e "  Interface '$IFNAME' device = ${G}$CHECK${N}"
fi
