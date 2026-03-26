#!/usr/bin/env bash
# Deploy Realm desktop themes from realmwatch to their system locations.
#
# Usage:
#   ./desktop-themes/deploy.sh          # deploy all
#   ./desktop-themes/deploy.sh kitty    # deploy one
#   ./desktop-themes/deploy.sh ghostty
#   ./desktop-themes/deploy.sh brave
#   ./desktop-themes/deploy.sh navidrome
#   ./desktop-themes/deploy.sh gnome
#   ./desktop-themes/deploy.sh gtk
#   ./desktop-themes/deploy.sh dock
#   ./desktop-themes/deploy.sh extensions
#   ./desktop-themes/deploy.sh editor
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
G='\033[1;32m'; Y='\033[1;33m'; C='\033[0;36m'; N='\033[0m'

deploy_kitty() {
  mkdir -p ~/.config/kitty
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
    echo -e "${C}Kitty (light)${N} → ~/.config/kitty/"
    cp "$DIR/kitty/kitty-light.conf" ~/.config/kitty/kitty.conf
  else
    echo -e "${C}Kitty (dark)${N} → ~/.config/kitty/"
    cp "$DIR/kitty/kitty-dark.conf" ~/.config/kitty/kitty.conf
  fi
  echo -e "  ${G}OK${N}"
}

deploy_ghostty() {
  mkdir -p ~/.config/ghostty/shaders
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
    echo -e "${C}Ghostty (light)${N} → ~/.config/ghostty/"
    cp "$DIR/ghostty/config-light" ~/.config/ghostty/config
  else
    echo -e "${C}Ghostty (dark)${N} → ~/.config/ghostty/"
    cp "$DIR/ghostty/config-dark" ~/.config/ghostty/config
    cp "$DIR/ghostty/realm-glow.glsl" ~/.config/ghostty/shaders/realm-glow.glsl
  fi
  echo -e "  ${G}OK${N}"
}

deploy_brave() {
  local theme_dir="$DIR/brave"
  # Check if Brave is installed
  if ! command -v brave-browser &>/dev/null; then
    echo -e "  ${Y}Skip${N} — brave-browser not found"
    return
  fi
  # Pick dark or light based on system color scheme
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
    echo -e "${C}Brave (light)${N} → $theme_dir/manifest.json"
    cp "$theme_dir/manifest-light.json" "$theme_dir/manifest.json"
  else
    echo -e "${C}Brave (dark)${N} → $theme_dir/manifest.json"
    cp "$theme_dir/manifest-dark.json" "$theme_dir/manifest.json"
  fi
  # Delete cached theme so Brave reads fresh manifest on next launch
  rm -f "$theme_dir/Cached Theme.pak"
  echo -e "  ${G}OK${N}"
  # Brave requires manual load of unpacked extensions the first time.
  # After that, reload the extension or restart Brave to pick up changes.
  echo -e "  First time: brave://extensions → Developer mode → Load unpacked → select $theme_dir"
}

deploy_navidrome() {
  local remote="jp@10.0.6.120"
  local dest="/opt/mediaserver/site/navidrome/realm-theme.css"
  # Check if file server is reachable
  if ! ssh -o ConnectTimeout=3 "$remote" true 2>/dev/null; then
    echo -e "  ${Y}Skip${N} — file server unreachable"
    return
  fi
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
    echo -e "${C}Navidrome (light)${N} → $remote:$dest"
    scp -q "$DIR/navidrome/realm-light.css" "$remote:$dest"
  else
    echo -e "${C}Navidrome (dark)${N} → $remote:$dest"
    scp -q "$DIR/navidrome/realm-dark.css" "$remote:$dest"
  fi
  echo -e "  ${G}OK${N} (reload Navidrome page to see changes)"
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
    if [[ "$scheme" != "'prefer-dark'" ]]; then
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

deploy_dock() {
  echo -e "${C}Ubuntu Dock${N} → gsettings"
  # Ubuntu Dock ignores shell theme CSS — must use gsettings directly
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-background-color false
    gsettings set org.gnome.shell.extensions.dash-to-dock transparency-mode 'FIXED'
    gsettings set org.gnome.shell.extensions.dash-to-dock customize-alphas true
    gsettings set org.gnome.shell.extensions.dash-to-dock max-alpha 0.55
    gsettings set org.gnome.shell.extensions.dash-to-dock min-alpha 0.35
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-customize-running-dots true
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-color '#8a6520'
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-border-color '#6a3a90'
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-border-width 0
    echo -e "  ${G}OK${N} (light — translucent dock, dark gold dots)"
  else
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-background-color true
    gsettings set org.gnome.shell.extensions.dash-to-dock background-color '#2a1a40'
    gsettings set org.gnome.shell.extensions.dash-to-dock transparency-mode 'FIXED'
    gsettings set org.gnome.shell.extensions.dash-to-dock customize-alphas true
    gsettings set org.gnome.shell.extensions.dash-to-dock max-alpha 0.45
    gsettings set org.gnome.shell.extensions.dash-to-dock min-alpha 0.25
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-customize-running-dots true
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-color '#d4a050'
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-border-color '#b080d0'
    gsettings set org.gnome.shell.extensions.dash-to-dock custom-theme-running-dots-border-width 0
    echo -e "  ${G}OK${N} (dark — void dock, gold dots)"
  fi
}

deploy_extensions() {
  echo -e "${C}GNOME Extensions${N} — checking from extensions.json"
  local json="$DIR/gnome-extensions/extensions.json"
  if [[ ! -f "$json" ]]; then
    echo -e "  ${Y}Skip${N} — extensions.json not found"
    return
  fi

  # Process each extension with settings
  local ids
  ids=$(python3 -c "
import json
with open('$json') as f:
    data = json.load(f)
for ext in data['extensions']:
    if 'settings' in ext:
        print(ext['id'])
  " 2>/dev/null)

  for ext_id in $ids; do
    local name
    name=$(python3 -c "
import json
with open('$json') as f:
    data = json.load(f)
for ext in data['extensions']:
    if ext['id'] == '$ext_id':
        print(ext['name'])
        break
" 2>/dev/null)

    # Check if installed
    if ! gnome-extensions info "$ext_id" &>/dev/null; then
      echo -e "  ${Y}$name${N} — not installed, skipping settings"
      continue
    fi

    # Check if enabled
    if ! gnome-extensions info "$ext_id" 2>/dev/null | grep -qE "ENABLED|ACTIVE|Enabled: Yes"; then
      echo -e "  ${Y}$name${N} — installed but not enabled, skipping settings"
      continue
    fi

    # Apply dconf settings from JSON
    python3 -c "
import json, subprocess
with open('$json') as f:
    data = json.load(f)
for ext in data['extensions']:
    if ext['id'] != '$ext_id':
        continue
    base = '/org/gnome/shell/extensions/' + ext['id'].split('@')[0] + '/'
    for subpath, settings in ext.get('settings', {}).items():
        path = base + subpath
        for key, val in settings.items():
            dconf_key = path + key
            if isinstance(val, bool):
                dconf_val = 'true' if val else 'false'
            elif isinstance(val, int):
                dconf_val = str(val)
            elif isinstance(val, float):
                dconf_val = str(val)
            elif isinstance(val, str) and val.startswith('('):
                dconf_val = val  # tuple like (0.82, 0.63, 0.31, 0.5)
            elif isinstance(val, str):
                dconf_val = \"'\" + val + \"'\"
            else:
                continue
            subprocess.run(['dconf', 'write', dconf_key, dconf_val],
                         capture_output=True)
" 2>/dev/null
    echo -e "  ${G}$name${N} — settings applied"
  done
}

deploy_gtk() {
  mkdir -p ~/.config/gtk-4.0 ~/.config/gtk-3.0

  # Pick dark or light based on system color scheme
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || echo "'default'")
  if [[ "$scheme" != "'prefer-dark'" ]]; then
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
  brave)      deploy_brave ;;
  navidrome)  deploy_navidrome ;;
  gnome)      deploy_gnome ;;
  dock)       deploy_dock ;;
  extensions) deploy_extensions ;;
  gtk)        deploy_gtk ;;
  editor)     deploy_editor ;;
  all)
    deploy_kitty
    deploy_ghostty
    deploy_brave
    deploy_navidrome
    deploy_gnome
    deploy_dock
    deploy_extensions
    deploy_gtk
    deploy_editor
    ;;
  *)
    echo "Usage: $0 [kitty|ghostty|brave|navidrome|gnome|dock|extensions|gtk|editor|all]"
    exit 1
    ;;
esac

echo ""
echo -e "${G}Done${N}"
