// ── Main application module (terrain, UI, events, navigation, panels, effects, persistence) ──
// Imports from extracted modules
import { WORLD_W, WORLD_H, WORLD_SCALE, _isMobile, _cpuCores, _perfTier, setPerfTier, _PERF, _mapTilt, setMapTilt, SSE_URL } from './config.js';
import { scaleLabel, scaleColor, fmtBytes, fmtRate, scalePct } from './utils.js';
import { tips, _topology, infraNodes, isTS, CONN_TYPE_TO_CLASS, _tsHostMap, _vlanLabels, _connPaths, _nodeDOM, getNodeDOM, getNodeCenter, updateLinePositions, _getNodePos, _computePathD, refreshTopology, setTopologyRefreshHook, isClusterExpandable, toggleClusterExpand } from './topology.js';
import { saveFormation, unsealPanel, registerPanel } from './panel-manager.js';

// ── Dynamic Biome Terrain (generated from topology VLANs/zones) ──
let _biomeLandScale = 1.0, _biomeGlow = 1.0, _biomeRoads = 0.5, _biomePeaks = 0.5, _biomeGrid = 0.03;

const VLAN_BIOMES = {
  6:  { name:'Citadel',   land:'#141a28', glow:[240,216,144], accent:'#1a1810' },
  8:  { name:'Family',    land:'#1a1814', glow:[192,160,96],  accent:'#1a1510' },
  10: { name:'Enchanted', land:'#101a18', glow:[96,192,96],   accent:'#0a1a10' },
  11: { name:'Guest',     land:'#101620', glow:[100,160,220], accent:'#0c1420' },
  0:  { name:'Astral',    land:'#0e1028', glow:[144,96,192],  accent:'#0c0c20' },
};

function _nodeCenter(n) {
  const iw = n.iconStyle?.width ? parseInt(n.iconStyle.width) : 64;
  const ih = n.iconStyle?.height ? parseInt(n.iconStyle.height) : 64;
  return { x: n.x + iw / 2, y: n.y + ih / 2 };
}

export function generateTerrain() {
  if (!_topology) return;
  const el = document.getElementById('terrain-dynamic');
  if (!el) return;
  const W = WORLD_W, H = WORLD_H;

  // Assign nodes to VLANs from connection data (majority vote)
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const nodeVlan = {};
  for (const [id, cts] of Object.entries(vlanCounts)) {
    let best = 6, max = 0;
    for (const [v, c] of Object.entries(cts)) { if (c > max) { max = c; best = +v; } }
    nodeVlan[id] = best;
  }
  _topology.nodes.forEach(n => {
    if (!nodeVlan[n.id]) nodeVlan[n.id] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
  });

  // Group nodes by VLAN
  const groups = {};
  _topology.nodes.forEach(n => {
    const v = nodeVlan[n.id];
    if (!groups[v]) groups[v] = [];
    groups[v].push(n);
  });

  // Compute biome zones (centroid + bounding ellipse)
  const biomes = [];
  for (const [vlan, nodes] of Object.entries(groups)) {
    const theme = VLAN_BIOMES[vlan] || VLAN_BIOMES[6];
    let sx = 0, sy = 0;
    const pts = nodes.map(n => { const c = _nodeCenter(n); sx += c.x; sy += c.y; return c; });
    const cx = sx / pts.length, cy = sy / pts.length;
    let maxDx = 0, maxDy = 0;
    pts.forEach(p => { maxDx = Math.max(maxDx, Math.abs(p.x - cx)); maxDy = Math.max(maxDy, Math.abs(p.y - cy)); });
    const pad = 180 * _biomeLandScale;
    const rx = (maxDx * 1.2 + pad) * _biomeLandScale;
    const ry = (maxDy * 1.2 + pad) * _biomeLandScale;
    biomes.push({ vlan: +vlan, theme, cx, cy, rx: Math.max(rx, 250), ry: Math.max(ry, 200), nodes, pts });
  }
  biomes.sort((a, b) => (b.rx * b.ry) - (a.rx * a.ry)); // largest first

  // Build SVG content
  const g = _biomeGlow;
  let s = `<rect width="${W}" height="${H}" fill="#0a0a12"/>`;

  // ── Biome landmasses ──
  for (const b of biomes) {
    const { theme, cx, cy, rx, ry } = b;
    const [gr, gg, gb] = theme.glow;
    // Outer haze
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.4}" ry="${ry * 1.4}" fill="${theme.land}" filter="url(#terrain-blur-lg)" opacity="0.4"/>`;
    // Inner landmass
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${theme.accent}" opacity="0.6"/>`;
    // Radial glow
    if (g > 0) {
      s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="none" opacity="1">`;
      // Use inline radialGradient via style
      s += `</circle>`;
      s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="rgba(${gr},${gg},${gb},${0.12 * g})" filter="url(#terrain-blur-lg)"/>`;
    }
  }

  // ── Per-node glows (magical auras) ──
  if (g > 0) {
    for (const n of _topology.nodes) {
      const c = _nodeCenter(n);
      const v = nodeVlan[n.id];
      const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
      const [gr, gg, gb] = theme.glow;
      const r = n.type === 'core' ? 120 : n.type === 'tower' ? 70 : n.type === 'infra' ? 55 : n.type === 'bridge' ? 60 : 40;
      const op = n.type === 'core' ? 0.15 * g : 0.08 * g;
      s += `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="rgba(${gr},${gg},${gb},${op})" filter="url(#terrain-blur)"/>`;
    }
  }

  // ── Mountain peaks near core/infra nodes ──
  if (_biomePeaks > 0) {
    for (const n of _topology.nodes) {
      if (n.type !== 'core' && n.type !== 'infra') continue;
      const c = _nodeCenter(n);
      const sz = n.type === 'core' ? 60 : 35;
      const pk = _biomePeaks;
      // Generate deterministic mountain from node ID hash
      let hash = 0;
      for (let i = 0; i < n.id.length; i++) hash = ((hash << 5) - hash + n.id.charCodeAt(i)) | 0;
      const pts = [];
      const spikes = n.type === 'core' ? 6 : 4;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2 - Math.PI / 2;
        const r = sz * pk * (0.7 + ((hash >> (i * 3)) & 7) / 20);
        pts.push(`${(c.x + Math.cos(a) * r) | 0},${(c.y + Math.sin(a) * r) | 0}`);
      }
      s += `<polygon points="${pts.join(' ')}" fill="#1a2535" opacity="${0.4 * pk}"/>`;
      s += `<polygon points="${pts.join(' ')}" fill="none" stroke="rgba(160,140,100,${0.08 * pk})" stroke-width="1"/>`;
    }
  }

  // ── Roads along connections ──
  if (_biomeRoads > 0) {
    const nodeMap = {};
    _topology.nodes.forEach(n => { nodeMap[n.id] = n; });
    for (const c of _topology.connections) {
      const fn = nodeMap[c.from], tn = nodeMap[c.to];
      if (!fn || !tn) continue;
      const fp = _nodeCenter(fn), tp = _nodeCenter(tn);
      const mx = (fp.x + tp.x) / 2, my = (fp.y + tp.y) / 2;
      const v = c.vlan || nodeVlan[c.from] || 6;
      const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
      const [gr, gg, gb] = theme.glow;
      const op = (c.type === 'mesh' || c.type === 'portal') ? 0.03 : 0.06;
      s += `<path d="M${fp.x|0},${fp.y|0} Q${mx|0},${my|0} ${tp.x|0},${tp.y|0}" fill="none" stroke="rgba(${gr},${gg},${gb},${op * _biomeRoads})" stroke-width="${c.type === 'active' ? 3 : 2}"/>`;
    }
  }

  // ── Compass rose ──
  s += `<g transform="translate(180,${H - 200})" opacity="0.3">`;
  s += `<line x1="0" y1="-40" x2="0" y2="40" stroke="#a89870" stroke-width="1"/>`;
  s += `<line x1="-40" y1="0" x2="40" y2="0" stroke="#a89870" stroke-width="1"/>`;
  s += `<polygon points="0,-45 -6,-10 6,-10" fill="#f0d890"/>`;
  s += `<text x="0" y="-52" text-anchor="middle" fill="#f0d890" font-family="Cinzel,serif" font-size="12">N</text>`;
  s += `<text x="0" y="62" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">S</text>`;
  s += `<text x="52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">E</text>`;
  s += `<text x="-52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">W</text>`;
  s += `</g>`;

  // ── Grid lines ──
  if (_biomeGrid > 0) {
    s += `<g opacity="${_biomeGrid}" stroke="#a89870" stroke-width="0.5">`;
    for (let y = 400; y < H; y += 400) s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    for (let x = 600; x < W; x += 600) s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
    s += `</g>`;
  }

  el.innerHTML = s;
}

// ── Dynamic Region Labels (computed from VLAN node clusters) ──
const VLAN_REGION_LABELS = {
  6:  { label: 'The Citadel',           color: 'rgba(240,216,144,0.22)', spacing: 6 },
  8:  { label: 'The Family Hearth',     color: 'rgba(192,160,96,0.22)',  spacing: 5 },
  10: { label: 'The Enchanted Quarters', color: 'rgba(96,192,96,0.22)',  spacing: 5 },
  11: { label: 'The Guest Marches',     color: 'rgba(100,160,220,0.22)', spacing: 4 },
  0:  { label: 'The Astral Sea',        color: 'rgba(144,96,192,0.22)',  spacing: 5 },
};

// Sub-region labels for VLAN 6 (the largest group), split by node type
const CITADEL_SUBLABELS = {
  core:   { label: 'The Inner Keep',      fontSize: 14, color: 'rgba(240,216,144,0.18)', spacing: 4 },
  tower:  { label: 'The Guardian Towers',  fontSize: 13, color: 'rgba(192,144,96,0.18)',  spacing: 3 },
  bridge: { label: 'The Signal Bridges',   fontSize: 13, color: 'rgba(144,96,192,0.18)',  spacing: 3 },
  infra:  { label: 'The Deep Forges',      fontSize: 13, color: 'rgba(160,140,100,0.18)', spacing: 3 },
};

export function updateRegionLabels() {
  if (!_topology) return;
  const rc = document.getElementById('region-labels');
  if (!rc) return;
  rc.innerHTML = '';

  // Reuse VLAN assignment logic from generateTerrain
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const nodeVlan = {};
  for (const [id, cts] of Object.entries(vlanCounts)) {
    let best = 6, max = 0;
    for (const [v, c] of Object.entries(cts)) { if (c > max) { max = c; best = +v; } }
    nodeVlan[id] = best;
  }
  _topology.nodes.forEach(n => {
    if (!nodeVlan[n.id]) nodeVlan[n.id] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
  });

  // Group by VLAN
  const groups = {};
  _topology.nodes.forEach(n => {
    const v = nodeVlan[n.id];
    if (!groups[v]) groups[v] = [];
    groups[v].push(n);
  });

  // Place main VLAN region label above each cluster centroid
  for (const [vlan, nodes] of Object.entries(groups)) {
    const cfg = VLAN_REGION_LABELS[vlan] || VLAN_REGION_LABELS[6];
    const { cx, cy, minY } = _clusterBounds(nodes);
    _addRegionLabel(rc, cfg.label, cx, minY - 55, {
      fontSize: 18, color: cfg.color, spacing: cfg.spacing, rotate: 0
    });

    // Sub-labels for VLAN 6 (split by node type)
    if (+vlan === 6) {
      const byType = {};
      nodes.forEach(n => {
        const t = n.type || 'device';
        if (!byType[t]) byType[t] = [];
        byType[t].push(n);
      });
      for (const [type, typeNodes] of Object.entries(byType)) {
        const sub = CITADEL_SUBLABELS[type];
        if (!sub || typeNodes.length < 2) continue;
        const tb = _clusterBounds(typeNodes);
        _addRegionLabel(rc, sub.label, tb.cx, tb.minY - 35, {
          fontSize: sub.fontSize, color: sub.color, spacing: sub.spacing, rotate: 0
        });
      }
    }
  }

  // Reapply globe Z if tilted
  if (_mapTilt > 0) {
    const peakH = _mapTilt * 5;
    const counterRot = `x ${-_mapTilt}deg`;
    rc.style.translate = `0px 0px ${peakH * 0.7}px`;
    rc.style.rotate = counterRot;
  }
}

function _clusterBounds(nodes) {
  let sx = 0, sy = 0, minY = Infinity;
  const pts = nodes.map(n => {
    const c = _nodeCenter(n);
    sx += c.x; sy += c.y;
    if (c.y < minY) minY = c.y;
    return c;
  });
  return { cx: sx / pts.length, cy: sy / pts.length, minY, pts };
}

function _addRegionLabel(container, text, x, y, opts) {
  const el = document.createElement('div');
  el.className = 'region-label';
  let s = `left:${x}px;top:${y}px;transform:translateX(-50%)`;
  if (opts.rotate) s += ` rotate(${opts.rotate}deg)`;
  s += ';';
  if (opts.fontSize) s += `font-size:${opts.fontSize}px;`;
  if (opts.color) s += `color:${opts.color};`;
  if (opts.spacing) s += `letter-spacing:${opts.spacing}px;`;
  el.setAttribute('style', s);
  el.textContent = text;
  container.appendChild(el);
}

// Generate terrain + region labels after topology is rendered
generateTerrain();
updateRegionLabels();

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



// ── Update the UI from live data ──
let lastStatus = null;
let liveOk = false;
let _lastReportTs = 0;
let _dbgRefreshTimer = null;

function updateGauges(d) {
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

function updateLatencyPanel() {
  const body = document.getElementById('latency-body');
  const summary = document.getElementById('latency-summary');
  if (!body || !_latencyMap) return;
  const panel = document.getElementById('latency-panel');
  if (!panel || panel.style.display === 'none') return;

  const nodes = _buildNodeLookup();
  const entries = Object.entries(_latencyMap).sort((a, b) => a[1] - b[1]);
  if (!entries.length) { body.textContent = 'Probing...'; return; }

  // Summary
  const rtts = entries.map(e => e[1]);
  const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length;
  const max = rtts[rtts.length - 1];
  if (summary) summary.textContent = `${entries.length} nodes \u2022 avg ${avg.toFixed(1)}ms`;

  // Group by VLAN
  const groups = {};
  const tsGroup = [];
  for (const [id, rtt] of entries) {
    const n = nodes[id];
    const ip = n?.ip || '';
    const parts = ip.split('.');
    if (id.startsWith('ts-')) {
      tsGroup.push([id, rtt, n]);
    } else if (parts.length === 4) {
      const vlan = parseInt(parts[2]);
      if (!groups[vlan]) groups[vlan] = [];
      groups[vlan].push([id, rtt, n]);
    } else {
      if (!groups[0]) groups[0] = [];
      groups[0].push([id, rtt, n]);
    }
  }

  const frag = document.createDocumentFragment();
  const vlanOrder = [6, 8, 10, 11];
  for (const vlan of vlanOrder) {
    const items = groups[vlan];
    if (!items) continue;
    const title = document.createElement('div');
    title.className = 'latency-group-title';
    title.textContent = _vlanNames[vlan] || `VLAN ${vlan}`;
    frag.appendChild(title);
    for (const [id, rtt, n] of items) {
      frag.appendChild(_makeLatencyRow(id, rtt, n, max));
    }
  }
  // Other VLANs
  for (const vlan of Object.keys(groups).map(Number).sort()) {
    if (vlanOrder.includes(vlan) || vlan === 0) continue;
    const items = groups[vlan];
    const title = document.createElement('div');
    title.className = 'latency-group-title';
    title.textContent = `VLAN ${vlan}`;
    frag.appendChild(title);
    for (const [id, rtt, n] of items) {
      frag.appendChild(_makeLatencyRow(id, rtt, n, max));
    }
  }
  // Tailscale
  if (tsGroup.length) {
    const title = document.createElement('div');
    title.className = 'latency-group-title';
    title.textContent = 'Tailscale';
    frag.appendChild(title);
    for (const [id, rtt, n] of tsGroup) {
      frag.appendChild(_makeLatencyRow(id, rtt, n, max));
    }
  }
  // Unknown
  if (groups[0]) {
    const title = document.createElement('div');
    title.className = 'latency-group-title';
    title.textContent = 'Other';
    frag.appendChild(title);
    for (const [id, rtt, n] of groups[0]) {
      frag.appendChild(_makeLatencyRow(id, rtt, n, max));
    }
  }

  body.textContent = '';
  body.appendChild(frag);
}

function _makeLatencyRow(id, rtt, n, maxRtt) {
  const row = document.createElement('div');
  row.className = 'latency-row';
  const hue = _latencyHue(rtt);
  const pct = Math.min(rtt / Math.max(maxRtt, 1) * 100, 100);
  row.innerHTML = `<span class="latency-icon">${n?.icon || '?'}</span>`
    + `<span class="latency-label">${n?.label || id}</span>`
    + `<span class="latency-bar"><span class="latency-fill" style="width:${pct}%;background:hsl(${hue},70%,50%)"></span></span>`
    + `<span class="latency-val">${rtt < 1 ? rtt.toFixed(2) : rtt.toFixed(1)} ms</span>`;
  return row;
}

// ── Firewall Panel ──
const _vlanIfaceMap = {
  '3': 'br-lan.3', '4': 'br-lan.4', '5': 'br-lan.5', '6': 'br-lan.6',
  '7': 'br-lan.7', '8': 'br-lan.8', '9': 'br-lan.9', '10': 'br-lan.10',
  '11': 'br-lan.11', '12': 'br-lan.12', '20': 'br-lan.20', '38': 'br-lan.38',
};
let _fwData = null;
let _fwFetchTimer = null;

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
function updateFirewallPanel(d) {
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

// Fetch firewall data on load and every 60s
setTimeout(() => { _fetchFirewall(); _fwFetchTimer = setInterval(_fetchFirewall, 60000); }, 3000);

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

// Fetch on load and every 2 minutes
setTimeout(() => { _fetchWifiAPs(); setInterval(_fetchWifiAPs, 120000); }, 4000);

function updateCoreSublabels(d) {
  const { forge, mana, essence, astral } = d;
  const gpu = forge.gpu;
  const gpuLoad = gpu ? gpu.load : 0;
  const gpuTemp = gpu ? gpu.temp : null;

  const forgeN = getNodeDOM('forge');
  if (forgeN.sub) {
    const tempStr = forge.temp != null ? forge.temp.toFixed(0) + '\u00B0C' : '?';
    forgeN.sub.textContent = `CPU ${tempStr} \u2022 Scale ${forge.scale >= 0 ? '+' : ''}${forge.scale.toFixed(1)}`;
  }
  if (forgeN.bar) forgeN.bar.style.width = scalePct(forge.scale) + '%';

  const gpuN = getNodeDOM('gpu');
  if (gpuN.sub) {
    const tStr = gpuTemp != null ? gpuTemp.toFixed(0) + '\u00B0C' : '?';
    gpuN.sub.textContent = `${tStr} \u2022 ${gpuLoad.toFixed(0)}% load`;
  }

  const manaN = getNodeDOM('mana');
  if (manaN.sub) manaN.sub.textContent = `${mana.usage.toFixed(1)}% used \u2022 Scale ${mana.scale >= 0 ? '+' : ''}${mana.scale.toFixed(1)}`;
  if (manaN.bar) manaN.bar.style.width = scalePct(mana.scale) + '%';

  const essN = getNodeDOM('essence');
  if (essN.sub) essN.sub.textContent = `${essence.plugged ? 'Eternal Source' : 'Untethered'} \u2022 ${essence.usage.toFixed(0)}%`;
  if (essN.bar) essN.bar.style.width = scalePct(essence.scale) + '%';

  const katN = getNodeDOM('katana');
  if (katN.bar) katN.bar.style.width = scalePct(d.realm_scale) + '%';

  const wanN = getNodeDOM('wan');
  if (wanN.sub && astral.nft) wanN.sub.textContent = fmtBytes(astral.nft.wan) + ' traversed';

  const gkN = getNodeDOM('gatekeeper');
  if (gkN.sub) gkN.sub.textContent = astral.nodes.gatekeeper ? 'OpenWrt Router \u2022 10.0.6.1' : 'SILENT \u2022 10.0.6.1';
  if (gkN.pulse) gkN.pulse.style.display = astral.nodes.gatekeeper ? '' : 'none';

  const oN = getNodeDOM('oracle');
  if (oN.sub) oN.sub.textContent = astral.nodes.oracle ? 'ubox0 \u2022 10.0.6.11' : 'SILENT \u2022 10.0.6.11';
  if (oN.pulse) oN.pulse.style.display = astral.nodes.oracle ? '' : 'none';
}

function findStatusKey(nodeStatus, tipKey) {
  return Object.keys(nodeStatus).find(k => k.toLowerCase() === tipKey.toLowerCase())
    || Object.keys(nodeStatus).find(k => k.replace(/-/g, '').toLowerCase() === tipKey.replace(/-/g, '').toLowerCase());
}

function findCollectd(collectd, tipKey, statusKey) {
  const info = infraNodes[tipKey];
  if (info && info.collectdHost && collectd[info.collectdHost]) return collectd[info.collectdHost];
  return collectd[statusKey || tipKey] || collectd[tipKey]
    || Object.values(collectd).find(c => c.hostname && c.hostname.toLowerCase().replace(/[-_]/g, '') === tipKey.toLowerCase().replace(/[-_]/g, ''));
}

function buildCollectdExtra(cd) {
  const extra = [];
  if (cd.load_1 != null) extra.push(["Load", `${cd.load_1.toFixed(2)} / ${(cd.load_5 || 0).toFixed(2)} / ${(cd.load_15 || 0).toFixed(2)}`]);
  if (cd.mem_pct != null) extra.push(["Memory", `${cd.mem_pct}% of ${cd.mem_total_mb || '?'} MB`]);
  if (cd.cpu_cores) extra.push(["CPU Cores", cd.cpu_cores]);
  if (cd.temp != null) extra.push(["Temp", cd.temp + "\u00B0C"]);
  if (cd.uptime != null) {
    const days = Math.floor(cd.uptime / 86400);
    const hrs = Math.floor((cd.uptime % 86400) / 3600);
    extra.push(["Uptime", days > 0 ? `${days}d ${hrs}h` : `${hrs}h`]);
  }
  if (cd.conntrack) extra.push(["Conntrack", cd.conntrack.toLocaleString()]);
  if (cd.dhcp_leases) extra.push(["DHCP Leases", cd.dhcp_leases]);
  if (cd.ping) Object.entries(cd.ping).forEach(([t, ms]) => extra.push(["Ping " + t, ms + " ms"]));
  if (cd.disk_pct != null) extra.push(["Disk", `${cd.disk_pct}% of ${cd.disk_total_gb} GB`]);
  if (cd.swap_used != null && cd.swap_used > 0) extra.push(["Swap", `${(cd.swap_used / 1048576).toFixed(0)} MB`]);
  if (cd.procs_running) extra.push(["Processes", cd.procs_running + " running"]);
  if (cd.interfaces) {
    Object.entries(cd.interfaces)
      .map(([name, v]) => [name, (v.rx_bps || 0) + (v.tx_bps || 0)])
      .sort((a, b) => b[1] - a[1]).slice(0, 2)
      .forEach(([name, total]) => {
        if (total > 0) {
          const iface = cd.interfaces[name];
          extra.push([name, `\u2193${fmtRate(iface.rx_bps)} \u2191${fmtRate(iface.tx_bps)}`]);
        }
      });
  }
  return extra;
}

function updateInfraNodes(d) {
  const nodeStatus = d.astral.nodes || {};
  let towersOnline = 0, towersTotal = 0;

  Object.entries(infraNodes).forEach(([tipKey, info]) => {
    const n = getNodeDOM(tipKey);
    const statusKey = findStatusKey(nodeStatus, tipKey);
    const online = statusKey ? nodeStatus[statusKey] : false;

    if (n.sub) n.sub.textContent = online ? `Online \u2022 ${info.ip}` : `Offline \u2022 ${info.ip}`;
    if (n.pulse) n.pulse.style.display = online ? '' : 'none';
    if (n.el) n.el.style.opacity = online ? '1' : '0.35';

    if (n.isTower) { towersTotal++; if (online) towersOnline++; }

    if (d.collectd && tips[tipKey]) {
      const cd = findCollectd(d.collectd, tipKey, statusKey);
      if (cd) {
        const extra = buildCollectdExtra(cd);
        const base = tips[tipKey].stats.filter(s => ["Model", "IP", "OS", "Role", "Service", "Hostname"].includes(s[0]));
        tips[tipKey].stats = [...base, ...extra, ['Status', online ? 'Online' : 'Offline']];
        if (n.sub && cd.load_1 != null) {
          const memStr = cd.mem_pct != null ? ` \u2022 ${cd.mem_pct}%` : '';
          n.sub.textContent = `Load ${cd.load_1.toFixed(2)}${memStr} \u2022 ${info.ip}`;
        }
      }
    }
    if (tips[tipKey]) {
      const stats = tips[tipKey].stats;
      if (!stats.some(s => s[0] === 'Status')) stats.push(['Status', online ? 'Online' : 'Offline']);
    }
  });

  DOM.towersOnline.textContent = towersOnline;
  DOM.towersTotal.textContent = towersTotal;
}

function updateHASublabels(d) {
  const ha = d.ha;
  if (!ha) return;
  for (const [nodeId, info] of Object.entries(ha)) {
    const n = getNodeDOM(nodeId);
    if (n.sub) n.sub.textContent = info.sublabel;
    // Also inject into tooltip
    if (tips[nodeId]) {
      const existing = tips[nodeId].stats.filter(s => s[0] !== 'HA Status');
      existing.push(['HA Status', info.sublabel]);
      tips[nodeId].stats = existing;
    }
  }
}

function updateTooltips(d) {
  const { forge, mana, essence, astral } = d;
  const gpu = forge.gpu;
  const ts = d.tailscale;
  const tsOnline = ts ? ts.online_count : '?';
  const tsTotal = ts ? ts.total : '?';

  const katCd = d.collectd && Object.values(d.collectd).find(c => c.hostname && c.hostname.includes('katana'));
  tips.katana.stats = [
    ["Role", "Primary Server (Self)"], ["IP", "10.0.6.129"],
    ["Status", astral.nodes.katana ? "Online \u2014 Unsheathed" : "OFFLINE"],
    ["Tailscale", `${tsOnline} online / ${tsTotal} total`],
  ];
  if (katCd) {
    if (katCd.load_1 != null) tips.katana.stats.push(["Load", `${katCd.load_1.toFixed(2)} / ${(katCd.load_5 || 0).toFixed(2)} / ${(katCd.load_15 || 0).toFixed(2)}`]);
    if (katCd.disk_pct != null) tips.katana.stats.push(["Disk", `${katCd.disk_pct}% of ${katCd.disk_total_gb} GB`]);
    if (katCd.procs_running) tips.katana.stats.push(["Processes", katCd.procs_running + " running"]);
    if (katCd.uptime) { const ud = Math.floor(katCd.uptime / 86400); tips.katana.stats.push(["Uptime", ud + "d"]); }
  }

  const gkCd = d.collectd && d.collectd['gatekeeper'];
  tips.gatekeeper.stats = [
    ["Role", "OpenWrt Router / Firewall"], ["IP", "10.0.6.1"],
    ["WAN Traffic", astral.nft ? fmtBytes(astral.nft.wan) : "N/A"],
    ["LAN Traffic", astral.nft ? fmtBytes(astral.nft.lan) : "N/A"],
    ["Status", astral.nodes.gatekeeper ? "Standing Watch" : "Silent"],
  ];
  if (gkCd) {
    if (gkCd.load_1 != null) tips.gatekeeper.stats.push(["Load", `${gkCd.load_1.toFixed(2)} / ${(gkCd.load_5 || 0).toFixed(2)}`]);
    if (gkCd.mem_pct != null) tips.gatekeeper.stats.push(["Memory", `${gkCd.mem_pct}%`]);
    if (gkCd.temp != null) tips.gatekeeper.stats.push(["Temp", gkCd.temp + "\u00B0C"]);
    if (gkCd.conntrack) tips.gatekeeper.stats.push(["Conntrack", gkCd.conntrack.toLocaleString()]);
    if (gkCd.dhcp_leases) tips.gatekeeper.stats.push(["DHCP Leases", gkCd.dhcp_leases]);
    if (gkCd.ping) Object.entries(gkCd.ping).forEach(([t, ms]) => tips.gatekeeper.stats.push(["Ping " + t, ms + " ms"]));
    if (gkCd.uptime) { const ud = Math.floor(gkCd.uptime / 86400); tips.gatekeeper.stats.push(["Uptime", ud + "d"]); }
  }

  tips.oracle.stats = [["Role", "Network Monitor"], ["Hostname", "ubox0"], ["IP", "10.0.6.11"], ["Status", astral.nodes.oracle ? "Pulsing" : "Silent"]];
  tips.forge.stats = [["Usage", forge.usage.toFixed(1) + "%"], ["Temperature", forge.temp != null ? forge.temp.toFixed(0) + "\u00B0C" : "N/A"], ["Scale", `${forge.scale >= 0 ? '+' : ''}${forge.scale.toFixed(1)} (${scaleLabel(forge.scale)})`], ["Reading", forge.msg]];
  tips.mana.stats = [["Usage", mana.usage.toFixed(1) + "%"], ["Scale", `${mana.scale >= 0 ? '+' : ''}${mana.scale.toFixed(1)} (${scaleLabel(mana.scale)})`], ["Reading", mana.msg]];
  tips.gpu.stats = gpu ? [["Temperature", gpu.temp.toFixed(0) + "\u00B0C"], ["Load", gpu.load.toFixed(0) + "%"]] : [["Status", "No GPU detected"]];
  tips.essence.stats = [["Charge", essence.usage.toFixed(0) + "%"], ["Source", essence.plugged ? "Eternal Source (plugged)" : "Untethered"], ["Scale", `${essence.scale >= 0 ? '+' : ''}${essence.scale.toFixed(1)} (${scaleLabel(essence.scale)})`]];
  tips.wan.stats = [["Total Traversed", astral.nft ? fmtBytes(astral.nft.wan) : "N/A"], ["Direction", "Outward \u2014 to the Outer Darkness"], ["Guarded By", "The Gatekeeper (nftables)"]];

  // Tailscale per-peer tooltips (merge with existing collectd stats)
  const _tsKeys = new Set(["TS IP", "OS", "Link", "TS Traffic", "Exit Node", "Last Seen", "Key Expiry"]);
  const tsPeers = ts && ts.peers ? ts.peers : {};
  Object.entries(_tsHostMap).forEach(([host, nodeId]) => {
    const p = tsPeers[host];
    if (!tips[nodeId]) return;
    // Keep existing stats (including collectd), strip stale TS fields
    const existing = tips[nodeId].stats.filter(s => !_tsKeys.has(s[0]));
    if (!p) return;
    const tsStats = [];
    if (p.ip) tsStats.push(["TS IP", p.ip]);
    if (p.os) tsStats.push(["OS", p.os]);
    if (p.curAddr) tsStats.push(["Link", "Direct \u2014 " + p.curAddr]);
    else if (p.online && p.relay) tsStats.push(["Link", "Relayed via " + p.relay.toUpperCase()]);
    if (p.tx || p.rx) tsStats.push(["TS Traffic", "\u2191 " + fmtBytes(p.tx) + " \u2193 " + fmtBytes(p.rx)]);
    if (p.exitNode) tsStats.push(["Exit Node", "Yes"]);
    if (p.lastSeen && !p.online) {
      const ago = Date.now() - new Date(p.lastSeen).getTime();
      const days = Math.floor(ago / 86400000);
      tsStats.push(["Last Seen", days > 0 ? days + "d ago" : "recently"]);
    }
    if (p.keyExpiry) {
      const exp = new Date(p.keyExpiry);
      const daysLeft = Math.floor((exp - Date.now()) / 86400000);
      tsStats.push(["Key Expiry", daysLeft > 0 ? daysLeft + "d" : "EXPIRED"]);
    }
    tips[nodeId].stats = [...existing, ...tsStats];
  });
}

export function updateUI(d) {
  lastStatus = d;
  updateGauges(d);
  updateCoreSublabels(d);
  updateInfraNodes(d);
  updateHASublabels(d);
  updateTooltips(d);

  // Periodic status report to quest log (every 60s)
  if (Date.now() - _lastReportTs > 60000) {
    _lastReportTs = Date.now();
    const { forge, mana } = d;
    addLogEntry({
      type: 'report', node: 'katana',
      text: `Forge ${forge.usage.toFixed(0)}% \u2022 Mana ${mana.usage.toFixed(0)}% \u2022 Towers ${DOM.towersOnline.textContent}/${DOM.towersTotal.textContent} \u2022 Scale ${d.realm_scale >= 0 ? '+' : ''}${d.realm_scale.toFixed(1)}`,
      ts: Date.now() / 1000
    });
  }

  // Codex stats
  if (d.collectd && DOM.codexCd) DOM.codexCd.textContent = Object.keys(d.collectd).length;
  if (DOM.codexNodes) DOM.codexNodes.textContent = _topology.nodes ? _topology.nodes.length : '?';

  // When SSE is active, traffic updates come via the 'traffic' event -- skip here
  if (!_sseTrafficMap) {
    updateConnectionTraffic(d.collectd);
    _lastTopoCollectd = d.collectd;
    if (_topoEnabled) renderTopoLayer(d.collectd);
  }
  updateNodeListStatus(d);
  updateCensusSubLabels(d);
  updateLatencyPanel();
  updateFirewallPanel(d);
  firePulse();
  // Debounced debug panel refresh
  clearTimeout(_dbgRefreshTimer);
  _dbgRefreshTimer = setTimeout(_dbgRefresh, 200);
}

// ── Master scale slider (multiplies node, text, bubble) ──
let masterScale = 1.0;
const masterSlider = document.getElementById('master-scale-slider');
const masterScaleVal = document.getElementById('master-scale-val');

function applyMasterScale() {
  // Drive each sub-slider's effective value = base * master
  nodeScaleSlider.dispatchEvent(new Event('input'));
  textScaleSlider.dispatchEvent(new Event('input'));
  bubbleScaleSlider.dispatchEvent(new Event('input'));
}
masterSlider.addEventListener('input', () => {
  masterScale = parseFloat(masterSlider.value);
  masterScaleVal.textContent = masterScale.toFixed(1) + 'x';
  applyMasterScale();
  scheduleSave();
});

// ── Traffic scale slider ──
let trafficScale = 1.0;
const trafficSlider = document.getElementById('traffic-scale-slider');
const trafficScaleVal = document.getElementById('traffic-scale-val');
trafficSlider.addEventListener('input', () => {
  trafficScale = parseFloat(trafficSlider.value);
  trafficScaleVal.textContent = trafficScale.toFixed(1) + 'x';
  if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
  else if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
  scheduleSave();
});

// ── Node scale slider ──
let nodeScale = 1.0;
const nodeScaleSlider = document.getElementById('node-scale-slider');
const nodeScaleVal = document.getElementById('node-scale-val');
let _nodeScaleRaf = false;
nodeScaleSlider.addEventListener('input', () => {
  nodeScale = parseFloat(nodeScaleSlider.value) * masterScale;
  nodeScaleVal.textContent = nodeScale.toFixed(1) + 'x';
  if (!_nodeScaleRaf) {
    _nodeScaleRaf = true;
    requestAnimationFrame(() => {
      _nodeScaleRaf = false;
      document.querySelectorAll('.realm-node').forEach(node => {
        node.style.transform = `scale(${nodeScale})`;
      });
      updateLinePositions();
    });
  }
  scheduleSave();
});

// ── Text scale slider ──
let textScale = 1.0;
const textScaleSlider = document.getElementById('text-scale-slider');
const textScaleVal = document.getElementById('text-scale-val');
let _textScaleRaf = false;
textScaleSlider.addEventListener('input', () => {
  textScale = parseFloat(textScaleSlider.value) * masterScale;
  textScaleVal.textContent = textScale.toFixed(1) + 'x';
  if (!_textScaleRaf) {
    _textScaleRaf = true;
    requestAnimationFrame(() => {
      _textScaleRaf = false;
      document.documentElement.style.setProperty('--text-scale', textScale);
      document.querySelectorAll('.node-label').forEach(el => {
        el.style.transform = `scale(${textScale})`;
      });
      document.querySelectorAll('.node-sublabel').forEach(el => {
        el.style.transform = `scale(${textScale})`;
      });
      document.querySelectorAll('.vlan-label').forEach(el => {
        el.style.transform = `translate(-50%, -100%) scale(${textScale})`;
      });
      document.querySelectorAll('.region-label').forEach(el => {
        el.style.transform = `rotate(${el.dataset.rotate || 0}deg) scale(${textScale})`;
      });
    });
  }
  scheduleSave();
});

// ── Bubble scale slider ──
let bubbleScale = 1.0;
const bubbleScaleSlider = document.getElementById('bubble-scale-slider');
const bubbleScaleVal = document.getElementById('bubble-scale-val');
bubbleScaleSlider.addEventListener('input', () => {
  bubbleScale = parseFloat(bubbleScaleSlider.value) * masterScale;
  bubbleScaleVal.textContent = bubbleScale.toFixed(1) + 'x';
  document.documentElement.style.setProperty('--bubble-scale', bubbleScale);
  scheduleSave();
});

// ── Update speed slider ──
// TODO: Repurpose slider — SSE replaced polling, so this no longer controls refresh rate.
// Could send desired tick rate to SSE broker or adjust client-side animation speed.
const updateSpeedSlider = document.getElementById('update-speed-slider');
const updateSpeedVal = document.getElementById('update-speed-val');

// ── Connection traffic animation ──
// Color bases for each connection type (r,g,b)
const connColors = {
  'conn-active': [100,180,255], 'conn-ap': [100,180,255], 'conn-wan': [255,180,50],
  'conn-infra': [96,160,192], 'conn-bridge': [160,100,220], 'conn-vlan': [255,160,60],
  'conn-mesh': [120,220,120],
};
// VLAN-specific base colors (match CSS [data-vlan] custom properties)
const vlanColors = {
  '6': [140,180,255], '8': [255,200,100], '10': [100,220,160],
  '11': [200,140,255], '0': [100,220,220],
};

export function getNodeTraffic(collectd, nodeKey) {
  if (!collectd) return null;
  const key = nodeKey.toLowerCase();
  // Try exact match
  let cd = collectd[nodeKey];
  // Try prefix match (hostname.domain.tld → hostname)
  if (!cd) {
    for (const [k, v] of Object.entries(collectd)) {
      if (k.toLowerCase().split('.')[0] === key) { cd = v; break; }
    }
  }
  // Try fuzzy hostname match
  if (!cd) {
    cd = Object.values(collectd).find(c =>
      c.hostname && c.hostname.toLowerCase().replace(/[-_]/g,'') === key.replace(/[-_]/g,''));
  }
  if (!cd || !cd.interfaces) return null;
  // Pick the busiest single interface (typically eth0 or wan) — not sum of all
  let bestRx = 0, bestTx = 0, bestTotal = 0;
  Object.values(cd.interfaces).forEach(iface => {
    const rx = iface.rx_bps || 0;
    const tx = iface.tx_bps || 0;
    if (rx + tx > bestTotal) {
      bestRx = rx; bestTx = tx; bestTotal = rx + tx;
    }
  });
  return bestTotal > 0 ? { rx: bestRx, tx: bestTx, total: bestTotal } : null;
}

// Snapshot connection paths for traffic updates (uses _connPaths from renderTopology)
const _connLinesWithData = _connPaths.filter(p => p && p.dataset.to);
const _connBaseWidths = new Map();
const _connCache = new WeakMap();  // Cache per-line: {connType, sw, speed, dir, tier, stroke, animated}
_connPaths.forEach(path => {
  if (!path) return;
  const cs = getComputedStyle(path);
  _connBaseWidths.set(path, parseFloat(cs.getPropertyValue('--sw')) || 1.5);
  // Pre-cache connType (doesn't change)
  const connType = Array.from(path.classList).find(c => connColors[c]);
  _connCache.set(path, { connType, sw: 0, speed: 0, dir: '', tier: '', stroke: '', animated: false });
});

const TOP_GLOW_COUNT = 5;  // Only apply expensive SVG glow to top N traffic lines
const MAX_ANIMATED_CONNS = 15;  // Limit dash animations — each is a 60fps SVG repaint

export function updateConnectionTraffic(collectd) {
  if (!collectd) return;
  const trafficData = [];  // Collect {line, intensity} for top-N glow selection

  _connLinesWithData.forEach(line => {
    const cache = _connCache.get(line) || { connType: null, sw: 0, speed: 0, dir: '', tier: '', stroke: '', animated: false, glow: false };
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toTraffic = getNodeTraffic(collectd, toNode);
    const fromTraffic = fromNode ? getNodeTraffic(collectd, fromNode) : null;
    const traffic = (toTraffic && fromTraffic)
      ? (toTraffic.total > fromTraffic.total ? toTraffic : fromTraffic)
      : (toTraffic || fromTraffic);
    const baseW = _connBaseWidths.get(line) || 1.5;
    if (!traffic || traffic.total === 0) {
      // Only update if was previously active
      if (cache.tier || cache.sw !== baseW || cache.animated || cache.glow) {
        line.style.setProperty('--sw', baseW);
        line.style.removeProperty('--speed');
        line.style.removeProperty('--dir');
        line.removeAttribute('stroke');
        if (cache.tier) line.classList.remove(cache.tier);
        if (cache.animated) { line.classList.remove('conn-animated'); cache.animated = false; }
        if (cache.glow) { line.classList.remove('conn-glow'); cache.glow = false; }
        cache.sw = baseW; cache.speed = 0; cache.dir = ''; cache.tier = ''; cache.stroke = '';
      }
      return;
    }
    // Enable animation only when there's traffic
    if (!cache.animated) { line.classList.add('conn-animated'); cache.animated = true; }
    // Realistic bandwidth scale: 0→1 mapped over 1 KB/s → 10 MB/s (log scale)
    const rawIntensity = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawIntensity * trafficScale);
    // Stroke width: base (frozen original) + up to 8px extra scaled by slider
    const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
    const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
    const dir = traffic.rx > traffic.tx ? 'reverse' : 'normal';
    const tier = intensity > 0.65 ? 'conn-traffic-high' : intensity > 0.35 ? 'conn-traffic-med' : intensity > 0.15 ? 'conn-traffic-low' : '';
    // Only update DOM if values changed
    if (sw !== cache.sw) { line.style.setProperty('--sw', sw); cache.sw = sw; }
    if (speed !== cache.speed) { line.style.setProperty('--speed', speed + 's'); cache.speed = speed; }
    if (dir !== cache.dir) { line.style.setProperty('--dir', dir); cache.dir = dir; }
    // Stroke color
    if (cache.connType) {
      const vlan = line.dataset.vlan;
      const [r,g,b] = (vlan && vlanColors[vlan]) || connColors[cache.connType] || [100,180,255];
      const alpha = +(0.15 + intensity * 0.5).toFixed(2);
      const bright = 1 + intensity * 0.3;
      const stroke = `rgba(${Math.min(255,r*bright)|0},${Math.min(255,g*bright)|0},${Math.min(255,b*bright)|0},${alpha})`;
      if (stroke !== cache.stroke) { line.setAttribute('stroke', stroke); cache.stroke = stroke; }
    }
    // Tier class (opacity only, no filter)
    if (tier !== cache.tier) {
      if (cache.tier) line.classList.remove(cache.tier);
      if (tier) line.classList.add(tier);
      cache.tier = tier;
    }
    // Track for top-N glow selection
    if (intensity > 0.3) trafficData.push({ line, cache, intensity });
  });

  // Apply expensive SVG glow filter only to top N traffic lines
  trafficData.sort((a, b) => b.intensity - a.intensity);
  const topLines = new Set(trafficData.slice(0, TOP_GLOW_COUNT).map(d => d.line));
  trafficData.forEach(({ line, cache }) => {
    const shouldGlow = topLines.has(line);
    if (shouldGlow !== cache.glow) {
      if (shouldGlow) line.classList.add('conn-glow');
      else line.classList.remove('conn-glow');
      cache.glow = shouldGlow;
    }
  });

  // Scale node icons based on traffic (use cached DOM refs, not querySelectorAll)
  for (const tipKey of Object.keys(_nodeDOM)) {
    const n = _nodeDOM[tipKey];
    if (!n.el) continue;
    const icon = n._icon || (n._icon = n.el.querySelector('.node-icon'));
    if (!icon) continue;
    const traffic = getNodeTraffic(collectd, tipKey);
    if (!traffic || traffic.total === 0) {
      if (n._lastTrafficScale) { icon.style.transform = ''; icon.style.filter = ''; n._lastTrafficScale = 0; }
      continue;
    }
    const rawI = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawI * trafficScale);
    const s = 1 + intensity * 0.5;
    // Skip DOM write if value unchanged (within 0.01)
    if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
      icon.style.transform = `scale(${s.toFixed(2)})`;
      icon.style.filter = intensity > 0.3 ? `brightness(${(1 + intensity * 0.4).toFixed(2)})` : '';
      n._lastTrafficScale = s;
    }
  }
}

/**
 * SSE-optimized traffic update -- receives pre-computed {nodeId: {rx, tx, total, intensity}}.
 * Skips hostname matching + interface scan + log math (done server-side).
 * Still applies local trafficScale, stroke colors, node icon scaling, and top-N glow.
 */
export function updateConnectionTrafficSSE(trafficMap) {
  if (!trafficMap) return;
  const trafficData = [];

  _connLinesWithData.forEach(line => {
    const cache = _connCache.get(line) || { connType: null, sw: 0, speed: 0, dir: '', tier: '', stroke: '', animated: false, glow: false };
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toT = trafficMap[toNode];
    const fromT = fromNode ? trafficMap[fromNode] : null;
    const traffic = (toT && fromT)
      ? (toT.total > fromT.total ? toT : fromT)
      : (toT || fromT);
    const baseW = _connBaseWidths.get(line) || 1.5;

    if (!traffic || traffic.total === 0) {
      if (cache.tier || cache.sw !== baseW || cache.animated || cache.glow) {
        line.style.setProperty('--sw', baseW);
        line.style.removeProperty('--speed');
        line.style.removeProperty('--dir');
        line.removeAttribute('stroke');
        if (cache.tier) line.classList.remove(cache.tier);
        if (cache.animated) { line.classList.remove('conn-animated'); cache.animated = false; }
        if (cache.glow) { line.classList.remove('conn-glow'); cache.glow = false; }
        cache.sw = baseW; cache.speed = 0; cache.dir = ''; cache.tier = ''; cache.stroke = '';
      }
      return;
    }

    const intensity = Math.min(1, traffic.intensity * trafficScale);
    const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
    const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
    const dir = traffic.rx > traffic.tx ? 'reverse' : 'normal';
    const tier = intensity > 0.65 ? 'conn-traffic-high' : intensity > 0.35 ? 'conn-traffic-med' : intensity > 0.15 ? 'conn-traffic-low' : '';

    if (sw !== cache.sw) { line.style.setProperty('--sw', sw); cache.sw = sw; }
    if (speed !== cache.speed) { line.style.setProperty('--speed', speed + 's'); cache.speed = speed; }
    if (dir !== cache.dir) { line.style.setProperty('--dir', dir); cache.dir = dir; }

    if (cache.connType) {
      const vlan = line.dataset.vlan;
      const [r,g,b] = (vlan && vlanColors[vlan]) || connColors[cache.connType] || [100,180,255];
      const alpha = +(0.15 + intensity * 0.5).toFixed(2);
      const bright = 1 + intensity * 0.3;
      const stroke = `rgba(${Math.min(255,r*bright)|0},${Math.min(255,g*bright)|0},${Math.min(255,b*bright)|0},${alpha})`;
      if (stroke !== cache.stroke) { line.setAttribute('stroke', stroke); cache.stroke = stroke; }
    }

    if (tier !== cache.tier) {
      if (cache.tier) line.classList.remove(cache.tier);
      if (tier) line.classList.add(tier);
      cache.tier = tier;
    }

    // Collect for animation budget (only top N get dash animation)
    trafficData.push({ line, cache, intensity });
  });

  // Only the top N connections by intensity get the expensive dash animation.
  // All others get static stroke styling but no animation (saves ~50 SVG repaints/frame).
  trafficData.sort((a, b) => b.intensity - a.intensity);
  const topAnimated = new Set(trafficData.slice(0, MAX_ANIMATED_CONNS).map(d => d.line));
  for (const { line, cache } of trafficData) {
    const shouldAnimate = topAnimated.has(line);
    if (shouldAnimate && !cache.animated) { line.classList.add('conn-animated'); cache.animated = true; }
    else if (!shouldAnimate && cache.animated) { line.classList.remove('conn-animated'); cache.animated = false; }
  }
  const topLines = new Set(trafficData.filter(d => d.intensity > 0.3).slice(0, TOP_GLOW_COUNT).map(d => d.line));
  trafficData.forEach(({ line, cache }) => {
    const shouldGlow = topLines.has(line);
    if (shouldGlow !== cache.glow) {
      if (shouldGlow) line.classList.add('conn-glow');
      else line.classList.remove('conn-glow');
      cache.glow = shouldGlow;
    }
  });

  for (const tipKey of Object.keys(_nodeDOM)) {
    const n = _nodeDOM[tipKey];
    if (!n.el) continue;
    const icon = n._icon || (n._icon = n.el.querySelector('.node-icon'));
    if (!icon) continue;
    const t = trafficMap[tipKey];
    if (!t || t.total === 0) {
      if (n._lastTrafficScale) { icon.style.transform = ''; icon.style.filter = ''; n._lastTrafficScale = 0; }
      continue;
    }
    const intensity = Math.min(1, t.intensity * trafficScale);
    const s = 1 + intensity * 0.5;
    if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
      icon.style.transform = `scale(${s.toFixed(2)})`;
      icon.style.filter = intensity > 0.3 ? `brightness(${(1 + intensity * 0.4).toFixed(2)})` : '';
      n._lastTrafficScale = s;
    }
  }
}

function _trafficToCollectd(trafficMap) {
  const fake = {};
  for (const [nodeId, t] of Object.entries(trafficMap)) {
    fake[nodeId] = { hostname: nodeId, interfaces: { best: { rx_bps: t.rx, tx_bps: t.tx } } };
  }
  return fake;
}

// ── Topographic Heightmap Layer (Web Worker) ──
// Heavy computation (Gaussian + marching squares) runs off main thread.
// Main thread only does DOM insertion of the resulting SVG bands.
const _topoSvg = document.getElementById('topo-svg');
let _topoEnabled = true;
let _topoOpacity = 0.6;
let _topoSpread = 120;   // gaussian sigma in world coords
let _topoContours = 12;
let _topoRiverWidth = 0.4;  // base river width as fraction of sigma
let _topoRiverDepth = 0.6;  // multiplicative carve depth (0=none, 1=to zero)
let _lastTopoCollectd = null;
let _topoRafId = 0;
let _topoHash = '';
let _topoWorkerBusy = false;
let _topoLastDispatch = 0;
const _TOPO_MIN_INTERVAL = 30000; // minimum 30s between topo recomputes

const _TOPO_DEFS = `<defs>
<filter id="topo-glow" x="-15%" y="-15%" width="130%" height="130%">
  <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
  <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
<filter id="topo-shimmer" x="-20%" y="-20%" width="140%" height="140%">
  <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="soft"/>
  <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="wide"/>
  <feColorMatrix in="wide" type="matrix" result="golden"
    values="1.2 0.2 0 0 0.08  0.8 0.6 0 0 0.04  0 0.1 0.3 0 0  0 0 0 0.5 0"/>
  <feMerge><feMergeNode in="golden"/><feMergeNode in="soft"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>`;

// Node map cache (used by ley-line mote sparkles and topo invalidation)
let _topoNodeMap = null;
function _getTopoNodeMap() {
  if (_topoNodeMap) return _topoNodeMap;
  _topoNodeMap = new Map();
  for (const n of _topology.nodes) _topoNodeMap.set(n.id, n);
  return _topoNodeMap;
}

// Grid constants (shared with worker)
const _TOPO_PAD = 50;
const _TOPO_SX = 10, _TOPO_SY = 10;
const _TOPO_W = Math.ceil(WORLD_W / _TOPO_SX) + _TOPO_PAD * 2;
const _TOPO_H = Math.ceil(WORLD_H / _TOPO_SY) + _TOPO_PAD * 2;

// Worker setup
const _topoWorker = new Worker('topo-worker.js');
_topoWorker.onmessage = function(e) {
  _topoWorkerBusy = false;
  const { hash, bands } = e.data;
  if (!bands || bands.length === 0) return;
  if (hash === _topoHash) return;
  _topoHash = hash;

  // DOM update — build SVG elements from worker-computed band data
  const VB = '-500 -500 5800 4300';
  const fragment = document.createDocumentFragment();
  let first = true;
  for (const b of bands) {
    let inner = '';
    if (first) { inner += _TOPO_DEFS; first = false; }
    if (b.halo && b.fillOp > 0) {
      inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="25" opacity="${b.fillOp}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const filterAttr = b.useFilter ? ' class="topo-idx"' : '';
    inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="${b.sw}" opacity="${b.op}" stroke-linecap="round"${filterAttr}/>`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', VB);
    svg.setAttribute('class', 'topo-band');
    svg.dataset.elev = b.elev.toFixed(3);
    svg.innerHTML = inner;
    fragment.appendChild(svg);
  }
  _topoSvg.innerHTML = '';
  _topoSvg.appendChild(fragment);
  if (_mapTilt > 0) _applyTopoZ();
};

export function renderTopoLayer(collectd) {
  if (!_topoSvg || !_topoEnabled || !_topology.nodes) return;
  if (_topoWorkerBusy) return; // don't queue while worker is computing

  // Throttle: minimum 30s between dispatches (slider overrides bypass this)
  const now = Date.now();
  if (now - _topoLastDispatch < _TOPO_MIN_INTERVAL) return;

  _topoWorkerBusy = true;
  _topoLastDispatch = now;

  // Send serializable data to worker (no DOM, no Maps)
  const nodes = _topology.nodes.map(n => ({
    id: n.id, x: n.x, y: n.y, type: n.type,
    iconStyle: n.iconStyle ? { width: n.iconStyle.width, height: n.iconStyle.height } : null
  }));
  const connections = (_topology.connections || []).map(c => ({ from: c.from, to: c.to }));

  _topoWorker.postMessage({
    nodes, connections,
    collectd: collectd || {},
    settings: { spread: _topoSpread, contours: _topoContours, riverWidth: _topoRiverWidth, riverDepth: _topoRiverDepth },
    grid: { W: _TOPO_W, H: _TOPO_H, sx: _TOPO_SX, sy: _TOPO_SY, pad: _TOPO_PAD },
    perfTier: _perfTier,
  });
}

// Force immediate render (bypass throttle — used by sliders)
function _topoForceRender() {
  _topoLastDispatch = 0;
  _topoHash = '';
  renderTopoLayer(_lastTopoCollectd);
}

// Topo controls
(function initTopoControls() {
  const toggle = document.getElementById('topo-toggle-cb');
  const opSlider = document.getElementById('topo-opacity-slider');
  const opVal = document.getElementById('topo-opacity-val');
  const spSlider = document.getElementById('topo-spread-slider');
  const spVal = document.getElementById('topo-spread-val');
  const cnSlider = document.getElementById('topo-contour-slider');
  const cnVal = document.getElementById('topo-contour-val');
  if (!toggle || !_topoSvg) return;

  _topoSvg.style.setProperty('--topo-opacity', _topoOpacity);

  function scheduleRender() {
    cancelAnimationFrame(_topoRafId);
    _topoRafId = requestAnimationFrame(() => _topoForceRender());
  }

  toggle.addEventListener('change', () => {
    _topoEnabled = toggle.checked;
    _topoSvg.classList.toggle('active', _topoEnabled);
    if (_topoEnabled) scheduleRender();
    saveSettings();
  });
  opSlider.addEventListener('input', () => {
    _topoOpacity = parseFloat(opSlider.value);
    opVal.textContent = _topoOpacity.toFixed(2);
    _topoSvg.style.setProperty('--topo-opacity', _topoOpacity);
    scheduleSave();
  });
  spSlider.addEventListener('input', () => {
    _topoSpread = parseInt(spSlider.value);
    spVal.textContent = _topoSpread;
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });
  cnSlider.addEventListener('input', () => {
    _topoContours = parseInt(cnSlider.value);
    cnVal.textContent = _topoContours;
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });

  const rwSlider = document.getElementById('topo-rw-slider');
  const rwVal = document.getElementById('topo-rw-val');
  const rdSlider = document.getElementById('topo-rd-slider');
  const rdVal = document.getElementById('topo-rd-val');
  if (rwSlider) rwSlider.addEventListener('input', () => {
    _topoRiverWidth = parseFloat(rwSlider.value);
    rwVal.textContent = _topoRiverWidth.toFixed(2);
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });
  if (rdSlider) rdSlider.addEventListener('input', () => {
    _topoRiverDepth = parseFloat(rdSlider.value);
    rdVal.textContent = _topoRiverDepth.toFixed(2);
    if (_topoEnabled) scheduleRender();
    scheduleSave();
  });

  if (_topoEnabled && _topology.nodes) renderTopoLayer(null);
})();

// ── Arcane Grid Controls ──
const _gridSvg = document.getElementById('arcane-grid');
const _gridContent = document.getElementById('arcane-grid-content');
let _gridEnabled = false;
let _gridOpacity = 0.4;
let _gridScale = 1.0;
let _gridPulse = true;
let _gridHue = 0;

(function initGridControls() {
  const toggle = document.getElementById('grid-toggle-cb');
  const visToggle = document.getElementById('vis-grid');
  const opSlider = document.getElementById('grid-opacity-slider');
  const opVal = document.getElementById('grid-opacity-val');
  const scSlider = document.getElementById('grid-scale-slider');
  const scVal = document.getElementById('grid-scale-val');
  const pulseToggle = document.getElementById('grid-pulse-cb');
  const pulseVal = document.getElementById('grid-pulse-val');
  const hueSlider = document.getElementById('grid-hue-slider');
  const hueVal = document.getElementById('grid-hue-val');
  const layerSlider = document.getElementById('layer-grid-slider');

  if (!_gridSvg) return;

  function applyGridStyle() {
    _gridSvg.style.setProperty('--grid-opacity', _gridOpacity);
    _gridSvg.style.setProperty('--grid-scale', _gridScale);
    _gridSvg.style.filter = _gridHue ? `hue-rotate(${_gridHue}deg)` : '';
    _gridSvg.style.animationPlayState = _gridPulse ? 'running' : 'paused';
    _gridSvg.classList.toggle('active', _gridEnabled);
  }

  function syncToggles() {
    if (toggle) toggle.checked = _gridEnabled;
    if (visToggle) visToggle.checked = _gridEnabled;
  }

  if (toggle) toggle.addEventListener('change', () => {
    _gridEnabled = toggle.checked;
    syncToggles();
    applyGridStyle();
    saveSettings();
  });
  if (visToggle) visToggle.addEventListener('change', () => {
    _gridEnabled = visToggle.checked;
    syncToggles();
    applyGridStyle();
    saveSettings();
  });
  if (opSlider) opSlider.addEventListener('input', () => {
    _gridOpacity = parseFloat(opSlider.value);
    if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
    if (layerSlider) layerSlider.value = _gridOpacity;
    applyGridStyle();
    scheduleSave();
  });
  if (layerSlider) layerSlider.addEventListener('input', () => {
    _gridOpacity = parseFloat(layerSlider.value);
    if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
    if (opSlider) opSlider.value = _gridOpacity;
    applyGridStyle();
    scheduleSave();
  });
  if (scSlider) scSlider.addEventListener('input', () => {
    _gridScale = parseFloat(scSlider.value);
    if (scVal) scVal.textContent = _gridScale.toFixed(1);
    applyGridStyle();
    scheduleSave();
  });
  if (pulseToggle) pulseToggle.addEventListener('change', () => {
    _gridPulse = pulseToggle.checked;
    if (pulseVal) pulseVal.textContent = _gridPulse ? 'on' : 'off';
    applyGridStyle();
    scheduleSave();
  });
  if (hueSlider) hueSlider.addEventListener('input', () => {
    _gridHue = parseInt(hueSlider.value);
    if (hueVal) hueVal.textContent = _gridHue + '°';
    applyGridStyle();
    scheduleSave();
  });

  // Export for save/restore
  window._gridControls = {
    applyGridStyle,
    syncToggles,
    getState: () => ({ enabled: _gridEnabled, opacity: _gridOpacity, scale: _gridScale, pulse: _gridPulse, hue: _gridHue }),
    setState: (s) => {
      if (s.enabled !== undefined) _gridEnabled = s.enabled;
      if (s.opacity !== undefined) _gridOpacity = s.opacity;
      if (s.scale !== undefined) _gridScale = s.scale;
      if (s.pulse !== undefined) _gridPulse = s.pulse;
      if (s.hue !== undefined) _gridHue = s.hue;
      // Update UI
      if (opSlider) opSlider.value = _gridOpacity;
      if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
      if (layerSlider) layerSlider.value = _gridOpacity;
      if (scSlider) scSlider.value = _gridScale;
      if (scVal) scVal.textContent = _gridScale.toFixed(1);
      if (pulseToggle) pulseToggle.checked = _gridPulse;
      if (pulseVal) pulseVal.textContent = _gridPulse ? 'on' : 'off';
      if (hueSlider) hueSlider.value = _gridHue;
      if (hueVal) hueVal.textContent = _gridHue + '°';
      syncToggles();
      applyGridStyle();
    }
  };

  applyGridStyle();
})();

// ── Arcane Ambiance Controls (Compass, Sparkles, Vignette, Glow) ──
(function initAmbianceControls() {
  const compassEl = document.getElementById('compass-rose');
  const sparkleLayer = document.getElementById('sparkle-layer');
  const vignetteEl = document.getElementById('map-vignette');
  const mapWorld = document.getElementById('map-world');

  let compassEnabled = true, compassOpacity = 0.7, compassScale = 1.0;
  let sparklesEnabled = true, sparkleOpacity = 0.7, sparkleDensity = 0.5;
  let vignetteEnabled = true, vignetteOpacity = 0.3;
  let ambientGlow = 0.3;
  let sparkleTimer = null;

  function applyCompass() {
    if (compassEl) {
      compassEl.style.display = compassEnabled ? '' : 'none';
      compassEl.style.setProperty('--compass-opacity', compassOpacity);
      compassEl.style.opacity = compassOpacity;
      compassEl.style.transform = `scale(${compassScale})`;
    }
  }

  function applySparkles() {
    if (sparkleLayer) {
      sparkleLayer.style.display = sparklesEnabled ? '' : 'none';
      sparkleLayer.style.opacity = sparkleOpacity;
    }
    if (sparkleTimer) { clearInterval(sparkleTimer); sparkleTimer = null; }
    if (sparklesEnabled && sparkleDensity > 0 && sparkleLayer) {
      const ms = Math.max(80, 600 / sparkleDensity);
      sparkleTimer = setInterval(spawnSparkle, ms);
    }
  }

  function spawnSparkle() {
    if (!sparkleLayer) return;
    // Cap max sparkles for performance
    if (sparkleLayer.children.length > 30) return;
    const el = document.createElement('div');
    const isLarge = Math.random() < 0.15;
    el.className = isLarge ? 'sparkle sparkle-large' : 'sparkle';
    el.style.left = (Math.random() * 4800) + 'px';
    el.style.top = (Math.random() * 3300) + 'px';
    const dur = 2 + Math.random() * 4;
    const size = isLarge ? (4 + Math.random() * 4) : (2 + Math.random() * 3);
    el.style.setProperty('--sparkle-dur', dur + 's');
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    sparkleLayer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  function applyVignette() {
    if (vignetteEl) {
      vignetteEl.style.display = vignetteEnabled ? '' : 'none';
      vignetteEl.style.opacity = vignetteOpacity;
    }
  }

  function applyGlow() {
    if (mapWorld) mapWorld.style.setProperty('--ambient-glow', ambientGlow);
  }

  // Wire layer toggles
  const visCb = { compass: 'vis-compass', sparkles: 'vis-sparkles', vignette: 'vis-vignette' };
  const layerSl = { compass: 'layer-compass-slider', sparkles: 'layer-sparkles-slider', vignette: 'layer-vignette-slider' };

  const compassCb = document.getElementById(visCb.compass);
  if (compassCb) compassCb.addEventListener('change', () => { compassEnabled = compassCb.checked; applyCompass(); scheduleSave(); });
  const compassLayerSl = document.getElementById(layerSl.compass);
  if (compassLayerSl) compassLayerSl.addEventListener('input', () => { compassOpacity = parseFloat(compassLayerSl.value); applyCompass(); scheduleSave(); });

  const sparklesCb = document.getElementById(visCb.sparkles);
  if (sparklesCb) sparklesCb.addEventListener('change', () => { sparklesEnabled = sparklesCb.checked; applySparkles(); scheduleSave(); });
  const sparklesLayerSl = document.getElementById(layerSl.sparkles);
  if (sparklesLayerSl) sparklesLayerSl.addEventListener('input', () => { sparkleOpacity = parseFloat(sparklesLayerSl.value); applySparkles(); scheduleSave(); });

  const vignetteCb = document.getElementById(visCb.vignette);
  if (vignetteCb) vignetteCb.addEventListener('change', () => { vignetteEnabled = vignetteCb.checked; applyVignette(); scheduleSave(); });
  const vignetteLayerSl = document.getElementById(layerSl.vignette);
  if (vignetteLayerSl) vignetteLayerSl.addEventListener('input', () => { vignetteOpacity = parseFloat(vignetteLayerSl.value); applyVignette(); scheduleSave(); });

  // Wire spellbook sliders
  const compassScaleSl = document.getElementById('compass-scale-slider');
  const compassScaleVal = document.getElementById('compass-scale-val');
  if (compassScaleSl) compassScaleSl.addEventListener('input', () => {
    compassScale = parseFloat(compassScaleSl.value);
    if (compassScaleVal) compassScaleVal.textContent = compassScale.toFixed(1);
    applyCompass(); scheduleSave();
  });

  const sparkleDensitySl = document.getElementById('sparkle-density-slider');
  const sparkleDensityVal = document.getElementById('sparkle-density-val');
  if (sparkleDensitySl) sparkleDensitySl.addEventListener('input', () => {
    sparkleDensity = parseFloat(sparkleDensitySl.value);
    if (sparkleDensityVal) sparkleDensityVal.textContent = sparkleDensity.toFixed(2);
    applySparkles(); scheduleSave();
  });

  const ambientGlowSl = document.getElementById('ambient-glow-slider');
  const ambientGlowVal = document.getElementById('ambient-glow-val');
  if (ambientGlowSl) ambientGlowSl.addEventListener('input', () => {
    ambientGlow = parseFloat(ambientGlowSl.value);
    if (ambientGlowVal) ambientGlowVal.textContent = ambientGlow.toFixed(2);
    applyGlow(); scheduleSave();
  });

  const vignetteSl = document.getElementById('vignette-slider');
  const vignetteValEl = document.getElementById('vignette-val');
  if (vignetteSl) vignetteSl.addEventListener('input', () => {
    vignetteOpacity = parseFloat(vignetteSl.value);
    if (vignetteLayerSl) vignetteLayerSl.value = vignetteOpacity;
    if (vignetteValEl) vignetteValEl.textContent = vignetteOpacity.toFixed(2);
    applyVignette(); scheduleSave();
  });

  // Export for save/restore
  window._ambianceControls = {
    getState: () => ({
      compass: compassEnabled, compassOp: compassOpacity, compassSc: compassScale,
      sparkles: sparklesEnabled, sparkleOp: sparkleOpacity, sparkleDen: sparkleDensity,
      vignette: vignetteEnabled, vignetteOp: vignetteOpacity, glow: ambientGlow,
    }),
    setState: (s) => {
      if (s.compass !== undefined) compassEnabled = s.compass;
      if (s.compassOp !== undefined) compassOpacity = s.compassOp;
      if (s.compassSc !== undefined) compassScale = s.compassSc;
      if (s.sparkles !== undefined) sparklesEnabled = s.sparkles;
      if (s.sparkleOp !== undefined) sparkleOpacity = s.sparkleOp;
      if (s.sparkleDen !== undefined) sparkleDensity = s.sparkleDen;
      if (s.vignette !== undefined) vignetteEnabled = s.vignette;
      if (s.vignetteOp !== undefined) vignetteOpacity = s.vignetteOp;
      if (s.glow !== undefined) ambientGlow = s.glow;
      // Sync UI
      if (compassCb) compassCb.checked = compassEnabled;
      if (compassLayerSl) compassLayerSl.value = compassOpacity;
      if (compassScaleSl) compassScaleSl.value = compassScale;
      if (compassScaleVal) compassScaleVal.textContent = compassScale.toFixed(1);
      if (sparklesCb) sparklesCb.checked = sparklesEnabled;
      if (sparklesLayerSl) sparklesLayerSl.value = sparkleOpacity;
      if (sparkleDensitySl) sparkleDensitySl.value = sparkleDensity;
      if (sparkleDensityVal) sparkleDensityVal.textContent = sparkleDensity.toFixed(2);
      if (vignetteCb) vignetteCb.checked = vignetteEnabled;
      if (vignetteLayerSl) vignetteLayerSl.value = vignetteOpacity;
      if (vignetteSl) vignetteSl.value = vignetteOpacity;
      if (vignetteValEl) vignetteValEl.textContent = vignetteOpacity.toFixed(2);
      if (ambientGlowSl) ambientGlowSl.value = ambientGlow;
      if (ambientGlowVal) ambientGlowVal.textContent = ambientGlow.toFixed(2);
      applyCompass(); applySparkles(); applyVignette(); applyGlow();
    }
  };

  // Apply initial state
  applyCompass(); applySparkles(); applyVignette(); applyGlow();
})();

// ── Event rendering (SSE replaces polling — see initSSE below) ──
let lastEventTs = 0;

const _pageLoadTs = Date.now() / 1000;
const BUBBLE_RESTORE_AGE = 600;  // Restore bubbles for events up to 10 min old
const _restoredBubbleNodes = new Set();  // Track which nodes got a restored bubble

function renderEvent(evt, isRestore = false) {
  lastEventTs = Math.max(lastEventTs, evt.ts || 0);
  const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);

  // Always log to quest log (addLogEntry checks dismissed internally)
  addLogEntry(evt, nodeEl);

  // Skip bubble for dismissed events
  if (evt.text && _dismissedQuests.includes(evt.text)) return;

  // For restored events, only show bubble (no highlight flash)
  // For live events, show both bubble and highlight
  const evtAge = _pageLoadTs - (evt.ts || 0);
  const isStale = evtAge > 30 && !evt._local;

  if (!nodeEl) return;

  // One bubble per node — latest event always wins (showSpeechBubble dismisses the old one).
  // On restore: SSE replays chronologically, so last event per node is the most recent.
  // Just let each event overwrite — showSpeechBubble handles the dedup.
  let showBubble = false;
  const isPersistent = ['quest', 'alert', 'oracle_query', 'oracle_response'].includes(evt.type);
  if (isRestore) {
    showBubble = isPersistent || evtAge < BUBBLE_RESTORE_AGE;
  } else if (!isStale) {
    showBubble = true;
  }

  if (!showBubble) return;

  if (evt.type === 'speech') {
    showSpeechBubble(nodeEl, evt);
    if (!isRestore) showHighlight(nodeEl, { color: evt.color || 'rgba(160,200,255,0.4)' });
  } else if (evt.type === 'highlight') {
    if (!isRestore) showHighlight(nodeEl, evt);
  } else if (evt.type === 'alert') {
    showSpeechBubble(nodeEl, evt, true);
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(255,80,60,0.6)' });
  } else if (evt.type === 'quest') {
    showSpeechBubble(nodeEl, evt);
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,144,255,0.5)' });
    _refreshQuestCards(); // Refresh structured quest view
  } else if (evt.type === 'oracle_query') {
    showSpeechBubble(nodeEl, { ...evt, text: '\u2728 ' + evt.text, color: '#c080ff' });
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,128,255,0.6)' });
  } else if (evt.type === 'oracle_response') {
    showSpeechBubble(nodeEl, { ...evt, color: evt.color || '#e0b0ff' });
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,128,255,0.4)' });
  }
}

// ── Quest Log (enhanced with tabs) ──
let logCount = 0;
const MAX_LOG = 80;
let activeTab = 'all';

// Quest cards container (injected before log body)
const _questCards = document.createElement('div');
_questCards.className = 'quest-cards';
_questCards.style.display = 'none';
const _logBodyEl = document.getElementById('quest-log-body');
if (_logBodyEl) _logBodyEl.parentNode.insertBefore(_questCards, _logBodyEl);

// Tab switching
document.querySelectorAll('.log-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    // Quest cards only visible on quest tab
    _questCards.style.display = activeTab === 'quest' ? '' : 'none';
    if (_logBodyEl) _logBodyEl.style.display = activeTab === 'quest' ? 'none' : '';
    document.querySelectorAll('.log-entry').forEach(entry => {
      if (activeTab === 'quest') {
        entry.style.display = 'none';
      } else if (activeTab === 'all') {
        entry.style.display = '';
      } else if (activeTab === 'notion') {
        entry.style.display = entry.classList.contains('notion-quest') ? '' : 'none';
      } else {
        entry.style.display = entry.classList.contains('log-' + activeTab) ? '' : 'none';
      }
    });
  });
});

// Codex header click-to-collapse removed — seal system handles panel hide/show

// Codex section toggles (click h4 to expand/collapse tool lists)
document.querySelectorAll('.codex-toggle').forEach(h4 => {
  h4.addEventListener('click', () => {
    const target = document.getElementById(h4.dataset.target);
    if (!target) return;
    h4.classList.toggle('open');
    target.classList.toggle('open');
  });
});

// Populate codex personas from /personas endpoint
fetch('/personas').then(r => r.json()).then(personas => {
  const el = document.querySelector('.codex-persona-list');
  if (!el) return;
  const icons = { katana:'\u2694', gatekeeper:'\u26E9', oracle:'\uD83D\uDD2E',
    forge:'\uD83D\uDD25', mana:'\uD83D\uDCA7', crystal:'\uD83D\uDC8E',
    'hp-switch':'\u2699', ha:'\uD83C\uDFE0', 'notion-portal':'\u2728', 'tab-s5e':'\uD83D\uDCF1' };
  el.innerHTML = Object.entries(personas).map(([k,p]) =>
    `<div class="codex-persona"><span class="cp-icon">${icons[k]||'\u2B50'}</span><div>`+
    `<div class="cp-name">${p.name||k} &mdash; ${p.title||''}</div>`+
    `<div class="cp-voice">${(p.voice||'').replace('en-US-','').replace('Neural','')} &bull; ${(p.hints||[]).slice(0,2).join(', ')}</div>`+
    `</div></div>`
  ).join('');
}).catch(() => {});

// Populate codex Notion-backed sections (Lore, Architecture, Guide, Reference)
const _sectionIcons = { Lore:'\uD83D\uDCDC', Architecture:'\u2699\uFE0F', Guide:'\uD83D\uDCD6', Reference:'\uD83D\uDCCB' };
const _sectionColors = { Lore:'#b090d0', Architecture:'#70a0d0', Guide:'#70c080', Reference:'#a0a0a0' };
const _sectionOrder = ['Lore','Architecture','Guide','Reference'];
function renderCodexNotion(data) {
  const container = document.getElementById('codex-notion-sections');
  if (!container) return;
  let html = '';
  for (const sec of _sectionOrder) {
    const entries = data[sec];
    if (!entries || !entries.length) continue;
    const id = 'codex-notion-' + sec.toLowerCase();
    const color = _sectionColors[sec] || '#b0a080';
    html += `<div class="codex-section">`;
    html += `<h4 class="codex-toggle" data-target="${id}" style="color:${color}">${_sectionIcons[sec]||''} ${sec} <span class="codex-tool-count">${entries.length}</span></h4>`;
    html += `<div id="${id}" class="codex-tools">`;
    for (const e of entries) {
      html += `<div class="codex-notion-entry">`;
      if (e.url) {
        html += `<div class="cne-header"><a href="${e.url}" target="_blank" rel="noopener" class="cne-link">${e.icon||''} <span class="cne-name">${e.name}</span></a></div>`;
      } else {
        html += `<div class="cne-header">${e.icon||''} <span class="cne-name">${e.name}</span></div>`;
      }
      html += `<div class="cne-body">${e.body||''}</div>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;
  // Re-bind toggles for new sections
  container.querySelectorAll('.codex-toggle').forEach(h4 => {
    h4.addEventListener('click', () => {
      const target = document.getElementById(h4.dataset.target);
      if (!target) return;
      h4.classList.toggle('open');
      target.classList.toggle('open');
    });
  });
}
// Defer Notion sync — not needed for initial render
setTimeout(() => fetch('/codex-sync').then(r => r.json()).then(renderCodexNotion).catch(() => {}), 5000);

// Quest log header click-to-collapse removed — seal system handles panel hide/show

const _logBody = document.getElementById('quest-log-body');
const _logCounter = document.getElementById('log-count');

// ── Notion Sync Portal button ──
const _syncBtn = document.getElementById('notion-sync-btn');
if (_syncBtn) {
  _syncBtn.addEventListener('click', async (e) => {
    e.stopPropagation(); // Don't toggle quest log
    if (_syncBtn.classList.contains('syncing')) return;
    _syncBtn.classList.add('syncing');
    _syncBtn.textContent = '\u231B Syncing...';
    try {
      const r = await fetch('/notion-sync');
      const data = await r.json();
      if (data.error) {
        _syncBtn.textContent = '\u26A0 ' + data.error.substring(0, 30);
        setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 3000);
        return;
      }
      _syncBtn.innerHTML = `\u2714 ${data.new || 0} new`;
      setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 2000);
    } catch (err) {
      _syncBtn.textContent = '\u26A0 Offline';
      setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 3000);
    }
  });
}

export function addLogEntry(evt, nodeEl) {
  if (!_logBody) return;
  const body = _logBody, counter = _logCounter;

  // Skip dismissed entries
  if (evt.text && _dismissedQuests.includes(evt.text)) return;

  // Prevent duplicate quest entries
  if (evt.type === 'quest' && evt.text) {
    for (const existing of body.children) {
      if (existing.classList.contains('log-quest') && existing.querySelector('.log-text')?.textContent?.includes(evt.text)) return;
    }
  }

  const name = nodeEl ? (nodeEl.querySelector('.node-label')?.textContent || evt.node) : (evt.node || 'System');
  const time = new Date((evt.ts || Date.now() / 1000) * 1000);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const entry = document.createElement('div');
  const logType = evt.type || 'speech';
  const isNotion = evt._source === 'notion';
  entry.className = `log-entry log-${logType} log-entry-new` + (isNotion ? ' notion-quest' : '');
  if (isNotion && evt._notion_id) entry.dataset.notionId = evt._notion_id;

  let textContent = '';
  if (logType === 'quest' && evt.text) {
    const icon = isNotion ? '&#127744;' : '&#9744;';
    textContent = `<div class="log-text quest-text"><span class="quest-check" title="Click to complete">${icon}</span> ${evt.text}</div>`;
  } else if (evt.text) {
    const prefix = logType === 'speech' ? '\u201C' : '';
    const suffix = logType === 'speech' ? '\u201D' : '';
    textContent = `<div class="log-text">${prefix}${evt.text}${suffix}</div>`;
  } else if (logType === 'highlight') {
    textContent = `<div class="log-text" style="font-style:italic;color:#708060">A pulse of energy ripples outward.</div>`;
  }

  const communeHint = evt.node ? '<span class="log-commune" title="Click to commune with this node">\u{1F52E}</span>' : '';
  entry.innerHTML = `<button class="panel-close panel-close--danger" title="Dismiss">\u2715</button><div class="log-time">${timeStr}</div><div class="log-speaker">${name}${communeHint}</div>${textContent}`;
  entry._nodeId = evt.node;

  // Click entry to navigate to node and open oracle chat
  entry.addEventListener('click', (e) => {
    // Don't navigate if clicking dismiss button or quest checkbox
    if (e.target.closest('.panel-close') || e.target.closest('.quest-check')) return;
    const nodeId = entry._nodeId;
    if (!nodeId) return;
    const tn = _topology?.nodes.find(nd => nd.id === nodeId);
    if (tn) panToNode(tn.x, tn.y);
    openNodeChat(nodeId, evt.text, false);
  });

  // Dismiss button — also removes matching speech bubble and persists
  entry.querySelector('.panel-close').addEventListener('click', (e) => {
    e.stopPropagation();
    entry.classList.add('log-entry-dismiss');
    if (evt.text) {
      // Dismiss matching bubble
      for (const b of _activeBubbles) {
        if (b.querySelector('.bubble-text')?.textContent?.includes(evt.text)) {
          _dismissBubble(b);
          break;
        }
      }
      // Persist dismissal
      if (!_dismissedQuests.includes(evt.text)) {
        _dismissedQuests.push(evt.text);
        _saveDismissed();
      }
      // Delete quest from DB
      if (evt.type === 'quest') {
        fetch('/quest-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: evt.text }) }).catch(() => {});
      }
    }
    entry.addEventListener('animationend', () => {
      entry.remove();
      logCount = Math.max(0, logCount - 1);
      _logCounter.textContent = `${logCount} entries`;
    });
  });

  // Quest checkbox toggle — persists completed state + Notion sync
  const check = entry.querySelector('.quest-check');
  if (check) {
    // Restore completed state
    if (evt.text && _completedQuests.includes(evt.text)) {
      check.innerHTML = '\u2611';
      entry.classList.add('quest-done');
    }
    check.addEventListener('click', async () => {
      const done = check.textContent === '\u2611';
      check.innerHTML = done ? (isNotion ? '&#127744;' : '\u2610') : '\u2611';
      entry.classList.toggle('quest-done', !done);
      if (evt.text) {
        const idx = _completedQuests.indexOf(evt.text);
        if (!done && idx === -1) _completedQuests.push(evt.text);
        else if (done && idx !== -1) _completedQuests.splice(idx, 1);
        _saveCompleted();
      }
      // Sync completion to Notion
      if (isNotion && evt._notion_id && !done) {
        try {
          check.style.opacity = '0.5';
          const r = await fetch('/notion-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notion_id: evt._notion_id }),
          });
          if (r.ok) {
            check.style.opacity = '1';
            check.innerHTML = '\u2705';
          } else {
            check.style.opacity = '1';
          }
        } catch (e) { check.style.opacity = '1'; }
      }
    });
  }

  // Tab filter
  if (activeTab === 'notion') {
    entry.style.display = entry.classList.contains('notion-quest') ? '' : 'none';
  } else if (activeTab !== 'all' && !entry.classList.contains('log-' + activeTab)) {
    entry.style.display = 'none';
  }

  body.insertBefore(entry, body.firstChild);
  logCount++;
  setTimeout(() => entry.classList.remove('log-entry-new'), 3000);

  // Event rewards — only for SSE events with a DB id, not local/transient
  if (evt.id && !evt._local && !_rewardedEvents.has(evt.id)) {
    _rewardedEvents.add(evt.id);
    fetch('/player/reward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'event', id: String(evt.id) }),
    }).then(r => r.json()).then(res => {
      if (res.granted && res.reward) {
        _floatRewardText(entry, res.reward);
        window.updateDockHUD?.(res, true);
        if (res.level_up) _celebrateLevelUp(res.level);
      }
    }).catch(() => {});
  }

  while (body.children.length > MAX_LOG) {
    body.removeChild(body.lastChild);
  }
  counter.textContent = `${Math.min(logCount, MAX_LOG)} entries`;
}

// Persist dismissed/completed quests across refreshes
const _dismissedQuests = JSON.parse(localStorage.getItem('realm-dismissed-quests') || '[]');
const _completedQuests = JSON.parse(localStorage.getItem('realm-completed-quests') || '[]');
function _saveDismissed() { localStorage.setItem('realm-dismissed-quests', JSON.stringify(_dismissedQuests)); }
function _saveCompleted() { localStorage.setItem('realm-completed-quests', JSON.stringify(_completedQuests)); }

// ── Player Reward System ──
const _rewardedEvents = new Set();

function _floatRewardText(anchor, reward) {
  const parts = [];
  if (reward.xp) parts.push(`+${reward.xp} XP`);
  if (reward.gold) parts.push(`+${reward.gold}g`);
  if (reward.gems) parts.push(`+${reward.gems} gem`);
  if (!parts.length) return;
  const el = document.createElement('div');
  el.className = 'reward-float';
  el.textContent = parts.join(' ');
  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top = rect.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function _celebrateLevelUp(level) {
  // Golden flash overlay
  const overlay = document.createElement('div');
  overlay.className = 'level-up-overlay';
  document.body.appendChild(overlay);
  // Rising level badge
  const badge = document.createElement('div');
  badge.className = 'level-up-badge';
  const circle = document.createElement('div');
  circle.className = 'lub-circle';
  circle.textContent = level;
  badge.appendChild(circle);
  const text = document.createElement('div');
  text.className = 'lub-text';
  text.textContent = 'LEVEL UP';
  badge.appendChild(text);
  document.body.appendChild(badge);
  // Pulse dock HUD level badge
  const dockLevel = document.querySelector('.hud-level');
  if (dockLevel) dockLevel.classList.add('hud-level-up');
  setTimeout(() => {
    overlay.remove();
    badge.remove();
    if (dockLevel) dockLevel.classList.remove('hud-level-up');
  }, 3000);
}

function _checkParentAutoReward(parentId) {
  setTimeout(() => {
    fetch('/quests').then(r => r.json()).then(quests => {
      const parent = quests.find(q => q.id === parentId);
      if (!parent || !parent.children?.length) return;
      const allDone = parent.children.every(c => c.status === 'completed');
      if (!allDone) return;
      fetch('/player/reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'quest', id: parentId }),
      }).then(r => r.json()).then(res => {
        if (!res.granted) return;
        const card = document.querySelector(`.quest-card[data-quest-id="${parentId}"]`);
        if (card) _floatRewardText(card, res.reward);
        window.updateDockHUD?.(res, true);
        if (res.level_up) _celebrateLevelUp(res.level);
      }).catch(() => {});
    }).catch(() => {});
  }, 500);
}

// ── Quest Card System (structured quests with interactive actions) ──
const _ACTION_ICONS = {
  pan: '\uD83D\uDDFA\uFE0F', panel: '\uD83D\uDCCB', highlight: '\u2728',
  chat: '\uD83D\uDCAC', scan: '\uD83D\uDD0D', link: '\uD83D\uDD17',
};

function _executeQuestAction(action) {
  if (action.type === 'pan' && action.node) {
    const tn = _topology?.nodes.find(n => n.id === action.node);
    if (tn) { panToNode(tn.x, tn.y); showHighlight(getNodeDOM(tn.id), { color: 'rgba(192,144,255,0.6)' }); }
  } else if (action.type === 'panel' && action.panel) {
    const panelEl = document.getElementById(action.panel);
    if (panelEl) { unsealPanel(panelEl); panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  } else if (action.type === 'highlight' && action.nodes) {
    action.nodes.forEach(nid => {
      const tn = _topology?.nodes.find(n => n.id === nid);
      if (tn) showHighlight(getNodeDOM(nid), { color: action.color || 'rgba(192,144,255,0.5)' });
    });
  } else if (action.type === 'chat' && action.node) {
    const tn = _topology?.nodes.find(n => n.id === action.node);
    if (tn) panToNode(tn.x, tn.y);
    openNodeChat(action.node, action.prompt || '', false);
  } else if (action.type === 'scan') {
    fetch(action.endpoint || '/scan').catch(() => {});
    addLogEntry({ type: 'system', node: 'katana', text: 'Initiating realm scan...', ts: Date.now()/1000 });
  }
}

function _renderQuestCards(quests) {
  _questCards.innerHTML = '';
  if (!quests.length) {
    _questCards.innerHTML = '<div style="padding:16px;text-align:center;color:#706040;font-size:11px;font-style:italic">No active quests. The realm is at peace.</div>';
    return;
  }
  quests.forEach(quest => {
    const card = document.createElement('div');
    const children = quest.children || [];
    const doneCount = children.filter(c => c.status === 'completed').length;
    const total = children.length;
    const allDone = total > 0 && doneCount === total;
    const isComplete = quest.status === 'completed' || allDone;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    card.className = 'quest-card' + (isComplete ? ' quest-card--done' : '');
    card.dataset.questId = quest.id;

    // Header (click to expand)
    const header = document.createElement('div');
    header.className = 'quest-card-header';
    header.innerHTML = `<span class="quest-card-icon">\u25B6</span>` +
      `<span class="quest-card-title">${quest.title}</span>` +
      (isComplete ? '<span class="quest-card-badge">\u2714 Complete</span>' : '') +
      (total > 0 && !isComplete ? `<span class="quest-card-progress">${doneCount}/${total}</span>` : '');
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'quest-card-delete';
    delBtn.innerHTML = '\u2716';
    delBtn.title = 'Dismiss quest';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('quest-card--dismissing');
      setTimeout(() => {
        fetch('/quest-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: quest.id }),
        }).then(() => _refreshQuestCards()).catch(() => {});
      }, 400);
    });
    header.appendChild(delBtn);
    header.addEventListener('click', (e) => {
      if (e.target.closest('.quest-card-delete')) return;
      card.classList.toggle('quest-card--open');
    });
    card.appendChild(header);

    // Progress bar
    if (total > 0) {
      const bar = document.createElement('div');
      bar.className = 'quest-card-bar';
      bar.innerHTML = `<div class="quest-card-bar-fill" style="width:${pct}%"></div>`;
      card.appendChild(bar);
    }

    // Description
    if (quest.description) {
      const desc = document.createElement('div');
      desc.className = 'quest-card-desc';
      desc.textContent = quest.description;
      card.appendChild(desc);
    }

    // Main quest actions
    if (quest.actions?.length) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'quest-actions';
      actionsRow.style.padding = '2px 10px 6px 34px';
      quest.actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = `quest-action quest-action--${action.type}`;
        btn.innerHTML = `${_ACTION_ICONS[action.type] || ''} ${action.label}`;
        btn.addEventListener('click', (e) => { e.stopPropagation(); _executeQuestAction(action); });
        actionsRow.appendChild(btn);
      });
      card.appendChild(actionsRow);
    }

    // Complete button for quests with no sub-quests
    if (total === 0 && quest.status !== 'completed') {
      const completeRow = document.createElement('div');
      completeRow.className = 'quest-complete-row';
      const completeBtn = document.createElement('button');
      completeBtn.className = 'quest-complete-btn';
      completeBtn.innerHTML = '<span class="qcb-rune">&#x16C7;</span> Claim Reward <span class="qcb-rune">&#x16C8;</span>';
      completeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (completeBtn.disabled) return;
        completeBtn.disabled = true;
        // Grant reward via server
        fetch('/player/reward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'quest', id: quest.id }),
        }).then(r => r.json()).then(res => {
          _spawnQuestReward(card, completeBtn, res.granted ? res.reward : null);
          window.updateDockHUD?.(res, true);
          if (res.level_up) _celebrateLevelUp(res.level);
        }).catch(() => {
          _spawnQuestReward(card, completeBtn, null);
        });
        // Mark completed after animation peaks
        setTimeout(() => {
          fetch('/quest-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: quest.id, status: 'completed' }),
          }).then(() => _refreshQuestCards()).catch(() => {});
        }, 1800);
      });
      completeRow.appendChild(completeBtn);
      card.appendChild(completeRow);
    }

    // Collapsible body with sub-quests
    const body = document.createElement('div');
    body.className = 'quest-card-body';
    children.forEach(sub => {
      const subEl = document.createElement('div');
      const isDone = sub.status === 'completed';
      subEl.className = 'quest-sub' + (isDone ? ' quest-sub--done' : '');

      const check = document.createElement('span');
      check.className = 'quest-sub-check';
      check.innerHTML = isDone ? '\u2611' : '\u2610';
      check.addEventListener('click', () => {
        const newStatus = isDone ? 'active' : 'completed';
        fetch('/quest-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sub.id, status: newStatus }),
        }).then(() => _refreshQuestCards()).catch(() => {});
        // Grant reward only when toggling TO completed
        if (!isDone) {
          fetch('/player/reward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'sub', id: sub.id }),
          }).then(r => r.json()).then(res => {
            if (res.granted) _floatRewardText(subEl, res.reward);
            window.updateDockHUD?.(res, true);
            if (res.level_up) _celebrateLevelUp(res.level);
          }).catch(() => {});
          _checkParentAutoReward(quest.id);
        }
        // Immediate visual feedback
        subEl.classList.toggle('quest-sub--done');
        subEl.classList.add('quest-sub--completing');
        check.innerHTML = isDone ? '\u2610' : '\u2611';
      });

      const content = document.createElement('div');
      content.className = 'quest-sub-content';
      content.innerHTML = `<div class="quest-sub-title">${sub.title}</div>` +
        (sub.node ? `<div class="quest-sub-node">\u2694 ${sub.node}</div>` : '');

      // Sub-quest actions
      if (sub.actions?.length) {
        const subActions = document.createElement('div');
        subActions.className = 'quest-actions';
        sub.actions.forEach(action => {
          const btn = document.createElement('button');
          btn.className = `quest-action quest-action--${action.type}`;
          btn.innerHTML = `${_ACTION_ICONS[action.type] || ''} ${action.label}`;
          btn.addEventListener('click', (e) => { e.stopPropagation(); _executeQuestAction(action); });
          subActions.appendChild(btn);
        });
        content.appendChild(subActions);
      }

      subEl.appendChild(check);
      subEl.appendChild(content);
      body.appendChild(subEl);
    });
    card.appendChild(body);
    _questCards.appendChild(card);
  });
}

// ── Quest Reward Burst ──
const _REWARD_RUNES = ['\u16A0','\u16A2','\u16A6','\u16B1','\u16B7','\u16C1','\u16C7','\u16C8','\u16CF','\u16D6'];
const _REWARD_GEMS = ['💎','✦','⬥','◆','🔮','⚜','✧','★'];
function _spawnQuestReward(card, btn, reward) {
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // Add glow class to card
  card.classList.add('quest-card--rewarding');
  btn.classList.add('qcb--activated');
  // Spawn particles
  const container = document.createElement('div');
  container.className = 'quest-reward-burst';
  container.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;z-index:99999;pointer-events:none`;
  document.body.appendChild(container);
  // Ring of rune particles
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('span');
    p.className = 'qr-particle qr-rune';
    p.textContent = _REWARD_RUNES[i % _REWARD_RUNES.length];
    const angle = (i / 16) * Math.PI * 2;
    const dist = 60 + Math.random() * 50;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.animationDelay = `${i * 40}ms`;
    container.appendChild(p);
  }
  // Gem shower
  for (let i = 0; i < 10; i++) {
    const g = document.createElement('span');
    g.className = 'qr-particle qr-gem';
    g.textContent = _REWARD_GEMS[i % _REWARD_GEMS.length];
    g.style.setProperty('--dx', `${(Math.random() - 0.5) * 140}px`);
    g.style.setProperty('--dy', `${-40 - Math.random() * 80}px`);
    g.style.animationDelay = `${200 + i * 60}ms`;
    container.appendChild(g);
  }
  // XP banner
  const xp = document.createElement('div');
  xp.className = 'qr-xp';
  if (reward) {
    const parts = [`+${reward.xp} XP`];
    if (reward.gold) parts.push(`+${reward.gold}g`);
    if (reward.gems) parts.push(`+${reward.gems} gem`);
    xp.textContent = parts.join(' ');
  } else {
    xp.textContent = '+?? XP';
  }
  container.appendChild(xp);
  // Golden flash on the card
  const flash = document.createElement('div');
  flash.className = 'qr-flash';
  card.style.position = 'relative';
  card.appendChild(flash);
  // Cleanup
  setTimeout(() => {
    container.remove();
    flash.remove();
    card.classList.remove('quest-card--rewarding');
  }, 2400);
}

function _refreshQuestCards() {
  fetch('/quests').then(r => r.json()).then(quests => _renderQuestCards(quests)).catch(() => {});
}

// Load quest log from DB on startup
function _loadQuestLog() {
  // 1) Structured quest cards
  _refreshQuestCards();
  // 2) Recent events for the flat log (All/Speech/Reports tabs)
  fetch('/events?limit=50').then(r => r.json()).then(events => {
    events.filter(e => e.text && !_dismissedQuests.includes(e.text)).forEach((e, i) => {
      setTimeout(() => addLogEntry(e), i * 50);
    });
  }).catch(() => {});
}
setTimeout(() => {
  addLogEntry({ type: 'system', node: 'katana', text: 'The Realm Map has been inscribed.', ts: Date.now()/1000 });
  _loadQuestLog();
  // Load player stats into dock HUD
  fetch('/player').then(r => r.json()).then(stats => {
    window.updateDockHUD?.(stats, false);
  }).catch(() => {});
}, 800);

// Track active speech bubbles for repositioning during drag
const _activeBubbles = new Set();

function _positionBubble(bubble) {
  let nodeEl = bubble._nodeEl;
  // Re-find node if reference is stale (happens after topology refresh)
  if (!nodeEl || !nodeEl.isConnected) {
    if (bubble._nodeId) {
      nodeEl = document.querySelector(`[data-tip="${bubble._nodeId}"]`);
      if (nodeEl) bubble._nodeEl = nodeEl;
    }
  }
  if (!nodeEl || !nodeEl.isConnected) return;
  const nodeLeft = parseInt(nodeEl.style.left) || 0;
  const nodeTop = parseInt(nodeEl.style.top) || 0;
  const icon = nodeEl.querySelector('.node-icon');
  const iconW = icon ? icon.offsetWidth : 64;
  bubble.style.left = (nodeLeft + iconW / 2 - bubble.offsetWidth / 2) + 'px';
  bubble.style.top = (nodeTop - bubble.offsetHeight - 12) + 'px';
}

export function updateBubblePositions() {
  _activeBubbles.forEach(b => {
    if (!b.isConnected) { _activeBubbles.delete(b); return; }
    _positionBubble(b);
  });
}

// Register hook so topology refresh updates bubbles, search index, ghost lines
setTopologyRefreshHook(() => {
  updateBubblePositions();
  _searchIndex = null;
  _ghostDirty = true;
});

function _dismissBubble(bubble) {
  bubble.style.animation = 'bubbleOut 0.3s ease-in forwards';
  setTimeout(() => { bubble.remove(); _activeBubbles.delete(bubble); }, 300);
}

export function showSpeechBubble(nodeEl, evt, isAlert) {
  // One bubble per node, period — latest event wins
  const dismissList = [];
  for (const b of _activeBubbles) {
    if (b._nodeId === evt.node) dismissList.push(b);
  }
  for (const b of dismissList) _dismissBubble(b);

  const bubble = document.createElement('div');
  const isQuest = evt.type === 'quest';
  const isNotion = evt._source === 'notion';
  let cls = 'speech-bubble';
  if (isAlert) cls += ' alert-bubble';
  if (isQuest) cls += ' quest-bubble';
  if (isNotion) cls += ' notion-bubble';
  bubble.className = cls;
  bubble._nodeEl = nodeEl;
  bubble._nodeId = evt.node;
  const name = nodeEl.querySelector('.node-label')?.textContent || evt.node;

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close';
  closeBtn.innerHTML = '\u00D7';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _dismissBubble(bubble);
  });

  const prefix = isNotion ? '<span style="color:#a080e0">&#127744;</span> ' : (isQuest ? '<span style="color:#c090ff">&#9733;</span> ' : '');
  bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${prefix}${evt.text || ''}</div>`;
  bubble.appendChild(closeBtn);
  if (evt.color) bubble.style.borderColor = evt.color;

  // Click bubble to open chat with this node's context
  bubble.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    openNodeChat(evt.node, evt.text);
  });
  bubble.style.cursor = 'pointer';

  const world = document.getElementById('map-world');
  world.appendChild(bubble);
  _positionBubble(bubble);
  _activeBubbles.add(bubble);
  // Respect visibility toggle
  if (window._visState && window._visState['.speech-bubble'] === false) bubble.style.visibility = 'hidden';
  // Float above globe surface when tilted
  if (_mapTilt > 0) {
    const bz = _mapTilt * 5 + _mapTilt * 3 + _mapTilt * 8 + _mapTilt * 3;
    bubble.style.translate = `0px 0px ${bz}px`;
    bubble.style.rotate = `x ${-_mapTilt}deg`;
  }

  // All bubbles stay until manually closed (no auto-dismiss)
}

export function showHighlight(nodeEl, evt) {
  const iconEl = nodeEl.querySelector('.node-icon');
  if (!iconEl) return;
  const flash = document.createElement('div');
  flash.className = 'node-highlight';
  if (evt.color) {
    flash.style.animation = 'none';
    flash.style.boxShadow = `0 0 30px 15px ${evt.color}`;
    flash.style.animation = 'highlightFlash 1.5s ease-out forwards';
  }
  iconEl.appendChild(flash);
  setTimeout(() => flash.remove(), 1500);
}

// ── Pulse visual (cached refs) ──
const _pulseCore = document.getElementById('pulse-core');
const _pulseRing1 = document.getElementById('pulse-ring1');
const _pulseRing2 = document.getElementById('pulse-ring2');
const _pulseLabel = document.getElementById('pulse-label');
const _scanLine = document.getElementById('scan-line');

export function firePulse() {
  const core = _pulseCore, ring1 = _pulseRing1, ring2 = _pulseRing2;
  const label = _pulseLabel, scan = _scanLine;

  // Core glow
  core.style.background = '#a0ff60';
  core.style.boxShadow = '0 0 12px rgba(160,255,96,0.8), 0 0 4px rgba(160,255,96,0.4)';
  setTimeout(() => {
    core.style.background = '#60a040';
    core.style.boxShadow = '0 0 6px rgba(96,160,64,0.4)';
  }, 600);

  // Expanding rings
  ring1.style.animation = 'none';
  ring2.style.animation = 'none';
  void ring1.offsetWidth; // force reflow
  ring1.style.animation = 'dataPulse1 0.8s ease-out forwards';
  ring2.style.animation = 'dataPulse2 1.1s ease-out 0.1s forwards';

  // Label
  label.textContent = 'LIVE';
  label.style.color = '#a0c070';

  // Scan line across the map
  scan.style.animation = 'none';
  void scan.offsetWidth;
  scan.style.animation = 'scanPass 1.2s ease-in-out forwards';
}

export function showOffline() {
  if (_pulseCore) { _pulseCore.style.background = '#804040'; _pulseCore.style.boxShadow = 'none'; }
  if (_pulseLabel) { _pulseLabel.textContent = 'OFFLINE'; _pulseLabel.style.color = '#604040'; }
}

// ── Polling removed — SSE replaces it (see initSSE below) ──

// ── Pan & zoom ──
const canvas = document.getElementById('map-canvas');
const world = document.getElementById('map-world');
// Cache canvas rect — getBoundingClientRect on every wheel event forces synchronous layout
let _canvasRect = canvas.getBoundingClientRect();
export let scale = 1, panX = 0, panY = 0;
let dragging = false, lastX, lastY;

let _lastGlobeTilt = 0;

// ── Ghost ley-lines — half-res canvas shown during zoom/pan ──
// Pre-renders SVG connection curves onto a canvas bitmap using Path2D.
// Single raster layer = zero per-element compositing cost during zoom.
const _GHOST_VLAN_COLORS = {
  0:[100,220,220], 3:[180,120,100], 4:[120,110,100], 5:[160,100,180],
  6:[140,180,255], 7:[255,160,100], 8:[200,140,255], 9:[100,180,180],
  10:[100,220,160], 11:[255,200,100], 12:[140,140,160], 20:[140,140,160],
  38:[255,100,130]
};
let _ghostCanvas = null;
let _ghostDirty = true;

// Connection class → ghost rendering style
const _GHOST_CONN_STYLE = {
  'conn-wan':     { sw: 3.5, alpha: 0.5,  glow: true, dash: null },
  'conn-bridge':  { sw: 3,   alpha: 0.45, glow: true, dash: [12, 4, 2, 4] },
  'conn-portal':  { sw: 2.5, alpha: 0.4,  glow: true, dash: [3, 6, 1, 6] },
  'conn-infra':   { sw: 2.5, alpha: 0.4,  glow: false, dash: null },
  'conn-active':  { sw: 2,   alpha: 0.35, glow: false, dash: [8, 4] },
  'conn-vlan':    { sw: 1.8, alpha: 0.28, glow: false, dash: [6, 3] },
  'conn-ap':      { sw: 1.5, alpha: 0.2,  glow: false, dash: [4, 6] },
  'conn-mesh':    { sw: 1.5, alpha: 0.2,  glow: false, dash: [4, 6] },
  'conn-offline': { sw: 1,   alpha: 0.1,  glow: false, dash: [2, 8] },
};

function _getConnStyle(path) {
  for (const cls of Object.keys(_GHOST_CONN_STYLE)) {
    if (path.classList.contains(cls)) return _GHOST_CONN_STYLE[cls];
  }
  return { sw: 1.5, alpha: 0.25, glow: false, dash: [8, 4] };
}

function _renderGhostLines() {
  if (!_topology || !_connPaths.length) return;
  if (!_ghostCanvas) {
    _ghostCanvas = document.createElement('canvas');
    _ghostCanvas.id = 'ghost-lines';
    // Half resolution — smooth CSS upscale gives ethereal soft look
    _ghostCanvas.width = Math.round(WORLD_W / 2);
    _ghostCanvas.height = Math.round(WORLD_H / 2);
    world.appendChild(_ghostCanvas);
  }
  const ctx = _ghostCanvas.getContext('2d');
  ctx.clearRect(0, 0, _ghostCanvas.width, _ghostCanvas.height);
  ctx.save();
  ctx.scale(0.5, 0.5);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // First pass: glow layer (wider, soft, low opacity)
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    const style = _getConnStyle(path);
    if (!style.glow) continue;
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];
    ctx.strokeStyle = `rgba(${r},${g},${b},${style.alpha * 0.3})`;
    ctx.lineWidth = style.sw + 6;
    ctx.setLineDash([]);
    ctx.stroke(new Path2D(d));
  }

  // Second pass: main lines with proper dash patterns
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    // Skip hidden connections
    if (path.style.display === 'none' || path.getAttribute('opacity') === '0') continue;
    const style = _getConnStyle(path);
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];

    // WAN lines use gold instead of VLAN color
    const isWan = path.classList.contains('conn-wan');
    const cr = isWan ? 255 : r;
    const cg = isWan ? 180 : g;
    const cb = isWan ? 50 : b;

    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${style.alpha})`;
    ctx.lineWidth = style.sw;
    ctx.setLineDash(style.dash || []);
    ctx.stroke(new Path2D(d));
  }

  // Third pass: bright core on bridges and portals
  for (const path of _connPaths) {
    if (!path) continue;
    const d = path.getAttribute('d');
    if (!d) continue;
    const isBridge = path.classList.contains('conn-bridge');
    const isPortal = path.classList.contains('conn-portal');
    if (!isBridge && !isPortal) continue;
    const v = path.dataset.vlan || '6';
    const [r, g, b] = _GHOST_VLAN_COLORS[+v] || [140, 180, 255];
    ctx.strokeStyle = `rgba(${r},${g},${b},0.5)`;
    ctx.lineWidth = 1;
    ctx.setLineDash(isBridge ? [2, 6] : [1, 4]);
    ctx.stroke(new Path2D(d));
  }

  ctx.restore();
  _ghostDirty = false;
}

// During active zoom/pan, strip heavy layers (display:none) then promote world to
// a single GPU layer (will-change:transform). With heavy layers gone, the texture
// is just 87 small icons + ghost canvas — well within VRAM.  Sequence matters:
//   Frame 0: add .zooming (display:none strips layers from paint tree)
//   Frame 1: set will-change:transform (browser rasterizes the now-lightweight world)
//   Frame 2+: GPU scales the cached raster — zero main-thread paint work
let _zoomActive = false;
let _zoomIdleTimer = 0;
let _zoomWillChangeRaf = 0;
function _enterZoomMode() {
  if (!_zoomActive) {
    _zoomActive = true;
    if (_ghostDirty) _renderGhostLines();
    world.classList.add('zooming');
    // Delay will-change by one frame so display:none takes effect first
    _zoomWillChangeRaf = requestAnimationFrame(() => {
      _zoomWillChangeRaf = 0;
      if (_zoomActive) world.style.willChange = 'transform';
    });
  }
  clearTimeout(_zoomIdleTimer);
  _zoomIdleTimer = setTimeout(_exitZoomMode, 400);
}
function _exitZoomMode() {
  _zoomActive = false;
  if (_zoomWillChangeRaf) { cancelAnimationFrame(_zoomWillChangeRaf); _zoomWillChangeRaf = 0; }
  world.style.willChange = '';
  world.classList.remove('zooming');
  _updateSparkleRect();
}

// ═══════════════════════════════════════════════════════════
// ENCHANTED VINES — procedural fantasy botanical overlay
// ═══════════════════════════════════════════════════════════
(function _generateVines() {
  const svg = document.getElementById('enchanted-vines');
  if (!svg) return;

  const W = 4800, H = 3300;
  const ns = 'http://www.w3.org/2000/svg';

  // Seeded random for reproducibility
  let _seed = 42;
  function rand() { _seed = (_seed * 16807 + 0) % 2147483647; return (_seed - 1) / 2147483646; }
  function randRange(a, b) { return a + rand() * (b - a); }

  // Color palettes — muted greens/golds/teals
  const vineColors = [
    'rgba(60,100,50,0.4)', 'rgba(40,80,45,0.35)', 'rgba(50,90,40,0.3)',
    'rgba(70,110,55,0.25)', 'rgba(45,85,50,0.35)',
  ];
  const leafColors = [
    'rgba(70,120,55,0.45)', 'rgba(50,100,45,0.4)', 'rgba(80,130,60,0.35)',
    'rgba(60,110,50,0.5)', 'rgba(90,140,70,0.3)',
  ];
  const bloomColors = [
    'rgba(200,160,80,0.4)', 'rgba(180,140,100,0.35)', 'rgba(160,120,180,0.3)',
    'rgba(140,180,200,0.25)', 'rgba(220,180,100,0.35)',
  ];
  const glowColors = [
    'rgba(140,200,120,0.15)', 'rgba(100,180,140,0.12)', 'rgba(180,200,100,0.1)',
  ];

  // Add SVG defs for glow filter
  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `
    <filter id="vine-glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="vine-soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2"/>
    </filter>`;
  svg.appendChild(defs);

  // Generate a single vine tendril as a cubic bezier chain
  function generateTendril(startX, startY, angle, length, depth) {
    const points = [{ x: startX, y: startY }];
    let x = startX, y = startY, a = angle;
    const segments = Math.floor(length / 40) + 2;

    for (let i = 0; i < segments; i++) {
      const segLen = randRange(30, 60) * (1 - depth * 0.15);
      a += randRange(-0.4, 0.4);
      x += Math.cos(a) * segLen;
      y += Math.sin(a) * segLen;
      points.push({ x, y });
    }

    // Build smooth curve through points
    let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 5;
      const cp1y = p1.y + (p2.y - p0.y) / 5;
      const cp2x = p2.x - (p3.x - p1.x) / 5;
      const cp2y = p2.y - (p3.y - p1.y) / 5;
      d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }

    return { d, points, angle: a };
  }

  // Place a leaf shape at a point
  function createLeaf(x, y, angle, size) {
    const la = angle + randRange(-0.5, 0.5);
    const lx = Math.cos(la), ly = Math.sin(la);
    const px = -ly, py = lx; // perpendicular
    const s = size * randRange(0.6, 1.2);
    const tipX = x + lx * s * 2, tipY = y + ly * s * 2;
    const w = s * 0.5;
    return `M${x.toFixed(1)},${y.toFixed(1)} C${(x + lx * s * 0.5 + px * w).toFixed(1)},${(y + ly * s * 0.5 + py * w).toFixed(1)} ${(tipX - lx * s * 0.3 + px * w * 0.3).toFixed(1)},${(tipY - ly * s * 0.3 + py * w * 0.3).toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)} C${(tipX - lx * s * 0.3 - px * w * 0.3).toFixed(1)},${(tipY - ly * s * 0.3 - py * w * 0.3).toFixed(1)} ${(x + lx * s * 0.5 - px * w).toFixed(1)},${(y + ly * s * 0.5 - py * w).toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  }

  // Build full vine system from an origin
  function buildVineCluster(ox, oy, mainAngle, mainLen) {
    const g = document.createElementNS(ns, 'g');
    const animDelay = randRange(0, 5);

    // Main tendril
    const main = generateTendril(ox, oy, mainAngle, mainLen, 0);
    const mainPath = document.createElementNS(ns, 'path');
    mainPath.setAttribute('d', main.d);
    mainPath.setAttribute('class', 'vine-tendril');
    mainPath.setAttribute('stroke', vineColors[Math.floor(rand() * vineColors.length)]);
    mainPath.setAttribute('stroke-width', randRange(1.5, 3).toFixed(1));
    g.appendChild(mainPath);

    // Side branches
    for (let i = 2; i < main.points.length - 1; i++) {
      if (rand() > 0.5) continue;
      const p = main.points[i];
      const branchAngle = main.angle + (rand() > 0.5 ? 1 : -1) * randRange(0.5, 1.2);
      const branch = generateTendril(p.x, p.y, branchAngle, mainLen * randRange(0.2, 0.45), 1);
      const bp = document.createElementNS(ns, 'path');
      bp.setAttribute('d', branch.d);
      bp.setAttribute('class', 'vine-tendril');
      bp.setAttribute('stroke', vineColors[Math.floor(rand() * vineColors.length)]);
      bp.setAttribute('stroke-width', randRange(0.8, 1.5).toFixed(1));
      g.appendChild(bp);

      // Leaves on branches
      for (const lp of branch.points) {
        if (rand() > 0.35) continue;
        const leaf = document.createElementNS(ns, 'path');
        leaf.setAttribute('d', createLeaf(lp.x, lp.y, branchAngle, randRange(6, 14)));
        leaf.setAttribute('class', 'vine-leaf');
        leaf.setAttribute('fill', leafColors[Math.floor(rand() * leafColors.length)]);
        g.appendChild(leaf);
      }

      // Occasional bloom on branch tip
      if (rand() > 0.6) {
        const tip = branch.points[branch.points.length - 1];
        const bloom = document.createElementNS(ns, 'circle');
        bloom.setAttribute('cx', tip.x.toFixed(1));
        bloom.setAttribute('cy', tip.y.toFixed(1));
        bloom.setAttribute('r', randRange(3, 7).toFixed(1));
        bloom.setAttribute('class', 'vine-bloom');
        bloom.setAttribute('fill', bloomColors[Math.floor(rand() * bloomColors.length)]);
        bloom.setAttribute('filter', 'url(#vine-glow)');
        g.appendChild(bloom);
      }
    }

    // Leaves on main tendril
    for (let i = 1; i < main.points.length; i++) {
      if (rand() > 0.4) continue;
      const p = main.points[i];
      const segAngle = i > 0 ? Math.atan2(p.y - main.points[i - 1].y, p.x - main.points[i - 1].x) : mainAngle;
      const side = rand() > 0.5 ? 1 : -1;
      const leaf = document.createElementNS(ns, 'path');
      leaf.setAttribute('d', createLeaf(p.x, p.y, segAngle + side * randRange(0.6, 1.2), randRange(8, 18)));
      leaf.setAttribute('class', 'vine-leaf');
      leaf.setAttribute('fill', leafColors[Math.floor(rand() * leafColors.length)]);
      g.appendChild(leaf);
    }

    // Glow motes scattered along vine
    for (let i = 0; i < 3; i++) {
      const p = main.points[Math.floor(rand() * main.points.length)];
      const mote = document.createElementNS(ns, 'circle');
      mote.setAttribute('cx', (p.x + randRange(-15, 15)).toFixed(1));
      mote.setAttribute('cy', (p.y + randRange(-15, 15)).toFixed(1));
      mote.setAttribute('r', randRange(4, 10).toFixed(1));
      mote.setAttribute('fill', glowColors[Math.floor(rand() * glowColors.length)]);
      mote.setAttribute('filter', 'url(#vine-soft)');
      g.appendChild(mote);
    }

    g.style.animation = `vine-sway ${randRange(6, 12).toFixed(1)}s ease-in-out ${animDelay.toFixed(1)}s infinite`;
    return g;
  }

  // Spawn vine clusters around edges and scattered across the map
  // Edge vines — grow inward from borders, extended well past edges to avoid visible boundary
  const edgeSpawns = [
    // Top edge
    ...Array.from({length: 10}, () => ({ x: randRange(-200, W + 200), y: randRange(-120, 60), a: randRange(1.2, 1.9) })),
    // Bottom edge
    ...Array.from({length: 10}, () => ({ x: randRange(-200, W + 200), y: randRange(H - 60, H + 120), a: randRange(-1.9, -1.2) })),
    // Left edge
    ...Array.from({length: 8}, () => ({ x: randRange(-120, 60), y: randRange(-100, H + 100), a: randRange(-0.4, 0.4) })),
    // Right edge
    ...Array.from({length: 8}, () => ({ x: randRange(W - 60, W + 120), y: randRange(-100, H + 100), a: randRange(2.7, 3.5) })),
  ];

  for (const s of edgeSpawns) {
    svg.appendChild(buildVineCluster(s.x, s.y, s.a, randRange(200, 500)));
  }

  // Interior vines — shorter, more decorative
  for (let i = 0; i < 20; i++) {
    const x = randRange(200, W - 200);
    const y = randRange(200, H - 200);
    const a = randRange(0, Math.PI * 2);
    svg.appendChild(buildVineCluster(x, y, a, randRange(80, 250)));
  }

  // Corner flourishes — dense clusters in corners, extended outward
  const corners = [
    { x: -30, y: -30, a: 0.8 }, { x: W + 30, y: -30, a: 2.3 },
    { x: -30, y: H + 30, a: -0.8 }, { x: W + 30, y: H + 30, a: -2.3 },
  ];
  for (const c of corners) {
    for (let i = 0; i < 5; i++) {
      svg.appendChild(buildVineCluster(c.x + randRange(-60, 60), c.y + randRange(-60, 60), c.a + randRange(-0.6, 0.6), randRange(300, 600)));
    }
  }
})();

// rAF-batched transform: multiple wheel/touch events per frame collapse into one DOM write
let _transformRafId = 0;
function _applyTransformNow() {
  _transformRafId = 0;
  if (_mapTilt > 0) {
    canvas.classList.add('tilted');
    world.style.transformStyle = 'preserve-3d';
    world.style.zoom = '';
    const cx = WORLD_W / 2, cy = WORLD_H / 2;
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) translate(${cx}px, ${cy}px) rotateX(${_mapTilt}deg) translate(${-cx}px, ${-cy}px)`;
    if (_mapTilt !== _lastGlobeTilt) {
      _applyGlobeZ();
      _lastGlobeTilt = _mapTilt;
    }
  } else {
    canvas.classList.remove('tilted');
    if (_lastGlobeTilt !== 0) {
      _clearGlobeZ();
      _lastGlobeTilt = 0;
    }
    world.style.transformStyle = '';
    world.style.zoom = '';
    // transform: scale() is compositor-only (no layout reflow).
    // During zoom, will-change: transform caches the raster so GPU just scales the bitmap.
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }
}

export function applyTransform() {
  if (!_transformRafId) _transformRafId = requestAnimationFrame(_applyTransformNow);
}

// Spherical dome: nodes at center pop toward viewer, edges recede
// Topo bands become 3D peaks; nodes float above and face the camera
function _applyGlobeZ() {
  if (!_topology) return;
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const maxD2 = cx * cx + cy * cy;
  const R = _mapTilt * 8;        // dome curvature
  const peakH = _mapTilt * 5;    // topo peak height
  const nodeFloat = _mapTilt * 3; // node hover above peaks
  const counterRot = `x ${-_mapTilt}deg`; // billboard — face the camera

  // 3D topo peaks — each contour band at its elevation Z
  const topoEl = document.getElementById('topo-svg');
  if (topoEl) {
    topoEl.style.transformStyle = 'preserve-3d';
    topoEl.querySelectorAll('.topo-band').forEach(band => {
      const elev = parseFloat(band.dataset.elev) || 0;
      band.style.translate = `0px 0px ${elev * peakH}px`;
    });
  }

  // Connection lines float at mid-peak height
  const connSvg = document.getElementById('connections');
  if (connSvg) connSvg.style.translate = `0px 0px ${peakH * 0.4}px`;

  // Region labels at peak level, face camera
  const regionEl = document.getElementById('region-labels');
  if (regionEl) {
    regionEl.style.translate = `0px 0px ${peakH * 0.7}px`;
    regionEl.style.rotate = counterRot;
  }

  // Per-node dome Z + float; counter-rotate to face camera (billboard)
  for (const n of _topology.nodes) {
    const el = _nodeElCache[n.id] || document.querySelector(`[data-tip="${n.id}"]`);
    if (!el) continue;
    const dx = n.x - cx, dy = n.y - cy;
    const d2 = (dx * dx + dy * dy) / maxD2;
    const dome = R * Math.max(0, 1 - d2);
    const z = peakH + nodeFloat + dome;
    el.style.translate = `0px 0px ${z}px`;
    el.style.rotate = counterRot;
  }

  // Speech bubbles float high, face camera
  const bubbleZ = peakH + nodeFloat + R + _mapTilt * 3;
  document.querySelectorAll('.speech-bubble').forEach(b => {
    b.style.translate = `0px 0px ${bubbleZ}px`;
    b.style.rotate = counterRot;
  });
}

function _applyTopoZ() {
  const peakH = _mapTilt * 5;
  const topoEl = document.getElementById('topo-svg');
  if (!topoEl) return;
  topoEl.style.transformStyle = 'preserve-3d';
  topoEl.querySelectorAll('.topo-band').forEach(band => {
    const elev = parseFloat(band.dataset.elev) || 0;
    band.style.translate = `0px 0px ${elev * peakH}px`;
  });
}

function _clearGlobeZ() {
  if (!_topology) return;
  for (const n of _topology.nodes) {
    const el = _nodeElCache[n.id] || document.querySelector(`[data-tip="${n.id}"]`);
    if (el) { el.style.translate = ''; el.style.rotate = ''; }
  }
  const topoEl = document.getElementById('topo-svg');
  const connSvg = document.getElementById('connections');
  const regionEl = document.getElementById('region-labels');
  if (topoEl) {
    topoEl.style.transformStyle = '';
    topoEl.querySelectorAll('.topo-band').forEach(b => { b.style.translate = ''; });
  }
  if (connSvg) connSvg.style.translate = '';
  if (regionEl) { regionEl.style.translate = ''; regionEl.style.rotate = ''; }
  document.querySelectorAll('.speech-bubble').forEach(b => { b.style.translate = ''; b.style.rotate = ''; });
}

export function centerMap() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = Math.min(cw / WORLD_W, ch / WORLD_H) * 1.2;
  panX = (cw - WORLD_W * scale) / 2;
  panY = (ch - WORLD_H * scale) / 2;
  applyTransform();
}

export function panToNode(x, y) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = 1.2;
  panX = cw / 2 - x * scale;
  panY = ch / 2 - y * scale;
  applyTransform();
}

canvas.addEventListener('mousedown', e => {
  // Don't start pan if clicking an interactive element (bubble, panel, button)
  if (e.target.closest('.speech-bubble, .panel, button, a, input, textarea, select')) return;
  dragging = true;
  lastX = e.clientX; lastY = e.clientY;
  _enterZoomMode();  // Activate immediately — prevents repaint gap between zoom→pan
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  _enterZoomMode();  // Lock raster for pan too
  panX += e.clientX - lastX;
  panY += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyTransform();
});
window.addEventListener('mouseup', () => { if (dragging) { dragging = false; saveSettings(); } });

// ── Touch: pan & pinch-to-zoom ──
let _touchPanning = false, _lastTouch = null, _pinchDist = null;
canvas.addEventListener('touchstart', e => {
  if (e.target.closest('.speech-bubble, .panel, button, a, input, textarea, select')) return;
  _enterZoomMode();  // Activate immediately on touch
  if (e.touches.length === 2) {
    _pinchDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    _touchPanning = false;
  } else if (e.touches.length === 1) {
    _touchPanning = true;
    _lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
}, { passive: true });
canvas.addEventListener('touchmove', e => {
  _enterZoomMode();  // Lock raster BEFORE transform changes
  if (e.touches.length === 2 && _pinchDist !== null) {
    e.preventDefault();
    const newDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const mx = midX - _canvasRect.left, my = midY - _canvasRect.top;
    const oldScale = scale;
    scale = Math.max(0.1, Math.min(3, scale * (newDist / _pinchDist)));
    panX = mx - (mx - panX) * (scale / oldScale);
    panY = my - (my - panY) * (scale / oldScale);
    _pinchDist = newDist;
    applyTransform();
  } else if (_touchPanning && e.touches.length === 1 && _lastTouch) {
    const t = e.touches[0];
    panX += t.clientX - _lastTouch.x;
    panY += t.clientY - _lastTouch.y;
    _lastTouch = { x: t.clientX, y: t.clientY };
    applyTransform();
  }
}, { passive: false });
canvas.addEventListener('touchend', () => {
  if (_touchPanning || _pinchDist) saveSettings();
  _touchPanning = false; _lastTouch = null; _pinchDist = null;
}, { passive: true });

let _zoomSaveTimer = null;
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  _enterZoomMode();  // Lock raster BEFORE transform changes
  const mx = e.clientX - _canvasRect.left, my = e.clientY - _canvasRect.top;
  const oldScale = scale;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  scale = Math.max(0.1, Math.min(3, scale * delta));
  panX = mx - (mx - panX) * (scale / oldScale);
  panY = my - (my - panY) * (scale / oldScale);
  applyTransform();
  clearTimeout(_zoomSaveTimer);
  _zoomSaveTimer = setTimeout(saveSettings, 800);
}, { passive: false });

// ── Tooltips (delegated — survives topology refresh) ──
const tooltip = document.getElementById('tooltip');
let _tipNode = null;
document.getElementById('map-world').addEventListener('mouseover', e => {
  const node = e.target.closest('.realm-node');
  if (!node || node === _tipNode) return;
  _tipNode = node;
  const key = node.dataset.tip;
  const data = tips[key];
  if (!data) return;
  let html = `<h3>${data.title}</h3>`;
  data.stats.forEach(([k, v]) => {
    html += `<div class="stat-line"><span>${k}</span><span class="stat-val">${v}</span></div>`;
  });
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
});
document.getElementById('map-world').addEventListener('mousemove', e => {
  if (_tipNode) {
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top = (e.clientY + 16) + 'px';
  }
});
document.getElementById('map-world').addEventListener('mouseout', e => {
  const node = e.target.closest('.realm-node');
  if (!node) return;
  const related = e.relatedTarget?.closest?.('.realm-node');
  if (related === node) return;
  if (_tipNode === node) _tipNode = null;
  tooltip.style.display = 'none';
});

// Minimap removed — seal/dock system and search provide navigation

// Init — centerMap sets default; restoreSettings (later) overrides with saved zoom/pan
centerMap();
// On resize, preserve current zoom — just refresh the canvas rect cache
window.addEventListener('resize', () => { _canvasRect = canvas.getBoundingClientRect(); });

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
    const groupConfig = lastStatus?.groups?.[nodeKey];
    const hasMembers = groupConfig && (
      Array.isArray(groupConfig.entities) ? groupConfig.entities.length > 1 :
      typeof groupConfig.entities === 'object' ? Object.keys(groupConfig.entities).length > 1 : false
    );
    groupTab.style.display = hasMembers ? '' : 'none';
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
  peHints.innerHTML = '';
  peHintsList.forEach((hint, i) => {
    const tag = document.createElement('span');
    tag.className = 'pe-hint-tag';
    tag.innerHTML = `${hint} <span class="hint-x" data-idx="${i}">&times;</span>`;
    peHints.appendChild(tag);
  });
  peHints.querySelectorAll('.hint-x').forEach(x => {
    x.addEventListener('click', () => {
      peHintsList.splice(parseInt(x.dataset.idx), 1);
      renderHints();
    });
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
      // Update the codex persona list if visible
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
    if (target === 'control') renderControlPane(currentEditNode);
    if (target === 'group') renderGroupPane(currentEditNode);
    if (target === 'shell') { renderShellPane(currentEditNode); _shellInput.focus(); }
    if (target === 'links') renderConnectionsPane(currentEditNode);
  });
});

function _switchToTab(name) {
  document.querySelectorAll('.pe-tab').forEach(t => t.classList.toggle('active', t.dataset.peTab === name));
  document.querySelectorAll('.pe-pane').forEach(p => p.style.display = 'none');
  document.getElementById('pe-pane-' + name).style.display = '';
  if (name === 'stats') startStatsRefresh();
  else stopStatsRefresh();
  if (name === 'node') renderNodePane(currentEditNode);
  if (name === 'control') renderControlPane(currentEditNode);
  if (name === 'group') renderGroupPane(currentEditNode);
  if (name === 'shell') renderShellPane(currentEditNode);
  if (name === 'links') renderConnectionsPane(currentEditNode);
}

function startStatsRefresh() {
  stopStatsRefresh();
  renderStatsPane(currentEditNode);
  _statsInterval = setInterval(() => renderStatsPane(currentEditNode), 5000);
}
function stopStatsRefresh() {
  if (_statsInterval) { clearInterval(_statsInterval); _statsInterval = null; }
}

// ── Node Properties Tab ──
const _nodeFields = ['label','sublabel','icon','type','ip','mac','collectd','x','y','ssh','tshost'];
function renderNodePane(nodeKey) {
  if (!nodeKey || !_topology) return;
  const node = _topology.nodes.find(n => n.id === nodeKey);
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
  el('ssh').value = node.ssh || '';
  el('tshost').value = node.tsHost || '';
}

document.getElementById('pe-node-save')?.addEventListener('click', () => {
  if (!currentEditNode || !_topology) return;
  const node = _topology.nodes.find(n => n.id === currentEditNode);
  if (!node) return;
  const el = id => document.getElementById('pe-node-' + id);
  node.label = el('label').value;
  node.sublabel = el('sublabel').value;
  node.icon = el('icon').value;
  node.type = el('type').value;
  node.ip = el('ip').value;
  node.mac = el('mac').value || undefined;
  node.collectd = el('collectd').value || undefined;
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
      const scale = WORLD_SCALE || 1;
      node.x = Math.round(nx * scale);
      node.y = Math.round(ny * scale);
      // Update DOM
      const domNode = document.querySelector(`[data-tip="${currentEditNode}"]`);
      if (domNode) {
        domNode.style.left = node.x + 'px';
        domNode.style.top = node.y + 'px';
        const lbl = domNode.querySelector('.node-label');
        if (lbl) lbl.textContent = node.label;
        const sub = domNode.querySelector('.node-sublabel');
        if (sub) sub.innerHTML = node.sublabel;
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
  titleEl.textContent = nodeName + ' — Scrying';

  if (!lastStatus) {
    body.innerHTML = '<div class="pe-stats-empty">No scrying data available.</div>';
    return;
  }
  const cd = lastStatus.collectd ? findCollectd(lastStatus.collectd, nodeKey, null) : null;
  const tsHost = info && info.tsHost;
  const tsPeer = tsHost && lastStatus.tailscale && lastStatus.tailscale.peers ? lastStatus.tailscale.peers[tsHost] : null;
  const wifiInfo = lastStatus.wifi ? lastStatus.wifi[nodeKey] : null;
  const haInfo = lastStatus.ha ? lastStatus.ha[nodeKey] : null;
  const wledInfo = lastStatus.wled ? lastStatus.wled[nodeKey] : null;
  const nodeRole = lastStatus.roles ? lastStatus.roles[nodeKey] : null;
  const topoNode = _topology ? _topology.nodes.find(n => n.id === nodeKey) : null;
  if (!cd && !tsPeer && !wifiInfo && !haInfo && !wledInfo && !topoNode) {
    body.innerHTML = '<div class="pe-stats-empty">No sigils bound to this node.</div>';
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
    const apLabel = _topology?.nodes.find(n => n.id === wifiInfo.ap)?.label || wifiInfo.ap;
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
    // Parse sublabel for structured display
    const sublabel = haInfo.sublabel || '';
    if (sublabel.includes('°F')) {
      // Thermostat: "68°F • idle" or "68°F avg • 0/5 active"
      const parts = sublabel.split(' • ');
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Temperature</span><span class="pe-stat-val">${parts[0]}</span></div>`;
      if (parts[1]) html += `<div class="pe-stat-row"><span class="pe-stat-label">State</span><span class="pe-stat-val">${parts[1]}</span></div>`;
    } else if (sublabel.includes('kW') || sublabel.includes('Batt')) {
      // Solar: "☀ 2.5kW generating • Batt 52.8V"
      const parts = sublabel.split(' • ');
      parts.forEach(p => {
        if (p.includes('kW')) html += `<div class="pe-stat-row"><span class="pe-stat-label">Power</span><span class="pe-stat-val">${p}</span></div>`;
        else if (p.includes('Batt')) html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${p}</span></div>`;
      });
    } else if (sublabel.includes('%') && !sublabel.includes('on')) {
      // Battery or percentage: "🔋 62%"
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${sublabel}</span></div>`;
    } else if (sublabel.includes('/') && sublabel.includes('on')) {
      // Switch cluster: "4/12 on"
      const [on, total] = sublabel.match(/(\d+)\/(\d+)/)?.slice(1) || [];
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Active</span><span class="pe-stat-val">${on} of ${total}</span></div>`;
    } else if (sublabel.includes('Radar:')) {
      // Radar sensor
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Presence</span><span class="pe-stat-val">${sublabel.replace('Radar: ', '')}</span></div>`;
    } else {
      // Generic status
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
    // Only show if we have rows and no other major section
    if (nodeRows.length && !cd) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Node Info</div>';
      nodeRows.forEach(([l, v]) => html += `<div class="pe-stat-row"><span class="pe-stat-label">${l}</span><span class="pe-stat-val">${v}</span></div>`);
      html += '</div>';
    }
  }

  body.innerHTML = html;
}

// ── Control Tab ──
function renderControlPane(nodeKey) {
  const body = document.getElementById('pe-control-body');
  const titleEl = document.getElementById('pe-control-title');
  const statusEl = document.getElementById('pe-control-status');
  if (!body) return;

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
  const topoNode = _topology ? _topology.nodes.find(n => n.id === nodeKey) : null;

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
function renderGroupPane(nodeKey) {
  const body = document.getElementById('pe-group-body');
  const titleEl = document.getElementById('pe-group-title');
  const countEl = document.getElementById('pe-group-count');
  if (!body) return;

  const groupConfig = lastStatus?.groups?.[nodeKey];
  if (!groupConfig || !groupConfig.entities) {
    body.innerHTML = '<div class="pe-stats-empty">Not a group node.</div>';
    return;
  }

  const entities = groupConfig.entities;
  const fnType = groupConfig.fn || '';
  const also = groupConfig.also || [];

  // Get entity states from HA
  const allStates = lastStatus?._ha_raw || null;
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
      const alsoNode = _topology?.nodes.find(n => n.id === nid);
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
  const n = _topology?.nodes.find(nd => nd.id === id);
  return n ? n.label : id;
}

function renderConnectionsPane(nodeKey) {
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
      const tn = _topology?.nodes.find(nd => nd.id === target);
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
  if (!target || !currentEditNode) return;
  const type = _linksType.value;
  const vlan = _linksVlan.value ? parseInt(_linksVlan.value) : undefined;
  const conn = { from: currentEditNode, to: target, type };
  if (vlan) conn.vlan = vlan;
  _topology.connections.push(conn);
  // Add SVG path for new connection
  _addConnectionPath(conn, _topology.connections.length - 1);
  _saveConnections();
  renderConnectionsPane(currentEditNode);
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

function renderShellPane(nodeKey) {
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
  if (e.key === 'Enter' && e.target.value.trim() && currentEditNode) {
    e.preventDefault();
    const cmd = e.target.value.trim();
    e.target.value = '';
    _runShellCmd(currentEditNode, cmd);
  }
});

// Double-click a node to open persona editor (delegated — survives topology refresh)
document.getElementById('map-world').addEventListener('dblclick', e => {
  const node = e.target.closest('.realm-node');
  if (!node) return;
  e.stopPropagation();
  const key = node.dataset.tip;
  if (key) openPersonaEditor(key);
});

// Panel minimize/seal handled entirely by panel-manager.js (dock system)

// ── Spellbook Page Navigation ──
const _spellPages = document.querySelectorAll('#spellbook .spell-page');
const _spellTabs = document.querySelectorAll('.spell-tab');
let _spellPage = 0;
function _showSpellPage(idx) {
  _spellPage = Math.max(0, Math.min(idx, _spellPages.length - 1));
  _spellPages.forEach((p, i) => { p.style.display = i === _spellPage ? '' : 'none'; });
  _spellTabs.forEach((t, i) => t.classList.toggle('active', i === _spellPage));
  saveSettings();
}
_spellTabs.forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    _showSpellPage(parseInt(tab.dataset.spell));
  });
});

// ── Spellbook Presets ──
const _PRESETS = {
  minimal:     { 'fx-ambient': 0.05, 'fx-nodes': 0.1, 'fx-leylines': 0.05, 'fx-glow': 0.3, 'fx-pulse': 0.5, 'fx-leyglow': 0.2, 'traffic-scale': 0.5 },
  cinematic:   { 'fx-ambient': 0.6,  'fx-nodes': 0.8, 'fx-leylines': 0.7,  'fx-glow': 2.0, 'fx-pulse': 0.8, 'fx-leyglow': 1.5, 'traffic-scale': 1.5 },
  performance: { 'fx-ambient': 0,    'fx-nodes': 0.2, 'fx-leylines': 0.1,  'fx-glow': 0.5, 'fx-pulse': 1.0, 'fx-leyglow': 0.5, 'traffic-scale': 0.5 },
  full:        { 'fx-ambient': 0.5,  'fx-nodes': 0.7, 'fx-leylines': 0.6,  'fx-glow': 1.5, 'fx-pulse': 1.2, 'fx-leyglow': 1.2, 'traffic-scale': 1.2 },
};
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = _PRESETS[btn.dataset.preset];
    if (!preset) return;
    for (const [id, val] of Object.entries(preset)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
    if (btn.dataset.preset === 'performance') {
      const q = document.getElementById('fx-quality-select');
      if (q) { q.value = 'low'; q.dispatchEvent(new Event('change')); }
    }
    saveSettings();
  });
});

// ── Section Reset Buttons ──
const _SECTION_DEFAULTS = {
  effects:       { 'fx-ambient': 0.3, 'fx-nodes': 0.5, 'fx-glow': 1.0, 'fx-pulse': 1.0 },
  biomes:        { 'biome-land': 1.0, 'biome-glow': 1.0, 'biome-roads': 0.5, 'biome-peaks': 0.5, 'biome-grid': 0.03 },
  scale:         { 'master-scale': 1.0, 'node-scale': 1.0, 'text-scale': 1.0, 'bubble-scale': 1.0 },
  'ley-lines':   { 'traffic-scale': 1.0, 'fx-leylines': 0.4, 'fx-leyglow': 1.0 },
  'arcane-grid': { 'grid-opacity': 0.4, 'grid-scale': 1.0, 'grid-hue': 0 },
  ambiance:      { 'compass-scale': 1.0, 'sparkle-density': 0.5, 'ambient-glow': 0.3, 'vignette': 0.3 },
  topographic:   { 'topo-opacity': 0.6, 'topo-spread': 120, 'topo-contour': 12, 'topo-rw': 0.4, 'topo-rd': 0.6 },
  layout:        { 'layout-attract': 4.0, 'layout-repulse': 80, 'layout-edge': 80, 'layout-spacing': 8, 'layout-tilt': 0 },
};
document.querySelectorAll('.section-reset').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.dataset.reset === 'layers') {
      // Reset all layer checkboxes to checked (except grid which defaults off), opacities to 1
      ['vis-terrain','vis-topo','vis-nodes','vis-connections','vis-labels','vis-sublabels','vis-regions','vis-vlanlabels','vis-bubbles',
       'vis-titlebar','vis-search','vis-statuspanel','vis-legend','vis-codex','vis-questlog','vis-cartographer','vis-energy','vis-nodelist'].forEach(id => {
        const cb = document.getElementById(id);
        if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      });
      // Grid defaults to off
      const gridCb = document.getElementById('vis-grid');
      if (gridCb && gridCb.checked) { gridCb.checked = false; gridCb.dispatchEvent(new Event('change')); }
      ['layer-terrain','layer-terrain-orig','layer-topo','layer-grid','layer-nodes','layer-connections','layer-labels','layer-sublabels','layer-regions','layer-vlanlabels','layer-bubbles'].forEach(id => {
        const sl = document.getElementById(id + '-slider');
        if (sl) { sl.value = id === 'layer-grid' ? 0.4 : 1; sl.dispatchEvent(new Event('input')); }
      });
      saveSettings();
      return;
    }
    if (btn.dataset.reset === 'arcane-grid') {
      // Reset grid checkboxes too
      const toggleCb = document.getElementById('grid-toggle-cb');
      const pulseCb = document.getElementById('grid-pulse-cb');
      if (toggleCb && toggleCb.checked) { toggleCb.checked = false; toggleCb.dispatchEvent(new Event('change')); }
      if (pulseCb && !pulseCb.checked) { pulseCb.checked = true; pulseCb.dispatchEvent(new Event('change')); }
    }
    const defaults = _SECTION_DEFAULTS[btn.dataset.reset];
    if (!defaults) return;
    for (const [id, val] of Object.entries(defaults)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
    saveSettings();
  });
});

// Legend + Spellbook collapsible sections
document.querySelectorAll('.legend-section-header').forEach(header => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('collapsed');
    saveSettings();
  });
});
// Start with Nodes and Effects collapsed, Lines and Controls open
document.querySelector('.legend-section[data-section="nodes"]')?.classList.add('collapsed');
document.querySelector('.legend-section[data-section="effects"]')?.classList.add('collapsed');

// ── Magical Effects Controls ──
(function initEffectsControls() {
  function wire(id, getter, setter) {
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) return;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = id === 'fx-pulse' ? v.toFixed(1) + 'x' : v.toFixed(2);
      scheduleSave();
    });
  }
  wire('fx-ambient', () => _sparkleAmbient, v => { _sparkleAmbient = v; });
  wire('fx-nodes', () => _sparkleNodes, v => { _sparkleNodes = v; });
  wire('fx-leylines', () => _sparkleLeyLines, v => { _sparkleLeyLines = v; });
  wire('fx-glow', () => _sparkleGlowSize, v => { _sparkleGlowSize = v; });
  wire('fx-pulse', null, v => {
    // Scale all pulse/animation speeds via CSS custom property
    document.documentElement.style.setProperty('--pulse-speed', v);
    document.querySelectorAll('.pulse-ring').forEach(el => {
      el.style.animationDuration = (2.5 / v) + 's';
    });
    document.querySelectorAll('.data-pulse-ring').forEach(el => {
      el.style.animationDuration = (0.8 / v) + 's';
    });
  });
  wire('fx-leyglow', null, v => {
    // Scale ley line connection glow opacity
    const svg = document.getElementById('connections');
    if (svg) svg.style.opacity = Math.min(1, v);
    // Scale filter blur
    document.querySelectorAll('#connections path').forEach(p => {
      p.style.filter = v > 0 ? '' : 'none';
      p.style.opacity = Math.min(1, v);
    });
  });

  // Quality tier selector
  const qSel = document.getElementById('fx-quality-select');
  const qVal = document.getElementById('fx-quality-val');
  if (qSel) {
    // Show detected tier on load
    qVal.textContent = _perfTier + (_isMobile ? ' (mobile)' : '');
    qSel.addEventListener('change', () => {
      if (qSel.value === 'auto') {
        setPerfTier(_isMobile ? (_cpuCores >= 6 ? 'medium' : 'low') : 'high');
      } else {
        setPerfTier(qSel.value);
      }
      qVal.textContent = _perfTier;
      _topoHash = '';
      if (_topoEnabled) renderTopoLayer(_lastTopoCollectd);
      saveSettings();
    });
  }
})();

// ── Realm Search ──
const _realmSearch = document.getElementById('realm-search');
const _searchInput = document.getElementById('search-input');
const _searchResults = document.getElementById('search-results');
const _searchClear = document.getElementById('search-clear');
let _searchIndex = null; // built lazily
let _searchActiveIdx = -1;

const _panelEntries = [
  { id: '_panel:realm-panel',  icon: '&#9876;',   label: 'Realm Vitals',  sub: 'CPU, RAM, GPU gauges',        kind: 'Panel', sel: '#realm-panel' },
  { id: '_panel:legend',       icon: '&#128506;',  label: 'Legend',        sub: 'Ley line & node type key',    kind: 'Panel', sel: '#legend' },
  { id: '_panel:spellbook',    icon: '&#128214;',  label: 'Spellbook',     sub: 'Effects, layers, layout',     kind: 'Panel', sel: '#spellbook' },
  { id: '_panel:realm-codex',  icon: '&#128220;',  label: 'Realm Codex',   sub: 'Lore, tools, personas',       kind: 'Panel', sel: '#realm-codex' },
  { id: '_panel:quest-log',    icon: '&#9753;',    label: 'Quest Log',     sub: 'Events, quests, speech',      kind: 'Panel', sel: '#quest-log' },
  { id: '_panel:node-list',    icon: '&#9873;',    label: 'Realm Census',  sub: 'All nodes by region',         kind: 'Panel', sel: '#node-list' },
  { id: '_panel:cartographer', icon: '&#128506;',  label: 'Cartographer',  sub: 'Map layout modes',            kind: 'Panel', sel: '#cartographer' },
  { id: '_panel:energy-panel', icon: '&#9889;',    label: 'Realm Energy',  sub: 'Energy & data flow',          kind: 'Panel', sel: '#energy-panel' },
  { id: '_panel:debug-panel',  icon: '&#128302;',  label: 'Arcane Mirror', sub: 'Debug panel, diagnostics',    kind: 'Panel', sel: '#debug-panel' },
  { id: '_panel:latency-panel', icon: '&#127992;', label: 'Arcane Pulse',  sub: 'Ping latency, network health', kind: 'Panel', sel: '#latency-panel' },
  { id: '_panel:firewall-panel', icon: '&#128737;', label: 'Realm Wards', sub: 'Firewall, VLANs, network segments', kind: 'Panel', sel: '#firewall-panel' },
];

// Build comprehensive search index from topology + panels + all settings/controls
function _buildSearchIndex() {
  if (!_topology || _searchIndex) return;
  _searchIndex = [
    // Topology nodes
    ..._topology.nodes.map(n => ({
      id: n.id,
      icon: n.icon,
      label: n.label,
      sub: n.sublabel || '',
      ip: n.ip || '',
      type: n.type || 'core',
      _text: [n.label, n.sublabel, n.ip, n.id, n.type].filter(Boolean).join(' ').toLowerCase(),
    })),
    // Panel entries
    ..._panelEntries.map(p => ({
      id: p.id,
      icon: p.icon,
      label: p.label,
      sub: p.sub,
      ip: '',
      type: p.kind,
      sel: p.sel,
      _text: [p.label, p.sub, p.kind].join(' ').toLowerCase(),
    })),
  ];
  // Scan all panels for controls: sliders, toggles, selects, buttons
  _indexPanelControls();
}

// Panel icon lookup for search results
const _panelIcons = {
  'spellbook': '&#128214;', 'legend': '&#128506;', 'realm-codex': '&#128220;',
  'realm-panel': '&#9876;', 'cartographer': '&#128506;', 'energy-panel': '&#9889;',
  'debug-panel': '&#128302;', 'quest-log': '&#9753;', 'node-list': '&#9873;',
  'latency-panel': '&#127992;', 'firewall-panel': '&#128737;',
};
const _panelNames = {
  'spellbook': 'Spellbook', 'legend': 'Legend', 'realm-codex': 'Realm Codex',
  'realm-panel': 'Realm Vitals', 'cartographer': 'Cartographer', 'energy-panel': 'Energy',
  'debug-panel': 'Arcane Mirror', 'quest-log': 'Quest Log', 'node-list': 'Census',
  'latency-panel': 'Arcane Pulse', 'firewall-panel': 'Realm Wards',
};

function _indexPanelControls() {
  const panelIds = ['spellbook', 'legend', 'realm-codex', 'realm-panel', 'cartographer', 'energy-panel', 'latency-panel', 'firewall-panel'];
  for (const panelId of panelIds) {
    const panel = document.getElementById(panelId);
    if (!panel) continue;
    const icon = _panelIcons[panelId] || '&#9881;';
    const panelName = _panelNames[panelId] || panelId;

    // Index sliders (type="range")
    panel.querySelectorAll('input[type="range"]').forEach(slider => {
      const label = _findControlLabel(slider);
      if (!label) return;
      const section = _findSectionName(slider);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${slider.id || label}`,
        icon, label, sub, ip: '', type: 'Slider',
        _el: slider,
        _text: [label, sub, 'slider', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index checkboxes / toggles
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      const label = _findControlLabel(cb);
      if (!label) return;
      const section = _findSectionName(cb);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${cb.id || label}`,
        icon, label, sub, ip: '', type: 'Toggle',
        _el: cb,
        _text: [label, sub, 'toggle', 'switch', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index selects
    panel.querySelectorAll('select').forEach(sel => {
      const label = _findControlLabel(sel);
      if (!label) return;
      const section = _findSectionName(sel);
      const optTexts = [...sel.options].map(o => o.textContent).join(' ');
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${sel.id || label}`,
        icon, label, sub, ip: '', type: 'Select',
        _el: sel,
        _text: [label, sub, 'select', optTexts, panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index number inputs
    panel.querySelectorAll('input[type="number"]').forEach(input => {
      const label = _findControlLabel(input);
      if (!label) return;
      const section = _findSectionName(input);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:${input.id || label}`,
        icon, label, sub, ip: '', type: 'Setting',
        _el: input,
        _text: [label, sub, 'setting', panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });

    // Index preset buttons
    panel.querySelectorAll('.preset-btn').forEach(btn => {
      const label = btn.textContent.trim();
      const section = _findSectionName(btn);
      const sub = section ? `${panelName} \u203A ${section}` : panelName;
      _searchIndex.push({
        id: `_ctrl:preset-${btn.dataset.preset || label}`,
        icon, label: `Preset: ${label}`, sub, ip: '', type: 'Action',
        _el: btn,
        _text: [label, 'preset', sub, panelName, section].filter(Boolean).join(' ').toLowerCase(),
      });
    });
  }

  // Index cartographer layout modes
  document.querySelectorAll('.carto-mode').forEach(btn => {
    const name = btn.querySelector('.carto-name')?.textContent || '';
    const iconEl = btn.querySelector('.carto-icon')?.innerHTML || '';
    _searchIndex.push({
      id: `_ctrl:layout-${btn.dataset.layout}`,
      icon: iconEl || '&#128506;', label: `Layout: ${name}`, sub: 'Cartographer', ip: '', type: 'Layout',
      _el: btn,
      _text: [name, 'layout', 'cartographer', 'map', btn.dataset.layout].join(' ').toLowerCase(),
    });
  });

  // Index codex tool entries
  document.querySelectorAll('.codex-tool code').forEach(code => {
    const toolName = code.textContent;
    const desc = code.parentElement?.querySelector('span')?.textContent || '';
    const group = code.closest('.codex-tools')?.previousElementSibling?.textContent?.replace(/\d+ tools/, '').trim() || '';
    _searchIndex.push({
      id: `_ctrl:tool-${toolName}`,
      icon: '&#128220;', label: toolName, sub: `${group} \u203A ${desc}`.substring(0, 60), ip: '', type: 'Tool',
      _el: code.closest('.codex-tool'),
      _text: [toolName, desc, group, 'tool', 'codex', 'mcp'].join(' ').toLowerCase(),
    });
  });

  // Index legend items
  document.querySelectorAll('#legend .legend-item').forEach(item => {
    const label = item.textContent.trim();
    const section = _findSectionName(item);
    _searchIndex.push({
      id: `_ctrl:legend-${label}`,
      icon: '&#128506;', label, sub: `Legend \u203A ${section || ''}`, ip: '', type: 'Legend',
      _el: item,
      _text: [label, 'legend', section, 'ley line', 'node type'].filter(Boolean).join(' ').toLowerCase(),
    });
  });
}

// Walk up DOM to find the nearest label text for a control
function _findControlLabel(el) {
  // Check for <label> wrapping or preceding the control
  const parent = el.closest('.traffic-control, .layer-row, .cfg-row');
  if (parent) {
    const lbl = parent.querySelector('label');
    if (lbl) {
      // Strip value spans
      const clone = lbl.cloneNode(true);
      clone.querySelectorAll('.tc-val, .topo-switch').forEach(v => v.remove());
      return clone.textContent.trim();
    }
    const name = parent.querySelector('.layer-name');
    if (name) return name.textContent.trim();
  }
  // Fallback: check closest label element
  const wrapper = el.closest('label');
  if (wrapper) {
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll('input, select, .tc-val, .topo-switch-track').forEach(v => v.remove());
    return clone.textContent.trim();
  }
  return '';
}

// Walk up DOM to find containing section name
function _findSectionName(el) {
  const section = el.closest('.legend-section');
  if (section) {
    const header = section.querySelector('.legend-section-header');
    if (header) {
      const clone = header.cloneNode(true);
      clone.querySelectorAll('.legend-chevron, .section-reset').forEach(v => v.remove());
      return clone.textContent.trim();
    }
  }
  const codexSection = el.closest('.codex-section');
  if (codexSection) {
    const h4 = codexSection.querySelector('h4');
    if (h4) return h4.textContent.replace(/\d+ tools/, '').trim();
  }
  return '';
}

function _searchRealm(query) {
  _buildSearchIndex();
  if (!_searchIndex || !query) return [];
  const terms = query.toLowerCase().split(/\s+/);
  const scored = [];
  for (const entry of _searchIndex) {
    let match = true;
    let score = 0;
    for (const t of terms) {
      const idx = entry._text.indexOf(t);
      if (idx === -1) { match = false; break; }
      if (entry.label.toLowerCase().startsWith(t)) score += 10;
      else if (entry.ip.startsWith(t)) score += 5;
      else score += 1;
    }
    if (match) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 16).map(s => s.entry);
}

function _highlightMatch(text, query) {
  if (!query) return text;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;
  for (const t of terms) {
    const idx = result.toLowerCase().indexOf(t);
    if (idx !== -1) {
      result = result.slice(0, idx) + '<mark>' + result.slice(idx, idx + t.length) + '</mark>' + result.slice(idx + t.length);
    }
  }
  return result;
}

function _renderSearchResults(results, query) {
  _searchActiveIdx = -1;
  if (!results.length) {
    // Safe: static text only
    _searchResults.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'sr-empty';
    empty.textContent = 'No matches in the Realm';
    _searchResults.appendChild(empty);
    _searchResults.classList.add('open');
    return;
  }
  const typeName = { core: 'Core', infra: 'Infra', tower: 'Tower', bridge: 'Bridge', cluster: 'IoT', tailscale: 'Astral',
    Panel: 'Panel', Slider: 'Slider', Toggle: 'Toggle', Select: 'Setting', Setting: 'Setting',
    Action: 'Action', Layout: 'Layout', Tool: 'Tool', Legend: 'Legend' };
  // Safe: all data sourced from server-side topology.json (trusted)
  const frag = document.createDocumentFragment();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const item = document.createElement('div');
    item.className = 'sr-item';
    item.dataset.idx = i;
    item.dataset.nodeId = r.id;
    item.dataset.kind = r.type || '';

    const iconEl = document.createElement('div');
    iconEl.className = 'sr-icon';
    iconEl.innerHTML = r.icon; // topology.json icon HTML entities (trusted)

    const info = document.createElement('div');
    info.className = 'sr-info';
    const name = document.createElement('div');
    name.className = 'sr-name';
    name.innerHTML = _highlightMatch(r.label, query); // topology.json label (trusted)
    const sub = document.createElement('div');
    sub.className = 'sr-sub';
    sub.textContent = r.sub;
    info.appendChild(name);
    info.appendChild(sub);

    const typeEl = document.createElement('div');
    typeEl.className = 'sr-type';
    typeEl.textContent = typeName[r.type] || r.type;

    item.appendChild(iconEl);
    item.appendChild(info);
    item.appendChild(typeEl);
    frag.appendChild(item);
  }
  _searchResults.textContent = '';
  _searchResults.appendChild(frag);
  _searchResults.classList.add('open');
}

// Restore a panel: unseal if sealed, un-hide, re-check vis checkbox
function _restorePanel(panelEl) {
  if (!panelEl) return;
  // If sealed to dock, properly unseal it (removes rune, restores position)
  if (panelEl.classList.contains('panel-sealed')) {
    unsealPanel(panelEl);
    saveFormation();
    return;
  }
  panelEl.style.display = '';
  // Re-check vis checkbox if it exists
  const id = panelEl.id;
  const visMap = {
    'realm-panel': 'vis-statuspanel', 'legend': 'vis-legend', 'spellbook': 'vis-spellbook',
    'realm-codex': 'vis-codex', 'quest-log': 'vis-questlog', 'node-list': 'vis-nodelist',
    'cartographer': 'vis-cartographer', 'energy-panel': 'vis-energy',
    'debug-panel': 'vis-debug', 'latency-panel': 'vis-latency',
    'firewall-panel': 'vis-firewall',
    'wifi-panel': 'vis-wifi',
  };
  const visId = visMap[id] || ('vis-' + id);
  const visCb = document.getElementById(visId);
  if (visCb && !visCb.checked) { visCb.checked = true; visCb.dispatchEvent(new Event('change')); }
}

// Flash-highlight an element with a golden glow
function _flashElement(el) {
  if (!el) return;
  el.style.transition = 'box-shadow 0.3s, outline 0.3s';
  el.style.boxShadow = '0 0 20px rgba(240,216,144,0.5)';
  el.style.outline = '2px solid rgba(240,216,144,0.6)';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.boxShadow = '';
    el.style.outline = '';
    el.style.outlineOffset = '';
  }, 1500);
}

function _navigateToSearchResult(nodeId) {
  _searchInput.blur();
  _searchResults.classList.remove('open');

  // Control results: open panel → tab → section → scroll to control
  if (nodeId.startsWith('_ctrl:')) {
    const entry = _searchIndex?.find(e => e.id === nodeId);
    const el = entry?._el;
    if (!el) return;

    // Find and restore the parent panel
    const panel = el.closest('.panel, #persona-editor, #debug-panel');
    if (panel) {
      _restorePanel(panel);
      // Also un-hide codex/legend bodies
      const body = panel.querySelector('#codex-body');
      if (body) body.style.display = '';
    }

    // Switch spellbook tab if control is inside a spell-page
    const spellPage = el.closest('.spell-page');
    if (spellPage) {
      const pageIdx = parseInt(spellPage.dataset.spellPage);
      if (!isNaN(pageIdx)) _showSpellPage(pageIdx);
    }

    // Expand collapsed legend-section
    const section = el.closest('.legend-section');
    if (section && section.classList.contains('collapsed')) {
      section.classList.remove('collapsed');
    }

    // Expand collapsed codex-tools
    const codexTools = el.closest('.codex-tools');
    if (codexTools && !codexTools.classList.contains('open')) {
      codexTools.classList.add('open');
      const h4 = codexTools.previousElementSibling;
      if (h4) h4.classList.add('open');
    }

    // Scroll to element and flash it
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      _flashElement(el.closest('.traffic-control, .layer-row, .cfg-row, .codex-tool, .legend-item, .carto-mode, .preset-btn') || el);
      // Focus interactive elements
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') el.focus();
      if (el.tagName === 'BUTTON') el.click();
    });
    return;
  }

  // Panel results: restore panel, scroll into view, and flash it
  if (nodeId.startsWith('_panel:')) {
    const entry = _searchIndex?.find(e => e.id === nodeId);
    const panelEl = entry?.sel ? document.querySelector(entry.sel) : null;
    if (panelEl) {
      _restorePanel(panelEl);
      panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      _flashElement(panelEl);
    }
    return;
  }

  // Node results: pan to node and highlight
  const nodeEl = document.querySelector(`[data-tip="${CSS.escape(nodeId)}"]`);
  if (!nodeEl) return;
  const nodeLeft = parseInt(nodeEl.style.left) || 0;
  const nodeTop = parseInt(nodeEl.style.top) || 0;
  scale = 1.2;
  panX = canvas.clientWidth / 2 - nodeLeft * scale;
  panY = canvas.clientHeight / 2 - nodeTop * scale;
  applyTransform();
  showHighlight(nodeEl, { color: 'rgba(240,216,144,0.5)' });
}

if (_searchInput) {
  _searchInput.addEventListener('input', () => {
    const rawVal = _searchInput.value;
    const isMagic = rawVal.startsWith('?');
    const q = rawVal.trim();

    _realmSearch.classList.toggle('magic-morph', isMagic);
    _searchClear.style.display = q ? '' : 'none';

    if (!q) {
      _searchResults.classList.remove('open');
      return;
    }

    if (isMagic) {
      _searchResults.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'sr-empty';
      hint.textContent = q.length > 1 ? '\u2728 Press Enter to consult the Oracle...' : '\u2728 Ask the Oracle anything...';
      _searchResults.appendChild(hint);
      _searchResults.classList.add('open');
    } else {
      _renderSearchResults(_searchRealm(q), q);
    }
  });

  _searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && _realmSearch.classList.contains('magic-morph')) {
      const q = _searchInput.value.trim();
      if (q.length > 1) {
        e.preventDefault();
        const query = q.substring(1).trim();

        // Fire as event through existing system
        fetch('/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'oracle_query', node: 'scrying-pool', text: query, color: '#c080ff' })
        }).catch(err => console.error('Oracle query failed:', err));

        // Visual feedback
        _searchResults.textContent = '';
        const sent = document.createElement('div');
        sent.className = 'sr-empty';
        sent.textContent = '\u2728 Query cast into the Aether...';
        _searchResults.appendChild(sent);

        setTimeout(() => {
          _searchInput.value = '';
          _realmSearch.classList.remove('magic-morph');
          _searchResults.classList.remove('open');
          _searchClear.style.display = 'none';
        }, 1200);
        return;
      }
    }

    const items = _searchResults.querySelectorAll('.sr-item');
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _searchActiveIdx = Math.min(_searchActiveIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === _searchActiveIdx));
      items[_searchActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _searchActiveIdx = Math.max(_searchActiveIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === _searchActiveIdx));
      items[_searchActiveIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && _searchActiveIdx >= 0) {
      e.preventDefault();
      const id = items[_searchActiveIdx]?.dataset.nodeId;
      if (id) _navigateToSearchResult(id);
    } else if (e.key === 'Escape') {
      _searchResults.classList.remove('open');
      _searchInput.blur();
    }
  });

  _searchResults.addEventListener('click', e => {
    const item = e.target.closest('.sr-item');
    if (item) _navigateToSearchResult(item.dataset.nodeId);
  });

  _searchClear.addEventListener('click', () => {
    _searchInput.value = '';
    _searchClear.style.display = 'none';
    _searchResults.classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#realm-search')) _searchResults.classList.remove('open');
  });
}

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
        const cw = canvas.clientWidth, ch = canvas.clientHeight;
        scale = 1.2;
        panX = cw / 2 - nodeLeft * scale;
        panY = ch / 2 - nodeTop * scale;
        applyTransform();
        // Flash the node
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
    // Match status key (same logic as updateUI)
    const statusKey = Object.keys(nodeStatus).find(k => k.toLowerCase() === id.toLowerCase())
      || Object.keys(nodeStatus).find(k => k.replace(/-/g, '').toLowerCase() === id.replace(/-/g, '').toLowerCase());
    const online = statusKey ? nodeStatus[statusKey] : null;
    dot.className = 'nl-status ' + (online === true ? 'online' : online === false ? 'offline' : 'unknown');
  });
}

// Build the node list from topology
buildNodeList();

function updateCensusSubLabels(d) {
  if (!d) return;
  document.querySelectorAll('.nl-item').forEach(item => {
    const id = item.dataset.nodeId;
    if (!id) return;
    const subEl = item.querySelector('.nl-sub');
    if (!subEl) return;
    // Show live HA sublabel if available
    const haInfo = d.ha?.[id];
    if (haInfo?.sublabel) {
      subEl.textContent = haInfo.sublabel;
      return;
    }
    // Show WLED state
    const wledInfo = d.wled?.[id];
    if (wledInfo?.online) {
      subEl.textContent = wledInfo.on ? `On \u2022 ${wledInfo.effect || 'Solid'}` : 'Off';
      return;
    }
    // Show WiFi signal
    const wifi = d.wifi?.[id];
    if (wifi?.signal != null) {
      subEl.textContent = `${wifi.signal} dBm \u2022 ${wifi.ap || ''}`;
      return;
    }
  });
}

// Rebuild census when topology refreshes
let _lastCensusCount = _topology?.nodes?.length || 0;
setInterval(() => {
  const n = _topology?.nodes?.length || 0;
  if (n !== _lastCensusCount) {
    _lastCensusCount = n;
    buildNodeList();
  }
}, 10000);

// ── Energy Panel ──
function updateEnergyPanel(data) {
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

// ── Energy polling removed — SSE replaces it (see initSSE below) ──

// ── Auto-Arrange Layout (force-directed, non-blocking) ──
// Stores topology.json original positions for reset
const _originalPositions = {};
if (_topology) _topology.nodes.forEach(n => { _originalPositions[n.id] = { x: n.x, y: n.y }; });

// Pre-build connection index array: [fromIdx, toIdx, fromId, toId] for O(1) lookup
const _connIdx = [];
if (_topology) {
  const idxMap = {};
  _topology.nodes.forEach((n, i) => { idxMap[n.id] = i; });
  _topology.connections.forEach(c => {
    const a = idxMap[c.from], b = idxMap[c.to];
    if (a !== undefined && b !== undefined) _connIdx.push([a, b, c.from, c.to]);
  });
}

// Pre-compute VLAN assignments for layout modes (majority vote from connection VLANs)
const _nodeVlans = [];
if (_topology) {
  const vlanCounts = {};
  _topology.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!vlanCounts[id]) vlanCounts[id] = {};
      vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  _topology.nodes.forEach((n, i) => {
    if (vlanCounts[n.id]) {
      let best = 6, max = 0;
      for (const [v, c] of Object.entries(vlanCounts[n.id])) { if (c > max) { max = c; best = +v; } }
      _nodeVlans[i] = best;
    } else {
      _nodeVlans[i] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
    }
  });
}

let _layoutRunning = false;
let _layoutWorker = null;
let _layoutMode = 'world-tree';
// Exposed layout parameters (wired to sliders)
let _layoutAttract = 4.0;   // spring strength multiplier (x0.001)
let _layoutRepulse = 80;    // repulsion base (x1000)
let _layoutEdgeLen = 80;    // base ideal edge length
let _layoutSpacing = 8;     // same-depth peer spacing (x1000)

export function autoArrangeLayout(mode) {
  if (!_topology || _layoutRunning) return;
  if (mode) _layoutMode = mode;
  _layoutRunning = true;

  // Update mode button states
  document.querySelectorAll('.carto-mode').forEach(b => {
    b.classList.toggle('active', b.dataset.layout === _layoutMode);
  });
  const activeBtn = document.querySelector(`.carto-mode[data-layout="${_layoutMode}"]`);
  if (activeBtn) activeBtn.classList.add('running');
  const castBtn = document.getElementById('layout-auto-btn');
  if (castBtn) { castBtn.classList.add('running'); castBtn.textContent = '\u2728 Casting\u2026'; }

  // Terminate previous worker if any
  if (_layoutWorker) { _layoutWorker.terminate(); _layoutWorker = null; }

  // Prepare lightweight data for the worker (no DOM refs)
  const nodeData = _topology.nodes.map(n => ({ id: n.id, type: n.type }));
  const connData = _connIdx.map(c => [c[0], c[1]]); // just indices

  _layoutWorker = new Worker('layout-worker.js?v=2');
  _layoutWorker.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'progress') {
      if (castBtn) castBtn.textContent = `\u2728 ${Math.round(msg.step / msg.total * 100)}%`;
      return;
    }
    if (msg.type === 'done') {
      const x = new Float32Array(msg.x);
      const y = new Float32Array(msg.y);
      const pos = [];
      for (let i = 0; i < msg.count; i++) pos.push({ x: x[i], y: y[i] });

      _animateToPositions(pos, 900, () => {
        _layoutRunning = false;
        generateTerrain();
        updateRegionLabels();
        if (activeBtn) activeBtn.classList.remove('running');
        if (castBtn) { castBtn.classList.remove('running'); castBtn.textContent = '\u2728 Cast Arrangement'; }
      });
      _layoutWorker.terminate();
      _layoutWorker = null;
    }
  };
  _layoutWorker.onerror = function(err) {
    console.error('Layout worker error:', err);
    _layoutRunning = false;
    if (activeBtn) activeBtn.classList.remove('running');
    if (castBtn) { castBtn.classList.remove('running'); castBtn.textContent = '\u2728 Cast Arrangement'; }
    _layoutWorker = null;
  };

  _layoutWorker.postMessage({
    nodes: nodeData,
    connIdx: connData,
    params: { attract: _layoutAttract, repulse: _layoutRepulse, edgeLen: _layoutEdgeLen, spacing: _layoutSpacing },
    worldW: WORLD_W,
    worldH: WORLD_H,
    mode: _layoutMode,
    nodeVlans: _nodeVlans,
    latencyMap: _latencyMap,
    wifiMap: _wifiMap,
  });
}

function resetToOriginalPositions() {
  if (_layoutRunning) return;
  const nodes = _topology.nodes;
  const pos = nodes.map(n => {
    const orig = _originalPositions[n.id];
    return orig ? { x: orig.x, y: orig.y } : { x: n.x, y: n.y };
  });
  _animateToPositions(pos, 700, () => { generateTerrain(); updateRegionLabels(); });
}

// Cache node element refs for animation (avoid querySelector in hot loop)
const _nodeElCache = {};
if (_topology) _topology.nodes.forEach(n => {
  _nodeElCache[n.id] = document.querySelector(`[data-tip="${n.id}"]`);
});

function _animateToPositions(targetPos, duration, onDone) {
  const nodes = _topology.nodes;
  const startPos = nodes.map(n => ({ x: n.x, y: n.y }));
  const startTime = performance.now();

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    // Smooth ease-out cubic
    const e = 1 - (1 - t) * (1 - t) * (1 - t);

    for (let i = 0; i < nodes.length; i++) {
      const nx = startPos[i].x + (targetPos[i].x - startPos[i].x) * e;
      const ny = startPos[i].y + (targetPos[i].y - startPos[i].y) * e;
      nodes[i].x = nx;
      nodes[i].y = ny;
      const el = _nodeElCache[nodes[i].id];
      if (el) { el.style.left = nx + 'px'; el.style.top = ny + 'px'; }
    }
    updateLinePositions();
    updateBubblePositions();

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      _topoNodeMap = null;
      _topoForceRender();
      scheduleSave();
      if (onDone) onDone();
    }
  }
  requestAnimationFrame(step);
}

// Wire cartographer mode buttons — clicking a mode starts arrangement
document.querySelectorAll('.carto-mode').forEach(btn => {
  btn.addEventListener('click', () => autoArrangeLayout(btn.dataset.layout));
});

// Wire layout buttons + sliders
document.getElementById('layout-auto-btn')?.addEventListener('click', () => autoArrangeLayout());
document.getElementById('layout-reset-btn')?.addEventListener('click', resetToOriginalPositions);

(function wireLayoutSliders() {
  const sliders = [
    ['layout-attract', v => { _layoutAttract = v; }],
    ['layout-repulse', v => { _layoutRepulse = v; }],
    ['layout-edge',    v => { _layoutEdgeLen = v; }],
    ['layout-spacing', v => { _layoutSpacing = v; }],
    ['layout-tilt',    v => { setMapTilt(v); applyTransform(); }, v => v + '\u00B0'],
  ];
  for (const entry of sliders) {
    const [id, setter, fmt] = entry;
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = fmt ? fmt(v) : (v % 1 === 0 ? v : v.toFixed(1));
      scheduleSave();
    });
  }
})();

// ── Biome sliders ──
(function wireBiomeSliders() {
  const sliders = [
    ['biome-land', v => { _biomeLandScale = v; generateTerrain(); }],
    ['biome-glow', v => { _biomeGlow = v; generateTerrain(); }],
    ['biome-roads', v => { _biomeRoads = v; generateTerrain(); }],
    ['biome-peaks', v => { _biomePeaks = v; generateTerrain(); }],
    ['biome-grid', v => { _biomeGrid = v; generateTerrain(); }],
  ];
  for (const [id, setter] of sliders) {
    const sl = document.getElementById(id + '-slider');
    const vl = document.getElementById(id + '-val');
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      setter(v);
      if (vl) vl.textContent = v.toFixed(2);
      scheduleSave();
    });
  }
})();

// ── Visibility Toggles ──
(function wireVisibilityToggles() {
  // [checkboxId, singleSelector, multiSelector]
  const toggles = [
    // Map layers
    ['vis-parchment',    '#map-parchment'],
    ['vis-terrain',      '#terrain-dynamic'],
    ['vis-terrain-orig', '#terrain-original'],
    ['vis-topo',         '#topo-svg'],
    ['vis-connections',  '#connections'],
    ['vis-nodes',        null, '.realm-node'],
    ['vis-labels',       null, '.node-label'],
    ['vis-sublabels',    null, '.node-sublabel'],
    ['vis-regions',      '#region-labels'],
    ['vis-vlanlabels',   null, '.vlan-label'],
    ['vis-bubbles',      null, '.speech-bubble'],
    // Panels
    ['vis-titlebar',     '#title-bar'],
    ['vis-search',       '#realm-search'],
    ['vis-statuspanel',  '#realm-panel'],
    ['vis-legend',       '#legend'],
    ['vis-spellbook',    '#spellbook'],
    ['vis-codex',        '#realm-codex'],
    ['vis-questlog',     '#quest-log'],
    ['vis-cartographer', '#cartographer'],
    ['vis-energy',       '#energy-panel'],
    ['vis-nodelist',     '#node-list'],
    ['vis-debug',        '#debug-panel'],
    ['vis-latency',      '#latency-panel'],
    ['vis-firewall',     '#firewall-panel'],
    ['vis-wifi',         '#wifi-panel'],
    // Decorations
    ['vis-map-vines',    '#enchanted-vines'],
  ];
  for (const [id, sel, multiSel] of toggles) {
    const cb = document.getElementById(id);
    if (!cb) continue;
    cb.addEventListener('change', () => {
      const show = cb.checked;
      if (sel) {
        const el = document.querySelector(sel);
        if (el) {
          // Clean up seal rune if panel was sealed
          if (el.classList.contains('panel-sealed')) {
            const rune = document.querySelector(`.sealed-rune[data-panel-id="${el.id}"]`);
            if (rune) rune.remove();
            el.classList.remove('panel-sealed');
            const dock = document.getElementById('sealed-dock');
            const tray = dock?.querySelector('.dock-tray');
            if (tray && tray.children.length === 0) {
              dock.classList.remove('has-runes');
              dock.style.bottom = '-80px';
            }
          }
          el.style.display = show ? '' : 'none';
        }
      } else if (multiSel) {
        document.querySelectorAll(multiSel).forEach(el => {
          el.style.visibility = show ? '' : 'hidden';
        });
        if (!window._visState) window._visState = {};
        window._visState[multiSel] = show;
      }
      saveSettings();
      if (!_restoring) saveFormation();  // sync panel-manager so hidden panels stay hidden on reload
      // Mark ghost canvas dirty so zoom bitmap refreshes
      _ghostDirty = true;
    });
  }

  // Wire up panel mode buttons (logic at module scope below)
  document.querySelectorAll('.panel-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setPanelMode(btn.dataset.mode));
  });

  // Sealed dock controls
  const dockOpSlider = document.getElementById('dock-opacity-slider');
  const dockOpVal = document.getElementById('dock-opacity-val');
  const dockScSlider = document.getElementById('dock-scale-slider');
  const dockScVal = document.getElementById('dock-scale-val');
  const dockBgSlider = document.getElementById('dock-bg-slider');
  const dockBgVal = document.getElementById('dock-bg-val');

  if (dockOpSlider) {
    dockOpSlider.addEventListener('input', () => {
      const v = parseFloat(dockOpSlider.value);
      if (dockOpVal) dockOpVal.textContent = v.toFixed(2);
      const dock = document.getElementById('sealed-dock');
      if (dock) dock.style.opacity = v;
      saveSettings();
    });
  }
  if (dockScSlider) {
    dockScSlider.addEventListener('input', () => {
      const v = parseFloat(dockScSlider.value);
      if (dockScVal) dockScVal.textContent = v.toFixed(2);
      document.querySelectorAll('.sealed-rune').forEach(r => {
        r.style.transform = `scale(${v})`;
      });
      // Store for newly created runes
      window._dockRuneScale = v;
      saveSettings();
    });
  }
  if (dockBgSlider) {
    dockBgSlider.addEventListener('input', () => {
      const v = parseFloat(dockBgSlider.value);
      if (dockBgVal) dockBgVal.textContent = v.toFixed(2);
      const dock = document.getElementById('sealed-dock');
      if (dock) {
        // Adjust just the background opacity via a CSS custom property
        dock.style.setProperty('--dock-bg-opacity', v);
      }
      saveSettings();
    });
  }

  // Loading screen vines toggle
  const loadVinesCb = document.getElementById('vis-loading-vines');
  if (loadVinesCb) {
    loadVinesCb.addEventListener('change', () => {
      document.querySelectorAll('.rl-vines').forEach(el => {
        el.style.display = loadVinesCb.checked ? '' : 'none';
      });
      saveSettings();
    });
  }

  // Replay loading screen button
  const replayBtn = document.getElementById('replay-loading-btn');
  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      const loadEl = document.getElementById('realm-loading');
      if (!loadEl) return;
      // Reset to stage 0
      loadEl.dataset.stage = '0';
      const arc = loadEl.querySelector('.rl-progress-arc');
      if (arc) arc.style.strokeDashoffset = '1099.56';
      loadEl.querySelectorAll('.rl-stage-mark').forEach(m => m.classList.remove('lit'));
      loadEl.querySelector('.rl-sparks').innerHTML = '';
      const stageText = loadEl.querySelector('.rl-stage-text');
      if (stageText) stageText.textContent = 'Igniting the arcane sigil';
      loadEl.classList.remove('dismissed');
      // Re-trigger vine trace animations by cloning paths
      loadEl.querySelectorAll('.rl-vines path[stroke]').forEach(p => {
        const clone = p.cloneNode(true);
        p.parentNode.replaceChild(clone, p);
      });
      loadEl.querySelectorAll('.rl-vines path[fill]:not([stroke])').forEach(p => {
        const clone = p.cloneNode(true);
        p.parentNode.replaceChild(clone, p);
      });
      loadEl.querySelectorAll('.rl-vines circle').forEach(c => {
        const clone = c.cloneNode(true);
        c.parentNode.replaceChild(clone, c);
      });
      // Replay stages with timing
      const adv = window._advanceLoadStage;
      if (adv) {
        setTimeout(() => adv(1), 600);
        setTimeout(() => adv(2), 1800);
        setTimeout(() => adv(3), 3000);
        setTimeout(() => adv(4), 4200);
      }
      setTimeout(() => loadEl.classList.add('dismissed'), 5500);
    });
  }

  // Layer opacity sliders: [sliderId, target selector or multi-selector, isMulti]
  const opacityLayers = [
    ['layer-parchment-slider',    '#map-parchment',    false],
    ['layer-terrain-orig-slider', '#terrain-original', false],
    ['layer-terrain-slider',      '#terrain-dynamic',  false],
    ['layer-topo-slider',         '#topo-svg',         false],
    ['layer-connections-slider',  '#connections',       false],
    ['layer-regions-slider',      '#region-labels',     false],
    ['layer-nodes-slider',        null,                 true, '.realm-node'],
    ['layer-labels-slider',       null,                 true, '.node-label'],
    ['layer-sublabels-slider',    null,                 true, '.node-sublabel'],
    ['layer-vlanlabels-slider',   null,                 true, '.vlan-label'],
    ['layer-bubbles-slider',      null,                 true, '.speech-bubble'],
    // Panel opacity sliders
    ['panel-titlebar-slider',     '#title-bar',         false],
    ['panel-search-slider',       '#realm-search',      false],
    ['panel-vitals-slider',       '#realm-panel',       false],
    ['panel-legend-slider',       '#legend',            false],
    ['panel-spellbook-slider',    '#spellbook',         false],
    ['panel-codex-slider',        '#realm-codex',       false],
    ['panel-questlog-slider',     '#quest-log',         false],
    ['panel-cartographer-slider', '#cartographer',      false],
    ['panel-energy-slider',       '#energy-panel',      false],
    ['panel-nodelist-slider',     '#node-list',         false],
    ['panel-mirror-slider',       '#debug-panel',       false],
    ['panel-latency-slider',      '#latency-panel',     false],
    ['panel-firewall-slider',     '#firewall-panel',    false],
    ['panel-wifi-slider',        '#wifi-panel',        false],
  ];
  for (const [sliderId, sel, isMulti, multiSel] of opacityLayers) {
    const sl = document.getElementById(sliderId);
    if (!sl) continue;
    sl.addEventListener('input', () => {
      const v = sl.value;
      if (sel) {
        const el = document.querySelector(sel);
        if (el) el.style.opacity = v;
      } else if (multiSel) {
        document.querySelectorAll(multiSel).forEach(el => { el.style.opacity = v; });
        if (!window._layerOpacity) window._layerOpacity = {};
        window._layerOpacity[multiSel] = v;
      }
      saveSettings();
    });
  }
})();

// ── Magic Motes Trail (for draggable elements) ──
const moteCanvas = document.createElement('canvas');
moteCanvas.id = 'mote-canvas';
moteCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:300';
document.body.appendChild(moteCanvas);
const moteCtx = moteCanvas.getContext('2d');
let motes = [];

// FPS counter (toggle with Ctrl+Shift+F)
const _fpsEl = document.createElement('div');
_fpsEl.style.cssText = 'position:fixed;top:4px;right:4px;z-index:9999;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.7);padding:2px 6px;border-radius:3px;pointer-events:none;display:none';
document.body.appendChild(_fpsEl);
let _fpsFrames = 0, _fpsLast = performance.now(), _fpsMotes = 0;
function _fpsUpdate() {
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLast >= 1000) {
    _fpsEl.textContent = `${_fpsFrames} fps | ${_fpsMotes} motes`;
    _fpsFrames = 0;
    _fpsLast = now;
  }
}
window.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'F') _fpsEl.style.display = _fpsEl.style.display === 'none' ? '' : 'none';
});

function resizeMoteCanvas() {
  moteCanvas.width = window.innerWidth;
  moteCanvas.height = window.innerHeight;
}
resizeMoteCanvas();
window.addEventListener('resize', resizeMoteCanvas);

export function spawnMote(x, y, color) {
  const angle = Math.random() * Math.PI * 2;
  const speed = 0.3 + Math.random() * 1.2;
  motes.push({
    x, y,
    vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 0.5,
    vy: Math.sin(angle) * speed + (Math.random() - 0.5) * 0.5 - 0.3,
    life: 1.0,
    decay: 0.012 + Math.random() * 0.02,
    size: 1.5 + Math.random() * 2.5,
    color: color || [240, 216, 144],
    wobble: Math.random() * Math.PI * 2,
    wobbleSpeed: 0.05 + Math.random() * 0.1,
  });
}

// Ambient sparkle settings
let _sparkleAmbient = 0.3;   // ambient sparkle rate (0=off, 1=max)
let _sparkleNodes = 0.5;     // node aura sparkle rate
let _sparkleLeyLines = 0.4;  // ley line sparkle rate
let _sparkleGlowSize = 1.0;  // glow multiplier

// Cached map-world rect for sparkle spawners (updated once per spawn cycle)
let _sparkleRect = null;
const _sparkleColors = [[240,216,144],[180,200,255],[160,255,180],[200,160,255],[255,200,120]];

function _spawnAmbientSparkles() {
  if (_sparkleAmbient <= 0 || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleAmbient * 0.15 / _PERF.sparkleDiv;
  if (Math.random() < rate) {
    const c = _sparkleColors[Math.random() * 5 | 0];
    motes.push({
      x: Math.random() * moteCanvas.width, y: Math.random() * moteCanvas.height,
      vx: (Math.random() - 0.5) * 0.2, vy: -0.1 - Math.random() * 0.3,
      life: 1.0, decay: 0.004 + Math.random() * 0.008,
      size: 1 + Math.random() * 2, color: c,
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.03 + Math.random() * 0.06,
      twinkle: true,
    });
  }
}

function _spawnNodeSparkles() {
  if (_sparkleNodes <= 0 || !_topology || !_topology.nodes || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleNodes * 0.02 / _PERF.sparkleDiv;
  if (!_sparkleRect) return;
  const rect = _sparkleRect;
  const cw = moteCanvas.width, ch = moteCanvas.height;
  for (const n of _topology.nodes) {
    if (Math.random() > rate) continue;
    const iw = (n.iconStyle && n.iconStyle.width) ? parseInt(n.iconStyle.width) : 64;
    const ih = (n.iconStyle && n.iconStyle.height) ? parseInt(n.iconStyle.height) : 64;
    const sx = rect.left + (n.x + iw/2) * scale + (Math.random() - 0.5) * iw * scale * 0.6;
    const sy = rect.top + (n.y + ih/2) * scale + (Math.random() - 0.5) * ih * scale * 0.6;
    // Skip offscreen nodes
    if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
    if (motes.length >= _PERF.moteCap) break;
    const isCore = n.type === 'core';
    motes.push({
      x: sx, y: sy,
      vx: (Math.random() - 0.5) * 0.4, vy: -0.3 - Math.random() * 0.6,
      life: 1.0, decay: 0.008 + Math.random() * 0.012,
      size: isCore ? 2 + Math.random() * 2 : 1 + Math.random() * 1.5,
      color: isCore ? [255,220,100] : n.type === 'tower' ? [120,200,255] : [160,255,140],
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.04 + Math.random() * 0.08,
      twinkle: true,
    });
  }
}

const _leyColors = { wan: [100,180,255], bridge: [180,120,255], _default: [140,220,180] };
function _spawnLeyLineSparkles() {
  if (_sparkleLeyLines <= 0 || !_topology || !_topology.connections || motes.length >= _PERF.moteCap) return;
  const rate = _sparkleLeyLines * 0.015 / _PERF.sparkleDiv;
  if (!_sparkleRect) return;
  const rect = _sparkleRect;
  const nodeMap = _getTopoNodeMap();
  const cw = moteCanvas.width, ch = moteCanvas.height;
  for (const c of _topology.connections) {
    if (Math.random() > rate) continue;
    const fn = nodeMap.get(c.from), tn = nodeMap.get(c.to);
    if (!fn || !tn) continue;
    const t = Math.random();
    const sx = rect.left + (fn.x + (tn.x - fn.x) * t) * scale + (Math.random() - 0.5) * 10;
    const sy = rect.top + (fn.y + (tn.y - fn.y) * t) * scale + (Math.random() - 0.5) * 10;
    if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
    if (motes.length >= _PERF.moteCap) break;
    motes.push({
      x: sx, y: sy,
      vx: (tn.x - fn.x) * scale * 0.0004 + (Math.random() - 0.5) * 0.3,
      vy: (tn.y - fn.y) * scale * 0.0004 - 0.15,
      life: 1.0, decay: 0.01 + Math.random() * 0.015,
      size: 1 + Math.random() * 1.5,
      color: _leyColors[c.type] || _leyColors._default,
      wobble: Math.random() * Math.PI * 2, wobbleSpeed: 0.05 + Math.random() * 0.1,
      twinkle: true,
    });
  }
}

let _sparkleTimer = 0;
const _PI2 = Math.PI * 2;
let _moteSkipFrame = false;  // Halve frame rate when idle
let _motePaused = false;
document.addEventListener('visibilitychange', () => {
  _motePaused = document.hidden;
  // Disable connection animations when tab hidden (79 SVG repaints per frame)
  document.body.classList.toggle('reduce-motion', document.hidden);
});

// Cache sparkle rect on resize instead of in animation loop
const _sparkleRectWorld = document.getElementById('map-world');
function _updateSparkleRect() {
  if (_sparkleRectWorld) _sparkleRect = _sparkleRectWorld.getBoundingClientRect();
}
window.addEventListener('resize', _updateSparkleRect);
_updateSparkleRect();

function animateMotes() {
  // Skip entirely when tab hidden
  if (_motePaused) { requestAnimationFrame(animateMotes); return; }

  // Skip during active zoom
  if (_zoomActive) { requestAnimationFrame(animateMotes); return; }

  // 30fps cap — skip entire frame (spawn + physics + render) every other tick.
  // Must be before ALL work to actually halve CPU/GPU cost.
  _moteSkipFrame = !_moteSkipFrame;
  if (_moteSkipFrame) { requestAnimationFrame(animateMotes); return; }

  const cw = moteCanvas.width, ch = moteCanvas.height;

  // Spawn cycle
  _sparkleTimer++;
  const spawnDiv = _PERF.sparkleDiv;
  if (_sparkleTimer % (2 * spawnDiv) === 0) _spawnAmbientSparkles();
  if (_sparkleTimer % (8 * spawnDiv) === 0) _spawnNodeSparkles();
  if (_sparkleTimer % (6 * spawnDiv) === 0) _spawnLeyLineSparkles();

  if (motes.length === 0) {
    _fpsUpdate();
    requestAnimationFrame(animateMotes);
    return;
  }

  moteCtx.clearRect(0, 0, cw, ch);
  const doGlow = _PERF.moteGlow;
  const doStar = _PERF.moteStarCross;
  let writeIdx = 0;

  // Batch by color to reduce fillStyle changes (major canvas perf win)
  const colorBuckets = {};
  const glowBuckets = {};

  for (let i = 0, len = motes.length; i < len; i++) {
    const m = motes[i];
    m.x += m.vx + Math.sin(m.wobble) * 0.3;
    m.y += m.vy + Math.cos(m.wobble) * 0.2;
    m.wobble += m.wobbleSpeed;
    m.life -= m.decay;
    if (m.life <= 0) continue;
    if (writeIdx !== i) motes[writeIdx] = m;
    writeIdx++;
    if (m.x < -10 || m.x > cw + 10 || m.y < -10 || m.y > ch + 10) continue;
    const [r, g, b] = m.color;
    let a = m.life * 0.8;
    if (m.twinkle) a *= 0.5 + 0.5 * Math.sin(m.wobble * 3);
    if (a < 0.01) continue;
    const sz = m.size * m.life * _sparkleGlowSize;
    // Quantize alpha to reduce unique fillStyle strings (16 buckets)
    const aq = ((a * 15 + 0.5) | 0) / 15;
    const key = `${r},${g},${b},${aq.toFixed(2)}`;
    (colorBuckets[key] || (colorBuckets[key] = [])).push(m.x, m.y, sz);
    if (doGlow) {
      const gaq = ((a * 0.12 * 15 + 0.5) | 0) / 15;
      const gkey = `${r},${g},${b},${gaq.toFixed(3)}`;
      (glowBuckets[gkey] || (glowBuckets[gkey] = [])).push(m.x, m.y, sz * 2.5);
    }
    // Star-cross (high tier only)
    if (doStar && m.twinkle && a > 0.3 && sz > 1.5) {
      moteCtx.strokeStyle = `rgba(${r},${g},${b},${(a * 0.4).toFixed(2)})`;
      moteCtx.lineWidth = 0.5;
      const cr = sz * 3;
      moteCtx.beginPath();
      moteCtx.moveTo(m.x - cr, m.y); moteCtx.lineTo(m.x + cr, m.y);
      moteCtx.moveTo(m.x, m.y - cr); moteCtx.lineTo(m.x, m.y + cr);
      moteCtx.stroke();
    }
  }
  motes.length = writeIdx;

  // Draw glow halos first (behind), then main dots — batched by color
  if (doGlow) {
    for (const key in glowBuckets) {
      const arr = glowBuckets[key];
      moteCtx.fillStyle = `rgba(${key})`;
      moteCtx.beginPath();
      for (let j = 0; j < arr.length; j += 3) {
        moteCtx.moveTo(arr[j] + arr[j+2], arr[j+1]);
        moteCtx.arc(arr[j], arr[j+1], arr[j+2], 0, _PI2);
      }
      moteCtx.fill();
    }
  }
  for (const key in colorBuckets) {
    const arr = colorBuckets[key];
    moteCtx.fillStyle = `rgba(${key})`;
    moteCtx.beginPath();
    for (let j = 0; j < arr.length; j += 3) {
      moteCtx.moveTo(arr[j] + arr[j+2], arr[j+1]);
      moteCtx.arc(arr[j], arr[j+1], arr[j+2], 0, _PI2);
    }
    moteCtx.fill();
  }

  _fpsMotes = writeIdx;
  _fpsUpdate();
  requestAnimationFrame(animateMotes);
}
animateMotes();

// ── Layout persistence (localStorage) ──
// ── SSE Connection (replaces poll + pollEvents + refreshTopology + fetchEnergy) ──
let _sseTrafficMap = null;
let _sseConnected = false;
let _latencyMap = null;
let _wifiMap = null;

(function initSSE() {
  const sse = new EventSource(SSE_URL);
  let _sseRestoreMode = true;

  let _trafficRafPending = false;
  sse.addEventListener('traffic', e => {
    _sseTrafficMap = JSON.parse(e.data);
    if (!_trafficRafPending) {
      _trafficRafPending = true;
      requestAnimationFrame(() => {
        _trafficRafPending = false;
        updateConnectionTrafficSSE(_sseTrafficMap);
        const fakeCollectd = _trafficToCollectd(_sseTrafficMap);
        _lastTopoCollectd = fakeCollectd;
        if (_topoEnabled) renderTopoLayer(fakeCollectd);
      });
    }
  });

  sse.addEventListener('realm-event', e => {
    const evt = JSON.parse(e.data);
    renderEvent(evt, _sseRestoreMode);
  });

  sse.addEventListener('topology', e => {
    // Topology changes are rare. Re-use existing refreshTopology() which has DOM-preservation logic.
    refreshTopology();
  });

  sse.addEventListener('status', e => {
    const d = JSON.parse(e.data);
    _sseRestoreMode = false;
    updateUI(d);
    if (d.wifi) _wifiMap = d.wifi;
    if (!liveOk) {
      liveOk = true;
      console.log('Realm Map: SSE live data connected');
      // Stage 4: connected — hold for a beat, then dismiss
      if (window._advanceLoadStage) window._advanceLoadStage(4);
      const loadEl = document.getElementById('realm-loading');
      if (loadEl && !loadEl.classList.contains('dismissed')) {
        setTimeout(() => loadEl.classList.add('dismissed'), 1200);
      }
    }
  });

  sse.addEventListener('energy', e => {
    const data = JSON.parse(e.data);
    updateEnergyPanel(data);
  });

  sse.addEventListener('latency', e => {
    _latencyMap = JSON.parse(e.data);
    updateLatencyPanel();
  });

  sse.addEventListener('open', () => {
    if (!_sseConnected) {
      _sseConnected = true;
      _sseRestoreMode = true;
      console.log('Realm Map: SSE connected');
    }
  });

  sse.addEventListener('error', () => {
    if (_sseConnected) {
      _sseConnected = false;
      console.warn('Realm Map: SSE disconnected, reconnecting...');
      showOffline();
    }
  });
})();

const LAYOUT_KEY = 'realm-map-layout-v2';
const SETTINGS_KEY = 'realm-map-settings-v3';

// ── Panel Layout Modes (module-scope for persistence access) ──
const _PANEL_IDS = ['realm-panel','legend','spellbook','quest-log','realm-codex','node-list',
  'energy-panel','latency-panel','firewall-panel','wifi-panel','cartographer','debug-panel'];
const _MODE_DESCS = {
  manual: 'Panels stay where you place them.',
  auto: 'Panels auto-size and tile to fill the viewport beautifully.',
  focus: 'Unfocused panels fade. Hover to summon.',
};
let _panelMode = 'manual';

function setPanelMode(mode) {
  const prev = _panelMode;
  _panelMode = mode;
  document.body.classList.remove('panel-mode-manual', 'panel-mode-auto', 'panel-mode-focus', 'dynamic-panels');
  document.body.classList.add('panel-mode-' + mode);
  if (mode === 'auto') document.body.classList.add('dynamic-panels');
  document.querySelectorAll('.panel-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const desc = document.getElementById('panel-mode-desc');
  if (desc) desc.textContent = _MODE_DESCS[mode] || '';

  // Entering enchant: persist current layout so we can restore it later
  if (mode === 'auto' && prev !== 'auto') {
    saveLayout();
  }

  // Leaving enchant: strip treemap inline styles, restore saved layout
  if (prev === 'auto' && mode !== 'auto') {
    _PANEL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.left = ''; el.style.top = '';
      el.style.right = ''; el.style.bottom = '';
      el.style.width = ''; el.style.height = '';
      el.style.maxHeight = ''; el.style.transform = '';
    });
    // Re-apply saved layout (user's manual positions)
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const layout = JSON.parse(raw);
        if (layout.panels) {
          Object.entries(layout.panels).forEach(([id, pos]) => {
            const el = document.getElementById(id);
            if (!el || !pos.left) return;
            el.style.left = pos.left;
            el.style.top = pos.top;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.transform = 'none';
            if (pos.width) el.style.width = pos.width;
            if (pos.height) { el.style.height = pos.height; el.style.maxHeight = 'none'; }
          });
        }
      }
    } catch (e) { /* ignore */ }
    // Clamp any panel still off-screen
    _PANEL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.style.display === 'none' || el.classList.contains('panel-sealed')) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let moved = false;
      let l = rect.left, t = rect.top;
      if (rect.right < 40) { l = 20; moved = true; }
      if (rect.left > vw - 40) { l = vw - rect.width - 20; moved = true; }
      if (rect.bottom < 40) { t = 60; moved = true; }
      if (rect.top > vh - 40) { t = vh - rect.height - 20; moved = true; }
      if (moved) {
        el.style.left = Math.round(Math.max(0, l)) + 'px';
        el.style.top = Math.round(Math.max(56, t)) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    });
  }

  if (mode === 'auto') autoArrangePanels();
  saveSettings();
}

// Track last-interacted panel for enchant focus boost
let _lastActivePanel = null;
document.addEventListener('mousedown', e => {
  const p = e.target.closest('.panel, #debug-panel');
  if (p && _PANEL_IDS.includes(p.id)) _lastActivePanel = p.id;
}, true);

function _measurePanelWeight(el) {
  // Base importance — panels the user monitors most get higher base
  const importance = {
    'realm-panel': 3, 'quest-log': 5, 'realm-codex': 5, 'firewall-panel': 4, 'wifi-panel': 3,
    'node-list': 4, 'latency-panel': 3, 'spellbook': 3, 'energy-panel': 2,
    'cartographer': 2, 'legend': 2, 'debug-panel': 4,
  };
  const base = importance[el.id] || 3;

  // Content volume — measure how much scrollable content is hidden
  // Find the scrollable child (the panel body)
  const scrollChild = el.querySelector('[class*="-body"], .quest-cards, .spell-page:not([style*="display: none"]), .spell-page:not([style*="display:none"])');
  let contentRatio = 1;
  if (scrollChild) {
    const sh = scrollChild.scrollHeight || 100;
    const ch = scrollChild.clientHeight || 100;
    // Ratio > 1 means content is clipped — panel wants more space
    contentRatio = Math.min(3, sh / Math.max(ch, 1));
  }

  // Boost for last-interacted panel (user intent)
  const focusBoost = (_lastActivePanel === el.id) ? 1.5 : 1;

  // Final weight: importance × content need × focus
  return base * (0.5 + contentRatio * 0.5) * focusBoost;
}

function autoArrangePanels() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = 10;
  const topBar = 56;
  const pad = gap; // outer padding
  const ax = pad, ay = topBar + pad;
  const aw = vw - pad * 2, ah = vh - topBar - pad * 2;

  // Collect visible panels with measured weights
  const items = [];
  _PANEL_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.style.display === 'none' || el.classList.contains('panel-sealed')) return;
    items.push({ id, el, weight: _measurePanelWeight(el) });
  });
  if (!items.length) return;

  // Sort descending by weight (treemap needs this)
  items.sort((a, b) => b.weight - a.weight);

  // ── Treemap Layout ──
  // Recursive slice-and-dice: splits weighted panels into the bounding box,
  // alternating horizontal/vertical cuts. Heavier panels get proportionally
  // more area. Split point optimizes for balanced aspect ratios.
  const rects = new Map();

  function _treemapSlice(itemList, bx, by, bw, bh, horizontal) {
    if (itemList.length === 0) return;
    if (itemList.length === 1) {
      rects.set(itemList[0].id, { x: bx, y: by, w: bw, h: bh, el: itemList[0].el });
      return;
    }

    const total = itemList.reduce((s, it) => s + it.weight, 0) || 1;

    // Find split point — try to keep aspect ratios close to golden
    // Split where cumulative weight crosses ~half
    let cumul = 0;
    let bestSplit = 1, bestAspectScore = Infinity;
    for (let i = 0; i < itemList.length - 1; i++) {
      cumul += itemList[i].weight;
      const frac = cumul / total;
      // Compute aspect ratios for both halves
      let a1w, a1h, a2w, a2h;
      if (horizontal) {
        a1w = bw * frac; a1h = bh; a2w = bw * (1 - frac); a2h = bh;
      } else {
        a1w = bw; a1h = bh * frac; a2w = bw; a2h = bh * (1 - frac);
      }
      // Penalize extreme aspect ratios in either half
      const r1 = Math.max(a1w, a1h) / Math.max(Math.min(a1w, a1h), 1);
      const r2 = Math.max(a2w, a2h) / Math.max(Math.min(a2w, a2h), 1);
      // Also penalize uneven panel counts (prefer balanced splits)
      const balance = Math.abs((i + 1) / itemList.length - 0.5);
      const score = r1 + r2 + balance * 2;
      if (score < bestAspectScore) { bestAspectScore = score; bestSplit = i + 1; }
    }

    const left = itemList.slice(0, bestSplit);
    const right = itemList.slice(bestSplit);
    const leftWeight = left.reduce((s, it) => s + it.weight, 0);
    const frac = leftWeight / total;

    if (horizontal) {
      const lw = Math.max(80, Math.round(bw * frac - gap / 2));
      const rw = Math.max(80, bw - lw - gap);
      _treemapSlice(left, bx, by, lw, bh, !horizontal);
      _treemapSlice(right, bx + lw + gap, by, rw, bh, !horizontal);
    } else {
      const lh = Math.max(50, Math.round(bh * frac - gap / 2));
      const rh = Math.max(50, bh - lh - gap);
      _treemapSlice(left, bx, by, bw, lh, !horizontal);
      _treemapSlice(right, bx, by + lh + gap, bw, rh, !horizontal);
    }
  }

  // Start horizontal if viewport is landscape, vertical if portrait
  _treemapSlice(items, ax, ay, aw, ah, aw >= ah);

  // Apply positions
  rects.forEach((r, id) => {
    const el = r.el;
    el.style.position = 'fixed';
    el.style.left = Math.round(r.x) + 'px';
    el.style.top = Math.round(r.y) + 'px';
    el.style.width = Math.round(Math.max(100, r.w)) + 'px';
    el.style.height = Math.round(Math.max(60, r.h)) + 'px';
    el.style.maxHeight = 'none';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    // Sparkle burst
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    for (let s = 0; s < 3; s++) {
      setTimeout(() => {
        spawnMote(cx + (Math.random() - 0.5) * r.w * 0.5, cy + (Math.random() - 0.5) * r.h * 0.3, [192, 144, 255]);
      }, s * 70);
    }
  });
}

// Re-arrange on panel seal/unseal in auto mode
let _autoLayoutTimer;
document.addEventListener('panel-layout-change', () => {
  if (_panelMode === 'auto') {
    clearTimeout(_autoLayoutTimer);
    _autoLayoutTimer = setTimeout(autoArrangePanels, 350);
  }
});

// Re-arrange on window resize in auto mode
let _autoResizeTimer;
window.addEventListener('resize', () => {
  if (_panelMode === 'auto') {
    clearTimeout(_autoResizeTimer);
    _autoResizeTimer = setTimeout(autoArrangePanels, 200);
  }
});

// All slider/toggle IDs to persist
const _PERSIST_SLIDERS = [
  'master-scale', 'traffic-scale', 'node-scale', 'text-scale', 'bubble-scale', 'update-speed',
  'fx-ambient', 'fx-nodes', 'fx-leylines', 'fx-glow', 'fx-pulse', 'fx-leyglow',
  'topo-opacity', 'topo-spread', 'topo-contour', 'topo-rw', 'topo-rd',
  'grid-opacity', 'grid-scale', 'grid-hue', 'layer-grid',
  'layout-attract', 'layout-repulse', 'layout-edge', 'layout-spacing', 'layout-tilt',
  'biome-land', 'biome-glow', 'biome-roads', 'biome-peaks', 'biome-grid',
  'layer-terrain-orig', 'layer-terrain', 'layer-topo', 'layer-connections',
  'layer-regions', 'layer-nodes', 'layer-labels', 'layer-sublabels',
  'layer-vlanlabels', 'layer-bubbles',
  'panel-titlebar', 'panel-search', 'panel-vitals', 'panel-legend',
  'panel-codex', 'panel-spellbook', 'panel-questlog', 'panel-cartographer', 'panel-energy', 'panel-nodelist', 'panel-mirror', 'panel-latency', 'panel-firewall', 'panel-wifi',
  'layer-compass', 'layer-sparkles', 'layer-vignette',
  'compass-scale', 'sparkle-density', 'ambient-glow', 'vignette',
  'dock-opacity', 'dock-scale', 'dock-bg', 'layer-parchment',
];
const _PERSIST_CHECKBOXES = [
  'topo-toggle-cb', 'grid-toggle-cb', 'grid-pulse-cb',
  'vis-parchment', 'vis-terrain', 'vis-terrain-orig', 'vis-topo', 'vis-grid', 'vis-connections', 'vis-nodes', 'vis-labels',
  'vis-sublabels', 'vis-regions', 'vis-vlanlabels', 'vis-bubbles',
  'vis-compass', 'vis-sparkles', 'vis-vignette',
  'vis-titlebar', 'vis-search', 'vis-statuspanel', 'vis-legend', 'vis-spellbook',
  'vis-codex', 'vis-questlog', 'vis-cartographer', 'vis-energy', 'vis-nodelist', 'vis-debug', 'vis-latency', 'vis-firewall', 'vis-wifi',
  'vis-map-vines', 'vis-loading-vines',
];

// Debounce server saves (avoid hammering on every slider move)
let _saveTimer = null;
export function saveSettings() {
  if (_restoring) return;
  _initialRestoreDone = true;  // user interacted, don't let async restore override
  const vp = document.getElementById('map-viewport');
  const activePeTab = document.querySelector('.pe-tab.active');
  const s = {
    sliders: {}, checkboxes: {}, quality: null, collapsed: [], spellPage: _spellPage,
    zoom: { scale, panX, panY },
    selectedNode: currentEditNode,
    peTab: activePeTab?.dataset.peTab || 'stats',
    mirrorTab: activeTab,
    panelMode: _panelMode,
  };
  _PERSIST_SLIDERS.forEach(id => {
    const sl = document.getElementById(id + '-slider');
    if (sl) s.sliders[id] = sl.value;
  });
  _PERSIST_CHECKBOXES.forEach(id => {
    const cb = document.getElementById(id);
    if (cb) s.checkboxes[id] = cb.checked;
  });
  const qSel = document.getElementById('fx-quality-select');
  if (qSel) s.quality = qSel.value;
  document.querySelectorAll('.legend-section.collapsed').forEach(sec => {
    const ds = sec.dataset.section;
    if (ds) s.collapsed.push(ds);
  });
  // Save to localStorage immediately (fast local fallback)
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // Debounced save to server DB (shared across sessions)
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }).catch(() => {});
  }, 500);
}

let _restoring = false;
function _applySettings(s) {
  _restoring = true;
  if (s.sliders) {
    for (const [id, val] of Object.entries(s.sliders)) {
      const sl = document.getElementById(id + '-slider');
      if (sl) { sl.value = val; sl.dispatchEvent(new Event('input')); }
    }
  }
  if (s.checkboxes) {
    for (const [id, checked] of Object.entries(s.checkboxes)) {
      const cb = document.getElementById(id);
      if (cb && cb.checked !== checked) { cb.checked = checked; cb.dispatchEvent(new Event('change')); }
    }
  }
  if (s.quality) {
    const qSel = document.getElementById('fx-quality-select');
    if (qSel) { qSel.value = s.quality; qSel.dispatchEvent(new Event('change')); }
  }
  if (s.collapsed) {
    document.querySelectorAll('.legend-section').forEach(sec => {
      const ds = sec.dataset.section;
      if (ds) sec.classList.toggle('collapsed', s.collapsed.includes(ds));
    });
  }
  if (s.spellPage != null) _showSpellPage(s.spellPage);
  // Restore map zoom & pan position
  if (s.zoom) {
    scale = s.zoom.scale ?? 1;
    panX = s.zoom.panX ?? 0;
    panY = s.zoom.panY ?? 0;
    applyTransform();
  }
  // Restore selected node + PE tab
  if (s.selectedNode) {
    openPersonaEditor(s.selectedNode);
    if (s.peTab) _switchToTab(s.peTab);
  }
  // Restore mirror tab
  if (s.mirrorTab) {
    const tab = document.querySelector(`.log-tab[data-tab="${s.mirrorTab}"]`);
    if (tab) tab.click();
  }
  // Restore panel layout mode
  if (s.panelMode && _MODE_DESCS[s.panelMode]) {
    setPanelMode(s.panelMode);
  }
  // Seal state is managed by panel-manager.js via realm-panel-formation
  _restoring = false;
}

let _initialRestoreDone = false;
export function restoreSettings() {
  // Check for reset parameter - clears all saved settings
  if (new URLSearchParams(window.location.search).has('reset')) {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem('realm-panel-formation');
    localStorage.removeItem('realm-map-layout');
    fetch('/settings', { method: 'DELETE' }).catch(() => {});
    window.history.replaceState({}, '', window.location.pathname);
    console.log('Settings reset');
    return true;
  }
  // Try localStorage first (instant)
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) _applySettings(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  // Async: load from server DB (only if user hasn't interacted yet)
  fetch('/settings').then(r => r.ok ? r.json() : null).then(s => {
    if (s && Object.keys(s).length > 0 && !_initialRestoreDone) {
      _applySettings(s);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    }
    _initialRestoreDone = true;
  }).catch(() => { _initialRestoreDone = true; });
  return true;
}

export function saveLayout() {
  const layout = { panels: {}, nodes: {} };
  // Save panel positions
  ['realm-panel','legend','spellbook','quest-log','realm-codex','node-list','debug-panel','cartographer','energy-panel','latency-panel','firewall-panel','wifi-panel'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.style.left) {
      const p = { left: el.style.left, top: el.style.top };
      if (el.style.width) p.width = el.style.width;
      if (el.style.height) p.height = el.style.height;
      layout.panels[id] = p;
    }
  });
  // Save node positions
  document.querySelectorAll('.realm-node').forEach(n => {
    const tip = n.dataset.tip;
    if (tip) layout.nodes[tip] = { left: n.style.left, top: n.style.top };
  });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  // Save layout to server DB too
  fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _layout: layout }),
  }).catch(() => {});
  saveSettings();
}

function _applyLayout(layout) {
  if (!layout) return false;
  let applied = false;
  // Restore panels
  if (layout.panels) {
    Object.entries(layout.panels).forEach(([id, pos]) => {
      const el = document.getElementById(id);
      if (el && pos.left) {
        el.style.left = pos.left;
        el.style.top = pos.top;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
        if (pos.width) { el.style.width = pos.width; }
        if (pos.height) { el.style.height = pos.height; el.style.maxHeight = 'none'; }
      }
    });
    applied = true;
  }
  // Panel seal state managed by panel-manager.js
  // Restore node positions
  if (layout.nodes && Object.keys(layout.nodes).length) {
    Object.entries(layout.nodes).forEach(([tip, pos]) => {
      const el = document.querySelector(`[data-tip="${tip}"]`);
      if (el && pos.left) {
        el.style.left = pos.left;
        el.style.top = pos.top;
      }
      // Sync topology data with restored positions
      if (_topology && _topology.nodes && pos.left) {
        const tn = _topology.nodes.find(n => n.id === tip);
        if (tn) { tn.x = parseInt(pos.left); tn.y = parseInt(pos.top); }
      }
    });
    _topoNodeMap = null; // invalidate cached node map
    updateLinePositions();
    applied = true;
  }
  return applied;
}

export function restoreLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const layout = JSON.parse(raw);
      if (_applyLayout(layout)) return true;
    }
  } catch (e) { /* ignore corrupt layout */ }
  // Fallback: try server DB (layout is stored under _layout key in ui settings)
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/settings', false);
    xhr.send();
    if (xhr.status === 200) {
      const s = JSON.parse(xhr.responseText);
      if (s._layout) {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(s._layout));
        if (_applyLayout(s._layout)) return true;
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}

// Debounced save — write at most every 500ms during drag
let _layoutSaveTimer = null;
export function scheduleSave() {
  if (_restoring || _layoutSaveTimer) return;
  _layoutSaveTimer = setTimeout(() => { _layoutSaveTimer = null; saveLayout(); }, 500);
}
// Flush pending saves on page close
window.addEventListener('beforeunload', () => {
  if (_layoutSaveTimer) { clearTimeout(_layoutSaveTimer); _layoutSaveTimer = null; saveLayout(); }
});

// ── Draggable UI Panels (mouse + touch) ──
function makeDraggable(el, handleSelector, moteColor) {
  const handle = handleSelector ? el.querySelector(handleSelector) : el;
  if (!handle) return;
  let dx = 0, dy = 0, isDragging = false;
  handle.style.cursor = 'grab';

  function startDrag(cx, cy) {
    isDragging = true;
    const rect = el.getBoundingClientRect();
    dx = cx - rect.left;
    dy = cy - rect.top;
    handle.style.cursor = 'grabbing';
    el.style.transition = 'none';
  }
  function moveDrag(cx, cy) {
    if (!isDragging) return;
    el.style.left = (cx - dx) + 'px';
    el.style.top = (cy - dy) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
    if (Math.random() < 0.4) {
      spawnMote(cx + (Math.random()-0.5)*20, cy + (Math.random()-0.5)*20, moteColor);
    }
  }
  function endDrag() {
    if (isDragging) {
      isDragging = false;
      handle.style.cursor = 'grab';
      scheduleSave();
    }
  }

  const _skipDrag = t => t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.closest('button');

  // Mouse — attach move/up only while dragging
  handle.addEventListener('mousedown', e => {
    if (_skipDrag(e.target)) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
    const onMove = ev => moveDrag(ev.clientX, ev.clientY);
    const onUp = () => { endDrag(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // Touch — attach move/end only while dragging
  handle.addEventListener('touchstart', e => {
    if (_skipDrag(e.target)) return;
    if (e.touches.length !== 1) return;
    e.preventDefault();
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
    const onMove = ev => { if (ev.touches.length) moveDrag(ev.touches[0].clientX, ev.touches[0].clientY); };
    const onEnd = () => { endDrag(); window.removeEventListener('touchmove', onMove); window.removeEventListener('touchend', onEnd); };
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
  }, { passive: false });
}

// ── Magic Panel Resizing ──
function makeResizable(el, moteColor) {
  if (!el) return;
  // Create resize handle (bottom-right corner grip)
  const grip = document.createElement('div');
  grip.className = 'panel-resize-grip';
  grip.innerHTML = '&#9698;'; // ◢ triangle
  el.appendChild(grip);

  let isResizing = false, startX, startY, startW, startH;

  function startResize(cx, cy, e) {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    startX = cx;
    startY = cy;
    const rect = el.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    el.style.transition = 'none';
    grip.classList.add('active');
    document.body.style.userSelect = 'none';
  }
  function doResize(cx, cy) {
    if (!isResizing) return;
    const w = Math.max(140, startW + (cx - startX));
    const h = Math.max(80, startH + (cy - startY));
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
    el.style.maxHeight = 'none';
    // Sparkle trail on edge
    if (moteColor && Math.random() < 0.35) {
      spawnMote(cx + (Math.random() - 0.5) * 12, cy + (Math.random() - 0.5) * 12, moteColor);
    }
  }
  function endResize() {
    if (!isResizing) return;
    isResizing = false;
    grip.classList.remove('active');
    document.body.style.userSelect = '';
    scheduleSave();
    // Trigger re-arrange if in auto mode
    if (_panelMode === 'auto') {
      clearTimeout(_autoLayoutTimer);
      _autoLayoutTimer = setTimeout(autoArrangePanels, 300);
    }
  }

  // Mouse
  grip.addEventListener('mousedown', e => startResize(e.clientX, e.clientY, e));
  window.addEventListener('mousemove', e => doResize(e.clientX, e.clientY));
  window.addEventListener('mouseup', endResize);
  // Touch
  grip.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startResize(e.touches[0].clientX, e.touches[0].clientY, e);
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!isResizing || !e.touches.length) return;
    doResize(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', endResize, { passive: true });
}

// Make all fixed panels draggable with magic motes
makeDraggable(document.getElementById('realm-panel'), '.panel-header', [240,216,144]);
makeDraggable(document.getElementById('legend'), '.panel-header', [100,180,255]);
makeDraggable(document.getElementById('spellbook'), '.panel-header', [192,160,255]);
makeDraggable(document.getElementById('quest-log'), '#quest-log-header', [160,255,96]);
makeDraggable(document.getElementById('realm-codex'), '#codex-header', [144,96,192]);
makeDraggable(document.getElementById('cartographer'), '.panel-header', [192,144,96]);
makeDraggable(document.getElementById('energy-panel'), '.panel-header', [96,192,96]);
makeDraggable(document.getElementById('persona-editor'), '.pe-header', [240,200,100]);
makeDraggable(document.getElementById('node-list'), '#node-list-header', [192,144,96]);
makeDraggable(document.getElementById('latency-panel'), '.panel-header', [100,180,255]);
makeDraggable(document.getElementById('firewall-panel'), '.panel-header', [220,160,80]);
makeDraggable(document.getElementById('wifi-panel'), '.panel-header', [100,200,255]);

// Make all panels resizable with magical grip handles
makeResizable(document.getElementById('realm-panel'), [240,216,144]);
makeResizable(document.getElementById('legend'), [100,180,255]);
makeResizable(document.getElementById('spellbook'), [192,160,255]);
makeResizable(document.getElementById('quest-log'), [160,255,96]);
makeResizable(document.getElementById('realm-codex'), [144,96,192]);
makeResizable(document.getElementById('cartographer'), [192,144,96]);
makeResizable(document.getElementById('energy-panel'), [96,192,96]);
makeResizable(document.getElementById('node-list'), [192,144,96]);
makeResizable(document.getElementById('latency-panel'), [100,180,255]);
makeResizable(document.getElementById('firewall-panel'), [220,160,80]);
makeResizable(document.getElementById('wifi-panel'), [100,200,255]);
makeResizable(document.getElementById('debug-panel'), [120,80,200]);
makeResizable(document.getElementById('persona-editor'), [240,200,100]);

// ── Draggable Map Nodes (mouse + touch) ──
(function() {
  let dragNode = null, dragOffsetX = 0, dragOffsetY = 0, hasMoved = false;
  let _longPressTimer = null;
  let _dragFrame = 0, _dragRafPending = false;
  let _lastNodeTapTime = 0, _lastNodeTapped = null;
  let _dragStartCx = 0, _dragStartCy = 0;
  const DRAG_THRESHOLD = 8; // px before a tap becomes a drag
  const mapWorld = document.getElementById('map-world');

  function startNodeDrag(node, cx, cy) {
    dragNode = node;
    hasMoved = false;
    _dragStartCx = cx;
    _dragStartCy = cy;
    const nodeLeft = parseInt(node.style.left) || 0;
    const nodeTop = parseInt(node.style.top) || 0;
    const worldRect = mapWorld.getBoundingClientRect();
    const wx = (cx - worldRect.left) / scale;
    const wy = (cy - worldRect.top) / scale;
    dragOffsetX = wx - nodeLeft;
    dragOffsetY = wy - nodeTop;
    node.style.zIndex = '25';
    node.style.transition = 'none';
  }

  function moveNodeDrag(cx, cy) {
    if (!dragNode) return;
    // Require minimum movement before committing to a drag
    if (!hasMoved) {
      const dx = cx - _dragStartCx, dy = cy - _dragStartCy;
      if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      hasMoved = true;
    }
    dragging = false;
    _touchPanning = false;
    const worldRect = mapWorld.getBoundingClientRect();
    const wx = (cx - worldRect.left) / scale;
    const wy = (cy - worldRect.top) / scale;
    const nx = wx - dragOffsetX;
    const ny = wy - dragOffsetY;
    dragNode.style.left = nx + 'px';
    dragNode.style.top = ny + 'px';
    // Sync topology data so topo overlay tracks dragged position
    const tipId = dragNode.dataset.tip;
    if (tipId && _topology && _topology.nodes) {
      const tn = _topology.nodes.find(n => n.id === tipId);
      if (tn) { tn.x = nx; tn.y = ny; }
    }
    // Throttle expensive line recomputation (rAF + perf tier skip)
    _dragFrame++;
    if (_dragFrame % _PERF.dragLineThrottle === 0 && !_dragRafPending) {
      _dragRafPending = true;
      requestAnimationFrame(() => { _dragRafPending = false; updateLinePositions(); });
    }
    updateBubblePositions();
    if (Math.random() < 0.3) {
      const colors = [[240,216,144],[160,255,96],[100,180,255]];
      spawnMote(cx + (Math.random()-0.5)*16, cy + (Math.random()-0.5)*16,
        colors[Math.floor(Math.random()*colors.length)]);
    }
  }

  function endNodeDrag() {
    if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    if (dragNode) {
      const tappedNode = dragNode;
      dragNode.style.zIndex = '';
      dragNode.style.transition = '';
      if (hasMoved) {
        const rect = tappedNode.getBoundingClientRect();
        const cx = rect.left + rect.width/2;
        const cy = rect.top + rect.height/2;
        for (let i = 0; i < 12; i++) {
          spawnMote(cx + (Math.random()-0.5)*30, cy + (Math.random()-0.5)*30, [160,255,96]);
        }
        scheduleSave();
        // Re-render topo overlay with new node positions
        _topoNodeMap = null;
        _topoForceRender();
        generateTerrain();
        updateRegionLabels();
      } else {
        // No movement — this was a tap. Check for double-tap (mobile persona editor).
        const now = Date.now();
        if (_lastNodeTapped === tappedNode && now - _lastNodeTapTime < 400) {
          const key = tappedNode.dataset.tip;
          if (key) openPersonaEditor(key);
          _lastNodeTapTime = 0;
          _lastNodeTapped = null;
        } else {
          _lastNodeTapTime = now;
          _lastNodeTapped = tappedNode;
          // Single tap on cluster → toggle expand/collapse
          const tipKey = tappedNode.dataset.tip;
          if (tipKey && isClusterExpandable(tipKey)) {
            toggleClusterExpand(tipKey);
          }
        }
      }
      dragNode = null;
    }
  }

  // Delegated handlers on map-world (survives topology refresh)
  mapWorld.addEventListener('mousedown', e => {
    const node = e.target.closest('.realm-node');
    if (!node || e.button !== 0) return;
    e.stopPropagation();
    startNodeDrag(node, e.clientX, e.clientY);
  });

  mapWorld.addEventListener('touchstart', e => {
    const node = e.target.closest('.realm-node');
    if (!node || e.touches.length !== 1) return;
    e.stopPropagation();
    e.preventDefault();
    startNodeDrag(node, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });

  // Mouse move/up
  window.addEventListener('mousemove', e => moveNodeDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endNodeDrag);

  // Touch move/end
  window.addEventListener('touchmove', e => {
    if (!dragNode || !e.touches.length) return;
    e.preventDefault();
    moveNodeDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  window.addEventListener('touchend', endNodeDrag, { passive: true });
  window.addEventListener('touchcancel', endNodeDrag, { passive: true });
})();

// Restore saved layout on load (panel seal state managed by panel-manager.js)
restoreLayout();
// Always restore settings (sliders, toggles, collapsed sections) independently
restoreSettings();

// Zoom/pan is now saved by wheel, mouseup, and touchend handlers above

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

async function openNodeChat(nodeId, contextText, autoChat = true) {
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

// ── Arcane Config (MCP server settings) ──
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
  const d = lastStatus;
  const filter = (_dbgSearch?.value || '').toLowerCase().trim();
  const tab = _dbgTab;
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
    body += _dbgKV('last event ts', lastEventTs ? new Date(lastEventTs * 1000).toLocaleTimeString() : 'none');
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

  const _acMcpTools = [
    { name:'get_system_status', desc:'Raw sensor JSON', params:[], group:'Observation' },
    { name:'get_energy_status', desc:'HA energy data', params:[], group:'Observation' },
    { name:'trigger_system_observation', desc:'Fantasy narration', params:[], group:'Observation' },
    { name:'vocalize_message', desc:'Speak custom text', params:[{name:'text',type:'textarea',placeholder:'Text to speak'}], group:'Observation' },
    { name:'commune_with_system', desc:'Voice conversation', params:[], group:'Observation' },
    { name:'map_event', desc:'Push event to map', params:[{name:'type',type:'select',options:['speech','alert','quest','highlight']},{name:'node',type:'text',placeholder:'node id'},{name:'text',type:'textarea',placeholder:'Event text'}], group:'Map Events' },
    { name:'map_node_chat', desc:'Node speaks via persona', params:[{name:'node',type:'text',placeholder:'node id'},{name:'prompt',type:'textarea',placeholder:'Prompt'}], group:'Map Events' },
    { name:'get_map_events', desc:'Recent events', params:[{name:'since',type:'text',placeholder:'timestamp'}], group:'Map Events' },
    { name:'get_node_personas', desc:'List all personas', params:[], group:'Personas' },
    { name:'configure_persona', desc:'Create/update persona', params:[{name:'node',type:'text',placeholder:'node id'},{name:'name',type:'text',placeholder:'Name'},{name:'voice',type:'text',placeholder:'Voice'}], group:'Personas' },
    { name:'delete_persona', desc:'Remove persona', params:[{name:'node',type:'text',placeholder:'node id'}], group:'Personas' },
    { name:'herald_round', desc:'Multi-node voice round', params:[{name:'count',type:'text',placeholder:'2-5'}], group:'Personas' },
    { name:'get_topology', desc:'Full topology', params:[], group:'Topology' },
    { name:'configure_topology_node', desc:'Add/update node', params:[{name:'id',type:'text',placeholder:'node id'},{name:'label',type:'text',placeholder:'Label'}], group:'Topology' },
    { name:'get_collectd_data', desc:'RRD metrics', params:[{name:'hostname',type:'text',placeholder:'hostname (optional)'}], group:'Topology' },
    { name:'scan_wifi', desc:'AP scan', params:[{name:'action',type:'select',options:['scan','status']}], group:'Topology' },
    { name:'sync_notion_quests', desc:'Notion todo sync', params:[{name:'force',type:'checkbox',label:'Force'}], group:'Topology' },
    { name:'manage_map_server', desc:'HTTP server control', params:[{name:'action',type:'select',options:['status','start','stop','restart']}], group:'Services' },
    { name:'manage_herald', desc:'Herald daemon', params:[{name:'action',type:'select',options:['status','start','stop','once']}], group:'Services' },
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

  // Render MCP tools
  const mcpContainer = document.getElementById('ac-mcp');
  let mcpHtml = '', lastGroup = '';
  for (const tool of _acMcpTools) {
    if (tool.group !== lastGroup) {
      mcpHtml += `<div class="codex-tool-group">${tool.group}</div>`;
      lastGroup = tool.group;
    }
    mcpHtml += `<div class="ac-item" data-ac-type="mcp" data-ac-tool="${tool.name}">`;
    mcpHtml += `<div class="ac-item-header"><span class="ac-method ac-method-mcp">MCP</span><span class="ac-path">${tool.name}</span><span class="ac-desc">${tool.desc}</span></div>`;
    mcpHtml += `<div class="ac-form">${_acBuildForm(tool.params)}<button class="ac-invoke-btn">Cast</button><div class="ac-response" style="display:none"></div></div>`;
    mcpHtml += `</div>`;
  }
  mcpContainer.innerHTML = mcpHtml;
  document.getElementById('ac-mcp-count').textContent = _acMcpTools.length + ' spells';

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

  async function _acInvokeMcp(item) {
    const toolName = item.dataset.acTool;
    const form = item.querySelector('.ac-form'), params = _acCollectParams(form);
    const respEl = form.querySelector('.ac-response'), btn = form.querySelector('.ac-invoke-btn');
    btn.classList.add('ac-running'); btn.textContent = 'Casting...';
    respEl.style.display = 'block'; respEl.className = 'ac-response'; respEl.textContent = 'Weaving incantation...';
    try {
      const r = await fetch('/mcp/invoke', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tool: toolName, arguments: params }) });
      const text = await r.text();
      try { respEl.textContent = JSON.stringify(JSON.parse(text), null, 2); } catch { respEl.textContent = text; }
      if (!r.ok) respEl.classList.add('ac-error');
    } catch (e) { respEl.textContent = 'Error: ' + e.message; respEl.classList.add('ac-error'); }
    btn.classList.remove('ac-running'); btn.textContent = 'Cast';
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
      else if (item.dataset.acType === 'mcp') _acInvokeMcp(item);
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

