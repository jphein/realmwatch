"""Lexicon plugin — fleet catalog (identity-of-record) for realmwatch.

Spec: docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import os
import pwd
import sys
from pathlib import Path


def _real_home() -> Path:
    """Find the user's real home even when launched under sudo.

    `make dev` typically runs as root (port 80), which makes Path.home()
    return /root. Fall back to SUDO_USER's home, then to LOGNAME, then
    to the current user's home.
    """
    for env_var in ("SUDO_USER", "LOGNAME", "USER"):
        user = os.environ.get(env_var)
        if user and user != "root":
            try:
                return Path(pwd.getpwnam(user).pw_dir)
            except KeyError:
                continue
    return Path.home()


# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = _real_home() / "Projects" / "lexicon.realm.watch" / "python"
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

    from . import endpoints
    endpoints.register(ctx, catalog)

    from . import discovery as _discovery_mod
    try:
        import discovery_engine as _de
        _de.set_push_event_fn(ctx.push_event)
    except Exception as e:
        print(f"[lexicon] could not register discovery push_event_fn: {e}")

    def _discovery_cb(evt):
        try:
            if _discovery_mod.on_discovery_observation(
                catalog,
                evt.get("mac"),
                evt.get("hostname"),
                evt.get("vendor_oui"),
                evt.get("evidence") or {},
                catalog.save,
            ):
                ctx.push_event("plugin-broadcast",
                               {"type": "fleet-update", "kind": "tentative-added"})
        except Exception as e:
            print(f"[lexicon] discovery callback error: {e}")
    ctx.on_event("discovery.observation", _discovery_cb)

    from . import watcher as _watcher_mod
    def _reload_from_disk():
        new_cat = load_fleet_catalog(FLEET_YAML)
        catalog.entries = new_cat.entries
        catalog._reindex()
        ctx.push_event("plugin-broadcast", {"type": "fleet-update", "reloaded": True})
        print(f"[lexicon] fleet.yaml reloaded: {len(catalog.entries)} entries")

    _fleet_watcher = _watcher_mod.FleetWatcher(FLEET_YAML, _reload_from_disk)
    _fleet_watcher.start()
