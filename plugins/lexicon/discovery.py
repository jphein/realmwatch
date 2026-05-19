"""Discovery callback — on first sight of a new MAC, write a tentative fleet entry."""

from __future__ import annotations

from datetime import date

from lexicon import FleetEntry


def on_discovery_observation(catalog, mac, hostname=None,
                              vendor_oui=None, evidence=None,
                              save_fn=None):
    """Returns True if a new tentative entry was created."""
    if not mac:
        return False
    mac = mac.lower()
    fleet_id = f"mac:{mac}"
    if fleet_id in catalog._by_id:
        catalog._by_id[fleet_id].last_seen = str(date.today())
        if save_fn:
            save_fn()
        return False

    suffix4 = mac.replace(':', '')[-4:]
    if hostname:
        suggested = hostname
    elif vendor_oui:
        suggested = f"{vendor_oui}-{suffix4}"
    else:
        suggested = f"unknown-{suffix4}"

    entry = FleetEntry(
        fleet_id=fleet_id,
        current_name=suggested,
        realm="signal",
        kind="unknown",
        role=None,
        status="tentative",
        first_seen=str(date.today()),
        last_seen=str(date.today()),
        discovery_evidence=evidence or {},
    )
    # name collisions: append the MAC suffix
    if suggested in catalog._by_name:
        entry.current_name = f"{suggested}-{suffix4}"
    catalog.entries.append(entry)
    catalog._reindex()
    if save_fn:
        save_fn()
    return True
