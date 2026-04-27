#!/usr/bin/env bash
# Install the system-updates check timer as a systemd --user unit.
# Idempotent: re-running just refreshes the unit files and re-enables.
#
# Why a separate script instead of bundling in plugin.py setup(): the
# plugin runs as a long-lived process inside realmwatch and shouldn't
# touch user systemd state at startup (would trigger every realmwatch
# restart). Manual install is the right granularity — JP runs this
# once after deploying v1.2.0.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.config/systemd/user"
mkdir -p "$DEST"

install -m 644 "$HERE/realm-system-updates-check.service" "$DEST/"
install -m 644 "$HERE/realm-system-updates-check.timer" "$DEST/"

systemctl --user daemon-reload
systemctl --user enable --now realm-system-updates-check.timer

echo "✅ Daily update check timer installed and enabled."
systemctl --user list-timers realm-system-updates-check.timer --all
