# scripts/lib/config.sh
#
# XDG-aware config loader. Loads, in clig.dev precedence (lowest first):
#   1. built-in defaults
#   2. ~/.config/realm/config.sh
#   3. ./.realm.conf (project-local)
#   4. env vars already set
#   5. flags applied to env in args.sh
#
# Exposes:
#   $REALM_HOST, $REALM_PORT, $REALM_API
#   realm::state_dir, realm::cache_dir, realm::config_dir
#
# Source me, don't execute.

# Built-in defaults
: "${REALM_HOST:=http://localhost}"
: "${REALM_PORT:=80}"

# Resolve the user config file first; sourcing it lets the user override anything above
_realm_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/realm"
if [[ -f "$_realm_config_dir/config.sh" ]]; then
  # shellcheck disable=SC1090
  source "$_realm_config_dir/config.sh"
fi

# Project-local override
if [[ -f "./.realm.conf" ]]; then
  # shellcheck disable=SC1091
  source "./.realm.conf"
fi

# Compute derived values after all sourcing is done
REALM_API="${REALM_HOST}"
if [[ "$REALM_PORT" != "80" && "$REALM_PORT" != "443" ]]; then
  # Only append port if non-standard. Trust user-supplied REALM_HOST if it already has a port.
  if [[ "$REALM_HOST" != *":"$REALM_PORT* ]]; then
    REALM_API="${REALM_HOST}:${REALM_PORT}"
  fi
fi

realm::state_dir() {
  local d="${XDG_STATE_HOME:-$HOME/.local/state}/realm"
  mkdir -p "$d"
  printf '%s' "$d"
}

realm::cache_dir() {
  local d="${XDG_CACHE_HOME:-$HOME/.cache}/realm"
  mkdir -p "$d"
  printf '%s' "$d"
}

realm::config_dir() {
  mkdir -p "$_realm_config_dir"
  printf '%s' "$_realm_config_dir"
}
