#!/usr/bin/env bash
# realm-version — print version info, optionally with sibling-service rollup
set -euo pipefail

REALM_HELP_SUMMARY="Print realm CLI version and (with --all) sibling service versions"
realm::help() {
  cat <<'EOF'
realm version — print version info

USAGE:
  realm version [--all]

OPTIONS:
  --all     Also fetch /api/version on the local realm server and sibling
            services (oracle, coin, portal, status, deploy) if reachable.
  --json    Emit version info as JSON ({"name","hash"}; --all adds local+siblings).

EXAMPLES:
  realm version
  realm version --json
  realm version --all
  realm version --all --json
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

show_all=""
[[ "${1:-}" = "--all" ]] && show_all=1

# Resolve the CLI's own short hash the same way realm::_print_version does
# (stamp file → git → "dev"), so --json reports an identical value.
_self_hash() {
  local stamp_file
  stamp_file="$(dirname "${BASH_SOURCE[0]}")/.realm-version"
  if [[ -f "$stamp_file" ]]; then
    cat "$stamp_file" 2>/dev/null || echo dev
  elif git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD &>/dev/null; then
    git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD
  else
    echo dev
  fi
}

# --- JSON mode ---
if [[ "$REALM_OUTPUT" = "json" ]]; then
  hash="$(_self_hash)"
  if [[ -z "$show_all" ]]; then
    jq -n --arg name realm --arg hash "$hash" '{name:$name, hash:$hash}'
    exit 0
  fi

  # --all: roll local server + siblings into one object.
  local_json="null"
  if realm::api_reachable; then
    local_json="$(realm::api_get /api/version 2>/dev/null || echo null)"
    # Guard against non-JSON bodies (e.g. server without /api/version).
    printf '%s' "$local_json" | jq -e . >/dev/null 2>&1 || local_json="null"
  fi

  declare -A SIBLINGS=(
    [oracle]="https://oracle.realm.watch"
    [coin]="https://coin.realm.watch"
    [portal]="https://portal.realm.watch"
    [status]="https://status.realm.watch"
    [deploy]="https://deploy.realm.watch"
  )
  sib_conf="$(realm::config_dir)/siblings.conf"
  if [[ -f "$sib_conf" ]]; then
    while IFS='=' read -r k v; do
      [[ -z "$k" || "$k" = \#* ]] && continue
      SIBLINGS["$k"]="$v"
    done < "$sib_conf"
  fi

  siblings_json="{}"
  for name in "${!SIBLINGS[@]}"; do
    url="${SIBLINGS[$name]}"
    resp="$(curl --silent --fail --max-time 2 "$url/api/version" 2>/dev/null || true)"
    if [[ -z "$resp" ]] || ! printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
      entry="$(jq -n --arg url "$url" '{url:$url, reachable:false}')"
    else
      entry="$(printf '%s' "$resp" | jq --arg url "$url" '{url:$url, reachable:true} + .')"
    fi
    siblings_json="$(printf '%s' "$siblings_json" | jq --arg n "$name" --argjson e "$entry" '. + {($n): $e}')"
  done

  jq -n --arg name realm --arg hash "$hash" \
    --argjson local "$local_json" --argjson siblings "$siblings_json" \
    '{name:$name, hash:$hash, local:$local, siblings:$siblings}'
  exit 0
fi

# --- Human mode ---
# Self version line
realm::_print_version

if [[ -z "$show_all" ]]; then
  exit 0
fi

# Local realm server
realm::print_section "Local realm server"
if realm::api_reachable; then
  realm::api_get /api/version 2>/dev/null \
    | jq -r '"  \(.name // "?") \(.version // "?") (\(.hash // "?"), built \(.built // "?"))"' 2>/dev/null \
    || echo "  (no /api/version on this server)"
else
  realm::status_fail "unreachable: $REALM_API"
fi

# Sibling services
realm::print_section "Sibling services"
declare -A SIBLINGS=(
  [oracle]="https://oracle.realm.watch"
  [coin]="https://coin.realm.watch"
  [portal]="https://portal.realm.watch"
  [status]="https://status.realm.watch"
  [deploy]="https://deploy.realm.watch"
)

# Optional override from ~/.config/realm/siblings.conf
sib_conf="$(realm::config_dir)/siblings.conf"
if [[ -f "$sib_conf" ]]; then
  # Format: name=URL per line
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" = \#* ]] && continue
    SIBLINGS["$k"]="$v"
  done < "$sib_conf"
fi

for name in "${!SIBLINGS[@]}"; do
  url="${SIBLINGS[$name]}"
  resp="$(curl --silent --fail --max-time 2 "$url/api/version" 2>/dev/null || true)"
  if [[ -z "$resp" ]]; then
    realm::status_fail "$name ($url): unreachable"
  else
    v="$(printf '%s' "$resp" | jq -r '.version // "?"' 2>/dev/null)"
    h="$(printf '%s' "$resp" | jq -r '.hash // "?"' 2>/dev/null)"
    realm::status_ok "$name: $v ($h)"
  fi
done
