# Alerting Plugin — "Realm Herald's Watch"

> **Status:** Approved
> **Date:** 2026-04-07
> **Phase:** Post-Phase 1 (depends on discovery engine + plugin system)

## Goal

A plugin that routes realm events to external notification channels based on configurable rules, with a full settings panel for configuration and testing.

## Architecture

Single `plugins/alerting/` integrated plugin. Subscribes to all realm events via `ctx.on_event()`, evaluates rules, dispatches to channel adapters in parallel.

## Channels (6)

| Channel | Adapter | Config Fields | Dependencies |
|---------|---------|---------------|-------------|
| Desktop | `notify-send` subprocess | urgency, icon | notify-send (installed) |
| SSE Toast | Push event via SSE broker | duration, position | None (built-in) |
| Email | `smtplib` (stdlib) | SMTP host/port/user/pass, TLS, from, to[] | None |
| Webhook | `httpx.post()` | URL, method, headers, body template, preset | httpx (installed) |
| Voice | speech-to-cli MCP HTTP | voice, quality | speech-to-cli server |
| Pushover | `httpx.post()` to api.pushover.net | user_key, app_token, priority map | httpx (installed) |

### Webhook Presets

Built-in body templates for common services:
- **Slack**: `{"text": "{event.text}", "username": "RealmWatch", "icon_emoji": ":shield:"}`
- **Discord**: `{"content": "{event.text}", "username": "RealmWatch"}`
- **Ntfy**: POST to topic URL with `Title: {event.type}` header, body = `{event.text}`
- **Custom**: User-defined JSON body with template variables

### Template Variables

Simple `{var}` string replacement (no Jinja):
- `{event.type}`, `{event.text}`, `{event.node}`, `{event.color}`, `{event.ts}`
- `{entity.name}`, `{entity.status}`, `{entity.host}`, `{entity.type}`
- `{severity}` — computed: "critical" / "warning" / "info"

## Rule Engine

Ordered rules, first-match-wins. Each rule:

```json
{
  "id": "rule-1",
  "name": "Critical alerts everywhere",
  "enabled": true,
  "conditions": {
    "event_types": ["alert"],
    "severity": ["critical"],
    "node_pattern": "*"
  },
  "channels": ["email", "webhook", "desktop", "voice", "pushover"],
  "cooldown": 300,
  "priority": 1
}
```

### Default Rules (seeded on first load)

| Priority | Name | Condition | Channels |
|----------|------|-----------|----------|
| 1 | Critical → all channels | type=alert, color=#ff4040 | email, webhook, desktop, voice, pushover |
| 2 | Warnings → local | type=alert | desktop, webhook, voice |
| 3 | Discovery failures | type=discovery, status=failed | desktop, webhook |
| 4 | HA state changes | type=speech, node=ha | sse_toast |
| 5 | Default | * | sse_toast |

### Severity Detection

Computed from event data:
- `critical`: event.color == "#ff4040" OR entity.status == "failed"
- `warning`: event.color == "#ffaa00" OR entity.status == "stopped"
- `info`: everything else

## Settings Panel

Plugin panel with 4 tabs accessible from the Realmwatch UI.

### Channels Tab
- Card per channel: name, enabled toggle, config fields, **Test** button
- Test button sends a sample notification and shows success/failure inline
- Email: SMTP host, port, TLS toggle, username, password (masked), from address, to addresses (comma-sep)
- Webhook: URL, preset dropdown (Slack/Discord/Ntfy/Custom), custom body editor, custom headers
- Pushover: user key, app token, priority mapping (critical→emergency, warning→high, info→low)
- Voice: voice selector, quality toggle, enabled toggle
- Desktop: urgency dropdown (low/normal/critical), icon path

### Rules Tab
- Ordered rule list with drag handle
- Each rule: name, enabled toggle, condition builder (event type multi-select, severity checkboxes, node pattern input), channel checkboxes, cooldown input
- Add / Edit / Delete buttons
- Reset to defaults button

### History Tab
- Recent 100 alerts: timestamp, event text, matched rule, channels fired, delivery status per channel
- Filter by channel, status (sent/failed/cooldown), time range
- Clear history button

### Status Tab
- Per-channel health: last success time, last failure time + error, total sent/failed counts
- Overall stats: events processed, alerts fired, alerts suppressed by cooldown

## Database Tables

```sql
CREATE TABLE IF NOT EXISTS plugin_alerting_channels (
    name TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    config TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS plugin_alerting_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    priority INTEGER NOT NULL,
    conditions TEXT DEFAULT '{}',
    channels TEXT DEFAULT '[]',
    cooldown INTEGER DEFAULT 300
);

CREATE TABLE IF NOT EXISTS plugin_alerting_history (
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
);
CREATE INDEX IF NOT EXISTS idx_alerting_history_ts ON plugin_alerting_history(ts);
```

## File Structure

```
plugins/alerting/
  plugin.json          — manifest
  plugin.py            — setup: event handler, endpoints, SSE, panel registration
  rule_engine.py       — Rule matching, severity detection, cooldown tracking
  channels/
    __init__.py        — ChannelAdapter base, dispatch_parallel()
    desktop.py         — notify-send adapter
    sse_toast.py       — SSE event push adapter
    email_adapter.py   — SMTP adapter
    webhook.py         — Generic webhook + presets
    voice.py           — speech-to-cli HTTP adapter
    pushover.py        — Pushover API adapter
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /alerting/channels | All channel configs |
| POST | /alerting/channels | Update channel config |
| POST | /alerting/channels/test | Send test notification |
| GET | /alerting/rules | All rules (ordered) |
| POST | /alerting/rules | Create/update rule |
| DELETE | /alerting/rules?id= | Delete rule |
| POST | /alerting/rules/reorder | Reorder rules |
| GET | /alerting/history | Recent alert history |
| DELETE | /alerting/history | Clear history |
| GET | /alerting/status | Channel health + stats |

## Data Flow

```
event_generator / discovery_engine / HA bridge / any plugin
  → push_event() → realm_db.push_event()
    → plugin_registry.fire_event(type, event)
      → alerting plugin on_event handler
        → rule_engine.evaluate(event) → matched_rule + channels
          → dispatch_parallel(channels, event, matched_rule)
            → each adapter.send(event, config)
              → log result to alerting_history
```

## Key Decisions

- **No new dependencies** — smtplib is stdlib, httpx already installed, notify-send available
- **Secrets in plugin DB** — not .env, since they're user-configurable from the panel
- **Per-channel cooldown** — same event won't fire on same channel within cooldown window
- **Graceful degradation** — channel failure doesn't block other channels
- **Thread pool dispatch** — channels fire in parallel, results collected
- **Event handler subscribes to "*"** — catches all event types, rule engine filters
- **Fantasy theming** — panel uses realm aesthetic, alert history shows fantasy-themed severity icons
