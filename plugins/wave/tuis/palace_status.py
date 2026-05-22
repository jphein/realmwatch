#!/usr/bin/env python3
"""Palace-daemon status TUI.

Polls http://disks.jphe.in:8085/mcp every 5s and renders:
  - daemon reachability (HTTP 200 on /mcp tools/list)
  - mempalace_status response (drawer count, wing count, error if any)
  - reality-check via ssh + psql when daemon reports "No palace found"
    (distinguishes daemon misconfigured from postgres truly empty)

Config:
  PALACE_DAEMON_URL  default http://disks.jphe.in:8085
  PALACE_API_KEY     auto-fetched from disks (~/.config/palace-daemon/env)
                     if not in env. Cached in process for the session.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from typing import Optional

from rich.align import Align
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

URL = os.environ.get("PALACE_DAEMON_URL", "http://disks.jphe.in:8085")
DISKS_HOST = os.environ.get("PALACE_DAEMON_HOST", "jp@disks.jphe.in")
REFRESH_S = 5.0


def fetch_api_key() -> str:
    """Pull the API key from disks once at startup. Returns '' if unavailable."""
    if v := os.environ.get("PALACE_API_KEY"):
        return v
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "ConnectTimeout=4", DISKS_HOST,
             'sed -n "s/^PALACE_API_KEY=//p" ~/.config/palace-daemon/env'],
            timeout=8, stderr=subprocess.DEVNULL,
        )
        return out.decode().strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError):
        return ""


def mcp_call(api_key: str, tool: str, args: Optional[dict] = None,
             timeout: float = 4.0) -> dict:
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args or {}},
    }).encode()
    req = urllib.request.Request(
        f"{URL}/mcp",
        data=body,
        headers={"content-type": "application/json", "x-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def mcp_tools_list(api_key: str, timeout: float = 4.0) -> Optional[dict]:
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {},
    }).encode()
    req = urllib.request.Request(
        f"{URL}/mcp",
        data=body,
        headers={"content-type": "application/json", "x-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def reality_check_postgres() -> str:
    """When daemon says 'no palace', ask postgres directly. Returns '?' on failure."""
    cmd = (
        'DSN=$(grep -oE "MEMPALACE_POSTGRES_DSN=\\S+" ~/.config/palace-daemon/env '
        '| cut -d= -f2- | head -1); '
        '[ -n "$DSN" ] && psql "$DSN" -tAc "SELECT count(*) FROM drawers" '
        '2>/dev/null || echo "?"'
    )
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "ConnectTimeout=4", DISKS_HOST, cmd],
            timeout=8, stderr=subprocess.DEVNULL,
        )
        return out.decode().strip() or "?"
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            FileNotFoundError):
        return "?"


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def render(state: dict, term_w: int, term_h: int) -> Panel:
    status = state["status"]
    color_map = {
        "ok":     "green",
        "stale":  "yellow",
        "no_palace": "yellow",
        "down":   "red",
        "auth":   "red",
        "error":  "red",
        "init":   "dim",
    }
    border = color_map.get(status, "cyan")

    inner_w = max(20, term_w - 6)

    # Header
    title = Text()
    title.append("palace-daemon", style="bold cyan")
    if inner_w >= 50:
        title.append("  ", style="")
        title.append(URL, style="dim cyan")

    # Status pill
    pill = Text()
    label = {
        "ok": "● OK",
        "stale": "● STALE",
        "no_palace": "● NO PALACE",
        "down": "● DOWN",
        "auth": "● AUTH FAIL",
        "error": "● ERROR",
        "init": "● init…",
    }.get(status, status.upper())
    pill.append(label, style=f"bold {border}")
    title.append("   ")
    title.append_text(pill)

    # Body: a key/value table that survives narrow widths.
    kv = Table.grid(padding=(0, 2))
    kv.add_column(justify="right", style="dim")
    kv.add_column(justify="left")

    def row(k, v, style=None):
        text = Text(str(v), style=style) if not isinstance(v, Text) else v
        kv.add_row(k, text)

    msg = state.get("message", "")
    drawers = state.get("drawers")
    wings = state.get("wings")
    pg_count = state.get("pg_count")
    last_ok_age = state.get("last_ok_age")
    tools = state.get("tools")
    err = state.get("error")

    if drawers is not None:
        row("drawers", f"{drawers:,}", style="bold green")
    if wings is not None:
        row("wings", f"{wings}", style="bold")
    if tools is not None:
        row("mcp tools", f"{tools}", style="bold cyan")
    if pg_count is not None:
        row("postgres", f"{pg_count} drawers (direct probe)",
            style="yellow" if pg_count == "?" else "bold")
    if last_ok_age is not None:
        row("last ok", f"{last_ok_age:.0f}s ago",
            style="yellow" if last_ok_age > 30 else "dim")
    if err:
        row("error", err, style="red")
    if msg and not err:
        row("message", msg)

    parts = [Align.left(kv)]

    # Footer
    parts.append(Text(""))
    parts.append(Text(
        f"refresh {REFRESH_S:.0f}s   ·   ctrl-c to exit",
        style="dim", justify="right"
    ))

    return Panel(
        Group(*parts),
        title=title,
        title_align="left",
        border_style=border,
        padding=(1, 2),
    )


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def main():
    api_key = fetch_api_key()
    if not api_key:
        print(f"ERROR: no PALACE_API_KEY in env and could not pull from {DISKS_HOST}")
        return 1

    state = {"status": "init", "message": "fetching first sample…"}
    last_ok = 0.0
    console = Console()

    def cur():
        size = shutil.get_terminal_size((80, 24))
        s = dict(state)
        if last_ok:
            s["last_ok_age"] = time.time() - last_ok
        return render(s, size.columns, size.lines)

    with Live(cur(), refresh_per_second=4, screen=False, console=console) as live:
        while True:
            new_state = {"status": "init"}

            # 1. Reachability via tools/list
            try:
                tl = mcp_tools_list(api_key)
                tools = len((tl or {}).get("result", {}).get("tools", []))
                new_state["tools"] = tools
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    new_state.update(status="auth", error="HTTP 401 (bad key)")
                else:
                    new_state.update(status="down",
                                     error=f"HTTP {e.code} on /mcp tools/list")
                state.update(new_state); live.update(cur()); time.sleep(REFRESH_S); continue
            except (urllib.error.URLError, ConnectionError, OSError) as e:
                new_state.update(status="down", error=f"unreachable: {e}")
                state.update(new_state); live.update(cur()); time.sleep(REFRESH_S); continue

            # 2. mempalace_status
            try:
                mp = mcp_call(api_key, "mempalace_status")
                txt = (mp or {}).get("result", {}).get("content", [{}])[0].get("text", "")
                inner = json.loads(txt) if txt.lstrip().startswith("{") else {}
            except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
                new_state.update(status="error", error=f"mempalace_status: {e}")
                state.update(new_state); live.update(cur()); time.sleep(REFRESH_S); continue

            if "error" in inner:
                pg = reality_check_postgres()
                new_state.update(
                    status="no_palace",
                    error=inner.get("error", "no palace"),
                    pg_count=pg,
                )
            else:
                drawers = inner.get("total_drawers") or inner.get("drawers")
                wings = (inner.get("wings") or [])
                wing_count = len(wings) if isinstance(wings, list) else wings
                new_state.update(
                    status="ok",
                    drawers=drawers,
                    wings=wing_count,
                    message=inner.get("hostname", "")
                )
                last_ok = time.time()

            state.update(new_state)
            live.update(cur())
            time.sleep(REFRESH_S)


if __name__ == "__main__":
    try:
        raise SystemExit(main() or 0)
    except KeyboardInterrupt:
        pass
