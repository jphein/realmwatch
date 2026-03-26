'use strict';
// ── Inscription Codex Plugin — Skills / CLAUDE.md / Hooks / Agents ──
// Standalone script — no ES module imports. Uses window.RealmAPI.

(function() {
  var API = window.RealmAPI;
  if (!API) { console.error('skills plugin: RealmAPI not available'); return; }

  // ── Tabs ──
  var TABS = [
    { id: 'skills',   label: 'Skills',    icon: '\u2726' },
    { id: 'claudemd', label: 'CLAUDE.md', icon: '\u270E' },
    { id: 'hooks',    label: 'Hooks',     icon: '\u2693' },
    { id: 'agents',   label: 'Agents',    icon: '\u2694' },
  ];

  var _activeTab = 'skills';

  // ── Skills state ──
  var _skills = [];
  var _activeSkill = null;
  var _skillEditing = false;

  // ── CLAUDE.md state ──
  var _claudeMd = '';
  var _claudeMdEditing = false;

  // ── Hooks state ──
  var _hooks = [];

  // ── Agents state ──
  var _agents = [];

  // ── Set panel accent color ──
  var panel = document.getElementById('skills-panel');
  if (panel) {
    panel.style.setProperty('--panel-accent', 'rgba(160,140,220,0.5)');
  }

  // ── FETCH ──
  function _fetchSkills() {
    return fetch('/skills').then(function(r) {
      return r.ok ? r.json() : [];
    }).then(function(d) { _skills = d; }).catch(function() { _skills = []; });
  }

  function _fetchClaudeMd() {
    return fetch('/claude-md').then(function(r) {
      return r.ok ? r.json() : {};
    }).then(function(d) { _claudeMd = d.content || ''; }).catch(function() { _claudeMd = ''; });
  }

  function _fetchHooks() {
    return fetch('/hooks').then(function(r) {
      return r.ok ? r.json() : {};
    }).then(function(d) { _hooks = d.hooks || []; }).catch(function() { _hooks = []; });
  }

  function _fetchAgents() {
    return fetch('/agents').then(function(r) {
      return r.ok ? r.json() : [];
    }).then(function(d) { _agents = d; }).catch(function() { _agents = []; });
  }

  // ── SAVE ──
  function _saveSkill(name, description, body) {
    fetch('/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, description: description, body: body }),
    }).then(function(r) {
      if (!r.ok) throw new Error(r.statusText);
      _skillEditing = false;
      return _fetchSkills();
    }).then(function() { _render(); })
      .catch(function(err) { console.error('Skills: save failed', err); });
  }

  function _saveClaudeMd(content) {
    fetch('/claude-md', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content }),
    }).then(function(r) {
      if (!r.ok) throw new Error(r.statusText);
      _claudeMdEditing = false;
      _claudeMd = content;
      _render();
    }).catch(function(err) { console.error('CLAUDE.md: save failed', err); });
  }

  // ── RENDER — TAB BAR ──
  function _renderTabs() {
    var bar = document.getElementById('skills-tab-bar');
    if (!bar) return;
    bar.textContent = '';

    TABS.forEach(function(tab) {
      var btn = document.createElement('button');
      btn.className = 'skills-tab' + (tab.id === _activeTab ? ' skills-tab--active' : '');
      btn.dataset.tab = tab.id;

      var iconSpan = document.createElement('span');
      iconSpan.className = 'skills-tab-icon';
      iconSpan.textContent = tab.icon;

      var labelSpan = document.createElement('span');
      labelSpan.className = 'skills-tab-label';
      labelSpan.textContent = tab.label;

      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);
      bar.appendChild(btn);
    });
  }

  // ── RENDER — SKILLS TAB ──
  function _renderSkillsTab(container) {
    var wrap = document.createElement('div');
    wrap.className = 'skills-split';

    var list = document.createElement('div');
    list.className = 'skills-list';

    if (_skills.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'None found';
      list.appendChild(empty);
    } else {
      _skills.forEach(function(sk) {
        var item = document.createElement('div');
        item.className = 'skills-item' + (sk.name === _activeSkill ? ' skills-item--active' : '');
        item.dataset.skillName = sk.name;

        var icon = document.createElement('span');
        icon.className = 'skills-item-icon';
        icon.textContent = '\u2726';

        var info = document.createElement('div');
        info.className = 'skills-item-info';

        var nameEl = document.createElement('div');
        nameEl.className = 'skills-item-name';
        nameEl.textContent = sk.name;

        var descEl = document.createElement('div');
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

    var detail = document.createElement('div');
    detail.className = 'skills-detail';

    var sk = null;
    for (var i = 0; i < _skills.length; i++) {
      if (_skills[i].name === _activeSkill) { sk = _skills[i]; break; }
    }
    if (!sk) {
      var hint = document.createElement('div');
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
    var titleEl = document.createElement('div');
    titleEl.className = 'skills-detail-title';
    titleEl.textContent = sk.name;
    detail.appendChild(titleEl);

    var descEl = document.createElement('div');
    descEl.className = 'skills-detail-desc';
    descEl.textContent = sk.description || '';
    detail.appendChild(descEl);

    var pathEl = document.createElement('div');
    pathEl.className = 'skills-detail-path';
    pathEl.textContent = sk.path || '';
    detail.appendChild(pathEl);

    var bodyEl = document.createElement('div');
    bodyEl.className = 'skills-body';
    (sk.body || '').split('\n').forEach(function(line) {
      var el = document.createElement('div');
      if (line.indexOf('# ') === 0) { el.className = 'skills-line-h1'; el.textContent = line.slice(2); }
      else if (line.indexOf('## ') === 0) { el.className = 'skills-line-h2'; el.textContent = line.slice(3); }
      else if (line.indexOf('- ') === 0 || /^\d+\.\s/.test(line)) { el.className = 'skills-line-li'; el.textContent = line; }
      else if (line.indexOf('```') === 0) { el.className = 'skills-line-code'; el.textContent = line; }
      else { el.className = 'skills-line'; el.textContent = line || '\u00A0'; }
      bodyEl.appendChild(el);
    });
    detail.appendChild(bodyEl);

    var editBtn = document.createElement('button');
    editBtn.className = 'skills-btn skills-btn--edit';
    editBtn.textContent = 'Engrave';
    editBtn.dataset.action = 'skill-edit';
    detail.appendChild(editBtn);
  }

  function _renderSkillEditor(detail, sk) {
    var titleEl = document.createElement('div');
    titleEl.className = 'skills-detail-title';
    titleEl.textContent = sk.name;
    detail.appendChild(titleEl);

    var descInput = document.createElement('input');
    descInput.className = 'skills-edit-desc';
    descInput.type = 'text';
    descInput.value = sk.description || '';
    descInput.placeholder = 'Description\u2026';
    detail.appendChild(descInput);

    var textarea = document.createElement('textarea');
    textarea.className = 'skills-edit-body';
    textarea.value = sk.body || '';
    textarea.spellcheck = false;
    detail.appendChild(textarea);

    var actions = document.createElement('div');
    actions.className = 'skills-actions';

    var saveBtn = document.createElement('button');
    saveBtn.className = 'skills-btn skills-btn--save';
    saveBtn.textContent = 'Inscribe';
    saveBtn.dataset.action = 'skill-save';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'skills-btn skills-btn--cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.dataset.action = 'skill-cancel';

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    detail.appendChild(actions);
  }

  // ── RENDER — CLAUDE.MD TAB ──
  function _renderClaudeMdTab(container) {
    if (_claudeMdEditing) {
      var textarea = document.createElement('textarea');
      textarea.className = 'claudemd-editor';
      textarea.value = _claudeMd;
      textarea.spellcheck = false;
      container.appendChild(textarea);

      var actions = document.createElement('div');
      actions.className = 'skills-actions';

      var saveBtn = document.createElement('button');
      saveBtn.className = 'skills-btn skills-btn--save';
      saveBtn.textContent = 'Inscribe';
      saveBtn.dataset.action = 'claudemd-save';

      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'skills-btn skills-btn--cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.dataset.action = 'claudemd-cancel';

      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      container.appendChild(actions);
    } else if (!_claudeMd) {
      var empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'No CLAUDE.md found';
      container.appendChild(empty);
    } else {
      var bodyEl = document.createElement('div');
      bodyEl.className = 'claudemd-body';
      _claudeMd.split('\n').forEach(function(line) {
        var el = document.createElement('div');
        if (line.indexOf('# ') === 0) { el.className = 'skills-line-h1'; el.textContent = line.slice(2); }
        else if (line.indexOf('## ') === 0) { el.className = 'skills-line-h2'; el.textContent = line.slice(3); }
        else if (line.indexOf('### ') === 0) { el.className = 'skills-line-h3'; el.textContent = line.slice(4); }
        else if (line.indexOf('| ') === 0) { el.className = 'skills-line-table'; el.textContent = line; }
        else if (line.indexOf('- ') === 0 || /^\d+\.\s/.test(line)) { el.className = 'skills-line-li'; el.textContent = line; }
        else if (line.indexOf('```') === 0) { el.className = 'skills-line-code'; el.textContent = line; }
        else { el.className = 'skills-line'; el.textContent = line || '\u00A0'; }
        bodyEl.appendChild(el);
      });
      container.appendChild(bodyEl);

      var editBtn = document.createElement('button');
      editBtn.className = 'skills-btn skills-btn--edit';
      editBtn.textContent = 'Engrave';
      editBtn.dataset.action = 'claudemd-edit';
      container.appendChild(editBtn);
    }
  }

  // ── RENDER — HOOKS TAB ──
  function _renderHooksTab(container) {
    if (_hooks.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'None found';
      container.appendChild(empty);
      return;
    }

    var table = document.createElement('div');
    table.className = 'hooks-list';

    _hooks.forEach(function(hook) {
      var row = document.createElement('div');
      row.className = 'hooks-row';

      var eventEl = document.createElement('span');
      eventEl.className = 'hooks-event';
      eventEl.textContent = hook.event;

      var cmdEl = document.createElement('span');
      cmdEl.className = 'hooks-command';
      cmdEl.textContent = hook.command;

      var matchEl = document.createElement('span');
      matchEl.className = 'hooks-matcher';
      matchEl.textContent = hook.matcher || '*';

      row.appendChild(eventEl);
      row.appendChild(cmdEl);
      row.appendChild(matchEl);
      table.appendChild(row);
    });

    container.appendChild(table);
  }

  // ── RENDER — AGENTS TAB ──
  function _renderAgentsTab(container) {
    if (_agents.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'None found';
      container.appendChild(empty);
      return;
    }

    _agents.forEach(function(agent) {
      var card = document.createElement('div');
      card.className = 'agent-card';

      var nameEl = document.createElement('div');
      nameEl.className = 'agent-name';
      nameEl.textContent = agent.name;

      var descEl = document.createElement('div');
      descEl.className = 'agent-desc';
      descEl.textContent = agent.description || '';

      var pathEl = document.createElement('div');
      pathEl.className = 'agent-path';
      pathEl.textContent = agent.path || '';

      card.appendChild(nameEl);
      card.appendChild(descEl);
      card.appendChild(pathEl);

      if (agent.body) {
        var bodyEl = document.createElement('div');
        bodyEl.className = 'agent-body-preview';
        var preview = agent.body.length > 300 ? agent.body.slice(0, 300) + '\u2026' : agent.body;
        bodyEl.textContent = preview;
        card.appendChild(bodyEl);
      }

      container.appendChild(card);
    });
  }

  // ── MAIN RENDER ──
  function _render() {
    _renderTabs();

    var content = document.getElementById('skills-content');
    if (!content) return;
    content.textContent = '';

    switch (_activeTab) {
      case 'skills':   _renderSkillsTab(content); break;
      case 'claudemd': _renderClaudeMdTab(content); break;
      case 'hooks':    _renderHooksTab(content); break;
      case 'agents':   _renderAgentsTab(content); break;
    }
  }

  // ── EVENT DELEGATION ──
  function _handleClick(e) {
    var tabBtn = e.target.closest('.skills-tab');
    if (tabBtn && tabBtn.dataset.tab) {
      _activeTab = tabBtn.dataset.tab;
      _skillEditing = false;
      _claudeMdEditing = false;
      _render();
      return;
    }

    var skillItem = e.target.closest('.skills-item');
    if (skillItem) {
      _activeSkill = skillItem.dataset.skillName;
      _skillEditing = false;
      _render();
      return;
    }

    var action = e.target.dataset ? e.target.dataset.action : null;
    if (!action) return;

    if (action === 'skill-edit') { _skillEditing = true; _render(); }
    else if (action === 'skill-cancel') { _skillEditing = false; _render(); }
    else if (action === 'skill-save') {
      var panelEl = document.getElementById('skills-panel');
      var descInput = panelEl ? panelEl.querySelector('.skills-edit-desc') : null;
      var textarea = panelEl ? panelEl.querySelector('.skills-edit-body') : null;
      if (descInput && textarea && _activeSkill) {
        _saveSkill(_activeSkill, descInput.value, textarea.value);
      }
    }
    else if (action === 'claudemd-edit') { _claudeMdEditing = true; _render(); }
    else if (action === 'claudemd-cancel') { _claudeMdEditing = false; _render(); }
    else if (action === 'claudemd-save') {
      var ta = document.querySelector('.claudemd-editor');
      if (ta) _saveClaudeMd(ta.value);
    }
  }

  // ── INIT ──
  var panelEl = document.getElementById('skills-panel');
  if (!panelEl) return;

  panelEl.addEventListener('click', _handleClick);

  Promise.all([_fetchSkills(), _fetchClaudeMd(), _fetchHooks(), _fetchAgents()])
    .then(function() { _render(); });
})();
