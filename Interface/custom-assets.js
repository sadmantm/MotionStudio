'use strict';
// custom-assets.js
//
//  Efeitos, transições e textos criados pelo usuário (servidor: libs/custom-assets.js).
//  "+ Novo" nas abas Efeitos, Transições e Texto abre o modal: colar o HTML ou
//  gerar com IA (descrição + imagens/HTML de referência), com prévia ao vivo.
//  Tudo segue o contrato window.Motion dos clips:
//    efeito     → clip HTML de sobreposição esticado sobre o clip selecionado
//    transição  → clip HTML de sobreposição centrado no corte (clip anterior → selecionado)
//    texto      → template do TextRegistry, igual aos de text-templates/ ({{text}}, {{color}}…)

(() => {
  const API = '/api/custom-assets';
  const DRAG_CX = 'text/x-ms-cx';
  const st = () => window.__appState;
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? ''));
  const status = text => { const el = document.getElementById('mbStatus'); if (el) el.textContent = text; };

  const KIND = {
    effect:     { title: 'Novo efeito',    tab: 'tabEffects',     ptab: 'effects',     section: 'Meus efeitos' },
    transition: { title: 'Nova transição', tab: 'tabTransitions', ptab: 'transitions', section: 'Minhas transições' },
    text:       { title: 'Novo texto',     tab: 'tabtext',        ptab: 'text',        section: 'Meus textos' },
  };
  const TEXT_DEFAULTS = {
    text: 'Seu texto aqui',
    fontFamily: "'Montserrat', sans-serif",
    fontSize: 96,
    fontWeight: '900',
    color: '#ffffff',
    highlightColor: '#82ea00',
    align: 'center',
    bg: 'transparent',
    duration: 3,
  };
  const FRAMES = 12;

  const S = { items: [], frames: new Map(), thumbQueue: Promise.resolve() };

  const projectRes = () => st()?.project?.res || { w: 1080, h: 1920 };
  const sample = () => window.__fxSample || '';

  // #region Dados
  async function load() {
    try {
      const resp = await fetch(API, { cache: 'no-store' });
      S.items = resp.ok ? await resp.json() : [];
    } catch (_) {
      S.items = [];
    }
    syncTextRegistry();
    renderAll();
  }

  /** Textos do usuário entram no TextRegistry como os de text-templates/index.json */
  function syncTextRegistry() {
    const reg = window.__TextRegistry;
    if (!reg?.addSource) return;
    reg.getAll().filter(t => t.custom && !S.items.some(i => i.id === t.id)).forEach(t => reg.remove(t.id));
    S.items.filter(i => i.kind === 'text').forEach(i => {
      reg.addSource({
        id: i.id,
        name: i.name,
        desc: 'Criado por você',
        category: i.category,
        defaults: { ...TEXT_DEFAULTS, ...(i.defaults || {}) },
        custom: true,
      }, i.html);
    });
  }

  /** Template de texto com os padrões (prévia e miniatura) */
  function fillText(html, params) {
    const res = projectRes();
    const merged = { ...TEXT_DEFAULTS, ...params, w: res.w, h: res.h };
    return html.replace(/\{\{(\w+)\}\}/g, (_, key) => (merged[key] !== undefined ? String(merged[key]) : ''));
  }
  // #endregion

  // #region Abas da biblioteca
  function renderAll() {
    renderFxSection('effect');
    renderFxSection('transition');
    if (typeof window.renderTextPanel === 'function') window.renderTextPanel();
  }

  function newCard(kind) {
    return `
      <button class="cx-new" data-cx-new="${kind}" title="Colar um HTML ou gerar com IA">
        <span class="cx-new-plus">+</span>
        <span>${esc(KIND[kind].title)}</span>
      </button>`;
  }

  /** Seção "Meus efeitos" / "Minhas transições" no topo da aba (fx-panel monta o resto) */
  function renderFxSection(kind) {
    const tab = document.getElementById(KIND[kind].tab);
    if (!tab) return;
    let box = tab.querySelector(`.cx-section[data-kind="${kind}"]`);
    if (!box) {
      box = document.createElement('div');
      box.className = 'cx-section';
      box.dataset.kind = kind;
      const hint = tab.querySelector('.fx-tab-hint');
      if (hint) hint.after(box); else tab.prepend(box);
    }
    const items = S.items.filter(i => i.kind === kind);
    box.innerHTML = `
      <div class="fx-section">${esc(KIND[kind].section)}</div>
      <div class="fx-grid">
        ${newCard(kind)}
        ${items.map(item => `
          <div class="cx-card" draggable="true" data-cx-id="${esc(item.id)}"
            title="${esc(item.name)} — clique para aplicar no clip selecionado ou arraste até um clip">
            <span class="fx-card-view cx-view">
              <img class="cx-bg" src="${sample()}" alt="">
              <img class="cx-frame" alt="" hidden>
            </span>
            <span class="fx-card-name">${esc(item.name)}</span>
            <button class="cx-del" data-cx-del="${esc(item.id)}" title="Excluir da biblioteca">✕</button>
          </div>`).join('')}
      </div>`;
    items.forEach(item => loadFrames(item).then(() => paintStill(box.querySelector(`[data-cx-id="${CSS.escape(item.id)}"]`), item)));
  }

  /** Quadros da prévia: o servidor renderiza o HTML (fundo transparente) */
  function loadFrames(item) {
    const key = `${item.id}|${item.updatedAt || ''}`;
    if (S.frames.has(key)) return S.frames.get(key);
    const res = projectRes();
    const k = Math.min(1, 640 / Math.max(res.w, res.h));
    const w = Math.round(res.w * k), h = Math.round(res.h * k);
    const html = item.kind === 'text' ? fillText(item.html, item.defaults) : item.html;
    const d = Math.max(0.2, Number(item.duration) || 1);
    const times = Array.from({ length: FRAMES }, (_, i) => +((i + 0.5) * d / FRAMES).toFixed(3));
    // Um pedido por vez (o renderizador usa um Chromium só)
    const job = S.thumbQueue.then(async () => {
      const resp = await fetch('/api/thumbs/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, w, h, times, height: 160 }),
      });
      if (!resp.ok) return [];
      return (await resp.json()).frames || [];
    }).catch(() => []);
    S.thumbQueue = job;
    S.frames.set(key, job);
    return job;
  }

  async function framesOf(item) {
    return loadFrames(item);
  }

  /** Quadro parado: o meio (transição = quadro coberto; efeito = no auge) */
  async function paintStill(card, item) {
    if (!card) return;
    const frames = await framesOf(item);
    const img = card.querySelector('.cx-frame');
    if (!frames.length || !img) return;
    img.src = frames[Math.floor(frames.length * (item.kind === 'transition' ? 0.42 : 0.5))].url;
    img.hidden = false;
    card.querySelector('.cx-bg').classList.remove('cx-bg-b');
  }

  /** Hover: os quadros tocam em sequência no tempo real do HTML */
  async function startDemo(card, item) {
    stopDemo(card);
    const frames = await framesOf(item);
    if (!frames.length || !card.matches(':hover')) return;
    const img = card.querySelector('.cx-frame');
    const bg = card.querySelector('.cx-bg');
    const step = Math.max(40, (Number(item.duration) || 1) * 1000 / frames.length);
    let i = 0;
    card._timer = setInterval(() => {
      img.src = frames[i].url;
      img.hidden = false;
      // Transição: a cena de baixo troca no meio (A → B), como no corte real
      if (item.kind === 'transition') bg.classList.toggle('cx-bg-b', i >= frames.length / 2);
      i = (i + 1) % frames.length;
    }, step);
  }

  function stopDemo(card) {
    clearInterval(card._timer);
    card._timer = null;
  }

  function initTabs() {
    ['tabEffects', 'tabTransitions', 'tabtext'].forEach(id => {
      const tab = document.getElementById(id);
      if (!tab || tab._cxBound) return;
      tab._cxBound = true;
      tab.addEventListener('click', e => {
        const add = e.target.closest('[data-cx-new]');
        if (add) return openModal(add.dataset.cxNew);
        const del = e.target.closest('.cx-card [data-cx-del]');
        if (del) return removeItem(del.dataset.cxDel);
        const card = e.target.closest('.cx-card');
        if (card) applyItem(S.items.find(i => i.id === card.dataset.cxId), selectedTargets());
      });
      tab.addEventListener('mouseover', e => {
        const card = e.target.closest('.cx-card');
        if (card && !card.contains(e.relatedTarget)) startDemo(card, S.items.find(i => i.id === card.dataset.cxId));
      });
      tab.addEventListener('mouseout', e => {
        const card = e.target.closest('.cx-card');
        if (card && !card.contains(e.relatedTarget)) {
          stopDemo(card);
          paintStill(card, S.items.find(i => i.id === card.dataset.cxId));
        }
      });
      tab.addEventListener('dragstart', e => {
        const card = e.target.closest('.cx-card');
        if (!card) return;
        e.dataTransfer.setData(DRAG_CX, card.dataset.cxId);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });

    // Aba Texto: o texts.js refaz a aba inteira; o botão e o "excluir" voltam depois
    const original = window.renderTextPanel;
    if (typeof original === 'function' && !original._cx) {
      window.renderTextPanel = function () {
        original.apply(this, arguments);
        decorateTextTab();
      };
      window.renderTextPanel._cx = true;
    }
  }

  function decorateTextTab() {
    const tab = document.getElementById('tabtext');
    if (!tab || tab.querySelector('.cx-text-new')) return;
    const bar = document.createElement('div');
    bar.className = 'cx-text-new';
    bar.innerHTML = newCard('text');
    tab.prepend(bar);
    tab.querySelectorAll('.text-preview-card').forEach(card => {
      if (!S.items.some(i => i.id === card.dataset.tmplId)) return;
      const del = document.createElement('button');
      del.className = 'cx-del';
      del.dataset.cxDel = card.dataset.tmplId;
      del.title = 'Excluir da biblioteca';
      del.textContent = '✕';
      // O card de texto trata o clique (adiciona na timeline): o ✕ para aqui
      del.addEventListener('click', e => { e.stopPropagation(); removeItem(del.dataset.cxDel); });
      del.addEventListener('mousedown', e => e.stopPropagation());
      card.appendChild(del);
    });
  }

  async function removeItem(id) {
    const item = S.items.find(i => i.id === id);
    if (!item) return;
    const resp = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) return status('Não foi possível excluir');
    S.items = S.items.filter(i => i.id !== id);
    syncTextRegistry();
    renderAll();
    status(`"${item.name}" excluído da biblioteca`);
    // Sem pergunta: Desfazer recria o item (clips já colocados na timeline nunca saíram do projeto)
    window.MSUI.toast({
      message: `“${item.name}” excluído da biblioteca.`,
      kind: 'info',
      duration: 8000,
      action: {
        label: 'Desfazer',
        onClick: async () => {
          const back = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: item.kind, name: item.name, html: item.html, defaults: item.defaults }) });
          if (!back.ok) return window.MSUI.notify('Não foi possível restaurar.');
          await reload();
        },
      },
    });
  }
  // #endregion

  // #region Aplicar na timeline
  function selectedTargets() {
    const state = st();
    const ids = window.__selectedClipIds?.size ? [...window.__selectedClipIds] : (state?.currentClipId ? [state.currentClipId] : []);
    return ids
      .map(id => state.clips.find(c => c.id === id))
      .filter(c => c && state.templates.find(t => t.id === c.templateId)?.type !== 'audio');
  }

  function prevClipOf(clip) {
    return st().clips.find(o => o !== clip &&
      (Number(o.trackIndex) || 0) === (Number(clip.trackIndex) || 0) &&
      Math.abs(o.start + o.duration - clip.start) < 0.05);
  }

  /** Clip HTML de sobreposição (um template por clip, como nos clips HTML) */
  function addOverlay(item, { start, duration, above, stretch }) {
    const state = st();
    const sourceDuration = Math.max(0.1, Number(item.duration) || duration);
    const end = start + duration;
    const trackIndex = window.__findFreeTrack ? window.__findFreeTrack(start, end, above) : above;
    const template = {
      id: window.mkId(),
      name: item.name,
      type: 'html',
      html: item.html,
      sourceDuration,
      fps: window.extractFps?.(item.html) || state.project.fps,
      color: item.kind === 'transition' ? '#3aa0ff' : '#a06eff',
      inLibrary: false,
      customAssetId: item.id,
    };
    state.templates.push(template);
    const clip = {
      id: window.mkId(),
      templateId: template.id,
      label: item.name,
      start,
      duration,
      trimStart: 0,
      trimEnd: stretch ? sourceDuration : duration,
      fitAnimationToClip: Boolean(stretch),
      trackIndex,
      color: template.color,
    };
    state.clips.push(window.normalizeClip ? window.normalizeClip(clip) : clip);
    window.getTrack?.(trackIndex);
    return clip;
  }

  function applyItem(item, clips) {
    const state = st();
    if (!item || !state?.project) return;
    if (item.kind === 'text') return;   // textos entram pela aba Texto (TextRegistry)
    window.__tlPushUndo?.();
    const added = [];
    const track = c => Number(c.trackIndex) || 0;

    if (item.kind === 'effect') {
      if (clips.length) {
        // Cobre cada clip inteiro: a animação estica para a duração dele
        clips.forEach(c => added.push(addOverlay(item, { start: c.start, duration: c.duration, above: track(c) + 1, stretch: true })));
      } else {
        added.push(addOverlay(item, { start: state.time, duration: item.duration, above: 0, stretch: false }));
      }
    } else {
      const d = Math.max(0.1, Number(item.duration) || 1);
      // Centrada no corte: metade antes, metade depois do começo do clip
      const cuts = clips.length ? clips : [{ start: state.time, trackIndex: -1 }];
      cuts.forEach(c => {
        const prev = c.trackIndex >= 0 ? prevClipOf(c) : null;
        const above = Math.max(track(c), prev ? track(prev) : -1) + 1;
        added.push(addOverlay(item, { start: Math.max(0, c.start - d / 2), duration: d, above, stretch: false }));
      });
    }

    window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
    window.__syncCompositorToTime?.(state.time);
    status(item.kind === 'effect'
      ? `Efeito "${item.name}" ${clips.length ? `sobre ${clips.length} clip(s)` : 'no playhead'}`
      : `Transição "${item.name}" ${clips.length ? `em ${clips.length} corte(s)` : 'no playhead'}`);
    return added;
  }

  function initTimelineDrop() {
    const tracks = document.getElementById('tlTracks');
    if (!tracks) return;
    tracks.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes(DRAG_CX)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    tracks.addEventListener('drop', e => {
      if (!e.dataTransfer.types.includes(DRAG_CX)) return;
      e.preventDefault();
      e.stopPropagation();
      const item = S.items.find(i => i.id === e.dataTransfer.getData(DRAG_CX));
      const block = e.target.closest('.tl-block');
      const clip = block && st().clips.find(c => c.id === block.dataset.clipId);
      applyItem(item, clip && st().templates.find(t => t.id === clip.templateId)?.type !== 'audio' ? [clip] : []);
    });
  }
  // #endregion

  // #region Modal "Novo efeito / transição / texto"
  const M = { el: null, kind: 'effect', mode: 'paste', html: '', images: [], raf: null, frame: null, ready: false, abort: null, warnings: [] };
  const $m = sel => M.el.querySelector(sel);

  /** HTML base de efeito/transição (contrato window.Motion, fundo transparente) */
  function overlayBase(kind) {
    const { w, h } = projectRes();
    const fps = st()?.project?.fps || 30;
    const D = kind === 'transition' ? 1 : 4;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${kind === 'transition' ? 'Minha transição' : 'Meu efeito'}</title>
<style>
  html, body { width:${w}px; height:${h}px; margin:0; overflow:hidden; background:transparent; }
  #fx { position:absolute; inset:0; }
</style>
</head>
<body>
<div id="fx"></div>
<script>
  const CONFIG = { fps: ${fps}, durationInSeconds: ${D}, totalFrames: ${fps * D} };
  const el = document.getElementById('fx');
  function seek(t) {
    const p = Math.min(1, Math.max(0, t / CONFIG.durationInSeconds));
    // ${kind === 'transition' ? 'cobre o quadro no meio (p = 0.5) e revela de novo' : 'efeito por cima do vídeo, sem cobrir tudo'}
    ${kind === 'transition'
      ? "el.style.background = '#82ea00'; el.style.clipPath = `inset(0 ${(100 - Math.sin(p * Math.PI) * 100).toFixed(2)}% 0 0)`;"
      : "el.style.background = `radial-gradient(circle at ${30 + p * 40}% 40%, rgba(255,180,80,.45), transparent 60%)`; el.style.mixBlendMode = 'screen';"}
  }
  function renderFrame(frame) { seek(frame / CONFIG.fps); }
  function whenReady() { return Promise.resolve(); }
  window.Motion = { config: CONFIG, seek, renderFrame, whenReady };
  Motion.config = CONFIG;
  seek(0);
</script>
</body>
</html>`;
  }

  function buildModal() {
    if (M.el) return;
    const el = document.createElement('div');
    el.id = 'cxModal';
    el.className = 'modal-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="modal cx-modal" role="dialog" aria-labelledby="cxTitle">
        <div class="modal-header">
          <div class="modal-header-icon accent">+</div>
          <span id="cxTitle">Novo efeito</span>
          <button class="icon-btn" data-cx="close" aria-label="Fechar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="modal-body cx-body">
          <div class="cx-side">
            <div class="cx-seg" role="radiogroup" aria-label="Tipo">
              <button data-cx-kind="effect">Efeito</button>
              <button data-cx-kind="transition">Transição</button>
              <button data-cx-kind="text">Texto</button>
            </div>
            <p class="cx-kind-hint" id="cxKindHint"></p>
            <div class="form-group">
              <label for="cxName">Nome</label>
              <input id="cxName" class="prop-input full" maxlength="60" placeholder="Ex.: Light leak quente">
            </div>
            <div class="cx-tabs" role="tablist">
              <button data-cx-mode="ai" role="tab">✨ Gerar com IA</button>
              <button data-cx-mode="paste" role="tab">Colar HTML</button>
            </div>
            <div class="cx-pane" data-pane="ai">
              <textarea id="cxPrompt" class="prop-input full cx-prompt" rows="4"
                placeholder="Descreva como você quer. Ex.: vazamento de luz laranja e rosa entrando pela esquerda, com grão de filme leve"></textarea>
              <div class="cx-refs">
                <label class="cx-ref-add" title="Imagens de referência (prints, frames, moodboard)">
                  <input type="file" id="cxImages" accept="image/*" multiple hidden>
                  + Imagens de referência
                </label>
                <button class="cx-link" data-cx="use-clip" title="Usa o HTML do clip selecionado na timeline como referência">Usar clip selecionado</button>
              </div>
              <div class="cx-thumbs" id="cxThumbs"></div>
              <details class="cx-ref-html">
                <summary>Referência em HTML (opcional)</summary>
                <textarea id="cxRefHtml" class="prop-input full cx-code" rows="4" placeholder="Cole um HTML para a IA usar como referência de visual/técnica"></textarea>
              </details>
              <div class="cx-ai-row">
                <button class="export-btn" data-cx="generate">Gerar</button>
                <span class="cx-ai-status" id="cxAiStatus"></span>
              </div>
            </div>
            <div class="cx-pane" data-pane="paste">
              <textarea id="cxHtml" class="prop-input full cx-code" rows="12" spellcheck="false"
                placeholder="Cole aqui o HTML (contrato window.Motion: seek, renderFrame, whenReady, config)"></textarea>
              <div class="cx-paste-row">
                <button class="cx-link" data-cx="base">Inserir HTML base</button>
                <span class="cx-paste-hint" id="cxPasteHint"></span>
              </div>
            </div>
          </div>
          <div class="cx-preview-col">
            <div class="cx-stage" id="cxStage">
              <img class="cx-stage-bg" id="cxStageBg" alt="">
              <iframe id="cxFrame" sandbox="allow-scripts allow-same-origin" title="Prévia"></iframe>
              <div class="cx-stage-empty" id="cxStageEmpty">A prévia aparece aqui</div>
            </div>
            <div class="cx-transport">
              <button class="cx-play" data-cx="play" title="Play / pausa">❚❚</button>
              <input type="range" id="cxScrub" min="0" max="1000" value="0">
              <span class="cx-time" id="cxTime">0.0 s</span>
            </div>
            <input id="cxSampleText" class="prop-input full" placeholder="Texto de teste" hidden>
          </div>
        </div>
        <div class="modal-footer">
          <span class="cx-msg" id="cxMsg"></span>
          <button class="btn-secondary" data-cx="close">Cancelar</button>
          <button class="export-btn" data-cx="save">Salvar na biblioteca</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    M.el = el;

    el.addEventListener('click', e => {
      if (e.target === el) return closeModal();
      const kind = e.target.closest('[data-cx-kind]');
      if (kind) return setKind(kind.dataset.cxKind);
      const mode = e.target.closest('[data-cx-mode]');
      if (mode) return setMode(mode.dataset.cxMode);
      const rm = e.target.closest('[data-cx-rm]');
      if (rm) { M.images.splice(Number(rm.dataset.cxRm), 1); return renderThumbs(); }
      const action = e.target.closest('[data-cx]')?.dataset.cx;
      if (action === 'close') closeModal();
      if (action === 'generate') generate();
      if (action === 'save') save();
      if (action === 'base') insertBase();
      if (action === 'use-clip') useSelectedClip();
      if (action === 'play') togglePlay();
    });
    el.addEventListener('keydown', e => {
      e.stopPropagation();   // atalhos do editor não disparam enquanto digita
      if (e.key === 'Escape') closeModal();
    });
    $m('#cxHtml').addEventListener('input', () => {
      clearTimeout(M._typing);
      M._typing = setTimeout(() => loadPreview($m('#cxHtml').value), 500);
    });
    $m('#cxSampleText').addEventListener('input', () => {
      clearTimeout(M._typing);
      M._typing = setTimeout(() => loadPreview(M.html), 400);
    });
    $m('#cxImages').addEventListener('change', async e => {
      for (const file of [...e.target.files].slice(0, 4 - M.images.length)) {
        M.images.push(await shrinkImage(file));
      }
      e.target.value = '';
      renderThumbs();
    });
    $m('#cxScrub').addEventListener('input', e => {
      M.playing = false;
      $m('[data-cx="play"]').textContent = '▶';
      M.t = Number(e.target.value) / 1000 * duration();
      seekPreview(M.t);
    });
  }

  function openModal(kind = 'effect') {
    buildModal();
    M.el.hidden = false;
    M.el.style.display = 'flex';
    M.images = [];
    M.html = '';
    $m('#cxName').value = '';
    $m('#cxPrompt').value = '';
    $m('#cxRefHtml').value = '';
    $m('#cxHtml').value = '';
    msg('');
    aiStatus('');
    renderThumbs();
    setKind(kind);
    setMode('ai');
    loadPreview('');
    setTimeout(() => $m('#cxPrompt').focus(), 50);
  }

  function closeModal() {
    if (!M.el) return;
    M.abort?.abort();
    cancelAnimationFrame(M.raf);
    M.el.hidden = true;
    M.el.style.display = 'none';
    $m('#cxFrame').srcdoc = '';
  }

  const HINTS = {
    effect: 'Sobreposição com fundo transparente: cobre o clip selecionado inteiro (light leak, grão, partículas, glitch…).',
    transition: 'Sobreposição centrada no corte entre dois clips: transparente nas pontas e cobrindo o quadro no meio.',
    text: 'Template de texto como os da aba Texto: {{text}}, {{color}}, {{fontSize}}… são trocados pelo editor.',
  };

  function setKind(kind) {
    M.kind = kind;
    $m('#cxTitle').textContent = KIND[kind].title;
    $m('#cxKindHint').textContent = HINTS[kind];
    M.el.querySelectorAll('[data-cx-kind]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.cxKind === kind)));
    $m('#cxSampleText').hidden = kind !== 'text';
    $m('#cxPasteHint').textContent = kind === 'text' ? 'Base: text-templates/ia-base.html' : 'Contrato: templates/template-ia.html';
    loadPreview(M.html);
  }

  function setMode(mode) {
    M.mode = mode;
    M.el.querySelectorAll('[data-cx-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.cxMode === mode)));
    M.el.querySelectorAll('.cx-pane').forEach(p => { p.hidden = p.dataset.pane !== mode; });
    if (mode === 'paste' && M.html && !$m('#cxHtml').value) $m('#cxHtml').value = M.html;
  }

  function msg(text, kind = '') {
    const el = $m('#cxMsg');
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function aiStatus(text, isError = false) {
    const el = $m('#cxAiStatus');
    el.textContent = text;
    el.classList.toggle('is-error', isError);
  }

  async function insertBase() {
    let html = '';
    if (M.kind === 'text') {
      try { html = await (await fetch('text-templates/ia-base.html', { cache: 'no-cache' })).text(); } catch (_) { /* sem base */ }
    } else {
      html = overlayBase(M.kind);
    }
    if (!html) return msg('Não consegui carregar o HTML base.', 'error');
    $m('#cxHtml').value = html;
    loadPreview(html);
  }

  function useSelectedClip() {
    const clip = selectedTargets()[0];
    const tmpl = clip && st().templates.find(t => t.id === clip.templateId);
    if (!tmpl?.html) return aiStatus('Selecione um clip HTML ou de texto na timeline.', true);
    $m('#cxRefHtml').value = tmpl.html;
    $m('.cx-ref-html').open = true;
    aiStatus(`Referência: "${clip.label}"`);
  }

  /** Referência em imagem: até 1024 px, JPEG (o pedido para a IA fica leve) */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1024 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem inválida')); };
      img.src = url;
    });
  }

  function renderThumbs() {
    $m('#cxThumbs').innerHTML = M.images.map((src, i) => `
      <span class="cx-thumb"><img src="${src}" alt=""><button data-cx-rm="${i}" title="Remover">✕</button></span>`).join('');
  }
  // #endregion

  // #region Prévia ao vivo
  const duration = () => {
    const m = String(M.html).match(/durationInSeconds\s*:\s*([\d.]+)/);
    const lit = m ? Number(m[1]) : NaN;
    if (Number.isFinite(lit) && lit > 0) return lit;
    return M.kind === 'text' ? TEXT_DEFAULTS.duration : (M.kind === 'transition' ? 1 : 4);
  };

  function loadPreview(html) {
    M.html = html || '';
    cancelAnimationFrame(M.raf);
    M.ready = false;
    const frame = $m('#cxFrame');
    const res = projectRes();
    const stage = $m('#cxStage');
    // Palco no formato do projeto (vertical, quadrado, horizontal), até 340×380 px
    const k = Math.min(340 / res.w, 380 / res.h);
    stage.style.width = `${Math.round(res.w * k)}px`;
    stage.style.height = `${Math.round(res.h * k)}px`;
    frame.style.width = `${res.w}px`;
    frame.style.height = `${res.h}px`;
    frame.style.transform = `scale(${k})`;
    const bg = $m('#cxStageBg');
    bg.src = sample();
    bg.hidden = M.kind === 'text';
    $m('#cxStageEmpty').hidden = Boolean(M.html);
    if (!M.html) { frame.srcdoc = ''; return; }
    const doc = M.kind === 'text'
      ? fillText(M.html, { text: $m('#cxSampleText').value.trim() || TEXT_DEFAULTS.text })
      : M.html;
    frame.onload = async () => {
      try { await frame.contentWindow?.Motion?.whenReady?.(); } catch (_) { /* segue */ }
      M.ready = true;
      M.playing = true;
      M.t = 0;
      $m('[data-cx="play"]').textContent = '❚❚';
      M.last = performance.now();
      loop();
    };
    frame.srcdoc = doc;
  }

  function seekPreview(t) {
    const d = duration();
    try { $m('#cxFrame').contentWindow?.Motion?.seek(t); } catch (_) { /* HTML com erro */ }
    $m('#cxTime').textContent = `${t.toFixed(1)} / ${d.toFixed(1)} s`;
    $m('#cxScrub').value = String(Math.round(t / d * 1000));
    // Transição: a cena de baixo troca no meio (A → B)
    $m('#cxStageBg').classList.toggle('cx-bg-b', M.kind === 'transition' && t >= d / 2);
  }

  function loop() {
    if (!M.ready || M.el.hidden) return;
    const now = performance.now();
    if (M.playing) M.t = (M.t + (now - M.last) / 1000) % duration();
    M.last = now;
    seekPreview(M.t);
    M.raf = requestAnimationFrame(loop);
  }

  function togglePlay() {
    M.playing = !M.playing;
    M.last = performance.now();
    $m('[data-cx="play"]').textContent = M.playing ? '❚❚' : '▶';
  }
  // #endregion

  // #region IA e salvar
  async function streamNdjson(url, body, onEvent, signal) {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { code: data.code });
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    const handle = line => {
      if (!line.trim()) return;
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw Object.assign(new Error(ev.error), { code: ev.code });
      if (ev.type === 'done') done = ev;
      else onEvent(ev);
    };
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    handle(buf + decoder.decode());
    if (!done) throw new Error('A resposta terminou antes do fim.');
    return done;
  }

  async function generate() {
    const prompt = $m('#cxPrompt').value.trim();
    const refHtml = $m('#cxRefHtml').value.trim();
    if (!prompt && !M.images.length && !refHtml) {
      $m('#cxPrompt').focus();
      return aiStatus('Descreva o que você quer ou adicione uma referência.', true);
    }
    M.abort?.abort();
    M.abort = new AbortController();
    const button = $m('[data-cx="generate"]');
    button.disabled = true;
    aiStatus('Preparando…');
    try {
      const res = projectRes();
      const out = await streamNdjson('/api/ai/generate', {
        mode: 'create',
        prompt,
        name: $m('#cxName').value.trim(),
        project: { w: res.w, h: res.h, fps: st()?.project?.fps || 30 },
        asset: { kind: M.kind, references: { images: M.images, html: refHtml } },
      }, ev => {
        if (ev.type === 'status') aiStatus(ev.message);
        if (ev.type === 'progress') aiStatus(`Gerando… ${ev.chars.toLocaleString('pt-BR')} caracteres`);
      }, M.abort.signal);
      $m('#cxHtml').value = out.html;
      if (!$m('#cxName').value.trim() && out.name) $m('#cxName').value = out.name;
      M.warnings = out.warnings || [];
      loadPreview(out.html);
      aiStatus(`Pronto (${out.model}). Confira a prévia; dá para ajustar o código em "Colar HTML".`);
      button.textContent = 'Gerar de novo';
    } catch (err) {
      if (err.name !== 'AbortError') aiStatus(err.message || 'Falha ao gerar.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function save() {
    const html = ($m('#cxHtml').value || M.html).trim();
    const name = $m('#cxName').value.trim();
    if (!html) return msg('Gere com a IA ou cole um HTML primeiro.', 'error');
    if (!name) { $m('#cxName').focus(); return msg('Dê um nome.', 'error'); }
    const button = $m('[data-cx="save"]');
    button.disabled = true;
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: M.kind, name, html, defaults: M.kind === 'text' ? TEXT_DEFAULTS : undefined }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) return msg(data.error || `Erro ${resp.status}`, 'error');
      S.items = [...S.items.filter(i => i.id !== data.id), data];
      syncTextRegistry();
      renderAll();
      closeModal();
      document.querySelector(`.ptab[data-tab="${KIND[data.kind].ptab}"]`)?.click();
      status(`"${data.name}" salvo em ${KIND[data.kind].section}${data.warnings?.length ? ` · avisos: ${data.warnings.join('; ')}` : ''}`);
    } catch (err) {
      msg(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }
  // #endregion

  function boot() {
    initTabs();
    initTimelineDrop();
    // Abas de efeitos/transições são montadas pelo fx-panel no boot; textos pelo TextRegistry
    setTimeout(load, 0);
  }

  window.MSCustomAssets = { open: openModal, reload: load, apply: (id, clips) => applyItem(S.items.find(i => i.id === id), clips || selectedTargets()), items: () => S.items };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
