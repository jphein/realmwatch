#!/bin/bash
# HP V1910-24G live thermal monitor with desktop + voice alerts.
#
# Usage:  switch-tempmon.sh [interval_seconds]   # default 30
# Stop:   Ctrl-C
#
# Wraps switch-tempmon.exp (persistent SSH+cmdline session) and:
#  - pretty-prints each poll with color-coded temperature
#  - logs every line to $XDG_STATE_HOME/realm/switch-fan/tempmon.log
#  - fires notify-send + spd-say when:
#      * temp crosses 70°C / 80°C / 85°C(warn) / 90°C / 95°C(alarm)
#      * fan state leaves 'Normal'
#      * temp falls back below a threshold we previously alerted on (recovery)
#
# Thresholds match the V1910 firmware: 85°C WarningLimit, 95°C AlarmLimit.

set -u
INTERVAL="${1:-30}"

EXP="$(dirname "$0")/switch-tempmon.exp"
LOG_DIR="${REALM_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/realm}/switch-fan"
LOG="$LOG_DIR/tempmon.log"
mkdir -p "$LOG_DIR"

# ANSI colors
C_RESET=$'\033[0m'
C_DIM=$'\033[2m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_ORANGE=$'\033[38;5;208m'
C_RED=$'\033[31m'
C_BOLD=$'\033[1m'

# Ascending threshold ladder. last_step tracks the highest threshold crossed.
LADDER=(70 80 85 90 95)
last_step=-1
last_fan="Normal"

speak() {
    # Best-effort voice alert; never block the monitor.
    if command -v spd-say >/dev/null 2>&1; then
        spd-say -r -20 -i +20 "$1" >/dev/null 2>&1 &
    fi
}

notify() {
    local urgency="$1" title="$2" msg="$3"
    notify-send -u "$urgency" -a "switch-tempmon" "$title" "$msg" 2>/dev/null || true
}

color_for_temp() {
    local t="$1"
    if   [[ "$t" == "?" ]];        then printf '%s' "$C_DIM"
    elif (( t >= 95 ));            then printf '%s' "$C_RED$C_BOLD"
    elif (( t >= 85 ));            then printf '%s' "$C_RED"
    elif (( t >= 80 ));            then printf '%s' "$C_ORANGE"
    elif (( t >= 70 ));            then printf '%s' "$C_YELLOW"
    else                                printf '%s' "$C_GREEN"
    fi
}

handle_poll() {
    local ts="$1" temp="$2" fan="$3" power="$4"
    local human_ts; human_ts=$(date -d "@$ts" +"%H:%M:%S")
    local color;    color=$(color_for_temp "$temp")

    printf '%s[%s]%s  hotspot=%s%3s°C%s  fan=%s  power=%s\n' \
        "$C_DIM" "$human_ts" "$C_RESET" \
        "$color" "$temp" "$C_RESET" "$fan" "$power"

    # ---- threshold logic ----
    if [[ "$temp" =~ ^[0-9]+$ ]]; then
        # find highest ladder index <= temp
        local step=-1 i
        for i in "${!LADDER[@]}"; do
            (( temp >= LADDER[i] )) && step=$i
        done

        if (( step > last_step )); then
            local crossed="${LADDER[step]}"
            local urgency="normal"
            (( crossed >= 85 )) && urgency="critical"
            notify "$urgency" "Switch hot: ${temp}°C" "Crossed ${crossed}°C threshold (warn=85 alarm=95)"
            speak "Switch temperature now ${temp} degrees."
        elif (( step < last_step && last_step >= 0 )); then
            notify "low" "Switch cooling: ${temp}°C" "Below ${LADDER[last_step]}°C"
            speak "Switch cooling to ${temp} degrees."
        fi
        last_step=$step
    fi

    if [[ "$fan" != "?" && "$fan" != "$last_fan" ]]; then
        notify "critical" "Fan state changed" "Fan 1 was '$last_fan', now '$fan'"
        speak "Fan state changed from $last_fan to $fan."
        last_fan="$fan"
    fi
}

cleanup() {
    echo
    echo "${C_DIM}-- monitor stopped --${C_RESET}"
    [[ -n "${EXP_PID:-}" ]] && kill "$EXP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "${C_BOLD}HP V1910 thermal monitor${C_RESET}  ${C_DIM}interval=${INTERVAL}s  log=$LOG${C_RESET}"
echo "${C_DIM}thresholds: 70 / 80 / 85=warn / 90 / 95=alarm   (Ctrl-C to stop)${C_RESET}"
echo

# Run the expect, tee its stdout to log, parse our structured lines.
"$EXP" "$INTERVAL" 2> >(tee -a "$LOG" >&2) | tee -a "$LOG" | while IFS= read -r line; do
    case "$line" in
        "POLL "*)
            # POLL <epoch> <temp> <fan> <power>
            read -r _ ts temp fan power <<<"$line"
            handle_poll "$ts" "$temp" "$fan" "$power"
            ;;
        "READY "*)
            echo "${C_GREEN}${line}${C_RESET}"
            ;;
        "WARN "*|"ERR "*)
            echo "${C_YELLOW}${line}${C_RESET}"
            ;;
        *)
            [[ -n "$line" ]] && echo "${C_DIM}${line}${C_RESET}"
            ;;
    esac
done
