"""MCP tools for the Astral Conduit — wake / slumber / status of fleet hosts.

Shipped in the documented ``MCP_TOOLS = [(name, fn, description), ...]`` shape
(matching plugins/palace). The tools call the running realmwatch HTTP server,
so the map server must be up for these to act.
"""
import json
import os
import urllib.request

_BASE = f"http://localhost:{os.environ.get('REALM_PORT', '80')}"


def _post(path, body):
    req = urllib.request.Request(_BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())


def _get(path):
    with urllib.request.urlopen(_BASE + path, timeout=25) as r:
        return json.loads(r.read())


def wol_status() -> dict:
    """Power state (awake/slumbering/waking/dark) of all WoL-managed fleet hosts."""
    return _get("/plugins/wol/status")


def wol_wake(target: str) -> dict:
    """Wake a host via a Wake-on-LAN magic packet (mutating). target = MAC or fleet name/id."""
    return _post("/wol", {"target": target})


def wol_sleep(target: str) -> dict:
    """Suspend a sleepable, WoL-armed fleet host to S3 (mutating). target = fleet name/id."""
    return _post("/plugins/wol/sleep", {"target": target})


MCP_TOOLS = [
    ("wol_status", wol_status, "Power state of all WoL-managed fleet hosts."),
    ("wol_wake", wol_wake, "Wake a fleet host via WoL magic packet (mutating)."),
    ("wol_sleep", wol_sleep, "Suspend a sleepable fleet host to S3 (mutating)."),
]
TOOLS = MCP_TOOLS
