"""Channel adapter system — base class and parallel dispatch.

Each channel adapter implements send() and test(). Dispatch runs
all matched channels in parallel via ThreadPoolExecutor.
"""

import logging
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

log = logging.getLogger(__name__)

_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="alerting")


class ChannelAdapter:
    """Base class for notification channel adapters."""

    name = "base"
    display_name = "Base Channel"
    config_fields = []  # list of {"key": str, "label": str, "type": "text"|"password"|"number"|"toggle"|"select", "default": any, "options": list (for select)}

    def __init__(self):
        self._config = {}

    def configure(self, config):
        """Update adapter config."""
        self._config = config or {}

    def send(self, event, severity, config=None):
        """Send a notification. Returns (success: bool, error: str|None)."""
        raise NotImplementedError

    def test(self, config=None):
        """Send a test notification. Returns (success: bool, error: str|None)."""
        test_event = {
            "type": "alert",
            "text": "Test alert from Realm Herald's Watch",
            "node": "realmwatch",
            "color": "#ffaa00",
            "ts": time.time(),
        }
        return self.send(test_event, "info", config)

    def get_config(self):
        """Return current config."""
        return dict(self._config)

    def get_status(self):
        """Return adapter health status."""
        return {"name": self.name, "configured": bool(self._config)}


def expand_template(template, event, severity="info"):
    """Expand {var} template variables in a string."""
    replacements = {
        "event.type": event.get("type", ""),
        "event.text": event.get("text", ""),
        "event.node": event.get("node", ""),
        "event.color": event.get("color", ""),
        "event.ts": str(event.get("ts", "")),
        "entity.name": event.get("entity_name", ""),
        "entity.status": event.get("entity_status", ""),
        "entity.host": event.get("entity_host", ""),
        "entity.type": event.get("entity_type", ""),
        "severity": severity,
    }
    result = template
    for key, value in replacements.items():
        result = result.replace("{" + key + "}", str(value))
    return result


# ── Channel Registry ──

_adapters = {}  # name -> ChannelAdapter instance


def register_adapter(adapter):
    """Register a channel adapter."""
    _adapters[adapter.name] = adapter
    log.info("Registered alerting channel: %s", adapter.name)


def get_adapter(name):
    """Get adapter by name."""
    return _adapters.get(name)


def get_all_adapters():
    """Get all registered adapters."""
    return dict(_adapters)


def dispatch_parallel(channels, event, severity, rule_name="", log_fn=None):
    """Fire notification on multiple channels in parallel.

    Args:
        channels: list of channel names
        event: event dict
        severity: computed severity string
        rule_name: name of matched rule (for logging)
        log_fn: callback(channel, success, error) for logging results

    Returns:
        list of (channel, success, error) tuples
    """
    results = []
    futures = {}

    for ch_name in channels:
        adapter = _adapters.get(ch_name)
        if not adapter:
            results.append((ch_name, False, f"Unknown channel: {ch_name}"))
            continue

        future = _pool.submit(_safe_send, adapter, event, severity)
        futures[future] = ch_name

    for future in as_completed(futures, timeout=30):
        ch_name = futures[future]
        try:
            success, error = future.result(timeout=5)
        except Exception as e:
            success, error = False, str(e)
        results.append((ch_name, success, error))
        if log_fn:
            log_fn(ch_name, success, error)

    return results


def _safe_send(adapter, event, severity):
    """Send with error handling."""
    try:
        return adapter.send(event, severity)
    except Exception as e:
        log.warning("Channel %s send error: %s", adapter.name, e)
        return False, str(e)
