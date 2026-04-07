'use strict';
// ── Survey Glass Plugin — manual scan runner panel ──
// Standalone script (NOT an ES module). Uses window.RealmAPI for integration.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('scan plugin: RealmAPI not available'); return; }

  // Set panel accent color and inject Run All button into header
  var panel = document.getElementById('scanner-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(220,180,80,0.5)');
    var header = panel.querySelector('.panel-header');
    if (header) {
      var runAllBtn = document.createElement('button');
      runAllBtn.id = 'scanner-run-all';
      runAllBtn.className = 'scanner-run-all-btn';
      runAllBtn.textContent = 'Run All';
      header.appendChild(runAllBtn);
    }
  }

  // ── Scan definitions ──
  var SCANS = [
    {
      id: 'wifi',
      icon: '\ud83d\udce1',
      name: 'Aetheric Survey',
      techName: 'GET /scan \u2014 WiFi AP Scan',
      schedule: { mode: 'bg', every: '90s', by: 'ap_scanner._scanner_loop()' },
      desc: 'Polls all access points via SSH for WiFi client MACs, signal strength, ' +
            'roaming state and DHCP identity. Auto-creates unknown nodes for new devices.',
      fetch: function() { return window.fetch('/scan').then(function(r) { return r.json(); }); },
      format: function(d) {
        var c = d.clients != null ? d.clients : d.total_clients;
        var n = d.nodes_added || 0;
        return (c != null ? c + ' clients' : 'complete') + (n ? ' \u00b7 ' + n + ' new nodes' : '');
      },
      logDetail: function(d) {
        var lines = [];
        if (d.aps) { lines.push('\u2500\u2500 Access Points \u2500\u2500'); Object.keys(d.aps).forEach(function(k) { lines.push('  ' + k + ': ' + (d.aps[k].clients || 0) + ' clients'); }); }
        if (d.summary) { lines.push('\u2500\u2500 Summary \u2500\u2500'); String(d.summary).split('\n').filter(Boolean).forEach(function(l) { lines.push(l); }); }
        return lines;
      }
    },
    {
      id: 'lldp',
      icon: '\ud83d\udd17',
      name: 'Ether Weave',
      techName: 'GET /scan/lldp \u2014 LLDP/CDP Topology',
      schedule: { mode: 'bg', every: '~10m', by: 'every 7th WiFi scan (7\u00d790s)' },
      desc: 'Queries all managed switches and APs for LLDP/CDP neighbor tables. ' +
            'Detects unmanaged switch cliques via the Bron\u2013Kerbosch algorithm.',
      fetch: function() { return window.fetch('/scan/lldp').then(function(r) { return r.json(); }); },
      format: function(d) { return (d.links || 0) + ' links \u00b7 ' + (d.switches || 0) + ' unmanaged switches'; },
      logDetail: function(d) {
        var lines = [];
        if (Array.isArray(d.connections)) {
          lines.push('\u2500\u2500 Connections \u2500\u2500');
          d.connections.slice(0, 20).forEach(function(c) { lines.push('  ' + c.from + ' \u2192 ' + c.to + ' (' + (c.type || 'infra') + ')'); });
          if (d.connections.length > 20) lines.push('  \u2026 and ' + (d.connections.length - 20) + ' more');
        }
        if (d.cliques && d.cliques.length) {
          lines.push('\u2500\u2500 Detected Cliques \u2500\u2500');
          d.cliques.forEach(function(cl) { lines.push('  ' + (Array.isArray(cl) ? cl.join(', ') : cl)); });
        }
        return lines;
      }
    },
    {
      id: 'towers',
      icon: '\ud83d\uddfc',
      name: 'Tower Census',
      techName: 'GET /scan/wifi \u2014 AP Radio Discovery',
      schedule: { mode: 'sse', every: '120s', by: 'SSE broker tick%24 \u00b7 cache TTL 120s' },
      desc: 'Enumerates all access point radios, BSSIDs, SSIDs, channels and band ' +
            'assignments from OpenWrt UCI config via SSH.',
      fetch: function() { return window.fetch('/scan/wifi').then(function(r) { return r.json(); }); },
      format: function(d) {
        var aps = Array.isArray(d) ? d : Object.values(d || {});
        return aps.length + ' towers';
      },
      logDetail: function(d) {
        var aps = Array.isArray(d) ? d : Object.keys(d || {}).map(function(k) { var v = d[k]; v.id = k; return v; });
        var lines = ['\u2500\u2500 Access Points \u2500\u2500'];
        aps.slice(0, 15).forEach(function(ap) { lines.push('  ' + (ap.label || ap.id || ap.name || '?') + ': ' + (ap.ip || '')); });
        if (aps.length > 15) lines.push('  \u2026 and ' + (aps.length - 15) + ' more');
        return lines;
      }
    },
    {
      id: 'firewall',
      icon: '\ud83d\udee1\ufe0f',
      name: 'Ward Inspection',
      techName: 'GET /firewall \u2014 nftables Ruleset',
      schedule: { mode: 'sse', every: '60s', by: 'SSE broker tick%12 \u00b7 cache TTL 30s' },
      desc: 'Parses fw4 nftables JSON from gatekeeper via SSH hop. Maps zone\u2192VLAN ' +
            'rules, active chains, blocked IPs and connection tracking stats.',
      fetch: function() { return window.fetch('/firewall').then(function(r) { return r.json(); }); },
      format: function(d) {
        var zones = Object.keys(d.zones || {}).length;
        var rules = d.rules ? d.rules.length : (d.chain_count || '?');
        return zones + ' zones \u00b7 ' + rules + ' rules';
      },
      logDetail: function(d) {
        var lines = [];
        if (d.zones) {
          lines.push('\u2500\u2500 Zones \u2500\u2500');
          Object.keys(d.zones).forEach(function(z) {
            var info = d.zones[z];
            lines.push('  ' + z + ': VLAN ' + (info.vlan || '?') + ' \u2014 ' + (info.subnet || ''));
          });
        }
        if (d.traffic_top && d.traffic_top.length) {
          lines.push('\u2500\u2500 Top Traffic \u2500\u2500');
          d.traffic_top.slice(0, 8).forEach(function(t) { lines.push('  ' + (t.src || t.label) + ': ' + (t.bytes_str || '')); });
        }
        return lines;
      }
    },
    {
      id: 'collectd',
      icon: '\ud83d\udcca',
      name: 'Flux Reading',
      techName: 'GET /collectd \u2014 RRD Metrics',
      schedule: { mode: 'sse', every: '10s', by: 'SSE broker tick%2 \u00b7 live RRD reads' },
      desc: 'Reads RRD files from /var/lib/collectd for all monitored hosts. ' +
            'Returns traffic rates, ping latency, packet drop and stddev.',
      fetch: function() { return window.fetch('/collectd').then(function(r) { return r.json(); }); },
      format: function(d) {
        var hosts = Object.keys(d && d.hosts ? d.hosts : (d || {})).length;
        return hosts + ' hosts';
      },
      logDetail: function(d) {
        var hosts = Object.keys(d && d.hosts ? d.hosts : (d || {}));
        var lines = ['\u2500\u2500 Hosts \u2500\u2500'];
        hosts.slice(0, 15).forEach(function(h) { lines.push('  ' + h); });
        if (hosts.length > 15) lines.push('  \u2026 and ' + (hosts.length - 15) + ' more');
        return lines;
      }
    },
    {
      id: 'observation',
      icon: '\ud83d\udd2e',
      name: 'Oracle Gaze',
      techName: 'GET /observation \u2014 AI Narration',
      schedule: { mode: 'manual', every: null, by: 'oracle_daemon polls 10s for oracle_query events' },
      desc: 'Triggers the AI oracle to observe current system state and generate a ' +
            'narrated report. Calls Azure AI and posts a voice event to the map.',
      fetch: function() { return window.fetch('/observation').then(function(r) { return r.json(); }); },
      format: function(d) {
        var msg = d.message || d.text || '';
        return msg ? msg.slice(0, 72) + (msg.length > 72 ? '\u2026' : '') : 'observation complete';
      },
      logDetail: function(d) {
        var msg = d.message || d.text || '';
        if (!msg) return [];
        return ['\u2500\u2500 Oracle Message \u2500\u2500'].concat(msg.split('. ').filter(Boolean).map(function(s) { return '  ' + s.trim(); }));
      }
    }
  ];

  // ── Per-scan state ──
  var _state = {};
  SCANS.forEach(function(s) {
    _state[s.id] = { status: 'idle', lastRun: null, duration: null, summary: '', log: [], expanded: false, _start: null, _timer: null };
  });

  // ── Formatters ──
  function _fmtElapsed(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function _fmtTime(ts) {
    if (!ts) return 'never';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // ── Build static card DOM ──
  function _makeCard(scan) {
    var card = document.createElement('div');
    card.className = 'scan-card';
    card.dataset.id = scan.id;

    var hdr = document.createElement('div');
    hdr.className = 'scan-card-hdr';

    var iconEl = document.createElement('span');
    iconEl.className = 'scan-icon';
    iconEl.textContent = scan.icon;

    var titles = document.createElement('div');
    titles.className = 'scan-titles';

    var nameEl = document.createElement('div');
    nameEl.className = 'scan-name';
    nameEl.textContent = scan.name;

    var techEl = document.createElement('div');
    techEl.className = 'scan-tech';
    techEl.textContent = scan.techName;

    titles.appendChild(nameEl);
    titles.appendChild(techEl);

    var dot = document.createElement('span');
    dot.className = 'scan-dot scan-dot--idle';

    var btn = document.createElement('button');
    btn.className = 'scan-run-btn';
    btn.dataset.action = 'run';
    btn.dataset.scan = scan.id;
    btn.textContent = 'Run';

    hdr.appendChild(iconEl);
    hdr.appendChild(titles);
    hdr.appendChild(dot);
    hdr.appendChild(btn);
    card.appendChild(hdr);

    var desc = document.createElement('div');
    desc.className = 'scan-desc';
    desc.textContent = scan.desc;
    card.appendChild(desc);

    if (scan.schedule) {
      var sched = scan.schedule;
      var schedRow = document.createElement('div');
      schedRow.className = 'scan-sched';

      var modeBadge = document.createElement('span');
      modeBadge.className = 'scan-sched-mode scan-sched-mode--' + sched.mode;
      modeBadge.textContent = sched.mode === 'bg' ? 'bg daemon' : sched.mode === 'sse' ? 'sse push' : 'manual';
      schedRow.appendChild(modeBadge);

      if (sched.every) {
        var everyEl = document.createElement('span');
        everyEl.className = 'scan-sched-every';
        everyEl.textContent = 'every ' + sched.every;
        schedRow.appendChild(everyEl);
      }

      var byEl = document.createElement('span');
      byEl.className = 'scan-sched-by';
      byEl.textContent = sched.by;
      schedRow.appendChild(byEl);

      card.appendChild(schedRow);
    }

    var statusRow = document.createElement('div');
    statusRow.className = 'scan-status-row';

    var lastRunEl = document.createElement('span');
    lastRunEl.className = 'scan-last-run';
    lastRunEl.textContent = 'never';

    var elapsedEl = document.createElement('span');
    elapsedEl.className = 'scan-elapsed';

    var summaryEl = document.createElement('span');
    summaryEl.className = 'scan-summary';

    statusRow.appendChild(lastRunEl);
    statusRow.appendChild(elapsedEl);
    statusRow.appendChild(summaryEl);
    card.appendChild(statusRow);

    var logWrap = document.createElement('div');
    logWrap.className = 'scan-log-wrap';

    var logToggle = document.createElement('button');
    logToggle.className = 'scan-log-toggle';
    logToggle.dataset.action = 'toggle-log';
    logToggle.dataset.scan = scan.id;
    logToggle.textContent = 'details \u25be';

    var logBody = document.createElement('div');
    logBody.className = 'scan-log-body scan-log-body--hidden';

    var notYet = document.createElement('div');
    notYet.className = 'panel-empty';
    notYet.textContent = 'Not yet run';
    logBody.appendChild(notYet);

    logWrap.appendChild(logToggle);
    logWrap.appendChild(logBody);
    card.appendChild(logWrap);

    return card;
  }

  // ── Update card from state ──
  function _updateCard(scan) {
    var s = _state[scan.id];
    var card = document.querySelector('.scan-card[data-id="' + scan.id + '"]');
    if (!card) return;

    card.querySelector('.scan-dot').className = 'scan-dot scan-dot--' + s.status;

    var btn = card.querySelector('.scan-run-btn');
    btn.textContent = s.status === 'running' ? '\u2026' : 'Run';
    btn.disabled = s.status === 'running';

    card.querySelector('.scan-last-run').textContent = _fmtTime(s.lastRun);

    var elapsedEl = card.querySelector('.scan-elapsed');
    if (s.status === 'running' && s._start) {
      elapsedEl.textContent = _fmtElapsed(Date.now() - s._start);
    } else if (s.duration != null) {
      elapsedEl.textContent = _fmtElapsed(s.duration);
    } else {
      elapsedEl.textContent = '';
    }

    card.querySelector('.scan-summary').textContent = s.summary;

    var logBody = card.querySelector('.scan-log-body');
    logBody.classList.toggle('scan-log-body--hidden', !s.expanded);
    logBody.textContent = '';
    if (s.log.length === 0 && !s.lastRun) {
      var notYet = document.createElement('div');
      notYet.className = 'panel-empty';
      notYet.textContent = 'Not yet run';
      logBody.appendChild(notYet);
    } else {
      s.log.forEach(function(line) {
        var lineEl = document.createElement('div');
        lineEl.className = line.indexOf('\u2500\u2500') === 0 ? 'scan-log-head' : 'scan-log-line';
        lineEl.textContent = line;
        logBody.appendChild(lineEl);
      });
    }

    var logToggle = card.querySelector('.scan-log-toggle');
    logToggle.textContent = s.expanded ? 'details \u25b4' : 'details \u25be';
  }

  // ── Run a single scan ──
  function _runScan(scan) {
    var s = _state[scan.id];
    if (s.status === 'running') return;

    s.status = 'running';
    s._start = Date.now();
    s.summary = '';
    s.log = [];
    _updateCard(scan);

    s._timer = setInterval(function() { _updateCard(scan); }, 150);

    scan.fetch().then(function(data) {
      clearInterval(s._timer);
      s.duration = Date.now() - s._start;
      s.lastRun = Date.now();
      s.status = 'ok';
      s.summary = scan.format(data);
      s.log = scan.logDetail(data);
      _updateCard(scan);
      setTimeout(function() {
        if (_state[scan.id].status === 'ok') { _state[scan.id].status = 'idle'; _updateCard(scan); }
      }, 12000);
    }).catch(function(err) {
      clearInterval(s._timer);
      s.duration = Date.now() - s._start;
      s.lastRun = Date.now();
      s.status = 'error';
      s.summary = String(err).slice(0, 80);
      s.log = ['\u2500\u2500 Error \u2500\u2500', String(err)];
      _updateCard(scan);
      setTimeout(function() {
        if (_state[scan.id].status === 'error') { _state[scan.id].status = 'idle'; _updateCard(scan); }
      }, 20000);
    });
  }

  // ── Run all scans concurrently ──
  function _runAll() {
    SCANS.forEach(function(s) { _runScan(s); });
  }

  // ── Init ──
  var body = document.getElementById('scanner-body');
  if (!body) return;

  SCANS.forEach(function(scan) { body.appendChild(_makeCard(scan)); });

  var runAllBtn = document.getElementById('scanner-run-all');
  if (runAllBtn) runAllBtn.addEventListener('click', _runAll);

  body.addEventListener('click', function(e) {
    var action = e.target.dataset ? e.target.dataset.action : null;
    if (!action) return;
    var scanId = e.target.dataset.scan;
    var scan = null;
    for (var i = 0; i < SCANS.length; i++) { if (SCANS[i].id === scanId) { scan = SCANS[i]; break; } }
    if (!scan) return;
    if (action === 'run') _runScan(scan);
    else if (action === 'toggle-log') { _state[scanId].expanded = !_state[scanId].expanded; _updateCard(scan); }
  });

  setInterval(function() {
    if (document.hidden) return;
    SCANS.forEach(function(scan) { if (_state[scan.id].status !== 'running') _updateCard(scan); });
  }, 30000);

  // ── Discovery Scans Section ──

  var discSection = document.createElement('div');
  discSection.className = 'scan-discovery-section';

  var discHdr = document.createElement('div');
  discHdr.className = 'scan-discovery-hdr';

  var discIcon = document.createElement('span');
  discIcon.className = 'scan-icon';
  discIcon.textContent = '\ud83d\udd2d';
  discHdr.appendChild(discIcon);

  var discTitle = document.createElement('span');
  discTitle.className = 'scan-discovery-title';
  discTitle.textContent = 'Realm Discovery';
  discHdr.appendChild(discTitle);

  var discRunAll = document.createElement('button');
  discRunAll.className = 'scan-run-btn scan-discovery-run-all';
  discRunAll.dataset.action = 'disc-run';
  discRunAll.dataset.provider = 'all';
  discRunAll.textContent = 'Scan All';
  discHdr.appendChild(discRunAll);

  discSection.appendChild(discHdr);

  var discStatusEl = document.createElement('div');
  discStatusEl.className = 'scan-discovery-status';
  discSection.appendChild(discStatusEl);

  var discProvidersEl = document.createElement('div');
  discProvidersEl.className = 'scan-discovery-providers';
  discSection.appendChild(discProvidersEl);

  body.appendChild(discSection);

  function _loadDiscoveryProviders() {
    window.fetch('/discovery/providers').then(function(r) { return r.json(); }).then(function(providers) {
      discProvidersEl.textContent = '';
      providers.forEach(function(p) {
        var btn = document.createElement('button');
        btn.className = 'scan-run-btn scan-btn-sm';
        btn.dataset.action = 'disc-run';
        btn.dataset.provider = p.name;
        btn.textContent = p.name + ' (' + p.entity_types.join(', ') + ')';
        discProvidersEl.appendChild(btn);
      });
    }).catch(function() {});
  }

  function _updateDiscoveryStatus() {
    window.fetch('/discovery').then(function(r) { return r.json(); }).then(function(data) {
      var s = data.summary;
      discStatusEl.textContent = '';
      var stats = [
        { text: s.total + ' entities', cls: '' },
        { text: s.running + ' running', cls: 'scan-disc-ok' },
        { text: s.stopped + ' stopped', cls: 'scan-disc-warn' },
        { text: s.failed + ' failed', cls: 'scan-disc-crit' }
      ];
      stats.forEach(function(st) {
        var span = document.createElement('span');
        span.className = 'scan-disc-stat' + (st.cls ? ' ' + st.cls : '');
        span.textContent = st.text;
        discStatusEl.appendChild(span);
      });
    }).catch(function() {});
  }

  function _triggerDiscoveryScan(provider, btn) {
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Scanning\u2026';
    window.fetch('/discovery/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider }),
    }).then(function() {
      btn.textContent = '\u2713 Triggered';
      setTimeout(function() { btn.disabled = false; btn.textContent = origText; }, 4000);
      setTimeout(_updateDiscoveryStatus, 5000);
      setTimeout(_updateDiscoveryStatus, 15000);
    }).catch(function() {
      btn.textContent = 'Error';
      setTimeout(function() { btn.disabled = false; btn.textContent = origText; }, 4000);
    });
  }

  discSection.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action="disc-run"]');
    if (!btn || btn.disabled) return;
    _triggerDiscoveryScan(btn.dataset.provider, btn);
  });

  _loadDiscoveryProviders();
  _updateDiscoveryStatus();

  setInterval(function() {
    if (document.hidden) return;
    _updateDiscoveryStatus();
  }, 30000);
})();
