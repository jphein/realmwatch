#!/usr/bin/env python3
"""palace-daemon journal tail.

Streams `journalctl -fu palace-daemon` from disks. On disconnect, retries
with exponential backoff up to MAX_BACKOFF seconds.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time

HOST = os.environ.get("PALACE_DAEMON_HOST", "jp@disks.jphe.in")
UNIT = os.environ.get("PALACE_DAEMON_UNIT", "palace-daemon")
MAX_BACKOFF = 30


def banner():
    sys.stdout.write("\033[36m")
    sys.stdout.write("=" * 70 + "\n")
    sys.stdout.write(f"  palace-daemon journal — {HOST} :: {UNIT}\n")
    sys.stdout.write("=" * 70 + "\n\033[0m\n")
    sys.stdout.flush()


def main() -> int:
    banner()
    backoff = 1
    while True:
        cmd = [
            "ssh", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4",
            HOST, f"journalctl -fu {UNIT} --no-hostname -o short-iso",
        ]
        try:
            proc = subprocess.Popen(cmd)
            ret = proc.wait()
            if ret == 130 or ret == -signal.SIGINT:
                return 130
            sys.stdout.write(
                f"\n\033[33m[journal] ssh exited with code {ret}; "
                f"reconnecting in {backoff}s\033[0m\n"
            )
            sys.stdout.flush()
        except KeyboardInterrupt:
            return 130
        except (OSError, FileNotFoundError) as e:
            sys.stdout.write(
                f"\n\033[31m[journal] ssh launch failed: {e}; "
                f"retrying in {backoff}s\033[0m\n"
            )
            sys.stdout.flush()
        time.sleep(backoff)
        backoff = min(MAX_BACKOFF, backoff * 2)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.exit(130)
