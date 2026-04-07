# Autodiscovery Phase 7 — Frontend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the frontend for discovery data — Vassals tab in node detail panels, a discovery dashboard panel, and linked node indicators (badges/status) on the map. All work is in `src/*.js` files with `npm run build`.

**Depends on:** Phase 1 (core engine + API + SSE), Phases 2-6 (discovery data populated)

**Estimated tasks:** 3

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (section "Frontend Integration")

---

## File Structure

| File | Changes |
|------|---------|
| `src/node-controls.js` | Add "Vassals" tab to node detail panel |
| `src/panels.js` | Add discovery dashboard panel |
| `src/topology.js` | Add linked node indicators (badges, status colors) |
| `src/app.js` | Wire SSE `discovery` event to panels |
| `realm-map.html` | Add panel template HTML for discovery dashboard |
| `realm-map.css` | Styles for Vassals tab, discovery panel, status badges |

---

## Task 1: Vassals Tab in Node Detail Panel

**Files:** `src/node-controls.js`, `realm-map.html`, `realm-map.css`

**Description:** When clicking a host node that has sub-entities, the node detail panel gains a "Vassals" tab showing containers, VMs, services, and other discovered entities. Each entry shows name, type icon, status indicator (colored dot), and expandable metadata. Includes link/unlink buttons for manual entity linking and a "Promote" button to create topology nodes from SubEntities.

**Key frontend logic (src/node-controls.js):**

```javascript
async function renderVassalsTab(nodeId) {
    const resp = await fetch(`/discovery/${nodeId}`);
    const entities = await resp.json();
    if (!entities.length) return '<p class="muted">No vassals discovered</p>';

    const grouped = {};
    for (const e of entities) {
        const type = e.type;
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(e);
    }

    let html = '';
    const typeLabels = {
        container: 'Iron Golems', vm: 'Ethereal Planes',
        service: 'Runic Wards', wifi_client: 'Wandering Spirits',
        snmp_port: 'Crystal Channels', reverse_proxy: 'Gate Wardens',
    };

    for (const [type, items] of Object.entries(grouped)) {
        const label = typeLabels[type] || type;
        html += `<div class="vassal-group">
            <h4>${label} (${items.length})</h4>
            ${items.map(e => renderVassalEntry(e)).join('')}
        </div>`;
    }
    return html;
}

function renderVassalEntry(entity) {
    const statusClass = {
        running: 'status-up', stopped: 'status-down',
        failed: 'status-critical', stale: 'status-stale',
        connected: 'status-up', up: 'status-up', down: 'status-down',
    }[entity.status] || 'status-unknown';

    const linked = entity.linked_node_id
        ? `<span class="vassal-link">→ ${entity.linked_node_id}</span>`
        : `<button class="vassal-promote" data-id="${entity.id}">Promote</button>`;

    return `<div class="vassal-entry" data-entity-id="${entity.id}">
        <span class="vassal-status ${statusClass}"></span>
        <span class="vassal-name">${entity.name}</span>
        ${linked}
        <div class="vassal-meta hidden">
            ${Object.entries(entity.metadata || {})
                .map(([k,v]) => `<div><b>${k}:</b> ${v}</div>`).join('')}
        </div>
    </div>`;
}
```

**CSS additions (realm-map.css):**

```css
.vassal-group h4 { color: var(--gold); font-size: 0.85rem; margin: 0.5rem 0 0.25rem; }
.vassal-entry { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; }
.vassal-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.vassal-status.status-up { background: var(--green); }
.vassal-status.status-down { background: var(--red); }
.vassal-status.status-critical { background: var(--red); animation: pulse 1s infinite; }
.vassal-status.status-stale { background: var(--muted); }
.vassal-name { flex: 1; font-size: 0.8rem; }
.vassal-link { font-size: 0.75rem; color: var(--accent); }
.vassal-promote { font-size: 0.7rem; padding: 0.1rem 0.4rem; }
.vassal-meta { font-size: 0.7rem; color: var(--muted); padding-left: 1rem; }
```

**Interactions:**
- Click entry → toggle metadata expansion
- Click "Promote" → `POST /discovery/promote {sub_entity_id: ...}` → refresh panel
- Link/unlink → `POST /discovery/link` or `/discovery/unlink`

- [ ] Step 1: Add "Vassals" tab to node detail panel tab system in `node-controls.js`
- [ ] Step 2: Implement `renderVassalsTab()` with grouped display
- [ ] Step 3: Add promote/link/unlink click handlers
- [ ] Step 4: Add CSS styles to `realm-map.css`
- [ ] Step 5: Wire SSE `discovery` event to refresh Vassals tab when open
- [ ] Step 6: `npm run build` and test
- [ ] Step 7: Commit

---

## Task 2: Discovery Dashboard Panel ("Realm Surveyors")

**Files:** `src/panels.js`, `realm-map.html`, `realm-map.css`

**Description:** A new plugin panel showing the discovery engine overview. Registered as a standard panel (like latency, firewall, census). Shows: provider status grid (name, last scan, entity count, error count), per-host capability matrix, unlinked entities needing attention, and recent discovery events. Updated via SSE `discovery` events.

**Key frontend logic (src/panels.js):**

```javascript
function renderDiscoveryPanel(data) {
    if (!data) return '';
    const { sub_entities, summary } = data;

    // Summary bar
    let html = `<div class="discovery-summary">
        <span class="disc-total">${summary.total} vassals</span>
        <span class="disc-running">${summary.running} active</span>
        ${summary.failed ? `<span class="disc-failed">${summary.failed} failed</span>` : ''}
        ${summary.stopped ? `<span class="disc-stopped">${summary.stopped} stopped</span>` : ''}
    </div>`;

    // Per-host breakdown
    html += '<div class="discovery-hosts">';
    for (const [hostId, entities] of Object.entries(sub_entities)) {
        const running = entities.filter(e => e.status === 'running').length;
        const failed = entities.filter(e => e.status === 'failed').length;
        const statusClass = failed ? 'host-warn' : 'host-ok';
        html += `<div class="disc-host ${statusClass}" data-node="${hostId}">
            <span class="disc-host-name">${hostId}</span>
            <span class="disc-host-count">${entities.length}</span>
            ${failed ? `<span class="disc-host-failed">${failed} failed</span>` : ''}
        </div>`;
    }
    html += '</div>';

    // Unlinked entities (need attention)
    const allEntities = Object.values(sub_entities).flat();
    const unlinked = allEntities.filter(e => !e.linked_node_id && e.type !== 'snmp_port');
    if (unlinked.length) {
        html += `<div class="disc-unlinked">
            <h4>Unlinked (${unlinked.length})</h4>
            ${unlinked.slice(0, 20).map(e =>
                `<div class="disc-unlinked-item">${e.name} <span class="muted">(${e.type})</span></div>`
            ).join('')}
        </div>`;
    }

    return html;
}
```

**Provider status** requires a separate fetch to `/discovery/providers`:

```javascript
async function loadProviderStatus() {
    const resp = await fetch('/discovery/providers');
    const providers = await resp.json();
    // Render grid: name | last_scan | entity_count | errors
}
```

**Panel registration in realm-map.html:**
```html
<div class="panel" id="discovery-panel" data-panel="discovery">
    <div class="panel-header">
        <h3>Realm Surveyors</h3>
    </div>
    <div class="panel-body" id="discovery-content"></div>
</div>
```

- [ ] Step 1: Add panel HTML template to `realm-map.html`
- [ ] Step 2: Implement `renderDiscoveryPanel()` in `src/panels.js`
- [ ] Step 3: Add provider status grid with `/discovery/providers` fetch
- [ ] Step 4: Wire SSE `discovery` event updates
- [ ] Step 5: Add click handlers (host → navigate to node, unlinked → link dialog)
- [ ] Step 6: Add CSS styles — fantasy theme consistent with existing panels
- [ ] Step 7: `npm run build` and test
- [ ] Step 8: Commit

---

## Task 3: Linked Node Indicators on Map

**Files:** `src/topology.js`, `src/node-status.js`, `realm-map.css`

**Description:** Topology nodes linked to sub-entities gain visual indicators on the map. A small badge icon shows the entity type (container, VM, service). Status color comes from the discovery engine (green/red/yellow/gray). The node tooltip includes discovery info ("container on disks | running"). This is purely visual — the data already flows via SSE status updates with discovery enrichment from Phase 1's node enricher.

**Key frontend logic (src/topology.js):**

```javascript
function renderDiscoveryBadge(nodeEl, nodeData) {
    // Discovery metadata is in status blob under node's meta
    const discoveryType = nodeData.meta?.['discovery:type'];
    const discoveryHost = nodeData.meta?.['discovery:host'];
    const discoveryStatus = nodeData.meta?.['discovery:status'];
    if (!discoveryType) return;

    const iconMap = {
        container: '⚙', vm: '☁', service: '⚡',
        wifi_client: '📶', reverse_proxy: '🚪',
    };
    const icon = iconMap[discoveryType] || '◆';

    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    badge.setAttribute('class', `discovery-badge discovery-${discoveryStatus}`);
    badge.setAttribute('x', nodeEl.getAttribute('cx') || 0);
    badge.setAttribute('y', (parseFloat(nodeEl.getAttribute('cy') || 0) - 12));
    badge.setAttribute('text-anchor', 'middle');
    badge.setAttribute('font-size', '10');
    badge.textContent = icon;
    nodeEl.parentNode.appendChild(badge);
}
```

**Key tooltip addition (src/node-status.js):**

```javascript
function getDiscoverySublabel(nodeData) {
    const type = nodeData.meta?.['discovery:type'];
    const host = nodeData.meta?.['discovery:host'];
    const status = nodeData.meta?.['discovery:status'];
    if (!type) return null;
    return `${type} on ${host} | ${status}`;
}
```

**CSS for badges:**

```css
.discovery-badge { fill: var(--gold); pointer-events: none; }
.discovery-badge.discovery-running { fill: var(--green); }
.discovery-badge.discovery-stopped { fill: var(--muted); }
.discovery-badge.discovery-failed { fill: var(--red); }

/* Host nodes with sub-entities get a subtle count badge */
.discovery-host-count {
    fill: var(--gold); font-size: 8px;
    font-family: var(--font-mono);
}
```

- [ ] Step 1: Add badge rendering in `src/topology.js` node render pass
- [ ] Step 2: Add discovery sublabel to tooltip in `src/node-status.js`
- [ ] Step 3: Add host-node entity count indicator
- [ ] Step 4: Add CSS styles to `realm-map.css`
- [ ] Step 5: `npm run build` and test visually
- [ ] Step 6: Verify badges update on SSE `discovery` and `status` events
- [ ] Step 7: Commit

---

## What's Next

This completes the autodiscovery engine implementation. After Phase 7:
- status.realm.watch can read from realmwatch's `/discovery` API instead of maintaining manual checks
- The oracle and herald can reference discovery data for richer responses
- Future plugins (mDNS, UPnP, cloud deployment APIs) follow the same provider pattern
