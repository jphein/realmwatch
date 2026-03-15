// ── Topology loading, rendering, ley-line routing, node DOM cache ──
// Note: innerHTML usage is safe here - all data comes from our own topology.json,
// not user input. Node icons/sublabels are defined server-side.
import { WORLD_SCALE } from './config.js';

export const tips = {};
export let _topology = null;
export const infraNodes = {};

const TYPE_TO_CLASS = { tower: 'tower-node', cluster: 'cluster-node', bridge: 'bridge-node', infra: 'infra-node', portal: 'portal-node' };
export const isTS = n => n.type === 'tailscale' || n.tailscale;
export const CONN_TYPE_TO_CLASS = { active:'conn-active', wan:'conn-wan', ap:'conn-ap', infra:'conn-infra', vlan:'conn-vlan', bridge:'conn-bridge', mesh:'conn-mesh', offline:'conn-offline', portal:'conn-portal' };

export const _tsHostMap = {};
export const _vlanLabels = [];
export const _connPaths = [];

// Hook for app.js to register bubble position updater (avoids circular import)
export let _onTopologyRefresh = null;
export function setTopologyRefreshHook(fn) { _onTopologyRefresh = fn; }

// ── Per-node DOM cache ──
export const _nodeDOM = {};
export function getNodeDOM(tipKey) {
  if (_nodeDOM[tipKey]) return _nodeDOM[tipKey];
  const el = document.querySelector(`[data-tip="${tipKey}"]`);
  if (!el) return (_nodeDOM[tipKey] = { el: null, sub: null, bar: null, pulse: null });
  _nodeDOM[tipKey] = {
    el,
    sub: el.querySelector('.node-sublabel'),
    bar: el.querySelector('.scale-fill'),
    pulse: el.querySelector('.pulse-ring'),
    isTower: el.classList.contains('tower-node'),
  };
  return _nodeDOM[tipKey];
}

// ── Ley-line routing ──
export function _getNodePos(nodeId) {
  const n = getNodeDOM(nodeId);
  if (n.el) return getNodeCenter(n.el);
  const tn = _topology?.nodes.find(nd => nd.id === nodeId);
  if (tn) {
    const is = tn.iconStyle || {};
    return { x: tn.x + (parseInt(is.width) || 64) / 2, y: tn.y + (parseInt(is.height) || 64) / 2 };
  }
  return null;
}

function _computeFanAngles() {
  if (!_topology) return [];
  const nodeConns = {};
  _topology.connections.forEach((c, i) => {
    const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
    if (!fp || !tp) return;
    (nodeConns[c.from] ||= []).push({ angle: Math.atan2(tp.y - fp.y, tp.x - fp.x), connIdx: i, isFrom: true });
    (nodeConns[c.to] ||= []).push({ angle: Math.atan2(fp.y - tp.y, fp.x - tp.x), connIdx: i, isFrom: false });
  });
  const result = _topology.connections.map(() => ({ fromAngle: 0, toAngle: 0 }));
  const MIN_GAP = 0.10;
  for (const conns of Object.values(nodeConns)) {
    conns.sort((a, b) => a.angle - b.angle);
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < conns.length; i++) {
        const j = (i + 1) % conns.length;
        let gap = conns[j].angle - conns[i].angle;
        if (j <= i) gap += Math.PI * 2;
        if (gap < MIN_GAP) {
          const push = (MIN_GAP - gap) / 2;
          conns[i].angle -= push;
          conns[j].angle += push;
        }
      }
    }
    for (const { angle, connIdx, isFrom } of conns) {
      if (isFrom) result[connIdx].fromAngle = angle;
      else result[connIdx].toAngle = angle;
    }
  }
  return result;
}

let _obstacles = [];
const _nodeSizeCache = new Map();  // id → {w, h} — nodes don't resize, just move
function _buildObstacles() {
  _obstacles = [];
  if (!_topology) return;
  for (const n of _topology.nodes) {
    const el = getNodeDOM(n.id);
    if (!el.el) continue;
    const left = parseInt(el.el.style.left) || 0;
    const top = parseInt(el.el.style.top) || 0;
    let sz = _nodeSizeCache.get(n.id);
    if (!sz) {
      sz = { w: el.el.offsetWidth, h: el.el.offsetHeight };
      _nodeSizeCache.set(n.id, sz);
    }
    const icon = el._icon || (el._icon = el.el.querySelector('.node-icon'));
    let iconScale = 1;
    if (icon && icon.style.transform) {
      const m = icon.style.transform.match(/scale\(([^)]+)\)/);
      if (m) iconScale = parseFloat(m[1]) || 1;
    }
    const cx = left + sz.w / 2;
    const cy = top + sz.h / 2;
    const rx = (sz.w / 2) * Math.max(1, iconScale) + 20;
    const ry = (sz.h / 2) * Math.max(1, iconScale) + 15;
    _obstacles.push({ id: n.id, x: cx, y: cy, rx, ry });
  }
}

function _hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function _computePathD(fp, tp, fromAngle, toAngle, fromId, toId) {
  const dist = Math.hypot(tp.x - fp.x, tp.y - fp.y);
  if (dist < 1) return `M${fp.x},${fp.y}L${tp.x},${tp.y}`;

  const dx = tp.x - fp.x, dy = tp.y - fp.y;
  const px = -dy / dist, py = dx / dist;
  const numSegs = Math.max(3, Math.min(6, Math.round(dist / 120)));
  const seed = _hashStr(fromId + '-' + toId);
  const phase = ((seed & 0xFFFF) / 0xFFFF) * Math.PI * 2;

  const waypoints = [{ x: fp.x, y: fp.y }];
  for (let i = 1; i < numSegs; i++) {
    const t = i / numSegs;
    const bx = fp.x + dx * t, by = fp.y + dy * t;
    const meander = (
      Math.sin(phase + t * Math.PI * 2) * 0.07 +
      Math.sin(phase * 1.7 + t * Math.PI * 3.5) * 0.03
    ) * dist;
    waypoints.push({ x: bx + px * meander, y: by + py * meander });
  }
  waypoints.push({ x: tp.x, y: tp.y });

  const obs = _obstacles.filter(o => o.id !== fromId && o.id !== toId);
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < waypoints.length - 1; i++) {
      const wp = waypoints[i];
      for (const o of obs) {
        const ndx = (wp.x - o.x) / o.rx, ndy = (wp.y - o.y) / o.ry;
        const ed = Math.hypot(ndx, ndy);
        if (ed < 1 && ed > 0) {
          const push = (1 - ed) * 0.7;
          const d = Math.hypot(wp.x - o.x, wp.y - o.y);
          wp.x += ((wp.x - o.x) / d) * push * o.rx;
          wp.y += ((wp.y - o.y) / d) * push * o.ry;
        }
      }
    }
  }

  const n = waypoints.length;
  const armLen = dist / numSegs * 0.5;
  const pBefore = { x: fp.x - Math.cos(fromAngle) * armLen, y: fp.y - Math.sin(fromAngle) * armLen };
  const pAfter = { x: tp.x - Math.cos(toAngle) * armLen, y: tp.y - Math.sin(toAngle) * armLen };

  let d = `M${fp.x.toFixed(1)},${fp.y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = i > 0 ? waypoints[i - 1] : pBefore;
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const p3 = i + 2 < n ? waypoints[i + 2] : pAfter;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

// ── Node center + line position update ──
export function getNodeCenter(nodeEl) {
  const left = parseInt(nodeEl.style.left) || 0;
  const top = parseInt(nodeEl.style.top) || 0;
  const icon = nodeEl.querySelector('.node-icon');
  if (icon) {
    return {
      x: left + icon.offsetLeft + icon.offsetWidth / 2,
      y: top + icon.offsetTop + icon.offsetHeight / 2
    };
  }
  return { x: left + 32, y: top + 32 };
}

export function updateLinePositions() {
  if (!_topology) return;
  _buildObstacles();
  const fanAngles = _computeFanAngles();
  _topology.connections.forEach((c, i) => {
    const path = _connPaths[i];
    if (!path) return;
    const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
    if (!fp || !tp) return;
    const fa = fanAngles[i] || { fromAngle: 0, toAngle: 0 };
    const d = _computePathD(fp, tp, fa.fromAngle, fa.toAngle, c.from, c.to);
    path.setAttribute('d', d);
    if (path._bridgeInner) path._bridgeInner.setAttribute('d', d);
  });
  _vlanLabels.forEach(({ label, connIdx }) => {
    const path = _connPaths[connIdx];
    if (!path) return;
    try {
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      label.style.left = mid.x + 'px';
      label.style.top = (mid.y - 4) + 'px';
    } catch (e) { /* path not yet rendered */ }
  });
}

// ── Render topology from server data ──
// All data comes from our server's topology.json - safe for DOM insertion
export function renderTopology(topo) {
  _topology = topo;
  topo.nodes.forEach(n => { n.x = Math.round(n.x * WORLD_SCALE); n.y = Math.round(n.y * WORLD_SCALE); });
  (topo.regions || []).forEach(r => { r.x = Math.round(r.x * WORLD_SCALE); r.y = Math.round(r.y * WORLD_SCALE); });
  const world = document.getElementById('map-world');
  const connSvg = document.querySelector('#connections');
  const nodeMap = {};
  topo.nodes.forEach(n => { nodeMap[n.id] = n; });

  topo.nodes.forEach(n => {
    const div = document.createElement('div');
    const tc = TYPE_TO_CLASS[n.type] || '';
    div.className = 'realm-node' + (tc ? ' ' + tc : '') + (n.collectd ? ' collectd-monitored' : '');
    let ns = `left:${n.x}px;top:${n.y}px;`;
    if (isTS(n) && !n.online) ns += 'opacity:0.4;';
    div.setAttribute('style', ns);
    div.dataset.tip = n.id;

    const icon = document.createElement('div');
    icon.className = 'node-icon';
    const is = n.iconStyle || {};
    if (isTS(n) && !n.online) {
      icon.setAttribute('style', 'background:#111;width:44px;height:44px;font-size:18px;border-color:rgba(100,100,100,0.3);box-shadow:none');
    } else {
      let ic = '';
      for (const [k,v] of Object.entries(is)) ic += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
      icon.setAttribute('style', ic);
    }
    if (n.pulse && !(isTS(n) && !n.online)) {
      const p = document.createElement('div');
      p.className = 'pulse-ring';
      if (n.pulseStyle?.borderColor) p.style.borderColor = n.pulseStyle.borderColor;
      if (isTS(n) && is.width) {
        const sz = parseInt(is.width);
        p.style.cssText = `width:${sz}px;height:${sz}px;margin:-${sz/2}px 0 0 -${sz/2}px`;
      }
      icon.appendChild(p);
    }
    if (n.badge) {
      const b = document.createElement('span');
      b.className = 'cluster-badge';
      b.textContent = n.badge;
      icon.appendChild(b);
    }
    // Safe: n.icon is from our topology.json, not user input
    icon.insertAdjacentHTML('beforeend', n.icon);
    div.appendChild(icon);

    const lbl = document.createElement('div');
    lbl.className = 'node-label';
    if (isTS(n) && !n.online) lbl.setAttribute('style', 'color:#606060;font-size:11px');
    else if (n.labelStyle) {
      let ls = '';
      for (const [k,v] of Object.entries(n.labelStyle)) ls += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
      lbl.setAttribute('style', ls);
    }
    lbl.textContent = n.label;
    div.appendChild(lbl);

    const sub = document.createElement('div');
    sub.className = 'node-sublabel';
    if (isTS(n) && !n.online) sub.setAttribute('style', 'color:#404040');
    // Safe: n.sublabel is from topology.json
    sub.innerHTML = n.sublabel;
    div.appendChild(sub);

    if (n.scaleBar) {
      const bar = document.createElement('div'); bar.className = 'scale-bar';
      const fill = document.createElement('div'); fill.className = 'scale-fill';
      let fs = `width:${n.scaleBar.width};`;
      if (n.scaleBar.gradient) fs += `background:${n.scaleBar.gradient};`;
      else if (n.scaleBar.color) fs += `background:${n.scaleBar.color};`;
      fill.setAttribute('style', fs);
      bar.appendChild(fill); div.appendChild(bar);
    }
    world.appendChild(div);

    if (n.tip) tips[n.id] = { title: n.tip.title, stats: [...(n.tip.stats || [])] };
    else {
      const auto = [];
      if (n._hostname) auto.push(['Hostname', n._hostname]);
      if (n.type) auto.push(['Type', n.type]);
      if (n.ip) auto.push(['IP', n.ip]);
      if (n._vendor) auto.push(['Vendor', n._vendor]);
      tips[n.id] = { title: n.label || n.id, stats: auto };
    }
    if (n.ip || n.ssh) infraNodes[n.id] = { name: n.label, ip: n.ip || '', collectdHost: n.collectd || null, sshHost: n.ssh || null, tsHost: n.tsHost || null };
    if (n.tsHost) _tsHostMap[n.tsHost] = n.id;
  });

  // Compute per-node VLAN assignment (majority vote from connections)
  const _vlanCounts = {};
  topo.connections.forEach(c => {
    if (!c.vlan) return;
    [c.from, c.to].forEach(id => {
      if (!_vlanCounts[id]) _vlanCounts[id] = {};
      _vlanCounts[id][c.vlan] = (_vlanCounts[id][c.vlan] || 0) + 1;
    });
  });
  const _nodeVlans = {};
  topo.nodes.forEach(n => {
    if (_vlanCounts[n.id]) {
      let best = 6, max = 0;
      for (const [v, cnt] of Object.entries(_vlanCounts[n.id])) { if (cnt > max) { max = cnt; best = +v; } }
      _nodeVlans[n.id] = best;
    } else {
      _nodeVlans[n.id] = (n.tailscale || n.type === 'tailscale') ? 0 : 6;
    }
  });

  // Connection paths (routed curves)
  _buildObstacles();
  const fanAngles = _computeFanAngles();
  topo.connections.forEach((c, i) => {
    const fn = nodeMap[c.from], tn = nodeMap[c.to];
    if (!fn || !tn) return;
    const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
    if (!fp || !tp) { _connPaths.push(null); return; }
    const fa = fanAngles[i] || { fromAngle: 0, toAngle: 0 };

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', _computePathD(fp, tp, fa.fromAngle, fa.toAngle, c.from, c.to));
    path.setAttribute('class', 'conn-line ' + (CONN_TYPE_TO_CLASS[c.type] || 'conn-active'));
    // VLAN data attribute for color-coding ley lines
    const connVlan = c.vlan || _nodeVlans[c.from] || _nodeVlans[c.to] || 6;
    path.dataset.vlan = connVlan;
    if (c.collectd) path.dataset.to = c.collectd;
    else path.dataset.to = c.to;
    path.dataset.from = c.from;
    path.dataset.fromNode = c.from;
    path.dataset.toNode = c.to;
    connSvg.appendChild(path);
    if (c.type === 'bridge') {
      const inner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      inner.setAttribute('d', path.getAttribute('d'));
      inner.setAttribute('class', 'conn-bridge-inner');
      connSvg.appendChild(inner);
      path._bridgeInner = inner;
    }
    _connPaths.push(path);

    if (c.vlan) {
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const label = document.createElement('div');
      label.className = 'vlan-label';
      label.textContent = 'VLAN ' + c.vlan;
      label.style.left = mid.x + 'px';
      label.style.top = (mid.y - 4) + 'px';
      world.appendChild(label);
      _vlanLabels.push({ label, connIdx: i });
    }
  });
}

// ── Load topology (async) ──
export async function loadTopology() {
  try {
    const r = await fetch('/topology');
    if (r.ok) {
      const topo = await r.json();
      renderTopology(topo);
    }
  } catch (e) {
    console.error('Realm Map: topology load failed', e);
  }
}

// ── Refresh topology (async, preserves scroll) ──
let _lastNodeCount = 0;
export async function refreshTopology() {
  try {
    const r = await fetch('/topology');
    if (!r.ok) return;
    const topo = await r.json();
    // Only re-render if node/connection count changed (avoids DOM thrash)
    const nc = (topo.nodes || []).length;
    const cc = (topo.connections || []).length;
    if (nc === _lastNodeCount && cc === (_topology?.connections || []).length) return;
    _lastNodeCount = nc;
    // Save current node positions (preserves auto-arrange / user drag)
    const savedPos = {};
    if (_topology) {
      _topology.nodes.forEach(n => { savedPos[n.id] = { x: n.x, y: n.y }; });
    }
    // Save scroll position
    const vp = document.getElementById('map-viewport');
    const sx = vp?.scrollLeft, sy = vp?.scrollTop;
    // Clear existing DOM + caches
    const world = document.getElementById('map-world');
    world.querySelectorAll('.realm-node, .region-label, .vlan-label').forEach(el => el.remove());
    const svg = document.querySelector('#connections');
    svg.innerHTML = '';
    _connPaths.length = 0;
    _vlanLabels.length = 0;
    Object.keys(_nodeDOM).forEach(k => delete _nodeDOM[k]);
    _nodeSizeCache.clear();
    // Re-render with server data
    renderTopology(topo);
    // Restore saved positions for existing nodes (auto-arrange / drag)
    if (Object.keys(savedPos).length > 0) {
      let restored = false;
      _topology.nodes.forEach(n => {
        if (savedPos[n.id]) {
          n.x = savedPos[n.id].x;
          n.y = savedPos[n.id].y;
          const el = document.querySelector(`[data-tip="${n.id}"]`);
          if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
          restored = true;
        }
      });
      if (restored) updateLinePositions();
    }
    // Restore scroll
    if (vp && sx != null) { vp.scrollLeft = sx; vp.scrollTop = sy; }
    // Notify app.js to update bubble positions
    if (_onTopologyRefresh) _onTopologyRefresh();
  } catch (e) { /* silent */ }
}

// ── Render a single node (reusable for initial render + cluster expand) ──
function _renderNode(n) {
  const world = document.getElementById('map-world');
  const div = document.createElement('div');
  const tc = TYPE_TO_CLASS[n.type] || '';
  div.className = 'realm-node' + (tc ? ' ' + tc : '') + (n.collectd ? ' collectd-monitored' : '');
  if (n._clusterChild) div.classList.add('cluster-child');
  div.setAttribute('style', `left:${n.x}px;top:${n.y}px;`);
  div.dataset.tip = n.id;

  const icon = document.createElement('div');
  icon.className = 'node-icon';
  const is = n.iconStyle || {};
  let ic = '';
  for (const [k,v] of Object.entries(is)) ic += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
  icon.setAttribute('style', ic);
  if (n.pulse) {
    const p = document.createElement('div');
    p.className = 'pulse-ring';
    if (n.pulseStyle?.borderColor) p.style.borderColor = n.pulseStyle.borderColor;
    icon.appendChild(p);
  }
  if (n.badge) {
    const b = document.createElement('span');
    b.className = 'cluster-badge';
    b.textContent = n.badge;
    icon.appendChild(b);
  }
  // Safe: icon HTML comes from our topology data, not user input
  icon.insertAdjacentHTML('beforeend', n.icon || '&#9670;');
  div.appendChild(icon);

  const lbl = document.createElement('div');
  lbl.className = 'node-label';
  if (n.labelStyle) {
    let ls = '';
    for (const [k,v] of Object.entries(n.labelStyle)) ls += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
    lbl.setAttribute('style', ls);
  }
  lbl.textContent = n.label;
  div.appendChild(lbl);

  const sub = document.createElement('div');
  sub.className = 'node-sublabel';
  // Safe: sublabel comes from our topology data, not user input
  sub.textContent = n.sublabel || '';
  div.appendChild(sub);

  world.appendChild(div);

  // Register in caches
  if (n.tip) tips[n.id] = { title: n.tip.title, stats: [...(n.tip.stats || [])] };
  else {
    const auto = []; if (n.type) auto.push(['Type', n.type]); if (n.ip) auto.push(['IP', n.ip]);
    tips[n.id] = { title: n.label || n.id, stats: auto };
  }
  if (n.ip) infraNodes[n.id] = { name: n.label, ip: n.ip, collectdHost: n.collectd || null, sshHost: null, tsHost: null };
  delete _nodeDOM[n.id]; // clear stale cache
  return div;
}

// ── Render a single connection (ley-line routed) ──
function _renderConn(conn) {
  const connSvg = document.querySelector('#connections');
  const fp = _getNodePos(conn.from), tp = _getNodePos(conn.to);
  if (!fp || !tp) return null;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', _computePathD(fp, tp, 0, 0, conn.from, conn.to));
  path.setAttribute('class', 'conn-line ' + (CONN_TYPE_TO_CLASS[conn.type] || 'conn-active'));
  if (conn._clusterChild) path.classList.add('conn-cluster-child');
  path.dataset.from = conn.from;
  path.dataset.to = conn.to;
  path.dataset.fromNode = conn.from;
  path.dataset.toNode = conn.to;
  connSvg.appendChild(path);
  _connPaths.push(path);
  return path;
}

// ── Expandable Clusters ──
const _expandedClusters = new Set();
const _clusterChildIds = {};   // clusterId → [nodeId, ...]

export function isClusterExpandable(nodeId) {
  const n = _topology?.nodes.find(nd => nd.id === nodeId);
  return n?.type === 'cluster' && n.members?.length > 0;
}

export function isClusterExpanded(nodeId) { return _expandedClusters.has(nodeId); }

export function toggleClusterExpand(clusterId) {
  if (_expandedClusters.has(clusterId)) collapseCluster(clusterId);
  else expandCluster(clusterId);
}

function expandCluster(clusterId) {
  const cluster = _topology?.nodes.find(n => n.id === clusterId);
  if (!cluster?.members?.length) return;
  const center = _getNodePos(clusterId);
  if (!center) return;

  const members = cluster.members;
  const childIds = [];

  // Group members by AP — position each group near its AP node
  const apGroups = {};  // ap_id → [member, ...]
  const noAp = [];
  members.forEach(m => {
    if (m.ap && _topology.nodes.find(n => n.id === m.ap)) {
      (apGroups[m.ap] ||= []).push(m);
    } else {
      noAp.push(m);
    }
  });

  const allPlacements = []; // [{member, tx, ty, apId}, ...]

  // Members with known APs: fan out along the line between AP and cluster
  for (const [apId, group] of Object.entries(apGroups)) {
    const apPos = _getNodePos(apId);
    if (!apPos) { noAp.push(...group); continue; }
    const midX = (apPos.x + center.x) / 2;
    const midY = (apPos.y + center.y) / 2;
    const fanRadius = Math.max(60, group.length * 18);
    const baseAngle = Math.atan2(center.y - apPos.y, center.x - apPos.x);
    group.forEach((m, i) => {
      const spread = (i - (group.length - 1) / 2) * 0.35;
      const a = baseAngle + spread;
      allPlacements.push({
        member: m,
        tx: Math.round(midX + Math.cos(a) * fanRadius),
        ty: Math.round(midY + Math.sin(a) * fanRadius),
        apId,
      });
    });
  }

  // Members without AP: orbit the cluster center
  const orbitRadius = Math.max(80, noAp.length * 22);
  noAp.forEach((m, i) => {
    const angle = (i / Math.max(noAp.length, 1)) * Math.PI * 2 - Math.PI / 2;
    allPlacements.push({
      member: m,
      tx: Math.round(center.x + Math.cos(angle) * orbitRadius),
      ty: Math.round(center.y + Math.sin(angle) * orbitRadius),
      apId: null,
    });
  });

  let idx = 0;
  allPlacements.forEach(({ member: m, tx, ty, apId }) => {
    const nodeId = `${clusterId}::${m.mac || idx}`;
    idx++;

    const nodeData = {
      id: nodeId, type: 'device',
      _clusterChild: true, _parentCluster: clusterId,
      x: center.x, y: center.y,
      _targetX: tx, _targetY: ty,
      icon: '&#9670;',
      label: m.label,
      sublabel: (m.hw ? m.hw : '') + (m.hw && m.ip ? ' \u2022 ' : '') + (m.ip || ''),
      ip: m.ip || '',
      iconStyle: {
        width: '30px', height: '30px', fontSize: '13px',
        background: 'radial-gradient(circle, #1a1520, #0f0d12)',
        borderColor: 'rgba(96,192,96,0.35)',
        boxShadow: '0 0 10px rgba(96,192,96,0.2)',
      },
      tip: {
        title: m.label,
        stats: [
          ['Hostname', m.hw || 'Unknown'], ['IP', m.ip || 'N/A'],
          ['MAC', m.mac || 'N/A'], ['AP', apId || 'Unknown'],
        ]
      },
    };

    _topology.nodes.push(nodeData);
    _renderNode(nodeData);

    // Connect to actual AP if known, otherwise to parent cluster
    const connTarget = apId || clusterId;
    const conn = { from: nodeId, to: connTarget, type: 'active', _clusterChild: true };
    _topology.connections.push(conn);
    _renderConn(conn);

    childIds.push(nodeId);
  });

  _clusterChildIds[clusterId] = childIds;
  _expandedClusters.add(clusterId);

  // Visual feedback on parent
  const clusterEl = document.querySelector(`[data-tip="${clusterId}"]`);
  if (clusterEl) clusterEl.classList.add('cluster-expanded');

  // Animate children outward from cluster center
  requestAnimationFrame(() => {
    childIds.forEach(nid => {
      const nd = _topology.nodes.find(n => n.id === nid);
      if (!nd) return;
      const el = document.querySelector(`[data-tip="${nid}"]`);
      if (!el) return;
      el.style.transition = 'left 0.45s cubic-bezier(0.34,1.56,0.64,1), top 0.45s cubic-bezier(0.34,1.56,0.64,1)';
      nd.x = nd._targetX; nd.y = nd._targetY;
      el.style.left = nd.x + 'px';
      el.style.top = nd.y + 'px';
    });
    // Rebuild ley-lines after animation settles
    setTimeout(() => { _buildObstacles(); updateLinePositions(); }, 470);
  });
}

function collapseCluster(clusterId) {
  const childIds = _clusterChildIds[clusterId];
  if (!childIds) return;
  const center = _getNodePos(clusterId);

  // Animate children back to cluster center
  childIds.forEach(nid => {
    const el = document.querySelector(`[data-tip="${nid}"]`);
    if (!el) return;
    el.style.transition = 'left 0.25s ease-in, top 0.25s ease-in, opacity 0.2s ease';
    if (center) { el.style.left = center.x + 'px'; el.style.top = center.y + 'px'; }
    el.style.opacity = '0';
  });

  // After animation, clean up DOM + topology data
  setTimeout(() => {
    const removeSet = new Set(childIds);
    _topology.nodes = _topology.nodes.filter(n => !removeSet.has(n.id));
    _topology.connections = _topology.connections.filter(c => !removeSet.has(c.from) && !removeSet.has(c.to));

    childIds.forEach(nid => {
      const el = document.querySelector(`[data-tip="${nid}"]`);
      if (el) el.remove();
      delete tips[nid];
      delete _nodeDOM[nid];
      delete infraNodes[nid];
    });

    // Remove SVG paths for child connections
    for (let i = _connPaths.length - 1; i >= 0; i--) {
      const p = _connPaths[i];
      if (p && (removeSet.has(p.dataset.fromNode) || removeSet.has(p.dataset.toNode))) {
        p.remove();
        _connPaths.splice(i, 1);
      }
    }
    _buildObstacles();
    updateLinePositions();
  }, 300);

  delete _clusterChildIds[clusterId];
  _expandedClusters.delete(clusterId);

  const clusterEl = document.querySelector(`[data-tip="${clusterId}"]`);
  if (clusterEl) clusterEl.classList.remove('cluster-expanded');
}

// loadTopology() called from main.js (async, non-blocking)
