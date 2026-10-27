'use strict';
// fx-timeline.js
//
//  Efeitos do clip, visíveis e editáveis direto no bloco da timeline:
//    • faixa de chips no rodapé do bloco: filtro, ajustes, movimento, espelhar
//      (valem pelo clip inteiro) e entrada / saída / transição (com a duração real)
//    • clicar num chip seleciona o clip e leva ao controle no painel da direita
//    • arrastar a borda interna de entrada/saída/transição muda a duração
//    • rampa translúcida no trecho que o efeito ocupa (como os fades de áudio)
//  Os dados são os de clip.fx (clip-fx.js); a edição passa por fx-panel.js
//  (updateFx), então desfazer, preview e export seguem a mesma regra.

(() => {
  const FX = () => window.ClipFX;
  const st = () => window.__appState;
  const MIN_CHIP = 20;   // px: chip curto continua clicável
  const ADJUST_NAMES = { brightness: 'Brilho', contrast: 'Contraste', saturation: 'Saturação', hue: 'Matiz', blur: 'Desfoque', opacity: 'Opacidade' };
  const EDGE = { transition: { icon: '⇄', cls: 'trans', label: 'Transição', map: 'TRANSITIONS' }, in: { icon: '▶', cls: 'in', label: 'Entrada', map: 'IN_OUT' }, out: { icon: '◀', cls: 'out', label: 'Saída', map: 'IN_OUT' } };

  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const num = (v, d = 1) => Number(v).toFixed(d).replace(/\.0$/, '');

  /** Chips que valem pelo clip inteiro */
  function spanChips(fx) {
    const chips = [];
    if (fx.look && fx.look !== 'none') {
      const name = FX().LOOKS[fx.look]?.label || fx.look;
      chips.push({ key: 'look', cls: 'look', icon: '◐', label: name, title: `Filtro: ${name}` });
    }
    const adjust = Object.entries(fx.adjust || {});
    if (adjust.length) {
      const parts = adjust.map(([k, v]) => `${ADJUST_NAMES[k] || k} ${k === 'opacity' || k === 'blur' ? num(v) : (v > 0 ? '+' : '') + num(v)}`);
      chips.push({ key: 'adjust', cls: 'adjust', icon: '☀', label: adjust.length > 1 ? `Ajustes ${adjust.length}` : ADJUST_NAMES[adjust[0][0]] || 'Ajuste', title: `Ajustes: ${parts.join(' · ')}` });
    }
    if (fx.motion?.type && fx.motion.type !== 'none') {
      const name = FX().MOTIONS[fx.motion.type] || fx.motion.type;
      chips.push({ key: 'motion', cls: 'motion', icon: '↗', label: name.replace(/\s*\(.*\)/, ''), title: `Movimento: ${name} · intensidade ${num(fx.motion.strength || 1)}×` });
    }
    if (fx.flipH || fx.flipV) {
      chips.push({ key: 'flip', cls: 'flip', icon: '⇋', label: 'Espelhado', title: `Espelhado${fx.flipH && fx.flipV ? ' (horizontal e vertical)' : fx.flipH ? ' na horizontal' : ' na vertical'}` });
    }
    return chips;
  }

  /** Entrada/saída/transição com a duração: a transição tem prioridade sobre a entrada (como no clip-fx.js) */
  function edgeChips(fx) {
    const list = [];
    if (FX().active(fx.transition)) list.push('transition');
    else if (FX().active(fx.in)) list.push('in');
    if (FX().active(fx.out)) list.push('out');
    return list;
  }

  const chipHtml = (c, extra = '') => `<button type="button" class="tl-fxc tl-fxc-${c.cls}" data-fx-key="${c.key}" title="${esc(c.title)} — clique para editar"${extra}>` +
    `<i>${c.icon}</i><span>${esc(c.label)}</span></button>`;

  function decorateBlock(block, clip, pxPerSec) {
    block.querySelectorAll('.tl-fx-mark, .tl-fxbar').forEach(el => el.remove());
    block.classList.remove('tl-has-fxbar');
    const fx = clip.fx || {};
    const blend = clip.blend && clip.blend !== 'normal' && FX()?.BLENDS?.[clip.blend] ? clip.blend : null;
    if (!FX() || (!FX().anyFx(clip.fx) && !blend)) return;

    const clipW = Math.max(4, clip.duration * pxPerSec - 1);
    const edges = edgeChips(fx);
    const spans = spanChips(fx);
    // Modo de mesclagem (Efeitos › Mesclagem ou botão direito no clip)
    if (blend) spans.push({ key: 'blend', cls: 'blend', icon: '◧', label: FX().BLENDS[blend], title: `Mesclagem: ${FX().BLENDS[blend]}` });

    // Rampas translúcidas no trecho que o efeito ocupa
    edges.forEach(kind => {
      const w = Math.min(Number(fx[kind].duration) * pxPerSec, clipW);
      const ramp = document.createElement('div');
      ramp.className = `tl-fx-mark tl-fx-${kind === 'transition' ? 'trans' : kind}`;
      ramp.style.width = `${w}px`;
      block.appendChild(ramp);
    });

    const bar = document.createElement('div');
    bar.className = 'tl-fxbar';
    let html = '';

    if (edges.length) {
      html += '<div class="tl-fxlane tl-fxlane-edge">' + edges.map(kind => {
        const e = EDGE[kind];
        const d = Number(fx[kind].duration);
        const name = FX()[e.map][fx[kind].type] || fx[kind].type;
        const w = Math.max(MIN_CHIP, Math.min(d * pxPerSec, clipW));
        const side = kind === 'out' ? 'right' : 'left';
        const title = `${e.label}: ${name} · ${num(d, 2)} s`;
        return `<div class="tl-fxe tl-fxe-${e.cls}" style="${side}:0;width:${w}px" data-edge="${kind}">` +
          chipHtml({ key: kind, cls: e.cls, icon: e.icon, label: w < 74 ? `${num(d)}s` : `${name} ${num(d)}s`, title }) +
          `<span class="tl-fxgrip tl-fxgrip-${kind === 'out' ? 'l' : 'r'}" data-grip="${kind}" title="Arraste para mudar a duração (${num(d, 2)} s)"></span></div>`;
      }).join('') + '</div>';
    }
    if (spans.length) {
      html += `<div class="tl-fxlane tl-fxlane-span">${spans.map(c => chipHtml(c)).join('')}</div>`;
    }
    bar.innerHTML = html;
    block.appendChild(bar);
    block.classList.add('tl-has-fxbar');
  }

  // #region Interação (captura: antes de o bloco iniciar o arrastar do clip)
  let tip = null;
  const showTip = (x, y, text) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tl-fx-tip'; document.body.appendChild(tip); }
    tip.textContent = text;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y - 28}px`;
  };
  const hideTip = () => { tip?.remove(); tip = null; };

  function clipOf(el) {
    const block = el.closest('.tl-block');
    const clip = block && st().clips.find(c => c.id === block.dataset.clipId);
    return clip ? { block, clip } : null;
  }

  /** Arrastar a borda interna: duração de entrada/saída/transição */
  function startGrip(e, kind, ctx) {
    const { clip } = ctx;
    if (!clip.fx?.[kind]) return;
    const pxPerSec = (window.__PX_PER_SEC || 80) * st().zoom;
    const startX = e.clientX;
    const d0 = Number(clip.fx[kind].duration);
    // Entrada e saída não se cruzam; transição divide o início com a entrada (que ela substitui)
    const other = kind === 'out' ? (FX().active(clip.fx.transition) ? clip.fx.transition : clip.fx.in) : clip.fx.out;
    const max = Math.max(0.1, clip.duration - (FX().active(other) ? Number(other.duration) : 0));
    let pushed = false;

    const move = ev => {
      const dx = (ev.clientX - startX) / pxPerSec;
      const d = Math.min(max, Math.max(0.1, Math.round((d0 + (kind === 'out' ? -dx : dx)) / 0.05) * 0.05));
      if (!pushed && Math.abs(ev.clientX - startX) > 2) {
        window.__tlPushUndo?.();
        pushed = true;
      }
      if (!pushed) return;
      window.__fxUpdate([clip], fx => { fx[kind] = { ...fx[kind], duration: d }; }, { undo: false });
      showTip(ev.clientX, ev.clientY, `${num(d, 2)} s`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      hideTip();
      document.body.classList.remove('tl-fx-resizing');
      if (pushed) window.__renderProps?.();
    };
    document.body.classList.add('tl-fx-resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function initEvents() {
    const tracks = document.getElementById('tlTracks');
    if (!tracks) return;
    tracks.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const grip = e.target.closest('.tl-fxgrip');
      const chip = e.target.closest('.tl-fxc');
      if (!grip && !chip) return;
      const ctx = clipOf(e.target);
      if (!ctx) return;
      e.stopPropagation();   // não inicia o arrastar do clip
      e.preventDefault();
      if (!window.__selectedClipIds?.has(ctx.clip.id)) window.selectClip?.(ctx.clip.id);
      if (grip) return startGrip(e, grip.dataset.grip, ctx);
      window.__fxFocus?.(ctx.clip.id, chip.dataset.fxKey);
    }, true);
  }
  // #endregion

  window.__decorateFxBlock = decorateBlock;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEvents, { once: true });
  else initEvents();
})();
