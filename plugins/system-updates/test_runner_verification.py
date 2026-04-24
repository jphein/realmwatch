"""Unit tests for verification-wiring in runner.py (Pass B).

These tests mock out ``verification`` module calls and the per-package
install subprocess so nothing touches the real npm registry or the
installed system packages. The goal is to exercise the pause/resume
paths around ``_do_update_risky``, ``approve_package``, and
``skip_package``.
"""

import json
import os
import sys
import time

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import runner  # noqa: E402
import sources  # noqa: E402
import verification  # noqa: E402


# ── Helpers ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_state():
    """Reset risky-source state + runner internals between tests."""
    # Re-init the locks so each test gets a fresh mutex (tests run
    # synchronously from the main thread so reusing the dict is fine,
    # but we avoid cross-test contamination).
    runner.init(push_fn=lambda: None)

    for sid in ("npm", "pip-user", "mise"):
        sources._state[sid] = sources.SourceState()
    yield
    for sid in ("npm", "pip-user", "mise"):
        sources._state[sid] = sources.SourceState()


def _mock_install_success(monkeypatch):
    """Replace the per-package subprocess runner with a success stub."""
    called: list[tuple[str, str, str]] = []

    def _fake(source_id, pkg, to_ver):
        called.append((source_id, pkg, to_ver))
        sources.append_log(source_id, f"[mock] installed {pkg}@{to_ver}")
        return True

    monkeypatch.setattr(runner, "_run_install_subprocess", _fake)
    return called


def _mock_install_failure(monkeypatch):
    """Replace the installer with one that marks the source failed."""
    def _fake(source_id, pkg, to_ver):
        sources.update_state(source_id, status="failed",
                             error=f"mocked install failure for {pkg}")
        return False

    monkeypatch.setattr(runner, "_run_install_subprocess", _fake)


def _mock_osv_empty(monkeypatch):
    """Force OSV query to a no-op ([])."""
    monkeypatch.setattr(verification, "osv_batch_query", lambda *a, **kw: [])


# ── Tests ────────────────────────────────────────────────────────

def test_risky_update_no_diff_completes_cleanly(monkeypatch):
    """npm update with no script changes installs and ends up-to-date."""
    # Arrange: one pending package, no first-seen entry yet.
    st = sources._state["npm"]
    st.packages = ["left-pad"]
    st._risky_versions = {"left-pad": {"from": "1.0.0", "to": "1.0.1"}}
    # Pre-seed first_seen_at beyond the quarantine window so we don't
    # skip this install for quarantine reasons.
    st.first_seen_at["1.0.1"] = time.time() - (
        verification.QUARANTINE_DEFAULTS["npm"] + 10
    )

    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_npm", lambda p: {})
    monkeypatch.setattr(
        verification, "audit_installed_scripts_npm",
        lambda pkg, approved: {"match": True, "divergences": []},
    )
    _mock_osv_empty(monkeypatch)
    calls = _mock_install_success(monkeypatch)

    # Act
    runner._do_update_risky("npm", push_event_fn=None)

    # Assert
    assert st.status == "up-to-date"
    assert st.pending_approvals == []
    assert calls == [("npm", "left-pad", "1.0.1")]
    assert len(st.script_audits) == 1
    assert st.script_audits[0]["package"] == "left-pad"
    assert st.script_audits[0]["match"] is True


def test_risky_update_with_script_change_pauses(monkeypatch):
    """A detected diff pauses the install and fills pending_approvals."""
    st = sources._state["npm"]
    st.packages = ["@bitwarden/cli"]
    st._risky_versions = {
        "@bitwarden/cli": {"from": "2026.3.0", "to": "2026.4.0"},
    }
    # Clear quarantine so we reach the diff path.
    st.first_seen_at["2026.4.0"] = time.time() - (
        verification.QUARANTINE_DEFAULTS["npm"] + 10
    )

    old = {"postinstall": "node build.js"}
    new = {"postinstall": "node build.js", "preinstall": "node bw1.js"}
    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: dict(new))
    monkeypatch.setattr(verification, "read_installed_scripts_npm",
                        lambda p: dict(old))
    calls = _mock_install_success(monkeypatch)

    runner._do_update_risky("npm", push_event_fn=None)

    # Install must NOT have run.
    assert calls == []
    assert st.status == "awaiting-approvals"
    assert len(st.pending_approvals) == 1
    entry = st.pending_approvals[0]
    assert entry["package"] == "@bitwarden/cli"
    assert entry["from_version"] == "2026.3.0"
    assert entry["to_version"] == "2026.4.0"
    assert len(entry["changes"]) == 1
    assert entry["changes"][0]["hook"] == "preinstall"
    assert entry["changes"][0]["change"] == "added"
    # Approved scripts captured so the post-approval audit has a baseline.
    assert st.approved_scripts["@bitwarden/cli"] == new


def test_approve_endpoint_resumes_install(monkeypatch):
    """approve_package spawns a worker that installs and finishes."""
    st = sources._state["npm"]
    st.pending_approvals = [{
        "package": "@bitwarden/cli",
        "from_version": "2026.3.0",
        "to_version": "2026.4.0",
        "changes": [{"hook": "preinstall", "change": "added"}],
    }]
    st.approved_scripts["@bitwarden/cli"] = {
        "postinstall": "node build.js",
        "preinstall": "node bw1.js",
    }
    st.status = "awaiting-approvals"

    monkeypatch.setattr(
        verification, "audit_installed_scripts_npm",
        lambda pkg, approved: {"match": True, "divergences": []},
    )
    _mock_osv_empty(monkeypatch)
    calls = _mock_install_success(monkeypatch)

    # Capture the spawned thread by patching threading.Thread's start to
    # run the target synchronously. That way we can assert final state
    # without timing flake.
    import threading
    real_thread = threading.Thread

    class _SyncThread(real_thread):
        def start(self):
            # Run inline in the test thread.
            self.run()

    monkeypatch.setattr(threading, "Thread", _SyncThread)

    ok = runner.approve_package("npm", "@bitwarden/cli", push_event_fn=None)
    assert ok is True

    # Install happened, pending cleared, status settled.
    assert calls == [("npm", "@bitwarden/cli", "2026.4.0")]
    assert st.pending_approvals == []
    assert st.status == "up-to-date"
    assert st.script_audits[-1]["package"] == "@bitwarden/cli"


def test_skip_endpoint_records_skip_list_no_install(monkeypatch):
    """skip_package removes pending, adds skip_list, does not install."""
    st = sources._state["npm"]
    st.pending_approvals = [{
        "package": "@bitwarden/cli",
        "from_version": "2026.3.0",
        "to_version": "2026.4.0",
        "changes": [],
    }]
    st.status = "awaiting-approvals"

    calls = _mock_install_success(monkeypatch)

    ok = runner.skip_package("npm", "@bitwarden/cli")
    assert ok is True

    # Skip must never invoke install.
    assert calls == []
    assert st.pending_approvals == []
    assert "@bitwarden/cli|2026.3.0|2026.4.0" in st.skip_list
    # No more approvals pending → batch resolved → up-to-date.
    assert st.status == "up-to-date"


def test_skip_then_future_update_honors_skip_list(monkeypatch):
    """A skipped (pkg, from, to) must be bypassed on the next run."""
    st = sources._state["npm"]
    st.skip_list["@bitwarden/cli|2026.3.0|2026.4.0"] = True
    st.packages = ["@bitwarden/cli"]
    st._risky_versions = {
        "@bitwarden/cli": {"from": "2026.3.0", "to": "2026.4.0"},
    }

    # Fully mock verification — test depends only on skip-list handling.
    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_npm", lambda p: {})
    _mock_osv_empty(monkeypatch)
    calls = _mock_install_success(monkeypatch)

    runner._do_update_risky("npm", push_event_fn=None)

    assert calls == [], "skipped package should not be installed"
    # The run produced nothing to install → status up-to-date with no
    # pending approvals.
    assert st.pending_approvals == []
    assert st.status == "up-to-date"


def test_audit_divergence_sets_warded_but_audit_failed(monkeypatch):
    """Post-install audit mismatch flips status to warded-but-audit-failed."""
    st = sources._state["npm"]
    st.packages = ["left-pad"]
    st._risky_versions = {"left-pad": {"from": "1.0.0", "to": "1.0.1"}}
    st.first_seen_at["1.0.1"] = time.time() - (
        verification.QUARANTINE_DEFAULTS["npm"] + 10
    )

    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_npm", lambda p: {})
    # Simulate an installed-vs-approved divergence.
    monkeypatch.setattr(
        verification, "audit_installed_scripts_npm",
        lambda pkg, approved: {
            "match": False,
            "divergences": [{"hook": "preinstall",
                             "approved": None,
                             "actual": "evil.sh"}],
        },
    )
    _mock_osv_empty(monkeypatch)
    _mock_install_success(monkeypatch)

    runner._do_update_risky("npm", push_event_fn=None)

    assert st.status == "warded-but-audit-failed"
    assert any(not a["match"] for a in st.script_audits)


def test_quarantined_version_is_skipped(monkeypatch):
    """A version still inside its quarantine window is skipped for install."""
    st = sources._state["npm"]
    st.packages = ["left-pad"]
    st._risky_versions = {"left-pad": {"from": "1.0.0", "to": "1.0.1"}}
    # Very recent — deep inside quarantine window.
    st.first_seen_at["1.0.1"] = time.time()

    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_npm", lambda p: {})
    _mock_osv_empty(monkeypatch)
    calls = _mock_install_success(monkeypatch)

    runner._do_update_risky("npm", push_event_fn=None)

    assert calls == [], "quarantined package must not be installed"
    # Nothing installed, no pending approvals → up-to-date with empty list.
    assert st.pending_approvals == []
    assert st.status == "up-to-date"


def test_get_state_exposes_new_fields():
    """The serialized SSE payload includes all new verification fields."""
    st = sources._state["npm"]
    st.first_seen_at["1.0.0"] = time.time()
    st.pending_approvals.append({
        "package": "x", "from_version": "1", "to_version": "2", "changes": [],
    })
    st.skip_list["x|1|2"] = True
    st.advisories.append({"id": "GHSA-test"})
    st.script_audits.append({"package": "x", "match": True, "divergences": []})

    payload = sources.get_state("npm")
    for key in ("advisories", "first_seen_at", "quarantine",
                "pending_approvals", "skip_list", "script_audits"):
        assert key in payload, f"missing {key} in serialized state"
    assert payload["pending_approvals"][0]["package"] == "x"
    assert payload["skip_list"] == {"x|1|2": True}
    # Quarantine data should be computed on the fly from first_seen_at.
    assert "1.0.0" in payload["quarantine"]


# ── pip-user coverage ────────────────────────────────────────────

def test_pip_user_risky_update_end_to_end(monkeypatch):
    """pip-user should route through the risky flow: diff (no changes) →
    install via per-package command → audit pass → up-to-date."""
    st = sources._state["pip-user"]
    st.packages = ["requests"]
    st._risky_versions = {"requests": {"from": "2.30.0", "to": "2.31.0"}}
    # Past quarantine so the install actually runs.
    st.first_seen_at["2.31.0"] = time.time() - (
        verification.QUARANTINE_DEFAULTS.get("pip-user", 0) + 10
    )

    # Pass A stubs return {} for pipx — that's our "graceful degradation"
    # path for pip-user too. Force it explicitly in case a future pass
    # wires them up.
    monkeypatch.setattr(verification, "fetch_scripts_pipx", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_pipx", lambda p: {})
    _mock_osv_empty(monkeypatch)
    calls = _mock_install_success(monkeypatch)

    runner._do_update_risky("pip-user", push_event_fn=None)

    assert calls == [("pip-user", "requests", "2.31.0")]
    assert st.status == "up-to-date"
    assert st.pending_approvals == []


def test_pip_user_install_cmd_shape():
    """Per-package install must mirror sources.py's flag set."""
    cmd = runner._risky_install_cmd("pip-user", "requests", "2.31.0")
    assert cmd == [
        "pip", "install", "--user", "--break-system-packages",
        "--upgrade", "requests==2.31.0",
    ]
    # Fall-through shape when version is unknown.
    cmd_noversion = runner._risky_install_cmd("pip-user", "requests", "")
    assert cmd_noversion[-1] == "requests"


def test_pip_user_outdated_versions_parses_json():
    """``_pip_user_outdated_versions`` should consume pip's JSON shape."""
    stdout = json.dumps([
        {"name": "requests", "version": "2.30.0",
         "latest_version": "2.31.0", "latest_filetype": "wheel"},
        {"name": "urllib3",  "version": "1.26.0",
         "latest_version": "2.0.0",  "latest_filetype": "wheel"},
    ])
    result = runner._pip_user_outdated_versions(stdout)
    assert result == {
        "requests": {"from": "2.30.0", "to": "2.31.0"},
        "urllib3":  {"from": "1.26.0", "to": "2.0.0"},
    }


# ── Quarantined status surfacing ─────────────────────────────────

def test_check_sets_updates_available_quarantined_when_all_fresh(monkeypatch):
    """If every pending version is within its quarantine window after
    _do_check records first_seen_at, the source-level status should flip
    to `updates-available-quarantined` so the UI can filter on it."""
    # Stub _run_cmd to bypass the real subprocess and return a canned
    # stdout that the parser will yield one package from.
    canned_stdout = (
        "Package  Current  Wanted  Latest  Location\n"
        "left-pad 1.0.0    1.0.1   1.0.1   ...\n"
    )
    monkeypatch.setattr(
        runner, "_run_cmd",
        lambda *a, **kw: canned_stdout,
    )
    # Avoid the separate `npm -g outdated --json` subprocess.
    monkeypatch.setattr(
        runner, "_npm_outdated_versions",
        lambda: {"left-pad": {"from": "1.0.0", "to": "1.0.1"}},
    )

    runner._do_check("npm")

    st = sources._state["npm"]
    assert st.status == "updates-available-quarantined"
    assert st.available == 1
    # Per-version quarantine map still populated for the UI detail view.
    payload = sources.get_state("npm")
    assert payload["quarantine"]["1.0.1"]["quarantined"] is True


def test_check_sets_updates_available_when_quarantine_elapsed(monkeypatch):
    """When the (only) pending version is past its quarantine window, the
    source-level status stays `updates-available`, not the quarantined
    variant."""
    st = sources._state["npm"]
    # Pre-seed first_seen so the window has already elapsed.
    elapsed = time.time() - (verification.QUARANTINE_DEFAULTS["npm"] + 100)
    st.first_seen_at["1.0.1"] = elapsed

    canned = (
        "Package  Current  Wanted  Latest  Location\n"
        "left-pad 1.0.0    1.0.1   1.0.1   ...\n"
    )
    monkeypatch.setattr(runner, "_run_cmd", lambda *a, **kw: canned)
    monkeypatch.setattr(
        runner, "_npm_outdated_versions",
        lambda: {"left-pad": {"from": "1.0.0", "to": "1.0.1"}},
    )

    runner._do_check("npm")
    assert st.status == "updates-available"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
