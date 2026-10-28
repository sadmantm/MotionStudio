'use strict';
// timeline-pro.js
//
//  Recursos de edição da timeline que não pertencem ao núcleo (compositor.js):
//    · área de transferência de clips (copiar / recortar / colar no playhead)
//    · selecionar tudo, mover entre tracks, ajustar zoom, atalhos de teclado
//    · áudio por clip (volume, mudo, fade in/out) + mute/solo de track
//    · miniaturas (filmstrip) e forma de onda nos blocos de vídeo
//
//  Depende dos globais de app.js / compositor.js (scripts clássicos).

// #region Área de transferência de clips
const CLIP_CLIPBOARD_MARK = 'motion-studio:clips:';
let _clipClipboard = null;

window.__hasClipClipboard = () => Boolean(_clipClipboard?.items.length);

function copySelectedClips({ cut = false } = {}) {
  const ids = getActionClipIds();
  if (!ids.length) return;

  const clips    = state.clips.filter(c => ids.includes(c.id));
  const minStart = Math.min(...clips.map(c => c.start));
  const minTrack = Math.min(...clips.map(c => Number(c.trackIndex) || 0));

  _clipClipboard = {
    id: mkId(),
    minStart,
    minTrack,
    items: clips.map(clip => {
      const tmpl = state.templates.find(t => t.id === clip.templateId);
      return {
        clip: JSON.parse(JSON.stringify(clip)),
        // HTML/texto: cópia congelada; mídia: mesma referência (dataUrl/objectURL)
        template: tmpl && (tmpl.type === 'html' || tmpl.type === 'text')
          ? { ...tmpl, textParams: tmpl.textParams ? { ...tmpl.textParams } : tmpl.textParams }
          : tmpl,
      };
    }),
  };

  // Marca no clipboard do sistema: o Ctrl+V sabe que deve colar clips (e não HTML)
  try { navigator.clipboard?.writeText(CLIP_CLIPBOARD_MARK + _clipClipboard.id).catch(() => {}); } catch (_) {}

  setStatus(`${clips.length} clip(s) ${cut ? 'recortado(s)' : 'copiado(s)'}`);
  if (cut) window.deleteSelectedClips();
}

function trackIsFree(trackIndex, start, end) {
  if (state.tracks.some(t => t.index === trackIndex && t.locked)) return false;
  return !state.clips.some(c =>
    (Number(c.trackIndex) || 0) === trackIndex &&
    timelineIntervalsOverlap(start, end, c.start, c.start + c.duration)
  );
}

function pasteClipClipboard() {
  if (!_clipClipboard?.items.length || !state.project) return false;

  tlPushUndo();

  const offset = Math.max(0, state.time) - _clipClipboard.minStart;
  const placed = _clipClipboard.items.map(({ clip }) => ({
    start:    Math.max(0, clip.start + offset),
    end:      Math.max(0, clip.start + offset) + clip.duration,
    relTrack: (Number(clip.trackIndex) || 0) - _clipClipboard.minTrack,
  }));

  // Mantém o arranjo entre tracks; se colidir, sobe o bloco inteiro até caber
  let base = _clipClipboard.minTrack;
  for (let tries = 0; tries < 200; tries++) {
    if (placed.every(p => trackIsFree(base + p.relTrack, p.start, p.end))) break;
    base++;
  }

  const newIds = [];
  _clipClipboard.items.forEach(({ clip, template }, i) => {
    let templateId = clip.templateId;

    if (template && (template.type === 'html' || template.type === 'text')) {
      const copy = {
        ...template,
        id: mkId(),
        textParams: template.textParams ? { ...template.textParams } : template.textParams,
        inLibrary: false,
        libraryId: template.libraryId || (template.inLibrary ? template.id : undefined),
      };
      state.templates.push(copy);
      templateId = copy.id;
    } else if (template && !state.templates.some(t => t.id === template.id)) {
      state.templates.push(template);
    }

    const pasted = {
      ...JSON.parse(JSON.stringify(clip)),
      id:         mkId(),
      templateId,
      start:      placed[i].start,
      trackIndex: base + placed[i].relTrack,
    };
    getTrack(pasted.trackIndex);
    state.clips.push(pasted);
    newIds.push(pasted.id);
  });

  getSelectedIds().clear();
  newIds.forEach(id => getSelectedIds().add(id));
  state.currentClipId = newIds[0] || null;

  recalcProjectDuration();
  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  renderMediaPanel();
  window.mountAllClips?.();
  updateSelectionFeedback();
  setStatus(`${newIds.length} clip(s) colado(s)`);
  return true;
}

// Ctrl/⌘+V: se o clipboard do sistema tem a nossa marca (ou não tem HTML),
// cola clips; senão deixa o fluxo de "colar HTML" do app.js agir.
window.addEventListener('paste', e => {
  if (isEditableTarget(e.target) || !_clipClipboard) return;
  const text  = e.clipboardData?.getData('text/plain') || '';
  const files = e.clipboardData?.files?.length || 0;
  const ours  = text.startsWith(CLIP_CLIPBOARD_MARK) || (!files && !isHtmlSource(text));
  if (!ours) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  pasteClipClipboard();
}, true);
// #endregion

// #region Ações (menus, menu de contexto, teclado)
function setStatus(text) {
  const el = $('mbStatus');
  if (el) el.textContent = text;
}

function selectAllClips() {
  if (!state.clips.length) return;
  const sel = getSelectedIds();
  sel.clear();
  state.clips.forEach(c => { if (!isClipLocked(c)) sel.add(c.id); });
  state.currentClipId = [...sel][0] || null;
  renderProjectSettings();
  updateSelectionFeedback();
  window.__onSelectionChange?.(sel);
}

async function renameSelectedClip() {
  const clip = state.clips.find(c => c.id === state.currentClipId);
  if (!clip) return;
  const name = await window.MSUI.prompt({ title: 'Renomear clip', label: 'Nome do clip', value: clip.label, confirmLabel: 'Renomear' });
  if (name == null || !name.trim()) return;
  tlPushUndo();
  window.renameClip(clip.id, name);
  renderProjectSettings();
}

const TIMELINE_ACTIONS = {
  copy:      () => copySelectedClips(),
  cut:       () => copySelectedClips({ cut: true }),
  paste:     () => pasteClipClipboard(),
  duplicate: () => window.duplicateSelectedClips(),
  split:     () => window.splitCurrentScene(),
  delete:    () => window.deleteSelectedClips(),
  ripple:    () => window.rippleDeleteSelectedClips(),
  selectAll: () => selectAllClips(),
  undo:      () => window.__tlUndo?.(),
  redo:      () => window.__tlRedo?.(),
  zoomFit:   () => window.zoomTimelineToFit?.(),
  rename:    () => renameSelectedClip(),
  captions:  () => window.openCaptionsEditor?.(state.currentClipId),
  trackUp:   () => window.moveSelectedToTrack(1),
  trackDown: () => window.moveSelectedToTrack(-1),
  addTrack:  () => window.addTrack(),
  extractAudio: () => window.__extractClipAudio?.(state.currentClipId),
};

/** Executa uma ação; `clipId` (menu de contexto) entra na seleção se ainda não estiver */
window.__runTimelineAction = function runTimelineAction(action, clipId = null) {
  if (clipId && !getSelectedIds().has(clipId) && state.clips.some(c => c.id === clipId)) {
    selectClip(clipId);
  }
  TIMELINE_ACTIONS[action]?.();
};

document.addEventListener('click', e => {
  const item = e.target.closest('[data-tl-action]');
  if (!item || item.classList.contains('disabled')) return;
  window.__runTimelineAction(item.dataset.tlAction);
});

// Teclado (desfazer, copiar, Del, Home/End, Esc…): registro de comandos em commands.js
// #endregion

// #region Áudio por clip (volume, mudo, fades) e por track (mute/solo)
/** Ganho 0–1 do clip no tempo t (preview; o export aplica os mesmos campos) */
window.__clipAudioGain = function clipAudioGain(clip, t) {
  const track   = state.tracks?.find(tr => tr.index === (Number(clip.trackIndex) || 0));
  const anySolo = state.tracks?.some(tr => tr.solo);
  if (clip.muted || track?.muted || (anySolo && !track?.solo)) return 0;

  // Keyframes de volume (audio-keyframes.js) substituem o volume fixo do clip
  let gain = clamp(window.ClipKF?.volumeAt(clip, t) ?? Number(clip.volume ?? 1), 0, 1) * clamp(Number(track?.volume ?? 1), 0, 1);
  const elapsed   = t - clip.start;
  const remaining = clip.start + clip.duration - t;
  if (clip.fadeIn  > 0 && elapsed   < clip.fadeIn)  gain *= clamp(elapsed / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0 && remaining < clip.fadeOut) gain *= clamp(remaining / clip.fadeOut, 0, 1);
  return gain;
};

let _audioGestureClipId = null;

/** Alteração ao vivo (slider): um único passo de undo por gesto */
window.previewClipAudio = function previewClipAudio(clipId, field, value) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;
  if (_audioGestureClipId !== clipId) {
    tlPushUndo();
    _audioGestureClipId = clipId;
  }
  applyAudioField(clip, field, value);
  const label = document.getElementById('apVolumeVal');
  if (label && field === 'volume') label.textContent = Math.round((window.ClipKF?.valueAt(clip, 'volume', state.time) ?? clip.volume) * 100) + '%';
};

window.setClipAudio = function setClipAudio(clipId, field, value) {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;
  if (_audioGestureClipId !== clipId) tlPushUndo();
  _audioGestureClipId = null;
  applyAudioField(clip, field, value);
  refreshClipBlock(clip.id);
  renderProjectSettings();
};

let _audioGestureGroup = null;

/**
 * Edição em grupo: o mesmo campo (ou { campo: valor, … }) em vários clips.
 * live (slider) = um passo de undo por gesto.
 */
window.setClipsAudio = function setClipsAudio(ids, field, value, { live = false } = {}) {
  const clips = ids.map(id => state.clips.find(c => c.id === id)).filter(Boolean);
  if (!clips.length) return;
  const fields = typeof field === 'object' ? field : { [field]: value };
  const gesture = `${Object.keys(fields).join('+')}|${ids.join(',')}`;
  if (_audioGestureGroup !== gesture) tlPushUndo();
  _audioGestureGroup = live ? gesture : null;
  clips.forEach(clip => Object.entries(fields).forEach(([f, v]) => applyAudioField(clip, f, v)));
  if (live) return;
  clips.forEach(clip => refreshClipBlock(clip.id));
  renderProjectSettings();
};

function applyAudioField(clip, field, value) {
  if (field === 'volume' && !window.ClipKF?.handleVolumeInput(clip, clamp(Number(value) / 100, 0, 1))) clip.volume = clamp(Number(value) / 100, 0, 1);
  if (field === 'muted')   clip.muted   = Boolean(value);
  if (field === 'fadeIn')  clip.fadeIn  = clamp(Number(value) || 0, 0, clip.duration / 2);
  if (field === 'fadeOut') clip.fadeOut = clamp(Number(value) || 0, 0, clip.duration / 2);
  window.__syncCompositorToTime?.(state.time);
}

window.__renderAudioProps = function renderAudioProps(clip, tmpl) {
  if (tmpl?.type !== 'video' && tmpl?.type !== 'audio') return '';
  const vol = Math.round(clamp(window.ClipKF?.valueAt(clip, 'volume', state.time) ?? Number(clip.volume ?? 1), 0, 1) * 100);
  const id  = escapeHtml(clip.id);
  return `
    <div class="prop-section">
      <div class="prop-title fx-title">Áudio
        <button class="fx-clear" data-audio-action="reset" data-clip-id="${id}" title="Volume 100%, sem mudo, sem fades e sem keyframes de volume">padrão</button>
      </div>
      <div class="prop-row">
        <label>Volume</label>
        <input type="range" min="0" max="100" step="1" value="${vol}" class="prop-range" data-default="100"
          oninput="window.previewClipAudio('${id}', 'volume', this.value)"
          onchange="window.setClipAudio('${id}', 'volume', this.value)">
        <span class="prop-val" id="apVolumeVal" style="min-width:34px;text-align:right">${vol}%</span>
        ${window.ClipKF?.controls(clip, 'volume') || ''}
      </div>
      <div class="prop-row">
        <label>Mudo</label>
        <input type="checkbox" ${clip.muted ? 'checked' : ''}
          onchange="window.setClipAudio('${id}', 'muted', this.checked)">
      </div>
      <div class="prop-row">
        <label>Fade in (s)</label>
        <input type="number" class="prop-input" min="0" step="0.1" value="${Number(clip.fadeIn || 0)}"
          onchange="window.setClipAudio('${id}', 'fadeIn', this.value)">
      </div>
      <div class="prop-row">
        <label>Fade out (s)</label>
        <input type="number" class="prop-input" min="0" step="0.1" value="${Number(clip.fadeOut || 0)}"
          onchange="window.setClipAudio('${id}', 'fadeOut', this.value)">
      </div>
    </div>
    ${window.__renderAudioToolsProps?.(clip, tmpl) || ''}
    ${window.__renderAudioMeter?.(clip.trackIndex) || ''}
  `;
};
// #endregion

// #region Miniaturas e forma de onda
const _mediaInfo = new Map();   // templateId → { thumbs, aspect, peaks, peaksRate, … }
const _mediaJobs = [];
let   _mediaBusy = false;

/** Texto/legenda também é template HTML, mas não ganha filmstrip (centenas de clips) */
function isHtmlScene(tmpl) {
  return tmpl?.type === 'html' && !tmpl.textTmplId;
}

function mediaInfoFor(tmpl) {
  // HTML editado (IA / editor) ou mídia trocada: refaz miniaturas e picos
  // Vídeo com proxy (HEVC/ProRes…): as miniaturas saem da cópia H.264
  const src = tmpl.type === 'html' ? tmpl.html : (tmpl.proxyUrl || tmpl.dataUrl || tmpl.objectUrl);
  let info = _mediaInfo.get(tmpl.id);
  if (info && info.src !== src) info = null;
  if (!info) {
    info = {
      src, thumbs: [], aspect: 16 / 9, peaks: null,
      peaksRate: tmpl.type === 'audio' ? 200 : 100,
      thumbsDone: false, peaksDone: false, waiters: [],
    };
    _mediaInfo.set(tmpl.id, info);
    if (tmpl.type === 'video') _mediaJobs.push(() => buildThumbnails(tmpl, info), () => buildPeaks(tmpl, info));
    if (tmpl.type === 'audio') _mediaJobs.push(() => buildPeaks(tmpl, info));
    if (isHtmlScene(tmpl))     _mediaJobs.push(() => buildHtmlThumbnails(tmpl, info));
    runMediaJobs();
  }
  return info;
}

/** Chama `fn(info)` agora ou quando o próximo job dessa mídia terminar */
function whenMediaInfo(tmpl, ready, fn) {
  const info = mediaInfoFor(tmpl);
  if (ready(info)) fn(info);
  else info.waiters.push(() => ready(info) && fn(info));
}

async function runMediaJobs() {
  if (_mediaBusy) return;
  _mediaBusy = true;
  while (_mediaJobs.length) {
    try { await _mediaJobs.shift()(); } catch (err) { console.warn('[Timeline] mídia:', err?.message || err); }
    _mediaInfo.forEach(info => {
      const waiters = info.waiters.splice(0);
      waiters.forEach(fn => { if (fn() === false) info.waiters.push(fn); });
    });
    scheduleRenderTimeline();
  }
  _mediaBusy = false;
}

function waitEvent(el, name, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout ${name}`)); }, timeout);
    const ok  = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error(`erro ${name}`)); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(name, ok); el.removeEventListener('error', bad); };
    el.addEventListener(name, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/** ~1 quadro a cada 2s (2–90 quadros), 72px de altura, JPEG pequeno */
async function buildThumbnails(tmpl, info) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = tmpl.proxyUrl || tmpl.dataUrl || tmpl.objectUrl;
  await waitEvent(video, 'loadeddata', 15000);

  const duration = video.duration;
  if (!Number.isFinite(duration) || !video.videoWidth) return;

  const h = 72;
  // Vídeo sem fundo (cor | alpha lado a lado): a miniatura é só a metade da cor
  const packed = tmpl.alphaPacked === 'sbs';
  const srcW = packed ? video.videoWidth / 2 : video.videoWidth;
  const w = Math.max(16, Math.round(h * srcW / video.videoHeight));
  info.aspect = w / h;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const count = clamp(Math.ceil(duration / 2), 2, 90);
  const step  = duration / count;

  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, i * step + step / 2);
    video.currentTime = t;
    try { await waitEvent(video, 'seeked'); } catch (_) { continue; }
    if (packed) ctx.drawImage(video, 0, 0, srcW, video.videoHeight, 0, 0, w, h);
    else ctx.drawImage(video, 0, 0, w, h);
    info.thumbs.push({ t, url: canvas.toDataURL('image/jpeg', 0.6) });
    if (i % 10 === 9) scheduleRenderTimeline();
  }

  info.thumbsDone = true;
  video.removeAttribute('src');
  video.load();
}

/**
 * Clipe HTML: o servidor renderiza quadros num Chromium headless
 * (~1 a cada 1,5s, 2–20 quadros, 90px de altura)
 */
async function buildHtmlThumbnails(tmpl, info) {
  const res = state.project?.res || { w: 1080, h: 1920 };
  info.aspect = res.w / res.h;

  const duration = Math.max(0.1, Number(tmpl.sourceDuration) || 5);
  const count = clamp(Math.ceil(duration / 1.5), 2, 20);
  const times = Array.from({ length: count }, (_, i) => +((i + 0.5) * duration / count).toFixed(3));

  const resp = await fetch('/api/thumbs/html', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: tmpl.html, w: res.w, h: res.h, times, height: 90 }),
  });
  info.thumbsDone = true;
  if (!resp.ok) throw new Error(`miniaturas HTML: HTTP ${resp.status}`);
  const { frames } = await resp.json();
  // Template editado enquanto renderizava: descarta
  if (_mediaInfo.get(tmpl.id) === info) info.thumbs = frames || [];
}

/** Picos de amplitude a 100/s, decodificando o áudio a 8 kHz mono (pouca RAM) */
async function buildPeaks(tmpl, info) {
  if (Number(tmpl.fileSize) > 500e6 || typeof OfflineAudioContext === 'undefined') return;
  const buffer = await (await fetch(tmpl.dataUrl || tmpl.objectUrl)).arrayBuffer();

  let audio;
  try {
    audio = await new OfflineAudioContext(1, 8000, 8000).decodeAudioData(buffer);
  } catch (_) {
    info.peaksDone = true;   // vídeo sem faixa de áudio
    return;
  }

  const data  = audio.getChannelData(0);

  // Medidor de dB (audio-meter.js): pico e RMS absolutos a cada 50 ms
  const LEVEL_RATE = 20;
  const levelBlock = Math.max(1, Math.floor(audio.sampleRate / LEVEL_RATE));
  const levelCount = Math.ceil(data.length / levelBlock);
  const levelPeak = new Float32Array(levelCount);
  const levelRms  = new Float32Array(levelCount);
  for (let i = 0; i < levelCount; i++) {
    let peak = 0, sum = 0;
    const end = Math.min(data.length, (i + 1) * levelBlock);
    for (let j = i * levelBlock; j < end; j++) {
      const v = data[j];
      sum += v * v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    levelPeak[i] = peak;
    levelRms[i] = Math.sqrt(sum / Math.max(1, end - i * levelBlock));
  }
  info.levels = { rate: LEVEL_RATE, peak: levelPeak, rms: levelRms };

  const block = Math.max(1, Math.floor(audio.sampleRate / info.peaksRate));
  const peaks = new Float32Array(Math.ceil(data.length / block));
  let max = 0;
  for (let i = 0; i < peaks.length; i++) {
    let peak = 0;
    const end = Math.min(data.length, (i + 1) * block);
    for (let j = i * block; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;

  info.peaks = peaks;
  info.peaksDone = true;
}

/**
 * Pinta os picos em `width` colunas. timeAt(px) = segundo da fonte da coluna,
 * gainAt(px) = volume/fades do clip; centered = forma espelhada (áudio).
 */
function drawPeaks(ctx, info, { width, height, centered, color, timeAt, secPerPx, gainAt = () => 1 }) {
  const rate = info.peaksRate;
  const peaks = info.peaks;
  ctx.fillStyle = color;
  for (let px = 0; px < width; px++) {
    const t0 = timeAt(px);
    let peak = 0;
    for (let i = Math.floor(t0 * rate), end = Math.max(i + 1, Math.ceil((t0 + secPerPx) * rate)); i < end && i < peaks.length; i++) {
      if (peaks[i] > peak) peak = peaks[i];
    }
    const amp = peak * gainAt(px);
    if (centered) {
      const h = Math.max(1, amp * (height - 2));
      ctx.fillRect(px, (height - h) / 2, 1, h);
    } else {
      const h = Math.max(1, amp * (height - 1));
      ctx.fillRect(px, height - h, 1, h);
    }
  }
}

// Biblioteca (library.js): pôster, scrub no hover e forma de onda dos assets
window.__whenMediaInfo = whenMediaInfo;

/** Níveis absolutos (pico/RMS a 20/s) de uma mídia com áudio; null enquanto analisa */
window.__mediaLevels = tmpl => (tmpl && (tmpl.type === 'audio' || tmpl.type === 'video'))
  ? mediaInfoFor(tmpl).levels || null
  : null;

/** Card do painel de mídia: forma de onda do arquivo inteiro */
window.__paintAudioThumb = function paintAudioThumb(canvas, tmpl) {
  whenMediaInfo(tmpl, info => info.peaks, info => {
    const w = canvas.offsetWidth || 120;
    const h = canvas.offsetHeight || 68;
    canvas.width = w;
    canvas.height = h;
    const duration = Math.max(0.1, Number(tmpl.sourceDuration) || info.peaks.length / info.peaksRate);
    drawPeaks(canvas.getContext('2d'), info, {
      width: w, height: h, centered: true, color: 'rgba(120, 200, 255, 0.85)',
      timeAt: px => px * duration / w, secPerPx: duration / w,
    });
  });
};

/** Faixa [x0, x1] (px relativos ao bloco) que está na janela visível da timeline */
function visibleBlockSpan(clip, pxPerSec) {
  const blockLeft  = clip.start * pxPerSec;
  const blockWidth = Math.max(4, clip.duration * pxPerSec);
  const viewW      = tlScroll.clientWidth || 1200;
  const x0 = Math.max(0, tlScroll.scrollLeft - viewW - blockLeft);
  const x1 = Math.min(blockWidth, tlScroll.scrollLeft + viewW * 2 - blockLeft);
  return x1 > x0 ? [x0, x1] : null;
}

window.__decorateClipBlock = function decorateClipBlock(block, clip, tmpl, pxPerSec) {
  const layer = block.querySelector('.tl-block-media');
  if (!layer || !tmpl) return;
  layer.innerHTML = '';

  // Fades de áudio: rampas nas bordas do bloco
  ['fadeIn', 'fadeOut'].forEach(field => {
    const seconds = Number(clip[field]) || 0;
    if (seconds <= 0) return;
    const ramp = document.createElement('div');
    ramp.className = `tl-fade tl-${field === 'fadeIn' ? 'fade-in' : 'fade-out'}`;
    ramp.style.width = Math.min(seconds * pxPerSec, clip.duration * pxPerSec) + 'px';
    layer.appendChild(ramp);
  });

  if (tmpl.type === 'image') {
    layer.style.backgroundImage = `url("${tmpl.dataUrl}")`;
    layer.classList.add('tl-media-image');
    return;
  }
  const isAudio = tmpl.type === 'audio';
  if (tmpl.type !== 'video' && !isAudio && !isHtmlScene(tmpl)) return;

  const info = mediaInfoFor(tmpl);
  // Esqueleto brilhando enquanto miniaturas/forma de onda ainda estão sendo geradas
  layer.classList.toggle('tl-media-loading', (tmpl.type === 'video' && !info.thumbsDone) || (isAudio && !info.peaksDone) || (isHtmlScene(tmpl) && !info.thumbsDone));
  const span = visibleBlockSpan(clip, pxPerSec);
  if (!span) return;
  const [x0, x1] = span;
  const height   = block.clientHeight || parseFloat(block.style.height) || 60;
  const trimIn   = Number(clip.trimStart) || 0;

  // Tempo da fonte no pixel x do bloco (HTML respeita trim e time stretch)
  const sourceAt = x => tmpl.type === 'html' && typeof mapClipTimeToSource === 'function'
    ? mapClipTimeToSource(clip, clip.start + x / pxPerSec, tmpl)
    : trimIn + x / pxPerSec;

  // Filmstrip: um quadro por "tile" visível, escolhido pelo tempo da fonte
  if (info.thumbs.length) {
    const tileW = Math.max(24, Math.round(height * info.aspect));
    for (let x = Math.floor(x0 / tileW) * tileW; x < x1; x += tileW) {
      const t = sourceAt(x + tileW / 2);
      let best = info.thumbs[0];
      for (const th of info.thumbs) if (Math.abs(th.t - t) < Math.abs(best.t - t)) best = th;
      const img = document.createElement('img');
      img.className = 'tl-thumb';
      img.src = best.url;
      img.style.left  = x + 'px';
      img.style.width = tileW + 'px';
      layer.appendChild(img);
    }
  }

  // Forma de onda só na faixa visível (canvas tem limite de largura).
  // Vídeo: metade de baixo, por cima da filmstrip. Áudio: o bloco todo, espelhada.
  if (info.peaks) {
    const width  = Math.min(8000, Math.ceil(x1 - x0));
    const canvas = document.createElement('canvas');
    canvas.className = isAudio ? 'tl-wave tl-wave-full' : 'tl-wave';
    canvas.width  = width;
    canvas.height = isAudio ? Math.max(16, Math.round(height - 18)) : Math.max(12, Math.round(height * 0.45));
    canvas.style.left  = x0 + 'px';
    canvas.style.width = width + 'px';
    drawPeaks(canvas.getContext('2d'), info, {
      width,
      height: canvas.height,
      centered: isAudio,
      color: isAudio ? 'rgba(120, 200, 255, 0.85)' : 'rgba(130, 234, 0, 0.75)',
      timeAt: px => trimIn + (x0 + px) / pxPerSec,
      secPerPx: 1 / pxPerSec,
      gainAt: px => window.__clipAudioGain(clip, clip.start + (x0 + px) / pxPerSec),
    });
    layer.appendChild(canvas);
  }
};
// #endregion

// #region Aviso de WebGL indisponível
// Sem aceleração por hardware o Chrome atual não cria WebGL (não há mais fallback
// automático por software): clipes 3D ficam em branco no preview. O export não
// é afetado — o Chromium dele roda com WebGL por software.
window.__webglAvailable = (() => {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch (_) {
    return false;
  }
})();

let _webglNoticeShown = false;

function showWebGLNotice() {
  if (_webglNoticeShown || window.__webglAvailable) return;
  _webglNoticeShown = true;
  const bar = document.createElement('div');
  bar.className = 'webgl-notice';
  bar.innerHTML = `
    <b>WebGL indisponível neste navegador</b> — clipes 3D não aparecem no preview (o export funciona normalmente).
    No Chrome: Configurações → Sistema → ative <b>"Usar aceleração de hardware quando disponível"</b> e reinicie.
    Diagnóstico: <code>chrome://gpu</code> (WebGL deve estar "Hardware accelerated").
    <button type="button" aria-label="Fechar">✕</button>`;
  bar.querySelector('button').addEventListener('click', () => bar.remove());
  document.getElementById('previewContainer')?.prepend(bar);
}

(function hookWebGLNotice() {
  const C = window.__Compositor;
  if (!C || window.__webglAvailable) return;
  const mount = C.mount;
  C.mount = function (clip, html) {
    if (/webgl|three(\.module)?(\.min)?\.js|pixi|<canvas/i.test(String(html))) showWebGLNotice();
    return mount.apply(this, arguments);
  };
})();
// #endregion
