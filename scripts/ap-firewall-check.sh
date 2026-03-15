#!/usr/bin/env bash
# Check gatekeeper firewall rules relevant to VLAN zones.
# Shows fw4 zones, forwarding rules, and port-specific rules.
# Usage: ./scripts/ap-firewall-check.sh
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

GK="root@10.0.6.1"

echo -e "${C}=== Gatekeeper Firewall Audit ===${N}"

if ! ssh -o ConnectTimeout=3 "$GK" true 2>/dev/null; then
  echo -e "${R}Cannot reach gatekeeper at 10.0.6.1${N}"
  exit 1
fi

echo -e "\n${Y}fw4 Zones:${N}"
echo -e "  ${Y}(reminder: lan=IoT/VLAN10, iot=Guest/VLAN8, admin=Admin/VLAN6, family=Family/VLAN11)${N}"
ssh "$GK" "
  for z in \$(uci show firewall 2>/dev/null | grep '=zone' | cut -d= -f1 | cut -d. -f2); do
    name=\$(uci -q get firewall.\$z.name)
    nets=\$(uci -q get firewall.\$z.network | tr ' ' ',')
    input=\$(uci -q get firewall.\$z.input)
    output=\$(uci -q get firewall.\$z.output)
    forward=\$(uci -q get firewall.\$z.forward)
    printf '  %-10s networks=%-20s in=%-8s out=%-8s fwd=%s\n' \"\$name\" \"\$nets\" \"\$input\" \"\$output\" \"\$forward\"
  done
"

echo -e "\n${Y}Forwarding rules:${N}"
ssh "$GK" "
  for f in \$(uci show firewall 2>/dev/null | grep '=forwarding' | cut -d= -f1 | cut -d. -f2); do
    src=\$(uci -q get firewall.\$f.src)
    dest=\$(uci -q get firewall.\$f.dest)
    printf '  %-10s → %s\n' \"\$src\" \"\$dest\"
  done
"

echo -e "\n${Y}Custom rules (non-default):${N}"
ssh "$GK" "
  for r in \$(uci show firewall 2>/dev/null | grep '=rule' | cut -d= -f1 | cut -d. -f2); do
    name=\$(uci -q get firewall.\$r.name)
    src=\$(uci -q get firewall.\$r.src)
    dest=\$(uci -q get firewall.\$r.dest)
    proto=\$(uci -q get firewall.\$r.proto)
    dport=\$(uci -q get firewall.\$r.dest_port)
    target=\$(uci -q get firewall.\$r.target)
    # Skip common default rules
    case \"\$name\" in
      Allow-DHCP-Renew|Allow-Ping|Allow-IGMP|Allow-DHCPv6|Allow-MLD|Allow-ICMPv6*) continue ;;
    esac
    printf '  %-35s src=%-10s dest=%-10s proto=%-5s port=%-10s %s\n' \"\$name\" \"\$src\" \"\$dest\" \"\$proto\" \"\$dport\" \"\$target\"
  done
"

echo -e "\n${C}=== Done ===${N}"
