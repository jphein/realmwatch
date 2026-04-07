"""Desktop notification adapter — uses notify-send."""

import logging
import subprocess
from . import ChannelAdapter

log = logging.getLogger(__name__)


class DesktopAdapter(ChannelAdapter):
    name = "desktop"
    display_name = "Desktop Notifications"
    config_fields = [
        {"key": "urgency", "label": "Urgency", "type": "select", "default": "normal",
         "options": ["low", "normal", "critical"]},
        {"key": "icon", "label": "Icon", "type": "text", "default": "dialog-warning"},
    ]

    def send(self, event, severity, config=None):
        cfg = config or self._config
        urgency = cfg.get("urgency", "normal")
        icon = cfg.get("icon", "dialog-warning")

        # Map severity to urgency if not overridden
        if severity == "critical":
            urgency = "critical"

        title = f"RealmWatch [{severity.upper()}]"
        body = event.get("text", "Unknown event")
        node = event.get("node", "")
        if node:
            body = f"[{node}] {body}"

        try:
            subprocess.run(
                ["notify-send", "-u", urgency, "-i", icon, title, body],
                capture_output=True, timeout=5
            )
            return True, None
        except FileNotFoundError:
            return False, "notify-send not found"
        except subprocess.TimeoutExpired:
            return False, "notify-send timed out"
        except Exception as e:
            return False, str(e)
