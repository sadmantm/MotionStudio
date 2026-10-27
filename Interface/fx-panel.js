'use strict';
// fx-panel.js
//
//  Interface dos efeitos e transições (cálculo em clip-fx.js):
//    • painel do clip (direita): filtro, ajustes, movimento, transições
//    • abas Efeitos e Transições da biblioteca: cards com prévia no hover;
//      clique aplica nos clips selecionados, arrastar aplica no clip onde soltar
//  clip.fx é sempre substituído (nunca alterado no lugar): o snapshot do
//  undo guarda a referência antiga.

(() => {
  const DRAG_FX = 'text/x-ms-fx';
  const DEFAULT_DUR = { in: 0.5, out: 0.5, transition: 0.6 };
  const ADJUST = [
    ['brightness', 'Brilho',     -100, 100, 1, 0],
    ['contrast',   'Contraste',  -100, 100, 1, 0],
    ['saturation', 'Saturação',  -100, 100, 1, 0],
    ['hue',        'Matiz',      -180, 180, 1, 0],
    ['blur',       'Desfoque',      0,  40, 0.5, 0],
    ['opacity',    'Opacidade',     0, 100, 1, 100],
  ];

  const st = () => window.__appState;
  const FX = () => window.ClipFX;
  let undoArmed = false;

  // Imagem de exemplo dos cards (céu, sol, morros): mostra bem cor e contraste
  const SAMPLE = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100">' +
    '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a8ee6"/><stop offset="1" stop-color="#f6c38b"/></linearGradient></defs>' +
    '<rect width="160" height="100" fill="url(#s)"/><circle cx="118" cy="38" r="16" fill="#ffd34d"/>' +
    '<path d="M0 72 L40 48 L72 70 L104 52 L160 76 V100 H0Z" fill="#2f7d4f"/><path d="M0 84 L54 66 L96 86 L160 70 V100 H0Z" fill="#1d5a38"/>' +
    '<rect x="16" y="20" width="34" height="8" rx="4" fill="#fff" opacity=".9"/></svg>');

  // #region Dados do clip
  function targetClips() {
    const state = st();
    const ids = window.__selectedClipIds?.size ? [...window.__selectedClipIds] : (state.currentClipId ? [state.currentClipId] : []);
    return ids
      .map(id => state.clips.find(c => c.id === id))
      .filter(c => c && state.templates.find(t => t.id === c.templateId)?.type !== 'audio');
  }

  /** Novo objeto fx sem as partes vazias (null = sem efeito nenhum) */
  function cleanFx(fx) {
    const out = {};
    if (fx.look && fx.look !== 'none') out.look = fx.look;
    const adjust = {};
    ADJUST.forEach(([key, , , , , def]) => {
      const v = Number(fx.adjust?.[key]);
      if (Number.isFinite(v) && v !== def) adjust[key] = v;
    });
    if (Object.keys(adjust).length) out.adjust = adjust;
    if (fx.motion?.type && fx.motion.type !== 'none') out.motion = { type: fx.motion.type, strength: Number(fx.motion.strength) || 1 };
    if (fx.flipH) out.flipH = true;
    if (fx.flipV) out.flipV = true;
    ['in', 'out', 'transition'].forEach(k => {
      const tr = fx[k];
      if (tr?.type && tr.type !== 'none') out[k] = { type: tr.type, duration: Math.max(0.1, Number(tr.duration) || DEFAULT_DUR[k]) };
    });
    return Object.keys(out).length ? out : null;
  }

  /** Aplica `change(fx)` (fx = cópia editável) aos clips, com undo */
  function updateFx(clips, change, { undo = true } = {}) {
    if (!clips.length) return;
    if (undo) window.__tlPushUndo?.();
    clips.forEach(clip => {
      const fx = JSON.parse(JSON.stringify(clip.fx || {}));
      change(fx, clip);
      const cleaned = cleanFx(fx);
      if (cleaned) clip.fx = cleaned; else delete clip.fx;
      if (typeof refreshClipBlock === 'function') refreshClipBlock(clip.id);
    });
    window.__syncCompositorToTime?.(st().time);
  }

  function prevClip(clip) {
    return st().clips.find(o => o !== clip &&
      (Number(o.trackIndex) || 0) === (Number(clip.trackIndex) || 0) &&
      Math.abs(o.start + o.duration - clip.start) < 0.05);
  }
  // #endregion

  // #region Painel do clip (direita)
  const options = (map, current) => Object.entries(map)
    .map(([id, v]) => `<option value="${id}"${id === current ? ' selected' : ''}>${escapeHtml(typeof v === 'string' ? v : v.label)}</option>`)
    .join('');

  function renderProps(clip, tmpl) {
    if (!FX() || !clip || tmpl?.type === 'audio' || tmpl?.layer?.kind === 'camera') return '';
    const fx = clip.fx || {};
    const a = fx.adjust || {};
    const has = FX().hasFx(fx);
    const trRow = (key, label, map, hint = '') => {
      const tr = fx[key] || {};
      return `
        <div class="prop-row fx-row">
          <label title="${escapeHtml(hint)}">${label}</label>
          <select class="prop-input fx-select" data-fx="${key}.type">${options(map, tr.type || 'none')}</select>
          <input class="prop-input fx-dur" type="number" min="0.1" max="5" step="0.1" title="Duração (s)"
            value="${Number(tr.duration || DEFAULT_DUR[key]).toFixed(1)}" data-fx="${key}.duration"${tr.type && tr.type !== 'none' ? '' : ' disabled'}>
        </div>`;
    };
    return `
      <div class="prop-section fx-props" data-clip-id="${clip.id}">
        <div class="prop-title fx-title">Efeitos
          ${has ? '<button class="fx-clear" data-fx-action="clear-fx" title="Remover efeitos">limpar</button>' : ''}
        </div>
        <div class="prop-row">
          <label>Filtro</label>
          <select class="prop-input" data-fx="look">${options(FX().LOOKS, fx.look || 'none')}</select>
        </div>
        <div class="prop-row" data-clip-id="${clip.id}">
          <label title="Como esta camada se combina com o que está abaixo dela">Mesclagem</label>
          <select class="prop-input" data-blend>${options(FX().BLENDS, clip.blend || 'normal')}</select>
        </div>
        ${ADJUST.map(([key, label, min, max, step, def]) => {
          const animated = window.ClipKF?.keys(clip, key);
          const v = animated ? Math.round(window.ClipKF.valueAt(clip, key, st().time) * 10) / 10 : (a[key] ?? def);
          return `
            <div class="prop-row fx-slider">
              <label>${label}</label>
              <input type="range" class="prop-range" min="${min}" max="${max}" step="${step}" value="${v}" data-fx="adjust.${key}" data-default="${def}">
              <span class="fx-val" data-edit title="Clique para digitar">${v}</span>
              ${window.ClipKF?.controls(clip, key) || ''}
            </div>`;
        }).join('')}
        <div class="prop-row">
          <label>Movimento</label>
          <select class="prop-input" data-fx="motion.type">${options(FX().MOTIONS, fx.motion?.type || 'none')}</select>
        </div>
        <div class="prop-row fx-slider"${fx.motion?.type ? '' : ' hidden'}>
          <label>Intensidade</label>
          <input type="range" class="prop-range" min="0.2" max="2.5" step="0.1" value="${fx.motion?.strength || 1}" data-fx="motion.strength" data-default="1">
          <span class="fx-val" data-edit data-unit="×" title="Clique para digitar">${Number(fx.motion?.strength || 1).toFixed(1)}×</span>
        </div>
      </div>

      <div class="prop-section fx-props" data-clip-id="${clip.id}">
        <div class="prop-title">Transições</div>
        ${trRow('transition', 'Entre clips', FX().TRANSITIONS,
          prevClip(clip) ? 'Passa do clip anterior (mesma track) para este' : 'Sem clip encostado antes deste na mesma track: aparece sobre o que estiver embaixo')}
        ${trRow('in', 'Entrada', FX().IN_OUT)}
        ${trRow('out', 'Saída', FX().IN_OUT)}
        ${fx.transition && !prevClip(clip) ? '<p class="fx-hint">Nenhum clip encostado antes deste na mesma track: a transição revela o que estiver embaixo.</p>' : ''}
      </div>`;
  }

  /** Lê o caminho "adjust.brightness" etc. de um controle e grava no fx */
  function setPath(fx, path, value) {
    const [group, key] = path.split('.');
    if (!key) { fx[group] = value; return; }
    fx[group] = { ...(fx[group] || {}) };
    if (group === 'in' || group === 'out' || group === 'transition') {
      fx[group].duration = fx[group].duration || DEFAULT_DUR[group];
    }
    fx[group][key] = value;
  }

  function initPropsEvents() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    props.addEventListener('input', e => {
      const ctl = e.target.closest('.fx-props [data-fx]');
      if (!ctl || ctl.type !== 'range') return;
      const clip = st().clips.find(c => c.id === ctl.closest('.fx-props').dataset.clipId);
      if (!clip) return;
      // Ajuste com keyframes: o slider cria/atualiza o keyframe da agulha
      if (ctl.dataset.fx.startsWith('adjust.') && window.ClipKF?.handleInput(clip, ctl.dataset.fx.slice(7), Number(ctl.value), { undo: !undoArmed })) {
        undoArmed = true;
        const v = ctl.parentElement.querySelector('.fx-val');
        if (v) v.textContent = ctl.value;
        return;
      }
      // Um passo de undo por gesto do slider
      updateFx([clip], fx => setPath(fx, ctl.dataset.fx, Number(ctl.value)), { undo: !undoArmed });
      undoArmed = true;
      const val = ctl.parentElement.querySelector('.fx-val');
      if (val) val.textContent = ctl.dataset.fx === 'motion.strength' ? `${Number(ctl.value).toFixed(1)}×` : ctl.value;
    });
    props.addEventListener('change', e => {
      const ctl = e.target.closest('.fx-props [data-fx]');
      if (!ctl) return;
      if (ctl.type === 'range') { undoArmed = false; return; }
      const clip = st().clips.find(c => c.id === ctl.closest('.fx-props').dataset.clipId);
      if (!clip) return;
      const value = ctl.type === 'number' ? Number(ctl.value) : ctl.value;
      updateFx([clip], fx => setPath(fx, ctl.dataset.fx, value));
      window.__renderProps?.();   // mostra/esconde intensidade e durações
    });
    // Clique duplo no slider volta ao padrão
    props.addEventListener('dblclick', e => {
      const ctl = e.target.closest('.fx-props input[type="range"]');
      if (!ctl) return;
      ctl.value = ctl.dataset.default;
      ctl.dispatchEvent(new Event('input', { bubbles: true }));
      undoArmed = false;
    });
    props.addEventListener('click', e => {
      if (!e.target.closest('[data-fx-action="clear-fx"]')) return;
      const clip = st().clips.find(c => c.id === e.target.closest('.fx-props').dataset.clipId);
      if (!clip) return;
      updateFx([clip], fx => { delete fx.look; delete fx.adjust; delete fx.motion; });
      window.__renderProps?.();
    });
  }
  // #endregion

  // #region Abas da biblioteca
  function card({ kind, id, label, sample }) {
    return `
      <button class="fx-card" draggable="true" data-kind="${kind}" data-id="${id}" title="${escapeHtml(label)} — clique para aplicar no clip selecionado ou arraste até um clip">
        <span class="fx-card-view">${sample}</span>
        <span class="fx-card-name">${escapeHtml(label)}</span>
      </button>`;
  }

  function lookSample(id) {
    const style = FX().style({ start: 0, duration: 1, fx: { look: id } }, 0.5);
    return `<img src="${SAMPLE}" alt="" style="filter:${style.filter || 'none'}">`;
  }

  // Duas cenas para as transições: A (azul) sai, B (laranja) entra
  const PAIR = `<span class="fx-a"><img src="${SAMPLE}" alt=""></span><span class="fx-b"><img src="${SAMPLE}" alt="" style="filter:hue-rotate(160deg) saturate(1.3)"></span>`;

  function buildTabs() {
    const effects = document.getElementById('tabEffects');
    const transitions = document.getElementById('tabTransitions');
    if (!effects || !transitions || !FX()) return;
    effects.innerHTML = `
      <p class="fx-tab-hint">Selecione um clip na timeline e clique num efeito, ou arraste o efeito até o clip.</p>
      <div class="fx-section">Filtros</div>
      <div class="fx-grid">${Object.entries(FX().LOOKS).map(([id, v]) => card({ kind: 'look', id, label: v.label, sample: lookSample(id) })).join('')}</div>
      <div class="fx-section">Movimento</div>
      <div class="fx-grid">${Object.entries(FX().MOTIONS).map(([id, label]) => card({ kind: 'motion', id, label: id === 'none' ? 'Sem movimento' : label, sample: `<span class="fx-solo"><img src="${SAMPLE}" alt=""></span>` })).join('')}</div>`;
    transitions.innerHTML = `
      <p class="fx-tab-hint">Entre clips: aplicada no começo do clip selecionado, passando do clip anterior da mesma track.</p>
      <div class="fx-section">Entre clips</div>
      <div class="fx-grid">${Object.entries(FX().TRANSITIONS).filter(([id]) => id !== 'none').map(([id, label]) => card({ kind: 'transition', id, label, sample: PAIR })).join('')}</div>
      <div class="fx-section">Entrada</div>
      <div class="fx-grid">${Object.entries(FX().IN_OUT).filter(([id]) => id !== 'none').map(([id, label]) => card({ kind: 'in', id, label, sample: `<span class="fx-solo"><img src="${SAMPLE}" alt=""></span>` })).join('')}</div>
      <div class="fx-section">Saída</div>
      <div class="fx-grid">${Object.entries(FX().IN_OUT).filter(([id]) => id !== 'none').map(([id, label]) => card({ kind: 'out', id, label, sample: `<span class="fx-solo"><img src="${SAMPLE}" alt=""></span>` })).join('')}</div>`;

    [effects, transitions].forEach(tab => {
      tab.querySelectorAll('.fx-card').forEach(paintStill);
      tab.addEventListener('click', e => {
        const c = e.target.closest('.fx-card');
        if (c) applyCard(c.dataset.kind, c.dataset.id, targetClips());
      });
      tab.addEventListener('mouseover', e => {
        const c = e.target.closest('.fx-card');
        if (c && !c.contains(e.relatedTarget)) startDemo(c);
      });
      tab.addEventListener('mouseout', e => {
        const c = e.target.closest('.fx-card');
        if (c && !c.contains(e.relatedTarget)) stopDemo(c);
      });
      tab.addEventListener('dragstart', e => {
        const c = e.target.closest('.fx-card');
        if (!c) return;
        e.dataTransfer.setData(DRAG_FX, JSON.stringify({ kind: c.dataset.kind, id: c.dataset.id }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    });
  }

  function applyCard(kind, id, clips) {
    if (!clips.length) {
      const status = document.getElementById('mbStatus');
      if (status) status.textContent = 'Selecione um clip na timeline para aplicar';
      return;
    }
    updateFx(clips, fx => {
      if (kind === 'look') fx.look = id;
      if (kind === 'motion') fx.motion = { type: id, strength: fx.motion?.strength || 1 };
      if (kind === 'in' || kind === 'out' || kind === 'transition') {
        fx[kind] = { type: id, duration: fx[kind]?.duration || DEFAULT_DUR[kind] };
      }
    });
    window.__renderProps?.();
    const status = document.getElementById('mbStatus');
    if (status) status.textContent = `Aplicado em ${clips.length} clip(s)`;
  }

  const DEMO_LOOP = { motion: 2.4, transition: 1.6, in: 1.6, out: 1.6 };
  // Quadro parado do card: o meio do efeito (cada card fica diferente dos outros)
  const STILL_AT = { motion: 1.8, transition: 0.82, in: 0.5, out: 0.45 };

  /** Desenha a amostra do card no instante t do loop de demonstração */
  function demoFrame(c, t) {
    const kind = c.dataset.kind, id = c.dataset.id;
    const a = c.querySelector('.fx-a'), b = c.querySelector('.fx-b'), solo = c.querySelector('.fx-solo');
    if (kind === 'transition') {
      const A = FX().style({ start: 0, duration: 0.4, tailFx: { type: id, duration: 0.9 } }, t);
      const B = FX().style({ start: 0.4, duration: 5, fx: { transition: { type: id, duration: 0.9 } } }, t);
      paint(a, A); paint(b, B);
    } else {
      const fx = kind === 'motion' ? { motion: { type: id, strength: 1.4 } } : { [kind]: { type: id, duration: 0.8 } };
      // Entrada: começa em 0; saída: termina no fim do loop
      paint(solo, FX().style({ start: kind === 'out' ? -0.4 : 0.2, duration: 1.2, fx }, t));
    }
  }

  function paintStill(c) {
    if (c.dataset.kind in STILL_AT) demoFrame(c, STILL_AT[c.dataset.kind]);
  }

  /** Prévia no hover: o próprio clip-fx.js anima a amostra */
  function startDemo(c) {
    stopDemo(c);
    const LOOP = DEMO_LOOP[c.dataset.kind];
    if (!LOOP) return;
    const t0 = performance.now();
    const tick = now => {
      demoFrame(c, ((now - t0) / 1000) % LOOP);
      c._raf = requestAnimationFrame(tick);
    };
    c._raf = requestAnimationFrame(tick);
  }

  function paint(el, s) {
    if (!el) return;
    el.style.visibility = s.visible ? 'visible' : 'hidden';
    el.style.opacity = s.opacity;
    el.style.filter = s.filter;
    el.style.transform = s.transform;
    el.style.clipPath = s.clipPath;
    el.style.zIndex = s.front ? 2 : 1;
  }

  function stopDemo(c) {
    cancelAnimationFrame(c._raf);
    c.querySelectorAll('.fx-a, .fx-b, .fx-solo').forEach(el => {
      el.style.cssText = '';
    });
    paintStill(c);
  }
  // #endregion

  // #region Soltar efeito num clip da timeline
  function initTimelineDrop() {
    const tracks = document.getElementById('tlTracks');
    if (!tracks) return;
    let hover = null;
    const setHover = block => {
      if (hover === block) return;
      hover?.classList.remove('tl-fx-drop');
      hover = block;
      hover?.classList.add('tl-fx-drop');
    };
    tracks.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes(DRAG_FX)) return;
      const block = e.target.closest('.tl-block');
      setHover(block);
      if (!block) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    tracks.addEventListener('dragleave', e => { if (!tracks.contains(e.relatedTarget)) setHover(null); });
    tracks.addEventListener('drop', e => {
      if (!e.dataTransfer.types.includes(DRAG_FX)) return;
      const block = e.target.closest('.tl-block');
      setHover(null);
      if (!block) return;
      e.preventDefault();
      e.stopPropagation();
      let data;
      try { data = JSON.parse(e.dataTransfer.getData(DRAG_FX)); } catch (_) { return; }
      const clip = st().clips.find(c => c.id === block.dataset.clipId);
      if (!clip || st().templates.find(t => t.id === clip.templateId)?.type === 'audio') return;
      applyCard(data.kind, data.id, [clip]);
      selectClip(clip.id);
    });
  }
  // #endregion

  // #region Chips de efeito na timeline
  /**
   * Clique num chip do bloco (fx-timeline.js): seleciona o clip e leva ao controle
   * do efeito no painel da direita, com um destaque rápido.
   */
  function focusSection(clipId, key) {
    window.selectClip?.(clipId);
    window.__renderProps?.();
    const sections = document.querySelectorAll(`#propsContent .fx-props[data-clip-id="${CSS.escape(clipId)}"]`);
    const second = ['transition', 'in', 'out'].includes(key);
    const section = sections[second ? 1 : 0];
    if (!section) return;
    const path = { look: 'look', adjust: 'adjust.', motion: 'motion.type', flip: null, transition: 'transition.type', in: 'in.type', out: 'out.type' }[key];
    const control = key === 'blend' ? section.querySelector('[data-blend]') : (path ? section.querySelector(`[data-fx^="${path}"]`) : null);
    const target = control?.closest('.prop-row') || section;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('fx-flash');
    void target.offsetWidth;
    target.classList.add('fx-flash');
    setTimeout(() => target.classList.remove('fx-flash'), 1400);
  }
  // #endregion

  /**
   * Número ao lado de um slider (.fx-val[data-edit]): clique vira campo;
   * Enter/sair aplica (dispara input + change no slider, com undo), Esc cancela.
   * data-max permite digitar além do fim do slider (ex.: escala 2000%).
   */
  function initNumberEdit() {
    document.getElementById('propsContent')?.addEventListener('click', e => {
      const label = e.target.closest('.fx-val[data-edit]');
      if (!label || label.querySelector('input')) return;
      const range = label.parentElement.querySelector('input[type="range"]');
      if (!range) return;
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'fx-val-input';
      input.step = range.step || 'any';
      input.min = range.min;
      input.max = label.dataset.max || range.max;
      input.value = parseFloat(label.textContent) || range.value;
      const previous = label.textContent;
      label.textContent = '';
      label.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        const value = Number(input.value);
        label.textContent = previous;
        if (!commit || !Number.isFinite(value)) return;
        const max = Number(label.dataset.max || range.max);
        const clamped = Math.min(max, Math.max(Number(range.min), value));
        // Slider limita no próprio max: guarda o valor digitado para quem lê
        range.max = String(Math.max(Number(range.max), clamped));
        range.value = String(clamped);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
      };
      input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        ev.stopPropagation();   // atalhos do editor não roubam as teclas
      });
      input.addEventListener('blur', () => finish(true));
    });
  }

  window.__renderFxProps = renderProps;
  window.__fxSample = SAMPLE;   // custom-assets.js: mesma imagem nos cards do usuário
  window.__fxUpdate = updateFx;
  window.__fxApply = (kind, id) => applyCard(kind, id, targetClips());   // paleta de comandos
  window.__fxFocus = focusSection;

  function boot() {
    buildTabs();
    initPropsEvents();
    initNumberEdit();
    initTimelineDrop();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
