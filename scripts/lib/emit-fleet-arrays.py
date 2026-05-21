#!/usr/bin/env python3
"""Emit bash array definitions from fleet.yaml. Sourced by scripts/lib/fleet.sh.

Reads fleet.yaml as the single source of truth. Groups entries by their
operator-curated `category` field into bash associative arrays.

Output (printed to stdout):
  declare -A APS=( [name]="ip" ... )
  declare -A ROUTERS=( ... )
  declare -A SWITCHES_OPENWRT=( ... )
  declare -A SWITCHES_VENDOR=( ... )
  declare -A OPENWRT_FLEET   # union of APS + ROUTERS + SWITCHES_OPENWRT

Entries without `category` set are skipped — operator-curated only.
Entries without `ops_ip` set fall back to `?` so the shape is preserved.

Usage:
  scripts/lib/fleet.sh sources this via `eval "$(python3 .../emit-fleet-arrays.py)"`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
sys.path.insert(0, str(_LEXICON_PY))

from lexicon import load_fleet_catalog  # noqa: E402
from lexicon.fleet import LIVE_STATUSES  # noqa: E402

FLEET_YAML = Path(__file__).parent.parent.parent / "fleet.yaml"

# category -> bash array name
CATEGORY_TO_ARRAY = {
    "ap": "APS",
    "router": "ROUTERS",
    "switch_openwrt": "SWITCHES_OPENWRT",
    "switch_vendor": "SWITCHES_VENDOR",
}


def main():
    if not FLEET_YAML.exists():
        print(f"# emit-fleet-arrays: {FLEET_YAML} missing — emitting empty arrays", file=sys.stderr)
        for arr in CATEGORY_TO_ARRAY.values():
            print(f"declare -A {arr}=()")
        print("declare -A OPENWRT_FLEET=()")
        return 0

    cat = load_fleet_catalog(FLEET_YAML)
    buckets: dict[str, list[tuple[str, str, str]]] = {arr: [] for arr in CATEGORY_TO_ARRAY.values()}

    for entry in cat.entries:
        if entry.status not in LIVE_STATUSES:
            continue
        arr = CATEGORY_TO_ARRAY.get(entry.category or "")
        if not arr:
            continue
        ip = entry.ops_ip or "?"
        vendor = entry.vendor or ""
        buckets[arr].append((entry.current_name, ip, vendor))

    for bucket in buckets.values():
        bucket.sort(key=lambda t: t[0])

    print(f"# generated from fleet.yaml ({len(cat.entries)} entries; {sum(len(b) for b in buckets.values())} categorized)")
    for category, arr in CATEGORY_TO_ARRAY.items():
        print(f"declare -A {arr}=(")
        for name, ip, vendor in buckets[arr]:
            comment = f"  # {vendor}" if vendor else ""
            print(f'  [{name}]="{ip}"{comment}')
        print(")")

    # Derive OPENWRT_FLEET = APS + ROUTERS + SWITCHES_OPENWRT
    print("declare -A OPENWRT_FLEET")
    print('for _k in "${!APS[@]}";              do OPENWRT_FLEET[$_k]="${APS[$_k]}";              done')
    print('for _k in "${!ROUTERS[@]}";          do OPENWRT_FLEET[$_k]="${ROUTERS[$_k]}";          done')
    print('for _k in "${!SWITCHES_OPENWRT[@]}"; do OPENWRT_FLEET[$_k]="${SWITCHES_OPENWRT[$_k]}"; done')
    print("unset _k")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
