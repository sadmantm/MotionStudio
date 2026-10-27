// export.js (frontend)
'use strict';

// #region Configuração
// A interface é servida pelo próprio servidor de export (porta/host podem variar)
const EXPORT_SERVER = location.protocol.startsWith('http') ? location.origin : 'http://localhost:3001';
// #endregion

// #region Utilitários de UI
function setProgress(pct, msg) {
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = msg;
  // Cartão de progresso fixo: continua visível com o modal fechado (clicar reabre)
  const task = window.__exportTask;
  if (task?.running) {
    const text = String(msg).replace(/^[✅❌]\s*/, '');
    if (/^❌/.test(msg)) task.fail(text);
    else if (/^✅/.test(msg)) task.done(text);
    else task.update({ progress: Math.max(0, Math.min(1, pct / 100)), detail: text });
  }
}

function setExportBusy(busy) {
  document.getElementById('btnStartExport').disabled = busy;
}
// #endregion

// #region Validação Pré-Export
function validateProjectForExport(clips) {
  const errors = [];

  if (!Array.isArray(clips) || !clips.length) {
    return ['Nenhum projeto carregado.'];
  }

  clips.forEach((clip, index) => {
    const label = clip.label || clip.id || 'Sem nome';

    const hasContent = clip.isText
      ? Boolean(clip.html || clip.textParams)
      : clip.type === 'html'
        ? Boolean(clip.html)
        : Boolean(clip.uploadId || clip.dataUrl);

    if (!hasContent) {
      errors.push(`Clip ${index + 1} (${label}): sem conteúdo.`);
    }

    if (!(Number(clip.duration) > 0)) {
      errors.push(`Clip ${index + 1} (${label}): duração inválida.`);
    }

    if (!Number.isFinite(Number(clip.start)) || Number(clip.start) < 0) {
      errors.push(`Clip ${index + 1} (${label}): início inválido.`);
    }
  });

  return errors;
}
async function uploadMediaForExport(url, clip, mimeType) {
  const sourceResponse = await fetch(url);

  if (!sourceResponse.ok) {
    throw new Error(
      `Falha ao ler "${clip.label}": HTTP ${sourceResponse.status}`
    );
  }

  const blob = await sourceResponse.blob();

  const response = await fetch(
    `${EXPORT_SERVER}/api/export/media/upload`,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          blob.type ||
          mimeType ||
          'application/octet-stream',

        'X-Clip-Id':
          String(clip.id || ''),

        'X-File-Name':
          encodeURIComponent(
            clip.label || 'media'
          ),
      },
      body: blob,
    }
  );

  if (!response.ok) {
    throw new Error(
      await response.text()
    );
  }

  const result =
    await response.json();

  if (!result?.uploadId) {
    throw new Error(
      'Servidor não retornou o identificador do upload.'
    );
  }

  return result.uploadId;
}
/*
 * HTML do template de texto para o export — o MESMO documento que o preview
 * monta (TextRegistry.buildHtml), reconstruído com os params atuais e
 * duration = clip.duration (o compositor faz igual ao redimensionar o clip).
 * Sem registry/template → null e o backend usa o renderizador genérico.
 */
function buildTextHtmlForExport(tmpl, textParams) {
  const registry = window.__TextRegistry;
  const res = window.__appState?.project?.res;

  if (
    tmpl.textTmplId &&
    textParams &&
    typeof registry?.buildHtml === 'function' &&
    registry.getById?.(tmpl.textTmplId)
  ) {
    try {
      const html = registry.buildHtml(
        tmpl.textTmplId,
        textParams,
        res
      );
      if (html) return html;
    } catch (err) {
      console.warn('[export] Falha ao montar HTML do texto:', err);
    }
  }

  return tmpl.html || null;
}

async function buildClipForExport(
  clip,
  templates,
  tracks,
  fallbackFps
) {
  const tmpl =
    templates.find(
      template =>
        template.id === clip.templateId
    );

  if (!tmpl) {
    return null;
  }

  // A câmera 2D não tem imagem: ela só move as camadas abaixo (cams, mais abaixo)
  if (window.ClipKF?.isCamera(clip)) {
    return null;
  }

  const track =
    tracks.find(
      item =>
        item.index ===
        (clip.trackIndex ?? 0)
    );

  if (track?.hidden) {
    return null;
  }

  // Áudio efetivo (mesma regra do preview: mudo do clip/track, solo de track)
  const anySolo = tracks.some(item => item.solo);
  const audioMuted = Boolean(
    clip.muted || track?.muted || (anySolo && !track?.solo)
  );

  const isText =
    Boolean(
      clip.isText ||
      tmpl.type === 'text'
    );

  const entry = {
    id:
      clip.id,

    label:
      clip.label,

    type:
      isText ||
      tmpl.type === 'html'
        ? 'html'
        : tmpl.type,

    isText,

    textParams:
      isText && tmpl.textParams
        ? {
            ...tmpl.textParams,
            duration:
              Number(clip.duration) || 0,
          }
        : null,

    textTmplId:
      isText
        ? tmpl.textTmplId || null
        : null,

    start:
      Number(clip.start) || 0,

    duration:
      Number(clip.duration) || 0,

    trimStart:
      Number(clip.trimStart) || 0,

    trimEnd:
      Number(clip.trimEnd) ||
      Number(tmpl.sourceDuration) ||
      Number(clip.duration) ||
      0,

    sourceDuration:
      Number(tmpl.sourceDuration) ||
      Number(clip.duration) ||
      0,

    fitAnimationToClip:
      Boolean(
        clip.fitAnimationToClip
      ),

    trackIndex:
      clip.trackIndex ?? 0,

    volume:
      audioMuted ? 0 : (window.ClipKF?.has(clip, 'volume') ? 1 : Math.max(0, Math.min(1, Number(clip.volume ?? 1)))) *
        Math.max(0, Math.min(1, Number(track?.volume ?? 1))),

    // Keyframes de volume: curva em segundos do clip, já multiplicada pelo volume da track
    // (mudo/solo: sem curva; volume acima fica 0)
    volumeKeys:
      audioMuted ? null : window.ClipKF?.exportKeys(clip, Math.max(0, Math.min(1, Number(track?.volume ?? 1)))) || null,

    fadeIn:
      Math.max(0, Number(clip.fadeIn) || 0),

    fadeOut:
      Math.max(0, Number(clip.fadeOut) || 0),

    // Mesclagem, camada de ajuste e câmeras 2D acima desta camada (ver ClipKF.fxExtras)
    blend:
      window.ClipKF?.fxExtras(clip, [])?.blend || null,

    adj:
      Boolean(window.ClipKF?.fxExtras(clip, [])?.adj),

    ...(window.ClipKF
      ? (({ cams, center, frame }) => (cams ? { cams, center, frame } : {}))(window.ClipKF.fxExtras(clip, window.ClipKF.cameras()))
      : {}),

    // Animação por keyframes (escala, posição, rotação, cor): chaves em segundos do clip + a caixa fixa de referência
    kf:
      window.ClipKF?.hasAnim(clip) ? window.ClipKF.relKeys(clip) : null,

    kfBase:
      window.ClipKF?.hasAnim(clip) ? window.ClipKF.baseOf(clip) : null,

    // Efeitos e transições (clip-fx.js); tailFx é preenchido em runExport
    fx:
      clip.fx || null,

    tx:
      clip._tx || null,

    txNat:
      clip._txNat || null,

    fps:
      Number(tmpl.fps) ||
      fallbackFps,

    html:
      null,

    dataUrl:
      null,

    uploadId:
      null,

    mimeType:
      tmpl.mimeType || null,
  };

  // Camadas especiais (sólido, gradiente, forma, ajuste…): vão como HTML com a imagem SVG embutida,
  // o mesmo caminho dos clips HTML (o arquivo .svg enviado não teria extensão no servidor)
  if (tmpl.layer && window.MSLayers?.exportHtml) {
    entry.type = 'html';
    entry.html = window.MSLayers.exportHtml(tmpl, entry.duration);
    entry.trimStart = 0;
    entry.trimEnd = entry.duration;
    entry.sourceDuration = entry.duration;
    entry.fitAnimationToClip = false;
    entry.dataUrl = null;
    entry.uploadId = null;
    return entry;
  }

  if (entry.type === 'html') {
    if (isText) {
      /*
       * Textos exportam com o HTML animado do próprio template (igual ao
       * preview). Tempo 1:1 com a timeline: sem trim nem time-stretch.
       */
      entry.html =
        buildTextHtmlForExport(
          tmpl,
          entry.textParams
        );
      entry.trimStart = 0;
      entry.trimEnd = entry.duration;
      entry.sourceDuration = entry.duration;
      entry.fitAnimationToClip = false;
    } else {
      entry.html = tmpl.html;
    }

    return entry;
  }

  entry.uploadId =
    await uploadMediaForExport(
      tmpl.dataUrl,
      clip,
      tmpl.mimeType
    );

  return entry;
}
// #endregion

// #region Conversão de mídia para base64
async function blobUrlToDataUri(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
// #endregion

// #region Execução do Export
window.runExport = async function runExport() {
  const fmt     = document.getElementById('exportFormat').value;
  const fps = parseInt(document.getElementById('exportFps').value) || 30;
  const W = parseInt(document.getElementById('exportWidth').value)  || 1920;
  const H = parseInt(document.getElementById('exportHeight').value) || 1080 ;
  console.log('export dims →', {
    rawW: document.getElementById('exportWidth')?.value,
    rawH: document.getElementById('exportHeight')?.value,
    W, H,
  });
  // 0 = automático (o servidor decide pelos núcleos e RAM livres)
  const workers = Math.max(0, parseInt(document.getElementById('exportWorkers').value) || 0);

  document.getElementById('exportProgress').style.display = 'block';
  setExportBusy(true);
  window.__exportTask?.close();
  window.__exportTask = window.MSUI?.task({
    title: 'Exportando vídeo',
    detail: 'Preparando…',
    progress: 0,
    onOpen: () => { document.getElementById('exportModal').style.display = 'flex'; },
  });

  // ── 1. Health check ────────────────────────────────────────
  try {
    const hc = await fetch(`${EXPORT_SERVER}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!hc.ok) throw new Error('status ' + hc.status);
  } catch {
    setProgress(0, '❌ Servidor offline — execute: node server.js');
    setExportBusy(false);
    return;
  }

  // ── 2. Coleta de clips do state (não de __projectScenes) ───
  const state      = window.__appState;
  const stateClips = state?.clips || [];
  const templates  = state?.templates || [];
  const tracks     = state?.tracks || [];

  if (!stateClips.length) {
    setProgress(0, '❌ Nenhum clip no projeto.');
    setExportBusy(false);
    return;
  }

  // Monta clips com tipo + conteúdo resolvido
  const clipsForExport = [];

  for (const clip of stateClips) {
    try {
      const entry =
        await buildClipForExport(
          clip,
          templates,
          tracks,
          fps
        );
  
      if (entry) {
        clipsForExport.push(entry);
      }
    } catch (err) {
      setProgress(
        0,
        `❌ Falha ao preparar "${clip.label}": ${err.message}`
      );
  
      setExportBusy(false);
      return;
    }
  }

  // Transição entre clips: o anterior fica visível por baixo (mesma regra do preview)
  const tails = window.__buildTailMap?.(stateClips) || new Map();
  clipsForExport.forEach(entry => {
    entry.tailFx = tails.get(entry.id) || null;
  });

  const errors = validateProjectForExport(clipsForExport);
  if (errors.length) {
    setProgress(0, '❌ ' + errors.join(' | '));
    setExportBusy(false);
    return;
  }

  setProgress(2, `Enviando ${clipsForExport.length} clip(s) para o servidor…`);

  // ── 3. Inicia o job ───────────────────────────────────────
  let jobId;
  try {
    const r = await fetch(`${EXPORT_SERVER}/api/export/start`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: clipsForExport,
        fps, format: fmt, width: W, height: H,
        projectRes: state?.project?.res || { w: W, h: H },   // ← NOVO
        workersPerScene: workers,
        quality: document.getElementById('exportQuality')?.value || 'high',
        background: state?.project?.background || '#000000',
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    jobId = (await r.json()).jobId;
  } catch (err) {
    setProgress(0, '❌ Erro ao iniciar job: ' + err.message);
    setExportBusy(false);
    return;
  }

  setProgress(5, 'Renderizando frames…');

  // #region Conversão de mídia para base64
async function blobUrlToDataUri(url) {
  // Vídeos/imagens entram como blob: (object URL). O backend não consegue lê-los,
  // então convertemos para data URI base64 e enviamos no payload.
  const resp = await fetch(url);
  const blob = await resp.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
// #endregion


  // ── 6. Polling ────────────────────────────────────────────
  try {
    await pollJob(jobId, job => {
      setProgress(5 + Math.round(job.progress * 0.93), job.message || 'Processando…');
    });
  } catch (err) {
    setProgress(0, '❌ ' + err.message);
    setExportBusy(false);
    return;
  }

  // ── 7. Download ───────────────────────────────────────────
  setProgress(99, 'Preparando download…');
  const a      = document.createElement('a');
  a.href       = `${EXPORT_SERVER}/api/export/download/${jobId}`;
  a.download   = `motion-export.${fmt}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setProgress(100, '✅ Exportação concluída!');
  setTimeout(() => {
    document.getElementById('exportModal').style.display    = 'none';
    document.getElementById('exportProgress').style.display = 'none';
    setExportBusy(false);
  }, 2500);
};
// #endregion

// #region Polling de Status do Job
function pollJob(jobId, onUpdate) {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const r   = await fetch(`${EXPORT_SERVER}/api/export/status/${jobId}`);
        const job = await r.json();
        onUpdate(job);
        if (job.status === 'done')  { clearInterval(iv); resolve(job); }
        if (job.status === 'error') { clearInterval(iv); reject(new Error(job.error || 'Erro desconhecido')); }
      } catch (e) { clearInterval(iv); reject(e); }
    }, 800);
  });
}
// #endregion