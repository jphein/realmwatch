# scripts/lib/realm-cli.sh
#
# Umbrella source for realm CLI subcommands. Pulls in args, config, colors,
# http, output, and fleet libs in the right order.
#
# Typical use at the top of a subcommand:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   REALM_HELP_SUMMARY="One-line description for the index"
#   realm::help() { ... }
#   source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
#   realm::parse_common "$@"
#   set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"
#
# Order matters: args.sh sets REALM_NO_COLOR before colors.sh checks for it.

_realm_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck disable=SC1091
source "$_realm_lib_dir/args.sh"
# shellcheck disable=SC1091
source "$_realm_lib_dir/config.sh"
# shellcheck disable=SC1091
source "$_realm_lib_dir/colors.sh"
# shellcheck disable=SC1091
source "$_realm_lib_dir/http.sh"
# shellcheck disable=SC1091
source "$_realm_lib_dir/output.sh"
# fleet.sh is optional — only fleet ops scripts need it
# shellcheck disable=SC1091
[[ -f "$_realm_lib_dir/fleet.sh" ]] && source "$_realm_lib_dir/fleet.sh"
