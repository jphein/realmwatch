# Design: Token Efficiency Improvements (Option B)
**Date:** 2026-03-15
**Status:** Implemented

## Goal

Reduce AI agent context consumption so that development sessions don't require `/compact`.
Root causes: `src/app.js` is 7,777 lines (fills context for any frontend task), and
`realm-map.css` is ~4,300 lines (loaded unnecessarily). No runtime changes.

---

## Phase 1 — Quick Wins

### 1a. `.claudeignore` addition

Add `realm-map.css` — CSS is rarely modified by agents; targeted `Grep` + `Edit` is sufficient.

```
# Large style file — use Grep + Edit for targeted CSS changes
realm-map.css
```

`realm-map.js`, `realm.db`, `topology.json`, `personas.json` already in `.claudeignore`.

### 1b. CLAUDE.md navigation table

Add a `## Navigation` section so agents can open the right file without codebase exploration.

```markdown
## Navigation

| Task | File |
|------|------|
| Speech bubbles / quest events | src/quest-log.js |
| Tooltip content or node sublabels | src/node-status.js |
| Pan/zoom, touch, node drag | src/map-view.js |
| Traffic animation / connection SVG | src/traffic.js |
| Latency / firewall / WiFi / census panels | src/panels.js |
| Persona editor (properties/stats tabs) | src/persona-editor.js |
| Node control/group/shell/chat | src/node-controls.js |
| Spellbook controls / realm search | src/spellbook.js |
| Panel layout / settings / drag | src/layout.js |
| Biome terrain / heightmap | src/terrain.js |
| Motes / sparkles / FPS loop | src/effects.js |
| Debug panel / herald / arcane config | src/debug.js |
| Survey Glass scan runner panel | src/scan.js (existing) |
| SSE connection / event dispatch | src/app.js (residual) |
```

---

## Phase 2 — Split `src/app.js`

### Overview

`src/app.js` (7,777 lines) splits into 12 focused modules plus a thin coordinator (~200 lines).
`src/main.js` import order unchanged (`topology` then `app`). No esbuild config changes.

`src/scan.js` already exists (Survey Glass scan runner). Imported at line 7, `initScanner()`
called at line 6883 (stays in residual `app.js` coordinator). No changes to `scan.js`.

### Module Breakdown

| File | Content | Approx. line ranges | Est. lines |
|------|---------|---------------------|-----------|
| `src/terrain.js` | Biome terrain, mountains, roads, compass, grid; region labels; topographic heightmap; biome sliders | 9–285, 1262–1437, 5465–5486 | ~550 |
| `src/panels.js` | DOM refs + gauges; latency panel; firewall panel; WiFi panel; energy panel; census panel (line ~5060, not adjacent); `_latencyMap`/`_latencyFlat`/`_wifiMap` state | 285–600, 5060–5240 | ~530 |
| `src/node-status.js` | Core sublabels, collectd display, infra nodes, HA sublabels; tooltip delegation; scale sliders (master/node/text/bubble/speed) | 601–904, 917–986 | ~430 |
| `src/traffic.js` | `trafficScale` declaration + connection traffic animation + SVG glow/dash management | 986–1261 | ~280 |
| `src/map-view.js` | Pan & zoom, ghost ley-lines, touch/pinch, node drag (delegated); arcane grid; arcane ambiance; visibility toggles; `_bubbleFixedSize` + `_updateBubbleTotalScale` | 1438–1704, 2571–3180, 5487–5746, 6885–7025 | ~870 |
| `src/quest-log.js` | SSE event rendering (`renderEvent`), speech bubbles, quest log (with tabs), codex/notion, rewards, quest cards, reward burst | 1705–2570 | ~870 |
| `src/persona-editor.js` | Persona editor base + open/close; tab switcher; node properties tab; stats pane | 3181–3718 | ~540 |
| `src/node-controls.js` | Control tab; group tab; connections pane; shell pane; node chat dialog | 3719–4324, 7026–7229 | ~830 |
| `src/spellbook.js` | Spellbook page nav, presets, section reset buttons, magical effects controls; realm search; `_autoDetectEnabled`, `_applyPerfClasses`, `_syncQualityUI` | 4325–5059 | ~735 |
| `src/layout.js` | Auto-arrange; panel layout modes (`setPanelMode`); settings persistence (~6506–6719); draggable UI panels; panel resizing | 5241–5464, 6240–6884 | ~870 |
| `src/effects.js` | Magic motes trail, client RTT ping, FPS loop, ambient sparkles, ley-line sparkles | 5747–6113 | ~370 |
| `src/debug.js` | Arcane config, herald controls, arcane mirror debug panel | 7230–7777 | ~550 |
| `src/app.js` (residual) | SSE connection init + event dispatch; traffic-scale slider handler (lines 905–916); `initScanner()`; calls `init*()` from each module; `_sseConnected` state | 905–916, 6114–6239 + wiring | ~230 |

**Notes on non-obvious placements:**
- Census panel (line ~5060) is in `panels.js` by ownership, not by proximity to other panels (~326–600)
- **Traffic-scale slider handler (lines 905–916) moves to residual `app.js`** — it reads `_sseTrafficMap` (app.js) and needs to call `setTrafficScale(v)` (traffic.js). Keeping it in `app.js` avoids a cycle. `trafficScale` declaration moves to `traffic.js`.
- `_bubbleFixedSize` + `_updateBubbleTotalScale` move to `map-view.js` (they use `scale` from map-view)
- `_latencyMap`/`_latencyFlat`/`_wifiMap` move from SSE block (~6118) to `panels.js` (they are panel-data)

### Import Graph

```
src/main.js
  → src/topology.js   (unchanged)
  → src/app.js        (thin init coordinator)
       → src/config.js        (unchanged)
       → src/utils.js         (unchanged)
       → src/panel-manager.js (unchanged)
       → src/scan.js          (unchanged)
       → src/terrain.js
       → src/panels.js
       → src/node-status.js
       → src/traffic.js
       → src/map-view.js
       → src/quest-log.js
       → src/persona-editor.js
       → src/node-controls.js
       → src/spellbook.js
       → src/layout.js
       → src/effects.js
       → src/debug.js
```

`saveSettings` (from `layout.js`) is called from ~29 sites — every module that calls it
imports from `./layout.js`.

One intentional circular-safe reference: `debug.js` imports `getSseConnected` from `app.js`
while `app.js` imports `initDebug` from `debug.js`. This is safe in ES modules because
`_sseConnected` is only read when the debug panel refreshes interactively (long after
module init completes). No eager initialization issue.

### Cross-module exports: already exported

These are already `export function` / `export let` in `app.js`. Move to owning module;
callers update their import path. No code changes needed beyond adding `import` statements.

| Symbol | Moves to | Imported by |
|--------|----------|------------|
| `generateTerrain()` | `terrain.js` | `app.js` init |
| `updateRegionLabels()` | `terrain.js` | `topology.js` refresh hook |
| `renderTopoLayer(collectd)` | `terrain.js` | `map-view.js`, `spellbook.js`, `node-status.js` |
| `updateUI(d)` | `node-status.js` | `map-view.js` (flush), `app.js` SSE |
| `getNodeTraffic(collectd, nodeKey)` | `traffic.js` | `node-status.js` |
| `updateConnectionTraffic(collectd)` | `traffic.js` | `node-status.js`, `app.js` slider |
| `updateConnectionTrafficSSE(trafficMap)` | `traffic.js` | `app.js` SSE + slider, `map-view.js` (flush) |
| `addLogEntry(evt, nodeEl)` | `quest-log.js` | `app.js` SSE |
| `renderEvent(evt, isRestore)` | `quest-log.js` | `app.js` SSE (line 6154) |
| `updateBubblePositions()` | `quest-log.js` | `topology.js` refresh hook |
| `showSpeechBubble(nodeEl, evt, isAlert)` | `quest-log.js` | `app.js` SSE |
| `showHighlight(nodeEl, evt)` | `map-view.js` | `quest-log.js`, `node-controls.js`, `spellbook.js`, `panels.js` |
| `firePulse()` | `quest-log.js` | `app.js` SSE |
| `showOffline()` | `quest-log.js` | `app.js` SSE |
| `applyTransform()` | `map-view.js` | `layout.js`, `spellbook.js`, `panels.js`, `node-status.js` |
| `centerMap()` | `map-view.js` | `app.js` init, `spellbook.js` |
| `panToNode(x, y)` | `map-view.js` | `panels.js`, `quest-log.js`, `node-status.js` |
| `openPersonaEditor(nodeKey)` | `persona-editor.js` | `topology.js` (dblclick hook), `app.js` SSE |
| `updateNodeListStatus(d)` | `panels.js` | `app.js` SSE |
| `rebuildCensusIfNeeded()` | `panels.js` | `app.js` SSE |
| `autoArrangeLayout(mode)` | `layout.js` | `spellbook.js` |
| `spawnMote(x, y, color)` | `effects.js` | `panel-manager.js`, `layout.js` |
| `saveSettings()` | `layout.js` | everywhere (~29 sites) |
| `restoreSettings()` | `layout.js` | `app.js` init |
| `saveLayout()` | `layout.js` | `app.js` init |
| `restoreLayout()` | `layout.js` | `app.js` init |
| `scheduleSave()` | `layout.js` | `panel-manager.js`, `layout.js` internal |

### Cross-module exports: private symbols requiring new exports

---

**`export let scale, panX, panY` → `map-view.js`**

Already `export let`. ES modules forbid external assignment.
Three external write sites: `spellbook.js` line 4958, `panels.js` line 5106, `layout.js` line 6574.
```js
// map-view.js:
export function setViewport(s, x, y) { scale = s; panX = x; panY = y; }
```

---

**`let _zoomActive` → `map-view.js`**

Read by SSE handlers in residual `app.js` (lines 6137, 6169, 6191, 6206).
```js
// map-view.js:
export const isZoomActive = () => _zoomActive;
```

---

**`let _deferredStatus/Energy/Latency` + `let _deferredTrafficMap` → `map-view.js`**

SSE handlers write the deferred flags; `_flushDeferredUpdates` stays in `map-view.js`.
Note: `_deferredTraffic` (boolean) becomes `_deferredTrafficMap` (stores the actual map).
```js
// map-view.js:
export function setDeferredStatus(v)     { _deferredStatus   = v; }
export function setDeferredTraffic(map)  { _deferredTrafficMap = map; }
export function setDeferredEnergy(v)     { _deferredEnergy   = v; }
export function setDeferredLatency(v)    { _deferredLatency  = v; }
```
`_flushDeferredUpdates` calls `updateUI` (node-status.js), `updateEnergyPanel` and
`updateLatencyPanel` (panels.js), `renderTopoLayer` + `setLastTopoCollectd` (terrain.js),
`updateConnectionTrafficSSE` + `trafficToCollectd` (traffic.js). Import all from their modules.
The `_sseTrafficMap` read is eliminated: the stored `_deferredTrafficMap` value is used directly.

---

**`let _sseTrafficMap` — circular dependency resolution**

`_sseTrafficMap` stays in residual `app.js` (SSE coordinator). It is no longer read by
`node-status.js` (see `updateUI` fix below) or by `_flushDeferredUpdates` (uses
`_deferredTrafficMap` instead). The traffic-scale slider handler in app.js reads it directly.
No export needed; no cycle.

**`updateUI` fix:** Remove the `_sseTrafficMap`-dependent calls at lines 872 and 912 from
`updateUI`. Move the `updateConnectionTrafficSSE(_sseTrafficMap)` call into the SSE `status`
handler in `app.js` (which has direct access). `updateUI` no longer references `_sseTrafficMap`.

---

**`let _gpuZoomEnabled` → move to `map-view.js`**

Declared in spellbook territory (line 4518), read only by `_enterZoomMode` (map-view.js).
Move declaration to `map-view.js`.
```js
// map-view.js:
export function setGpuZoomEnabled(v) { _gpuZoomEnabled = v; }
```

---

**`moteCtx`, `moteCanvas`, `_ensureMoteLoop`, `_updateSparkleRect` → `effects.js`**

Used by `_enterZoomMode` (line 2703) and `_exitZoomMode` (lines 2727–2728).
```js
// effects.js:
export function clearMoteCanvas() { moteCtx.clearRect(0, 0, moteCanvas.width, moteCanvas.height); }
export function updateSparkleRect() { _updateSparkleRect(); }
export function ensureMoteLoop() { _ensureMoteLoop(); }
```

---

**`function _trafficToCollectd` → `traffic.js`**

Called in `_flushDeferredUpdates` (map-view.js).
```js
// traffic.js:
export function trafficToCollectd(trafficMap) { /* existing body */ }
```

---

**`let trafficScale` → `traffic.js`**

Move declaration to `traffic.js`. Export setter for the slider handler in app.js.
```js
// traffic.js:
export function setTrafficScale(v) { trafficScale = v; }
```
The slider handler (lines 905–916) moves to residual `app.js` coordinator:
it calls `setTrafficScale(v)`, has direct access to `_sseTrafficMap`, and calls
`updateConnectionTrafficSSE` / `updateConnectionTraffic` already imported.

---

**`let _lastTopoCollectd` → `terrain.js`**

Written at line 874 (node-status.js `updateUI`) and in `_flushDeferredUpdates` (map-view.js).
```js
// terrain.js:
export function setLastTopoCollectd(v) { _lastTopoCollectd = v; }
```

---

**`_topoEnabled` — external guards are redundant**

`renderTopoLayer` internally guards `if (!_topoEnabled) return`. The external guards at
lines 875, 4477, and 2739 are redundant. Remove them. No export needed.

---

**`_topoNodeMap`, `_topoHash`, `_getTopoNodeMap`, `_topoForceRender` → `terrain.js`**

- `_topoNodeMap = null` at lines 5426 (layout.js) and 6964 (map-view.js): cache invalidation
- `_topoForceRender()` at lines 5427 (layout.js) and 6965 (map-view.js): force re-render
- `_getTopoNodeMap()` at line 5962 (effects.js): ley-line sparkle node lookup
- `_topoHash = ''` at line 4476 (spellbook.js): invalidate hash on quality tier change
```js
// terrain.js:
export function invalidateTopoNodeMap() { _topoNodeMap = null; }
export function forceTopoRender()       { _topoForceRender(); }
export function getTopoNodeMap()        { return _getTopoNodeMap(); }
export function resetTopoHash()         { _topoHash = ''; }
```

---

**`_fitToNodes` → `map-view.js`**

Called from layout.js auto-arrange worker `onmessage` (line 5353).
```js
// map-view.js:
export function fitToNodes() { _fitToNodes(); }
```

---

**`let _latencyMap`, `let _latencyFlat`, `let _wifiMap` → `panels.js`**

Move from app.js SSE block (line 6118). SSE handler writes them; panels/effects/layout read them.
```js
// panels.js:
export function setLatencyMap(v)   { _latencyMap = v; }
export function setLatencyFlat(v)  { _latencyFlat = v; }
export function setWifiMap(v)      { _wifiMap = v; }
export const getLatencyFlat = ()   => _latencyFlat;
export const getWifiMap     = ()   => _wifiMap;
```
The SSE latency handler (app.js) keeps the group-iteration flat-extraction logic and calls
both `setLatencyMap(parsed)` and `setLatencyFlat(flat)` after computing the flat map.
`updateLatencyPanel` reads `_latencyMap` locally. `effects.js` imports `getLatencyFlat`.
`layout.js` imports `getLatencyFlat` + `getWifiMap` for auto-arrange worker.

---

**`function updateFirewallPanel(d)`, `function _renderFirewallPanel()`,
`let _fwData` → `panels.js`**

`updateFirewallPanel` (line 427) called from `updateUI` in node-status.js (line 880).
App.js SSE (line 6213) does `if (!d.error) { _fwData = d; _renderFirewallPanel(); }`.
Export a combined handler so app.js never writes `_fwData` directly:
```js
// panels.js:
export function updateFirewallPanel(d)  { /* existing body */ }
export function handleFirewallData(d)   { if (!d.error) { _fwData = d; _renderFirewallPanel(); } }
```
App.js SSE calls `handleFirewallData(d)`.

---

**`function _renderWifiPanel(data)` → `panels.js`**

Called by app.js SSE (line 6218).
```js
// panels.js:
export function renderWifiPanel(data) { _renderWifiPanel(data); }
```

---

**`function updateGauges(d)` → `panels.js`**

Called from `updateUI` (node-status.js, line 850).
```js
// panels.js:
export function updateGauges(d) { /* existing body */ }
```

---

**`let _bubbleFixedSize` + `function _updateBubbleTotalScale` → move to `map-view.js`**

These use `scale` (map-view) and are called from `applyTransform` (map-view), node-status.js,
and spellbook.js. Moving to map-view.js avoids a node-status ↔ map-view cycle.
```js
// map-view.js:
export function updateBubbleTotalScale() { _updateBubbleTotalScale(); }
export function setBubbleFixedSize(v) {
  _bubbleFixedSize = v;
  document.getElementById('map-world').classList.toggle('bubble-fixed', v);
  _updateBubbleTotalScale();
}
```
Spellbook.js bubble-fixed checkbox calls `setBubbleFixedSize(v)`.
Node-status.js bubble-scale slider calls `updateBubbleTotalScale()`.

---

**`let lastStatus` → `node-status.js`**

Declared at line 302 (DOM-refs, panels.js territory) but owned by `updateUI` (node-status.js).
Move declaration to node-status.js. Export getter for persona-editor.js, node-controls.js, debug.js.
```js
// node-status.js:
export const getLastStatus = () => lastStatus;
```

---

**`let _sseConnected` → stays in residual `app.js`**

Read by debug.js (lines 7432, 7439). Export getter from app.js.
```js
// app.js:
export const getSseConnected = () => _sseConnected;
```
debug.js imports `getSseConnected` from `./app.js`.
This creates a `debug.js` ↔ `app.js` mutual import. It is safe at runtime: `getSseConnected`
is only called during interactive debug panel refreshes (long after module init).

---

**`let lastEventTs` → `quest-log.js`**

Read by debug.js (line 7504).
```js
// quest-log.js:
export const getLastEventTs = () => lastEventTs;
```

---

**`_applyPerfClasses`, `_syncQualityUI`, `let _autoDetectEnabled` → `spellbook.js`**

Called from effects.js FPS auto-downgrade path (lines 5842–5851).
```js
// spellbook.js:
export function applyPerfClasses()        { _applyPerfClasses(); }
export function syncQualityUI()           { _syncQualityUI(); }
export const getAutoDetectEnabled = ()    => _autoDetectEnabled;
```

---

**`function _switchToTab(name)` → `persona-editor.js`**

Called by `_applySettings` in layout.js (line 6582).
```js
// persona-editor.js:
export function switchToTab(name) { _switchToTab(name); }
```

---

**`let _spellPage` + `function _showSpellPage` → `spellbook.js`**

`saveSettings` (layout.js) reads `_spellPage`; `_applySettings` (layout.js) calls `_showSpellPage`.
```js
// spellbook.js:
export const getSpellPage = () => _spellPage;
export function showSpellPage(idx) { _showSpellPage(idx); }
```

---

**`function updateCensusSubLabels(d)` → `panels.js`**

Called by `updateUI` in node-status.js (line 878).
```js
// panels.js:
export function updateCensusSubLabels(d) { /* existing body */ }
```

---

**`function setPanelMode(mode)` → `layout.js`**

Called by spellbook.js panel-mode buttons (line 5561).
```js
// layout.js:
export function setPanelMode(mode) { /* existing body */ }
```

---

**`let currentEditNode` → `persona-editor.js`**

Read by node-controls.js.
```js
// persona-editor.js:
export const getCurrentEditNode = () => currentEditNode;
```

---

**`let activeTab` → `quest-log.js`**

Read by `saveSettings` (layout.js, line 6516).
```js
// quest-log.js:
export const getActiveTab = () => activeTab;
```

---

**`let liveOk` → stays in residual `app.js`**

Declared at line 303 (DOM-refs area, panels.js territory) but exclusively written and read
in the SSE coordinator block (lines 6183–6187). Move declaration to residual `app.js`.
No export needed.

---

**`DOM` object → `panels.js`**

`panels.js` exports `DOM`. Modules that access `DOM.*` import it.

---

### Required exports summary

| Module | New exports needed | Already exported |
|--------|-------------------|-----------------|
| `terrain.js` | `setLastTopoCollectd`, `invalidateTopoNodeMap`, `forceTopoRender`, `getTopoNodeMap`, `resetTopoHash` | `generateTerrain`, `updateRegionLabels`, `renderTopoLayer` |
| `panels.js` | `DOM`, `updateGauges`, `setLatencyMap`, `setWifiMap`, `getLatencyFlat`, `getWifiMap`, `updateEnergyPanel`, `updateLatencyPanel`, `updateFirewallPanel`, `handleFirewallData`, `renderWifiPanel`, `updateCensusSubLabels` | `updateNodeListStatus`, `rebuildCensusIfNeeded` |
| `node-status.js` | `getLastStatus` | `updateUI`, `getNodeTraffic`, `updateConnectionTraffic` |
| `traffic.js` | `trafficToCollectd`, `setTrafficScale` | `updateConnectionTrafficSSE` |
| `map-view.js` | `setViewport`, `isZoomActive`, `setDeferredStatus/Energy/Latency`, `setDeferredTraffic(map)`, `setGpuZoomEnabled`, `updateBubbleTotalScale`, `setBubbleFixedSize`, `fitToNodes` | `scale, panX, panY`, `applyTransform`, `centerMap`, `panToNode`, `showHighlight` |
| `quest-log.js` | `getActiveTab`, `getLastEventTs` | `renderEvent`, `addLogEntry`, `showSpeechBubble`, `updateBubblePositions`, `firePulse`, `showOffline` |
| `persona-editor.js` | `getCurrentEditNode`, `switchToTab` | `openPersonaEditor` |
| `spellbook.js` | `getSpellPage`, `showSpellPage`, `applyPerfClasses`, `syncQualityUI`, `getAutoDetectEnabled` | `autoArrangeLayout` |
| `effects.js` | `clearMoteCanvas`, `ensureMoteLoop`, `updateSparkleRect` | `spawnMote` |
| `layout.js` | `setPanelMode` | `saveSettings`, `restoreSettings`, `saveLayout`, `restoreLayout`, `scheduleSave` |
| `debug.js` | `scheduleDebugRefresh` (wraps `_dbgRefreshTimer`/`_dbgRefresh` — called by `updateUI` at lines 883–884) | — |
| `app.js` (residual) | `getSseConnected` | — |

### Discovery principle

The table above covers all cross-module accesses identified through exhaustive inspection.
During implementation, verify each new file by searching:
```bash
grep -n "SYMBOL" src/app.js   # find all sites; confirm each site's module line range
```
If a private `let`/`function` in module A is accessed from module B's line range,
add an export to A. This is the only pattern needed.

### Build

```bash
npm run build   # unchanged — esbuild follows imports, no config changes
```

---

## Out of Scope

- No runtime behavior changes, no new features
- `src/topology.js`, `src/panel-manager.js`, `src/config.js`, `src/utils.js`, `src/scan.js` — not modified
- Python backend — not touched
- `realm-map.html` — not modified

---

## Success Criteria

1. `npm run build` succeeds with no errors
2. All existing functionality works identically in the browser
3. No module exceeds ~900 lines
4. `src/app.js` is ≤200 lines
5. The CLAUDE.md navigation table correctly maps tasks to files
