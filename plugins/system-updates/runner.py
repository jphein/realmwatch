"""Subprocess runner with lock-group serialization and live log capture.

For most sources the flow is a single subprocess captured live via
:func:`_run_cmd`. For supply-chain-risky sources (see :data:`RISKY_SOURCES`)
the update flow switches to per-package integrity verification wired
around :mod:`verification`:

1. Quarantine-check each pending version.
2. Diff registry-declared install hooks against what's installed. Any
   change pauses the install for that package and queues a
   ``pending_approval`` entry for the UI.
3. Packages with no diff (or an approval received) install one at a
   time; each install is audited against the approved hook set.
4. After the batch, OSV is queried for the installed versions.

Approval is driven by two endpoints in :mod:`plugin` (``handle_approve_one``
and ``handle_skip_one``). Approvals spawn a single-package install worker
rather than resuming a blocked thread — the source lock is therefore
never held across a user-interaction wait.
"""

import json
import os
import subprocess
import threading
import time

from sources import (
    SOURCES, PARSERS,
    update_state, append_log, clear_log,
)

# ── Lock group management ────────────────────────────────────────

_locks: dict[str, threading.Lock] = {}
_running_procs: dict[str, subprocess.Popen] = {}
_push_sse = None  # set by init()


# ── Risky sources (Layer 3 script verification) ──────────────────

# Source ids that run through the per-package verification flow. Note
# the spec talks about "pipx" conceptually, but this plugin registers
# ``pip-user`` (pip install --user) as its Python-ecosystem source,
# so that's the id we protect. The verification module still uses the
# ``fetch_scripts_pipx`` / ``read_installed_scripts_pipx`` naming since
# those hooks represent Python-sdist inspection shared between pipx and
# pip-user.
RISKY_SOURCES: set[str] = {"npm", "pip-user", "mise"}

# OSV ecosystem identifier per risky source. ``None`` means we skip the L1
# advisory lookup for that source (no OSV coverage).
OSV_ECOSYSTEMS: dict[str, str | None] = {
    "npm": "npm",
    "pip-user": "PyPI",
    "mise": None,
}


def init(push_fn):
    """Initialize the runner with a function to push SSE updates."""
    global _push_sse
    _push_sse = push_fn
    groups = set()
    for src in SOURCES.values():
        groups.add(src.lock_group)
    for g in groups:
        _locks[g] = threading.Lock()


def _notify():
    """Push current state via SSE."""
    if _push_sse:
        _push_sse()


def _event(push_event_fn, event_type, text, color):
    """Emit a realm event if the caller provided a push function."""
    if push_event_fn:
        push_event_fn("realm-event", {
            "type": event_type,
            "text": text,
            "color": color,
        })


def _env():
    """Build the subprocess environment with PATH augmented for user tools."""
    env = os.environ.copy()
    env["PATH"] = os.path.expanduser("~/.local/bin") + ":" + \
                   os.path.expanduser("~/.npm-global/bin") + ":" + \
                   "/home/linuxbrew/.linuxbrew/bin" + ":" + \
                   env.get("PATH", "")
    env.setdefault("HOMEBREW_NO_AUTO_UPDATE", "1")
    env.setdefault("HOMEBREW_NO_ENV_HINTS", "1")
    return env


# ── Core execution ───────────────────────────────────────────────

def _acquire_lock(source_id: str):
    """Acquire the source's lock group lock, queuing if busy."""
    src = SOURCES[source_id]
    lock = _locks[src.lock_group]
    if not lock.acquire(blocking=False):
        holder = None
        for sid, s in SOURCES.items():
            if s.lock_group == src.lock_group and sid != source_id:
                from sources import _state
                if _state[sid].status in ("checking", "updating"):
                    holder = sid
                    break
        update_state(source_id, status="queued", queued_behind=holder)
        _notify()
        lock.acquire()
        update_state(source_id, queued_behind=None)
    return lock


def _run_cmd(source_id: str, cmd, shell: bool, timeout: int, mode: str, ok_codes=None):
    """Execute a command for a source, capturing output line-by-line.

    Args:
        source_id: Source identifier.
        cmd: Command (list or string).
        shell: Whether to run via shell.
        timeout: Max seconds.
        mode: "checking" or "updating" — sets the status during execution.
        ok_codes: Extra exit codes to treat as success (e.g., [1] for npm outdated).

    Returns:
        stdout text on success, None on failure (state already updated).
    """
    lock = _acquire_lock(source_id)

    try:
        clear_log(source_id)
        update_state(source_id, status=mode, error=None)
        _notify()

        try:
            proc = subprocess.Popen(
                cmd,
                shell=shell,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=_env(),
                bufsize=1,
            )
        except FileNotFoundError:
            cmd_name = cmd[0] if isinstance(cmd, list) else cmd.split()[0]
            append_log(source_id, f"{cmd_name}: command not found")
            update_state(source_id, status="failed", error=f"{cmd_name} not installed")
            _notify()
            return None
        _running_procs[source_id] = proc

        deadline = time.monotonic() + timeout
        full_output = []

        for line in proc.stdout:
            line = line.rstrip("\n")
            append_log(source_id, line)
            full_output.append(line)
            _notify()

            if time.monotonic() > deadline:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                update_state(source_id, status="failed", error="Timed out")
                _notify()
                return None

        proc.wait()
        _running_procs.pop(source_id, None)

        stdout_text = "\n".join(full_output)

        allowed = {0}
        if ok_codes:
            allowed.update(ok_codes)
        if proc.returncode not in allowed:
            error_lines = full_output[-3:] if full_output else ["Unknown error"]
            error_msg = "\n".join(error_lines)
            update_state(source_id, status="failed", error=error_msg)
            _notify()
            return None

        return stdout_text

    finally:
        lock.release()


# ── Check operations ─────────────────────────────────────────────

def _do_check(source_id: str):
    """Run the check command for a source and parse results."""
    src = SOURCES[source_id]
    stdout = _run_cmd(source_id, src.check_cmd, src.check_shell, src.timeout, "checking",
                      ok_codes=src.check_ok_codes)

    if stdout is None:
        return  # already set to failed

    parser = PARSERS.get(src.parse_check_fn, PARSERS["default"])
    count, packages = parser(stdout)

    # For risky sources, also gather {pkg: (current, latest)} so the
    # quarantine tracker and pre-install diff know the target version.
    version_info: dict[str, dict[str, str]] = {}
    if source_id in RISKY_SOURCES:
        version_info = _collect_risky_versions(source_id, stdout) or {}
        # Record first-seen timestamps for any version we haven't seen
        # before. Mutates state.first_seen_at in-place.
        from sources import _state
        st = _state[source_id]
        now = time.time()
        for info in version_info.values():
            ver = info.get("to")
            if ver and ver not in st.first_seen_at:
                st.first_seen_at[ver] = now

    if count > 0:
        # For risky sources: if every pending version is still in its
        # quarantine window, surface that at the source level so the UI
        # can filter cleanly (Pass C). Per-version detail still rides in
        # the `quarantine` map inside get_state().
        status = "updates-available"
        if source_id in RISKY_SOURCES and version_info:
            import verification
            from sources import _state
            first_seen = _state[source_id].first_seen_at
            versions = [info.get("to", "") for info in version_info.values()
                        if info.get("to")]
            if versions and all(
                verification.is_quarantined(source_id, v, first_seen)[0]
                for v in versions
            ):
                status = "updates-available-quarantined"

        update_state(source_id,
                     status=status,
                     available=count,
                     packages=packages,
                     last_check=time.time())
        # Stash the version map on state so _do_update can read it without
        # re-invoking the check command.
        if source_id in RISKY_SOURCES:
            from sources import _state
            _state[source_id]._risky_versions = version_info  # type: ignore[attr-defined]
    else:
        update_state(source_id,
                     status="up-to-date",
                     available=0,
                     packages=[],
                     last_check=time.time())
    _notify()


def _collect_risky_versions(source_id: str, check_stdout: str) -> dict[str, dict[str, str]]:
    """Produce ``{pkg: {"from": current, "to": latest}}`` for risky sources.

    Uses a best-effort per-source mechanism:

    - **npm**: shells out to ``npm -g outdated --json`` (short, offline-safe).
    - **mise**: parses the already-captured ``mise outdated`` stdout.
    - **pip-user**: parses the ``pip list --user --outdated --format=json``
      stdout already captured during the check (or re-runs the command).

    Any parse/subprocess failure returns ``{}`` so the caller falls back to
    the name-only packages list without blocking the update flow.
    """
    try:
        if source_id == "npm":
            return _npm_outdated_versions()
        if source_id == "mise":
            return _mise_outdated_versions(check_stdout)
        if source_id == "pip-user":
            return _pip_user_outdated_versions(check_stdout)
    except Exception:
        return {}
    return {}


def _npm_outdated_versions() -> dict[str, dict[str, str]]:
    """Run ``npm -g outdated --json`` and parse."""
    try:
        r = subprocess.run(
            ["npm", "-g", "outdated", "--json"],
            capture_output=True, text=True, env=_env(),
            timeout=60, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {}
    if not r.stdout.strip():
        return {}
    try:
        data = json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for pkg, info in data.items():
        if not isinstance(info, dict):
            continue
        cur = str(info.get("current") or "")
        tgt = str(info.get("wanted") or info.get("latest") or "")
        if tgt:
            out[pkg] = {"from": cur, "to": tgt}
    return out


def _mise_outdated_versions(stdout: str) -> dict[str, dict[str, str]]:
    """Parse ``mise outdated`` tabular output.

    Expected layout: ``Plugin Requested Current Latest`` — space-separated.
    Robust to unexpected layouts via ``try/except`` at the call site.
    """
    out: dict[str, dict[str, str]] = {}
    lines = stdout.strip().splitlines()
    if not lines:
        return out
    for line in lines[1:]:
        parts = line.split()
        if len(parts) >= 4:
            pkg, _requested, current, latest = parts[0], parts[1], parts[2], parts[3]
            out[pkg] = {"from": current, "to": latest}
        elif len(parts) >= 2:
            # Fallback shape: just name + latest. Don't know current.
            out[parts[0]] = {"from": "", "to": parts[-1]}
    return out


def _pip_user_outdated_versions(check_stdout: str = "") -> dict[str, dict[str, str]]:
    """Parse ``pip list --user --outdated --format=json`` into version info.

    Prefers the stdout already captured by ``_do_check`` (no extra
    subprocess). If that's empty or unparseable, re-runs the command.
    """
    payload: list = []
    text = (check_stdout or "").strip()
    if text:
        try:
            data = json.loads(text)
            if isinstance(data, list):
                payload = data
        except (json.JSONDecodeError, ValueError):
            payload = []

    if not payload:
        try:
            r = subprocess.run(
                ["pip", "list", "--user", "--outdated", "--format=json"],
                capture_output=True, text=True, env=_env(),
                timeout=60, check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return {}
        if r.stdout.strip():
            try:
                data = json.loads(r.stdout)
                if isinstance(data, list):
                    payload = data
            except (json.JSONDecodeError, ValueError):
                return {}

    out: dict[str, dict[str, str]] = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not name:
            continue
        cur = str(item.get("version") or "")
        tgt = str(item.get("latest_version") or "")
        if tgt:
            out[name] = {"from": cur, "to": tgt}
    return out


def check_source(source_id: str) -> bool:
    """Start a check for one source. Returns False if source not found."""
    if source_id not in SOURCES:
        return False
    threading.Thread(target=_do_check, args=(source_id,), daemon=True).start()
    return True


def check_all():
    """Start checks for all sources."""
    for sid in SOURCES:
        check_source(sid)


# ── Update operations ────────────────────────────────────────────

def _do_update(source_id: str, push_event_fn=None):
    """Run the update command for a source.

    Risky sources take a per-package path that layers in quarantine,
    script-diff approvals, post-install audits, and OSV queries. All
    other sources keep the existing single-subprocess flow untouched.
    """
    if source_id in RISKY_SOURCES:
        return _do_update_risky(source_id, push_event_fn)

    src = SOURCES[source_id]
    stdout = _run_cmd(source_id, src.update_cmd, src.update_shell, src.timeout, "updating",
                      ok_codes=src.update_ok_codes)

    if stdout is None:
        from sources import _state
        error = _state[source_id].error or "Unknown error"
        _event(push_event_fn, "system-update-failed",
               f"{src.fantasy_name} update failed: {error}", "red")
        return

    update_state(source_id,
                 status="up-to-date",
                 available=0,
                 packages=[],
                 last_update=time.time(),
                 last_check=time.time())
    _notify()

    _event(push_event_fn, "system-update-complete",
           f"{src.fantasy_name} — all tools warded", "green")


# ── Risky-source update flow ─────────────────────────────────────

def _skip_key(pkg: str, from_ver: str, to_ver: str) -> str:
    """Composite key for the per-session skip list."""
    return f"{pkg}|{from_ver}|{to_ver}"


def _risky_install_cmd(source_id: str, pkg: str, to_ver: str) -> list[str]:
    """Build a per-package install command for a risky source.

    For pip-user, mirrors the flags from ``sources.py``'s existing
    ``update_cmd`` — ``--user --break-system-packages --upgrade`` — so
    the per-package path behaves the same as the batch path on Ubuntu
    24.04 (PEP 668 marks /usr/bin/python3 as externally managed).

    Raises ``ValueError`` if ``to_ver`` is empty — installing without a
    pinned version would bypass both the quarantine window and the script
    diff that was done against the specific version (I2).
    """
    if not to_ver:
        raise ValueError(f"Cannot install {pkg}: target version unknown")
    if source_id == "npm":
        return ["npm", "install", "-g", f"{pkg}@{to_ver}"]
    if source_id == "mise":
        return ["mise", "upgrade", f"{pkg}@{to_ver}"]
    if source_id == "pip-user":
        return ["pip", "install", "--user", "--break-system-packages",
                "--upgrade", f"{pkg}=={to_ver}"]
    raise ValueError(f"Not a risky source: {source_id}")


def _do_update_risky(source_id: str, push_event_fn=None):
    """Per-package update loop for supply-chain-risky sources.

    Lock is held while we enumerate + install the non-diff packages;
    released once we either finish or transition into the "awaiting
    approvals" state. Approvals are driven by a separate worker
    (``_install_after_approval``) so nobody holds the lock across a
    user-interaction wait.
    """
    import verification

    src = SOURCES[source_id]
    lock = _acquire_lock(source_id)

    try:
        clear_log(source_id)
        update_state(source_id, status="updating", error=None)
        from sources import _state
        st = _state[source_id]
        # Fresh run — clear stale pending approvals / advisories but keep
        # skip_list (persists for the session).
        with st._approval_lock:
            st.pending_approvals = []
        st.advisories = []
        _notify()

        # Figure out which packages are pending and their target versions.
        versions: dict[str, dict[str, str]] = getattr(st, "_risky_versions", {}) or {}
        if not versions:
            # Lazy re-collect — _do_check may not have populated.
            versions = _collect_risky_versions(source_id, "") or {}
        # Fall back to name-only entries for packages we couldn't resolve.
        for pkg in st.packages:
            versions.setdefault(pkg, {"from": "", "to": ""})

        now = time.time()
        # Record first-seen so quarantine tracking stays consistent even
        # when the update was triggered without a prior check.
        for info in versions.values():
            ver = info.get("to")
            if ver and ver not in st.first_seen_at:
                st.first_seen_at[ver] = now

        # Partition candidates.
        skipped_quarantine: list[str] = []
        pending_diff: list[tuple[str, str, str, list]] = []  # pkg, from, to, changes
        ready_to_install: list[tuple[str, str, str]] = []    # pkg, from, to

        for pkg, info in versions.items():
            from_ver = info.get("from", "") or ""
            to_ver = info.get("to", "") or ""

            if _skip_key(pkg, from_ver, to_ver) in st.skip_list:
                append_log(source_id, f"{pkg}: skipped by skip_list")
                _notify()
                continue

            quar, remaining = verification.is_quarantined(
                source_id, to_ver, st.first_seen_at
            )
            if quar and to_ver:
                append_log(source_id,
                           f"{pkg}: quarantined — skipping ({remaining}s remaining)")
                skipped_quarantine.append(pkg)
                _notify()
                continue

            # Layer 3A pre-install diff.
            new_scripts = _fetch_scripts(source_id, pkg, to_ver)
            old_scripts = _read_installed_scripts(source_id, pkg)
            changes = verification.diff_scripts(
                old_scripts, new_scripts, pkg, from_ver, to_ver
            )
            if changes:
                pending_diff.append((pkg, from_ver, to_ver, changes))
                # Record the proposed script set so approval captures it.
                st.approved_scripts.setdefault(pkg, dict(new_scripts))
            else:
                # No changes → capture the empty-or-equal hook set as approved
                # so the post-install audit has a baseline to compare against.
                st.approved_scripts[pkg] = dict(new_scripts)
                ready_to_install.append((pkg, from_ver, to_ver))

        # Populate pending_approvals entries for UI.
        with st._approval_lock:
            for pkg, from_ver, to_ver, changes in pending_diff:
                st.pending_approvals.append({
                    "package": pkg,
                    "from_version": from_ver,
                    "to_version": to_ver,
                    "changes": [_script_change_dict(c) for c in changes],
                })
            has_pending = bool(st.pending_approvals)
        _notify()

        # Install the diff-free packages right now under the held lock.
        installed_versions: list[tuple[str, str]] = []
        for pkg, from_ver, to_ver in ready_to_install:
            ok = _install_one_locked(source_id, pkg, to_ver, push_event_fn)
            if not ok:
                # Install failed or audit tripped — stop this batch.
                return
            installed_versions.append((pkg, to_ver))

        # If any packages are awaiting approval, transition into
        # "awaiting-approvals" and return. Approval/skip endpoints drive
        # the next phase.
        if has_pending:
            update_state(source_id, status="awaiting-approvals")
            _notify()
            return

        _finish_risky(source_id, installed_versions, push_event_fn)

    finally:
        try:
            lock.release()
        except RuntimeError:
            pass


def _script_change_dict(change) -> dict:
    """Serialize a ScriptChange dataclass to a dict for SSE payloads."""
    return {
        "package": change.package,
        "from_version": change.from_version,
        "to_version": change.to_version,
        "hook": change.hook,
        "old": change.old,
        "new": change.new,
        "change": change.change,
    }


def _fetch_scripts(source_id: str, pkg: str, version: str) -> dict[str, str]:
    """Dispatch to the verification module's registry-metadata fetch.

    Note: the ``pip-user`` branch calls ``fetch_scripts_pipx`` — the
    verification module uses the pipx naming for its Python-sdist
    inspection, which is the right shape for both pipx (future) and
    pip-user (today). The function is a stub in Pass A, so pip-user
    sees an empty script set → "no changes" → proceed to install.
    That's the graceful-degradation contract the spec calls for.
    """
    import verification
    if source_id == "npm":
        return verification.fetch_scripts_npm(pkg, version)
    if source_id == "pip-user":
        return verification.fetch_scripts_pipx(pkg, version)
    if source_id == "mise":
        return verification.fetch_scripts_mise(pkg, version)
    return {}


def _read_installed_scripts(source_id: str, pkg: str) -> dict[str, str]:
    import verification
    if source_id == "npm":
        return verification.read_installed_scripts_npm(pkg)
    if source_id == "pip-user":
        return verification.read_installed_scripts_pipx(pkg)
    if source_id == "mise":
        return verification.read_installed_scripts_mise(pkg)
    return {}


def _audit_installed(source_id: str, pkg: str, approved: dict[str, str]) -> dict:
    """Post-install audit dispatch for risky sources.

    Only npm has an implemented audit in Pass A. pip-user and mise fall
    through to a passing result until ``audit_installed_scripts_pipx``
    and ``audit_installed_scripts_mise`` land in a future pass.
    """
    import verification
    if source_id == "npm":
        return verification.audit_installed_scripts_npm(pkg, approved)
    # pip-user / mise audits not yet implemented — treat as passing.
    return {"match": True, "divergences": []}


def _run_install_subprocess(source_id: str, pkg: str, to_ver: str) -> bool:
    """Run the per-package install command, streaming output to the log."""
    src = SOURCES[source_id]
    try:
        cmd = _risky_install_cmd(source_id, pkg, to_ver)
    except ValueError as exc:
        append_log(source_id, f"[error] {exc}")
        update_state(source_id, status="failed", error=str(exc))
        _notify()
        return False
    append_log(source_id, f"$ {' '.join(cmd)}")
    _notify()

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=_env(),
            bufsize=1,
        )
    except FileNotFoundError:
        append_log(source_id, f"{cmd[0]}: command not found")
        update_state(source_id, status="failed", error=f"{cmd[0]} not installed")
        _notify()
        return False

    _running_procs[source_id] = proc
    deadline = time.monotonic() + src.timeout
    for line in proc.stdout:
        line = line.rstrip("\n")
        append_log(source_id, line)
        _notify()
        if time.monotonic() > deadline:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            update_state(source_id, status="failed",
                         error=f"Timed out installing {pkg}")
            _notify()
            return False
    proc.wait()
    _running_procs.pop(source_id, None)

    allowed = {0}
    if src.update_ok_codes:
        allowed.update(src.update_ok_codes)
    if proc.returncode not in allowed:
        update_state(source_id, status="failed",
                     error=f"{pkg}: install exit code {proc.returncode}")
        _notify()
        return False
    return True


def _install_one_locked(source_id: str, pkg: str, to_ver: str, push_event_fn) -> bool:
    """Install one package (assumes caller holds the source lock).

    Returns ``True`` on success (install + audit pass), ``False`` on
    failure — which has already marked the source as ``failed``.
    """
    from sources import _state
    st = _state[source_id]
    approved = st.approved_scripts.get(pkg, {})

    if not _run_install_subprocess(source_id, pkg, to_ver):
        _event(push_event_fn, "system-update-failed",
               f"{SOURCES[source_id].fantasy_name} — {pkg} install failed",
               "red")
        return False

    # Post-install audit (L3B).
    audit = _audit_installed(source_id, pkg, approved)
    st.script_audits.append({
        "package": pkg,
        "version": to_ver,
        "match": bool(audit.get("match", True)),
        "divergences": list(audit.get("divergences", [])),
        "ts": time.time(),
    })
    if not audit.get("match", True):
        update_state(source_id, status="warded-but-audit-failed",
                     error=f"{pkg}: installed scripts diverge from approved")
        _notify()
        _event(push_event_fn, "system-update-audit-failed",
               f"{SOURCES[source_id].fantasy_name} — {pkg} audit failed",
               "red")
        return False
    return True


def _finish_risky(source_id: str, installed: list[tuple[str, str]], push_event_fn):
    """Run the post-install OSV query and mark the source done.

    ``installed`` is a list of ``(pkg, version)`` pairs we successfully
    upgraded in this run. The OSV query is best-effort; failures leave
    advisories empty.
    """
    import verification

    from sources import _state
    st = _state[source_id]
    ecosystem = OSV_ECOSYSTEMS.get(source_id)
    advisories: list = []
    if ecosystem and installed:
        try:
            adv_objs = verification.osv_batch_query(installed, ecosystem)
            advisories = [
                {
                    "id": a.id,
                    "severity": a.severity,
                    "package": a.package,
                    "version": a.version,
                    "summary": a.summary,
                    "url": a.url,
                }
                for a in adv_objs
            ]
        except Exception:
            advisories = []
    st.advisories = advisories

    if advisories:
        status = "warded-but-advised"
    else:
        status = "up-to-date"

    update_state(
        source_id,
        status=status,
        available=0,
        packages=[],
        last_update=time.time(),
        last_check=time.time(),
    )
    _notify()

    fantasy = SOURCES[source_id].fantasy_name
    if advisories:
        _event(push_event_fn, "system-update-advised",
               f"{fantasy} — warded but {len(advisories)} advisories",
               "amber")
    else:
        _event(push_event_fn, "system-update-complete",
               f"{fantasy} — all tools warded", "green")


def run_source(source_id: str, push_event_fn=None) -> bool:
    """Start an update for one source. Returns False if source not found."""
    if source_id not in SOURCES:
        return False
    from sources import _state
    if _state[source_id].status in ("updating", "checking", "awaiting-approvals", "queued"):
        return False  # already running or awaiting user decision
    threading.Thread(target=_do_update, args=(source_id, push_event_fn), daemon=True).start()
    return True


def run_all(push_event_fn=None):
    """Start updates for all sources."""
    for sid in SOURCES:
        run_source(sid, push_event_fn)


# ── Approval endpoints (driven by plugin.py handlers) ────────────

def approve_package(source_id: str, pkg: str, push_event_fn=None) -> bool:
    """User approved the pending script diff for ``pkg``. Install it.

    Returns False if the source/pkg doesn't have a pending approval
    entry. Spawns a worker thread that acquires the lock, runs the
    single-package install + audit, and (when no more approvals remain)
    finishes the batch with the OSV query.
    """
    if source_id not in SOURCES:
        return False
    from sources import _state
    st = _state[source_id]
    entry = _pop_pending_approval(st, pkg)
    if not entry:
        return False
    threading.Thread(
        target=_install_after_approval,
        args=(source_id, entry, push_event_fn),
        daemon=True,
    ).start()
    return True


def skip_package(source_id: str, pkg: str) -> bool:
    """User skipped the pending approval for ``pkg``.

    Adds the ``(pkg, from, to)`` triple to ``skip_list`` so future runs
    bypass it, drops the pending entry, and updates status if the batch
    is now fully resolved.
    """
    if source_id not in SOURCES:
        return False
    from sources import _state
    st = _state[source_id]
    entry = _pop_pending_approval(st, pkg)
    if not entry:
        return False
    key = _skip_key(entry["package"], entry.get("from_version", ""),
                    entry.get("to_version", ""))
    st.skip_list[key] = True

    if not st.pending_approvals and st.status == "awaiting-approvals":
        # Nothing left — batch is resolved.
        update_state(source_id, status="up-to-date",
                     last_update=time.time(), last_check=time.time())
    _notify()
    return True


def _pop_pending_approval(st, pkg: str) -> dict | None:
    """Remove and return the pending_approvals entry for pkg (or None).

    Acquires ``st._approval_lock`` to prevent concurrent iterate+pop races
    between approve_package / skip_package and _do_update_risky.
    """
    with st._approval_lock:
        for i, entry in enumerate(st.pending_approvals):
            if entry.get("package") == pkg:
                return st.pending_approvals.pop(i)
    return None


def _install_after_approval(source_id: str, entry: dict, push_event_fn):
    """Worker: install a single approved package, then maybe finalize."""
    lock = _acquire_lock(source_id)
    try:
        update_state(source_id, status="updating", error=None)
        _notify()
        pkg = entry["package"]
        to_ver = entry.get("to_version", "")

        try:
            ok = _install_one_locked(source_id, pkg, to_ver, push_event_fn)
            if not ok:
                # status may already be "failed" from cancel_source (SIGTERM) or from
                # _run_install_subprocess (non-zero exit / timeout). Either way, the
                # specific error set by the earlier path is more useful than a generic
                # fallback — don't overwrite it.
                from sources import _state
                if _state[source_id].status != "failed":
                    update_state(source_id, status="failed",
                                 error=f"Install of {pkg} failed")
                    _notify()
                return

            from sources import _state
            st = _state[source_id]
            installed = [(pkg, to_ver)]

            if not st.pending_approvals:
                _finish_risky(source_id, installed, push_event_fn)
            else:
                # Still more awaiting approval — stay in that status.
                update_state(source_id, status="awaiting-approvals")
                _notify()
        except Exception as exc:
            # C2: unhandled crash — mark failed so the source doesn't strand
            # in "updating" or "awaiting-approvals" forever.
            update_state(source_id, status="failed",
                         error=f"Install worker crashed: {exc}")
            _notify()
    finally:
        try:
            lock.release()
        except RuntimeError:
            pass


# ── Cancel ───────────────────────────────────────────────────────

def cancel_source(source_id: str) -> bool:
    """Cancel a running source by sending SIGTERM."""
    proc = _running_procs.get(source_id)
    if proc and proc.poll() is None:
        proc.terminate()
        update_state(source_id, status="failed", error="Cancelled by user")
        _notify()
        return True
    return False
