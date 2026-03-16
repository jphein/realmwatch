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
         setGhostDirty, applyTopoZ, setOpenPersonaEditor } from './map-view.js';
import { openPersonaEditor, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { initSpellbook, invalidateSearchIndex } from './spellbook.js';
import { saveSettings, scheduleSave } from './layout.js';
import { scheduleDebugRefresh } from './debug.js';

let liveOk = false;

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

// Register hook so topology refresh updates bubbles, search index, ghost lines
setTopologyRefreshHook(() => {
  updateBubblePositions();
  invalidateSearchIndex();
  setGhostDirty();
});

// Wire up tab renderers for persona-editor.js
setTabRenderers({
  renderControlPane,
  renderGroupPane,
  renderShellPane,
  renderConnectionsPane,
  focusShellInput,
});

// ── SSE Connection ──
let _sseTrafficMap = null;
let _sseConnected = false;
export const getSseConnected = () => _sseConnected;

(function initSSE() {
  const sse = new EventSource(SSE_URL);
  let _sseRestoreMode = true;

  // ── Stream attunement tracker (lights up loading screen indicators) ──
  function _attuneStream(name) {
    const el = document.querySelector(`.rl-stream[data-stream="${name}"]`);
    if (el && !el.classList.contains('attuned')) el.classList.add('attuned');
  }

  let _trafficRafPending = false;
  sse.addEventListener('traffic', e => {
    _attuneStream('traffic');
    _sseTrafficMap = JSON.parse(e.data);
    // Defer DOM-heavy traffic updates during zoom — flush on exit
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
    _attuneStream('events');
    const evt = JSON.parse(e.data);
    renderEvent(evt, _sseRestoreMode);
  });

  sse.addEventListener('topology', e => {
    _attuneStream('topology');
    refreshTopology();
    rebuildCensusIfNeeded();
  });

  sse.addEventListener('status', e => {
    _attuneStream('status');
    const d = JSON.parse(e.data);
    _sseRestoreMode = false;
    // Defer all DOM updates during zoom — just stash the latest data
    // (but never defer the first-connect that dismisses the loading screen)
    if (isZoomActive() && liveOk) { setDeferredStatus(d); if (d.wifi) setWifiMap(d.wifi); return; }
    updateUI(d);
    if (d.wifi) setWifiMap(d.wifi);
    if (!liveOk) {
      liveOk = true;
      console.log('Realm Map: SSE live data connected');
      // Stage 4: connected — hold for a beat, then dismiss
      if (window._advanceLoadStage) window._advanceLoadStage(4);
      const loadEl = document.getElementById('realm-loading');
      if (loadEl && !loadEl.classList.contains('dismissed')) {
        setTimeout(() => {
          loadEl.classList.add('dismissed');
          // Kill loading screen entirely after fade (1.2s transition) — stops 15 animations from burning GPU
          setTimeout(() => { loadEl.style.display = 'none'; }, 1300);
        }, 1200);
      }
    }
  });

  sse.addEventListener('energy', e => {
    _attuneStream('energy');
    const data = JSON.parse(e.data);
    if (isZoomActive()) { setDeferredEnergy(data); return; }
    updateEnergyPanel(data);
  });

  sse.addEventListener('latency', e => {
    _attuneStream('latency');
    const parsed = JSON.parse(e.data);
    setLatencyMap(parsed);
    // Extract flat map for layout worker (Cartographer modes)
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
    _attuneStream('firewall');
    const d = JSON.parse(e.data);
    handleFirewallData(d);
  });

  sse.addEventListener('wifi', e => {
    _attuneStream('wifi');
    const data = JSON.parse(e.data);
    if (data && Object.keys(data).length) renderWifiPanel(data);
  });

  // Bootstrap wifi panel immediately (SSE wifi event only fires every 120s)
  fetchWifiAPs();

  sse.addEventListener('open', () => {
    if (!_sseConnected) {
      _sseConnected = true;
      _sseRestoreMode = true;
      console.log('Realm Map: SSE connected');
    }
  });

  sse.addEventListener('error', () => {
    if (_sseConnected) {
      _sseConnected = false;
      console.warn('Realm Map: SSE disconnected, reconnecting...');
      showOffline();
    }
  });
})();

initScanner();

