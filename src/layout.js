'use strict';
import { WORLD_W, WORLD_H, setMapTilt } from './config.js';
import { _topology, updateLinePositions } from './topology.js';
import { generateTerrain, updateRegionLabels, invalidateTopoNodeMap, forceTopoRender, initBiomeSliders } from './terrain.js';
import { getLatencyFlat, getWifiMap } from './panels.js';
import { scale, panX, panY, applyTransform, setViewport, fitToNodes } from './map-view.js';
import { getActiveTab, updateBubblePositions } from './quest-log.js';
import { getSpellPage, showSpellPage } from './spellbook.js';
import { openPersonaEditor, getCurrentEditNode, switchToTab } from './persona-editor.js';
import { spawnMote } from './effects.js';
import { saveFormation } from './panel-manager.js';

// ── Auto-Arrange Layout (force-directed, non-blocking) ──
// Stores topology.json original positions for reset
const _originalPositions = {};
if (_topology) _topology.nodes.forEach(n => { _originalPositions[n.id] = { x: n.x, y: n.y }; });

// Pre-build connection index array: [fromIdx, toIdx, fromId, toId] for O(1) lookup
const _connIdx = [];
if (_topology) {
  const idxMap = {};
  _topology.nodes.forEach((n, i) => { idxMap[n.id] = i; });
  _topology.connections.forEach(c => {
    const a = idxMap[c.from], b = idxMap[c.to];
    if (a !== undefined && b !== undefined) _connIdx.push([a, b, c.from, c.to]);
  });
}

// Pre-compute VLAN assignments for layout modes (majority vote from connection VLANs)
const _nodeVlans = [];
if (_topology) {
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  _topology.nodes.forEach((n, i) => {
    if (vlanCounts[n.id]) {
      let best = 6, max = 0;
      for (const [v, c] of Object.entries(vlanCounts[n.id])) { if (c > max) { max = c; best = +v; } }
      _nodeVlans[i] = best;
    } else {
      _nodeVlans[i] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
    }
  });
}

let _layoutRunning = false;
let _layoutWorker = null;
let _layoutMode = 'world-tree';
// Exposed layout parameters (wired to sliders)
let _layoutAttract = 4.0;   // spring strength multiplier (x0.001)
let _layoutRepulse = 80;    // repulsion base (x1000)
let _layoutEdgeLen = 80;    // base ideal edge length
let _layoutSpacing = 8;     // same-depth peer spacing (x1000)

export function autoArrangeLayout(mode) {
  if (!_topology || _layoutRunning) return;
  if (mode) _layoutMode = mode;
  _layoutRunning = true;

  // Update mode button states
  document.querySelectorAll('.carto-mode').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === _layoutMode);
  });
  const activeBtn = document.querySelector(`.carto-mode[data-layout="${_layoutMode}"]`);
  if (activeBtn) activeBtn.classList.add('running');
  const castBtn = document.getElementById('layout-auto-btn');
  if (castBtn) { castBtn.classList.add('running'); castBtn.textContent = '\u2728 Casting\u2026'; }

  // Terminate previous worker if any
  if (_layoutWorker) { _layoutWorker.terminate(); _layoutWorker = null; }

  // Rebuild fresh index maps from current topology on every run — topology
  // may have grown (new auto-nodes, wired unknowns) since module load.
  const _freshIdxMap = {};
  _topology.nodes.forEach((n, i) => { _freshIdxMap[n.id] = i; });

  const nodeData = _topology.nodes.map(n => ({ id: n.id, type: n.type }));
  const connData = [];
  _topology.connections.forEach(c => {
    const a = _freshIdxMap[c.from], b = _freshIdxMap[c.to];
    if (a !== undefined && b !== undefined) connData.push([a, b]);
  });

  // Rebuild fresh VLAN assignments
  const _freshVlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!_freshVlanCounts[id]) _freshVlanCounts[id] = {};
      _freshVlanCounts[id][c.vlan] = (_freshVlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const freshNodeVlans = _topology.nodes.map(n => {
    const vc = _freshVlanCounts[n.id];
    if (vc) {
      let best = 6, max = 0;
      for (const [v, c] of Object.entries(vc)) { if (c > max) { max = c; best = +v; } }
      return best;
    }
    return (n.tailscale || n.type === 'tailscale') ? 0 : 6;
  });

  _layoutWorker = new Worker('layout-worker.js?v=2');
  _layoutWorker.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'progress') {
      if (castBtn) castBtn.textContent = `\u2728 ${Math.round(msg.step / msg.total * 100)}%`;
      return;
    }
    if (msg.type === 'done') {
      const x = new Float32Array(msg.x);
      const y = new Float32Array(msg.y);
      const pos = [];
      for (let i = 0; i < msg.count; i++) pos.push({ x: x[i], y: y[i] });

      _animateToPositions(pos, 900, () => {
        _layoutRunning = false;
        generateTerrain();
        updateRegionLabels();
        fitToNodes();
        if (activeBtn) activeBtn.classList.remove('running');
        if (castBtn) { castBtn.classList.remove('running'); castBtn.textContent = '\u2728 Cast Arrangement'; }
      });
      _layoutWorker.terminate();
      _layoutWorker = null;
    }
  };
  _layoutWorker.onerror = function(err) {
    console.error('Layout worker error:', err);
    _layoutRunning = false;
    if (activeBtn) activeBtn.classList.remove('running');
    if (castBtn) { castBtn.classList.remove('running'); castBtn.textContent = '\u2728 Cast Arrangement'; }
    _layoutWorker = null;
  };

  _layoutWorker.postMessage({
    nodes: nodeData,
    connIdx: connData,
    params: { attract: _layoutAttract, repulse: _layoutRepulse, edgeLen: _layoutEdgeLen, spacing: _layoutSpacing },
    worldW: WORLD_W,
    worldH: WORLD_H,
    mode: _layoutMode,
    nodeVlans: freshNodeVlans,
    latencyMap: getLatencyFlat(),
    wifiMap: getWifiMap(),
  });
}

function resetToOriginalPositions() {
  if (_layoutRunning) return;
  const nodes = _topology.nodes;
  const pos = nodes.map(n => {
    const orig = _originalPositions[n.id];
    return orig ? { x: orig.x, y: orig.y } : { x: n.x, y: n.y };
  });
  _animateToPositions(pos, 700, () => { generateTerrain(); updateRegionLabels(); });
}

// Cache node element refs for animation (avoid querySelector in hot loop)
const _nodeElCache = {};
if (_topology) _topology.nodes.forEach(n => {
  _nodeElCache[n.id] = document.querySelector(`[data-tip="${n.id}"]`);
});

function _animateToPositions(targetPos, duration, onDone) {
  const nodes = _topology.nodes;
  const startPos = nodes.map(n => ({ x: n.x, y: n.y }));
  const startTime = performance.now();
  // Build fresh element cache — topology may have new nodes since module load
  const elCache = {};
  nodes.forEach(n => { elCache[n.id] = document.querySelector(`[data-tip="${n.id}"]`); });

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    // Smooth ease-out cubic
    const e = 1 - (1 - t) * (1 - t) * (1 - t);

    const len = Math.min(nodes.length, targetPos.length);
    for (let i = 0; i < len; i++) {
      const nx = startPos[i].x + (targetPos[i].x - startPos[i].x) * e;
      const ny = startPos[i].y + (targetPos[i].y - startPos[i].y) * e;
      nodes[i].x = nx;
      nodes[i].y = ny;
      const el = elCache[nodes[i].id];
      if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
    }
    updateLinePositions();
    updateBubblePositions();

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      invalidateTopoNodeMap();
      forceTopoRender();
      scheduleSave();
      if (onDone) onDone();
    }
  }
  requestAnimationFrame(step);
}

// Wire cartographer mode buttons — clicking a mode starts arrangement
document.querySelectorAll('.carto-mode').forEach(btn => {
  btn.addEventListener('click', () => autoArrangeLayout(btn.dataset.layout));
});

// Wire layout buttons + sliders
document.getElementById('layout-auto-btn')?.addEventListener('click', () => autoArrangeLayout());
document.getElementById('layout-reset-btn')?.addEventListener('click', resetToOriginalPositions);

(function wireLayoutSliders() {
  const sliders = [
    ['layout-attract', v => { _layoutAttract = v; }],
    ['layout-repulse', v => { _layoutRepulse = v; }],
    ['layout-edge',    v => { _layoutEdgeLen = v; }],
    ['layout-spacing', v => { _layoutSpacing = v; }],
    ['layout-tilt',    v => { setMapTilt(v); applyTransform(); }, v => v + '\u00B0'],
  ];
  for (const entry of sliders) {
    const [id, setter, fmt] = entry;
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = fmt ? fmt(v) : (v % 1 === 0 ? v : v.toFixed(1));
      scheduleSave();
    });
  }
})();

initBiomeSliders({ scheduleSave });

// ── Panel Layout Modes (module-scope for persistence access) ──
const LAYOUT_KEY = 'realm-map-layout-v2';
const SETTINGS_KEY = 'realm-map-settings-v3';

const _PANEL_IDS = ['realm-panel','legend','spellbook','quest-log','realm-codex','node-list',
  'energy-panel','latency-panel','firewall-panel','wifi-panel','cartographer','debug-panel','scanner-panel'];
const _MODE_DESCS = {
  manual: 'Panels stay where you place them.',
  auto: 'Panels auto-size and tile to fill the viewport beautifully.',
  focus: 'Unfocused panels fade. Hover to summon.',
};
let _panelMode = 'manual';

export function setPanelMode(mode) {
  const prev = _panelMode;
  _panelMode = mode;
  document.body.classList.remove('panel-mode-manual', 'panel-mode-auto', 'panel-mode-focus', 'dynamic-panels');
  document.body.classList.add('panel-mode-' + mode);
  if (mode === 'auto') document.body.classList.add('dynamic-panels');
  document.querySelectorAll('.panel-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const desc = document.getElementById('panel-mode-desc');
  if (desc) desc.textContent = _MODE_DESCS[mode] || '';

  // Entering enchant: persist current layout so we can restore it later
  if (mode === 'auto' && prev !== 'auto') {
    saveLayout();
  }

  // Leaving enchant: strip treemap inline styles, restore saved layout
  if (prev === 'auto' && mode !== 'auto') {
    _PANEL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.left = ''; el.style.top = '';
      el.style.right = ''; el.style.bottom = '';
      el.style.width = ''; el.style.height = '';
      el.style.maxHeight = ''; el.style.transform = '';
    });
    // Re-apply saved layout (user's manual positions)
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const layout = JSON.parse(raw);
        if (layout.panels) {
          Object.entries(layout.panels).forEach(([id, pos]) => {
            const el = document.getElementById(id);
            if (!el || !pos.left) return;
            el.style.left = pos.left;
            el.style.top = pos.top;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';
            if (pos.width) el.style.width = pos.width;
            if (pos.height) { el.style.height = pos.height; el.style.maxHeight = 'none'; }
          });
        }
      }
    } catch (e) { /* ignore */ }
    // Clamp any panel still off-screen
    _PANEL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none' || el.classList.contains('panel-sealed')) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let moved = false;
      let l = rect.left, t = rect.top;
      if (rect.right < 40) { l = 20; moved = true; }
      if (rect.left > vw - 40) { l = vw - rect.width - 20; moved = true; }
      if (rect.bottom < 40) { t = 60; moved = true; }
      if (rect.top > vh - 40) { t = vh - rect.height - 20; moved = true; }
      if (moved) {
        el.style.left = Math.round(Math.max(0, l)) + 'px';
        el.style.top = Math.round(Math.max(56, t)) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    });
  }

  if (mode === 'auto') autoArrangePanels();
  saveSettings();
}

// Track last-interacted panel for enchant focus boost
let _lastActivePanel = null;
document.addEventListener('mousedown', e => {
  const p = e.target.closest('.panel, #debug-panel');
  if (p && _PANEL_IDS.includes(p.id)) _lastActivePanel = p.id;
}, true);

function _measurePanelWeight(el) {
  // Base importance — panels the user monitors most get higher base
  const importance = {
    'realm-panel': 3, 'quest-log': 5, 'realm-codex': 5, 'firewall-panel': 4, 'wifi-panel': 3,
    'node-list': 4, 'latency-panel': 3, 'spellbook': 3, 'energy-panel': 2,
    'cartographer': 2, 'legend': 2, 'debug-panel': 4,
  };
  const base = importance[el.id] || 3;

  // Content volume — measure how much scrollable content is hidden
  // Find the scrollable child (the panel body)
  const scrollChild = el.querySelector('[class*="-body"], .quest-cards, .spell-page:not([style*="display: none"]), .spell-page:not([style*="display:none"])');
  let contentRatio = 1;
  if (scrollChild) {
    const sh = scrollChild.scrollHeight || 100;
    const ch = scrollChild.clientHeight || 100;
    // Ratio > 1 means content is clipped — panel wants more space
    contentRatio = Math.min(3, sh / Math.max(ch, 1));
  }

  // Boost for last-interacted panel (user intent)
  const focusBoost = (_lastActivePanel === el.id) ? 1.5 : 1;

  // Final weight: importance x content need x focus
  return base * (0.5 + contentRatio * 0.5) * focusBoost;
}

function autoArrangePanels() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 10;
  const topBar = 56;
  const pad = gap; // outer padding
  const ax = pad, ay = topBar + pad;
  const aw = vw - pad * 2, ah = vh - topBar - pad * 2;

  // Collect visible panels with measured weights
  const items = [];
  _PANEL_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.style.display === 'none' || el.classList.contains('panel-sealed')) return;
    items.push({ id, el, weight: _measurePanelWeight(el) });
  });
  if (!items.length) return;

  // Sort descending by weight (treemap needs this)
  items.sort((a, b) => b.weight - a.weight);

  // ── Treemap Layout ──
  // Recursive slice-and-dice: splits weighted panels into the bounding box,
  // alternating horizontal/vertical cuts. Heavier panels get proportionally
  // more area. Split point optimizes for balanced aspect ratios.
  const rects = new Map();

  function _treemapSlice(itemList, bx, by, bw, bh, horizontal) {
    if (itemList.length === 0) return;
    if (itemList.length === 1) {
      rects.set(itemList[0].id, { x: bx, y: by, w: bw, h: bh, el: itemList[0].el });
      return;
    }

    const total = itemList.reduce((s, it) => s + it.weight, 0) || 1;

    // Find split point — try to keep aspect ratios close to golden
    // Split where cumulative weight crosses ~half
    let cumul = 0;
    let bestSplit = 1, bestAspectScore = Infinity;
    for (let i = 0; i < itemList.length - 1; i++) {
      cumul += itemList[i].weight;
      const frac = cumul / total;
      // Compute aspect ratios for both halves
      let a1w, a1h, a2w, a2h;
      if (horizontal) {
        a1w = bw * frac; a1h = bh; a2w = bw * (1 - frac); a2h = bh;
      } else {
        a1w = bw; a1h = bh * frac; a2w = bw; a2h = bh * (1 - frac);
      }
      // Penalize extreme aspect ratios in either half
      const r1 = Math.max(a1w, a1h) / Math.max(Math.min(a1w, a1h), 1);
      const r2 = Math.max(a2w, a2h) / Math.max(Math.min(a2w, a2h), 1);
      // Also penalize uneven panel counts (prefer balanced splits)
      const balance = Math.abs((i + 1) / itemList.length - 0.5);
      const score = r1 + r2 + balance * 2;
      if (score < bestAspectScore) { bestAspectScore = score; bestSplit = i + 1; }
    }

    const left = itemList.slice(0, bestSplit);
    const right = itemList.slice(bestSplit);
    const leftWeight = left.reduce((s, it) => s + it.weight, 0);
    const frac = leftWeight / total;

    if (horizontal) {
      const lw = Math.max(80, Math.round(bw * frac - gap / 2));
      const rw = Math.max(80, bw - lw - gap);
      _treemapSlice(left, bx, by, lw, bh, !horizontal);
      _treemapSlice(right, bx + lw + gap, by, rw, bh, !horizontal);
    } else {
      const lh = Math.max(50, Math.round(bh * frac - gap / 2));
      const rh = Math.max(50, bh - lh - gap);
      _treemapSlice(left, bx, by, bw, lh, !horizontal);
      _treemapSlice(right, bx, by + lh + gap, bw, rh, !horizontal);
    }
  }

  // Start horizontal if viewport is landscape, vertical if portrait
  _treemapSlice(items, ax, ay, aw, ah, aw >= ah);

  // Apply positions
  rects.forEach((r, id) => {
    const el = r.el;
    el.style.position = 'fixed';
    el.style.left = Math.round(r.x) + 'px';
    el.style.top = Math.round(r.y) + 'px';
    el.style.width = Math.round(Math.max(100, r.w)) + 'px';
    el.style.height = Math.round(Math.max(60, r.h)) + 'px';
    el.style.maxHeight = 'none';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    // Sparkle burst
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    for (let s = 0; s < 3; s++) {
      setTimeout(() => {
        spawnMote(cx + (Math.random() - 0.5) * r.w * 0.5, cy + (Math.random() - 0.5) * r.h * 0.3, [192, 144, 255]);
      }, s * 70);
    }
  });
}

// Re-arrange on panel seal/unseal in auto mode
let _autoLayoutTimer;
document.addEventListener('panel-layout-change', () => {
  if (_panelMode === 'auto') {
    clearTimeout(_autoLayoutTimer);
    _autoLayoutTimer = setTimeout(autoArrangePanels, 350);
  }
});

// Re-arrange on window resize in auto mode
let _autoResizeTimer;
window.addEventListener('resize', () => {
  if (_panelMode === 'auto') {
    clearTimeout(_autoResizeTimer);
    _autoResizeTimer = setTimeout(autoArrangePanels, 200);
  }
});

// All slider/toggle IDs to persist
const _PERSIST_SLIDERS = [
  'master-scale', 'traffic-scale', 'node-scale', 'text-scale', 'bubble-scale', 'update-speed',
  'fx-ambient', 'fx-nodes', 'fx-leylines', 'fx-glow', 'fx-pulse', 'fx-leyglow',
  'topo-opacity', 'topo-spread', 'topo-contour', 'topo-rw', 'topo-rd',
  'grid-opacity', 'grid-scale', 'grid-hue', 'layer-grid',
  'layout-attract', 'layout-repulse', 'layout-edge', 'layout-spacing', 'layout-tilt',
  'biome-land', 'biome-glow', 'biome-roads', 'biome-peaks', 'biome-grid',
  'layer-terrain-orig', 'layer-terrain', 'layer-topo', 'layer-connections',
  'layer-regions', 'layer-nodes', 'layer-labels', 'layer-sublabels',
  'layer-vlanlabels', 'layer-bubbles',
  'panel-titlebar', 'panel-search', 'panel-vitals', 'panel-legend',
  'panel-codex', 'panel-spellbook', 'panel-questlog', 'panel-cartographer', 'panel-energy', 'panel-nodelist', 'panel-mirror', 'panel-latency', 'panel-firewall', 'panel-wifi', 'panel-scanner',
  'layer-compass', 'layer-sparkles', 'layer-vignette',
  'compass-scale', 'sparkle-density', 'ambient-glow', 'vignette',
  'dock-opacity', 'dock-scale', 'dock-bg', 'dock-hue', 'layer-parchment',
];
const _PERSIST_CHECKBOXES = [
  'topo-toggle-cb', 'grid-toggle-cb', 'grid-pulse-cb',
  'vis-parchment', 'vis-terrain', 'vis-terrain-orig', 'vis-topo', 'vis-grid', 'vis-connections', 'vis-nodes', 'vis-labels',
  'vis-sublabels', 'vis-regions', 'vis-vlanlabels', 'vis-bubbles',
  'vis-compass', 'vis-sparkles', 'vis-vignette',
  'vis-titlebar', 'vis-search', 'vis-statuspanel', 'vis-legend', 'vis-spellbook',
  'vis-codex', 'vis-questlog', 'vis-cartographer', 'vis-energy', 'vis-nodelist', 'vis-debug', 'vis-latency', 'vis-firewall', 'vis-wifi', 'vis-scanner',
  'vis-map-vines', 'vis-loading-vines',
  'dock-emoji-icons', 'dock-rune-labels',
  'vis-fps-counter',
  'perf-auto-detect', 'perf-gpu-zoom',
  'bubble-fixed-size',
];

// Debounce server saves (avoid hammering on every slider move)
let _saveTimer = null;
let _restoring = false;
let _initialRestoreDone = false;

export function isRestoring() { return _restoring; }

export function saveSettings() {
  if (_restoring) return;
  _initialRestoreDone = true;  // user interacted, don't let async restore override
  const activePeTab = document.querySelector('.pe-tab.active');
  const s = {
    sliders: {}, checkboxes: {}, quality: null, collapsed: [], spellPage: getSpellPage(),
    zoom: { scale, panX, panY },
    selectedNode: getCurrentEditNode(),
    peTab: activePeTab?.dataset.peTab || 'stats',
    mirrorTab: getActiveTab(),
    panelMode: _panelMode,
  };
  _PERSIST_SLIDERS.forEach(id => {
    const sl = document.getElementById(id + '-slider');
    if (sl) s.sliders[id] = sl.value;
  });
  _PERSIST_CHECKBOXES.forEach(id => {
    const cb = document.getElementById(id);
    if (cb) s.checkboxes[id] = cb.checked;
  });
  const qSel = document.getElementById('fx-quality-select');
  if (qSel) s.quality = qSel.value;
  document.querySelectorAll('.legend-section.collapsed').forEach(sec => {
    const ds = sec.dataset.section;
    if (ds) s.collapsed.push(ds);
  });
  // Save to localStorage immediately (fast local fallback)
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // Debounced save to server DB (shared across sessions)
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).catch(() => {});
  }, 500);
}

function _applySettings(s) {
  _restoring = true;
  if (s.sliders) {
    for (const [id, val] of Object.entries(s.sliders)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
  }
  if (s.checkboxes) {
    for (const [id, checked] of Object.entries(s.checkboxes)) {
      const cb = document.getElementById(id);
      if (cb && cb.checked !== checked) { cb.checked = checked; cb.dispatchEvent(new Event('change')); }
    }
  }
  if (s.quality) {
    const qSel = document.getElementById('fx-quality-select');
    if (qSel) { qSel.value = s.quality; qSel.dispatchEvent(new Event('change')); }
  }
  if (s.collapsed) {
    document.querySelectorAll('.legend-section').forEach(sec => {
      const ds = sec.dataset.section;
      if (ds) sec.classList.toggle('collapsed', s.collapsed.includes(ds));
    });
  }
  if (s.spellPage != null) showSpellPage(s.spellPage);
  // Restore map zoom & pan position
  if (s.zoom) {
    setViewport(s.zoom.scale ?? 1, s.zoom.panX ?? 0, s.zoom.panY ?? 0);
    applyTransform();
  }
  // Restore selected node + PE tab
  if (s.selectedNode) {
    openPersonaEditor(s.selectedNode);
    if (s.peTab) switchToTab(s.peTab);
  }
  // Restore mirror tab
  if (s.mirrorTab) {
    const tab = document.querySelector(`.log-tab[data-tab="${s.mirrorTab}"]`);
    if (tab) tab.click();
  }
  // Restore panel layout mode
  if (s.panelMode && _MODE_DESCS[s.panelMode]) {
    setPanelMode(s.panelMode);
  }
  // Seal state is managed by panel-manager.js via realm-panel-formation
  _restoring = false;
}

export function restoreSettings() {
  // Check for reset parameter - clears all saved settings
  if (new URLSearchParams(window.location.search).has('reset')) {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('realm-panel-formation');
    localStorage.removeItem('realm-map-layout');
    fetch('/settings', { method: 'DELETE' }).catch(() => {});
    window.history.replaceState({}, '', window.location.pathname);
    console.log('Settings reset');
    return true;
  }
  // Try localStorage first (instant)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) _applySettings(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  // Async: load from server DB (only if user hasn't interacted yet)
  fetch('/settings').then(r => r.ok ? r.json() : null).then(s => {
    if (s && Object.keys(s).length > 0 && !_initialRestoreDone) {
      _applySettings(s);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }
    _initialRestoreDone = true;
  }).catch(() => { _initialRestoreDone = true; });
  return true;
}

export function saveLayout() {
  const layout = { panels: {}, nodes: {} };
  // Save panel positions
  ['realm-panel','legend','spellbook','quest-log','realm-codex','node-list','debug-panel','cartographer','energy-panel','latency-panel','firewall-panel','wifi-panel','scanner-panel'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.style.left) {
      const p = { left: el.style.left, top: el.style.top };
      if (el.style.width) p.width = el.style.width;
      if (el.style.height) p.height = el.style.height;
      layout.panels[id] = p;
    }
  });
  // Save node positions
  document.querySelectorAll('.realm-node').forEach(n => {
    const tip = n.dataset.tip;
    if (tip) layout.nodes[tip] = { left: n.style.left, top: n.style.top };
  });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  // Save layout to server DB too
  fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _layout: layout }),
  }).catch(() => {});
  saveSettings();
}

function _applyLayout(layout) {
  if (!layout) return false;
  let applied = false;
  // Restore panels
  if (layout.panels) {
    Object.entries(layout.panels).forEach(([id, pos]) => {
      const el = document.getElementById(id);
      if (el && pos.left) {
        el.style.left = pos.left;
        el.style.top = pos.top;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
        if (pos.width) { el.style.width = pos.width; }
        if (pos.height) { el.style.height = pos.height; el.style.maxHeight = 'none'; }
      }
    });
    applied = true;
  }
  // Panel seal state managed by panel-manager.js
  // Restore node positions
  if (layout.nodes && Object.keys(layout.nodes).length) {
    Object.entries(layout.nodes).forEach(([tip, pos]) => {
      const el = document.querySelector(`[data-tip="${tip}"]`);
      if (el && pos.left) {
        el.style.left = pos.left;
        el.style.top = pos.top;
      }
      // Sync topology data with restored positions
      if (_topology && _topology.nodes && pos.left) {
        const tn = _topology.nodes.find(n => n.id === tip);
        if (tn) { tn.x = parseInt(pos.left); tn.y = parseInt(pos.top); }
      }
    });
    invalidateTopoNodeMap(); // invalidate cached node map
    updateLinePositions();
    applied = true;
  }
  return applied;
}

export function restoreLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const layout = JSON.parse(raw);
      if (_applyLayout(layout)) return true;
    }
  } catch (e) { /* ignore corrupt layout */ }
  // Fallback: try server DB (layout is stored under _layout key in ui settings)
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/settings', false);
    xhr.send();
    if (xhr.status === 200) {
      const s = JSON.parse(xhr.responseText);
      if (s._layout) {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(s._layout));
        if (_applyLayout(s._layout)) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

// Debounced save — write at most every 500ms during drag
let _layoutSaveTimer = null;
export function scheduleSave() {
  if (_restoring || _layoutSaveTimer) return;
  _layoutSaveTimer = setTimeout(() => { _layoutSaveTimer = null; saveLayout(); }, 500);
}
// Flush pending saves on page close
window.addEventListener('beforeunload', () => {
  if (_layoutSaveTimer) { clearTimeout(_layoutSaveTimer); _layoutSaveTimer = null; saveLayout(); }
});

// ── Draggable UI Panels (mouse + touch) ──
export function makeDraggable(el, handleSelector, moteColor) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  let dx = 0, dy = 0, isDragging = false;
  handle.style.cursor = 'grab';

  function startDrag(cx, cy) {
    isDragging = true;
    const rect = el.getBoundingClientRect();
    dx = cx - rect.left;
    dy = cy - rect.top;
    handle.style.cursor = 'grabbing';
    el.style.transition = 'none';
  }
  function moveDrag(cx, cy) {
    if (!isDragging) return;
    el.style.left = (cx - dx) + 'px';
    el.style.top = (cy - dy) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    if (Math.random() < 0.4) {
      spawnMote(cx + (Math.random()-0.5)*20, cy + (Math.random()-0.5)*20, moteColor);
    }
  }
  function endDrag() {
    if (isDragging) {
      isDragging = false;
      handle.style.cursor = 'grab';
      scheduleSave();
    }
  }

  const _skipDrag = t => t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.closest('button');

  // Mouse — attach move/up only while dragging
  handle.addEventListener('mousedown', e => {
    if (_skipDrag(e.target)) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
    const onMove = ev => moveDrag(ev.clientX, ev.clientY);
    const onUp = () => { endDrag(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Touch — attach move/end only while dragging
  handle.addEventListener('touchstart', e => {
    if (_skipDrag(e.target)) return;
    if (e.touches.length !== 1) return;
    e.preventDefault();
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
    const onMove = ev => { if (ev.touches.length) moveDrag(ev.touches[0].clientX, ev.touches[0].clientY); };
    const onEnd = () => { endDrag(); window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
  }, { passive: false });
}

// ── Magic Panel Resizing ──
export function makeResizable(el, moteColor) {
  if (!el) return;
  // Create resize handle (bottom-right corner grip)
  const grip = document.createElement('div');
  grip.className = 'panel-resize-grip';
  grip.textContent = '\u25E2'; // triangle character
  el.appendChild(grip);

  let isResizing = false, startX, startY, startW, startH;

  function startResize(cx, cy, e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    startX = cx;
    startY = cy;
    const rect = el.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    el.style.transition = 'none';
    grip.classList.add('active');
    document.body.style.userSelect = 'none';
  }
  function doResize(cx, cy) {
    if (!isResizing) return;
    const w = Math.max(140, startW + (cx - startX));
    const h = Math.max(80, startH + (cy - startY));
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
    el.style.maxHeight = 'none';
    // Sparkle trail on edge
    if (moteColor && Math.random() < 0.35) {
      spawnMote(cx + (Math.random() - 0.5) * 12, cy + (Math.random() - 0.5) * 12, moteColor);
    }
  }
  function endResize() {
    if (!isResizing) return;
    isResizing = false;
    grip.classList.remove('active');
    document.body.style.userSelect = '';
    scheduleSave();
    // Trigger re-arrange if in auto mode
    if (_panelMode === 'auto') {
      clearTimeout(_autoLayoutTimer);
      _autoLayoutTimer = setTimeout(autoArrangePanels, 300);
    }
  }

  // Mouse
  grip.addEventListener('mousedown', e => startResize(e.clientX, e.clientY, e));
  window.addEventListener('mousemove', e => doResize(e.clientX, e.clientY));
  window.addEventListener('mouseup', endResize);
  // Touch
  grip.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startResize(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!isResizing || !e.touches.length) return;
    doResize(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', endResize, { passive: true });
}

// Make all fixed panels draggable with magic motes
makeDraggable(document.getElementById('realm-panel'), '.panel-header', [240,216,144]);
makeDraggable(document.getElementById('legend'), '.panel-header', [100,180,255]);
makeDraggable(document.getElementById('spellbook'), '.panel-header', [192,160,255]);
makeDraggable(document.getElementById('quest-log'), '#quest-log-header', [160,255,96]);
makeDraggable(document.getElementById('realm-codex'), '#codex-header', [144,96,192]);
makeDraggable(document.getElementById('cartographer'), '.panel-header', [192,144,96]);
makeDraggable(document.getElementById('energy-panel'), '.panel-header', [96,192,96]);
makeDraggable(document.getElementById('persona-editor'), '.pe-header', [240,200,100]);
makeDraggable(document.getElementById('node-list'), '#node-list-header', [192,144,96]);
makeDraggable(document.getElementById('latency-panel'), '.panel-header', [100,180,255]);
makeDraggable(document.getElementById('firewall-panel'), '.panel-header', [220,160,80]);
makeDraggable(document.getElementById('wifi-panel'), '.panel-header', [100,200,255]);
makeDraggable(document.getElementById('scanner-panel'), '.panel-header', [220,180,80]);

// Make all panels resizable with magical grip handles
makeResizable(document.getElementById('realm-panel'), [240,216,144]);
makeResizable(document.getElementById('legend'), [100,180,255]);
makeResizable(document.getElementById('spellbook'), [192,160,255]);
makeResizable(document.getElementById('quest-log'), [160,255,96]);
makeResizable(document.getElementById('realm-codex'), [144,96,192]);
makeResizable(document.getElementById('cartographer'), [192,144,96]);
makeResizable(document.getElementById('energy-panel'), [96,192,96]);
makeResizable(document.getElementById('node-list'), [192,144,96]);
makeResizable(document.getElementById('latency-panel'), [100,180,255]);
makeResizable(document.getElementById('firewall-panel'), [220,160,80]);
makeResizable(document.getElementById('wifi-panel'), [100,200,255]);
makeResizable(document.getElementById('scanner-panel'), [220,180,80]);
makeResizable(document.getElementById('debug-panel'), [120,80,200]);
makeResizable(document.getElementById('persona-editor'), [240,200,100]);

// Restore saved layout on load (panel seal state managed by panel-manager.js)
restoreLayout();
// Always restore settings (sliders, toggles, collapsed sections) independently
restoreSettings();
