#!/usr/bin/env bash
# Watch GNOME color-scheme changes and redeploy Realm desktop themes.
# Runs as a systemd user service via realm-theme-watcher.service.
set -euo pipefail

DEPLOY="$(cd "$(dirname "$0")" && pwd)/deploy.sh"

echo "Realm theme watcher started — monitoring color-scheme changes"

# Deploy once on startup to ensure current scheme is applied
"$DEPLOY" all

# Monitor for changes — gsettings monitor blocks and emits on each change
gsettings monitor org.gnome.desktop.interface color-scheme | while read -r _key value; do
  echo "Color scheme changed to: $value"
  # Small delay to let GNOME Shell finish its own transition
  sleep 1
  "$DEPLOY" all
  # Restart Brave to reload theme extension (preserves all tabs)
  sleep 2
  if pgrep -x brave >/dev/null 2>&1; then
    brave-browser-stable --new-window 'brave://restart' &>/dev/null &
    disown
    echo "Brave restart triggered"
  fi
done
