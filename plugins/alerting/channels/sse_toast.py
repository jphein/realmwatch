"""SSE toast adapter — pushes toast events to browser via SSE."""

import logging
import time
from . import ChannelAdapter

log = logging.getLogger(__name__)

# Set by plugin.py during setup
_push_event_fn = None


def set_push_event(fn):
    global _push_event_fn
    _push_event_fn = fn


class SSEToastAdapter(ChannelAdapter):
    name = "sse_toast"
    display_name = "Browser Toast"
    config_fields = [
        {"key": "duration", "label": "Duration (seconds)", "type": "number", "default": 8},
        {"key": "position", "label": "Position", "type": "select", "default": "top-right",
         "options": ["top-right", "top-left", "bottom-right", "bottom-left"]},
    ]

    def send(self, event, severity, config=None):
        if not _push_event_fn:
            return False, "SSE push function not configured"

        cfg = config or self._config
        duration = cfg.get("duration", 8)
        position = cfg.get("position", "top-right")

        toast_event = {
            "type": "toast",
            "text": event.get("text", ""),
            "node": event.get("node", ""),
            "severity": severity,
            "color": event.get("color", ""),
            "duration": duration,
            "position": position,
            "ts": time.time(),
        }

        try:
            _push_event_fn(toast_event)
            return True, None
        except Exception as e:
            return False, str(e)
