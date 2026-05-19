#!/usr/bin/env bash
# Audit gatekeeper fw4 firewall: zones, forwarding rules, custom rules.
#
# Usage:
#   ./scripts/ap-firewall-check.sh
#
# Description:
#   SSH to gatekeeper (10.0.6.1) and dumps three sections:
#     - fw4 Zones: name, networks, input/output/forward policies
#     - Forwarding rules: src → dest VLAN-to-VLAN permissions
#     - Custom rules: non-default rules with src/dest/proto/port/target
#       (boilerplate DHCP/ping/ICMPv6 rules are filtered out)
#
#   fw4 zone name reminder (gatekeeper naming is counterintuitive):
#     lan=IoT/VLAN10  iot=Guest/VLAN8  admin=Admin/VLAN6  family=Family/VLAN11
#
#   Use alongside firewall_parser.py for live nft ruleset analysis.
#
# Requires: ssh key auth to gatekeeper (root@10.0.6.1)
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

# shellcheck disable=SC1091
source "$(dirname "$0")/lib/realm-python.sh"
GK_IP="$("$REALM_PYTHON" -c "import sys; sys.path.insert(0, '$REALM_HOME'); import realm_fleet; print(realm_fleet.host_ip('gatekeeper') or '')" 2>/dev/null)"
[[ -n "$GK_IP" ]] || { echo -e "${R}Could not resolve 'gatekeeper' from fleet.yaml${N}" >&2; exit 5; }
GK="root@${GK_IP}"  # was hardcoded root@10.0.6.1

echo -e "${C}=== Gatekeeper Firewall Audit ===${N}"

if ! ssh -o ConnectTimeout=3 "$GK" true 2>/dev/null; then
  echo -e "${R}Cannot reach gatekeeper at ${GK_IP}${N}"
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
