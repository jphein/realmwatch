#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against any fleet host.

Invoked by `realm wave <hostname>` via the plugin dispatcher (which sets
WAVE_HOST to the verb name). Exec's into wave-block.py with `custom` mode
so the auto-detect renderer pairs numeric fields (load, RAM, GPU, disk,
temps, net) into metric rows with sparkline history, and renders string
fields (distro, kernel, hostname) as label rows.

Data source: host-poll.py (same dir) — ssh's into the target and runs
host-collect.py via piped stdin (no remote deployment).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLL = os.path.join(HERE, "host-poll.py")

HOST = os.environ.get("WAVE_HOST", "").strip()
if not HOST:
    sys.exit(
        "wave host-launcher: WAVE_HOST env var not set. "
        "Invoke as `realm wave <hostname>` (the dispatcher sets it for you)."
    )

INTERVAL = os.environ.get("HOST_INTERVAL", "5")
TITLE = os.environ.get("HOST_TITLE", f"HOST · {HOST}")

os.execv(
    sys.executable,
    [
        sys.executable,
        WAVE_BLOCK,
        "host",
        "--title", TITLE,
        "--cmd", f"{sys.executable} {POLL}",
        "--interval", INTERVAL,
    ],
)
