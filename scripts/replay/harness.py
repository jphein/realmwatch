"""Event capture and replay harness.

Captures live events from the game SQLite (``~/.realmwatch/game.db``) to a
JSON file, replays them back with replay_flag=1 so they don't affect real
progression, and injects synthetic events from ``generators.py``.

Migrated from os.realm.watch/servers/replay/harness.py 2026-05-19.

WAVE-3-NOTE
-----------
The upstream version imported ``servers.realm_engine.server.ingest_event``
(the canonical inserter with bestiary hooks and entity resolution). The
realm-engine server hasn't been ported into realmwatch yet — its eventual
home is ``plugins/realm-engine/`` (or it may be subsumed by an existing
plugin). Until then this harness uses a self-contained ``_ingest_event``
shim that talks to the game.db directly: same dedupe semantics, same
schema, but no bestiary side-effects. When realm-engine lands, swap
``_ingest_event`` for the canonical import. The CLI surface should not
need to change.

CLI
---
    python3 scripts/replay/harness.py --capture out.json [--limit N]
    python3 scripts/replay/harness.py --replay  in.json
    python3 scripts/replay/harness.py --generate cpu_spike
    python3 scripts/replay/harness.py --list-generators

All CLI verbs default to the standard game DB at ``~/.realmwatch/game.db``;
override with ``--db PATH``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

# Allow ``python3 scripts/replay/harness.py`` without setting PYTHONPATH —
# the realmwatch repo root is two levels up from this file. realm_text.ulid()
# is the canonical event-id generator post-Wave-1.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from realm_text import sanitize_hostname, ulid  # noqa: E402

# Same as the upstream servers/shared/db.py constant.
DEFAULT_DB_PATH = os.path.expanduser("~/.realmwatch/game.db")


# Allow ``from scripts.replay.harness import generate_cpu_spike`` etc., and
# also let ``--generate <name>`` find generators by string key.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from generators import GENERATORS  # noqa: E402


def _get_connection(db_path: str) -> sqlite3.Connection:
    """Open a row-factory connection. Mirrors servers/shared/db.get_connection."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _ingest_event(
    db_path: str,
    event_type: str,
    source_system: str,
    severity: int = 1,
    confidence: int = 50,
    payload: dict | None = None,
    entity_id: str | None = None,
    correlation_id: str | None = None,
    replay: bool = True,
) -> dict:
    """Minimal in-process event ingester.

    Tracks the upstream realm_engine.ingest_event contract closely enough
    for replay/capture workflows: dedupe by payload hash, sanitize host-ish
    fields, insert with replay_flag. Skips bestiary updates (a downstream
    concern). When realm-engine lands in realmwatch, replace calls with
    that canonical inserter.
    """
    payload = payload or {}
    now_ms = int(time.time() * 1000)

    # Match upstream: sanitize known-hostname-shaped fields before storage.
    for key in ("host", "hostname", "ssid", "banner"):
        if key in payload and isinstance(payload[key], str):
            payload[key] = sanitize_hostname(payload[key])

    raw_json = json.dumps(payload, sort_keys=True)
    dedupe_key = hashlib.sha256(
        f"{event_type}:{source_system}:{raw_json}".encode()
    ).hexdigest()[:32]

    conn = _get_connection(db_path)
    try:
        existing = conn.execute(
            "SELECT event_id FROM events WHERE dedupe_key=?", (dedupe_key,)
        ).fetchone()
        if existing:
            return {"event_id": existing["event_id"], "deduplicated": True}

        eid = ulid()
        conn.execute(
            """INSERT INTO events
               (event_id, event_type, source_system, entity_id, correlation_id,
                dedupe_key, severity, confidence, timestamp_observed,
                timestamp_ingested, replay_flag, raw_payload_json,
                normalized_payload_json, schema_version)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
            (eid, event_type, source_system, entity_id, correlation_id,
             dedupe_key, severity, confidence, now_ms, now_ms,
             1 if replay else 0, raw_json, raw_json),
        )
        conn.commit()
        return {"event_id": eid, "deduplicated": False}
    finally:
        conn.close()


def capture_events(db_path: str, output_file: str, limit: int = 1000) -> int:
    """Capture recent events from the DB to a JSON file."""
    conn = _get_connection(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY timestamp_observed DESC LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        conn.close()

    events = []
    for row in rows:
        events.append({
            "event_type": row["event_type"],
            "source_system": row["source_system"],
            "severity": row["severity"],
            "confidence": row["confidence"],
            "payload": json.loads(row["raw_payload_json"]) if row["raw_payload_json"] else {},
            "entity_id": row["entity_id"],
            "correlation_id": row["correlation_id"],
        })

    with open(output_file, "w") as f:
        json.dump(events, f, indent=2)

    return len(events)


def replay_events(db_path: str, input_file: str) -> int:
    """Replay events from a JSON file into the event bus with replay_flag=1."""
    with open(input_file) as f:
        events = json.load(f)

    count = 0
    for event in events:
        result = _ingest_event(
            db_path=db_path,
            event_type=event["event_type"],
            source_system=event.get("source_system", "replay"),
            severity=event.get("severity", 1),
            confidence=event.get("confidence", 50),
            payload=event.get("payload", {}),
            entity_id=event.get("entity_id"),
            correlation_id=event.get("correlation_id"),
            replay=True,
        )
        if not result.get("deduplicated"):
            count += 1

    return count


def inject_synthetic(db_path: str, event_dict: dict) -> dict:
    """Inject a single synthetic event into the event bus."""
    return _ingest_event(
        db_path=db_path,
        event_type=event_dict["event_type"],
        source_system=event_dict.get("source_system", "synthetic"),
        severity=event_dict.get("severity", 2),
        confidence=event_dict.get("confidence", 70),
        payload=event_dict.get("payload", {}),
        replay=True,
    )


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="harness",
        description="Capture/replay/inject synthetic events into the game DB.",
    )
    p.add_argument("--db", default=DEFAULT_DB_PATH,
                   help="Path to game.db (default: %(default)s)")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--capture", metavar="OUT.json",
                   help="Capture recent events to a JSON file.")
    g.add_argument("--replay", metavar="IN.json",
                   help="Replay events from a JSON file (replay_flag=1).")
    g.add_argument("--generate", metavar="NAME",
                   help="Inject one synthetic event by generator name "
                        "(see --list-generators).")
    g.add_argument("--list-generators", action="store_true",
                   help="Print available synthetic generator names and exit.")
    p.add_argument("--limit", type=int, default=1000,
                   help="--capture row cap (default: 1000)")
    p.add_argument("--dry-run", action="store_true",
                   help="With --generate: print the event dict without "
                        "writing to the DB.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.list_generators:
        for name in sorted(GENERATORS):
            print(name)
        return 0

    if args.capture:
        n = capture_events(args.db, args.capture, limit=args.limit)
        print(f"captured {n} events -> {args.capture}")
        return 0

    if args.replay:
        n = replay_events(args.db, args.replay)
        print(f"replayed {n} new events (deduped existing) from {args.replay}")
        return 0

    if args.generate:
        if args.generate not in GENERATORS:
            print(f"unknown generator: {args.generate!r}. "
                  f"Try --list-generators.", file=sys.stderr)
            return 2
        event = GENERATORS[args.generate]()
        if args.dry_run:
            print(json.dumps(event, indent=2))
            return 0
        result = inject_synthetic(args.db, event)
        print(json.dumps(result))
        return 0

    return 1  # unreachable due to required mutually-exclusive group


if __name__ == "__main__":
    raise SystemExit(main())
