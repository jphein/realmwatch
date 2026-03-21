// ── Survey Glass — manual scan runner panel ────────────────────────────────
'use strict';

// Escape helper for any API-sourced string inserted into DOM text
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Scan definitions ────────────────────────────────────────────────────────
const SCANS = [
  {
    id: 'wifi',
    icon: '📡',
    name: 'Aetheric Survey',
    techName: 'GET /scan — WiFi AP Scan',
    schedule: { mode: 'bg', every: '90s', by: 'ap_scanner._scanner_loop()' },
    desc: 'Polls all access points via SSH for WiFi client MACs, signal strength, ' +
          'roaming state and DHCP identity. Auto-creates unknown nodes for new devices.',
    fetch: () => fetch('/scan').then(r => r.json()),
    format: d => {
      const c = d.clients ?? d.total_clients;
      const n = d.nodes_added ?? 0;
      return (c != null ? `${c} clients` : 'complete') + (n ? ` · ${n} new nodes` : '');
    },
    logDetail: d => {
      const lines = [];
      if (d.aps) { lines.push('── Access Points ──'); Object.entries(d.aps).forEach(([k, v]) => lines.push(`  ${k}: ${v.clients ?? 0} clients`)); }
      if (d.summary) lines.push('── Summary ──', ...String(d.summary).split('\n').filter(Boolean));
      return lines;
    },
  },
  {
    id: 'lldp',
    icon: '🔗',
    name: 'Ether Weave',
    techName: 'GET /scan/lldp — LLDP/CDP Topology',
    schedule: { mode: 'bg', every: '~10m', by: 'every 7th WiFi scan (7×90s)' },
    desc: 'Queries all managed switches and APs for LLDP/CDP neighbor tables. ' +
          'Detects unmanaged switch cliques via the Bron–Kerbosch algorithm.',
    fetch: () => fetch('/scan/lldp').then(r => r.json()),
    format: d => `${d.links ?? 0} links · ${d.switches ?? 0} unmanaged switches`,
    logDetail: d => {
      const lines = [];
      if (Array.isArray(d.connections)) {
        lines.push('── Connections ──');
        d.connections.slice(0, 20).forEach(c => lines.push(`  ${c.from} → ${c.to} (${c.type ?? 'infra'})`));
        if (d.connections.length > 20) lines.push(`  … and ${d.connections.length - 20} more`);
      }
      if (d.cliques?.length) {
        lines.push('── Detected Cliques ──');
        d.cliques.forEach(cl => lines.push(`  ${Array.isArray(cl) ? cl.join(', ') : cl}`));
      }
      return lines;
    },
  },
  {
    id: 'towers',
    icon: '🗼',
    name: 'Tower Census',
    techName: 'GET /scan/wifi — AP Radio Discovery',
    schedule: { mode: 'sse', every: '120s', by: 'SSE broker tick%24 · cache TTL 120s' },
    desc: 'Enumerates all access point radios, BSSIDs, SSIDs, channels and band ' +
          'assignments from OpenWrt UCI config via SSH.',
    fetch: () => fetch('/scan/wifi').then(r => r.json()),
    format: d => {
      const aps = Array.isArray(d) ? d : Object.values(d ?? {});
      return `${aps.length} towers`;
    },
    logDetail: d => {
      const aps = Array.isArray(d) ? d : Object.entries(d ?? {}).map(([k, v]) => ({ id: k, ...v }));
      const lines = ['── Access Points ──'];
      aps.slice(0, 15).forEach(ap => lines.push(`  ${ap.label ?? ap.id ?? ap.name ?? '?'}: ${ap.ip ?? ''}`));
      if (aps.length > 15) lines.push(`  … and ${aps.length - 15} more`);
      return lines;
    },
  },
  {
    id: 'firewall',
    icon: '🛡️',
    name: 'Ward Inspection',
    techName: 'GET /firewall — nftables Ruleset',
    schedule: { mode: 'sse', every: '60s', by: 'SSE broker tick%12 · cache TTL 30s' },
    desc: 'Parses fw4 nftables JSON from gatekeeper via SSH hop. Maps zone→VLAN ' +
          'rules, active chains, blocked IPs and connection tracking stats.',
    fetch: () => fetch('/firewall').then(r => r.json()),
    format: d => {
      const zones = Object.keys(d.zones ?? {}).length;
      const rules = d.rules?.length ?? d.chain_count ?? '?';
      return `${zones} zones · ${rules} rules`;
    },
    logDetail: d => {
      const lines = [];
      if (d.zones) {
        lines.push('── Zones ──');
        Object.entries(d.zones).forEach(([z, info]) => {
          lines.push(`  ${z}: VLAN ${info.vlan ?? '?'} — ${info.subnet ?? ''}`);
        });
      }
      if (d.traffic_top?.length) {
        lines.push('── Top Traffic ──');
        d.traffic_top.slice(0, 8).forEach(t => lines.push(`  ${t.src ?? t.label}: ${t.bytes_str ?? ''}`));
      }
      return lines;
    },
  },
  {
    id: 'collectd',
    icon: '📊',
    name: 'Flux Reading',
    techName: 'GET /collectd — RRD Metrics',
    schedule: { mode: 'sse', every: '10s', by: 'SSE broker tick%2 · live RRD reads' },
    desc: 'Reads RRD files from /var/lib/collectd for all monitored hosts. ' +
          'Returns traffic rates, ping latency, packet drop and stddev.',
    fetch: () => fetch('/collectd').then(r => r.json()),
    format: d => {
      const hosts = Object.keys(d?.hosts ?? d ?? {}).length;
      return `${hosts} hosts`;
    },
    logDetail: d => {
      const hosts = Object.keys(d?.hosts ?? d ?? {});
      const lines = ['── Hosts ──'];
      hosts.slice(0, 15).forEach(h => lines.push(`  ${h}`));
      if (hosts.length > 15) lines.push(`  … and ${hosts.length - 15} more`);
      return lines;
    },
  },
  {
    id: 'observation',
    icon: '🔮',
    name: 'Oracle Gaze',
    techName: 'GET /observation — AI Narration',
    schedule: { mode: 'manual', every: null, by: 'oracle_daemon polls 10s for oracle_query events' },
    desc: 'Triggers the AI oracle to observe current system state and generate a ' +
          'narrated report. Calls Azure AI and posts a voice event to the map.',
    fetch: () => fetch('/observation').then(r => r.json()),
    format: d => {
      const msg = d.message ?? d.text ?? '';
      return msg ? msg.slice(0, 72) + (msg.length > 72 ? '…' : '') : 'observation complete';
    },
    logDetail: d => {
      const msg = d.message ?? d.text ?? '';
      if (!msg) return [];
      return ['── Oracle Message ──', ...msg.split('. ').filter(Boolean).map(s => '  ' + s.trim())];
    },
  },
];

// ── Per-scan state ──────────────────────────────────────────────────────────
const _state = {};
SCANS.forEach(s => {
  _state[s.id] = { status: 'idle', lastRun: null, duration: null, summary: '', log: [], expanded: false, _start: null, _timer: null };
});

// ── Formatters ─────────────────────────────────────────────────────────────
function _fmtElapsed(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function _fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Build static card DOM (no dynamic data) ─────────────────────────────────
function _makeCard(scan) {
  const card = document.createElement('div');
  card.className = 'scan-card';
  card.dataset.id = scan.id;

  // Header: icon + titles + status dot + run button
  const hdr = document.createElement('div');
  hdr.className = 'scan-card-hdr';

  const iconEl = document.createElement('span');
  iconEl.className = 'scan-icon';
  iconEl.textContent = scan.icon;

  const titles = document.createElement('div');
  titles.className = 'scan-titles';

  const nameEl = document.createElement('div');
  nameEl.className = 'scan-name';
  nameEl.textContent = scan.name;

  const techEl = document.createElement('div');
  techEl.className = 'scan-tech';
  techEl.textContent = scan.techName;

  titles.appendChild(nameEl);
  titles.appendChild(techEl);

  const dot = document.createElement('span');
  dot.className = 'scan-dot scan-dot--idle';

  const btn = document.createElement('button');
  btn.className = 'scan-run-btn';
  btn.dataset.action = 'run';
  btn.dataset.scan = scan.id;
  btn.textContent = 'Run';

  hdr.appendChild(iconEl);
  hdr.appendChild(titles);
  hdr.appendChild(dot);
  hdr.appendChild(btn);
  card.appendChild(hdr);

  // Description
  const desc = document.createElement('div');
  desc.className = 'scan-desc';
  desc.textContent = scan.desc;
  card.appendChild(desc);

  // Schedule row
  if (scan.schedule) {
    const sched = scan.schedule;
    const schedRow = document.createElement('div');
    schedRow.className = 'scan-sched';

    const modeBadge = document.createElement('span');
    modeBadge.className = `scan-sched-mode scan-sched-mode--${sched.mode}`;
    modeBadge.textContent = sched.mode === 'bg' ? 'bg daemon' : sched.mode === 'sse' ? 'sse push' : 'manual';
    schedRow.appendChild(modeBadge);

    if (sched.every) {
      const everyEl = document.createElement('span');
      everyEl.className = 'scan-sched-every';
      everyEl.textContent = `every ${sched.every}`;
      schedRow.appendChild(everyEl);
    }

    const byEl = document.createElement('span');
    byEl.className = 'scan-sched-by';
    byEl.textContent = sched.by;
    schedRow.appendChild(byEl);

    card.appendChild(schedRow);
  }

  // Status row: last-run · elapsed · summary
  const statusRow = document.createElement('div');
  statusRow.className = 'scan-status-row';

  const lastRunEl = document.createElement('span');
  lastRunEl.className = 'scan-last-run';
  lastRunEl.textContent = 'never';

  const elapsedEl = document.createElement('span');
  elapsedEl.className = 'scan-elapsed';

  const summaryEl = document.createElement('span');
  summaryEl.className = 'scan-summary';

  statusRow.appendChild(lastRunEl);
  statusRow.appendChild(elapsedEl);
  statusRow.appendChild(summaryEl);
  card.appendChild(statusRow);

  // Log section
  const logWrap = document.createElement('div');
  logWrap.className = 'scan-log-wrap';

  const logToggle = document.createElement('button');
  logToggle.className = 'scan-log-toggle';
  logToggle.dataset.action = 'toggle-log';
  logToggle.dataset.scan = scan.id;
  logToggle.textContent = 'details ▾';

  const logBody = document.createElement('div');
  logBody.className = 'scan-log-body scan-log-body--hidden';

  const notYet = document.createElement('div');
  notYet.className = 'panel-empty';
  notYet.textContent = 'Not yet run';
  logBody.appendChild(notYet);

  logWrap.appendChild(logToggle);
  logWrap.appendChild(logBody);
  card.appendChild(logWrap);

  return card;
}

// ── Update card from state (all dynamic data via textContent) ───────────────
function _updateCard(scan) {
  const s = _state[scan.id];
  const card = document.querySelector(`.scan-card[data-id="${scan.id}"]`);
  if (!card) return;

  card.querySelector('.scan-dot').className = `scan-dot scan-dot--${s.status}`;

  const btn = card.querySelector('.scan-run-btn');
  btn.textContent = s.status === 'running' ? '…' : 'Run';
  btn.disabled = s.status === 'running';

  card.querySelector('.scan-last-run').textContent = _fmtTime(s.lastRun);

  const elapsedEl = card.querySelector('.scan-elapsed');
  if (s.status === 'running' && s._start) {
    elapsedEl.textContent = _fmtElapsed(Date.now() - s._start);
  } else if (s.duration != null) {
    elapsedEl.textContent = _fmtElapsed(s.duration);
  } else {
    elapsedEl.textContent = '';
  }

  card.querySelector('.scan-summary').textContent = s.summary;

  const logBody = card.querySelector('.scan-log-body');
  logBody.classList.toggle('scan-log-body--hidden', !s.expanded);
  // Rebuild log lines using textContent — no innerHTML with untrusted data
  logBody.textContent = '';
  if (s.log.length === 0 && !s.lastRun) {
    const notYet = document.createElement('div');
    notYet.className = 'panel-empty';
    notYet.textContent = 'Not yet run';
    logBody.appendChild(notYet);
  } else {
    s.log.forEach(line => {
      const lineEl = document.createElement('div');
      lineEl.className = line.startsWith('──') ? 'scan-log-head' : 'scan-log-line';
      lineEl.textContent = line;
      logBody.appendChild(lineEl);
    });
  }

  const logToggle = card.querySelector('.scan-log-toggle');
  logToggle.textContent = s.expanded ? 'details ▴' : 'details ▾';
}

// ── Run a single scan ───────────────────────────────────────────────────────
async function _runScan(scan) {
  const s = _state[scan.id];
  if (s.status === 'running') return;

  s.status = 'running';
  s._start = Date.now();
  s.summary = '';
  s.log = [];
  _updateCard(scan);

  // Live elapsed ticker at 150ms
  s._timer = setInterval(() => _updateCard(scan), 150);

  try {
    const data = await scan.fetch();
    clearInterval(s._timer);
    s.duration = Date.now() - s._start;
    s.lastRun = Date.now();
    s.status = 'ok';
    s.summary = scan.format(data);
    s.log = scan.logDetail(data);
    _updateCard(scan);
    // Fade status dot back to idle after 12s
    setTimeout(() => {
      if (_state[scan.id].status === 'ok') { _state[scan.id].status = 'idle'; _updateCard(scan); }
    }, 12000);
  } catch (err) {
    clearInterval(s._timer);
    s.duration = Date.now() - s._start;
    s.lastRun = Date.now();
    s.status = 'error';
    s.summary = String(err).slice(0, 80);
    s.log = ['── Error ──', String(err)];
    _updateCard(scan);
    setTimeout(() => {
      if (_state[scan.id].status === 'error') { _state[scan.id].status = 'idle'; _updateCard(scan); }
    }, 20000);
  }
}

// ── Run all scans concurrently ──────────────────────────────────────────────
function _runAll() {
  Promise.allSettled(SCANS.map(s => _runScan(s)));
}

// ── Init (called from app.js) ───────────────────────────────────────────────
export function initScanner() {
  const body = document.getElementById('scanner-body');
  if (!body) return;

  SCANS.forEach(scan => body.appendChild(_makeCard(scan)));

  const runAllBtn = document.getElementById('scanner-run-all');
  if (runAllBtn) runAllBtn.addEventListener('click', _runAll);

  // Event delegation for run + toggle-log buttons
  body.addEventListener('click', e => {
    const action = e.target.dataset?.action;
    if (!action) return;
    const scanId = e.target.dataset.scan;
    const scan = SCANS.find(s => s.id === scanId);
    if (!scan) return;
    if (action === 'run') _runScan(scan);
    else if (action === 'toggle-log') { _state[scanId].expanded = !_state[scanId].expanded; _updateCard(scan); }
  });

  // 30s tick to keep "last run" timestamps fresh
  setInterval(() => {
    if (document.hidden) return;  // skip DOM updates when tab is hidden
    SCANS.forEach(scan => { if (_state[scan.id].status !== 'running') _updateCard(scan); });
  }, 30000);
}
