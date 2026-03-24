'use strict';
// ── Latency Plugin Panel ──
// Uses window.RealmAPI for SSE subscription and data access.
// Does NOT use esbuild imports — loaded as a standalone script.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('latency plugin: RealmAPI not available'); return; }

  var _latencyMap = null;

  // ── Inject summary badge into panel header ──
  var panel = document.getElementById('latency-panel');
  if (panel) {
    var header = panel.querySelector('.panel-header');
    if (header) {
      var summary = document.createElement('span');
      summary.className = 'latency-summary';
      summary.id = 'latency-summary';
      summary.textContent = '--';
      header.appendChild(summary);
    }
    // Set the panel accent color to match the original
    panel.style.setProperty('--panel-accent', 'rgba(100,180,255,0.5)');
  }

  // ── Latency hue calculation (green -> red) ──
  function latencyHue(ms) {
    if (ms < 1) return 140;   // green -- local switch
    if (ms < 5) return 100;   // lime
    if (ms < 15) return 60;   // yellow
    if (ms < 50) return 30;   // orange
    return 0;                  // red -- slow
  }

  // ── Build a single latency row using safe DOM methods ──
  function makeLatencyRow(e) {
    var row = document.createElement('div');
    row.className = 'latency-row';

    var icon = document.createElement('span');
    icon.className = 'latency-icon';
    icon.textContent = e.icon;

    var label = document.createElement('span');
    label.className = 'latency-label';
    label.textContent = e.label;

    var bar = document.createElement('span');
    bar.className = 'latency-bar';
    var fill = document.createElement('span');
    fill.className = 'latency-fill';
    fill.style.width = e.pct + '%';
    fill.style.background = 'hsl(' + e.hue + ',70%,50%)';
    bar.appendChild(fill);

    var val = document.createElement('span');
    val.className = 'latency-val';
    val.textContent = (e.rtt < 1 ? e.rtt.toFixed(2) : e.rtt.toFixed(1)) + ' ms';

    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(val);
    return row;
  }

  // ── Build node lookup from topology ──
  function buildNodeLookup() {
    var topo = API.getTopology();
    var map = {};
    if (!topo || !topo.nodes) return map;
    for (var i = 0; i < topo.nodes.length; i++) {
      var n = topo.nodes[i];
      map[n.id] = { icon: n.icon || '?', label: n.label || n.id, ip: n.ip || '' };
    }
    return map;
  }

  // ── Update the latency panel UI ──
  function updateLatencyPanel() {
    var body = document.getElementById('latency-body');
    var summaryEl = document.getElementById('latency-summary');
    if (!body || !_latencyMap) return;
    var panelEl = document.getElementById('latency-panel');
    if (!panelEl || panelEl.style.display === 'none') return;

    var data = _latencyMap;

    if (data.groups) {
      // Pre-grouped from server -- skip all sorting/grouping
      if (summaryEl) summaryEl.textContent = data.summary.count + ' nodes \u2022 avg ' + data.summary.avg + 'ms';
      var frag = document.createDocumentFragment();
      for (var g = 0; g < data.groups.length; g++) {
        var group = data.groups[g];
        var title = document.createElement('div');
        title.className = 'latency-group-title';
        title.textContent = group.name;
        frag.appendChild(title);
        for (var j = 0; j < group.entries.length; j++) {
          frag.appendChild(makeLatencyRow(group.entries[j]));
        }
      }
      body.textContent = '';
      body.appendChild(frag);
      return;
    }

    // Fallback: flat {node_id: rtt} map (legacy / direct fetch)
    var nodes = buildNodeLookup();
    var entries = Object.entries(data).sort(function(a, b) { return a[1] - b[1]; });
    if (!entries.length) { body.textContent = 'Probing...'; return; }
    var rtts = entries.map(function(e) { return e[1]; });
    var avg = rtts.reduce(function(s, v) { return s + v; }, 0) / rtts.length;
    var max = rtts[rtts.length - 1];
    if (summaryEl) summaryEl.textContent = entries.length + ' nodes \u2022 avg ' + avg.toFixed(1) + 'ms';
    var frag2 = document.createDocumentFragment();
    for (var k = 0; k < entries.length; k++) {
      var id = entries[k][0];
      var rtt = entries[k][1];
      var n = nodes[id];
      frag2.appendChild(makeLatencyRow({
        id: id, rtt: rtt,
        label: n ? n.label : id,
        icon: n ? n.icon : '?',
        hue: latencyHue(rtt),
        pct: Math.min(rtt / Math.max(max, 1) * 100, 100)
      }));
    }
    body.textContent = '';
    body.appendChild(frag2);
  }

  // ── Subscribe to SSE latency events ──
  API.onSSE('latency', function(data) {
    _latencyMap = data;
    updateLatencyPanel();
  });
})();
