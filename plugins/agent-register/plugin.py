"""The Heralds' Gate — active agent auto-registration.

A host runs a tiny systemd timer that POSTs /register every 5 minutes with
its hostname, IP, and declared metadata (role, OS, tags). The server
creates / updates a topology node, applies role + tags from the metadata,
and tracks freshness. Stops heartbeating for >15 min → status='dormant'.

Zabbix-inspired (issue #9). Composes with #3 role templates.
"""

import json
import logging
import time

import realm_db

log = logging.getLogger(__name__)

_ctx = None
_db = None

DORMANT_AFTER_SECONDS = 900   # 15 min — match Zabbix's default
PRUNE_AFTER_DAYS = 30          # don't auto-delete forever-gone agents either


def _init_table():
    _db.create_table(
        "agents",
        """
        hostname     TEXT PRIMARY KEY,
        ip           TEXT,
        role         TEXT,
        first_seen   REAL,
        last_seen    REAL,
        metadata     TEXT DEFAULT '{}',
        token        TEXT
        """,
    )


def _agent_to_dict(row, now):
    try:
        meta = json.loads(row.get("metadata") or "{}")
    except (TypeError, json.JSONDecodeError):
        meta = {}
    last_seen = row.get("last_seen") or 0
    age = now - last_seen if last_seen else 0
    status = "active"
    if age > DORMANT_AFTER_SECONDS:
        status = "dormant"
    return {
        "hostname": row["hostname"],
        "ip": row.get("ip") or "",
        "role": row.get("role") or "",
        "first_seen": row.get("first_seen") or 0,
        "last_seen": last_seen,
        "age_seconds": age,
        "status": status,
        "metadata": meta,
    }


def _list_agents():
    now = time.time()
    rows = _db.query(
        "SELECT hostname, ip, role, first_seen, last_seen, metadata, token "
        "FROM plugin_agent_register_agents ORDER BY hostname"
    )
    return [_agent_to_dict(r, now) for r in rows]


def _get_agent(hostname):
    rows = _db.query(
        "SELECT hostname, ip, role, first_seen, last_seen, metadata, token "
        "FROM plugin_agent_register_agents WHERE hostname = ?",
        (hostname,),
    )
    if not rows:
        return None
    return _agent_to_dict(rows[0], time.time())


# ── Apply registration → topology ──

def _apply_to_topology(agent):
    """Upsert a topology node for this agent, carrying os/tags/role through.

    Idempotent — re-registrations refresh the row but don't churn it.
    """
    hostname = agent["hostname"]
    meta = agent.get("metadata", {})

    # Build a topology row update — only set fields we have signal on.
    body = {"id": hostname}
    if agent.get("ip"):
        body["ip"] = agent["ip"]
    if agent.get("role"):
        body["_role"] = agent["role"]
    # Pass OS through so node_roles + ansible inventory can use it
    if meta.get("os"):
        body["os"] = meta["os"]
    if meta.get("os_version"):
        body["os_version"] = meta["os_version"]
    if meta.get("os_pretty"):
        body["os_pretty"] = meta["os_pretty"]
    # Tags merge: keep existing, add new
    existing_node = realm_db.get_node(hostname) or {}
    existing_tags = set(existing_node.get("tags") or [])
    new_tags = set(meta.get("tags") or [])
    new_tags.add("self-registered")
    if meta.get("os"):
        new_tags.add(meta["os"])
    merged_tags = sorted(existing_tags | new_tags)
    body["tags"] = merged_tags

    # If this is a brand-new node, give it a label and default position
    if not existing_node:
        body["label"] = meta.get("label") or f"The Newcomer ({hostname})"
        body["type"] = meta.get("type") or "core"
        # Stash near origin — JP can drag it on the map
        body["x"] = 100
        body["y"] = 100

    # Merge with existing so we don't drop fields like x/y the user has set
    merged = {**existing_node, **body}
    realm_db.set_node(hostname, merged)


# ── Handlers ──

def _h_post_register(req, params):
    """POST /register — agent self-announce.

    Body: {hostname, ip, metadata: {os, os_version, role, tags, ...}, token?}
    """
    body = req.json() or {}
    hostname = (body.get("hostname") or "").strip()
    if not hostname:
        return req.respond({"error": "hostname is required"}, 400)
    ip = (body.get("ip") or "").strip()
    metadata = body.get("metadata") or {}
    role = body.get("role") or metadata.get("role") or ""
    token = body.get("token") or ""

    now = time.time()
    existing = _get_agent(hostname)
    first_seen = existing["first_seen"] if existing else now

    _db.execute(
        """INSERT OR REPLACE INTO plugin_agent_register_agents
           (hostname, ip, role, first_seen, last_seen, metadata, token)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (hostname, ip, role, first_seen, now, json.dumps(metadata), token),
    )

    agent = _get_agent(hostname)
    _apply_to_topology(agent)

    if not existing:
        log.info("New agent registered: %s (role=%s)", hostname, role)
        # Emit a quest-grade event so the map shows the arrival
        _ctx.push_event("system", {
            "subtype": "agent_registered",
            "node": hostname,
            "text": f"A new presence joins the realm: {hostname}",
            "color": "#60c060",
        })

    return req.respond({"ok": True, "agent": agent})


def _h_get_agents(req, params):
    return req.respond({"agents": _list_agents()})


def _h_get_agent(req, params):
    hostname = params.get("hostname", "")
    agent = _get_agent(hostname)
    if not agent:
        return req.respond({"error": f"no such agent: {hostname}"}, 404)
    return req.respond(agent)


def _h_delete_agent(req, params):
    hostname = params.get("hostname", "")
    _db.execute("DELETE FROM plugin_agent_register_agents WHERE hostname = ?", (hostname,))
    return req.respond({"ok": True, "forgotten": hostname})


def _h_get_install_sh(req, params):
    """GET /register/install.sh — return the one-liner installer script.

    The new host runs:
      curl -s http://<realm-host>/register/install.sh | bash -s -- --role <ROLE> [--tag t1] [--tag t2]
    """
    # Determine the realm URL from the request itself when possible
    realm_url = ""
    try:
        host_hdr = req.headers.get("Host", "")
        realm_url = f"http://{host_hdr}" if host_hdr else "http://localhost"
    except Exception:
        realm_url = "http://localhost"

    script = _INSTALL_SCRIPT.replace("__REALM_URL__", realm_url)
    # respond_html sets text/html but curl | bash doesn't care about MIME type.
    # Using HTML rather than building a custom text/x-shellscript response.
    req.respond_html(script)


# ── Dormant marker (runs as background thread) ──

import threading


def _dormant_loop():
    """Mark long-quiet agents as dormant. Doesn't delete — operator's call."""
    while True:
        try:
            now = time.time()
            cutoff = now - DORMANT_AFTER_SECONDS
            stale = _db.query(
                "SELECT hostname FROM plugin_agent_register_agents WHERE last_seen < ?",
                (cutoff,),
            )
            if stale:
                log.info("agent-register: %d host(s) dormant (>%ds since heartbeat)",
                         len(stale), DORMANT_AFTER_SECONDS)
        except Exception:
            pass
        time.sleep(120)  # check every 2 min


# ── Setup ──

def setup(ctx):
    global _ctx, _db
    _ctx = ctx
    _db = ctx.db
    _init_table()

    ctx.register_endpoint("POST",   "/register",                   _h_post_register, raw_path=True)
    ctx.register_endpoint("GET",    "/register/agents",            _h_get_agents,    raw_path=True)
    ctx.register_endpoint("GET",    "/register/agents/<hostname>", _h_get_agent,     raw_path=True)
    ctx.register_endpoint("DELETE", "/register/agents/<hostname>", _h_delete_agent,  raw_path=True)
    ctx.register_endpoint("GET",    "/register/install.sh",        _h_get_install_sh,raw_path=True)

    # Background thread (daemon=True so realm shutdown doesn't hang)
    t = threading.Thread(target=_dormant_loop, daemon=True, name="agent-register-dormant")
    t.start()

    ctx.log("The Heralds' Gate is open — agent registration listening at /register")


# ── Install script template ──

_INSTALL_SCRIPT = r"""#!/usr/bin/env bash
# realm-agent — one-line install for a new realm-managed host.
#
# Usage (run as root on the new host):
#   curl -s __REALM_URL__/register/install.sh | bash -s -- --role docker-host --tag lab
#
# What this installs:
#   /usr/local/bin/realm-agent-heartbeat   — a 30-line script that POSTs metadata
#   ~/.config/systemd/user/realm-agent.{service,timer}  — fires every 5 min
#
# Idempotent — re-running just refreshes the config.

set -euo pipefail

REALM_URL="__REALM_URL__"
ROLE=""
declare -a TAGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --role=*) ROLE="${1#*=}"; shift ;;
    --tag) TAGS+=("$2"); shift 2 ;;
    --tag=*) TAGS+=("${1#*=}"); shift ;;
    --realm) REALM_URL="$2"; shift 2 ;;
    --realm=*) REALM_URL="${1#*=}"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── heartbeat script ──
sudo tee /usr/local/bin/realm-agent-heartbeat > /dev/null <<'HBEOF'
#!/usr/bin/env bash
set -euo pipefail
REALM_URL="${REALM_URL:-__REALM_URL__}"
ROLE="${REALM_ROLE:-}"
TAGS="${REALM_TAGS:-}"

hostname=$(hostname -s)
ip=$(hostname -I | awk '{print $1}')

# Source /etc/os-release for OS metadata
os=""; os_version=""; os_pretty=""
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  os="$ID"; os_version="$VERSION_ID"; os_pretty="$PRETTY_NAME"
fi

# Build metadata JSON
tags_json=$(echo "$TAGS" | tr ',' '\n' | grep -v '^$' | jq -R . | jq -s .)
metadata=$(jq -n \
  --arg os "$os" --arg ver "$os_version" --arg pretty "$os_pretty" \
  --arg role "$ROLE" --argjson tags "$tags_json" \
  '{os:$os, os_version:$ver, os_pretty:$pretty, role:$role, tags:$tags}')

body=$(jq -n --arg h "$hostname" --arg i "$ip" --arg r "$ROLE" --argjson m "$metadata" \
  '{hostname:$h, ip:$i, role:$r, metadata:$m}')

curl --silent --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  --data "$body" \
  "$REALM_URL/register" >/dev/null || true
HBEOF
sudo chmod +x /usr/local/bin/realm-agent-heartbeat

# ── env for the heartbeat ──
sudo mkdir -p /etc/realm-agent
sudo tee /etc/realm-agent/env > /dev/null <<EOF
REALM_URL=$REALM_URL
REALM_ROLE=$ROLE
REALM_TAGS=$(IFS=,; echo "${TAGS[*]+${TAGS[*]}}")
EOF

# ── systemd user units ──
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/realm-agent.service <<EOF
[Unit]
Description=Realm agent — heartbeat to $REALM_URL

[Service]
Type=oneshot
EnvironmentFile=/etc/realm-agent/env
ExecStart=/usr/local/bin/realm-agent-heartbeat
EOF

cat > ~/.config/systemd/user/realm-agent.timer <<EOF
[Unit]
Description=Realm agent heartbeat every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now realm-agent.timer

# Fire one immediate heartbeat so the host shows up right away
/usr/local/bin/realm-agent-heartbeat || true

echo ""
echo "✓ realm-agent installed and registered."
echo "  Heartbeat:    every 5 min via systemd timer"
echo "  Tail logs:    journalctl --user -u realm-agent -f"
echo "  Realm host:   $REALM_URL"
[[ -n "$ROLE" ]] && echo "  Role:         $ROLE"
[[ ${#TAGS[@]} -gt 0 ]] && echo "  Tags:         ${TAGS[*]}"
"""
