#!/usr/bin/env python3
"""wave-block — beautiful live TUI dashboard for palace-daemon jobs.

Usage:
    wave-block.py backfill [--url URL] [--key KEY] [--total N] [--interval S]
    wave-block.py custom   --title TITLE --cmd CMD [--parse JMESPATH] [--interval S]

The backfill subcommand polls /backfill-age/status and renders a live
progress dashboard.  The custom subcommand wraps any shell command that
emits JSON, rendering key metrics in the same visual frame.

This file is the CLI half of wave-block: polling loops, subprocess
launches, terminal detection (WaveTerm / Ghostty / inline), and the
argparse entry point. Pure rendering primitives — ANSI palette,
box-drawing, sparklines, BackfillState, render_backfill, _render_custom —
live in the sibling `renderer.py` module and can be imported standalone
by tests or alternate front-ends.

The file is invoked by absolute path (`python3 .../wave-block.py …`) by
the six hardcoded launcher shims and the seven manifest-driven verbs in
`plugins/wave/cli`. Keep its CLI surface and exit behavior stable.

Requires: Python 3.10+, no external deps (stdlib only).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time

# Renderer lives next to us — wave-block.py has a hyphen in its filename, so
# it can never be imported as a module itself, but renderer.py can. Adding
# our directory to sys.path lets us `import renderer` regardless of cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import renderer  # noqa: E402
from renderer import (  # noqa: E402
    BackfillState,
    C,
    clear_screen,
    hide_cursor,
    move_to,
    parse_backfill_status,
    render_backfill,
    render_host,
    show_cursor,
    term_height,
    _flatten_json,
    _on_resize,
    _render_custom,
)


# ── Polling ─────────────────────────────────────────────────────────────────

def fetch_backfill_status(url: str, api_key: str, cmd: str = "") -> dict:
    if cmd:
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
            return json.loads(result.stdout)
        except Exception as e:
            return {"error": str(e), "in_progress": False}
    import urllib.request
    req = urllib.request.Request(
        url,
        headers={"X-Api-Key": api_key} if api_key else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "in_progress": False}


def run_backfill_dashboard(url: str, api_key: str, total: int, interval: float, cmd: str = ""):
    signal.signal(signal.SIGWINCH, _on_resize)

    state = BackfillState(total_drawers=total)
    tick = 0

    hide_cursor()
    clear_screen()

    try:
        while True:
            data = fetch_backfill_status(url, api_key, cmd=cmd)
            if "error" in data and not data.get("in_progress"):
                state.in_progress = False
            else:
                parse_backfill_status(data, state)

            clear_screen()
            render_backfill(state, tick)
            tick += 1

            if not state.in_progress and state.poll_count > 1:
                move_to(term_height() - 1, 1)
                sys.stdout.write(f"\n{C['good']}  ✓ Backfill complete!{C['reset']}\n")
                sys.stdout.flush()
                break

            poll_start = time.monotonic()
            while time.monotonic() - poll_start < interval:
                time.sleep(0.15)
                tick += 1
                if renderer._resize_flag:
                    renderer._resize_flag = False
                    clear_screen()
                render_backfill(state, tick)

    except KeyboardInterrupt:
        pass
    finally:
        show_cursor()
        sys.stdout.write("\n")


# ── Custom mode ─────────────────────────────────────────────────────────────

def run_custom_dashboard(title: str, cmd: str, parse_path: str | None, interval: float):
    """Run an arbitrary command, parse JSON output, render as wave block."""
    signal.signal(signal.SIGWINCH, _on_resize)

    tick = 0
    metrics_history: dict[str, list[float]] = {}

    hide_cursor()
    clear_screen()

    try:
        while True:
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=10,
                )
                data = json.loads(result.stdout)
            except Exception as e:
                data = {"_error": str(e)}

            flat = _flatten_json(data)

            for k, v in flat.items():
                if isinstance(v, (int, float)):
                    metrics_history.setdefault(k, []).append(v)
                    if len(metrics_history[k]) > 120:
                        metrics_history[k] = metrics_history[k][-120:]

            clear_screen()
            _render_custom(title, flat, metrics_history, tick)
            tick += 1

            poll_start = time.monotonic()
            while time.monotonic() - poll_start < interval:
                time.sleep(0.15)
                tick += 1
                if renderer._resize_flag:
                    renderer._resize_flag = False
                    clear_screen()
                _render_custom(title, flat, metrics_history, tick)

    except KeyboardInterrupt:
        pass
    finally:
        show_cursor()
        sys.stdout.write("\n")


def run_host_dashboard(title: str, cmd: str, interval: float):
    """Run a host-collect-shaped command and render as the bar-heavy host TUI.

    Mirrors run_custom_dashboard's poll loop but routes the flattened metrics
    + history buffers through render_host, which prefers progress_bar over
    sparkline for *_pct fields and adds dedicated GPU / load / temp sections.
    """
    signal.signal(signal.SIGWINCH, _on_resize)

    tick = 0
    metrics_history: dict[str, list[float]] = {}

    hide_cursor()
    clear_screen()

    try:
        while True:
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=15,
                )
                data = json.loads(result.stdout)
            except Exception as e:
                data = {"_error": str(e)}

            flat = _flatten_json(data)

            for k, v in flat.items():
                if isinstance(v, (int, float)):
                    metrics_history.setdefault(k, []).append(v)
                    if len(metrics_history[k]) > 120:
                        metrics_history[k] = metrics_history[k][-120:]

            clear_screen()
            render_host(title, flat, metrics_history, tick)
            tick += 1

            poll_start = time.monotonic()
            while time.monotonic() - poll_start < interval:
                time.sleep(0.15)
                tick += 1
                if renderer._resize_flag:
                    renderer._resize_flag = False
                    clear_screen()
                render_host(title, flat, metrics_history, tick)

    except KeyboardInterrupt:
        pass
    finally:
        show_cursor()
        sys.stdout.write("\n")


# ── Terminal detection & launch ──────────────────────────────────────────────

def _detect_terminal() -> str:
    if os.environ.get("WAVETERM") == "1":
        return "waveterm"
    term_prog = os.environ.get("TERM_PROGRAM", "").lower()
    if "ghostty" in term_prog:
        return "ghostty"
    return "inline"

def _shell_quote(s: str) -> str:
    import shlex
    return shlex.quote(s)

def _find_wsh() -> str | None:
    candidates = [
        os.path.expanduser("~/.local/share/waveterm-dev/bin/wsh"),
        os.path.expanduser("~/.local/share/waveterm/bin/wsh"),
        shutil.which("wsh"),
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None

def _launch_in_waveterm(argv: list[str], env_vars: dict[str, str] | None = None):
    wsh = _find_wsh()
    if not wsh:
        print("wsh not found — falling back to inline mode", file=sys.stderr)
        return False

    cmd_parts = []
    if env_vars:
        for k, v in env_vars.items():
            cmd_parts.append(f"{k}={v}")
    cmd_parts.extend(_shell_quote(a) for a in argv)

    subprocess.Popen(
        [wsh, "run", "-c", " ".join(cmd_parts)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True

def _launch_in_ghostty(argv: list[str], env_vars: dict[str, str] | None = None):
    cmd_parts = []
    if env_vars:
        for k, v in env_vars.items():
            cmd_parts.append(f"export {k}='{v}';")
    cmd_parts.append(" ".join(_shell_quote(a) for a in argv))
    cmd_parts.append("; read -p 'Done. Press enter.'")
    shell_cmd = " ".join(cmd_parts)

    ghostty = shutil.which("ghostty") or "/snap/bin/ghostty"
    subprocess.Popen(
        [ghostty, "-e", "bash", "-c", shell_cmd],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return True


def _get_palace_api_key() -> str:
    key = os.environ.get("PALACE_API_KEY", "")
    if key:
        return key
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", "service", "palace-daemon", "type", "api-key"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _get_total_drawers(api_key: str, url_base: str) -> int:
    import urllib.request
    try:
        req = urllib.request.Request(
            url_base.replace("/backfill-age/status", "/palace/drawer-count"),
            headers={"X-Api-Key": api_key} if api_key else {},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            return data.get("count", 339_403)
    except Exception:
        return 339_403


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    # NB: do NOT install a no-op SIGINT handler here. The dashboard loops
    # rely on the default handler raising KeyboardInterrupt to break out of
    # `while True: time.sleep(0.15)`; swallowing SIGINT made Ctrl-C a no-op.

    parser = argparse.ArgumentParser(
        description="wave-block — beautiful live TUI dashboards",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    bf = sub.add_parser("backfill", help="AGE graph backfill progress")
    bf.add_argument("--url", default="http://familiar:8085/backfill-age/status")
    bf.add_argument("--key", default="")
    bf.add_argument("--total", type=int, default=0)
    bf.add_argument("--interval", type=float, default=10.0)
    bf.add_argument("--cmd", default="",
                    help="Poll a local command instead of --url (must emit same JSON shape)")
    bf.add_argument("--detach", action="store_true",
                    help="Launch in a new terminal block (WaveTerm/Ghostty) instead of inline")

    cu = sub.add_parser("custom", help="Custom JSON command dashboard")
    cu.add_argument("--title", required=True)
    cu.add_argument("--cmd", required=True)
    cu.add_argument("--parse", default=None)
    cu.add_argument("--interval", type=float, default=5.0)
    cu.add_argument("--detach", action="store_true",
                    help="Launch in a new terminal block (WaveTerm/Ghostty) instead of inline")

    ho = sub.add_parser("host", help="Per-host system dashboard (RAM/disk/GPU bars, temp sparklines)")
    ho.add_argument("--title", required=True)
    ho.add_argument("--cmd", required=True,
                    help="Shell command emitting JSON matching host-collect.py's schema")
    ho.add_argument("--interval", type=float, default=5.0)
    ho.add_argument("--detach", action="store_true",
                    help="Launch in a new terminal block (WaveTerm/Ghostty) instead of inline")

    args = parser.parse_args()

    if args.mode == "backfill":
        api_key = args.key or _get_palace_api_key()

        if args.detach:
            script = os.path.abspath(__file__)
            argv = ["python3", script, "backfill",
                    "--url", args.url,
                    "--key", api_key,
                    "--interval", str(args.interval)]
            if args.total:
                argv.extend(["--total", str(args.total)])
            if args.cmd:
                argv.extend(["--cmd", args.cmd])

            terminal = _detect_terminal()
            if terminal == "waveterm":
                if _launch_in_waveterm(argv, {"PALACE_API_KEY": api_key}):
                    print(f"Launched backfill dashboard in WaveTerm block")
                    return
            elif terminal == "ghostty":
                if _launch_in_ghostty(argv, {"PALACE_API_KEY": api_key}):
                    print(f"Launched backfill dashboard in Ghostty window")
                    return
            print("No detach target found — running inline")

        total = args.total or 339_403
        run_backfill_dashboard(args.url, api_key, total, args.interval, cmd=args.cmd)

    elif args.mode == "custom":
        if args.detach:
            script = os.path.abspath(__file__)
            argv = ["python3", script, "custom",
                    "--title", args.title,
                    "--cmd", args.cmd,
                    "--interval", str(args.interval)]

            terminal = _detect_terminal()
            if terminal == "waveterm":
                if _launch_in_waveterm(argv):
                    print(f"Launched '{args.title}' dashboard in WaveTerm block")
                    return
            elif terminal == "ghostty":
                if _launch_in_ghostty(argv):
                    print(f"Launched '{args.title}' dashboard in Ghostty window")
                    return
            print("No detach target found — running inline")

        run_custom_dashboard(args.title, args.cmd, args.parse, args.interval)

    elif args.mode == "host":
        if args.detach:
            script = os.path.abspath(__file__)
            argv = ["python3", script, "host",
                    "--title", args.title,
                    "--cmd", args.cmd,
                    "--interval", str(args.interval)]

            terminal = _detect_terminal()
            if terminal == "waveterm":
                if _launch_in_waveterm(argv):
                    print(f"Launched '{args.title}' dashboard in WaveTerm block")
                    return
            elif terminal == "ghostty":
                if _launch_in_ghostty(argv):
                    print(f"Launched '{args.title}' dashboard in Ghostty window")
                    return
            print("No detach target found — running inline")

        run_host_dashboard(args.title, args.cmd, args.interval)


if __name__ == "__main__":
    main()
