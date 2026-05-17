# Realmwatch Screenshots

Populated by `scripts/capture-shots.py`. Run from the repo root once
`map_server.py` is up:

```bash
make dev                                # in one shell, leave running
make screenshots                        # in another (or python3 scripts/capture-shots.py)
```

Captured shots (filenames are stable; README + landing reference them):

| File | What it shows |
|---|---|
| `01-realm-map-full.png` | Full realm map at zoom-out — the treasure-map view |
| `02-realm-map-zoom.png` | Mid-zoom showing nodes, regions, traffic ley lines |
| `03-node-panel.png` | Node detail panel — stats, persona, controls |
| `04-scan-panel.png` | Survey Glass scan panel mid-discovery |
| `05-system-updates.png` | Scroll of Patch Runes — pending updates per source |

The capture script uses Playwright + headless Chromium at 2× device pixel
ratio (Retina-quality). One-time install:

```bash
pip install --user playwright
python3 -m playwright install chromium
```
