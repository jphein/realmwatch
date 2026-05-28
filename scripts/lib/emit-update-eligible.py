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
      sources: [apt, brew]   # optional allowlist (currently advisory)
      os: ubuntu | openwrt   # explicit; falls back to category-inferred
                             # (ap/router/switch_openwrt → openwrt, else ubuntu)

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

# Resolve paths via realm_text.real_home() so this works under sudo —
# Path.home() returns /root when invoked by `sudo realm update …`, but JP's
# lexicon checkout lives at /home/jp/Projects/. realm_text lives at the
# realmwatch repo root (two levels up from scripts/lib/).
_REPO_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT))
from realm_text import real_home  # noqa: E402

_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
sys.path.insert(0, str(_LEXICON_PY))

from lexicon.fleet import LIVE_STATUSES  # noqa: E402

FLEET_YAML = _REPO_ROOT / "fleet.yaml"


def _eligible(entry: dict) -> bool:
    ru = entry.get("realm_update") or {}
    if not isinstance(ru, dict):
        return False
    if not ru.get("enabled"):
        return False
    if entry.get("status", "curated") not in LIVE_STATUSES:
        return False
    return True


# Phase B: when an entry does not declare realm_update.os, infer from
# category/role. The OpenWrt-family categories in fleet.yaml are `ap`,
# `router`, and `switch_openwrt`; everything else (server, service,
# infra_*, switch_vendor, …) stays on the back-compat `ubuntu` default.
_OPENWRT_CATEGORIES = frozenset({"ap", "router", "switch_openwrt"})


def _infer_os(entry: dict) -> str:
    if (entry.get("category") or "") in _OPENWRT_CATEGORIES:
        return "openwrt"
    if (entry.get("vendor") or "").lower().startswith("openwrt"):
        return "openwrt"
    return "ubuntu"


def _opt(entry: dict) -> dict:
    ru = entry.get("realm_update") or {}
    return {
        "name": entry.get("current_name") or entry.get("fleet_id"),
        "fleet_id": entry.get("fleet_id"),
        "ops_ip": entry.get("ops_ip") or "",
        "category": entry.get("category") or "",
        "os": (ru.get("os") or _infer_os(entry)),
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
        root = yaml.load(fh)
    # Guard against an empty / malformed fleet.yaml (None, scalar, list, etc.)
    # — anything but a mapping at the root yields zero nodes rather than crash.
    if not isinstance(root, dict):
        root = {}
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
