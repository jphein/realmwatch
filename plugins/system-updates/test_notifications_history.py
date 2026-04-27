"""Tests for v1.2.0 additions: notifications + history.

Locks in:
- notifications._enabled() respects DISPLAY + SYSTEM_UPDATES_NOTIFY env.
- notify() is fire-and-forget — never raises, never blocks.
- history.init() is idempotent (safe to re-run).
- history.record() inserts and prunes (>10 per source/type → trimmed).
- history.get() filters by source_id and run_type, newest-first.
"""
import os
import sys
import time
import tempfile
from unittest.mock import patch

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# realm_db lives at the realmwatch repo root (two parents up from the
# plugin dir). Inject it the same way history.py does at import time
# so the test fixture below can monkeypatch DB_PATH.
_REALMWATCH_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _REALMWATCH_ROOT not in sys.path:
    sys.path.insert(0, _REALMWATCH_ROOT)

import notifications  # noqa: E402


# ── notifications ────────────────────────────────────────────────

def test_enabled_disabled_when_env_zero(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.setenv("SYSTEM_UPDATES_NOTIFY", "0")
    assert notifications._enabled() is False


def test_enabled_disabled_when_no_display(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("SYSTEM_UPDATES_NOTIFY", raising=False)
    assert notifications._enabled() is False


def test_enabled_when_display_and_notify_send_present(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")
    monkeypatch.delenv("SYSTEM_UPDATES_NOTIFY", raising=False)
    with patch("notifications.shutil.which", return_value="/usr/bin/notify-send"):
        assert notifications._enabled() is True


def test_notify_silent_when_disabled(monkeypatch):
    monkeypatch.setenv("SYSTEM_UPDATES_NOTIFY", "0")
    # Should NOT raise even with garbage args.
    notifications.notify("title", "body", urgency="critical")


def test_notify_check_result_skips_zero_count(monkeypatch):
    """No toast for 'nothing to update' — would be spammy on every check."""
    called = []

    def fake_popen(*a, **kw):
        called.append(a)

    monkeypatch.setenv("DISPLAY", ":0")
    with patch("notifications.shutil.which", return_value="/usr/bin/notify-send"), \
         patch("notifications.subprocess.Popen", fake_popen):
        notifications.notify_check_result("Brew Cellar", 0)
    assert called == []


def test_notify_check_result_pluralizes(monkeypatch):
    """Singular vs plural in the body — small UI quality detail."""
    captured = []

    def fake_popen(args, **kw):
        captured.append(args)

    monkeypatch.setenv("DISPLAY", ":0")
    with patch("notifications.shutil.which", return_value="/usr/bin/notify-send"), \
         patch("notifications.subprocess.Popen", fake_popen):
        notifications.notify_check_result("Brew Cellar", 1)
        notifications.notify_check_result("Brew Cellar", 5)
    assert "1 update available" in captured[0][-1]
    assert "5 updates available" in captured[1][-1]


# ── history ──────────────────────────────────────────────────────

@pytest.fixture
def isolated_history(tmp_path, monkeypatch):
    """Point realm_db at a throwaway sqlite file so tests don't pollute
    the real realm.db."""
    import realm_db
    test_db = tmp_path / "test.db"
    monkeypatch.setattr(realm_db, "DB_PATH", str(test_db))
    # Force a new connection that uses the patched path. realm_db caches
    # per-thread; clean up so we get a fresh _local.
    if hasattr(realm_db._local, "conn"):
        realm_db._local.conn.close()
        del realm_db._local.conn
    # Now re-import history module fresh so it picks up the patched DB.
    import history
    history.init()
    yield history
    # Cleanup: close per-thread conn so the next test gets a fresh DB.
    if hasattr(realm_db._local, "conn"):
        realm_db._local.conn.close()
        del realm_db._local.conn


def test_history_init_idempotent(isolated_history):
    """Running init() twice must not error and must not duplicate the table."""
    isolated_history.init()
    isolated_history.init()
    rows = isolated_history.get()
    assert rows == []


def test_history_record_and_get(isolated_history):
    isolated_history.record("apt", "check", 1000.0, 1010.0, ok=True, count=3)
    isolated_history.record("apt", "update", 1020.0, 1100.0, ok=True, count=3)
    isolated_history.record("snap", "check", 1030.0, 1031.0, ok=False, count=0,
                            error="snapd unreachable")
    rows = isolated_history.get()
    # Newest-first ordering.
    assert [r["source_id"] for r in rows] == ["snap", "apt", "apt"]
    # Failure row preserves error and ok=False.
    assert rows[0]["ok"] is False
    assert rows[0]["error"] == "snapd unreachable"


def test_history_filter_by_source(isolated_history):
    isolated_history.record("apt", "check", 1000.0, 1010.0, ok=True, count=3)
    isolated_history.record("snap", "check", 1020.0, 1030.0, ok=True, count=0)
    rows = isolated_history.get(source_id="apt")
    assert len(rows) == 1
    assert rows[0]["source_id"] == "apt"


def test_history_filter_by_run_type(isolated_history):
    isolated_history.record("apt", "check", 1000.0, 1010.0, ok=True, count=3)
    isolated_history.record("apt", "update", 1020.0, 1100.0, ok=True, count=3)
    rows = isolated_history.get(run_type="update")
    assert len(rows) == 1
    assert rows[0]["run_type"] == "update"


def test_history_prunes_beyond_keep_per_pair(isolated_history):
    """Insert more than KEEP_PER_SOURCE_PER_TYPE; oldest should be pruned."""
    cap = isolated_history.KEEP_PER_SOURCE_PER_TYPE
    for i in range(cap + 5):
        isolated_history.record("apt", "check", 1000.0 + i, 1001.0 + i,
                                ok=True, count=i)
    rows = isolated_history.get(source_id="apt", run_type="check", limit=100)
    assert len(rows) == cap
    # Oldest 5 should be gone — surviving counts are i=5..i=cap+4.
    counts = sorted(r["count"] for r in rows)
    assert counts == list(range(5, cap + 5))


def test_history_prune_is_per_source_per_type(isolated_history):
    """Pruning must NOT affect other (source, type) pairs."""
    cap = isolated_history.KEEP_PER_SOURCE_PER_TYPE
    for i in range(cap + 3):
        isolated_history.record("apt", "check", 1000.0 + i, 1001.0 + i,
                                ok=True, count=i)
    # snap/check should keep its 2 rows even though apt/check pruned.
    isolated_history.record("snap", "check", 2000.0, 2001.0, ok=True, count=1)
    isolated_history.record("snap", "check", 2010.0, 2011.0, ok=True, count=2)
    snap_rows = isolated_history.get(source_id="snap")
    assert len(snap_rows) == 2
