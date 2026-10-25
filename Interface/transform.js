// transform.js
'use strict';

;(function () {

  const HANDLE_SIZE  = 10;
  const MIN_W        = 20;
  const MIN_H        = 20;
  const SNAP_THRESH  = 14;   // mais agressivo

  let overlay      = null;
  let box          = null;
  let bar          = null;
  let snapLines    = null;
  let activeClipId = null;

  let _groupMode = false;       // true quando há múltiplos clips selecionados
let _groupIds  = [];          // ids dos clips no grupo
let _groupOffsets = new Map(); // clipId → {dx, dy, dw, dh} relativo ao bbox do grupo


  let tx = { x: 0, y: 0, w: 0, h: 0, r: 0 };

  let drag = null;

  // ── init ─────────────────────────────────────────────────────────────────
  function init() {
    injectCSS();

    overlay = document.createElement('div');
    overlay.id = 'transformOverlay';
    overlay.style.cssText = `
      position:absolute; inset:0;
      pointer-events:none;
      z-index:30;
      overflow:visible;
      display:none;
    `;

    box = document.createElement('div');
    box.id = 'transformBox';
    box.style.cssText = `
      position:absolute;
      box-sizing:border-box;
      border:2px solid #82ea00;
      pointer-events:auto;
      cursor:move;
    `;

    ['nw','n','ne','e','se','s','sw','w'].forEach(h => {
      const el = document.createElement('div');
      el.className = 'tx-handle';
      el.dataset.handle = h;
      el.style.cssText = handleCSS(h);
      el.addEventListener('mousedown', onHandleDown);
      box.appendChild(el);
    });

    bar = document.createElement('div');
    bar.id = 'transformBar';
    bar.innerHTML = `
      <button class="tx-bar-btn" id="txBtnRot" title="Clique e arraste para rotacionar">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
          <path d="M21 3v5h-5"/>
        </svg>
        <span id="txRotLabel">0°</span>
      </button>
      <div class="tx-vsep"></div>
      <button class="tx-bar-btn" id="txBtnSnap" title="Toggle snap" data-active="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
        </svg>
        <span>Snap</span>
      </button>
      <div class="tx-vsep"></div>
      <button class="tx-bar-btn" id="txBtnReset" title="Reset transform">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10"/>
          <path d="M3.51 15a9 9 0 1 0 .49-4"/>
        </svg>
        <span>Reset</span>
      </button>
    `;
    box.appendChild(bar);

    snapLines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    snapLines.id = 'txSnapLines';
    snapLines.style.cssText = `
      position:absolute; inset:0;
      width:100%; height:100%;
      pointer-events:none;
      z-index:29;
      overflow:visible;
    `;

    overlay.appendChild(snapLines);
    overlay.appendChild(box);

    bar.querySelector('#txBtnRot').addEventListener('mousedown', onRotateDown);
    bar.querySelector('#txBtnReset').addEventListener('click', resetTransform);
    bar.querySelector('#txBtnSnap').addEventListener('click', function() {
      _snapEnabled = !_snapEnabled;
      this.dataset.active = _snapEnabled ? 'true' : 'false';
      this.style.color = _snapEnabled ? 'var(--accent, #82ea00)' : '';
    });

    box.addEventListener('mousedown', onBoxDown);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    window.addEventListener('resize', scheduleRepos);

    const _orig = window.__syncPreviewSize;
    window.__syncPreviewSize = function () {
      _orig?.apply(this, arguments);
      scheduleRepos();
    };

    const ro = new ResizeObserver(scheduleRepos);
    ['previewScroll','center','previewOuter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    });

    let _last = null;
    setInterval(() => {
      const cur = window.__appState?.currentClipId || null;
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

  }

  let _snapEnabled = true;

  let _reposTimer = null;
  function scheduleRepos() {
    clearTimeout(_reposTimer);
    _reposTimer = setTimeout(() => { if (activeClipId) positionBox(); }, 16);
  }

  // ── handles CSS ───────────────────────────────────────────────────────────
  const H = HANDLE_SIZE;
  const O = -(H / 2) + 'px';

  const HANDLE_POS = {
    nw: `top:${O};left:${O}`,
    n:  `top:${O};left:calc(50% - ${H/2}px)`,
    ne: `top:${O};right:${O}`,
    e:  `top:calc(50% - ${H/2}px);right:${O}`,
    se: `bottom:${O};right:${O}`,
    s:  `bottom:${O};left:calc(50% - ${H/2}px)`,
    sw: `bottom:${O};left:${O}`,
    w:  `top:calc(50% - ${H/2}px);left:${O}`,
  };

  const HANDLE_CURSOR = {
    nw:'nw-resize', n:'n-resize',  ne:'ne-resize',
    e:'e-resize',   se:'se-resize', s:'s-resize',
    sw:'sw-resize', w:'w-resize',
  };

  function handleCSS(h) {
    return `
      position:absolute;
      width:${H}px; height:${H}px;
      background:#fff;
      border:2px solid #82ea00;
      border-radius:2px;
      box-sizing:border-box;
      pointer-events:auto;
      ${HANDLE_POS[h]};
      cursor:${HANDLE_CURSOR[h]};
    `;
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  function getWrapper() { return document.getElementById('previewWrapper'); }
  function getOuter()   { return document.getElementById('previewOuter');   }

  function getScale() {
    const m = getWrapper()?.style.transform.match(/scale\(([\d.]+)\)/);
    return m ? parseFloat(m[1]) : 1;
  }

  function wrapperOrigin() {
    const outer  = getOuter();
    const scale  = getScale();
    const res    = window.__appState?.project?.res || { w:1080, h:1920 };
    const outerW = outer?.offsetWidth || res.w * scale;
    return {
      left: (outerW - res.w * scale) / 2,
      top:  0,
    };
  }

  // ── Snap helpers ──────────────────────────────────────────────────────────
  function getSnapCandidates() {
    const state = window.__appState;
    if (!state?.clips) return [];
    const res = state.project?.res || { w:1080, h:1920 };
    const lines = [];

    lines.push({ axis:'x', v:0 });
    lines.push({ axis:'x', v:res.w });
    lines.push({ axis:'x', v:res.w / 2 });
    lines.push({ axis:'y', v:0 });
    lines.push({ axis:'y', v:res.h });
    lines.push({ axis:'y', v:res.h / 2 });

    state.clips.forEach(clip => {
      if (clip.id === activeClipId) return;
      const t = clip._tx;
      if (!t) return;
      lines.push({ axis:'x', v:t.x });
      lines.push({ axis:'x', v:t.x + t.w });
      lines.push({ axis:'x', v:t.x + t.w / 2 });
      lines.push({ axis:'y', v:t.y });
      lines.push({ axis:'y', v:t.y + t.h });
      lines.push({ axis:'y', v:t.y + t.h / 2 });
    });

    return lines;
  }

  // Testa snap de um valor contra candidatos
  function snapValue(val, axis, candidates) {
    if (!_snapEnabled) return { v: val, snapped: null };
    let best = null, bestDist = SNAP_THRESH;
    candidates.forEach(c => {
      if (c.axis !== axis) return;
      const d = Math.abs(val - c.v);
      if (d < bestDist) { bestDist = d; best = c.v; }
    });
    return best !== null ? { v: best, snapped: best } : { v: val, snapped: null };
  }

  // Aplica snap ao tx; agora coleta TODAS as guias ativas (não para no primeiro snap)
  function applySnap(proposed) {
    const candidates = getSnapCandidates();
    const snapHints  = { x: [], y: [] };

    const edges = {
      x: [ proposed.x, proposed.x + proposed.w / 2, proposed.x + proposed.w ],
      y: [ proposed.y, proposed.y + proposed.h / 2, proposed.y + proposed.h ],
    };

    let dx = null, dy = null;

    // Varre todas as bordas/centro no eixo X — pega o snap mais próximo
    for (const v of edges.x) {
      const r = snapValue(v, 'x', candidates);
      if (r.snapped !== null) {
        const offset = r.snapped - v;
        if (dx === null || Math.abs(offset) < Math.abs(dx)) {
          dx = offset;
          snapHints.x = [r.snapped];
        }
      }
    }

    // Varre todas as bordas/centro no eixo Y
    for (const v of edges.y) {
      const r = snapValue(v, 'y', candidates);
      if (r.snapped !== null) {
        const offset = r.snapped - v;
        if (dy === null || Math.abs(offset) < Math.abs(dy)) {
          dy = offset;
          snapHints.y = [r.snapped];
        }
      }
    }

    return {
      tx: {
        ...proposed,
        x: proposed.x + (dx || 0),
        y: proposed.y + (dy || 0),
      },
      hints: snapHints,
    };
  }

  // ── Shift-lock: alinha perfeitamente ao eixo travado ──────────────────────
  // Detecta se o drag é predominantemente horizontal ou vertical e,
  // ao segurar Shift, trava o eixo oposto na posição SNAPPED mais próxima.
  function applyAxisLock(proposed, startTx, shiftKey) {
    if (!shiftKey) return proposed;

    const totalDx = Math.abs(proposed.x - startTx.x);
    const totalDy = Math.abs(proposed.y - startTx.y);
    const res = window.__appState?.project?.res || { w:1080, h:1920 };

    if (totalDx >= totalDy) {
      // movimento predominantemente horizontal → trava Y
      // snappa o centro Y do clipe ao candidato mais próximo
      const candidates = getSnapCandidates();
      const centerY = proposed.y + proposed.h / 2;
      const edges = [proposed.y, centerY, proposed.y + proposed.h];
      let bestY = startTx.y, bestDist = Infinity;

      // Tenta todas as bordas do clipe contra todos os candidatos Y
      edges.forEach(v => {
        candidates.filter(c => c.axis === 'y').forEach(c => {
          const d = Math.abs(v - c.v);
          if (d < bestDist) {
            bestDist = d;
            bestY = c.v - (v - proposed.y); // ajusta origem Y
          }
        });
      });

      return { ...proposed, y: bestY };
    } else {
      // movimento predominantemente vertical → trava X
      const candidates = getSnapCandidates();
      const edges = [proposed.x, proposed.x + proposed.w / 2, proposed.x + proposed.w];
      let bestX = startTx.x, bestDist = Infinity;

      edges.forEach(v => {
        candidates.filter(c => c.axis === 'x').forEach(c => {
          const d = Math.abs(v - c.v);
          if (d < bestDist) {
            bestDist = d;
            bestX = c.v - (v - proposed.x);
          }
        });
      });

      return { ...proposed, x: bestX };
    }
  }

  // Desenha guias de snap no SVG sobreposto
  function drawSnapGuides(hints) {
    if (!snapLines) return;
    while (snapLines.firstChild) snapLines.removeChild(snapLines.firstChild);
    if (!_snapEnabled) return;

    const scale  = getScale();
    const origin = wrapperOrigin();
    const res    = window.__appState?.project?.res || { w:1080, h:1920 };
    const W      = res.w * scale;
    const H      = res.h * scale;

    const makeLine = (x1, y1, x2, y2) => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', '#82ea00');
      l.setAttribute('stroke-width', '1.5');
      l.setAttribute('stroke-dasharray', '4 3');
      l.setAttribute('opacity', '0.95');
      snapLines.appendChild(l);
    };

    (hints.x || []).forEach(v => {
      const px = origin.left + v * scale;
      makeLine(px, origin.top - 20, px, origin.top + H + 20);
    });
    (hints.y || []).forEach(v => {
      const py = origin.top + v * scale;
      makeLine(origin.left - 20, py, origin.left + W + 20, py);
    });
  }

  function clearSnapGuides() {
    if (!snapLines) return;
    while (snapLines.firstChild) snapLines.removeChild(snapLines.firstChild);
  }

  // ── show / hide ───────────────────────────────────────────────────────────
  function show(clipId) {
    const clip = getClip(clipId);
    if (!clip) return;
    // Áudio não tem caixa no preview
    const st = window.__appState;
    if (st?.templates?.find(t => t.id === clip.templateId)?.type === 'audio') return hide();
    activeClipId = clipId;
  
    const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
    if (!clip._tx) clip._tx = { x: 0, y: 0, w: res.w, h: res.h, r: 0 };
    tx = { ...clip._tx };
  
    pushUndo(clipId, tx);
  
    const outer = getOuter();
    if (outer && !outer.contains(overlay)) {
      outer.style.position = 'relative';
      outer.appendChild(overlay);
    }
  
    overlay.style.display = '';
  
    // Verifica se há seleção múltipla (áudio não tem caixa e fica fora do grupo)
    const selIds = (window.__getSelectedClipIds?.() || []).filter(id => !isAudioClip(id));
    if (selIds.length > 1) {
      _groupMode = true;
      _groupIds  = selIds;
      computeGroupBBox();
    } else {
      _groupMode   = false;
      _groupIds    = [];
      _groupOffsets.clear();
    }
  
    positionBox();
  }
  
  // ── Calcula o bounding box do grupo e os offsets de cada clip: ────────────
  function computeGroupBBox() {
    const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
    _groupIds.forEach(id => {
      const c = getClip(id);
      if (!c) return;
      if (!c._tx) c._tx = { x: 0, y: 0, w: res.w, h: res.h, r: 0 };
      const t = c._tx;
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x + t.w);
      maxY = Math.max(maxY, t.y + t.h);
    });
  
    // tx representa o bbox do grupo inteiro
    tx = { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0 };
  
    // Offsets de cada clip em relação ao bbox
    _groupOffsets.clear();
    _groupIds.forEach(id => {
      const c = getClip(id);
      if (!c?._tx) return;
      _groupOffsets.set(id, {
        dx: c._tx.x - minX,
        dy: c._tx.y - minY,
        dw: c._tx.w,
        dh: c._tx.h,
        r:  c._tx.r || 0,
      });
    });
  }
  
  // ── Aplica o tx do grupo a cada clip proporcional ao bbox: ────────────────
  function applyGroupTx(newTx) {
    // startBBox = bbox do grupo quando o drag começou (passado pelo caller)
    // ou cai em tx como fallback para move (onde tx ainda é o bbox correto)
    const base = drag?.groupStartTx || newTx;
    const prevW = base.w || 1;
    const prevH = base.h || 1;
    const scaleX = newTx.w / prevW;
    const scaleY = newTx.h / prevH;
  
    _groupIds.forEach(id => {
      const c = getClip(id);
      if (!c) return;
      const off = _groupOffsets.get(id);
      if (!off) return;
      c._tx = {
        x: newTx.x + off.dx * scaleX,
        y: newTx.y + off.dy * scaleY,
        w: off.dw * scaleX,
        h: off.dh * scaleY,
        r: off.r,   // cada clip mantém a própria rotação
      };
    });
  }
  

  function hide() {
    if (overlay) overlay.style.display = 'none';
    clearSnapGuides();
    activeClipId = null;
  }

  // ── posicionar box ────────────────────────────────────────────────────────
  function positionBox() {
    if (!box || !activeClipId) return;
    const scale  = getScale();
    const origin = wrapperOrigin();

    box.style.left            = (origin.left + tx.x * scale) + 'px';
    box.style.top             = (origin.top  + tx.y * scale) + 'px';
    box.style.width           = (tx.w * scale) + 'px';
    box.style.height          = (tx.h * scale) + 'px';
    box.style.transform       = `rotate(${tx.r}deg)`;
    box.style.transformOrigin = 'center center';

    const lbl = document.getElementById('txRotLabel');
    if (lbl) lbl.textContent = `${Math.round(tx.r)}°`;
  }

  // ── aplicar ao iframe ─────────────────────────────────────────────────────
  /** Gira cada clip em torno do centro do grupo (posição e ângulo) */
  function applyGroupRotation(delta) {
    const { cx, cy, starts } = drag.groupRotate;
    const rad = delta * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    starts.forEach((s, id) => {
      const c = getClip(id);
      if (!c) return;
      const ox = s.x + s.w / 2 - cx;
      const oy = s.y + s.h / 2 - cy;
      const nx = cx + ox * cos - oy * sin;
      const ny = cy + ox * sin + oy * cos;
      c._tx = { x: nx - s.w / 2, y: ny - s.h / 2, w: s.w, h: s.h, r: (((s.r || 0) + delta) % 360 + 360) % 360 };
    });
  }

  function applyLive() {
    if (_groupMode) {
      if (drag?.type === 'rotate' && drag.groupRotate) applyGroupRotation(tx.r);
      else applyGroupTx(tx);
      _groupIds.forEach(id => {
        const clip  = getClip(id);
        const entry = window.__Compositor?.get(id);
        if (!entry || !clip) return;
        if (entry.isNative) window.__applyElementTransform?.(entry.iframe, clip);
        else                window.__applyClipTransformStyle?.(entry.iframe, clip);
      });
      return;
    }
  
    // Singular — comportamento original
    const clip = getClip(activeClipId);
    if (!clip) return;
    clip._tx = { ...tx };
    const entry = window.__Compositor?.get(activeClipId);
    if (!entry) return;
    if (entry.isNative) window.__applyElementTransform?.(entry.iframe, clip);
    else                window.__applyClipTransformStyle?.(entry.iframe, clip);
  }
  
  function save() {
    if (_groupMode) {
      // applyLive já gravou cada clip; a caixa volta a ser o contorno do grupo
      computeGroupBBox();
      positionBox();
      window.__onGroupTransformed?.();
    } else {
      const clip = getClip(activeClipId);
      if (clip) clip._tx = { ...tx };
    }
    window.__syncCompositorToTime?.(window.__appState?.time ?? 0);
  }
  
  // ── Hook que compositor.js chama quando a seleção muda: ───────────────────
  window.__onSelectionChange = function(selSet) {
    const ids = [...selSet];
    // Primário = clip atual se for visual, senão o primeiro visual da seleção
    const cur = window.__appState?.currentClipId;
    const primary = ids.includes(cur) && !isAudioClip(cur) ? cur : ids.find(id => !isAudioClip(id));
    if (!primary) { hide(); return; }
    show(primary);
  };

  function isAudioClip(id) {
    const st = window.__appState;
    const clip = st?.clips?.find(c => c.id === id);
    return st?.templates?.find(t => t.id === clip?.templateId)?.type === 'audio';
  }

  // Reposiciona a caixa depois de mudanças feitas por fora (painel do grupo, undo)
  window.__refreshTransformOverlay = function () {
    if (activeClipId && getClip(activeClipId)) show(activeClipId);
  };
  

  function getClip(id) {
    return window.__appState?.clips?.find(c => c.id === id) || null;
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  function resetTransform() {
    const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
  
    if (_groupMode) {
      window.__tlPushUndo?.();
      _groupIds.forEach(id => {
        const c = getClip(id);
        if (!c) return;
        c._tx = { x: 0, y: 0, w: res.w, h: res.h, r: 0 };
        c._txNat = null;
        const entry = window.__Compositor?.get(id);
        if (entry?.iframe) {
          if (entry.isNative) window.__applyElementTransform?.(entry.iframe, c);
          else                window.__applyClipTransformStyle?.(entry.iframe, c);
        }
      });
      computeGroupBBox();
      positionBox();
      save();
      return;
    }
  
    // Singular — igual para todos os tipos
    const clip = getClip(activeClipId);
    if (!clip) return;
    clip._tx   = { x: 0, y: 0, w: res.w, h: res.h, r: 0 };
    clip._txNat = null;
    tx = { ...clip._tx };
    positionBox();
    applyLive();
    save();
  }
  

  // ── drag: mover ───────────────────────────────────────────────────────────
  /** Grupo: o undo da timeline guarda o _tx de todos os clips de uma vez */
  function groupUndoPoint() {
    if (_groupMode) window.__tlPushUndo?.();
  }

  function onBoxDown(e) {
    if (e.target.closest('.tx-handle, #transformBar')) return;
    // Shift/Cmd/Ctrl+clique é seleção (group-edit.js), não arraste
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault(); e.stopPropagation();
    groupUndoPoint();
    drag = { type:'move', startX:e.clientX, startY:e.clientY, startTx:{ ...tx } };
  }

  // ── drag: resize ──────────────────────────────────────────────────────────
  function onHandleDown(e) {
    e.preventDefault(); e.stopPropagation();
    groupUndoPoint();
    drag = {
      type:'resize', handle:e.currentTarget.dataset.handle,
      startX:e.clientX, startY:e.clientY, startTx:{ ...tx },
      groupStartTx: _groupMode ? { ...tx } : null, // ← bbox do grupo no início
    };
  }

  // ── drag: rotate ──────────────────────────────────────────────────────────
  function onRotateDown(e) {
    e.preventDefault(); e.stopPropagation();
    const rect = box.getBoundingClientRect();
    const cx   = rect.left + rect.width  / 2;
    const cy   = rect.top  + rect.height / 2;
    const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    groupUndoPoint();
    drag = { type:'rotate', cx, cy, startAngle, startR: tx.r };
    if (_groupMode) {
      // Grupo: parte de 0° e gira cada clip a partir do estado inicial
      drag.startR = 0;
      tx.r = 0;
      drag.groupRotate = {
        cx: tx.x + tx.w / 2,
        cy: tx.y + tx.h / 2,
        starts: new Map(_groupIds.map(id => [id, { ...(getClip(id)?._tx || {}) }]).filter(([, t]) => 'x' in t)),
      };
    }
  }

  // ── mouse global ──────────────────────────────────────────────────────────
  function onMouseMove(e) {
    if (!drag || !activeClipId) return;

    if (drag.type === 'move') {
      const s  = getScale();
      const dx = (e.clientX - drag.startX) / s;
      const dy = (e.clientY - drag.startY) / s;

      let proposed = {
        ...tx,
        x: drag.startTx.x + dx,
        y: drag.startTx.y + dy,
      };

      // Shift: trava no eixo dominante e alinha ao snap mais próximo do eixo oposto
      proposed = applyAxisLock(proposed, drag.startTx, e.shiftKey);

      const { tx: snapped, hints } = applySnap(proposed);
      tx = snapped;

      // Se Shift ativo, mostra guia do eixo travado também
      if (e.shiftKey) {
        const totalDx = Math.abs(proposed.x - drag.startTx.x);
        const totalDy = Math.abs(proposed.y - drag.startTx.y);
        if (totalDx >= totalDy) {
          // travado em Y → mostra linha Y
          if (!hints.y.length) hints.y = [snapped.y + snapped.h / 2];
        } else {
          // travado em X → mostra linha X
          if (!hints.x.length) hints.x = [snapped.x + snapped.w / 2];
        }
      }

      drawSnapGuides(hints);
    }

    if (drag.type === 'resize') {
      const s  = getScale();
      const dx = (e.clientX - drag.startX) / s;
      const dy = (e.clientY - drag.startY) / s;
      const { handle:h, startTx:st } = drag;
      let { x, y, w, h: ht } = { x:st.x, y:st.y, w:st.w, h:st.h };
      const ar = st.w / st.h;

      if (h.includes('e')) w  = Math.max(MIN_W, st.w + dx);
      if (h.includes('s')) ht = Math.max(MIN_H, st.h + dy);
      if (h.includes('w')) { const d = Math.min(dx, st.w - MIN_W); x += d; w = st.w - d; }
      if (h.includes('n')) { const d = Math.min(dy, st.h - MIN_H); y += d; ht = st.h - d; }

      if (e.shiftKey) {
        if (h.includes('e') || h.includes('w')) ht = w / ar;
        else w = ht * ar;
      }

      const proposed = { ...tx, x, y, w:Math.max(MIN_W,w), h:Math.max(MIN_H,ht) };
      const { tx: snapped, hints } = applySnap(proposed);
      tx = snapped;
      drawSnapGuides(hints);
    }

    if (drag.type === 'rotate') {
      clearSnapGuides();
      const angle = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * (180 / Math.PI);
      let   delta = angle - drag.startAngle;
      if (e.shiftKey) delta = Math.round(delta / 15) * 15;
      tx.r = ((drag.startR + delta) % 360 + 360) % 360;
    }

    positionBox();
    applyLive();
  }

  function onMouseUp() {
    if (!drag) return;
    // Snapshot do estado ANTES de finalizar (drag já atualizou tx); grupo usa o undo da timeline
    if (!_groupMode) pushUndo(activeClipId, tx);
    drag = null;
    clearSnapGuides();
    save();
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('txCSS')) return;
    const s = document.createElement('style');
    s.id = 'txCSS';
    s.textContent = `
      #transformBar {
        position:absolute;
        bottom:-46px; left:50%;
        transform:translateX(-50%);
        display:flex; align-items:center; gap:6px;
        background:rgba(20,20,20,0.92);
        border:1px solid rgba(130,234,0,0.3);
        border-radius:8px;
        padding:5px 10px;
        pointer-events:auto;
        white-space:nowrap;
        user-select:none;
        font-family:Inter,sans-serif;
        font-size:11px; color:#e0e0e0;
      }
      .tx-bar-btn {
        display:flex; align-items:center; gap:4px;
        background:rgba(255,255,255,0.07);
        border:1px solid rgba(255,255,255,0.12);
        border-radius:5px; color:#e0e0e0;
        padding:4px 8px; cursor:grab; font-size:11px;
        transition:background .15s;
      }
      .tx-bar-btn:hover { background:rgba(130,234,0,0.15); border-color:#82ea00; color:#82ea00; }
      .tx-bar-btn:hover svg { stroke:#82ea00; }
      .tx-bar-btn[data-active="true"] { color:#82ea00; }
      #txBtnReset, #txBtnSnap { cursor:pointer; }
      .tx-vsep { width:1px; height:20px; background:rgba(255,255,255,0.15); margin:0 2px; }
      .tx-handle:hover { background:#82ea00 !important; }
    `;
    document.head.appendChild(s);
  }

  // ── Undo de Transform ─────────────────────────────────────────────────────
  const UNDO_LIMIT = 50;
  const _undoStack = new Map(); // clipId → tx[]
  
  function pushUndo(clipId, txSnapshot) {
    if (!_undoStack.has(clipId)) _undoStack.set(clipId, []);
    const stack = _undoStack.get(clipId);
    const top = stack[stack.length - 1];
    if (top && top.x === txSnapshot.x && top.y === txSnapshot.y &&
        top.w === txSnapshot.w && top.h === txSnapshot.h && top.r === txSnapshot.r) return;
    stack.push({ ...txSnapshot });
    if (stack.length > UNDO_LIMIT) stack.shift();
  
    // Sinaliza que a última ação foi de transform — só quando houve transformação
    // de fato (a 1ª entrada é só o estado-base ao montar/selecionar o clip; antes
    // ela "roubava" o Ctrl+Z da timeline logo após criar um clip).
    if (stack.length >= 2) window.__lastUndoSource = 'transform';
  }
  
  function undoTransform() {
    if (!activeClipId) return;
    const stack = _undoStack.get(activeClipId);
    if (!stack || stack.length < 2) return;
  
    stack.pop();
    const prev = stack[stack.length - 1];
    tx = { ...prev };
  
    const clip = getClip(activeClipId);
    if (clip) clip._tx = { ...tx };
  
    positionBox();
    applyLive();
    save();
  
    // Após desfazer, próximo Ctrl+Z deve ir para a timeline
    window.__lastUndoSource = 'timeline';
  }

  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== 'z') return;
  
    // Não interfere se o foco está em campo de texto
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  
    e.preventDefault();
  
    if (window.__lastUndoSource === 'transform') {
      undoTransform();
    } else {
      window.__tlUndo?.();
    }
  });

  // ── arranque ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once:true });
  } else {
    init();
  }

})();