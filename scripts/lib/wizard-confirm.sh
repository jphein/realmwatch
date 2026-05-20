# scripts/lib/wizard-confirm.sh
#
# Confirmation prompts for realm-wizard. Respects --yes, --non-interactive,
# and --dry-run modes from the parent wizard.
#
# Source me. The wizard sets WIZARD_YES, WIZARD_DRY, WIZARD_NONINT before
# calling any function in here.
#
# Functions:
#   wizard::confirm "prompt"              → y/N (no=default), respects flags
#   wizard::confirm_yes "prompt"          → Y/n (yes=default)
#   wizard::prompt "prompt" [default]     → free-form input with optional default
#   wizard::prompt_secret "prompt"        → masked input (read -s)
#   wizard::pick "prompt" opt1 opt2 ...   → menu picker, returns selected index (1-based)
#
# All output goes to stderr so functions can echo values to stdout cleanly.

: "${WIZARD_YES:=}"
: "${WIZARD_DRY:=}"
: "${WIZARD_NONINT:=}"

# wizard::confirm — default NO. Returns 0 if user said yes.
# In --yes mode: returns 0 (auto-yes).
# In --non-interactive or --dry-run mode (without --yes): returns 1 (skip).
wizard::confirm() {
  local prompt="${1:-Continue?}"
  if [[ -n "$WIZARD_YES" ]]; then
    printf '  %s%s%s %s[auto-yes]%s\n' "$D" "$prompt" "$N" "$G" "$N" >&2
    return 0
  fi
  if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
    printf '  %s%s%s %s[skipped — non-interactive]%s\n' "$D" "$prompt" "$N" "$Y" "$N" >&2
    return 1
  fi
  printf '  %s%s%s [y/N] ' "$W" "$prompt" "$N" >&2
  local reply=""
  read -r reply
  [[ "$reply" =~ ^[Yy] ]]
}

# wizard::confirm_yes — default YES. Empty input means "yes".
wizard::confirm_yes() {
  local prompt="${1:-Continue?}"
  if [[ -n "$WIZARD_YES" ]]; then
    printf '  %s%s%s %s[auto-yes]%s\n' "$D" "$prompt" "$N" "$G" "$N" >&2
    return 0
  fi
  if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
    printf '  %s%s%s %s[skipped — non-interactive]%s\n' "$D" "$prompt" "$N" "$Y" "$N" >&2
    return 1
  fi
  printf '  %s%s%s [Y/n] ' "$W" "$prompt" "$N" >&2
  local reply=""
  read -r reply
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# wizard::prompt — free-form input. Echoes value to stdout.
# Empty input returns the default if provided.
# In non-interactive: returns default (or empty).
wizard::prompt() {
  local prompt="$1"
  local default="${2:-}"
  if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
    printf '%s' "$default"
    return 0
  fi
  if [[ -n "$default" ]]; then
    printf '  %s%s%s [%s%s%s]: ' "$W" "$prompt" "$N" "$C" "$default" "$N" >&2
  else
    printf '  %s%s%s: ' "$W" "$prompt" "$N" >&2
  fi
  local reply=""
  read -r reply
  if [[ -z "$reply" && -n "$default" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$reply"
  fi
}

# wizard::prompt_secret — masked input. Echoes value to stdout, prints newline
# to stderr after for layout. Empty input returns empty string.
wizard::prompt_secret() {
  local prompt="${1:-Enter secret}"
  if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
    return 0
  fi
  printf '  %s%s%s: ' "$W" "$prompt" "$N" >&2
  local reply=""
  read -rs reply
  printf '\n' >&2
  printf '%s' "$reply"
}

# wizard::pick — single-choice menu. Prints options to stderr, reads selection.
# Echoes the chosen value (not the index) to stdout.
#
# Usage:
#   choice=$(wizard::pick "Choose tier" "light" "standard" "heavy" "custom")
#
# Empty input → first option (the default).
wizard::pick() {
  local prompt="$1"; shift
  local -a options=("$@")
  if [[ ${#options[@]} -eq 0 ]]; then
    return 2
  fi
  if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
    printf '%s' "${options[0]}"
    return 0
  fi
  printf '  %s%s%s\n' "$W" "$prompt" "$N" >&2
  local i=1
  for opt in "${options[@]}"; do
    if [[ $i -eq 1 ]]; then
      printf '    %s%d)%s %s %s(default)%s\n' "$C" "$i" "$N" "$opt" "$D" "$N" >&2
    else
      printf '    %s%d)%s %s\n' "$C" "$i" "$N" "$opt" >&2
    fi
    i=$((i + 1))
  done
  printf '  %sChoice%s [1]: ' "$W" "$N" >&2
  local reply=""
  read -r reply
  reply="${reply:-1}"
  if ! [[ "$reply" =~ ^[0-9]+$ ]] || (( reply < 1 || reply > ${#options[@]} )); then
    reply=1
  fi
  printf '%s' "${options[$((reply - 1))]}"
}
