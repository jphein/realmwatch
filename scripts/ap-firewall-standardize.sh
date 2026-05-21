#!/usr/bin/env bash
# Standardize per-AP fw4 + network config to the realm standard.
# Idempotent. DRY-RUN by default — prints the plan; pass --commit to execute.
#
# Realm standard (companion to ap-firewall-audit.sh):
#   - firewall.@defaults[0].input='REJECT' / .output='ACCEPT' / .forward='REJECT'
#   - firewall.@zone[trusted].name='admin', .network='admin', .input='ACCEPT'
#   - All forwarding/rule entries with src/dest in {lan, mgmt} rewritten to 'admin'
#   - network.lan removed if it exists as a dangling orphan
#   - network.globals.ula_prefix removed
#
# Safety:
#   - Each AP gets /etc/config/{firewall,network} backed up to /root/ before any change
#   - A setsid-detached rollback timer fires in 120s if not disarmed
#   - We disarm AFTER verifying SSH still works post-reload
#
# Usage:
#   ./scripts/ap-firewall-standardize.sh <ap_name|--all> [--commit]
#   ./scripts/ap-firewall-standardize.sh --all                  # dry-run all
#   ./scripts/ap-firewall-standardize.sh north-office --commit  # apply one
#
# Requires: ssh key auth to root@<ap_ip>.

set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; B='\033[0;34m'; N='\033[0m'

_FLEET="$(dirname "$0")/lib/fleet.sh"
[[ -f "$_FLEET" ]] || { echo "ERROR: $_FLEET missing" >&2; exit 4; }
# shellcheck source=lib/fleet.sh
source "$_FLEET"
unset _FLEET

COMMIT=0
TARGET=""
ALL=0
for arg in "$@"; do
  case "$arg" in
    --commit) COMMIT=1 ;;
    --all)    ALL=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *)   TARGET="$arg" ;;
  esac
done

if [[ -z "$TARGET" && "$ALL" -eq 0 ]]; then
  echo "Usage: $0 <ap_name|--all> [--commit]" >&2
  exit 2
fi

# Build target list
declare -A SCAN
if [[ "$ALL" -eq 1 ]]; then
  for n in "${!APS[@]}"; do SCAN[$n]="${APS[$n]}"; done
else
  ip="${APS[$TARGET]:-}"
  [[ -z "$ip" ]] && { echo "Unknown AP: $TARGET" >&2; exit 3; }
  SCAN[$TARGET]="$ip"
fi

# The remote-side standardization script, embedded so we can pipe it via ssh.
# Args: $1 = "dryrun" or "commit"
REMOTE_SCRIPT='#!/bin/sh
set -e
MODE="$1"
TS=$(date +%s)

# === Plan: collect drift items ===
plan=""
add_plan() { plan="$plan\n  - $1"; }

dinput=$(uci -q get firewall.@defaults[0].input 2>/dev/null || echo "")
doutput=$(uci -q get firewall.@defaults[0].output 2>/dev/null || echo "")
dforward=$(uci -q get firewall.@defaults[0].forward 2>/dev/null || echo "")
[ "$dinput"   != "REJECT" ] && add_plan "set firewall.@defaults[0].input=REJECT (was $dinput)"
[ "$doutput"  != "ACCEPT" ] && add_plan "set firewall.@defaults[0].output=ACCEPT (was $doutput)"
[ "$dforward" != "REJECT" ] && add_plan "set firewall.@defaults[0].forward=REJECT (was $dforward)"

# Find trusted zone (named lan/mgmt/admin)
zone_idx=""
i=0
while uci -q get firewall.@zone[$i] >/dev/null 2>&1; do
  nm="$(uci -q get firewall.@zone[$i].name)"
  case "$nm" in
    lan|mgmt|admin) zone_idx=$i; break ;;
  esac
  i=$((i+1))
done

if [ -z "$zone_idx" ]; then
  echo "ERROR: no trusted firewall zone found (lan/mgmt/admin) — refusing to act"
  exit 5
fi

zname=$(uci -q get firewall.@zone[$zone_idx].name)
znet=$(uci -q get firewall.@zone[$zone_idx].network 2>/dev/null | tr "\n" " " | sed "s/ \$//")
zinput=$(uci -q get firewall.@zone[$zone_idx].input)

[ "$zname"  != "admin"  ] && add_plan "rename firewall.@zone[$zone_idx].name: $zname -> admin"
[ "$znet"   != "admin"  ] && add_plan "set firewall.@zone[$zone_idx].network=[admin] (was: $znet)"
[ "$zinput" != "ACCEPT" ] && add_plan "set firewall.@zone[$zone_idx].input=ACCEPT (was $zinput)"

# forwarding/rule references to old zone name
old_name="$zname"
if [ "$old_name" != "admin" ]; then
  i=0
  while uci -q get firewall.@forwarding[$i] >/dev/null 2>&1; do
    [ "$(uci -q get firewall.@forwarding[$i].src)"  = "$old_name" ] && add_plan "rewrite firewall.@forwarding[$i].src: $old_name -> admin"
    [ "$(uci -q get firewall.@forwarding[$i].dest)" = "$old_name" ] && add_plan "rewrite firewall.@forwarding[$i].dest: $old_name -> admin"
    i=$((i+1))
  done
  i=0
  while uci -q get firewall.@rule[$i] >/dev/null 2>&1; do
    [ "$(uci -q get firewall.@rule[$i].src)"  = "$old_name" ] && add_plan "rewrite firewall.@rule[$i].src: $old_name -> admin"
    [ "$(uci -q get firewall.@rule[$i].dest)" = "$old_name" ] && add_plan "rewrite firewall.@rule[$i].dest: $old_name -> admin"
    i=$((i+1))
  done
fi

# network.lan orphan?
lan_dev=$(uci -q get network.lan.device 2>/dev/null || echo "")
admin_dev=$(uci -q get network.admin.device 2>/dev/null || echo "")
if [ -n "$lan_dev" ] && [ -n "$admin_dev" ]; then
  add_plan "remove orphan network.lan (device=$lan_dev; real mgmt is network.admin=$admin_dev)"
fi

# network.globals.ula_prefix
ula=$(uci -q get network.globals.ula_prefix 2>/dev/null || echo "")
[ -n "$ula" ] && add_plan "remove network.globals.ula_prefix ($ula)"

# Done planning
if [ -z "$plan" ]; then
  echo "OK already-compliant — no changes needed"
  exit 0
fi

printf "PLAN:"
printf "%b\n" "$plan"

if [ "$MODE" = "dryrun" ]; then
  exit 0
fi

# === Commit mode ===
FW_BACKUP=/root/firewall.pre-std.$TS
NET_BACKUP=/root/network.pre-std.$TS
DISARM=/root/std-disarm-$TS
cp /etc/config/firewall "$FW_BACKUP"
cp /etc/config/network  "$NET_BACKUP"
echo "BACKUP firewall: $FW_BACKUP"
echo "BACKUP network:  $NET_BACKUP"

# Arm setsid rollback BEFORE writing changes
setsid sh -c "sleep 120
[ -f $DISARM ] && exit 0
cp $FW_BACKUP /etc/config/firewall
cp $NET_BACKUP /etc/config/network
fw4 reload >/dev/null 2>&1 || /etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/network reload >/dev/null 2>&1" </dev/null >/dev/null 2>&1 &
echo "ARMED rollback (disarm: $DISARM)"

# Apply changes
uci set firewall.@defaults[0].input=REJECT
uci set firewall.@defaults[0].output=ACCEPT
uci set firewall.@defaults[0].forward=REJECT
uci set firewall.@zone[$zone_idx].name=admin
uci -q delete firewall.@zone[$zone_idx].network
uci add_list firewall.@zone[$zone_idx].network=admin
uci set firewall.@zone[$zone_idx].input=ACCEPT
uci set firewall.@zone[$zone_idx].output=ACCEPT
uci set firewall.@zone[$zone_idx].forward=REJECT
if [ "$old_name" != "admin" ]; then
  i=0
  while uci -q get firewall.@forwarding[$i] >/dev/null 2>&1; do
    [ "$(uci -q get firewall.@forwarding[$i].src)"  = "$old_name" ] && uci set firewall.@forwarding[$i].src=admin
    [ "$(uci -q get firewall.@forwarding[$i].dest)" = "$old_name" ] && uci set firewall.@forwarding[$i].dest=admin
    i=$((i+1))
  done
  i=0
  while uci -q get firewall.@rule[$i] >/dev/null 2>&1; do
    [ "$(uci -q get firewall.@rule[$i].src)"  = "$old_name" ] && uci set firewall.@rule[$i].src=admin
    [ "$(uci -q get firewall.@rule[$i].dest)" = "$old_name" ] && uci set firewall.@rule[$i].dest=admin
    i=$((i+1))
  done
fi
[ -n "$lan_dev" ] && [ -n "$admin_dev" ] && uci -q delete network.lan
uci -q delete network.globals.ula_prefix || true

uci commit firewall
uci commit network

fw4 reload >/dev/null 2>&1 || /etc/init.d/firewall reload >/dev/null 2>&1

echo "COMMITTED disarm-with: touch $DISARM"
echo "DISARM=$DISARM"
'

echo -e "${C}=== ap-firewall-standardize (mode: $([ $COMMIT -eq 1 ] && echo COMMIT || echo DRY-RUN)) ===${N}"
[[ $COMMIT -eq 0 ]] && echo -e "${Y}  (re-run with --commit to actually apply changes)${N}"
echo ""

fail=0
applied=0
ok=0
unreach=0

for name in $(echo "${!SCAN[@]}" | tr ' ' '\n' | sort); do
  ip="${SCAN[$name]}"
  echo -e "${B}── $name ($ip) ──${N}"

  if ! ssh -o ConnectTimeout=4 -o BatchMode=yes "root@$ip" true 2>/dev/null; then
    echo -e "  ${Y}● UNREACHABLE${N}"
    unreach=$((unreach+1))
    continue
  fi

  mode=$([ $COMMIT -eq 1 ] && echo "commit" || echo "dryrun")
  out=$(ssh -o ConnectTimeout=8 "root@$ip" "cat > /tmp/std.sh && sh /tmp/std.sh $mode" <<<"$REMOTE_SCRIPT" 2>&1) || true

  echo "$out" | sed 's/^/  /'

  case "$out" in
    *"already-compliant"*) ok=$((ok+1)) ;;
    *"COMMITTED"*)
      applied=$((applied+1))
      # Verify + disarm
      disarm=$(echo "$out" | awk -F= '/^DISARM=/{print $2}')
      sleep 2
      if ssh -o ConnectTimeout=5 "root@$ip" "touch $disarm" 2>/dev/null; then
        echo -e "  ${G}✓ verified + disarmed${N}"
      else
        echo -e "  ${R}✗ SSH dropped after commit — rollback will fire in <120s${N}"
        fail=$((fail+1))
      fi
      ;;
    *PLAN:*)
      # Dry-run; just listed the plan
      :
      ;;
    *) fail=$((fail+1)) ;;
  esac
  echo ""
done

echo -e "${C}=== summary ===${N}"
echo -e "  ${G}compliant=$ok${N}  applied=$applied  failed=$fail  ${Y}unreachable=$unreach${N}"

[[ $fail -gt 0 ]] && exit 1
exit 0
