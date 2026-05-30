#!/usr/bin/env python3
"""Launch wave-block.py's slate dashboard against the SME benchmark slate.

Invoked by `realm wave benchmark` (and `realm wave install benchmark`) via
the plugin dispatcher. We exec into wave-block.py with `slate` mode, which
renders the structured benchmark slate (status sigils, metric chips, slate
progress bar, structural-category strip) rather than auto-detected metric
rows.

The data source is benchmark-poll.py (same dir): it reads a small JSON
status file the SME eval runs write — $REALM_BENCHMARK_SLATE, else
~/.realmwatch/benchmark-slate.json, else the shipped
benchmark-slate.example.json fallback.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLLER = os.path.join(HERE, "benchmark-poll.py")

INTERVAL = os.environ.get("BENCHMARK_INTERVAL", "15")
TITLE = os.environ.get("BENCHMARK_TITLE", "SME Benchmark Slate")

os.execv(
    sys.executable,
    [
        sys.executable,
        WAVE_BLOCK,
        "slate",
        "--title", TITLE,
        "--cmd", f"{sys.executable} {POLLER}",
        "--interval", INTERVAL,
    ],
)
