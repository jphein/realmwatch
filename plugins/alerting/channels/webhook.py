"""Webhook adapter — generic HTTP webhook with presets for Slack, Discord, Ntfy."""

import json
import logging
from . import ChannelAdapter, expand_template

log = logging.getLogger(__name__)

PRESETS = {
    "slack": {
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "text": "*[{severity}]* {event.text}",
            "username": "RealmWatch",
            "icon_emoji": ":shield:",
        }),
    },
    "discord": {
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "content": "**[{severity}]** {event.text}",
            "username": "RealmWatch",
        }),
    },
    "ntfy": {
        "method": "POST",
        "headers": {
            "Title": "RealmWatch [{severity}]",
            "Priority": "default",
            "Tags": "shield",
        },
        "body": "{event.text}",
    },
    "custom": {
        "method": "POST",
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "severity": "{severity}",
            "text": "{event.text}",
            "node": "{event.node}",
            "type": "{event.type}",
        }),
    },
}


class WebhookAdapter(ChannelAdapter):
    name = "webhook"
    display_name = "Webhook"
    config_fields = [
        {"key": "url", "label": "Webhook URL", "type": "text", "default": ""},
        {"key": "preset", "label": "Preset", "type": "select", "default": "custom",
         "options": ["slack", "discord", "ntfy", "custom"]},
        {"key": "method", "label": "HTTP Method", "type": "select", "default": "POST",
         "options": ["POST", "PUT", "PATCH"]},
        {"key": "custom_headers", "label": "Custom Headers (JSON)", "type": "text", "default": "{}"},
        {"key": "custom_body", "label": "Custom Body Template", "type": "text", "default": ""},
    ]

    def send(self, event, severity, config=None):
        import httpx

        cfg = config or self._config
        url = cfg.get("url", "")
        if not url:
            return False, "Webhook URL not configured"

        preset_name = cfg.get("preset", "custom")
        preset = PRESETS.get(preset_name, PRESETS["custom"])

        # Use custom body/headers if provided, else preset
        method = cfg.get("method") or preset.get("method", "POST")

        headers = dict(preset.get("headers", {}))
        custom_headers_raw = cfg.get("custom_headers", "{}")
        try:
            custom_headers = json.loads(custom_headers_raw) if custom_headers_raw else {}
            headers.update(custom_headers)
        except json.JSONDecodeError:
            pass

        body_template = cfg.get("custom_body") or preset.get("body", "")
        body = expand_template(body_template, event, severity)

        # Expand template vars in headers too
        headers = {k: expand_template(v, event, severity) for k, v in headers.items()}

        try:
            resp = httpx.request(
                method, url, content=body, headers=headers, timeout=10
            )
            if resp.status_code < 300:
                return True, None
            return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
        except httpx.ConnectError:
            return False, f"Cannot connect to webhook URL"
        except Exception as e:
            return False, str(e)
