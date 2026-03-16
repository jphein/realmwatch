'use strict';
import { _topology } from './topology.js';
import { scaleColor, scaleLabel, fmtBytes, fmtRate } from './utils.js';
import { panToNode, showHighlight, findStatusKey } from './app.js';

// ── Panel state (owned here, setters for SSE handlers in app.js) ──
let _latencyMap = null;
let _latencyFlat = null;
let _wifiMap = null;
let _fwData = null;

export function setLatencyMap(v)  { _latencyMap = v; }
export function setLatencyFlat(v) { _latencyFlat = v; }
export function setWifiMap(v)     { _wifiMap = v; }
export const getLatencyFlat = () => _latencyFlat;
export const getWifiMap     = () => _wifiMap;

// ── Cached DOM references (queried once, reused every poll cycle) ──
const DOM = {
  gForge: document.getElementById('g-forge'),
  gGpu: document.getElementById('g-gpu'),
  gMana: document.getElementById('g-mana'),
  gEssence: document.getElementById('g-essence'),
  rsVal: document.getElementById('realm-scale-val'),
  rsLabel: document.getElementById('realm-scale-label'),
  towersOnline: document.getElementById('towers-online'),
  towersTotal: document.getElementById('towers-total'),
  codexCd: document.getElementById('codex-collectd-count'),
  codexNodes: document.getElementById('codex-node-count'),
};
export { DOM };

// ── Update the UI from live data ──
export function updateGauges(d) {
  const { forge, mana, essence } = d;
  const gpu = forge.gpu;
  const gpuLoad = gpu ? gpu.load : 0;

  DOM.gForge.style.width = forge.usage + '%';
  DOM.gForge.parentElement.nextElementSibling.textContent = forge.usage.toFixed(1) + '%';
  DOM.gGpu.style.width = gpuLoad + '%';
  DOM.gGpu.parentElement.nextElementSibling.textContent = gpuLoad.toFixed(0) + '%';
  DOM.gMana.style.width = mana.usage + '%';
  DOM.gMana.parentElement.nextElementSibling.textContent = mana.usage.toFixed(1) + '%';
  DOM.gEssence.style.width = essence.usage + '%';
  DOM.gEssence.parentElement.nextElementSibling.textContent = essence.usage.toFixed(0) + '%';

  DOM.rsVal.textContent = (d.realm_scale >= 0 ? '+' : '') + d.realm_scale.toFixed(1);
  DOM.rsVal.style.color = scaleColor(d.realm_scale);
  DOM.rsLabel.textContent = scaleLabel(d.realm_scale);
}

// ── Latency Panel ──
const _vlanNames = { 6: 'Admin', 8: 'Family', 10: 'IoT', 11: 'Guest' };

function _latencyHue(ms) {
  if (ms < 1) return 140;   // green — local switch
  if (ms < 5) return 100;   // lime
  if (ms < 15) return 60;   // yellow
  if (ms < 50) return 30;   // orange
  return 0;                  // red — slow
}

function _buildNodeLookup() {
  const map = {};
  if (!_topology?.nodes) return map;
  for (const n of _topology.nodes) {
    map[n.id] = { icon: n.icon || '?', label: n.label || n.id, ip: n.ip || '' };
  }
  return map;
}

export function updateLatencyPanel() {
  const body = document.getElementById('latency-body');
  const summary = document.getElementById('latency-summary');
  if (!body || !_latencyMap) return;
  const panel = document.getElementById('latency-panel');
  if (!panel || panel.style.display === 'none') return;

  // Server sends pre-grouped data: {summary, groups}
  const data = _latencyMap;
  if (data.groups) {
    // Pre-grouped from server — skip all sorting/grouping
    if (summary) summary.textContent = `${data.summary.count} nodes \u2022 avg ${data.summary.avg}ms`;
    const frag = document.createDocumentFragment();
    for (const group of data.groups) {
      const title = document.createElement('div');
      title.className = 'latency-group-title';
      title.textContent = group.name;
      frag.appendChild(title);
      for (const e of group.entries) {
        frag.appendChild(_makeLatencyRow(e));
      }
    }
    body.textContent = '';
    body.appendChild(frag);
    return;
  }

  // Fallback: flat {node_id: rtt} map (legacy / direct fetch)
  const nodes = _buildNodeLookup();
  const entries = Object.entries(data).sort((a, b) => a[1] - b[1]);
  if (!entries.length) { body.textContent = 'Probing...'; return; }
  const rtts = entries.map(e => e[1]);
  const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length;
  const max = rtts[rtts.length - 1];
  if (summary) summary.textContent = `${entries.length} nodes \u2022 avg ${avg.toFixed(1)}ms`;
  const frag = document.createDocumentFragment();
  for (const [id, rtt] of entries) {
    const n = nodes[id];
    frag.appendChild(_makeLatencyRow({id, rtt, label: n?.label || id, icon: n?.icon || '?',
      hue: _latencyHue(rtt), pct: Math.min(rtt / Math.max(max, 1) * 100, 100)}));
  }
  body.textContent = '';
  body.appendChild(frag);
}

function _makeLatencyRow(e) {
  const row = document.createElement('div');
  row.className = 'latency-row';
  row.innerHTML = `<span class="latency-icon">${e.icon}</span>`
    + `<span class="latency-label">${e.label}</span>`
    + `<span class="latency-bar"><span class="latency-fill" style="width:${e.pct}%;background:hsl(${e.hue},70%,50%)"></span></span>`
    + `<span class="latency-val">${e.rtt < 1 ? e.rtt.toFixed(2) : e.rtt.toFixed(1)} ms</span>`;
  return row;
}

// ── Firewall Panel ──
const _vlanIfaceMap = {
  '3': 'br-lan.3', '4': 'br-lan.4', '5': 'br-lan.5', '6': 'br-lan.6',
  '7': 'br-lan.7', '8': 'br-lan.8', '9': 'br-lan.9', '10': 'br-lan.10',
  '11': 'br-lan.11', '12': 'br-lan.12', '20': 'br-lan.20', '38': 'br-lan.38',
};

function _fetchFirewall() {
  fetch('/firewall').then(r => r.json()).then(d => {
    if (!d.error) { _fwData = d; _renderFirewallPanel(); }
  }).catch(() => {});
}

let _fwVlanCache = null;  // Cached firewall VLAN DOM refs
function _buildFwVlanCache(panel) {
  _fwVlanCache = [];
  panel.querySelectorAll('.fw-vlan').forEach(row => {
    _fwVlanCache.push({
      iface: _vlanIfaceMap[row.dataset.vlan],
      rx: row.querySelector('.fw-rx-val'),
      tx: row.querySelector('.fw-tx-val'),
    });
  });
}
export function updateFirewallPanel(d) {
  const panel = document.getElementById('firewall-panel');
  if (!panel || panel.style.display === 'none') return;
  const gk = d.collectd?.['gatekeeper'];
  const ifaces = gk?.interfaces || {};
  if (!_fwVlanCache) _buildFwVlanCache(panel);

  for (const c of _fwVlanCache) {
    const data = ifaces[c.iface];
    c.rx.textContent = data ? fmtRate(data.rx_bps) : '--';
    c.tx.textContent = data ? fmtRate(data.tx_bps) : '--';
  }
}

function _renderFirewallPanel() {
  if (!_fwData) return;
  _fwVlanCache = null;  // Invalidate — panel DOM is about to be rebuilt
  const panel = document.getElementById('firewall-panel');
  if (!panel) return;
  const { zones, wan, suggestions } = _fwData;

  // Update zone counters
  for (const [zname, z] of Object.entries(zones)) {
    const row = panel.querySelector(`.fw-vlan[data-vlan="${z.vlan}"]`);
    if (!row) continue;
    // Accept/reject counters
    let statsEl = row.querySelector('.fw-zone-stats');
    if (!statsEl) {
      statsEl = document.createElement('div');
      statsEl.className = 'fw-zone-stats';
      row.appendChild(statsEl);
    }
    const c = z.counters;
    let html = `<span class="fw-stat-accept">${fmtBytes(c.accept_bytes)} in</span>`;
    if (c.reject_pkts > 0) html += ` <span class="fw-stat-reject">${c.reject_pkts.toLocaleString()} rej</span>`;
    statsEl.innerHTML = html;

    // DNS badge
    let dnsEl = row.querySelector('.fw-dns-badge');
    if (z.dns_redirect) {
      if (!dnsEl) {
        dnsEl = document.createElement('span');
        dnsEl.className = 'fw-dns-badge';
        const header = row.querySelector('.fw-vlan-header');
        if (header) header.appendChild(dnsEl);
      }
      dnsEl.textContent = 'DNS';
      dnsEl.title = `${z.dns_queries.toLocaleString()} queries redirected`;
    } else if (dnsEl) {
      dnsEl.remove();
    }

    // Blocked IPs
    let blocksEl = row.querySelector('.fw-blocks');
    if (z.blocked_ips && z.blocked_ips.length) {
      if (!blocksEl) {
        blocksEl = document.createElement('div');
        blocksEl.className = 'fw-blocks';
        row.appendChild(blocksEl);
      }
      blocksEl.innerHTML = z.blocked_ips.map(b =>
        `<span class="fw-block-ip${b.pkts === 0 ? ' fw-block-inactive' : ''}" title="${b.pkts.toLocaleString()} pkts blocked">${b.ip.replace('10.0.10.', '.10.')}${b.pkts > 0 ? ' \u2717' : ' ?'}</span>`
      ).join('');
    } else if (blocksEl) {
      blocksEl.innerHTML = '';
    }

    // Reachability
    let reachEl = row.querySelector('.fw-reach');
    if (z.can_reach && z.can_reach.length) {
      if (!reachEl) {
        reachEl = document.createElement('div');
        reachEl.className = 'fw-reach';
        row.appendChild(reachEl);
      }
      const labels = { wan: 'WAN', lan: 'IoT', iot: 'Guest', family: 'Family', admin: 'Admin', vpn: 'VPN', wanguard: 'WAN Guard' };
      reachEl.innerHTML = '\u2192 ' + z.can_reach.map(r => labels[r] || r).join(', ');
    } else if (reachEl) {
      reachEl.innerHTML = '';
    }
  }

  // WAN gate counter
  const wanEl = document.getElementById('fw-wan');
  if (wanEl) wanEl.textContent = fmtBytes(wan.accept_bytes);
  const lanEl = document.getElementById('fw-lan');
  if (lanEl) lanEl.textContent = wan.reject_pkts.toLocaleString() + ' rej';

  // Suggestions
  let sugEl = panel.querySelector('.fw-suggestions');
  if (!sugEl) {
    const body = panel.querySelector('.firewall-body');
    if (body) {
      const div = document.createElement('div');
      div.className = 'fw-divider';
      body.appendChild(div);
      sugEl = document.createElement('div');
      sugEl.className = 'fw-suggestions';
      body.appendChild(sugEl);
    }
  }
  if (sugEl && suggestions && suggestions.length) {
    const icons = { info: '\u2139', warn: '\u26A0', critical: '\u2622' };
    sugEl.innerHTML = '<div class="fw-section-title">Observations</div>' +
      suggestions.map(s =>
        `<div class="fw-sug fw-sug-${s.severity}"><span class="fw-sug-icon">${icons[s.severity] || '\u2022'}</span> ${s.text}</div>`
      ).join('');
  }
}

// Firewall data pushed via SSE 'firewall' event — initial burst on connect.
export function handleFirewallData(d) { if (!d.error) { _fwData = d; _renderFirewallPanel(); } }

// ── WiFi / Aether Towers Panel ──
const _VLAN_NAMES = { 6: 'Admin', 8: 'Family', 10: 'IoT', 11: 'Guest' };
const _VLAN_COLORS = { 6: '#f0d890', 8: '#c0a060', 10: '#60c060', 11: '#64a0dc' };

function _fetchWifiAPs() {
  const panel = document.getElementById('wifi-panel');
  if (!panel || panel.style.display === 'none') return;
  fetch('/wifi/aps').then(r => r.json()).then(data => {
    _renderWifiPanel(data);
  }).catch(() => {
    const body = document.getElementById('wifi-body');
    if (body) body.innerHTML = '<div class="wifi-loading">Towers unreachable</div>';
  });
}

function _renderWifiPanel(data) {
  const body = document.getElementById('wifi-body');
  const badge = document.getElementById('wifi-ap-count');
  if (!body) return;
  const apIds = Object.keys(data);
  if (badge) badge.textContent = apIds.length + ' towers';
  if (!apIds.length) { body.innerHTML = '<div class="wifi-loading">No towers found</div>'; return; }

  let html = '';
  for (const [apId, ap] of Object.entries(data)) {
    const ssidHtml = (ap.ssids || []).map(s => {
      const vlan = s.vlan;
      const vlanName = _VLAN_NAMES[vlan] || s.network || '?';
      const color = _VLAN_COLORS[vlan] || '#a89870';
      return `<div class="wifi-ssid">
        <span class="wifi-ssid-name">${s.ssid}</span>
        <span class="wifi-ssid-vlan" style="color:${color}">${vlanName}${vlan ? ' <small>v' + vlan + '</small>' : ''}</span>
      </div>`;
    }).join('');
    html += `<div class="wifi-ap" data-ap="${apId}">
      <div class="wifi-ap-header">
        <span class="wifi-ap-icon">&#128225;</span>
        <span class="wifi-ap-name">${ap.label || apId}</span>
        <span class="wifi-ap-clients">${ap.clients || 0} &#128246;</span>
      </div>
      <div class="wifi-ap-ip">${ap.ip || ''}</div>
      ${ssidHtml || '<div class="wifi-ssid wifi-ssid-none">No SSIDs detected</div>'}
    </div>`;
  }
  body.innerHTML = html;

  // Click AP to pan to it on map
  body.querySelectorAll('.wifi-ap').forEach(el => {
    el.addEventListener('click', () => {
      const nodeId = el.dataset.ap;
      const nodeEl = document.querySelector(`[data-tip="${nodeId}"]`);
      if (nodeEl) {
        const x = parseInt(nodeEl.style.left) || 0;
        const y = parseInt(nodeEl.style.top) || 0;
        panToNode(x, y);
      }
    });
  });
}

// WiFi AP data pushed via SSE 'wifi' event — initial burst on connect.
export function renderWifiPanel(data) { _renderWifiPanel(data); }

// ── Node List Panel (Realm Census) ──
const NODE_TYPE_ORDER = ['core', 'infra', 'tower', 'bridge', 'cluster', 'tailscale'];
const NODE_TYPE_LABELS = {
  core: 'Inner Sanctum', infra: 'Infrastructure', tower: 'Guardian Towers',
  bridge: 'Signal Bridges', cluster: 'Enchanted Quarters', tailscale: 'Astral Sea'
};

function buildNodeList() {
  if (!_topology) return;
  const body = document.getElementById('node-list-body');
  const countEl = document.getElementById('nl-count');
  if (!body) return;
  body.innerHTML = '';
  _censusSubCache = null;  // Invalidate DOM cache on rebuild

  // Group nodes by type
  const groups = {};
  _topology.nodes.forEach(n => {
    const type = n.type || 'core';
    if (!groups[type]) groups[type] = [];
    groups[type].push(n);
  });

  let total = 0;
  NODE_TYPE_ORDER.forEach(type => {
    const nodes = groups[type];
    if (!nodes || !nodes.length) return;
    total += nodes.length;

    const group = document.createElement('div');
    group.className = 'nl-group';
    group.innerHTML = `<div class="nl-group-title">${NODE_TYPE_LABELS[type] || type}</div>`;

    nodes.forEach(n => {
      const item = document.createElement('div');
      item.className = 'nl-item';
      item.dataset.nodeId = n.id;
      item.innerHTML = `<div class="nl-status unknown"></div><span class="nl-icon">${n.icon}</span><div class="nl-info"><div class="nl-name">${n.label}</div><div class="nl-sub">${n.ip || n.sublabel || ''}</div></div>`;

      // Click to pan/zoom to node
      item.addEventListener('click', () => {
        const nodeEl = document.querySelector(`[data-tip="${n.id}"]`);
        if (!nodeEl) return;
        const nodeLeft = parseInt(nodeEl.style.left) || 0;
        const nodeTop = parseInt(nodeEl.style.top) || 0;
        panToNode(nodeLeft, nodeTop);
        showHighlight(nodeEl, { color: 'rgba(240,216,144,0.5)' });
      });

      group.appendChild(item);
    });
    body.appendChild(group);
  });

  if (countEl) countEl.textContent = total + ' nodes';
}

export function updateNodeListStatus(d) {
  if (!d || !d.astral) return;
  const nodeStatus = d.astral.nodes || {};
  document.querySelectorAll('.nl-item').forEach(item => {
    const id = item.dataset.nodeId;
    const dot = item.querySelector('.nl-status');
    if (!dot) return;
    const statusKey = findStatusKey(nodeStatus, id);
    const online = statusKey ? nodeStatus[statusKey] : null;
    dot.className = 'nl-status ' + (online === true ? 'online' : online === false ? 'offline' : 'unknown');
  });
}

// Build the node list from topology
buildNodeList();

// Cache census DOM refs to avoid querySelectorAll every 10s
let _censusSubCache = null;
function _buildCensusSubCache() {
  _censusSubCache = [];
  document.querySelectorAll('.nl-item').forEach(item => {
    const id = item.dataset.nodeId;
    const subEl = item.querySelector('.nl-sub');
    if (id && subEl) _censusSubCache.push({ id, subEl });
  });
}

export function updateCensusSubLabels(d) {
  if (!d) return;
  if (!_censusSubCache) _buildCensusSubCache();
  const sublabels = d.sublabels || {};
  for (const { id, subEl } of _censusSubCache) {
    // Use server-precomputed sublabel when available
    if (sublabels[id]) {
      subEl.textContent = sublabels[id];
    } else {
      // Fallback: HA > WLED > WiFi
      const haInfo = d.ha?.[id];
      if (haInfo?.sublabel) { subEl.textContent = haInfo.sublabel; continue; }
      const wledInfo = d.wled?.[id];
      if (wledInfo?.online) { subEl.textContent = wledInfo.on ? `On \u2022 ${wledInfo.effect || 'Solid'}` : 'Off'; continue; }
      const wifi = d.wifi?.[id];
      if (wifi?.signal != null) { subEl.textContent = `${wifi.signal} dBm \u2022 ${wifi.ssid || wifi.ap || ''}`; }
    }
  }
}

// Census rebuild triggered by SSE topology event (see initSSE below)
export function rebuildCensusIfNeeded() {
  buildNodeList();
  _censusSubCache = null;  // Invalidate cache — nodes may have changed
}

// ── Energy Panel ──
export function updateEnergyPanel(data) {
  if (!data || data.error) return;

  const fmt = (v, unit, decimals = 1) => v != null ? `${v.toFixed(decimals)}${unit}` : '--';
  const fmtW = (w) => {
    if (w == null) return '--';
    if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(1)}kW`;
    return `${Math.round(w)}W`;
  };

  // Solar
  const solarEl = document.getElementById('energy-solar');
  if (solarEl) {
    const pv = data.solar_kw;
    solarEl.textContent = pv != null ? fmtW(pv) : '--';
  }

  // Battery
  const battEl = document.getElementById('energy-battery');
  if (battEl) {
    const soc = data.battery_soc;
    const power = data.battery_power;
    if (soc != null) {
      const dir = power < -10 ? ' +' : power > 10 ? ' -' : '';
      battEl.textContent = `${Math.round(soc)}%${dir}`;
    } else {
      battEl.textContent = '--';
    }
  }

  // Grid
  const gridEl = document.getElementById('energy-grid');
  if (gridEl) {
    const gp = data.grid_power;
    if (gp != null) {
      gridEl.textContent = `${gp.toFixed(2)}kW`;
    } else {
      gridEl.textContent = '--';
    }
  }

  // House
  const houseEl = document.getElementById('energy-house');
  if (houseEl) {
    const load = data.house_load;
    houseEl.textContent = load != null ? fmtW(load) : '--';
  }

  // Today
  const todayEl = document.getElementById('energy-today');
  if (todayEl) {
    const today = data.today_load_kwh;
    todayEl.textContent = today != null ? `${today.toFixed(1)}kWh` : '--';
  }

  // Export
  const exportEl = document.getElementById('energy-export');
  if (exportEl) {
    const exp = data.grid_export_kwh;
    exportEl.textContent = exp != null ? `${exp.toFixed(0)}kWh` : '--';
  }
}
