'use strict';
// posters.js
//
//  Quadro estático (WebP) de um documento HTML animado, renderizado pelo
//  Chromium do servidor (/api/thumbs/html) e guardado no localStorage pelo
//  hash do HTML. Cards de texto e o modal de transcrição mostram o pôster e
//  só criam um iframe vivo no card sob o mouse — um iframe de 1080×1920 por
//  card travava o editor.

(() => {
  const KEY = 'ms.posters';
  const MAX = 120;               // pôsteres guardados (~5–10 KB cada)

  let cache = null;
  const inflight = new Map();
  let queue = Promise.resolve(); // o servidor renderiza um por vez: sem fila paralela

  function load() {
    if (!cache) {
      try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { cache = {}; }
    }
    return cache;
  }

  function persist() {
    const keys = Object.keys(cache);
    if (keys.length > MAX) keys.slice(0, keys.length - MAX).forEach(k => delete cache[k]);
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) { /* sem espaço: fica só em memória */ }
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }

  const keyOf = (html, res, t) => `${res.w}x${res.h}|${t}|${hash(html)}`;

  /** URL já pronta (síncrono) ou null */
  function cached(html, res, t) {
    return load()[keyOf(html, res, t)] || null;
  }

  /** Promise<url data:image/webp> do quadro em `t` segundos */
  function get(html, res, t) {
    const key = keyOf(html, res, t);
    const hit = load()[key];
    if (hit) return Promise.resolve(hit);
    if (inflight.has(key)) return inflight.get(key);

    const job = queue.then(async () => {
      const resp = await fetch('/api/thumbs/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, w: res.w, h: res.h, times: [t], height: 240 }),
      });
      const url = resp.ok ? (await resp.json()).frames?.[0]?.url : null;
      if (!url) throw new Error(`pôster: HTTP ${resp.status}`);
      load()[key] = url;
      persist();
      return url;
    });
    queue = job.catch(() => {});
    inflight.set(key, job);
    job.then(() => inflight.delete(key), () => inflight.delete(key));
    return job;
  }

  window.MSPosters = { get, cached };
})();
