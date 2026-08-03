"""Lexicon plugin — fleet catalog (identity-of-record) for realmwatch.

Spec: docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import sys
from pathlib import Path

# realm_text lives at the realmwatch repo root — guaranteed on sys.path by
# the time map_server.py imports plugin_loader.
from realm_text import real_home


# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
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
        # realm_fleet keeps its OWN FleetCatalog, loaded once and cached for the
        # life of the process. Reloading only this plugin's copy left every
        # realm_fleet consumer — wol, palace, mcp tools, ap_scanner, ha_bridge —
        # serving the snapshot taken at startup, so a corrected ops_ip never
        # reached them and the docs' "edit fleet.yaml, hot-reloads in ~2s" was
        # only true inside lexicon. Observed 2026-08-02 while fixing #122:
        # serialhub's ops_ip stayed at the re-leased 10.0.6.123 after the edit.
        try:
            import realm_fleet
            realm_fleet.invalidate()
        except Exception as e:
            print(f"[lexicon] realm_fleet.invalidate() failed: {e}", flush=True)
        ctx.push_event("plugin-broadcast", {"type": "fleet-update", "reloaded": True})
        # flush=True: stdout is a pipe under systemd, so an unflushed reload
        # notice sits in the buffer and the watcher looks dead when it is not.
        print(f"[lexicon] fleet.yaml reloaded: {len(catalog.entries)} entries", flush=True)

    _fleet_watcher = _watcher_mod.FleetWatcher(FLEET_YAML, _reload_from_disk)
    _fleet_watcher.start()
