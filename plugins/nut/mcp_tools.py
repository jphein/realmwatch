"""MCP tools for the Astral Conduit — Ward of the Battery (NUT/UPS).

Shipped in the documented ``MCP_TOOLS = [(name, fn, description), ...]`` shape.
The tools call the running realmwatch HTTP server, so the map server must be up.
Both are read-only.
"""
import json
import os
import urllib.request

_BASE = f"http://localhost:{os.environ.get('REALM_PORT', '80')}"


def _get(path):
    with urllib.request.urlopen(_BASE + path, timeout=25) as r:
        return json.loads(r.read())


def nut_status() -> dict:
    """Live per-UPS status/load/watts/battery + the host(s) each UPS powers."""
    return _get("/ups-power")


def nut_doctor() -> dict:
    """Diagnose NUT health: disconnected drivers + upsmon MONITOR name mismatches."""
    return _get("/plugins/nut/doctor")


MCP_TOOLS = [
    ("nut_status", nut_status, "Live per-UPS status/load/watts/battery + powered hosts."),
    ("nut_doctor", nut_doctor, "Diagnose NUT: disconnected drivers + upsmon mismatches."),
]
TOOLS = MCP_TOOLS
