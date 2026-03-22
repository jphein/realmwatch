#!/bin/bash
# Deploy the collectd WiFi client exec plugin to OpenWrt APs.
#
# Usage:
#   ./setup-collectd-ap.sh <AP_IP> [AP_IP2 ...]
#   ./setup-collectd-ap.sh all   # auto-resolves IPs from topology.json
#
# Description:
#   Installs collectd-mod-exec on each AP (if missing), uploads
#   collectd-wifi-clients.sh, appends the <Plugin exec> block to
#   /etc/collectd.conf (idempotent), and restarts collectd.
#
#   The exec plugin runs collectd-wifi-clients.sh every 60s, emitting
#   per-client signal/SNR/bitrate metrics under wifi_clients-<MAC>/.
#
# Requires: sshpass, collectd already running on APs (see setup-collectd-openwrt.sh)
# Note:     SSH password from OPENWRT_SSH_PASS env var or Bitwarden vault (bw CLI).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS="-o ConnectTimeout=4 -o StrictHostKeyChecking=no"
SSH_PASS="sshpass -p ${OPENWRT_SSH_PASS:-$(bw get password gatekeeper-openwrt 2>/dev/null)}"

deploy_ap() {
    local AP_IP="$1"
    local AP_HOST
    AP_HOST=$($SSH_PASS ssh $SSH_OPTS "root@$AP_IP" "cat /proc/sys/kernel/hostname" 2>/dev/null)

    if [ -z "$AP_HOST" ]; then
        echo "  SKIP $AP_IP — unreachable"
        return 1
    fi
    echo "  Deploying to $AP_HOST ($AP_IP)..."

    # Install exec plugin if missing
    $SSH_PASS ssh $SSH_OPTS "root@$AP_IP" "
        opkg list-installed 2>/dev/null | grep -q collectd-mod-exec || {
            opkg update >/dev/null 2>&1
            opkg install collectd-mod-exec 2>/dev/null
        }
    "

    # Upload wifi-clients script via SSH stdin (no sftp-server on OpenWrt)
    $SSH_PASS ssh $SSH_OPTS "root@$AP_IP" "mkdir -p /usr/local/bin"
    cat "$SCRIPT_DIR/collectd-wifi-clients.sh" | $SSH_PASS ssh $SSH_OPTS "root@$AP_IP" "cat > /usr/local/bin/collectd-wifi-clients.sh && chmod +x /usr/local/bin/collectd-wifi-clients.sh"

    # Add exec plugin to collectd config if not present
    $SSH_PASS ssh $SSH_OPTS "root@$AP_IP" '
        if ! grep -q "LoadPlugin exec" /etc/collectd.conf 2>/dev/null; then
            sed -i "/LoadPlugin network/i LoadPlugin exec" /etc/collectd.conf
            cat >> /etc/collectd.conf << "EXECCONF"

<Plugin exec>
  Exec "nobody:nogroup" "/usr/local/bin/collectd-wifi-clients.sh"
</Plugin>
EXECCONF
            echo "  config updated"
        else
            echo "  exec plugin already configured"
        fi
    '

    # Restart collectd
    $SSH_PASS ssh $SSH_OPTS "root@$AP_IP" "/etc/init.d/collectd restart 2>/dev/null"
    echo "  OK $AP_HOST — wifi client metrics enabled"
}

# Resolve AP list
AP_LIST=()
if [ "$1" = "all" ]; then
    echo "Resolving AP IPs from topology.json..."
    mapfile -t AP_LIST < <(python3 -c "
import json
with open('$SCRIPT_DIR/topology.json') as f:
    topo = json.load(f)
for n in topo['nodes']:
    if n.get('type') == 'tower' and n.get('ip'):
        print(n['ip'])
")
elif [ $# -gt 0 ]; then
    AP_LIST=("$@")
else
    echo "Usage: $0 <AP_IP> [AP_IP2 ...] | all"
    exit 1
fi

echo "=== Deploying WiFi client metrics to ${#AP_LIST[@]} APs ==="
SUCCESS=0
FAIL=0
for AP in "${AP_LIST[@]}"; do
    if deploy_ap "$AP"; then
        ((SUCCESS++))
    else
        ((FAIL++))
    fi
done
echo "=== Done: $SUCCESS deployed, $FAIL skipped ==="
echo "    Metrics will appear in ~60s at /var/lib/collectd/rrd/<AP>/wifi_clients-*/"
