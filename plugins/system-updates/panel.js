'use strict';
(function () {
  var API = window.RealmAPI;
  if (!API) { console.error('system-updates: RealmAPI not available'); return; }

  // ── State ───────────────────────────────────────────────────────

  var _state = null;
  var _expanded = {};  // source_id -> bool

  // ── DOM refs ────────────────────────────────────────────────────

  var body = document.getElementById('updates-body');
  var wardedBadge = document.getElementById('updates-warded');
  var pendingBadge = document.getElementById('updates-pending');
  var failedBadge = document.getElementById('updates-failed');
  var checkAllBtn = document.getElementById('updates-check-all');
  var runAllBtn = document.getElementById('updates-run-all');

  // ── Helpers ─────────────────────────────────────────────────────

  function relativeTime(ts) {
    if (!ts) return 'never';
    var diff = Math.floor(Date.now() / 1000 - ts);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function statusClass(status) {
    switch (status) {
      case 'up-to-date': return 'warded';
      case 'updates-available': return 'pending';
      case 'checking': case 'updating': return 'running';
      case 'queued': return 'queued';
      case 'failed': return 'failed';
      default: return 'idle';
    }
  }

  function statusLabel(src) {
    switch (src.status) {
      case 'up-to-date': return 'warded';
      case 'updates-available': return src.available + ' pending';
      case 'checking': return '\u27f3 checking';
      case 'updating': return '\u27f3 updating';
      case 'queued': return 'queued' + (src.queued_behind ? ' \u2190 ' + src.queued_behind : '');
      case 'failed': return 'failed';
      default: return 'idle';
    }
  }

  function el(tag, className, textContent) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (textContent) e.textContent = textContent;
    return e;
  }

  // ── DOM construction ────────────────────────────────────────────

  function buildRow(id, src) {
    var cls = statusClass(src.status);
    var isExpanded = _expanded[id];
    var isRunning = src.status === 'updating' || src.status === 'checking';

    var row = el('div', 'updates-row updates-row--' + cls + (isExpanded ? ' expanded' : ''));
    row.setAttribute('data-source', id);

    // Header
    var header = el('div', 'updates-row-header');
    header.setAttribute('data-source', id);
    header.appendChild(el('span', 'updates-row-icon', src.icon));
    header.appendChild(el('span', 'updates-row-name', src.fantasy_name));
    var statusSpan = el('span', 'updates-row-status updates-row-status--' + cls, statusLabel(src));
    header.appendChild(statusSpan);
    header.appendChild(el('span', 'updates-row-time', relativeTime(src.last_check || src.last_update)));
    row.appendChild(header);

    // Detail (expanded area)
    var detail = el('div', 'updates-row-detail');

    // Package list
    if (src.packages && src.packages.length > 0 && src.status === 'updates-available') {
      var pkgList = el('div', 'updates-pkg-list');
      for (var j = 0; j < src.packages.length; j++) {
        pkgList.appendChild(el('span', null, src.packages[j]));
      }
      detail.appendChild(pkgList);
    }

    // Log
    if ((src.log_lines && src.log_lines.length > 0) || (src.error && src.status === 'failed')) {
      var log = el('div', 'updates-log');
      log.id = 'log-' + id;

      if (src.log_lines) {
        for (var k = 0; k < src.log_lines.length; k++) {
          var line = src.log_lines[k];
          var lineCls = '';
          if (line.charAt(0) === '$' || line.charAt(0) === '+') lineCls = 'updates-log-line--cmd';
          else if (/error|fail|cannot|unable/i.test(line)) lineCls = 'updates-log-line--error';
          else if (/done|success|up.to.date|already/i.test(line)) lineCls = 'updates-log-line--success';
          log.appendChild(el('div', lineCls, line));
        }
      }

      if (src.error && src.status === 'failed' && (!src.log_lines || src.log_lines.length === 0)) {
        log.appendChild(el('div', 'updates-log-line--error', src.error));
      }

      if (isRunning) {
        log.appendChild(el('span', 'updates-log-cursor'));
      }
      detail.appendChild(log);
    }

    // Action buttons
    var actions = el('div', 'updates-row-actions');
    if (isRunning) {
      var cancelBtn = el('button', 'updates-btn updates-btn--cancel', 'Cancel');
      cancelBtn.setAttribute('data-cancel', id);
      actions.appendChild(cancelBtn);
    } else {
      var checkBtn = el('button', 'updates-btn updates-btn--check', 'Check');
      checkBtn.setAttribute('data-check', id);
      actions.appendChild(checkBtn);
      var runBtn = el('button', 'updates-btn updates-btn--run', 'Run');
      runBtn.setAttribute('data-run', id);
      actions.appendChild(runBtn);
    }
    detail.appendChild(actions);

    row.appendChild(detail);
    return row;
  }

  // ── Rendering ───────────────────────────────────────────────────

  function render(data) {
    if (!data || !data.sources) return;
    _state = data;

    // Update summary badges
    var s = data.summary;
    wardedBadge.textContent = s.warded + ' warded';
    if (s.pending > 0) {
      pendingBadge.textContent = s.pending + ' pending';
      pendingBadge.style.display = '';
    } else {
      pendingBadge.style.display = 'none';
    }
    if (s.failed > 0) {
      failedBadge.textContent = s.failed + ' failed';
      failedBadge.style.display = '';
    } else {
      failedBadge.style.display = 'none';
    }

    // Auto-expand running sources
    for (var sid in data.sources) {
      var src = data.sources[sid];
      if (src.status === 'updating' || src.status === 'checking') {
        _expanded[sid] = true;
      }
    }

    // Build DOM
    var frag = document.createDocumentFragment();
    var sourceOrder = Object.keys(data.sources);
    for (var i = 0; i < sourceOrder.length; i++) {
      frag.appendChild(buildRow(sourceOrder[i], data.sources[sourceOrder[i]]));
    }

    // Replace body contents
    while (body.firstChild) body.removeChild(body.firstChild);
    body.appendChild(frag);

    // Auto-scroll logs for running sources
    for (var sid in data.sources) {
      if (data.sources[sid].status === 'updating' || data.sources[sid].status === 'checking') {
        var logEl = document.getElementById('log-' + sid);
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
      }
    }
  }

  // ── Event handlers ──────────────────────────────────────────────

  body.addEventListener('click', function (e) {
    var header = e.target.closest('.updates-row-header');
    if (header && !e.target.closest('button')) {
      var sid = header.getAttribute('data-source');
      _expanded[sid] = !_expanded[sid];
      if (_state) render(_state);
      return;
    }

    var checkBtn = e.target.closest('[data-check]');
    if (checkBtn) {
      fetch('/updates/check/' + checkBtn.getAttribute('data-check'), { method: 'POST' });
      return;
    }

    var runBtn = e.target.closest('[data-run]');
    if (runBtn) {
      fetch('/updates/run/' + runBtn.getAttribute('data-run'), { method: 'POST' });
      return;
    }

    var cancelBtn = e.target.closest('[data-cancel]');
    if (cancelBtn) {
      fetch('/updates/run/' + cancelBtn.getAttribute('data-cancel'), { method: 'DELETE' });
      return;
    }
  });

  checkAllBtn.addEventListener('click', function () {
    fetch('/updates/check', { method: 'POST' });
  });

  runAllBtn.addEventListener('click', function () {
    fetch('/updates/run', { method: 'POST' });
  });

  // ── SSE subscription ───────────────────────────────────────────

  API.onSSE('updates', render);

  // Initial fetch
  fetch('/updates').then(function (r) { return r.json(); }).then(render);
})();
