"""Lexicon plugin — fleet catalog (identity-of-record) for realmwatch.

Spec: docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import sys
from pathlib import Path

# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
if str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))

from lexicon import FleetCatalog, load_fleet_catalog  # noqa: E402

FLEET_YAML = Path(__file__).parent.parent.parent / "fleet.yaml"


def setup(ctx):
    """Register fleet resolver and endpoints."""
    if not FLEET_YAML.exists():
        ctx.log("WARN: fleet.yaml not found at %s — run scripts/migrate-fleet.py" % FLEET_YAML)
        ctx.expose_api({"resolve": lambda _: None, "list": lambda: [], "loaded": False})
        return

    catalog = load_fleet_catalog(FLEET_YAML)
    ctx.log(f"loaded fleet.yaml: {len(catalog.entries)} entries")

    ctx.expose_api({
        "resolve": catalog.resolve,
        "list": lambda: list(catalog.entries),
        "loaded": True,
        "_catalog": catalog,
    })
