'use strict';
// -- Realm Census Plugin Panel --
// Groups nodes by type, shows online/offline status dots, sublabels.
// Uses window.RealmAPI for SSE subscription and topology data.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('census plugin: RealmAPI not available'); return; }

  var NODE_TYPE_ORDER = ['core', 'infra', 'tower', 'bridge', 'cluster', 'tailscale'];
  var NODE_TYPE_LABELS = {
    core: 'Inner Sanctum',
    infra: 'Infrastructure',
    tower: 'Guardian Towers',
    bridge: 'Signal Bridges',
    cluster: 'Enchanted Quarters',
    tailscale: 'Astral Sea'
  };

  var _censusSubCache = null;

  // -- Build the node list grouped by type --
  function buildNodeList() {
    var topo = API.getTopology();
    if (!topo || !topo.nodes) return;
    var body = document.getElementById('node-list-body');
    var countEl = document.getElementById('nl-count');
    if (!body) return;

    // Clear and invalidate cache
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
    var frag = document.createDocumentFragment();

    for (var t = 0; t < NODE_TYPE_ORDER.length; t++) {
      var typeName = NODE_TYPE_ORDER[t];
      var nodes = groups[typeName];
      if (!nodes || !nodes.length) continue;
      total += nodes.length;

      var groupEl = document.createElement('div');
      groupEl.className = 'nl-group';

      var title = document.createElement('div');
      title.className = 'nl-group-title';
      title.textContent = NODE_TYPE_LABELS[typeName] || typeName;
      groupEl.appendChild(title);

      for (var j = 0; j < nodes.length; j++) {
        var node = nodes[j];
        groupEl.appendChild(makeNodeItem(node));
      }
      frag.appendChild(groupEl);
    }

    body.appendChild(frag);
    if (countEl) countEl.textContent = total + ' nodes';
  }

  // -- Create a single node item row --
  function makeNodeItem(n) {
    var item = document.createElement('div');
    item.className = 'nl-item';
    item.dataset.nodeId = n.id;

    var dot = document.createElement('div');
    dot.className = 'nl-status unknown';

    var icon = document.createElement('span');
    icon.className = 'nl-icon';
    icon.textContent = n.icon || '?';

    var info = document.createElement('div');
    info.className = 'nl-info';

    var name = document.createElement('div');
    name.className = 'nl-name';
    name.textContent = n.label || n.id;

    var sub = document.createElement('div');
    sub.className = 'nl-sub';
    sub.textContent = n.ip || n.sublabel || '';

    info.appendChild(name);
    info.appendChild(sub);

    item.appendChild(dot);
    item.appendChild(icon);
    item.appendChild(info);

    // Click to pan/zoom to node on the map
    item.addEventListener('click', function() {
      var nodeEl = document.querySelector('[data-tip="' + n.id + '"]');
      if (!nodeEl) return;
      var nodeLeft = parseInt(nodeEl.style.left) || 0;
      var nodeTop = parseInt(nodeEl.style.top) || 0;
      // Pan to node coordinates — use the global panToNode if exposed, else scroll
      if (window._realmPanToNode) {
        window._realmPanToNode(nodeLeft, nodeTop);
      }
      // Highlight the node briefly
      nodeEl.classList.add('node-highlight');
      setTimeout(function() { nodeEl.classList.remove('node-highlight'); }, 2000);
    });

    return item;
  }

  // -- Find a status key with case-insensitive matching --
  function findStatusKey(nodeStatus, id) {
    if (nodeStatus[id]) return id;
    var lo = id.toLowerCase();
    var keys = Object.keys(nodeStatus);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].toLowerCase() === lo) return keys[k];
      if (keys[k].toLowerCase().replace(/-/g, '') === lo.replace(/-/g, '')) return keys[k];
    }
    return null;
  }

  // -- Update online/offline status dots --
  function updateNodeListStatus(d) {
    if (!d || !d.astral) return;
    var nodeStatus = d.astral.nodes || {};
    var items = document.querySelectorAll('#node-list-panel .nl-item');
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

  // -- Build cached refs for sublabel updates --
  function buildCensusSubCache() {
    _censusSubCache = [];
    var items = document.querySelectorAll('#node-list-panel .nl-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var id = item.dataset.nodeId;
      var subEl = item.querySelector('.nl-sub');
      if (id && subEl) _censusSubCache.push({ id: id, subEl: subEl });
    }
  }

  // -- Update sublabels from SSE status data --
  function updateCensusSubLabels(d) {
    if (!d) return;
    if (!_censusSubCache) buildCensusSubCache();
    var sublabels = d.sublabels || {};
    for (var i = 0; i < _censusSubCache.length; i++) {
      var entry = _censusSubCache[i];
      if (sublabels[entry.id]) {
        entry.subEl.textContent = sublabels[entry.id];
      } else {
        // Fallback: HA > WLED > WiFi
        var haInfo = d.ha && d.ha[entry.id];
        if (haInfo && haInfo.sublabel) { entry.subEl.textContent = haInfo.sublabel; continue; }
        var wledInfo = d.wled && d.wled[entry.id];
        if (wledInfo && wledInfo.online) {
          entry.subEl.textContent = wledInfo.on ? 'On \u2022 ' + (wledInfo.effect || 'Solid') : 'Off';
          continue;
        }
        var wifi = d.wifi && d.wifi[entry.id];
        if (wifi && wifi.signal != null) {
          entry.subEl.textContent = wifi.signal + ' dBm \u2022 ' + (wifi.ssid || wifi.ap || '');
        }
      }
    }
  }

  // -- Subscribe to SSE events --
  API.onSSE('status', function(d) {
    updateNodeListStatus(d);
    updateCensusSubLabels(d);
  });

  API.onSSE('topology', function() {
    buildNodeList();
  });

  // -- Initial build --
  buildNodeList();
})();
