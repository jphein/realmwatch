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
  # Reload Ghostty config via D-Bus (no restart, preserves sessions)
  if gdbus call --session --dest com.mitchellh.ghostty --object-path /com/mitchellh/ghostty --method org.gtk.Actions.Activate 'reload-config' '[]' '{}' &>/dev/null; then
    echo "Ghostty config reloaded"
  fi
  # Restart Brave to reload theme extension (preserves all tabs)
  sleep 2
  if pgrep -x brave >/dev/null 2>&1; then
    # Kill Brave gracefully (SIGTERM saves session), delete theme cache,
    # relaunch — Brave's "Continue where you left off" restores all tabs
    killall -TERM brave 2>/dev/null || true
    for i in $(seq 1 20); do
      pgrep -x brave >/dev/null 2>&1 || break
      sleep 0.5
    done
    rm -f "$(dirname "$DEPLOY")/brave/Cached Theme.pak"
    sleep 1
    setsid brave-browser-stable &>/dev/null &
    echo "Brave restart triggered"
  fi
done
