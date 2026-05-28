# Realmwatch Screenshots

Image assets for the project README and the GitHub Pages landing at
[realm.watch](https://realm.watch). See **[CAPTURE.md](CAPTURE.md)** for
the exact commands that produce each file — keep that in sync when you
add or rename images.

## Captured

### Wave Terminal TUIs

Rendered statically from each TUI's `render(...)` function via
`render-wave-tuis.py` (no live data needed):

| Preview | File | What it shows |
|---|---|---|
| ![bandwidth](wave-bandwidth.png) | `wave-bandwidth.{svg,png}` | `realm wave bandwidth` — live WAN trunk (gatekeeper br-lan.38) with 30s-bucket sparklines and per-direction stats |
| ![palace](wave-palace.png)       | `wave-palace.{svg,png}`    | `realm wave palace` — palace-daemon health pill, drawer/wing/tool counts |
| ![daemon](wave-daemon.png)       | `wave-daemon.{svg,png}`    | `realm wave daemon` — journal tail of palace-daemon with reconnect status footer |

SVG is the preferred embed for the GitHub Pages landing (scales
perfectly, ~5–50 KB). PNG is the README fallback since GitHub renders
inline `<img>` but not `<svg>` from a README on github.com.

### Static site pages

Captured from the built `docs/` Jekyll site via headless Chrome on disk:

| Preview | File | What it shows |
|---|---|---|
| ![landing](landing-page.png) | `landing-page.png` | `docs/index.html` hero at 1920×1080 (dark theme) |
| ![codex](codex-page.png)     | `codex-page.png`   | `docs/codex/index.html` chronicle index at 1920×1200 |

### Realm map (Playwright)

Captured by `scripts/capture-shots.py` against a running `map_server` on
port 80:

| Preview | File | What it shows |
|---|---|---|
| ![realm-full](01-realm-map-full.png) | `01-realm-map-full.png` | Full realm map at 2400×1500 — the treasure-map view |
| ![realm-zoom](02-realm-map-zoom.png) | `02-realm-map-zoom.png` | Mid-zoom at 1600×1100 showing nodes, regions, traffic ley lines |
| ![realm-3](03-node-panel.png)        | `03-node-panel.png`     | Map view at 1400×1000 — _node detail panel not yet captured here; current shot shows the bare map_ |
| ![realm-4](04-scan-panel.png)        | `04-scan-panel.png`     | Map view at 1400×1000 — _Survey Glass scan panel not yet captured here; current shot shows the bare map_ |
| ![realm-5](05-system-updates.png)    | `05-system-updates.png` | Map view at 1400×1000 — _Scroll of Patch Runes panel not yet captured here; current shot shows the bare map_ |

Shots 03–05 need follow-up work in `capture-shots.py` to actually open
the named panels before snapping. The current pass dismisses all panels
to expose the realm map underneath, so all three 1400×1000 frames look
the same. Filenames are kept stable so the README and landing page can
already reference them.

Refresh recipe in **[CAPTURE.md](CAPTURE.md)**. TL;DR:

```bash
make dev &                                       # leave running
uv pip install playwright && \
  .venv/bin/python3 -m playwright install chromium   # one-time
.venv/bin/python3 scripts/capture-shots.py
```

## Helpers in this directory

| File | Purpose |
|---|---|
| `render-wave-tuis.py` | Imports each Wave TUI's `render()` function with mocked state, exports SVG via `rich.Console.export_svg()`, rasterises to PNG via `inkscape`. |
| `CAPTURE.md` | Step-by-step capture recipe for every image above. |
