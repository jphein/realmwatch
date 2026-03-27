"""Subprocess runner with lock-group serialization and live log capture."""

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


# ── Core execution ───────────────────────────────────────────────

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
    src = SOURCES[source_id]
    lock = _locks[src.lock_group]

    # Try to acquire lock, or queue
    if not lock.acquire(blocking=False):
        # Find who holds the lock
        holder = None
        for sid, s in SOURCES.items():
            if s.lock_group == src.lock_group and sid != source_id:
                from sources import _state
                if _state[sid].status in ("checking", "updating"):
                    holder = sid
                    break
        update_state(source_id, status="queued", queued_behind=holder)
        _notify()
        lock.acquire()  # block until available
        update_state(source_id, queued_behind=None)

    try:
        clear_log(source_id)
        update_state(source_id, status=mode, error=None)
        _notify()

        env = os.environ.copy()
        env["PATH"] = os.path.expanduser("~/.local/bin") + ":" + \
                       os.path.expanduser("~/.npm-global/bin") + ":" + \
                       env.get("PATH", "")

        try:
            proc = subprocess.Popen(
                cmd,
                shell=shell,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
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

    if count > 0:
        update_state(source_id,
                     status="updates-available",
                     available=count,
                     packages=packages,
                     last_check=time.time())
    else:
        update_state(source_id,
                     status="up-to-date",
                     available=0,
                     packages=[],
                     last_check=time.time())
    _notify()


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
    """Run the update command for a source."""
    src = SOURCES[source_id]
    stdout = _run_cmd(source_id, src.update_cmd, src.update_shell, src.timeout, "updating")

    if stdout is None:
        from sources import _state
        error = _state[source_id].error or "Unknown error"
        if push_event_fn:
            push_event_fn("realm-event", {
                "type": "system-update-failed",
                "text": f"{src.fantasy_name} update failed: {error}",
                "color": "red",
            })
        return

    update_state(source_id,
                 status="up-to-date",
                 available=0,
                 packages=[],
                 last_update=time.time(),
                 last_check=time.time())
    _notify()

    if push_event_fn:
        push_event_fn("realm-event", {
            "type": "system-update-complete",
            "text": f"{src.fantasy_name} — all tools warded",
            "color": "green",
        })


def run_source(source_id: str, push_event_fn=None) -> bool:
    """Start an update for one source. Returns False if source not found."""
    if source_id not in SOURCES:
        return False
    from sources import _state
    if _state[source_id].status in ("updating", "checking"):
        return False  # already running
    threading.Thread(target=_do_update, args=(source_id, push_event_fn), daemon=True).start()
    return True


def run_all(push_event_fn=None):
    """Start updates for all sources."""
    for sid in SOURCES:
        run_source(sid, push_event_fn)


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
