"""Event throttling — severity threshold, cooldowns, dedup.

Prevents quest spam from noisy network events. A quiet, stable
network should feel peaceful, not broken.

Migrated from os.realm.watch/servers/quest_forge/throttle.py.
"""
from __future__ import annotations

import time

# In-memory cooldown tracker (resets on server restart — acceptable for v1)
_cooldowns: dict[str, float] = {}


def should_throttle(
    db_path: str,
    event_type: str,
    node_id: str,
    cooldown_seconds: int = 900,  # 15 minutes
) -> bool:
    """Check if this event type + node combo should be throttled."""
    key = f"{event_type}:{node_id}"
    now = time.time()
    last_seen = _cooldowns.get(key, 0)
    return (now - last_seen) < cooldown_seconds


def record_event_seen(db_path: str, event_type: str, node_id: str):
    """Record that we've seen this event type + node combo."""
    key = f"{event_type}:{node_id}"
    _cooldowns[key] = time.time()


def clear_cooldowns():
    """Clear all cooldowns (for testing)."""
    _cooldowns.clear()
