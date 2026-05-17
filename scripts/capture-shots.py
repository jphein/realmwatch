#!/usr/bin/env python3
"""Capture realm-map screenshots for README + GitHub Pages landing.

Drives a headless Chromium via Playwright against a running map_server.
Run from the repo root once `make dev` is up. Writes PNG + cropped variants
to docs/screenshots/.

  python3 scripts/capture-shots.py [--host URL] [--out DIR] [--keep-server]

Prereq: `pip install playwright && playwright install chromium`. The script
checks for both and prints install commands if anything is missing.
"""
from __future__ import annotations

import argparse
import importlib.util
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_HOST = "http://localhost"
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "docs" / "screenshots"
SHOTS = [
    # (filename, viewport_w, viewport_h, wait_ms_after_load, description)
    ("01-realm-map-full.png", 2400, 1500, 4000, "Full realm map at zoom-out — the treasure-map view"),
    ("02-realm-map-zoom.png", 1600, 1100, 4500, "Mid-zoom showing nodes, regions, traffic ley lines"),
    ("03-node-panel.png",     1400, 1000, 4500, "Node detail panel — stats, persona, controls"),
    ("04-scan-panel.png",     1400, 1000, 4500, "Survey Glass scan panel mid-discovery"),
    ("05-system-updates.png", 1400, 1000, 4500, "Scroll of Patch Runes — pending updates per source"),
]


def fail(msg: str, code: int = 1) -> None:
    print(f"\x1b[31m✘ {msg}\x1b[0m", file=sys.stderr)
    sys.exit(code)


def preflight() -> None:
    if importlib.util.find_spec("playwright") is None:
        fail(
            "playwright not installed. Run:\n"
            "  pip install --user playwright && python3 -m playwright install chromium",
        )
    if shutil.which("python3") is None:
        fail("python3 not on PATH (somehow). Install Python 3.10+.")


def server_reachable(host: str) -> bool:
    try:
        with urllib.request.urlopen(f"{host}/status", timeout=3) as r:
            return r.status == 200
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return False


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--host", default=DEFAULT_HOST, help=f"map_server URL (default {DEFAULT_HOST})")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output directory (default {DEFAULT_OUT})")
    p.add_argument("--keep-server", action="store_true", help="don't suggest starting map_server even if down")
    args = p.parse_args()

    preflight()

    if not server_reachable(args.host):
        msg = f"map_server unreachable at {args.host}"
        if not args.keep_server:
            msg += "\n  Start it with: make dev"
        fail(msg, code=3)

    args.out.mkdir(parents=True, exist_ok=True)

    # Import after preflight so the failure path is clean.
    from playwright.sync_api import sync_playwright  # noqa: E402

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        for filename, w, h, wait_ms, description in SHOTS:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
            page = ctx.new_page()
            page.goto(f"{args.host}/realm-map.html", wait_until="networkidle")
            # Wait for SVG topology nodes to render — confirms the SSE bootstrap landed.
            page.wait_for_selector("svg .node, svg g.node, [data-node-id]", timeout=10_000)
            page.wait_for_timeout(wait_ms)
            out = args.out / filename
            page.screenshot(path=str(out), full_page=False)
            ctx.close()
            print(f"  {filename}  ({w}×{h})  — {description}")
        browser.close()

    print(f"\nWrote {len(SHOTS)} screenshots to {args.out}")
    print("\nNext: review them with `xdg-open docs/screenshots/`, then commit.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
