# Lexicon Fleet Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `plugins/lexicon/` plugin for realmwatch that makes a gitignored `fleet.yaml` the authoritative store of per-node identity (current_name, prior_names, kind, role, realm), with two rename verbs (pure rename, hardware-swap replace) and a one-shot migration from `realm.db`.

**Architecture:** Two repos. (a) `~/Projects/lexicon.realm.watch/python/` gains a `FleetCatalog` class parallel to the existing project `Catalog`, sharing low-level YAML utilities. (b) `~/Projects/realmwatch/plugins/lexicon/` loads `fleet.yaml`, exposes a resolver as a plugin API via `expose_plugin_api()`, registers `/fleet/*` endpoints, and watches the file with an mtime poll for hot reload. `realm.db` keeps live state and gets a `fleet_id` foreign-key field in each node's `data` JSON blob.

**Tech Stack:** Python 3.12, `ruamel.yaml` (already a lexicon dep) for round-trip YAML, sqlite3, stdlib threading for mtime poll. Esbuild not required (plugin panels load directly).

**Spec:** `docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md`

**Testing model:** Lexicon library changes get full pytest TDD (lexicon already has pytest configured). Realmwatch plugin gets smoke-validation via `scripts/test-fleet.py` per realmwatch's no-test-framework convention (CLAUDE.md), and manual map-rendering check.

---

## File Structure

### Created in `~/Projects/lexicon.realm.watch/`
- `python/lexicon/fleet.py` — `FleetCatalog`, `FleetEntry`, `FleetPriorName`, and `load_fleet_catalog()` entrypoint
- `python/tests/test_fleet.py` — pytest tests for fleet catalog
- `python/tests/fixtures/fleet-sample.yaml` — small hand-written fixture for tests

### Modified in `~/Projects/lexicon.realm.watch/`
- `python/lexicon/__init__.py` — re-export fleet symbols + `load_catalog_by_kind` dispatcher

### Created in `~/Projects/realmwatch/`
- `plugins/lexicon/plugin.json` — manifest
- `plugins/lexicon/plugin.py` — `setup(ctx)` entry point
- `plugins/lexicon/endpoints.py` — request handlers for `/fleet/*`
- `plugins/lexicon/discovery.py` — discovery-engine callback (tentative-entry writer)
- `plugins/lexicon/watcher.py` — fleet.yaml mtime poll loop (stdlib only)
- `plugins/lexicon/panel.html`, `panel.js`, `panel.css` — fleet inspector UI
- `scripts/migrate-fleet.py` — one-shot, idempotent migration from realm.db → fleet.yaml + rekey personas.json/realm-local.json
- `scripts/test-fleet.py` — smoke-test runner (curl-driven)
- `fleet.example.yaml` — public reference for the schema (fleet.yaml itself is gitignored)

### Modified in `~/Projects/realmwatch/`
- `.gitignore` — add `fleet.yaml`
- `map_server.py` — wire resolver into `/node`, `/personas`, `/ssh` etc.; topology join in `/topology` GET and SSE `topology` event
- `plugin_registry.py` — add a `get_plugin_api(name)` getter symmetric to `expose_plugin_api`
- `discovery_engine.py` — emit a `discovery.observation` event when a new MAC is seen

---

## Phase 1 — Lexicon library: FleetCatalog class

Work happens in `~/Projects/lexicon.realm.watch/`. Activate the lexicon venv before running tests:

```bash
cd ~/Projects/lexicon.realm.watch/python
source .venv/bin/activate
```

### Task 1.1: Add fleet fixture file

**Files:**
- Create: `python/tests/fixtures/fleet-sample.yaml`

- [ ] **Step 1: Write the fixture**

```yaml
# python/tests/fixtures/fleet-sample.yaml
version: 1
nodes:
  - fleet_id: "mac:78:48:59:a8:25:97"
    current_name: hp-switch
    prior_names: []
    realm: signal
    kind: switch
    role: managed_switch_24port
    vendor: "HP V1910-24G"
    status: curated
    first_seen: 2024-08-12
    last_seen: 2026-05-18

  - fleet_id: "mac:b4:fb:e4:12:34:56"
    current_name: east-tree-trunk
    prior_names: []
    realm: forest
    kind: switch
    role: managed_switch_8port
    vendor: "TRENDnet GS308T"
    status: curated
    first_seen: 2026-05-18
    last_seen: 2026-05-18

  - fleet_id: "mac:de:ad:be:ef:00:01"
    current_name: gst308t-office
    prior_names: []
    status: retired
    replaced_by: "mac:b4:fb:e4:12:34:56"
    retired_on: 2026-05-18
    retire_reason: "swapped for new TRENDnet on VLAN 37"

  - fleet_id: "mac:aa:bb:cc:dd:ee:01"
    current_name: glasswing-printer
    prior_names:
      - { name: hp-laserjet-m234, retired_on: 2025-12-01, reason: "fantasy-renamed" }
    realm: forest
    kind: printer
    role: laser_printer
    status: curated

  - fleet_id: "fleet:11111111-2222-3333-4444-555555555555"
    current_name: ha-energy-bridge
    prior_names: []
    realm: signal
    kind: ha_entity
    role: energy_bridge
    status: curated
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/lexicon.realm.watch
git add python/tests/fixtures/fleet-sample.yaml
git commit -m "test: add fleet catalog fixture"
```

### Task 1.2: Failing test for load_fleet_catalog

**Files:**
- Create: `python/tests/test_fleet.py`

- [ ] **Step 1: Write the failing test**

```python
# python/tests/test_fleet.py
"""FleetCatalog tests — load, resolve, mutate, round-trip."""

from __future__ import annotations

from pathlib import Path

import pytest

from lexicon import FleetCatalog, load_fleet_catalog


FIXTURE = Path(__file__).parent / "fixtures" / "fleet-sample.yaml"


@pytest.fixture()
def fleet() -> FleetCatalog:
    return load_fleet_catalog(FIXTURE)


def test_load_fleet_reads_fixture(fleet: FleetCatalog) -> None:
    ids = [e.fleet_id for e in fleet.entries]
    assert "mac:78:48:59:a8:25:97" in ids
    assert "fleet:11111111-2222-3333-4444-555555555555" in ids
    assert len(fleet.entries) == 5


def test_resolve_by_fleet_id(fleet: FleetCatalog) -> None:
    e = fleet.resolve("mac:78:48:59:a8:25:97")
    assert e is not None
    assert e.current_name == "hp-switch"


def test_resolve_by_current_name(fleet: FleetCatalog) -> None:
    e = fleet.resolve("east-tree-trunk")
    assert e is not None
    assert e.fleet_id == "mac:b4:fb:e4:12:34:56"


def test_resolve_by_prior_name(fleet: FleetCatalog) -> None:
    e = fleet.resolve("hp-laserjet-m234")
    assert e is not None
    assert e.current_name == "glasswing-printer"


def test_resolve_walks_replaced_by_chain(fleet: FleetCatalog) -> None:
    # gst308t-office is retired, replaced_by → east-tree-trunk
    e = fleet.resolve("gst308t-office")
    assert e is not None
    assert e.current_name == "east-tree-trunk"
    assert e.status == "curated"


def test_resolve_returns_none_on_miss(fleet: FleetCatalog) -> None:
    assert fleet.resolve("does-not-exist") is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/lexicon.realm.watch/python && source .venv/bin/activate
pytest tests/test_fleet.py -v
```

Expected: FAIL with `ImportError: cannot import name 'FleetCatalog' from 'lexicon'`

- [ ] **Step 3: Commit**

```bash
git add python/tests/test_fleet.py
git commit -m "test: failing tests for FleetCatalog load + resolve"
```

### Task 1.3: Minimal FleetCatalog to pass load + resolve

**Files:**
- Create: `python/lexicon/fleet.py`
- Modify: `python/lexicon/__init__.py`

- [ ] **Step 1: Write minimal FleetCatalog**

```python
# python/lexicon/fleet.py
"""Fleet catalog — stable per-node identity for realmwatch.

Parallels Catalog (projects) but with retired/replaced_by lifecycle.
Schema spec: realmwatch/docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq


FLEET_ID_RE = re.compile(r"^(mac:[0-9a-f]{2}(:[0-9a-f]{2}){5}|fleet:[0-9a-f-]{36})$")
LIVE_STATUSES = ("tentative", "curated")
VALID_STATUSES = ("tentative", "curated", "retired")
MAX_RESOLVE_HOPS = 10


@dataclass
class FleetPriorName:
    name: str
    retired_on: str | None = None
    reason: str | None = None


@dataclass
class FleetEntry:
    fleet_id: str
    current_name: str
    prior_names: list[FleetPriorName] = field(default_factory=list)
    realm: str | None = None
    kind: str | None = None
    role: str | None = None
    vendor: str | None = None
    status: str = "curated"
    notes: str | None = None
    first_seen: str | None = None
    last_seen: str | None = None
    replaced_by: str | None = None
    retired_on: str | None = None
    retire_reason: str | None = None
    discovery_evidence: dict | None = None

    @classmethod
    def from_raw(cls, raw: dict) -> "FleetEntry":
        priors = [
            FleetPriorName(
                name=p["name"],
                retired_on=p.get("retired_on"),
                reason=p.get("reason"),
            )
            for p in raw.get("prior_names", []) or []
        ]
        return cls(
            fleet_id=raw["fleet_id"],
            current_name=raw["current_name"],
            prior_names=priors,
            realm=raw.get("realm"),
            kind=raw.get("kind"),
            role=raw.get("role"),
            vendor=raw.get("vendor"),
            status=raw.get("status", "curated"),
            notes=raw.get("notes"),
            first_seen=raw.get("first_seen"),
            last_seen=raw.get("last_seen"),
            replaced_by=raw.get("replaced_by"),
            retired_on=raw.get("retired_on"),
            retire_reason=raw.get("retire_reason"),
            discovery_evidence=raw.get("discovery_evidence"),
        )


class FleetCatalog:
    def __init__(self, entries: list[FleetEntry], source_path: Path | None = None, raw_root: Any = None):
        self.entries: list[FleetEntry] = entries
        self.source_path: Path | None = source_path
        self._raw_root = raw_root
        self._by_id: dict[str, FleetEntry] = {}
        self._by_name: dict[str, str] = {}  # name -> fleet_id
        self._reindex()

    def _reindex(self) -> None:
        self._by_id.clear()
        self._by_name.clear()
        for e in self.entries:
            self._by_id[e.fleet_id] = e
        for e in self.entries:
            if e.status in LIVE_STATUSES:
                self._by_name[e.current_name] = e.fleet_id
                for p in e.prior_names:
                    self._by_name.setdefault(p.name, e.fleet_id)
            elif e.status == "retired":
                self._by_name.setdefault(e.current_name, e.fleet_id)

    def resolve(self, name_or_id: str) -> FleetEntry | None:
        """Resolve a string to a live FleetEntry, walking replaced_by chains."""
        if not name_or_id:
            return None
        e = self._by_id.get(name_or_id)
        if e is None:
            fid = self._by_name.get(name_or_id)
            e = self._by_id.get(fid) if fid else None
        if e is None:
            return None
        hops = 0
        seen: set[str] = set()
        while e and e.status == "retired" and e.replaced_by:
            if e.fleet_id in seen or hops >= MAX_RESOLVE_HOPS:
                return None
            seen.add(e.fleet_id)
            hops += 1
            e = self._by_id.get(e.replaced_by)
        return e


def load_fleet_catalog(path: str | Path) -> FleetCatalog:
    p = Path(path)
    yaml = YAML(typ="rt")
    with p.open() as f:
        raw = yaml.load(f) or {}
    nodes_raw = raw.get("nodes", []) or []
    entries = [FleetEntry.from_raw(dict(n)) for n in nodes_raw]
    return FleetCatalog(entries=entries, source_path=p, raw_root=raw)
```

- [ ] **Step 2: Export from package**

Modify `python/lexicon/__init__.py` — append:

```python
from .fleet import (
    FleetCatalog,
    FleetEntry,
    FleetPriorName,
    load_fleet_catalog,
)
```

If `__all__` is defined at module top, append `"FleetCatalog", "FleetEntry", "FleetPriorName", "load_fleet_catalog"` to it.

- [ ] **Step 3: Run tests, verify pass**

```bash
pytest tests/test_fleet.py -v
```

Expected: all 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add python/lexicon/fleet.py python/lexicon/__init__.py
git commit -m "feat: FleetCatalog with prior_names + replaced_by resolve"
```

### Task 1.4: Schema validation tests

**Files:**
- Modify: `python/tests/test_fleet.py`
- Modify: `python/lexicon/fleet.py`

- [ ] **Step 1: Add failing validation tests**

Append to `test_fleet.py`:

```python
import tempfile


def _write_yaml(text: str) -> Path:
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False)
    f.write(text)
    f.close()
    return Path(f.name)


def test_invalid_fleet_id_rejected() -> None:
    p = _write_yaml("""
version: 1
nodes:
  - fleet_id: "not-a-valid-id"
    current_name: bad
""")
    with pytest.raises(ValueError, match="fleet_id"):
        load_fleet_catalog(p)


def test_duplicate_current_name_rejected() -> None:
    p = _write_yaml("""
version: 1
nodes:
  - fleet_id: "mac:aa:aa:aa:aa:aa:aa"
    current_name: dup
    status: curated
  - fleet_id: "mac:bb:bb:bb:bb:bb:bb"
    current_name: dup
    status: curated
""")
    with pytest.raises(ValueError, match="duplicate"):
        load_fleet_catalog(p)


def test_replaced_by_only_valid_when_retired() -> None:
    p = _write_yaml("""
version: 1
nodes:
  - fleet_id: "mac:aa:aa:aa:aa:aa:aa"
    current_name: live-with-replaced-by
    status: curated
    replaced_by: "mac:bb:bb:bb:bb:bb:bb"
""")
    with pytest.raises(ValueError, match="replaced_by"):
        load_fleet_catalog(p)


def test_status_must_be_known() -> None:
    p = _write_yaml("""
version: 1
nodes:
  - fleet_id: "mac:aa:aa:aa:aa:aa:aa"
    current_name: bad-status
    status: ghost
""")
    with pytest.raises(ValueError, match="status"):
        load_fleet_catalog(p)
```

- [ ] **Step 2: Run tests, verify failure**

```bash
pytest tests/test_fleet.py -v -k "invalid or duplicate or replaced_by or status_must"
```

Expected: 4 new tests FAIL (validation not yet implemented).

- [ ] **Step 3: Implement validation in load_fleet_catalog**

Replace `load_fleet_catalog` (and add `_validate_entries` above it) in `python/lexicon/fleet.py`:

```python
def _validate_entries(entries: list[FleetEntry]) -> None:
    seen_ids: set[str] = set()
    live_names: dict[str, str] = {}
    for e in entries:
        if not FLEET_ID_RE.match(e.fleet_id):
            raise ValueError(f"invalid fleet_id: {e.fleet_id!r}")
        if e.fleet_id in seen_ids:
            raise ValueError(f"duplicate fleet_id: {e.fleet_id}")
        seen_ids.add(e.fleet_id)

        if e.status not in VALID_STATUSES:
            raise ValueError(f"unknown status {e.status!r} for {e.fleet_id}")

        if e.replaced_by and e.status != "retired":
            raise ValueError(
                f"replaced_by only valid for retired entries; "
                f"{e.fleet_id} has status={e.status}"
            )

        if e.status in LIVE_STATUSES:
            if e.current_name in live_names:
                raise ValueError(
                    f"duplicate current_name {e.current_name!r}: "
                    f"{live_names[e.current_name]} and {e.fleet_id}"
                )
            live_names[e.current_name] = e.fleet_id
            for p in e.prior_names:
                if p.name in live_names:
                    raise ValueError(
                        f"prior_name {p.name!r} on {e.fleet_id} "
                        f"collides with live entry {live_names[p.name]}"
                    )


def load_fleet_catalog(path: str | Path) -> FleetCatalog:
    p = Path(path)
    yaml = YAML(typ="rt")
    with p.open() as f:
        raw = yaml.load(f) or {}
    nodes_raw = raw.get("nodes", []) or []
    entries = [FleetEntry.from_raw(dict(n)) for n in nodes_raw]
    _validate_entries(entries)
    return FleetCatalog(entries=entries, source_path=p, raw_root=raw)
```

- [ ] **Step 4: Run tests, verify pass**

```bash
pytest tests/test_fleet.py -v
```

Expected: all tests pass (originals + 4 validation tests).

- [ ] **Step 5: Commit**

```bash
git add python/lexicon/fleet.py python/tests/test_fleet.py
git commit -m "feat: FleetCatalog schema validation on load"
```

### Task 1.5: Mutation methods — rename and retire

**Files:**
- Modify: `python/tests/test_fleet.py`
- Modify: `python/lexicon/fleet.py`

- [ ] **Step 1: Write failing tests for rename + retire + save round-trip**

Append to `test_fleet.py`:

```python
def test_rename_appends_to_prior_names(fleet: FleetCatalog) -> None:
    fleet.rename("mac:78:48:59:a8:25:97", "iron-eye", reason="fantasy-renamed")
    e = fleet.resolve("iron-eye")
    assert e is not None
    assert e.current_name == "iron-eye"
    assert any(p.name == "hp-switch" for p in e.prior_names)
    assert fleet.resolve("hp-switch") is e


def test_retire_with_replacement(fleet: FleetCatalog) -> None:
    new_entry = FleetEntry(
        fleet_id="mac:99:99:99:99:99:99",
        current_name="iron-replacement",
        realm="signal",
        kind="switch",
        status="curated",
    )
    fleet.retire(
        "mac:78:48:59:a8:25:97",
        new_entry=new_entry,
        retired_on="2026-05-18",
        reason="swapped",
    )
    assert fleet.resolve("hp-switch").current_name == "iron-replacement"
    old = fleet._by_id["mac:78:48:59:a8:25:97"]
    assert old.status == "retired"
    assert old.replaced_by == "mac:99:99:99:99:99:99"


def test_save_round_trip(fleet: FleetCatalog, tmp_path: Path) -> None:
    fleet.rename("mac:78:48:59:a8:25:97", "iron-eye")
    out = tmp_path / "fleet.yaml"
    fleet.save(out)
    reloaded = load_fleet_catalog(out)
    assert reloaded.resolve("hp-switch").current_name == "iron-eye"
    assert reloaded.resolve("iron-eye") is not None
```

- [ ] **Step 2: Run, verify failure**

```bash
pytest tests/test_fleet.py -v -k "rename or retire or save_round_trip"
```

Expected: FAIL — `AttributeError: 'FleetCatalog' object has no attribute 'rename'`.

- [ ] **Step 3: Implement rename, retire, save on FleetCatalog**

Add to `FleetCatalog` class in `python/lexicon/fleet.py`:

```python
    def rename(
        self,
        fleet_id: str,
        new_name: str,
        reason: str | None = None,
        today: str | None = None,
    ) -> None:
        e = self._by_id.get(fleet_id)
        if e is None:
            raise KeyError(f"unknown fleet_id: {fleet_id}")
        if e.status not in LIVE_STATUSES:
            raise ValueError(f"cannot rename {e.status} entry {fleet_id}")
        old = e.current_name
        if new_name == old:
            return
        e.prior_names.append(
            FleetPriorName(name=old, retired_on=today or _today(), reason=reason)
        )
        e.current_name = new_name
        _validate_entries(self.entries)
        self._reindex()

    def retire(
        self,
        old_fleet_id: str,
        new_entry: FleetEntry | None = None,
        retired_on: str | None = None,
        reason: str | None = None,
    ) -> None:
        e = self._by_id.get(old_fleet_id)
        if e is None:
            raise KeyError(f"unknown fleet_id: {old_fleet_id}")
        if new_entry is not None:
            if new_entry.fleet_id in self._by_id:
                raise ValueError(f"fleet_id already exists: {new_entry.fleet_id}")
            self.entries.append(new_entry)
            e.replaced_by = new_entry.fleet_id
        e.status = "retired"
        e.retired_on = retired_on or _today()
        if reason:
            e.retire_reason = reason
        _validate_entries(self.entries)
        self._reindex()

    def save(self, path: str | Path | None = None) -> None:
        target = Path(path) if path else self.source_path
        if target is None:
            raise ValueError("no path provided and no source_path on catalog")
        yaml = YAML(typ="rt")
        yaml.default_flow_style = False
        out = CommentedMap()
        out["version"] = 1
        out["nodes"] = CommentedSeq(self._to_raw(e) for e in self.entries)
        with target.open("w") as f:
            yaml.dump(out, f)

    @staticmethod
    def _to_raw(e: FleetEntry) -> CommentedMap:
        m = CommentedMap()
        m["fleet_id"] = e.fleet_id
        m["current_name"] = e.current_name
        m["prior_names"] = CommentedSeq(
            CommentedMap({"name": p.name, "retired_on": p.retired_on, "reason": p.reason})
            for p in e.prior_names
        )
        for k in ("realm", "kind", "role", "vendor", "notes",
                  "first_seen", "last_seen", "replaced_by",
                  "retired_on", "retire_reason"):
            v = getattr(e, k)
            if v is not None:
                m[k] = v
        m["status"] = e.status
        if e.discovery_evidence is not None:
            m["discovery_evidence"] = e.discovery_evidence
        return m
```

And add at module level:

```python
def _today() -> str:
    return date.today().isoformat()
```

- [ ] **Step 4: Run, verify pass**

```bash
pytest tests/test_fleet.py -v
```

Expected: all tests pass (original 6 + 4 validation + 3 mutation = 13).

- [ ] **Step 5: Commit**

```bash
git add python/lexicon/fleet.py python/tests/test_fleet.py
git commit -m "feat: FleetCatalog rename/retire/save with prior_names + replaced_by"
```

### Task 1.6: load_catalog_by_kind dispatcher (convenience)

**Files:**
- Modify: `python/lexicon/__init__.py`

- [ ] **Step 1: Expose a kind discriminator**

Append to `python/lexicon/__init__.py`:

```python
def load_catalog_by_kind(path, kind: str = "projects"):
    """Dispatch load by catalog kind. Convenience for callers."""
    if kind == "projects":
        from .catalog import load_catalog
        return load_catalog(path)
    if kind == "fleet":
        return load_fleet_catalog(path)
    raise ValueError(f"unknown catalog kind: {kind}")
```

- [ ] **Step 2: Commit**

```bash
git add python/lexicon/__init__.py
git commit -m "feat: load_catalog_by_kind dispatcher (projects | fleet)"
```

### Task 1.7: Tag lexicon release

- [ ] **Step 1: Bump lexicon python version**

Edit `python/pyproject.toml` — bump version (e.g. `0.2.0` → `0.3.0`). Update `CHANGELOG.md` with a `## [0.3.0]` entry listing fleet catalog support.

- [ ] **Step 2: Commit and tag**

```bash
git add python/pyproject.toml CHANGELOG.md
git commit -m "release: lexicon 0.3.0 — FleetCatalog"
git tag v0.3.0-python
```

Phase 1 complete. Lexicon now has a working FleetCatalog with full pytest coverage.

---

## Phase 2 — Realmwatch plugin skeleton (read-only)

Work in `~/Projects/realmwatch/`. No automated tests in this repo (per CLAUDE.md), so each task ends with a manual server-run smoke check.

### Task 2.1: Plugin manifest and stub setup

**Files:**
- Create: `plugins/lexicon/plugin.json`
- Create: `plugins/lexicon/plugin.py`

- [ ] **Step 1: Write manifest**

```json
{
  "name": "lexicon",
  "version": "0.1.0",
  "type": "integrated",
  "description": "Stable per-node identity via lexicon fleet catalog. Owns current_name/prior_names/realm/kind/role for every realmwatch node.",
  "fantasy_name": "The Naming Ledger",
  "icon": "📜",
  "priority": 100,
  "depends_on": [],
  "panel": {
    "id": "lexicon-panel",
    "name": "The Naming Ledger",
    "html": "panel.html",
    "js": "panel.js",
    "css": "panel.css",
    "anchor": "sw",
    "priority": 80
  }
}
```

- [ ] **Step 2: Write stub plugin.py**

```python
# plugins/lexicon/plugin.py
"""Lexicon plugin — fleet catalog (identity-of-record) for realmwatch.

Spec: docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import sys
from pathlib import Path

# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
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
```

- [ ] **Step 3: Run server, verify it starts and lexicon plugin loads**

```bash
cd ~/Projects/realmwatch
make dev
```

In another terminal:

```bash
curl -s http://localhost/debug | python3 -m json.tool | grep -A 3 lexicon
```

Expected: lexicon plugin shown as loaded (with WARN about missing fleet.yaml — expected at this stage).

- [ ] **Step 4: Commit**

```bash
git add plugins/lexicon/plugin.json plugins/lexicon/plugin.py
git commit -m "feat: lexicon plugin skeleton (loads fleet.yaml when present)"
```

### Task 2.2: Add fleet.yaml to .gitignore + minimal example

**Files:**
- Modify: `.gitignore`
- Create: `fleet.example.yaml`

- [ ] **Step 1: Update .gitignore**

Append to `.gitignore`:

```
# Fleet catalog — JP-specific MACs, hostnames, VLANs; never tracked
fleet.yaml
```

- [ ] **Step 2: Write fleet.example.yaml as a public reference**

```yaml
# fleet.example.yaml — example showing the schema. Actual fleet.yaml is gitignored.
version: 1
nodes:
  - fleet_id: "mac:00:11:22:33:44:55"
    current_name: example-switch
    prior_names: []
    realm: signal
    kind: switch
    role: managed_switch_8port
    status: curated
    first_seen: 2026-01-01
```

- [ ] **Step 3: Create a temporary fleet.yaml by copying the example**

```bash
cp fleet.example.yaml fleet.yaml
```

- [ ] **Step 4: Restart server, verify catalog loads**

```bash
make dev
```

In another terminal:

```bash
curl -s http://localhost/debug | python3 -c "import sys,json; d=json.load(sys.stdin); print([p for p in d.get('plugins',[]) if 'lexicon' in str(p).lower()])"
```

Expected: lexicon plugin loaded with 1 fleet entry.

- [ ] **Step 5: Commit**

```bash
git add .gitignore fleet.example.yaml
git commit -m "chore: gitignore fleet.yaml + add example reference"
```

### Task 2.3: Plugin registry getter for cross-plugin API access

**Files:**
- Modify: `plugin_registry.py`

- [ ] **Step 1: Add get_plugin_api**

Find `expose_plugin_api(self, plugin_name: str, api_dict: dict)` in `plugin_registry.py`. Add an instance variable to track exposed APIs and a getter:

```python
    def __init__(self):
        # ... existing init ...
        self._plugin_apis: dict[str, dict] = {}

    def expose_plugin_api(self, plugin_name: str, api_dict: dict):
        # store for cross-plugin lookup
        self._plugin_apis[plugin_name] = dict(self._plugin_apis.get(plugin_name, {}))
        self._plugin_apis[plugin_name].update(api_dict)
        # ... existing behavior ...

    def get_plugin_api(self, plugin_name: str) -> dict | None:
        """Return the exposed API dict for a named plugin, or None if not exposed."""
        return self._plugin_apis.get(plugin_name)
```

(If `expose_plugin_api` already stores into a registry, just add the getter alongside.)

- [ ] **Step 2: Commit**

```bash
git add plugin_registry.py
git commit -m "feat: plugin_registry.get_plugin_api() for cross-plugin API lookup"
```

### Task 2.4: Read-only endpoints — /fleet/list and /fleet/resolve

**Files:**
- Create: `plugins/lexicon/endpoints.py`
- Modify: `plugins/lexicon/plugin.py`

- [ ] **Step 1: Write the endpoints module**

```python
# plugins/lexicon/endpoints.py
"""HTTP handlers for /fleet/* — read paths."""

from __future__ import annotations

from dataclasses import asdict


def _entry_to_dict(e):
    return asdict(e)


def register(ctx, catalog):
    """Wire read-only fleet endpoints."""

    def list_handler(req):
        status_filter = req.query_params().get("status")
        entries = catalog.entries
        if status_filter:
            entries = [e for e in entries if e.status == status_filter]
        return req.respond({
            "count": len(entries),
            "entries": [_entry_to_dict(e) for e in entries],
        })

    def resolve_handler(req):
        name = req.path().rsplit("/", 1)[-1]
        e = catalog.resolve(name)
        if e is None:
            return req.respond({"error": "not found", "query": name}, status=404)
        return req.respond({"query": name, "entry": _entry_to_dict(e)})

    ctx.register_endpoint("GET", "/fleet/list", list_handler)
    ctx.register_endpoint("GET", "/fleet/resolve/", resolve_handler, raw_path=True)
```

- [ ] **Step 2: Wire endpoints from plugin.py**

Replace the `setup()` body in `plugins/lexicon/plugin.py`:

```python
def setup(ctx):
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
```

- [ ] **Step 3: Restart server, smoke-test endpoints**

```bash
make dev
# in another terminal:
curl -s http://localhost/fleet/list | python3 -m json.tool
curl -s http://localhost/fleet/resolve/example-switch | python3 -m json.tool
curl -sw "%{http_code}\n" http://localhost/fleet/resolve/does-not-exist -o /dev/null
```

Expected:
- `/fleet/list` → JSON with `count: 1`, one entry
- `/fleet/resolve/example-switch` → JSON with the entry
- `/fleet/resolve/does-not-exist` → 404

- [ ] **Step 4: Commit**

```bash
git add plugins/lexicon/endpoints.py plugins/lexicon/plugin.py
git commit -m "feat: GET /fleet/list and /fleet/resolve/<name>"
```

Phase 2 complete. Read-only plugin ships with a hand-edited fleet.yaml.

---

## Phase 3 — Migration from realm.db

### Task 3.1: Migration script — dry-run mode

**Files:**
- Create: `scripts/migrate-fleet.py`

- [ ] **Step 1: Write the dry-run scaffold**

```python
#!/usr/bin/env python3
"""One-shot migration: realm.db nodes → fleet.yaml.

Idempotent. Run with --dry-run first; rerun with --apply to actually write.

Per spec: realmwatch/docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import uuid
from datetime import date
from pathlib import Path

# Path-injection per CLAUDE.md realm-sigil precedent
_LEXICON_PY = Path.home() / "Projects" / "lexicon.realm.watch" / "python"
sys.path.insert(0, str(_LEXICON_PY))

from lexicon import FleetCatalog, FleetEntry  # noqa: E402

REPO = Path(__file__).parent.parent
REALM_DB = REPO / "realm.db"
FLEET_YAML = REPO / "fleet.yaml"
PERSONAS_JSON = REPO / "personas.json"
REALM_LOCAL_JSON = REPO / "realm-local.json"


def derive_realm_from_role(role: str | None) -> str:
    """Map a role string to a realm. Conservative — defaults to signal."""
    if not role:
        return "signal"
    role_lower = role.lower()
    realm_hints = {
        "router": "signal",
        "switch": "signal",
        "access_point": "signal",
        "server": "forge",
        "printer": "forest",
        "camera": "void",
        "wled": "stellar",
        "ha_": "oracle",
    }
    for prefix, realm in realm_hints.items():
        if prefix in role_lower:
            return realm
    return "signal"


def plan_migration(db_path: Path) -> tuple[list[FleetEntry], list[tuple[str, str]]]:
    """Read realm.db nodes, build fleet entries, return (entries, db_writebacks)."""
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    entries: list[FleetEntry] = []
    writebacks: list[tuple[str, str]] = []

    for row in db.execute("SELECT node_id, data FROM nodes"):
        node_id = row["node_id"]
        try:
            data = json.loads(row["data"] or "{}")
        except json.JSONDecodeError:
            print(f"  WARN: bad JSON in node {node_id}, skipping", file=sys.stderr)
            continue

        existing_fleet_id = data.get("fleet_id")
        mac = (data.get("mac") or "").lower().strip()
        if mac and ":" in mac:
            fleet_id = f"mac:{mac}"
        elif existing_fleet_id:
            fleet_id = existing_fleet_id
        else:
            fleet_id = f"fleet:{uuid.uuid4()}"

        entry = FleetEntry(
            fleet_id=fleet_id,
            current_name=node_id,
            prior_names=[],
            realm=derive_realm_from_role(data.get("role")),
            kind=data.get("type"),
            role=data.get("role"),
            vendor=data.get("vendor"),
            status="curated",
            first_seen=str(date.today()),
            last_seen=str(date.today()),
        )
        entries.append(entry)

        new_data = dict(data)
        new_data["fleet_id"] = fleet_id
        for k in ("label", "role", "realm", "type", "vendor"):
            new_data.pop(k, None)
        writebacks.append((node_id, json.dumps(new_data)))

    db.close()
    return entries, writebacks


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate realm.db → fleet.yaml")
    parser.add_argument("--apply", action="store_true",
                        help="actually write files (default: dry-run)")
    parser.add_argument("--db", default=str(REALM_DB), help="path to realm.db")
    parser.add_argument("--out", default=str(FLEET_YAML), help="path to write fleet.yaml")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: {db_path} not found", file=sys.stderr)
        return 1

    entries, writebacks = plan_migration(db_path)

    by_anchor = {"mac": 0, "fleet": 0}
    for e in entries:
        by_anchor[e.fleet_id.split(":", 1)[0]] += 1

    print(f"would write {len(entries)} fleet entries:")
    print(f"  mac-anchored:   {by_anchor['mac']}")
    print(f"  uuid-anchored:  {by_anchor['fleet']}")
    print(f"would rewrite {len(writebacks)} realm.db nodes.data blobs")
    print()
    print("sample entries:")
    for e in entries[:5]:
        print(f"  {e.fleet_id:50s} → {e.current_name:25s} realm={e.realm}")

    if not args.apply:
        print()
        print("(dry-run; rerun with --apply to write)")
        return 0

    import shutil
    backup = db_path.with_suffix(f".db.pre-fleet-{date.today().isoformat()}")
    shutil.copy2(db_path, backup)
    print(f"backed up realm.db → {backup}")

    out_path = Path(args.out)
    catalog = FleetCatalog(entries=entries, source_path=out_path)
    catalog.save(out_path)
    print(f"wrote {out_path}")

    db = sqlite3.connect(db_path)
    for node_id, new_data in writebacks:
        db.execute("UPDATE nodes SET data = ? WHERE node_id = ?", (new_data, node_id))
    db.commit()
    db.close()
    print(f"rewrote {len(writebacks)} realm.db node data blobs")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run dry-run, inspect output**

```bash
cd ~/Projects/realmwatch
python3 scripts/migrate-fleet.py
```

Expected output: `~99 fleet entries`, breakdown of mac-anchored vs uuid-anchored matching realm.db reality (52 mac, 47 fleet:uuid), sample entries listed.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-fleet.py
git commit -m "feat: migrate-fleet.py dry-run + apply (realm.db → fleet.yaml)"
```

### Task 3.2: Apply migration

- [ ] **Step 1: Stop the server, apply**

```bash
pkill -f "python3 map_server.py" || true
cd ~/Projects/realmwatch
python3 scripts/migrate-fleet.py --apply
```

Expected: writes `fleet.yaml`, updates ~99 rows in realm.db, prints backup path.

- [ ] **Step 2: Verify fleet.yaml is valid**

```bash
python3 -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path.home() / 'Projects' / 'lexicon.realm.watch' / 'python'))
from lexicon import load_fleet_catalog
cat = load_fleet_catalog('fleet.yaml')
print(f'loaded {len(cat.entries)} entries')
for e in cat.entries[:3]: print(' ', e.fleet_id, '->', e.current_name)
"
```

- [ ] **Step 3: Verify realm.db still loads and topology renders**

```bash
make dev
# in another terminal:
curl -s http://localhost/fleet/list | python3 -c "import sys,json; d=json.load(sys.stdin); print('count:', d['count'])"
curl -s http://localhost/topology | python3 -c "import sys,json; d=json.load(sys.stdin); print('nodes:', len(d.get('nodes',[])))"
```

Both counts should match realm.db's `nodes` row count.

Open `xdg-open http://localhost/realm-map.html` and confirm the map renders. Node labels may temporarily look different until Task 5.1 wires the resolver into the topology read path.

### Task 3.3: Rekey personas.json and realm-local.json

**Files:**
- Modify: `scripts/migrate-fleet.py`

- [ ] **Step 1: Add rekey functions**

Add to `migrate-fleet.py`, before `main()`:

```python
def rekey_json_file(path: Path, key_to_fleet_id: dict[str, str], apply: bool) -> None:
    if not path.exists():
        print(f"  skip: {path} not present")
        return
    data = json.loads(path.read_text())
    rekeyed_top: dict[str, object] = {}
    legacy_map: dict[str, str] = {}
    for k, v in data.items():
        if k == "_comment":
            rekeyed_top[k] = v
            continue
        if isinstance(v, dict):
            new_inner = {}
            for inner_k, inner_v in v.items():
                fid = key_to_fleet_id.get(inner_k)
                if fid:
                    new_inner[fid] = inner_v
                    legacy_map[fid] = inner_k
                else:
                    new_inner[inner_k] = inner_v
            rekeyed_top[k] = new_inner
        else:
            rekeyed_top[k] = v
    if legacy_map:
        rekeyed_top["_legacy_name_map"] = legacy_map

    if apply:
        backup = path.with_suffix(path.suffix + f".pre-fleet-{date.today().isoformat()}")
        path.rename(backup)
        path.write_text(json.dumps(rekeyed_top, indent=2))
        print(f"  rekeyed {path.name}: {len(legacy_map)} keys converted (backup: {backup.name})")
    else:
        print(f"  would rekey {path.name}: {len(legacy_map)} keys")
```

In `main()`, after the realm.db writeback block, add:

```python
    name_to_id = {e.current_name: e.fleet_id for e in entries}
    rekey_json_file(PERSONAS_JSON, name_to_id, apply=args.apply)
    rekey_json_file(REALM_LOCAL_JSON, name_to_id, apply=args.apply)
```

- [ ] **Step 2: Dry-run, inspect**

```bash
python3 scripts/migrate-fleet.py
```

Look for the "would rekey" lines for `personas.json` and `realm-local.json`.

- [ ] **Step 3: Apply**

```bash
python3 scripts/migrate-fleet.py --apply
ls -1 personas.json* realm-local.json* 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-fleet.py
git commit -m "feat: migrate-fleet.py rekeys personas.json + realm-local.json"
```

### Task 3.4: Smoke-test script

**Files:**
- Create: `scripts/test-fleet.py`

- [ ] **Step 1: Write the smoke test**

```python
#!/usr/bin/env python3
"""End-to-end smoke test for the fleet plugin. Runs against a live server.

Usage: python3 scripts/test-fleet.py [--host http://localhost]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.reason}


def post(url: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.reason}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost")
    args = parser.parse_args()

    failures = 0

    print("1. /fleet/list returns >0 entries")
    status, body = get(f"{args.host}/fleet/list")
    if status != 200 or body.get("count", 0) == 0:
        print(f"   FAIL: status={status} count={body.get('count')}")
        failures += 1
    else:
        print(f"   PASS: {body['count']} entries")

    if body.get("count"):
        sample_name = body["entries"][0]["current_name"]
        print(f"2. /fleet/resolve/{sample_name} returns the entry")
        status, body2 = get(f"{args.host}/fleet/resolve/{sample_name}")
        if status != 200 or body2.get("entry", {}).get("current_name") != sample_name:
            print(f"   FAIL: status={status} body={body2}")
            failures += 1
        else:
            print(f"   PASS")

    print("3. /fleet/resolve/does-not-exist returns 404")
    status, body3 = get(f"{args.host}/fleet/resolve/zzz-does-not-exist")
    if status != 404:
        print(f"   FAIL: expected 404, got {status}")
        failures += 1
    else:
        print(f"   PASS")

    print("4. /topology still renders (no regression)")
    status, body4 = get(f"{args.host}/topology")
    if status != 200 or "nodes" not in body4:
        print(f"   FAIL: status={status}")
        failures += 1
    else:
        print(f"   PASS: {len(body4.get('nodes', []))} nodes")

    if failures:
        print(f"\n{failures} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Run smoke test against the running server**

```bash
# make sure server is running: make dev (in another terminal)
python3 scripts/test-fleet.py
```

Expected: all 4 checks pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-fleet.py
git commit -m "test: smoke-test script for /fleet/* endpoints"
```

Phase 3 complete. fleet.yaml exists, personas.json and realm-local.json rekeyed, smoke test green.

---

## Phase 4 — Mutating endpoints

### Task 4.1: POST /fleet/rename

**Files:**
- Modify: `plugins/lexicon/endpoints.py`
- Modify: `scripts/test-fleet.py`

- [ ] **Step 1: Add rename handler in endpoints.py**

Insert into `register()` in `plugins/lexicon/endpoints.py`:

```python
    def rename_handler(req):
        try:
            body = req.json()
        except Exception:
            return req.respond({"error": "invalid JSON"}, status=400)

        fleet_id = body.get("fleet_id")
        new_name = body.get("new_name")
        reason = body.get("reason")
        if not fleet_id or not new_name:
            return req.respond(
                {"error": "fleet_id and new_name required"}, status=400
            )

        try:
            catalog.rename(fleet_id, new_name, reason=reason)
        except KeyError as e:
            return req.respond({"error": str(e)}, status=404)
        except ValueError as e:
            return req.respond({"error": str(e)}, status=400)

        catalog.save()

        ctx.push_event("realm-event", {
            "kind": "fleet.renamed",
            "fleet_id": fleet_id,
            "from": catalog._by_id[fleet_id].prior_names[-1].name,
            "to": new_name,
        })
        ctx.push_event("plugin-broadcast", {
            "type": "fleet-update",
            "changed_fleet_ids": [fleet_id],
        })

        return req.respond({"ok": True, "fleet_id": fleet_id, "current_name": new_name})

    ctx.register_endpoint("POST", "/fleet/rename", rename_handler)
```

- [ ] **Step 2: Restart server and exercise rename**

```bash
make dev
# in another terminal — pick any current entry's fleet_id:
curl -s -X POST http://localhost/fleet/rename \
  -H "Content-Type: application/json" \
  -d '{"fleet_id":"mac:78:48:59:a8:25:97","new_name":"renamed-by-test","reason":"phase4 smoke"}' \
  | python3 -m json.tool
curl -s http://localhost/fleet/resolve/hp-switch | python3 -m json.tool
# expect resolved entry with current_name=renamed-by-test
```

Verify fleet.yaml on disk got updated:

```bash
grep -A 2 "renamed-by-test" fleet.yaml
```

- [ ] **Step 3: Extend smoke test**

In `scripts/test-fleet.py`, append a check before the final summary:

```python
    print("5. POST /fleet/rename round-trips")
    status, body5 = get(f"{args.host}/fleet/list")
    target = body5["entries"][0]
    original_name = target["current_name"]
    new_name = original_name + "-smoke"
    status_r1, r1 = post(f"{args.host}/fleet/rename",
                         {"fleet_id": target["fleet_id"], "new_name": new_name})
    if status_r1 == 200 and r1.get("ok") and r1.get("current_name") == new_name:
        # rename back so test is idempotent
        post(f"{args.host}/fleet/rename",
             {"fleet_id": target["fleet_id"], "new_name": original_name})
        print(f"   PASS")
    else:
        print(f"   FAIL: status={status_r1} response={r1}")
        failures += 1
```

Run it: `python3 scripts/test-fleet.py` — expect all 5 pass.

- [ ] **Step 4: Commit**

```bash
git add plugins/lexicon/endpoints.py scripts/test-fleet.py
git commit -m "feat: POST /fleet/rename + SSE realm-event + smoke test"
```

### Task 4.2: POST /fleet/replace

**Files:**
- Modify: `plugins/lexicon/endpoints.py`

- [ ] **Step 1: Add the inheritance helpers at module top of endpoints.py**

Add (or update) the top of `endpoints.py`:

```python
import json
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent.parent
REPO_PERSONAS = REPO_ROOT / "personas.json"
REPO_REALM_LOCAL = REPO_ROOT / "realm-local.json"
REPO_REALM_DB = REPO_ROOT / "realm.db"


def _rekey_json(path: Path, old_key: str, new_key: str) -> None:
    if not path.exists():
        return
    d = json.loads(path.read_text())
    if old_key in d:
        d[new_key] = d.pop(old_key)
        path.write_text(json.dumps(d, indent=2))


def _rekey_json_nested(path: Path, outer_key: str, old_key: str, new_key: str) -> None:
    if not path.exists():
        return
    d = json.loads(path.read_text())
    inner = d.get(outer_key)
    if isinstance(inner, dict) and old_key in inner:
        inner[new_key] = inner.pop(old_key)
        path.write_text(json.dumps(d, indent=2))


def _rekey_realm_db_topology(db_path: Path, old_fleet_id: str, new_fleet_id: str,
                              ip: str | None = None, vlan: int | None = None) -> None:
    if not db_path.exists():
        return
    db = sqlite3.connect(db_path)
    for row in list(db.execute("SELECT node_id, data FROM nodes")):
        data = json.loads(row[1] or "{}")
        if data.get("fleet_id") == old_fleet_id:
            data["fleet_id"] = new_fleet_id
            if ip:
                data["ip"] = ip
            if vlan is not None:
                data["vlan"] = vlan
            db.execute("UPDATE nodes SET data = ? WHERE node_id = ?",
                       (json.dumps(data), row[0]))
            break
    db.commit()
    db.close()
```

- [ ] **Step 2: Add replace handler**

Insert into `register()`:

```python
    def replace_handler(req):
        try:
            body = req.json()
        except Exception:
            return req.respond({"error": "invalid JSON"}, status=400)

        old_ref = body.get("old", {})
        new_spec = body.get("new", {})
        inherit = body.get("inherit", {})
        if not (old_ref and new_spec.get("fleet_id") and new_spec.get("current_name")):
            return req.respond(
                {"error": "old, new.fleet_id, new.current_name required"}, status=400
            )

        old_entry = None
        if old_ref.get("fleet_id"):
            old_entry = catalog._by_id.get(old_ref["fleet_id"])
        elif old_ref.get("name"):
            old_entry = catalog.resolve(old_ref["name"])
        if old_entry is None:
            return req.respond({"error": f"old entry not found: {old_ref}"}, status=404)

        from lexicon import FleetEntry
        new_entry = FleetEntry(
            fleet_id=new_spec["fleet_id"],
            current_name=new_spec["current_name"],
            realm=new_spec.get("realm", old_entry.realm),
            kind=new_spec.get("kind", old_entry.kind),
            role=new_spec.get("role", old_entry.role),
            vendor=new_spec.get("vendor"),
            status="curated",
        )

        try:
            catalog.retire(
                old_entry.fleet_id,
                new_entry=new_entry,
                retired_on=body.get("retired_on"),
                reason=body.get("reason"),
            )
        except (KeyError, ValueError) as e:
            return req.respond({"error": str(e)}, status=400)

        catalog.save()

        warnings = []
        if inherit.get("persona"):
            try:
                _rekey_json(REPO_PERSONAS, old_entry.fleet_id, new_entry.fleet_id)
            except Exception as e:
                warnings.append(f"persona rekey failed: {e}")
        if inherit.get("herald_templates"):
            try:
                _rekey_json_nested(REPO_REALM_LOCAL, "herald_node_templates",
                                   old_entry.fleet_id, new_entry.fleet_id)
            except Exception as e:
                warnings.append(f"herald rekey failed: {e}")
        if inherit.get("position"):
            try:
                _rekey_realm_db_topology(REPO_REALM_DB, old_entry.fleet_id, new_entry.fleet_id,
                                         ip=body.get("ip"), vlan=body.get("vlan"))
            except Exception as e:
                warnings.append(f"realm.db rekey failed: {e}")

        ctx.push_event("realm-event", {
            "kind": "fleet.replaced",
            "old_fleet_id": old_entry.fleet_id,
            "new_fleet_id": new_entry.fleet_id,
            "retired_on": body.get("retired_on"),
        })
        ctx.push_event("plugin-broadcast", {
            "type": "fleet-update",
            "changed_fleet_ids": [old_entry.fleet_id, new_entry.fleet_id],
        })

        resp = {"ok": True, "old_fleet_id": old_entry.fleet_id, "new_fleet_id": new_entry.fleet_id}
        if warnings:
            resp["warnings"] = warnings
        return req.respond(resp)

    ctx.register_endpoint("POST", "/fleet/replace", replace_handler)
```

- [ ] **Step 3: Smoke-test the replace verb**

The actual gst308t-office → east-tree-trunk case:

```bash
make dev
# pick the fleet_id for the old gst308t-office entry from /fleet/list, then:
OLD_ID="mac:<existing-mac>"  # fill from /fleet/list output
curl -s -X POST http://localhost/fleet/replace \
  -H "Content-Type: application/json" \
  -d "{
    \"old\": {\"fleet_id\":\"${OLD_ID}\"},
    \"new\": {
      \"fleet_id\":\"mac:b4:fb:e4:12:34:56\",
      \"current_name\":\"east-tree-trunk\",
      \"realm\":\"forest\",
      \"kind\":\"switch\"
    },
    \"inherit\": {\"persona\": true, \"position\": true, \"herald_templates\": true},
    \"ip\": \"10.0.37.4\",
    \"vlan\": 37,
    \"retired_on\": \"2026-05-18\",
    \"reason\": \"swapped\"
  }" | python3 -m json.tool

curl -s http://localhost/fleet/resolve/gst308t-office | python3 -m json.tool
# expect to see east-tree-trunk via replaced_by chain
```

Inspect fleet.yaml — old entry should be `status: retired`, new entry should be `status: curated`.

- [ ] **Step 4: Commit**

```bash
git add plugins/lexicon/endpoints.py
git commit -m "feat: POST /fleet/replace with persona/position/herald inheritance"
```

### Task 4.3: POST /fleet/promote and POST /fleet/reload

**Files:**
- Modify: `plugins/lexicon/endpoints.py`

- [ ] **Step 1: Add promote and reload handlers**

Insert into `register()`:

```python
    def promote_handler(req):
        try:
            body = req.json()
        except Exception:
            return req.respond({"error": "invalid JSON"}, status=400)
        fleet_id = body.get("fleet_id")
        entry = catalog._by_id.get(fleet_id) if fleet_id else None
        if entry is None:
            return req.respond({"error": "not found"}, status=404)
        if entry.status != "tentative":
            return req.respond(
                {"error": f"can only promote tentative entries; got {entry.status}"},
                status=400,
            )
        entry.status = "curated"
        if body.get("new_name"):
            entry.current_name = body["new_name"]
        for field_name in ("realm", "kind", "role"):
            if field_name in body:
                setattr(entry, field_name, body[field_name])
        catalog._reindex()
        catalog.save()
        ctx.push_event("realm-event", {
            "kind": "fleet.promoted",
            "fleet_id": fleet_id,
            "current_name": entry.current_name,
        })
        ctx.push_event("plugin-broadcast", {
            "type": "fleet-update",
            "changed_fleet_ids": [fleet_id],
        })
        return req.respond({"ok": True, "fleet_id": fleet_id, "current_name": entry.current_name})

    def reload_handler(req):
        from lexicon import load_fleet_catalog
        new_catalog = load_fleet_catalog(catalog.source_path)
        catalog.entries = new_catalog.entries
        catalog._reindex()
        ctx.push_event("plugin-broadcast", {"type": "fleet-update", "reloaded": True})
        return req.respond({"ok": True, "count": len(catalog.entries)})

    ctx.register_endpoint("POST", "/fleet/promote", promote_handler)
    ctx.register_endpoint("POST", "/fleet/reload", reload_handler)
```

- [ ] **Step 2: Smoke test**

```bash
curl -s -X POST http://localhost/fleet/reload | python3 -m json.tool
# expect {ok: true, count: N}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/lexicon/endpoints.py
git commit -m "feat: POST /fleet/promote (tentative → curated) and /fleet/reload"
```

Phase 4 complete. All four mutating verbs live and smoke-tested.

---

## Phase 5 — Read-path integration

### Task 5.1: Topology join in /topology endpoint

**Files:**
- Modify: `map_server.py` (find the `/topology` GET handler)

- [ ] **Step 1: Locate the /topology handler and add a fleet-aware join**

Add a module-level helper near the top of `map_server.py`:

```python
def _join_fleet_into_nodes(nodes: list[dict], fleet_api: dict | None) -> list[dict]:
    """Replace identity fields (label, role, realm, kind) with values from fleet catalog."""
    if not fleet_api or not fleet_api.get("loaded"):
        return nodes
    resolve = fleet_api["resolve"]
    out = []
    for node in nodes:
        fid = (node.get("data") or {}).get("fleet_id") or node.get("fleet_id")
        entry = resolve(fid) if fid else None
        if entry is None:
            out.append(node)
            continue
        merged = dict(node)
        merged.setdefault("data", {})
        merged["label"] = entry.current_name
        merged["fleet_id"] = entry.fleet_id
        if entry.realm:
            merged["realm"] = entry.realm
        if entry.role:
            merged["role"] = entry.role
        if entry.kind:
            merged["kind"] = entry.kind
        out.append(merged)
    return out
```

Find the function that handles `GET /topology` and serves a dict with `nodes` and `connections`. Just before returning, inject:

```python
    fleet_api = plugin_registry.get_plugin_api("lexicon") if plugin_registry else None
    response["nodes"] = _join_fleet_into_nodes(response["nodes"], fleet_api)
```

- [ ] **Step 2: Restart, verify topology nodes have resolved fields**

```bash
make dev
curl -s http://localhost/topology | python3 -c "
import sys, json
d = json.load(sys.stdin)
n = d['nodes'][0]
print('first node:', {k: n.get(k) for k in ('id','label','fleet_id','realm','role')})
"
```

Expect: `fleet_id` populated, `label` equals the fleet entry's current_name.

- [ ] **Step 3: Open the map in browser, verify it still renders**

```bash
xdg-open http://localhost/realm-map.html
```

Visually confirm node labels still appear correctly.

- [ ] **Step 4: Commit**

```bash
git add map_server.py
git commit -m "feat: /topology joins fleet catalog for label/role/realm/kind"
```

### Task 5.2: Resolver wrapper for endpoints that accept node ids by name

**Files:**
- Modify: `map_server.py`

- [ ] **Step 1: Add a resolver helper**

Add to `map_server.py`:

```python
def _resolve_node_id(node_id_or_name: str, plugin_registry) -> str:
    """Resolve any string (current_name, prior_name, fleet_id) to current node_id.
    Returns the input unchanged if no fleet entry matches (backward-compat)."""
    fleet_api = plugin_registry.get_plugin_api("lexicon") if plugin_registry else None
    if not fleet_api or not fleet_api.get("loaded"):
        return node_id_or_name
    entry = fleet_api["resolve"](node_id_or_name)
    if entry is None:
        return node_id_or_name
    return entry.current_name
```

- [ ] **Step 2: Wrap callers**

For each handler that pulls a node id from a request body or URL — targets: `POST /node`, `POST /personas`, `POST /ssh`, `GET /ping/<ip>`, `POST /wol`, `POST /wled/<node_id>/state` — replace:

```python
node_id = body["id"]
```

with:

```python
original_id = body["id"]
node_id = _resolve_node_id(original_id, plugin_registry)
```

And in each handler, if the server's response API supports custom headers, attach:

```python
if node_id != original_id:
    req.set_header("X-Fleet-Resolved",
                   f"prior_name={original_id}; current_name={node_id}")
```

(If `req` doesn't expose `set_header`, add a `headers` argument to `req.respond()` in `plugin_context.py` and use that — keep the change minimal.)

- [ ] **Step 3: Smoke-test backward compatibility**

```bash
# Try a prior_name and verify it routes to the new current_name node:
curl -sv -X POST http://localhost/node \
  -H "Content-Type: application/json" \
  -d '{"id":"<known-prior-name>","ip":"10.0.6.99"}' 2>&1 | grep -i fleet-resolved
```

- [ ] **Step 4: Commit**

```bash
git add map_server.py plugin_context.py
git commit -m "feat: resolver wrapper for /node, /personas, /ssh etc. + X-Fleet-Resolved header"
```

### Task 5.3: SSE topology event uses resolved shape

**Files:**
- Modify: `map_server.py` (find the SSE topology event source)

- [ ] **Step 1: Pipe SSE topology through the same join**

Locate the SSE source registered for the `topology` event. It builds the same `{nodes, connections}` payload — apply `_join_fleet_into_nodes` to its `nodes` field before emitting:

```python
def _topology_sse_getter():
    payload = _build_topology_payload()  # existing function
    fleet_api = plugin_registry.get_plugin_api("lexicon")
    payload["nodes"] = _join_fleet_into_nodes(payload["nodes"], fleet_api)
    return payload
```

- [ ] **Step 2: Confirm SSE event carries resolved labels**

```bash
curl -s -N http://localhost/sse | grep -m1 -A1 '"event": "topology"' | head -20
```

Look for `"label":` matching the fleet catalog values.

- [ ] **Step 3: Commit**

```bash
git add map_server.py
git commit -m "feat: SSE topology event uses fleet-resolved labels"
```

Phase 5 complete. Server is fleet-aware end-to-end.

---

## Phase 6 — Discovery hook + watcher

### Task 6.1: Discovery callback writes tentative entries

**Files:**
- Create: `plugins/lexicon/discovery.py`
- Modify: `plugins/lexicon/plugin.py`
- Modify: `discovery_engine.py`

- [ ] **Step 1: Add a fleet-tentative writer in the plugin**

```python
# plugins/lexicon/discovery.py
"""Discovery callback — on first sight of a new MAC, write a tentative fleet entry."""

from __future__ import annotations

from datetime import date

from lexicon import FleetEntry


def on_discovery_observation(catalog, mac: str, hostname: str | None,
                              vendor_oui: str | None, evidence: dict,
                              save_fn) -> bool:
    """Returns True if a new tentative entry was created."""
    if not mac:
        return False
    mac = mac.lower()
    fleet_id = f"mac:{mac}"
    if fleet_id in catalog._by_id:
        catalog._by_id[fleet_id].last_seen = str(date.today())
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
        discovery_evidence=evidence,
    )
    if suggested in catalog._by_name:
        entry.current_name = f"{suggested}-{suffix4}"
    catalog.entries.append(entry)
    catalog._reindex()
    save_fn()
    return True
```

- [ ] **Step 2: Register the callback from plugin.py**

Append to `setup()` in `plugins/lexicon/plugin.py`, after `endpoints.register(...)`:

```python
    from . import discovery as _discovery_mod
    def _discovery_cb(evt):
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
    ctx.on_event("discovery.observation", _discovery_cb)
```

- [ ] **Step 3: Emit the event from discovery_engine.py**

Find where `discovery_engine.py` processes a newly-observed device (look for where it writes to the `sub_entities` table or where it logs discovery). Use the existing event-push mechanism (`push_event_fn` if injected, or the SSE broker). Add at the appropriate point:

```python
push_event_fn("discovery.observation", {
    "mac": observation.mac,
    "hostname": observation.hostname,
    "vendor_oui": observation.vendor_oui,
    "evidence": observation.evidence,
})
```

If the local variable names differ, adapt to the existing module's shape — the key is emitting an event named `discovery.observation` with `mac`, `hostname`, `vendor_oui`, `evidence` fields.

- [ ] **Step 4: Smoke test**

Trigger a discovery scan via the existing `/scan` endpoint:

```bash
curl -s -X POST http://localhost/scan
sleep 30
curl -s "http://localhost/fleet/list?status=tentative" | python3 -m json.tool | head -40
```

Expect at least a few tentative entries if any new MACs were observed.

- [ ] **Step 5: Commit**

```bash
git add plugins/lexicon/discovery.py plugins/lexicon/plugin.py discovery_engine.py
git commit -m "feat: discovery_engine writes tentative fleet entries on new MAC"
```

### Task 6.2: mtime watcher on fleet.yaml

**Files:**
- Create: `plugins/lexicon/watcher.py`
- Modify: `plugins/lexicon/plugin.py`

- [ ] **Step 1: Implement an mtime poll loop (stdlib only)**

```python
# plugins/lexicon/watcher.py
"""Filesystem watcher for fleet.yaml. Polls mtime every 2s; reloads on change.

stdlib-only — no pyinotify dependency. Works on bind mounts and remote FSes."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable


class FleetWatcher(threading.Thread):
    def __init__(self, path: Path, on_change: Callable[[], None],
                 interval: float = 2.0):
        super().__init__(daemon=True, name="fleet-watcher")
        self.path = path
        self.on_change = on_change
        self.interval = interval
        self._last_mtime = self._mtime()
        self._stop = threading.Event()

    def _mtime(self) -> float:
        try:
            return self.path.stat().st_mtime
        except FileNotFoundError:
            return 0.0

    def run(self) -> None:
        while not self._stop.wait(self.interval):
            current = self._mtime()
            if current and current != self._last_mtime:
                self._last_mtime = current
                try:
                    self.on_change()
                except Exception as e:
                    print(f"[fleet-watcher] reload failed: {e}")

    def stop(self) -> None:
        self._stop.set()
```

- [ ] **Step 2: Start the watcher from setup()**

In `plugins/lexicon/plugin.py`, append to `setup()`:

```python
    from . import watcher as _watcher_mod
    def _reload_from_disk():
        new_cat = load_fleet_catalog(FLEET_YAML)
        catalog.entries = new_cat.entries
        catalog._reindex()
        ctx.push_event("plugin-broadcast", {"type": "fleet-update", "reloaded": True})
        ctx.log(f"fleet.yaml reloaded: {len(catalog.entries)} entries")

    _watcher = _watcher_mod.FleetWatcher(FLEET_YAML, _reload_from_disk)
    _watcher.start()
```

- [ ] **Step 3: Smoke test by editing fleet.yaml**

```bash
# Server running. In another terminal:
printf "\n# touched at %s\n" "$(date)" >> fleet.yaml
sleep 4
```

Watch the server log for "fleet.yaml reloaded", or watch the SSE feed:

```bash
curl -s -N --max-time 6 http://localhost/sse | grep -m1 fleet-update
```

- [ ] **Step 4: Commit**

```bash
git add plugins/lexicon/watcher.py plugins/lexicon/plugin.py
git commit -m "feat: mtime watcher hot-reloads fleet.yaml"
```

Phase 6 complete. Discovery seeds tentative entries; manual edits hot-reload.

---

## Phase 7 — Fleet inspector panel

### Task 7.1: Panel HTML and CSS scaffolding

**Files:**
- Create: `plugins/lexicon/panel.html`
- Create: `plugins/lexicon/panel.css`

- [ ] **Step 1: Write panel.html**

```html
<!-- plugins/lexicon/panel.html -->
<div class="lexicon-panel">
  <header>
    <h2>The Naming Ledger</h2>
    <input type="search" class="lexicon-search" placeholder="search by name or MAC…" />
  </header>

  <div class="lexicon-tabs">
    <button data-tab="curated" class="active">Curated</button>
    <button data-tab="tentative">Tentative</button>
    <button data-tab="retired">Retired</button>
  </div>

  <table class="lexicon-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Realm</th>
        <th>Kind</th>
        <th>Fleet ID</th>
        <th>Prior</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <div class="lexicon-empty" hidden>No entries.</div>
</div>
```

- [ ] **Step 2: Write panel.css**

```css
/* plugins/lexicon/panel.css */
.lexicon-panel {
  padding: 8px 12px;
  color: var(--realm-text, #ddd);
  font-family: var(--realm-font, system-ui, sans-serif);
}
.lexicon-panel header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.lexicon-panel h2 { margin: 0; font-size: 14px; letter-spacing: 0.5px; }
.lexicon-search { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: inherit; padding: 4px 8px; border-radius: 4px; flex: 0 0 60%; }
.lexicon-tabs { display: flex; gap: 4px; margin: 8px 0; }
.lexicon-tabs button { background: transparent; border: 1px solid rgba(255,255,255,0.15); color: inherit; padding: 2px 8px; cursor: pointer; font-size: 11px; }
.lexicon-tabs button.active { background: rgba(255,200,100,0.2); border-color: rgba(255,200,100,0.5); }
.lexicon-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.lexicon-table th, .lexicon-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: left; }
.lexicon-table th { font-weight: 600; color: rgba(255,255,255,0.7); }
.lexicon-table .fleet-id { font-family: monospace; opacity: 0.7; font-size: 10px; }
.lexicon-action-btn { background: rgba(255,200,100,0.15); border: 1px solid rgba(255,200,100,0.4); color: inherit; padding: 1px 6px; cursor: pointer; font-size: 10px; }
.lexicon-empty { text-align: center; padding: 16px; opacity: 0.5; font-style: italic; }
```

- [ ] **Step 3: Commit**

```bash
git add plugins/lexicon/panel.html plugins/lexicon/panel.css
git commit -m "feat: lexicon panel HTML/CSS scaffolding"
```

### Task 7.2: Panel JS — fetch list, render rows, SSE refresh

**Files:**
- Create: `plugins/lexicon/panel.js`

Note: this script uses DOM construction (`createElement`/`textContent`) rather than `innerHTML` to avoid the XSS surface that an `innerHTML+escapeHtml` pattern leaves open. Every cell value is set via `textContent` so untrusted catalog data can never be interpreted as HTML.

- [ ] **Step 1: Write panel.js**

```javascript
// plugins/lexicon/panel.js
(function () {
  const root = document.querySelector('.lexicon-panel');
  if (!root) return;

  const tbody = root.querySelector('.lexicon-table tbody');
  const empty = root.querySelector('.lexicon-empty');
  const search = root.querySelector('.lexicon-search');
  const tabs = root.querySelectorAll('.lexicon-tabs button');

  const state = { entries: [], status: 'curated', query: '' };

  async function fetchEntries() {
    const resp = await fetch('/fleet/list');
    const data = await resp.json();
    state.entries = data.entries || [];
    render();
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    return td;
  }

  function actionCell(entry) {
    const td = document.createElement('td');
    if (entry.status === 'tentative' || entry.status === 'curated') {
      const btn = document.createElement('button');
      btn.className = 'lexicon-action-btn';
      btn.dataset.fleetId = entry.fleet_id;
      btn.dataset.action = entry.status === 'tentative' ? 'promote' : 'rename';
      btn.textContent = entry.status === 'tentative' ? 'Promote' : 'Rename';
      td.appendChild(btn);
    }
    return td;
  }

  function priorNamesText(entry) {
    return (entry.prior_names || []).map((p) => p.name).join(', ');
  }

  function rowFor(entry) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(entry.current_name));
    tr.appendChild(cell(entry.realm));
    tr.appendChild(cell(entry.kind));
    const idTd = cell(entry.fleet_id);
    idTd.className = 'fleet-id';
    tr.appendChild(idTd);
    tr.appendChild(cell(priorNamesText(entry)));
    tr.appendChild(actionCell(entry));
    return tr;
  }

  function render() {
    const q = state.query.toLowerCase();
    const filtered = state.entries.filter((e) =>
      e.status === state.status &&
      (!q ||
        (e.current_name && e.current_name.toLowerCase().includes(q)) ||
        (e.fleet_id && e.fleet_id.toLowerCase().includes(q)) ||
        (e.prior_names || []).some((p) => (p.name || '').toLowerCase().includes(q)))
    );
    clearChildren(tbody);
    empty.hidden = filtered.length > 0;
    for (const e of filtered) {
      tbody.appendChild(rowFor(e));
    }
  }

  tbody.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const fleetId = btn.dataset.fleetId;
    const action = btn.dataset.action;
    if (action === 'rename') {
      const newName = prompt('New name?');
      if (!newName) return;
      await fetch('/fleet/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fleet_id: fleetId, new_name: newName }),
      });
      await fetchEntries();
    } else if (action === 'promote') {
      await fetch('/fleet/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fleet_id: fleetId }),
      });
      await fetchEntries();
    }
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.status = tab.dataset.tab;
      render();
    });
  });

  search.addEventListener('input', (ev) => {
    state.query = ev.target.value;
    render();
  });

  if (window.RealmAPI && window.RealmAPI.on) {
    window.RealmAPI.on('plugin-broadcast', (msg) => {
      if (msg && msg.type === 'fleet-update') fetchEntries();
    });
  }

  fetchEntries();
})();
```

- [ ] **Step 2: Open the map and click into the panel**

```bash
xdg-open http://localhost/realm-map.html
```

Open the Naming Ledger panel from the spellbook or dock. Confirm:
- Curated tab shows your migrated entries
- Tentative tab is empty until discovery runs
- Search filters
- Rename action prompts and updates the row

- [ ] **Step 3: Commit**

```bash
git add plugins/lexicon/panel.js
git commit -m "feat: lexicon panel — list, search, tabs, rename/promote actions"
```

Phase 7 complete.

---

## Phase 8 — Cleanup & verification

### Task 8.1: Update README and CLAUDE.md

**Files:**
- Modify: `README.md` (realmwatch)
- Modify: `CLAUDE.md` (realmwatch)

- [ ] **Step 1: Add a plugin entry to README's plugin catalog**

In `README.md`, find the plugin catalog section and add an entry for `lexicon` describing what it does (identity-of-record, rename/replace verbs, panel name "The Naming Ledger").

- [ ] **Step 2: Add a rule to CLAUDE.md**

Append to the `## Rules` section:

```markdown
- `fleet.yaml` is identity-of-record for all nodes — JP-specific, gitignored.
  Mutations go through `/fleet/rename`, `/fleet/replace`, `/fleet/promote`,
  or direct file edits (mtime-poll hot-reloads). topology.json/personas.json/
  realm-local.json reference nodes by `fleet_id`, not by current_name.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: lexicon plugin in plugin catalog + fleet.yaml rule"
```

### Task 8.2: Full smoke test pass + map render

- [ ] **Step 1: Run all checks**

```bash
make dev
# in another terminal:
python3 scripts/test-fleet.py
make health
```

Both should exit 0.

- [ ] **Step 2: Visual verification of the gst308t-office case**

Open `xdg-open http://localhost/realm-map.html`. Open the Naming Ledger panel. Verify:
- gst308t-office appears under Retired tab with replaced_by → east-tree-trunk
- east-tree-trunk appears under Curated tab with the new VLAN-37 metadata
- Searching "gst308t" surfaces the retired entry

- [ ] **Step 3: Tag the release**

```bash
git tag fleet-catalog-v0.1.0
```

---

## Self-Review

**Spec coverage check (against `docs/superpowers/specs/2026-05-18-lexicon-fleet-catalog-design.md`):**

- §3 Identity model (mac/fleet prefixes, lifecycle states, resolver semantics) → Tasks 1.3, 1.4, 1.5, 5.2
- §4 Schema → Tasks 1.1 (fixture), 1.3/1.4 (validator), 3.1 (migration writes schema)
- §5 Authority shift → Task 3.1 strips `label/role/realm/type/vendor` from realm.db; Task 5.1 server-side join restores them on read
- §6 Read path → Task 5.1 (topology join), 5.3 (SSE), 5.2 (endpoint resolver)
- §7 Rename verbs → Tasks 4.1 (/fleet/rename), 4.2 (/fleet/replace)
- §8 Discovery integration → Task 6.1
- §9 Migration → Tasks 3.1–3.3
- §10 Lexicon changes → Tasks 1.3–1.6
- §11 Plugin layout → Tasks 2.1, 2.4 (endpoints), 6.2 (watcher), 7.1/7.2 (panel)
- §12 SSE event additions → Tasks 4.1 (`fleet.renamed`), 4.2 (`fleet.replaced`), 4.3 (`fleet.promoted`), 6.1 (`fleet-update` for tentative), 6.2 (`fleet-update` reloaded)
- §13 Hot-reload — mtime poll → Task 6.2; explicit /fleet/reload → Task 4.3
- §14 Out-of-scope items → Honored: no HA-entity tracking, no sub_entities migration, no UI for editing prior_names history (panel is read-only on history)
- §15 Open questions → Migration staging reflected in phase order; promote stays separate from rename; fleet.yaml ordering left as-is (sorting can be added later if diff readability becomes an issue)
- §16 Test plan → Tasks 3.1 (dry-run), 3.4 (smoke script), 5.x manual map render

**Placeholder scan:** No "TBD", no "add appropriate error handling," no "similar to Task N." All steps contain runnable code or executable commands.

**Type consistency:**
- `FleetEntry`, `FleetPriorName`, `FleetCatalog`, `load_fleet_catalog` — used consistently across tasks.
- `ctx.expose_api`, `ctx.register_endpoint`, `ctx.push_event`, `ctx.on_event`, `ctx.log` — match the `PluginContext` surface verified during exploration.
- `plugin_registry.get_plugin_api(name)` is added in Task 2.3 before being consumed in Task 5.1.

**Scope check:** Single coherent feature — fleet identity catalog. No subsystems split out. Plan length reflects spec breadth but each phase ends with a working, committable state.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-lexicon-fleet-catalog.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
