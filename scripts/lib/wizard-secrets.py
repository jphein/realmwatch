#!/usr/bin/env python3
"""wizard-secrets.py — fetch secrets from Bitwarden CLI with graceful fallback.

Wraps `bw get password <name>` and returns a clean answer:

  - prints the password to stdout if found
  - exits 0 on success
  - exits 1 if no item matches (caller should prompt user)
  - exits 2 if the vault is locked (caller should launch `bw unlock` in Ghostty)
  - exits 3 if `bw` is not installed at all
  - exits 4 if `bw` is installed but not logged in (`bw status` reports "unauthenticated")

Caller convention:
    secret=$(python3 scripts/lib/wizard-secrets.py get "OpenRouter API")
    case $? in
      0) echo "got it: $secret" ;;
      1) prompt_user ;;
      2) launch_unlock_in_ghostty ;;
      3) echo "bw not installed — npm i -g @bitwarden/cli" ;;
      4) echo "bw login first" ;;
    esac

Per JP's CLAUDE.md: never ask JP to paste a secret. Always fetch from `bw`.
The wizard uses this helper as the first step in section-cloud-keys.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from typing import Optional


def _bw_available() -> bool:
    return shutil.which("bw") is not None


def _bw_status() -> Optional[dict]:
    """Return parsed `bw status` JSON, or None if call fails."""
    try:
        result = subprocess.run(
            ["bw", "status"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return None


def get_secret(name: str) -> tuple[int, str]:
    """Fetch a password by item name. Returns (exit_code, value).

    Exit codes match the CLI contract above.
    """
    if not _bw_available():
        return 3, ""

    status = _bw_status()
    if status is None:
        # bw exists but `bw status` failed — treat as locked
        return 2, ""

    state = status.get("status", "")
    if state == "unauthenticated":
        return 4, ""
    if state == "locked":
        return 2, ""
    # state should be "unlocked" at this point

    try:
        result = subprocess.run(
            ["bw", "get", "password", name],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 2, ""

    if result.returncode != 0:
        # bw returns non-zero for "Not found" — that's caller's "prompt user" case
        return 1, ""

    secret = result.stdout.strip()
    if not secret:
        return 1, ""

    return 0, secret


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: wizard-secrets.py get <item-name>", file=sys.stderr)
        return 2

    cmd = sys.argv[1]
    if cmd == "status":
        # Diagnostic: print bw status, exit 0 if unlocked
        if not _bw_available():
            print("bw: not installed", file=sys.stderr)
            return 3
        status = _bw_status()
        if status is None:
            print("bw: status call failed", file=sys.stderr)
            return 2
        print(status.get("status", "unknown"))
        return 0 if status.get("status") == "unlocked" else 2

    if cmd == "get":
        if len(sys.argv) < 3:
            print("usage: wizard-secrets.py get <item-name>", file=sys.stderr)
            return 2
        name = sys.argv[2]
        code, value = get_secret(name)
        if code == 0:
            print(value)
        return code

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
