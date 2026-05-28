#!/usr/bin/env python3
"""SSH into WAVE_HOST and run host-collect.py via piped stdin.

Lets `realm wave <host>` work against any fleet entry without deploying
anything to the target — we stream host-collect.py over ssh stdin every
poll. If WAVE_HOST matches the local hostname, runs the collector locally
(no ssh hop).

Config:
  WAVE_HOST            target host (current_name or fleet_id, or any
                       host SSH-reachable as `<WAVE_SSH_USER>@<host>`)
  WAVE_SSH_USER        ssh user (default jp)
  WAVE_HOST_TIMEOUT    per-poll ssh timeout in seconds (default 8)

The collector script itself is stdlib-only Python 3.10+; the target needs
python3 on PATH (most hosts; OpenWrt APs may lack it — those will surface
as `{"_error": "...remote python..."}`).
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COLLECTOR = os.path.join(HERE, "host-collect.py")

HOST = os.environ.get("WAVE_HOST", "").strip()
USER = os.environ.get("WAVE_SSH_USER", "jp")
TIMEOUT = int(os.environ.get("WAVE_HOST_TIMEOUT", "8"))


def _is_local(target: str) -> bool:
    """True if target resolves to the same machine we're running on."""
    if not target:
        return False
    try:
        local = socket.gethostname()
    except OSError:
        local = ""
    short = local.split(".", 1)[0]
    return target.lower() in (local.lower(), short.lower(), "localhost", "127.0.0.1")


def main() -> int:
    if not HOST:
        json.dump({"_error": "WAVE_HOST env var not set"}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    try:
        with open(COLLECTOR) as f:
            script = f.read()
    except OSError as e:
        json.dump({"_error": f"collector missing: {e}", "host": HOST},
                  sys.stdout)
        sys.stdout.write("\n")
        return 1

    if _is_local(HOST):
        # Skip the ssh hop — run the collector directly with stdin piped.
        cmd = [sys.executable, "-"]
        try:
            r = subprocess.run(
                cmd, input=script, capture_output=True, text=True,
                timeout=TIMEOUT,
            )
            out = r.stdout
        except Exception as e:
            json.dump({"_error": f"local exec failed: {e}", "host": HOST},
                      sys.stdout)
            sys.stdout.write("\n")
            return 1
    else:
        target = HOST if "@" in HOST else f"{USER}@{HOST}"
        try:
            r = subprocess.run(
                ["ssh", "-o", "ConnectTimeout=4",
                 "-o", "BatchMode=yes",
                 target, "python3 -"],
                input=script, capture_output=True, text=True,
                timeout=TIMEOUT,
            )
            out = r.stdout
        except subprocess.TimeoutExpired:
            json.dump({"_error": f"ssh timeout ({TIMEOUT}s)", "host": HOST},
                      sys.stdout)
            sys.stdout.write("\n")
            return 1
        except Exception as e:
            json.dump({"_error": f"ssh failed: {e}", "host": HOST}, sys.stdout)
            sys.stdout.write("\n")
            return 1

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        json.dump(
            {"_error": "remote python returned non-JSON", "host": HOST,
             "preview": out[:200]},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 1

    # Echo the target hostname into the payload so the wave-block label
    # always shows which host we're looking at, even when the remote's
    # uname disagrees with the fleet name.
    data["wave_host"] = HOST
    json.dump(data, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
