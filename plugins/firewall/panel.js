'use strict';
// -- Ward Stones Firewall Plugin Panel --
// Uses window.RealmAPI for SSE subscription and data access.
// Does NOT use esbuild imports -- loaded as a standalone script.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('firewall plugin: RealmAPI not available'); return; }

  var _fwData = null;

  var VLAN_IFACE_MAP = {
    '3': 'br-lan.3', '4': 'br-lan.4', '5': 'br-lan.5', '6': 'br-lan.6',
    '7': 'br-lan.7', '8': 'br-lan.8', '9': 'br-lan.9', '10': 'br-lan.10',
    '11': 'br-lan.11', '12': 'br-lan.12', '20': 'br-lan.20', '38': 'br-lan.38',
  };

  var panel = document.getElementById('firewall-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(220,160,80,0.5)');
  }

  // -- Format bytes for display --
  function fmtBytes(b) {
    if (b == null) return '--';
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'K';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + 'M';
    return (b / 1073741824).toFixed(1) + 'G';
  }

  function fmtRate(bps) {
    if (bps == null) return '--';
    if (bps < 1024) return bps.toFixed(0) + 'B/s';
    if (bps < 1048576) return (bps / 1024).toFixed(1) + 'K/s';
    return (bps / 1048576).toFixed(1) + 'M/s';
  }

  // -- Cached DOM refs for VLAN traffic update --
  var _fwVlanCache = null;
  function buildFwVlanCache() {
    var p = document.getElementById('firewall-panel');
    if (!p) return;
    _fwVlanCache = [];
    var rows = p.querySelectorAll('.fw-vlan');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      _fwVlanCache.push({
        iface: VLAN_IFACE_MAP[row.dataset.vlan],
        rx: row.querySelector('.fw-rx-val'),
        tx: row.querySelector('.fw-tx-val'),
      });
    }
  }

  // -- Update traffic rates from collectd status data --
  function updateFirewallTraffic(d) {
    var p = document.getElementById('firewall-panel');
    if (!p || p.style.display === 'none') return;
    var gk = d.collectd && d.collectd['gatekeeper'];
    var ifaces = (gk && gk.interfaces) || {};
    if (!_fwVlanCache) buildFwVlanCache();

    for (var i = 0; i < _fwVlanCache.length; i++) {
      var c = _fwVlanCache[i];
      var data = ifaces[c.iface];
      if (c.rx) c.rx.textContent = data ? fmtRate(data.rx_bps) : '--';
      if (c.tx) c.tx.textContent = data ? fmtRate(data.tx_bps) : '--';
    }
  }

  // -- Render firewall zone data from nftables --
  function renderFirewallPanel() {
    if (!_fwData) return;
    _fwVlanCache = null;  // Invalidate -- panel DOM is about to be rebuilt
    var p = document.getElementById('firewall-panel');
    if (!p) return;
    var zones = _fwData.zones;
    var wan = _fwData.wan;
    var suggestions = _fwData.suggestions;

    // Update zone counters
    var zoneNames = Object.keys(zones);
    for (var zi = 0; zi < zoneNames.length; zi++) {
      var zname = zoneNames[zi];
      var z = zones[zname];
      var row = p.querySelector('.fw-vlan[data-vlan="' + z.vlan + '"]');
      if (!row) continue;

      // Accept/reject counters
      var statsEl = row.querySelector('.fw-zone-stats');
      if (!statsEl) {
        statsEl = document.createElement('div');
        statsEl.className = 'fw-zone-stats';
        row.appendChild(statsEl);
      }
      var c = z.counters;
      statsEl.textContent = '';
      var acceptSpan = document.createElement('span');
      acceptSpan.className = 'fw-stat-accept';
      acceptSpan.textContent = fmtBytes(c.accept_bytes) + ' in';
      statsEl.appendChild(acceptSpan);
      if (c.reject_pkts > 0) {
        var rejectSpan = document.createElement('span');
        rejectSpan.className = 'fw-stat-reject';
        rejectSpan.textContent = ' ' + c.reject_pkts.toLocaleString() + ' rej';
        statsEl.appendChild(rejectSpan);
      }

      // DNS badge
      var dnsEl = row.querySelector('.fw-dns-badge');
      if (z.dns_redirect) {
        if (!dnsEl) {
          dnsEl = document.createElement('span');
          dnsEl.className = 'fw-dns-badge';
          var header = row.querySelector('.fw-vlan-header');
          if (header) header.appendChild(dnsEl);
        }
        dnsEl.textContent = 'DNS';
        dnsEl.title = z.dns_queries.toLocaleString() + ' queries redirected';
      } else if (dnsEl) {
        dnsEl.parentNode.removeChild(dnsEl);
      }

      // Blocked IPs
      var blocksEl = row.querySelector('.fw-blocks');
      if (z.blocked_ips && z.blocked_ips.length) {
        if (!blocksEl) {
          blocksEl = document.createElement('div');
          blocksEl.className = 'fw-blocks';
          row.appendChild(blocksEl);
        }
        blocksEl.textContent = '';
        for (var bi = 0; bi < z.blocked_ips.length; bi++) {
          var b = z.blocked_ips[bi];
          var ipSpan = document.createElement('span');
          ipSpan.className = 'fw-block-ip' + (b.pkts === 0 ? ' fw-block-inactive' : '');
          ipSpan.title = b.pkts.toLocaleString() + ' pkts blocked';
          ipSpan.textContent = b.ip.replace('10.0.10.', '.10.') + (b.pkts > 0 ? ' \u2717' : ' ?');
          blocksEl.appendChild(ipSpan);
        }
      } else if (blocksEl) {
        blocksEl.textContent = '';
      }

      // Reachability
      var reachEl = row.querySelector('.fw-reach');
      if (z.can_reach && z.can_reach.length) {
        if (!reachEl) {
          reachEl = document.createElement('div');
          reachEl.className = 'fw-reach';
          row.appendChild(reachEl);
        }
        var labels = { wan: 'WAN', lan: 'IoT', iot: 'Guest', family: 'Family', admin: 'Admin', vpn: 'VPN', wanguard: 'WAN Guard' };
        var reachNames = [];
        for (var ri = 0; ri < z.can_reach.length; ri++) {
          reachNames.push(labels[z.can_reach[ri]] || z.can_reach[ri]);
        }
        reachEl.textContent = '\u2192 ' + reachNames.join(', ');
      } else if (reachEl) {
        reachEl.textContent = '';
      }
    }

    // WAN gate counter
    var wanEl = document.getElementById('fw-wan');
    if (wanEl) wanEl.textContent = fmtBytes(wan.accept_bytes);
    var lanEl = document.getElementById('fw-lan');
    if (lanEl) lanEl.textContent = wan.reject_pkts.toLocaleString() + ' rej';

    // Suggestions
    var body = p.querySelector('.firewall-body') || document.getElementById('firewall-body');
    var sugEl = body ? body.querySelector('.fw-suggestions') : null;
    if (!sugEl && body) {
      var div = document.createElement('div');
      div.className = 'fw-divider';
      body.appendChild(div);
      sugEl = document.createElement('div');
      sugEl.className = 'fw-suggestions';
      body.appendChild(sugEl);
    }
    if (sugEl && suggestions && suggestions.length) {
      var icons = { info: '\u2139', warn: '\u26A0', critical: '\u2622' };
      sugEl.textContent = '';
      var titleEl = document.createElement('div');
      titleEl.className = 'fw-section-title';
      titleEl.textContent = 'Observations';
      sugEl.appendChild(titleEl);
      for (var si = 0; si < suggestions.length; si++) {
        var s = suggestions[si];
        var sugDiv = document.createElement('div');
        sugDiv.className = 'fw-sug fw-sug-' + s.severity;
        var sugIcon = document.createElement('span');
        sugIcon.className = 'fw-sug-icon';
        sugIcon.textContent = icons[s.severity] || '\u2022';
        sugDiv.appendChild(sugIcon);
        sugDiv.appendChild(document.createTextNode(' ' + s.text));
        sugEl.appendChild(sugDiv);
      }
    }
  }

  // -- Subscribe to SSE firewall events --
  API.onSSE('firewall', function(data) {
    if (!data.error) {
      _fwData = data;
      renderFirewallPanel();
    }
  });

  // -- Subscribe to SSE status events for traffic rates --
  API.onSSE('status', function(data) {
    updateFirewallTraffic(data);
  });
})();
