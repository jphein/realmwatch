"""Thin HTTP wrapper over palace-daemon.

palace-daemon (techempower-org fork) fronts the 273K-drawer mempalace and
exposes a REST surface for search, deposit, list, graph, and CRUD. This
client wraps the subset realmwatch needs with sane timeouts and graceful
failure — palace-daemon may be unreachable (LAN-only, off the host, etc.),
and the realmwatch plugin must keep loading either way.

All methods return ``(ok, payload)`` tuples on the public surface, where
``ok`` is a bool and ``payload`` is the decoded JSON on success or an
``{"error": "..."}`` dict on failure. The HTTP-endpoint handlers translate
that into the right status code.

Endpoints used (palace-daemon v1.7.2 + unreleased main):
  GET    /health
  GET    /search?q=&limit=
  POST   /search/hybrid             (body: {"query": "...", "limit": N})
  GET    /list?wing=&room=&limit=&offset=
  POST   /memory                    (deposit: {wing, room, title, body})
  POST   /mcp                       (recall: JSON-RPC tools/call →
                                     mempalace_get_drawer. palace-daemon's
                                     REST surface does NOT expose
                                     GET /memory/{id}.)

Auth: palace-daemon honours ``X-Api-Key`` when ``PALACE_API_KEY`` is set in
its environment. This client reads ``PALACE_API_KEY`` from realmwatch's
environment and sends it along on every request; if the daemon is running
without auth, the header is harmless.
"""

from __future__ import annotations

import os
from typing import Any, Optional

import httpx


DEFAULT_TIMEOUT = 8.0  # seconds — palace-daemon /search can take a beat on cold start
DEFAULT_DEPOSIT_TIMEOUT = 12.0  # silent-save / deposit paths run a bit longer


class PalaceClient:
    """Thin HTTP client for palace-daemon.

    Args:
        base_url: palace-daemon base URL, e.g.
                  ``"http://palace-daemon.example.com:8085"``. Resolved by
                  the caller (plugin or mcp_tools) via env > realm_fleet —
                  this class never bakes in a host.
                  Trailing slash is stripped.
        api_key:  Optional ``X-Api-Key`` header. Reads ``PALACE_API_KEY`` from
                  the environment when ``None``.
        timeout:  Default request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("PALACE_API_KEY")
        self.timeout = timeout

    # ── internal ─────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.api_key:
            h["X-Api-Key"] = self.api_key
        return h

    def _get(self, path: str, params: Optional[dict] = None,
             timeout: Optional[float] = None) -> tuple[bool, Any]:
        url = f"{self.base_url}{path}"
        try:
            r = httpx.get(
                url,
                params=params or {},
                headers=self._headers(),
                timeout=timeout or self.timeout,
            )
        except httpx.HTTPError as exc:
            return False, {"error": f"palace-daemon unreachable: {exc.__class__.__name__}: {exc}"}
        except Exception as exc:  # pragma: no cover — defensive
            return False, {"error": f"palace-daemon error: {exc.__class__.__name__}: {exc}"}
        if r.status_code >= 400:
            return False, {
                "error": f"palace-daemon {r.status_code}",
                "body": (r.text[:500] if r.text else ""),
                "status": r.status_code,
            }
        try:
            return True, r.json()
        except ValueError:
            return True, {"raw": r.text}

    def _post(self, path: str, body: dict,
              timeout: Optional[float] = None) -> tuple[bool, Any]:
        url = f"{self.base_url}{path}"
        try:
            r = httpx.post(
                url,
                json=body,
                headers={**self._headers(), "Content-Type": "application/json"},
                timeout=timeout or self.timeout,
            )
        except httpx.HTTPError as exc:
            return False, {"error": f"palace-daemon unreachable: {exc.__class__.__name__}: {exc}"}
        except Exception as exc:  # pragma: no cover
            return False, {"error": f"palace-daemon error: {exc.__class__.__name__}: {exc}"}
        if r.status_code >= 400:
            return False, {
                "error": f"palace-daemon {r.status_code}",
                "body": (r.text[:500] if r.text else ""),
                "status": r.status_code,
            }
        try:
            return True, r.json()
        except ValueError:
            return True, {"raw": r.text}

    # ── public ──────────────────────────────────────────────────────────────

    def health(self) -> tuple[bool, Any]:
        """Liveness + version from palace-daemon."""
        return self._get("/health", timeout=3.0)

    def search(self, query: str, limit: int = 10,
               wing: Optional[str] = None, room: Optional[str] = None,
               hybrid: bool = False) -> tuple[bool, Any]:
        """Semantic search. When ``hybrid`` is set, POSTs to /search/hybrid
        (vector ∪ BM25 ∪ AGE-graph candidates, rrf-fused). Otherwise GETs
        /search?q=…&limit=N. ``wing`` / ``room`` are advisory filters applied
        client-side over the daemon's response payload — /search itself does
        not always honour them (palace-daemon falls back to BM25 for
        non-embeddable queries and ignores wing filtering there).
        """
        if hybrid:
            body: dict[str, Any] = {"query": query, "limit": max(1, min(int(limit), 100))}
            if wing:
                body["wing"] = wing
            if room:
                body["room"] = room
            ok, payload = self._post("/search/hybrid", body)
        else:
            params: dict[str, Any] = {"q": query, "limit": max(1, min(int(limit), 100))}
            if wing:
                params["wing"] = wing
            if room:
                params["room"] = room
            ok, payload = self._get("/search", params=params)
        if not ok:
            return ok, payload
        # Best-effort client-side filter when the daemon returned a list of
        # results and wing/room were specified. Defensive: many shapes exist.
        if (wing or room) and isinstance(payload, dict):
            results = payload.get("results") or payload.get("memories") or payload.get("items")
            if isinstance(results, list):
                filtered = [
                    r for r in results
                    if (not wing or (r.get("wing") == wing))
                    and (not room or (r.get("room") == room))
                ]
                payload = dict(payload)
                payload["results"] = filtered
                payload["count"] = len(filtered)
        return ok, payload

    def recall(self, drawer_id: str) -> tuple[bool, Any]:
        """Fetch one drawer by id.

        palace-daemon's REST surface doesn't expose a ``GET /memory/{id}``
        endpoint (DELETE/PATCH only); the equivalent is the
        ``mempalace_get_drawer`` MCP tool, which we invoke via the
        ``POST /mcp`` JSON-RPC passthrough.
        """
        if not drawer_id:
            return False, {"error": "drawer_id required"}
        rpc = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "mempalace_get_drawer",
                "arguments": {"drawer_id": drawer_id},
            },
        }
        ok, payload = self._post("/mcp", rpc)
        if not ok:
            return ok, payload
        # JSON-RPC envelope: {"jsonrpc": "2.0", "id": 1, "result": {...}} or
        # {"jsonrpc": "2.0", "id": 1, "error": {...}}. Unwrap so the caller
        # gets the drawer dict directly.
        if isinstance(payload, dict):
            if "error" in payload and payload.get("error"):
                return False, {"error": payload["error"]}
            result = payload.get("result")
            if isinstance(result, dict):
                # mempalace_get_drawer returns either the drawer dict or a
                # {"content": [{"text": "..."}]} MCP-content envelope. Unwrap
                # the latter if present.
                content = result.get("content")
                if isinstance(content, list) and content:
                    first = content[0]
                    if isinstance(first, dict) and first.get("type") == "text":
                        import json as _json
                        try:
                            return True, _json.loads(first.get("text") or "")
                        except (ValueError, TypeError):
                            return True, first
                return True, result
            return True, payload
        return True, payload

    def list_drawers(self, wing: Optional[str] = None,
                     room: Optional[str] = None,
                     limit: int = 50,
                     offset: int = 0) -> tuple[bool, Any]:
        """Query-free metadata browse via GET /list."""
        params: dict[str, Any] = {
            "limit": max(1, min(int(limit), 500)),
            "offset": max(0, int(offset)),
        }
        if wing:
            params["wing"] = wing
        if room:
            params["room"] = room
        return self._get("/list", params=params)

    def deposit(self, wing: str, room: str, title: str,
                body: str) -> tuple[bool, Any]:
        """Drop a new drawer into the palace via POST /memory.

        Returns the daemon's response (typically ``{"id": "...", "ok": true}``
        but exact shape varies by mempalace version — we pass-through).
        """
        if not wing or not room or not title:
            return False, {"error": "wing, room, and title are required"}
        payload = {
            "wing": wing,
            "room": room,
            "title": title,
            "body": body or "",
        }
        return self._post("/memory", payload,
                          timeout=DEFAULT_DEPOSIT_TIMEOUT)
