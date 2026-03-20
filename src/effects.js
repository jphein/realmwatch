'use strict';
import { _perfTier, setPerfTier, _PERF } from './config.js';
import { _topology } from './topology.js';
import { getTopoNodeMap } from './terrain.js';
import { getLatencyFlat } from './panels.js';
import { applyPerfClasses, syncQualityUI, getAutoDetectEnabled } from './spellbook.js';
import { scale, isZoomActive } from './map-view.js';

// ── Magic Motes Trail (for draggable elements) ──
const moteCanvas = document.createElement('canvas');
moteCanvas.id = 'mote-canvas';
moteCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:300';
document.body.appendChild(moteCanvas);
const moteCtx = moteCanvas.getContext('2d');
let motes = [];

// FPS counter (toggle with Ctrl+Shift+F)
const _fpsEl = document.createElement('div');
_fpsEl.style.cssText = 'position:fixed;top:4px;right:4px;z-index:9999;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.7);padding:3px 8px;border-radius:3px;pointer-events:none;display:none;line-height:1.5;min-width:200px';
document.body.appendChild(_fpsEl);
let _fpsFrames = 0, _fpsLast = performance.now(), _fpsMotes = 0;
let _fpsFrameTimes = [];  // last 60 frame timestamps for jitter/percentile
let _fpsLongFrames = 0;   // frames >20ms (jank)
let _fpsMinFps = 999, _fpsMaxFt = 0;  // worst fps / worst frame time in window

// ── Client RTT ping (measures browser → map_server roundtrip) ──
let _pingRtt = null;        // latest RTT in ms
let _pingHistory = [];      // sliding window of recent RTTs
const _PING_WINDOW = 12;    // keep last 12 measurements (60s at 5s interval)
let _pingJitter = null;     // stddev of recent RTTs

function _doPing() {
  const t0 = performance.now();
  fetch('/ping').then(() => {
    const rtt = performance.now() - t0;
    _pingRtt = rtt;
    _pingHistory.push(rtt);
    if (_pingHistory.length > _PING_WINDOW) _pingHistory.shift();
    // Compute jitter as standard deviation
    if (_pingHistory.length >= 2) {
      const mean = _pingHistory.reduce((a, b) => a + b, 0) / _pingHistory.length;
      const variance = _pingHistory.reduce((a, v) => a + (v - mean) ** 2, 0) / _pingHistory.length;
      _pingJitter = Math.sqrt(variance);
    }
  }).catch(() => { _pingRtt = null; });
}
_doPing();
let _pingInterval = setInterval(_doPing, 5000);

function _fpsUpdate() {
  const now = performance.now();
  _fpsFrames++;

  // Track per-frame timing for jitter stats
  _fpsFrameTimes.push(now);
  if (_fpsFrameTimes.length > 1) {
    const dt = now - _fpsFrameTimes[_fpsFrameTimes.length - 2];
    if (dt > 20) _fpsLongFrames++;
    if (dt > _fpsMaxFt) _fpsMaxFt = dt;
  }
  if (_fpsFrameTimes.length > 120) _fpsFrameTimes.splice(0, _fpsFrameTimes.length - 120);

  if (now - _fpsLast >= 1000) {
    const fps = _fpsFrames;
    if (fps < _fpsMinFps) _fpsMinFps = fps;

    // Compute 1% low (worst 1% of frame intervals)
    const intervals = [];
    for (let i = 1; i < _fpsFrameTimes.length; i++) {
      intervals.push(_fpsFrameTimes[i] - _fpsFrameTimes[i - 1]);
    }
    intervals.sort((a, b) => b - a);
    const p1 = intervals.length > 0 ? intervals[Math.floor(intervals.length * 0.01)] : 0;
    const fps1Low = p1 > 0 ? Math.round(1000 / p1) : fps;

    const fpsVisible = _fpsEl.style.display !== 'none';
    const anims = fpsVisible ? document.getAnimations().length : 0;
    const mem = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)}MB` : '--';
    const domNodes = fpsVisible ? document.querySelectorAll('*').length : 0;

    // Color code FPS
    const color = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f44';

    // Latency line: client RTT + host (gatekeeper fping) + jitter
    const cRtt = _pingRtt != null ? _pingRtt.toFixed(1) + 'ms' : '--';
    const _lf = getLatencyFlat();
    const hRtt = _lf && _lf['gatekeeper'] != null ? _lf['gatekeeper'].toFixed(1) + 'ms' : '--';
    const jit = _pingJitter != null ? _pingJitter.toFixed(1) + 'ms' : '--';
    const rttColor = _pingRtt != null ? (_pingRtt < 10 ? '#0f0' : _pingRtt < 50 ? '#ff0' : '#f44') : '#888';

    /* eslint-disable -- FPS overlay uses only local numeric values, no user input */
    _fpsEl.innerHTML =
      `<span style="color:${color};font-weight:bold">${fps}</span> fps` +
      ` <span style="color:#888">1%low:</span>${fps1Low}` +
      ` <span style="color:#888">min:</span>${_fpsMinFps}` +
      `<br>${_fpsMotes} motes | ${anims} anims` +
      `<br><span style="color:#888">jank:</span>${_fpsLongFrames} <span style="color:#888">worst:</span>${_fpsMaxFt.toFixed(1)}ms` +
      `<br><span style="color:#888">rtt:</span><span style="color:${rttColor}">${cRtt}</span>` +
      ` <span style="color:#888">host:</span>${hRtt}` +
      ` <span style="color:#888">jitter:</span>${jit}` +
      `<br><span style="color:#888">DOM:</span>${domNodes} <span style="color:#888">mem:</span>${mem}` +
      `<br><span style="color:#888">tier:</span>${_perfTier}` +
      (isZoomActive() ? ' <span style="color:#f80">ZOOM</span>' : '');
    /* eslint-enable */

    // Auto-detect weak hardware: 3 consecutive seconds below 25fps → downgrade to 'low'
    if (getAutoDetectEnabled() && _perfTier !== 'low' && _autoDetectSamples < 10) {
      _autoDetectSamples++;
      if (_autoDetectSamples > 2) {  // skip first 2s (SSE init, layout settle)
        if (fps < 25) _autoDetectLow++;
        else _autoDetectLow = 0;  // must be consecutive
        if (_autoDetectLow >= 3) {
          console.log('[perf] Auto-downgrade to low tier (avg idle fps < 25)');
          setPerfTier('low');
          applyPerfClasses();
          syncQualityUI();
        }
      }
    }

    _fpsFrames = 0;
    _fpsLast = now;
    _fpsLongFrames = 0;
    _fpsMaxFt = 0;
  }
}
let _autoDetectSamples = 0;
let _autoDetectLow = 0;

// Reset min FPS on click (useful after settling)
_fpsEl.addEventListener('click', () => { _fpsMinFps = 999; });
_fpsEl.style.pointerEvents = 'auto';
_fpsEl.style.cursor = 'pointer';
_fpsEl.title = 'Click to reset min FPS';

window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    _fpsEl.style.display = _fpsEl.style.display === 'none' ? '' : 'none';
    if (_fpsEl.style.display !== 'none') _startFpsLoop();
    const cb = document.getElementById('vis-fps-counter');
    if (cb) cb.checked = _fpsEl.style.display !== 'none';
  }
});

function resizeMoteCanvas() {
  moteCanvas.width = window.innerWidth;
  moteCanvas.height = window.innerHeight;
}
resizeMoteCanvas();
window.addEventListener('resize', resizeMoteCanvas);

export function spawnMote(x, y, color) {
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.3 + Math.random() * 1.2;
  motes.push({
    x, y,
    vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 0.5,
    vy: Math.sin(angle) * speed + (Math.random() - 0.5) * 0.5 - 0.3,
    life: 1.0,
    decay: 0.012 + Math.random() * 0.02,
    size: 1.5 + Math.random() * 2.5,
    color: color || [240, 216, 144],
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: 0.05 + Math.random() * 0.1,
  });
}

// Ambient sparkle settings
let _sparkleAmbient = 0.3;   // ambient sparkle rate (0=off, 1=max)
let _sparkleNodes = 0.5;     // node aura sparkle rate
let _sparkleLeyLines = 0.4;  // ley line sparkle rate
let _sparkleGlowSize = 1.0;  // glow multiplier

// Getters/setters for sparkle settings (used by spellbook controls in app.js)
export const getSparkleAmbient  = () => _sparkleAmbient;
export const getSparkleNodes    = () => _sparkleNodes;
export const getSparkleLeyLines = () => _sparkleLeyLines;
export const getSparkleGlowSize = () => _sparkleGlowSize;
export function setSparkleAmbient(v)  { _sparkleAmbient = v; }
export function setSparkleNodes(v)    { _sparkleNodes = v; }
export function setSparkleLeyLines(v) { _sparkleLeyLines = v; }
export function setSparkleGlowSize(v) { _sparkleGlowSize = v; }

// Cached map-world rect for sparkle spawners (updated once per spawn cycle)
let _sparkleRect = null;
const _sparkleColors = [[240,216,144],[180,200,255],[160,255,180],[200,160,255],[255,200,120]];

function _spawnAmbientSparkles() {
  if (_sparkleAmbient <= 0 || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleAmbient * 0.15 / _PERF.sparkleDiv;
  if (Math.random() < rate) {
    const c = _sparkleColors[Math.random() * 5 | 0];
    motes.push({
      x: Math.random() * moteCanvas.width, y: Math.random() * moteCanvas.height,
      vx: (Math.random() - 0.5) * 0.2, vy: -0.1 - Math.random() * 0.3,
      life: 1.0, decay: 0.004 + Math.random() * 0.008,
      size: 1 + Math.random() * 2, color: c,
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.03 + Math.random() * 0.06,
      twinkle: true,
    });
  }
}

function _spawnNodeSparkles() {
  if (_sparkleNodes <= 0 || !_topology || !_topology.nodes || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleNodes * 0.02 / _PERF.sparkleDiv;
  if (!_sparkleRect) return;
  const rect = _sparkleRect;
  const cw = moteCanvas.width, ch = moteCanvas.height;
  for (const n of _topology.nodes) {
    if (Math.random() > rate) continue;
    const iw = (n.iconStyle && n.iconStyle.width) ? parseInt(n.iconStyle.width) : 64;
    const ih = (n.iconStyle && n.iconStyle.height) ? parseInt(n.iconStyle.height) : 64;
    const sx = rect.left + (n.x + iw/2) * scale + (Math.random() - 0.5) * iw * scale * 0.6;
    const sy = rect.top + (n.y + ih/2) * scale + (Math.random() - 0.5) * ih * scale * 0.6;
    // Skip offscreen nodes
    if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
    if (motes.length >= _PERF.moteCap) break;
    const isCore = n.type === 'core';
    motes.push({
      x: sx, y: sy,
      vx: (Math.random() - 0.5) * 0.4, vy: -0.3 - Math.random() * 0.6,
      life: 1.0, decay: 0.008 + Math.random() * 0.012,
      size: isCore ? 2 + Math.random() * 2 : 1 + Math.random() * 1.5,
      color: isCore ? [255,220,100] : n.type === 'tower' ? [120,200,255] : [160,255,140],
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.04 + Math.random() * 0.08,
      twinkle: true,
    });
  }
}

const _leyColors = { wan: [100,180,255], bridge: [180,120,255], _default: [140,220,180] };
function _spawnLeyLineSparkles() {
  if (_sparkleLeyLines <= 0 || !_topology || !_topology.connections || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleLeyLines * 0.015 / _PERF.sparkleDiv;
  if (!_sparkleRect) return;
  const rect = _sparkleRect;
  const nodeMap = getTopoNodeMap();
  const cw = moteCanvas.width, ch = moteCanvas.height;
  for (const c of _topology.connections) {
    if (Math.random() > rate) continue;
    const fn = nodeMap.get(c.from), tn = nodeMap.get(c.to);
    if (!fn || !tn) continue;
    const t = Math.random();
    const sx = rect.left + (fn.x + (tn.x - fn.x) * t) * scale + (Math.random() - 0.5) * 10;
    const sy = rect.top + (fn.y + (tn.y - fn.y) * t) * scale + (Math.random() - 0.5) * 10;
    if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
    if (motes.length >= _PERF.moteCap) break;
    motes.push({
      x: sx, y: sy,
      vx: (tn.x - fn.x) * scale * 0.0004 + (Math.random() - 0.5) * 0.3,
      vy: (tn.y - fn.y) * scale * 0.0004 - 0.15,
      life: 1.0, decay: 0.01 + Math.random() * 0.015,
      size: 1 + Math.random() * 1.5,
      color: _leyColors[c.type] || _leyColors._default,
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.05 + Math.random() * 0.1,
      twinkle: true,
    });
  }
}

let _sparkleTimer = 0;
const _PI2 = Math.PI * 2;
let _moteSkipFrame = false;  // Halve frame rate when idle
let _motePaused = false;
document.addEventListener('visibilitychange', () => {
  _motePaused = document.hidden;
  // Disable connection animations when tab hidden (79 SVG repaints per frame)
  document.body.classList.toggle('reduce-motion', document.hidden);
  if (!document.hidden) {
    _ensureMoteLoop();
    // Resume ping interval when tab becomes visible
    if (!_pingInterval) { _doPing(); _pingInterval = setInterval(_doPing, 5000); }
    // Restart FPS loop if overlay is visible
    if (_fpsEl.style.display !== 'none') _startFpsLoop();
  } else {
    // Pause ping interval when tab is hidden
    clearInterval(_pingInterval); _pingInterval = null;
  }
});

// Cache sparkle rect on resize instead of in animation loop
const _sparkleRectWorld = document.getElementById('map-world');
function _updateSparkleRect() {
  if (_sparkleRectWorld) _sparkleRect = _sparkleRectWorld.getBoundingClientRect();
}
window.addEventListener('resize', _updateSparkleRect);
_updateSparkleRect();

// Separate FPS tracking loop — only runs while the FPS overlay is visible
// (also runs during the auto-detect startup window)
let _fpsLoopRunning = false;
function _fpsLoopNeeded() {
  if (_fpsEl.style.display !== 'none') return true;
  // Keep running during auto-detect startup window
  if (getAutoDetectEnabled() && _autoDetectSamples < 10) return true;
  return false;
}
function _fpsLoop() {
  if (!_fpsLoopNeeded()) { _fpsLoopRunning = false; return; }
  _fpsUpdate();
  requestAnimationFrame(_fpsLoop);
}
function _startFpsLoop() {
  if (!_fpsLoopRunning) { _fpsLoopRunning = true; requestAnimationFrame(_fpsLoop); }
}
// Start the loop initially for auto-detect
_startFpsLoop();

let _moteLoopRunning = false;
function _ensureMoteLoop() {
  if (!_moteLoopRunning) { _moteLoopRunning = true; requestAnimationFrame(animateMotes); }
}
function animateMotes() {
  // Stop loop entirely when tab hidden or zooming — restart via _ensureMoteLoop
  if (_motePaused || isZoomActive()) { _moteLoopRunning = false; return; }

  // 30fps cap — skip entire frame (spawn + physics + render) every other tick.
  // Must be before ALL work to actually halve CPU/GPU cost.
  _moteSkipFrame = !_moteSkipFrame;
  if (_moteSkipFrame) { requestAnimationFrame(animateMotes); return; }

  const cw = moteCanvas.width, ch = moteCanvas.height;

  // Spawn cycle
  _sparkleTimer++;
  const spawnDiv = _PERF.sparkleDiv;
  if (_sparkleTimer % (2 * spawnDiv) === 0) _spawnAmbientSparkles();
  if (_sparkleTimer % (8 * spawnDiv) === 0) _spawnNodeSparkles();
  if (_sparkleTimer % (6 * spawnDiv) === 0) _spawnLeyLineSparkles();

  if (motes.length === 0) {
    requestAnimationFrame(animateMotes);
    return;
  }

  moteCtx.clearRect(0, 0, cw, ch);
  const doGlow = _PERF.moteGlow;
  const doStar = _PERF.moteStarCross;
  let writeIdx = 0;

  // Batch by color to reduce fillStyle changes (major canvas perf win)
  const colorBuckets = {};
  const glowBuckets = {};

  for (let i = 0, len = motes.length; i < len; i++) {
    const m = motes[i];
    m.x += m.vx + Math.sin(m.wobble) * 0.3;
    m.y += m.vy + Math.cos(m.wobble) * 0.2;
    m.wobble += m.wobbleSpeed;
    m.life -= m.decay;
    if (m.life <= 0) continue;
    if (writeIdx !== i) motes[writeIdx] = m;
    writeIdx++;
    if (m.x < -10 || m.x > cw + 10 || m.y < -10 || m.y > ch + 10) continue;
    const [r, g, b] = m.color;
    let a = m.life * 0.8;
    if (m.twinkle) a *= 0.5 + 0.5 * Math.sin(m.wobble * 3);
    if (a < 0.01) continue;
    const sz = m.size * m.life * _sparkleGlowSize;
    // Quantize alpha to reduce unique fillStyle strings (16 buckets)
    const aq = ((a * 15 + 0.5) | 0) / 15;
    const key = `${r},${g},${b},${aq.toFixed(2)}`;
    (colorBuckets[key] || (colorBuckets[key] = [])).push(m.x, m.y, sz);
    if (doGlow) {
      const gaq = ((a * 0.12 * 15 + 0.5) | 0) / 15;
      const gkey = `${r},${g},${b},${gaq.toFixed(3)}`;
      (glowBuckets[gkey] || (glowBuckets[gkey] = [])).push(m.x, m.y, sz * 2.5);
    }
    // Star-cross (high tier only)
    if (doStar && m.twinkle && a > 0.3 && sz > 1.5) {
      moteCtx.strokeStyle = `rgba(${r},${g},${b},${(a * 0.4).toFixed(2)})`;
      moteCtx.lineWidth = 0.5;
      const cr = sz * 3;
      moteCtx.beginPath();
      moteCtx.moveTo(m.x - cr, m.y); moteCtx.lineTo(m.x + cr, m.y);
      moteCtx.moveTo(m.x, m.y - cr); moteCtx.lineTo(m.x, m.y + cr);
      moteCtx.stroke();
    }
  }
  motes.length = writeIdx;

  // Draw glow halos first (behind), then main dots — batched by color
  if (doGlow) {
    for (const key in glowBuckets) {
      const arr = glowBuckets[key];
      moteCtx.fillStyle = `rgba(${key})`;
      moteCtx.beginPath();
      for (let j = 0; j < arr.length; j += 3) {
        moteCtx.moveTo(arr[j] + arr[j+2], arr[j+1]);
        moteCtx.arc(arr[j], arr[j+1], arr[j+2], 0, _PI2);
      }
      moteCtx.fill();
    }
  }
  for (const key in colorBuckets) {
    const arr = colorBuckets[key];
    moteCtx.fillStyle = `rgba(${key})`;
    moteCtx.beginPath();
    for (let j = 0; j < arr.length; j += 3) {
      moteCtx.moveTo(arr[j] + arr[j+2], arr[j+1]);
      moteCtx.arc(arr[j], arr[j+1], arr[j+2], 0, _PI2);
    }
    moteCtx.fill();
  }

  _fpsMotes = writeIdx;
  requestAnimationFrame(animateMotes);
}
_ensureMoteLoop();

// ── Public API ──
export function clearMoteCanvas() { moteCtx.clearRect(0, 0, moteCanvas.width, moteCanvas.height); }
export function updateSparkleRect() { _updateSparkleRect(); }
export function ensureMoteLoop() { _ensureMoteLoop(); }
export function getFpsEl() { return _fpsEl; }
export function startFpsLoop() { _startFpsLoop(); }
