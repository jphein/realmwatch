'use strict';
// ── Debug panel, arcane config, herald controls, grimoire, scrying terminal ──
import { _topology } from './topology.js';
import { registerPanel } from './panel-manager.js';
import { getLastStatus } from './node-status.js';
import { getLastEventTs } from './quest-log.js';
import { makeDraggable, makeResizable } from './layout.js';
import { getSseConnected } from './app.js';

let _dbgRefreshTimer = null;

export function scheduleDebugRefresh() {
  clearTimeout(_dbgRefreshTimer);
  _dbgRefreshTimer = setTimeout(_dbgRefresh, 200);
}

// ── Arcane Config (external service settings) ──
const _cfgFields = {
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
  const parts = path.split('.');
  let v = obj;
  for (const p of parts) { v = v?.[p]; }
  return v;
}

async function loadArcaneConfig() {
  try {
    const r = await fetch('/config');
    if (!r.ok) return;
    const cfg = await r.json();
    for (const [id, spec] of Object.entries(_cfgFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const val = _getPath(cfg, spec.path);
      if (val == null) continue;
      if (spec.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    }
  } catch (e) { /* config endpoint may not be available yet */ }
}

function _saveArcaneConfig() {
  const update = { chat: {}, speech: {}, oracle: {} };
  for (const [id, spec] of Object.entries(_cfgFields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const [section, key] = spec.path.split('.');
    let val;
    if (spec.type === 'checkbox') val = el.checked;
    else if (spec.type === 'number') val = parseFloat(el.value);
    else val = el.value;
    update[section][key] = val;
    if (spec.also) {
      const [s2, k2] = spec.also.split('.');
      update[s2][k2] = val;
    }
  }
  const statusEl = document.getElementById('cfg-status');
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }).then(r => {
    if (statusEl) {
      statusEl.textContent = r.ok ? 'Config saved \u2714' : 'Save failed';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  }).catch(() => {
    if (statusEl) statusEl.textContent = 'Save failed';
  });
}

const _cfgSaveBtn = document.getElementById('cfg-save-btn');
if (_cfgSaveBtn) _cfgSaveBtn.addEventListener('click', _saveArcaneConfig);
loadArcaneConfig();

// ── Herald Controls ──
const _heraldStatus = document.getElementById('herald-status');
function _heraldAction(action) {
  const interval = document.getElementById('cfg-herald-interval')?.value || 90;
  const url = `/herald?action=${action}&interval=${interval}`;
  if (_heraldStatus) _heraldStatus.textContent = `${action}...`;
  fetch(url).then(r => r.json()).then(d => {
    if (_heraldStatus) {
      if (d.error) _heraldStatus.textContent = d.error;
      else if (d.pid) _heraldStatus.textContent = `Running (PID ${d.pid}, ${d.interval}s)`;
      else if (d.stopped) _heraldStatus.textContent = 'Stopped';
      else if (d.output) _heraldStatus.textContent = 'Round complete';
      else if (d.running) _heraldStatus.textContent = `Running (PIDs: ${d.pids.join(',')})`;
      else _heraldStatus.textContent = 'Not running';
    }
  }).catch(() => { if (_heraldStatus) _heraldStatus.textContent = 'Error'; });
}
document.getElementById('herald-start-btn')?.addEventListener('click', () => _heraldAction('start'));
document.getElementById('herald-stop-btn')?.addEventListener('click', () => _heraldAction('stop'));
document.getElementById('herald-once-btn')?.addEventListener('click', () => _heraldAction('once'));
// Check herald status on load
_heraldAction('status');

// ── Arcane Mirror (Debug Panel) ──
const _dbgPanel = document.getElementById('debug-panel');
const _dbgBody = document.getElementById('debug-body');
const _dbgSearch = document.getElementById('debug-search');
const _dbgSseStatus = document.getElementById('debug-poll-count');
let _dbgTab = 'all';
let _dbgDbInfo = null;

// Close button
document.getElementById('debug-close')?.addEventListener('click', () => {
  const cb = document.getElementById('vis-debug');
  if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
});

// Tab switching
document.querySelectorAll('.debug-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    _dbgTab = tab.dataset.dtab;
    _dbgRefresh();
  });
});

// Filter
_dbgSearch?.addEventListener('input', () => _dbgRefresh());

// Drag header to reposition (mouse + touch)
{
  const hdr = document.getElementById('debug-header');
  let offX = 0, offY = 0, dragging = false;
  function startDrag(cx, cy) {
    const r = _dbgPanel.getBoundingClientRect();
    offX = cx - r.left; offY = cy - r.top;
    dragging = true;
  }
  function moveDrag(cx, cy) {
    if (!dragging) return;
    _dbgPanel.style.left = (cx - offX) + 'px';
    _dbgPanel.style.top = (cy - offY) + 'px';
    _dbgPanel.style.bottom = 'auto';
    _dbgPanel.style.right = 'auto';
  }
  function endDrag() { dragging = false; }
  hdr?.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault(); startDrag(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  document.addEventListener('mouseup', endDrag);
  hdr?.addEventListener('touchstart', e => {
    if (e.target.tagName === 'BUTTON' || e.touches.length !== 1) return;
    e.preventDefault(); startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (dragging && e.touches.length) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchend', endDrag);
}

function _dbgSection(title, id, content, collapsed = false) {
  return `<div class="dbg-section${collapsed ? ' collapsed' : ''}" data-dbg="${id}">
    <div class="dbg-section-title">${title}</div>
    <div class="dbg-section-body">${content}</div></div>`;
}

function _dbgKV(k, v, cls = '') {
  const vc = typeof v === 'number' ? (v === 0 ? 'dim' : '') : cls;
  return `<div class="dbg-kv"><span class="dbg-k">${k}</span><span class="dbg-v ${vc}">${_escH(String(v))}</span></div>`;
}

function _escH(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _dbgTree(obj, depth = 0, filter = '') {
  if (obj === null || obj === undefined) return '<span class="dbg-v dim">null</span>';
  if (typeof obj !== 'object') return `<span class="dbg-v">${_escH(String(obj))}</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '<span class="dbg-v dim">[]</span>';
    if (depth > 2) return `<span class="dbg-v dim">[${obj.length} items]</span>`;
    return obj.slice(0, 20).map((v, i) =>
      `<div class="dbg-kv"><span class="dbg-k">[${i}]</span>${_dbgTree(v, depth+1, filter)}</div>`
    ).join('') + (obj.length > 20 ? `<div class="dbg-v dim">...+${obj.length - 20} more</div>` : '');
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return '<span class="dbg-v dim">{}</span>';
  const filtered = filter
    ? entries.filter(([k, v]) => {
        const s = k + ' ' + JSON.stringify(v);
        return s.toLowerCase().includes(filter);
      })
    : entries;
  if (depth > 2) return `<span class="dbg-v dim">{${filtered.length} keys}</span>`;
  return `<div class="dbg-tree">${filtered.map(([k, v]) =>
    `<div class="dbg-kv"><span class="dbg-k">${_escH(k)}</span>${_dbgTree(v, depth+1, filter)}</div>`
  ).join('')}</div>`;
}

function _dbgRefresh() {
  if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
  const d = getLastStatus();
  const filter = (_dbgSearch?.value || '').toLowerCase().trim();
  const tab = _dbgTab;
  const _sseConnected = getSseConnected();
  let html = '';

  if (_dbgSseStatus) _dbgSseStatus.textContent = _sseConnected ? 'sse:live' : 'sse:off';

  // Status overview
  if (tab === 'all' || tab === 'status') {
    const s = d ? {
      realm_scale: d.realm_scale, forge_cpu: d.forge?.usage, mana_mem: d.mana?.usage,
      gpu: d.gpu?.usage, uptime: d.adult?.uptime, load: d.adult?.load1,
      host: d.host?.hostname, sse: _sseConnected ? 'live' : 'off',
    } : { status: 'no data yet' };
    html += _dbgSection('Status', 'status', _dbgTree(s, 0, filter));
  }

  // Collectd
  if ((tab === 'all' || tab === 'collectd') && d?.collectd) {
    const hosts = Object.keys(d.collectd).length;
    let body = _dbgKV('hosts', hosts);
    body += _dbgTree(d.collectd, 0, filter);
    html += _dbgSection(`Collectd (${hosts} hosts)`, 'collectd', body, tab === 'all');
  }

  // WiFi
  if ((tab === 'all' || tab === 'wifi') && d?.wifi) {
    const clients = Object.keys(d.wifi).length;
    let body = _dbgKV('clients', clients);
    body += _dbgTree(d.wifi, 0, filter);
    html += _dbgSection(`WiFi (${clients} clients)`, 'wifi', body, tab === 'all');
  }

  // HA
  if ((tab === 'all' || tab === 'ha') && d?.ha) {
    const ents = Object.keys(d.ha).length;
    let body = _dbgKV('entities', ents);
    body += _dbgTree(d.ha, 0, filter);
    html += _dbgSection(`Home Assistant (${ents})`, 'ha', body, tab === 'all');
  }

  // Tailscale
  if ((tab === 'all' || tab === 'tailscale') && d?.tailscale) {
    const ts = d.tailscale;
    let body = _dbgKV('online', ts.online?.length || 0, 'ok');
    body += _dbgKV('offline', ts.offline?.length || 0, ts.offline?.length ? 'warn' : '');
    body += _dbgTree(ts, 0, filter);
    html += _dbgSection('Tailscale', 'tailscale', body, tab === 'all');
  }

  // Topology
  if (tab === 'all' || tab === 'topology') {
    const t = _topology || {};
    let body = _dbgKV('nodes', t.nodes?.length || 0);
    body += _dbgKV('connections', t.connections?.length || 0);
    body += _dbgKV('regions', t.regions?.length || 0);
    if (tab === 'topology') {
      // Show node types breakdown
      const types = {};
      (t.nodes || []).forEach(n => { types[n.type || 'unknown'] = (types[n.type || 'unknown'] || 0) + 1; });
      body += _dbgKV('types', JSON.stringify(types));
      // Show online/offline
      if (d?.tailscale) {
        const online = new Set([...(d.tailscale.online || [])]);
        const onlineNodes = (t.nodes || []).filter(n => n.online !== false).length;
        body += _dbgKV('online nodes', onlineNodes, 'ok');
      }
      body += _dbgTree(t, 0, filter);
    }
    html += _dbgSection('Topology', 'topology', body, tab === 'all');
  }

  // Events
  if (tab === 'all' || tab === 'events') {
    const logBody = document.getElementById('quest-log-body');
    const count = logBody ? logBody.children.length : 0;
    let body = _dbgKV('log entries', count);
    body += _dbgKV('last event ts', getLastEventTs() ? new Date(getLastEventTs() * 1000).toLocaleTimeString() : 'none');
    body += _dbgKV('delivery', 'SSE (real-time)');
    html += _dbgSection(`Events (${count})`, 'events', body);
  }

  // DB / Settings
  if (tab === 'all' || tab === 'db') {
    let body = '';
    if (_dbgDbInfo) {
      body += _dbgKV('db size', (_dbgDbInfo.db_size / 1024).toFixed(0) + ' KB');
      body += _dbgKV('notion synced', _dbgDbInfo.notion_synced);
      body += _dbgKV('wifi scan', _dbgDbInfo.wifi_scan_ts ? new Date(_dbgDbInfo.wifi_scan_ts * 1000).toLocaleTimeString() : 'none');
      body += _dbgKV('namespaces', (_dbgDbInfo.settings_ns || []).join(', '));
      if (_dbgDbInfo.tables) body += _dbgTree(_dbgDbInfo.tables, 0, filter);
    } else {
      body += _dbgKV('loading...', '');
    }
    const ls = localStorage.getItem('realm-map-settings');
    if (ls) {
      try {
        const s = JSON.parse(ls);
        body += _dbgKV('local sliders', Object.keys(s.sliders || {}).length);
        body += _dbgKV('local cbs', Object.keys(s.checkboxes || {}).length);
        if (tab === 'db') body += _dbgTree(s, 0, filter);
      } catch (e) { body += _dbgKV('localStorage', 'parse error', 'err'); }
    }
    html += _dbgSection('DB / Settings', 'db', body, tab === 'all');
  }

  _dbgBody.innerHTML = html;

  // Collapse toggle for sections
  _dbgBody.querySelectorAll('.dbg-section-title').forEach(el => {
    el.addEventListener('click', () => {
      el.parentElement.classList.toggle('collapsed');
    });
  });

  // Highlight filter matches
  if (filter) {
    const re = new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    _dbgBody.querySelectorAll('.dbg-v, .dbg-k').forEach(el => {
      if (el.querySelector('*')) return; // skip containers
      const t = el.textContent;
      if (re.test(t)) {
        el.innerHTML = t.replace(re, '<span class="dbg-highlight">$1</span>');
      }
    });
  }
}

// Fetch DB stats periodically when visible
function _dbgFetchDb() {
  if (!_dbgPanel || _dbgPanel.style.display === 'none') return;
  fetch('/debug').then(r => r.json()).then(d => { _dbgDbInfo = d; }).catch(() => {});
}

// Auto-refresh when panel becomes visible
new MutationObserver(() => {
  if (_dbgPanel && _dbgPanel.style.display !== 'none') { _dbgFetchDb(); _dbgRefresh(); }
}).observe(_dbgPanel, { attributes: true, attributeFilter: ['style'] });
// Refresh DB stats every 30s while visible (only when panel is shown)
setInterval(() => {
  if (_dbgPanel && _dbgPanel.style.display !== 'none') _dbgFetchDb();
}, 30000);

// ═══════════════════════════════════════════════════════════
// ARCANE GRIMOIRE — spell catalogue of endpoints, tools, scripts
// ═══════════════════════════════════════════════════════════

const _agPanel = document.getElementById('arcane-grimoire');
if (_agPanel) {
  registerPanel(_agPanel);
  makeDraggable(_agPanel, '.panel-header', [240,200,100]);
  makeResizable(_agPanel, [240,200,100]);

  const _acEndpoints = [
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
    let html = '';
    for (const p of params) {
      if (p.type === 'textarea') {
        html += `<label>${p.name}</label><textarea data-param="${p.name}" placeholder="${p.placeholder || ''}"></textarea>`;
      } else if (p.type === 'select') {
        html += `<label>${p.name}</label><select data-param="${p.name}">${(p.options||[]).map(o => `<option value="${o}">${o}</option>`).join('')}</select>`;
      } else if (p.type === 'checkbox') {
        html += `<label><input type="checkbox" data-param="${p.name}"> ${p.label || p.name}</label>`;
      } else {
        html += `<label>${p.name}</label><input type="text" data-param="${p.name}" placeholder="${p.placeholder || ''}">`;
      }
    }
    return html;
  }

  function _acCollectParams(formEl) {
    const params = {};
    formEl.querySelectorAll('[data-param]').forEach(el => {
      const name = el.dataset.param;
      if (el.type === 'checkbox') { if (el.checked) params[name] = true; }
      else if (el.value.trim()) params[name] = el.value.trim();
    });
    return params;
  }

  // Render API endpoints
  const apiContainer = document.getElementById('ac-api');
  let apiHtml = '';
  for (const ep of _acEndpoints) {
    const mcls = 'ac-method ac-method-' + ep.method.toLowerCase();
    apiHtml += `<div class="ac-item" data-ac-type="api" data-ac-path="${ep.path}" data-ac-method="${ep.method}">`;
    apiHtml += `<div class="ac-item-header"><span class="${mcls}">${ep.method}</span><span class="ac-path">${ep.path}</span><span class="ac-desc">${ep.desc}</span></div>`;
    apiHtml += `<div class="ac-form">${_acBuildForm(ep.params)}<button class="ac-invoke-btn">Invoke</button><div class="ac-response" style="display:none"></div></div>`;
    apiHtml += `</div>`;
  }
  apiContainer.innerHTML = apiHtml;
  document.getElementById('ac-api-count').textContent = _acEndpoints.length;

  // Render scripts
  (async () => {
    const container = document.getElementById('ac-scripts');
    try {
      const r = await fetch('/scripts');
      const data = await r.json();
      let html = '';
      for (const s of data.scripts) {
        html += `<div class="ac-script"><span class="ac-script-name">${s.name}</span><span class="ac-script-desc">${s.description}</span><button class="ac-script-run" data-script="${s.path}">Forge</button></div>`;
      }
      container.innerHTML = html || '<div style="color:#605040;font-size:9px;padding:8px;font-style:italic">The forge is cold...</div>';
      document.getElementById('ac-script-count').textContent = data.scripts.length;
    } catch { container.innerHTML = '<div style="color:#805050;font-size:9px;padding:8px;font-style:italic">Failed to consult the forge</div>'; }
  })();

  // Invoke helpers
  async function _acInvokeApi(item) {
    const method = item.dataset.acMethod, path = item.dataset.acPath;
    const form = item.querySelector('.ac-form'), params = _acCollectParams(form);
    const respEl = form.querySelector('.ac-response'), btn = form.querySelector('.ac-invoke-btn');
    btn.classList.add('ac-running'); btn.textContent = 'Casting...';
    respEl.style.display = 'block'; respEl.className = 'ac-response'; respEl.textContent = 'Channeling...';
    try {
      let url = path, opts = {};
      if (method === 'GET' || method === 'SSE') {
        const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        if (qs) url += '?' + qs;
      } else if (method === 'POST') {
        opts = { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) };
      } else if (method === 'DELETE') { opts = { method: 'DELETE' }; }
      const r = await fetch(url, opts);
      const text = await r.text();
      try { respEl.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { respEl.textContent = text; }
      if (!r.ok) respEl.classList.add('ac-error');
    } catch (e) { respEl.textContent = 'Error: ' + e.message; respEl.classList.add('ac-error'); }
    btn.classList.remove('ac-running'); btn.textContent = 'Invoke';
  }

  // Event delegation for grimoire
  _agPanel.addEventListener('click', e => {
    const toggle = e.target.closest('.ag-section-toggle');
    if (toggle) { toggle.classList.toggle('open'); return; }
    const itemHeader = e.target.closest('.ac-item-header');
    if (itemHeader) { itemHeader.closest('.ac-item').classList.toggle('ac-open'); return; }
    const invokeBtn = e.target.closest('.ac-invoke-btn');
    if (invokeBtn && !invokeBtn.classList.contains('ac-running')) {
      const item = invokeBtn.closest('.ac-item');
      if (item.dataset.acType === 'api') _acInvokeApi(item);
      return;
    }
    const scriptBtn = e.target.closest('.ac-script-run');
    if (scriptBtn) {
      scriptBtn.textContent = 'Forging...';
      scriptBtn.style.pointerEvents = 'none';
      _stExec('bash ' + scriptBtn.dataset.script).then(() => {
        scriptBtn.textContent = 'Forge';
        scriptBtn.style.pointerEvents = '';
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════
// SCRYING TERMINAL — crystal command interface
// ═══════════════════════════════════════════════════════════

const _stPanel = document.getElementById('scrying-terminal');
if (_stPanel) {
  registerPanel(_stPanel);
  makeDraggable(_stPanel, '.panel-header', [140,180,255]);
  makeResizable(_stPanel, [140,180,255]);

  const _stOutput = document.getElementById('st-output');
  const _stInput = document.getElementById('st-input');
  const _stCastBtn = document.getElementById('st-cast');
  const _stHistory = [];
  let _stHistIdx = -1;

  function _stAppend(text, cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    el.textContent = text;
    _stOutput.appendChild(el);
    _stOutput.scrollTop = _stOutput.scrollHeight;
  }

  async function _stExec(cmd) {
    _stAppend(cmd, 'st-cmd');
    _stCastBtn.classList.add('casting');
    try {
      const r = await fetch('/exec', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ command: cmd }) });
      const data = await r.json();
      if (data.output) _stAppend(data.output, 'st-result');
      if (data.error) _stAppend(data.error, 'st-error');
      if (data.exit_code !== 0 && !data.error) _stAppend(`The spell faltered (exit ${data.exit_code})`, 'st-error');
    } catch (e) {
      _stAppend('The crystal dims: ' + e.message, 'st-error');
    }
    _stCastBtn.classList.remove('casting');
  }

  function _stSubmit() {
    const cmd = _stInput.value.trim();
    if (!cmd) return;
    _stHistory.unshift(cmd);
    _stHistIdx = -1;
    _stInput.value = '';
    _stExec(cmd);
  }

  _stInput.addEventListener('keydown', e => {
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
