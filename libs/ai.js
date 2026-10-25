/**
 * libs/ai.js — Barra de comando "Clipe com IA" (Gemini).
 *
 * Ctrl+Espaço / ⌘+Espaço ou botão #btnAiPrompt: abre/fecha.
 * Enter envia · Shift+Enter quebra linha · Esc cancela/fecha
 * ↑/↓ histórico · Tab alterna "Novo clipe" / "Editar: <clip>".
 *
 * Expõe window.__onClipAIEdit(clipId) (menu de contexto → "Editar com IA").
 * Depende de globais de app.js/compositor.js: loadScenes, getEditableHtmlClip,
 * updateHtmlClipFromModal, refreshEditorAfterProjectChange, tlPushUndo, getTrack…
 */
(function () {
  'use strict';

  if (window.__aiBarInstalled) return;
  window.__aiBarInstalled = true;

  const HISTORY_KEY = 'motionStudio.ai.history';
  const HISTORY_MAX = 30;
  const MAX_LINES   = 5;

  // #region Helpers de ambiente
  const appState = () => window.__appState || (typeof state !== 'undefined' ? state : null);

  const g = name => {
    // Funções top-level dos scripts clássicos ficam em window
    const fn = window[name];
    return typeof fn === 'function' ? fn : null;
  };

  function editableClip(clipId) {
    const fn = g('getEditableHtmlClip');
    if (fn) return fn(clipId);
    const st = appState();
    const clip = st?.clips.find(c => c.id === clipId);
    const template = clip && st.templates.find(t => t.id === clip.templateId);
    return template && template.type === 'html' && !clip.isText ? { clip, template } : null;
  }

  function clipLabel(clip) {
    return String(clip?.label || 'Clipe').slice(0, 40);
  }

  const fmtInt = n => Number(n || 0).toLocaleString('pt-BR');
  // #endregion

  // #region Estilos
  const css = `
  .ai-bar {
    position: fixed; z-index: 9500; left: 50%; top: 80px;
    width: min(580px, calc(100vw - 32px));
    transform: translate(-50%, -8px) scale(.985);
    opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity .12s ease, transform .14s cubic-bezier(.2,.8,.2,1), visibility 0s linear .14s;
    background: rgba(24,24,30,.96);
    border: 1px solid var(--border2, #32323e);
    border-radius: 12px;
    box-shadow: 0 18px 50px rgba(0,0,0,.55), 0 0 0 1px rgba(130,234,0,.06), inset 0 1px 0 rgba(255,255,255,.03);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    font-family: 'Inter', system-ui, sans-serif; color: var(--text, #dcdce8);
  }
  .ai-bar.is-open {
    opacity: 1; visibility: visible; pointer-events: auto;
    transform: translate(-50%, 0) scale(1);
    transition: opacity .12s ease, transform .14s cubic-bezier(.2,.8,.2,1), visibility 0s;
  }
  .ai-bar.is-busy { border-color: rgba(130,234,0,.35); }
  .ai-bar-main { display: flex; align-items: flex-start; gap: 8px; padding: 9px 9px 7px 12px; }
  .ai-bar-icon { flex: none; width: 18px; height: 26px; display: flex; align-items: center; color: var(--accent, #82ea00); }
  .ai-bar.is-busy .ai-bar-icon svg { animation: ai-bar-spin 1.4s linear infinite; }
  @keyframes ai-bar-spin { to { transform: rotate(360deg); } }
  .ai-bar-mode {
    flex: none; max-width: 190px; height: 24px; margin-top: 1px; padding: 0 9px;
    border-radius: 999px; border: 1px solid var(--border2, #32323e);
    background: var(--bg4, #1f1f26); color: var(--text-muted, #8a8aa0);
    font: 500 11px/22px 'Inter', system-ui, sans-serif; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: color .12s, border-color .12s, background .12s;
  }
  .ai-bar-mode:hover { color: var(--text, #dcdce8); border-color: var(--border3, #3e3e4e); }
  .ai-bar-mode.is-edit { color: var(--accent, #82ea00); border-color: rgba(130,234,0,.35); background: var(--accent-dim, rgba(130,234,0,.1)); }
  .ai-bar-sfx {
    flex: none; height: 24px; margin-top: 1px; padding: 0 9px; border-radius: 999px;
    border: 1px solid var(--border2, #32323e); background: var(--bg4, #1f1f26); color: var(--text-muted, #8a8aa0);
    font: 500 11px/22px 'Inter', system-ui, sans-serif; cursor: pointer; white-space: nowrap;
    transition: color .12s, border-color .12s, background .12s;
  }
  .ai-bar-sfx:hover { color: var(--text, #dcdce8); border-color: var(--border3, #3e3e4e); }
  .ai-bar-sfx[aria-pressed="true"] { color: var(--accent, #82ea00); border-color: rgba(130,234,0,.35); background: var(--accent-dim, rgba(130,234,0,.1)); }
  .ai-bar-sfx:focus-visible { outline: 2px solid var(--accent, #82ea00); outline-offset: 1px; }
  .ai-bar-input {
    flex: 1; min-width: 0; resize: none; border: 0; outline: 0; background: transparent;
    color: var(--text, #dcdce8); font: 400 13.5px/20px 'Inter', system-ui, sans-serif;
    padding: 3px 2px; height: 26px; max-height: ${MAX_LINES * 20 + 6}px; overflow-y: auto;
    user-select: text; -webkit-user-select: text;
  }
  .ai-bar-input::placeholder { color: var(--text-muted, #5e5e72); }
  .ai-bar-input:disabled { opacity: .55; }
  .ai-bar-btn {
    flex: none; width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
    border: 1px solid transparent; background: transparent; color: var(--text-muted, #8a8aa0); cursor: pointer;
    transition: color .12s, background .12s, border-color .12s;
  }
  .ai-bar-btn:hover { color: var(--text, #dcdce8); background: var(--bg5, #26262f); }
  .ai-bar-btn:focus-visible, .ai-bar-mode:focus-visible { outline: 2px solid var(--accent, #82ea00); outline-offset: 1px; }
  .ai-bar-btn svg { pointer-events: none; }
  .ai-bar-send { background: var(--accent, #82ea00); color: #0c0c10; }
  .ai-bar-send:hover { background: var(--accent-hover, #96ff00); color: #0c0c10; }
  .ai-bar-send.is-stop { background: var(--danger-dim, rgba(255,68,85,.12)); color: var(--danger, #ff4455); border-color: rgba(255,68,85,.3); }
  .ai-bar-gear.is-active { color: var(--accent, #82ea00); background: var(--accent-dim, rgba(130,234,0,.1)); }
  .ai-bar-status {
    display: flex; align-items: center; gap: 10px; min-height: 24px;
    padding: 0 12px 7px 38px; font-size: 11px; color: var(--text-muted, #6e6e84);
  }
  .ai-bar-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-bar-msg.is-error { color: var(--danger, #ff4455); white-space: normal; }
  .ai-bar-msg.is-ok { color: var(--accent, #82ea00); }
  .ai-bar-hint { flex: none; color: var(--text-dim, #4a4a5a); white-space: nowrap; }
  .ai-bar-hint kbd {
    font: 500 10px 'Inter', system-ui, sans-serif; color: var(--text-muted, #6e6e84);
    border: 1px solid var(--border2, #32323e); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; margin: 0 1px;
  }
  .ai-bar-settings {
    border-top: 1px solid var(--border, #252530); padding: 10px 12px 12px 38px;
    display: grid; gap: 8px; font-size: 11.5px;
  }
  .ai-bar-settings[hidden] { display: none; }
  .ai-bar-check { display: flex; gap: 6px; align-items: center; text-transform: none !important; letter-spacing: 0 !important; font-size: 11.5px !important; color: var(--text, #dcdce8) !important; cursor: pointer; }
  .ai-bar-check input { accent-color: var(--accent, #82ea00); }
  .ai-bar-settings label { color: var(--text-muted, #8a8aa0); font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; }
  .ai-bar-row { display: flex; gap: 6px; align-items: center; }
  .ai-bar-field {
    flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 6px;
    border: 1px solid var(--border2, #32323e); background: var(--bg2, #111116); color: var(--text, #dcdce8);
    font: 400 12px 'Inter', system-ui, sans-serif; outline: 0;
  }
  .ai-bar-field:focus { border-color: rgba(130,234,0,.5); }
  .ai-bar-save {
    height: 26px; padding: 0 12px; border-radius: 6px; border: 1px solid rgba(130,234,0,.4);
    background: var(--accent-dim, rgba(130,234,0,.1)); color: var(--accent, #82ea00);
    font: 600 11.5px 'Inter', system-ui, sans-serif; cursor: pointer;
  }
  .ai-bar-save:hover { background: var(--accent-mid, rgba(130,234,0,.22)); }
  .ai-bar-save:disabled { opacity: .5; cursor: default; }
  .ai-bar-note { color: var(--text-muted, #6e6e84); font-size: 11px; line-height: 1.45; }
  .ai-bar-setmsg { user-select: text; -webkit-user-select: text; overflow-wrap: anywhere; }
  .ai-bar-note b { color: var(--text, #dcdce8); font-weight: 500; }
  .ai-bar-note.is-error { color: var(--danger, #ff4455); }
  .ai-bar-note.is-ok { color: var(--accent, #82ea00); }
  .ai-toast {
    position: fixed; z-index: 9600; left: 50%; top: 84px; transform: translate(-50%, -6px);
    padding: 7px 14px; border-radius: 999px; font: 500 12px 'Inter', system-ui, sans-serif;
    background: rgba(24,24,30,.96); border: 1px solid rgba(130,234,0,.35); color: var(--text, #dcdce8);
    box-shadow: 0 10px 30px rgba(0,0,0,.45); opacity: 0; pointer-events: none;
    transition: opacity .16s ease, transform .16s ease; white-space: nowrap; max-width: calc(100vw - 32px);
    overflow: hidden; text-overflow: ellipsis;
  }
  .ai-toast::before { content: '✦ '; color: var(--accent, #82ea00); }
  .ai-toast.is-error { border-color: rgba(255,68,85,.4); }
  .ai-toast.is-error::before { content: '! '; color: var(--danger, #ff4455); }
  .ai-toast.is-on { opacity: 1; transform: translate(-50%, 0); }
  #btnAiPrompt.is-active { color: var(--accent, #82ea00); border-color: rgba(130,234,0,.4); background: var(--accent-dim, rgba(130,234,0,.1)); }
  @media (prefers-reduced-motion: reduce) {
    .ai-bar, .ai-bar.is-open, .ai-toast { transition: opacity .01s, visibility 0s; transform: translate(-50%, 0); }
    .ai-bar.is-busy .ai-bar-icon svg { animation: none; }
  }`;
  // #endregion

  // #region DOM
  const ICON_SPARK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>';
  const ICON_SEND  = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const ICON_STOP  = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const ICON_GEAR  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

  let els = null;

  function build() {
    const style = document.createElement('style');
    style.id = 'ai-bar-style';
    style.textContent = css;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.className = 'ai-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Clipe com IA');
    bar.setAttribute('aria-hidden', 'true');
    bar.innerHTML = `
      <div class="ai-bar-main">
        <span class="ai-bar-icon" aria-hidden="true">${ICON_SPARK}</span>
        <button type="button" class="ai-bar-mode" title="Alternar modo (Tab)">Novo clipe</button>
        <button type="button" class="ai-bar-sfx" aria-pressed="false" title="Efeitos sonoros: a IA cria sons sincronizados com a animação, numa faixa de áudio abaixo do clipe">🔊 Sons</button>
        <textarea class="ai-bar-input" rows="1" spellcheck="false" aria-label="Descreva o clipe"
          placeholder="Descreva o clipe que você quer…"></textarea>
        <button type="button" class="ai-bar-btn ai-bar-gear" title="Configurações da IA" aria-label="Configurações da IA">${ICON_GEAR}</button>
        <button type="button" class="ai-bar-btn ai-bar-send" title="Enviar (Enter)" aria-label="Enviar">${ICON_SEND}</button>
      </div>
      <div class="ai-bar-status">
        <span class="ai-bar-msg" aria-live="polite"></span>
        <span class="ai-bar-hint"><kbd>Enter</kbd> envia · <kbd>Tab</kbd> modo · <kbd>Esc</kbd> fecha · <kbd>Ctrl+Espaço</kbd></span>
      </div>
      <div class="ai-bar-settings" hidden>
        <div class="ai-bar-note ai-bar-keystate">Carregando configuração…</div>
        <label for="aiBarKey">Chave da API do Gemini</label>
        <div class="ai-bar-row">
          <input id="aiBarKey" class="ai-bar-field ai-bar-key" type="password" autocomplete="off" spellcheck="false" placeholder="Cole sua chave (AIza…)">
          <button type="button" class="ai-bar-save">Salvar</button>
        </div>
        <label for="aiBarModel">Modelo</label>
        <div class="ai-bar-row">
          <select id="aiBarModel" class="ai-bar-field ai-bar-model"><option value="">Automático</option></select>
        </div>
        <label class="ai-bar-check"><input type="checkbox" class="ai-bar-rotate" checked> Trocar de modelo automaticamente quando a cota/limite estourar</label>
        <div class="ai-bar-note ai-bar-rotation"></div>
        <div class="ai-bar-note">Obter chave: <b>aistudio.google.com/apikey</b> · A chave fica salva só neste computador (config/ai.local.json).</div>
        <div class="ai-bar-note ai-bar-setmsg" aria-live="polite"></div>
      </div>`;
    document.body.appendChild(bar);

    const toast = document.createElement('div');
    toast.className = 'ai-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);

    els = {
      bar, toast,
      mode:     bar.querySelector('.ai-bar-mode'),
      input:    bar.querySelector('.ai-bar-input'),
      send:     bar.querySelector('.ai-bar-send'),
      gear:     bar.querySelector('.ai-bar-gear'),
      msg:      bar.querySelector('.ai-bar-msg'),
      hint:     bar.querySelector('.ai-bar-hint'),
      settings: bar.querySelector('.ai-bar-settings'),
      keyState: bar.querySelector('.ai-bar-keystate'),
      key:      bar.querySelector('.ai-bar-key'),
      save:     bar.querySelector('.ai-bar-save'),
      model:    bar.querySelector('.ai-bar-model'),
      setMsg:   bar.querySelector('.ai-bar-setmsg'),
      rotate:   bar.querySelector('.ai-bar-rotate'),
      rotation: bar.querySelector('.ai-bar-rotation'),
      sfx:      bar.querySelector('.ai-bar-sfx'),
    };

    // Efeitos sonoros: preferência deste navegador
    try { S.sfx = localStorage.getItem('ms.aiSfx') === '1'; } catch (_) { S.sfx = false; }
    els.sfx.setAttribute('aria-pressed', S.sfx ? 'true' : 'false');
    els.sfx.addEventListener('click', () => {
      S.sfx = !S.sfx;
      els.sfx.setAttribute('aria-pressed', S.sfx ? 'true' : 'false');
      try { localStorage.setItem('ms.aiSfx', S.sfx ? '1' : '0'); } catch (_) { /* sem storage */ }
      els.input.focus();
    });

    els.input.addEventListener('keydown', onInputKey);
    els.input.addEventListener('input', () => { autoGrow(); if (!S.busy) setMsg(''); });
    els.send.addEventListener('click', () => (S.busy ? cancel() : submit()));
    els.mode.addEventListener('click', () => { toggleMode(); els.input.focus(); });
    els.gear.addEventListener('click', () => toggleSettings());
    els.save.addEventListener('click', saveKey);
    els.key.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    });
    els.model.addEventListener('change', saveModel);
    els.rotate.addEventListener('change', saveRotate);
    // Evita que atalhos globais (Space = play, Delete…) disparem dentro da barra
    bar.addEventListener('keydown', e => e.stopPropagation());
    window.addEventListener('resize', () => { if (S.open) position(); });
  }
  // #endregion

  // #region Estado
  const S = {
    open: false,
    sfx: false,          // "🔊 Sons": a IA declara Motion.sfx
    mode: 'create',      // 'create' | 'edit'
    editClipId: null,
    busy: false,
    controller: null,
    startedAt: 0,
    chars: 0,
    statusText: '',
    timer: null,
    histIdx: -1,
    draft: '',
    config: null,
    modelsLoaded: false,
    toastTimer: null,
  };

  function loadHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }

  function pushHistory(text) {
    try {
      const arr = loadHistory().filter(x => x !== text);
      arr.push(text);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-HISTORY_MAX)));
    } catch { /* storage indisponível */ }
  }
  // #endregion

  // #region Abrir / fechar
  function position() {
    const center = document.getElementById('center');
    const r = center?.getBoundingClientRect();
    const topBar = document.getElementById('previewTopBar');
    const topBarH = topBar && topBar.offsetParent ? topBar.getBoundingClientRect().height : 0;
    if (r && r.width > 0) {
      const w = Math.min(580, Math.max(300, r.width - 32));
      els.bar.style.width = `${w}px`;
      els.bar.style.left = `${r.left + r.width / 2}px`;
      els.bar.style.top = `${r.top + topBarH + 14}px`;
      els.toast.style.left = `${r.left + r.width / 2}px`;
    } else {
      els.bar.style.left = '50%';
      els.bar.style.top = '80px';
    }
    els.toast.style.top = els.bar.style.top;
  }

  function open({ mode, clipId = null, focus = true } = {}) {
    if (!els) build();
    if (!S.busy && mode) {
      if (!S.open) setMsg('');
      setMode(mode, clipId);
    }
    position();
    clearTimeout(S.toastTimer);
    els.toast.classList.remove('is-on');
    S.open = true;
    els.bar.classList.add('is-open');
    els.bar.setAttribute('aria-hidden', 'false');
    document.getElementById('btnAiPrompt')?.classList.add('is-active');
    autoGrow();
    if (focus) requestAnimationFrame(() => (S.busy ? els.send : els.input).focus());
    ensureConfig().then(cfg => {
      if (cfg && !cfg.hasKey && !S.busy) openSettings('Configure sua chave da API do Gemini para começar.');
    });
  }

  function close() {
    if (!els || !S.open) return;
    S.open = false;
    els.bar.classList.remove('is-open');
    els.bar.setAttribute('aria-hidden', 'true');
    document.getElementById('btnAiPrompt')?.classList.remove('is-active');
    if (els.bar.contains(document.activeElement)) document.activeElement.blur();
  }

  function toggle() {
    if (S.open) close(); else open({ mode: S.busy ? undefined : 'create' });
  }
  // #endregion

  // #region Modo
  function setMode(mode, clipId = null) {
    if (mode === 'edit') {
      const ed = editableClip(clipId);
      if (!ed) {
        S.mode = 'create'; S.editClipId = null;
        renderMode();
        setMsg('Esse clipe não pode ser editado com IA (somente clipes HTML).', 'error');
        return false;
      }
      S.mode = 'edit'; S.editClipId = clipId;
    } else {
      S.mode = 'create'; S.editClipId = null;
    }
    renderMode();
    return true;
  }

  function renderMode() {
    if (!els) return;
    if (S.mode === 'edit') {
      const ed = editableClip(S.editClipId);
      const label = clipLabel(ed?.clip);
      els.mode.textContent = `Editar: ${label}`;
      els.mode.title = `Editando "${label}" — Tab volta para Novo clipe`;
      els.mode.classList.add('is-edit');
      els.input.placeholder = 'O que mudar neste clipe?';
    } else {
      els.mode.textContent = 'Novo clipe';
      els.mode.title = 'Criar um novo clipe no playhead — Tab edita o clipe selecionado';
      els.mode.classList.remove('is-edit');
      els.input.placeholder = 'Descreva o clipe que você quer…';
    }
  }

  function toggleMode() {
    if (S.busy) return;
    if (S.mode === 'edit') { setMode('create'); setMsg(''); return; }
    const st = appState();
    const id = st?.currentClipId;
    if (!id) { setMsg('Selecione um clipe HTML na timeline para editar.', 'error'); return; }
    if (setMode('edit', id)) setMsg('');
  }
  // #endregion

  // #region Input
  function autoGrow() {
    const ta = els.input;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_LINES * 20 + 6)}px`;
  }

  function setInput(value) {
    els.input.value = value;
    autoGrow();
    const end = value.length;
    els.input.setSelectionRange(end, end);
  }

  function onInputKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const ta = els.input;

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey) {
      const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
      if (ta.value === '' || atStart || S.histIdx >= 0 && !ta.value.slice(0, ta.selectionStart).includes('\n')) {
        const hist = loadHistory();
        if (!hist.length) return;
        e.preventDefault();
        if (S.histIdx < 0) { S.draft = ta.value; S.histIdx = hist.length; }
        S.histIdx = Math.max(0, S.histIdx - 1);
        setInput(hist[S.histIdx]);
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && S.histIdx >= 0) {
      const atEnd = ta.selectionStart === ta.value.length;
      if (atEnd || !ta.value.slice(ta.selectionEnd).includes('\n')) {
        e.preventDefault();
        const hist = loadHistory();
        S.histIdx += 1;
        if (S.histIdx >= hist.length) { S.histIdx = -1; setInput(S.draft || ''); }
        else setInput(hist[S.histIdx]);
      }
    }
  }

  function setMsg(text, kind = '') {
    if (!els) return;
    els.msg.textContent = text || '';
    els.msg.title = text || '';
    els.msg.classList.toggle('is-error', kind === 'error');
    els.msg.classList.toggle('is-ok', kind === 'ok');
    els.hint.style.display = text && kind === 'error' ? 'none' : '';
  }

  function setBusy(busy) {
    S.busy = busy;
    els.bar.classList.toggle('is-busy', busy);
    els.input.disabled = busy;
    els.mode.disabled = busy;
    els.send.classList.toggle('is-stop', busy);
    els.send.innerHTML = busy ? ICON_STOP : ICON_SEND;
    els.send.title = busy ? 'Cancelar (Esc)' : 'Enviar (Enter)';
    els.send.setAttribute('aria-label', busy ? 'Cancelar' : 'Enviar');
    clearInterval(S.timer);
    if (busy) {
      S.startedAt = performance.now();
      S.chars = 0;
      S.timer = setInterval(renderProgress, 250);
    }
  }

  function renderProgress() {
    if (!S.busy) return;
    const secs = Math.floor((performance.now() - S.startedAt) / 1000);
    const parts = [S.statusText || 'Gerando…'];
    if (S.chars) parts.push(`${fmtInt(S.chars)} caracteres`);
    parts.push(`${secs}s`);
    setMsg(parts.join(' · '));
  }

  function toast(text, kind = '') {
    if (!els) build();
    position();
    els.toast.textContent = text;
    els.toast.classList.toggle('is-error', kind === 'error');
    els.toast.classList.add('is-on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 2600);
  }
  // #endregion

  // #region Configurações
  async function api(path, opts = {}) {
    const resp = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    let data = {};
    try { data = await resp.json(); } catch { /* corpo vazio */ }
    if (!resp.ok) {
      const err = new Error(data.error || `Erro ${resp.status}`);
      err.code = data.code;
      throw err;
    }
    return data;
  }

  async function ensureConfig(force = false) {
    if (S.config && !force) return S.config;
    try {
      S.config = await api('/api/ai/config');
    } catch (err) {
      S.config = null;
      if (S.open) setMsg('Servidor da IA indisponível. Reinicie o Motion Studio.', 'error');
    }
    renderKeyState();
    return S.config;
  }

  function renderKeyState() {
    if (!els) return;
    const c = S.config;
    if (!c) { els.keyState.textContent = 'Configuração indisponível.'; return; }
    els.keyState.classList.toggle('is-ok', !!c.hasKey);
    els.keyState.innerHTML = c.hasKey
      ? `Chave configurada <b>${c.keyHint}</b> (${c.source === 'env' ? 'variável GEMINI_API_KEY' : 'salva neste computador'}).`
      : 'Nenhuma chave configurada.';
    els.key.placeholder = c.hasKey ? 'Cole uma nova chave para substituir' : 'Cole sua chave (AIza…)';
    // Arquivo de configuração ilegível (ex.: criado com sudo): explica em vez de "sem chave"
    if (c.configError) setSettingsMsg(c.configError, 'error');
  }

  function setSettingsMsg(text, kind = '') {
    els.setMsg.textContent = text || '';
    els.setMsg.classList.toggle('is-error', kind === 'error');
    els.setMsg.classList.toggle('is-ok', kind === 'ok');
  }

  function openSettings(message) {
    if (!els) build();
    if (!S.open) open({ focus: false });
    els.settings.hidden = false;
    els.gear.classList.add('is-active');
    if (message) setSettingsMsg(message, 'error');
    ensureConfig().then(cfg => {
      renderKeyState();
      if (cfg?.hasKey) loadModels();
      if (!cfg?.hasKey) els.key.focus();
    });
  }

  function toggleSettings() {
    if (!els.settings.hidden) {
      els.settings.hidden = true;
      els.gear.classList.remove('is-active');
      els.input.focus();
      return;
    }
    setSettingsMsg('');
    openSettings();
  }

  async function loadModels(force = false) {
    if (S.modelsLoaded && !force) return;
    const sel = els.model;
    sel.disabled = true;
    try {
      const data = await api(`/api/ai/models${force ? '?refresh=1' : ''}`);
      sel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = `Automático${data.autoModel ? ` (${data.autoModel})` : ''}`;
      sel.appendChild(auto);
      const cooling = new Map((data.cooldowns || []).map(c => [c.model, c]));
      const waitLabel = s => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
      for (const m of data.models || []) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.displayName && m.displayName !== m.id ? `${m.id} — ${m.displayName}` : m.id;
        const c = cooling.get(m.id);
        if (c) opt.textContent += ` · em espera (${waitLabel(c.secondsLeft)})`;
        sel.appendChild(opt);
      }
      els.rotate.checked = data.autoRotate !== false;
      els.rotation.textContent = data.autoRotate !== false && data.rotation?.length > 1
        ? `Ordem de tentativa: ${data.rotation.join(' → ')}`
        : 'Rotação desligada: se a cota acabar, a geração para com erro.';
      if (data.configured && !(data.models || []).some(m => m.id === data.configured)) {
        const opt = document.createElement('option');
        opt.value = data.configured;
        opt.textContent = `${data.configured} (não listado)`;
        sel.appendChild(opt);
      }
      sel.value = data.configured || '';
      S.modelsLoaded = true;
    } catch (err) {
      setSettingsMsg(err.message, 'error');
    } finally {
      sel.disabled = false;
    }
  }

  async function saveKey() {
    const key = els.key.value.trim();
    if (!key) { setSettingsMsg('Cole a chave no campo acima.', 'error'); els.key.focus(); return; }
    els.save.disabled = true;
    setSettingsMsg('Validando chave…');
    try {
      S.config = await api('/api/ai/config', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
      els.key.value = '';
      renderKeyState();
      setSettingsMsg('Chave salva e validada.', 'ok');
      S.modelsLoaded = false;
      await loadModels(true);
      setMsg('');
    } catch (err) {
      setSettingsMsg(err.message, 'error');
    } finally {
      els.save.disabled = false;
    }
  }

  async function saveRotate() {
    try {
      S.config = await api('/api/ai/config', { method: 'POST', body: JSON.stringify({ autoRotate: els.rotate.checked }) });
      setSettingsMsg(els.rotate.checked ? 'Rotação automática ligada.' : 'Rotação automática desligada.', 'ok');
      await loadModels(true);
    } catch (err) {
      setSettingsMsg(err.message, 'error');
    }
  }

  async function saveModel() {
    try {
      S.config = await api('/api/ai/config', { method: 'POST', body: JSON.stringify({ model: els.model.value }) });
      setSettingsMsg(els.model.value ? `Modelo: ${els.model.value}` : 'Modelo automático.', 'ok');
    } catch (err) {
      setSettingsMsg(err.message, 'error');
    }
  }
  // #endregion

  // #region Geração
  function cancel() {
    if (S.busy && S.controller) S.controller.abort();
  }

  async function submit() {
    if (S.busy) return;
    const prompt = els.input.value.trim();
    if (!prompt) { setMsg('Escreva o que você quer no clipe.', 'error'); return; }

    const cfg = await ensureConfig();
    if (!cfg) return;
    if (!cfg.hasKey) { openSettings('Configure sua chave da API do Gemini para gerar clipes.'); return; }

    const st = appState();
    const mode = S.mode;
    const clipId = S.editClipId;
    let editable = null;
    if (mode === 'edit') {
      editable = editableClip(clipId);
      if (!editable) {
        setMode('create');
        setMsg('O clipe selecionado não existe mais ou não é um clipe HTML.', 'error');
        return;
      }
    }

    const fpsDefault = typeof DEFAULT_FPS !== 'undefined' ? DEFAULT_FPS : 60;
    const project = st?.project
      ? { w: st.project.res.w, h: st.project.res.h, fps: st.project.fps }
      : { w: 1080, h: 1920, fps: fpsDefault };
    const playhead = st?.project ? Math.max(0, Number(st.time) || 0) : 0;

    pushHistory(prompt);
    S.histIdx = -1;
    S.draft = '';

    const controller = new AbortController();
    S.controller = controller;
    S.statusText = mode === 'edit' ? 'Enviando edição…' : 'Enviando pedido…';
    setBusy(true);
    renderProgress();

    let result = null;
    try {
      const resp = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt,
          mode,
          html: editable?.template.html,
          name: editable ? (editable.clip.label || editable.template.name) : undefined,
          project,
          playhead,
          sfx: Boolean(S.sfx),
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        let data = {};
        try { data = await resp.json(); } catch { /* ignore */ }
        throw Object.assign(new Error(data.error || `Erro ${resp.status} no servidor`), { code: data.code });
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handle = line => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === 'status') { S.statusText = ev.message; renderProgress(); }
        else if (ev.type === 'progress') { S.chars = ev.chars; }
        else if (ev.type === 'done') { result = ev; }
        else if (ev.type === 'error') { throw Object.assign(new Error(ev.error), { code: ev.code }); }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          handle(line);
        }
      }
      handle(buf + decoder.decode());
      if (!result) throw new Error('A resposta da IA terminou sem um clipe. Tente novamente.');
    } catch (err) {
      S.controller = null;
      setBusy(false);
      if (err.name === 'AbortError' || err.code === 'aborted') {
        setMsg('Cancelado.');
      } else {
        if (!S.open) open({ focus: false });
        setMsg(err.message || 'Falha ao gerar o clipe.', 'error');
        if (err.code === 'no_key' || err.code === 'invalid_key') {
          S.config = null;
          openSettings(err.message);
        }
      }
      els.input.focus();
      return;
    }

    S.controller = null;
    setBusy(false);

    try {
      if (mode === 'edit') {
        applyEdit(clipId, result);
        const sounds = await syncSfx(clipId, result);
        toast(`Clipe atualizado${editSummary(result.edit)}${sounds}${result.rotated?.length ? ` · via ${result.model}` : ''}`);
      } else {
        const id = await applyCreate(result, playhead);
        const sounds = await syncSfx(id, result);
        toast(`Clipe criado: ${result.name}${sounds}${result.rotated?.length ? ` · via ${result.model}` : ''}`);
      }
      setInput('');
      // Modelos em espera mudaram: a lista das configurações se atualiza na próxima abertura
      if (result.rotated?.length) S.modelsLoaded = false;
      setMsg(result.warnings?.length ? `Atenção: ${result.warnings.join('; ')}` : '');
      if (mode === 'edit') renderMode();
      close();
    } catch (err) {
      console.error('[AI] Falha ao aplicar clipe:', err);
      if (!S.open) open({ focus: false });
      setMsg(`Clipe gerado, mas não foi possível inseri-lo: ${err.message}`, 'error');
    }
  }
  // #endregion

  // #region Aplicar na timeline
  function overlaps(a0, a1, b0, b1) {
    return a0 < b1 - 1e-4 && b0 < a1 - 1e-4;
  }

  function pickTrack(st, clip) {
    const others = st.clips.filter(c => c.id !== clip.id);
    if (!others.length) return 0;
    const t0 = clip.start, t1 = clip.start + clip.duration;
    // Busca compartilhada da timeline (respeita tracks bloqueadas)
    if (window.__findFreeTrack) return window.__findFreeTrack(t0, t1, 1, [clip.id]);
    const locked = g('isTrackLocked');
    const hidden = g('isTrackHidden');
    const maxIdx = Math.max(0, ...others.map(c => Number(c.trackIndex) || 0), ...(st.tracks || []).map(t => t.index || 0));
    for (let idx = 1; idx <= maxIdx + 1; idx++) {
      if (locked?.(idx) || hidden?.(idx)) continue;
      const busy = others.some(c => (Number(c.trackIndex) || 0) === idx && overlaps(t0, t1, c.start, c.start + c.duration));
      if (!busy) return idx;
    }
    return maxIdx + 1;
  }

  async function applyCreate(result, playhead) {
    const loadScenesFn = g('loadScenes');
    if (!loadScenesFn) throw new Error('loadScenes indisponível');
    const st = appState();
    const hadProject = !!st?.project;
    const t = hadProject ? playhead : 0;

    const pushUndo = g('tlPushUndo');
    pushUndo?.();

    const name = String(result.name || 'Clipe IA').replace(/\.html?$/i, '');
    const ids = await loadScenesFn([{ type: 'html', name: `${name}.html`, html: result.html }]);
    const id = ids?.[0];
    const S2 = appState();
    const clip = id && S2.clips.find(c => c.id === id);
    if (!clip) throw new Error('o clipe não foi adicionado');

    // loadScenes coloca o clipe no fim da track 0 e move o playhead até ele:
    // reposiciona no playhead original, numa track livre.
    clip.start = Math.max(0, t);
    clip.trackIndex = pickTrack(S2, clip);
    g('getTrack')?.(clip.trackIndex);
    S2.time = t;
    S2.currentClipId = id;

    const refresh = g('refreshEditorAfterProjectChange');
    if (refresh) {
      refresh({ mount: true, seek: true });
    } else {
      g('recalcProjectDuration')?.();
      g('syncProjectGlobals')?.();
      (g('renderTimeline') || window.__renderTimeline)?.();
      window.mountAllClips?.();
      requestAnimationFrame(() => window.seekTo?.(t));
    }
    window.__selectClip?.(id);
    return id;
  }

  /**
   * Faixa de efeitos sonoros do clipe: criada quando "Sons" está ligado e
   * atualizada quando o clipe já tinha uma (edição muda os tempos).
   */
  async function syncSfx(clipId, result) {
    const clip = appState()?.clips.find(c => c.id === clipId);
    if (!clip || !window.__buildClipSfx) return '';
    if (!S.sfx && !clip.sfxClipId) return '';
    if (!result.hasSfx && !clip.sfxClipId) return S.sfx ? ' · sem sons' : '';
    const n = await window.__buildClipSfx(clipId);
    return n ? ` · ${n} ${n === 1 ? 'som' : 'sons'}` : '';
  }

  /** " · 3 blocos (−92% de saída)": quanto a edição por blocos economizou */
  function editSummary(edit) {
    if (!edit) return '';
    if (edit.mode === 'full') return ' · reescrito por completo';
    const saved = edit.htmlChars ? Math.round((1 - edit.outputChars / edit.htmlChars) * 100) : 0;
    const blocks = `${edit.blocks} bloco${edit.blocks === 1 ? '' : 's'}`;
    return saved > 0 ? ` · ${blocks} (−${saved}% de saída)` : ` · ${blocks}`;
  }

  function applyEdit(clipId, result) {
    const update = g('updateHtmlClipFromModal');
    if (!update) throw new Error('updateHtmlClipFromModal indisponível');
    const ed = editableClip(clipId);
    if (!ed) throw new Error('o clipe não existe mais');
    // updateHtmlClipFromModal já registra o undo (pushHtmlEditUndo) e remonta o preview
    update(clipId, ed.clip.label || result.name, result.html);
    window.__selectClip?.(clipId);
  }
  // #endregion

  // #region Atalhos e ganchos
  window.addEventListener('keydown', e => {
    const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';
    if (isSpace && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) toggle();
      return;
    }
    if (!S.open || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (S.busy) { cancel(); return; }
    if (els && !els.settings.hidden && els.bar.contains(document.activeElement) && document.activeElement !== els.input) {
      toggleSettings();
      return;
    }
    close();
  }, true);

  function bindButton() {
    const btn = document.getElementById('btnAiPrompt');
    if (!btn || btn.__aiBound) return;
    btn.__aiBound = true;
    btn.addEventListener('click', e => { e.preventDefault(); toggle(); });
  }

  window.__onClipAIEdit = function (clipId) {
    if (S.busy) { open(); setMsg('Aguarde a geração atual terminar (Esc cancela).', 'error'); return; }
    open({ mode: 'edit', clipId });
  };

  window.MotionAI = { open, close, toggle, isOpen: () => S.open };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { build(); bindButton(); }, { once: true });
  } else {
    build();
    bindButton();
  }
  // #endregion
})();
