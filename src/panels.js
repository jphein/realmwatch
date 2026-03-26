// ── Panel state & gauges — shared data for core modules ──
// Latency/WiFi/Firewall rendering moved to plugins; this file retains
// only the gauge DOM refs and data-model state consumed by effects.js,
// layout.js, and node-status.js.
'use strict';
import { scaleColor, scaleLabel } from './utils.js';

// ── SSE data state (setters called from app.js, getters used by effects/layout) ──
let _latencyFlat = null;
let _wifiMap = null;

export function setLatencyFlat(v) { _latencyFlat = v; }
export function setWifiMap(v)     { _wifiMap = v; }
export const getLatencyFlat = () => _latencyFlat;
export const getWifiMap     = () => _wifiMap;

// ── Cached DOM references (queried once, reused every poll cycle) ──
const DOM = {
  gForge: document.getElementById('g-forge'),
  gGpu: document.getElementById('g-gpu'),
  gMana: document.getElementById('g-mana'),
  gEssence: document.getElementById('g-essence'),
  rsVal: document.getElementById('realm-scale-val'),
  rsLabel: document.getElementById('realm-scale-label'),
  towersOnline: document.getElementById('towers-online'),
  towersTotal: document.getElementById('towers-total'),
  codexCd: document.getElementById('codex-collectd-count'),
  codexNodes: document.getElementById('codex-node-count'),
};
export { DOM };

// ── Update the gauge bars from live status data ──
export function updateGauges(d) {
  const { forge, mana, essence } = d;
  const gpu = forge.gpu;
  const gpuLoad = gpu ? gpu.load : 0;

  DOM.gForge.style.width = forge.usage + '%';
  DOM.gForge.parentElement.nextElementSibling.textContent = forge.usage.toFixed(1) + '%';
  DOM.gGpu.style.width = gpuLoad + '%';
  DOM.gGpu.parentElement.nextElementSibling.textContent = gpuLoad.toFixed(0) + '%';
  DOM.gMana.style.width = mana.usage + '%';
  DOM.gMana.parentElement.nextElementSibling.textContent = mana.usage.toFixed(1) + '%';
  DOM.gEssence.style.width = essence.usage + '%';
  DOM.gEssence.parentElement.nextElementSibling.textContent = essence.usage.toFixed(0) + '%';

  DOM.rsVal.textContent = (d.realm_scale >= 0 ? '+' : '') + d.realm_scale.toFixed(1);
  DOM.rsVal.style.color = scaleColor(d.realm_scale);
  DOM.rsLabel.textContent = scaleLabel(d.realm_scale);
}
