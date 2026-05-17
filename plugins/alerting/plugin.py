"""Alerting plugin — Realm Herald's Watch.

Routes realm events to notification channels (desktop, email, webhook, voice,
pushover, SSE toast) based on configurable rules with cooldown tracking.
"""

import json
import logging
import time
import threading

log = logging.getLogger(__name__)

_ctx = None
_cooldown = None
_db = None


# ── Event Handler ──

def _on_event(event):
    """Handle incoming realm events — evaluate rules and dispatch."""
    from .rule_engine import evaluate, detect_severity, CooldownTracker
    from . import channels
    from . import dependencies

    if _cooldown is None:
        return

    severity = detect_severity(event)
    rules = _load_rules()
    rule, channel_names, cooldown = evaluate(event, rules)

    if not rule:
        return

    # Trigger dependencies (Zabbix-inspired, issue #5): suppress child alerts
    # when an upstream node is in problem state. Only applies to critical/
    # warning alerts on real nodes — info-level events and node-less events
    # (e.g. system-updates run_complete) flow through unaffected.
    node_id = event.get("node", "")
    if node_id and severity in ("critical", "warning"):
        blocking = dependencies.find_blocking_ancestor(_db, node_id)
        dependencies._record_decision(node_id, blocking, event.get("type", ""), severity)
        if blocking:
            _log_alert(event, severity, rule.get("name", ""),
                       "all", "suppressed_by_parent", blocking)
            log.info("Suppressed alert for %s: blocking ancestor %s is in problem state",
                     node_id, blocking)
            return

    # Acknowledgement suppression (Zabbix-inspired, issue #8): if a matching
    # event from the same (type, node, text-prefix) was already acked and not
    # closed, the human is on it — don't re-page. Both alerts and discovery
    # events benefit; speech/info events flow through.
    if node_id and severity in ("critical", "warning"):
        import realm_db
        prior = realm_db.find_recent_acked_event(
            event.get("type", ""), node_id, event.get("text", "")
        )
        if prior:
            _log_alert(event, severity, rule.get("name", ""),
                       "all", "ack_suppressed", f"acked_by:{prior.get('ack_by','?')}")
            log.info("Suppressed alert for %s: prior event %s acked by %s",
                     node_id, prior.get("id"), prior.get("ack_by", "?"))
            return

    # Maintenance-window suppression (Zabbix-inspired, issue #4): if the node
    # is in an active maintenance window, mute all severities, not just
    # critical/warning. Planned downtime should silence the whole stream.
    if node_id:
        try:
            from plugins.maintenance import plugin as maintenance_plugin
            window = maintenance_plugin.is_in_maintenance(node_id)
        except Exception:
            window = None
        if window:
            _log_alert(event, severity, rule.get("name", ""),
                       "all", "maintenance_suppressed", f"window:{window['id']}")
            log.info("Suppressed alert for %s: maintenance window '%s' is active",
                     node_id, window.get("name") or window.get("id"))
            return

    # Filter channels by cooldown and enablement
    active_channels = []
    for ch_name in channel_names:
        ch_config = _load_channel_config(ch_name)
        if not ch_config.get("enabled", False):
            continue
        if not _cooldown.can_fire(event, ch_name, cooldown):
            _log_alert(event, severity, rule.get("name", ""), ch_name, "cooldown", None)
            continue
        # Configure adapter
        adapter = channels.get_adapter(ch_name)
        if adapter:
            adapter.configure(ch_config)
            active_channels.append(ch_name)

    if not active_channels:
        return

    # Dispatch in parallel
    results = channels.dispatch_parallel(
        active_channels, event, severity,
        rule_name=rule.get("name", ""),
        log_fn=lambda ch, ok, err: _log_alert(event, severity, rule.get("name", ""), ch,
                                                "sent" if ok else "failed", err),
    )


# ── DB Helpers ──

def _init_tables():
    """Create alerting tables."""
    _db.create_table("channels", """
        name TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        config TEXT DEFAULT '{}'
    """)
    _db.create_table("rules", """
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER NOT NULL,
        conditions TEXT DEFAULT '{}',
        channels TEXT DEFAULT '[]',
        cooldown INTEGER DEFAULT 300
    """)
    _db.create_table("history", """
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        event_type TEXT,
        event_text TEXT,
        severity TEXT,
        node_id TEXT,
        matched_rule TEXT,
        channel TEXT,
        status TEXT,
        error TEXT
    """)
    # Create index on history ts
    try:
        from realm_db import _conn
        c = _conn()
        c.execute("CREATE INDEX IF NOT EXISTS idx_plugin_alerting_history_ts ON plugin_alerting_history(ts)")
        c.commit()
    except Exception:
        pass


def _seed_defaults():
    """Seed default rules if none exist."""
    from .rule_engine import DEFAULT_RULES
    existing = _db.query("SELECT id FROM plugin_alerting_rules")
    if existing:
        return
    for rule in DEFAULT_RULES:
        _db.execute(
            "INSERT OR IGNORE INTO plugin_alerting_rules (id, name, enabled, priority, conditions, channels, cooldown) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (rule["id"], rule["name"], 1 if rule["enabled"] else 0, rule["priority"],
             json.dumps(rule["conditions"]), json.dumps(rule["channels"]), rule["cooldown"])
        )


def _load_rules():
    """Load rules from DB."""
    rows = _db.query("SELECT * FROM plugin_alerting_rules ORDER BY priority")
    rules = []
    for r in rows:
        rules.append({
            "id": r["id"],
            "name": r["name"],
            "enabled": bool(r["enabled"]),
            "priority": r["priority"],
            "conditions": json.loads(r["conditions"]) if r["conditions"] else {},
            "channels": json.loads(r["channels"]) if r["channels"] else [],
            "cooldown": r["cooldown"],
        })
    return rules


def _load_channel_config(channel_name):
    """Load channel config from DB."""
    rows = _db.query("SELECT * FROM plugin_alerting_channels WHERE name = ?", (channel_name,))
    if rows:
        cfg = json.loads(rows[0]["config"]) if rows[0]["config"] else {}
        cfg["enabled"] = bool(rows[0]["enabled"])
        return cfg
    return {"enabled": False}


def _save_channel_config(channel_name, config):
    """Save channel config to DB."""
    enabled = 1 if config.get("enabled", False) else 0
    cfg = {k: v for k, v in config.items() if k != "enabled"}
    _db.execute(
        "INSERT OR REPLACE INTO plugin_alerting_channels (name, enabled, config) VALUES (?, ?, ?)",
        (channel_name, enabled, json.dumps(cfg))
    )


def _log_alert(event, severity, rule_name, channel, status, error):
    """Log an alert to history."""
    try:
        _db.execute(
            "INSERT INTO plugin_alerting_history (ts, event_type, event_text, severity, node_id, matched_rule, channel, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (time.time(), event.get("type", ""), event.get("text", "")[:500], severity,
             event.get("node", ""), rule_name, channel, status, error)
        )
    except Exception as e:
        log.warning("Failed to log alert: %s", e)


# ── API Endpoints ──

def _h_get_channels(req, params):
    """GET /alerting/channels — all channel configs with adapter metadata."""
    from . import channels
    result = []
    for name, adapter in channels.get_all_adapters().items():
        cfg = _load_channel_config(name)
        result.append({
            "name": name,
            "display_name": adapter.display_name,
            "enabled": cfg.get("enabled", False),
            "config": {k: v for k, v in cfg.items() if k != "enabled"},
            "config_fields": adapter.config_fields,
        })
    return req.respond(result)


def _h_post_channels(req, params):
    """POST /alerting/channels — update channel config."""
    data = req.json()
    name = data.get("name", "")
    config = data.get("config", {})
    if not name:
        return req.respond({"error": "name required"}, 400)
    _save_channel_config(name, config)
    return req.respond({"ok": True})


def _h_post_channels_test(req, params):
    """POST /alerting/channels/test — send test notification."""
    from . import channels
    data = req.json()
    name = data.get("name", "")
    config = data.get("config")

    adapter = channels.get_adapter(name)
    if not adapter:
        return req.respond({"error": f"Unknown channel: {name}"}, 400)

    if config:
        adapter.configure(config)
    else:
        adapter.configure(_load_channel_config(name))

    success, error = adapter.test()
    return req.respond({"success": success, "error": error})


def _h_get_rules(req, params):
    """GET /alerting/rules — all rules ordered by priority."""
    return req.respond(_load_rules())


def _h_post_rules(req, params):
    """POST /alerting/rules — create or update a rule."""
    data = req.json()
    rule_id = data.get("id", "")
    if not rule_id:
        rule_id = f"rule-{int(time.time())}"

    _db.execute(
        "INSERT OR REPLACE INTO plugin_alerting_rules (id, name, enabled, priority, conditions, channels, cooldown) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (rule_id, data.get("name", "Unnamed"), 1 if data.get("enabled", True) else 0,
         data.get("priority", 99), json.dumps(data.get("conditions", {})),
         json.dumps(data.get("channels", [])), data.get("cooldown", 300))
    )
    return req.respond({"ok": True, "id": rule_id})


def _h_delete_rules(req, params):
    """DELETE /alerting/rules?id= — delete a rule."""
    rule_id = req.query_params.get("id", "")
    if not rule_id:
        return req.respond({"error": "id required"}, 400)
    _db.execute("DELETE FROM plugin_alerting_rules WHERE id = ?", (rule_id,))
    return req.respond({"ok": True})


def _h_post_rules_reorder(req, params):
    """POST /alerting/rules/reorder — reorder rules."""
    data = req.json()
    order = data.get("order", [])  # list of rule IDs in desired order
    for i, rule_id in enumerate(order):
        _db.execute("UPDATE plugin_alerting_rules SET priority = ? WHERE id = ?", (i + 1, rule_id))
    return req.respond({"ok": True})


def _h_get_history(req, params):
    """GET /alerting/history — recent alert history."""
    limit = int(req.query_params.get("limit", "100"))
    rows = _db.query(
        "SELECT * FROM plugin_alerting_history ORDER BY ts DESC LIMIT ?", (limit,))
    return req.respond(rows)


def _h_delete_history(req, params):
    """DELETE /alerting/history — clear history."""
    _db.execute("DELETE FROM plugin_alerting_history")
    return req.respond({"ok": True})


def _h_get_status(req, params):
    """GET /alerting/status — channel health + stats."""
    from . import channels

    stats = {}
    for name in channels.get_all_adapters():
        rows = _db.query(
            "SELECT status, COUNT(*) as cnt FROM plugin_alerting_history WHERE channel = ? GROUP BY status",
            (name,))
        counts = {r["status"]: r["cnt"] for r in rows}

        last_success = _db.query(
            "SELECT ts FROM plugin_alerting_history WHERE channel = ? AND status = 'sent' ORDER BY ts DESC LIMIT 1",
            (name,))
        last_failure = _db.query(
            "SELECT ts, error FROM plugin_alerting_history WHERE channel = ? AND status = 'failed' ORDER BY ts DESC LIMIT 1",
            (name,))

        stats[name] = {
            "sent": counts.get("sent", 0),
            "failed": counts.get("failed", 0),
            "cooldown": counts.get("cooldown", 0),
            "last_success": last_success[0]["ts"] if last_success else None,
            "last_failure": last_failure[0]["ts"] if last_failure else None,
            "last_error": last_failure[0]["error"] if last_failure else None,
        }

    total = _db.query("SELECT COUNT(*) as cnt FROM plugin_alerting_history")
    return req.respond({
        "channels": stats,
        "total_alerts": total[0]["cnt"] if total else 0,
    })


# ── Trigger Dependencies (Zabbix-inspired, issue #5) ──

def _h_get_dependencies(req, params):
    """GET /alerting/dependencies — recent suppression decisions (audit trail)."""
    from . import dependencies
    limit = int(req.query_params.get("limit", "50"))
    window = int(req.query_params.get("window_s", "3600"))
    return req.respond({
        "decisions": dependencies.get_recent_decisions(limit, window),
        "window_s": window,
    })


def _h_get_dependencies_why(req, params):
    """GET /alerting/dependencies/why?node=<id> — explain suppression for one node."""
    from . import dependencies
    node = req.query_params.get("node", "")
    if not node:
        return req.respond({"error": "missing ?node=<id>"}, status=400)
    lookback = int(req.query_params.get("lookback_seconds", "120"))
    return req.respond(dependencies.explain(_db, node, lookback))


# ── Cleanup Thread ──

def _cleanup_loop():
    """Periodic cleanup of old history and cooldown entries."""
    while True:
        try:
            # Keep last 7 days of history
            cutoff = time.time() - (7 * 86400)
            _db.execute("DELETE FROM plugin_alerting_history WHERE ts < ?", (cutoff,))
            if _cooldown:
                _cooldown.cleanup()
        except Exception:
            pass
        time.sleep(3600)  # hourly


# ── Setup ──

def setup(ctx):
    global _ctx, _cooldown, _db
    from .rule_engine import CooldownTracker
    from . import channels
    from .channels.desktop import DesktopAdapter
    from .channels.sse_toast import SSEToastAdapter, set_push_event
    from .channels.voice import VoiceAdapter
    from .channels.email_adapter import EmailAdapter
    from .channels.webhook import WebhookAdapter
    from .channels.pushover import PushoverAdapter

    _ctx = ctx
    _db = ctx.db
    _cooldown = CooldownTracker()

    # Init DB tables and seed defaults
    _init_tables()
    _seed_defaults()

    # Register channel adapters
    channels.register_adapter(DesktopAdapter())
    channels.register_adapter(SSEToastAdapter())
    channels.register_adapter(VoiceAdapter())
    channels.register_adapter(EmailAdapter())
    channels.register_adapter(WebhookAdapter())
    channels.register_adapter(PushoverAdapter())

    # Wire SSE toast push function
    set_push_event(ctx.push_event)

    # Subscribe to ALL event types
    ctx.on_event("alert", _on_event)
    ctx.on_event("speech", _on_event)
    ctx.on_event("discovery", _on_event)
    ctx.on_event("system", _on_event)

    # Register API endpoints
    ctx.register_endpoint("GET", "/alerting/channels", _h_get_channels, raw_path=True)
    ctx.register_endpoint("POST", "/alerting/channels", _h_post_channels, raw_path=True)
    ctx.register_endpoint("POST", "/alerting/channels/test", _h_post_channels_test, raw_path=True)
    ctx.register_endpoint("GET", "/alerting/rules", _h_get_rules, raw_path=True)
    ctx.register_endpoint("POST", "/alerting/rules", _h_post_rules, raw_path=True)
    ctx.register_endpoint("DELETE", "/alerting/rules", _h_delete_rules, raw_path=True)
    ctx.register_endpoint("POST", "/alerting/rules/reorder", _h_post_rules_reorder, raw_path=True)
    ctx.register_endpoint("GET", "/alerting/history", _h_get_history, raw_path=True)
    ctx.register_endpoint("DELETE", "/alerting/history", _h_delete_history, raw_path=True)
    ctx.register_endpoint("GET", "/alerting/status", _h_get_status, raw_path=True)
    ctx.register_endpoint("GET", "/alerting/dependencies", _h_get_dependencies, raw_path=True)
    ctx.register_endpoint("GET", "/alerting/dependencies/why", _h_get_dependencies_why, raw_path=True)

    # Status provider
    def _status_provider():
        from . import channels
        adapters = channels.get_all_adapters()
        enabled = sum(1 for n in adapters if _load_channel_config(n).get("enabled", False))
        return {"alerting": {"channels_enabled": enabled, "channels_total": len(adapters)}}

    ctx.register_status_provider(_status_provider)

    # Start cleanup thread
    t = threading.Thread(target=_cleanup_loop, daemon=True, name="alerting-cleanup")
    t.start()

    ctx.log(f"Herald's Watch active — 6 channels, {len(_load_rules())} rules")
