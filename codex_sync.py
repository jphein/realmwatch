"""Sync the Realm Codex from Notion — fetches lore, architecture, guides, and reference entries."""
import json
import os
import time
import urllib.request

NOTION_API_VERSION = "2022-06-28"
NOTION_BASE = "https://api.notion.com/v1"
CODEX_DB_ID = "9a2bee7e-baf9-4ab6-884b-5308e24a5af1"

# Cache: avoid hitting Notion on every request
_cache = {"entries": [], "ts": 0, "ttl": 300}  # 5 min TTL


def _headers():
    key = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN", "")
    return {
        "Authorization": f"Bearer {key}",
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
    }


def _api(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{NOTION_BASE}{path}", data=data, headers=_headers(), method=method
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def _get_text(prop):
    if prop.get("type") == "title":
        return "".join(t.get("plain_text", "") for t in prop.get("title", []))
    if prop.get("type") == "rich_text":
        return "".join(t.get("plain_text", "") for t in prop.get("rich_text", []))
    return ""


def _get_select(prop):
    if prop.get("type") == "select" and prop.get("select"):
        return prop["select"].get("name", "")
    return ""


def _get_number(prop):
    if prop.get("type") == "number" and prop.get("number") is not None:
        return prop["number"]
    return 999


def fetch_codex(force=False):
    """Fetch all codex entries from Notion, with caching."""
    now = time.time()
    if not force and _cache["entries"] and (now - _cache["ts"]) < _cache["ttl"]:
        return _cache["entries"]

    key = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN", "")
    if not key:
        return []

    try:
        result = _api("POST", f"/databases/{CODEX_DB_ID}/query", {
            "sorts": [
                {"property": "Section", "direction": "ascending"},
                {"property": "Order", "direction": "ascending"},
            ],
        })
    except Exception:
        return _cache["entries"]  # return stale on error

    entries = []
    for page in result.get("results", []):
        p = page.get("properties", {})
        name = _get_text(p.get("Name", {}))
        if not name:
            continue
        entries.append({
            "id": page["id"],
            "name": name,
            "section": _get_select(p.get("Section", {})),
            "icon": _get_text(p.get("Icon", {})),
            "order": _get_number(p.get("Order", {})),
            "body": _get_text(p.get("Body", {})),
            "url": page.get("url", ""),
        })

    _cache["entries"] = entries
    _cache["ts"] = now
    return entries


def get_grouped():
    """Return codex entries grouped by section, sorted by order."""
    entries = fetch_codex()
    groups = {}
    for e in entries:
        sec = e["section"] or "Uncategorized"
        groups.setdefault(sec, []).append(e)
    # Sort each group by order
    for sec in groups:
        groups[sec].sort(key=lambda x: x["order"])
    return groups
