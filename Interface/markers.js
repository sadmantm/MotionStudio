'use strict';
// markers.js
//
//  Marcadores e regiões na timeline:
//    • M cria um marcador na agulha (duplo clique na régua também). Bandeirinha colorida na
//      régua + linha pela timeline; clicar vai até ele, arrastar move, duplo clique renomeia,
//      botão direito: renomear, cor, excluir. Marcadores têm snap (clips e agulha encostam neles).
//    • I / O marcam o início e o fim de uma região de trabalho (faixa translúcida na régua e
//      nas tracks). "Remover região e fechar o espaço" corta todas as tracks nas bordas, apaga o
//      miolo e puxa o resto para a esquerda; "Criar região do clip" usa o clip selecionado.
//    • Lista (botão 🚩 da barra da timeline) para pular entre marcadores; Shift+↑/↓ pulam para o
//      anterior/próximo; os marcadores aparecem também na paleta de comandos (Ctrl+K).
//  Dado: state.markers = [{ id, t, end?, label, color, work? }] (end = região). Salva com o
//  projeto (editor.markers) e entra no histórico de desfazer (snapshot da timeline).

(() => {
  const st = () => window.__appState;
  const COLORS = ['#ff5d6c', '#ffb02e', '#82ea00', '#22d3ee', '#a78bfa', '#f472b6'];
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const fmt = t => (window.fmtTime ? window.fmtTime(t) : `${Number(t).toFixed(2)}s`);
  const pps = () => (window.__PX_PER_SEC || 80) * (st().zoom || 1);
  const fps = () => st().project?.fps || 30;
  const snapT = t => Math.max(0, Math.round(t * fps()) / fps());
  const newId = () => 'mk_' + Math.random().toString(36).slice(2, 9);

  const list = () => (st().markers ||= []);
  const sorted = () => [...list()].sort((a, b) => a.t - b.t);
  const byId = id => list().find(m => m.id === id);
  const pushUndo = () => window.__tlPushUndo?.();

  // #region Dados
  function add({ t = st().time, label, end = null, color, work = false } = {}) {
    const n = list().filter(m => !m.work).length + 1;
    const m = {
      id: work ? 'work' : newId(),
      t: snapT(t),
      ...(end != null ? { end: snapT(end) } : {}),
      label: label || (work ? 'Região' : end != null ? `Região ${n}` : `Marcador ${n}`),
      color: color || (work ? '#3aa0ff' : COLORS[(n - 1) % COLORS.length]),
      ...(work ? { work: true } : {}),
    };
    list().push(m);
    return m;
  }

  function remove(id) {
    const i = list().findIndex(m => m.id === id);
    if (i >= 0) list().splice(i, 1);
  }

  /** Marcadores (e bordas de região) para o snap da timeline */
  const times = () => list().flatMap(m => [m.t, m.end].filter(Number.isFinite));

  /** Vai para o marcador anterior (-1) ou seguinte (+1) à agulha */
  function jump(dir) {
    const t = st().time;
    const pts = [...new Set(times().map(x => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
    const target = dir > 0 ? pts.find(x => x > t + 0.001) : [...pts].reverse().find(x => x < t - 0.001);
    if (target == null) return window.MSUI?.toast({ message: dir > 0 ? 'Não há marcador depois da agulha.' : 'Não há marcador antes da agulha.', kind: 'info', duration: 2200 });
    window.seekTo?.(target);
  }

  // ── Região de trabalho (I / O) ──
  const work = () => list().find(m => m.work);
  function setIn(t = st().time) {
    pushUndo();
    const w = work();
    const T = snapT(t);
    if (w) { w.t = T; if (w.end == null || w.end <= T) w.end = Math.min(st().project?.totalDuration || T + 1, T + 1); }
    else add({ t: T, end: Math.max(T + 1, st().project?.totalDuration || 0), work: true });
    render();
  }
  function setOut(t = st().time) {
    pushUndo();
    const w = work();
    const T = snapT(t);
    if (w) { w.end = T; if (w.t >= T) w.t = Math.max(0, T - 1); }
    else add({ t: 0, end: T, work: true });
    render();
  }
  function clearWork() {
    if (!work()) return;
    pushUndo();
    remove('work');
    render();
  }

  /** Região a partir do clip selecionado */
  function regionFromSelection() {
    const sel = [...(window.__selectedClipIds || [])].map(id => st().clips.find(c => c.id === id)).filter(Boolean);
    if (!sel.length) return window.MSUI?.toast({ message: 'Selecione um clip para criar a região.', kind: 'info' });
    const a = Math.min(...sel.map(c => c.start));
    const b = Math.max(...sel.map(c => c.start + c.duration));
    pushUndo();
    remove('work');
    add({ t: a, end: b, work: true });
    render();
  }

  /** Remove a região de trabalho em todas as tracks e fecha o espaço (ripple) */
  function rippleRemoveRegion() {
    const w = work();
    if (!w || !(w.end > w.t)) return window.MSUI?.toast({ message: 'Marque uma região com I e O primeiro.', kind: 'info' });
    const a = w.t, b = w.end, len = b - a;
    const MIN = typeof MIN_CLIP_DURATION === 'number' ? MIN_CLIP_DURATION : 0.1;
    const locked = c => (typeof isClipLocked === 'function' ? isClipLocked(c) : false);
    pushUndo();
    [b, a].forEach(T => st().clips.slice().forEach(c => {
      if (!locked(c) && T > c.start + MIN && T < c.start + c.duration - MIN) splitClipAt(c, T);
    }));
    const inside = st().clips.filter(c => !locked(c) && c.start >= a - 1e-3 && c.start + c.duration <= b + 1e-3).map(c => c.id);
    removeClipsById(inside);
    st().clips.forEach(c => { if (!locked(c) && c.start >= b - 1e-3) c.start = Math.max(0, c.start - len); });
    // Marcadores depois da região acompanham; os de dentro saem
    st().markers = list().filter(m => !m.work && !(m.t >= a && m.t < b)).map(m => (m.t >= b ? { ...m, t: m.t - len, ...(m.end != null ? { end: m.end - len } : {}) } : m));
    afterClipsRemoved();
    render();
    window.MSUI?.toast({ message: `Região de ${fmt(len)} removida; o espaço foi fechado.`, kind: 'ok', action: { label: 'Desfazer', onClick: () => window.__tlUndo?.() } });
  }
  // #endregion

  // #region Desenho
  let layer = null;
  function ensureLayer() {
    const scroll = document.getElementById('tlScroll');
    if (!scroll) return null;
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.id = 'tlMarkers';
      scroll.appendChild(layer);
    }
    return layer;
  }

  function render() {
    const el = ensureLayer();
    if (!el || !st().project) { if (el) el.innerHTML = ''; return; }
    const tracksH = document.getElementById('tlTracks')?.scrollHeight || 0;
    const rulerH = document.getElementById('tlRuler')?.offsetHeight || 26;
    el.style.width = (document.getElementById('tlRuler')?.style.width || '100%');
    const k = pps();
    el.innerHTML = sorted().map(m => {
      const x = m.t * k;
      if (m.end != null) {
        const w = Math.max(2, (m.end - m.t) * k);
        return `<div class="tl-mk-region${m.work ? ' is-work' : ''}" data-id="${m.id}" style="left:${x}px;width:${w}px;--mk:${m.color}">
          <div class="tl-mk-band" style="height:${tracksH}px"></div>
          <div class="tl-mk-rbar" title="${esc(m.label)} · ${fmt(m.t)} → ${fmt(m.end)} (${fmt(m.end - m.t)})">
            <span class="tl-mk-h tl-mk-h-l" data-h="start" title="Arraste o início"></span>
            <span class="tl-mk-rlabel">${esc(m.label)}</span>
            <span class="tl-mk-h tl-mk-h-r" data-h="end" title="Arraste o fim"></span>
          </div>
        </div>`;
      }
      return `<div class="tl-mk" data-id="${m.id}" style="left:${x}px;--mk:${m.color}">
        <div class="tl-mk-line" style="height:${tracksH}px"></div>
        <div class="tl-mk-flag" title="${esc(m.label)} · ${fmt(m.t)} — clique: ir; arraste: mover; duplo clique: renomear; botão direito: opções"><i></i><span>${esc(m.label)}</span></div>
      </div>`;
    }).join('');
    el.style.setProperty('--ruler-h', `${rulerH}px`);
    refreshButton();
  }
  // #endregion

  // #region Interação
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };

  async function rename(id) {
    const m = byId(id);
    if (!m) return;
    const name = await window.MSUI.prompt({ title: m.end != null ? 'Renomear região' : 'Renomear marcador', label: 'Nome', value: m.label, confirmLabel: 'Renomear' });
    if (name == null || !name.trim()) return;
    pushUndo();
    m.label = name.trim().slice(0, 40);
    render();
  }

  function openMenu(id, x, y) {
    closeMenu();
    const m = byId(id);
    if (!m) return;
    menu = document.createElement('div');
    menu.className = 'tl-mk-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.innerHTML = `
      <button type="button" data-mk="rename">Renomear…</button>
      <div class="tl-mk-colors">${COLORS.map(c => `<button type="button" data-mk="color" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>
      ${m.end != null ? '<button type="button" data-mk="work">Usar como região de trabalho</button>' : ''}
      <button type="button" data-mk="delete" class="is-danger">Excluir</button>`;
    document.body.appendChild(menu);
    menu.addEventListener('click', e => {
      const b = e.target.closest('[data-mk]');
      if (!b) return;
      const act = b.dataset.mk;
      closeMenu();
      if (act === 'rename') rename(id);
      if (act === 'color') { pushUndo(); m.color = b.dataset.color; render(); }
      if (act === 'delete') { pushUndo(); remove(id); render(); window.MSUI?.toast({ message: 'Removido.', kind: 'info', duration: 5000, action: { label: 'Desfazer', onClick: () => window.__tlUndo?.() } }); }
      if (act === 'work') { pushUndo(); remove('work'); m.work = true; m.id = 'work'; render(); }
    });
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!menu?.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off); } }), 0);
  }

  function pointerTime(ev) {
    const scroll = document.getElementById('tlScroll');
    const r = scroll.getBoundingClientRect();
    return Math.max(0, (ev.clientX - r.left + scroll.scrollLeft) / pps());
  }

  function startDrag(e, id, part) {
    const m = byId(id);
    if (!m) return;
    const startX = e.clientX;
    let pushed = false;
    const len = m.end != null ? m.end - m.t : 0;
    const move = ev => {
      if (!pushed && Math.abs(ev.clientX - startX) < 3) return;
      if (!pushed) { pushUndo(); pushed = true; }
      const T = snapT(pointerTime(ev));
      if (part === 'start') m.t = Math.min(T, (m.end ?? T) - 0.05);
      else if (part === 'end') m.end = Math.max(T, m.t + 0.05);
      else { m.t = T; if (m.end != null) m.end = T + len; }
      render();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('tl-mk-dragging');
      if (!pushed && !part) window.seekTo?.(m.t);   // clique simples: vai até o marcador
    };
    document.body.classList.add('tl-mk-dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function initEvents() {
    const scroll = document.getElementById('tlScroll');
    if (!scroll) return;
    scroll.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const handle = e.target.closest('.tl-mk-h');
      const flag = e.target.closest('.tl-mk-flag, .tl-mk-rlabel');
      if (!handle && !flag) return;
      const id = (handle || flag).closest('[data-id]')?.dataset.id;
      if (!id) return;
      e.stopPropagation();   // não é scrub da régua
      e.preventDefault();
      startDrag(e, id, handle ? handle.dataset.h : null);
    }, true);
    scroll.addEventListener('dblclick', e => {
      const flag = e.target.closest('.tl-mk-flag, .tl-mk-rlabel');
      if (flag) { e.stopPropagation(); rename(flag.closest('[data-id]').dataset.id); return; }
      if (e.target.closest('#tlRuler') && !e.target.closest('.tl-mk, .tl-mk-region')) {
        pushUndo();
        add({ t: pointerTime(e) });
        render();
      }
    });
    scroll.addEventListener('contextmenu', e => {
      const hit = e.target.closest('.tl-mk-flag, .tl-mk-rbar');
      if (!hit) return;
      e.preventDefault();
      openMenu(hit.closest('[data-id]').dataset.id, e.clientX, e.clientY);
    });
    document.getElementById('btnTlMarker')?.addEventListener('click', e => { e.stopPropagation(); togglePopover(e.currentTarget); });
  }
  // #endregion

  // #region Lista (botão da barra)
  let pop = null;
  function refreshButton() {
    const b = document.getElementById('btnTlMarker');
    if (b) b.dataset.count = String(list().filter(m => !m.work).length || '');
  }

  function togglePopover(anchor) {
    if (pop) { pop.remove(); pop = null; return; }
    pop = document.createElement('div');
    pop.className = 'tl-mk-pop';
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left - 80)}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
    const draw = () => {
      const items = sorted();
      pop.innerHTML = `
        <div class="tl-mk-pop-head"><b>Marcadores e regiões</b>
          <button type="button" data-mk="add">＋ Aqui <kbd>M</kbd></button></div>
        ${items.length ? items.map(m => `
          <div class="tl-mk-item" data-id="${m.id}">
            <i style="background:${m.color}"></i>
            <button type="button" class="tl-mk-go" data-mk="go">${esc(m.label)}</button>
            <span>${fmt(m.t)}${m.end != null ? ` → ${fmt(m.end)}` : ''}</span>
            <button type="button" data-mk="del" title="Excluir">✕</button>
          </div>`).join('') : '<p class="tl-mk-empty">Nenhum marcador. Aperte <kbd>M</kbd> na posição desejada.</p>'}
        <div class="tl-mk-pop-foot"><kbd>I</kbd>/<kbd>O</kbd> marcam uma região · <kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> pulam entre marcadores</div>`;
    };
    draw();
    document.body.appendChild(pop);
    pop.addEventListener('click', e => {
      const b = e.target.closest('[data-mk]');
      if (!b) return;
      const id = b.closest('[data-id]')?.dataset.id;
      if (b.dataset.mk === 'add') { pushUndo(); add({}); render(); draw(); }
      if (b.dataset.mk === 'go') window.seekTo?.(byId(id)?.t ?? 0);
      if (b.dataset.mk === 'del') { pushUndo(); remove(id); render(); draw(); }
    });
    setTimeout(() => document.addEventListener('mousedown', function off(e) {
      if (pop && !pop.contains(e.target) && !e.target.closest('#btnTlMarker')) { pop.remove(); pop = null; document.removeEventListener('mousedown', off); }
    }), 0);
  }
  // #endregion

  // Histórico e salvamento (compositor.js / app.js / projects.js)
  window.__mkSnap = () => list().map(m => ({ ...m }));
  window.__mkRestore = snap => { st().markers = (snap || []).map(m => ({ ...m })); render(); };
  window.__mkTimes = times;
  window.__renderMarkers = render;
  window.MSMarkers = { list, sorted, add, remove, jump, setIn, setOut, clearWork, regionFromSelection, rippleRemoveRegion, rename, render, work };

  function boot() { initEvents(); render(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
