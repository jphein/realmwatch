#!/usr/bin/env bash
# realm-update-all — keep katana itself AND every Ubuntu host in the realm
# up to date. Two-stage default: dry-run first, then live if dry-run clean.
#
# Composes three plugins:
#   - system-updates  (local box: apt/snap/flatpak/mise/brew/...)
#   - ansible         (every other Ubuntu host via update-ubuntu.yml)
#   - events / alerting (posts realm events; alerting routes to channels)
#
# Designed to be invoked unattended (systemd timer) but useful interactively.
#
# Flags:
#   --skip-local     Skip system-updates on this box
#   --skip-fleet     Skip ansible-update on remote Ubuntu hosts
#   --no-check       Skip the dry-run stage; go straight to live
#   --local-source S Only run this source for the local box (default: apt)
#                    Use 'all' to run every source.
#   --json           Machine output (final summary as JSON)
#
# Exit codes: 0 ok, 5 a phase failed, 2 usage error.
#
# Note: NEVER auto-reboots. If any host reports reboot-required, that fact is
# included in the event and the summary — reboot is JP's call.

set -euo pipefail

REALM_HELP_SUMMARY="Two-stage update: katana (system-updates) + Ubuntu fleet (ansible)"

realm::help() {
  cat <<'EOF'
realm update-all — orchestrate updates across katana + the Ubuntu fleet

USAGE:
  realm update-all [OPTIONS]

OPTIONS:
  --skip-local         Don't run system-updates on this box
  --skip-fleet         Don't run ansible-update on remote hosts
  --no-check           Skip the dry-run stage; go straight to live
  --local-source S     For local box, only run this source (default: apt).
                       Use 'all' for every source.
  --json               Print the final summary as JSON

FLOW (default):
  1. realm system-updates check                  (refresh local index)
  2. realm system-updates run-one apt            (local box, safe sources)
  3. realm ansible-update --check                (dry-run on Ubuntu fleet)
  4. realm ansible-update                        (live, only if step 3 ok)
  5. realm event post system-updates "Daily run complete: ..."
     (alerting plugin routes it via configured rules + channels)

NEVER reboots automatically. Reboot-required hosts are listed in the summary.

EXAMPLES:
  realm update-all                    # full default flow
  realm update-all --skip-local       # fleet only (safe from realm host)
  realm update-all --local-source all # run every local source
  realm update-all --no-check         # skip dry-run; live immediately
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

SKIP_LOCAL=""
SKIP_FLEET=""
NO_CHECK=""
LOCAL_SOURCE="apt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-local)    SKIP_LOCAL=1; shift ;;
    --skip-fleet)    SKIP_FLEET=1; shift ;;
    --no-check)      NO_CHECK=1; shift ;;
    --local-source)  LOCAL_SOURCE="$2"; shift 2 ;;
    --local-source=*) LOCAL_SOURCE="${1#*=}"; shift ;;
    *) realm::die "unknown arg: $1" 2 ;;
  esac
done

realm::api_reachable || realm::die_unreachable

# Where `realm` itself lives — we exec the dispatcher rather than per-subcommand
# scripts so future re-wiring (Method A → Method B etc.) flows through one entry.
realm_bin="$(command -v realm 2>/dev/null || echo "$(dirname "${BASH_SOURCE[0]}")/../realm")"

# Summary state — we collect per-phase results then emit one final event and
# (optionally) a JSON summary at the end.
declare -A PHASE_STATUS=()
declare -A PHASE_DETAIL=()
overall_ok=1

_record() {
  local phase="$1"; local status="$2"; local detail="$3"
  PHASE_STATUS["$phase"]="$status"
  PHASE_DETAIL["$phase"]="$detail"
  # Wrap in an if-block so a "ok" status (test returns false) doesn't make
  # this function return non-zero — `set -e` would otherwise kill the caller.
  if [[ "$status" != "ok" ]]; then
    overall_ok=0
  fi
}

_post_event() {
  local subtype="$1"; local text="$2"; local color="${3:-cyan}"
  local body
  body=$(jq -n --arg t "$text" --arg st "$subtype" --arg c "$color" \
    '{type:"system-updates", subtype:$st, text:$t, color:$c}')
  # Best-effort: don't fail the orchestrator if the event POST flakes
  curl --silent --max-time 5 -X POST \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "${REALM_API}/event" >/dev/null 2>&1 || true
}

started=$(date +%s)
realm::print_section "realm update-all — started $(date +'%Y-%m-%d %H:%M:%S')"
_post_event run_started "Daily realm update started" "cyan"

# ─── Phase 1: local box (system-updates) ─────────────────────────────────
if [[ -z "$SKIP_LOCAL" ]]; then
  realm::print_section "[1/4] Local box: refreshing source index"
  if "$realm_bin" system-updates check >/dev/null 2>&1; then
    realm::status_ok "check"
  else
    realm::status_warn "check returned non-zero (continuing)"
  fi

  realm::print_section "[2/4] Local box: running updates ($LOCAL_SOURCE)"
  if [[ "$LOCAL_SOURCE" = "all" ]]; then
    if "$realm_bin" system-updates run; then
      _record local ok "all sources"
      realm::status_ok "run all"
    else
      _record local failed "run all returned non-zero"
      realm::status_fail "run all"
    fi
  else
    if "$realm_bin" system-updates run-one "$LOCAL_SOURCE"; then
      _record local ok "$LOCAL_SOURCE"
      realm::status_ok "run-one $LOCAL_SOURCE"
    else
      _record local failed "run-one $LOCAL_SOURCE returned non-zero"
      realm::status_fail "run-one $LOCAL_SOURCE"
    fi
  fi
else
  realm::print_section "[1-2/4] Local box: SKIPPED (--skip-local)"
fi

# ─── Phase 3: fleet dry-run (ansible-update --check) ─────────────────────
if [[ -z "$SKIP_FLEET" ]]; then
  if [[ -z "$NO_CHECK" ]]; then
    realm::print_section "[3/4] Fleet: dry-run (ansible --check)"
    if "$realm_bin" ansible-update --check; then
      _record fleet_check ok ""
      realm::status_ok "dry-run"
    else
      ec=$?
      _record fleet_check failed "exit=$ec"
      realm::status_fail "dry-run failed (exit=$ec) — skipping live run"
      _post_event run_failed "Dry-run failed (exit=$ec); skipping live" "red"
    fi
  fi

  # ─── Phase 4: fleet live (only if dry-run clean OR --no-check) ─────────
  if [[ -n "$NO_CHECK" || "${PHASE_STATUS[fleet_check]:-}" = "ok" ]]; then
    realm::print_section "[4/4] Fleet: LIVE update"
    if "$realm_bin" ansible-update; then
      _record fleet_live ok ""
      realm::status_ok "live run"
    else
      ec=$?
      _record fleet_live failed "exit=$ec"
      realm::status_fail "live run failed (exit=$ec)"
    fi
  fi
else
  realm::print_section "[3-4/4] Fleet: SKIPPED (--skip-fleet)"
fi

# ─── Summary + final event ──────────────────────────────────────────────
duration=$(( $(date +%s) - started ))
realm::print_section "Summary (${duration}s)"
for phase in local fleet_check fleet_live; do
  status="${PHASE_STATUS[$phase]:-skipped}"
  detail="${PHASE_DETAIL[$phase]:-}"
  case "$status" in
    ok)      realm::status_ok    "$phase ${detail:+($detail)}" ;;
    failed)  realm::status_fail  "$phase ${detail:+($detail)}" ;;
    skipped) realm::status_warn  "$phase (skipped)" ;;
  esac
done

if [[ $overall_ok -eq 1 ]]; then
  summary_text="Daily realm update OK (${duration}s)"
  _post_event run_complete "$summary_text" "green"
  exit_code=0
else
  failed_phases=()
  for phase in "${!PHASE_STATUS[@]}"; do
    [[ "${PHASE_STATUS[$phase]}" = "failed" ]] && failed_phases+=("$phase")
  done
  summary_text="Daily realm update FAILED in: ${failed_phases[*]} (${duration}s)"
  _post_event run_failed "$summary_text" "red"
  exit_code=5
fi

if [[ "$REALM_OUTPUT" = "json" ]]; then
  jq -n \
    --argjson duration "$duration" \
    --argjson ok "$overall_ok" \
    --arg started "$(date -d @$started +%FT%T)" \
    --argjson phases "$(
      for phase in "${!PHASE_STATUS[@]}"; do
        jq -n --arg p "$phase" --arg s "${PHASE_STATUS[$phase]}" --arg d "${PHASE_DETAIL[$phase]:-}" \
          '{phase:$p, status:$s, detail:$d}'
      done | jq -s .
    )" \
    '{started:$started, duration:$duration, ok:($ok==1), phases:$phases}'
fi

exit $exit_code
