"""Codex plugin — syncs and serves the Realm Codex lore wiki from Notion.

Delegates to codex_sync for API calls.
Provides /codex-sync, /codex, and /codex/ endpoints.
"""

import os

import codex_sync

_MAP_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def handle_codex_sync(req, params):
    """GET /codex-sync — fetch codex entries, optionally force refresh."""
    try:
        force = "force=1" in req.path
        if force:
            codex_sync.fetch_codex(force=True)
        data = codex_sync.get_grouped()
        return data
    except Exception as e:
        req.respond({"error": str(e)}, 500)
        return None


def handle_codex(req, params):
    """GET /codex — redirect to /codex/."""
    req.redirect("/codex/")
    return None


def handle_codex_index(req, params):
    """GET /codex/ — serve the codex HTML page."""
    codex_path = os.path.join(_MAP_DIR, "docs", "codex", "index.html")
    if os.path.isfile(codex_path):
        req._handler.path = "/docs/codex/index.html"
        req._handler._serve_static_gzip()
    else:
        req._handler.send_error(404, "Codex not found")
    return None


def setup(ctx):
    """Plugin setup — expose codex API."""
    ctx.expose_api({
        "fetch_codex": codex_sync.fetch_codex,
        "get_grouped": codex_sync.get_grouped,
    })

    ctx.log("Lore Archives codex sync ready")
