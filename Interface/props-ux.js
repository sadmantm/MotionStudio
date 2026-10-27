'use strict';
// props-ux.js
//
//  Ergonomia do painel de propriedades (direita), aplicada por cima do que cada painel desenha:
//    • seções recolhíveis (clique no título); o que você recolhe fica lembrado entre clips e sessões
//    • duplo clique em qualquer slider volta ao valor padrão
//    • arrastar sobre o número ao lado do slider (ou sobre as letras X/Y e os rótulos de campos
//      numéricos) altera o valor — como no CapCut/Premiere; clicar continua digitando
//    • "padrão" na seção Áudio (volume, mudo e fades)
//  O painel é refeito (innerHTML) a cada mudança, então um MutationObserver reaplica o ajuste.

(() => {
  const LS = 'ms.propsCollapsed';
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch (_) { collapsed = new Set(); }
  const persist = () => { try { localStorage.setItem(LS, JSON.stringify([...collapsed])); } catch (_) { /* sem storage */ } };
  const st = () => window.__appState;

  // #region Seções recolhíveis
  const titleKey = el => (el.querySelector('.prop-title')?.childNodes[0]?.textContent || el.querySelector('.prop-title')?.textContent || '').trim().replace(/\s+/g, ' ');

  function enhance(root) {
    root.querySelectorAll('.prop-section').forEach(sec => {
      const title = sec.querySelector(':scope > .prop-title');
      if (!title || sec.dataset.ux) return;
      sec.dataset.ux = '1';
      const key = titleKey(sec);
      if (!key) return;
      sec.dataset.uxKey = key;
      title.classList.add('ux-collapsible');
      title.insertAdjacentHTML('afterbegin', '<i class="ux-caret" aria-hidden="true">▾</i>');
      title.setAttribute('role', 'button');
      title.setAttribute('aria-expanded', String(!collapsed.has(key)));
      title.tabIndex = 0;
      sec.classList.toggle('is-collapsed', collapsed.has(key));
    });
  }

  function toggle(sec) {
    const key = sec.dataset.uxKey;
    const now = !sec.classList.contains('is-collapsed');
    sec.classList.toggle('is-collapsed', now);
    sec.querySelector(':scope > .prop-title')?.setAttribute('aria-expanded', String(!now));
    if (now) collapsed.add(key); else collapsed.delete(key);
    persist();
    // As outras seções com o mesmo título (ex.: duas "Efeitos") seguem junto
    document.querySelectorAll(`#propsContent .prop-section[data-ux-key="${CSS.escape(key)}"]`).forEach(s => {
      s.classList.toggle('is-collapsed', now);
      s.querySelector(':scope > .prop-title')?.setAttribute('aria-expanded', String(!now));
    });
  }
  // #endregion

  // #region Duplo clique volta ao padrão
  function resetSlider(range) {
    const def = range.dataset.default;
    if (def == null || def === '') return;
    if (Number(range.value) === Number(def)) return;
    range.value = def;
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // #endregion

  // #region Arrastar o número
  let scrub = null;
  let suppressClick = false;

  function targetFor(el) {
    // 1) número ao lado do slider
    const val = el.closest('.fx-val[data-edit]');
    if (val) {
      const range = val.parentElement.querySelector('input[type="range"]');
      return range ? { input: range, label: val, kind: 'range' } : null;
    }
    // 2) letras X/Y e rótulos de campos numéricos
    const axis = el.closest('.tf-axis');
    if (axis) {
      const input = axis.nextElementSibling?.matches('input[type="number"]') ? axis.nextElementSibling : null;
      return input ? { input, kind: 'number' } : null;
    }
    const label = el.closest('.prop-row > label');
    if (label) {
      const nums = label.parentElement.querySelectorAll('input[type="number"]');
      return nums.length === 1 ? { input: nums[0], kind: 'number' } : null;
    }
    return null;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const t = targetFor(e.target);
    if (!t || t.input.disabled || t.label?.querySelector('input')) return;
    const min = t.input.min !== '' ? Number(t.input.min) : -Infinity;
    const max = t.input.max !== '' ? Number(t.input.max) : Infinity;
    const range = Number.isFinite(max - min) ? max - min : 200;
    const step = Number(t.input.step) > 0 ? Number(t.input.step) : 1;
    scrub = { ...t, x0: e.clientX, v0: Number(t.input.value) || 0, min, max, perPx: Math.max(step, range / 240), step, moved: false };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }

  function onMove(e) {
    if (!scrub) return;
    const dx = e.clientX - scrub.x0;
    if (!scrub.moved && Math.abs(dx) < 3) return;
    if (!scrub.moved) { scrub.moved = true; document.body.classList.add('ux-scrubbing'); e.preventDefault(); }
    // Shift = fino, Ctrl = grosso
    const k = e.shiftKey ? 0.2 : e.ctrlKey || e.metaKey ? 5 : 1;
    let v = scrub.v0 + dx * scrub.perPx * k;
    v = Math.round(v / scrub.step) * scrub.step;
    v = Math.max(scrub.min, Math.min(scrub.max, v));
    if (Number(scrub.input.value) === v) return;
    scrub.input.value = String(Math.round(v * 1000) / 1000);
    // Slider: evento input a cada passo (preview ao vivo); campo numérico: só ao soltar
    if (scrub.kind === 'range') scrub.input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.body.classList.remove('ux-scrubbing');
    if (scrub?.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      scrub.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scrub = null;
  }
  // #endregion

  // #region Seção Áudio: "padrão"
  function resetAudio(clipId) {
    const clip = st().clips.find(c => c.id === clipId);
    if (!clip) return;
    window.__tlPushUndo?.();
    clip.volume = 1;
    clip.muted = false;
    clip.fadeIn = 0;
    clip.fadeOut = 0;
    if (clip.keyframes?.volume) { const { volume, ...rest } = clip.keyframes; if (Object.keys(rest).length) clip.keyframes = rest; else delete clip.keyframes; }
    window.__syncCompositorToTime?.(st().time);
    if (typeof refreshClipBlock === 'function') refreshClipBlock(clipId);
    window.__renderProps?.();
  }
  // #endregion

  function boot() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    let busy = false;
    const run = () => {
      if (busy) return;
      busy = true;
      try { enhance(props); } finally { busy = false; }
    };
    new MutationObserver(run).observe(props, { childList: true, subtree: true });
    run();

    props.addEventListener('click', e => {
      if (suppressClick && e.target.closest('.fx-val[data-edit]')) { e.stopPropagation(); e.preventDefault(); return; }
      const title = e.target.closest('.prop-title.ux-collapsible');
      if (title && !e.target.closest('button, input, select, a')) toggle(title.parentElement);
      const reset = e.target.closest('[data-audio-action="reset"]');
      if (reset) resetAudio(reset.dataset.clipId);
    }, true);
    props.addEventListener('keydown', e => {
      const title = e.target.closest?.('.prop-title.ux-collapsible');
      if (title && (e.key === 'Enter' || e.key === ' ') && e.target === title) { e.preventDefault(); toggle(title.parentElement); }
    });
    // Duplo clique no slider volta ao padrão. Os painéis se redesenham no 1º clique (o valor muda
    // e o painel é refeito), então o evento dblclick nunca chega: o duplo clique é medido aqui
    // (dois toques no mesmo slider, juntos) e o reset vale para o slider novo. Efeitos já tem o seu.
    const keyOf = r => r.dataset.tf || r.dataset.fx || r.dataset.at || r.getAttribute('oninput') || r.id || '';
    let lastDown = null;
    props.addEventListener('mousedown', e => {
      const range = e.target.closest('input[type="range"]');
      if (!range || range.closest('.fx-props')) return;
      const key = keyOf(range);
      const now = performance.now();
      if (key && lastDown && lastDown.key === key && now - lastDown.t < 450 && Math.abs(e.clientX - lastDown.x) < 8) {
        lastDown = null;
        e.preventDefault();
        setTimeout(() => {
          const live = [...props.querySelectorAll('input[type="range"]')].find(r => keyOf(r) === key);
          if (live) resetSlider(live);
        }, 0);
        return;
      }
      lastDown = { key, t: now, x: e.clientX };
    }, true);
    props.addEventListener('mousedown', onDown);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
