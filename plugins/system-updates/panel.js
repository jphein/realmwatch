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
      case 'up-to-date':                    return 'warded';
      case 'warded-but-advised':            return 'advised';
      case 'warded-but-audit-failed':       return 'audit-failed';
      case 'updates-available':             return 'pending';
      case 'updates-available-quarantined': return 'quarantined';
      case 'awaiting-approvals':            return 'awaiting';
      case 'checking': case 'updating':     return 'running';
      case 'queued':                        return 'queued';
      case 'failed':                        return 'failed';
      default:                              return 'idle';
    }
  }

  function statusLabel(src) {
    switch (src.status) {
      case 'up-to-date':                    return 'warded';
      case 'warded-but-advised':            return '\u26a0 advised';
      case 'warded-but-audit-failed':       return '\ud83d\uded1 audit failed';
      case 'updates-available':             return src.available + ' pending';
      case 'updates-available-quarantined': return '\u23f3 quarantined';
      case 'awaiting-approvals':            return '\u23f8 awaiting approval';
      case 'checking':                      return '\u27f3 checking';
      case 'updating':                      return '\u27f3 updating';
      case 'queued':                        return 'queued' + (src.queued_behind ? ' \u2190 ' + src.queued_behind : '');
      case 'failed':                        return 'failed';
      default:                              return 'idle';
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

    // Quarantine badge on header
    if (src.status === 'updates-available-quarantined' || src.status === 'updates-available') {
      var quarantine = src.quarantine || {};
      var quarantinedVersions = Object.keys(quarantine).filter(function (v) {
        return quarantine[v].quarantined && quarantine[v].remaining > 0;
      });
      if (quarantinedVersions.length > 0) {
        var minRemaining = Math.min.apply(null, quarantinedVersions.map(function (v) {
          return quarantine[v].remaining;
        }));
        var hoursLeft = Math.ceil(minRemaining / 3600);
        var qBadge = el('span', 'updates-quarantine-badge', '⏳ ' + hoursLeft + 'h');
        var tooltipMsg;
        if (src.status === 'updates-available-quarantined') {
          tooltipMsg = quarantinedVersions.length + ' version(s) in quarantine window. Earliest available in ~' + hoursLeft + 'h.';
        } else {
          tooltipMsg = 'Some versions in quarantine (' + hoursLeft + 'h remaining) — other updates are available now.';
        }
        qBadge.title = tooltipMsg;
        header.appendChild(qBadge);
      }
    }

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

    // Advisory block (L1 OSV)
    if (src.advisories && src.advisories.length > 0) {
      var advBlock = el('div', 'updates-advisories');
      advBlock.appendChild(el('div', 'updates-advisory-title', '⚠ Security Advisories (' + src.advisories.length + ')'));
      for (var ai = 0; ai < src.advisories.length; ai++) {
        var adv = src.advisories[ai];
        var advItem = el('div', 'updates-advisory-item');
        var sev = adv.severity ? '[' + adv.severity + '] ' : '';
        advItem.textContent = sev + (adv.package || '') + ' ' + (adv.version || '') + ': ' + (adv.summary || adv.id);
        if (adv.url && (adv.url.startsWith('https://') || adv.url.startsWith('http://'))) {
          var link = document.createElement('a');
          link.href = adv.url;
          link.target = '_blank';
          link.textContent = ' ↗';
          link.title = adv.url;
          advItem.appendChild(link);
        }
        advBlock.appendChild(advItem);
      }
      detail.appendChild(advBlock);
    }

    // Audit-failed block (L3B)
    if (src.status === 'warded-but-audit-failed' && src.script_audits) {
      var failedAudits = src.script_audits.filter(function (a) { return !a.match; });
      if (failedAudits.length > 0) {
        var auditBlock = el('div', 'updates-audit-failed');
        var auditLines = ['🛑 Install-script audit failed: on-disk hooks differ from approved manifest'];
        for (var fi = 0; fi < failedAudits.length; fi++) {
          var fa = failedAudits[fi];
          auditLines.push('  ' + (fa.package || '?') + ' → ' + (fa.hook || '?') + ': approved=' + (fa.approved || '(none)').substring(0, 40) + '…');
        }
        auditBlock.textContent = auditLines.join('\n');
        detail.appendChild(auditBlock);
      }
    }

    // Pending approval blocks (L3A)
    if (src.pending_approvals && src.pending_approvals.length > 0) {
      for (var pi = 0; pi < src.pending_approvals.length; pi++) {
        var approval = src.pending_approvals[pi];
        var approvalBlock = el('div', 'updates-approval');

        var approvalTitle = approval.package + '  ' + (approval.from_version || '?') + ' → ' + (approval.to_version || '?');
        approvalBlock.appendChild(el('div', 'updates-approval-title', '🔍 Script change: ' + approvalTitle));

        // Diff
        if (approval.changes && approval.changes.length > 0) {
          var diffEl = el('div', 'updates-approval-diff');
          for (var ci = 0; ci < approval.changes.length; ci++) {
            var ch = approval.changes[ci];
            var diffLine;
            if (ch.change === 'added') {
              diffLine = el('div', 'diff-added', '+ ' + ch.hook + ':  ' + (ch.new || ''));
              diffEl.appendChild(diffLine);
            } else if (ch.change === 'removed') {
              diffLine = el('div', 'diff-removed', '- ' + ch.hook + ':  ' + (ch.old || ''));
              diffEl.appendChild(diffLine);
            } else {
              diffLine = el('div', 'diff-removed', '- ' + ch.hook + ':  ' + (ch.old || ''));
              diffEl.appendChild(diffLine);
              diffLine = el('div', 'diff-added', '+ ' + ch.hook + ':  ' + (ch.new || ''));
              diffEl.appendChild(diffLine);
            }
          }
          approvalBlock.appendChild(diffEl);
        }

        // Approve/Skip buttons
        var approvalActions = el('div', 'updates-approval-actions');
        var approveBtn = el('button', 'updates-btn updates-btn--approve', 'Install anyway');
        approveBtn.setAttribute('data-approve', id);
        approveBtn.setAttribute('data-pkg', approval.package);
        var skipBtn = el('button', 'updates-btn updates-btn--skip', 'Skip');
        skipBtn.setAttribute('data-skip', id);
        skipBtn.setAttribute('data-pkg', approval.package);
        approvalActions.appendChild(approveBtn);
        approvalActions.appendChild(skipBtn);
        approvalBlock.appendChild(approvalActions);

        detail.appendChild(approvalBlock);
      }
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
      if (src.status === 'updates-available-quarantined') {
        runBtn.disabled = true;
        runBtn.title = 'All updates in quarantine window — check back later';
      }
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

    // Auto-expand running sources and sources needing attention
    for (var sid in data.sources) {
      var src = data.sources[sid];
      if (src.status === 'updating' || src.status === 'checking') {
        _expanded[sid] = true;
      }
      if (src.status === 'awaiting-approvals' ||
          src.status === 'warded-but-audit-failed' ||
          src.status === 'warded-but-advised') {
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

    var approveBtn2 = e.target.closest('[data-approve]');
    if (approveBtn2) {
      var src2 = approveBtn2.getAttribute('data-approve');
      var pkg2 = approveBtn2.getAttribute('data-pkg');
      fetch('/updates/approve/' + src2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pkg: pkg2 })
      });
      return;
    }

    var skipBtn2 = e.target.closest('[data-skip]');
    if (skipBtn2) {
      var src3 = skipBtn2.getAttribute('data-skip');
      var pkg3 = skipBtn2.getAttribute('data-pkg');
      fetch('/updates/approve/' + src3, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pkg: pkg3 })
      });
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
