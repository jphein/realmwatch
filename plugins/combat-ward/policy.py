"""Action policy enforcement — hard constraints that cannot be bypassed.

Even with sanitized inputs, AI can recommend wrong actions. This module
enforces hard constraints before any defensive action executes.

Migrated from os.realm.watch/servers/combat_ward/policy.py 2026-05-19.
Only change: imports the local plugin db helper instead of servers.shared.db.
"""
from __future__ import annotations

import ipaddress

from .db import get_connection


_PROTECTED_RANGES = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
]

_DESTRUCTIVE_ACTIONS = {"block_ip", "quarantine_device", "rate_limit", "sentry"}


def check_policy(
    db_path: str,
    action_type: str,
    entity_id: str | None = None,
    action_class: str = "suggest",
    target_ip: str | None = None,
    replay: bool = False,
) -> tuple[bool, str]:
    """Check if an action passes policy. Returns (allowed, reason)."""
    if replay:
        return False, "Replay actions never execute real effects"

    if action_class == "observe":
        return True, "Observe actions always allowed"

    if target_ip and action_type in _DESTRUCTIVE_ACTIONS:
        try:
            network = ipaddress.ip_network(target_ip, strict=False)
            for protected in _PROTECTED_RANGES:
                if network.prefixlen <= protected.prefixlen and network.overlaps(protected):
                    return False, f"Cannot target wide range {target_ip} — overlaps {protected}"
        except ValueError:
            pass  # single IP address, not a range — OK

    if entity_id and action_type in ("quarantine_device", "block_ip"):
        conn = get_connection(db_path)
        entity = conn.execute(
            "SELECT infrastructure_flag, identity_confidence FROM entities WHERE entity_id=?",
            (entity_id,),
        ).fetchone()
        conn.close()
        if entity and entity["infrastructure_flag"]:
            return False, "Cannot quarantine/block infrastructure nodes"

    if entity_id and action_class in ("confirm", "auto"):
        conn = get_connection(db_path)
        entity = conn.execute(
            "SELECT identity_confidence FROM entities WHERE entity_id=?",
            (entity_id,),
        ).fetchone()
        conn.close()
        if entity and entity["identity_confidence"] < 80:
            return False, (
                f"Entity confidence {entity['identity_confidence']}% "
                f"too low for {action_class} actions (minimum 80%)"
            )

    return True, "Policy check passed"
