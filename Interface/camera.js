'use strict';
// camera.js
//
//  Câmera 2D (estilo After Effects): uma camada "Câmera 2D" (menu de contexto da timeline › Nova camada)
//  que move, aproxima e gira TUDO que está abaixo dela (tracks de menor número); o que fica acima
//  — legendas, logos — permanece fixo. Painel do clip:
//    • Posição X/Y (para onde a câmera olha, em px a partir do centro do quadro), Zoom e Rotação,
//      cada um com ◇ de keyframe (keyframes.js) e curvas (curves.js)
//    • Visão geral (volta ao enquadramento normal), "Mirar em elemento" (enquadra um elemento de uma
//      cena HTML na posição da agulha) e "Câmera com IA" (camera-ai.js)
//    • Ver sem câmera: mostra a cena inteira no preview (o export sempre aplica a câmera)
//  No preview, com a câmera selecionada: arrastar move a câmera, a roda do mouse aproxima, Shift+arrastar gira.
//  O cálculo (preview e export) é ClipFX.cameraTransform (clip-fx.js).

(() => {
  const st = () => window.__appState;
  const KF = () => window.ClipKF;
  const pushUndo = () => window.__tlPushUndo?.();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const round1 = v => Math.round(v * 10) / 10;

  const cameraOf = id => { const c = st().clips.find(x => x.id === id); return c && KF()?.isCamera(c) ? c : null; };
  const selectedCamera = () => cameraOf(st()?.currentClipId);

  // #region Painel do clip
  function render(clip, tmpl) {
    if (!clip || tmpl?.layer?.kind !== 'camera') return '';
    const t = st().time;
    const v = p => round1(KF().valueAt(clip, p, t));
    const id = esc(clip.id);
    const keyed = KF().CAMERA.some(p => KF().keys(clip, p));
    return `
      <div class="prop-section cam-props" data-clip-id="${id}">
        <div class="prop-title fx-title">Câmera 2D
          <button class="fx-clear" data-cam-action="overview" title="Enquadramento geral${keyed ? ' (cria um keyframe aqui)' : ''}: sem deslocamento, zoom 100%, sem giro">visão geral</button>
        </div>
        <p class="cam-hint">Move, aproxima e gira tudo que está <b>abaixo</b> desta camada. O que está acima fica fixo.</p>
        <div class="prop-row tf-pos">
          <label title="Para onde a câmera olha, em px a partir do centro do quadro">Olhar para</label>
          <span class="tf-axis">X</span><input type="number" class="prop-input" step="1" value="${v('camX')}" data-cam="camX">
          <span class="tf-axis">Y</span><input type="number" class="prop-input" step="1" value="${v('camY')}" data-cam="camY">
          ${KF().controls(clip, 'camPos')}
        </div>
        <div class="prop-row fx-slider">
          <label>Zoom</label>
          <input type="range" class="prop-range" min="25" max="400" step="1" value="${Math.round(v('camZoom'))}" data-cam="camZoom" data-default="100">
          <span class="fx-val" data-edit data-unit="%" data-max="800">${Math.round(v('camZoom'))}%</span>
          ${KF().controls(clip, 'camZoom')}
        </div>
        <div class="prop-row fx-slider">
          <label title="Positivo = a visão gira no sentido horário">Rotação</label>
          <input type="range" class="prop-range" min="-45" max="45" step="0.5" value="${v('camR')}" data-cam="camR" data-default="0">
          <span class="fx-val" data-edit data-unit="°" data-max="180">${v('camR')}°</span>
          ${KF().controls(clip, 'camR')}
        </div>
        <div class="tf-buttons cam-tools">
          <button class="tf-btn${window.__cameraBypass ? '' : ''}" data-cam-action="bypass"${window.__cameraBypass ? ' data-on' : ''} title="Mostra a cena sem a câmera no preview (o export sempre usa a câmera)">${window.__cameraBypass ? '👁 Sem câmera (ligado)' : '👁 Ver sem câmera'}</button>
          <button class="tf-btn" data-cam-action="aim" title="Enquadra um elemento das cenas HTML na posição da agulha">◎ Mirar em elemento</button>
        </div>
        <div class="tf-buttons">
          <button class="tf-btn cam-ai-btn" data-cam-action="ai" title="A IA planeja os movimentos pela fala e pela posição dos elementos">✨ Câmera com IA…</button>
        </div>
        ${keyed ? '<button class="cv-link cam-clear" data-cam-action="clear">remover todos os keyframes da câmera</button>' : ''}
        <p class="cam-hint cam-hint-sm">No preview: <b>arraste</b> para mover · <b>roda</b> = zoom · <b>Shift+arrastar</b> = girar.</p>
      </div>`;
  }

  /** Muda uma propriedade da câmera: com keyframes vira keyframe na agulha; senão, o valor fixo */
  function setProp(clip, prop, value, { undo = true } = {}) {
    if (KF().keys(clip, prop)) return KF().handleInput(clip, prop, value, { undo });
    if (undo) pushUndo();
    KF().setStatic(clip, prop, value);
    KF().syncAfterEdit(clip, { full: false });
    return true;
  }

  /** Vários valores de uma vez (um passo de undo); force = cria keyframes na agulha para todos */
  function setMany(clip, values, { force = false } = {}) {
    pushUndo();
    const t = st().time;
    Object.entries(values).forEach(([prop, v]) => {
      if (force || KF().keys(clip, prop)) {
        if (KF().insideClip(clip, t)) KF().addKey(clip, prop, t, v);
      } else KF().setStatic(clip, prop, v);
    });
    KF().syncAfterEdit(clip);
  }

  let armed = false;
  function onPanelEvents() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    const clipOf = el => cameraOf(el.closest('.cam-props')?.dataset.clipId);

    props.addEventListener('input', e => {
      const ctl = e.target.closest('.cam-props [data-cam]');
      const clip = ctl && clipOf(ctl);
      if (!clip || ctl.type !== 'range') return;
      setProp(clip, ctl.dataset.cam, Number(ctl.value), { undo: !armed });
      armed = true;
      const label = ctl.parentElement.querySelector('.fx-val');
      if (label) label.textContent = `${ctl.value}${label.dataset.unit || ''}`;
    });
    props.addEventListener('change', e => {
      const ctl = e.target.closest('.cam-props [data-cam]');
      const clip = ctl && clipOf(ctl);
      if (!clip) return;
      if (ctl.type === 'range') { armed = false; return; }
      const v = Number(ctl.value);
      if (!Number.isFinite(v)) return;
      setProp(clip, ctl.dataset.cam, v, { undo: true });
      window.__renderProps?.();
    });
    props.addEventListener('click', e => {
      const btn = e.target.closest('.cam-props [data-cam-action]');
      const clip = btn && clipOf(btn);
      if (!clip) return;
      const act = btn.dataset.camAction;
      if (act === 'overview') { setMany(clip, { camX: 0, camY: 0, camZoom: 100, camR: 0 }); window.__renderProps?.(); }
      if (act === 'bypass') toggleBypass();
      if (act === 'ai') window.MSCameraAI?.open(clip.id);
      if (act === 'aim') openAim(clip, btn);
      if (act === 'clear') clearKeys(clip);
    });
  }

  function clearKeys(clip) {
    pushUndo();
    const t = st().time;
    const now = {};
    KF().CAMERA.forEach(p => { now[p] = KF().valueAt(clip, p, t); });
    KF().CAMERA.forEach(p => { KF().setKeys(clip, p, []); KF().setStatic(clip, p, now[p]); });   // o valor da agulha vira o fixo
    KF().syncAfterEdit(clip);
    window.MSUI?.toast({ message: 'Keyframes da câmera removidos.', kind: 'info', duration: 5000, action: { label: 'Desfazer', onClick: () => window.__tlUndo?.() } });
  }
  // #endregion

  // #region Ver sem câmera
  function toggleBypass(force) {
    window.__cameraBypass = force == null ? !window.__cameraBypass : Boolean(force);
    window.__syncCompositorToTime?.(st().time);
    window.__refreshTransformOverlay?.();
    document.body.classList.toggle('cam-bypass', window.__cameraBypass);
    window.MSUI?.toast({ message: window.__cameraBypass ? 'Preview sem a câmera (o export continua com ela).' : 'Câmera ligada no preview.', kind: 'info', duration: 2200 });
    window.__renderProps?.();
    hud();
  }
  // #endregion

  // #region Arrastar no preview
  let drag = null;
  const previewScale = () => {
    const w = document.getElementById('previewWrapper');
    const res = st().project?.res;
    return w && res ? (w.getBoundingClientRect().width / res.w) || 1 : 1;
  };
  const rad = deg => deg * Math.PI / 180;

  function initPreview() {
    const outer = document.getElementById('previewOuter');
    if (!outer) return;
    outer.addEventListener('mousedown', e => {
      const clip = selectedCamera();
      if (!clip || e.button !== 0 || window.__cameraBypass) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { clip, x: e.clientX, y: e.clientY, pushed: false, base: { camX: KF().valueAt(clip, 'camX', st().time), camY: KF().valueAt(clip, 'camY', st().time), camZoom: KF().valueAt(clip, 'camZoom', st().time), camR: KF().valueAt(clip, 'camR', st().time) }, rotate: e.shiftKey };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
    }, true);
    outer.addEventListener('wheel', e => {
      const clip = selectedCamera();
      if (!clip || window.__cameraBypass) return;
      e.preventDefault();
      const z = KF().valueAt(clip, 'camZoom', st().time);
      const next = Math.max(25, Math.min(800, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      setProp(clip, 'camZoom', Math.round(next * 10) / 10, { undo: !wheelArmed });
      wheelArmed = true;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelArmed = false; window.__renderProps?.(); }, 350);
    }, { passive: false, capture: true });
  }
  let wheelArmed = false, wheelTimer = null;

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.pushed && Math.abs(dx) + Math.abs(dy) < 3) return;
    const { clip, base } = drag;
    const undo = !drag.pushed;
    drag.pushed = true;
    if (drag.rotate) {
      setProp(clip, 'camR', Math.max(-180, Math.min(180, round1(base.camR + dx * 0.25))), { undo });
    } else {
      // arrastar o conteúdo para a direita = a câmera passa a olhar mais para a esquerda
      // (o deslocamento da tela volta pela rotação e pelo zoom da câmera — ver ClipFX.cameraTransform)
      const k = previewScale();
      const z = Math.max(0.05, base.camZoom / 100);
      const r = rad(base.camR);
      const ddx = dx / k, ddy = dy / k;
      setProp(clip, 'camX', Math.round(base.camX - (ddx * Math.cos(r) - ddy * Math.sin(r)) / z), { undo });
      setProp(clip, 'camY', Math.round(base.camY - (ddx * Math.sin(r) + ddy * Math.cos(r)) / z), { undo: false });
    }
    refreshPanel();
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    if (drag?.pushed) window.__renderProps?.();
    drag = null;
  }

  /** Números do painel acompanham o gesto sem refazer o painel */
  function refreshPanel() {
    window.__kfOnTime?.(st().time);
    const c = drag?.clip;
    if (!c) return;
    ['camX', 'camY', 'camR'].forEach(p => {
      const input = document.querySelector(`#propsContent [data-cam="${p}"]`);
      if (!input) return;
      const v = round1(KF().valueAt(c, p, st().time));
      input.value = v;
      const label = input.parentElement.querySelector('.fx-val');
      if (label) label.textContent = `${v}${label.dataset.unit || ''}`;
    });
  }
  // #endregion

  // #region Aviso no preview
  let hudEl = null;
  function hud() {
    const cont = document.getElementById('previewContainer');
    if (!cont) return;
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.className = 'cam-hud';
      cont.appendChild(hudEl);
    }
    const clip = selectedCamera();
    hudEl.hidden = !clip;
    if (clip) {
      hudEl.innerHTML = window.__cameraBypass
        ? '📷 <b>Câmera 2D</b> · vendo a cena <b>sem a câmera</b> <button type="button" data-cam-hud="bypass">ligar</button>'
        : '📷 <b>Câmera 2D</b> · arraste = mover · roda = zoom · Shift+arrastar = girar';
    }
  }
  // #endregion

  // #region Mirar em elemento
  let aimMenu = null;
  const closeAim = () => { aimMenu?.remove(); aimMenu = null; };

  async function openAim(clip, anchor) {
    closeAim();
    if (!window.MSCameraAI?.probeAt) return window.MSUI.toast({ message: 'Módulo de análise da cena indisponível.', kind: 'warn' });
    const r = anchor.getBoundingClientRect();
    aimMenu = document.createElement('div');
    aimMenu.className = 'ctx-menu ly-menu cam-aim';
    aimMenu.style.cssText = `display:block;left:${Math.max(8, r.left - 40)}px;top:${r.bottom + 4}px;max-height:320px;overflow:auto`;
    aimMenu.innerHTML = '<div class="ly-head">Analisando a cena…</div>';
    document.body.appendChild(aimMenu);
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (aimMenu && !aimMenu.contains(e.target)) { closeAim(); document.removeEventListener('mousedown', off, true); } }, true), 0);
    let items = [];
    try { items = await window.MSCameraAI.probeAt(clip, st().time); } catch (err) { console.warn('[Câmera] análise falhou:', err); }
    if (!aimMenu) return;
    if (!items.length) {
      aimMenu.innerHTML = '<div class="ly-head">Nenhum elemento encontrado</div><div class="cam-hint" style="padding:4px 10px 8px;max-width:240px">Só clips HTML <b>abaixo</b> da câmera, visíveis nesta posição da agulha, entram na lista.</div>';
      return;
    }
    aimMenu.innerHTML = '<div class="ly-head">Mirar em…</div>' + items.map((it, i) =>
      `<div class="ctx-item ly-item" data-i="${i}"><span class="ly-label">${esc(it.text || it.label)}</span><span class="ctx-shortcut">${esc(it.kind)} · ${Math.round(it.w)}×${Math.round(it.h)}</span></div>`).join('');
    aimMenu.addEventListener('click', ev => {
      const row = ev.target.closest('.ly-item');
      if (!row) return;
      const it = items[Number(row.dataset.i)];
      closeAim();
      aimAt(clip, it);
    });
  }

  /** Enquadra um retângulo (centro x,y e tamanho w×h, em px do quadro): foco no centro, zoom que o contém com folga */
  function aimAt(clip, it, margin = 1.4) {
    const res = st().project.res;
    const zoom = Math.max(1, Math.min(3, Math.min(res.w / (it.w * margin), res.h / (it.h * margin))));
    const halfW = res.w / (2 * zoom), halfH = res.h / (2 * zoom);
    const fx = Math.max(halfW, Math.min(res.w - halfW, it.x));
    const fy = Math.max(halfH, Math.min(res.h - halfH, it.y));
    setMany(clip, { camX: Math.round(fx - res.w / 2), camY: Math.round(fy - res.h / 2), camZoom: Math.round(zoom * 100), camR: 0 }, { force: true });
    window.__renderProps?.();
  }
  // #endregion

  // #region Comandos
  function registerCommands() {
    const R = window.MSCmd?.register;
    if (!R) return;
    const anyCamera = () => st().project && st().clips.some(c => KF()?.isCamera(c));
    R({ id: 'camera-bypass', title: 'Câmera 2D: ver sem câmera (liga/desliga)', group: 'Efeitos e IA', keywords: 'camera preview', when: anyCamera, run: () => toggleBypass() });
    R({ id: 'camera-ai', title: 'Câmera 2D: gerar movimentos com IA…', group: 'Efeitos e IA', keywords: 'camera gemini fala', when: anyCamera, run: () => {
      const cam = selectedCamera() || st().clips.filter(c => KF().isCamera(c)).sort((a, b) => b.trackIndex - a.trackIndex)[0];
      if (cam) window.MSCameraAI?.open(cam.id);
    } });
  }
  // #endregion

  window.__renderCameraProps = render;
  window.MSCamera = { setProp, setMany, aimAt, toggleBypass, selectedCamera };

  function boot() {
    onPanelEvents();
    initPreview();
    registerCommands();
    document.addEventListener('click', e => { if (e.target.closest('[data-cam-hud="bypass"]')) toggleBypass(false); });
    // o aviso acompanha a seleção
    const prev = window.__onSelectionChange;
    window.__onSelectionChange = function () { try { prev?.apply(this, arguments); } finally { hud(); } };
    hud();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
