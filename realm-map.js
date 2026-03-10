// ── Load topology synchronously so nodes exist before other JS runs ──
const tips = {};
let _topology = null;
{
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/topology', false); // synchronous
  xhr.send();
  if (xhr.status === 200) {
    const topo = JSON.parse(xhr.responseText);
    // renderTopology is defined below but we call it after definition
    window._pendingTopo = topo;
  }
}

// ── Helper functions ──
function scaleLabel(s) {
  if (s <= -7) return "Deep Depletion";
  if (s <= -3) return "Depleted";
  if (s <= 3) return "Balanced";
  if (s <= 7) return "Replete";
  return "Full Plenitude";
}
function scaleColor(s) {
  if (s <= -7) return "#ff4040";
  if (s <= -3) return "#f09040";
  if (s <= 3) return "#f0d040";
  if (s <= 7) return "#a0d060";
  return "#a0ff60";
}
function fmtBytes(b) {
  if (b == null) return "N/A";
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + " GB";
  if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b > 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}
function fmtRate(bps) {
  if (bps == null || bps === 0) return "0";
  if (bps > 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
  if (bps > 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return bps + " B/s";
}
function scalePct(s) { return Math.max(0, Math.min(100, (s + 10) / 20 * 100)); }

// ── Infrastructure node definitions (populated from topology.json) ──
const infraNodes = {};

// ── Topology renderer ──
const TYPE_TO_CLASS = { tower: 'tower-node', cluster: 'cluster-node', bridge: 'bridge-node', infra: 'infra-node', portal: 'portal-node' };
const isTS = n => n.type === 'tailscale' || n.tailscale;
const CONN_TYPE_TO_CLASS = { active:'conn-active', wan:'conn-wan', ap:'conn-ap', infra:'conn-infra', vlan:'conn-vlan', bridge:'conn-bridge', mesh:'conn-mesh', offline:'conn-offline', portal:'conn-portal' };

const _tsHostMap = {}; // tailscale hostname → node ID
const _vlanLabels = [];
const _connPaths = []; // path element per connection (same order as topo.connections)

// Cache per-node DOM elements (must be before routing functions that use getNodeDOM)
const _nodeDOM = {};
function getNodeDOM(tipKey) {
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

// ── Ley Line routing (rivers/streams flowing between nodes) ──
function _getNodePos(nodeId) {
  const n = getNodeDOM(nodeId);
  if (n.el) return getNodeCenter(n.el);
  // Fallback to topology data
  const tn = _topology?.nodes.find(nd => nd.id === nodeId);
  if (tn) {
    const is = tn.iconStyle || {};
    return { x: tn.x + (parseInt(is.width) || 64) / 2, y: tn.y + (parseInt(is.height) || 64) / 2 };
  }
  return null;
}

function _computeFanAngles() {
  if (!_topology) return [];
  const nodeConns = {}; // nodeId → [{angle, connIdx, isFrom}]
  _topology.connections.forEach((c, i) => {
    const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
    if (!fp || !tp) return;
    (nodeConns[c.from] ||= []).push({ angle: Math.atan2(tp.y - fp.y, tp.x - fp.x), connIdx: i, isFrom: true });
    (nodeConns[c.to] ||= []).push({ angle: Math.atan2(fp.y - tp.y, fp.x - tp.x), connIdx: i, isFrom: false });
  });
  const result = _topology.connections.map(() => ({ fromAngle: 0, toAngle: 0 }));
  const MIN_GAP = 0.10; // ~6 degrees minimum between adjacent connections
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

// Build obstacle list once per frame (shared across all connections)
// Covers the full node: icon + label + sublabel
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
    // Account for dynamic traffic scaling on the icon
    const icon = el.el.querySelector('.node-icon');
    let iconScale = 1;
    if (icon && icon.style.transform) {
      const m = icon.style.transform.match(/scale\(([^)]+)\)/);
      if (m) iconScale = parseFloat(m[1]) || 1;
    }
    // Elliptical obstacle covering the full node (icon + labels)
    const cx = left + w / 2;
    const cy = top + h / 2;
    const rx = (w / 2) * Math.max(1, iconScale) + 20;
    const ry = (h / 2) * Math.max(1, iconScale) + 15;
    _obstacles.push({ id: n.id, x: cx, y: cy, rx, ry });
  }
}

// Deterministic hash for consistent meander per connection
function _hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function _computePathD(fp, tp, fromAngle, toAngle, fromId, toId) {
  const dist = Math.hypot(tp.x - fp.x, tp.y - fp.y);
  if (dist < 1) return `M${fp.x},${fp.y}L${tp.x},${tp.y}`;

  const dx = tp.x - fp.x, dy = tp.y - fp.y;
  const px = -dy / dist, py = dx / dist; // perpendicular unit vector

  // More segments for longer paths = more meandering
  const numSegs = Math.max(3, Math.min(6, Math.round(dist / 120)));
  const seed = _hashStr(fromId + '-' + toId);
  const phase = ((seed & 0xFFFF) / 0xFFFF) * Math.PI * 2;

  // Build waypoints with sinusoidal meander offsets (river-like)
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

  // Push intermediate waypoints away from obstacles (elliptical: covers icon + labels)
  const obs = _obstacles.filter(o => o.id !== fromId && o.id !== toId);
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 1; i < waypoints.length - 1; i++) {
      const wp = waypoints[i];
      for (const o of obs) {
        // Elliptical distance: normalized so 1.0 = on the boundary
        const ndx = (wp.x - o.x) / o.rx, ndy = (wp.y - o.y) / o.ry;
        const ed = Math.hypot(ndx, ndy);
        if (ed < 1 && ed > 0) {
          const push = (1 - ed) * 0.7;
          // Push in the actual (non-normalized) direction
          const d = Math.hypot(wp.x - o.x, wp.y - o.y);
          wp.x += ((wp.x - o.x) / d) * push * o.rx;
          wp.y += ((wp.y - o.y) / d) * push * o.ry;
        }
      }
    }
  }

  // Catmull-Rom → cubic bezier path through waypoints (smooth interpolation)
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
    // Catmull-Rom to cubic bezier control points
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderTopology(topo) {
  _topology = topo;
  const world = document.getElementById('map-world');
  const connSvg = document.querySelector('#connections');
  const nodeMap = {};
  topo.nodes.forEach(n => { nodeMap[n.id] = n; });

  // Region labels
  const rc = document.getElementById('region-labels');
  (topo.regions || []).forEach(r => {
    const el = document.createElement('div');
    el.className = 'region-label';
    let s = `left:${r.x}px;top:${r.y}px;`;
    if (r.rotate) s += `transform:rotate(${r.rotate}deg);`;
    if (r.fontSize) s += `font-size:${r.fontSize}px;`;
    if (r.color) s += `color:${r.color};`;
    if (r.spacing) s += `letter-spacing:${r.spacing}px;`;
    el.setAttribute('style', s);
    el.dataset.rotate = r.rotate || 0;
    el.textContent = r.label;
    rc.appendChild(el);
  });

  // Nodes first (so getNodeCenter works for path routing)
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
    if (n.ip || n.ssh) infraNodes[n.id] = { name: n.label, ip: n.ip || '', collectdHost: n.collectd || null, sshHost: n.ssh || null, tsHost: n.tsHost || null };
    if (n.tsHost) _tsHostMap[n.tsHost] = n.id;
  });

  // Connection paths (routed curves — computed after nodes exist in DOM)
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
    // Bridge connections get a second inner energy beam
    if (c.type === 'bridge') {
      const inner = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      inner.setAttribute('d', path.getAttribute('d'));
      inner.setAttribute('class', 'conn-bridge-inner');
      connSvg.appendChild(inner);
      path._bridgeInner = inner;
    }
    _connPaths.push(path);

    // VLAN label at curve midpoint
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

// ── Render topology (must happen before updateUI / tooltips / dragging) ──
if (window._pendingTopo) { renderTopology(window._pendingTopo); delete window._pendingTopo; }

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

function updateUI(d) {
  lastStatus = d;
  updateGauges(d);
  updateCoreSublabels(d);
  updateInfraNodes(d);
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
  if (DOM.codexNodes) DOM.codexNodes.textContent = Object.keys(d.astral.nodes || {}).length + '+';

  updateConnectionTraffic(d.collectd);
  updateNodeListStatus(d);
  firePulse();
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
});

// ── Traffic scale slider ──
let trafficScale = 1.0;
const trafficSlider = document.getElementById('traffic-scale-slider');
const trafficScaleVal = document.getElementById('traffic-scale-val');
trafficSlider.addEventListener('input', () => {
  trafficScale = parseFloat(trafficSlider.value);
  trafficScaleVal.textContent = trafficScale.toFixed(1) + 'x';
  // Re-apply with current data
  if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
});

// ── Node scale slider ──
let nodeScale = 1.0;
const nodeScaleSlider = document.getElementById('node-scale-slider');
const nodeScaleVal = document.getElementById('node-scale-val');
nodeScaleSlider.addEventListener('input', () => {
  nodeScale = parseFloat(nodeScaleSlider.value) * masterScale;
  nodeScaleVal.textContent = nodeScale.toFixed(1) + 'x';
  document.querySelectorAll('.realm-node').forEach(node => {
    node.style.transform = `scale(${nodeScale})`;
  });
  updateLinePositions();
});

// ── Text scale slider ──
let textScale = 1.0;
const textScaleSlider = document.getElementById('text-scale-slider');
const textScaleVal = document.getElementById('text-scale-val');
textScaleSlider.addEventListener('input', () => {
  textScale = parseFloat(textScaleSlider.value) * masterScale;
  textScaleVal.textContent = textScale.toFixed(1) + 'x';
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

// ── Bubble scale slider ──
let bubbleScale = 1.0;
const bubbleScaleSlider = document.getElementById('bubble-scale-slider');
const bubbleScaleVal = document.getElementById('bubble-scale-val');
bubbleScaleSlider.addEventListener('input', () => {
  bubbleScale = parseFloat(bubbleScaleSlider.value) * masterScale;
  bubbleScaleVal.textContent = bubbleScale.toFixed(1) + 'x';
  document.documentElement.style.setProperty('--bubble-scale', bubbleScale);
});

// ── Update speed slider ──
let updateSpeedMs = 5000;
const updateSpeedSlider = document.getElementById('update-speed-slider');
const updateSpeedVal = document.getElementById('update-speed-val');
updateSpeedSlider.addEventListener('input', () => {
  updateSpeedMs = parseInt(updateSpeedSlider.value) * 1000;
  updateSpeedVal.textContent = updateSpeedSlider.value + 's';
});

// ── Connection traffic animation ──
// Color bases for each connection type (r,g,b)
const connColors = {
  'conn-active': [100,180,255], 'conn-ap': [100,180,255], 'conn-wan': [255,180,50],
  'conn-infra': [96,160,192], 'conn-bridge': [160,100,220], 'conn-vlan': [255,160,60],
  'conn-mesh': [120,220,120],
};

function getNodeTraffic(collectd, nodeKey) {
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
_connPaths.forEach(path => {
  if (!path) return;
  const cs = getComputedStyle(path);
  _connBaseWidths.set(path, parseFloat(cs.getPropertyValue('--sw')) || 1.5);
});

function updateConnectionTraffic(collectd) {
  if (!collectd) return;
  _connLinesWithData.forEach(line => {
    const toNode = line.dataset.to;
    const fromNode = line.dataset.from;
    const toTraffic = getNodeTraffic(collectd, toNode);
    const fromTraffic = fromNode ? getNodeTraffic(collectd, fromNode) : null;
    const traffic = (toTraffic && fromTraffic)
      ? (toTraffic.total > fromTraffic.total ? toTraffic : fromTraffic)
      : (toTraffic || fromTraffic);
    const baseW = _connBaseWidths.get(line) || 1.5;
    if (!traffic || traffic.total === 0) {
      line.style.setProperty('--sw', baseW);
      line.style.removeProperty('--speed');
      line.style.removeProperty('--dir');
      line.removeAttribute('stroke');
      line.classList.remove('conn-traffic-low', 'conn-traffic-med', 'conn-traffic-high');
      return;
    }
    // Realistic bandwidth scale: 0→1 mapped over 1 KB/s → 10 MB/s (log scale)
    const rawIntensity = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawIntensity * trafficScale);
    // Stroke width: base (frozen original) + up to 8px extra scaled by slider
    const sw = baseW + intensity * 8 * trafficScale;
    line.style.setProperty('--sw', sw.toFixed(1));
    // Animation speed: 20s → 2s (faster = more traffic)
    const speed = Math.max(2, 20 - intensity * 18);
    line.style.setProperty('--speed', speed.toFixed(1) + 's');
    // Flow direction: toward the hub if download-dominant, outward if upload-dominant
    const rxDominant = traffic.rx > traffic.tx;
    line.style.setProperty('--dir', rxDominant ? 'reverse' : 'normal');
    // Brighten stroke color
    const connType = Array.from(line.classList).find(c => connColors[c]);
    if (connType) {
      const [r,g,b] = connColors[connType];
      const alpha = 0.15 + intensity * 0.5;
      const bright = 1 + intensity * 0.3;
      line.setAttribute('stroke', `rgba(${Math.min(255,r*bright)|0},${Math.min(255,g*bright)|0},${Math.min(255,b*bright)|0},${alpha.toFixed(2)})`);
    }
    // Glow tier
    line.classList.remove('conn-traffic-low', 'conn-traffic-med', 'conn-traffic-high');
    if (intensity > 0.65) line.classList.add('conn-traffic-high');
    else if (intensity > 0.35) line.classList.add('conn-traffic-med');
    else if (intensity > 0.15) line.classList.add('conn-traffic-low');
  });

  // Scale node icons based on traffic through them
  document.querySelectorAll('.realm-node').forEach(node => {
    const tip = node.dataset.tip;
    if (!tip) return;
    const traffic = getNodeTraffic(collectd, tip);
    const icon = node.querySelector('.node-icon');
    if (!icon) return;
    if (!traffic || traffic.total === 0) {
      icon.style.transform = '';
      icon.style.filter = '';
      return;
    }
    const rawI = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    const intensity = Math.min(1, rawI * trafficScale);
    // Scale icon 1.0 → 1.5x based on traffic
    const scale = 1 + intensity * 0.5;
    icon.style.transform = `scale(${scale.toFixed(2)})`;
    // Add glow brightness boost
    if (intensity > 0.3) icon.style.filter = `brightness(${(1 + intensity * 0.4).toFixed(2)})`;
    else icon.style.filter = '';
  });
}

// ── Dynamic Ley Lines — curved paths follow dragged nodes ──
function getNodeCenter(nodeEl) {
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

function updateLinePositions() {
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
  // VLAN labels at curve midpoints (use SVG getPointAtLength for any path shape)
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

// Hook into node dragging — update lines on every mouse move
// (the existing drag handler in the IIFE below calls this)

// ── Event rendering ──
let lastEventTs = 0;
const EVENTS_POLL_MS = 1000;

async function pollEvents() {
  try {
    const r = await fetch(`/events?since=${lastEventTs}`);
    if (!r.ok) throw new Error(r.status);
    const events = await r.json();
    events.forEach(renderEvent);
  } catch (e) { /* silent */ }
  setTimeout(pollEvents, EVENTS_POLL_MS);
}
pollEvents();

const _pageLoadTs = Date.now() / 1000;

function renderEvent(evt) {
  lastEventTs = Math.max(lastEventTs, evt.ts || 0);
  const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);

  // Always log to quest log
  addLogEntry(evt, nodeEl);

  // Skip visual effects for stale server events (older than 30s before page load)
  const evtAge = _pageLoadTs - (evt.ts || 0);
  if (evtAge > 30 && !evt._local) { return; }

  if (!nodeEl) return;

  if (evt.type === 'speech') {
    showSpeechBubble(nodeEl, evt);
  } else if (evt.type === 'highlight') {
    showHighlight(nodeEl, evt);
  } else if (evt.type === 'alert') {
    showSpeechBubble(nodeEl, evt, true);
    showHighlight(nodeEl, { color: 'rgba(255,80,60,0.6)' });
  } else if (evt.type === 'quest') {
    showSpeechBubble(nodeEl, evt);
    showHighlight(nodeEl, { color: 'rgba(192,144,255,0.5)' });
  }
}

// ── Quest Log (enhanced with tabs) ──
let logCount = 0;
const MAX_LOG = 80;
let activeTab = 'all';

// Tab switching
document.querySelectorAll('.log-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.log-entry').forEach(entry => {
      if (activeTab === 'all') {
        entry.style.display = '';
      } else if (activeTab === 'notion') {
        entry.style.display = entry.classList.contains('notion-quest') ? '' : 'none';
      } else {
        entry.style.display = entry.classList.contains('log-' + activeTab) ? '' : 'none';
      }
    });
  });
});

// Codex toggle (click header to collapse)
document.getElementById('codex-header').addEventListener('click', () => {
  const body = document.getElementById('codex-body');
  body.style.display = body.style.display === 'none' ? '' : 'none';
});

// Quest log toggle (click header to collapse)
document.getElementById('quest-log-header').addEventListener('click', () => {
  const body = document.getElementById('quest-log-body');
  const tabs = document.getElementById('quest-log-tabs');
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  if (tabs) tabs.style.display = hidden ? '' : 'none';
});

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

function addLogEntry(evt, nodeEl) {
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

  entry.innerHTML = `<button class="log-dismiss" title="Dismiss">\u2715</button><div class="log-time">${timeStr}</div><div class="log-speaker">${name}</div>${textContent}`;

  // Dismiss button — also removes matching speech bubble and persists
  entry.querySelector('.log-dismiss').addEventListener('click', () => {
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

// Initial quest entries — rendered as full events (log + speech bubble + highlight)
const _initialQuests = [
  { type: 'quest', node: 'katana', text: 'Chart every node in the Digital Dominion \u2014 ensure all devices report their presence to the Citadel', duration: 12 },
  { type: 'quest', node: 'hp-switch', text: 'Awaken all Guardian Towers \u2014 bring collectd scrying to every AP in the realm', duration: 12 },
  { type: 'quest', node: 'gatekeeper', text: 'Unite the Enchanted Quarters \u2014 connect all IoT clusters through proper VLAN gateways', duration: 12 },
  { type: 'quest', node: 'gs308t', text: 'Map the Hub Stone \u2014 monitor all 8 switch ports and track inter-bridge traffic', duration: 12 },
  { type: 'quest', node: 'hp-switch', text: 'Bridge the realms \u2014 verify GigaBeam and CPE710 links carry full VLAN trunks', duration: 12 },
];
setTimeout(() => {
  addLogEntry({ type: 'system', node: 'katana', text: 'The Realm Map has been inscribed.', ts: Date.now()/1000 });
  const activeQuests = _initialQuests.filter(q => !_dismissedQuests.includes(q.text));
  // All quests appear together with staggered animations
  activeQuests.forEach((q, i) => {
    setTimeout(() => renderEvent({ ...q, ts: Date.now()/1000, _local: true }), i * 150);
  });
}, 800);

// Track active speech bubbles for repositioning during drag
const _activeBubbles = new Set();

function _positionBubble(bubble) {
  const nodeEl = bubble._nodeEl;
  if (!nodeEl || !nodeEl.isConnected) return;
  const nodeLeft = parseInt(nodeEl.style.left) || 0;
  const nodeTop = parseInt(nodeEl.style.top) || 0;
  const icon = nodeEl.querySelector('.node-icon');
  const iconW = icon ? icon.offsetWidth : 64;
  bubble.style.left = (nodeLeft + iconW / 2 - bubble.offsetWidth / 2) + 'px';
  bubble.style.top = (nodeTop - bubble.offsetHeight - 12) + 'px';
}

function updateBubblePositions() {
  _activeBubbles.forEach(b => {
    if (!b.isConnected) { _activeBubbles.delete(b); return; }
    _positionBubble(b);
  });
}

function _dismissBubble(bubble) {
  bubble.style.animation = 'bubbleOut 0.3s ease-in forwards';
  setTimeout(() => { bubble.remove(); _activeBubbles.delete(bubble); }, 300);
}

function showSpeechBubble(nodeEl, evt, isAlert) {
  // Remove existing bubble on same node to avoid stacking
  for (const b of _activeBubbles) {
    if (b._nodeEl === nodeEl) { _dismissBubble(b); break; }
  }

  const bubble = document.createElement('div');
  const isQuest = evt.type === 'quest';
  const isNotion = evt._source === 'notion';
  let cls = 'speech-bubble';
  if (isAlert) cls += ' alert-bubble';
  if (isQuest) cls += ' quest-bubble';
  if (isNotion) cls += ' notion-bubble';
  bubble.className = cls;
  bubble._nodeEl = nodeEl;
  const name = nodeEl.querySelector('.node-label')?.textContent || evt.node;

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bubble-close';
  closeBtn.innerHTML = '\u00D7';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _dismissBubble(bubble);
  });

  const prefix = isNotion ? '<span style="color:#a080e0">&#127744;</span> ' : (isQuest ? '<span style="color:#c090ff">&#9733;</span> ' : '');
  bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${prefix}${evt.text || ''}</div>`;
  bubble.appendChild(closeBtn);
  if (evt.color) bubble.style.borderColor = evt.color;

  const world = document.getElementById('map-world');
  world.appendChild(bubble);
  _positionBubble(bubble);
  _activeBubbles.add(bubble);

  // Quests stay until manually closed; other bubbles auto-dismiss
  if (!isQuest) {
    const dur = (evt.duration || 15) * 1000;
    setTimeout(() => { if (bubble.isConnected) _dismissBubble(bubble); }, dur);
  }
}

function showHighlight(nodeEl, evt) {
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

function firePulse() {
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

function showOffline() {
  if (_pulseCore) { _pulseCore.style.background = '#804040'; _pulseCore.style.boxShadow = 'none'; }
  if (_pulseLabel) { _pulseLabel.textContent = 'OFFLINE'; _pulseLabel.style.color = '#604040'; }
}

// ── Polling ──
const STATUS_URL = '/status';
let POLL_MS = 5000;

async function poll() {
  try {
    const r = await fetch(STATUS_URL);
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    updateUI(d);
    if (!liveOk) { liveOk = true; console.log('Realm Map: live data connected'); }
  } catch (e) {
    showOffline();
  }
  setTimeout(poll, updateSpeedMs);
}
poll();

// ── Pan & zoom ──
const canvas = document.getElementById('map-canvas');
const world = document.getElementById('map-world');
let scale = 1, panX = 0, panY = 0;
let dragging = false, lastX, lastY;

function applyTransform() {
  world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  updateMinimap();
}

function centerMap() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = Math.min(cw / 3200, ch / 2200) * 1.2;
  panX = (cw - 3200 * scale) / 2;
  panY = (ch - 2200 * scale) / 2;
  applyTransform();
}

function panToNode(x, y) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  scale = 1.2;
  panX = cw / 2 - x * scale;
  panY = ch / 2 - y * scale;
  applyTransform();
}

canvas.addEventListener('mousedown', e => {
  dragging = true;
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  panX += e.clientX - lastX;
  panY += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  applyTransform();
});
window.addEventListener('mouseup', () => dragging = false);

// ── Touch: pan & pinch-to-zoom ──
let _touchPanning = false, _lastTouch = null, _pinchDist = null;
canvas.addEventListener('touchstart', e => {
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
  if (e.touches.length === 2 && _pinchDist !== null) {
    e.preventDefault();
    const newDist = Math.hypot(
      e.touches[1].clientX - e.touches[0].clientX,
      e.touches[1].clientY - e.touches[0].clientY
    );
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const rect = canvas.getBoundingClientRect();
    const mx = midX - rect.left, my = midY - rect.top;
    const oldScale = scale;
    scale = Math.max(0.3, Math.min(3, scale * (newDist / _pinchDist)));
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
  _touchPanning = false; _lastTouch = null; _pinchDist = null;
}, { passive: true });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const oldScale = scale;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  scale = Math.max(0.3, Math.min(3, scale * delta));
  panX = mx - (mx - panX) * (scale / oldScale);
  panY = my - (my - panY) * (scale / oldScale);
  applyTransform();
}, { passive: false });

// ── Tooltips ──
const tooltip = document.getElementById('tooltip');
document.querySelectorAll('.realm-node').forEach(node => {
  node.addEventListener('mouseenter', e => {
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
  node.addEventListener('mousemove', e => {
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top = (e.clientY + 16) + 'px';
  });
  node.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
});

// ── Minimap ──
const minimap = document.getElementById('minimap');
const viewport = document.getElementById('minimap-viewport');
const mmW = 200, mmH = 138, worldW = 3200, worldH = 2200;

// Generate minimap dots from topology data (no more hardcoded positions)
const MINIMAP_COLORS = {
  core: '#f0d890', infra: '#60a0c0', tower: '#c09060',
  bridge: '#9060c0', cluster: '#60c060', tailscale: '#40c040',
};
if (_topology) {
  _topology.nodes.forEach(n => {
    const dot = document.createElement('div');
    dot.className = 'minimap-dot';
    dot.dataset.mmTip = n.id;
    dot.style.left = (n.x / worldW * mmW) + 'px';
    dot.style.top = (n.y / worldH * mmH) + 'px';
    const isOffline = isTS(n) && !n.online;
    const mmType = n.tailscale ? 'tailscale' : n.type;
    dot.style.background = isOffline ? '#404040' : (MINIMAP_COLORS[mmType] || '#f0d890');
    minimap.appendChild(dot);
  });
}

function updateMinimap() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const vx = -panX / scale / worldW * mmW;
  const vy = -panY / scale / worldH * mmH;
  const vw = cw / scale / worldW * mmW;
  const vh = ch / scale / worldH * mmH;
  viewport.style.left = Math.max(0, vx) + 'px';
  viewport.style.top = Math.max(0, vy) + 'px';
  viewport.style.width = Math.min(mmW, vw) + 'px';
  viewport.style.height = Math.min(mmH, vh) + 'px';
}

// Init
centerMap();
window.addEventListener('resize', centerMap);

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

function openPersonaEditor(nodeKey) {
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
  if (!cd && !tsPeer) {
    body.innerHTML = '<div class="pe-stats-empty">No sigils bound to this node.</div>';
    return;
  }

  let html = '';

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

  if (!cd) { body.innerHTML = html; return; }

  // System section
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

  body.innerHTML = html;
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

// Double-click a node to open persona editor
document.querySelectorAll('.realm-node').forEach(node => {
  node.addEventListener('dblclick', e => {
    e.stopPropagation();
    const key = node.dataset.tip;
    if (key) openPersonaEditor(key);
  });
});

// ── Panel Minimize System (double-click header → fantasy icon) ──
const PANEL_ICONS = {
  'realm-panel':  { icon: '\u2694', tooltip: 'Realm Vitals',  color: '#f0d890', rgb: [240,216,144] },
  'legend':       { icon: '\u2726', tooltip: 'Map Legend',     color: '#64b4ff', rgb: [100,180,255] },
  'quest-log':    { icon: '\u2619', tooltip: 'Quest Log',     color: '#a0ff60', rgb: [160,255,96] },
  'realm-codex':  { icon: '\u2630', tooltip: 'Realm Codex',   color: '#9060c0', rgb: [144,96,192] },
  'minimap':      { icon: '\u25CE', tooltip: 'Minimap',       color: '#60a0c0', rgb: [96,160,192] },
  'node-list':    { icon: '\u2691', tooltip: 'Realm Census',  color: '#c09060', rgb: [192,144,96] },
};

function setupPanelMinimize(panelId, handleSelector) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const cfg = PANEL_ICONS[panelId] || { icon: '\u2726', tooltip: panelId, color: '#f0d890' };

  // Create the minimized icon element (always in DOM, hidden until minimized)
  const minIcon = document.createElement('div');
  minIcon.className = 'panel-min-icon';
  minIcon.dataset.tooltip = cfg.tooltip;
  minIcon.innerHTML = `<span style="color:${cfg.color};filter:drop-shadow(0 0 4px ${cfg.color})">${cfg.icon}</span><div class="min-glow" style="box-shadow:0 0 8px ${cfg.color}30"></div>`;
  panel.appendChild(minIcon);

  // Detect handle element
  const handle = handleSelector ? panel.querySelector(handleSelector) : panel;
  if (!handle) return;

  let _dblClickTimer = null;

  handle.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    if (panel.classList.contains('panel-minimized')) return;
    // Store original dimensions for restore
    panel._origWidth = panel.style.width || '';
    panel._origMinWidth = panel.style.minWidth || '';
    panel._origMaxHeight = panel.style.maxHeight || '';
    panel._origPadding = panel.style.padding || '';
    panel._origBorderRadius = panel.style.borderRadius || '';
    panel._origOverflow = panel.style.overflow || '';
    panel.classList.add('panel-minimized');
    panel.style.animation = 'panelMinimize 0.4s ease-out';
    // Spawn motes on minimize
    const rect = panel.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    for (let i = 0; i < 8; i++) {
      spawnMote(cx + (Math.random() - 0.5) * 40, cy + (Math.random() - 0.5) * 40,
        cfg.rgb);
    }
    scheduleSave();
  });

  // Click the minimized icon to restore
  minIcon.addEventListener('click', e => {
    e.stopPropagation();
    if (!panel.classList.contains('panel-minimized')) return;
    if (minIcon._wasDragged) { minIcon._wasDragged = false; return; }
    panel.classList.remove('panel-minimized');
    panel.style.animation = '';
    // Spawn motes on restore
    const rect = panel.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    for (let i = 0; i < 6; i++) {
      spawnMote(cx + (Math.random() - 0.5) * 60, cy + (Math.random() - 0.5) * 60,
        cfg.rgb);
    }
    scheduleSave();
  });

  // Make minimized icon draggable (drags the whole panel)
  let _minDx = 0, _minDy = 0, _minDragging = false, _minMoved = false;
  function minStartDrag(cx, cy) {
    _minDragging = true; _minMoved = false;
    const rect = panel.getBoundingClientRect();
    _minDx = cx - rect.left; _minDy = cy - rect.top;
    minIcon.style.cursor = 'grabbing';
  }
  function minMoveDrag(cx, cy) {
    if (!_minDragging) return;
    _minMoved = true;
    panel.style.left = (cx - _minDx) + 'px';
    panel.style.top = (cy - _minDy) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.transform = 'none';
    if (Math.random() < 0.4) spawnMote(cx + (Math.random()-0.5)*20, cy + (Math.random()-0.5)*20, cfg.rgb);
  }
  function minEndDrag() {
    if (_minDragging) {
      _minDragging = false;
      minIcon.style.cursor = 'pointer';
      if (_minMoved) { minIcon._wasDragged = true; scheduleSave(); }
    }
  }
  minIcon.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); minStartDrag(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => minMoveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', minEndDrag);
  minIcon.addEventListener('touchstart', e => { if (e.touches.length !== 1) return; e.preventDefault(); e.stopPropagation(); minStartDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
  window.addEventListener('touchmove', e => { if (_minDragging && e.touches.length) minMoveDrag(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener('touchend', minEndDrag, { passive: true });
}

// Wire up all panels
setupPanelMinimize('realm-panel', 'h3');
setupPanelMinimize('legend', 'h3');

// Legend collapsible sections
document.querySelectorAll('.legend-section-header').forEach(header => {
  header.addEventListener('click', () => {
    header.parentElement.classList.toggle('collapsed');
  });
});
// Start with Nodes and Effects collapsed, Lines and Controls open
document.querySelector('.legend-section[data-section="nodes"]')?.classList.add('collapsed');
document.querySelector('.legend-section[data-section="effects"]')?.classList.add('collapsed');
setupPanelMinimize('quest-log', '#quest-log-header');
setupPanelMinimize('realm-codex', '#codex-header');
setupPanelMinimize('minimap', null);
setupPanelMinimize('node-list', '#node-list-header');

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

function updateNodeListStatus(d) {
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

// ── Magic Motes Trail (for draggable elements) ──
const moteCanvas = document.createElement('canvas');
moteCanvas.id = 'mote-canvas';
moteCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:300';
document.body.appendChild(moteCanvas);
const moteCtx = moteCanvas.getContext('2d');
let motes = [];

function resizeMoteCanvas() {
  moteCanvas.width = window.innerWidth;
  moteCanvas.height = window.innerHeight;
}
resizeMoteCanvas();
window.addEventListener('resize', resizeMoteCanvas);

function spawnMote(x, y, color) {
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

function animateMotes() {
  moteCtx.clearRect(0, 0, moteCanvas.width, moteCanvas.height);
  for (let i = motes.length - 1; i >= 0; i--) {
    const m = motes[i];
    m.x += m.vx + Math.sin(m.wobble) * 0.3;
    m.y += m.vy + Math.cos(m.wobble) * 0.2;
    m.wobble += m.wobbleSpeed;
    m.life -= m.decay;
    if (m.life <= 0) { motes.splice(i, 1); continue; }
    const [r, g, b] = m.color;
    const a = m.life * 0.8;
    moteCtx.beginPath();
    moteCtx.arc(m.x, m.y, m.size * m.life, 0, Math.PI * 2);
    moteCtx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(2)})`;
    moteCtx.fill();
    // Glow
    moteCtx.beginPath();
    moteCtx.arc(m.x, m.y, m.size * m.life * 2.5, 0, Math.PI * 2);
    moteCtx.fillStyle = `rgba(${r},${g},${b},${(a * 0.15).toFixed(3)})`;
    moteCtx.fill();
  }
  requestAnimationFrame(animateMotes);
}
animateMotes();

// ── Layout persistence (localStorage) ──
const LAYOUT_KEY = 'realm-map-layout';
function saveLayout() {
  const layout = { panels: {}, nodes: {}, minimized: [] };
  // Save panel positions and minimized state
  ['realm-panel','legend','quest-log','realm-codex','minimap','node-list'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.style.left) {
      layout.panels[id] = { left: el.style.left, top: el.style.top };
    }
    if (el && el.classList.contains('panel-minimized')) {
      layout.minimized.push(id);
    }
  });
  // Save node positions
  document.querySelectorAll('.realm-node').forEach(n => {
    const tip = n.dataset.tip;
    if (tip) layout.nodes[tip] = { left: n.style.left, top: n.style.top };
  });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

function restoreLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return false;
    const layout = JSON.parse(raw);
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
        }
      });
    }
    // Restore minimized panels
    if (layout.minimized) {
      layout.minimized.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('panel-minimized');
      });
    }
    // Restore node positions
    if (layout.nodes) {
      Object.entries(layout.nodes).forEach(([tip, pos]) => {
        const el = document.querySelector(`[data-tip="${tip}"]`);
        if (el && pos.left) {
          el.style.left = pos.left;
          el.style.top = pos.top;
        }
      });
      // Update ley lines after restoring node positions
      updateLinePositions();
    }
    return true;
  } catch (e) { /* ignore corrupt layout */ }
  return false;
}

// Debounced save — write at most every 500ms during drag
let _saveTimer = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveLayout(); }, 500);
}

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

  // Mouse
  handle.addEventListener('mousedown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  // Touch
  handle.addEventListener('touchstart', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.touches.length !== 1) return;
    e.preventDefault();
    startDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!isDragging || !e.touches.length) return;
    moveDrag(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', endDrag, { passive: true });
}

// Make all fixed panels draggable with magic motes
makeDraggable(document.getElementById('realm-panel'), 'h3', [240,216,144]);
makeDraggable(document.getElementById('legend'), 'h3', [100,180,255]);
makeDraggable(document.getElementById('quest-log'), '#quest-log-header', [160,255,96]);
makeDraggable(document.getElementById('realm-codex'), '#codex-header', [144,96,192]);
makeDraggable(document.getElementById('minimap'), null, [96,160,192]);
makeDraggable(document.getElementById('persona-editor'), '.pe-header', [240,200,100]);
makeDraggable(document.getElementById('node-list'), '#node-list-header', [192,144,96]);

// ── Draggable Map Nodes (mouse + touch) ──
(function() {
  let dragNode = null, dragOffsetX = 0, dragOffsetY = 0, hasMoved = false;
  let _longPressTimer = null;
  const mapWorld = document.getElementById('map-world');

  function startNodeDrag(node, cx, cy) {
    dragNode = node;
    hasMoved = false;
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
    hasMoved = true;
    dragging = false;
    _touchPanning = false;
    const worldRect = mapWorld.getBoundingClientRect();
    const wx = (cx - worldRect.left) / scale;
    const wy = (cy - worldRect.top) / scale;
    const nx = wx - dragOffsetX;
    const ny = wy - dragOffsetY;
    dragNode.style.left = nx + 'px';
    dragNode.style.top = ny + 'px';
    updateLinePositions();
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
      dragNode.style.zIndex = '';
      dragNode.style.transition = '';
      if (hasMoved) {
        const rect = dragNode.getBoundingClientRect();
        const cx = rect.left + rect.width/2;
        const cy = rect.top + rect.height/2;
        for (let i = 0; i < 12; i++) {
          spawnMote(cx + (Math.random()-0.5)*30, cy + (Math.random()-0.5)*30, [160,255,96]);
        }
        scheduleSave();
      }
      dragNode = null;
    }
  }

  document.querySelectorAll('.realm-node').forEach(node => {
    // Mouse
    node.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      startNodeDrag(node, e.clientX, e.clientY);
    });

    // Touch — drag immediately on single touch (consistent with mouse)
    node.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      startNodeDrag(node, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
  });

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

// Restore saved layout on load, or apply defaults (only legend + vitals maximized)
if (!restoreLayout()) {
  ['quest-log', 'realm-codex', 'minimap', 'node-list'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('panel-minimized');
  });
}

