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
const TYPE_TO_CLASS = { tower: 'tower-node', cluster: 'cluster-node', bridge: 'bridge-node', infra: 'infra-node' };
const CONN_TYPE_TO_CLASS = { active:'conn-active', wan:'conn-wan', ap:'conn-ap', infra:'conn-infra', vlan:'conn-vlan', bridge:'conn-bridge', mesh:'conn-mesh', offline:'conn-offline' };

const _vlanLabels = [];
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
    el.textContent = r.label;
    rc.appendChild(el);
  });

  // Connection lines
  topo.connections.forEach(c => {
    const fn = nodeMap[c.from], tn = nodeMap[c.to];
    if (!fn || !tn) return;
    const fis = fn.iconStyle || {}, tis = tn.iconStyle || {};
    const fW = parseInt(fis.width) || 64, fH = parseInt(fis.height) || 64;
    const tW = parseInt(tis.width) || 64, tH = parseInt(tis.height) || 64;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', fn.x + fW/2); line.setAttribute('y1', fn.y + fH/2);
    line.setAttribute('x2', tn.x + tW/2); line.setAttribute('y2', tn.y + tH/2);
    line.setAttribute('class', 'conn-line ' + (CONN_TYPE_TO_CLASS[c.type] || 'conn-active'));
    if (c.collectd) line.dataset.to = c.collectd;
    else line.dataset.to = c.to;
    line.dataset.from = c.from;
    line.dataset.fromNode = c.from;
    line.dataset.toNode = c.to;
    connSvg.appendChild(line);

    // VLAN label at midpoint (HTML div — SVG text breaks line setAttribute)
    if (c.vlan) {
      const mx = (fn.x + fW/2 + tn.x + tW/2) / 2, my = (fn.y + fH/2 + tn.y + tH/2) / 2;
      const label = document.createElement('div');
      label.className = 'vlan-label';
      label.textContent = 'VLAN ' + c.vlan;
      label.style.left = mx + 'px';
      label.style.top = (my - 4) + 'px';
      world.appendChild(label);
      _vlanLabels.push({ label, fromId: c.from, toId: c.to });
    }
  });

  // Nodes
  topo.nodes.forEach(n => {
    const div = document.createElement('div');
    const tc = TYPE_TO_CLASS[n.type] || '';
    div.className = 'realm-node' + (tc ? ' ' + tc : '');
    let ns = `left:${n.x}px;top:${n.y}px;`;
    if (n.type === 'tailscale' && !n.online) ns += 'opacity:0.4;';
    div.setAttribute('style', ns);
    div.dataset.tip = n.id;

    const icon = document.createElement('div');
    icon.className = 'node-icon';
    const is = n.iconStyle || {};
    if (n.type === 'tailscale' && !n.online) {
      icon.setAttribute('style', 'background:#111;width:44px;height:44px;font-size:18px;border-color:rgba(100,100,100,0.3);box-shadow:none');
    } else {
      let ic = '';
      for (const [k,v] of Object.entries(is)) ic += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
      icon.setAttribute('style', ic);
    }
    if (n.pulse && !(n.type === 'tailscale' && !n.online)) {
      const p = document.createElement('div');
      p.className = 'pulse-ring';
      if (n.pulseStyle?.borderColor) p.style.borderColor = n.pulseStyle.borderColor;
      if (n.type === 'tailscale' && is.width) {
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
    if (n.type === 'tailscale' && !n.online) lbl.setAttribute('style', 'color:#606060;font-size:11px');
    else if (n.labelStyle) {
      let ls = '';
      for (const [k,v] of Object.entries(n.labelStyle)) ls += `${k.replace(/[A-Z]/g, m => '-'+m.toLowerCase())}:${v};`;
      lbl.setAttribute('style', ls);
    }
    lbl.textContent = n.label;
    div.appendChild(lbl);

    const sub = document.createElement('div');
    sub.className = 'node-sublabel';
    if (n.type === 'tailscale' && !n.online) sub.setAttribute('style', 'color:#404040');
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
    if (n.ip) infraNodes[n.id] = { name: n.label, ip: n.ip };
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

// Cache per-node DOM elements (sublabel, scale-fill, pulse-ring, root element)
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
  if (gkN.sub) gkN.sub.textContent = astral.nodes.Gatekeeper ? 'OpenWrt Router \u2022 10.0.6.1' : 'SILENT \u2022 10.0.6.1';
  if (gkN.pulse) gkN.pulse.style.display = astral.nodes.Gatekeeper ? '' : 'none';

  const oN = getNodeDOM('oracle');
  if (oN.sub) oN.sub.textContent = astral.nodes.ubox0 ? 'ubox0 \u2022 10.0.6.11' : 'SILENT \u2022 10.0.6.11';
  if (oN.pulse) oN.pulse.style.display = astral.nodes.ubox0 ? '' : 'none';
}

function findStatusKey(nodeStatus, tipKey) {
  return Object.keys(nodeStatus).find(k => k.toLowerCase() === tipKey.toLowerCase())
    || Object.keys(nodeStatus).find(k => k.replace(/-/g, '').toLowerCase() === tipKey.replace(/-/g, '').toLowerCase());
}

function findCollectd(collectd, tipKey, statusKey) {
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
    ["Status", astral.nodes.Katana ? "Online \u2014 Unsheathed" : "OFFLINE"],
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
    ["Status", astral.nodes.Gatekeeper ? "Standing Watch" : "Silent"],
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

  tips.oracle.stats = [["Role", "Network Monitor"], ["Hostname", "ubox0"], ["IP", "10.0.6.11"], ["Status", astral.nodes.ubox0 ? "Pulsing" : "Silent"]];
  tips.forge.stats = [["Usage", forge.usage.toFixed(1) + "%"], ["Temperature", forge.temp != null ? forge.temp.toFixed(0) + "\u00B0C" : "N/A"], ["Scale", `${forge.scale >= 0 ? '+' : ''}${forge.scale.toFixed(1)} (${scaleLabel(forge.scale)})`], ["Reading", forge.msg]];
  tips.mana.stats = [["Usage", mana.usage.toFixed(1) + "%"], ["Scale", `${mana.scale >= 0 ? '+' : ''}${mana.scale.toFixed(1)} (${scaleLabel(mana.scale)})`], ["Reading", mana.msg]];
  tips.gpu.stats = gpu ? [["Temperature", gpu.temp.toFixed(0) + "\u00B0C"], ["Load", gpu.load.toFixed(0) + "%"]] : [["Status", "No GPU detected"]];
  tips.essence.stats = [["Charge", essence.usage.toFixed(0) + "%"], ["Source", essence.plugged ? "Eternal Source (plugged)" : "Untethered"], ["Scale", `${essence.scale >= 0 ? '+' : ''}${essence.scale.toFixed(1)} (${scaleLabel(essence.scale)})`]];
  tips.wan.stats = [["Total Traversed", astral.nft ? fmtBytes(astral.nft.wan) : "N/A"], ["Direction", "Outward \u2014 to the Outer Darkness"], ["Guarded By", "The Gatekeeper (nftables)"]];
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

// ── Connection traffic animation ──
// Color bases for each connection type (r,g,b)
const connColors = {
  'conn-active': [100,180,255], 'conn-ap': [100,180,255], 'conn-wan': [255,180,50],
  'conn-infra': [96,160,192], 'conn-bridge': [160,100,220], 'conn-vlan': [255,160,60],
  'conn-mesh': [120,220,120],
};

function getNodeTraffic(collectd, nodeKey) {
  if (!collectd) return null;
  // Try exact match, then fuzzy match
  const cd = collectd[nodeKey]
    || Object.values(collectd).find(c => c.hostname && c.hostname.toLowerCase().replace(/[-_]/g,'') === nodeKey.toLowerCase().replace(/[-_]/g,''));
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

// Snapshot connection lines once (cached for traffic + ley line updates)
const _connLines = Array.from(document.querySelectorAll('#connections .conn-line'));
const _connLinesWithData = _connLines.filter(l => l.dataset.to);
const _connBaseWidths = new Map();
_connLines.forEach(line => {
  const cs = getComputedStyle(line);
  _connBaseWidths.set(line, parseFloat(cs.getPropertyValue('--sw')) || 1.5);
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
    // Stroke width: base (frozen original) + up to 3px extra scaled by slider
    const sw = baseW + intensity * 3 * trafficScale;
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
}

// ── Dynamic Ley Lines — connection lines follow dragged nodes ──
// Build a map of node positions (data-tip → center coords in map space)
const nodePositions = {};
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

// Build initial position map and line→node mapping
const lineNodeMap = []; // [{line, fromTip, toTip}]
(function buildLineNodeMap() {
  // Map node data-tip → initial SVG coordinates (from the original line endpoints)
  const tipToCoord = {};
  document.querySelectorAll('.realm-node').forEach(n => {
    const tip = n.dataset.tip;
    if (tip) tipToCoord[tip] = getNodeCenter(n);
  });

  document.querySelectorAll('#connections .conn-line').forEach(line => {
    const x1 = parseFloat(line.getAttribute('x1'));
    const y1 = parseFloat(line.getAttribute('y1'));
    const x2 = parseFloat(line.getAttribute('x2'));
    const y2 = parseFloat(line.getAttribute('y2'));
    // Find nearest nodes to each endpoint
    let fromTip = null, toTip = null;
    let bestD1 = 80, bestD2 = 80; // max match distance
    for (const [tip, pos] of Object.entries(tipToCoord)) {
      const d1 = Math.hypot(pos.x - x1, pos.y - y1);
      const d2 = Math.hypot(pos.x - x2, pos.y - y2);
      if (d1 < bestD1) { bestD1 = d1; fromTip = tip; }
      if (d2 < bestD2) { bestD2 = d2; toTip = tip; }
    }
    if (fromTip || toTip) {
      lineNodeMap.push({ line, fromTip, toTip });
    }
  });
})();

function updateLinePositions() {
  lineNodeMap.forEach(({ line, fromTip, toTip }) => {
    if (fromTip) {
      const n = getNodeDOM(fromTip);
      if (n.el) {
        const pos = getNodeCenter(n.el);
        line.setAttribute('x1', pos.x);
        line.setAttribute('y1', pos.y);
      }
    }
    if (toTip) {
      const n = getNodeDOM(toTip);
      if (n.el) {
        const pos = getNodeCenter(n.el);
        line.setAttribute('x2', pos.x);
        line.setAttribute('y2', pos.y);
      }
    }
  });
  // Update VLAN labels to midpoint of their connection's endpoints
  _vlanLabels.forEach(({ label, fromId, toId }) => {
    const fn = getNodeDOM(fromId), tn = getNodeDOM(toId);
    if (fn.el && tn.el) {
      const fp = getNodeCenter(fn.el), tp = getNodeCenter(tn.el);
      label.style.left = ((fp.x + tp.x) / 2) + 'px';
      label.style.top = ((fp.y + tp.y) / 2 - 4) + 'px';
    }
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

function renderEvent(evt) {
  lastEventTs = Math.max(lastEventTs, evt.ts || 0);
  const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);

  // Always log to quest log
  addLogEntry(evt, nodeEl);

  if (!nodeEl) return;

  if (evt.type === 'speech') {
    showSpeechBubble(nodeEl, evt);
  } else if (evt.type === 'highlight') {
    showHighlight(nodeEl, evt);
  } else if (evt.type === 'alert') {
    showSpeechBubble(nodeEl, evt, true);
    showHighlight(nodeEl, { color: 'rgba(255,80,60,0.6)' });
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

function addLogEntry(evt, nodeEl) {
  if (!_logBody) return;
  const body = _logBody, counter = _logCounter;

  const name = nodeEl ? (nodeEl.querySelector('.node-label')?.textContent || evt.node) : (evt.node || 'System');
  const time = new Date((evt.ts || Date.now() / 1000) * 1000);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const entry = document.createElement('div');
  const logType = evt.type || 'speech';
  entry.className = `log-entry log-${logType} log-entry-new`;

  let textContent = '';
  if (evt.text) {
    const prefix = logType === 'speech' ? '\u201C' : '';
    const suffix = logType === 'speech' ? '\u201D' : '';
    textContent = `<div class="log-text">${prefix}${evt.text}${suffix}</div>`;
  } else if (logType === 'highlight') {
    textContent = `<div class="log-text" style="font-style:italic;color:#708060">A pulse of energy ripples outward.</div>`;
  }

  entry.innerHTML = `<div class="log-time">${timeStr}</div><div class="log-speaker">${name}</div>${textContent}`;

  // Tab filter
  if (activeTab !== 'all' && !entry.classList.contains('log-' + activeTab)) {
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

// Initial quest entries
setTimeout(() => {
  addLogEntry({ type: 'quest', node: 'katana', text: 'Map the entire Digital Dominion', ts: Date.now()/1000 });
  addLogEntry({ type: 'quest', node: 'katana', text: 'Awaken all Guardian Towers', ts: Date.now()/1000 });
  addLogEntry({ type: 'quest', node: 'katana', text: 'Unite the Enchanted Quarters', ts: Date.now()/1000 });
  addLogEntry({ type: 'system', node: 'katana', text: 'The Realm Map has been inscribed.', ts: Date.now()/1000 });
}, 500);

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

function showSpeechBubble(nodeEl, evt, isAlert) {
  const bubble = document.createElement('div');
  bubble.className = 'speech-bubble' + (isAlert ? ' alert-bubble' : '');
  bubble._nodeEl = nodeEl; // track parent node
  const name = nodeEl.querySelector('.node-label')?.textContent || evt.node;

  // Close button — bubbles stay open until user dismisses them
  const closeBtn = document.createElement('button');
  closeBtn.className = 'bubble-close';
  closeBtn.innerHTML = '\u00D7';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bubble.style.animation = 'bubbleOut 0.3s ease-in forwards';
    setTimeout(() => { bubble.remove(); _activeBubbles.delete(bubble); }, 300);
  });

  bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${evt.text || ''}</div>`;
  bubble.appendChild(closeBtn);
  if (evt.color) bubble.style.borderColor = evt.color;

  // Append first (so offsetWidth/Height are available), then position above node
  const world = document.getElementById('map-world');
  world.appendChild(bubble);
  _positionBubble(bubble);
  _activeBubbles.add(bubble);
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
const POLL_MS = 3000;

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
  setTimeout(poll, POLL_MS);
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
    const isOffline = n.type === 'tailscale' && !n.online;
    dot.style.background = isOffline ? '#404040' : (MINIMAP_COLORS[n.type] || '#f0d890');
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
    if (!raw) return;
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
  } catch (e) { /* ignore corrupt layout */ }
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

// Restore saved layout on load
restoreLayout();

