"""Integrity verification for supply-chain-risky update sources.

Three-layer defense applied to npm, pipx, and mise sources (spec §
Update Integrity Verification):

- Layer 1: Reactive advisory lookup via OSV.dev after a successful
  install. Flags known-bad published versions.
- Layer 2: Proactive quarantine window that delays installing brand-new
  versions until community monitoring has had time to react.
- Layer 3: Install-script hook diff (pre-install, mechanism defense) and
  on-disk audit (post-install, metadata-divergence defense) that catches
  zero-day hook-injection supply-chain attacks.

Design constraints:
- All network calls must degrade gracefully — return empty/default on
  any exception, never propagate. Timeouts ≤5s.
- Module is standalone; no realmwatch imports. Wired into ``runner.py``
  by a follow-up pass.
- npm is the reference implementation in this pass. pipx and mise hooks
  are stubbed with graceful empties; Pass B will exercise them.
"""

import http.client
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


# ── Layer 1: Advisory check (OSV.dev) ────────────────────────────

@dataclass
class Advisory:
    """A single OSV advisory for an installed (package, version)."""
    id: str
    severity: str
    package: str
    version: str
    summary: str          # truncated to 280 chars in osv_batch_query()
    url: str


_OSV_ENDPOINT = "https://api.osv.dev/v1/querybatch"
_OSV_DETAIL = "https://api.osv.dev/v1/vulns/"
_ADVISORY_TTL = 6 * 3600

# Cache: {(name, version, ecosystem): (timestamp, [Advisory, ...])}
_advisory_cache: dict[tuple[str, str, str], tuple[float, list[Advisory]]] = {}


def osv_batch_query(
    pkgs: list[tuple[str, str]],
    ecosystem: str,
    timeout: float = 5.0,
) -> list[Advisory]:
    """Query OSV.dev for advisories on the given packages.

    Best-effort: any exception (network, parse, timeout) returns ``[]``
    rather than raising. Results are cached per (name, version, ecosystem)
    for :data:`_ADVISORY_TTL` seconds.

    Args:
        pkgs: List of ``(name, version)`` tuples.
        ecosystem: OSV ecosystem identifier — "npm", "PyPI", etc.
        timeout: Per-request timeout in seconds (≤5s).

    Returns:
        Flat list of :class:`Advisory` across all packages. Empty on any
        failure or when no advisories exist.
    """
    if not pkgs:
        return []

    now = time.time()
    results: list[Advisory] = []
    to_query: list[tuple[str, str]] = []

    # Partition by cache freshness.
    for name, ver in pkgs:
        key = (name, ver, ecosystem)
        cached = _advisory_cache.get(key)
        if cached and (now - cached[0]) < _ADVISORY_TTL:
            results.extend(cached[1])
        else:
            to_query.append((name, ver))

    if not to_query:
        return results

    body = {
        "queries": [
            {"package": {"name": n, "ecosystem": ecosystem}, "version": v}
            for (n, v) in to_query
        ]
    }

    try:
        req = urllib.request.Request(
            _OSV_ENDPOINT,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (
        urllib.error.URLError,
        http.client.HTTPException,
        TimeoutError,
        ValueError,
        OSError,
    ):
        # Network, parse, or timeout failure — best-effort, skip silently.
        # http.client.HTTPException covers IncompleteRead / RemoteDisconnected
        # which inherit from Exception, not OSError.
        return results

    batch = payload.get("results", []) if isinstance(payload, dict) else []
    # OSV returns results aligned 1:1 with the queries list.
    for (name, ver), entry in zip(to_query, batch):
        advisories: list[Advisory] = []
        vulns = (entry or {}).get("vulns", []) if isinstance(entry, dict) else []
        for v in vulns:
            if not isinstance(v, dict):
                continue
            vuln_id = v.get("id", "")
            # querybatch returns minimal entries (id + modified); fetch
            # detail best-effort for summary/severity. Failure leaves
            # placeholders so we still surface the ID.
            detail = _osv_fetch_detail(vuln_id, timeout=timeout) if vuln_id else {}
            advisories.append(
                Advisory(
                    id=vuln_id,
                    severity=_extract_severity(detail),
                    package=name,
                    version=ver,
                    summary=(detail.get("summary") or "")[:280],
                    url=f"https://osv.dev/vulnerability/{vuln_id}" if vuln_id else "",
                )
            )
        _advisory_cache[(name, ver, ecosystem)] = (now, advisories)
        results.extend(advisories)

    return results


def _osv_fetch_detail(vuln_id: str, timeout: float = 5.0) -> dict:
    """Fetch full OSV vuln detail by ID. Returns {} on any failure."""
    try:
        req = urllib.request.Request(
            _OSV_DETAIL + urllib.parse.quote(vuln_id, safe=""),
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (
        urllib.error.URLError,
        http.client.HTTPException,
        TimeoutError,
        ValueError,
        OSError,
    ):
        return {}


def _extract_severity(detail: dict) -> str:
    """Pull a human-readable severity string from an OSV detail payload."""
    if not isinstance(detail, dict):
        return ""
    sev = detail.get("severity")
    if isinstance(sev, list) and sev:
        first = sev[0]
        if isinstance(first, dict):
            return str(first.get("score") or first.get("type") or "")
    db = detail.get("database_specific") or {}
    if isinstance(db, dict):
        return str(db.get("severity") or "")
    return ""


# ── Layer 2: Quarantine ──────────────────────────────────────────

# read-only; treat as config. Values in seconds per source id.
QUARANTINE_DEFAULTS: dict[str, int] = {
    "npm": 24 * 3600,
    "pipx": 24 * 3600,
    "mise": 12 * 3600,
}


def is_quarantined(
    source_id: str,
    version: str,
    first_seen_at: dict[str, float],
) -> tuple[bool, int]:
    """Determine whether a version is still in its quarantine window.

    Args:
        source_id: Source identifier ("npm", "pipx", "mise", ...).
        version: The upstream version under consideration.
        first_seen_at: ``{version: unix_timestamp}`` map of when each
            version was first observed as available. Mutated by the
            caller — this function only reads.

    Returns:
        Tuple ``(is_quarantined, seconds_remaining)``:
        - ``(True, window_seconds)`` if the version was never seen before
          (caller should record ``first_seen_at[version] = now()``).
        - ``(True, remaining)`` if still within the window.
        - ``(False, 0)`` once the window has elapsed, or when the source
          has no quarantine configured.
    """
    window = QUARANTINE_DEFAULTS.get(source_id, 0)
    if window <= 0:
        return (False, 0)

    first_seen = first_seen_at.get(version)
    if first_seen is None:
        # Never seen — full window ahead.
        return (True, window)

    elapsed = time.time() - first_seen
    remaining = window - elapsed
    if remaining <= 0:
        return (False, 0)
    return (True, int(remaining))


# ── Layer 3: Install-script inspection ───────────────────────────

@dataclass
class ScriptChange:
    """A single hook-script change between installed and target versions."""
    package: str
    from_version: str
    to_version: str
    hook: str                # "preinstall" | "install" | "postinstall" | "prepare"
    old: str | None          # previous body (None if hook absent before)
    new: str | None          # new body (None if hook removed)
    change: str              # "added" | "removed" | "modified"


_NPM_HOOKS: tuple[str, ...] = ("preinstall", "install", "postinstall", "prepare")
_NPM_GLOBAL_PREFIX = "~/.npm-global/lib/node_modules"


def _is_safe_npm_pkg_name(pkg: str) -> bool:
    """Reject pkg names that could escape the npm global prefix.

    Allowed: plain names (``left-pad``) and scoped names (``@scope/name``)
    with exactly one ``/`` after a leading ``@`` for the scope separator.
    Rejects traversal (``..``), absolute paths, hidden dirs, empty strings,
    and anything containing NUL or backslashes.
    """
    if not pkg or not isinstance(pkg, str):
        return False
    if "\x00" in pkg or "\\" in pkg:
        return False
    if pkg.startswith("/") or pkg.startswith("."):
        return False
    # Split into segments on "/". Legitimate shapes:
    #   ["name"]            → unscoped
    #   ["@scope", "name"]  → scoped (scope must start with "@")
    parts = pkg.split("/")
    if len(parts) == 1:
        segments = parts
    elif len(parts) == 2 and parts[0].startswith("@") and len(parts[0]) > 1:
        segments = parts
    else:
        return False
    for seg in segments:
        if not seg or seg == "." or seg == "..":
            return False
    return True


def fetch_scripts_npm(pkg: str, version: str, timeout: float = 10.0) -> dict[str, str]:
    """Fetch target-version script hooks from the npm registry.

    Uses ``npm view <pkg>@<ver> scripts --json`` which reads package
    metadata without triggering install (no hook execution). Only the
    supply-chain-relevant hooks in :data:`_NPM_HOOKS` are returned.

    Returns ``{}`` on any failure (network, bad version, parse error,
    timeout). Never raises.
    """
    try:
        r = subprocess.run(
            ["npm", "view", f"{pkg}@{version}", "scripts", "--json"],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return {}

    if r.returncode != 0 or not r.stdout.strip():
        return {}

    try:
        data = json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        return {}

    if not isinstance(data, dict):
        return {}

    return {k: str(v) for k, v in data.items() if k in _NPM_HOOKS and v is not None}


def read_installed_scripts_npm(pkg: str) -> dict[str, str]:
    """Read hook scripts from an installed npm global package on disk.

    Returns ``{}`` if the package is not installed, the manifest is
    malformed, any I/O error occurs, or the package name fails the
    traversal-safety check (defends against untrusted input flowing in
    from HTTP handlers in Pass B).
    """
    if not _is_safe_npm_pkg_name(pkg):
        return {}
    path = os.path.expanduser(f"{_NPM_GLOBAL_PREFIX}/{pkg}/package.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return {}

    scripts = data.get("scripts") if isinstance(data, dict) else None
    if not isinstance(scripts, dict):
        return {}

    return {k: str(v) for k, v in scripts.items() if k in _NPM_HOOKS and v is not None}


# ── pipx / mise stubs (Pass B will exercise) ─────────────────────

def fetch_scripts_pipx(pkg: str, version: str, timeout: float = 10.0) -> dict[str, str]:
    """Stub — Pass B will implement pipx script fetch via pip download +
    pyproject.toml / [project.scripts] inspection. Returns {} for now so
    the diff pipeline short-circuits to 'no changes'."""
    del pkg, version, timeout  # unused; Pass B fills in
    return {}


def read_installed_scripts_pipx(pkg: str) -> dict[str, str]:
    """Stub — Pass B will read installed pipx venv metadata."""
    del pkg  # unused; Pass B fills in
    return {}


def fetch_scripts_mise(pkg: str, version: str, timeout: float = 10.0) -> dict[str, str]:
    """Stub — Pass B will inspect mise plugin manifests where available
    and gracefully skip where not."""
    del pkg, version, timeout  # unused; Pass B fills in
    return {}


def read_installed_scripts_mise(pkg: str) -> dict[str, str]:
    """Stub — Pass B will read installed mise shim/plugin metadata."""
    del pkg  # unused; Pass B fills in
    return {}


# ── Diff + audit ─────────────────────────────────────────────────

def diff_scripts(
    old: dict[str, str],
    new: dict[str, str],
    pkg: str,
    from_ver: str,
    to_ver: str,
) -> list[ScriptChange]:
    """Return one :class:`ScriptChange` per hook that differs.

    Comparison is whitespace-normalized (``.strip()``) so cosmetic
    formatting churn does not trigger user-facing prompts. Hook order
    independence comes for free from dict keying.

    Classification:
    - ``"added"``   — hook absent before, present now.
    - ``"removed"`` — hook present before, absent now.
    - ``"modified"`` — body changed (after normalization).
    """
    changes: list[ScriptChange] = []
    for hook in sorted(set(old) | set(new)):
        a_raw = old.get(hook)
        b_raw = new.get(hook)
        a_norm = (a_raw or "").strip()
        b_norm = (b_raw or "").strip()
        if a_norm == b_norm:
            continue
        if not a_norm:
            change = "added"
        elif not b_norm:
            change = "removed"
        else:
            change = "modified"
        changes.append(
            ScriptChange(
                package=pkg,
                from_version=from_ver,
                to_version=to_ver,
                hook=hook,
                old=a_raw,
                new=b_raw,
                change=change,
            )
        )
    return changes


def audit_installed_scripts_npm(pkg: str, approved: dict[str, str]) -> dict:
    """Post-install audit (npm): compare on-disk scripts vs the approved set.

    Re-reads the installed package's scripts and returns a report. Any
    divergence from the ``approved`` set captured at pre-install time
    indicates the installed artifact does not match the registry
    metadata that was reviewed.

    The ``_npm`` suffix matches the existing ``fetch_scripts_npm`` /
    ``read_installed_scripts_npm`` convention — Pass B will add
    ``audit_installed_scripts_pipx`` and ``audit_installed_scripts_mise``
    alongside, rather than routing every source through npm disk reads.

    Returns:
        ``{"match": bool, "divergences": [{"hook", "approved", "actual"}, ...]}``
    """
    actual = read_installed_scripts_npm(pkg)
    divergences: list[dict] = []
    for hook in sorted(set(approved) | set(actual)):
        a = (approved.get(hook) or "").strip()
        b = (actual.get(hook) or "").strip()
        if a != b:
            divergences.append(
                {
                    "hook": hook,
                    "approved": approved.get(hook),
                    "actual": actual.get(hook),
                }
            )
    return {"match": not divergences, "divergences": divergences}
