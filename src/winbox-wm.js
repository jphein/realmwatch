'use strict';

// ── WinBox Window Manager — Arcane Pane Conjuration ──
// Wraps existing .panel DOM elements into WinBox.js windows,
// granting each panel the power of free movement across the realm map.

import WinBox from 'winbox/src/js/winbox.js';

// ── Panel Registry — The named wards of the realm ──
const PANELS = {
  'realm-panel':      'Realm Vitals',
  'legend':           'Legend',
  'spellbook':        'Spellbook',
  'realm-codex':      'Codex',
  'quest-log':        'Quest Log',
  'cartographer':     'Cartographer',
  'energy-panel':     'Energy',
  'node-list':        'Census',
  'debug-panel':      'Arcane Mirror',
  'latency-panel':    'Arcane Pulse',
  'firewall-panel':   'Realm Wards',
  'wifi-panel':       'Aether Towers',
  'scanner-panel':    'Survey Glass',
  'node-chat-dialog': 'Oracle Commune',
  'arcane-grimoire':  'Grimoire',
  'scrying-terminal': 'Scrying Terminal',
  'skills-panel':     'Inscription Codex',
};

// ── Storage keys ──
const STORAGE_MODE_KEY = 'realm-winbox-mode';
const STORAGE_POS_KEY  = 'realm-winbox-positions';

// ── Default window dimensions ──
const DEFAULT_WIDTH  = 360;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH      = 200;
const MIN_HEIGHT     = 120;

// ── State ──
// Active WinBox instances keyed by panel ID
const _instances = new Map();

// Saved positions/sizes, loaded from localStorage on init
let _savedPositions = {};

// Whether WinBox mode is currently active
let _active = false;

// Original parent elements for each panel (to restore on disable)
const _originalParents = new Map();
const _originalNextSiblings = new Map();

// ── Position persistence ──

/** Load saved window positions from the realm's memory crystal */
function _loadPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_POS_KEY);
    _savedPositions = raw ? JSON.parse(raw) : {};
  } catch {
    _savedPositions = {};
  }
}

/** Inscribe current window positions into localStorage */
function _savePositions() {
  try {
    localStorage.setItem(STORAGE_POS_KEY, JSON.stringify(_savedPositions));
  } catch { /* storage full — silently ignore */ }
}

/** Record a panel's position and size */
function _recordPosition(panelId, x, y, w, h) {
  _savedPositions[panelId] = { x, y, w, h };
  _savePositions();
}

// ── WinBox instance creation ──

/**
 * Conjure a WinBox window for the given panel element.
 * The panel DOM node is mounted (moved) into the WinBox body.
 */
function _createWinBox(panelId) {
  const el = document.getElementById(panelId);
  if (!el) {
    console.warn(`[WinBox WM] Panel element not found: ${panelId}`);
    return null;
  }

  const title = PANELS[panelId] || panelId;

  // Preserve original DOM location for restoration
  if (!_originalParents.has(panelId)) {
    _originalParents.set(panelId, el.parentNode);
    _originalNextSiblings.set(panelId, el.nextSibling);
  }

  // Retrieve saved geometry or use defaults
  const saved = _savedPositions[panelId];
  const width  = saved?.w || DEFAULT_WIDTH;
  const height = saved?.h || DEFAULT_HEIGHT;
  const x      = saved?.x ?? 'center';
  const y      = saved?.y ?? 100;

  const wb = new WinBox({
    title,
    mount: el,
    class: 'realm-window',
    width,
    height,
    x,
    y,
    minwidth:  MIN_WIDTH,
    minheight: MIN_HEIGHT,
    background: 'transparent',
    border: 0,

    // Prevent destruction — panels are eternal wards, merely hidden when dismissed
    onclose(force) {
      if (force) return; // allow forced destruction during cleanup
      this.minimize();
      // Signal panel-manager that this panel was sealed
      el.dispatchEvent(new CustomEvent('panel-sealed', {
        bubbles: true,
        detail: { panelId },
      }));
      return false; // block destroy
    },

    // Focus brings window to front (WinBox handles z-index automatically)
    onfocus() {},

    onblur() {},

    // Persist geometry on resize
    onresize(w, h) {
      _recordPosition(panelId, this.x, this.y, w, h);
    },

    // Persist geometry on move
    onmove(x, y) {
      _recordPosition(panelId, x, y, this.width, this.height);
    },

    onminimize() {
      // Let WinBox handle the minimize animation
    },
  });

  _instances.set(panelId, wb);
  return wb;
}

// ── Public API ──

/**
 * Initialize the WinBox window management system.
 * Call after all .panel elements exist in the DOM.
 * Does NOT auto-open panels — they await summoning.
 */
export function initWinBoxWM() {
  _loadPositions();

  // Restore mode from localStorage if previously enabled
  const stored = localStorage.getItem(STORAGE_MODE_KEY);
  if (stored === 'true') {
    _active = true;
  }
}

/**
 * Open (or reveal) a WinBox window for the given panel.
 * If no instance exists, conjures a new one.
 * If minimized, restores it to the mortal plane.
 */
export function openWinBoxPanel(panelId) {
  if (!_active) return;
  if (!PANELS[panelId]) {
    console.warn(`[WinBox WM] Unknown panel: ${panelId}`);
    return;
  }

  let wb = _instances.get(panelId);

  if (!wb) {
    // First summoning — conjure the window
    wb = _createWinBox(panelId);
    if (!wb) return;
  } else {
    // Already conjured — restore if minimized
    wb.restore();
    wb.focus();
  }
}

/**
 * Minimize (seal) a WinBox window without destroying it.
 * The panel can be re-opened later with openWinBoxPanel.
 */
export function closeWinBoxPanel(panelId) {
  const wb = _instances.get(panelId);
  if (wb) {
    wb.minimize();
  }
}

/**
 * Returns true if the WinBox window manager is the active pane system.
 */
export function isWinBoxMode() {
  return _active;
}

/**
 * Toggle WinBox mode on or off.
 * When disabled, all WinBox windows are destroyed and panels
 * return to their original DOM positions for legacy layout.
 */
export function toggleWinBoxMode(enabled) {
  _active = !!enabled;
  localStorage.setItem(STORAGE_MODE_KEY, _active ? 'true' : 'false');

  if (!_active) {
    // Banish all WinBox windows — return panels to their ancestral DOM homes
    for (const [panelId, wb] of _instances) {
      const el = document.getElementById(panelId);
      if (el) {
        // Restore to original DOM position
        const parent = _originalParents.get(panelId);
        const sibling = _originalNextSiblings.get(panelId);
        if (parent) {
          if (sibling && sibling.parentNode === parent) {
            parent.insertBefore(el, sibling);
          } else {
            parent.appendChild(el);
          }
        }
      }
      // Force-close to bypass the onclose prevention
      wb.close(true);
    }
    _instances.clear();
    _originalParents.clear();
    _originalNextSiblings.clear();
  }
}
