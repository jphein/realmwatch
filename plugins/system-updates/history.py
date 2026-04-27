"""Persistent history of check/update runs in realm.db.

Schema lives in this module rather than a migration file because the
plugin is self-contained — there's no separate DB-init step in
realmwatch's plugin model. ``init()`` is called from plugin setup() and
is idempotent (CREATE TABLE IF NOT EXISTS).

Why a single ``runs`` table instead of separate tables for checks and
updates: the columns are identical (source_id, started_at, finished_at,
ok, count, error) and a ``run_type`` discriminator keeps queries simple
("last 10 runs across check and update for source X" is one SELECT).

Retention: ``prune()`` keeps the last ``KEEP_PER_SOURCE_PER_TYPE``
entries per (source_id, run_type) pair. Called opportunistically after
each insert so the table doesn't grow unbounded between manual runs.
The hardcoded value mirrors the spec's "last 10 runs per source".
"""
import sys
import os

# Make realmwatch's realm_db importable. The plugin runs inside the
# realmwatch process so this path is the parent of the plugins dir.
_REALMWATCH_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
if _REALMWATCH_ROOT not in sys.path:
    sys.path.insert(0, _REALMWATCH_ROOT)

import realm_db  # type: ignore  # noqa: E402

KEEP_PER_SOURCE_PER_TYPE = 10

_SCHEMA = """
CREATE TABLE IF NOT EXISTS system_updates_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   TEXT NOT NULL,
    run_type    TEXT NOT NULL,    -- 'check' | 'update'
    started_at  REAL NOT NULL,
    finished_at REAL,
    ok          INTEGER,           -- 0/1, NULL while running
    count       INTEGER,           -- packages found (check) or upgraded (update)
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sur_source_started
    ON system_updates_runs(source_id, run_type, started_at DESC);
"""


def init():
    """Idempotent schema setup. Called from plugin setup()."""
    with realm_db._conn() as conn:
        conn.executescript(_SCHEMA)
        conn.commit()


def record(source_id: str, run_type: str, started_at: float,
           finished_at: float, ok: bool, count: int = 0,
           error: str | None = None) -> int:
    """Insert a completed run, prune old rows, return the row id."""
    with realm_db._conn() as conn:
        cur = conn.execute(
            "INSERT INTO system_updates_runs "
            "(source_id, run_type, started_at, finished_at, ok, count, error) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (source_id, run_type, started_at, finished_at,
             1 if ok else 0, count, error),
        )
        row_id = cur.lastrowid
        # Prune older entries for this (source, type) pair beyond the cap.
        conn.execute(
            "DELETE FROM system_updates_runs "
            "WHERE source_id = ? AND run_type = ? "
            "AND id NOT IN ("
            "  SELECT id FROM system_updates_runs "
            "  WHERE source_id = ? AND run_type = ? "
            "  ORDER BY started_at DESC LIMIT ?"
            ")",
            (source_id, run_type, source_id, run_type, KEEP_PER_SOURCE_PER_TYPE),
        )
        conn.commit()
    return row_id


def get(source_id: str | None = None, run_type: str | None = None,
        limit: int = 50) -> list[dict]:
    """Read recent runs as a list of dicts, newest first.

    Filters: ``source_id`` narrows to one source; ``run_type`` to
    'check' or 'update'. Both default to no filter.
    """
    where = []
    args: list = []
    if source_id:
        where.append("source_id = ?")
        args.append(source_id)
    if run_type:
        where.append("run_type = ?")
        args.append(run_type)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    args.append(limit)
    with realm_db._conn() as conn:
        rows = conn.execute(
            f"SELECT id, source_id, run_type, started_at, finished_at, "
            f"ok, count, error FROM system_updates_runs "
            f"{where_sql} ORDER BY started_at DESC LIMIT ?",
            tuple(args),
        ).fetchall()
    cols = ("id", "source_id", "run_type", "started_at", "finished_at",
            "ok", "count", "error")
    return [
        {**dict(zip(cols, row)), "ok": bool(row[5]) if row[5] is not None else None}
        for row in rows
    ]
