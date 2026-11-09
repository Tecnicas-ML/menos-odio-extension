// Content script: encuentra comentarios en el DOM, pide el puntaje al modelo
// (vía background.js) y oculta/difumina los que superan el umbral.
/* global MOV_SITES, MOV_GENERIC, movSiteFor */
(() => {
  if (window.__movLoaded) return;
  window.__movLoaded = true;

  const DEFAULTS = {
    enabled: true,
    threshold: 0.5, // puntaje combinado v5 (0.5 = umbral de DEV_EVAL por cabeza)
    mode: "blur", // "blur" | "hide"
    showAllScores: false, // también mostrar puntaje en comentarios no ofensivos
    genericMode: true, // heurística para periódicos/blogs
    disabledHosts: [],
  };
  const MAX_CHARS = 1000;
  const MAX_BATCH = 48;

  let S = { ...DEFAULTS };
  const host = location.hostname;
  const site = movSiteFor(host);
  const adapters = () => [site, S.genericMode ? MOV_GENERIC : null].filter(Boolean);

  // Estado por nodo: texto analizado y probabilidad
  const state = new WeakMap(); // el -> {text, prob|null, pending}
  const scored = new Set(); // nodos con puntaje (para reaplicar si cambia el umbral)
  const queue = new Map(); // text -> [el, ...]
  let stats = { analyzed: 0, flagged: 0, errors: 0 };
  let backendDown = false;

  const active = () => S.enabled && !S.disabledHosts.includes(host);

  // ---------- extracción ----------
  function textOf(el, exclude) {
    let node = el;
    if (exclude && el.querySelector(exclude)) {
      node = el.cloneNode(true);
      node.querySelectorAll(exclude).forEach((n) => n.remove());
    }
    node.querySelectorAll?.("mov-badge").forEach((n) => n.remove?.());
    const t = (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim();
    return t.slice(0, MAX_CHARS);
  }

  function candidates() {
    const out = [];
    for (const a of adapters()) {
      let nodes;
      try {
        nodes = document.querySelectorAll(a.items);
      } catch {
        continue;
      }
      const set = new Set(nodes);
      for (const el of nodes) {
        // Si otro nodo coincidente está dentro, nos quedamos con el más interno
        let hasInner = false;
        for (const n of el.querySelectorAll(a.items)) if (set.has(n)) { hasInner = true; break; }
        if (hasInner) continue;
        if (el.closest("[contenteditable='true'], textarea, input, mov-badge")) continue;
        if (a.skip && el.parentElement?.closest(a.skip)) continue;
        if (a.skip && el.matches(a.skip)) continue;
        out.push([el, a]);
      }
    }
    return out;
  }

  // ---------- escaneo ----------
  function scan() {
    if (!active()) return;
    for (const [el, a] of candidates()) {
      const text = textOf(el, a.exclude);
      if (text.length < (a.minLen ?? 2)) continue;
      const st = state.get(el);
      if (st && st.text === text && (st.prob != null || st.pending)) continue; // ya visto
      if (st && st.text !== text) clear(el); // nodo reciclado (YouTube, React)
      state.set(el, { text, prob: null, pending: true });
      if (!queue.has(text)) queue.set(text, []);
      queue.get(text).push(el);
    }
    flush();
  }

  let flushing = false;
  async function flush() {
    if (flushing || !queue.size) return;
    flushing = true;
    try {
      while (queue.size) {
        const texts = [...queue.keys()].slice(0, MAX_BATCH);
        const groups = texts.map((t) => queue.get(t));
        texts.forEach((t) => queue.delete(t));
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: "score", texts });
        } catch (e) {
          res = { ok: false, error: String(e) };
        }
        if (!res?.ok) {
          backendDown = true;
          stats.errors += texts.length;
          // liberar para reintentar en el próximo escaneo
          groups.flat().forEach((el) => state.delete(el));
          break;
        }
        backendDown = false;
        res.probs.forEach((p, i) => {
          for (const el of groups[i]) {
            const st = state.get(el);
            if (!st || st.text !== texts[i]) continue;
            st.prob = p;
            st.pending = false;
            scored.add(el);
            stats.analyzed++;
            apply(el);
          }
        });
        report();
      }
    } finally {
      flushing = false;
    }
  }

  // ---------- UI sobre el comentario ----------
  function pct(p) {
    return `${Math.round(p * 100)}%`;
  }

  function badgeFor(el) {
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === "MOV-BADGE") return prev;
    const b = document.createElement("mov-badge");
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.target.closest("[data-act='toggle']")) {
        if (el.hasAttribute("data-mov-revealed")) el.removeAttribute("data-mov-revealed");
        else el.setAttribute("data-mov-revealed", "");
        apply(el);
      }
    });
    el.parentNode?.insertBefore(b, el);
    return b;
  }

  function apply(el) {
    const st = state.get(el);
    if (!st || st.prob == null) return;
    if (!el.isConnected) {
      scored.delete(el);
      return;
    }
    const flagged = st.prob >= S.threshold;
    const was = el.getAttribute("data-mov-flag") === "1";
    if (flagged !== was) stats.flagged += flagged ? 1 : was ? -1 : 0;

    el.setAttribute("data-mov-prob", st.prob.toFixed(4));
    el.setAttribute("data-mov-mode", S.mode);
    if (!active()) return clear(el, true);

    if (flagged) {
      el.setAttribute("data-mov-flag", "1");
      const revealed = el.hasAttribute("data-mov-revealed");
      const b = badgeFor(el);
      b.className = "mov-bad";
      const msg = revealed
        ? "Comentario marcado como posible odio"
        : S.mode === "hide"
          ? "Comentario oculto por posible odio"
          : "Posible odio";
      b.innerHTML = "";
      const score = document.createElement("span");
      score.className = "mov-score";
      score.textContent = pct(st.prob);
      score.title = `Probabilidad de odio según el modelo v5 (insulto / odio grupal): ${st.prob.toFixed(3)} (umbral ${S.threshold.toFixed(2)})`;
      const label = document.createElement("span");
      label.className = "mov-label";
      label.textContent = msg;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.act = "toggle";
      btn.textContent = revealed ? "Ocultar" : "Mostrar";
      b.append(score, label, btn);
    } else {
      el.setAttribute("data-mov-flag", "0");
      if (S.showAllScores) {
        const b = badgeFor(el);
        b.className = "mov-ok";
        b.textContent = pct(st.prob);
        b.title = `Probabilidad de odio: ${st.prob.toFixed(3)} (umbral ${S.threshold.toFixed(2)})`;
      } else {
        removeBadge(el);
      }
    }
  }

  function removeBadge(el) {
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === "MOV-BADGE") prev.remove();
  }

  function clear(el, keepState = false) {
    if (el.getAttribute("data-mov-flag") === "1") stats.flagged--;
    removeBadge(el);
    ["data-mov-flag", "data-mov-prob", "data-mov-mode", "data-mov-revealed"].forEach((a) =>
      el.removeAttribute(a),
    );
    if (!keepState) {
      state.delete(el);
      scored.delete(el);
    }
  }

  function reapplyAll() {
    for (const el of [...scored]) apply(el);
    report();
  }

  // ---------- estadísticas ----------
  let reportTimer = null;
  function report() {
    if (window !== window.top && stats.analyzed === 0) return;
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      let flagged = 0;
      for (const el of scored) if (el.isConnected && el.getAttribute("data-mov-flag") === "1") flagged++;
      stats.flagged = flagged;
      chrome.runtime.sendMessage({ type: "stats", flagged, analyzed: stats.analyzed }).catch(() => {});
    }, 300);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg?.type === "getStats" && window === window.top) {
      send({ ...stats, site: site?.name || (S.genericMode ? MOV_GENERIC.name : null), host, backendDown });
    }
    if (msg?.type === "rescan") {
      scan();
    }
  });

  // ---------- observador ----------
  let scanTimer = null;
  let lastScan = 0;
  function schedule() {
    if (scanTimer) return;
    const wait = Math.max(150, 600 - (Date.now() - lastScan));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      lastScan = Date.now();
      scan();
    }, wait);
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      // ignorar nuestros propios cambios
      const t = m.target;
      if (t.nodeType === 1 && (t.tagName === "MOV-BADGE" || t.closest?.("mov-badge"))) continue;
      if (m.type === "attributes") continue;
      schedule();
      return;
    }
  });

  chrome.storage.sync.get(DEFAULTS, (v) => {
    S = { ...DEFAULTS, ...v };
    // Sin adaptador y sin modo genérico: no hacemos nada en esta página
    if (!site && !S.genericMode) return;
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scan();
    // Reintento periódico si el servidor estaba caído
    setInterval(() => backendDown && active() && scan(), 10000);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const before = { ...S };
    for (const k in changes) S[k] = changes[k].newValue ?? DEFAULTS[k];
    if (before.genericMode !== S.genericMode && !before.genericMode) {
      obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }
    reapplyAll();
    scan();
  });
})();
