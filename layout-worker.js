// ── Layout Web Worker — Multiple Arrangement Modes ──
// Pure computation — no DOM access. Receives topology + mode, returns positions.

self.onmessage = function(e) {
  const { nodes, connIdx, params, worldW, worldH, mode, nodeVlans, latencyMap, wifiMap } = e.data;
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

  // ── Shared: WiFi detection + golden ratio arrangement ──
  const _wifiSet = new Set();
  const _apGroups = {};  // {apNodeIdx: [clientIdx, ...]}
  if (wifiMap) {
    for (let i = 0; i < N; i++) {
      const w = wifiMap[nodes[i].id];
      if (w && w.ap) {
        _wifiSet.add(i);
        const apIdx = nodes.findIndex(n => n.id === w.ap);
        if (apIdx >= 0) {
          if (!_apGroups[apIdx]) _apGroups[apIdx] = [];
          _apGroups[apIdx].push(i);
        }
      }
    }
  }

  function _isWifi(i) { return _wifiSet.has(i); }

  function _goldenArrange(apX, apY, clientIndices, spc) {
    const PHI = 2.39996322; // golden angle radians
    for (let j = 0; j < clientIndices.length; j++) {
      const angle = j * PHI;
      const r = Math.sqrt(j + 1) * spc;
      pos[clientIndices[j]] = {
        x: apX + Math.cos(angle) * r,
        y: apY + Math.sin(angle) * r * 0.86,
      };
    }
  }

  function _estimateLatency(iA, iB) {
    if (!latencyMap) return null;
    const idA = nodes[iA].id, idB = nodes[iB].id;
    const rttA = latencyMap[idA], rttB = latencyMap[idB];
    const aWifi = _isWifi(iA), bWifi = _isWifi(iB);

    // Both WiFi same AP
    if (aWifi && bWifi) {
      const apA = wifiMap && wifiMap[idA] ? wifiMap[idA].ap : null;
      const apB = wifiMap && wifiMap[idB] ? wifiMap[idB].ap : null;
      return (apA && apA === apB) ? 10 : 25;
    }
    // One WiFi
    if (aWifi || bWifi) {
      const wId = aWifi ? idA : idB;
      const wiredRtt = aWifi ? rttB : rttA;
      const snr = (wifiMap && wifiMap[wId]) ? (wifiMap[wId].snr || 30) : 30;
      return Math.max(5, Math.min(40, 5 + (60 - snr) * 0.5)) + (wiredRtt || 0.5);
    }
    // Both wired
    if (rttA == null && rttB == null) return null;
    if (rttA == null) return rttB;
    if (rttB == null) return rttA;
    // Approximate: if both RTTs are very low (<1ms), assume same switch
    if (rttA < 1 && rttB < 1) return Math.max(rttA, rttB);
    return rttA + rttB;
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
    case 'hexcrown': layoutHexcrown(); break;
    case 'runic-spiral': layoutRunicSpiral(); break;
    case 'leyline-nexus': layoutLeylineNexus(); break;
    case 'latency-cartograph': layoutLatencyCartograph(); break;
    case 'golden-resonance': layoutGoldenResonance(); break;
    case 'latency-forge': layoutLatencyForge(); break;
    case 'spectral-sigil': layoutSpectralSigil(); break;
    case 'arcane-mandala': layoutArcaneMandala(); break;
    case 'stress-atlas': layoutStressAtlas(); break;
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

  // ── Hexcrown: Concentric hexagonal rings matching the arcane grid ──
  function layoutHexcrown() {
    // Sort all nodes by importance (type rank * 2 + degree), heart first
    const sorted = Array.from({length: N}, (_, i) => i);
    sorted.sort((a, b) => {
      if (a === heartIdx) return -1;
      if (b === heartIdx) return 1;
      const sa = (typeRank[nodes[a].type] || 1) * 2 + degree[a];
      const sb = (typeRank[nodes[b].type] || 1) * 2 + degree[b];
      return sb - sa;
    });

    // Hex ring geometry: ring d has 6*d slots (ring 0 = 1 center slot)
    const ringDist = edgeLen * 1.1;
    let placed = 0;

    // Place heart at center
    pos[sorted[0]] = { x: CX, y: CY };
    placed = 1;

    let ring = 1;
    while (placed < N) {
      const slots = 6 * ring;
      const r = ring * ringDist;
      for (let s = 0; s < slots && placed < N; s++) {
        const angle = (s / slots) * Math.PI * 2 - Math.PI / 6;
        pos[sorted[placed]] = {
          x: CX + Math.cos(angle) * r,
          y: CY + Math.sin(angle) * r * 0.86,
        };
        placed++;
      }
      ring++;
    }
  }

  // ── Runic Spiral: VLAN groups along logarithmic spiral arms ──
  function layoutRunicSpiral() {
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

    // Sort nodes within each VLAN by importance
    for (const v of vlans) {
      vlanGroups[v].sort((a, b) => {
        const sa = (typeRank[nodes[a].type] || 1) * 2 + degree[a];
        const sb = (typeRank[nodes[b].type] || 1) * 2 + degree[b];
        return sb - sa;
      });
    }

    const numArms = vlans.length;
    const maxR = Math.min(W, H) * 0.44;
    const spiralTightness = 0.12; // controls how fast the spiral expands

    for (let ai = 0; ai < numArms; ai++) {
      const arm = vlanGroups[vlans[ai]];
      const armAngleOffset = (ai / numArms) * Math.PI * 2;

      for (let j = 0; j < arm.length; j++) {
        if (j === 0 && ai === 0) {
          // First node of first arm (heart equivalent) near center
          pos[arm[j]] = { x: CX, y: CY };
          continue;
        }
        // Logarithmic spiral: r = a * e^(b * theta)
        const t = (j + 1) / (arm.length + 1);
        const theta = armAngleOffset + t * Math.PI * 3.5; // ~1.75 full turns per arm
        const r = maxR * (1 - Math.exp(-spiralTightness * (j + 1))) * 0.95;
        pos[arm[j]] = {
          x: CX + Math.cos(theta) * r,
          y: CY + Math.sin(theta) * r * 0.86,
        };
      }
    }
  }

  // ── Leyline Nexus: 6 radial hex-angle leylines with branches ──
  function layoutLeylineNexus() {
    // 6 primary leylines at 60° intervals
    const NUM_LINES = 6;
    const maxReach = Math.min(W, H) * 0.44;

    // Assign nodes to leylines based on BFS parent chain direction
    const lineAssign = new Int32Array(N).fill(-1);
    const lineNodes = new Array(NUM_LINES);
    for (let i = 0; i < NUM_LINES; i++) lineNodes[i] = [];

    // Heart at center
    pos[heartIdx] = { x: CX, y: CY };
    lineAssign[heartIdx] = -2; // special: center

    // Assign depth-1 children to nearest leyline by round-robin of importance
    const d1 = children[heartIdx].slice().sort((a, b) => {
      const sa = (typeRank[nodes[a].type] || 1) * 2 + degree[a];
      const sb = (typeRank[nodes[b].type] || 1) * 2 + degree[b];
      return sb - sa;
    });
    for (let i = 0; i < d1.length; i++) {
      const line = i % NUM_LINES;
      lineAssign[d1[i]] = line;
      lineNodes[line].push(d1[i]);
    }

    // Propagate: each deeper node inherits its parent's leyline
    for (let k = 0; k < bfs.length; k++) {
      const idx = bfs[k];
      if (lineAssign[idx] < 0) continue;
      for (const ch of children[idx]) {
        if (lineAssign[ch] === -1) {
          lineAssign[ch] = lineAssign[idx];
          lineNodes[lineAssign[idx]].push(ch);
        }
      }
    }

    // Catch any unassigned nodes
    for (let i = 0; i < N; i++) {
      if (lineAssign[i] === -1) {
        const smallest = lineNodes.reduce((mi, arr, idx) =>
          arr.length < lineNodes[mi].length ? idx : mi, 0);
        lineAssign[i] = smallest;
        lineNodes[smallest].push(i);
      }
    }

    // Place nodes along each leyline
    for (let li = 0; li < NUM_LINES; li++) {
      const line = lineNodes[li];
      if (line.length === 0) continue;
      const baseAngle = (li / NUM_LINES) * Math.PI * 2 - Math.PI / 2;

      // Sort by depth then importance
      line.sort((a, b) => {
        if (depthArr[a] !== depthArr[b]) return depthArr[a] - depthArr[b];
        const sa = (typeRank[nodes[a].type] || 1) * 2 + degree[a];
        const sb = (typeRank[nodes[b].type] || 1) * 2 + degree[b];
        return sb - sa;
      });

      for (let j = 0; j < line.length; j++) {
        const t = (j + 1) / (line.length + 1);
        const r = t * maxReach;
        // Alternate nodes slightly off the main line at ±30° (hex branch angles)
        const branchOffset = (j % 3 === 0) ? 0 :
                             (j % 3 === 1) ? Math.PI / 6 : -Math.PI / 6;
        const branchR = branchOffset !== 0 ? edgeLen * 0.4 : 0;
        const mainX = CX + Math.cos(baseAngle) * r;
        const mainY = CY + Math.sin(baseAngle) * r * 0.86;
        pos[line[j]] = {
          x: mainX + Math.cos(baseAngle + branchOffset) * branchR,
          y: mainY + Math.sin(baseAngle + branchOffset) * branchR * 0.86,
        };
      }
    }
  }

  // ── Latency Cartograph: Radial map, wired distance = f(rtt), WiFi golden spirals ──
  function layoutLatencyCartograph() {
    // Find katana (or highest-ranked core node) as center
    let centerIdx = heartIdx;
    for (let i = 0; i < N; i++) {
      if (nodes[i].id === 'katana') { centerIdx = i; break; }
    }
    pos[centerIdx] = { x: CX, y: CY };

    // Separate wired and WiFi nodes
    const wired = [];
    for (let i = 0; i < N; i++) {
      if (i === centerIdx) continue;
      if (!_isWifi(i)) wired.push(i);
    }

    // Sort wired by BFS depth from center, then by degree
    const bfsDist = new Int32Array(N).fill(-1);
    bfsDist[centerIdx] = 0;
    const bfsQ = [centerIdx];
    let bqi = 0;
    while (bqi < bfsQ.length) {
      const cur = bfsQ[bqi++];
      for (const nb of neighbors[cur]) {
        if (bfsDist[nb] === -1) {
          bfsDist[nb] = bfsDist[cur] + 1;
          bfsQ.push(nb);
        }
      }
    }

    // Place wired nodes radially: distance = f(latency), angle = BFS order
    const baseR = edgeLen * 1.5;
    wired.sort((a, b) => {
      const da = bfsDist[a], db = bfsDist[b];
      if (da !== db) return da - db;
      return degree[b] - degree[a];
    });

    for (let j = 0; j < wired.length; j++) {
      const i = wired[j];
      const rtt = (latencyMap && latencyMap[nodes[i].id]) || null;
      const r = rtt != null
        ? baseR * Math.max(0.5, Math.log2(rtt + 1) + 0.5)
        : baseR * (bfsDist[i] || 1);
      // Distribute angle evenly, BFS order preserves topology adjacency
      const angle = (j / wired.length) * Math.PI * 2 - Math.PI / 2;
      pos[i] = {
        x: CX + Math.cos(angle) * r,
        y: CY + Math.sin(angle) * r * 0.86,
      };
    }

    // Place WiFi nodes as golden spirals around their AP
    const wifiSpacing = edgeLen * 0.35;
    for (const [apIdxStr, clients] of Object.entries(_apGroups)) {
      const apIdx = parseInt(apIdxStr);
      const apPos = pos[apIdx] || { x: CX, y: CY };
      _goldenArrange(apPos.x, apPos.y, clients, wifiSpacing);
    }

    // Place any remaining unpositioned nodes
    for (let i = 0; i < N; i++) {
      if (!pos[i]) {
        pos[i] = { x: CX + (Math.random() - 0.5) * W * 0.3, y: CY + (Math.random() - 0.5) * H * 0.3 };
      }
    }
  }

  // ── Golden Resonance: Vogel sunflower, radial order = latency rank ──
  function layoutGoldenResonance() {
    const PHI_ANGLE = 2.39996322;

    // Separate wired and WiFi
    const wired = [];
    const wifiByAp = {};  // {apIdx: [clientIdx, ...]}
    for (let i = 0; i < N; i++) {
      if (_isWifi(i)) {
        // Find AP index
        const wData = wifiMap && wifiMap[nodes[i].id];
        const apIdx = wData ? nodes.findIndex(n => n.id === wData.ap) : -1;
        if (apIdx >= 0) {
          if (!wifiByAp[apIdx]) wifiByAp[apIdx] = [];
          wifiByAp[apIdx].push(i);
        } else {
          wired.push(i); // no AP found, treat as wired
        }
      } else {
        wired.push(i);
      }
    }

    // Sort wired by latency (lowest first, null at end)
    wired.sort((a, b) => {
      const la = (latencyMap && latencyMap[nodes[a].id]) ?? 9999;
      const lb = (latencyMap && latencyMap[nodes[b].id]) ?? 9999;
      if (la !== lb) return la - lb;
      // Tie-break by type rank
      return (typeRank[nodes[b].type] || 1) - (typeRank[nodes[a].type] || 1);
    });

    // Place wired nodes in Vogel sunflower pattern
    const spc = edgeLen * 0.85;
    for (let j = 0; j < wired.length; j++) {
      const angle = j * PHI_ANGLE;
      const r = Math.sqrt(j + 1) * spc;
      pos[wired[j]] = {
        x: CX + Math.cos(angle) * r,
        y: CY + Math.sin(angle) * r * 0.86,
      };
    }

    // Insert WiFi children as golden sub-spirals around their AP
    const wifiSpacing = edgeLen * 0.3;
    for (const [apIdxStr, clients] of Object.entries(wifiByAp)) {
      const apIdx = parseInt(apIdxStr);
      const apPos = pos[apIdx] || { x: CX, y: CY };
      _goldenArrange(apPos.x, apPos.y, clients, wifiSpacing);
    }

    // Catch unpositioned
    for (let i = 0; i < N; i++) {
      if (!pos[i]) {
        pos[i] = { x: CX + (Math.random() - 0.5) * W * 0.3, y: CY + (Math.random() - 0.5) * H * 0.3 };
      }
    }
  }

  // ── Latency Forge: Force-directed with latency-derived rest lengths ──
  function layoutLatencyForge() {
    // Initialize from BFS radial (gives a reasonable starting shape)
    layoutWorldTree();

    // Build rest-length table for each edge
    const restLengths = new Float32Array(connIdx.length);
    for (let e = 0; e < connIdx.length; e++) {
      const [iA, iB] = connIdx[e];
      const aWifi = _isWifi(iA), bWifi = _isWifi(iB);

      if (aWifi && bWifi) {
        restLengths[e] = edgeLen * 0.3;
      } else if (aWifi || bWifi) {
        restLengths[e] = edgeLen * 0.4;
      } else {
        const est = _estimateLatency(iA, iB);
        restLengths[e] = est != null
          ? edgeLen * Math.max(0.5, Math.log2(est + 1))
          : edgeLen * 1.2;
      }
    }

    // Force simulation: 100 iterations
    const FORGE_STEPS = 100;
    const fVel = new Array(N);
    for (let i = 0; i < N; i++) fVel[i] = { x: 0, y: 0 };

    for (let step = 0; step < FORGE_STEPS; step++) {
      const temp = 1 - step / FORGE_STEPS;

      // Repulsion (all pairs, close range)
      const repBase = repulse * 400 * (0.1 + 0.9 * temp);
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const d2 = dx * dx + dy * dy + 100;
          if (d2 > 40000) continue;
          const f = repBase / d2;
          fVel[i].x += dx * f; fVel[i].y += dy * f;
          fVel[j].x -= dx * f; fVel[j].y -= dy * f;
        }
      }

      // Spring forces toward rest lengths
      for (let e = 0; e < connIdx.length; e++) {
        const [iA, iB] = connIdx[e];
        const dx = pos[iB].x - pos[iA].x;
        const dy = pos[iB].y - pos[iA].y;
        const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const rl = restLengths[e];
        const f = attract * 0.0008 * (d - rl) * temp;
        fVel[iA].x += (dx / d) * f; fVel[iA].y += (dy / d) * f;
        fVel[iB].x -= (dx / d) * f; fVel[iB].y -= (dy / d) * f;
      }

      // WiFi gravity: extra pull toward AP
      for (const [apIdxStr, clients] of Object.entries(_apGroups)) {
        const apIdx = parseInt(apIdxStr);
        if (!pos[apIdx]) continue;
        for (const ci of clients) {
          const dx = pos[apIdx].x - pos[ci].x;
          const dy = pos[apIdx].y - pos[ci].y;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.1;
          if (d > edgeLen * 0.5) {
            const f = 0.05 * temp;
            fVel[ci].x += dx * f; fVel[ci].y += dy * f;
          }
        }
      }

      // Apply velocities
      for (let i = 0; i < N; i++) {
        fVel[i].x *= 0.7; fVel[i].y *= 0.7;
        const vLen = Math.sqrt(fVel[i].x * fVel[i].x + fVel[i].y * fVel[i].y);
        if (vLen > 8) { fVel[i].x *= 8 / vLen; fVel[i].y *= 8 / vLen; }
        pos[i].x += fVel[i].x; pos[i].y += fVel[i].y;
      }

      if ((step + 1) % 20 === 0) {
        self.postMessage({ type: 'progress', step: step + 1, total: FORGE_STEPS });
      }
    }

    // Final pass: rearrange WiFi clusters as golden spirals around settled AP positions
    const wifiSpacing = edgeLen * 0.3;
    for (const [apIdxStr, clients] of Object.entries(_apGroups)) {
      const apIdx = parseInt(apIdxStr);
      if (pos[apIdx]) {
        _goldenArrange(pos[apIdx].x, pos[apIdx].y, clients, wifiSpacing);
      }
    }
  }

  // ── Spectral Sigil: Eigenvector layout — crystalline star chart ──
  // Uses power iteration on the graph Laplacian to find the 2nd and 3rd
  // smallest eigenvectors (Fiedler vectors). Reveals deep topological symmetry.
  function layoutSpectralSigil() {
    // Build Laplacian L = D - A
    const L = new Array(N);
    for (let i = 0; i < N; i++) {
      L[i] = new Float64Array(N);
      L[i][i] = degree[i];
    }
    for (const [a, b] of connIdx) {
      L[a][b] -= 1;
      L[b][a] -= 1;
    }

    // Power iteration to find smallest non-trivial eigenvectors
    // We use inverse iteration with shift: solve (L - σI)^{-1} v = λv
    // But for small N, use explicit deflated power iteration on (maxλI - L)
    // to find the LARGEST eigenvectors of the flipped matrix.

    // First, estimate max eigenvalue (Gershgorin bound)
    let maxLam = 0;
    for (let i = 0; i < N; i++) {
      let rowSum = 0;
      for (let j = 0; j < N; j++) rowSum += Math.abs(L[i][j]);
      if (rowSum > maxLam) maxLam = rowSum;
    }

    // M = maxLam * I - L  (flips spectrum: smallest eigenvalues of L become largest of M)
    const M = new Array(N);
    for (let i = 0; i < N; i++) {
      M[i] = new Float64Array(N);
      for (let j = 0; j < N; j++) M[i][j] = -L[i][j];
      M[i][i] += maxLam;
    }

    function matVec(mat, v) {
      const r = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) s += mat[i][j] * v[j];
        r[i] = s;
      }
      return r;
    }

    function normalize(v) {
      let s = 0;
      for (let i = 0; i < N; i++) s += v[i] * v[i];
      s = Math.sqrt(s) || 1;
      for (let i = 0; i < N; i++) v[i] /= s;
      return v;
    }

    function dot(a, b) {
      let s = 0;
      for (let i = 0; i < N; i++) s += a[i] * b[i];
      return s;
    }

    function deflate(v, against) {
      const d = dot(v, against);
      for (let i = 0; i < N; i++) v[i] -= d * against[i];
      return v;
    }

    // Find top 3 eigenvectors of M (= bottom 3 of L)
    const ITERS = 200;
    const evecs = [];

    // The first eigenvector of L is always [1,1,...1]/√N (trivial)
    const trivial = new Float64Array(N).fill(1 / Math.sqrt(N));
    evecs.push(trivial);

    for (let ev = 1; ev <= 2; ev++) {
      let v = new Float64Array(N);
      for (let i = 0; i < N; i++) v[i] = Math.random() - 0.5;
      normalize(v);

      for (let iter = 0; iter < ITERS; iter++) {
        v = matVec(M, v);
        // Deflate against all previously found eigenvectors
        for (const prev of evecs) deflate(v, prev);
        normalize(v);
      }
      evecs.push(v);
    }

    // Use 2nd and 3rd eigenvectors as x, y coordinates
    const v2 = evecs[1], v3 = evecs[2];
    for (let i = 0; i < N; i++) {
      pos[i] = { x: CX + v2[i] * W * 0.4, y: CY + v3[i] * H * 0.4 };
    }
  }

  // ── Arcane Mandala: Concentric VLAN rings with angular sectors ──
  // Each VLAN occupies a ring radius and angular wedge. Core nodes at center,
  // infrastructure on inner rings, devices on outer. Within each ring, nodes
  // spread evenly across their VLAN's wedge.
  function layoutArcaneMandala() {
    // Group by VLAN
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

    // Each VLAN gets a wedge (angular sector)
    const numVlans = vlans.length;
    const wedgeSize = (Math.PI * 2) / numVlans;
    const maxR = Math.min(W, H) * 0.44;

    // Tier radii: core=0, infra=0.2, tower/bridge=0.45, portal/cluster=0.65, device/ts=0.85
    const tierRadius = { core: 0, infra: 0.2, tower: 0.45, bridge: 0.45, portal: 0.65, cluster: 0.65, device: 0.85, tailscale: 0.95 };

    for (let vi = 0; vi < numVlans; vi++) {
      const vlan = vlans[vi];
      const group = vlanGroups[vlan];
      const wedgeStart = vi * wedgeSize - Math.PI / 2;

      // Sort by tier (inner first), then by degree
      group.sort((a, b) => {
        const ra = tierRadius[nodes[a].type] || 0.85;
        const rb = tierRadius[nodes[b].type] || 0.85;
        if (ra !== rb) return ra - rb;
        return degree[b] - degree[a];
      });

      // Group nodes by their tier ring
      const tiers = {};
      for (const idx of group) {
        const r = tierRadius[nodes[idx].type] || 0.85;
        const rKey = Math.round(r * 100);
        if (!tiers[rKey]) tiers[rKey] = { r, nodes: [] };
        tiers[rKey].nodes.push(idx);
      }

      for (const tier of Object.values(tiers)) {
        const tierNodes = tier.nodes;
        const r = tier.r * maxR;

        if (r === 0) {
          // Core nodes go to center
          for (let j = 0; j < tierNodes.length; j++) {
            const a = wedgeStart + (j + 0.5) * wedgeSize / Math.max(tierNodes.length, 1);
            pos[tierNodes[j]] = {
              x: CX + Math.cos(a) * maxR * 0.08,
              y: CY + Math.sin(a) * maxR * 0.08,
            };
          }
        } else {
          // Distribute evenly within the wedge at this radius
          for (let j = 0; j < tierNodes.length; j++) {
            const frac = (j + 0.5) / tierNodes.length;
            const a = wedgeStart + frac * wedgeSize;
            // Slight radial jitter for visual interest
            const rJitter = r + (j % 2 === 0 ? -1 : 1) * maxR * 0.03;
            pos[tierNodes[j]] = {
              x: CX + Math.cos(a) * rJitter,
              y: CY + Math.sin(a) * rJitter * 0.86,
            };
          }
        }
      }
    }
  }

  // ── Stress Atlas: Graph-distance-preserving MDS layout (SMACOF) ──
  // Computes all-pairs shortest path distances, then iteratively finds 2D
  // positions that preserve those distances. Produces topographic, map-like
  // layouts where visual distance = network distance.
  function layoutStressAtlas() {
    // All-pairs shortest path (BFS — unweighted)
    const dist = new Array(N);
    for (let i = 0; i < N; i++) {
      dist[i] = new Float32Array(N).fill(Infinity);
      dist[i][i] = 0;
      const q = [i];
      let qi2 = 0;
      while (qi2 < q.length) {
        const cur = q[qi2++];
        for (const nb of neighbors[cur]) {
          if (dist[i][nb] === Infinity) {
            dist[i][nb] = dist[i][cur] + 1;
            q.push(nb);
          }
        }
      }
    }

    // Initialize positions: use spectral layout for a good start
    // (2 eigenvectors of Laplacian, quick power iteration)
    const Lm = new Array(N);
    for (let i = 0; i < N; i++) {
      Lm[i] = new Float64Array(N);
      Lm[i][i] = degree[i];
    }
    for (const [a, b] of connIdx) { Lm[a][b] -= 1; Lm[b][a] -= 1; }

    let maxLam = 0;
    for (let i = 0; i < N; i++) maxLam = Math.max(maxLam, 2 * degree[i]);
    const Mm = new Array(N);
    for (let i = 0; i < N; i++) {
      Mm[i] = new Float64Array(N);
      for (let j = 0; j < N; j++) Mm[i][j] = -Lm[i][j];
      Mm[i][i] += maxLam;
    }

    function mv(mat, v) {
      const r = new Float64Array(N);
      for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += mat[i][j] * v[j]; r[i] = s; }
      return r;
    }
    function nrm(v) { let s = 0; for (let i = 0; i < N; i++) s += v[i]*v[i]; s = Math.sqrt(s)||1; for (let i = 0; i < N; i++) v[i]/=s; return v; }
    function dt(a,b) { let s=0; for (let i=0; i<N; i++) s+=a[i]*b[i]; return s; }
    function dfl(v,u) { const d=dt(v,u); for (let i=0; i<N; i++) v[i]-=d*u[i]; return v; }

    const trivial2 = new Float64Array(N).fill(1/Math.sqrt(N));
    const evs = [trivial2];
    for (let e = 1; e <= 2; e++) {
      let v = new Float64Array(N); for (let i=0; i<N; i++) v[i] = Math.random()-0.5; nrm(v);
      for (let it = 0; it < 100; it++) { v = mv(Mm, v); for (const p of evs) dfl(v, p); nrm(v); }
      evs.push(v);
    }

    // Initialize from spectral
    for (let i = 0; i < N; i++) {
      pos[i] = { x: CX + evs[1][i] * W * 0.3, y: CY + evs[2][i] * H * 0.3 };
    }

    // SMACOF iteration — minimize stress = Σ w_ij (||xi-xj|| - d_ij)^2
    // w_ij = 1/d_ij^2 (inverse distance weighting)
    const SMACOF_STEPS = 80;
    const idealScale = edgeLen * 1.2; // 1 graph hop = this many pixels

    for (let step = 0; step < SMACOF_STEPS; step++) {
      const newX = new Float64Array(N);
      const newY = new Float64Array(N);
      const wSum = new Float64Array(N);

      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const dij = dist[i][j];
          if (dij === Infinity) continue;
          const targetDist = dij * idealScale;
          const w = 1 / (dij * dij); // weight

          const dx = pos[i].x - pos[j].x;
          const dy = pos[i].y - pos[j].y;
          const currDist = Math.sqrt(dx*dx + dy*dy) || 0.01;

          newX[i] += w * (pos[j].x + targetDist * dx / currDist);
          newY[i] += w * (pos[j].y + targetDist * dy / currDist);
          wSum[i] += w;
        }
      }

      for (let i = 0; i < N; i++) {
        if (wSum[i] > 0) {
          pos[i].x = newX[i] / wSum[i];
          pos[i].y = newY[i] / wSum[i];
        }
      }

      if ((step + 1) % 20 === 0) {
        self.postMessage({ type: 'progress', step: step + 1, total: SMACOF_STEPS });
      }
    }
  }

  // ══════════════════════════════════════════════
  // ── SHARED: Overlap-removal force simulation ──
  // ══════════════════════════════════════════════

  // ── Fallback: place any nodes not yet positioned ──
  // Disconnected nodes (not reachable by BFS from heartIdx) are skipped by
  // most layout modes. Give them valid positions before the force sim reads
  // pos[i].x — undefined would corrupt all velocities via NaN propagation.
  {
    const unpos = [];
    for (let i = 0; i < N; i++) if (!pos[i]) unpos.push(i);
    if (unpos.length > 0) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(unpos.length)));
      const cellW = edgeLen * 0.65, cellH = edgeLen * 0.55;
      unpos.forEach((idx, j) => {
        const col = j % cols, row = Math.floor(j / cols);
        // Place in a grid just below the main layout, centered on X
        pos[idx] = {
          x: CX + (col - cols / 2) * cellW,
          y: H * 0.82 + row * cellH,
        };
      });
    }
  }

  // Latency Forge runs its own extended force sim — skip the shared one
  const skipSharedSim = (mode === 'latency-forge' || mode === 'stress-atlas');

  if (!skipSharedSim) {
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
