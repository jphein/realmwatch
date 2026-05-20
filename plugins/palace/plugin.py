"""Palace plugin — mempalace + palace-daemon bridge for realmwatch.

This plugin gives realmwatch:

1. **Search/recall surface.** ``GET /palace/{health,search,recall,list}``
   proxies palace-daemon at ``disks.jphe.in:8085`` (configurable). Other
   plugins consume the same surface via ``ctx.get_plugin_api("palace")`` →
   ``{search, recall, list, health, deposit}``.

2. **Auto-deposit on significant events.** Subscribes to ``realm-event``,
   ``xp.grant``, and ``alert`` via ``ctx.on_event`` and routes them to the
   right wing/room in the palace, with per-(event-type, node) rate
   limiting. See ``deposit_router.py`` for the full taxonomy.

3. **MCP tools.** ``mcp_tools.py`` exposes ``palace_search``,
   ``palace_recall``, ``palace_list``, ``palace_deposit``, and
   ``palace_health`` to Claude Code via the Astral Conduit.

4. **CLI integration point.** ``scripts/cli/realm-recall.sh`` is a new
   verb that curls ``/palace/search`` directly; ``realm find`` can pick
   up palace results as a 6th source by consuming the exposed API.

URL resolution order (highest to lowest precedence):
  1. ``PALACE_DAEMON_URL`` env var
  2. ``realm_fleet.host_ip("palace-daemon")`` from fleet.yaml
  3. Hardcoded fallback ``http://disks.jphe.in:8085``

If palace-daemon is unreachable, the plugin still LOADS — endpoints return
the upstream error gracefully, the deposit router logs and drops, and the
realmwatch HTTP server stays up.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Path-injection per CLAUDE.md realm-sigil precedent — realm_fleet lives
# at the realmwatch repo root and uses lexicon under
# ~/Projects/lexicon.realm.watch/python.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from .client import PalaceClient  # noqa: E402
from .deposit_router import DepositRouter  # noqa: E402


DEFAULT_FALLBACK_URL = "http://disks.jphe.in:8085"


def _resolve_palace_url(log) -> str:
    """Resolve the palace-daemon base URL.

    Order:
      1. ``PALACE_DAEMON_URL`` env var (overrides everything)
      2. ``realm_fleet.host_ip("palace-daemon")`` from fleet.yaml
      3. Hardcoded fallback ``http://disks.jphe.in:8085``

    The fleet entry's ``ops_ip`` is stored as ``10.0.6.120:8085`` (host:port).
    We prepend ``http://`` if the resolved value doesn't already include a
    scheme.
    """
    env = os.environ.get("PALACE_DAEMON_URL", "").strip()
    if env:
        log("using PALACE_DAEMON_URL=%s", env)
        return env

    try:
        import realm_fleet  # type: ignore
        host_ip = realm_fleet.host_ip("palace-daemon")
    except Exception as exc:
        log("realm_fleet lookup failed (%s); falling back to %s",
            exc.__class__.__name__, DEFAULT_FALLBACK_URL)
        return DEFAULT_FALLBACK_URL

    if not host_ip:
        log("fleet has no palace-daemon entry; falling back to %s",
            DEFAULT_FALLBACK_URL)
        return DEFAULT_FALLBACK_URL

    # Add scheme if missing.
    if not host_ip.startswith(("http://", "https://")):
        host_ip = f"http://{host_ip}"
    log("resolved palace-daemon via fleet: %s", host_ip)
    return host_ip


# ── HTTP handlers ──────────────────────────────────────────────────────────


def _make_handlers(client: PalaceClient):
    """Build closure-bound handlers that share a single PalaceClient."""

    def health_handler(req, _params):
        ok, payload = client.health()
        if not ok:
            return req.respond(payload, status=502)
        return req.respond(payload)

    def search_handler(req, _params):
        qp = req.query_params
        q = qp.get("q") or qp.get("query") or ""
        if not q:
            return req.respond({"error": "q (query) is required"}, status=400)
        try:
            limit = max(1, min(int(qp.get("limit") or 10), 100))
        except (TypeError, ValueError):
            limit = 10
        wing = qp.get("wing") or None
        room = qp.get("room") or None
        hybrid = (qp.get("hybrid") or "").lower() in ("1", "true", "yes")
        ok, payload = client.search(q, limit=limit, wing=wing, room=room,
                                    hybrid=hybrid)
        if not ok:
            return req.respond(payload, status=502)
        return req.respond(payload)

    def recall_handler(req, params):
        # Route is registered as /palace/recall/<drawer_id> — route_table
        # extracts the trailing segment into params["drawer_id"]. Fall back
        # to a query-string drawer_id for ergonomics.
        drawer_id = (params or {}).get("drawer_id") or ""
        if not drawer_id:
            qp = req.query_params
            drawer_id = qp.get("drawer_id") or qp.get("id") or ""
        if not drawer_id:
            return req.respond({"error": "drawer_id required in path"}, status=400)
        ok, payload = client.recall(drawer_id)
        if not ok:
            status = 404 if isinstance(payload, dict) and payload.get("status") == 404 else 502
            return req.respond(payload, status=status)
        return req.respond(payload)

    def list_handler(req, _params):
        qp = req.query_params
        wing = qp.get("wing") or None
        room = qp.get("room") or None
        try:
            limit = max(1, min(int(qp.get("limit") or 50), 500))
        except (TypeError, ValueError):
            limit = 50
        try:
            offset = max(0, int(qp.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        ok, payload = client.list_drawers(wing=wing, room=room,
                                          limit=limit, offset=offset)
        if not ok:
            return req.respond(payload, status=502)
        return req.respond(payload)

    def deposit_handler(req, _params):
        body = req.json() or {}
        wing = (body.get("wing") or "").strip()
        room = (body.get("room") or "").strip()
        title = (body.get("title") or "").strip()
        deposit_body = body.get("body") or ""
        if not wing or not room or not title:
            return req.respond(
                {"error": "wing, room, and title are required"}, status=400)
        ok, payload = client.deposit(
            wing=wing, room=room, title=title, body=deposit_body)
        if not ok:
            return req.respond(payload, status=502)
        return req.respond(payload)

    return {
        "health": health_handler,
        "search": search_handler,
        "recall": recall_handler,
        "list": list_handler,
        "deposit": deposit_handler,
    }


# ── plugin entry ───────────────────────────────────────────────────────────


def setup(ctx):
    """Plugin entry point — see module docstring."""
    base_url = _resolve_palace_url(ctx.log)
    client = PalaceClient(base_url=base_url)
    router = DepositRouter(client, log=ctx.log)

    # ── HTTP endpoints (raw_path so they live at /palace/* not /plugins/palace/*) ──
    handlers = _make_handlers(client)
    ctx.register_endpoint("GET",  "/palace/health", handlers["health"],  raw_path=True)
    ctx.register_endpoint("GET",  "/palace/search", handlers["search"],  raw_path=True)
    ctx.register_endpoint("GET",  "/palace/list",   handlers["list"],    raw_path=True)
    ctx.register_endpoint("POST", "/palace/deposit", handlers["deposit"], raw_path=True)

    # /palace/recall/<drawer_id> — route_table extracts the trailing
    # segment into params["drawer_id"]. Also expose /palace/recall (no id)
    # for a 400 with usage info.
    ctx.register_endpoint("GET",  "/palace/recall/<drawer_id>",
                          handlers["recall"], raw_path=True)
    ctx.register_endpoint("GET",  "/palace/recall",
                          handlers["recall"], raw_path=True)

    # ── Cross-plugin API ────────────────────────────────────────────────────
    ctx.expose_api({
        # Each returns (ok, payload) — same shape as the client.
        "search": client.search,
        "recall": client.recall,
        "list": client.list_drawers,
        "health": client.health,
        "deposit": client.deposit,
        # Convenience: a simple search wrapper that returns just the
        # results list (for realm-find integration — see findings).
        "palace_search": _palace_search_adapter(client),
        # Direct access to the underlying client for any plugin that
        # wants more control. Convention: prefer the named functions.
        "_client": client,
        "_router": router,
        "base_url": base_url,
    })

    # ── Event subscriptions (auto-deposit) ─────────────────────────────────
    ctx.on_event("realm-event", router.on_realm_event)
    ctx.on_event("xp.grant", router.on_xp_grant)
    ctx.on_event("alert", router.on_alert)
    # quest.completed is also fired as a standalone event by some plugins.
    # The realm-event dispatch covers `{kind: quest.completed}` shape;
    # this covers `quest.completed` as the direct event_type.
    ctx.on_event("quest.completed",
                 lambda e: router.on_realm_event({**(e or {}), "kind": "quest.completed"}))

    ctx.log("The Memory Palace — bridge to %s ready (5 endpoints, %d "
            "auto-deposit triggers)", base_url, 4)


def _palace_search_adapter(client: PalaceClient):
    """Adapter used by ``realm find`` (and other CLI tools) to consume
    palace results in the same flat-list shape the other 5 sources use.

    Returns a list of ``{title, wing, room, score, drawer_id}`` dicts,
    one per result. On error returns an empty list (graceful skip).
    """
    def _search(query: str, limit: int = 10) -> list[dict]:
        try:
            ok, payload = client.search(query, limit=limit)
        except Exception:
            return []
        if not ok or not isinstance(payload, dict):
            return []
        results = (payload.get("results")
                   or payload.get("memories")
                   or payload.get("items") or [])
        if not isinstance(results, list):
            return []
        out: list[dict] = []
        for r in results:
            if not isinstance(r, dict):
                continue
            out.append({
                "title": r.get("title") or r.get("name") or "",
                "wing": r.get("wing") or "",
                "room": r.get("room") or "",
                "score": r.get("score") or r.get("similarity") or 0,
                "drawer_id": r.get("id") or r.get("drawer_id") or "",
            })
        return out
    return _search
