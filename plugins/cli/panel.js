// The Command Spire — wraps realm CLI in the webgui.
// Four tabs: Brief, Doctor, Logs, Exec.
// DOM-built (no innerHTML) per realmwatch hook policy.
(function () {
  const root = document.querySelector('.cli-panel');
  if (!root) return;

  const out = root.querySelector('.cli-output');
  const tabs = root.querySelectorAll('.cli-tabs button');
  const refreshBtn = root.querySelector('.cli-refresh');
  const autoChk = root.querySelector('.cli-auto');
  const filterInput = root.querySelector('.cli-filter');
  const linesInput = root.querySelector('.cli-lines');
  const errorsBtn = root.querySelector('.cli-errors');
  const execBar = root.querySelector('.cli-exec-bar');
  const cmdInput = root.querySelector('.cli-cmd');
  const runBtn = root.querySelector('.cli-run');

  const state = {
    tab: 'brief',
    autoTimer: null,
    errorsOnly: false,
  };

  function setOutput(text, classify) {
    while (out.firstChild) out.removeChild(out.firstChild);
    if (!classify) {
      out.textContent = text;
      return;
    }
    // Classify each line by leading marker (✓ ✘ ! or section headers)
    text.split('\n').forEach((line) => {
      const span = document.createElement('span');
      if (/^\s*✓/.test(line)) span.className = 'ok';
      else if (/^\s*✘/.test(line)) span.className = 'fail';
      else if (/^\s*!/.test(line)) span.className = 'warn';
      else if (/^[A-Z][A-Za-z ]+$/.test(line.trim())) span.className = 'header';
      span.textContent = line + '\n';
      out.appendChild(span);
    });
  }

  function show(el, on) { el.hidden = !on; }

  async function loadBrief() {
    setOutput('loading brief…');
    try {
      const r = await fetch('/cli/brief');
      const j = await r.json();
      setOutput(j.text || j.stderr || JSON.stringify(j, null, 2), true);
    } catch (e) {
      setOutput('error: ' + e.message);
    }
  }

  async function loadDoctor() {
    setOutput('running doctor (may take ~10s for ping sweep)…');
    try {
      const r = await fetch('/cli/doctor?quick=1');
      const j = await r.json();
      setOutput(j.text || j.stderr || JSON.stringify(j, null, 2), true);
    } catch (e) {
      setOutput('error: ' + e.message);
    }
  }

  async function loadLogs() {
    const n = Math.max(10, Math.min(parseInt(linesInput.value, 10) || 50, 1000));
    const plugin = filterInput.value.trim();
    let url = `/cli/logs?n=${n}`;
    if (plugin) url += `&plugin=${encodeURIComponent(plugin)}`;
    if (state.errorsOnly) url += '&errors=1';
    setOutput('fetching logs…');
    try {
      const r = await fetch(url);
      const j = await r.json();
      setOutput(j.text || j.stderr || '(no logs)', false);
      // Auto-scroll to bottom for tail behavior
      out.scrollTop = out.scrollHeight;
    } catch (e) {
      setOutput('error: ' + e.message);
    }
  }

  async function runExec(cmd) {
    if (!cmd) return;
    setOutput(`> realm ${cmd}\n\nrunning…`);
    try {
      const r = await fetch('/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `realm ${cmd}` }),
      });
      const j = await r.json();
      const text = `> realm ${cmd}\n\n` +
                   (j.stdout || '') +
                   (j.stderr ? `\n${j.stderr}` : '') +
                   `\n[exit ${j.code}]`;
      setOutput(text, j.code === 0);
      out.scrollTop = out.scrollHeight;
    } catch (e) {
      setOutput('error: ' + e.message);
    }
  }

  function refresh() {
    if (state.tab === 'brief')  return loadBrief();
    if (state.tab === 'doctor') return loadDoctor();
    if (state.tab === 'logs')   return loadLogs();
    // exec tab does nothing on refresh
  }

  function setTab(tab) {
    state.tab = tab;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    show(filterInput, tab === 'logs');
    show(linesInput, tab === 'logs');
    show(errorsBtn, tab === 'logs');
    show(execBar, tab === 'exec');
    show(refreshBtn, tab !== 'exec');
    if (tab !== 'exec') refresh();
    else setOutput('Type a realm sub-command and press Enter or Run.\nExamples:\n  fleet list\n  doctor --quick\n  status\n  ssh katana uptime\n  event list');
  }

  tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  refreshBtn.addEventListener('click', refresh);
  errorsBtn.addEventListener('click', () => {
    state.errorsOnly = !state.errorsOnly;
    errorsBtn.style.background = state.errorsOnly ? 'rgba(255,100,100,0.3)' : '';
    refresh();
  });
  linesInput.addEventListener('change', refresh);
  filterInput.addEventListener('change', refresh);

  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      runExec(cmdInput.value.trim());
    }
  });
  runBtn.addEventListener('click', () => runExec(cmdInput.value.trim()));

  autoChk.addEventListener('change', () => {
    if (autoChk.checked) {
      state.autoTimer = setInterval(refresh, 30000);
    } else if (state.autoTimer) {
      clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  });

  if (window.RealmAPI && window.RealmAPI.onSSE) {
    window.RealmAPI.onSSE('plugin-broadcast', (msg) => {
      if (msg && (msg.type === 'fleet-update' || msg.type === 'cli-refresh')) {
        if (state.tab === 'brief') loadBrief();
      }
    });
  }

  setTab('brief');
})();
