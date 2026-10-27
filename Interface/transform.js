// transform.js
'use strict';

/*
 * Caixa de transformação do preview (estilo CapCut):
 *   • arrastar o corpo move; Shift trava no eixo dominante; Ctrl desliga o snap
 *   • cantos escalam mantendo a proporção (Shift: livre; Alt: a partir do centro),
 *     também com o clip girado
 *   • alça circular abaixo gira (gruda em 0/90/180/270°; Shift: passos de 15°)
 *   • Alt + roda do mouse escala; barra com Ajustar, Preencher, Snap e Reset
 * Undo: o da timeline (o snapshot guarda o _tx de todos os clips).
 */
;(function () {

  const HANDLE_SIZE = 11;
  const MIN_SIZE    = 16;
  const SNAP_THRESH = 14;   // px do projeto
  const ROT_SNAP    = 4;    // graus para grudar em múltiplos de 90°

  let overlay      = null;
  let box          = null;
  let bar          = null;
  let knob         = null;
  let angleTip     = null;
  let snapLines    = null;
  let activeClipId = null;

  let _groupMode    = false;      // true quando há múltiplos clips selecionados
  let _groupIds     = [];         // ids dos clips no grupo
  let _groupOffsets = new Map();  // clipId → {dx, dy, dw, dh} relativo ao bbox do grupo

  let tx   = { x: 0, y: 0, w: 0, h: 0, r: 0 };
  let drag = null;
  let _snapEnabled = true;

  const st  = () => window.__appState;
  const res = () => st()?.project?.res || { w: 1080, h: 1920 };

  // ── init ─────────────────────────────────────────────────────────────────
  function init() {
    injectCSS();

    overlay = document.createElement('div');
    overlay.id = 'transformOverlay';
    overlay.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:30; overflow:visible; display:none;';

    box = document.createElement('div');
    box.id = 'transformBox';

    // Só os cantos: escala uniforme (as laterais esticavam e distorciam o clip)
    ['nw', 'ne', 'se', 'sw'].forEach(h => {
      const el = document.createElement('div');
      el.className = `tx-handle tx-handle-${h}`;
      el.dataset.handle = h;
      el.title = 'Arraste para escalar (Shift: livre · Alt: a partir do centro)';
      el.addEventListener('mousedown', onHandleDown);
      box.appendChild(el);
    });

    knob = document.createElement('div');
    knob.className = 'tx-rot-knob';
    knob.title = 'Arraste para girar (Shift: 15° · clique duplo: 0°)';
    knob.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`;
    knob.addEventListener('mousedown', onRotateDown);
    knob.addEventListener('dblclick', () => setRotation(0));
    box.appendChild(knob);

    angleTip = document.createElement('div');
    angleTip.className = 'tx-angle-tip';
    box.appendChild(angleTip);

    bar = document.createElement('div');
    bar.id = 'transformBar';
    bar.innerHTML = `
      <button class="tx-bar-btn" data-tx="fit" title="Encaixar no quadro sem cortar">Ajustar</button>
      <button class="tx-bar-btn" data-tx="fill" title="Preencher o quadro (corta o excedente)">Preencher</button>
      <div class="tx-vsep"></div>
      <button class="tx-bar-btn" id="txBtnSnap" data-tx="snap" title="Snap nas bordas, no centro e nos outros clips (Ctrl durante o arraste desliga)" data-active="true">Snap</button>
      <div class="tx-vsep"></div>
      <button class="tx-bar-btn" data-tx="reset" title="Voltar ao enquadramento original, sem rotação">Reset</button>
    `;
    box.appendChild(bar);
    bar.addEventListener('mousedown', e => e.stopPropagation());
    bar.addEventListener('click', e => {
      const btn = e.target.closest('[data-tx]');
      if (!btn) return;
      const act = btn.dataset.tx;
      if (act === 'fit') frameClips('fit');
      if (act === 'fill') frameClips('fill');
      if (act === 'reset') frameClips('fit', { resetRotation: true });
      if (act === 'snap') {
        _snapEnabled = !_snapEnabled;
        btn.dataset.active = _snapEnabled ? 'true' : 'false';
      }
    });

    snapLines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    snapLines.id = 'txSnapLines';
    snapLines.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:29; overflow:visible;';

    overlay.appendChild(snapLines);
    overlay.appendChild(box);

    box.addEventListener('mousedown', onBoxDown);
    box.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', scheduleRepos);

    const _orig = window.__syncPreviewSize;
    window.__syncPreviewSize = function () {
      _orig?.apply(this, arguments);
      scheduleRepos();
    };

    const ro = new ResizeObserver(scheduleRepos);
    ['previewScroll', 'center', 'previewOuter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    });

    let _last = null;
    setInterval(() => {
      const cur = st()?.currentClipId || null;
      if (cur === _last) return;
      _last = cur;
      // Mesma regra da seleção: áudio selecionado junto não esconde a caixa do grupo
      const sel = window.__getSelectedClipIds?.() || [];
      if (sel.length) window.__onSelectionChange(new Set(sel));
      else cur ? show(cur) : hide();
    }, 80);

    window.__showTransformOverlay  = show;
    window.__hideTransformOverlay  = hide;
    window.__clearTransformOverlay = hide;
    window.__getClipTransform      = id => getClip(id)?._tx || null;
    window.__applyClipTransform    = (id, t) => {
      const c = getClip(id);
      if (!c) return;
      c._tx = { ...t };
      if (id === activeClipId) { tx = { ...t }; positionBox(); }
    };
    // Enquadramentos usados também pelo painel Transformar (transform-panel.js)
    window.__frameClip = (clipId, mode) => frameFor(getClip(clipId), mode);
  }

  let _reposTimer = null;
  function scheduleRepos() {
    clearTimeout(_reposTimer);
    _reposTimer = setTimeout(() => { if (activeClipId) positionBox(); }, 16);
  }

  // ── DOM / coordenadas ─────────────────────────────────────────────────────
  function getWrapper() { return document.getElementById('previewWrapper'); }
  function getOuter()   { return document.getElementById('previewOuter'); }

  function getScale() {
    const m = getWrapper()?.style.transform.match(/scale\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  }

  function wrapperOrigin() {
    const outer  = getOuter();
    const scale  = getScale();
    const outerW = outer?.offsetWidth || res().w * scale;
    return { left: (outerW - res().w * scale) / 2, top: 0 };
  }

  /** Ponto da tela → coordenadas do projeto */
  function toProject(clientX, clientY) {
    const rect = getWrapper().getBoundingClientRect();
    const s = getScale();
    return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s };
  }

  const rotate = (v, deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  };

  // ── Enquadramentos (ajustar / preencher) ──────────────────────────────────
  function templateOf(clip) {
    return st()?.templates?.find(t => t.id === clip?.templateId) || null;
  }

  /**
   * Caixa do clip encaixada (fit) ou cobrindo o quadro (fill), sem distorcer.
   * Vídeo/imagem: proporção da mídia. HTML/texto: são desenhados no tamanho do
   * projeto, então o original é o quadro inteiro.
   */
  function frameFor(clip, mode = 'fit') {
    const R = res();
    const tmpl = templateOf(clip);
    const media = tmpl && (tmpl.type === 'video' || tmpl.type === 'image') && tmpl.res?.w && tmpl.res?.h;
    const srcW = media ? tmpl.res.w : R.w;
    const srcH = media ? tmpl.res.h : R.h;
    const k = mode === 'fill' ? Math.max(R.w / srcW, R.h / srcH) : Math.min(R.w / srcW, R.h / srcH);
    const w = Math.round(srcW * k), h = Math.round(srcH * k);
    return { x: Math.round((R.w - w) / 2), y: Math.round((R.h - h) / 2), w, h, r: clip?._tx?.r || 0 };
  }

  /** Ajustar/Preencher/Reset nos clips da caixa (grupo: cada um no próprio) */
  function frameClips(mode, { resetRotation = false } = {}) {
    const ids = _groupMode ? _groupIds : [activeClipId];
    if (!ids.length || !ids[0]) return;
    window.__tlPushUndo?.();
    ids.forEach(id => {
      const c = getClip(id);
      if (!c) return;
      const next = frameFor(c, mode);
      if (resetRotation) next.r = 0;
      c._tx = next;
      c._txNat = null;
      applyClip(id);
    });
    if (_groupMode) computeGroupBBox(); else tx = { ...getClip(activeClipId)._tx };
    positionBox();
    save();
  }

  function setRotation(deg) {
    if (!activeClipId || _groupMode) return;
    window.__tlPushUndo?.();
    tx.r = deg;
    positionBox();
    applyLive();
    save();
  }

  // ── Snap ──────────────────────────────────────────────────────────────────
  function getSnapCandidates() {
    const state = st();
    if (!state?.clips) return [];
    const R = res();
    const lines = [
      { axis: 'x', v: 0 }, { axis: 'x', v: R.w }, { axis: 'x', v: R.w / 2 },
      { axis: 'y', v: 0 }, { axis: 'y', v: R.h }, { axis: 'y', v: R.h / 2 },
    ];
    const skip = new Set(_groupMode ? _groupIds : [activeClipId]);
    const t = state.time;
    state.clips.forEach(clip => {
      // Só clips visíveis agora (antes: todos os da timeline, inclusive escondidos)
      if (skip.has(clip.id) || !clip._tx || t < clip.start || t >= clip.start + clip.duration) return;
      const b = clip._tx;
      lines.push({ axis: 'x', v: b.x }, { axis: 'x', v: b.x + b.w }, { axis: 'x', v: b.x + b.w / 2 });
      lines.push({ axis: 'y', v: b.y }, { axis: 'y', v: b.y + b.h }, { axis: 'y', v: b.y + b.h / 2 });
    });
    return lines;
  }

  /** Move a caixa para encostar no candidato mais próximo (bordas e centro) */
  function applySnap(proposed, { lockX = false, lockY = false } = {}) {
    const hints = { x: [], y: [] };
    if (!_snapEnabled) return { tx: proposed, hints };
    const candidates = getSnapCandidates();
    const best = (values, axis) => {
      let pick = null;
      values.forEach(v => candidates.forEach(c => {
        if (c.axis !== axis) return;
        const d = c.v - v;
        if (Math.abs(d) < SNAP_THRESH && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d, line: c.v };
      }));
      return pick;
    };
    const out = { ...proposed };
    if (!lockX) {
      const p = best([proposed.x, proposed.x + proposed.w / 2, proposed.x + proposed.w], 'x');
      if (p) { out.x += p.d; hints.x.push(p.line); }
    }
    if (!lockY) {
      const p = best([proposed.y, proposed.y + proposed.h / 2, proposed.y + proposed.h], 'y');
      if (p) { out.y += p.d; hints.y.push(p.line); }
    }
    return { tx: out, hints };
  }

  function drawSnapGuides(hints) {
    clearSnapGuides();
    if (!snapLines) return;
    const scale = getScale();
    const origin = wrapperOrigin();
    const W = res().w * scale, H = res().h * scale;
    const line = (x1, y1, x2, y2, color = '#ff4fa0') => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', color);
      l.setAttribute('stroke-width', '1.5');
      l.setAttribute('stroke-dasharray', '5 4');
      snapLines.appendChild(l);
    };
    (hints.x || []).forEach(v => { const px = origin.left + v * scale; line(px, origin.top, px, origin.top + H); });
    (hints.y || []).forEach(v => { const py = origin.top + v * scale; line(origin.left, py, origin.left + W, py); });
  }

  function clearSnapGuides() {
    if (!snapLines) return;
    while (snapLines.firstChild) snapLines.removeChild(snapLines.firstChild);
  }

  // ── show / hide ───────────────────────────────────────────────────────────
  function show(clipId) {
    const clip = getClip(clipId);
    if (!clip) return;
    // Áudio e câmera 2D não têm caixa no preview (a câmera se arrasta pelo preview, camera.js)
    if (templateOf(clip)?.type === 'audio' || window.ClipKF?.isCamera(clip)) return hide();
    activeClipId = clipId;

    if (!clip._tx) clip._tx = frameFor(clip, 'fit');
    // Com keyframes de posição/escala/rotação a caixa mostra o enquadramento da agulha
    tx = window.ClipKF?.hasTransformKeys(clip) ? window.ClipKF.animatedBox(clip, st()?.time ?? 0) : { ...clip._tx };

    const outer = getOuter();
    if (outer && !outer.contains(overlay)) {
      outer.style.position = 'relative';
      outer.appendChild(overlay);
    }
    overlay.style.display = '';

    // Seleção múltipla (áudio não tem caixa e fica fora do grupo)
    const selIds = (window.__getSelectedClipIds?.() || []).filter(id => !isAudioClip(id));
    if (selIds.length > 1) {
      _groupMode = true;
      _groupIds  = selIds;
      computeGroupBBox();
    } else {
      _groupMode = false;
      _groupIds  = [];
      _groupOffsets.clear();
    }
    box.classList.toggle('is-group', _groupMode);
    positionBox();
  }

  // ── Bounding box do grupo e offsets de cada clip ──────────────────────────
  function computeGroupBBox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    _groupIds.forEach(id => {
      const c = getClip(id);
      if (!c) return;
      if (!c._tx) c._tx = frameFor(c, 'fit');
      const t = c._tx;
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.w);
      maxY = Math.max(maxY, t.y + t.h);
    });
    tx = { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0 };
    _groupOffsets.clear();
    _groupIds.forEach(id => {
      const c = getClip(id);
      if (!c?._tx) return;
      _groupOffsets.set(id, { dx: c._tx.x - minX, dy: c._tx.y - minY, dw: c._tx.w, dh: c._tx.h, r: c._tx.r || 0 });
    });
  }

  function applyGroupTx(newTx) {
    const base = drag?.groupStartTx || newTx;
    const scaleX = newTx.w / (base.w || 1);
    const scaleY = newTx.h / (base.h || 1);
    _groupIds.forEach(id => {
      const c = getClip(id);
      const off = _groupOffsets.get(id);
      if (!c || !off) return;
      c._tx = { x: newTx.x + off.dx * scaleX, y: newTx.y + off.dy * scaleY, w: off.dw * scaleX, h: off.dh * scaleY, r: off.r };
    });
  }

  function hide() {
    if (overlay) overlay.style.display = 'none';
    clearSnapGuides();
    activeClipId = null;
  }

  // ── Caixa na tela ─────────────────────────────────────────────────────────
  function positionBox() {
    if (!box || !activeClipId) return;
    const scale  = getScale();
    const origin = wrapperOrigin();
    // Com uma câmera 2D ativa acima do clip a caixa mostra onde ele aparece na tela (só leitura)
    const clip = _groupMode ? null : getClip(activeClipId);
    const view = (clip && window.ClipKF?.cameraViewBox(clip, tx, st()?.time ?? 0)) || tx;
    box.classList.toggle('cam-locked', view !== tx);
    box.title = view !== tx ? 'A câmera 2D está ativa neste instante: a caixa mostra onde o clip aparece. Use “Ver sem câmera” (painel da câmera) para editar o enquadramento.' : '';
    box.style.left      = (origin.left + view.x * scale) + 'px';
    box.style.top       = (origin.top  + view.y * scale) + 'px';
    box.style.width     = (view.w * scale) + 'px';
    box.style.height    = (view.h * scale) + 'px';
    box.style.transform = `rotate(${view.r}deg)`;
    angleTip.textContent = `${Math.round(((tx.r + 180) % 360 + 360) % 360 - 180)}°`;
  }

  /** Grava a caixa nova no preview (mantendo os efeitos do clip) */
  function applyClip(id) {
    const clip = getClip(id);
    const entry = window.__Compositor?.get(id);
    if (!entry || !clip) return;
    if (entry.isNative) window.__applyElementTransform?.(entry.iframe, clip);
    else                window.__applyClipTransformStyle?.(entry.iframe, clip);
    window.__reapplyClipFx?.(id);
  }

  /** Gira cada clip em torno do centro do grupo (posição e ângulo) */
  function applyGroupRotation(delta) {
    const { cx, cy, starts } = drag.groupRotate;
    starts.forEach((s, id) => {
      const c = getClip(id);
      if (!c) return;
      const o = rotate({ x: s.x + s.w / 2 - cx, y: s.y + s.h / 2 - cy }, delta);
      c._tx = { x: cx + o.x - s.w / 2, y: cy + o.y - s.h / 2, w: s.w, h: s.h, r: (((s.r || 0) + delta) % 360 + 360) % 360 };
    });
  }

  function applyLive() {
    if (_groupMode) {
      if (drag?.type === 'rotate' && drag.groupRotate) applyGroupRotation(tx.r);
      else applyGroupTx(tx);
      _groupIds.forEach(applyClip);
      return;
    }
    const clip = getClip(activeClipId);
    if (!clip) return;
    // Propriedades com keyframes viram keyframe na agulha; as demais vão para a caixa fixa
    if (!window.ClipKF?.commitBox(clip, tx)) clip._tx = { ...tx };
    applyClip(activeClipId);
  }

  function save() {
    if (_groupMode) {
      computeGroupBBox();
      positionBox();
      window.__onGroupTransformed?.();
    } else {
      const clip = getClip(activeClipId);
      if (clip && !window.ClipKF?.commitBox(clip, tx)) clip._tx = { ...tx };
      if (clip) window.ClipKF?.syncAfterEdit(clip, { full: false });
    }
    window.__syncCompositorToTime?.(st()?.time ?? 0);
    window.__renderProps?.();   // números do painel Transformar
  }

  window.__onSelectionChange = function (selSet) {
    const ids = [...selSet];
    const cur = st()?.currentClipId;
    const primary = ids.includes(cur) && !isAudioClip(cur) ? cur : ids.find(id => !isAudioClip(id));
    if (!primary) { hide(); return; }
    show(primary);
  };

  function isAudioClip(id) {
    return templateOf(getClip(id))?.type === 'audio';
  }

  // Reposiciona a caixa depois de mudanças feitas por fora (painéis, undo)
  window.__refreshTransformOverlay = function () {
    if (activeClipId && getClip(activeClipId)) show(activeClipId);
  };

  function getClip(id) {
    return st()?.clips?.find(c => c.id === id) || null;
  }

  // ── Gestos ────────────────────────────────────────────────────────────────
  /** Um passo de undo por gesto, só quando algo muda de fato */
  function touch() {
    if (drag && !drag.touched) {
      drag.touched = true;
      window.__tlPushUndo?.();
      box.classList.add('is-dragging');
    }
  }

  function onBoxDown(e) {
    if (e.target.closest('.tx-handle, #transformBar, .tx-rot-knob')) return;
    // Shift/Cmd/Ctrl+clique é seleção (group-edit.js), não arraste
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    drag = { type: 'move', startX: e.clientX, startY: e.clientY, startTx: { ...tx } };
  }

  function onHandleDown(e) {
    e.preventDefault(); e.stopPropagation();
    const h = e.currentTarget.dataset.handle;
    const startTx = { ...tx };
    const sx = h.includes('e') ? 1 : -1;
    const sy = h.includes('s') ? 1 : -1;
    const center = { x: startTx.x + startTx.w / 2, y: startTx.y + startTx.h / 2 };
    const anchorLocal = { x: -sx * startTx.w / 2, y: -sy * startTx.h / 2 };
    const a = rotate(anchorLocal, startTx.r || 0);
    drag = {
      type: 'resize', sx, sy, startTx, center,
      anchor: { x: center.x + a.x, y: center.y + a.y },
      groupStartTx: _groupMode ? { ...tx } : null,
    };
  }

  function onRotateDown(e) {
    e.preventDefault(); e.stopPropagation();
    const rect = box.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    drag = { type: 'rotate', cx, cy, startAngle: Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI, startR: tx.r };
    if (_groupMode) {
      drag.startR = 0;
      tx.r = 0;
      drag.groupRotate = {
        cx: tx.x + tx.w / 2,
        cy: tx.y + tx.h / 2,
        starts: new Map(_groupIds.map(id => [id, { ...(getClip(id)?._tx || {}) }]).filter(([, t]) => 'x' in t)),
      };
    }
    box.classList.add('is-rotating');
  }

  /** Alt + roda: escala a partir do centro */
  function onWheel(e) {
    if (!e.altKey || !activeClipId) return;
    e.preventDefault();
    e.stopPropagation();
    // Um passo de undo por "giro" da roda (eventos a menos de 200 ms juntos)
    if (!onWheel._active) window.__tlPushUndo?.();
    onWheel._active = true;
    const k = Math.exp(-e.deltaY * 0.0015);
    const cx = tx.x + tx.w / 2, cy = tx.y + tx.h / 2;
    const w = Math.max(MIN_SIZE, tx.w * k), h = Math.max(MIN_SIZE, tx.h * k);
    tx = { ...tx, x: cx - w / 2, y: cy - h / 2, w, h };
    positionBox();
    applyLive();
    clearTimeout(onWheel._t);
    onWheel._t = setTimeout(() => { onWheel._active = false; save(); }, 200);
  }

  function onMouseMove(e) {
    if (!drag || !activeClipId) return;

    if (drag.type === 'move') {
      const s = getScale();
      let dx = (e.clientX - drag.startX) / s;
      let dy = (e.clientY - drag.startY) / s;
      if (!drag.touched && Math.hypot(dx * s, dy * s) < 3) return;
      touch();
      // Shift: trava no eixo dominante (o outro fica onde estava)
      const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx);
      const lockY = e.shiftKey && !lockX;
      if (lockX) dx = 0;
      if (lockY) dy = 0;
      const proposed = { ...tx, x: drag.startTx.x + dx, y: drag.startTx.y + dy };
      const snapped = e.ctrlKey || e.metaKey ? { tx: proposed, hints: { x: [], y: [] } } : applySnap(proposed, { lockX, lockY });
      tx = snapped.tx;
      drawSnapGuides(snapped.hints);
    }

    if (drag.type === 'resize') {
      touch();
      const { sx, sy, startTx: s, center, anchor } = drag;
      const fromCenter = e.altKey;
      const origin = fromCenter ? center : anchor;
      const p = toProject(e.clientX, e.clientY);
      // Vetor origem → ponteiro no referencial do clip (desfaz a rotação)
      const v = rotate({ x: p.x - origin.x, y: p.y - origin.y }, -(s.r || 0));
      const span = fromCenter ? 0.5 : 1;   // do centro, o canto está a meia caixa
      let w, h;
      if (e.shiftKey) {
        w = Math.max(MIN_SIZE, sx * v.x / span);
        h = Math.max(MIN_SIZE, sy * v.y / span);
      } else {
        // Projeção na diagonal da caixa: escala uniforme que segue o mouse
        const d = { x: sx * s.w * span, y: sy * s.h * span };
        let k = (v.x * d.x + v.y * d.y) / (d.x * d.x + d.y * d.y);
        k = Math.max(MIN_SIZE / Math.min(s.w, s.h), k);
        // Gruda no tamanho "Ajustar" (100%)
        const fit = frameFor(getClip(activeClipId), 'fit');
        const kFit = fit.w / s.w;
        if (!_groupMode && _snapEnabled && Math.abs(k - kFit) < 0.02 * kFit && Math.abs(s.w / s.h - fit.w / fit.h) < 0.01) k = kFit;
        w = s.w * k;
        h = s.h * k;
      }
      const c = fromCenter
        ? center
        : (() => { const o = rotate({ x: sx * w / 2, y: sy * h / 2 }, s.r || 0); return { x: anchor.x + o.x, y: anchor.y + o.y }; })();
      tx = { ...tx, x: c.x - w / 2, y: c.y - h / 2, w, h };
      clearSnapGuides();
    }

    if (drag.type === 'rotate') {
      touch();
      clearSnapGuides();
      const angle = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180 / Math.PI;
      let r = drag.startR + (angle - drag.startAngle);
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      else {
        const near = Math.round(r / 90) * 90;
        if (Math.abs(r - near) < ROT_SNAP) r = near;
      }
      tx.r = (r % 360 + 360) % 360;
    }

    positionBox();
    applyLive();
  }

  function onMouseUp() {
    if (!drag) return;
    const changed = drag.touched;
    drag = null;
    box.classList.remove('is-dragging', 'is-rotating');
    clearSnapGuides();
    if (changed) save();
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('txCSS')) return;
    const s = document.createElement('style');
    s.id = 'txCSS';
    s.textContent = `
      #transformBox {
        position:absolute; box-sizing:border-box;
        border:1.5px solid #fff;
        box-shadow:0 0 0 1px rgba(0,0,0,.45);
        pointer-events:auto; cursor:move;
        transform-origin:center center;
      }
      #transformBox.is-group { border-style:dashed; }
      .tx-handle {
        position:absolute; width:${HANDLE_SIZE}px; height:${HANDLE_SIZE}px;
        margin:-${HANDLE_SIZE / 2}px 0 0 -${HANDLE_SIZE / 2}px;
        background:#fff; border-radius:50%;
        box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 1px 4px rgba(0,0,0,.4);
        pointer-events:auto;
      }
      .tx-handle:hover { background:#82ea00; transform:scale(1.25); }
      .tx-handle-nw { left:0; top:0; cursor:nwse-resize; }
      .tx-handle-ne { left:100%; top:0; cursor:nesw-resize; }
      .tx-handle-se { left:100%; top:100%; cursor:nwse-resize; }
      .tx-handle-sw { left:0; top:100%; cursor:nesw-resize; }
      .tx-rot-knob {
        position:absolute; left:50%; top:100%;
        width:26px; height:26px; margin:16px 0 0 -13px;
        display:grid; place-items:center;
        border-radius:50%; background:#fff; color:#111;
        box-shadow:0 0 0 1px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.45);
        cursor:grab; pointer-events:auto;
      }
      .tx-rot-knob::before {
        content:''; position:absolute; left:50%; bottom:100%;
        width:1.5px; height:16px; margin-left:-.75px; background:rgba(255,255,255,.8);
      }
      .tx-rot-knob:hover { background:#82ea00; }
      .tx-rot-knob svg { pointer-events:none; }
      .tx-angle-tip {
        position:absolute; left:50%; top:100%; margin:48px 0 0; transform:translateX(-50%);
        padding:2px 7px; border-radius:5px; background:rgba(0,0,0,.8); color:#fff;
        font:600 11px Inter,sans-serif; white-space:nowrap; pointer-events:none; display:none;
      }
      #transformBox.is-rotating .tx-angle-tip { display:block; }
      #transformBox.is-dragging #transformBar,
      #transformBox.is-rotating #transformBar { opacity:0; pointer-events:none; }
      #transformBar {
        position:absolute; bottom:100%; left:50%; margin-bottom:12px;
        transform:translateX(-50%);
        display:flex; align-items:center; gap:4px;
        background:rgba(18,18,22,.94); border:1px solid rgba(255,255,255,.14);
        border-radius:8px; padding:4px; pointer-events:auto; white-space:nowrap;
        font-family:Inter,sans-serif; font-size:11px; color:#e0e0e0;
        transition:opacity .12s;
      }
      .tx-bar-btn {
        background:none; border:0; border-radius:5px; color:#e0e0e0;
        padding:4px 9px; cursor:pointer; font:600 11px Inter,sans-serif;
      }
      .tx-bar-btn:hover { background:rgba(255,255,255,.1); }
      .tx-bar-btn[data-active="true"] { color:#82ea00; }
      .tx-vsep { width:1px; height:16px; background:rgba(255,255,255,.15); }
    `;
    document.head.appendChild(s);
  }

  // ── arranque ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
