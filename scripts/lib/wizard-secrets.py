#!/usr/bin/env python3
"""wizard-secrets.py — fetch secrets from Bitwarden CLI with graceful fallback.

Wraps `bw get password <name>` and returns a clean answer:

  - prints the password to stdout if found
  - exits 0 on success
  - exits 1 if no item matches (caller should prompt user)
  - exits 2 if the vault is locked (caller should launch `bw unlock` in Ghostty)
  - exits 3 if `bw` is not installed at all
  - exits 4 if `bw` is installed but not logged in (`bw status` reports "unauthenticated")
  - exits 64 (EX_USAGE) for usage errors / unknown commands (per sysexits.h)
  - exits 5 if `bw` returned a non-zero exit for reasons other than not-found
    (transient failure, unexpected stderr; details on stderr for the caller)

Caller convention:
    secret=$(python3 scripts/lib/wizard-secrets.py get "OpenRouter API")
    case $? in
      0)  echo "got it: $secret" ;;
      1)  prompt_user ;;
      2)  launch_unlock_in_ghostty ;;
      3)  echo "bw not installed — npm i -g @bitwarden/cli" ;;
      4)  echo "bw login first" ;;
      5)  echo "bw call failed for unknown reason — see stderr" ;;
      64) echo "usage error" ;;
    esac

Per JP's global ~/.claude/CLAUDE.md conventions: never ask JP to paste a
secret — always fetch from `bw`. (That rule lives in the global user
config, not realmwatch's repo CLAUDE.md.) The wizard uses this helper as
the first step in section-cloud-keys.
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
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(f"bw: invocation failed ({exc})", file=sys.stderr)
        return 5, ""

    if result.returncode != 0:
        # Non-zero from `bw get password` is ambiguous: it covers genuine
        # not-found, transient errors, session/vault issues, etc. Re-check
        # `bw status` to disambiguate before assigning a category.
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        combined = f"{stdout}\n{stderr}".lower()

        post_status = _bw_status()
        if post_status is None:
            # `bw status` call also failed → likely transient / unknown.
            print(
                "bw: `bw status` failed after a failing `bw get` — "
                "vault may have just locked or bw is misbehaving",
                file=sys.stderr,
            )
            return 5, ""
        post_state = post_status.get("status", "")
        if post_state == "locked":
            return 2, ""
        if post_state == "unauthenticated":
            return 4, ""

        # Vault is still unlocked: the failure is either a real not-found
        # or some other unexpected error. Disambiguate by stderr content.
        if "not found" in combined or "no object" in combined:
            return 1, ""

        # Unknown error — surface stderr so the caller can decide.
        if stderr:
            print(f"bw: unexpected error — {stderr}", file=sys.stderr)
        else:
            print(
                f"bw: non-zero exit ({result.returncode}) with no stderr",
                file=sys.stderr,
            )
        return 5, ""

    secret = result.stdout.strip()
    if not secret:
        return 1, ""

    return 0, secret


def main() -> int:
    # Exit code 64 (EX_USAGE per sysexits.h) is reserved for usage errors so
    # exit 2 remains an unambiguous "vault is locked" signal for the caller.
    if len(sys.argv) < 2:
        print("usage: wizard-secrets.py get <item-name>", file=sys.stderr)
        return 64

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
            return 64
        name = sys.argv[2]
        code, value = get_secret(name)
        if code == 0:
            print(value)
        return code

    print(f"unknown command: {cmd}", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main())
