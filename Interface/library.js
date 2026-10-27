'use strict';
// library.js
//
//  Biblioteca do projeto (painel esquerdo, aba Mídia): os ASSETS importados —
//  vídeo, áudio, imagem e HTML (tratado como vídeo) —, não os clips da
//  timeline. Um asset pode ter vários clips. Recursos:
//    • pôster + scrub no hover (quadros que timeline-pro.js já gera)
//    • filtros por tipo e busca
//    • clique duplo / "+" → entra no playhead; arrastar → entra onde soltar
//  Também trata o "soltar na timeline" de assets, templates de texto e
//  arquivos do sistema, com uma sombra mostrando onde o clip vai entrar.

(() => {
  const FILTERS = [
    ['all',   'Tudo'],
    ['video', 'Vídeo'],
    ['html',  'Animação'],
    ['audio', 'Áudio'],
    ['image', 'Imagem'],
  ];
  const TYPE_LABEL = { video: 'Vídeo', html: 'Animação HTML', audio: 'Áudio', image: 'Imagem' };
  const TYPE_ICON = {
    video: '<path d="M15 10l5-3v10l-5-3z"/><rect x="2" y="6" width="13" height="12" rx="2"/>',
    html:  '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  };
  const DRAG_ASSET = 'text/x-ms-asset';
  const DRAG_TEXT  = 'text/x-mstudio-tmpl';

  const S = {
    filter: 'all',
    selected: null,
    cards: new Map(),   // templateId → elemento do card
    drag: null,         // { kind: 'asset'|'text'|'files', id?, duration }
    audio: null,        // <audio> da prévia
    playingId: null,
    ghost: null,
  };

  const st  = () => window.__appState;
  const $id = id => document.getElementById(id);
  const esc = v => escapeHtml(v);

  // Importados, gravações, áudio extraído e clipes de IA avulsos. Cópias de
  // clips (corte/colagem), cenas de IA em lote e efeitos sonoros ficam fora.
  const isAsset = t => Boolean(t?.inLibrary) && t.type !== 'text';

  function fmtDur(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const m = Math.floor(s / 60);
    return s < 60 ? `${s.toFixed(1)}s` : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  /** Muda quando a fonte muda (HTML editado, mídia trocada) → card refeito */
  function srcKey(t) {
    return t.type === 'html'
      ? `${t.html?.length}|${t.html?.slice(0, 40)}|${t.html?.slice(-40)}`
      : (t.dataUrl || t.objectUrl || '');
  }

  /** templateId do asset → nº de clips (clips de cópias contam para o original) */
  function usageMap() {
    const state = st();
    const owner = new Map(state.templates.map(t => [t.id, t.libraryId || t.id]));
    const map = new Map();
    state.clips.forEach(c => {
      const id = owner.get(c.templateId) || c.templateId;
      map.set(id, (map.get(id) || 0) + 1);
    });
    return map;
  }

  /** Clips que usam o asset (inclusive as cópias de corte/colagem) */
  function clipsOf(id) {
    const state = st();
    const ids = new Set(state.templates.filter(t => t.id === id || t.libraryId === id).map(t => t.id));
    return state.clips.filter(c => ids.has(c.templateId));
  }

  // #region Render
  function ensureChrome() {
    const tab = $id('tabMedia');
    if (!tab || tab.dataset.lib === '1') return;
    tab.dataset.lib = '1';
    tab.innerHTML = `
      <div class="lib-toolbar">
        <button class="lib-import" id="btnAddMedia" title="Importar vídeo, áudio, imagem ou HTML (Ctrl+I)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>
          Importar
        </button>
        <button class="lib-icon-btn" data-action="record-voice" title="Gravar voz">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v4"/></svg>
        </button>
      </div>
      <div class="lib-search-wrap">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input class="lib-search" id="mediaSearch" placeholder="Buscar na biblioteca…" autocomplete="off">
      </div>
      <div class="lib-filters" role="tablist">
        ${FILTERS.map(([id, label]) => `<button class="lib-filter${id === 'all' ? ' is-active' : ''}" data-filter="${id}" role="tab">${label}<span class="lib-count"></span></button>`).join('')}
      </div>
      <div id="mediaGrid" class="lib-grid"></div>
      <div id="mediaEmpty" class="lib-empty">
        <div class="lib-drop">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
          <p>Arraste arquivos para cá</p>
          <small>Vídeo, áudio, imagem ou HTML</small>
          <button class="lib-empty-btn" data-lib="import">Importar mídia</button>
        </div>
      </div>
      <div class="lib-none" id="libNone" hidden>Nada com esse filtro.</div>`;

    tab.querySelector('#btnAddMedia').addEventListener('click', () => $id('fileInput').click());
    tab.querySelector('[data-lib="import"]').addEventListener('click', () => $id('fileInput').click());
    tab.querySelector('#mediaSearch').addEventListener('input', render);
    tab.querySelector('.lib-filters').addEventListener('click', e => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      S.filter = btn.dataset.filter;
      tab.querySelectorAll('.lib-filter').forEach(b => b.classList.toggle('is-active', b === btn));
      render();
    });
    const grid = tab.querySelector('#mediaGrid');
    grid.addEventListener('click', onGridClick);
    grid.addEventListener('dblclick', e => {
      const card = e.target.closest('.lib-card');
      if (card) addToTimeline(card.dataset.id);
    });
    grid.addEventListener('contextmenu', e => {
      const card = e.target.closest('.lib-card');
      if (!card) return;
      e.preventDefault();
      select(card.dataset.id);
      openMenu(card.dataset.id, e.clientX, e.clientY);
    });
    // Soltar arquivos do sistema na biblioteca = importar (sem ir para a timeline)
    tab.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      tab.classList.add('is-dropping');
    });
    tab.addEventListener('dragleave', e => { if (!tab.contains(e.relatedTarget)) tab.classList.remove('is-dropping'); });
    tab.addEventListener('drop', e => {
      tab.classList.remove('is-dropping');
      if (!e.dataTransfer.files.length || !st()?.project) return;
      e.preventDefault();
      e.stopPropagation();
      handleMediaFiles(e.dataTransfer.files);
    });
  }

  function render() {
    ensureChrome();
    const grid = $id('mediaGrid');
    const empty = $id('mediaEmpty');
    if (!grid) return;
    const state = st();
    const all = state?.project ? state.templates.filter(isAsset) : [];

    // Proporção do pôster acompanha o projeto (vertical / paisagem), com limites
    const res = state?.project?.res || { w: 16, h: 10 };
    const ratio = Math.min(16 / 9, Math.max(3 / 4, res.w / res.h));
    grid.style.setProperty('--lib-ratio', String(ratio));

    const q = ($id('mediaSearch')?.value || '').trim().toLowerCase();
    const list = all.filter(t =>
      (S.filter === 'all' || t.type === S.filter) &&
      (!q || String(t.name || '').toLowerCase().includes(q)));

    document.querySelectorAll('.lib-filter').forEach(btn => {
      const n = btn.dataset.filter === 'all' ? all.length : all.filter(t => t.type === btn.dataset.filter).length;
      btn.querySelector('.lib-count').textContent = n ? ` ${n}` : '';
      btn.hidden = btn.dataset.filter !== 'all' && !n;
    });
    if (S.filter !== 'all' && !all.some(t => t.type === S.filter)) {
      S.filter = 'all';
      document.querySelectorAll('.lib-filter').forEach(b => b.classList.toggle('is-active', b.dataset.filter === 'all'));
      return render();
    }

    empty.hidden = all.length > 0;
    $id('libNone').hidden = !(all.length && !list.length);

    const used = usageMap();
    const keep = new Set();
    list.forEach(t => {
      let card = S.cards.get(t.id);
      if (card && card.dataset.src !== srcKey(t)) { card.remove(); card = null; }
      if (!card) {
        card = buildCard(t);
        S.cards.set(t.id, card);
      }
      updateCard(card, t, used.get(t.id) || 0);
      grid.appendChild(card);   // reordena sem recriar
      keep.add(t.id);
    });
    S.cards.forEach((card, id) => {
      if (keep.has(id)) return;
      card.remove();
      if (!state?.templates.some(t => t.id === id)) S.cards.delete(id);
    });
  }

  function buildCard(t) {
    const card = document.createElement('div');
    card.className = `lib-card lib-${t.type}`;
    card.dataset.id = t.id;
    card.dataset.src = srcKey(t);
    card.draggable = true;
    card.innerHTML = `
      <div class="lib-thumb">
        ${t.type === 'audio' ? '<canvas class="lib-wave"></canvas>' : '<img class="lib-poster" alt="" decoding="async">'}
        <span class="lib-type" title="${TYPE_LABEL[t.type]}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">${TYPE_ICON[t.type]}</svg></span>
        <span class="lib-dur"></span>
        <span class="lib-used" title="Clips desta mídia na timeline"></span>
        ${t.type === 'audio' ? '<button class="lib-play" data-lib="play" title="Ouvir"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg></button>' : ''}
        <button class="lib-add" data-lib="add" title="Adicionar no playhead (clique duplo)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <div class="lib-scrub"></div>
      </div>
      <div class="lib-name"></div>`;

    const thumb = card.querySelector('.lib-thumb');
    if (t.type === 'image') {
      card.querySelector('.lib-poster').src = t.dataUrl || t.objectUrl;
    } else if (t.type === 'audio') {
      requestAnimationFrame(() => window.__paintAudioThumb?.(card.querySelector('.lib-wave'), t));
    } else {
      thumb.classList.add('is-loading');
      // Quadros: os mesmos da filmstrip da timeline (vídeo no navegador, HTML no servidor)
      window.__whenMediaInfo?.(t, info => info.thumbs.length > 1 || info.thumbsDone, info => {
        thumb.classList.remove('is-loading');
        card._frames = info.thumbs;
        setPoster(card);
      });
      thumb.addEventListener('mousemove', e => scrub(card, e));
      thumb.addEventListener('mouseleave', () => { setPoster(card); thumb.classList.remove('is-scrubbing'); });
    }

    card.addEventListener('dragstart', e => {
      const tmpl = st().templates.find(x => x.id === t.id);
      S.drag = { kind: 'asset', id: t.id, duration: clipDuration(tmpl) };
      e.dataTransfer.setData(DRAG_ASSET, t.id);
      e.dataTransfer.effectAllowed = 'copy';
      const img = card.querySelector('.lib-poster');
      if (img?.naturalWidth) e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    });
    card.addEventListener('dragend', endDrag);
    return card;
  }

  function updateCard(card, t, uses) {
    card.querySelector('.lib-name').textContent = t.name || TYPE_LABEL[t.type];
    card.title = `${t.name}\n${TYPE_LABEL[t.type]}${t.res ? ` · ${t.res.w}×${t.res.h}` : ''}${uses ? `\nNa timeline: ${uses} clip(s)` : ''}`;
    card.querySelector('.lib-dur').textContent = t.type === 'image' ? '' : fmtDur(t.sourceDuration);
    const usedEl = card.querySelector('.lib-used');
    usedEl.textContent = uses > 1 ? `✓ ${uses}` : '✓';
    usedEl.hidden = !uses;
    card.classList.toggle('is-selected', S.selected === t.id);
  }

  /** Quadro de ~1/4 da duração: evita tela preta de abertura */
  function setPoster(card) {
    const frames = card._frames;
    const img = card.querySelector('.lib-poster');
    if (!img || !frames?.length) return;
    img.src = frames[Math.min(frames.length - 1, Math.floor(frames.length / 4))].url;
    card.querySelector('.lib-scrub').style.opacity = '0';
  }

  function scrub(card, e) {
    const frames = card._frames;
    if (!frames?.length) return;
    const thumb = card.querySelector('.lib-thumb');
    const rect = thumb.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const frame = frames[Math.min(frames.length - 1, Math.floor(ratio * frames.length))];
    card.querySelector('.lib-poster').src = frame.url;
    const line = card.querySelector('.lib-scrub');
    line.style.left = `${ratio * 100}%`;
    line.style.opacity = '1';
    thumb.classList.add('is-scrubbing');
  }
  // #endregion

  // #region Ações
  function onGridClick(e) {
    const card = e.target.closest('.lib-card');
    if (!card) return;
    const btn = e.target.closest('[data-lib]');
    if (btn?.dataset.lib === 'add') { e.stopPropagation(); return addToTimeline(card.dataset.id); }
    if (btn?.dataset.lib === 'play') { e.stopPropagation(); return togglePlay(card.dataset.id); }
    select(card.dataset.id);
  }

  function select(id) {
    S.selected = id;
    S.cards.forEach((card, cid) => card.classList.toggle('is-selected', cid === id));
  }

  function clipDuration(tmpl) {
    if (!tmpl) return 5;
    return tmpl.type === 'image' ? projectImageDuration() : Math.max(MIN_CLIP_DURATION, Number(tmpl.sourceDuration) || 5);
  }

  /** No playhead, na primeira track livre (vídeo/HTML acima do que já está no trecho) */
  function addToTimeline(id, at = st().time, trackIndex = null, undo = true) {
    const ids = addTemplatesToTimeline([id], { at, trackIndex, undo });
    if (ids.length) {
      selectClip(ids[0]);
      const status = $id('mbStatus');
      if (status) status.textContent = 'Clip adicionado à timeline';
    }
  }

  function togglePlay(id) {
    const tmpl = st().templates.find(t => t.id === id);
    if (!tmpl) return;
    if (!S.audio) {
      S.audio = new Audio();
      S.audio.addEventListener('ended', () => setPlaying(null));
    }
    if (S.playingId === id) { S.audio.pause(); return setPlaying(null); }
    S.audio.src = tmpl.dataUrl || tmpl.objectUrl;
    S.audio.currentTime = 0;
    S.audio.play().catch(() => setPlaying(null));
    setPlaying(id);
  }

  function setPlaying(id) {
    S.playingId = id;
    S.cards.forEach((card, cid) => card.classList.toggle('is-playing', cid === id));
  }

  function removeAsset(id) {
    const state = st();
    const tmpl = state.templates.find(t => t.id === id);
    if (!tmpl) return;
    const clipIds = clipsOf(id).map(c => c.id);
    if (S.playingId === id) { S.audio.pause(); setPlaying(null); }
    window.__tlPushUndo?.();
    if (clipIds.length) {
      removeClipsById(clipIds);
      afterClipsRemoved();
    }
    // Com clips, o undo recria o asset (o snapshot guarda o template); sem, sai de vez
    const index = state.templates.findIndex(t => t.id === id);
    if (index >= 0) state.templates.splice(index, 1);
    S.cards.get(id)?.remove();
    S.cards.delete(id);
    render();
    // Sem pergunta: o aviso oferece Desfazer (com clips, o undo da timeline; sem, o asset volta no lugar)
    window.MSUI.toast({
      message: clipIds.length ? `“${tmpl.name}” e ${clipIds.length} clip(s) removidos.` : `“${tmpl.name}” removido da biblioteca.`,
      kind: 'info',
      duration: 8000,
      action: {
        label: 'Desfazer',
        onClick: () => {
          if (clipIds.length) { window.__tlUndo?.(); return; }
          if (!state.templates.some(t => t.id === id)) state.templates.splice(Math.min(index, state.templates.length), 0, tmpl);
          render();
        },
      },
    });
  }

  async function renameAsset(id) {
    const tmpl = st().templates.find(t => t.id === id);
    if (!tmpl) return;
    const name = await window.MSUI.prompt({ title: 'Renomear na biblioteca', label: 'Nome', value: tmpl.name, confirmLabel: 'Renomear' });
    if (!name?.trim()) return;
    tmpl.name = name.trim();
    render();
  }

  function selectClipsOf(id) {
    const ids = clipsOf(id).map(c => c.id);
    if (!ids.length) return;
    selectClip(ids[0]);
    ids.slice(1).forEach(cid => selectClip(cid, true));
    const first = st().clips.find(c => c.id === ids[0]);
    window.seekTo?.(first.start);
  }

  function openMenu(id, x, y) {
    let menu = $id('libMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'libMenu';
      menu.className = 'ctx-menu lib-menu';
      document.body.appendChild(menu);
      menu.addEventListener('click', e => {
        const item = e.target.closest('[data-act]');
        if (!item) return;
        menu.style.display = 'none';
        const tid = menu.dataset.id;
        if (item.dataset.act === 'add') addToTimeline(tid);
        if (item.dataset.act === 'rename') renameAsset(tid);
        if (item.dataset.act === 'clips') selectClipsOf(tid);
        if (item.dataset.act === 'remove') removeAsset(tid);
      });
      document.addEventListener('mousedown', e => { if (!menu.contains(e.target)) menu.style.display = 'none'; });
    }
    const uses = usageMap().get(id) || 0;
    menu.dataset.id = id;
    menu.innerHTML = `
      <div class="ctx-item" data-act="add">Adicionar no playhead</div>
      <div class="ctx-item" data-act="rename">Renomear</div>
      ${uses ? `<div class="ctx-item" data-act="clips">Selecionar ${uses} clip(s) na timeline</div>` : ''}
      <div class="ctx-divider"></div>
      <div class="ctx-item ctx-danger" data-act="remove">Remover da biblioteca</div>`;
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  }
  // #endregion

  // #region Soltar na timeline
  /** Tempo/track sob o cursor; track = null + newTrack na faixa abaixo da última */
  function dropTarget(e, duration) {
    const state = st();
    const rect = tlTracks.getBoundingClientRect();
    const pxPerSec = PX_PER_SEC * state.zoom;
    const rowH = trackRowHeight();
    const tracks = getTrackIndexes();
    let t = Math.max(0, (e.clientX - rect.left) / pxPerSec);
    if (typeof snapTimeInfo === 'function') t = snapTimeInfo(t).time;
    const row = Math.floor((e.clientY - rect.top) / rowH);
    const newTrack = row >= tracks.length;
    const hovered = newTrack ? null : tracks[Math.max(0, row)];
    // Onde vai entrar de fato: a track sob o cursor se estiver livre, senão a próxima livre acima
    const resolved = newTrack ? null : findFreeTrack(t, t + duration, hovered);
    return { t, hovered, resolved, newTrack, rowH, pxPerSec, tracks };
  }

  function showGhost(target, duration, label) {
    if (!S.ghost) {
      S.ghost = document.createElement('div');
      S.ghost.className = 'lib-ghost';
      S.ghost.innerHTML = '<span></span>';
    }
    if (S.ghost.parentElement !== tlTracks) tlTracks.appendChild(S.ghost);
    const rowIdx = target.newTrack ? target.tracks.length : target.tracks.indexOf(target.resolved);
    const above = rowIdx < 0;   // a track livre ainda não existe: entra uma nova no topo
    S.ghost.classList.toggle('is-new', target.newTrack || above);
    S.ghost.style.left = `${target.t * target.pxPerSec}px`;
    S.ghost.style.width = `${Math.max(6, duration * target.pxPerSec)}px`;
    S.ghost.style.top = `${(above ? 0 : rowIdx) * target.rowH}px`;
    S.ghost.style.height = `${target.rowH}px`;
    S.ghost.querySelector('span').textContent = `${label} · ${fmtTime(target.t)}${target.newTrack ? ' · nova track' : ''}`;
    S.ghost.hidden = false;
    showSnapGuide?.(target.t * target.pxPerSec);
  }

  function hideGhost() {
    if (S.ghost) S.ghost.hidden = true;
    hideSnapGuide?.();
  }

  function endDrag() {
    S.drag = null;
    hideGhost();
  }

  function dragInfo(e) {
    const types = e.dataTransfer.types;
    if (S.drag) return S.drag;
    if (types.includes(DRAG_TEXT)) return { kind: 'text', duration: 4 };
    if (types.includes('Files')) return { kind: 'files', duration: 5 };
    return null;
  }

  function initTimelineDrop() {
    const area = $id('tlScroll');
    if (!area) return;

    area.addEventListener('dragover', e => {
      if (!st()?.project) return;
      const info = dragInfo(e);
      if (!info) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const label = info.kind === 'asset'
        ? (st().templates.find(t => t.id === info.id)?.name || 'Mídia')
        : info.kind === 'text' ? 'Texto' : 'Arquivo';
      showGhost(dropTarget(e, info.duration), info.duration, label);
    });

    area.addEventListener('dragleave', e => { if (!area.contains(e.relatedTarget)) hideGhost(); });

    area.addEventListener('drop', e => {
      const info = dragInfo(e);
      if (!info || !st()?.project) return;
      e.preventDefault();
      e.stopPropagation();   // o drop do documento importaria só para a biblioteca
      const target = dropTarget(e, info.duration);
      endDrag();

      // Um passo de undo só, tirado antes de abrir a track (que renumera as outras)
      window.__tlPushUndo?.();
      let trackIndex = target.resolved;
      if (target.newTrack) {
        insertTrackAt(0);   // faixa abaixo da última → track nova embaixo
        trackIndex = 0;
      }

      if (info.kind === 'asset') {
        const id = e.dataTransfer.getData(DRAG_ASSET) || info.id;
        return addToTimeline(id, target.t, trackIndex, false);
      }
      if (info.kind === 'text') {
        const tmpl = window.__TextRegistry?.getById(e.dataTransfer.getData(DRAG_TEXT));
        if (tmpl) addTextClipFromTemplate(tmpl, { at: target.t, trackIndex, undo: false });
        return;
      }
      if (e.dataTransfer.files.length) {
        handleMediaFiles(e.dataTransfer.files, { toTimeline: true, at: target.t, trackIndex });
      }
    });

    document.addEventListener('dragend', endDrag);
  }
  // #endregion

  function boot() {
    ensureChrome();
    initTimelineDrop();
    // Botões "Gravar voz" espalhados pela UI (biblioteca, estado vazio)
    document.addEventListener('click', e => {
      if (e.target.closest('[data-action="record-voice"]')) window.MSVoice?.open();
    });
    render();
  }

  window.MSLibrary = { render, addToTimeline, remove: removeAsset, setTextDrag: info => { S.drag = info; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
