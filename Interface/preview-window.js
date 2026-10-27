'use strict';
// preview-window.js
//
//  Preview numa janela separada (para outro monitor) enquanto se edita na
//  principal. O palco (#previewOuter) muda de documento com adoptNode: os
//  clips são remontados lá, as mensagens dos iframes (que agora têm a janela
//  nova como pai) são repassadas para o editor, e o play passa a ser dirigido
//  pelos quadros da janela do preview (compositor.js: playbackRafHost).
//  A janela é só para assistir: editar continua na principal.

(() => {
  const S = { win: null, outer: null, placeholder: null, nativeGet: null, raf: null, idle: null };
  const st = () => window.__appState;

  const isOpen = () => Boolean(S.win && !S.win.closed);

  /** Tamanho útil do palco na janela separada (compositor.js → syncPreviewSize) */
  window.__previewHostSize = () => {
    if (!isOpen()) return null;
    const stage = S.win.document.getElementById('pwStage');
    return stage ? { w: Math.max(80, stage.clientWidth - 16), h: Math.max(80, stage.clientHeight - 16) } : null;
  };

  function remountClips() {
    const compositor = window.__Compositor;
    compositor?.allIds().forEach(id => compositor.unmount(id));
    window.mountAllClips?.();
    requestAnimationFrame(() => {
      window.__syncPreviewSize?.();
      window.__syncCompositorToTime?.(st()?.time ?? 0);
    });
  }

  function buildDocument(win) {
    const doc = win.document;
    doc.title = `Preview — ${st()?.project?.name || 'Motion Studio'}`;
    // Mesmos estilos do editor (links absolutos + <style> injetados pelos módulos)
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
      const copy = node.tagName === 'LINK' ? doc.createElement('link') : doc.createElement('style');
      if (node.tagName === 'LINK') { copy.rel = 'stylesheet'; copy.href = node.href; }
      else copy.textContent = node.textContent;
      doc.head.appendChild(copy);
    });
    const style = doc.createElement('style');
    style.textContent = `
      html, body { margin:0; height:100%; background:#000; overflow:hidden; }
      body { display:flex; flex-direction:column; user-select:none; }
      #pwBar {
        display:flex; align-items:center; gap:10px; height:38px; padding:0 12px;
        background:#111116; border-bottom:1px solid #252530; color:#dcdce8;
        font:600 12px Inter, system-ui, sans-serif; flex-shrink:0;
        transition:margin-top .2s;
      }
      #pwBar .pw-name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #pwBar .pw-time { font-variant-numeric:tabular-nums; color:#8b8ba0; }
      #pwBar button {
        height:26px; padding:0 10px; border:1px solid #32323e; border-radius:6px;
        background:#18181e; color:#dcdce8; font:inherit; cursor:pointer;
      }
      #pwBar button:hover { border-color:#82ea00; color:#82ea00; }
      #pwStage { flex:1; display:grid; place-items:center; overflow:hidden; min-height:0; }
      #pwStage #previewOuter { margin:auto; }
      #transformOverlay, #psGuides { display:none !important; }
      body.pw-idle #pwBar { margin-top:-38px; }
      body.pw-idle { cursor:none; }
    `;
    doc.head.appendChild(style);
    doc.body.innerHTML = `
      <div id="pwBar">
        <button data-pw="play" title="Play / pausa (Espaço)">▶</button>
        <span class="pw-time" id="pwTime">00:00:00.00</span>
        <span class="pw-name"></span>
        <button data-pw="full" title="Tela cheia (F)">Tela cheia</button>
        <button data-pw="back" title="Voltar o preview para o editor">Voltar ao editor</button>
      </div>
      <div id="pwStage"></div>`;
    doc.querySelector('.pw-name').textContent = st()?.project?.name || '';

    doc.addEventListener('click', e => {
      const btn = e.target.closest('[data-pw]');
      if (!btn) return;
      if (btn.dataset.pw === 'play') window.togglePlay?.();
      if (btn.dataset.pw === 'full') toggleFullscreen();
      if (btn.dataset.pw === 'back') close();
    });
    doc.getElementById('pwStage').addEventListener('dblclick', toggleFullscreen);
    // Atalhos de assistir (o resto continua na janela do editor)
    doc.addEventListener('keydown', e => {
      const state = st();
      if (!state?.project) return;
      const frame = 1 / (state.project.fps || 30);
      if (e.code === 'Space') { e.preventDefault(); window.togglePlay?.(); }
      if (e.code === 'ArrowLeft') window.seekTo?.(state.time - (e.shiftKey ? 1 : frame));
      if (e.code === 'ArrowRight') window.seekTo?.(state.time + (e.shiftKey ? 1 : frame));
      if (e.code === 'Home') window.seekTo?.(0);
      if (e.code === 'End') window.seekTo?.(state.project.totalDuration);
      if (e.code === 'KeyF') toggleFullscreen();
    });
    // Barra some com o mouse parado (bom para tela cheia no outro monitor)
    doc.addEventListener('mousemove', () => {
      doc.body.classList.remove('pw-idle');
      clearTimeout(S.idle);
      S.idle = setTimeout(() => doc.body.classList.add('pw-idle'), 2500);
    });
    // Mensagens dos clips HTML: o pai deles agora é esta janela
    win.addEventListener('message', e => {
      window.dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin }));
    });
    win.addEventListener('resize', () => window.__syncPreviewSize?.());
    win.addEventListener('pagehide', () => close({ closing: true }));
  }

  function toggleFullscreen() {
    if (!isOpen()) return;
    const doc = S.win.document;
    if (doc.fullscreenElement) doc.exitFullscreen?.();
    else doc.documentElement.requestFullscreen?.().catch(() => {});
  }

  /** Tempo e ícone de play na barra da janela */
  function barLoop() {
    if (!isOpen()) return;
    const doc = S.win.document;
    const time = doc.getElementById('pwTime');
    if (time) time.textContent = window.__fmtTime?.(st()?.time || 0) || '';
    const play = doc.querySelector('[data-pw="play"]');
    if (play) play.textContent = st()?.playing ? '❚❚' : '▶';
    S.raf = S.win.requestAnimationFrame(barLoop);
  }

  function open() {
    if (isOpen()) { S.win.focus(); return; }
    const outer = document.getElementById('previewOuter');
    const state = st();
    if (!outer || !state?.project) return;

    const { w, h } = state.project.res;
    const k = Math.min(1, 860 / h, 1400 / w);
    const win = window.open('', 'msPreviewWindow',
      `popup,width=${Math.round(w * k) + 32},height=${Math.round(h * k) + 70}`);
    if (!win) {
      window.MSUI.notify('O navegador bloqueou a janela do preview. Permita pop-ups para este endereço e tente de novo.');
      return;
    }
    S.win = win;
    window.__previewWindow = win;
    buildDocument(win);

    // Marca o lugar do palco no editor
    S.placeholder = document.createElement('div');
    S.placeholder.className = 'pw-placeholder';
    S.placeholder.innerHTML = `
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="14" height="11" rx="2"/><rect x="9" y="10" width="13" height="10" rx="2"/></svg>
      <p>O preview está aberto em outra janela</p>
      <div class="pw-placeholder-actions">
        <button class="btn-secondary" data-pw-main="focus">Mostrar janela</button>
        <button class="export-btn" data-pw-main="back">Trazer de volta</button>
      </div>`;
    outer.before(S.placeholder);
    S.outer = outer;

    // getElementById do editor também acha o palco na outra janela
    S.nativeGet = document.getElementById;
    document.getElementById = function (id) {
      return S.nativeGet.call(document, id) || (isOpen() ? S.win.document.getElementById(id) : null);
    };

    win.document.getElementById('pwStage').appendChild(win.document.adoptNode(outer));
    document.body.classList.add('pw-detached');
    remountClips();
    barLoop();
  }

  function close({ closing = false } = {}) {
    if (!S.outer) return;
    const win = S.win;
    S.win = null;
    window.__previewWindow = null;
    if (S.nativeGet) { document.getElementById = S.nativeGet; S.nativeGet = null; }
    try { win?.cancelAnimationFrame(S.raf); } catch (_) { /* janela já fechada */ }

    // Palco de volta ao editor (remontado: os iframes recarregam ao trocar de janela)
    const outer = document.adoptNode(S.outer);
    if (S.placeholder?.isConnected) S.placeholder.replaceWith(outer);
    else document.getElementById('previewScroll')?.appendChild(outer);
    S.placeholder = null;
    S.outer = null;
    document.body.classList.remove('pw-detached');
    remountClips();
    window.__refreshTransformOverlay?.();
    if (!closing) { try { win?.close(); } catch (_) { /* sem permissão */ } }
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-pw-main], #btnPreviewPopout, #mbPreviewPopout');
    if (!btn) return;
    if (btn.dataset.pwMain === 'focus') S.win?.focus();
    else if (btn.dataset.pwMain === 'back') close();
    else isOpen() ? close() : open();
  });

  // Fechou pelo X do sistema sem disparar pagehide (alguns navegadores)
  setInterval(() => { if (S.outer && (!S.win || S.win.closed)) close({ closing: true }); }, 1000);
  window.addEventListener('beforeunload', () => { try { S.win?.close(); } catch (_) { /* nada */ } });

  window.MSPreviewWindow = { open, close, isOpen };
})();
