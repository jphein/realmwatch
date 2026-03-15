#!/usr/bin/env bash
# AP Audit — SSH into all APs and dump SSID→Network→VLAN mappings.
# Usage: ./scripts/ap-audit.sh
#   or:  ./scripts/ap-audit.sh onhub-closet   (single AP)
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

# All known APs: hostname (SSH alias or IP)
declare -A APS=(
  [mr8300-host]="10.0.6.100"
  [onhub-office]="10.0.6.101"
  [onhub-closet]="10.0.6.102"
  [woodshed]="10.0.6.105"
  [wndr4300sw-shed]="10.0.6.109"
  [onhub-pumphouse]="10.0.6.111"
  [wrt1900ac]="10.0.6.114"
  [ea6350-cl]="10.0.6.116"
  [eap225-outdoor]="10.0.6.119"
  [ea6350v3]="10.0.6.135"
  [onhub-family]="10.0.6.141"
  [onhub-bed]="10.0.6.246"
)

audit_ap() {
  local name="$1" ip="$2"
  echo -e "\n${C}═══ $name ($ip) ═══${N}"

  if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$ip" true 2>/dev/null; then
    echo -e "  ${R}UNREACHABLE${N}"
    return
  fi

  # Dump SSID→network mapping
  echo -e "  ${Y}SSIDs:${N}"
  ssh -o ConnectTimeout=5 "root@$ip" "
    for iface in \$(uci show wireless 2>/dev/null | grep '=wifi-iface' | cut -d= -f1 | cut -d. -f2); do
      ssid=\$(uci -q get wireless.\$iface.ssid)
      net=\$(uci -q get wireless.\$iface.network)
      disabled=\$(uci -q get wireless.\$iface.disabled)
      mode=\$(uci -q get wireless.\$iface.mode)
      r11=\$(uci -q get wireless.\$iface.ieee80211r)
      [ -z \"\$ssid\" ] && continue
      status='active'
      [ \"\$disabled\" = '1' ] && status='disabled'
      printf '    %-25s net=%-10s mode=%-4s 11r=%-3s %s\n' \"\$ssid\" \"\$net\" \"\$mode\" \"\${r11:-no}\" \"\$status\"
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
