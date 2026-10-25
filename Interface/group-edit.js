'use strict';
// group-edit.js
//
//  Edição de vários clips selecionados:
//   - painel de propriedades da seleção (posição, tamanho, escala, rotação,
//     alinhar, distribuir e mudança de track em grupo)
//   - seleção clicando no preview (Shift/Cmd/Ctrl+clique soma ou tira)
//  Arrastar/redimensionar/girar o grupo pela caixa fica em transform.js.
//  Toda operação gera um passo de undo da timeline (guarda o _tx de todos).

(() => {
  // #region Geometria
  const appState = () => window.__appState;
  const projectRes = () => appState()?.project?.res || { w: 1080, h: 1920 };
  const typeOf = clip => appState().templates.find(t => t.id === clip.templateId)?.type;
  const round = v => Math.round(v * 10) / 10;

  function ensureTx(clip) {
    const res = projectRes();
    if (!clip._tx) clip._tx = { x: 0, y: 0, w: res.w, h: res.h, r: 0 };
    return clip._tx;
  }

  /** Clips selecionados que têm imagem (áudio fica de fora das operações visuais) */
  function selectedClips() {
    const st = appState();
    const ids = new Set(window.__getSelectedClipIds?.() || []);
    return (st?.clips || []).filter(c => ids.has(c.id));
  }
  const visualClips = () => selectedClips().filter(c => typeOf(c) !== 'audio');

  /** Retângulo alinhado aos eixos que contém o clip já girado */
  function aabb(t) {
    const r = (t.r || 0) * Math.PI / 180;
    const cos = Math.abs(Math.cos(r));
    const sin = Math.abs(Math.sin(r));
    const w = t.w * cos + t.h * sin;
    const h = t.w * sin + t.h * cos;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function bounds(clips) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    clips.forEach(c => {
      const b = aabb(ensureTx(c));
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // #endregion

  // #region Operações
  function applyToPreview(clips) {
    clips.forEach(c => {
      const entry = window.__Compositor?.get(c.id);
      if (!entry?.iframe) return;
      if (entry.isNative) window.__applyElementTransform?.(entry.iframe, c);
      else window.__applyClipTransformStyle?.(entry.iframe, c);
    });
  }

  /** Um passo de undo, aplica `fn` nos clips visuais e atualiza preview/caixa/painel */
  function commit(fn) {
    const clips = visualClips();
    if (!clips.length) return;
    window.__tlPushUndo?.();
    clips.forEach(ensureTx);
    fn(clips, bounds(clips));
    clips.forEach(c => { c._tx = { ...c._tx }; });
    applyToPreview(clips);
    window.__refreshTransformOverlay?.();
    window.__syncCompositorToTime?.(appState().time);
    window.renderProjectSettings?.();
  }

  const ops = {
    moveTo(x, y) {
      commit((clips, b) => {
        const dx = Number.isFinite(x) ? x - b.x : 0;
        const dy = Number.isFinite(y) ? y - b.y : 0;
        clips.forEach(c => { c._tx.x += dx; c._tx.y += dy; });
      });
    },
    /** Escala uniforme; origem 'center' ou 'topleft' (campos L/A mantêm X/Y) */
    scale(factor, origin = 'center') {
      if (!(factor > 0) || factor === 1) return;
      commit((clips, b) => {
        const ox = origin === 'center' ? b.x + b.w / 2 : b.x;
        const oy = origin === 'center' ? b.y + b.h / 2 : b.y;
        clips.forEach(c => {
          const t = c._tx;
          const cx = ox + (t.x + t.w / 2 - ox) * factor;
          const cy = oy + (t.y + t.h / 2 - oy) * factor;
          t.w *= factor;
          t.h *= factor;
          t.x = cx - t.w / 2;
          t.y = cy - t.h / 2;
        });
      });
    },
    /** Gira o grupo em torno do centro: posição e ângulo de cada clip */
    rotate(deg) {
      if (!deg) return;
      commit((clips, b) => {
        const gx = b.x + b.w / 2;
        const gy = b.y + b.h / 2;
        const rad = deg * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        clips.forEach(c => {
          const t = c._tx;
          const ox = t.x + t.w / 2 - gx;
          const oy = t.y + t.h / 2 - gy;
          t.x = gx + ox * cos - oy * sin - t.w / 2;
          t.y = gy + ox * sin + oy * cos - t.h / 2;
          t.r = (((t.r || 0) + deg) % 360 + 360) % 360;
        });
      });
    },
    /** Alinha cada clip à borda/centro da seleção (ou do quadro com toFrame) */
    align(edge, toFrame = false) {
      commit((clips, b) => {
        const res = projectRes();
        const ref = toFrame ? { x: 0, y: 0, w: res.w, h: res.h } : b;
        clips.forEach(c => {
          const a = aabb(c._tx);
          if (edge === 'left')    c._tx.x += ref.x - a.x;
          if (edge === 'hcenter') c._tx.x += ref.x + ref.w / 2 - (a.x + a.w / 2);
          if (edge === 'right')   c._tx.x += ref.x + ref.w - (a.x + a.w);
          if (edge === 'top')     c._tx.y += ref.y - a.y;
          if (edge === 'vcenter') c._tx.y += ref.y + ref.h / 2 - (a.y + a.h / 2);
          if (edge === 'bottom')  c._tx.y += ref.y + ref.h - (a.y + a.h);
        });
      });
    },
    /** Centraliza a seleção inteira no quadro, mantendo o arranjo */
    centerInFrame() {
      commit((clips, b) => {
        const res = projectRes();
        const dx = res.w / 2 - (b.x + b.w / 2);
        const dy = res.h / 2 - (b.y + b.h / 2);
        clips.forEach(c => { c._tx.x += dx; c._tx.y += dy; });
      });
    },
    /** Espaços iguais entre os clips (3 ou mais), na ordem em que estão */
    distribute(axis) {
      commit(clips => {
        if (clips.length < 3) return;
        const pos = axis === 'x' ? 'x' : 'y';
        const size = axis === 'x' ? 'w' : 'h';
        const items = clips.map(c => ({ c, a: aabb(c._tx) })).sort((p, q) => p.a[pos] - q.a[pos]);
        const first = items[0].a;
        const last = items[items.length - 1].a;
        const span = last[pos] + last[size] - first[pos];
        const used = items.reduce((s, i) => s + i.a[size], 0);
        const gap = (span - used) / (items.length - 1);
        let cursor = first[pos];
        items.forEach(({ c, a }) => {
          c._tx[pos] += cursor - a[pos];
          cursor += a[size] + gap;
        });
      });
    },
  };
  window.__groupOps = ops;
  // #endregion

  // #region Painel da seleção
  window.__groupPropsActive = () => (window.__getSelectedClipIds?.() || []).length > 1;

  const ICON = {
    left:    '<path d="M4 3v18"/><rect x="7" y="6" width="11" height="4" rx="1"/><rect x="7" y="14" width="7" height="4" rx="1"/>',
    hcenter: '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="8" y="14" width="8" height="4" rx="1"/>',
    right:   '<path d="M20 3v18"/><rect x="6" y="6" width="11" height="4" rx="1"/><rect x="10" y="14" width="7" height="4" rx="1"/>',
    top:     '<path d="M3 4h18"/><rect x="6" y="7" width="4" height="11" rx="1"/><rect x="14" y="7" width="4" height="7" rx="1"/>',
    vcenter: '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="8" width="4" height="8" rx="1"/>',
    bottom:  '<path d="M3 20h18"/><rect x="6" y="6" width="4" height="11" rx="1"/><rect x="14" y="10" width="4" height="7" rx="1"/>',
    distX:   '<rect x="3" y="7" width="4" height="10" rx="1"/><rect x="10" y="7" width="4" height="10" rx="1"/><rect x="17" y="7" width="4" height="10" rx="1"/>',
    distY:   '<rect x="7" y="3" width="10" height="4" rx="1"/><rect x="7" y="10" width="10" height="4" rx="1"/><rect x="7" y="17" width="10" height="4" rx="1"/>',
  };
  const icon = name => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ICON[name]}</svg>`;
  const btn = (action, label, content, extra = '') =>
    `<button type="button" class="grp-btn" data-grp="${action}" title="${label}" aria-label="${label}" ${extra}>${content}</button>`;

  window.__renderGroupProps = function renderGroupProps(container) {
    const all = selectedClips();
    const visual = all.filter(c => typeOf(c) !== 'audio');
    const audio = all.length - visual.length;
    const b = visual.length ? bounds(visual) : null;
    const tracks = [...new Set(all.map(c => Number(c.trackIndex) || 0))].sort((p, q) => p - q);
    const t0 = Math.min(...all.map(c => c.start));
    const t1 = Math.max(...all.map(c => c.start + c.duration));
    const fmt = t => (window.fmtTime ? window.fmtTime(t) : t.toFixed(2));
    const trackLabel = tracks.length === 1 ? `V${tracks[0] + 1}` : `V${tracks[0] + 1}–V${tracks[tracks.length - 1] + 1}`;
    const canDistribute = visual.length >= 3 ? '' : 'disabled';

    container.innerHTML = `
      <div class="prop-section grp-panel">
        <div class="prop-title">Seleção · ${all.length} clips</div>
        <div class="grp-summary">${visual.length} visuais${audio ? ` · ${audio} de áudio` : ''} · ${trackLabel} · ${fmt(t0)} → ${fmt(t1)}</div>
      </div>
      ${b ? `
      <div class="prop-section grp-panel">
        <div class="prop-title">Transformar em grupo</div>
        <div class="grp-grid">
          <label>X <input type="number" class="prop-input" data-grp-field="x" value="${round(b.x)}" step="1"></label>
          <label>Y <input type="number" class="prop-input" data-grp-field="y" value="${round(b.y)}" step="1"></label>
          <label>L <input type="number" class="prop-input" data-grp-field="w" value="${round(b.w)}" min="1" step="1"></label>
          <label>A <input type="number" class="prop-input" data-grp-field="h" value="${round(b.h)}" min="1" step="1"></label>
        </div>
        <div class="grp-row">
          <span class="grp-label">Escala</span>
          ${btn('scale', 'Diminuir 10%', '−10%', 'data-value="0.9"')}
          ${btn('scale', 'Aumentar 10%', '+10%', 'data-value="1.1"')}
          <label class="grp-inline"><input type="number" class="prop-input" data-grp-field="scale" value="100" min="1" step="5">%</label>
        </div>
        <div class="grp-row">
          <span class="grp-label">Girar</span>
          ${btn('rotate', 'Girar −90°', '⟲90', 'data-value="-90"')}
          ${btn('rotate', 'Girar −15°', '⟲15', 'data-value="-15"')}
          ${btn('rotate', 'Girar +15°', '⟳15', 'data-value="15"')}
          ${btn('rotate', 'Girar +90°', '⟳90', 'data-value="90"')}
          <label class="grp-inline"><input type="number" class="prop-input" data-grp-field="rotate" value="0" step="1">°</label>
        </div>
        <div class="grp-row">
          <span class="grp-label">Alinhar</span>
          ${['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].map(e => btn('align', { left: 'Alinhar à esquerda', hcenter: 'Centralizar na horizontal', right: 'Alinhar à direita', top: 'Alinhar ao topo', vcenter: 'Centralizar na vertical', bottom: 'Alinhar à base' }[e], icon(e), `data-value="${e}"`)).join('')}
        </div>
        <div class="grp-row">
          <span class="grp-label">No quadro</span>
          <label class="grp-check"><input type="checkbox" data-grp-field="toFrame"> alinhar ao quadro</label>
          ${btn('center', 'Centralizar a seleção no quadro', 'Centralizar')}
        </div>
        <div class="grp-row">
          <span class="grp-label">Distribuir</span>
          ${btn('distribute', 'Distribuir na horizontal (3+ clips)', icon('distX'), `data-value="x" ${canDistribute}`)}
          ${btn('distribute', 'Distribuir na vertical (3+ clips)', icon('distY'), `data-value="y" ${canDistribute}`)}
        </div>
      </div>` : ''}
      <div class="prop-section grp-panel">
        <div class="prop-title">Faixa</div>
        <div class="grp-row">
          ${btn('track', 'Subir a seleção uma track (Alt+↑)', '▲ Subir', 'data-value="1"')}
          ${btn('track', 'Descer a seleção uma track (Alt+↓)', '▼ Descer', 'data-value="-1"')}
        </div>
        <div class="grp-hint">O grupo anda junto, pulando tracks ocupadas. Na base, abre uma track nova.</div>
      </div>
      <div class="prop-section grp-panel">
        <div class="grp-row">
          ${btn('aisfx', 'A IA analisa os clips e cria efeitos sonoros sincronizados', '🔊 Sons com IA')}
          ${btn('duplicate', 'Duplicar a seleção (⌘/Ctrl+D)', 'Duplicar')}
          ${btn('delete', 'Excluir a seleção (Delete)', 'Excluir', 'data-danger')}
        </div>
      </div>`;
  };

  let toFrame = false;

  function onPanelClick(e) {
    const el = e.target.closest('[data-grp]');
    if (!el || el.disabled) return;
    const value = el.dataset.value;
    switch (el.dataset.grp) {
      case 'scale':      return ops.scale(Number(value));
      case 'rotate':     return ops.rotate(Number(value));
      case 'align':      return ops.align(value, toFrame);
      case 'center':     return ops.centerInFrame();
      case 'distribute': return ops.distribute(value);
      case 'track':      return window.moveSelectedToTrack?.(Number(value));
      case 'aisfx':      return window.__aiSfxForClips?.(window.__getSelectedClipIds?.() || []);
      case 'duplicate':  return window.duplicateSelectedClips?.();
      case 'delete':     return window.deleteSelectedClips?.();
    }
  }

  function onPanelChange(e) {
    const field = e.target.dataset?.grpField;
    if (!field) return;
    if (field === 'toFrame') { toFrame = e.target.checked; return; }
    const v = Number(e.target.value);
    const clips = visualClips();
    if (!clips.length || !Number.isFinite(v)) return;
    const b = bounds(clips);
    if (field === 'x') ops.moveTo(v, NaN);
    if (field === 'y') ops.moveTo(NaN, v);
    if (field === 'w' && v > 0) ops.scale(v / b.w, 'topleft');
    if (field === 'h' && v > 0) ops.scale(v / b.h, 'topleft');
    if (field === 'scale' && v > 0) ops.scale(v / 100);
    if (field === 'rotate') ops.rotate(v);
  }

  function bindPanel() {
    const panel = document.getElementById('propsContent');
    if (!panel || panel.__grpBound) return;
    panel.__grpBound = true;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('change', onPanelChange);
    panel.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.dataset?.grpField) e.target.blur();
    });
  }

  // Arrastar a caixa do grupo também atualiza os números do painel
  window.__onGroupTransformed = () => {
    if (window.__groupPropsActive()) window.renderProjectSettings?.();
  };
  // #endregion

  // #region Seleção pelo preview
  /** Clip visível mais acima sob o ponto (coordenadas do projeto) */
  function clipAtPoint(px, py) {
    const st = appState();
    const t = st.time;
    const hidden = new Set((st.tracks || []).filter(tr => tr.hidden).map(tr => tr.index));
    const candidates = st.clips
      .filter(c => t >= c.start && t < c.start + c.duration)
      .filter(c => typeOf(c) !== 'audio' && !hidden.has(Number(c.trackIndex) || 0))
      .sort((a, b) => (Number(b.trackIndex) || 0) - (Number(a.trackIndex) || 0));
    for (const c of candidates) {
      const tx = ensureTx(c);
      const cx = tx.x + tx.w / 2;
      const cy = tx.y + tx.h / 2;
      const r = -(tx.r || 0) * Math.PI / 180;
      const lx = (px - cx) * Math.cos(r) - (py - cy) * Math.sin(r);
      const ly = (px - cx) * Math.sin(r) + (py - cy) * Math.cos(r);
      if (Math.abs(lx) <= tx.w / 2 && Math.abs(ly) <= tx.h / 2) return c;
    }
    return null;
  }

  function onPreviewMouseDown(e) {
    if (e.button !== 0 || !appState()?.project) return;
    if (e.target.closest('#transformBar, .tx-handle, .webgl-notice, button, input, select')) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Sem modificador, clicar dentro da caixa é arrastar (transform.js)
    if (!additive && e.target.closest('#transformBox')) return;

    const wrapper = document.getElementById('previewWrapper');
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const res = projectRes();
    const scale = rect.width / res.w;
    if (!(scale > 0)) return;
    const hit = clipAtPoint((e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);

    if (additive) {
      e.preventDefault();
      e.stopPropagation();
      if (hit) window.__selectClip?.(hit.id, true);
      return;
    }
    if (hit) window.__selectClip?.(hit.id);
    else window.deselectClip?.();
  }

  function bindPreview() {
    const outer = document.getElementById('previewOuter');
    if (!outer || outer.__grpBound) return;
    outer.__grpBound = true;
    // Captura: decide antes da caixa de transformação
    outer.addEventListener('mousedown', onPreviewMouseDown, true);
  }
  // #endregion

  function init() {
    bindPanel();
    bindPreview();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
