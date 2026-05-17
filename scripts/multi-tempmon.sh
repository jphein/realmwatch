#!/bin/bash
# Unified temperature monitor: ubox0 / gatekeeper / V1910 switch.
# Quiet (no spd-say) — toast alerts via notify-send only.
# Cadence: 30s for Linux boxes, switch reading lifted from switch-tempmon.log.
#
# Usage:  multi-tempmon.sh [interval_seconds]   default 30
# Stop:   Ctrl-C (or kill the background task)

set -u
INTERVAL="${1:-30}"

_REALM_STATE="${REALM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/realm}"
LOG_DIR="$_REALM_STATE/multi-tempmon"
LOG="$LOG_DIR/tempmon.log"
PIDFILE="$LOG_DIR/multi-tempmon.pid"
SWITCH_LOG="$_REALM_STATE/switch-fan/tempmon.log"
mkdir -p "$LOG_DIR"

# Kill any existing instance via pid file (prevents duplicate toasts)
if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        kill "$old" 2>/dev/null
        sleep 1
    fi
fi
echo $$ > "$PIDFILE"

# ANSI colors
C_RESET=$'\033[0m'
C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_ORANGE=$'\033[38;5;208m'
C_RED=$'\033[31m'
C_BOLD=$'\033[1m'
C_CYAN=$'\033[36m'

# Per-host alert state and per-host thresholds with hysteresis.
# V1910 idles at 70°C with fan unplugged — its known equilibrium.
# ubox0 oscillates 58-69°C under recording-room load — its 70°C edge is normal.
# Floors picked above each host's normal upper edge so steady-state never trips.
declare -A LAST_STEP=([ubox0]=-1 [gatekeeper]=-1 [v1910]=-1)
declare -A LADDERS=(
    [ubox0]="75 82 88 95"
    [gatekeeper]="70 80 85 95"
    [v1910]="78 82 88 95"
)
# Hysteresis: once we've alerted at level N, we don't allow LAST_STEP to drop
# back below N until temp falls HYST_DROP °C below that threshold. Prevents
# oscillation re-alerts (the bug that made this annoying).
HYST_DROP=5

color_for_temp() {
    # Color is per-host so v1910's 70°C plateau shows green, not yellow.
    local host="$1" t="$2"
    local floor=70
    [[ "$host" == "v1910" ]] && floor=78
    if   [[ ! "$t" =~ ^[0-9]+$ ]];     then printf '%s' "$C_DIM"
    elif (( t >= 95 ));                then printf '%s' "$C_RED$C_BOLD"
    elif (( t >= 85 ));                then printf '%s' "$C_RED"
    elif (( t >= floor + 10 ));        then printf '%s' "$C_ORANGE"
    elif (( t >= floor ));             then printf '%s' "$C_YELLOW"
    else                                    printf '%s' "$C_GREEN"
    fi
}

check_threshold() {
    local host="$1" temp="$2"
    [[ "$temp" =~ ^[0-9]+$ ]] || return
    local ladder=(${LADDERS[$host]})
    # Find step from raw temp.
    local step=-1 i
    for i in "${!ladder[@]}"; do
        (( temp >= ladder[i] )) && step=$i
    done
    local prev="${LAST_STEP[$host]}"
    # Latched logic: only fire on UPWARD step changes. Don't fire cooling
    # toasts (they were noise). Only allow LAST_STEP to drop if temp has
    # fallen $HYST_DROP °C below the previously-alerted threshold.
    if (( step > prev )); then
        local crossed="${ladder[step]}"
        local urgency="normal"
        (( crossed >= 85 )) && urgency="critical"
        notify-send -u "$urgency" -a "multi-tempmon" \
            "$host hot: ${temp}°C" "Crossed ${crossed}°C threshold"
        LAST_STEP[$host]=$step
    elif (( prev >= 0 )); then
        # Only relax the latch if we've cooled well past the threshold.
        local prev_threshold="${ladder[prev]}"
        if (( temp < prev_threshold - HYST_DROP )); then
            LAST_STEP[$host]=$step
        fi
        # Don't fire any cooling toast — silently relax.
    fi
}

poll_ubox0() {
    ssh -o ConnectTimeout=4 -o BatchMode=yes ubox0 '
        pkg=$(($(cat /sys/class/hwmon/hwmon2/temp1_input 2>/dev/null || echo 0)/1000))
        smm_temp="?"
        smm_fan="?"
        for h in /sys/class/hwmon/hwmon*; do
            [ "$(cat $h/name 2>/dev/null)" = "dell_smm" ] || continue
            smm_temp=$(($(cat $h/temp1_input 2>/dev/null || echo 0)/1000))
            smm_fan=$(cat $h/fan1_input 2>/dev/null || echo "?")
        done
        echo "$pkg $smm_temp $smm_fan"
    ' 2>/dev/null || echo "? ? ?"
}

poll_gatekeeper() {
    # Locate coretemp by name (hwmon order can shift across reboots) and walk
    # all temp*_input files to find the hottest core.
    # Remote shell is busybox ash — no (( )), use POSIX [ -gt ].
    ssh -o ConnectTimeout=4 -o BatchMode=yes root@gatekeeper '
        coretemp_path=""
        for h in /sys/class/hwmon/hwmon*; do
            [ "$(cat $h/name 2>/dev/null)" = "coretemp" ] && coretemp_path=$h && break
        done
        pkg="?"; max_core=0
        if [ -n "$coretemp_path" ]; then
            pkg=$(($(cat $coretemp_path/temp1_input 2>/dev/null || echo 0)/1000))
            for t in $coretemp_path/temp*_input; do
                [ -e "$t" ] || continue
                v=$(($(cat $t)/1000))
                [ "$v" -gt "$max_core" ] && max_core=$v
            done
        fi
        f0=$(($(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0)/1000))
        echo "$pkg $max_core $f0"
    ' 2>/dev/null || echo "? ? ?"
}

poll_v1910() {
    # Read latest POLL line from switch-tempmon.exp's log.
    # Format: "POLL <epoch> <temp> <fan_state> <power_state>"
    if [ ! -r "$SWITCH_LOG" ]; then
        echo "? ? ?"
        return
    fi
    local last age now
    last=$(grep '^POLL ' "$SWITCH_LOG" | tail -1)
    [ -z "$last" ] && { echo "? ? ?"; return; }
    set -- $last  # POLL ts temp fan power
    now=$(date +%s)
    age=$(( now - $2 ))
    # Stale if older than 60s
    if (( age > 60 )); then
        echo "? ? stale(${age}s)"
    else
        echo "$3 $4 $5"
    fi
}

cleanup() {
    rm -f "$PIDFILE"
    echo
    echo "${C_DIM}-- multi-tempmon stopped --${C_RESET}"
}
trap cleanup EXIT INT TERM

echo "${C_BOLD}multi-tempmon${C_RESET}  ${C_DIM}interval=${INTERVAL}s  log=$LOG${C_RESET}"
echo "${C_DIM}thresholds: 70 / 80 / 85=warn / 95=alarm   (Ctrl-C to stop)${C_RESET}"
printf "${C_DIM}%-9s  %-26s  %-26s  %-22s${C_RESET}\n" "time" "ubox0" "gatekeeper" "v1910 switch"
printf "${C_DIM}%-9s  %-26s  %-26s  %-22s${C_RESET}\n" "----" "pkg/smm/fan" "pkg/maxcore/freq" "temp/fan/power"
echo

while true; do
    # Poll all three in parallel via tempfiles (subshells can't return strings cleanly)
    tmpdir=$(mktemp -d)
    poll_ubox0      > "$tmpdir/u" &
    poll_gatekeeper > "$tmpdir/g" &
    poll_v1910      > "$tmpdir/v" &
    wait
    u_out=$(cat "$tmpdir/u")
    g_out=$(cat "$tmpdir/g")
    v_out=$(cat "$tmpdir/v")
    rm -rf "$tmpdir"

    read u_pkg u_smm u_fan <<<"$u_out"
    read g_pkg g_max g_freq <<<"$g_out"
    read v_temp v_fanstate v_power <<<"$v_out"

    ts=$(date +%H:%M:%S)

    # Color the temps (per-host so v1910's 70°C reads green)
    cu=$(color_for_temp ubox0 "$u_pkg")
    cg=$(color_for_temp gatekeeper "$g_pkg")
    cv=$(color_for_temp v1910 "$v_temp")

    printf "%s%s%s  %s%3s°C%s/%3s°C/%-5sRPM  %s%3s°C%s/%3s°C/%4sMHz  %s%3s°C%s/%-7s/%s\n" \
        "$C_DIM" "$ts" "$C_RESET" \
        "$cu" "$u_pkg" "$C_RESET" "$u_smm" "$u_fan" \
        "$cg" "$g_pkg" "$C_RESET" "$g_max" "$g_freq" \
        "$cv" "$v_temp" "$C_RESET" "$v_fanstate" "$v_power"

    # Log + alerts
    epoch=$(date +%s)
    echo "$epoch $ts ubox0=$u_pkg/$u_smm/$u_fan gk=$g_pkg/$g_max/$g_freq v1910=$v_temp/$v_fanstate/$v_power" >> "$LOG"

    check_threshold ubox0      "$u_pkg"
    check_threshold gatekeeper "$g_pkg"
    check_threshold v1910      "$v_temp"

    sleep "$INTERVAL"
done
