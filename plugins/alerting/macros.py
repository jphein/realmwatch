"""User macros — host/role/global parameterization for alerting rules.

Zabbix-inspired (issue #7). A rule like {"threshold": "{$DISK_FULL_PCT}"}
gets expanded against the node's macro scope chain before match_rule sees
it. One template, per-host overrides, no rule duplication.

Resolution order (first hit wins):
  1. macros.host:<node_id>.<NAME>   — most specific
  2. macros.role:<role>.<NAME>      — role default (composes with #3)
  3. macros.global.<NAME>           — fleet-wide default

Macros are stored in the existing `settings` table under three namespaces.
No new schema.
"""

import re
import logging

import realm_db

log = logging.getLogger(__name__)

MACRO_PATTERN = re.compile(r"\{\$([A-Z][A-Z0-9_]*)\}")


def _ns_host(node_id: str) -> str:
    return f"macros.host:{node_id}"


def _ns_role(role: str) -> str:
    return f"macros.role:{role}"


_NS_GLOBAL = "macros.global"


def get_macro(name: str, node_id: str = "", role: str = "", default=None):
    """Resolve one macro by name, walking host → role → global. Returns default
    if no scope provides a value."""
    if node_id:
        v = realm_db.get_setting(_ns_host(node_id), name, None)
        if v is not None:
            return v
    if role:
        v = realm_db.get_setting(_ns_role(role), name, None)
        if v is not None:
            return v
    v = realm_db.get_setting(_NS_GLOBAL, name, None)
    if v is not None:
        return v
    return default


def set_macro(name: str, value, scope: str = "global", node_id: str = "", role: str = ""):
    """Set a macro at the given scope. scope ∈ {host, role, global}."""
    if scope == "host":
        if not node_id:
            raise ValueError("host scope requires node_id")
        ns = _ns_host(node_id)
    elif scope == "role":
        if not role:
            raise ValueError("role scope requires role")
        ns = _ns_role(role)
    elif scope == "global":
        ns = _NS_GLOBAL
    else:
        raise ValueError(f"unknown scope: {scope}")
    realm_db.set_settings(ns, {name: value})


def delete_macro(name: str, scope: str = "global", node_id: str = "", role: str = ""):
    """Delete a macro at a specific scope. Other scopes are unaffected."""
    if scope == "host":
        ns = _ns_host(node_id)
    elif scope == "role":
        ns = _ns_role(role)
    elif scope == "global":
        ns = _NS_GLOBAL
    else:
        raise ValueError(f"unknown scope: {scope}")
    realm_db.delete_setting(ns, name)


def list_macros(scope: str = "all", node_id: str = "", role: str = "") -> dict:
    """Return macros at the given scope (or all scopes if scope='all').

    Format: {scope_label: {name: value}}
    """
    out: dict = {}
    if scope in ("all", "global"):
        out["global"] = realm_db.get_settings(_NS_GLOBAL)
    if scope in ("all", "role") and role:
        out[f"role:{role}"] = realm_db.get_settings(_ns_role(role))
    elif scope == "all":
        # Discover any role-scoped macros that exist
        all_settings = realm_db.get_settings()
        for ns, values in all_settings.items():
            if ns.startswith("macros.role:") and values:
                out[ns.replace("macros.", "")] = values
    if scope in ("all", "host") and node_id:
        out[f"host:{node_id}"] = realm_db.get_settings(_ns_host(node_id))
    elif scope == "all":
        all_settings = realm_db.get_settings()
        for ns, values in all_settings.items():
            if ns.startswith("macros.host:") and values:
                out[ns.replace("macros.", "")] = values
    return out


def explain(name: str, node_id: str = "", role: str = "") -> dict:
    """Show the full resolution chain for a macro: which scope wins + what
    every scope says. Powers `realm macro explain`."""
    chain = []
    final_value = None
    final_scope = None

    if node_id:
        v = realm_db.get_setting(_ns_host(node_id), name, "__missing__")
        present = v != "__missing__"
        chain.append({"scope": f"host:{node_id}", "value": v if present else None, "present": present})
        if present and final_value is None:
            final_value = v
            final_scope = f"host:{node_id}"

    if role:
        v = realm_db.get_setting(_ns_role(role), name, "__missing__")
        present = v != "__missing__"
        chain.append({"scope": f"role:{role}", "value": v if present else None, "present": present})
        if present and final_value is None:
            final_value = v
            final_scope = f"role:{role}"

    v = realm_db.get_setting(_NS_GLOBAL, name, "__missing__")
    present = v != "__missing__"
    chain.append({"scope": "global", "value": v if present else None, "present": present})
    if present and final_value is None:
        final_value = v
        final_scope = "global"

    return {
        "name": name,
        "node_id": node_id,
        "role": role,
        "chain": chain,
        "value": final_value,
        "resolved_from": final_scope,
    }


def expand(text: str, node_id: str = "", role: str = "") -> str:
    """Replace every {$NAME} token in `text` with its resolved value.

    Unresolved macros are LEFT IN PLACE so partial expansion is visible —
    a missing {$DB_PORT} stays as {$DB_PORT}, not silently emptied. Callers
    that need to detect this can grep the result for `{$`.

    Non-string values are coerced via str() — useful for thresholds where
    the resolved value is an int.
    """
    if not text or "{$" not in text:
        return text

    def replace(m):
        name = m.group(1)
        v = get_macro(name, node_id=node_id, role=role)
        if v is None:
            return m.group(0)  # leave unchanged
        return str(v)

    return MACRO_PATTERN.sub(replace, text)


def expand_dict(d: dict, node_id: str = "", role: str = "") -> dict:
    """Recursively expand macros in every string value in a dict/list tree.

    Used by the rule engine to expand a rule's conditions/threshold/etc.
    before evaluation. Keys are NOT expanded.
    """
    if isinstance(d, dict):
        return {k: expand_dict(v, node_id, role) for k, v in d.items()}
    if isinstance(d, list):
        return [expand_dict(v, node_id, role) for v in d]
    if isinstance(d, str):
        return expand(d, node_id, role)
    return d
