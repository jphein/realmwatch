'use strict';
// -- Ward of the Battery (NUT/UPS) --
// Per-UPS load / battery / runtime / wall-draw watts + the host(s) each UPS
// powers, sourced from the nut plugin's /ups-power feed. Reads `ups_power`
// from the 10s status SSE blob. Aggregate UPS watts are deliberately distinct
// from #108's per-host RAPL (Wattage of the Realm) — wall vs silicon.

(function () {
  var API = window.RealmAPI;
  if (!API) { console.error('nut plugin: RealmAPI not available'); return; }

  var BODY = 'ward-body', TOTAL = 'ward-total', EMPTY = 'ward-empty';

  function fmt(v, d) {
    if (v === null || v === undefined) return null;
    var p = Math.pow(10, d || 0);
    return (Math.round(v * p) / p).toString();
  }

  function runtimeStr(s) {
    if (s === null || s === undefined) return null;
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
  }

  function render(upsPower) {
    var body = document.getElementById(BODY);
    var totalEl = document.getElementById(TOTAL);
    var emptyEl = document.getElementById(EMPTY);
    if (!body) return;

    var keys = upsPower ? Object.keys(upsPower) : [];
    keys.sort(function (a, b) { return (upsPower[b].watts || 0) - (upsPower[a].watts || 0); });

    if (!keys.length) {
      body.textContent = '';
      if (emptyEl) emptyEl.style.display = '';
      if (totalEl) totalEl.textContent = '— W';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    var frag = document.createDocumentFragment();
    var grandTotal = 0;
    for (var i = 0; i < keys.length; i++) {
      var rec = upsPower[keys[i]];
      if (rec.watts) grandTotal += rec.watts;
      frag.appendChild(makeCard(rec));
    }
    body.textContent = '';
    body.appendChild(frag);
    if (totalEl) totalEl.textContent = (Math.round(grandTotal * 10) / 10) + ' W';
  }

  function makeCard(rec) {
    var card = document.createElement('div');
    card.className = 'ward-item' + (rec.healthy ? '' : ' ward-offline');
    if (rec.ups_node) card.dataset.nodeId = rec.ups_node;

    // Header: name + model + status pill
    var head = document.createElement('div');
    head.className = 'ward-head';
    var name = document.createElement('span');
    name.className = 'ward-name';
    name.textContent = rec.name || '?';
    var pill = document.createElement('span');
    pill.className = 'ward-pill ' + (rec.healthy ? 'ok' : 'bad');
    pill.textContent = rec.status || (rec.healthy ? 'OL' : 'offline');
    head.appendChild(name);
    head.appendChild(pill);

    if (rec.model) {
      var model = document.createElement('div');
      model.className = 'ward-model';
      model.textContent = rec.model;
      head.appendChild(model);
    }

    // Battery bar
    var batWrap = document.createElement('div');
    batWrap.className = 'ward-bat';
    var batFill = document.createElement('div');
    batFill.className = 'ward-bat-fill';
    var pct = (rec.battery_charge === null || rec.battery_charge === undefined) ? 0 : rec.battery_charge;
    batFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (pct < 50) batFill.classList.add('low');
    batWrap.appendChild(batFill);

    // Stats line: watts · load% · battery% · runtime.
    // Built with DOM nodes only (no innerHTML) — XSS-safe, mirrors sibling panels.
    var stats = document.createElement('div');
    stats.className = 'ward-stats';
    var segs = [];
    var w = fmt(rec.watts, 0);
    if (w !== null) segs.push({ text: w + ' W', strong: true });
    var load = fmt(rec.load_pct, 0);
    if (load !== null) segs.push({ text: load + '% load' });
    var bat = fmt(rec.battery_charge, 0);
    if (bat !== null) segs.push({ text: '🔋 ' + bat + '%' });
    var rt = runtimeStr(rec.runtime_s);
    if (rt !== null) segs.push({ text: '⏱ ' + rt });
    if (!segs.length) {
      stats.textContent = '—';
    } else {
      for (var s = 0; s < segs.length; s++) {
        if (s > 0) stats.appendChild(document.createTextNode(' · '));
        var el = document.createElement(segs[s].strong ? 'b' : 'span');
        el.textContent = segs[s].text;
        stats.appendChild(el);
      }
    }

    card.appendChild(head);
    card.appendChild(batWrap);
    card.appendChild(stats);

    // Powered hosts
    if (rec.powers && rec.powers.length) {
      var powers = document.createElement('div');
      powers.className = 'ward-powers';
      powers.textContent = '⚡ powers: ' + rec.powers.join(', ');
      card.appendChild(powers);
    }

    // Click to pan to the UPS node on the map. ups_node comes from an operator
    // alias, so it may contain selector-breaking characters (quotes, etc.) —
    // guard the query so a bad alias can't throw out of the click handler.
    if (rec.ups_node) {
      card.addEventListener('click', function () {
        try {
          var nodeEl = document.querySelector('[data-tip="' + rec.ups_node + '"]');
          if (!nodeEl) return;
          var x = parseInt(nodeEl.style.left) || 0;
          var y = parseInt(nodeEl.style.top) || 0;
          if (window._realmPanToNode) window._realmPanToNode(x, y);
          nodeEl.classList.add('node-highlight');
          setTimeout(function () { nodeEl.classList.remove('node-highlight'); }, 2000);
        } catch (e) {
          console.error('nut plugin: failed to query node for', rec.ups_node, e);
        }
      });
    }

    return card;
  }

  // Live updates ride the 10s status SSE (ups_power folded in by the plugin).
  API.onSSE('status', function (d) {
    if (d && d.ups_power) render(d.ups_power);
  });

  // Initial paint from the last status snapshot.
  var last = API.getLastStatus && API.getLastStatus();
  if (last && last.ups_power) render(last.ups_power);
})();
