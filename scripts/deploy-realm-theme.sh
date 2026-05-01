#!/usr/bin/env bash
# Deploy Realm fantasy LuCI theme to all OpenWrt devices in the fleet.
#
# Usage:
#   ./scripts/deploy-realm-theme.sh               # all OpenWrt devices
#   ./scripts/deploy-realm-theme.sh gatekeeper     # single device by name
#   ./scripts/deploy-realm-theme.sh 10.0.6.100     # single device by IP
set -uo pipefail

THEME_DIR="$(cd "$(dirname "$0")/../theme" && pwd)"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes"

G='\033[1;32m'; R='\033[1;31m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'

# shellcheck source=lib/fleet.sh
source "$(dirname "$0")/lib/fleet.sh"

# Remote paths
CSS_DIR="/www/luci-static/realm"
TPL_DIR="/usr/share/ucode/luci/template/themes/realm"

ssh_cmd() {
  ssh $SSH_OPTS "root@$1" "$2" 2>/dev/null
}

push_file() {
  local ip="$1" local_file="$2" remote_path="$3"
  cat "$local_file" | ssh $SSH_OPTS "root@$ip" "cat > $remote_path" 2>/dev/null
}

deploy_device() {
  local name="$1" ip="$2"
  printf "${C}%-22s${N} %s " "$name" "$ip"

  # Check reachable
  if ! ssh $SSH_OPTS "root@$ip" "echo ok" >/dev/null 2>&1; then
    echo -e "${R}UNREACHABLE${N}"
    return 1
  fi

  # Create directories
  ssh_cmd "$ip" "mkdir -p $CSS_DIR $TPL_DIR"

  # Push our overrides only — header.ut loads upstream bootstrap cascade.css
  # and mobile.css directly from /luci-static/bootstrap/, so we don't ship those.
  push_file "$ip" "$THEME_DIR/realm-overrides.css" "$CSS_DIR/realm-overrides.css"
  push_file "$ip" "$THEME_DIR/logo.svg" "$CSS_DIR/logo.svg"
  push_file "$ip" "$THEME_DIR/logo_48.png" "$CSS_DIR/logo_48.png"

  # Push templates
  push_file "$ip" "$THEME_DIR/header.ut" "$TPL_DIR/header.ut"
  push_file "$ip" "$THEME_DIR/footer.ut" "$TPL_DIR/footer.ut"
  push_file "$ip" "$THEME_DIR/sysauth.ut" "$TPL_DIR/sysauth.ut"

  # Register theme in UCI + set as active
  ssh_cmd "$ip" "
    uci set luci.themes.Realm='/luci-static/realm'
    uci set luci.main.mediaurlbase='/luci-static/realm'
    uci commit luci
  "

  echo -e "${G}OK${N}"
}

# ── Main ──
echo -e "${Y}Realm Theme Deployer${N}"
echo "Theme source: $THEME_DIR"
echo ""

FAILED=0
DEPLOYED=0

if [[ $# -gt 0 ]]; then
  # Single device mode
  target="$1"
  # Check if it's a name or IP
  if [[ -n "${OPENWRT_FLEET[$target]+x}" ]]; then
    deploy_device "$target" "${OPENWRT_FLEET[$target]}" || ((FAILED++))
    ((DEPLOYED++))
  else
    # Try as IP — find matching name
    found=0
    for name in "${!OPENWRT_FLEET[@]}"; do
      if [[ "${OPENWRT_FLEET[$name]}" == "$target" ]]; then
        deploy_device "$name" "$target" || ((FAILED++))
        ((DEPLOYED++))
        found=1
        break
      fi
    done
    if [[ $found -eq 0 ]]; then
      echo -e "${R}Unknown device: $target${N}"
      exit 1
    fi
  fi
else
  # All devices
  for name in $(echo "${!OPENWRT_FLEET[@]}" | tr ' ' '\n' | sort); do
    deploy_device "$name" "${OPENWRT_FLEET[$name]}" || ((FAILED++))
    ((DEPLOYED++))
  done
fi

echo ""
echo -e "${Y}Deployed:${N} $DEPLOYED  ${R}Failed:${N} $FAILED"
