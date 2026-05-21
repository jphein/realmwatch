#!/usr/bin/env python3
"""WAN bandwidth TUI — adaptive layout for any terminal size.

Source: gatekeeper's br-lan.38 (WAN trunk, VLAN 38) via
`realm collectd show --json`. Polls every REFRESH_S seconds; collectd updates
every 30s so successive samples often repeat — that's intentional, the
sparkline shows shape, not sample-rate fidelity.

Design
------
- History buffer auto-grows up to the widest viewport ever rendered,
  so making the window wider never shows truncated history.
- Sparklines fill the available width.
- At tall terminals (>= 4 free rows) a 30s-bucketed long-window pair is
  added below the live pair.
- At wide terminals (>= 100 cols) a per-direction stats column appears
  flanking the big numbers.
- Header drops fields right-to-left as width shrinks.
- If the data source goes stale (>120s without a fresh sample) the
  border + header turn red and the staleness is reported.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from collections import deque
from typing import Optional

from rich.align import Align
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

REALM_CMD = ["realm", "collectd", "show", "--json"]
HOST = "gatekeeper"
IFACE = "br-lan.38"
REFRESH_S = 2.0
STALE_S = 120  # seconds without fresh sample before red
MAX_HISTORY = 4096  # ~2.3 hours at 2s refresh — generous cap
LONG_BUCKET_S = 30  # seconds per long-window sparkline bucket

SPARK = " ▁▂▃▄▅▆▇█"


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
def fetch() -> Optional[dict]:
    try:
        out = subprocess.check_output(REALM_CMD, timeout=8, stderr=subprocess.DEVNULL)
        d = json.loads(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired,
            json.JSONDecodeError, FileNotFoundError):
        return None
    gk = d.get(HOST) or {}
    ifs = gk.get("interfaces") or {}
    iface = ifs.get(IFACE)
    if not iface:
        return None
    return {
        "rx_bps": float(iface.get("rx_bps", 0)),
        "tx_bps": float(iface.get("tx_bps", 0)),
        "load_1": gk.get("load_1"),
        "ping_ms": (gk.get("ping") or {}).get("8.8.8.8"),
        "ping_drop": (gk.get("ping_drop") or {}).get("8.8.8.8"),
        "uptime_s": gk.get("uptime"),
        "temp_c": gk.get("temp"),
        "conntrack": gk.get("conntrack"),
    }


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #
def fmt_bps(bps: float) -> Text:
    """Color-coded bps string (green/yellow/red by magnitude)."""
    color = "green"
    if bps >= 100_000_000:
        color = "red"
    elif bps >= 10_000_000:
        color = "yellow"
    if bps >= 1_000_000_000:
        s = f"{bps/1e9:.2f} Gbps"
    elif bps >= 1_000_000:
        s = f"{bps/1e6:.2f} Mbps"
    elif bps >= 1_000:
        s = f"{bps/1e3:.2f} Kbps"
    else:
        s = f"{bps:.0f}  bps"
    return Text(s, style=color)


def fmt_bytes(b: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} PB"


def fmt_uptime(s: Optional[float]) -> str:
    if s is None:
        return "?"
    s = int(s)
    d, rem = divmod(s, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    if d:
        return f"{d}d {h}h"
    if h:
        return f"{h}h {m}m"
    return f"{m}m"


def sparkline(history, width: int, scale_to: Optional[float] = None) -> Text:
    """Render last `width` samples; color by quintile of local peak."""
    if width <= 0:
        return Text("")
    pts = list(history)[-width:]
    if len(pts) < width:
        pts = [None] * (width - len(pts)) + pts
    valid = [p for p in pts if p is not None]
    if not valid:
        return Text(" " * width, style="dim")
    peak = scale_to or max(valid) or 1.0
    out = Text()
    for v in pts:
        if v is None:
            out.append(" ", style="dim")
            continue
        idx = min(len(SPARK) - 1, int((v / peak) * (len(SPARK) - 1)))
        ch = SPARK[idx]
        ratio = v / peak
        if ratio >= 0.85:
            out.append(ch, style="bold red")
        elif ratio >= 0.6:
            out.append(ch, style="yellow")
        elif ratio >= 0.25:
            out.append(ch, style="cyan")
        else:
            out.append(ch, style="dim cyan")
    return out


def stats(hist) -> dict:
    pts = [p for p in hist if p is not None]
    if not pts:
        return {"avg": 0, "peak": 0, "total_b": 0}
    return {
        "avg": sum(pts) / len(pts),
        "peak": max(pts),
        # bytes transferred during the captured window
        "total_b": sum(pts) * REFRESH_S / 8,
    }


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def build_header(width: int, last: Optional[dict], stale: bool, age: float) -> Text:
    title = Text()
    title.append("gatekeeper", style="bold cyan")
    title.append(" ←→ ")
    title.append(IFACE, style="bold")
    if width >= 50:
        title.append("  ")
        title.append("WAN trunk · VLAN 38", style="dim cyan")
    if not last:
        title.append("   no data", style="bold red")
        return title
    if stale:
        title.append(f"   STALE {age:.0f}s", style="bold red")

    # Append meta fields by priority; only commit if they fit.
    extras: list[tuple[str, str]] = []
    if last.get("uptime_s") is not None:
        extras.append(("up", fmt_uptime(last["uptime_s"])))
    if last.get("load_1") is not None:
        extras.append(("load", f"{last['load_1']:.2f}"))
    if last.get("ping_ms") is not None:
        ping_str = f"{last['ping_ms']:.1f}ms"
        if last.get("ping_drop"):
            ping_str += f" drop {last['ping_drop']*100:.0f}%"
        extras.append(("8.8.8.8", ping_str))
    if last.get("temp_c") is not None:
        extras.append(("temp", f"{last['temp_c']:.0f}°C"))
    if last.get("conntrack") is not None:
        extras.append(("ct", f"{last['conntrack']}"))

    base_len = title.cell_len + 6
    for label, value in extras:
        chunk_len = len(f"   {label} {value}")
        if base_len + chunk_len > width:
            break
        title.append(f"   {label} ", style="dim")
        title.append(value, style="bold")
        base_len += chunk_len
    return title


def _stat_block(rs: dict, color: str, align: str) -> Text:
    """Per-direction stats column: avg / peak / total."""
    lines = [
        ("avg",   fmt_bps(rs["avg"]).plain.strip()),
        ("peak",  fmt_bps(rs["peak"]).plain.strip()),
        ("total", fmt_bytes(rs["total_b"])),
    ]
    out = Text()
    for i, (label, value) in enumerate(lines):
        if i:
            out.append("\n")
        if align == "right":
            out.append(f"{label:>5} ", style="dim")
            out.append(value, style=color)
        else:
            out.append(value, style=color)
            out.append(f" {label:<5}", style="dim")
    return out


def build_big_numbers(width: int, rx: float, tx: float,
                      rx_hist, tx_hist) -> Table:
    """Center: big rx/tx; flanking columns of stats when wide enough."""
    rs = stats(rx_hist)
    ts = stats(tx_hist)

    rx_big = Text()
    rx_big.append("↓ rx\n", style="bold cyan")
    rx_big.append_text(fmt_bps(rx))
    tx_big = Text()
    tx_big.append("↑ tx\n", style="bold magenta")
    tx_big.append_text(fmt_bps(tx))

    if width >= 100:
        t = Table.grid(expand=True, padding=(0, 1))
        t.add_column(ratio=2, justify="right")
        t.add_column(ratio=1, justify="center")
        t.add_column(ratio=1, justify="center")
        t.add_column(ratio=2, justify="left")
        t.add_row(_stat_block(rs, "cyan", "right"), rx_big, tx_big,
                  _stat_block(ts, "magenta", "left"))
        return t

    if width >= 60:
        t = Table.grid(expand=True, padding=(0, 2))
        t.add_column(ratio=1, justify="center")
        t.add_column(ratio=1, justify="center")
        t.add_row(rx_big, tx_big)
        return t

    # Narrow: single column, vertical
    t = Table.grid(padding=(0, 1))
    t.add_column(justify="center")
    t.add_row(rx_big)
    t.add_row(Text(""))
    t.add_row(tx_big)
    return t


def build_sparklines(width: int, vertical_budget: int,
                     rx_hist, tx_hist, long_rx, long_tx) -> Table:
    label_w = 3
    spark_w = max(8, width - label_w - 2)

    t = Table.grid(expand=True, padding=(0, 1))
    t.add_column(width=label_w, justify="right")
    t.add_column(ratio=1)

    peak = max(
        max((p for p in rx_hist if p is not None), default=0),
        max((p for p in tx_hist if p is not None), default=0),
        1.0,
    )
    t.add_row(Text("rx", style="bold cyan"),
              sparkline(rx_hist, spark_w, peak))
    t.add_row(Text("tx", style="bold magenta"),
              sparkline(tx_hist, spark_w, peak))

    # Long-window pair if we have rows + at least a few buckets.
    long_ready = (len(long_rx) >= 2 or len(long_tx) >= 2)
    if vertical_budget >= 4 and long_ready:
        long_peak = max(
            max((p for p in long_rx if p is not None), default=0),
            max((p for p in long_tx if p is not None), default=0),
            1.0,
        )
        bucket_min = LONG_BUCKET_S * spark_w / 60
        t.add_row(Text(""), Text(
            f"30s buckets · {bucket_min:.0f}m window",
            style="dim italic"
        ))
        t.add_row(Text("RX", style="cyan"),
                  sparkline(long_rx, spark_w, long_peak))
        t.add_row(Text("TX", style="magenta"),
                  sparkline(long_tx, spark_w, long_peak))

    return t


def build_footer(sample_age: float, fetch_age: float) -> Text:
    bits = [
        f"sample {sample_age:.0f}s ago",
        f"fetch {fetch_age:.0f}s ago",
        f"refresh {REFRESH_S:.0f}s",
    ]
    return Text("  ·  ".join(bits), style="dim", justify="right")


def render(rx_hist, tx_hist, long_rx, long_tx,
           last: Optional[dict], last_seen: float, last_fetch: float,
           term_w: int, term_h: int) -> Panel:
    age = time.time() - last_seen if last_seen else 999.0
    fetch_age = time.time() - last_fetch if last_fetch else 999.0
    stale = age > STALE_S and last_seen > 0

    rx, tx = (last["rx_bps"], last["tx_bps"]) if last else (0.0, 0.0)
    inner_w = max(20, term_w - 6)
    big_lines = 2 if inner_w < 100 else 4
    extra_v = max(0, term_h - 2 - 2 - big_lines - 2 - 2 - 1)

    header = build_header(inner_w, last, stale, age)
    big = build_big_numbers(inner_w, rx, tx, rx_hist, tx_hist)
    sparks = build_sparklines(inner_w, extra_v,
                              rx_hist, tx_hist, long_rx, long_tx)

    parts = [Align.center(big), Text(""), sparks]
    if stale:
        parts.append(Text(""))
        parts.append(Text(
            f"  ⚠ STALE — last sample {age:.0f}s ago (collectd update overdue)",
            style="bold red"
        ))
    parts.append(Text(""))
    parts.append(build_footer(age, fetch_age))

    return Panel(
        Group(*parts),
        title=header,
        title_align="left",
        border_style="red" if stale else "cyan",
        padding=(1, 2),
    )


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def main():
    rx_hist: deque = deque(maxlen=MAX_HISTORY)
    tx_hist: deque = deque(maxlen=MAX_HISTORY)
    long_rx: deque = deque(maxlen=MAX_HISTORY)
    long_tx: deque = deque(maxlen=MAX_HISTORY)
    long_acc_rx: list[float] = []
    long_acc_tx: list[float] = []
    long_acc_started = time.time()

    last: Optional[dict] = None
    last_seen = 0.0
    last_fetch = 0.0
    console = Console()

    def current_render():
        size = shutil.get_terminal_size((100, 30))
        return render(rx_hist, tx_hist, long_rx, long_tx,
                      last, last_seen, last_fetch, size.columns, size.lines)

    with Live(current_render(), refresh_per_second=4, screen=False,
              console=console) as live:
        while True:
            data = fetch()
            last_fetch = time.time()
            if data is not None:
                last = data
                last_seen = last_fetch
                rx_hist.append(data["rx_bps"])
                tx_hist.append(data["tx_bps"])
                long_acc_rx.append(data["rx_bps"])
                long_acc_tx.append(data["tx_bps"])
                if last_fetch - long_acc_started >= LONG_BUCKET_S:
                    if long_acc_rx:
                        long_rx.append(sum(long_acc_rx) / len(long_acc_rx))
                        long_tx.append(sum(long_acc_tx) / len(long_acc_tx))
                    long_acc_rx.clear()
                    long_acc_tx.clear()
                    long_acc_started = last_fetch

            live.update(current_render())
            time.sleep(REFRESH_S)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
