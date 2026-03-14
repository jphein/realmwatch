// ── Topo Heightmap Web Worker ──
// Pure computation: Gaussian stamping + river carving + marching squares → SVG path strings.
// No DOM access. Receives node positions + traffic + settings, returns contour band data.

self.onmessage = function(e) {
  const { nodes, connections, collectd, settings, grid, perfTier } = e.data;
  const { spread, contours, riverWidth, riverDepth } = settings;
  const { W, H, sx, sy, pad } = grid;

  // ── Build traffic map ──
  const trafficMap = new Map();
  let hash = spread + '|' + contours + '|' + riverWidth + '|' + riverDepth;
  for (const n of nodes) {
    const t = getNodeTraffic(collectd, n.id);
    trafficMap.set(n.id, t);
    hash += '|' + (t ? (Math.log2(t.total + 1) | 0) : 0);
  }

  // ── Heightmap ──
  const hmap = new Float32Array(W * H);
  hmap.fill(0.15);

  const sigma = spread / sx;
  const hs3 = (sigma * 3) | 0;
  const inv2s2 = 1 / (2 * sigma * sigma);

  // 1) Stamp gaussian peaks
  for (const n of nodes) {
    const iw = (n.iconStyle && n.iconStyle.width) ? parseInt(n.iconStyle.width) : 64;
    const ih = (n.iconStyle && n.iconStyle.height) ? parseInt(n.iconStyle.height) : 64;
    const cx = (n.x + iw / 2) / sx + pad, cy = (n.y + ih / 2) / sy + pad;
    const h = nodeHeight(n, trafficMap);
    const x0 = Math.max(0, (cx - hs3) | 0), x1 = Math.min(W - 1, (cx + hs3) | 0);
    const y0 = Math.max(0, (cy - hs3) | 0), y1 = Math.min(H - 1, (cy + hs3) | 0);
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

  // 2) Carve river valleys along connections
  if (connections) {
    const nodeMap = new Map();
    for (const n of nodes) nodeMap.set(n.id, n);
    for (const c of connections) {
      const fn = nodeMap.get(c.from), tn = nodeMap.get(c.to);
      if (!fn || !tn) continue;
      const tFrom = trafficMap.get(c.from), tTo = trafficMap.get(c.to);
      const tr = (tFrom && tTo) ? (tFrom.total > tTo.total ? tFrom : tTo) : (tFrom || tTo);
      let I = 0;
      if (tr && tr.total > 0) I = Math.max(0, Math.min(1, (Math.log10(tr.total + 1) - 3) / 4));
      const rw = sigma * (riverWidth + I * 0.5);
      const rd = riverDepth + I * (1 - riverDepth) * 0.5;
      const irw = 1 / (2 * rw * rw);
      const rw3 = (rw * 3) | 0;
      const ax = fn.x / sx + pad, ay = fn.y / sy + pad, bx = tn.x / sx + pad, by = tn.y / sy + pad;
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(4, (dist / 2) | 0);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        const lx0 = Math.max(0, (px - rw3) | 0), lx1 = Math.min(W - 1, (px + rw3) | 0);
        const ly0 = Math.max(0, (py - rw3) | 0), ly1 = Math.min(H - 1, (py + rw3) | 0);
        for (let y = ly0; y <= ly1; y++) {
          const dy2 = (y - py) * (y - py);
          const row = y * W;
          for (let x = lx0; x <= lx1; x++) {
            const dx = x - px, d = (dx * dx + dy2) * irw;
            if (d < 8) hmap[row + x] *= 1 - rd * Math.exp(-d);
          }
        }
      }
    }
  }

  // 3) Marching squares → SVG path strings
  const nC = contours;
  const cStep = nC > 0 ? 1 / (nC + 1) : 0;
  const topoHaloRes = perfTier === 'low' ? 2 : 1;
  const topoFilters = perfTier !== 'low';
  const bands = [];

  for (let ci = 1; ci <= nC; ci++) {
    const lev = ci * cStep;
    const isIdx = (ci % 5 === 0);
    const t = ci / nC;
    const col = topoColor(t);
    let pathD = '';

    for (let gy = 0; gy < H - 1; gy++) {
      for (let gx = 0; gx < W - 1; gx++) {
        const i = gy * W + gx;
        const v00 = hmap[i], v10 = hmap[i + 1], v01 = hmap[i + W], v11 = hmap[i + W + 1];
        const cls = ((v00 >= lev) << 3) | ((v10 >= lev) << 2) | ((v11 >= lev) << 1) | (v01 >= lev);
        if (cls === 0 || cls === 15) continue;

        const lrp = (a, b) => (b === a) ? 0.5 : (lev - a) / (b - a);
        const T = [(gx + lrp(v00, v10) - pad) * sx, (gy - pad) * sy];
        const B = [(gx + lrp(v01, v11) - pad) * sx, (gy + 1 - pad) * sy];
        const L = [(gx - pad) * sx, (gy + lrp(v00, v01) - pad) * sy];
        const R = [(gx + 1 - pad) * sx, (gy + lrp(v10, v11) - pad) * sy];
        const seg = (a, b) => { pathD += `M${a[0]|0},${a[1]|0}L${b[0]|0},${b[1]|0}`; };

        switch (cls) {
          case 1: case 14: seg(L, B); break;
          case 2: case 13: seg(B, R); break;
          case 3: case 12: seg(L, R); break;
          case 4: case 11: seg(T, R); break;
          case 6: case 9:  seg(T, B); break;
          case 7: case 8:  seg(L, T); break;
          case 5: {
            const ctr = (v00 + v10 + v01 + v11) / 4;
            if (ctr >= lev) { seg(L, B); seg(T, R); }
            else { seg(L, T); seg(B, R); }
            break;
          }
          case 10: {
            const ctr = (v00 + v10 + v01 + v11) / 4;
            if (ctr >= lev) { seg(L, T); seg(B, R); }
            else { seg(L, B); seg(T, R); }
            break;
          }
        }
      }
    }

    if (!pathD) continue;

    // Include halo?
    const halo = (ci % topoHaloRes === 0);
    const fillOp = halo ? (t < 0.15 ? 0.09 : 0.05) : 0;
    const sw = isIdx ? 3 : 1.3;
    const op = isIdx ? 0.6 : 0.3;
    const useFilter = isIdx && topoFilters;

    bands.push({ pathD, col, elev: t, sw, op, halo, fillOp, useFilter });
  }

  self.postMessage({ hash, bands });
};

// ── Helper: get traffic for a node from collectd-like object ──
function getNodeTraffic(collectd, nodeKey) {
  if (!collectd) return null;
  const key = nodeKey.toLowerCase();
  let cd = collectd[nodeKey];
  if (!cd) {
    for (const k of Object.keys(collectd)) {
      if (k.toLowerCase().split('.')[0] === key) { cd = collectd[k]; break; }
    }
  }
  if (!cd) {
    cd = Object.values(collectd).find(c =>
      c.hostname && c.hostname.toLowerCase().replace(/[-_]/g, '') === key.replace(/[-_]/g, ''));
  }
  if (!cd || !cd.interfaces) return null;
  let bestRx = 0, bestTx = 0, bestTotal = 0;
  for (const iface of Object.values(cd.interfaces)) {
    const rx = iface.rx_bps || 0, tx = iface.tx_bps || 0;
    if (rx + tx > bestTotal) { bestRx = rx; bestTx = tx; bestTotal = rx + tx; }
  }
  return bestTotal > 0 ? { rx: bestRx, tx: bestTx, total: bestTotal } : null;
}

// ── Helper: node height based on type + traffic ──
function nodeHeight(node, trafficMap) {
  const traffic = trafficMap.get(node.id);
  let h = 0.18;
  if (traffic && traffic.total > 0) {
    const raw = Math.max(0, Math.min(1, (Math.log10(traffic.total + 1) - 3) / 4));
    h = 0.25 + raw * 0.75;
  }
  if (node.type === 'core') h = Math.max(h, 0.6);
  else if (node.type === 'tower') h = Math.max(h, 0.35);
  else if (node.type === 'bridge') h = Math.max(h, 0.28);
  return h;
}

// ── Helper: elevation → color ──
function topoColor(t) {
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
