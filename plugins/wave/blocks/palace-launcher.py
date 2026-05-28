#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against palace-daemon status.

Invoked by `realm wave palace` (and `realm wave install palace`) via the
plugin dispatcher. We exec into wave-block.py with `custom` mode so the
mempalace_status response renders as paired metric rows (drawer count,
wing count, triples, daemon http ms) with sparkline history. The `status`
and `reachable` strings render as label rows.

Data source: palace-poll.py (same dir) — hits the palace-daemon MCP at
PALACE_DAEMON_URL (default http://familiar:8085) with PALACE_API_KEY
(auto-fetched from familiar's ~/.config/palace-daemon/env if unset).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLL = os.path.join(HERE, "palace-poll.py")

INTERVAL = os.environ.get("PALACE_INTERVAL", "5")
TITLE = os.environ.get("PALACE_TITLE", "MEMPALACE · familiar:8085")

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
