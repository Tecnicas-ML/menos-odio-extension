const DEFAULTS = {
  enabled: true,
  threshold: 0.5,
  mode: "blur",
  showAllScores: false,
  genericMode: true,
  disabledHosts: [],
  backend: "local",
  serverUrl: "http://127.0.0.1:8765",
};

const $ = (id) => document.getElementById(id);
let S = { ...DEFAULTS };
let tab = null;
let host = "";

function save(patch) {
  Object.assign(S, patch);
  chrome.storage.sync.set(patch);
}

function render() {
  $("enabled").checked = S.enabled;
  $("threshold").value = S.threshold;
  $("thrVal").textContent = Number(S.threshold).toFixed(2);
  $("mode").value = S.mode;
  $("showAllScores").checked = S.showAllScores;
  $("genericMode").checked = S.genericMode;
  $("pauseHere").checked = host && S.disabledHosts.includes(host);
  $("pauseHere").disabled = !host;
  $("backend").value = S.backend;
  $("serverUrl").value = S.serverUrl;
  $("serverRow").style.display = S.backend === "local" ? "" : "none";
}

async function checkHealth() {
  const el = $("status");
  el.className = "status";
  el.textContent = "Comprobando…";
  const h = await chrome.runtime.sendMessage({ type: "health" });
  if (h?.ok) {
    el.className = "status ok";
    el.textContent =
      h.backend === "local"
        ? `● Conectado · ${h.device} · umbral modelo ${Number(h.threshold).toFixed(2)}`
        : `● ${h.detail}`;
  } else {
    el.className = "status err";
    el.innerHTML =
      h?.backend === "local"
        ? "● Servidor apagado. Ejecuta <code>python server/server.py</code>"
        : `● Space no disponible (${h?.error || "error"})`;
  }
}

async function loadStats() {
  if (!tab?.id) return;
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: "getStats" });
    $("flagged").textContent = st.flagged;
    $("analyzed").textContent = st.analyzed;
    $("site").textContent = st.site || "Sin adaptador";
  } catch {
    $("site").textContent = "No disponible";
  }
  $("host").textContent = host;
}

document.addEventListener("DOMContentLoaded", async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    host = new URL(tab.url).hostname;
  } catch {
    host = "";
  }
  S = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  render();
  checkHealth();
  loadStats();
  setInterval(loadStats, 1500);

  $("enabled").onchange = (e) => save({ enabled: e.target.checked });
  $("threshold").oninput = (e) => {
    $("thrVal").textContent = Number(e.target.value).toFixed(2);
  };
  $("threshold").onchange = (e) => save({ threshold: Number(e.target.value) });
  $("mode").onchange = (e) => save({ mode: e.target.value });
  $("showAllScores").onchange = (e) => save({ showAllScores: e.target.checked });
  $("genericMode").onchange = (e) => save({ genericMode: e.target.checked });
  $("pauseHere").onchange = (e) => {
    const set = new Set(S.disabledHosts);
    e.target.checked ? set.add(host) : set.delete(host);
    save({ disabledHosts: [...set] });
  };
  $("backend").onchange = (e) => {
    save({ backend: e.target.value });
    render();
    checkHealth();
  };
  $("serverUrl").onchange = (e) => {
    save({ serverUrl: e.target.value.trim() || DEFAULTS.serverUrl });
    checkHealth();
  };
});
