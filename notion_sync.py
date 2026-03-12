"""Notion API integration for quest sync — fetches Today todos and maps to quest events."""
import json
import os
import urllib.request
import realm_db

NOTION_API_VERSION = "2022-06-28"
NOTION_BASE = "https://api.notion.com/v1"

# Priority/Size options include emoji prefixes in Notion (e.g. "🔴 High")
# We strip the emoji for mapping but display the full text
_PRI_COLOR = {
    "High": "rgba(255,80,60,0.6)",
    "Medium": "rgba(255,200,60,0.6)",
    "Low": "rgba(100,200,100,0.6)",
}

def _strip_emoji_prefix(s):
    """Strip leading emoji + space from Notion select values like '🔴 High' → 'High'."""
    parts = s.split(" ", 1)
    return parts[1] if len(parts) > 1 and len(parts[0]) <= 2 else s

# Synced page IDs persisted in DB (survives restarts)
_synced_ids = None  # lazy-loaded


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
    return ""


def _get_select(prop):
    if prop.get("type") == "select" and prop.get("select"):
        return prop["select"].get("name", "")
    if prop.get("type") == "multi_select":
        return ", ".join(s.get("name", "") for s in prop.get("multi_select", []))
    return ""


def _get_date(prop):
    if prop.get("type") == "date" and prop.get("date"):
        return prop["date"].get("start", "")
    return ""


def configured():
    """Check if Notion integration is configured."""
    has_key = bool(os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN"))
    has_db = bool(os.environ.get("NOTION_DATABASE_ID"))
    return has_key and has_db


def fetch_today():
    """Fetch todos with Status='Today' from Notion database."""
    db_id = os.environ.get("NOTION_DATABASE_ID", "")
    if not configured():
        return {"error": "Set NOTION_TOKEN and NOTION_DATABASE_ID env vars"}

    result = _api(
        "POST",
        f"/databases/{db_id}/query",
        {
            "filter": {"property": "Status", "select": {"equals": "Today"}},
            "sorts": [{"property": "Priority", "direction": "ascending"}],
        },
    )

    quests = []
    for page in result.get("results", []):
        p = page.get("properties", {})
        name = _get_text(p.get("Name", {}))
        if not name:
            continue
        priority_raw = _get_select(p.get("Priority", {}))
        size_raw = _get_select(p.get("Size", {}))
        life_area = _get_select(p.get("Life Area", {}))
        due = _get_date(p.get("Due", {}))
        priority = _strip_emoji_prefix(priority_raw) if priority_raw else ""

        # Build quest text: priority emoji + name + life area + due
        parts = []
        if priority_raw:
            parts.append(priority_raw.split(" ")[0])  # just the emoji
        parts.append(name)
        if life_area:
            parts.append(f"[{life_area}]")
        if due:
            parts.append(f"\u2022 {due}")
        text = " ".join(parts)

        quests.append(
            {
                "notion_id": page["id"],
                "text": text,
                "name": name,
                "priority": priority,
                "size": _strip_emoji_prefix(size_raw) if size_raw else "",
                "life_area": life_area,
                "due": due,
            }
        )
    return {"quests": quests, "count": len(quests)}


def _get_synced_ids():
    global _synced_ids
    if _synced_ids is None:
        try:
            _synced_ids = realm_db.get_notion_synced()
        except Exception:
            _synced_ids = set()
    return _synced_ids


def sync_to_events():
    """Fetch today's todos, return new ones as quest events (pushes to caller)."""
    data = fetch_today()
    if "error" in data:
        return data
    synced = _get_synced_ids()
    events = []
    for q in data["quests"]:
        nid = q["notion_id"]
        if nid in synced:
            continue
        synced.add(nid)
        realm_db.add_notion_synced(nid)
        events.append(
            {
                "type": "quest",
                "node": "notion-portal",
                "text": q["text"],
                "color": _PRI_COLOR.get(q["priority"], "rgba(160,120,255,0.6)"),
                "_source": "notion",
                "_notion_id": nid,
            }
        )
    return {"events": events, "new": len(events), "total": data["count"]}


def complete(notion_id):
    """Set a Notion page status to Archive."""
    if not (os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN")):
        return {"error": "NOTION_TOKEN not set"}
    _api("PATCH", f"/pages/{notion_id}", {
        "properties": {"Status": {"status": {"name": "Archive"}}}
    })
    synced = _get_synced_ids()
    synced.discard(notion_id)
    realm_db.remove_notion_synced(notion_id)
    return {"ok": True, "id": notion_id}


def force_resync():
    """Clear synced IDs so next sync fetches everything again."""
    global _synced_ids
    _synced_ids = set()
    realm_db.clear_notion_synced()
    return {"ok": True, "cleared": True}
