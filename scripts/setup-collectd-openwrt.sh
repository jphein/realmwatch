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

KATANA_IP="10.0.6.129"
COLLECTD_PORT="25826"
INTERVAL="30"

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
