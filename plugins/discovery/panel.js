'use strict';
// ── Discovery Plugin Panel (Realm Surveyors) ──
// Standalone IIFE — uses window.RealmAPI for SSE + data access.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('discovery plugin: RealmAPI not available'); return; }

  var panel = document.getElementById('discovery-panel');
  if (!panel) return;

  // Set accent color (gold/amber for discovery theme)
  panel.style.setProperty('--panel-accent', 'rgba(200,170,80,0.5)');

  // Inject summary badge into panel header
  var header = panel.querySelector('.panel-header');
  var headerBadge = null;
  if (header) {
    headerBadge = document.createElement('span');
    headerBadge.className = 'disc-header-badge';
    headerBadge.textContent = '--';
    header.appendChild(headerBadge);
  }

  // Fantasy type labels
  var typeLabels = {
    container: 'Iron Golems', vm: 'Ethereal Planes',
    service: 'Runic Wards', wifi_client: 'Wandering Spirits',
    snmp_port: 'Crystal Channels', reverse_proxy: 'Gate Wardens',
    ha_device: 'Enchanted Artifacts', collectd_host: 'Scrying Stones',
    local_project: 'Arcane Tomes', github_repo: 'Distant Tomes',
    manual: 'Inscribed Vassals',
  };

  function typeLabel(t) { return typeLabels[t] || t; }

  function statusClass(s) {
    if (s === 'running' || s === 'connected' || s === 'up') return 'disc-status-up';
    if (s === 'stopped' || s === 'failed' || s === 'down') return 'disc-status-down';
    return 'disc-status-stale';
  }

  // ── Summary bar ──
  function renderSummary(summary) {
    var el = document.getElementById('discovery-summary');
    if (!el) return;
    el.textContent = '';

    var items = [
      { label: 'Vassals', value: summary.total || 0, cls: 'disc-stat-total' },
      { label: 'Active', value: summary.running || 0, cls: 'disc-stat-active' },
      { label: 'Stopped', value: summary.stopped || 0, cls: 'disc-stat-stopped' },
      { label: 'Failed', value: summary.failed || 0, cls: 'disc-stat-failed' },
    ];

    for (var i = 0; i < items.length; i++) {
      var stat = document.createElement('div');
      stat.className = 'disc-stat ' + items[i].cls;
      var num = document.createElement('span');
      num.className = 'disc-stat-num';
      num.textContent = items[i].value;
      var lbl = document.createElement('span');
      lbl.className = 'disc-stat-label';
      lbl.textContent = items[i].label;
      stat.appendChild(num);
      stat.appendChild(lbl);
      el.appendChild(stat);
    }

    // Update header badge
    if (headerBadge) {
      headerBadge.textContent = summary.total + ' vassals';
    }
  }

  // ── Provider grid ──
  function renderProviders(providers) {
    var el = document.getElementById('discovery-providers');
    if (!el || !providers || !providers.length) return;
    el.textContent = '';

    var title = document.createElement('div');
    title.className = 'disc-section-title';
    title.textContent = 'Survey Guilds';
    el.appendChild(title);

    var grid = document.createElement('div');
    grid.className = 'disc-provider-grid';

    for (var i = 0; i < providers.length; i++) {
      var p = providers[i];
      var row = document.createElement('div');
      row.className = 'disc-provider-row';

      var dot = document.createElement('span');
      dot.className = 'disc-dot disc-status-up';
      row.appendChild(dot);

      var name = document.createElement('span');
      name.className = 'disc-provider-name';
      name.textContent = p.name;
      row.appendChild(name);

      var types = document.createElement('span');
      types.className = 'disc-provider-types';
      var typeText = (p.entity_types || []).map(typeLabel).join(', ');
      types.textContent = typeText;
      types.title = typeText;
      row.appendChild(types);

      var interval = document.createElement('span');
      interval.className = 'disc-provider-interval';
      interval.textContent = p.interval ? (p.interval + 's') : '--';
      row.appendChild(interval);

      grid.appendChild(row);
    }
    el.appendChild(grid);
  }

  // ── Per-host breakdown ──
  function renderHosts(subEntities, summary) {
    var el = document.getElementById('discovery-hosts');
    if (!el) return;
    el.textContent = '';

    var title = document.createElement('div');
    title.className = 'disc-section-title';
    title.textContent = 'Host Garrisons';
    el.appendChild(title);

    var hostIds = Object.keys(subEntities);
    if (!hostIds.length) {
      var empty = document.createElement('div');
      empty.className = 'disc-empty';
      empty.textContent = 'No vassals discovered yet...';
      el.appendChild(empty);
      return;
    }

    // Sort by entity count descending
    hostIds.sort(function(a, b) {
      return subEntities[b].length - subEntities[a].length;
    });

    for (var i = 0; i < hostIds.length; i++) {
      var hostId = hostIds[i];
      var entities = subEntities[hostId];
      var node = API.getNode(hostId);
      var hostLabel = node ? (node.label || hostId) : hostId;
      var hostIcon = node ? (node.icon || '\u2726') : '\u2726';

      var failedCount = 0;
      var runningCount = 0;
      for (var j = 0; j < entities.length; j++) {
        if (entities[j].status === 'failed') failedCount++;
        if (entities[j].status === 'running' || entities[j].status === 'up' || entities[j].status === 'connected') runningCount++;
      }

      var row = document.createElement('div');
      row.className = 'disc-host-row';
      row.dataset.nodeId = hostId;

      var icon = document.createElement('span');
      icon.className = 'disc-host-icon';
      icon.textContent = hostIcon;
      row.appendChild(icon);

      var label = document.createElement('span');
      label.className = 'disc-host-label';
      label.textContent = hostLabel;
      row.appendChild(label);

      var count = document.createElement('span');
      count.className = 'disc-host-count';
      count.textContent = entities.length;
      row.appendChild(count);

      if (failedCount > 0) {
        var badge = document.createElement('span');
        badge.className = 'disc-host-failed';
        badge.textContent = failedCount + ' failed';
        row.appendChild(badge);
      }

      var bar = document.createElement('div');
      bar.className = 'disc-host-bar';
      var fill = document.createElement('div');
      fill.className = 'disc-host-fill';
      var pct = entities.length > 0 ? (runningCount / entities.length * 100) : 0;
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      row.appendChild(bar);

      // Click to pan to node on map
      row.addEventListener('click', (function(nid) {
        return function() {
          var n = API.getNode(nid);
          if (n && typeof n.x === 'number') {
            document.dispatchEvent(new CustomEvent('realm-pan-to-node', { detail: { nodeId: nid, x: n.x, y: n.y } }));
          }
        };
      })(hostId));

      el.appendChild(row);
    }
  }

  // ── Unlinked entities ──
  function renderUnlinked(subEntities) {
    var el = document.getElementById('discovery-unlinked');
    if (!el) return;
    el.textContent = '';

    // Collect all unlinked entities
    var unlinked = [];
    var hostIds = Object.keys(subEntities);
    for (var i = 0; i < hostIds.length; i++) {
      var entities = subEntities[hostIds[i]];
      for (var j = 0; j < entities.length; j++) {
        if (!entities[j].linked_node_id) {
          unlinked.push(entities[j]);
        }
      }
    }

    if (!unlinked.length) return;

    var title = document.createElement('div');
    title.className = 'disc-section-title';
    title.textContent = 'Unbound Vassals';
    el.appendChild(title);

    // Cap at 20
    var max = Math.min(unlinked.length, 20);
    for (var k = 0; k < max; k++) {
      var e = unlinked[k];
      var row = document.createElement('div');
      row.className = 'disc-unlinked-row';

      var dot = document.createElement('span');
      dot.className = 'disc-dot ' + statusClass(e.status);
      row.appendChild(dot);

      var name = document.createElement('span');
      name.className = 'disc-unlinked-name';
      name.textContent = e.name || e.id;
      name.title = e.id;
      row.appendChild(name);

      var type = document.createElement('span');
      type.className = 'disc-unlinked-type';
      type.textContent = typeLabel(e.type);
      row.appendChild(type);

      el.appendChild(row);
    }

    if (unlinked.length > max) {
      var more = document.createElement('div');
      more.className = 'disc-more';
      more.textContent = '+ ' + (unlinked.length - max) + ' more unbound...';
      el.appendChild(more);
    }
  }

  // ── Full render ──
  function render(data) {
    if (!data) return;
    renderSummary(data.summary || { total: 0, running: 0, stopped: 0, failed: 0 });
    renderHosts(data.sub_entities || {}, data.summary);
    renderUnlinked(data.sub_entities || {});
  }

  // ── Initial fetch ──
  fetch('/discovery').then(function(r) { return r.json(); }).then(function(data) {
    render(data);
  }).catch(function(err) { console.error('discovery panel: fetch error', err); });

  fetch('/discovery/providers').then(function(r) { return r.json(); }).then(function(providers) {
    renderProviders(providers);
  }).catch(function(err) { console.error('discovery panel: providers fetch error', err); });

  // ── SSE subscription ──
  API.onSSE('discovery', function(data) {
    render(data);
  });
})();
