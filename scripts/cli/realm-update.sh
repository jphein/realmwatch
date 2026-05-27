#!/usr/bin/env bash
# realm-update — unified update orchestrator (closes #47).
#
# Three execution surfaces, one verb:
#   • Local (default)              → plugins/system-updates/cli.py
#                                    (apt, brew, npm, pipx, mise, snap,
#                                    flatpak, firmware, claude, copilot…)
#   • Single / multi node          → realm ansible-update --hosts a,b,c
#   • Whole realm                  → realm update-all (two-stage:
#                                    local first, then Ubuntu fleet)
#
# The fleet target list comes from fleet.yaml — entries opt in by adding
# realm_update.enabled: true (see scripts/lib/emit-update-eligible.py).
# This replaces the older ~/.config/realm/ubuntu-hosts.conf knob: fleet.yaml
# is now the single source of truth for which boxes are update-managed.
#
# Wave terminal (wavesrv) injects XDG_CACHE_HOME, XDG_CONFIG_HOME,
# XDG_DATA_HOME as empty strings. The XDG basedir spec says empty should
# fall back to the default ($HOME/.cache etc.), but not every tool complies
# — notably, mise path-joins XDG_CACHE_HOME with "mise", yielding a
# relative dir and leaking cache into whatever CWD this script runs from.
# Normalize before any subprocess inherits.
set -euo pipefail

REALM_HELP_SUMMARY="Check & apply system / runtime updates (local or fleet-wide)"

realm::help() {
  cat <<'EOF'
realm update — keep this box and the realm up to date

USAGE:
  realm update [SUBCMD|FLAGS]

LOCAL (default — same as `realm-update` legacy script):
  realm update                       Interactive: check all sources, prompt to upgrade
  realm update list                  List known sources (apt, brew, mise, …)
  realm update check [SOURCE]        Check one source, or all
  realm update run   [SOURCE]        Upgrade one source, or all (no prompt)

CROSS-HOST (via ansible plugin, Ubuntu only in Phase A):
  realm update --node NAME           Update one fleet host
  realm update --nodes a,b,c         Update a comma-separated set
  realm update --all-nodes           Update every fleet.yaml entry with
                                     realm_update.enabled: true
  realm update --list-hosts          Show which fleet entries are opted in

ORCHESTRATED (local + fleet, two-stage; same as `realm update-all`):
  realm update --everything          Local box first, then Ubuntu fleet,
                                     dry-run gate by default.

COMMON FLAGS (forwarded as appropriate):
  --dry-run                          Local: print plan only.
                                     Remote: ansible --check (no changes made).
  --json                             Machine-readable output where supported.

EXAMPLES:
  realm update                       # interactive local update
  realm update check apt             # just refresh apt index
  realm update --node disks --dry-run
  realm update --all-nodes
  realm update --everything --dry-run

DETAILS:
  - Local desktop toolchains (mise, brew, claude/copilot updaters, pipx,
    firmware) only live on this box — the system-updates plugin owns them.
  - Fleet hosts are handled by the ansible plugin's update-ubuntu.yml.
  - Logs land in $XDG_STATE_HOME/realm-update/ (default ~/.local/state/...).
    The 10 most recent runs are kept.
EOF
}

REALM_SUBCOMMANDS="list
check
run"

# Normalize XDG vars before parse_common — see header.
[ -z "${XDG_CACHE_HOME:-}" ]  && export XDG_CACHE_HOME="$HOME/.cache"
[ -z "${XDG_CONFIG_HOME:-}" ] && export XDG_CONFIG_HOME="$HOME/.config"
[ -z "${XDG_DATA_HOME:-}" ]   && export XDG_DATA_HOME="$HOME/.local/share"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# Pull our cross-host flags out of the remaining args; everything else is
# either a local subcommand (list/check/run/...) or passes through to the
# system-updates CLI unchanged.
NODES=()
ALL_NODES=0
EVERYTHING=0
LIST_HOSTS=0
LOCAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)        [[ $# -ge 2 ]] || realm::die "--node requires a value" 2
                   NODES+=("$2"); shift 2 ;;
    --node=*)      NODES+=("${1#*=}"); shift ;;
    --nodes)       [[ $# -ge 2 ]] || realm::die "--nodes requires a value" 2
                   IFS=',' read -ra _ns <<<"$2"; NODES+=("${_ns[@]}"); shift 2 ;;
    --nodes=*)     IFS=',' read -ra _ns <<<"${1#*=}"; NODES+=("${_ns[@]}"); shift ;;
    --all-nodes)   ALL_NODES=1; shift ;;
    --everything|--all-stages)
                   EVERYTHING=1; shift ;;
    --list-hosts|--list-nodes)
                   LIST_HOSTS=1; shift ;;
    *)             LOCAL_ARGS+=("$1"); shift ;;
  esac
done

_self="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || realpath "${BASH_SOURCE[0]}")"
_scripts_dir="$(cd "$(dirname "$_self")/.." && pwd)"
_repo_dir="$(cd "$_scripts_dir/.." && pwd)"
realm_bin="$(command -v realm 2>/dev/null || echo "$_scripts_dir/realm")"

LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/realm-update"
mkdir -p "$LOG_DIR"

# Mutual-exclusion: cross-host modes can't combine.
mode_count=0
[[ ${#NODES[@]} -gt 0 ]] && mode_count=$((mode_count+1))
[[ $ALL_NODES -eq 1 ]] && mode_count=$((mode_count+1))
[[ $EVERYTHING -eq 1 ]] && mode_count=$((mode_count+1))
[[ $LIST_HOSTS -eq 1 ]] && mode_count=$((mode_count+1))
if [[ $mode_count -gt 1 ]]; then
  realm::die "pick one of --node/--nodes, --all-nodes, --everything, --list-hosts" 2
fi

# ─── --list-hosts: show fleet.yaml opt-ins, exit ─────────────────────────
if [[ $LIST_HOSTS -eq 1 ]]; then
  if [[ "${REALM_OUTPUT:-human}" = "json" ]]; then
    exec python3 "$_scripts_dir/lib/emit-update-eligible.py" --format=json
  else
    realm::print_section "fleet.yaml entries opted in to realm update"
    python3 "$_scripts_dir/lib/emit-update-eligible.py" --format=table | column -t -s $'\t'
    echo
    echo "Opt a node in by adding to its fleet.yaml entry:"
    echo "  realm_update:"
    echo "    enabled: true"
    exit 0
  fi
fi

# ─── --everything: delegate to existing update-all orchestrator ─────────
# update-all already implements the two-stage flow (dry-run gate, event
# posts, JSON summary). No reason to duplicate; just pass through.
if [[ $EVERYTHING -eq 1 ]]; then
  exec "$realm_bin" update-all "${LOCAL_ARGS[@]+"${LOCAL_ARGS[@]}"}"
fi

# ─── --node / --nodes / --all-nodes: ansible bridge ──────────────────────
if [[ ${#NODES[@]} -gt 0 || $ALL_NODES -eq 1 ]]; then
  if [[ $ALL_NODES -eq 1 ]]; then
    mapfile -t NODES < <(python3 "$_scripts_dir/lib/emit-update-eligible.py" --format=names)
    if [[ ${#NODES[@]} -eq 0 ]]; then
      realm::die "no fleet.yaml entries with realm_update.enabled: true (try: realm update --list-hosts)" 1
    fi
  fi

  hosts_csv=$(IFS=','; echo "${NODES[*]}")
  realm::print_section "Cross-host update via ansible plugin: $hosts_csv"

  ansible_args=(ansible-update --hosts "$hosts_csv")
  [[ "${REALM_DRY_RUN:-}" = "1" ]] && ansible_args+=(--check)
  [[ "${REALM_OUTPUT:-human}" = "json" ]] && ansible_args+=(--json)
  # Forward any leftover args (e.g. --playbook, --no-wait) verbatim.
  ansible_args+=("${LOCAL_ARGS[@]+"${LOCAL_ARGS[@]}"}")

  exec "$realm_bin" "${ansible_args[@]}"
fi

# ─── Default path: local system-updates ──────────────────────────────────
cd "$_repo_dir"
LOG="$LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
# Trim to the 10 most recent logs.
( ls -1t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +11 | xargs -r rm -- ) || true

# python3 -u keeps stdout unbuffered so streaming subprocess lines appear
# live through the tee; pipefail (set above) propagates python's exit code.
python3 -u plugins/system-updates/cli.py "${LOCAL_ARGS[@]+"${LOCAL_ARGS[@]}"}" 2>&1 | tee "$LOG"
