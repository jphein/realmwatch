# scripts/lib/realm-python.sh — locate realmwatch's venv python from any caller.
#
# Source from any bash script that needs to invoke realmwatch python (e.g. to
# call realm_fleet.host_ip from a shell pipeline):
#
#   source "$(dirname "$0")/lib/realm-python.sh"
#   ip="$($REALM_PYTHON -c "import realm_fleet; print(realm_fleet.host_ip('katana') or '')")"
#
# Why a helper: scripts get invoked from different cwds (./scripts/foo.sh,
# ~/.local/bin/realm-foo via symlink, etc.). This file uses readlink -f on its
# own BASH_SOURCE to walk back to the realmwatch repo root, then points at
# .venv/bin/python3. Always absolute, always correct.
#
# Falls back to system `python3` with a warning if .venv/bin/python3 is missing
# (e.g. fresh checkout before `make install` ran). Scripts can check
# $REALM_PYTHON_OK to gate their behavior.

_rp_self="$(readlink -f "${BASH_SOURCE[0]}")"
REALM_HOME="$(cd "$(dirname "$_rp_self")/../.." && pwd)"
unset _rp_self

if [[ -x "$REALM_HOME/.venv/bin/python3" ]]; then
  REALM_PYTHON="$REALM_HOME/.venv/bin/python3"
  REALM_PYTHON_OK=1
else
  REALM_PYTHON="python3"
  REALM_PYTHON_OK=0
  echo "WARN: $REALM_HOME/.venv/bin/python3 not found — using system python3" >&2
  echo "      run \`make install\` in $REALM_HOME to set up the managed venv" >&2
fi

# Put REALM_HOME on PYTHONPATH so top-level modules (realm_zones, realm_vlans,
# realm_fleet, firewall_parser, ap_scanner, ...) are importable from the venv.
# pyproject.toml marks the repo as `package = false`, so there is no editable
# install — this is how callers get the local modules onto sys.path. Prepend
# rather than append so repo modules win over any same-named PyPI package.
if [[ -n "${PYTHONPATH:-}" ]]; then
  PYTHONPATH="$REALM_HOME:$PYTHONPATH"
else
  PYTHONPATH="$REALM_HOME"
fi

# Export so subshells (heredocs, $(...)) see it
export REALM_HOME REALM_PYTHON REALM_PYTHON_OK PYTHONPATH
