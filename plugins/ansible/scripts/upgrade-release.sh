#!/usr/bin/env bash
# realm ansible upgrade-release — major Ubuntu release upgrade for one host.
#
# This is NOT the daily safe-upgrade flow (`realm ansible-update`). It runs
# `do-release-upgrade` interactively over SSH inside a tmux session so JP can
# attend to prompts (third-party repo handling, conffile conflicts, services
# to restart) without losing the session on disconnect.
#
# Flow:
#   1. Resolve <name> to a target node via the topology (which mirrors
#      fleet.yaml). Confirm node.data.os == "ubuntu".
#   2. SSH to the target and run `do-release-upgrade -c` (a read-only check
#      that prints the available new release).
#   3. Show JP the current and target version, prompt for explicit
#      confirmation. No --yes flag — this is always human-in-the-loop.
#   4. Open a tmux session over SSH so JP can watch and answer prompts.
#      The tmux session is named so it survives disconnects.
#   5. Push realm events (upgrade.started / upgrade.completed) for the
#      alerting plugin and the codex.
#
# Out of scope (per issue #11): auto-reboot, bulk fleet upgrades,
# pre-release/dev versions.

set -euo pipefail

REALM_HELP_SUMMARY="Major Ubuntu release upgrade for one host (interactive, via SSH+tmux)"

realm::help() {
  cat <<'EOF'
realm ansible upgrade-release — major Ubuntu release upgrade for one host

USAGE:
  realm ansible upgrade-release --host <name> [OPTIONS]

OPTIONS:
  --host NAME          Target host (current_name or fleet_id). Required.
  --to VERSION         Target Ubuntu version (e.g. 24.04). Optional —
                       defaults to whatever `do-release-upgrade -c` offers.
                       If set, the check must match or the run is aborted.
  --user USER          SSH username (default: root, then jp)
  --no-tmux            Run do-release-upgrade directly over SSH instead of
                       wrapping in tmux. Survives only as long as the SSH
                       session — not recommended.
  --tmux-session NAME  tmux session name on the target (default:
                       realm-upgrade-<host>-<timestamp>)
  --no-event           Don't emit realm events (default: emit before/after)
  --check-only         Only run do-release-upgrade -c; never start the upgrade.
                       Useful for previewing what would happen across hosts.
  --dry-run            Print every SSH/tmux command without executing.

EXAMPLES:
  # Preview an upgrade
  realm ansible upgrade-release --host familiar --check-only

  # Interactive upgrade of one host
  realm ansible upgrade-release --host familiar

  # Pin the target version (aborts if the host offers a different one)
  realm ansible upgrade-release --host familiar --to 24.04

RECOVERY:
  If the tmux session detaches or you lose the SSH connection, reconnect
  with:
      ssh <user>@<host>
      tmux attach -t <session-name>
  The session name is printed when the upgrade starts.

EXIT CODES:
   0  ok (--check-only succeeded, or upgrade completed successfully)
   2  usage error
   3  realm server unreachable
   4  no such host / wrong OS / not Ubuntu
   5  no new release available, or release didn't match --to
   6  user declined the prompt
   7  SSH unreachable / upgrade run failed

SAFETY NOTES:
  - JP confirms explicitly before any state-changing command runs.
  - No reboots are triggered — the host will say "reboot required" at the
    end; trigger that yourself (`realm ssh <host> sudo reboot`).
  - The upgrade itself is interactive — you'll be prompted for conffile
    conflicts, third-party repo handling, and service restarts. The tmux
    session is designed exactly for this.
  - This command is LAN-only by intent. SSH credentials come from the
    operator's ~/.ssh, not from realm config.
EOF
}

# Pre-parse our `--host <fleet-name>` BEFORE realm::parse_common, because the
# common parser uses `--host URL` to mean the realm server URL (and would
# steal our value). Issue #11 specifies `realm ansible upgrade-release
# --host <name>` so we honor that surface; the realm-server override is
# still reachable via $REALM_HOST or `--host` AFTER the upgrade-release verb
# is dispatched (but here we don't need it — the API call is incidental).
HOST=""
declare -a _passthrough=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)    HOST="$2"; shift 2 ;;
    --host=*)  HOST="${1#*=}"; shift ;;
    *)         _passthrough+=("$1"); shift ;;
  esac
done
set -- "${_passthrough[@]+"${_passthrough[@]}"}"

source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

TARGET_VERSION=""
SSH_USERS_RAW="root,jp"
USE_TMUX=true
TMUX_SESSION=""
EMIT_EVENT=true
CHECK_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)              TARGET_VERSION="$2"; shift 2 ;;
    --to=*)            TARGET_VERSION="${1#*=}"; shift ;;
    --user)            SSH_USERS_RAW="$2"; shift 2 ;;
    --user=*)          SSH_USERS_RAW="${1#*=}"; shift ;;
    --no-tmux)         USE_TMUX=false; shift ;;
    --tmux-session)    TMUX_SESSION="$2"; shift 2 ;;
    --tmux-session=*)  TMUX_SESSION="${1#*=}"; shift ;;
    --no-event)        EMIT_EVENT=false; shift ;;
    --check-only)      CHECK_ONLY=true; shift ;;
    *)                 realm::die "unknown arg: $1 (try --help)" 2 ;;
  esac
done

[[ -n "$HOST" ]] || realm::die "--host is required (try --help)" 2

realm::api_reachable || realm::die_unreachable

# ── resolve target via topology ──────────────────────────────────
# topology mirrors fleet.yaml — nodes carry id, ip, data.os, etc. We accept
# either the fleet current_name (most common) or the fleet_id.
node_json=$(realm::api_get /topology 2>/dev/null \
  | jq --arg h "$HOST" '
      .nodes
      | map(select(
          .id == $h
          or .label == $h
          or (.fleet_id // "") == $h
          or (.current_name // "") == $h
        ))
      | .[0] // empty
    ')

if [[ -z "$node_json" || "$node_json" == "null" ]]; then
  realm::die "no such host in topology: $HOST (try: realm fleet show)" 4
fi

node_id=$(printf '%s' "$node_json" | jq -r '.id // ""')
node_label=$(printf '%s' "$node_json" | jq -r '.label // .id')
node_ip=$(printf '%s' "$node_json" | jq -r '.ip // ""')
node_os=$(printf '%s' "$node_json" | jq -r '.os // .data.os // ""' | tr '[:upper:]' '[:lower:]')
node_os_version=$(printf '%s' "$node_json" | jq -r '.os_version // .data.os_version // ""')
node_os_pretty=$(printf '%s' "$node_json" | jq -r '.os_pretty // .data.os_pretty // ""')

if [[ -z "$node_ip" ]]; then
  realm::die "host '$HOST' has no IP in topology — can't SSH" 4
fi

if [[ "$node_os" != "ubuntu" ]]; then
  printf '%s✘ realm ansible upgrade-release:%s host %s is not Ubuntu\n' "$R" "$N" "$node_label" >&2
  printf '  current OS: %s%s%s\n' "$Y" "${node_os:-unknown}" "$N" >&2
  printf '  This verb only handles Ubuntu hosts. Run %srealm discover-os --hosts %s%s\n' "$C" "$node_label" "$N" >&2
  printf '  if you think the OS tag is stale.\n' >&2
  exit 4
fi

realm::print_section "Target"
realm::print_kv "host"        "$node_label"
realm::print_kv "ip"          "$node_ip"
realm::print_kv "current_os"  "${node_os_pretty:-$node_os $node_os_version}"

# ── SSH probe: do-release-upgrade -c ────────────────────────────
# Try each user in order until one works.
IFS=',' read -ra SSH_USERS <<< "$SSH_USERS_RAW"
ssh_user=""
release_check_out=""

probe_release() {
  local u="$1"
  ssh -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=no \
      -o BatchMode=yes \
      -o LogLevel=ERROR \
      "$u@$node_ip" 'do-release-upgrade -c 2>&1' 2>/dev/null
}

if [[ -n "${REALM_DRY_RUN:-}" ]]; then
  realm::say "DRY-RUN: would SSH to $node_ip as one of: ${SSH_USERS_RAW//,/ }"
  realm::say "DRY-RUN: would run 'do-release-upgrade -c' and parse 'New release' line"
  release_check_out="New release '24.04 LTS' available.
Run 'do-release-upgrade' to upgrade to it."
  ssh_user="${SSH_USERS[0]}"
else
  for u in "${SSH_USERS[@]}"; do
    realm::verbose "Probing $u@$node_ip..."
    if release_check_out=$(probe_release "$u"); then
      ssh_user="$u"
      break
    fi
    # `do-release-upgrade -c` exits non-zero when no upgrade is available
    # — capture the output anyway and let the parser decide. Empty output
    # means the SSH itself failed.
    if [[ -n "$release_check_out" ]]; then
      ssh_user="$u"
      break
    fi
  done
fi

if [[ -z "$ssh_user" ]]; then
  realm::die "couldn't SSH to $node_ip (tried users: ${SSH_USERS_RAW//,/ })" 7
fi

realm::print_kv "ssh_user"    "$ssh_user"

# Parse the version offered. do-release-upgrade -c outputs lines like:
#   "New release '24.04 LTS' available."
# When no release is available it prints e.g.:
#   "Checking for a new Ubuntu release"
#   "No new release found."
new_release_line=$(printf '%s\n' "$release_check_out" | grep -i "^New release" | head -1 || true)
no_release_line=$(printf '%s\n' "$release_check_out" | grep -iE "No new release|No new releases" | head -1 || true)

if [[ -z "$new_release_line" ]]; then
  if [[ -n "$no_release_line" ]]; then
    realm::say "No new release available — $node_label is already on the latest."
    exit 5
  fi
  printf '%s✘ realm ansible upgrade-release:%s could not parse release-check output:\n' "$R" "$N" >&2
  printf '%s\n' "$release_check_out" >&2
  exit 5
fi

# Extract the version string between single quotes (e.g. "24.04 LTS")
offered_version=$(printf '%s' "$new_release_line" | sed -nE "s/.*'([^']+)'.*/\1/p")
realm::print_kv "new_release" "${offered_version:-$new_release_line}"

# If JP pinned --to, verify it matches the offered version.
if [[ -n "$TARGET_VERSION" ]]; then
  if [[ "$offered_version" != *"$TARGET_VERSION"* ]]; then
    printf '%s✘ realm ansible upgrade-release:%s --to %s but host offers %s\n' \
      "$R" "$N" "$TARGET_VERSION" "$offered_version" >&2
    printf '  Re-run without --to to accept whatever is offered, or wait for the\n' >&2
    printf '  target release to be available on this host.\n' >&2
    exit 5
  fi
fi

if [[ "$CHECK_ONLY" = true ]]; then
  realm::say "--check-only: skipping the actual upgrade."
  exit 0
fi

# ── confirm with JP ───────────────────────────────────────────────
printf '\n%sAbout to run a MAJOR Ubuntu release upgrade.%s\n' "$Y" "$N" >&2
printf '  host:    %s (%s)\n' "$node_label" "$node_ip" >&2
printf '  from:    %s\n' "${node_os_pretty:-$node_os $node_os_version}" >&2
printf '  to:      %s\n' "${offered_version:-unknown}" >&2
printf '  ssh as:  %s\n' "$ssh_user" >&2
if [[ "$USE_TMUX" = true ]]; then
  printf '  mode:    tmux session (survives disconnect)\n' >&2
else
  printf '  %smode:    direct SSH (no tmux — session dies on disconnect)%s\n' "$Y" "$N" >&2
fi
printf '\n%sThis will take 15-60 minutes and will prompt you interactively for%s\n' "$Y" "$N" >&2
printf '%sthird-party repos, conffile conflicts, and service restarts.%s\n' "$Y" "$N" >&2
printf '%sNo reboot will be triggered automatically.%s\n\n' "$Y" "$N" >&2

if [[ -n "${REALM_DRY_RUN:-}" ]]; then
  realm::say "DRY-RUN: would prompt for confirmation here"
  CONFIRM_REPLY="y"
else
  printf '  %sProceed?%s [y/N] ' "$W" "$N" >&2
  read -r CONFIRM_REPLY
fi

if [[ ! "$CONFIRM_REPLY" =~ ^[Yy] ]]; then
  realm::say "Aborted by user."
  exit 6
fi

# ── kick off the upgrade ─────────────────────────────────────────
if [[ -z "$TMUX_SESSION" ]]; then
  TMUX_SESSION="realm-upgrade-${node_label}-$(date +%s)"
fi

# Build the remote command. We always want the host to write a marker file
# so a later poll can see whether do-release-upgrade exited cleanly even if
# JP detached from tmux.
marker="/var/log/realm-upgrade-release.${TMUX_SESSION}.log"
remote_cmd="set -e; \
  echo \"--- realm ansible upgrade-release ---\"; \
  echo \"host:    \$(hostname)\"; \
  echo \"started: \$(date -u +%FT%TZ)\"; \
  echo \"session: ${TMUX_SESSION}\"; \
  echo \"target:  ${offered_version}\"; \
  echo; \
  sudo do-release-upgrade 2>&1 | tee ${marker}; \
  rc=\$?; \
  echo; \
  echo \"finished: \$(date -u +%FT%TZ) rc=\$rc\"; \
  if [[ \$rc -ne 0 ]]; then \
    echo \"do-release-upgrade failed; tmux session will remain open for inspection.\"; \
  fi; \
  echo \"press enter to close this tmux pane\"; read -r _"

emit_event() {
  local subtype="$1" status="${2:-}"
  [[ "$EMIT_EVENT" = true ]] || return 0
  [[ -n "${REALM_DRY_RUN:-}" ]] && { realm::say "DRY-RUN: would emit ansible event $subtype"; return 0; }
  local body
  body=$(jq -n \
    --arg type "ansible" \
    --arg subtype "$subtype" \
    --arg host "$node_label" \
    --arg ip "$node_ip" \
    --arg from "${node_os_pretty:-$node_os $node_os_version}" \
    --arg to "$offered_version" \
    --arg session "$TMUX_SESSION" \
    --arg status "$status" \
    --arg msg "War Room: Ubuntu release upgrade $subtype on $node_label (→ $offered_version)" \
    '{
       type: $type,
       subtype: $subtype,
       severity: 2,
       host: $host,
       data: {ip: $ip, from: $from, to: $to, tmux_session: $session, status: $status},
       message: $msg
     }')
  realm::api_post /event "$body" >/dev/null 2>&1 \
    || realm::warn "POST /event failed (continuing)"
}

emit_event "upgrade.started"

realm::say "Launching upgrade in tmux session: $TMUX_SESSION"
realm::say "If you disconnect, reconnect with: ssh $ssh_user@$node_ip ; tmux attach -t $TMUX_SESSION"

# When tmux is used, we want JP attached interactively so the prompts work.
# `ssh -t` allocates a tty; the remote `tmux new-session -A -s ...` creates
# or attaches to the named session (idempotent on reconnect). The remote
# command runs inside that session.
ssh_opts=(
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=no
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -t
)

if [[ -n "${REALM_DRY_RUN:-}" ]]; then
  if [[ "$USE_TMUX" = true ]]; then
    printf 'DRY-RUN: ssh %s %s@%s "tmux new-session -A -s %s bash -lc <upgrade-cmd>"\n' \
      "${ssh_opts[*]}" "$ssh_user" "$node_ip" "$TMUX_SESSION" >&2
  else
    printf 'DRY-RUN: ssh %s %s@%s bash -lc <upgrade-cmd>\n' \
      "${ssh_opts[*]}" "$ssh_user" "$node_ip" >&2
  fi
  emit_event "upgrade.completed" "dry-run"
  exit 0
fi

if [[ "$USE_TMUX" = true ]]; then
  # Wrap the remote command in tmux. `new-session -A` attaches if the session
  # already exists (e.g. reconnecting after detach).
  # shellcheck disable=SC2029  # we want $TMUX_SESSION expanded locally
  ssh "${ssh_opts[@]}" "$ssh_user@$node_ip" \
    "tmux new-session -A -s '$TMUX_SESSION' bash -lc $(printf %q "$remote_cmd")"
  ssh_rc=$?
else
  # shellcheck disable=SC2029
  ssh "${ssh_opts[@]}" "$ssh_user@$node_ip" "bash -lc $(printf %q "$remote_cmd")"
  ssh_rc=$?
fi

if [[ $ssh_rc -eq 0 ]]; then
  emit_event "upgrade.completed" "success"
  realm::print_section "Result"
  realm::print_kv "host"      "$node_label"
  realm::print_kv "upgraded"  "${offered_version}"
  realm::print_kv "session"   "$TMUX_SESSION"
  realm::print_kv "log"       "$marker (on target)"
  realm::say "Reboot when ready: realm ssh $node_label sudo reboot"
  exit 0
else
  emit_event "upgrade.completed" "failed"
  realm::warn "ssh/tmux returned rc=$ssh_rc — the upgrade may have failed or you detached."
  realm::say  "Reattach: ssh $ssh_user@$node_ip ; tmux attach -t $TMUX_SESSION"
  realm::say  "Log on target: $marker"
  exit 7
fi
