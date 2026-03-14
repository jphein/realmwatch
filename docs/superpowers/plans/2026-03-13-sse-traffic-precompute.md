# SSE + Server-Side Traffic Pre-computation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser polling with a single SSE stream and server-side traffic pre-computation, making the realm map feel instant without changing any visuals.

**Architecture:** map_server.py gets a `/sse` endpoint powered by a background thread that collects data from existing sources (engine, collectd_reader, ha_bridge, etc.), detects changes via hashing, and pushes typed SSE events. A new `traffic_precompute.py` module handles hostname matching + log-scale intensity math server-side. The frontend replaces 3 polling loops + 1 energy fetch with a single `EventSource('/sse')`.

**Tech Stack:** Python stdlib (`http.server.ThreadingHTTPServer`, `threading`, `queue`), vanilla JS `EventSource`

**Spec:** `docs/superpowers/specs/2026-03-13-sse-traffic-precompute-design.md`

---

## File Structure

| File | Role | Action |
|------|------|--------|
| `traffic_precompute.py` | Hostname matching + best-interface + log-scale intensity | **Create** |
| `sse_broker.py` | SSE client registry + background data collection + change detection + push | **Create** |
| `map_server.py` | Extract `build_status()`, add `/sse` endpoint, switch to `ThreadingHTTPServer` | **Modify** |
| `src/app.js` | Replace polling with EventSource, add `updateConnectionTrafficSSE()` | **Modify** |
| `src/config.js` | Add SSE constants | **Modify** |

---

## Chunk 1: Server-Side Traffic Pre-computation

### Task 1: Create `traffic_precompute.py`

This module moves the hostname matching + best-interface selection + log-scale math from `src/app.js:669-695` to the server.

**Files:**
- Create: `traffic_precompute.py`

- [ ] **Step 1: Write the module**

```python
"""Pre-compute per-node traffic intensity from collectd data.

Moves hostname matching, best-interface selection, and log-scale
intensity computation from the browser to the server.
"""

import math
from collectd_reader import get_all_summaries


def _match_host(collectd, node_id):
    """Match a topology node ID to a collectd hostname.

    Tries: exact match, then prefix match (hostname.domain.tld → hostname),
    then fuzzy match (ignoring hyphens/underscores).
    Mirrors the logic in app.js getNodeTraffic().
    """
    key = node_id.lower()
    # Exact
    if node_id in collectd:
        return collectd[node_id]
    # Prefix
    for k, v in collectd.items():
        if k.lower().split('.')[0] == key:
            return v
    # Fuzzy
    norm = key.replace('-', '').replace('_', '')
    for v in collectd.values():
        h = (v.get('hostname') or '').lower().replace('-', '').replace('_', '')
        if h == norm:
            return v
    return None


def _best_interface(host_data):
    """Pick the busiest interface (highest rx+tx). Returns (rx, tx, total) or None."""
    ifaces = host_data.get('interfaces')
    if not ifaces:
        return None
    best_rx, best_tx, best_total = 0, 0, 0
    for iface in ifaces.values():
        rx = iface.get('rx_bps', 0) or 0
        tx = iface.get('tx_bps', 0) or 0
        total = rx + tx
        if total > best_total:
            best_rx, best_tx, best_total = rx, tx, total
    if best_total == 0:
        return None
    return best_rx, best_tx, best_total


def compute_traffic(topology_nodes):
    """Compute per-node traffic from current collectd data.

    Returns {node_id: {"rx": float, "tx": float, "total": float, "intensity": float}}
    for all nodes that have traffic data.
    """
    collectd = get_all_summaries()
    result = {}
    for node in topology_nodes:
        nid = node["id"]
        host = _match_host(collectd, nid)
        if not host:
            continue
        best = _best_interface(host)
        if not best:
            continue
        rx, tx, total = best
        # Raw log-scale intensity: 0->1 mapped over 1 KB/s -> 10 MB/s
        # Matches app.js: Math.max(0, Math.min(1, (Math.log10(total + 1) - 3) / 4))
        raw = max(0.0, min(1.0, (math.log10(total + 1) - 3) / 4))
        result[nid] = {"rx": round(rx, 1), "tx": round(tx, 1),
                       "total": round(total, 1), "intensity": round(raw, 4)}
    return result
```

- [ ] **Step 2: Smoke test from command line**

Run: `cd /home/jp/Projects/lit-rpg-fantasy-voice && ./venv/bin/python3 -c "from traffic_precompute import compute_traffic; import realm_db; realm_db.init(); t = realm_db.get_topology(); print(compute_traffic(t.get('nodes',[])))"`

Expected: Dict with node IDs as keys, each having rx/tx/total/intensity fields. Non-empty if collectd is running.

- [ ] **Step 3: Commit**

```bash
git add traffic_precompute.py
git commit -m "feat: add server-side traffic pre-computation module"
```

---

## Chunk 2: SSE Broker + Extract shared status builder

### Task 2: Extract `build_status()` from map_server.py

The SSE broker needs to build the same status blob as the `/status` endpoint. Extract it as a shared function to avoid duplication and circular imports.

**Files:**
- Modify: `map_server.py:155-168` (handler)

- [ ] **Step 1: Extract `build_status()` as a module-level function**

Add this function before the `RealmHandler` class in `map_server.py` (after `_load_topology`, around line 67):

```python
def build_status():
    """Build the full status blob (shared by /status endpoint and SSE broker)."""
    status = engine.get_status()
    status["tailscale"] = engine.get_tailscale_status()
    status["adult"] = engine.adult_observation(status)
    status["host"] = engine.get_host_config()
    status["collectd"] = get_all_summaries()
    status["wifi"] = ap_scanner.get_wifi_signal()
    status["ha"] = ha_bridge.get_ha_states()
    status["wled"] = wled_bridge.get_wled_states()
    topo_nodes = _load_topology().get("nodes", [])
    status["roles"] = {n["id"]: node_roles.get_role(n["id"], n) for n in topo_nodes}
    status["groups"] = node_roles.get_ha_map()
    return status
```

- [ ] **Step 2: Update `/status` handler to use `build_status()`**

Change the `/status` handler (lines 156-168) from the inline logic to:

```python
        if self.path == "/status":
            self._json_response(build_status())
```

- [ ] **Step 3: Verify `/status` still works**

Run: `curl -s http://localhost:8777/status | python3 -m json.tool | head -5`

Expected: Valid JSON with `forge`, `mana`, etc.

- [ ] **Step 4: Commit**

```bash
git add map_server.py
git commit -m "refactor: extract build_status() for reuse by SSE broker"
```

### Task 3: Create `sse_broker.py`

The broker manages SSE client connections, runs a background data collection loop, detects changes via hashing, and pushes typed events to all connected clients. Imports `build_status` and `_get_energy_data` from `map_server` (no circular import since broker doesn't get imported at module load time by map_server — it's imported after these functions are defined).

**Files:**
- Create: `sse_broker.py`

- [ ] **Step 1: Write the broker module**

```python
"""SSE broker -- background data collection, change detection, client push.

Manages a set of connected SSE clients (thread-safe queue per client).
A single background thread collects data from existing sources, hashes for
changes, and pushes typed events only when data differs.
"""

import hashlib
import json
import queue
import threading
import time

import realm_db
from traffic_precompute import compute_traffic


class SSEBroker:
    def __init__(self, status_fn, energy_fn):
        """Initialize broker.

        Args:
            status_fn: callable returning the full status dict (map_server.build_status)
            energy_fn: callable returning energy data dict (map_server._get_energy_data)
        """
        self._status_fn = status_fn
        self._energy_fn = energy_fn
        self._clients = []  # list of queue.Queue
        self._lock = threading.Lock()
        self._hashes = {}  # {event_type: last_hash}
        self._last_event_ts = 0.0
        self._running = False

    def add_client(self):
        """Register a new SSE client. Returns a Queue that receives (event_type, data_json) tuples."""
        q = queue.Queue(maxsize=50)
        with self._lock:
            self._clients.append(q)
        return q

    def remove_client(self, q):
        """Unregister an SSE client."""
        with self._lock:
            try:
                self._clients.remove(q)
            except ValueError:
                pass

    def _broadcast(self, event_type, data):
        """Send an event to all connected clients."""
        payload = json.dumps(data, separators=(',', ':'))
        dead = []
        with self._lock:
            for q in self._clients:
                try:
                    q.put_nowait((event_type, payload))
                except queue.Full:
                    dead.append(q)
            for q in dead:
                try:
                    self._clients.remove(q)
                except ValueError:
                    pass

    def _hash(self, data):
        """Fast hash of JSON-serializable data for change detection."""
        return hashlib.md5(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()[:12]

    def _check_and_push(self, event_type, data):
        """Push event only if data hash changed."""
        h = self._hash(data)
        if h != self._hashes.get(event_type):
            self._hashes[event_type] = h
            self._broadcast(event_type, data)
            return True
        return False

    def _collect_loop(self):
        """Main background loop -- runs every 5s, checks for changes, pushes events."""
        tick = 0
        topo_nodes = []
        while self._running:
            try:
                # -- Traffic: every tick (5s) --
                if topo_nodes:
                    traffic = compute_traffic(topo_nodes)
                    if traffic:
                        self._check_and_push("traffic", traffic)

                # -- Events: every tick --
                events = realm_db.get_events_since(self._last_event_ts)
                for evt in events:
                    self._last_event_ts = max(self._last_event_ts, evt.get("ts", 0))
                    self._broadcast("realm-event", evt)

                # -- Status: every 2nd tick (10s) --
                if tick % 2 == 0:
                    status = self._status_fn()
                    self._check_and_push("status", status)

                # -- Topology: every 12th tick (60s) --
                if tick % 12 == 0:
                    topo = realm_db.get_topology()
                    topo_nodes = topo.get("nodes", [])
                    self._check_and_push("topology", topo)

                # -- Energy: every 6th tick (30s) --
                if tick % 6 == 0:
                    try:
                        energy = self._energy_fn()
                        if "error" not in energy:
                            self._check_and_push("energy", energy)
                    except Exception:
                        pass

            except Exception as e:
                print(f"SSE broker error: {e}")

            tick += 1
            time.sleep(5)

    def start(self):
        """Start the background collection thread."""
        if self._running:
            return
        self._running = True
        self._last_event_ts = time.time() - 600  # Catch up last 10 min of events on start
        t = threading.Thread(target=self._collect_loop, daemon=True, name="sse-broker")
        t.start()

    def stop(self):
        self._running = False
```

- [ ] **Step 2: Smoke test the broker**

Run: `cd /home/jp/Projects/lit-rpg-fantasy-voice && ./venv/bin/python3 -c "
import realm_db; realm_db.init()
from map_server import build_status, _get_energy_data
from sse_broker import SSEBroker
b = SSEBroker(build_status, _get_energy_data)
q = b.add_client()
b.start()
import time; time.sleep(6)
msgs = []
while not q.empty():
    msgs.append(q.get_nowait())
print(f'Got {len(msgs)} events: {[m[0] for m in msgs]}')
b.stop()
"`

Expected: `Got N events: ['traffic', 'realm-event', ..., 'status', 'topology']` (at least traffic + status + topology on first tick).

- [ ] **Step 3: Commit**

```bash
git add sse_broker.py
git commit -m "feat: add SSE broker with change detection and typed events"
```

---

## Chunk 3: Wire SSE into map_server.py

### Task 4: Add `/sse` endpoint and switch to ThreadingHTTPServer

**Files:**
- Modify: `map_server.py` (imports at top, new class before `RealmHandler`, new route in `do_GET`, main block at bottom)

- [ ] **Step 1: Add imports**

At top of `map_server.py`, add to existing imports:

```python
import queue
from socketserver import ThreadingMixIn
from sse_broker import SSEBroker
```

- [ ] **Step 2: Add ThreadingHTTPServer class**

Before the `RealmHandler` class (around line 140), add:

```python
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
```

- [ ] **Step 3: Add SSE broker initialization**

After `engine = LitRPGEngine()` (line 35), add:

```python
_sse_broker = SSEBroker(build_status, _get_energy_data)
```

Note: This line must come AFTER the `build_status` and `_get_energy_data` function definitions. Since `build_status` was added around line 67 and `_get_energy_data` is at line 70, place this after both — e.g. around line 130 (before the ThreadingHTTPServer class).

- [ ] **Step 4: Add `/sse` route to `do_GET`**

In the `do_GET` method, add a new route after the `/energy` route and before the final `else` / `super().do_GET()`:

```python
        elif self.path.startswith("/sse"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            client_q = _sse_broker.add_client()
            try:
                # Send initial keepalive
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        event_type, payload = client_q.get(timeout=15)
                        self.wfile.write(f"event: {event_type}\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                    except queue.Empty:
                        # Keepalive comment to detect dead connections
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                _sse_broker.remove_client(client_q)
            return
```

- [ ] **Step 5: Switch to ThreadingHTTPServer in main block**

Change line 580:
```python
    HTTPServer(("", PORT), RealmHandler).serve_forever()
```
to:
```python
    _sse_broker.start()
    ThreadingHTTPServer(("", PORT), RealmHandler).serve_forever()
```

- [ ] **Step 6: Test the SSE endpoint manually**

Restart map_server, then:
```bash
curl -N http://localhost:8777/sse 2>/dev/null | head -20
```

Expected: `: connected` first, then `event: traffic`, `event: status`, `event: topology` lines within 10 seconds.

- [ ] **Step 7: Commit**

```bash
git add map_server.py
git commit -m "feat: add /sse endpoint with ThreadingHTTPServer"
```

---

## Chunk 4: Frontend — Replace Polling with EventSource

### Task 5: Add SSE constants to config.js

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Add SSE constants**

Append to `src/config.js`:
```javascript
// SSE connection
export const SSE_URL = '/sse';
```

- [ ] **Step 2: Commit**

```bash
git add src/config.js
git commit -m "feat: add SSE config constants"
```

### Task 6: Replace polling loops with EventSource in app.js

Core frontend change. Replace `poll()`, `pollEvents()`, `setInterval(refreshTopology, 90000)`, and `setInterval(fetchEnergy, 30000)` with a single `EventSource('/sse')`, and add `updateConnectionTrafficSSE()`.

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: Add SSE import**

At the top of `src/app.js` (line 3, after existing config import), add `SSE_URL` to the config import:

Change:
```javascript
import { WORLD_W, WORLD_H, WORLD_SCALE, _isMobile, _cpuCores, _perfTier, setPerfTier, _PERF, _mapTilt, setMapTilt } from './config.js';
```
To:
```javascript
import { WORLD_W, WORLD_H, WORLD_SCALE, _isMobile, _cpuCores, _perfTier, setPerfTier, _PERF, _mapTilt, setMapTilt, SSE_URL } from './config.js';
```

- [ ] **Step 2: Add `updateConnectionTrafficSSE()` function**

Add after the existing `updateConnectionTraffic()` function ends (after line 807, after the node icon scaling block). This function receives pre-computed `{nodeId: {rx, tx, total, intensity}}` from the server:

```javascript
/**
 * SSE-optimized traffic update -- receives pre-computed {nodeId: {rx, tx, total, intensity}}.
 * Skips hostname matching + interface scan + log math (done server-side).
 * Still applies local trafficScale, stroke colors, node icon scaling, and top-N glow.
 */
export function updateConnectionTrafficSSE(trafficMap) {
  if (!trafficMap) return;
  const trafficData = [];

  _connLinesWithData.forEach(line => {
    const cache = _connCache.get(line) || { connType: null, sw: 0, speed: 0, dir: '', tier: '', stroke: '', animated: false, glow: false };
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toT = trafficMap[toNode];
    const fromT = fromNode ? trafficMap[fromNode] : null;
    const traffic = (toT && fromT)
      ? (toT.total > fromT.total ? toT : fromT)
      : (toT || fromT);
    const baseW = _connBaseWidths.get(line) || 1.5;

    if (!traffic || traffic.total === 0) {
      if (cache.tier || cache.sw !== baseW || cache.animated || cache.glow) {
        line.style.setProperty('--sw', baseW);
        line.style.removeProperty('--speed');
        line.style.removeProperty('--dir');
        line.removeAttribute('stroke');
        if (cache.tier) line.classList.remove(cache.tier);
        if (cache.animated) { line.classList.remove('conn-animated'); cache.animated = false; }
        if (cache.glow) { line.classList.remove('conn-glow'); cache.glow = false; }
        cache.sw = baseW; cache.speed = 0; cache.dir = ''; cache.tier = ''; cache.stroke = '';
      }
      return;
    }

    if (!cache.animated) { line.classList.add('conn-animated'); cache.animated = true; }
    // Server sends raw intensity (0-1), apply local trafficScale
    const intensity = Math.min(1, traffic.intensity * trafficScale);
    const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
    const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
    const dir = traffic.rx > traffic.tx ? 'reverse' : 'normal';
    const tier = intensity > 0.65 ? 'conn-traffic-high' : intensity > 0.35 ? 'conn-traffic-med' : intensity > 0.15 ? 'conn-traffic-low' : '';

    if (sw !== cache.sw) { line.style.setProperty('--sw', sw); cache.sw = sw; }
    if (speed !== cache.speed) { line.style.setProperty('--speed', speed + 's'); cache.speed = speed; }
    if (dir !== cache.dir) { line.style.setProperty('--dir', dir); cache.dir = dir; }

    if (cache.connType) {
      const vlan = line.dataset.vlan;
      const [r,g,b] = (vlan && vlanColors[vlan]) || connColors[cache.connType] || [100,180,255];
      const alpha = +(0.15 + intensity * 0.5).toFixed(2);
      const bright = 1 + intensity * 0.3;
      const stroke = `rgba(${Math.min(255,r*bright)|0},${Math.min(255,g*bright)|0},${Math.min(255,b*bright)|0},${alpha})`;
      if (stroke !== cache.stroke) { line.setAttribute('stroke', stroke); cache.stroke = stroke; }
    }

    if (tier !== cache.tier) {
      if (cache.tier) line.classList.remove(cache.tier);
      if (tier) line.classList.add(tier);
      cache.tier = tier;
    }

    if (intensity > 0.3) trafficData.push({ line, cache, intensity });
  });

  // Top-N glow (same as original)
  trafficData.sort((a, b) => b.intensity - a.intensity);
  const topLines = new Set(trafficData.slice(0, TOP_GLOW_COUNT).map(d => d.line));
  trafficData.forEach(({ line, cache }) => {
    const shouldGlow = topLines.has(line);
    if (shouldGlow !== cache.glow) {
      if (shouldGlow) line.classList.add('conn-glow');
      else line.classList.remove('conn-glow');
      cache.glow = shouldGlow;
    }
  });

  // Node icon scaling (same as original, using pre-computed intensity)
  for (const tipKey of Object.keys(_nodeDOM)) {
    const n = _nodeDOM[tipKey];
    if (!n.el) continue;
    const icon = n._icon || (n._icon = n.el.querySelector('.node-icon'));
    if (!icon) continue;
    const t = trafficMap[tipKey];
    if (!t || t.total === 0) {
      if (n._lastTrafficScale) { icon.style.transform = ''; icon.style.filter = ''; n._lastTrafficScale = 0; }
      continue;
    }
    const intensity = Math.min(1, t.intensity * trafficScale);
    const s = 1 + intensity * 0.5;
    if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
      icon.style.transform = `scale(${s.toFixed(2)})`;
      icon.style.filter = intensity > 0.3 ? `brightness(${(1 + intensity * 0.4).toFixed(2)})` : '';
      n._lastTrafficScale = s;
    }
  }
}

// Convert SSE traffic map to a collectd-like object for renderTopoLayer
function _trafficToCollectd(trafficMap) {
  const fake = {};
  for (const [nodeId, t] of Object.entries(trafficMap)) {
    fake[nodeId] = { hostname: nodeId, interfaces: { best: { rx_bps: t.rx, tx_bps: t.tx } } };
  }
  return fake;
}
```

- [ ] **Step 3: Update traffic scale slider to use SSE path**

Change the traffic slider handler at line 594 from:
```javascript
  if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
```
To:
```javascript
  if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
  else if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
```

(The `_sseTrafficMap` variable is declared in the next step at module scope, so this forward reference is fine in JS.)

- [ ] **Step 4: Comment out polling loops and add EventSource**

Comment out (not delete yet) these sections:
1. The `poll()` function and its initial `poll()` call (~lines 1893-1907)
2. The `pollEvents()` function and its initial `pollEvents()` call (~lines 1383-1402)
3. The `setInterval(refreshTopology, 90000)` call (line 1405)
4. The `fetchEnergy()` function and its `setInterval(fetchEnergy, 30000)` (lines 4282-4291)

Then add at module scope (not inside any IIFE), before the settings persistence section:

```javascript
// ── SSE Connection (replaces poll + pollEvents + refreshTopology + fetchEnergy) ──
let _sseTrafficMap = null;  // Last received traffic data (module scope for slider + guard)

(function initSSE() {
  const sse = new EventSource(SSE_URL);
  let sseConnected = false;
  // Restore mode: events arriving before the first 'status' are restores (no animation/sound).
  // Reset on every reconnect so catch-up events after auto-reconnect are also restored.
  let _sseRestoreMode = true;

  sse.addEventListener('traffic', e => {
    const traffic = JSON.parse(e.data);
    _sseTrafficMap = traffic;
    updateConnectionTrafficSSE(traffic);
    // Feed topo heightmap with converted data
    const fakeCollectd = _trafficToCollectd(traffic);
    _lastTopoCollectd = fakeCollectd;
    if (_topoEnabled) renderTopoLayer(fakeCollectd);
  });

  sse.addEventListener('realm-event', e => {
    const evt = JSON.parse(e.data);
    // Events arriving before first status push are restores (show bubble, no flash/sound)
    renderEvent(evt, _sseRestoreMode);
  });

  sse.addEventListener('topology', e => {
    // Topology changes are rare. Re-use existing refreshTopology() which fetches
    // /topology via HTTP — it has DOM-preservation logic we don't want to duplicate.
    // Future optimization: accept pushed data directly to avoid the extra fetch.
    refreshTopology();
  });

  sse.addEventListener('status', e => {
    const d = JSON.parse(e.data);
    // First status event ends restore mode (all catch-up events have been delivered)
    _sseRestoreMode = false;
    updateUI(d);
    if (!liveOk) { liveOk = true; console.log('Realm Map: SSE live data connected'); }
  });

  sse.addEventListener('energy', e => {
    const data = JSON.parse(e.data);
    updateEnergyPanel(data);
  });

  sse.addEventListener('open', () => {
    if (!sseConnected) {
      sseConnected = true;
      // Reset restore mode on each reconnect so catch-up events are quiet
      _sseRestoreMode = true;
      console.log('Realm Map: SSE connected');
    }
  });

  sse.addEventListener('error', () => {
    if (sseConnected) {
      sseConnected = false;
      console.warn('Realm Map: SSE disconnected, reconnecting...');
      showOffline();
    }
    // EventSource auto-reconnects
  });
})();
```

- [ ] **Step 5: Guard updateUI against double traffic updates**

In the existing `updateUI(d)` function (~line 558), change:
```javascript
  updateConnectionTraffic(d.collectd);
  _lastTopoCollectd = d.collectd;
  if (_topoEnabled) renderTopoLayer(d.collectd);
```
To:
```javascript
  // When SSE is active, traffic updates come via the 'traffic' event -- skip here
  if (!_sseTrafficMap) {
    updateConnectionTraffic(d.collectd);
    _lastTopoCollectd = d.collectd;
    if (_topoEnabled) renderTopoLayer(d.collectd);
  }
```

- [ ] **Step 6: Build and test**

Run: `npm run build`

Restart map_server and open http://localhost:8777. Verify:
- SSE connection appears in browser DevTools Network tab (event-stream type)
- Traffic animations work (connections pulse with VLAN colors)
- Node icons scale with traffic
- Topo heightmap renders
- Quest log shows events (initial events appear as restore — bubble only, no flash)
- Energy panel updates
- No polling requests to /status, /events in Network tab (only /sse)
- Traffic scale slider still works (adjusts line widths/brightness)
- "OFFLINE" indicator appears if server is killed, clears on reconnect

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/app.js
git commit -m "feat: replace polling with SSE EventSource for real-time updates"
```

---

## Chunk 5: Cleanup and Polish

### Task 7: Remove dead polling code

After confirming SSE works in the browser:

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: Remove dead polling code**

Delete the commented-out:
- `poll()` function and its `poll()` call
- `pollEvents()` function and its `pollEvents()` call
- `_isFirstPoll` variable and logic
- `POLL_MS` and `EVENTS_POLL_MS` constants
- `setInterval(refreshTopology, 90000)` call
- `fetchEnergy()` function and its `setInterval(fetchEnergy, 30000)`

Keep these (still called from SSE handlers):
- `updateUI()`, `renderEvent()`, `refreshTopology()`, `updateEnergyPanel()`
- `getNodeTraffic()`, `updateConnectionTraffic()` (fallback + topo heightmap)
- `showOffline()`, `liveOk`

Also update the `update-speed-slider` — it currently feeds `updateSpeedMs` into the deleted `setTimeout(poll, updateSpeedMs)`. For now, keep the slider functional but note it's deferred: its value is visible but doesn't control SSE push rate yet. Add a comment:

```javascript
// TODO: repurpose to control SSE traffic push interval via query param
```

Update debug counter: replace `_dbgPollN++` reference (now deleted) with an SSE message counter if the debug panel references it. If the debug panel just shows `poll_ms`, leave it — it's informational only.

- [ ] **Step 2: Build and verify**

Run: `npm run build`

Open http://localhost:8777 and verify everything still works.

- [ ] **Step 3: Commit**

```bash
git add src/app.js
git commit -m "refactor: remove polling code replaced by SSE"
```

### Task 8: Final integration test

- [ ] **Step 1: Full smoke test checklist**

Verify each of these in the browser:
1. Open DevTools Network: single `/sse` EventSource connection, no `/status` or `/events` polling
2. Connection ley lines animate with VLAN colors and tier-based saturation
3. Node icons scale up with traffic intensity
4. Top 5 busiest connections get glow effect
5. Topo heightmap renders and updates with traffic
6. Quest log receives new events in real-time (trigger one via MCP `map_event` tool)
7. Energy panel shows solar/battery data
8. Spellbook sliders (traffic scale, topo controls) still work
9. Kill map_server and restart — SSE auto-reconnects, data resumes, OFFLINE indicator clears
10. Existing endpoints still work: `curl http://localhost:8777/status | python3 -m json.tool | head`
11. Traffic scale slider adjusts connection widths/brightness in real-time
12. Initial page load: recent events appear as restored bubbles (no animation flash) — restore mode ends when first `status` event arrives

- [ ] **Step 2: Commit any remaining fixes**

```bash
git add -A
git commit -m "feat: SSE + server-side traffic pre-computation complete"
```
