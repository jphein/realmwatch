'use strict';
import { scaleLabel, fmtBytes, fmtRate, scalePct } from './utils.js';
import { tips, _topology, _nodeMap, infraNodes, _tsHostMap, getNodeDOM, updateLinePositions } from './topology.js';
import { renderTopoLayer, setLastTopoCollectd } from './terrain.js';
import { DOM, updateGauges, updateFirewallPanel, updateCensusSubLabels, updateLatencyPanel, updateNodeListStatus } from './panels.js';
import { updateConnectionTraffic } from './traffic.js';
import { scheduleSave } from './layout.js';
import { updateBubbleTotalScale } from './map-view.js';

// ── Status data ──
let lastStatus = null;
export const getLastStatus = () => lastStatus;
let _lastReportTs = 0;

// Post-update hook — app.js registers firePulse + debug refresh + addLogEntry here
let _postUpdateHook = null;
export function setPostUpdateHook(fn) { _postUpdateHook = fn; }

// ── Core sublabels (forge, gpu, mana, essence, katana, wan, gatekeeper, oracle) ──

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

// Pre-built lowercase → original key map for O(1) status lookups
let _statusKeyMap = null;
let _statusKeyMapSrc = null;  // identity ref to avoid rebuilding on same object

function _buildStatusKeyMap(nodeStatus) {
  if (_statusKeyMapSrc === nodeStatus) return _statusKeyMap;
  const m = new Map();
  for (const k of Object.keys(nodeStatus)) {
    const lo = k.toLowerCase();
    m.set(lo, k);
    m.set(lo.replace(/-/g, ''), k);  // also index dash-stripped variant
  }
  _statusKeyMap = m;
  _statusKeyMapSrc = nodeStatus;
  return m;
}

export function findStatusKey(nodeStatus, tipKey) {
  const m = _buildStatusKeyMap(nodeStatus);
  const lo = tipKey.toLowerCase();
  return m.get(lo) || m.get(lo.replace(/-/g, ''));
}

export function findCollectd(collectd, tipKey, statusKey) {
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
          extra.push([name, `↓${fmtRate(iface.rx_bps)} ↑${fmtRate(iface.tx_bps)}`]);
        }
      });
  }
  return extra;
}

// Mark tooltip stats dirty — rebuilt lazily on hover instead of every 10s
let _tipsDirty = true;

function updateInfraNodes(d) {
  const nodeStatus = d.astral.nodes || {};
  const sublabels = d.sublabels || {};
  let towersOnline = 0, towersTotal = 0;

  Object.entries(infraNodes).forEach(([tipKey, info]) => {
    const n = getNodeDOM(tipKey);
    const statusKey = findStatusKey(nodeStatus, tipKey);
    const online = statusKey ? nodeStatus[statusKey] : false;

    // Use server-precomputed sublabel when available (eliminates hostname matching)
    if (sublabels[tipKey]) {
      if (n.sub) n.sub.textContent = sublabels[tipKey];
    } else {
      if (n.sub) n.sub.textContent = online ? `Online \u2022 ${info.ip}` : `Offline \u2022 ${info.ip}`;
    }
    if (n.pulse) n.pulse.style.display = online ? '' : 'none';
    if (n.el) n.el.style.opacity = online ? '1' : '0.35';

    if (n.isTower) { towersTotal++; if (online) towersOnline++; }
  });

  _tipsDirty = true;  // Tooltip stats will be rebuilt on next hover
  DOM.towersOnline.textContent = towersOnline;
  DOM.towersTotal.textContent = towersTotal;
}

function _rebuildTipStats(tipKey) {
  if (!lastStatus || !tips[tipKey]) return;
  const d = lastStatus;
  const nodeStatus = d.astral?.nodes || {};
  const statusKey = findStatusKey(nodeStatus, tipKey);
  const online = statusKey ? nodeStatus[statusKey] : false;

  if (d.collectd) {
    const cd = findCollectd(d.collectd, tipKey, statusKey);
    if (cd) {
      const extra = buildCollectdExtra(cd);
      const base = tips[tipKey].stats.filter(s => ["Model", "IP", "OS", "Role", "Service", "Hostname"].includes(s[0]));
      // Use live node IP from topology (tip stats can have stale IPs from enrichment)
      const liveNode = _nodeMap.get(tipKey);
      if (liveNode?.ip) {
        const ipIdx = base.findIndex(s => s[0] === 'IP');
        if (ipIdx >= 0) base[ipIdx] = ['IP', liveNode.ip];
        else base.push(['IP', liveNode.ip]);
      }
      tips[tipKey].stats = [...base, ...extra, ['Status', online ? 'Online' : 'Offline']];
    }
  }
  // HA status
  const haInfo = d.ha?.[tipKey];
  if (haInfo?.sublabel) {
    const existing = tips[tipKey].stats.filter(s => s[0] !== 'HA Status');
    existing.push(['HA Status', haInfo.sublabel]);
    tips[tipKey].stats = existing;
  }
  if (!tips[tipKey].stats.some(s => s[0] === 'Status')) {
    tips[tipKey].stats.push(['Status', online ? 'Online' : 'Offline']);
  }
}

function updateHASublabels(d) {
  const ha = d.ha;
  const sublabels = d.sublabels || {};
  if (!ha) return;
  for (const [nodeId, info] of Object.entries(ha)) {
    // Only set sublabel if server didn't already provide one
    if (!sublabels[nodeId]) {
      const n = getNodeDOM(nodeId);
      if (n.sub) n.sub.textContent = info.sublabel;
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

// ── Main status update ──
export function updateUI(d) {
  lastStatus = d;
  updateGauges(d);
  updateCoreSublabels(d);
  updateInfraNodes(d);
  updateHASublabels(d);
  updateTooltips(d);

  // Codex stats
  if (d.collectd && DOM.codexCd) DOM.codexCd.textContent = Object.keys(d.collectd).length;
  if (DOM.codexNodes) DOM.codexNodes.textContent = _topology.nodes ? _topology.nodes.length : '?';

  // Traffic fallback — when SSE traffic events are active, this is skipped by the caller
  updateConnectionTraffic(d.collectd);
  setLastTopoCollectd(d.collectd);
  renderTopoLayer(d.collectd);

  updateNodeListStatus(d);
  updateCensusSubLabels(d);
  updateLatencyPanel();
  updateFirewallPanel(d);

  // Post-update hook (firePulse, debug refresh, periodic log — registered by app.js)
  if (_postUpdateHook) _postUpdateHook(d);
}

// ── Master scale slider (multiplies node, text, bubble) ──
let masterScale = 1.0;
const masterSlider = document.getElementById('master-scale-slider');
const masterScaleVal = document.getElementById('master-scale-val');

export function applyMasterScale() {
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

// ── Node scale slider ──
let nodeScale = 1.0;
const nodeScaleSlider = document.getElementById('node-scale-slider');
const nodeScaleVal = document.getElementById('node-scale-val');
let _nodeScaleRaf = false;
nodeScaleSlider.addEventListener('input', () => {
  nodeScale = parseFloat(nodeScaleSlider.value) * masterScale;
  nodeScaleVal.textContent = nodeScale.toFixed(1) + 'x';
  // Single CSS variable write instead of 87 per-element transforms
  document.documentElement.style.setProperty('--node-scale', nodeScale);
  if (!_nodeScaleRaf) {
    _nodeScaleRaf = true;
    requestAnimationFrame(() => {
      _nodeScaleRaf = false;
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
  // Single CSS variable write — labels, sublabels, vlan-labels all use var(--text-scale)
  document.documentElement.style.setProperty('--text-scale', textScale);
  // Region labels still need inline (per-element rotate + scale), but only ~9 elements
  if (!_textScaleRaf) {
    _textScaleRaf = true;
    requestAnimationFrame(() => {
      _textScaleRaf = false;
      document.querySelectorAll('.region-label').forEach(el => {
        el.style.transform = `rotate(${el.dataset.rotate || 0}deg) scale(${textScale})`;
      });
    });
  }
  scheduleSave();
});

// ── Bubble scale slider ──
export let bubbleScale = 1.0;
export let _bubbleFixedSize = true;  // Default on: bubbles don't scale with zoom
const bubbleScaleSlider = document.getElementById('bubble-scale-slider');
const bubbleScaleVal = document.getElementById('bubble-scale-val');
bubbleScaleSlider.addEventListener('input', () => {
  bubbleScale = parseFloat(bubbleScaleSlider.value) * masterScale;
  bubbleScaleVal.textContent = bubbleScale.toFixed(1) + 'x';
  document.documentElement.style.setProperty('--bubble-scale', bubbleScale);
  updateBubbleTotalScale();
  scheduleSave();
});

// ── Update speed slider ──
const updateSpeedSlider = document.getElementById('update-speed-slider');
const updateSpeedVal = document.getElementById('update-speed-val');

// ── Slider getters for settings save/restore ──
export function getSliderRefs() {
  return { masterSlider, masterScaleVal, nodeScaleSlider, nodeScaleVal,
           textScaleSlider, textScaleVal, bubbleScaleSlider, bubbleScaleVal,
           updateSpeedSlider, updateSpeedVal };
}
export function setMasterScale(v) { masterScale = v; }
export function getMasterScale() { return masterScale; }
export function setBubbleFixedSize(v) { _bubbleFixedSize = v; }
export function getBubbleFixedSize() { return _bubbleFixedSize; }
export function getBubbleScale() { return bubbleScale; }

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
  // Lazy rebuild: only compute stats for the hovered node (saves ~60 node rebuilds per tick)
  if (_tipsDirty && infraNodes[key]) _rebuildTipStats(key);
  let html = `<h3>${data.title}</h3>`;
  data.stats.forEach(([k, v]) => {
    html += `<div class="stat-line"><span>${k}</span><span class="stat-val">${v}</span></div>`;
  });
  tooltip.innerHTML = html;  // Trusted data from topology config — not user input
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

// Re-export for app.js consumers
export { updateCoreSublabels, updateHASublabels, updateTooltips, updateInfraNodes };
