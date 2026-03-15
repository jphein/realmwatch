#!/bin/sh
# collectd exec plugin — per-client WiFi signal metrics for OpenWrt APs.
#
# Deployed to: /usr/local/bin/collectd-wifi-clients.sh  (on each AP)
# Deployed by: setup-collectd-ap.sh
#
# Description:
#   Runs as a collectd exec plugin. Loops forever, sleeping COLLECTD_INTERVAL
#   seconds between iterations. Each iteration iterates all wireless interfaces
#   (iwinfo), collects assoclists, and emits PUTVAL lines for each client.
#
# Metrics emitted (MAC address with colons replaced by underscores):
#   <host>/wifi_clients-<MAC>/signal_power  — signal strength (dBm, gauge)
#   <host>/wifi_clients-<MAC>/snr           — signal-to-noise ratio (gauge)
#   <host>/wifi_clients-<MAC>/bitrate-tx    — TX rate (Mbit/s, gauge)
#   <host>/wifi_clients-<MAC>/bitrate-rx    — RX rate (Mbit/s, gauge)
#   <host>/wifi_clients/count               — total associated clients (gauge)
#
# Design: single iwinfo+awk pass per interval for minimal CPU overhead.
# Requires: iwinfo (standard on OpenWrt)

HOSTNAME="${COLLECTD_HOSTNAME:-$(cat /proc/sys/kernel/hostname)}"
INTERVAL="${COLLECTD_INTERVAL:-60}"

gather() {
    # Collect all assoclists into one stream, parse with single awk
    IFACES=$(iwinfo 2>/dev/null | grep ESSID | cut -d' ' -f1)
    [ -z "$IFACES" ] && { echo "PUTVAL \"$HOSTNAME/wifi_clients/count\" interval=$INTERVAL N:0"; return; }

    # Single subshell: iterate interfaces, pipe all output to one awk
    (for IFACE in $IFACES; do iwinfo "$IFACE" assoclist 2>/dev/null; done) | awk -v h="$HOSTNAME" -v iv="$INTERVAL" '
    /^[0-9A-Fa-f][0-9A-Fa-f]:/ {
        mac = tolower($1); gsub(/:/, "_", mac)
        sig = "U"; snr = "U"
        for (i = 2; i <= NF; i++) {
            if ($i ~ /^-[0-9]+$/ && $(i+1) == "dBm" && sig == "U") sig = $i
            if ($i == "(SNR") { v = $(i+1); gsub(/[^0-9]/, "", v); snr = v + 0 }
        }
        getline
        rx = "U"; split($0, a, " ")
        for (j in a) if (a[j] == "MBit/s" || a[j] == "MBit/s,") { rx = a[j-1] + 0; break }
        getline
        tx = "U"; split($0, a, " ")
        for (j in a) if (a[j] == "MBit/s" || a[j] == "MBit/s,") { tx = a[j-1] + 0; break }
        p = h "/wifi_clients-" mac
        printf "PUTVAL \"%s/signal_power\" interval=%d N:%s\n", p, iv, sig
        printf "PUTVAL \"%s/snr\" interval=%d N:%s\n", p, iv, snr
        printf "PUTVAL \"%s/bitrate-tx\" interval=%d N:%s\n", p, iv, tx
        printf "PUTVAL \"%s/bitrate-rx\" interval=%d N:%s\n", p, iv, rx
        count++
    }
    END {
        printf "PUTVAL \"%s/wifi_clients/count\" interval=%d N:%d\n", h, iv, count + 0
    }'
}

while true; do
    gather
    sleep "$INTERVAL"
done
