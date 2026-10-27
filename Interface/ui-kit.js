'use strict';
// ui-kit.js
//
//  Avisos e diálogos do editor, no lugar dos alert/confirm/prompt do navegador (que travam a
//  tela, destoam do visual e não deixam desfazer):
//    MSUI.toast({ message, kind, action, duration })   aviso no canto, com ação opcional ("Desfazer")
//    MSUI.confirm({ title, message, confirmLabel, danger }) → Promise<boolean>
//    MSUI.prompt({ title, label, value, placeholder })      → Promise<string | null>
//    MSUI.alert({ title, message })                         → Promise<void>  (erros longos)
//    MSUI.task({ title, detail, progress, onCancel })       → cartão de progresso fixo para
//        operações demoradas (exportar, transcrever, gerar cenas…); não bloqueia a edição.
//        handle.update({ progress, detail, title }) · .done(msg) · .fail(msg) · .close()
//  Os diálogos usam foco preso, Enter confirma e Esc cancela.

(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const ICON = { ok: '✓', error: '✕', warn: '!', info: 'i' };

  // #region Toasts
  let toastHost = null;
  function host() {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'ui-toasts';
      toastHost.setAttribute('role', 'status');
      toastHost.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastHost);
    }
    return toastHost;
  }

  /** kind: 'info' | 'ok' | 'warn' | 'error'. action: { label, onClick }. duration em ms (0 = fica até fechar) */
  function toast({ message, kind = 'info', action = null, duration } = {}) {
    if (!message) return null;
    const ms = duration ?? (kind === 'error' ? 7000 : action ? 6500 : 3800);
    const el = document.createElement('div');
    el.className = `ui-toast is-${kind}`;
    el.innerHTML = `<span class="ui-toast-icon" aria-hidden="true">${ICON[kind] || 'i'}</span>
      <span class="ui-toast-msg">${esc(message)}</span>
      ${action ? `<button type="button" class="ui-toast-action">${esc(action.label)}</button>` : ''}
      <button type="button" class="ui-toast-x" aria-label="Fechar">✕</button>`;
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 180);
    };
    el.querySelector('.ui-toast-x').addEventListener('click', close);
    el.querySelector('.ui-toast-action')?.addEventListener('click', () => { try { action.onClick?.(); } finally { close(); } });
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { if (ms) timer = setTimeout(close, 1800); });
    const h = host();
    h.appendChild(el);
    while (h.children.length > 4) h.firstElementChild.remove();   // não empilha sem fim
    if (ms) timer = setTimeout(close, ms);
    return { close };
  }
  // #endregion

  // #region Diálogos
  /** Modal genérico: devolve { el, close(result), promise } */
  function dialog({ title, bodyHtml, confirmLabel = 'OK', cancelLabel = 'Cancelar', danger = false, hideCancel = false, onReady }) {
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="modal ui-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-header"><span>${esc(title)}</span></div>
        <div class="modal-body ui-dialog-body">${bodyHtml}</div>
        <div class="modal-footer">
          ${hideCancel ? '' : `<button type="button" class="btn-secondary" data-ui="cancel">${esc(cancelLabel)}</button>`}
          <button type="button" class="export-btn${danger ? ' is-danger' : ''}" data-ui="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const close = result => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      try { prevFocus?.focus?.(); } catch (_) { /* foco perdido */ }
      finish(result);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === 'Tab') {   // foco preso no diálogo
        const f = [...overlay.querySelectorAll('button, input, textarea, select')].filter(x => !x.disabled);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(null); });
    overlay.querySelector('[data-ui="cancel"]')?.addEventListener('click', () => close(null));
    onReady?.(overlay, close);
    return { el: overlay, close, promise };
  }

  function confirm({ title = 'Confirmar', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
    const d = dialog({
      title, bodyHtml: `<p class="ui-dialog-msg">${esc(message).replace(/\n/g, '<br>')}</p>`, confirmLabel, cancelLabel, danger,
      onReady: (el, close) => {
        const ok = el.querySelector('[data-ui="ok"]');
        ok.addEventListener('click', () => close(true));
        ok.focus();
      },
    });
    return d.promise.then(v => v === true);
  }

  function prompt({ title = 'Nome', label = '', value = '', placeholder = '', confirmLabel = 'OK', maxLength = 120 } = {}) {
    const d = dialog({
      title,
      bodyHtml: `${label ? `<label class="ui-dialog-label" for="uiPromptInput">${esc(label)}</label>` : ''}
        <input id="uiPromptInput" class="prop-input full ui-dialog-input" type="text" maxlength="${maxLength}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`,
      confirmLabel,
      onReady: (el, close) => {
        const input = el.querySelector('input');
        const submit = () => close(input.value);
        el.querySelector('[data-ui="ok"]').addEventListener('click', submit);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        input.focus();
        input.select();
      },
    });
    return d.promise.then(v => (v == null ? null : String(v)));
  }

  function alert({ title = 'Aviso', message = '' } = {}) {
    const d = dialog({
      title, bodyHtml: `<p class="ui-dialog-msg">${esc(message).replace(/\n/g, '<br>')}</p>`, confirmLabel: 'OK', hideCancel: true,
      onReady: (el, close) => {
        const ok = el.querySelector('[data-ui="ok"]');
        ok.addEventListener('click', () => close(true));
        ok.focus();
      },
    });
    return d.promise.then(() => undefined);
  }
  // #endregion

  // #region Cartões de progresso (tarefas demoradas)
  let dock = null;
  const tasks = new Set();
  function taskDock() {
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'ui-tasks';
      document.body.appendChild(dock);
    }
    return dock;
  }

  const fmtEta = sec => (sec >= 90 ? `~${Math.round(sec / 60)} min` : `~${Math.max(1, Math.round(sec))} s`);

  /**
   * Cartão fixo no canto. progress: 0–1 (barra) ou null (indeterminado).
   * onCancel: mostra o botão Cancelar. onOpen: clique no cartão (ex.: reabrir o modal da tarefa).
   */
  function task({ title, detail = '', progress = null, onCancel = null, onOpen = null } = {}) {
    const el = document.createElement('div');
    el.className = 'ui-task';
    el.innerHTML = `
      <div class="ui-task-head"><span class="ui-task-title"></span><span class="ui-task-eta"></span>
        ${onCancel ? '<button type="button" class="ui-task-cancel" title="Cancelar">Cancelar</button>' : ''}</div>
      <div class="ui-task-detail"></div>
      <div class="ui-task-bar"><i></i></div>`;
    const $ = s => el.querySelector(s);
    const t0 = Date.now();
    let state = 'run';
    let closeTimer = null;
    const paint = (p, d, t) => {
      if (t != null) $('.ui-task-title').textContent = t;
      if (d != null) $('.ui-task-detail').textContent = d;
      const bar = $('.ui-task-bar');
      if (p == null) { bar.classList.add('is-indeterminate'); $('.ui-task-eta').textContent = ''; return; }
      bar.classList.remove('is-indeterminate');
      const pct = Math.max(0, Math.min(1, p));
      $('.ui-task-bar i').style.width = `${(pct * 100).toFixed(1)}%`;
      const elapsed = (Date.now() - t0) / 1000;
      $('.ui-task-eta').textContent = pct > 0.04 && pct < 0.995 && elapsed > 3 ? `${Math.round(pct * 100)}% · ${fmtEta(elapsed * (1 - pct) / pct)}` : `${Math.round(pct * 100)}%`;
    };
    paint(progress, detail, title);
    const handle = {
      el,
      update({ progress: p, detail: d, title: t } = {}) { if (state === 'run') paint(p === undefined ? progress : (progress = p), d, t); },
      done(message = 'Concluído') {
        if (state !== 'run') return;
        state = 'done';
        el.classList.add('is-done');
        paint(1, message);
        $('.ui-task-eta').textContent = '✓';
        $('.ui-task-cancel')?.remove();
        closeTimer = setTimeout(() => handle.close(), 3500);
      },
      fail(message = 'Falhou') {
        if (state !== 'run') return;
        state = 'fail';
        el.classList.add('is-error');
        paint(progress ?? 0, message);
        $('.ui-task-eta').textContent = '✕';
        $('.ui-task-cancel')?.remove();
        closeTimer = setTimeout(() => handle.close(), 9000);
      },
      close() {
        clearTimeout(closeTimer);
        tasks.delete(handle);
        el.classList.add('is-leaving');
        setTimeout(() => { el.remove(); if (!taskDock().children.length) dock.hidden = true; }, 180);
      },
      get running() { return state === 'run'; },
    };
    $('.ui-task-cancel')?.addEventListener('click', e => { e.stopPropagation(); try { onCancel(); } finally { handle.fail('Cancelado'); } });
    if (onOpen) { el.classList.add('is-clickable'); el.addEventListener('click', () => onOpen()); }
    tasks.add(handle);
    taskDock().hidden = false;
    taskDock().appendChild(el);
    return handle;
  }
  // #endregion

  /** Substitui o alert(): mensagem curta vira toast; longa ou com várias linhas, diálogo */
  function notify(message, opts = {}) {
    const text = String(message ?? '');
    const kind = opts.kind || (/não foi possível|erro|falh|inválid/i.test(text) ? 'error' : 'warn');
    if (text.length > 160 || text.split('\n').length > 3) return alert({ title: kind === 'error' ? 'Algo deu errado' : 'Aviso', message: text });
    toast({ message: text.replace(/\n+/g, ' '), kind });
    return Promise.resolve();
  }

  window.MSUI = { toast, confirm, prompt, alert, notify, task, dialog };
})();
