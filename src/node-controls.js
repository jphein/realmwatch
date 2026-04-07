'use strict';
import { _topology, _nodeMap, infraNodes, CONN_TYPE_TO_CLASS, _connPaths, _getNodePos, _computePathD } from './topology.js';
import { getLastStatus } from './node-status.js';
import { getCurrentEditNode, openPersonaEditor } from './persona-editor.js';
import { panToNode } from './map-view.js';
import { registerPanel } from './panel-manager.js';
import { makeDraggable, makeResizable } from './layout.js';

// ── Control Tab ──
export function renderControlPane(nodeKey) {
  const body = document.getElementById('pe-control-body');
  const titleEl = document.getElementById('pe-control-title');
  const statusEl = document.getElementById('pe-control-status');
  if (!body) return;

  const lastStatus = getLastStatus();
  const info = infraNodes[nodeKey];
  const nodeName = info ? info.name : nodeKey;
  titleEl.textContent = nodeName + ' — Controls';
  statusEl.textContent = '';

  if (!lastStatus) {
    body.innerHTML = '<div class="pe-control-empty">No connection to realm.</div>';
    return;
  }

  const nodeRole = lastStatus.roles ? lastStatus.roles[nodeKey] : null;
  const wledInfo = lastStatus.wled ? lastStatus.wled[nodeKey] : null;
  const haInfo = lastStatus.ha ? lastStatus.ha[nodeKey] : null;
  const topoNode = _nodeMap.get(nodeKey) || null;

  let html = '';
  let hasControls = false;

  // WLED Controls
  if (wledInfo && wledInfo.online) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">LED Strip</div>';

    // Power toggle
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Power</span>
      <div class="pe-control-toggle ${wledInfo.on ? 'active' : ''}" data-action="wled-power" data-node="${nodeKey}" data-state="${wledInfo.on ? 'off' : 'on'}"></div>
    </div>`;

    // Brightness slider
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Brightness</span>
      <input type="range" class="pe-control-slider" min="0" max="255" value="${wledInfo.brightness || 128}" data-action="wled-brightness" data-node="${nodeKey}">
      <span style="width:30px;text-align:right;color:#a89870;font-size:11px">${wledInfo.brightness_pct || 50}%</span>
    </div>`;

    // Effect buttons
    const quickEffects = [
      { id: 0, name: 'Solid' },
      { id: 38, name: 'Aurora' },
      { id: 9, name: 'Rainbow' },
      { id: 12, name: 'Theater' },
      { id: 44, name: 'Fire' },
      { id: 108, name: 'Noise' },
    ];
    html += '<div class="pe-control-row" style="flex-wrap:wrap;gap:6px;justify-content:flex-start">';
    quickEffects.forEach(fx => {
      const active = wledInfo.effect_id === fx.id ? 'style="border-color:#60c060;color:#90ff90"' : '';
      html += `<button class="pe-control-btn" data-action="wled-effect" data-node="${nodeKey}" data-effect="${fx.id}" ${active}>${fx.name}</button>`;
    });
    html += '</div>';
    html += '</div>';
  }

  // Smart Plug Controls (via HA)
  if (nodeRole === 'plug' && haInfo) {
    hasControls = true;
    const isOn = haInfo.sublabel && (haInfo.sublabel.toLowerCase().includes('on') || haInfo.sublabel.includes('/'));
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Smart Plug</div>';
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Power</span>
      <div class="pe-control-toggle ${isOn ? 'active' : ''}" data-action="ha-switch" data-node="${nodeKey}"></div>
    </div>`;
    html += '</div>';
  }

  // Thermostat Controls
  if (nodeRole === 'thermostat' && haInfo) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Climate</div>';
    const tempMatch = haInfo.sublabel?.match(/(\d+)/);
    const currentTemp = tempMatch ? parseInt(tempMatch[1]) : 70;
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Target</span>
      <button class="pe-control-btn" data-action="ha-climate" data-node="${nodeKey}" data-delta="-1">-</button>
      <span style="color:#d4c5a0;font-size:14px;min-width:40px;text-align:center">${currentTemp}°F</span>
      <button class="pe-control-btn" data-action="ha-climate" data-node="${nodeKey}" data-delta="1">+</button>
    </div>`;
    html += '<div class="pe-control-row" style="gap:6px;justify-content:flex-start">';
    ['off', 'heat', 'cool', 'auto'].forEach(mode => {
      html += `<button class="pe-control-btn" data-action="ha-hvac-mode" data-node="${nodeKey}" data-mode="${mode}">${mode}</button>`;
    });
    html += '</div></div>';
  }

  // Speaker Controls
  if (nodeRole === 'speaker' && haInfo) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Media</div>';
    html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
    html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="previous">&#9198;</button>`;
    html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="play_pause">&#9199;</button>`;
    html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="next">&#9197;</button>`;
    html += '</div>';
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Volume</span>
      <input type="range" class="pe-control-slider" min="0" max="100" value="50" data-action="ha-volume" data-node="${nodeKey}">
    </div>`;
    html += '</div>';
  }

  // Vacuum Controls
  if (nodeRole === 'vacuum' && haInfo) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Vacuum</div>';
    html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
    html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="start">Start</button>`;
    html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="pause">Pause</button>`;
    html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="return_to_base">Dock</button>`;
    html += '</div></div>';
  }

  // Appliance Controls (generic on/off)
  if (nodeRole === 'appliance' && haInfo) {
    hasControls = true;
    const isOn = haInfo.sublabel && haInfo.sublabel.toLowerCase().includes('running');
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Appliance</div>';
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Status</span>
      <span style="color:${isOn ? '#60c060' : '#a89870'}">${haInfo.sublabel || 'Unknown'}</span>
    </div>`;
    html += '</div>';
  }

  // TV / Media Player Controls
  if (nodeRole === 'tv' && haInfo) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Media Player</div>';
    html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
    html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="turn_on">On</button>`;
    html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="turn_off">Off</button>`;
    html += '</div></div>';
  }

  // Network tools for any node with IP
  const ethernetRoles = ['server', 'desktop', 'laptop', 'nas', 'vm', 'router', 'ap', 'switch', 'bridge'];
  if (topoNode?.ip) {
    hasControls = true;
    html += '<div class="pe-control-section"><div class="pe-control-section-title">Network</div>';

    // Ping button
    html += `<div class="pe-control-row">
      <span class="pe-control-label">Ping</span>
      <button class="pe-control-btn" data-action="ping" data-ip="${topoNode.ip}">Test Connection</button>
    </div>`;

    // Wake-on-LAN for ethernet devices with MAC
    if (topoNode.mac && ethernetRoles.includes(nodeRole)) {
      html += `<div class="pe-control-row">
        <span class="pe-control-label">Wake-on-LAN</span>
        <button class="pe-control-btn" data-action="wol" data-mac="${topoNode.mac}" data-ip="${topoNode.ip}">Send Magic Packet</button>
      </div>`;
    }

    // SSH for infrastructure
    if (nodeRole === 'router' || nodeRole === 'ap' || nodeRole === 'server' || nodeRole === 'nas') {
      html += `<div class="pe-control-row">
        <span class="pe-control-label">SSH</span>
        <button class="pe-control-btn" data-action="ssh" data-ip="${topoNode.ip}">Connect</button>
      </div>`;
    }

    // Reboot for routers/APs (with confirmation)
    if (nodeRole === 'router' || nodeRole === 'ap') {
      html += `<div class="pe-control-row">
        <span class="pe-control-label">Reboot</span>
        <button class="pe-control-btn danger" data-action="reboot" data-ip="${topoNode.ip}">Restart Device</button>
      </div>`;
    }
    html += '</div>';
  }

  // No controls available
  if (!hasControls) {
    html = `<div class="pe-control-empty">No controls available for this ${nodeRole || 'node'}.</div>`;
  }

  body.innerHTML = html;

  // Wire up control event handlers
  body.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', handleControlAction);
    el.addEventListener('input', handleControlAction);
  });
}

// ── Group Tab (multi-device nodes) ──
export function renderGroupPane(nodeKey) {
  const body = document.getElementById('pe-group-body');
  const titleEl = document.getElementById('pe-group-title');
  const countEl = document.getElementById('pe-group-count');
  if (!body) return;

  const lastStatus = getLastStatus();
  const groupConfig = lastStatus?.groups?.[nodeKey];
  if (!groupConfig || !groupConfig.entities) {
    body.innerHTML = '<div class="pe-stats-empty">Not a group node.</div>';
    return;
  }

  const entities = groupConfig.entities;
  const fnType = groupConfig.fn || '';
  const also = groupConfig.also || [];

  // Get entity states from HA
  const info = infraNodes[nodeKey];
  const nodeName = info ? info.name : nodeKey;
  titleEl.textContent = nodeName + ' — Members';

  let html = '';
  let memberCount = 0;

  if (Array.isArray(entities)) {
    // Entity list (cameras, speakers, thermostats, switches)
    memberCount = entities.length;
    countEl.textContent = `${memberCount} members`;

    entities.forEach(eid => {
      const entityName = eid.split('.').pop().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const domain = eid.split('.')[0];

      // Build member row with live state from HA sublabel data
      html += `<div class="pe-group-member">`;
      html += `<div class="pe-group-member-icon">${_groupMemberIcon(domain, fnType)}</div>`;
      html += `<div class="pe-group-member-info">`;
      html += `<div class="pe-group-member-name">${entityName}</div>`;
      html += `<div class="pe-group-member-id">${eid}</div>`;
      html += `</div>`;
      html += `</div>`;
    });
  } else if (typeof entities === 'object') {
    // Named entity map (solar: {kw, grid_in, batt_v, ...})
    const keys = Object.entries(entities);
    memberCount = keys.length;
    countEl.textContent = `${memberCount} sensors`;

    keys.forEach(([label, eid]) => {
      const entityName = label.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      html += `<div class="pe-group-member">`;
      html += `<div class="pe-group-member-icon">\uD83D\uDCCA</div>`;
      html += `<div class="pe-group-member-info">`;
      html += `<div class="pe-group-member-name">${entityName}</div>`;
      html += `<div class="pe-group-member-id">${eid}</div>`;
      html += `</div>`;
      html += `</div>`;
    });
  }

  // Show "also" linked nodes
  if (also.length) {
    html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Linked Nodes</div>';
    also.forEach(nid => {
      const alsoNode = _nodeMap.get(nid);
      const label = alsoNode?.label || nid;
      html += `<div class="pe-group-member">`;
      html += `<div class="pe-group-member-icon">${alsoNode?.icon || '\u2753'}</div>`;
      html += `<div class="pe-group-member-info">`;
      html += `<div class="pe-group-member-name">${label}</div>`;
      html += `<div class="pe-group-member-id">${nid} (shares this group's state)</div>`;
      html += `</div>`;
      html += `</div>`;
    });
    html += '</div>';
  }

  body.innerHTML = html;
}

// ── Vassals Tab (discovered sub-entities) ──

const _vassalTypeLabels = {
  container: 'Iron Golems', vm: 'Ethereal Planes',
  service: 'Runic Wards', wifi_client: 'Wandering Spirits',
  snmp_port: 'Crystal Channels', reverse_proxy: 'Gate Wardens',
  ha_device: 'Enchanted Artifacts', collectd_host: 'Scrying Stones',
  local_project: 'Arcane Tomes',
};

const _vassalTypeIcons = {
  container: '\uD83E\uDDF1', vm: '\uD83C\uDF0C', service: '\uD83D\uDD2E',
  wifi_client: '\uD83D\uDC7B', snmp_port: '\uD83D\uDD2E', reverse_proxy: '\uD83D\uDEE1\uFE0F',
  ha_device: '\u2728', collectd_host: '\uD83D\uDD2D', local_project: '\uD83D\uDCDC',
};

function _vassalStatusClass(status) {
  return {
    running: 'vassal-up', stopped: 'vassal-down',
    failed: 'vassal-critical', stale: 'vassal-stale',
    connected: 'vassal-up', up: 'vassal-up', down: 'vassal-down',
  }[status] || 'vassal-unknown';
}

function _vassalStatusLabel(status) {
  return {
    running: 'Active', stopped: 'Dormant', failed: 'Fallen',
    stale: 'Fading', connected: 'Active', up: 'Active', down: 'Dormant',
  }[status] || 'Unknown';
}

export async function renderVassalsPane(nodeKey) {
  const body = document.getElementById('pe-vassals-body');
  const titleEl = document.getElementById('pe-vassals-title');
  const countEl = document.getElementById('pe-vassals-count');
  if (!body) return;

  const info = infraNodes[nodeKey];
  const nodeName = info ? info.name : nodeKey;
  titleEl.textContent = nodeName + ' \u2014 Vassals';

  body.textContent = '';
  const loadingDiv = document.createElement('div');
  loadingDiv.className = 'pe-control-empty';
  loadingDiv.textContent = 'Scrying for vassals\u2026';
  body.appendChild(loadingDiv);

  let data;
  try {
    const r = await fetch('/discovery/' + encodeURIComponent(nodeKey));
    if (!r.ok) { body.textContent = ''; const d = document.createElement('div'); d.className = 'pe-control-empty'; d.textContent = 'No vassals discovered.'; body.appendChild(d); countEl.textContent = ''; return; }
    data = await r.json();
  } catch {
    body.textContent = ''; const d = document.createElement('div'); d.className = 'pe-control-empty'; d.textContent = 'Failed to reach the discovery oracle.'; body.appendChild(d);
    countEl.textContent = '';
    return;
  }

  const entities = [...(data.host_entities || []), ...(data.linked_entities || [])];
  if (!entities.length) {
    body.textContent = ''; const d = document.createElement('div'); d.className = 'pe-control-empty'; d.textContent = 'No vassals discovered for this node.'; body.appendChild(d);
    countEl.textContent = '';
    return;
  }

  countEl.textContent = entities.length + ' vassal' + (entities.length !== 1 ? 's' : '');

  // Group by type
  const groups = {};
  for (const e of entities) {
    (groups[e.type] = groups[e.type] || []).push(e);
  }

  const frag = document.createDocumentFragment();
  for (const [type, items] of Object.entries(groups)) {
    const groupLabel = _vassalTypeLabels[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const icon = _vassalTypeIcons[type] || '\u2022';
    const groupEl = document.createElement('div');
    groupEl.className = 'vassal-group';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'vassal-group-title';
    titleDiv.textContent = icon + ' ' + groupLabel + ' ';
    const countSpan = document.createElement('span');
    countSpan.className = 'vassal-group-count';
    countSpan.textContent = '(' + items.length + ')';
    titleDiv.appendChild(countSpan);
    groupEl.appendChild(titleDiv);

    for (const ent of items) {
      const sc = _vassalStatusClass(ent.status);
      const sl = _vassalStatusLabel(ent.status);
      const isLinked = !!ent.linked_node_id;

      const row = document.createElement('div');
      row.className = 'vassal-row';
      row.dataset.vassalId = ent.id;

      const dot = document.createElement('span');
      dot.className = 'vassal-status-dot ' + sc;
      dot.title = sl;
      row.appendChild(dot);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'vassal-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'vassal-name';
      nameDiv.textContent = ent.name || ent.id;
      infoDiv.appendChild(nameDiv);
      if (ent.name && ent.name !== ent.id) {
        const idDiv = document.createElement('div');
        idDiv.className = 'vassal-id';
        idDiv.textContent = ent.id;
        infoDiv.appendChild(idDiv);
      }
      row.appendChild(infoDiv);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'vassal-actions';
      const actionBtn = document.createElement('button');
      actionBtn.className = 'pe-control-btn vassal-btn';
      actionBtn.dataset.vassalAction = isLinked ? 'unlink' : 'promote';
      actionBtn.dataset.vassalId = ent.id;
      actionBtn.title = isLinked ? 'Unlink from node' : 'Promote to map node';
      actionBtn.textContent = isLinked ? 'Unlink' : 'Promote';
      actionsDiv.appendChild(actionBtn);

      const expandBtn = document.createElement('button');
      expandBtn.className = 'vassal-expand-btn';
      expandBtn.dataset.vassalId = ent.id;
      expandBtn.title = 'Show details';
      expandBtn.textContent = '\u25B6';
      actionsDiv.appendChild(expandBtn);
      row.appendChild(actionsDiv);
      groupEl.appendChild(row);

      // Expandable metadata
      const meta = ent.metadata || {};
      const metaKeys = Object.keys(meta);
      if (metaKeys.length) {
        const metaDiv = document.createElement('div');
        metaDiv.className = 'vassal-meta';
        metaDiv.id = 'vassal-meta-' + ent.id;
        metaDiv.style.display = 'none';
        for (const [k, v] of Object.entries(meta)) {
          const metaRow = document.createElement('div');
          metaRow.className = 'vassal-meta-row';
          const keySpan = document.createElement('span');
          keySpan.className = 'vassal-meta-key';
          keySpan.textContent = k;
          const valSpan = document.createElement('span');
          valSpan.className = 'vassal-meta-val';
          valSpan.textContent = v;
          metaRow.appendChild(keySpan);
          metaRow.appendChild(valSpan);
          metaDiv.appendChild(metaRow);
        }
        groupEl.appendChild(metaDiv);
      }
    }
    frag.appendChild(groupEl);
  }

  body.textContent = '';
  body.appendChild(frag);

  // Wire event handlers via delegation
  body.addEventListener('click', async (e) => {
    // Expand/collapse metadata
    const expBtn = e.target.closest('.vassal-expand-btn');
    if (expBtn) {
      const vid = expBtn.dataset.vassalId;
      const metaEl = document.getElementById('vassal-meta-' + vid);
      if (metaEl) {
        const showing = metaEl.style.display !== 'none';
        metaEl.style.display = showing ? 'none' : '';
        expBtn.textContent = showing ? '\u25B6' : '\u25BC';
      }
      return;
    }

    // Promote / Unlink actions
    const actBtn = e.target.closest('[data-vassal-action]');
    if (!actBtn) return;
    const action = actBtn.dataset.vassalAction;
    const vassalId = actBtn.dataset.vassalId;
    actBtn.disabled = true;
    actBtn.textContent = '\u2026';
    try {
      const endpoint = action === 'promote' ? '/discovery/promote' : '/discovery/unlink';
      const payload = action === 'promote'
        ? { sub_entity_id: vassalId }
        : { sub_entity_id: vassalId };
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error((await r.json()).error || action + ' failed');
      renderVassalsPane(nodeKey);
    } catch (err) {
      actBtn.textContent = 'Error';
      actBtn.title = err.message;
      setTimeout(() => { actBtn.textContent = action === 'promote' ? 'Promote' : 'Unlink'; actBtn.disabled = false; }, 2000);
    }
  });
}

function _groupMemberIcon(domain, fnType) {
  const icons = {
    climate: '\uD83C\uDF21\uFE0F', camera: '\uD83D\uDCF9', media_player: '\uD83D\uDD0A',
    switch: '\uD83D\uDD0C', light: '\uD83D\uDCA1', fan: '\uD83C\uDF2C\uFE0F',
    vacuum: '\uD83E\uDD16', sensor: '\uD83D\uDCCA', binary_sensor: '\uD83D\uDCCA',
    humidifier: '\uD83D\uDCA7', select: '\u2699\uFE0F',
  };
  return icons[domain] || '\u2022';
}

async function handleControlAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;

  const action = el.dataset.action;
  const nodeKey = el.dataset.node;
  const statusEl = document.getElementById('pe-control-status');

  try {
    statusEl.textContent = 'Sending...';
    statusEl.style.color = '#c0a030';

    let endpoint, body;

    switch (action) {
      case 'wled-power': {
        const newState = el.dataset.state === 'on';
        endpoint = `/wled/${nodeKey}/state`;
        body = { on: newState };
        break;
      }
      case 'wled-brightness': {
        endpoint = `/wled/${nodeKey}/state`;
        body = { bri: parseInt(el.value) };
        // Update percentage display
        const pctSpan = el.nextElementSibling;
        if (pctSpan) pctSpan.textContent = Math.round(el.value / 255 * 100) + '%';
        break;
      }
      case 'wled-effect': {
        endpoint = `/wled/${nodeKey}/state`;
        body = { fx: parseInt(el.dataset.effect) };
        break;
      }
      case 'ha-switch': {
        const isOn = el.classList.contains('active');
        endpoint = `/ha/switch/${isOn ? 'off' : 'on'}`;
        body = { node: nodeKey };
        break;
      }
      case 'ping': {
        endpoint = `/ping/${el.dataset.ip}`;
        break;
      }
      case 'wol': {
        endpoint = `/wol`;
        body = { mac: el.dataset.mac, ip: el.dataset.ip };
        break;
      }
      case 'reboot': {
        if (!confirm(`Reboot ${nodeKey}? This will disconnect the device temporarily.`)) {
          statusEl.textContent = 'Cancelled';
          statusEl.style.color = '#a89870';
          return;
        }
        endpoint = `/ssh/${el.dataset.ip}/reboot`;
        break;
      }
      case 'ssh': {
        // Open SSH in new terminal (client-side only)
        statusEl.textContent = 'Opening terminal...';
        window.open(`ssh://${el.dataset.ip}`, '_blank');
        return;
      }
      default:
        statusEl.textContent = 'Unknown action';
        statusEl.style.color = '#c04040';
        return;
    }

    const resp = await fetch(endpoint, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });

    if (resp.ok) {
      statusEl.textContent = 'Done';
      statusEl.style.color = '#60a040';
      // Toggle visual state for toggles
      if (action === 'wled-power' || action === 'ha-switch') {
        el.classList.toggle('active');
      }
      // SSE will push updated status within ~10s
    } else {
      statusEl.textContent = 'Failed';
      statusEl.style.color = '#c04040';
    }
  } catch (err) {
    statusEl.textContent = 'Error';
    statusEl.style.color = '#c04040';
    console.error('Control action error:', err);
  }
}

// ── Shell Tab ──
// ── Connections (Links) Pane ──
const _linksBody = document.getElementById('pe-links-body');
const _linksTarget = document.getElementById('pe-links-target');
const _linksType = document.getElementById('pe-links-type');
const _linksVlan = document.getElementById('pe-links-vlan');

// Populate target dropdown once from topology
if (_topology) {
  _topology.nodes.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n.id;
    opt.textContent = `${n.label} (${n.id})`;
    _linksTarget.appendChild(opt);
  });
}

function _getNodeConns(nodeId) {
  if (!_topology) return [];
  return _topology.connections
    .map((c, i) => ({ ...c, _idx: i }))
    .filter(c => c.from === nodeId || c.to === nodeId);
}

function _nodeLabel(id) {
  const n = _nodeMap.get(id);
  return n ? n.label : id;
}

export function renderConnectionsPane(nodeKey) {
  if (!_linksBody) return;
  const conns = _getNodeConns(nodeKey);
  if (!conns.length) {
    _linksBody.innerHTML = '<div class="pe-link-empty">No connections bound to this node.</div>';
    return;
  }
  _linksBody.innerHTML = '';
  conns.forEach(c => {
    const row = document.createElement('div');
    row.className = 'pe-link-row';
    const isFrom = c.from === nodeKey;
    const other = isFrom ? c.to : c.from;
    row.innerHTML =
      `<span class="pe-link-dir">${isFrom ? '\u2192' : '\u2190'}</span>` +
      `<span class="pe-link-node" data-nav="${other}">${_nodeLabel(other)}</span>` +
      `<span class="pe-link-type">${c.type}</span>` +
      (c.vlan ? `<span class="pe-link-vlan">V${c.vlan}</span>` : '') +
      (c.collectd ? `<span class="pe-link-vlan">${c.collectd}</span>` : '') +
      `<button class="pe-link-del" data-idx="${c._idx}" title="Remove connection">\u00d7</button>`;
    _linksBody.appendChild(row);
  });

  // Click node name to navigate
  _linksBody.querySelectorAll('.pe-link-node').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.nav;
      const tn = _nodeMap.get(target);
      if (tn) { panToNode(tn.x, tn.y); openPersonaEditor(target); }
    });
  });

  // Delete button
  _linksBody.querySelectorAll('.pe-link-del').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx);
      const conn = _topology.connections[idx];
      if (!conn) return;
      _topology.connections.splice(idx, 1);
      // Remove SVG path
      if (_connPaths[idx]) { _connPaths[idx].remove(); _connPaths.splice(idx, 1); }
      _saveConnections();
      renderConnectionsPane(nodeKey);
    });
  });

  // Filter out self from target dropdown
  _linksTarget.querySelectorAll('option').forEach(o => o.hidden = o.value === nodeKey);
}

function _saveConnections() {
  if (!_topology) return;
  fetch('/connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connections: _topology.connections })
  });
}

document.getElementById('pe-links-add-btn').addEventListener('click', () => {
  const target = _linksTarget.value;
  if (!target || !getCurrentEditNode()) return;
  const type = _linksType.value;
  const vlan = _linksVlan.value ? parseInt(_linksVlan.value) : undefined;
  const conn = { from: getCurrentEditNode(), to: target, type };
  if (vlan) conn.vlan = vlan;
  _topology.connections.push(conn);
  // Add SVG path for new connection
  _addConnectionPath(conn, _topology.connections.length - 1);
  _saveConnections();
  renderConnectionsPane(getCurrentEditNode());
  _linksTarget.value = '';
});

function _addConnectionPath(c, idx) {
  const connSvg = document.getElementById('connection-svg');
  if (!connSvg) return;
  const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
  if (!fp || !tp) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', _computePathD(fp, tp, 0, 0, c.from, c.to));
  path.setAttribute('class', 'conn-line ' + (CONN_TYPE_TO_CLASS[c.type] || 'conn-active'));
  path.dataset.to = c.collectd || c.to;
  path.dataset.from = c.from;
  path.dataset.fromNode = c.from;
  path.dataset.toNode = c.to;
  connSvg.appendChild(path);
  _connPaths[idx] = path;
}

// ── Shell Pane ──
const _shellHistory = {};
const _shellOutput = document.getElementById('pe-shell-output');
const _shellInput = document.getElementById('pe-shell-input');

export function renderShellPane(nodeKey) {
  const info = infraNodes[nodeKey];
  _shellOutput.innerHTML = '';
  if (!info || !info.sshHost) {
    _shellOutput.innerHTML = '<div class="pe-shell-info">No SSH sigil bound to this node.</div>';
    _shellInput.disabled = true;
    _shellInput.placeholder = 'unavailable';
    return;
  }
  _shellInput.disabled = false;
  _shellInput.placeholder = `runs on ${info.sshHost}...`;
  // Restore history
  (_shellHistory[nodeKey] || []).forEach(e => _appendShellEntry(e));
  _shellOutput.scrollTop = _shellOutput.scrollHeight;
}

export function focusShellInput() {
  _shellInput?.focus();
}

function _appendShellEntry(entry) {
  const cmd = document.createElement('div');
  cmd.className = 'pe-shell-cmd';
  cmd.textContent = '$ ' + entry.cmd;
  _shellOutput.appendChild(cmd);
  if (entry.output) {
    const out = document.createElement('div');
    out.textContent = entry.output;
    _shellOutput.appendChild(out);
  }
  if (entry.error) {
    const err = document.createElement('div');
    err.className = 'pe-shell-err';
    err.textContent = entry.error;
    _shellOutput.appendChild(err);
  }
}

async function _runShellCmd(nodeKey, command) {
  const info = infraNodes[nodeKey];
  if (!info?.sshHost) return;
  // Show command
  const cmd = document.createElement('div');
  cmd.className = 'pe-shell-cmd';
  cmd.textContent = '$ ' + command;
  _shellOutput.appendChild(cmd);
  const spin = document.createElement('div');
  spin.className = 'pe-shell-running';
  spin.textContent = 'Invoking distant arcana...';
  _shellOutput.appendChild(spin);
  _shellOutput.scrollTop = _shellOutput.scrollHeight;
  _shellInput.disabled = true;

  try {
    const r = await fetch('/ssh', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ host: info.sshHost, command })
    });
    const d = await r.json();
    spin.remove();
    const entry = { cmd: command, output: d.output || '', error: d.error || null };
    if (entry.output) {
      const out = document.createElement('div');
      out.textContent = entry.output;
      _shellOutput.appendChild(out);
    }
    if (entry.error) {
      const err = document.createElement('div');
      err.className = 'pe-shell-err';
      err.textContent = entry.error;
      _shellOutput.appendChild(err);
    }
    (_shellHistory[nodeKey] ||= []).push(entry);
  } catch (e) {
    spin.remove();
    const err = document.createElement('div');
    err.className = 'pe-shell-err';
    err.textContent = 'Connection lost to the realm.';
    _shellOutput.appendChild(err);
  }
  _shellInput.disabled = false;
  _shellInput.focus();
  _shellOutput.scrollTop = _shellOutput.scrollHeight;
}

_shellInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.value.trim() && getCurrentEditNode()) {
    e.preventDefault();
    const cmd = e.target.value.trim();
    e.target.value = '';
    _runShellCmd(getCurrentEditNode(), cmd);
  }
});

// Click a node to open its URL in a new tab (delayed to avoid firing on double-click)
// Resolution chain: explicit url > cached resolve > server probe (hostname.jphe.in → hostname → hostname.local → ip → port scan)
let _apClickTimer = 0;
const _resolvedUrls = {};  // cache: nodeId → url
document.getElementById('map-world').addEventListener('click', e => {
  const node = e.target.closest('.realm-node');
  if (!node) return;
  const key = node.dataset.tip;
  if (!key || !_topology) return;
  const topoNode = _nodeMap.get(key);
  if (!topoNode) return;
  // Explicit url field — use directly
  if (topoNode.url) {
    clearTimeout(_apClickTimer);
    _apClickTimer = setTimeout(() => window.open(topoNode.url, '_blank'), 250);
    return;
  }
  // Cached resolved url
  if (_resolvedUrls[key]) {
    clearTimeout(_apClickTimer);
    _apClickTimer = setTimeout(() => window.open(_resolvedUrls[key], '_blank'), 250);
    return;
  }
  // Server-side probe with fallback chain
  const hostname = topoNode._hostname || topoNode.label || key;
  const ip = topoNode.ip || '';
  const services = (topoNode.tip?.stats?.find(s => s[0] === 'Services') || [])[1] || '';
  clearTimeout(_apClickTimer);
  _apClickTimer = setTimeout(() => {
    fetch(`/resolve-url?hostname=${encodeURIComponent(hostname)}&ip=${encodeURIComponent(ip)}&services=${encodeURIComponent(services)}`)
      .then(r => r.json())
      .then(data => {
        if (data.url) {
          _resolvedUrls[key] = data.url;
          window.open(data.url, '_blank');
        } else if (ip) {
          // Nothing resolved — last resort: raw IP
          _resolvedUrls[key] = `http://${ip}`;
          window.open(`http://${ip}`, '_blank');
        }
      })
      .catch(() => { if (ip) window.open(`http://${ip}`, '_blank'); });
  }, 250);
});

// Double-click a node to open persona editor (delegated — survives topology refresh)
document.getElementById('map-world').addEventListener('dblclick', e => {
  clearTimeout(_apClickTimer);
  const node = e.target.closest('.realm-node');
  if (!node) return;
  e.stopPropagation();
  const key = node.dataset.tip;
  if (key) openPersonaEditor(key);
});

// Panel minimize/seal handled entirely by panel-manager.js (dock system)

// ── Node Chat Dialog ──
let _chatDialog = null;
let _chatNodeId = null;
let _chatHistory = [];

function _createChatDialog() {
  if (_chatDialog) return _chatDialog;

  const dialog = document.createElement('div');
  dialog.id = 'node-chat-dialog';
  dialog.className = 'panel';
  dialog.innerHTML = `
    <div class="panel-header">
      <span class="panel-hdr-icon">&#128302;</span>
      <span class="panel-hdr-title" id="chat-dialog-title">Oracle Commune</span>
      <button class="panel-close" id="chat-close">&times;</button>
    </div>
    <div id="chat-messages"></div>
    <div class="chat-input-area">
      <textarea id="chat-input" placeholder="Speak to the oracle..."></textarea>
      <div class="chat-actions">
        <button id="chat-send" class="chat-btn chat-btn-send">Commune</button>
        <button id="chat-clear" class="chat-btn chat-btn-clear">Clear</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);

  // Close button — seal to dock (keeps rune for reopening)
  dialog.querySelector('#chat-close').addEventListener('click', () => {
    const sealBtn = dialog.querySelector('.panel-seal-btn');
    if (sealBtn) sealBtn.click();
    else dialog.classList.remove('open');
  });

  // Send button
  dialog.querySelector('#chat-send').addEventListener('click', sendChatMessage);

  // Enter to send (shift+enter for newline)
  dialog.querySelector('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Clear button
  dialog.querySelector('#chat-clear').addEventListener('click', async () => {
    try {
      await fetch('/chat/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: _chatNodeId ? `node-${_chatNodeId}` : null })
      });
      _chatHistory = [];
      dialog.querySelector('#chat-messages').innerHTML = '<div class="chat-msg-system">Session cleared. The oracle awaits.</div>';
    } catch (e) { /* silent */ }
  });

  // Register with panel manager (seal button, drag, dock)
  registerPanel(dialog);
  makeDraggable(dialog, '.panel-header', [160,120,255]);
  makeResizable(dialog, [160,120,255]);

  _chatDialog = dialog;
  return dialog;
}

export async function openNodeChat(nodeId, contextText, autoChat = true) {
  const dialog = _createChatDialog();
  _chatNodeId = nodeId;

  // Update title
  const node = document.querySelector(`[data-tip="${nodeId}"]`);
  const nodeName = node?.querySelector('.node-label')?.textContent || nodeId;
  dialog.querySelector('#chat-dialog-title').textContent = `Commune: ${nodeName}`;

  dialog.classList.add('open');

  // Load history for this node's session
  await _loadChatHistory(nodeId);

  // If we have context from a bubble, show it and auto-chat about it
  if (contextText && autoChat) {
    // Add the bubble message as context in the chat
    _chatHistory.push({ role: 'system', content: `[Event] ${contextText}` });
    _renderChatHistory();

    // Auto-send a follow-up question
    const input = dialog.querySelector('#chat-input');
    input.value = `Tell me more about this: "${contextText}"`;
    sendChatMessage();
  } else {
    dialog.querySelector('#chat-input').focus();
  }
}

async function _loadChatHistory(nodeId) {
  const dialog = _chatDialog;
  const messagesEl = dialog.querySelector('#chat-messages');
  messagesEl.innerHTML = '<div style="color:#808080;">Loading...</div>';

  try {
    const session = nodeId ? `node-${nodeId}` : null;
    const r = await fetch(`/chat/history${session ? `?session=${session}` : ''}`);
    const data = await r.json();
    _chatHistory = data.history || [];
    _renderChatHistory();
  } catch (e) {
    messagesEl.innerHTML = '<div style="color:#ff8080;">Failed to load history</div>';
  }
}

function _renderChatHistory() {
  const messagesEl = _chatDialog.querySelector('#chat-messages');
  if (_chatHistory.length === 0) {
    messagesEl.innerHTML = '<div class="chat-msg-system">No messages yet. Click a speech bubble or ask a question to commune.</div>';
    return;
  }
  messagesEl.innerHTML = _chatHistory.map(m => {
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';
    let cls, label;
    if (isSystem) { cls = 'chat-msg-system'; label = ''; }
    else if (isUser) { cls = 'chat-msg chat-msg-user'; label = 'You'; }
    else { cls = 'chat-msg chat-msg-oracle'; label = 'Oracle'; }
    if (isSystem) return `<div class="${cls}">${m.content}</div>`;
    return `<div class="${cls}"><span class="chat-msg-label">${label}</span>${m.content}</div>`;
  }).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendChatMessage() {
  const input = _chatDialog.querySelector('#chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  input.disabled = true;
  _chatDialog.querySelector('#chat-send').disabled = true;

  // Add user message to UI immediately
  _chatHistory.push({ role: 'user', content: message });
  _renderChatHistory();

  // Add typing indicator
  const messagesEl = _chatDialog.querySelector('#chat-messages');
  const loadingEl = document.createElement('div');
  loadingEl.className = 'chat-typing';
  loadingEl.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
  messagesEl.appendChild(loadingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const session = _chatNodeId ? `node-${_chatNodeId}` : null;
    const r = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        node: _chatNodeId,
        session
      })
    });
    const data = await r.json();

    loadingEl.remove();

    if (data.error) {
      _chatHistory.push({ role: 'assistant', content: `Error: ${data.error}` });
    } else if (data.response) {
      _chatHistory.push({ role: 'assistant', content: data.response });
    } else {
      _chatHistory.push({ role: 'assistant', content: '(Empty response from oracle)' });
    }
    _renderChatHistory();
  } catch (e) {
    loadingEl.remove();
    _chatHistory.push({ role: 'assistant', content: `Error: ${e.message}` });
    _renderChatHistory();
  } finally {
    input.disabled = false;
    _chatDialog.querySelector('#chat-send').disabled = false;
    input.focus();
  }
}

// Also wire up magical search to open chat
const _magicalSearchInput = document.getElementById('magical-search');
if (_magicalSearchInput) {
  _magicalSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      // Ctrl+Enter: send search text to oracle
      const query = _magicalSearchInput.value.trim();
      if (query) {
        openNodeChat(null, null);
        _chatDialog.querySelector('#chat-input').value = query;
        sendChatMessage();
        _magicalSearchInput.value = '';
      }
    }
  });
}
