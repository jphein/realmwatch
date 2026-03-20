#!/bin/bash
# Configure collectd on katana to collect local metrics and send to itself (UDP 25826).
# Run: sudo bash scripts/setup-collectd-katana.sh

set -e

echo "=== Configuring collectd on katana ==="

sudo tee /etc/collectd/collectd.conf > /dev/null << 'CONF'
Hostname "katana"
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
LoadPlugin sensors

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

<Plugin disk>
  Disk "nvme0n1"
  IgnoreSelected false
</Plugin>

<Plugin interface>
  IgnoreSelected true
  Interface "lo"
</Plugin>

<Plugin network>
  Server "127.0.0.1" "25826"
</Plugin>
CONF

sudo systemctl enable collectd
sudo systemctl restart collectd

echo "=== Done! collectd restarted ==="
echo "    Check in ~60s: ls /var/lib/collectd/rrd/katana/"
