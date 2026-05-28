#!/usr/bin/env python3
"""Launch wave-block.py's render_backfill template against the KG-extract queue.

Invoked by `realm wave backfill` (and `realm wave install backfill`) via the
plugin dispatcher, which always calls scripts with the venv python. We exec
into wave-block.py with the right `backfill` mode arguments so the existing
polished renderer (wave banners, progress bar, sparklines, multi-worker)
displays our queue's progress + ETA.

The data source is kg-extract-poll.py (same dir), which emits the JSON shape
parse_backfill_status() expects.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLL = os.path.join(HERE, "kg-extract-poll.py")

# Approximate queue ceiling — used only as a fallback denominator if the
# poll's JSON doesn't carry total_drawers (it does, so this rarely matters).
# Updated periodically as the palace grows.
TOTAL = os.environ.get("KG_EXTRACT_TOTAL", "383090")

# Default poll cadence: 5s. Override via KG_EXTRACT_INTERVAL.
INTERVAL = os.environ.get("KG_EXTRACT_INTERVAL", "5")

os.execv(
    sys.executable,
    [
        sys.executable,
        WAVE_BLOCK,
        "backfill",
        "--cmd", f"{sys.executable} {POLL}",
        "--total", TOTAL,
        "--interval", INTERVAL,
    ],
)
