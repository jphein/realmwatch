'use strict';
// ── Debug Plugin — Arcane Mirror, Arcane Grimoire, Scrying Terminal ──
// Standalone IIFE — no ES module imports. Uses RealmAPI + fetch for data.
// Security model: full trust — plugin content is locally authored (see plugin-api.js)

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('debug plugin: RealmAPI not available'); return; }

  // ══════════════════════════════════════════════════════════════
  // ARCANE CONFIG (external service settings — lives in spellbook DOM)
  // ══════════════════════════════════════════════════════════════

  var _cfgFields = {
    'cfg-chat-model': { path: 'chat.deployment', also: 'chat.model' },
    'cfg-reasoning': { path: 'chat.reasoning_effort' },
    'cfg-max-tokens': { path: 'chat.max_completion_tokens', type: 'number' },
    'cfg-multi-timeout': { path: 'chat.multi_chat_timeout', type: 'number' },
    'cfg-voice': { path: 'speech.voice' },
    'cfg-silence': { path: 'speech.silence_timeout', type: 'number' },
    'cfg-subtitles': { path: 'speech.live_subtitles', type: 'checkbox' },
    'cfg-oracle-model': { path: 'oracle.model' },
    'cfg-oracle-reasoning': { path: 'oracle.reasoning_effort' },
    'cfg-oracle-voice': { path: 'oracle.voice' },
  };

  function _getPath(obj, path) {
    var parts = path.split('.');
    var v = obj;
    for (var i = 0; i < parts.length; i++) { v = v && v[parts[i]]; }
    return v;
  }

  function loadArcaneConfig() {
    fetch('/config').then(function(r) {
      if (!r.ok) return;
      return r.json();
    }).then(function(cfg) {
      if (!cfg) return;
      var entries = Object.entries(_cfgFields);
      for (var i = 0; i < entries.length; i++) {
        var id = entries[i][0], spec = entries[i][1];
        var el = document.getElementById(id);
        if (!el) continue;
        var val = _getPath(cfg, spec.path);
        if (val == null) continue;
        if (spec.type === 'checkbox') el.checked = !!val;
        else el.value = val;
      }
    }).catch(function() { /* config endpoint may not be available yet */ });
  }

  function _saveArcaneConfig() {
    var update = { chat: {}, speech: {}, oracle: {} };
    var entries = Object.entries(_cfgFields);
    for (var i = 0; i < entries.length; i++) {
      var id = entries[i][0], spec = entries[i][1];
      var el = document.getElementById(id);
      if (!el) continue;
      var parts = spec.path.split('.');
      var section = parts[0], key = parts[1];
      var val;
      if (spec.type === 'checkbox') val = el.checked;
      else if (spec.type === 'number') val = parseFloat(el.value);
      else val = el.value;
      update[section][key] = val;
      if (spec.also) {
        var also = spec.also.split('.');
        update[also[0]][also[1]] = val;
      }
    }
    var statusEl = document.getElementById('cfg-status');
    fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    }).then(function(r) {
      if (statusEl) {
        statusEl.textContent = r.ok ? 'Config saved \u2714' : 'Save failed';
        setTimeout(function() { statusEl.textContent = ''; }, 3000);
      }
    }).catch(function() {
      if (statusEl) statusEl.textContent = 'Save failed';
    });
  }

  var _cfgSaveBtn = document.getElementById('cfg-save-btn');
  if (_cfgSaveBtn) _cfgSaveBtn.addEventListener('click', _saveArcaneConfig);
  loadArcaneConfig();

  // ══════════════════════════════════════════════════════════════
  // SERVER INFO
  // ══════════════════════════════════════════════════════════════

  function loadServerInfo() {
    fetch('/server-info').then(function(r) {
      if (!r.ok) return;
      return r.json();
    }).then(function(info) {
      if (!info) return;
      var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      set('srv-port', info.port);
      set('srv-domain', info.domain || '(none)');
      set('srv-hostname', info.hostname);
      set('srv-pid', info.pid);
      var h = Math.floor(info.uptime / 3600), m = Math.floor((info.uptime % 3600) / 60);
      set('srv-uptime', h > 0 ? h + 'h ' + m + 'm' : m + 'm');
    }).catch(function() { /* server-info may not be available */ });
  }
  loadServerInfo();
  setInterval(loadServerInfo, 60000);

  // ══════════════════════════════════════════════════════════════
  // HERALD CONTROLS (lives in spellbook DOM)
  // ══════════════════════════════════════════════════════════════

  var _heraldStatus = document.getElementById('herald-status');
  function _heraldAction(action) {
    var interval = (document.getElementById('cfg-herald-interval') || {}).value || 90;
    var url = '/herald?action=' + action + '&interval=' + interval;
    if (_heraldStatus) _heraldStatus.textContent = action + '...';
    fetch(url).then(function(r) { return r.json(); }).then(function(d) {
      if (_heraldStatus) {
        if (d.error) _heraldStatus.textContent = d.error;
        else if (d.pid) _heraldStatus.textContent = 'Running (PID ' + d.pid + ', ' + d.interval + 's)';
        else if (d.stopped) _heraldStatus.textContent = 'Stopped';
        else if (d.output) _heraldStatus.textContent = 'Round complete';
        else if (d.running) _heraldStatus.textContent = 'Running (PIDs: ' + d.pids.join(',') + ')';
        else _heraldStatus.textContent = 'Not running';
      }
    }).catch(function() { if (_heraldStatus) _heraldStatus.textContent = 'Error'; });
  }
  var _hStartBtn = document.getElementById('herald-start-btn');
  var _hStopBtn = document.getElementById('herald-stop-btn');
  var _hOnceBtn = document.getElementById('herald-once-btn');
  if (_hStartBtn) _hStartBtn.addEventListener('click', function() { _heraldAction('start'); });
  if (_hStopBtn) _hStopBtn.addEventListener('click', function() { _heraldAction('stop'); });
  if (_hOnceBtn) _hOnceBtn.addEventListener('click', function() { _heraldAction('once'); });
  _heraldAction('status');

  // ══════════════════════════════════════════════════════════════
  // ARCANE MIRROR (Debug Panel)
  // ══════════════════════════════════════════════════════════════

  var _dbgPanel = document.getElementById('debug-panel');
  var _dbgBody = document.getElementById('debug-body');
  var _dbgSearch = document.getElementById('debug-search');
  var _dbgSseStatus = null;
  var _dbgTab = 'all';
  var _dbgDbInfo = null;
  var _dbgRefreshTimer = null;
  var _cachedTopology = null;
  var _cachedStatus = null;

  // Inject SSE status badge into the panel header
  if (_dbgPanel) {
    var hdr = _dbgPanel.querySelector('.panel-header');
    if (hdr) {
      _dbgSseStatus = document.createElement('span');
      _dbgSseStatus.id = 'debug-poll-count';
      _dbgSseStatus.className = 'debug-stat';
      hdr.appendChild(_dbgSseStatus);
    }
  }

  function scheduleDebugRefresh() {
    clearTimeout(_dbgRefreshTimer);
    _dbgRefreshTimer = setTimeout(_dbgRefresh, 200);
  }

  // Tab switching
  document.querySelectorAll('.debug-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.debug-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      _dbgTab = tab.dataset.dtab;
      _dbgRefresh();
    });
  });

  // Filter
  if (_dbgSearch) _dbgSearch.addEventListener('input', function() { _dbgRefresh(); });

  // ── Helpers ──

  function _dbgSection(title, id, content, collapsed) {
    return '<div class="dbg-section' + (collapsed ? ' collapsed' : '') + '" data-dbg="' + id + '">' +
      '<div class="dbg-section-title">' + title + '</div>' +
      '<div class="dbg-section-body">' + content + '</div></div>';
  }

  function _dbgKV(k, v, cls) {
    var vc = typeof v === 'number' ? (v === 0 ? 'dim' : '') : (cls || '');
    return '<div class="dbg-kv"><span class="dbg-k">' + k + '</span><span class="dbg-v ' + vc + '">' + _escH(String(v)) + '</span></div>';
  }

  function _escH(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _dbgTree(obj, depth, filter) {
    if (obj === null || obj === undefined) return '<span class="dbg-v dim">null</span>';
    if (typeof obj !== 'object') return '<span class="dbg-v">' + _escH(String(obj)) + '</span>';
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '<span class="dbg-v dim">[]</span>';
      if (depth > 2) return '<span class="dbg-v dim">[' + obj.length + ' items]</span>';
      return obj.slice(0, 20).map(function(v, i) {
        return '<div class="dbg-kv"><span class="dbg-k">[' + i + ']</span>' + _dbgTree(v, depth+1, filter) + '</div>';
      }).join('') + (obj.length > 20 ? '<div class="dbg-v dim">...+' + (obj.length - 20) + ' more</div>' : '');
    }
    var entries = Object.entries(obj);
    if (entries.length === 0) return '<span class="dbg-v dim">{}</span>';
    var filtered = filter
      ? entries.filter(function(e) {
          var s = e[0] + ' ' + JSON.stringify(e[1]);
          return s.toLowerCase().includes(filter);
        })
      : entries;
    if (depth > 2) return '<span class="dbg-v dim">{' + filtered.length + ' keys}</span>';
    return '<div class="dbg-tree">' + filtered.map(function(e) {
      return '<div class="dbg-kv"><span class="dbg-k">' + _escH(e[0]) + '</span>' + _dbgTree(e[1], depth+1, filter) + '</div>';
    }).join('') + '</div>';
  }

  // Check SSE connectivity by pinging the server
  var _sseConnected = false;
  function _checkSseStatus() {
    fetch('/ping').then(function(r) { _sseConnected = r.ok; }).catch(function() { _sseConnected = false; });
  }
  _checkSseStatus();
  setInterval(_checkSseStatus, 10000);

  function _dbgRefresh() {
    if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
    var d = _cachedStatus;
    var filter = (_dbgSearch ? _dbgSearch.value : '').toLowerCase().trim();
    var tab = _dbgTab;
    var html = '';

    if (_dbgSseStatus) _dbgSseStatus.textContent = _sseConnected ? 'sse:live' : 'sse:off';

    // Status overview
    if (tab === 'all' || tab === 'status') {
      var s = d ? {
        realm_scale: d.realm_scale, forge_cpu: d.forge && d.forge.usage, mana_mem: d.mana && d.mana.usage,
        gpu: d.gpu && d.gpu.usage, uptime: d.adult && d.adult.uptime, load: d.adult && d.adult.load1,
        host: d.host && d.host.hostname, sse: _sseConnected ? 'live' : 'off',
      } : { status: 'no data yet' };
      html += _dbgSection('Status', 'status', _dbgTree(s, 0, filter));
    }

    // Collectd
    if ((tab === 'all' || tab === 'collectd') && d && d.collectd) {
      var hosts = Object.keys(d.collectd).length;
      var body = _dbgKV('hosts', hosts);
      body += _dbgTree(d.collectd, 0, filter);
      html += _dbgSection('Collectd (' + hosts + ' hosts)', 'collectd', body, tab === 'all');
    }

    // WiFi
    if ((tab === 'all' || tab === 'wifi') && d && d.wifi) {
      var wifiClients = Object.keys(d.wifi).length;
      var wifiBody = _dbgKV('clients', wifiClients);
      wifiBody += _dbgTree(d.wifi, 0, filter);
      html += _dbgSection('WiFi (' + wifiClients + ' clients)', 'wifi', wifiBody, tab === 'all');
    }

    // HA
    if ((tab === 'all' || tab === 'ha') && d && d.ha) {
      var ents = Object.keys(d.ha).length;
      var haBody = _dbgKV('entities', ents);
      haBody += _dbgTree(d.ha, 0, filter);
      html += _dbgSection('Home Assistant (' + ents + ')', 'ha', haBody, tab === 'all');
    }

    // Tailscale
    if ((tab === 'all' || tab === 'tailscale') && d && d.tailscale) {
      var ts = d.tailscale;
      var tsBody = _dbgKV('online', (ts.online && ts.online.length) || 0, 'ok');
      tsBody += _dbgKV('offline', (ts.offline && ts.offline.length) || 0, (ts.offline && ts.offline.length) ? 'warn' : '');
      tsBody += _dbgTree(ts, 0, filter);
      html += _dbgSection('Tailscale', 'tailscale', tsBody, tab === 'all');
    }

    // Topology
    if (tab === 'all' || tab === 'topology') {
      var t = _cachedTopology || {};
      var topoBody = _dbgKV('nodes', (t.nodes && t.nodes.length) || 0);
      topoBody += _dbgKV('connections', (t.connections && t.connections.length) || 0);
      topoBody += _dbgKV('regions', (t.regions && t.regions.length) || 0);
      if (tab === 'topology') {
        var types = {};
        (t.nodes || []).forEach(function(n) { types[n.type || 'unknown'] = (types[n.type || 'unknown'] || 0) + 1; });
        topoBody += _dbgKV('types', JSON.stringify(types));
        if (d && d.tailscale) {
          var onlineNodes = (t.nodes || []).filter(function(n) { return n.online !== false; }).length;
          topoBody += _dbgKV('online nodes', onlineNodes, 'ok');
        }
        topoBody += _dbgTree(t, 0, filter);
      }
      html += _dbgSection('Topology', 'topology', topoBody, tab === 'all');
    }

    // Events
    if (tab === 'all' || tab === 'events') {
      var logBody = document.getElementById('quest-log-body');
      var count = logBody ? logBody.children.length : 0;
      var evBody = _dbgKV('log entries', count);
      evBody += _dbgKV('delivery', 'SSE (real-time)');
      html += _dbgSection('Events (' + count + ')', 'events', evBody);
    }

    // DB / Settings
    if (tab === 'all' || tab === 'db') {
      var dbBody = '';
      if (_dbgDbInfo) {
        dbBody += _dbgKV('db size', (_dbgDbInfo.db_size / 1024).toFixed(0) + ' KB');
        dbBody += _dbgKV('notion synced', _dbgDbInfo.notion_synced);
        dbBody += _dbgKV('wifi scan', _dbgDbInfo.wifi_scan_ts ? new Date(_dbgDbInfo.wifi_scan_ts * 1000).toLocaleTimeString() : 'none');
        dbBody += _dbgKV('namespaces', (_dbgDbInfo.settings_ns || []).join(', '));
        if (_dbgDbInfo.tables) dbBody += _dbgTree(_dbgDbInfo.tables, 0, filter);
      } else {
        dbBody += _dbgKV('loading...', '');
      }
      var ls = localStorage.getItem('realm-map-settings');
      if (ls) {
        try {
          var settings = JSON.parse(ls);
          dbBody += _dbgKV('local sliders', Object.keys(settings.sliders || {}).length);
          dbBody += _dbgKV('local cbs', Object.keys(settings.checkboxes || {}).length);
          if (tab === 'db') dbBody += _dbgTree(settings, 0, filter);
        } catch (e) { dbBody += _dbgKV('localStorage', 'parse error', 'err'); }
      }
      html += _dbgSection('DB / Settings', 'db', dbBody, tab === 'all');
    }

    // Safe DOM update — debug panel renders trusted local data only
    _dbgBody.innerHTML = html;  // eslint-disable-line no-unsanitized/property

    // Show empty state when filter matches nothing
    if (filter && !_dbgBody.querySelector('.dbg-kv, .dbg-tree')) {
      _dbgBody.textContent = '';
      var emptyEl = document.createElement('div');
      emptyEl.className = 'panel-empty';
      emptyEl.textContent = 'No matches';
      _dbgBody.appendChild(emptyEl);
      return;
    }

    // Collapse toggle for sections
    _dbgBody.querySelectorAll('.dbg-section-title').forEach(function(el) {
      el.addEventListener('click', function() {
        el.parentElement.classList.toggle('collapsed');
      });
    });

    // Highlight filter matches
    if (filter) {
      var re = new RegExp('(' + filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      _dbgBody.querySelectorAll('.dbg-v, .dbg-k').forEach(function(el) {
        if (el.querySelector('*')) return;
        var txt = el.textContent;
        if (re.test(txt)) {
          el.innerHTML = txt.replace(re, '<span class="dbg-highlight">$1</span>');  // eslint-disable-line no-unsanitized/property
        }
      });
    }
  }

  // Fetch data for the debug panel
  function _fetchDebugData() {
    if (document.hidden) return;
    if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
    _cachedStatus = API.getLastStatus();
    _cachedTopology = API.getTopology();
    fetch('/debug').then(function(r) { return r.json(); }).then(function(d) { _dbgDbInfo = d; }).catch(function() {});
  }

  // Auto-refresh when panel becomes visible
  if (_dbgPanel) {
    new MutationObserver(function() {
      if (_dbgPanel && _dbgPanel.style.display !== 'none') { _fetchDebugData(); _dbgRefresh(); }
    }).observe(_dbgPanel, { attributes: true, attributeFilter: ['style'] });
  }

  // Self-schedule refresh via setInterval (replaces exported scheduleDebugRefresh)
  setInterval(function() {
    if (_dbgPanel && _dbgPanel.style.display !== 'none') {
      _fetchDebugData();
      scheduleDebugRefresh();
    }
  }, 5000);

  // Refresh DB stats every 30s while visible
  setInterval(function() {
    if (_dbgPanel && _dbgPanel.style.display !== 'none') {
      fetch('/debug').then(function(r) { return r.json(); }).then(function(d) { _dbgDbInfo = d; }).catch(function() {});
    }
  }, 30000);

  // ══════════════════════════════════════════════════════════════
  // ARCANE GRIMOIRE — spell catalogue of endpoints, tools, scripts
  // ══════════════════════════════════════════════════════════════

  var _agPanel = null;

  function _initGrimoire() {
    _agPanel = document.getElementById('arcane-grimoire');

    if (!_agPanel) {
      // Build grimoire DOM programmatically
      _agPanel = document.createElement('div');
      _agPanel.id = 'arcane-grimoire';
      _agPanel.className = 'panel plugin-panel';
      _agPanel.style.setProperty('--panel-accent', 'rgba(240,200,100,0.5)');

      var grimoireHTML =
        '<div class="panel-header ag-header">' +
          '<span class="panel-hdr-icon">&#128214;</span>' +
          '<span class="panel-hdr-title">Arcane Grimoire</span>' +
          '<span class="panel-hdr-badge ag-status"></span>' +
        '</div>' +
        '<div class="ag-body" id="ag-body">' +
          '<div class="ag-section">' +
            '<div class="ag-section-toggle" data-target="ac-api">' +
              '<span class="ag-sigil">&#9880;</span>' +
              '<span class="ag-section-title">Ley-Line Endpoints</span>' +
              '<span class="ag-count" id="ac-api-count"></span>' +
              '<span class="ag-chevron"></span>' +
            '</div>' +
            '<div id="ac-api" class="ag-section-body"></div>' +
          '</div>' +
          '<div class="ag-section">' +
            '<div class="ag-section-toggle" data-target="ac-scripts">' +
              '<span class="ag-sigil">&#9876;</span>' +
              '<span class="ag-section-title">Forge Scripts</span>' +
              '<span class="ag-count" id="ac-script-count"></span>' +
              '<span class="ag-chevron"></span>' +
            '</div>' +
            '<div id="ac-scripts" class="ag-section-body"></div>' +
          '</div>' +
        '</div>';

      // Safe: all content is hardcoded string literals, not user input
      _agPanel.innerHTML = grimoireHTML;  // eslint-disable-line no-unsanitized/property

      var dock = document.getElementById('sealed-dock');
      if (dock) dock.parentNode.insertBefore(_agPanel, dock);
      else document.body.appendChild(_agPanel);
    }

    // Register with panel manager for seal/drag/formation behavior
    if (API.registerExistingPanel) {
      API.registerExistingPanel(_agPanel, {
        name: 'Arcane Grimoire',
        icon: '\ud83d\udcd6',
        anchor: 'nw',
        priority: 91,
      });
    }

    var _acEndpoints = [
      { method:'GET', path:'/status', desc:'Full realm status', params:[] },
      { method:'GET', path:'/topology', desc:'Nodes, connections, regions', params:[] },
      { method:'GET', path:'/latency', desc:'fping latency per node', params:[] },
      { method:'GET', path:'/firewall', desc:'nftables rules (60s cache)', params:[] },
      { method:'GET', path:'/energy', desc:'Solar, battery, grid, load', params:[] },
      { method:'GET', path:'/events', desc:'Map events', params:[{name:'since',type:'text',placeholder:'timestamp'},{name:'limit',type:'text',placeholder:'50'}] },
      { method:'GET', path:'/quests', desc:'Active quest log', params:[] },
      { method:'GET', path:'/personas', desc:'All node personas', params:[] },
      { method:'GET', path:'/config', desc:'Chat/speech/oracle config', params:[] },
      { method:'GET', path:'/settings', desc:'UI layout settings', params:[] },
      { method:'GET', path:'/scan/status', desc:'Last WiFi scan results', params:[] },
      { method:'GET', path:'/scan/wifi', desc:'WiFi signal per AP', params:[] },
      { method:'GET', path:'/codex-sync', desc:'Notion lore database', params:[{name:'force',type:'checkbox',label:'Force refresh'}] },
      { method:'GET', path:'/chat/sessions', desc:'Chat session list', params:[] },
      { method:'GET', path:'/chat/history', desc:'Chat history', params:[{name:'session',type:'text',placeholder:'session name'}] },
      { method:'GET', path:'/collectd', desc:'All collectd RRD summaries', params:[{name:'host',type:'text',placeholder:'hostname (optional)'}] },
      { method:'GET', path:'/observation', desc:'Fantasy narration + status', params:[] },
      { method:'GET', path:'/herald', desc:'Herald daemon control', params:[{name:'action',type:'select',options:['status','start','stop','once']},{name:'interval',type:'text',placeholder:'90'}] },
      { method:'GET', path:'/debug', desc:'DB stats & diagnostics', params:[] },
      { method:'SSE', path:'/sse', desc:'Live event stream', params:[] },
      { method:'POST', path:'/event', desc:'Push map event', params:[{name:'type',type:'select',options:['speech','alert','quest','highlight']},{name:'node',type:'text',placeholder:'node id'},{name:'text',type:'textarea',placeholder:'Event text'}] },
      { method:'POST', path:'/chat', desc:'Send chat message', params:[{name:'message',type:'textarea',placeholder:'Message'},{name:'node',type:'text',placeholder:'node id'},{name:'session',type:'text',placeholder:'session'}] },
      { method:'POST', path:'/exec', desc:'Run local command', params:[{name:'command',type:'text',placeholder:'bash command'}] },
      { method:'POST', path:'/ssh', desc:'SSH to topology host', params:[{name:'host',type:'text',placeholder:'hostname'},{name:'command',type:'text',placeholder:'command'}] },
      { method:'POST', path:'/node', desc:'Add/update topology node', params:[{name:'id',type:'text',placeholder:'node id'},{name:'x',type:'text',placeholder:'x'},{name:'y',type:'text',placeholder:'y'}] },
      { method:'POST', path:'/wol', desc:'Wake-on-LAN', params:[{name:'mac',type:'text',placeholder:'AA:BB:CC:DD:EE:FF'},{name:'ip',type:'text',placeholder:'broadcast IP'}] },
      { method:'POST', path:'/personas', desc:'Update persona', params:[{name:'node',type:'text',placeholder:'node id'},{name:'name',type:'text',placeholder:'persona name'}] },
      { method:'POST', path:'/scan', desc:'Trigger WiFi scan', params:[] },
      { method:'DELETE', path:'/settings', desc:'Clear UI settings', params:[] },
    ];

    function _acBuildForm(params) {
      if (!params || !params.length) return '';
      var formHtml = '';
      for (var i = 0; i < params.length; i++) {
        var p = params[i];
        if (p.type === 'textarea') {
          formHtml += '<label>' + p.name + '</label><textarea data-param="' + p.name + '" placeholder="' + (p.placeholder || '') + '"></textarea>';
        } else if (p.type === 'select') {
          formHtml += '<label>' + p.name + '</label><select data-param="' + p.name + '">' + (p.options||[]).map(function(o) { return '<option value="' + o + '">' + o + '</option>'; }).join('') + '</select>';
        } else if (p.type === 'checkbox') {
          formHtml += '<label><input type="checkbox" data-param="' + p.name + '"> ' + (p.label || p.name) + '</label>';
        } else {
          formHtml += '<label>' + p.name + '</label><input type="text" data-param="' + p.name + '" placeholder="' + (p.placeholder || '') + '">';
        }
      }
      return formHtml;
    }

    function _acCollectParams(formEl) {
      var params = {};
      formEl.querySelectorAll('[data-param]').forEach(function(el) {
        var name = el.dataset.param;
        if (el.type === 'checkbox') { if (el.checked) params[name] = true; }
        else if (el.value.trim()) params[name] = el.value.trim();
      });
      return params;
    }

    // Render API endpoints — all content is from hardcoded endpoint definitions
    var apiContainer = document.getElementById('ac-api');
    var apiHtml = '';
    for (var i = 0; i < _acEndpoints.length; i++) {
      var ep = _acEndpoints[i];
      var mcls = 'ac-method ac-method-' + ep.method.toLowerCase();
      apiHtml += '<div class="ac-item" data-ac-type="api" data-ac-path="' + ep.path + '" data-ac-method="' + ep.method + '">';
      apiHtml += '<div class="ac-item-header"><span class="' + mcls + '">' + ep.method + '</span><span class="ac-path">' + ep.path + '</span><span class="ac-desc">' + ep.desc + '</span></div>';
      apiHtml += '<div class="ac-form">' + _acBuildForm(ep.params) + '<button class="ac-invoke-btn">Invoke</button><div class="ac-response" style="display:none"></div></div>';
      apiHtml += '</div>';
    }
    if (apiContainer) apiContainer.innerHTML = apiHtml;  // eslint-disable-line no-unsanitized/property
    var apiCountEl = document.getElementById('ac-api-count');
    if (apiCountEl) apiCountEl.textContent = _acEndpoints.length;

    // Render scripts
    (function() {
      var container = document.getElementById('ac-scripts');
      if (!container) return;
      fetch('/scripts').then(function(r) { return r.json(); }).then(function(data) {
        // Build script list using safe DOM methods
        container.textContent = '';
        if (!data.scripts || data.scripts.length === 0) {
          var empty = document.createElement('div');
          empty.style.cssText = 'color:#605040;font-size:9px;padding:8px;font-style:italic';
          empty.textContent = 'The forge is cold...';
          container.appendChild(empty);
        } else {
          for (var j = 0; j < data.scripts.length; j++) {
            var s = data.scripts[j];
            var row = document.createElement('div');
            row.className = 'ac-script';
            var nameSpan = document.createElement('span');
            nameSpan.className = 'ac-script-name';
            nameSpan.textContent = s.name;
            var descSpan = document.createElement('span');
            descSpan.className = 'ac-script-desc';
            descSpan.textContent = s.description;
            var btn = document.createElement('button');
            btn.className = 'ac-script-run';
            btn.dataset.script = s.path;
            btn.textContent = 'Forge';
            row.appendChild(nameSpan);
            row.appendChild(descSpan);
            row.appendChild(btn);
            container.appendChild(row);
          }
        }
        var scriptCountEl = document.getElementById('ac-script-count');
        if (scriptCountEl) scriptCountEl.textContent = data.scripts.length;
      }).catch(function() {
        container.textContent = '';
        var errEl = document.createElement('div');
        errEl.style.cssText = 'color:#805050;font-size:9px;padding:8px;font-style:italic';
        errEl.textContent = 'Failed to consult the forge';
        container.appendChild(errEl);
      });
    })();

    // Invoke API endpoint
    function _acInvokeApi(item) {
      var method = item.dataset.acMethod, path = item.dataset.acPath;
      var form = item.querySelector('.ac-form'), params = _acCollectParams(form);
      var respEl = form.querySelector('.ac-response'), btn = form.querySelector('.ac-invoke-btn');
      btn.classList.add('ac-running'); btn.textContent = 'Casting...';
      respEl.style.display = 'block'; respEl.className = 'ac-response'; respEl.textContent = 'Channeling...';
      var url = path, opts = {};
      if (method === 'GET' || method === 'SSE') {
        var qs = Object.entries(params).map(function(e) { return e[0] + '=' + encodeURIComponent(e[1]); }).join('&');
        if (qs) url += '?' + qs;
      } else if (method === 'POST') {
        opts = { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) };
      } else if (method === 'DELETE') { opts = { method: 'DELETE' }; }
      fetch(url, opts).then(function(r) {
        return r.text().then(function(text) {
          try { respEl.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch(e) { respEl.textContent = text; }
          if (!r.ok) respEl.classList.add('ac-error');
          btn.classList.remove('ac-running'); btn.textContent = 'Invoke';
        });
      }).catch(function(e) {
        respEl.textContent = 'Error: ' + e.message; respEl.classList.add('ac-error');
        btn.classList.remove('ac-running'); btn.textContent = 'Invoke';
      });
    }

    // Event delegation for grimoire
    _agPanel.addEventListener('click', function(e) {
      var toggle = e.target.closest('.ag-section-toggle');
      if (toggle) { toggle.classList.toggle('open'); return; }
      var itemHeader = e.target.closest('.ac-item-header');
      if (itemHeader) { itemHeader.closest('.ac-item').classList.toggle('ac-open'); return; }
      var invokeBtn = e.target.closest('.ac-invoke-btn');
      if (invokeBtn && !invokeBtn.classList.contains('ac-running')) {
        var item = invokeBtn.closest('.ac-item');
        if (item.dataset.acType === 'api') _acInvokeApi(item);
        return;
      }
      var scriptBtn = e.target.closest('.ac-script-run');
      if (scriptBtn) {
        scriptBtn.textContent = 'Forging...';
        scriptBtn.style.pointerEvents = 'none';
        _stExec('bash ' + scriptBtn.dataset.script).then(function() {
          scriptBtn.textContent = 'Forge';
          scriptBtn.style.pointerEvents = '';
        });
      }
    });
  }

  // ══════════════════════════════════════════════════════════════
  // SCRYING TERMINAL — crystal command interface
  // ══════════════════════════════════════════════════════════════

  var _stExecFn = null;

  function _stExec(cmd) {
    if (_stExecFn) return _stExecFn(cmd);
    return Promise.resolve();
  }

  function _initScryingTerminal() {
    var panel = document.getElementById('scrying-terminal');

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'scrying-terminal';
      panel.className = 'panel plugin-panel';
      panel.style.setProperty('--panel-accent', 'rgba(140,180,255,0.5)');

      // Build terminal DOM using safe methods
      var header = document.createElement('div');
      header.className = 'panel-header st-header';
      var hdrIcon = document.createElement('span');
      hdrIcon.className = 'panel-hdr-icon';
      hdrIcon.textContent = '\ud83d\udd2e';
      var hdrTitle = document.createElement('span');
      hdrTitle.className = 'panel-hdr-title';
      hdrTitle.textContent = 'Scrying Terminal';
      header.appendChild(hdrIcon);
      header.appendChild(hdrTitle);

      var stBody = document.createElement('div');
      stBody.className = 'st-body';
      var crystal = document.createElement('div');
      crystal.className = 'st-crystal';
      var scanline = document.createElement('div');
      scanline.className = 'st-scanline';
      crystal.appendChild(scanline);
      var output = document.createElement('div');
      output.id = 'st-output';
      output.className = 'st-output';
      crystal.appendChild(output);
      stBody.appendChild(crystal);

      var inputRow = document.createElement('div');
      inputRow.className = 'st-input-row';
      var prompt = document.createElement('div');
      prompt.className = 'st-rune-prompt';
      prompt.textContent = '\u27E9';
      inputRow.appendChild(prompt);
      var input = document.createElement('input');
      input.type = 'text';
      input.id = 'st-input';
      input.className = 'st-input';
      input.placeholder = 'Speak thy command...';
      input.autocomplete = 'off';
      input.spellcheck = false;
      inputRow.appendChild(input);
      var castBtn = document.createElement('button');
      castBtn.id = 'st-cast';
      castBtn.className = 'st-cast-btn';
      castBtn.title = 'Cast';
      castBtn.textContent = '\u26A1';
      inputRow.appendChild(castBtn);
      stBody.appendChild(inputRow);

      panel.appendChild(header);
      panel.appendChild(stBody);

      var dock = document.getElementById('sealed-dock');
      if (dock) dock.parentNode.insertBefore(panel, dock);
      else document.body.appendChild(panel);
    }

    // Register with panel manager for seal/drag/formation behavior
    if (API.registerExistingPanel) {
      API.registerExistingPanel(panel, {
        name: 'Scrying Terminal',
        icon: '\ud83d\udd2e',
        anchor: 'sw',
        priority: 92,
      });
    }

    var _stOutput = document.getElementById('st-output');
    var _stInput = document.getElementById('st-input');
    var _stCastBtn = document.getElementById('st-cast');
    var _stHistory = [];
    var _stHistIdx = -1;

    function _stAppend(text, cls) {
      var el = document.createElement('div');
      if (cls) el.className = cls;
      el.textContent = text;
      _stOutput.appendChild(el);
      _stOutput.scrollTop = _stOutput.scrollHeight;
    }

    _stExecFn = function(cmd) {
      _stAppend(cmd, 'st-cmd');
      _stCastBtn.classList.add('casting');
      return fetch('/exec', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ command: cmd }) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.output) _stAppend(data.output, 'st-result');
          if (data.error) _stAppend(data.error, 'st-error');
          if (data.exit_code !== 0 && !data.error) _stAppend('The spell faltered (exit ' + data.exit_code + ')', 'st-error');
          _stCastBtn.classList.remove('casting');
        }).catch(function(e) {
          _stAppend('The crystal dims: ' + e.message, 'st-error');
          _stCastBtn.classList.remove('casting');
        });
    };

    function _stSubmit() {
      var cmd = _stInput.value.trim();
      if (!cmd) return;
      _stHistory.unshift(cmd);
      _stHistIdx = -1;
      _stInput.value = '';
      _stExecFn(cmd);
    }

    _stInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { _stSubmit(); }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (_stHistIdx < _stHistory.length - 1) { _stHistIdx++; _stInput.value = _stHistory[_stHistIdx]; }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (_stHistIdx > 0) { _stHistIdx--; _stInput.value = _stHistory[_stHistIdx]; }
        else { _stHistIdx = -1; _stInput.value = ''; }
      }
    });

    _stCastBtn.addEventListener('click', _stSubmit);
    _stAppend('The crystal awakens. Speak thy commands...', 'st-system');
  }

  // ══════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ══════════════════════════════════════════════════════════════

  window.RealmPlugins = window.RealmPlugins || {};
  window.RealmPlugins.debug = {
    init: function(api) {
      _initGrimoire();
      _initScryingTerminal();
      _fetchDebugData();
    }
  };

})();
