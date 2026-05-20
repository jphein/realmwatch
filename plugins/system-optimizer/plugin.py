"""The Realm Optimizer — periodic system audit, surfaced as realm events.

Runs every AUDIT_INTERVAL seconds (default 300) and pushes one realm event
per finding via ctx._push_event. Dedup is handled by realm_db.push_event's
5-minute window on (node, type, text), so re-running the same check every
5 minutes is safe — only changed conditions produce new events.

Endpoints:
  GET  /plugins/system-optimizer/audit   Trigger one audit pass immediately,
                                          return the list of findings (and
                                          push each to the event stream).
  GET  /plugins/system-optimizer/info    Diagnostic — last run time, check list.

The original cron/timer behavior from os.realm.watch (manual scripts in
~/Projects/optimize/) is replaced by an in-process background thread; the
plugin owns its own cadence.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent


def _load_sibling(name: str):
    """Load a sibling .py module under a unique sys.modules key so multiple
    plugins can each have a 'producer.py' without colliding."""
    spec_name = f"plugins.system_optimizer.{name}"
    if spec_name in sys.modules:
        return sys.modules[spec_name]
    spec = importlib.util.spec_from_file_location(
        spec_name, str(_PLUGIN_DIR / f"{name}.py")
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec_name] = module
    spec.loader.exec_module(module)
    return module


producer = _load_sibling("producer")


# How often to run the full audit sweep. Default 5 minutes (matches the
# realm_db dedup window so repeated identical findings collapse cleanly).
_AUDIT_INTERVAL = int(os.environ.get("REALM_OPTIMIZER_INTERVAL", "300"))

# Node id the optimizer is auditing. Default to the host running map_server.
_NODE = os.environ.get("REALM_OPTIMIZER_NODE", producer.DEFAULT_NODE)

# Module-level state — last audit timestamp and last findings list.
_last_run_ts = 0.0
_last_findings: list[dict] = []


def _run_once(push_event_fn) -> list[dict]:
    """One audit sweep — run all checks, push every finding."""
    global _last_run_ts, _last_findings
    findings = producer.run_audit(node=_NODE)
    for finding in findings:
        try:
            push_event_fn(finding)
        except Exception as e:
            print(f"system-optimizer: push_event failed: {e}", flush=True)
    _last_findings = findings
    _last_run_ts = time.time()
    return findings


def setup(ctx):
    """Register endpoints and start the periodic audit thread."""

    def _audit_loop():
        _run_once(ctx._push_event)

    # Background thread — start_background_thread with interval handles the
    # try/except loop and sleep for us.
    ctx.start_background_thread(
        target=_audit_loop,
        interval=_AUDIT_INTERVAL,
        name="plugin-system-optimizer",
    )

    def audit_handler(req, params):
        findings = _run_once(ctx._push_event)
        return req.respond({
            "ok": True,
            "node": _NODE,
            "ts": _last_run_ts,
            "finding_count": len(findings),
            "findings": findings,
        })

    def info_handler(req, params):
        return req.respond({
            "ok": True,
            "node": _NODE,
            "interval_sec": _AUDIT_INTERVAL,
            "last_run_ts": _last_run_ts,
            "last_finding_count": len(_last_findings),
            "checks": [c.__name__ for c in producer.ALL_CHECKS],
        })

    ctx.register_endpoint("GET", "/audit", audit_handler)
    ctx.register_endpoint("GET", "/info", info_handler)

    ctx.expose_api({
        "run_audit": lambda: producer.run_audit(node=_NODE),
        "last_findings": lambda: list(_last_findings),
        "last_run_ts": lambda: _last_run_ts,
    })

    ctx.log("Realm Optimizer ready — %d checks, interval=%ds, node=%s",
            len(producer.ALL_CHECKS), _AUDIT_INTERVAL, _NODE)
