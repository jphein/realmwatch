'use strict';
// -- Aether Towers WiFi Plugin Panel --
// Uses window.RealmAPI for SSE subscription and data access.
// Does NOT use esbuild imports -- loaded as a standalone script.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('wifi plugin: RealmAPI not available'); return; }

  var VLAN_NAMES = { 6: 'Admin', 8: 'Family', 10: 'IoT', 11: 'Guest' };
  var VLAN_COLORS = { 6: '#f0d890', 8: '#c0a060', 10: '#60c060', 11: '#64a0dc' };

  var panel = document.getElementById('wifi-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(100,200,255,0.5)');
  }

  // -- Build AP card using safe DOM methods --
  function makeApCard(apId, ap) {
    var card = document.createElement('div');
    card.className = 'wifi-ap';
    card.dataset.ap = apId;

    // Header
    var header = document.createElement('div');
    header.className = 'wifi-ap-header';

    var icon = document.createElement('span');
    icon.className = 'wifi-ap-icon';
    icon.textContent = '\uD83D\uDCE1';

    var name = document.createElement('span');
    name.className = 'wifi-ap-name';
    name.textContent = ap.label || apId;

    var clients = document.createElement('span');
    clients.className = 'wifi-ap-clients';
    clients.textContent = (ap.clients || 0) + ' \uD83D\uDCF6';

    header.appendChild(icon);
    header.appendChild(name);
    header.appendChild(clients);
    card.appendChild(header);

    // IP
    if (ap.ip) {
      var ipEl = document.createElement('div');
      ipEl.className = 'wifi-ap-ip';
      ipEl.textContent = ap.ip;
      card.appendChild(ipEl);
    }

    // SSIDs
    var ssids = ap.ssids || [];
    if (ssids.length) {
      for (var i = 0; i < ssids.length; i++) {
        var s = ssids[i];
        var ssidEl = document.createElement('div');
        ssidEl.className = 'wifi-ssid';

        var ssidName = document.createElement('span');
        ssidName.className = 'wifi-ssid-name';
        ssidName.textContent = s.ssid;

        var vlanName = VLAN_NAMES[s.vlan] || s.network || '?';
        var color = VLAN_COLORS[s.vlan] || '#a89870';
        var ssidVlan = document.createElement('span');
        ssidVlan.className = 'wifi-ssid-vlan';
        ssidVlan.style.color = color;
        ssidVlan.textContent = vlanName + (s.vlan ? ' v' + s.vlan : '');

        ssidEl.appendChild(ssidName);
        ssidEl.appendChild(ssidVlan);
        card.appendChild(ssidEl);
      }
    } else {
      var noSsid = document.createElement('div');
      noSsid.className = 'wifi-ssid wifi-ssid-none';
      noSsid.textContent = 'No SSIDs detected';
      card.appendChild(noSsid);
    }

    // Click to pan to node on map
    card.addEventListener('click', function() {
      var topo = API.getTopology();
      if (!topo || !topo.nodes) return;
      for (var j = 0; j < topo.nodes.length; j++) {
        if (topo.nodes[j].id === apId) {
          var nodeEl = document.querySelector('[data-tip="' + apId + '"]');
          if (nodeEl && API.panToNode) {
            var x = parseInt(nodeEl.style.left) || 0;
            var y = parseInt(nodeEl.style.top) || 0;
            API.panToNode(x, y);
          }
          break;
        }
      }
    });

    return card;
  }

  // -- Render the WiFi panel --
  function renderWifiPanel(data) {
    var body = document.getElementById('wifi-body');
    var badge = document.getElementById('wifi-ap-count');
    if (!body) return;

    var apIds = Object.keys(data);
    if (badge) badge.textContent = apIds.length + ' towers';

    if (!apIds.length) {
      body.textContent = '';
      var msg = document.createElement('div');
      msg.className = 'wifi-loading';
      msg.textContent = 'No towers found';
      body.appendChild(msg);
      return;
    }

    var frag = document.createDocumentFragment();
    for (var k = 0; k < apIds.length; k++) {
      frag.appendChild(makeApCard(apIds[k], data[apIds[k]]));
    }
    body.textContent = '';
    body.appendChild(frag);
  }

  // -- Subscribe to SSE wifi events --
  API.onSSE('wifi', function(data) {
    renderWifiPanel(data);
  });

  // -- Initial fetch --
  var panelEl = document.getElementById('wifi-panel');
  if (panelEl && panelEl.style.display !== 'none') {
    fetch('/wifi/aps').then(function(r) { return r.json(); }).then(function(data) {
      renderWifiPanel(data);
    }).catch(function() {
      var body = document.getElementById('wifi-body');
      if (body) {
        body.textContent = '';
        var err = document.createElement('div');
        err.className = 'wifi-loading';
        err.textContent = 'Towers unreachable';
        body.appendChild(err);
      }
    });
  }
})();
