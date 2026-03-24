'use strict';
// ── Plugin Manager Panel ──
// Fetches /plugins and /sse/sources, renders a plugin status dashboard.

(function() {
  var API = window.RealmAPI;
  if (!API) return;

  var body = document.getElementById('pm-body');
  if (!body) return;

  var panel = document.getElementById('plugin-manager-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(180,140,255,0.5)');
  }

  // ── Badge in header ──
  var header = panel && panel.querySelector('.panel-header');
  if (header) {
    var badge = document.createElement('span');
    badge.className = 'pm-badge';
    badge.id = 'pm-badge';
    badge.textContent = '--';
    header.appendChild(badge);
  }

  // ── Status dot color ──
  function statusColor(s) {
    if (s === 'loaded') return '#50c878';
    if (s === 'error') return '#e05050';
    if (s === 'discovered') return '#c0a040';
    return '#607080';
  }

  // ── Build a plugin card ──
  function makeCard(p, sseSources) {
    var card = document.createElement('div');
    card.className = 'pm-card' + (p.status === 'error' ? ' pm-card-error' : '');

    // Header row: icon + name + status dot
    var hdr = document.createElement('div');
    hdr.className = 'pm-card-header';

    var icon = document.createElement('span');
    icon.className = 'pm-icon';
    icon.textContent = p.icon || '\u2728';

    var name = document.createElement('span');
    name.className = 'pm-name';
    name.textContent = p.fantasy_name || p.name;

    var dot = document.createElement('span');
    dot.className = 'pm-dot';
    dot.style.background = statusColor(p.status);
    dot.title = p.status;

    hdr.appendChild(icon);
    hdr.appendChild(name);
    hdr.appendChild(dot);
    card.appendChild(hdr);

    // Tech name + version
    var sub = document.createElement('div');
    sub.className = 'pm-sub';
    sub.textContent = p.name + ' v' + p.version;
    card.appendChild(sub);

    // Description
    if (p.description) {
      var desc = document.createElement('div');
      desc.className = 'pm-desc';
      desc.textContent = p.description;
      card.appendChild(desc);
    }

    // Tags row
    var tags = document.createElement('div');
    tags.className = 'pm-tags';

    // Type tag
    var typeTag = document.createElement('span');
    typeTag.className = 'pm-tag pm-tag-type';
    typeTag.textContent = p.type;
    tags.appendChild(typeTag);

    // Panel tag
    if (p.panel) {
      var panelTag = document.createElement('span');
      panelTag.className = 'pm-tag pm-tag-panel';
      panelTag.textContent = '\u25a3 panel';
      tags.appendChild(panelTag);
    }

    // SSE tag
    var pluginSSE = sseSources.filter(function(s) { return s.name === p.name; });
    if (pluginSSE.length > 0) {
      for (var i = 0; i < pluginSSE.length; i++) {
        var sseTag = document.createElement('span');
        sseTag.className = 'pm-tag pm-tag-sse';
        sseTag.textContent = '\u26a1 ' + pluginSSE[i].event_type + ' ' + pluginSSE[i].interval + 's';
        tags.appendChild(sseTag);
      }
    }

    if (tags.children.length > 0) card.appendChild(tags);
    return card;
  }

  // ── Fetch and render ──
  function render() {
    Promise.all([
      fetch('/plugins').then(function(r) { return r.json(); }),
      fetch('/sse/sources').then(function(r) { return r.json(); })
    ]).then(function(results) {
      var plugins = results[0];
      var sseSources = (results[1] && results[1].sources) || [];
      if (!Array.isArray(plugins)) plugins = plugins.plugins || [];

      // Update badge
      var badgeEl = document.getElementById('pm-badge');
      if (badgeEl) {
        var loaded = plugins.filter(function(p) { return p.status === 'loaded'; }).length;
        badgeEl.textContent = loaded + '/' + plugins.length;
      }

      // Clear and rebuild
      body.textContent = '';

      // Summary bar
      var summary = document.createElement('div');
      summary.className = 'pm-summary';
      var loaded = plugins.filter(function(p) { return p.status === 'loaded'; }).length;
      var withPanels = plugins.filter(function(p) { return p.panel; }).length;
      summary.textContent = loaded + ' enchantments active \u00b7 ' +
        withPanels + ' panels \u00b7 ' + sseSources.length + ' SSE streams';
      body.appendChild(summary);

      // Plugin cards
      plugins.sort(function(a, b) {
        if (a.status !== b.status) return a.status === 'loaded' ? -1 : 1;
        return (a.fantasy_name || a.name).localeCompare(b.fantasy_name || b.name);
      });

      for (var i = 0; i < plugins.length; i++) {
        body.appendChild(makeCard(plugins[i], sseSources));
      }
    }).catch(function(err) {
      body.textContent = '';
      var errEl = document.createElement('div');
      errEl.className = 'pm-loading';
      errEl.textContent = 'Failed to scry enchantments: ' + err.message;
      body.appendChild(errEl);
    });
  }

  // Initial render + refresh every 30s
  render();
  setInterval(render, 30000);
})();
