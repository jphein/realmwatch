#!/bin/bash
# ── Fix Chrome SSL — import Realm CA into Chrome's NSS database ──
# Run as your user (not sudo)

set -euo pipefail

CA_CERT="$HOME/.local/share/realm-ca/realm-ca.pem"
NSSDB="sql:$HOME/.pki/nssdb"
CA_NAME="Realm CA"

info() { echo -e "\033[1;33m[realm-ssl]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[realm-ssl]\033[0m $*"; }
err()  { echo -e "\033[1;31m[realm-ssl]\033[0m $*"; }

# Step 1: Recover CA from /root if needed
if [[ ! -f "$CA_CERT" ]]; then
  info "CA not found at $CA_CERT — copying from /root..."
  sudo cp -r /root/.local/share/realm-ca "$HOME/.local/share/realm-ca"
  sudo chown -R "$(id -u):$(id -g)" "$HOME/.local/share/realm-ca"
fi

if [[ ! -f "$CA_CERT" ]]; then
  err "CA cert not found. Run setup-ssl-certs.sh first."
  exit 1
fi

# Step 2: Ensure NSS tools installed
if ! command -v certutil &>/dev/null; then
  info "Installing libnss3-tools..."
  sudo apt-get install -y libnss3-tools
fi

# Step 3: Ensure NSS database exists
mkdir -p "$HOME/.pki/nssdb"
if [[ ! -f "$HOME/.pki/nssdb/cert9.db" ]]; then
  info "Creating NSS database..."
  certutil -d "$NSSDB" -N --empty-password
fi

# Step 4: Remove old entry if exists
certutil -d "$NSSDB" -D -n "$CA_NAME" 2>/dev/null || true

# Step 5: Import CA
info "Importing Realm CA into Chrome NSS database..."
certutil -d "$NSSDB" -A -t "C,," -n "$CA_NAME" -i "$CA_CERT"

# Step 6: Verify
ok "Realm CA imported into Chrome trust store."
certutil -d "$NSSDB" -L -n "$CA_NAME" | head -5
echo ""
ok "Restart Chrome now: close all windows or visit chrome://restart"
