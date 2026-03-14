// ── Arcane Panel Manager — Magical Layout System ──
// Manages panel positions with ley anchors, formations, and conjuration modes.

const ANCHORS = [
  { id: 'nw', x: 0, y: 0, label: 'Northwest Anchor' },
  { id: 'n',  x: 0.5, y: 0, label: 'North Anchor' },
  { id: 'ne', x: 1, y: 0, label: 'Northeast Anchor' },
  { id: 'e',  x: 1, y: 0.5, label: 'East Anchor' },
  { id: 'se', x: 1, y: 1, label: 'Southeast Anchor' },
  { id: 's',  x: 0.5, y: 1, label: 'South Anchor' },
  { id: 'sw', x: 0, y: 1, label: 'Southwest Anchor' },
  { id: 'w',  x: 0, y: 0.5, label: 'West Anchor' },
];

// Panel definitions with default anchors and priority
const PANELS = {
  'realm-panel':    { name: 'Realm Vitals', anchor: 'ne', priority: 1, icon: '\u2694' },
  'legend':         { name: 'Legend', anchor: 'sw', priority: 5, icon: '\uD83D\uDDFA' },
  'spellbook':      { name: 'Spellbook', anchor: 'sw', priority: 3, icon: '\uD83D\uDCD6' },
  'realm-codex':    { name: 'Codex', anchor: 'nw', priority: 4, icon: '\u2630' },
  'quest-log':      { name: 'Quest Log', anchor: 'se', priority: 6, icon: '\u2619' },
  'minimap':        { name: 'Minimap', anchor: 'se', priority: 2, icon: '\uD83E\uDDED' },
  'cartographer':   { name: 'Cartographer', anchor: 'e', priority: 7, icon: '\uD83E\uDDED' },
  'energy-panel':   { name: 'Energy', anchor: 'w', priority: 8, icon: '\u26A1' },
  'node-list':      { name: 'Census', anchor: 'w', priority: 9, icon: '\uD83D\uDCDC' },
  'debug-panel':    { name: 'Arcane Mirror', anchor: 's', priority: 10, icon: '\uD83D\uDD2E' },
};

// Arcane Formations (presets)
const FORMATIONS = {
  'scrying-focus': {
    name: 'Scrying Focus',
    icon: '\uD83D\uDC41',
    desc: 'Clear sight upon the realm',
    visible: ['minimap'],
    anchors: { 'minimap': 'se' },
  },
  'wardens-watch': {
    name: "Warden's Watch",
    icon: '\uD83D\uDEE1',
    desc: 'Monitor the realm vitals',
    visible: ['realm-panel', 'energy-panel', 'minimap'],
    anchors: { 'realm-panel': 'ne', 'energy-panel': 'nw', 'minimap': 'se' },
  },
  'grand-arcanum': {
    name: 'Grand Arcanum',
    icon: '\u2728',
    desc: 'Summon all panels',
    visible: Object.keys(PANELS),
    anchors: null, // auto-arrange
  },
  'grimoire-binding': {
    name: 'Grimoire Binding',
    icon: '\uD83D\uDCD5',
    desc: 'Your saved formation',
    visible: null, // loaded from storage
    anchors: null,
  },
};

const STORAGE_KEY = 'realm-panel-formation';
let _mode = 'auto'; // 'auto' or 'manual'
let _currentFormation = null;
let _dragging = null;
let _dragOffset = { x: 0, y: 0 };
let _anchorOverlay = null;
let _particleCanvas = null;

// ── Initialization ──
export function initPanelManager() {
  _createAnchorOverlay();
  _createParticleCanvas();
  _attachDragHandlers();
  _loadFormation();
  _injectFormationUI();
}

function _createAnchorOverlay() {
  _anchorOverlay = document.createElement('div');
  _anchorOverlay.id = 'ley-anchor-overlay';

  // Build anchors with safe DOM methods
  ANCHORS.forEach(a => {
    const anchor = document.createElement('div');
    anchor.className = 'ley-anchor';
    anchor.dataset.anchor = a.id;
    anchor.style.left = (a.x * 100) + '%';
    anchor.style.top = (a.y * 100) + '%';

    const rune = document.createElement('span');
    rune.className = 'anchor-rune';
    rune.textContent = '\u25C8'; // ◈

    const glow = document.createElement('span');
    glow.className = 'anchor-glow';

    anchor.appendChild(rune);
    anchor.appendChild(glow);
    _anchorOverlay.appendChild(anchor);
  });

  document.body.appendChild(_anchorOverlay);
}

function _createParticleCanvas() {
  _particleCanvas = document.createElement('canvas');
  _particleCanvas.id = 'arcane-particles';
  _particleCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9998;';
  document.body.appendChild(_particleCanvas);
  _resizeParticleCanvas();
  window.addEventListener('resize', _resizeParticleCanvas);
}

function _resizeParticleCanvas() {
  _particleCanvas.width = window.innerWidth;
  _particleCanvas.height = window.innerHeight;
}

// ── Drag Handlers ──
function _attachDragHandlers() {
  document.querySelectorAll('.panel').forEach(panel => {
    const header = panel.querySelector('.panel-header');
    if (!header || !PANELS[panel.id]) return;

    header.style.cursor = 'grab';
    header.addEventListener('mousedown', e => _startDrag(e, panel));
    header.addEventListener('touchstart', e => _startDrag(e, panel), { passive: false });

    // Double-click to minimize/restore
    header.addEventListener('dblclick', () => _toggleMinimize(panel));
  });

  document.addEventListener('mousemove', _onDrag);
  document.addEventListener('touchmove', _onDrag, { passive: false });
  document.addEventListener('mouseup', _endDrag);
  document.addEventListener('touchend', _endDrag);
}

function _startDrag(e, panel) {
  if (e.target.closest('.panel-close, .panel-min-icon, button, input, select')) return;
  e.preventDefault();

  _dragging = panel;
  _mode = 'manual';

  const rect = panel.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  _dragOffset = { x: clientX - rect.left, y: clientY - rect.top };

  panel.classList.add('panel-dragging');
  panel.style.transition = 'none';
  panel.style.position = 'fixed';
  panel.style.zIndex = '9999';

  // Show anchor overlay
  _anchorOverlay.classList.add('visible');

  // Start ethereal trail
  _startParticleTrail(clientX, clientY);
}

function _onDrag(e) {
  if (!_dragging) return;
  e.preventDefault();

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  const x = clientX - _dragOffset.x;
  const y = clientY - _dragOffset.y;

  _dragging.style.left = x + 'px';
  _dragging.style.top = y + 'px';
  _dragging.style.right = 'auto';
  _dragging.style.bottom = 'auto';

  // Highlight nearest anchor
  const nearest = _findNearestAnchor(clientX, clientY);
  document.querySelectorAll('.ley-anchor').forEach(el => {
    el.classList.toggle('active', el.dataset.anchor === nearest.id);
  });

  // Update particle trail
  _updateParticleTrail(clientX, clientY);
}

function _endDrag() {
  if (!_dragging) return;

  const panel = _dragging;
  const rect = panel.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // Find nearest anchor and snap
  const anchor = _findNearestAnchor(centerX, centerY);
  _snapToAnchor(panel, anchor);

  // Flash rune effect
  _flashAnchorRune(anchor);

  // Cleanup
  panel.classList.remove('panel-dragging');
  panel.style.transition = '';
  panel.style.zIndex = '';
  _anchorOverlay.classList.remove('visible');
  _stopParticleTrail();

  _dragging = null;

  // Save formation
  _saveFormation();
}

function _findNearestAnchor(x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let nearest = ANCHORS[0];
  let minDist = Infinity;

  for (const a of ANCHORS) {
    const ax = a.x * vw;
    const ay = a.y * vh;
    const dist = Math.hypot(x - ax, y - ay);
    if (dist < minDist) {
      minDist = dist;
      nearest = a;
    }
  }
  return nearest;
}

function _snapToAnchor(panel, anchor) {
  const pad = 15;
  const style = panel.style;

  // Clear all positioning
  style.left = style.right = style.top = style.bottom = 'auto';
  style.transform = '';

  // Apply anchor-based positioning
  if (anchor.x === 0) style.left = pad + 'px';
  else if (anchor.x === 1) style.right = pad + 'px';
  else { style.left = '50%'; style.transform = 'translateX(-50%)'; }

  if (anchor.y === 0) style.top = pad + 'px';
  else if (anchor.y === 1) style.bottom = pad + 'px';
  else {
    style.top = '50%';
    style.transform = anchor.x === 0.5 ? 'translate(-50%, -50%)' : 'translateY(-50%)';
  }

  // Store anchor in dataset
  panel.dataset.anchor = anchor.id;
}

// ── Minimize/Restore ──
function _toggleMinimize(panel) {
  const isMinimized = panel.classList.contains('panel-sealed');

  if (isMinimized) {
    panel.classList.remove('panel-sealed');
    _spawnRestoreParticles(panel);
  } else {
    panel.classList.add('panel-sealed');
    _spawnSealParticles(panel);
  }

  _saveFormation();
}

// ── Particle Effects ──
let _particles = [];
let _trailActive = false;
let _trailX = 0, _trailY = 0;

function _startParticleTrail(x, y) {
  _trailActive = true;
  _trailX = x;
  _trailY = y;
  _animateParticles();
}

function _updateParticleTrail(x, y) {
  if (!_trailActive) return;

  const dx = x - _trailX;
  const dy = y - _trailY;
  const dist = Math.hypot(dx, dy);

  if (dist > 5) {
    _particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2 - 1,
      life: 1,
      size: Math.random() * 4 + 2,
      hue: 200 + Math.random() * 60,
    });
    _trailX = x;
    _trailY = y;
  }
}

function _stopParticleTrail() {
  _trailActive = false;
}

function _animateParticles() {
  if (!_trailActive && _particles.length === 0) return;

  const ctx = _particleCanvas.getContext('2d');
  ctx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);

  for (let i = _particles.length - 1; i >= 0; i--) {
    const p = _particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.02;

    if (p.life <= 0) {
      _particles.splice(i, 1);
      continue;
    }

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.life * 0.8})`;
    ctx.fill();

    // Glow
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life * 2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.life * 0.3})`;
    ctx.fill();
  }

  requestAnimationFrame(_animateParticles);
}

function _flashAnchorRune(anchor) {
  const el = document.querySelector(`.ley-anchor[data-anchor="${anchor.id}"]`);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 500);
}

function _spawnSealParticles(panel) {
  const rect = panel.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  for (let i = 0; i < 20; i++) {
    const angle = (i / 20) * Math.PI * 2;
    _particles.push({
      x: cx + Math.cos(angle) * 50,
      y: cy + Math.sin(angle) * 50,
      vx: -Math.cos(angle) * 3,
      vy: -Math.sin(angle) * 3,
      life: 1,
      size: 4,
      hue: 280,
    });
  }
  _animateParticles();
}

function _spawnRestoreParticles(panel) {
  const rect = panel.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  for (let i = 0; i < 30; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 4 + 2;
    _particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      size: Math.random() * 3 + 2,
      hue: 50 + Math.random() * 30,
    });
  }
  _animateParticles();
}

// ── Formations ──
export function applyFormation(formationId) {
  const formation = FORMATIONS[formationId];
  if (!formation) return;

  _currentFormation = formationId;

  // Handle grimoire (custom saved)
  let visible = formation.visible;
  let anchors = formation.anchors;

  if (formationId === 'grimoire-binding') {
    const saved = _loadSavedFormation();
    if (saved) {
      visible = saved.visible;
      anchors = saved.anchors;
    } else {
      visible = Object.keys(PANELS);
      anchors = null;
    }
  }

  // Hide all panels first
  Object.keys(PANELS).forEach(id => {
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'none';
  });

  // Show and position visible panels
  if (visible) {
    visible.forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;

      panel.style.display = '';

      if (anchors && anchors[id]) {
        const anchor = ANCHORS.find(a => a.id === anchors[id]);
        if (anchor) _snapToAnchor(panel, anchor);
      }
    });
  }

  // Auto-arrange if no specific anchors
  if (!anchors && visible) {
    _autoArrangePanels(visible);
  }

  // Conjuration animation
  _spawnConjurationCircle();
}

function _autoArrangePanels(panelIds) {
  // Sort by priority
  const sorted = [...panelIds].sort((a, b) =>
    (PANELS[a]?.priority || 99) - (PANELS[b]?.priority || 99)
  );

  // Assign to anchors intelligently
  const usedAnchors = new Set();
  const anchorStacks = {};

  sorted.forEach(id => {
    const panel = document.getElementById(id);
    if (!panel) return;

    const def = PANELS[id];
    let anchor = ANCHORS.find(a => a.id === def?.anchor);

    // If preferred anchor is used, find alternative
    if (usedAnchors.has(anchor?.id)) {
      const alternatives = ANCHORS.filter(a => !usedAnchors.has(a.id));
      if (alternatives.length > 0) {
        anchor = alternatives[0];
      }
    }

    if (anchor) {
      _snapToAnchor(panel, anchor);
      usedAnchors.add(anchor.id);

      // Stack offset for same anchor
      if (!anchorStacks[anchor.id]) anchorStacks[anchor.id] = 0;
      const stackOffset = anchorStacks[anchor.id] * 40;

      if (anchor.y === 0) panel.style.top = (15 + stackOffset) + 'px';
      else if (anchor.y === 1) panel.style.bottom = (15 + stackOffset) + 'px';

      anchorStacks[anchor.id]++;
    }
  });
}

function _spawnConjurationCircle() {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

  for (let ring = 0; ring < 3; ring++) {
    const radius = 100 + ring * 60;
    const count = 20 + ring * 10;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const delay = ring * 100 + i * 10;

      setTimeout(() => {
        _particles.push({
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: Math.cos(angle) * 0.5,
          vy: Math.sin(angle) * 0.5,
          life: 1,
          size: 3,
          hue: 200 + ring * 40,
        });
      }, delay);
    }
  }
  _animateParticles();
}

// ── Persistence ──
function _saveFormation() {
  const state = {
    visible: [],
    anchors: {},
    minimized: [],
  };

  Object.keys(PANELS).forEach(id => {
    const panel = document.getElementById(id);
    if (!panel) return;

    if (panel.style.display !== 'none') {
      state.visible.push(id);
      if (panel.dataset.anchor) {
        state.anchors[id] = panel.dataset.anchor;
      }
      if (panel.classList.contains('panel-sealed')) {
        state.minimized.push(id);
      }
    }
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function _loadFormation() {
  const saved = _loadSavedFormation();
  if (saved) {
    applyFormation('grimoire-binding');
  }
}

function _loadSavedFormation() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

// ── UI Injection ──
function _injectFormationUI() {
  const spellbook = document.getElementById('spellbook');
  if (!spellbook) return;

  const enchantPage = spellbook.querySelector('.spell-page[data-spell="0"]');
  if (!enchantPage) return;

  // Create formation section using safe DOM methods
  const section = document.createElement('div');
  section.className = 'legend-section';
  section.dataset.section = 'formations';

  // Header
  const header = document.createElement('div');
  header.className = 'legend-section-header';
  header.dataset.accent = 'purple';

  const chevron = document.createElement('span');
  chevron.className = 'legend-chevron';
  chevron.textContent = '\u25BE'; // ▾

  const secIcon = document.createElement('span');
  secIcon.className = 'sec-icon';
  secIcon.textContent = '\u2727'; // ✧

  header.appendChild(chevron);
  header.appendChild(secIcon);
  header.appendChild(document.createTextNode(' Arcane Formations'));

  // Body
  const body = document.createElement('div');
  body.className = 'legend-section-body';

  // Formation grid
  const grid = document.createElement('div');
  grid.className = 'formation-grid';

  Object.entries(FORMATIONS).forEach(([id, f]) => {
    const btn = document.createElement('button');
    btn.className = 'formation-btn';
    btn.dataset.formation = id;
    btn.title = f.desc;

    const icon = document.createElement('span');
    icon.className = 'formation-icon';
    icon.textContent = f.icon;

    const name = document.createElement('span');
    name.className = 'formation-name';
    name.textContent = f.name;

    btn.appendChild(icon);
    btn.appendChild(name);
    btn.addEventListener('click', () => {
      applyFormation(id);
      grid.querySelectorAll('.formation-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    grid.appendChild(btn);
  });

  // Mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'formation-mode';

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'topo-switch';

  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.id = 'auto-conjure-toggle';
  toggleInput.checked = _mode === 'auto';
  toggleInput.addEventListener('change', e => {
    _mode = e.target.checked ? 'auto' : 'manual';
  });

  const toggleTrack = document.createElement('span');
  toggleTrack.className = 'topo-switch-track';

  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(toggleTrack);

  const modeLabel = document.createElement('span');
  modeLabel.className = 'layer-name';
  modeLabel.textContent = 'Auto-Conjure';

  modeRow.appendChild(toggleLabel);
  modeRow.appendChild(modeLabel);

  // Save button
  const saveBtn = document.createElement('button');
  saveBtn.className = 'formation-save-btn';
  saveBtn.id = 'save-grimoire-btn';

  const saveIcon = document.createElement('span');
  saveIcon.textContent = '\uD83D\uDCD5'; // 📕

  saveBtn.appendChild(saveIcon);
  saveBtn.appendChild(document.createTextNode(' Bind to Grimoire'));
  saveBtn.addEventListener('click', () => {
    _saveFormation();
    _flashSaveEffect();
  });

  body.appendChild(grid);
  body.appendChild(modeRow);
  body.appendChild(saveBtn);

  section.appendChild(header);
  section.appendChild(body);

  enchantPage.insertBefore(section, enchantPage.firstChild);
}

function _flashSaveEffect() {
  const btn = document.getElementById('save-grimoire-btn');
  if (!btn) return;
  btn.classList.add('saved');
  btn.textContent = '';
  const check = document.createElement('span');
  check.textContent = '\u2713'; // ✓
  btn.appendChild(check);
  btn.appendChild(document.createTextNode(' Bound!'));
  setTimeout(() => {
    btn.classList.remove('saved');
    btn.textContent = '';
    const icon = document.createElement('span');
    icon.textContent = '\uD83D\uDCD5';
    btn.appendChild(icon);
    btn.appendChild(document.createTextNode(' Bind to Grimoire'));
  }, 1500);
}

// ── Exports ──
export { FORMATIONS, PANELS, ANCHORS };
