"""Shell Sentinel — GNOME Shell log classifier.

Migrated from os.realm.watch/servers/plugins/gnome_shell_monitor.py 2026-05-19.

Parses output from the (external) gnome-shell-monitor systemd service and
converts health events into realm event payloads. Extension crashes appear as
structural instabilities, fixes appear as ward repairs.

Pure parsing — no I/O. The plugin wraps these helpers and decides whether
to push the result onto the realm event stream.
"""
from __future__ import annotations

import re

# (regex pattern) -> (event_type, severity 1..5, human description)
_PATTERNS: dict[str, tuple[str, int, str]] = {
    r"extension.*crash": ("shell_extension_crash", 4, "Extension crash detected"),
    r"js error|javascript error": ("shell_js_error", 3, "JavaScript error in GNOME Shell"),
    r"segfault|segmentation fault": ("shell_segfault", 5, "GNOME Shell segmentation fault"),
    r"disposed|GC callback": ("shell_gc_error", 2, "Disposed object access in GNOME Shell"),
    r"compositor.*ping.*failed": ("shell_compositor_hang", 4, "Compositor not responding"),
    r"recovered|self-healed|fixed": ("shell_recovered", 1, "GNOME Shell self-healed"),
}


def classify_shell_event(log_line: str) -> tuple[str, int, str] | None:
    """Classify a gnome-shell-monitor log line.

    Returns (event_type, severity, description) or None if the line does
    not match any known pattern.
    """
    if not log_line:
        return None
    lower = log_line.lower()
    for pattern, result in _PATTERNS.items():
        if re.search(pattern, lower):
            return result
    return None


# Fantasy-themed event text per shell event type. The original os.realm.watch
# producer stored only the technical description; the realmwatch plugin layers
# realm flavor on top so quest-log / herald can speak it naturally.
_FANTASY_TEXT: dict[str, str] = {
    "shell_extension_crash": "An arcane charm has shattered in the Watcher's sanctum",
    "shell_js_error": "Runes flicker uneasily across the Watcher's mirror",
    "shell_segfault": "The Watcher's sanctum has collapsed into the void!",
    "shell_gc_error": "Phantom hands grasp at vanished memories in the sanctum",
    "shell_compositor_hang": "The compositor's heartbeat has fallen silent",
    "shell_recovered": "The Watcher's sanctum has mended itself",
}

# Severity 1..5 -> realm event color hint
_SEVERITY_COLOR: dict[int, str] = {
    1: "#80ff80",  # green — recovery
    2: "#a0c0ff",  # blue — minor anomaly
    3: "#ffaa00",  # amber — error
    4: "#ff8040",  # orange — major instability
    5: "#ff4040",  # red — segfault / catastrophic
}


def build_event(log_line: str, node: str = "katana") -> dict | None:
    """Build a realm-event-shaped dict from a log line, or None.

    Args:
        log_line: A single log line from the gnome-shell-monitor service.
        node: Node id whose persona should host the event. The shell runs
              on JP's desktop ("katana") so that's the sensible default.

    Returns:
        Dict suitable for ctx._push_event(...) or None if the line is not
        a recognised event.
    """
    classified = classify_shell_event(log_line)
    if not classified:
        return None
    event_type, severity, description = classified
    fantasy = _FANTASY_TEXT.get(event_type, description)
    return {
        "type": "alert" if severity >= 4 else "speech",
        "node": node,
        "text": fantasy,
        "color": _SEVERITY_COLOR.get(severity, "#ffaa00"),
        "shell_event_type": event_type,
        "severity": severity,
        "description": description,
        "raw_log": log_line[:256],
        "source": "gnome-shell-monitor",
    }
