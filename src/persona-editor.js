'use strict';
import { WORLD_SCALE } from './config.js';
import { _topology, _nodeMap, infraNodes } from './topology.js';
import { getLastStatus, findCollectd } from './node-status.js';
import { addLogEntry } from './quest-log.js';
import { fmtBytes, fmtRate } from './utils.js';

// ── Persona Editor ──
let currentEditNode = null;
const peOverlay = document.getElementById('pe-overlay');
const peEditor = document.getElementById('persona-editor');
const peNodeKey = document.getElementById('pe-node-key');
const peName = document.getElementById('pe-name');
const peTitleField = document.getElementById('pe-title-field');
const peVoice = document.getElementById('pe-voice');
const pePrompt = document.getElementById('pe-prompt');
const peHints = document.getElementById('pe-hints');
const peHintInput = document.getElementById('pe-hint-input');
const peSaved = document.getElementById('pe-saved');
let peHintsList = [];

// Late-bound renderers injected by app.js (these live in node-controls territory)
let _tabRenderers = {};
export function setTabRenderers(renderers) { _tabRenderers = renderers; }

export const getCurrentEditNode = () => currentEditNode;

export function openPersonaEditor(nodeKey) {
  currentEditNode = nodeKey;
  peNodeKey.value = nodeKey;
  _switchToTab('persona');
  // Load current persona from server
  fetch('/personas').then(r => r.json()).then(personas => {
    const p = personas[nodeKey] || {};
    peName.value = p.name || nodeKey;
    peTitleField.value = p.title || '';
    peVoice.value = p.voice || 'en-US-GuyNeural';
    pePrompt.value = p.system_prompt || '';
    peHintsList = Array.isArray(p.hints) ? [...p.hints] : [];
    renderHints();
  }).catch(() => {
    peName.value = nodeKey;
    peTitleField.value = '';
    pePrompt.value = '';
    peHintsList = [];
    renderHints();
  });
  // Show/hide Group tab based on whether node has entity members
  const groupTab = document.querySelector('.pe-tab[data-pe-tab="group"]');
  if (groupTab) {
    const lastStatus = getLastStatus();
    const groupConfig = lastStatus?.groups?.[nodeKey];
    const hasMembers = groupConfig && (
      Array.isArray(groupConfig.entities) ? groupConfig.entities.length > 1 :
      typeof groupConfig.entities === 'object' ? Object.keys(groupConfig.entities).length > 1 : false
    );
    groupTab.style.display = hasMembers ? '' : 'none';
  }
  // Show/hide Vassals tab based on whether node has discovered sub-entities
  const vassalsTab = document.querySelector('.pe-tab[data-pe-tab="vassals"]');
  if (vassalsTab) {
    fetch('/discovery/' + encodeURIComponent(nodeKey))
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const count = (data?.host_entities?.length || 0) + (data?.linked_entities?.length || 0);
        vassalsTab.style.display = count > 0 ? '' : 'none';
      })
      .catch(() => { vassalsTab.style.display = 'none'; });
  }
  peEditor.classList.add('open');
  peOverlay.classList.add('open');
  peSaved.classList.remove('show');
}

function closePersonaEditor() {
  peEditor.classList.remove('open');
  peOverlay.classList.remove('open');
  currentEditNode = null;
  stopStatsRefresh();
}

function renderHints() {
  peHints.textContent = '';
  peHintsList.forEach((hint, i) => {
    const tag = document.createElement('span');
    tag.className = 'pe-hint-tag';
    tag.textContent = hint + ' ';
    const x = document.createElement('span');
    x.className = 'hint-x';
    x.dataset.idx = i;
    x.textContent = '\u00d7';
    x.addEventListener('click', () => {
      peHintsList.splice(i, 1);
      renderHints();
    });
    tag.appendChild(x);
    peHints.appendChild(tag);
  });
}

peHintInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && peHintInput.value.trim()) {
    e.preventDefault();
    peHintsList.push(peHintInput.value.trim());
    peHintInput.value = '';
    renderHints();
  }
});

document.getElementById('pe-save').addEventListener('click', () => {
  if (!currentEditNode) return;
  const payload = {
    node: currentEditNode,
    name: peName.value,
    title: peTitleField.value,
    voice: peVoice.value,
    system_prompt: pePrompt.value,
    hints: peHintsList,
  };
  fetch('/personas', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      peSaved.classList.add('show');
      setTimeout(() => peSaved.classList.remove('show'), 2000);
      addLogEntry({type:'system', node: currentEditNode,
        text: `Persona "${peName.value}" inscribed in the archives.`, ts: Date.now()/1000});
    }
  }).catch(() => {});
});

document.getElementById('pe-cancel').addEventListener('click', closePersonaEditor);
document.getElementById('pe-close').addEventListener('click', closePersonaEditor);
peOverlay.addEventListener('click', closePersonaEditor);

// ── Persona Editor Tabs ──
let _statsInterval = null;

document.querySelectorAll('.pe-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.pe-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.peTab;
    document.querySelectorAll('.pe-pane').forEach(p => p.style.display = 'none');
    document.getElementById('pe-pane-' + target).style.display = '';
    if (target === 'stats') startStatsRefresh();
    else stopStatsRefresh();
    if (target === 'node') renderNodePane(currentEditNode);
    if (target === 'control') _tabRenderers.renderControlPane?.(currentEditNode);
    if (target === 'group') _tabRenderers.renderGroupPane?.(currentEditNode);
    if (target === 'shell') { _tabRenderers.renderShellPane?.(currentEditNode); _tabRenderers.focusShellInput?.(); }
    if (target === 'links') _tabRenderers.renderConnectionsPane?.(currentEditNode);
    if (target === 'vassals') _tabRenderers.renderVassalsPane?.(currentEditNode);
  });
});

export function switchToTab(name) {
  _switchToTab(name);
}

function _switchToTab(name) {
  document.querySelectorAll('.pe-tab').forEach(t => t.classList.toggle('active', t.dataset.peTab === name));
  document.querySelectorAll('.pe-pane').forEach(p => p.style.display = 'none');
  document.getElementById('pe-pane-' + name).style.display = '';
  if (name === 'stats') startStatsRefresh();
  else stopStatsRefresh();
  if (name === 'node') renderNodePane(currentEditNode);
  if (name === 'control') _tabRenderers.renderControlPane?.(currentEditNode);
  if (name === 'group') _tabRenderers.renderGroupPane?.(currentEditNode);
  if (name === 'shell') _tabRenderers.renderShellPane?.(currentEditNode);
  if (name === 'links') _tabRenderers.renderConnectionsPane?.(currentEditNode);
  if (name === 'vassals') _tabRenderers.renderVassalsPane?.(currentEditNode);
}

function startStatsRefresh() {
  stopStatsRefresh();
  renderStatsPane(currentEditNode);
  _statsInterval = setInterval(() => {
    if (!document.hidden) renderStatsPane(currentEditNode);
  }, 5000);
}
function stopStatsRefresh() {
  if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
}

// ── Node Properties Tab ──
const _nodeFields = ['label','sublabel','icon','type','ip','mac','collectd','x','y','ssh','tshost'];
function renderNodePane(nodeKey) {
  if (!nodeKey || !_topology) return;
  const node = _nodeMap.get(nodeKey);
  if (!node) return;
  const el = id => document.getElementById('pe-node-' + id);
  el('label').value = node.label || '';
  el('sublabel').value = node.sublabel || '';
  el('icon').value = node.icon || '';
  el('type').value = node.type || 'device';
  el('ip').value = node.ip || '';
  el('mac').value = node.mac || '';
  el('collectd').value = node.collectd || '';
  el('x').value = Math.round((node.x || 0) / (WORLD_SCALE || 1));
  el('y').value = Math.round((node.y || 0) / (WORLD_SCALE || 1));
  el('url').value = node.url || '';
  el('ssh').value = node.ssh || '';
  el('tshost').value = node.tsHost || '';
}

document.getElementById('pe-node-save')?.addEventListener('click', () => {
  if (!currentEditNode || !_topology) return;
  const node = _nodeMap.get(currentEditNode);
  if (!node) return;
  const el = id => document.getElementById('pe-node-' + id);
  node.label = el('label').value;
  node.sublabel = el('sublabel').value;
  node.icon = el('icon').value;
  node.type = el('type').value;
  node.ip = el('ip').value;
  node.mac = el('mac').value || undefined;
  node.collectd = el('collectd').value || undefined;
  node.url = el('url').value || undefined;
  node.ssh = el('ssh').value || undefined;
  node.tsHost = el('tshost').value || undefined;
  // Position (stored in unscaled coords on server)
  const nx = parseInt(el('x').value) || 0;
  const ny = parseInt(el('y').value) || 0;
  // Save to server
  const payload = { ...node, x: nx, y: ny };
  delete payload._auto;
  fetch('/node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      // Update local scaled position
      const sc = WORLD_SCALE || 1;
      node.x = Math.round(nx * sc);
      node.y = Math.round(ny * sc);
      // Update DOM
      const domNode = document.querySelector(`[data-tip="${currentEditNode}"]`);
      if (domNode) {
        domNode.style.left = node.x + 'px';
        domNode.style.top = node.y + 'px';
        const lbl = domNode.querySelector('.node-label');
        if (lbl) lbl.textContent = node.label;
        const sub = domNode.querySelector('.node-sublabel');
        if (sub) sub.textContent = node.sublabel;
        const ico = domNode.querySelector('.node-icon');
        if (ico) { const txt = ico.childNodes; if (txt.length) txt[txt.length-1].textContent = node.icon; }
      }
      addLogEntry({ type: 'system', node: currentEditNode, text: `Node "${node.label}" updated.`, ts: Date.now()/1000 });
    }
  });
});

document.getElementById('pe-node-delete')?.addEventListener('click', () => {
  if (!currentEditNode) return;
  if (!confirm(`Delete node "${currentEditNode}"? This cannot be undone.`)) return;
  fetch('/node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentEditNode, _delete: true })
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      closePersonaEditor();
      location.reload();
    }
  });
});

function _barClass(pct) {
  return pct > 85 ? 'bar-crit' : pct > 60 ? 'bar-warn' : 'bar-ok';
}

function renderStatsPane(nodeKey) {
  const body = document.getElementById('pe-stats-body');
  const titleEl = document.getElementById('pe-stats-title');
  if (!body) return;

  const info = infraNodes[nodeKey];
  const nodeName = info ? info.name : nodeKey;
  titleEl.textContent = nodeName + ' \u2014 Scrying';

  const lastStatus = getLastStatus();
  if (!lastStatus) {
    body.textContent = 'No scrying data available.';
    return;
  }
  const cd = lastStatus.collectd ? findCollectd(lastStatus.collectd, nodeKey, null) : null;
  const tsHost = info && info.tsHost;
  const tsPeer = tsHost && lastStatus.tailscale && lastStatus.tailscale.peers ? lastStatus.tailscale.peers[tsHost] : null;
  const wifiInfo = lastStatus.wifi ? lastStatus.wifi[nodeKey] : null;
  const haInfo = lastStatus.ha ? lastStatus.ha[nodeKey] : null;
  const wledInfo = lastStatus.wled ? lastStatus.wled[nodeKey] : null;
  const nodeRole = lastStatus.roles ? lastStatus.roles[nodeKey] : null;
  const topoNode = _nodeMap.get(nodeKey) || null;
  if (!cd && !tsPeer && !wifiInfo && !haInfo && !wledInfo && !topoNode) {
    body.textContent = 'No sigils bound to this node.';
    return;
  }

  let html = '';

  // Role badge + basic info header
  const roleIcons = {
    router: '\uD83C\uDF10', ap: '\uD83D\uDCE1', switch: '\uD83D\uDD00', bridge: '\uD83C\uDF09',
    server: '\uD83D\uDDA5\uFE0F', nas: '\uD83D\uDCBE', vm: '\uD83D\uDCE6',
    wled: '\uD83C\uDF08', thermostat: '\uD83C\uDF21\uFE0F', camera: '\uD83D\uDCF9', speaker: '\uD83D\uDD0A',
    plug: '\uD83D\uDD0C', sensor: '\uD83D\uDCCA', appliance: '\uD83C\uDFE0', vacuum: '\uD83E\uDD16',
    inverter: '\u2600\uFE0F', ups: '\uD83D\uDD0B', ev_charger: '\u26A1',
    phone: '\uD83D\uDCF1', tablet: '\uD83D\uDCDF', laptop: '\uD83D\uDCBB', desktop: '\uD83D\uDDA5\uFE0F',
    tv: '\uD83D\uDCFA', tailscale: '\uD83D\uDD17', unknown: '\u2753'
  };
  const roleNames = {
    router: 'Router', ap: 'Access Point', switch: 'Switch', bridge: 'Bridge',
    server: 'Server', nas: 'NAS', vm: 'VM', wled: 'LED Controller',
    thermostat: 'Thermostat', camera: 'Camera', speaker: 'Speaker', plug: 'Smart Plug',
    sensor: 'Sensor', appliance: 'Appliance', vacuum: 'Vacuum', inverter: 'Inverter',
    ups: 'UPS', ev_charger: 'EV Charger', phone: 'Phone', tablet: 'Tablet',
    laptop: 'Laptop', desktop: 'Desktop', tv: 'TV', tailscale: 'Tailscale', unknown: 'Unknown'
  };
  if (nodeRole) {
    const icon = roleIcons[nodeRole] || '\u2753';
    const name = roleNames[nodeRole] || nodeRole;
    html += `<div class="pe-role-badge"><span class="pe-role-icon">${icon}</span><span class="pe-role-name">${name}</span></div>`;
  }

  // Tailscale section
  if (tsPeer) {
    html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Tailscale</div>';
    html += `<div class="pe-stat-row"><span class="pe-stat-label">Status</span><span class="pe-stat-val" style="color:${tsPeer.online ? '#60c060' : '#c04040'}">${tsPeer.online ? (tsPeer.active ? 'Active' : 'Online') : 'Offline'}</span></div>`;
    if (tsPeer.ip) html += `<div class="pe-stat-row"><span class="pe-stat-label">TS IP</span><span class="pe-stat-val">${tsPeer.ip}</span></div>`;
    if (tsPeer.os) html += `<div class="pe-stat-row"><span class="pe-stat-label">OS</span><span class="pe-stat-val">${tsPeer.os}</span></div>`;
    if (tsPeer.curAddr) html += `<div class="pe-stat-row"><span class="pe-stat-label">Link</span><span class="pe-stat-val" style="color:#60c060">Direct \u2014 ${tsPeer.curAddr}</span></div>`;
    else if (tsPeer.online && tsPeer.relay) html += `<div class="pe-stat-row"><span class="pe-stat-label">Link</span><span class="pe-stat-val" style="color:#c0a030">Relayed via ${tsPeer.relay.toUpperCase()}</span></div>`;
    if (tsPeer.tx || tsPeer.rx) html += `<div class="pe-stat-row"><span class="pe-stat-label">Traffic</span><span class="pe-stat-val">\u2191 ${fmtBytes(tsPeer.tx)} \u2193 ${fmtBytes(tsPeer.rx)}</span></div>`;
    if (tsPeer.exitNode) html += `<div class="pe-stat-row"><span class="pe-stat-label">Exit Node</span><span class="pe-stat-val" style="color:#c09030">Yes</span></div>`;
    if (tsPeer.lastSeen && !tsPeer.online) {
      const ago = Date.now() - new Date(tsPeer.lastSeen).getTime();
      const days = Math.floor(ago / 86400000);
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Last Seen</span><span class="pe-stat-val">${days > 0 ? days + 'd ago' : 'recently'}</span></div>`;
    }
    if (tsPeer.keyExpiry) {
      const daysLeft = Math.floor((new Date(tsPeer.keyExpiry) - Date.now()) / 86400000);
      const kColor = daysLeft < 7 ? '#c04040' : daysLeft < 30 ? '#c0a030' : '#60a040';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Key Expiry</span><span class="pe-stat-val" style="color:${kColor}">${daysLeft > 0 ? daysLeft + 'd' : 'EXPIRED'}</span></div>`;
    }
    html += '</div>';
  }

  // WLED section
  if (wledInfo) {
    html += '<div class="pe-stats-section"><div class="pe-stats-section-title">WLED</div>';
    const onColor = wledInfo.on ? '#60c060' : '#808080';
    html += `<div class="pe-stat-row"><span class="pe-stat-label">State</span><span class="pe-stat-val" style="color:${onColor}">${wledInfo.on ? 'On' : 'Off'}</span></div>`;
    if (wledInfo.on) {
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Brightness</span><span class="pe-stat-val">${wledInfo.brightness_pct}%</span></div>`;
      html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill pe-bar-good" style="width:${wledInfo.brightness_pct}%;background:linear-gradient(90deg,#ff6090,#60c0ff)"></div></div>`;
      if (wledInfo.effect) html += `<div class="pe-stat-row"><span class="pe-stat-label">Effect</span><span class="pe-stat-val">${wledInfo.effect}</span></div>`;
    }
    if (wledInfo.led_count) html += `<div class="pe-stat-row"><span class="pe-stat-label">LEDs</span><span class="pe-stat-val">${wledInfo.led_count}</span></div>`;
    if (wledInfo.led_power_mw) {
      const powerW = (wledInfo.led_power_mw / 1000).toFixed(1);
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Power</span><span class="pe-stat-val">${powerW}W</span></div>`;
    }
    if (wledInfo.wifi_rssi != null) {
      const rssiColor = wledInfo.wifi_rssi > -50 ? '#60a040' : wledInfo.wifi_rssi > -70 ? '#c0a030' : '#c04040';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">WiFi RSSI</span><span class="pe-stat-val" style="color:${rssiColor}">${wledInfo.wifi_rssi} dBm</span></div>`;
    }
    if (wledInfo.uptime_str) html += `<div class="pe-stat-row"><span class="pe-stat-label">Uptime</span><span class="pe-stat-val">${wledInfo.uptime_str}</span></div>`;
    if (wledInfo.version) html += `<div class="pe-stat-row"><span class="pe-stat-label">Version</span><span class="pe-stat-val">${wledInfo.version}</span></div>`;
    html += '</div>';
  }

  // System section (from collectd)
  if (cd) {
    const sysRows = [];
    if (cd.hostname) sysRows.push(['Hostname', cd.hostname]);
    if (cd.cpu_cores) sysRows.push(['CPU Cores', cd.cpu_cores]);
    if (cd.uptime != null) {
      const d = Math.floor(cd.uptime / 86400), h = Math.floor((cd.uptime % 86400) / 3600);
      sysRows.push(['Uptime', d > 0 ? `${d}d ${h}h` : `${h}h`]);
    }
    if (cd.procs_running) sysRows.push(['Processes', cd.procs_running + ' running']);
    if (cd.fork_rate) sysRows.push(['Fork Rate', cd.fork_rate.toLocaleString()]);
    if (sysRows.length) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">System</div>';
      sysRows.forEach(([l, v]) => html += `<div class="pe-stat-row"><span class="pe-stat-label">${l}</span><span class="pe-stat-val">${v}</span></div>`);
      html += '</div>';
    }

    // Load section
    if (cd.load_1 != null) {
      const cores = cd.cpu_cores || 1;
      const loadPct = Math.min(100, (cd.load_1 / cores) * 100);
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Load</div>';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">1 / 5 / 15 min</span><span class="pe-stat-val">${cd.load_1.toFixed(2)} / ${(cd.load_5||0).toFixed(2)} / ${(cd.load_15||0).toFixed(2)}</span></div>`;
      html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(loadPct)}" style="width:${loadPct}%"></div></div>`;
      html += '</div>';
    }

    // Memory section
    if (cd.mem_pct != null) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Memory</div>';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Usage</span><span class="pe-stat-val">${cd.mem_pct}% of ${cd.mem_total_mb || '?'} MB</span></div>`;
      html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(cd.mem_pct)}" style="width:${cd.mem_pct}%"></div></div>`;
      if (cd.swap_used != null && cd.swap_used > 0) {
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Swap</span><span class="pe-stat-val">${(cd.swap_used / 1048576).toFixed(0)} MB</span></div>`;
      }
      html += '</div>';
    }

    // Disk section
    if (cd.disk_pct != null) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Disk</div>';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Usage</span><span class="pe-stat-val">${cd.disk_pct}% of ${cd.disk_total_gb} GB</span></div>`;
      html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(cd.disk_pct)}" style="width:${cd.disk_pct}%"></div></div>`;
      html += '</div>';
    }

    // Thermal section
    if (cd.temp != null) {
      const tempPct = Math.min(100, (cd.temp / 100) * 100);
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Thermal</div>';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Temperature</span><span class="pe-stat-val">${cd.temp}\u00B0C</span></div>`;
      html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(tempPct)}" style="width:${tempPct}%"></div></div>`;
      html += '</div>';
    }

    // Network section
    if (cd.interfaces && Object.keys(cd.interfaces).length) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Network</div>';
      Object.entries(cd.interfaces)
        .sort(([,a],[,b]) => ((b.rx_bps||0)+(b.tx_bps||0)) - ((a.rx_bps||0)+(a.tx_bps||0)))
        .forEach(([name, v]) => {
          html += `<div class="pe-iface-row"><span class="pe-iface-name">${name}</span><span class="pe-iface-traffic">\u2193${fmtRate(v.rx_bps||0)} \u2191${fmtRate(v.tx_bps||0)}</span></div>`;
        });
      html += '</div>';
    }

    // Conntrack / DHCP
    if (cd.conntrack || cd.dhcp_leases) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Connections</div>';
      if (cd.conntrack) html += `<div class="pe-stat-row"><span class="pe-stat-label">Conntrack</span><span class="pe-stat-val">${cd.conntrack.toLocaleString()}</span></div>`;
      if (cd.dhcp_leases) html += `<div class="pe-stat-row"><span class="pe-stat-label">DHCP Leases</span><span class="pe-stat-val">${cd.dhcp_leases}</span></div>`;
      html += '</div>';
    }

    // Ping section
    if (cd.ping && Object.keys(cd.ping).length) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Ping</div>';
      Object.entries(cd.ping).forEach(([target, ms]) => {
        const pingColor = ms < 10 ? '#60a040' : ms < 50 ? '#c0a030' : '#c04040';
        html += `<div class="pe-stat-row"><span class="pe-stat-label">${target}</span><span class="pe-stat-val" style="color:${pingColor}">${ms} ms</span></div>`;
      });
      html += '</div>';
    }
  } // end collectd

  // WiFi signal section (from ap_scanner)
  if (wifiInfo) {
    html += '<div class="pe-stats-section"><div class="pe-stats-section-title">WiFi</div>';
    const apLabel = _nodeMap.get(wifiInfo.ap)?.label || wifiInfo.ap;
    html += `<div class="pe-stat-row"><span class="pe-stat-label">Access Point</span><span class="pe-stat-val">${apLabel}</span></div>`;
    if (wifiInfo.signal != null) {
      const sigColor = wifiInfo.signal > -50 ? '#60a040' : wifiInfo.signal > -70 ? '#c0a030' : '#c04040';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Signal</span><span class="pe-stat-val" style="color:${sigColor}">${wifiInfo.signal} dBm</span></div>`;
    }
    if (wifiInfo.snr != null) {
      const snrColor = wifiInfo.snr > 40 ? '#60a040' : wifiInfo.snr > 20 ? '#c0a030' : '#c04040';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">SNR</span><span class="pe-stat-val" style="color:${snrColor}">${wifiInfo.snr} dB</span></div>`;
    }
    if (wifiInfo.tx_rate) html += `<div class="pe-stat-row"><span class="pe-stat-label">TX Rate</span><span class="pe-stat-val">${wifiInfo.tx_rate} Mbit/s</span></div>`;
    if (wifiInfo.rx_rate) html += `<div class="pe-stat-row"><span class="pe-stat-label">RX Rate</span><span class="pe-stat-val">${wifiInfo.rx_rate} Mbit/s</span></div>`;
    if (wifiInfo.tx_pkts) html += `<div class="pe-stat-row"><span class="pe-stat-label">TX Packets</span><span class="pe-stat-val">${wifiInfo.tx_pkts.toLocaleString()}</span></div>`;
    if (wifiInfo.rx_pkts) html += `<div class="pe-stat-row"><span class="pe-stat-label">RX Packets</span><span class="pe-stat-val">${wifiInfo.rx_pkts.toLocaleString()}</span></div>`;
    html += '</div>';
  }

  // Home Assistant section
  if (haInfo) {
    html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Home Assistant</div>';
    const sublabel = haInfo.sublabel || '';
    if (sublabel.includes('\u00B0F')) {
      const parts = sublabel.split(' \u2022 ');
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Temperature</span><span class="pe-stat-val">${parts[0]}</span></div>`;
      if (parts[1]) html += `<div class="pe-stat-row"><span class="pe-stat-label">State</span><span class="pe-stat-val">${parts[1]}</span></div>`;
    } else if (sublabel.includes('kW') || sublabel.includes('Batt')) {
      const parts = sublabel.split(' \u2022 ');
      parts.forEach(p => {
        if (p.includes('kW')) html += `<div class="pe-stat-row"><span class="pe-stat-label">Power</span><span class="pe-stat-val">${p}</span></div>`;
        else if (p.includes('Batt')) html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${p}</span></div>`;
      });
    } else if (sublabel.includes('%') && !sublabel.includes('on')) {
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${sublabel}</span></div>`;
    } else if (sublabel.includes('/') && sublabel.includes('on')) {
      const [on, total] = sublabel.match(/(\d+)\/(\d+)/)?.slice(1) || [];
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Active</span><span class="pe-stat-val">${on} of ${total}</span></div>`;
    } else if (sublabel.includes('Radar:')) {
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Presence</span><span class="pe-stat-val">${sublabel.replace('Radar: ', '')}</span></div>`;
    } else {
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Status</span><span class="pe-stat-val">${sublabel || 'connected'}</span></div>`;
    }
    if (haInfo.entities) html += `<div class="pe-stat-row"><span class="pe-stat-label">Entities</span><span class="pe-stat-val">${haInfo.entities}</span></div>`;
    html += '</div>';
  }

  // Basic node info (always show for topology nodes)
  if (topoNode) {
    const nodeRows = [];
    if (topoNode.type) nodeRows.push(['Type', topoNode.type]);
    if (topoNode.ip) nodeRows.push(['IP', topoNode.ip]);
    if (topoNode.mac) nodeRows.push(['MAC', topoNode.mac]);
    if (topoNode.collectd) nodeRows.push(['Collectd', topoNode.collectd]);
    if (topoNode.tsHost) nodeRows.push(['Tailscale', topoNode.tsHost]);
    if (topoNode._auto) nodeRows.push(['Source', '<span style="color:#a070c0">Auto-discovered</span>']);
    if (nodeRows.length && !cd) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Node Info</div>';
      nodeRows.forEach(([l, v]) => html += `<div class="pe-stat-row"><span class="pe-stat-label">${l}</span><span class="pe-stat-val">${v}</span></div>`);
      html += '</div>';
    }
  }

  body.innerHTML = html;
}
