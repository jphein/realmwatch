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
  'cartographer':   { name: 'Cartographer', anchor: 'e', priority: 7, icon: '\uD83E\uDDED' },
  'energy-panel':   { name: 'Energy', anchor: 'w', priority: 8, icon: '\u26A1' },
  'node-list':      { name: 'Census', anchor: 'w', priority: 9, icon: '\uD83D\uDCDC' },
  'debug-panel':    { name: 'Arcane Mirror', anchor: 's', priority: 10, icon: '\uD83D\uDD2E' },
  'latency-panel':  { name: 'Arcane Pulse', anchor: 'e', priority: 11, icon: '\uD83C\uDFD3' },
  'firewall-panel': { name: 'Realm Wards', anchor: 'w', priority: 12, icon: '\uD83D\uDEE1' },
  'wifi-panel':     { name: 'Aether Towers', anchor: 'w', priority: 13, icon: '\uD83D\uDCE1' },
  'node-chat-dialog': { name: 'Oracle Commune', anchor: 'se', priority: 14, icon: '\uD83D\uDCAC' },
  'arcane-console':   { name: 'Arcane Console', anchor: 'nw', priority: 15, icon: '\u2328' },
};

// Arcane Formations (presets)
const FORMATIONS = {
  'scrying-focus': {
    name: 'Scrying Focus',
    icon: '\uD83D\uDC41',
    desc: 'Clear sight upon the realm',
    visible: [],
    anchors: {},
  },
  'wardens-watch': {
    name: "Warden's Watch",
    icon: '\uD83D\uDEE1',
    desc: 'Monitor the realm vitals',
    visible: ['realm-panel', 'energy-panel'],
    anchors: { 'realm-panel': 'ne', 'energy-panel': 'nw' },
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
let _autoSnap = true;    // Snap panels to anchor points after drag
let _showAnchors = true; // Show anchor overlay during drag
let _currentFormation = null;
let _dragging = null;
let _dragOffset = { x: 0, y: 0 };
let _anchorOverlay = null;
let _particleCanvas = null;
let _sealedDock = null;
let _wanderingRunes = []; // For wander mode animation
let _conjureAngle = 0;   // Conjure orbit animation
let _conjureRaf = 0;     // rAF handle for conjure orbit
let _anchoredDrag = null; // For dragging anchored/conjured runes

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

  // Swipe handle / grip bar
  const handle = document.createElement('div');
  handle.className = 'dock-handle';
  const grip = document.createElement('div');
  grip.className = 'dock-grip';
  handle.appendChild(grip);
  _sealedDock.appendChild(handle);

  // Container for sealed panel icons
  const tray = document.createElement('div');
  tray.className = 'dock-tray';
  _sealedDock.appendChild(tray);

  document.body.appendChild(_sealedDock);
  _attachDockDragHandlers(tray);
  _attachDrawerGesture(_sealedDock, handle);
}

function _updateDockBadge() {
  const tray = _sealedDock?.querySelector('.dock-tray');
  if (!tray) return;
  // Check if tray content overflows (hidden runes exist)
  requestAnimationFrame(() => {
    const overflows = tray.scrollHeight > tray.clientHeight + 5;
    _sealedDock.classList.toggle('has-overflow', overflows);
    if (!overflows) _sealedDock.classList.remove('dock-expanded');
  });
}

function _attachDrawerGesture(dock, handle) {
  let _touch = null; // { startY, startBottom, expanded }

  const expand = () => { dock.classList.add('dock-expanded'); };
  const collapse = () => { dock.classList.remove('dock-expanded'); };
  const isExpanded = () => dock.classList.contains('dock-expanded');

  // Tap handle to toggle
  handle.addEventListener('click', () => {
    if (isExpanded()) collapse(); else expand();
  });

  // Swipe gesture on entire dock — skip rune touches (handled by drag)
  dock.addEventListener('touchstart', e => {
    if (e.target.closest('.sealed-rune')) return;
    const t = e.touches[0];
    _touch = { startY: t.clientY, expanded: isExpanded() };
  }, { passive: true });

  dock.addEventListener('touchmove', e => {
    if (!_touch || _dockDrag) return;
    const dy = _touch.startY - e.touches[0].clientY; // positive = swipe up
    if (Math.abs(dy) > 20) {
      if (dy > 0 && !_touch.expanded) expand();
      else if (dy < 0 && _touch.expanded) collapse();
      _touch = null; // consumed
    }
  }, { passive: true });

  dock.addEventListener('touchend', () => { _touch = null; }, { passive: true });
}

// ── Dock Rune Drag-to-Reorder ──
let _dockDrag = null; // { rune, ghost, placeholder, startX, startY, offsetX, offsetY }

function _attachDockDragHandlers(tray) {
  // Track pending drag — only commit to drag after movement threshold
  let _pending = null; // { rune, pointerId, startX, startY, offsetX, offsetY }

  tray.addEventListener('pointerdown', e => {
    const rune = e.target.closest('.sealed-rune');
    if (!rune || !tray.contains(rune)) return;
    // Don't preventDefault or setPointerCapture yet — let click fire for taps
    const rect = rune.getBoundingClientRect();
    _pending = {
      rune, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
    };
  });

  tray.addEventListener('pointermove', e => {
    // Promote pending to active drag once threshold exceeded
    if (_pending && !_dockDrag && e.pointerId === _pending.pointerId) {
      const dx = Math.abs(e.clientX - _pending.startX);
      const dy = Math.abs(e.clientY - _pending.startY);
      if (dx < 10 && dy < 10) return; // not past threshold yet
      // Commit to drag — now capture and create visuals
      const p = _pending;
      _pending = null;
      p.rune.setPointerCapture(e.pointerId);

      const rect = p.rune.getBoundingClientRect();
      const ghost = p.rune.cloneNode(true);
      ghost.className = 'sealed-rune dock-drag-ghost active';
      ghost.style.cssText = `
        position: fixed; z-index: 10001; pointer-events: none;
        left: ${rect.left}px; top: ${rect.top}px;
        width: ${rect.width}px; height: ${rect.height}px;
        transition: none;
      `;
      document.body.appendChild(ghost);

      const placeholder = document.createElement('div');
      placeholder.className = 'dock-drag-placeholder';
      tray.insertBefore(placeholder, p.rune);
      p.rune.style.visibility = 'hidden';

      _dockDrag = {
        rune: p.rune, ghost, placeholder, tray,
        pointerId: e.pointerId,
        offsetX: p.offsetX, offsetY: p.offsetY,
      };
    }

    if (!_dockDrag || e.pointerId !== _dockDrag.pointerId) return;
    e.preventDefault();
    const d = _dockDrag;

    d.ghost.style.left = (e.clientX - d.offsetX) + 'px';
    d.ghost.style.top = (e.clientY - d.offsetY) + 'px';

    // Find insertion point — works for both single-row flex and multi-row grid
    const siblings = [...d.tray.querySelectorAll('.sealed-rune:not([style*="visibility: hidden"])')];
    let insertBefore = null;
    for (const sib of siblings) {
      const sr = sib.getBoundingClientRect();
      if (!sr.width) continue; // skip display:none runes
      // If pointer is above this row, insert before
      if (e.clientY < sr.top) { insertBefore = sib; break; }
      // If pointer is within this row, check X
      if (e.clientY < sr.bottom && e.clientX < sr.left + sr.width / 2) {
        insertBefore = sib; break;
      }
    }

    if (insertBefore) {
      d.tray.insertBefore(d.placeholder, insertBefore);
    } else {
      d.tray.appendChild(d.placeholder);
    }
    d.placeholder.after(d.rune);

    _spawnDockParticle(e.clientX, e.clientY);
  });

  const endDockDrag = (e) => {
    // Clear pending on any pointer up (tap — let click fire naturally)
    if (_pending && e.pointerId === _pending.pointerId) {
      _pending = null;
      return;
    }
    if (!_dockDrag || e.pointerId !== _dockDrag.pointerId) return;
    const d = _dockDrag;
    _dockDrag = null;

    const targetRect = d.placeholder.getBoundingClientRect();
    d.ghost.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
    d.ghost.style.left = targetRect.left + 'px';
    d.ghost.style.top = targetRect.top + 'px';

    setTimeout(() => {
      d.placeholder.replaceWith(d.rune);
      d.rune.style.visibility = '';
      d.ghost.remove();
      d.tray.classList.remove('reordering');
      _spawnDockBurst(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2);
      _saveFormation();
    }, 300);
  };

  tray.addEventListener('pointerup', endDockDrag);
  tray.addEventListener('pointercancel', endDockDrag);
}

function _spawnDockParticle(x, y) {
  const p = document.createElement('div');
  p.className = 'dock-particle';
  p.style.left = x + 'px';
  p.style.top = y + 'px';
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 600);
}

function _spawnDockBurst(cx, cy) {
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const p = document.createElement('div');
    p.className = 'dock-particle burst';
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.setProperty('--dx', Math.cos(angle) * 30 + 'px');
    p.style.setProperty('--dy', Math.sin(angle) * 30 + 'px');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 500);
  }
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

    // Add seal button to header
    const sealBtn = document.createElement('button');
    sealBtn.className = 'panel-seal-btn';
    sealBtn.innerHTML = '◈';
    sealBtn.title = 'Seal panel to dock';
    sealBtn.addEventListener('click', e => {
      e.stopPropagation();
      _toggleMinimize(panel);
    });
    header.appendChild(sealBtn);

    header.style.cursor = 'grab';
    header.addEventListener('mousedown', e => _startDrag(e, panel));
    header.addEventListener('touchstart', e => _startDrag(e, panel), { passive: false });

    // Double-click to minimize/restore (kept as backup)
    header.addEventListener('dblclick', () => _toggleMinimize(panel));
  });

  document.addEventListener('mousemove', _onDrag);
  document.addEventListener('touchmove', _onDrag, { passive: false });
  document.addEventListener('mouseup', _endDrag);
  document.addEventListener('touchend', _endDrag);
}

let _dragStartPos = null;
let _dragThreshold = 10; // pixels before drag actually starts

function _startDrag(e, panel) {
  if (e.target.closest('.panel-close, .panel-seal-btn, button, input, select')) return;
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
      if (_autoSnap && _showAnchors && !document.body.classList.contains('panel-mode-auto')) _anchorOverlay.classList.add('visible');
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

  if (_autoSnap && !document.body.classList.contains('panel-mode-auto')) {
    const rect = panel.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const anchor = _findNearestAnchor(centerX, centerY);
    _snapToAnchor(panel, anchor);
    _flashAnchorRune(anchor);
  } else {
    // Free placement — just keep where it was dropped
    panel.dataset.anchor = '';
  }

  // Cleanup
  panel.classList.remove('panel-dragging');
  panel.style.transition = '';
  panel.style.zIndex = '';
  _anchorOverlay.classList.remove('visible');
  _stopParticleTrail();

  _dragging = null;
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
    _saveFormation();
  } else {
    _sealPanel(panel);
    // _saveFormation is called from _finalizeSeal after animation completes
  }
}

function _sealPanel(panel) {
  const def = PANELS[panel.id];
  if (!def) return;

  const rect = panel.getBoundingClientRect();

  // Store original position for restoration (computed rect as fallback for CSS-positioned panels)
  panel.dataset.originalAnchor = panel.dataset.anchor || def.anchor;
  panel.dataset.originalLeft = panel.style.left || (rect.left + 'px');
  panel.dataset.originalTop = panel.style.top || (rect.top + 'px');
  panel.dataset.originalRight = panel.style.right;
  panel.dataset.originalBottom = panel.style.bottom;
  panel.dataset.originalTransform = panel.style.transform;
  panel.dataset.originalWidth = rect.width;
  panel.dataset.originalHeight = rect.height;

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

  const label = document.createElement('span');
  label.className = 'rune-label';
  label.textContent = def.name;

  rune.appendChild(icon);
  rune.appendChild(glow);
  rune.appendChild(label);

  // Click to unseal (dock mode uses this; anchored/conjured use drag handler)
  const panel = document.getElementById(panelId);
  rune.addEventListener('click', (e) => {
    if (rune._dragManaged) return; // Handled by _makeRuneDraggable
    _toggleMinimize(panel);
  });

  return rune;
}

function _insertRuneInOrder(tray, rune) {
  const panel = document.getElementById(rune.dataset.panelId);
  const rightIds = (panel?.dataset.dockRight || '').split(',').filter(Boolean);
  const leftIds = (panel?.dataset.dockLeft || '').split(',').filter(Boolean);

  // Try first available right neighbor
  for (const id of rightIds) {
    const sib = tray.querySelector(`.sealed-rune[data-panel-id="${id}"]`);
    if (sib) { tray.insertBefore(rune, sib); return; }
  }
  // Try last available left neighbor
  for (let i = leftIds.length - 1; i >= 0; i--) {
    const sib = tray.querySelector(`.sealed-rune[data-panel-id="${leftIds[i]}"]`);
    if (sib) { sib.after(rune); return; }
  }
  tray.appendChild(rune);
}

function _sealToDock(panel, rune, rect) {
  const tray = _sealedDock.querySelector('.dock-tray');
  _insertRuneInOrder(tray, rune);
  _sealedDock.classList.add('has-runes');
  // Force dock visible on mobile (CSS transition may not fire)
  _sealedDock.style.bottom = '0';

  requestAnimationFrame(() => {
    // Target the rune's actual position in the tray (not dock center)
    const runeRect = rune.getBoundingClientRect();
    const targetX = runeRect.left + runeRect.width / 2;
    const targetY = runeRect.top + runeRect.height / 2;

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
  _makeRuneDraggable(rune);

  panel.style.transition = 'all 0.4s ease-out';
  panel.style.transform = 'scale(0)';
  panel.style.opacity = '0';

  setTimeout(() => {
    _finalizeSeal(panel);
    rune.classList.add('entering');
    setTimeout(() => rune.classList.remove('entering'), 500);
  }, 400);
}

// ── Draggable Runes (anchored + conjured modes) ──
function _makeRuneDraggable(rune) {
  rune._dragManaged = true;
  let startX, startY, origLeft, origTop, moved;

  function onDown(e) {
    // Skip if rune is in the dock tray — dock has its own drag system
    if (rune.closest('.dock-tray')) return;
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX; startY = pt.clientY;
    origLeft = parseFloat(rune.style.left) || 0;
    origTop = parseFloat(rune.style.top) || 0;
    moved = false;
    rune.classList.add('rune-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }

  function onMove(e) {
    e.preventDefault();
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX, dy = pt.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    moved = true;
    rune.style.left = (origLeft + dx) + 'px';
    rune.style.top = (origTop + dy) + 'px';
    rune.style.transition = 'none';
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    rune.classList.remove('rune-dragging');
    rune.style.transition = '';
    // If not moved, treat as click (unseal)
    if (!moved) {
      const panel = document.getElementById(rune.dataset.panelId);
      if (panel) _toggleMinimize(panel);
    }
  }

  rune.addEventListener('mousedown', onDown);
  rune.addEventListener('touchstart', onDown, { passive: false });
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
  // Add to conjured constellation
  let conjured = document.getElementById('conjured-runes');
  if (!conjured) {
    conjured = _createConjuredContainer();
  }
  rune.style.position = 'fixed';
  conjured.appendChild(rune);
  _makeRuneDraggable(rune);

  panel.style.transition = 'all 0.4s ease-out';
  panel.style.transform = 'scale(0)';
  panel.style.opacity = '0';

  setTimeout(() => {
    _finalizeSeal(panel);
    rune.classList.add('entering');
    setTimeout(() => rune.classList.remove('entering'), 500);
    _arrangeConjuredRunes();
    _startConjureOrbit();
  }, 400);
}

function _createConjuredContainer() {
  const conjured = document.createElement('div');
  conjured.id = 'conjured-runes';
  conjured.className = 'conjured-runes';
  // Central sigil
  const sigil = document.createElement('div');
  sigil.className = 'conjure-sigil';
  sigil.innerHTML = `<svg viewBox="0 0 120 120" width="120" height="120">
    <circle cx="60" cy="60" r="55" fill="none" stroke="rgba(160,120,220,0.15)" stroke-width="1"/>
    <circle cx="60" cy="60" r="40" fill="none" stroke="rgba(160,120,220,0.1)" stroke-width="0.5" stroke-dasharray="4 4"/>
    <circle cx="60" cy="60" r="25" fill="none" stroke="rgba(160,120,220,0.08)" stroke-width="0.5"/>
    <polygon points="60,10 107,82 13,82" fill="none" stroke="rgba(180,140,255,0.12)" stroke-width="0.5"/>
    <polygon points="60,110 13,38 107,38" fill="none" stroke="rgba(180,140,255,0.12)" stroke-width="0.5"/>
    <circle cx="60" cy="60" r="4" fill="rgba(200,170,255,0.3)"/>
  </svg>`;
  conjured.appendChild(sigil);
  // Orbit ring (visual only)
  const ring = document.createElement('div');
  ring.className = 'conjure-orbit-ring';
  conjured.appendChild(ring);
  document.body.appendChild(conjured);
  return conjured;
}

function _finalizeSeal(panel) {
  panel.classList.add('panel-sealed');
  panel.style.display = 'none';
  panel.style.transition = '';
  panel.style.transform = '';
  panel.style.opacity = '';
  _saveFormation();
  _updateDockBadge();
  // Notify layout system that a panel was sealed
  document.dispatchEvent(new CustomEvent('panel-layout-change', { detail: { action: 'seal', id: panel.id } }));
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

  const runes = [...conjured.querySelectorAll('.sealed-rune')];
  const count = runes.length;
  if (count === 0) return;

  // Position constellation: bottom-right on desktop, center on mobile
  const isMobile = window.innerWidth < 600;
  const centerX = isMobile ? window.innerWidth / 2 : window.innerWidth - 140;
  const centerY = isMobile ? window.innerHeight / 2 : window.innerHeight - 140;
  const radius = Math.max(55, 35 + count * 12);

  // Position sigil and orbit ring at center
  const sigil = conjured.querySelector('.conjure-sigil');
  const ring = conjured.querySelector('.conjure-orbit-ring');
  if (sigil) {
    sigil.style.left = (centerX - 60) + 'px';
    sigil.style.top = (centerY - 60) + 'px';
  }
  if (ring) {
    ring.style.left = (centerX - radius - 8) + 'px';
    ring.style.top = (centerY - radius - 8) + 'px';
    ring.style.width = (radius * 2 + 16) + 'px';
    ring.style.height = (radius * 2 + 16) + 'px';
  }

  // Store constellation data on each rune for orbit animation
  runes.forEach((rune, i) => {
    rune.dataset.orbitIndex = i;
    rune.dataset.orbitTotal = count;
    rune.dataset.orbitCx = centerX;
    rune.dataset.orbitCy = centerY;
    rune.dataset.orbitR = radius;
    // Initial position
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const x = centerX + Math.cos(angle) * radius - 25;
    const y = centerY + Math.sin(angle) * radius - 25;
    rune.style.transition = 'all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
    rune.style.left = x + 'px';
    rune.style.top = y + 'px';
    // Stagger glow intensity by position
    rune.style.animationDelay = -(i * 0.7) + 's';
  });
}

function _startConjureOrbit() {
  if (_conjureRaf) return;
  _conjureAngle = 0;
  function tick() {
    const conjured = document.getElementById('conjured-runes');
    if (!conjured || _sealMode !== 'conjure') { _conjureRaf = 0; return; }
    const runes = [...conjured.querySelectorAll('.sealed-rune')];
    if (runes.length === 0) { _conjureRaf = 0; return; }
    _conjureAngle += 0.003; // Slow orbit
    runes.forEach(rune => {
      if (rune.classList.contains('rune-dragging')) return;
      const i = parseInt(rune.dataset.orbitIndex) || 0;
      const n = parseInt(rune.dataset.orbitTotal) || 1;
      const cx = parseFloat(rune.dataset.orbitCx) || window.innerWidth / 2;
      const cy = parseFloat(rune.dataset.orbitCy) || window.innerHeight / 2;
      const r = parseFloat(rune.dataset.orbitR) || 60;
      // Each rune has its own orbit offset + slight wobble
      const baseAngle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const angle = baseAngle + _conjureAngle;
      const wobble = Math.sin(_conjureAngle * 3 + i * 1.7) * 4;
      const x = cx + Math.cos(angle) * (r + wobble) - 25;
      const y = cy + Math.sin(angle) * (r + wobble) - 25;
      rune.style.transition = 'none';
      rune.style.left = x + 'px';
      rune.style.top = y + 'px';
    });
    _conjureRaf = requestAnimationFrame(tick);
  }
  _conjureRaf = requestAnimationFrame(tick);
}

function _stopConjureOrbit() {
  if (_conjureRaf) { cancelAnimationFrame(_conjureRaf); _conjureRaf = 0; }
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
      _makeRuneDraggable(rune);
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
      if (!conjured) conjured = _createConjuredContainer();
      rune.classList.remove('anchored-rune', 'wandering-rune');
      rune.style.position = 'fixed';
      conjured.appendChild(rune);
      _makeRuneDraggable(rune);
      _sealedDock.classList.remove('has-runes');
      _sealedDock.style.bottom = '-80px'; // Hide dock
    }
  });

  // Start wandering if needed
  if (newMode === 'wander' && _wanderingRunes.length > 0) {
    _animateWandering();
  }

  // Stop conjure orbit if leaving conjure mode
  if (newMode !== 'conjure') {
    _stopConjureOrbit();
    const old = document.getElementById('conjured-runes');
    if (old) old.remove();
  }

  // Arrange conjured and start orbit if entering conjure mode
  if (newMode === 'conjure') {
    _arrangeConjuredRunes();
    _startConjureOrbit();
  }
}

function _unsealPanel(panel) {
  // Find rune from any location (dock, body, or conjured container)
  let rune = _sealedDock?.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);
  if (!rune) rune = document.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);

  if (rune) {
    // Remove from wandering list if present
    _wanderingRunes = _wanderingRunes.filter(wr => wr.el !== rune);

    // Remember full dock context so re-sealing puts it back in the same slot
    const allRight = [], allLeft = [];
    let s = rune.nextElementSibling;
    while (s) { if (s.classList.contains('sealed-rune')) allRight.push(s.dataset.panelId); s = s.nextElementSibling; }
    s = rune.previousElementSibling;
    while (s) { if (s.classList.contains('sealed-rune')) allLeft.unshift(s.dataset.panelId); s = s.previousElementSibling; }
    panel.dataset.dockRight = allRight.join(',');
    panel.dataset.dockLeft = allLeft.join(',');

    rune.classList.add('exiting');
    setTimeout(() => {
      rune.remove();
      _updateDockBadge();
      // Hide dock if now empty
      const tray = _sealedDock?.querySelector('.dock-tray');
      if (tray && tray.children.length === 0) {
        _sealedDock.classList.remove('has-runes');
        _sealedDock.style.bottom = '-80px';
        _sealedDock.classList.remove('dock-expanded');
      }
      // Re-arrange conjured if applicable
      _arrangeConjuredRunes();
    }, 300);
  }

  // Restore panel
  panel.classList.remove('panel-sealed');
  panel.style.display = '';

  // Re-check visibility toggle so spellbook checkbox stays in sync
  const _visMap = {
    'realm-panel': 'vis-statuspanel', 'legend': 'vis-legend', 'spellbook': 'vis-spellbook',
    'realm-codex': 'vis-codex', 'quest-log': 'vis-questlog', 'node-list': 'vis-nodelist',
    'cartographer': 'vis-cartographer', 'energy-panel': 'vis-energy',
    'debug-panel': 'vis-debug', 'latency-panel': 'vis-latency',
    'firewall-panel': 'vis-firewall',
    'wifi-panel': 'vis-wifi',
  };
  const _visCb = document.getElementById(_visMap[panel.id]);
  if (_visCb && !_visCb.checked) _visCb.checked = true;

  // Restore to exact saved position, clamped to viewport
  const savedLeft = panel.dataset.originalLeft;
  const savedTop = panel.dataset.originalTop;
  const savedRight = panel.dataset.originalRight;
  const savedBottom = panel.dataset.originalBottom;

  if (savedLeft || savedTop) {
    let x = parseFloat(savedLeft) || 0;
    let y = parseFloat(savedTop) || 0;
    const pw = parseFloat(panel.dataset.originalWidth) || 200;
    const ph = parseFloat(panel.dataset.originalHeight) || 100;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 20;

    // Clamp so at least pad pixels are visible on each edge
    x = Math.max(pad - pw + 60, Math.min(vw - 60, x));
    y = Math.max(pad, Math.min(vh - 40, y));

    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = '';
    if (panel.dataset.originalAnchor) panel.dataset.anchor = panel.dataset.originalAnchor;
  } else if (savedRight || savedBottom) {
    panel.style.left = savedLeft || '';
    panel.style.top = savedTop || '';
    panel.style.right = savedRight || '';
    panel.style.bottom = savedBottom || '';
    panel.style.transform = panel.dataset.originalTransform || '';
    if (panel.dataset.originalAnchor) panel.dataset.anchor = panel.dataset.originalAnchor;
  } else if (!document.body.classList.contains('panel-mode-auto')) {
    // No saved position — snap to anchor (skip in enchant mode, auto-arrange handles it)
    const anchorId = panel.dataset.originalAnchor;
    const anchor = ANCHORS.find(a => a.id === anchorId);
    if (anchor) _snapToAnchor(panel, anchor);
  }

  // Conjuration animation — save base transform, animate scale, restore
  const baseTransform = panel.style.transform || '';
  panel.style.opacity = '0';
  panel.style.transform = (baseTransform ? baseTransform + ' ' : '') + 'scale(0.5)';

  requestAnimationFrame(() => {
    panel.style.transition = 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
    panel.style.opacity = '1';
    panel.style.transform = baseTransform;

    setTimeout(() => {
      panel.style.transition = '';
    }, 400);
  });

  _spawnRestoreParticles(panel);
  // Notify layout system that a panel was unsealed
  document.dispatchEvent(new CustomEvent('panel-layout-change', { detail: { action: 'unseal', id: panel.id } }));
}

// ── Particle Effects ──
let _particles = [];
let _trailActive = false;
let _trailX = 0, _trailY = 0;

function _startParticleTrail(x, y) {
  _trailActive = true;
  _trailX = x;
  _trailY = y;
  if (!_particleLoopRunning) _animateParticles();
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

let _particleLoopRunning = false;
function _animateParticles() {
  if (!_trailActive && _particles.length === 0) {
    _particleLoopRunning = false;
    return;
  }
  _particleLoopRunning = true;

  const ctx = _particleCanvas.getContext('2d');
  ctx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);

  // Swap-and-pop removal (avoids O(n) splice shifts)
  let writeIdx = 0;
  for (let i = 0, len = _particles.length; i < len; i++) {
    const p = _particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.02;

    if (p.life <= 0) continue;
    if (writeIdx !== i) _particles[writeIdx] = p;
    writeIdx++;

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.life * 0.8})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life * 2, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.life * 0.3})`;
    ctx.fill();
  }
  _particles.length = writeIdx;

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
  if (!_particleLoopRunning) _animateParticles();
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
  if (!_particleLoopRunning) _animateParticles();
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

  // Show and position visible panels (non-minimized first)
  if (visible) {
    visible.forEach(id => {
      if (minimized.includes(id)) return; // handled below in dock order
      const panel = document.getElementById(id);
      if (!panel) return;
      panel.style.display = '';
      if (anchors && anchors[id]) {
        const anchor = ANCHORS.find(a => a.id === anchors[id]);
        if (anchor) _snapToAnchor(panel, anchor);
      }
    });
    // Restore sealed panels in saved dock order
    minimized.forEach(id => {
      const panel = document.getElementById(id);
      if (!panel) return;
      _restoreSealedToDoc(panel, anchors?.[id] || PANELS[id]?.anchor);
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
function _restoreSealedToDoc(panel, anchorId) {
  const def = PANELS[panel.id];
  if (!def) return;

  // Store anchor so _unsealPanel can position correctly
  panel.dataset.originalAnchor = anchorId || def.anchor;

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

  const label = document.createElement('span');
  label.className = 'rune-label';
  label.textContent = def.name;

  rune.appendChild(icon);
  rune.appendChild(glow);
  rune.appendChild(label);
  rune.addEventListener('click', () => {
    if (rune._dragManaged) return;
    _toggleMinimize(panel);
  });
  tray.appendChild(rune);

  // Mark panel as sealed
  panel.classList.add('panel-sealed');
  panel.style.display = 'none';

  // Show dock
  _sealedDock.classList.add('has-runes');
  _updateDockBadge();
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
  if (!_particleLoopRunning) _animateParticles();
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

    const isSealed = panel.classList.contains('panel-sealed');
    if (panel.style.display !== 'none' || isSealed) {
      state.visible.push(id);
      if (panel.dataset.anchor) {
        state.anchors[id] = panel.dataset.anchor;
      }
    }
  });

  // Save minimized list in dock DOM order (preserves user's drag reorder)
  const tray = _sealedDock?.querySelector('.dock-tray');
  if (tray) {
    tray.querySelectorAll('.sealed-rune').forEach(rune => {
      const pid = rune.dataset.panelId;
      if (pid) state.minimized.push(pid);
    });
  }

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

  // ── Drag Settings ──
  const settingsWrap = document.createElement('div');
  settingsWrap.className = 'seal-settings';

  // Auto-snap toggle
  const snapRow = document.createElement('label');
  snapRow.className = 'seal-setting-row';
  const snapCb = document.createElement('input');
  snapCb.type = 'checkbox';
  snapCb.checked = _autoSnap;
  snapCb.addEventListener('change', () => { _autoSnap = snapCb.checked; });
  snapRow.appendChild(snapCb);
  snapRow.appendChild(document.createTextNode(' Auto-snap to anchors'));
  settingsWrap.appendChild(snapRow);

  // Show anchors toggle
  const anchorRow = document.createElement('label');
  anchorRow.className = 'seal-setting-row';
  const anchorCb = document.createElement('input');
  anchorCb.type = 'checkbox';
  anchorCb.checked = _showAnchors;
  anchorCb.addEventListener('change', () => { _showAnchors = anchorCb.checked; });
  anchorRow.appendChild(anchorCb);
  anchorRow.appendChild(document.createTextNode(' Show anchor overlay'));
  settingsWrap.appendChild(anchorRow);

  body.appendChild(settingsWrap);

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

// Register a panel created after initPanelManager (e.g. lazy dialogs)
export function registerPanel(panel) {
  if (!panel || !PANELS[panel.id]) return;
  const header = panel.querySelector('.panel-header');
  if (!header) return;

  // Add seal button
  const sealBtn = document.createElement('button');
  sealBtn.className = 'panel-seal-btn';
  sealBtn.innerHTML = '◈';
  sealBtn.title = 'Seal panel to dock';
  sealBtn.addEventListener('click', e => {
    e.stopPropagation();
    _toggleMinimize(panel);
  });
  header.appendChild(sealBtn);

  header.style.cursor = 'grab';
  header.addEventListener('mousedown', e => _startDrag(e, panel));
  header.addEventListener('touchstart', e => _startDrag(e, panel), { passive: false });
  header.addEventListener('dblclick', () => _toggleMinimize(panel));
}

// ── Exports ──
export { FORMATIONS, PANELS, ANCHORS, _saveFormation as saveFormation, _unsealPanel as unsealPanel };
