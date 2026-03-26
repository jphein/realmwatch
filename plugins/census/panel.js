'use strict';
// ── Census Plugin Panel (Realm Census) ──
// Grouped node list with live online/offline status dots and sublabels.
// Uses window.RealmAPI for topology data and SSE subscription.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('census plugin: RealmAPI not available'); return; }

  var NODE_TYPE_ORDER = ['core', 'infra', 'tower', 'bridge', 'cluster', 'tailscale'];
  var NODE_TYPE_LABELS = {
    core: 'Inner Sanctum', infra: 'Infrastructure', tower: 'Guardian Towers',
    bridge: 'Signal Bridges', cluster: 'Enchanted Quarters', tailscale: 'Astral Sea'
  };

  var _censusSubCache = null;
  var _statusKeyMap = null;
  var _statusKeyMapSrc = null;

  // ── Inject count badge into panel header ──
  var panel = document.getElementById('node-list');
  var countEl = null;
  if (panel) {
    var header = panel.querySelector('.panel-header');
    if (header) {
      countEl = document.createElement('span');
      countEl.className = 'panel-hdr-badge nl-count';
      countEl.id = 'nl-count';
      countEl.textContent = '-- nodes';
      header.appendChild(countEl);
    }
    panel.style.setProperty('--panel-accent', 'rgba(192,144,96,0.5)');
  }

  // ── Status key lookup (case-insensitive, dash-stripped) ──
  function buildStatusKeyMap(nodeStatus) {
    if (_statusKeyMapSrc === nodeStatus) return _statusKeyMap;
    var m = {};
    var keys = Object.keys(nodeStatus);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var lo = k.toLowerCase();
      m[lo] = k;
      m[lo.replace(/-/g, '')] = k;
    }
    _statusKeyMap = m;
    _statusKeyMapSrc = nodeStatus;
    return m;
  }

  function findStatusKey(nodeStatus, tipKey) {
    var m = buildStatusKeyMap(nodeStatus);
    var lo = tipKey.toLowerCase();
    return m[lo] || m[lo.replace(/-/g, '')];
  }

  // ── Build grouped node list from topology ──
  function buildNodeList() {
    var topo = API.getTopology();
    if (!topo || !topo.nodes) return;
    var body = document.getElementById('node-list-body');
    if (!body) return;
    body.textContent = '';
    _censusSubCache = null;

    // Group nodes by type
    var groups = {};
    for (var i = 0; i < topo.nodes.length; i++) {
      var n = topo.nodes[i];
      var type = n.type || 'core';
      if (!groups[type]) groups[type] = [];
      groups[type].push(n);
    }

    var total = 0;
    for (var t = 0; t < NODE_TYPE_ORDER.length; t++) {
      var typeName = NODE_TYPE_ORDER[t];
      var nodes = groups[typeName];
      if (!nodes || !nodes.length) continue;
      total += nodes.length;

      var group = document.createElement('div');
      group.className = 'nl-group';
      var title = document.createElement('div');
      title.className = 'nl-group-title';
      title.textContent = NODE_TYPE_LABELS[typeName] || typeName;
      group.appendChild(title);

      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        var item = document.createElement('div');
        item.className = 'nl-item';
        item.dataset.nodeId = node.id;

        var dot = document.createElement('div');
        dot.className = 'nl-status unknown';
        var icon = document.createElement('span');
        icon.className = 'nl-icon';
        icon.textContent = node.icon || '?';
        var info = document.createElement('div');
        info.className = 'nl-info';
        var name = document.createElement('div');
        name.className = 'nl-name';
        name.textContent = node.label || node.id;
        var sub = document.createElement('div');
        sub.className = 'nl-sub';
        sub.textContent = node.ip || node.sublabel || '';
        info.appendChild(name);
        info.appendChild(sub);

        item.appendChild(dot);
        item.appendChild(icon);
        item.appendChild(info);

        // Click to pan to node on map
        (function(nodeId) {
          item.addEventListener('click', function() {
            var nodeEl = document.querySelector('[data-tip="' + nodeId + '"]');
            if (!nodeEl) return;
            var nodeLeft = parseInt(nodeEl.style.left) || 0;
            var nodeTop = parseInt(nodeEl.style.top) || 0;
            if (window._realmPanToNode) {
              window._realmPanToNode(nodeLeft, nodeTop);
            }
            nodeEl.classList.add('node-highlight');
            setTimeout(function() { nodeEl.classList.remove('node-highlight'); }, 2000);
          });
        })(node.id);

        group.appendChild(item);
      }
      body.appendChild(group);
    }

    if (countEl) countEl.textContent = total + ' nodes';
  }

  // ── Update online/offline status dots ──
  function updateNodeListStatus(d) {
    if (!d || !d.astral) return;
    var nodeStatus = d.astral.nodes || {};
    var items = document.querySelectorAll('#node-list-body .nl-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = item.dataset.nodeId;
      var dot = item.querySelector('.nl-status');
      if (!dot) continue;
      var statusKey = findStatusKey(nodeStatus, id);
      var online = statusKey ? nodeStatus[statusKey] : null;
      dot.className = 'nl-status ' + (online === true ? 'online' : online === false ? 'offline' : 'unknown');
    }
  }

  // ── Build DOM cache for sublabel updates ──
  function buildCensusSubCache() {
    _censusSubCache = [];
    var items = document.querySelectorAll('#node-list-body .nl-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = item.dataset.nodeId;
      var subEl = item.querySelector('.nl-sub');
      if (id && subEl) _censusSubCache.push({ id: id, subEl: subEl });
    }
  }

  // ── Update sublabels from status data ──
  function updateCensusSubLabels(d) {
    if (!d) return;
    if (!_censusSubCache) buildCensusSubCache();
    var sublabels = d.sublabels || {};
    for (var i = 0; i < _censusSubCache.length; i++) {
      var entry = _censusSubCache[i];
      var id = entry.id;
      var subEl = entry.subEl;
      if (sublabels[id]) {
        subEl.textContent = sublabels[id];
      } else {
        var haInfo = d.ha && d.ha[id];
        if (haInfo && haInfo.sublabel) { subEl.textContent = haInfo.sublabel; continue; }
        var wledInfo = d.wled && d.wled[id];
        if (wledInfo && wledInfo.online) { subEl.textContent = wledInfo.on ? 'On \u2022 ' + (wledInfo.effect || 'Solid') : 'Off'; continue; }
        var wifi = d.wifi && d.wifi[id];
        if (wifi && wifi.signal != null) { subEl.textContent = wifi.signal + ' dBm \u2022 ' + (wifi.ssid || wifi.ap || ''); }
      }
    }
  }

  // ── Initial build ──
  buildNodeList();

  // Apply initial status if already available
  var initStatus = API.getLastStatus();
  if (initStatus) {
    updateNodeListStatus(initStatus);
    updateCensusSubLabels(initStatus);
  }

  // ── Subscribe to SSE events ──
  API.onSSE('status', function(d) {
    updateNodeListStatus(d);
    updateCensusSubLabels(d);
  });

  API.onSSE('topology', function() {
    buildNodeList();
    _censusSubCache = null;
    // Re-apply status after rebuild
    var lastStatus = API.getLastStatus();
    if (lastStatus) {
      updateNodeListStatus(lastStatus);
      updateCensusSubLabels(lastStatus);
    }
  });

  // Register as a RealmPlugin for init lifecycle
  window.RealmPlugins = window.RealmPlugins || {};
  window.RealmPlugins.census = {
    init: function() {}
  };
})();
