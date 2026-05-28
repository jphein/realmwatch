#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against familiar KG-ops JSON.

Invoked by `realm wave kgops` (and `realm wave install kgops`) via the
plugin dispatcher. We exec into wave-block.py with `custom` mode so the
sysmon metrics + KG-extract queue counts + per-worker activity flags all
render as auto-detected numeric/string rows with sparkline history.

The data source is familiar-kgops.sh (same dir), a one-line ssh shim
that runs kgops-collect.py on the familiar host and emits a JSON blob
(everything sysmon emits plus kg_completed/incomplete/errors/total_triples/
rate_per_min and worker_<N>=active|inactive entries).
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
SHIM = os.path.join(HERE, "familiar-kgops.sh")

INTERVAL = os.environ.get("KGOPS_INTERVAL", "5")
TITLE = os.environ.get("KGOPS_TITLE", "FAMILIAR KGOPS")

os.execv(
    sys.executable,
    [
        sys.executable,
        WAVE_BLOCK,
        "custom",
        "--title", TITLE,
        "--cmd", f"bash {SHIM}",
        "--interval", INTERVAL,
    ],
)
