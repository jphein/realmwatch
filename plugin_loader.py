"""Plugin loader — discovery, validation, topological sort, and lifecycle management.

Scans plugins/ directory, validates manifests, resolves dependency order,
imports plugin modules, and calls setup(ctx) for each integrated plugin.
"""

import importlib
import importlib.machinery
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path

from plugin_context import PluginContext
from plugin_registry import PluginRegistry, PluginInfo, PanelInfo

log = logging.getLogger(__name__)

PLUGINS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plugins")

REQUIRED_MANIFEST_FIELDS = {"name", "version", "type"}
VALID_PLUGIN_TYPES = {"integrated", "standalone", "on-demand"}


def discover_plugins(plugins_dir=None):
    """Scan plugins directory for valid plugin manifests.

    Returns:
        List of (name, manifest_dict, plugin_dir) tuples for valid plugins.
    """
    plugins_dir = plugins_dir or PLUGINS_DIR
    if not os.path.isdir(plugins_dir):
        log.info("No plugins directory found at %s", plugins_dir)
        return []

    found = []
    for entry in sorted(os.listdir(plugins_dir)):
        plugin_dir = os.path.join(plugins_dir, entry)
        if not os.path.isdir(plugin_dir):
            continue

        manifest_path = os.path.join(plugin_dir, "plugin.json")
        if not os.path.isfile(manifest_path):
            continue

        try:
            with open(manifest_path) as f:
                manifest = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            log.warning("Skipping plugin %s: invalid manifest: %s", entry, e)
            continue

        # Validate required fields
        missing = REQUIRED_MANIFEST_FIELDS - set(manifest.keys())
        if missing:
            log.warning("Skipping plugin %s: missing fields: %s", entry, missing)
            continue

        if manifest["type"] not in VALID_PLUGIN_TYPES:
            log.warning("Skipping plugin %s: invalid type '%s'", entry, manifest["type"])
            continue

        # Name in manifest must match directory name
        if manifest["name"] != entry:
            log.warning("Skipping plugin %s: manifest name '%s' != directory '%s'",
                        entry, manifest["name"], entry)
            continue

        found.append((manifest["name"], manifest, plugin_dir))

    return found


def _topological_sort(plugins):
    """Sort plugins by depends_on, detecting cycles.

    Args:
        plugins: List of (name, manifest, dir) tuples.

    Returns:
        (sorted_list, skipped_names) — sorted plugins and names involved in cycles.
    """
    by_name = {name: (manifest, pdir) for name, manifest, pdir in plugins}
    all_names = set(by_name.keys())

    # Build adjacency: name -> set of dependencies
    deps = {}
    for name, manifest, _ in plugins:
        dep_list = manifest.get("depends_on", [])
        # Only track dependencies on plugins that exist
        deps[name] = set(d for d in dep_list if d in all_names)

    # Kahn's algorithm
    in_degree = {name: 0 for name in all_names}
    for name, dep_set in deps.items():
        for d in dep_set:
            if d in in_degree:
                # name depends on d, so d must come before name
                pass
        in_degree[name] = len(dep_set)

    queue = [n for n in all_names if in_degree[n] == 0]
    queue.sort()  # deterministic order for same-level plugins
    sorted_names = []

    while queue:
        name = queue.pop(0)
        sorted_names.append(name)
        # Find plugins that depend on this one
        for other, dep_set in deps.items():
            if name in dep_set:
                in_degree[other] -= 1
                if in_degree[other] == 0:
                    queue.append(other)
                    queue.sort()

    skipped = all_names - set(sorted_names)
    if skipped:
        log.error("Dependency cycle detected! Skipping plugins: %s", skipped)

    # Rebuild sorted list with full tuples
    result = []
    for name in sorted_names:
        manifest, pdir = by_name[name]
        result.append((name, manifest, pdir))

    return result, skipped


def _validate_files(manifest, plugin_dir):
    """Check that files referenced in the manifest actually exist.

    Returns list of warning strings (empty = all good).
    """
    warnings = []

    # Python module
    python = manifest.get("python", {})
    if python:
        module_name = python.get("module", "plugin")
        module_path = os.path.join(plugin_dir, f"{module_name}.py")
        if not os.path.isfile(module_path):
            warnings.append(f"Python module not found: {module_name}.py")

    # Panel files
    panel = manifest.get("panel", {})
    for key in ("html", "js", "css"):
        filename = panel.get(key)
        if filename and not os.path.isfile(os.path.join(plugin_dir, filename)):
            warnings.append(f"Panel {key} not found: {filename}")

    return warnings


def _ensure_plugins_namespace() -> None:
    """Make `plugins` and `plugins.<plugin_name>` resolvable as packages.

    Without this, two plugins that each `import sources` (or any other bare
    sibling name) would share the same `sys.modules['sources']` entry — the
    second plugin's import silently picks up the first plugin's module.
    Aether's Wave 2 findings documented this trap in detail.

    The fix is two-part:
      1) Register `plugins` itself as a synthetic namespace package rooted at
         `<repo>/plugins/`. Python's import system can then resolve
         `plugins.<name>.<sibling>` via standard relative-import machinery.
      2) Register each plugin's own directory as `plugins.<name>` so
         `from . import sibling` inside a plugin module attaches to the
         right namespace without each plugin needing
         `sys.path.insert(0, plugin_dir.parent)`.

    Step (2) happens lazily inside `_load_plugin_module()`, since that's
    when we know the plugin name and dir. This function only does step (1).
    """
    if "plugins" in sys.modules:
        return
    plugins_root = os.path.dirname(os.path.abspath(__file__))
    plugins_pkg_dir = os.path.join(plugins_root, "plugins")
    if not os.path.isdir(plugins_pkg_dir):
        return
    spec = importlib.machinery.ModuleSpec("plugins", loader=None, is_package=True)
    spec.submodule_search_locations = [plugins_pkg_dir]
    pkg = importlib.util.module_from_spec(spec)
    pkg.__path__ = [plugins_pkg_dir]  # required for `from plugins.x import y`
    sys.modules["plugins"] = pkg


def _load_plugin_module(name, manifest, plugin_dir):
    """Import a plugin's Python module.

    Returns the module object, or None on failure.
    """
    python = manifest.get("python", {})
    if not python:
        return None

    module_name = python.get("module", "plugin")
    module_path = os.path.join(plugin_dir, f"{module_name}.py")

    if not os.path.isfile(module_path):
        return None

    # Ensure `plugins` and `plugins.<name>` are registered as packages so
    # relative imports (`from . import server`) resolve under unique keys
    # — this prevents the sibling-name collision Aether documented (two
    # plugins each importing a bare `producer` / `server` / `sources`
    # would otherwise share one sys.modules entry).
    _ensure_plugins_namespace()
    pkg_spec_name = f"plugins.{name}"
    if pkg_spec_name not in sys.modules:
        pkg_spec = importlib.machinery.ModuleSpec(
            pkg_spec_name, loader=None, is_package=True
        )
        pkg_spec.submodule_search_locations = [plugin_dir]
        pkg_mod = importlib.util.module_from_spec(pkg_spec)
        pkg_mod.__path__ = [plugin_dir]
        sys.modules[pkg_spec_name] = pkg_mod

    # Import using spec loader to avoid name collisions
    spec_name = f"plugins.{name}.{module_name}"
    try:
        spec = importlib.util.spec_from_file_location(
            spec_name, module_path,
            submodule_search_locations=[plugin_dir],
        )
        if spec is None or spec.loader is None:
            log.error("Cannot create module spec for plugin %s", name)
            return None
        module = importlib.util.module_from_spec(spec)
        # Set __package__ so `from . import x` resolves to plugins.<name>.x
        module.__package__ = pkg_spec_name
        sys.modules[spec_name] = module
        spec.loader.exec_module(module)
        return module
    except Exception:
        log.error("Failed to import plugin %s", name, exc_info=True)
        return None


def _merge_config(manifest):
    """Merge manifest config defaults with DB overrides.

    Returns resolved config dict.
    """
    config_schema = manifest.get("config", {})
    defaults = {}
    for key, spec in config_schema.items():
        if isinstance(spec, dict):
            defaults[key] = spec.get("default")
        else:
            defaults[key] = spec

    # Load DB overrides
    import realm_db
    db_config = realm_db.get_settings(f"plugin:{manifest['name']}")

    # Merge: DB overrides win
    merged = dict(defaults)
    merged.update(db_config)
    return merged


def load_plugins(route_table, push_event_fn, sse_broker, plugins_dir=None):
    """Main entry point: discover, sort, load, and register all plugins.

    Args:
        route_table: RouteTable instance for endpoint registration.
        push_event_fn: The realm's push_event function.
        sse_broker: SSEBroker instance for SSE source registration.
        plugins_dir: Override plugins directory (for testing).

    Returns:
        PluginRegistry with all loaded plugins registered.
    """
    registry = PluginRegistry()

    # 1. Discover
    found = discover_plugins(plugins_dir)
    if not found:
        log.info("No plugins found")
        return registry

    log.info("Discovered %d plugin(s): %s",
             len(found), ", ".join(n for n, _, _ in found))

    # 2. Topological sort
    sorted_plugins, skipped = _topological_sort(found)

    # 3. Check for disabled plugins
    import realm_db
    disabled = realm_db.get_settings("plugins") or {}

    # 3. Load each plugin in order
    counts = {"integrated": 0, "standalone": 0, "on-demand": 0}

    for name, manifest, plugin_dir in sorted_plugins:
        if disabled.get(name) == "disabled":
            log.info("Plugin %s: disabled by user, skipping", name)
            info = PluginInfo(
                name=name,
                version=manifest.get("version", "0.0.0"),
                plugin_type=manifest["type"],
                description=manifest.get("description", ""),
                fantasy_name=manifest.get("fantasy_name", name),
                icon=manifest.get("icon", ""),
                data_dir=plugin_dir,
                manifest=manifest,
                status="disabled",
            )
            registry.register_plugin(info)
            continue
        plugin_type = manifest["type"]

        # Validate referenced files
        file_warnings = _validate_files(manifest, plugin_dir)
        for w in file_warnings:
            log.warning("Plugin %s: %s", name, w)

        # Create PluginInfo
        info = PluginInfo(
            name=name,
            version=manifest.get("version", "0.0.0"),
            plugin_type=plugin_type,
            description=manifest.get("description", ""),
            fantasy_name=manifest.get("fantasy_name", name),
            icon=manifest.get("icon", ""),
            data_dir=plugin_dir,
            manifest=manifest,
        )

        # Register panel metadata (if declared in manifest)
        panel = manifest.get("panel", {})
        if panel:
            panel_info = PanelInfo(
                id=panel.get("id", f"{name}-panel"),
                name=panel.get("name", info.fantasy_name),
                plugin=name,
                anchor=panel.get("anchor", "ne"),
                priority=panel.get("priority", 20),
                html=panel.get("html", ""),
                js=panel.get("js", ""),
                css=panel.get("css", ""),
            )
            registry.register_panel(panel_info)

        # For integrated plugins: import and call setup()
        if plugin_type == "integrated":
            python = manifest.get("python", {})
            if python:
                module = _load_plugin_module(name, manifest, plugin_dir)
                if module is None:
                    info.status = "error"
                    info.error = "Failed to import module"
                    registry.register_plugin(info)
                    log.error("Plugin %s: failed to import, skipping setup", name)
                    continue

                info.module = module

                # Build config
                config = _merge_config(manifest)

                # Create context
                ctx = PluginContext(
                    name=name,
                    data_dir=plugin_dir,
                    config=config,
                    registry=registry,
                    route_table=route_table,
                    push_event_fn=push_event_fn,
                    sse_broker=sse_broker,
                )

                # Call setup
                entry_fn = python.get("entry", "setup")
                try:
                    setup = getattr(module, entry_fn)
                    setup(ctx)
                    log.info("Plugin %s: setup() complete", name)
                except Exception:
                    info.status = "error"
                    info.error = "setup() failed"
                    log.error("Plugin %s: setup() failed", name, exc_info=True)
                    registry.register_plugin(info)
                    continue

        # Register manifest-declared endpoints
        for ep in manifest.get("endpoints", []):
            ep_method = ep.get("method", "GET")
            ep_path = ep.get("path", "")
            ep_handler_name = ep.get("handler", "")
            raw = ep.get("raw_path", False)

            if not ep_path or not ep_handler_name:
                continue

            # Look up handler in the plugin module
            if info.module and hasattr(info.module, ep_handler_name):
                handler = getattr(info.module, ep_handler_name)
                full_path = ep_path if raw else f"/plugins/{name}/{ep_path.lstrip('/')}"
                from route_table import PRIORITY_RAW_PATH, PRIORITY_NAMESPACED
                priority = PRIORITY_RAW_PATH if raw else PRIORITY_NAMESPACED
                route_table.add(ep_method, full_path, handler,
                                plugin=name, priority=priority)
            else:
                log.warning("Plugin %s: endpoint handler '%s' not found",
                            name, ep_handler_name)

        # Register manifest-declared SSE types
        for sse_type in manifest.get("sse_types", []):
            log.info("Plugin %s: declares SSE type '%s'", name, sse_type)

        registry.register_plugin(info)
        counts[plugin_type] += 1

    # 4. Check for route conflicts
    route_table.check_conflicts()

    # 5. Summary
    total = sum(counts.values())
    log.info("Loaded %d plugin(s): %d integrated, %d standalone, %d on-demand",
             total, counts["integrated"], counts["standalone"], counts["on-demand"])
    if skipped:
        log.warning("Skipped %d plugin(s) due to dependency cycles: %s",
                    len(skipped), skipped)

    return registry
