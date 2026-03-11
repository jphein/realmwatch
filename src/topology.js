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
function _buildObstacles() {
  _obstacles = [];
  if (!_topology) return;
  for (const n of _topology.nodes) {
    const el = getNodeDOM(n.id);
    if (!el.el) continue;
    const left = parseInt(el.el.style.left) || 0;
    const top = parseInt(el.el.style.top) || 0;
    const w = el.el.offsetWidth;
    const h = el.el.offsetHeight;
    const icon = el.el.querySelector('.node-icon');
    let iconScale = 1;
    if (icon && icon.style.transform) {
      const m = icon.style.transform.match(/scale\(([^)]+)\)/);
      if (m) iconScale = parseFloat(m[1]) || 1;
    }
    const cx = left + w / 2;
    const cy = top + h / 2;
    const rx = (w / 2) * Math.max(1, iconScale) + 20;
    const ry = (h / 2) * Math.max(1, iconScale) + 15;
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
      const auto = []; if (n.type) auto.push(['Type', n.type]); if (n.ip) auto.push(['IP', n.ip]);
      tips[n.id] = { title: n.label || n.id, stats: auto };
    }
    if (n.ip || n.ssh) infraNodes[n.id] = { name: n.label, ip: n.ip || '', collectdHost: n.collectd || null, sshHost: n.ssh || null, tsHost: n.tsHost || null };
    if (n.tsHost) _tsHostMap[n.tsHost] = n.id;
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

// ── Load topology synchronously ──
export function loadTopology() {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/topology', false);
  xhr.send();
  if (xhr.status === 200) {
    const topo = JSON.parse(xhr.responseText);
    renderTopology(topo);
  }
}

// Load topology synchronously at module init
loadTopology();
