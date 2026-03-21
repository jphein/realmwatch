// ── Enchanted Forest Theme — Particle System ──
// Ambient particles: wisps, butterflies, fireflies, leaves, sparkles, fog
// All visuals via CSS animations on DOM elements inside #forest-overlay.

'use strict';

const FOREST_KEY = 'realm-forest-theme';

let _active = false;
let _overlay = null;
let _timers = [];       // spawn interval IDs
let _reducedMotion = false;

// ── Particle budgets (DOM element caps) ──
const MAX_WISPS       = 10;
const MAX_BUTTERFLIES = 8;
const MAX_FIREFLIES   = 25;
const MAX_LEAVES      = 10;
const MAX_SPARKLES    = 15;
// fog = 1 element, always

// Current counts
let _counts = { wisp: 0, butterfly: 0, firefly: 0, leaf: 0, sparkle: 0 };

// ── Helpers ──
function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

function _ensureOverlay() {
  _overlay = document.getElementById('forest-overlay');
  if (!_overlay) {
    _overlay = document.createElement('div');
    _overlay.id = 'forest-overlay';
    document.body.appendChild(_overlay);
  }
  _overlay.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;pointer-events:none;';
}

// Create a particle element, add to overlay, auto-remove after lifetime
function _spawn(className, styles, lifetimeMs) {
  if (!_active || !_overlay) return null;
  const el = document.createElement('div');
  el.className = className;
  Object.assign(el.style, styles);
  _overlay.appendChild(el);

  if (lifetimeMs && lifetimeMs > 0) {
    const t = setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      // Decrement count by type
      const type = className.replace('forest-', '');
      if (_counts[type] !== undefined) _counts[type] = Math.max(0, _counts[type] - 1);
    }, lifetimeMs);
    el._timer = t;
  }
  return el;
}

// ── Wisps: glowing orbs drifting horizontally with sine-wave vertical ──
function _spawnWisp() {
  if (_counts.wisp >= MAX_WISPS) return;
  _counts.wisp++;

  const size = randInt(8, 16);
  const dur = rand(15, 30);
  const lifetime = dur * 1000;
  const startY = rand(10, 80);
  const yOsc = rand(30, 80);
  const hue = pick(['120', '90', '60', '45']); // green, yellow-green, gold
  const color = `hsl(${hue}, 70%, 60%)`;

  _spawn('forest-wisp', {
    width: size + 'px',
    height: size + 'px',
    top: startY + 'vh',
    left: '-20px',
    '--wisp-dur': dur + 's',
    '--wisp-y-osc': yOsc + 'px',
    '--wisp-color': color,
    animationDuration: dur + 's',
    animationDelay: rand(0, 2) + 's',
  }, lifetime);
}

// ── Butterflies: fluttering wing shapes on curved paths ──
function _spawnButterfly() {
  if (_counts.butterfly >= MAX_BUTTERFLIES) return;
  _counts.butterfly++;

  const size = randInt(10, 18);
  const dur = rand(20, 40);
  const lifetime = dur * 1000;
  const startY = rand(15, 70);
  const startX = rand(-5, 10);
  const hueShift = randInt(0, 260);

  _spawn('forest-butterfly', {
    width: size + 'px',
    height: size + 'px',
    top: startY + 'vh',
    left: startX + 'vw',
    '--bf-dur': dur + 's',
    '--bf-hue': hueShift + 'deg',
    '--bf-end-x': rand(60, 100) + 'vw',
    '--bf-mid-y': rand(-80, 80) + 'px',
    animationDuration: dur + 's',
    animationDelay: rand(0, 3) + 's',
  }, lifetime);
}

// ── Fireflies: persistent pulsing dots ──
function _spawnFirefly() {
  if (_counts.firefly >= MAX_FIREFLIES) return;
  _counts.firefly++;

  const size = randInt(3, 5);
  const pulseDur = rand(2, 4);
  const x = rand(5, 95);
  const y = rand(10, 90);
  const driftDur = rand(20, 40);

  _spawn('forest-firefly', {
    width: size + 'px',
    height: size + 'px',
    left: x + 'vw',
    top: y + 'vh',
    '--ff-pulse': pulseDur + 's',
    '--ff-drift': driftDur + 's',
    '--ff-drift-x': rand(-30, 30) + 'px',
    '--ff-drift-y': rand(-30, 30) + 'px',
    animationDuration: pulseDur + 's',
    animationDelay: rand(0, pulseDur) + 's',
  }, 0); // persistent — 0 means no auto-remove
}

// ── Leaves: falling + drifting with rotation ──
function _spawnLeaf() {
  if (_counts.leaf >= MAX_LEAVES) return;
  _counts.leaf++;

  const size = randInt(8, 14);
  const dur = rand(20, 40);
  const lifetime = dur * 1000;
  const startX = rand(5, 95);
  const drift = rand(-60, 60);
  const rotation = randInt(180, 720) * (Math.random() > 0.5 ? 1 : -1);
  const color = pick(['#4a7c3f', '#6b8e23', '#c8a93e', '#b87333']);

  _spawn('forest-leaf', {
    width: size + 'px',
    height: size * 0.6 + 'px',
    left: startX + 'vw',
    top: '-20px',
    '--leaf-dur': dur + 's',
    '--leaf-drift': drift + 'px',
    '--leaf-rotation': rotation + 'deg',
    '--leaf-color': color,
    animationDuration: dur + 's',
    animationDelay: rand(0, 2) + 's',
  }, lifetime);
}

// ── Sparkles: tiny motes rising upward ──
function _spawnSparkle() {
  if (_counts.sparkle >= MAX_SPARKLES) return;
  _counts.sparkle++;

  const size = randInt(2, 4);
  const dur = rand(5, 10);
  const lifetime = dur * 1000;
  const startX = rand(5, 95);
  const startY = rand(67, 95); // bottom third
  const rise = rand(150, 400);
  const tint = pick(['#ffffffcc', '#ffd700cc', '#90ee90cc']);

  _spawn('forest-sparkle', {
    width: size + 'px',
    height: size + 'px',
    left: startX + 'vw',
    bottom: (100 - startY) + 'vh',
    '--spark-dur': dur + 's',
    '--spark-rise': rise + 'px',
    '--spark-color': tint,
    animationDuration: dur + 's',
    animationDelay: rand(0, 1.5) + 's',
  }, lifetime);
}

// ── Fog: single gradient layer at bottom ──
function _spawnFog() {
  _spawn('forest-fog', {}, 0); // persistent
}

// ── Spawn scheduling ──
function _startSpawners() {
  // Initial fireflies (persistent, created all at once with stagger)
  const ffCount = randInt(15, 25);
  for (let i = 0; i < ffCount; i++) {
    const delay = setTimeout(() => _spawnFirefly(), i * 120);
    _timers.push(delay);
  }

  // Fog — single element
  _spawnFog();

  // Stagger initial batch of other particles
  _staggerInitial(_spawnWisp, randInt(4, 6), 500);
  _staggerInitial(_spawnButterfly, randInt(2, 4), 800);
  _staggerInitial(_spawnLeaf, randInt(3, 5), 600);
  _staggerInitial(_spawnSparkle, randInt(5, 8), 300);

  // Ongoing spawn intervals
  _timers.push(setInterval(() => {
    _spawnWisp();
    if (Math.random() > 0.5) _spawnWisp();
  }, rand(3000, 5000)));

  _timers.push(setInterval(() => {
    _spawnButterfly();
  }, rand(5000, 8000)));

  _timers.push(setInterval(() => {
    _spawnLeaf();
    if (Math.random() > 0.5) _spawnLeaf();
  }, rand(2000, 4000)));

  _timers.push(setInterval(() => {
    _spawnSparkle();
    if (Math.random() > 0.4) _spawnSparkle();
  }, rand(1000, 2000)));
}

function _staggerInitial(fn, count, delayMs) {
  for (let i = 0; i < count; i++) {
    const t = setTimeout(fn, i * delayMs + rand(0, delayMs * 0.5));
    _timers.push(t);
  }
}

// ── Cleanup ──
function _clearAll() {
  // Clear all timers
  _timers.forEach(t => clearTimeout(t));
  _timers.forEach(t => clearInterval(t));
  _timers = [];

  // Clear particle auto-remove timers and remove elements
  if (_overlay) {
    while (_overlay.firstChild) {
      const el = _overlay.firstChild;
      if (el._timer) clearTimeout(el._timer);
      _overlay.removeChild(el);
    }
  }

  // Reset counts
  _counts = { wisp: 0, butterfly: 0, firefly: 0, leaf: 0, sparkle: 0 };
}

// ── Public API ──

/**
 * Toggle the enchanted forest theme on or off.
 * @param {boolean} enabled
 */
export function toggleForestTheme(enabled) {
  _reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (enabled && _reducedMotion) {
    // Respect reduced motion: only enable fog (no animated particles)
    _active = true;
    _ensureOverlay();
    document.body.classList.add('forest-active');
    _spawnFog();
    localStorage.setItem(FOREST_KEY, 'true');
    return;
  }

  if (enabled && !_active) {
    _active = true;
    _ensureOverlay();
    document.body.classList.add('forest-active');
    _startSpawners();
    localStorage.setItem(FOREST_KEY, 'true');
  } else if (!enabled && _active) {
    _active = false;
    document.body.classList.remove('forest-active');
    _clearAll();
    localStorage.setItem(FOREST_KEY, 'false');
  }
}

/**
 * Initialize forest theme. Auto-enables if localStorage setting is 'true'.
 */
export function initForestTheme() {
  const saved = localStorage.getItem(FOREST_KEY);
  if (saved === 'true') {
    toggleForestTheme(true);
  }
}
