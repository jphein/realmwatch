'use strict';
// -- Oracle Sight: Wattage of the Realm --
// Per-host CPU/GPU power draw (watts), sourced from the netdata plugin's
// /host-power feed (Intel-RAPL package + nvidia_smi GPU). Reads `host_power`
// from the 10s status SSE blob. Distinct from the HA "Solar Sanctum" panel
// (whole-home solar / grid / battery) — this is per-host silicon draw.

(function () {
  var API = window.RealmAPI;
  if (!API) { console.error('netdata plugin: RealmAPI not available'); return; }

  var BODY = 'hp-body', TOTAL = 'hp-total', EMPTY = 'hp-empty';

  function fmtW(v) {
    if (v === null || v === undefined) return null;
    return (Math.round(v * 10) / 10).toFixed(1);
  }

  function rowTotal(r) {
    return (r.package_watts || 0) + (r.gpu_watts || 0);
  }

  function render(hostPower) {
    var body = document.getElementById(BODY);
    var totalEl = document.getElementById(TOTAL);
    var emptyEl = document.getElementById(EMPTY);
    if (!body) return;

    var ids = hostPower ? Object.keys(hostPower) : [];
    ids.sort(function (a, b) { return rowTotal(hostPower[b]) - rowTotal(hostPower[a]); });

    if (!ids.length) {
      body.textContent = '';
      if (emptyEl) emptyEl.style.display = '';
      if (totalEl) totalEl.textContent = '— W';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    var maxTotal = 0;
    for (var i = 0; i < ids.length; i++) {
      var t = rowTotal(hostPower[ids[i]]);
      if (t > maxTotal) maxTotal = t;
    }

    var frag = document.createDocumentFragment();
    var grandTotal = 0;
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k];
      var rec = hostPower[id];
      grandTotal += rowTotal(rec);
      frag.appendChild(makeRow(id, rec, maxTotal));
    }
    body.textContent = '';
    body.appendChild(frag);
    if (totalEl) totalEl.textContent = (Math.round(grandTotal * 10) / 10).toFixed(1) + ' W';
  }

  function makeRow(id, rec, maxTotal) {
    var total = rowTotal(rec);

    var item = document.createElement('div');
    item.className = 'hp-item';
    item.dataset.nodeId = id;

    var name = document.createElement('div');
    name.className = 'hp-name';
    name.textContent = rec.name || id;

    var bar = document.createElement('div');
    bar.className = 'hp-bar';
    var fill = document.createElement('div');
    fill.className = 'hp-fill';
    var pct = maxTotal > 0 ? Math.max(4, (total / maxTotal) * 100) : 4;
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    var info = document.createElement('div');
    info.className = 'hp-info';
    info.appendChild(name);
    info.appendChild(bar);

    var stats = document.createElement('div');
    stats.className = 'hp-stats';
    var cpuStr = fmtW(rec.package_watts);
    var gpuStr = fmtW(rec.gpu_watts);
    var parts = [];
    if (cpuStr !== null) parts.push('⚡ ' + cpuStr);
    if (gpuStr !== null) parts.push('🎮 ' + gpuStr);
    stats.textContent = parts.length ? parts.join('  ') + ' W' : '—';

    item.appendChild(info);
    item.appendChild(stats);

    // Click to pan/zoom + highlight the host node on the map.
    item.addEventListener('click', function () {
      var nodeEl = document.querySelector('[data-tip="' + id + '"]');
      if (!nodeEl) return;
      var nodeLeft = parseInt(nodeEl.style.left) || 0;
      var nodeTop = parseInt(nodeEl.style.top) || 0;
      if (window._realmPanToNode) window._realmPanToNode(nodeLeft, nodeTop);
      nodeEl.classList.add('node-highlight');
      setTimeout(function () { nodeEl.classList.remove('node-highlight'); }, 2000);
    });

    return item;
  }

  // Live updates ride the 10s status SSE (host_power folded in by the plugin).
  API.onSSE('status', function (d) {
    if (d && d.host_power) render(d.host_power);
  });

  // Initial paint from the last status snapshot (if one already arrived).
  var last = API.getLastStatus && API.getLastStatus();
  if (last && last.host_power) render(last.host_power);
})();
