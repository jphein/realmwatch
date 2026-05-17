"""Trigger dependencies — suppress child alerts when an upstream node is down.

Walks the topology connection graph from the node that produced an event
toward infrastructure-class neighbors (routers, switches, cores). If any
such neighbor is currently in a problem state (unresolved critical event
in the last `lookback_seconds`), the event is suppressed and logged with
status='suppressed_by_parent'.

Connection direction is NOT reliable in the realm topology — `from_node` /
`to_node` is determined by whichever side was added first, not by upstream/
downstream semantics. So we walk neighbors in both directions and rely on
node type/role to identify legitimate ancestors. Only nodes whose type is
in `UPSTREAM_TYPES` participate in the walk.

Zabbix-inspired (issue #5).
"""

import json
import logging
import time

log = logging.getLogger(__name__)

# Node types that are valid "upstream" candidates. A core/router/switch going
# down legitimately blocks alerts from everything behind it; a device or
# workstation going down does not.
UPSTREAM_TYPES = {"core", "infra", "router", "switch", "tower", "bridge"}

# Module-level state: tracks every suppression decision so /alerting/dependencies
# can render an audit trail. Bounded to last N decisions to keep memory tame.
_decisions: list = []
_decisions_max = 200


def _record_decision(node_id: str, blocking_ancestor: str | None, event_type: str, severity: str):
    """Append a suppression decision to the in-memory audit ring."""
    _decisions.append({
        "ts": time.time(),
        "node": node_id,
        "event_type": event_type,
        "severity": severity,
        "blocking_ancestor": blocking_ancestor,  # None = not suppressed
        "suppressed": blocking_ancestor is not None,
    })
    if len(_decisions) > _decisions_max:
        del _decisions[: len(_decisions) - _decisions_max]


def get_recent_decisions(limit: int = 50, window_s: int = 3600) -> list:
    """Return recent suppression decisions, newest first."""
    cutoff = time.time() - window_s
    return [d for d in reversed(_decisions) if d["ts"] >= cutoff][:limit]


def _load_node_types(db) -> dict[str, str]:
    """Map every node_id to its `type` field, lowercased. Empty string if absent."""
    types: dict[str, str] = {}
    for r in db.query("SELECT node_id, data FROM nodes"):
        try:
            d = json.loads(r.get("data") or "{}")
            types[r["node_id"]] = (d.get("type") or "").lower()
        except (TypeError, json.JSONDecodeError):
            types[r["node_id"]] = ""
    return types


def walk_upstream(db, node_id: str, max_depth: int = 5) -> list[str]:
    """BFS through topology toward infrastructure neighbors.

    Direction-agnostic: connections aren't reliably directional, so neighbors
    are collected from either side (from_node==X or to_node==X). Traversal
    continues only through infrastructure-type nodes (UPSTREAM_TYPES) — a
    workstation neighbor is reported but not followed.

    Returns ancestors in BFS order (closest first).
    """
    if not node_id:
        return []

    node_types = _load_node_types(db)
    seen = {node_id}
    out: list[str] = []
    current = [node_id]

    for _ in range(max_depth):
        next_layer: list[str] = []
        for n in current:
            rows = db.query(
                """SELECT from_node AS n FROM connections WHERE to_node = ?
                   UNION
                   SELECT to_node   AS n FROM connections WHERE from_node = ?""",
                (n, n),
            )
            for r in rows:
                neighbor = r.get("n")
                if not neighbor or neighbor in seen:
                    continue
                seen.add(neighbor)
                ntype = node_types.get(neighbor, "")
                # Only follow + report infrastructure-class neighbors
                if ntype in UPSTREAM_TYPES:
                    out.append(neighbor)
                    next_layer.append(neighbor)
        if not next_layer:
            break
        current = next_layer
    return out


def has_recent_problem(db, node_id: str, lookback_seconds: int = 120) -> bool:
    """Is `node_id` currently in a problem state?

    Problem state = a critical/failed event from this node within the lookback
    window. We check the universal `events` table (every plugin posts there)
    rather than alerting history specifically — this catches problems flagged
    by any plugin (latency, discovery, firewall, etc.).
    """
    if not node_id:
        return False
    cutoff = time.time() - lookback_seconds

    # Match the same heuristics rule_engine.detect_severity uses for "critical"
    rows = db.query(
        """SELECT data FROM events
           WHERE ts >= ?
             AND json_extract(data, '$.node') = ?
             AND (
               json_extract(data, '$.color') = '#ff4040'
               OR json_extract(data, '$.status') = 'failed'
               OR json_extract(data, '$.status') = 'down'
               OR json_extract(data, '$.subtype') = 'down'
               OR json_extract(data, '$.severity') = 'critical'
             )
           LIMIT 1""",
        (cutoff, node_id),
    )
    return len(rows) > 0


def find_blocking_ancestor(
    db,
    node_id: str,
    lookback_seconds: int = 120,
    max_depth: int = 5,
) -> str | None:
    """Walk upstream; return the first ancestor in problem state, or None."""
    for ancestor in walk_upstream(db, node_id, max_depth):
        if has_recent_problem(db, ancestor, lookback_seconds):
            return ancestor
    return None


def explain(db, node_id: str, lookback_seconds: int = 120, max_depth: int = 5) -> dict:
    """Return a human-readable explanation of the alerting decision for `node_id`.

    Used by `realm alerting why <node>`. Walks the full upstream chain and
    reports the status of each ancestor so the operator sees the entire path.
    """
    chain = walk_upstream(db, node_id, max_depth)
    chain_status = []
    blocking = None
    for ancestor in chain:
        in_problem = has_recent_problem(db, ancestor, lookback_seconds)
        if in_problem and blocking is None:
            blocking = ancestor
        chain_status.append({"node": ancestor, "in_problem": in_problem})

    return {
        "node": node_id,
        "self_in_problem": has_recent_problem(db, node_id, lookback_seconds),
        "upstream_chain": chain_status,
        "blocking_ancestor": blocking,
        "would_suppress": blocking is not None,
        "lookback_seconds": lookback_seconds,
    }
