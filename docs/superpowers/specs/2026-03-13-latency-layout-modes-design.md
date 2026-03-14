# Latency-Aware Layout Modes — Design Spec

**Status**: Implemented

## Overview

Three new Cartographer layout modes that use live latency measurements for wired node spacing and golden ratio phyllotaxis for WiFi node arrangement. A background latency prober on the map server pings all wired IPs from katana every 30s, building a latency map that the layout worker consumes.

## Latency Probing System

### Architecture

New module `latency_prober.py` — a background thread that:
1. Reads wired node IPs from topology.json (nodes with `ip` field)
2. Filters out WiFi clients (cross-reference with `wifi` status data)
3. Pings each wired IP using `fping` (single command, all IPs at once — much faster than sequential `ping`)
4. Stores results in a dict: `{node_id: rtt_ms}` (null if unreachable)
5. Runs every 30s in a daemon thread
6. Exposes `get_latency_map()` → `{node_id: rtt_ms}` and `estimate_latency(a, b)` → ms

### Latency Estimation (node-to-node)

Since we only probe from katana, we estimate pairwise latency:
- **Both wired, same subnet**: `max(rtt_a, rtt_b)` — they're likely on the same switch, so the slower one dominates
- **Both wired, different subnet**: `rtt_a + rtt_b` — traffic traverses katana's segment
- **One is WiFi**: fixed estimate based on WiFi SNR: `5 + (60 - snr) * 0.5` ms (clamped 5-40ms)
- **Both WiFi on same AP**: 10ms fixed (local bridge)
- **Tailscale/cloud nodes**: use measured RTT directly (already includes WAN latency)

### Subnet detection

Extract subnet from IP: `10.0.6.x` → VLAN 6 (Admin), `10.0.8.x` → VLAN 8 (Family), `10.0.10.x` → VLAN 10 (IoT), `10.0.11.x` → VLAN 11 (Guest). Same third octet = same subnet.

### Data flow

```
latency_prober.py (30s thread)
  → fping -c1 -t500 <all wired IPs>
  → parse RTTs → {node_id: rtt_ms}
  → stored in module-level dict (thread-safe via replace-reference)

map_server.py
  → /latency endpoint returns current latency map
  → SSE broker pushes latency event every 30s (alongside traffic)

layout-worker.js
  → receives latencyMap in postMessage
  → uses rtt to compute edge rest lengths and radial positions
```

### WiFi node identification

A node is WiFi if it appears in the `wifi` status data (keyed by hostname, has `ap` field). Everything else with an IP is wired. The prober skips WiFi-identified nodes.

## Layout Mode 1: Latency Cartograph

**Concept**: Radial map centered on katana. Wired node distance from center = f(rtt). WiFi nodes spiral around their AP.

### Algorithm

1. Place katana at world center
2. For each wired node: radial distance = `baseRadius * log2(rtt_ms + 1)` (log scale so 0.1ms and 100ms don't differ by 1000x). Angle determined by BFS order from katana in the topology graph.
3. Group WiFi nodes by their AP (from `wifi.ap` field)
4. For each AP's WiFi group: arrange in golden angle phyllotaxis (Vogel model) starting from the AP's position:
   - `angle = i * 2.39996` (golden angle in radians)
   - `r = sqrt(i) * spacing` (square-root spiral for equal area)
   - `spacing` = compact, ~40% of normal `edgeLen`
5. Force simulation with edge rest length = `estimate_latency(a, b) * lengthScale`

### Visual character
Looks like a radar/sonar display — katana at center, fast local infra tight around it, cloud nodes at the edges, WiFi clients clustering in golden spirals around their tower.

## Layout Mode 2: Golden Resonance

**Concept**: Vogel sunflower arrangement where radial order is latency-ranked. Mathematical beauty meets network topology.

### Algorithm

1. Rank all wired nodes by RTT (lowest first)
2. Place wired nodes using Vogel's model:
   - `angle = i * 2.39996` (golden angle)
   - `r = sqrt(i) * spacing`
   - But `i` is the latency rank, not arbitrary — so fastest nodes cluster at the golden center
3. WiFi nodes: for each AP, insert its WiFi children immediately after the AP in the spiral sequence, using tighter spacing (golden ratio subdivisions)
4. Light force simulation for overlap removal only (no spring forces — preserve the mathematical structure)

### Visual character
A perfect golden spiral where the mathematical elegance encodes real network distance. The center blooms with the fastest nodes, the edges hold the slowest/furthest. WiFi clusters appear as local "petals" around their tower.

## Layout Mode 3: Latency Forge

**Concept**: Force-directed where edge rest lengths come from measured/estimated latency. The network "relaxes" into its true latency shape.

### Algorithm

1. Initialize positions randomly (or from current positions for smoother transition)
2. For each edge in the topology:
   - Wired↔Wired: `restLength = edgeLen * log2(estimate_latency(a, b) + 1)`
   - Wired↔WiFi or WiFi↔AP: `restLength = edgeLen * 0.4` (compact golden ratio distance)
   - WiFi↔WiFi (same AP): `restLength = edgeLen * 0.3`
3. Run force simulation (100 iterations, higher than the 50 used by other modes):
   - Spring force: pulls connected nodes toward rest length
   - Repulsion: prevents overlap
   - WiFi gravity: WiFi nodes have extra attraction toward their AP (prevents drift)
4. WiFi sub-clusters: after force simulation converges, re-arrange each AP's WiFi children into golden phyllotaxis around the AP's settled position (overrides their force-sim positions for aesthetic consistency)

### Visual character
Organic, network-shaped. Wired backbone finds its natural latency-based shape — tight clusters where latency is low, stretched ley-lines where it's high. WiFi nodes form neat golden rosettes around each tower.

## Shared: WiFi Golden Ratio Arrangement

All three modes share the same WiFi sub-arrangement:

```
function goldenArrange(apPos, wifiNodes, spacing) {
  const PHI = 2.39996; // golden angle in radians
  for (let i = 0; i < wifiNodes.length; i++) {
    const angle = i * PHI;
    const r = Math.sqrt(i + 1) * spacing;
    pos[wifiNodes[i]] = {
      x: apPos.x + Math.cos(angle) * r,
      y: apPos.y + Math.sin(angle) * r * 0.86,
    };
  }
}
```

## Data Contract: Worker Input

The `autoArrangeLayout()` function adds to its existing `postMessage`:

```js
_layoutWorker.postMessage({
  // ... existing fields ...
  latencyMap: { nodeId: rtt_ms, ... },        // from /latency or SSE
  wifiMap: { clientId: { ap: 'onhub-bed', snr: 45 }, ... },  // from status.wifi
});
```

The worker detects latency modes and uses these fields. Non-latency modes ignore them.

## UI: Three New Buttons

Add to `realm-map.html` in `.carto-modes`:

| Mode | Icon | Label | data-layout |
|------|------|-------|-------------|
| Latency Cartograph | 📡 | Cartograph | `latency-cartograph` |
| Golden Resonance | 🌻 | Resonance | `golden-resonance` |
| Latency Forge | ⚒️ | Forge | `latency-forge` |

## SSE Integration

The SSE broker gets a new event type `latency` pushed every 30s:
```
event: latency
data: {"katana": 0, "gatekeeper": 0.1, "onhub-bed": 0.4, ...}
```

The frontend caches this in `_latencyMap` and passes it to the layout worker on demand.

## Failure Handling

- If a wired node is unreachable: exclude from latency map (worker uses default edgeLen)
- If fping is not installed: fall back to sequential subprocess `ping -c1 -W1`
- If no latency data available yet: layout modes work but use uniform spacing (graceful degradation)
- WiFi nodes with no AP data: treated as wired (use latency if available, else default)
