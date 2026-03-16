'use strict';
import { WORLD_W, WORLD_H, _perfTier, _mapTilt } from './config.js';
import { _topology } from './topology.js';

// ── Dynamic Biome Terrain (generated from topology VLANs/zones) ──
let _biomeLandScale = 1.0, _biomeGlow = 1.0, _biomeRoads = 0.5, _biomePeaks = 0.5, _biomeGrid = 0.03;

const VLAN_BIOMES = {
  6:  { name:'Citadel',   land:'#141a28', glow:[240,216,144], accent:'#1a1810' },
  8:  { name:'Family',    land:'#1a1814', glow:[192,160,96],  accent:'#1a1510' },
  10: { name:'Enchanted', land:'#101a18', glow:[96,192,96],   accent:'#0a1a10' },
  11: { name:'Guest',     land:'#101620', glow:[100,160,220], accent:'#0c1420' },
  0:  { name:'Astral',    land:'#0e1028', glow:[144,96,192],  accent:'#0c0c20' },
};

function _nodeCenter(n) {
  const iw = n.iconStyle?.width ? parseInt(n.iconStyle.width) : 64;
  const ih = n.iconStyle?.height ? parseInt(n.iconStyle.height) : 64;
  return { x: n.x + iw / 2, y: n.y + ih / 2 };
}

export function generateTerrain() {
  if (!_topology) return;
  const el = document.getElementById('terrain-dynamic');
  if (!el) return;
  const W = WORLD_W, H = WORLD_H;

  // Assign nodes to VLANs from connection data (majority vote)
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const nodeVlan = {};
  for (const [id, cts] of Object.entries(vlanCounts)) {
    let best = 6, max = 0;
    for (const [v, c] of Object.entries(cts)) { if (c > max) { max = c; best = +v; } }
    nodeVlan[id] = best;
  }
  _topology.nodes.forEach(n => {
    if (!nodeVlan[n.id]) nodeVlan[n.id] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
  });

  // Group nodes by VLAN
  const groups = {};
  _topology.nodes.forEach(n => {
    const v = nodeVlan[n.id];
    if (!groups[v]) groups[v] = [];
    groups[v].push(n);
  });

  // Compute biome zones (centroid + bounding ellipse)
  const biomes = [];
  for (const [vlan, nodes] of Object.entries(groups)) {
    const theme = VLAN_BIOMES[vlan] || VLAN_BIOMES[6];
    let sx = 0, sy = 0;
    const pts = nodes.map(n => { const c = _nodeCenter(n); sx += c.x; sy += c.y; return c; });
    const cx = sx / pts.length, cy = sy / pts.length;
    let maxDx = 0, maxDy = 0;
    pts.forEach(p => { maxDx = Math.max(maxDx, Math.abs(p.x - cx)); maxDy = Math.max(maxDy, Math.abs(p.y - cy)); });
    const pad = 180 * _biomeLandScale;
    const rx = (maxDx * 1.2 + pad) * _biomeLandScale;
    const ry = (maxDy * 1.2 + pad) * _biomeLandScale;
    biomes.push({ vlan: +vlan, theme, cx, cy, rx: Math.max(rx, 250), ry: Math.max(ry, 200), nodes, pts });
  }
  biomes.sort((a, b) => (b.rx * b.ry) - (a.rx * a.ry)); // largest first

  // Build SVG content
  const g = _biomeGlow;
  let s = `<rect width="${W}" height="${H}" fill="#0a0a12"/>`;

  // ── Biome landmasses ──
  for (const b of biomes) {
    const { theme, cx, cy, rx, ry } = b;
    const [gr, gg, gb] = theme.glow;
    // Outer haze
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.4}" ry="${ry * 1.4}" fill="${theme.land}" filter="url(#terrain-blur-lg)" opacity="0.4"/>`;
    // Inner landmass
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${theme.accent}" opacity="0.6"/>`;
    // Radial glow
    if (g > 0) {
      s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="none" opacity="1">`;
      // Use inline radialGradient via style
      s += `</circle>`;
      s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="rgba(${gr},${gg},${gb},${0.12 * g})" filter="url(#terrain-blur-lg)"/>`;
    }
  }

  // ── Per-node glows (magical auras) ──
  if (g > 0) {
    for (const n of _topology.nodes) {
      const c = _nodeCenter(n);
      const v = nodeVlan[n.id];
      const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
      const [gr, gg, gb] = theme.glow;
      const r = n.type === 'core' ? 120 : n.type === 'tower' ? 70 : n.type === 'infra' ? 55 : n.type === 'bridge' ? 60 : 40;
      const op = n.type === 'core' ? 0.15 * g : 0.08 * g;
      s += `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="rgba(${gr},${gg},${gb},${op})" filter="url(#terrain-blur)"/>`;
    }
  }

  // ── Mountain peaks near core/infra nodes ──
  if (_biomePeaks > 0) {
    for (const n of _topology.nodes) {
      if (n.type !== 'core' && n.type !== 'infra') continue;
      const c = _nodeCenter(n);
      const sz = n.type === 'core' ? 60 : 35;
      const pk = _biomePeaks;
      // Generate deterministic mountain from node ID hash
      let hash = 0;
      for (let i = 0; i < n.id.length; i++) hash = ((hash << 5) - hash + n.id.charCodeAt(i)) | 0;
      const pts = [];
      const spikes = n.type === 'core' ? 6 : 4;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2 - Math.PI / 2;
        const r = sz * pk * (0.7 + ((hash >> (i * 3)) & 7) / 20);
        pts.push(`${(c.x + Math.cos(a) * r) | 0},${(c.y + Math.sin(a) * r) | 0}`);
      }
      s += `<polygon points="${pts.join(' ')}" fill="#1a2535" opacity="${0.4 * pk}"/>`;
      s += `<polygon points="${pts.join(' ')}" fill="none" stroke="rgba(160,140,100,${0.08 * pk})" stroke-width="1"/>`;
    }
  }

  // ── Roads along connections ──
  if (_biomeRoads > 0) {
    const nodeMap = {};
    _topology.nodes.forEach(n => { nodeMap[n.id] = n; });
    for (const c of _topology.connections) {
      const fn = nodeMap[c.from], tn = nodeMap[c.to];
      if (!fn || !tn) continue;
      const fp = _nodeCenter(fn), tp = _nodeCenter(tn);
      const mx = (fp.x + tp.x) / 2, my = (fp.y + tp.y) / 2;
      const v = c.vlan || nodeVlan[c.from] || 6;
      const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
      const [gr, gg, gb] = theme.glow;
      const op = (c.type === 'mesh' || c.type === 'portal') ? 0.03 : 0.06;
      s += `<path d="M${fp.x|0},${fp.y|0} Q${mx|0},${my|0} ${tp.x|0},${tp.y|0}" fill="none" stroke="rgba(${gr},${gg},${gb},${op * _biomeRoads})" stroke-width="${c.type === 'active' ? 3 : 2}"/>`;
    }
  }

  // ── Compass rose ──
  s += `<g transform="translate(180,${H - 200})" opacity="0.3">`;
  s += `<line x1="0" y1="-40" x2="0" y2="40" stroke="#a89870" stroke-width="1"/>`;
  s += `<line x1="-40" y1="0" x2="40" y2="0" stroke="#a89870" stroke-width="1"/>`;
  s += `<polygon points="0,-45 -6,-10 6,-10" fill="#f0d890"/>`;
  s += `<text x="0" y="-52" text-anchor="middle" fill="#f0d890" font-family="Cinzel,serif" font-size="12">N</text>`;
  s += `<text x="0" y="62" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">S</text>`;
  s += `<text x="52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">E</text>`;
  s += `<text x="-52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">W</text>`;
  s += `</g>`;

  // ── Grid lines ──
  if (_biomeGrid > 0) {
    s += `<g opacity="${_biomeGrid}" stroke="#a89870" stroke-width="0.5">`;
    for (let y = 400; y < H; y += 400) s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    for (let x = 600; x < W; x += 600) s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
    s += `</g>`;
  }

  el.innerHTML = s;
}

// ── Dynamic Region Labels (computed from VLAN node clusters) ──
const VLAN_REGION_LABELS = {
  6:  { label: 'The Citadel',           color: 'rgba(240,216,144,0.22)', spacing: 6 },
  8:  { label: 'The Family Hearth',     color: 'rgba(192,160,96,0.22)',  spacing: 5 },
  10: { label: 'The Enchanted Quarters', color: 'rgba(96,192,96,0.22)',  spacing: 5 },
  11: { label: 'The Guest Marches',     color: 'rgba(100,160,220,0.22)', spacing: 4 },
  0:  { label: 'The Astral Sea',        color: 'rgba(144,96,192,0.22)',  spacing: 5 },
};

// Sub-region labels for VLAN 6 (the largest group), split by node type
const CITADEL_SUBLABELS = {
  core:   { label: 'The Inner Keep',      fontSize: 14, color: 'rgba(240,216,144,0.18)', spacing: 4 },
  tower:  { label: 'The Guardian Towers',  fontSize: 13, color: 'rgba(192,144,96,0.18)',  spacing: 3 },
  bridge: { label: 'The Signal Bridges',   fontSize: 13, color: 'rgba(144,96,192,0.18)',  spacing: 3 },
  infra:  { label: 'The Deep Forges',      fontSize: 13, color: 'rgba(160,140,100,0.18)', spacing: 3 },
};

export function updateRegionLabels() {
  if (!_topology) return;
  const rc = document.getElementById('region-labels');
  if (!rc) return;
  rc.innerHTML = '';

  // Reuse VLAN assignment logic from generateTerrain
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const nodeVlan = {};
  for (const [id, cts] of Object.entries(vlanCounts)) {
    let best = 6, max = 0;
    for (const [v, c] of Object.entries(cts)) { if (c > max) { max = c; best = +v; } }
    nodeVlan[id] = best;
  }
  _topology.nodes.forEach(n => {
    if (!nodeVlan[n.id]) nodeVlan[n.id] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
  });

  // Group by VLAN
  const groups = {};
  _topology.nodes.forEach(n => {
    const v = nodeVlan[n.id];
    if (!groups[v]) groups[v] = [];
    groups[v].push(n);
  });

  // Place main VLAN region label above each cluster centroid
  for (const [vlan, nodes] of Object.entries(groups)) {
    const cfg = VLAN_REGION_LABELS[vlan] || VLAN_REGION_LABELS[6];
    const { cx, cy, minY } = _clusterBounds(nodes);
    _addRegionLabel(rc, cfg.label, cx, minY - 55, {
      fontSize: 18, color: cfg.color, spacing: cfg.spacing, rotate: 0
    });

    // Sub-labels for VLAN 6 (split by node type)
    if (+vlan === 6) {
      const byType = {};
      nodes.forEach(n => {
        const t = n.type || 'device';
        if (!byType[t]) byType[t] = [];
        byType[t].push(n);
      });
      for (const [type, typeNodes] of Object.entries(byType)) {
        const sub = CITADEL_SUBLABELS[type];
        if (!sub || typeNodes.length < 2) continue;
        const tb = _clusterBounds(typeNodes);
        _addRegionLabel(rc, sub.label, tb.cx, tb.minY - 35, {
          fontSize: sub.fontSize, color: sub.color, spacing: sub.spacing, rotate: 0
        });
      }
    }
  }

  // Reapply globe Z if tilted
  if (_mapTilt > 0) {
    const peakH = _mapTilt * 5;
    const counterRot = `x ${-_mapTilt}deg`;
    rc.style.translate = `0px 0px ${peakH * 0.7}px`;
    rc.style.rotate = counterRot;
  }
}

function _clusterBounds(nodes) {
  let sx = 0, sy = 0, minY = Infinity;
  const pts = nodes.map(n => {
    const c = _nodeCenter(n);
    sx += c.x; sy += c.y;
    if (c.y < minY) minY = c.y;
    return c;
  });
  return { cx: sx / pts.length, cy: sy / pts.length, minY, pts };
}

function _addRegionLabel(container, text, x, y, opts) {
  const el = document.createElement('div');
  el.className = 'region-label';
  let s = `left:${x}px;top:${y}px;transform:translateX(-50%)`;
  if (opts.rotate) s += ` rotate(${opts.rotate}deg)`;
  s += ';';
  if (opts.fontSize) s += `font-size:${opts.fontSize}px;`;
  if (opts.color) s += `color:${opts.color};`;
  if (opts.spacing) s += `letter-spacing:${opts.spacing}px;`;
  el.setAttribute('style', s);
  el.textContent = text;
  container.appendChild(el);
}

// ── Topographic Heightmap Layer (Web Worker) ──
// Heavy computation (Gaussian + marching squares) runs off main thread.
// Main thread only does DOM insertion of the resulting SVG bands.
const _topoSvg = document.getElementById('topo-svg');
let _topoEnabled = true;
let _topoOpacity = 0.6;
let _topoSpread = 120;   // gaussian sigma in world coords
let _topoContours = 12;
let _topoRiverWidth = 0.4;  // base river width as fraction of sigma
let _topoRiverDepth = 0.6;  // multiplicative carve depth (0=none, 1=to zero)
let _lastTopoCollectd = null;
let _topoRafId = 0;
let _topoHash = '';
let _topoWorkerBusy = false;
let _topoLastDispatch = 0;
const _TOPO_MIN_INTERVAL = 30000; // minimum 30s between topo recomputes

const _TOPO_DEFS = `<defs>
<filter id="topo-glow" x="-15%" y="-15%" width="130%" height="130%">
  <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
  <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
<filter id="topo-shimmer" x="-20%" y="-20%" width="140%" height="140%">
  <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="soft"/>
  <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="wide"/>
  <feColorMatrix in="wide" type="matrix" result="golden"
    values="1.2 0.2 0 0 0.08  0.8 0.6 0 0 0.04  0 0.1 0.3 0 0  0 0 0 0.5 0"/>
  <feMerge><feMergeNode in="golden"/><feMergeNode in="soft"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>`;

// Node map cache (used by ley-line mote sparkles and topo invalidation)
let _topoNodeMap = null;
function _getTopoNodeMap() {
  if (_topoNodeMap) return _topoNodeMap;
  _topoNodeMap = new Map();
  for (const n of _topology.nodes) _topoNodeMap.set(n.id, n);
  return _topoNodeMap;
}

// Grid constants (shared with worker)
const _TOPO_PAD = 50;
const _TOPO_SX = 10, _TOPO_SY = 10;
const _TOPO_W = Math.ceil(WORLD_W / _TOPO_SX) + _TOPO_PAD * 2;
const _TOPO_H = Math.ceil(WORLD_H / _TOPO_SY) + _TOPO_PAD * 2;

// _applyTopoZ callback — set by initTopoControls
let _applyTopoZ = () => {};

// Worker setup
const _topoWorker = new Worker('topo-worker.js');
_topoWorker.onmessage = function(e) {
  _topoWorkerBusy = false;
  const { hash, bands } = e.data;
  if (!bands || bands.length === 0) return;
  if (hash === _topoHash) return;
  _topoHash = hash;

  // DOM update — build SVG elements from worker-computed band data
  const VB = '-500 -500 5800 4300';
  const fragment = document.createDocumentFragment();
  let first = true;
  for (const b of bands) {
    let inner = '';
    if (first) { inner += _TOPO_DEFS; first = false; }
    if (b.halo && b.fillOp > 0) {
      inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="25" opacity="${b.fillOp}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const filterAttr = b.useFilter ? ' class="topo-idx"' : '';
    inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="${b.sw}" opacity="${b.op}" stroke-linecap="round"${filterAttr}/>`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', VB);
    svg.setAttribute('class', 'topo-band');
    svg.dataset.elev = b.elev.toFixed(3);
    svg.innerHTML = inner;
    fragment.appendChild(svg);
  }
  _topoSvg.innerHTML = '';
  _topoSvg.appendChild(fragment);
  if (_mapTilt > 0) _applyTopoZ();
};

export function renderTopoLayer(collectd) {
  if (!_topoSvg || !_topoEnabled || !_topology.nodes) return;
  if (_topoWorkerBusy) return; // don't queue while worker is computing

  // Throttle: minimum 30s between dispatches (slider overrides bypass this)
  const now = Date.now();
  if (now - _topoLastDispatch < _TOPO_MIN_INTERVAL) return;

  _topoWorkerBusy = true;
  _topoLastDispatch = now;

  // Send serializable data to worker (no DOM, no Maps)
  const nodes = _topology.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y, type: n.type,
    iconStyle: n.iconStyle ? { width: n.iconStyle.width, height: n.iconStyle.height } : null
  }));
  const connections = (_topology.connections || []).map(c => ({ from: c.from, to: c.to }));

  _topoWorker.postMessage({
    nodes, connections,
    collectd: collectd || {},
    settings: { spread: _topoSpread, contours: _topoContours, riverWidth: _topoRiverWidth, riverDepth: _topoRiverDepth },
    grid: { W: _TOPO_W, H: _TOPO_H, sx: _TOPO_SX, sy: _TOPO_SY, pad: _TOPO_PAD },
    perfTier: _perfTier,
  });
}

// Force immediate render (bypass throttle — used by sliders)
function _topoForceRender() {
  _topoLastDispatch = 0;
  _topoHash = '';
  renderTopoLayer(_lastTopoCollectd);
}

// Topo controls — call initTopoControls({ saveSettings, scheduleSave, applyTopoZ }) from app.js
export function initTopoControls({ saveSettings, scheduleSave, applyTopoZ }) {
  const toggle = document.getElementById('topo-toggle-cb');
  const opSlider = document.getElementById('topo-opacity-slider');
  const opVal = document.getElementById('topo-opacity-val');
  const spSlider = document.getElementById('topo-spread-slider');
  const spVal = document.getElementById('topo-spread-val');
  const cnSlider = document.getElementById('topo-contour-slider');
  const cnVal = document.getElementById('topo-contour-val');
  if (!toggle || !_topoSvg) return;

  // Wire _applyTopoZ callback into the worker message handler
  _applyTopoZ = applyTopoZ;

  _topoSvg.style.setProperty('--topo-opacity', _topoOpacity);

  function scheduleRender() {
    cancelAnimationFrame(_topoRafId);
    _topoRafId = requestAnimationFrame(() => _topoForceRender());
  }

  toggle.addEventListener('change', () => {
    _topoEnabled = toggle.checked;
    _topoSvg.classList.toggle('active', _topoEnabled);
    if (_topoEnabled) scheduleRender();
    saveSettings();
  });
  opSlider.addEventListener('input', () => {
    _topoOpacity = parseFloat(opSlider.value);
    opVal.textContent = _topoOpacity.toFixed(2);
    _topoSvg.style.setProperty('--topo-opacity', _topoOpacity);
    scheduleSave();
  });
  spSlider.addEventListener('input', () => {
    _topoSpread = parseInt(spSlider.value);
    spVal.textContent = _topoSpread;
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });
  cnSlider.addEventListener('input', () => {
    _topoContours = parseInt(cnSlider.value);
    cnVal.textContent = _topoContours;
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });

  const rwSlider = document.getElementById('topo-rw-slider');
  const rwVal = document.getElementById('topo-rw-val');
  const rdSlider = document.getElementById('topo-rd-slider');
  const rdVal = document.getElementById('topo-rd-val');
  if (rwSlider) rwSlider.addEventListener('input', () => {
    _topoRiverWidth = parseFloat(rwSlider.value);
    rwVal.textContent = _topoRiverWidth.toFixed(2);
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });
  if (rdSlider) rdSlider.addEventListener('input', () => {
    _topoRiverDepth = parseFloat(rdSlider.value);
    rdVal.textContent = _topoRiverDepth.toFixed(2);
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });

  if (_topoEnabled && _topology.nodes) renderTopoLayer(null);
}

// ── Biome sliders — call initBiomeSliders({ scheduleSave }) from app.js ──
export function initBiomeSliders({ scheduleSave }) {
  const sliders = [
    ['biome-land', v => { _biomeLandScale = v; generateTerrain(); }],
    ['biome-glow', v => { _biomeGlow = v; generateTerrain(); }],
    ['biome-roads', v => { _biomeRoads = v; generateTerrain(); }],
    ['biome-peaks', v => { _biomePeaks = v; generateTerrain(); }],
    ['biome-grid', v => { _biomeGrid = v; generateTerrain(); }],
  ];
  for (const [id, setter] of sliders) {
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = v.toFixed(2);
      scheduleSave();
    });
  }
}

// ── Exports for app.js cross-module access ──
export function setLastTopoCollectd(v) { _lastTopoCollectd = v; }
export function invalidateTopoNodeMap() { _topoNodeMap = null; }
export function forceTopoRender()       { _topoForceRender(); }
export function getTopoNodeMap()        { return _getTopoNodeMap(); }
export function resetTopoHash()         { _topoHash = ''; }
