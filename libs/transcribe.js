
//  Fluxo:
//  1. Usuário clica "Transcrição" no context menu
//  2. Modal abre com a prévia animada de cada template de legenda (sobre um
//     quadro do próprio vídeo) + tamanho/cores + idioma
//  3. Envia o trecho do clip para o servidor Whisper (transcribeClipMedia)
//  4. Recebe segmentos e cria clips de texto na timeline
const WHISPER_URL    = '/api/transcribe';
const WHISPER_STATUS = '/api/whisper/status';
// 1ª execução pode instalar o Python + baixar o modelo (até ~3 GB)
const WHISPER_READY_TIMEOUT = 60 * 60 * 1000;

// #region Prévia dos templates de legenda
const TX_SAMPLE_TEXT = 'Sua legenda animada fica assim';
const TX_SAMPLE_DUR  = 2.4;
const TX_PREFS_KEY   = 'ms.txCaptionPrefs';
const TX_PREVIEW_FPS = 30;   // a prévia não precisa de 60 seeks/s

const _tx = {
  tmplId:    null,
  overrides: {},          // { fontSize, color, highlightColor }
  hover:     null,        // { iframe, clock } — único iframe vivo da grade
  raf:       null,
  stageClock: 0,
  resKey:    '',
};

function _txLoadPrefs() {
  try { return JSON.parse(localStorage.getItem(TX_PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
}

function _txSavePrefs() {
  try { localStorage.setItem(TX_PREFS_KEY, JSON.stringify({ tmplId: _tx.tmplId, overrides: _tx.overrides })); } catch (_) { /* sem storage */ }
}

/** Parâmetros de exemplo, com palavras cronometradas para os templates palavra a palavra */
function _txSampleParams(txTmpl, overrides = {}) {
  const words = TX_SAMPLE_TEXT.split(' ');
  const step  = (TX_SAMPLE_DUR * 0.8) / words.length;
  const timed = words.map((word, i) => ({
    word,
    start: +(0.1 + i * step).toFixed(2),
    end:   +(0.1 + (i + 1) * step - 0.04).toFixed(2),
  }));
  return {
    ...txTmpl.defaults,
    ...overrides,
    text: TX_SAMPLE_TEXT,
    duration: TX_SAMPLE_DUR,
    wordsJson: JSON.stringify(timed),
  };
}

function _txSeek(iframe, t) {
  try { iframe.contentWindow?.Motion?.seek(t); } catch (_) { /* ainda carregando */ }
}

/** Legendas palavra a palavra primeiro (são as feitas para transcrição) */
function _txTemplates() {
  const all = window.__TextRegistry?.getAll() || [];
  const isCaption = t => /legenda/i.test(t.category || '');
  return [...all.filter(isCaption), ...all.filter(t => !isCaption(t))];
}

/** iframe do template escalado para caber em `w`×`h`, centralizado (corta o excesso) */
function _txMakeFrame(res, w, h) {
  const scale  = w / res.w;
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts allow-same-origin';
  iframe.tabIndex = -1;
  iframe.style.cssText =
    `position:absolute;left:0;top:${Math.round((h - res.h * scale) / 2)}px;` +
    `width:${res.w}px;height:${res.h}px;border:0;pointer-events:none;` +
    `transform-origin:top left;transform:scale(${scale});background:transparent`;
  return iframe;
}

/**
 * Miniaturas da grade: pôsteres WebP do servidor em cache (posters.js). Um
 * iframe vivo de 1080×1920 por card (14 templates) travava o editor.
 */
function _txBuildGrid() {
  const grid = document.getElementById('txTmplGrid');
  const res  = window.__appState?.project?.res || { w: 1080, h: 1920 };
  const resKey = `${res.w}x${res.h}`;
  if (_tx.resKey === resKey && grid.children.length) return;
  _tx.resKey = resKey;

  const W = 104, H = 92;
  const scale = W / res.w;
  const posterAt = TX_SAMPLE_DUR * 0.75;
  grid.innerHTML = '';
  _txTemplates().forEach(t => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tx-tmpl-card';
    card.dataset.id = t.id;
    card.title = t.desc || t.name;

    const thumb = document.createElement('div');
    thumb.className = 'tx-tmpl-thumb';
    thumb.style.width  = W + 'px';
    thumb.style.height = H + 'px';

    // Quadro parado no fim da animação (texto inteiro visível), centralizado como o iframe
    const html = window.__TextRegistry.buildHtml(t.id, _txSampleParams(t), res);
    const img = document.createElement('img');
    img.className = 'tx-tmpl-img';
    img.alt = '';
    img.decoding = 'async';
    img.style.cssText = `top:${Math.round((H - res.h * scale) / 2)}px;width:${W}px;height:${Math.round(res.h * scale)}px`;
    const cached = window.MSPosters.cached(html, res, posterAt);
    if (cached) {
      img.src = cached;
    } else {
      thumb.classList.add('is-loading');
      window.MSPosters.get(html, res, posterAt).then(
        url => { img.src = url; thumb.classList.remove('is-loading'); },
        // Sem Chromium no servidor: o card mostra o quadro num iframe, como antes
        () => {
          thumb.classList.remove('is-loading');
          const iframe = _txMakeFrame(res, W, H);
          iframe.addEventListener('load', () => _txSeek(iframe, posterAt));
          iframe.srcdoc = html;
          img.replaceWith(iframe);
        },
      );
    }
    thumb.appendChild(img);

    const name = document.createElement('span');
    name.className = 'tx-tmpl-name';
    name.textContent = t.name;
    if (/legenda/i.test(t.category || '')) {
      const tag = document.createElement('span');
      tag.className = 'tx-tmpl-tag';
      tag.textContent = 'palavra a palavra';
      card.append(thumb, name, tag);
    } else {
      card.append(thumb, name);
    }

    card.addEventListener('click', () => _txSelect(t.id));
    // Animação no hover: um iframe criado na hora, por cima da miniatura, e descartado ao sair
    card.addEventListener('mouseenter', () => {
      _txStopHover();
      const iframe = _txMakeFrame(res, W, H);
      // Fundo transparente: a miniatura some só quando o quadro animado existe
      iframe.addEventListener('load', () => thumb.classList.add('is-live'));
      iframe.srcdoc = html;
      thumb.appendChild(iframe);
      _tx.hover = { iframe, thumb, clock: 0 };
    });
    card.addEventListener('mouseleave', _txStopHover);
    grid.appendChild(card);
  });
}

function _txStopHover() {
  if (!_tx.hover) return;
  _tx.hover.iframe.remove();
  _tx.hover.thumb.classList.remove('is-live');
  _tx.hover = null;
}

function _txSelect(tmplId) {
  const t = window.__TextRegistry?.getById(tmplId) || _txTemplates()[0];
  if (!t) return;
  _tx.tmplId = t.id;
  document.getElementById('txTmplSelect').value = t.id;
  document.querySelectorAll('#txTmplGrid .tx-tmpl-card').forEach(card => {
    const on = card.dataset.id === t.id;
    card.classList.toggle('is-active', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) card.scrollIntoView({ block: 'nearest' });
  });

  const defaults = t.defaults || {};
  const o = _tx.overrides;
  document.getElementById('txFontSize').value = Number(o.fontSize || defaults.fontSize) || 72;
  document.getElementById('txColor').value = _txHex(o.color || defaults.color, '#ffffff');
  const hasHighlight = 'highlightColor' in defaults;
  document.getElementById('txHighlightWrap').style.display = hasHighlight ? '' : 'none';
  document.getElementById('txHighlight').value = _txHex(o.highlightColor || defaults.highlightColor, '#82ea00');
  document.getElementById('txStageName').textContent = t.name;
  document.getElementById('txStageDesc').textContent = t.desc || '';
  _txRenderStage();
  _txSavePrefs();
}

function _txHex(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
}

/** Parâmetros escolhidos no modal que valem para o template atual */
function _txActiveOverrides() {
  const t = window.__TextRegistry?.getById(_tx.tmplId);
  const out = {};
  if (!t) return out;
  const o = _tx.overrides;
  if (o.fontSize) out.fontSize = o.fontSize;
  if (o.color) out.color = o.color;
  if (o.highlightColor && 'highlightColor' in (t.defaults || {})) out.highlightColor = o.highlightColor;
  return out;
}

let _txStageTimer = null;
function _txRenderStage() {
  clearTimeout(_txStageTimer);
  _txStageTimer = setTimeout(() => {
    const t = window.__TextRegistry?.getById(_tx.tmplId);
    const stage = document.getElementById('txStage');
    if (!t || !stage) return;
    const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
    const W = 210;
    const H = Math.min(374, Math.round(W * res.h / res.w));
    stage.style.width  = W + 'px';
    stage.style.height = H + 'px';
    stage.querySelector('iframe')?.remove();
    const iframe = _txMakeFrame(res, W, H);
    iframe.srcdoc = window.__TextRegistry.buildHtml(t.id, _txSampleParams(t, _txActiveOverrides()), res);
    stage.appendChild(iframe);
    _tx.stageClock = 0;
  }, 180);   // arrastar o seletor de cor não recria o documento a cada evento
}

/** Um único loop de rAF a TX_PREVIEW_FPS: palco sempre animando + card sob o mouse */
function _txAnimate() {
  cancelAnimationFrame(_tx.raf);
  const stage = document.getElementById('txStage');
  let last = null;
  const tick = ts => {
    _tx.raf = requestAnimationFrame(tick);
    if (last != null && ts - last < 1000 / TX_PREVIEW_FPS - 2) return;
    const dt = last == null ? 0 : Math.min(0.25, (ts - last) / 1000);
    last = ts;
    // Palco: anima, segura o quadro final 0,8 s e repete
    _tx.stageClock = (_tx.stageClock + dt) % (TX_SAMPLE_DUR + 0.8);
    const stageFrame = stage?.querySelector('iframe');
    if (stageFrame) _txSeek(stageFrame, Math.min(_tx.stageClock, TX_SAMPLE_DUR));
    if (_tx.hover) {
      _tx.hover.clock = (_tx.hover.clock + dt) % (TX_SAMPLE_DUR + 0.5);
      _txSeek(_tx.hover.iframe, Math.min(_tx.hover.clock, TX_SAMPLE_DUR));
    }
  };
  _tx.raf = requestAnimationFrame(tick);
}

/** Fundo do palco: quadro do próprio vídeo (áudio: gradiente neutro) */
async function _txStageBackdrop(clip, tmpl) {
  const stage = document.getElementById('txStage');
  stage.style.backgroundImage = '';
  stage.classList.toggle('is-audio', tmpl?.type !== 'video');
  if (tmpl?.type !== 'video') return;
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = tmpl.dataUrl || tmpl.objectUrl;
    await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = fail; setTimeout(fail, 8000); });
    video.currentTime = (Number(clip.trimStart) || 0) + Math.min(clip.duration * 0.4, 30);
    await new Promise((ok, fail) => { video.onseeked = ok; setTimeout(fail, 8000); });
    const canvas = document.createElement('canvas');
    canvas.width  = 360;
    canvas.height = Math.round(360 * video.videoHeight / video.videoWidth) || 640;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    if (document.getElementById('transcribeModal')?._clipId === clip.id) {
      stage.style.backgroundImage = `url("${canvas.toDataURL('image/jpeg', 0.75)}")`;
    }
    video.removeAttribute('src');
    video.load();
  } catch (_) { /* sem quadro: fica o gradiente */ }
}
// #endregion

// Modal de configuração
function _buildTranscribeModal() {
  if (document.getElementById('transcribeModal')) return;

  const modal = document.createElement('div');
  modal.id        = 'transcribeModal';
  modal.className = 'modal-overlay';
  modal.style.display = 'none';
  modal.innerHTML = `
    <div class="modal tx-modal">
      <div class="modal-header">
        <div class="modal-header-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </div>
        <span>Transcrição Automática</span>
        <button class="icon-btn" id="btnCloseTranscribe">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="modal-body tx-body">
        <div class="tx-stage-col">
          <div class="tx-stage" id="txStage"></div>
          <div class="tx-stage-name" id="txStageName"></div>
          <div class="tx-stage-desc" id="txStageDesc"></div>
        </div>

        <div class="tx-side">
          <p id="txWhisperStatus" class="tx-whisper-status">Verificando Whisper…</p>

          <div class="form-group">
            <label>Estilo da legenda <small>passe o mouse para ver a animação</small></label>
            <input type="hidden" id="txTmplSelect">
            <div class="tx-tmpl-grid" id="txTmplGrid" role="group" aria-label="Templates de legenda"></div>
          </div>

          <div class="tx-style-row">
            <div class="form-group">
              <label for="txFontSize">Tamanho</label>
              <input type="number" id="txFontSize" class="prop-input full" min="12" max="400" step="2">
            </div>
            <div class="form-group">
              <label for="txColor">Cor</label>
              <input type="color" id="txColor">
            </div>
            <div class="form-group" id="txHighlightWrap">
              <label for="txHighlight">Destaque</label>
              <input type="color" id="txHighlight">
            </div>
            <div class="form-group">
              <label for="txLangSelect">Idioma do áudio</label>
              <select id="txLangSelect" class="prop-input full">
                <option value="">Auto-detectar</option>
                <option value="pt" selected>Português</option>
                <option value="en">Inglês</option>
                <option value="es">Espanhol</option>
                <option value="fr">Francês</option>
                <option value="de">Alemão</option>
                <option value="ja">Japonês</option>
                <option value="zh">Chinês</option>
              </select>
            </div>
            <div class="form-group">
              <label for="txTrackIndex">Track</label>
              <input type="number" id="txTrackIndex" class="prop-input full" value="1" min="0" max="99"
                title="Os clips de texto serão criados nessa track (recomendado: acima do vídeo)">
            </div>
          </div>

          <div id="txProgress" style="display:none">
            <div class="progress-bar" style="margin-top:8px">
              <div class="progress-fill" id="txProgressFill" style="width:0%"></div>
            </div>
            <p class="progress-text" id="txProgressText">Enviando para Whisper…</p>
          </div>

          <div id="txResult" style="display:none">
            <div class="tx-result-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#82ea00" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span id="txResultSummary"></span>
            </div>
            <div id="txSegmentList" class="tx-segment-list"></div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" id="btnCancelTranscribe">Cancelar</button>
        <button class="export-btn" id="btnStartTranscribe">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
          Transcrever
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('btnCloseTranscribe')?.addEventListener('click',  closeTranscribeModal);
  document.getElementById('btnCancelTranscribe')?.addEventListener('click', closeTranscribeModal);
  document.getElementById('btnStartTranscribe')?.addEventListener('click',  startTranscription);
  modal.addEventListener('click', e => { if (e.target === modal) closeTranscribeModal(); });

  const onStyle = (field, read) => e => {
    _tx.overrides[field] = read(e.target.value);
    _txRenderStage();
    _txSavePrefs();
  };
  document.getElementById('txFontSize').addEventListener('input', onStyle('fontSize', v => Number(v) || undefined));
  document.getElementById('txColor').addEventListener('input', onStyle('color', v => v));
  document.getElementById('txHighlight').addEventListener('input', onStyle('highlightColor', v => v));
}

/** clipIds: um id ou vários (seleção múltipla) — o primeiro dá o fundo da prévia */
function openTranscribeModal(clipIds) {
  _buildTranscribeModal();

  const ids    = [].concat(clipIds).filter(Boolean);
  const clipId = ids[0];
  const modal  = document.getElementById('transcribeModal');
  modal._clipId  = clipId;
  modal._clipIds = ids;
  modal.querySelector('.modal-header > span').textContent =
    ids.length > 1 ? `Transcrição Automática · ${ids.length} clips` : 'Transcrição Automática';

  // Reset UI
  document.getElementById('txProgress').style.display = 'none';
  document.getElementById('txResult').style.display   = 'none';
  document.getElementById('btnStartTranscribe').disabled = false;
  document.getElementById('txProgressFill').style.width  = '0%';

  modal.style.display = 'flex';

  const prefs = _txLoadPrefs();
  _tx.overrides = { ...(prefs.overrides || {}) };
  _txBuildGrid();
  _txSelect(_tx.tmplId || prefs.tmplId);
  _txAnimate();

  const st   = window.__appState;
  const clip = st?.clips.find(c => c.id === clipId);
  _txStageBackdrop(clip, clip && st.templates.find(t => t.id === clip.templateId));

  // Pré-carrega o modelo enquanto o usuário escolhe as opções
  _refreshWhisperStatus();
}

function closeTranscribeModal() {
  document.getElementById('transcribeModal').style.display = 'none';
  cancelAnimationFrame(_tx.raf);
  clearTimeout(_txStageTimer);
  clearTimeout(_refreshWhisperStatus._t);
  _txStopHover();
  // O documento do palco não fica vivo com o modal fechado (open recria)
  document.querySelector('#txStage iframe')?.remove();
}

async function _fetchWhisperStatus(retry = false) {
  const res = await fetch(`${WHISPER_STATUS}${retry ? '?retry=1' : ''}`, { cache: 'no-store' });
  return res.json();
}

async function _refreshWhisperStatus() {
  const el = document.getElementById('txWhisperStatus');
  if (!el) return;
  try {
    const s = await _fetchWhisperStatus();
    const hw = s.device ? ` · ${s.model} em ${s.device === 'cuda' ? 'GPU' : 'CPU'}` : '';
    el.textContent = s.state === 'failed' ? `⚠ ${s.error}` : `${s.message}${s.ready ? hw : ''}`;
    el.style.color = s.state === 'failed' ? '#ff6b6b' : 'var(--text-dim)';

    // Enquanto instala/baixa, atualiza a linha de status com o modal aberto
    const modal = document.getElementById('transcribeModal');
    if (!s.ready && s.state !== 'failed' && modal?.style.display !== 'none') {
      clearTimeout(_refreshWhisperStatus._t);
      _refreshWhisperStatus._t = setTimeout(_refreshWhisperStatus, 2000);
    }
  } catch {
    el.textContent = '⚠ Servidor não respondeu.';
  }
}

/**
 * Espera o Whisper ficar pronto. Na primeira execução o modelo é baixado
 * (1.5–3 GB) — antes o cliente desistia após 60s e quebrava com
 * "Cannot read properties of undefined", o que parecia falha aleatória.
 */
async function _waitWhisperReady(onProgress) {
  const deadline = Date.now() + WHISPER_READY_TIMEOUT;
  let retry = true; // se falhou antes, tenta de novo uma vez

  while (Date.now() < deadline) {
    const s = await _fetchWhisperStatus(retry);
    retry = false;
    if (s.ready)              return s;
    if (s.state === 'failed') throw new Error(s.error || 'Whisper falhou ao iniciar.');
    onProgress?.(s);
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Tempo esgotado aguardando o Whisper carregar. Veja o terminal do servidor.');
}

// #region Transcrição (reutilizável)
const _txCache = new Map();   // mídia + trecho + idioma → resultado do Whisper

/**
 * Transcreve o trecho usado do clip (vídeo ou áudio). Tempos relativos ao
 * início do trecho (trimStart). onProgress({ stage: 'model'|'read'|'transcribe', status? })
 * Mesmo trecho e idioma reaproveitam o resultado anterior.
 */
async function transcribeClipMedia(clip, { language = '', onProgress } = {}) {
  const tmpl = window.__appState?.templates.find(t => t.id === clip?.templateId);
  if (tmpl?.type !== 'video' && tmpl?.type !== 'audio') {
    throw new Error('Transcrição disponível apenas para clips de vídeo ou áudio.');
  }

  // Só o trecho usado na timeline é transcrito (bem mais rápido em CPU)
  const srcStart = Math.max(0, Number(clip.trimStart) || 0);
  const srcDur   = Math.max(0, Number(clip.duration) || 0);
  const key = [tmpl.dataUrl || tmpl.objectUrl, srcStart.toFixed(3), srcDur.toFixed(3), language].join('|');
  if (_txCache.has(key)) return _txCache.get(key);

  const status = await _waitWhisperReady(s => onProgress?.({ stage: 'model', status: s }));

  onProgress?.({ stage: 'read' });
  // fetch() lê tanto blob: quanto data: URLs
  const blob = await (await fetch(tmpl.dataUrl || tmpl.objectUrl)).blob();

  const MIME_TO_EXT = { quicktime: 'mov', 'x-msvideo': 'avi', 'x-matroska': 'mkv', 'x-m4v': 'm4v', mpeg: 'mp3', 'x-wav': 'wav', 'x-m4a': 'm4a' };
  const rawExt = (tmpl.mimeType || blob.type || 'video/mp4').split('/')[1]?.split(';')[0] || 'mp4';
  const ext    = MIME_TO_EXT[rawExt] || rawExt;

  const qs = new URLSearchParams({
    clipId: clip.id, ext, lang: language,
    start: srcStart.toFixed(3), duration: srcDur.toFixed(3),
  });

  onProgress?.({ stage: 'transcribe', status });

  // Upload binário: antes ia como base64 dentro de JSON (+33% de tamanho,
  // e vídeos grandes estouravam o limite de string do navegador/Node)
  const response = await fetch(`${WHISPER_URL}?${qs}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body:    blob,
  });

  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

  _txCache.set(key, result);
  return result;
}

window.__transcribeClip = function (clipId, opts) {
  const clip = window.__appState?.clips.find(c => c.id === clipId);
  if (!clip) return Promise.reject(new Error('Clip não encontrado.'));
  return transcribeClipMedia(clip, opts);
};
// #endregion

// Transcrição
async function startTranscription() {

  const modal = document.getElementById('transcribeModal');
  const state = window.__appState;
  // Seleção múltipla: transcreve na ordem da timeline
  const clips = (modal._clipIds || [modal._clipId])
    .map(id => state?.clips.find(c => c.id === id))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (!clips.length) { window.MSUI.notify('Clip não encontrado.'); return; }

  const txTmplId   = document.getElementById('txTmplSelect').value;
  const language   = document.getElementById('txLangSelect').value || '';
  const trackIndex = parseInt(document.getElementById('txTrackIndex').value) || 1;

  if (!txTmplId) { window.MSUI.notify('Selecione um template de texto.'); return; }

  const btnStart     = document.getElementById('btnStartTranscribe');
  const progress     = document.getElementById('txProgress');
  const progressFill = document.getElementById('txProgressFill');
  const progressText = document.getElementById('txProgressText');

  btnStart.disabled        = true;
  progress.style.display   = 'block';
  progressText.textContent = 'Preparando Whisper…';
  progressFill.style.width = '5%';

  // Cartão de progresso fixo (continua com o modal fechado; clicar reabre)
  const task = window.MSUI.task({ title: 'Transcrevendo o áudio', detail: progressText.textContent, progress: 0.05, onOpen: () => { modal.style.display = 'flex'; } });
  const sync = () => task.update({ progress: (parseFloat(progressFill.style.width) || 0) / 100, detail: progressText.textContent });

  // Etapa de um clip (local 0–1) → barra do lote inteiro
  let index = 0;
  const setProgress = (local, text) => {
    progressText.textContent = clips.length > 1 ? `Clip ${index + 1}/${clips.length} · ${text}` : text;
    progressFill.style.width = `${((index + local) / clips.length) * 100}%`;
    sync();
  };

  // Todas as legendas do lote: um grupo (editor em lote) e um passo de undo
  const captionGroupId = 'cap_' + mkId();
  const shown  = [];
  const failed = [];
  let created  = 0;
  let last     = null;

  try {
    for (; index < clips.length; index++) {
      const clip = clips[index];
      try {
        let tick = 0;
        const result = await transcribeClipMedia(clip, {
          language,
          onProgress: ({ stage, status }) => {
            if (stage === 'model') {
              // Download do modelo ocupa 5–20% da barra; senão avança devagar
              setProgress(status.progress
                ? 0.05 + status.progress.percent * 0.0015
                : Math.min(0.05 + ++tick * 0.005, 0.2), status.message || 'Carregando modelo Whisper…');
            } else if (stage === 'read') {
              setProgress(0.22, 'Lendo arquivo…');
            } else {
              setProgress(0.35, status.device === 'cuda'
                ? 'Transcrevendo (GPU)…'
                : 'Transcrevendo em CPU — pode levar alguns minutos…');
            }
          },
        });

        const captions = result.captions?.length ? result.captions : (result.segments || []);
        if (!captions.length) throw new Error('Nenhuma fala detectada nesse trecho.');

        setProgress(0.9, 'Criando clips na timeline…');

        const n = _createTextClipsFromSegments(captions, clip, txTmplId, trackIndex, _txActiveOverrides(),
          { captionGroupId, undo: created === 0 });
        if (!n) throw new Error('As falas detectadas ficaram fora do trecho usado do clip.');
        created += n;
        last = result;
        // Na lista do lote, tempos da timeline (cada clip começa num ponto)
        captions.forEach(seg => shown.push(clips.length > 1 ? { ...seg, start: clip.start + seg.start } : seg));
      } catch (err) {
        // Um clip sem fala não derruba o lote; erro de servidor sim, se for o único
        console.error('[Transcribe] Erro:', clip.label, err);
        failed.push(`${clip.label || clip.id}: ${err.message}`);
      }
    }

    if (!created) throw new Error(failed.join('\n') || 'Nada transcrito.');

    index = clips.length;
    progressFill.style.width = '100%';
    _showTranscribeResult(clips.length > 1
      ? { ...last, captions: shown, probability: null, duration: clips.reduce((sum, c) => sum + c.duration, 0) }
      : last);
    btnStart.disabled = false;
    task.done(`${created} legenda(s) criadas` + (failed.length ? ` · ${failed.length} clip(s) sem legenda` : ''));
    if (failed.length) window.MSUI.notify(`Alguns clips não foram legendados:\n${failed.join('\n')}`);

  } catch (err) {
    progress.style.display = 'none';
    btnStart.disabled      = false;
    task.fail(err.message || 'Falhou');
    _refreshWhisperStatus();
    window.MSUI.notify(`Erro na transcrição:\n${err.message}`);
  }
}

// Cria clips de texto na timeline
/** overrides: { fontSize?, color?, highlightColor? } escolhidos no modal */
/** batch: { captionGroupId?, undo? } — lote de vários clips num grupo e num passo de undo */
function _createTextClipsFromSegments(segments, sourceClip, txTmplId, trackIndex, overrides = {}, batch = {}) {
  const state  = window.__appState;
  const res    = state.project.res;
  const txTmpl = window.__TextRegistry?.getById(txTmplId);
  if (!txTmpl) return;

  // Timestamps vêm relativos ao início do trecho usado (trimStart) do clip
  const clipEnd = sourceClip.start + sourceClip.duration;

  const valid = segments.filter(seg => seg.text && sourceClip.start + seg.start < clipEnd);
  if (!valid.length) return 0;

  // Um passo de undo para a transcrição inteira
  if (batch.undo !== false) window.__tlPushUndo?.();

  // Se a track escolhida já tem clips nesse intervalo, sobe para a primeira livre
  const rangeStart = sourceClip.start + valid[0].start;
  const rangeEnd   = Math.min(clipEnd, sourceClip.start + valid[valid.length - 1].start + valid[valid.length - 1].duration);
  trackIndex = window.__findFreeTrack?.(rangeStart, rangeEnd, trackIndex) ?? trackIndex;

  const captionGroupId = batch.captionGroupId || 'cap_' + mkId();
  let created = 0;

  segments.forEach((seg, i) => {
    if (!seg.text) return;

    const start    = sourceClip.start + seg.start;
    const duration = Math.min(seg.duration, clipEnd - start);
    if (start >= clipEnd || duration < 0.1) return;

    // Palavras relativas ao início da legenda, para animação palavra a palavra
    const words = (seg.words || []).map(w => ({
      word:  w.word,
      start: Math.max(0, +(w.start - seg.start).toFixed(3)),
      end:   Math.max(0, +(w.end   - seg.start).toFixed(3)),
    }));

    const params = {
      ...txTmpl.defaults,
      ...overrides,
      text:      seg.text,
      duration,
      // JSON seguro para embutir dentro de <script> no template
      wordsJson: JSON.stringify(words).replace(/</g, '\\u003c'),
    };

    const html       = window.__TextRegistry.buildHtml(txTmplId, params, res);
    const templateId = mkId();
    const clipId     = mkId();
    const color      = SCENE_COLORS[i % SCENE_COLORS.length];

    state.templates.push({
      id:             templateId,
      type:           'text',
      html,
      textParams:     { ...params },
      textTmplId:     txTmplId,
      sourceDuration: duration,
      fps:            30,
      label:          seg.text.slice(0, 32),
      color,
    });

    state.clips.push({
      id:         clipId,
      templateId,
      label:      seg.text.slice(0, 32),
      start,
      duration:   Math.max(duration, 0.2),
      trimStart:  0,
      trimEnd:    duration,
      trackIndex,
      color,
      _tx:    { x: 0, y: 0, w: res.w, h: res.h, r: 0 },
      isText: true,
      words,
      captionGroupId,
    });
    created++;
  });

  recalcProjectDuration?.();
  syncProjectGlobals?.();
  renderSceneList?.();
  renderTimeline?.();
  window.mountAllClips?.();

  if (typeof getTrack === 'function') getTrack(trackIndex);
  _lastCaptionClipId = state.clips.find(c => c.captionGroupId === captionGroupId)?.id || null;
  return created;
}

let _lastCaptionClipId = null;

// Mostra resultado no modal
function _showTranscribeResult(result) {
  document.getElementById('txProgressText').textContent = 'Concluído!';

  const resultEl  = document.getElementById('txResult');
  const summaryEl = document.getElementById('txResultSummary');
  const listEl    = document.getElementById('txSegmentList');

  const nCaptions = result.captions?.length ?? 0;
  const nWords    = result.captions?.reduce((acc, c) => acc + (c.words?.length ?? 0), 0) ?? 0;

  summaryEl.textContent =
    `${nCaptions} legendas · ${nWords} palavras · ` +
    `${result.language?.toUpperCase()} ` +
    `${result.probability != null ? `(${Math.round(result.probability * 100)}%) · ` : ''}` +
    `${fmtTime(result.duration)}`;

  // Mostra captions (agrupadas por palavras), não os segments brutos
  const source = result.captions?.length ? result.captions : result.segments;
  listEl.innerHTML = source.map(seg => `
    <div class="tx-segment">
      <span class="tx-seg-time">${fmtTime(seg.start)}</span>
      <span class="tx-seg-text">${escapeHtml(seg.text)}</span>
      <span class="tx-seg-dur">${seg.duration.toFixed(1)}s</span>
    </div>
  `).join('');

  resultEl.style.display = 'block';

  // Atalho para o editor em lote das legendas recém-criadas
  let btn = document.getElementById('btnTxOpenCaptions');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'btnTxOpenCaptions';
    btn.className = 'btn-secondary';
    btn.style.marginTop = '8px';
    btn.textContent = 'Editar legendas…';
    btn.addEventListener('click', () => {
      closeTranscribeModal();
      window.openCaptionsEditor?.(_lastCaptionClipId);
    });
    resultEl.appendChild(btn);
  }
}

// ── Hook no context menu
window.__onClipTranscribe = function(clipId) {
  openTranscribeModal(clipId);
};