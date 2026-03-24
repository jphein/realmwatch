"""Herald plugin — manages the realm herald subprocess.

The herald daemon picks interesting nodes and generates themed speech events.
This plugin provides start/stop/status/once controls via /herald endpoint.
"""

import os
import signal
import subprocess

_MAP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_VENV_PYTHON = os.path.join(_MAP_DIR, "venv", "bin", "python3")

# Herald subprocess handle
_herald_proc = None


def _herald_start(interval=90):
    """Start the herald daemon as a subprocess."""
    global _herald_proc
    _herald_stop()
    _herald_proc = subprocess.Popen(
        [_VENV_PYTHON, "realm_herald.py", "--interval", str(interval)],
        cwd=_MAP_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return _herald_proc.pid


def _herald_stop():
    """Stop the herald daemon."""
    global _herald_proc
    if _herald_proc and _herald_proc.poll() is None:
        _herald_proc.terminate()
        try:
            _herald_proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _herald_proc.kill()
    _herald_proc = None
    # Also kill by script name
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "realm_herald.py"], text=True, timeout=3
        ).strip()
        for pid in (int(p) for p in out.split("\n") if p.strip()):
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass


def _herald_status():
    """Check herald daemon status."""
    running = _herald_proc is not None and _herald_proc.poll() is None
    pids = []
    try:
        out = subprocess.check_output(
            ["pgrep", "-f", "realm_herald.py"], text=True, timeout=3
        ).strip()
        pids = [int(p) for p in out.split("\n") if p.strip()]
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        pass
    return {"running": running or len(pids) > 0, "pids": pids}


def _herald_once():
    """Run a single herald round (blocking, returns output)."""
    try:
        out = subprocess.check_output(
            [_VENV_PYTHON, "realm_herald.py", "--once"],
            cwd=_MAP_DIR, text=True, timeout=15, stderr=subprocess.STDOUT,
        )
        return {"ok": True, "output": out}
    except subprocess.TimeoutExpired:
        return {"error": "Herald round timed out (15s)"}
    except subprocess.CalledProcessError as e:
        return {"error": f"Herald round failed: {e}"}


def handle_herald(req, params):
    """GET /herald — control the herald daemon (action=status|start|stop|once)."""
    qp = req.query_params
    action = qp.get("action", "status")
    if action == "status":
        return _herald_status()
    elif action == "start":
        interval = int(qp.get("interval", 90))
        pid = _herald_start(interval)
        return {"ok": True, "pid": pid, "interval": interval}
    elif action == "stop":
        _herald_stop()
        return {"ok": True, "stopped": True}
    elif action == "once":
        return _herald_once()
    else:
        req.respond({"error": f"Unknown action: {action}"}, 400)
        return None


def setup(ctx):
    """Plugin setup — expose herald management API."""
    ctx.expose_api({
        "start": _herald_start,
        "stop": _herald_stop,
        "status": _herald_status,
        "once": _herald_once,
    })

    ctx.log("Town Crier herald manager ready")
