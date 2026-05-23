#!/usr/bin/env bash
# Audit all APs: SSID→network mappings, VLAN system, interfaces, collectd status.
#
# Usage:
#   ./scripts/ap-audit.sh               # all 12 APs
#   ./scripts/ap-audit.sh ap-closet  # single AP by name
#   ./scripts/ap-audit.sh 10.0.6.102    # single AP by IP
#
# Description:
#   SSH into each AP and dumps:
#     - Every wifi-iface: SSID, network, mode, 802.11r status, enabled/disabled
#     - VLAN system type: DSA (bridge-vlan) or swconfig (switch_vlan)
#     - Network interfaces: device and protocol
#     - Collectd: running + which server IP it's sending to
#   Useful for verifying SSID→VLAN assignments are consistent across APs
#   and confirming collectd is sending to 10.0.6.129 (katana).
#
# Requires: ssh key auth or manual password (no sshpass here)
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

audit_ap() {
  local name="$1" ip="$2"
  echo -e "\n${C}═══ $name ($ip) ═══${N}"

  if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$ip" true 2>/dev/null; then
    echo -e "  ${R}UNREACHABLE${N}"
    return
  fi

  # Dump SSID→network mapping with band/channel from parent radio
  echo -e "  ${Y}SSIDs:${N}"
  ssh -o ConnectTimeout=5 "root@$ip" "
    for iface in \$(uci show wireless 2>/dev/null | grep '=wifi-iface' | cut -d= -f1 | cut -d. -f2); do
      ssid=\$(uci -q get wireless.\$iface.ssid)
      net=\$(uci -q get wireless.\$iface.network)
      disabled=\$(uci -q get wireless.\$iface.disabled)
      mode=\$(uci -q get wireless.\$iface.mode)
      r11=\$(uci -q get wireless.\$iface.ieee80211r)
      radio=\$(uci -q get wireless.\$iface.device)
      [ -z \"\$ssid\" ] && continue
      band=\$(uci -q get wireless.\$radio.band)
      chan=\$(uci -q get wireless.\$radio.channel)
      rdisabled=\$(uci -q get wireless.\$radio.disabled)
      status='active'
      [ \"\$disabled\" = '1' ] && status='disabled'
      [ \"\$rdisabled\" = '1' ] && status='disabled'
      printf '    %-25s net=%-10s %-4s ch%-4s mode=%-4s 11r=%-3s %s\n' \"\$ssid\" \"\$net\" \"\${band:-?}\" \"\${chan:-?}\" \"\$mode\" \"\${r11:-no}\" \"\$status\"
    done
  " 2>/dev/null || echo -e "  ${R}Failed to read wireless config${N}"

  # Show VLAN config type (DSA vs swconfig)
  echo -e "  ${Y}VLAN system:${N}"
  ssh -o ConnectTimeout=5 "root@$ip" "
    if uci show network 2>/dev/null | grep -q 'bridge-vlan'; then
      echo '    DSA (bridge-vlan)'
      echo '    VLANs:'
      for bv in \$(uci show network 2>/dev/null | grep '=bridge-vlan' | cut -d= -f1 | cut -d. -f2); do
        vid=\$(uci -q get network.\$bv.vlan)
        printf '      VLAN %s\n' \"\$vid\"
      done
    elif uci show network 2>/dev/null | grep -q 'switch_vlan'; then
      echo '    swconfig (switch_vlan)'
      echo '    VLANs:'
      for sv in \$(uci show network 2>/dev/null | grep '=switch_vlan' | cut -d= -f1 | cut -d. -f2); do
        vid=\$(uci -q get network.\$sv.vid)
        desc=\$(uci -q get network.\$sv.description)
        printf '      VLAN %s (%s)\n' \"\$vid\" \"\$desc\"
      done
    else
      echo '    Unknown VLAN system'
    fi
  " 2>/dev/null || echo -e "  ${R}Failed to read VLAN config${N}"

  # Show network interfaces
  echo -e "  ${Y}Network interfaces:${N}"
  ssh -o ConnectTimeout=5 "root@$ip" "
    for iface in \$(uci show network 2>/dev/null | grep '=interface' | cut -d= -f1 | cut -d. -f2); do
      [ \"\$iface\" = 'loopback' ] && continue
      dev=\$(uci -q get network.\$iface.device)
      proto=\$(uci -q get network.\$iface.proto)
      printf '    %-15s device=%-15s proto=%s\n' \"\$iface\" \"\$dev\" \"\$proto\"
    done
  " 2>/dev/null || echo -e "  ${R}Failed to read network config${N}"

  # Check collectd
  echo -e "  ${Y}Collectd:${N}"
  ssh -o ConnectTimeout=5 "root@$ip" "
    if pgrep collectd >/dev/null 2>&1; then
      server=\$(uci -q get collectd.network_server_0.host 2>/dev/null || grep -oP 'Server \"\\K[^\"]+' /etc/collectd.conf 2>/dev/null || echo 'unknown')
      echo \"    Running → \$server\"
    else
      echo '    Not running'
    fi
  " 2>/dev/null || echo -e "  ${R}Failed to check collectd${N}"
}

# Single AP mode or all
if [ "${1:-}" != "" ]; then
  ip="${APS[$1]:-$1}"
  audit_ap "$1" "$ip"
else
  echo -e "${C}=== AP Audit — $(date '+%Y-%m-%d %H:%M') ===${N}"
  for name in $(echo "${!APS[@]}" | tr ' ' '\n' | sort); do
    audit_ap "$name" "${APS[$name]}"
  done
  echo -e "\n${C}=== Done ===${N}"
fi
