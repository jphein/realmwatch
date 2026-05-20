# scripts/replay/

Dev / test tooling for the game event bus (`~/.realmwatch/game.db`).

Migrated from `os.realm.watch/servers/replay/` on 2026-05-19. **Not** a plugin
— these are CLI scripts you run by hand to seed scenarios, capture live event
streams for replay later, or inject synthetic events while training the
oracle / chronicling / alerting paths.

## Files

| File | Purpose |
|------|---------|
| `generators.py` | Pure functions returning event dicts (cpu_spike, port_scan, brute_force, ddos, …). No side effects. Importable from anywhere. |
| `harness.py` | CLI + library: `capture_events`, `replay_events`, `inject_synthetic`. Talks to the game.db directly. |

## CLI

```bash
# Inject one synthetic event into the live game.db
python3 scripts/replay/harness.py --generate cpu_spike

# Preview the event without writing
python3 scripts/replay/harness.py --generate ddos --dry-run

# Show every available generator
python3 scripts/replay/harness.py --list-generators

# Capture the last 500 events to a JSON snapshot
python3 scripts/replay/harness.py --capture /tmp/events.json --limit 500

# Replay them back (replay_flag=1, so progression isn't double-credited)
python3 scripts/replay/harness.py --replay /tmp/events.json

# Use a non-default DB (e.g. a throwaway test fixture)
python3 scripts/replay/harness.py --db /tmp/scratch.db --generate brute_force
```

## Library use

```python
from scripts.replay.generators import generate_brute_force
from scripts.replay.harness import inject_synthetic, DEFAULT_DB_PATH

event = generate_brute_force(target="vault", attempts=200)
result = inject_synthetic(DEFAULT_DB_PATH, event)
print(result)  # -> {"event_id": "01K...", "deduplicated": False}
```

## Available generators

`cpu_spike`, `port_scan`, `new_device`, `memory_critical`, `latency_spike`,
`brute_force`, `dns_poisoning`, `ddos`, `unknown_device`.

Each has reasonable defaults; pass kwargs to customize (e.g.
`generate_cpu_spike(host="nas", value=99)`).

## What it talks to

`~/.realmwatch/game.db` — the game-state SQLite shared by the future
realm-engine / lore-keeper / combat-ward / quest-forge plugins (see
`CLAUDE.md` "Game DB sidecar"). Distinct from `realm.db`, which is the
network-monitor live data store. **Do not** point this at `realm.db`.

## Wave 3 note

`harness.py` includes a local `_ingest_event()` shim that inserts directly
into `events` with the same dedupe semantics as the upstream
`servers.realm_engine.server.ingest_event`. When realm-engine lands as a
plugin (Wave 3 or later), swap that shim for a direct call into the
canonical inserter so bestiary side-effects re-engage. The CLI surface
stays the same.
