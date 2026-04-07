"""Voice adapter — speaks alerts via speech-to-cli MCP server."""

import logging
from . import ChannelAdapter

log = logging.getLogger(__name__)


class VoiceAdapter(ChannelAdapter):
    name = "voice"
    display_name = "Voice Alerts"
    config_fields = [
        {"key": "voice", "label": "Voice", "type": "text",
         "default": "en-US-Davis:DragonHDLatestNeural"},
        {"key": "quality", "label": "Quality", "type": "select", "default": "hd",
         "options": ["hd", "standard"]},
        {"key": "speech_url", "label": "Speech Server URL", "type": "text",
         "default": "http://localhost:58642"},
    ]

    def send(self, event, severity, config=None):
        import httpx

        cfg = config or self._config
        voice = cfg.get("voice", "en-US-Davis:DragonHDLatestNeural")
        quality = cfg.get("quality", "hd")
        base_url = cfg.get("speech_url", "http://localhost:58642")

        text = event.get("text", "Alert from RealmWatch")
        node = event.get("node", "")
        if node:
            text = f"{node}: {text}"

        try:
            resp = httpx.post(
                f"{base_url}/speak",
                json={"text": text, "voice": voice, "quality": quality},
                timeout=10,
            )
            if resp.status_code == 200:
                return True, None
            return False, f"Speech server returned {resp.status_code}"
        except httpx.ConnectError:
            return False, "Speech server not reachable"
        except Exception as e:
            return False, str(e)
