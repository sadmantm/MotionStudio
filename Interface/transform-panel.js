'use strict';
// transform-panel.js
//
//  Seção "Transformar" do painel do clip: escala (% do tamanho encaixado),
//  posição (centro do clip em relação ao centro do quadro, como no CapCut),
//  rotação, Ajustar/Preencher, alinhamento e espelhar. Mesmo histórico de
//  undo da timeline; a caixa do preview acompanha.

(() => {
  const st = () => window.__appState;
  let undoArmed = false;

  const fmt = v => (Math.round(v * 10) / 10).toString();

  function metrics(clip) {
    const R = st().project.res;
    const tx = clip._tx || window.__frameClip?.(clip.id, 'fit') || { x: 0, y: 0, w: R.w, h: R.h, r: 0 };
    const fit = window.__frameClip?.(clip.id, 'fit') || { w: R.w, h: R.h };
    const m = {
      tx,
      scale: tx.w / Math.max(1, fit.w) * 100,
      x: tx.x + tx.w / 2 - R.w / 2,
      y: tx.y + tx.h / 2 - R.h / 2,
      r: ((((tx.r || 0) + 180) % 360) + 360) % 360 - 180,
      fit,
    };
    // Propriedades com keyframes mostram o valor da agulha
    const KF = window.ClipKF;
    ['scale', 'x', 'y', 'r'].forEach(p => { if (KF?.keys(clip, p)) m[p] = KF.valueAt(clip, p, st().time); });
    return m;
  }

  function render(clip, tmpl) {
    if (!clip || !st()?.project || tmpl?.type === 'audio' || tmpl?.layer?.kind === 'camera') return '';
    const m = metrics(clip);
    const fx = clip.fx || {};
    return `
      <div class="prop-section tf-props" data-clip-id="${clip.id}">
        <div class="prop-title fx-title">Transformar
          <button class="fx-clear" data-tf-action="reset" title="Enquadramento original, sem rotação">reset</button>
        </div>
        <div class="prop-row fx-slider">
          <label>Escala</label>
          <input type="range" class="prop-range" min="5" max="400" step="1" value="${Math.round(m.scale)}" data-tf="scale" data-default="100">
          <span class="fx-val" data-edit data-unit="%" data-max="2000">${Math.round(m.scale)}%</span>
          ${window.ClipKF?.controls(clip, 'scale') || ''}
        </div>
        <div class="prop-row tf-pos">
          <label>Posição</label>
          <span class="tf-axis">X</span><input type="number" class="prop-input" step="1" value="${Math.round(m.x)}" data-tf="x" title="Centro do clip em relação ao centro do quadro (px)">
          <span class="tf-axis">Y</span><input type="number" class="prop-input" step="1" value="${Math.round(m.y)}" data-tf="y">
          ${window.ClipKF?.controls(clip, 'pos') || ''}
        </div>
        <div class="prop-row fx-slider">
          <label>Rotação</label>
          <input type="range" class="prop-range" min="-180" max="180" step="1" value="${Math.round(m.r)}" data-tf="r" data-default="0">
          <span class="fx-val" data-edit data-unit="°">${fmt(m.r)}°</span>
          ${window.ClipKF?.controls(clip, 'r') || ''}
        </div>
        <div class="tf-buttons">
          <button class="tf-btn" data-tf-action="fit" title="Encaixar no quadro sem cortar">Ajustar</button>
          <button class="tf-btn" data-tf-action="fill" title="Preencher o quadro (corta o excedente)">Preencher</button>
          <button class="tf-btn" data-tf-action="flipH" title="Espelhar na horizontal"${fx.flipH ? ' data-on' : ''}>⇋</button>
          <button class="tf-btn" data-tf-action="flipV" title="Espelhar na vertical"${fx.flipV ? ' data-on' : ''}>⇵</button>
        </div>
        <div class="tf-buttons tf-align" title="Alinhar ao quadro">
          <button class="tf-btn" data-tf-align="left"   title="Esquerda">⇤</button>
          <button class="tf-btn" data-tf-align="hcenter" title="Centro horizontal">↔</button>
          <button class="tf-btn" data-tf-align="right"  title="Direita">⇥</button>
          <button class="tf-btn" data-tf-align="top"    title="Topo">⤒</button>
          <button class="tf-btn" data-tf-align="vcenter" title="Centro vertical">↕</button>
          <button class="tf-btn" data-tf-align="bottom" title="Base">⤓</button>
        </div>
      </div>`;
  }

  /** Grava a caixa nova no clip e no preview */
  function setTx(clip, next, { undo }) {
    if (undo) window.__tlPushUndo?.();
    clip._tx = { ...next };
    const entry = window.__Compositor?.get(clip.id);
    if (entry) {
      if (entry.isNative) window.__applyElementTransform?.(entry.iframe, clip);
      else window.__applyClipTransformStyle?.(entry.iframe, clip);
      window.__reapplyClipFx?.(clip.id);
    }
    window.__refreshTransformOverlay?.();
  }

  function fromControls(clip, key, value) {
    const R = st().project.res;
    const m = metrics(clip);
    const t = { ...m.tx };
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    if (key === 'scale') {
      // Mantém o centro e a proporção atual
      const aspect = t.w / Math.max(1, t.h);
      t.w = Math.max(4, m.fit.w * value / 100);
      t.h = t.w / aspect;
      t.x = cx - t.w / 2;
      t.y = cy - t.h / 2;
    }
    if (key === 'x') t.x = R.w / 2 + value - t.w / 2;
    if (key === 'y') t.y = R.h / 2 + value - t.h / 2;
    if (key === 'r') t.r = ((value % 360) + 360) % 360;
    return t;
  }

  function align(clip, where) {
    const R = st().project.res;
    const t = { ...metrics(clip).tx };
    if (where === 'left') t.x = 0;
    if (where === 'right') t.x = R.w - t.w;
    if (where === 'hcenter') t.x = (R.w - t.w) / 2;
    if (where === 'top') t.y = 0;
    if (where === 'bottom') t.y = R.h - t.h;
    if (where === 'vcenter') t.y = (R.h - t.h) / 2;
    return t;
  }

  function initEvents() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    const clipOf = el => st().clips.find(c => c.id === el.closest('.tf-props')?.dataset.clipId);

    props.addEventListener('input', e => {
      const ctl = e.target.closest('.tf-props [data-tf]');
      const clip = ctl && clipOf(ctl);
      if (!clip || ctl.type !== 'range') return;
      // Propriedade com keyframes: o controle cria/atualiza o keyframe da agulha
      if (window.ClipKF?.handleInput(clip, ctl.dataset.tf, Number(ctl.value), { undo: !undoArmed })) {
        undoArmed = true;
        const v = ctl.parentElement.querySelector('.fx-val');
        if (v) v.textContent = `${ctl.value}${v.dataset.unit || ''}`;
        return;
      }
      setTx(clip, fromControls(clip, ctl.dataset.tf, Number(ctl.value)), { undo: !undoArmed });
      undoArmed = true;
      const val = ctl.parentElement.querySelector('.fx-val');
      if (val) val.textContent = `${ctl.value}${val.dataset.unit || ''}`;
    });

    props.addEventListener('change', e => {
      const ctl = e.target.closest('.tf-props [data-tf]');
      const clip = ctl && clipOf(ctl);
      if (!clip) return;
      if (ctl.type === 'range') { undoArmed = false; window.__renderProps?.(); return; }
      const value = Number(ctl.value);
      if (!Number.isFinite(value)) return;
      if (window.ClipKF?.handleInput(clip, ctl.dataset.tf, value, { undo: true })) { window.__renderProps?.(); return; }
      setTx(clip, fromControls(clip, ctl.dataset.tf, value), { undo: true });
      window.__renderProps?.();
    });

    props.addEventListener('click', e => {
      const btn = e.target.closest('.tf-props [data-tf-action], .tf-props [data-tf-align]');
      const clip = btn && clipOf(btn);
      if (!clip) return;
      if (btn.dataset.tfAlign) {
        setTx(clip, align(clip, btn.dataset.tfAlign), { undo: true });
      } else {
        const action = btn.dataset.tfAction;
        if (action === 'fit' || action === 'fill' || action === 'reset') {
          const next = window.__frameClip(clip.id, action === 'fill' ? 'fill' : 'fit');
          if (action === 'reset') next.r = 0;
          setTx(clip, next, { undo: true });
        }
        if (action === 'flipH' || action === 'flipV') {
          window.__tlPushUndo?.();
          const fx = { ...(clip.fx || {}) };
          if (fx[action]) delete fx[action]; else fx[action] = true;
          if (Object.keys(fx).length) clip.fx = fx; else delete clip.fx;
          window.__reapplyClipFx?.(clip.id);
        }
      }
      window.__renderProps?.();
    });
  }

  window.__renderTransformProps = render;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEvents, { once: true });
  else initEvents();
})();
