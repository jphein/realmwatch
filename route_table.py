"""Route table — pattern-matched HTTP routing for core and plugin endpoints.

Replaces if/elif chains with a priority-ordered route table. Core routes
register first (highest priority), then plugin raw_path routes, then
namespaced plugin routes.
"""

import logging
import re

log = logging.getLogger(__name__)

# Priority levels: lower number = higher priority
PRIORITY_CORE = 0
PRIORITY_RAW_PATH = 10
PRIORITY_NAMESPACED = 20


class RouteTable:
    """Priority-ordered HTTP route table with path parameter extraction."""

    def __init__(self):
        self._routes = []  # [(method, pattern_re, param_names, handler, priority, plugin_name, raw_pattern)]
        self._sorted = True

    def add(self, method, path, handler, plugin=None, priority=None):
        """Register a route.

        Args:
            method: HTTP method (GET, POST, DELETE).
            path: URL pattern. Use <name> for path parameters (e.g., /run/<id>).
            handler: Callable(req, params) -> dict | None.
            plugin: Plugin name (None for core routes).
            priority: Route priority (lower = checked first). Defaults based on plugin/path.
        """
        if priority is None:
            if plugin is None:
                priority = PRIORITY_CORE
            elif not path.startswith("/plugins/"):
                priority = PRIORITY_RAW_PATH
            else:
                priority = PRIORITY_NAMESPACED

        # Convert path pattern to regex
        param_names = []
        regex_parts = []
        for segment in path.split("/"):
            if not segment:
                continue
            if segment.startswith("<") and segment.endswith(">"):
                name = segment[1:-1]
                param_names.append(name)
                regex_parts.append(r"([^/]+)")
            else:
                regex_parts.append(re.escape(segment))

        pattern_str = "/" + "/".join(regex_parts)
        # Preserve trailing slash if the original path had one
        if path.endswith("/") and not pattern_str.endswith("/"):
            pattern_str += "/"
        # Match the path exactly (strip query string before matching)
        pattern_re = re.compile(f"^{pattern_str}$")

        self._routes.append((
            method.upper(), pattern_re, param_names, handler,
            priority, plugin, path
        ))
        self._sorted = False

    def match(self, method, path):
        """Find matching handler for a request.

        Args:
            method: HTTP method.
            path: Request path (query string will be stripped).

        Returns:
            (handler, params_dict) or None if no match.
        """
        if not self._sorted:
            self._routes.sort(key=lambda r: r[4])  # sort by priority
            self._sorted = True

        # Strip query string for pattern matching
        clean_path = path.split("?")[0]

        for m, pattern_re, param_names, handler, priority, plugin, raw_pattern in self._routes:
            if m != method.upper():
                continue
            match = pattern_re.match(clean_path)
            if match:
                params = dict(zip(param_names, match.groups()))
                # Attach query params for convenience
                params["_query"] = _parse_query(path)
                return handler, params
        return None

    def get_routes(self, plugin=None):
        """List registered routes, optionally filtered by plugin name."""
        routes = []
        for m, _, _, handler, priority, p, raw_pattern in self._routes:
            if plugin is not None and p != plugin:
                continue
            routes.append({
                "method": m,
                "path": raw_pattern,
                "plugin": p,
                "priority": priority,
            })
        return routes

    def check_conflicts(self):
        """Log warnings for routes that may shadow each other."""
        seen = {}  # (method, pattern) -> (plugin, raw_path)
        for m, pattern_re, _, _, priority, plugin, raw_pattern in self._routes:
            key = (m, pattern_re.pattern)
            if key in seen:
                existing = seen[key]
                log.warning(
                    "Route conflict: %s %s (plugin=%s, priority=%d) "
                    "shadows %s %s (plugin=%s)",
                    m, raw_pattern, plugin, priority,
                    m, existing[1], existing[0],
                )
            else:
                seen[key] = (plugin, raw_pattern)


def _parse_query(path):
    """Parse query string from a path into a dict."""
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
