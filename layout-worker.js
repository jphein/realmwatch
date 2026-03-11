// ── Force-Directed Layout Web Worker ──
// Pure computation — no DOM access. Receives topology data, returns positions.

self.onmessage = function(e) {
  const { nodes, connIdx, params, worldW, worldH } = e.data;
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

  // ── Find the heart (most important node) ──
  const typeRank = { core: 5, infra: 4, bridge: 3, tower: 3, portal: 2, cluster: 2, device: 1, tailscale: 1 };
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

  // ── Radial tree layout ──
  const W = worldW * 0.85, H = worldH * 0.85, CX = W / 2, CY = H / 2;
  const pos = new Array(N);
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

  // ── Overlap-removal pass (force sim) ──
  const vel = new Array(N);
  for (let i = 0; i < N; i++) vel[i] = { x: 0, y: 0 };

  const STEPS = 120;
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

    // Non-tree edge attraction
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

    // Same-depth spacing
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

    // Apply velocities
    for (let i = 0; i < N; i++) {
      vel[i].x *= 0.7; vel[i].y *= 0.7;
      const vLen = Math.sqrt(vel[i].x * vel[i].x + vel[i].y * vel[i].y);
      if (vLen > 6) { vel[i].x *= 6 / vLen; vel[i].y *= 6 / vLen; }
      pos[i].x += vel[i].x; pos[i].y += vel[i].y;
    }

    // Report progress every 30 steps
    if ((step + 1) % 30 === 0) {
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
    [xArr.buffer, yArr.buffer] // transferable
  );
};
