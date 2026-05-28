#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against palace-daemon log health.

Invoked by `realm wave daemon` (and `realm wave install daemon`) via the
plugin dispatcher. wave-block is a polling renderer, not a log tail, so
this turns the journal into a *status snapshot*: error/warn/line counts
over the last DAEMON_WINDOW_SEC seconds, unit ActiveState, and the most
recent log line as a label. For the raw streaming tail, ssh to familiar
and run `journalctl -fu palace-daemon` directly.

Data source: daemon-poll.py (same dir) — one ssh round-trip per poll.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLL = os.path.join(HERE, "daemon-poll.py")

INTERVAL = os.environ.get("DAEMON_INTERVAL", "5")
TITLE = os.environ.get("DAEMON_TITLE", "PALACE DAEMON · familiar journal")

os.execv(
    sys.executable,
    [
        sys.executable,
        WAVE_BLOCK,
        "custom",
        "--title", TITLE,
        "--cmd", f"{sys.executable} {POLL}",
        "--interval", INTERVAL,
    ],
)
