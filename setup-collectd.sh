#!/bin/bash
# Setup collectd on an Ubuntu host to send metrics to katana.
# Usage: ssh HOST 'bash -s' < setup-collectd.sh
#   or:  ssh HOST 'bash -s -- --ts' < setup-collectd.sh  (use Tailscale IP for katana)

set -e

KATANA_LAN="10.0.6.129"
KATANA_TS=$(ssh katana "tailscale ip -4" 2>/dev/null || echo "100.96.209.70")
HOST=$(hostname)
USE_TS=false

if [[ "$1" == "--ts" ]]; then
  USE_TS=true
fi

if $USE_TS; then
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
