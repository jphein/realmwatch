#!/usr/bin/env bash
# realm-wizard — homelab AI station bootstrap.
#
# Takes a fresh checkout and gets the operator from "git clone" to a working
# multi-agent multi-provider AI workstation in 10-15 minutes of interactive
# prompts. 9 sections, each opt-out via --skip / --section.
#
# Design spec: scratch/realm-cli-extensions/wizard-design.md
# Research:    scratch/realm-cli-extensions/ai-bundle-research.md
#
# Exit codes:
#   0 = success (all sections completed or skipped cleanly)
#   1 = one or more sections failed
#   2 = usage error

set -euo pipefail

REALM_HELP_SUMMARY="Bootstrap the homelab AI station — interactive 9-section setup"
realm::help() {
  cat <<'EOF'
realm wizard — homelab AI station bootstrap (9 sections)

USAGE:
  realm wizard                          # interactive — runs all sections in order
  realm wizard --section <name>         # run one section
  realm wizard --list-sections          # list sections + completion state
  realm wizard --reset                  # delete state, start fresh
  realm wizard --skip <s1>,<s2>         # skip specific sections
  realm wizard --non-interactive        # no prompts; skip steps that would prompt
  realm wizard --yes                    # auto-confirm all prompts (unattended)
  realm wizard --dry-run                # print what would happen, no changes

SECTIONS:
  1. prereqs          Check python/uv/npm/jq/bw/etc.
  2. realm-setup      .venv, lexicon, fleet.yaml, doctor
  3. terminal         Warp Terminal (open source 2026-04-30)            [opt-in]
  4. local-llms       Ollama + tiered model set                         [opt-in]
  5. cloud-keys       11 providers — Anthropic, OpenRouter, Groq, ...
  6. commercial-cli   Verify claude/gemini/codex/copilot/aider
  7. oss-agents       OpenCode (default), Cline, Goose                  [opt-in]
  8. mcp-wire         Register MCP servers (realmwatch + mempalace +
                      speech-to-cli + cloud-chat-assistant) with each agent
  9. final-card       Next-steps card

STATE:
  ~/.realmwatch/wizard-state.json — completion tracking, re-runnable.

EXAMPLES:
  realm wizard                                  # full interactive run
  realm wizard --section local-llms             # just pull models
  realm wizard --skip terminal,local-llms       # skip opt-ins
  realm wizard --yes                            # unattended, auto-yes everything
  realm wizard --dry-run                        # preview only
EOF
  realm::help_flags
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# --- Resolve repo root ---
_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_self")/../.." && pwd)"

# --- Source wizard-confirm.sh (requires colors which realm-cli.sh already sourced) ---
# shellcheck disable=SC1091
source "$REALM_HOME/scripts/lib/wizard-confirm.sh"

# --- Wizard-level flags (separate namespace from realm:: flags) ---
WIZARD_YES=""
WIZARD_DRY=""
WIZARD_NONINT=""
WIZARD_RESET=""
WIZARD_LIST=""
WIZARD_SECTION=""
WIZARD_SKIP=""

# Pull our own flags out of REALM_POSARGS so they don't pollute downstream
_remaining=()
i=0
args=( "$@" )
while [[ $i -lt ${#args[@]} ]]; do
  arg="${args[$i]}"
  case "$arg" in
    --yes|-y)            WIZARD_YES=1 ;;
    --dry-run)           WIZARD_DRY=1 ;;
    --non-interactive)   WIZARD_NONINT=1 ;;
    --reset)             WIZARD_RESET=1 ;;
    --list-sections)     WIZARD_LIST=1 ;;
    --section)
      # Arity check: --section requires an explicit value; missing one would
      # silently fall back to a full run, which is a footgun. Use EX_USAGE (64).
      if [[ $((i + 1)) -ge ${#args[@]} ]]; then
        realm::die "--section requires a value" 64
      fi
      i=$((i + 1))
      WIZARD_SECTION="${args[$i]}"
      ;;
    --section=*)
      WIZARD_SECTION="${arg#*=}"
      [[ -n "$WIZARD_SECTION" ]] || realm::die "--section requires a value" 64
      ;;
    --skip)
      if [[ $((i + 1)) -ge ${#args[@]} ]]; then
        realm::die "--skip requires a value" 64
      fi
      i=$((i + 1))
      WIZARD_SKIP="${args[$i]}"
      ;;
    --skip=*)
      WIZARD_SKIP="${arg#*=}"
      [[ -n "$WIZARD_SKIP" ]] || realm::die "--skip requires a value" 64
      ;;
    *)                   _remaining+=("$arg") ;;
  esac
  i=$((i + 1))
done
set -- "${_remaining[@]+"${_remaining[@]}"}"

# REALM_DRY_RUN (from common args) also flips wizard dry-run for convenience
[[ -n "${REALM_DRY_RUN:-}" ]] && WIZARD_DRY=1

export WIZARD_YES WIZARD_DRY WIZARD_NONINT

# --- State file (per design spec — ~/.realmwatch/wizard-state.json) ---
# Note: wizard runs as user JP, not sudo — $HOME is safe here.
# (If we ever needed sudo-aware home: source realm_text.real_home() via python.)
WIZARD_STATE_DIR="$HOME/.realmwatch"
WIZARD_STATE_FILE="$WIZARD_STATE_DIR/wizard-state.json"

# All sections in order — the canonical list.
SECTIONS=(
  prereqs
  realm-setup
  terminal
  local-llms
  cloud-keys
  commercial-cli
  oss-agents
  mcp-wire
  final-card
)

SECTION_TITLES=(
  "Prerequisites"
  "Realm Setup"
  "Terminal (Warp)"
  "Local LLMs (Ollama)"
  "Cloud API Keys"
  "Commercial CLIs"
  "OSS Agents"
  "MCP Wire-up"
  "Final Card"
)

# Sections that are OPT-IN (default behavior: ask, default-NO).
# Per constraints in the prompt: 3, 4, 7 are opt-in.
declare -A SECTION_OPTIN=(
  [terminal]=1
  [local-llms]=1
  [oss-agents]=1
)

# ---------- State file helpers ----------

state::ensure_dir() {
  mkdir -p "$WIZARD_STATE_DIR"
}

state::init_if_missing() {
  state::ensure_dir
  if [[ ! -f "$WIZARD_STATE_FILE" ]]; then
    local now
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "$WIZARD_STATE_FILE" <<EOF
{
  "version": 1,
  "completed": [],
  "skipped": [],
  "started_at": "$now",
  "last_run": "$now"
}
EOF
  fi
}

state::reset() {
  if [[ -f "$WIZARD_STATE_FILE" ]]; then
    rm -f "$WIZARD_STATE_FILE"
    realm::status_ok "removed $WIZARD_STATE_FILE"
  else
    realm::status_warn "no state file at $WIZARD_STATE_FILE"
  fi
}

# state::is_completed <section-name>
state::is_completed() {
  [[ -f "$WIZARD_STATE_FILE" ]] || return 1
  jq -e --arg s "$1" '.completed | index($s) != null' "$WIZARD_STATE_FILE" >/dev/null 2>&1
}

# state::is_skipped <section-name>
state::is_skipped() {
  [[ -f "$WIZARD_STATE_FILE" ]] || return 1
  jq -e --arg s "$1" '.skipped | index($s) != null' "$WIZARD_STATE_FILE" >/dev/null 2>&1
}

# state::mark_completed <section-name>
state::mark_completed() {
  [[ -n "$WIZARD_DRY" ]] && return 0
  # If jq is missing, the prereqs section is expected to surface it; do not
  # crash subsequent sections under `set -e` just because state can't be
  # serialized. Warn and continue.
  command -v jq >/dev/null 2>&1 || {
    realm::warn "jq missing; state file not updated"
    return 0
  }
  state::init_if_missing
  local now tmp
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp=$(mktemp)
  jq --arg s "$1" --arg now "$now" '
    .completed = (.completed + [$s] | unique)
    | .skipped = (.skipped - [$s])
    | .last_run = $now
  ' "$WIZARD_STATE_FILE" > "$tmp" && mv "$tmp" "$WIZARD_STATE_FILE"
}

# state::mark_skipped <section-name>
state::mark_skipped() {
  [[ -n "$WIZARD_DRY" ]] && return 0
  command -v jq >/dev/null 2>&1 || {
    realm::warn "jq missing; state file not updated"
    return 0
  }
  state::init_if_missing
  local now tmp
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmp=$(mktemp)
  jq --arg s "$1" --arg now "$now" '
    .skipped = (.skipped + [$s] | unique)
    | .last_run = $now
  ' "$WIZARD_STATE_FILE" > "$tmp" && mv "$tmp" "$WIZARD_STATE_FILE"
}

# ---------- Output helpers ----------

banner() {
  printf '\n'
  printf '%s                              ✦ Realm Awakening ✦%s\n' "$W" "$N"
  printf '%s                  ─────────────────────────────────────────%s\n' "$D" "$N"
  printf '%s                  bootstrapping your homelab AI station%s\n' "$D" "$N"
  printf '\n'
}

section_header() {
  local num="$1" total="$2" title="$3"
  printf '\n'
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C" "$N"
  printf '   %s⚙%s  Section %s of %s — %s%s%s\n' "$W" "$N" "$num" "$total" "$W" "$title" "$N"
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$C" "$N"
}

dry_say() {
  printf '  %s[dry-run]%s would: %s\n' "$D" "$N" "$1"
}

# ---------- list-sections subcommand ----------

list_sections() {
  printf '\n%sWizard sections%s\n' "$W" "$N"
  printf '%s---------------%s\n' "$D" "$N"
  local i=0
  for name in "${SECTIONS[@]}"; do
    local title="${SECTION_TITLES[$i]}"
    local status="pending"
    local marker=" "
    local color="$N"
    if state::is_completed "$name"; then
      status="completed"; marker="✓"; color="$G"
    elif state::is_skipped "$name"; then
      status="skipped";   marker="—"; color="$Y"
    fi
    local optin=""
    [[ -n "${SECTION_OPTIN[$name]:-}" ]] && optin=" $D[opt-in]$N"
    printf '  %s%s%s %s%-18s%s %-22s%b\n' \
      "$color" "$marker" "$N" "$C" "$name" "$N" "$title" "$optin"
    i=$((i + 1))
  done
  printf '\n'
  if [[ -f "$WIZARD_STATE_FILE" ]]; then
    local last
    last=$(jq -r '.last_run // "never"' "$WIZARD_STATE_FILE" 2>/dev/null || echo "never")
    printf '  %sState file:%s %s\n' "$D" "$N" "$WIZARD_STATE_FILE"
    printf '  %sLast run:%s   %s\n' "$D" "$N" "$last"
  else
    printf '  %sState file:%s (none — first run)\n' "$D" "$N"
  fi
}

# =========================================================================
# Section 1 — prereqs
# =========================================================================

check_tool() {
  local name="$1" hint="$2" required="${3:-1}"  # required=1 → FAIL, else WARN
  if command -v "$name" >/dev/null 2>&1; then
    local where
    where=$(command -v "$name")
    realm::status_ok "$name ($(basename "$where"))"
    return 0
  else
    if [[ "$required" -eq 1 ]]; then
      realm::status_fail "$name missing"
      [[ -n "$hint" ]] && printf '      %s%s%s\n' "$D" "$hint" "$N"
      return 1
    else
      realm::status_warn "$name missing (optional)"
      [[ -n "$hint" ]] && printf '      %s%s%s\n' "$D" "$hint" "$N"
      return 0
    fi
  fi
}

check_python_version() {
  if ! command -v python3 >/dev/null 2>&1; then
    realm::status_fail "python3 missing"
    printf '      %sapt install python3.12%s\n' "$D" "$N"
    return 1
  fi
  local ver
  ver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)
  local major minor
  IFS='.' read -r major minor <<< "$ver"
  if [[ "$major" -lt 3 ]] || ([[ "$major" -eq 3 ]] && [[ "$minor" -lt 12 ]]); then
    realm::status_warn "python3 $ver (3.12+ recommended)"
    printf '      %sapt install python3.12%s\n' "$D" "$N"
  else
    realm::status_ok "python3 $ver"
  fi
  return 0
}

section_prereqs() {
  realm::print_section "Checking prerequisites"
  local fails=0
  # Each check_* function may `return 1` on failure. Under `set -e`, a bare
  # call would abort the wizard; aggregate via `|| fails=$((fails+1))`
  # at the call site so the section can summarize ALL missing tools.
  check_python_version || fails=$((fails + 1))
  check_tool uv "curl -LsSf https://astral.sh/uv/install.sh | sh" 1 || fails=$((fails + 1))
  check_tool npm "apt install nodejs npm   (or: mise install node@20)" 1 || fails=$((fails + 1))
  check_tool jq "apt install jq" 1 || fails=$((fails + 1))
  check_tool curl "apt install curl" 1 || fails=$((fails + 1))
  check_tool fping "apt install fping  (optional — latency plugin)" 0
  check_tool ssh "apt install openssh-client" 1 || fails=$((fails + 1))
  check_tool git "apt install git" 1 || fails=$((fails + 1))
  check_tool gh "mise install gh   (or: apt install gh)" 0
  check_tool bw "npm i -g @bitwarden/cli   (needed for cloud-keys section)" 0

  if [[ "$fails" -gt 0 ]]; then
    realm::status_fail "$fails required tool(s) missing — install and re-run"
    return 1
  fi
  realm::status_ok "all required prerequisites present"
  return 0
}

# =========================================================================
# Section 2 — realm-setup
# =========================================================================

section_realm_setup() {
  realm::print_section "Realm setup"

  # 1. venv check
  if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
    local pyver
    pyver=$("$REALM_HOME/.venv/bin/python3" --version 2>&1)
    realm::status_ok ".venv present ($pyver)"
  else
    realm::status_fail ".venv missing"
    printf '      %scd %s && make install%s\n' "$D" "$REALM_HOME" "$N"
    if wizard::confirm "Run 'make install' now?"; then
      if [[ -n "$WIZARD_DRY" ]]; then
        dry_say "cd $REALM_HOME && make install"
      else
        ( cd "$REALM_HOME" && make install ) || {
          realm::status_fail "make install failed"
          return 1
        }
      fi
    else
      realm::status_warn "skipping .venv setup — wizard will continue but other steps may fail"
    fi
  fi

  # 2. lexicon check
  local lexicon_dir="$HOME/Projects/lexicon.realm.watch"
  if [[ -d "$lexicon_dir" ]]; then
    realm::status_ok "lexicon present ($lexicon_dir)"
  else
    realm::status_warn "lexicon missing ($lexicon_dir)"
    printf '      %sgit clone https://github.com/jphein/lexicon.realm.watch %s%s\n' \
      "$D" "$lexicon_dir" "$N"
    if wizard::confirm "Clone lexicon now?"; then
      if [[ -n "$WIZARD_DRY" ]]; then
        dry_say "git clone https://github.com/jphein/lexicon.realm.watch $lexicon_dir"
      else
        if ! git clone https://github.com/jphein/lexicon.realm.watch "$lexicon_dir"; then
          realm::status_fail "lexicon clone failed"
          realm::warn "lexicon clone failed; some features will be unavailable"
          return 1
        fi
      fi
    fi
  fi

  # 3. fleet.yaml check
  if [[ -f "$REALM_HOME/fleet.yaml" ]]; then
    local size
    size=$(wc -c < "$REALM_HOME/fleet.yaml")
    realm::status_ok "fleet.yaml present ($size bytes)"
  elif [[ -f "$REALM_HOME/fleet.example.yaml" ]]; then
    realm::status_warn "fleet.yaml missing (but fleet.example.yaml exists)"
    if wizard::confirm "Copy fleet.example.yaml → fleet.yaml?"; then
      if [[ -n "$WIZARD_DRY" ]]; then
        dry_say "cp fleet.example.yaml fleet.yaml"
      else
        cp "$REALM_HOME/fleet.example.yaml" "$REALM_HOME/fleet.yaml" \
          && realm::status_ok "seeded fleet.yaml from example" \
          || realm::status_fail "copy failed"
      fi
    fi
  else
    realm::status_warn "fleet.yaml and fleet.example.yaml both missing"
    printf '      %sscripts/migrate-fleet.py --apply  (if realm.db has rows)%s\n' "$D" "$N"
  fi

  # 4. realm doctor --quick (best-effort; absence of server is fine)
  if [[ -x "$REALM_HOME/scripts/cli/realm-doctor.sh" ]]; then
    realm::print_section "Quick health check"
    if [[ -n "$WIZARD_DRY" ]]; then
      dry_say "realm doctor --quick"
    else
      # don't fail the wizard if doctor warns; just surface
      "$REALM_HOME/scripts/cli/realm-doctor.sh" --quick 2>&1 | head -50 || true
    fi
  fi

  return 0
}

# =========================================================================
# Section 3 — terminal (Warp)
# =========================================================================

section_terminal() {
  realm::print_section "Warp Terminal (open source 2026-04-30)"

  if command -v warp >/dev/null 2>&1 || command -v warp-terminal >/dev/null 2>&1; then
    realm::status_ok "Warp already installed"
    return 0
  fi

  printf '  %sWarp is a Rust-based terminal with native multi-agent support%s\n' "$D" "$N"
  printf '  %s(Claude Code, Codex, Gemini, OpenCode side-by-side).%s\n' "$D" "$N"

  if ! wizard::confirm "Install Warp via the official APT repo? (requires sudo)"; then
    realm::status_warn "skipped — Warp not installed"
    return 0
  fi

  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "sudo mkdir -p /etc/apt/keyrings"
    dry_say "curl -fsSL https://app.warp.dev/download/linux/deb/keyring.gpg | sudo gpg --dearmor -o /etc/apt/keyrings/warp-keyring.gpg"
    dry_say "echo 'deb [...] https://app.warp.dev/download/linux/deb stable main' | sudo tee /etc/apt/sources.list.d/warp.list"
    dry_say "sudo apt update && sudo apt install warp-terminal"
    return 0
  fi

  # Install per design spec, with verification at run time
  sudo mkdir -p /etc/apt/keyrings || { realm::status_fail "mkdir failed"; return 1; }
  if curl -fsSL https://app.warp.dev/download/linux/deb/keyring.gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/warp-keyring.gpg; then
    realm::status_ok "added Warp signing key"
  else
    realm::status_fail "failed to fetch Warp keyring (URL may have moved — check app.warp.dev)"
    return 1
  fi

  if echo "deb [signed-by=/etc/apt/keyrings/warp-keyring.gpg] https://app.warp.dev/download/linux/deb stable main" \
      | sudo tee /etc/apt/sources.list.d/warp.list >/dev/null; then
    realm::status_ok "added Warp APT source"
  else
    realm::status_fail "failed to write /etc/apt/sources.list.d/warp.list"
    return 1
  fi

  sudo apt update && sudo apt install -y warp-terminal && {
    realm::status_ok "Warp installed"
    printf '  %sTo make Warp your default terminal (manual):%s\n' "$D" "$N"
    printf '      %sxdg-settings set default-terminal warp-terminal%s\n' "$D" "$N"
  } || {
    realm::status_fail "apt install warp-terminal failed"
    return 1
  }

  return 0
}

# =========================================================================
# Section 4 — local-llms (Ollama)
# =========================================================================

section_local_llms() {
  realm::print_section "Local LLMs via Ollama"

  # 1. Install ollama if missing
  if command -v ollama >/dev/null 2>&1; then
    realm::status_ok "ollama already installed ($(ollama --version 2>/dev/null | head -1))"
  else
    if ! wizard::confirm "Install Ollama? (curl | sh from ollama.com)"; then
      realm::status_warn "skipped — Ollama not installed"
      return 0
    fi
    if [[ -n "$WIZARD_DRY" ]]; then
      dry_say "curl -fsSL https://ollama.com/install.sh | sh"
    else
      curl -fsSL https://ollama.com/install.sh | sh \
        && realm::status_ok "Ollama installed" \
        || { realm::status_fail "Ollama install failed"; return 1; }
    fi
  fi

  # 2. Pick tier
  printf '\n  %sChoose a model tier:%s\n' "$W" "$N"
  printf '    %slight%s     — 8 GB RAM ok    (phi:3.8b, qwen3:8b) ~7 GB total\n' "$C" "$N"
  printf '    %sstandard%s  — 16 GB VRAM     (+ gemma4:26b, llama4:scout) ~33 GB\n' "$C" "$N"
  printf '    %sheavy%s     — 24+ GB VRAM    (+ qwen3.6:27b) ~55 GB\n' "$C" "$N"
  printf '    %scustom%s    — pick each model\n' "$C" "$N"
  printf '    %sskip%s      — do not pull anything\n' "$C" "$N"

  local tier
  tier=$(wizard::pick "Tier" "light" "standard" "heavy" "custom" "skip")
  printf '  %sselected:%s %s\n' "$D" "$N" "$tier"

  local -a models=()
  case "$tier" in
    light)
      models=( "phi:3.8b" "qwen3:8b" )
      ;;
    standard)
      models=( "phi:3.8b" "qwen3:8b" "gemma4:26b" "llama4:scout" )
      ;;
    heavy)
      models=( "phi:3.8b" "qwen3:8b" "gemma4:26b" "llama4:scout" "qwen3.6:27b" )
      ;;
    custom)
      local available=( "phi:3.8b" "qwen3:8b" "gemma4:26b" "llama4:scout" "qwen3.6:27b" "deepseek-v4" "kimi-k2.6" )
      for m in "${available[@]}"; do
        if wizard::confirm "Pull $m?"; then
          models+=( "$m" )
        fi
      done
      ;;
    skip)
      realm::status_warn "no models pulled"
      return 0
      ;;
  esac

  # 3. Pull each model
  for model in "${models[@]}"; do
    # Idempotency: check if already pulled
    if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$model"; then
      realm::status_ok "$model already present"
      continue
    fi
    printf '\n  %spulling%s %s ...\n' "$C" "$N" "$model"
    if [[ -n "$WIZARD_DRY" ]]; then
      dry_say "ollama pull $model"
      continue
    fi
    if ollama pull "$model"; then
      realm::status_ok "$model pulled"
    else
      realm::status_warn "$model pull failed (model name may not exist yet — check 'ollama list')"
    fi
  done

  # 4. Verify
  printf '\n'
  realm::print_section "Ollama library"
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "ollama list"
  else
    ollama list 2>/dev/null | head -20 || true
  fi
  return 0
}

# =========================================================================
# Section 5 — cloud-keys
# =========================================================================

# All providers in priority order. Format: env-var|bw-item-name|description
PROVIDERS=(
  "OPENROUTER_API_KEY|OpenRouter API|Universal gateway — 500+ models, OpenAI-compatible"
  "ANTHROPIC_API_KEY|Anthropic API|Claude (best general agent)"
  "OPENAI_API_KEY|OpenAI API|GPT, o-series, Codex CLI"
  "GOOGLE_API_KEY|Google AI API|Gemini (also used by GEMINI_API_KEY)"
  "GROQ_API_KEY|Groq API|Fastest TTFT (~0.7s), LPU"
  "CEREBRAS_API_KEY|Cerebras API|~3000 tok/s throughput champion"
  "TOGETHER_API_KEY|Together.ai API|Open-source hyperscaler"
  "DEEPINFRA_API_KEY|DeepInfra API|Cheap open-source hosting"
  "FIREWORKS_API_KEY|Fireworks API|Open-source hosting"
  "AZURE_AI_API_KEY|Azure AI API|Already used by realmwatch chat/oracle"
  # AWS Bedrock needs the full credential triplet (access-key + secret +
  # region). Grouped here so the cloud-keys walk collects all three before
  # moving on — earlier versions only collected AWS_ACCESS_KEY_ID, leaving
  # the .env incomplete and Bedrock unusable.
  "AWS_ACCESS_KEY_ID|AWS Bedrock Access Key|AWS access key (paired with secret + region below)"
  "AWS_SECRET_ACCESS_KEY|AWS Bedrock Secret Key|AWS secret access key (pairs with AWS_ACCESS_KEY_ID)"
  "AWS_REGION|AWS Bedrock Region|AWS region (e.g. us-west-2). Press Enter for us-west-2 default."
)

# Check if env var already set in .env file
env_has_key() {
  local var="$1"
  [[ -f "$REALM_HOME/.env" ]] || return 1
  grep -q "^${var}=[^[:space:]]" "$REALM_HOME/.env"
}

# Append a key=value line to .env (idempotent — checks first)
env_append() {
  local var="$1" val="$2"
  [[ -n "$WIZARD_DRY" ]] && { dry_say "append $var=*** to .env"; return 0; }
  if env_has_key "$var"; then
    realm::status_warn "$var already in .env — leaving untouched"
    return 0
  fi
  # Ensure trailing newline before append
  if [[ -f "$REALM_HOME/.env" ]] && [[ -s "$REALM_HOME/.env" ]]; then
    tail -c 1 "$REALM_HOME/.env" | od -An -c | grep -q '\\n' || echo "" >> "$REALM_HOME/.env"
  fi
  printf '%s=%s\n' "$var" "$val" >> "$REALM_HOME/.env"
  realm::status_ok "appended $var to .env"
}

section_cloud_keys() {
  realm::print_section "Cloud API keys"
  printf '  %sFor each provider, the wizard:%s\n' "$D" "$N"
  printf '    %s1.%s checks %s.env%s — skips if already set\n' "$D" "$N" "$C" "$N"
  printf '    %s2.%s tries %sbw get password "<provider> API"%s\n' "$D" "$N" "$C" "$N"
  printf '    %s3.%s prompts you (masked input) only if bw fails\n' "$D" "$N"
  printf '    %s4.%s SKIPS the provider on empty input\n' "$D" "$N"
  printf '\n'

  # Check bw status once up front
  local bw_state="missing"
  if command -v bw >/dev/null 2>&1; then
    local code
    set +e
    python3 "$REALM_HOME/scripts/lib/wizard-secrets.py" status >/dev/null 2>&1
    code=$?
    set -e
    case "$code" in
      0) bw_state="unlocked" ;;
      2) bw_state="locked" ;;
      4) bw_state="unauthenticated" ;;
      *) bw_state="error" ;;
    esac
  fi
  case "$bw_state" in
    unlocked)        realm::status_ok "bw vault unlocked" ;;
    locked)
      realm::status_warn "bw vault is LOCKED — secrets won't auto-fetch"
      printf '      %s(launch %sghostty -e bash -c "bw unlock"%s in another window if needed)%s\n' \
        "$D" "$C" "$D" "$N"
      ;;
    unauthenticated) realm::status_warn "bw not logged in — run 'bw login' first" ;;
    missing)         realm::status_warn "bw not installed — keys will require manual entry" ;;
    *)               realm::status_warn "bw status check failed" ;;
  esac

  # Walk providers
  local provider env_var bw_item desc
  for provider in "${PROVIDERS[@]}"; do
    IFS='|' read -r env_var bw_item desc <<< "$provider"
    printf '\n  %s%s%s — %s\n' "$W" "$env_var" "$N" "$desc"

    # 1. Already in .env?
    if env_has_key "$env_var"; then
      realm::status_ok "already in .env"
      continue
    fi

    # 2. Try bw
    local val=""
    if [[ "$bw_state" == "unlocked" ]]; then
      set +e
      val=$(python3 "$REALM_HOME/scripts/lib/wizard-secrets.py" get "$bw_item" 2>/dev/null)
      local bw_code=$?
      set -e
      if [[ "$bw_code" -eq 0 && -n "$val" ]]; then
        if wizard::confirm_yes "Found '$bw_item' in vault. Add to .env?"; then
          env_append "$env_var" "$val"
        else
          realm::status_warn "skipped on user request"
        fi
        continue
      fi
    fi

    # 3. Prompt user (masked)
    if [[ -n "$WIZARD_NONINT" || -n "$WIZARD_DRY" ]]; then
      # Non-interactive mode: skip unless we have a sensible default.
      # AWS_REGION is the one exception — JP's homelab is California, so
      # us-west-2 is a reasonable unattended default.
      if [[ "$env_var" == "AWS_REGION" ]]; then
        env_append "$env_var" "us-west-2"
      else
        realm::status_warn "no value found, skipping (non-interactive)"
      fi
      continue
    fi
    # AWS_REGION is not a secret — prompt unmasked with a default.
    if [[ "$env_var" == "AWS_REGION" ]]; then
      printf '      %s(not in vault — press Enter for us-west-2 default)%s\n' "$D" "$N"
      printf '  Enter %s [us-west-2]: ' "$env_var"
      read -r val || val=""
      val="${val:-us-west-2}"
    else
      printf '      %s(not in vault — paste key or press Enter to skip)%s\n' "$D" "$N"
      val=$(wizard::prompt_secret "  Enter $env_var")
    fi
    if [[ -z "$val" ]]; then
      realm::status_warn "skipped — empty input"
      continue
    fi
    env_append "$env_var" "$val"
  done

  return 0
}

# =========================================================================
# Section 6 — commercial-cli
# =========================================================================

# Per the prompt: VERIFY they're installed + on PATH; offer to update if stale.
# No-op for already-installed tools (which is the common case).
section_commercial_cli() {
  realm::print_section "Commercial AI CLIs"

  # Tool name | install-hint (if missing)
  local -a tools=(
    "claude|Claude Code CLI — see https://docs.anthropic.com/claude-code"
    "copilot|GitHub Copilot CLI — gh extension install github/gh-copilot"
    "gemini|Gemini CLI — npm i -g @google/gemini-cli (or via mise)"
    "codex|OpenAI Codex CLI — npm i -g @openai/codex (or via mise)"
    "aider|Aider — pipx install aider-chat"
  )

  for entry in "${tools[@]}"; do
    local tool hint
    IFS='|' read -r tool hint <<< "$entry"

    # GitHub Copilot CLI ships as a `gh` extension (`gh copilot ...`), NOT a
    # standalone `copilot` binary. The earlier `command -v copilot` check
    # always failed even on systems where the extension was installed, so
    # the wizard kept suggesting an install that wasn't needed. Detect both
    # forms and fall through to "not installed" only when neither is found.
    if [[ "$tool" == "copilot" ]]; then
      if command -v gh >/dev/null 2>&1 \
          && gh extension list 2>/dev/null | grep -q 'github/gh-copilot'; then
        local ver
        ver=$(timeout 3 gh copilot --version 2>/dev/null | head -1 || echo "gh extension")
        realm::status_ok "gh copilot extension installed — $ver"
      elif command -v copilot >/dev/null 2>&1; then
        local ver
        ver=$(timeout 3 copilot --version 2>/dev/null | head -1 || echo "version unknown")
        realm::status_ok "copilot binary (standalone) installed — $ver"
      else
        realm::status_warn "copilot CLI not installed"
        printf '      %sinstall hint: gh extension install github/gh-copilot%s\n' "$D" "$N"
      fi
      continue
    fi

    if command -v "$tool" >/dev/null 2>&1; then
      local ver
      ver=$(timeout 3 "$tool" --version 2>/dev/null | head -1 || echo "version unknown")
      realm::status_ok "$tool — $ver"
    else
      realm::status_warn "$tool not installed"
      printf '      %s%s%s\n' "$D" "$hint" "$N"
    fi
  done

  printf '\n  %s(self-updating tools refresh on their own. No actions taken.)%s\n' "$D" "$N"
  return 0
}

# =========================================================================
# Section 7 — oss-agents
# =========================================================================

# Each: name | install-cmd | check-cmd
# install-cmd is a single shell string passed to `bash -c` after confirm.
install_opencode() {
  if command -v opencode >/dev/null 2>&1; then
    realm::status_ok "OpenCode already installed ($(opencode --version 2>/dev/null | head -1))"
    return 0
  fi
  if ! wizard::confirm "Install OpenCode? (curl | bash from opencode.ai)"; then
    realm::status_warn "skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "curl -fsSL https://opencode.ai/install | bash"
    return 0
  fi
  curl -fsSL https://opencode.ai/install | bash \
    && realm::status_ok "OpenCode installed" \
    || realm::status_fail "OpenCode install failed"
}

install_cline() {
  if command -v cline >/dev/null 2>&1; then
    realm::status_ok "Cline already installed"
    return 0
  fi
  if ! wizard::confirm "Install Cline? (npm i -g cline)"; then
    realm::status_warn "skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "npm i -g cline"
    return 0
  fi
  npm i -g cline \
    && realm::status_ok "Cline installed" \
    || realm::status_fail "Cline install failed"
}

install_goose() {
  if command -v goose >/dev/null 2>&1; then
    realm::status_ok "Goose already installed"
    return 0
  fi
  if ! wizard::confirm "Install Block Goose? (uses official installer)"; then
    realm::status_warn "skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash"
    return 0
  fi
  # Block's official one-liner. URL may change; this is best-effort.
  if curl -fsSL https://github.com/block/goose/releases/latest/download/download_cli.sh | bash; then
    realm::status_ok "Goose installed"
    return 0
  fi
  # User opted-in but install failed. Don't silently mark the section
  # completed — surface the failure so it shows up as a problem.
  realm::status_warn "Goose install failed — check https://block.github.io/goose"
  if [[ -n "$WIZARD_YES" || -n "$WIZARD_NONINT" ]]; then
    # Unattended: propagate failure
    return 1
  fi
  # Interactive: ask whether to soldier on or report failure
  if wizard::confirm "Goose install failed. Continue with section anyway?"; then
    return 0
  fi
  return 1
}

section_oss_agents() {
  realm::print_section "OSS AI agents"
  local rc=0
  install_opencode || rc=1
  install_cline    || rc=1
  install_goose    || rc=1
  return "$rc"
}

# =========================================================================
# Section 8 — mcp-wire
# =========================================================================
#
# Registers the full set of MCP servers in JP's homelab with every
# installed AI agent. The registry is the source of truth — add a row to
# MCP_REGISTRY and the wizard will offer it to every agent.
#
# Excluded from registry (with reason):
#   familiar     — HTTP-only MCP at familiar.jphe.in/mcp; no stdio launcher
#                  exists. Wire manually when an agent supports HTTP MCP.
#   gnome-speaks — GNOME shell extension + D-Bus service; not an MCP
#                  server.
#   palace-daemon — Backend for the mempalace dispatcher; not exposed as
#                  its own MCP server.
#
# Registry format: each row is "name|command|args" — `args` is a
# space-joined argv (may include the launcher script path).

MCP_LAUNCHER="$REALM_HOME/plugins/mcp/launcher.py"
MCP_PYTHON="$REALM_HOME/.venv/bin/python3"

# REAL_HOME / DISKS_HOST — resolved lazily by mcp_registry::build via the
# realmwatch python (so we respect realm_text.real_home() and
# realm_fleet.host_ip() per styleguide). Falls back to $HOME / "disks" if
# the helper isn't usable on this host.
REAL_HOME=""
DISKS_HOST=""

_mcp_resolve_helpers() {
  # Source realm-python.sh once (idempotent). It sets $REALM_PYTHON.
  if [[ -z "${REALM_PYTHON:-}" ]]; then
    # shellcheck disable=SC1091
    source "$REALM_HOME/scripts/lib/realm-python.sh" 2>/dev/null || true
  fi

  # Try the venv python first; fall back to system python3.
  local py="${REALM_PYTHON:-python3}"

  REAL_HOME="$("$py" -c "
import sys
sys.path.insert(0, '$REALM_HOME')
try:
    from realm_text import real_home
    print(real_home())
except Exception:
    import os; print(os.path.expanduser('~'))
" 2>/dev/null)"
  [[ -n "$REAL_HOME" ]] || REAL_HOME="$HOME"

  DISKS_HOST="$("$py" -c "
import sys
sys.path.insert(0, '$REALM_HOME')
try:
    import realm_fleet
    print(realm_fleet.host_ip('disks') or 'disks')
except Exception:
    print('disks')
" 2>/dev/null)"
  [[ -n "$DISKS_HOST" ]] || DISKS_HOST="disks"
}

# mcp_registry::build — populate MCP_REGISTRY based on what's installable
# on this host. Called once at the top of section_mcp_wire after the
# realmwatch-specific defaults are resolved.
declare -a MCP_REGISTRY=()
mcp_registry::build() {
  MCP_REGISTRY=()
  _mcp_resolve_helpers

  # realmwatch — local repo, FastMCP stdio.
  if [[ -f "$MCP_LAUNCHER" ]]; then
    MCP_REGISTRY+=( "realmwatch|$MCP_PYTHON|$MCP_LAUNCHER" )
  fi

  # mempalace — dispatcher form (proxies to palace-daemon at disks:8085).
  # Launcher: memorypalace's plugin venv python + palace-daemon's
  # mempalace-mcp.py client. We don't probe disks:8085 here — the wizard
  # registers the launcher and `claude mcp list` will surface connect
  # failures at runtime (graceful no-op per spec).
  local mempal_py="$REAL_HOME/Projects/memorypalace/.claude-plugin/venv/bin/python"
  local mempal_client="$REAL_HOME/Projects/palace-daemon/clients/mempalace-mcp.py"
  if [[ -x "$mempal_py" && -f "$mempal_client" ]]; then
    MCP_REGISTRY+=( "mempalace|$mempal_py|$mempal_client --daemon http://${DISKS_HOST}:8085" )
  fi

  # speech-to-cli — single-file python MCP, no venv needed.
  local speech_script="$REAL_HOME/Projects/speech-to-cli/mcp_speech.py"
  if [[ -f "$speech_script" ]]; then
    MCP_REGISTRY+=( "speech-to-cli|python3|$speech_script" )
  fi

  # cloud-chat-assistant — needs its own venv.
  local cca_py="$REAL_HOME/Projects/cloud-chat-assistant/venv/bin/python3"
  local cca_script="$REAL_HOME/Projects/cloud-chat-assistant/mcp_cloud_chat.py"
  if [[ -x "$cca_py" && -f "$cca_script" ]]; then
    MCP_REGISTRY+=( "cloud-chat-assistant|$cca_py|$cca_script" )
  fi
}

# mcp_registry::parse <row> → sets MCP_NAME / MCP_CMD / MCP_ARGS (array).
# MCP_ARGS is the canonical argv form used by every wire_<agent>_one
# helper (no further word-splitting needed downstream). Registry rows are
# authored in this file, so the space-joined source is safe to split here.
# Returns 0 on success.
MCP_NAME=""
MCP_CMD=""
declare -a MCP_ARGS=()
mcp_registry::parse() {
  local row="$1"
  MCP_NAME="${row%%|*}"
  local rest="${row#*|}"
  MCP_CMD="${rest%%|*}"
  local args_str="${rest#*|}"
  # shellcheck disable=SC2206  # intentional word-split for argv
  MCP_ARGS=( $args_str )
}

# mcp_registry::backup_config <path> — copy to <path>.bak-YYYYMMDDHHMMSS-NNN.
# Seconds-resolution would collide when this is called several times in the
# same second (every server × every agent does its own backup); appending
# nanoseconds + $RANDOM keeps each restore point unique. No-op if the file
# does not exist or we're in dry-run.
mcp_registry::backup_config() {
  local cfg="$1"
  [[ -f "$cfg" ]] || return 0
  local stamp
  stamp="$(date +%Y%m%d%H%M%S)-$(date +%N 2>/dev/null || echo 000000000)-${RANDOM}"
  [[ -n "$WIZARD_DRY" ]] && { dry_say "backup $cfg → $cfg.bak-$stamp"; return 0; }
  cp -p "$cfg" "$cfg.bak-$stamp"
}

# ---------- Per-agent wire helpers ----------
#
# Each helper takes: <name> <command> <args-string>
# Returns 0 on success or graceful skip (already-wired counts as success).

wire_claude_one() {
  # NOTE: reads global MCP_NAME / MCP_CMD / MCP_ARGS (populated by
  # mcp_registry::parse). The array form avoids word-splitting hazards
  # if any argv ever grows a space (gemini styleguide).
  local name="$MCP_NAME" cmd="$MCP_CMD"
  # idempotency: claude mcp list reports current name set.
  if claude mcp list 2>/dev/null | grep -qE "^${name}: "; then
    realm::status_ok "claude: $name already wired"
    return 0
  fi
  if ! wizard::confirm_yes "wire $name into Claude Code?"; then
    realm::status_warn "claude: $name skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "claude mcp add $name -- $cmd ${MCP_ARGS[*]+${MCP_ARGS[*]}}"
    return 0
  fi
  # `claude mcp add <name> -- <cmd> <args...>` — the `--` separator stops
  # claude from interpreting launcher args as flags to itself.
  if claude mcp add "$name" -- "$cmd" "${MCP_ARGS[@]+"${MCP_ARGS[@]}"}" 2>&1 | head -3; then
    realm::status_ok "claude: $name wired"
  else
    realm::status_warn "claude: $name — mcp add returned non-zero (may already be registered)"
  fi
}

# _jq_write_merge <cfg> <root-key> <name> <cmd> <args-json-array>
# Generic jq-merge for JSON configs that use {<root-key>: {<name>: {command, args}}}.
_jq_write_merge() {
  local cfg="$1" root="$2" name="$3" cmd="$4" args_json="$5"
  mkdir -p "$(dirname "$cfg")"
  local tmp
  tmp=$(mktemp)
  if [[ -f "$cfg" ]]; then
    jq --arg r "$root" --arg n "$name" --arg c "$cmd" --argjson a "$args_json" '
      .[$r] = (.[$r] // {}) |
      .[$r][$n] = {command: $c, args: $a}
    ' "$cfg" > "$tmp" 2>/dev/null || jq -n --arg r "$root" --arg n "$name" --arg c "$cmd" --argjson a "$args_json" '
      {($r): {($n): {command: $c, args: $a}}}
    ' > "$tmp"
  else
    jq -n --arg r "$root" --arg n "$name" --arg c "$cmd" --argjson a "$args_json" '
      {($r): {($n): {command: $c, args: $a}}}
    ' > "$tmp"
  fi
  mv "$tmp" "$cfg"
}

# _config_has_name <cfg> <root-key> <name> — 0 if already present.
_config_has_name() {
  local cfg="$1" root="$2" name="$3"
  [[ -f "$cfg" ]] || return 1
  jq -e --arg r "$root" --arg n "$name" '.[$r][$n] // empty' "$cfg" >/dev/null 2>&1
}

wire_opencode_one() {
  local name="$MCP_NAME" cmd="$MCP_CMD"
  local cfg="$REAL_HOME/.opencode/config.json"

  # Backward-compat: previous wizard versions wrote the realmwatch server
  # under the bare key `mcp_servers.realm` (not `mcp_servers.realmwatch`).
  # Existing user configs in the wild use that. Preserve the legacy key for
  # realmwatch only; every other server uses its own name canonically.
  local config_key="$name"
  if [[ "$name" == "realmwatch" ]]; then
    config_key="realm"
  fi

  # Idempotency: treat either the legacy or canonical key as "already wired"
  # so we don't double-register on re-run.
  if _config_has_name "$cfg" "mcp_servers" "$config_key"; then
    realm::status_ok "opencode: $name already wired (key: $config_key)"
    return 0
  fi
  if [[ "$name" == "realmwatch" ]] && _config_has_name "$cfg" "mcp_servers" "realmwatch"; then
    realm::status_ok "opencode: $name already wired"
    return 0
  fi
  if ! wizard::confirm_yes "wire $name into OpenCode?"; then
    realm::status_warn "opencode: $name skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "merge $name into $cfg (key: $config_key)"
    return 0
  fi
  mcp_registry::backup_config "$cfg"
  # jq --args + $ARGS.positional preserves argv with embedded whitespace.
  local args_json
  args_json=$(jq -nc '$ARGS.positional' --args "${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")
  _jq_write_merge "$cfg" "mcp_servers" "$config_key" "$cmd" "$args_json"
  realm::status_ok "opencode: $name wired (key: $config_key)"
}

wire_cline_one() {
  local name="$MCP_NAME" cmd="$MCP_CMD"
  local cfg="$REAL_HOME/.cline/mcp.json"
  if _config_has_name "$cfg" "mcpServers" "$name"; then
    realm::status_ok "cline: $name already wired"
    return 0
  fi
  if ! wizard::confirm_yes "wire $name into Cline?"; then
    realm::status_warn "cline: $name skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "merge $name into $cfg"
    return 0
  fi
  mcp_registry::backup_config "$cfg"
  local args_json
  args_json=$(jq -nc '$ARGS.positional' --args "${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")
  _jq_write_merge "$cfg" "mcpServers" "$name" "$cmd" "$args_json"
  realm::status_ok "cline: $name wired"
}

wire_gemini_one() {
  local name="$MCP_NAME" cmd="$MCP_CMD"
  # Gemini CLI uses ~/.gemini/settings.json (single file holds account,
  # model, and mcpServers). Verified live on this workstation.
  local cfg="$REAL_HOME/.gemini/settings.json"
  if _config_has_name "$cfg" "mcpServers" "$name"; then
    realm::status_ok "gemini: $name already wired"
    return 0
  fi
  if ! wizard::confirm_yes "wire $name into Gemini CLI?"; then
    realm::status_warn "gemini: $name skipped"
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "merge $name into $cfg"
    return 0
  fi
  mcp_registry::backup_config "$cfg"
  local args_json
  args_json=$(jq -nc '$ARGS.positional' --args "${MCP_ARGS[@]+"${MCP_ARGS[@]}"}")
  _jq_write_merge "$cfg" "mcpServers" "$name" "$cmd" "$args_json"
  realm::status_ok "gemini: $name wired"
}

wire_goose_one() {
  local name="$MCP_NAME" cmd="$MCP_CMD"
  # Goose YAML — print hint only (schema varies by version and we don't
  # want to risk corrupting a YAML config with bash text munging).
  if ! wizard::confirm_yes "print Goose hint for $name? (manual YAML edit)"; then
    realm::status_warn "goose: $name skipped"
    return 0
  fi
  local cfg="$REAL_HOME/.config/goose/config.yaml"
  printf '  %sAdd to %s:%s\n' "$D" "$cfg" "$N"
  printf '    extensions:\n'
  printf '      %s:\n' "$name"
  printf '        type: stdio\n'
  printf '        cmd: %s\n' "$cmd"
  if [[ ${#MCP_ARGS[@]} -gt 0 ]]; then
    printf '        args:\n'
    local a
    for a in "${MCP_ARGS[@]}"; do
      printf '          - %s\n' "$a"
    done
  fi
  realm::status_ok "goose: $name hint printed"
}

wire_codex_one() {
  local name="$MCP_NAME" cmd="$MCP_CMD"
  # Codex TOML — print hint only. Bash should not edit TOML structure.
  if ! wizard::confirm_yes "print Codex hint for $name? (manual TOML edit)"; then
    realm::status_warn "codex: $name skipped"
    return 0
  fi
  local cfg="$REAL_HOME/.codex/config.toml"
  printf '  %sAdd to %s:%s\n' "$D" "$cfg" "$N"
  printf '    [mcp_servers.%s]\n' "$name"
  printf '    command = "%s"\n' "$cmd"
  if [[ ${#MCP_ARGS[@]} -gt 0 ]]; then
    # jq emits a valid JSON array literal — same syntax as TOML for
    # string arrays — straight from the argv array (handles whitespace).
    printf '    args = %s\n' "$(jq -nc '$ARGS.positional' --args "${MCP_ARGS[@]}")"
  fi
  realm::status_ok "codex: $name hint printed"
}

# mcp_registry::smoke_test — run `claude mcp list` if available and
# print which registry names connected. Non-fatal.
mcp_registry::smoke_test() {
  if ! command -v claude >/dev/null 2>&1; then
    return 0
  fi
  if [[ -n "$WIZARD_DRY" ]]; then
    dry_say "smoke-test: claude mcp list (would verify registry names connect)"
    return 0
  fi
  printf '\n  %sSmoke test — claude mcp list:%s\n' "$D" "$N"
  local out
  out=$(claude mcp list 2>&1 || true)
  local row name
  for row in "${MCP_REGISTRY[@]}"; do
    name="${row%%|*}"
    if echo "$out" | grep -qE "^${name}: .* ✓ Connected"; then
      realm::status_ok "claude reports: $name connected"
    elif echo "$out" | grep -qE "^${name}: "; then
      realm::status_warn "claude reports: $name registered but not connected"
    else
      realm::status_warn "claude reports: $name not present"
    fi
  done
}

section_mcp_wire() {
  realm::print_section "Wire MCP servers"

  # Hard dep: every JSON-config wirer (opencode/cline/gemini) uses jq for
  # the merge, and codex's TOML hint uses it for the args literal. Fail
  # fast with a clear pointer rather than letting `set -e` kill us mid-loop
  # if the user skipped prereqs.
  command -v jq >/dev/null 2>&1 || \
    realm::die "jq required for mcp-wire (run: realm wizard --section prereqs)" 2

  # Resolve realmwatch defaults first (other registry entries are
  # workstation-wide, but realmwatch is local-repo-relative).
  if [[ ! -f "$MCP_LAUNCHER" ]]; then
    realm::status_fail "realmwatch MCP launcher not found at $MCP_LAUNCHER"
    return 1
  fi
  if [[ ! -x "$MCP_PYTHON" ]]; then
    realm::status_warn "$MCP_PYTHON not found — using system python3 for realmwatch"
    MCP_PYTHON="$(command -v python3 || echo python3)"
  fi

  mcp_registry::build

  if [[ ${#MCP_REGISTRY[@]} -eq 0 ]]; then
    realm::status_fail "MCP registry is empty — nothing to wire"
    return 1
  fi

  realm::status_ok "MCP registry has ${#MCP_REGISTRY[@]} server(s):"
  local row name
  for row in "${MCP_REGISTRY[@]}"; do
    name="${row%%|*}"
    printf '    %s•%s %s\n' "$C" "$N" "$name"
  done
  printf '\n'

  # Per-agent installed detection — only loop the agents that exist.
  local -a AGENTS=()
  command -v claude   >/dev/null 2>&1 && AGENTS+=( claude )
  command -v opencode >/dev/null 2>&1 && AGENTS+=( opencode )
  command -v cline    >/dev/null 2>&1 && AGENTS+=( cline )
  command -v goose    >/dev/null 2>&1 && AGENTS+=( goose )
  command -v gemini   >/dev/null 2>&1 && AGENTS+=( gemini )
  command -v codex    >/dev/null 2>&1 && AGENTS+=( codex )

  if [[ ${#AGENTS[@]} -eq 0 ]]; then
    realm::status_warn "no AI agent CLIs detected — skipping mcp-wire"
    return 0
  fi

  realm::status_ok "agents present: ${AGENTS[*]}"
  printf '\n'

  # (agent × server) loop. Each pair is independently confirmable so the
  # operator can pick exactly which MCP servers go into which agent.
  # mcp_registry::parse populates the globals MCP_NAME / MCP_CMD / MCP_ARGS
  # that each wire_<agent>_one helper reads. Passing argv as a space-joined
  # string and re-splitting it would lose any embedded whitespace.
  local agent
  for agent in "${AGENTS[@]}"; do
    printf '\n  %s── %s ──%s\n' "$D" "$agent" "$N"
    for row in "${MCP_REGISTRY[@]}"; do
      mcp_registry::parse "$row"
      case "$agent" in
        claude)   wire_claude_one   ;;
        opencode) wire_opencode_one ;;
        cline)    wire_cline_one    ;;
        goose)    wire_goose_one    ;;
        gemini)   wire_gemini_one   ;;
        codex)    wire_codex_one    ;;
      esac
    done
  done

  mcp_registry::smoke_test

  return 0
}

# =========================================================================
# Section 9 — final-card
# =========================================================================

section_final_card() {
  printf '\n'
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$G" "$N"
  printf '   %s✦ Awakening Complete ✦%s\n' "$W" "$N"
  printf '%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' "$G" "$N"
  printf '\n'
  printf '  %sYour realm is ready. Try these:%s\n' "$W" "$N"
  printf '\n'
  printf '    %srealm brief%s              # what'\''s happening right now\n' "$C" "$N"
  printf '    %srealm doctor%s             # comprehensive health check\n' "$C" "$N"
  printf '    %srealm show katana%s        # everything about one host\n' "$C" "$N"
  printf '    %srealm fleet list%s         # the curated hosts\n' "$C" "$N"
  printf '    %srealm find <query>%s       # fuzzy search across the realm\n' "$C" "$N"
  printf '\n'
  printf '  %sWeb map:%s        http://localhost/realm-map.html\n' "$D" "$N"
  printf '  %sWizard state:%s   %s\n' "$D" "$N" "$WIZARD_STATE_FILE"
  printf '  %sRe-run section:%s realm wizard --section <name>\n' "$D" "$N"
  printf '\n'
  printf '  %sConnected MCP servers for AI agents:%s\n' "$D" "$N"
  if [[ ${#MCP_REGISTRY[@]} -gt 0 ]]; then
    local row name
    for row in "${MCP_REGISTRY[@]}"; do
      name="${row%%|*}"
      printf '    %s•%s %s\n' "$C" "$N" "$name"
    done
  else
    printf '    %s%s%s\n' "$C" "$MCP_LAUNCHER" "$N"
  fi
  printf '\n'
  return 0
}

# =========================================================================
# Dispatcher
# =========================================================================

# section_dispatch <name> — run the function for a single section.
section_dispatch() {
  local name="$1"
  case "$name" in
    prereqs)         section_prereqs ;;
    realm-setup)     section_realm_setup ;;
    terminal)        section_terminal ;;
    local-llms)      section_local_llms ;;
    cloud-keys)      section_cloud_keys ;;
    commercial-cli)  section_commercial_cli ;;
    oss-agents)      section_oss_agents ;;
    mcp-wire)        section_mcp_wire ;;
    final-card)      section_final_card ;;
    *)               realm::die "unknown section: $name" 2 ;;
  esac
}

# section_index_of <name> — echo 1-based index or empty.
section_index_of() {
  local name="$1" i=0
  for s in "${SECTIONS[@]}"; do
    i=$((i + 1))
    [[ "$s" == "$name" ]] && { echo "$i"; return; }
  done
  return 1
}

# in_skip_list <name>
in_skip_list() {
  [[ -z "$WIZARD_SKIP" ]] && return 1
  IFS=',' read -ra parts <<< "$WIZARD_SKIP"
  for p in "${parts[@]}"; do
    [[ "$p" == "$1" ]] && return 0
  done
  return 1
}

# run_section_with_chrome <name> — emits header, dispatches, marks state.
run_section_with_chrome() {
  local name="$1"
  local idx
  idx=$(section_index_of "$name")
  local title="${SECTION_TITLES[$((idx - 1))]}"
  section_header "$idx" "${#SECTIONS[@]}" "$title"

  # Skip list?
  if in_skip_list "$name"; then
    realm::status_warn "skipped via --skip"
    state::mark_skipped "$name"
    return 0
  fi

  # Already completed?
  if state::is_completed "$name"; then
    realm::status_ok "already completed — re-run with: realm wizard --section $name"
    if ! wizard::confirm "Re-run this section anyway?"; then
      return 0
    fi
  fi

  # Opt-in default-NO gating
  if [[ -n "${SECTION_OPTIN[$name]:-}" ]]; then
    if ! wizard::confirm "This section is opt-in. Run it?"; then
      realm::status_warn "skipped (opt-in default-no)"
      state::mark_skipped "$name"
      return 0
    fi
  fi

  # Dispatch the section
  local rc=0
  section_dispatch "$name" || rc=$?

  if [[ "$rc" -eq 0 ]]; then
    state::mark_completed "$name"
    return 0
  else
    realm::status_fail "section '$name' returned non-zero ($rc)"
    return "$rc"
  fi
}

# =========================================================================
# Main entry
# =========================================================================

# Handle one-shot flags first
if [[ -n "$WIZARD_RESET" ]]; then
  state::reset
  exit 0
fi

if [[ -n "$WIZARD_LIST" ]]; then
  list_sections
  exit 0
fi

state::init_if_missing

# Single-section mode
if [[ -n "$WIZARD_SECTION" ]]; then
  if ! section_index_of "$WIZARD_SECTION" >/dev/null; then
    realm::die "unknown section: $WIZARD_SECTION (try --list-sections)" 2
  fi
  banner
  run_section_with_chrome "$WIZARD_SECTION"
  exit $?
fi

# Full run
banner
overall_rc=0
for s in "${SECTIONS[@]}"; do
  if ! run_section_with_chrome "$s"; then
    overall_rc=1
    # final-card is purely cosmetic; don't bail on its failure
    if [[ "$s" != "final-card" ]]; then
      realm::warn "section '$s' failed — continuing to next"
    fi
  fi
done

exit "$overall_rc"
