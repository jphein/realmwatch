"""Tiny read-only helper for looking up hosts in fleet.yaml from anywhere in realmwatch.

Wraps lexicon.load_fleet_catalog() with a process-local cache so callers that
import this don't pay the YAML-parse cost on every lookup. fleet.yaml is the
gitignored single source of truth; this is the import-from-anywhere accessor.

Usage:
    import realm_fleet
    ip = realm_fleet.host_ip("katana")         # -> "10.0.6.129"
    ip = realm_fleet.host_ip("ubox0")          # -> "10.0.6.11" (alias resolves to oracle)
    entry = realm_fleet.host("gatekeeper")     # -> FleetEntry
    realm_fleet.invalidate()                   # force reload (rare; mtime watcher in
                                               # the lexicon plugin handles most cases)

Design:
- Lazy — fleet.yaml is loaded on first lookup, not at import.
- Cached — subsequent lookups share one FleetCatalog instance.
- Fallback-aware — if fleet.yaml is missing or unreadable, host_ip() returns None
  rather than raising. Callers can fall back to env vars / their own defaults.
- Path-injection follows the realm-sigil precedent (CLAUDE.md).
"""

from __future__ import annotations

import os
import pwd
import sys
from pathlib import Path
from typing import Optional


def _real_home() -> Path:
    """Find the user's real home even when launched under sudo (server binds port 80)."""
    for env_var in ("SUDO_USER", "LOGNAME", "USER"):
        user = os.environ.get(env_var)
        if user and user != "root":
            try:
                return Path(pwd.getpwnam(user).pw_dir)
            except KeyError:
                continue
    return Path.home()


# Path-injection — same pattern used by plugins/lexicon/plugin.py
_LEXICON_PY = _real_home() / "Projects" / "lexicon.realm.watch" / "python"
if str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))

try:
    from lexicon import FleetCatalog, FleetEntry, load_fleet_catalog
except ImportError:
    FleetCatalog = None  # type: ignore
    FleetEntry = None    # type: ignore
    load_fleet_catalog = None  # type: ignore

_FLEET_YAML = Path(__file__).parent / "fleet.yaml"
_cached: Optional["FleetCatalog"] = None


def _catalog() -> Optional["FleetCatalog"]:
    """Return the cached FleetCatalog, loading it on first call. None if unavailable."""
    global _cached
    if _cached is not None:
        return _cached
    if load_fleet_catalog is None or not _FLEET_YAML.exists():
        return None
    try:
        _cached = load_fleet_catalog(_FLEET_YAML)
    except Exception as e:
        # Validation failure or YAML parse error — log to stderr, fall back to None.
        print(f"[realm_fleet] failed to load {_FLEET_YAML}: {e}", file=sys.stderr)
        return None
    return _cached


def invalidate() -> None:
    """Force the next lookup to re-read fleet.yaml. Useful after a /fleet/* mutation."""
    global _cached
    _cached = None


def host(name_or_id: str) -> Optional["FleetEntry"]:
    """Resolve a name (current_name, prior_name, or fleet_id) to a FleetEntry, or None."""
    cat = _catalog()
    if cat is None:
        return None
    return cat.resolve(name_or_id)


def host_ip(name_or_id: str, env_var: Optional[str] = None,
            default: Optional[str] = None) -> Optional[str]:
    """Return the operator-curated ops_ip for a host.

    Lookup order:
      1. fleet.yaml entry's ops_ip
      2. env var (if env_var provided)
      3. default (if provided)
      4. None
    """
    entry = host(name_or_id)
    if entry and entry.ops_ip:
        return entry.ops_ip
    if env_var:
        v = os.environ.get(env_var)
        if v:
            return v
    return default


def hosts_by_category(category: str) -> list["FleetEntry"]:
    """Return all curated entries with the given category."""
    cat = _catalog()
    if cat is None:
        return []
    return [e for e in cat.entries if e.status == "curated" and e.category == category]
