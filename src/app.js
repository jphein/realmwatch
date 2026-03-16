// ── App coordinator — SSE dispatch, module wiring, visual-layer controls ──
import { SSE_URL } from './config.js';
import { refreshTopology, setTopologyRefreshHook } from './topology.js';
import { saveFormation } from './panel-manager.js';
import { initScanner } from './scan.js';
import { renderTopoLayer, setLastTopoCollectd, initTopoControls } from './terrain.js';
import { updateConnectionTraffic, updateConnectionTrafficSSE, trafficToCollectd, setTrafficScale } from './traffic.js';
import { setLatencyMap, setLatencyFlat, setWifiMap,
         updateEnergyPanel, updateLatencyPanel, handleFirewallData, renderWifiPanel,
         rebuildCensusIfNeeded } from './panels.js';
import { updateUI, getLastStatus, setPostUpdateHook } from './node-status.js';
import { getFpsEl } from './effects.js';
import { renderEvent, updateBubblePositions, firePulse, showOffline,
         setOpenNodeChat } from './quest-log.js';
import { isZoomActive,
         setDeferredStatus, setDeferredTraffic, setDeferredEnergy, setDeferredLatency,
         setGhostDirty, applyTopoZ, setOpenPersonaEditor } from './map-view.js';
import { openPersonaEditor, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { initSpellbook, invalidateSearchIndex } from './spellbook.js';
import { saveSettings, scheduleSave, setPanelMode, isRestoring } from './layout.js';
import { scheduleDebugRefresh } from './debug.js';

let liveOk = false;

// Register post-update hook for firePulse + debug refresh + periodic log
setPostUpdateHook(() => {
  firePulse();
  scheduleDebugRefresh();
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

initTopoControls({ saveSettings, scheduleSave, applyTopoZ });

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

// Wire up tab renderers for persona-editor.js
setTabRenderers({
  renderControlPane,
  renderGroupPane,
  renderShellPane,
  renderConnectionsPane,
  focusShellInput,
});

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

  // Wire up panel mode buttons
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

// ── SSE Connection ──
let _sseTrafficMap = null;
let _sseConnected = false;
export const getSseConnected = () => _sseConnected;

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

initScanner();

