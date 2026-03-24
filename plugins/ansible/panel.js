// Ansible War Room — Panel JS
// Uses window.RealmAPI (NOT esbuild imports)
// Security model: full trust (local-only project, all data from local topology)
(function() {
  'use strict';

  var API = window.RealmAPI;
  if (!API) { console.error('RealmAPI not available for ansible plugin'); return; }

  // Set current plugin for scoped fetch
  var prevPlugin = API._currentPlugin;
  API._currentPlugin = 'ansible';

  // ── State ──
  var inventory = {};
  var selectedNodes = new Set();
  var playbooks = [];
  var currentRunId = null;

  // ── DOM refs ──
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  // ── Safe DOM builders ──
  function el(tag, className, textContent) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (textContent) e.textContent = textContent;
    return e;
  }

  // ── Tab Switching ──
  function initTabs() {
    var bar = $('.ansible-tab-bar');
    if (!bar) return;
    bar.addEventListener('click', function(e) {
      var btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      var tab = btn.dataset.tab;

      bar.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');

      $$('.ansible-tab').forEach(function(t) { t.classList.remove('active'); });
      var target = $('[data-tab-content="' + tab + '"]');
      if (target) target.classList.add('active');
    });
  }

  // ── Inventory ──
  function loadInventory() {
    var container = $('#ansible-inventory');
    if (!container) return;
    container.textContent = '';
    container.appendChild(el('div', 'ansible-loading', 'Summoning inventory...'));

    API.fetch('/inventory').then(function(r) { return r.json(); }).then(function(data) {
      inventory = data.inventory || {};
      renderInventory();
    }).catch(function() {
      container.textContent = '';
      container.appendChild(el('div', 'ansible-error', 'Failed to summon inventory'));
    });
  }

  function renderInventory() {
    var container = $('#ansible-inventory');
    if (!container) return;
    container.textContent = '';

    var groups = Object.keys(inventory).sort();
    if (groups.length === 0) {
      container.appendChild(el('div', 'ansible-empty', 'No nodes discovered'));
      return;
    }

    groups.forEach(function(group) {
      var nodes = inventory[group];
      var reachable = nodes.filter(function(n) { return n.reachable; });
      if (reachable.length === 0) return;

      var groupEl = el('div', 'ansible-inv-group');

      var header = el('div', 'ansible-inv-group-header');
      header.appendChild(el('span', 'ansible-inv-group-name', group));
      header.appendChild(el('span', 'ansible-inv-group-count', String(reachable.length)));

      var toggleBtn = el('button', 'ansible-btn ansible-btn--xs ansible-group-toggle', 'All');
      toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var allSelected = reachable.every(function(n) { return selectedNodes.has(n.id); });
        reachable.forEach(function(n) {
          if (allSelected) selectedNodes.delete(n.id);
          else selectedNodes.add(n.id);
        });
        renderInventory();
        updateSelectedCount();
      });
      header.appendChild(toggleBtn);
      groupEl.appendChild(header);

      reachable.forEach(function(node) {
        var row = el('label', 'ansible-inv-node' + (selectedNodes.has(node.id) ? ' selected' : ''));

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedNodes.has(node.id);
        cb.addEventListener('change', function() {
          if (cb.checked) selectedNodes.add(node.id);
          else selectedNodes.delete(node.id);
          row.classList.toggle('selected', cb.checked);
          updateSelectedCount();
        });

        row.appendChild(cb);
        row.appendChild(el('span', 'ansible-node-label', node.label));
        row.appendChild(el('span', 'ansible-node-ip', node.ip || '\u2014'));
        if (node.os !== 'unknown') {
          row.appendChild(el('span', 'ansible-os-tag ansible-os-' + node.os, node.os));
        }
        groupEl.appendChild(row);
      });

      container.appendChild(groupEl);
    });
  }

  function updateSelectedCount() {
    var countEl = $('.ansible-selected-count');
    if (countEl) countEl.textContent = selectedNodes.size + ' selected';
  }

  // ── Playbooks ──
  function loadPlaybooks() {
    var container = $('#ansible-playbooks');
    if (!container) return;
    container.textContent = '';
    container.appendChild(el('div', 'ansible-loading', 'Gathering playbooks...'));

    API.fetch('/playbooks').then(function(r) { return r.json(); }).then(function(data) {
      playbooks = data.playbooks || [];
      renderPlaybooks();
    }).catch(function() {
      container.textContent = '';
      container.appendChild(el('div', 'ansible-error', 'Failed to load playbooks'));
    });
  }

  function renderPlaybooks() {
    var container = $('#ansible-playbooks');
    if (!container) return;
    container.textContent = '';

    if (playbooks.length === 0) {
      container.appendChild(el('div', 'ansible-empty', 'No playbooks found in the armory'));
      return;
    }

    playbooks.forEach(function(pb) {
      var card = el('div', 'ansible-pb-card');

      var header = el('div', 'ansible-pb-header');
      header.appendChild(el('span', 'ansible-pb-name', pb.name));
      header.appendChild(el('span', 'ansible-pb-file', pb.filename));
      card.appendChild(header);

      if (pb.description) {
        card.appendChild(el('div', 'ansible-pb-desc', pb.description));
      }

      var actions = el('div', 'ansible-pb-actions');

      var viewBtn = el('button', 'ansible-btn ansible-btn--sm ansible-btn--ghost', 'View');
      viewBtn.addEventListener('click', function() { togglePlaybookView(card, pb); });

      var runBtn = el('button', 'ansible-btn ansible-btn--sm ansible-btn--run', 'Execute');
      runBtn.addEventListener('click', function() { executePlaybook(pb.filename); });

      actions.appendChild(viewBtn);
      actions.appendChild(runBtn);
      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  function togglePlaybookView(card, pb) {
    var existing = card.querySelector('.ansible-pb-viewer');
    if (existing) { existing.remove(); return; }

    var viewer = el('div', 'ansible-pb-viewer');
    var pre = el('pre', 'ansible-pb-content', pb.content || '# Empty playbook');
    viewer.appendChild(pre);
    card.appendChild(viewer);
  }

  function executePlaybook(filename) {
    if (selectedNodes.size === 0) {
      API.showToast('Select target nodes in the Inventory tab first', 'warning');
      return;
    }

    var checkMode = true;
    var cb = $('#ansible-check-mode');
    if (cb) checkMode = cb.checked;

    var targets = Array.from(selectedNodes);

    // Show run output
    var outputArea = $('#ansible-run-output');
    var outputPre = $('#ansible-output-pre');
    var statusEl = $('#ansible-run-status');
    var labelEl = $('#ansible-run-label');

    if (outputArea) outputArea.style.display = 'block';
    if (outputPre) outputPre.textContent = '';
    if (statusEl) {
      statusEl.textContent = 'Deploying...';
      statusEl.className = 'ansible-run-status running';
    }
    if (labelEl) labelEl.textContent = filename + (checkMode ? ' (dry run)' : ' (LIVE)');

    API.fetch('/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playbook: filename, targets: targets, check_mode: checkMode }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) {
        if (outputPre) outputPre.textContent = 'ERROR: ' + data.error;
        if (statusEl) { statusEl.textContent = 'Failed'; statusEl.className = 'ansible-run-status failed'; }
        return;
      }
      currentRunId = data.run_id;
      if (outputPre) outputPre.textContent = 'Run ' + data.run_id + ' started...\n';
      API.showToast('Playbook execution started: ' + filename, 'info');
    }).catch(function(err) {
      if (outputPre) outputPre.textContent = 'Request failed: ' + err;
      if (statusEl) { statusEl.textContent = 'Error'; statusEl.className = 'ansible-run-status failed'; }
    });
  }

  // ── SSE: Live run output ──
  function handleAnsibleSSE(data) {
    if (!data || !data.active_runs) return;
    var outputPre = $('#ansible-output-pre');
    var statusEl = $('#ansible-run-status');

    if (currentRunId && data.active_runs[currentRunId]) {
      var run = data.active_runs[currentRunId];
      if (outputPre && run.output_lines) {
        outputPre.textContent = run.output_lines.join('\n');
        outputPre.scrollTop = outputPre.scrollHeight;
      }
      if (statusEl) {
        statusEl.textContent = run.status === 'running' ? 'Executing...' : run.status;
        statusEl.className = 'ansible-run-status ' + run.status;
      }

      if (run.status === 'success' || run.status === 'failed') {
        currentRunId = null;
        loadRunHistory();
      }
    }
  }

  // ── Run History ──
  function loadRunHistory() {
    var container = $('#ansible-history-list');
    if (!container) return;

    API.fetch('/runs?limit=10').then(function(r) { return r.json(); }).then(function(data) {
      var runs = data.runs || [];
      container.textContent = '';

      if (runs.length === 0) {
        container.appendChild(el('div', 'ansible-empty', 'No battles recorded'));
        return;
      }

      runs.forEach(function(run) {
        var row = el('div', 'ansible-history-row');
        var statusClass = run.status === 'success' ? 'success' : (run.status === 'failed' ? 'failed' : 'pending');

        row.appendChild(el('span', 'ansible-history-status ' + statusClass, run.status));
        row.appendChild(el('span', 'ansible-history-pb', run.playbook));

        var tag = el('span', 'ansible-tag');
        if (run.check_mode) { tag.className += ' ansible-tag--check'; tag.textContent = 'dry run'; }
        else { tag.className += ' ansible-tag--live'; tag.textContent = 'LIVE'; }
        row.appendChild(tag);

        var timeStr = run.started_at ? new Date(run.started_at * 1000).toLocaleString() : '\u2014';
        row.appendChild(el('span', 'ansible-history-time', timeStr));
        container.appendChild(row);
      });
    }).catch(function() { /* silent */ });
  }

  // ── AI Assist ──
  function initAI() {
    var sendBtn = $('#ansible-ai-send');
    var input = $('#ansible-ai-input');

    if (sendBtn) sendBtn.addEventListener('click', sendAIMessage);
    if (input) input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
    });
  }

  function sendAIMessage() {
    var input = $('#ansible-ai-input');
    if (!input) return;
    var message = input.value.trim();
    if (!message) return;
    input.value = '';

    appendAIMessage('user', message);

    var messagesEl = $('#ansible-ai-messages');
    var thinking = el('div', 'ansible-ai-msg ansible-ai-thinking', 'The War Sage contemplates...');
    if (messagesEl) messagesEl.appendChild(thinking);

    API.fetch('/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      thinking.remove();
      if (data.error) appendAIMessage('error', 'The sage is silent: ' + data.error);
      else appendAIMessage('assistant', data.response || 'No response');
    }).catch(function(err) {
      thinking.remove();
      appendAIMessage('error', 'Communication failed: ' + err);
    });
  }

  function appendAIMessage(role, text) {
    var messagesEl = $('#ansible-ai-messages');
    if (!messagesEl) return;

    // Remove welcome message on first interaction
    var welcome = messagesEl.querySelector('.ansible-ai-welcome');
    if (welcome) welcome.remove();

    var msg = el('div', 'ansible-ai-msg ansible-ai-' + role);
    var label = role === 'user' ? 'Commander' : (role === 'assistant' ? 'War Sage' : 'Error');
    msg.appendChild(el('span', 'ansible-ai-role', label));
    msg.appendChild(el('span', 'ansible-ai-text', text));
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ── Init ──
  function init() {
    initTabs();
    loadInventory();
    loadPlaybooks();
    loadRunHistory();
    initAI();

    // Toolbar buttons
    var refreshInv = $('#ansible-refresh-inv');
    if (refreshInv) refreshInv.addEventListener('click', loadInventory);

    var refreshPb = $('#ansible-refresh-pb');
    if (refreshPb) refreshPb.addEventListener('click', loadPlaybooks);

    var selectAll = $('#ansible-select-all');
    if (selectAll) selectAll.addEventListener('click', function() {
      Object.values(inventory).forEach(function(nodes) {
        nodes.forEach(function(n) { if (n.reachable) selectedNodes.add(n.id); });
      });
      renderInventory();
      updateSelectedCount();
    });

    var selectNone = $('#ansible-select-none');
    if (selectNone) selectNone.addEventListener('click', function() {
      selectedNodes.clear();
      renderInventory();
      updateSelectedCount();
    });

    // Subscribe to ansible SSE events
    API.onSSE('ansible', handleAnsibleSSE);
  }

  // Panel HTML may not be in DOM yet — wait for it
  if (document.querySelector('.ansible-tab-bar')) {
    init();
  } else {
    var observer = new MutationObserver(function(mutations, obs) {
      if (document.querySelector('.ansible-tab-bar')) {
        obs.disconnect();
        init();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function() { observer.disconnect(); init(); }, 3000);
  }

  // Restore plugin context
  API._currentPlugin = prevPlugin;
})();
