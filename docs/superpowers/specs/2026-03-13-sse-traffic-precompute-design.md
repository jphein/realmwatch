# SSE Stream + Server-Side Traffic Pre-computation

**Date**: 2026-03-13
**Status**: Implemented
**Goal**: Make the realm map feel instant and responsive without sacrificing visual quality

## Problem

The browser polls three endpoints on timers:
- `/status` every 10s — returns ALL data (~200KB+): collectd for 20 hosts, 2036 HA entities, wifi, tailscale, roles
- `/events` every 5s — realm events
- `refreshTopology` every 90s — full topology (87 nodes, 84 connections)

The browser then does expensive work: hostname matching across collectd hosts, interface scanning, log-scale intensity math, and JSON parsing of massive payloads — most of which haven't changed.

## Solution

Replace polling with a single SSE stream (`/sse`). Server pushes typed events only when data changes. Pre-compute raw traffic intensities server-side so the browser skips hostname matching and log math.

## Architecture

### Threading Requirement

`map_server.py` currently uses `HTTPServer` (single-threaded). SSE holds a connection open indefinitely, which would block all other requests. **Must switch to `ThreadingHTTPServer`** (one-line change: `from http.server import ThreadingHTTPServer`).

SQLite threading: `realm_db.py` uses a connection-per-call pattern (`_conn()` creates or reuses per-thread). Verify `check_same_thread=False` is set, or switch to connection-per-call with no caching. SQLite in WAL mode handles concurrent readers fine.

### SSE Endpoint (`/sse` on map_server.py)

Single `text/event-stream` connection. Server background thread runs change detection and pushes:

| Event type     | Payload | Frequency | Trigger |
|---------------|---------|-----------|---------|
| `traffic`     | `{nodeId: {rx, tx, total, intensity}, ...}` | 5-10s | collectd change (only changed nodes) |
| `realm-event` | Single realm event object | Real-time | realm_db insert |
| `topology`    | Full topology JSON | Rare | Node add/remove/move |
| `status`      | Full status blob (gauges, HA, wifi, tailscale, roles, wled, host) | 10-30s | Any field change |
| `energy`      | Solar/battery/grid numbers | 30s | Value change |

### Wire Format (Datastar-compatible)

```
event: traffic
data: {"raven":{"rx":1234,"tx":5678,"total":6912,"intensity":0.42},"phoenix":{"rx":9000,"tx":3000,"total":12000,"intensity":0.61}}

event: realm-event
data: {"node":"raven","type":"traffic_spike","msg":"Surge detected","ts":1710345600}

event: topology
data: {"nodes":[...],"connections":[...],"regions":[...]}
```

Named event types so Datastar can dispatch on `event:` field natively. JSON data payloads — Datastar can consume these as signals, and plain `EventSource` listeners parse them identically.

### Server-Side Traffic Pre-computation

New function in `map_server.py` (or a small `traffic_precompute.py` module):

```python
def compute_traffic(collectd_data, topology_nodes):
    """Pre-compute per-node raw traffic intensity from collectd.

    Returns {node_id: {rx, tx, total, intensity}} for changed nodes only.
    - Hostname matching: exact then prefix (same logic as app.js getNodeTraffic)
    - Best-interface selection: highest rx+tx across all interfaces
    - Raw log-scale intensity: max(0, min(1, (log10(total+1) - 3) / 4))
    - Delta detection: only return nodes whose intensity bucket changed
    """
```

**Important**: `intensity` is the *raw* log-scaled value (0-1). The browser still applies the user's local `trafficScale` slider on top: `scaledIntensity = Math.min(1, rawIntensity * trafficScale)`. This preserves user-adjustable sensitivity without server round-trips.

The server eliminates: hostname prefix matching, interface scanning, log-scale math.
The browser still does: `trafficScale` multiplication, stroke width/speed/color computation, node icon scaling, top-N glow selection.

### Status Event: Full Data Flow

The `status` event carries the same structure as the current `/status` response. This includes:
- `forge`, `mana`, `essence`, `astral`, `realm_scale` (gauges)
- `tailscale` (peer details)
- `ha` (Home Assistant entity states)
- `wled` (WLED states)
- `wifi` (signal data)
- `host` (host config)
- `roles`, `groups` (node roles)
- `collectd` (raw summaries — still needed for tooltip detail, topo heightmap)

The existing `updateUI(d)` function receives this unchanged. The win here is **push instead of poll** — data arrives when it changes, not on a timer. Change detection hashes the full blob and only pushes when something differs.

For a future optimization pass, this could be split into fast-changing channels (gauges, collectd) and slow-changing channels (HA, roles, wifi), but that's out of scope for v1.

### Surviving Client Features

All existing traffic visualization features survive the refactor:
- **Connection stroke color**: VLAN-aware colors + tier alpha (uses raw intensity * trafficScale)
- **Connection stroke width**: base + intensity * 8 * trafficScale
- **Connection animation speed/direction**: derived from intensity + rx vs tx
- **Traffic tier classes**: conn-traffic-high/med/low based on scaled intensity
- **Node icon scaling**: scale(1 + intensity * 0.5) with brightness filter
- **Top-N glow**: SVG glow filter on top 5 highest-traffic connections
- **Topographic heightmap**: `renderTopoLayer` uses `traffic.total` (raw bytes) per node to compute gaussian peaks — this data is included in the `traffic` event payload

### Change Detection

Server keeps previous state hashes per event type:
- **Traffic**: hash of intensity buckets (quantized to 0.05 steps — traffic must change ~5% to trigger push)
- **Topology**: hash of node/connection count + modification timestamp from realm_db
- **Status**: hash of full status blob (JSON string hash)
- **Energy**: hash of rounded values (solar to 0.1kW, battery to 1%)
- **Events**: watched via realm_db polling (already fast, just relay)

### Client Changes (`src/app.js`)

Replace:
```javascript
// REMOVE these:
setTimeout(poll, updateSpeedMs);        // /status polling
setTimeout(pollEvents, EVENTS_POLL_MS); // /events polling
setInterval(refreshTopology, 90000);    // topology polling
```

With:
```javascript
const sse = new EventSource('/sse');

sse.addEventListener('traffic', e => {
  const traffic = JSON.parse(e.data);
  updateConnectionTrafficSSE(traffic);  // applies trafficScale locally, updates connections + nodes + topo
});

sse.addEventListener('realm-event', e => {
  renderEvent(JSON.parse(e.data));
});

sse.addEventListener('topology', e => {
  // Full topology refresh (rare)
});

sse.addEventListener('status', e => {
  updateUI(JSON.parse(e.data));  // same function, same blob shape
});

sse.addEventListener('energy', e => {
  updateEnergy(JSON.parse(e.data));
});
```

`updateConnectionTrafficSSE(traffic)` replaces the inner loop of `updateConnectionTraffic(collectd)`:
- Receives `{nodeId: {rx, tx, total, intensity}}` — skips hostname matching + interface scan + log math
- Still applies `trafficScale` locally: `scaledIntensity = Math.min(1, raw.intensity * trafficScale)`
- Still computes stroke width, speed, direction, RGBA color, tier class (all depend on trafficScale)
- Still scales node icons and selects top-N glow connections
- Passes `traffic` data to `renderTopoLayer` for heightmap updates

### Backward Compatibility

- `/status`, `/events`, `/topology`, `/energy` endpoints remain for MCP tools, CLI agents, and debugging
- `/sse` is additive — the frontend switches to it, everything else keeps working
- `update-speed-slider` repurposed: controls traffic push interval (tells server via query param or initial SSE handshake)

### Datastar Forward Compatibility

No Datastar dependency now. Design choices that keep the door open:
- Named SSE event types (Datastar dispatches on these)
- JSON data payloads (Datastar binds as signals)
- DOM elements already use `data-*` attributes (`data-tip`, `data-vlan`, `data-layout`)
- Future: server can push HTML fragments alongside JSON for panel updates (Datastar `merge` mode)
- When chat/speech panels arrive via gateway, Datastar becomes natural reactive layer

## What Stays Untouched

- All CSS/SVG visuals (sparkles, vignette, compass, VLAN colors)
- Layout web worker
- Spellbook controls and settings persistence
- `topology.js` rendering
- `engine.py`, `server.py`, `realm_db.py`

## Files Changed

| File | Change |
|------|--------|
| `map_server.py` | Switch to `ThreadingHTTPServer`, +`/sse` endpoint, +background change-detection thread, +traffic pre-computation |
| `src/app.js` | Replace 3 polling loops with EventSource, add `updateConnectionTrafficSSE()`, wire topo heightmap to SSE traffic data |
| `src/config.js` | Add SSE config constants (reconnect backoff, traffic push interval) |

## Performance Expected

| Metric | Before | After |
|--------|--------|-------|
| Network per 10s | ~200KB (full /status) | ~5-20KB (changed deltas, status blob only when changed) |
| Fetches per minute | ~9 (status+events+topo) | 0 (server pushes) |
| Browser JS per update | hostname match + interface scan + log math for 20 hosts | apply pre-computed raw intensity * trafficScale to DOM |
| Update latency | 5-10s (next poll) | <1s (server push) |
| Reconnect | manual retry | EventSource auto-reconnect |
