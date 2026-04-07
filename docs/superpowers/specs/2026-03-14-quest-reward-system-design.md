# Quest Reward System Design

**Date:** 2026-03-14
**Status:** Partially Implemented

## Overview

A persistent reward system where players earn XP, Gold, and Gems by completing quests and encountering new events. Rewards are displayed in a compact HUD bar inside the sealed dock. Leveling up triggers a celebration animation. The system supports quest-defined custom rewards with sensible defaults, and deduplicates all grants server-side.

## Goals

- Make quest completion and event exploration feel rewarding with persistent progression
- Display player stats (level, XP, gold, gems) in the dock HUD, always visible
- Support custom reward amounts per quest, with fallback defaults
- Deduplicate all reward grants to prevent farming via refresh or re-completion
- Leave hooks for future spending mechanics without implementing them now

## Non-Goals

- Spending currencies (future work)
- Milestone/achievement tracking
- Multiplayer leaderboards
- Sound effects (hook only, no audio files)

## Data Layer

### Storage

Use the existing `settings` table in realm.db with two namespaces:

- **`player`** namespace — stores `xp` (int), `gold` (int), `gems` (int). Level is derived from XP, not stored.
- **`player_rewards`** namespace — stores granted reward keys as `"{source}:{source_id}": true` for deduplication.

### Quest Schema Change

Add a nullable `rewards` TEXT column to the `quests` table:

```sql
ALTER TABLE quests ADD COLUMN rewards TEXT;
```

Format: `{"xp": 500, "gold": 100, "gems": 10}` or null for tier defaults. Applied in `realm_db.py` init with try/except (SQLite has no `ALTER TABLE IF NOT EXISTS` for columns).

### Leveling Formula

XP threshold for level N → N+1: `floor(N * 100 * 1.5^(N-1))`

| Level | XP to Next | Cumulative |
|-------|-----------|------------|
| 1→2   | 100       | 100        |
| 2→3   | 300       | 400        |
| 3→4   | 675       | 1,075      |
| 4→5   | 1,350     | 2,425      |
| 5→6   | 2,531     | 4,956      |

Level is derived: iterate thresholds until cumulative exceeds total XP. Pure function, no storage.

### Default Reward Tiers

| Trigger | XP | Gold | Gems |
|---------|-----|------|------|
| Parent quest complete (no children) | 200 | 50 | 5 |
| Sub-quest checkbox complete | 50 | 10 | 1 |
| New alert event | 15 | 5 | 0 |
| New oracle_response event | 20 | 8 | 1 |
| New speech/system/other event | 5 | 2 | 0 |

Quests with a `rewards` JSON field override these defaults for that quest.

## API Endpoints

### `GET /player`

Returns current player stats:

```json
{
  "xp": 430,
  "level": 3,
  "gold": 142,
  "gems": 12,
  "xp_next": 675,
  "xp_in_level": 30,
  "xp_level_start": 400
}
```

`xp_in_level` = XP earned within current level (430 - 400 = 30). `xp_level_start` = cumulative XP where current level began. Frontend uses these to render the XP bar: `fill% = xp_in_level / (xp_next - xp_level_start)`.

### `POST /player/reward`

Request (client sends only source and id — server determines amounts):

```json
{
  "source": "quest",
  "id": "vlan6-audit"
}
```

Source types: `"quest"` (parent quest), `"sub"` (sub-quest), `"event"` (SSE event).

Server logic:
- `source: "quest"` — looks up quest by id, reads its `rewards` field or uses parent-quest defaults (200/50/5)
- `source: "sub"` — uses sub-quest defaults (50/10/1). If the sub's parent quest has a `rewards` field with a `sub` key, use that instead.
- `source: "event"` — looks up event by id, determines tier from event type (alert=15/5/0, oracle_response=20/8/1, other=5/2/0)

Response:

```json
{
  "ok": true,
  "granted": true,
  "reward": {"xp": 200, "gold": 50, "gems": 5},
  "xp": 630,
  "level": 3,
  "gold": 192,
  "gems": 17,
  "xp_next": 675,
  "xp_in_level": 230,
  "xp_level_start": 400,
  "level_up": false
}
```

The `reward` field tells the frontend what was actually granted (for animation text). If already granted (duplicate): `{"ok": true, "granted": false, ...current_stats}`.

## Backend Implementation

### realm_db.py

**New functions:**

- **`get_player_stats()`** — Reads `player` namespace. Returns `{xp, level, gold, gems, xp_next, xp_in_level, xp_level_start}`. Defaults: `{xp: 0, gold: 0, gems: 0}`.
- **`calc_level(total_xp)`** — Pure function. Returns `{level, xp_next, xp_in_level, xp_level_start}`.
- **`grant_reward(source, source_id, xp, gold, gems)`** — Checks `player_rewards` namespace for key `"{source}:{source_id}"`. If exists, returns `{granted: False, ...stats}`. Otherwise: increments player xp/gold/gems, records the grant key, computes new level, returns `{granted: True, level_up: bool, old_level, new_level, ...stats}`.

**Updated functions:**

- **`push_event(event)`** — Must return the inserted row's `id` (autoincrement) so SSE can include it.
- **`get_events_since(since_ts)`** — Must include the row `id` field in the returned event dict so the frontend can use it for dedup.
- **`get_quests()`** and **`get_quest(quest_id)`** — Must include the `rewards` column in their SELECT and returned dict.
- **`upsert_quest(quest)`** — Must accept and persist the optional `rewards` field.

### map_server.py

Two new route handlers in `do_GET` / `do_POST`:

- `GET /player` → `realm_db.get_player_stats()`
- `POST /player/reward` → server looks up reward amounts from quest `rewards` field or tier defaults based on `source` type. Client sends only `{source, id}`. Server determines and applies the correct amounts. Returns updated stats.

**Trust boundary note:** Since the server determines reward amounts, the client cannot inflate rewards. For event rewards, the server uses the event's type to select the tier. For quest/sub rewards, the server reads the quest's `rewards` field or applies defaults.

## Frontend Implementation

### Reward Wiring (src/app.js)

**Quest "Claim Reward" button (childless quests):**
1. Click triggers existing particle animation
2. `POST /player/reward` with `{source: "quest", id: quest.id}`
3. Response `reward` field drives the XP/gold/gems banner text (real values, not random)
4. Update dock HUD with new totals
5. If `level_up`, trigger level-up celebration

**Parent quest with children — auto-complete reward:**
When all sub-quests are completed, the parent quest card already gets `quest-card--done`. Add: when the last sub-quest is checked and `_refreshQuestCards()` detects `allDone`, auto-fire `POST /player/reward` with `{source: "quest", id: parent.id}`. Show a reward banner on the parent card (smaller than "Claim Reward" burst, but still celebratory). The server dedup key `"quest:{parent_id}"` prevents double-granting if the user unchecks and re-checks.

**Sub-quest checkbox:**
1. **Only when toggling TO completed** (not when unchecking back to active): `POST /player/reward` with `{source: "sub", id: sub.id}`
2. Float a small `+50 XP +10g` text near the checkbox (no particle burst)
3. Update dock HUD
4. Toggling back to active does NOT revoke or re-grant rewards

**Event rewards:**
1. In `addLogEntry()`, after rendering a new SSE event, check a client-side `Set` of granted event IDs
2. If new and event has a DB `id` field: `POST /player/reward` with `{source: "event", id: event.id}`
3. Float a subtle `+5 XP` text drifting up from the log entry (gold/gems only shown if > 0)
4. Client-side Set prevents redundant fetches; server dedup is the true guard
5. Events without a DB `id` (transient) are not eligible for rewards

**Level-up celebration:**
- Screen-wide golden flash overlay (reuse `qr-golden-flash` keyframe pattern)
- Rising level badge: large golden circle with new level number, scales up then settles
- Dock HUD level badge pulses with golden ring burst

### Dock HUD (src/panel-manager.js + realm-map.css)

A `.dock-hud` div inserted before `.dock-tray` in `_createSealedDock()`.

Layout:
```
  ⭐ Lv.3  ████████░░ 180/225  |  🪙 142  |  💎 12
```

Structure:
- `.dock-hud` — flex row, ~28px tall, centered, same width as tray
- `.hud-level` — golden circle badge with level number
- `.hud-xp-bar` — thin progress bar (gradient fill matching quest card bars)
- `.hud-xp-text` — "180/225" in small MedievalSharp font
- `.hud-gold` — gold coin icon + count
- `.hud-gems` — gem icon + count

Behavior:
- On page load: `GET /player` → populate all fields
- After any reward: animate changed values (count-up tween via requestAnimationFrame, brief glow pulse on numbers)
- On level-up: level badge scale-pulse + golden ring, XP bar flash-resets

Styling:
- Cinzel font for level, MedievalSharp for counts
- Gold color (`#ddb870`) for gold count, cyan (`#60d8d8`) for gems
- Subtle separator pipes between sections
- Fades in with the dock (same `label-etch` animation timing)

## Files Changed

| File | Changes |
|------|---------|
| `realm_db.py` | `get_player_stats()`, `calc_level()`, `grant_reward()`, quests rewards column migration |
| `map_server.py` | `GET /player`, `POST /player/reward` handlers |
| `src/app.js` | Wire quest/sub/event reward calls, real reward values in animations, event floaters, level-up celebration |
| `src/panel-manager.js` | `.dock-hud` creation in `_createSealedDock()`, HUD update functions, expose `updateDockHUD()` |
| `realm-map.css` | `.dock-hud` styling, HUD animations, level-up overlay, event reward float |

## Edge Cases

- **Page refresh**: `GET /player` restores state. Client-side event Set is empty but server dedup prevents re-grants.
- **Quest re-opened after completion**: If quest status toggled back to active, the reward for the original completion is already granted and won't re-grant.
- **Sub-quest re-toggle**: Unchecking a sub-quest does NOT revoke rewards. Re-checking it does NOT re-grant (server dedup on `"sub:{id}"`). Frontend only fires reward POST when toggling TO completed.
- **Parent quest auto-complete**: When last sub-quest is checked, parent reward fires automatically. If a sub-quest is later unchecked and re-checked, the parent reward is already granted.
- **Negative rewards**: Validated server-side — xp/gold/gems must be >= 0.
- **Concurrent requests**: SQLite serializes writes, no race condition on increment.
- **Events without DB IDs**: SSE events that lack an `id` field are not eligible for event rewards (they're transient).
- **Event ID plumbing**: `push_event()` must return the row's autoincrement `id`, and event query functions must include it in results, so SSE-broadcast events carry the `id` field the frontend needs for reward dedup.
