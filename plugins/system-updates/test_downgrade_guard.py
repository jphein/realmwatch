"""Regression tests for the downgrade guard (2026-08-12 incident).

``npm -g outdated`` compares installed versions against the registry and
is blind to npm-link: a local fork published under the upstream package
name that is *ahead* of the registry shows up with wanted < current.
Treating that row as an update "upgraded" @karpeleslab/teamclaude
1.4.2 -> 1.1.12 — a silent downgrade that replaced the linked fork with
the registry package. The invariant under test: a downgrade is never
counted, surfaced, or installed.
"""

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


# Real `npm -g outdated` output captured on katana 2026-08-12: the
# teamclaude row is the linked fork (1.4.2 installed, registry 1.1.12).
NPM_OUTDATED_TABLE = """\
Package                  Current   Wanted   Latest  Location                              Depended by
@kaitranntt/ccs            8.8.1    8.9.0    8.9.0  node_modules/@kaitranntt/ccs          global
@karpeleslab/teamclaude    1.4.2   1.1.12   1.1.12  node_modules/@karpeleslab/teamclaude  global
pnpm                      11.3.0  11.21.0  11.21.0  node_modules/pnpm                     global
"""


@pytest.fixture(autouse=True)
def _clean_state():
    """Reset risky-source state + runner internals between tests."""
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


# ── is_downgrade helper ──────────────────────────────────────────

def test_is_downgrade_true_when_target_older():
    assert sources.is_downgrade("1.4.2", "1.1.12") is True


def test_is_downgrade_false_for_upgrade_equal_or_unknown():
    assert sources.is_downgrade("1.1.12", "1.4.2") is False   # upgrade
    assert sources.is_downgrade("1.4.2", "1.4.2") is False    # equal
    assert sources.is_downgrade("", "1.0.0") is False         # unknown current
    assert sources.is_downgrade("1.0.0", "") is False         # unknown target
    assert sources.is_downgrade("linked", "1.0.0") is False   # unparseable fails open


# ── parse_npm: check-time filtering ──────────────────────────────

def test_parse_npm_skips_downgrade_rows():
    count, packages = sources.parse_npm(NPM_OUTDATED_TABLE)
    assert "@karpeleslab/teamclaude" not in packages
    assert packages == ["@kaitranntt/ccs", "pnpm"]
    assert count == 2


# ── _do_update_risky: install-time guard ─────────────────────────

def test_risky_update_blocks_downgrade(monkeypatch):
    """A downgrade entry is skipped with a log line; upgrades proceed."""
    st = sources._state["npm"]
    st.packages = ["left-pad", "@karpeleslab/teamclaude"]
    st._risky_versions = {
        "left-pad": {"from": "1.0.0", "to": "1.0.1"},
        "@karpeleslab/teamclaude": {"from": "1.4.2", "to": "1.1.12"},
    }
    past = time.time() - (verification.QUARANTINE_DEFAULTS["npm"] + 10)
    st.first_seen_at["1.0.1"] = past
    st.first_seen_at["1.1.12"] = past

    monkeypatch.setattr(verification, "fetch_scripts_npm", lambda p, v: {})
    monkeypatch.setattr(verification, "read_installed_scripts_npm", lambda p: {})
    monkeypatch.setattr(
        verification, "audit_installed_scripts_npm",
        lambda pkg, approved: {"match": True, "divergences": []},
    )
    monkeypatch.setattr(verification, "osv_batch_query", lambda *a, **kw: [])
    calls = _mock_install_success(monkeypatch)

    runner._do_update_risky("npm", push_event_fn=None)

    assert calls == [("npm", "left-pad", "1.0.1")]
    assert st.status == "up-to-date"
    assert st.pending_approvals == []
    assert any("downgrade" in line.lower() for line in st.log_lines)
