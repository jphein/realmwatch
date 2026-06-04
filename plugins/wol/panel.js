// Slumber Ward — list WoL-managed hosts with live power state + wake/slumber.
// Rows are built with createElement/textContent (never innerHTML) so host names
// from the API can never be interpreted as markup.
const WOL_ICON = { awake: "⚡", slumbering: "🌙", waking: "…", dark: "🕯️" };

function wolBtn(label, act, host) {
  const b = document.createElement("button");
  b.className = "wol-btn";
  b.textContent = label;
  b.dataset.act = act;
  b.dataset.host = host;
  return b;
}

async function wolRefresh() {
  const statusEl = document.getElementById("wol-status");
  const tb = document.getElementById("wol-rows");
  if (!tb) return;
  let data;
  try {
    data = await fetch("/plugins/wol/status").then((r) => r.json());
  } catch (e) {
    if (statusEl) statusEl.textContent = "✗ " + e;
    return;
  }
  tb.replaceChildren();
  for (const h of data.hosts || []) {
    const tr = document.createElement("tr");

    const tdHost = document.createElement("td");
    tdHost.textContent = h.host;
    tr.appendChild(tdHost);

    const tdState = document.createElement("td");
    tdState.textContent = (WOL_ICON[h.state] || "") + " " + h.state;
    tdState.className = "wol-state wol-" + h.state;
    tr.appendChild(tdState);

    const tdAct = document.createElement("td");
    if (h.wake_capable) tdAct.appendChild(wolBtn("Wake", "wake", h.host));
    if (h.sleepable) tdAct.appendChild(wolBtn("Slumber", "sleep", h.host));
    tr.appendChild(tdAct);

    tb.appendChild(tr);
  }
}

async function wolAction(act, host) {
  const statusEl = document.getElementById("wol-status");
  if (act === "sleep" && !confirm(`Slumber ${host}? It will suspend to S3.`)) return;
  const path = act === "wake" ? "/wol" : "/plugins/wol/sleep";
  if (statusEl) statusEl.textContent = act + "…";
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: host }),
    }).then((r) => r.json());
  } catch (e) {
    res = { error: String(e) };
  }
  if (statusEl) statusEl.textContent = res.error ? "✗ " + res.error : "✓ " + act + " " + host;
  setTimeout(wolRefresh, 2500);
}

(function initWolPanel() {
  const body = document.getElementById("wol-panel-body");
  if (!body || body.dataset.wolInit) return;
  body.dataset.wolInit = "1";
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (b) { wolAction(b.dataset.act, b.dataset.host); return; }
    if (e.target.closest("#wol-refresh")) wolRefresh();
  });
  wolRefresh();
  setInterval(wolRefresh, 30000);
})();
