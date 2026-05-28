#!/usr/bin/env python3
"""Emit gatekeeper br-lan.38 WAN bandwidth as JSON for wave-block custom mode.

Polls `realm collectd show --json` and extracts the rx/tx bps for the
gatekeeper WAN trunk (VLAN 38, br-lan.38). Converts bytes/s → Mbps so the
sparkline range stays human-readable.

Source: gatekeeper.interfaces.br-lan.38.{rx_bps,tx_bps}
Output: {"rx_Mbps": <float>, "tx_Mbps": <float>, "rx_bps": <int>, "tx_bps": <int>,
         "iface": "br-lan.38", "host": "gatekeeper"}
"""
from __future__ import annotations

import json
import subprocess
import sys


def main() -> int:
    try:
        out = subprocess.check_output(
            ["realm", "collectd", "show", "--json"],
            timeout=10,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError):
        json.dump({"_error": "realm collectd show failed", "iface": "br-lan.38"},
                  sys.stdout)
        sys.stdout.write("\n")
        return 1

    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        json.dump({"_error": "non-JSON output", "iface": "br-lan.38"}, sys.stdout)
        sys.stdout.write("\n")
        return 1

    # Walk gatekeeper.interfaces.br-lan.38
    gk = data.get("gatekeeper", {}) if isinstance(data, dict) else {}
    ifaces = gk.get("interfaces", {}) if isinstance(gk, dict) else {}
    wan = ifaces.get("br-lan.38", {}) if isinstance(ifaces, dict) else {}

    rx_bps = int(wan.get("rx_bps", 0) or 0)
    tx_bps = int(wan.get("tx_bps", 0) or 0)

    json.dump({
        "host": "gatekeeper",
        "iface": "br-lan.38",
        "rx_Mbps": round(rx_bps / 1_000_000, 2),
        "tx_Mbps": round(tx_bps / 1_000_000, 2),
        "rx_bps": rx_bps,
        "tx_bps": tx_bps,
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
