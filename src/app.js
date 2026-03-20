// ── App coordinator — SSE dispatch + module wiring ──
import { SSE_URL } from './config.js';
import { refreshTopology, setTopologyRefreshHook } from './topology.js';
import { initScanner } from './scan.js';
import { renderTopoLayer, setLastTopoCollectd, initTopoControls } from './terrain.js';
import { updateConnectionTraffic, updateConnectionTrafficSSE, trafficToCollectd, setTrafficScale } from './traffic.js';
import { setLatencyMap, setLatencyFlat, setWifiMap,
         updateEnergyPanel, updateLatencyPanel, handleFirewallData, renderWifiPanel,
         rebuildCensusIfNeeded, fetchWifiAPs } from './panels.js';
import { updateUI, getLastStatus, setPostUpdateHook } from './node-status.js';
import { renderEvent, updateBubblePositions, firePulse, showOffline,
         setOpenNodeChat } from './quest-log.js';
import { isZoomActive,
         setDeferredStatus, setDeferredTraffic, setDeferredEnergy, setDeferredLatency,
         setGhostDirty, applyTopoZ, setOpenPersonaEditor, invalidateGlobeZCache } from './map-view.js';
import { openPersonaEditor, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { initSpellbook, invalidateSearchIndex } from './spellbook.js';
import { saveSettings, scheduleSave } from './layout.js';
import { scheduleDebugRefresh } from './debug.js';

let liveOk = false;

// Inject build version into splash screen
const _rvEl = document.getElementById('realm-version');
if (_rvEl) _rvEl.textContent = typeof __REALM_VERSION__ !== 'undefined' ? __REALM_VERSION__ : '';

// Pre-rasterize the parchment SVG (feTurbulence is CPU-only and costs ~500ms
// per repaint on a 9600×6600 surface).  Convert it to a static bitmap so that
// zoom exit just composites a cached raster instead of re-computing fractal noise.
(function rasterizeParchment() {
  const svg = document.getElementById('map-parchment');
  if (!svg) return;
  // Wait until the browser has painted the filters at least once
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 2400; c.height = 1650; // half-res — good enough for a subtle texture
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, 2400, 1650);
      URL.revokeObjectURL(url);
      // Replace heavy SVG content with a single raster image
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const imgEl = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      imgEl.setAttribute('href', c.toDataURL('image/jpeg', 0.8));
      imgEl.setAttribute('width', '4800');
      imgEl.setAttribute('height', '3300');
      svg.appendChild(imgEl);
      console.log('Parchment pre-rasterized (feTurbulence eliminated)');
    };
    img.src = url;
  }));
})();

// Register post-update hook for firePulse + debug refresh + periodic log
setPostUpdateHook(() => {
  firePulse();
  scheduleDebugRefresh();
});

// Wire up openNodeChat for quest-log.js (async function declaration — hoisted)
setOpenNodeChat(openNodeChat);
// Wire up openPersonaEditor for map-view.js node double-tap
setOpenPersonaEditor(openPersonaEditor);
// Wire up spellbook.js with save callbacks (function declarations — hoisted)
initSpellbook({ saveSettings, scheduleSave });

// ── Traffic scale slider ──
const trafficSlider = document.getElementById('traffic-scale-slider');
const trafficScaleVal = document.getElementById('traffic-scale-val');
trafficSlider.addEventListener('input', () => {
  const v = parseFloat(trafficSlider.value);
  setTrafficScale(v);
  trafficScaleVal.textContent = v.toFixed(1) + 'x';
  if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
  else { const _ls = getLastStatus(); if (_ls && _ls.collectd) updateConnectionTraffic(_ls.collectd); }
  scheduleSave();
});

initTopoControls({ saveSettings, scheduleSave, applyTopoZ });

// Register hook so topology refresh updates bubbles, search index, ghost lines, globe-Z cache
setTopologyRefreshHook(() => {
  updateBubblePositions();
  invalidateSearchIndex();
  setGhostDirty();
  invalidateGlobeZCache();
});

// Wire up tab renderers for persona-editor.js
setTabRenderers({
  renderControlPane,
  renderGroupPane,
  renderShellPane,
  renderConnectionsPane,
  focusShellInput,
});

// ── SSE Connection with reconnection manager ──
let _sseTrafficMap = null;
let _sseConnected = false;
let _ssePermanentlyDead = false;
export const getSseConnected = () => _sseConnected;

(function initSSE() {
  const BACKOFF_INITIAL = 1000;
  const BACKOFF_MAX = 30000;
  const MAX_CONSECUTIVE_FAILURES = 10;

  let sse = null;
  let _sseRestoreMode = true;
  let _backoff = BACKOFF_INITIAL;
  let _consecutiveFailures = 0;
  let _reconnectTimer = null;
  let _trafficRafPending = false;

  // ── Stream attunement tracker (lights up loading screen indicators) ──
  function _attuneStream(name) {
    const el = document.querySelector(`.rl-stream[data-stream="${name}"]`);
    if (el && !el.classList.contains('attuned')) el.classList.add('attuned');
  }

  // Reset backoff on any successful message — the connection is healthy
  function _onMessageReceived() {
    _backoff = BACKOFF_INITIAL;
    _consecutiveFailures = 0;
    if (_ssePermanentlyDead) {
      _ssePermanentlyDead = false;
      console.log('Realm Map: SSE connection restored from permanent failure state');
    }
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return; // already scheduled
    if (_ssePermanentlyDead) return; // gave up
    console.warn(`Realm Map: SSE reconnecting in ${(_backoff / 1000).toFixed(1)}s (attempt ${_consecutiveFailures + 1}/${MAX_CONSECUTIVE_FAILURES})`);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      _connect();
    }, _backoff);
    _backoff = Math.min(_backoff * 2, BACKOFF_MAX);
  }

  function _teardown() {
    if (sse) {
      sse.close();
      sse = null;
    }
  }

  function _connect() {
    _teardown();

    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      _ssePermanentlyDead = true;
      _sseConnected = false;
      console.error(`Realm Map: SSE permanently disconnected after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      showOffline();
      return;
    }

    sse = new EventSource(SSE_URL);

    // ── Message handlers (unchanged logic) ──

    sse.addEventListener('traffic', e => {
      _onMessageReceived();
      _attuneStream('traffic');
      _sseTrafficMap = JSON.parse(e.data);
      if (isZoomActive()) { setDeferredTraffic(_sseTrafficMap); return; }
      if (!_trafficRafPending) {
        _trafficRafPending = true;
        requestAnimationFrame(() => {
          _trafficRafPending = false;
          if (isZoomActive()) { setDeferredTraffic(_sseTrafficMap); return; }
          updateConnectionTrafficSSE(_sseTrafficMap);
          const fakeCollectd = trafficToCollectd(_sseTrafficMap);
          setLastTopoCollectd(fakeCollectd);
          renderTopoLayer(fakeCollectd);
        });
      }
    });

    sse.addEventListener('realm-event', e => {
      _onMessageReceived();
      _attuneStream('events');
      const evt = JSON.parse(e.data);
      renderEvent(evt, _sseRestoreMode);
    });

    sse.addEventListener('topology', e => {
      _onMessageReceived();
      _attuneStream('topology');
      refreshTopology();
      rebuildCensusIfNeeded();
    });

    sse.addEventListener('status', e => {
      _onMessageReceived();
      _attuneStream('status');
      const d = JSON.parse(e.data);
      _sseRestoreMode = false;
      if (isZoomActive() && liveOk) { setDeferredStatus(d); if (d.wifi) setWifiMap(d.wifi); return; }
      updateUI(d);
      if (d.wifi) setWifiMap(d.wifi);
      if (!liveOk) {
        liveOk = true;
        console.log('Realm Map: SSE live data connected');
        if (window._advanceLoadStage) window._advanceLoadStage(4);
        const loadEl = document.getElementById('realm-loading');
        if (loadEl && !loadEl.classList.contains('dismissed')) {
          setTimeout(() => {
            loadEl.classList.add('dismissed');
            setTimeout(() => { loadEl.style.display = 'none'; }, 1300);
          }, 1200);
        }
      }
    });

    sse.addEventListener('energy', e => {
      _onMessageReceived();
      _attuneStream('energy');
      const data = JSON.parse(e.data);
      if (isZoomActive()) { setDeferredEnergy(data); return; }
      updateEnergyPanel(data);
    });

    sse.addEventListener('latency', e => {
      _onMessageReceived();
      _attuneStream('latency');
      const parsed = JSON.parse(e.data);
      setLatencyMap(parsed);
      if (parsed.groups) {
        const flat = {};
        for (const g of parsed.groups) for (const entry of g.entries) flat[entry.id] = entry.rtt;
        setLatencyFlat(flat);
      } else {
        setLatencyFlat(parsed);
      }
      if (isZoomActive()) { setDeferredLatency(true); return; }
      updateLatencyPanel();
    });

    sse.addEventListener('firewall', e => {
      _onMessageReceived();
      _attuneStream('firewall');
      const d = JSON.parse(e.data);
      handleFirewallData(d);
    });

    sse.addEventListener('wifi', e => {
      _onMessageReceived();
      _attuneStream('wifi');
      const data = JSON.parse(e.data);
      if (data && Object.keys(data).length) renderWifiPanel(data);
    });

    // ── Connection lifecycle ──

    sse.addEventListener('open', () => {
      _sseConnected = true;
      _sseRestoreMode = true;
      // Don't reset backoff here — wait for an actual message to confirm health
      console.log('Realm Map: SSE connected');
    });

    sse.addEventListener('error', () => {
      _sseConnected = false;
      _consecutiveFailures++;
      console.warn('Realm Map: SSE disconnected');
      showOffline();
      // Kill the native EventSource so its built-in reconnect doesn't race us
      _teardown();
      _scheduleReconnect();
    });
  }

  // ── Visibility change: force immediate reconnect if tab becomes visible ──
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (_sseConnected) return; // already connected, nothing to do

    // Clear any pending scheduled reconnect — we'll try right now
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }

    // Allow retry even after permanent failure — user actively returned to the tab
    if (_ssePermanentlyDead) {
      _ssePermanentlyDead = false;
      _consecutiveFailures = 0;
      _backoff = BACKOFF_INITIAL;
      console.log('Realm Map: Tab visible — resetting SSE failure state and reconnecting');
    } else {
      _backoff = BACKOFF_INITIAL;
      console.log('Realm Map: Tab visible — forcing immediate SSE reconnect');
    }
    _connect();
  });

  // Bootstrap wifi panel immediately (SSE wifi event only fires every 120s)
  fetchWifiAPs();

  // Initial connection
  _connect();
})();

initScanner();

