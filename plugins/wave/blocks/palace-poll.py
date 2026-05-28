#!/usr/bin/env python3
"""Emit palace-daemon + mempalace_status as JSON for wave-block custom mode.

Hits the palace-daemon MCP at PALACE_DAEMON_URL (default http://familiar:8085)
with PALACE_API_KEY (auto-fetched from familiar's ~/.config/palace-daemon/env
if not set in the local env). Returns a flat dict suitable for wave-block's
auto-detect renderer: numeric fields become metric rows with sparklines,
string fields render as labels.

Output schema:
  status            "OK" | "DEGRADED" | "DAEMON_DOWN" | "EMPTY"
  drawers           int   total drawer count in the palace
  wings             int   wing count
  rooms             int   room count (if returned)
  triples           int   knowledge-graph triple count (if returned)
  daemon_http_ms    float HTTP round-trip ms to /mcp tools/list
  reachable         "yes" | "no"
  error             string (only present on failure)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

URL = os.environ.get("PALACE_DAEMON_URL", "http://familiar:8085")
FAMILIAR_HOST = os.environ.get("PALACE_DAEMON_HOST", "jp@familiar")
TIMEOUT = float(os.environ.get("PALACE_POLL_TIMEOUT", "6"))


def _fetch_api_key() -> str:
    if v := os.environ.get("PALACE_API_KEY", "").strip():
        return v
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "ConnectTimeout=4", FAMILIAR_HOST,
             'sed -n "s/^PALACE_API_KEY=//p" ~/.config/palace-daemon/env'],
            timeout=8, stderr=subprocess.DEVNULL,
        )
        key = out.decode().strip().strip('"').strip("'")
        if key:
            os.environ["PALACE_API_KEY"] = key
        return key
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError):
        return ""


def _mcp_call(api_key: str, tool: str, arguments: dict | None = None) -> tuple[dict | None, float, str]:
    """POST a JSON-RPC tools/call to /mcp. Returns (result, elapsed_ms, error)."""
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000),
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments or {}},
    }
    req = urllib.request.Request(
        f"{URL.rstrip('/')}/mcp",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": api_key,
        },
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            elapsed_ms = (time.monotonic() - started) * 1000
            body = json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
            json.JSONDecodeError, OSError) as e:
        return None, (time.monotonic() - started) * 1000, str(e)

    # MCP responses wrap content in result.content[0].text (JSON string).
    result = body.get("result", {}) if isinstance(body, dict) else {}
    content = result.get("content", []) if isinstance(result, dict) else []
    if content and isinstance(content[0], dict):
        text = content[0].get("text", "")
        try:
            return json.loads(text), elapsed_ms, ""
        except json.JSONDecodeError:
            return {"_raw": text}, elapsed_ms, ""
    return result, elapsed_ms, ""


def main() -> int:
    api_key = _fetch_api_key()
    out: dict = {"reachable": "no"}

    if not api_key:
        out["status"] = "DAEMON_DOWN"
        out["error"] = "no PALACE_API_KEY"
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0

    result, elapsed_ms, err = _mcp_call(api_key, "mempalace_status")
    out["daemon_http_ms"] = round(elapsed_ms, 1)

    if err:
        out["status"] = "DAEMON_DOWN"
        out["error"] = err[:120]
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0

    out["reachable"] = "yes"

    if not isinstance(result, dict):
        out["status"] = "DEGRADED"
        out["error"] = "non-dict mempalace_status payload"
        json.dump(out, sys.stdout)
        sys.stdout.write("\n")
        return 0

    def _count(*keys: str) -> int:
        # mempalace_status returns wings/rooms as dicts (name → count) and
        # drawer/triple totals as ints. Coerce uniformly: dict → len(); list
        # → len(); numeric → int(); anything else → 0.
        for k in keys:
            v = result.get(k)
            if v is None:
                continue
            if isinstance(v, dict):
                return len(v)
            if isinstance(v, list):
                return len(v)
            if isinstance(v, (int, float)):
                return int(v)
            if isinstance(v, str) and v.strip().lstrip("-").isdigit():
                return int(v.strip())
        return 0

    drawers = _count("drawer_count", "drawers", "total_drawers")
    wings = _count("wing_count", "wings", "total_wings")
    rooms = _count("room_count", "rooms", "total_rooms")
    triples = _count("triple_count", "triples", "total_triples")

    if drawers == 0 and wings == 0:
        out["status"] = "EMPTY"
    else:
        out["status"] = "OK"

    out["drawers"] = drawers
    out["wings"] = wings
    if rooms > 0:
        out["rooms"] = rooms
    if triples > 0:
        out["triples"] = triples

    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
