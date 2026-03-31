// ── App coordinator — SSE dispatch + module wiring ──
import { SSE_URL } from './config.js';
import { refreshTopology, setTopologyRefreshHook } from './topology.js';
import { renderTopoLayer, setLastTopoCollectd, initTopoControls } from './terrain.js';
import { updateConnectionTraffic, updateConnectionTrafficSSE, trafficToCollectd, setTrafficScale } from './traffic.js';
import { setLatencyFlat, setWifiMap } from './panels.js';
import { updateUI, getLastStatus, setPostUpdateHook } from './node-status.js';
import { renderEvent, updateBubblePositions, firePulse, showOffline,
         setOpenNodeChat } from './quest-log.js';
import { isZoomActive,
         setDeferredStatus, setDeferredTraffic,
         setGhostDirty, applyTopoZ, setOpenPersonaEditor, invalidateGlobeZCache } from './map-view.js';
import { openPersonaEditor, setTabRenderers } from './persona-editor.js';
import { renderControlPane, renderGroupPane, renderShellPane, renderConnectionsPane, focusShellInput, openNodeChat } from './node-controls.js';
import { initSpellbook, invalidateSearchIndex } from './spellbook.js';
import { saveSettings, scheduleSave } from './layout.js';
import { initRealmAPI, dispatchPluginSSE } from './plugin-api.js';
import { registerPluginPanel, openPanel, closePanel, unsealPanel } from './panel-manager.js';
import { initWinBoxWM, toggleWinBoxMode, openWinBoxPanel } from './winbox-wm.js';
import { applyFormation } from './panel-manager.js';

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

// Register post-update hook for firePulse + periodic log
setPostUpdateHook(() => {
  firePulse();
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
if (trafficSlider) {
  trafficSlider.addEventListener('input', () => {
    const v = parseFloat(trafficSlider.value);
    setTrafficScale(v);
    if (trafficScaleVal) trafficScaleVal.textContent = v.toFixed(1) + 'x';
    if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
    else { const _ls = getLastStatus(); if (_ls && _ls.collectd) updateConnectionTraffic(_ls.collectd); }
    scheduleSave();
  });
}

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
  let _statusRafPending = false;
  let _pendingStatusData = null;

  // ── Stream attunement tracker (lights up loading screen indicators) ──
  const _attuneCache = {};
  const _attuneDone = {};
  function _attuneStream(name) {
    if (_attuneDone[name]) return;  // Already attuned — skip DOM access entirely
    let el = _attuneCache[name];
    if (!el) {
      el = document.querySelector(`.rl-stream[data-stream="${name}"]`);
      _attuneCache[name] = el;
    }
    if (el && !el.classList.contains('attuned')) {
      el.classList.add('attuned');
      _attuneDone[name] = true;  // One-shot — never query again
    }
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
    });

    sse.addEventListener('status', e => {
      _onMessageReceived();
      _attuneStream('status');
      const d = JSON.parse(e.data);
      _sseRestoreMode = false;
      if (isZoomActive() && liveOk) { setDeferredStatus(d); if (d.wifi) setWifiMap(d.wifi); return; }
      // First status must apply immediately (loading screen depends on it)
      if (!liveOk) {
        updateUI(d);
        if (d.wifi) setWifiMap(d.wifi);
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
        return;
      }
      // Subsequent status updates: batch via RAF to avoid layout thrashing
      _pendingStatusData = d;
      if (!_statusRafPending) {
        _statusRafPending = true;
        requestAnimationFrame(() => {
          _statusRafPending = false;
          if (_pendingStatusData) {
            if (isZoomActive()) { setDeferredStatus(_pendingStatusData); if (_pendingStatusData.wifi) setWifiMap(_pendingStatusData.wifi); }
            else { updateUI(_pendingStatusData); if (_pendingStatusData.wifi) setWifiMap(_pendingStatusData.wifi); }
            _pendingStatusData = null;
          }
        });
      }
    });

    // Energy SSE handling moved to plugins/ha/panel.js

    // Latency data model update (rendering handled by plugins/latency/panel.js)
    sse.addEventListener('latency', e => {
      _onMessageReceived();
      _attuneStream('latency');
      const parsed = JSON.parse(e.data);
      if (parsed.groups) {
        const flat = {};
        for (const g of parsed.groups) for (const entry of g.entries) flat[entry.id] = entry.rtt;
        setLatencyFlat(flat);
      } else {
        setLatencyFlat(parsed);
      }
    });

    // Firewall + WiFi panel rendering handled by plugins/firewall/ and plugins/wifi/

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

    // ── Plugin SSE dispatch ──
    // Attach listeners for plugin-declared SSE types (re-attached on each reconnect)
    if (window._realmPluginSSETypes) {
      for (const eventType of window._realmPluginSSETypes) {
        sse.addEventListener(eventType, e => {
          _onMessageReceived();
          try {
            const data = JSON.parse(e.data);
            dispatchPluginSSE(eventType, data);
          } catch (err) {
            console.error(`Plugin SSE parse error (${eventType}):`, err);
          }
        });
      }
    }
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

  // Attach plugin SSE listeners to the live connection (called after plugins load)
  window._attachPluginSSEListeners = function(types) {
    if (!sse || !types || types.length === 0) return;
    for (const eventType of types) {
      sse.addEventListener(eventType, e => {
        _onMessageReceived();
        try {
          const data = JSON.parse(e.data);
          dispatchPluginSSE(eventType, data);
        } catch (err) {
          console.error(`Plugin SSE parse error (${eventType}):`, err);
        }
      });
    }
  };

  // Initial connection
  _connect();
})();

// Defer non-critical init to idle time — SSE connection is the priority
const _deferInit = window.requestIdleCallback || (cb => setTimeout(cb, 50));
_deferInit(() => { initWinBoxWM(); });

// ── Initialize RealmAPI for plugins ──
initRealmAPI({
  registerPanelFn: registerPluginPanel,
  openPanelFn: openPanel,
  closePanelFn: closePanel,
});

// ── Plugin loading sequence ──
// Fetch plugin list, inject CSS/JS, call init() on each
(async function loadPlugins() {
  try {
    const res = await fetch('/plugins');
    if (!res.ok) return;
    const allPlugins = await res.json();
    if (!Array.isArray(allPlugins) || allPlugins.length === 0) return;
    const plugins = allPlugins.filter(p => p.status !== 'disabled');

    // Hide DOM shells for disabled plugin panels (they exist in HTML but shouldn't show)
    const disabledPlugins = allPlugins.filter(p => p.status === 'disabled');
    for (const dp of disabledPlugins) {
      const pid = dp.panel?.id;
      if (pid) {
        const el = document.getElementById(pid);
        if (el) el.style.display = 'none';
      }
    }

    if (plugins.length === 0) return;

    // Track loaded plugin SSE types for dispatch
    const pluginSSETypes = new Set();

    // Inject all CSS in parallel (non-blocking) — top-level and panel CSS
    for (const plugin of plugins) {
      const cssFile = plugin.css || plugin.panel?.css;
      if (cssFile) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `/plugins/${plugin.name}/${cssFile}`;
        document.head.appendChild(link);
      }
      if (plugin.sse_types) {
        for (const t of plugin.sse_types) pluginSSETypes.add(t);
      }
    }

    // Create panel DOM for plugins that declare a panel but don't have one in HTML
    for (const plugin of plugins) {
      const p = plugin.panel;
      if (!p || document.getElementById(p.id)) continue;
      // Fetch panel HTML and register via RealmAPI
      try {
        const htmlRes = await fetch(`/plugins/${plugin.name}/${p.html}`);
        const html = htmlRes.ok ? await htmlRes.text() : '';
        window.RealmAPI.registerPanel(p.id, {
          name: p.name || plugin.fantasy_name || plugin.name,
          icon: plugin.icon || '\u2726',
          anchor: p.anchor || 'sw',
          priority: p.priority || 50,
          html,
        });
      } catch (e) {
        console.error(`Plugin ${plugin.name}: panel creation failed`, e);
      }
    }

    // Load all plugin JS in parallel — top-level and panel JS
    const t0 = performance.now();
    const jsPlugins = plugins.filter(p => p.js || p.panel?.js);
    await Promise.all(jsPlugins.map(plugin => {
      const jsFile = plugin.js || plugin.panel.js;
      return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = `/plugins/${plugin.name}/${jsFile}`;
        script.onload = resolve;
        script.onerror = () => {
          console.error(`Plugin ${plugin.name}: failed to load ${jsFile}`);
          resolve();
        };
        document.head.appendChild(script);
      });
    }));
    console.log(`Realm Map: plugin JS loaded in ${(performance.now() - t0).toFixed(0)}ms`);

    // Init plugins sequentially (order may matter for registration)
    for (const plugin of plugins) {
      const pluginObj = window.RealmPlugins?.[plugin.name];
      if (pluginObj && typeof pluginObj.init === 'function') {
        try {
          window.RealmAPI._currentPlugin = plugin.name;
          pluginObj.init(window.RealmAPI);
          window.RealmAPI._currentPlugin = null;
        } catch (e) {
          console.error(`Plugin ${plugin.name}: init() failed`, e);
          window.RealmAPI._currentPlugin = null;
        }
      }
    }

    // Wire up SSE dispatch for plugin event types on the live connection
    window._realmPluginSSETypes = pluginSSETypes;
    if (window._attachPluginSSEListeners) {
      window._attachPluginSSEListeners(pluginSSETypes);
    }

    if (plugins.length > 0) {
      console.log(`Realm Map: ${plugins.length} plugin(s) loaded`);
      invalidateSearchIndex();
    }
  } catch (e) {
    // Plugin loading is non-critical — don't break the app
    console.warn('Realm Map: plugin loading failed', e);
  }
})();

// Spellbook toggle for WinBox window manager
const _wbcb = document.getElementById('winbox-wm-cb');
if (_wbcb) {
  _wbcb.checked = localStorage.getItem('realm-winbox-mode') !== 'false';
  _wbcb.addEventListener('change', () => {
    toggleWinBoxMode(_wbcb.checked);

    if (_wbcb.checked) {
      // Entering WinBox mode: unseal all sealed panels, hide dock, open panels in WinBox
      const dock = document.getElementById('sealed-dock');
      if (dock) dock.style.display = 'none';
      // Unseal all currently sealed panels
      document.querySelectorAll('.panel-sealed').forEach(p => unsealPanel(p));
      // Remove all runes
      document.querySelectorAll('.sealed-rune').forEach(r => r.remove());
      // Open visible panels in WinBox windows
      requestAnimationFrame(() => {
        document.querySelectorAll('.panel').forEach(p => {
          if (p.style.display !== 'none' && p.id) openWinBoxPanel(p.id);
        });
      });
    } else {
      // Leaving WinBox mode: show dock, apply formation
      const dock = document.getElementById('sealed-dock');
      if (dock) dock.style.display = '';
      document.body.classList.add('no-panel-transitions');
      requestAnimationFrame(() => {
        applyFormation('grimoire-binding');
        requestAnimationFrame(() => {
          document.body.classList.remove('no-panel-transitions');
        });
      });
    }
  });
}

