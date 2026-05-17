"""Plugin registry — queryable catalog of all loaded plugins and their registrations.

Central registry that core components (map_server, SSE broker, build_status)
use to discover plugin-provided endpoints, SSE sources, panels, enrichers, etc.
"""

import logging
import subprocess
import dataclasses
from typing import Any, Callable

from discovery_engine import DiscoveryProvider

log = logging.getLogger(__name__)


@dataclasses.dataclass
class PluginInfo:
    """Metadata for a loaded plugin."""
    name: str
    version: str
    plugin_type: str  # "integrated" | "standalone" | "on-demand"
    description: str
    fantasy_name: str
    icon: str
    data_dir: str
    manifest: dict
    status: str = "loaded"  # loaded | error | disabled
    error: str = ""
    module: Any = None  # Python module reference


@dataclasses.dataclass
class SSESource:
    """A plugin-registered SSE data source."""
    event_type: str
    getter_fn: Callable
    interval: int  # seconds
    burst: bool = False
    burst_priority: int = 50  # lower = earlier in burst
    plugin: str = ""


@dataclasses.dataclass
class PanelInfo:
    """Frontend panel metadata from a plugin manifest."""
    id: str
    name: str
    plugin: str
    anchor: str = "ne"
    priority: int = 20
    html: str = ""   # filename relative to plugin dir
    js: str = ""     # filename relative to plugin dir
    css: str = ""    # filename relative to plugin dir


@dataclasses.dataclass
class MenuItem:
    """A context menu item registered by a plugin."""
    label: str
    handler_fn: Callable
    plugin: str = ""


class PluginRegistry:
    """Central registry for all plugin registrations."""

    def __init__(self):
        self._plugins: dict[str, PluginInfo] = {}
        self._endpoints = []  # stored in route_table, not here
        self._sse_sources: list[SSESource] = []
        self._panels: list[PanelInfo] = []
        self._node_enrichers: list[tuple[Callable, str, int]] = []  # (fn, plugin, priority)
        self._context_menu_items: list[MenuItem] = []
        self._status_providers: list[tuple[Callable, str]] = []  # (fn, plugin)
        self._event_handlers: dict[str, list[tuple[Callable, str]]] = {}  # event_type -> [(fn, plugin)]
        self._plugin_apis: dict[str, dict] = {}  # plugin_name -> api_dict
        self._discovery_providers: list[DiscoveryProvider] = []

    def register_plugin(self, info: PluginInfo):
        """Register a plugin's metadata."""
        self._plugins[info.name] = info

    def register_sse_source(self, source: SSESource):
        """Register a plugin SSE data source."""
        self._sse_sources.append(source)

    def register_panel(self, panel: PanelInfo):
        """Register a plugin panel for frontend injection."""
        self._panels.append(panel)

    def register_node_enricher(self, fn: Callable, plugin: str, priority: int = 50):
        """Register a node enrichment function."""
        self._node_enrichers.append((fn, plugin, priority))
        # Keep sorted by priority (lower = higher priority = runs first)
        self._node_enrichers.sort(key=lambda x: x[2])

    def register_context_menu_item(self, item: MenuItem):
        """Register a node context menu item."""
        self._context_menu_items.append(item)

    def register_status_provider(self, fn: Callable, plugin: str):
        """Register a status provider function for build_status aggregation."""
        self._status_providers.append((fn, plugin))

    def register_event_handler(self, event_type: str, fn: Callable, plugin: str):
        """Register a handler for realm events."""
        if event_type not in self._event_handlers:
            self._event_handlers[event_type] = []
        self._event_handlers[event_type].append((fn, plugin))

    def expose_plugin_api(self, plugin_name: str, api_dict: dict):
        """Store a plugin's public API for inter-plugin access."""
        self._plugin_apis[plugin_name] = api_dict

    def register_discovery_provider(self, provider: DiscoveryProvider):
        """Register a discovery provider."""
        self._discovery_providers.append(provider)

    def get_discovery_providers(self) -> list[DiscoveryProvider]:
        """All registered discovery providers."""
        return list(self._discovery_providers)

    # ── Queries ──

    def get_all_plugins(self) -> list[PluginInfo]:
        """All registered plugins."""
        return list(self._plugins.values())

    def get_plugin(self, name: str) -> PluginInfo | None:
        """Get a single plugin by name."""
        return self._plugins.get(name)

    def get_sse_sources(self) -> list[SSESource]:
        """All registered SSE sources."""
        return list(self._sse_sources)

    def get_panels(self) -> list[PanelInfo]:
        """All registered panels."""
        return list(self._panels)

    def get_node_enrichers(self) -> list[tuple[Callable, str, int]]:
        """All node enrichers, sorted by priority."""
        return list(self._node_enrichers)

    def get_context_menu_items(self) -> list[MenuItem]:
        """All context menu items."""
        return list(self._context_menu_items)

    def get_status_providers(self) -> list[tuple[Callable, str]]:
        """All status provider functions."""
        return list(self._status_providers)

    def get_discovery_prototypes(self) -> list[dict]:
        """Return every discovery prototype declared in plugin manifests.

        Each entry is {entity_type, sublabel, alert_on, plugin, ...} —
        whatever the manifest declared, with `plugin` added so consumers
        know which provider owns each prototype.

        Zabbix-inspired (issue #6). Prototypes describe how to render and
        alert on sub-entities of a given type — one declaration covers N
        discovered instances.
        """
        out: list[dict] = []
        for plugin_name, info in self._plugins.items():
            manifest = info.manifest or {}
            for proto in manifest.get("discovery_prototypes", []):
                if not isinstance(proto, dict):
                    continue
                out.append({**proto, "plugin": plugin_name})
        return out

    def get_event_handlers(self, event_type: str) -> list[tuple[Callable, str]]:
        """Event handlers for a specific event type."""
        return self._event_handlers.get(event_type, [])

    def get_plugin_api(self, plugin_name: str) -> dict | None:
        """Get another plugin's exposed API."""
        return self._plugin_apis.get(plugin_name)

    def get_plugin_status(self, name: str) -> dict:
        """Get runtime status for a plugin (running/stopped/error)."""
        info = self._plugins.get(name)
        if not info:
            return {"status": "not_found"}

        result = {
            "name": info.name,
            "type": info.plugin_type,
            "status": info.status,
            "error": info.error,
        }

        # For standalone plugins, check systemd service status
        if info.plugin_type == "standalone":
            service = info.manifest.get("service", "")
            if service:
                try:
                    out = subprocess.run(
                        ["systemctl", "--user", "is-active", service],
                        capture_output=True, text=True, timeout=3,
                    )
                    result["service_status"] = out.stdout.strip()
                except Exception:
                    result["service_status"] = "unknown"

        return result

    def fire_event(self, event_type: str, event: dict):
        """Dispatch an event to all registered handlers for that type."""
        handlers = self._event_handlers.get(event_type, [])
        for fn, plugin in handlers:
            try:
                fn(event)
            except Exception:
                log.warning("Event handler error in plugin %s for %s",
                            plugin, event_type, exc_info=True)
