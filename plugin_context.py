"""Plugin context — the API surface passed to each plugin's setup() function.

Provides scoped access to registration, storage, events, and inter-plugin
communication. Each plugin gets its own PluginContext instance.
"""

import json
import logging
import threading
from pathlib import Path

import realm_db

log = logging.getLogger(__name__)


class PluginRequest:
    """Wraps RealmHandler to expose a clean public API for plugin handlers.

    Plugin handlers receive this instead of the raw HTTP handler, preventing
    leakage of HTTP internals.
    """

    def __init__(self, handler):
        self._handler = handler
        self._responded = False

    def json(self):
        """Parse request body as JSON."""
        try:
            length = int(self._handler.headers.get("Content-Length", 0))
            if length > 0:
                body = self._handler.rfile.read(length)
                return json.loads(body)
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
        return {}

    def respond(self, data, status=200):
        """Send a JSON response."""
        if self._responded:
            return
        self._responded = True
        self._handler._json_response(data, status)

    def respond_html(self, html, status=200):
        """Send an HTML response."""
        if self._responded:
            return
        self._responded = True
        encoded = html.encode()
        self._handler.send_response(status)
        self._handler.send_header("Content-Type", "text/html")
        self._handler.send_header("Content-Length", len(encoded))
        self._handler.end_headers()
        self._handler.wfile.write(encoded)

    def redirect(self, location, status=301):
        """Send a redirect response."""
        if self._responded:
            return
        self._responded = True
        self._handler.send_response(status)
        self._handler.send_header("Location", location)
        self._handler.end_headers()

    @property
    def query_params(self):
        """Parse query parameters from the request path."""
        path = self._handler.path
        if "?" not in path:
            return {}
        qs = path.split("?", 1)[1]
        params = {}
        for part in qs.split("&"):
            if "=" in part:
                k, v = part.split("=", 1)
                params[k] = v
            elif part:
                params[part] = ""
        return params

    @property
    def headers(self):
        """Request headers."""
        return self._handler.headers

    @property
    def path(self):
        """Request path."""
        return self._handler.path

    @property
    def method(self):
        """HTTP method."""
        return self._handler.command


class PluginDB:
    """Scoped database access for a plugin.

    Settings are namespaced as 'plugin:<name>' in the existing settings table.
    Custom tables are prefixed with 'plugin_<name>_'.
    """

    def __init__(self, plugin_name):
        self._name = plugin_name
        self._namespace = f"plugin:{plugin_name}"
        self._table_prefix = f"plugin_{plugin_name.replace('-', '_')}_"

    def get_settings(self):
        """Read all settings for this plugin."""
        return realm_db.get_settings(self._namespace)

    def set_settings(self, data):
        """Write settings for this plugin."""
        realm_db.set_settings(self._namespace, data)

    def get_setting(self, key, default=None):
        """Read a single setting."""
        return realm_db.get_setting(self._namespace, key, default)

    def set_setting(self, key, value):
        """Write a single setting."""
        realm_db.set_settings(self._namespace, {key: value})

    def create_table(self, table_name, schema):
        """Create a plugin-prefixed table.

        Args:
            table_name: Short name (e.g., 'runs'). Will be prefixed with plugin_<name>_.
            schema: SQL column definitions (e.g., 'id INTEGER PRIMARY KEY, data TEXT').
        """
        full_name = self._table_prefix + table_name
        c = realm_db._conn()
        c.execute(f"CREATE TABLE IF NOT EXISTS {full_name} ({schema})")
        c.commit()
        return full_name

    def execute(self, sql, params=None):
        """Execute SQL scoped to plugin tables.

        The SQL must reference tables with the plugin prefix. This is a trust-based
        model — plugins have full DB access, but convention keeps them in their lane.
        """
        c = realm_db._conn()
        c.execute(sql, params or ())
        c.commit()

    def query(self, sql, params=None):
        """Query and return rows as list of dicts."""
        c = realm_db._conn()
        rows = c.execute(sql, params or ()).fetchall()
        return [dict(r) for r in rows]


class PluginContext:
    """API surface for a single plugin. Passed to setup()."""

    def __init__(self, name, data_dir, config, registry, route_table, push_event_fn, sse_broker):
        self.name = name
        self.data_dir = Path(data_dir)
        self.config = config
        self.db = PluginDB(name)
        self._registry = registry
        self._route_table = route_table
        self._push_event = push_event_fn
        self._sse_broker = sse_broker
        self._threads = []
        self._logger = logging.getLogger(f"plugin.{name}")

    # ── Registration ──

    def register_endpoint(self, method, path, handler, raw_path=False):
        """Register an HTTP endpoint.

        Args:
            method: HTTP method (GET, POST, DELETE).
            path: URL path. Auto-prefixed with /plugins/<name>/ unless raw_path=True.
            handler: Callable(req: PluginRequest, params: dict) -> dict | None.
            raw_path: If True, path is used as-is (no auto-prefix).
        """
        from route_table import PRIORITY_RAW_PATH, PRIORITY_NAMESPACED

        if raw_path:
            full_path = path
            priority = PRIORITY_RAW_PATH
        else:
            full_path = f"/plugins/{self.name}/{path.lstrip('/')}"
            priority = PRIORITY_NAMESPACED

        self._route_table.add(method, full_path, handler,
                              plugin=self.name, priority=priority)
        self._logger.info("Registered endpoint: %s %s", method, full_path)

    def register_sse_source(self, event_type, getter_fn, interval=30,
                            burst=False, burst_priority=50):
        """Register an SSE data source.

        Args:
            event_type: SSE event name (e.g., 'energy', 'ansible').
            getter_fn: Callable that returns data dict (must be fast — read cached data).
            interval: Seconds between polls in the SSE collect loop.
            burst: Include in initial burst to new SSE clients.
            burst_priority: Order within burst (lower = earlier).
        """
        from plugin_registry import SSESource
        source = SSESource(
            event_type=event_type,
            getter_fn=getter_fn,
            interval=interval,
            burst=burst,
            burst_priority=burst_priority,
            plugin=self.name,
        )
        self._registry.register_sse_source(source)
        self._logger.info("Registered SSE source: %s (every %ds)", event_type, interval)

    def register_node_enricher(self, fn, priority=50):
        """Register a node enrichment function.

        Args:
            fn: Callable(node_id, node_data) -> dict | None.
                Return dict with optional keys: sublabel, sublabel_priority, badge,
                status_class, context_menu, meta. Return None to skip.
            priority: Enricher priority (lower = runs first, sublabel wins).
        """
        self._registry.register_node_enricher(fn, self.name, priority)
        self._logger.info("Registered node enricher (priority=%d)", priority)

    def register_context_menu_item(self, label, handler_fn):
        """Register a right-click context menu item for nodes."""
        from plugin_registry import MenuItem
        item = MenuItem(label=label, handler_fn=handler_fn, plugin=self.name)
        self._registry.register_context_menu_item(item)

    def register_status_provider(self, fn):
        """Register a status provider for build_status aggregation.

        Args:
            fn: Callable() -> dict. Result merged into the status blob.
        """
        self._registry.register_status_provider(fn, self.name)
        self._logger.info("Registered status provider")

    def on_event(self, event_type, handler_fn):
        """Subscribe to realm events.

        Args:
            event_type: Event type string to listen for.
            handler_fn: Callable(event_dict) called when matching events fire.
        """
        self._registry.register_event_handler(event_type, handler_fn, self.name)

    def register_discovery_provider(self, name, roles, discover_fn, interval=60,
                                     entity_types=None, priority=50):
        """Register a discovery provider with the engine.

        Args:
            name: Provider name (e.g., 'docker', 'systemd').
            roles: Node roles this provider scans (e.g., ['server', 'nas']).
            discover_fn: Callable(node_id, node_data, host_access, engine) -> list[SubEntity].
            interval: Seconds between scans (default 60).
            entity_types: What this provider discovers (e.g., ['container']).
            priority: Scan order (lower = earlier, default 50).
        """
        from discovery_engine import DiscoveryProvider
        provider = DiscoveryProvider(
            name=name, roles=roles, discover_fn=discover_fn,
            interval=interval, entity_types=entity_types or [],
            priority=priority, plugin=self.name,
        )
        self._registry.register_discovery_provider(provider)
        self._logger.info("Registered discovery provider: %s (roles=%s)", name, roles)

    # ── Utilities ──

    def push_event(self, event_type, data):
        """Push an event to the realm event stream.

        Args:
            event_type: Event type string.
            data: Event data dict (type and ts will be set automatically).
        """
        event = dict(data)
        event["type"] = event_type
        return self._push_event(event)

    def get_topology(self):
        """Read current topology (nodes, connections, regions)."""
        return realm_db.get_topology()

    def get_node(self, node_id):
        """Read a single node by ID."""
        return realm_db.get_node(node_id)

    def log(self, msg, *args):
        """Plugin-scoped logging (prefixed with plugin name)."""
        self._logger.info(msg, *args)

    def start_background_thread(self, target, interval=None, name=None):
        """Start a managed daemon thread.

        Args:
            target: Callable to run. If interval is set, called repeatedly.
            interval: Seconds between calls (None = run once).
            name: Thread name (defaults to plugin-<name>-bg).
        """
        thread_name = name or f"plugin-{self.name}-bg"

        if interval is not None:
            def _loop():
                while True:
                    try:
                        target()
                    except Exception:
                        self._logger.warning("Background thread error in %s",
                                             thread_name, exc_info=True)
                    threading.Event().wait(interval)

            t = threading.Thread(target=_loop, daemon=True, name=thread_name)
        else:
            def _wrapped():
                try:
                    target()
                except Exception:
                    self._logger.warning("Background thread error in %s",
                                         thread_name, exc_info=True)

            t = threading.Thread(target=_wrapped, daemon=True, name=thread_name)

        t.start()
        self._threads.append(t)
        self._logger.info("Started background thread: %s", thread_name)
        return t

    # ── Inter-plugin ──

    def expose_api(self, api_dict):
        """Expose a public API dict for other plugins to access.

        Args:
            api_dict: Dict of callable functions other plugins can use.
        """
        self._registry.expose_plugin_api(self.name, api_dict)
        self._logger.info("Exposed plugin API with %d methods", len(api_dict))

    def get_plugin_api(self, plugin_name):
        """Access another plugin's public API.

        Args:
            plugin_name: Name of the plugin whose API to access.

        Returns:
            API dict or None if plugin hasn't exposed an API.
        """
        return self._registry.get_plugin_api(plugin_name)
