# scripts/lib/args.sh
#
# Shared argument parsing for realm CLI subcommands.
#
# Usage at top of a subcommand:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   REALM_HELP_SUMMARY="One-line description for the index"
#   realm::help() {
#     cat <<'EOF'
#   realm foo — what this command does
#
#   USAGE:
#     realm foo [OPTIONS] <ARGS>
#
#   OPTIONS:
#     -h, --help     Show this help
#     --json         Machine-readable JSON output
#
#   EXAMPLES:
#     realm foo bar
#   EOF
#   }
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
#   realm::parse_common "$@"
#   set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"
#   # ... now $@ contains only positionals/subcommand-specific flags
#
# Common flags recognized:
#   -h, --help          → calls realm::help and exits 0
#   --version           → prints sigil-format version line and exits 0
#   -v, --verbose       → REALM_VERBOSE=1
#   -q, --quiet         → REALM_QUIET=1
#   --no-color          → REALM_NO_COLOR=1
#   --json              → REALM_OUTPUT=json
#   --dry-run           → REALM_DRY_RUN=1
#   --host URL          → REALM_HOST=URL (overrides config)
#   --one-line-help     → prints REALM_HELP_SUMMARY, exits 0 (hidden, dispatcher use)
#   --list-subcommands  → prints REALM_SUBCOMMANDS one per line, exits 0 (hidden)
#   --                  → stops parsing; remainder is positional
#
# After parse, positional args are in REALM_POSARGS (array). Unknown long flags
# starting with -- error with exit 2 ("usage error" per clig.dev). Unknown short
# flags also error. Use `--` to forward args containing dashes to a subprocess.

# Initialize globals if unset (lets subcommands set their own defaults beforehand)
: "${REALM_VERBOSE:=}"
: "${REALM_QUIET:=}"
: "${REALM_NO_COLOR:=}"
: "${REALM_OUTPUT:=human}"
: "${REALM_DRY_RUN:=}"
: "${REALM_HELP_SUMMARY:=}"
: "${REALM_SUBCOMMANDS:=}"

# Output array
REALM_POSARGS=()

realm::parse_common() {
  REALM_POSARGS=()
  local arg val
  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      -h|--help)
        if declare -f realm::help >/dev/null 2>&1; then
          realm::help
        else
          echo "${REALM_HELP_SUMMARY:-No help available}"
        fi
        exit 0
        ;;
      --version)
        realm::_print_version
        exit 0
        ;;
      --one-line-help)
        printf '%s\n' "${REALM_HELP_SUMMARY:-(no description)}"
        exit 0
        ;;
      --list-subcommands)
        # REALM_SUBCOMMANDS is a newline-separated string set by the subcommand
        if [[ -n "$REALM_SUBCOMMANDS" ]]; then
          printf '%s\n' "$REALM_SUBCOMMANDS"
        fi
        exit 0
        ;;
      -v|--verbose) REALM_VERBOSE=1; shift ;;
      -q|--quiet)   REALM_QUIET=1; shift ;;
      --no-color)   REALM_NO_COLOR=1; shift ;;
      --json)       REALM_OUTPUT=json; shift ;;
      --dry-run)    REALM_DRY_RUN=1; shift ;;
      --host=*)     REALM_HOST="${arg#*=}"; shift ;;
      --host)
        [[ $# -ge 2 ]] || { echo "realm: --host requires a value" >&2; exit 2; }
        REALM_HOST="$2"; shift 2
        ;;
      --) shift; REALM_POSARGS+=("$@"); break ;;
      --*=*)
        # Unknown long flag with value — let subcommand handle it via REALM_POSARGS
        REALM_POSARGS+=("$arg"); shift
        ;;
      --*)
        # Unknown long flag — let subcommand handle (it might be subcommand-specific)
        REALM_POSARGS+=("$arg"); shift
        ;;
      -*)
        # Unknown short flag — subcommand-specific
        REALM_POSARGS+=("$arg"); shift
        ;;
      *)
        REALM_POSARGS+=("$arg"); shift
        ;;
    esac
  done

  # Re-export REALM_HOST so http.sh picks up --host overrides
  export REALM_HOST
}

# realm::_print_version — internal; prints the sigil-format version line.
# Reads $(repo)/scripts/cli/.realm-version (stamped by `make cli-install`)
# or falls back to "dev" if unset.
realm::_print_version() {
  local hash="dev"
  local stamp_file
  stamp_file="$(dirname "${BASH_SOURCE[0]}")/../cli/.realm-version"
  if [[ -f "$stamp_file" ]]; then
    hash="$(cat "$stamp_file" 2>/dev/null || echo dev)"
  elif git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD &>/dev/null; then
    hash="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --short HEAD)"
  fi
  local name="${0##*/}"
  name="${name%.sh}"
  printf '%s %s\n' "$name" "$hash"
}

# realm::flag_set — check if a positional looks like a flag.
realm::flag_set() {
  local target="$1"; shift
  for a in "$@"; do
    [[ "$a" == "$target" || "$a" == "$target="* ]] && return 0
  done
  return 1
}

# realm::flag_value — extract value of a long flag from a list.
# Returns empty string if not set. Supports --foo=bar and --foo bar.
realm::flag_value() {
  local target="$1"; shift
  local i=0
  local -a args=("$@")
  while [[ $i -lt ${#args[@]} ]]; do
    if [[ "${args[$i]}" == "$target" ]] && [[ $((i+1)) -lt ${#args[@]} ]]; then
      printf '%s' "${args[$((i+1))]}"
      return 0
    elif [[ "${args[$i]}" == "$target="* ]]; then
      printf '%s' "${args[$i]#*=}"
      return 0
    fi
    i=$((i+1))
  done
  return 1
}

# realm::help_flags — print the standardized GLOBAL FLAGS + EXIT CODES footer
# that every subcommand's `realm::help` should end with. Keeping the canonical
# flag list and exit-code contract in ONE place means per-command help can't
# drift from `realm --help` (the dispatcher index uses the same wording).
#
# Call it at the end of a command's realm::help, after the usage heredoc:
#   realm::help() {
#     cat <<'EOF'
#   ...usage text...
#   EOF
#     realm::help_flags
#   }
#
# Color vars ($W/$C/$N) resolve at call time — colors.sh is sourced after this
# file, but realm::help only runs once the full lib chain is loaded, so the
# palette (or its no-color blanks) is always populated by then.
realm::help_flags() {
  # Color vars come from colors.sh, which realm-cli.sh sources AFTER this file.
  # In the normal subcommand flow they're populated by the time help runs, but
  # guard with ${VAR:-} so a standalone source of args.sh (or any future
  # reorder) can't trip `set -u` with an unbound-variable crash.
  printf '\n%sGLOBAL FLAGS%s\n' "${W:-}" "${N:-}"
  printf '  %s-h, --help%s     Show this help and exit\n' "${C:-}" "${N:-}"
  printf '  %s    --version%s  Print version and exit\n' "${C:-}" "${N:-}"
  printf '  %s    --json%s     Machine-readable JSON output\n' "${C:-}" "${N:-}"
  printf '  %s    --no-color%s Disable ANSI color (env: NO_COLOR=1)\n' "${C:-}" "${N:-}"
  printf '  %s-v, --verbose%s  Verbose output (show curl invocations)\n' "${C:-}" "${N:-}"
  printf '  %s-q, --quiet%s    Suppress informational output\n' "${C:-}" "${N:-}"
  printf '  %s    --dry-run%s  Preview API calls without sending them\n' "${C:-}" "${N:-}"
  printf '  %s    --host URL%s Override the realm host (default: %s)\n' "${C:-}" "${N:-}" "${REALM_HOST:-http://localhost}"
  printf '\n%sEXIT CODES%s\n' "${W:-}" "${N:-}"
  printf '  %s0%s ok · %s2%s usage · %s3%s network · %s4%s auth · %s5%s server · %s22%s client\n' \
    "${C:-}" "${N:-}" "${C:-}" "${N:-}" "${C:-}" "${N:-}" "${C:-}" "${N:-}" "${C:-}" "${N:-}" "${C:-}" "${N:-}"
}
