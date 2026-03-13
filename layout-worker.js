// ── Layout Web Worker — Multiple Arrangement Modes ──
// Pure computation — no DOM access. Receives topology + mode, returns positions.

self.onmessage = function(e) {
  const { nodes, connIdx, params, worldW, worldH, mode, nodeVlans } = e.data;
  const { attract, repulse, edgeLen, spacing } = params;
  const N = nodes.length;

  // ── Build graph ──
  const degree = new Float32Array(N);
  const neighbors = new Array(N);
  for (let i = 0; i < N; i++) neighbors[i] = [];
  for (const [a, b] of connIdx) {
    degree[a]++; degree[b]++;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }

  // ── Type hierarchy rank ──
  const typeRank = { core: 5, infra: 4, bridge: 3, tower: 3, portal: 2, cluster: 2, device: 1, tailscale: 1 };

  // ── Find the heart (most important node) ──
  let heartIdx = 0;
  for (let i = 1; i < N; i++) {
    const s = (typeRank[nodes[i].type] || 1) * 2 + degree[i];
    const hs = (typeRank[nodes[heartIdx].type] || 1) * 2 + degree[heartIdx];
    if (s > hs) heartIdx = i;
  }

  // ── BFS tree from heart ──
  const parent = new Int32Array(N).fill(-1);
  const depthArr = new Int32Array(N).fill(-1);
  const children = new Array(N);
  for (let i = 0; i < N; i++) children[i] = [];
  const bfs = [heartIdx]; depthArr[heartIdx] = 0;
  let qi = 0;
  while (qi < bfs.length) {
    const cur = bfs[qi++];
    const unvisited = neighbors[cur].filter(nb => depthArr[nb] === -1);
    unvisited.sort((a, b) => degree[b] - degree[a]);
    for (const nb of unvisited) {
      depthArr[nb] = depthArr[cur] + 1;
      parent[nb] = cur;
      children[cur].push(nb);
      bfs.push(nb);
    }
  }
  for (let i = 0; i < N; i++) {
    if (depthArr[i] === -1) { depthArr[i] = 1; parent[i] = heartIdx; children[heartIdx].push(i); }
  }

  // ── Subtree sizes ──
  const subtreeSize = new Int32Array(N).fill(1);
  for (let k = bfs.length - 1; k >= 0; k--) {
    const idx = bfs[k];
    for (const ch of children[idx]) subtreeSize[idx] += subtreeSize[ch];
  }

  const W = worldW * 0.85, H = worldH * 0.85, CX = W / 2, CY = H / 2;
  const pos = new Array(N);

  // ══════════════════════════════════════════════
  // ── LAYOUT MODES ──
  // ══════════════════════════════════════════════

  switch (mode || 'world-tree') {
    case 'world-tree': layoutWorldTree(); break;
    case 'realm-domains': layoutRealmDomains(); break;
    case 'great-hierarchy': layoutGreatHierarchy(); break;
    case 'ring-of-power': layoutRingOfPower(); break;
    case 'constellation': layoutConstellation(); break;
    case 'serpents-spine': layoutSerpentsSpine(); break;
    default: layoutWorldTree();
  }

  // ── World Tree: Radial BFS (original) ──
  function layoutWorldTree() {
    const ringDist = (d) => d === 0 ? 0 : edgeLen + (d - 1) * edgeLen * 0.85;
    const wedge = new Array(N);
    wedge[heartIdx] = { start: 0, end: Math.PI * 2 };
    pos[heartIdx] = { x: CX, y: CY };

    for (let k = 0; k < bfs.length; k++) {
      const idx = bfs[k];
      const ch = children[idx];
      if (ch.length === 0) continue;
      const w = wedge[idx];
      const totalLeaves = ch.reduce((s, c) => s + subtreeSize[c], 0);
      let angleStart = w.start;
      for (const c of ch) {
        const fraction = subtreeSize[c] / totalLeaves;
        const angleEnd = angleStart + (w.end - w.start) * fraction;
        wedge[c] = { start: angleStart, end: angleEnd };
        const midAngle = (angleStart + angleEnd) / 2;
        const r = ringDist(depthArr[c]);
        pos[c] = {
          x: CX + Math.cos(midAngle) * r,
          y: CY + Math.sin(midAngle) * r * 0.82,
        };
        angleStart = angleEnd;
      }
    }
  }

  // ── Realm Domains: VLAN-clustered islands ──
  function layoutRealmDomains() {
    const vlanGroups = {};
    for (let i = 0; i < N; i++) {
      const v = (nodeVlans && nodeVlans[i]) || 6;
      if (!vlanGroups[v]) vlanGroups[v] = [];
      vlanGroups[v].push(i);
    }
    const vlans = Object.keys(vlanGroups).map(Number).sort((a, b) => {
      if (a === 6) return -1; if (b === 6) return 1;
      return vlanGroups[b].length - vlanGroups[a].length;
    });

    const vlanCenters = {};
    const ringR = Math.min(W, H) * 0.32;
    vlans.forEach((v, i) => {
      if (i === 0) {
        vlanCenters[v] = { x: CX, y: CY };
      } else {
        const angle = ((i - 1) / (vlans.length - 1)) * Math.PI * 2 - Math.PI / 2;
        vlanCenters[v] = {
          x: CX + Math.cos(angle) * ringR,
          y: CY + Math.sin(angle) * ringR * 0.82,
        };
      }
    });

    for (const v of vlans) {
      const group = vlanGroups[v];
      const center = vlanCenters[v];
      group.sort((a, b) => {
        const sa = (typeRank[nodes[a].type] || 1) * 2 + degree[a];
        const sb = (typeRank[nodes[b].type] || 1) * 2 + degree[b];
        return sb - sa;
      });

      if (group.length === 1) {
        pos[group[0]] = { x: center.x, y: center.y };
      } else {
        pos[group[0]] = { x: center.x, y: center.y };
        let ring = 1, ri = 1;
        const nodesPerRing = 6;
        for (let j = 1; j < group.length; j++) {
          const angle = (ri / Math.min(nodesPerRing * ring, group.length - 1)) * Math.PI * 2;
          const r = ring * edgeLen * 0.7;
          pos[group[j]] = {
            x: center.x + Math.cos(angle) * r,
            y: center.y + Math.sin(angle) * r * 0.82,
          };
          ri++;
          if (ri > nodesPerRing * ring) { ring++; ri = 1; }
        }
      }
    }
  }

  // ── Great Hierarchy: Tiered horizontal bands ──
  function layoutGreatHierarchy() {
    const tierMap = { core: 0, infra: 1, tower: 2, bridge: 2, portal: 3, cluster: 3, device: 4, tailscale: 5 };
    const tiers = {};
    for (let i = 0; i < N; i++) {
      const t = tierMap[nodes[i].type] || 4;
      if (!tiers[t]) tiers[t] = [];
      tiers[t].push(i);
    }

    const tierKeys = Object.keys(tiers).map(Number).sort();
    const numTiers = tierKeys.length;
    const bandH = H / (numTiers + 1);

    for (let ti = 0; ti < tierKeys.length; ti++) {
      const tier = tiers[tierKeys[ti]];
      const y = bandH * (ti + 1);
      tier.sort((a, b) => degree[b] - degree[a]);
      const tierW = W * 0.8;
      const gap = tier.length > 1 ? tierW / (tier.length - 1) : 0;
      const startX = CX - tierW / 2;
      for (let j = 0; j < tier.length; j++) {
        pos[tier[j]] = {
          x: tier.length === 1 ? CX : startX + j * gap,
          y: y + (Math.random() - 0.5) * bandH * 0.3,
        };
      }
    }
  }

  // ── Ring of Power: Concentric depth rings ──
  function layoutRingOfPower() {
    const maxDepth = Math.max(...depthArr);
    const ringGap = Math.min(W, H) * 0.4 / (maxDepth + 1);

    const rings = {};
    for (let i = 0; i < N; i++) {
      const d = depthArr[i];
      if (!rings[d]) rings[d] = [];
      rings[d].push(i);
    }

    pos[heartIdx] = { x: CX, y: CY };

    for (let d = 1; d <= maxDepth; d++) {
      const ring = rings[d];
      if (!ring) continue;
      const r = ringGap * d;
      ring.sort((a, b) => {
        const pa = parent[a] >= 0 && pos[parent[a]] ? Math.atan2(pos[parent[a]].y - CY, pos[parent[a]].x - CX) : 0;
        const pb = parent[b] >= 0 && pos[parent[b]] ? Math.atan2(pos[parent[b]].y - CY, pos[parent[b]].x - CX) : 0;
        return pa - pb;
      });
      for (let j = 0; j < ring.length; j++) {
        const angle = (j / ring.length) * Math.PI * 2 - Math.PI / 2;
        pos[ring[j]] = {
          x: CX + Math.cos(angle) * r,
          y: CY + Math.sin(angle) * r * 0.82,
        };
      }
    }
  }

  // ── Constellation: Star-cluster patterns ──
  function layoutConstellation() {
    const threshold = 3;
    const stars = [];
    const assigned = new Uint8Array(N);

    const byImportance = Array.from({length: N}, (_, i) => i);
    byImportance.sort((a, b) => {
      const sa = (typeRank[nodes[a].type] || 1) * 3 + degree[a];
      const sb = (typeRank[nodes[b].type] || 1) * 3 + degree[b];
      return sb - sa;
    });

    for (const i of byImportance) {
      if (assigned[i]) continue;
      if (degree[i] >= threshold || nodes[i].type === 'core' || nodes[i].type === 'infra') {
        stars.push({ center: i, members: [i] });
        assigned[i] = 1;
        for (const nb of neighbors[i]) {
          if (!assigned[nb]) {
            stars[stars.length - 1].members.push(nb);
            assigned[nb] = 1;
          }
        }
      }
    }

    for (let i = 0; i < N; i++) {
      if (assigned[i]) continue;
      let bestStar = 0;
      for (let s = 0; s < stars.length; s++) {
        for (const nb of neighbors[i]) {
          if (stars[s].members.includes(nb)) { bestStar = s; break; }
        }
      }
      if (stars.length > 0) {
        stars[bestStar].members.push(i);
      } else {
        stars.push({ center: i, members: [i] });
      }
      assigned[i] = 1;
    }

    const numStars = stars.length;
    for (let s = 0; s < numStars; s++) {
      const star = stars[s];
      const angle = s * 2.399963; // golden angle
      const r = Math.sqrt(s + 1) * Math.min(W, H) * 0.06;
      const cx = CX + Math.cos(angle) * r;
      const cy = CY + Math.sin(angle) * r * 0.82;

      pos[star.center] = { x: cx, y: cy };

      const members = star.members.filter(m => m !== star.center);
      const starR = Math.max(edgeLen * 0.6, members.length * edgeLen * 0.15);
      for (let j = 0; j < members.length; j++) {
        const a = (j / members.length) * Math.PI * 2 - Math.PI / 2;
        const mr = (j % 2 === 0) ? starR : starR * 0.6;
        pos[members[j]] = {
          x: cx + Math.cos(a) * mr,
          y: cy + Math.sin(a) * mr * 0.82,
        };
      }
    }
  }

  // ── Serpent's Spine: Linear backbone with branches ──
  function layoutSerpentsSpine() {
    function farthestFrom(start) {
      const dist = new Int32Array(N).fill(-1);
      const q = [start]; dist[start] = 0;
      let last = start;
      let qi2 = 0;
      while (qi2 < q.length) {
        const cur = q[qi2++];
        last = cur;
        for (const nb of neighbors[cur]) {
          if (dist[nb] === -1) { dist[nb] = dist[cur] + 1; q.push(nb); }
        }
      }
      return { node: last, dist };
    }

    const { node: end1 } = farthestFrom(heartIdx);
    const { node: end2 } = farthestFrom(end1);

    const spine = [end2];
    const prev = new Int32Array(N).fill(-1);
    {
      const q = [end1]; const vis = new Uint8Array(N); vis[end1] = 1;
      let qi2 = 0;
      while (qi2 < q.length) {
        const cur = q[qi2++];
        if (cur === end2) break;
        for (const nb of neighbors[cur]) {
          if (!vis[nb]) { vis[nb] = 1; prev[nb] = cur; q.push(nb); }
        }
      }
    }
    {
      let cur = end2;
      while (prev[cur] !== -1) { spine.push(prev[cur]); cur = prev[cur]; }
    }
    spine.reverse();

    const onSpine = new Uint8Array(N);
    spine.forEach(s => { onSpine[s] = 1; });

    const spineLen = spine.length;
    const amplitude = H * 0.25;
    const waveLen = W * 0.85;
    const startX2 = (W - waveLen) / 2 + 100;

    for (let j = 0; j < spineLen; j++) {
      const t = spineLen === 1 ? 0.5 : j / (spineLen - 1);
      const x = startX2 + t * waveLen;
      const y = CY + Math.sin(t * Math.PI * 2) * amplitude;
      pos[spine[j]] = { x, y };
    }

    for (let i = 0; i < N; i++) {
      if (onSpine[i]) continue;
      let nearestSpine = -1;
      const visited = new Uint8Array(N); visited[i] = 1;
      const bfsQ = [{ node: i, dist: 0 }];
      let bi = 0;
      while (bi < bfsQ.length) {
        const { node: cur, dist: d } = bfsQ[bi++];
        if (onSpine[cur] && d > 0) { nearestSpine = cur; break; }
        for (const nb of neighbors[cur]) {
          if (!visited[nb]) { visited[nb] = 1; bfsQ.push({ node: nb, dist: d + 1 }); }
        }
      }

      if (nearestSpine >= 0 && pos[nearestSpine]) {
        const sx = pos[nearestSpine].x;
        const sy = pos[nearestSpine].y;
        const side = (i % 2 === 0) ? 1 : -1;
        const offset = (bfsQ.find(q => q.node === nearestSpine)?.dist || 1) * edgeLen * 0.6;
        pos[i] = {
          x: sx + (Math.random() - 0.5) * edgeLen * 0.3,
          y: sy + side * offset,
        };
      } else {
        pos[i] = { x: CX + (Math.random() - 0.5) * W * 0.5, y: CY + (Math.random() - 0.5) * H * 0.5 };
      }
    }
  }

  // ══════════════════════════════════════════════
  // ── SHARED: Overlap-removal force simulation ──
  // ══════════════════════════════════════════════

  const vel = new Array(N);
  for (let i = 0; i < N; i++) vel[i] = { x: 0, y: 0 };

  const STEPS = 50;
  const isWorldTree = (mode || 'world-tree') === 'world-tree';

  for (let step = 0; step < STEPS; step++) {
    const temp = 1 - step / STEPS;

    // Overlap repulsion
    const repBase = repulse * 400 * (0.1 + 0.9 * temp);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d2 = dx * dx + dy * dy + 100;
        if (d2 > 40000) continue;
        const f = repBase / d2;
        vel[i].x += dx * f; vel[i].y += dy * f;
        vel[j].x -= dx * f; vel[j].y -= dy * f;
      }
    }

    // Edge attraction
    if (isWorldTree) {
      // World Tree: only non-tree edges
      for (const [iA, iB] of connIdx) {
        if (parent[iA] === iB || parent[iB] === iA) continue;
        const dx = pos[iB].x - pos[iA].x;
        const dy = pos[iB].y - pos[iA].y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const idealLen = edgeLen * 1.5;
        if (d <= idealLen) continue;
        const f = attract * 0.0005 * (d - idealLen) * temp;
        vel[iA].x += (dx / d) * f; vel[iA].y += (dy / d) * f;
        vel[iB].x -= (dx / d) * f; vel[iB].y -= (dy / d) * f;
      }

      // World Tree: same-depth spacing
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          if (depthArr[i] !== depthArr[j]) continue;
          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const d2 = dx * dx + dy * dy + 1;
          if (d2 < 10000) {
            const push = spacing * 500 * temp / d2;
            vel[i].x += dx * push; vel[i].y += dy * push;
            vel[j].x -= dx * push; vel[j].y -= dy * push;
          }
        }
      }
    } else {
      // Other modes: all connected edges
      for (const [iA, iB] of connIdx) {
        const dx = pos[iB].x - pos[iA].x;
        const dy = pos[iB].y - pos[iA].y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const idealLen = edgeLen * 1.2;
        if (d <= idealLen) continue;
        const f = attract * 0.0003 * (d - idealLen) * temp;
        vel[iA].x += (dx / d) * f; vel[iA].y += (dy / d) * f;
        vel[iB].x -= (dx / d) * f; vel[iB].y -= (dy / d) * f;
      }
    }

    // Apply velocities
    for (let i = 0; i < N; i++) {
      vel[i].x *= 0.7; vel[i].y *= 0.7;
      const vLen = Math.sqrt(vel[i].x * vel[i].x + vel[i].y * vel[i].y);
      if (vLen > 6) { vel[i].x *= 6 / vLen; vel[i].y *= 6 / vLen; }
      pos[i].x += vel[i].x; pos[i].y += vel[i].y;
    }

    if ((step + 1) % 10 === 0) {
      self.postMessage({ type: 'progress', step: step + 1, total: STEPS });
    }
  }

  // ── Post-process: center + scale to fill world ──
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    if (pos[i].x < minX) minX = pos[i].x;
    if (pos[i].x > maxX) maxX = pos[i].x;
    if (pos[i].y < minY) minY = pos[i].y;
    if (pos[i].y > maxY) maxY = pos[i].y;
  }
  const usedW = maxX - minX + 200, usedH = maxY - minY + 200;
  const PAD = 120;
  const fitScale = Math.min((W - PAD * 2) / usedW, (H - PAD * 2) / usedH);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  for (let i = 0; i < N; i++) {
    pos[i].x = CX + (pos[i].x - cx) * fitScale;
    pos[i].y = CY + (pos[i].y - cy) * fitScale;
  }

  // Return flat arrays for efficient transfer
  const xArr = new Float32Array(N);
  const yArr = new Float32Array(N);
  for (let i = 0; i < N; i++) { xArr[i] = pos[i].x; yArr[i] = pos[i].y; }

  self.postMessage(
    { type: 'done', x: xArr.buffer, y: yArr.buffer, count: N },
    [xArr.buffer, yArr.buffer]
  );
};
