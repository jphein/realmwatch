# scripts/lib/colors.sh
#
# Color codes for realm CLI tools. Matches the existing convention exactly
# (single-letter G R Y C N, plus extended C_* set for monitor-style scripts).
#
# Disables color automatically when:
#   - NO_COLOR env var is set and non-empty (no-color.org standard)
#   - stdout is not a TTY (so piping into less/files stays clean)
#   - REALM_NO_COLOR=1 (set by --no-color flag in args.sh)
#
# Source me, don't execute.

# Defaults (color ON)
G=$'\033[0;32m'      # green (basic)
R=$'\033[0;31m'      # red (basic)
Y=$'\033[0;33m'      # yellow (basic)
C=$'\033[0;36m'      # cyan (basic)
B=$'\033[0;34m'      # blue (basic)
M=$'\033[0;35m'      # magenta (basic)
W=$'\033[1;37m'      # bright white / bold
D=$'\033[2m'         # dim
N=$'\033[0m'         # no color (reset)

# Extended palette for monitor-style scripts (matches existing tempmon usage)
C_RESET=$'\033[0m'
C_DIM=$'\033[2m'
C_BOLD=$'\033[1m'
C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'
C_ORANGE=$'\033[38;5;208m'    # 256-color orange
C_RED=$'\033[31m'
C_CYAN=$'\033[36m'

# Disable if NO_COLOR set, not a TTY, or --no-color requested
if [[ -n "${NO_COLOR:-}" ]] || [[ ! -t 1 ]] || [[ "${REALM_NO_COLOR:-}" = "1" ]]; then
  G=''; R=''; Y=''; C=''; B=''; M=''; W=''; D=''; N=''
  C_RESET=''; C_DIM=''; C_BOLD=''; C_GREEN=''; C_YELLOW=''
  C_ORANGE=''; C_RED=''; C_CYAN=''
fi
