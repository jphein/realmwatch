#!/usr/bin/env bash
# Per-AP firewall audit: validate each AP matches the realm's standard.
#
# Standard (set 2026-05-21):
#   - firewall.@zone[0].name='admin'
#   - firewall.@zone[0].network='admin' (only)
#   - firewall.@zone[0].input='ACCEPT'
#   - firewall.@defaults[0].input='REJECT'
#   - firewall.@defaults[0].output='ACCEPT'
#   - firewall.@defaults[0].forward='REJECT'
#   - network.admin exists (device=br-lan.6 or br-admin), proto='dhcp'
#   - network.lan does NOT exist (no orphan)
#   - network.globals.ula_prefix is empty (v6 disabled)
#   - No global IPv6 addresses on any interface
#
# Usage:
#   ./scripts/ap-firewall-audit.sh              # audit all reachable APs
#   ./scripts/ap-firewall-audit.sh ap-name      # one AP by name
#   ./scripts/ap-firewall-audit.sh --json       # machine output
#
# Prints PASS/FAIL per AP with the specific drift detected.
# Exit 0 if all PASS, 1 if any FAIL, 2 if any UNREACHABLE.

set -euo pipefail

G='\033[0;32m'; R='\033[0;31m'; Y='\033[0;33m'; C='\033[0;36m'; N='\033[0m'

_FLEET="$(dirname "$0")/lib/fleet.sh"
[[ -f "$_FLEET" ]] || { echo "ERROR: $_FLEET missing" >&2; exit 4; }
# shellcheck source=lib/fleet.sh
source "$_FLEET"
unset _FLEET

JSON=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h|--help) sed -n '2,/^$/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) TARGET="$arg" ;;
  esac
done

# Returns one of: PASS / FAIL:<reasons> / UNREACHABLE
audit_one() {
  local ip="$1"
  if ! ssh -o ConnectTimeout=3 -o BatchMode=yes "root@$ip" true 2>/dev/null; then
    echo "UNREACHABLE"
    return
  fi
  ssh -o ConnectTimeout=5 "root@$ip" '
    fail=""
    zname=$(uci -q get firewall.@zone[0].name)
    znet=$(uci -q get firewall.@zone[0].network 2>/dev/null | tr -d "\n")
    zinput=$(uci -q get firewall.@zone[0].input)
    dinput=$(uci -q get firewall.@defaults[0].input)
    doutput=$(uci -q get firewall.@defaults[0].output)
    dforward=$(uci -q get firewall.@defaults[0].forward)
    admin_dev=$(uci -q get network.admin.device)
    admin_proto=$(uci -q get network.admin.proto)
    lan_exists=$(uci -q get network.lan)
    ula=$(uci -q get network.globals.ula_prefix)
    v6=$(ip -6 addr 2>/dev/null | grep "inet6" | grep -vcE "(fe80::|::1/128)")

    [ "$zname" = "admin" ]                                 || fail="$fail zone.name=$zname(want=admin)"
    [ "$znet" = "admin" ]                                  || fail="$fail zone.network=$znet(want=admin)"
    [ "$zinput" = "ACCEPT" ]                               || fail="$fail zone.input=$zinput(want=ACCEPT)"
    [ "$dinput" = "REJECT" ]                               || fail="$fail defaults.input=$dinput(want=REJECT)"
    [ "$doutput" = "ACCEPT" ]                              || fail="$fail defaults.output=$doutput(want=ACCEPT)"
    [ "$dforward" = "REJECT" ]                             || fail="$fail defaults.forward=$dforward(want=REJECT)"
    case "$admin_dev" in br-lan.6|br-admin) ;; *) fail="$fail network.admin.device=$admin_dev(want=br-lan.6|br-admin)" ;; esac
    [ "$admin_proto" = "dhcp" ]                            || fail="$fail network.admin.proto=$admin_proto(want=dhcp)"
    [ -z "$lan_exists" ]                                   || fail="$fail network.lan=present(want=absent)"
    [ -z "$ula" ]                                          || fail="$fail ula_prefix=$ula(want=empty)"
    [ "$v6" = "0" ]                                        || fail="$fail v6_global_count=$v6(want=0)"

    if [ -z "$fail" ]; then
      echo "PASS"
    else
      echo "FAIL:$fail"
    fi
  ' 2>/dev/null || echo "FAIL:ssh-or-script-error"
}

# Build the AP list
if [[ -n "$TARGET" ]]; then
  ip="${APS[$TARGET]:-}"
  [[ -z "$ip" ]] && { echo "Unknown AP: $TARGET" >&2; exit 3; }
  declare -A SCAN=( ["$TARGET"]="$ip" )
else
  declare -A SCAN
  for n in "${!APS[@]}"; do SCAN[$n]="${APS[$n]}"; done
fi

pass=0 fail=0 unreach=0
results=()
for name in $(echo "${!SCAN[@]}" | tr ' ' '\n' | sort); do
  res=$(audit_one "${SCAN[$name]}")
  results+=("$name|${SCAN[$name]}|$res")
  case "$res" in
    PASS) pass=$((pass+1)) ;;
    UNREACHABLE) unreach=$((unreach+1)) ;;
    FAIL:*) fail=$((fail+1)) ;;
  esac
done

if [[ "$JSON" == "1" ]]; then
  printf '{"results":['
  first=1
  for line in "${results[@]}"; do
    IFS='|' read -r n i r <<<"$line"
    [[ $first -eq 1 ]] || printf ','
    printf '{"name":"%s","ip":"%s","result":"%s"}' "$n" "$i" "$r"
    first=0
  done
  printf '],"summary":{"pass":%d,"fail":%d,"unreachable":%d}}\n' "$pass" "$fail" "$unreach"
else
  echo -e "${C}=== Per-AP firewall audit (standard: zone=admin, defaults=REJECT/ACCEPT/REJECT, no ula, no v6) ===${N}"
  for line in "${results[@]}"; do
    IFS='|' read -r n i r <<<"$line"
    case "$r" in
      PASS)        printf "  ${G}✓ PASS${N}        %-22s %s\n" "$n" "$i" ;;
      UNREACHABLE) printf "  ${Y}● UNREACH${N}     %-22s %s\n" "$n" "$i" ;;
      FAIL:*)      printf "  ${R}✗ FAIL${N}        %-22s %s — %s\n" "$n" "$i" "${r#FAIL:}" ;;
    esac
  done
  echo ""
  echo -e "  ${G}pass=$pass${N}  ${R}fail=$fail${N}  ${Y}unreach=$unreach${N}"
fi

[[ "$fail" -gt 0 ]] && exit 1
[[ "$unreach" -gt 0 ]] && exit 2
exit 0
