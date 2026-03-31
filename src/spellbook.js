'use strict';
import { _perfTier, setPerfTier, _PERF, _isMobile, _cpuCores } from './config.js';
import { _topology } from './topology.js';
import { forceTopoRender } from './terrain.js';
import { setGpuZoomEnabled, updateBubbleTotalScale, panToNode } from './map-view.js';
import { getBubbleFixedSize, setBubbleFixedSize } from './node-status.js';
import { getSparkleAmbient, setSparkleAmbient, getSparkleNodes, setSparkleNodes,
         getSparkleLeyLines, setSparkleLeyLines, getSparkleGlowSize, setSparkleGlowSize } from './effects.js';
import { unsealPanel, saveFormation, PANELS } from './panel-manager.js';
import { showHighlight } from './quest-log.js';

// ── Injected callbacks (set by app.js via initSpellbook) ──
let _saveSettings = () => {};
let _scheduleSave = () => {};

export function initSpellbook({ saveSettings, scheduleSave }) {
  _saveSettings = saveSettings;
  _scheduleSave = scheduleSave;
}

// ── Spellbook Page Navigation ──
const _spellPages = document.querySelectorAll('#spellbook .spell-page');
const _spellTabs = document.querySelectorAll('.spell-tab');
let _spellPage = 0;
function _showSpellPage(idx) {
  _spellPage = Math.max(0, Math.min(idx, _spellPages.length - 1));
  _spellPages.forEach((p, i) => {
    p.style.display = i === _spellPage ? 'block' : 'none';
    p.classList.toggle('active', i === _spellPage);
  });
  _spellTabs.forEach((t, i) => t.classList.toggle('active', i === _spellPage));
  _saveSettings();
}
_spellTabs.forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    _showSpellPage(parseInt(tab.dataset.spell));
  });
});

// ── Spellbook Presets ──
const _PRESETS = {
  minimal:     { 'fx-ambient': 0.05, 'fx-nodes': 0.1, 'fx-leylines': 0.05, 'fx-glow': 0.3, 'fx-pulse': 0.5, 'fx-leyglow': 0.2, 'traffic-scale': 0.5 },
  cinematic:   { 'fx-ambient': 0.6,  'fx-nodes': 0.8, 'fx-leylines': 0.7,  'fx-glow': 2.0, 'fx-pulse': 0.8, 'fx-leyglow': 1.5, 'traffic-scale': 1.5 },
  performance: { 'fx-ambient': 0,    'fx-nodes': 0.2, 'fx-leylines': 0.1,  'fx-glow': 0.5, 'fx-pulse': 1.0, 'fx-leyglow': 0.5, 'traffic-scale': 0.5 },
  full:        { 'fx-ambient': 0.5,  'fx-nodes': 0.7, 'fx-leylines': 0.6,  'fx-glow': 1.5, 'fx-pulse': 1.2, 'fx-leyglow': 1.2, 'traffic-scale': 1.2 },
};
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = _PRESETS[btn.dataset.preset];
    if (!preset) return;
    for (const [id, val] of Object.entries(preset)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
    if (btn.dataset.preset === 'performance') {
      const q = document.getElementById('fx-quality-select');
      if (q) { q.value = 'low'; q.dispatchEvent(new Event('change')); }
    }
    _saveSettings();
  });
});

// ── Section Reset Buttons ──
const _SECTION_DEFAULTS = {
  effects:       { 'fx-ambient': 0.3, 'fx-nodes': 0.5, 'fx-glow': 1.0, 'fx-pulse': 1.0 },
  biomes:        { 'biome-land': 1.0, 'biome-glow': 1.0, 'biome-roads': 0.5, 'biome-peaks': 0.5, 'biome-grid': 0.03 },
  scale:         { 'master-scale': 1.0, 'node-scale': 1.0, 'text-scale': 1.0, 'bubble-scale': 1.0 },
  'ley-lines':   { 'traffic-scale': 1.0, 'fx-leylines': 0.4, 'fx-leyglow': 1.0 },
  'arcane-grid': { 'grid-opacity': 0.4, 'grid-scale': 1.0, 'grid-hue': 0 },
  ambiance:      { 'compass-scale': 1.0, 'sparkle-density': 0.5, 'ambient-glow': 0.3, 'vignette': 0.3 },
  topographic:   { 'topo-opacity': 0.6, 'topo-spread': 120, 'topo-contour': 12, 'topo-rw': 0.4, 'topo-rd': 0.6 },
  layout:        { 'layout-attract': 4.0, 'layout-repulse': 80, 'layout-edge': 80, 'layout-spacing': 8, 'layout-tilt': 0 },
};
document.querySelectorAll('.section-reset').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.reset === 'layers') {
      // Reset all layer checkboxes to checked (except grid which defaults off), opacities to 1
      ['vis-terrain','vis-topo','vis-nodes','vis-connections','vis-labels','vis-sublabels','vis-regions','vis-vlanlabels','vis-bubbles',
       'vis-titlebar','vis-search','vis-statuspanel','vis-legend','vis-codex','vis-questlog','vis-cartographer','vis-energy','vis-nodelist'].forEach(id => {
        const cb = document.getElementById(id);
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
      // Grid defaults to off
      const gridCb = document.getElementById('vis-grid');
      if (gridCb && gridCb.checked) { gridCb.checked = false; gridCb.dispatchEvent(new Event('change')); }
      ['layer-terrain','layer-terrain-orig','layer-topo','layer-grid','layer-nodes','layer-connections','layer-labels','layer-sublabels','layer-regions','layer-vlanlabels','layer-bubbles'].forEach(id => {
        const sl = document.getElementById(id + '-slider');
        if (sl) { sl.value = id === 'layer-grid' ? 0.4 : 1; sl.dispatchEvent(new Event('input')); }
      });
      _saveSettings();
      return;
    }
    if (btn.dataset.reset === 'arcane-grid') {
      // Reset grid checkboxes too
      const toggleCb = document.getElementById('grid-toggle-cb');
      const pulseCb = document.getElementById('grid-pulse-cb');
      if (toggleCb && toggleCb.checked) { toggleCb.checked = false; toggleCb.dispatchEvent(new Event('change')); }
      if (pulseCb && !pulseCb.checked) { pulseCb.checked = true; pulseCb.dispatchEvent(new Event('change')); }
    }
    const defaults = _SECTION_DEFAULTS[btn.dataset.reset];
    if (!defaults) return;
    for (const [id, val] of Object.entries(defaults)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
    _saveSettings();
  });
});

// Legend + Spellbook collapsible sections
document.querySelectorAll('.legend-section-header').forEach(header => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('collapsed');
    _saveSettings();
  });
});
// Start with Nodes and Effects collapsed, Lines and Controls open
document.querySelector('.legend-section[data-section="nodes"]')?.classList.add('collapsed');
document.querySelector('.legend-section[data-section="effects"]')?.classList.add('collapsed');

// ── Magical Effects Controls ──
(function initEffectsControls() {
  function wire(id, getter, setter) {
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) return;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = id === 'fx-pulse' ? v.toFixed(1) + 'x' : v.toFixed(2);
      _scheduleSave();
    });
  }
  wire('fx-ambient', getSparkleAmbient, v => { setSparkleAmbient(v); });
  wire('fx-nodes', getSparkleNodes, v => { setSparkleNodes(v); });
  wire('fx-leylines', getSparkleLeyLines, v => { setSparkleLeyLines(v); });
  wire('fx-glow', getSparkleGlowSize, v => { setSparkleGlowSize(v); });
  wire('fx-pulse', null, v => {
    // Scale all pulse/animation speeds via CSS custom property
    document.documentElement.style.setProperty('--pulse-speed', v);
    document.querySelectorAll('.pulse-ring').forEach(el => {
      el.style.animationDuration = (2.5 / v) + 's';
    });
    document.querySelectorAll('.data-pulse-ring').forEach(el => {
      el.style.animationDuration = (0.8 / v) + 's';
    });
  });
  wire('fx-leyglow', null, v => {
    // Scale ley line connection glow opacity
    const svg = document.getElementById('connections');
    if (svg) svg.style.opacity = Math.min(1, v);
    // Scale filter blur
    document.querySelectorAll('#connections path').forEach(p => {
      p.style.filter = v > 0 ? '' : 'none';
      p.style.opacity = Math.min(1, v);
    });
  });

  // Quality tier selector
  const qSel = document.getElementById('fx-quality-select');
  const qVal = document.getElementById('fx-quality-val');
  if (qSel) {
    // Show detected tier on load
    qVal.textContent = _perfTier + (_isMobile ? ' (mobile)' : '');
    qSel.addEventListener('change', () => {
      if (qSel.value === 'auto') {
        setPerfTier(_isMobile ? (_cpuCores >= 6 ? 'medium' : 'low') : 'high');
      } else {
        setPerfTier(qSel.value);
      }
      qVal.textContent = _perfTier;
      _applyPerfClasses();
      forceTopoRender();
      _saveSettings();
    });
  }
  _applyPerfClasses();

  // Auto-detect tier toggle
  const adCb = document.getElementById('perf-auto-detect');
  if (adCb) {
    adCb.addEventListener('change', () => {
      _autoDetectEnabled = adCb.checked;
      _saveSettings();
    });
  }

  // GPU zoom boost toggle
  const gzCb = document.getElementById('perf-gpu-zoom');
  if (gzCb) {
    gzCb.addEventListener('change', () => {
      setGpuZoomEnabled(gzCb.checked);
      _saveSettings();
    });
  }

  // Fixed bubble size toggle
  const bfCb = document.getElementById('bubble-fixed-size');
  if (bfCb) {
    bfCb.checked = getBubbleFixedSize();
    bfCb.addEventListener('change', () => {
      setBubbleFixedSize(bfCb.checked);
      document.getElementById('map-world').classList.toggle('bubble-fixed', getBubbleFixedSize());
      updateBubbleTotalScale();
      _saveSettings();
    });
  }
  // Apply initial state
  document.getElementById('map-world').classList.toggle('bubble-fixed', getBubbleFixedSize());
  updateBubbleTotalScale();
})();

let _autoDetectEnabled = true;

function _syncQualityUI() {
  const qSel = document.getElementById('fx-quality-select');
  const qVal = document.getElementById('fx-quality-val');
  if (qSel) qSel.value = _perfTier;
  if (qVal) qVal.textContent = _perfTier;
}

function _applyPerfClasses() {
  const b = document.body;
  b.classList.toggle('perf-no-dash', !_PERF.dashAnims);
  b.classList.toggle('perf-no-breath', !_PERF.runeBreath);
  b.classList.toggle('perf-no-filters', !_PERF.svgFilters);
  b.classList.toggle('perf-no-vine-anim', !_PERF.vineAnims);
}

// ── Realm Search ──
const _realmSearch = document.getElementById('realm-search');
const _searchInput = document.getElementById('search-input');
const _searchResults = document.getElementById('search-results');
const _searchClear = document.getElementById('search-clear');
let _searchIndex = null; // built lazily
let _searchActiveIdx = -1;

// Build panel entries dynamically from PANELS registry (includes plugin panels)
function _getPanelEntries() {
  return Object.entries(PANELS)
    .filter(([id]) => document.getElementById(id))
    .map(([id, p]) => ({
      id: '_panel:' + id,
      icon: p.icon || '\u2726',
      label: p.name || id,
      sub: '',
      kind: 'Panel',
      sel: '#' + id,
    }));
}

// Build comprehensive search index from topology + panels + all settings/controls
function _buildSearchIndex() {
  if (!_topology || _searchIndex) return;
  _searchIndex = [
    // Topology nodes
    ..._topology.nodes.map(n => ({
      id: n.id,
      icon: n.icon,
      label: n.label,
      sub: n.sublabel || '',
      ip: n.ip || '',
      type: n.type || 'core',
      _text: [n.label, n.sublabel, n.ip, n.id, n.type].filter(Boolean).join(' ').toLowerCase(),
    })),
    // Panel entries (dynamic — includes plugin panels)
    ..._getPanelEntries().map(p => ({
      id: p.id,
      icon: p.icon,
      label: p.label,
      sub: p.sub,
      ip: '',
      type: p.kind,
      sel: p.sel,
      _text: [p.label, p.sub, p.kind].join(' ').toLowerCase(),
    })),
  ];
  // Scan all panels for controls: sliders, toggles, selects, buttons
  _indexPanelControls();
}

// Panel icon lookup for search results
const _panelIcons = {
  'spellbook': '&#128214;', 'legend': '&#128506;', 'realm-codex': '&#128220;',
  'realm-panel': '&#9876;', 'cartographer': '&#128506;', 'energy-panel': '&#9889;',
  'debug-panel': '&#128302;', 'quest-log': '&#9753;', 'node-list': '&#9873;',
  'latency-panel': '&#127992;', 'firewall-panel': '&#128737;',
};
const _panelNames = {
  'spellbook': 'Spellbook', 'legend': 'Legend', 'realm-codex': 'Realm Codex',
  'realm-panel': 'Realm Vitals', 'cartographer': 'Cartographer', 'energy-panel': 'Energy',
  'debug-panel': 'Arcane Mirror', 'quest-log': 'Quest Log', 'node-list': 'Census',
  'latency-panel': 'Arcane Pulse', 'firewall-panel': 'Realm Wards',
};

function _indexPanelControls() {
  const panelIds = Object.keys(PANELS);
  for (const panelId of panelIds) {
    const panel = document.getElementById(panelId);
    if (!panel) continue;
    const pDef = PANELS[panelId];
    const icon = _panelIcons[panelId] || (pDef?.icon || '&#9881;');
    const panelName = _panelNames[panelId] || pDef?.name || panelId;

    // Index sliders (type="range")
    panel.querySelectorAll('input[type="range"]').forEach(slider => {
      const label = _findControlLabel(slider);
      if (!label) return;
      const section = _findSectionName(slider);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${slider.id || label}`,
        icon, label, sub, ip: '', type: 'Slider',
        _el: slider,
        _text: [label, sub, 'slider', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index checkboxes / toggles
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = _findControlLabel(cb);
      if (!label) return;
      const section = _findSectionName(cb);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${cb.id || label}`,
        icon, label, sub, ip: '', type: 'Toggle',
        _el: cb,
        _text: [label, sub, 'toggle', 'switch', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index selects
    panel.querySelectorAll('select').forEach(sel => {
      const label = _findControlLabel(sel);
      if (!label) return;
      const section = _findSectionName(sel);
      const optTexts = [...sel.options].map(o => o.textContent).join(' ');
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${sel.id || label}`,
        icon, label, sub, ip: '', type: 'Select',
        _el: sel,
        _text: [label, sub, 'select', optTexts, panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index number inputs
    panel.querySelectorAll('input[type="number"]').forEach(input => {
      const label = _findControlLabel(input);
      if (!label) return;
      const section = _findSectionName(input);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${input.id || label}`,
        icon, label, sub, ip: '', type: 'Setting',
        _el: input,
        _text: [label, sub, 'setting', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index preset buttons
    panel.querySelectorAll('.preset-btn').forEach(btn => {
      const label = btn.textContent.trim();
      const section = _findSectionName(btn);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:preset-${btn.dataset.preset || label}`,
        icon, label: `Preset: ${label}`, sub, ip: '', type: 'Action',
        _el: btn,
        _text: [label, 'preset', sub, panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });
  }

  // Index cartographer layout modes
  document.querySelectorAll('.carto-mode').forEach(btn => {
    const name = btn.querySelector('.carto-name')?.textContent || '';
    const iconEl = btn.querySelector('.carto-icon')?.innerHTML || '';
    _searchIndex.push({
      id: `_ctrl:layout-${btn.dataset.layout}`,
      icon: iconEl || '&#128506;', label: `Layout: ${name}`, sub: 'Cartographer', ip: '', type: 'Layout',
      _el: btn,
      _text: [name, 'layout', 'cartographer', 'map', btn.dataset.layout].join(' ').toLowerCase(),
    });
  });

  // Index codex tool entries
  document.querySelectorAll('.codex-tool code').forEach(code => {
    const toolName = code.textContent;
    const desc = code.parentElement?.querySelector('span')?.textContent || '';
    const group = code.closest('.codex-tools')?.previousElementSibling?.textContent?.replace(/\d+ tools/, '').trim() || '';
    _searchIndex.push({
      id: `_ctrl:tool-${toolName}`,
      icon: '&#128220;', label: toolName, sub: `${group} \u203A ${desc}`.substring(0, 60), ip: '', type: 'Tool',
      _el: code.closest('.codex-tool'),
      _text: [toolName, desc, group, 'tool', 'codex'].join(' ').toLowerCase(),
    });
  });

  // Index legend items
  document.querySelectorAll('#legend .legend-item').forEach(item => {
    const label = item.textContent.trim();
    const section = _findSectionName(item);
    _searchIndex.push({
      id: `_ctrl:legend-${label}`,
      icon: '&#128506;', label, sub: `Legend \u203A ${section || ''}`, ip: '', type: 'Legend',
      _el: item,
      _text: [label, 'legend', section, 'ley line', 'node type'].filter(Boolean).join(' ').toLowerCase(),
    });
  });
}

// Walk up DOM to find the nearest label text for a control
function _findControlLabel(el) {
  // Check for <label> wrapping or preceding the control
  const parent = el.closest('.traffic-control, .layer-row, .cfg-row');
  if (parent) {
    const lbl = parent.querySelector('label');
    if (lbl) {
      // Strip value spans
      const clone = lbl.cloneNode(true);
      clone.querySelectorAll('.tc-val, .topo-switch').forEach(v => v.remove());
      return clone.textContent.trim();
    }
    const name = parent.querySelector('.layer-name');
    if (name) return name.textContent.trim();
  }
  // Fallback: check closest label element
  const wrapper = el.closest('label');
  if (wrapper) {
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll('input, select, .tc-val, .topo-switch-track').forEach(v => v.remove());
    return clone.textContent.trim();
  }
  return '';
}

// Walk up DOM to find containing section name
function _findSectionName(el) {
  const section = el.closest('.legend-section');
  if (section) {
    const header = section.querySelector('.legend-section-header');
    if (header) {
      const clone = header.cloneNode(true);
      clone.querySelectorAll('.legend-chevron, .section-reset').forEach(v => v.remove());
      return clone.textContent.trim();
    }
  }
  const codexSection = el.closest('.codex-section');
  if (codexSection) {
    const h4 = codexSection.querySelector('h4');
    if (h4) return h4.textContent.replace(/\d+ tools/, '').trim();
  }
  return '';
}

function _searchRealm(query) {
  _buildSearchIndex();
  if (!_searchIndex || !query) return [];
  const terms = query.toLowerCase().split(/\s+/);
  const scored = [];
  for (const entry of _searchIndex) {
    let match = true;
    let score = 0;
    for (const t of terms) {
      const idx = entry._text.indexOf(t);
      if (idx === -1) { match = false; break; }
      if (entry.label.toLowerCase().startsWith(t)) score += 10;
      else if (entry.ip.startsWith(t)) score += 5;
      else score += 1;
    }
    if (match) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 16).map(s => s.entry);
}

function _highlightMatch(text, query) {
  if (!query) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;
  for (const t of terms) {
    const idx = result.toLowerCase().indexOf(t);
    if (idx !== -1) {
      result = result.slice(0, idx) + '<mark>' + result.slice(idx, idx + t.length) + '</mark>' + result.slice(idx + t.length);
    }
  }
  return result;
}

function _renderSearchResults(results, query) {
  _searchActiveIdx = -1;
  if (!results.length) {
    // Safe: static text only
    _searchResults.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'sr-empty';
    empty.textContent = 'No matches in the Realm';
    _searchResults.appendChild(empty);
    _searchResults.classList.add('open');
    return;
  }
  const typeName = { core: 'Core', infra: 'Infra', tower: 'Tower', bridge: 'Bridge', cluster: 'IoT', tailscale: 'Astral',
    Panel: 'Panel', Slider: 'Slider', Toggle: 'Toggle', Select: 'Setting', Setting: 'Setting',
    Action: 'Action', Layout: 'Layout', Tool: 'Tool', Legend: 'Legend' };
  // Safe: all data sourced from server-side topology.json (trusted)
  const frag = document.createDocumentFragment();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const item = document.createElement('div');
    item.className = 'sr-item';
    item.dataset.idx = i;
    item.dataset.nodeId = r.id;
    item.dataset.kind = r.type || '';

    const iconEl = document.createElement('div');
    iconEl.className = 'sr-icon';
    iconEl.innerHTML = r.icon; // topology.json icon HTML entities (trusted)

    const info = document.createElement('div');
    info.className = 'sr-info';
    const name = document.createElement('div');
    name.className = 'sr-name';
    name.innerHTML = _highlightMatch(r.label, query); // topology.json label (trusted)
    const sub = document.createElement('div');
    sub.className = 'sr-sub';
    sub.textContent = r.sub;
    info.appendChild(name);
    info.appendChild(sub);

    const typeEl = document.createElement('div');
    typeEl.className = 'sr-type';
    typeEl.textContent = typeName[r.type] || r.type;

    item.appendChild(iconEl);
    item.appendChild(info);
    item.appendChild(typeEl);
    frag.appendChild(item);
  }
  _searchResults.textContent = '';
  _searchResults.appendChild(frag);
  _searchResults.classList.add('open');
}

// Restore a panel: unseal if sealed, un-hide, re-check vis checkbox
function _restorePanel(panelEl) {
  if (!panelEl) return;
  // If sealed to dock, properly unseal it (removes rune, restores position)
  if (panelEl.classList.contains('panel-sealed')) {
    unsealPanel(panelEl);
    saveFormation();
    return;
  }
  panelEl.style.display = '';
  // Re-check vis checkbox if it exists
  const id = panelEl.id;
  const visMap = {
    'realm-panel': 'vis-statuspanel', 'legend': 'vis-legend', 'spellbook': 'vis-spellbook',
    'realm-codex': 'vis-codex', 'quest-log': 'vis-questlog', 'node-list': 'vis-nodelist',
    'cartographer': 'vis-cartographer', 'energy-panel': 'vis-energy',
    'debug-panel': 'vis-debug', 'latency-panel': 'vis-latency',
    'firewall-panel': 'vis-firewall',
    'wifi-panel': 'vis-wifi',
    'scanner-panel': 'vis-scanner',
  };
  const visId = visMap[id] || ('vis-' + id);
  const visCb = document.getElementById(visId);
  if (visCb && !visCb.checked) { visCb.checked = true; visCb.dispatchEvent(new Event('change')); }
}

// Flash-highlight an element with a golden glow
function _flashElement(el) {
  if (!el) return;
  el.style.transition = 'box-shadow 0.3s, outline 0.3s';
  el.style.boxShadow = '0 0 20px rgba(240,216,144,0.5)';
  el.style.outline = '2px solid rgba(240,216,144,0.6)';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.boxShadow = '';
    el.style.outline = '';
    el.style.outlineOffset = '';
  }, 1500);
}

function _navigateToSearchResult(nodeId) {
  _searchInput.blur();
  _searchResults.classList.remove('open');

  // Control results: open panel -> tab -> section -> scroll to control
  if (nodeId.startsWith('_ctrl:')) {
    const entry = _searchIndex?.find(e => e.id === nodeId);
    const el = entry?._el;
    if (!el) return;

    // Find and restore the parent panel
    const panel = el.closest('.panel, #persona-editor, #debug-panel');
    if (panel) {
      _restorePanel(panel);
      // Also un-hide codex/legend bodies
      const body = panel.querySelector('#codex-body');
      if (body) body.style.display = '';
    }

    // Switch spellbook tab if control is inside a spell-page
    const spellPage = el.closest('.spell-page');
    if (spellPage) {
      const pageIdx = parseInt(spellPage.dataset.spellPage);
      if (!isNaN(pageIdx)) _showSpellPage(pageIdx);
    }

    // Expand collapsed legend-section
    const section = el.closest('.legend-section');
    if (section && section.classList.contains('collapsed')) {
      section.classList.remove('collapsed');
    }

    // Expand collapsed codex-tools
    const codexTools = el.closest('.codex-tools');
    if (codexTools && !codexTools.classList.contains('open')) {
      codexTools.classList.add('open');
      const h4 = codexTools.previousElementSibling;
      if (h4) h4.classList.add('open');
    }

    // Scroll to element and flash it
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      _flashElement(el.closest('.traffic-control, .layer-row, .cfg-row, .codex-tool, .legend-item, .carto-mode, .preset-btn') || el);
      // Focus interactive elements
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') el.focus();
      if (el.tagName === 'BUTTON') el.click();
    });
    return;
  }

  // Panel results: restore panel, scroll into view, and flash it
  if (nodeId.startsWith('_panel:')) {
    const entry = _searchIndex?.find(e => e.id === nodeId);
    const panelEl = entry?.sel ? document.querySelector(entry.sel) : null;
    if (panelEl) {
      _restorePanel(panelEl);
      panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      _flashElement(panelEl);
    }
    return;
  }

  // Node results: pan to node and highlight
  const nodeEl = document.querySelector(`[data-tip="${CSS.escape(nodeId)}"]`);
  if (!nodeEl) return;
  const nodeLeft = parseInt(nodeEl.style.left) || 0;
  const nodeTop = parseInt(nodeEl.style.top) || 0;
  panToNode(nodeLeft, nodeTop);
  showHighlight(nodeEl, { color: 'rgba(240,216,144,0.5)' });
}

if (_searchInput) {
  _searchInput.addEventListener('input', () => {
    const rawVal = _searchInput.value;
    const isMagic = rawVal.startsWith('?');
    const q = rawVal.trim();

    _realmSearch.classList.toggle('magic-morph', isMagic);
    _searchClear.style.display = q ? '' : 'none';

    if (!q) {
      _searchResults.classList.remove('open');
      return;
    }

    if (isMagic) {
      _searchResults.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'sr-empty';
      hint.textContent = q.length > 1 ? '\u2728 Press Enter to consult the Oracle...' : '\u2728 Ask the Oracle anything...';
      _searchResults.appendChild(hint);
      _searchResults.classList.add('open');
    } else {
      _renderSearchResults(_searchRealm(q), q);
    }
  });

  _searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _realmSearch.classList.contains('magic-morph')) {
      const q = _searchInput.value.trim();
      if (q.length > 1) {
        e.preventDefault();
        const query = q.substring(1).trim();

        // Fire as event through existing system
        fetch('/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'oracle_query', node: 'scrying-pool', text: query, color: '#c080ff' })
        }).catch(err => console.error('Oracle query failed:', err));

        // Visual feedback
        _searchResults.textContent = '';
        const sent = document.createElement('div');
        sent.className = 'sr-empty';
        sent.textContent = '\u2728 Query cast into the Aether...';
        _searchResults.appendChild(sent);

        setTimeout(() => {
          _searchInput.value = '';
          _realmSearch.classList.remove('magic-morph');
          _searchResults.classList.remove('open');
          _searchClear.style.display = 'none';
        }, 1200);
        return;
      }
    }

    const items = _searchResults.querySelectorAll('.sr-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _searchActiveIdx = Math.min(_searchActiveIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === _searchActiveIdx));
      items[_searchActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _searchActiveIdx = Math.max(_searchActiveIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === _searchActiveIdx));
      items[_searchActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && _searchActiveIdx >= 0) {
      e.preventDefault();
      const id = items[_searchActiveIdx]?.dataset.nodeId;
      if (id) _navigateToSearchResult(id);
    } else if (e.key === 'Escape') {
      _searchResults.classList.remove('open');
      _searchInput.blur();
    }
  });

  _searchResults.addEventListener('click', e => {
    const item = e.target.closest('.sr-item');
    if (item) _navigateToSearchResult(item.dataset.nodeId);
  });

  _searchClear.addEventListener('click', () => {
    _searchInput.value = '';
    _searchClear.style.display = 'none';
    _searchResults.classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#realm-search')) _searchResults.classList.remove('open');
  });
}

// ── Exports ──
export const getSpellPage = () => _spellPage;
export function showSpellPage(idx) { _showSpellPage(idx); }
export function applyPerfClasses() { _applyPerfClasses(); }
export function syncQualityUI() { _syncQualityUI(); }
export const getAutoDetectEnabled = () => _autoDetectEnabled;
export function invalidateSearchIndex() { _searchIndex = null; }
