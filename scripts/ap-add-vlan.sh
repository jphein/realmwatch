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
