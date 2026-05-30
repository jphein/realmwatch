"""wave-block renderer — pure TUI rendering primitives.

This module is the library half of wave-block: ANSI palette, box-drawing,
sparklines, progress bars, the BackfillState data model, and the two
dashboard renderers (`render_backfill`, `_render_custom`). It carries no
polling, no subprocess launching, and no argparse — that lives in
`wave-block.py`, which composes these primitives into a live dashboard.

The split exists so the renderer can be imported by tests or alternative
front-ends (notebook embeds, single-shot screenshots) without dragging in
the polling loop or terminal-detection helpers. Callers that exec
`wave-block.py` by absolute path are unaffected: the CLI re-exports
everything it needs from here.

SIGWINCH state (`_resize_flag`, `_on_resize`) is kept here because the
resize signal is a renderer concern — what changes on resize is the
geometry the renderer reads via `term_width()` / `term_height()`. The
dashboard loops in wave-block.py install the handler against this
module's flag.
"""
from __future__ import annotations

import math
import re
import shutil
import sys
from dataclasses import dataclass, field
from typing import Any

# ── ANSI palette ────────────────────────────────────────────────────────────
# Gruvbox-ish warm palette — looks great on dark and light terminals.
C = {
    "reset":     "\033[0m",
    "bold":      "\033[1m",
    "dim":       "\033[2m",
    "fg":        "\033[38;5;223m",   # warm cream
    "accent":    "\033[38;5;214m",   # amber
    "good":      "\033[38;5;142m",   # olive green
    "warn":      "\033[38;5;208m",   # orange
    "err":       "\033[38;5;167m",   # muted red
    "muted":     "\033[38;5;245m",   # gray
    "bar_fill":  "\033[38;5;214m",   # amber
    "bar_bg":    "\033[38;5;239m",   # dark gray
    "spark":     "\033[38;5;109m",   # teal
    "border":    "\033[38;5;246m",   # visible gray
    "title_bg":  "\033[48;5;235m",   # very dark bg for title bar
    "wave1":     "\033[38;5;31m",    # deep blue
    "wave2":     "\033[38;5;37m",    # teal
    "wave3":     "\033[38;5;73m",    # light teal
    "wave4":     "\033[38;5;109m",   # pale teal
}

WAVE_CHARS = "▁▂▃▄▅▆▇█"
SPARK_CHARS = "▁▂▃▄▅▆▇█"
BAR_FILL = "█"
BAR_HALF = "▌"
BAR_EMPTY = "░"

BOX = {
    "tl": "╭", "tr": "╮", "bl": "╰", "br": "╯",
    "h": "─", "v": "│",
    "lt": "├", "rt": "┤", "tt": "┬", "bt": "┴",
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def hide_cursor():
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()

def show_cursor():
    sys.stdout.write("\033[?25h")
    sys.stdout.flush()

def clear_screen():
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()

def move_to(row: int, col: int):
    sys.stdout.write(f"\033[{row};{col}H")

def term_width() -> int:
    return shutil.get_terminal_size((80, 24)).columns

def term_height() -> int:
    return shutil.get_terminal_size((80, 24)).lines

def fmt_duration(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"

def fmt_number(n: int | float) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}K"
    return str(int(n))

def sparkline(values: list[float], width: int = 20) -> str:
    if not values:
        return C["muted"] + "·" * width + C["reset"]
    recent = values[-width:]
    mn, mx = min(recent), max(recent)
    rng = mx - mn if mx > mn else 1.0
    chars = []
    for v in recent:
        idx = int((v - mn) / rng * (len(SPARK_CHARS) - 1))
        chars.append(SPARK_CHARS[min(idx, len(SPARK_CHARS) - 1)])
    pad = width - len(chars)
    return C["muted"] + "·" * pad + C["spark"] + "".join(chars) + C["reset"]

def progress_bar(fraction: float, width: int = 40) -> str:
    fraction = max(0.0, min(1.0, fraction))
    filled = fraction * width
    full_blocks = int(filled)
    remainder = filled - full_blocks
    bar = C["bar_fill"] + BAR_FILL * full_blocks
    if remainder >= 0.5 and full_blocks < width:
        bar += BAR_HALF
        full_blocks += 1
    bar += C["bar_bg"] + BAR_EMPTY * (width - full_blocks)
    bar += C["reset"]
    return bar

def wave_banner(tick: int, width: int) -> str:
    colors = [C["wave1"], C["wave2"], C["wave3"], C["wave4"]]
    wave_chars = "░▒▓█▓▒░ "
    line = ""
    for i in range(width):
        phase = (i * 0.3 + tick * 0.5)
        idx = int((math.sin(phase) + 1) / 2 * (len(wave_chars) - 1))
        cidx = int((math.sin(phase * 0.7) + 1) / 2 * (len(colors) - 1))
        line += colors[cidx] + wave_chars[idx]
    return line + C["reset"]


# ── Box renderer ────────────────────────────────────────────────────────────

def box_top(width: int, title: str = "") -> str:
    inner = width - 2
    if title:
        t = f" {title} "
        t_visible = re.sub(r'\033\[[^m]*m', '', t)
        pad = inner - len(t_visible)
        lpad = pad // 2
        rpad = pad - lpad
        line = BOX["h"] * lpad + C["accent"] + C["bold"] + t + C["reset"] + C["border"] + BOX["h"] * rpad
    else:
        line = BOX["h"] * inner
    return C["border"] + BOX["tl"] + line + BOX["tr"] + C["reset"]

def box_mid(width: int) -> str:
    return C["border"] + BOX["lt"] + BOX["h"] * (width - 2) + BOX["rt"] + C["reset"]

def box_bot(width: int) -> str:
    return C["border"] + BOX["bl"] + BOX["h"] * (width - 2) + BOX["br"] + C["reset"]

def box_row(content: str, width: int) -> str:
    stripped = re.sub(r'\033\[[^m]*m', '', content)
    pad = width - 2 - len(stripped)
    if pad < 0:
        pad = 0
    return C["border"] + BOX["v"] + C["reset"] + content + " " * pad + C["border"] + BOX["v"] + C["reset"]

def box_row_pair(left: str, right: str, width: int) -> str:
    half = (width - 3) // 2
    l_stripped = re.sub(r'\033\[[^m]*m', '', left)
    r_stripped = re.sub(r'\033\[[^m]*m', '', right)
    l_pad = half - len(l_stripped)
    r_pad = (width - 3 - half) - len(r_stripped)
    if l_pad < 0: l_pad = 0
    if r_pad < 0: r_pad = 0
    return (C["border"] + BOX["v"] + C["reset"] +
            left + " " * l_pad +
            C["border"] + BOX["v"] + C["reset"] +
            right + " " * r_pad +
            C["border"] + BOX["v"] + C["reset"])


# ── Data model ──────────────────────────────────────────────────────────────

@dataclass
class BackfillState:
    in_progress: bool = False
    drawers_seen: int = 0
    entities_added: int = 0
    errors: int = 0
    rate: float = 0.0
    elapsed: float = 0.0
    total_drawers: int = 339_403
    rate_history: list[float] = field(default_factory=list)
    entity_history: list[float] = field(default_factory=list)
    poll_count: int = 0
    started_at: str = ""
    last_log_time: str = ""
    workers: int = 1

    @property
    def pct(self) -> float:
        if self.total_drawers <= 0:
            return 0.0
        return self.drawers_seen / self.total_drawers

    @property
    def eta_seconds(self) -> float:
        if self.rate <= 0:
            return float('inf')
        remaining = self.total_drawers - self.drawers_seen
        return remaining / self.rate

    @property
    def entities_per_drawer(self) -> float:
        if self.drawers_seen <= 0:
            return 0.0
        return self.entities_added / self.drawers_seen


def parse_backfill_status(data: dict, state: BackfillState) -> BackfillState:
    import time
    state.in_progress = data.get("in_progress", False)
    state.elapsed = data.get("elapsed_seconds", 0.0)
    if data.get("total_drawers"):
        state.total_drawers = data["total_drawers"]

    # Prefer checkpointed_drawers from the status JSON — this reflects
    # actual progress including previously completed runs, unlike
    # drawers_seen which resets to 0 each run.
    if data.get("checkpointed_drawers"):
        state.drawers_seen = data["checkpointed_drawers"]

    lines = data.get("recent_output", [])
    if lines:
        last = lines[-1]
        # Only use log-parsed drawers_seen if no checkpoint count available
        if not data.get("checkpointed_drawers"):
            m = re.search(r'drawers_seen=(\d+)', last)
            if m:
                state.drawers_seen = int(m.group(1))
        m = re.search(r'entities_added=(\d+)', last)
        if m:
            state.entities_added = int(m.group(1))
        m = re.search(r'errors=(\d+)', last)
        if m:
            state.errors = int(m.group(1))
        m = re.search(r'rate=([\d.]+)/s', last)
        if m:
            state.rate = float(m.group(1))

        m = re.search(r'workers=(\d+)', last)
        if m:
            state.workers = int(m.group(1))
        m = re.search(r'^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})', last)
        if m:
            state.last_log_time = m.group(1)

    # Compute rate from checkpoint deltas when the source doesn't report it
    if state.rate == 0.0 and state.poll_count > 0:
        prev = state._prev_drawers if hasattr(state, '_prev_drawers') else state.drawers_seen
        prev_t = state._prev_time if hasattr(state, '_prev_time') else time.monotonic()
        dt = time.monotonic() - prev_t
        if dt > 0 and state.drawers_seen > prev:
            state.rate = (state.drawers_seen - prev) / dt
    state._prev_drawers = state.drawers_seen
    state._prev_time = time.monotonic()

    # EMA smoothing: don't let rate jump to 0 between polls
    if not hasattr(state, '_ema_rate'):
        state._ema_rate = state.rate
    if state.rate > 0:
        state._ema_rate = 0.3 * state.rate + 0.7 * state._ema_rate
    state.rate = state._ema_rate

    state.rate_history.append(state.rate)
    if len(state.rate_history) > 120:
        state.rate_history = state.rate_history[-120:]

    state.entity_history.append(state.entities_added)
    if len(state.entity_history) > 120:
        state.entity_history = state.entity_history[-120:]

    state.poll_count += 1
    return state


# ── Responsive layout tiers ─────────────────────────────────────────────────
#
#  Tier     Width     Height    Layout
#  ────     ─────     ──────    ──────
#  tiny     < 30      < 8       pct + rate only, no box, no sparklines
#  narrow   30-49     any       single-column metrics, short labels
#  medium   50-79     any       paired columns, sparklines if height allows
#  wide     80+       any       full layout with wave banners, all sparklines
#
# Height gates (applied after width tier picks candidate rows):
#  < 5   → progress bar + one stat line only
#  5-8   → progress + core stats (rate/eta/elapsed)
#  9-13  → above + entity/error stats
#  14-17 → above + sparklines (1-2)
#  18+   → above + wave banners + footer

def _size_tier(w: int) -> str:
    if w < 30: return "tiny"
    if w < 50: return "narrow"
    if w < 80: return "medium"
    return "wide"


def render_backfill(state: BackfillState, tick: int):
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    lines: list[str] = []

    status_icon = "◉" if state.in_progress else "○"
    status_color = C["good"] if state.in_progress else C["muted"]
    rate_color = C["good"] if state.rate >= 3.5 else (C["warn"] if state.rate >= 2.0 else C["err"])
    err_color = C["good"] if state.errors == 0 else C["err"]
    eta = state.eta_seconds
    eta_text = fmt_duration(eta) if eta < float('inf') else "∞"

    # ── TINY: bare minimum, no box frame ────────────────────────────────────
    if tier == "tiny":
        pct_str = f"{state.pct * 100:.0f}%"
        bar_w = max(w - len(pct_str) - 2, 5)
        lines.append(f"{progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']}")
        if h >= 3:
            lines.append(f"{rate_color}{state.rate:.1f}/s{C['reset']} {C['muted']}→{C['reset']} {C['accent']}{eta_text}{C['reset']}")
        if h >= 4:
            lines.append(f"{C['accent']}{fmt_number(state.drawers_seen)}{C['muted']}/{fmt_number(state.total_drawers)}{C['reset']}")
        if h >= 5:
            w_tag = f" {C['muted']}w:{state.workers}" if state.workers > 1 else ""
            lines.append(f"{C['muted']}E:{C['accent']}{fmt_number(state.entities_added)} {err_color}err:{state.errors}{w_tag}{C['reset']}")
        _emit(lines, h, tick)
        return

    # ── NARROW: single column in a box ──────────────────────────────────────
    if tier == "narrow":
        # Wave banner if we can afford the height
        if h >= 14:
            lines.append(wave_banner(tick, w))

        title = f"BACKFILL {status_color}{status_icon}{C['reset']}"
        lines.append(box_top(w, title))

        bar_w = max(w - 12, 8)
        pct_str = f"{state.pct * 100:5.1f}%"
        lines.append(box_row(f" {progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']}", w))

        if h >= 6:
            lines.append(box_row(f" {C['fg']}Drawers {C['accent']}{fmt_number(state.drawers_seen)}{C['muted']}/{fmt_number(state.total_drawers)}{C['reset']}", w))
        if h >= 7:
            lines.append(box_row(f" {C['fg']}Rate    {rate_color}{state.rate:.1f}/s{C['reset']}", w))
        if h >= 8:
            lines.append(box_row(f" {C['fg']}ETA     {C['accent']}{eta_text}{C['reset']}", w))
        if h >= 9:
            lines.append(box_row(f" {C['fg']}Elapsed {C['accent']}{fmt_duration(state.elapsed)}{C['reset']}", w))
        if h >= 10:
            lines.append(box_row(f" {C['fg']}Entities{C['accent']} {fmt_number(state.entities_added)}{C['reset']}", w))
        if h >= 11:
            lines.append(box_row(f" {C['fg']}Errors  {err_color}{state.errors}{C['reset']}", w))
        if h >= 12 and state.workers > 1:
            lines.append(box_row(f" {C['fg']}Workers {C['accent']}{state.workers}{C['reset']}", w))

        if h >= 14:
            lines.append(box_mid(w))
            spark_w = max(w - 12, 8)
            lines.append(box_row(f" {C['fg']}Rate {sparkline(state.rate_history, spark_w)}", w))

        lines.append(box_bot(w))

        if h >= 16:
            lines.append(wave_banner(tick + 4, w))

        _emit(lines, h, tick)
        return

    # ── MEDIUM + WIDE: paired columns ───────────────────────────────────────
    is_wide = tier == "wide"

    # Top wave
    if h >= 18:
        lines.append(wave_banner(tick, w))

    title = f"AGE GRAPH BACKFILL {status_color}{status_icon}{C['reset']}"
    lines.append(box_top(w, title))

    # Progress bar — always shown
    bar_w = max(w - 18, 10)
    pct_str = f"{state.pct * 100:5.1f}%"
    lines.append(box_row(f" {progress_bar(state.pct, bar_w)} {C['accent']}{pct_str}{C['reset']} ", w))

    # Counts pair
    if h >= 6:
        seen_str = f" {C['fg']}Drawers  {C['accent']}{fmt_number(state.drawers_seen)}{C['muted']} / {fmt_number(state.total_drawers)}{C['reset']}"
        ent_str = f" {C['fg']}Entities {C['accent']}{fmt_number(state.entities_added)}{C['reset']}"
        lines.append(box_row_pair(seen_str, ent_str, w))

    if h >= 8:
        lines.append(box_mid(w))

    # Rate + ETA pair
    if h >= 9:
        rate_str = f" {C['fg']}Rate     {rate_color}{state.rate:.1f}/s{C['reset']}"
        eta_str = f" {C['fg']}ETA      {C['accent']}{eta_text}{C['reset']}"
        lines.append(box_row_pair(rate_str, eta_str, w))

    # Elapsed + Errors pair
    if h >= 10:
        elapsed_str = f" {C['fg']}Elapsed  {C['accent']}{fmt_duration(state.elapsed)}{C['reset']}"
        err_str = f" {C['fg']}Errors   {err_color}{state.errors}{C['reset']}"
        lines.append(box_row_pair(elapsed_str, err_str, w))

    # Ent/drawer + workers pair
    if h >= 11:
        epd_str = f" {C['fg']}Ent/draw {C['accent']}{state.entities_per_drawer:.1f}{C['reset']}"
        if state.workers > 1:
            workers_str = f" {C['fg']}Workers  {C['accent']}{state.workers}{C['reset']}"
        else:
            workers_str = f" {C['fg']}Last log {C['muted']}{state.last_log_time}{C['reset']}"
        lines.append(box_row_pair(epd_str, workers_str, w))

    # Sparklines — only if height allows
    if h >= 14:
        lines.append(box_mid(w))
        spark_w = max(w - 18, 10)
        lines.append(box_row(f" {C['fg']}Rate  ╌╌ {sparkline(state.rate_history, spark_w)} ", w))

    if h >= 15:
        deltas = []
        for i in range(1, len(state.entity_history)):
            deltas.append(state.entity_history[i] - state.entity_history[i - 1])
        spark_w = max(w - 18, 10)
        lines.append(box_row(f" {C['fg']}Ents  ╌╌ {sparkline(deltas, spark_w)} ", w))

    # Wide bonus: extra sparkline rows if lots of vertical space
    if is_wide and h >= 22 and len(state.rate_history) > 1:
        lines.append(box_mid(w))
        # Big ASCII bar chart of rate history
        _append_bar_chart(lines, state.rate_history, w, min(h - len(lines) - 4, 6))

    lines.append(box_bot(w))

    # Bottom wave
    if h >= 18:
        lines.append(wave_banner(tick + 4, w))

    # Footer
    if h >= 16:
        if is_wide:
            footer = f"{C['muted']}  poll #{state.poll_count}  ·  Ctrl-C to exit  ·  palace-daemon @ familiar:8085{C['reset']}"
        else:
            footer = f"{C['muted']}  poll #{state.poll_count}  ·  Ctrl-C{C['reset']}"
        lines.append(footer)

    _emit(lines, h, tick)


def _append_bar_chart(lines: list[str], values: list[float], w: int, max_rows: int):
    """Vertical bar chart using block elements — bonus for wide+tall terminals."""
    if max_rows < 2 or len(values) < 2:
        return
    chart_w = w - 4
    recent = values[-chart_w:]
    mn, mx = min(recent), max(recent)
    rng = mx - mn if mx > mn else 1.0
    for row in range(max_rows - 1, -1, -1):
        threshold = mn + (row / max_rows) * rng
        bar_line = ""
        for v in recent:
            if v >= threshold + rng / max_rows:
                bar_line += C["bar_fill"] + "█"
            elif v >= threshold:
                frac = (v - threshold) / (rng / max_rows)
                idx = min(int(frac * len(WAVE_CHARS)), len(WAVE_CHARS) - 1)
                bar_line += C["spark"] + WAVE_CHARS[idx]
            else:
                bar_line += C["bar_bg"] + " "
        bar_line += C["reset"]
        lines.append(box_row(f" {bar_line} ", w))


def _emit(lines: list[str], h: int, tick: int = 0):
    """Write lines to terminal, filling leftover rows with dim wave pattern."""
    w = term_width()
    for i, line in enumerate(lines):
        move_to(i + 1, 1)
        sys.stdout.write(line)
        sys.stdout.write("\033[K")
    for i in range(len(lines) + 1, h + 1):
        move_to(i, 1)
        fill = ""
        for col in range(w):
            phase = col * 0.15 + (i + tick) * 0.4
            v = (math.sin(phase) + 1) / 2
            if v > 0.7:
                fill += C["dim"] + "\033[38;5;237m" + "░"
            else:
                fill += " "
        sys.stdout.write(fill + C["reset"] + "\033[K")
    sys.stdout.flush()


# ── Custom-mode helpers ─────────────────────────────────────────────────────

# ── Host dashboard render ───────────────────────────────────────────────────
#
# `render_host` lays out a one-host system snapshot in the wave-block style:
# stacked gold progress bars for each percent metric (RAM, swap, disk, GPU
# util, GPU VRAM), a temperature/load sparkline section, a network row, and
# label lines for distro/kernel. The point is the visual quality of the
# bars — the same `█▌░` half-block precision render that the backfill
# template uses.

# The label, color, and (used_key, total_key) source for each percent bar.
# Order matters — that's the display order.
_HOST_BARS: list[tuple[str, str, str, str, str]] = [
    # (label, pct_key, color, used_key, total_key)
    ("RAM",     "ram_pct",   "accent", "ram_used_gb",   "ram_total_gb"),
    ("Swap",    "swap_pct",  "warn",   "swap_used_gb",  ""),
    ("Disk /",  "disk_pct",  "accent", "disk_used_gb",  "disk_total_gb"),
]


def _host_temp_color(c: int | float) -> str:
    """Olive ≤55 → amber ≤75 → orange ≤85 → red above. CPUs + GPUs."""
    try:
        v = float(c)
    except (TypeError, ValueError):
        return "muted"
    if v >= 85:
        return "err"
    if v >= 75:
        return "warn"
    if v >= 55:
        return "accent"
    return "good"


def _bar_row(label: str, pct: float, width: int, *, color: str = "accent",
             detail: str = "") -> str:
    """Render one labelled progress-bar row that fits inside box_row(content, width).

    Layout:  " <label:7s> <bar> <pct:5.1f%>  <detail> "
    """
    label_str = f" {label:<7s}"
    pct_str = f" {pct:5.1f}%"
    detail_str = f"  {C['muted']}{detail}{C['reset']}" if detail else ""
    detail_visible = len(detail) + 2 if detail else 0
    bar_w = width - 2 - len(label_str) - len(pct_str) - detail_visible
    if bar_w < 6:
        bar_w = max(6, width - 2 - len(label_str) - len(pct_str))
        detail_str = ""
    bar = progress_bar(pct / 100.0, bar_w)
    return (
        f"{label_str}"
        f"{bar} "
        f"{C[color]}{pct_str.strip()}{C['reset']}"
        f"{detail_str}"
    )


def _mini_bar(pct: float, width: int = 10) -> str:
    """Smaller progress bar suitable for inline GPU util/VRAM rows."""
    return progress_bar(max(pct, 0) / 100.0, width)


def render_host(title: str, metrics: dict, history: dict[str, list[float]], tick: int):
    """Beautiful per-host dashboard — gold percent bars, teal sparklines, wave banners.

    Field conventions consumed:
      ram_pct + ram_used_gb + ram_total_gb            primary bar
      swap_pct + swap_used_gb                         swap bar (omitted if missing)
      disk_pct + disk_used_gb + disk_total_gb         disk bar
      load_1m / load_5m / load_15m + cpu_count        load line
      cpu_temp_c                                      temp line (sparkline)
      gpu<N>_temp_c / gpu<N>_util_pct / gpu<N>_vram_pct GPU rows (per index)
      net_<iface>_rx_Mbps / net_<iface>_tx_Mbps        net line
      uptime_hours, pg_active_conns                   misc numerics
      hostname, distro, kernel, arch, wave_host       label footer
    """
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    lines: list[str] = []

    if h >= 18 and tier in ("medium", "wide"):
        lines.append(wave_banner(tick, w))

    # ── Title bar ───────────────────────────────────────────────────────────
    distro = metrics.get("distro", "")
    cores = metrics.get("cpu_count", "")
    title_extras = []
    if distro: title_extras.append(str(distro))
    if cores:  title_extras.append(f"{cores} cores")
    full_title = title + (" · " + " · ".join(title_extras) if title_extras and tier != "narrow" else "")
    lines.append(box_top(w, full_title))

    # ── Stacked percent bars ────────────────────────────────────────────────
    bar_count = 0
    for label, pct_key, color, used_key, total_key in _HOST_BARS:
        if pct_key not in metrics:
            continue
        try:
            pct = float(metrics[pct_key])
        except (TypeError, ValueError):
            continue
        detail = ""
        used = metrics.get(used_key)
        total = metrics.get(total_key) if total_key else None
        if used is not None and total is not None:
            detail = f"{used}G / {total}G"
        elif used is not None:
            detail = f"{used}G used"
        lines.append(box_row(_bar_row(label, pct, w, color=color, detail=detail), w))
        bar_count += 1

    if bar_count == 0:
        lines.append(box_row(f" {C['muted']}(no resource counters yet){C['reset']}", w))

    # ── Load + CPU temp ─────────────────────────────────────────────────────
    if h >= 8 and tier in ("medium", "wide", "narrow"):
        lines.append(box_mid(w))

    load_parts = []
    for k in ("load_1m", "load_5m", "load_15m"):
        if k in metrics:
            load_parts.append(f"{float(metrics[k]):.2f}")
    if load_parts:
        cores_suffix = f"  {C['muted']}({metrics.get('cpu_count', '?')} cores){C['reset']}" if "cpu_count" in metrics else ""
        load_str = f" {C['fg']}Load{C['reset']}    {C['accent']}{' / '.join(load_parts)}{C['reset']}{cores_suffix}"
        lines.append(box_row(load_str, w))

    cpu_t = metrics.get("cpu_temp_c")
    if cpu_t is not None:
        col = _host_temp_color(cpu_t)
        spark_w = max(w - 24, 8) if tier in ("medium", "wide") else max(w - 16, 4)
        cpu_history = history.get("cpu_temp_c", [])
        spark = sparkline(cpu_history, spark_w) if len(cpu_history) > 1 else ""
        lines.append(box_row(
            f" {C['fg']}CPU temp{C['reset']} {C[col]}{int(float(cpu_t))}°C{C['reset']} {spark}", w
        ))

    # ── GPUs (per-index) ────────────────────────────────────────────────────
    gpu_indices: set[int] = set()
    for k in metrics:
        if k.startswith("gpu") and "_" in k:
            try:
                gpu_indices.add(int(k[3:].split("_", 1)[0]))
            except ValueError:
                continue

    for i in sorted(gpu_indices):
        temp = metrics.get(f"gpu{i}_temp_c")
        util = metrics.get(f"gpu{i}_util_pct")
        vram = metrics.get(f"gpu{i}_vram_pct")
        vram_gb = metrics.get(f"gpu{i}_vram_used_gb")
        parts: list[str] = [f" {C['fg']}GPU {i}{C['reset']}"]
        if temp is not None:
            tcol = _host_temp_color(temp)
            parts.append(f"{C[tcol]}{int(float(temp))}°C{C['reset']}")
        if util is not None and tier in ("medium", "wide"):
            parts.append(f"{C['muted']}util{C['reset']} {_mini_bar(float(util), 10)} {C['accent']}{int(float(util)):>3d}%{C['reset']}")
        elif util is not None:
            parts.append(f"util {C['accent']}{int(float(util))}%{C['reset']}")
        if vram is not None and tier in ("medium", "wide"):
            vram_label = f"vram {_mini_bar(float(vram), 10)} {C['accent']}{float(vram):4.1f}%{C['reset']}"
            if vram_gb is not None:
                vram_label += f"  {C['muted']}({vram_gb}G){C['reset']}"
            parts.append(vram_label)
        elif vram is not None:
            parts.append(f"vram {C['accent']}{float(vram):.0f}%{C['reset']}")
        lines.append(box_row("  ".join(parts), w))

    # ── Network + uptime + pg + last log ─────────────────────────────────────
    net_pairs = []
    for k in sorted(metrics):
        if k.startswith("net_") and k.endswith("_rx_Mbps"):
            iface = k[len("net_"):-len("_rx_Mbps")]
            rx = metrics.get(k, 0)
            tx = metrics.get(f"net_{iface}_tx_Mbps", 0)
            net_pairs.append((iface, float(rx), float(tx)))
    if net_pairs and h >= 10:
        lines.append(box_mid(w))
        for iface, rx, tx in net_pairs[:2]:
            lines.append(box_row(
                f" {C['fg']}Net{C['reset']}    {C['muted']}{iface}{C['reset']}  "
                f"rx {C['accent']}{rx:6.2f} Mbps{C['reset']}  "
                f"tx {C['accent']}{tx:6.2f} Mbps{C['reset']}", w
            ))

    misc_parts: list[str] = []
    if "uptime_hours" in metrics:
        u = float(metrics["uptime_hours"])
        if u >= 24:
            misc_parts.append(f"{C['fg']}uptime{C['reset']} {C['accent']}{u/24:.1f}d{C['reset']}")
        else:
            misc_parts.append(f"{C['fg']}uptime{C['reset']} {C['accent']}{u:.1f}h{C['reset']}")
    if "pg_active_conns" in metrics:
        misc_parts.append(f"{C['fg']}pg_conns{C['reset']} {C['accent']}{int(metrics['pg_active_conns'])}{C['reset']}")
    if misc_parts and h >= 11:
        lines.append(box_row(" " + "    ".join(misc_parts), w))

    # ── Identity footer ─────────────────────────────────────────────────────
    if h >= 12:
        lines.append(box_mid(w))
        id_parts: list[str] = []
        for k in ("hostname", "distro", "kernel", "arch"):
            v = metrics.get(k)
            if v:
                id_parts.append(str(v))
        if id_parts:
            ident = " · ".join(id_parts)
            if len(ident) > w - 4:
                ident = ident[:w - 7] + "..."
            lines.append(box_row(f" {C['muted']}{ident}{C['reset']}", w))

    if "_error" in metrics:
        lines.append(box_row(f" {C['err']}{str(metrics['_error'])[:w-4]}{C['reset']}", w))

    lines.append(box_bot(w))

    if h >= 18 and tier in ("medium", "wide"):
        lines.append(wave_banner(tick + 4, w))

    _emit(lines, h, tick)


# ── Benchmark slate render ──────────────────────────────────────────────────
#
# `render_slate` is a bespoke layout for the SME memory-system benchmark
# slate: a header progress bar (how much of the slate is DONE), one row per
# benchmark with a status sigil + inline metrics, and a compact structural-
# category strip beneath. It consumes the realmwatch-benchmark-slate/v1
# schema emitted by benchmark-poll.py and leans on the same gold-bar / teal
# / wave-banner primitives the other dashboards use, so it sits visually
# alongside them in a Wave grid.

# status → (sigil, palette key). Order here is also the "completeness"
# ranking used for the slate progress bar (done counts as full).
_SLATE_STATUS = {
    "done":        ("◆", "good"),
    "partial":     ("◈", "accent"),
    "in_progress": ("◐", "warn"),
    "pending":     ("○", "muted"),
    "blocked":     ("✕", "err"),
}
# Fraction of "complete" each status contributes to the slate progress bar.
_SLATE_WEIGHT = {
    "done": 1.0, "partial": 0.5, "in_progress": 0.33,
    "pending": 0.0, "blocked": 0.0,
}


def _slate_sigil(status: str) -> tuple[str, str]:
    return _SLATE_STATUS.get(str(status).lower(), ("·", "muted"))


def _strip_ansi(s: str) -> str:
    return re.sub(r'\033\[[^m]*m', '', s)


def _clip_visible(s: str, max_visible: int) -> str:
    """Truncate s to max_visible printable chars, keeping ANSI codes intact.

    box_row only pads — it never clips — so a row whose visible content is
    wider than the box spills past the right border. Slate metric chips can
    be long at narrow widths, so we pre-clip them here, walking the string
    and counting only non-escape characters toward the budget. Always ends
    with a reset so a clipped color can't bleed into the border.
    """
    if max_visible <= 0:
        return C["reset"]
    out: list[str] = []
    shown = 0
    i = 0
    truncated = False
    while i < len(s):
        if s[i] == "\033":
            m = re.match(r'\033\[[^m]*m', s[i:])
            if m:
                out.append(m.group(0))
                i += m.end()
                continue
        if shown >= max_visible - 1:
            truncated = True
            break
        out.append(s[i])
        shown += 1
        i += 1
    if truncated:
        out.append(C["muted"] + "…")
    out.append(C["reset"])
    return "".join(out)


def _fmt_metric(metric: dict) -> str:
    """One ` name value ` chip, colored by kind. Pending → dim em-dash."""
    name = str(metric.get("name", "")).strip()
    kind = str(metric.get("kind", "number")).lower()
    val = metric.get("value")
    if kind == "pending" or val is None:
        return f"{C['muted']}{name} —{C['reset']}"
    try:
        num = float(val)
    except (TypeError, ValueError):
        return f"{C['fg']}{name} {C['accent']}{val}{C['reset']}"
    if kind == "fraction":
        shown = f"{num * 100:.1f}%"
    elif num == int(num):
        shown = str(int(num))
    else:
        shown = f"{num:.3g}"
    return f"{C['fg']}{name} {C['accent']}{shown}{C['reset']}"


def render_slate(title: str, slate: dict, tick: int):
    """Render the SME benchmark slate — status sigils, metric chips, progress.

    Schema consumed (realmwatch-benchmark-slate/v1):
      title       str
      updated     str (ISO-8601 — shown in footer)
      benchmarks  [{label, status, blurb, metrics:[{name,value,kind}]}]
      structural  [{label, status}]
      _source     str (path the poller read — footer)
      _error      str (surfaced as an error row if present)
    """
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    benchmarks = slate.get("benchmarks") or []
    structural = slate.get("structural") or []
    disp_title = str(slate.get("title") or title)

    # Slate progress: weighted completeness across the headline benchmarks.
    if benchmarks:
        done_w = sum(_SLATE_WEIGHT.get(str(b.get("status", "")).lower(), 0.0)
                     for b in benchmarks)
        frac = done_w / len(benchmarks)
    else:
        frac = 0.0
    n_done = sum(1 for b in benchmarks if str(b.get("status", "")).lower() == "done")

    lines: list[str] = []

    if h >= 18 and tier in ("medium", "wide"):
        lines.append(wave_banner(tick, w))

    lines.append(box_top(w, disp_title.upper()))

    # ── Slate progress bar ───────────────────────────────────────────────────
    bar_w = max(w - 22, 10)
    pct_str = f"{frac * 100:4.0f}%"
    count_str = f"{n_done}/{len(benchmarks)}" if benchmarks else "0/0"
    lines.append(box_row(
        f" {progress_bar(frac, bar_w)} {C['accent']}{pct_str}{C['reset']} "
        f"{C['muted']}{count_str}{C['reset']}", w))

    if benchmarks:
        lines.append(box_mid(w))

    # ── Benchmark rows ───────────────────────────────────────────────────────
    # Each headline benchmark: sigil + label, then its metric chips, then a
    # dim blurb line (wide/medium only, if vertical space allows).
    label_w = 16 if tier in ("medium", "wide") else 12
    for b in benchmarks:
        if len(lines) >= h - 4:
            break
        status = str(b.get("status", "")).lower()
        sigil, col = _slate_sigil(status)
        label = str(b.get("label", b.get("id", "?")))[:label_w]
        metrics = b.get("metrics") or []
        chips = "   ".join(_fmt_metric(m) for m in metrics if isinstance(m, dict))
        if not chips:
            chips = f"{C['muted']}{status or '—'}{C['reset']}"
        head = (f" {C[col]}{sigil}{C['reset']} "
                f"{C['bold']}{C['fg']}{label:<{label_w}s}{C['reset']} {chips}")
        lines.append(box_row(_clip_visible(head, w - 2), w))

        blurb = str(b.get("blurb", "")).strip()
        if blurb and tier in ("medium", "wide") and h >= 14 and len(lines) < h - 4:
            lines.append(box_row(
                _clip_visible(f"   {C['muted']}{C['dim']}{blurb}{C['reset']}", w - 2), w))

    # ── Structural categories strip ──────────────────────────────────────────
    if structural and len(lines) < h - 4:
        lines.append(box_mid(w))
        # Pack the cat sigils onto as few rows as fit the width. Each cell is
        # "<sigil> <label>" separated by two spaces.
        cells = []
        for s in structural:
            sigil, col = _slate_sigil(str(s.get("status", "")).lower())
            label = str(s.get("label", s.get("id", "?")))
            cells.append((f"{C[col]}{sigil}{C['reset']} {C['fg']}{label}{C['reset']}",
                          len(_strip_ansi(f"{sigil} {label}"))))
        per_row = 2 if tier == "wide" else 1
        half = (w - 3) // 2
        for i in range(0, len(cells), per_row):
            if len(lines) >= h - 3:
                break
            row_cells = cells[i:i + per_row]
            if len(row_cells) == 2:
                lines.append(box_row_pair(
                    _clip_visible(" " + row_cells[0][0], half),
                    _clip_visible(" " + row_cells[1][0], w - 3 - half), w))
            else:
                lines.append(box_row(_clip_visible(" " + row_cells[0][0], w - 2), w))

    if "_error" in slate:
        lines.append(box_row(
            f" {C['err']}slate: {str(slate['_error'])[:w - 12]}{C['reset']}", w))

    lines.append(box_bot(w))

    if h >= 18 and tier in ("medium", "wide"):
        lines.append(wave_banner(tick + 4, w))

    if h >= 16:
        updated = str(slate.get("updated", "")).strip()
        src = str(slate.get("_source", ""))
        src_tag = src.rsplit("/", 1)[-1] if src else ""
        legend = (f"{C['good']}◆done{C['reset']}  {C['accent']}◈partial{C['reset']}  "
                  f"{C['warn']}◐active{C['reset']}  {C['muted']}○pending{C['reset']}")
        foot_bits = [legend]
        if updated:
            foot_bits.append(f"{C['muted']}updated {updated}{C['reset']}")
        if src_tag and tier == "wide":
            foot_bits.append(f"{C['muted']}{src_tag}{C['reset']}")
        lines.append("  " + "   ·   ".join(foot_bits))

    _emit(lines, h, tick)


# ── JSON flatten helper ─────────────────────────────────────────────────────

def _flatten_json(obj: Any, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out.update(_flatten_json(v, key))
            elif isinstance(v, list) and len(v) <= 5:
                out[key] = v
            elif isinstance(v, (int, float, str, bool)):
                out[key] = v
    return out


def _render_custom(title: str, metrics: dict, history: dict[str, list[float]], tick: int):
    w = term_width()
    h = term_height()
    tier = _size_tier(w)

    numeric_keys = [k for k, v in metrics.items() if isinstance(v, (int, float)) and not k.startswith("_")]
    string_keys = [k for k, v in metrics.items() if isinstance(v, str) and not k.startswith("_")]

    lines: list[str] = []

    # ── TINY: no frame, just key=value lines ────────────────────────────────
    if tier == "tiny":
        lines.append(f"{C['accent']}{title[:w]}{C['reset']}")
        for k in numeric_keys[:min(h - 1, 6)]:
            v = metrics[k]
            label = k[:max(w - 8, 3)]
            lines.append(f"{C['fg']}{label} {C['accent']}{fmt_number(v)}{C['reset']}")
        _emit(lines, h, tick)
        return

    # ── NARROW: single column ───────────────────────────────────────────────
    if tier == "narrow":
        if h >= 14:
            lines.append(wave_banner(tick, w))
        lines.append(box_top(w, title.upper()))

        label_w = min(12, w - 12)
        budget = h - len(lines) - 2  # save room for box_bot
        for k in numeric_keys[:budget]:
            v = metrics[k]
            lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['accent']}{fmt_number(v)}{C['reset']}", w))

        if h >= 14 and numeric_keys:
            lines.append(box_mid(w))
            spark_w = max(w - 12, 8)
            for k in numeric_keys[:2]:
                if k in history and len(history[k]) > 1:
                    lines.append(box_row(f" {C['fg']}{k[:4]} {sparkline(history[k], spark_w)}", w))

        for k in string_keys[:max(0, h - len(lines) - 2)]:
            v = metrics[k]
            lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['muted']}{str(v)[:w-label_w-6]}{C['reset']}", w))

        lines.append(box_bot(w))
        if h >= 16:
            lines.append(wave_banner(tick + 4, w))
        _emit(lines, h, tick)
        return

    # ── MEDIUM + WIDE: paired columns ───────────────────────────────────────
    if h >= 18:
        lines.append(wave_banner(tick, w))

    lines.append(box_top(w, title.upper()))

    label_w = 12
    for i in range(0, len(numeric_keys), 2):
        if len(lines) >= h - 4:
            break
        k1 = numeric_keys[i]
        v1 = metrics[k1]
        left = f" {C['fg']}{k1[:label_w]:{label_w}s} {C['accent']}{fmt_number(v1)}{C['reset']}"
        if i + 1 < len(numeric_keys):
            k2 = numeric_keys[i + 1]
            v2 = metrics[k2]
            right = f" {C['fg']}{k2[:label_w]:{label_w}s} {C['accent']}{fmt_number(v2)}{C['reset']}"
        else:
            right = ""
        lines.append(box_row_pair(left, right, w))

    if numeric_keys and h - len(lines) >= 5:
        lines.append(box_mid(w))
        spark_w = max(w - 18, 10)
        max_sparks = 4 if tier == "wide" else 2
        for k in numeric_keys[:max_sparks]:
            if len(lines) >= h - 3:
                break
            if k in history and len(history[k]) > 1:
                label = k[:6]
                lines.append(box_row(f" {C['fg']}{label:{6}s} ╌╌ {sparkline(history[k], spark_w)} ", w))

    for k in string_keys[:max(0, min(4, h - len(lines) - 3))]:
        v = metrics[k]
        lines.append(box_row(f" {C['fg']}{k[:label_w]:{label_w}s} {C['muted']}{str(v)[:w-label_w-6]}{C['reset']}", w))

    if "_error" in metrics:
        lines.append(box_row(f" {C['err']}Error: {metrics['_error'][:w-14]}{C['reset']}", w))

    lines.append(box_bot(w))

    if h >= 18:
        lines.append(wave_banner(tick + 4, w))
    if h >= 16:
        lines.append(f"{C['muted']}  Ctrl-C to exit{C['reset']}")

    _emit(lines, h, tick)


# ── SIGWINCH state ──────────────────────────────────────────────────────────
# Module-level flag set by the SIGWINCH handler and polled by the dashboard
# loops in wave-block.py. Lives here because resize is a renderer concern.

_resize_flag = False

def _on_resize(signum, frame):
    global _resize_flag
    _resize_flag = True
