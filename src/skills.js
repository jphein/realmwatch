// ── Arcane Codex — Skills / CLAUDE.md / Hooks / Agents panel ────────────────
'use strict';

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'skills',   label: 'Skills',    icon: '\u2726' },  // ✦
  { id: 'claudemd', label: 'CLAUDE.md', icon: '\u270E' },  // ✎
  { id: 'hooks',    label: 'Hooks',     icon: '\u2693' },  // ⚓
  { id: 'agents',   label: 'Agents',    icon: '\u2694' },  // ⚔
];

let _activeTab = 'skills';

// ── Skills state ────────────────────────────────────────────────────────────
let _skills = [];
let _activeSkill = null;
let _skillEditing = false;

// ── CLAUDE.md state ─────────────────────────────────────────────────────────
let _claudeMd = '';
let _claudeMdEditing = false;

// ── Hooks state ─────────────────────────────────────────────────────────────
let _hooks = [];

// ── Agents state ────────────────────────────────────────────────────────────
let _agents = [];

// ─────────────────────────────────────────────────────────────────────────────
// FETCH
// ─────────────────────────────────────────────────────────────────────────────
async function _fetchSkills() {
  try {
    const r = await fetch('/skills');
    _skills = r.ok ? await r.json() : [];
  } catch { _skills = []; }
}

async function _fetchClaudeMd() {
  try {
    const r = await fetch('/claude-md');
    const d = r.ok ? await r.json() : {};
    _claudeMd = d.content || '';
  } catch { _claudeMd = ''; }
}

async function _fetchHooks() {
  try {
    const r = await fetch('/hooks');
    const d = r.ok ? await r.json() : {};
    _hooks = d.hooks || [];
  } catch { _hooks = []; }
}

async function _fetchAgents() {
  try {
    const r = await fetch('/agents');
    _agents = r.ok ? await r.json() : [];
  } catch { _agents = []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE
// ─────────────────────────────────────────────────────────────────────────────
async function _saveSkill(name, description, body) {
  try {
    const r = await fetch('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, body }),
    });
    if (!r.ok) throw new Error(r.statusText);
    _skillEditing = false;
    await _fetchSkills();
    _render();
  } catch (err) { console.error('Skills: save failed', err); }
}

async function _saveClaudeMd(content) {
  try {
    const r = await fetch('/claude-md', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(r.statusText);
    _claudeMdEditing = false;
    _claudeMd = content;
    _render();
  } catch (err) { console.error('CLAUDE.md: save failed', err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — TAB BAR
// ─────────────────────────────────────────────────────────────────────────────
function _renderTabs() {
  const bar = document.getElementById('skills-tab-bar');
  if (!bar) return;
  bar.textContent = '';

  TABS.forEach(tab => {
    const btn = document.createElement('button');
    btn.className = 'skills-tab' + (tab.id === _activeTab ? ' skills-tab--active' : '');
    btn.dataset.tab = tab.id;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'skills-tab-icon';
    iconSpan.textContent = tab.icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'skills-tab-label';
    labelSpan.textContent = tab.label;

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
    bar.appendChild(btn);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — SKILLS TAB
// ─────────────────────────────────────────────────────────────────────────────
function _renderSkillsTab(container) {
  // Split layout: list + detail
  const wrap = document.createElement('div');
  wrap.className = 'skills-split';

  // Left: skill list
  const list = document.createElement('div');
  list.className = 'skills-list';

  if (_skills.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'skills-empty';
    empty.textContent = 'No skills inscribed';
    list.appendChild(empty);
  } else {
    _skills.forEach(sk => {
      const item = document.createElement('div');
      item.className = 'skills-item' + (sk.name === _activeSkill ? ' skills-item--active' : '');
      item.dataset.skillName = sk.name;

      const icon = document.createElement('span');
      icon.className = 'skills-item-icon';
      icon.textContent = '\u2726';

      const info = document.createElement('div');
      info.className = 'skills-item-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'skills-item-name';
      nameEl.textContent = sk.name;

      const descEl = document.createElement('div');
      descEl.className = 'skills-item-desc';
      descEl.textContent = sk.description || '';

      info.appendChild(nameEl);
      info.appendChild(descEl);
      item.appendChild(icon);
      item.appendChild(info);
      list.appendChild(item);
    });
  }
  wrap.appendChild(list);

  // Right: detail
  const detail = document.createElement('div');
  detail.className = 'skills-detail';

  const sk = _skills.find(s => s.name === _activeSkill);
  if (!sk) {
    const hint = document.createElement('div');
    hint.className = 'skills-hint';
    hint.textContent = _skills.length ? 'Select a skill rune' : 'No skills in .claude/skills/';
    detail.appendChild(hint);
  } else if (_skillEditing) {
    _renderSkillEditor(detail, sk);
  } else {
    _renderSkillView(detail, sk);
  }

  wrap.appendChild(detail);
  container.appendChild(wrap);
}

function _renderSkillView(detail, sk) {
  const titleEl = document.createElement('div');
  titleEl.className = 'skills-detail-title';
  titleEl.textContent = sk.name;
  detail.appendChild(titleEl);

  const descEl = document.createElement('div');
  descEl.className = 'skills-detail-desc';
  descEl.textContent = sk.description || '';
  detail.appendChild(descEl);

  const pathEl = document.createElement('div');
  pathEl.className = 'skills-detail-path';
  pathEl.textContent = sk.path || '';
  detail.appendChild(pathEl);

  // Render markdown-ish body
  const bodyEl = document.createElement('div');
  bodyEl.className = 'skills-body';
  (sk.body || '').split('\n').forEach(line => {
    const el = document.createElement('div');
    if (line.startsWith('# ')) { el.className = 'skills-line-h1'; el.textContent = line.slice(2); }
    else if (line.startsWith('## ')) { el.className = 'skills-line-h2'; el.textContent = line.slice(3); }
    else if (line.startsWith('- ') || /^\d+\.\s/.test(line)) { el.className = 'skills-line-li'; el.textContent = line; }
    else if (line.startsWith('```')) { el.className = 'skills-line-code'; el.textContent = line; }
    else { el.className = 'skills-line'; el.textContent = line || '\u00A0'; }
    bodyEl.appendChild(el);
  });
  detail.appendChild(bodyEl);

  const editBtn = document.createElement('button');
  editBtn.className = 'skills-btn skills-btn--edit';
  editBtn.textContent = 'Engrave';
  editBtn.dataset.action = 'skill-edit';
  detail.appendChild(editBtn);
}

function _renderSkillEditor(detail, sk) {
  const titleEl = document.createElement('div');
  titleEl.className = 'skills-detail-title';
  titleEl.textContent = sk.name;
  detail.appendChild(titleEl);

  const descInput = document.createElement('input');
  descInput.className = 'skills-edit-desc';
  descInput.type = 'text';
  descInput.value = sk.description || '';
  descInput.placeholder = 'Description\u2026';
  detail.appendChild(descInput);

  const textarea = document.createElement('textarea');
  textarea.className = 'skills-edit-body';
  textarea.value = sk.body || '';
  textarea.spellcheck = false;
  detail.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'skills-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'skills-btn skills-btn--save';
  saveBtn.textContent = 'Inscribe';
  saveBtn.dataset.action = 'skill-save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'skills-btn skills-btn--cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.dataset.action = 'skill-cancel';

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  detail.appendChild(actions);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — CLAUDE.MD TAB
// ─────────────────────────────────────────────────────────────────────────────
function _renderClaudeMdTab(container) {
  if (_claudeMdEditing) {
    const textarea = document.createElement('textarea');
    textarea.className = 'claudemd-editor';
    textarea.value = _claudeMd;
    textarea.spellcheck = false;
    container.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'skills-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'skills-btn skills-btn--save';
    saveBtn.textContent = 'Inscribe';
    saveBtn.dataset.action = 'claudemd-save';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'skills-btn skills-btn--cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.dataset.action = 'claudemd-cancel';

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    container.appendChild(actions);
  } else {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'claudemd-body';
    (_claudeMd || 'No CLAUDE.md found').split('\n').forEach(line => {
      const el = document.createElement('div');
      if (line.startsWith('# ')) { el.className = 'skills-line-h1'; el.textContent = line.slice(2); }
      else if (line.startsWith('## ')) { el.className = 'skills-line-h2'; el.textContent = line.slice(3); }
      else if (line.startsWith('### ')) { el.className = 'skills-line-h3'; el.textContent = line.slice(4); }
      else if (line.startsWith('| ')) { el.className = 'skills-line-table'; el.textContent = line; }
      else if (line.startsWith('- ') || /^\d+\.\s/.test(line)) { el.className = 'skills-line-li'; el.textContent = line; }
      else if (line.startsWith('```')) { el.className = 'skills-line-code'; el.textContent = line; }
      else { el.className = 'skills-line'; el.textContent = line || '\u00A0'; }
      bodyEl.appendChild(el);
    });
    container.appendChild(bodyEl);

    const editBtn = document.createElement('button');
    editBtn.className = 'skills-btn skills-btn--edit';
    editBtn.textContent = 'Engrave';
    editBtn.dataset.action = 'claudemd-edit';
    container.appendChild(editBtn);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — HOOKS TAB
// ─────────────────────────────────────────────────────────────────────────────
function _renderHooksTab(container) {
  if (_hooks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'skills-empty';
    empty.textContent = 'No hooks configured';
    container.appendChild(empty);
    return;
  }

  const table = document.createElement('div');
  table.className = 'hooks-list';

  _hooks.forEach(hook => {
    const row = document.createElement('div');
    row.className = 'hooks-row';

    const eventEl = document.createElement('span');
    eventEl.className = 'hooks-event';
    eventEl.textContent = hook.event;

    const cmdEl = document.createElement('span');
    cmdEl.className = 'hooks-command';
    cmdEl.textContent = hook.command;

    const matchEl = document.createElement('span');
    matchEl.className = 'hooks-matcher';
    matchEl.textContent = hook.matcher || '*';

    row.appendChild(eventEl);
    row.appendChild(cmdEl);
    row.appendChild(matchEl);
    table.appendChild(row);
  });

  container.appendChild(table);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — AGENTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function _renderAgentsTab(container) {
  if (_agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'skills-empty';
    empty.textContent = 'No custom agents defined';
    container.appendChild(empty);
    return;
  }

  _agents.forEach(agent => {
    const card = document.createElement('div');
    card.className = 'agent-card';

    const nameEl = document.createElement('div');
    nameEl.className = 'agent-name';
    nameEl.textContent = agent.name;

    const descEl = document.createElement('div');
    descEl.className = 'agent-desc';
    descEl.textContent = agent.description || '';

    const pathEl = document.createElement('div');
    pathEl.className = 'agent-path';
    pathEl.textContent = agent.path || '';

    card.appendChild(nameEl);
    card.appendChild(descEl);
    card.appendChild(pathEl);

    // Show body preview
    if (agent.body) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'agent-body-preview';
      const preview = agent.body.length > 300 ? agent.body.slice(0, 300) + '\u2026' : agent.body;
      bodyEl.textContent = preview;
      card.appendChild(bodyEl);
    }

    container.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN RENDER
// ─────────────────────────────────────────────────────────────────────────────
function _render() {
  _renderTabs();

  const content = document.getElementById('skills-content');
  if (!content) return;
  content.textContent = '';

  switch (_activeTab) {
    case 'skills':   _renderSkillsTab(content); break;
    case 'claudemd': _renderClaudeMdTab(content); break;
    case 'hooks':    _renderHooksTab(content); break;
    case 'agents':   _renderAgentsTab(content); break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT DELEGATION
// ─────────────────────────────────────────────────────────────────────────────
function _handleClick(e) {
  // Tab switch
  const tabBtn = e.target.closest('.skills-tab');
  if (tabBtn && tabBtn.dataset.tab) {
    _activeTab = tabBtn.dataset.tab;
    _skillEditing = false;
    _claudeMdEditing = false;
    _render();
    return;
  }

  // Skill list item
  const skillItem = e.target.closest('.skills-item');
  if (skillItem) {
    _activeSkill = skillItem.dataset.skillName;
    _skillEditing = false;
    _render();
    return;
  }

  const action = e.target.dataset?.action;
  if (!action) return;

  // Skills actions
  if (action === 'skill-edit') { _skillEditing = true; _render(); }
  else if (action === 'skill-cancel') { _skillEditing = false; _render(); }
  else if (action === 'skill-save') {
    const panel = document.getElementById('skills-panel');
    const descInput = panel?.querySelector('.skills-edit-desc');
    const textarea = panel?.querySelector('.skills-edit-body');
    if (descInput && textarea && _activeSkill) {
      _saveSkill(_activeSkill, descInput.value, textarea.value);
    }
  }

  // CLAUDE.md actions
  else if (action === 'claudemd-edit') { _claudeMdEditing = true; _render(); }
  else if (action === 'claudemd-cancel') { _claudeMdEditing = false; _render(); }
  else if (action === 'claudemd-save') {
    const textarea = document.querySelector('.claudemd-editor');
    if (textarea) _saveClaudeMd(textarea.value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export function initSkills() {
  const panel = document.getElementById('skills-panel');
  if (!panel) return;

  panel.addEventListener('click', _handleClick);

  // Fetch all data in parallel
  Promise.all([_fetchSkills(), _fetchClaudeMd(), _fetchHooks(), _fetchAgents()])
    .then(() => _render());
}
