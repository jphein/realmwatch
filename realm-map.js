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
      const icon = el.el.querySelector(".node-icon");
      let iconScale = 1;
      if (icon && icon.style.transform) {
        const m = icon.style.transform.match(/scale\(([^)]+)\)/);
        if (m) iconScale = parseFloat(m[1]) || 1;
      }
      const cx = left + w / 2;
      const cy = top + h / 2;
      const rx = w / 2 * Math.max(1, iconScale) + 20;
      const ry = h / 2 * Math.max(1, iconScale) + 15;
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
      if (n.ip || n.ssh) infraNodes[n.id] = { name: n.label, ip: n.ip || "", collectdHost: n.collectd || null, sshHost: n.ssh || null, tsHost: n.tsHost || null };
      if (n.tsHost) _tsHostMap[n.tsHost] = n.id;
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
  loadTopology();

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
    updateConnectionTraffic(d.collectd);
    _lastTopoCollectd = d.collectd;
    if (_topoEnabled) renderTopoLayer(d.collectd);
    updateNodeListStatus(d);
    firePulse();
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
    if (lastStatus && lastStatus.collectd) updateConnectionTraffic(lastStatus.collectd);
    scheduleSave();
  });
  var nodeScale = 1;
  var nodeScaleSlider = document.getElementById("node-scale-slider");
  var nodeScaleVal = document.getElementById("node-scale-val");
  nodeScaleSlider.addEventListener("input", () => {
    nodeScale = parseFloat(nodeScaleSlider.value) * masterScale;
    nodeScaleVal.textContent = nodeScale.toFixed(1) + "x";
    document.querySelectorAll(".realm-node").forEach((node) => {
      node.style.transform = `scale(${nodeScale})`;
    });
    updateLinePositions();
    scheduleSave();
  });
  var textScale = 1;
  var textScaleSlider = document.getElementById("text-scale-slider");
  var textScaleVal = document.getElementById("text-scale-val");
  textScaleSlider.addEventListener("input", () => {
    textScale = parseFloat(textScaleSlider.value) * masterScale;
    textScaleVal.textContent = textScale.toFixed(1) + "x";
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
  var updateSpeedMs = 5e3;
  var updateSpeedSlider = document.getElementById("update-speed-slider");
  var updateSpeedVal = document.getElementById("update-speed-val");
  updateSpeedSlider.addEventListener("input", () => {
    updateSpeedMs = parseInt(updateSpeedSlider.value) * 1e3;
    updateSpeedVal.textContent = updateSpeedSlider.value + "s";
    scheduleSave();
  });
  var connColors = {
    "conn-active": [100, 180, 255],
    "conn-ap": [100, 180, 255],
    "conn-wan": [255, 180, 50],
    "conn-infra": [96, 160, 192],
    "conn-bridge": [160, 100, 220],
    "conn-vlan": [255, 160, 60],
    "conn-mesh": [120, 220, 120]
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
  _connPaths.forEach((path) => {
    if (!path) return;
    const cs = getComputedStyle(path);
    _connBaseWidths.set(path, parseFloat(cs.getPropertyValue("--sw")) || 1.5);
  });
  function updateConnectionTraffic(collectd) {
    if (!collectd) return;
    _connLinesWithData.forEach((line) => {
      const toNode = line.dataset.to;
      const fromNode = line.dataset.from;
      const toTraffic = getNodeTraffic(collectd, toNode);
      const fromTraffic = fromNode ? getNodeTraffic(collectd, fromNode) : null;
      const traffic = toTraffic && fromTraffic ? toTraffic.total > fromTraffic.total ? toTraffic : fromTraffic : toTraffic || fromTraffic;
      const baseW = _connBaseWidths.get(line) || 1.5;
      if (!traffic || traffic.total === 0) {
        line.style.setProperty("--sw", baseW);
        line.style.removeProperty("--speed");
        line.style.removeProperty("--dir");
        line.removeAttribute("stroke");
        line.classList.remove("conn-traffic-low", "conn-traffic-med", "conn-traffic-high");
        return;
      }
      const rawIntensity = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
      const intensity = Math.min(1, rawIntensity * trafficScale);
      const sw = baseW + intensity * 8 * trafficScale;
      line.style.setProperty("--sw", sw.toFixed(1));
      const speed = Math.max(2, 20 - intensity * 18);
      line.style.setProperty("--speed", speed.toFixed(1) + "s");
      const rxDominant = traffic.rx > traffic.tx;
      line.style.setProperty("--dir", rxDominant ? "reverse" : "normal");
      const connType = Array.from(line.classList).find((c) => connColors[c]);
      if (connType) {
        const [r, g, b] = connColors[connType];
        const alpha = 0.15 + intensity * 0.5;
        const bright = 1 + intensity * 0.3;
        line.setAttribute("stroke", `rgba(${Math.min(255, r * bright) | 0},${Math.min(255, g * bright) | 0},${Math.min(255, b * bright) | 0},${alpha.toFixed(2)})`);
      }
      line.classList.remove("conn-traffic-low", "conn-traffic-med", "conn-traffic-high");
      if (intensity > 0.65) line.classList.add("conn-traffic-high");
      else if (intensity > 0.35) line.classList.add("conn-traffic-med");
      else if (intensity > 0.15) line.classList.add("conn-traffic-low");
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
  var _topoNodeMap = null;
  function _getTopoNodeMap() {
    if (_topoNodeMap) return _topoNodeMap;
    _topoNodeMap = /* @__PURE__ */ new Map();
    for (const n of _topology.nodes) _topoNodeMap.set(n.id, n);
    return _topoNodeMap;
  }
  __name(_getTopoNodeMap, "_getTopoNodeMap");
  function _topoNodeHeight(node, trafficMap) {
    const traffic = trafficMap.get(node.id);
    let h = 0.18;
    if (traffic && traffic.total > 0) {
      const raw = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
      h = 0.25 + raw * 0.75;
    }
    if (node.type === "core") h = Math.max(h, 0.6);
    else if (node.type === "tower") h = Math.max(h, 0.35);
    else if (node.type === "bridge") h = Math.max(h, 0.28);
    return h;
  }
  __name(_topoNodeHeight, "_topoNodeHeight");
  function _topoColor(t) {
    if (t < 0.15) {
      const s = t / 0.15;
      return `rgb(${32 + 26 * s | 0},${37 + 3 * s | 0},${144 - 32 * s | 0})`;
    } else if (t < 0.5) {
      const s = (t - 0.15) / 0.35;
      return `rgb(${58 + 48 * s | 0},${40 + 34 * s | 0},${112 - 32 * s | 0})`;
    } else {
      const s = (t - 0.5) / 0.5;
      return `rgb(${106 + 106 * s | 0},${74 + 86 * s | 0},${80 - 16 * s | 0})`;
    }
  }
  __name(_topoColor, "_topoColor");
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
  var _TOPO_PAD = 50;
  var _TOPO_SX = 10;
  var _TOPO_SY = 10;
  var _TOPO_W = Math.ceil(WORLD_W / _TOPO_SX) + _TOPO_PAD * 2;
  var _TOPO_H = Math.ceil(WORLD_H / _TOPO_SY) + _TOPO_PAD * 2;
  function renderTopoLayer(collectd) {
    if (!_topoSvg || !_topoEnabled || !_topology.nodes) return;
    collectd = collectd || {};
    const trafficMap = /* @__PURE__ */ new Map();
    let hash = _topoSpread + "|" + _topoContours + "|" + _topoRiverWidth + "|" + _topoRiverDepth;
    for (const n of _topology.nodes) {
      const t = getNodeTraffic(collectd, n.id);
      trafficMap.set(n.id, t);
      hash += "|" + (t ? Math.log2(t.total + 1) | 0 : 0);
    }
    if (hash === _topoHash) return;
    _topoHash = hash;
    const W = _TOPO_W, H = _TOPO_H, sx = _TOPO_SX, sy = _TOPO_SY, pad = _TOPO_PAD;
    const sigma = _topoSpread / sx;
    if (!renderTopoLayer._hmap || renderTopoLayer._hmap.length !== W * H)
      renderTopoLayer._hmap = new Float32Array(W * H);
    const hmap = renderTopoLayer._hmap;
    hmap.fill(0);
    const nodeMap = _getTopoNodeMap();
    hmap.fill(0.15);
    const hs3 = sigma * 3 | 0;
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (const n of _topology.nodes) {
      const iw = n.iconStyle && n.iconStyle.width ? parseInt(n.iconStyle.width) : 64;
      const ih = n.iconStyle && n.iconStyle.height ? parseInt(n.iconStyle.height) : 64;
      const cx = (n.x + iw / 2) / sx + pad, cy = (n.y + ih / 2) / sy + pad;
      const h = _topoNodeHeight(n, trafficMap);
      const x0 = Math.max(0, cx - hs3 | 0), x1 = Math.min(W - 1, cx + hs3 | 0);
      const y0 = Math.max(0, cy - hs3 | 0), y1 = Math.min(H - 1, cy + hs3 | 0);
      for (let y = y0; y <= y1; y++) {
        const dy2 = (y - cy) * (y - cy);
        const row = y * W;
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const d = (dx * dx + dy2) * inv2s2;
          if (d < 8) hmap[row + x] += h * Math.exp(-d);
        }
      }
    }
    if (_topology.connections) {
      for (const c of _topology.connections) {
        const fn = nodeMap.get(c.from), tn = nodeMap.get(c.to);
        if (!fn || !tn) continue;
        const tFrom = trafficMap.get(c.from), tTo = trafficMap.get(c.to);
        const tr = tFrom && tTo ? tFrom.total > tTo.total ? tFrom : tTo : tFrom || tTo;
        let I = 0;
        if (tr && tr.total > 0) I = Math.max(0, Math.min(1, (Math.log10(tr.total + 1) - 3) / 4));
        const rw = sigma * (_topoRiverWidth + I * 0.5);
        const rd = _topoRiverDepth + I * (1 - _topoRiverDepth) * 0.5;
        const irw = 1 / (2 * rw * rw);
        const rw3 = rw * 3 | 0;
        const ax = fn.x / sx + pad, ay = fn.y / sy + pad, bx = tn.x / sx + pad, by = tn.y / sy + pad;
        const dist = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(4, dist / 2 | 0);
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
          const lx0 = Math.max(0, px - rw3 | 0), lx1 = Math.min(W - 1, px + rw3 | 0);
          const ly0 = Math.max(0, py - rw3 | 0), ly1 = Math.min(H - 1, py + rw3 | 0);
          for (let y = ly0; y <= ly1; y++) {
            const dy2 = (y - py) * (y - py);
            const row = y * W;
            for (let x = lx0; x <= lx1; x++) {
              const dx = x - px, d = (dx * dx + dy2) * irw;
              if (d < 8) {
                hmap[row + x] *= 1 - rd * Math.exp(-d);
              }
            }
          }
        }
      }
    }
    const nC = _topoContours;
    const cStep = nC > 0 ? 1 / (nC + 1) : 0;
    const VB = "-500 -500 5800 4300";
    const bandEls = [];
    for (let ci = 1; ci <= nC; ci++) {
      const lev = ci * cStep;
      const isIdx = ci % 5 === 0;
      const t = ci / nC;
      const col = _topoColor(t);
      let pathD = "";
      for (let gy = 0; gy < H - 1; gy++) {
        for (let gx = 0; gx < W - 1; gx++) {
          const i = gy * W + gx;
          const v00 = hmap[i], v10 = hmap[i + 1], v01 = hmap[i + W], v11 = hmap[i + W + 1];
          const cls = (v00 >= lev) << 3 | (v10 >= lev) << 2 | (v11 >= lev) << 1 | v01 >= lev;
          if (cls === 0 || cls === 15) continue;
          const lrp = /* @__PURE__ */ __name((a, b) => b === a ? 0.5 : (lev - a) / (b - a), "lrp");
          const T = [(gx + lrp(v00, v10) - pad) * sx, (gy - pad) * sy];
          const B = [(gx + lrp(v01, v11) - pad) * sx, (gy + 1 - pad) * sy];
          const L = [(gx - pad) * sx, (gy + lrp(v00, v01) - pad) * sy];
          const R = [(gx + 1 - pad) * sx, (gy + lrp(v10, v11) - pad) * sy];
          const seg = /* @__PURE__ */ __name((a, b) => {
            pathD += `M${a[0] | 0},${a[1] | 0}L${b[0] | 0},${b[1] | 0}`;
          }, "seg");
          switch (cls) {
            case 1:
            case 14:
              seg(L, B);
              break;
            case 2:
            case 13:
              seg(B, R);
              break;
            case 3:
            case 12:
              seg(L, R);
              break;
            case 4:
            case 11:
              seg(T, R);
              break;
            case 6:
            case 9:
              seg(T, B);
              break;
            case 7:
            case 8:
              seg(L, T);
              break;
            case 5: {
              const ctr = (v00 + v10 + v01 + v11) / 4;
              if (ctr >= lev) {
                seg(L, B);
                seg(T, R);
              } else {
                seg(L, T);
                seg(B, R);
              }
              break;
            }
            case 10: {
              const ctr = (v00 + v10 + v01 + v11) / 4;
              if (ctr >= lev) {
                seg(L, T);
                seg(B, R);
              } else {
                seg(L, B);
                seg(T, R);
              }
              break;
            }
          }
        }
      }
      if (!pathD) continue;
      let inner = "";
      if (bandEls.length === 0) inner += _TOPO_DEFS;
      if (ci % _PERF.topoHaloRes === 0) {
        const fillOp = t < 0.15 ? 0.09 : 0.05;
        inner += `<path d="${pathD}" fill="none" stroke="${col}" stroke-width="25" opacity="${fillOp}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      const sw = isIdx ? 3 : 1.3;
      const op = isIdx ? 0.6 : 0.3;
      const filter = isIdx && _PERF.topoFilters ? ' filter="url(#topo-shimmer)" class="topo-idx"' : isIdx ? ' class="topo-idx"' : "";
      inner += `<path d="${pathD}" fill="none" stroke="${col}" stroke-width="${sw}" opacity="${op}" stroke-linecap="round"${filter}/>`;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", VB);
      svg.setAttribute("class", "topo-band");
      svg.dataset.elev = t.toFixed(3);
      svg.innerHTML = inner;
      bandEls.push(svg);
    }
    _topoSvg.innerHTML = "";
    bandEls.forEach((s) => _topoSvg.appendChild(s));
    if (_mapTilt > 0) _applyTopoZ();
  }
  __name(renderTopoLayer, "renderTopoLayer");
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
      _topoRafId = requestAnimationFrame(() => {
        _topoHash = "";
        renderTopoLayer(_lastTopoCollectd);
      });
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
  var lastEventTs = 0;
  var EVENTS_POLL_MS = 1e3;
  async function pollEvents() {
    try {
      const r = await fetch(`/events?since=${lastEventTs}`);
      if (!r.ok) throw new Error(r.status);
      const events = await r.json();
      events.forEach(renderEvent);
    } catch (e) {
    }
    setTimeout(pollEvents, EVENTS_POLL_MS);
  }
  __name(pollEvents, "pollEvents");
  pollEvents();
  var _pageLoadTs = Date.now() / 1e3;
  function renderEvent(evt) {
    lastEventTs = Math.max(lastEventTs, evt.ts || 0);
    const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);
    addLogEntry(evt, nodeEl);
    const evtAge = _pageLoadTs - (evt.ts || 0);
    if (evtAge > 30 && !evt._local) {
      return;
    }
    if (!nodeEl) return;
    if (evt.type === "speech") {
      showSpeechBubble(nodeEl, evt);
    } else if (evt.type === "highlight") {
      showHighlight(nodeEl, evt);
    } else if (evt.type === "alert") {
      showSpeechBubble(nodeEl, evt, true);
      showHighlight(nodeEl, { color: "rgba(255,80,60,0.6)" });
    } else if (evt.type === "quest") {
      showSpeechBubble(nodeEl, evt);
      showHighlight(nodeEl, { color: "rgba(192,144,255,0.5)" });
    }
  }
  __name(renderEvent, "renderEvent");
  var logCount = 0;
  var MAX_LOG = 80;
  var activeTab = "all";
  document.querySelectorAll(".log-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".log-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeTab = tab.dataset.tab;
      document.querySelectorAll(".log-entry").forEach((entry) => {
        if (activeTab === "all") {
          entry.style.display = "";
        } else if (activeTab === "notion") {
          entry.style.display = entry.classList.contains("notion-quest") ? "" : "none";
        } else {
          entry.style.display = entry.classList.contains("log-" + activeTab) ? "" : "none";
        }
      });
    });
  });
  document.getElementById("codex-header").addEventListener("click", () => {
    const body = document.getElementById("codex-body");
    body.style.display = body.style.display === "none" ? "" : "none";
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
  document.getElementById("quest-log-header").addEventListener("click", () => {
    const body = document.getElementById("quest-log-body");
    const tabs = document.getElementById("quest-log-tabs");
    const hidden = body.style.display === "none";
    body.style.display = hidden ? "" : "none";
    if (tabs) tabs.style.display = hidden ? "" : "none";
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
    entry.innerHTML = `<button class="log-dismiss" title="Dismiss">\u2715</button><div class="log-time">${timeStr}</div><div class="log-speaker">${name}</div>${textContent}`;
    entry.querySelector(".log-dismiss").addEventListener("click", () => {
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
  var _initialQuests = [
    { type: "quest", node: "katana", text: "Chart every node in the Digital Dominion \u2014 ensure all devices report their presence to the Citadel", duration: 12 },
    { type: "quest", node: "hp-switch", text: "Awaken all Guardian Towers \u2014 bring collectd scrying to every AP in the realm", duration: 12 },
    { type: "quest", node: "gatekeeper", text: "Unite the Enchanted Quarters \u2014 connect all IoT clusters through proper VLAN gateways", duration: 12 },
    { type: "quest", node: "gs308t", text: "Map the Hub Stone \u2014 monitor all 8 switch ports and track inter-bridge traffic", duration: 12 },
    { type: "quest", node: "hp-switch", text: "Bridge the realms \u2014 verify GigaBeam and CPE710 links carry full VLAN trunks", duration: 12 }
  ];
  setTimeout(() => {
    addLogEntry({ type: "system", node: "katana", text: "The Realm Map has been inscribed.", ts: Date.now() / 1e3 });
    const activeQuests = _initialQuests.filter((q) => !_dismissedQuests.includes(q.text));
    activeQuests.forEach((q, i) => {
      setTimeout(() => renderEvent({ ...q, ts: Date.now() / 1e3, _local: true }), i * 150);
    });
  }, 800);
  var _activeBubbles = /* @__PURE__ */ new Set();
  function _positionBubble(bubble) {
    const nodeEl = bubble._nodeEl;
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
  function _dismissBubble(bubble) {
    bubble.style.animation = "bubbleOut 0.3s ease-in forwards";
    setTimeout(() => {
      bubble.remove();
      _activeBubbles.delete(bubble);
    }, 300);
  }
  __name(_dismissBubble, "_dismissBubble");
  function showSpeechBubble(nodeEl, evt, isAlert) {
    for (const b of _activeBubbles) {
      if (b._nodeEl === nodeEl) {
        _dismissBubble(b);
        break;
      }
    }
    const bubble = document.createElement("div");
    const isQuest = evt.type === "quest";
    const isNotion = evt._source === "notion";
    let cls = "speech-bubble";
    if (isAlert) cls += " alert-bubble";
    if (isQuest) cls += " quest-bubble";
    if (isNotion) cls += " notion-bubble";
    bubble.className = cls;
    bubble._nodeEl = nodeEl;
    const name = nodeEl.querySelector(".node-label")?.textContent || evt.node;
    const closeBtn = document.createElement("button");
    closeBtn.className = "bubble-close";
    closeBtn.innerHTML = "\xD7";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _dismissBubble(bubble);
    });
    const prefix = isNotion ? '<span style="color:#a080e0">&#127744;</span> ' : isQuest ? '<span style="color:#c090ff">&#9733;</span> ' : "";
    bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${prefix}${evt.text || ""}</div>`;
    bubble.appendChild(closeBtn);
    if (evt.color) bubble.style.borderColor = evt.color;
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
    if (!isQuest) {
      const dur = (evt.duration || 15) * 1e3;
      setTimeout(() => {
        if (bubble.isConnected) _dismissBubble(bubble);
      }, dur);
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
  var STATUS_URL = "/status";
  async function poll() {
    try {
      const r = await fetch(STATUS_URL);
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      updateUI(d);
      if (!liveOk) {
        liveOk = true;
        console.log("Realm Map: live data connected");
      }
    } catch (e) {
      showOffline();
    }
    setTimeout(poll, updateSpeedMs);
  }
  __name(poll, "poll");
  poll();
  var canvas = document.getElementById("map-canvas");
  var world = document.getElementById("map-world");
  var scale = 1;
  var panX = 0;
  var panY = 0;
  var dragging = false;
  var lastX;
  var lastY;
  var _lastGlobeTilt = 0;
  function applyTransform() {
    if (_mapTilt > 0) {
      world.style.transformStyle = "preserve-3d";
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale}) translate(${cx}px, ${cy}px) rotateX(${_mapTilt}deg) translate(${-cx}px, ${-cy}px)`;
      if (_mapTilt !== _lastGlobeTilt) {
        _applyGlobeZ();
        _lastGlobeTilt = _mapTilt;
      }
    } else {
      if (_lastGlobeTilt !== 0) {
        _clearGlobeZ();
        _lastGlobeTilt = 0;
      }
      world.style.transformStyle = "";
      world.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }
    updateMinimap();
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
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });
  window.addEventListener("mouseup", () => dragging = false);
  var _touchPanning = false;
  var _lastTouch = null;
  var _pinchDist = null;
  canvas.addEventListener("touchstart", (e) => {
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
    _touchPanning = false;
    _lastTouch = null;
    _pinchDist = null;
  }, { passive: true });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldScale = scale;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.max(0.1, Math.min(3, scale * delta));
    panX = mx - (mx - panX) * (scale / oldScale);
    panY = my - (my - panY) * (scale / oldScale);
    applyTransform();
  }, { passive: false });
  var tooltip = document.getElementById("tooltip");
  document.querySelectorAll(".realm-node").forEach((node) => {
    node.addEventListener("mouseenter", (e) => {
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
    node.addEventListener("mousemove", (e) => {
      tooltip.style.left = e.clientX + 16 + "px";
      tooltip.style.top = e.clientY + 16 + "px";
    });
    node.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
    });
  });
  var minimap = document.getElementById("minimap");
  var viewport = document.getElementById("minimap-viewport");
  var mmW = 200;
  var mmH = 138;
  var worldW = WORLD_W;
  var worldH = WORLD_H;
  var MINIMAP_COLORS = {
    core: "#f0d890",
    infra: "#60a0c0",
    tower: "#c09060",
    bridge: "#9060c0",
    cluster: "#60c060",
    tailscale: "#40c040"
  };
  if (_topology) {
    _topology.nodes.forEach((n) => {
      const dot = document.createElement("div");
      dot.className = "minimap-dot";
      dot.dataset.mmTip = n.id;
      dot.style.left = n.x / worldW * mmW + "px";
      dot.style.top = n.y / worldH * mmH + "px";
      const isOffline = isTS(n) && !n.online;
      const mmType = n.tailscale ? "tailscale" : n.type;
      dot.style.background = isOffline ? "#404040" : MINIMAP_COLORS[mmType] || "#f0d890";
      minimap.appendChild(dot);
    });
  }
  function updateMinimap() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const vx = -panX / scale / worldW * mmW;
    const vy = -panY / scale / worldH * mmH;
    const vw = cw / scale / worldW * mmW;
    const vh = ch / scale / worldH * mmH;
    viewport.style.left = Math.max(0, vx) + "px";
    viewport.style.top = Math.max(0, vy) + "px";
    viewport.style.width = Math.min(mmW, vw) + "px";
    viewport.style.height = Math.min(mmH, vh) + "px";
  }
  __name(updateMinimap, "updateMinimap");
  centerMap();
  window.addEventListener("resize", centerMap);
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
    if (!cd && !tsPeer) {
      body.innerHTML = '<div class="pe-stats-empty">No sigils bound to this node.</div>';
      return;
    }
    let html = "";
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
    if (!cd) {
      body.innerHTML = html;
      return;
    }
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
    body.innerHTML = html;
  }
  __name(renderStatsPane, "renderStatsPane");
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
  document.querySelectorAll(".realm-node").forEach((node) => {
    node.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const key = node.dataset.tip;
      if (key) openPersonaEditor(key);
    });
  });
  var PANEL_ICONS = {
    "realm-panel": { icon: "\u2694", tooltip: "Realm Vitals", color: "#f0d890", rgb: [240, 216, 144] },
    "legend": { icon: "\u{1F5FA}", tooltip: "Legend", color: "#80b0ff", rgb: [128, 176, 255] },
    "spellbook": { icon: "\u{1F4D6}", tooltip: "Spellbook", color: "#c0a0ff", rgb: [192, 160, 255] },
    "quest-log": { icon: "\u2619", tooltip: "Quest Log", color: "#a0ff60", rgb: [160, 255, 96] },
    "realm-codex": { icon: "\u2630", tooltip: "Realm Codex", color: "#9060c0", rgb: [144, 96, 192] },
    "minimap": { icon: "\u25CE", tooltip: "Minimap", color: "#60a0c0", rgb: [96, 160, 192] },
    "node-list": { icon: "\u2691", tooltip: "Realm Census", color: "#c09060", rgb: [192, 144, 96] }
  };
  function setupPanelMinimize(panelId, handleSelector) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const cfg = PANEL_ICONS[panelId] || { icon: "\u2726", tooltip: panelId, color: "#f0d890" };
    const minIcon = document.createElement("div");
    minIcon.className = "panel-min-icon";
    minIcon.dataset.tooltip = cfg.tooltip;
    minIcon.innerHTML = `<span style="color:${cfg.color};filter:drop-shadow(0 0 4px ${cfg.color})">${cfg.icon}</span><div class="min-glow" style="box-shadow:0 0 8px ${cfg.color}30"></div>`;
    panel.appendChild(minIcon);
    const handle = handleSelector ? panel.querySelector(handleSelector) : panel;
    if (!handle) return;
    function doMinimize() {
      if (panel.classList.contains("panel-minimized")) return;
      panel._origWidth = panel.style.width || "";
      panel._origMinWidth = panel.style.minWidth || "";
      panel._origMaxHeight = panel.style.maxHeight || "";
      panel._origPadding = panel.style.padding || "";
      panel._origBorderRadius = panel.style.borderRadius || "";
      panel._origOverflow = panel.style.overflow || "";
      panel.classList.add("panel-minimized");
      panel.style.animation = "panelMinimize 0.4s ease-out";
      const rect = panel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      for (let i = 0; i < 8; i++) {
        spawnMote(
          cx + (Math.random() - 0.5) * 40,
          cy + (Math.random() - 0.5) * 40,
          cfg.rgb
        );
      }
      scheduleSave();
    }
    __name(doMinimize, "doMinimize");
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      doMinimize();
    });
    let _lastTapTime = 0;
    handle.addEventListener("touchend", (e) => {
      const now = Date.now();
      if (now - _lastTapTime < 350) {
        e.preventDefault();
        doMinimize();
        _lastTapTime = 0;
      } else {
        _lastTapTime = now;
      }
    });
    minIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!panel.classList.contains("panel-minimized")) return;
      if (minIcon._wasDragged) {
        minIcon._wasDragged = false;
        return;
      }
      panel.classList.remove("panel-minimized");
      panel.style.animation = "";
      const rect = panel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      for (let i = 0; i < 6; i++) {
        spawnMote(
          cx + (Math.random() - 0.5) * 60,
          cy + (Math.random() - 0.5) * 60,
          cfg.rgb
        );
      }
      scheduleSave();
    });
    let _minDx = 0, _minDy = 0, _minDragging = false, _minMoved = false, _minStartX = 0, _minStartY = 0;
    function minStartDrag(cx, cy) {
      _minDragging = true;
      _minMoved = false;
      _minStartX = cx;
      _minStartY = cy;
      const rect = panel.getBoundingClientRect();
      _minDx = cx - rect.left;
      _minDy = cy - rect.top;
      minIcon.style.cursor = "grabbing";
    }
    __name(minStartDrag, "minStartDrag");
    function minMoveDrag(cx, cy) {
      if (!_minDragging) return;
      if (!_minMoved && Math.abs(cx - _minStartX) + Math.abs(cy - _minStartY) < 6) return;
      _minMoved = true;
      panel.style.left = cx - _minDx + "px";
      panel.style.top = cy - _minDy + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.transform = "none";
      if (Math.random() < 0.4) spawnMote(cx + (Math.random() - 0.5) * 20, cy + (Math.random() - 0.5) * 20, cfg.rgb);
    }
    __name(minMoveDrag, "minMoveDrag");
    function minEndDrag() {
      if (_minDragging) {
        _minDragging = false;
        minIcon.style.cursor = "pointer";
        if (_minMoved) {
          minIcon._wasDragged = true;
          scheduleSave();
        }
      }
    }
    __name(minEndDrag, "minEndDrag");
    minIcon.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      minStartDrag(e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", (e) => minMoveDrag(e.clientX, e.clientY));
    window.addEventListener("mouseup", minEndDrag);
    minIcon.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      minStartDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener("touchmove", (e) => {
      if (_minDragging && e.touches.length) minMoveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchend", minEndDrag, { passive: true });
    minIcon.addEventListener("touchend", (e) => {
      if (_minMoved) return;
      if (!panel.classList.contains("panel-minimized")) return;
      e.preventDefault();
      e.stopPropagation();
      panel.classList.remove("panel-minimized");
      panel.style.animation = "";
      const rect = panel.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      for (let i = 0; i < 6; i++) {
        spawnMote(cx + (Math.random() - 0.5) * 60, cy + (Math.random() - 0.5) * 60, cfg.rgb);
      }
      scheduleSave();
    });
  }
  __name(setupPanelMinimize, "setupPanelMinimize");
  setupPanelMinimize("realm-panel", "h3");
  setupPanelMinimize("legend", "h3");
  setupPanelMinimize("spellbook", "h3");
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
  setupPanelMinimize("quest-log", "#quest-log-header");
  setupPanelMinimize("realm-codex", "#codex-header");
  setupPanelMinimize("minimap", null);
  setupPanelMinimize("node-list", "#node-list-header");
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
  var _layoutRunning = false;
  var _layoutWorker = null;
  var _layoutAttract = 4;
  var _layoutRepulse = 80;
  var _layoutEdgeLen = 80;
  var _layoutSpacing = 8;
  function autoArrangeLayout() {
    if (!_topology || _layoutRunning) return;
    _layoutRunning = true;
    const btn = document.getElementById("layout-auto-btn");
    if (btn) {
      btn.classList.add("running");
      btn.textContent = "\u2728 Arranging\u2026";
    }
    if (_layoutWorker) {
      _layoutWorker.terminate();
      _layoutWorker = null;
    }
    const nodeData = _topology.nodes.map((n) => ({ type: n.type }));
    const connData = _connIdx.map((c) => [c[0], c[1]]);
    _layoutWorker = new Worker("layout-worker.js");
    _layoutWorker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === "progress") {
        if (btn) btn.textContent = `\u2728 ${Math.round(msg.step / msg.total * 100)}%`;
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
          if (btn) {
            btn.classList.remove("running");
            btn.textContent = "\u2728 Auto-Arrange";
          }
        });
        _layoutWorker.terminate();
        _layoutWorker = null;
      }
    };
    _layoutWorker.onerror = function(err) {
      console.error("Layout worker error:", err);
      _layoutRunning = false;
      if (btn) {
        btn.classList.remove("running");
        btn.textContent = "\u2728 Auto-Arrange";
      }
      _layoutWorker = null;
    };
    _layoutWorker.postMessage({
      nodes: nodeData,
      connIdx: connData,
      params: { attract: _layoutAttract, repulse: _layoutRepulse, edgeLen: _layoutEdgeLen, spacing: _layoutSpacing },
      worldW: WORLD_W,
      worldH: WORLD_H
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
        _topoHash = "";
        if (_topoEnabled) renderTopoLayer(_lastTopoCollectd);
        scheduleSave();
        if (onDone) onDone();
      }
    }
    __name(step, "step");
    requestAnimationFrame(step);
  }
  __name(_animateToPositions, "_animateToPositions");
  document.getElementById("layout-auto-btn")?.addEventListener("click", autoArrangeLayout);
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
      ["vis-terrain", "#terrain"],
      ["vis-topo", "#topo-svg"],
      ["vis-connections", "#connections"],
      ["vis-nodes", null, ".realm-node"],
      ["vis-labels", null, ".node-label"],
      ["vis-regions", "#region-labels"],
      ["vis-bubbles", null, ".speech-bubble"],
      // Panels
      ["vis-titlebar", "#title-bar"],
      ["vis-statuspanel", "#realm-panel"],
      ["vis-legend", "#legend"],
      ["vis-codex", "#realm-codex"],
      ["vis-questlog", "#quest-log"],
      ["vis-minimap", "#minimap"],
      ["vis-nodelist", "#node-list"]
    ];
    for (const [id, sel, multiSel] of toggles) {
      const cb = document.getElementById(id);
      if (!cb) continue;
      cb.addEventListener("change", () => {
        const show = cb.checked;
        if (sel) {
          const el = document.querySelector(sel);
          if (el) el.style.display = show ? "" : "none";
        } else if (multiSel) {
          document.querySelectorAll(multiSel).forEach((el) => {
            el.style.visibility = show ? "" : "hidden";
          });
          if (!window._visState) window._visState = {};
          window._visState[multiSel] = show;
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
  function animateMotes() {
    const cw = moteCanvas.width, ch = moteCanvas.height;
    moteCtx.clearRect(0, 0, cw, ch);
    _sparkleTimer++;
    const spawnDiv = _PERF.sparkleDiv;
    if (_sparkleTimer % (2 * spawnDiv) === 0) _spawnAmbientSparkles();
    if (_sparkleTimer % (8 * spawnDiv) === 0) {
      const mapEl = document.getElementById("map-world");
      if (mapEl) _sparkleRect = mapEl.getBoundingClientRect();
      _spawnNodeSparkles();
    }
    if (_sparkleTimer % (6 * spawnDiv) === 0) _spawnLeyLineSparkles();
    const doGlow = _PERF.moteGlow;
    const doStar = _PERF.moteStarCross;
    let writeIdx = 0;
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
      moteCtx.beginPath();
      moteCtx.arc(m.x, m.y, sz, 0, Math.PI * 2);
      moteCtx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(2)})`;
      moteCtx.fill();
      if (doGlow) {
        moteCtx.beginPath();
        moteCtx.arc(m.x, m.y, sz * 2.5, 0, Math.PI * 2);
        moteCtx.fillStyle = `rgba(${r},${g},${b},${(a * 0.12).toFixed(3)})`;
        moteCtx.fill();
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
    requestAnimationFrame(animateMotes);
  }
  __name(animateMotes, "animateMotes");
  animateMotes();
  var LAYOUT_KEY = "realm-map-layout-v2";
  var SETTINGS_KEY = "realm-map-settings-v1";
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
    "layout-attract",
    "layout-repulse",
    "layout-edge",
    "layout-spacing",
    "layout-tilt",
    "biome-land",
    "biome-glow",
    "biome-roads",
    "biome-peaks",
    "biome-grid"
  ];
  var _PERSIST_CHECKBOXES = [
    "topo-toggle-cb",
    "vis-terrain",
    "vis-topo",
    "vis-connections",
    "vis-nodes",
    "vis-labels",
    "vis-regions",
    "vis-bubbles",
    "vis-titlebar",
    "vis-statuspanel",
    "vis-legend",
    "vis-codex",
    "vis-questlog",
    "vis-minimap",
    "vis-nodelist"
  ];
  function saveSettings() {
    if (_restoring) return;
    const s = { sliders: {}, checkboxes: {}, quality: null, collapsed: [] };
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
  }
  __name(saveSettings, "saveSettings");
  var _restoring = false;
  function restoreSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return false;
      const s = JSON.parse(raw);
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
      _restoring = false;
      return true;
    } catch (e) {
      _restoring = false;
    }
    return false;
  }
  __name(restoreSettings, "restoreSettings");
  function saveLayout() {
    const layout = { panels: {}, nodes: {}, minimized: [] };
    ["realm-panel", "legend", "spellbook", "quest-log", "realm-codex", "minimap", "node-list"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.style.left) {
        layout.panels[id] = { left: el.style.left, top: el.style.top };
      }
      if (el && el.classList.contains("panel-minimized")) {
        layout.minimized.push(id);
      }
    });
    document.querySelectorAll(".realm-node").forEach((n) => {
      const tip = n.dataset.tip;
      if (tip) layout.nodes[tip] = { left: n.style.left, top: n.style.top };
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    saveSettings();
  }
  __name(saveLayout, "saveLayout");
  function restoreLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return false;
      const layout = JSON.parse(raw);
      if (layout.panels) {
        Object.entries(layout.panels).forEach(([id, pos]) => {
          const el = document.getElementById(id);
          if (el && pos.left) {
            el.style.left = pos.left;
            el.style.top = pos.top;
            el.style.right = "auto";
            el.style.bottom = "auto";
            el.style.transform = "none";
          }
        });
      }
      if (layout.minimized) {
        layout.minimized.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.classList.add("panel-minimized");
        });
      }
      if (layout.nodes) {
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
      }
      return true;
    } catch (e) {
    }
    return false;
  }
  __name(restoreLayout, "restoreLayout");
  var _saveTimer = null;
  function scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      saveLayout();
    }, 500);
  }
  __name(scheduleSave, "scheduleSave");
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
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      e.preventDefault();
      startDrag(e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", (e) => moveDrag(e.clientX, e.clientY));
    window.addEventListener("mouseup", endDrag);
    handle.addEventListener("touchstart", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener("touchmove", (e) => {
      if (!isDragging || !e.touches.length) return;
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    window.addEventListener("touchend", endDrag, { passive: true });
  }
  __name(makeDraggable, "makeDraggable");
  makeDraggable(document.getElementById("realm-panel"), "h3", [240, 216, 144]);
  makeDraggable(document.getElementById("legend"), "h3", [100, 180, 255]);
  makeDraggable(document.getElementById("spellbook"), "h3", [192, 160, 255]);
  makeDraggable(document.getElementById("quest-log"), "#quest-log-header", [160, 255, 96]);
  makeDraggable(document.getElementById("realm-codex"), "#codex-header", [144, 96, 192]);
  makeDraggable(document.getElementById("minimap"), null, [96, 160, 192]);
  makeDraggable(document.getElementById("persona-editor"), ".pe-header", [240, 200, 100]);
  makeDraggable(document.getElementById("node-list"), "#node-list-header", [192, 144, 96]);
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
          _topoHash = "";
          if (_topoEnabled) renderTopoLayer(_lastTopoCollectd);
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
          }
        }
        dragNode = null;
      }
    }
    __name(endNodeDrag, "endNodeDrag");
    document.querySelectorAll(".realm-node").forEach((node) => {
      node.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        startNodeDrag(node, e.clientX, e.clientY);
      });
      node.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 1) return;
        e.stopPropagation();
        e.preventDefault();
        startNodeDrag(node, e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: false });
    });
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
  if (!restoreLayout()) {
    ["spellbook", "quest-log", "realm-codex", "minimap", "node-list"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("panel-minimized");
    });
  }
  restoreSettings();
})();
//# sourceMappingURL=realm-map.js.map
