'use strict';
import { _connPaths, _nodeDOM } from './topology.js';

let trafficScale = 1.0;
export function setTrafficScale(v) { trafficScale = v; }

// ── Connection traffic animation ──
// Color bases for each connection type (r,g,b)
const connColors = {
  'conn-active': [100,180,255], 'conn-ap': [100,180,255], 'conn-wan': [255,180,50],
  'conn-infra': [96,160,192], 'conn-bridge': [160,100,220], 'conn-vlan': [255,160,60],
  'conn-mesh': [120,220,120],
};
// VLAN-specific base colors (match CSS [data-vlan] custom properties)
const vlanColors = {
  '6': [140,180,255], '8': [255,200,100], '10': [100,220,160],
  '11': [200,140,255], '0': [100,220,220],
};

export function getNodeTraffic(collectd, nodeKey) {
  if (!collectd) return null;
  const key = nodeKey.toLowerCase();
  // Try exact match
  let cd = collectd[nodeKey];
  // Try prefix match (hostname.domain.tld → hostname)
  if (!cd) {
    for (const [k, v] of Object.entries(collectd)) {
      if (k.toLowerCase().split('.')[0] === key) { cd = v; break; }
    }
  }
  // Try fuzzy hostname match
  if (!cd) {
    cd = Object.values(collectd).find(c =>
      c.hostname && c.hostname.toLowerCase().replace(/[-_]/g,'') === key.replace(/[-_]/g,''));
  }
  if (!cd || !cd.interfaces) return null;
  // Pick the busiest single interface (typically eth0 or wan) — not sum of all
  let bestRx = 0, bestTx = 0, bestTotal = 0;
  Object.values(cd.interfaces).forEach(iface => {
    const rx = iface.rx_bps || 0;
    const tx = iface.tx_bps || 0;
    if (rx + tx > bestTotal) {
      bestRx = rx; bestTx = tx; bestTotal = rx + tx;
    }
  });
  return bestTotal > 0 ? { rx: bestRx, tx: bestTx, total: bestTotal } : null;
}

// Base stroke widths by connection class (matches CSS --sw custom properties)
const _connBaseWidthsByClass = {
  'conn-active': 2, 'conn-ap': 1.5, 'conn-wan': 3, 'conn-mesh': 1.5,
  'conn-offline': 1, 'conn-portal': 2, 'conn-vlan': 1.5, 'conn-bridge': 2.5,
  'conn-infra': 2,
};
const _defaultBaseWidth = 1.5;  // CSS fallback: var(--sw, 1.5)

const _connCache = new WeakMap();  // Cache per-line: {connType, sw, speed, dir, tier, stroke, animated}

function _getBaseWidth(path) {
  for (const cls of path.classList) {
    if (cls in _connBaseWidthsByClass) return _connBaseWidthsByClass[cls];
  }
  return _defaultBaseWidth;
}

function _ensureCache(path) {
  let cache = _connCache.get(path);
  if (!cache) {
    const connType = Array.from(path.classList).find(c => connColors[c]) || null;
    cache = { connType, sw: 0, speed: 0, dir: '', tier: '', stroke: '', animated: false, glow: false };
    _connCache.set(path, cache);
  }
  return cache;
}

const TOP_GLOW_COUNT = 5;  // Only apply expensive SVG glow to top N traffic lines
const MAX_ANIMATED_CONNS = 15;  // Limit dash animations — each is a 60fps SVG repaint

export function updateConnectionTraffic(collectd) {
  if (!collectd) return;
  const trafficData = [];  // Collect {line, intensity} for top-N glow selection

  for (const line of _connPaths) {
    if (!line || !line.dataset.to) continue;
    const cache = _ensureCache(line);
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toTraffic = getNodeTraffic(collectd, toNode);
    const fromTraffic = fromNode ? getNodeTraffic(collectd, fromNode) : null;
    const traffic = (toTraffic && fromTraffic)
      ? (toTraffic.total > fromTraffic.total ? toTraffic : fromTraffic)
      : (toTraffic || fromTraffic);
    const baseW = _getBaseWidth(line);
    if (!traffic || traffic.total === 0) {
      // Only update if was previously active
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
      continue;
    }
    // Enable animation only when there's traffic
    if (!cache.animated) { line.classList.add('conn-animated'); cache.animated = true; }
    // Realistic bandwidth scale: 0→1 mapped over 1 KB/s → 10 MB/s (log scale)
    const rawIntensity = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawIntensity * trafficScale);
    // Stroke width: base (frozen original) + up to 8px extra scaled by slider
    const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
    const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
    const dir = traffic.rx > traffic.tx ? 'reverse' : 'normal';
    const tier = intensity > 0.65 ? 'conn-traffic-high' : intensity > 0.35 ? 'conn-traffic-med' : intensity > 0.15 ? 'conn-traffic-low' : '';
    // Only update DOM if values changed
    if (sw !== cache.sw) { line.style.setProperty('--sw', sw); cache.sw = sw; }
    if (speed !== cache.speed) { line.style.setProperty('--speed', speed + 's'); cache.speed = speed; }
    if (dir !== cache.dir) { line.style.setProperty('--dir', dir); cache.dir = dir; }
    // Stroke color
    if (cache.connType) {
      const vlan = line.dataset.vlan;
      const [r,g,b] = (vlan && vlanColors[vlan]) || connColors[cache.connType] || [100,180,255];
      const alpha = +(0.15 + intensity * 0.5).toFixed(2);
      const bright = 1 + intensity * 0.3;
      const stroke = `rgba(${Math.min(255,r*bright)|0},${Math.min(255,g*bright)|0},${Math.min(255,b*bright)|0},${alpha})`;
      if (stroke !== cache.stroke) { line.setAttribute('stroke', stroke); cache.stroke = stroke; }
    }
    // Tier class (opacity only, no filter)
    if (tier !== cache.tier) {
      if (cache.tier) line.classList.remove(cache.tier);
      if (tier) line.classList.add(tier);
      cache.tier = tier;
    }
    // Track for top-N glow selection
    if (intensity > 0.3) trafficData.push({ line, cache, intensity });
  }

  // Apply expensive SVG glow filter only to top N traffic lines
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

  // Scale node icons based on traffic (use cached DOM refs, not querySelectorAll)
  for (const tipKey of Object.keys(_nodeDOM)) {
    const n = _nodeDOM[tipKey];
    if (!n.el) continue;
    const icon = n._icon || (n._icon = n.el.querySelector('.node-icon'));
    if (!icon) continue;
    const traffic = getNodeTraffic(collectd, tipKey);
    if (!traffic || traffic.total === 0) {
      if (n._lastTrafficScale) { icon.style.transform = ''; n._lastTrafficScale = 0; }
      continue;
    }
    const rawI = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawI * trafficScale);
    const s = 1 + intensity * 0.5;
    // Skip DOM write if value unchanged (within 0.01)
    if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
      icon.style.transform = `scale(${s.toFixed(2)})`;
      n._lastTrafficScale = s;
    }
  }
}

/**
 * SSE-optimized traffic update -- receives pre-computed {nodeId: {rx, tx, total, intensity}}.
 * Skips hostname matching + interface scan + log math (done server-side).
 * Still applies local trafficScale, stroke colors, node icon scaling, and top-N glow.
 */
export function updateConnectionTrafficSSE(trafficMap) {
  if (!trafficMap) return;
  const trafficData = [];

  for (const line of _connPaths) {
    if (!line || !line.dataset.to) continue;
    const cache = _ensureCache(line);
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toT = trafficMap[toNode];
    const fromT = fromNode ? trafficMap[fromNode] : null;
    const traffic = (toT && fromT)
      ? (toT.total > fromT.total ? toT : fromT)
      : (toT || fromT);
    const baseW = _getBaseWidth(line);

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
      continue;
    }

    const intensity = Math.min(1, traffic.intensity * trafficScale);
    const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
    const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
    const dir = traffic.dir || (traffic.rx > traffic.tx ? 'reverse' : 'normal');
    const tier = traffic.tier ? ('conn-traffic-' + traffic.tier) : (intensity > 0.65 ? 'conn-traffic-high' : intensity > 0.35 ? 'conn-traffic-med' : intensity > 0.15 ? 'conn-traffic-low' : '');

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

    // Collect for animation budget (only top N get dash animation)
    trafficData.push({ line, cache, intensity, traffic });
  }

  // Use server-provided animate/glow flags if available; fall back to client-side sort
  const hasServerFlags = trafficData.length > 0 && trafficData[0].traffic?.animate !== undefined;
  if (hasServerFlags) {
    for (const { line, cache, traffic } of trafficData) {
      const shouldAnimate = !!traffic.animate;
      if (shouldAnimate !== cache.animated) {
        if (shouldAnimate) line.classList.add('conn-animated'); else line.classList.remove('conn-animated');
        cache.animated = shouldAnimate;
      }
      const shouldGlow = !!traffic.glow;
      if (shouldGlow !== cache.glow) {
        if (shouldGlow) line.classList.add('conn-glow'); else line.classList.remove('conn-glow');
        cache.glow = shouldGlow;
      }
    }
  } else {
    trafficData.sort((a, b) => b.intensity - a.intensity);
    const topAnimated = new Set(trafficData.slice(0, MAX_ANIMATED_CONNS).map(d => d.line));
    for (const { line, cache } of trafficData) {
      const shouldAnimate = topAnimated.has(line);
      if (shouldAnimate && !cache.animated) { line.classList.add('conn-animated'); cache.animated = true; }
      else if (!shouldAnimate && cache.animated) { line.classList.remove('conn-animated'); cache.animated = false; }
    }
    const topLines = new Set(trafficData.filter(d => d.intensity > 0.3).slice(0, TOP_GLOW_COUNT).map(d => d.line));
    trafficData.forEach(({ line, cache }) => {
      const shouldGlow = topLines.has(line);
      if (shouldGlow !== cache.glow) {
        if (shouldGlow) line.classList.add('conn-glow'); else line.classList.remove('conn-glow');
        cache.glow = shouldGlow;
      }
    });
  }

  for (const tipKey of Object.keys(_nodeDOM)) {
    const n = _nodeDOM[tipKey];
    if (!n.el) continue;
    const icon = n._icon || (n._icon = n.el.querySelector('.node-icon'));
    if (!icon) continue;
    const t = trafficMap[tipKey];
    if (!t || t.total === 0) {
      if (n._lastTrafficScale) { icon.style.transform = ''; n._lastTrafficScale = 0; }
      continue;
    }
    const intensity = Math.min(1, t.intensity * trafficScale);
    const s = 1 + intensity * 0.5;
    if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
      icon.style.transform = `scale(${s.toFixed(2)})`;
      n._lastTrafficScale = s;
    }
  }
}

export function trafficToCollectd(trafficMap) {
  const fake = {};
  for (const [nodeId, t] of Object.entries(trafficMap)) {
    fake[nodeId] = { hostname: nodeId, interfaces: { best: { rx_bps: t.rx, tx_bps: t.tx } } };
  }
  return fake;
}
