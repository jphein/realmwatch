// ── Main application module (terrain, UI, events, navigation, panels, effects, persistence) ──
// Imports from extracted modules
import { WORLD_W, WORLD_H, _mapTilt, setMapTilt, SSE_URL } from './config.js';
import { scaleLabel, scaleColor, scalePct } from './utils.js';
import { tips, _topology, isTS, _tsHostMap, _vlanLabels, _nodeDOM, getNodeDOM, getNodeCenter, updateLinePositions, refreshTopology, setTopologyRefreshHook } from './topology.js';
import { saveFormation, registerPanel } from './panel-manager.js';
import { initScanner } from './scan.js';
import { generateTerrain, updateRegionLabels, renderTopoLayer, setLastTopoCollectd, invalidateTopoNodeMap, forceTopoRender, getTopoNodeMap, initTopoControls, initBiomeSliders } from './terrain.js';
import { getNodeTraffic, updateConnectionTraffic, updateConnectionTrafficSSE, trafficToCollectd, setTrafficScale } from './traffic.js';
import { DOM, updateGauges, setLatencyMap, setLatencyFlat, setWifiMap, getLatencyFlat, getWifiMap,
         updateEnergyPanel, updateLatencyPanel, updateFirewallPanel, handleFirewallData, renderWifiPanel,
         updateCensusSubLabels, updateNodeListStatus, rebuildCensusIfNeeded } from './panels.js';
import { updateUI, updateCoreSublabels, updateHASublabels, updateTooltips, updateInfraNodes,
         applyMasterScale, getLastStatus, findStatusKey, setPostUpdateHook,
         getSliderRefs, setMasterScale, getMasterScale } from './node-status.js';
import { spawnMote, getFpsEl } from './effects.js';
import { renderEvent, addLogEntry, showSpeechBubble, updateBubblePositions, firePulse, showOffline,
         setOpenNodeChat, getActiveTab, getLastEventTs } from './quest-log.js';
import { scale, panX, panY, applyTransform,
         setViewport, isZoomActive, fitToNodes,
         setDeferredStatus, setDeferredTraffic, setDeferredEnergy, setDeferredLatency,
         setGhostDirty, applyTopoZ, setOpenPersonaEditor } from './map-view.js';
import { openPersonaEditor, getCurrentEditNode, switchToTab, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { getSpellPage, showSpellPage, initSpellbook, invalidateSearchIndex } from './spellbook.js';

// (updateUI, sublabels, tooltips, scale sliders moved to node-status.js)
let lastStatus = null;  // Local mirror — kept in sync via post-update hook
let liveOk = false;
let _dbgRefreshTimer = null;

// Register post-update hook for firePulse + debug refresh + periodic log
setPostUpdateHook((d) => {
  lastStatus = d;
  firePulse();
  clearTimeout(_dbgRefreshTimer);
  _dbgRefreshTimer = setTimeout(_dbgRefresh, 200);
});

// Wire up openNodeChat for quest-log.js (async function declaration — hoisted)
setOpenNodeChat(openNodeChat);
// Wire up openPersonaEditor for map-view.js node double-tap
setOpenPersonaEditor(openPersonaEditor);
// Wire up spellbook.js with save callbacks (function declarations — hoisted)
initSpellbook({ saveSettings, scheduleSave });

// ── Traffic scale slider ──
const trafficSlider = document.getElementById('traffic-scale-slider');
const trafficScaleVal = document.getElementById('traffic-scale-val');
trafficSlider.addEventListener('input', () => {
  const v = parseFloat(trafficSlider.value);
  setTrafficScale(v);
  trafficScaleVal.textContent = v.toFixed(1) + 'x';
  if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
  else { const _ls = getLastStatus(); if (_ls && _ls.collectd) updateConnectionTraffic(_ls.collectd); }
  scheduleSave();
});

// (Node, text, bubble, update-speed sliders moved to node-status.js)
initTopoControls({ saveSettings, scheduleSave, applyTopoZ });

// ── Arcane Grid Controls ──
const _gridSvg = document.getElementById('arcane-grid');
const _gridContent = document.getElementById('arcane-grid-content');
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
    if (hueVal) hueVal.textContent = _gridHue + '°';
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
      if (hueVal) hueVal.textContent = _gridHue + '°';
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
    // Cap max sparkles for performance
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

  // Wire layer toggles
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

  // Wire spellbook sliders
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
      // Sync UI
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

  // Apply initial state
  applyCompass(); applySparkles(); applyVignette(); applyGlow();
})();

// Register hook so topology refresh updates bubbles, search index, ghost lines
setTopologyRefreshHook(() => {
  updateBubblePositions();
  invalidateSearchIndex();
  setGhostDirty();
});

// (Pan & zoom, ghost ley-lines, zoom mode, vines, touch, draggable nodes moved to map-view.js)
// (Persona editor, tabs, node properties, stats pane moved to persona-editor.js)

// Wire up tab renderers for persona-editor.js (imported from node-controls.js)
setTabRenderers({
  renderControlPane,
  renderGroupPane,
  renderShellPane,
  renderConnectionsPane,
  focusShellInput,
});

// (Control tab, group tab, connections pane, shell pane, node click/dblclick moved to node-controls.js)

// (Spellbook page navigation, presets, section resets, effects controls, realm search moved to spellbook.js)

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

// ── Visibility Toggles ──
(function wireVisibilityToggles() {
  // [checkboxId, singleSelector, multiSelector]
  const toggles = [
    // Map layers
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
    // Panels
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
    // Decorations
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
          // Clean up seal rune if panel was sealed
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
      if (!_restoring) saveFormation();  // sync panel-manager so hidden panels stay hidden on reload
      // Mark ghost canvas dirty so zoom bitmap refreshes
      setGhostDirty();
    });
  }

  // Wire up panel mode buttons (logic at module scope below)
  document.querySelectorAll('.panel-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setPanelMode(btn.dataset.mode));
  });

  // Sealed dock controls
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
      if (dock) dock.style.opacity = v;
      saveSettings();
    });
  }
  if (dockScSlider) {
    dockScSlider.addEventListener('input', () => {
      const v = parseFloat(dockScSlider.value);
      if (dockScVal) dockScVal.textContent = v.toFixed(2);
      document.querySelectorAll('.sealed-rune').forEach(r => {
        r.style.transform = `scale(${v})`;
      });
      // Store for newly created runes
      window._dockRuneScale = v;
      saveSettings();
    });
  }
  if (dockBgSlider) {
    dockBgSlider.addEventListener('input', () => {
      const v = parseFloat(dockBgSlider.value);
      if (dockBgVal) dockBgVal.textContent = v.toFixed(2);
      const dock = document.getElementById('sealed-dock');
      if (dock) {
        // Adjust just the background opacity via a CSS custom property
        dock.style.setProperty('--dock-bg-opacity', v);
      }
      saveSettings();
    });
  }

  const dockHueSlider = document.getElementById('dock-hue-slider');
  const dockHueVal = document.getElementById('dock-hue-val');
  if (dockHueSlider) {
    dockHueSlider.addEventListener('input', () => {
      const v = parseInt(dockHueSlider.value);
      if (dockHueVal) dockHueVal.textContent = v + '°';
      document.documentElement.style.setProperty('--dock-hue', v + 'deg');
      saveSettings();
    });
  }

  // Emoji icons toggle
  const emojiCb = document.getElementById('dock-emoji-icons');
  if (emojiCb) {
    emojiCb.checked = localStorage.getItem('realm-emoji-icons') === 'true';
    emojiCb.addEventListener('change', () => {
      window.setEmojiIcons?.(emojiCb.checked);
      saveSettings();
    });
  }

  // Rune labels toggle — always show labels under dock icons
  const runeLabelCb = document.getElementById('dock-rune-labels');
  if (runeLabelCb) {
    runeLabelCb.addEventListener('change', () => {
      document.getElementById('sealed-dock')?.classList.toggle('show-rune-labels', runeLabelCb.checked);
      saveSettings();
    });
  }

  // FPS counter toggle
  const fpsCb = document.getElementById('vis-fps-counter');
  if (fpsCb) {
    fpsCb.addEventListener('change', () => {
      getFpsEl().style.display = fpsCb.checked ? '' : 'none';
      saveSettings();
    });
  }

  // Loading screen vines toggle
  const loadVinesCb = document.getElementById('vis-loading-vines');
  if (loadVinesCb) {
    loadVinesCb.addEventListener('change', () => {
      document.querySelectorAll('.rl-vines').forEach(el => {
        el.style.display = loadVinesCb.checked ? '' : 'none';
      });
      saveSettings();
    });
  }

  // Replay loading screen button
  const replayBtn = document.getElementById('replay-loading-btn');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      const loadEl = document.getElementById('realm-loading');
      if (!loadEl) return;
      // Reset to stage 0
      loadEl.dataset.stage = '0';
      const arc = loadEl.querySelector('.rl-progress-arc');
      if (arc) arc.style.strokeDashoffset = '1099.56';
      loadEl.querySelectorAll('.rl-stage-mark').forEach(m => m.classList.remove('lit'));
      loadEl.querySelector('.rl-sparks').innerHTML = '';
      const stageText = loadEl.querySelector('.rl-stage-text');
      if (stageText) stageText.textContent = 'Igniting the arcane sigil';
      loadEl.style.display = '';
      loadEl.classList.remove('dismissed');
      // Re-trigger vine trace animations by cloning paths
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
      // Replay stages with timing
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

  // Layer opacity sliders: [sliderId, target selector or multi-selector, isMulti]
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
    // Panel opacity sliders
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
})();

// ── Layout persistence (localStorage) ──
// ── SSE Connection (replaces poll + pollEvents + refreshTopology + fetchEnergy) ──
let _sseTrafficMap = null;
let _sseConnected = false;

(function initSSE() {
  const sse = new EventSource(SSE_URL);
  let _sseRestoreMode = true;

  // ── Stream attunement tracker (lights up loading screen indicators) ──
  function _attuneStream(name) {
    const el = document.querySelector(`.rl-stream[data-stream="${name}"]`);
    if (el && !el.classList.contains('attuned')) el.classList.add('attuned');
  }

  let _trafficRafPending = false;
  sse.addEventListener('traffic', e => {
    _attuneStream('traffic');
    _sseTrafficMap = JSON.parse(e.data);
    // Defer DOM-heavy traffic updates during zoom — flush on exit
    if (isZoomActive()) { setDeferredTraffic(_sseTrafficMap); return; }
    if (!_trafficRafPending) {
      _trafficRafPending = true;
      requestAnimationFrame(() => {
        _trafficRafPending = false;
        if (isZoomActive()) { setDeferredTraffic(_sseTrafficMap); return; }
        updateConnectionTrafficSSE(_sseTrafficMap);
        const fakeCollectd = trafficToCollectd(_sseTrafficMap);
        setLastTopoCollectd(fakeCollectd);
        renderTopoLayer(fakeCollectd);
      });
    }
  });

  sse.addEventListener('realm-event', e => {
    _attuneStream('events');
    const evt = JSON.parse(e.data);
    renderEvent(evt, _sseRestoreMode);
  });

  sse.addEventListener('topology', e => {
    _attuneStream('topology');
    refreshTopology();
    rebuildCensusIfNeeded();
  });

  sse.addEventListener('status', e => {
    _attuneStream('status');
    const d = JSON.parse(e.data);
    _sseRestoreMode = false;
    // Defer all DOM updates during zoom — just stash the latest data
    // (but never defer the first-connect that dismisses the loading screen)
    if (isZoomActive() && liveOk) { setDeferredStatus(d); if (d.wifi) setWifiMap(d.wifi); return; }
    updateUI(d);
    if (d.wifi) setWifiMap(d.wifi);
    if (!liveOk) {
      liveOk = true;
      console.log('Realm Map: SSE live data connected');
      // Stage 4: connected — hold for a beat, then dismiss
      if (window._advanceLoadStage) window._advanceLoadStage(4);
      const loadEl = document.getElementById('realm-loading');
      if (loadEl && !loadEl.classList.contains('dismissed')) {
        setTimeout(() => {
          loadEl.classList.add('dismissed');
          // Kill loading screen entirely after fade (1.2s transition) — stops 15 animations from burning GPU
          setTimeout(() => { loadEl.style.display = 'none'; }, 1300);
        }, 1200);
      }
    }
  });

  sse.addEventListener('energy', e => {
    _attuneStream('energy');
    const data = JSON.parse(e.data);
    if (isZoomActive()) { setDeferredEnergy(data); return; }
    updateEnergyPanel(data);
  });

  sse.addEventListener('latency', e => {
    _attuneStream('latency');
    const parsed = JSON.parse(e.data);
    setLatencyMap(parsed);
    // Extract flat map for layout worker (Cartographer modes)
    if (parsed.groups) {
      const flat = {};
      for (const g of parsed.groups) for (const entry of g.entries) flat[entry.id] = entry.rtt;
      setLatencyFlat(flat);
    } else {
      setLatencyFlat(parsed);
    }
    if (isZoomActive()) { setDeferredLatency(true); return; }
    updateLatencyPanel();
  });

  sse.addEventListener('firewall', e => {
    _attuneStream('firewall');
    const d = JSON.parse(e.data);
    handleFirewallData(d);
  });

  sse.addEventListener('wifi', e => {
    const data = JSON.parse(e.data);
    if (data && Object.keys(data).length) renderWifiPanel(data);
  });

  sse.addEventListener('open', () => {
    if (!_sseConnected) {
      _sseConnected = true;
      _sseRestoreMode = true;
      console.log('Realm Map: SSE connected');
    }
  });

  sse.addEventListener('error', () => {
    if (_sseConnected) {
      _sseConnected = false;
      console.warn('Realm Map: SSE disconnected, reconnecting...');
      showOffline();
    }
  });
})();

const LAYOUT_KEY = 'realm-map-layout-v2';
const SETTINGS_KEY = 'realm-map-settings-v3';

// ── Panel Layout Modes (module-scope for persistence access) ──
const _PANEL_IDS = ['realm-panel','legend','spellbook','quest-log','realm-codex','node-list',
  'energy-panel','latency-panel','firewall-panel','wifi-panel','cartographer','debug-panel','scanner-panel'];
const _MODE_DESCS = {
  manual: 'Panels stay where you place them.',
  auto: 'Panels auto-size and tile to fill the viewport beautifully.',
  focus: 'Unfocused panels fade. Hover to summon.',
};
let _panelMode = 'manual';

function setPanelMode(mode) {
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

  // Final weight: importance × content need × focus
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
export function saveSettings() {
  if (_restoring) return;
  _initialRestoreDone = true;  // user interacted, don't let async restore override
  const vp = document.getElementById('map-viewport');
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

let _restoring = false;
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

let _initialRestoreDone = false;
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
  grip.innerHTML = '&#9698;'; // ◢ triangle
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

initScanner();
makeResizable(document.getElementById('persona-editor'), [240,200,100]);


// Restore saved layout on load (panel seal state managed by panel-manager.js)
restoreLayout();
// Always restore settings (sliders, toggles, collapsed sections) independently
restoreSettings();

// Zoom/pan is now saved by wheel, mouseup, and touchend handlers above

// (Node Chat Dialog moved to node-controls.js)

// ── Arcane Config (external service settings) ──
const _cfgFields = {
  'cfg-chat-model': { path: 'chat.deployment', also: 'chat.model' },
  'cfg-reasoning': { path: 'chat.reasoning_effort' },
  'cfg-max-tokens': { path: 'chat.max_completion_tokens', type: 'number' },
  'cfg-multi-timeout': { path: 'chat.multi_chat_timeout', type: 'number' },
  'cfg-voice': { path: 'speech.voice' },
  'cfg-silence': { path: 'speech.silence_timeout', type: 'number' },
  'cfg-subtitles': { path: 'speech.live_subtitles', type: 'checkbox' },
  'cfg-oracle-model': { path: 'oracle.model' },
  'cfg-oracle-reasoning': { path: 'oracle.reasoning_effort' },
  'cfg-oracle-voice': { path: 'oracle.voice' },
};

function _getPath(obj, path) {
  const parts = path.split('.');
  let v = obj;
  for (const p of parts) { v = v?.[p]; }
  return v;
}

async function loadArcaneConfig() {
  try {
    const r = await fetch('/config');
    if (!r.ok) return;
    const cfg = await r.json();
    for (const [id, spec] of Object.entries(_cfgFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const val = _getPath(cfg, spec.path);
      if (val == null) continue;
      if (spec.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    }
  } catch (e) { /* config endpoint may not be available yet */ }
}

function _saveArcaneConfig() {
  const update = { chat: {}, speech: {}, oracle: {} };
  for (const [id, spec] of Object.entries(_cfgFields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const [section, key] = spec.path.split('.');
    let val;
    if (spec.type === 'checkbox') val = el.checked;
    else if (spec.type === 'number') val = parseFloat(el.value);
    else val = el.value;
    update[section][key] = val;
    if (spec.also) {
      const [s2, k2] = spec.also.split('.');
      update[s2][k2] = val;
    }
  }
  const statusEl = document.getElementById('cfg-status');
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }).then(r => {
    if (statusEl) {
      statusEl.textContent = r.ok ? 'Config saved \u2714' : 'Save failed';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  }).catch(() => {
    if (statusEl) statusEl.textContent = 'Save failed';
  });
}

const _cfgSaveBtn = document.getElementById('cfg-save-btn');
if (_cfgSaveBtn) _cfgSaveBtn.addEventListener('click', _saveArcaneConfig);
loadArcaneConfig();

// ── Herald Controls ──
const _heraldStatus = document.getElementById('herald-status');
function _heraldAction(action) {
  const interval = document.getElementById('cfg-herald-interval')?.value || 90;
  const url = `/herald?action=${action}&interval=${interval}`;
  if (_heraldStatus) _heraldStatus.textContent = `${action}...`;
  fetch(url).then(r => r.json()).then(d => {
    if (_heraldStatus) {
      if (d.error) _heraldStatus.textContent = d.error;
      else if (d.pid) _heraldStatus.textContent = `Running (PID ${d.pid}, ${d.interval}s)`;
      else if (d.stopped) _heraldStatus.textContent = 'Stopped';
      else if (d.output) _heraldStatus.textContent = 'Round complete';
      else if (d.running) _heraldStatus.textContent = `Running (PIDs: ${d.pids.join(',')})`;
      else _heraldStatus.textContent = 'Not running';
    }
  }).catch(() => { if (_heraldStatus) _heraldStatus.textContent = 'Error'; });
}
document.getElementById('herald-start-btn')?.addEventListener('click', () => _heraldAction('start'));
document.getElementById('herald-stop-btn')?.addEventListener('click', () => _heraldAction('stop'));
document.getElementById('herald-once-btn')?.addEventListener('click', () => _heraldAction('once'));
// Check herald status on load
_heraldAction('status');

// ── Arcane Mirror (Debug Panel) ──
const _dbgPanel = document.getElementById('debug-panel');
const _dbgBody = document.getElementById('debug-body');
const _dbgSearch = document.getElementById('debug-search');
const _dbgSseStatus = document.getElementById('debug-poll-count');
let _dbgTab = 'all';
let _dbgDbInfo = null;

// Close button
document.getElementById('debug-close')?.addEventListener('click', () => {
  const cb = document.getElementById('vis-debug');
  if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
});

// Tab switching
document.querySelectorAll('.debug-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _dbgTab = tab.dataset.dtab;
    _dbgRefresh();
  });
});

// Filter
_dbgSearch?.addEventListener('input', () => _dbgRefresh());

// Drag header to reposition (mouse + touch)
{
  const hdr = document.getElementById('debug-header');
  let offX = 0, offY = 0, dragging = false;
  function startDrag(cx, cy) {
    const r = _dbgPanel.getBoundingClientRect();
    offX = cx - r.left; offY = cy - r.top;
    dragging = true;
  }
  function moveDrag(cx, cy) {
    if (!dragging) return;
    _dbgPanel.style.left = (cx - offX) + 'px';
    _dbgPanel.style.top = (cy - offY) + 'px';
    _dbgPanel.style.bottom = 'auto';
    _dbgPanel.style.right = 'auto';
  }
  function endDrag() { dragging = false; }
  hdr?.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault(); startDrag(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  document.addEventListener('mouseup', endDrag);
  hdr?.addEventListener('touchstart', e => {
    if (e.target.tagName === 'BUTTON' || e.touches.length !== 1) return;
    e.preventDefault(); startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (dragging && e.touches.length) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchend', endDrag);
}

function _dbgSection(title, id, content, collapsed = false) {
  return `<div class="dbg-section${collapsed ? ' collapsed' : ''}" data-dbg="${id}">
    <div class="dbg-section-title">${title}</div>
    <div class="dbg-section-body">${content}</div></div>`;
}

function _dbgKV(k, v, cls = '') {
  const vc = typeof v === 'number' ? (v === 0 ? 'dim' : '') : cls;
  return `<div class="dbg-kv"><span class="dbg-k">${k}</span><span class="dbg-v ${vc}">${_escH(String(v))}</span></div>`;
}

function _escH(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _dbgTree(obj, depth = 0, filter = '') {
  if (obj === null || obj === undefined) return '<span class="dbg-v dim">null</span>';
  if (typeof obj !== 'object') return `<span class="dbg-v">${_escH(String(obj))}</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="dbg-v dim">[]</span>';
    if (depth > 2) return `<span class="dbg-v dim">[${obj.length} items]</span>`;
    return obj.slice(0, 20).map((v, i) =>
      `<div class="dbg-kv"><span class="dbg-k">[${i}]</span>${_dbgTree(v, depth+1, filter)}</div>`
    ).join('') + (obj.length > 20 ? `<div class="dbg-v dim">...+${obj.length - 20} more</div>` : '');
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return '<span class="dbg-v dim">{}</span>';
  const filtered = filter
    ? entries.filter(([k, v]) => {
        const s = k + ' ' + JSON.stringify(v);
        return s.toLowerCase().includes(filter);
      })
    : entries;
  if (depth > 2) return `<span class="dbg-v dim">{${filtered.length} keys}</span>`;
  return `<div class="dbg-tree">${filtered.map(([k, v]) =>
    `<div class="dbg-kv"><span class="dbg-k">${_escH(k)}</span>${_dbgTree(v, depth+1, filter)}</div>`
  ).join('')}</div>`;
}

function _dbgRefresh() {
  if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
  const d = lastStatus;
  const filter = (_dbgSearch?.value || '').toLowerCase().trim();
  const tab = _dbgTab;
  let html = '';

  if (_dbgSseStatus) _dbgSseStatus.textContent = _sseConnected ? 'sse:live' : 'sse:off';

  // Status overview
  if (tab === 'all' || tab === 'status') {
    const s = d ? {
      realm_scale: d.realm_scale, forge_cpu: d.forge?.usage, mana_mem: d.mana?.usage,
      gpu: d.gpu?.usage, uptime: d.adult?.uptime, load: d.adult?.load1,
      host: d.host?.hostname, sse: _sseConnected ? 'live' : 'off',
    } : { status: 'no data yet' };
    html += _dbgSection('Status', 'status', _dbgTree(s, 0, filter));
  }

  // Collectd
  if ((tab === 'all' || tab === 'collectd') && d?.collectd) {
    const hosts = Object.keys(d.collectd).length;
    let body = _dbgKV('hosts', hosts);
    body += _dbgTree(d.collectd, 0, filter);
    html += _dbgSection(`Collectd (${hosts} hosts)`, 'collectd', body, tab === 'all');
  }

  // WiFi
  if ((tab === 'all' || tab === 'wifi') && d?.wifi) {
    const clients = Object.keys(d.wifi).length;
    let body = _dbgKV('clients', clients);
    body += _dbgTree(d.wifi, 0, filter);
    html += _dbgSection(`WiFi (${clients} clients)`, 'wifi', body, tab === 'all');
  }

  // HA
  if ((tab === 'all' || tab === 'ha') && d?.ha) {
    const ents = Object.keys(d.ha).length;
    let body = _dbgKV('entities', ents);
    body += _dbgTree(d.ha, 0, filter);
    html += _dbgSection(`Home Assistant (${ents})`, 'ha', body, tab === 'all');
  }

  // Tailscale
  if ((tab === 'all' || tab === 'tailscale') && d?.tailscale) {
    const ts = d.tailscale;
    let body = _dbgKV('online', ts.online?.length || 0, 'ok');
    body += _dbgKV('offline', ts.offline?.length || 0, ts.offline?.length ? 'warn' : '');
    body += _dbgTree(ts, 0, filter);
    html += _dbgSection('Tailscale', 'tailscale', body, tab === 'all');
  }

  // Topology
  if (tab === 'all' || tab === 'topology') {
    const t = _topology || {};
    let body = _dbgKV('nodes', t.nodes?.length || 0);
    body += _dbgKV('connections', t.connections?.length || 0);
    body += _dbgKV('regions', t.regions?.length || 0);
    if (tab === 'topology') {
      // Show node types breakdown
      const types = {};
      (t.nodes || []).forEach(n => { types[n.type || 'unknown'] = (types[n.type || 'unknown'] || 0) + 1; });
      body += _dbgKV('types', JSON.stringify(types));
      // Show online/offline
      if (d?.tailscale) {
        const online = new Set([...(d.tailscale.online || [])]);
        const onlineNodes = (t.nodes || []).filter(n => n.online !== false).length;
        body += _dbgKV('online nodes', onlineNodes, 'ok');
      }
      body += _dbgTree(t, 0, filter);
    }
    html += _dbgSection('Topology', 'topology', body, tab === 'all');
  }

  // Events
  if (tab === 'all' || tab === 'events') {
    const logBody = document.getElementById('quest-log-body');
    const count = logBody ? logBody.children.length : 0;
    let body = _dbgKV('log entries', count);
    body += _dbgKV('last event ts', getLastEventTs() ? new Date(getLastEventTs() * 1000).toLocaleTimeString() : 'none');
    body += _dbgKV('delivery', 'SSE (real-time)');
    html += _dbgSection(`Events (${count})`, 'events', body);
  }

  // DB / Settings
  if (tab === 'all' || tab === 'db') {
    let body = '';
    if (_dbgDbInfo) {
      body += _dbgKV('db size', (_dbgDbInfo.db_size / 1024).toFixed(0) + ' KB');
      body += _dbgKV('notion synced', _dbgDbInfo.notion_synced);
      body += _dbgKV('wifi scan', _dbgDbInfo.wifi_scan_ts ? new Date(_dbgDbInfo.wifi_scan_ts * 1000).toLocaleTimeString() : 'none');
      body += _dbgKV('namespaces', (_dbgDbInfo.settings_ns || []).join(', '));
      if (_dbgDbInfo.tables) body += _dbgTree(_dbgDbInfo.tables, 0, filter);
    } else {
      body += _dbgKV('loading...', '');
    }
    const ls = localStorage.getItem('realm-map-settings');
    if (ls) {
      try {
        const s = JSON.parse(ls);
        body += _dbgKV('local sliders', Object.keys(s.sliders || {}).length);
        body += _dbgKV('local cbs', Object.keys(s.checkboxes || {}).length);
        if (tab === 'db') body += _dbgTree(s, 0, filter);
      } catch (e) { body += _dbgKV('localStorage', 'parse error', 'err'); }
    }
    html += _dbgSection('DB / Settings', 'db', body, tab === 'all');
  }

  _dbgBody.innerHTML = html;

  // Collapse toggle for sections
  _dbgBody.querySelectorAll('.dbg-section-title').forEach(el => {
    el.addEventListener('click', () => {
      el.parentElement.classList.toggle('collapsed');
    });
  });

  // Highlight filter matches
  if (filter) {
    const re = new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    _dbgBody.querySelectorAll('.dbg-v, .dbg-k').forEach(el => {
      if (el.querySelector('*')) return; // skip containers
      const t = el.textContent;
      if (re.test(t)) {
        el.innerHTML = t.replace(re, '<span class="dbg-highlight">$1</span>');
      }
    });
  }
}

// Fetch DB stats periodically when visible
function _dbgFetchDb() {
  if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
  fetch('/debug').then(r => r.json()).then(d => { _dbgDbInfo = d; }).catch(() => {});
}

// Auto-refresh when panel becomes visible
new MutationObserver(() => {
  if (_dbgPanel && _dbgPanel.style.display !== 'none') { _dbgFetchDb(); _dbgRefresh(); }
}).observe(_dbgPanel, { attributes: true, attributeFilter: ['style'] });
// Refresh DB stats every 30s while visible (only when panel is shown)
setInterval(() => {
  if (_dbgPanel && _dbgPanel.style.display !== 'none') _dbgFetchDb();
}, 30000);

// ═══════════════════════════════════════════════════════════
// ARCANE GRIMOIRE — spell catalogue of endpoints, tools, scripts
// ═══════════════════════════════════════════════════════════

const _agPanel = document.getElementById('arcane-grimoire');
if (_agPanel) {
  registerPanel(_agPanel);
  makeDraggable(_agPanel, '.panel-header', [240,200,100]);
  makeResizable(_agPanel, [240,200,100]);

  const _acEndpoints = [
    { method:'GET', path:'/status', desc:'Full realm status', params:[] },
    { method:'GET', path:'/topology', desc:'Nodes, connections, regions', params:[] },
    { method:'GET', path:'/latency', desc:'fping latency per node', params:[] },
    { method:'GET', path:'/firewall', desc:'nftables rules (60s cache)', params:[] },
    { method:'GET', path:'/energy', desc:'Solar, battery, grid, load', params:[] },
    { method:'GET', path:'/events', desc:'Map events', params:[{name:'since',type:'text',placeholder:'timestamp'},{name:'limit',type:'text',placeholder:'50'}] },
    { method:'GET', path:'/quests', desc:'Active quest log', params:[] },
    { method:'GET', path:'/personas', desc:'All node personas', params:[] },
    { method:'GET', path:'/config', desc:'Chat/speech/oracle config', params:[] },
    { method:'GET', path:'/settings', desc:'UI layout settings', params:[] },
    { method:'GET', path:'/scan/status', desc:'Last WiFi scan results', params:[] },
    { method:'GET', path:'/scan/wifi', desc:'WiFi signal per AP', params:[] },
    { method:'GET', path:'/codex-sync', desc:'Notion lore database', params:[{name:'force',type:'checkbox',label:'Force refresh'}] },
    { method:'GET', path:'/chat/sessions', desc:'Chat session list', params:[] },
    { method:'GET', path:'/chat/history', desc:'Chat history', params:[{name:'session',type:'text',placeholder:'session name'}] },
    { method:'GET', path:'/collectd', desc:'All collectd RRD summaries', params:[{name:'host',type:'text',placeholder:'hostname (optional)'}] },
    { method:'GET', path:'/observation', desc:'Fantasy narration + status', params:[] },
    { method:'GET', path:'/herald', desc:'Herald daemon control', params:[{name:'action',type:'select',options:['status','start','stop','once']},{name:'interval',type:'text',placeholder:'90'}] },
    { method:'GET', path:'/debug', desc:'DB stats & diagnostics', params:[] },
    { method:'SSE', path:'/sse', desc:'Live event stream', params:[] },
    { method:'POST', path:'/event', desc:'Push map event', params:[{name:'type',type:'select',options:['speech','alert','quest','highlight']},{name:'node',type:'text',placeholder:'node id'},{name:'text',type:'textarea',placeholder:'Event text'}] },
    { method:'POST', path:'/chat', desc:'Send chat message', params:[{name:'message',type:'textarea',placeholder:'Message'},{name:'node',type:'text',placeholder:'node id'},{name:'session',type:'text',placeholder:'session'}] },
    { method:'POST', path:'/exec', desc:'Run local command', params:[{name:'command',type:'text',placeholder:'bash command'}] },
    { method:'POST', path:'/ssh', desc:'SSH to topology host', params:[{name:'host',type:'text',placeholder:'hostname'},{name:'command',type:'text',placeholder:'command'}] },
    { method:'POST', path:'/node', desc:'Add/update topology node', params:[{name:'id',type:'text',placeholder:'node id'},{name:'x',type:'text',placeholder:'x'},{name:'y',type:'text',placeholder:'y'}] },
    { method:'POST', path:'/wol', desc:'Wake-on-LAN', params:[{name:'mac',type:'text',placeholder:'AA:BB:CC:DD:EE:FF'},{name:'ip',type:'text',placeholder:'broadcast IP'}] },
    { method:'POST', path:'/personas', desc:'Update persona', params:[{name:'node',type:'text',placeholder:'node id'},{name:'name',type:'text',placeholder:'persona name'}] },
    { method:'POST', path:'/scan', desc:'Trigger WiFi scan', params:[] },
    { method:'DELETE', path:'/settings', desc:'Clear UI settings', params:[] },
  ];

  function _acBuildForm(params) {
    if (!params || !params.length) return '';
    let html = '';
    for (const p of params) {
      if (p.type === 'textarea') {
        html += `<label>${p.name}</label><textarea data-param="${p.name}" placeholder="${p.placeholder || ''}"></textarea>`;
      } else if (p.type === 'select') {
        html += `<label>${p.name}</label><select data-param="${p.name}">${(p.options||[]).map(o => `<option value="${o}">${o}</option>`).join('')}</select>`;
      } else if (p.type === 'checkbox') {
        html += `<label><input type="checkbox" data-param="${p.name}"> ${p.label || p.name}</label>`;
      } else {
        html += `<label>${p.name}</label><input type="text" data-param="${p.name}" placeholder="${p.placeholder || ''}">`;
      }
    }
    return html;
  }

  function _acCollectParams(formEl) {
    const params = {};
    formEl.querySelectorAll('[data-param]').forEach(el => {
      const name = el.dataset.param;
      if (el.type === 'checkbox') { if (el.checked) params[name] = true; }
      else if (el.value.trim()) params[name] = el.value.trim();
    });
    return params;
  }

  // Render API endpoints
  const apiContainer = document.getElementById('ac-api');
  let apiHtml = '';
  for (const ep of _acEndpoints) {
    const mcls = 'ac-method ac-method-' + ep.method.toLowerCase();
    apiHtml += `<div class="ac-item" data-ac-type="api" data-ac-path="${ep.path}" data-ac-method="${ep.method}">`;
    apiHtml += `<div class="ac-item-header"><span class="${mcls}">${ep.method}</span><span class="ac-path">${ep.path}</span><span class="ac-desc">${ep.desc}</span></div>`;
    apiHtml += `<div class="ac-form">${_acBuildForm(ep.params)}<button class="ac-invoke-btn">Invoke</button><div class="ac-response" style="display:none"></div></div>`;
    apiHtml += `</div>`;
  }
  apiContainer.innerHTML = apiHtml;
  document.getElementById('ac-api-count').textContent = _acEndpoints.length;

  // Render scripts
  (async () => {
    const container = document.getElementById('ac-scripts');
    try {
      const r = await fetch('/scripts');
      const data = await r.json();
      let html = '';
      for (const s of data.scripts) {
        html += `<div class="ac-script"><span class="ac-script-name">${s.name}</span><span class="ac-script-desc">${s.description}</span><button class="ac-script-run" data-script="${s.path}">Forge</button></div>`;
      }
      container.innerHTML = html || '<div style="color:#605040;font-size:9px;padding:8px;font-style:italic">The forge is cold...</div>';
      document.getElementById('ac-script-count').textContent = data.scripts.length;
    } catch { container.innerHTML = '<div style="color:#805050;font-size:9px;padding:8px;font-style:italic">Failed to consult the forge</div>'; }
  })();

  // Invoke helpers
  async function _acInvokeApi(item) {
    const method = item.dataset.acMethod, path = item.dataset.acPath;
    const form = item.querySelector('.ac-form'), params = _acCollectParams(form);
    const respEl = form.querySelector('.ac-response'), btn = form.querySelector('.ac-invoke-btn');
    btn.classList.add('ac-running'); btn.textContent = 'Casting...';
    respEl.style.display = 'block'; respEl.className = 'ac-response'; respEl.textContent = 'Channeling...';
    try {
      let url = path, opts = {};
      if (method === 'GET' || method === 'SSE') {
        const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        if (qs) url += '?' + qs;
      } else if (method === 'POST') {
        opts = { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) };
      } else if (method === 'DELETE') { opts = { method: 'DELETE' }; }
      const r = await fetch(url, opts);
      const text = await r.text();
      try { respEl.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { respEl.textContent = text; }
      if (!r.ok) respEl.classList.add('ac-error');
    } catch (e) { respEl.textContent = 'Error: ' + e.message; respEl.classList.add('ac-error'); }
    btn.classList.remove('ac-running'); btn.textContent = 'Invoke';
  }

  // Event delegation for grimoire
  _agPanel.addEventListener('click', e => {
    const toggle = e.target.closest('.ag-section-toggle');
    if (toggle) { toggle.classList.toggle('open'); return; }
    const itemHeader = e.target.closest('.ac-item-header');
    if (itemHeader) { itemHeader.closest('.ac-item').classList.toggle('ac-open'); return; }
    const invokeBtn = e.target.closest('.ac-invoke-btn');
    if (invokeBtn && !invokeBtn.classList.contains('ac-running')) {
      const item = invokeBtn.closest('.ac-item');
      if (item.dataset.acType === 'api') _acInvokeApi(item);
      return;
    }
    const scriptBtn = e.target.closest('.ac-script-run');
    if (scriptBtn) {
      scriptBtn.textContent = 'Forging...';
      scriptBtn.style.pointerEvents = 'none';
      _stExec('bash ' + scriptBtn.dataset.script).then(() => {
        scriptBtn.textContent = 'Forge';
        scriptBtn.style.pointerEvents = '';
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SCRYING TERMINAL — crystal command interface
// ═══════════════════════════════════════════════════════════

const _stPanel = document.getElementById('scrying-terminal');
if (_stPanel) {
  registerPanel(_stPanel);
  makeDraggable(_stPanel, '.panel-header', [140,180,255]);
  makeResizable(_stPanel, [140,180,255]);

  const _stOutput = document.getElementById('st-output');
  const _stInput = document.getElementById('st-input');
  const _stCastBtn = document.getElementById('st-cast');
  const _stHistory = [];
  let _stHistIdx = -1;

  function _stAppend(text, cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    el.textContent = text;
    _stOutput.appendChild(el);
    _stOutput.scrollTop = _stOutput.scrollHeight;
  }

  async function _stExec(cmd) {
    _stAppend(cmd, 'st-cmd');
    _stCastBtn.classList.add('casting');
    try {
      const r = await fetch('/exec', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ command: cmd }) });
      const data = await r.json();
      if (data.output) _stAppend(data.output, 'st-result');
      if (data.error) _stAppend(data.error, 'st-error');
      if (data.exit_code !== 0 && !data.error) _stAppend(`The spell faltered (exit ${data.exit_code})`, 'st-error');
    } catch (e) {
      _stAppend('The crystal dims: ' + e.message, 'st-error');
    }
    _stCastBtn.classList.remove('casting');
  }

  function _stSubmit() {
    const cmd = _stInput.value.trim();
    if (!cmd) return;
    _stHistory.unshift(cmd);
    _stHistIdx = -1;
    _stInput.value = '';
    _stExec(cmd);
  }

  _stInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { _stSubmit(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_stHistIdx < _stHistory.length - 1) { _stHistIdx++; _stInput.value = _stHistory[_stHistIdx]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_stHistIdx > 0) { _stHistIdx--; _stInput.value = _stHistory[_stHistIdx]; }
      else { _stHistIdx = -1; _stInput.value = ''; }
    }
  });

  _stCastBtn.addEventListener('click', _stSubmit);

  _stAppend('The crystal awakens. Speak thy commands...', 'st-system');
}

