// Service worker: recibe lotes de textos de los content scripts, llama al
// backend del modelo v5 y devuelve probabilidades. Mantiene una caché en memoria.

const DEFAULTS = {
  backend: "local", // "local" (server.py) | "space" (Gradio en Hugging Face)
  serverUrl: "http://127.0.0.1:8765",
  spaceUrl: "https://tatisvivass-menos-odio-a-la-vista.hf.space",
  threshold: 0.5, // puntaje combinado v5: 0.5 = umbral de DEV_EVAL de cada cabeza (insulto / odio grupal)
};

// Migración A3 -> v5: el umbral 0.28 guardado por la versión anterior no aplica al puntaje v5.
async function migrate() {
  const { modelVersion } = await chrome.storage.sync.get({ modelVersion: null });
  if (modelVersion !== "v5") {
    await chrome.storage.sync.set({ modelVersion: "v5", threshold: DEFAULTS.threshold });
    cache.clear();
  }
}
chrome.runtime.onInstalled.addListener(migrate);
chrome.runtime.onStartup.addListener(migrate);

const cache = new Map(); // `${backend}|${text}` -> prob
const CACHE_MAX = 5000;

function cachePut(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function fetchJSON(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}

// ---- backend local (FastAPI, lotes) ----
async function scoreLocal(texts, s) {
  const r = await fetchJSON(`${s.serverUrl.replace(/\/$/, "")}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts }),
  });
  const d = await r.json();
  return d.probs;
}

// ---- backend Space (Gradio 5, un texto por llamada) ----
async function scoreSpaceOne(text, s) {
  const base = s.spaceUrl.replace(/\/$/, "");
  const r1 = await fetchJSON(`${base}/gradio_api/call/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: [text.slice(0, 500), s.threshold] }),
  });
  const { event_id } = await r1.json();
  const r2 = await fetchJSON(`${base}/gradio_api/call/predict/${event_id}`, {}, 120000);
  const body = await r2.text();
  // SSE: "event: complete\ndata: [etiqueta, prob, mensaje]"
  const m = body.match(/event:\s*complete\s*\ndata:\s*(.+)/);
  if (!m) throw new Error("Space sin respuesta (¿cuota ZeroGPU agotada?)");
  return Number(JSON.parse(m[1])[1]);
}

async function scoreSpace(texts, s) {
  const out = new Array(texts.length);
  let i = 0;
  const worker = async () => {
    while (i < texts.length) {
      const k = i++;
      out[k] = await scoreSpaceOne(texts[k], s);
    }
  };
  await Promise.all([worker(), worker()]); // máx. 2 en paralelo (cola del Space)
  return out;
}

async function score(texts) {
  const s = await settings();
  const key = (t) => `${s.backend}|${t}`;
  const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
  if (missing.length) {
    const probs = s.backend === "space" ? await scoreSpace(missing, s) : await scoreLocal(missing, s);
    missing.forEach((t, i) => cachePut(key(t), probs[i]));
  }
  return texts.map((t) => cache.get(key(t)));
}

async function health() {
  const s = await settings();
  try {
    if (s.backend === "space") {
      await fetchJSON(`${s.spaceUrl.replace(/\/$/, "")}/config`, {}, 10000);
      return { ok: true, backend: "space", detail: "Space en línea (puede tardar o agotar cuota)" };
    }
    const r = await fetchJSON(`${s.serverUrl.replace(/\/$/, "")}/health`, {}, 4000);
    return { ok: true, backend: "local", ...(await r.json()) };
  } catch (e) {
    return { ok: false, backend: s.backend, error: String(e.message || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg?.type === "score") {
    score(msg.texts)
      .then((probs) => send({ ok: true, probs }))
      .catch((e) => send({ ok: false, error: String(e.message || e) }));
    return true; // respuesta asíncrona
  }
  if (msg?.type === "health") {
    health().then(send);
    return true;
  }
  if (msg?.type === "stats" && sender.tab?.id != null) {
    const n = msg.flagged || 0;
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#c62828" });
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n) : "" });
  }
  if (msg?.type === "clearCache") {
    cache.clear();
    send({ ok: true });
  }
  return false;
});
