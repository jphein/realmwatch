#!/usr/bin/env python3
"""Launch wave-block.py's custom dashboard against gatekeeper WAN bandwidth.

Invoked by `realm wave bandwidth` (and `realm wave install bandwidth`) via
the plugin dispatcher. We exec into wave-block.py with `custom` mode so the
auto-detect renderer turns rx_Mbps / tx_Mbps into paired metric rows with
sparkline history.

Data source: bandwidth-poll.py (same dir) — wraps `realm collectd show --json`
and extracts the gatekeeper br-lan.38 (WAN trunk) rx/tx counters.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WAVE_BLOCK = os.path.join(HERE, "wave-block.py")
POLL = os.path.join(HERE, "bandwidth-poll.py")

INTERVAL = os.environ.get("BANDWIDTH_INTERVAL", "2")
TITLE = os.environ.get("BANDWIDTH_TITLE", "WAN BANDWIDTH · gatekeeper br-lan.38")

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
