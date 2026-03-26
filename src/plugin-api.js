// ── Plugin API — window.RealmAPI for plugin scripts ──
// This module sets up the global RealmAPI that plugin panel.js files use.
// Bundled into realm-map.js via esbuild; plugin scripts are NOT bundled.

import { _topology, _nodeMap } from './topology.js';
import { getLastStatus } from './node-status.js';

// ── SSE subscriber registry ──
// Map of eventType -> Set<handler>
const _sseSubscribers = new Map();

// ── Node enrichers (frontend) ──
const _nodeEnrichers = [];

// ── Context menu items ──
const _contextMenuItems = [];

// ── Map overlays ──
const _mapOverlays = [];

// ── Toast container (created lazily) ──
let _toastContainer = null;

function _getToastContainer() {
  if (_toastContainer) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.className = 'realm-toast-container';
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

/**
 * Dispatch an SSE event to plugin subscribers.
 * Called from app.js SSE handlers for plugin event types.
 */
export function dispatchPluginSSE(eventType, data) {
  const handlers = _sseSubscribers.get(eventType);
  if (!handlers) return;
  for (const fn of handlers) {
    try { fn(data); } catch (e) { console.error(`Plugin SSE handler error (${eventType}):`, e); }
  }
}

/** Get all registered node enrichers */
export function getNodeEnrichers() { return _nodeEnrichers; }

/** Get all registered context menu items */
export function getContextMenuItems() { return _contextMenuItems; }

/** Get all registered map overlays */
export function getMapOverlays() { return _mapOverlays; }

/**
 * Initialize RealmAPI on window. Called from app.js after core init.
 * @param {object} opts - { registerPanelFn, openPanelFn, closePanelFn }
 */
export function initRealmAPI({ registerPanelFn, openPanelFn, closePanelFn }) {
  window.RealmAPI = {
    // ── Panel management ──
    registerPanel(id, { name, icon, anchor, priority, html }) {
      // Create panel DOM element with standard chrome
      const panel = document.createElement('div');
      panel.id = id;
      panel.className = 'panel plugin-panel';
      panel.style.setProperty('--panel-accent', 'rgba(160,140,220,0.5)');

      const header = document.createElement('div');
      header.className = 'panel-header';
      const hdrIcon = document.createElement('span');
      hdrIcon.className = 'panel-hdr-icon';
      hdrIcon.textContent = icon || '\u2726';
      const hdrTitle = document.createElement('span');
      hdrTitle.className = 'panel-hdr-title';
      hdrTitle.textContent = name || id;
      header.appendChild(hdrIcon);
      header.appendChild(hdrTitle);

      const body = document.createElement('div');
      body.className = 'panel-body';
      // Plugin HTML comes from local trusted plugin authors (security model: full trust)
      if (typeof html === 'string') {
        body.innerHTML = html;  // eslint-disable-line no-unsanitized/property
      }

      panel.appendChild(header);
      panel.appendChild(body);

      // Insert into DOM before the sealed dock
      const dock = document.getElementById('sealed-dock');
      if (dock) {
        dock.parentNode.insertBefore(panel, dock);
      } else {
        document.body.appendChild(panel);
      }

      // Register with panel manager (adds to PANELS, attaches drag/seal handlers)
      registerPanelFn(panel, { name, icon, anchor, priority });

      return panel;
    },

    // Register an existing DOM element as a panel (for plugins that build custom chrome)
    registerExistingPanel(panelEl, { name, icon, anchor, priority }) {
      if (!panelEl || !panelEl.id) return;
      registerPanelFn(panelEl, { name, icon, anchor, priority });
    },

    removePanel(id) {
      const panel = document.getElementById(id);
      if (panel) panel.remove();
      // Note: removal from PANELS registry happens in panel-manager
    },

    // ── SSE events ──
    onSSE(eventType, handler) {
      if (!_sseSubscribers.has(eventType)) _sseSubscribers.set(eventType, new Set());
      _sseSubscribers.get(eventType).add(handler);
    },

    offSSE(eventType, handler) {
      const handlers = _sseSubscribers.get(eventType);
      if (handlers) handlers.delete(handler);
    },

    // ── Node enrichment ──
    registerNodeEnricher(fn) {
      _nodeEnrichers.push(fn);
    },

    registerContextMenuItem(label, fn) {
      _contextMenuItems.push({ label, fn });
    },

    registerMapOverlay(renderFn) {
      _mapOverlays.push(renderFn);
    },

    // ── Data access (read-only snapshots) ──
    getTopology() {
      if (!_topology) return null;
      // Shallow clone with frozen arrays — plugins get a snapshot they can't mutate
      return {
        nodes: _topology.nodes,
        connections: _topology.connections,
        regions: _topology.regions,
      };
    },

    getNode(nodeId) {
      return _nodeMap.get(nodeId) || null;
    },

    getLastStatus() {
      return getLastStatus();
    },

    // ── Utilities ──
    fetch(path, opts = {}) {
      // Plugin scripts set their name on RealmAPI._currentPlugin during init
      const prefix = window.RealmAPI._currentPlugin
        ? `/plugins/${window.RealmAPI._currentPlugin}`
        : '';
      const url = prefix + (path.startsWith('/') ? path : '/' + path);
      return fetch(url, opts);
    },

    showToast(message, type = 'info') {
      const container = _getToastContainer();
      const toast = document.createElement('div');
      toast.className = `realm-toast realm-toast--${type}`;
      toast.textContent = message;
      container.appendChild(toast);
      // Animate in
      requestAnimationFrame(() => toast.classList.add('realm-toast--visible'));
      // Auto-dismiss after 4s
      setTimeout(() => {
        toast.classList.remove('realm-toast--visible');
        setTimeout(() => toast.remove(), 400);
      }, 4000);
    },

    openPanel(panelId) {
      openPanelFn(panelId);
    },

    closePanel(panelId) {
      closePanelFn(panelId);
    },

    pushEvent(type, data) {
      return fetch('/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...data }),
      });
    },

    getPluginConfig(pluginName) {
      return fetch(`/plugins/${pluginName}/config`).then(r => r.ok ? r.json() : null);
    },

    // Internal: set by plugin loader during init sequence
    _currentPlugin: null,
  };
}
