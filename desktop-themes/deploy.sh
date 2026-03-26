#!/usr/bin/env bash
# Deploy Realm desktop themes from realmwatch to their system locations.
#
# Usage:
#   ./desktop-themes/deploy.sh          # deploy all
#   ./desktop-themes/deploy.sh kitty    # deploy one
#   ./desktop-themes/deploy.sh ghostty
#   ./desktop-themes/deploy.sh gnome
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
G='\033[1;32m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'

deploy_kitty() {
  echo -e "${C}Kitty${N} → ~/.config/kitty/"
  mkdir -p ~/.config/kitty
  cp "$DIR/kitty/kitty.conf" ~/.config/kitty/kitty.conf
  echo -e "  ${G}OK${N}"
}

deploy_ghostty() {
  echo -e "${C}Ghostty${N} → ~/.config/ghostty/"
  mkdir -p ~/.config/ghostty/shaders
  cp "$DIR/ghostty/config" ~/.config/ghostty/config
  cp "$DIR/ghostty/realm-glow.glsl" ~/.config/ghostty/shaders/realm-glow.glsl
  echo -e "  ${G}OK${N}"
}

deploy_gnome() {
  echo -e "${C}GNOME Shell${N} → ~/.local/share/themes/Realm/"
  mkdir -p ~/.local/share/themes/Realm/gnome-shell
  cp "$DIR/gnome-shell/gnome-shell.css" ~/.local/share/themes/Realm/gnome-shell/gnome-shell.css
  echo -e "  ${G}OK${N}"
  # Apply if user-theme extension is enabled
  if gnome-extensions info user-theme@gnome-shell-extensions.gcampax.github.com 2>/dev/null | grep -q "ENABLED"; then
    gsettings set org.gnome.shell.extensions.user-theme name 'Realm'
    echo -e "  ${G}Applied${N} (user-theme extension)"
  else
    echo -e "  ${Y}Note${N}: enable user-theme extension and set theme to 'Realm'"
  fi
}

echo -e "${Y}Realm Desktop Theme Deployer${N}"
echo ""

case "${1:-all}" in
  kitty)   deploy_kitty ;;
  ghostty) deploy_ghostty ;;
  gnome)   deploy_gnome ;;
  all)
    deploy_kitty
    deploy_ghostty
    deploy_gnome
    ;;
  *)
    echo "Usage: $0 [kitty|ghostty|gnome|all]"
    exit 1
    ;;
esac

echo ""
echo -e "${G}Done${N}"
