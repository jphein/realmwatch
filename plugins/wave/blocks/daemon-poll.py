#!/usr/bin/env python3
"""Emit palace-daemon log-health stats as JSON for wave-block custom mode.

The original `daemon` verb was a plain `journalctl -fu palace-daemon` tail —
useful but not a dashboard. wave-block is a polling renderer, so we turn
the journal into a status snapshot: error/warn counts over the last
DAEMON_WINDOW_SEC seconds, total lines, the last log line as a label,
plus the unit's current ActiveState. If you want the raw tail, ssh to
familiar and run `journalctl -fu palace-daemon` directly.

Config:
  PALACE_DAEMON_HOST     default jp@familiar
  PALACE_DAEMON_UNIT     default palace-daemon
  DAEMON_WINDOW_SEC      default 60   (window for error/warn counts)

Output schema:
  unit_state          "active" | "inactive" | "failed" | "unknown"
  lines_window        int     log lines in the last window
  errors_window       int     ERROR-level lines in the window
  warns_window        int     WARN-level lines in the window
  last_line           str     truncated last log line (label row)
  reachable           "yes" | "no"
  error               str     (only on failure)
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys

HOST = os.environ.get("PALACE_DAEMON_HOST", "jp@familiar")
UNIT = os.environ.get("PALACE_DAEMON_UNIT", "palace-daemon")
WINDOW_SEC = int(os.environ.get("DAEMON_WINDOW_SEC", "60"))


def _ssh(cmd: str, timeout: int = 8) -> tuple[str, str]:
    try:
        r = subprocess.run(
            ["ssh", "-o", "ConnectTimeout=4", HOST, cmd],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.stdout, r.stderr
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError, OSError) as e:
        return "", str(e)


def main() -> int:
    out: dict = {"reachable": "no", "unit_state": "unknown"}

    # One round-trip: state + recent journal lines.
    state_cmd = f"systemctl is-active {shlex.quote(UNIT)} || true"
    journal_cmd = (
        f"journalctl -u {shlex.quote(UNIT)} --since={WINDOW_SEC}s "
        "ago --no-pager --output=short-iso 2>/dev/null || true"
    )
    last_cmd = (
        f"journalctl -u {shlex.quote(UNIT)} -n 1 --no-pager "
        "--output=short-iso 2>/dev/null || true"
    )
    combined = f"({state_cmd}); echo ---SEP---; ({journal_cmd}); echo ---SEP---; ({last_cmd})"

    stdout, stderr = _ssh(combined, timeout=10)
    if not stdout:
        out["error"] = (stderr or "ssh empty")[:120]
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0

    parts = stdout.split("---SEP---")
    if len(parts) < 3:
        out["error"] = "unexpected ssh payload"
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0

    out["reachable"] = "yes"
    out["unit_state"] = parts[0].strip() or "unknown"

    journal_lines = [ln for ln in parts[1].splitlines() if ln.strip()]
    out["lines_window"] = len(journal_lines)

    err_re = re.compile(r"\b(ERROR|FATAL|CRITICAL|Traceback)\b", re.IGNORECASE)
    warn_re = re.compile(r"\bWARN(ING)?\b", re.IGNORECASE)
    out["errors_window"] = sum(1 for ln in journal_lines if err_re.search(ln))
    out["warns_window"] = sum(1 for ln in journal_lines if warn_re.search(ln))

    last = parts[2].strip().splitlines()
    if last:
        # Trim the syslog timestamp + hostname prefix to keep the label compact.
        line = last[-1]
        m = re.match(r"^\S+\s+\S+\s+(.*)$", line)
        out["last_line"] = (m.group(1) if m else line)[:140]

    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
