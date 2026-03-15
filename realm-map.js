// Built from src/ modules — do not edit directly

(() => {
  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // src/config.js
  var WORLD_W = 4800;
  var WORLD_H = 3300;
  var WORLD_SCALE = WORLD_W / 3200;
  var _isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  var _cpuCores = navigator.hardwareConcurrency || 2;
  var _perfTier = _isMobile ? _cpuCores >= 6 ? "medium" : "low" : "high";
  function setPerfTier(t) {
    _perfTier = t;
  }
  __name(setPerfTier, "setPerfTier");
  var _mapTilt = 0;
  function setMapTilt(v) {
    _mapTilt = v;
  }
  __name(setMapTilt, "setMapTilt");
  var SSE_URL = "/sse";
  var _PERF = {
    get moteCap() {
      return _perfTier === "low" ? 80 : _perfTier === "medium" ? 180 : 400;
    },
    get topoFilters() {
      return _perfTier !== "low";
    },
    get topoHaloRes() {
      return _perfTier === "low" ? 2 : 1;
    },
    get sparkleDiv() {
      return _perfTier === "low" ? 4 : _perfTier === "medium" ? 2 : 1;
    },
    get moteGlow() {
      return _perfTier !== "low";
    },
    get moteStarCross() {
      return _perfTier === "high";
    },
    get dragLineThrottle() {
      return _perfTier === "low" ? 3 : 1;
    }
  };

  // src/topology.js
  var tips = {};
  var _topology = null;
  var infraNodes = {};
  var TYPE_TO_CLASS = { tower: "tower-node", cluster: "cluster-node", bridge: "bridge-node", infra: "infra-node", portal: "portal-node" };
  var isTS = /* @__PURE__ */ __name((n) => n.type === "tailscale" || n.tailscale, "isTS");
  var CONN_TYPE_TO_CLASS = { active: "conn-active", wan: "conn-wan", ap: "conn-ap", infra: "conn-infra", vlan: "conn-vlan", bridge: "conn-bridge", mesh: "conn-mesh", offline: "conn-offline", portal: "conn-portal" };
  var _tsHostMap = {};
  var _vlanLabels = [];
  var _connPaths = [];
  var _onTopologyRefresh = null;
  function setTopologyRefreshHook(fn) {
    _onTopologyRefresh = fn;
  }
  __name(setTopologyRefreshHook, "setTopologyRefreshHook");
  var _nodeDOM = {};
  function getNodeDOM(tipKey) {
    if (_nodeDOM[tipKey]) return _nodeDOM[tipKey];
    const el = document.querySelector(`[data-tip="${tipKey}"]`);
    if (!el) return _nodeDOM[tipKey] = { el: null, sub: null, bar: null, pulse: null };
    _nodeDOM[tipKey] = {
      el,
      sub: el.querySelector(".node-sublabel"),
      bar: el.querySelector(".scale-fill"),
      pulse: el.querySelector(".pulse-ring"),
      isTower: el.classList.contains("tower-node")
    };
    return _nodeDOM[tipKey];
  }
  __name(getNodeDOM, "getNodeDOM");
  function _getNodePos(nodeId) {
    const n = getNodeDOM(nodeId);
    if (n.el) return getNodeCenter(n.el);
    const tn = _topology?.nodes.find((nd) => nd.id === nodeId);
    if (tn) {
      const is = tn.iconStyle || {};
      return { x: tn.x + (parseInt(is.width) || 64) / 2, y: tn.y + (parseInt(is.height) || 64) / 2 };
    }
    return null;
  }
  __name(_getNodePos, "_getNodePos");
  function _computeFanAngles() {
    if (!_topology) return [];
    const nodeConns = {};
    _topology.connections.forEach((c, i) => {
      var _a, _b;
      const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
      if (!fp || !tp) return;
      (nodeConns[_a = c.from] || (nodeConns[_a] = [])).push({ angle: Math.atan2(tp.y - fp.y, tp.x - fp.x), connIdx: i, isFrom: true });
      (nodeConns[_b = c.to] || (nodeConns[_b] = [])).push({ angle: Math.atan2(fp.y - tp.y, fp.x - tp.x), connIdx: i, isFrom: false });
    });
    const result = _topology.connections.map(() => ({ fromAngle: 0, toAngle: 0 }));
    const MIN_GAP = 0.1;
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
  __name(_computeFanAngles, "_computeFanAngles");
  var _obstacles = [];
  var _nodeSizeCache = /* @__PURE__ */ new Map();
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
      const icon = el._icon || (el._icon = el.el.querySelector(".node-icon"));
      let iconScale = 1;
      if (icon && icon.style.transform) {
        const m = icon.style.transform.match(/scale\(([^)]+)\)/);
        if (m) iconScale = parseFloat(m[1]) || 1;
      }
      const cx = left + sz.w / 2;
      const cy = top + sz.h / 2;
      const rx = sz.w / 2 * Math.max(1, iconScale) + 20;
      const ry = sz.h / 2 * Math.max(1, iconScale) + 15;
      _obstacles.push({ id: n.id, x: cx, y: cy, rx, ry });
    }
  }
  __name(_buildObstacles, "_buildObstacles");
  function _hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
    return h;
  }
  __name(_hashStr, "_hashStr");
  function _computePathD(fp, tp, fromAngle, toAngle, fromId, toId) {
    const dist = Math.hypot(tp.x - fp.x, tp.y - fp.y);
    if (dist < 1) return `M${fp.x},${fp.y}L${tp.x},${tp.y}`;
    const dx = tp.x - fp.x, dy = tp.y - fp.y;
    const px = -dy / dist, py = dx / dist;
    const numSegs = Math.max(3, Math.min(6, Math.round(dist / 120)));
    const seed = _hashStr(fromId + "-" + toId);
    const phase = (seed & 65535) / 65535 * Math.PI * 2;
    const waypoints = [{ x: fp.x, y: fp.y }];
    for (let i = 1; i < numSegs; i++) {
      const t = i / numSegs;
      const bx = fp.x + dx * t, by = fp.y + dy * t;
      const meander = (Math.sin(phase + t * Math.PI * 2) * 0.07 + Math.sin(phase * 1.7 + t * Math.PI * 3.5) * 0.03) * dist;
      waypoints.push({ x: bx + px * meander, y: by + py * meander });
    }
    waypoints.push({ x: tp.x, y: tp.y });
    const obs = _obstacles.filter((o) => o.id !== fromId && o.id !== toId);
    for (let iter = 0; iter < 4; iter++) {
      for (let i = 1; i < waypoints.length - 1; i++) {
        const wp = waypoints[i];
        for (const o of obs) {
          const ndx = (wp.x - o.x) / o.rx, ndy = (wp.y - o.y) / o.ry;
          const ed = Math.hypot(ndx, ndy);
          if (ed < 1 && ed > 0) {
            const push = (1 - ed) * 0.7;
            const d2 = Math.hypot(wp.x - o.x, wp.y - o.y);
            wp.x += (wp.x - o.x) / d2 * push * o.rx;
            wp.y += (wp.y - o.y) / d2 * push * o.ry;
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
  __name(_computePathD, "_computePathD");
  function getNodeCenter(nodeEl) {
    const left = parseInt(nodeEl.style.left) || 0;
    const top = parseInt(nodeEl.style.top) || 0;
    const icon = nodeEl.querySelector(".node-icon");
    if (icon) {
      return {
        x: left + icon.offsetLeft + icon.offsetWidth / 2,
        y: top + icon.offsetTop + icon.offsetHeight / 2
      };
    }
    return { x: left + 32, y: top + 32 };
  }
  __name(getNodeCenter, "getNodeCenter");
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
      path.setAttribute("d", d);
      if (path._bridgeInner) path._bridgeInner.setAttribute("d", d);
    });
    _vlanLabels.forEach(({ label, connIdx }) => {
      const path = _connPaths[connIdx];
      if (!path) return;
      try {
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        label.style.left = mid.x + "px";
        label.style.top = mid.y - 4 + "px";
      } catch (e) {
      }
    });
  }
  __name(updateLinePositions, "updateLinePositions");
  function renderTopology(topo) {
    _topology = topo;
    topo.nodes.forEach((n) => {
      n.x = Math.round(n.x * WORLD_SCALE);
      n.y = Math.round(n.y * WORLD_SCALE);
    });
    (topo.regions || []).forEach((r) => {
      r.x = Math.round(r.x * WORLD_SCALE);
      r.y = Math.round(r.y * WORLD_SCALE);
    });
    const world2 = document.getElementById("map-world");
    const connSvg = document.querySelector("#connections");
    const nodeMap = {};
    topo.nodes.forEach((n) => {
      nodeMap[n.id] = n;
    });
    topo.nodes.forEach((n) => {
      const div = document.createElement("div");
      const tc = TYPE_TO_CLASS[n.type] || "";
      div.className = "realm-node" + (tc ? " " + tc : "") + (n.collectd ? " collectd-monitored" : "");
      let ns = `left:${n.x}px;top:${n.y}px;`;
      if (isTS(n) && !n.online) ns += "opacity:0.4;";
      div.setAttribute("style", ns);
      div.dataset.tip = n.id;
      const icon = document.createElement("div");
      icon.className = "node-icon";
      const is = n.iconStyle || {};
      if (isTS(n) && !n.online) {
        icon.setAttribute("style", "background:#111;width:44px;height:44px;font-size:18px;border-color:rgba(100,100,100,0.3);box-shadow:none");
      } else {
        let ic = "";
        for (const [k, v] of Object.entries(is)) ic += `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v};`;
        icon.setAttribute("style", ic);
      }
      if (n.pulse && !(isTS(n) && !n.online)) {
        const p = document.createElement("div");
        p.className = "pulse-ring";
        if (n.pulseStyle?.borderColor) p.style.borderColor = n.pulseStyle.borderColor;
        if (isTS(n) && is.width) {
          const sz = parseInt(is.width);
          p.style.cssText = `width:${sz}px;height:${sz}px;margin:-${sz / 2}px 0 0 -${sz / 2}px`;
        }
        icon.appendChild(p);
      }
      if (n.badge) {
        const b = document.createElement("span");
        b.className = "cluster-badge";
        b.textContent = n.badge;
        icon.appendChild(b);
      }
      icon.insertAdjacentHTML("beforeend", n.icon);
      div.appendChild(icon);
      const lbl = document.createElement("div");
      lbl.className = "node-label";
      if (isTS(n) && !n.online) lbl.setAttribute("style", "color:#606060;font-size:11px");
      else if (n.labelStyle) {
        let ls = "";
        for (const [k, v] of Object.entries(n.labelStyle)) ls += `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v};`;
        lbl.setAttribute("style", ls);
      }
      lbl.textContent = n.label;
      div.appendChild(lbl);
      const sub = document.createElement("div");
      sub.className = "node-sublabel";
      if (isTS(n) && !n.online) sub.setAttribute("style", "color:#404040");
      sub.innerHTML = n.sublabel;
      div.appendChild(sub);
      if (n.scaleBar) {
        const bar = document.createElement("div");
        bar.className = "scale-bar";
        const fill = document.createElement("div");
        fill.className = "scale-fill";
        let fs = `width:${n.scaleBar.width};`;
        if (n.scaleBar.gradient) fs += `background:${n.scaleBar.gradient};`;
        else if (n.scaleBar.color) fs += `background:${n.scaleBar.color};`;
        fill.setAttribute("style", fs);
        bar.appendChild(fill);
        div.appendChild(bar);
      }
      world2.appendChild(div);
      if (n.tip) tips[n.id] = { title: n.tip.title, stats: [...n.tip.stats || []] };
      else {
        const auto = [];
        if (n._hostname) auto.push(["Hostname", n._hostname]);
        if (n.type) auto.push(["Type", n.type]);
        if (n.ip) auto.push(["IP", n.ip]);
        if (n._vendor) auto.push(["Vendor", n._vendor]);
        tips[n.id] = { title: n.label || n.id, stats: auto };
      }
      if (n.ip || n.ssh) infraNodes[n.id] = { name: n.label, ip: n.ip || "", collectdHost: n.collectd || null, sshHost: n.ssh || null, tsHost: n.tsHost || null };
      if (n.tsHost) _tsHostMap[n.tsHost] = n.id;
    });
    const _vlanCounts = {};
    topo.connections.forEach((c) => {
      if (!c.vlan) return;
      [c.from, c.to].forEach((id) => {
        if (!_vlanCounts[id]) _vlanCounts[id] = {};
        _vlanCounts[id][c.vlan] = (_vlanCounts[id][c.vlan] || 0) + 1;
      });
    });
    const _nodeVlans2 = {};
    topo.nodes.forEach((n) => {
      if (_vlanCounts[n.id]) {
        let best = 6, max = 0;
        for (const [v, cnt] of Object.entries(_vlanCounts[n.id])) {
          if (cnt > max) {
            max = cnt;
            best = +v;
          }
        }
        _nodeVlans2[n.id] = best;
      } else {
        _nodeVlans2[n.id] = n.tailscale || n.type === "tailscale" ? 0 : 6;
      }
    });
    _buildObstacles();
    const fanAngles = _computeFanAngles();
    topo.connections.forEach((c, i) => {
      const fn = nodeMap[c.from], tn = nodeMap[c.to];
      if (!fn || !tn) return;
      const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
      if (!fp || !tp) {
        _connPaths.push(null);
        return;
      }
      const fa = fanAngles[i] || { fromAngle: 0, toAngle: 0 };
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", _computePathD(fp, tp, fa.fromAngle, fa.toAngle, c.from, c.to));
      path.setAttribute("class", "conn-line " + (CONN_TYPE_TO_CLASS[c.type] || "conn-active"));
      const connVlan = c.vlan || _nodeVlans2[c.from] || _nodeVlans2[c.to] || 6;
      path.dataset.vlan = connVlan;
      if (c.collectd) path.dataset.to = c.collectd;
      else path.dataset.to = c.to;
      path.dataset.from = c.from;
      path.dataset.fromNode = c.from;
      path.dataset.toNode = c.to;
      connSvg.appendChild(path);
      if (c.type === "bridge") {
        const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
        inner.setAttribute("d", path.getAttribute("d"));
        inner.setAttribute("class", "conn-bridge-inner");
        connSvg.appendChild(inner);
        path._bridgeInner = inner;
      }
      _connPaths.push(path);
      if (c.vlan) {
        const mid = path.getPointAtLength(path.getTotalLength() / 2);
        const label = document.createElement("div");
        label.className = "vlan-label";
        label.textContent = "VLAN " + c.vlan;
        label.style.left = mid.x + "px";
        label.style.top = mid.y - 4 + "px";
        world2.appendChild(label);
        _vlanLabels.push({ label, connIdx: i });
      }
    });
  }
  __name(renderTopology, "renderTopology");
  function loadTopology() {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/topology", false);
    xhr.send();
    if (xhr.status === 200) {
      const topo = JSON.parse(xhr.responseText);
      renderTopology(topo);
    }
  }
  __name(loadTopology, "loadTopology");
  var _lastNodeCount = 0;
  async function refreshTopology() {
    try {
      const r = await fetch("/topology");
      if (!r.ok) return;
      const topo = await r.json();
      const nc = (topo.nodes || []).length;
      const cc = (topo.connections || []).length;
      if (nc === _lastNodeCount && cc === (_topology?.connections || []).length) return;
      _lastNodeCount = nc;
      const savedPos = {};
      if (_topology) {
        _topology.nodes.forEach((n) => {
          savedPos[n.id] = { x: n.x, y: n.y };
        });
      }
      const vp = document.getElementById("map-viewport");
      const sx = vp?.scrollLeft, sy = vp?.scrollTop;
      const world2 = document.getElementById("map-world");
      world2.querySelectorAll(".realm-node, .region-label, .vlan-label").forEach((el) => el.remove());
      const svg = document.querySelector("#connections");
      svg.innerHTML = "";
      _connPaths.length = 0;
      _vlanLabels.length = 0;
      Object.keys(_nodeDOM).forEach((k) => delete _nodeDOM[k]);
      _nodeSizeCache.clear();
      renderTopology(topo);
      if (Object.keys(savedPos).length > 0) {
        let restored = false;
        _topology.nodes.forEach((n) => {
          if (savedPos[n.id]) {
            n.x = savedPos[n.id].x;
            n.y = savedPos[n.id].y;
            const el = document.querySelector(`[data-tip="${n.id}"]`);
            if (el) {
              el.style.left = n.x + "px";
              el.style.top = n.y + "px";
            }
            restored = true;
          }
        });
        if (restored) updateLinePositions();
      }
      if (vp && sx != null) {
        vp.scrollLeft = sx;
        vp.scrollTop = sy;
      }
      if (_onTopologyRefresh) _onTopologyRefresh();
    } catch (e) {
    }
  }
  __name(refreshTopology, "refreshTopology");
  function _renderNode(n) {
    const world2 = document.getElementById("map-world");
    const div = document.createElement("div");
    const tc = TYPE_TO_CLASS[n.type] || "";
    div.className = "realm-node" + (tc ? " " + tc : "") + (n.collectd ? " collectd-monitored" : "");
    if (n._clusterChild) div.classList.add("cluster-child");
    div.setAttribute("style", `left:${n.x}px;top:${n.y}px;`);
    div.dataset.tip = n.id;
    const icon = document.createElement("div");
    icon.className = "node-icon";
    const is = n.iconStyle || {};
    let ic = "";
    for (const [k, v] of Object.entries(is)) ic += `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v};`;
    icon.setAttribute("style", ic);
    if (n.pulse) {
      const p = document.createElement("div");
      p.className = "pulse-ring";
      if (n.pulseStyle?.borderColor) p.style.borderColor = n.pulseStyle.borderColor;
      icon.appendChild(p);
    }
    if (n.badge) {
      const b = document.createElement("span");
      b.className = "cluster-badge";
      b.textContent = n.badge;
      icon.appendChild(b);
    }
    icon.insertAdjacentHTML("beforeend", n.icon || "&#9670;");
    div.appendChild(icon);
    const lbl = document.createElement("div");
    lbl.className = "node-label";
    if (n.labelStyle) {
      let ls = "";
      for (const [k, v] of Object.entries(n.labelStyle)) ls += `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v};`;
      lbl.setAttribute("style", ls);
    }
    lbl.textContent = n.label;
    div.appendChild(lbl);
    const sub = document.createElement("div");
    sub.className = "node-sublabel";
    sub.textContent = n.sublabel || "";
    div.appendChild(sub);
    world2.appendChild(div);
    if (n.tip) tips[n.id] = { title: n.tip.title, stats: [...n.tip.stats || []] };
    else {
      const auto = [];
      if (n.type) auto.push(["Type", n.type]);
      if (n.ip) auto.push(["IP", n.ip]);
      tips[n.id] = { title: n.label || n.id, stats: auto };
    }
    if (n.ip) infraNodes[n.id] = { name: n.label, ip: n.ip, collectdHost: n.collectd || null, sshHost: null, tsHost: null };
    delete _nodeDOM[n.id];
    return div;
  }
  __name(_renderNode, "_renderNode");
  function _renderConn(conn) {
    const connSvg = document.querySelector("#connections");
    const fp = _getNodePos(conn.from), tp = _getNodePos(conn.to);
    if (!fp || !tp) return null;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", _computePathD(fp, tp, 0, 0, conn.from, conn.to));
    path.setAttribute("class", "conn-line " + (CONN_TYPE_TO_CLASS[conn.type] || "conn-active"));
    if (conn._clusterChild) path.classList.add("conn-cluster-child");
    path.dataset.from = conn.from;
    path.dataset.to = conn.to;
    path.dataset.fromNode = conn.from;
    path.dataset.toNode = conn.to;
    connSvg.appendChild(path);
    _connPaths.push(path);
    return path;
  }
  __name(_renderConn, "_renderConn");
  var _expandedClusters = /* @__PURE__ */ new Set();
  var _clusterChildIds = {};
  function isClusterExpandable(nodeId) {
    const n = _topology?.nodes.find((nd) => nd.id === nodeId);
    return n?.type === "cluster" && n.members?.length > 0;
  }
  __name(isClusterExpandable, "isClusterExpandable");
  function isClusterExpanded(nodeId) {
    return _expandedClusters.has(nodeId);
  }
  __name(isClusterExpanded, "isClusterExpanded");
  function toggleClusterExpand(clusterId) {
    if (_expandedClusters.has(clusterId)) collapseCluster(clusterId);
    else expandCluster(clusterId);
  }
  __name(toggleClusterExpand, "toggleClusterExpand");
  function expandCluster(clusterId) {
    const cluster = _topology?.nodes.find((n) => n.id === clusterId);
    if (!cluster?.members?.length) return;
    const center = _getNodePos(clusterId);
    if (!center) return;
    const members = cluster.members;
    const childIds = [];
    const apGroups = {};
    const noAp = [];
    members.forEach((m) => {
      var _a;
      if (m.ap && _topology.nodes.find((n) => n.id === m.ap)) {
        (apGroups[_a = m.ap] || (apGroups[_a] = [])).push(m);
      } else {
        noAp.push(m);
      }
    });
    const allPlacements = [];
    for (const [apId, group] of Object.entries(apGroups)) {
      const apPos = _getNodePos(apId);
      if (!apPos) {
        noAp.push(...group);
        continue;
      }
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
          apId
        });
      });
    }
    const orbitRadius = Math.max(80, noAp.length * 22);
    noAp.forEach((m, i) => {
      const angle = i / Math.max(noAp.length, 1) * Math.PI * 2 - Math.PI / 2;
      allPlacements.push({
        member: m,
        tx: Math.round(center.x + Math.cos(angle) * orbitRadius),
        ty: Math.round(center.y + Math.sin(angle) * orbitRadius),
        apId: null
      });
    });
    let idx = 0;
    allPlacements.forEach(({ member: m, tx, ty, apId }) => {
      const nodeId = `${clusterId}::${m.mac || idx}`;
      idx++;
      const nodeData = {
        id: nodeId,
        type: "device",
        _clusterChild: true,
        _parentCluster: clusterId,
        x: center.x,
        y: center.y,
        _targetX: tx,
        _targetY: ty,
        icon: "&#9670;",
        label: m.label,
        sublabel: (m.hw ? m.hw : "") + (m.hw && m.ip ? " \u2022 " : "") + (m.ip || ""),
        ip: m.ip || "",
        iconStyle: {
          width: "30px",
          height: "30px",
          fontSize: "13px",
          background: "radial-gradient(circle, #1a1520, #0f0d12)",
          borderColor: "rgba(96,192,96,0.35)",
          boxShadow: "0 0 10px rgba(96,192,96,0.2)"
        },
        tip: {
          title: m.label,
          stats: [
            ["Hostname", m.hw || "Unknown"],
            ["IP", m.ip || "N/A"],
            ["MAC", m.mac || "N/A"],
            ["AP", apId || "Unknown"]
          ]
        }
      };
      _topology.nodes.push(nodeData);
      _renderNode(nodeData);
      const connTarget = apId || clusterId;
      const conn = { from: nodeId, to: connTarget, type: "active", _clusterChild: true };
      _topology.connections.push(conn);
      _renderConn(conn);
      childIds.push(nodeId);
    });
    _clusterChildIds[clusterId] = childIds;
    _expandedClusters.add(clusterId);
    const clusterEl = document.querySelector(`[data-tip="${clusterId}"]`);
    if (clusterEl) clusterEl.classList.add("cluster-expanded");
    requestAnimationFrame(() => {
      childIds.forEach((nid) => {
        const nd = _topology.nodes.find((n) => n.id === nid);
        if (!nd) return;
        const el = document.querySelector(`[data-tip="${nid}"]`);
        if (!el) return;
        el.style.transition = "left 0.45s cubic-bezier(0.34,1.56,0.64,1), top 0.45s cubic-bezier(0.34,1.56,0.64,1)";
        nd.x = nd._targetX;
        nd.y = nd._targetY;
        el.style.left = nd.x + "px";
        el.style.top = nd.y + "px";
      });
      setTimeout(() => {
        _buildObstacles();
        updateLinePositions();
      }, 470);
    });
  }
  __name(expandCluster, "expandCluster");
  function collapseCluster(clusterId) {
    const childIds = _clusterChildIds[clusterId];
    if (!childIds) return;
    const center = _getNodePos(clusterId);
    childIds.forEach((nid) => {
      const el = document.querySelector(`[data-tip="${nid}"]`);
      if (!el) return;
      el.style.transition = "left 0.25s ease-in, top 0.25s ease-in, opacity 0.2s ease";
      if (center) {
        el.style.left = center.x + "px";
        el.style.top = center.y + "px";
      }
      el.style.opacity = "0";
    });
    setTimeout(() => {
      const removeSet = new Set(childIds);
      _topology.nodes = _topology.nodes.filter((n) => !removeSet.has(n.id));
      _topology.connections = _topology.connections.filter((c) => !removeSet.has(c.from) && !removeSet.has(c.to));
      childIds.forEach((nid) => {
        const el = document.querySelector(`[data-tip="${nid}"]`);
        if (el) el.remove();
        delete tips[nid];
        delete _nodeDOM[nid];
        delete infraNodes[nid];
      });
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
    if (clusterEl) clusterEl.classList.remove("cluster-expanded");
  }
  __name(collapseCluster, "collapseCluster");
  loadTopology();
  _lastNodeCount = (_topology?.nodes || []).length;

  // src/utils.js
  function scaleLabel(s) {
    if (s <= -7) return "Deep Depletion";
    if (s <= -3) return "Depleted";
    if (s <= 3) return "Balanced";
    if (s <= 7) return "Replete";
    return "Full Plenitude";
  }
  __name(scaleLabel, "scaleLabel");
  function scaleColor(s) {
    if (s <= -7) return "#ff4040";
    if (s <= -3) return "#f09040";
    if (s <= 3) return "#f0d040";
    if (s <= 7) return "#a0d060";
    return "#a0ff60";
  }
  __name(scaleColor, "scaleColor");
  function fmtBytes(b) {
    if (b == null) return "N/A";
    if (b > 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b > 1024) return (b / 1024).toFixed(0) + " KB";
    return b + " B";
  }
  __name(fmtBytes, "fmtBytes");
  function fmtRate(bps) {
    if (bps == null || bps === 0) return "0";
    if (bps > 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
    if (bps > 1024) return (bps / 1024).toFixed(0) + " KB/s";
    return bps + " B/s";
  }
  __name(fmtRate, "fmtRate");
  function scalePct(s) {
    return Math.max(0, Math.min(100, (s + 10) / 20 * 100));
  }
  __name(scalePct, "scalePct");

  // src/panel-manager.js
  var ANCHORS = [
    { id: "nw", x: 0, y: 0, label: "Northwest Anchor" },
    { id: "n", x: 0.5, y: 0, label: "North Anchor" },
    { id: "ne", x: 1, y: 0, label: "Northeast Anchor" },
    { id: "e", x: 1, y: 0.5, label: "East Anchor" },
    { id: "se", x: 1, y: 1, label: "Southeast Anchor" },
    { id: "s", x: 0.5, y: 1, label: "South Anchor" },
    { id: "sw", x: 0, y: 1, label: "Southwest Anchor" },
    { id: "w", x: 0, y: 0.5, label: "West Anchor" }
  ];
  var PANELS = {
    "realm-panel": { name: "Realm Vitals", anchor: "ne", priority: 1, icon: "\u2694" },
    "legend": { name: "Legend", anchor: "sw", priority: 5, icon: "\u{1F5FA}" },
    "spellbook": { name: "Spellbook", anchor: "sw", priority: 3, icon: "\u{1F4D6}" },
    "realm-codex": { name: "Codex", anchor: "nw", priority: 4, icon: "\u2630" },
    "quest-log": { name: "Quest Log", anchor: "se", priority: 6, icon: "\u2619" },
    "cartographer": { name: "Cartographer", anchor: "e", priority: 7, icon: "\u{1F9ED}" },
    "energy-panel": { name: "Energy", anchor: "w", priority: 8, icon: "\u26A1" },
    "node-list": { name: "Census", anchor: "w", priority: 9, icon: "\u{1F4DC}" },
    "debug-panel": { name: "Arcane Mirror", anchor: "s", priority: 10, icon: "\u{1F52E}" },
    "latency-panel": { name: "Arcane Pulse", anchor: "e", priority: 11, icon: "\u{1F3D3}" },
    "firewall-panel": { name: "Realm Wards", anchor: "w", priority: 12, icon: "\u{1F6E1}" },
    "wifi-panel": { name: "Aether Towers", anchor: "w", priority: 13, icon: "\u{1F4E1}" },
    "node-chat-dialog": { name: "Oracle Commune", anchor: "se", priority: 14, icon: "\u{1F4AC}" }
  };
  var FORMATIONS = {
    "scrying-focus": {
      name: "Scrying Focus",
      icon: "\u{1F441}",
      desc: "Clear sight upon the realm",
      visible: [],
      anchors: {}
    },
    "wardens-watch": {
      name: "Warden's Watch",
      icon: "\u{1F6E1}",
      desc: "Monitor the realm vitals",
      visible: ["realm-panel", "energy-panel"],
      anchors: { "realm-panel": "ne", "energy-panel": "nw" }
    },
    "grand-arcanum": {
      name: "Grand Arcanum",
      icon: "\u2728",
      desc: "Summon all panels",
      visible: Object.keys(PANELS),
      anchors: null
      // auto-arrange
    },
    "grimoire-binding": {
      name: "Grimoire Binding",
      icon: "\u{1F4D5}",
      desc: "Your saved formation",
      visible: null,
      // loaded from storage
      anchors: null
    }
  };
  var STORAGE_KEY = "realm-panel-formation";
  var SEAL_MODES = {
    dock: { name: "Docked", icon: "\u2693", desc: "Sealed runes gather in the dock" },
    anchored: { name: "Anchored", icon: "\u{1F4CD}", desc: "Runes stay where panels were" },
    wander: { name: "Wander", icon: "\u2728", desc: "Runes float freely about" },
    conjure: { name: "Conjure", icon: "\u{1F52E}", desc: "Runes arrange themselves" }
  };
  var _mode = "auto";
  var _sealMode = "dock";
  var _autoSnap = true;
  var _showAnchors = true;
  var _currentFormation = null;
  var _dragging = null;
  var _dragOffset = { x: 0, y: 0 };
  var _anchorOverlay = null;
  var _particleCanvas = null;
  var _sealedDock = null;
  var _wanderingRunes = [];
  var _conjureAngle = 0;
  var _conjureRaf = 0;
  function initPanelManager() {
    _createAnchorOverlay();
    _createParticleCanvas();
    _createSealedDock();
    _attachDragHandlers();
    _loadFormation();
    _injectFormationUI();
  }
  __name(initPanelManager, "initPanelManager");
  function _createSealedDock() {
    _sealedDock = document.createElement("div");
    _sealedDock.id = "sealed-dock";
    _sealedDock.className = "sealed-dock";
    const handle = document.createElement("div");
    handle.className = "dock-handle";
    const grip = document.createElement("div");
    grip.className = "dock-grip";
    handle.appendChild(grip);
    _sealedDock.appendChild(handle);
    const tray = document.createElement("div");
    tray.className = "dock-tray";
    _sealedDock.appendChild(tray);
    document.body.appendChild(_sealedDock);
    _attachDockDragHandlers(tray);
    _attachDrawerGesture(_sealedDock, handle);
  }
  __name(_createSealedDock, "_createSealedDock");
  function _updateDockBadge() {
    const tray = _sealedDock?.querySelector(".dock-tray");
    if (!tray) return;
    requestAnimationFrame(() => {
      const overflows = tray.scrollHeight > tray.clientHeight + 5;
      _sealedDock.classList.toggle("has-overflow", overflows);
      if (!overflows) _sealedDock.classList.remove("dock-expanded");
    });
  }
  __name(_updateDockBadge, "_updateDockBadge");
  function _attachDrawerGesture(dock, handle) {
    let _touch = null;
    const expand = /* @__PURE__ */ __name(() => {
      dock.classList.add("dock-expanded");
    }, "expand");
    const collapse = /* @__PURE__ */ __name(() => {
      dock.classList.remove("dock-expanded");
    }, "collapse");
    const isExpanded = /* @__PURE__ */ __name(() => dock.classList.contains("dock-expanded"), "isExpanded");
    handle.addEventListener("click", () => {
      if (isExpanded()) collapse();
      else expand();
    });
    dock.addEventListener("touchstart", (e) => {
      if (e.target.closest(".sealed-rune")) return;
      const t = e.touches[0];
      _touch = { startY: t.clientY, expanded: isExpanded() };
    }, { passive: true });
    dock.addEventListener("touchmove", (e) => {
      if (!_touch || _dockDrag) return;
      const dy = _touch.startY - e.touches[0].clientY;
      if (Math.abs(dy) > 20) {
        if (dy > 0 && !_touch.expanded) expand();
        else if (dy < 0 && _touch.expanded) collapse();
        _touch = null;
      }
    }, { passive: true });
    dock.addEventListener("touchend", () => {
      _touch = null;
    }, { passive: true });
  }
  __name(_attachDrawerGesture, "_attachDrawerGesture");
  var _dockDrag = null;
  function _attachDockDragHandlers(tray) {
    let _pending = null;
    tray.addEventListener("pointerdown", (e) => {
      const rune = e.target.closest(".sealed-rune");
      if (!rune || !tray.contains(rune)) return;
      const rect = rune.getBoundingClientRect();
      _pending = {
        rune,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top
      };
    });
    tray.addEventListener("pointermove", (e) => {
      if (_pending && !_dockDrag && e.pointerId === _pending.pointerId) {
        const dx = Math.abs(e.clientX - _pending.startX);
        const dy = Math.abs(e.clientY - _pending.startY);
        if (dx < 10 && dy < 10) return;
        const p = _pending;
        _pending = null;
        p.rune.setPointerCapture(e.pointerId);
        const rect = p.rune.getBoundingClientRect();
        const ghost = p.rune.cloneNode(true);
        ghost.className = "sealed-rune dock-drag-ghost active";
        ghost.style.cssText = `
        position: fixed; z-index: 10001; pointer-events: none;
        left: ${rect.left}px; top: ${rect.top}px;
        width: ${rect.width}px; height: ${rect.height}px;
        transition: none;
      `;
        document.body.appendChild(ghost);
        const placeholder = document.createElement("div");
        placeholder.className = "dock-drag-placeholder";
        tray.insertBefore(placeholder, p.rune);
        p.rune.style.visibility = "hidden";
        _dockDrag = {
          rune: p.rune,
          ghost,
          placeholder,
          tray,
          pointerId: e.pointerId,
          offsetX: p.offsetX,
          offsetY: p.offsetY
        };
      }
      if (!_dockDrag || e.pointerId !== _dockDrag.pointerId) return;
      e.preventDefault();
      const d = _dockDrag;
      d.ghost.style.left = e.clientX - d.offsetX + "px";
      d.ghost.style.top = e.clientY - d.offsetY + "px";
      const siblings = [...d.tray.querySelectorAll('.sealed-rune:not([style*="visibility: hidden"])')];
      let insertBefore = null;
      for (const sib of siblings) {
        const sr = sib.getBoundingClientRect();
        if (!sr.width) continue;
        if (e.clientY < sr.top) {
          insertBefore = sib;
          break;
        }
        if (e.clientY < sr.bottom && e.clientX < sr.left + sr.width / 2) {
          insertBefore = sib;
          break;
        }
      }
      if (insertBefore) {
        d.tray.insertBefore(d.placeholder, insertBefore);
      } else {
        d.tray.appendChild(d.placeholder);
      }
      d.placeholder.after(d.rune);
      _spawnDockParticle(e.clientX, e.clientY);
    });
    const endDockDrag = /* @__PURE__ */ __name((e) => {
      if (_pending && e.pointerId === _pending.pointerId) {
        _pending = null;
        return;
      }
      if (!_dockDrag || e.pointerId !== _dockDrag.pointerId) return;
      const d = _dockDrag;
      _dockDrag = null;
      const targetRect = d.placeholder.getBoundingClientRect();
      d.ghost.style.transition = "all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)";
      d.ghost.style.left = targetRect.left + "px";
      d.ghost.style.top = targetRect.top + "px";
      setTimeout(() => {
        d.placeholder.replaceWith(d.rune);
        d.rune.style.visibility = "";
        d.ghost.remove();
        d.tray.classList.remove("reordering");
        _spawnDockBurst(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2);
        _saveFormation();
      }, 300);
    }, "endDockDrag");
    tray.addEventListener("pointerup", endDockDrag);
    tray.addEventListener("pointercancel", endDockDrag);
  }
  __name(_attachDockDragHandlers, "_attachDockDragHandlers");
  function _spawnDockParticle(x, y) {
    const p = document.createElement("div");
    p.className = "dock-particle";
    p.style.left = x + "px";
    p.style.top = y + "px";
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 600);
  }
  __name(_spawnDockParticle, "_spawnDockParticle");
  function _spawnDockBurst(cx, cy) {
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      const p = document.createElement("div");
      p.className = "dock-particle burst";
      p.style.left = cx + "px";
      p.style.top = cy + "px";
      p.style.setProperty("--dx", Math.cos(angle) * 30 + "px");
      p.style.setProperty("--dy", Math.sin(angle) * 30 + "px");
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 500);
    }
  }
  __name(_spawnDockBurst, "_spawnDockBurst");
  function _createAnchorOverlay() {
    _anchorOverlay = document.createElement("div");
    _anchorOverlay.id = "ley-anchor-overlay";
    ANCHORS.forEach((a) => {
      const anchor = document.createElement("div");
      anchor.className = "ley-anchor";
      anchor.dataset.anchor = a.id;
      anchor.style.left = a.x * 100 + "%";
      anchor.style.top = a.y * 100 + "%";
      const rune = document.createElement("span");
      rune.className = "anchor-rune";
      rune.textContent = "\u25C8";
      const glow = document.createElement("span");
      glow.className = "anchor-glow";
      anchor.appendChild(rune);
      anchor.appendChild(glow);
      _anchorOverlay.appendChild(anchor);
    });
    document.body.appendChild(_anchorOverlay);
  }
  __name(_createAnchorOverlay, "_createAnchorOverlay");
  function _createParticleCanvas() {
    _particleCanvas = document.createElement("canvas");
    _particleCanvas.id = "arcane-particles";
    _particleCanvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9998;";
    document.body.appendChild(_particleCanvas);
    _resizeParticleCanvas();
    window.addEventListener("resize", _resizeParticleCanvas);
  }
  __name(_createParticleCanvas, "_createParticleCanvas");
  function _resizeParticleCanvas() {
    _particleCanvas.width = window.innerWidth;
    _particleCanvas.height = window.innerHeight;
  }
  __name(_resizeParticleCanvas, "_resizeParticleCanvas");
  function _attachDragHandlers() {
    document.querySelectorAll(".panel").forEach((panel) => {
      const header = panel.querySelector(".panel-header");
      if (!header || !PANELS[panel.id]) return;
      const sealBtn = document.createElement("button");
      sealBtn.className = "panel-seal-btn";
      sealBtn.innerHTML = "\u25C8";
      sealBtn.title = "Seal panel to dock";
      sealBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        _toggleMinimize(panel);
      });
      header.appendChild(sealBtn);
      header.style.cursor = "grab";
      header.addEventListener("mousedown", (e) => _startDrag(e, panel));
      header.addEventListener("touchstart", (e) => _startDrag(e, panel), { passive: false });
      header.addEventListener("dblclick", () => _toggleMinimize(panel));
    });
    document.addEventListener("mousemove", _onDrag);
    document.addEventListener("touchmove", _onDrag, { passive: false });
    document.addEventListener("mouseup", _endDrag);
    document.addEventListener("touchend", _endDrag);
  }
  __name(_attachDragHandlers, "_attachDragHandlers");
  var _dragStartPos = null;
  var _dragThreshold = 10;
  function _startDrag(e, panel) {
    if (e.target.closest(".panel-close, .panel-seal-btn, button, input, select")) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    _dragStartPos = { x: clientX, y: clientY, panel };
    _mode = "manual";
    const rect = panel.getBoundingClientRect();
    _dragOffset = { x: clientX - rect.left, y: clientY - rect.top };
  }
  __name(_startDrag, "_startDrag");
  function _onDrag(e) {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    if (_dragStartPos && !_dragging) {
      const dx = Math.abs(clientX - _dragStartPos.x);
      const dy = Math.abs(clientY - _dragStartPos.y);
      if (dx > _dragThreshold || dy > _dragThreshold) {
        _dragging = _dragStartPos.panel;
        _dragging.classList.add("panel-dragging");
        _dragging.style.transition = "none";
        _dragging.style.position = "fixed";
        _dragging.style.zIndex = "9999";
        if (_autoSnap && _showAnchors && !document.body.classList.contains("panel-mode-auto")) _anchorOverlay.classList.add("visible");
        _startParticleTrail(clientX, clientY);
      }
    }
    if (!_dragging) return;
    e.preventDefault();
    const x = clientX - _dragOffset.x;
    const y = clientY - _dragOffset.y;
    _dragging.style.left = x + "px";
    _dragging.style.top = y + "px";
    _dragging.style.right = "auto";
    _dragging.style.bottom = "auto";
    const nearest = _findNearestAnchor(clientX, clientY);
    document.querySelectorAll(".ley-anchor").forEach((el) => {
      el.classList.toggle("active", el.dataset.anchor === nearest.id);
    });
    _updateParticleTrail(clientX, clientY);
  }
  __name(_onDrag, "_onDrag");
  function _endDrag() {
    _dragStartPos = null;
    if (!_dragging) return;
    const panel = _dragging;
    if (_autoSnap && !document.body.classList.contains("panel-mode-auto")) {
      const rect = panel.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const anchor = _findNearestAnchor(centerX, centerY);
      _snapToAnchor(panel, anchor);
      _flashAnchorRune(anchor);
    } else {
      panel.dataset.anchor = "";
    }
    panel.classList.remove("panel-dragging");
    panel.style.transition = "";
    panel.style.zIndex = "";
    _anchorOverlay.classList.remove("visible");
    _stopParticleTrail();
    _dragging = null;
    _saveFormation();
  }
  __name(_endDrag, "_endDrag");
  function _findNearestAnchor(x, y) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nearest = ANCHORS[0];
    let minDist = Infinity;
    for (const a of ANCHORS) {
      const ax = a.x * vw;
      const ay = a.y * vh;
      const dist = Math.hypot(x - ax, y - ay);
      if (dist < minDist) {
        minDist = dist;
        nearest = a;
      }
    }
    return nearest;
  }
  __name(_findNearestAnchor, "_findNearestAnchor");
  function _snapToAnchor(panel, anchor) {
    const pad = 15;
    const style = panel.style;
    style.left = style.right = style.top = style.bottom = "auto";
    style.transform = "";
    if (anchor.x === 0) style.left = pad + "px";
    else if (anchor.x === 1) style.right = pad + "px";
    else {
      style.left = "50%";
      style.transform = "translateX(-50%)";
    }
    if (anchor.y === 0) style.top = pad + "px";
    else if (anchor.y === 1) style.bottom = pad + "px";
    else {
      style.top = "50%";
      style.transform = anchor.x === 0.5 ? "translate(-50%, -50%)" : "translateY(-50%)";
    }
    panel.dataset.anchor = anchor.id;
  }
  __name(_snapToAnchor, "_snapToAnchor");
  function _toggleMinimize(panel) {
    const isMinimized = panel.classList.contains("panel-sealed");
    if (isMinimized) {
      _unsealPanel(panel);
      _saveFormation();
    } else {
      _sealPanel(panel);
    }
  }
  __name(_toggleMinimize, "_toggleMinimize");
  function _sealPanel(panel) {
    const def = PANELS[panel.id];
    if (!def) return;
    const rect = panel.getBoundingClientRect();
    panel.dataset.originalAnchor = panel.dataset.anchor || def.anchor;
    panel.dataset.originalLeft = panel.style.left || rect.left + "px";
    panel.dataset.originalTop = panel.style.top || rect.top + "px";
    panel.dataset.originalRight = panel.style.right;
    panel.dataset.originalBottom = panel.style.bottom;
    panel.dataset.originalTransform = panel.style.transform;
    panel.dataset.originalWidth = rect.width;
    panel.dataset.originalHeight = rect.height;
    const rune = _createRune(panel.id, def);
    _spawnSealParticles(panel);
    if (_sealMode === "dock") {
      _sealToDock(panel, rune, rect);
    } else if (_sealMode === "anchored") {
      _sealAnchored(panel, rune, rect);
    } else if (_sealMode === "wander") {
      _sealWandering(panel, rune, rect);
    } else if (_sealMode === "conjure") {
      _sealConjured(panel, rune, rect);
    }
  }
  __name(_sealPanel, "_sealPanel");
  function _createRune(panelId, def) {
    const rune = document.createElement("div");
    rune.className = "sealed-rune";
    rune.dataset.panelId = panelId;
    rune.title = def.name;
    const icon = document.createElement("span");
    icon.className = "rune-icon";
    icon.textContent = def.icon;
    const glow = document.createElement("span");
    glow.className = "rune-glow";
    const label = document.createElement("span");
    label.className = "rune-label";
    label.textContent = def.name;
    rune.appendChild(icon);
    rune.appendChild(glow);
    rune.appendChild(label);
    const panel = document.getElementById(panelId);
    rune.addEventListener("click", (e) => {
      if (rune._dragManaged) return;
      _toggleMinimize(panel);
    });
    return rune;
  }
  __name(_createRune, "_createRune");
  function _insertRuneInOrder(tray, rune) {
    const panel = document.getElementById(rune.dataset.panelId);
    const rightIds = (panel?.dataset.dockRight || "").split(",").filter(Boolean);
    const leftIds = (panel?.dataset.dockLeft || "").split(",").filter(Boolean);
    for (const id of rightIds) {
      const sib = tray.querySelector(`.sealed-rune[data-panel-id="${id}"]`);
      if (sib) {
        tray.insertBefore(rune, sib);
        return;
      }
    }
    for (let i = leftIds.length - 1; i >= 0; i--) {
      const sib = tray.querySelector(`.sealed-rune[data-panel-id="${leftIds[i]}"]`);
      if (sib) {
        sib.after(rune);
        return;
      }
    }
    tray.appendChild(rune);
  }
  __name(_insertRuneInOrder, "_insertRuneInOrder");
  function _sealToDock(panel, rune, rect) {
    const tray = _sealedDock.querySelector(".dock-tray");
    _insertRuneInOrder(tray, rune);
    _sealedDock.classList.add("has-runes");
    _sealedDock.style.bottom = "0";
    requestAnimationFrame(() => {
      const runeRect = rune.getBoundingClientRect();
      const targetX = runeRect.left + runeRect.width / 2;
      const targetY = runeRect.top + runeRect.height / 2;
      panel.style.transition = "all 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)";
      panel.style.transform = `translate(${targetX - rect.left - rect.width / 2}px, ${targetY - rect.top - rect.height / 2}px) scale(0)`;
      panel.style.opacity = "0";
      setTimeout(() => {
        _finalizeSeal(panel);
        rune.classList.add("entering");
        setTimeout(() => rune.classList.remove("entering"), 500);
      }, 500);
    });
  }
  __name(_sealToDock, "_sealToDock");
  function _sealAnchored(panel, rune, rect) {
    rune.classList.add("anchored-rune");
    rune.style.position = "fixed";
    rune.style.left = rect.left + rect.width / 2 - 25 + "px";
    rune.style.top = rect.top + rect.height / 2 - 25 + "px";
    document.body.appendChild(rune);
    _makeRuneDraggable(rune);
    panel.style.transition = "all 0.4s ease-out";
    panel.style.transform = "scale(0)";
    panel.style.opacity = "0";
    setTimeout(() => {
      _finalizeSeal(panel);
      rune.classList.add("entering");
      setTimeout(() => rune.classList.remove("entering"), 500);
    }, 400);
  }
  __name(_sealAnchored, "_sealAnchored");
  function _makeRuneDraggable(rune) {
    rune._dragManaged = true;
    let startX, startY, origLeft, origTop, moved;
    function onDown(e) {
      if (rune.closest(".dock-tray")) return;
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const pt = e.touches ? e.touches[0] : e;
      startX = pt.clientX;
      startY = pt.clientY;
      origLeft = parseFloat(rune.style.left) || 0;
      origTop = parseFloat(rune.style.top) || 0;
      moved = false;
      rune.classList.add("rune-dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    }
    __name(onDown, "onDown");
    function onMove(e) {
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - startX, dy = pt.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      moved = true;
      rune.style.left = origLeft + dx + "px";
      rune.style.top = origTop + dy + "px";
      rune.style.transition = "none";
    }
    __name(onMove, "onMove");
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
      rune.classList.remove("rune-dragging");
      rune.style.transition = "";
      if (!moved) {
        const panel = document.getElementById(rune.dataset.panelId);
        if (panel) _toggleMinimize(panel);
      }
    }
    __name(onUp, "onUp");
    rune.addEventListener("mousedown", onDown);
    rune.addEventListener("touchstart", onDown, { passive: false });
  }
  __name(_makeRuneDraggable, "_makeRuneDraggable");
  function _sealWandering(panel, rune, rect) {
    rune.classList.add("wandering-rune");
    rune.style.position = "fixed";
    rune.style.left = rect.left + rect.width / 2 - 25 + "px";
    rune.style.top = rect.top + rect.height / 2 - 25 + "px";
    document.body.appendChild(rune);
    _wanderingRunes.push({
      el: rune,
      x: rect.left + rect.width / 2 - 25,
      y: rect.top + rect.height / 2 - 25,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2
    });
    if (_wanderingRunes.length === 1) {
      _animateWandering();
    }
    panel.style.transition = "all 0.4s ease-out";
    panel.style.transform = "scale(0)";
    panel.style.opacity = "0";
    setTimeout(() => {
      _finalizeSeal(panel);
      rune.classList.add("entering");
      setTimeout(() => rune.classList.remove("entering"), 500);
    }, 400);
  }
  __name(_sealWandering, "_sealWandering");
  function _sealConjured(panel, rune, rect) {
    let conjured = document.getElementById("conjured-runes");
    if (!conjured) {
      conjured = _createConjuredContainer();
    }
    rune.style.position = "fixed";
    conjured.appendChild(rune);
    _makeRuneDraggable(rune);
    panel.style.transition = "all 0.4s ease-out";
    panel.style.transform = "scale(0)";
    panel.style.opacity = "0";
    setTimeout(() => {
      _finalizeSeal(panel);
      rune.classList.add("entering");
      setTimeout(() => rune.classList.remove("entering"), 500);
      _arrangeConjuredRunes();
      _startConjureOrbit();
    }, 400);
  }
  __name(_sealConjured, "_sealConjured");
  function _createConjuredContainer() {
    const conjured = document.createElement("div");
    conjured.id = "conjured-runes";
    conjured.className = "conjured-runes";
    const sigil = document.createElement("div");
    sigil.className = "conjure-sigil";
    sigil.innerHTML = `<svg viewBox="0 0 120 120" width="120" height="120">
    <circle cx="60" cy="60" r="55" fill="none" stroke="rgba(160,120,220,0.15)" stroke-width="1"/>
    <circle cx="60" cy="60" r="40" fill="none" stroke="rgba(160,120,220,0.1)" stroke-width="0.5" stroke-dasharray="4 4"/>
    <circle cx="60" cy="60" r="25" fill="none" stroke="rgba(160,120,220,0.08)" stroke-width="0.5"/>
    <polygon points="60,10 107,82 13,82" fill="none" stroke="rgba(180,140,255,0.12)" stroke-width="0.5"/>
    <polygon points="60,110 13,38 107,38" fill="none" stroke="rgba(180,140,255,0.12)" stroke-width="0.5"/>
    <circle cx="60" cy="60" r="4" fill="rgba(200,170,255,0.3)"/>
  </svg>`;
    conjured.appendChild(sigil);
    const ring = document.createElement("div");
    ring.className = "conjure-orbit-ring";
    conjured.appendChild(ring);
    document.body.appendChild(conjured);
    return conjured;
  }
  __name(_createConjuredContainer, "_createConjuredContainer");
  function _finalizeSeal(panel) {
    panel.classList.add("panel-sealed");
    panel.style.display = "none";
    panel.style.transition = "";
    panel.style.transform = "";
    panel.style.opacity = "";
    _saveFormation();
    _updateDockBadge();
    document.dispatchEvent(new CustomEvent("panel-layout-change", { detail: { action: "seal", id: panel.id } }));
  }
  __name(_finalizeSeal, "_finalizeSeal");
  function _animateWandering() {
    if (_wanderingRunes.length === 0) return;
    const padding = 60;
    const maxX = window.innerWidth - padding;
    const maxY = window.innerHeight - padding;
    for (const wr of _wanderingRunes) {
      wr.x += wr.vx;
      wr.y += wr.vy;
      if (wr.x < padding || wr.x > maxX) {
        wr.vx *= -1;
        wr.x = Math.max(padding, Math.min(maxX, wr.x));
      }
      if (wr.y < padding || wr.y > maxY) {
        wr.vy *= -1;
        wr.y = Math.max(padding, Math.min(maxY, wr.y));
      }
      wr.vx += (Math.random() - 0.5) * 0.1;
      wr.vy += (Math.random() - 0.5) * 0.1;
      const maxV = 1.5;
      wr.vx = Math.max(-maxV, Math.min(maxV, wr.vx));
      wr.vy = Math.max(-maxV, Math.min(maxV, wr.vy));
      wr.el.style.left = wr.x + "px";
      wr.el.style.top = wr.y + "px";
    }
    requestAnimationFrame(_animateWandering);
  }
  __name(_animateWandering, "_animateWandering");
  function _arrangeConjuredRunes() {
    const conjured = document.getElementById("conjured-runes");
    if (!conjured) return;
    const runes = [...conjured.querySelectorAll(".sealed-rune")];
    const count = runes.length;
    if (count === 0) return;
    const isMobile = window.innerWidth < 600;
    const centerX = isMobile ? window.innerWidth / 2 : window.innerWidth - 140;
    const centerY = isMobile ? window.innerHeight / 2 : window.innerHeight - 140;
    const radius = Math.max(55, 35 + count * 12);
    const sigil = conjured.querySelector(".conjure-sigil");
    const ring = conjured.querySelector(".conjure-orbit-ring");
    if (sigil) {
      sigil.style.left = centerX - 60 + "px";
      sigil.style.top = centerY - 60 + "px";
    }
    if (ring) {
      ring.style.left = centerX - radius - 8 + "px";
      ring.style.top = centerY - radius - 8 + "px";
      ring.style.width = radius * 2 + 16 + "px";
      ring.style.height = radius * 2 + 16 + "px";
    }
    runes.forEach((rune, i) => {
      rune.dataset.orbitIndex = i;
      rune.dataset.orbitTotal = count;
      rune.dataset.orbitCx = centerX;
      rune.dataset.orbitCy = centerY;
      rune.dataset.orbitR = radius;
      const angle = i / count * Math.PI * 2 - Math.PI / 2;
      const x = centerX + Math.cos(angle) * radius - 25;
      const y = centerY + Math.sin(angle) * radius - 25;
      rune.style.transition = "all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)";
      rune.style.left = x + "px";
      rune.style.top = y + "px";
      rune.style.animationDelay = -(i * 0.7) + "s";
    });
  }
  __name(_arrangeConjuredRunes, "_arrangeConjuredRunes");
  function _startConjureOrbit() {
    if (_conjureRaf) return;
    _conjureAngle = 0;
    function tick() {
      const conjured = document.getElementById("conjured-runes");
      if (!conjured || _sealMode !== "conjure") {
        _conjureRaf = 0;
        return;
      }
      const runes = [...conjured.querySelectorAll(".sealed-rune")];
      if (runes.length === 0) {
        _conjureRaf = 0;
        return;
      }
      _conjureAngle += 3e-3;
      runes.forEach((rune) => {
        if (rune.classList.contains("rune-dragging")) return;
        const i = parseInt(rune.dataset.orbitIndex) || 0;
        const n = parseInt(rune.dataset.orbitTotal) || 1;
        const cx = parseFloat(rune.dataset.orbitCx) || window.innerWidth / 2;
        const cy = parseFloat(rune.dataset.orbitCy) || window.innerHeight / 2;
        const r = parseFloat(rune.dataset.orbitR) || 60;
        const baseAngle = i / n * Math.PI * 2 - Math.PI / 2;
        const angle = baseAngle + _conjureAngle;
        const wobble = Math.sin(_conjureAngle * 3 + i * 1.7) * 4;
        const x = cx + Math.cos(angle) * (r + wobble) - 25;
        const y = cy + Math.sin(angle) * (r + wobble) - 25;
        rune.style.transition = "none";
        rune.style.left = x + "px";
        rune.style.top = y + "px";
      });
      _conjureRaf = requestAnimationFrame(tick);
    }
    __name(tick, "tick");
    _conjureRaf = requestAnimationFrame(tick);
  }
  __name(_startConjureOrbit, "_startConjureOrbit");
  function _stopConjureOrbit() {
    if (_conjureRaf) {
      cancelAnimationFrame(_conjureRaf);
      _conjureRaf = 0;
    }
  }
  __name(_stopConjureOrbit, "_stopConjureOrbit");
  function _migrateSealedRunes(newMode) {
    const allRunes = document.querySelectorAll(".sealed-rune");
    if (allRunes.length === 0) return;
    _wanderingRunes = [];
    allRunes.forEach((rune, index) => {
      const panelId = rune.dataset.panelId;
      let rect = rune.getBoundingClientRect();
      if (rect.top > window.innerHeight - 50 || rect.top < 0 || rect.left > window.innerWidth - 50 || rect.left < 0) {
        rect = {
          left: window.innerWidth / 2 - 25 + index * 60,
          top: window.innerHeight / 2 - 25
        };
      }
      rune.remove();
      if (newMode === "dock") {
        const tray = _sealedDock.querySelector(".dock-tray");
        rune.className = "sealed-rune";
        rune.style = "";
        tray.appendChild(rune);
        _sealedDock.classList.add("has-runes");
        _sealedDock.style.bottom = "0";
      } else if (newMode === "anchored") {
        rune.classList.add("anchored-rune");
        rune.classList.remove("wandering-rune");
        rune.style.position = "fixed";
        rune.style.left = rect.left + "px";
        rune.style.top = rect.top + "px";
        document.body.appendChild(rune);
        _makeRuneDraggable(rune);
        _sealedDock.classList.remove("has-runes");
        _sealedDock.style.bottom = "-80px";
      } else if (newMode === "wander") {
        rune.classList.add("wandering-rune");
        rune.classList.remove("anchored-rune");
        rune.style.position = "fixed";
        rune.style.left = rect.left + "px";
        rune.style.top = rect.top + "px";
        document.body.appendChild(rune);
        _wanderingRunes.push({
          el: rune,
          x: rect.left,
          y: rect.top,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2
        });
        _sealedDock.classList.remove("has-runes");
        _sealedDock.style.bottom = "-80px";
      } else if (newMode === "conjure") {
        let conjured = document.getElementById("conjured-runes");
        if (!conjured) conjured = _createConjuredContainer();
        rune.classList.remove("anchored-rune", "wandering-rune");
        rune.style.position = "fixed";
        conjured.appendChild(rune);
        _makeRuneDraggable(rune);
        _sealedDock.classList.remove("has-runes");
        _sealedDock.style.bottom = "-80px";
      }
    });
    if (newMode === "wander" && _wanderingRunes.length > 0) {
      _animateWandering();
    }
    if (newMode !== "conjure") {
      _stopConjureOrbit();
      const old = document.getElementById("conjured-runes");
      if (old) old.remove();
    }
    if (newMode === "conjure") {
      _arrangeConjuredRunes();
      _startConjureOrbit();
    }
  }
  __name(_migrateSealedRunes, "_migrateSealedRunes");
  function _unsealPanel(panel) {
    let rune = _sealedDock?.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);
    if (!rune) rune = document.querySelector(`.sealed-rune[data-panel-id="${panel.id}"]`);
    if (rune) {
      _wanderingRunes = _wanderingRunes.filter((wr) => wr.el !== rune);
      const allRight = [], allLeft = [];
      let s = rune.nextElementSibling;
      while (s) {
        if (s.classList.contains("sealed-rune")) allRight.push(s.dataset.panelId);
        s = s.nextElementSibling;
      }
      s = rune.previousElementSibling;
      while (s) {
        if (s.classList.contains("sealed-rune")) allLeft.unshift(s.dataset.panelId);
        s = s.previousElementSibling;
      }
      panel.dataset.dockRight = allRight.join(",");
      panel.dataset.dockLeft = allLeft.join(",");
      rune.classList.add("exiting");
      setTimeout(() => {
        rune.remove();
        _updateDockBadge();
        const tray = _sealedDock?.querySelector(".dock-tray");
        if (tray && tray.children.length === 0) {
          _sealedDock.classList.remove("has-runes");
          _sealedDock.style.bottom = "-80px";
          _sealedDock.classList.remove("dock-expanded");
        }
        _arrangeConjuredRunes();
      }, 300);
    }
    panel.classList.remove("panel-sealed");
    panel.style.display = "";
    const _visMap = {
      "realm-panel": "vis-statuspanel",
      "legend": "vis-legend",
      "spellbook": "vis-spellbook",
      "realm-codex": "vis-codex",
      "quest-log": "vis-questlog",
      "node-list": "vis-nodelist",
      "cartographer": "vis-cartographer",
      "energy-panel": "vis-energy",
      "debug-panel": "vis-debug",
      "latency-panel": "vis-latency",
      "firewall-panel": "vis-firewall",
      "wifi-panel": "vis-wifi"
    };
    const _visCb = document.getElementById(_visMap[panel.id]);
    if (_visCb && !_visCb.checked) _visCb.checked = true;
    const savedLeft = panel.dataset.originalLeft;
    const savedTop = panel.dataset.originalTop;
    const savedRight = panel.dataset.originalRight;
    const savedBottom = panel.dataset.originalBottom;
    if (savedLeft || savedTop) {
      let x = parseFloat(savedLeft) || 0;
      let y = parseFloat(savedTop) || 0;
      const pw = parseFloat(panel.dataset.originalWidth) || 200;
      const ph = parseFloat(panel.dataset.originalHeight) || 100;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 20;
      x = Math.max(pad - pw + 60, Math.min(vw - 60, x));
      y = Math.max(pad, Math.min(vh - 40, y));
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "";
      if (panel.dataset.originalAnchor) panel.dataset.anchor = panel.dataset.originalAnchor;
    } else if (savedRight || savedBottom) {
      panel.style.left = savedLeft || "";
      panel.style.top = savedTop || "";
      panel.style.right = savedRight || "";
      panel.style.bottom = savedBottom || "";
      panel.style.transform = panel.dataset.originalTransform || "";
      if (panel.dataset.originalAnchor) panel.dataset.anchor = panel.dataset.originalAnchor;
    } else if (!document.body.classList.contains("panel-mode-auto")) {
      const anchorId = panel.dataset.originalAnchor;
      const anchor = ANCHORS.find((a) => a.id === anchorId);
      if (anchor) _snapToAnchor(panel, anchor);
    }
    const baseTransform = panel.style.transform || "";
    panel.style.opacity = "0";
    panel.style.transform = (baseTransform ? baseTransform + " " : "") + "scale(0.5)";
    requestAnimationFrame(() => {
      panel.style.transition = "all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)";
      panel.style.opacity = "1";
      panel.style.transform = baseTransform;
      setTimeout(() => {
        panel.style.transition = "";
      }, 400);
    });
    _spawnRestoreParticles(panel);
    document.dispatchEvent(new CustomEvent("panel-layout-change", { detail: { action: "unseal", id: panel.id } }));
  }
  __name(_unsealPanel, "_unsealPanel");
  var _particles = [];
  var _trailActive = false;
  var _trailX = 0;
  var _trailY = 0;
  function _startParticleTrail(x, y) {
    _trailActive = true;
    _trailX = x;
    _trailY = y;
    if (!_particleLoopRunning) _animateParticles();
  }
  __name(_startParticleTrail, "_startParticleTrail");
  function _updateParticleTrail(x, y) {
    if (!_trailActive) return;
    const dx = x - _trailX;
    const dy = y - _trailY;
    const dist = Math.hypot(dx, dy);
    if (dist > 5) {
      _particles.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2 - 1,
        life: 1,
        size: Math.random() * 4 + 2,
        hue: 200 + Math.random() * 60
      });
      _trailX = x;
      _trailY = y;
    }
  }
  __name(_updateParticleTrail, "_updateParticleTrail");
  function _stopParticleTrail() {
    _trailActive = false;
  }
  __name(_stopParticleTrail, "_stopParticleTrail");
  var _particleLoopRunning = false;
  function _animateParticles() {
    if (!_trailActive && _particles.length === 0) {
      _particleLoopRunning = false;
      return;
    }
    _particleLoopRunning = true;
    const ctx = _particleCanvas.getContext("2d");
    ctx.clearRect(0, 0, _particleCanvas.width, _particleCanvas.height);
    let writeIdx = 0;
    for (let i = 0, len = _particles.length; i < len; i++) {
      const p = _particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;
      if (p.life <= 0) continue;
      if (writeIdx !== i) _particles[writeIdx] = p;
      writeIdx++;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 80%, 60%, ${p.life * 0.8})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life * 2, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.life * 0.3})`;
      ctx.fill();
    }
    _particles.length = writeIdx;
    requestAnimationFrame(_animateParticles);
  }
  __name(_animateParticles, "_animateParticles");
  function _flashAnchorRune(anchor) {
    const el = document.querySelector(`.ley-anchor[data-anchor="${anchor.id}"]`);
    if (!el) return;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 500);
  }
  __name(_flashAnchorRune, "_flashAnchorRune");
  function _spawnSealParticles(panel) {
    const rect = panel.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < 20; i++) {
      const angle = i / 20 * Math.PI * 2;
      _particles.push({
        x: cx + Math.cos(angle) * 50,
        y: cy + Math.sin(angle) * 50,
        vx: -Math.cos(angle) * 3,
        vy: -Math.sin(angle) * 3,
        life: 1,
        size: 4,
        hue: 280
      });
    }
    if (!_particleLoopRunning) _animateParticles();
  }
  __name(_spawnSealParticles, "_spawnSealParticles");
  function _spawnRestoreParticles(panel) {
    const rect = panel.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 4 + 2;
      _particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        size: Math.random() * 3 + 2,
        hue: 50 + Math.random() * 30
      });
    }
    if (!_particleLoopRunning) _animateParticles();
  }
  __name(_spawnRestoreParticles, "_spawnRestoreParticles");
  function applyFormation(formationId) {
    const formation = FORMATIONS[formationId];
    if (!formation) return;
    _currentFormation = formationId;
    let visible = formation.visible;
    let anchors = formation.anchors;
    let minimized = [];
    if (formationId === "grimoire-binding") {
      const saved = _loadSavedFormation();
      if (saved) {
        visible = saved.visible;
        anchors = saved.anchors;
        minimized = saved.minimized || [];
      } else {
        visible = Object.keys(PANELS);
        anchors = null;
      }
    }
    const tray = _sealedDock?.querySelector(".dock-tray");
    if (tray) tray.innerHTML = "";
    _sealedDock?.classList.remove("has-runes");
    Object.keys(PANELS).forEach((id) => {
      const panel = document.getElementById(id);
      if (panel) {
        panel.style.display = "none";
        panel.classList.remove("panel-sealed");
      }
    });
    if (visible) {
      visible.forEach((id) => {
        if (minimized.includes(id)) return;
        const panel = document.getElementById(id);
        if (!panel) return;
        panel.style.display = "";
        if (anchors && anchors[id]) {
          const anchor = ANCHORS.find((a) => a.id === anchors[id]);
          if (anchor) _snapToAnchor(panel, anchor);
        }
      });
      minimized.forEach((id) => {
        const panel = document.getElementById(id);
        if (!panel) return;
        _restoreSealedToDoc(panel, anchors?.[id] || PANELS[id]?.anchor);
      });
    }
    if (!anchors && visible) {
      _autoArrangePanels(visible.filter((id) => !minimized.includes(id)));
    }
    _spawnConjurationCircle();
  }
  __name(applyFormation, "applyFormation");
  function _restoreSealedToDoc(panel, anchorId) {
    const def = PANELS[panel.id];
    if (!def) return;
    panel.dataset.originalAnchor = anchorId || def.anchor;
    const tray = _sealedDock.querySelector(".dock-tray");
    const rune = document.createElement("div");
    rune.className = "sealed-rune";
    rune.dataset.panelId = panel.id;
    rune.title = def.name;
    const icon = document.createElement("span");
    icon.className = "rune-icon";
    icon.textContent = def.icon;
    const glow = document.createElement("span");
    glow.className = "rune-glow";
    const label = document.createElement("span");
    label.className = "rune-label";
    label.textContent = def.name;
    rune.appendChild(icon);
    rune.appendChild(glow);
    rune.appendChild(label);
    rune.addEventListener("click", () => {
      if (rune._dragManaged) return;
      _toggleMinimize(panel);
    });
    tray.appendChild(rune);
    panel.classList.add("panel-sealed");
    panel.style.display = "none";
    _sealedDock.classList.add("has-runes");
    _updateDockBadge();
  }
  __name(_restoreSealedToDoc, "_restoreSealedToDoc");
  function _autoArrangePanels(panelIds) {
    const sorted = [...panelIds].sort(
      (a, b) => (PANELS[a]?.priority || 99) - (PANELS[b]?.priority || 99)
    );
    const usedAnchors = /* @__PURE__ */ new Set();
    const anchorStacks = {};
    sorted.forEach((id) => {
      const panel = document.getElementById(id);
      if (!panel) return;
      const def = PANELS[id];
      let anchor = ANCHORS.find((a) => a.id === def?.anchor);
      if (usedAnchors.has(anchor?.id)) {
        const alternatives = ANCHORS.filter((a) => !usedAnchors.has(a.id));
        if (alternatives.length > 0) {
          anchor = alternatives[0];
        }
      }
      if (anchor) {
        _snapToAnchor(panel, anchor);
        usedAnchors.add(anchor.id);
        if (!anchorStacks[anchor.id]) anchorStacks[anchor.id] = 0;
        const stackOffset = anchorStacks[anchor.id] * 40;
        if (anchor.y === 0) panel.style.top = 15 + stackOffset + "px";
        else if (anchor.y === 1) panel.style.bottom = 15 + stackOffset + "px";
        anchorStacks[anchor.id]++;
      }
    });
  }
  __name(_autoArrangePanels, "_autoArrangePanels");
  function _spawnConjurationCircle() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    for (let ring = 0; ring < 3; ring++) {
      const radius = 100 + ring * 60;
      const count = 20 + ring * 10;
      for (let i = 0; i < count; i++) {
        const angle = i / count * Math.PI * 2;
        const delay = ring * 100 + i * 10;
        setTimeout(() => {
          _particles.push({
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
            vx: Math.cos(angle) * 0.5,
            vy: Math.sin(angle) * 0.5,
            life: 1,
            size: 3,
            hue: 200 + ring * 40
          });
        }, delay);
      }
    }
    if (!_particleLoopRunning) _animateParticles();
  }
  __name(_spawnConjurationCircle, "_spawnConjurationCircle");
  function _saveFormation() {
    const state = {
      visible: [],
      anchors: {},
      minimized: []
    };
    Object.keys(PANELS).forEach((id) => {
      const panel = document.getElementById(id);
      if (!panel) return;
      const isSealed = panel.classList.contains("panel-sealed");
      if (panel.style.display !== "none" || isSealed) {
        state.visible.push(id);
        if (panel.dataset.anchor) {
          state.anchors[id] = panel.dataset.anchor;
        }
      }
    });
    const tray = _sealedDock?.querySelector(".dock-tray");
    if (tray) {
      tray.querySelectorAll(".sealed-rune").forEach((rune) => {
        const pid = rune.dataset.panelId;
        if (pid) state.minimized.push(pid);
      });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  __name(_saveFormation, "_saveFormation");
  function _loadFormation() {
    const saved = _loadSavedFormation();
    if (saved) {
      applyFormation("grimoire-binding");
    }
  }
  __name(_loadFormation, "_loadFormation");
  function _loadSavedFormation() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }
  __name(_loadSavedFormation, "_loadSavedFormation");
  function _injectFormationUI() {
    const spellbook = document.getElementById("spellbook");
    if (!spellbook) return;
    const enchantPage = spellbook.querySelector('.spell-page[data-spell-page="0"]');
    if (!enchantPage) return;
    const section = document.createElement("div");
    section.className = "legend-section";
    section.dataset.section = "seal-modes";
    const header = document.createElement("div");
    header.className = "legend-section-header";
    header.dataset.accent = "purple";
    const chevron = document.createElement("span");
    chevron.className = "legend-chevron";
    chevron.textContent = "\u25BE";
    const secIcon = document.createElement("span");
    secIcon.className = "sec-icon";
    secIcon.textContent = "\u2727";
    header.appendChild(chevron);
    header.appendChild(secIcon);
    header.appendChild(document.createTextNode(" Sealed Runes"));
    const body = document.createElement("div");
    body.className = "legend-section-body";
    const sealGrid = document.createElement("div");
    sealGrid.className = "seal-mode-grid";
    Object.entries(SEAL_MODES).forEach(([id, mode]) => {
      const btn = document.createElement("button");
      btn.className = "seal-mode-btn" + (_sealMode === id ? " active" : "");
      btn.dataset.mode = id;
      btn.title = mode.desc;
      const icon = document.createElement("span");
      icon.className = "seal-mode-icon";
      icon.textContent = mode.icon;
      const name = document.createElement("span");
      name.className = "seal-mode-name";
      name.textContent = mode.name;
      btn.appendChild(icon);
      btn.appendChild(name);
      btn.addEventListener("click", () => {
        _sealMode = id;
        sealGrid.querySelectorAll(".seal-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        _migrateSealedRunes(id);
      });
      sealGrid.appendChild(btn);
    });
    body.appendChild(sealGrid);
    const settingsWrap = document.createElement("div");
    settingsWrap.className = "seal-settings";
    const snapRow = document.createElement("label");
    snapRow.className = "seal-setting-row";
    const snapCb = document.createElement("input");
    snapCb.type = "checkbox";
    snapCb.checked = _autoSnap;
    snapCb.addEventListener("change", () => {
      _autoSnap = snapCb.checked;
    });
    snapRow.appendChild(snapCb);
    snapRow.appendChild(document.createTextNode(" Auto-snap to anchors"));
    settingsWrap.appendChild(snapRow);
    const anchorRow = document.createElement("label");
    anchorRow.className = "seal-setting-row";
    const anchorCb = document.createElement("input");
    anchorCb.type = "checkbox";
    anchorCb.checked = _showAnchors;
    anchorCb.addEventListener("change", () => {
      _showAnchors = anchorCb.checked;
    });
    anchorRow.appendChild(anchorCb);
    anchorRow.appendChild(document.createTextNode(" Show anchor overlay"));
    settingsWrap.appendChild(anchorRow);
    body.appendChild(settingsWrap);
    section.appendChild(header);
    section.appendChild(body);
    enchantPage.insertBefore(section, enchantPage.firstChild);
  }
  __name(_injectFormationUI, "_injectFormationUI");
  function registerPanel(panel) {
    if (!panel || !PANELS[panel.id]) return;
    const header = panel.querySelector(".panel-header");
    if (!header) return;
    const sealBtn = document.createElement("button");
    sealBtn.className = "panel-seal-btn";
    sealBtn.innerHTML = "\u25C8";
    sealBtn.title = "Seal panel to dock";
    sealBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _toggleMinimize(panel);
    });
    header.appendChild(sealBtn);
    header.style.cursor = "grab";
    header.addEventListener("mousedown", (e) => _startDrag(e, panel));
    header.addEventListener("touchstart", (e) => _startDrag(e, panel), { passive: false });
    header.addEventListener("dblclick", () => _toggleMinimize(panel));
  }
  __name(registerPanel, "registerPanel");

  // src/app.js
  var _biomeLandScale = 1;
  var _biomeGlow = 1;
  var _biomeRoads = 0.5;
  var _biomePeaks = 0.5;
  var _biomeGrid = 0.03;
  var VLAN_BIOMES = {
    6: { name: "Citadel", land: "#141a28", glow: [240, 216, 144], accent: "#1a1810" },
    8: { name: "Family", land: "#1a1814", glow: [192, 160, 96], accent: "#1a1510" },
    10: { name: "Enchanted", land: "#101a18", glow: [96, 192, 96], accent: "#0a1a10" },
    11: { name: "Guest", land: "#101620", glow: [100, 160, 220], accent: "#0c1420" },
    0: { name: "Astral", land: "#0e1028", glow: [144, 96, 192], accent: "#0c0c20" }
  };
  function _nodeCenter(n) {
    const iw = n.iconStyle?.width ? parseInt(n.iconStyle.width) : 64;
    const ih = n.iconStyle?.height ? parseInt(n.iconStyle.height) : 64;
    return { x: n.x + iw / 2, y: n.y + ih / 2 };
  }
  __name(_nodeCenter, "_nodeCenter");
  function generateTerrain() {
    if (!_topology) return;
    const el = document.getElementById("terrain-dynamic");
    if (!el) return;
    const W = WORLD_W, H = WORLD_H;
    const vlanCounts = {};
    _topology.connections.forEach((c) => {
      if (!c.vlan) return;
      [c.from, c.to].forEach((id) => {
        if (!vlanCounts[id]) vlanCounts[id] = {};
        vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
      });
    });
    const nodeVlan = {};
    for (const [id, cts] of Object.entries(vlanCounts)) {
      let best = 6, max = 0;
      for (const [v, c] of Object.entries(cts)) {
        if (c > max) {
          max = c;
          best = +v;
        }
      }
      nodeVlan[id] = best;
    }
    _topology.nodes.forEach((n) => {
      if (!nodeVlan[n.id]) nodeVlan[n.id] = n.tailscale || n.type === "tailscale" ? 0 : 6;
    });
    const groups = {};
    _topology.nodes.forEach((n) => {
      const v = nodeVlan[n.id];
      if (!groups[v]) groups[v] = [];
      groups[v].push(n);
    });
    const biomes = [];
    for (const [vlan, nodes] of Object.entries(groups)) {
      const theme = VLAN_BIOMES[vlan] || VLAN_BIOMES[6];
      let sx = 0, sy = 0;
      const pts = nodes.map((n) => {
        const c = _nodeCenter(n);
        sx += c.x;
        sy += c.y;
        return c;
      });
      const cx = sx / pts.length, cy = sy / pts.length;
      let maxDx = 0, maxDy = 0;
      pts.forEach((p) => {
        maxDx = Math.max(maxDx, Math.abs(p.x - cx));
        maxDy = Math.max(maxDy, Math.abs(p.y - cy));
      });
      const pad = 180 * _biomeLandScale;
      const rx = (maxDx * 1.2 + pad) * _biomeLandScale;
      const ry = (maxDy * 1.2 + pad) * _biomeLandScale;
      biomes.push({ vlan: +vlan, theme, cx, cy, rx: Math.max(rx, 250), ry: Math.max(ry, 200), nodes, pts });
    }
    biomes.sort((a, b) => b.rx * b.ry - a.rx * a.ry);
    const g = _biomeGlow;
    let s = `<rect width="${W}" height="${H}" fill="#0a0a12"/>`;
    for (const b of biomes) {
      const { theme, cx, cy, rx, ry } = b;
      const [gr, gg, gb] = theme.glow;
      s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.4}" ry="${ry * 1.4}" fill="${theme.land}" filter="url(#terrain-blur-lg)" opacity="0.4"/>`;
      s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${theme.accent}" opacity="0.6"/>`;
      if (g > 0) {
        s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="none" opacity="1">`;
        s += `</circle>`;
        s += `<circle cx="${cx}" cy="${cy}" r="${rx * 0.9}" fill="rgba(${gr},${gg},${gb},${0.12 * g})" filter="url(#terrain-blur-lg)"/>`;
      }
    }
    if (g > 0) {
      for (const n of _topology.nodes) {
        const c = _nodeCenter(n);
        const v = nodeVlan[n.id];
        const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
        const [gr, gg, gb] = theme.glow;
        const r = n.type === "core" ? 120 : n.type === "tower" ? 70 : n.type === "infra" ? 55 : n.type === "bridge" ? 60 : 40;
        const op = n.type === "core" ? 0.15 * g : 0.08 * g;
        s += `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="rgba(${gr},${gg},${gb},${op})" filter="url(#terrain-blur)"/>`;
      }
    }
    if (_biomePeaks > 0) {
      for (const n of _topology.nodes) {
        if (n.type !== "core" && n.type !== "infra") continue;
        const c = _nodeCenter(n);
        const sz = n.type === "core" ? 60 : 35;
        const pk = _biomePeaks;
        let hash = 0;
        for (let i = 0; i < n.id.length; i++) hash = (hash << 5) - hash + n.id.charCodeAt(i) | 0;
        const pts = [];
        const spikes = n.type === "core" ? 6 : 4;
        for (let i = 0; i < spikes; i++) {
          const a = i / spikes * Math.PI * 2 - Math.PI / 2;
          const r = sz * pk * (0.7 + (hash >> i * 3 & 7) / 20);
          pts.push(`${c.x + Math.cos(a) * r | 0},${c.y + Math.sin(a) * r | 0}`);
        }
        s += `<polygon points="${pts.join(" ")}" fill="#1a2535" opacity="${0.4 * pk}"/>`;
        s += `<polygon points="${pts.join(" ")}" fill="none" stroke="rgba(160,140,100,${0.08 * pk})" stroke-width="1"/>`;
      }
    }
    if (_biomeRoads > 0) {
      const nodeMap = {};
      _topology.nodes.forEach((n) => {
        nodeMap[n.id] = n;
      });
      for (const c of _topology.connections) {
        const fn = nodeMap[c.from], tn = nodeMap[c.to];
        if (!fn || !tn) continue;
        const fp = _nodeCenter(fn), tp = _nodeCenter(tn);
        const mx = (fp.x + tp.x) / 2, my = (fp.y + tp.y) / 2;
        const v = c.vlan || nodeVlan[c.from] || 6;
        const theme = VLAN_BIOMES[v] || VLAN_BIOMES[6];
        const [gr, gg, gb] = theme.glow;
        const op = c.type === "mesh" || c.type === "portal" ? 0.03 : 0.06;
        s += `<path d="M${fp.x | 0},${fp.y | 0} Q${mx | 0},${my | 0} ${tp.x | 0},${tp.y | 0}" fill="none" stroke="rgba(${gr},${gg},${gb},${op * _biomeRoads})" stroke-width="${c.type === "active" ? 3 : 2}"/>`;
      }
    }
    s += `<g transform="translate(180,${H - 200})" opacity="0.3">`;
    s += `<line x1="0" y1="-40" x2="0" y2="40" stroke="#a89870" stroke-width="1"/>`;
    s += `<line x1="-40" y1="0" x2="40" y2="0" stroke="#a89870" stroke-width="1"/>`;
    s += `<polygon points="0,-45 -6,-10 6,-10" fill="#f0d890"/>`;
    s += `<text x="0" y="-52" text-anchor="middle" fill="#f0d890" font-family="Cinzel,serif" font-size="12">N</text>`;
    s += `<text x="0" y="62" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">S</text>`;
    s += `<text x="52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">E</text>`;
    s += `<text x="-52" y="4" text-anchor="middle" fill="#a89870" font-family="Cinzel,serif" font-size="10">W</text>`;
    s += `</g>`;
    if (_biomeGrid > 0) {
      s += `<g opacity="${_biomeGrid}" stroke="#a89870" stroke-width="0.5">`;
      for (let y = 400; y < H; y += 400) s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
      for (let x = 600; x < W; x += 600) s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
      s += `</g>`;
    }
    el.innerHTML = s;
  }
  __name(generateTerrain, "generateTerrain");
  var VLAN_REGION_LABELS = {
    6: { label: "The Citadel", color: "rgba(240,216,144,0.22)", spacing: 6 },
    8: { label: "The Family Hearth", color: "rgba(192,160,96,0.22)", spacing: 5 },
    10: { label: "The Enchanted Quarters", color: "rgba(96,192,96,0.22)", spacing: 5 },
    11: { label: "The Guest Marches", color: "rgba(100,160,220,0.22)", spacing: 4 },
    0: { label: "The Astral Sea", color: "rgba(144,96,192,0.22)", spacing: 5 }
  };
  var CITADEL_SUBLABELS = {
    core: { label: "The Inner Keep", fontSize: 14, color: "rgba(240,216,144,0.18)", spacing: 4 },
    tower: { label: "The Guardian Towers", fontSize: 13, color: "rgba(192,144,96,0.18)", spacing: 3 },
    bridge: { label: "The Signal Bridges", fontSize: 13, color: "rgba(144,96,192,0.18)", spacing: 3 },
    infra: { label: "The Deep Forges", fontSize: 13, color: "rgba(160,140,100,0.18)", spacing: 3 }
  };
  function updateRegionLabels() {
    if (!_topology) return;
    const rc = document.getElementById("region-labels");
    if (!rc) return;
    rc.innerHTML = "";
    const vlanCounts = {};
    _topology.connections.forEach((c) => {
      if (!c.vlan) return;
      [c.from, c.to].forEach((id) => {
        if (!vlanCounts[id]) vlanCounts[id] = {};
        vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
      });
    });
    const nodeVlan = {};
    for (const [id, cts] of Object.entries(vlanCounts)) {
      let best = 6, max = 0;
      for (const [v, c] of Object.entries(cts)) {
        if (c > max) {
          max = c;
          best = +v;
        }
      }
      nodeVlan[id] = best;
    }
    _topology.nodes.forEach((n) => {
      if (!nodeVlan[n.id]) nodeVlan[n.id] = n.tailscale || n.type === "tailscale" ? 0 : 6;
    });
    const groups = {};
    _topology.nodes.forEach((n) => {
      const v = nodeVlan[n.id];
      if (!groups[v]) groups[v] = [];
      groups[v].push(n);
    });
    for (const [vlan, nodes] of Object.entries(groups)) {
      const cfg = VLAN_REGION_LABELS[vlan] || VLAN_REGION_LABELS[6];
      const { cx, cy, minY } = _clusterBounds(nodes);
      _addRegionLabel(rc, cfg.label, cx, minY - 55, {
        fontSize: 18,
        color: cfg.color,
        spacing: cfg.spacing,
        rotate: 0
      });
      if (+vlan === 6) {
        const byType = {};
        nodes.forEach((n) => {
          const t = n.type || "device";
          if (!byType[t]) byType[t] = [];
          byType[t].push(n);
        });
        for (const [type, typeNodes] of Object.entries(byType)) {
          const sub = CITADEL_SUBLABELS[type];
          if (!sub || typeNodes.length < 2) continue;
          const tb = _clusterBounds(typeNodes);
          _addRegionLabel(rc, sub.label, tb.cx, tb.minY - 35, {
            fontSize: sub.fontSize,
            color: sub.color,
            spacing: sub.spacing,
            rotate: 0
          });
        }
      }
    }
    if (_mapTilt > 0) {
      const peakH = _mapTilt * 5;
      const counterRot = `x ${-_mapTilt}deg`;
      rc.style.translate = `0px 0px ${peakH * 0.7}px`;
      rc.style.rotate = counterRot;
    }
  }
  __name(updateRegionLabels, "updateRegionLabels");
  function _clusterBounds(nodes) {
    let sx = 0, sy = 0, minY = Infinity;
    const pts = nodes.map((n) => {
      const c = _nodeCenter(n);
      sx += c.x;
      sy += c.y;
      if (c.y < minY) minY = c.y;
      return c;
    });
    return { cx: sx / pts.length, cy: sy / pts.length, minY, pts };
  }
  __name(_clusterBounds, "_clusterBounds");
  function _addRegionLabel(container, text, x, y, opts) {
    const el = document.createElement("div");
    el.className = "region-label";
    let s = `left:${x}px;top:${y}px;transform:translateX(-50%)`;
    if (opts.rotate) s += ` rotate(${opts.rotate}deg)`;
    s += ";";
    if (opts.fontSize) s += `font-size:${opts.fontSize}px;`;
    if (opts.color) s += `color:${opts.color};`;
    if (opts.spacing) s += `letter-spacing:${opts.spacing}px;`;
    el.setAttribute("style", s);
    el.textContent = text;
    container.appendChild(el);
  }
  __name(_addRegionLabel, "_addRegionLabel");
  generateTerrain();
  updateRegionLabels();
  var DOM = {
    gForge: document.getElementById("g-forge"),
    gGpu: document.getElementById("g-gpu"),
    gMana: document.getElementById("g-mana"),
    gEssence: document.getElementById("g-essence"),
    rsVal: document.getElementById("realm-scale-val"),
    rsLabel: document.getElementById("realm-scale-label"),
    towersOnline: document.getElementById("towers-online"),
    towersTotal: document.getElementById("towers-total"),
    codexCd: document.getElementById("codex-collectd-count"),
    codexNodes: document.getElementById("codex-node-count")
  };
  var lastStatus = null;
  var liveOk = false;
  var _lastReportTs = 0;
  var _dbgRefreshTimer = null;
  function updateGauges(d) {
    const { forge, mana, essence } = d;
    const gpu = forge.gpu;
    const gpuLoad = gpu ? gpu.load : 0;
    DOM.gForge.style.width = forge.usage + "%";
    DOM.gForge.parentElement.nextElementSibling.textContent = forge.usage.toFixed(1) + "%";
    DOM.gGpu.style.width = gpuLoad + "%";
    DOM.gGpu.parentElement.nextElementSibling.textContent = gpuLoad.toFixed(0) + "%";
    DOM.gMana.style.width = mana.usage + "%";
    DOM.gMana.parentElement.nextElementSibling.textContent = mana.usage.toFixed(1) + "%";
    DOM.gEssence.style.width = essence.usage + "%";
    DOM.gEssence.parentElement.nextElementSibling.textContent = essence.usage.toFixed(0) + "%";
    DOM.rsVal.textContent = (d.realm_scale >= 0 ? "+" : "") + d.realm_scale.toFixed(1);
    DOM.rsVal.style.color = scaleColor(d.realm_scale);
    DOM.rsLabel.textContent = scaleLabel(d.realm_scale);
  }
  __name(updateGauges, "updateGauges");
  var _vlanNames = { 6: "Admin", 8: "Family", 10: "IoT", 11: "Guest" };
  function _latencyHue(ms) {
    if (ms < 1) return 140;
    if (ms < 5) return 100;
    if (ms < 15) return 60;
    if (ms < 50) return 30;
    return 0;
  }
  __name(_latencyHue, "_latencyHue");
  function _buildNodeLookup() {
    const map = {};
    if (!_topology?.nodes) return map;
    for (const n of _topology.nodes) {
      map[n.id] = { icon: n.icon || "?", label: n.label || n.id, ip: n.ip || "" };
    }
    return map;
  }
  __name(_buildNodeLookup, "_buildNodeLookup");
  function updateLatencyPanel() {
    const body = document.getElementById("latency-body");
    const summary = document.getElementById("latency-summary");
    if (!body || !_latencyMap) return;
    const panel = document.getElementById("latency-panel");
    if (!panel || panel.style.display === "none") return;
    const nodes = _buildNodeLookup();
    const entries = Object.entries(_latencyMap).sort((a, b) => a[1] - b[1]);
    if (!entries.length) {
      body.textContent = "Probing...";
      return;
    }
    const rtts = entries.map((e) => e[1]);
    const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length;
    const max = rtts[rtts.length - 1];
    if (summary) summary.textContent = `${entries.length} nodes \u2022 avg ${avg.toFixed(1)}ms`;
    const groups = {};
    const tsGroup = [];
    for (const [id, rtt] of entries) {
      const n = nodes[id];
      const ip = n?.ip || "";
      const parts = ip.split(".");
      if (id.startsWith("ts-")) {
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
      const title = document.createElement("div");
      title.className = "latency-group-title";
      title.textContent = _vlanNames[vlan] || `VLAN ${vlan}`;
      frag.appendChild(title);
      for (const [id, rtt, n] of items) {
        frag.appendChild(_makeLatencyRow(id, rtt, n, max));
      }
    }
    for (const vlan of Object.keys(groups).map(Number).sort()) {
      if (vlanOrder.includes(vlan) || vlan === 0) continue;
      const items = groups[vlan];
      const title = document.createElement("div");
      title.className = "latency-group-title";
      title.textContent = `VLAN ${vlan}`;
      frag.appendChild(title);
      for (const [id, rtt, n] of items) {
        frag.appendChild(_makeLatencyRow(id, rtt, n, max));
      }
    }
    if (tsGroup.length) {
      const title = document.createElement("div");
      title.className = "latency-group-title";
      title.textContent = "Tailscale";
      frag.appendChild(title);
      for (const [id, rtt, n] of tsGroup) {
        frag.appendChild(_makeLatencyRow(id, rtt, n, max));
      }
    }
    if (groups[0]) {
      const title = document.createElement("div");
      title.className = "latency-group-title";
      title.textContent = "Other";
      frag.appendChild(title);
      for (const [id, rtt, n] of groups[0]) {
        frag.appendChild(_makeLatencyRow(id, rtt, n, max));
      }
    }
    body.textContent = "";
    body.appendChild(frag);
  }
  __name(updateLatencyPanel, "updateLatencyPanel");
  function _makeLatencyRow(id, rtt, n, maxRtt) {
    const row = document.createElement("div");
    row.className = "latency-row";
    const hue = _latencyHue(rtt);
    const pct = Math.min(rtt / Math.max(maxRtt, 1) * 100, 100);
    row.innerHTML = `<span class="latency-icon">${n?.icon || "?"}</span><span class="latency-label">${n?.label || id}</span><span class="latency-bar"><span class="latency-fill" style="width:${pct}%;background:hsl(${hue},70%,50%)"></span></span><span class="latency-val">${rtt < 1 ? rtt.toFixed(2) : rtt.toFixed(1)} ms</span>`;
    return row;
  }
  __name(_makeLatencyRow, "_makeLatencyRow");
  var _vlanIfaceMap = {
    "3": "br-lan.3",
    "4": "br-lan.4",
    "5": "br-lan.5",
    "6": "br-lan.6",
    "7": "br-lan.7",
    "8": "br-lan.8",
    "9": "br-lan.9",
    "10": "br-lan.10",
    "11": "br-lan.11",
    "12": "br-lan.12",
    "20": "br-lan.20",
    "38": "br-lan.38"
  };
  var _fwData = null;
  var _fwFetchTimer = null;
  function _fetchFirewall() {
    fetch("/firewall").then((r) => r.json()).then((d) => {
      if (!d.error) {
        _fwData = d;
        _renderFirewallPanel();
      }
    }).catch(() => {
    });
  }
  __name(_fetchFirewall, "_fetchFirewall");
  var _fwVlanCache = null;
  function _buildFwVlanCache(panel) {
    _fwVlanCache = [];
    panel.querySelectorAll(".fw-vlan").forEach((row) => {
      _fwVlanCache.push({
        iface: _vlanIfaceMap[row.dataset.vlan],
        rx: row.querySelector(".fw-rx-val"),
        tx: row.querySelector(".fw-tx-val")
      });
    });
  }
  __name(_buildFwVlanCache, "_buildFwVlanCache");
  function updateFirewallPanel(d) {
    const panel = document.getElementById("firewall-panel");
    if (!panel || panel.style.display === "none") return;
    const gk = d.collectd?.["gatekeeper"];
    const ifaces = gk?.interfaces || {};
    if (!_fwVlanCache) _buildFwVlanCache(panel);
    for (const c of _fwVlanCache) {
      const data = ifaces[c.iface];
      c.rx.textContent = data ? fmtRate(data.rx_bps) : "--";
      c.tx.textContent = data ? fmtRate(data.tx_bps) : "--";
    }
  }
  __name(updateFirewallPanel, "updateFirewallPanel");
  function _renderFirewallPanel() {
    if (!_fwData) return;
    _fwVlanCache = null;
    const panel = document.getElementById("firewall-panel");
    if (!panel) return;
    const { zones, wan, suggestions } = _fwData;
    for (const [zname, z] of Object.entries(zones)) {
      const row = panel.querySelector(`.fw-vlan[data-vlan="${z.vlan}"]`);
      if (!row) continue;
      let statsEl = row.querySelector(".fw-zone-stats");
      if (!statsEl) {
        statsEl = document.createElement("div");
        statsEl.className = "fw-zone-stats";
        row.appendChild(statsEl);
      }
      const c = z.counters;
      let html = `<span class="fw-stat-accept">${fmtBytes(c.accept_bytes)} in</span>`;
      if (c.reject_pkts > 0) html += ` <span class="fw-stat-reject">${c.reject_pkts.toLocaleString()} rej</span>`;
      statsEl.innerHTML = html;
      let dnsEl = row.querySelector(".fw-dns-badge");
      if (z.dns_redirect) {
        if (!dnsEl) {
          dnsEl = document.createElement("span");
          dnsEl.className = "fw-dns-badge";
          const header = row.querySelector(".fw-vlan-header");
          if (header) header.appendChild(dnsEl);
        }
        dnsEl.textContent = "DNS";
        dnsEl.title = `${z.dns_queries.toLocaleString()} queries redirected`;
      } else if (dnsEl) {
        dnsEl.remove();
      }
      let blocksEl = row.querySelector(".fw-blocks");
      if (z.blocked_ips && z.blocked_ips.length) {
        if (!blocksEl) {
          blocksEl = document.createElement("div");
          blocksEl.className = "fw-blocks";
          row.appendChild(blocksEl);
        }
        blocksEl.innerHTML = z.blocked_ips.map(
          (b) => `<span class="fw-block-ip${b.pkts === 0 ? " fw-block-inactive" : ""}" title="${b.pkts.toLocaleString()} pkts blocked">${b.ip.replace("10.0.10.", ".10.")}${b.pkts > 0 ? " \u2717" : " ?"}</span>`
        ).join("");
      } else if (blocksEl) {
        blocksEl.innerHTML = "";
      }
      let reachEl = row.querySelector(".fw-reach");
      if (z.can_reach && z.can_reach.length) {
        if (!reachEl) {
          reachEl = document.createElement("div");
          reachEl.className = "fw-reach";
          row.appendChild(reachEl);
        }
        const labels = { wan: "WAN", lan: "IoT", iot: "Guest", family: "Family", admin: "Admin", vpn: "VPN", wanguard: "WAN Guard" };
        reachEl.innerHTML = "\u2192 " + z.can_reach.map((r) => labels[r] || r).join(", ");
      } else if (reachEl) {
        reachEl.innerHTML = "";
      }
    }
    const wanEl = document.getElementById("fw-wan");
    if (wanEl) wanEl.textContent = fmtBytes(wan.accept_bytes);
    const lanEl = document.getElementById("fw-lan");
    if (lanEl) lanEl.textContent = wan.reject_pkts.toLocaleString() + " rej";
    let sugEl = panel.querySelector(".fw-suggestions");
    if (!sugEl) {
      const body = panel.querySelector(".firewall-body");
      if (body) {
        const div = document.createElement("div");
        div.className = "fw-divider";
        body.appendChild(div);
        sugEl = document.createElement("div");
        sugEl.className = "fw-suggestions";
        body.appendChild(sugEl);
      }
    }
    if (sugEl && suggestions && suggestions.length) {
      const icons = { info: "\u2139", warn: "\u26A0", critical: "\u2622" };
      sugEl.innerHTML = '<div class="fw-section-title">Observations</div>' + suggestions.map(
        (s) => `<div class="fw-sug fw-sug-${s.severity}"><span class="fw-sug-icon">${icons[s.severity] || "\u2022"}</span> ${s.text}</div>`
      ).join("");
    }
  }
  __name(_renderFirewallPanel, "_renderFirewallPanel");
  setTimeout(() => {
    _fetchFirewall();
    _fwFetchTimer = setInterval(_fetchFirewall, 6e4);
  }, 3e3);
  var _VLAN_NAMES = { 6: "Admin", 8: "Family", 10: "IoT", 11: "Guest" };
  var _VLAN_COLORS = { 6: "#f0d890", 8: "#c0a060", 10: "#60c060", 11: "#64a0dc" };
  function _fetchWifiAPs() {
    const panel = document.getElementById("wifi-panel");
    if (!panel || panel.style.display === "none") return;
    fetch("/wifi/aps").then((r) => r.json()).then((data) => {
      _renderWifiPanel(data);
    }).catch(() => {
      const body = document.getElementById("wifi-body");
      if (body) body.innerHTML = '<div class="wifi-loading">Towers unreachable</div>';
    });
  }
  __name(_fetchWifiAPs, "_fetchWifiAPs");
  function _renderWifiPanel(data) {
    const body = document.getElementById("wifi-body");
    const badge = document.getElementById("wifi-ap-count");
    if (!body) return;
    const apIds = Object.keys(data);
    if (badge) badge.textContent = apIds.length + " towers";
    if (!apIds.length) {
      body.innerHTML = '<div class="wifi-loading">No towers found</div>';
      return;
    }
    let html = "";
    for (const [apId, ap] of Object.entries(data)) {
      const ssidHtml = (ap.ssids || []).map((s) => {
        const vlan = s.vlan;
        const vlanName = _VLAN_NAMES[vlan] || s.network || "?";
        const color = _VLAN_COLORS[vlan] || "#a89870";
        return `<div class="wifi-ssid">
        <span class="wifi-ssid-name">${s.ssid}</span>
        <span class="wifi-ssid-vlan" style="color:${color}">${vlanName}${vlan ? " <small>v" + vlan + "</small>" : ""}</span>
      </div>`;
      }).join("");
      html += `<div class="wifi-ap" data-ap="${apId}">
      <div class="wifi-ap-header">
        <span class="wifi-ap-icon">&#128225;</span>
        <span class="wifi-ap-name">${ap.label || apId}</span>
        <span class="wifi-ap-clients">${ap.clients || 0} &#128246;</span>
      </div>
      <div class="wifi-ap-ip">${ap.ip || ""}</div>
      ${ssidHtml || '<div class="wifi-ssid wifi-ssid-none">No SSIDs detected</div>'}
    </div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll(".wifi-ap").forEach((el) => {
      el.addEventListener("click", () => {
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
  __name(_renderWifiPanel, "_renderWifiPanel");
  setTimeout(() => {
    _fetchWifiAPs();
    setInterval(_fetchWifiAPs, 12e4);
  }, 4e3);
  function updateCoreSublabels(d) {
    const { forge, mana, essence, astral } = d;
    const gpu = forge.gpu;
    const gpuLoad = gpu ? gpu.load : 0;
    const gpuTemp = gpu ? gpu.temp : null;
    const forgeN = getNodeDOM("forge");
    if (forgeN.sub) {
      const tempStr = forge.temp != null ? forge.temp.toFixed(0) + "\xB0C" : "?";
      forgeN.sub.textContent = `CPU ${tempStr} \u2022 Scale ${forge.scale >= 0 ? "+" : ""}${forge.scale.toFixed(1)}`;
    }
    if (forgeN.bar) forgeN.bar.style.width = scalePct(forge.scale) + "%";
    const gpuN = getNodeDOM("gpu");
    if (gpuN.sub) {
      const tStr = gpuTemp != null ? gpuTemp.toFixed(0) + "\xB0C" : "?";
      gpuN.sub.textContent = `${tStr} \u2022 ${gpuLoad.toFixed(0)}% load`;
    }
    const manaN = getNodeDOM("mana");
    if (manaN.sub) manaN.sub.textContent = `${mana.usage.toFixed(1)}% used \u2022 Scale ${mana.scale >= 0 ? "+" : ""}${mana.scale.toFixed(1)}`;
    if (manaN.bar) manaN.bar.style.width = scalePct(mana.scale) + "%";
    const essN = getNodeDOM("essence");
    if (essN.sub) essN.sub.textContent = `${essence.plugged ? "Eternal Source" : "Untethered"} \u2022 ${essence.usage.toFixed(0)}%`;
    if (essN.bar) essN.bar.style.width = scalePct(essence.scale) + "%";
    const katN = getNodeDOM("katana");
    if (katN.bar) katN.bar.style.width = scalePct(d.realm_scale) + "%";
    const wanN = getNodeDOM("wan");
    if (wanN.sub && astral.nft) wanN.sub.textContent = fmtBytes(astral.nft.wan) + " traversed";
    const gkN = getNodeDOM("gatekeeper");
    if (gkN.sub) gkN.sub.textContent = astral.nodes.gatekeeper ? "OpenWrt Router \u2022 10.0.6.1" : "SILENT \u2022 10.0.6.1";
    if (gkN.pulse) gkN.pulse.style.display = astral.nodes.gatekeeper ? "" : "none";
    const oN = getNodeDOM("oracle");
    if (oN.sub) oN.sub.textContent = astral.nodes.oracle ? "ubox0 \u2022 10.0.6.11" : "SILENT \u2022 10.0.6.11";
    if (oN.pulse) oN.pulse.style.display = astral.nodes.oracle ? "" : "none";
  }
  __name(updateCoreSublabels, "updateCoreSublabels");
  function findStatusKey(nodeStatus, tipKey) {
    return Object.keys(nodeStatus).find((k) => k.toLowerCase() === tipKey.toLowerCase()) || Object.keys(nodeStatus).find((k) => k.replace(/-/g, "").toLowerCase() === tipKey.replace(/-/g, "").toLowerCase());
  }
  __name(findStatusKey, "findStatusKey");
  function findCollectd(collectd, tipKey, statusKey) {
    const info = infraNodes[tipKey];
    if (info && info.collectdHost && collectd[info.collectdHost]) return collectd[info.collectdHost];
    return collectd[statusKey || tipKey] || collectd[tipKey] || Object.values(collectd).find((c) => c.hostname && c.hostname.toLowerCase().replace(/[-_]/g, "") === tipKey.toLowerCase().replace(/[-_]/g, ""));
  }
  __name(findCollectd, "findCollectd");
  function buildCollectdExtra(cd) {
    const extra = [];
    if (cd.load_1 != null) extra.push(["Load", `${cd.load_1.toFixed(2)} / ${(cd.load_5 || 0).toFixed(2)} / ${(cd.load_15 || 0).toFixed(2)}`]);
    if (cd.mem_pct != null) extra.push(["Memory", `${cd.mem_pct}% of ${cd.mem_total_mb || "?"} MB`]);
    if (cd.cpu_cores) extra.push(["CPU Cores", cd.cpu_cores]);
    if (cd.temp != null) extra.push(["Temp", cd.temp + "\xB0C"]);
    if (cd.uptime != null) {
      const days = Math.floor(cd.uptime / 86400);
      const hrs = Math.floor(cd.uptime % 86400 / 3600);
      extra.push(["Uptime", days > 0 ? `${days}d ${hrs}h` : `${hrs}h`]);
    }
    if (cd.conntrack) extra.push(["Conntrack", cd.conntrack.toLocaleString()]);
    if (cd.dhcp_leases) extra.push(["DHCP Leases", cd.dhcp_leases]);
    if (cd.ping) Object.entries(cd.ping).forEach(([t, ms]) => extra.push(["Ping " + t, ms + " ms"]));
    if (cd.disk_pct != null) extra.push(["Disk", `${cd.disk_pct}% of ${cd.disk_total_gb} GB`]);
    if (cd.swap_used != null && cd.swap_used > 0) extra.push(["Swap", `${(cd.swap_used / 1048576).toFixed(0)} MB`]);
    if (cd.procs_running) extra.push(["Processes", cd.procs_running + " running"]);
    if (cd.interfaces) {
      Object.entries(cd.interfaces).map(([name, v]) => [name, (v.rx_bps || 0) + (v.tx_bps || 0)]).sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([name, total]) => {
        if (total > 0) {
          const iface = cd.interfaces[name];
          extra.push([name, `\u2193${fmtRate(iface.rx_bps)} \u2191${fmtRate(iface.tx_bps)}`]);
        }
      });
    }
    return extra;
  }
  __name(buildCollectdExtra, "buildCollectdExtra");
  function updateInfraNodes(d) {
    const nodeStatus = d.astral.nodes || {};
    let towersOnline = 0, towersTotal = 0;
    Object.entries(infraNodes).forEach(([tipKey, info]) => {
      const n = getNodeDOM(tipKey);
      const statusKey = findStatusKey(nodeStatus, tipKey);
      const online = statusKey ? nodeStatus[statusKey] : false;
      if (n.sub) n.sub.textContent = online ? `Online \u2022 ${info.ip}` : `Offline \u2022 ${info.ip}`;
      if (n.pulse) n.pulse.style.display = online ? "" : "none";
      if (n.el) n.el.style.opacity = online ? "1" : "0.35";
      if (n.isTower) {
        towersTotal++;
        if (online) towersOnline++;
      }
      if (d.collectd && tips[tipKey]) {
        const cd = findCollectd(d.collectd, tipKey, statusKey);
        if (cd) {
          const extra = buildCollectdExtra(cd);
          const base = tips[tipKey].stats.filter((s) => ["Model", "IP", "OS", "Role", "Service", "Hostname"].includes(s[0]));
          tips[tipKey].stats = [...base, ...extra, ["Status", online ? "Online" : "Offline"]];
          if (n.sub && cd.load_1 != null) {
            const memStr = cd.mem_pct != null ? ` \u2022 ${cd.mem_pct}%` : "";
            n.sub.textContent = `Load ${cd.load_1.toFixed(2)}${memStr} \u2022 ${info.ip}`;
          }
        }
      }
      if (tips[tipKey]) {
        const stats = tips[tipKey].stats;
        if (!stats.some((s) => s[0] === "Status")) stats.push(["Status", online ? "Online" : "Offline"]);
      }
    });
    DOM.towersOnline.textContent = towersOnline;
    DOM.towersTotal.textContent = towersTotal;
  }
  __name(updateInfraNodes, "updateInfraNodes");
  function updateHASublabels(d) {
    const ha = d.ha;
    if (!ha) return;
    for (const [nodeId, info] of Object.entries(ha)) {
      const n = getNodeDOM(nodeId);
      if (n.sub) n.sub.textContent = info.sublabel;
      if (tips[nodeId]) {
        const existing = tips[nodeId].stats.filter((s) => s[0] !== "HA Status");
        existing.push(["HA Status", info.sublabel]);
        tips[nodeId].stats = existing;
      }
    }
  }
  __name(updateHASublabels, "updateHASublabels");
  function updateTooltips(d) {
    const { forge, mana, essence, astral } = d;
    const gpu = forge.gpu;
    const ts = d.tailscale;
    const tsOnline = ts ? ts.online_count : "?";
    const tsTotal = ts ? ts.total : "?";
    const katCd = d.collectd && Object.values(d.collectd).find((c) => c.hostname && c.hostname.includes("katana"));
    tips.katana.stats = [
      ["Role", "Primary Server (Self)"],
      ["IP", "10.0.6.129"],
      ["Status", astral.nodes.katana ? "Online \u2014 Unsheathed" : "OFFLINE"],
      ["Tailscale", `${tsOnline} online / ${tsTotal} total`]
    ];
    if (katCd) {
      if (katCd.load_1 != null) tips.katana.stats.push(["Load", `${katCd.load_1.toFixed(2)} / ${(katCd.load_5 || 0).toFixed(2)} / ${(katCd.load_15 || 0).toFixed(2)}`]);
      if (katCd.disk_pct != null) tips.katana.stats.push(["Disk", `${katCd.disk_pct}% of ${katCd.disk_total_gb} GB`]);
      if (katCd.procs_running) tips.katana.stats.push(["Processes", katCd.procs_running + " running"]);
      if (katCd.uptime) {
        const ud = Math.floor(katCd.uptime / 86400);
        tips.katana.stats.push(["Uptime", ud + "d"]);
      }
    }
    const gkCd = d.collectd && d.collectd["gatekeeper"];
    tips.gatekeeper.stats = [
      ["Role", "OpenWrt Router / Firewall"],
      ["IP", "10.0.6.1"],
      ["WAN Traffic", astral.nft ? fmtBytes(astral.nft.wan) : "N/A"],
      ["LAN Traffic", astral.nft ? fmtBytes(astral.nft.lan) : "N/A"],
      ["Status", astral.nodes.gatekeeper ? "Standing Watch" : "Silent"]
    ];
    if (gkCd) {
      if (gkCd.load_1 != null) tips.gatekeeper.stats.push(["Load", `${gkCd.load_1.toFixed(2)} / ${(gkCd.load_5 || 0).toFixed(2)}`]);
      if (gkCd.mem_pct != null) tips.gatekeeper.stats.push(["Memory", `${gkCd.mem_pct}%`]);
      if (gkCd.temp != null) tips.gatekeeper.stats.push(["Temp", gkCd.temp + "\xB0C"]);
      if (gkCd.conntrack) tips.gatekeeper.stats.push(["Conntrack", gkCd.conntrack.toLocaleString()]);
      if (gkCd.dhcp_leases) tips.gatekeeper.stats.push(["DHCP Leases", gkCd.dhcp_leases]);
      if (gkCd.ping) Object.entries(gkCd.ping).forEach(([t, ms]) => tips.gatekeeper.stats.push(["Ping " + t, ms + " ms"]));
      if (gkCd.uptime) {
        const ud = Math.floor(gkCd.uptime / 86400);
        tips.gatekeeper.stats.push(["Uptime", ud + "d"]);
      }
    }
    tips.oracle.stats = [["Role", "Network Monitor"], ["Hostname", "ubox0"], ["IP", "10.0.6.11"], ["Status", astral.nodes.oracle ? "Pulsing" : "Silent"]];
    tips.forge.stats = [["Usage", forge.usage.toFixed(1) + "%"], ["Temperature", forge.temp != null ? forge.temp.toFixed(0) + "\xB0C" : "N/A"], ["Scale", `${forge.scale >= 0 ? "+" : ""}${forge.scale.toFixed(1)} (${scaleLabel(forge.scale)})`], ["Reading", forge.msg]];
    tips.mana.stats = [["Usage", mana.usage.toFixed(1) + "%"], ["Scale", `${mana.scale >= 0 ? "+" : ""}${mana.scale.toFixed(1)} (${scaleLabel(mana.scale)})`], ["Reading", mana.msg]];
    tips.gpu.stats = gpu ? [["Temperature", gpu.temp.toFixed(0) + "\xB0C"], ["Load", gpu.load.toFixed(0) + "%"]] : [["Status", "No GPU detected"]];
    tips.essence.stats = [["Charge", essence.usage.toFixed(0) + "%"], ["Source", essence.plugged ? "Eternal Source (plugged)" : "Untethered"], ["Scale", `${essence.scale >= 0 ? "+" : ""}${essence.scale.toFixed(1)} (${scaleLabel(essence.scale)})`]];
    tips.wan.stats = [["Total Traversed", astral.nft ? fmtBytes(astral.nft.wan) : "N/A"], ["Direction", "Outward \u2014 to the Outer Darkness"], ["Guarded By", "The Gatekeeper (nftables)"]];
    const _tsKeys = /* @__PURE__ */ new Set(["TS IP", "OS", "Link", "TS Traffic", "Exit Node", "Last Seen", "Key Expiry"]);
    const tsPeers = ts && ts.peers ? ts.peers : {};
    Object.entries(_tsHostMap).forEach(([host, nodeId]) => {
      const p = tsPeers[host];
      if (!tips[nodeId]) return;
      const existing = tips[nodeId].stats.filter((s) => !_tsKeys.has(s[0]));
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
        const days = Math.floor(ago / 864e5);
        tsStats.push(["Last Seen", days > 0 ? days + "d ago" : "recently"]);
      }
      if (p.keyExpiry) {
        const exp = new Date(p.keyExpiry);
        const daysLeft = Math.floor((exp - Date.now()) / 864e5);
        tsStats.push(["Key Expiry", daysLeft > 0 ? daysLeft + "d" : "EXPIRED"]);
      }
      tips[nodeId].stats = [...existing, ...tsStats];
    });
  }
  __name(updateTooltips, "updateTooltips");
  function updateUI(d) {
    lastStatus = d;
    updateGauges(d);
    updateCoreSublabels(d);
    updateInfraNodes(d);
    updateHASublabels(d);
    updateTooltips(d);
    if (Date.now() - _lastReportTs > 6e4) {
      _lastReportTs = Date.now();
      const { forge, mana } = d;
      addLogEntry({
        type: "report",
        node: "katana",
        text: `Forge ${forge.usage.toFixed(0)}% \u2022 Mana ${mana.usage.toFixed(0)}% \u2022 Towers ${DOM.towersOnline.textContent}/${DOM.towersTotal.textContent} \u2022 Scale ${d.realm_scale >= 0 ? "+" : ""}${d.realm_scale.toFixed(1)}`,
        ts: Date.now() / 1e3
      });
    }
    if (d.collectd && DOM.codexCd) DOM.codexCd.textContent = Object.keys(d.collectd).length;
    if (DOM.codexNodes) DOM.codexNodes.textContent = _topology.nodes ? _topology.nodes.length : "?";
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
    clearTimeout(_dbgRefreshTimer);
    _dbgRefreshTimer = setTimeout(_dbgRefresh, 200);
  }
  __name(updateUI, "updateUI");
  var masterScale = 1;
  var masterSlider = document.getElementById("master-scale-slider");
  var masterScaleVal = document.getElementById("master-scale-val");
  function applyMasterScale() {
    nodeScaleSlider.dispatchEvent(new Event("input"));
    textScaleSlider.dispatchEvent(new Event("input"));
    bubbleScaleSlider.dispatchEvent(new Event("input"));
  }
  __name(applyMasterScale, "applyMasterScale");
  masterSlider.addEventListener("input", () => {
    masterScale = parseFloat(masterSlider.value);
    masterScaleVal.textContent = masterScale.toFixed(1) + "x";
    applyMasterScale();
    scheduleSave();
  });
  var trafficScale = 1;
  var trafficSlider = document.getElementById("traffic-scale-slider");
  var trafficScaleVal = document.getElementById("traffic-scale-val");
  trafficSlider.addEventListener("input", () => {
    trafficScale = parseFloat(trafficSlider.value);
    trafficScaleVal.textContent = trafficScale.toFixed(1) + "x";
    if (_sseTrafficMap) updateConnectionTrafficSSE(_sseTrafficMap);
    else if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
    scheduleSave();
  });
  var nodeScale = 1;
  var nodeScaleSlider = document.getElementById("node-scale-slider");
  var nodeScaleVal = document.getElementById("node-scale-val");
  var _nodeScaleRaf = false;
  nodeScaleSlider.addEventListener("input", () => {
    nodeScale = parseFloat(nodeScaleSlider.value) * masterScale;
    nodeScaleVal.textContent = nodeScale.toFixed(1) + "x";
    if (!_nodeScaleRaf) {
      _nodeScaleRaf = true;
      requestAnimationFrame(() => {
        _nodeScaleRaf = false;
        document.querySelectorAll(".realm-node").forEach((node) => {
          node.style.transform = `scale(${nodeScale})`;
        });
        updateLinePositions();
      });
    }
    scheduleSave();
  });
  var textScale = 1;
  var textScaleSlider = document.getElementById("text-scale-slider");
  var textScaleVal = document.getElementById("text-scale-val");
  var _textScaleRaf = false;
  textScaleSlider.addEventListener("input", () => {
    textScale = parseFloat(textScaleSlider.value) * masterScale;
    textScaleVal.textContent = textScale.toFixed(1) + "x";
    if (!_textScaleRaf) {
      _textScaleRaf = true;
      requestAnimationFrame(() => {
        _textScaleRaf = false;
        document.documentElement.style.setProperty("--text-scale", textScale);
        document.querySelectorAll(".node-label").forEach((el) => {
          el.style.transform = `scale(${textScale})`;
        });
        document.querySelectorAll(".node-sublabel").forEach((el) => {
          el.style.transform = `scale(${textScale})`;
        });
        document.querySelectorAll(".vlan-label").forEach((el) => {
          el.style.transform = `translate(-50%, -100%) scale(${textScale})`;
        });
        document.querySelectorAll(".region-label").forEach((el) => {
          el.style.transform = `rotate(${el.dataset.rotate || 0}deg) scale(${textScale})`;
        });
      });
    }
    scheduleSave();
  });
  var bubbleScale = 1;
  var bubbleScaleSlider = document.getElementById("bubble-scale-slider");
  var bubbleScaleVal = document.getElementById("bubble-scale-val");
  bubbleScaleSlider.addEventListener("input", () => {
    bubbleScale = parseFloat(bubbleScaleSlider.value) * masterScale;
    bubbleScaleVal.textContent = bubbleScale.toFixed(1) + "x";
    document.documentElement.style.setProperty("--bubble-scale", bubbleScale);
    scheduleSave();
  });
  var updateSpeedSlider = document.getElementById("update-speed-slider");
  var updateSpeedVal = document.getElementById("update-speed-val");
  var connColors = {
    "conn-active": [100, 180, 255],
    "conn-ap": [100, 180, 255],
    "conn-wan": [255, 180, 50],
    "conn-infra": [96, 160, 192],
    "conn-bridge": [160, 100, 220],
    "conn-vlan": [255, 160, 60],
    "conn-mesh": [120, 220, 120]
  };
  var vlanColors = {
    "6": [140, 180, 255],
    "8": [255, 200, 100],
    "10": [100, 220, 160],
    "11": [200, 140, 255],
    "0": [100, 220, 220]
  };
  function getNodeTraffic(collectd, nodeKey) {
    if (!collectd) return null;
    const key = nodeKey.toLowerCase();
    let cd = collectd[nodeKey];
    if (!cd) {
      for (const [k, v] of Object.entries(collectd)) {
        if (k.toLowerCase().split(".")[0] === key) {
          cd = v;
          break;
        }
      }
    }
    if (!cd) {
      cd = Object.values(collectd).find((c) => c.hostname && c.hostname.toLowerCase().replace(/[-_]/g, "") === key.replace(/[-_]/g, ""));
    }
    if (!cd || !cd.interfaces) return null;
    let bestRx = 0, bestTx = 0, bestTotal = 0;
    Object.values(cd.interfaces).forEach((iface) => {
      const rx = iface.rx_bps || 0;
      const tx = iface.tx_bps || 0;
      if (rx + tx > bestTotal) {
        bestRx = rx;
        bestTx = tx;
        bestTotal = rx + tx;
      }
    });
    return bestTotal > 0 ? { rx: bestRx, tx: bestTx, total: bestTotal } : null;
  }
  __name(getNodeTraffic, "getNodeTraffic");
  var _connLinesWithData = _connPaths.filter((p) => p && p.dataset.to);
  var _connBaseWidths = /* @__PURE__ */ new Map();
  var _connCache = /* @__PURE__ */ new WeakMap();
  _connPaths.forEach((path) => {
    if (!path) return;
    const cs = getComputedStyle(path);
    _connBaseWidths.set(path, parseFloat(cs.getPropertyValue("--sw")) || 1.5);
    const connType = Array.from(path.classList).find((c) => connColors[c]);
    _connCache.set(path, { connType, sw: 0, speed: 0, dir: "", tier: "", stroke: "", animated: false });
  });
  var TOP_GLOW_COUNT = 5;
  function updateConnectionTraffic(collectd) {
    if (!collectd) return;
    const trafficData = [];
    _connLinesWithData.forEach((line) => {
      const cache = _connCache.get(line) || { connType: null, sw: 0, speed: 0, dir: "", tier: "", stroke: "", animated: false, glow: false };
      const toNode = line.dataset.to;
      const fromNode = line.dataset.from;
      const toTraffic = getNodeTraffic(collectd, toNode);
      const fromTraffic = fromNode ? getNodeTraffic(collectd, fromNode) : null;
      const traffic = toTraffic && fromTraffic ? toTraffic.total > fromTraffic.total ? toTraffic : fromTraffic : toTraffic || fromTraffic;
      const baseW = _connBaseWidths.get(line) || 1.5;
      if (!traffic || traffic.total === 0) {
        if (cache.tier || cache.sw !== baseW || cache.animated || cache.glow) {
          line.style.setProperty("--sw", baseW);
          line.style.removeProperty("--speed");
          line.style.removeProperty("--dir");
          line.removeAttribute("stroke");
          if (cache.tier) line.classList.remove(cache.tier);
          if (cache.animated) {
            line.classList.remove("conn-animated");
            cache.animated = false;
          }
          if (cache.glow) {
            line.classList.remove("conn-glow");
            cache.glow = false;
          }
          cache.sw = baseW;
          cache.speed = 0;
          cache.dir = "";
          cache.tier = "";
          cache.stroke = "";
        }
        return;
      }
      if (!cache.animated) {
        line.classList.add("conn-animated");
        cache.animated = true;
      }
      const rawIntensity = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
      const intensity = Math.min(1, rawIntensity * trafficScale);
      const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
      const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
      const dir = traffic.rx > traffic.tx ? "reverse" : "normal";
      const tier = intensity > 0.65 ? "conn-traffic-high" : intensity > 0.35 ? "conn-traffic-med" : intensity > 0.15 ? "conn-traffic-low" : "";
      if (sw !== cache.sw) {
        line.style.setProperty("--sw", sw);
        cache.sw = sw;
      }
      if (speed !== cache.speed) {
        line.style.setProperty("--speed", speed + "s");
        cache.speed = speed;
      }
      if (dir !== cache.dir) {
        line.style.setProperty("--dir", dir);
        cache.dir = dir;
      }
      if (cache.connType) {
        const vlan = line.dataset.vlan;
        const [r, g, b] = vlan && vlanColors[vlan] || connColors[cache.connType] || [100, 180, 255];
        const alpha = +(0.15 + intensity * 0.5).toFixed(2);
        const bright = 1 + intensity * 0.3;
        const stroke = `rgba(${Math.min(255, r * bright) | 0},${Math.min(255, g * bright) | 0},${Math.min(255, b * bright) | 0},${alpha})`;
        if (stroke !== cache.stroke) {
          line.setAttribute("stroke", stroke);
          cache.stroke = stroke;
        }
      }
      if (tier !== cache.tier) {
        if (cache.tier) line.classList.remove(cache.tier);
        if (tier) line.classList.add(tier);
        cache.tier = tier;
      }
      if (intensity > 0.3) trafficData.push({ line, cache, intensity });
    });
    trafficData.sort((a, b) => b.intensity - a.intensity);
    const topLines = new Set(trafficData.slice(0, TOP_GLOW_COUNT).map((d) => d.line));
    trafficData.forEach(({ line, cache }) => {
      const shouldGlow = topLines.has(line);
      if (shouldGlow !== cache.glow) {
        if (shouldGlow) line.classList.add("conn-glow");
        else line.classList.remove("conn-glow");
        cache.glow = shouldGlow;
      }
    });
    for (const tipKey of Object.keys(_nodeDOM)) {
      const n = _nodeDOM[tipKey];
      if (!n.el) continue;
      const icon = n._icon || (n._icon = n.el.querySelector(".node-icon"));
      if (!icon) continue;
      const traffic = getNodeTraffic(collectd, tipKey);
      if (!traffic || traffic.total === 0) {
        if (n._lastTrafficScale) {
          icon.style.transform = "";
          icon.style.filter = "";
          n._lastTrafficScale = 0;
        }
        continue;
      }
      const rawI = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
      const intensity = Math.min(1, rawI * trafficScale);
      const s = 1 + intensity * 0.5;
      if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
        icon.style.transform = `scale(${s.toFixed(2)})`;
        icon.style.filter = intensity > 0.3 ? `brightness(${(1 + intensity * 0.4).toFixed(2)})` : "";
        n._lastTrafficScale = s;
      }
    }
  }
  __name(updateConnectionTraffic, "updateConnectionTraffic");
  function updateConnectionTrafficSSE(trafficMap) {
    if (!trafficMap) return;
    const trafficData = [];
    _connLinesWithData.forEach((line) => {
      const cache = _connCache.get(line) || { connType: null, sw: 0, speed: 0, dir: "", tier: "", stroke: "", animated: false, glow: false };
      const toNode = line.dataset.to;
      const fromNode = line.dataset.from;
      const toT = trafficMap[toNode];
      const fromT = fromNode ? trafficMap[fromNode] : null;
      const traffic = toT && fromT ? toT.total > fromT.total ? toT : fromT : toT || fromT;
      const baseW = _connBaseWidths.get(line) || 1.5;
      if (!traffic || traffic.total === 0) {
        if (cache.tier || cache.sw !== baseW || cache.animated || cache.glow) {
          line.style.setProperty("--sw", baseW);
          line.style.removeProperty("--speed");
          line.style.removeProperty("--dir");
          line.removeAttribute("stroke");
          if (cache.tier) line.classList.remove(cache.tier);
          if (cache.animated) {
            line.classList.remove("conn-animated");
            cache.animated = false;
          }
          if (cache.glow) {
            line.classList.remove("conn-glow");
            cache.glow = false;
          }
          cache.sw = baseW;
          cache.speed = 0;
          cache.dir = "";
          cache.tier = "";
          cache.stroke = "";
        }
        return;
      }
      if (!cache.animated) {
        line.classList.add("conn-animated");
        cache.animated = true;
      }
      const intensity = Math.min(1, traffic.intensity * trafficScale);
      const sw = +(baseW + intensity * 8 * trafficScale).toFixed(1);
      const speed = +Math.max(2, 20 - intensity * 18).toFixed(1);
      const dir = traffic.rx > traffic.tx ? "reverse" : "normal";
      const tier = intensity > 0.65 ? "conn-traffic-high" : intensity > 0.35 ? "conn-traffic-med" : intensity > 0.15 ? "conn-traffic-low" : "";
      if (sw !== cache.sw) {
        line.style.setProperty("--sw", sw);
        cache.sw = sw;
      }
      if (speed !== cache.speed) {
        line.style.setProperty("--speed", speed + "s");
        cache.speed = speed;
      }
      if (dir !== cache.dir) {
        line.style.setProperty("--dir", dir);
        cache.dir = dir;
      }
      if (cache.connType) {
        const vlan = line.dataset.vlan;
        const [r, g, b] = vlan && vlanColors[vlan] || connColors[cache.connType] || [100, 180, 255];
        const alpha = +(0.15 + intensity * 0.5).toFixed(2);
        const bright = 1 + intensity * 0.3;
        const stroke = `rgba(${Math.min(255, r * bright) | 0},${Math.min(255, g * bright) | 0},${Math.min(255, b * bright) | 0},${alpha})`;
        if (stroke !== cache.stroke) {
          line.setAttribute("stroke", stroke);
          cache.stroke = stroke;
        }
      }
      if (tier !== cache.tier) {
        if (cache.tier) line.classList.remove(cache.tier);
        if (tier) line.classList.add(tier);
        cache.tier = tier;
      }
      if (intensity > 0.3) trafficData.push({ line, cache, intensity });
    });
    trafficData.sort((a, b) => b.intensity - a.intensity);
    const topLines = new Set(trafficData.slice(0, TOP_GLOW_COUNT).map((d) => d.line));
    trafficData.forEach(({ line, cache }) => {
      const shouldGlow = topLines.has(line);
      if (shouldGlow !== cache.glow) {
        if (shouldGlow) line.classList.add("conn-glow");
        else line.classList.remove("conn-glow");
        cache.glow = shouldGlow;
      }
    });
    for (const tipKey of Object.keys(_nodeDOM)) {
      const n = _nodeDOM[tipKey];
      if (!n.el) continue;
      const icon = n._icon || (n._icon = n.el.querySelector(".node-icon"));
      if (!icon) continue;
      const t = trafficMap[tipKey];
      if (!t || t.total === 0) {
        if (n._lastTrafficScale) {
          icon.style.transform = "";
          icon.style.filter = "";
          n._lastTrafficScale = 0;
        }
        continue;
      }
      const intensity = Math.min(1, t.intensity * trafficScale);
      const s = 1 + intensity * 0.5;
      if (Math.abs(s - (n._lastTrafficScale || 1)) > 0.01) {
        icon.style.transform = `scale(${s.toFixed(2)})`;
        icon.style.filter = intensity > 0.3 ? `brightness(${(1 + intensity * 0.4).toFixed(2)})` : "";
        n._lastTrafficScale = s;
      }
    }
  }
  __name(updateConnectionTrafficSSE, "updateConnectionTrafficSSE");
  function _trafficToCollectd(trafficMap) {
    const fake = {};
    for (const [nodeId, t] of Object.entries(trafficMap)) {
      fake[nodeId] = { hostname: nodeId, interfaces: { best: { rx_bps: t.rx, tx_bps: t.tx } } };
    }
    return fake;
  }
  __name(_trafficToCollectd, "_trafficToCollectd");
  var _topoSvg = document.getElementById("topo-svg");
  var _topoEnabled = true;
  var _topoOpacity = 0.6;
  var _topoSpread = 120;
  var _topoContours = 12;
  var _topoRiverWidth = 0.4;
  var _topoRiverDepth = 0.6;
  var _lastTopoCollectd = null;
  var _topoRafId = 0;
  var _topoHash = "";
  var _topoWorkerBusy = false;
  var _topoLastDispatch = 0;
  var _TOPO_MIN_INTERVAL = 3e4;
  var _TOPO_DEFS = `<defs>
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
  var _topoNodeMap = null;
  function _getTopoNodeMap() {
    if (_topoNodeMap) return _topoNodeMap;
    _topoNodeMap = /* @__PURE__ */ new Map();
    for (const n of _topology.nodes) _topoNodeMap.set(n.id, n);
    return _topoNodeMap;
  }
  __name(_getTopoNodeMap, "_getTopoNodeMap");
  var _TOPO_PAD = 50;
  var _TOPO_SX = 10;
  var _TOPO_SY = 10;
  var _TOPO_W = Math.ceil(WORLD_W / _TOPO_SX) + _TOPO_PAD * 2;
  var _TOPO_H = Math.ceil(WORLD_H / _TOPO_SY) + _TOPO_PAD * 2;
  var _topoWorker = new Worker("topo-worker.js");
  _topoWorker.onmessage = function(e) {
    _topoWorkerBusy = false;
    const { hash, bands } = e.data;
    if (!bands || bands.length === 0) return;
    if (hash === _topoHash) return;
    _topoHash = hash;
    const VB = "-500 -500 5800 4300";
    const fragment = document.createDocumentFragment();
    let first = true;
    for (const b of bands) {
      let inner = "";
      if (first) {
        inner += _TOPO_DEFS;
        first = false;
      }
      if (b.halo && b.fillOp > 0) {
        inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="25" opacity="${b.fillOp}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      const filterAttr = b.useFilter ? ' class="topo-idx"' : "";
      inner += `<path d="${b.pathD}" fill="none" stroke="${b.col}" stroke-width="${b.sw}" opacity="${b.op}" stroke-linecap="round"${filterAttr}/>`;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", VB);
      svg.setAttribute("class", "topo-band");
      svg.dataset.elev = b.elev.toFixed(3);
      svg.innerHTML = inner;
      fragment.appendChild(svg);
    }
    _topoSvg.innerHTML = "";
    _topoSvg.appendChild(fragment);
    if (_mapTilt > 0) _applyTopoZ();
  };
  function renderTopoLayer(collectd) {
    if (!_topoSvg || !_topoEnabled || !_topology.nodes) return;
    if (_topoWorkerBusy) return;
    const now = Date.now();
    if (now - _topoLastDispatch < _TOPO_MIN_INTERVAL) return;
    _topoWorkerBusy = true;
    _topoLastDispatch = now;
    const nodes = _topology.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      type: n.type,
      iconStyle: n.iconStyle ? { width: n.iconStyle.width, height: n.iconStyle.height } : null
    }));
    const connections = (_topology.connections || []).map((c) => ({ from: c.from, to: c.to }));
    _topoWorker.postMessage({
      nodes,
      connections,
      collectd: collectd || {},
      settings: { spread: _topoSpread, contours: _topoContours, riverWidth: _topoRiverWidth, riverDepth: _topoRiverDepth },
      grid: { W: _TOPO_W, H: _TOPO_H, sx: _TOPO_SX, sy: _TOPO_SY, pad: _TOPO_PAD },
      perfTier: _perfTier
    });
  }
  __name(renderTopoLayer, "renderTopoLayer");
  function _topoForceRender() {
    _topoLastDispatch = 0;
    _topoHash = "";
    renderTopoLayer(_lastTopoCollectd);
  }
  __name(_topoForceRender, "_topoForceRender");
  (/* @__PURE__ */ __name((function initTopoControls() {
    const toggle = document.getElementById("topo-toggle-cb");
    const opSlider = document.getElementById("topo-opacity-slider");
    const opVal = document.getElementById("topo-opacity-val");
    const spSlider = document.getElementById("topo-spread-slider");
    const spVal = document.getElementById("topo-spread-val");
    const cnSlider = document.getElementById("topo-contour-slider");
    const cnVal = document.getElementById("topo-contour-val");
    if (!toggle || !_topoSvg) return;
    _topoSvg.style.setProperty("--topo-opacity", _topoOpacity);
    function scheduleRender() {
      cancelAnimationFrame(_topoRafId);
      _topoRafId = requestAnimationFrame(() => _topoForceRender());
    }
    __name(scheduleRender, "scheduleRender");
    toggle.addEventListener("change", () => {
      _topoEnabled = toggle.checked;
      _topoSvg.classList.toggle("active", _topoEnabled);
      if (_topoEnabled) scheduleRender();
      saveSettings();
    });
    opSlider.addEventListener("input", () => {
      _topoOpacity = parseFloat(opSlider.value);
      opVal.textContent = _topoOpacity.toFixed(2);
      _topoSvg.style.setProperty("--topo-opacity", _topoOpacity);
      scheduleSave();
    });
    spSlider.addEventListener("input", () => {
      _topoSpread = parseInt(spSlider.value);
      spVal.textContent = _topoSpread;
      if (_topoEnabled) scheduleRender();
      scheduleSave();
    });
    cnSlider.addEventListener("input", () => {
      _topoContours = parseInt(cnSlider.value);
      cnVal.textContent = _topoContours;
      if (_topoEnabled) scheduleRender();
      scheduleSave();
    });
    const rwSlider = document.getElementById("topo-rw-slider");
    const rwVal = document.getElementById("topo-rw-val");
    const rdSlider = document.getElementById("topo-rd-slider");
    const rdVal = document.getElementById("topo-rd-val");
    if (rwSlider) rwSlider.addEventListener("input", () => {
      _topoRiverWidth = parseFloat(rwSlider.value);
      rwVal.textContent = _topoRiverWidth.toFixed(2);
      if (_topoEnabled) scheduleRender();
      scheduleSave();
    });
    if (rdSlider) rdSlider.addEventListener("input", () => {
      _topoRiverDepth = parseFloat(rdSlider.value);
      rdVal.textContent = _topoRiverDepth.toFixed(2);
      if (_topoEnabled) scheduleRender();
      scheduleSave();
    });
    if (_topoEnabled && _topology.nodes) renderTopoLayer(null);
  }), "initTopoControls"))();
  var _gridSvg = document.getElementById("arcane-grid");
  var _gridContent = document.getElementById("arcane-grid-content");
  var _gridEnabled = false;
  var _gridOpacity = 0.4;
  var _gridScale = 1;
  var _gridPulse = true;
  var _gridHue = 0;
  (/* @__PURE__ */ __name((function initGridControls() {
    const toggle = document.getElementById("grid-toggle-cb");
    const visToggle = document.getElementById("vis-grid");
    const opSlider = document.getElementById("grid-opacity-slider");
    const opVal = document.getElementById("grid-opacity-val");
    const scSlider = document.getElementById("grid-scale-slider");
    const scVal = document.getElementById("grid-scale-val");
    const pulseToggle = document.getElementById("grid-pulse-cb");
    const pulseVal = document.getElementById("grid-pulse-val");
    const hueSlider = document.getElementById("grid-hue-slider");
    const hueVal = document.getElementById("grid-hue-val");
    const layerSlider = document.getElementById("layer-grid-slider");
    if (!_gridSvg) return;
    function applyGridStyle() {
      _gridSvg.style.setProperty("--grid-opacity", _gridOpacity);
      _gridSvg.style.setProperty("--grid-scale", _gridScale);
      _gridSvg.style.filter = _gridHue ? `hue-rotate(${_gridHue}deg)` : "";
      _gridSvg.style.animationPlayState = _gridPulse ? "running" : "paused";
      _gridSvg.classList.toggle("active", _gridEnabled);
    }
    __name(applyGridStyle, "applyGridStyle");
    function syncToggles() {
      if (toggle) toggle.checked = _gridEnabled;
      if (visToggle) visToggle.checked = _gridEnabled;
    }
    __name(syncToggles, "syncToggles");
    if (toggle) toggle.addEventListener("change", () => {
      _gridEnabled = toggle.checked;
      syncToggles();
      applyGridStyle();
      saveSettings();
    });
    if (visToggle) visToggle.addEventListener("change", () => {
      _gridEnabled = visToggle.checked;
      syncToggles();
      applyGridStyle();
      saveSettings();
    });
    if (opSlider) opSlider.addEventListener("input", () => {
      _gridOpacity = parseFloat(opSlider.value);
      if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
      if (layerSlider) layerSlider.value = _gridOpacity;
      applyGridStyle();
      scheduleSave();
    });
    if (layerSlider) layerSlider.addEventListener("input", () => {
      _gridOpacity = parseFloat(layerSlider.value);
      if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
      if (opSlider) opSlider.value = _gridOpacity;
      applyGridStyle();
      scheduleSave();
    });
    if (scSlider) scSlider.addEventListener("input", () => {
      _gridScale = parseFloat(scSlider.value);
      if (scVal) scVal.textContent = _gridScale.toFixed(1);
      applyGridStyle();
      scheduleSave();
    });
    if (pulseToggle) pulseToggle.addEventListener("change", () => {
      _gridPulse = pulseToggle.checked;
      if (pulseVal) pulseVal.textContent = _gridPulse ? "on" : "off";
      applyGridStyle();
      scheduleSave();
    });
    if (hueSlider) hueSlider.addEventListener("input", () => {
      _gridHue = parseInt(hueSlider.value);
      if (hueVal) hueVal.textContent = _gridHue + "\xB0";
      applyGridStyle();
      scheduleSave();
    });
    window._gridControls = {
      applyGridStyle,
      syncToggles,
      getState: /* @__PURE__ */ __name(() => ({ enabled: _gridEnabled, opacity: _gridOpacity, scale: _gridScale, pulse: _gridPulse, hue: _gridHue }), "getState"),
      setState: /* @__PURE__ */ __name((s) => {
        if (s.enabled !== void 0) _gridEnabled = s.enabled;
        if (s.opacity !== void 0) _gridOpacity = s.opacity;
        if (s.scale !== void 0) _gridScale = s.scale;
        if (s.pulse !== void 0) _gridPulse = s.pulse;
        if (s.hue !== void 0) _gridHue = s.hue;
        if (opSlider) opSlider.value = _gridOpacity;
        if (opVal) opVal.textContent = _gridOpacity.toFixed(2);
        if (layerSlider) layerSlider.value = _gridOpacity;
        if (scSlider) scSlider.value = _gridScale;
        if (scVal) scVal.textContent = _gridScale.toFixed(1);
        if (pulseToggle) pulseToggle.checked = _gridPulse;
        if (pulseVal) pulseVal.textContent = _gridPulse ? "on" : "off";
        if (hueSlider) hueSlider.value = _gridHue;
        if (hueVal) hueVal.textContent = _gridHue + "\xB0";
        syncToggles();
        applyGridStyle();
      }, "setState")
    };
    applyGridStyle();
  }), "initGridControls"))();
  (/* @__PURE__ */ __name((function initAmbianceControls() {
    const compassEl = document.getElementById("compass-rose");
    const sparkleLayer = document.getElementById("sparkle-layer");
    const vignetteEl = document.getElementById("map-vignette");
    const mapWorld = document.getElementById("map-world");
    let compassEnabled = true, compassOpacity = 0.7, compassScale = 1;
    let sparklesEnabled = true, sparkleOpacity = 0.7, sparkleDensity = 0.5;
    let vignetteEnabled = true, vignetteOpacity = 0.3;
    let ambientGlow = 0.3;
    let sparkleTimer = null;
    function applyCompass() {
      if (compassEl) {
        compassEl.style.display = compassEnabled ? "" : "none";
        compassEl.style.setProperty("--compass-opacity", compassOpacity);
        compassEl.style.opacity = compassOpacity;
        compassEl.style.transform = `scale(${compassScale})`;
      }
    }
    __name(applyCompass, "applyCompass");
    function applySparkles() {
      if (sparkleLayer) {
        sparkleLayer.style.display = sparklesEnabled ? "" : "none";
        sparkleLayer.style.opacity = sparkleOpacity;
      }
      if (sparkleTimer) {
        clearInterval(sparkleTimer);
        sparkleTimer = null;
      }
      if (sparklesEnabled && sparkleDensity > 0 && sparkleLayer) {
        const ms = Math.max(80, 600 / sparkleDensity);
        sparkleTimer = setInterval(spawnSparkle, ms);
      }
    }
    __name(applySparkles, "applySparkles");
    function spawnSparkle() {
      if (!sparkleLayer) return;
      if (sparkleLayer.children.length > 30) return;
      const el = document.createElement("div");
      const isLarge = Math.random() < 0.15;
      el.className = isLarge ? "sparkle sparkle-large" : "sparkle";
      el.style.left = Math.random() * 4800 + "px";
      el.style.top = Math.random() * 3300 + "px";
      const dur = 2 + Math.random() * 4;
      const size = isLarge ? 4 + Math.random() * 4 : 2 + Math.random() * 3;
      el.style.setProperty("--sparkle-dur", dur + "s");
      el.style.width = size + "px";
      el.style.height = size + "px";
      sparkleLayer.appendChild(el);
      el.addEventListener("animationend", () => el.remove());
    }
    __name(spawnSparkle, "spawnSparkle");
    function applyVignette() {
      if (vignetteEl) {
        vignetteEl.style.display = vignetteEnabled ? "" : "none";
        vignetteEl.style.opacity = vignetteOpacity;
      }
    }
    __name(applyVignette, "applyVignette");
    function applyGlow() {
      if (mapWorld) mapWorld.style.setProperty("--ambient-glow", ambientGlow);
    }
    __name(applyGlow, "applyGlow");
    const visCb = { compass: "vis-compass", sparkles: "vis-sparkles", vignette: "vis-vignette" };
    const layerSl = { compass: "layer-compass-slider", sparkles: "layer-sparkles-slider", vignette: "layer-vignette-slider" };
    const compassCb = document.getElementById(visCb.compass);
    if (compassCb) compassCb.addEventListener("change", () => {
      compassEnabled = compassCb.checked;
      applyCompass();
      scheduleSave();
    });
    const compassLayerSl = document.getElementById(layerSl.compass);
    if (compassLayerSl) compassLayerSl.addEventListener("input", () => {
      compassOpacity = parseFloat(compassLayerSl.value);
      applyCompass();
      scheduleSave();
    });
    const sparklesCb = document.getElementById(visCb.sparkles);
    if (sparklesCb) sparklesCb.addEventListener("change", () => {
      sparklesEnabled = sparklesCb.checked;
      applySparkles();
      scheduleSave();
    });
    const sparklesLayerSl = document.getElementById(layerSl.sparkles);
    if (sparklesLayerSl) sparklesLayerSl.addEventListener("input", () => {
      sparkleOpacity = parseFloat(sparklesLayerSl.value);
      applySparkles();
      scheduleSave();
    });
    const vignetteCb = document.getElementById(visCb.vignette);
    if (vignetteCb) vignetteCb.addEventListener("change", () => {
      vignetteEnabled = vignetteCb.checked;
      applyVignette();
      scheduleSave();
    });
    const vignetteLayerSl = document.getElementById(layerSl.vignette);
    if (vignetteLayerSl) vignetteLayerSl.addEventListener("input", () => {
      vignetteOpacity = parseFloat(vignetteLayerSl.value);
      applyVignette();
      scheduleSave();
    });
    const compassScaleSl = document.getElementById("compass-scale-slider");
    const compassScaleVal = document.getElementById("compass-scale-val");
    if (compassScaleSl) compassScaleSl.addEventListener("input", () => {
      compassScale = parseFloat(compassScaleSl.value);
      if (compassScaleVal) compassScaleVal.textContent = compassScale.toFixed(1);
      applyCompass();
      scheduleSave();
    });
    const sparkleDensitySl = document.getElementById("sparkle-density-slider");
    const sparkleDensityVal = document.getElementById("sparkle-density-val");
    if (sparkleDensitySl) sparkleDensitySl.addEventListener("input", () => {
      sparkleDensity = parseFloat(sparkleDensitySl.value);
      if (sparkleDensityVal) sparkleDensityVal.textContent = sparkleDensity.toFixed(2);
      applySparkles();
      scheduleSave();
    });
    const ambientGlowSl = document.getElementById("ambient-glow-slider");
    const ambientGlowVal = document.getElementById("ambient-glow-val");
    if (ambientGlowSl) ambientGlowSl.addEventListener("input", () => {
      ambientGlow = parseFloat(ambientGlowSl.value);
      if (ambientGlowVal) ambientGlowVal.textContent = ambientGlow.toFixed(2);
      applyGlow();
      scheduleSave();
    });
    const vignetteSl = document.getElementById("vignette-slider");
    const vignetteValEl = document.getElementById("vignette-val");
    if (vignetteSl) vignetteSl.addEventListener("input", () => {
      vignetteOpacity = parseFloat(vignetteSl.value);
      if (vignetteLayerSl) vignetteLayerSl.value = vignetteOpacity;
      if (vignetteValEl) vignetteValEl.textContent = vignetteOpacity.toFixed(2);
      applyVignette();
      scheduleSave();
    });
    window._ambianceControls = {
      getState: /* @__PURE__ */ __name(() => ({
        compass: compassEnabled,
        compassOp: compassOpacity,
        compassSc: compassScale,
        sparkles: sparklesEnabled,
        sparkleOp: sparkleOpacity,
        sparkleDen: sparkleDensity,
        vignette: vignetteEnabled,
        vignetteOp: vignetteOpacity,
        glow: ambientGlow
      }), "getState"),
      setState: /* @__PURE__ */ __name((s) => {
        if (s.compass !== void 0) compassEnabled = s.compass;
        if (s.compassOp !== void 0) compassOpacity = s.compassOp;
        if (s.compassSc !== void 0) compassScale = s.compassSc;
        if (s.sparkles !== void 0) sparklesEnabled = s.sparkles;
        if (s.sparkleOp !== void 0) sparkleOpacity = s.sparkleOp;
        if (s.sparkleDen !== void 0) sparkleDensity = s.sparkleDen;
        if (s.vignette !== void 0) vignetteEnabled = s.vignette;
        if (s.vignetteOp !== void 0) vignetteOpacity = s.vignetteOp;
        if (s.glow !== void 0) ambientGlow = s.glow;
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
        applyCompass();
        applySparkles();
        applyVignette();
        applyGlow();
      }, "setState")
    };
    applyCompass();
    applySparkles();
    applyVignette();
    applyGlow();
  }), "initAmbianceControls"))();
  var lastEventTs = 0;
  var _pageLoadTs = Date.now() / 1e3;
  var BUBBLE_RESTORE_AGE = 600;
  function renderEvent(evt, isRestore = false) {
    lastEventTs = Math.max(lastEventTs, evt.ts || 0);
    const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);
    addLogEntry(evt, nodeEl);
    if (evt.text && _dismissedQuests.includes(evt.text)) return;
    const evtAge = _pageLoadTs - (evt.ts || 0);
    const isStale = evtAge > 30 && !evt._local;
    if (!nodeEl) return;
    let showBubble = false;
    const isPersistent = ["quest", "alert", "oracle_query", "oracle_response"].includes(evt.type);
    if (isRestore) {
      showBubble = isPersistent || evtAge < BUBBLE_RESTORE_AGE;
    } else if (!isStale) {
      showBubble = true;
    }
    if (!showBubble) return;
    if (evt.type === "speech") {
      showSpeechBubble(nodeEl, evt);
      if (!isRestore) showHighlight(nodeEl, { color: evt.color || "rgba(160,200,255,0.4)" });
    } else if (evt.type === "highlight") {
      if (!isRestore) showHighlight(nodeEl, evt);
    } else if (evt.type === "alert") {
      showSpeechBubble(nodeEl, evt, true);
      if (!isRestore) showHighlight(nodeEl, { color: "rgba(255,80,60,0.6)" });
    } else if (evt.type === "quest") {
      showSpeechBubble(nodeEl, evt);
      if (!isRestore) showHighlight(nodeEl, { color: "rgba(192,144,255,0.5)" });
      _refreshQuestCards();
    } else if (evt.type === "oracle_query") {
      showSpeechBubble(nodeEl, { ...evt, text: "\u2728 " + evt.text, color: "#c080ff" });
      if (!isRestore) showHighlight(nodeEl, { color: "rgba(192,128,255,0.6)" });
    } else if (evt.type === "oracle_response") {
      showSpeechBubble(nodeEl, { ...evt, color: evt.color || "#e0b0ff" });
      if (!isRestore) showHighlight(nodeEl, { color: "rgba(192,128,255,0.4)" });
    }
  }
  __name(renderEvent, "renderEvent");
  var logCount = 0;
  var MAX_LOG = 80;
  var activeTab = "all";
  var _questCards = document.createElement("div");
  _questCards.className = "quest-cards";
  _questCards.style.display = "none";
  var _logBodyEl = document.getElementById("quest-log-body");
  if (_logBodyEl) _logBodyEl.parentNode.insertBefore(_questCards, _logBodyEl);
  document.querySelectorAll(".log-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".log-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeTab = tab.dataset.tab;
      _questCards.style.display = activeTab === "quest" ? "" : "none";
      if (_logBodyEl) _logBodyEl.style.display = activeTab === "quest" ? "none" : "";
      document.querySelectorAll(".log-entry").forEach((entry) => {
        if (activeTab === "quest") {
          entry.style.display = "none";
        } else if (activeTab === "all") {
          entry.style.display = "";
        } else if (activeTab === "notion") {
          entry.style.display = entry.classList.contains("notion-quest") ? "" : "none";
        } else {
          entry.style.display = entry.classList.contains("log-" + activeTab) ? "" : "none";
        }
      });
    });
  });
  document.querySelectorAll(".codex-toggle").forEach((h4) => {
    h4.addEventListener("click", () => {
      const target = document.getElementById(h4.dataset.target);
      if (!target) return;
      h4.classList.toggle("open");
      target.classList.toggle("open");
    });
  });
  fetch("/personas").then((r) => r.json()).then((personas) => {
    const el = document.querySelector(".codex-persona-list");
    if (!el) return;
    const icons = {
      katana: "\u2694",
      gatekeeper: "\u26E9",
      oracle: "\u{1F52E}",
      forge: "\u{1F525}",
      mana: "\u{1F4A7}",
      crystal: "\u{1F48E}",
      "hp-switch": "\u2699",
      ha: "\u{1F3E0}",
      "notion-portal": "\u2728",
      "tab-s5e": "\u{1F4F1}"
    };
    el.innerHTML = Object.entries(personas).map(
      ([k, p]) => `<div class="codex-persona"><span class="cp-icon">${icons[k] || "\u2B50"}</span><div><div class="cp-name">${p.name || k} &mdash; ${p.title || ""}</div><div class="cp-voice">${(p.voice || "").replace("en-US-", "").replace("Neural", "")} &bull; ${(p.hints || []).slice(0, 2).join(", ")}</div></div></div>`
    ).join("");
  }).catch(() => {
  });
  var _sectionIcons = { Lore: "\u{1F4DC}", Architecture: "\u2699\uFE0F", Guide: "\u{1F4D6}", Reference: "\u{1F4CB}" };
  var _sectionColors = { Lore: "#b090d0", Architecture: "#70a0d0", Guide: "#70c080", Reference: "#a0a0a0" };
  var _sectionOrder = ["Lore", "Architecture", "Guide", "Reference"];
  function renderCodexNotion(data) {
    const container = document.getElementById("codex-notion-sections");
    if (!container) return;
    let html = "";
    for (const sec of _sectionOrder) {
      const entries = data[sec];
      if (!entries || !entries.length) continue;
      const id = "codex-notion-" + sec.toLowerCase();
      const color = _sectionColors[sec] || "#b0a080";
      html += `<div class="codex-section">`;
      html += `<h4 class="codex-toggle" data-target="${id}" style="color:${color}">${_sectionIcons[sec] || ""} ${sec} <span class="codex-tool-count">${entries.length}</span></h4>`;
      html += `<div id="${id}" class="codex-tools">`;
      for (const e of entries) {
        html += `<div class="codex-notion-entry">`;
        html += `<div class="cne-header">${e.icon || ""} <span class="cne-name">${e.name}</span></div>`;
        html += `<div class="cne-body">${e.body || ""}</div>`;
        html += `</div>`;
      }
      html += `</div></div>`;
    }
    container.innerHTML = html;
    container.querySelectorAll(".codex-toggle").forEach((h4) => {
      h4.addEventListener("click", () => {
        const target = document.getElementById(h4.dataset.target);
        if (!target) return;
        h4.classList.toggle("open");
        target.classList.toggle("open");
      });
    });
  }
  __name(renderCodexNotion, "renderCodexNotion");
  fetch("/codex-sync").then((r) => r.json()).then(renderCodexNotion).catch(() => {
  });
  var _logBody = document.getElementById("quest-log-body");
  var _logCounter = document.getElementById("log-count");
  var _syncBtn = document.getElementById("notion-sync-btn");
  if (_syncBtn) {
    _syncBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (_syncBtn.classList.contains("syncing")) return;
      _syncBtn.classList.add("syncing");
      _syncBtn.textContent = "\u231B Syncing...";
      try {
        const r = await fetch("/notion-sync");
        const data = await r.json();
        if (data.error) {
          _syncBtn.textContent = "\u26A0 " + data.error.substring(0, 30);
          setTimeout(() => {
            _syncBtn.innerHTML = "&#127744; Sync Portal";
            _syncBtn.classList.remove("syncing");
          }, 3e3);
          return;
        }
        _syncBtn.innerHTML = `\u2714 ${data.new || 0} new`;
        setTimeout(() => {
          _syncBtn.innerHTML = "&#127744; Sync Portal";
          _syncBtn.classList.remove("syncing");
        }, 2e3);
      } catch (err) {
        _syncBtn.textContent = "\u26A0 Offline";
        setTimeout(() => {
          _syncBtn.innerHTML = "&#127744; Sync Portal";
          _syncBtn.classList.remove("syncing");
        }, 3e3);
      }
    });
  }
  function addLogEntry(evt, nodeEl) {
    if (!_logBody) return;
    const body = _logBody, counter = _logCounter;
    if (evt.text && _dismissedQuests.includes(evt.text)) return;
    if (evt.type === "quest" && evt.text) {
      for (const existing of body.children) {
        if (existing.classList.contains("log-quest") && existing.querySelector(".log-text")?.textContent?.includes(evt.text)) return;
      }
    }
    const name = nodeEl ? nodeEl.querySelector(".node-label")?.textContent || evt.node : evt.node || "System";
    const time = new Date((evt.ts || Date.now() / 1e3) * 1e3);
    const timeStr = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const entry = document.createElement("div");
    const logType = evt.type || "speech";
    const isNotion = evt._source === "notion";
    entry.className = `log-entry log-${logType} log-entry-new` + (isNotion ? " notion-quest" : "");
    if (isNotion && evt._notion_id) entry.dataset.notionId = evt._notion_id;
    let textContent = "";
    if (logType === "quest" && evt.text) {
      const icon = isNotion ? "&#127744;" : "&#9744;";
      textContent = `<div class="log-text quest-text"><span class="quest-check" title="Click to complete">${icon}</span> ${evt.text}</div>`;
    } else if (evt.text) {
      const prefix = logType === "speech" ? "\u201C" : "";
      const suffix = logType === "speech" ? "\u201D" : "";
      textContent = `<div class="log-text">${prefix}${evt.text}${suffix}</div>`;
    } else if (logType === "highlight") {
      textContent = `<div class="log-text" style="font-style:italic;color:#708060">A pulse of energy ripples outward.</div>`;
    }
    const communeHint = evt.node ? '<span class="log-commune" title="Click to commune with this node">\u{1F52E}</span>' : "";
    entry.innerHTML = `<button class="panel-close panel-close--danger" title="Dismiss">\u2715</button><div class="log-time">${timeStr}</div><div class="log-speaker">${name}${communeHint}</div>${textContent}`;
    entry._nodeId = evt.node;
    entry.addEventListener("click", (e) => {
      if (e.target.closest(".panel-close") || e.target.closest(".quest-check")) return;
      const nodeId = entry._nodeId;
      if (!nodeId) return;
      const tn = _topology?.nodes.find((nd) => nd.id === nodeId);
      if (tn) panToNode(tn.x, tn.y);
      openNodeChat(nodeId, evt.text, false);
    });
    entry.querySelector(".panel-close").addEventListener("click", (e) => {
      e.stopPropagation();
      entry.classList.add("log-entry-dismiss");
      if (evt.text) {
        for (const b of _activeBubbles) {
          if (b.querySelector(".bubble-text")?.textContent?.includes(evt.text)) {
            _dismissBubble(b);
            break;
          }
        }
        if (!_dismissedQuests.includes(evt.text)) {
          _dismissedQuests.push(evt.text);
          _saveDismissed();
        }
        if (evt.type === "quest") {
          fetch("/quest-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: evt.text }) }).catch(() => {
          });
        }
      }
      entry.addEventListener("animationend", () => {
        entry.remove();
        logCount = Math.max(0, logCount - 1);
        _logCounter.textContent = `${logCount} entries`;
      });
    });
    const check = entry.querySelector(".quest-check");
    if (check) {
      if (evt.text && _completedQuests.includes(evt.text)) {
        check.innerHTML = "\u2611";
        entry.classList.add("quest-done");
      }
      check.addEventListener("click", async () => {
        const done = check.textContent === "\u2611";
        check.innerHTML = done ? isNotion ? "&#127744;" : "\u2610" : "\u2611";
        entry.classList.toggle("quest-done", !done);
        if (evt.text) {
          const idx = _completedQuests.indexOf(evt.text);
          if (!done && idx === -1) _completedQuests.push(evt.text);
          else if (done && idx !== -1) _completedQuests.splice(idx, 1);
          _saveCompleted();
        }
        if (isNotion && evt._notion_id && !done) {
          try {
            check.style.opacity = "0.5";
            const r = await fetch("/notion-complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ notion_id: evt._notion_id })
            });
            if (r.ok) {
              check.style.opacity = "1";
              check.innerHTML = "\u2705";
            } else {
              check.style.opacity = "1";
            }
          } catch (e) {
            check.style.opacity = "1";
          }
        }
      });
    }
    if (activeTab === "notion") {
      entry.style.display = entry.classList.contains("notion-quest") ? "" : "none";
    } else if (activeTab !== "all" && !entry.classList.contains("log-" + activeTab)) {
      entry.style.display = "none";
    }
    body.insertBefore(entry, body.firstChild);
    logCount++;
    setTimeout(() => entry.classList.remove("log-entry-new"), 3e3);
    while (body.children.length > MAX_LOG) {
      body.removeChild(body.lastChild);
    }
    counter.textContent = `${Math.min(logCount, MAX_LOG)} entries`;
  }
  __name(addLogEntry, "addLogEntry");
  var _dismissedQuests = JSON.parse(localStorage.getItem("realm-dismissed-quests") || "[]");
  var _completedQuests = JSON.parse(localStorage.getItem("realm-completed-quests") || "[]");
  function _saveDismissed() {
    localStorage.setItem("realm-dismissed-quests", JSON.stringify(_dismissedQuests));
  }
  __name(_saveDismissed, "_saveDismissed");
  function _saveCompleted() {
    localStorage.setItem("realm-completed-quests", JSON.stringify(_completedQuests));
  }
  __name(_saveCompleted, "_saveCompleted");
  var _ACTION_ICONS = {
    pan: "\u{1F5FA}\uFE0F",
    panel: "\u{1F4CB}",
    highlight: "\u2728",
    chat: "\u{1F4AC}",
    scan: "\u{1F50D}",
    link: "\u{1F517}"
  };
  function _executeQuestAction(action) {
    if (action.type === "pan" && action.node) {
      const tn = _topology?.nodes.find((n) => n.id === action.node);
      if (tn) {
        panToNode(tn.x, tn.y);
        showHighlight(getNodeDOM(tn.id), { color: "rgba(192,144,255,0.6)" });
      }
    } else if (action.type === "panel" && action.panel) {
      const panelEl = document.getElementById(action.panel);
      if (panelEl) {
        _unsealPanel(panelEl);
        panelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else if (action.type === "highlight" && action.nodes) {
      action.nodes.forEach((nid) => {
        const tn = _topology?.nodes.find((n) => n.id === nid);
        if (tn) showHighlight(getNodeDOM(nid), { color: action.color || "rgba(192,144,255,0.5)" });
      });
    } else if (action.type === "chat" && action.node) {
      const tn = _topology?.nodes.find((n) => n.id === action.node);
      if (tn) panToNode(tn.x, tn.y);
      openNodeChat(action.node, action.prompt || "", false);
    } else if (action.type === "scan") {
      fetch(action.endpoint || "/scan").catch(() => {
      });
      addLogEntry({ type: "system", node: "katana", text: "Initiating realm scan...", ts: Date.now() / 1e3 });
    }
  }
  __name(_executeQuestAction, "_executeQuestAction");
  function _renderQuestCards(quests) {
    _questCards.innerHTML = "";
    if (!quests.length) {
      _questCards.innerHTML = '<div style="padding:16px;text-align:center;color:#706040;font-size:11px;font-style:italic">No active quests. The realm is at peace.</div>';
      return;
    }
    quests.forEach((quest) => {
      const card = document.createElement("div");
      const children = quest.children || [];
      const doneCount = children.filter((c) => c.status === "completed").length;
      const total = children.length;
      const allDone = total > 0 && doneCount === total;
      const pct = total > 0 ? Math.round(doneCount / total * 100) : 0;
      card.className = "quest-card" + (allDone ? " quest-card--done" : "");
      const header = document.createElement("div");
      header.className = "quest-card-header";
      header.innerHTML = `<span class="quest-card-icon">\u25B6</span><span class="quest-card-title">${quest.title}</span>` + (total > 0 ? `<span class="quest-card-progress">${doneCount}/${total}</span>` : "");
      header.addEventListener("click", () => card.classList.toggle("quest-card--open"));
      card.appendChild(header);
      if (total > 0) {
        const bar = document.createElement("div");
        bar.className = "quest-card-bar";
        bar.innerHTML = `<div class="quest-card-bar-fill" style="width:${pct}%"></div>`;
        card.appendChild(bar);
      }
      if (quest.description) {
        const desc = document.createElement("div");
        desc.className = "quest-card-desc";
        desc.textContent = quest.description;
        card.appendChild(desc);
      }
      if (quest.actions?.length) {
        const actionsRow = document.createElement("div");
        actionsRow.className = "quest-actions";
        actionsRow.style.padding = "2px 10px 6px 34px";
        quest.actions.forEach((action) => {
          const btn = document.createElement("button");
          btn.className = `quest-action quest-action--${action.type}`;
          btn.innerHTML = `${_ACTION_ICONS[action.type] || ""} ${action.label}`;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            _executeQuestAction(action);
          });
          actionsRow.appendChild(btn);
        });
        card.appendChild(actionsRow);
      }
      const body = document.createElement("div");
      body.className = "quest-card-body";
      children.forEach((sub) => {
        const subEl = document.createElement("div");
        const isDone = sub.status === "completed";
        subEl.className = "quest-sub" + (isDone ? " quest-sub--done" : "");
        const check = document.createElement("span");
        check.className = "quest-sub-check";
        check.innerHTML = isDone ? "\u2611" : "\u2610";
        check.addEventListener("click", () => {
          const newStatus = isDone ? "active" : "completed";
          fetch("/quest-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: sub.id, status: newStatus })
          }).then(() => _refreshQuestCards()).catch(() => {
          });
          subEl.classList.toggle("quest-sub--done");
          subEl.classList.add("quest-sub--completing");
          check.innerHTML = isDone ? "\u2610" : "\u2611";
        });
        const content = document.createElement("div");
        content.className = "quest-sub-content";
        content.innerHTML = `<div class="quest-sub-title">${sub.title}</div>` + (sub.node ? `<div class="quest-sub-node">\u2694 ${sub.node}</div>` : "");
        if (sub.actions?.length) {
          const subActions = document.createElement("div");
          subActions.className = "quest-actions";
          sub.actions.forEach((action) => {
            const btn = document.createElement("button");
            btn.className = `quest-action quest-action--${action.type}`;
            btn.innerHTML = `${_ACTION_ICONS[action.type] || ""} ${action.label}`;
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              _executeQuestAction(action);
            });
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
  __name(_renderQuestCards, "_renderQuestCards");
  function _refreshQuestCards() {
    fetch("/quests").then((r) => r.json()).then((quests) => _renderQuestCards(quests)).catch(() => {
    });
  }
  __name(_refreshQuestCards, "_refreshQuestCards");
  function _loadQuestLog() {
    _refreshQuestCards();
    fetch("/events?limit=50").then((r) => r.json()).then((events) => {
      events.filter((e) => e.text && !_dismissedQuests.includes(e.text)).forEach((e, i) => {
        setTimeout(() => addLogEntry(e), i * 50);
      });
    }).catch(() => {
    });
  }
  __name(_loadQuestLog, "_loadQuestLog");
  setTimeout(() => {
    addLogEntry({ type: "system", node: "katana", text: "The Realm Map has been inscribed.", ts: Date.now() / 1e3 });
    _loadQuestLog();
  }, 800);
  var _activeBubbles = /* @__PURE__ */ new Set();
  function _positionBubble(bubble) {
    let nodeEl = bubble._nodeEl;
    if (!nodeEl || !nodeEl.isConnected) {
      if (bubble._nodeId) {
        nodeEl = document.querySelector(`[data-tip="${bubble._nodeId}"]`);
        if (nodeEl) bubble._nodeEl = nodeEl;
      }
    }
    if (!nodeEl || !nodeEl.isConnected) return;
    const nodeLeft = parseInt(nodeEl.style.left) || 0;
    const nodeTop = parseInt(nodeEl.style.top) || 0;
    const icon = nodeEl.querySelector(".node-icon");
    const iconW = icon ? icon.offsetWidth : 64;
    bubble.style.left = nodeLeft + iconW / 2 - bubble.offsetWidth / 2 + "px";
    bubble.style.top = nodeTop - bubble.offsetHeight - 12 + "px";
  }
  __name(_positionBubble, "_positionBubble");
  function updateBubblePositions() {
    _activeBubbles.forEach((b) => {
      if (!b.isConnected) {
        _activeBubbles.delete(b);
        return;
      }
      _positionBubble(b);
    });
  }
  __name(updateBubblePositions, "updateBubblePositions");
  setTopologyRefreshHook(updateBubblePositions);
  setTopologyRefreshHook(() => {
    _searchIndex = null;
  });
  function _dismissBubble(bubble) {
    bubble.style.animation = "bubbleOut 0.3s ease-in forwards";
    setTimeout(() => {
      bubble.remove();
      _activeBubbles.delete(bubble);
    }, 300);
  }
  __name(_dismissBubble, "_dismissBubble");
  function showSpeechBubble(nodeEl, evt, isAlert) {
    const dismissList = [];
    for (const b of _activeBubbles) {
      if (b._nodeId === evt.node) dismissList.push(b);
    }
    for (const b of dismissList) _dismissBubble(b);
    const bubble = document.createElement("div");
    const isQuest = evt.type === "quest";
    const isNotion = evt._source === "notion";
    let cls = "speech-bubble";
    if (isAlert) cls += " alert-bubble";
    if (isQuest) cls += " quest-bubble";
    if (isNotion) cls += " notion-bubble";
    bubble.className = cls;
    bubble._nodeEl = nodeEl;
    bubble._nodeId = evt.node;
    const name = nodeEl.querySelector(".node-label")?.textContent || evt.node;
    const closeBtn = document.createElement("button");
    closeBtn.className = "panel-close";
    closeBtn.innerHTML = "\xD7";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _dismissBubble(bubble);
    });
    const prefix = isNotion ? '<span style="color:#a080e0">&#127744;</span> ' : isQuest ? '<span style="color:#c090ff">&#9733;</span> ' : "";
    bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${prefix}${evt.text || ""}</div>`;
    bubble.appendChild(closeBtn);
    if (evt.color) bubble.style.borderColor = evt.color;
    bubble.addEventListener("click", (e) => {
      if (e.target === closeBtn) return;
      openNodeChat(evt.node, evt.text);
    });
    bubble.style.cursor = "pointer";
    const world2 = document.getElementById("map-world");
    world2.appendChild(bubble);
    _positionBubble(bubble);
    _activeBubbles.add(bubble);
    if (window._visState && window._visState[".speech-bubble"] === false) bubble.style.visibility = "hidden";
    if (_mapTilt > 0) {
      const bz = _mapTilt * 5 + _mapTilt * 3 + _mapTilt * 8 + _mapTilt * 3;
      bubble.style.translate = `0px 0px ${bz}px`;
      bubble.style.rotate = `x ${-_mapTilt}deg`;
    }
  }
  __name(showSpeechBubble, "showSpeechBubble");
  function showHighlight(nodeEl, evt) {
    const iconEl = nodeEl.querySelector(".node-icon");
    if (!iconEl) return;
    const flash = document.createElement("div");
    flash.className = "node-highlight";
    if (evt.color) {
      flash.style.animation = "none";
      flash.style.boxShadow = `0 0 30px 15px ${evt.color}`;
      flash.style.animation = "highlightFlash 1.5s ease-out forwards";
    }
    iconEl.appendChild(flash);
    setTimeout(() => flash.remove(), 1500);
  }
  __name(showHighlight, "showHighlight");
  var _pulseCore = document.getElementById("pulse-core");
  var _pulseRing1 = document.getElementById("pulse-ring1");
  var _pulseRing2 = document.getElementById("pulse-ring2");
  var _pulseLabel = document.getElementById("pulse-label");
  var _scanLine = document.getElementById("scan-line");
  function firePulse() {
    const core = _pulseCore, ring1 = _pulseRing1, ring2 = _pulseRing2;
    const label = _pulseLabel, scan = _scanLine;
    core.style.background = "#a0ff60";
    core.style.boxShadow = "0 0 12px rgba(160,255,96,0.8), 0 0 4px rgba(160,255,96,0.4)";
    setTimeout(() => {
      core.style.background = "#60a040";
      core.style.boxShadow = "0 0 6px rgba(96,160,64,0.4)";
    }, 600);
    ring1.style.animation = "none";
    ring2.style.animation = "none";
    void ring1.offsetWidth;
    ring1.style.animation = "dataPulse1 0.8s ease-out forwards";
    ring2.style.animation = "dataPulse2 1.1s ease-out 0.1s forwards";
    label.textContent = "LIVE";
    label.style.color = "#a0c070";
    scan.style.animation = "none";
    void scan.offsetWidth;
    scan.style.animation = "scanPass 1.2s ease-in-out forwards";
  }
  __name(firePulse, "firePulse");
  function showOffline() {
    if (_pulseCore) {
      _pulseCore.style.background = "#804040";
      _pulseCore.style.boxShadow = "none";
    }
    if (_pulseLabel) {
      _pulseLabel.textContent = "OFFLINE";
      _pulseLabel.style.color = "#604040";
    }
  }
  __name(showOffline, "showOffline");
  var canvas = document.getElementById("map-canvas");
  var world = document.getElementById("map-world");
  var _canvasRect = canvas.getBoundingClientRect();
  var scale = 1;
  var panX = 0;
  var panY = 0;
  var dragging = false;
  var lastX;
  var lastY;
  var _lastGlobeTilt = 0;
  var _zoomActive = false;
  var _zoomIdleTimer = 0;
  var _zoomWillChangeRaf = 0;
  function _enterZoomMode() {
    if (!_zoomActive) {
      _zoomActive = true;
      world.classList.add("zooming");
      _zoomWillChangeRaf = requestAnimationFrame(() => {
        _zoomWillChangeRaf = 0;
        if (_zoomActive) world.style.willChange = "transform";
      });
    }
    clearTimeout(_zoomIdleTimer);
    _zoomIdleTimer = setTimeout(_exitZoomMode, 400);
  }
  __name(_enterZoomMode, "_enterZoomMode");
  var _zoomVeil = document.createElement("div");
  _zoomVeil.id = "zoom-veil";
  document.getElementById("map-canvas").appendChild(_zoomVeil);
  function _exitZoomMode() {
    _zoomActive = false;
    if (_zoomWillChangeRaf) {
      cancelAnimationFrame(_zoomWillChangeRaf);
      _zoomWillChangeRaf = 0;
    }
    world.style.willChange = "";
    _zoomVeil.classList.add("active");
    requestAnimationFrame(() => {
      world.classList.remove("zooming");
      _updateSparkleRect();
      requestAnimationFrame(() => {
        _zoomVeil.classList.add("fade");
        setTimeout(() => {
          _zoomVeil.classList.remove("active", "fade");
        }, 250);
      });
    });
  }
  __name(_exitZoomMode, "_exitZoomMode");
  var _transformRafId = 0;
  function _applyTransformNow() {
    _transformRafId = 0;
    if (_mapTilt > 0) {
      canvas.classList.add("tilted");
      world.style.transformStyle = "preserve-3d";
      world.style.zoom = "";
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) translate(${cx}px, ${cy}px) rotateX(${_mapTilt}deg) translate(${-cx}px, ${-cy}px)`;
      if (_mapTilt !== _lastGlobeTilt) {
        _applyGlobeZ();
        _lastGlobeTilt = _mapTilt;
      }
    } else {
      canvas.classList.remove("tilted");
      if (_lastGlobeTilt !== 0) {
        _clearGlobeZ();
        _lastGlobeTilt = 0;
      }
      world.style.transformStyle = "";
      world.style.zoom = "";
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }
  }
  __name(_applyTransformNow, "_applyTransformNow");
  function applyTransform() {
    if (!_transformRafId) _transformRafId = requestAnimationFrame(_applyTransformNow);
  }
  __name(applyTransform, "applyTransform");
  function _applyGlobeZ() {
    if (!_topology) return;
    const cx = WORLD_W / 2, cy = WORLD_H / 2;
    const maxD2 = cx * cx + cy * cy;
    const R = _mapTilt * 8;
    const peakH = _mapTilt * 5;
    const nodeFloat = _mapTilt * 3;
    const counterRot = `x ${-_mapTilt}deg`;
    const topoEl = document.getElementById("topo-svg");
    if (topoEl) {
      topoEl.style.transformStyle = "preserve-3d";
      topoEl.querySelectorAll(".topo-band").forEach((band) => {
        const elev = parseFloat(band.dataset.elev) || 0;
        band.style.translate = `0px 0px ${elev * peakH}px`;
      });
    }
    const connSvg = document.getElementById("connections");
    if (connSvg) connSvg.style.translate = `0px 0px ${peakH * 0.4}px`;
    const regionEl = document.getElementById("region-labels");
    if (regionEl) {
      regionEl.style.translate = `0px 0px ${peakH * 0.7}px`;
      regionEl.style.rotate = counterRot;
    }
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
    const bubbleZ = peakH + nodeFloat + R + _mapTilt * 3;
    document.querySelectorAll(".speech-bubble").forEach((b) => {
      b.style.translate = `0px 0px ${bubbleZ}px`;
      b.style.rotate = counterRot;
    });
  }
  __name(_applyGlobeZ, "_applyGlobeZ");
  function _applyTopoZ() {
    const peakH = _mapTilt * 5;
    const topoEl = document.getElementById("topo-svg");
    if (!topoEl) return;
    topoEl.style.transformStyle = "preserve-3d";
    topoEl.querySelectorAll(".topo-band").forEach((band) => {
      const elev = parseFloat(band.dataset.elev) || 0;
      band.style.translate = `0px 0px ${elev * peakH}px`;
    });
  }
  __name(_applyTopoZ, "_applyTopoZ");
  function _clearGlobeZ() {
    if (!_topology) return;
    for (const n of _topology.nodes) {
      const el = _nodeElCache[n.id] || document.querySelector(`[data-tip="${n.id}"]`);
      if (el) {
        el.style.translate = "";
        el.style.rotate = "";
      }
    }
    const topoEl = document.getElementById("topo-svg");
    const connSvg = document.getElementById("connections");
    const regionEl = document.getElementById("region-labels");
    if (topoEl) {
      topoEl.style.transformStyle = "";
      topoEl.querySelectorAll(".topo-band").forEach((b) => {
        b.style.translate = "";
      });
    }
    if (connSvg) connSvg.style.translate = "";
    if (regionEl) {
      regionEl.style.translate = "";
      regionEl.style.rotate = "";
    }
    document.querySelectorAll(".speech-bubble").forEach((b) => {
      b.style.translate = "";
      b.style.rotate = "";
    });
  }
  __name(_clearGlobeZ, "_clearGlobeZ");
  function centerMap() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    scale = Math.min(cw / WORLD_W, ch / WORLD_H) * 1.2;
    panX = (cw - WORLD_W * scale) / 2;
    panY = (ch - WORLD_H * scale) / 2;
    applyTransform();
  }
  __name(centerMap, "centerMap");
  function panToNode(x, y) {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    scale = 1.2;
    panX = cw / 2 - x * scale;
    panY = ch / 2 - y * scale;
    applyTransform();
  }
  __name(panToNode, "panToNode");
  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    _enterZoomMode();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    _enterZoomMode();
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      saveSettings();
    }
  });
  var _touchPanning = false;
  var _lastTouch = null;
  var _pinchDist = null;
  canvas.addEventListener("touchstart", (e) => {
    _enterZoomMode();
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
  canvas.addEventListener("touchmove", (e) => {
    _enterZoomMode();
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
  canvas.addEventListener("touchend", () => {
    if (_touchPanning || _pinchDist) saveSettings();
    _touchPanning = false;
    _lastTouch = null;
    _pinchDist = null;
  }, { passive: true });
  var _zoomSaveTimer = null;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    _enterZoomMode();
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
  var tooltip = document.getElementById("tooltip");
  var _tipNode = null;
  document.getElementById("map-world").addEventListener("mouseover", (e) => {
    const node = e.target.closest(".realm-node");
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
    tooltip.style.display = "block";
  });
  document.getElementById("map-world").addEventListener("mousemove", (e) => {
    if (_tipNode) {
      tooltip.style.left = e.clientX + 16 + "px";
      tooltip.style.top = e.clientY + 16 + "px";
    }
  });
  document.getElementById("map-world").addEventListener("mouseout", (e) => {
    const node = e.target.closest(".realm-node");
    if (!node) return;
    const related = e.relatedTarget?.closest?.(".realm-node");
    if (related === node) return;
    if (_tipNode === node) _tipNode = null;
    tooltip.style.display = "none";
  });
  centerMap();
  window.addEventListener("resize", () => {
    _canvasRect = canvas.getBoundingClientRect();
  });
  var currentEditNode = null;
  var peOverlay = document.getElementById("pe-overlay");
  var peEditor = document.getElementById("persona-editor");
  var peNodeKey = document.getElementById("pe-node-key");
  var peName = document.getElementById("pe-name");
  var peTitleField = document.getElementById("pe-title-field");
  var peVoice = document.getElementById("pe-voice");
  var pePrompt = document.getElementById("pe-prompt");
  var peHints = document.getElementById("pe-hints");
  var peHintInput = document.getElementById("pe-hint-input");
  var peSaved = document.getElementById("pe-saved");
  var peHintsList = [];
  function openPersonaEditor(nodeKey) {
    currentEditNode = nodeKey;
    peNodeKey.value = nodeKey;
    _switchToTab("persona");
    fetch("/personas").then((r) => r.json()).then((personas) => {
      const p = personas[nodeKey] || {};
      peName.value = p.name || nodeKey;
      peTitleField.value = p.title || "";
      peVoice.value = p.voice || "en-US-GuyNeural";
      pePrompt.value = p.system_prompt || "";
      peHintsList = Array.isArray(p.hints) ? [...p.hints] : [];
      renderHints();
    }).catch(() => {
      peName.value = nodeKey;
      peTitleField.value = "";
      pePrompt.value = "";
      peHintsList = [];
      renderHints();
    });
    const groupTab = document.querySelector('.pe-tab[data-pe-tab="group"]');
    if (groupTab) {
      const groupConfig = lastStatus?.groups?.[nodeKey];
      const hasMembers = groupConfig && (Array.isArray(groupConfig.entities) ? groupConfig.entities.length > 1 : typeof groupConfig.entities === "object" ? Object.keys(groupConfig.entities).length > 1 : false);
      groupTab.style.display = hasMembers ? "" : "none";
    }
    peEditor.classList.add("open");
    peOverlay.classList.add("open");
    peSaved.classList.remove("show");
  }
  __name(openPersonaEditor, "openPersonaEditor");
  function closePersonaEditor() {
    peEditor.classList.remove("open");
    peOverlay.classList.remove("open");
    currentEditNode = null;
    stopStatsRefresh();
  }
  __name(closePersonaEditor, "closePersonaEditor");
  function renderHints() {
    peHints.innerHTML = "";
    peHintsList.forEach((hint, i) => {
      const tag = document.createElement("span");
      tag.className = "pe-hint-tag";
      tag.innerHTML = `${hint} <span class="hint-x" data-idx="${i}">&times;</span>`;
      peHints.appendChild(tag);
    });
    peHints.querySelectorAll(".hint-x").forEach((x) => {
      x.addEventListener("click", () => {
        peHintsList.splice(parseInt(x.dataset.idx), 1);
        renderHints();
      });
    });
  }
  __name(renderHints, "renderHints");
  peHintInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && peHintInput.value.trim()) {
      e.preventDefault();
      peHintsList.push(peHintInput.value.trim());
      peHintInput.value = "";
      renderHints();
    }
  });
  document.getElementById("pe-save").addEventListener("click", () => {
    if (!currentEditNode) return;
    const payload = {
      node: currentEditNode,
      name: peName.value,
      title: peTitleField.value,
      voice: peVoice.value,
      system_prompt: pePrompt.value,
      hints: peHintsList
    };
    fetch("/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        peSaved.classList.add("show");
        setTimeout(() => peSaved.classList.remove("show"), 2e3);
        addLogEntry({
          type: "system",
          node: currentEditNode,
          text: `Persona "${peName.value}" inscribed in the archives.`,
          ts: Date.now() / 1e3
        });
      }
    }).catch(() => {
    });
  });
  document.getElementById("pe-cancel").addEventListener("click", closePersonaEditor);
  document.getElementById("pe-close").addEventListener("click", closePersonaEditor);
  peOverlay.addEventListener("click", closePersonaEditor);
  var _statsInterval = null;
  document.querySelectorAll(".pe-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".pe-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.peTab;
      document.querySelectorAll(".pe-pane").forEach((p) => p.style.display = "none");
      document.getElementById("pe-pane-" + target).style.display = "";
      if (target === "stats") startStatsRefresh();
      else stopStatsRefresh();
      if (target === "node") renderNodePane(currentEditNode);
      if (target === "control") renderControlPane(currentEditNode);
      if (target === "group") renderGroupPane(currentEditNode);
      if (target === "shell") {
        renderShellPane(currentEditNode);
        _shellInput.focus();
      }
      if (target === "links") renderConnectionsPane(currentEditNode);
    });
  });
  function _switchToTab(name) {
    document.querySelectorAll(".pe-tab").forEach((t) => t.classList.toggle("active", t.dataset.peTab === name));
    document.querySelectorAll(".pe-pane").forEach((p) => p.style.display = "none");
    document.getElementById("pe-pane-" + name).style.display = "";
    if (name === "stats") startStatsRefresh();
    else stopStatsRefresh();
    if (name === "node") renderNodePane(currentEditNode);
    if (name === "control") renderControlPane(currentEditNode);
    if (name === "group") renderGroupPane(currentEditNode);
    if (name === "shell") renderShellPane(currentEditNode);
    if (name === "links") renderConnectionsPane(currentEditNode);
  }
  __name(_switchToTab, "_switchToTab");
  function startStatsRefresh() {
    stopStatsRefresh();
    renderStatsPane(currentEditNode);
    _statsInterval = setInterval(() => renderStatsPane(currentEditNode), 5e3);
  }
  __name(startStatsRefresh, "startStatsRefresh");
  function stopStatsRefresh() {
    if (_statsInterval) {
      clearInterval(_statsInterval);
      _statsInterval = null;
    }
  }
  __name(stopStatsRefresh, "stopStatsRefresh");
  function renderNodePane(nodeKey) {
    if (!nodeKey || !_topology) return;
    const node = _topology.nodes.find((n) => n.id === nodeKey);
    if (!node) return;
    const el = /* @__PURE__ */ __name((id) => document.getElementById("pe-node-" + id), "el");
    el("label").value = node.label || "";
    el("sublabel").value = node.sublabel || "";
    el("icon").value = node.icon || "";
    el("type").value = node.type || "device";
    el("ip").value = node.ip || "";
    el("mac").value = node.mac || "";
    el("collectd").value = node.collectd || "";
    el("x").value = Math.round((node.x || 0) / (WORLD_SCALE || 1));
    el("y").value = Math.round((node.y || 0) / (WORLD_SCALE || 1));
    el("ssh").value = node.ssh || "";
    el("tshost").value = node.tsHost || "";
  }
  __name(renderNodePane, "renderNodePane");
  document.getElementById("pe-node-save")?.addEventListener("click", () => {
    if (!currentEditNode || !_topology) return;
    const node = _topology.nodes.find((n) => n.id === currentEditNode);
    if (!node) return;
    const el = /* @__PURE__ */ __name((id) => document.getElementById("pe-node-" + id), "el");
    node.label = el("label").value;
    node.sublabel = el("sublabel").value;
    node.icon = el("icon").value;
    node.type = el("type").value;
    node.ip = el("ip").value;
    node.mac = el("mac").value || void 0;
    node.collectd = el("collectd").value || void 0;
    node.ssh = el("ssh").value || void 0;
    node.tsHost = el("tshost").value || void 0;
    const nx = parseInt(el("x").value) || 0;
    const ny = parseInt(el("y").value) || 0;
    const payload = { ...node, x: nx, y: ny };
    delete payload._auto;
    fetch("/node", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        const scale2 = WORLD_SCALE || 1;
        node.x = Math.round(nx * scale2);
        node.y = Math.round(ny * scale2);
        const domNode = document.querySelector(`[data-tip="${currentEditNode}"]`);
        if (domNode) {
          domNode.style.left = node.x + "px";
          domNode.style.top = node.y + "px";
          const lbl = domNode.querySelector(".node-label");
          if (lbl) lbl.textContent = node.label;
          const sub = domNode.querySelector(".node-sublabel");
          if (sub) sub.innerHTML = node.sublabel;
          const ico = domNode.querySelector(".node-icon");
          if (ico) {
            const txt = ico.childNodes;
            if (txt.length) txt[txt.length - 1].textContent = node.icon;
          }
        }
        addLogEntry({ type: "system", node: currentEditNode, text: `Node "${node.label}" updated.`, ts: Date.now() / 1e3 });
      }
    });
  });
  document.getElementById("pe-node-delete")?.addEventListener("click", () => {
    if (!currentEditNode) return;
    if (!confirm(`Delete node "${currentEditNode}"? This cannot be undone.`)) return;
    fetch("/node", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: currentEditNode, _delete: true })
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        closePersonaEditor();
        location.reload();
      }
    });
  });
  function _barClass(pct) {
    return pct > 85 ? "bar-crit" : pct > 60 ? "bar-warn" : "bar-ok";
  }
  __name(_barClass, "_barClass");
  function renderStatsPane(nodeKey) {
    const body = document.getElementById("pe-stats-body");
    const titleEl = document.getElementById("pe-stats-title");
    if (!body) return;
    const info = infraNodes[nodeKey];
    const nodeName = info ? info.name : nodeKey;
    titleEl.textContent = nodeName + " \u2014 Scrying";
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
    const topoNode = _topology ? _topology.nodes.find((n) => n.id === nodeKey) : null;
    if (!cd && !tsPeer && !wifiInfo && !haInfo && !wledInfo && !topoNode) {
      body.innerHTML = '<div class="pe-stats-empty">No sigils bound to this node.</div>';
      return;
    }
    let html = "";
    const roleIcons = {
      router: "\u{1F310}",
      ap: "\u{1F4E1}",
      switch: "\u{1F500}",
      bridge: "\u{1F309}",
      server: "\u{1F5A5}\uFE0F",
      nas: "\u{1F4BE}",
      vm: "\u{1F4E6}",
      wled: "\u{1F308}",
      thermostat: "\u{1F321}\uFE0F",
      camera: "\u{1F4F9}",
      speaker: "\u{1F50A}",
      plug: "\u{1F50C}",
      sensor: "\u{1F4CA}",
      appliance: "\u{1F3E0}",
      vacuum: "\u{1F916}",
      inverter: "\u2600\uFE0F",
      ups: "\u{1F50B}",
      ev_charger: "\u26A1",
      phone: "\u{1F4F1}",
      tablet: "\u{1F4DF}",
      laptop: "\u{1F4BB}",
      desktop: "\u{1F5A5}\uFE0F",
      tv: "\u{1F4FA}",
      tailscale: "\u{1F517}",
      unknown: "\u2753"
    };
    const roleNames = {
      router: "Router",
      ap: "Access Point",
      switch: "Switch",
      bridge: "Bridge",
      server: "Server",
      nas: "NAS",
      vm: "VM",
      wled: "LED Controller",
      thermostat: "Thermostat",
      camera: "Camera",
      speaker: "Speaker",
      plug: "Smart Plug",
      sensor: "Sensor",
      appliance: "Appliance",
      vacuum: "Vacuum",
      inverter: "Inverter",
      ups: "UPS",
      ev_charger: "EV Charger",
      phone: "Phone",
      tablet: "Tablet",
      laptop: "Laptop",
      desktop: "Desktop",
      tv: "TV",
      tailscale: "Tailscale",
      unknown: "Unknown"
    };
    if (nodeRole) {
      const icon = roleIcons[nodeRole] || "\u2753";
      const name = roleNames[nodeRole] || nodeRole;
      html += `<div class="pe-role-badge"><span class="pe-role-icon">${icon}</span><span class="pe-role-name">${name}</span></div>`;
    }
    if (tsPeer) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Tailscale</div>';
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Status</span><span class="pe-stat-val" style="color:${tsPeer.online ? "#60c060" : "#c04040"}">${tsPeer.online ? tsPeer.active ? "Active" : "Online" : "Offline"}</span></div>`;
      if (tsPeer.ip) html += `<div class="pe-stat-row"><span class="pe-stat-label">TS IP</span><span class="pe-stat-val">${tsPeer.ip}</span></div>`;
      if (tsPeer.os) html += `<div class="pe-stat-row"><span class="pe-stat-label">OS</span><span class="pe-stat-val">${tsPeer.os}</span></div>`;
      if (tsPeer.curAddr) html += `<div class="pe-stat-row"><span class="pe-stat-label">Link</span><span class="pe-stat-val" style="color:#60c060">Direct \u2014 ${tsPeer.curAddr}</span></div>`;
      else if (tsPeer.online && tsPeer.relay) html += `<div class="pe-stat-row"><span class="pe-stat-label">Link</span><span class="pe-stat-val" style="color:#c0a030">Relayed via ${tsPeer.relay.toUpperCase()}</span></div>`;
      if (tsPeer.tx || tsPeer.rx) html += `<div class="pe-stat-row"><span class="pe-stat-label">Traffic</span><span class="pe-stat-val">\u2191 ${fmtBytes(tsPeer.tx)} \u2193 ${fmtBytes(tsPeer.rx)}</span></div>`;
      if (tsPeer.exitNode) html += `<div class="pe-stat-row"><span class="pe-stat-label">Exit Node</span><span class="pe-stat-val" style="color:#c09030">Yes</span></div>`;
      if (tsPeer.lastSeen && !tsPeer.online) {
        const ago = Date.now() - new Date(tsPeer.lastSeen).getTime();
        const days = Math.floor(ago / 864e5);
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Last Seen</span><span class="pe-stat-val">${days > 0 ? days + "d ago" : "recently"}</span></div>`;
      }
      if (tsPeer.keyExpiry) {
        const daysLeft = Math.floor((new Date(tsPeer.keyExpiry) - Date.now()) / 864e5);
        const kColor = daysLeft < 7 ? "#c04040" : daysLeft < 30 ? "#c0a030" : "#60a040";
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Key Expiry</span><span class="pe-stat-val" style="color:${kColor}">${daysLeft > 0 ? daysLeft + "d" : "EXPIRED"}</span></div>`;
      }
      html += "</div>";
    }
    if (wledInfo) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">WLED</div>';
      const onColor = wledInfo.on ? "#60c060" : "#808080";
      html += `<div class="pe-stat-row"><span class="pe-stat-label">State</span><span class="pe-stat-val" style="color:${onColor}">${wledInfo.on ? "On" : "Off"}</span></div>`;
      if (wledInfo.on) {
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Brightness</span><span class="pe-stat-val">${wledInfo.brightness_pct}%</span></div>`;
        html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill pe-bar-good" style="width:${wledInfo.brightness_pct}%;background:linear-gradient(90deg,#ff6090,#60c0ff)"></div></div>`;
        if (wledInfo.effect) html += `<div class="pe-stat-row"><span class="pe-stat-label">Effect</span><span class="pe-stat-val">${wledInfo.effect}</span></div>`;
      }
      if (wledInfo.led_count) html += `<div class="pe-stat-row"><span class="pe-stat-label">LEDs</span><span class="pe-stat-val">${wledInfo.led_count}</span></div>`;
      if (wledInfo.led_power_mw) {
        const powerW = (wledInfo.led_power_mw / 1e3).toFixed(1);
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Power</span><span class="pe-stat-val">${powerW}W</span></div>`;
      }
      if (wledInfo.wifi_rssi != null) {
        const rssiColor = wledInfo.wifi_rssi > -50 ? "#60a040" : wledInfo.wifi_rssi > -70 ? "#c0a030" : "#c04040";
        html += `<div class="pe-stat-row"><span class="pe-stat-label">WiFi RSSI</span><span class="pe-stat-val" style="color:${rssiColor}">${wledInfo.wifi_rssi} dBm</span></div>`;
      }
      if (wledInfo.uptime_str) html += `<div class="pe-stat-row"><span class="pe-stat-label">Uptime</span><span class="pe-stat-val">${wledInfo.uptime_str}</span></div>`;
      if (wledInfo.version) html += `<div class="pe-stat-row"><span class="pe-stat-label">Version</span><span class="pe-stat-val">${wledInfo.version}</span></div>`;
      html += "</div>";
    }
    if (cd) {
      const sysRows = [];
      if (cd.hostname) sysRows.push(["Hostname", cd.hostname]);
      if (cd.cpu_cores) sysRows.push(["CPU Cores", cd.cpu_cores]);
      if (cd.uptime != null) {
        const d = Math.floor(cd.uptime / 86400), h = Math.floor(cd.uptime % 86400 / 3600);
        sysRows.push(["Uptime", d > 0 ? `${d}d ${h}h` : `${h}h`]);
      }
      if (cd.procs_running) sysRows.push(["Processes", cd.procs_running + " running"]);
      if (cd.fork_rate) sysRows.push(["Fork Rate", cd.fork_rate.toLocaleString()]);
      if (sysRows.length) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">System</div>';
        sysRows.forEach(([l, v]) => html += `<div class="pe-stat-row"><span class="pe-stat-label">${l}</span><span class="pe-stat-val">${v}</span></div>`);
        html += "</div>";
      }
      if (cd.load_1 != null) {
        const cores = cd.cpu_cores || 1;
        const loadPct = Math.min(100, cd.load_1 / cores * 100);
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Load</div>';
        html += `<div class="pe-stat-row"><span class="pe-stat-label">1 / 5 / 15 min</span><span class="pe-stat-val">${cd.load_1.toFixed(2)} / ${(cd.load_5 || 0).toFixed(2)} / ${(cd.load_15 || 0).toFixed(2)}</span></div>`;
        html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(loadPct)}" style="width:${loadPct}%"></div></div>`;
        html += "</div>";
      }
      if (cd.mem_pct != null) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Memory</div>';
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Usage</span><span class="pe-stat-val">${cd.mem_pct}% of ${cd.mem_total_mb || "?"} MB</span></div>`;
        html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(cd.mem_pct)}" style="width:${cd.mem_pct}%"></div></div>`;
        if (cd.swap_used != null && cd.swap_used > 0) {
          html += `<div class="pe-stat-row"><span class="pe-stat-label">Swap</span><span class="pe-stat-val">${(cd.swap_used / 1048576).toFixed(0)} MB</span></div>`;
        }
        html += "</div>";
      }
      if (cd.disk_pct != null) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Disk</div>';
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Usage</span><span class="pe-stat-val">${cd.disk_pct}% of ${cd.disk_total_gb} GB</span></div>`;
        html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(cd.disk_pct)}" style="width:${cd.disk_pct}%"></div></div>`;
        html += "</div>";
      }
      if (cd.temp != null) {
        const tempPct = Math.min(100, cd.temp / 100 * 100);
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Thermal</div>';
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Temperature</span><span class="pe-stat-val">${cd.temp}\xB0C</span></div>`;
        html += `<div class="pe-stat-bar"><div class="pe-stat-bar-fill ${_barClass(tempPct)}" style="width:${tempPct}%"></div></div>`;
        html += "</div>";
      }
      if (cd.interfaces && Object.keys(cd.interfaces).length) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Network</div>';
        Object.entries(cd.interfaces).sort(([, a], [, b]) => (b.rx_bps || 0) + (b.tx_bps || 0) - ((a.rx_bps || 0) + (a.tx_bps || 0))).forEach(([name, v]) => {
          html += `<div class="pe-iface-row"><span class="pe-iface-name">${name}</span><span class="pe-iface-traffic">\u2193${fmtRate(v.rx_bps || 0)} \u2191${fmtRate(v.tx_bps || 0)}</span></div>`;
        });
        html += "</div>";
      }
      if (cd.conntrack || cd.dhcp_leases) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Connections</div>';
        if (cd.conntrack) html += `<div class="pe-stat-row"><span class="pe-stat-label">Conntrack</span><span class="pe-stat-val">${cd.conntrack.toLocaleString()}</span></div>`;
        if (cd.dhcp_leases) html += `<div class="pe-stat-row"><span class="pe-stat-label">DHCP Leases</span><span class="pe-stat-val">${cd.dhcp_leases}</span></div>`;
        html += "</div>";
      }
      if (cd.ping && Object.keys(cd.ping).length) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Ping</div>';
        Object.entries(cd.ping).forEach(([target, ms]) => {
          const pingColor = ms < 10 ? "#60a040" : ms < 50 ? "#c0a030" : "#c04040";
          html += `<div class="pe-stat-row"><span class="pe-stat-label">${target}</span><span class="pe-stat-val" style="color:${pingColor}">${ms} ms</span></div>`;
        });
        html += "</div>";
      }
    }
    if (wifiInfo) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">WiFi</div>';
      const apLabel = _topology?.nodes.find((n) => n.id === wifiInfo.ap)?.label || wifiInfo.ap;
      html += `<div class="pe-stat-row"><span class="pe-stat-label">Access Point</span><span class="pe-stat-val">${apLabel}</span></div>`;
      if (wifiInfo.signal != null) {
        const sigColor = wifiInfo.signal > -50 ? "#60a040" : wifiInfo.signal > -70 ? "#c0a030" : "#c04040";
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Signal</span><span class="pe-stat-val" style="color:${sigColor}">${wifiInfo.signal} dBm</span></div>`;
      }
      if (wifiInfo.snr != null) {
        const snrColor = wifiInfo.snr > 40 ? "#60a040" : wifiInfo.snr > 20 ? "#c0a030" : "#c04040";
        html += `<div class="pe-stat-row"><span class="pe-stat-label">SNR</span><span class="pe-stat-val" style="color:${snrColor}">${wifiInfo.snr} dB</span></div>`;
      }
      if (wifiInfo.tx_rate) html += `<div class="pe-stat-row"><span class="pe-stat-label">TX Rate</span><span class="pe-stat-val">${wifiInfo.tx_rate} Mbit/s</span></div>`;
      if (wifiInfo.rx_rate) html += `<div class="pe-stat-row"><span class="pe-stat-label">RX Rate</span><span class="pe-stat-val">${wifiInfo.rx_rate} Mbit/s</span></div>`;
      if (wifiInfo.tx_pkts) html += `<div class="pe-stat-row"><span class="pe-stat-label">TX Packets</span><span class="pe-stat-val">${wifiInfo.tx_pkts.toLocaleString()}</span></div>`;
      if (wifiInfo.rx_pkts) html += `<div class="pe-stat-row"><span class="pe-stat-label">RX Packets</span><span class="pe-stat-val">${wifiInfo.rx_pkts.toLocaleString()}</span></div>`;
      html += "</div>";
    }
    if (haInfo) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Home Assistant</div>';
      const sublabel = haInfo.sublabel || "";
      if (sublabel.includes("\xB0F")) {
        const parts = sublabel.split(" \u2022 ");
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Temperature</span><span class="pe-stat-val">${parts[0]}</span></div>`;
        if (parts[1]) html += `<div class="pe-stat-row"><span class="pe-stat-label">State</span><span class="pe-stat-val">${parts[1]}</span></div>`;
      } else if (sublabel.includes("kW") || sublabel.includes("Batt")) {
        const parts = sublabel.split(" \u2022 ");
        parts.forEach((p) => {
          if (p.includes("kW")) html += `<div class="pe-stat-row"><span class="pe-stat-label">Power</span><span class="pe-stat-val">${p}</span></div>`;
          else if (p.includes("Batt")) html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${p}</span></div>`;
        });
      } else if (sublabel.includes("%") && !sublabel.includes("on")) {
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Battery</span><span class="pe-stat-val">${sublabel}</span></div>`;
      } else if (sublabel.includes("/") && sublabel.includes("on")) {
        const [on, total] = sublabel.match(/(\d+)\/(\d+)/)?.slice(1) || [];
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Active</span><span class="pe-stat-val">${on} of ${total}</span></div>`;
      } else if (sublabel.includes("Radar:")) {
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Presence</span><span class="pe-stat-val">${sublabel.replace("Radar: ", "")}</span></div>`;
      } else {
        html += `<div class="pe-stat-row"><span class="pe-stat-label">Status</span><span class="pe-stat-val">${sublabel || "connected"}</span></div>`;
      }
      if (haInfo.entities) html += `<div class="pe-stat-row"><span class="pe-stat-label">Entities</span><span class="pe-stat-val">${haInfo.entities}</span></div>`;
      html += "</div>";
    }
    if (topoNode) {
      const nodeRows = [];
      if (topoNode.type) nodeRows.push(["Type", topoNode.type]);
      if (topoNode.ip) nodeRows.push(["IP", topoNode.ip]);
      if (topoNode.mac) nodeRows.push(["MAC", topoNode.mac]);
      if (topoNode.collectd) nodeRows.push(["Collectd", topoNode.collectd]);
      if (topoNode.tsHost) nodeRows.push(["Tailscale", topoNode.tsHost]);
      if (topoNode._auto) nodeRows.push(["Source", '<span style="color:#a070c0">Auto-discovered</span>']);
      if (nodeRows.length && !cd) {
        html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Node Info</div>';
        nodeRows.forEach(([l, v]) => html += `<div class="pe-stat-row"><span class="pe-stat-label">${l}</span><span class="pe-stat-val">${v}</span></div>`);
        html += "</div>";
      }
    }
    body.innerHTML = html;
  }
  __name(renderStatsPane, "renderStatsPane");
  function renderControlPane(nodeKey) {
    const body = document.getElementById("pe-control-body");
    const titleEl = document.getElementById("pe-control-title");
    const statusEl = document.getElementById("pe-control-status");
    if (!body) return;
    const info = infraNodes[nodeKey];
    const nodeName = info ? info.name : nodeKey;
    titleEl.textContent = nodeName + " \u2014 Controls";
    statusEl.textContent = "";
    if (!lastStatus) {
      body.innerHTML = '<div class="pe-control-empty">No connection to realm.</div>';
      return;
    }
    const nodeRole = lastStatus.roles ? lastStatus.roles[nodeKey] : null;
    const wledInfo = lastStatus.wled ? lastStatus.wled[nodeKey] : null;
    const haInfo = lastStatus.ha ? lastStatus.ha[nodeKey] : null;
    const topoNode = _topology ? _topology.nodes.find((n) => n.id === nodeKey) : null;
    let html = "";
    let hasControls = false;
    if (wledInfo && wledInfo.online) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">LED Strip</div>';
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Power</span>
      <div class="pe-control-toggle ${wledInfo.on ? "active" : ""}" data-action="wled-power" data-node="${nodeKey}" data-state="${wledInfo.on ? "off" : "on"}"></div>
    </div>`;
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Brightness</span>
      <input type="range" class="pe-control-slider" min="0" max="255" value="${wledInfo.brightness || 128}" data-action="wled-brightness" data-node="${nodeKey}">
      <span style="width:30px;text-align:right;color:#a89870;font-size:11px">${wledInfo.brightness_pct || 50}%</span>
    </div>`;
      const quickEffects = [
        { id: 0, name: "Solid" },
        { id: 38, name: "Aurora" },
        { id: 9, name: "Rainbow" },
        { id: 12, name: "Theater" },
        { id: 44, name: "Fire" },
        { id: 108, name: "Noise" }
      ];
      html += '<div class="pe-control-row" style="flex-wrap:wrap;gap:6px;justify-content:flex-start">';
      quickEffects.forEach((fx) => {
        const active = wledInfo.effect_id === fx.id ? 'style="border-color:#60c060;color:#90ff90"' : "";
        html += `<button class="pe-control-btn" data-action="wled-effect" data-node="${nodeKey}" data-effect="${fx.id}" ${active}>${fx.name}</button>`;
      });
      html += "</div>";
      html += "</div>";
    }
    if (nodeRole === "plug" && haInfo) {
      hasControls = true;
      const isOn = haInfo.sublabel && (haInfo.sublabel.toLowerCase().includes("on") || haInfo.sublabel.includes("/"));
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Smart Plug</div>';
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Power</span>
      <div class="pe-control-toggle ${isOn ? "active" : ""}" data-action="ha-switch" data-node="${nodeKey}"></div>
    </div>`;
      html += "</div>";
    }
    if (nodeRole === "thermostat" && haInfo) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Climate</div>';
      const tempMatch = haInfo.sublabel?.match(/(\d+)/);
      const currentTemp = tempMatch ? parseInt(tempMatch[1]) : 70;
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Target</span>
      <button class="pe-control-btn" data-action="ha-climate" data-node="${nodeKey}" data-delta="-1">-</button>
      <span style="color:#d4c5a0;font-size:14px;min-width:40px;text-align:center">${currentTemp}\xB0F</span>
      <button class="pe-control-btn" data-action="ha-climate" data-node="${nodeKey}" data-delta="1">+</button>
    </div>`;
      html += '<div class="pe-control-row" style="gap:6px;justify-content:flex-start">';
      ["off", "heat", "cool", "auto"].forEach((mode) => {
        html += `<button class="pe-control-btn" data-action="ha-hvac-mode" data-node="${nodeKey}" data-mode="${mode}">${mode}</button>`;
      });
      html += "</div></div>";
    }
    if (nodeRole === "speaker" && haInfo) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Media</div>';
      html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
      html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="previous">&#9198;</button>`;
      html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="play_pause">&#9199;</button>`;
      html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="next">&#9197;</button>`;
      html += "</div>";
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Volume</span>
      <input type="range" class="pe-control-slider" min="0" max="100" value="50" data-action="ha-volume" data-node="${nodeKey}">
    </div>`;
      html += "</div>";
    }
    if (nodeRole === "vacuum" && haInfo) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Vacuum</div>';
      html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
      html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="start">Start</button>`;
      html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="pause">Pause</button>`;
      html += `<button class="pe-control-btn" data-action="ha-vacuum" data-node="${nodeKey}" data-cmd="return_to_base">Dock</button>`;
      html += "</div></div>";
    }
    if (nodeRole === "appliance" && haInfo) {
      hasControls = true;
      const isOn = haInfo.sublabel && haInfo.sublabel.toLowerCase().includes("running");
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Appliance</div>';
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Status</span>
      <span style="color:${isOn ? "#60c060" : "#a89870"}">${haInfo.sublabel || "Unknown"}</span>
    </div>`;
      html += "</div>";
    }
    if (nodeRole === "tv" && haInfo) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Media Player</div>';
      html += '<div class="pe-control-row" style="gap:8px;justify-content:center">';
      html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="turn_on">On</button>`;
      html += `<button class="pe-control-btn" data-action="ha-media" data-node="${nodeKey}" data-cmd="turn_off">Off</button>`;
      html += "</div></div>";
    }
    const ethernetRoles = ["server", "desktop", "laptop", "nas", "vm", "router", "ap", "switch", "bridge"];
    if (topoNode?.ip) {
      hasControls = true;
      html += '<div class="pe-control-section"><div class="pe-control-section-title">Network</div>';
      html += `<div class="pe-control-row">
      <span class="pe-control-label">Ping</span>
      <button class="pe-control-btn" data-action="ping" data-ip="${topoNode.ip}">Test Connection</button>
    </div>`;
      if (topoNode.mac && ethernetRoles.includes(nodeRole)) {
        html += `<div class="pe-control-row">
        <span class="pe-control-label">Wake-on-LAN</span>
        <button class="pe-control-btn" data-action="wol" data-mac="${topoNode.mac}" data-ip="${topoNode.ip}">Send Magic Packet</button>
      </div>`;
      }
      if (nodeRole === "router" || nodeRole === "ap" || nodeRole === "server" || nodeRole === "nas") {
        html += `<div class="pe-control-row">
        <span class="pe-control-label">SSH</span>
        <button class="pe-control-btn" data-action="ssh" data-ip="${topoNode.ip}">Connect</button>
      </div>`;
      }
      if (nodeRole === "router" || nodeRole === "ap") {
        html += `<div class="pe-control-row">
        <span class="pe-control-label">Reboot</span>
        <button class="pe-control-btn danger" data-action="reboot" data-ip="${topoNode.ip}">Restart Device</button>
      </div>`;
      }
      html += "</div>";
    }
    if (!hasControls) {
      html = `<div class="pe-control-empty">No controls available for this ${nodeRole || "node"}.</div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", handleControlAction);
      el.addEventListener("input", handleControlAction);
    });
  }
  __name(renderControlPane, "renderControlPane");
  function renderGroupPane(nodeKey) {
    const body = document.getElementById("pe-group-body");
    const titleEl = document.getElementById("pe-group-title");
    const countEl = document.getElementById("pe-group-count");
    if (!body) return;
    const groupConfig = lastStatus?.groups?.[nodeKey];
    if (!groupConfig || !groupConfig.entities) {
      body.innerHTML = '<div class="pe-stats-empty">Not a group node.</div>';
      return;
    }
    const entities = groupConfig.entities;
    const fnType = groupConfig.fn || "";
    const also = groupConfig.also || [];
    const allStates = lastStatus?._ha_raw || null;
    const info = infraNodes[nodeKey];
    const nodeName = info ? info.name : nodeKey;
    titleEl.textContent = nodeName + " \u2014 Members";
    let html = "";
    let memberCount = 0;
    if (Array.isArray(entities)) {
      memberCount = entities.length;
      countEl.textContent = `${memberCount} members`;
      entities.forEach((eid) => {
        const entityName = eid.split(".").pop().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const domain = eid.split(".")[0];
        html += `<div class="pe-group-member">`;
        html += `<div class="pe-group-member-icon">${_groupMemberIcon(domain, fnType)}</div>`;
        html += `<div class="pe-group-member-info">`;
        html += `<div class="pe-group-member-name">${entityName}</div>`;
        html += `<div class="pe-group-member-id">${eid}</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    } else if (typeof entities === "object") {
      const keys = Object.entries(entities);
      memberCount = keys.length;
      countEl.textContent = `${memberCount} sensors`;
      keys.forEach(([label, eid]) => {
        const entityName = label.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        html += `<div class="pe-group-member">`;
        html += `<div class="pe-group-member-icon">\u{1F4CA}</div>`;
        html += `<div class="pe-group-member-info">`;
        html += `<div class="pe-group-member-name">${entityName}</div>`;
        html += `<div class="pe-group-member-id">${eid}</div>`;
        html += `</div>`;
        html += `</div>`;
      });
    }
    if (also.length) {
      html += '<div class="pe-stats-section"><div class="pe-stats-section-title">Linked Nodes</div>';
      also.forEach((nid) => {
        const alsoNode = _topology?.nodes.find((n) => n.id === nid);
        const label = alsoNode?.label || nid;
        html += `<div class="pe-group-member">`;
        html += `<div class="pe-group-member-icon">${alsoNode?.icon || "\u2753"}</div>`;
        html += `<div class="pe-group-member-info">`;
        html += `<div class="pe-group-member-name">${label}</div>`;
        html += `<div class="pe-group-member-id">${nid} (shares this group's state)</div>`;
        html += `</div>`;
        html += `</div>`;
      });
      html += "</div>";
    }
    body.innerHTML = html;
  }
  __name(renderGroupPane, "renderGroupPane");
  function _groupMemberIcon(domain, fnType) {
    const icons = {
      climate: "\u{1F321}\uFE0F",
      camera: "\u{1F4F9}",
      media_player: "\u{1F50A}",
      switch: "\u{1F50C}",
      light: "\u{1F4A1}",
      fan: "\u{1F32C}\uFE0F",
      vacuum: "\u{1F916}",
      sensor: "\u{1F4CA}",
      binary_sensor: "\u{1F4CA}",
      humidifier: "\u{1F4A7}",
      select: "\u2699\uFE0F"
    };
    return icons[domain] || "\u2022";
  }
  __name(_groupMemberIcon, "_groupMemberIcon");
  async function handleControlAction(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    const nodeKey = el.dataset.node;
    const statusEl = document.getElementById("pe-control-status");
    try {
      statusEl.textContent = "Sending...";
      statusEl.style.color = "#c0a030";
      let endpoint, body;
      switch (action) {
        case "wled-power": {
          const newState = el.dataset.state === "on";
          endpoint = `/wled/${nodeKey}/state`;
          body = { on: newState };
          break;
        }
        case "wled-brightness": {
          endpoint = `/wled/${nodeKey}/state`;
          body = { bri: parseInt(el.value) };
          const pctSpan = el.nextElementSibling;
          if (pctSpan) pctSpan.textContent = Math.round(el.value / 255 * 100) + "%";
          break;
        }
        case "wled-effect": {
          endpoint = `/wled/${nodeKey}/state`;
          body = { fx: parseInt(el.dataset.effect) };
          break;
        }
        case "ha-switch": {
          const isOn = el.classList.contains("active");
          endpoint = `/ha/switch/${isOn ? "off" : "on"}`;
          body = { node: nodeKey };
          break;
        }
        case "ping": {
          endpoint = `/ping/${el.dataset.ip}`;
          break;
        }
        case "wol": {
          endpoint = `/wol`;
          body = { mac: el.dataset.mac, ip: el.dataset.ip };
          break;
        }
        case "reboot": {
          if (!confirm(`Reboot ${nodeKey}? This will disconnect the device temporarily.`)) {
            statusEl.textContent = "Cancelled";
            statusEl.style.color = "#a89870";
            return;
          }
          endpoint = `/ssh/${el.dataset.ip}/reboot`;
          break;
        }
        case "ssh": {
          statusEl.textContent = "Opening terminal...";
          window.open(`ssh://${el.dataset.ip}`, "_blank");
          return;
        }
        default:
          statusEl.textContent = "Unknown action";
          statusEl.style.color = "#c04040";
          return;
      }
      const resp = await fetch(endpoint, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : void 0
      });
      if (resp.ok) {
        statusEl.textContent = "Done";
        statusEl.style.color = "#60a040";
        if (action === "wled-power" || action === "ha-switch") {
          el.classList.toggle("active");
        }
      } else {
        statusEl.textContent = "Failed";
        statusEl.style.color = "#c04040";
      }
    } catch (err) {
      statusEl.textContent = "Error";
      statusEl.style.color = "#c04040";
      console.error("Control action error:", err);
    }
  }
  __name(handleControlAction, "handleControlAction");
  var _linksBody = document.getElementById("pe-links-body");
  var _linksTarget = document.getElementById("pe-links-target");
  var _linksType = document.getElementById("pe-links-type");
  var _linksVlan = document.getElementById("pe-links-vlan");
  if (_topology) {
    _topology.nodes.forEach((n) => {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = `${n.label} (${n.id})`;
      _linksTarget.appendChild(opt);
    });
  }
  function _getNodeConns(nodeId) {
    if (!_topology) return [];
    return _topology.connections.map((c, i) => ({ ...c, _idx: i })).filter((c) => c.from === nodeId || c.to === nodeId);
  }
  __name(_getNodeConns, "_getNodeConns");
  function _nodeLabel(id) {
    const n = _topology?.nodes.find((nd) => nd.id === id);
    return n ? n.label : id;
  }
  __name(_nodeLabel, "_nodeLabel");
  function renderConnectionsPane(nodeKey) {
    if (!_linksBody) return;
    const conns = _getNodeConns(nodeKey);
    if (!conns.length) {
      _linksBody.innerHTML = '<div class="pe-link-empty">No connections bound to this node.</div>';
      return;
    }
    _linksBody.innerHTML = "";
    conns.forEach((c) => {
      const row = document.createElement("div");
      row.className = "pe-link-row";
      const isFrom = c.from === nodeKey;
      const other = isFrom ? c.to : c.from;
      row.innerHTML = `<span class="pe-link-dir">${isFrom ? "\u2192" : "\u2190"}</span><span class="pe-link-node" data-nav="${other}">${_nodeLabel(other)}</span><span class="pe-link-type">${c.type}</span>` + (c.vlan ? `<span class="pe-link-vlan">V${c.vlan}</span>` : "") + (c.collectd ? `<span class="pe-link-vlan">${c.collectd}</span>` : "") + `<button class="pe-link-del" data-idx="${c._idx}" title="Remove connection">\xD7</button>`;
      _linksBody.appendChild(row);
    });
    _linksBody.querySelectorAll(".pe-link-node").forEach((el) => {
      el.addEventListener("click", () => {
        const target = el.dataset.nav;
        const tn = _topology?.nodes.find((nd) => nd.id === target);
        if (tn) {
          panToNode(tn.x, tn.y);
          openPersonaEditor(target);
        }
      });
    });
    _linksBody.querySelectorAll(".pe-link-del").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx);
        const conn = _topology.connections[idx];
        if (!conn) return;
        _topology.connections.splice(idx, 1);
        if (_connPaths[idx]) {
          _connPaths[idx].remove();
          _connPaths.splice(idx, 1);
        }
        _saveConnections();
        renderConnectionsPane(nodeKey);
      });
    });
    _linksTarget.querySelectorAll("option").forEach((o) => o.hidden = o.value === nodeKey);
  }
  __name(renderConnectionsPane, "renderConnectionsPane");
  function _saveConnections() {
    if (!_topology) return;
    fetch("/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connections: _topology.connections })
    });
  }
  __name(_saveConnections, "_saveConnections");
  document.getElementById("pe-links-add-btn").addEventListener("click", () => {
    const target = _linksTarget.value;
    if (!target || !currentEditNode) return;
    const type = _linksType.value;
    const vlan = _linksVlan.value ? parseInt(_linksVlan.value) : void 0;
    const conn = { from: currentEditNode, to: target, type };
    if (vlan) conn.vlan = vlan;
    _topology.connections.push(conn);
    _addConnectionPath(conn, _topology.connections.length - 1);
    _saveConnections();
    renderConnectionsPane(currentEditNode);
    _linksTarget.value = "";
  });
  function _addConnectionPath(c, idx) {
    const connSvg = document.getElementById("connection-svg");
    if (!connSvg) return;
    const fp = _getNodePos(c.from), tp = _getNodePos(c.to);
    if (!fp || !tp) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", _computePathD(fp, tp, 0, 0, c.from, c.to));
    path.setAttribute("class", "conn-line " + (CONN_TYPE_TO_CLASS[c.type] || "conn-active"));
    path.dataset.to = c.collectd || c.to;
    path.dataset.from = c.from;
    path.dataset.fromNode = c.from;
    path.dataset.toNode = c.to;
    connSvg.appendChild(path);
    _connPaths[idx] = path;
  }
  __name(_addConnectionPath, "_addConnectionPath");
  var _shellHistory = {};
  var _shellOutput = document.getElementById("pe-shell-output");
  var _shellInput = document.getElementById("pe-shell-input");
  function renderShellPane(nodeKey) {
    const info = infraNodes[nodeKey];
    _shellOutput.innerHTML = "";
    if (!info || !info.sshHost) {
      _shellOutput.innerHTML = '<div class="pe-shell-info">No SSH sigil bound to this node.</div>';
      _shellInput.disabled = true;
      _shellInput.placeholder = "unavailable";
      return;
    }
    _shellInput.disabled = false;
    _shellInput.placeholder = `runs on ${info.sshHost}...`;
    (_shellHistory[nodeKey] || []).forEach((e) => _appendShellEntry(e));
    _shellOutput.scrollTop = _shellOutput.scrollHeight;
  }
  __name(renderShellPane, "renderShellPane");
  function _appendShellEntry(entry) {
    const cmd = document.createElement("div");
    cmd.className = "pe-shell-cmd";
    cmd.textContent = "$ " + entry.cmd;
    _shellOutput.appendChild(cmd);
    if (entry.output) {
      const out = document.createElement("div");
      out.textContent = entry.output;
      _shellOutput.appendChild(out);
    }
    if (entry.error) {
      const err = document.createElement("div");
      err.className = "pe-shell-err";
      err.textContent = entry.error;
      _shellOutput.appendChild(err);
    }
  }
  __name(_appendShellEntry, "_appendShellEntry");
  async function _runShellCmd(nodeKey, command) {
    const info = infraNodes[nodeKey];
    if (!info?.sshHost) return;
    const cmd = document.createElement("div");
    cmd.className = "pe-shell-cmd";
    cmd.textContent = "$ " + command;
    _shellOutput.appendChild(cmd);
    const spin = document.createElement("div");
    spin.className = "pe-shell-running";
    spin.textContent = "Invoking distant arcana...";
    _shellOutput.appendChild(spin);
    _shellOutput.scrollTop = _shellOutput.scrollHeight;
    _shellInput.disabled = true;
    try {
      const r = await fetch("/ssh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: info.sshHost, command })
      });
      const d = await r.json();
      spin.remove();
      const entry = { cmd: command, output: d.output || "", error: d.error || null };
      if (entry.output) {
        const out = document.createElement("div");
        out.textContent = entry.output;
        _shellOutput.appendChild(out);
      }
      if (entry.error) {
        const err = document.createElement("div");
        err.className = "pe-shell-err";
        err.textContent = entry.error;
        _shellOutput.appendChild(err);
      }
      (_shellHistory[nodeKey] || (_shellHistory[nodeKey] = [])).push(entry);
    } catch (e) {
      spin.remove();
      const err = document.createElement("div");
      err.className = "pe-shell-err";
      err.textContent = "Connection lost to the realm.";
      _shellOutput.appendChild(err);
    }
    _shellInput.disabled = false;
    _shellInput.focus();
    _shellOutput.scrollTop = _shellOutput.scrollHeight;
  }
  __name(_runShellCmd, "_runShellCmd");
  _shellInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim() && currentEditNode) {
      e.preventDefault();
      const cmd = e.target.value.trim();
      e.target.value = "";
      _runShellCmd(currentEditNode, cmd);
    }
  });
  document.getElementById("map-world").addEventListener("dblclick", (e) => {
    const node = e.target.closest(".realm-node");
    if (!node) return;
    e.stopPropagation();
    const key = node.dataset.tip;
    if (key) openPersonaEditor(key);
  });
  var _spellPages = document.querySelectorAll("#spellbook .spell-page");
  var _spellTabs = document.querySelectorAll(".spell-tab");
  var _spellPage = 0;
  function _showSpellPage(idx) {
    _spellPage = Math.max(0, Math.min(idx, _spellPages.length - 1));
    _spellPages.forEach((p, i) => {
      p.style.display = i === _spellPage ? "" : "none";
    });
    _spellTabs.forEach((t, i) => t.classList.toggle("active", i === _spellPage));
    saveSettings();
  }
  __name(_showSpellPage, "_showSpellPage");
  _spellTabs.forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      _showSpellPage(parseInt(tab.dataset.spell));
    });
  });
  var _PRESETS = {
    minimal: { "fx-ambient": 0.05, "fx-nodes": 0.1, "fx-leylines": 0.05, "fx-glow": 0.3, "fx-pulse": 0.5, "fx-leyglow": 0.2, "traffic-scale": 0.5 },
    cinematic: { "fx-ambient": 0.6, "fx-nodes": 0.8, "fx-leylines": 0.7, "fx-glow": 2, "fx-pulse": 0.8, "fx-leyglow": 1.5, "traffic-scale": 1.5 },
    performance: { "fx-ambient": 0, "fx-nodes": 0.2, "fx-leylines": 0.1, "fx-glow": 0.5, "fx-pulse": 1, "fx-leyglow": 0.5, "traffic-scale": 0.5 },
    full: { "fx-ambient": 0.5, "fx-nodes": 0.7, "fx-leylines": 0.6, "fx-glow": 1.5, "fx-pulse": 1.2, "fx-leyglow": 1.2, "traffic-scale": 1.2 }
  };
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = _PRESETS[btn.dataset.preset];
      if (!preset) return;
      for (const [id, val] of Object.entries(preset)) {
        const sl = document.getElementById(id + "-slider");
        if (sl) {
          sl.value = val;
          sl.dispatchEvent(new Event("input"));
        }
      }
      if (btn.dataset.preset === "performance") {
        const q = document.getElementById("fx-quality-select");
        if (q) {
          q.value = "low";
          q.dispatchEvent(new Event("change"));
        }
      }
      saveSettings();
    });
  });
  var _SECTION_DEFAULTS = {
    effects: { "fx-ambient": 0.3, "fx-nodes": 0.5, "fx-glow": 1, "fx-pulse": 1 },
    biomes: { "biome-land": 1, "biome-glow": 1, "biome-roads": 0.5, "biome-peaks": 0.5, "biome-grid": 0.03 },
    scale: { "master-scale": 1, "node-scale": 1, "text-scale": 1, "bubble-scale": 1 },
    "ley-lines": { "traffic-scale": 1, "fx-leylines": 0.4, "fx-leyglow": 1 },
    "arcane-grid": { "grid-opacity": 0.4, "grid-scale": 1, "grid-hue": 0 },
    ambiance: { "compass-scale": 1, "sparkle-density": 0.5, "ambient-glow": 0.3, "vignette": 0.3 },
    topographic: { "topo-opacity": 0.6, "topo-spread": 120, "topo-contour": 12, "topo-rw": 0.4, "topo-rd": 0.6 },
    layout: { "layout-attract": 4, "layout-repulse": 80, "layout-edge": 80, "layout-spacing": 8, "layout-tilt": 0 }
  };
  document.querySelectorAll(".section-reset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.dataset.reset === "layers") {
        [
          "vis-terrain",
          "vis-topo",
          "vis-nodes",
          "vis-connections",
          "vis-labels",
          "vis-sublabels",
          "vis-regions",
          "vis-vlanlabels",
          "vis-bubbles",
          "vis-titlebar",
          "vis-search",
          "vis-statuspanel",
          "vis-legend",
          "vis-codex",
          "vis-questlog",
          "vis-cartographer",
          "vis-energy",
          "vis-nodelist"
        ].forEach((id) => {
          const cb = document.getElementById(id);
          if (cb && !cb.checked) {
            cb.checked = true;
            cb.dispatchEvent(new Event("change"));
          }
        });
        const gridCb = document.getElementById("vis-grid");
        if (gridCb && gridCb.checked) {
          gridCb.checked = false;
          gridCb.dispatchEvent(new Event("change"));
        }
        ["layer-terrain", "layer-terrain-orig", "layer-topo", "layer-grid", "layer-nodes", "layer-connections", "layer-labels", "layer-sublabels", "layer-regions", "layer-vlanlabels", "layer-bubbles"].forEach((id) => {
          const sl = document.getElementById(id + "-slider");
          if (sl) {
            sl.value = id === "layer-grid" ? 0.4 : 1;
            sl.dispatchEvent(new Event("input"));
          }
        });
        saveSettings();
        return;
      }
      if (btn.dataset.reset === "arcane-grid") {
        const toggleCb = document.getElementById("grid-toggle-cb");
        const pulseCb = document.getElementById("grid-pulse-cb");
        if (toggleCb && toggleCb.checked) {
          toggleCb.checked = false;
          toggleCb.dispatchEvent(new Event("change"));
        }
        if (pulseCb && !pulseCb.checked) {
          pulseCb.checked = true;
          pulseCb.dispatchEvent(new Event("change"));
        }
      }
      const defaults = _SECTION_DEFAULTS[btn.dataset.reset];
      if (!defaults) return;
      for (const [id, val] of Object.entries(defaults)) {
        const sl = document.getElementById(id + "-slider");
        if (sl) {
          sl.value = val;
          sl.dispatchEvent(new Event("input"));
        }
      }
      saveSettings();
    });
  });
  document.querySelectorAll(".legend-section-header").forEach((header) => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("collapsed");
      saveSettings();
    });
  });
  document.querySelector('.legend-section[data-section="nodes"]')?.classList.add("collapsed");
  document.querySelector('.legend-section[data-section="effects"]')?.classList.add("collapsed");
  (/* @__PURE__ */ __name((function initEffectsControls() {
    function wire(id, getter, setter) {
      const sl = document.getElementById(id + "-slider");
      const vl = document.getElementById(id + "-val");
      if (!sl) return;
      sl.addEventListener("input", () => {
        const v = parseFloat(sl.value);
        setter(v);
        if (vl) vl.textContent = id === "fx-pulse" ? v.toFixed(1) + "x" : v.toFixed(2);
        scheduleSave();
      });
    }
    __name(wire, "wire");
    wire("fx-ambient", () => _sparkleAmbient, (v) => {
      _sparkleAmbient = v;
    });
    wire("fx-nodes", () => _sparkleNodes, (v) => {
      _sparkleNodes = v;
    });
    wire("fx-leylines", () => _sparkleLeyLines, (v) => {
      _sparkleLeyLines = v;
    });
    wire("fx-glow", () => _sparkleGlowSize, (v) => {
      _sparkleGlowSize = v;
    });
    wire("fx-pulse", null, (v) => {
      document.documentElement.style.setProperty("--pulse-speed", v);
      document.querySelectorAll(".pulse-ring").forEach((el) => {
        el.style.animationDuration = 2.5 / v + "s";
      });
      document.querySelectorAll(".data-pulse-ring").forEach((el) => {
        el.style.animationDuration = 0.8 / v + "s";
      });
    });
    wire("fx-leyglow", null, (v) => {
      const svg = document.getElementById("connections");
      if (svg) svg.style.opacity = Math.min(1, v);
      document.querySelectorAll("#connections path").forEach((p) => {
        p.style.filter = v > 0 ? "" : "none";
        p.style.opacity = Math.min(1, v);
      });
    });
    const qSel = document.getElementById("fx-quality-select");
    const qVal = document.getElementById("fx-quality-val");
    if (qSel) {
      qVal.textContent = _perfTier + (_isMobile ? " (mobile)" : "");
      qSel.addEventListener("change", () => {
        if (qSel.value === "auto") {
          setPerfTier(_isMobile ? _cpuCores >= 6 ? "medium" : "low" : "high");
        } else {
          setPerfTier(qSel.value);
        }
        qVal.textContent = _perfTier;
        _topoHash = "";
        if (_topoEnabled) renderTopoLayer(_lastTopoCollectd);
        saveSettings();
      });
    }
  }), "initEffectsControls"))();
  var _realmSearch = document.getElementById("realm-search");
  var _searchInput = document.getElementById("search-input");
  var _searchResults = document.getElementById("search-results");
  var _searchClear = document.getElementById("search-clear");
  var _searchIndex = null;
  var _searchActiveIdx = -1;
  var _panelEntries = [
    { id: "_panel:realm-panel", icon: "&#9876;", label: "Realm Vitals", sub: "CPU, RAM, GPU gauges", kind: "Panel", sel: "#realm-panel" },
    { id: "_panel:legend", icon: "&#128506;", label: "Legend", sub: "Ley line & node type key", kind: "Panel", sel: "#legend" },
    { id: "_panel:spellbook", icon: "&#128214;", label: "Spellbook", sub: "Effects, layers, layout", kind: "Panel", sel: "#spellbook" },
    { id: "_panel:realm-codex", icon: "&#128220;", label: "Realm Codex", sub: "Lore, tools, personas", kind: "Panel", sel: "#realm-codex" },
    { id: "_panel:quest-log", icon: "&#9753;", label: "Quest Log", sub: "Events, quests, speech", kind: "Panel", sel: "#quest-log" },
    { id: "_panel:node-list", icon: "&#9873;", label: "Realm Census", sub: "All nodes by region", kind: "Panel", sel: "#node-list" },
    { id: "_panel:cartographer", icon: "&#128506;", label: "Cartographer", sub: "Map layout modes", kind: "Panel", sel: "#cartographer" },
    { id: "_panel:energy-panel", icon: "&#9889;", label: "Realm Energy", sub: "Energy & data flow", kind: "Panel", sel: "#energy-panel" },
    { id: "_panel:debug-panel", icon: "&#128302;", label: "Arcane Mirror", sub: "Debug panel, diagnostics", kind: "Panel", sel: "#debug-panel" },
    { id: "_panel:latency-panel", icon: "&#127992;", label: "Arcane Pulse", sub: "Ping latency, network health", kind: "Panel", sel: "#latency-panel" },
    { id: "_panel:firewall-panel", icon: "&#128737;", label: "Realm Wards", sub: "Firewall, VLANs, network segments", kind: "Panel", sel: "#firewall-panel" }
  ];
  function _buildSearchIndex() {
    if (!_topology || _searchIndex) return;
    _searchIndex = [
      // Topology nodes
      ..._topology.nodes.map((n) => ({
        id: n.id,
        icon: n.icon,
        label: n.label,
        sub: n.sublabel || "",
        ip: n.ip || "",
        type: n.type || "core",
        _text: [n.label, n.sublabel, n.ip, n.id, n.type].filter(Boolean).join(" ").toLowerCase()
      })),
      // Panel entries
      ..._panelEntries.map((p) => ({
        id: p.id,
        icon: p.icon,
        label: p.label,
        sub: p.sub,
        ip: "",
        type: p.kind,
        sel: p.sel,
        _text: [p.label, p.sub, p.kind].join(" ").toLowerCase()
      }))
    ];
    _indexPanelControls();
  }
  __name(_buildSearchIndex, "_buildSearchIndex");
  var _panelIcons = {
    "spellbook": "&#128214;",
    "legend": "&#128506;",
    "realm-codex": "&#128220;",
    "realm-panel": "&#9876;",
    "cartographer": "&#128506;",
    "energy-panel": "&#9889;",
    "debug-panel": "&#128302;",
    "quest-log": "&#9753;",
    "node-list": "&#9873;",
    "latency-panel": "&#127992;",
    "firewall-panel": "&#128737;"
  };
  var _panelNames = {
    "spellbook": "Spellbook",
    "legend": "Legend",
    "realm-codex": "Realm Codex",
    "realm-panel": "Realm Vitals",
    "cartographer": "Cartographer",
    "energy-panel": "Energy",
    "debug-panel": "Arcane Mirror",
    "quest-log": "Quest Log",
    "node-list": "Census",
    "latency-panel": "Arcane Pulse",
    "firewall-panel": "Realm Wards"
  };
  function _indexPanelControls() {
    const panelIds = ["spellbook", "legend", "realm-codex", "realm-panel", "cartographer", "energy-panel", "latency-panel", "firewall-panel"];
    for (const panelId of panelIds) {
      const panel = document.getElementById(panelId);
      if (!panel) continue;
      const icon = _panelIcons[panelId] || "&#9881;";
      const panelName = _panelNames[panelId] || panelId;
      panel.querySelectorAll('input[type="range"]').forEach((slider) => {
        const label = _findControlLabel(slider);
        if (!label) return;
        const section = _findSectionName(slider);
        const sub = section ? `${panelName} \u203A ${section}` : panelName;
        _searchIndex.push({
          id: `_ctrl:${slider.id || label}`,
          icon,
          label,
          sub,
          ip: "",
          type: "Slider",
          _el: slider,
          _text: [label, sub, "slider", panelName, section].filter(Boolean).join(" ").toLowerCase()
        });
      });
      panel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        const label = _findControlLabel(cb);
        if (!label) return;
        const section = _findSectionName(cb);
        const sub = section ? `${panelName} \u203A ${section}` : panelName;
        _searchIndex.push({
          id: `_ctrl:${cb.id || label}`,
          icon,
          label,
          sub,
          ip: "",
          type: "Toggle",
          _el: cb,
          _text: [label, sub, "toggle", "switch", panelName, section].filter(Boolean).join(" ").toLowerCase()
        });
      });
      panel.querySelectorAll("select").forEach((sel) => {
        const label = _findControlLabel(sel);
        if (!label) return;
        const section = _findSectionName(sel);
        const optTexts = [...sel.options].map((o) => o.textContent).join(" ");
        const sub = section ? `${panelName} \u203A ${section}` : panelName;
        _searchIndex.push({
          id: `_ctrl:${sel.id || label}`,
          icon,
          label,
          sub,
          ip: "",
          type: "Select",
          _el: sel,
          _text: [label, sub, "select", optTexts, panelName, section].filter(Boolean).join(" ").toLowerCase()
        });
      });
      panel.querySelectorAll('input[type="number"]').forEach((input) => {
        const label = _findControlLabel(input);
        if (!label) return;
        const section = _findSectionName(input);
        const sub = section ? `${panelName} \u203A ${section}` : panelName;
        _searchIndex.push({
          id: `_ctrl:${input.id || label}`,
          icon,
          label,
          sub,
          ip: "",
          type: "Setting",
          _el: input,
          _text: [label, sub, "setting", panelName, section].filter(Boolean).join(" ").toLowerCase()
        });
      });
      panel.querySelectorAll(".preset-btn").forEach((btn) => {
        const label = btn.textContent.trim();
        const section = _findSectionName(btn);
        const sub = section ? `${panelName} \u203A ${section}` : panelName;
        _searchIndex.push({
          id: `_ctrl:preset-${btn.dataset.preset || label}`,
          icon,
          label: `Preset: ${label}`,
          sub,
          ip: "",
          type: "Action",
          _el: btn,
          _text: [label, "preset", sub, panelName, section].filter(Boolean).join(" ").toLowerCase()
        });
      });
    }
    document.querySelectorAll(".carto-mode").forEach((btn) => {
      const name = btn.querySelector(".carto-name")?.textContent || "";
      const iconEl = btn.querySelector(".carto-icon")?.innerHTML || "";
      _searchIndex.push({
        id: `_ctrl:layout-${btn.dataset.layout}`,
        icon: iconEl || "&#128506;",
        label: `Layout: ${name}`,
        sub: "Cartographer",
        ip: "",
        type: "Layout",
        _el: btn,
        _text: [name, "layout", "cartographer", "map", btn.dataset.layout].join(" ").toLowerCase()
      });
    });
    document.querySelectorAll(".codex-tool code").forEach((code) => {
      const toolName = code.textContent;
      const desc = code.parentElement?.querySelector("span")?.textContent || "";
      const group = code.closest(".codex-tools")?.previousElementSibling?.textContent?.replace(/\d+ tools/, "").trim() || "";
      _searchIndex.push({
        id: `_ctrl:tool-${toolName}`,
        icon: "&#128220;",
        label: toolName,
        sub: `${group} \u203A ${desc}`.substring(0, 60),
        ip: "",
        type: "Tool",
        _el: code.closest(".codex-tool"),
        _text: [toolName, desc, group, "tool", "codex", "mcp"].join(" ").toLowerCase()
      });
    });
    document.querySelectorAll("#legend .legend-item").forEach((item) => {
      const label = item.textContent.trim();
      const section = _findSectionName(item);
      _searchIndex.push({
        id: `_ctrl:legend-${label}`,
        icon: "&#128506;",
        label,
        sub: `Legend \u203A ${section || ""}`,
        ip: "",
        type: "Legend",
        _el: item,
        _text: [label, "legend", section, "ley line", "node type"].filter(Boolean).join(" ").toLowerCase()
      });
    });
  }
  __name(_indexPanelControls, "_indexPanelControls");
  function _findControlLabel(el) {
    const parent = el.closest(".traffic-control, .layer-row, .cfg-row");
    if (parent) {
      const lbl = parent.querySelector("label");
      if (lbl) {
        const clone = lbl.cloneNode(true);
        clone.querySelectorAll(".tc-val, .topo-switch").forEach((v) => v.remove());
        return clone.textContent.trim();
      }
      const name = parent.querySelector(".layer-name");
      if (name) return name.textContent.trim();
    }
    const wrapper = el.closest("label");
    if (wrapper) {
      const clone = wrapper.cloneNode(true);
      clone.querySelectorAll("input, select, .tc-val, .topo-switch-track").forEach((v) => v.remove());
      return clone.textContent.trim();
    }
    return "";
  }
  __name(_findControlLabel, "_findControlLabel");
  function _findSectionName(el) {
    const section = el.closest(".legend-section");
    if (section) {
      const header = section.querySelector(".legend-section-header");
      if (header) {
        const clone = header.cloneNode(true);
        clone.querySelectorAll(".legend-chevron, .section-reset").forEach((v) => v.remove());
        return clone.textContent.trim();
      }
    }
    const codexSection = el.closest(".codex-section");
    if (codexSection) {
      const h4 = codexSection.querySelector("h4");
      if (h4) return h4.textContent.replace(/\d+ tools/, "").trim();
    }
    return "";
  }
  __name(_findSectionName, "_findSectionName");
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
        if (idx === -1) {
          match = false;
          break;
        }
        if (entry.label.toLowerCase().startsWith(t)) score += 10;
        else if (entry.ip.startsWith(t)) score += 5;
        else score += 1;
      }
      if (match) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 16).map((s) => s.entry);
  }
  __name(_searchRealm, "_searchRealm");
  function _highlightMatch(text, query) {
    if (!query) return text;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let result = text;
    for (const t of terms) {
      const idx = result.toLowerCase().indexOf(t);
      if (idx !== -1) {
        result = result.slice(0, idx) + "<mark>" + result.slice(idx, idx + t.length) + "</mark>" + result.slice(idx + t.length);
      }
    }
    return result;
  }
  __name(_highlightMatch, "_highlightMatch");
  function _renderSearchResults(results, query) {
    _searchActiveIdx = -1;
    if (!results.length) {
      _searchResults.textContent = "";
      const empty = document.createElement("div");
      empty.className = "sr-empty";
      empty.textContent = "No matches in the Realm";
      _searchResults.appendChild(empty);
      _searchResults.classList.add("open");
      return;
    }
    const typeName = {
      core: "Core",
      infra: "Infra",
      tower: "Tower",
      bridge: "Bridge",
      cluster: "IoT",
      tailscale: "Astral",
      Panel: "Panel",
      Slider: "Slider",
      Toggle: "Toggle",
      Select: "Setting",
      Setting: "Setting",
      Action: "Action",
      Layout: "Layout",
      Tool: "Tool",
      Legend: "Legend"
    };
    const frag = document.createDocumentFragment();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const item = document.createElement("div");
      item.className = "sr-item";
      item.dataset.idx = i;
      item.dataset.nodeId = r.id;
      item.dataset.kind = r.type || "";
      const iconEl = document.createElement("div");
      iconEl.className = "sr-icon";
      iconEl.innerHTML = r.icon;
      const info = document.createElement("div");
      info.className = "sr-info";
      const name = document.createElement("div");
      name.className = "sr-name";
      name.innerHTML = _highlightMatch(r.label, query);
      const sub = document.createElement("div");
      sub.className = "sr-sub";
      sub.textContent = r.sub;
      info.appendChild(name);
      info.appendChild(sub);
      const typeEl = document.createElement("div");
      typeEl.className = "sr-type";
      typeEl.textContent = typeName[r.type] || r.type;
      item.appendChild(iconEl);
      item.appendChild(info);
      item.appendChild(typeEl);
      frag.appendChild(item);
    }
    _searchResults.textContent = "";
    _searchResults.appendChild(frag);
    _searchResults.classList.add("open");
  }
  __name(_renderSearchResults, "_renderSearchResults");
  function _restorePanel(panelEl) {
    if (!panelEl) return;
    if (panelEl.classList.contains("panel-sealed")) {
      _unsealPanel(panelEl);
      _saveFormation();
      return;
    }
    panelEl.style.display = "";
    const id = panelEl.id;
    const visMap = {
      "realm-panel": "vis-statuspanel",
      "legend": "vis-legend",
      "spellbook": "vis-spellbook",
      "realm-codex": "vis-codex",
      "quest-log": "vis-questlog",
      "node-list": "vis-nodelist",
      "cartographer": "vis-cartographer",
      "energy-panel": "vis-energy",
      "debug-panel": "vis-debug",
      "latency-panel": "vis-latency",
      "firewall-panel": "vis-firewall",
      "wifi-panel": "vis-wifi"
    };
    const visId = visMap[id] || "vis-" + id;
    const visCb = document.getElementById(visId);
    if (visCb && !visCb.checked) {
      visCb.checked = true;
      visCb.dispatchEvent(new Event("change"));
    }
  }
  __name(_restorePanel, "_restorePanel");
  function _flashElement(el) {
    if (!el) return;
    el.style.transition = "box-shadow 0.3s, outline 0.3s";
    el.style.boxShadow = "0 0 20px rgba(240,216,144,0.5)";
    el.style.outline = "2px solid rgba(240,216,144,0.6)";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.boxShadow = "";
      el.style.outline = "";
      el.style.outlineOffset = "";
    }, 1500);
  }
  __name(_flashElement, "_flashElement");
  function _navigateToSearchResult(nodeId) {
    _searchInput.blur();
    _searchResults.classList.remove("open");
    if (nodeId.startsWith("_ctrl:")) {
      const entry = _searchIndex?.find((e) => e.id === nodeId);
      const el = entry?._el;
      if (!el) return;
      const panel = el.closest(".panel, #persona-editor, #debug-panel");
      if (panel) {
        _restorePanel(panel);
        const body = panel.querySelector("#codex-body");
        if (body) body.style.display = "";
      }
      const spellPage = el.closest(".spell-page");
      if (spellPage) {
        const pageIdx = parseInt(spellPage.dataset.spellPage);
        if (!isNaN(pageIdx)) _showSpellPage(pageIdx);
      }
      const section = el.closest(".legend-section");
      if (section && section.classList.contains("collapsed")) {
        section.classList.remove("collapsed");
      }
      const codexTools = el.closest(".codex-tools");
      if (codexTools && !codexTools.classList.contains("open")) {
        codexTools.classList.add("open");
        const h4 = codexTools.previousElementSibling;
        if (h4) h4.classList.add("open");
      }
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        _flashElement(el.closest(".traffic-control, .layer-row, .cfg-row, .codex-tool, .legend-item, .carto-mode, .preset-btn") || el);
        if (el.tagName === "SELECT" || el.tagName === "INPUT") el.focus();
        if (el.tagName === "BUTTON") el.click();
      });
      return;
    }
    if (nodeId.startsWith("_panel:")) {
      const entry = _searchIndex?.find((e) => e.id === nodeId);
      const panelEl = entry?.sel ? document.querySelector(entry.sel) : null;
      if (panelEl) {
        _restorePanel(panelEl);
        panelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        _flashElement(panelEl);
      }
      return;
    }
    const nodeEl = document.querySelector(`[data-tip="${CSS.escape(nodeId)}"]`);
    if (!nodeEl) return;
    const nodeLeft = parseInt(nodeEl.style.left) || 0;
    const nodeTop = parseInt(nodeEl.style.top) || 0;
    scale = 1.2;
    panX = canvas.clientWidth / 2 - nodeLeft * scale;
    panY = canvas.clientHeight / 2 - nodeTop * scale;
    applyTransform();
    showHighlight(nodeEl, { color: "rgba(240,216,144,0.5)" });
  }
  __name(_navigateToSearchResult, "_navigateToSearchResult");
  if (_searchInput) {
    _searchInput.addEventListener("input", () => {
      const rawVal = _searchInput.value;
      const isMagic = rawVal.startsWith("?");
      const q = rawVal.trim();
      _realmSearch.classList.toggle("magic-morph", isMagic);
      _searchClear.style.display = q ? "" : "none";
      if (!q) {
        _searchResults.classList.remove("open");
        return;
      }
      if (isMagic) {
        _searchResults.textContent = "";
        const hint = document.createElement("div");
        hint.className = "sr-empty";
        hint.textContent = q.length > 1 ? "\u2728 Press Enter to consult the Oracle..." : "\u2728 Ask the Oracle anything...";
        _searchResults.appendChild(hint);
        _searchResults.classList.add("open");
      } else {
        _renderSearchResults(_searchRealm(q), q);
      }
    });
    _searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && _realmSearch.classList.contains("magic-morph")) {
        const q = _searchInput.value.trim();
        if (q.length > 1) {
          e.preventDefault();
          const query = q.substring(1).trim();
          fetch("/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "oracle_query", node: "scrying-pool", text: query, color: "#c080ff" })
          }).catch((err) => console.error("Oracle query failed:", err));
          _searchResults.textContent = "";
          const sent = document.createElement("div");
          sent.className = "sr-empty";
          sent.textContent = "\u2728 Query cast into the Aether...";
          _searchResults.appendChild(sent);
          setTimeout(() => {
            _searchInput.value = "";
            _realmSearch.classList.remove("magic-morph");
            _searchResults.classList.remove("open");
            _searchClear.style.display = "none";
          }, 1200);
          return;
        }
      }
      const items = _searchResults.querySelectorAll(".sr-item");
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        _searchActiveIdx = Math.min(_searchActiveIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle("active", i === _searchActiveIdx));
        items[_searchActiveIdx]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        _searchActiveIdx = Math.max(_searchActiveIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle("active", i === _searchActiveIdx));
        items[_searchActiveIdx]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && _searchActiveIdx >= 0) {
        e.preventDefault();
        const id = items[_searchActiveIdx]?.dataset.nodeId;
        if (id) _navigateToSearchResult(id);
      } else if (e.key === "Escape") {
        _searchResults.classList.remove("open");
        _searchInput.blur();
      }
    });
    _searchResults.addEventListener("click", (e) => {
      const item = e.target.closest(".sr-item");
      if (item) _navigateToSearchResult(item.dataset.nodeId);
    });
    _searchClear.addEventListener("click", () => {
      _searchInput.value = "";
      _searchClear.style.display = "none";
      _searchResults.classList.remove("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#realm-search")) _searchResults.classList.remove("open");
    });
  }
  var NODE_TYPE_ORDER = ["core", "infra", "tower", "bridge", "cluster", "tailscale"];
  var NODE_TYPE_LABELS = {
    core: "Inner Sanctum",
    infra: "Infrastructure",
    tower: "Guardian Towers",
    bridge: "Signal Bridges",
    cluster: "Enchanted Quarters",
    tailscale: "Astral Sea"
  };
  function buildNodeList() {
    if (!_topology) return;
    const body = document.getElementById("node-list-body");
    const countEl = document.getElementById("nl-count");
    if (!body) return;
    body.innerHTML = "";
    const groups = {};
    _topology.nodes.forEach((n) => {
      const type = n.type || "core";
      if (!groups[type]) groups[type] = [];
      groups[type].push(n);
    });
    let total = 0;
    NODE_TYPE_ORDER.forEach((type) => {
      const nodes = groups[type];
      if (!nodes || !nodes.length) return;
      total += nodes.length;
      const group = document.createElement("div");
      group.className = "nl-group";
      group.innerHTML = `<div class="nl-group-title">${NODE_TYPE_LABELS[type] || type}</div>`;
      nodes.forEach((n) => {
        const item = document.createElement("div");
        item.className = "nl-item";
        item.dataset.nodeId = n.id;
        item.innerHTML = `<div class="nl-status unknown"></div><span class="nl-icon">${n.icon}</span><div class="nl-info"><div class="nl-name">${n.label}</div><div class="nl-sub">${n.ip || n.sublabel || ""}</div></div>`;
        item.addEventListener("click", () => {
          const nodeEl = document.querySelector(`[data-tip="${n.id}"]`);
          if (!nodeEl) return;
          const nodeLeft = parseInt(nodeEl.style.left) || 0;
          const nodeTop = parseInt(nodeEl.style.top) || 0;
          const cw = canvas.clientWidth, ch = canvas.clientHeight;
          scale = 1.2;
          panX = cw / 2 - nodeLeft * scale;
          panY = ch / 2 - nodeTop * scale;
          applyTransform();
          showHighlight(nodeEl, { color: "rgba(240,216,144,0.5)" });
        });
        group.appendChild(item);
      });
      body.appendChild(group);
    });
    if (countEl) countEl.textContent = total + " nodes";
  }
  __name(buildNodeList, "buildNodeList");
  function updateNodeListStatus(d) {
    if (!d || !d.astral) return;
    const nodeStatus = d.astral.nodes || {};
    document.querySelectorAll(".nl-item").forEach((item) => {
      const id = item.dataset.nodeId;
      const dot = item.querySelector(".nl-status");
      if (!dot) return;
      const statusKey = Object.keys(nodeStatus).find((k) => k.toLowerCase() === id.toLowerCase()) || Object.keys(nodeStatus).find((k) => k.replace(/-/g, "").toLowerCase() === id.replace(/-/g, "").toLowerCase());
      const online = statusKey ? nodeStatus[statusKey] : null;
      dot.className = "nl-status " + (online === true ? "online" : online === false ? "offline" : "unknown");
    });
  }
  __name(updateNodeListStatus, "updateNodeListStatus");
  buildNodeList();
  function updateCensusSubLabels(d) {
    if (!d) return;
    document.querySelectorAll(".nl-item").forEach((item) => {
      const id = item.dataset.nodeId;
      if (!id) return;
      const subEl = item.querySelector(".nl-sub");
      if (!subEl) return;
      const haInfo = d.ha?.[id];
      if (haInfo?.sublabel) {
        subEl.textContent = haInfo.sublabel;
        return;
      }
      const wledInfo = d.wled?.[id];
      if (wledInfo?.online) {
        subEl.textContent = wledInfo.on ? `On \u2022 ${wledInfo.effect || "Solid"}` : "Off";
        return;
      }
      const wifi = d.wifi?.[id];
      if (wifi?.signal != null) {
        subEl.textContent = `${wifi.signal} dBm \u2022 ${wifi.ap || ""}`;
        return;
      }
    });
  }
  __name(updateCensusSubLabels, "updateCensusSubLabels");
  var _lastCensusCount = _topology?.nodes?.length || 0;
  setInterval(() => {
    const n = _topology?.nodes?.length || 0;
    if (n !== _lastCensusCount) {
      _lastCensusCount = n;
      buildNodeList();
    }
  }, 1e4);
  function updateEnergyPanel(data) {
    if (!data || data.error) return;
    const fmt = /* @__PURE__ */ __name((v, unit, decimals = 1) => v != null ? `${v.toFixed(decimals)}${unit}` : "--", "fmt");
    const fmtW = /* @__PURE__ */ __name((w) => {
      if (w == null) return "--";
      if (Math.abs(w) >= 1e3) return `${(w / 1e3).toFixed(1)}kW`;
      return `${Math.round(w)}W`;
    }, "fmtW");
    const solarEl = document.getElementById("energy-solar");
    if (solarEl) {
      const pv = data.solar_kw;
      solarEl.textContent = pv != null ? fmtW(pv) : "--";
    }
    const battEl = document.getElementById("energy-battery");
    if (battEl) {
      const soc = data.battery_soc;
      const power = data.battery_power;
      if (soc != null) {
        const dir = power < -10 ? " +" : power > 10 ? " -" : "";
        battEl.textContent = `${Math.round(soc)}%${dir}`;
      } else {
        battEl.textContent = "--";
      }
    }
    const gridEl = document.getElementById("energy-grid");
    if (gridEl) {
      const gp = data.grid_power;
      if (gp != null) {
        gridEl.textContent = `${gp.toFixed(2)}kW`;
      } else {
        gridEl.textContent = "--";
      }
    }
    const houseEl = document.getElementById("energy-house");
    if (houseEl) {
      const load = data.house_load;
      houseEl.textContent = load != null ? fmtW(load) : "--";
    }
    const todayEl = document.getElementById("energy-today");
    if (todayEl) {
      const today = data.today_load_kwh;
      todayEl.textContent = today != null ? `${today.toFixed(1)}kWh` : "--";
    }
    const exportEl = document.getElementById("energy-export");
    if (exportEl) {
      const exp = data.grid_export_kwh;
      exportEl.textContent = exp != null ? `${exp.toFixed(0)}kWh` : "--";
    }
  }
  __name(updateEnergyPanel, "updateEnergyPanel");
  var _originalPositions = {};
  if (_topology) _topology.nodes.forEach((n) => {
    _originalPositions[n.id] = { x: n.x, y: n.y };
  });
  var _connIdx = [];
  if (_topology) {
    const idxMap = {};
    _topology.nodes.forEach((n, i) => {
      idxMap[n.id] = i;
    });
    _topology.connections.forEach((c) => {
      const a = idxMap[c.from], b = idxMap[c.to];
      if (a !== void 0 && b !== void 0) _connIdx.push([a, b, c.from, c.to]);
    });
  }
  var _nodeVlans = [];
  if (_topology) {
    const vlanCounts = {};
    _topology.connections.forEach((c) => {
      if (!c.vlan) return;
      [c.from, c.to].forEach((id) => {
        if (!vlanCounts[id]) vlanCounts[id] = {};
        vlanCounts[id][c.vlan] = (vlanCounts[id][c.vlan] || 0) + 1;
      });
    });
    _topology.nodes.forEach((n, i) => {
      if (vlanCounts[n.id]) {
        let best = 6, max = 0;
        for (const [v, c] of Object.entries(vlanCounts[n.id])) {
          if (c > max) {
            max = c;
            best = +v;
          }
        }
        _nodeVlans[i] = best;
      } else {
        _nodeVlans[i] = n.tailscale || n.type === "tailscale" ? 0 : 6;
      }
    });
  }
  var _layoutRunning = false;
  var _layoutWorker = null;
  var _layoutMode = "world-tree";
  var _layoutAttract = 4;
  var _layoutRepulse = 80;
  var _layoutEdgeLen = 80;
  var _layoutSpacing = 8;
  function autoArrangeLayout(mode) {
    if (!_topology || _layoutRunning) return;
    if (mode) _layoutMode = mode;
    _layoutRunning = true;
    document.querySelectorAll(".carto-mode").forEach((b) => {
      b.classList.toggle("active", b.dataset.layout === _layoutMode);
    });
    const activeBtn = document.querySelector(`.carto-mode[data-layout="${_layoutMode}"]`);
    if (activeBtn) activeBtn.classList.add("running");
    const castBtn = document.getElementById("layout-auto-btn");
    if (castBtn) {
      castBtn.classList.add("running");
      castBtn.textContent = "\u2728 Casting\u2026";
    }
    if (_layoutWorker) {
      _layoutWorker.terminate();
      _layoutWorker = null;
    }
    const nodeData = _topology.nodes.map((n) => ({ id: n.id, type: n.type }));
    const connData = _connIdx.map((c) => [c[0], c[1]]);
    _layoutWorker = new Worker("layout-worker.js?v=2");
    _layoutWorker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === "progress") {
        if (castBtn) castBtn.textContent = `\u2728 ${Math.round(msg.step / msg.total * 100)}%`;
        return;
      }
      if (msg.type === "done") {
        const x = new Float32Array(msg.x);
        const y = new Float32Array(msg.y);
        const pos = [];
        for (let i = 0; i < msg.count; i++) pos.push({ x: x[i], y: y[i] });
        _animateToPositions(pos, 900, () => {
          _layoutRunning = false;
          generateTerrain();
          updateRegionLabels();
          if (activeBtn) activeBtn.classList.remove("running");
          if (castBtn) {
            castBtn.classList.remove("running");
            castBtn.textContent = "\u2728 Cast Arrangement";
          }
        });
        _layoutWorker.terminate();
        _layoutWorker = null;
      }
    };
    _layoutWorker.onerror = function(err) {
      console.error("Layout worker error:", err);
      _layoutRunning = false;
      if (activeBtn) activeBtn.classList.remove("running");
      if (castBtn) {
        castBtn.classList.remove("running");
        castBtn.textContent = "\u2728 Cast Arrangement";
      }
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
      wifiMap: _wifiMap
    });
  }
  __name(autoArrangeLayout, "autoArrangeLayout");
  function resetToOriginalPositions() {
    if (_layoutRunning) return;
    const nodes = _topology.nodes;
    const pos = nodes.map((n) => {
      const orig = _originalPositions[n.id];
      return orig ? { x: orig.x, y: orig.y } : { x: n.x, y: n.y };
    });
    _animateToPositions(pos, 700, () => {
      generateTerrain();
      updateRegionLabels();
    });
  }
  __name(resetToOriginalPositions, "resetToOriginalPositions");
  var _nodeElCache = {};
  if (_topology) _topology.nodes.forEach((n) => {
    _nodeElCache[n.id] = document.querySelector(`[data-tip="${n.id}"]`);
  });
  function _animateToPositions(targetPos, duration, onDone) {
    const nodes = _topology.nodes;
    const startPos = nodes.map((n) => ({ x: n.x, y: n.y }));
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      for (let i = 0; i < nodes.length; i++) {
        const nx = startPos[i].x + (targetPos[i].x - startPos[i].x) * e;
        const ny = startPos[i].y + (targetPos[i].y - startPos[i].y) * e;
        nodes[i].x = nx;
        nodes[i].y = ny;
        const el = _nodeElCache[nodes[i].id];
        if (el) {
          el.style.left = nx + "px";
          el.style.top = ny + "px";
        }
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
    __name(step, "step");
    requestAnimationFrame(step);
  }
  __name(_animateToPositions, "_animateToPositions");
  document.querySelectorAll(".carto-mode").forEach((btn) => {
    btn.addEventListener("click", () => autoArrangeLayout(btn.dataset.layout));
  });
  document.getElementById("layout-auto-btn")?.addEventListener("click", () => autoArrangeLayout());
  document.getElementById("layout-reset-btn")?.addEventListener("click", resetToOriginalPositions);
  (/* @__PURE__ */ __name((function wireLayoutSliders() {
    const sliders = [
      ["layout-attract", (v) => {
        _layoutAttract = v;
      }],
      ["layout-repulse", (v) => {
        _layoutRepulse = v;
      }],
      ["layout-edge", (v) => {
        _layoutEdgeLen = v;
      }],
      ["layout-spacing", (v) => {
        _layoutSpacing = v;
      }],
      ["layout-tilt", (v) => {
        setMapTilt(v);
        applyTransform();
      }, (v) => v + "\xB0"]
    ];
    for (const entry of sliders) {
      const [id, setter, fmt] = entry;
      const sl = document.getElementById(id + "-slider");
      const vl = document.getElementById(id + "-val");
      if (!sl) continue;
      sl.addEventListener("input", () => {
        const v = parseFloat(sl.value);
        setter(v);
        if (vl) vl.textContent = fmt ? fmt(v) : v % 1 === 0 ? v : v.toFixed(1);
        scheduleSave();
      });
    }
  }), "wireLayoutSliders"))();
  (/* @__PURE__ */ __name((function wireBiomeSliders() {
    const sliders = [
      ["biome-land", (v) => {
        _biomeLandScale = v;
        generateTerrain();
      }],
      ["biome-glow", (v) => {
        _biomeGlow = v;
        generateTerrain();
      }],
      ["biome-roads", (v) => {
        _biomeRoads = v;
        generateTerrain();
      }],
      ["biome-peaks", (v) => {
        _biomePeaks = v;
        generateTerrain();
      }],
      ["biome-grid", (v) => {
        _biomeGrid = v;
        generateTerrain();
      }]
    ];
    for (const [id, setter] of sliders) {
      const sl = document.getElementById(id + "-slider");
      const vl = document.getElementById(id + "-val");
      if (!sl) continue;
      sl.addEventListener("input", () => {
        const v = parseFloat(sl.value);
        setter(v);
        if (vl) vl.textContent = v.toFixed(2);
        scheduleSave();
      });
    }
  }), "wireBiomeSliders"))();
  (/* @__PURE__ */ __name((function wireVisibilityToggles() {
    const toggles = [
      // Map layers
      ["vis-terrain", "#terrain-dynamic"],
      ["vis-terrain-orig", "#terrain-original"],
      ["vis-topo", "#topo-svg"],
      ["vis-connections", "#connections"],
      ["vis-nodes", null, ".realm-node"],
      ["vis-labels", null, ".node-label"],
      ["vis-sublabels", null, ".node-sublabel"],
      ["vis-regions", "#region-labels"],
      ["vis-vlanlabels", null, ".vlan-label"],
      ["vis-bubbles", null, ".speech-bubble"],
      // Panels
      ["vis-titlebar", "#title-bar"],
      ["vis-search", "#realm-search"],
      ["vis-statuspanel", "#realm-panel"],
      ["vis-legend", "#legend"],
      ["vis-spellbook", "#spellbook"],
      ["vis-codex", "#realm-codex"],
      ["vis-questlog", "#quest-log"],
      ["vis-cartographer", "#cartographer"],
      ["vis-energy", "#energy-panel"],
      ["vis-nodelist", "#node-list"],
      ["vis-debug", "#debug-panel"],
      ["vis-latency", "#latency-panel"],
      ["vis-firewall", "#firewall-panel"],
      ["vis-wifi", "#wifi-panel"]
    ];
    for (const [id, sel, multiSel] of toggles) {
      const cb = document.getElementById(id);
      if (!cb) continue;
      cb.addEventListener("change", () => {
        const show = cb.checked;
        if (sel) {
          const el = document.querySelector(sel);
          if (el) {
            if (el.classList.contains("panel-sealed")) {
              const rune = document.querySelector(`.sealed-rune[data-panel-id="${el.id}"]`);
              if (rune) rune.remove();
              el.classList.remove("panel-sealed");
              const dock = document.getElementById("sealed-dock");
              const tray = dock?.querySelector(".dock-tray");
              if (tray && tray.children.length === 0) {
                dock.classList.remove("has-runes");
                dock.style.bottom = "-80px";
              }
            }
            el.style.display = show ? "" : "none";
          }
        } else if (multiSel) {
          document.querySelectorAll(multiSel).forEach((el) => {
            el.style.visibility = show ? "" : "hidden";
          });
          if (!window._visState) window._visState = {};
          window._visState[multiSel] = show;
        }
        saveSettings();
        if (!_restoring) _saveFormation();
      });
    }
    document.querySelectorAll(".panel-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setPanelMode(btn.dataset.mode));
    });
    const opacityLayers = [
      ["layer-terrain-orig-slider", "#terrain-original", false],
      ["layer-terrain-slider", "#terrain-dynamic", false],
      ["layer-topo-slider", "#topo-svg", false],
      ["layer-connections-slider", "#connections", false],
      ["layer-regions-slider", "#region-labels", false],
      ["layer-nodes-slider", null, true, ".realm-node"],
      ["layer-labels-slider", null, true, ".node-label"],
      ["layer-sublabels-slider", null, true, ".node-sublabel"],
      ["layer-vlanlabels-slider", null, true, ".vlan-label"],
      ["layer-bubbles-slider", null, true, ".speech-bubble"],
      // Panel opacity sliders
      ["panel-titlebar-slider", "#title-bar", false],
      ["panel-search-slider", "#realm-search", false],
      ["panel-vitals-slider", "#realm-panel", false],
      ["panel-legend-slider", "#legend", false],
      ["panel-spellbook-slider", "#spellbook", false],
      ["panel-codex-slider", "#realm-codex", false],
      ["panel-questlog-slider", "#quest-log", false],
      ["panel-cartographer-slider", "#cartographer", false],
      ["panel-energy-slider", "#energy-panel", false],
      ["panel-nodelist-slider", "#node-list", false],
      ["panel-mirror-slider", "#debug-panel", false],
      ["panel-latency-slider", "#latency-panel", false],
      ["panel-firewall-slider", "#firewall-panel", false],
      ["panel-wifi-slider", "#wifi-panel", false]
    ];
    for (const [sliderId, sel, isMulti, multiSel] of opacityLayers) {
      const sl = document.getElementById(sliderId);
      if (!sl) continue;
      sl.addEventListener("input", () => {
        const v = sl.value;
        if (sel) {
          const el = document.querySelector(sel);
          if (el) el.style.opacity = v;
        } else if (multiSel) {
          document.querySelectorAll(multiSel).forEach((el) => {
            el.style.opacity = v;
          });
          if (!window._layerOpacity) window._layerOpacity = {};
          window._layerOpacity[multiSel] = v;
        }
        saveSettings();
      });
    }
  }), "wireVisibilityToggles"))();
  var moteCanvas = document.createElement("canvas");
  moteCanvas.id = "mote-canvas";
  moteCanvas.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:300";
  document.body.appendChild(moteCanvas);
  var moteCtx = moteCanvas.getContext("2d");
  var motes = [];
  var _fpsEl = document.createElement("div");
  _fpsEl.style.cssText = "position:fixed;top:4px;right:4px;z-index:9999;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.7);padding:2px 6px;border-radius:3px;pointer-events:none;display:none";
  document.body.appendChild(_fpsEl);
  var _fpsFrames = 0;
  var _fpsLast = performance.now();
  var _fpsMotes = 0;
  function _fpsUpdate() {
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLast >= 1e3) {
      _fpsEl.textContent = `${_fpsFrames} fps | ${_fpsMotes} motes`;
      _fpsFrames = 0;
      _fpsLast = now;
    }
  }
  __name(_fpsUpdate, "_fpsUpdate");
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "F") _fpsEl.style.display = _fpsEl.style.display === "none" ? "" : "none";
  });
  function resizeMoteCanvas() {
    moteCanvas.width = window.innerWidth;
    moteCanvas.height = window.innerHeight;
  }
  __name(resizeMoteCanvas, "resizeMoteCanvas");
  resizeMoteCanvas();
  window.addEventListener("resize", resizeMoteCanvas);
  function spawnMote(x, y, color) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.3 + Math.random() * 1.2;
    motes.push({
      x,
      y,
      vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 0.5,
      vy: Math.sin(angle) * speed + (Math.random() - 0.5) * 0.5 - 0.3,
      life: 1,
      decay: 0.012 + Math.random() * 0.02,
      size: 1.5 + Math.random() * 2.5,
      color: color || [240, 216, 144],
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.05 + Math.random() * 0.1
    });
  }
  __name(spawnMote, "spawnMote");
  var _sparkleAmbient = 0.3;
  var _sparkleNodes = 0.5;
  var _sparkleLeyLines = 0.4;
  var _sparkleGlowSize = 1;
  var _sparkleRect = null;
  var _sparkleColors = [[240, 216, 144], [180, 200, 255], [160, 255, 180], [200, 160, 255], [255, 200, 120]];
  function _spawnAmbientSparkles() {
    if (_sparkleAmbient <= 0 || motes.length >= _PERF.moteCap) return;
    const rate = _sparkleAmbient * 0.15 / _PERF.sparkleDiv;
    if (Math.random() < rate) {
      const c = _sparkleColors[Math.random() * 5 | 0];
      motes.push({
        x: Math.random() * moteCanvas.width,
        y: Math.random() * moteCanvas.height,
        vx: (Math.random() - 0.5) * 0.2,
        vy: -0.1 - Math.random() * 0.3,
        life: 1,
        decay: 4e-3 + Math.random() * 8e-3,
        size: 1 + Math.random() * 2,
        color: c,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.03 + Math.random() * 0.06,
        twinkle: true
      });
    }
  }
  __name(_spawnAmbientSparkles, "_spawnAmbientSparkles");
  function _spawnNodeSparkles() {
    if (_sparkleNodes <= 0 || !_topology || !_topology.nodes || motes.length >= _PERF.moteCap) return;
    const rate = _sparkleNodes * 0.02 / _PERF.sparkleDiv;
    if (!_sparkleRect) return;
    const rect = _sparkleRect;
    const cw = moteCanvas.width, ch = moteCanvas.height;
    for (const n of _topology.nodes) {
      if (Math.random() > rate) continue;
      const iw = n.iconStyle && n.iconStyle.width ? parseInt(n.iconStyle.width) : 64;
      const ih = n.iconStyle && n.iconStyle.height ? parseInt(n.iconStyle.height) : 64;
      const sx = rect.left + (n.x + iw / 2) * scale + (Math.random() - 0.5) * iw * scale * 0.6;
      const sy = rect.top + (n.y + ih / 2) * scale + (Math.random() - 0.5) * ih * scale * 0.6;
      if (sx < -20 || sx > cw + 20 || sy < -20 || sy > ch + 20) continue;
      if (motes.length >= _PERF.moteCap) break;
      const isCore = n.type === "core";
      motes.push({
        x: sx,
        y: sy,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.3 - Math.random() * 0.6,
        life: 1,
        decay: 8e-3 + Math.random() * 0.012,
        size: isCore ? 2 + Math.random() * 2 : 1 + Math.random() * 1.5,
        color: isCore ? [255, 220, 100] : n.type === "tower" ? [120, 200, 255] : [160, 255, 140],
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.04 + Math.random() * 0.08,
        twinkle: true
      });
    }
  }
  __name(_spawnNodeSparkles, "_spawnNodeSparkles");
  var _leyColors = { wan: [100, 180, 255], bridge: [180, 120, 255], _default: [140, 220, 180] };
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
        x: sx,
        y: sy,
        vx: (tn.x - fn.x) * scale * 4e-4 + (Math.random() - 0.5) * 0.3,
        vy: (tn.y - fn.y) * scale * 4e-4 - 0.15,
        life: 1,
        decay: 0.01 + Math.random() * 0.015,
        size: 1 + Math.random() * 1.5,
        color: _leyColors[c.type] || _leyColors._default,
        wobble: Math.random() * Math.PI * 2,
        wobbleSpeed: 0.05 + Math.random() * 0.1,
        twinkle: true
      });
    }
  }
  __name(_spawnLeyLineSparkles, "_spawnLeyLineSparkles");
  var _sparkleTimer = 0;
  var _PI2 = Math.PI * 2;
  var _moteSkipFrame = false;
  var _motePaused = false;
  document.addEventListener("visibilitychange", () => {
    _motePaused = document.hidden;
    document.body.classList.toggle("reduce-motion", document.hidden);
  });
  var _sparkleRectWorld = document.getElementById("map-world");
  function _updateSparkleRect() {
    if (_sparkleRectWorld) _sparkleRect = _sparkleRectWorld.getBoundingClientRect();
  }
  __name(_updateSparkleRect, "_updateSparkleRect");
  window.addEventListener("resize", _updateSparkleRect);
  _updateSparkleRect();
  function animateMotes() {
    if (_motePaused) {
      requestAnimationFrame(animateMotes);
      return;
    }
    if (_zoomActive) {
      requestAnimationFrame(animateMotes);
      return;
    }
    _moteSkipFrame = !_moteSkipFrame;
    if (_moteSkipFrame) {
      requestAnimationFrame(animateMotes);
      return;
    }
    const cw = moteCanvas.width, ch = moteCanvas.height;
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
      const aq = (a * 15 + 0.5 | 0) / 15;
      const key = `${r},${g},${b},${aq.toFixed(2)}`;
      (colorBuckets[key] || (colorBuckets[key] = [])).push(m.x, m.y, sz);
      if (doGlow) {
        const gaq = (a * 0.12 * 15 + 0.5 | 0) / 15;
        const gkey = `${r},${g},${b},${gaq.toFixed(3)}`;
        (glowBuckets[gkey] || (glowBuckets[gkey] = [])).push(m.x, m.y, sz * 2.5);
      }
      if (doStar && m.twinkle && a > 0.3 && sz > 1.5) {
        moteCtx.strokeStyle = `rgba(${r},${g},${b},${(a * 0.4).toFixed(2)})`;
        moteCtx.lineWidth = 0.5;
        const cr = sz * 3;
        moteCtx.beginPath();
        moteCtx.moveTo(m.x - cr, m.y);
        moteCtx.lineTo(m.x + cr, m.y);
        moteCtx.moveTo(m.x, m.y - cr);
        moteCtx.lineTo(m.x, m.y + cr);
        moteCtx.stroke();
      }
    }
    motes.length = writeIdx;
    if (doGlow) {
      for (const key in glowBuckets) {
        const arr = glowBuckets[key];
        moteCtx.fillStyle = `rgba(${key})`;
        moteCtx.beginPath();
        for (let j = 0; j < arr.length; j += 3) {
          moteCtx.moveTo(arr[j] + arr[j + 2], arr[j + 1]);
          moteCtx.arc(arr[j], arr[j + 1], arr[j + 2], 0, _PI2);
        }
        moteCtx.fill();
      }
    }
    for (const key in colorBuckets) {
      const arr = colorBuckets[key];
      moteCtx.fillStyle = `rgba(${key})`;
      moteCtx.beginPath();
      for (let j = 0; j < arr.length; j += 3) {
        moteCtx.moveTo(arr[j] + arr[j + 2], arr[j + 1]);
        moteCtx.arc(arr[j], arr[j + 1], arr[j + 2], 0, _PI2);
      }
      moteCtx.fill();
    }
    _fpsMotes = writeIdx;
    _fpsUpdate();
    requestAnimationFrame(animateMotes);
  }
  __name(animateMotes, "animateMotes");
  animateMotes();
  var _sseTrafficMap = null;
  var _sseConnected = false;
  var _latencyMap = null;
  var _wifiMap = null;
  (/* @__PURE__ */ __name((function initSSE() {
    const sse = new EventSource(SSE_URL);
    let _sseRestoreMode = true;
    let _trafficRafPending = false;
    sse.addEventListener("traffic", (e) => {
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
    sse.addEventListener("realm-event", (e) => {
      const evt = JSON.parse(e.data);
      renderEvent(evt, _sseRestoreMode);
    });
    sse.addEventListener("topology", (e) => {
      refreshTopology();
    });
    sse.addEventListener("status", (e) => {
      const d = JSON.parse(e.data);
      _sseRestoreMode = false;
      updateUI(d);
      if (d.wifi) _wifiMap = d.wifi;
      if (!liveOk) {
        liveOk = true;
        console.log("Realm Map: SSE live data connected");
        const loadEl = document.getElementById("realm-loading");
        if (loadEl) {
          loadEl.classList.add("dismissed");
          setTimeout(() => loadEl.remove(), 1e3);
        }
      }
    });
    sse.addEventListener("energy", (e) => {
      const data = JSON.parse(e.data);
      updateEnergyPanel(data);
    });
    sse.addEventListener("latency", (e) => {
      _latencyMap = JSON.parse(e.data);
      updateLatencyPanel();
    });
    sse.addEventListener("open", () => {
      if (!_sseConnected) {
        _sseConnected = true;
        _sseRestoreMode = true;
        console.log("Realm Map: SSE connected");
      }
    });
    sse.addEventListener("error", () => {
      if (_sseConnected) {
        _sseConnected = false;
        console.warn("Realm Map: SSE disconnected, reconnecting...");
        showOffline();
      }
    });
  }), "initSSE"))();
  var LAYOUT_KEY = "realm-map-layout-v2";
  var SETTINGS_KEY = "realm-map-settings-v3";
  var _PANEL_IDS = [
    "realm-panel",
    "legend",
    "spellbook",
    "quest-log",
    "realm-codex",
    "node-list",
    "energy-panel",
    "latency-panel",
    "firewall-panel",
    "wifi-panel",
    "cartographer",
    "debug-panel"
  ];
  var _MODE_DESCS = {
    manual: "Panels stay where you place them.",
    auto: "Panels auto-size and tile to fill the viewport beautifully.",
    focus: "Unfocused panels fade. Hover to summon."
  };
  var _panelMode = "manual";
  function setPanelMode(mode) {
    const prev = _panelMode;
    _panelMode = mode;
    document.body.classList.remove("panel-mode-manual", "panel-mode-auto", "panel-mode-focus", "dynamic-panels");
    document.body.classList.add("panel-mode-" + mode);
    if (mode === "auto") document.body.classList.add("dynamic-panels");
    document.querySelectorAll(".panel-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    const desc = document.getElementById("panel-mode-desc");
    if (desc) desc.textContent = _MODE_DESCS[mode] || "";
    if (mode === "auto" && prev !== "auto") {
      saveLayout();
    }
    if (prev === "auto" && mode !== "auto") {
      _PANEL_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.left = "";
        el.style.top = "";
        el.style.right = "";
        el.style.bottom = "";
        el.style.width = "";
        el.style.height = "";
        el.style.maxHeight = "";
        el.style.transform = "";
      });
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
              el.style.right = "auto";
              el.style.bottom = "auto";
              el.style.transform = "none";
              if (pos.width) el.style.width = pos.width;
              if (pos.height) {
                el.style.height = pos.height;
                el.style.maxHeight = "none";
              }
            });
          }
        }
      } catch (e) {
      }
      _PANEL_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.style.display === "none" || el.classList.contains("panel-sealed")) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let moved = false;
        let l = rect.left, t = rect.top;
        if (rect.right < 40) {
          l = 20;
          moved = true;
        }
        if (rect.left > vw - 40) {
          l = vw - rect.width - 20;
          moved = true;
        }
        if (rect.bottom < 40) {
          t = 60;
          moved = true;
        }
        if (rect.top > vh - 40) {
          t = vh - rect.height - 20;
          moved = true;
        }
        if (moved) {
          el.style.left = Math.round(Math.max(0, l)) + "px";
          el.style.top = Math.round(Math.max(56, t)) + "px";
          el.style.right = "auto";
          el.style.bottom = "auto";
        }
      });
    }
    if (mode === "auto") autoArrangePanels();
    saveSettings();
  }
  __name(setPanelMode, "setPanelMode");
  var _lastActivePanel = null;
  document.addEventListener("mousedown", (e) => {
    const p = e.target.closest(".panel, #debug-panel");
    if (p && _PANEL_IDS.includes(p.id)) _lastActivePanel = p.id;
  }, true);
  function _measurePanelWeight(el) {
    const importance = {
      "realm-panel": 3,
      "quest-log": 5,
      "realm-codex": 5,
      "firewall-panel": 4,
      "wifi-panel": 3,
      "node-list": 4,
      "latency-panel": 3,
      "spellbook": 3,
      "energy-panel": 2,
      "cartographer": 2,
      "legend": 2,
      "debug-panel": 4
    };
    const base = importance[el.id] || 3;
    const scrollChild = el.querySelector('[class*="-body"], .quest-cards, .spell-page:not([style*="display: none"]), .spell-page:not([style*="display:none"])');
    let contentRatio = 1;
    if (scrollChild) {
      const sh = scrollChild.scrollHeight || 100;
      const ch = scrollChild.clientHeight || 100;
      contentRatio = Math.min(3, sh / Math.max(ch, 1));
    }
    const focusBoost = _lastActivePanel === el.id ? 1.5 : 1;
    return base * (0.5 + contentRatio * 0.5) * focusBoost;
  }
  __name(_measurePanelWeight, "_measurePanelWeight");
  function autoArrangePanels() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const gap = 10;
    const topBar = 56;
    const pad = gap;
    const ax = pad, ay = topBar + pad;
    const aw = vw - pad * 2, ah = vh - topBar - pad * 2;
    const items = [];
    _PANEL_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.style.display === "none" || el.classList.contains("panel-sealed")) return;
      items.push({ id, el, weight: _measurePanelWeight(el) });
    });
    if (!items.length) return;
    items.sort((a, b) => b.weight - a.weight);
    const rects = /* @__PURE__ */ new Map();
    function _treemapSlice(itemList, bx, by, bw, bh, horizontal) {
      if (itemList.length === 0) return;
      if (itemList.length === 1) {
        rects.set(itemList[0].id, { x: bx, y: by, w: bw, h: bh, el: itemList[0].el });
        return;
      }
      const total = itemList.reduce((s, it) => s + it.weight, 0) || 1;
      let cumul = 0;
      let bestSplit = 1, bestAspectScore = Infinity;
      for (let i = 0; i < itemList.length - 1; i++) {
        cumul += itemList[i].weight;
        const frac2 = cumul / total;
        let a1w, a1h, a2w, a2h;
        if (horizontal) {
          a1w = bw * frac2;
          a1h = bh;
          a2w = bw * (1 - frac2);
          a2h = bh;
        } else {
          a1w = bw;
          a1h = bh * frac2;
          a2w = bw;
          a2h = bh * (1 - frac2);
        }
        const r1 = Math.max(a1w, a1h) / Math.max(Math.min(a1w, a1h), 1);
        const r2 = Math.max(a2w, a2h) / Math.max(Math.min(a2w, a2h), 1);
        const balance = Math.abs((i + 1) / itemList.length - 0.5);
        const score = r1 + r2 + balance * 2;
        if (score < bestAspectScore) {
          bestAspectScore = score;
          bestSplit = i + 1;
        }
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
    __name(_treemapSlice, "_treemapSlice");
    _treemapSlice(items, ax, ay, aw, ah, aw >= ah);
    rects.forEach((r, id) => {
      const el = r.el;
      el.style.position = "fixed";
      el.style.left = Math.round(r.x) + "px";
      el.style.top = Math.round(r.y) + "px";
      el.style.width = Math.round(Math.max(100, r.w)) + "px";
      el.style.height = Math.round(Math.max(60, r.h)) + "px";
      el.style.maxHeight = "none";
      el.style.right = "auto";
      el.style.bottom = "auto";
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      for (let s = 0; s < 3; s++) {
        setTimeout(() => {
          spawnMote(cx + (Math.random() - 0.5) * r.w * 0.5, cy + (Math.random() - 0.5) * r.h * 0.3, [192, 144, 255]);
        }, s * 70);
      }
    });
  }
  __name(autoArrangePanels, "autoArrangePanels");
  var _autoLayoutTimer;
  document.addEventListener("panel-layout-change", () => {
    if (_panelMode === "auto") {
      clearTimeout(_autoLayoutTimer);
      _autoLayoutTimer = setTimeout(autoArrangePanels, 350);
    }
  });
  var _autoResizeTimer;
  window.addEventListener("resize", () => {
    if (_panelMode === "auto") {
      clearTimeout(_autoResizeTimer);
      _autoResizeTimer = setTimeout(autoArrangePanels, 200);
    }
  });
  var _PERSIST_SLIDERS = [
    "master-scale",
    "traffic-scale",
    "node-scale",
    "text-scale",
    "bubble-scale",
    "update-speed",
    "fx-ambient",
    "fx-nodes",
    "fx-leylines",
    "fx-glow",
    "fx-pulse",
    "fx-leyglow",
    "topo-opacity",
    "topo-spread",
    "topo-contour",
    "topo-rw",
    "topo-rd",
    "grid-opacity",
    "grid-scale",
    "grid-hue",
    "layer-grid",
    "layout-attract",
    "layout-repulse",
    "layout-edge",
    "layout-spacing",
    "layout-tilt",
    "biome-land",
    "biome-glow",
    "biome-roads",
    "biome-peaks",
    "biome-grid",
    "layer-terrain-orig",
    "layer-terrain",
    "layer-topo",
    "layer-connections",
    "layer-regions",
    "layer-nodes",
    "layer-labels",
    "layer-sublabels",
    "layer-vlanlabels",
    "layer-bubbles",
    "panel-titlebar",
    "panel-search",
    "panel-vitals",
    "panel-legend",
    "panel-codex",
    "panel-spellbook",
    "panel-questlog",
    "panel-cartographer",
    "panel-energy",
    "panel-nodelist",
    "panel-mirror",
    "panel-latency",
    "panel-firewall",
    "panel-wifi",
    "layer-compass",
    "layer-sparkles",
    "layer-vignette",
    "compass-scale",
    "sparkle-density",
    "ambient-glow",
    "vignette"
  ];
  var _PERSIST_CHECKBOXES = [
    "topo-toggle-cb",
    "grid-toggle-cb",
    "grid-pulse-cb",
    "vis-terrain",
    "vis-terrain-orig",
    "vis-topo",
    "vis-grid",
    "vis-connections",
    "vis-nodes",
    "vis-labels",
    "vis-sublabels",
    "vis-regions",
    "vis-vlanlabels",
    "vis-bubbles",
    "vis-compass",
    "vis-sparkles",
    "vis-vignette",
    "vis-titlebar",
    "vis-search",
    "vis-statuspanel",
    "vis-legend",
    "vis-spellbook",
    "vis-codex",
    "vis-questlog",
    "vis-cartographer",
    "vis-energy",
    "vis-nodelist",
    "vis-debug",
    "vis-latency",
    "vis-firewall",
    "vis-wifi"
  ];
  var _saveTimer = null;
  function saveSettings() {
    if (_restoring) return;
    _initialRestoreDone = true;
    const vp = document.getElementById("map-viewport");
    const activePeTab = document.querySelector(".pe-tab.active");
    const s = {
      sliders: {},
      checkboxes: {},
      quality: null,
      collapsed: [],
      spellPage: _spellPage,
      zoom: { scale, panX, panY },
      selectedNode: currentEditNode,
      peTab: activePeTab?.dataset.peTab || "stats",
      mirrorTab: activeTab,
      panelMode: _panelMode
    };
    _PERSIST_SLIDERS.forEach((id) => {
      const sl = document.getElementById(id + "-slider");
      if (sl) s.sliders[id] = sl.value;
    });
    _PERSIST_CHECKBOXES.forEach((id) => {
      const cb = document.getElementById(id);
      if (cb) s.checkboxes[id] = cb.checked;
    });
    const qSel = document.getElementById("fx-quality-select");
    if (qSel) s.quality = qSel.value;
    document.querySelectorAll(".legend-section.collapsed").forEach((sec) => {
      const ds = sec.dataset.section;
      if (ds) s.collapsed.push(ds);
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      fetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s)
      }).catch(() => {
      });
    }, 500);
  }
  __name(saveSettings, "saveSettings");
  var _restoring = false;
  function _applySettings(s) {
    _restoring = true;
    if (s.sliders) {
      for (const [id, val] of Object.entries(s.sliders)) {
        const sl = document.getElementById(id + "-slider");
        if (sl) {
          sl.value = val;
          sl.dispatchEvent(new Event("input"));
        }
      }
    }
    if (s.checkboxes) {
      for (const [id, checked] of Object.entries(s.checkboxes)) {
        const cb = document.getElementById(id);
        if (cb && cb.checked !== checked) {
          cb.checked = checked;
          cb.dispatchEvent(new Event("change"));
        }
      }
    }
    if (s.quality) {
      const qSel = document.getElementById("fx-quality-select");
      if (qSel) {
        qSel.value = s.quality;
        qSel.dispatchEvent(new Event("change"));
      }
    }
    if (s.collapsed) {
      document.querySelectorAll(".legend-section").forEach((sec) => {
        const ds = sec.dataset.section;
        if (ds) sec.classList.toggle("collapsed", s.collapsed.includes(ds));
      });
    }
    if (s.spellPage != null) _showSpellPage(s.spellPage);
    if (s.zoom) {
      scale = s.zoom.scale ?? 1;
      panX = s.zoom.panX ?? 0;
      panY = s.zoom.panY ?? 0;
      applyTransform();
    }
    if (s.selectedNode) {
      openPersonaEditor(s.selectedNode);
      if (s.peTab) _switchToTab(s.peTab);
    }
    if (s.mirrorTab) {
      const tab = document.querySelector(`.log-tab[data-tab="${s.mirrorTab}"]`);
      if (tab) tab.click();
    }
    if (s.panelMode && _MODE_DESCS[s.panelMode]) {
      setPanelMode(s.panelMode);
    }
    _restoring = false;
  }
  __name(_applySettings, "_applySettings");
  var _initialRestoreDone = false;
  function restoreSettings() {
    if (new URLSearchParams(window.location.search).has("reset")) {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem("realm-panel-formation");
      localStorage.removeItem("realm-map-layout");
      fetch("/settings", { method: "DELETE" }).catch(() => {
      });
      window.history.replaceState({}, "", window.location.pathname);
      console.log("Settings reset");
      return true;
    }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) _applySettings(JSON.parse(raw));
    } catch (e) {
    }
    fetch("/settings").then((r) => r.ok ? r.json() : null).then((s) => {
      if (s && Object.keys(s).length > 0 && !_initialRestoreDone) {
        _applySettings(s);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      }
      _initialRestoreDone = true;
    }).catch(() => {
      _initialRestoreDone = true;
    });
    return true;
  }
  __name(restoreSettings, "restoreSettings");
  function saveLayout() {
    const layout = { panels: {}, nodes: {} };
    ["realm-panel", "legend", "spellbook", "quest-log", "realm-codex", "node-list", "debug-panel", "cartographer", "energy-panel", "latency-panel", "firewall-panel", "wifi-panel"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.style.left) {
        const p = { left: el.style.left, top: el.style.top };
        if (el.style.width) p.width = el.style.width;
        if (el.style.height) p.height = el.style.height;
        layout.panels[id] = p;
      }
    });
    document.querySelectorAll(".realm-node").forEach((n) => {
      const tip = n.dataset.tip;
      if (tip) layout.nodes[tip] = { left: n.style.left, top: n.style.top };
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _layout: layout })
    }).catch(() => {
    });
    saveSettings();
  }
  __name(saveLayout, "saveLayout");
  function _applyLayout(layout) {
    if (!layout) return false;
    let applied = false;
    if (layout.panels) {
      Object.entries(layout.panels).forEach(([id, pos]) => {
        const el = document.getElementById(id);
        if (el && pos.left) {
          el.style.left = pos.left;
          el.style.top = pos.top;
          el.style.right = "auto";
          el.style.bottom = "auto";
          el.style.transform = "none";
          if (pos.width) {
            el.style.width = pos.width;
          }
          if (pos.height) {
            el.style.height = pos.height;
            el.style.maxHeight = "none";
          }
        }
      });
      applied = true;
    }
    if (layout.nodes && Object.keys(layout.nodes).length) {
      Object.entries(layout.nodes).forEach(([tip, pos]) => {
        const el = document.querySelector(`[data-tip="${tip}"]`);
        if (el && pos.left) {
          el.style.left = pos.left;
          el.style.top = pos.top;
        }
        if (_topology && _topology.nodes && pos.left) {
          const tn = _topology.nodes.find((n) => n.id === tip);
          if (tn) {
            tn.x = parseInt(pos.left);
            tn.y = parseInt(pos.top);
          }
        }
      });
      _topoNodeMap = null;
      updateLinePositions();
      applied = true;
    }
    return applied;
  }
  __name(_applyLayout, "_applyLayout");
  function restoreLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        const layout = JSON.parse(raw);
        if (_applyLayout(layout)) return true;
      }
    } catch (e) {
    }
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/settings", false);
      xhr.send();
      if (xhr.status === 200) {
        const s = JSON.parse(xhr.responseText);
        if (s._layout) {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(s._layout));
          if (_applyLayout(s._layout)) return true;
        }
      }
    } catch (e) {
    }
    return false;
  }
  __name(restoreLayout, "restoreLayout");
  var _layoutSaveTimer = null;
  function scheduleSave() {
    if (_restoring || _layoutSaveTimer) return;
    _layoutSaveTimer = setTimeout(() => {
      _layoutSaveTimer = null;
      saveLayout();
    }, 500);
  }
  __name(scheduleSave, "scheduleSave");
  window.addEventListener("beforeunload", () => {
    if (_layoutSaveTimer) {
      clearTimeout(_layoutSaveTimer);
      _layoutSaveTimer = null;
      saveLayout();
    }
  });
  function makeDraggable(el, handleSelector, moteColor) {
    const handle = handleSelector ? el.querySelector(handleSelector) : el;
    if (!handle) return;
    let dx = 0, dy = 0, isDragging = false;
    handle.style.cursor = "grab";
    function startDrag(cx, cy) {
      isDragging = true;
      const rect = el.getBoundingClientRect();
      dx = cx - rect.left;
      dy = cy - rect.top;
      handle.style.cursor = "grabbing";
      el.style.transition = "none";
    }
    __name(startDrag, "startDrag");
    function moveDrag(cx, cy) {
      if (!isDragging) return;
      el.style.left = cx - dx + "px";
      el.style.top = cy - dy + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.transform = "none";
      if (Math.random() < 0.4) {
        spawnMote(cx + (Math.random() - 0.5) * 20, cy + (Math.random() - 0.5) * 20, moteColor);
      }
    }
    __name(moveDrag, "moveDrag");
    function endDrag() {
      if (isDragging) {
        isDragging = false;
        handle.style.cursor = "grab";
        scheduleSave();
      }
    }
    __name(endDrag, "endDrag");
    const _skipDrag = /* @__PURE__ */ __name((t) => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "BUTTON" || t.closest("button"), "_skipDrag");
    handle.addEventListener("mousedown", (e) => {
      if (_skipDrag(e.target)) return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
      const onMove = /* @__PURE__ */ __name((ev) => moveDrag(ev.clientX, ev.clientY), "onMove");
      const onUp = /* @__PURE__ */ __name(() => {
        endDrag();
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }, "onUp");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    handle.addEventListener("touchstart", (e) => {
      if (_skipDrag(e.target)) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
      const onMove = /* @__PURE__ */ __name((ev) => {
        if (ev.touches.length) moveDrag(ev.touches[0].clientX, ev.touches[0].clientY);
      }, "onMove");
      const onEnd = /* @__PURE__ */ __name(() => {
        endDrag();
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
      }, "onEnd");
      window.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("touchend", onEnd, { passive: true });
    }, { passive: false });
  }
  __name(makeDraggable, "makeDraggable");
  function makeResizable(el, moteColor) {
    if (!el) return;
    const grip = document.createElement("div");
    grip.className = "panel-resize-grip";
    grip.innerHTML = "&#9698;";
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
      el.style.transition = "none";
      grip.classList.add("active");
      document.body.style.userSelect = "none";
    }
    __name(startResize, "startResize");
    function doResize(cx, cy) {
      if (!isResizing) return;
      const w = Math.max(140, startW + (cx - startX));
      const h = Math.max(80, startH + (cy - startY));
      el.style.width = Math.round(w) + "px";
      el.style.height = Math.round(h) + "px";
      el.style.maxHeight = "none";
      if (moteColor && Math.random() < 0.35) {
        spawnMote(cx + (Math.random() - 0.5) * 12, cy + (Math.random() - 0.5) * 12, moteColor);
      }
    }
    __name(doResize, "doResize");
    function endResize() {
      if (!isResizing) return;
      isResizing = false;
      grip.classList.remove("active");
      document.body.style.userSelect = "";
      scheduleSave();
      if (_panelMode === "auto") {
        clearTimeout(_autoLayoutTimer);
        _autoLayoutTimer = setTimeout(autoArrangePanels, 300);
      }
    }
    __name(endResize, "endResize");
    grip.addEventListener("mousedown", (e) => startResize(e.clientX, e.clientY, e));
    window.addEventListener("mousemove", (e) => doResize(e.clientX, e.clientY));
    window.addEventListener("mouseup", endResize);
    grip.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startResize(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });
    window.addEventListener("touchmove", (e) => {
      if (!isResizing || !e.touches.length) return;
      doResize(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchend", endResize, { passive: true });
  }
  __name(makeResizable, "makeResizable");
  makeDraggable(document.getElementById("realm-panel"), ".panel-header", [240, 216, 144]);
  makeDraggable(document.getElementById("legend"), ".panel-header", [100, 180, 255]);
  makeDraggable(document.getElementById("spellbook"), ".panel-header", [192, 160, 255]);
  makeDraggable(document.getElementById("quest-log"), "#quest-log-header", [160, 255, 96]);
  makeDraggable(document.getElementById("realm-codex"), "#codex-header", [144, 96, 192]);
  makeDraggable(document.getElementById("cartographer"), ".panel-header", [192, 144, 96]);
  makeDraggable(document.getElementById("energy-panel"), ".panel-header", [96, 192, 96]);
  makeDraggable(document.getElementById("persona-editor"), ".pe-header", [240, 200, 100]);
  makeDraggable(document.getElementById("node-list"), "#node-list-header", [192, 144, 96]);
  makeDraggable(document.getElementById("latency-panel"), ".panel-header", [100, 180, 255]);
  makeDraggable(document.getElementById("firewall-panel"), ".panel-header", [220, 160, 80]);
  makeDraggable(document.getElementById("wifi-panel"), ".panel-header", [100, 200, 255]);
  makeResizable(document.getElementById("realm-panel"), [240, 216, 144]);
  makeResizable(document.getElementById("legend"), [100, 180, 255]);
  makeResizable(document.getElementById("spellbook"), [192, 160, 255]);
  makeResizable(document.getElementById("quest-log"), [160, 255, 96]);
  makeResizable(document.getElementById("realm-codex"), [144, 96, 192]);
  makeResizable(document.getElementById("cartographer"), [192, 144, 96]);
  makeResizable(document.getElementById("energy-panel"), [96, 192, 96]);
  makeResizable(document.getElementById("node-list"), [192, 144, 96]);
  makeResizable(document.getElementById("latency-panel"), [100, 180, 255]);
  makeResizable(document.getElementById("firewall-panel"), [220, 160, 80]);
  makeResizable(document.getElementById("wifi-panel"), [100, 200, 255]);
  makeResizable(document.getElementById("debug-panel"), [120, 80, 200]);
  makeResizable(document.getElementById("persona-editor"), [240, 200, 100]);
  (function() {
    let dragNode = null, dragOffsetX = 0, dragOffsetY = 0, hasMoved = false;
    let _longPressTimer = null;
    let _dragFrame = 0, _dragRafPending = false;
    let _lastNodeTapTime = 0, _lastNodeTapped = null;
    let _dragStartCx = 0, _dragStartCy = 0;
    const DRAG_THRESHOLD = 8;
    const mapWorld = document.getElementById("map-world");
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
      node.style.zIndex = "25";
      node.style.transition = "none";
    }
    __name(startNodeDrag, "startNodeDrag");
    function moveNodeDrag(cx, cy) {
      if (!dragNode) return;
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
      dragNode.style.left = nx + "px";
      dragNode.style.top = ny + "px";
      const tipId = dragNode.dataset.tip;
      if (tipId && _topology && _topology.nodes) {
        const tn = _topology.nodes.find((n) => n.id === tipId);
        if (tn) {
          tn.x = nx;
          tn.y = ny;
        }
      }
      _dragFrame++;
      if (_dragFrame % _PERF.dragLineThrottle === 0 && !_dragRafPending) {
        _dragRafPending = true;
        requestAnimationFrame(() => {
          _dragRafPending = false;
          updateLinePositions();
        });
      }
      updateBubblePositions();
      if (Math.random() < 0.3) {
        const colors = [[240, 216, 144], [160, 255, 96], [100, 180, 255]];
        spawnMote(
          cx + (Math.random() - 0.5) * 16,
          cy + (Math.random() - 0.5) * 16,
          colors[Math.floor(Math.random() * colors.length)]
        );
      }
    }
    __name(moveNodeDrag, "moveNodeDrag");
    function endNodeDrag() {
      if (_longPressTimer) {
        clearTimeout(_longPressTimer);
        _longPressTimer = null;
      }
      if (dragNode) {
        const tappedNode = dragNode;
        dragNode.style.zIndex = "";
        dragNode.style.transition = "";
        if (hasMoved) {
          const rect = tappedNode.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          for (let i = 0; i < 12; i++) {
            spawnMote(cx + (Math.random() - 0.5) * 30, cy + (Math.random() - 0.5) * 30, [160, 255, 96]);
          }
          scheduleSave();
          _topoNodeMap = null;
          _topoForceRender();
          generateTerrain();
          updateRegionLabels();
        } else {
          const now = Date.now();
          if (_lastNodeTapped === tappedNode && now - _lastNodeTapTime < 400) {
            const key = tappedNode.dataset.tip;
            if (key) openPersonaEditor(key);
            _lastNodeTapTime = 0;
            _lastNodeTapped = null;
          } else {
            _lastNodeTapTime = now;
            _lastNodeTapped = tappedNode;
            const tipKey = tappedNode.dataset.tip;
            if (tipKey && isClusterExpandable(tipKey)) {
              toggleClusterExpand(tipKey);
            }
          }
        }
        dragNode = null;
      }
    }
    __name(endNodeDrag, "endNodeDrag");
    mapWorld.addEventListener("mousedown", (e) => {
      const node = e.target.closest(".realm-node");
      if (!node || e.button !== 0) return;
      e.stopPropagation();
      startNodeDrag(node, e.clientX, e.clientY);
    });
    mapWorld.addEventListener("touchstart", (e) => {
      const node = e.target.closest(".realm-node");
      if (!node || e.touches.length !== 1) return;
      e.stopPropagation();
      e.preventDefault();
      startNodeDrag(node, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener("mousemove", (e) => moveNodeDrag(e.clientX, e.clientY));
    window.addEventListener("mouseup", endNodeDrag);
    window.addEventListener("touchmove", (e) => {
      if (!dragNode || !e.touches.length) return;
      e.preventDefault();
      moveNodeDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener("touchend", endNodeDrag, { passive: true });
    window.addEventListener("touchcancel", endNodeDrag, { passive: true });
  })();
  restoreLayout();
  restoreSettings();
  var _chatDialog = null;
  var _chatNodeId = null;
  var _chatHistory = [];
  function _createChatDialog() {
    if (_chatDialog) return _chatDialog;
    const dialog = document.createElement("div");
    dialog.id = "node-chat-dialog";
    dialog.className = "panel";
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
    dialog.querySelector("#chat-close").addEventListener("click", () => {
      const sealBtn = dialog.querySelector(".panel-seal-btn");
      if (sealBtn) sealBtn.click();
      else dialog.classList.remove("open");
    });
    dialog.querySelector("#chat-send").addEventListener("click", sendChatMessage);
    dialog.querySelector("#chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
    dialog.querySelector("#chat-clear").addEventListener("click", async () => {
      try {
        await fetch("/chat/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: _chatNodeId ? `node-${_chatNodeId}` : null })
        });
        _chatHistory = [];
        dialog.querySelector("#chat-messages").innerHTML = '<div class="chat-msg-system">Session cleared. The oracle awaits.</div>';
      } catch (e) {
      }
    });
    registerPanel(dialog);
    makeDraggable(dialog, ".panel-header", [160, 120, 255]);
    makeResizable(dialog, [160, 120, 255]);
    _chatDialog = dialog;
    return dialog;
  }
  __name(_createChatDialog, "_createChatDialog");
  async function openNodeChat(nodeId, contextText, autoChat = true) {
    const dialog = _createChatDialog();
    _chatNodeId = nodeId;
    const node = document.querySelector(`[data-tip="${nodeId}"]`);
    const nodeName = node?.querySelector(".node-label")?.textContent || nodeId;
    dialog.querySelector("#chat-dialog-title").textContent = `Commune: ${nodeName}`;
    dialog.classList.add("open");
    await _loadChatHistory(nodeId);
    if (contextText && autoChat) {
      _chatHistory.push({ role: "system", content: `[Event] ${contextText}` });
      _renderChatHistory();
      const input = dialog.querySelector("#chat-input");
      input.value = `Tell me more about this: "${contextText}"`;
      sendChatMessage();
    } else {
      dialog.querySelector("#chat-input").focus();
    }
  }
  __name(openNodeChat, "openNodeChat");
  async function _loadChatHistory(nodeId) {
    const dialog = _chatDialog;
    const messagesEl = dialog.querySelector("#chat-messages");
    messagesEl.innerHTML = '<div style="color:#808080;">Loading...</div>';
    try {
      const session = nodeId ? `node-${nodeId}` : null;
      const r = await fetch(`/chat/history${session ? `?session=${session}` : ""}`);
      const data = await r.json();
      _chatHistory = data.history || [];
      _renderChatHistory();
    } catch (e) {
      messagesEl.innerHTML = '<div style="color:#ff8080;">Failed to load history</div>';
    }
  }
  __name(_loadChatHistory, "_loadChatHistory");
  function _renderChatHistory() {
    const messagesEl = _chatDialog.querySelector("#chat-messages");
    if (_chatHistory.length === 0) {
      messagesEl.innerHTML = '<div class="chat-msg-system">No messages yet. Click a speech bubble or ask a question to commune.</div>';
      return;
    }
    messagesEl.innerHTML = _chatHistory.map((m) => {
      const isUser = m.role === "user";
      const isSystem = m.role === "system";
      let cls, label;
      if (isSystem) {
        cls = "chat-msg-system";
        label = "";
      } else if (isUser) {
        cls = "chat-msg chat-msg-user";
        label = "You";
      } else {
        cls = "chat-msg chat-msg-oracle";
        label = "Oracle";
      }
      if (isSystem) return `<div class="${cls}">${m.content}</div>`;
      return `<div class="${cls}"><span class="chat-msg-label">${label}</span>${m.content}</div>`;
    }).join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  __name(_renderChatHistory, "_renderChatHistory");
  async function sendChatMessage() {
    const input = _chatDialog.querySelector("#chat-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    input.disabled = true;
    _chatDialog.querySelector("#chat-send").disabled = true;
    _chatHistory.push({ role: "user", content: message });
    _renderChatHistory();
    const messagesEl = _chatDialog.querySelector("#chat-messages");
    const loadingEl = document.createElement("div");
    loadingEl.className = "chat-typing";
    loadingEl.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
    messagesEl.appendChild(loadingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    try {
      const session = _chatNodeId ? `node-${_chatNodeId}` : null;
      const r = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          node: _chatNodeId,
          session
        })
      });
      const data = await r.json();
      loadingEl.remove();
      if (data.error) {
        _chatHistory.push({ role: "assistant", content: `Error: ${data.error}` });
      } else if (data.response) {
        _chatHistory.push({ role: "assistant", content: data.response });
      } else {
        _chatHistory.push({ role: "assistant", content: "(Empty response from oracle)" });
      }
      _renderChatHistory();
    } catch (e) {
      loadingEl.remove();
      _chatHistory.push({ role: "assistant", content: `Error: ${e.message}` });
      _renderChatHistory();
    } finally {
      input.disabled = false;
      _chatDialog.querySelector("#chat-send").disabled = false;
      input.focus();
    }
  }
  __name(sendChatMessage, "sendChatMessage");
  var _magicalSearchInput = document.getElementById("magical-search");
  if (_magicalSearchInput) {
    _magicalSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        const query = _magicalSearchInput.value.trim();
        if (query) {
          openNodeChat(null, null);
          _chatDialog.querySelector("#chat-input").value = query;
          sendChatMessage();
          _magicalSearchInput.value = "";
        }
      }
    });
  }
  var _cfgFields = {
    "cfg-chat-model": { path: "chat.deployment", also: "chat.model" },
    "cfg-reasoning": { path: "chat.reasoning_effort" },
    "cfg-max-tokens": { path: "chat.max_completion_tokens", type: "number" },
    "cfg-multi-timeout": { path: "chat.multi_chat_timeout", type: "number" },
    "cfg-voice": { path: "speech.voice" },
    "cfg-silence": { path: "speech.silence_timeout", type: "number" },
    "cfg-subtitles": { path: "speech.live_subtitles", type: "checkbox" },
    "cfg-oracle-model": { path: "oracle.model" },
    "cfg-oracle-reasoning": { path: "oracle.reasoning_effort" },
    "cfg-oracle-voice": { path: "oracle.voice" }
  };
  function _getPath(obj, path) {
    const parts = path.split(".");
    let v = obj;
    for (const p of parts) {
      v = v?.[p];
    }
    return v;
  }
  __name(_getPath, "_getPath");
  async function loadArcaneConfig() {
    try {
      const r = await fetch("/config");
      if (!r.ok) return;
      const cfg = await r.json();
      for (const [id, spec] of Object.entries(_cfgFields)) {
        const el = document.getElementById(id);
        if (!el) continue;
        const val = _getPath(cfg, spec.path);
        if (val == null) continue;
        if (spec.type === "checkbox") el.checked = !!val;
        else el.value = val;
      }
    } catch (e) {
    }
  }
  __name(loadArcaneConfig, "loadArcaneConfig");
  function _saveArcaneConfig() {
    const update = { chat: {}, speech: {}, oracle: {} };
    for (const [id, spec] of Object.entries(_cfgFields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      const [section, key] = spec.path.split(".");
      let val;
      if (spec.type === "checkbox") val = el.checked;
      else if (spec.type === "number") val = parseFloat(el.value);
      else val = el.value;
      update[section][key] = val;
      if (spec.also) {
        const [s2, k2] = spec.also.split(".");
        update[s2][k2] = val;
      }
    }
    const statusEl = document.getElementById("cfg-status");
    fetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update)
    }).then((r) => {
      if (statusEl) {
        statusEl.textContent = r.ok ? "Config saved \u2714" : "Save failed";
        setTimeout(() => {
          statusEl.textContent = "";
        }, 3e3);
      }
    }).catch(() => {
      if (statusEl) statusEl.textContent = "Save failed";
    });
  }
  __name(_saveArcaneConfig, "_saveArcaneConfig");
  var _cfgSaveBtn = document.getElementById("cfg-save-btn");
  if (_cfgSaveBtn) _cfgSaveBtn.addEventListener("click", _saveArcaneConfig);
  loadArcaneConfig();
  var _dbgPanel = document.getElementById("debug-panel");
  var _dbgBody = document.getElementById("debug-body");
  var _dbgSearch = document.getElementById("debug-search");
  var _dbgSseStatus = document.getElementById("debug-poll-count");
  var _dbgTab = "all";
  var _dbgDbInfo = null;
  document.getElementById("debug-close")?.addEventListener("click", () => {
    const cb = document.getElementById("vis-debug");
    if (cb) {
      cb.checked = false;
      cb.dispatchEvent(new Event("change"));
    }
  });
  document.querySelectorAll(".debug-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".debug-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      _dbgTab = tab.dataset.dtab;
      _dbgRefresh();
    });
  });
  _dbgSearch?.addEventListener("input", () => _dbgRefresh());
  {
    let startDrag = function(cx, cy) {
      const r = _dbgPanel.getBoundingClientRect();
      offX = cx - r.left;
      offY = cy - r.top;
      dragging2 = true;
    }, moveDrag = function(cx, cy) {
      if (!dragging2) return;
      _dbgPanel.style.left = cx - offX + "px";
      _dbgPanel.style.top = cy - offY + "px";
      _dbgPanel.style.bottom = "auto";
      _dbgPanel.style.right = "auto";
    }, endDrag = function() {
      dragging2 = false;
    };
    __name(startDrag, "startDrag");
    __name(moveDrag, "moveDrag");
    __name(endDrag, "endDrag");
    const hdr = document.getElementById("debug-header");
    let offX = 0, offY = 0, dragging2 = false;
    hdr?.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    });
    document.addEventListener("mousemove", (e) => moveDrag(e.clientX, e.clientY));
    document.addEventListener("mouseup", endDrag);
    hdr?.addEventListener("touchstart", (e) => {
      if (e.target.tagName === "BUTTON" || e.touches.length !== 1) return;
      e.preventDefault();
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
      if (dragging2 && e.touches.length) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    document.addEventListener("touchend", endDrag);
  }
  function _dbgSection(title, id, content, collapsed = false) {
    return `<div class="dbg-section${collapsed ? " collapsed" : ""}" data-dbg="${id}">
    <div class="dbg-section-title">${title}</div>
    <div class="dbg-section-body">${content}</div></div>`;
  }
  __name(_dbgSection, "_dbgSection");
  function _dbgKV(k, v, cls = "") {
    const vc = typeof v === "number" ? v === 0 ? "dim" : "" : cls;
    return `<div class="dbg-kv"><span class="dbg-k">${k}</span><span class="dbg-v ${vc}">${_escH(String(v))}</span></div>`;
  }
  __name(_dbgKV, "_dbgKV");
  function _escH(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  __name(_escH, "_escH");
  function _dbgTree(obj, depth = 0, filter = "") {
    if (obj === null || obj === void 0) return '<span class="dbg-v dim">null</span>';
    if (typeof obj !== "object") return `<span class="dbg-v">${_escH(String(obj))}</span>`;
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '<span class="dbg-v dim">[]</span>';
      if (depth > 2) return `<span class="dbg-v dim">[${obj.length} items]</span>`;
      return obj.slice(0, 20).map(
        (v, i) => `<div class="dbg-kv"><span class="dbg-k">[${i}]</span>${_dbgTree(v, depth + 1, filter)}</div>`
      ).join("") + (obj.length > 20 ? `<div class="dbg-v dim">...+${obj.length - 20} more</div>` : "");
    }
    const entries = Object.entries(obj);
    if (entries.length === 0) return '<span class="dbg-v dim">{}</span>';
    const filtered = filter ? entries.filter(([k, v]) => {
      const s = k + " " + JSON.stringify(v);
      return s.toLowerCase().includes(filter);
    }) : entries;
    if (depth > 2) return `<span class="dbg-v dim">{${filtered.length} keys}</span>`;
    return `<div class="dbg-tree">${filtered.map(
      ([k, v]) => `<div class="dbg-kv"><span class="dbg-k">${_escH(k)}</span>${_dbgTree(v, depth + 1, filter)}</div>`
    ).join("")}</div>`;
  }
  __name(_dbgTree, "_dbgTree");
  function _dbgRefresh() {
    if (!_dbgPanel || _dbgPanel.style.display === "none") return;
    const d = lastStatus;
    const filter = (_dbgSearch?.value || "").toLowerCase().trim();
    const tab = _dbgTab;
    let html = "";
    if (_dbgSseStatus) _dbgSseStatus.textContent = _sseConnected ? "sse:live" : "sse:off";
    if (tab === "all" || tab === "status") {
      const s = d ? {
        realm_scale: d.realm_scale,
        forge_cpu: d.forge?.usage,
        mana_mem: d.mana?.usage,
        gpu: d.gpu?.usage,
        uptime: d.adult?.uptime,
        load: d.adult?.load1,
        host: d.host?.hostname,
        sse: _sseConnected ? "live" : "off"
      } : { status: "no data yet" };
      html += _dbgSection("Status", "status", _dbgTree(s, 0, filter));
    }
    if ((tab === "all" || tab === "collectd") && d?.collectd) {
      const hosts = Object.keys(d.collectd).length;
      let body = _dbgKV("hosts", hosts);
      body += _dbgTree(d.collectd, 0, filter);
      html += _dbgSection(`Collectd (${hosts} hosts)`, "collectd", body, tab === "all");
    }
    if ((tab === "all" || tab === "wifi") && d?.wifi) {
      const clients = Object.keys(d.wifi).length;
      let body = _dbgKV("clients", clients);
      body += _dbgTree(d.wifi, 0, filter);
      html += _dbgSection(`WiFi (${clients} clients)`, "wifi", body, tab === "all");
    }
    if ((tab === "all" || tab === "ha") && d?.ha) {
      const ents = Object.keys(d.ha).length;
      let body = _dbgKV("entities", ents);
      body += _dbgTree(d.ha, 0, filter);
      html += _dbgSection(`Home Assistant (${ents})`, "ha", body, tab === "all");
    }
    if ((tab === "all" || tab === "tailscale") && d?.tailscale) {
      const ts = d.tailscale;
      let body = _dbgKV("online", ts.online?.length || 0, "ok");
      body += _dbgKV("offline", ts.offline?.length || 0, ts.offline?.length ? "warn" : "");
      body += _dbgTree(ts, 0, filter);
      html += _dbgSection("Tailscale", "tailscale", body, tab === "all");
    }
    if (tab === "all" || tab === "topology") {
      const t = _topology || {};
      let body = _dbgKV("nodes", t.nodes?.length || 0);
      body += _dbgKV("connections", t.connections?.length || 0);
      body += _dbgKV("regions", t.regions?.length || 0);
      if (tab === "topology") {
        const types = {};
        (t.nodes || []).forEach((n) => {
          types[n.type || "unknown"] = (types[n.type || "unknown"] || 0) + 1;
        });
        body += _dbgKV("types", JSON.stringify(types));
        if (d?.tailscale) {
          const online = /* @__PURE__ */ new Set([...d.tailscale.online || []]);
          const onlineNodes = (t.nodes || []).filter((n) => n.online !== false).length;
          body += _dbgKV("online nodes", onlineNodes, "ok");
        }
        body += _dbgTree(t, 0, filter);
      }
      html += _dbgSection("Topology", "topology", body, tab === "all");
    }
    if (tab === "all" || tab === "events") {
      const logBody = document.getElementById("quest-log-body");
      const count = logBody ? logBody.children.length : 0;
      let body = _dbgKV("log entries", count);
      body += _dbgKV("last event ts", lastEventTs ? new Date(lastEventTs * 1e3).toLocaleTimeString() : "none");
      body += _dbgKV("delivery", "SSE (real-time)");
      html += _dbgSection(`Events (${count})`, "events", body);
    }
    if (tab === "all" || tab === "db") {
      let body = "";
      if (_dbgDbInfo) {
        body += _dbgKV("db size", (_dbgDbInfo.db_size / 1024).toFixed(0) + " KB");
        body += _dbgKV("notion synced", _dbgDbInfo.notion_synced);
        body += _dbgKV("wifi scan", _dbgDbInfo.wifi_scan_ts ? new Date(_dbgDbInfo.wifi_scan_ts * 1e3).toLocaleTimeString() : "none");
        body += _dbgKV("namespaces", (_dbgDbInfo.settings_ns || []).join(", "));
        if (_dbgDbInfo.tables) body += _dbgTree(_dbgDbInfo.tables, 0, filter);
      } else {
        body += _dbgKV("loading...", "");
      }
      const ls = localStorage.getItem("realm-map-settings");
      if (ls) {
        try {
          const s = JSON.parse(ls);
          body += _dbgKV("local sliders", Object.keys(s.sliders || {}).length);
          body += _dbgKV("local cbs", Object.keys(s.checkboxes || {}).length);
          if (tab === "db") body += _dbgTree(s, 0, filter);
        } catch (e) {
          body += _dbgKV("localStorage", "parse error", "err");
        }
      }
      html += _dbgSection("DB / Settings", "db", body, tab === "all");
    }
    _dbgBody.innerHTML = html;
    _dbgBody.querySelectorAll(".dbg-section-title").forEach((el) => {
      el.addEventListener("click", () => {
        el.parentElement.classList.toggle("collapsed");
      });
    });
    if (filter) {
      const re = new RegExp(`(${filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
      _dbgBody.querySelectorAll(".dbg-v, .dbg-k").forEach((el) => {
        if (el.querySelector("*")) return;
        const t = el.textContent;
        if (re.test(t)) {
          el.innerHTML = t.replace(re, '<span class="dbg-highlight">$1</span>');
        }
      });
    }
  }
  __name(_dbgRefresh, "_dbgRefresh");
  function _dbgFetchDb() {
    if (!_dbgPanel || _dbgPanel.style.display === "none") return;
    fetch("/debug").then((r) => r.json()).then((d) => {
      _dbgDbInfo = d;
    }).catch(() => {
    });
  }
  __name(_dbgFetchDb, "_dbgFetchDb");
  new MutationObserver(() => {
    if (_dbgPanel && _dbgPanel.style.display !== "none") {
      _dbgFetchDb();
      _dbgRefresh();
    }
  }).observe(_dbgPanel, { attributes: true, attributeFilter: ["style"] });
  setInterval(() => {
    if (_dbgPanel && _dbgPanel.style.display !== "none") _dbgFetchDb();
  }, 3e4);

  // src/main.js
  if (document.readyState === "complete") {
    initPanelManager();
  } else {
    window.addEventListener("load", initPanelManager);
  }
})();
//# sourceMappingURL=realm-map.js.map
