#!/usr/bin/env bash
# Install collectd + lldpd on OpenWrt APs and configure metrics forwarding to katana.
#
# Usage:
#   ./scripts/setup-collectd-openwrt.sh ap-closet   # by AP name
#   ./scripts/setup-collectd-openwrt.sh 10.0.6.102     # by IP
#   ./scripts/setup-collectd-openwrt.sh --all           # all 12 known APs
#
# Description:
#   For each AP:
#   1. Installs collectd packages via opkg:
#      collectd, collectd-mod-{cpu,memory,load,interface,network,uptime,ping,iwinfo,df}
#   2. Writes /etc/collectd.conf (Hostname=<ap_name>, sends to katana:25826, 30s interval)
#   3. Enables and starts collectd
#   4. Installs lldpd and configures it on physical ports (DSA: lan1-4+wan, else eth0/eth1)
#      lldpd enables ap_scanner's ethernet topology auto-detection
#   Skips APs that already have collectd running and pointed at katana (idempotent).
#
# Configuration:
#   KATANA_IP      = 10.0.6.129
#   COLLECTD_PORT  = 25826
#   INTERVAL       = 30 seconds
#
# Requires: ssh key auth to APs (root@<ip>)
# See also: setup-collectd-ap.sh to add the WiFi client exec plugin after this
set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

COLLECTD_PORT="25826"
INTERVAL="30"

# shellcheck source=lib/fleet.sh
_FLEET="$(dirname "$0")/lib/fleet.sh"
if [[ ! -f "$_FLEET" ]]; then
  echo "ERROR: $_FLEET missing — copy lib/fleet.sh.example and edit with your inventory" >&2
  exit 4
fi
# shellcheck disable=SC1090
source "$_FLEET"

# KATANA_IP resolves from fleet.yaml via the same path scripts/lib/fleet.sh uses.
# Was hardcoded "10.0.6.129". Falls back to that legacy value if fleet.yaml lookup fails.
KATANA_IP="$(python3 -c "import sys, pathlib; sys.path.insert(0, '$(dirname "$0")/..'); import realm_fleet; print(realm_fleet.host_ip('katana') or '')" 2>/dev/null)"
if [[ -z "$KATANA_IP" ]]; then
  echo "ERROR: could not resolve 'katana' from fleet.yaml" >&2
  exit 5
fi
source "$_FLEET"
unset _FLEET

setup_ap() {
  local name="$1" ip="$2"
  echo -e "\n${C}═══ $name ($ip) ═══${N}"

  if ! ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no "root@$ip" true 2>/dev/null; then
    echo -e "  ${R}UNREACHABLE${N}"
    return
  fi

  # Check if collectd is already running and properly configured
  RUNNING=$(ssh "root@$ip" "pgrep collectd >/dev/null 2>&1 && echo yes || echo no")
  if [ "$RUNNING" = "yes" ]; then
    SERVER=$(ssh "root@$ip" "grep -oP 'Server \"\\K[^\"]+' /etc/collectd.conf 2>/dev/null || echo 'unknown'")
    echo -e "  ${G}Already running${N} → $SERVER"
    if [ "$SERVER" = "$KATANA_IP" ]; then
      echo -e "  ${G}Correctly configured${N}"
      return
    fi
    echo -e "  ${Y}Wrong server, reconfiguring...${N}"
  fi

  echo -e "  Installing collectd packages..."
  ssh "root@$ip" "
    # Install collectd + network plugin
    opkg update 2>/dev/null
    opkg install collectd collectd-mod-cpu collectd-mod-memory \
      collectd-mod-load collectd-mod-interface collectd-mod-network \
      collectd-mod-uptime collectd-mod-ping collectd-mod-iwinfo \
      collectd-mod-df 2>/dev/null

    # Write config
    cat > /etc/collectd.conf << 'COLLCONF'
Hostname \"$name\"
FQDNLookup false
Interval $INTERVAL

LoadPlugin cpu
LoadPlugin memory
LoadPlugin load
LoadPlugin interface
LoadPlugin network
LoadPlugin uptime
LoadPlugin iwinfo
LoadPlugin df

<Plugin cpu>
  ReportByCpu false
  ReportByState true
  ValuesPercentage true
</Plugin>

<Plugin interface>
  IgnoreSelected true
  Interface \"lo\"
</Plugin>

<Plugin df>
  MountPoint \"/\"
  MountPoint \"/tmp\"
  MountPoint \"/overlay\"
</Plugin>

<Plugin iwinfo>
</Plugin>

<Plugin network>
  Server \"$KATANA_IP\" \"$COLLECTD_PORT\"
</Plugin>
COLLCONF

    # Enable and start
    /etc/init.d/collectd enable 2>/dev/null || true
    /etc/init.d/collectd restart
  " 2>/dev/null

  # Verify collectd
  sleep 2
  VERIFY=$(ssh "root@$ip" "pgrep collectd >/dev/null 2>&1 && echo yes || echo no")
  if [ "$VERIFY" = "yes" ]; then
    echo -e "  ${G}collectd running → $KATANA_IP:$COLLECTD_PORT${N}"
  else
    echo -e "  ${R}collectd failed to start${N}"
  fi

  # --- LLDP for ethernet topology auto-detection ---
  echo -e "  Installing lldpd..."
  ssh "root@$ip" "
    opkg install lldpd 2>/dev/null

    # Detect physical port names for lldpd config
    ports=''
    if ls /sys/class/net/lan1 >/dev/null 2>&1; then
      # DSA: physical ports are lan1-lanN + wan
      for p in lan1 lan2 lan3 lan4 wan; do
        [ -d /sys/class/net/\$p ] && ports=\"\$ports \$p\"
      done
    else
      # Non-DSA: use eth0/eth1
      for p in eth0 eth1; do
        [ -d /sys/class/net/\$p ] && ports=\"\$ports \$p\"
      done
    fi

    # Configure lldpd on physical ports
    uci set lldpd.config.enable_lldp='1'
    uci delete lldpd.config.interface 2>/dev/null
    for p in \$ports; do
      uci add_list lldpd.config.interface=\"\$p\"
    done
    uci commit lldpd
    /etc/init.d/lldpd enable 2>/dev/null || true
    /etc/init.d/lldpd restart
  " 2>/dev/null

  LLDP_OK=$(ssh "root@$ip" "pgrep lldpd >/dev/null 2>&1 && echo yes || echo no")
  if [ "$LLDP_OK" = "yes" ]; then
    echo -e "  ${G}lldpd running (ethernet topology detection)${N}"
  else
    echo -e "  ${Y}lldpd not available${N}"
  fi
}

if [ "${1:-}" = "--all" ]; then
  echo -e "${C}=== Setup collectd on ALL APs ===${N}"
  for name in $(echo "${!APS[@]}" | tr ' ' '\n' | sort); do
    setup_ap "$name" "${APS[$name]}"
  done
elif [ -n "${1:-}" ]; then
  name="$1"
  ip="${APS[$name]:-$name}"
  setup_ap "$name" "$ip"
else
  echo "Usage: $0 <ap_name|ip> | --all"
  echo ""
  echo "Sets up collectd on OpenWrt APs to send metrics to katana ($KATANA_IP)."
  echo "Installs: cpu, memory, load, interface, network, uptime, iwinfo, df plugins."
  echo ""
  echo "Known APs:"
  for name in $(echo "${!APS[@]}" | tr ' ' '\n' | sort); do
    printf "  %-20s %s\n" "$name" "${APS[$name]}"
  done
fi
