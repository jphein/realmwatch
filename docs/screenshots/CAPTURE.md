# Screenshot Capture Recipe

Exact commands to (re)generate every image in this directory. Run from
the realmwatch repo root unless noted.

Resolutions, viewport sizes, and wait times are tuned for the README and
GitHub Pages landing — change them only if you also update the consumers.

---

## 1. Realm map (`01-realm-map-full.png` and friends)

Driven by the existing `scripts/capture-shots.py` (Playwright + headless
Chromium). Requires a running `map_server` and Playwright installed in
the project venv.

```bash
# one-time
.venv/bin/pip install playwright
.venv/bin/python3 -m playwright install chromium

# in shell A — leave running
make dev

# in shell B
.venv/bin/python3 scripts/capture-shots.py
```

Writes five PNGs at 2× device pixel ratio:

| File | Viewport | Wait | What it shows |
|---|---|---|---|
| `01-realm-map-full.png` | 2400×1500 | 4.0s | Full realm map at zoom-out — the treasure-map view |
| `02-realm-map-zoom.png` | 1600×1100 | 4.5s | Mid-zoom showing nodes, regions, traffic ley lines |
| `03-node-panel.png`     | 1400×1000 | 4.5s | Node detail panel — stats, persona, controls |
| `04-scan-panel.png`     | 1400×1000 | 4.5s | Survey Glass scan panel mid-discovery |
| `05-system-updates.png` | 1400×1000 | 4.5s | Scroll of Patch Runes — pending updates per source |

To target a remote map_server (e.g. `realm.watch`):

```bash
.venv/bin/python3 scripts/capture-shots.py --host https://realm.watch
```

Skip the running-server check with `--keep-server` — useful when
hammering a static SVG snapshot only.

**Heads-up:** `capture-shots.py` waits for a `svg .node, svg g.node,
[data-node-id]` selector to appear before snapping, so the SSE topology
burst must land first. If you see "timed out waiting for selector" the
plugin set isn't producing a topology event — check `make health` and
`curl -sf http://localhost/topology | head` before re-running.

---

## 2. Wave Terminal TUIs (`wave-{bandwidth,palace,daemon}.{svg,png}`)

These are **rendered from mocked state**, not captured from a live
terminal. The TUI source defines a pure `render(...)` function that
returns a Rich renderable; the capture helper imports it, feeds it
plausible data, and emits a single frame via
`rich.console.Console.export_svg()` — then rasterises with `inkscape`
to PNG.

This means TUI screenshots do **not** require:

- a live collectd source (bandwidth TUI normally polls gatekeeper)
- ssh to `familiar` or a `PALACE_API_KEY` (palace TUI)
- a tail of `journalctl` on familiar (daemon TUI)

```bash
# from repo root
.venv/bin/python3 docs/screenshots/render-wave-tuis.py
```

Defaults: 120 columns × 30 rows, inkscape at 120 DPI → ~1853 px wide
PNGs (HiDPI-friendly for README rendering on github.com).

Files written:

| File | Source | What it shows |
|---|---|---|
| `wave-bandwidth.svg` / `.png` | `plugins/wave/tuis/bandwidth.py` | WAN trunk live + 30s-bucket sparklines + stats columns |
| `wave-palace.svg`    / `.png` | `plugins/wave/tuis/palace_status.py` | palace-daemon health pill + drawer/wing/tool counts |
| `wave-daemon.svg`    / `.png` | mocked (no `render()` in `daemon_log.py`) | Journal tail with realistic palace-daemon entries |

**SVG is preferred** for the GitHub Pages landing — it scales perfectly
and is ~5–50 KB. **PNG** is the fallback for `README.md` since GitHub
does not render `<svg>` inline in repo READMEs.

If `inkscape` is missing the script falls back to `convert` (ImageMagick).
If both are missing it writes the SVGs and skips PNG with a warning.

---

## 3. Static site pages (`landing-page.png`, `codex-page.png`)

The Jekyll-built `docs/` site is static — capture it directly from
disk with headless Chromium. No server needed.

```bash
# landing
google-chrome --headless --no-sandbox --hide-scrollbars --disable-gpu \
  --screenshot=docs/screenshots/landing-page.png \
  --window-size=1920,1080 \
  "file://$PWD/docs/index.html"

# codex landing
google-chrome --headless --no-sandbox --hide-scrollbars --disable-gpu \
  --screenshot=docs/screenshots/codex-page.png \
  --window-size=1920,1200 \
  "file://$PWD/docs/codex/index.html"
```

These render the dark theme (Chrome headless defaults to no
`prefers-color-scheme`, which our CSS treats as the dark realm-at-night
look). To force light/parchment:

```bash
google-chrome --headless --no-sandbox --hide-scrollbars --disable-gpu \
  --force-prefers-color-scheme=light \
  --screenshot=docs/screenshots/landing-page-light.png \
  --window-size=1920,1080 \
  "file://$PWD/docs/index.html"
```

(Flag works on Chrome ≥ 110. If unavailable, use a CSS override or run
the page in a real browser with the OS toggled.)

---

## 4. Refreshing everything

```bash
# wave TUIs — always fast, no daemons needed
.venv/bin/python3 docs/screenshots/render-wave-tuis.py

# static site pages — also fast
for page in index.html codex/index.html; do
  name=$(echo "$page" | tr '/' '-' | sed 's/.html$//')
  google-chrome --headless --no-sandbox --hide-scrollbars --disable-gpu \
    --screenshot="docs/screenshots/${name/index/landing}.png" \
    --window-size=1920,1080 \
    "file://$PWD/docs/$page"
done

# realm map — only if you've got map_server up
make dev &      # or `systemctl --user start realm-map-server`
sleep 5
.venv/bin/python3 scripts/capture-shots.py
```

---

## Tools used / available on the dev host (`katana`)

| Tool | Purpose | Status on katana |
|---|---|---|
| `google-chrome` | headless page capture | present (`Google Chrome 148`) |
| `inkscape` | SVG → PNG rasterise | present |
| `convert` (ImageMagick) | SVG → PNG fallback | present |
| `playwright` | scripted browser capture for `capture-shots.py` | needs `pip install` (one-time) |
| `firefox` | sanity-check rendering | present |
| `xdg-open` | preview a generated PNG | present |

Out of scope: live TTY capture (e.g. `asciinema` → `agg`) is intentionally
avoided because Rich's `export_svg()` already gives us a clean, sharp
frame without needing a graphical terminal.
