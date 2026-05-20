"""Tiny helper for looking up (and renaming) VLANs in vlans.yaml from anywhere in realmwatch.

Wraps lexicon.load_vlan_catalog() with a process-local cache so callers that
import this don't pay the YAML-parse cost on every lookup. vlans.yaml is the
gitignored single source of truth (see vlans.yaml.example for schema); this
is the import-from-anywhere accessor.

Lookup helpers (get / resolve / all_entries / zone_to_vlan) are read-only.
rename() mutates: it calls VLANCatalog.rename(), persists vlans.yaml via
.save(), and invalidates the cache so the next lookup re-reads from disk.

Usage:
    import realm_vlans
    entry = realm_vlans.get(10)              # -> VLANEntry(label="Cameras", ...)
    entry = realm_vlans.resolve("IoT")       # -> VLAN 10 (prior name → current)
    realm_vlans.rename(10, "Watchers", reason="thematic")  # persists to yaml
    realm_vlans.invalidate()                 # force reload

Design mirrors realm_fleet.py — same path-injection, same lazy + cached
pattern, same fallback-when-missing behavior.
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
    from lexicon import VLANCatalog, VLANEntry, VLANPriorName, load_vlan_catalog
except ImportError:
    VLANCatalog = None  # type: ignore
    VLANEntry = None    # type: ignore
    VLANPriorName = None  # type: ignore
    load_vlan_catalog = None  # type: ignore

_VLANS_YAML = Path(__file__).parent / "vlans.yaml"
_cached: Optional["VLANCatalog"] = None


def _catalog() -> Optional["VLANCatalog"]:
    """Return the cached VLANCatalog, loading it on first call. None if unavailable."""
    global _cached
    if _cached is not None:
        return _cached
    if load_vlan_catalog is None or not _VLANS_YAML.exists():
        return None
    try:
        _cached = load_vlan_catalog(_VLANS_YAML)
    except Exception as e:
        print(f"[realm_vlans] failed to load {_VLANS_YAML}: {e}", file=sys.stderr)
        return None
    return _cached


def invalidate() -> None:
    """Force the next lookup to re-read vlans.yaml. Useful after a rename."""
    global _cached
    _cached = None


def catalog() -> Optional["VLANCatalog"]:
    """Return the loaded VLANCatalog (or None if unavailable). Live object — callers
    can call .rename() / .save() on it and they should call invalidate() afterward."""
    return _catalog()


def get(vlan_id: int) -> Optional["VLANEntry"]:
    """Look up a VLAN by numeric ID. Returns None if missing or catalog unavailable."""
    cat = _catalog()
    return cat.resolve(vlan_id) if cat else None


def resolve(name_or_id: int | str) -> Optional["VLANEntry"]:
    """Look up a VLAN by ID (int or str) or by current/prior label."""
    cat = _catalog()
    return cat.resolve(name_or_id) if cat else None


def all_entries() -> list["VLANEntry"]:
    """Return all VLANEntry objects sorted by ID, or [] if catalog unavailable."""
    cat = _catalog()
    if cat is None:
        return []
    return sorted(cat.entries, key=lambda e: e.vlan_id)


def zone_to_vlan() -> dict:
    """fw4 zone-name → VLAN id (with WAN zones mapped to None)."""
    cat = _catalog()
    return cat.zone_to_vlan() if cat else {}


def rename(vlan_id: int, new_label: str, reason: Optional[str] = None) -> None:
    """Rename a VLAN's label, persisting to vlans.yaml. Raises if catalog unavailable."""
    cat = _catalog()
    if cat is None:
        raise RuntimeError(
            f"vlan catalog unavailable (check {_VLANS_YAML} exists and lexicon is importable)"
        )
    cat.rename(vlan_id, new_label, reason=reason)
    cat.save()
    invalidate()
