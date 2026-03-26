#!/usr/bin/env bash
# Deploy Realm desktop themes from realmwatch to their system locations.
#
# Usage:
#   ./desktop-themes/deploy.sh          # deploy all
#   ./desktop-themes/deploy.sh kitty    # deploy one
#   ./desktop-themes/deploy.sh ghostty
#   ./desktop-themes/deploy.sh gnome
#   ./desktop-themes/deploy.sh gtk
#   ./desktop-themes/deploy.sh editor
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
  echo -e "${C}GNOME Shell (dark)${N} → ~/.local/share/themes/Realm/"
  mkdir -p ~/.local/share/themes/Realm/gnome-shell
  cp "$DIR/gnome-shell/gnome-shell.css" ~/.local/share/themes/Realm/gnome-shell/gnome-shell.css
  echo -e "  ${G}OK${N}"

  echo -e "${C}GNOME Shell (light)${N} → ~/.local/share/themes/Realm-Light/"
  mkdir -p ~/.local/share/themes/Realm-Light/gnome-shell
  cp "$DIR/gnome-shell/gnome-shell-light.css" ~/.local/share/themes/Realm-Light/gnome-shell/gnome-shell.css
  echo -e "  ${G}OK${N}"

  # Apply dark variant if user-theme extension is enabled
  if gnome-extensions info user-theme@gnome-shell-extensions.gcampax.github.com 2>/dev/null | grep -qE "ENABLED|ACTIVE|Enabled: Yes"; then
    local scheme
    scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
    if [[ "$scheme" == "'prefer-light'" ]]; then
      gsettings set org.gnome.shell.extensions.user-theme name 'Realm-Light'
      echo -e "  ${G}Applied${N} Realm-Light (matches light system scheme)"
    else
      gsettings set org.gnome.shell.extensions.user-theme name 'Realm'
      echo -e "  ${G}Applied${N} Realm (matches dark system scheme)"
    fi
  else
    echo -e "  ${Y}Note${N}: enable user-theme extension and set theme to 'Realm' or 'Realm-Light'"
  fi
}

deploy_gtk() {
  mkdir -p ~/.config/gtk-4.0 ~/.config/gtk-3.0

  # Pick dark or light based on system color scheme
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" == "'prefer-light'" ]]; then
    echo -e "${C}GTK4 (light)${N} → ~/.config/gtk-4.0/"
    cp "$DIR/gtk4/gtk-light.css" ~/.config/gtk-4.0/gtk.css
  else
    echo -e "${C}GTK4 (dark)${N} → ~/.config/gtk-4.0/"
    cp "$DIR/gtk4/gtk-dark.css" ~/.config/gtk-4.0/gtk.css
  fi
  echo -e "  ${G}OK${N}"

  echo -e "${C}GTK3${N} → ~/.config/gtk-3.0/"
  cp "$DIR/gtk3/gtk.css" ~/.config/gtk-3.0/gtk.css
  echo -e "  ${G}OK${N}"
}

deploy_editor() {
  echo -e "${C}Text Editor${N} → ~/.local/share/gtksourceview-5/styles/"
  mkdir -p ~/.local/share/gtksourceview-5/styles
  cp "$DIR/gnome-text-editor/realm-dark.xml" ~/.local/share/gtksourceview-5/styles/realm-dark.xml
  cp "$DIR/gnome-text-editor/realm-light.xml" ~/.local/share/gtksourceview-5/styles/realm-light.xml
  echo -e "  ${G}OK${N}"

  # Set realm-dark as active (auto-switches with style-variant follow)
  gsettings set org.gnome.TextEditor style-scheme 'realm-dark' 2>/dev/null || true
  gsettings set org.gnome.TextEditor style-variant 'follow' 2>/dev/null || true
  echo -e "  ${G}Applied${N} realm-dark (follows system dark/light)"
}

echo -e "${Y}Realm Desktop Theme Deployer${N}"
echo ""

case "${1:-all}" in
  kitty)   deploy_kitty ;;
  ghostty) deploy_ghostty ;;
  gnome)   deploy_gnome ;;
  gtk)     deploy_gtk ;;
  editor)  deploy_editor ;;
  all)
    deploy_kitty
    deploy_ghostty
    deploy_gnome
    deploy_gtk
    deploy_editor
    ;;
  *)
    echo "Usage: $0 [kitty|ghostty|gnome|gtk|editor|all]"
    exit 1
    ;;
esac

echo ""
echo -e "${G}Done${N}"
