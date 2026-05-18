#!/usr/bin/env python3
"""One-shot migration: realm.db nodes → fleet.yaml.

Idempotent. Run without flags for dry-run; rerun with --apply to actually write.
Per spec: docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import uuid
from datetime import date
from pathlib import Path

# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
sys.path.insert(0, str(_LEXICON_PY))

from lexicon import FleetCatalog, FleetEntry  # noqa: E402

REPO = Path(__file__).parent.parent
REALM_DB = REPO / "realm.db"
FLEET_YAML = REPO / "fleet.yaml"
PERSONAS_JSON = REPO / "personas.json"
REALM_LOCAL_JSON = REPO / "realm-local.json"


def derive_realm_from_role(role: str | None) -> str:
    """Map a role string to a realm. Conservative — defaults to signal."""
    if not role:
        return "signal"
    role_lower = role.lower()
    realm_hints = {
        "router": "signal",
        "switch": "signal",
        "access_point": "signal",
        "server": "forge",
        "printer": "forest",
        "camera": "void",
        "wled": "stellar",
        "ha_": "oracle",
    }
    for prefix, realm in realm_hints.items():
        if prefix in role_lower:
            return realm
    return "signal"


def plan_migration(db_path: Path) -> tuple[list[FleetEntry], list[tuple[str, str]]]:
    """Read realm.db nodes, build fleet entries, return (entries, db_writebacks)."""
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    entries: list[FleetEntry] = []
    writebacks: list[tuple[str, str]] = []

    for row in db.execute("SELECT node_id, data FROM nodes"):
        node_id = row["node_id"]
        try:
            data = json.loads(row["data"] or "{}")
        except json.JSONDecodeError:
            print(f"  WARN: bad JSON in node {node_id}, skipping", file=sys.stderr)
            continue

        existing_fleet_id = data.get("fleet_id")
        mac = (data.get("mac") or "").lower().strip()
        if mac and ":" in mac:
            fleet_id = f"mac:{mac}"
        elif existing_fleet_id:
            fleet_id = existing_fleet_id
        else:
            fleet_id = f"fleet:{uuid.uuid4()}"

        entry = FleetEntry(
            fleet_id=fleet_id,
            current_name=node_id,
            prior_names=[],
            realm=derive_realm_from_role(data.get("role")),
            kind=data.get("type"),
            role=data.get("role"),
            vendor=data.get("vendor"),
            status="curated",
            first_seen=str(date.today()),
            last_seen=str(date.today()),
        )
        entries.append(entry)

        new_data = dict(data)
        new_data["fleet_id"] = fleet_id
        for k in ("label", "role", "realm", "type", "vendor"):
            new_data.pop(k, None)
        writebacks.append((node_id, json.dumps(new_data)))

    db.close()
    return entries, writebacks


def rekey_json_file(path: Path, key_to_fleet_id: dict[str, str], apply: bool) -> None:
    if not path.exists():
        print(f"  skip: {path.name} not present")
        return
    data = json.loads(path.read_text())
    rekeyed_top: dict[str, object] = {}
    legacy_map: dict[str, str] = {}
    for k, v in data.items():
        if k in ("_comment", "_legacy_name_map"):
            rekeyed_top[k] = v
            continue
        # Case A: top-level key IS a known node name (e.g. personas.json) — rekey here
        top_fid = key_to_fleet_id.get(k)
        if top_fid:
            rekeyed_top[top_fid] = v
            legacy_map[top_fid] = k
            continue
        # Case B: top-level key is a namespace (e.g. realm-local.json herald_node_templates) — recurse one level
        if isinstance(v, dict):
            new_inner = {}
            for inner_k, inner_v in v.items():
                inner_fid = key_to_fleet_id.get(inner_k)
                if inner_fid:
                    new_inner[inner_fid] = inner_v
                    legacy_map[inner_fid] = inner_k
                else:
                    new_inner[inner_k] = inner_v
            rekeyed_top[k] = new_inner
        else:
            rekeyed_top[k] = v
    if legacy_map:
        rekeyed_top["_legacy_name_map"] = legacy_map

    if apply:
        backup = path.with_suffix(path.suffix + f".pre-fleet-{date.today().isoformat()}")
        shutil.copy2(path, backup)
        path.write_text(json.dumps(rekeyed_top, indent=2))
        print(f"  rekeyed {path.name}: {len(legacy_map)} keys converted (backup: {backup.name})")
    else:
        print(f"  would rekey {path.name}: {len(legacy_map)} keys")


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate realm.db → fleet.yaml")
    parser.add_argument("--apply", action="store_true",
                        help="actually write files (default: dry-run)")
    parser.add_argument("--db", default=str(REALM_DB), help="path to realm.db")
    parser.add_argument("--out", default=str(FLEET_YAML), help="path to write fleet.yaml")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: {db_path} not found", file=sys.stderr)
        return 1

    entries, writebacks = plan_migration(db_path)

    by_anchor = {"mac": 0, "fleet": 0}
    for e in entries:
        by_anchor[e.fleet_id.split(":", 1)[0]] += 1

    print(f"would write {len(entries)} fleet entries:")
    print(f"  mac-anchored:   {by_anchor['mac']}")
    print(f"  uuid-anchored:  {by_anchor['fleet']}")
    print(f"would rewrite {len(writebacks)} realm.db nodes.data blobs")
    print()
    print("sample entries:")
    for e in entries[:5]:
        print(f"  {e.fleet_id:50s} -> {e.current_name:25s} realm={e.realm}")

    if not args.apply:
        print()
        print("(dry-run; rerun with --apply to write)")
        # still preview rekey
        name_to_id = {e.current_name: e.fleet_id for e in entries}
        rekey_json_file(PERSONAS_JSON, name_to_id, apply=False)
        rekey_json_file(REALM_LOCAL_JSON, name_to_id, apply=False)
        return 0

    backup = db_path.with_suffix(f".db.pre-fleet-{date.today().isoformat()}")
    shutil.copy2(db_path, backup)
    print(f"backed up realm.db -> {backup}")

    out_path = Path(args.out)
    catalog = FleetCatalog(entries=entries, source_path=out_path)
    catalog.save(out_path)
    print(f"wrote {out_path}")

    db = sqlite3.connect(db_path)
    for node_id, new_data in writebacks:
        db.execute("UPDATE nodes SET data = ? WHERE node_id = ?", (new_data, node_id))
    db.commit()
    db.close()
    print(f"rewrote {len(writebacks)} realm.db node data blobs")

    name_to_id = {e.current_name: e.fleet_id for e in entries}
    rekey_json_file(PERSONAS_JSON, name_to_id, apply=True)
    rekey_json_file(REALM_LOCAL_JSON, name_to_id, apply=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
