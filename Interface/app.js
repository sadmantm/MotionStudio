'use strict';

// #region Configuração Global
const DEFAULT_FPS            = 60;
const DEFAULT_SCENE_DURATION = 8;
const MIN_CLIP_DURATION      = 0.2;
const SNAP_TOLERANCE_PX      = 10;
const PX_PER_SEC             = 80;
const TRACK_HEIGHT           = 64; // altura de cada track (px) — usado p/ thumbnails

const SCENE_COLORS = [
  '#82ea00','#00c2ea','#ea8200','#ea0082','#8200ea',
  '#00ea82','#eacc00','#0082ea','#ea2200','#00ea44',
];
let _isInteracting = false;
// #endregion

// #region Estado da Aplicação
/**
 * Estado global. Separação clara:
 *   project   → configuração do vídeo (resolução, fps, duração editável do projeto)
 *   templates → HTMLs importados (fonte imutável — duração original preservada aqui)
 *   clips     → instâncias na timeline (start, duration, trimStart, trimEnd, trackIndex)
 */
const state = {
  project:       null,
  templates:     [],
  clips:         [],
  currentClipId: null,
  time:          0,
  playing:       false,
  zoom:          1,
  trackZoom:     1,   // ← zoom vertical das tracks (0.5 – 3)
  previewZoom:   1,
  rafId:         null,
  lastTimestamp: null,
  iframeReady:   false,
  seeking:       false,
  snapEnabled:   true,
  selectedTrack: null,   // track ativa: cortar/apagar agem só nela
};
// #endregion

// #region Referências do DOM
const $ = id => document.getElementById(id);

const emptyState   = $('emptyState');
const previewCont  = $('previewContainer');
const mediaGrid    = $('mediaGrid');
const mediaEmpty   = $('mediaEmpty');
const propsContent = $('propsContent');
const projectContent = $('projectContent');
const tlLabels     = $('tlLabels');
const tlTracks     = $('tlTracks');
const tlRuler      = $('tlRuler');
const tlPlayhead   = $('tlPlayhead');
const tlScroll     = $('tlScroll');
const inputTime    = $('inputTime');
const totalDur     = $('totalDuration');
const zoomLabel    = $('zoomLabel');
const previewSize  = $('previewSize');
const previewFpsEl = $('previewFps');
const previewTime  = $('previewTime');
const fileInput    = $('fileInput');

// #endregion

// #region Utilitários
function fmtTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const fr = Math.floor((s % 1) * 100); // centésimos
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}.${String(fr).padStart(2,'0')}`;
}

function parseTime(str) {
  // aceita HH:MM:SS.FF ou MM:SS.F
  const m = str.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  if (m) return parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/100;
  const m2 = str.match(/^(\d+):(\d+)\.(\d)$/);
  if (m2) return parseInt(m2[1])*60 + parseInt(m2[2]) + parseInt(m2[3])/10;
  return null;
}


function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Escapa texto para innerHTML/atributos (labels vêm da transcrição e do usuário). */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function mkId() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function extractResolution(html) {
  const patterns = [
    /#(?:motion-root|stage)\s*\{[^}]*?width\s*:\s*(\d+)px[^}]*?height\s*:\s*(\d+)px/s,
    /#(?:motion-root|stage)\s*\{[^}]*?height\s*:\s*(\d+)px[^}]*?width\s*:\s*(\d+)px/s,
  ];
  for (const [i, re] of patterns.entries()) {
    const m = html.match(re);
    if (m) return i === 0
      ? { w: parseInt(m[1]), h: parseInt(m[2]) }
      : { w: parseInt(m[2]), h: parseInt(m[1]) };
  }
  const wm = html.match(/config\s*[=:{][^}]*?width\s*:\s*(\d+)/);
  const hm = html.match(/config\s*[=:{][^}]*?height\s*:\s*(\d+)/);
  if (wm && hm) return { w: parseInt(wm[1]), h: parseInt(hm[1]) };
  return { w: 1080, h: 1920 };
}

function extractDuration(html) {
  // 1. Valor numérico direto: durationInSeconds: 15
  const direct = html.match(/durationInSeconds\s*:\s*([\d.]+)/);
  if (direct) return parseFloat(direct[1]);

  // 2. Valor via constante: const DURATION = 15; ... durationInSeconds: DURATION
  const constRef = html.match(/durationInSeconds\s*:\s*([A-Z_][A-Z_0-9]*)/);
  if (constRef) {
    const varName = constRef[1];
    // Procura a declaração da constante (const/let/var NOME = número)
    const decl = html.match(
      new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*([\\d.]+)`)
    );
    if (decl) return parseFloat(decl[1]);
  }

  // 3. Fallback: maior setTimeout (comportamento original)
  const matches = [...html.matchAll(/setTimeout\s*\(\s*[^,]+,\s*(\d+)\s*\)/g)];
  if (matches.length) {
    const ms = Math.max(...matches.map(m => parseInt(m[1])));
    if (ms >= 500) return ms / 1000 + 1;
  }

  return DEFAULT_SCENE_DURATION;
}

function extractFps(html) {
  const direct = html.match(/\bfps\s*:\s*(\d+)/);
  if (direct) return parseInt(direct[1]);

  const constRef = html.match(/\bfps\s*:\s*([A-Z_][A-Z_0-9]*)/);
  if (constRef) {
    const varName = constRef[1];
    const decl = html.match(
      new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*(\\d+)`)
    );
    if (decl) return parseInt(decl[1]);
  }

  return DEFAULT_FPS;
}

// #endregion

// #region Normalização de Clips
/**
 * Recalcula o totalDuration do projeto com base nos clips existentes.
 * Nunca usa sourceDuration do template — usa apenas clip.start + clip.duration.
 */
function recalcProjectDuration() {
  if (!state.project) return;
  state.project.totalDuration = state.clips.length
    ? Math.max(...state.clips.map(c => c.start + c.duration))
    : 0;
  if (totalDur) totalDur.textContent = fmtTime(state.project.totalDuration);
  if (previewTime) previewTime.textContent = fmtTime(state.time);
}


function normalizeClip(clip, maxDuration = Infinity) {
  if (!clip) return clip;

  const parsedDuration = Number(clip.duration);
  const safeDuration = Number.isFinite(parsedDuration)
    ? parsedDuration
    : MIN_CLIP_DURATION;

  clip.duration = Math.max(
    MIN_CLIP_DURATION,
    Math.min(safeDuration, maxDuration)
  );

  const tmpl =
    state.templates?.find(
      template => template.id === clip.templateId
    ) || null;

  const isHtmlTimeStretch = Boolean(
    clip.fitAnimationToClip &&
    tmpl?.type === 'html' &&
    !clip.isText
  );

  clip.trimStart = Math.max(
    0,
    Number(clip.trimStart) || 0
  );

  /*
   * No modo time stretch, trimStart e trimEnd representam
   * a faixa original da animação HTML que será remapeada
   * para dentro da duração atual do clipe.
   *
   * Por isso, trimEnd não deve ser alterado para:
   * trimStart + clip.duration.
   */
  if (isHtmlTimeStretch) {
    const sourceDuration = Math.max(
      MIN_CLIP_DURATION,
      Number(tmpl.sourceDuration) || clip.duration
    );

    clip.trimStart = clamp(
      clip.trimStart,
      0,
      Math.max(
        0,
        sourceDuration - MIN_CLIP_DURATION
      )
    );

    const requestedTrimEnd = Number(clip.trimEnd);

    clip.trimEnd = clamp(
      Number.isFinite(requestedTrimEnd)
        ? requestedTrimEnd
        : sourceDuration,
      clip.trimStart + MIN_CLIP_DURATION,
      sourceDuration
    );

    return clip;
  }

  const expectedTrimEnd =
    clip.trimStart + clip.duration;

  if (
    clip.trimEnd == null ||
    Math.abs(
      Number(clip.trimEnd) - expectedTrimEnd
    ) > 0.001
  ) {
    clip.trimEnd = expectedTrimEnd;
  }

  return clip;
}

/** Retorna o clip selecionado ou null. */
function selectedClip() {
  return state.clips.find(c => c.id === state.currentClipId) || null;
}

/** Retorna o clip que está sob o playhead no momento atual. */
function clipAtTime(t) {
  return state.clips
    .filter(c => t >= c.start && t < c.start + c.duration)
    .sort((a, b) => b.trackIndex - a.trackIndex)[0] || null;
}

// #endregion

// #region Updates
function normalizeSceneInput(input, index = 0) {
  if (!input || typeof input !== 'object') return null;

  const item = { ...input };
  const name = String(item.name || `Cena ${state.clips.length + index + 1}`);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  if (!item.type) {
    if (typeof item.html === 'string') item.type = 'html';
    else if (
      /^video\//i.test(item.mimeType || '') ||
      /^(mp4|webm|mov|mkv|avi|ogv)$/i.test(ext)
    ) {
      item.type = 'video';
    } else if (
      /^image\//i.test(item.mimeType || '') ||
      /^(jpe?g|png|gif|webp|avif|svg)$/i.test(ext)
    ) {
      item.type = 'image';
    } else if (
      /^audio\//i.test(item.mimeType || '') ||
      AUDIO_EXT_RE.test(ext)
    ) {
      item.type = 'audio';
    }
  }

  if (!['html', 'video', 'image', 'audio'].includes(item.type)) return null;
  if (item.type === 'html' && typeof item.html !== 'string') return null;
  if (item.type !== 'html' && !item.dataUrl) return null;

  item.name = item.type === 'html' && !/\.html?$/i.test(name)
    ? `${name}.html`
    : name;

  return item;
}

function syncProjectFormFields() {
  if (!state.project) return;

  const {
    res,
    fps,
    background = '#000000',
  } = state.project;

  const fields = {
    exportWidth: res.w,
    exportHeight: res.h,
    exportFps: fps,
  };

  Object.entries(fields).forEach(([id, value]) => {
    const element = $(id);
    if (element) element.value = String(value);
  });

  if (previewSize) {
    previewSize.textContent = `${res.w} × ${res.h}`;
  }

  if (previewFpsEl) {
    previewFpsEl.textContent = `${fps} fps`;
  }

  const wrapper = $('previewWrapper');

  if (wrapper) {
    wrapper.style.backgroundColor = background;
  }
}

function ensureProject(firstFile = null, overrides = {}) {
  if (state.project) return state.project;

  const first = firstFile
    ? normalizeSceneInput(firstFile, 0)
    : null;

  const detectedRes = first?.type === 'html'
    ? extractResolution(first.html)
    : { w: 1080, h: 1920 };

  const detectedFps = first?.type === 'html'
    ? extractFps(first.html)
    : DEFAULT_FPS;

  const now = new Date().toISOString();

  state.project = {
    id: overrides.id || mkId(),
    name: String(overrides.name || 'Projeto sem título'),

    res: {
      w: clamp(
        Number(overrides.res?.w ?? detectedRes.w) || 1080,
        1,
        7680
      ),

      h: clamp(
        Number(overrides.res?.h ?? detectedRes.h) || 1920,
        1,
        7680
      ),
    },

    fps: clamp(
      Number(overrides.fps ?? detectedFps) || DEFAULT_FPS,
      1,
      240
    ),

    background: /^#[0-9a-f]{6}$/i.test(overrides.background || '')
      ? overrides.background
      : '#000000',

    totalDuration: 0,
    createdAt: overrides.createdAt || now,
    updatedAt: now,
  };

  state.time = 0;
  state.currentClipId = null;

  syncProjectFormFields();
  syncProjectGlobals();

  const status = $('mbStatus');

  if (status) {
    status.textContent = 'Projeto iniciado';
  }

  return state.project;
}

function refreshEditorAfterProjectChange({
  mount = true,
  seek = true,
} = {}) {
  recalcProjectDuration();
  syncProjectGlobals();
  renderMediaPanel();
  renderProjectSettings();
  window.__renderTimeline?.();

  if (mount) {
    window.mountAllClips?.();
  }

  const hasClips = state.clips.length > 0;

  if (emptyState) {
    emptyState.style.display = hasClips ? 'none' : 'flex';
  }

  if (previewCont) {
    previewCont.style.display = hasClips ? 'flex' : 'none';
  }

  syncProjectFormFields();

  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  const snapButton = $('btnTlSnap');

  if (snapButton) {
    snapButton.dataset.active = state.snapEnabled
      ? 'true'
      : 'false';
  }

  window.__applyTrackZoom?.(state.trackZoom);

  requestAnimationFrame(() => {
    window.__syncPreviewSize?.();

    if (seek && hasClips) {
      window.seekTo?.(state.time);
    }
  });
}

/**
 * Template (asset da biblioteca) a partir de um arquivo normalizado. Não
 * coloca nada na timeline — ver createClipForTemplate.
 */
async function createTemplateFromInput(file, color) {
  if (file.type === 'html') {
    return {
      id: mkId(),
      name: file.name.replace(/\.html?$/i, ''),
      type: 'html',
      html: file.html,
      sourceDuration: Math.max(MIN_CLIP_DURATION, extractDuration(file.html)),
      fps: extractFps(file.html) || state.project.fps,
      color,
      inLibrary: true,
    };
  }

  const media = {
    id: mkId(),
    name: file.name.replace(/\.\w+$/i, ''),
    type: file.type,
    dataUrl: file.dataUrl,
    objectUrl: file.objectUrl || null,
    isObjectUrl: Boolean(file.isObjectUrl || /^blob:/i.test(file.dataUrl)),
    fileSize: Number(file.fileSize) || 0,
    fps: state.project.fps,
    color,
    inLibrary: true,
  };

  if (file.type === 'video') {
    return {
      ...media,
      mimeType: file.mimeType || 'video/mp4',
      sourceDuration: Math.max(MIN_CLIP_DURATION, Number(file.duration) || await probeVideoDuration(file.dataUrl)),
      res: {
        w: Number(file.videoWidth || file.width) || state.project.res.w,
        h: Number(file.videoHeight || file.height) || state.project.res.h,
      },
    };
  }

  if (file.type === 'image') {
    return {
      ...media,
      mimeType: file.mimeType || 'image/png',
      sourceDuration: projectImageDuration(),
      res: {
        w: Number(file.videoWidth || file.imageWidth || file.width) || state.project.res.w,
        h: Number(file.videoHeight || file.imageHeight || file.height) || state.project.res.h,
      },
    };
  }

  return {
    ...media,
    mimeType: file.mimeType || 'audio/mpeg',
    sourceDuration: Math.max(MIN_CLIP_DURATION, Number(file.duration) || await probeAudioDuration(file.dataUrl)),
  };
}

/** Clip novo (ainda fora de state.clips) de um template, em `start` na track `trackIndex` */
function createClipForTemplate(template, start, trackIndex) {
  const duration = template.type === 'image'
    ? projectImageDuration()
    : Math.max(MIN_CLIP_DURATION, Number(template.sourceDuration) || DEFAULT_SCENE_DURATION);
  const visual = template.type === 'video' || template.type === 'image';
  return normalizeClip({
    id: mkId(),
    templateId: template.id,
    label: template.name,
    trackIndex,
    start: Math.max(0, start),
    duration,
    trimStart: 0,
    trimEnd: duration,
    color: template.color || SCENE_COLORS[0],
    ...(visual ? { _tx: _calcFitTx(template.res?.w || state.project.res.w, template.res?.h || state.project.res.h, state.project.res) } : {}),
  });
}

/**
 * Coloca templates da biblioteca na timeline, um após o outro a partir de `at`.
 * Track: a pedida, se estiver livre no trecho; senão a 1ª livre acima.
 * Áudio sempre numa track livre (não empurra o vídeo).
 */
function addTemplatesToTimeline(templateIds, { at = state.time, trackIndex = null, undo = true } = {}) {
  if (!state.project) return [];
  if (undo) window.__tlPushUndo?.();
  const added = [];
  let cursor = Math.max(0, Number(at) || 0);

  templateIds.forEach(id => {
    const template = state.templates.find(t => t.id === id);
    if (!template) return;
    const probe = createClipForTemplate(template, cursor, 0);
    const end = probe.start + probe.duration;
    const preferred = trackIndex ?? 0;
    const track = window.__findFreeTrack?.(probe.start, end, preferred) ?? preferred;
    probe.trackIndex = track;
    window.getTrack?.(track);
    state.clips.push(probe);
    added.push(probe.id);
    cursor = end;
  });

  if (!added.length) return [];
  state.currentClipId = added[0];
  state.project.updatedAt = new Date().toISOString();
  refreshEditorAfterProjectChange({ mount: true, seek: true });
  return added;
}

/**
 * Importa arquivos normalizados. toTimeline=false: só biblioteca (import
 * padrão, estilo CapCut). toTimeline=true: também entram na timeline a
 * partir de `at` (ou emendados no fim, como antes).
 * onTemplate(template, input) é chamado para cada asset criado (ex.: copiar
 * a mídia para a pasta do projeto).
 */
async function loadScenes(files, { toTimeline = true, at = null, trackIndex = null, onTemplate = null } = {}) {
  const normalizedFiles = Array.from(files || [])
    .map((file, index) => normalizeSceneInput(file, index))
    .filter(Boolean);

  if (!normalizedFiles.length) {
    const status = $('mbStatus');

    if (status) {
      status.textContent = 'Nenhuma mídia válida';
    }

    return [];
  }

  ensureProject(normalizedFiles[0]);

  // Áudio por último: as mídias visuais ocupam a track 0 primeiro e o áudio
  // procura uma track livre sem colidir com elas
  normalizedFiles.sort((a, b) =>
    (a.type === 'audio') - (b.type === 'audio')
  );

  const templates = [];
  for (const file of normalizedFiles) {
    const color = SCENE_COLORS[state.templates.length % SCENE_COLORS.length];
    const template = await createTemplateFromInput(file, color);
    state.templates.push(template);
    templates.push(template);
    onTemplate?.(template, file);
  }

  if (!toTimeline) {
    state.project.updatedAt = new Date().toISOString();
    renderMediaPanel();
    const status = $('mbStatus');
    if (status) status.textContent = `${templates.length} arquivo(s) na biblioteca`;
    return templates.map(t => t.id);
  }

  // Sem posição: visuais emendados no fim da track 0, áudio no playhead
  const visual = templates.filter(t => t.type !== 'audio').map(t => t.id);
  const audio  = templates.filter(t => t.type === 'audio').map(t => t.id);
  const end    = state.clips.length ? Math.max(...state.clips.map(c => c.start + c.duration)) : 0;
  const added  = [
    ...addTemplatesToTimeline(visual, { at: at ?? end, trackIndex: trackIndex ?? 0 }),
    ...addTemplatesToTimeline(audio, { at: at ?? (state.clips.length ? state.time : 0), trackIndex }),
  ];

  const status = $('mbStatus');

  if (status) {
    status.textContent = `${state.clips.length} clip(s)`;
  }

  return added;
}

function revokeCurrentProjectObjectUrls() {
  const urls = new Set();

  state.templates.forEach(template => {
    if (
      template?.objectUrl &&
      /^blob:/i.test(template.objectUrl)
    ) {
      urls.add(template.objectUrl);
    }

    if (
      template?.isObjectUrl &&
      /^blob:/i.test(template.dataUrl || '')
    ) {
      urls.add(template.dataUrl);
    }
  });

  urls.forEach(url => {
    URL.revokeObjectURL(url);
  });
}

function clearCurrentProjectRuntime() {
  revokeCurrentProjectObjectUrls();

  state.playing = false;

  if (state.rafId != null) {
    cancelAnimationFrame(state.rafId);
  }

  state.project = null;

  state.templates.splice(
    0,
    state.templates.length
  );

  state.clips.splice(
    0,
    state.clips.length
  );

  state.currentClipId = null;
  state.selectedTrack = null;
  state.markers = [];
  state.tracks = [];
  state.time = 0;
  state.rafId = null;
  state.lastTimestamp = null;
  state.iframeReady = false;
  state.seeking = false;
  state.zoom = 1;
  state.trackZoom = 1;
  state.previewZoom = 1;
  state.snapEnabled = true;

  window.__selectedClipIds?.clear?.();
  window.__tlResetHistory?.();

  $('previewWrapper')?.replaceChildren();

  if (inputTime) {
    inputTime.value = fmtTime(0);
  }

  if (totalDur) {
    totalDur.textContent = fmtTime(0);
  }

  if (previewTime) {
    previewTime.textContent = fmtTime(0);
  }

  if ($('previewClipName')) {
    $('previewClipName').textContent = '—';
  }

  if (propsContent) {
    propsContent.innerHTML =
      '<div class="props-empty">Selecione um clip</div>';
  }

  if (projectContent) {
    projectContent.innerHTML =
      '<div class="props-empty">Crie ou abra um projeto</div>';
  }

  syncProjectGlobals();
  renderMediaPanel();
  window.__renderTimeline?.();

  if (previewCont) {
    previewCont.style.display = 'none';
  }

  if (emptyState) {
    emptyState.style.display = 'flex';
  }
}

function createNewProject(options = {}) {
  const hasCurrentWork = Boolean(
    state.project ||
    state.clips.length ||
    state.templates.length
  );

  // A confirmação ("alterações não salvas…") é feita pelo chamador, com MSUI.confirm (projectCommands.create)

  const width = clamp(
    Number(
      options.width
    ) || 1080,
    1,
    7680
  );

  const height = clamp(
    Number(
      options.height
    ) || 1920,
    1,
    7680
  );

  const fps = clamp(
    Number(
      options.fps
    ) || 30,
    1,
    240
  );

  const backgroundCandidate = String(
    options.background ??
    '#000000'
  );

  const background =
    /^#[0-9a-f]{6}$/i.test(backgroundCandidate)
      ? backgroundCandidate
      : '#000000';

  clearCurrentProjectRuntime();

  const project = ensureProject(null, {
    name:
      options.name ||
      'Projeto sem título',

    res: {
      w: width,
      h: height,
    },

    fps,
    background,
  });

  renderProjectSettings();
  window.__renderTimeline?.();

  const status = $('mbStatus');

  if (status) {
    status.textContent = 'Novo projeto';
  }

  if (options.openSettings === true) {
    window.MSProjectSettings?.open();
  }

  return project;
}

function cloneSerializable(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(
    JSON.stringify(value)
  );
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(String(reader.result));
    };

    reader.onerror = () => {
      reject(
        reader.error ||
        new Error('Falha ao converter mídia.')
      );
    };

    reader.readAsDataURL(blob);
  });
}

async function makeTemplatePortable(template) {
  const portable = cloneSerializable(template);

  const source =
    portable.dataUrl ||
    portable.objectUrl ||
    '';

  if (
    portable.type !== 'html' &&
    portable.type !== 'text' &&
    source &&
    !/^data:/i.test(source)
  ) {
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(
        `Falha ao incorporar a mídia "${portable.name}".`
      );
    }

    portable.dataUrl = await blobToDataUrl(
      await response.blob()
    );
  }

  delete portable.objectUrl;
  delete portable.isObjectUrl;
  delete portable.mediaUrl;
  delete portable.mediaFile;

  return portable;
}

async function buildMotionStudioProjectPayload() {
  if (!state.project) {
    throw new Error('Nenhum projeto aberto.');
  }

  const templates = [];

  for (const template of state.templates) {
    templates.push(
      await makeTemplatePortable(template)
    );
  }

  return {
    signature: 'MOTION_STUDIO_PROJECT',
    format: 'motion-studio-project',
    version: 1,
    savedAt: new Date().toISOString(),

    project: cloneSerializable(
      state.project
    ),

    templates,

    clips: cloneSerializable(
      state.clips
    ),

    tracks: cloneSerializable(
      state.tracks || []
    ),

    editor: {
      currentClipId: state.currentClipId,
      time: state.time,
      zoom: state.zoom,
      trackZoom: state.trackZoom,
      previewZoom: state.previewZoom,
      snapEnabled: state.snapEnabled,
      markers: window.__mkSnap?.() || [],
    },
  };
}

function sanitizeProjectFileName(value) {
  const base = String(
    value || 'projeto-motion-studio'
  )
    .replace(/\.ms$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  return `${
    base || 'projeto-motion-studio'
  }.ms`;
}

async function saveMotionStudioProject() {
  if (!state.project) {
    window.MSUI.notify(
      'Crie ou abra um projeto antes de salvar.'
    );

    return false;
  }

  if (
    !state.project.name ||
    state.project.name === 'Projeto sem título'
  ) {
    const chosenName = await window.MSUI.prompt({
      title: 'Salvar projeto',
      label: 'Nome do projeto',
      value: state.project.name || 'Projeto sem título',
      confirmLabel: 'Salvar',
    });

    if (chosenName === null) {
      return false;
    }

    state.project.name =
      chosenName.trim() ||
      'Projeto sem título';
  }

  const status = $('mbStatus');

  if (status) {
    status.textContent = 'Salvando projeto…';
  }

  try {
    state.project.updatedAt =
      new Date().toISOString();

    const payload =
      await buildMotionStudioProjectPayload();

    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      {
        type: 'application/x-motionstudio-project;charset=utf-8',
      }
    );

    const url =
      URL.createObjectURL(blob);

    const anchor =
      document.createElement('a');

    anchor.href = url;
    anchor.download =
      sanitizeProjectFileName(
        state.project.name
      );

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);

    if (status) {
      status.textContent = 'Projeto salvo';
    }

    return true;
  } catch (error) {
    console.error(
      '[Motion Studio] Erro ao salvar projeto:',
      error
    );

    if (status) {
      status.textContent = 'Erro ao salvar';
    }

    window.MSUI.notify(
      `Não foi possível salvar o projeto: ${
        error.message || error
      }`
    );

    return false;
  }
}

function chooseMotionStudioProjectFile() {
  return new Promise(resolve => {
    const input =
      document.createElement('input');

    input.type = 'file';

    input.accept =
      '.ms,application/json,application/x-motionstudio-project';

    input.style.display = 'none';

    input.addEventListener(
      'change',
      () => {
        const file =
          input.files?.[0] || null;

        input.remove();
        resolve(file);
      },
      { once: true }
    );

    input.addEventListener(
      'cancel',
      () => {
        input.remove();
        resolve(null);
      },
      { once: true }
    );

    document.body.appendChild(input);
    input.click();
  });
}

function validateMotionStudioProjectPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error(
      'Arquivo de projeto inválido.'
    );
  }

  if (
    payload.signature !==
      'MOTION_STUDIO_PROJECT' &&
    payload.format !==
      'motion-studio-project'
  ) {
    throw new Error(
      'Este arquivo não é um projeto do Motion Studio.'
    );
  }

  if (Number(payload.version) !== 1) {
    throw new Error(
      `Versão de projeto não suportada: ${payload.version}.`
    );
  }

  if (
    !payload.project ||
    !Array.isArray(payload.templates) ||
    !Array.isArray(payload.clips)
  ) {
    throw new Error(
      'O projeto está incompleto ou corrompido.'
    );
  }

  return payload;
}

/**
 * Carrega um projeto (payload do .ms ou da biblioteca de projetos) no
 * editor, substituindo o atual. Não pergunta nada: quem chama confirma.
 */
function applyProjectPayload(payload, fallbackName = '') {
  clearCurrentProjectRuntime();

  const project =
    cloneSerializable(payload.project);

  project.res = {
    w: clamp(
      Number(project.res?.w) || 1080,
      1,
      7680
    ),

    h: clamp(
      Number(project.res?.h) || 1920,
      1,
      7680
    ),
  };

  project.fps = clamp(
    Number(project.fps) || DEFAULT_FPS,
    1,
    240
  );

  project.background =
    /^#[0-9a-f]{6}$/i.test(
      project.background || ''
    )
      ? project.background
      : '#000000';

  project.name = String(
    project.name ||
    fallbackName ||
    'Projeto sem título'
  );

  project.totalDuration = 0;

  state.project = project;

  state.templates.push(
    ...cloneSerializable(
      payload.templates
    )
  );

  state.clips.push(
    ...cloneSerializable(payload.clips).map(
      clip =>
        normalizeClip({
          ...clip,

          id: clip.id || mkId(),

          trackIndex: Math.max(
            0,
            Number(clip.trackIndex) || 0
          ),

          start: Math.max(
            0,
            Number(clip.start) || 0
          ),

          duration: Math.max(
            MIN_CLIP_DURATION,
            Number(clip.duration) ||
            DEFAULT_SCENE_DURATION
          ),

          color:
            clip.color ||
            SCENE_COLORS[0],
        })
    )
  );

  // Projeto de antes da biblioteca (sem a marca inLibrary): cada mídia/HTML
  // distinto vira um asset; cópias de corte (mesmo conteúdo) apontam para ele
  if (!state.templates.some(t => 'inLibrary' in t)) {
    const firstBySource = new Map();
    state.templates.forEach(t => {
      if (t.type === 'text' || t.textTmplId) return;
      const source = t.type === 'html' ? t.html : (t.dataUrl || t.mediaUrl);
      if (!source) return;
      const first = firstBySource.get(source);
      if (first) {
        t.inLibrary = false;
        t.libraryId = first.id;
      } else {
        t.inLibrary = true;
        firstBySource.set(source, t);
      }
    });
  }

  // Tracks: nomes, bloqueio, mudo e solo (projetos antigos não tinham)
  state.tracks = Array.isArray(payload.tracks)
    ? cloneSerializable(payload.tracks)
    : [];

  const editor = payload.editor || {};

  const requestedClipId =
    editor.currentClipId;

  state.currentClipId =
    state.clips.some(
      clip => clip.id === requestedClipId
    )
      ? requestedClipId
      : state.clips[0]?.id || null;

  state.time = Math.max(
    0,
    Number(editor.time) || 0
  );

  state.zoom = clamp(
    Number(editor.zoom) || 1,
    0.1,
    16
  );

  state.trackZoom = clamp(
    Number(editor.trackZoom) || 1,
    0.4,
    3
  );

  state.previewZoom = clamp(
    Number(editor.previewZoom) || 1,
    0.1,
    4
  );

  state.snapEnabled =
    editor.snapEnabled !== false;

  state.markers = Array.isArray(editor.markers)
    ? editor.markers.filter(m => m && Number.isFinite(Number(m.t))).map(m => ({ ...m }))
    : [];

  recalcProjectDuration();

  state.time = clamp(
    state.time,
    0,
    state.project.totalDuration || 0
  );

  refreshEditorAfterProjectChange({
    mount: true,
    seek: true,
  });

  return state.project;
}

async function openMotionStudioProject(file = null) {
  const selectedFile =
    file ||
    await chooseMotionStudioProjectFile();

  if (!selectedFile) {
    return false;
  }

  const status = $('mbStatus');

  if (status) {
    status.textContent = 'Abrindo projeto…';
  }

  try {
    const payload =
      validateMotionStudioProjectPayload(
        JSON.parse(
          await selectedFile.text()
        )
      );

    // Com a biblioteca de projetos, o .ms vira um projeto novo dela
    if (window.MSProjects) {
      return window.MSProjects.importPayload(
        payload,
        selectedFile.name.replace(/\.ms$/i, '')
      );
    }

    if (
      (state.project || state.clips.length) &&
      !(await window.MSUI.confirm({
        title: 'Abrir projeto',
        message: 'Abrir este projeto? Alterações não salvas serão perdidas.',
        confirmLabel: 'Abrir',
      }))
    ) {
      if (status) {
        status.textContent =
          'Abertura cancelada';
      }

      return false;
    }

    applyProjectPayload(
      payload,
      selectedFile.name.replace(/\.ms$/i, '')
    );

    if (status) {
      status.textContent =
        `Projeto aberto: ${state.project.name}`;
    }

    return true;
  } catch (error) {
    console.error(
      '[Motion Studio] Erro ao abrir projeto:',
      error
    );

    if (status) {
      status.textContent = 'Erro ao abrir';
    }

    window.MSUI.notify(
      `Não foi possível abrir o projeto: ${
        error.message || error
      }`
    );

    return false;
  }
}

/**
 * Caixa (_tx) de um clip na resolução nova sem distorcer: quadro inteiro
 * continua inteiro, mídia "encaixada" é reencaixada, o resto escala por
 * igual em torno do centro (antes X e Y escalavam separados e 9:16 → 16:9
 * esticava vídeos e imagens).
 */
function retargetClipTx(clip, prevRes, nextRes) {
  const tx = clip._tx;
  if (!tx) return null;
  const near = (a, b) => Math.abs((Number(a) || 0) - b) < 1.5;
  if (near(tx.x, 0) && near(tx.y, 0) && near(tx.w, prevRes.w) && near(tx.h, prevRes.h)) {
    return { ...tx, x: 0, y: 0, w: nextRes.w, h: nextRes.h };
  }

  const tmpl = state.templates.find(t => t.id === clip.templateId);
  if (tmpl?.res && (tmpl.type === 'video' || tmpl.type === 'image')) {
    const prevFit = _calcFitTx(tmpl.res.w, tmpl.res.h, prevRes);
    if (near(tx.x, prevFit.x) && near(tx.y, prevFit.y) && near(tx.w, prevFit.w) && near(tx.h, prevFit.h)) {
      return { ...tx, ..._calcFitTx(tmpl.res.w, tmpl.res.h, nextRes), r: tx.r || 0 };
    }
  }

  const sx = nextRes.w / prevRes.w;
  const sy = nextRes.h / prevRes.h;
  const k  = Math.min(sx, sy);
  const cx = ((Number(tx.x) || 0) + (Number(tx.w) || 0) / 2) * sx;
  const cy = ((Number(tx.y) || 0) + (Number(tx.h) || 0) / 2) * sy;
  const w  = Math.max(1, Math.round((Number(tx.w) || 1) * k));
  const h  = Math.max(1, Math.round((Number(tx.h) || 1) * k));
  return { ...tx, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

/** Aplica resolução, fps e fundo ao projeto aberto ({ width, height, fps, background }) */
function applyProjectSettings(values = {}) {
  if (!state.project) return;

  const width = clamp(Math.round(Number(values.width) || state.project.res.w), 16, 7680);
  const height = clamp(Math.round(Number(values.height) || state.project.res.h), 16, 7680);
  const fps = clamp(Math.round(Number(values.fps) || state.project.fps), 1, 240);
  const background = /^#[0-9a-f]{6}$/i.test(values.background || '')
    ? values.background
    : state.project.background || '#000000';

  const previousRes = { ...state.project.res };
  const resChanged = previousRes.w !== width || previousRes.h !== height;

  if (resChanged || fps !== state.project.fps) {
    window.__tlPushUndo?.();
  }

  state.project.res = { w: width, h: height };
  state.project.fps = fps;
  state.project.background = background;
  state.project.updatedAt = new Date().toISOString();

  if (resChanged) {
    state.clips.forEach(clip => {
      const next = retargetClipTx(clip, previousRes, state.project.res);
      if (next) clip._tx = next;
    });

    // Textos são gerados para a resolução do projeto: refaz o documento
    state.templates.forEach(template => {
      if (template.type === 'text' && template.textTmplId && template.textParams) {
        template.html = window.__TextRegistry?.buildHtml(
          template.textTmplId, template.textParams, state.project.res
        ) || template.html;
      }
    });
    if (typeof renderTextPanel === 'function') renderTextPanel();

    // O compositor guarda iframe e transformação de cada clip na resolução
    // antiga: desmonta tudo para remontar no tamanho novo
    window.__Compositor?.allIds().forEach(id => window.__Compositor.unmount(id));
  }

  refreshEditorAfterProjectChange({
    mount: true,
    seek: true,
  });

  // Caixa de seleção do preview acompanha o reenquadramento (depois do resize do palco)
  if (resChanged) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__refreshTransformOverlay?.();
    }));
  }

  const status = $('mbStatus');

  if (status) {
    status.textContent =
      'Configurações aplicadas';
  }
}

function createProjectMenuItem({
  id,
  label,
  shortcut,
  iconPath,
}) {
  const item =
    document.createElement('div');

  item.className = 'mb-item';
  item.id = id;

  item.innerHTML = `
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="${iconPath}"></path>
    </svg>

    ${label}

    <span class="mb-shortcut">
      ${shortcut}
    </span>
  `;

  return item;
}

function configureProjectMenuItems() {
  const dropdown = document.querySelector(
    '.mb-menu[data-menu="cena"] .mb-dropdown'
  );

  if (!dropdown) {
    return {};
  }

  const items = Array.from(
    dropdown.querySelectorAll('.mb-item')
  );

  const saveItem = items.find(item =>
    item.textContent
      .trim()
      .startsWith('Salvar Projeto')
  );

  const openItem = items.find(item =>
    item.textContent
      .trim()
      .startsWith('Abrir Projeto')
  );

  if (saveItem) {
    saveItem.id = 'mbSaveProject';
    saveItem.classList.remove('disabled');
  }

  if (openItem) {
    openItem.id = 'mbOpenProject';
    openItem.classList.remove('disabled');
  }

  let newItem = $('mbNewProject');

  if (!newItem) {
    newItem = createProjectMenuItem({
      id: 'mbNewProject',
      label: 'Novo Projeto',
      shortcut: 'Ctrl+N',
      iconPath: 'M12 5v14M5 12h14',
    });

    dropdown.insertBefore(
      newItem,
      dropdown.firstChild
    );
  }

  // Exportar/importar um arquivo .ms (compartilhar o projeto com outro PC)
  let exportItem = $('mbExportMs');

  if (!exportItem && saveItem) {
    exportItem = createProjectMenuItem({
      id: 'mbExportMs',
      label: 'Exportar arquivo .ms…',
      shortcut: '',
      iconPath: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
    });

    openItem?.after(exportItem);
  }

  let importItem = $('mbImportMs');

  if (!importItem && exportItem) {
    importItem = createProjectMenuItem({
      id: 'mbImportMs',
      label: 'Importar arquivo .ms…',
      shortcut: '',
      iconPath: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
    });

    exportItem.after(importItem);
  }

  if (openItem) {
    openItem.childNodes.forEach(node => {
      if (node.nodeType === 3 && node.nodeValue.includes('Abrir Projeto')) {
        node.nodeValue = 'Projetos… ';
      }
    });
  }

  return {
    newItem,
    saveItem,
    openItem,
    exportItem,
    importItem,
  };
}

/** Com a biblioteca de projetos (projects.js) os comandos de arquivo passam por ela */
const projectCommands = {
  create: () => window.MSProjects
    ? window.MSProjects.showHome({ create: true })
    : (async () => {
        if ((state.project || state.clips.length || state.templates.length) && !(await window.MSUI.confirm({
          title: 'Novo projeto',
          message: 'Criar um novo projeto? Alterações não salvas serão perdidas.',
          confirmLabel: 'Criar',
        }))) return null;
        return createNewProject({ confirm: false });
      })(),

  save: () => window.MSProjects?.currentId()
    ? window.MSProjects.saveNow({ thumb: true }).then(() => {
        const status = $('mbStatus');
        if (status) status.textContent = 'Projeto salvo';
      }).catch(() => {})
    : saveMotionStudioProject(),

  open: () => window.MSProjects
    ? window.MSProjects.showHome()
    : openMotionStudioProject(),
};

function initProjectFileActions() {
  window.__motionStudioProjectController?.abort();

  const controller =
    new AbortController();

  window.__motionStudioProjectController =
    controller;

  const options = {
    signal: controller.signal,
  };

  const menu =
    configureProjectMenuItems();

  menu.newItem?.addEventListener(
    'click',
    projectCommands.create,
    options
  );

  menu.saveItem?.addEventListener(
    'click',
    projectCommands.save,
    options
  );

  menu.openItem?.addEventListener(
    'click',
    projectCommands.open,
    options
  );

  menu.exportItem?.addEventListener(
    'click',
    saveMotionStudioProject,
    options
  );

  menu.importItem?.addEventListener(
    'click',
    () => openMotionStudioProject(),
    options
  );

  // Ctrl+N / Ctrl+S / Ctrl+O: comandos 'project-*' em commands.js
}

function initMotionStudioProjectSystem() {
  initPasteHtmlFlow();
  initProjectFileActions();
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      resolve(
        String(reader.result || '')
      );
    };

    reader.onerror = () => {
      reject(
        reader.error ||
        new Error(
          `Falha ao ler ${file.name}.`
        )
      );
    };

    reader.readAsText(file);
  });
}

function probeVideoFile(file, objectUrl) {
  return new Promise(resolve => {
    const video =
      document.createElement('video');

    let settled = false;

    const finish = metadata => {
      if (settled) return;

      settled = true;

      video.removeAttribute('src');
      video.load();

      resolve(metadata);
    };

    video.preload = 'metadata';
    video.muted = true;

    video.onloadedmetadata = () =>
      finish({
        audioOnly:
          !video.videoWidth,

        videoWidth:
          video.videoWidth || 1080,

        videoHeight:
          video.videoHeight || 1920,

        duration:
          Number.isFinite(video.duration) &&
          video.duration > 0
            ? video.duration
            : DEFAULT_VIDEO_DURATION,
      });

    video.onerror = () =>
      finish({
        videoWidth: 1080,
        videoHeight: 1920,
        duration: DEFAULT_VIDEO_DURATION,
      });

    video.src = objectUrl;
  });
}

function probeImageFile(file, objectUrl) {
  return new Promise(resolve => {
    const image = new Image();

    let settled = false;

    const finish = metadata => {
      if (settled) return;

      settled = true;
      image.onload = null;
      image.onerror = null;

      resolve(metadata);
    };

    image.onload = () =>
      finish({
        videoWidth:
          image.naturalWidth || 1080,

        videoHeight:
          image.naturalHeight || 1920,
      });

    image.onerror = () =>
      finish({
        videoWidth: 1080,
        videoHeight: 1920,
      });

    image.src = objectUrl;
  });
}

async function handleMediaFiles(fileList, options = {}) {
  const allowed = Array.from(
    fileList || []
  ).filter(file =>
    /\.html?$/i.test(file.name) ||
    /\.(mp4|webm|mov|mkv|avi|ogv)$/i.test(
      file.name
    ) ||
    /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(
      file.name
    ) ||
    AUDIO_EXT_RE.test(
      file.name.split('.').pop()
    )
  );

  if (!allowed.length) {
    window.MSUI.notify(
      'Nenhum arquivo suportado (.html, .mp4, .webm, .jpg, .png, .mp3, .wav…).'
    );

    return [];
  }

  allowed.sort((a, b) => {
    const numberA = Number(
      a.name.match(/\d+/)?.[0] ??
      Number.MAX_SAFE_INTEGER
    );

    const numberB = Number(
      b.name.match(/\d+/)?.[0] ??
      Number.MAX_SAFE_INTEGER
    );

    return numberA !== numberB
      ? numberA - numberB
      : a.name.localeCompare(
          b.name,
          'pt-BR',
          { numeric: true }
        );
  });

  const status = $('mbStatus');

  if (status) {
    status.textContent =
      `Importando ${allowed.length} arquivo(s)…`;
  }

  // Importar vários ou grandes: cartão de progresso (a mídia sobe para a pasta do projeto)
  const importTask = (allowed.length > 2 || allowed.some(f => f.size > 30e6))
    ? window.MSUI.task({ title: `Importando ${allowed.length} arquivo(s)`, detail: 'Lendo os arquivos…', progress: 0.05 })
    : null;

  const results = await Promise.all(
    allowed.map(async file => {
      const extension =
        file.name
          .split('.')
          .pop()
          .toLowerCase();

      try {
        if (/^html?$/.test(extension)) {
          return {
            name: file.name,
            type: 'html',
            html: await readTextFile(file),
          };
        }

        const objectUrl =
          URL.createObjectURL(file);

        if (AUDIO_EXT_RE.test(extension)) {
          return {
            name: file.name,
            type: 'audio',
            dataUrl: objectUrl,
            objectUrl,
            isObjectUrl: true,
            mimeType:
              file.type || 'audio/mpeg',
            fileSize: file.size,
            duration:
              await probeAudioDuration(
                objectUrl
              ),
          };
        }

        if (
          /^(mp4|webm|mov|mkv|avi|ogv)$/.test(
            extension
          )
        ) {
          const metadata =
            await probeVideoFile(
              file,
              objectUrl
            );

          if (metadata.audioOnly) {
            return {
              name: file.name,
              type: 'audio',
              dataUrl: objectUrl,
              objectUrl,
              isObjectUrl: true,
              mimeType:
                file.type || 'audio/webm',
              fileSize: file.size,
              duration: metadata.duration,
            };
          }

          return {
            name: file.name,
            type: 'video',
            dataUrl: objectUrl,
            objectUrl,
            isObjectUrl: true,
            mimeType:
              file.type || 'video/mp4',
            fileSize: file.size,
            ...metadata,
          };
        }

        const metadata =
          await probeImageFile(
            file,
            objectUrl
          );

        return {
          name: file.name,
          type: 'image',
          dataUrl: objectUrl,
          objectUrl,
          isObjectUrl: true,
          mimeType:
            file.type || 'image/png',
          fileSize: file.size,
          ...metadata,
        };
      } catch (error) {
        console.error(
          `[Motion Studio] Erro ao importar ${file.name}:`,
          error
        );

        return null;
      }
    })
  );

  results.forEach((result, index) => {
    if (result) result.file = allowed[index];
  });

  const validResults =
    results.filter(Boolean);

  if (!validResults.length) {
    if (status) {
      status.textContent =
        'Falha na importação';
    }

    window.MSUI.notify(
      'Não foi possível importar os arquivos selecionados.'
    );
    importTask?.fail('Nenhum arquivo pôde ser importado');

    return [];
  }

  importTask?.update({ progress: 0.25, detail: 'Salvando no projeto…' });
  let saved = 0;

  // Padrão (estilo CapCut): só a biblioteca. Soltar na timeline passa
  // toTimeline/at/trackIndex para colocar no lugar certo.
  try {
    const loaded = await loadScenes(validResults, {
      toTimeline: false,
      ...options,
      onTemplate: async (template, input) => {
        const out = await window.MSProjects?.persistMedia(template, input.file);
        importTask?.update({ progress: 0.25 + 0.75 * (++saved / validResults.length), detail: input.file?.name || template.name });
        return out;
      },
    });
    importTask?.done(`${validResults.length} arquivo(s) na biblioteca`);
    return loaded;
  } catch (err) {
    importTask?.fail(err.message || 'Falha na importação');
    throw err;
  }
}

function getMotionStudioState() {
  if (window.__appState) {
    return window.__appState;
  }

  if (typeof state !== 'undefined') {
    return state;
  }

  return null;
}

function getPasteHtmlEditorState() {
  if (
    !window.__motionStudioPasteState ||
    typeof window.__motionStudioPasteState !== 'object'
  ) {
    window.__motionStudioPasteState = {
      mode: 'create',
      clipId: null,
    };
  }

  return window.__motionStudioPasteState;
}

function getEditableHtmlClip(clipId) {
  const appState = getMotionStudioState();

  if (!appState || !clipId) {
    return null;
  }

  const clip = appState.clips.find(
    item => item.id === clipId
  );

  if (!clip) {
    return null;
  }

  const template = appState.templates.find(
    item => item.id === clip.templateId
  );

  if (
    !template ||
    template.type !== 'html' ||
    clip.isText
  ) {
    return null;
  }

  return {
    clip,
    template,
  };
}

function isPasteHtmlModalOpen() {
  const modal = document.getElementById(
    'pasteModal'
  );

  if (!modal) {
    return false;
  }

  return (
    modal.style.display !== 'none' &&
    getComputedStyle(modal).display !== 'none'
  );
}

function setPasteModalTitle(title) {
  const modal = document.getElementById(
    'pasteModal'
  );

  const titleElement = modal?.querySelector(
    '.modal-header > span'
  );

  if (titleElement) {
    titleElement.textContent = title;
  }
}

function setPasteModalMode(
  mode,
  clipId = null
) {
  const modal = document.getElementById(
    'pasteModal'
  );

  const editorState =
    getPasteHtmlEditorState();

  editorState.mode =
    mode === 'edit'
      ? 'edit'
      : 'create';

  editorState.clipId =
    editorState.mode === 'edit'
      ? clipId
      : null;

  if (modal) {
    modal.dataset.mode =
      editorState.mode;

    if (editorState.clipId) {
      modal.dataset.clipId =
        editorState.clipId;
    } else {
      delete modal.dataset.clipId;
    }
  }
}

function openPasteHtmlModal(
  options = {}
) {
  const appState =
    getMotionStudioState();

  const modal =
    document.getElementById(
      'pasteModal'
    );

  const area =
    document.getElementById(
      'pasteArea'
    );

  const nameInput =
    document.getElementById(
      'pasteSceneName'
    );

  if (
    !appState ||
    !modal ||
    !area ||
    !nameInput
  ) {
    return false;
  }

  const normalizedOptions =
    typeof options === 'string'
      ? {
          clipId: options,
        }
      : options || {};

  const clipId =
    normalizedOptions.clipId ||
    null;

  if (clipId) {
    const editable =
      getEditableHtmlClip(
        clipId
      );

    if (!editable) {
      window.MSUI.notify(
        'Este clipe não possui um HTML editável.'
      );

      return false;
    }

    const currentName =
      String(
        editable.clip.label ||
        editable.template.name ||
        'Clip HTML'
      );

    const currentHtml =
      String(
        editable.template.html ??
        editable.template.sourceHtml ??
        editable.template.source ??
        editable.clip.html ??
        ''
      );

    setPasteModalMode(
      'edit',
      clipId
    );

    setPasteModalTitle(
      'Editar Clip HTML'
    );

    /*
     * Preenche imediatamente, antes de mostrar
     * o modal.
     */
    nameInput.value =
      currentName;

    area.value =
      currentHtml;

    modal.style.display =
      'flex';

    /*
     * Reaplica após o layout. Isso evita que
     * algum código legado sobrescreva os campos
     * no mesmo clique.
     */
    requestAnimationFrame(() => {
      const editorState =
        getPasteHtmlEditorState();

      if (
        editorState.mode !== 'edit' ||
        editorState.clipId !== clipId
      ) {
        return;
      }

      nameInput.value =
        currentName;

      area.value =
        currentHtml;

      area.scrollTop = 0;

      nameInput.focus();
      nameInput.select();
    });

    return true;
  }

  setPasteModalMode(
    'create'
  );

  setPasteModalTitle(
    'Adicionar Clip via HTML'
  );

  const initialName =
    String(
      normalizedOptions.initialName ||
      `Cena ${appState.clips.length + 1}`
    );

  const initialHtml =
    String(
      normalizedOptions.initialHtml ||
      ''
    );

  nameInput.value =
    initialName;

  area.value =
    initialHtml;

  modal.style.display =
    'flex';

  requestAnimationFrame(() => {
    if (initialHtml) {
      area.focus();
      area.setSelectionRange(
        area.value.length,
        area.value.length
      );
    } else {
      area.focus();
    }
  });

  return true;
}

function closePasteHtmlModal() {
  const modal =
    document.getElementById(
      'pasteModal'
    );

  const area =
    document.getElementById(
      'pasteArea'
    );

  const nameInput =
    document.getElementById(
      'pasteSceneName'
    );

  if (modal) {
    modal.style.display =
      'none';

    modal.dataset.mode =
      'create';

    delete modal.dataset.clipId;
  }

  if (area) {
    area.value = '';
  }

  if (nameInput) {
    nameInput.value = '';
  }

  setPasteModalMode(
    'create'
  );

  setPasteModalTitle(
    'Adicionar Clip via HTML'
  );
}

function openHtmlClipEditor(
  clipId
) {
  const appState =
    getMotionStudioState();

  const editable =
    getEditableHtmlClip(
      clipId
    );

  if (
    !appState ||
    !editable
  ) {
    window.MSUI.notify(
      'Este clipe não possui um HTML editável.'
    );

    return false;
  }

  appState.currentClipId =
    clipId;

  window.__selectClip?.(
    clipId
  );

  return openPasteHtmlModal({
    clipId,
  });
}

window.openHtmlClipEditor =
  openHtmlClipEditor;

function isHtmlSource(value) {
  const source =
    String(value || '').trim();

  if (!source) {
    return false;
  }

  return /<(?:!doctype\s+html|html|head|body|style|script|div|section|main|article|svg|canvas)\b/i.test(
    source
  );
}

function pushHtmlEditUndo() {
  if (
    typeof tlPushUndo ===
    'function'
  ) {
    tlPushUndo();
    return;
  }

  window.tlPushUndo?.();
}

function updateHtmlClipFromModal(
  clipId,
  name,
  html
) {
  const appState =
    getMotionStudioState();

  const editable =
    getEditableHtmlClip(
      clipId
    );

  if (
    !appState ||
    !editable
  ) {
    throw new Error(
      'Clip HTML não encontrado.'
    );
  }

  const {
    clip,
    template,
  } = editable;

  const cleanName =
    String(name || '')
      .replace(
        /[\\/:*?"<>|]+/g,
        '-'
      )
      .trim() ||
    clip.label ||
    template.name ||
    'Clip HTML';

  const cleanHtml =
    String(html || '').trim();

  if (
    !isHtmlSource(
      cleanHtml
    )
  ) {
    throw new Error(
      'O código informado não é um HTML válido.'
    );
  }

  pushHtmlEditUndo();

  const previousSourceDuration =
    Math.max(
      MIN_CLIP_DURATION,
      Number(
        template.sourceDuration
      ) ||
      Number(clip.duration) ||
      DEFAULT_SCENE_DURATION
    );

  const previousTrimStart =
    Math.max(
      0,
      Number(clip.trimStart) ||
      0
    );

  const previousTrimEnd =
    Math.max(
      previousTrimStart,
      Number(clip.trimEnd) ||
      previousSourceDuration
    );

  const usedWholeSource =
    previousTrimStart <= 0.001 &&
    Math.abs(
      previousTrimEnd -
      previousSourceDuration
    ) <= 0.01;

  const newSourceDuration =
    Math.max(
      MIN_CLIP_DURATION,
      Number(
        extractDuration(
          cleanHtml
        )
      ) ||
      DEFAULT_SCENE_DURATION
    );

  template.name =
    cleanName;

  template.html =
    cleanHtml;

  template.sourceDuration =
    newSourceDuration;

  template.fps =
    Number(
      extractFps(
        cleanHtml
      )
    ) ||
    template.fps ||
    appState.project?.fps ||
    DEFAULT_FPS;

  clip.label =
    cleanName;

  if (
    clip.fitAnimationToClip
  ) {
    /*
     * Mantém a duração visual atual e remapeia
     * toda a nova animação para dentro do clipe.
     */
    clip.trimStart = 0;
    clip.trimEnd =
      newSourceDuration;

    normalizeClip(
      clip,
      Infinity
    );
  } else if (
    usedWholeSource
  ) {
    /*
     * O clipe utilizava toda a fonte anterior.
     * Passa a utilizar toda a nova fonte.
     */
    clip.trimStart = 0;
    clip.duration =
      newSourceDuration;

    clip.trimEnd =
      newSourceDuration;

    normalizeClip(
      clip,
      newSourceDuration
    );
  } else {
    /*
     * Preserva o trim existente dentro dos
     * limites do novo HTML.
     */
    clip.trimStart =
      clamp(
        previousTrimStart,
        0,
        Math.max(
          0,
          newSourceDuration -
          MIN_CLIP_DURATION
        )
      );

    const availableDuration =
      Math.max(
        MIN_CLIP_DURATION,
        newSourceDuration -
        clip.trimStart
      );

    clip.duration =
      clamp(
        Number(
          clip.duration
        ) ||
        MIN_CLIP_DURATION,
        MIN_CLIP_DURATION,
        availableDuration
      );

    clip.trimEnd =
      clip.trimStart +
      clip.duration;

    normalizeClip(
      clip,
      availableDuration
    );
  }

  appState.currentClipId =
    clip.id;

  if (appState.project) {
    appState.project.updatedAt =
      new Date().toISOString();
  }

  recalcProjectDuration();
  syncProjectGlobals();

  if (
    typeof renderMediaPanel ===
    'function'
  ) {
    renderMediaPanel();
  }

  if (
    typeof renderSceneList ===
    'function'
  ) {
    renderSceneList();
  }

  if (
    typeof renderTimeline ===
    'function'
  ) {
    renderTimeline();
  }

  if (
    typeof renderProjectSettings ===
    'function'
  ) {
    renderProjectSettings();
  }

  /*
   * Remove o iframe antigo e monta novamente
   * usando template.html atualizado.
   */
  window.remountClip?.(
    clip.id
  );

  requestAnimationFrame(() => {
    window.__syncCompositorToTime?.(
      appState.time
    );

    window.__syncPreviewSize?.();
  });

  const status =
    document.getElementById(
      'mbStatus'
    );

  if (status) {
    status.textContent =
      `Clip atualizado: ${cleanName}`;
  }

  return true;
}

async function confirmPasteHtml() {
  const appState =
    getMotionStudioState();

  const area =
    document.getElementById(
      'pasteArea'
    );

  const nameInput =
    document.getElementById(
      'pasteSceneName'
    );

  const editorState =
    getPasteHtmlEditorState();

  if (
    !appState ||
    !area ||
    !nameInput
  ) {
    return false;
  }

  const html =
    String(
      area.value || ''
    ).trim();

  if (
    !isHtmlSource(
      html
    )
  ) {
    window.MSUI.notify(
      'Informe um código HTML válido.'
    );

    area.focus();

    return false;
  }

  const fallbackName =
    editorState.mode === 'edit'
      ? 'Clip HTML'
      : `Cena ${appState.clips.length + 1}`;

  const cleanName =
    String(
      nameInput.value ||
      fallbackName
    )
      .replace(
        /[\\/:*?"<>|]+/g,
        '-'
      )
      .trim() ||
    fallbackName;

  try {
    if (
      editorState.mode === 'edit' &&
      editorState.clipId
    ) {
      updateHtmlClipFromModal(
        editorState.clipId,
        cleanName,
        html
      );
    } else {
      const addedClipIds =
        await loadScenes([
          {
            type: 'html',
            name:
              `${cleanName}.html`,
            html,
          },
        ]);

      if (
        !addedClipIds?.length
      ) {
        return false;
      }
    }

    closePasteHtmlModal();

    return true;
  } catch (error) {
    console.error(
      '[Motion Studio] Falha ao salvar HTML:',
      error
    );

    window.MSUI.notify(
      `Não foi possível salvar o HTML: ${
        error.message ||
        error
      }`
    );

    return false;
  }
}

function isEditablePasteTarget(
  target
) {
  return Boolean(
    target instanceof
      HTMLInputElement ||
    target instanceof
      HTMLTextAreaElement ||
    target instanceof
      HTMLSelectElement ||
    target?.isContentEditable
  );
}

function getClipboardHtmlSource(
  clipboardData
) {
  if (!clipboardData) {
    return '';
  }

  const plainText =
    clipboardData.getData(
      'text/plain'
    ) || '';

  if (
    isHtmlSource(
      plainText
    )
  ) {
    return plainText;
  }

  const richHtml =
    clipboardData.getData(
      'text/html'
    ) || '';

  if (
    isHtmlSource(
      richHtml
    )
  ) {
    return richHtml;
  }

  return '';
}

function handlePasteAreaPaste(
  event
) {
  /*
   * Mantém o comportamento padrão do navegador:
   * Ctrl+V apenas cola no textarea.
   *
   * Impede que o evento alcance o listener global.
   */
  event.stopPropagation();
}

function handleGlobalHtmlPaste(
  event
) {
  /*
   * Nunca intercepta Ctrl+V dentro de inputs,
   * textareas ou campos editáveis.
   */
  if (
    isEditablePasteTarget(
      event.target
    )
  ) {
    return;
  }

  /*
   * Se o modal já estiver aberto, não cria clipe
   * nem altera o modo atual.
   */
  if (
    isPasteHtmlModalOpen()
  ) {
    return;
  }

  const source =
    getClipboardHtmlSource(
      event.clipboardData
    );

  if (
    !source
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  /*
   * Ctrl+V fora dos campos agora somente abre o
   * modal preenchido. O clipe só será criado após
   * clicar em "Adicionar à Timeline".
   */
  openPasteHtmlModal({
    initialHtml: source,
  });
}

function replaceElementWithoutListeners(
  id
) {
  const current =
    document.getElementById(
      id
    );

  if (!current) {
    return null;
  }

  const replacement =
    current.cloneNode(true);

  current.replaceWith(
    replacement
  );

  return replacement;
}

function removeLegacyPasteListeners() {
  /*
   * Os listeners antigos são anônimos e não podem
   * ser removidos com removeEventListener.
   *
   * Recriar os elementos elimina todos os listeners
   * antigos registrados diretamente neles.
   */
  const ids = [
    'mbPasteHtml',
    'btnQuickPaste',
    'btnEmptyPaste',
    'btnPasteHtml',
    'btnAddScene',
    'btnClosePaste',
    'btnCancelPaste',
    'btnConfirmPaste',
  ];

  const elements = {};

  ids.forEach(id => {
    elements[id] =
      replaceElementWithoutListeners(
        id
      );
  });

  return elements;
}

function initPasteHtmlFlow() {
  window
    .__motionStudioPasteController
    ?.abort();

  const elements =
    removeLegacyPasteListeners();

  const controller =
    new AbortController();

  window.__motionStudioPasteController =
    controller;

  const options = {
    signal:
      controller.signal,
  };

  const openCreateModal =
    event => {
      event?.preventDefault?.();
      event?.stopPropagation?.();

      openPasteHtmlModal();
    };

  [
    'mbPasteHtml',
    'btnQuickPaste',
    'btnEmptyPaste',
    'btnPasteHtml',
    'btnAddScene',
  ].forEach(id => {
    const element =
      elements[id] ||
      document.getElementById(id);

    element?.addEventListener(
      'click',
      openCreateModal,
      options
    );
  });

  const closeButton =
    elements.btnClosePaste ||
    document.getElementById(
      'btnClosePaste'
    );

  const cancelButton =
    elements.btnCancelPaste ||
    document.getElementById(
      'btnCancelPaste'
    );

  const confirmButton =
    elements.btnConfirmPaste ||
    document.getElementById(
      'btnConfirmPaste'
    );

  closeButton?.addEventListener(
    'click',
    event => {
      event.preventDefault();
      event.stopPropagation();

      closePasteHtmlModal();
    },
    options
  );

  cancelButton?.addEventListener(
    'click',
    event => {
      event.preventDefault();
      event.stopPropagation();

      closePasteHtmlModal();
    },
    options
  );

  confirmButton?.addEventListener(
    'click',
    event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      confirmPasteHtml();
    },
    options
  );

  document
    .getElementById(
      'pasteArea'
    )
    ?.addEventListener(
      'paste',
      handlePasteAreaPaste,
      options
    );

  document.addEventListener(
    'paste',
    handleGlobalHtmlPaste,
    options
  );

  document.addEventListener(
    'keydown',
    event => {
      if (
        event.key === 'Escape' &&
        isPasteHtmlModalOpen()
      ) {
        event.preventDefault();
        closePasteHtmlModal();
      }
    },
    options
  );
}

(function bootMotionStudioProjectSystem() {
  const start = () =>
    initMotionStudioProjectSystem();

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      start,
      { once: true }
    );
  } else {
    start();
  }
})();
// #endregion

// #region Carregamento de Projeto / Templates
const DEFAULT_IMAGE_DURATION = 5;   // segundos estáticos por padrão para imagens

/** Duração de uma imagem nova na timeline (Configurações → Editor) */
function projectImageDuration() {
  return Number(state.project?.settings?.imageDuration) || DEFAULT_IMAGE_DURATION;
}
const DEFAULT_VIDEO_DURATION = 10;  // fallback caso não consigamos ler metadados

/**
 * Retorna uma Promise<number> com a duração real de um vídeo via
 * elemento <video> em memória. Resolve em DEFAULT_VIDEO_DURATION se falhar.
 */
function probeVideoDuration(dataUrl) {
  return new Promise(resolve => {
    const v = document.createElement('video');
    v.preload  = 'metadata';
    v.muted    = true;
    v.onloadedmetadata = () => {
      resolve(isFinite(v.duration) && v.duration > 0 ? v.duration : DEFAULT_VIDEO_DURATION);
    };
    v.onerror = () => resolve(DEFAULT_VIDEO_DURATION);
    v.src = dataUrl;
  });
}

const AUDIO_EXT_RE = /^(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;

/** Duração de um arquivo de áudio (s); DEFAULT_VIDEO_DURATION se falhar */
function probeAudioDuration(dataUrl) {
  return new Promise(resolve => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      resolve(isFinite(a.duration) && a.duration > 0 ? a.duration : DEFAULT_VIDEO_DURATION);
    };
    a.onerror = () => resolve(DEFAULT_VIDEO_DURATION);
    a.src = dataUrl;
  });
}

function _calcFitTx(srcW, srcH, res) {
  const scaleW = res.w / srcW;
  const scaleH = res.h / srcH;
  const scale  = Math.min(scaleW, scaleH); // fit, não crop
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const x = Math.round((res.w - w) / 2);
  const y = Math.round((res.h - h) / 2);
  return { x, y, w, h, r: 0 };
}

function syncProjectGlobals() {
  window.__projectClips = state.clips;
  window.__projectTemplates = state.templates;
  window.__projectRes = state.project?.res;

  window.__projectScenes = state.clips.map(clip => {
    const tmpl = state.templates.find(
      template => template.id === clip.templateId
    );

    const sourceDuration = Math.max(
      MIN_CLIP_DURATION,
      Number(tmpl?.sourceDuration) || clip.duration
    );

    const sourceIn = Math.max(
      0,
      Number(clip.trimStart) || 0
    );

    const sourceOut = clip.fitAnimationToClip
      ? clamp(
          Number(clip.trimEnd) || sourceDuration,
          sourceIn,
          sourceDuration
        )
      : Math.min(
          sourceDuration,
          sourceIn + clip.duration
        );

    const sourceSpan = Math.max(
      0,
      sourceOut - sourceIn
    );

    const base = {
      id: clip.id,
      label: clip.label,
      start: clip.start,
      duration: clip.duration,

      trimStart: sourceIn,
      trimEnd: sourceOut,
      sourceDuration,

      fitAnimationToClip: Boolean(
        clip.fitAnimationToClip &&
        tmpl?.type === 'html' &&
        !clip.isText
      ),

      sourceTimeScale:
        clip.duration > 0
          ? sourceSpan / clip.duration
          : 1,

      fps:
        tmpl?.fps ||
        state.project?.fps ||
        DEFAULT_FPS,

      color: clip.color,
      tx: clip._tx || null,
      type: tmpl?.type || 'html',
    };

    if (tmpl?.type === 'html') {
      base.html = tmpl.html;
    } else if (
      tmpl?.type === 'video' ||
      tmpl?.type === 'image' ||
      tmpl?.type === 'audio'
    ) {
      base.dataUrl = tmpl.dataUrl;
      base.mimeType = tmpl.mimeType;
    }

    return base;
  });

  if (state.project) {
    if (previewSize) {
      previewSize.textContent =
        `${state.project.res.w} × ${state.project.res.h}`;
    }

    if (previewFpsEl) {
      previewFpsEl.textContent =
        `${state.project.fps} fps`;
    }
  }
}
// #endregion

// #region Configurações do Projeto (painel direito)
function renderProjectSettings() {
  if (!state.project) return;

  const clip = selectedClip();
  const res = state.project.res;
  const fps = state.project.fps;

  const tmpl = clip
    ? state.templates.find(
        template => template.id === clip.templateId
      )
    : null;

  const isStretchableHtml = Boolean(
    clip &&
    tmpl?.type === 'html' &&
    !clip.isText
  );

  const sourceDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(tmpl?.sourceDuration) ||
      Number(clip?.duration) ||
      MIN_CLIP_DURATION
  );

  const sourceIn = Math.max(
    0,
    Number(clip?.trimStart) || 0
  );

  const sourceOut = clip?.fitAnimationToClip
    ? clamp(
        Number(clip?.trimEnd) || sourceDuration,
        sourceIn,
        sourceDuration
      )
    : Math.min(
        sourceDuration,
        sourceIn +
          (Number(clip?.duration) || 0)
      );

  const sourceSpan = Math.max(
    MIN_CLIP_DURATION,
    sourceOut - sourceIn
  );

  const animationSpeed =
    clip?.duration > 0
      ? sourceSpan / clip.duration
      : 1;

  if (propsContent) {
    if (window.__groupPropsActive?.()) {
      // Vários clips selecionados: painel de edição em grupo (group-edit.js)
      window.__renderGroupProps(propsContent);
    } else if (clip?.isText) {
      window.renderTextClipProps(clip);
      propsContent.insertAdjacentHTML('beforeend',
        (window.__renderTransformProps?.(clip, tmpl) || '') + (window.__renderFxProps?.(clip, tmpl) || '') + (window.__renderAnimProps?.(clip, tmpl) || ''));

      const previewName = $('previewClipName');

      if (previewName) {
        previewName.textContent = clip.label;
      }
    } else {
      propsContent.innerHTML = clip
        ? `
          <div class="prop-section">
            <div class="prop-title">Clip</div>

            <div class="prop-row">
              <label>Nome</label>

              <input
                class="prop-input"
                value="${escapeHtml(clip.label)}"
                onchange="window.renameClip(
                  '${clip.id}',
                  this.value
                )"
              >
            </div>

            <div class="prop-row">
              <label>Início</label>

              <span class="prop-val">
                ${fmtTime(clip.start)}
              </span>
            </div>

            <div class="prop-row">
              <label>Duração</label>

              <input
                class="prop-input"
                type="number"
                step="0.1"
                min="${MIN_CLIP_DURATION}"
                max="3600"
                value="${clip.duration.toFixed(2)}"
                onchange="window.resizeClip(
                  '${clip.id}',
                  this.value
                )"
              >
            </div>

            <div class="prop-row">
              <label>Fim</label>

              <span class="prop-val">
                ${fmtTime(
                  clip.start + clip.duration
                )}
              </span>
            </div>

            <div class="prop-row">
              <label>Frames</label>

              <span class="prop-val">
                ${Math.round(
                  clip.duration *
                  (tmpl?.fps || fps)
                )}
              </span>
            </div>

            <div class="prop-row">
              <label>Trim in</label>

              <span class="prop-val">
                ${fmtTime(sourceIn)}
              </span>
            </div>

            <div class="prop-row">
              <label>Trim out</label>

              <span class="prop-val">
                ${fmtTime(sourceOut)}
              </span>
            </div>

            <div class="prop-row">
              <label>Track</label>

              <input
                class="prop-input"
                type="number"
                min="0"
                max="99"
                value="${clip.trackIndex}"
                onchange="window.moveClipToTrack(
                  '${clip.id}',
                  parseInt(this.value)
                )"
              >
            </div>

            <div class="prop-row">
              <label>Cor</label>

              <input
                type="color"
                class="prop-color"
                value="${clip.color}"
                onchange="window.recolorClip(
                  '${clip.id}',
                  this.value
                )"
              >
            </div>
          </div>

          ${
            isStretchableHtml
              ? `
                <div class="prop-section">
                  <div class="prop-title">
                    Tempo da animação
                  </div>

                  <div class="prop-row">
                    <label
                      title="Com esta opção ativa, a animação completa será comprimida ou estendida para caber no clipe."
                    >
                      Ajustar ao clip
                    </label>

                    <input
                      type="checkbox"
                      ${
                        clip.fitAnimationToClip
                          ? 'checked'
                          : ''
                      }
                      onchange="window.setClipAnimationFit(
                        '${clip.id}',
                        this.checked
                      )"
                    >
                  </div>

                  <div class="prop-row">
                    <label>Velocidade</label>

                    <span class="prop-val">
                      ${
                        clip.fitAnimationToClip
                          ? `${animationSpeed.toFixed(2)}×`
                          : '1.00×'
                      }
                    </span>
                  </div>

                  <div
                    style="
                      padding:6px 2px 0;
                      font-size:9px;
                      line-height:1.45;
                      color:var(--text-dim);
                    "
                  >
                    ${
                      clip.fitAnimationToClip
                        ? `A entrada e a saída serão preservadas.
                           A animação completa será remapeada
                           para a duração do clip.`
                        : `Desativado: reduzir o clip corta
                           o trecho excedente da animação.`
                    }
                  </div>
                </div>
              `
              : ''
          }

          ${window.__renderCameraProps?.(clip, tmpl) || ''}

          ${window.__renderLayerProps?.(clip, tmpl) || ''}

          ${window.__renderTransformProps?.(clip, tmpl) || ''}

          ${window.__renderFxProps?.(clip, tmpl) || ''}

          ${window.__renderAnimProps?.(clip, tmpl) || ''}

          ${window.__renderAudioProps?.(clip, tmpl) || ''}

          <div class="prop-section">
            <div class="prop-title">
              Template fonte
            </div>

            <div class="prop-row">
              <label>Nome</label>

              <span
                class="prop-val"
                style="
                  font-size:10px;
                  text-align:right;
                  max-width:130px;
                  overflow:hidden;
                  text-overflow:ellipsis;
                  white-space:nowrap;
                "
              >
                ${tmpl?.name || '—'}
              </span>
            </div>

            <div class="prop-row">
              <label>Dur. original</label>

              <span class="prop-val">
                ${fmtTime(sourceDuration)}
              </span>
            </div>

            <div class="prop-row">
              <label>FPS</label>

              <span class="prop-val">
                ${tmpl?.fps || fps}
              </span>
            </div>
          </div>

          <div class="prop-section">
            <div class="prop-row prop-row-btn">
              <button
                class="btn-danger"
                onclick="window.deleteClip(
                  '${clip.id}'
                )"
              >
                🗑 Remover clip
              </button>
            </div>
          </div>
        `
        : window.__renderTrackPanel?.(state.selectedTrack) || `
          <div class="props-empty">
            Selecione um clip ou uma track na timeline
          </div>
        `;
    }
  }

  const clipNameEl = $('previewClipName');

  if (clipNameEl) {
    clipNameEl.textContent =
      clip ? clip.label : '—';
  }

  if (projectContent) {
    const guides = window.MSProjectSettings?.settings().guides || {};

    projectContent.innerHTML = `
      <div class="prop-section">
        <div class="prop-title">${escapeHtml(state.project.name || 'Projeto')}</div>

        <div class="prop-row">
          <label>Resolução</label>
          <span class="prop-val">${res.w} × ${res.h}</span>
        </div>

        <div class="prop-row">
          <label>FPS</label>
          <span class="prop-val">${fps}</span>
        </div>

        <div class="prop-row">
          <label>Fundo</label>
          <span class="prop-val"><span class="prop-swatch" style="background:${escapeHtml(state.project.background || '#000')}"></span>${escapeHtml(state.project.background || '#000000')}</span>
        </div>

        <div class="prop-row">
          <label>Duração</label>
          <span class="prop-val">${fmtTime(state.project.totalDuration)}</span>
        </div>

        <div class="prop-row">
          <label>Clips</label>
          <span class="prop-val">${state.clips.length}</span>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-title">Editor</div>

        <div class="prop-row">
          <label>Snap</label>
          <input type="checkbox" data-project-toggle="snap" ${state.snapEnabled ? 'checked' : ''}>
        </div>

        <div class="prop-row">
          <label>Área segura</label>
          <input type="checkbox" data-project-toggle="safeArea" ${guides.safeArea ? 'checked' : ''}>
        </div>

        <div class="prop-row">
          <label>Grade de terços</label>
          <input type="checkbox" data-project-toggle="thirds" ${guides.thirds ? 'checked' : ''}>
        </div>
      </div>

      <div class="prop-section">
        <div class="prop-row prop-row-btn">
          <button class="btn-secondary" data-action="project-settings" style="font-size:11px;width:100%">
            ⚙ Configurações do projeto…
          </button>
        </div>
      </div>
    `;
  }
}
window.setClipAnimationFit =
function setClipAnimationFit(clipId, enabled) {
  const clip = state.clips.find(
    item => item.id === clipId
  );

  if (!clip) return;

  const tmpl = state.templates.find(
    template => template.id === clip.templateId
  );

  if (
    !tmpl ||
    tmpl.type !== 'html' ||
    clip.isText
  ) {
    return;
  }

  tlPushUndo();

  const sourceDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(tmpl.sourceDuration) || clip.duration
  );

  clip.fitAnimationToClip = Boolean(enabled);
  clip.trimStart = 0;

  if (clip.fitAnimationToClip) {
    /*
     * O clipe passa a representar a animação completa.
     * A duração do clipe poderá ser menor ou maior que
     * a duração original.
     */
    clip.trimEnd = sourceDuration;

    normalizeClip(
      clip,
      Infinity
    );
  } else {
    /*
     * Ao desligar, voltamos ao comportamento de corte.
     * Não permitimos uma duração maior que a fonte.
     */
    clip.duration = Math.min(
      clip.duration,
      sourceDuration
    );

    clip.trimEnd = clip.duration;

    normalizeClip(
      clip,
      sourceDuration
    );
  }

  const entry =
    window.__Compositor?.get(clip.id);

  if (entry) {
    entry._lastSeekSent = undefined;
  }

  recalcProjectDuration();
  syncProjectGlobals();
  renderSceneList();
  renderTimeline();
  renderProjectSettings();

  if (
    state.time >
    state.project.totalDuration
  ) {
    window.seekTo?.(
      state.project.totalDuration
    );
  } else {
    window.__syncCompositorToTime?.(
      state.time
    );
  }
};

document.querySelectorAll('.ptab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab   = btn.dataset.tab;
    const panel = btn.closest('aside') || document;

    panel.querySelectorAll('.ptab')
      .forEach(b => b.classList.toggle('active', b === btn));

    // tenta as duas convenções: 'tab' + tab  e  'tab' + Capitalizado
    const idLower = 'tab' + tab;                                   // tabtext, tabmedia…
    const idCamel = 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1); // tabProps, tabProject…
    panel.querySelectorAll('.panel-tab-content').forEach(c => {
      c.classList.toggle('active', c.id === idLower || c.id === idCamel);
    });

    if (tab === 'project') renderProjectSettings();
  });
});
// #endregion

projectContent?.addEventListener('change', e => {
  const toggle = e.target.closest('[data-project-toggle]');
  if (!toggle || !state.project) return;
  const key = toggle.dataset.projectToggle;
  if (key === 'snap') {
    state.snapEnabled = toggle.checked;
    const button = $('btnTlSnap');
    if (button) button.dataset.active = String(toggle.checked);
    return;
  }
  const settings = window.MSProjectSettings?.settings();
  if (!settings) return;
  settings.guides = { ...settings.guides, [key]: toggle.checked };
  window.MSProjectSettings.renderGuides();
});

// #region Biblioteca (painel esquerdo)
/** A biblioteca de assets vive em library.js; aqui fica o ponto de entrada antigo */
function renderMediaPanel() {
  window.MSLibrary?.render();
}
// #endregion

// #region Resize de Panels e Zoom Contextual

const PANEL_SIZE_STORAGE_KEY = 'motionStudio.panelSizes';

const PANEL_RESIZE_CONFIG = {
  left: {
    cssVar: '--panel-left-w',
    storageKey: 'panelLeft',
    min: 180,
    max: 420,
    defaultValue: 230,
  },
  right: {
    cssVar: '--panel-right-w',
    storageKey: 'panelRight',
    min: 200,
    max: 460,
    defaultValue: 240,
  },
  timeline: {
    cssVar: '--timeline-h',
    storageKey: 'timeline',
    min: 150,
    max: 620,
    defaultValue: 270,
  },
};

function loadPanelSizes() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_SIZE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePanelSizes(sizes) {
  localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(sizes));
}

function setCssPxVar(name, value) {
  document.documentElement.style.setProperty(name, `${Math.round(value)}px`);
}

function getCssPxVar(name, fallback = 0) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applySavedPanelSizes() {
  const saved = loadPanelSizes();

  Object.values(PANEL_RESIZE_CONFIG).forEach(config => {
    const value = Number(saved[config.storageKey]);
    if (!Number.isFinite(value)) return;
    const clamped = clamp(value, config.min, config.max);
    setCssPxVar(config.cssVar, clamped);
  });

  requestAnimationFrame(() => {
    window.__syncPreviewSize?.();   // ← via window, definido no compositor.js
    window.__renderTimeline?.();    // ← idem
  });
}

function createPanelResizeHandle(target, type) {
  if (!target) return;

  const oldHandle = target.querySelector(`.panel-resize-handle[data-resize="${type}"]`);
  if (oldHandle) oldHandle.remove();

  const handle = document.createElement('div');
  handle.className = 'panel-resize-handle';
  handle.dataset.resize = type;
  target.appendChild(handle);

  return handle;
}

function initPanelResize() {
  const panelLeft = document.getElementById('panelLeft');
  const panelRight = document.getElementById('panelRight');
  const timeline = document.getElementById('timeline');

  const leftHandle = createPanelResizeHandle(panelLeft, 'left-panel');
  const rightHandle = createPanelResizeHandle(panelRight, 'right-panel');
  const timelineHandle = createPanelResizeHandle(timeline, 'timeline');

  leftHandle?.addEventListener('mousedown', e => {
    startPanelResize(e, 'left');
  });

  rightHandle?.addEventListener('mousedown', e => {
    startPanelResize(e, 'right');
  });

  timelineHandle?.addEventListener('mousedown', e => {
    startPanelResize(e, 'timeline');
  });
}

function startPanelResize(e, type) {
  e.preventDefault();
  e.stopPropagation();

  const config = PANEL_RESIZE_CONFIG[type];
  if (!config) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const startValue = getCssPxVar(config.cssVar, config.defaultValue);

  document.body.classList.add('is-resizing-panel');

  if (type === 'timeline') {
    document.body.style.cursor = 'row-resize';
  } else {
    document.body.style.cursor = 'col-resize';
  }

  const onMove = ev => {
    let nextValue = startValue;

    if (type === 'left') {
      nextValue = startValue + (ev.clientX - startX);
    }

    if (type === 'right') {
      nextValue = startValue - (ev.clientX - startX);
    }

    if (type === 'timeline') {
      nextValue = startValue - (ev.clientY - startY);
    }

    nextValue = clamp(nextValue, config.min, config.max);
    setCssPxVar(config.cssVar, nextValue);

    const saved = loadPanelSizes();
    saved[config.storageKey] = Math.round(nextValue);
    savePanelSizes(saved);

    syncPreviewSize?.();

    if (type === 'timeline') {
      scheduleRenderTimeline?.();
    }
  };

  const onUp = () => {
    document.body.classList.remove('is-resizing-panel');
    document.body.style.cursor = '';

    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    syncPreviewSize?.();
    renderTimeline?.();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function zoomPreviewByWheel(e) {
  if (!state.project) return;

  e.preventDefault();
  e.stopPropagation();

  const scroll = document.getElementById('previewScroll');
  if (!scroll) return;

  const beforeW = scroll.scrollWidth;
  const beforeH = scroll.scrollHeight;
  const beforeLeft = scroll.scrollLeft;
  const beforeTop = scroll.scrollTop;

  const rect = scroll.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const ratioX = beforeW > 0 ? (beforeLeft + mouseX) / beforeW : 0.5;
  const ratioY = beforeH > 0 ? (beforeTop + mouseY) / beforeH : 0.5;

  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;

  state.previewZoom = clamp((state.previewZoom ?? 1) * factor, 0.1, 4);
  syncPreviewSize();

  requestAnimationFrame(() => {
    scroll.scrollLeft = (scroll.scrollWidth * ratioX) - mouseX;
    scroll.scrollTop = (scroll.scrollHeight * ratioY) - mouseY;
  });
}

/**
 * Roda sem modificador rola a timeline: Shift ou gesto lateral do trackpad
 * → horizontal; vertical rola as tracks se houver overflow, senão horizontal.
 */
function scrollTimelineByWheel(e) {
  const timelineScroll = document.getElementById('tlScroll');
  if (!timelineScroll || !state.project) return;

  e.preventDefault();

  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? timelineScroll.clientWidth : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  const hasVerticalOverflow = timelineScroll.scrollHeight > timelineScroll.clientHeight + 1;

  if (e.shiftKey) {
    timelineScroll.scrollLeft += dy || dx;
  } else if (Math.abs(dx) > Math.abs(dy)) {
    timelineScroll.scrollLeft += dx;
  } else if (hasVerticalOverflow) {
    timelineScroll.scrollTop += dy;
  } else {
    timelineScroll.scrollLeft += dy;
  }
}

function zoomTimelineByWheel(e) {
  if (!state.project) return;

  e.preventDefault();
  e.stopPropagation();

  const timelineScroll = document.getElementById('tlScroll');
  if (!timelineScroll) return;

  const rect = timelineScroll.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;

  const oldZoom = state.zoom || 1;
  const oldPxPerSec = PX_PER_SEC * oldZoom;

  const timeUnderMouse = (timelineScroll.scrollLeft + mouseX) / oldPxPerSec;

  // Pinça do trackpad manda deltas pequenos e contínuos; roda manda ±100
  const factor = Math.exp(-clamp(e.deltaY, -60, 60) * 0.004);

  state.zoom = clamp(oldZoom * factor, 0.1, 16);

  if (zoomLabel) {
    zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  }
  window.__syncZoomThumb?.();

  renderTimeline();

  requestAnimationFrame(() => {
    const newPxPerSec = PX_PER_SEC * state.zoom;
    timelineScroll.scrollLeft = (timeUnderMouse * newPxPerSec) - mouseX;
    updatePlayhead?.(state.time);
  });
}

function initContextualWheelZoom() {
  const previewScroll = document.getElementById('previewScroll');
  const timeline = document.getElementById('timeline');

  previewScroll?.addEventListener('wheel', zoomPreviewByWheel, {
    passive: false,
  });

  timeline?.addEventListener('wheel', e => {
    const isInsideResizeHandle = e.target.closest('.panel-resize-handle');
    if (isInsideResizeHandle) return;

    // Ctrl/⌘ + roda (ou pinça no trackpad, que chega com ctrlKey) → zoom
    if (e.ctrlKey || e.metaKey) {
      zoomTimelineByWheel(e);
      return;
    }

    scrollTimelineByWheel(e);
  }, {
    passive: false,
  });
}

applySavedPanelSizes();
initPanelResize();
initContextualWheelZoom();

// #endregion

// #region Importação de Mídias (HTML, Vídeo, Imagem)
fileInput.setAttribute('accept', '.html,.htm,.mp4,.webm,.mov,.mkv,.avi,.ogv,.jpg,.jpeg,.png,.gif,.webp,.avif,.svg,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.weba');

fileInput.addEventListener('change', e => {
  handleMediaFiles(e.target.files);
  fileInput.value = '';
});

document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  // Sem projeto aberto (tela inicial) não há onde importar
  if (!state.project) return;
  if (e.dataTransfer.files.length) handleMediaFiles(e.dataTransfer.files);
});

function renderSceneList() {
  renderMediaPanel();
}
// #endregion

// #region Modal: Exportar
$('btnExport')?.addEventListener('click', () => {
  if (!state.project) return;
  const exportDefaults = window.MSProjectSettings?.settings().export;
  if (exportDefaults) {
    if ($('exportFormat')) $('exportFormat').value = exportDefaults.format;
    if ($('exportQuality')) $('exportQuality').value = exportDefaults.quality;
  }
  const sum = $('exportScenesSummary');
  if (sum) {
    sum.innerHTML = `
      <div style="margin-bottom:6px;font-size:11px;color:var(--text-muted)">
        ${state.clips.length} clip(s) · ${fmtTime(state.project.totalDuration)} total
      </div>` +
      state.clips.map((c,i) =>
        `<div style="font-size:10px;color:var(--text-muted);padding:1px 0">
          <span style="color:var(--text)">${i+1}.</span> ${escapeHtml(c.label)}
          <span style="color:var(--text-dim)">— ${fmtTime(c.duration)}</span>
        </div>`
      ).join('');
  }
  $('exportModal').style.display = 'flex';
});
['exportFormat', 'exportQuality'].forEach(id => $(id)?.addEventListener('change', () => {
  const settings = window.MSProjectSettings?.settings();
  if (!settings) return;
  settings.export = { format: $('exportFormat').value, quality: $('exportQuality')?.value || 'high' };
}));
$('btnCloseExport')?.addEventListener('click',  () => $('exportModal').style.display = 'none');
$('btnCancelExport')?.addEventListener('click', () => $('exportModal').style.display = 'none');
$('btnStartExport')?.addEventListener('click', () => {
  if (typeof window.runExport === 'function') window.runExport();
  else { $('progressText').textContent = '❌ export.js não carregado'; $('exportProgress').style.display = 'block'; }
});
// #endregion

// #region Eventos do Teclado
inputTime.addEventListener('change', () => {
  const t = parseTime(inputTime.value);
  if (t !== null && typeof window.seekTo === 'function') window.seekTo(t);
});

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Campo onde Ctrl+Z desfaz o próprio texto. Sliders, selects, checkboxes e
 * botões não: lá o Ctrl+Z é o do editor (antes, mexer num slider de efeito
 * deixava o foco nele e o Ctrl+Z não fazia nada).
 */
function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  if (target.tagName !== 'INPUT') return false;
  return ['text', 'number', 'search', 'email', 'url', 'password', 'tel', ''].includes(target.type);
}

// Os atalhos (espaço, setas, S, Del, Ctrl+N/S/O…) são do registro de comandos: commands.js
// #endregion

// #region Exports para motion.js e export.js
window.__appState         = state;
window.__fmtTime          = fmtTime;
window.__clamp            = clamp;
window.__PX_PER_SEC       = PX_PER_SEC;
window.__renderSceneList  = renderSceneList;
window.__renderProps      = renderProjectSettings;
window.__highlightScene   = (idx) => {
  const clip = state.clips[idx];
  if (clip) highlightClipInList(clip.id);
};

window.__clipAtTime       = clipAtTime;
window.__normalizeClip    = normalizeClip;
window.__recalcProjectDuration = recalcProjectDuration;
window.__syncProjectGlobals    = syncProjectGlobals;
// #endregion
