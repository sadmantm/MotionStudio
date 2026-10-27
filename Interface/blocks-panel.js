'use strict';
// blocks-panel.js
//
//  Aba "Blocos" da biblioteca:
//    • Overlays prontos (templates/overlays/*.html): light leak, starburst,
//      anotações à mão e cursor do macOS. Cada card é uma variante do mesmo
//      arquivo — os parâmetros marcados /*ms:nome*/'valor' são trocados aqui.
//    • Catálogo do HyperFrames (libs/hyperframes-catalog.js): ~200 blocos
//      prontos (gráficos, lower thirds, transições, mapas…) que entram como
//      clipe HTML; o motion-kit dirige a timeline GSAP deles.
//  Clique ou arraste para a timeline: entra no playhead, numa track livre
//  acima do clip selecionado.

(() => {
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? ''));
  const st = () => window.__appState;
  const notify = msg => window.MSUI?.toast?.({ message: msg, kind: 'error' });

  const ICONS = {
    leak: c => `<span class="bk-swatch" style="background:radial-gradient(circle at 30% 40%, ${c[0]}, transparent 60%), radial-gradient(circle at 75% 65%, ${c[1]}, transparent 55%), #15151b"></span>`,
    star: '<svg viewBox="-50 -50 100 100"><g fill="#ffd166" fill-opacity=".8">' + Array.from({ length: 12 }, (_, i) => `<path d="M0 0 L${(Math.cos((i / 12) * 6.283 - 0.12) * 60).toFixed(1)} ${(Math.sin((i / 12) * 6.283 - 0.12) * 60).toFixed(1)} L${(Math.cos((i / 12) * 6.283 + 0.12) * 60).toFixed(1)} ${(Math.sin((i / 12) * 6.283 + 0.12) * 60).toFixed(1)}Z"/>`).join('') + '</g></svg>',
    circle: c => `<svg viewBox="0 0 100 60"><path d="M30 12 C 70 2, 96 22, 88 40 S 30 60, 12 40 S 40 8, 62 10" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/></svg>`,
    box: c => `<svg viewBox="0 0 100 60"><path d="M10 12 L90 10 L91 50 L9 51 Z" fill="none" stroke="${c}" stroke-width="4" stroke-linejoin="round"/></svg>`,
    underline: c => `<svg viewBox="0 0 100 60"><text x="50" y="34" font-size="18" text-anchor="middle" fill="#aaa" font-family="sans-serif">Texto</text><path d="M14 44 Q 50 40, 88 43" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/></svg>`,
    highlight: c => `<svg viewBox="0 0 100 60"><rect x="12" y="20" width="76" height="22" fill="${c}" opacity=".55"/><text x="50" y="37" font-size="18" text-anchor="middle" fill="#ddd" font-family="sans-serif">Texto</text></svg>`,
    strike: c => `<svg viewBox="0 0 100 60"><text x="50" y="37" font-size="18" text-anchor="middle" fill="#aaa" font-family="sans-serif">Texto</text><path d="M14 33 L88 29" stroke="${c}" stroke-width="4" stroke-linecap="round"/></svg>`,
    cross: c => `<svg viewBox="0 0 100 60"><path d="M20 10 L80 50 M80 10 L20 50" stroke="${c}" stroke-width="4" stroke-linecap="round"/></svg>`,
    arrow: '<svg viewBox="0 0 32 32"><path d="M6 3 L6 26 L11.6 20.7 L15.1 28.8 L18.7 27.2 L15.2 19.3 L22.8 19.3 Z" fill="#111" stroke="#fff" stroke-width="1.6"/></svg>',
    hand: '<svg viewBox="0 0 32 32"><path d="M11 3c1.1 0 2 .9 2 2v9l1-.2V9.5c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8V14l.8-.1v-3c0-1 .8-1.8 1.8-1.8s1.8.8 1.8 1.8V15l.6-.1v-2c0-1 .8-1.7 1.7-1.7s1.7.8 1.7 1.7V20c0 4.5-3.2 8-7.8 8h-2.6c-2.4 0-4.4-1-5.8-2.9l-4.1-5.5c-.6-.9-.4-2.1.5-2.7.8-.6 2-.5 2.7.3L9 17.5V5c0-1.1.9-2 2-2z" fill="#fff" stroke="#111" stroke-width="1.6"/></svg>',
  };

  // [id, nome, arquivo, parâmetros, ícone, ajustes do clip]
  const OVERLAYS = [
    ['leak-warm',  'Light leak quente', 'light-leak.html', { palette: 'warm' },  ICONS.leak(['#ff6a00', '#ff2e63']), { blend: 'screen', fit: true }],
    ['leak-cool',  'Light leak frio',   'light-leak.html', { palette: 'cool' },  ICONS.leak(['#2f8bff', '#6ef3ff']), { blend: 'screen', fit: true }],
    ['leak-prism', 'Light leak prisma', 'light-leak.html', { palette: 'prism' }, ICONS.leak(['#ff3d6e', '#3ee8b5']), { blend: 'screen', fit: true }],
    ['starburst',  'Starburst',         'starburst.html',  {},                  ICONS.star,                         { blend: 'screen', fit: true }],
    ['ann-circle',    'Círculo à mão',    'rough-annotation.html', { kind: 'circle' },    ICONS.circle('#ff3b30'),    {}],
    ['ann-box',       'Caixa à mão',      'rough-annotation.html', { kind: 'box' },       ICONS.box('#ff3b30'),       {}],
    ['ann-underline', 'Sublinhado',       'rough-annotation.html', { kind: 'underline' }, ICONS.underline('#ff3b30'), {}],
    ['ann-highlight', 'Marca-texto',      'rough-annotation.html', { kind: 'highlight', color: '#ffd60a' }, ICONS.highlight('#ffd60a'), { blend: 'multiply' }],
    ['ann-strike',    'Riscado',          'rough-annotation.html', { kind: 'strike' },    ICONS.strike('#ff3b30'),    {}],
    ['ann-cross',     'X à mão',          'rough-annotation.html', { kind: 'cross' },     ICONS.cross('#ff3b30'),     {}],
    ['cursor-arrow',  'Cursor (seta)',    'cursor.html', { kind: 'arrow' }, ICONS.arrow, {}],
    ['cursor-hand',   'Cursor (mão)',     'cursor.html', { kind: 'hand' },  ICONS.hand,  {}],
  ];

  const S = { built: false, catalog: null, loading: null, query: '', tag: '' };
  const sources = new Map();   // arquivo → Promise<html>

  function overlaySource(file) {
    if (!sources.has(file)) {
      sources.set(file, fetch(`/templates/overlays/${file}`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      }));
      sources.get(file).catch(() => sources.delete(file));
    }
    return sources.get(file);
  }

  /** Troca /*ms:nome*\/'valor' pelos parâmetros da variante */
  const fillParams = (html, params) => html.replace(/\/\*ms:(\w+)\*\/'[^']*'/g, (m, key) =>
    (params[key] !== undefined ? `/*ms:${key}*/'${String(params[key]).replace(/['\\]/g, '')}'` : m));

  /** Entra no playhead, numa track livre acima do clip selecionado */
  function insertHtml(name, html, adjust = {}) {
    const state = st();
    if (!state?.project) { notify('Abra ou crie um projeto primeiro.'); return []; }
    const selected = state.clips.find(c => c.id === state.currentClipId);
    const above = adjust.above !== false && selected ? (selected.trackIndex ?? 0) + 1 : (adjust.trackIndex ?? 0);
    return Promise.resolve(window.loadScenes([{ name, html }], { toTimeline: true, at: state.time, trackIndex: above })).then(ids => {
      (ids || []).forEach(id => {
        const clip = state.clips.find(c => c.id === id);
        if (!clip) return;
        if (adjust.blend) clip.blend = adjust.blend;
        if (adjust.fit) clip.fitAnimationToClip = true;
      });
      if (ids?.length && (adjust.blend || adjust.fit)) window.refreshEditorAfterProjectChange?.({ mount: true, seek: true });
      return ids || [];
    });
  }

  async function addOverlay(id) {
    const ov = OVERLAYS.find(o => o[0] === id);
    if (!ov) return;
    const [, name, file, params, , adjust] = ov;
    try {
      const html = fillParams(await overlaySource(file), params);
      await insertHtml(name, html, adjust);
    } catch (err) {
      notify(`Não foi possível adicionar "${name}": ${err.message}`);
    }
  }

  // #region Catálogo do HyperFrames
  function loadCatalog(refresh = false) {
    if (S.loading) return S.loading;
    renderCatalog();
    S.loading = fetch(`/api/hyperframes/catalog${refresh ? '?refresh=1' : ''}`)
      .then(r => r.json().then(d => (r.ok ? d : Promise.reject(new Error(d.error || `HTTP ${r.status}`)))))
      .then(data => { S.catalog = data; S.error = null; })
      .catch(err => { S.error = err.message; })
      .finally(() => { S.loading = null; renderCatalog(); });
    return S.loading;
  }

  function filtered() {
    const q = S.query.trim().toLowerCase();
    return (S.catalog?.blocks || []).filter(b => {
      if (S.tag && !b.tags.includes(S.tag)) return false;
      if (!q) return true;
      return [b.name, b.title, b.description, ...b.tags].join(' ').toLowerCase().includes(q);
    });
  }

  function topTags() {
    const count = new Map();
    (S.catalog?.blocks || []).forEach(b => b.tags.forEach(t => count.set(t, (count.get(t) || 0) + 1)));
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([t]) => t);
  }

  function renderCatalog() {
    const host = document.querySelector('#tabBlocks .bk-catalog');
    if (!host) return;
    if (S.loading && !S.catalog) {
      host.innerHTML = '<div class="bk-status"><span class="bk-spin"></span>Carregando o catálogo do HyperFrames… (só na primeira vez)</div>';
      return;
    }
    if (S.error && !S.catalog) {
      host.innerHTML = `<div class="bk-status is-error">${esc(S.error)} <button type="button" class="bk-link" data-bk="retry">Tentar de novo</button></div>`;
      return;
    }
    if (!S.catalog) {
      host.innerHTML = '<button type="button" class="bk-load" data-bk="load">Carregar catálogo do HyperFrames</button>';
      return;
    }
    const list = filtered();
    const tags = topTags();
    host.innerHTML = `
      <div class="bk-tags">${['', ...tags].map(t => `<button type="button" class="bk-tag${S.tag === t ? ' is-on' : ''}" data-bk-tag="${esc(t)}">${t ? esc(t) : 'Todos'}</button>`).join('')}</div>
      <div class="bk-grid">${list.map(b => `
        <button type="button" class="bk-card" data-bk-hf="${esc(b.name)}" title="${esc(b.description)}">
          <span class="bk-thumb">${b.poster ? `<img loading="lazy" src="${esc(b.poster)}" alt="">` : ''}${b.video ? `<video muted loop playsinline preload="none" data-src="${esc(b.video)}"></video>` : ''}</span>
          <span class="bk-name">${esc(b.title)}</span>
          <span class="bk-meta">${b.duration ? `${b.duration}s` : ''}${b.width ? ` · ${b.width}×${b.height}` : ''}${b.warn ? ' · <span class="bk-warn" title="' + esc(b.warn) + '">experimental</span>' : ''}</span>
        </button>`).join('') || '<div class="bk-status">Nenhum bloco com esse filtro.</div>'}</div>
      <p class="bk-credit">Blocos do <a href="https://github.com/heygen-com/hyperframes" target="_blank" rel="noopener">HyperFrames</a> (HeyGen, Apache-2.0). Entram como clipe HTML editável — inclusive com a IA.</p>`;
  }

  async function importBlock(card) {
    const name = card.dataset.bkHf;
    if (card.classList.contains('is-busy')) return;
    card.classList.add('is-busy');
    try {
      const r = await fetch('/api/hyperframes/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      await insertHtml(data.title, data.html, { above: true });
    } catch (err) {
      notify(err.message);
    } finally {
      card.classList.remove('is-busy');
    }
  }
  // #endregion

  function build() {
    const tab = document.getElementById('tabBlocks');
    if (!tab || S.built) return;
    S.built = true;
    tab.innerHTML = `
      <p class="fx-tab-hint">Clique para pôr no playhead (acima do clip selecionado) e ajuste a caixa do clipe sobre o que quer destacar.</p>
      <div class="fx-section">Overlays</div>
      <div class="bk-grid is-small">${OVERLAYS.map(([id, name, , , icon]) => `
        <button type="button" class="bk-card is-overlay" data-bk-ov="${id}" draggable="false">
          <span class="bk-thumb">${icon}</span>
          <span class="bk-name">${esc(name)}</span>
        </button>`).join('')}</div>
      <div class="fx-section bk-hf-head">Catálogo HyperFrames
        <input type="search" class="bk-search" placeholder="Buscar blocos (chart, lower third, map…)" aria-label="Buscar blocos do HyperFrames">
      </div>
      <div class="bk-catalog"></div>`;
    renderCatalog();

    tab.addEventListener('click', e => {
      const ov = e.target.closest('[data-bk-ov]');
      if (ov) return addOverlay(ov.dataset.bkOv);
      const hf = e.target.closest('[data-bk-hf]');
      if (hf) return importBlock(hf);
      const tag = e.target.closest('[data-bk-tag]');
      if (tag) { S.tag = tag.dataset.bkTag; return renderCatalog(); }
      const act = e.target.closest('[data-bk]')?.dataset.bk;
      if (act === 'load' || act === 'retry') loadCatalog(act === 'retry');
    });
    tab.querySelector('.bk-search').addEventListener('input', e => {
      S.query = e.target.value;
      if (!S.catalog && !S.loading) loadCatalog();
      renderCatalog();
    });
    // Prévia em vídeo no hover (o vídeo só baixa quando passa o mouse)
    tab.addEventListener('mouseover', e => {
      const card = e.target.closest('.bk-card');
      const video = card?.querySelector('video[data-src]');
      if (!video || card.contains(e.relatedTarget)) return;
      if (!video.src) video.src = video.dataset.src;
      card.classList.add('is-playing');
      video.play().catch(() => {});
    });
    tab.addEventListener('mouseout', e => {
      const card = e.target.closest('.bk-card');
      if (!card || card.contains(e.relatedTarget)) return;
      card.classList.remove('is-playing');
      card.querySelector('video')?.pause();
    });
  }

  document.addEventListener('click', e => {
    if (e.target.closest('.ptab[data-tab="blocks"]')) {
      build();
      if (!S.catalog && !S.loading && !S.error) loadCatalog();
    }
  });

  window.MSBlocks = { addOverlay, insertHtml, loadCatalog, OVERLAYS };
})();
