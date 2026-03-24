'use strict';
import { _mapTilt } from './config.js';
import { _topology, _nodeMap, getNodeDOM } from './topology.js';
import { panToNode, invalidateGlobeZCache } from './map-view.js';
import { unsealPanel } from './panel-manager.js';

// Late-bound callback for openNodeChat (set by app.js to avoid circular dep)
let _openNodeChat = () => {};
export function setOpenNodeChat(fn) { _openNodeChat = fn; }

// ── Event rendering (SSE replaces polling — see initSSE below) ──
let lastEventTs = 0;

const _pageLoadTs = Date.now() / 1000;
const BUBBLE_RESTORE_AGE = 600;  // Restore bubbles for events up to 10 min old
const _restoredBubbleNodes = new Set();  // Track which nodes got a restored bubble

export function renderEvent(evt, isRestore = false) {
  lastEventTs = Math.max(lastEventTs, evt.ts || 0);
  const nodeEl = document.querySelector(`[data-tip="${evt.node}"]`);

  // Always log to quest log (addLogEntry checks dismissed internally)
  addLogEntry(evt, nodeEl);

  // Skip bubble for dismissed events
  if (evt.text && _dismissedQuests.has(evt.text)) return;

  // For restored events, only show bubble (no highlight flash)
  // For live events, show both bubble and highlight
  const evtAge = _pageLoadTs - (evt.ts || 0);
  const isStale = evtAge > 30 && !evt._local;

  if (!nodeEl) return;

  // One bubble per node — latest event always wins (showSpeechBubble dismisses the old one).
  // On restore: SSE replays chronologically, so last event per node is the most recent.
  // Just let each event overwrite — showSpeechBubble handles the dedup.
  let showBubble = false;
  const isPersistent = ['quest', 'alert', 'oracle_query', 'oracle_response'].includes(evt.type);
  if (isRestore) {
    showBubble = isPersistent || evtAge < BUBBLE_RESTORE_AGE;
  } else if (!isStale) {
    showBubble = true;
  }

  if (!showBubble) return;

  if (evt.type === 'speech') {
    showSpeechBubble(nodeEl, evt);
    if (!isRestore) showHighlight(nodeEl, { color: evt.color || 'rgba(160,200,255,0.4)' });
  } else if (evt.type === 'highlight') {
    if (!isRestore) showHighlight(nodeEl, evt);
  } else if (evt.type === 'alert') {
    showSpeechBubble(nodeEl, evt, true);
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(255,80,60,0.6)' });
  } else if (evt.type === 'quest') {
    showSpeechBubble(nodeEl, evt);
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,144,255,0.5)' });
    _refreshQuestCards(); // Refresh structured quest view
  } else if (evt.type === 'oracle_query') {
    showSpeechBubble(nodeEl, { ...evt, text: '\u2728 ' + evt.text, color: '#c080ff' });
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,128,255,0.6)' });
  } else if (evt.type === 'oracle_response') {
    showSpeechBubble(nodeEl, { ...evt, color: evt.color || '#e0b0ff' });
    if (!isRestore) showHighlight(nodeEl, { color: 'rgba(192,128,255,0.4)' });
  }
}

// ── Quest Log (enhanced with tabs) ──
let logCount = 0;
const MAX_LOG = 80;
let activeTab = 'all';

// Quest cards container (injected before log body)
const _questCards = document.createElement('div');
_questCards.className = 'quest-cards';
_questCards.style.display = 'none';
const _logBodyEl = document.getElementById('quest-log-body');
if (_logBodyEl) _logBodyEl.parentNode.insertBefore(_questCards, _logBodyEl);

// Tab switching
document.querySelectorAll('.log-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.log-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    // Quest cards only visible on quest tab
    _questCards.style.display = activeTab === 'quest' ? '' : 'none';
    if (_logBodyEl) _logBodyEl.style.display = activeTab === 'quest' ? 'none' : '';
    document.querySelectorAll('.log-entry').forEach(entry => {
      if (activeTab === 'quest') {
        entry.style.display = 'none';
      } else if (activeTab === 'all') {
        entry.style.display = '';
      } else if (activeTab === 'notion') {
        entry.style.display = entry.classList.contains('notion-quest') ? '' : 'none';
      } else {
        entry.style.display = entry.classList.contains('log-' + activeTab) ? '' : 'none';
      }
    });
    // Show empty message if no entries visible for this tab
    if (_logBodyEl) {
      let emptyEl = _logBodyEl.querySelector('.panel-empty');
      if (!emptyEl) {
        emptyEl = document.createElement('div');
        emptyEl.className = 'panel-empty';
        emptyEl.textContent = 'No entries yet';
        _logBodyEl.appendChild(emptyEl);
      }
      const hasVisible = _logBodyEl.querySelector('.log-entry:not([style*="display: none"])');
      emptyEl.style.display = hasVisible ? 'none' : '';
    }
  });
});

// Codex header click-to-collapse removed — seal system handles panel hide/show

// Codex section toggles (click h4 to expand/collapse tool lists)
document.querySelectorAll('.codex-toggle').forEach(h4 => {
  h4.addEventListener('click', () => {
    const target = document.getElementById(h4.dataset.target);
    if (!target) return;
    h4.classList.toggle('open');
    target.classList.toggle('open');
  });
});

// Populate codex personas from /personas endpoint
fetch('/personas').then(r => r.json()).then(personas => {
  const el = document.querySelector('.codex-persona-list');
  if (!el) return;
  const icons = { katana:'\u2694', gatekeeper:'\u26E9', oracle:'\uD83D\uDD2E',
    forge:'\uD83D\uDD25', mana:'\uD83D\uDCA7', crystal:'\uD83D\uDC8E',
    'hp-switch':'\u2699', ha:'\uD83C\uDFE0', 'notion-portal':'\u2728', 'tab-s5e':'\uD83D\uDCF1' };
  el.innerHTML = Object.entries(personas).map(([k,p]) =>  // codex display — trusted server data
    `<div class="codex-persona"><span class="cp-icon">${icons[k]||'\u2B50'}</span><div>`+
    `<div class="cp-name">${p.name||k} &mdash; ${p.title||''}</div>`+
    `<div class="cp-voice">${(p.voice||'').replace('en-US-','').replace('Neural','')} &bull; ${(p.hints||[]).slice(0,2).join(', ')}</div>`+
    `</div></div>`
  ).join('');
}).catch(() => {});

// Populate codex Notion-backed sections (Lore, Architecture, Guide, Reference)
const _sectionIcons = { Lore:'\uD83D\uDCDC', Architecture:'\u2699\uFE0F', Guide:'\uD83D\uDCD6', Reference:'\uD83D\uDCCB' };
const _sectionColors = { Lore:'#b090d0', Architecture:'#70a0d0', Guide:'#70c080', Reference:'#a0a0a0' };
const _sectionOrder = ['Lore','Architecture','Guide','Reference'];
function renderCodexNotion(data) {
  const container = document.getElementById('codex-notion-sections');
  if (!container) return;
  let html = '';
  for (const sec of _sectionOrder) {
    const entries = data[sec];
    if (!entries || !entries.length) continue;
    const id = 'codex-notion-' + sec.toLowerCase();
    const color = _sectionColors[sec] || '#b0a080';
    html += `<div class="codex-section">`;
    html += `<h4 class="codex-toggle" data-target="${id}" style="color:${color}">${_sectionIcons[sec]||''} ${sec} <span class="codex-tool-count">${entries.length}</span></h4>`;
    html += `<div id="${id}" class="codex-tools">`;
    for (const e of entries) {
      html += `<div class="codex-notion-entry">`;
      if (e.url) {
        html += `<div class="cne-header"><a href="${e.url}" target="_blank" rel="noopener" class="cne-link">${e.icon||''} <span class="cne-name">${e.name}</span></a></div>`;
      } else {
        html += `<div class="cne-header">${e.icon||''} <span class="cne-name">${e.name}</span></div>`;
      }
      html += `<div class="cne-body">${e.body||''}</div>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;  // codex render — trusted server data
  // Re-bind toggles for new sections
  container.querySelectorAll('.codex-toggle').forEach(h4 => {
    h4.addEventListener('click', () => {
      const target = document.getElementById(h4.dataset.target);
      if (!target) return;
      h4.classList.toggle('open');
      target.classList.toggle('open');
    });
  });
}
// Defer Notion sync — not needed for initial render
setTimeout(() => fetch('/codex-sync').then(r => r.json()).then(renderCodexNotion).catch(() => {}), 5000);

// Quest log header click-to-collapse removed — seal system handles panel hide/show

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
        setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 3000);  // restore button label
        return;
      }
      _syncBtn.innerHTML = `\u2714 ${data.new || 0} new`;  // success count
      setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 2000);  // restore button label
    } catch (err) {
      _syncBtn.textContent = '\u26A0 Offline';
      setTimeout(() => { _syncBtn.innerHTML = '&#127744; Sync Portal'; _syncBtn.classList.remove('syncing'); }, 3000);  // restore button label
    }
  });
}

// ── Delegated event handlers on quest log body (avoids per-entry listeners) ──
if (_logBody) {
  // Click entry to navigate to node and open oracle chat
  _logBody.addEventListener('click', (e) => {
    // Dismiss button
    const dismissBtn = e.target.closest('.panel-close');
    if (dismissBtn) {
      e.stopPropagation();
      const entry = dismissBtn.closest('.log-entry');
      if (!entry) return;
      entry.classList.add('log-entry-dismiss');
      const evtText = entry.dataset.evtText;
      const evtType = entry.dataset.evtType;
      if (evtText) {
        for (const b of _activeBubbles) {
          if (b.querySelector('.bubble-text')?.textContent?.includes(evtText)) {
            _dismissBubble(b);
            break;
          }
        }
        if (!_dismissedQuests.has(evtText)) {
          _dismissedQuests.add(evtText);
          _saveDismissed();
        }
        if (evtType === 'quest') {
          fetch('/quest-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: evtText }) }).catch(() => {});
        }
      }
      entry.addEventListener('animationend', () => {
        entry.remove();
        if (evtType === 'quest' && evtText) _questTexts.delete(evtText);
        logCount = Math.max(0, logCount - 1);
        _logCounter.textContent = `${logCount} entries`;
        const emptyEl = _logBody.querySelector('.panel-empty');
        if (emptyEl) {
          const hasVisible = _logBody.querySelector('.log-entry:not([style*="display: none"])');
          emptyEl.style.display = hasVisible ? 'none' : '';
        }
      });
      return;
    }
    // Quest checkbox handled by per-entry listener (needs closure state)
    if (e.target.closest('.quest-check')) return;
    // Navigate to node on entry click
    const entry = e.target.closest('.log-entry');
    if (!entry) return;
    const nodeId = entry.dataset.nodeId;
    if (!nodeId) return;
    const tn = _nodeMap.get(nodeId);
    if (tn) panToNode(tn.x, tn.y);
    _openNodeChat(nodeId, entry.dataset.evtText, false);
  });
}

// Set-based quest dedup — avoids O(n) DOM iteration per addLogEntry call
const _questTexts = new Set();

export function addLogEntry(evt, nodeEl) {
  if (!_logBody) return;
  const body = _logBody, counter = _logCounter;

  // Skip dismissed entries
  if (evt.text && _dismissedQuests.has(evt.text)) return;

  // Prevent duplicate quest entries via Set lookup (O(1) vs DOM scan)
  if (evt.type === 'quest' && evt.text) {
    if (_questTexts.has(evt.text)) return;
    _questTexts.add(evt.text);
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

  const communeHint = evt.node ? '<span class="log-commune" title="Click to commune with this node">\u{1F52E}</span>' : '';
  // trusted server data — event text from realm server, not user input
  entry.innerHTML = `<button class="panel-close panel-close--danger" title="Dismiss">\u2715</button><div class="log-time">${timeStr}</div><div class="log-speaker">${name}${communeHint}</div>${textContent}`;
  // Store event data for delegated handlers (avoids per-entry listeners)
  entry.dataset.nodeId = evt.node || '';
  entry.dataset.evtText = evt.text || '';
  entry.dataset.evtType = evt.type || 'speech';

  // Quest checkbox toggle — persists completed state + Notion sync
  const check = entry.querySelector('.quest-check');
  if (check) {
    // Restore completed state
    if (evt.text && _completedQuests.has(evt.text)) {
      check.innerHTML = '\u2611';  // checkbox glyph
      entry.classList.add('quest-done');
    }
    check.addEventListener('click', async () => {
      const done = check.textContent === '\u2611';
      check.innerHTML = done ? (isNotion ? '&#127744;' : '\u2610') : '\u2611';  // checkbox toggle
      entry.classList.toggle('quest-done', !done);
      if (evt.text) {
        if (!done) _completedQuests.add(evt.text);
        else _completedQuests.delete(evt.text);
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
            check.innerHTML = '\u2705';  // checkmark
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

  // Hide empty state if this entry is visible
  if (entry.style.display !== 'none') {
    const emptyEl = body.querySelector('.panel-empty');
    if (emptyEl) emptyEl.style.display = 'none';
  }

  // Event rewards — only for SSE events with a DB id, not local/transient
  if (evt.id && !evt._local && !_rewardedEvents.has(evt.id)) {
    _rewardedEvents.add(evt.id);
    fetch('/player/reward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'event', id: String(evt.id) }),
    }).then(r => r.json()).then(res => {
      if (res.granted && res.reward) {
        _floatRewardText(entry, res.reward);
        window.updateDockHUD?.(res, true);
        if (res.level_up) _celebrateLevelUp(res.level);
      }
    }).catch(() => {});
  }

  while (body.children.length > MAX_LOG) {
    body.removeChild(body.lastChild);
  }
  counter.textContent = `${Math.min(logCount, MAX_LOG)} entries`;
}

// Persist dismissed/completed quests across refreshes (Sets for O(1) lookup)
const _dismissedQuests = new Set(JSON.parse(localStorage.getItem('realm-dismissed-quests') || '[]'));
const _completedQuests = new Set(JSON.parse(localStorage.getItem('realm-completed-quests') || '[]'));
function _saveDismissed() { localStorage.setItem('realm-dismissed-quests', JSON.stringify([..._dismissedQuests])); }
function _saveCompleted() { localStorage.setItem('realm-completed-quests', JSON.stringify([..._completedQuests])); }

// ── Player Reward System ──
const _rewardedEvents = new Set();

function _floatRewardText(anchor, reward) {
  const parts = [];
  if (reward.xp) parts.push(`+${reward.xp} XP`);
  if (reward.gold) parts.push(`+${reward.gold}g`);
  if (reward.gems) parts.push(`+${reward.gems} gem`);
  if (!parts.length) return;
  const el = document.createElement('div');
  el.className = 'reward-float';
  el.textContent = parts.join(' ');
  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top = rect.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function _celebrateLevelUp(level) {
  // Golden flash overlay
  const overlay = document.createElement('div');
  overlay.className = 'level-up-overlay';
  document.body.appendChild(overlay);
  // Rising level badge
  const badge = document.createElement('div');
  badge.className = 'level-up-badge';
  const circle = document.createElement('div');
  circle.className = 'lub-circle';
  circle.textContent = level;
  badge.appendChild(circle);
  const text = document.createElement('div');
  text.className = 'lub-text';
  text.textContent = 'LEVEL UP';
  badge.appendChild(text);
  document.body.appendChild(badge);
  // Pulse dock HUD level badge
  const dockLevel = document.querySelector('.hud-level');
  if (dockLevel) dockLevel.classList.add('hud-level-up');
  setTimeout(() => {
    overlay.remove();
    badge.remove();
    if (dockLevel) dockLevel.classList.remove('hud-level-up');
  }, 3000);
}

function _checkParentAutoReward(parentId) {
  setTimeout(() => {
    fetch('/quests').then(r => r.json()).then(quests => {
      const parent = quests.find(q => q.id === parentId);
      if (!parent || !parent.children?.length) return;
      const allDone = parent.children.every(c => c.status === 'completed');
      if (!allDone) return;
      fetch('/player/reward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'quest', id: parentId }),
      }).then(r => r.json()).then(res => {
        if (!res.granted) return;
        const card = document.querySelector(`.quest-card[data-quest-id="${parentId}"]`);
        if (card) _floatRewardText(card, res.reward);
        window.updateDockHUD?.(res, true);
        if (res.level_up) _celebrateLevelUp(res.level);
      }).catch(() => {});
    }).catch(() => {});
  }, 500);
}

// ── Quest Card System (structured quests with interactive actions) ──
const _ACTION_ICONS = {
  pan: '\uD83D\uDDFA\uFE0F', panel: '\uD83D\uDCCB', highlight: '\u2728',
  chat: '\uD83D\uDCAC', scan: '\uD83D\uDD0D', link: '\uD83D\uDD17',
};

function _executeQuestAction(action) {
  if (action.type === 'pan' && action.node) {
    const tn = _nodeMap.get(action.node);
    if (tn) { panToNode(tn.x, tn.y); showHighlight(getNodeDOM(tn.id), { color: 'rgba(192,144,255,0.6)' }); }
  } else if (action.type === 'panel' && action.panel) {
    const panelEl = document.getElementById(action.panel);
    if (panelEl) { unsealPanel(panelEl); panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  } else if (action.type === 'highlight' && action.nodes) {
    action.nodes.forEach(nid => {
      const tn = _nodeMap.get(nid);
      if (tn) showHighlight(getNodeDOM(nid), { color: action.color || 'rgba(192,144,255,0.5)' });
    });
  } else if (action.type === 'chat' && action.node) {
    const tn = _nodeMap.get(action.node);
    if (tn) panToNode(tn.x, tn.y);
    _openNodeChat(action.node, action.prompt || '', false);
  } else if (action.type === 'scan') {
    fetch(action.endpoint || '/scan').catch(() => {});
    addLogEntry({ type: 'system', node: 'katana', text: 'Initiating realm scan...', ts: Date.now()/1000 });
  }
}

function _renderQuestCards(quests) {
  _questCards.innerHTML = '';  // clear quest cards container
  if (!quests.length) {
    _questCards.innerHTML = '<div style="padding:16px;text-align:center;color:#706040;font-size:11px;font-style:italic">No active quests. The realm is at peace.</div>';  // empty state
    return;
  }
  quests.forEach(quest => {
    const card = document.createElement('div');
    const children = quest.children || [];
    const doneCount = children.filter(c => c.status === 'completed').length;
    const total = children.length;
    const allDone = total > 0 && doneCount === total;
    const isComplete = quest.status === 'completed' || allDone;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    card.className = 'quest-card' + (isComplete ? ' quest-card--done' : '');
    card.dataset.questId = quest.id;

    // Header (click to expand)
    const header = document.createElement('div');
    header.className = 'quest-card-header';
    header.innerHTML = `<span class="quest-card-icon">\u25B6</span>` +  // quest card header — trusted server data
      `<span class="quest-card-title">${quest.title}</span>` +
      (isComplete ? '<span class="quest-card-badge">\u2714 Complete</span>' : '') +
      (total > 0 && !isComplete ? `<span class="quest-card-progress">${doneCount}/${total}</span>` : '');
    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'quest-card-delete';
    delBtn.innerHTML = '\u2716';  // X glyph
    delBtn.title = 'Dismiss quest';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('quest-card--dismissing');
      setTimeout(() => {
        fetch('/quest-delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: quest.id }),
        }).then(() => _refreshQuestCards()).catch(() => {});
      }, 400);
    });
    header.appendChild(delBtn);
    header.addEventListener('click', (e) => {
      if (e.target.closest('.quest-card-delete')) return;
      card.classList.toggle('quest-card--open');
    });
    card.appendChild(header);

    // Progress bar
    if (total > 0) {
      const bar = document.createElement('div');
      bar.className = 'quest-card-bar';
      bar.innerHTML = `<div class="quest-card-bar-fill" style="width:${pct}%"></div>`;  // progress bar fill
      card.appendChild(bar);
    }

    // Description
    if (quest.description) {
      const desc = document.createElement('div');
      desc.className = 'quest-card-desc';
      desc.textContent = quest.description;
      card.appendChild(desc);
    }

    // Main quest actions
    if (quest.actions?.length) {
      const actionsRow = document.createElement('div');
      actionsRow.className = 'quest-actions';
      actionsRow.style.padding = '2px 10px 6px 34px';
      quest.actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = `quest-action quest-action--${action.type}`;
        btn.innerHTML = `${_ACTION_ICONS[action.type] || ''} ${action.label}`;  // action button — trusted server data
        btn.addEventListener('click', (e) => { e.stopPropagation(); _executeQuestAction(action); });
        actionsRow.appendChild(btn);
      });
      card.appendChild(actionsRow);
    }

    // Complete button for quests with no sub-quests
    if (total === 0 && quest.status !== 'completed') {
      const completeRow = document.createElement('div');
      completeRow.className = 'quest-complete-row';
      const completeBtn = document.createElement('button');
      completeBtn.className = 'quest-complete-btn';
      completeBtn.innerHTML = '<span class="qcb-rune">&#x16C7;</span> Claim Reward <span class="qcb-rune">&#x16C8;</span>';  // rune glyphs
      completeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (completeBtn.disabled) return;
        completeBtn.disabled = true;
        // Grant reward via server
        fetch('/player/reward', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'quest', id: quest.id }),
        }).then(r => r.json()).then(res => {
          _spawnQuestReward(card, completeBtn, res.granted ? res.reward : null);
          window.updateDockHUD?.(res, true);
          if (res.level_up) _celebrateLevelUp(res.level);
        }).catch(() => {
          _spawnQuestReward(card, completeBtn, null);
        });
        // Mark completed after animation peaks
        setTimeout(() => {
          fetch('/quest-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: quest.id, status: 'completed' }),
          }).then(() => _refreshQuestCards()).catch(() => {});
        }, 1800);
      });
      completeRow.appendChild(completeBtn);
      card.appendChild(completeRow);
    }

    // Collapsible body with sub-quests
    const body = document.createElement('div');
    body.className = 'quest-card-body';
    children.forEach(sub => {
      const subEl = document.createElement('div');
      const isDone = sub.status === 'completed';
      subEl.className = 'quest-sub' + (isDone ? ' quest-sub--done' : '');

      const check = document.createElement('span');
      check.className = 'quest-sub-check';
      check.innerHTML = isDone ? '\u2611' : '\u2610';  // checkbox glyph
      check.addEventListener('click', () => {
        const newStatus = isDone ? 'active' : 'completed';
        fetch('/quest-update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sub.id, status: newStatus }),
        }).then(() => _refreshQuestCards()).catch(() => {});
        // Grant reward only when toggling TO completed
        if (!isDone) {
          fetch('/player/reward', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'sub', id: sub.id }),
          }).then(r => r.json()).then(res => {
            if (res.granted) _floatRewardText(subEl, res.reward);
            window.updateDockHUD?.(res, true);
            if (res.level_up) _celebrateLevelUp(res.level);
          }).catch(() => {});
          _checkParentAutoReward(quest.id);
        }
        // Immediate visual feedback
        subEl.classList.toggle('quest-sub--done');
        subEl.classList.add('quest-sub--completing');
        check.innerHTML = isDone ? '\u2610' : '\u2611';  // checkbox toggle
      });

      const content = document.createElement('div');
      content.className = 'quest-sub-content';
      content.innerHTML = `<div class="quest-sub-title">${sub.title}</div>` +  // sub-quest — trusted server data
        (sub.node ? `<div class="quest-sub-node">\u2694 ${sub.node}</div>` : '');

      // Sub-quest actions
      if (sub.actions?.length) {
        const subActions = document.createElement('div');
        subActions.className = 'quest-actions';
        sub.actions.forEach(action => {
          const btn = document.createElement('button');
          btn.className = `quest-action quest-action--${action.type}`;
          btn.innerHTML = `${_ACTION_ICONS[action.type] || ''} ${action.label}`;  // action button — trusted server data
          btn.addEventListener('click', (e) => { e.stopPropagation(); _executeQuestAction(action); });
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

// ── Quest Reward Burst ──
const _REWARD_RUNES = ['\u16A0','\u16A2','\u16A6','\u16B1','\u16B7','\u16C1','\u16C7','\u16C8','\u16CF','\u16D6'];
const _REWARD_GEMS = ['\uD83D\uDC8E','\u2726','\u2B25','\u25C6','\uD83D\uDD2E','\u269C','\u2727','\u2605'];
function _spawnQuestReward(card, btn, reward) {
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // Add glow class to card
  card.classList.add('quest-card--rewarding');
  btn.classList.add('qcb--activated');
  // Spawn particles
  const container = document.createElement('div');
  container.className = 'quest-reward-burst';
  container.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;z-index:99999;pointer-events:none`;
  document.body.appendChild(container);
  // Ring of rune particles
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('span');
    p.className = 'qr-particle qr-rune';
    p.textContent = _REWARD_RUNES[i % _REWARD_RUNES.length];
    const angle = (i / 16) * Math.PI * 2;
    const dist = 60 + Math.random() * 50;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.animationDelay = `${i * 40}ms`;
    container.appendChild(p);
  }
  // Gem shower
  for (let i = 0; i < 10; i++) {
    const g = document.createElement('span');
    g.className = 'qr-particle qr-gem';
    g.textContent = _REWARD_GEMS[i % _REWARD_GEMS.length];
    g.style.setProperty('--dx', `${(Math.random() - 0.5) * 140}px`);
    g.style.setProperty('--dy', `${-40 - Math.random() * 80}px`);
    g.style.animationDelay = `${200 + i * 60}ms`;
    container.appendChild(g);
  }
  // XP banner
  const xp = document.createElement('div');
  xp.className = 'qr-xp';
  if (reward) {
    const parts = [`+${reward.xp} XP`];
    if (reward.gold) parts.push(`+${reward.gold}g`);
    if (reward.gems) parts.push(`+${reward.gems} gem`);
    xp.textContent = parts.join(' ');
  } else {
    xp.textContent = '+?? XP';
  }
  container.appendChild(xp);
  // Golden flash on the card
  const flash = document.createElement('div');
  flash.className = 'qr-flash';
  card.style.position = 'relative';
  card.appendChild(flash);
  // Cleanup
  setTimeout(() => {
    container.remove();
    flash.remove();
    card.classList.remove('quest-card--rewarding');
  }, 2400);
}

function _refreshQuestCards() {
  fetch('/quests').then(r => r.json()).then(quests => _renderQuestCards(quests)).catch(() => {});
}

// Load quest log from DB on startup
function _loadQuestLog() {
  // 1) Structured quest cards
  _refreshQuestCards();
  // 2) Recent events for the flat log (All/Speech/Reports tabs)
  fetch('/events?limit=50').then(r => r.json()).then(events => {
    events.filter(e => e.text && !_dismissedQuests.has(e.text)).forEach((e, i) => {
      setTimeout(() => addLogEntry(e), i * 50);
    });
  }).catch(() => {});
}
setTimeout(() => {
  addLogEntry({ type: 'system', node: 'katana', text: 'The Realm Map has been inscribed.', ts: Date.now()/1000 });
  _loadQuestLog();
  // Load player stats into dock HUD
  fetch('/player').then(r => r.json()).then(stats => {
    window.updateDockHUD?.(stats, false);
  }).catch(() => {});
}, 800);

// Track active speech bubbles for repositioning during drag
const _activeBubbles = new Set();

function _positionBubble(bubble) {
  let nodeEl = bubble._nodeEl;
  // Re-find node if reference is stale (happens after topology refresh)
  if (!nodeEl || !nodeEl.isConnected) {
    if (bubble._nodeId) {
      nodeEl = document.querySelector(`[data-tip="${bubble._nodeId}"]`);
      if (nodeEl) bubble._nodeEl = nodeEl;
    }
  }
  if (!nodeEl || !nodeEl.isConnected) return;
  const nodeLeft = parseInt(nodeEl.style.left) || 0;
  const nodeTop = parseInt(nodeEl.style.top) || 0;
  const icon = nodeEl.querySelector('.node-icon');
  const iconW = icon ? icon.offsetWidth : 64;
  bubble.style.left = (nodeLeft + iconW / 2 - bubble.offsetWidth / 2) + 'px';
  bubble.style.top = (nodeTop - bubble.offsetHeight - 12) + 'px';
}

export function updateBubblePositions() {
  _activeBubbles.forEach(b => {
    if (!b.isConnected) { _activeBubbles.delete(b); return; }
    _positionBubble(b);
  });
}

function _dismissBubble(bubble) {
  bubble.style.animation = 'bubbleOut 0.3s ease-in forwards';
  setTimeout(() => { bubble.remove(); _activeBubbles.delete(bubble); invalidateGlobeZCache(); }, 300);
}

export function showSpeechBubble(nodeEl, evt, isAlert) {
  // One bubble per node, period — latest event wins
  const dismissList = [];
  for (const b of _activeBubbles) {
    if (b._nodeId === evt.node) dismissList.push(b);
  }
  for (const b of dismissList) _dismissBubble(b);

  const bubble = document.createElement('div');
  const isQuest = evt.type === 'quest';
  const isNotion = evt._source === 'notion';
  let cls = 'speech-bubble';
  if (isAlert) cls += ' alert-bubble';
  if (isQuest) cls += ' quest-bubble';
  if (isNotion) cls += ' notion-bubble';
  bubble.className = cls;
  bubble._nodeEl = nodeEl;
  bubble._nodeId = evt.node;
  const name = nodeEl.querySelector('.node-label')?.textContent || evt.node;

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close';
  closeBtn.innerHTML = '\u00D7';  // multiplication sign (close)
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _dismissBubble(bubble);
  });

  const prefix = isNotion ? '<span style="color:#a080e0">&#127744;</span> ' : (isQuest ? '<span style="color:#c090ff">&#9733;</span> ' : '');
  bubble.innerHTML = `<div class="bubble-name">${name}</div><div class="bubble-text">${prefix}${evt.text || ''}</div>`;  // bubble — trusted event data
  bubble.appendChild(closeBtn);
  if (evt.color) bubble.style.borderColor = evt.color;

  // Click bubble to open chat with this node's context
  bubble.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    _openNodeChat(evt.node, evt.text);
  });
  bubble.style.cursor = 'pointer';

  const world = document.getElementById('map-world');
  world.appendChild(bubble);
  _positionBubble(bubble);
  _activeBubbles.add(bubble);
  invalidateGlobeZCache();
  // Respect visibility toggle
  if (window._visState && window._visState['.speech-bubble'] === false) bubble.style.visibility = 'hidden';
  // Float above globe surface when tilted
  if (_mapTilt > 0) {
    const bz = _mapTilt * 5 + _mapTilt * 3 + _mapTilt * 8 + _mapTilt * 3;
    bubble.style.translate = `0px 0px ${bz}px`;
    bubble.style.rotate = `x ${-_mapTilt}deg`;
  }

  // All bubbles stay until manually closed (no auto-dismiss)
}

export function showHighlight(nodeEl, evt) {
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

export function firePulse() {
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

export function showOffline() {
  if (_pulseCore) { _pulseCore.style.background = '#804040'; _pulseCore.style.boxShadow = 'none'; }
  if (_pulseLabel) { _pulseLabel.textContent = 'OFFLINE'; _pulseLabel.style.color = '#604040'; }
}

// Getter exports for private state
export const getActiveTab = () => activeTab;
export const getLastEventTs = () => lastEventTs;
