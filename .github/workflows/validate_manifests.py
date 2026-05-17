#!/usr/bin/env python3
"""Validate every plugins/<name>/plugin.json conforms to the manifest schema.

Run from CI via .github/workflows/ci.yml. Exits non-zero on any failure
and emits GitHub-Actions-compatible ::error annotations.
"""

import json
import pathlib
import sys


REQUIRED = ("name", "version", "description")
ALLOWED_TYPES = ("integrated", "standalone", "on-demand")


def validate(p: pathlib.Path) -> list[str]:
    errors: list[str] = []
    try:
        m = json.loads(p.read_text())
    except json.JSONDecodeError as e:
        return [f"invalid JSON: {e}"]

    for field in REQUIRED:
        if field not in m:
            errors.append(f"missing required field: {field}")

    ptype = m.get("type")
    if ptype and ptype not in ALLOWED_TYPES:
        errors.append(f"type '{ptype}' not in {ALLOWED_TYPES}")

    cli = m.get("cli")
    if cli is not None:
        if not isinstance(cli, dict):
            errors.append("cli must be a JSON object")
        elif not cli.get("verbs"):
            errors.append("cli section requires verbs[]")
        else:
            for i, v in enumerate(cli["verbs"]):
                for k in ("name", "method", "path"):
                    if k not in v:
                        errors.append(f"cli.verbs[{i}] missing {k}")

    for proto in m.get("discovery_prototypes", []):
        if "entity_type" not in proto:
            errors.append("discovery_prototypes entry missing entity_type")

    return errors


def main() -> int:
    repo_root = pathlib.Path(__file__).resolve().parents[2]
    manifests = sorted(repo_root.glob("plugins/*/plugin.json"))
    if not manifests:
        print("::error::no plugin manifests found")
        return 1

    fail = 0
    for p in manifests:
        errors = validate(p)
        rel = p.relative_to(repo_root)
        if errors:
            fail += 1
            for e in errors:
                print(f"::error file={rel}::{e}")
        else:
            print(f"  ✓ {rel}")

    if fail:
        print(f"\n::error::{fail} plugin manifest(s) failed validation")
        return 1
    print(f"\nAll {len(manifests)} plugin manifests valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
