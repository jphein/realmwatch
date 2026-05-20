"""Tiny helper for looking up (and renaming) fw4 zones from anywhere in realmwatch.

Wraps lexicon.load_zone_catalog() with a process-local cache. zones.yaml is the
gitignored single source of truth — it tracks fw4 zone names on the firewall
device (currently just gatekeeper) and any prior names from past renames.

The catalog is identity-only. Mutating the actual fw4 state (uci edits, fw4
reload) is the CLI's job (realm zones rename); this shim provides the
catalog read/write surface that the CLI builds on.

Usage:
    import realm_zones
    entry = realm_zones.get("lan")           # -> ZoneEntry(current_name="lan", ...)
    entry = realm_zones.resolve("home")      # -> resolves via prior_names
    realm_zones.rename("lan", "cameras", reason="...")  # catalog only — not fw4
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from realm_text import real_home


_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
if str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))

try:
    from lexicon import ZoneCatalog, ZoneEntry, ZonePriorName, load_zone_catalog
except ImportError:
    ZoneCatalog = None  # type: ignore
    ZoneEntry = None    # type: ignore
    ZonePriorName = None  # type: ignore
    load_zone_catalog = None  # type: ignore

_ZONES_YAML = Path(__file__).parent / "zones.yaml"
_cached: Optional["ZoneCatalog"] = None


def _catalog() -> Optional["ZoneCatalog"]:
    """Return the cached ZoneCatalog, loading on first call. None if unavailable."""
    global _cached
    if _cached is not None:
        return _cached
    if load_zone_catalog is None or not _ZONES_YAML.exists():
        return None
    try:
        _cached = load_zone_catalog(_ZONES_YAML)
    except Exception as e:
        print(f"[realm_zones] failed to load {_ZONES_YAML}: {e}", file=sys.stderr)
        return None
    return _cached


def invalidate() -> None:
    """Force the next lookup to re-read zones.yaml."""
    global _cached
    _cached = None


def catalog() -> Optional["ZoneCatalog"]:
    """Return the loaded ZoneCatalog (or None). Live object."""
    return _catalog()


def get(name: str) -> Optional["ZoneEntry"]:
    """Look up a zone by exact current_name. None if missing."""
    cat = _catalog()
    if cat is None:
        return None
    return next((e for e in cat.entries if e.current_name == name), None)


def resolve(name: str) -> Optional["ZoneEntry"]:
    """Look up a zone by current name or any prior name."""
    cat = _catalog()
    return cat.resolve(name) if cat else None


def all_entries() -> list:
    """Return all ZoneEntry objects in catalog order, or [] if unavailable."""
    cat = _catalog()
    if cat is None:
        return []
    return list(cat.entries)


def rename(old_name: str, new_name: str, reason: Optional[str] = None) -> None:
    """Rename a zone in the catalog (does NOT touch the actual firewall).
    Persists to zones.yaml. Raises if catalog unavailable."""
    cat = _catalog()
    if cat is None:
        raise RuntimeError(
            f"zone catalog unavailable (check {_ZONES_YAML} exists and lexicon is importable)"
        )
    cat.rename(old_name, new_name, reason=reason)
    cat.save()
    invalidate()
