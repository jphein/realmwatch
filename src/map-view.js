'use strict';
import { WORLD_W, WORLD_H, _perfTier, _PERF, _mapTilt } from './config.js';
import { _topology, _nodeMap, _connPaths, updateLinePositions, isClusterExpandable, toggleClusterExpand, getNodeDOM } from './topology.js';
import { renderTopoLayer, setLastTopoCollectd, invalidateTopoNodeMap, forceTopoRender,
         updateRegionLabels, generateTerrain } from './terrain.js';
import { spawnMote, clearMoteCanvas, updateSparkleRect, ensureMoteLoop } from './effects.js';
import { updateUI } from './node-status.js';
import { getBubbleScale, getBubbleFixedSize } from './node-status.js';
import { updateEnergyPanel, updateLatencyPanel } from './panels.js';
import { updateConnectionTrafficSSE, trafficToCollectd } from './traffic.js';
import { updateBubblePositions } from './quest-log.js';
import { saveSettings, scheduleSave, setPanelMode, isRestoring } from './layout.js';
import { saveFormation } from './panel-manager.js';
import { getFpsEl, startFpsLoop } from './effects.js';

// ── Pan & zoom ──
const canvas = document.getElementById('map-canvas');
const world = document.getElementById('map-world');
// Cache canvas rect — getBoundingClientRect on every wheel event forces synchronous layout
let _canvasRect = canvas.getBoundingClientRect();
export let scale = 1, panX = 0, panY = 0;
let dragging = false, lastX, lastY;

let _lastGlobeTilt = 0;

// ── Cached NodeLists for globe-Z transforms (avoids querySelectorAll per call) ──
let _cachedTopoBands = null;   // NodeList of .topo-band elements
let _cachedBubbles = null;     // NodeList of .speech-bubble elements
let _topoBandParent = null;    // topo-svg element when bands were cached

/** Invalidate globe-Z caches (call after topology refresh or terrain re-render). */
export function invalidateGlobeZCache() {
  _cachedTopoBands = null;
  _cachedBubbles = null;
  _topoBandParent = null;
}

function _getTopoBands() {
  const topoEl = document.getElementById('topo-svg');
  if (!topoEl) return [];
  if (_cachedTopoBands && _topoBandParent === topoEl) return _cachedTopoBands;
  _topoBandParent = topoEl;
  _cachedTopoBands = topoEl.querySelectorAll('.topo-band');
  return _cachedTopoBands;
}

function _getBubbles() {
  if (_cachedBubbles) return _cachedBubbles;
  _cachedBubbles = document.querySelectorAll('.speech-bubble');
  return _cachedBubbles;
}

// GPU zoom boost — toggled from spellbook perf controls
let _gpuZoomEnabled = true;
export function setGpuZoomEnabled(v) { _gpuZoomEnabled = v; }

// Bubble zoom compensation — uses local `scale` + imported bubble state from node-status.js
function _updateBubbleTotalScale() {
  const compensate = getBubbleFixedSize() ? (1 / Math.max(scale, 0.3)) : 1;
  document.documentElement.style.setProperty('--bubble-total-scale', getBubbleScale() * compensate);
}
export function updateBubbleTotalScale() { _updateBubbleTotalScale(); }

// ── Ghost ley-lines — half-res canvas shown during zoom/pan ──
// Pre-renders SVG connection curves onto a canvas bitmap using Path2D.
// Single raster layer = zero per-element compositing cost during zoom.
const _GHOST_VLAN_COLORS = {
  0:[100,220,220], 3:[180,120,100], 4:[120,110,100], 5:[160,100,180],
  6:[140,180,255], 7:[255,160,100], 8:[200,140,255], 9:[100,180,180],
  10:[100,220,160], 11:[255,200,100], 12:[140,140,160], 20:[140,140,160],
  38:[255,100,130]
};
let _ghostCanvas = null;
let _ghostDirty = true;
export function setGhostDirty() { _ghostDirty = true; }

// Connection class → ghost rendering style
const _GHOST_CONN_STYLE = {
  'conn-wan':     { sw: 3.5, alpha: 0.5,  glow: true, dash: null },
  'conn-bridge':  { sw: 3,   alpha: 0.45, glow: true, dash: [12, 4, 2, 4] },
  'conn-portal':  { sw: 2.5, alpha: 0.4,  glow: true, dash: [3, 6, 1, 6] },
  'conn-infra':   { sw: 2.5, alpha: 0.4,  glow: false, dash: null },
  'conn-active':  { sw: 2,   alpha: 0.35, glow: false, dash: [8, 4] },
  'conn-vlan':    { sw: 1.8, alpha: 0.28, glow: false, dash: [6, 3] },
  'conn-ap':      { sw: 1.5, alpha: 0.2,  glow: false, dash: [4, 6] },
  'conn-mesh':    { sw: 1.5, alpha: 0.2,  glow: false, dash: [4, 6] },
  'conn-offline': { sw: 1,   alpha: 0.1,  glow: false, dash: [2, 8] },
};

function _getConnStyle(path) {
  for (const cls of Object.keys(_GHOST_CONN_STYLE)) {
    if (path.classList.contains(cls)) return _GHOST_CONN_STYLE[cls];
  }
  return { sw: 1.5, alpha: 0.25, glow: false, dash: [8, 4] };
}

function _renderGhostLines() {
  if (!_topology || !_connPaths.length) return;
  if (!_ghostCanvas) {
    _ghostCanvas = document.createElement('canvas');
    _ghostCanvas.id = 'ghost-lines';
    // Half resolution — smooth CSS upscale gives ethereal soft look
    _ghostCanvas.width = Math.round(WORLD_W / 2);
    _ghostCanvas.height = Math.round(WORLD_H / 2);
    world.appendChild(_ghostCanvas);
  }
  const ctx = _ghostCanvas.getContext('2d');
  ctx.clearRect(0, 0, _ghostCanvas.width, _ghostCanvas.height);
  ctx.save();
  ctx.scale(0.5, 0.5);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // First pass: glow layer (wider, soft, low opacity)
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    const style = _getConnStyle(path);
    if (!style.glow) continue;
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];
    ctx.strokeStyle = `rgba(${r},${g},${b},${style.alpha * 0.3})`;
    ctx.lineWidth = style.sw + 6;
    ctx.setLineDash([]);
    ctx.stroke(new Path2D(d));
  }

  // Second pass: main lines with proper dash patterns
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    // Skip hidden connections
    if (path.style.display === 'none' || path.getAttribute('opacity') === '0') continue;
    const style = _getConnStyle(path);
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];

    // WAN lines use gold instead of VLAN color
    const isWan = path.classList.contains('conn-wan');
    const cr = isWan ? 255 : r;
    const cg = isWan ? 180 : g;
    const cb = isWan ? 50 : b;

    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${style.alpha})`;
    ctx.lineWidth = style.sw;
    ctx.setLineDash(style.dash || []);
    ctx.stroke(new Path2D(d));
  }

  // Third pass: bright core on bridges and portals
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    const isBridge = path.classList.contains('conn-bridge');
    const isPortal = path.classList.contains('conn-portal');
    if (!isBridge && !isPortal) continue;
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];
    ctx.strokeStyle = `rgba(${r},${g},${b},0.5)`;
    ctx.lineWidth = 1;
    ctx.setLineDash(isBridge ? [2, 6] : [1, 4]);
    ctx.stroke(new Path2D(d));
  }

  ctx.restore();
  _ghostDirty = false;
}

// During active zoom/pan, strip heavy layers (display:none) then promote world to
// a single GPU layer (will-change:transform). With heavy layers gone, the texture
// is just 87 small icons + ghost canvas — well within VRAM.  Sequence matters:
//   Frame 0: add .zooming (display:none strips layers from paint tree)
//   Frame 1: set will-change:transform (browser rasterizes the now-lightweight world)
//   Frame 2+: GPU scales the cached raster — zero main-thread paint work
let _zoomActive = false;
export function isZoomActive() { return _zoomActive; }
let _zoomIdleTimer = 0;
let _zoomWillChangeRaf = 0;
function _enterZoomMode() {
  if (!_zoomActive) {
    _zoomActive = true;
    if (_ghostDirty) _renderGhostLines();
    world.classList.add('zooming');
    // Clear mote canvas so stale particles don't persist while loop is paused
    clearMoteCanvas();
    // On medium/high, promote to GPU layer after decorative layers are gone.
    // On low tier or when disabled, skip — the 4800x3300 texture exceeds weak GPU VRAM.
    if (_gpuZoomEnabled && _perfTier !== 'low') {
      _zoomWillChangeRaf = requestAnimationFrame(() => {
        _zoomWillChangeRaf = 0;
        if (_zoomActive) world.style.willChange = 'transform';
      });
    }
  }
  clearTimeout(_zoomIdleTimer);
  _zoomIdleTimer = setTimeout(_exitZoomMode, 400);
}

// Deferred SSE updates — queued during zoom, flushed on exit
let _deferredStatus = null;
let _deferredTrafficMap = null;
let _deferredEnergy = null;
let _deferredLatency = false;

export function setDeferredStatus(d) { _deferredStatus = d; }
export function setDeferredTraffic(map) { _deferredTrafficMap = map; }
export function setDeferredEnergy(d) { _deferredEnergy = d; }
export function setDeferredLatency(v) { _deferredLatency = v; }

function _exitZoomMode() {
  _zoomActive = false;
  if (_zoomWillChangeRaf) { cancelAnimationFrame(_zoomWillChangeRaf); _zoomWillChangeRaf = 0; }
  world.style.willChange = '';
  world.classList.remove('zooming');
  updateSparkleRect();
  ensureMoteLoop();  // Restart mote animation (was fully stopped during zoom)
  // Flush deferred SSE updates in a single frame
  requestAnimationFrame(_flushDeferredUpdates);
}

function _flushDeferredUpdates() {
  if (_deferredStatus)     { updateUI(_deferredStatus); _deferredStatus = null; }
  if (_deferredTrafficMap) {
    updateConnectionTrafficSSE(_deferredTrafficMap);
    const fakeCollectd = trafficToCollectd(_deferredTrafficMap);
    setLastTopoCollectd(fakeCollectd);
    renderTopoLayer(fakeCollectd);
    _deferredTrafficMap = null;
  }
  if (_deferredEnergy)  { updateEnergyPanel(_deferredEnergy); _deferredEnergy = null; }
  if (_deferredLatency) { updateLatencyPanel(); _deferredLatency = false; }
}

// =============================================================
// ENCHANTED VINES -- procedural fantasy botanical overlay
// =============================================================
(function _generateVines() {
  const svg = document.getElementById('enchanted-vines');
  if (!svg) return;

  const W = 4800, H = 3300;
  const ns = 'http://www.w3.org/2000/svg';

  // Seeded random for reproducibility
  let _seed = 42;
  function rand() { _seed = (_seed * 16807 + 0) % 2147483647; return (_seed - 1) / 2147483646; }
  function randRange(a, b) { return a + rand() * (b - a); }

  // Color palettes -- muted greens/golds/teals
  const vineColors = [
    'rgba(60,100,50,0.4)', 'rgba(40,80,45,0.35)', 'rgba(50,90,40,0.3)',
    'rgba(70,110,55,0.25)', 'rgba(45,85,50,0.35)',
  ];
  const leafColors = [
    'rgba(70,120,55,0.45)', 'rgba(50,100,45,0.4)', 'rgba(80,130,60,0.35)',
    'rgba(60,110,50,0.5)', 'rgba(90,140,70,0.3)',
  ];
  const bloomColors = [
    'rgba(200,160,80,0.4)', 'rgba(180,140,100,0.35)', 'rgba(160,120,180,0.3)',
    'rgba(140,180,200,0.25)', 'rgba(220,180,100,0.35)',
  ];
  const glowColors = [
    'rgba(140,200,120,0.15)', 'rgba(100,180,140,0.12)', 'rgba(180,200,100,0.1)',
  ];

  // Add SVG defs for glow filter
  const defs = document.createElementNS(ns, 'defs');
  const filterMarkup = '<filter id="vine-glow" x="-30%" y="-30%" width="160%" height="160%">'
    + '<feGaussianBlur stdDeviation="4" result="blur"/>'
    + '<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>'
    + '</filter>'
    + '<filter id="vine-soft" x="-20%" y="-20%" width="140%" height="140%">'
    + '<feGaussianBlur stdDeviation="2"/>'
    + '</filter>';
  defs.innerHTML = filterMarkup;  // SVG filter defs (static, no user input)
  svg.appendChild(defs);

  // Generate a single vine tendril as a cubic bezier chain
  function generateTendril(startX, startY, angle, length, depth) {
    const points = [{ x: startX, y: startY }];
    let x = startX, y = startY, a = angle;
    const segments = Math.floor(length / 40) + 2;

    for (let i = 0; i < segments; i++) {
      const segLen = randRange(30, 60) * (1 - depth * 0.15);
      a += randRange(-0.4, 0.4);
      x += Math.cos(a) * segLen;
      y += Math.sin(a) * segLen;
      points.push({ x, y });
    }

    // Build smooth curve through points
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 5;
      const cp1y = p1.y + (p2.y - p0.y) / 5;
      const cp2x = p2.x - (p3.x - p1.x) / 5;
      const cp2y = p2.y - (p3.y - p1.y) / 5;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }

    return { d, points, angle: a };
  }

  // Place a leaf shape at a point
  function createLeaf(x, y, angle, size) {
    const la = angle + randRange(-0.5, 0.5);
    const lx = Math.cos(la), ly = Math.sin(la);
    const px = -ly, py = lx; // perpendicular
    const s = size * randRange(0.6, 1.2);
    const tipX = x + lx * s * 2, tipY = y + ly * s * 2;
    const w = s * 0.5;
    return `M${x.toFixed(1)},${y.toFixed(1)} C${(x + lx * s * 0.5 + px * w).toFixed(1)},${(y + ly * s * 0.5 + py * w).toFixed(1)} ${(tipX - lx * s * 0.3 + px * w * 0.3).toFixed(1)},${(tipY - ly * s * 0.3 + py * w * 0.3).toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)} C${(tipX - lx * s * 0.3 - px * w * 0.3).toFixed(1)},${(tipY - ly * s * 0.3 - py * w * 0.3).toFixed(1)} ${(x + lx * s * 0.5 - px * w).toFixed(1)},${(y + ly * s * 0.5 - py * w).toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  }

  // Build full vine system from an origin
  function buildVineCluster(ox, oy, mainAngle, mainLen) {
    const g = document.createElementNS(ns, 'g');
    const animDelay = randRange(0, 5);

    // Main tendril
    const main = generateTendril(ox, oy, mainAngle, mainLen, 0);
    const mainPath = document.createElementNS(ns, 'path');
    mainPath.setAttribute('d', main.d);
    mainPath.setAttribute('class', 'vine-tendril');
    mainPath.setAttribute('stroke', vineColors[Math.floor(rand() * vineColors.length)]);
    mainPath.setAttribute('stroke-width', randRange(1.5, 3).toFixed(1));
    g.appendChild(mainPath);

    // Side branches
    for (let i = 2; i < main.points.length - 1; i++) {
      if (rand() > 0.5) continue;
      const p = main.points[i];
      const branchAngle = main.angle + (rand() > 0.5 ? 1 : -1) * randRange(0.5, 1.2);
      const branch = generateTendril(p.x, p.y, branchAngle, mainLen * randRange(0.2, 0.45), 1);
      const bp = document.createElementNS(ns, 'path');
      bp.setAttribute('d', branch.d);
      bp.setAttribute('class', 'vine-tendril');
      bp.setAttribute('stroke', vineColors[Math.floor(rand() * vineColors.length)]);
      bp.setAttribute('stroke-width', randRange(0.8, 1.5).toFixed(1));
      g.appendChild(bp);

      // Leaves on branches
      for (const lp of branch.points) {
        if (rand() > 0.35) continue;
        const leaf = document.createElementNS(ns, 'path');
        leaf.setAttribute('d', createLeaf(lp.x, lp.y, branchAngle, randRange(6, 14)));
        leaf.setAttribute('class', 'vine-leaf');
        leaf.setAttribute('fill', leafColors[Math.floor(rand() * leafColors.length)]);
        g.appendChild(leaf);
      }

      // Occasional bloom on branch tip
      if (rand() > 0.6) {
        const tip = branch.points[branch.points.length - 1];
        const bloom = document.createElementNS(ns, 'circle');
        bloom.setAttribute('cx', tip.x.toFixed(1));
        bloom.setAttribute('cy', tip.y.toFixed(1));
        bloom.setAttribute('r', randRange(3, 7).toFixed(1));
        bloom.setAttribute('class', 'vine-bloom');
        bloom.setAttribute('fill', bloomColors[Math.floor(rand() * bloomColors.length)]);
        g.appendChild(bloom);
      }
    }

    // Leaves on main tendril
    for (let i = 1; i < main.points.length; i++) {
      if (rand() > 0.4) continue;
      const p = main.points[i];
      const segAngle = i > 0 ? Math.atan2(p.y - main.points[i - 1].y, p.x - main.points[i - 1].x) : mainAngle;
      const side = rand() > 0.5 ? 1 : -1;
      const leaf = document.createElementNS(ns, 'path');
      leaf.setAttribute('d', createLeaf(p.x, p.y, segAngle + side * randRange(0.6, 1.2), randRange(8, 18)));
      leaf.setAttribute('class', 'vine-leaf');
      leaf.setAttribute('fill', leafColors[Math.floor(rand() * leafColors.length)]);
      g.appendChild(leaf);
    }

    // Glow motes scattered along vine
    for (let i = 0; i < 3; i++) {
      const p = main.points[Math.floor(rand() * main.points.length)];
      const mote = document.createElementNS(ns, 'circle');
      mote.setAttribute('cx', (p.x + randRange(-15, 15)).toFixed(1));
      mote.setAttribute('cy', (p.y + randRange(-15, 15)).toFixed(1));
      mote.setAttribute('r', randRange(4, 10).toFixed(1));
      mote.setAttribute('fill', glowColors[Math.floor(rand() * glowColors.length)]);
      g.appendChild(mote);
    }

    g.style.animation = `vine-sway ${randRange(6, 12).toFixed(1)}s ease-in-out ${animDelay.toFixed(1)}s infinite`;
    return g;
  }

  // Spawn vine clusters around edges and scattered across the map
  // Edge vines -- grow inward from borders, extended well past edges to avoid visible boundary
  const edgeSpawns = [
    // Top edge
    ...Array.from({length: 10}, () => ({ x: randRange(-200, W + 200), y: randRange(-120, 60), a: randRange(1.2, 1.9) })),
    // Bottom edge
    ...Array.from({length: 10}, () => ({ x: randRange(-200, W + 200), y: randRange(H - 60, H + 120), a: randRange(-1.9, -1.2) })),
    // Left edge
    ...Array.from({length: 8}, () => ({ x: randRange(-120, 60), y: randRange(-100, H + 100), a: randRange(-0.4, 0.4) })),
    // Right edge
    ...Array.from({length: 8}, () => ({ x: randRange(W - 60, W + 120), y: randRange(-100, H + 100), a: randRange(2.7, 3.5) })),
  ];

  for (const s of edgeSpawns) {
    svg.appendChild(buildVineCluster(s.x, s.y, s.a, randRange(200, 500)));
  }

  // Interior vines -- shorter, more decorative
  for (let i = 0; i < 20; i++) {
    const x = randRange(200, W - 200);
    const y = randRange(200, H - 200);
    const a = randRange(0, Math.PI * 2);
    svg.appendChild(buildVineCluster(x, y, a, randRange(80, 250)));
  }

  // Corner flourishes -- dense clusters in corners, extended outward
  const corners = [
    { x: -30, y: -30, a: 0.8 }, { x: W + 30, y: -30, a: 2.3 },
    { x: -30, y: H + 30, a: -0.8 }, { x: W + 30, y: H + 30, a: -2.3 },
  ];
  for (const c of corners) {
    for (let i = 0; i < 5; i++) {
      svg.appendChild(buildVineCluster(c.x + randRange(-60, 60), c.y + randRange(-60, 60), c.a + randRange(-0.6, 0.6), randRange(300, 600)));
    }
  }
})();

// rAF-batched transform: multiple wheel/touch events per frame collapse into one DOM write
let _transformRafId = 0;
function _applyTransformNow() {
  _transformRafId = 0;
  if (_mapTilt > 0) {
    canvas.classList.add('tilted');
    world.style.transformStyle = 'preserve-3d';
    world.style.zoom = '';
    const cx = WORLD_W / 2, cy = WORLD_H / 2;
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) translate(${cx}px, ${cy}px) rotateX(${_mapTilt}deg) translate(${-cx}px, ${-cy}px)`;
    if (_mapTilt !== _lastGlobeTilt) {
      _applyGlobeZ();
      _lastGlobeTilt = _mapTilt;
    }
  } else {
    canvas.classList.remove('tilted');
    if (_lastGlobeTilt !== 0) {
      _clearGlobeZ();
      _lastGlobeTilt = 0;
    }
    world.style.transformStyle = '';
    world.style.zoom = '';
    // transform: scale() is compositor-only (no layout reflow).
    // During zoom, will-change: transform caches the raster so GPU just scales the bitmap.
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }
  // Update bubble zoom compensation (O(1) CSS var write)
  if (getBubbleFixedSize()) _updateBubbleTotalScale();
}

export function applyTransform() {
  if (!_transformRafId) _transformRafId = requestAnimationFrame(_applyTransformNow);
}

// Spherical dome: nodes at center pop toward viewer, edges recede
// Topo bands become 3D peaks; nodes float above and face the camera
function _applyGlobeZ() {
  if (!_topology) return;
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const maxD2 = cx * cx + cy * cy;
  const R = _mapTilt * 8;        // dome curvature
  const peakH = _mapTilt * 5;    // topo peak height
  const nodeFloat = _mapTilt * 3; // node hover above peaks
  const counterRot = `x ${-_mapTilt}deg`; // billboard -- face the camera

  // 3D topo peaks -- each contour band at its elevation Z
  const topoEl = document.getElementById('topo-svg');
  if (topoEl) {
    topoEl.style.transformStyle = 'preserve-3d';
    _getTopoBands().forEach(band => {
      const elev = parseFloat(band.dataset.elev) || 0;
      band.style.translate = `0px 0px ${elev * peakH}px`;
    });
  }

  // Connection lines float at mid-peak height
  const connSvg = document.getElementById('connections');
  if (connSvg) connSvg.style.translate = `0px 0px ${peakH * 0.4}px`;

  // Region labels at peak level, face camera
  const regionEl = document.getElementById('region-labels');
  if (regionEl) {
    regionEl.style.translate = `0px 0px ${peakH * 0.7}px`;
    regionEl.style.rotate = counterRot;
  }

  // Per-node dome Z + float; counter-rotate to face camera (billboard)
  for (const n of _topology.nodes) {
    const cached = getNodeDOM(n.id);
    if (!cached.el) continue;
    const dx = n.x - cx, dy = n.y - cy;
    const d2 = (dx * dx + dy * dy) / maxD2;
    const dome = R * Math.max(0, 1 - d2);
    const z = peakH + nodeFloat + dome;
    cached.el.style.translate = `0px 0px ${z}px`;
    cached.el.style.rotate = counterRot;
  }

  // Speech bubbles float high, face camera
  const bubbleZ = peakH + nodeFloat + R + _mapTilt * 3;
  _getBubbles().forEach(b => {
    b.style.translate = `0px 0px ${bubbleZ}px`;
    b.style.rotate = counterRot;
  });
}

export function applyTopoZ() {
  const peakH = _mapTilt * 5;
  const topoEl = document.getElementById('topo-svg');
  if (!topoEl) return;
  topoEl.style.transformStyle = 'preserve-3d';
  topoEl.querySelectorAll('.topo-band').forEach(band => {
    const elev = parseFloat(band.dataset.elev) || 0;
    band.style.translate = `0px 0px ${elev * peakH}px`;
  });
}

function _clearGlobeZ() {
  if (!_topology) return;
  for (const n of _topology.nodes) {
    const cached = getNodeDOM(n.id);
    if (cached.el) { cached.el.style.translate = ''; cached.el.style.rotate = ''; }
  }
  const topoEl = document.getElementById('topo-svg');
  const connSvg = document.getElementById('connections');
  const regionEl = document.getElementById('region-labels');
  if (topoEl) {
    topoEl.style.transformStyle = '';
    _getTopoBands().forEach(b => { b.style.translate = ''; });
  }
  if (connSvg) connSvg.style.translate = '';
  if (regionEl) { regionEl.style.translate = ''; regionEl.style.rotate = ''; }
  _getBubbles().forEach(b => { b.style.translate = ''; b.style.rotate = ''; });
}

export function centerMap() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = Math.min(cw / WORLD_W, ch / WORLD_H) * 1.2;
  panX = (cw - WORLD_W * scale) / 2;
  panY = (ch - WORLD_H * scale) / 2;
  applyTransform();
}

// Fit viewport to the bounding box of current node positions (used after auto-arrange)
function _fitToNodes() {
  if (!_topology || !_topology.nodes.length) { centerMap(); return; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  _topology.nodes.forEach(n => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  });
  const PAD = 160;
  const nodeW = (maxX - minX) + PAD * 2;
  const nodeH = (maxY - minY) + PAD * 2;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = Math.min(cw / nodeW, ch / nodeH);
  scale = Math.max(0.08, Math.min(2.5, scale));
  panX = cw / 2 - ((minX + maxX) / 2) * scale;
  panY = ch / 2 - ((minY + maxY) / 2) * scale;
  _applyTransformNow(); // bypass rAF guard -- guaranteed apply after arrangement
  saveSettings();
}
export function fitToNodes() { _fitToNodes(); }

export function panToNode(x, y) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = 1.2;
  panX = cw / 2 - x * scale;
  panY = ch / 2 - y * scale;
  applyTransform();
}

export function setViewport(s, x, y) { scale = s; panX = x; panY = y; }

canvas.addEventListener('mousedown', e => {
  // Don't start pan if clicking an interactive element (bubble, panel, button, node)
  if (e.target.closest('.speech-bubble, .panel, button, a, input, textarea, select, .realm-node')) return;
  dragging = true;
  lastX = e.clientX; lastY = e.clientY;
  _enterZoomMode();  // Activate immediately -- prevents repaint gap between zoom->pan
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  _enterZoomMode();  // Lock raster for pan too
  panX += e.clientX - lastX;
  panY += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyTransform();
});
window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveSettings(); } });

// ── Touch: pan & pinch-to-zoom ──
let _touchPanning = false, _lastTouch = null, _pinchDist = null;
canvas.addEventListener('touchstart', e => {
  if (e.target.closest('.speech-bubble, .panel, button, a, input, textarea, select, .realm-node')) return;
  _enterZoomMode();  // Activate immediately on touch
  if (e.touches.length === 2) {
    _pinchDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    _touchPanning = false;
  } else if (e.touches.length === 1) {
    _touchPanning = true;
    _lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  if (!_touchPanning && _pinchDist === null) return;  // Not panning or pinching -- skip (e.g. node drag)
  e.preventDefault();  // Block browser scroll/refresh for ALL map gestures
  _enterZoomMode();  // Lock raster BEFORE transform changes
  if (e.touches.length === 2 && _pinchDist !== null) {
    const newDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const mx = midX - _canvasRect.left, my = midY - _canvasRect.top;
    const oldScale = scale;
    scale = Math.max(0.1, Math.min(3, scale * (newDist / _pinchDist)));
    panX = mx - (mx - panX) * (scale / oldScale);
    panY = my - (my - panY) * (scale / oldScale);
    _pinchDist = newDist;
    applyTransform();
  } else if (_touchPanning && e.touches.length === 1 && _lastTouch) {
    const t = e.touches[0];
    panX += t.clientX - _lastTouch.x;
    panY += t.clientY - _lastTouch.y;
    _lastTouch = { x: t.clientX, y: t.clientY };
    applyTransform();
  }
}, { passive: false });
canvas.addEventListener('touchend', () => {
  if (_touchPanning || _pinchDist) saveSettings();
  _touchPanning = false; _lastTouch = null; _pinchDist = null;
}, { passive: true });

let _zoomSaveTimer = null;
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  _enterZoomMode();  // Lock raster BEFORE transform changes
  const mx = e.clientX - _canvasRect.left, my = e.clientY - _canvasRect.top;
  const oldScale = scale;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  scale = Math.max(0.1, Math.min(3, scale * delta));
  panX = mx - (mx - panX) * (scale / oldScale);
  panY = my - (my - panY) * (scale / oldScale);
  applyTransform();
  clearTimeout(_zoomSaveTimer);
  _zoomSaveTimer = setTimeout(saveSettings, 800);
}, { passive: false });

// (Tooltips moved to node-status.js)

// Init -- centerMap sets default; restoreSettings (later) overrides with saved zoom/pan
centerMap();
// On resize, preserve current zoom -- just refresh the canvas rect cache (debounced)
let _resizeTimer = 0;
window.addEventListener('resize', () => {
  if (_resizeTimer) return;
  _resizeTimer = setTimeout(() => { _resizeTimer = 0; _canvasRect = canvas.getBoundingClientRect(); }, 100);
});

// ── Draggable Map Nodes (mouse + touch) ──
// Late-bound callback for openPersonaEditor (set by app.js to avoid circular dep)
let _openPersonaEditor = () => {};
export function setOpenPersonaEditor(fn) { _openPersonaEditor = fn; }

(function() {
  let dragNode = null, dragOffsetX = 0, dragOffsetY = 0, hasMoved = false;
  let _longPressTimer = null;
  let _dragFrame = 0, _dragRafPending = false;
  let _lastNodeTapTime = 0, _lastNodeTapped = null;
  let _dragStartCx = 0, _dragStartCy = 0;
  const DRAG_THRESHOLD = 8; // px before a tap becomes a drag
  const mapWorld = document.getElementById('map-world');

  function startNodeDrag(node, cx, cy) {
    dragNode = node;
    hasMoved = false;
    _dragStartCx = cx;
    _dragStartCy = cy;
    const nodeLeft = parseInt(node.style.left) || 0;
    const nodeTop = parseInt(node.style.top) || 0;
    const worldRect = mapWorld.getBoundingClientRect();
    const wx = (cx - worldRect.left) / scale;
    const wy = (cy - worldRect.top) / scale;
    dragOffsetX = wx - nodeLeft;
    dragOffsetY = wy - nodeTop;
    node.style.zIndex = '25';
    node.style.transition = 'none';
  }

  function moveNodeDrag(cx, cy) {
    if (!dragNode) return;
    // Require minimum movement before committing to a drag
    if (!hasMoved) {
      const dx = cx - _dragStartCx, dy = cy - _dragStartCy;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      hasMoved = true;
    }
    dragging = false;
    _touchPanning = false;
    const worldRect = mapWorld.getBoundingClientRect();
    const wx = (cx - worldRect.left) / scale;
    const wy = (cy - worldRect.top) / scale;
    const nx = wx - dragOffsetX;
    const ny = wy - dragOffsetY;
    dragNode.style.left = nx + 'px';
    dragNode.style.top = ny + 'px';
    // Sync topology data so topo overlay tracks dragged position
    const tipId = dragNode.dataset.tip;
    if (tipId) {
      const tn = _nodeMap.get(tipId);
      if (tn) { tn.x = nx; tn.y = ny; }
    }
    // Throttle expensive line recomputation (rAF + perf tier skip)
    _dragFrame++;
    if (_dragFrame % _PERF.dragLineThrottle === 0 && !_dragRafPending) {
      _dragRafPending = true;
      requestAnimationFrame(() => { _dragRafPending = false; updateLinePositions(); });
    }
    updateBubblePositions();
    if (Math.random() < 0.3) {
      const colors = [[240,216,144],[160,255,96],[100,180,255]];
      spawnMote(cx + (Math.random()-0.5)*16, cy + (Math.random()-0.5)*16,
        colors[Math.floor(Math.random()*colors.length)]);
    }
  }

  function endNodeDrag() {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    if (dragNode) {
      const tappedNode = dragNode;
      dragNode.style.zIndex = '';
      dragNode.style.transition = '';
      if (hasMoved) {
        const rect = tappedNode.getBoundingClientRect();
        const cx = rect.left + rect.width/2;
        const cy = rect.top + rect.height/2;
        for (let i = 0; i < 12; i++) {
          spawnMote(cx + (Math.random()-0.5)*30, cy + (Math.random()-0.5)*30, [160,255,96]);
        }
        scheduleSave();
        // Re-render topo overlay with new node positions
        invalidateTopoNodeMap();
        forceTopoRender();
        generateTerrain();
        updateRegionLabels();
      } else {
        // No movement -- this was a tap. Check for double-tap (mobile persona editor).
        const now = Date.now();
        if (_lastNodeTapped === tappedNode && now - _lastNodeTapTime < 400) {
          const key = tappedNode.dataset.tip;
          if (key) _openPersonaEditor(key);
          _lastNodeTapTime = 0;
          _lastNodeTapped = null;
        } else {
          _lastNodeTapTime = now;
          _lastNodeTapped = tappedNode;
          // Single tap on cluster -> toggle expand/collapse
          const tipKey = tappedNode.dataset.tip;
          if (tipKey && isClusterExpandable(tipKey)) {
            toggleClusterExpand(tipKey);
          }
        }
      }
      dragNode = null;
    }
  }

  // Delegated handlers on map-world (survives topology refresh)
  mapWorld.addEventListener('mousedown', e => {
    const node = e.target.closest('.realm-node');
    if (!node || e.button !== 0) return;
    e.stopPropagation();
    startNodeDrag(node, e.clientX, e.clientY);
  });

  mapWorld.addEventListener('touchstart', e => {
    const node = e.target.closest('.realm-node');
    if (!node || e.touches.length !== 1) return;
    e.stopPropagation();
    e.preventDefault();
    startNodeDrag(node, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  // Mouse move/up
  window.addEventListener('mousemove', e => moveNodeDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endNodeDrag);

  // Touch move/end
  window.addEventListener('touchmove', e => {
    if (!dragNode || !e.touches.length) return;
    e.preventDefault();
    moveNodeDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  window.addEventListener('touchend', endNodeDrag, { passive: true });
  window.addEventListener('touchcancel', endNodeDrag, { passive: true });
})();

// ── Arcane Grid Controls ──
const _gridSvg = document.getElementById('arcane-grid');
let _gridEnabled = false;
let _gridOpacity = 0.4;
let _gridScale = 1.0;
let _gridPulse = true;
let _gridHue = 0;

(function initGridControls() {
  const toggle = document.getElementById('grid-toggle-cb');
  const visToggle = document.getElementById('vis-grid');
  const opSlider = document.getElementById('grid-opacity-slider');
  const opVal = document.getElementById('grid-opacity-val');
  const scSlider = document.getElementById('grid-scale-slider');
  const scVal = document.getElementById('grid-scale-val');
  const pulseToggle = document.getElementById('grid-pulse-cb');
  const pulseVal = document.getElementById('grid-pulse-val');
  const hueSlider = document.getElementById('grid-hue-slider');
  const hueVal = document.getElementById('grid-hue-val');
  const layerSlider = document.getElementById('layer-grid-slider');

  if (!_gridSvg) return;

  function applyGridStyle() {
    _gridSvg.style.setProperty('--grid-opacity', _gridOpacity);
    _gridSvg.style.setProperty('--grid-scale', _gridScale);
    _gridSvg.style.filter = _gridHue ? `hue-rotate(${_gridHue}deg)` : '';
    _gridSvg.style.animationPlayState = _gridPulse ? 'running' : 'paused';
    _gridSvg.classList.toggle('active', _gridEnabled);
  }

  function syncToggles() {
    if (toggle) toggle.checked = _gridEnabled;
    if (visToggle) visToggle.checked = _gridEnabled;
  }

  if (toggle) toggle.addEventListener('change', () => {
    _gridEnabled = toggle.checked;
    syncToggles();
    applyGridStyle();
    saveSettings();
  });
  if (visToggle) visToggle.addEventListener('change', () => {
    _gridEnabled = visToggle.checked;
    syncToggles();
    applyGridStyle();
    saveSettings();
  });
  if (opSlider) opSlider.addEventListener('input', () => {
    _gridOpacity = parseFloat(opSlider.value);
    if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
    if (layerSlider) layerSlider.value = _gridOpacity;
    applyGridStyle();
    scheduleSave();
  });
  if (layerSlider) layerSlider.addEventListener('input', () => {
    _gridOpacity = parseFloat(layerSlider.value);
    if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
    if (opSlider) opSlider.value = _gridOpacity;
    applyGridStyle();
    scheduleSave();
  });
  if (scSlider) scSlider.addEventListener('input', () => {
    _gridScale = parseFloat(scSlider.value);
    if (scVal) scVal.textContent = _gridScale.toFixed(1);
    applyGridStyle();
    scheduleSave();
  });
  if (pulseToggle) pulseToggle.addEventListener('change', () => {
    _gridPulse = pulseToggle.checked;
    if (pulseVal) pulseVal.textContent = _gridPulse ? 'on' : 'off';
    applyGridStyle();
    scheduleSave();
  });
  if (hueSlider) hueSlider.addEventListener('input', () => {
    _gridHue = parseInt(hueSlider.value);
    if (hueVal) hueVal.textContent = _gridHue + '\u00b0';
    applyGridStyle();
    scheduleSave();
  });

  // Export for save/restore
  window._gridControls = {
    applyGridStyle,
    syncToggles,
    getState: () => ({ enabled: _gridEnabled, opacity: _gridOpacity, scale: _gridScale, pulse: _gridPulse, hue: _gridHue }),
    setState: (s) => {
      if (s.enabled !== undefined) _gridEnabled = s.enabled;
      if (s.opacity !== undefined) _gridOpacity = s.opacity;
      if (s.scale !== undefined) _gridScale = s.scale;
      if (s.pulse !== undefined) _gridPulse = s.pulse;
      if (s.hue !== undefined) _gridHue = s.hue;
      // Update UI
      if (opSlider) opSlider.value = _gridOpacity;
      if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
      if (layerSlider) layerSlider.value = _gridOpacity;
      if (scSlider) scSlider.value = _gridScale;
      if (scVal) scVal.textContent = _gridScale.toFixed(1);
      if (pulseToggle) pulseToggle.checked = _gridPulse;
      if (pulseVal) pulseVal.textContent = _gridPulse ? 'on' : 'off';
      if (hueSlider) hueSlider.value = _gridHue;
      if (hueVal) hueVal.textContent = _gridHue + '\u00b0';
      syncToggles();
      applyGridStyle();
    }
  };

  applyGridStyle();
})();

// ── Arcane Ambiance Controls (Compass, Sparkles, Vignette, Glow) ──
(function initAmbianceControls() {
  const compassEl = document.getElementById('compass-rose');
  const sparkleLayer = document.getElementById('sparkle-layer');
  const vignetteEl = document.getElementById('map-vignette');
  const mapWorld = document.getElementById('map-world');

  let compassEnabled = true, compassOpacity = 0.7, compassScale = 1.0;
  let sparklesEnabled = true, sparkleOpacity = 0.7, sparkleDensity = 0.5;
  let vignetteEnabled = true, vignetteOpacity = 0.3;
  let ambientGlow = 0.3;
  let sparkleTimer = null;

  function applyCompass() {
    if (compassEl) {
      compassEl.style.display = compassEnabled ? '' : 'none';
      compassEl.style.setProperty('--compass-opacity', compassOpacity);
      compassEl.style.opacity = compassOpacity;
      compassEl.style.transform = `scale(${compassScale})`;
    }
  }

  function applySparkles() {
    if (sparkleLayer) {
      sparkleLayer.style.display = sparklesEnabled ? '' : 'none';
      sparkleLayer.style.opacity = sparkleOpacity;
    }
    if (sparkleTimer) { clearInterval(sparkleTimer); sparkleTimer = null; }
    if (sparklesEnabled && sparkleDensity > 0 && sparkleLayer) {
      const ms = Math.max(80, 600 / sparkleDensity);
      sparkleTimer = setInterval(spawnSparkle, ms);
    }
  }

  function spawnSparkle() {
    if (!sparkleLayer) return;
    if (sparkleLayer.children.length > 30) return;
    const el = document.createElement('div');
    const isLarge = Math.random() < 0.15;
    el.className = isLarge ? 'sparkle sparkle-large' : 'sparkle';
    el.style.left = (Math.random() * 4800) + 'px';
    el.style.top = (Math.random() * 3300) + 'px';
    const dur = 2 + Math.random() * 4;
    const size = isLarge ? (4 + Math.random() * 4) : (2 + Math.random() * 3);
    el.style.setProperty('--sparkle-dur', dur + 's');
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    sparkleLayer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function applyVignette() {
    if (vignetteEl) {
      vignetteEl.style.display = vignetteEnabled ? '' : 'none';
      vignetteEl.style.opacity = vignetteOpacity;
    }
  }

  function applyGlow() {
    if (mapWorld) mapWorld.style.setProperty('--ambient-glow', ambientGlow);
  }

  const visCb = { compass: 'vis-compass', sparkles: 'vis-sparkles', vignette: 'vis-vignette' };
  const layerSl = { compass: 'layer-compass-slider', sparkles: 'layer-sparkles-slider', vignette: 'layer-vignette-slider' };

  const compassCb = document.getElementById(visCb.compass);
  if (compassCb) compassCb.addEventListener('change', () => { compassEnabled = compassCb.checked; applyCompass(); scheduleSave(); });
  const compassLayerSl = document.getElementById(layerSl.compass);
  if (compassLayerSl) compassLayerSl.addEventListener('input', () => { compassOpacity = parseFloat(compassLayerSl.value); applyCompass(); scheduleSave(); });

  const sparklesCb = document.getElementById(visCb.sparkles);
  if (sparklesCb) sparklesCb.addEventListener('change', () => { sparklesEnabled = sparklesCb.checked; applySparkles(); scheduleSave(); });
  const sparklesLayerSl = document.getElementById(layerSl.sparkles);
  if (sparklesLayerSl) sparklesLayerSl.addEventListener('input', () => { sparkleOpacity = parseFloat(sparklesLayerSl.value); applySparkles(); scheduleSave(); });

  const vignetteCb = document.getElementById(visCb.vignette);
  if (vignetteCb) vignetteCb.addEventListener('change', () => { vignetteEnabled = vignetteCb.checked; applyVignette(); scheduleSave(); });
  const vignetteLayerSl = document.getElementById(layerSl.vignette);
  if (vignetteLayerSl) vignetteLayerSl.addEventListener('input', () => { vignetteOpacity = parseFloat(vignetteLayerSl.value); applyVignette(); scheduleSave(); });

  const compassScaleSl = document.getElementById('compass-scale-slider');
  const compassScaleVal = document.getElementById('compass-scale-val');
  if (compassScaleSl) compassScaleSl.addEventListener('input', () => {
    compassScale = parseFloat(compassScaleSl.value);
    if (compassScaleVal) compassScaleVal.textContent = compassScale.toFixed(1);
    applyCompass(); scheduleSave();
  });

  const sparkleDensitySl = document.getElementById('sparkle-density-slider');
  const sparkleDensityVal = document.getElementById('sparkle-density-val');
  if (sparkleDensitySl) sparkleDensitySl.addEventListener('input', () => {
    sparkleDensity = parseFloat(sparkleDensitySl.value);
    if (sparkleDensityVal) sparkleDensityVal.textContent = sparkleDensity.toFixed(2);
    applySparkles(); scheduleSave();
  });

  const ambientGlowSl = document.getElementById('ambient-glow-slider');
  const ambientGlowVal = document.getElementById('ambient-glow-val');
  if (ambientGlowSl) ambientGlowSl.addEventListener('input', () => {
    ambientGlow = parseFloat(ambientGlowSl.value);
    if (ambientGlowVal) ambientGlowVal.textContent = ambientGlow.toFixed(2);
    applyGlow(); scheduleSave();
  });

  const vignetteSl = document.getElementById('vignette-slider');
  const vignetteValEl = document.getElementById('vignette-val');
  if (vignetteSl) vignetteSl.addEventListener('input', () => {
    vignetteOpacity = parseFloat(vignetteSl.value);
    if (vignetteLayerSl) vignetteLayerSl.value = vignetteOpacity;
    if (vignetteValEl) vignetteValEl.textContent = vignetteOpacity.toFixed(2);
    applyVignette(); scheduleSave();
  });

  // Export for save/restore
  window._ambianceControls = {
    getState: () => ({
      compass: compassEnabled, compassOp: compassOpacity, compassSc: compassScale,
      sparkles: sparklesEnabled, sparkleOp: sparkleOpacity, sparkleDen: sparkleDensity,
      vignette: vignetteEnabled, vignetteOp: vignetteOpacity, glow: ambientGlow,
    }),
    setState: (s) => {
      if (s.compass !== undefined) compassEnabled = s.compass;
      if (s.compassOp !== undefined) compassOpacity = s.compassOp;
      if (s.compassSc !== undefined) compassScale = s.compassSc;
      if (s.sparkles !== undefined) sparklesEnabled = s.sparkles;
      if (s.sparkleOp !== undefined) sparkleOpacity = s.sparkleOp;
      if (s.sparkleDen !== undefined) sparkleDensity = s.sparkleDen;
      if (s.vignette !== undefined) vignetteEnabled = s.vignette;
      if (s.vignetteOp !== undefined) vignetteOpacity = s.vignetteOp;
      if (s.glow !== undefined) ambientGlow = s.glow;
      if (compassCb) compassCb.checked = compassEnabled;
      if (compassLayerSl) compassLayerSl.value = compassOpacity;
      if (compassScaleSl) compassScaleSl.value = compassScale;
      if (compassScaleVal) compassScaleVal.textContent = compassScale.toFixed(1);
      if (sparklesCb) sparklesCb.checked = sparklesEnabled;
      if (sparklesLayerSl) sparklesLayerSl.value = sparkleOpacity;
      if (sparkleDensitySl) sparkleDensitySl.value = sparkleDensity;
      if (sparkleDensityVal) sparkleDensityVal.textContent = sparkleDensity.toFixed(2);
      if (vignetteCb) vignetteCb.checked = vignetteEnabled;
      if (vignetteLayerSl) vignetteLayerSl.value = vignetteOpacity;
      if (vignetteSl) vignetteSl.value = vignetteOpacity;
      if (vignetteValEl) vignetteValEl.textContent = vignetteOpacity.toFixed(2);
      if (ambientGlowSl) ambientGlowSl.value = ambientGlow;
      if (ambientGlowVal) ambientGlowVal.textContent = ambientGlow.toFixed(2);
      applyCompass(); applySparkles(); applyVignette(); applyGlow();
    }
  };

  applyCompass(); applySparkles(); applyVignette(); applyGlow();
})();

// ── Visibility Toggles ──
(function wireVisibilityToggles() {
  const toggles = [
    ['vis-parchment',    '#map-parchment'],
    ['vis-terrain',      '#terrain-dynamic'],
    ['vis-terrain-orig', '#terrain-original'],
    ['vis-topo',         '#topo-svg'],
    ['vis-connections',  '#connections'],
    ['vis-nodes',        null, '.realm-node'],
    ['vis-labels',       null, '.node-label'],
    ['vis-sublabels',    null, '.node-sublabel'],
    ['vis-regions',      '#region-labels'],
    ['vis-vlanlabels',   null, '.vlan-label'],
    ['vis-bubbles',      null, '.speech-bubble'],
    ['vis-titlebar',     '#title-bar'],
    ['vis-search',       '#realm-search'],
    ['vis-statuspanel',  '#realm-panel'],
    ['vis-legend',       '#legend'],
    ['vis-spellbook',    '#spellbook'],
    ['vis-codex',        '#realm-codex'],
    ['vis-questlog',     '#quest-log'],
    ['vis-cartographer', '#cartographer'],
    ['vis-energy',       '#energy-panel'],
    ['vis-nodelist',     '#node-list'],
    ['vis-debug',        '#debug-panel'],
    ['vis-latency',      '#latency-panel'],
    ['vis-firewall',     '#firewall-panel'],
    ['vis-wifi',         '#wifi-panel'],
    ['vis-scanner',      '#scanner-panel'],
    ['vis-map-vines',    '#enchanted-vines'],
  ];
  for (const [id, sel, multiSel] of toggles) {
    const cb = document.getElementById(id);
    if (!cb) continue;
    cb.addEventListener('change', () => {
      const show = cb.checked;
      if (sel) {
        const el = document.querySelector(sel);
        if (el) {
          if (el.classList.contains('panel-sealed')) {
            const rune = document.querySelector(`.sealed-rune[data-panel-id="${el.id}"]`);
            if (rune) rune.remove();
            el.classList.remove('panel-sealed');
            const dock = document.getElementById('sealed-dock');
            const tray = dock?.querySelector('.dock-tray');
            if (tray && tray.children.length === 0) {
              dock.classList.remove('has-runes');
              dock.style.bottom = '-80px';
            }
          }
          el.style.display = show ? '' : 'none';
        }
      } else if (multiSel) {
        document.querySelectorAll(multiSel).forEach(el => {
          el.style.visibility = show ? '' : 'hidden';
        });
        if (!window._visState) window._visState = {};
        window._visState[multiSel] = show;
      }
      saveSettings();
      if (!isRestoring()) saveFormation();
      setGhostDirty();
    });
  }

  document.querySelectorAll('.panel-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setPanelMode(btn.dataset.mode));
  });

  // Clear legacy inline opacity from old settings (was set by old dock-opacity slider)
  const dockEl = document.getElementById('sealed-dock');
  if (dockEl) dockEl.style.removeProperty('opacity');

  const dockOpSlider = document.getElementById('dock-opacity-slider');
  const dockOpVal = document.getElementById('dock-opacity-val');
  const dockScSlider = document.getElementById('dock-scale-slider');
  const dockScVal = document.getElementById('dock-scale-val');
  const dockBgSlider = document.getElementById('dock-bg-slider');
  const dockBgVal = document.getElementById('dock-bg-val');

  if (dockOpSlider) {
    dockOpSlider.addEventListener('input', () => {
      const v = parseFloat(dockOpSlider.value);
      if (dockOpVal) dockOpVal.textContent = v.toFixed(2);
      const dock = document.getElementById('sealed-dock');
      if (dock) {
        // Clear legacy inline opacity from old settings
        dock.style.removeProperty('opacity');
        const bg = dock.querySelector('.dock-bg-layer');
        if (bg) bg.style.opacity = v;
        dock.style.setProperty('--dock-shadow-opacity', v);
      }
      saveSettings();
    });
  }
  if (dockScSlider) {
    dockScSlider.addEventListener('input', () => {
      const v = parseFloat(dockScSlider.value);
      if (dockScVal) dockScVal.textContent = v.toFixed(2);
      document.documentElement.style.setProperty('--rune-scale', v);
      saveSettings();
    });
  }
  if (dockBgSlider) {
    dockBgSlider.addEventListener('input', () => {
      const v = parseFloat(dockBgSlider.value);
      if (dockBgVal) dockBgVal.textContent = v.toFixed(2);
      const dock = document.getElementById('sealed-dock');
      if (dock) {
        dock.style.setProperty('--dock-bg-opacity', v);
      }
      saveSettings();
    });
  }

  const sigilOpSlider = document.getElementById('sigil-opacity-slider');
  const sigilOpVal = document.getElementById('sigil-opacity-val');
  if (sigilOpSlider) {
    sigilOpSlider.addEventListener('input', () => {
      const v = parseFloat(sigilOpSlider.value);
      if (sigilOpVal) sigilOpVal.textContent = v.toFixed(2);
      document.querySelectorAll('.sealed-rune').forEach(r => {
        r.style.opacity = v;
      });
      window._sigilOpacity = v;
      saveSettings();
    });
  }

  const dockHueSlider = document.getElementById('dock-hue-slider');
  const dockHueVal = document.getElementById('dock-hue-val');
  if (dockHueSlider) {
    dockHueSlider.addEventListener('input', () => {
      const v = parseInt(dockHueSlider.value);
      if (dockHueVal) dockHueVal.textContent = v + '\u00b0';
      document.documentElement.style.setProperty('--dock-hue', v + 'deg');
      saveSettings();
    });
  }

  // Icon mode buttons (sigil / emoji / nova)
  const iconModeBtns = document.querySelectorAll('.icon-mode-btn');
  const savedIconMode = localStorage.getItem('realm-icon-mode') || 'nova';
  iconModeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.iconMode === savedIconMode);
    btn.addEventListener('click', () => {
      iconModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      window.setIconMode?.(btn.dataset.iconMode);
      saveSettings();
    });
  });

  const runeLabelCb = document.getElementById('dock-rune-labels');
  if (runeLabelCb) {
    runeLabelCb.addEventListener('change', () => {
      document.getElementById('sealed-dock')?.classList.toggle('show-rune-labels', runeLabelCb.checked);
      saveSettings();
    });
  }

  const fpsCb = document.getElementById('vis-fps-counter');
  if (fpsCb) {
    fpsCb.addEventListener('change', () => {
      getFpsEl().style.display = fpsCb.checked ? '' : 'none';
      if (fpsCb.checked) startFpsLoop();
      saveSettings();
    });
  }

  const loadVinesCb = document.getElementById('vis-loading-vines');
  if (loadVinesCb) {
    loadVinesCb.addEventListener('change', () => {
      document.querySelectorAll('.rl-vines').forEach(el => {
        el.style.display = loadVinesCb.checked ? '' : 'none';
      });
      saveSettings();
    });
  }

  const replayBtn = document.getElementById('replay-loading-btn');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      const loadEl = document.getElementById('realm-loading');
      if (!loadEl) return;
      loadEl.dataset.stage = '0';
      const arc = loadEl.querySelector('.rl-progress-arc');
      if (arc) arc.style.strokeDashoffset = '1099.56';
      loadEl.querySelectorAll('.rl-stage-mark').forEach(m => m.classList.remove('lit'));
      loadEl.querySelector('.rl-sparks').innerHTML = '';
      const stageText = loadEl.querySelector('.rl-stage-text');
      if (stageText) stageText.textContent = 'Igniting the arcane sigil';
      loadEl.style.display = '';
      loadEl.classList.remove('dismissed');
      loadEl.querySelectorAll('.rl-vines path[stroke]').forEach(p => {
        const clone = p.cloneNode(true);
        p.parentNode.replaceChild(clone, p);
      });
      loadEl.querySelectorAll('.rl-vines path[fill]:not([stroke])').forEach(p => {
        const clone = p.cloneNode(true);
        p.parentNode.replaceChild(clone, p);
      });
      loadEl.querySelectorAll('.rl-vines circle').forEach(c => {
        const clone = c.cloneNode(true);
        c.parentNode.replaceChild(clone, c);
      });
      const adv = window._advanceLoadStage;
      if (adv) {
        setTimeout(() => adv(1), 600);
        setTimeout(() => adv(2), 1800);
        setTimeout(() => adv(3), 3000);
        setTimeout(() => adv(4), 4200);
      }
      setTimeout(() => {
        loadEl.classList.add('dismissed');
        setTimeout(() => { loadEl.style.display = 'none'; }, 1300);
      }, 5500);
    });
  }

  // ── Layer Opacity Sliders ──
  const opacityLayers = [
    ['layer-parchment-slider',    '#map-parchment',    false],
    ['layer-terrain-orig-slider', '#terrain-original', false],
    ['layer-terrain-slider',      '#terrain-dynamic',  false],
    ['layer-topo-slider',         '#topo-svg',         false],
    ['layer-connections-slider',  '#connections',       false],
    ['layer-regions-slider',      '#region-labels',     false],
    ['layer-nodes-slider',        null,                 true, '.realm-node'],
    ['layer-labels-slider',       null,                 true, '.node-label'],
    ['layer-sublabels-slider',    null,                 true, '.node-sublabel'],
    ['layer-vlanlabels-slider',   null,                 true, '.vlan-label'],
    ['layer-bubbles-slider',      null,                 true, '.speech-bubble'],
    ['panel-titlebar-slider',     '#title-bar',         false],
    ['panel-search-slider',       '#realm-search',      false],
    ['panel-vitals-slider',       '#realm-panel',       false],
    ['panel-legend-slider',       '#legend',            false],
    ['panel-spellbook-slider',    '#spellbook',         false],
    ['panel-codex-slider',        '#realm-codex',       false],
    ['panel-questlog-slider',     '#quest-log',         false],
    ['panel-cartographer-slider', '#cartographer',      false],
    ['panel-energy-slider',       '#energy-panel',      false],
    ['panel-nodelist-slider',     '#node-list',         false],
    ['panel-mirror-slider',       '#debug-panel',       false],
    ['panel-latency-slider',      '#latency-panel',     false],
    ['panel-firewall-slider',     '#firewall-panel',    false],
    ['panel-wifi-slider',        '#wifi-panel',        false],
    ['panel-scanner-slider',     '#scanner-panel',     false],
  ];
  for (const [sliderId, sel, isMulti, multiSel] of opacityLayers) {
    const sl = document.getElementById(sliderId);
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = sl.value;
      if (sel) {
        const el = document.querySelector(sel);
        if (el) el.style.opacity = v;
      } else if (multiSel) {
        document.querySelectorAll(multiSel).forEach(el => { el.style.opacity = v; });
        if (!window._layerOpacity) window._layerOpacity = {};
        window._layerOpacity[multiSel] = v;
      }
      saveSettings();
    });
  }
  // Apply saved slider values now — restoreSettings() fires before these listeners
  // exist (circular import: layout.js executes before map-view.js), so the dispatched
  // input events were lost. Re-apply any non-default values.
  for (const [sliderId, sel, isMulti, multiSel] of opacityLayers) {
    const sl = document.getElementById(sliderId);
    if (!sl || sl.value == 1) continue;
    const v = sl.value;
    if (sel) {
      const el = document.querySelector(sel);
      if (el) el.style.opacity = v;
    } else if (multiSel) {
      document.querySelectorAll(multiSel).forEach(el => { el.style.opacity = v; });
      if (!window._layerOpacity) window._layerOpacity = {};
      window._layerOpacity[multiSel] = v;
    }
  }
})();
