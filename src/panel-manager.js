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
const SEAL_MODES = {
  dock: { name: 'Docked', icon: '⚓', desc: 'Sealed runes gather in the dock' },
  anchored: { name: 'Anchored', icon: '📍', desc: 'Runes stay where panels were' },
  wander: { name: 'Wander', icon: '✨', desc: 'Runes float freely about' },
  conjure: { name: 'Conjure', icon: '🔮', desc: 'Runes arrange themselves' },
};
let _mode = 'auto'; // 'auto' or 'manual'
let _sealMode = 'dock'; // 'dock', 'anchored', 'wander', 'conjure'
let _currentFormation = null;
let _dragging = null;
let _dragOffset = { x: 0, y: 0 };
let _anchorOverlay = null;
let _particleCanvas = null;
let _sealedDock = null;
let _wanderingRunes = []; // For wander mode animation

// ── Initialization ──
export function initPanelManager() {
  _createAnchorOverlay();
  _createParticleCanvas();
  _createSealedDock();
  _attachDragHandlers();
  _loadFormation();
  _injectFormationUI();
}

function _createSealedDock() {
  _sealedDock = document.createElement('div');
  _sealedDock.id = 'sealed-dock';
  _sealedDock.className = 'sealed-dock';

  // Mystical dock label
  const label = document.createElement('div');
  label.className = 'dock-label';
  label.textContent = '\u2726 Sealed Runes \u2726'; // ✦ Sealed Runes ✦
  _sealedDock.appendChild(label);

  // Container for sealed panel icons
  const tray = document.createElement('div');
  tray.className = 'dock-tray';
  _sealedDock.appendChild(tray);

  document.body.appendChild(_sealedDock);
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

    // Double-tap for mobile (dblclick doesn't fire reliably on touch)
    let lastTap = 0;
    header.addEventListener('touchend', e => {
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        _toggleMinimize(panel);
        lastTap = 0; // Reset to avoid triple-tap triggering again
      } else {
        lastTap = now;
      }
    });
  });

  document.addEventListener('mousemove', _onDrag);
  document.addEventListener('touchmove', _onDrag, { passive: false });
  document.addEventListener('mouseup', _endDrag);
  document.addEventListener('touchend', _endDrag);
}

let _dragStartPos = null;
let _dragThreshold = 10; // pixels before drag actually starts

function _startDrag(e, panel) {
  if (e.target.closest('.panel-close, .panel-min-icon, button, input, select')) return;
  e.preventDefault();

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  // Store start position - actual drag starts on move past threshold
  _dragStartPos = { x: clientX, y: clientY, panel };
  _mode = 'manual';

  const rect = panel.getBoundingClientRect();
  _dragOffset = { x: clientX - rect.left, y: clientY - rect.top };
}

function _onDrag(e) {
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  // Check if we need to start actual drag (past threshold)
  if (_dragStartPos && !_dragging) {
    const dx = Math.abs(clientX - _dragStartPos.x);
    const dy = Math.abs(clientY - _dragStartPos.y);
    if (dx > _dragThreshold || dy > _dragThreshold) {
      // Start actual drag
      _dragging = _dragStartPos.panel;
      _dragging.classList.add('panel-dragging');
      _dragging.style.transition = 'none';
      _dragging.style.position = 'fixed';
      _dragging.style.zIndex = '9999';
      _anchorOverlay.classList.add('visible');
      _startParticleTrail(clientX, clientY);
    }
  }

  if (!_dragging) return;
  e.preventDefault();

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
  _dragStartPos = null; // Clear drag start position
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
    _unsealPanel(panel);
  } else {
    _sealPanel(panel);
  }

  _saveFormation();
}

function _sealPanel(panel) {
  const def = PANELS[panel.id];
  if (!def) return;

  const rect = panel.getBoundingClientRect();

  // Store original position for restoration
  panel.dataset.originalAnchor = panel.dataset.anchor || def.anchor;
  panel.dataset.originalLeft = panel.style.left;
  panel.dataset.originalTop = panel.style.top;
  panel.dataset.originalRight = panel.style.right;
  panel.dataset.originalBottom = panel.style.bottom;
  panel.dataset.originalTransform = panel.style.transform;

  // Create sealed rune
  const rune = _createRune(panel.id, def);

  // Spawn particles from original position
  _spawnSealParticles(panel);

  // Handle based on seal mode
  if (_sealMode === 'dock') {
    _sealToDock(panel, rune, rect);
  } else if (_sealMode === 'anchored') {
    _sealAnchored(panel, rune, rect);
  } else if (_sealMode === 'wander') {
    _sealWandering(panel, rune, rect);
  } else if (_sealMode === 'conjure') {
    _sealConjured(panel, rune, rect);
  }
}

function _createRune(panelId, def) {
  const rune = document.createElement('div');
  rune.className = 'sealed-rune';
  rune.dataset.panelId = panelId;
  rune.title = def.name;

  const icon = document.createElement('span');
  icon.className = 'rune-icon';
  icon.textContent = def.icon;

  const glow = document.createElement('span');
  glow.className = 'rune-glow';

  rune.appendChild(icon);
  rune.appendChild(glow);

  // Click to unseal
  const panel = document.getElementById(panelId);
  rune.addEventListener('click', () => _toggleMinimize(panel));

  return rune;
}

function _sealToDock(panel, rune, rect) {
  const tray = _sealedDock.querySelector('.dock-tray');
  tray.appendChild(rune);
  _sealedDock.classList.add('has-runes');
  // Force dock visible on mobile (CSS transition may not fire)
  _sealedDock.style.bottom = '0';

  requestAnimationFrame(() => {
    const dockRect = _sealedDock.getBoundingClientRect();
    const targetX = dockRect.left + dockRect.width / 2;
    const targetY = dockRect.top + 40;

    panel.style.transition = 'all 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
    panel.style.transform = `translate(${targetX - rect.left - rect.width/2}px, ${targetY - rect.top - rect.height/2}px) scale(0)`;
    panel.style.opacity = '0';

    setTimeout(() => {
      _finalizeSeal(panel);
      rune.classList.add('entering');
      setTimeout(() => rune.classList.remove('entering'), 500);
    }, 500);
  });
}

function _sealAnchored(panel, rune, rect) {
  // Position rune where panel was
  rune.classList.add('anchored-rune');
  rune.style.position = 'fixed';
  rune.style.left = (rect.left + rect.width / 2 - 25) + 'px';
  rune.style.top = (rect.top + rect.height / 2 - 25) + 'px';
  document.body.appendChild(rune);

  panel.style.transition = 'all 0.4s ease-out';
  panel.style.transform = 'scale(0)';
  panel.style.opacity = '0';

  setTimeout(() => {
    _finalizeSeal(panel);
    rune.classList.add('entering');
    setTimeout(() => rune.classList.remove('entering'), 500);
  }, 400);
}

function _sealWandering(panel, rune, rect) {
  // Position rune where panel was, then let it wander
  rune.classList.add('wandering-rune');
  rune.style.position = 'fixed';
  rune.style.left = (rect.left + rect.width / 2 - 25) + 'px';
  rune.style.top = (rect.top + rect.height / 2 - 25) + 'px';
  document.body.appendChild(rune);

  // Add to wandering list with velocity
  _wanderingRunes.push({
    el: rune,
    x: rect.left + rect.width / 2 - 25,
    y: rect.top + rect.height / 2 - 25,
    vx: (Math.random() - 0.5) * 2,
    vy: (Math.random() - 0.5) * 2,
  });

  // Start wandering animation if not already running
  if (_wanderingRunes.length === 1) {
    _animateWandering();
  }

  panel.style.transition = 'all 0.4s ease-out';
  panel.style.transform = 'scale(0)';
  panel.style.opacity = '0';

  setTimeout(() => {
    _finalizeSeal(panel);
    rune.classList.add('entering');
    setTimeout(() => rune.classList.remove('entering'), 500);
  }, 400);
}

function _sealConjured(panel, rune, rect) {
  // Add to a conjured container that auto-arranges
  let conjured = document.getElementById('conjured-runes');
  if (!conjured) {
    conjured = document.createElement('div');
    conjured.id = 'conjured-runes';
    conjured.className = 'conjured-runes';
    document.body.appendChild(conjured);
  }
  conjured.appendChild(rune);

  panel.style.transition = 'all 0.4s ease-out';
  panel.style.transform = 'scale(0)';
  panel.style.opacity = '0';

  setTimeout(() => {
    _finalizeSeal(panel);
    rune.classList.add('entering');
    setTimeout(() => rune.classList.remove('entering'), 500);
    _arrangeConjuredRunes();
  }, 400);
}

function _finalizeSeal(panel) {
  panel.classList.add('panel-sealed');
  panel.style.display = 'none';
  panel.style.transition = '';
  panel.style.transform = '';
  panel.style.opacity = '';
}

function _animateWandering() {
  if (_wanderingRunes.length === 0) return;

  const padding = 60;
  const maxX = window.innerWidth - padding;
  const maxY = window.innerHeight - padding;

  for (const wr of _wanderingRunes) {
    // Update position
    wr.x += wr.vx;
    wr.y += wr.vy;

    // Bounce off edges
    if (wr.x < padding || wr.x > maxX) {
      wr.vx *= -1;
      wr.x = Math.max(padding, Math.min(maxX, wr.x));
    }
    if (wr.y < padding || wr.y > maxY) {
      wr.vy *= -1;
      wr.y = Math.max(padding, Math.min(maxY, wr.y));
    }

    // Apply slight random drift
    wr.vx += (Math.random() - 0.5) * 0.1;
    wr.vy += (Math.random() - 0.5) * 0.1;

    // Clamp velocity
    const maxV = 1.5;
    wr.vx = Math.max(-maxV, Math.min(maxV, wr.vx));
    wr.vy = Math.max(-maxV, Math.min(maxV, wr.vy));

    wr.el.style.left = wr.x + 'px';
    wr.el.style.top = wr.y + 'px';
  }

  requestAnimationFrame(_animateWandering);
}

function _arrangeConjuredRunes() {
  const conjured = document.getElementById('conjured-runes');
  if (!conjured) return;

  const runes = [...conjured.children];
  const count = runes.length;
  if (count === 0) return;

  // Arrange in a circle - center of viewport on mobile, top-right on desktop
  const isMobile = window.innerWidth < 600;
  const centerX = isMobile ? window.innerWidth / 2 : window.innerWidth - 120;
  const centerY = isMobile ? window.innerHeight / 2 : 120;
  const radius = isMobile ? Math.min(60, count * 20) : 40 + count * 15;

  runes.forEach((rune, i) => {
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius - 25;
    const y = centerY + Math.sin(angle) * radius - 25;

    rune.style.transition = 'all 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)';
    rune.style.left = x + 'px';
    rune.style.top = y + 'px';
  });
}

function _migrateSealedRunes(newMode) {
  // Find all sealed runes from any location
  const allRunes = document.querySelectorAll('.sealed-rune');
  if (allRunes.length === 0) return;

  // Clear wandering animation
  _wanderingRunes = [];

  allRunes.forEach((rune, index) => {
    const panelId = rune.dataset.panelId;
    let rect = rune.getBoundingClientRect();

    // If rune is off-screen (e.g., from hidden dock), use center of viewport
    if (rect.top > window.innerHeight - 50 || rect.top < 0 ||
        rect.left > window.innerWidth - 50 || rect.left < 0) {
      rect = {
        left: window.innerWidth / 2 - 25 + index * 60,
        top: window.innerHeight / 2 - 25
      };
    }

    // Remove from current location
    rune.remove();

    // Re-add based on new mode
    if (newMode === 'dock') {
      const tray = _sealedDock.querySelector('.dock-tray');
      rune.className = 'sealed-rune';
      rune.style = '';
      tray.appendChild(rune);
      _sealedDock.classList.add('has-runes');
      _sealedDock.style.bottom = '0'; // Force visible on mobile
    } else if (newMode === 'anchored') {
      rune.classList.add('anchored-rune');
      rune.classList.remove('wandering-rune');
      rune.style.position = 'fixed';
      rune.style.left = rect.left + 'px';
      rune.style.top = rect.top + 'px';
      document.body.appendChild(rune);
      _sealedDock.classList.remove('has-runes');
      _sealedDock.style.bottom = '-80px'; // Hide dock
    } else if (newMode === 'wander') {
      rune.classList.add('wandering-rune');
      rune.classList.remove('anchored-rune');
      rune.style.position = 'fixed';
      rune.style.left = rect.left + 'px';
      rune.style.top = rect.top + 'px';
      document.body.appendChild(rune);
      _wanderingRunes.push({
        el: rune,
        x: rect.left,
        y: rect.top,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
      });
      _sealedDock.classList.remove('has-runes');
      _sealedDock.style.bottom = '-80px'; // Hide dock
    } else if (newMode === 'conjure') {
      let conjured = document.getElementById('conjured-runes');
      if (!conjured) {
        conjured = document.createElement('div');
        conjured.id = 'conjured-runes';
        conjured.className = 'conjured-runes';
        document.body.appendChild(conjured);
      }
      rune.classList.remove('anchored-rune', 'wandering-rune');
      rune.style.position = 'fixed';
      conjured.appendChild(rune);
      _sealedDock.classList.remove('has-runes');
      _sealedDock.style.bottom = '-80px'; // Hide dock
    }
  });

  // Start wandering if needed
  if (newMode === 'wander' && _wanderingRunes.length > 0) {
    _animateWandering();
  }

  // Arrange conjured if needed
  if (newMode === 'conjure') {
    _arrangeConjuredRunes();
  }
}

function _unsealPanel(panel) {
  // Find rune from any location (dock, body, or conjured container)
  let rune = _sealedDock?.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);
  if (!rune) rune = document.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);

  if (rune) {
    // Remove from wandering list if present
    _wanderingRunes = _wanderingRunes.filter(wr => wr.el !== rune);

    rune.classList.add('exiting');
    setTimeout(() => {
      rune.remove();
      // Hide dock if now empty
      const tray = _sealedDock?.querySelector('.dock-tray');
      if (tray && tray.children.length === 0) {
        _sealedDock.classList.remove('has-runes');
        _sealedDock.style.bottom = '-80px';
      }
      // Re-arrange conjured if applicable
      _arrangeConjuredRunes();
    }, 300);
  }

  // Restore panel
  panel.classList.remove('panel-sealed');
  panel.style.display = '';

  // Restore original position
  const anchorId = panel.dataset.originalAnchor;
  const anchor = ANCHORS.find(a => a.id === anchorId);

  if (anchor) {
    _snapToAnchor(panel, anchor);
  } else {
    panel.style.left = panel.dataset.originalLeft || '';
    panel.style.top = panel.dataset.originalTop || '';
    panel.style.right = panel.dataset.originalRight || '';
    panel.style.bottom = panel.dataset.originalBottom || '';
    panel.style.transform = panel.dataset.originalTransform || '';
  }

  // Conjuration animation
  panel.style.opacity = '0';
  panel.style.transform = (panel.style.transform || '') + ' scale(0.5)';

  requestAnimationFrame(() => {
    panel.style.transition = 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
    panel.style.opacity = '1';
    panel.style.transform = panel.style.transform.replace(' scale(0.5)', '');

    setTimeout(() => {
      panel.style.transition = '';
    }, 400);
  });

  _spawnRestoreParticles(panel);
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
  let minimized = [];

  if (formationId === 'grimoire-binding') {
    const saved = _loadSavedFormation();
    if (saved) {
      visible = saved.visible;
      anchors = saved.anchors;
      minimized = saved.minimized || [];
    } else {
      visible = Object.keys(PANELS);
      anchors = null;
    }
  }

  // Clear existing dock runes
  const tray = _sealedDock?.querySelector('.dock-tray');
  if (tray) tray.innerHTML = '';
  _sealedDock?.classList.remove('has-runes');

  // Hide all panels first
  Object.keys(PANELS).forEach(id => {
    const panel = document.getElementById(id);
    if (panel) {
      panel.style.display = 'none';
      panel.classList.remove('panel-sealed');
    }
  });

  // Show and position visible panels
  if (visible) {
    visible.forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;

      // Check if this panel should be minimized
      if (minimized.includes(id)) {
        _restoreSealedToDoc(panel);
      } else {
        panel.style.display = '';

        if (anchors && anchors[id]) {
          const anchor = ANCHORS.find(a => a.id === anchors[id]);
          if (anchor) _snapToAnchor(panel, anchor);
        }
      }
    });
  }

  // Auto-arrange if no specific anchors
  if (!anchors && visible) {
    _autoArrangePanels(visible.filter(id => !minimized.includes(id)));
  }

  // Conjuration animation
  _spawnConjurationCircle();
}

// Restore a sealed panel to the dock without animation (for page load)
function _restoreSealedToDoc(panel) {
  const def = PANELS[panel.id];
  if (!def) return;

  // Create rune in dock
  const tray = _sealedDock.querySelector('.dock-tray');
  const rune = document.createElement('div');
  rune.className = 'sealed-rune';
  rune.dataset.panelId = panel.id;
  rune.title = def.name;

  const icon = document.createElement('span');
  icon.className = 'rune-icon';
  icon.textContent = def.icon;

  const glow = document.createElement('span');
  glow.className = 'rune-glow';

  rune.appendChild(icon);
  rune.appendChild(glow);
  rune.addEventListener('click', () => _toggleMinimize(panel));
  tray.appendChild(rune);

  // Mark panel as sealed
  panel.classList.add('panel-sealed');
  panel.style.display = 'none';

  // Show dock
  _sealedDock.classList.add('has-runes');
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

  const enchantPage = spellbook.querySelector('.spell-page[data-spell-page="0"]');
  if (!enchantPage) return;

  // Create seal mode section
  const section = document.createElement('div');
  section.className = 'legend-section';
  section.dataset.section = 'seal-modes';

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
  header.appendChild(document.createTextNode(' Sealed Runes'));

  const body = document.createElement('div');
  body.className = 'legend-section-body';

  const sealGrid = document.createElement('div');
  sealGrid.className = 'seal-mode-grid';

  Object.entries(SEAL_MODES).forEach(([id, mode]) => {
    const btn = document.createElement('button');
    btn.className = 'seal-mode-btn' + (_sealMode === id ? ' active' : '');
    btn.dataset.mode = id;
    btn.title = mode.desc;

    const icon = document.createElement('span');
    icon.className = 'seal-mode-icon';
    icon.textContent = mode.icon;

    const name = document.createElement('span');
    name.className = 'seal-mode-name';
    name.textContent = mode.name;

    btn.appendChild(icon);
    btn.appendChild(name);

    btn.addEventListener('click', () => {
      _sealMode = id;
      sealGrid.querySelectorAll('.seal-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _migrateSealedRunes(id);
    });

    sealGrid.appendChild(btn);
  });

  body.appendChild(sealGrid);
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
