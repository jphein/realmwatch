#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against familiar sysmon JSON.

Invoked by `realm wave sysmon` (and `realm wave install sysmon`) via the
plugin dispatcher. We exec into wave-block.py with `custom` mode so the
auto-detected numeric fields (load, ram, disk, gpu temps, pg conns, …)
render as paired metric rows with sparkline history.

The data source is familiar-sysmon.sh (same dir), a one-line ssh shim
that runs sysmon-collect.py on the familiar host and emits a JSON blob.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
SHIM = os.path.join(HERE, "familiar-sysmon.sh")

INTERVAL = os.environ.get("SYSMON_INTERVAL", "3")
TITLE = os.environ.get("SYSMON_TITLE", "FAMILIAR SYSMON")

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
