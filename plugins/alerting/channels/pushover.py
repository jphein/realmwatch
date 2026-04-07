"""Pushover adapter — sends push notifications via Pushover API."""

import logging
from . import ChannelAdapter

log = logging.getLogger(__name__)

PUSHOVER_API = "https://api.pushover.net/1/messages.json"

# Map severity to Pushover priority (-2 to 2)
PRIORITY_MAP = {
    "critical": 1,   # high priority
    "warning": 0,    # normal
    "info": -1,      # low
}


class PushoverAdapter(ChannelAdapter):
    name = "pushover"
    display_name = "Pushover"
    config_fields = [
        {"key": "user_key", "label": "User Key", "type": "text", "default": ""},
        {"key": "app_token", "label": "App Token", "type": "password", "default": ""},
        {"key": "priority_critical", "label": "Critical Priority", "type": "select",
         "default": "1", "options": ["-2", "-1", "0", "1", "2"]},
        {"key": "priority_warning", "label": "Warning Priority", "type": "select",
         "default": "0", "options": ["-2", "-1", "0", "1", "2"]},
        {"key": "priority_info", "label": "Info Priority", "type": "select",
         "default": "-1", "options": ["-2", "-1", "0", "1", "2"]},
    ]

    def send(self, event, severity, config=None):
        import httpx

        cfg = config or self._config
        user_key = cfg.get("user_key", "")
        app_token = cfg.get("app_token", "")

        if not user_key or not app_token:
            return False, "Pushover user key and app token required"

        # Get priority from config or default map
        priority_key = f"priority_{severity}"
        priority = int(cfg.get(priority_key, PRIORITY_MAP.get(severity, 0)))

        text = event.get("text", "Alert from RealmWatch")
        node = event.get("node", "")
        title = f"RealmWatch [{severity.upper()}]"
        if node:
            title = f"RealmWatch [{node}]"

        payload = {
            "token": app_token,
            "user": user_key,
            "title": title,
            "message": text,
            "priority": priority,
            "sound": "siren" if severity == "critical" else "pushover",
        }

        # Emergency priority (2) requires retry/expire
        if priority == 2:
            payload["retry"] = 60
            payload["expire"] = 300

        try:
            resp = httpx.post(PUSHOVER_API, data=payload, timeout=10)
            if resp.status_code == 200:
                return True, None
            return False, f"Pushover API returned {resp.status_code}: {resp.text[:200]}"
        except Exception as e:
            return False, str(e)
