'use strict';
// captions-editor.js
//
//  Editor em lote das legendas criadas pela transcrição (estilo CapCut):
//  lista todas as legendas de um grupo, edita o texto de cada uma, troca
//  template / tamanho / cores de todas de uma vez e desloca o grupo no tempo.
//  Um grupo = clips com o mesmo `captionGroupId` (legendas antigas, sem grupo,
//  são agrupadas pela track).

// #region Grupos
function captionGroupKey(clip) {
  if (clip.captionGroupId) return clip.captionGroupId;
  if (clip.isText && clip.words?.length) return `track:${Number(clip.trackIndex) || 0}`;
  return null;
}

function captionGroupClips(key) {
  return state.clips
    .filter(c => captionGroupKey(c) === key)
    .sort((a, b) => a.start - b.start);
}

function captionTemplateOf(clip) {
  return state.templates.find(t => t.id === clip.templateId) || null;
}
// #endregion

// #region Modal
let _captionsKey = null;

function buildCaptionsModal() {
  let modal = document.getElementById('captionsModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'captionsModal';
  modal.className = 'modal-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal cap-modal">
      <div class="modal-header">
        <div class="modal-header-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>
        </div>
        <span>Editar legendas</span>
        <button class="icon-btn" data-cap="close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="cap-toolbar">
          <div class="form-group" style="flex:1 1 180px">
            <label>Estilo (todas)</label>
            <select class="prop-input full" id="capTemplate"></select>
          </div>
          <div class="form-group" style="width:78px">
            <label>Tamanho</label>
            <input type="number" class="prop-input full" id="capFontSize" min="12" max="400" step="2">
          </div>
          <div class="form-group">
            <label>Cor</label>
            <input type="color" id="capColor">
          </div>
          <div class="form-group" id="capHighlightWrap">
            <label>Destaque</label>
            <input type="color" id="capHighlight">
          </div>
          <div class="form-group">
            <label>Deslocar grupo</label>
            <div class="cap-shift">
              <button class="tl-btn small" data-cap="shift" data-delta="-0.5" title="-0,5s">−.5</button>
              <button class="tl-btn small" data-cap="shift" data-delta="-0.1" title="-0,1s">−.1</button>
              <button class="tl-btn small" data-cap="shift" data-delta="0.1" title="+0,1s">+.1</button>
              <button class="tl-btn small" data-cap="shift" data-delta="0.5" title="+0,5s">+.5</button>
            </div>
          </div>
        </div>
        <div class="cap-summary" id="capSummary"></div>
        <div class="cap-list" id="capList"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-cap="delete" style="margin-right:auto;color:var(--danger)">Excluir todas</button>
        <button class="btn-secondary" data-cap="select">Selecionar na timeline</button>
        <button class="export-btn" data-cap="close">Concluir</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', e => {
    if (e.target === modal) return closeCaptionsEditor();
    const btn = e.target.closest('[data-cap]');
    if (!btn) return;
    const action = btn.dataset.cap;
    if (action === 'close')  closeCaptionsEditor();
    if (action === 'shift')  shiftCaptionGroup(Number(btn.dataset.delta));
    if (action === 'select') selectCaptionGroup();
    if (action === 'delete') deleteCaptionGroup();
    if (action === 'seek')   window.seekTo?.(Number(btn.dataset.time));
  });

  modal.querySelector('#capTemplate').addEventListener('change', e => applyToCaptionGroup({ template: e.target.value }));
  modal.querySelector('#capFontSize').addEventListener('change', e => applyToCaptionGroup({ fontSize: Number(e.target.value) }));
  modal.querySelector('#capColor').addEventListener('change', e => applyToCaptionGroup({ color: e.target.value }));
  modal.querySelector('#capHighlight').addEventListener('change', e => applyToCaptionGroup({ highlightColor: e.target.value }));

  // Texto de cada legenda: aplica ao sair do campo / Enter
  modal.querySelector('#capList').addEventListener('change', e => {
    const input = e.target.closest('.cap-text');
    if (input) updateCaptionText(input.dataset.clipId, input.value);
  });
  modal.querySelector('#capList').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('.cap-text')) e.target.blur();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeCaptionsEditor();
  });

  return modal;
}

function toHexColor(value, fallback = '#ffffff') {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

function renderCaptionsEditor() {
  const modal = buildCaptionsModal();
  const clips = captionGroupClips(_captionsKey);
  if (!clips.length) return closeCaptionsEditor();

  const firstTmpl = captionTemplateOf(clips[0]);
  const params    = firstTmpl?.textParams || {};
  const templates = window.__TextRegistry?.getAll() || [];

  modal.querySelector('#capTemplate').innerHTML = templates.map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === firstTmpl?.textTmplId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');
  modal.querySelector('#capFontSize').value = Number(params.fontSize) || 72;
  modal.querySelector('#capColor').value    = toHexColor(params.color);

  const regTmpl = window.__TextRegistry?.getById(firstTmpl?.textTmplId);
  const hasHighlight = 'highlightColor' in (regTmpl?.defaults || {}) || 'highlightColor' in params;
  modal.querySelector('#capHighlightWrap').style.display = hasHighlight ? '' : 'none';
  modal.querySelector('#capHighlight').value = toHexColor(params.highlightColor, '#82ea00');

  const total = clips[clips.length - 1].start + clips[clips.length - 1].duration - clips[0].start;
  modal.querySelector('#capSummary').textContent =
    `${clips.length} legendas · ${fmtTime(clips[0].start)} → ${fmtTime(clips[0].start + total)} · track ${Number(clips[0].trackIndex) || 0}`;

  const t = state.time;
  modal.querySelector('#capList').innerHTML = clips.map(clip => {
    const text = captionTemplateOf(clip)?.textParams?.text ?? clip.label;
    const active = t >= clip.start && t < clip.start + clip.duration;
    return `
      <div class="cap-row${active ? ' active' : ''}">
        <button class="cap-time" data-cap="seek" data-time="${clip.start + 0.001}" title="Ir para esta legenda">${fmtTime(clip.start)}</button>
        <input class="cap-text" data-clip-id="${escapeHtml(clip.id)}" value="${escapeHtml(text)}">
        <span class="cap-dur">${clip.duration.toFixed(2)}s</span>
      </div>
    `;
  }).join('');
}

window.openCaptionsEditor = function openCaptionsEditor(clipId = null) {
  const clip = state.clips.find(c => c.id === clipId) ||
               state.clips.find(c => getSelectedIds().has(c.id) && captionGroupKey(c));
  const key  = (clip && captionGroupKey(clip)) ||
               state.clips.map(captionGroupKey).find(Boolean);

  if (!key) {
    if ($('mbStatus')) $('mbStatus').textContent = 'Nenhuma legenda — use Transcrição num clip de vídeo';
    return;
  }

  _captionsKey = key;
  renderCaptionsEditor();
  buildCaptionsModal().style.display = 'flex';
};

function closeCaptionsEditor() {
  const modal = document.getElementById('captionsModal');
  if (modal) modal.style.display = 'none';
  _captionsKey = null;
}
// #endregion

// #region Operações no grupo
function refreshAfterCaptionChange(clipIds) {
  clipIds.forEach(id => window.__Compositor?.unmount(id));
  recalcProjectDuration();
  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  window.mountAllClips?.();
  renderCaptionsEditor();
}

function updateCaptionText(clipId, text) {
  const clip = state.clips.find(c => c.id === clipId);
  const tmpl = clip && captionTemplateOf(clip);
  if (!tmpl?.textTmplId || !text.trim()) return;

  tlPushUndo();
  clip.label = text.trim().slice(0, 32);
  // wordsJson fica: o template redistribui o tempo se o nº de palavras mudar
  rebuildTextTemplate(tmpl, { text: text.trim(), duration: clip.duration });
  refreshAfterCaptionChange([clip.id]);
}

/** changes: { template?, fontSize?, color?, highlightColor? } */
function applyToCaptionGroup(changes) {
  const clips = captionGroupClips(_captionsKey);
  if (!clips.length) return;
  tlPushUndo();

  clips.forEach(clip => {
    const tmpl = captionTemplateOf(clip);
    if (!tmpl?.textTmplId) return;

    if (changes.template && changes.template !== tmpl.textTmplId) {
      const next = window.__TextRegistry.getById(changes.template);
      if (!next) return;
      const keep = tmpl.textParams || {};
      tmpl.textTmplId = next.id;
      tmpl.textParams = {
        ...next.defaults,
        text:      keep.text,
        duration:  clip.duration,
        wordsJson: keep.wordsJson,
        ...(keep.fontSize ? { fontSize: keep.fontSize } : {}),
      };
    }

    const params = { duration: clip.duration };
    if (changes.fontSize)       params.fontSize       = changes.fontSize;
    if (changes.color)          params.color          = changes.color;
    if (changes.highlightColor) params.highlightColor = changes.highlightColor;
    rebuildTextTemplate(tmpl, params);
  });

  refreshAfterCaptionChange(clips.map(c => c.id));
}

function shiftCaptionGroup(delta) {
  const clips = captionGroupClips(_captionsKey);
  if (!clips.length || !delta) return;
  // Não deixa o grupo passar do zero
  const applied = Math.max(delta, -clips[0].start);
  if (!applied) return;

  tlPushUndo();
  clips.forEach(clip => { clip.start = Math.max(0, clip.start + applied); });
  recalcProjectDuration();
  syncProjectGlobals();
  renderTimeline();
  window.__syncCompositorToTime?.(state.time);
  renderCaptionsEditor();
}

function selectCaptionGroup() {
  const clips = captionGroupClips(_captionsKey);
  const sel = getSelectedIds();
  sel.clear();
  clips.forEach(c => sel.add(c.id));
  state.currentClipId = clips[0]?.id || null;
  updateSelectionFeedback();
  renderProjectSettings();
  closeCaptionsEditor();
}

function deleteCaptionGroup() {
  const clips = captionGroupClips(_captionsKey);
  if (!clips.length) return;
  const sel = getSelectedIds();
  sel.clear();
  clips.forEach(c => sel.add(c.id));
  closeCaptionsEditor();
  window.deleteSelectedClips();
}
// #endregion
