#!/bin/bash
# ── Realm SSL — generate self-signed certs for OpenWrt LuCI ──
# Creates a local CA, per-router certs with SAN, pushes to routers,
# and installs the CA into Ubuntu's trust store for Chrome.

set -euo pipefail

CERT_DIR="$HOME/.local/share/realm-ca"
CA_KEY="$CERT_DIR/realm-ca.key"
CA_CERT="$CERT_DIR/realm-ca.pem"
CA_DAYS=3650  # 10 years
CERT_DAYS=825 # ~2.25 years (Chrome max)

# OpenWrt devices with LuCI web interface (uhttpd)
declare -A ROUTERS=(
  [gatekeeper]="10.0.6.1"
  [mr8300-host]="10.0.6.100"
  [onhub-office]="10.0.6.101"
  [onhub-closet]="10.0.6.102"
  [woodshed]="10.0.6.105"
  [wndr4300sw-shed]="10.0.6.109"
  [onhub-pumphouse]="10.0.6.111"
  [wrt1900ac-family]="10.0.6.114"
  [ea6350-cl]="10.0.6.116"
  [eap225-outdoor]="10.0.6.119"
  [ea6350v3-family]="10.0.6.135"
  [onhub-family]="10.0.6.141"
  [onhub-bed]="10.0.6.246"
)

# HP managed switch — has web UI but not uhttpd (cert generated, push is manual)
declare -A SWITCHES=(
  [hp]="10.0.6.103"
)

SSH_PASS="<REDACTED-WIFI-PSK>"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"

info()  { echo -e "\033[1;33m[realm-ssl]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[realm-ssl]\033[0m $*"; }
err()   { echo -e "\033[1;31m[realm-ssl]\033[0m $*"; }

# ── Step 1: Create CA ──
create_ca() {
  mkdir -p "$CERT_DIR"

  if [[ -f "$CA_KEY" && -f "$CA_CERT" ]]; then
    info "CA already exists at $CERT_DIR"
    echo "  Subject: $(openssl x509 -in "$CA_CERT" -noout -subject 2>/dev/null)"
    echo "  Expires: $(openssl x509 -in "$CA_CERT" -noout -enddate 2>/dev/null)"
    read -rp "  Regenerate CA? (y/N): " regen
    [[ "$regen" != "y" && "$regen" != "Y" ]] && return 0
  fi

  info "Generating Realm CA key + certificate..."
  openssl genrsa -out "$CA_KEY" 4096 2>/dev/null
  openssl req -x509 -new -nodes \
    -key "$CA_KEY" \
    -sha256 \
    -days "$CA_DAYS" \
    -out "$CA_CERT" \
    -subj "/C=US/ST=Realm/O=Realmwatch/CN=Realm CA" \
    2>/dev/null
  chmod 600 "$CA_KEY"
  ok "CA created: $CA_CERT (valid ${CA_DAYS} days)"
}

# ── Step 2: Generate per-router cert ──
generate_cert() {
  local name="$1" ip="$2"
  local key="$CERT_DIR/${name}.key"
  local csr="$CERT_DIR/${name}.csr"
  local cert="$CERT_DIR/${name}.pem"
  local ext="$CERT_DIR/${name}.ext"

  info "Generating cert for $name ($ip)..."

  # Key
  openssl genrsa -out "$key" 2048 2>/dev/null

  # CSR
  openssl req -new -key "$key" \
    -out "$csr" \
    -subj "/C=US/ST=Realm/O=Realmwatch/CN=${name}" \
    2>/dev/null

  # Extensions file with SAN (Chrome requires this)
  cat > "$ext" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,nonRepudiation,keyEncipherment,dataEncipherment
subjectAltName=@alt_names

[alt_names]
DNS.1 = ${name}
DNS.2 = ${name}.local
IP.1 = ${ip}
EOF

  # Sign with CA
  openssl x509 -req \
    -in "$csr" \
    -CA "$CA_CERT" \
    -CAkey "$CA_KEY" \
    -CAcreateserial \
    -out "$cert" \
    -days "$CERT_DAYS" \
    -sha256 \
    -extfile "$ext" \
    2>/dev/null

  rm -f "$csr" "$ext"
  ok "  Cert: $cert (SAN: $name, $name.local, $ip)"
}

# ── Step 3: Push cert to router ──
push_cert() {
  local name="$1" ip="$2"
  local key="$CERT_DIR/${name}.key"
  local cert="$CERT_DIR/${name}.pem"

  info "Pushing cert to $name ($ip)..."

  if ! sshpass -p "$SSH_PASS" ssh $SSH_OPTS "root@${ip}" "echo ok" &>/dev/null; then
    err "  Cannot reach $name at $ip — skipping"
    return 1
  fi

  # Upload key + cert (ssh cat — OpenWrt lacks sftp-server)
  cat "$key"  | sshpass -p "$SSH_PASS" ssh $SSH_OPTS "root@${ip}" "cat > /etc/uhttpd.key" 2>/dev/null
  cat "$cert" | sshpass -p "$SSH_PASS" ssh $SSH_OPTS "root@${ip}" "cat > /etc/uhttpd.crt" 2>/dev/null

  # Configure uhttpd for HTTPS and restart
  sshpass -p "$SSH_PASS" ssh $SSH_OPTS "root@${ip}" "
    # Ensure HTTPS listener is configured
    uci set uhttpd.main.listen_https='0.0.0.0:443'
    uci set uhttpd.main.listen_https_v6='[::]:443'
    uci set uhttpd.main.key='/etc/uhttpd.key'
    uci set uhttpd.main.cert='/etc/uhttpd.crt'
    uci set uhttpd.main.redirect_https='1'
    uci commit uhttpd
    /etc/init.d/uhttpd restart
  " 2>/dev/null

  ok "  $name: HTTPS enabled, uhttpd restarted"
}

# ── Step 4: Trust CA on Ubuntu ──
trust_ca() {
  info "Installing Realm CA into Ubuntu system trust store..."

  sudo cp "$CA_CERT" /usr/local/share/ca-certificates/realm-ca.crt
  sudo update-ca-certificates 2>/dev/null

  ok "CA trusted system-wide. Restart Chrome for it to take effect."
  echo ""
  echo "  Chrome: close ALL windows and reopen, or visit chrome://restart"
  echo "  Firefox: import manually via Settings > Certificates > Import"
  echo ""
  echo "  CA cert: $CA_CERT"
}

# ── Main ──
main() {
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║   Realm SSL — Self-Signed Cert Setup     ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""

  create_ca
  echo ""

  # Generate certs for all OpenWrt devices
  for name in "${!ROUTERS[@]}"; do
    generate_cert "$name" "${ROUTERS[$name]}"
  done

  # Generate certs for managed switches (no uhttpd push)
  for name in "${!SWITCHES[@]}"; do
    generate_cert "$name" "${SWITCHES[$name]}"
  done
  echo ""

  # Push to OpenWrt routers/APs (uhttpd)
  info "Pushing certs to OpenWrt devices..."
  echo ""
  local success=0 fail=0
  for name in "${!ROUTERS[@]}"; do
    if push_cert "$name" "${ROUTERS[$name]}"; then
      ((success++))
    else
      ((fail++))
    fi
  done
  echo ""
  ok "Pushed to $success OpenWrt devices ($fail unreachable)"
  echo ""

  # Note about managed switches
  info "Managed switch certs (upload manually via web UI):"
  for name in "${!SWITCHES[@]}"; do
    echo "  $name (${SWITCHES[$name]}): $CERT_DIR/${name}.key + $CERT_DIR/${name}.pem"
  done
  echo ""

  # Trust CA
  read -rp "Install CA into Ubuntu trust store? (Y/n): " trust
  if [[ "$trust" != "n" && "$trust" != "N" ]]; then
    trust_ca
  fi

  echo ""
  ok "Done! ${#ROUTERS[@]} OpenWrt devices + ${#SWITCHES[@]} switch certs generated."
  echo "  HTTPS URLs:"
  for name in "${!ROUTERS[@]}"; do
    echo "    https://${ROUTERS[$name]}  ($name)"
  done
  for name in "${!SWITCHES[@]}"; do
    echo "    https://${SWITCHES[$name]}  ($name) — manual cert upload"
  done
  echo ""
}

main "$@"
