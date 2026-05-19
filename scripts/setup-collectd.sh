#!/bin/bash
# Install and configure collectd on an Ubuntu/Debian host to send metrics to katana.
#
# Usage:
#   ssh HOST 'bash -s' < scripts/setup-collectd.sh          # LAN IP for katana
#   ssh HOST 'bash -s -- --ts' < scripts/setup-collectd.sh  # Tailscale IP
#
# Description:
#   Installs collectd if missing, writes /etc/collectd/collectd.conf to send
#   metrics to katana (10.0.6.129) on UDP 25826, then enables and starts the
#   service. With --ts, fetches katana's current Tailscale IP at runtime
#   (for hosts not on the LAN, e.g. remote VMs).
#
#   Hostname is taken from `hostname` on the remote host — ensure it matches
#   the node ID in topology.json for collectd_reader.py to correlate data.
#
# Plugins enabled: cpu, memory, load, disk, df, interface, processes, swap,
#                  uptime, network
#
# This is the canonical version. Root-level setup-collectd.sh is an older copy
# kept for backward compatibility (pipe directly from project root).

set -e

KATANA_LAN="$(python3 -c "import sys, pathlib; sys.path.insert(0, '$(dirname "$0")/..'); import realm_fleet; print(realm_fleet.host_ip('katana') or '')")"
[[ -n "$KATANA_LAN" ]] || { echo "ERROR: could not resolve 'katana' from fleet.yaml" >&2; exit 5; }
KATANA_TS_FALLBACK="100.96.209.70"
HOST=$(hostname)

if [[ "$1" == "--ts" ]]; then
  KATANA_TS=$(ssh -o ConnectTimeout=3 katana "tailscale ip -4" 2>/dev/null || echo "$KATANA_TS_FALLBACK")
  SERVER_IP="$KATANA_TS"
else
  SERVER_IP="$KATANA_LAN"
fi

echo "=== Setting up collectd on $HOST ==="
echo "    Sending to katana at $SERVER_IP"

# Install
if ! dpkg -l collectd 2>/dev/null | grep -q '^ii'; then
  echo "Installing collectd..."
  sudo apt-get update -qq && sudo apt-get install -y -qq collectd
else
  echo "collectd already installed."
fi

# Configure
echo "Writing config..."
sudo tee /etc/collectd/collectd.conf > /dev/null << CONF
Hostname "$HOST"
FQDNLookup false
Interval 30

LoadPlugin cpu
LoadPlugin memory
LoadPlugin load
LoadPlugin disk
LoadPlugin df
LoadPlugin interface
LoadPlugin processes
LoadPlugin swap
LoadPlugin uptime
LoadPlugin network

<Plugin cpu>
  ReportByCpu true
  ReportByState true
  ValuesPercentage true
</Plugin>

<Plugin df>
  MountPoint "/"
  ReportByDevice false
  ReportInodes false
  ValuesPercentage false
</Plugin>

<Plugin interface>
  IgnoreSelected true
  Interface "lo"
</Plugin>

<Plugin network>
  Server "$SERVER_IP" "25826"
</Plugin>
CONF

# Enable and start
sudo systemctl enable collectd
sudo systemctl restart collectd

echo "=== Done! $HOST → katana ($SERVER_IP) ==="
echo "    Check in ~60s: ssh katana 'ls /var/lib/collectd/rrd/$HOST/'"
