// ── Main application module (terrain, UI, events, navigation, panels, effects, persistence) ──
// Imports from extracted modules
import { SSE_URL } from './config.js';
import { _topology, refreshTopology, setTopologyRefreshHook } from './topology.js';
import { saveFormation, registerPanel } from './panel-manager.js';
import { initScanner } from './scan.js';
import { renderTopoLayer, setLastTopoCollectd, initTopoControls } from './terrain.js';
import { getNodeTraffic, updateConnectionTraffic, updateConnectionTrafficSSE, trafficToCollectd, setTrafficScale } from './traffic.js';
import { DOM, setLatencyMap, setLatencyFlat, setWifiMap,
         updateEnergyPanel, updateLatencyPanel, updateFirewallPanel, handleFirewallData, renderWifiPanel,
         updateCensusSubLabels, updateNodeListStatus, rebuildCensusIfNeeded } from './panels.js';
import { updateUI, updateCoreSublabels, updateHASublabels, updateTooltips, updateInfraNodes,
         applyMasterScale, getLastStatus, findStatusKey, setPostUpdateHook,
         getSliderRefs, setMasterScale, getMasterScale } from './node-status.js';
import { getFpsEl } from './effects.js';
import { renderEvent, updateBubblePositions, firePulse, showOffline,
         setOpenNodeChat, getLastEventTs } from './quest-log.js';
import { isZoomActive,
         setDeferredStatus, setDeferredTraffic, setDeferredEnergy, setDeferredLatency,
         setGhostDirty, applyTopoZ, setOpenPersonaEditor } from './map-view.js';
import { openPersonaEditor, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { initSpellbook, invalidateSearchIndex } from './spellbook.js';
import { saveSettings, scheduleSave, setPanelMode,
         makeDraggable, makeResizable, isRestoring } from './layout.js';

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

// (Auto-Arrange Layout, cartographer sliders, biome sliders moved to layout.js)

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
      if (!isRestoring()) saveFormation();  // sync panel-manager so hidden panels stay hidden on reload
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

// (Panel Layout Modes, settings persistence, draggable/resizable panels, layout restore moved to layout.js)

initScanner();

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

