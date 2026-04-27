#!/usr/bin/env python3
"""Helper invoked by the pipx UpdateSource's check_cmd.

Walks ``pipx list --json``, asks PyPI (via ``pip index versions``) for the
latest version of each pipx-installed package, prints the names of packages
where current != latest. One name per line; stdout consumed by parse_pipx.

Side note: the more "correct" approach would be to query PyPI's JSON API
directly (``GET https://pypi.org/pypi/<pkg>/json``), but ``pip index``
already handles index-url config and proxying via the user's pip
environment, so we lean on it. Each query is bounded with a 5s timeout
to keep the panel's check responsive — a flaky PyPI mirror won't hang
the whole source.
"""
import json
import subprocess
import sys


def _latest_version(name: str) -> str | None:
    try:
        r = subprocess.run(
            ["pip", "index", "versions", name],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    marker = "Available versions: "
    idx = r.stdout.find(marker)
    if idx < 0:
        return None
    return r.stdout[idx + len(marker):].split(",", 1)[0].strip()


def main() -> int:
    try:
        result = subprocess.run(
            ["pipx", "list", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return 0  # pipx unavailable → no outdated packages reported
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return 0
    for venv in data.get("venvs", {}).values():
        pkg = venv.get("metadata", {}).get("main_package", {}) or {}
        name = pkg.get("package_or_url", "")
        current = pkg.get("package_version", "")
        if not name or not current:
            continue
        latest = _latest_version(name)
        if latest and latest != current:
            print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
