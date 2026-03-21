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
const DEFAULT_WIDTH  = 420;
const DEFAULT_HEIGHT = 340;
const MIN_WIDTH      = 200;
const MIN_HEIGHT     = 120;

// ── Cascade defaults ──
const CASCADE_OFFSET = 30;
let _cascadeIndex = 0;

// ── State ──
let _active = false;
const _instances = new Map();          // panelId → WinBox instance
const _origParents = new Map();        // panelId → { parent, nextSibling }

// ── Debounced position save ──
let _saveTimer = null;

// ── Position persistence ──

function _loadPositions() {
  try {
    const raw = localStorage.getItem(STORAGE_POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _savePositions(positions) {
  try {
    localStorage.setItem(STORAGE_POS_KEY, JSON.stringify(positions));
  } catch { /* storage full — silently ignore */ }
}

function _debouncedSavePosition(panelId, x, y, w, h) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const positions = _loadPositions();
    positions[panelId] = { x, y, w, h };
    _savePositions(positions);
    _saveTimer = null;
  }, 100);
}

// ── Cascade position for new windows ──

function _cascadePosition() {
  const idx = _cascadeIndex % 8;
  _cascadeIndex++;
  return {
    x: 100 + idx * CASCADE_OFFSET,
    y: 80  + idx * CASCADE_OFFSET,
  };
}

// ── Internal: restore a panel's DOM and close its WinBox ──

function _restorePanel(panelId, wb) {
  const panel = document.getElementById(panelId);
  if (panel) {
    // Restore native panel header visibility
    const header = panel.querySelector('.panel-header');
    if (header) header.style.display = '';

    // Reset inline styles we applied
    panel.style.position = '';

    // Move panel DOM back to original location
    const orig = _origParents.get(panelId);
    if (orig && orig.parent) {
      if (orig.nextSibling && orig.nextSibling.parentNode === orig.parent) {
        orig.parent.insertBefore(panel, orig.nextSibling);
      } else {
        orig.parent.appendChild(panel);
      }
    }
  }

  // Force-close WinBox (bypass onclose handler)
  if (wb && wb.dom) {
    wb.close(true);
  }
}

// ── Public API ──

/**
 * Initialize the WinBox window management system.
 * Loads saved positions from localStorage. If WinBox mode was previously
 * enabled, sets _active = true but does NOT auto-open panels —
 * panel-manager handles that via applyFormation.
 */
export function initWinBoxWM() {
  const stored = localStorage.getItem(STORAGE_MODE_KEY);
  if (stored === 'true') {
    _active = true;
  }
}

/**
 * Returns true if the WinBox window manager is the active pane system.
 */
export function isWinBoxMode() {
  return _active;
}

/**
 * Open (or restore/focus) a panel inside a WinBox window.
 * If WinBox mode is not active, this is a no-op.
 */
export function openWinBoxPanel(panelId) {
  if (!_active) return;

  const panel = document.getElementById(panelId);
  if (!panel) return;

  // Already has a WinBox instance — restore and focus
  const existing = _instances.get(panelId);
  if (existing) {
    if (existing.dom) {
      existing.restore();
      existing.focus();
      return;
    }
    // Dead instance — clean up and fall through to recreate
    _instances.delete(panelId);
    _origParents.delete(panelId);
  }

  // Save original DOM position for later restoration
  _origParents.set(panelId, {
    parent: panel.parentNode,
    nextSibling: panel.nextSibling,
  });

  // Hide native panel header (WinBox provides its own titlebar)
  const header = panel.querySelector('.panel-header');
  if (header) header.style.display = 'none';

  // Make panel flow naturally inside WinBox body
  panel.style.display = '';
  panel.style.position = 'relative';

  // Determine position/size — saved or cascaded default
  const positions = _loadPositions();
  const saved = positions[panelId];
  let x, y, w, h;

  if (saved) {
    x = saved.x;
    y = saved.y;
    w = saved.w;
    h = saved.h;
  } else {
    const cascade = _cascadePosition();
    x = cascade.x;
    y = cascade.y;
    w = DEFAULT_WIDTH;
    h = DEFAULT_HEIGHT;
  }

  const title = PANELS[panelId] || panelId;

  const wb = new WinBox({
    title,
    mount: panel,
    class: 'realm-window',
    background: 'transparent',
    border: 0,
    x, y,
    width: w,
    height: h,
    minwidth: MIN_WIDTH,
    minheight: MIN_HEIGHT,

    // X button: minimize instead of destroy, dispatch event for panel-manager
    onclose(force) {
      if (force) return; // allow forced destruction (returns undefined → falsy)
      this.minimize();
      document.dispatchEvent(new CustomEvent('winbox-minimized', {
        detail: { panelId },
      }));
      return true; // prevent default close
    },

    onmove(mx, my) {
      _debouncedSavePosition(panelId, mx, my, this.width, this.height);
    },

    onresize(rw, rh) {
      _debouncedSavePosition(panelId, this.x, this.y, rw, rh);
    },

    onminimize() {
      document.dispatchEvent(new CustomEvent('winbox-minimized', {
        detail: { panelId },
      }));
    },
  });

  _instances.set(panelId, wb);
}

/**
 * Minimize a WinBox panel and dispatch 'winbox-minimized' so panel-manager
 * can create a rune in the dock.
 */
export function closeWinBoxPanel(panelId) {
  const wb = _instances.get(panelId);
  if (!wb || !wb.dom) return;

  wb.minimize();
  document.dispatchEvent(new CustomEvent('winbox-minimized', {
    detail: { panelId },
  }));
}

/**
 * Toggle WinBox mode on or off.
 *
 * Enabling: sets _active, saves to localStorage. Does NOT open panels —
 * caller (panel-manager / app.js) is responsible for that.
 *
 * Disabling: restores all panel DOM back to original parents, force-closes
 * all WinBox instances, clears state.
 */
export function toggleWinBoxMode(enabled) {
  if (enabled) {
    _active = true;
    localStorage.setItem(STORAGE_MODE_KEY, 'true');
  } else {
    // Tear down every WinBox instance, restoring DOM
    for (const [panelId, wb] of _instances) {
      _restorePanel(panelId, wb);
    }
    _instances.clear();
    _origParents.clear();
    _cascadeIndex = 0;
    _active = false;
    localStorage.setItem(STORAGE_MODE_KEY, 'false');
  }
}

/**
 * Force-close and clean up a single panel's WinBox window.
 * Used when panel-manager seals a panel while WinBox mode is active.
 * Restores .panel-header display and moves DOM back to original parent.
 */
export function destroyWinBoxPanel(panelId) {
  const wb = _instances.get(panelId);
  if (!wb) return;

  _restorePanel(panelId, wb);
  _instances.delete(panelId);
  _origParents.delete(panelId);
}

/**
 * Returns the WinBox instance for a panel, or undefined.
 * Useful for panel-manager to check if a panel is currently in a WinBox window.
 */
export function getWinBoxInstance(panelId) {
  return _instances.get(panelId);
}
