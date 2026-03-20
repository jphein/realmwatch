# Quest Reward System Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent XP/Gold/Gems reward system earned from quests and events, displayed in a dock HUD.

**Architecture:** Server-side reward logic in realm_db.py with deduplication via settings table namespaces. Two new HTTP endpoints in map_server.py. Frontend wires quest/sub/event triggers to POST /player/reward, updates a dock HUD bar, and celebrates level-ups.

**Tech Stack:** Python 3 + SQLite (realm_db.py, map_server.py), vanilla JS (src/app.js, src/panel-manager.js), CSS (realm-map.css), esbuild.

**Spec:** `docs/superpowers/specs/2026-03-14-quest-reward-system-design.md`

---

## Chunk 1: Backend Data Layer and API

### Task 1: Add rewards column migration and player stats functions to realm_db.py

**Files:**
- Modify: `realm_db.py:70-86` (init block with ALTER TABLE migration)
- Modify: `realm_db.py:143-162` (push_event, get_events_since with id field)
- Modify: `realm_db.py:165-223` (get_quests, get_quest, upsert_quest with rewards field)
- Modify: `realm_db.py` (append new player functions)

- [ ] **Step 1: Add rewards column migration to init block**

In realm_db.py, after the CREATE INDEX statements (~line 85), add try/except ALTER TABLE for rewards column.

- [ ] **Step 2: Update push_event to return row id**

Change push_event to capture cursor from execute, set `event["id"] = cur.lastrowid` before returning.

- [ ] **Step 3: Update get_events_since to include row id**

Change SELECT to include `id` column, inject `evt["id"] = r["id"]` into each parsed event dict.

- [ ] **Step 4: Update get_quests to include rewards field**

Add `"rewards": json.loads(r["rewards"]) if r.get("rewards") else None` to the quest dict.

- [ ] **Step 5: Update get_quest to include rewards field**

Same as step 4 for the single-quest function.

- [ ] **Step 6: Update upsert_quest to persist rewards field**

Add `rewards` to INSERT columns and values tuple, using `json.dumps(quest["rewards"]) if quest.get("rewards") else None`.

- [ ] **Step 7: Add calc_level, get_player_stats, grant_reward, and _get_reward_for functions**

Append player reward functions:
- `calc_level(total_xp)` -- iterates `floor(N * 100 * 1.5^(N-1))` thresholds
- `get_player_stats()` -- reads player namespace, returns stats with derived level
- `_get_reward_for(source, source_id)` -- looks up quest/event to determine amounts
- `grant_reward(source, source_id)` -- dedup check, increment totals, return result with level_up flag
- `_REWARD_TIERS` dict with defaults for quest/sub/event types

- [ ] **Step 8: Verify realm_db.py loads without errors**

Run: `./venv/bin/python3 -c "import realm_db; print(realm_db.get_player_stats())"`
Expected: `{'xp': 0, 'gold': 0, 'gems': 0, 'level': 1, 'xp_next': 100, 'xp_in_level': 0, 'xp_level_start': 0}`

- [ ] **Step 9: Quick smoke test of grant_reward**

Run: `./venv/bin/python3 -c "import realm_db; print(realm_db.grant_reward('quest', 'test-1')); print(realm_db.grant_reward('quest', 'test-1'))"`
Expected: First call `granted: True`, second call `granted: False` (dedup).

- [ ] **Step 10: Commit**

```bash
git add realm_db.py
git commit -m "feat(db): player reward system -- calc_level, grant_reward, event id plumbing, quest rewards column"
```

### Task 2: Add HTTP endpoints to map_server.py

**Files:**
- Modify: `map_server.py` (add GET /player in do_GET, add POST /player/reward in do_POST)

- [ ] **Step 1: Add GET /player handler**

In do_GET after the /energy handler (~line 402): `elif self.path == "/player":` calling `realm_db.get_player_stats()`.

- [ ] **Step 2: Add POST /player/reward handler**

In do_POST after /quest-update (~line 645): validate source (quest/sub/event) and id, call `realm_db.grant_reward(source, str(source_id))`, return result.

- [ ] **Step 3: Restart map server and test endpoints**

Run: `curl -s http://localhost:80/player | python3 -m json.tool`
Run: `curl -s -X POST -H "Content-Type: application/json" -d '{"source":"event","id":"999999"}' http://localhost:80/player/reward | python3 -m json.tool`

- [ ] **Step 4: Commit**

```bash
git add map_server.py
git commit -m "feat(api): GET /player and POST /player/reward endpoints"
```

---

## Chunk 2: Frontend Dock HUD

### Task 3: Create dock HUD bar in panel-manager.js

**Files:**
- Modify: `src/panel-manager.js:136-215` (_createSealedDock, insert HUD div before tray)
- Modify: `src/panel-manager.js` (add updateDockHUD function, expose via window)

- [ ] **Step 1: Add HUD div creation inside _createSealedDock**

After handle/grip creation (~line 203), before tray creation (line 206), create a `.dock-hud` div with child elements:
- `.hud-level` with `.hud-level-num` span
- `.hud-xp` with `.hud-xp-bar` > `.hud-xp-fill`, and `.hud-xp-text` span
- `.hud-sep` dividers
- `.hud-gold` with `.hud-coin-icon` + `.hud-gold-num`
- `.hud-gems` with `.hud-gem-icon` + `.hud-gems-num`

Use DOM createElement methods (not innerHTML) for the HUD structure.

- [ ] **Step 2: Add updateDockHUD function**

Add function that takes stats object and animate boolean. Updates level number, XP bar width/text, gold/gems counts. When animate=true, uses requestAnimationFrame count-up tween and adds hud-pulse class. Expose as `window.updateDockHUD`.

Also add `_animateCount(el, from, to, duration)` helper using requestAnimationFrame.

- [ ] **Step 3: Build and verify dock shows HUD**

Run: `npm run build`. Reload map, verify HUD bar appears above rune tray.

- [ ] **Step 4: Commit**

```bash
git add src/panel-manager.js
git commit -m "feat(dock): add player stats HUD bar -- level, XP bar, gold, gems"
```

### Task 4: Style the dock HUD

**Files:**
- Modify: `realm-map.css` (add .dock-hud styles)

- [ ] **Step 1: Add dock HUD CSS**

Before `.dock-handle` rules, add styles for:
- `.dock-hud` -- flex row, centered, 28px tall, z-index 2, label-etch animation
- `.hud-level` -- 26px golden circle badge with radial gradient, border, box-shadow
- `.hud-level-num` -- Cinzel 12px bold, golden color with text-shadow
- `.hud-xp` -- flex with gap, contains bar and text
- `.hud-xp-bar` -- 60px wide, 4px tall, dark bg with rounded overflow
- `.hud-xp-fill` -- gradient fill (purple to green), width transition 0.6s
- `.hud-xp-text` -- MedievalSharp 9px, muted color
- `.hud-sep` -- 1px x 14px subtle gold divider
- `.hud-currency` -- flex with gap
- `.hud-coin-icon::before` -- golden circle character, drop-shadow
- `.hud-gem-icon::before` -- cyan diamond character, drop-shadow
- `.hud-gold-num` / `.hud-gems-num` -- MedievalSharp 11px, matching colors
- `.hud-pulse` -- glow animation keyframe 0.8s
- `.hud-level-up` -- scale burst animation 1.5s with expanded box-shadow

- [ ] **Step 2: Build and verify styling**

Run: `npm run build`. Reload and confirm HUD looks styled with zeros.

- [ ] **Step 3: Commit**

```bash
git add realm-map.css
git commit -m "style: dock HUD -- level badge, XP bar, gold/gem counters with magical theming"
```

---

## Chunk 3: Frontend Reward Wiring and Animations

### Task 5: Wire quest rewards and load player stats on startup

**Files:**
- Modify: `src/app.js` (load player stats, wire Claim Reward, sub-quest, events, helpers)

- [ ] **Step 1: Add player stats loader at startup**

Near `_loadQuestLog` call (~line 2233), add fetch to GET /player, call `window.updateDockHUD(stats)`.

- [ ] **Step 2: Wire Claim Reward button to POST /player/reward**

Replace click handler (~line 2145-2158). New handler: POST /player/reward with source "quest", use response reward field in _spawnQuestReward, update HUD, check level_up.

- [ ] **Step 3: Update _spawnQuestReward to accept reward parameter**

Add optional `reward` param. Replace random XP text with real values from reward: `+{xp} XP +{gold}g +{gems} gem`. Fallback to `+?? XP` if null.

- [ ] **Step 4: Wire sub-quest checkbox rewards**

Modify check click handler (~line 2175). Only POST /player/reward when toggling TO completed (`!isDone`). Show float text, update HUD, check level_up. Call _checkParentAutoReward after.

- [ ] **Step 5: Add _checkParentAutoReward helper**

After 500ms delay, fetch /quests, find parent, check if all children completed, if so POST /player/reward for parent quest.

- [ ] **Step 6: Add _floatRewardText helper**

Creates a fixed-position `.reward-float` div near the anchor element showing `+XP +gold +gems`, auto-removes after 1500ms.

- [ ] **Step 7: Wire event rewards in addLogEntry**

Add `_rewardedEvents = new Set()` at top. After entry is inserted into DOM, if evt has id and not in Set and not _local: add to Set, POST /player/reward with source "event", show float text, update HUD.

- [ ] **Step 8: Add _celebrateLevelUp function**

Creates `.level-up-overlay` (golden flash) and `.level-up-badge` (circle with level number + "LEVEL UP" text). Adds `.hud-level-up` class to dock level badge. All removed after 3000ms.

- [ ] **Step 9: Build and test full flow**

Run: `npm run build`. Reload. Complete quest, check sub-quest, watch events. Verify HUD updates, floats appear, level-up works.

- [ ] **Step 10: Commit**

```bash
git add src/app.js
git commit -m "feat: wire quest/sub/event rewards to backend, real values in animations, level-up celebration"
```

### Task 6: Add reward animation CSS

**Files:**
- Modify: `realm-map.css` (add reward-float, level-up-overlay, level-up-badge styles)

- [ ] **Step 1: Add reward float and level-up CSS**

Add styles for:
- `.reward-float` -- Cinzel 13px bold, golden with triple text-shadow, `reward-float-rise` animation 1.4s (fade up and out)
- `.level-up-overlay` -- fixed inset 0, z-index 99998, `level-up-flash` animation 2.5s (golden flash)
- `.level-up-badge` -- fixed center, z-index 99999, flex column, `level-badge-rise` animation 2.8s (scale up, hold, fade out)
- `.lub-circle` -- 64px golden circle, Cinzel 28px bold, radial gradient background, glowing box-shadow
- `.lub-text` -- Cinzel 14px, letter-spacing 0.3em, golden glow text-shadow

- [ ] **Step 2: Build, bump cache, restart**

Run `npm run build`, update cache busters in realm-map.html, restart map server.

- [ ] **Step 3: Full end-to-end test**

1. Reload map -- dock HUD shows current stats
2. Complete a childless quest -- particle burst with real XP/gold/gems, HUD animates
3. Check a sub-quest checkbox -- small float text appears, HUD updates
4. Watch SSE events arrive -- subtle float rewards on new log entries
5. If enough XP accumulated, level-up overlay + badge animation fires

- [ ] **Step 4: Commit**

```bash
git add realm-map.css realm-map.html
git commit -m "style: reward float animations, level-up celebration overlay and badge"
```

### Task 7: Final build and integration commit

- [ ] **Step 1: Run full build**

`npm run build`

- [ ] **Step 2: Bump cache busters in realm-map.html**

- [ ] **Step 3: Restart map server via MCP**

- [ ] **Step 4: Clean up any test reward data**

`./venv/bin/python3 -c "import realm_db; realm_db.set_settings('player_rewards', {})"` if needed.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: quest reward system -- XP, Gold, Gems with dock HUD, level-up celebrations"
```
