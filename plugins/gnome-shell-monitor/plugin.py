"""Shell Sentinel — converts gnome-shell-monitor log lines into realm events.

The producer logic in producer.py is pure (classify -> event dict). This
plugin wraps it for the realmwatch HTTP server:

  POST /plugins/gnome-shell-monitor/ingest  body {"line": "...", "node": "katana"}
    Classify a single log line; if it matches a known pattern, push a
    realm event onto the stream and return the event. The (external)
    gnome-shell-monitor systemd service should POST each interesting line
    here, e.g.:

      journalctl --user -u gnome-shell-monitor -f -o cat | \\
        while read -r line; do
          curl -s -X POST -H 'Content-Type: application/json' \\
            -d "{\\"line\\": \\"$line\\"}" \\
            http://localhost/plugins/gnome-shell-monitor/ingest >/dev/null
        done

  GET  /plugins/gnome-shell-monitor/info
    Diagnostic: returns the pattern table and configured default node.

No background thread, no periodic timer — this plugin is purely reactive
to external POSTs. The GNOME *extension* of the same name lives in
os.realm.watch/extensions/ and is unrelated.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent


def _load_sibling(name: str):
    """Load a sibling .py module under a unique sys.modules key so multiple
    plugins can each have a 'producer.py' without colliding."""
    spec_name = f"plugins.gnome_shell_monitor.{name}"
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


# Default node id for shell events — JP's desktop hostname.
# Override per-call via the "node" field in the POST body.
_DEFAULT_NODE = os.environ.get("SHELL_SENTINEL_NODE", "katana")


def setup(ctx):
    """Register ingest endpoint and info endpoint."""

    def ingest_handler(req, params):
        body = req.json() or {}
        line = (body.get("line") or "").strip()
        node = body.get("node") or _DEFAULT_NODE
        if not line:
            return req.respond({"ok": False, "error": "missing 'line' field"}, status=400)

        event = producer.build_event(line, node=node)
        if event is None:
            return req.respond({"ok": True, "matched": False, "line": line[:200]})

        stored = ctx._push_event(event)
        return req.respond({
            "ok": True,
            "matched": True,
            "event_type": event.get("shell_event_type"),
            "severity": event.get("severity"),
            "stored_id": stored.get("id") if isinstance(stored, dict) else None,
        })

    def info_handler(req, params):
        return req.respond({
            "ok": True,
            "default_node": _DEFAULT_NODE,
            "patterns": list(producer._PATTERNS.keys()),
            "event_types": [v[0] for v in producer._PATTERNS.values()],
        })

    ctx.register_endpoint("POST", "/ingest", ingest_handler)
    ctx.register_endpoint("GET", "/info", info_handler)

    # Expose classify helper so other plugins (e.g. systemd journal tailer)
    # could route lines through here without HTTP.
    ctx.expose_api({
        "classify": producer.classify_shell_event,
        "build_event": producer.build_event,
    })

    ctx.log("Shell Sentinel ready — %d patterns, default node=%s",
            len(producer._PATTERNS), _DEFAULT_NODE)
