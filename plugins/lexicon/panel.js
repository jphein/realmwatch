(function () {
  const root = document.querySelector('.lexicon-panel');
  if (!root) return;

  const tbody = root.querySelector('.lexicon-table tbody');
  const empty = root.querySelector('.lexicon-empty');
  const search = root.querySelector('.lexicon-search');
  const tabs = root.querySelectorAll('.lexicon-tabs button');

  const state = { entries: [], status: 'curated', query: '' };

  async function fetchEntries() {
    const resp = await fetch('/fleet/list');
    const data = await resp.json();
    state.entries = data.entries || [];
    render();
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    return td;
  }

  function actionCell(entry) {
    const td = document.createElement('td');
    if (entry.status === 'tentative' || entry.status === 'curated') {
      const btn = document.createElement('button');
      btn.className = 'lexicon-action-btn';
      btn.dataset.fleetId = entry.fleet_id;
      btn.dataset.action = entry.status === 'tentative' ? 'promote' : 'rename';
      btn.textContent = entry.status === 'tentative' ? 'Promote' : 'Rename';
      td.appendChild(btn);
    }
    return td;
  }

  function priorNamesText(entry) {
    return (entry.prior_names || []).map((p) => p.name).join(', ');
  }

  function rowFor(entry) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(entry.current_name));
    tr.appendChild(cell(entry.realm));
    tr.appendChild(cell(entry.kind));
    const idTd = cell(entry.fleet_id);
    idTd.className = 'fleet-id';
    tr.appendChild(idTd);
    tr.appendChild(cell(priorNamesText(entry)));
    tr.appendChild(actionCell(entry));
    return tr;
  }

  function render() {
    const q = state.query.toLowerCase();
    const filtered = state.entries.filter((e) =>
      e.status === state.status &&
      (!q ||
        (e.current_name && e.current_name.toLowerCase().includes(q)) ||
        (e.fleet_id && e.fleet_id.toLowerCase().includes(q)) ||
        (e.prior_names || []).some((p) => (p.name || '').toLowerCase().includes(q)))
    );
    clearChildren(tbody);
    empty.hidden = filtered.length > 0;
    for (const e of filtered) {
      tbody.appendChild(rowFor(e));
    }
  }

  tbody.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const fleetId = btn.dataset.fleetId;
    const action = btn.dataset.action;
    if (action === 'rename') {
      const newName = prompt('New name?');
      if (!newName) return;
      await fetch('/fleet/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fleet_id: fleetId, new_name: newName }),
      });
      await fetchEntries();
    } else if (action === 'promote') {
      await fetch('/fleet/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fleet_id: fleetId }),
      });
      await fetchEntries();
    }
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.status = tab.dataset.tab;
      render();
    });
  });

  search.addEventListener('input', (ev) => {
    state.query = ev.target.value;
    render();
  });

  if (window.RealmAPI && typeof window.RealmAPI.onSSE === 'function') {
    window.RealmAPI.onSSE('plugin-broadcast', (msg) => {
      if (msg && msg.type === 'fleet-update') fetchEntries();
    });
  }

  fetchEntries();
})();
