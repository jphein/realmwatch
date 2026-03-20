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

// Icon mode: 'sigil' (SVG), 'emoji' (unicode), 'nova' (PNG images)
let _iconMode = localStorage.getItem('realm-icon-mode') || 'nova';

// SVG sigil icons — small hand-crafted rune marks for each panel
// Colored sigil helper — uses explicit stroke/fill colors per panel
const _SIGIL = (d, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

const SIGILS = {
  // Realm Vitals — beating heart with pulse line (crimson/rose)
  'realm-panel': _SIGIL('<path d="M12 21C12 21 4 15 4 9.5a4.5 4.5 0 018-2.9 4.5 4.5 0 018 2.9C20 15 12 21 12 21z" stroke="#e06060" fill="rgba(220,80,80,0.15)"/><path d="M4 12h3l2-3 2 6 2-4 2 2h5" stroke="#ff8888" stroke-width="1.2"/>'),
  // Legend — compass rose (warm gold)
  'legend': _SIGIL('<circle cx="12" cy="12" r="9" stroke="#c8a84c"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3" stroke="#c8a84c"/><path d="M12 7l2 5-2 1-2-1z" fill="#dcc060" stroke="none"/><path d="M12 17l-2-5 2-1 2 1z" fill="#a08030" stroke="none"/>'),
  // Spellbook — open tome with sparkle (arcane violet)
  'spellbook': _SIGIL('<path d="M4 19V5a2 2 0 012-2h12a2 2 0 012 2v14" stroke="#b088d0"/><path d="M4 19a2 2 0 012-2h12a2 2 0 012 2" stroke="#b088d0"/><path d="M12 3v14" stroke="#9070b0" opacity="0.6"/><path d="M15 8l1-2 1 2-2 1z" fill="#d0a0ff" stroke="none"/>'),
  // Codex — scroll with seal (warm parchment/amber)
  'realm-codex': _SIGIL('<path d="M8 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2h-2" stroke="#c8a060"/><path d="M8 3a2 2 0 012-2h4a2 2 0 012 2" stroke="#c8a060"/><circle cx="12" cy="13" r="3" stroke="#ddb870" fill="rgba(200,160,80,0.12)"/><path d="M12 10v-2m0 8v2" stroke="#ddb870"/>'),
  // Quest Log — scroll with quill (emerald green)
  'quest-log': _SIGIL('<path d="M18 3a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2" stroke="#70b870"/><path d="M8 9h8M8 13h5" stroke="#88d088"/><path d="M16 2l3 3-8 8-3 1 1-3z" stroke="#60c060" fill="rgba(80,180,80,0.1)"/>'),
  // Cartographer — drafting compass (sky blue)
  'cartographer': _SIGIL('<circle cx="12" cy="6" r="2" stroke="#70a8d8" fill="rgba(100,160,220,0.15)"/><path d="M12 8l-5 13M12 8l5 13" stroke="#70a8d8"/><path d="M8.5 16h7" stroke="#88c0e8"/>'),
  // Energy — arcane crystal (electric cyan/teal)
  'energy-panel': _SIGIL('<path d="M12 2l6 7-6 13-6-13z" stroke="#50c8c8" fill="rgba(60,200,200,0.12)"/><path d="M6 9h12" stroke="#60d8d8"/><path d="M9 9l3 13 3-13" stroke="#40b0b0" opacity="0.4"/>'),
  // Census — people/nodes roster (warm tan)
  'node-list': _SIGIL('<circle cx="9" cy="7" r="3" stroke="#c8a870"/><path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" stroke="#c8a870"/><circle cx="18" cy="9" r="2" stroke="#ddb870"/><path d="M18 14a3 3 0 013 3v1" stroke="#ddb870"/>'),
  // Arcane Mirror — eye of seeing (mystic purple)
  'debug-panel': _SIGIL('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" stroke="#a070c0"/><circle cx="12" cy="12" r="3" stroke="#c090e0" fill="rgba(180,120,220,0.1)"/><circle cx="12" cy="12" r="1" fill="#d0a0ff" stroke="none"/>'),
  // Arcane Pulse — ripple rings (electric blue)
  'latency-panel': _SIGIL('<circle cx="12" cy="12" r="2" fill="#60a0ff" stroke="none"/><circle cx="12" cy="12" r="5" stroke="#6090e0"/><circle cx="12" cy="12" r="8" stroke="#6090e0" opacity="0.5"/><circle cx="12" cy="12" r="11" stroke="#6090e0" opacity="0.25"/>'),
  // Realm Wards — shield with rune (fire orange/red)
  'firewall-panel': _SIGIL('<path d="M12 2l8 4v5c0 5.5-3.8 10.2-8 12-4.2-1.8-8-6.5-8-12V6z" stroke="#d88040" fill="rgba(220,120,50,0.1)"/><path d="M12 8v4m0 2v1" stroke="#ff9050" stroke-width="2"/>'),
  // Aether Towers — tower with signal (electric indigo)
  'wifi-panel': _SIGIL('<path d="M10 21h4V10h-4z" stroke="#7080d0"/><path d="M6 21h2V14H6z" stroke="#7080d0"/><path d="M16 21h2V14h-2z" stroke="#7080d0"/><path d="M12 7a5 5 0 00-5 5" fill="none" stroke="#90a0ff"/><path d="M12 4a8 8 0 00-8 8" fill="none" stroke="#90a0ff" opacity="0.5"/><circle cx="12" cy="7" r="1.5" fill="#a0b0ff" stroke="none"/>'),
  // Oracle Commune — speech crystal (ethereal mint)
  'node-chat-dialog': _SIGIL('<path d="M21 12a9 9 0 01-9 9l-4-2H5a2 2 0 01-2-2v-3a9 9 0 0118-2z" stroke="#60c0a0" fill="rgba(80,200,160,0.08)"/><path d="M9 12h.01M12 12h.01M15 12h.01" stroke="#80e0c0" stroke-width="2.5"/>'),
  // Grimoire — tome with arcane star (deep gold/amber)
  'arcane-grimoire': _SIGIL('<path d="M4 19V5a2 2 0 012-2h12a2 2 0 012 2v14" stroke="#b89040"/><path d="M4 19a2 2 0 012-2h12a2 2 0 012 2" stroke="#b89040"/><path d="M12 7l1.5 3 3 .5-2.2 2 .7 3L12 14.5 8.8 16l.7-3.5-2-1.5 3-.5z" fill="#e0b848" stroke="none"/>'),
  // Scrying Terminal — crystal ball with inner light (frost blue)
  'scrying-terminal': _SIGIL('<circle cx="12" cy="11" r="7" stroke="#70b0d8" fill="rgba(100,170,220,0.08)"/><path d="M9 20h6" stroke="#88c0e0"/><path d="M10 18h4" stroke="#88c0e0"/><path d="M10 9a3 3 0 013-3" stroke="#a0d0f0" opacity="0.5"/><circle cx="12" cy="11" r="2" fill="#90c8f0" stroke="none" opacity="0.5"/>'),
};

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
  'scanner-panel':  { name: 'Survey Glass', anchor: 'e', priority: 17, icon: '\uD83D\uDD2D' },
  'node-chat-dialog': { name: 'Oracle Commune', anchor: 'se', priority: 14, icon: '\uD83D\uDCAC' },
  'arcane-grimoire':  { name: 'Grimoire', anchor: 'nw', priority: 15, icon: '\uD83D\uDCD6' },
  'scrying-terminal': { name: 'Scrying Terminal', anchor: 'sw', priority: 16, icon: '\uD83D\uDD2E' },
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
let _autoSnap = false;   // Snap panels to anchor points after drag
let _showAnchors = false; // Show anchor overlay during drag
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
let _anchorElements = [];     // Cached ley-anchor DOM elements (populated in _createAnchorOverlay)
let _prevHighlightedAnchorId = null; // Track previously highlighted anchor to avoid redundant classList toggles

// ── HUD Settings ──
const HUD_POSITIONS = {
  'top-left':     { top: '10px', left: '10px', right: 'auto', bottom: 'auto' },
  'top-right':    { top: '10px', left: 'auto', right: '10px', bottom: 'auto' },
  'bottom-left':  { top: 'auto', left: '10px', right: 'auto', bottom: '60px' },
  'bottom-right': { top: 'auto', left: 'auto', right: '10px', bottom: '60px' },
};
let _hudPosition = 'top-left';
let _hudOpacity = 1.0;
let _hudScale = 1.0;
let _hudDraggable = false;
let _hudCustomPos = null; // { x, y } when position === 'custom'
let _hudEl = null;
let _hudDragState = null;

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

  // Ornamental corner flourishes
  const ornL = document.createElement('div');
  ornL.className = 'dock-ornament dock-orn-l';
  _sealedDock.appendChild(ornL);
  const ornR = document.createElement('div');
  ornR.className = 'dock-ornament dock-orn-r';
  _sealedDock.appendChild(ornR);

  // Swipe handle / grip bar
  const handle = document.createElement('div');
  handle.className = 'dock-handle';
  const grip = document.createElement('div');
  grip.className = 'dock-grip';
  handle.appendChild(grip);
  _sealedDock.appendChild(handle);

  // Player stats HUD bar
  const hud = document.createElement('div');
  hud.className = 'dock-hud';

  const hudLevel = document.createElement('div');
  hudLevel.className = 'hud-level';
  const levelNum = document.createElement('span');
  levelNum.className = 'hud-level-num';
  levelNum.textContent = '1';
  hudLevel.appendChild(levelNum);
  hud.appendChild(hudLevel);

  const hudXp = document.createElement('div');
  hudXp.className = 'hud-xp';
  const xpBar = document.createElement('div');
  xpBar.className = 'hud-xp-bar';
  const xpFill = document.createElement('div');
  xpFill.className = 'hud-xp-fill';
  xpFill.style.width = '0%';
  xpBar.appendChild(xpFill);
  hudXp.appendChild(xpBar);
  const xpText = document.createElement('span');
  xpText.className = 'hud-xp-text';
  xpText.textContent = '0/100';
  hudXp.appendChild(xpText);
  hud.appendChild(hudXp);

  const sep1 = document.createElement('div');
  sep1.className = 'hud-sep';
  hud.appendChild(sep1);

  const hudGold = document.createElement('div');
  hudGold.className = 'hud-currency hud-gold';
  const coinIcon = document.createElement('span');
  coinIcon.className = 'hud-coin-icon';
  hudGold.appendChild(coinIcon);
  const goldNum = document.createElement('span');
  goldNum.className = 'hud-gold-num';
  goldNum.textContent = '0';
  hudGold.appendChild(goldNum);
  hud.appendChild(hudGold);

  const sep2 = document.createElement('div');
  sep2.className = 'hud-sep';
  hud.appendChild(sep2);

  const hudGems = document.createElement('div');
  hudGems.className = 'hud-currency hud-gems';
  const gemIcon = document.createElement('span');
  gemIcon.className = 'hud-gem-icon';
  hudGems.appendChild(gemIcon);
  const gemsNum = document.createElement('span');
  gemsNum.className = 'hud-gems-num';
  gemsNum.textContent = '0';
  hudGems.appendChild(gemsNum);
  hud.appendChild(hudGems);

  // Append HUD to body (not dock) to escape transform containment
  _hudEl = hud;
  document.body.appendChild(hud);
  _applyHudSettings();
  _attachHudDrag();

  // Container for sealed panel icons
  const tray = document.createElement('div');
  tray.className = 'dock-tray';
  _sealedDock.appendChild(tray);

  // Arcane energy line between runes (decorative)
  const leyline = document.createElement('div');
  leyline.className = 'dock-leyline';
  _sealedDock.appendChild(leyline);

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

  // Swipe gesture on entire dock — including rune touches.
  // Vertical swipes expand/collapse; horizontal ones are handled by dock drag.
  dock.addEventListener('touchstart', e => {
    const t = e.touches[0];
    _touch = { startY: t.clientY, startX: t.clientX, expanded: isExpanded(), consumed: false };
  }, { passive: true });

  dock.addEventListener('touchmove', e => {
    if (!_touch || _touch.consumed || _dockDrag) return;
    const t = e.touches[0];
    const dy = _touch.startY - t.clientY; // positive = swipe up
    const dx = Math.abs(t.clientX - _touch.startX);
    // Only act on predominantly vertical swipes
    if (Math.abs(dy) > 20 && Math.abs(dy) > dx) {
      if (dy > 0 && !_touch.expanded) expand();
      else if (dy < 0 && _touch.expanded) collapse();
      _touch.consumed = true; // consumed
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
      if (dx < 12 && dy < 12) return; // not past threshold yet
      // Only commit to drag if movement is predominantly horizontal.
      // Vertical swipes are drawer expand/collapse — cancel and let that handle it.
      if (dy > dx) { _pending = null; return; }
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
  // Canvas-based particle — reuses the existing _particleCanvas + _animateParticles loop
  _particles.push({
    x, y,
    vx: (Math.random() - 0.5) * 1.5,
    vy: -Math.random() * 2 - 0.5,
    life: 1,
    size: 3,
    hue: 270 + Math.random() * 30, // purple to match .dock-particle CSS
  });
  if (!_particleLoopRunning) _animateParticles();
}

function _spawnDockBurst(cx, cy) {
  // Canvas-based burst — pushes 8 directional particles into the shared pool
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    _particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * 3,
      vy: Math.sin(angle) * 3,
      life: 1,
      size: 3,
      hue: 270 + Math.random() * 30,
    });
  }
  if (!_particleLoopRunning) _animateParticles();
}

function _createAnchorOverlay() {
  _anchorOverlay = document.createElement('div');
  _anchorOverlay.id = 'ley-anchor-overlay';

  // Build anchors with safe DOM methods — cache elements to avoid querySelectorAll in drag loop
  _anchorElements = [];
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
    _anchorElements.push(anchor);
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

    // Add seal button to header (skip if already added by registerPanel)
    if (!header.querySelector('.panel-seal-btn')) {
      const sealBtn = document.createElement('button');
      sealBtn.className = 'panel-seal-btn';
      sealBtn.innerHTML = '◈';
      sealBtn.title = 'Seal panel to dock';
      sealBtn.addEventListener('click', e => {
        e.stopPropagation();
        _toggleMinimize(panel);
      });
      header.appendChild(sealBtn);
    }

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

  // Highlight nearest anchor — use cached elements, only toggle when anchor changes
  const nearest = _findNearestAnchor(clientX, clientY);
  if (nearest.id !== _prevHighlightedAnchorId) {
    for (let i = 0; i < _anchorElements.length; i++) {
      const el = _anchorElements[i];
      if (el.dataset.anchor === _prevHighlightedAnchorId) el.classList.remove('active');
      if (el.dataset.anchor === nearest.id) el.classList.add('active');
    }
    _prevHighlightedAnchorId = nearest.id;
  }

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
  // Clear anchor highlight tracking
  if (_prevHighlightedAnchorId) {
    for (let i = 0; i < _anchorElements.length; i++) {
      if (_anchorElements[i].dataset.anchor === _prevHighlightedAnchorId) {
        _anchorElements[i].classList.remove('active');
        break;
      }
    }
    _prevHighlightedAnchorId = null;
  }
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

  // Skip child rendering during shrink animation (content-visibility: hidden via CSS)
  panel.classList.add('panel-sealing');

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

// Elder Futhark rune sets — each rune gets a unique inscription
const _RUNE_INSCRIPTIONS = [
  'ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ ᚷ ᚹ ᚺ ᚾ ᛁ ᛃ ᛈ ᛊ ᛏ ᛒ ᛗ ᛚ ᛞ ᛟ',
  'ᛟ ᛞ ᛚ ᛗ ᛒ ᛏ ᛊ ᛈ ᛃ ᛁ ᚾ ᚺ ᚹ ᚷ ᚲ ᚱ ᚨ ᚦ ᚢ ᚠ',
  'ᚦ ᛗ ᚱ ᛊ ᚹ ᛞ ᚠ ᛃ ᚲ ᛟ ᚢ ᛈ ᚷ ᛒ ᚨ ᛏ ᚺ ᛁ ᚾ ᛚ',
  'ᛊ ᚠ ᛞ ᚲ ᛗ ᚦ ᛃ ᚱ ᛟ ᚹ ᛈ ᚢ ᛒ ᚷ ᛁ ᚨ ᛚ ᚺ ᛏ ᚾ',
];
let _runeIdx = 0;

function _createRuneRing(panelId) {
  const ring = document.createElement('div');
  ring.className = 'rune-ring';
  const text = _RUNE_INSCRIPTIONS[_runeIdx++ % _RUNE_INSCRIPTIONS.length];
  const uid = 'rr-' + panelId;
  ring.innerHTML = `<svg viewBox="0 0 76 76"><defs><path id="${uid}" d="M38,6 a32,32 0 1,1 0,64 a32,32 0 1,1 0,-64"/></defs><text font-size="5.5" font-family="serif"><textPath href="#${uid}">${text}</textPath></text></svg>`;
  return ring;
}

const _RUNE_COLORS = {
  'realm-panel':      '220,80,80',    // crimson
  'legend':           '200,168,76',   // gold
  'spellbook':        '176,136,208',  // violet
  'realm-codex':      '200,160,96',   // amber
  'quest-log':        '96,192,96',    // emerald
  'cartographer':     '100,160,220',  // sky blue
  'energy-panel':     '60,200,200',   // cyan
  'node-list':        '200,168,112',  // tan
  'debug-panel':      '160,112,192',  // purple
  'latency-panel':    '96,144,224',   // electric blue
  'firewall-panel':   '216,128,64',   // fire orange
  'wifi-panel':       '112,128,208',  // indigo
  'node-chat-dialog': '96,192,160',   // mint
  'arcane-grimoire':  '184,144,64',   // deep gold
  'scrying-terminal': '112,176,216',  // frost blue
};

const _RUNE_ACCENTS = {
  'realm-panel':    { accent: '#e07070', glow: 'rgba(220,80,80,0.25)' },
  'legend':         { accent: '#dcc060', glow: 'rgba(220,190,80,0.25)' },
  'spellbook':      { accent: '#b888e0', glow: 'rgba(160,100,220,0.25)' },
  'realm-codex':    { accent: '#d8b060', glow: 'rgba(210,170,80,0.25)' },
  'quest-log':      { accent: '#70c080', glow: 'rgba(80,200,120,0.2)' },
  'cartographer':   { accent: '#80b0e8', glow: 'rgba(100,160,230,0.25)' },
  'energy-panel':   { accent: '#60c8b8', glow: 'rgba(60,200,180,0.25)' },
  'node-list':      { accent: '#dcc060', glow: 'rgba(220,190,80,0.25)' },
  'debug-panel':    { accent: '#b888e0', glow: 'rgba(160,100,220,0.25)' },
  'latency-panel':  { accent: '#80b0e8', glow: 'rgba(100,160,230,0.25)' },
  'firewall-panel': { accent: '#e07070', glow: 'rgba(220,80,80,0.25)' },
  'wifi-panel':     { accent: '#8890d0', glow: 'rgba(100,100,200,0.25)' },
  'node-chat-dialog':{ accent: '#70c8a8', glow: 'rgba(80,200,160,0.25)' },
  'arcane-grimoire': { accent: '#d8b060', glow: 'rgba(210,170,80,0.25)' },
  'scrying-terminal':{ accent: '#80b8d8', glow: 'rgba(100,170,210,0.25)' },
};

function _createRune(panelId, def) {
  const rune = document.createElement('div');
  rune.className = 'sealed-rune';
  rune.dataset.panelId = panelId;
  rune.title = def.name;
  if (_RUNE_COLORS[panelId]) rune.style.setProperty('--rune-color', _RUNE_COLORS[panelId]);

  const accents = _RUNE_ACCENTS[panelId] || _RUNE_ACCENTS[panelId.replace(/-panel$/, '')];
  if (accents) {
    rune.style.setProperty('--accent', accents.accent);
    rune.style.setProperty('--accent-glow', accents.glow);
  }

  const icon = document.createElement('span');
  icon.className = 'rune-icon';
  _setRuneIcon(icon, panelId, def);

  const glow = document.createElement('span');
  glow.className = 'rune-glow';

  const ring = _createRuneRing(panelId);
  const embers = document.createElement('div');
  embers.className = 'rune-embers';

  const label = document.createElement('span');
  label.className = 'rune-label';
  label.textContent = def.name;

  rune.appendChild(ring);
  rune.appendChild(embers);
  rune.appendChild(icon);
  rune.appendChild(glow);
  rune.appendChild(label);

  const innerGlow = document.createElement('div');
  innerGlow.className = 'rune-inner-glow';
  rune.appendChild(innerGlow);

  const carvedRing = document.createElement('div');
  carvedRing.className = 'rune-carved-ring';
  rune.appendChild(carvedRing);

  const glint = document.createElement('div');
  glint.className = 'rune-glint-flash';
  rune.appendChild(glint);

  const aura = document.createElement('div');
  aura.className = 'rune-outer-aura';
  rune.appendChild(aura);

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
  panel.classList.remove('panel-sealing');
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
  const el = _anchorElements.find(e => e.dataset.anchor === anchor.id);
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
      // Add any new panels not in saved state (default to sealed in dock)
      for (const id of Object.keys(PANELS)) {
        if (!visible.includes(id) && !minimized.includes(id)) {
          visible.push(id);
          minimized.push(id);
        }
      }
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
  if (_RUNE_COLORS[panel.id]) rune.style.setProperty('--rune-color', _RUNE_COLORS[panel.id]);

  const icon = document.createElement('span');
  icon.className = 'rune-icon';
  _setRuneIcon(icon, panel.id, def);

  const glow = document.createElement('span');
  glow.className = 'rune-glow';

  const ring = _createRuneRing(panel.id);
  const embers = document.createElement('div');
  embers.className = 'rune-embers';

  const label = document.createElement('span');
  label.className = 'rune-label';
  label.textContent = def.name;

  rune.appendChild(ring);
  rune.appendChild(embers);
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
    sealMode: _sealMode,
    autoSnap: _autoSnap,
    showAnchors: _showAnchors,
    hudPosition: _hudPosition,
    hudOpacity: _hudOpacity,
    hudScale: _hudScale,
    hudDraggable: _hudDraggable,
    hudCustomPos: _hudCustomPos,
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
    // Restore settings before UI creation so buttons/checkboxes init correctly
    if (saved.sealMode) _sealMode = saved.sealMode;
    if (saved.autoSnap != null) _autoSnap = saved.autoSnap;
    if (saved.showAnchors != null) _showAnchors = saved.showAnchors;
    if (saved.hudPosition) _hudPosition = saved.hudPosition;
    if (saved.hudOpacity != null) _hudOpacity = saved.hudOpacity;
    if (saved.hudScale != null) _hudScale = saved.hudScale;
    if (saved.hudDraggable != null) _hudDraggable = saved.hudDraggable;
    if (saved.hudCustomPos) _hudCustomPos = saved.hudCustomPos;
    applyFormation('grimoire-binding');
    // Migrate runes to saved seal mode (applyFormation always loads into dock)
    if (_sealMode !== 'dock') _migrateSealedRunes(_sealMode);
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
      _saveFormation();
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
  snapCb.addEventListener('change', () => { _autoSnap = snapCb.checked; _saveFormation(); });
  snapRow.appendChild(snapCb);
  snapRow.appendChild(document.createTextNode(' Auto-snap to anchors'));
  settingsWrap.appendChild(snapRow);

  // Show anchors toggle
  const anchorRow = document.createElement('label');
  anchorRow.className = 'seal-setting-row';
  const anchorCb = document.createElement('input');
  anchorCb.type = 'checkbox';
  anchorCb.checked = _showAnchors;
  anchorCb.addEventListener('change', () => { _showAnchors = anchorCb.checked; _saveFormation(); });
  anchorRow.appendChild(anchorCb);
  anchorRow.appendChild(document.createTextNode(' Show anchor overlay'));
  settingsWrap.appendChild(anchorRow);

  body.appendChild(settingsWrap);

  section.appendChild(header);
  section.appendChild(body);

  enchantPage.insertBefore(section, enchantPage.firstChild);

  // ── HUD Settings Section ──
  const hudSection = document.createElement('div');
  hudSection.className = 'legend-section';
  hudSection.dataset.section = 'hud-settings';

  const hudHeader = document.createElement('div');
  hudHeader.className = 'legend-section-header';
  hudHeader.dataset.accent = 'gold';

  const hudChevron = document.createElement('span');
  hudChevron.className = 'legend-chevron';
  hudChevron.textContent = '\u25BE';

  const hudIcon = document.createElement('span');
  hudIcon.className = 'sec-icon';
  hudIcon.textContent = '\u2726'; // ✦

  hudHeader.appendChild(hudChevron);
  hudHeader.appendChild(hudIcon);
  hudHeader.appendChild(document.createTextNode(' HUD Settings'));

  const hudBody = document.createElement('div');
  hudBody.className = 'legend-section-body';

  // ─ Position row ─
  const posLabel = document.createElement('div');
  posLabel.className = 'hud-setting-label';
  posLabel.textContent = 'Position';
  hudBody.appendChild(posLabel);

  const posGrid = document.createElement('div');
  posGrid.className = 'hud-pos-grid';

  const posPresets = [
    { id: 'top-left', icon: '◤', title: 'Top Left' },
    { id: 'top-right', icon: '◥', title: 'Top Right' },
    { id: 'bottom-left', icon: '◣', title: 'Bottom Left' },
    { id: 'bottom-right', icon: '◢', title: 'Bottom Right' },
  ];

  posPresets.forEach(preset => {
    const btn = document.createElement('button');
    btn.className = 'hud-pos-btn' + (_hudPosition === preset.id ? ' active' : '');
    btn.dataset.pos = preset.id;
    btn.title = preset.title;
    btn.textContent = preset.icon;
    btn.addEventListener('click', () => {
      _hudPosition = preset.id;
      _hudCustomPos = null;
      _applyHudSettings();
      _saveFormation();
      posGrid.querySelectorAll('.hud-pos-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
    posGrid.appendChild(btn);
  });

  hudBody.appendChild(posGrid);

  // ─ Draggable toggle ─
  const dragRow = document.createElement('label');
  dragRow.className = 'seal-setting-row';
  const dragCb = document.createElement('input');
  dragCb.type = 'checkbox';
  dragCb.checked = _hudDraggable;
  dragCb.addEventListener('change', () => {
    _hudDraggable = dragCb.checked;
    _applyHudSettings();
    _saveFormation();
  });
  dragRow.appendChild(dragCb);
  dragRow.appendChild(document.createTextNode(' Drag to reposition'));
  hudBody.appendChild(dragRow);

  // ─ Opacity slider ─
  const opacRow = document.createElement('div');
  opacRow.className = 'hud-slider-row';
  const opacLabel = document.createElement('span');
  opacLabel.className = 'hud-slider-label';
  opacLabel.textContent = 'Opacity';
  const opacVal = document.createElement('span');
  opacVal.className = 'hud-slider-val';
  opacVal.textContent = Math.round(_hudOpacity * 100) + '%';
  const opacSlider = document.createElement('input');
  opacSlider.type = 'range';
  opacSlider.className = 'hud-slider';
  opacSlider.min = '20';
  opacSlider.max = '100';
  opacSlider.value = Math.round(_hudOpacity * 100);
  opacSlider.addEventListener('input', () => {
    _hudOpacity = opacSlider.value / 100;
    opacVal.textContent = opacSlider.value + '%';
    _applyHudSettings();
  });
  opacSlider.addEventListener('change', () => _saveFormation());
  opacRow.appendChild(opacLabel);
  opacRow.appendChild(opacSlider);
  opacRow.appendChild(opacVal);
  hudBody.appendChild(opacRow);

  // ─ Scale slider ─
  const scaleRow = document.createElement('div');
  scaleRow.className = 'hud-slider-row';
  const scaleLabel = document.createElement('span');
  scaleLabel.className = 'hud-slider-label';
  scaleLabel.textContent = 'Scale';
  const scaleVal = document.createElement('span');
  scaleVal.className = 'hud-slider-val';
  scaleVal.textContent = Math.round(_hudScale * 100) + '%';
  const scaleSlider = document.createElement('input');
  scaleSlider.type = 'range';
  scaleSlider.className = 'hud-slider';
  scaleSlider.min = '50';
  scaleSlider.max = '200';
  scaleSlider.value = Math.round(_hudScale * 100);
  scaleSlider.addEventListener('input', () => {
    _hudScale = scaleSlider.value / 100;
    scaleVal.textContent = scaleSlider.value + '%';
    _applyHudSettings();
  });
  scaleSlider.addEventListener('change', () => _saveFormation());
  scaleRow.appendChild(scaleLabel);
  scaleRow.appendChild(scaleSlider);
  scaleRow.appendChild(scaleVal);
  hudBody.appendChild(scaleRow);

  hudSection.appendChild(hudHeader);
  hudSection.appendChild(hudBody);

  // Insert after seal modes section
  section.after(hudSection);
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

  // Add seal button (skip if already added by _attachDragHandlers)
  if (!header.querySelector('.panel-seal-btn')) {
    const sealBtn = document.createElement('button');
    sealBtn.className = 'panel-seal-btn';
    sealBtn.innerHTML = '◈';
    sealBtn.title = 'Seal panel to dock';
    sealBtn.addEventListener('click', e => {
      e.stopPropagation();
      _toggleMinimize(panel);
    });
    header.appendChild(sealBtn);
  }

  header.style.cursor = 'grab';
  header.addEventListener('mousedown', e => _startDrag(e, panel));
  header.addEventListener('touchstart', e => _startDrag(e, panel), { passive: false });
  header.addEventListener('dblclick', () => _toggleMinimize(panel));
}

// ── Emoji / Sigil icon switching ──

function _setRuneIcon(iconEl, panelId, def) {
  if (_iconMode === 'nova') {
    iconEl.textContent = '';
    iconEl.classList.remove('rune-icon--emoji');
    const existingImg = iconEl.querySelector('.rune-icon-img');
    if (existingImg) existingImg.remove();
    const img = document.createElement('img');
    img.src = '/assets/icons/style-b/' + panelId + '.png';
    img.alt = def.name || panelId;
    img.className = 'rune-icon-img';
    img.draggable = false;
    iconEl.appendChild(img);
    return;
  }
  const leftoverImg = iconEl.querySelector('.rune-icon-img');
  if (leftoverImg) leftoverImg.remove();
  if (_iconMode === 'emoji' || !SIGILS[panelId]) {
    iconEl.textContent = def.icon;
    iconEl.classList.add('rune-icon--emoji');
  } else {
    const tpl = document.createElement('template');
    tpl.innerHTML = SIGILS[panelId];
    iconEl.textContent = '';
    iconEl.appendChild(tpl.content);
    iconEl.classList.remove('rune-icon--emoji');
  }
}

function setIconMode(mode) {
  _iconMode = mode;
  localStorage.setItem('realm-icon-mode', mode);
  // Refresh all existing runes
  document.querySelectorAll('.sealed-rune').forEach(rune => {
    const pid = rune.dataset.panelId;
    const def = PANELS[pid];
    if (!def) return;
    const icon = rune.querySelector('.rune-icon');
    if (icon) _setRuneIcon(icon, pid, def);
  });
}

window.setIconMode = setIconMode;

// ── HUD Settings Engine ──

function _applyHudSettings() {
  if (!_hudEl) return;
  _hudEl.style.opacity = _hudOpacity;
  _hudEl.style.setProperty('--hud-scale', _hudScale);
  _hudEl.style.transform = `scale(${_hudScale})`;
  _hudEl.style.transformOrigin = 'top left';
  _hudEl.classList.toggle('hud-draggable', _hudDraggable);

  if (_hudPosition === 'custom' && _hudCustomPos) {
    _hudEl.style.top = _hudCustomPos.y + 'px';
    _hudEl.style.left = _hudCustomPos.x + 'px';
    _hudEl.style.right = 'auto';
    _hudEl.style.bottom = 'auto';
  } else {
    const pos = HUD_POSITIONS[_hudPosition] || HUD_POSITIONS['top-left'];
    _hudEl.style.top = pos.top;
    _hudEl.style.left = pos.left;
    _hudEl.style.right = pos.right;
    _hudEl.style.bottom = pos.bottom;
  }
}

function _attachHudDrag() {
  if (!_hudEl) return;
  _hudEl.addEventListener('pointerdown', (e) => {
    if (!_hudDraggable) return;
    e.preventDefault();
    const rect = _hudEl.getBoundingClientRect();
    _hudDragState = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
    };
    _hudEl.setPointerCapture(e.pointerId);
    _hudEl.classList.add('hud-dragging');
  });

  _hudEl.addEventListener('pointermove', (e) => {
    if (!_hudDragState) return;
    const dx = e.clientX - _hudDragState.startX;
    const dy = e.clientY - _hudDragState.startY;
    const x = Math.max(0, Math.min(window.innerWidth - 100, _hudDragState.origX + dx));
    const y = Math.max(0, Math.min(window.innerHeight - 32, _hudDragState.origY + dy));
    _hudEl.style.top = y + 'px';
    _hudEl.style.left = x + 'px';
    _hudEl.style.right = 'auto';
    _hudEl.style.bottom = 'auto';
  });

  const endDrag = () => {
    if (!_hudDragState) return;
    _hudDragState = null;
    _hudEl.classList.remove('hud-dragging');
    // Save custom position
    _hudPosition = 'custom';
    _hudCustomPos = {
      x: parseInt(_hudEl.style.left) || 10,
      y: parseInt(_hudEl.style.top) || 10,
    };
    _saveFormation();
    // Update UI button states
    document.querySelectorAll('.hud-pos-btn').forEach(b => b.classList.remove('active'));
  };
  _hudEl.addEventListener('pointerup', endDrag);
  _hudEl.addEventListener('pointercancel', endDrag);
}

// ── Dock HUD ──

function _animateCount(el, from, to, duration) {
  const start = performance.now();
  const delta = to - from;
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    el.textContent = Math.round(from + delta * t);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updateDockHUD(stats, animate) {
  if (!_hudEl) return;
  const levelEl = _hudEl.querySelector('.hud-level-num');
  const xpFill = _hudEl.querySelector('.hud-xp-fill');
  const xpText = _hudEl.querySelector('.hud-xp-text');
  const goldEl = _hudEl.querySelector('.hud-gold-num');
  const gemsEl = _hudEl.querySelector('.hud-gems-num');
  if (!levelEl) return;

  const rawPct = stats.xp_next > 0 ? Math.min(100, (stats.xp_in_level / stats.xp_next) * 100) : 0;
  const pct = Math.max(5, rawPct);  // always show a sliver of mana

  if (animate) {
    const oldLevel = parseInt(levelEl.textContent) || 1;
    const oldGold = parseInt(goldEl.textContent) || 0;
    const oldGems = parseInt(gemsEl.textContent) || 0;
    if (stats.level !== oldLevel) levelEl.textContent = stats.level;
    _animateCount(goldEl, oldGold, stats.gold, 600);
    _animateCount(gemsEl, oldGems, stats.gems, 600);
    _hudEl.classList.add('hud-pulse');
    setTimeout(() => _hudEl.classList.remove('hud-pulse'), 800);
  } else {
    levelEl.textContent = stats.level;
    goldEl.textContent = stats.gold;
    gemsEl.textContent = stats.gems;
  }

  xpFill.style.width = pct + '%';
  xpText.textContent = stats.xp_in_level + '/' + stats.xp_next;
}

window.updateDockHUD = updateDockHUD;

// ── Exports ──
export { FORMATIONS, PANELS, ANCHORS, _saveFormation as saveFormation, _unsealPanel as unsealPanel, setIconMode };
