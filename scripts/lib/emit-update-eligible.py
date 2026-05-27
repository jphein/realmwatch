#!/usr/bin/env python3
"""Emit fleet.yaml entries opted into `realm update --all-nodes`.

Reads fleet.yaml directly (bypassing lexicon.FleetEntry, which drops unknown
keys via its explicit dataclass field list) so the per-node opt-in block can
live next to the rest of the entry without a lexicon schema bump.

Opt-in shape (per entry):
  - fleet_id: mac:...
    current_name: disks
    realm_update:
      enabled: true
      sources: [apt, brew]   # optional allowlist (Phase B, currently advisory)
      os: ubuntu             # default; openwrt added in Phase B

Modes:
  --format=names   newline-separated current_names (default; for shell loops)
  --format=table   name<TAB>ops_ip<TAB>category<TAB>os   (humans / --list-hosts)
  --format=json    JSON array of full opt-in dicts        (machine pipelines)

Only emits entries with status in lexicon.fleet.LIVE_STATUSES.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ruamel.yaml import YAML

_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
sys.path.insert(0, str(_LEXICON_PY))

from lexicon.fleet import LIVE_STATUSES  # noqa: E402

FLEET_YAML = Path(__file__).parent.parent.parent / "fleet.yaml"


def _eligible(entry: dict) -> bool:
    ru = entry.get("realm_update") or {}
    if not isinstance(ru, dict):
        return False
    if not ru.get("enabled"):
        return False
    if entry.get("status", "curated") not in LIVE_STATUSES:
        return False
    return True


def _opt(entry: dict) -> dict:
    ru = entry.get("realm_update") or {}
    return {
        "name": entry.get("current_name") or entry.get("fleet_id"),
        "fleet_id": entry.get("fleet_id"),
        "ops_ip": entry.get("ops_ip") or "",
        "category": entry.get("category") or "",
        "os": (ru.get("os") or "ubuntu"),
        "sources": list(ru.get("sources") or []),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--format", choices=("names", "table", "json"), default="names")
    args = p.parse_args(argv)

    if not FLEET_YAML.exists():
        print(f"emit-update-eligible: {FLEET_YAML} missing", file=sys.stderr)
        return 1

    # ruamel.yaml typ="safe" mirrors PyYAML's safe_load: no !!python/object,
    # plain dicts/lists/scalars only. We never round-trip this file from here
    # (writes go through lexicon's typed model), so we don't need rt mode.
    yaml = YAML(typ="safe")
    with FLEET_YAML.open("r") as fh:
        root = yaml.load(fh) or {}
    nodes = root.get("nodes") or []

    rows = [_opt(n) for n in nodes if _eligible(n)]
    rows.sort(key=lambda r: r["name"])

    if args.format == "names":
        for r in rows:
            print(r["name"])
    elif args.format == "table":
        if not rows:
            print("# no fleet.yaml entries with realm_update.enabled: true", file=sys.stderr)
            return 0
        print("name\tops_ip\tcategory\tos")
        for r in rows:
            print(f"{r['name']}\t{r['ops_ip']}\t{r['category']}\t{r['os']}")
    else:  # json
        json.dump(rows, sys.stdout, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
