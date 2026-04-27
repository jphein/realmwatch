"""Tests for v1.1.0 additions: /api/inventory endpoint + pipx-as-source.

Locks in:
- pipx is registered as a 12th UpdateSource with the right metadata.
- parse_pipx handles the helper's "one outdated name per line" output
  including blanks and trailing whitespace.
- get_inventory returns the slim shape (no log_lines, no quarantine, no
  pending_approvals) — that's the whole reason the endpoint exists.
- ?since= filter is exclusive on the boundary (last_check must be strictly
  greater) so callers can pass their own last seen timestamp without
  double-counting.
- pipx's check_cmd points at an executable helper script in the plugin dir.
"""

import os
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import sources  # noqa: E402


# ── pipx registration ────────────────────────────────────────────

def test_pipx_registered_with_expected_metadata():
    src = sources.SOURCES.get("pipx")
    assert src is not None, "pipx not registered in SOURCES"
    assert src.fantasy_name == "Pipx Phylacteries"
    assert src.icon == "\U0001f9ff"
    assert src.lock_group == "pipx"
    assert src.parse_check_fn == "pipx"


def test_pipx_check_cmd_helper_script_exists_and_is_executable():
    src = sources.SOURCES["pipx"]
    assert isinstance(src.check_cmd, list)
    assert src.check_cmd[0] == "python3"
    helper = src.check_cmd[1]
    assert os.path.isfile(helper), f"helper missing: {helper}"
    assert os.access(helper, os.R_OK)


def test_pipx_update_cmd_uses_upgrade_all():
    """``pipx upgrade-all`` is the whole point — single command beats
    pip-user's per-package iteration."""
    src = sources.SOURCES["pipx"]
    assert src.update_cmd == ["pipx", "upgrade-all"]


def test_total_source_count_is_12():
    assert len(sources.SOURCES) == 12


# ── parse_pipx ───────────────────────────────────────────────────

def test_parse_pipx_basic():
    n, names = sources.parse_pipx("aider-chat\nhomemate-bridge\n")
    assert n == 2
    assert names == ["aider-chat", "homemate-bridge"]


def test_parse_pipx_empty_no_outdated():
    n, names = sources.parse_pipx("")
    assert n == 0
    assert names == []


def test_parse_pipx_strips_whitespace_and_blanks():
    n, names = sources.parse_pipx("  aider-chat  \n\n  black\n")
    assert names == ["aider-chat", "black"]


def test_parse_pipx_registered_in_PARSERS():
    assert sources.PARSERS["pipx"] is sources.parse_pipx


# ── get_inventory shape ──────────────────────────────────────────

def test_get_inventory_returns_slim_shape():
    inv = sources.get_inventory()
    assert "sources" in inv and "since" in inv
    # Pick any source and confirm the slim shape — no fat fields.
    sample = next(iter(inv["sources"].values()))
    assert set(sample.keys()) == {
        "fantasy_name",
        "outdated",
        "available_count",
        "last_check",
        "status",
    }
    # Specifically NOT in the response (the whole reason for the slim shape):
    assert "log_lines" not in sample
    assert "quarantine" not in sample
    assert "pending_approvals" not in sample
    assert "advisories" not in sample


def test_get_inventory_includes_all_12_sources_when_unfiltered():
    inv = sources.get_inventory(since=0)
    assert len(inv["sources"]) == 12


def test_get_inventory_since_filter_strict():
    """``since`` is strictly-greater so passing your own last_check doesn't
    re-include the sources you already saw."""
    # Set one source's last_check to a known value.
    sources.update_state("apt", last_check=1000.0)
    sources.update_state("snap", last_check=2000.0)
    inv = sources.get_inventory(since=1000.0)
    # apt at 1000.0 should be excluded (not strictly > since).
    assert "apt" not in inv["sources"]
    # snap at 2000.0 should be included.
    assert "snap" in inv["sources"]


def test_get_inventory_since_field_echoed():
    inv = sources.get_inventory(since=42.0)
    assert inv["since"] == 42.0
