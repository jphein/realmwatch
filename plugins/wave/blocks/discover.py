#!/usr/bin/env python3
"""Discover wave-block manifests across all realmwatch plugins.

Scans `plugins/*/plugin.json` for a `wave` block and emits one TSV line
per declared verb so the (bash) `plugins/wave/cli` dispatcher can merge
discovered verbs with its hardcoded entries.

Manifest shape (single verb):

    {
      ...,
      "wave": {
        "verb":     "latency",
        "title":    "Realm Latency",
        "summary":  "Per-VLAN latency heatmap + sparklines",
        "cmd":      "realm latency show --json",
        "mode":     "custom",         // or "backfill"
        "interval": 30
      }
    }

A plugin may also declare an array of wave blocks if it owns multiple
verbs (`"wave": [ {...}, {...} ]`).

Output (TSV, one line per discovered verb):
    verb<TAB>title<TAB>summary<TAB>mode<TAB>interval<TAB>cmd

The cmd column may contain spaces and special chars, hence is emitted last.
"""
from __future__ import annotations

import json
import os
import sys

# This file lives at plugins/wave/blocks/discover.py — four `dirname`s
# (file → blocks → wave → plugins → repo) get us to the repo root.
HERE = os.path.abspath(__file__)
PLUGINS_DIR = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))


def _emit(verb: str, manifest: dict) -> None:
    title = str(manifest.get("title", verb))
    summary = str(manifest.get("summary", ""))
    cmd = str(manifest.get("cmd", "")).strip()
    if not cmd:
        return
    mode = str(manifest.get("mode", "custom"))
    interval = str(manifest.get("interval", "5"))
    # Strip tabs/newlines defensively so bash can split safely.
    for field in (title, summary, cmd, mode, interval):
        if "\t" in field or "\n" in field:
            print(f"# discover: bad whitespace in {verb!r}, skipping", file=sys.stderr)
            return
    print(f"{verb}\t{title}\t{summary}\t{mode}\t{interval}\t{cmd}")


def main() -> int:
    if not os.path.isdir(PLUGINS_DIR):
        return 0
    for name in sorted(os.listdir(PLUGINS_DIR)):
        manifest_path = os.path.join(PLUGINS_DIR, name, "plugin.json")
        if not os.path.isfile(manifest_path):
            continue
        try:
            with open(manifest_path) as f:
                plugin = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"# discover: {name}/plugin.json unreadable: {e}", file=sys.stderr)
            continue
        wave = plugin.get("wave")
        if not wave:
            continue
        blocks = wave if isinstance(wave, list) else [wave]
        for block in blocks:
            if not isinstance(block, dict):
                continue
            verb = str(block.get("verb", "")).strip()
            if not verb:
                continue
            _emit(verb, block)
    return 0


if __name__ == "__main__":
    sys.exit(main())
