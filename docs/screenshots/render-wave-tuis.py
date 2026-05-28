#!/usr/bin/env python3
"""Render static Wave Terminal TUI screenshots without a real terminal.

Each Wave TUI in `plugins/wave/tuis/` builds its frame from a pure
`render(...)` function backed by Rich. We can import that function,
feed it mocked state, and have Rich emit a single SVG frame
(`Console(record=True).export_svg()`). The SVG is then rasterised to
PNG via `inkscape` (already on the host).

Outputs to docs/screenshots/:
  wave-bandwidth.svg / .png
  wave-palace.svg    / .png
  wave-daemon.svg    / .png

Re-run after touching a TUI's render code.

  cd ~/Projects/realmwatch
  .venv/bin/python3 docs/screenshots/render-wave-tuis.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # repo root
TUIS = ROOT / "plugins" / "wave" / "tuis"
OUT = Path(__file__).resolve().parent
WIDTH = 120
HEIGHT = 30

sys.path.insert(0, str(TUIS))


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def svg_to_png(svg: Path, png: Path) -> bool:
    """Convert SVG → PNG via inkscape (preferred) or ImageMagick."""
    if have("inkscape"):
        # 2x DPI for crisp text on retina/HiDPI displays.
        r = subprocess.run(
            ["inkscape", "--export-type=png",
             f"--export-filename={png}",
             "--export-dpi=120",
             str(svg)],
            capture_output=True, text=True,
        )
        return r.returncode == 0
    if have("convert"):
        r = subprocess.run(
            ["convert", "-density", "120", str(svg), str(png)],
            capture_output=True, text=True,
        )
        return r.returncode == 0
    print("WARN: no inkscape or convert on PATH — skipping PNG.", file=sys.stderr)
    return False


def emit(name: str, title: str, renderable) -> None:
    """Export a Rich renderable to SVG + PNG."""
    from rich.console import Console
    console = Console(
        record=True, width=WIDTH, height=HEIGHT,
        force_terminal=True, force_interactive=False,
    )
    console.print(renderable)
    svg = OUT / f"wave-{name}.svg"
    png = OUT / f"wave-{name}.png"
    console.save_svg(str(svg), title=title)
    print(f"  {svg.relative_to(ROOT)}  ({svg.stat().st_size:,} bytes)")
    if svg_to_png(svg, png):
        print(f"  {png.relative_to(ROOT)}  ({png.stat().st_size:,} bytes)")


def render_bandwidth() -> None:
    import bandwidth as bw  # type: ignore
    rx_hist = deque([1.5e8 + 2e7 * ((i % 30) / 30) for i in range(120)], maxlen=4096)
    tx_hist = deque([4e7 + 3e6 * ((i * 7 % 30) / 30) for i in range(120)], maxlen=4096)
    long_rx = deque([1.4e8, 1.6e8, 1.55e8, 1.7e8, 1.62e8, 1.5e8], maxlen=4096)
    long_tx = deque([3.5e7, 4.1e7, 3.9e7, 4.3e7, 4.0e7, 3.8e7], maxlen=4096)
    last = {
        "rx_bps": 1.65e8, "tx_bps": 4.2e7,
        "load_1": 0.42, "ping_ms": 8.3, "ping_drop": 0,
        "uptime_s": 86400 * 7 + 3600 * 4,
        "temp_c": 48, "conntrack": 1842,
    }
    now = time.time()
    panel = bw.render(rx_hist, tx_hist, long_rx, long_tx,
                      last, now - 2, now - 2, WIDTH, HEIGHT)
    emit("bandwidth", "Wave Terminal — realm wave bandwidth", panel)


def render_palace() -> None:
    import palace_status as ps  # type: ignore
    state = {
        "status": "ok",
        "drawers": 4218,
        "wings": 47,
        "tools": 22,
        "last_ok_age": 3.0,
        "message": "familiar",
    }
    panel = ps.render(state, WIDTH, HEIGHT)
    emit("palace", "Wave Terminal — realm wave palace", panel)


def render_daemon() -> None:
    """daemon_log.py is a plain stream tail with ANSI; mock a Panel of recent
    journal lines instead of importing it (it has no `render()` function)."""
    from rich.console import Group
    from rich.panel import Panel
    from rich.text import Text
    from rich.align import Align

    lines = [
        ("2026-05-27T20:14:02+01:00", "info",  "palace-daemon", "started v0.6.3 (postgres backend, hnsw enabled)"),
        ("2026-05-27T20:14:03+01:00", "info",  "palace-daemon", "loaded 4218 drawers across 47 wings"),
        ("2026-05-27T20:14:03+01:00", "info",  "mcp",           "listening on http://0.0.0.0:8085/mcp (22 tools registered)"),
        ("2026-05-27T20:14:18+01:00", "info",  "search",        "hybrid query 'realmwatch plugin system' (vector+bm25+graph) → 5 hits in 38ms"),
        ("2026-05-27T20:14:31+01:00", "info",  "kg",            "added (Max, started_school, Year 7, 2026-09-01)"),
        ("2026-05-27T20:14:46+01:00", "info",  "drawer",        "filed wing_realmwatch/architecture (12 KB, dedup=0.91 — kept)"),
        ("2026-05-27T20:15:01+01:00", "info",  "checkpoint",    "diary write: agent=davis topic=ship-pipeline (★★★)"),
        ("2026-05-27T20:15:14+01:00", "info",  "search",        "hybrid query 'wave terminal tui' → 8 hits in 41ms"),
        ("2026-05-27T20:15:29+01:00", "warn",  "embed",         "azure-ai rate limited (429), backing off 2.0s"),
        ("2026-05-27T20:15:31+01:00", "info",  "embed",         "recovered — batch of 12 embedded in 480ms"),
        ("2026-05-27T20:15:48+01:00", "info",  "tunnel",        "passive tunnel detected: realmwatch.problems ↔ ha.problems"),
        ("2026-05-27T20:16:03+01:00", "info",  "search",        "hybrid query 'tide singers' → 3 hits in 22ms"),
    ]

    body_lines: list[Text] = []
    for ts, lvl, mod, msg in lines:
        t = Text()
        t.append(ts, style="dim")
        t.append("  ")
        lvl_style = {"info": "cyan", "warn": "yellow", "err": "red"}.get(lvl, "white")
        t.append(f"{lvl:<5}", style=f"bold {lvl_style}")
        t.append(" ")
        t.append(f"{mod:<12}", style="magenta")
        t.append(" ")
        t.append(msg, style="white")
        body_lines.append(t)

    header = Text()
    header.append("palace-daemon", style="bold cyan")
    header.append("  ", style="")
    header.append("jp@familiar :: journalctl -fu palace-daemon", style="dim cyan")

    footer = Text(
        "ssh reconnect: ✓ alive · ServerAliveInterval=30 · ctrl-c to exit",
        style="dim", justify="right",
    )
    panel = Panel(
        Group(*body_lines, Text(""), footer),
        title=header,
        title_align="left",
        border_style="cyan",
        padding=(1, 2),
    )
    emit("daemon", "Wave Terminal — realm wave daemon", panel)


def main() -> int:
    if not TUIS.is_dir():
        print(f"ERROR: TUIs dir not found at {TUIS}", file=sys.stderr)
        return 2
    try:
        import rich  # noqa: F401
    except ImportError:
        print("ERROR: rich not importable. Run from the project venv:\n"
              "  .venv/bin/python3 docs/screenshots/render-wave-tuis.py",
              file=sys.stderr)
        return 2
    print(f"Rendering wave TUIs at {WIDTH}×{HEIGHT} → {OUT.relative_to(ROOT)}/")
    render_bandwidth()
    render_palace()
    render_daemon()
    print("\nDone. SVG is the source of truth (scales perfectly); PNG is the"
          " fallback for README rendering on github.com.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
