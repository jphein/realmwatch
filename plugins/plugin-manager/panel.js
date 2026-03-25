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
    if (s === 'disabled') return '#808080';
    if (s === 'discovered') return '#c0a040';
    return '#607080';
  }

  // ── Toggle plugin enabled/disabled ──
  function togglePlugin(name, enabled) {
    return fetch('/plugins/toggle', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: name, enabled: enabled})
    }).then(function(r) { return r.json(); });
  }

  // ── Restart notice with button ──
  function showRestartNotice() {
    var notice = document.createElement('div');
    notice.className = 'pm-restart-notice';
    var text = document.createElement('span');
    text.textContent = 'Changes require restart ';
    var btn = document.createElement('button');
    btn.className = 'pm-restart-btn';
    btn.textContent = 'Restart Realm';
    btn.addEventListener('click', function() {
      btn.disabled = true;
      btn.textContent = 'Restarting\u2026';
      fetch('http://localhost:8899/api/restart', {method: 'POST'})
        .then(function() {
          notice.textContent = 'Realm is restarting\u2026';
          notice.className = 'pm-restart-notice pm-restarting';
          // Poll until server is back
          var attempts = 0;
          var poll = setInterval(function() {
            attempts++;
            fetch('/ping').then(function(r) {
              if (r.ok) {
                clearInterval(poll);
                location.reload();
              }
            }).catch(function() {});
            if (attempts > 30) {
              clearInterval(poll);
              notice.textContent = 'Restart timed out \u2014 check server manually';
            }
          }, 1000);
        })
        .catch(function() {
          btn.disabled = false;
          btn.textContent = 'Restart Realm';
          notice.insertAdjacentHTML('beforeend',
            '<div style="font-size:7px;margin-top:2px;opacity:0.7">Launcher not running on :8899</div>');
        });
    });
    notice.appendChild(text);
    notice.appendChild(btn);
    body.insertBefore(notice, body.firstChild);
  }

  // ── Build a plugin card ──
  function makeCard(p, sseSources) {
    var card = document.createElement('div');
    card.className = 'pm-card'
      + (p.status === 'error' ? ' pm-card-error' : '')
      + (p.status === 'disabled' ? ' pm-card-disabled' : '');

    // Header row: icon + name + toggle + status dot
    var hdr = document.createElement('div');
    hdr.className = 'pm-card-header';

    var icon = document.createElement('span');
    icon.className = 'pm-icon';
    icon.textContent = p.icon || '\u2728';

    var name = document.createElement('span');
    name.className = 'pm-name';
    name.textContent = p.fantasy_name || p.name;

    // Toggle switch
    var toggle = document.createElement('label');
    toggle.className = 'pm-toggle';
    toggle.title = p.enabled ? 'Disable enchantment (requires restart)' : 'Enable enchantment (requires restart)';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled !== false;
    cb.addEventListener('change', function() {
      var willEnable = cb.checked;
      toggle.title = willEnable ? 'Disable enchantment (requires restart)' : 'Enable enchantment (requires restart)';
      togglePlugin(p.name, willEnable).then(function(res) {
        if (res && res.ok) {
          // Show restart notice with button
          if (!body.querySelector('.pm-restart-notice')) {
            showRestartNotice();
          }
        }
      });
    });
    var slider = document.createElement('span');
    slider.className = 'pm-slider';
    toggle.appendChild(cb);
    toggle.appendChild(slider);

    var dot = document.createElement('span');
    dot.className = 'pm-dot';
    dot.style.background = statusColor(p.status);
    dot.title = p.status;

    hdr.appendChild(icon);
    hdr.appendChild(name);
    hdr.appendChild(toggle);
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

      // Preserve restart notice if present
      var hadNotice = body.querySelector('.pm-restart-notice');

      // Clear and rebuild
      body.textContent = '';

      if (hadNotice) {
        var notice = document.createElement('div');
        notice.className = 'pm-restart-notice';
        notice.textContent = 'Restart required for changes to take effect';
        body.appendChild(notice);
      }

      // Summary bar
      var summary = document.createElement('div');
      summary.className = 'pm-summary';
      var loaded = plugins.filter(function(p) { return p.status === 'loaded'; }).length;
      var withPanels = plugins.filter(function(p) { return p.panel; }).length;
      summary.textContent = loaded + ' enchantments active \u00b7 ' +
        withPanels + ' panels \u00b7 ' + sseSources.length + ' SSE streams';
      body.appendChild(summary);

      // Plugin cards — loaded first, then disabled, then others
      plugins.sort(function(a, b) {
        var order = {loaded: 0, error: 1, disabled: 2, discovered: 3};
        var oa = order[a.status] !== undefined ? order[a.status] : 4;
        var ob = order[b.status] !== undefined ? order[b.status] : 4;
        if (oa !== ob) return oa - ob;
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
