# Status Plugin for Realmwatch — Design

**Date:** 2026-05-18
**Status:** spec, awaiting implementation plan
**Origin:** JP asked to add `status.realm.watch` as a realmwatch plugin. Hybrid model picked: realmwatch becomes the new home for checks; status-vm becomes a thin public proxy. `checks.json` moves to realmwatch (gitignored, paralleling `fleet.yaml`).

## 1. Goal

Make realmwatch the canonical source for the 94 homelab health checks currently run by `status.realm.watch` on `status-vm` (Alpine KVM VM). Surface checks inside realmwatch's map and panel system. status.realm.watch's public site continues to serve, but as a thin Caddy proxy fetching a snapshot from realmwatch over the LAN.

## 2. Current state

`~/Projects/status.realm.watch/` deploys to `status-vm` and runs:
- `check.sh` every 5 min via cron → writes `status.json` (snapshot of all check results)
- `release-watch.sh` hourly → writes `release-state.json` (GitHub release tracking)
- `server.py` (port 8080) → serves `index.html` (reads status.json), `/api/version`, `/api/config` (read/write checks.json), `/edit.html` (drag-drop UI)

`checks.json` source of truth shape:
```json
{
  "http": [{ "name": "Realm Portal", "url": "https://realm.watch" }, ...],
  "ping": [{ "name": "gatekeeper", "host": "10.0.6.3" }, ...],
  "tcp": [{ "name": "...", "host": "...", "port": ... }, ...],
  "udp": [...], "kvm_hosts": [...], "kvm_guests": [...],
  "caddy_hosts": [...], "docker_hosts": [...], "game_servers": [...],
  "intermittent_nodes": [...], "version": [...]
}
```

10 check kinds, 94 total checks. Each `{kind, list}` pair.

## 3. Architecture

```
JP's homelab (LAN)
  realmwatch :80                       status-vm :8080
  ├── plugins/status/                  ├── Caddy reverse proxy → fetches
  │   ├── plugin.json                  │   realmwatch_lan_ip/status/snapshot.json
  │   ├── plugin.py                    │   every 60s, caches locally
  │   ├── runner.py — executes checks  ├── /status.json (cached snapshot)
  │   ├── handlers/                    ├── /index.html (legacy UI, read-only)
  │   │   ├── http_check.py            └── /edit.html → POSTs to realmwatch /status/checks
  │   │   ├── ping_check.py            (status-vm stops running check.sh + edit.html proxies edits)
  │   │   ├── tcp_check.py
  │   │   ├── udp_check.py
  │   │   ├── ssh_check.py (KVM hosts, Docker hosts, Caddy hosts via SSH)
  │   │   ├── version_check.py (realm-sigil parity)
  │   │   └── github_check.py (release-watch)
  │   ├── endpoints.py — /status/* HTTP routes
  │   ├── panel.html/js/css — Watchtower panel
  │   └── watcher.py — mtime watch on checks.json (hot reload)
  └── checks.json (gitignored, source of truth)

Public:
  status.realm.watch (Caddy on status-vm) → snapshot served as plain HTML+JSON
```

## 4. Data model

### `checks.json` (gitignored at realmwatch root)
Same shape as the existing status.realm.watch file. Migrated via a one-shot `scripts/migrate-status.py` that:
1. Copies `~/Projects/status.realm.watch/checks.json` → `~/Projects/realmwatch/checks.json`
2. Adds an optional `fleet_id` field on each check that auto-resolves via the lexicon resolver if the check's host matches a known node

### Three new `realm.db` tables

```sql
CREATE TABLE status_check_defs (
    check_id TEXT PRIMARY KEY,         -- stable id, e.g. "http:realm-portal"
    kind TEXT NOT NULL,                -- http|ping|tcp|udp|ssh|version|github|kvm_host|kvm_guest|caddy|docker|game_server
    name TEXT NOT NULL,                -- human-readable
    spec TEXT NOT NULL,                -- JSON: url, host, port, etc.
    fleet_id TEXT,                     -- optional cross-ref to lexicon fleet entry
    enabled INTEGER NOT NULL DEFAULT 1,
    interval_s INTEGER DEFAULT 300,    -- per-check override; defaults to global 300s
    last_seen INTEGER,                 -- unix ts last seen in checks.json
    UNIQUE(kind, name)
);

CREATE TABLE status_results (        -- most recent result per check
    check_id TEXT PRIMARY KEY REFERENCES status_check_defs(check_id),
    status TEXT NOT NULL,              -- ok|fail|unknown|skipped
    last_ran INTEGER NOT NULL,         -- unix ts
    latency_ms INTEGER,                -- check duration; null on fail/unknown
    detail TEXT,                       -- JSON: status_code, response_size, error msg, etc.
    last_ok INTEGER,                   -- unix ts of last ok (for "down since X")
    last_fail INTEGER,                 -- unix ts of last fail (for "up since X")
    fail_streak INTEGER NOT NULL DEFAULT 0,
    transition_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE status_history (        -- time-series, capped (e.g. 30 days)
    check_id TEXT NOT NULL REFERENCES status_check_defs(check_id),
    ran_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER,
    detail TEXT,
    PRIMARY KEY(check_id, ran_at)
);
CREATE INDEX idx_status_history_ran ON status_history(ran_at);
```

`status_check_defs` is reconciled from `checks.json` on every load (mtime watcher fires reload, like fleet.yaml). Entries not in the current checks.json get `enabled=0` (soft-deleted).

## 5. Check runner

`plugins/status/runner.py` is a background thread that:
1. Reads `status_check_defs` where `enabled=1`
2. For each, computes `should_run = (now - last_ran) >= interval_s` (jitter to avoid thundering herd)
3. Dispatches to a handler module (`http_check`, `ping_check`, etc.) via a stdlib threadpool (cap ~16 concurrent)
4. Persists the result to `status_results` (upsert) + `status_history` (insert)
5. On transition (`ok ↔ fail`):
   - Emits `realm-event { kind: "status.changed", check_id, from, to }`
   - Increments `transition_count`
   - Optionally emits a quest if the check is flagged `quest: true` (deferred to v0.2)
6. Sleeps until next due check

Initial run on plugin startup: defer 5s, then start the loop.

### Handler signatures

Each handler module exposes `run(spec: dict, timeout_s: int) -> CheckResult` where `CheckResult` is:

```python
@dataclass
class CheckResult:
    status: str           # "ok" | "fail" | "unknown"
    latency_ms: int | None
    detail: dict          # status_code/error/output snippet
```

- `http_check.py`: `urllib.request` GET, 2xx/3xx → ok, else fail. Records `status_code`, `response_size`.
- `ping_check.py`: `subprocess.run(["fping", "-c1", host])`. Latency from output.
- `tcp_check.py`: `socket.create_connection((host, port), timeout)`.
- `udp_check.py`: sendto + recvfrom; tricky semantics — match existing check.sh's UDP probe.
- `ssh_check.py`: shells `ssh host <command>` to KVM/Docker/Caddy hosts. Uses realmwatch's existing SSH machinery (see `node-controls.js` for the pattern).
- `version_check.py`: HTTP GET `<url>/api/version`, parses realm-sigil response, compares against expected.
- `github_check.py`: GitHub API GET releases — equivalent to release-watch.sh.

## 6. API surface

| Verb + Path | Behavior |
|---|---|
| `GET /status/checks` | List all check definitions (joined with most-recent result) |
| `GET /status/results` | Same as above but result-focused, supports `?status=fail&kind=http` |
| `GET /status/summary` | Aggregate: total/ok/fail/unknown counts per kind |
| `GET /status/snapshot.json` | Full JSON snapshot in status-vm-compatible shape — what the public Caddy proxy fetches |
| `GET /status/history/<check_id>?since=...` | Time-series for one check |
| `POST /status/run/<check_id>` | Force-run one check immediately, returns result |
| `POST /status/reload` | Explicit re-read of checks.json (matches `/fleet/reload`) |
| `PUT /status/check` | Add/update one check via API (writes to checks.json + DB) |
| `DELETE /status/check/<check_id>` | Soft-delete (sets `enabled=0`); removed from checks.json on next save |

## 7. Fleet cross-reference

Each check entry MAY carry a `fleet_id` field. If absent, the migration script tries to auto-link:
- HTTP/ping/TCP/UDP checks with `host` matching a known node IP → `fleet_id = node.fleet_id`
- HTTP checks with hostnames that resolve to a known node IP → same
- Checks with no LAN host (external URLs, GitHub) → `fleet_id = null`

The map renders a small status sigil on each node whose `fleet_id` has a non-null check result. Color-coded: green (ok), amber (degraded ≥ 1 fail in last hour), red (failing now).

## 8. Frontend panel

`plugins/status/panel.{html,js,css}` — "The Watchtower":

- Header: total/ok/fail counters, summary breakdown by kind
- Tabs: All / Failing / By Kind
- Sortable rows: name, kind, status, last_ran, latency, fail_streak
- Click a row → expand to show detail (raw `detail` JSON, recent history sparkline)
- Action: "Run now" button per row → POST /status/run/<id>
- SSE subscription to `plugin-broadcast` type `status-update` for live refresh
- DOM-built (no innerHTML, hook-enforced same as lexicon panel)

## 9. SSE events

| Event | When | Payload |
|---|---|---|
| `plugin-broadcast { type: "status-update" }` | After each check batch | `{ summary: {ok, fail, ...} }` |
| `realm-event { kind: "status.changed" }` | On any check transition | `{ check_id, from, to, name, kind, fleet_id }` |
| `realm-event { kind: "status.batch_complete" }` | At end of each run cycle | `{ checks_run, duration_s, transitions }` |

## 10. Public proxy: status-vm → realmwatch

Rewrite `status-vm`'s Caddy config to:

```caddy
status.realm.watch {
    handle_path /status.json {
        reverse_proxy realmwatch_lan_ip:80 {
            rewrite /status/snapshot.json
            header_up Host status.realm.watch
        }
        header Cache-Control "max-age=30"
    }
    handle / {
        root * /var/www/status-static
        try_files {path} /index.html
        file_server
    }
}
```

`/index.html` on status-vm becomes a static page that fetches `/status.json` and renders. The current `server.py` and `check.sh` cron are decommissioned.

Open question: edit.html — should it disappear (operator edits checks.json on realmwatch directly), or stay and POST to realmwatch's `/status/check` endpoint over the LAN? Default: kill edit.html in this rev; revisit if JP wants the UI back.

## 11. Migration

`scripts/migrate-status.py`:
1. Read `~/Projects/status.realm.watch/checks.json`
2. Write to `~/Projects/realmwatch/checks.json` (gitignored)
3. For each check, generate a stable `check_id` (e.g. `http:realm-portal` from kind + slugified name)
4. Auto-link to fleet entries by host match (best-effort; null-ok)
5. Insert into `status_check_defs` table
6. (Optional, on apply) Run all checks once to populate `status_results`

## 12. Phasing (proposed)

1. **Phase 1** — DB schema migration, runner skeleton (HTTP only), `/status/checks`, `/status/results`, panel scaffold. End: realmwatch runs all HTTP checks, panel shows them.
2. **Phase 2** — ping, TCP, UDP handlers + check execution loop hardening (jitter, concurrency cap, timeout)
3. **Phase 3** — SSH-based handlers (KVM, Caddy, Docker). Reuse existing realmwatch SSH path. version_check.
4. **Phase 4** — Fleet cross-reference. Map sigil rendering. realm-events on transition.
5. **Phase 5** — `/status/snapshot.json` endpoint + status-vm Caddy migration script.
6. **Phase 6** — github_check (release-watch port). history retention + cap.
7. **Phase 7** — `PUT/DELETE /status/check` API + JSON editor in panel (replaces edit.html).
8. **Phase 8** — Decommission status-vm `server.py` + `check.sh`. Docs, smoke, release tag.

## 13. Out of scope (v0.1)

- Cron jobs on status-vm — disabled, not deleted
- The legacy `status.json` file format — we generate a compatible shape via `/status/snapshot.json`
- Multi-realm / multi-tenancy — single homelab
- Alert routing (email, SMS, Slack) — emit `realm-event`; other plugins handle delivery
- Historical graphs / Grafana export — `status_history` exists, visualization deferred

## 14. Open questions

- **Concurrency cap** — 16 simultaneous checks reasonable? Some hosts are slow (KVM hosts via SSH). Could be `per_kind` rather than global.
- **Discovery integration** — should NEW topology nodes auto-create a default ping check? Probably yes; opt-out via `auto_ping: false` flag.
- **Latency on SSH checks** — SSH-cold-connect is ~1s. With 30+ SSH checks at 5-min interval, that's 30s of SSH every 5 min. Acceptable but worth noting.
- **`intermittent_nodes` semantics** — what makes these special in the current check.sh? May need to read check.sh closely during planning.

---

End of spec. Implementation plan deferred to a separate document; this design is the brainstorm artifact.
