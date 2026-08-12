"""Regression tests for quest auto-generation (#123).

Auto-generation had never once worked for a novel event. Three defects, all
locked in here:

- `quests.source_event_id` and `quest_event_links.event_id` are FKs into
  game.db's ULID-keyed `events` table, but realmwatch events live in realm.db
  under an INTEGER AUTOINCREMENT id which the caller stringifies to
  "realm:<int>". With PRAGMA foreign_keys=ON every INSERT for a novel event
  raised "FOREIGN KEY constraint failed". Inverted outcome worth its own test:
  events that hit realm_db.push_event's 5-minute dedup return with no `id` at
  all, so the FK stayed NULL and the insert succeeded — novel events failed and
  repeats worked.

- The template lookup and the cooldown bucket both keyed off the *transport*
  type (speech / alert / realm-event), never a key in `_TEMPLATES`, so all 17
  semantic templates were unreachable and every quest came out titled "Realm
  Disturbance". The semantic type sits unread in the payload as
  `optimizer_event_type`.

- `record_event_seen` ran only on success, so a failing insert never armed the
  15-minute window and every qualifying event retried and re-logged forever.

Everything here runs against a throwaway sqlite file built from the plugin's
own bootstrap SQL — no live game.db, no network, no realm server.
"""

import os
import sqlite3
import sys

import pytest

# Make the plugin package importable regardless of pytest cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGINS = os.path.dirname(_HERE)
for _p in (_PLUGINS, os.path.dirname(_PLUGINS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from quests import db as quest_db          # noqa: E402
from quests import server as quest_server  # noqa: E402
from quests.throttle import clear_cooldowns  # noqa: E402

# realm-engine's dir name isn't a valid identifier, so load it by path.
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "_engine_db", os.path.join(_PLUGINS, "realm-engine", "db.py"))
engine_db = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(engine_db)

ULID_EVENT = "01KMS0MNHFT1D7W3A1X6A3G0C3"


@pytest.fixture
def db(tmp_path):
    """A game.db built by realm-engine's bootstrap — the real production schema.

    This matters. realm-engine owns `events` and declares the two FKs that made
    this bug possible; quests/db.py declares neither. A fixture built from
    quests/db.py alone would be strictly more permissive than production and the
    regression would be unobservable. So use the authoritative bootstrap rather
    than a hand-copied approximation of it.
    """
    path = str(tmp_path / "game.db")
    engine_db.create_database(path)
    quest_db.create_database(path)  # idempotent; mirrors real load order
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO events (event_id, event_type, source_system, dedupe_key,"
        " severity, confidence, timestamp_observed, timestamp_ingested,"
        " raw_payload_json, normalized_payload_json)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (ULID_EVENT, "disk_space_low", "realmwatch", "dk-1", 3, 90, 1, 1, "{}", "{}"))
    conn.commit()
    conn.close()
    clear_cooldowns()
    return path


@pytest.fixture
def db_no_events(tmp_path):
    """A game.db from quests/db.py alone — no `events` table at all.

    This is the fresh-install case where the quests plugin loads before
    realm-engine. The write path must still work.
    """
    path = str(tmp_path / "game-fresh.db")
    quest_db.create_database(path)
    clear_cooldowns()
    return path


def _event(**over):
    """A realmwatch bus event, shaped exactly as realm-optimizer emits one."""
    ev = {
        "type": "speech",                     # transport envelope
        "optimizer_event_type": "disk_space_low",  # the semantic type
        "node": "katana",
        "text": "disk filling",
        "severity": 3,
        "source": "realm-optimizer",
        "percent_used": 86.4,
    }
    ev.update(over)
    return ev


def _quests(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM quests")]
    conn.close()
    return rows


# ── Defect 1: the FK that could never be satisfied ───────────────────────

def test_novel_event_with_realm_db_id_is_generated(db):
    """The core regression: an event carrying a realm.db int id must mint a quest.

    Before the fix this raised sqlite3.IntegrityError and no row landed.
    """
    result = quest_server.generate_quest_from_event_dict(_event(id=194308), db_path=db)
    assert result is not None, "novel event produced no quest"
    rows = [q for q in _quests(db) if q["parent_quest_id"] is None]
    assert len(rows) == 1
    # The unresolvable reference is stored as NULL, not as "realm:194308".
    assert rows[0]["source_event_id"] is None
    # ...but the raw id is still used for dedupe, which is a local string.
    assert rows[0]["dedupe_key"] == "quest:realm:194308"


def test_unresolvable_id_writes_no_link_row(db):
    """quest_event_links carries the same FK — it must be gated identically."""
    quest_server.generate_quest_from_event_dict(_event(id=194308), db_path=db)
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM quest_event_links").fetchone()[0] == 0
    conn.close()


def test_resolvable_ulid_is_kept_and_linked(db):
    """An event that really does live in game.db keeps its reference."""
    result = quest_server.generate_quest_from_event_dict(
        _event(event_id=ULID_EVENT), db_path=db)
    assert result is not None
    rows = [q for q in _quests(db) if q["parent_quest_id"] is None]
    assert rows[0]["source_event_id"] == ULID_EVENT
    conn = sqlite3.connect(db)
    link = conn.execute(
        "SELECT event_id, role FROM quest_event_links").fetchone()
    conn.close()
    assert link == (ULID_EVENT, "trigger")


def test_foreign_keys_stay_clean(db):
    """Whatever we write, the database must remain referentially intact."""
    quest_server.generate_quest_from_event_dict(_event(id=194308), db_path=db)
    clear_cooldowns()
    quest_server.generate_quest_from_event_dict(
        _event(event_id=ULID_EVENT, optimizer_event_type="cache_bloat"), db_path=db)
    conn = quest_db.get_connection(db)
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_dedupe_key_is_stable_across_retries(db):
    """Same event twice must not become two incidents.

    The old fallback key embedded time.time() in milliseconds, so every retry of
    one event looked novel. Keying on the event id collapses them.
    """
    quest_server.generate_quest_from_event_dict(_event(id=194308), db_path=db)
    clear_cooldowns()
    quest_server.generate_quest_from_event_dict(_event(id=194308), db_path=db)
    parents = [q for q in _quests(db) if q["parent_quest_id"] is None]
    assert len(parents) == 1


def test_works_when_events_table_is_absent(db_no_events):
    """Fresh install, quests loaded before realm-engine: still mints a quest."""
    result = quest_server.generate_quest_from_event_dict(
        _event(id=194308), db_path=db_no_events)
    assert result is not None
    rows = [q for q in _quests(db_no_events) if q["parent_quest_id"] is None]
    assert rows[0]["source_event_id"] is None


# ── Defect 2: the discriminator keyed off the transport type ──────────────

def test_semantic_type_wins_over_transport_type():
    assert quest_server.quest_discriminator(_event()) == "disk_space_low"


def test_transport_type_is_the_last_resort():
    ev = _event()
    del ev["optimizer_event_type"]
    assert quest_server.quest_discriminator(ev) == "speech"


@pytest.mark.parametrize("key", ["subtype", "kind", "event_subtype", "anomaly_type"])
def test_alternate_semantic_keys(key):
    ev = {"type": "alert", key: "cpu_spike"}
    assert quest_server.quest_discriminator(ev) == "cpu_spike"


def test_blank_semantic_value_does_not_shadow_transport():
    assert quest_server.quest_discriminator(
        {"type": "alert", "optimizer_event_type": "   "}) == "alert"


def test_semantic_template_is_actually_used(db):
    """The payoff: a real template title instead of "Realm Disturbance"."""
    result = quest_server.generate_quest_from_event_dict(
        _event(id=1, optimizer_event_type="disk_space_low"), db_path=db)
    expected = quest_server._TEMPLATES["disk_space_low"]["title"]
    assert result["title"] == expected
    assert result["title"] != quest_server._DEFAULT_TEMPLATE["title"]


def test_distinct_semantic_types_do_not_mask_each_other(db):
    """Two different problems on one host are two quests, not one.

    Keying the cooldown on the transport type meant the second was swallowed.
    """
    a = quest_server.generate_quest_from_event_dict(
        _event(id=1, optimizer_event_type="disk_space_low"), db_path=db)
    b = quest_server.generate_quest_from_event_dict(
        _event(id=2, optimizer_event_type="cache_bloat"), db_path=db)
    assert a is not None and b is not None
    assert a["title"] != b["title"]


def test_same_semantic_type_is_still_throttled(db):
    """The cooldown must still bite within its window."""
    assert quest_server.generate_quest_from_event_dict(
        _event(id=1), db_path=db) is not None
    assert quest_server.generate_quest_from_event_dict(
        _event(id=2), db_path=db) is None


# ── Template coverage for the types actually emitted ─────────────────────
#
# The discriminator fix alone changed nothing visible: of the 7 semantic types
# realm-optimizer emits, the only two that had templates (cache_bloat,
# journal_bloat) are severity 2 and fall below the floor, so every quest still
# came out a generic "Realm Disturbance". These lock in the five that survive
# the floor, and — more importantly — that their placeholders resolve against
# real payload keys. _SafeDict renders a missing key as "?", so a typo'd field
# name is silently cosmetic damage that no other assertion would catch.

_LIVE_PAYLOADS = {
    "tmp_bloat": {"size_mb": 7348.4, "path": "/tmp"},
    "swap_pressure": {"percent_used": 75.7, "used_mb": 6198.1, "total_mb": 8192.0},
    "high_load": {"load_5min": 16.86, "cpu_count": 8, "threshold": 16.0},
    "zombie_processes": {"zombie_count": 6},
    "dns_failure": {"hostname": "dns.google"},
}


@pytest.mark.parametrize("semantic,fields", sorted(_LIVE_PAYLOADS.items()))
def test_live_semantic_types_have_templates(semantic, fields):
    assert semantic in quest_server._TEMPLATES, (
        f"{semantic} is emitted above the severity floor but has no template, "
        "so it would fall back to the generic default")


@pytest.mark.parametrize("semantic,fields", sorted(_LIVE_PAYLOADS.items()))
def test_template_placeholders_resolve_against_real_payloads(db, semantic, fields):
    result = quest_server.generate_quest_from_event_dict(
        _event(id=1, optimizer_event_type=semantic, **fields), db_path=db)
    assert result is not None
    assert result["title"] != quest_server._DEFAULT_TEMPLATE["title"]
    for field in ("technical_label", "description"):
        assert "?" not in result[field], (
            f"{semantic}.{field} left an unresolved placeholder: {result[field]!r}")


# ── Defect 3: the cooldown only armed on success ──────────────────────────

def test_failure_arms_the_cooldown(db, monkeypatch):
    """A failing insert must trip the breaker instead of retrying forever."""
    def boom(*a, **k):
        raise sqlite3.IntegrityError("FOREIGN KEY constraint failed")
    monkeypatch.setattr(quest_server, "_insert_quest", boom)

    with pytest.raises(sqlite3.IntegrityError):
        quest_server.generate_quest_from_event_dict(_event(id=1), db_path=db)

    # Second call is now throttled — it returns None rather than raising again,
    # which is what turns 100 log lines into 1.
    monkeypatch.undo()
    assert quest_server.generate_quest_from_event_dict(
        _event(id=2), db_path=db) is None


# ── Volume policy ────────────────────────────────────────────────────────

def test_severity_floor_rejects_routine_noise(db):
    """severity 2 is housekeeping chatter — the two loudest streams live there."""
    assert quest_server.AUTO_QUEST_MIN_SEVERITY == 3
    assert quest_server.generate_quest_from_event_dict(
        _event(id=1, severity=2), db_path=db) is None
    assert quest_server.generate_quest_from_event_dict(
        _event(id=2, severity=3), db_path=db) is not None


def test_explicit_threshold_still_overrides(db):
    """The manual generate path must be able to opt below the floor."""
    assert quest_server.generate_quest_from_event_dict(
        _event(id=1, severity=2), db_path=db, severity_threshold=2) is not None


def test_daily_cap_is_a_hard_backstop(db, monkeypatch):
    """Cap counts parents from the DB, so it survives a cooldown reset."""
    monkeypatch.setattr(quest_server, "AUTO_QUEST_DAILY_CAP", 2)
    made = 0
    for i in range(6):
        clear_cooldowns()  # simulate restarts wiping the in-process cooldowns
        if quest_server.generate_quest_from_event_dict(
                _event(id=i, optimizer_event_type=f"t{i}"), db_path=db):
            made += 1
    assert made == 2, f"cap leaked: {made} quests minted with cap=2"


def test_cap_counts_parents_not_sub_quests(db, monkeypatch):
    """A parent mints 3 sub-quests; those must not consume the budget."""
    monkeypatch.setattr(quest_server, "AUTO_QUEST_DAILY_CAP", 1)
    quest_server.generate_quest_from_event_dict(_event(id=1), db_path=db)
    rows = _quests(db)
    assert len(rows) > 1, "expected sub-quests alongside the parent"
    conn = quest_db.get_connection(db)
    assert quest_server._auto_quests_last_24h(conn) == 1
    conn.close()
