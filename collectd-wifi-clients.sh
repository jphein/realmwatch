#!/bin/sh
# collectd exec plugin — WiFi client metrics per AP.
# Optimized for minimal overhead: single iwinfo+awk pass, 60s interval.
#
# Metrics per client (MAC with underscores):
#   wifi_clients-<MAC>/signal_power  — signal dBm (gauge U:0)
#   wifi_clients-<MAC>/snr           — SNR (gauge 0:U)
#   wifi_clients-<MAC>/bitrate-tx    — TX Mbit/s (gauge)
#   wifi_clients-<MAC>/bitrate-rx    — RX Mbit/s (gauge)
#   wifi_clients/count               — total clients (gauge)

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
