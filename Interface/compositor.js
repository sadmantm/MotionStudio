'use strict';
// compositor.js

//  MODELO:
//    Um único "stage" no preview contém N iframes empilhados.
//    Cada iframe corresponde a UM clip da timeline.
//    A timeline controla: visibilidade, seek e play/pause
//    de cada iframe conforme o currentFrame do projeto.
//
//    O iframe nunca "assiste" ao playhead — quem decide o que
//    está visível é sempre o loop principal do app.

let _trimData = null;

// #region Trim de Clips

function startTrim(
  clipId,
  side,
  startX
) {
  const clip = state.clips.find(
    item => item.id === clipId
  );

  if (!clip || isClipLocked(clip)) return;

  _isInteracting = true;

  // Vizinhos na mesma track: o trim não pode invadir outro clip
  const trackIndex = Number(clip.trackIndex) || 0;
  const clipEnd = clip.start + clip.duration;
  const neighbours = state.clips.filter(
    item => item.id !== clipId && (Number(item.trackIndex) || 0) === trackIndex
  );
  const prevEnd = Math.max(
    0,
    ...neighbours
      .filter(item => item.start + item.duration <= clip.start + 1e-6)
      .map(item => item.start + item.duration)
  );
  const nextStart = Math.min(
    Infinity,
    ...neighbours
      .filter(item => item.start >= clipEnd - 1e-6)
      .map(item => item.start)
  );

  const tmpl = state.templates.find(
    template =>
      template.id === clip.templateId
  );

  const isText = Boolean(
    clip.isText
  );

  const isImage =
    tmpl?.type === 'image';

  const isHtmlFit = Boolean(
    tmpl?.type === 'html' &&
    !isText &&
    clip.fitAnimationToClip
  );

  const sourceDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(tmpl?.sourceDuration) ||
      clip.duration
  );

  /*
   * Texto, imagem e HTML com time stretch
   * podem possuir uma duração livre.
   */
  const hasFreeDuration =
    isText ||
    isImage ||
    isHtmlFit;

  _trimData = {
    clipId,
    side,
    startX,

    origStart:
      clip.start,

    origDuration:
      clip.duration,

    origTrimStart:
      clip.trimStart || 0,

    origTrimEnd:
      clip.trimEnd ?? sourceDuration,

    prevEnd,
    nextStart,
    undoPushed: false,
  };

  document.body.style.cursor =
    'ew-resize';

  const onMove = event => {
    if (!_trimData) return;

    const currentClip =
      state.clips.find(
        item =>
          item.id === _trimData.clipId
      );

    if (!currentClip) return;

    const dx =
      event.clientX -
      _trimData.startX;

    const delta =
      dx /
      (PX_PER_SEC * state.zoom);

    // Undo só quando o clip realmente muda (clique sem arrastar não gera passo)
    if (!_trimData.undoPushed) {
      if (Math.abs(dx) < 2) return;
      tlPushUndo();
      _trimData.undoPushed = true;
    }

    let snapPx = null;
    let didEdgeSnap = false;

    if (_trimData.side === 'right') {
      const rawEnd =
        _trimData.origStart +
        _trimData.origDuration +
        delta;

      const snapInfo = snapTimeInfo(
        rawEnd,
        [_trimData.clipId]
      );
      const snapped = snapInfo.time;
      didEdgeSnap = snapInfo.edge;

      const maxDuration = Math.min(
        hasFreeDuration
          ? Infinity
          : Math.max(
              MIN_CLIP_DURATION,
              sourceDuration -
                _trimData.origTrimStart
            ),
        Math.max(
          MIN_CLIP_DURATION,
          _trimData.nextStart - currentClip.start
        )
      );

      snapPx =
        snapped *
        PX_PER_SEC *
        state.zoom;

      currentClip.duration = clamp(
        snapped - currentClip.start,
        MIN_CLIP_DURATION,
        maxDuration
      );

      if (isHtmlFit) {
        /*
         * Mantém toda a faixa original.
         * Apenas a duração visual do clipe muda.
         */
        currentClip.trimStart =
          _trimData.origTrimStart;

        currentClip.trimEnd =
          _trimData.origTrimEnd;
      } else if (
        isText ||
        isImage
      ) {
        currentClip.trimStart = 0;
        currentClip.trimEnd =
          currentClip.duration;
      } else {
        currentClip.trimEnd =
          currentClip.trimStart +
          currentClip.duration;
      }
    } else {
      const rawStart =
        _trimData.origStart +
        delta;

      const snapInfo = snapTimeInfo(
        rawStart,
        [_trimData.clipId]
      );
      const snapped = snapInfo.time;
      didEdgeSnap = snapInfo.edge;

      const maxStart =
        _trimData.origStart +
        _trimData.origDuration -
        MIN_CLIP_DURATION;

      /*
       * Clips normais só podem ser estendidos para
       * a esquerda enquanto ainda houver conteúdo fonte.
       *
       * Clips com time stretch possuem duração livre.
       */
      const minStart = Math.max(
        _trimData.prevEnd,
        hasFreeDuration
          ? 0
          : Math.max(
              0,
              _trimData.origStart -
                _trimData.origTrimStart
            )
      );

      snapPx =
        snapped *
        PX_PER_SEC *
        state.zoom;

      const newStart = clamp(
        snapped,
        minStart,
        maxStart
      );

      const difference =
        newStart -
        _trimData.origStart;

      currentClip.start =
        newStart;

      currentClip.duration =
        _trimData.origDuration -
        difference;

      if (isHtmlFit) {
        /*
         * Mesmo alterando a borda esquerda,
         * toda a animação permanece no clipe.
         */
        currentClip.trimStart =
          _trimData.origTrimStart;

        currentClip.trimEnd =
          _trimData.origTrimEnd;
      } else if (
        isText ||
        isImage
      ) {
        currentClip.trimStart = 0;
        currentClip.trimEnd =
          currentClip.duration;
      } else {
        currentClip.trimStart = clamp(
          _trimData.origTrimStart +
            difference,
          0,
          Math.max(
            0,
            sourceDuration -
              MIN_CLIP_DURATION
          )
        );

        currentClip.trimEnd =
          currentClip.trimStart +
          currentClip.duration;
      }
    }

    normalizeClip(
      currentClip,
      hasFreeDuration
        ? Infinity
        : Math.max(
            MIN_CLIP_DURATION,
            sourceDuration -
              currentClip.trimStart
          )
    );

    /*
     * Clips de texto continuam usando o
     * sistema próprio de duração dinâmica.
     */
    if (isText) {
      try {
        window.__Compositor
          ?.get(currentClip.id)
          ?.iframe
          ?.contentWindow
          ?.Motion
          ?.setDuration(
            currentClip.duration
          );
      } catch (_) {}
    }

    const entry =
      window.__Compositor?.get(
        currentClip.id
      );

    if (entry) {
      /*
       * Força o compositor a reenviar o seek,
       * mesmo que o playhead não tenha mudado.
       */
      entry._lastSeekSent = undefined;
    }

    const edgeTime = _trimData.side === 'right'
      ? currentClip.start + currentClip.duration
      : currentClip.start;
    // Guia só quando encostou numa borda/playhead e o clamp não afastou a borda
    const snappedToEdge =
      didEdgeSnap &&
      snapPx !== null &&
      Math.abs(edgeTime * PX_PER_SEC * state.zoom - snapPx) < 0.5;

    showSnapGuide(snappedToEdge ? snapPx : null);

    recalcProjectDuration();
    syncProjectGlobals();
    refreshClipBlock(currentClip.id);
    updateTimelineWidth();

    window.__updatePlayhead?.(
      state.time
    );

    window.__syncCompositorToTime?.(
      state.time
    );
  };

  const onUp = () => {
    const finalClip =
      state.clips.find(
        item => item.id === clipId
      );

    _trimData = null;
    _isInteracting = false;

    document.body.style.cursor = '';

    hideSnapGuide();

    /*
     * Somente clips de texto precisam ter
     * seu HTML reconstruído.
     *
     * HTMLs importados com time stretch não
     * precisam ser remontados.
     */
    if (finalClip?.isText) {
      const textTemplate =
        state.templates.find(
          template =>
            template.id ===
            finalClip.templateId
        );

      if (textTemplate?.textParams) {
        textTemplate.textParams.duration =
          finalClip.duration;

        textTemplate.sourceDuration =
          finalClip.duration;

        textTemplate.html =
          window.__TextRegistry.buildHtml(
            textTemplate.textTmplId,
            textTemplate.textParams,
            state.project?.res
          );

        window.remountClip?.(
          finalClip.id
        );
      }
    }

    recalcProjectDuration();
    syncProjectGlobals();

    renderSceneList();
    renderProjectSettings();
    renderTimeline();

    window.__syncCompositorToTime?.(
      state.time
    );

    updateSelectionFeedback();

    document.removeEventListener(
      'mousemove',
      onMove
    );

    document.removeEventListener(
      'mouseup',
      onUp
    );
  };

  document.addEventListener(
    'mousemove',
    onMove
  );

  document.addEventListener(
    'mouseup',
    onUp
  );
}
// #endregion

function applyClipTransformStyle(iframe, clip) {
  const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
  const tx  = clip._tx || { x: 0, y: 0, w: res.w, h: res.h, r: 0 };

  let wrap = iframe.parentElement?.classList.contains('__tx_wrap')
    ? iframe.parentElement : null;

  if (!wrap) {
    wrap = iframe.ownerDocument.createElement('div');
    wrap.className = '__tx_wrap';
    iframe.parentElement?.insertBefore(wrap, iframe);
    wrap.appendChild(iframe);
  }

  wrap.style.cssText = `
    position:absolute;
    left:${tx.x}px;
    top:${tx.y}px;
    width:${tx.w}px;
    height:${tx.h}px;
    transform:rotate(${tx.r}deg);
    transform-origin:center center;
    overflow:hidden;
    pointer-events:none;
    z-index:${((clip.trackIndex ?? 0) + 1) * 2};
  `;

  iframe.style.cssText = `
    position:absolute;
    left:0; top:0;
    width:${res.w}px;
    height:${res.h}px;
    transform:scale(${tx.w / res.w}, ${tx.h / res.h});
    transform-origin:0 0;
    border:none;
    pointer-events:none;
  `;

  _clearInnerScale(iframe);
}

function _clearInnerScale(iframe) {
  function inject() {
    try {
      const doc = iframe.contentDocument;
      if (!doc || !doc.head) return false;
      const tag = doc.getElementById('__ms_preview_scale');
      if (tag) tag.textContent = '';
      return true;
    } catch (_) { return false; }
  }
  if (!inject()) iframe.addEventListener('load', inject, { once: true });
}

// mantém assinatura antiga para não quebrar chamadas externas
function _applyInnerScale(iframe) { _clearInnerScale(iframe); }

function _applyElementTransform(el, clip) {
  const res = window.__appState?.project?.res || { w: 1080, h: 1920 };
  const tx  = clip._tx || { x: 0, y: 0, w: res.w, h: res.h, r: 0 };

  // ── FIX: nativos também precisam do __tx_wrap para z-index,
  // overflow e comportamento consistente com iframes HTML.
  let wrap = el.parentElement?.classList.contains('__tx_wrap')
    ? el.parentElement
    : null;

  if (!wrap) {
    wrap = el.ownerDocument.createElement('div');
    wrap.className = '__tx_wrap';
    el.parentElement?.insertBefore(wrap, el);
    wrap.appendChild(el);
  }

  wrap.style.cssText = `
    position:absolute;
    left:${tx.x}px;
    top:${tx.y}px;
    width:${tx.w}px;
    height:${tx.h}px;
    transform:rotate(${tx.r}deg);
    transform-origin:center center;
    overflow:hidden;
    pointer-events:none;
    z-index:${((clip.trackIndex ?? 0) + 1) * 2};
  `;

  // O elemento nativo preenche o wrapper 100% — sem escala interna.
  el.style.cssText = `
    position:absolute;
    inset:0;
    width:100%;
    height:100%;
    border:none;
    pointer-events:none;
    object-fit:fill;
    display:block;
  `;
}
function mapClipTimeToSource(
  clip,
  timelineTime,
  tmpl = null
) {
  if (!clip) return 0;

  const clipDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(clip.duration) ||
      MIN_CLIP_DURATION
  );

  const elapsed = clamp(
    Number(timelineTime) -
      Number(clip.start || 0),
    0,
    clipDuration
  );

  const template =
    tmpl ||
    state.templates.find(
      item => item.id === clip.templateId
    );

  const shouldStretch = Boolean(
    clip.fitAnimationToClip &&
    template?.type === 'html' &&
    !clip.isText
  );

  /*
   * Comportamento normal:
   * um segundo na timeline equivale a um segundo
   * dentro do HTML.
   */
  if (!shouldStretch) {
    return Math.max(
      0,
      (Number(clip.trimStart) || 0) +
        elapsed
    );
  }

  const sourceDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(template.sourceDuration) ||
      Number(clip.trimEnd) ||
      clipDuration
  );

  const sourceIn = clamp(
    Number(clip.trimStart) || 0,
    0,
    sourceDuration
  );

  const sourceOut = clamp(
    Number(clip.trimEnd) || sourceDuration,
    sourceIn,
    sourceDuration
  );

  /*
   * Converte a posição atual do clipe em progresso:
   *
   * timeline: 0% ---------------------- 100%
   * HTML:     sourceIn ---------------- sourceOut
   */
  const progress =
    clipDuration > 0
      ? clamp(
          elapsed / clipDuration,
          0,
          1
        )
      : 0;

  return (
    sourceIn +
    (sourceOut - sourceIn) * progress
  );
}
function mountClipIntoCompositor(
  clip,
  tmpl
) {
  if (!clip || !tmpl) {
    return null;
  }

  const existing =
    window.__Compositor
      ?.get(clip.id);

  if (existing) {
    return existing;
  }

  if (tmpl.type === 'video') {
    return window.__Compositor
      .mountVideo(
        clip,
        tmpl.dataUrl,
        tmpl.mimeType
      );
  }

  if (tmpl.type === 'audio') {
    return window.__Compositor
      .mountAudio(
        clip,
        tmpl.dataUrl,
        tmpl.mimeType
      );
  }

  if (tmpl.type === 'image') {
    return window.__Compositor
      .mountImage(
        clip,
        tmpl.dataUrl
      );
  }

  return window.__Compositor
    .mount(
      clip,
      tmpl.html
    );
}

function reconcileCompositorWindow(
  time,
  preloadSeconds = 1.5
) {
  const state =
    window.__appState;

  const compositor =
    window.__Compositor;

  if (
    !state?.clips ||
    !compositor
  ) {
    return;
  }

  const currentTime =
    Math.max(
      0,
      Number(time) || 0
    );

  const selectedId =
    state.currentClipId ||
    null;

  const validIds =
    new Set(
      state.clips.map(
        clip => clip.id
      )
    );

  compositor
    .allIds()
    .forEach(id => {
      if (!validIds.has(id)) {
        compositor.unmount(id);
      }
    });

  const tails = buildTailMap(state.clips);

  state.clips.forEach(clip => {
    const start =
      Number(clip.start) || 0;

    const end =
      start +
      Math.max(
        0.001,
        Number(
          clip.duration
        ) || 0.001
      ) +
      // Clip anterior de uma transição fica montado durante o "rabo"
      (tails.get(clip.id)?.duration || 0);

    const shouldMount =
      clip.id === selectedId ||
      (
        currentTime >=
          start -
          preloadSeconds &&

        currentTime <=
          end +
          preloadSeconds
      );

    const entry =
      compositor.get(
        clip.id
      );

    if (
      shouldMount &&
      !entry
    ) {
      const tmpl =
        state.templates.find(
          template =>
            template.id ===
            clip.templateId
        );

      mountClipIntoCompositor(
        clip,
        tmpl
      );

      return;
    }

    if (
      !shouldMount &&
      entry
    ) {
      if (
        entry.isNative &&
        entry.nativeType ===
          'video'
      ) {
        compositor.send(
          clip.id,
          { type: 'PAUSE' }
        );
      }

      compositor.unmount(
        clip.id
      );
    }
  });
}

// #region Bridge injetado em cada clip-iframe

function injectClipBridge(html, clipId) {
  const bridge = `
<script id="__ms_bridge">
(function(){
  const CID = ${JSON.stringify(clipId)};
  window.__clipId_injected = CID;
  const post = m => window.top?.postMessage({ ...m, __clipId: CID }, '*');

  let clock = 0, playing = false, raf = null, lastTs = null;

  // Compatibilidade: tenta window.Motion, MotionAPI, GSAP, CSS animations
  function seekEngine(t) {
    try {
      if (window.Motion?.seek)          window.Motion.seek(t);
      else if (window.MotionAPI?.seek)  window.MotionAPI.seek(t);
      else syncCSS(t);
    } finally {
      // O editor espera este ack para mandar o próximo SEEK (sem fila acumulada)
      post({ type: 'FRAME_READY', time: t });
    }
  }

  function syncCSS(t) {
    document.getAnimations?.()?.forEach(a => {
      try { a.currentTime = t * 1000; } catch(_){}
    });
  }

  function getDuration() {
    if (window.Motion?.config?.durationInSeconds)  return window.Motion.config.durationInSeconds;
    if (window.MotionAPI?.totalDuration)            return window.MotionAPI.totalDuration;
    return null;
  }

  function tick(ts) {
    if (!playing) return;
    if (lastTs != null) clock += (ts - lastTs) / 1000;
    lastTs = ts;
    const dur = getDuration();
    if (dur != null && clock >= dur) {
      playing = false; lastTs = null;
      seekEngine(dur);
      post({ type: 'END' });
      return;
    }
    seekEngine(clock);
    raf = requestAnimationFrame(tick);
  }

  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || d.__clipId !== CID) return;
    if (d.type === 'SEEK') {
      clock = Math.max(0, d.time);
      lastTs = null;
      seekEngine(clock);
    }
    if (d.type === 'PLAY') {
      if (playing) return;
      playing = true; lastTs = null;
      raf = requestAnimationFrame(tick);
    }
    if (d.type === 'PAUSE') {
      playing = false; lastTs = null;
      cancelAnimationFrame(raf);
    }
  });

  function onReady() {
    const dur = getDuration();
    const fps = window.Motion?.config?.fps || window.MotionAPI?.fps || null;
    if (dur) post({ type: 'CFG', duration: dur, fps });
    post({ type: 'READY' });
  }

  const ready = window.Motion?.whenReady?.() ?? Promise.resolve();
  ready.then(onReady).catch(onReady);

  // Fallback se whenReady não existir
  if (document.readyState === 'complete') onReady();
  else window.addEventListener('load', onReady);
})();
<\/script>`;

  // Injeta antes de </head> ou no início
  return html.includes('</head>')
    ? html.replace('</head>', bridge + '</head>')
    : bridge + html;
}
// #endregion

// #region Compositor — gerencia iframes dos clips

const Compositor = (() => {
  const pool = new Map();

  /*
   * Isolamento de processo: clipes HTML PESADOS carregam de outro site
   * (localhost ↔ 127.0.0.1), então o Chrome os roda em processo próprio e o
   * template não bloqueia cliques/teclado do editor (latência p95 45 ms → 3 ms
   * no teste com efeitos pesados). Clipes leves ficam em srcdoc (um pouco mais
   * rápidos) e textos sempre em srcdoc (o painel edita o DOM ao vivo).
   * localStorage['ms.isolatePreview']: '0' nunca · '1' sempre · vazio = automático.
   */
  let isolateMode = 'auto';
  try { isolateMode = { '0': 'never', '1': 'always' }[localStorage.getItem('ms.isolatePreview')] || 'auto'; } catch (_) {}

  const isolatedHost = (() => {
    if (isolateMode === 'never') return null;
    const host = location.hostname;
    const other = host === 'localhost' ? '127.0.0.1' : host === '127.0.0.1' ? 'localhost' : null;
    return other ? `${location.protocol}//${other}${location.port ? ':' + location.port : ''}` : null;
  })();
  const uploadedHtml = new Map();   // html → Promise<id>

  function uploadPreviewHtml(html) {
    let pending = uploadedHtml.get(html);
    if (!pending) {
      pending = fetch('/api/preview/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      }).then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))).then(d => d.id);
      pending.catch(() => uploadedHtml.delete(html));
      uploadedHtml.set(html, pending);
      if (uploadedHtml.size > 60) uploadedHtml.delete(uploadedHtml.keys().next().value);
    }
    return pending;
  }

  /** Heurística estática: WebGL/canvas, bibliotecas de animação ou muitos efeitos */
  function looksHeavy(html) {
    if (/<canvas|webgl|importmap|three(\.module)?(\.min)?\.js|pixi|gsap|lottie|anime(\.min)?\.js|requestAnimationFrame/i.test(html)) return true;
    const effects = (html.match(/filter\s*:|backdrop-filter|box-shadow|text-shadow|mix-blend-mode|feGaussianBlur|feTurbulence|feDisplacementMap/gi) || []).length;
    return effects >= 12 || html.length > 80000;
  }

  function shouldIsolate(clip) {
    if (!isolatedHost || clip.isText) return false;
    const tmpl = window.__appState?.templates.find(t => t.id === clip.templateId);
    if (tmpl?.type !== 'html') return false;
    if (isolateMode === 'always') return true;
    if (tmpl._heavyPreview == null) tmpl._heavyPreview = looksHeavy(tmpl.html || '');
    return tmpl._heavyPreview;
  }

  let _wrapper = null;
  function wrapper() {
    if (!_wrapper) _wrapper = document.getElementById('previewWrapper');
    return _wrapper;
  }

  // Documento do palco: com o preview numa janela separada (preview-window.js)
  // as mídias nascem lá — vídeo criado no editor e adotado não desenha o
  // quadro parado até dar play
  const stageDoc = () => wrapper()?.ownerDocument || document;

  function mount(clip, html) {
    unmount(clip.id);

    const iframe = stageDoc().createElement('iframe');
    iframe.sandbox = 'allow-scripts allow-same-origin';
    iframe.style.border        = 'none';
    iframe.style.background    = 'transparent';
    iframe.style.display       = 'none';
    iframe.style.pointerEvents = 'none';
    iframe.dataset.clipId      = clip.id;

    wrapper()?.appendChild(iframe);        // ← anexa PRIMEIRO (parent precisa existir)
    applyClipTransformStyle(iframe, clip); // ← agora o wrapper é inserido corretamente

    const entry = { iframe, ready: false, pendingSeek: null, isolated: false };
    pool.set(clip.id, entry);

    const doc = injectClipBridge(html, clip.id);
    if (shouldIsolate(clip)) {
      entry.isolated = true;
      uploadPreviewHtml(doc)
        .then(id => {
          if (pool.get(clip.id) === entry) iframe.src = `${isolatedHost}/preview/clip/${id}`;
        })
        .catch(() => {
          // Servidor sem a rota (ou offline): volta ao modo antigo
          entry.isolated = false;
          if (pool.get(clip.id) === entry) iframe.srcdoc = doc;
        });
    } else {
      iframe.srcdoc = doc;
    }
    return entry;
  }

  /**
   * audioOnly: clip de áudio importado. Usa <audio> (invisível) mas entra como
   * nativeType 'video', então play/seek/volume/fades seguem o mesmo caminho.
   */
  function mountVideo(clip, dataUrl, mimeType, audioOnly = false) {
    unmount(clip.id);
  
    const video = stageDoc().createElement(audioOnly ? 'audio' : 'video');
    video.src         = dataUrl;
    video.preload     = 'metadata';
    video.loop        = false;
    video.playsInline = true;
    video.muted       = false;
    video.style.cssText = 'position:absolute;display:none;background:#000;object-fit:fill;';
    video.dataset.clipId   = clip.id;
    video.dataset.clipType = audioOnly ? 'audio' : 'video';
  
    wrapper()?.appendChild(video);        // anexa antes: o __tx_wrap entra no lugar dele
    _applyElementTransform(video, clip);
  
    const entry = {
      iframe:            video,
      isNative:          true,
      nativeType:        'video',
      audioOnly,
      ready:             false,
      pendingSeek:       null,
      isPlaying:         false,
      isSeeking:         false,
      lastSentSeek:      -1,
      trimStart:         clip.trimStart || 0,
      _transformApplied: true,
    };
    pool.set(clip.id, entry);
  
    video.addEventListener('loadedmetadata', () => {
      const startAt = clip.trimStart || 0;
  
      const markReady = () => {
        entry.ready       = true;
        entry.isSeeking   = false;
        entry.pendingSeek = null;
        entry.lastSentSeek = startAt;
        // Processa qualquer seek que chegou antes do ready
        const state = window.__appState;
        if (state) syncCompositorToTime(state.time);
      };
  
      if (startAt === 0 || Math.abs(video.currentTime - startAt) < 0.05) {
        // Já está na posição certa — não precisa esperar seeked
        markReady();
      } else {
        entry.isSeeking = true;
        video.currentTime = startAt;
        video.addEventListener('seeked', markReady, { once: true });
      }
    }, { once: true });

    entry._userMuted = false;
  
    return entry;
  }

  function mountAudio(clip, dataUrl, mimeType) {
    return mountVideo(clip, dataUrl, mimeType, true);
  }

  // ── NOVO: imagem nativa ───────────────────────────────────
  function mountImage(clip, dataUrl) {
    unmount(clip.id);

    const img = stageDoc().createElement('img');
    img.src           = dataUrl;
    img.style.cssText = 'position:absolute;display:none;object-fit:fill;';
    img.dataset.clipId   = clip.id;
    img.dataset.clipType = 'image';

    wrapper()?.appendChild(img);
    _applyElementTransform(img, clip);

    const entry = {
      iframe:      img,
      isNative:    true,
      nativeType:  'image',
      ready:       true,
      pendingSeek: null,
    };
    pool.set(clip.id, entry);

    return entry;
  }

  function unmount(clipId) {
    const entry = pool.get(clipId);
    if (entry) {
      const el     = entry.iframe;
      const parent = el.parentElement;
      // Remove o wrapper se existir, senão remove o elemento direto
      if (parent?.classList.contains('__tx_wrap')) {
        parent.remove();
      } else {
        el.remove();
      }
      pool.delete(clipId);
    }
  }

  function get(clipId) { return pool.get(clipId) || null; }

  function send(clipId, msg) {
    const entry = pool.get(clipId);
    if (!entry) return;
  
    // ── Elementos nativos (video/image) ──────────────────────
    if (entry.isNative) {
      if (!entry.ready) {
        if (msg.type === 'SEEK') entry.pendingSeek = msg.time;
        return;
      }
  
      const el = entry.iframe;
  
      if (entry.nativeType === 'video') {
        if (msg.type === 'PLAY') {
          if (entry.isPlaying) return;
          entry.isPlaying = true;
          entry.isSeeking = false;
        
          // ── Garante que AudioContext não está suspenso antes de dar play ──
          window.__resumeAudio?.();
        
          el.play().catch(() => {
            el.muted = true;
            entry._userMuted = false;
            el.play().catch(() => {});
          });
        } else if (msg.type === 'PAUSE') {
          entry.isPlaying = false;
          entry.isSeeking = false;
          el.pause();
  
        } else if (msg.type === 'SEEK') {
          // Seek em andamento: guarda só o mais recente e aplica no 'seeked'
          // (antes era descartado e o vídeo parava num quadro antigo após o scrub)
          if (entry.isSeeking) { entry.queuedSeek = msg.time; return; }
        
          const diff = Math.abs((el.currentTime ?? 0) - msg.time);
          if (diff <= 0.08) return; // tolerância mais fina
        
          // ── Se está tocando e o drift é pequeno (<1s), deixa o
          //    motor nativo corrigir sozinho — não interrompe o play ──
          if (entry.isPlaying && diff < 1.0) return;
        
          entry.isSeeking = true;
          entry.lastSentSeek = msg.time;
        
          const wasPlaying = entry.isPlaying;
          if (wasPlaying) el.pause();
        
          el.currentTime = Math.max(0, msg.time);
        
          el.addEventListener('seeked', () => {
            entry.isSeeking = false;
            if (entry.queuedSeek != null) {
              const next = entry.queuedSeek;
              entry.queuedSeek = null;
              send(clipId, { type: 'SEEK', time: next });
            }
            if (wasPlaying && entry.isPlaying) {
              el.play().catch(() => {
                el.muted = true;
                el.play().catch(() => {});
              });
            }
          }, { once: true });
        }
      }
      // Imagem: nenhuma ação
      return;
    }
  
    // ── Iframes HTML: postMessage original ───────────────────
    if (!entry.ready) {
      if (msg.type === 'SEEK') entry.pendingSeek = msg.time;
      return;
    }
    if (msg.type === 'SEEK') {
      // Contrapressão: template ainda desenhando o seek anterior → guarda só o
      // mais recente. Sem isso, templates pesados acumulam uma fila de seeks
      // e o editor inteiro trava. Watchdog de 300 ms para template que não responde.
      const now = performance.now();
      if (entry.seekInFlight && now - entry.seekSentAt < 300) {
        entry.queuedSeek = msg.time;
        return;
      }
      entry.seekInFlight = true;
      entry.seekSentAt   = now;
      entry.queuedSeek   = null;
    }
    try {
      entry.iframe.contentWindow.postMessage({ ...msg, __clipId: clipId }, '*');
    } catch(_) {}
  }

  function show(clipId) {
    const entry = pool.get(clipId);
    if (entry) entry.iframe.style.display = '';
  }

  function hide(clipId) {
    const entry = pool.get(clipId);
    if (entry) entry.iframe.style.display = 'none';
  }

  /** Ack do bridge: libera o próximo SEEK e mede o custo do quadro do template */
  function frameDone(clipId) {
    const entry = pool.get(clipId);
    if (!entry || entry.isNative) return;
    entry.seekInFlight = false;
    entry.frameCost = performance.now() - (entry.seekSentAt || performance.now());

    // Seek caro no mesmo processo: marca o template como pesado — na próxima
    // montagem ele vai para processo próprio
    if (!entry.isolated && entry.frameCost > 0) {
      entry.costEma = entry.costEma == null ? entry.frameCost : entry.costEma * 0.8 + entry.frameCost * 0.2;
      if (entry.costEma > 12) {
        const clip = window.__appState?.clips.find(c => c.id === clipId);
        const tmpl = clip && window.__appState.templates.find(t => t.id === clip.templateId);
        if (tmpl && !clip.isText && tmpl._heavyPreview !== true) {
          tmpl._heavyPreview = true;
          console.info(`[Preview] "${clip.label}" é pesado (${entry.costEma.toFixed(0)} ms/quadro) — será isolado em processo próprio.`);
        }
      }
    }
    if (entry.queuedSeek != null) {
      const next = entry.queuedSeek;
      entry.queuedSeek = null;
      send(clipId, { type: 'SEEK', time: next });
    }
  }

  function markReady(clipId) {
    const entry = pool.get(clipId);
    if (!entry) return;
    entry.ready = true;
    if (entry.pendingSeek !== null) {
      send(clipId, { type: 'SEEK', time: entry.pendingSeek });
      entry.pendingSeek = null;
    }
  }

  function isReady(clipId) { return pool.get(clipId)?.ready === true; }
  function allIds()        { return [...pool.keys()]; }

  // ← mountVideo e mountImage exportados aqui
  return { mount, mountVideo, mountAudio, mountImage, unmount, get, send, show, hide, markReady, frameDone, isReady, allIds };
})();

window.__Compositor = Compositor;
window.__applyClipTransformStyle = applyClipTransformStyle;
window.__applyElementTransform   = _applyElementTransform;
// #endregion

// #region Sincronização compositor ↔ timeline
function syncCompositorToTime(t) {
  const state = window.__appState;

  if (!state?.clips) return;
  reconcileCompositorWindow(
    t,
    1.5
  );

  // Índices montados uma vez por quadro (antes: find() por clip, por quadro)
  const templatesById = new Map(state.templates.map(template => [template.id, template]));
  const hiddenTracks  = new Set((state.tracks || []).filter(track => track.hidden).map(track => track.index));
  // No play, HTML anda no ritmo do preview (fps do projeto ou menos, se adaptativo)
  const playbackFps = state.playing ? previewPlaybackFps() : 0;
  const tails = buildTailMap(state.clips);
  // Câmeras 2D (camera.js): uma vez por quadro; "Ver sem câmera" as ignora só no preview
  const cams = window.__cameraBypass ? [] : (window.ClipKF?.cameras?.() || []);

  state.clips.forEach(clip => {
    const tmpl = templatesById.get(clip.templateId);

    const hidden = hiddenTracks.has(clip.trackIndex ?? 0);

    // Transição do próximo clip: este continua visível por baixo (congelado)
    const tailFx = tails.get(clip.id) || null;
    const inTail = Boolean(tailFx) && t >= clip.start + clip.duration;

    const inRange = Boolean(
      !hidden &&
      t >= clip.start &&
      t < clip.start + clip.duration + (tailFx ? tailFx.duration : 0)
    );

    const entry =
      Compositor.get(clip.id);

    if (inRange) {
      Compositor.show(clip.id);

      if (
        entry &&
        !entry._transformApplied
      ) {
        if (entry.isNative) {
          _applyElementTransform(
            entry.iframe,
            clip
          );
        } else {
          applyClipTransformStyle(
            entry.iframe,
            clip
          );
        }

        entry._transformApplied = true;
        entry._fxKey = null;   // cssText refeito: efeitos precisam ser reaplicados
      }

      if (tmpl?.type !== 'audio') applyClipFx(entry, clip, t, tailFx, cams);

      /*
       * Aqui acontece o time stretch.
       *
       * Quando a opção estiver desligada, retorna
       * o tempo normal do clipe.
       *
       * Quando estiver ligada, retorna o tempo
       * proporcional dentro da animação original.
       */
      const sourceTime =
        mapClipTimeToSource(
          clip,
          t,
          tmpl
        );

      if (
        entry?.isNative &&
        entry.nativeType === 'video'
      ) {
        // Gravando voz com o projeto tocando: preview mudo (não vaza no microfone)
        const gain = window.__previewMuted ? 0 : (window.__clipAudioGain ? window.__clipAudioGain(clip, t) : 1);
        if (Math.abs((entry.iframe.volume ?? 1) - gain) > 0.005) {
          entry.iframe.volume = clamp(gain, 0, 1);
        }
        const rate = state.playing ? (window.__playRate || 1) : 1;
        if (entry.iframe.playbackRate !== rate) entry.iframe.playbackRate = rate;

        if (state.playing && inTail) {
          if (entry.isPlaying) Compositor.send(clip.id, { type: 'PAUSE' });
          Compositor.send(clip.id, { type: 'SEEK', time: sourceTime });
        } else if (state.playing) {
          if (!entry.isPlaying) {
            const currentTime =
              entry.iframe.currentTime ?? 0;

            const difference = Math.abs(
              currentTime - sourceTime
            );

            if (difference > 0.15) {
              Compositor.send(
                clip.id,
                {
                  type: 'SEEK',
                  time: sourceTime,
                }
              );
            }

            Compositor.send(
              clip.id,
              { type: 'PLAY' }
            );
          } else if (entry.ready && !entry.isSeeking) {
            // Deriva: o elemento começou atrasado (saída de áudio acordando,
            // buffer) ou engasgou. Ressincroniza no máximo 1×/s.
            const drift = (entry.iframe.currentTime ?? 0) - sourceTime;
            const now = performance.now();
            if (Math.abs(drift) > 0.25 && now - (entry._lastResync || 0) > 1000) {
              entry._lastResync = now;
              entry.iframe.currentTime = sourceTime + 0.05;
            }
          }
        } else {
          Compositor.send(
            clip.id,
            {
              type: 'SEEK',
              time: sourceTime,
            }
          );
        }
      } else if (
        entry &&
        !entry.isNative
      ) {
        // Tocando: quantiza ao quadro do preview — um monitor de 60 Hz com
        // projeto a 30 fps não precisa redesenhar o template 2× por quadro
        const seekTime = playbackFps
          ? Math.floor(sourceTime * playbackFps + 1e-6) / playbackFps
          : sourceTime;

        if (
          entry._lastSeekSent === undefined ||
          Math.abs(
            entry._lastSeekSent -
              seekTime
          ) > 0.0005
        ) {
          entry._lastSeekSent = seekTime;

          Compositor.send(
            clip.id,
            {
              type: 'SEEK',
              time: seekTime,
            }
          );
        }
      }
    } else {
      Compositor.hide(clip.id);

      if (entry) {
        entry._transformApplied = false;
      }

      if (
        entry?.isNative &&
        entry.nativeType === 'video'
      ) {
        // Pré-roll: o clip seguinte (ex.: a outra metade de um corte) começa a tocar, mudo,
        // um instante ANTES do ponto de corte. play() de um elemento parado leva dezenas de ms
        // para sair som — era essa a pausa audível entre dois clips colados.
        const lead = clip.start - t;
        if (state.playing && !hidden && lead > 0 && lead <= AUDIO_PREROLL_S) {
          prerollNativeMedia(entry, clip, t, tmpl);
        } else {
          entry._prerolling = false;
          Compositor.send(
            clip.id,
            { type: 'PAUSE' }
          );
        }
      }
    }
  });
}

/** Segundos antes do começo de um clip de áudio/vídeo em que ele já toca (mudo) */
const AUDIO_PREROLL_S = 0.3;

function prerollNativeMedia(entry, clip, t, tmpl) {
  // Posição da fonte no instante t (antes do início: trimStart menos o que falta, sem passar de 0)
  const sourceTime = (Number(clip.trimStart) || 0) + (t - clip.start);
  if (sourceTime < 0) {
    // Clip que começa no 0 da mídia: não há "antes" para tocar; só começa na hora
    Compositor.send(clip.id, { type: 'PAUSE' });
    return;
  }
  entry._prerolling = true;
  if (entry.iframe.volume !== 0) entry.iframe.volume = 0;
  if (!entry.isPlaying) {
    entry._prerollFixed = false;
    Compositor.send(clip.id, { type: 'SEEK', time: sourceTime });
    Compositor.send(clip.id, { type: 'PLAY' });
  } else if (!entry._prerollFixed && !entry.isSeeking && clip.start - t <= 0.16) {
    // O play() demora a engatar e o elemento anda atrasado (~0,1 s): um ajuste fino, ainda mudo,
    // um pouco antes do corte para o som entrar exatamente no ponto
    entry._prerollFixed = true;
    if (Math.abs((entry.iframe.currentTime ?? 0) - sourceTime) > 0.02) entry.iframe.currentTime = sourceTime + 0.03;
  }
}

window.__syncCompositorToTime = syncCompositorToTime;

/**
 * clipId → tailFx. Um clip com transição de entrada "entre clips" faz o clip
 * anterior da mesma track (encostado nele) continuar visível por baixo
 * durante a transição, congelado no último quadro. export.js usa a mesma regra.
 */
function buildTailMap(clips) {
  const map = new Map();
  if (!window.ClipFX) return map;
  clips.forEach(clip => {
    const transition = clip.fx?.transition;
    if (!ClipFX.active(transition)) return;
    const track = Number(clip.trackIndex) || 0;
    const prev = clips.find(other => other !== clip &&
      (Number(other.trackIndex) || 0) === track &&
      Math.abs(other.start + other.duration - clip.start) < 0.05);
    if (prev) {
      map.set(prev.id, {
        type: transition.type,
        duration: Math.min(Number(transition.duration), clip.duration),
      });
    }
  });
  return map;
}
window.__buildTailMap = buildTailMap;

/** Reaplica efeitos depois de a caixa do clip ser reescrita (arrastar no preview) */
window.__reapplyClipFx = clipId => {
  const clip = state.clips.find(c => c.id === clipId);
  const entry = Compositor.get(clipId);
  if (!clip || !entry) return;
  entry._fxKey = null;
  const cams = window.__cameraBypass ? [] : (window.ClipKF?.cameras?.() || []);
  applyClipFx(entry, clip, state.time, buildTailMap(state.clips).get(clipId) || null, cams);
};

/** Efeitos/transições do clip no tempo t, aplicados na caixa (.__tx_wrap) */
function applyClipFx(entry, clip, t, tailFx, cams = null) {
  const wrap = entry?.iframe?.parentElement;
  if (!wrap?.classList.contains('__tx_wrap') || !window.ClipFX) return;
  const anim = window.ClipKF?.hasAnim(clip) ? window.ClipKF.styleInput(clip) : null;
  // Câmera 2D, modo de mesclagem e camada de ajuste (keyframes.js: fxExtras)
  const extras = window.ClipKF ? window.ClipKF.fxExtras(clip, cams) : {};
  const fx = (clip.fx || tailFx || anim || extras.cams || extras.blend || extras.adj)
    ? ClipFX.style({ start: clip.start, duration: clip.duration, fx: clip.fx, tailFx, ...(anim || {}), ...extras }, t)
    : null;
  const rotate = `rotate(${fx?.rotation != null ? fx.rotation : (Number(clip._tx?.r) || 0)}deg)`;
  const transform = fx?.transform ? `${fx.transform} ${rotate}` : rotate;
  const zIndex = ((clip.trackIndex ?? 0) + 1) * 2 + (fx?.front ? 1 : 0);
  const opacity = fx ? fx.opacity : 1;
  const key = `${opacity}|${fx?.filter || ''}|${transform}|${fx?.clipPath || ''}|${zIndex}|${fx?.blend || ''}|${fx?.backdropFilter || ''}`;
  if (entry._fxKey === key) return;
  entry._fxKey = key;
  wrap.style.opacity   = opacity === 1 ? '' : String(opacity);
  wrap.style.filter    = fx?.filter || '';
  wrap.style.transform = transform;
  wrap.style.clipPath  = fx?.clipPath || '';
  wrap.style.zIndex    = String(zIndex);
  wrap.style.mixBlendMode = fx?.blend || '';
  // Camada de ajuste: o filtro vai no fundo (backdrop-filter), sobre o que está embaixo dela
  wrap.style.backdropFilter = fx?.backdropFilter || '';
  wrap.style.webkitBackdropFilter = fx?.backdropFilter || '';
}
// #endregion

// #region Mensagens dos iframes → app
window.addEventListener('message', e => {
  const d = e.data;
  if (!d?.type) return;

  // ── __TEXT_SIZE vem sem __clipId — tratado separadamente ──
  // ── __TEXT_SIZE vem sem __clipId — tratado separadamente ──
  if (d.type === '__TEXT_SIZE') {
    // Texto é tratado como clip fullscreen — _tx não é alterado pelo tamanho do elemento.
    // Só reaplicamos o transform caso o clip tenha sido restaurado por undo (_txLocked).
    const clipId = d.clipId;
    if (!clipId) return;
  
    const clip = window.__appState?.clips?.find(c => c.id === clipId);
    if (!clip) return;
  
    if (clip._txLocked) {
      clip._txLocked = false;
      const entry = window.__Compositor?.get(clipId);
      if (entry?.iframe) window.__applyClipTransformStyle?.(entry.iframe, clip);
      if (window.__appState?.currentClipId === clipId) {
        window.__applyClipTransform?.(clipId, clip._tx);
      }
    }
    return;
  }

  // ── Mensagens normais dos iframes (precisam de __clipId) ──
  if (!d.__clipId) return;
  const clipId = d.__clipId;

  if (d.type === 'FRAME_READY') {
    Compositor.frameDone(clipId);
    return;
  }

  if (d.type === 'READY') {
    Compositor.markReady(clipId);
    const state = window.__appState;
    if (state) syncCompositorToTime(state.time);
  }

  if (d.type === 'CFG' && d.duration) {
    const state = window.__appState;
    const clip  = state?.clips.find(c => c.id === clipId);
    if (clip) {
      const tmpl = state.templates.find(t => t.id === clip.templateId);
      if (tmpl) {
        tmpl.sourceDuration = d.duration;
        if (d.fps) tmpl.fps = d.fps;
        window.__renderProps?.();
      }
    }
  }
});
// #endregion

// #region Montagem inicial dos clips

window.mountAllClips =
  function mountAllClips() {
    const state =
      window.__appState;

    if (!state) return;

    reconcileCompositorWindow(
      state.time,
      1.5
    );

    window
      .__syncCompositorToTime
      ?.(state.time);
  };

window.remountClip = function remountClip(clipId) {
  const state = window.__appState;
  const clip  = state?.clips.find(c => c.id === clipId);
  if (!clip) return;
  const tmpl = state.templates.find(t => t.id === clip.templateId);
  if (!tmpl) return;

  if (tmpl.type === 'video') {
    Compositor.mountVideo(clip, tmpl.dataUrl, tmpl.mimeType);
  } else if (tmpl.type === 'audio') {
    Compositor.mountAudio(clip, tmpl.dataUrl, tmpl.mimeType);
  } else if (tmpl.type === 'image') {
    Compositor.mountImage(clip, tmpl.dataUrl);
  } else {
    Compositor.mount(clip, tmpl.html);
  }
};
// #endregion

// #region Playback Engine
let _rafId = null;
let _rafHost = window;

/**
 * Janela que dirige o play: com o preview numa janela separada (outro
 * monitor), os quadros vêm dela — o editor coberto/minimizado não trava o play.
 */
function playbackRafHost() {
  const win = window.__previewWindow;
  return win && !win.closed ? win : window;
}
let _lastTs = null;

/**
 * Preview adaptativo: se o editor não sustenta o fps do projeto (templates
 * pesados), os clipes HTML passam a ser redesenhados a um fps menor — o vídeo
 * pula quadros em vez de travar a interface (como em editores profissionais).
 * Pausado/scrub sempre mostra o quadro exato.
 */
const _previewPerf = { cap: null, ema: 16.7, ticks: 0 };

function previewPlaybackFps() {
  const projectFps = window.__appState?.project?.fps || DEFAULT_FPS;
  if (_previewPerf.cap == null || _previewPerf.cap > projectFps) _previewPerf.cap = projectFps;
  return _previewPerf.cap;
}

function trackPreviewPerformance(frameMs) {
  const projectFps = window.__appState?.project?.fps || DEFAULT_FPS;
  _previewPerf.ema = _previewPerf.ema * 0.9 + Math.min(frameMs, 250) * 0.1;
  if (++_previewPerf.ticks % 20 !== 0) return;

  const cap = previewPlaybackFps();
  let next = cap;
  if (_previewPerf.ema > 34 && cap > 10)            next = Math.max(10, Math.round(cap * 0.75));
  else if (_previewPerf.ema < 21 && cap < projectFps) next = Math.min(projectFps, cap + 3);
  if (next === cap) return;

  _previewPerf.cap = next;
  const fpsEl = document.getElementById('previewFps');
  if (fpsEl) {
    fpsEl.textContent = next < projectFps ? `▶ ${next}/${projectFps} fps (adaptativo)` : `${projectFps} fps`;
    fpsEl.title = next < projectFps
      ? 'O preview está pulando quadros para não travar. O export sempre sai com todos os quadros.'
      : '';
  }
}

function _play() {
  const state = window.__appState;
  if (!state?.project || state.playing) return;
  if (state.time >= state.project.totalDuration) seekTo(0);

  state.playing       = true;
  state.lastTimestamp = null;
  _previewPerf.cap    = null;   // reavalia: começa no fps do projeto
  _previewPerf.ema    = 16.7;

  document.getElementById('iconPlay').style.display  = 'none';
  document.getElementById('iconPause').style.display = '';

  state.clips.forEach(clip => {
    const inRange = state.time >= clip.start && state.time < clip.start + clip.duration;
    if (!inRange) return;

    const entry = Compositor.get(clip.id);

    // ── Só vídeos nativos recebem PLAY. Iframes HTML são dirigidos
    //    exclusivamente por SEEK dentro do _scheduleTick (determinístico). ──
    if (entry?.isNative && entry.nativeType === 'video') {
      const relTime = (state.time - clip.start) + (clip.trimStart || 0);
      const diff = Math.abs((entry.iframe.currentTime ?? 0) - relTime);
      if (diff > 0.15) {
        entry.iframe.currentTime = relTime;
        entry.iframe.addEventListener('seeked', () => {
          Compositor.send(clip.id, { type: 'PLAY' });
        }, { once: true });
      } else {
        Compositor.send(clip.id, { type: 'PLAY' });
      }
    }
  });

  _scheduleTick();
}

function _pause() {
  const state = window.__appState;
  if (!state) return;
  state.playing = false;
  window.__playRate = 1;

  document.getElementById('iconPlay').style.display  = '';
  document.getElementById('iconPause').style.display = 'none';

  try { _rafHost.cancelAnimationFrame(_rafId); } catch (_) { /* janela fechada */ }
  _lastTs = null;

  // Pausa todos os iframes
  Compositor.allIds().forEach(id => Compositor.send(id, { type: 'PAUSE' }));

  // No play o HTML anda em quadros quantizados; pausado mostra o tempo exato
  syncCompositorToTime(state.time);
}

function _scheduleTick() {
  _rafHost = playbackRafHost();
  _rafId = _rafHost.requestAnimationFrame(ts => {
    const state = window.__appState;
    if (!state?.playing) return;

    if (_lastTs != null) {
      state.time += (ts - _lastTs) / 1000 * (window.__playRate || 1);
      trackPreviewPerformance(ts - _lastTs);
    }
    _lastTs = ts;

    const dur = state.project?.totalDuration || 0;
    if (state.time >= dur) {
      state.time = dur;
      _pause();
      window.__updatePlayhead?.(state.time);
      return;
    }

    // Atualiza todos os iframes com o novo tempo
    syncCompositorToTime(state.time);
    window.__updatePlayhead?.(state.time);
    followPlayhead(state.time);

    _scheduleTick();
  });
}

/** Durante o play, rola a timeline quando o playhead chega perto da borda direita */
function followPlayhead(t) {
  const el = document.getElementById('tlScroll');
  if (!el || state.seeking || _moveData || _trimData) return;
  const x = t * (window.__PX_PER_SEC ?? 80) * (state.zoom ?? 1);
  const w = el.clientWidth;
  if (x > el.scrollLeft + w * 0.92 || x < el.scrollLeft) {
    el.scrollLeft = Math.max(0, x - w * 0.08);
  }
}

window.togglePlay = function togglePlay() {
  window.__appState?.playing ? _pause() : _play();
};

window.seekTo = function seekTo(t) {
  const state = window.__appState;
  if (!state?.project) return;

  const wasPlaying = state.playing === true;

  // Para o loop RAF atual para evitar que sobrescreva o novo tempo
  if (wasPlaying) {
    state.playing = false;
    try { _rafHost.cancelAnimationFrame(_rafId); } catch (_) { /* janela fechada */ }
    _lastTs = null;
    // PAUSE só afeta vídeos nativos de fato; para iframes é inofensivo
    Compositor.allIds().forEach(id => Compositor.send(id, { type: 'PAUSE' }));
  }

  state.time = Math.max(0, Math.min(t, state.project.totalDuration));
  window.__updatePlayhead?.(state.time);
  syncCompositorToTime(state.time);

  // Auto-scroll da timeline
  const tlEl = document.getElementById('tlScroll');
  if (tlEl) {
    const zoom     = state.zoom ?? 1;
    const pxPerSec = window.__PX_PER_SEC ?? 80;
    const x  = state.time * pxPerSec * zoom;
    const sw = tlEl.clientWidth;
    if (x < tlEl.scrollLeft || x > tlEl.scrollLeft + sw - 40) {
      tlEl.scrollLeft = Math.max(0, x - sw / 3);
    }
  }

  // Retoma play a partir do novo tempo
  if (wasPlaying) {
    state.playing = true;
    state.lastTimestamp = null;

    // ── Só vídeos nativos precisam de PLAY. HTML volta a ser
    //    alimentado por SEEK no _scheduleTick. ──
    state.clips.forEach(clip => {
      const inRange = state.time >= clip.start && state.time < clip.start + clip.duration;
      if (!inRange) return;
      const entry = Compositor.get(clip.id);
      if (entry?.isNative && entry.nativeType === 'video') {
        const relTime = (state.time - clip.start) + (clip.trimStart || 0);
        entry.iframe.currentTime = Math.max(0, relTime);
        entry.iframe.addEventListener('seeked', () => {
          Compositor.send(clip.id, { type: 'PLAY' });
        }, { once: true });
      }
    });

    _scheduleTick();
  }
};
// #endregion


// #region Preview — Zoom Automático
function syncPreviewSize() {
  const wrapper = document.getElementById('previewWrapper');
  const outer   = document.getElementById('previewOuter');
  const previewCont = document.getElementById('previewContainer');
  if (!wrapper || !outer || !previewCont) return;

  const state = window.__appState;
  const res   = state?.project?.res || { w: 1080, h: 1920 };

  const topBar  = document.getElementById('previewTopBar');
  const infoBar = document.getElementById('previewInfo');
  const topH    = (topBar?.offsetHeight  || 32) + (infoBar?.offsetHeight || 24);
  // Preview numa janela separada: encaixa no tamanho dela (sem o zoom do editor)
  const host    = window.__previewHostSize?.();
  const maxH    = host ? host.h : Math.max(80, previewCont.clientHeight - topH - 40);
  const maxW    = host ? host.w : Math.max(80, previewCont.clientWidth  - 40);

  const fitScale = Math.min(maxH / res.h, maxW / res.w);
  const s = Math.min(Math.max(fitScale * (host ? 1 : (state?.previewZoom ?? 1)), 0.05), 8);

  wrapper.style.width           = res.w + 'px';
  wrapper.style.height          = res.h + 'px';
  wrapper.style.transform       = `scale(${s})`;
  wrapper.style.transformOrigin = 'top center';

  outer.style.width  = (res.w * s) + 'px';
  outer.style.height = (res.h * s) + 'px';

  const pzLabel = document.getElementById('previewZoomLabel');
  if (pzLabel) pzLabel.textContent = Math.round(s * 100) + '%';

  const sizeEl = document.getElementById('previewSize');
  const fpsEl  = document.getElementById('previewFps');
  if (sizeEl) sizeEl.textContent = `${res.w} × ${res.h}`;
  if (fpsEl && state?.project) fpsEl.textContent = `${state.project.fps} fps`;
}
window.__syncPreviewSize = syncPreviewSize;
window.addEventListener('resize', syncPreviewSize);

document.getElementById('btnPreviewZoomIn')?.addEventListener('click', () => {
  const s = window.__appState;
  if (s) { s.previewZoom = Math.min((s.previewZoom ?? 1) * 1.25, 4); syncPreviewSize(); }
});
document.getElementById('btnPreviewZoomOut')?.addEventListener('click', () => {
  const s = window.__appState;
  if (s) { s.previewZoom = Math.max((s.previewZoom ?? 1) / 1.25, 0.1); syncPreviewSize(); }
});
document.getElementById('btnPreviewZoomFit')?.addEventListener('click', () => {
  const s = window.__appState;
  if (s) { s.previewZoom = 1; syncPreviewSize(); }
});
// #endregion

// #region Zoom Vertical das Tracks
function applyTrackZoom(z) {
  const s = window.__appState;
  if (!s) return;
  s.trackZoom = Math.min(Math.max(z, 0.4), 3);
  const label = document.getElementById('trackZoomLabel');
  if (label) label.textContent = Math.round(s.trackZoom * 100) + '%';
  window.__renderTimeline?.();
}
window.__applyTrackZoom = applyTrackZoom;

// Botões +/− da altura ficam no index.html (junto do slider). Antes havia
// handler aqui também e cada clique aplicava o zoom duas vezes (×1.69).
// #endregion

// #region Hierarquia de Tracks
function ensureTracksState() {
  if (!Array.isArray(state.tracks)) {
    state.tracks = [];
  }

  if (!state.tracks.length) {
    state.tracks.push(createTrack(0));
  }

  const usedIndexes = new Set(state.clips.map(c => Number(c.trackIndex) || 0));

  usedIndexes.forEach(trackIndex => {
    if (!state.tracks.some(t => t.index === trackIndex)) {
      state.tracks.push(createTrack(trackIndex));
    }
  });

  state.tracks.sort((a, b) => b.index - a.index);
}

function createTrack(index) {
  return {
    id: 'track_' + index,
    index,
    name: `V${index + 1}`,
    type: 'video',
    hidden: false,
    locked: false,
    muted: false,
    solo: false,
    color: SCENE_COLORS[index % SCENE_COLORS.length],
  };
}

function getTrackIndexes() {
  ensureTracksState();

  const indexes = new Set();

  state.tracks.forEach(t => indexes.add(t.index));
  state.clips.forEach(c => indexes.add(Number(c.trackIndex) || 0));

  return [...indexes].sort((a, b) => b - a);
}

function getTrack(trackIndex) {
  ensureTracksState();

  let track = state.tracks.find(t => t.index === trackIndex);

  if (!track) {
    track = createTrack(trackIndex);
    state.tracks.push(track);
    state.tracks.sort((a, b) => b.index - a.index);
  }

  return track;
}

function nextTrackIndex() {
  const indexes = getTrackIndexes();
  return indexes.length ? Math.max(...indexes) + 1 : 0;
}

window.addTrack = () => {
  ensureTracksState();

  const index = nextTrackIndex();
  state.tracks.push(createTrack(index));
  state.tracks.sort((a, b) => b.index - a.index);

  renderTimeline();
  renderProjectSettings();
};

window.toggleTrackHidden = trackIndex => {
  const track = getTrack(Number(trackIndex));
  track.hidden = !track.hidden;

  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  window.__syncCompositorToTime?.(state.time);
};

window.toggleTrackLocked = trackIndex => {
  const track = getTrack(Number(trackIndex));
  track.locked = !track.locked;

  renderTimeline();
  renderProjectSettings();
};

window.toggleTrackMuted = trackIndex => {
  tlPushUndo();
  const track = getTrack(Number(trackIndex));
  track.muted = !track.muted;
  renderTimeline();
  window.__syncCompositorToTime?.(state.time);
};

window.toggleTrackSolo = trackIndex => {
  tlPushUndo();
  const track = getTrack(Number(trackIndex));
  track.solo = !track.solo;
  renderTimeline();
  window.__syncCompositorToTime?.(state.time);
};

window.renameTrack = (trackIndex, name) => {
  const track = getTrack(Number(trackIndex));
  track.name = String(name || '').trim() || `V${track.index + 1}`;

  renderTimeline();
  renderProjectSettings();
};

window.deleteTrack = trackIndex => {
  trackIndex = Number(trackIndex);

  const hasClips = state.clips.some(c => (Number(c.trackIndex) || 0) === trackIndex);

  if (hasClips) {
    window.MSUI.notify('Esta track possui clips. Mova ou exclua os clips antes de apagar a track.');
    return;
  }

  state.tracks = state.tracks.filter(t => t.index !== trackIndex);
  if (state.selectedTrack === trackIndex) state.selectedTrack = null;

  if (!state.tracks.length) {
    state.tracks.push(createTrack(0));
  }

  renderTimeline();
  renderProjectSettings();
};

window.moveClipToTrack = (clipId, trackIndex) => {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  trackIndex = Math.max(0, Number(trackIndex) || 0);

  const track = getTrack(trackIndex);
  if (track.locked) return;

  clip.trackIndex = trackIndex;

  const e = window.__Compositor?.get(clipId);   // ← NOVO
if (e) e._transformApplied = false;            // ← NOVO

syncProjectGlobals();
renderTimeline();
  renderProjectSettings();
  window.__syncCompositorToTime?.(state.time);
};

window.moveClipTrackDelta = (clipId, delta) => {
  const clip = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  const next = Math.max(0, (Number(clip.trackIndex) || 0) + Number(delta || 0));
  window.moveClipToTrack(clipId, next);
};
// #endregion

// #region Seleção de track
/**
 * Track ativa (state.selectedTrack): clicar no nome da track, numa área
 * vazia dela ou num clip dela. Cortar e apagar agem só nos clips dessa
 * track quando não há clip selecionado — antes iam para a track de cima.
 */
function selectTrack(trackIndex) {
  const next = trackIndex == null || !Number.isFinite(Number(trackIndex)) ? null : Number(trackIndex);
  if (state.selectedTrack === next) return;
  state.selectedTrack = next;
  markSelectedTrack();
  renderProjectSettings();   // painel da track (áudio/dB) à direita
}
window.selectTrack = selectTrack;

function markSelectedTrack() {
  tlLabels.querySelectorAll('.tl-label[data-track]').forEach(el => {
    el.classList.toggle('tl-label-selected', Number(el.dataset.track) === state.selectedTrack);
  });
  tlTracks.querySelectorAll('.tl-row[data-track]').forEach(el => {
    el.classList.toggle('tl-row-selected', Number(el.dataset.track) === state.selectedTrack);
  });
}

/** Clip da track ativa sob o playhead (alvo de cortar/apagar sem clip selecionado) */
function selectedTrackClipAt(time = state.time) {
  if (state.selectedTrack == null) return null;
  return state.clips.find(c =>
    (Number(c.trackIndex) || 0) === state.selectedTrack &&
    time >= c.start && time < c.start + c.duration) || null;
}
// #endregion

// #region Timeline — Renderização
function tlWidth() {
  const total = state.project?.totalDuration || 10;
  return Math.max(800, total * PX_PER_SEC * state.zoom + 200);
}

function trackRowHeight() {
  return Math.round(TRACK_HEIGHT * state.trackZoom);
}

function renderTimeline() {
  if (!state.project) return;
  const tracks   = getTrackIndexes();
  const W        = tlWidth();
  const fps      = state.project.fps || DEFAULT_FPS;
  const rowH     = trackRowHeight();
  const pxPerSec = PX_PER_SEC * state.zoom;
  const [t0, t1] = visibleTimeWindow(pxPerSec);

  _tlRenderedWindow = { left: tlScroll.scrollLeft, zoom: state.zoom };

  renderRuler(W, pxPerSec, fps, t0, t1);

  // ── Labels das tracks ───────────────────────────────────
  tlLabels.innerHTML = '<div class="tl-ruler-corner"><span>Tracks</span></div>';
  const effectiveTracks = tracks.length ? tracks : [0];
  const hasSolo = state.tracks.some(t => t.solo);

  effectiveTracks.forEach(ti => {
    const track = getTrack(ti);
    const el    = document.createElement('div');
    el.className    = 'tl-label' + (hasSolo && !track.solo ? ' tl-label-dimmed' : '');
    el.style.height = rowH + 'px';
    el.dataset.track = ti;

    const firstClip = state.clips.find(c => (Number(c.trackIndex)||0) === ti);
    const dotColor  = firstClip?.color || track.color || 'var(--text-muted)';
    const name      = escapeHtml(track.name);

    el.innerHTML = `
      <div class="tl-label-inner">
        <span class="tl-label-dot" style="background:${escapeHtml(dotColor)}"></span>
        <span class="tl-label-name" title="${name}">${name}</span>
        <div class="tl-label-actions">
          <button class="tl-track-btn tl-track-vis${track.hidden ? ' active' : ''}"
            data-track="${ti}" title="${track.hidden ? 'Mostrar' : 'Ocultar'}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${track.hidden
                ? '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
                : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}
            </svg>
          </button>
          <button class="tl-track-btn tl-track-mute${track.muted ? ' active' : ''}"
            data-track="${ti}" title="${track.muted ? 'Ativar áudio' : 'Silenciar track'}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              ${track.muted
                ? '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
                : '<path d="M15.54 8.46a5 5 0 010 7.07"/>'}
            </svg>
          </button>
          <button class="tl-track-btn tl-track-solo${track.solo ? ' active' : ''}"
            data-track="${ti}" title="${track.solo ? 'Desativar solo' : 'Solo (ouvir só esta track)'}">S</button>
          <button class="tl-track-btn tl-track-lock${track.locked ? ' active' : ''}"
            data-track="${ti}" title="${track.locked ? 'Desbloquear' : 'Bloquear'}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${track.locked
                ? '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'
                : '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/>'}
            </svg>
          </button>
          <button class="tl-track-btn tl-track-del" data-track="${ti}" title="Remover track">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    tlLabels.appendChild(el);
  });

  const addTrackBtn = document.createElement('div');
  addTrackBtn.className = 'tl-label tl-add-track-btn';
  addTrackBtn.innerHTML = `
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    Track
  `;
  addTrackBtn.title = 'Adicionar nova track';
  tlLabels.appendChild(addTrackBtn);

  // ── Blocos de clip (só os visíveis + selecionados) ─────
  tlTracks.style.width = W + 'px';
  tlTracks.innerHTML   = '';

  const selected = getSelectedIds();
  const byTrack  = new Map();
  state.clips.forEach(clip => {
    const ti = Number(clip.trackIndex) || 0;
    const visible = clip.start <= t1 && clip.start + clip.duration >= t0;
    if (!visible && !selected.has(clip.id)) return;
    if (!byTrack.has(ti)) byTrack.set(ti, []);
    byTrack.get(ti).push(clip);
  });

  const fragment = document.createDocumentFragment();

  effectiveTracks.forEach((ti, rowIndex) => {
    const track = getTrack(ti);
    const row   = document.createElement('div');
    row.className    = 'tl-row'
      + (track.hidden ? ' tl-row-hidden' : '')
      + (track.locked ? ' tl-row-locked' : '');
    row.style.height  = rowH + 'px';
    row.dataset.track = ti;
    if (rowIndex % 2 === 1) row.classList.add('tl-row-alt');

    (byTrack.get(ti) || []).forEach(clip => {
      row.appendChild(buildClipBlock(clip, track, rowH, pxPerSec, selected));
    });

    fragment.appendChild(row);
  });

  // Zona nova track
  const newTrackZone = document.createElement('div');
  newTrackZone.className = 'tl-new-track-zone';
  newTrackZone.dataset.newTrack = 'true';
  newTrackZone.innerHTML = `<span>+ Soltar aqui para criar nova track</span>`;
  fragment.appendChild(newTrackZone);

  tlTracks.appendChild(fragment);

  tlPlayhead.style.height = (24 + effectiveTracks.length * rowH) + 'px';
  updatePlayhead(state.time);
  markSelectedTrack();
  window.__renderMarkers?.();
}

function buildClipBlock(clip, track, rowH, pxPerSec, selected) {
  const tmpl  = state.templates.find(t => t.id === clip.templateId);
  const block = document.createElement('div');
  block.className = 'tl-block'
    + (selected.has(clip.id) || clip.id === state.currentClipId ? ' tl-selected' : '')
    + (clip.isText ? ' tl-block-text' : '')
    + (tmpl?.type === 'video' ? ' tl-block-video' : '')
    + (tmpl?.type === 'audio' ? ' tl-block-audio' : '');
  block.style.left   = (clip.start * pxPerSec) + 'px';
  block.style.width  = Math.max(4, clip.duration * pxPerSec - 1) + 'px';
  block.style.height = rowH + 'px';
  block.dataset.clipId = clip.id;
  block.title = `${clip.label}  ${fmtTime(clip.start)} → ${fmtTime(clip.start + clip.duration)}`;
  block.style.setProperty('--clip-color', clip.color || 'var(--accent)');

  if (track.hidden) block.style.opacity = '0.35';
  if (track.locked) block.classList.add('tl-block-locked');

  const badges = [
    clip.captionGroupId ? '<span class="tl-badge" title="Legenda">CC</span>' : '',
    clip.muted || (Number(clip.volume ?? 1) === 0) ? '<span class="tl-badge" title="Sem áudio">🔇</span>' : '',
    (clip.fadeIn > 0 || clip.fadeOut > 0) ? '<span class="tl-badge" title="Fade de áudio">◢◣</span>' : '',
    window.ClipFX?.anyFx(clip.fx) ? '<span class="tl-badge tl-badge-fx" title="Efeitos aplicados">FX</span>' : '',
    window.ClipKF?.has(clip) ? '<span class="tl-badge tl-badge-kf" title="Keyframes">◆</span>' : '',
    window.ClipKF?.layerKind(clip) === 'camera' ? '<span class="tl-badge tl-badge-cam" title="Câmera 2D: move o que está abaixo">CAM</span>' : '',
    window.ClipKF?.layerKind(clip) === 'adjustment' ? '<span class="tl-badge tl-badge-adj" title="Camada de ajuste: filtra tudo que está abaixo">AJ</span>' : '',
  ].join('');

  block.innerHTML = `
    <div class="tl-block-media"></div>
    <div class="tl-resize-handle tl-resize-left"></div>
    <div class="tl-block-meta">
      <span class="tl-block-label">${badges}${escapeHtml(clip.label)}</span>
      <span class="tl-block-dur">${fmtTime(clip.duration)}</span>
    </div>
    <div class="tl-resize-handle tl-resize-right"></div>
  `;

  // Miniaturas / forma de onda (timeline-pro.js) e marcas de transição (fx-panel.js)
  window.__decorateClipBlock?.(block, clip, tmpl, pxPerSec);
  window.__decorateFxBlock?.(block, clip, pxPerSec);
  window.__decorateKfBlock?.(block, clip, tmpl, pxPerSec);
  return block;
}

/** Atualiza posição/tamanho de um bloco sem re-renderizar a timeline */
function refreshClipBlock(clipId) {
  const clip  = state.clips.find(c => c.id === clipId);
  const block = tlTracks.querySelector(`.tl-block[data-clip-id="${clipId}"]`);
  if (!clip || !block) return;
  const pxPerSec = PX_PER_SEC * state.zoom;
  block.style.left  = (clip.start * pxPerSec) + 'px';
  block.style.width = Math.max(4, clip.duration * pxPerSec - 1) + 'px';
  const dur = block.querySelector('.tl-block-dur');
  if (dur) dur.textContent = fmtTime(clip.duration);
  const tmpl = state.templates.find(t => t.id === clip.templateId);
  window.__decorateClipBlock?.(block, clip, tmpl, pxPerSec);
  window.__decorateFxBlock?.(block, clip, pxPerSec);
  window.__decorateKfBlock?.(block, clip, tmpl, pxPerSec);
  // Selos FX e keyframes acompanham o que foi aplicado/removido
  const label = block.querySelector('.tl-block-label');
  [
    ['tl-badge-fx', Boolean(window.ClipFX?.anyFx(clip.fx)), '<span class="tl-badge tl-badge-fx" title="Efeitos aplicados">FX</span>'],
    ['tl-badge-kf', Boolean(window.ClipKF?.has(clip)), '<span class="tl-badge tl-badge-kf" title="Keyframes">◆</span>'],
  ].forEach(([cls, on, html]) => {
    const badge = label?.querySelector('.' + cls);
    if (label && on && !badge) label.insertAdjacentHTML('afterbegin', html);
    if (badge && !on) badge.remove();
  });
}

function updateTimelineWidth() {
  const W = tlWidth() + 'px';
  if (tlTracks.style.width !== W) {
    tlTracks.style.width = W;
    tlRuler.style.width  = W;
  }
}

/** Intervalo de tempo visível ± uma tela de margem para cada lado */
function visibleTimeWindow(pxPerSec) {
  const width  = tlScroll.clientWidth || 1200;
  const left   = tlScroll.scrollLeft;
  return [
    Math.max(0, (left - width) / pxPerSec),
    (left + width * 2) / pxPerSec,
  ];
}

const RULER_STEPS = [1 / 120, 1 / 60, 1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Rótulo curto da régua (0:05 · 1:20 · 1:02:03); passos abaixo de 1 s mostram centésimos */
function fmtRulerLabel(t, step) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = step < 1
    ? s.toFixed(2).padStart(5, '0')
    : String(Math.floor(s + 1e-6)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function renderRuler(W, pxPerSec, fps, t0, t1) {
  tlRuler.style.width = W + 'px';
  tlRuler.innerHTML   = '';

  const frame   = 1 / fps;
  const steps   = [frame, ...RULER_STEPS.filter(s => s > frame)];
  const subStep = steps.find(s => s * pxPerSec >= 8) || 600;
  // Rótulo só em múltiplos inteiros do passo menor (0,25 s ÷ 1/30 s = 7,5 dava 0:18.67…)
  const isMultiple = s => Math.abs(s / subStep - Math.round(s / subStep)) < 1e-6;
  const major   = steps.find(s => s * pxPerSec >= 70 && s >= subStep && isMultiple(s)) || 600;
  const ratio   = Math.max(1, Math.round(major / subStep));
  const end     = Math.min(t1, W / pxPerSec);

  const fragment = document.createDocumentFragment();
  // Índices inteiros: sem acumular erro de float (labels não somem mais)
  for (let i = Math.floor(t0 / subStep); i * subStep <= end; i++) {
    const t = i * subStep;
    const isMajor = i % ratio === 0;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick' + (isMajor ? ' ruler-major' : '');
    tick.style.left = (t * pxPerSec) + 'px';
    if (isMajor) tick.textContent = fmtRulerLabel(t, major);
    fragment.appendChild(tick);
  }
  tlRuler.appendChild(fragment);
}

let _tlRenderQueued    = false;
let _tlRenderedWindow  = { left: 0, zoom: 1 };

/** Coalesce vários pedidos de render num único frame (zoom, resize, scroll) */
function scheduleRenderTimeline() {
  if (_tlRenderQueued) return;
  _tlRenderQueued = true;
  requestAnimationFrame(() => {
    _tlRenderQueued = false;
    renderTimeline();
  });
}
window.__scheduleRenderTimeline = scheduleRenderTimeline;

// Scroll horizontal: re-renderiza a janela quando sai da margem pré-desenhada
tlScroll.addEventListener('scroll', () => {
  if (!state.project || _moveData || _trimData) return;
  const moved = Math.abs(tlScroll.scrollLeft - _tlRenderedWindow.left);
  if (moved > (tlScroll.clientWidth || 1200) * 0.6) scheduleRenderTimeline();
}, { passive: true });

function isClipLocked(clip) {
  return !!state.tracks?.find(t => t.index === (Number(clip.trackIndex) || 0))?.locked;
}

// ── Eventos da timeline (delegação: 1 listener para todos os blocos/labels) ──
tlLabels.addEventListener('click', e => {
  const btn = e.target.closest('.tl-track-btn, .tl-add-track-btn');
  if (!btn) {
    const label = e.target.closest('.tl-label[data-track]');
    if (!label || e.target.closest('.tl-label-input')) return;
    const ti = Number(label.dataset.track);
    deselectClip();
    selectTrack(state.selectedTrack === ti ? null : ti);
    return;
  }
  e.stopPropagation();
  if (btn.classList.contains('tl-add-track-btn')) return window.addTrack();
  const ti = Number(btn.dataset.track);
  if (btn.classList.contains('tl-track-vis'))  window.toggleTrackHidden(ti);
  if (btn.classList.contains('tl-track-lock')) window.toggleTrackLocked(ti);
  if (btn.classList.contains('tl-track-del'))  window.deleteTrack(ti);
  if (btn.classList.contains('tl-track-mute')) window.toggleTrackMuted(ti);
  if (btn.classList.contains('tl-track-solo')) window.toggleTrackSolo(ti);
});

tlLabels.addEventListener('dblclick', e => {
  const nameEl = e.target.closest('.tl-label-name');
  if (!nameEl) return;
  e.stopPropagation();
  const ti    = Number(nameEl.closest('.tl-label').dataset.track);
  const track = getTrack(ti);
  const input = document.createElement('input');
  input.className = 'tl-label-input';
  input.value     = track.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = () => { if (!done) { done = true; window.renameTrack(ti, input.value); } };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter')  input.blur();
    if (ev.key === 'Escape') { input.value = track.name; input.blur(); }
  });
});

tlTracks.addEventListener('mousedown', e => {
  const block = e.target.closest('.tl-block');
  if (!block || e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();

  const clipId = block.dataset.clipId;
  const clip   = state.clips.find(c => c.id === clipId);
  if (!clip) return;

  const handle = e.target.closest('.tl-resize-handle');
  if (handle) {
    selectClip(clipId);
    startTrim(clipId, handle.classList.contains('tl-resize-left') ? 'left' : 'right', e.clientX);
    return;
  }

  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  // Clicar num clip já selecionado (sem modificador) mantém a seleção para arrastar o grupo
  if (!(getSelectedIds().has(clipId) && !additive && getSelectedIds().size > 1)) {
    selectClip(clipId, additive);
  }

  // Playhead fora do clip: vai para o começo dele (o preview mostra o clip)
  if (!additive && (state.time < clip.start || state.time >= clip.start + clip.duration)) {
    window.seekTo?.(clip.start);
  }

  if (!isClipLocked(clip) && (!additive || getSelectedIds().size > 1)) {
    startClipDrag(clipId, e.clientX, e.clientY);
  }
});

// #endregion

// #region Timeline — Playhead e Scrub
function updatePlayhead(t) {
  const x = t * PX_PER_SEC * state.zoom;
  tlPlayhead.style.left = x + 'px';
  if (inputTime) inputTime.value = fmtTime(t);
  if (previewTime) previewTime.textContent = fmtTime(t);
  window.__kfOnTime?.(t);
}

tlScroll.addEventListener('mousedown', e => {
  if (!state.project || e.button !== 0) return;
  if (e.target.closest('.tl-block, .tl-resize-handle')) return;

  // Área das tracks é do marquee: clique simples ali busca o tempo no mouseup
  // (ver initMarquee). Scrub contínuo só na régua / área fora das rows.
  if (e.target.closest('#tlTracks')) return;

  deselectClip();
  scrubAt(e);
  state.seeking = true;
});

tlPlayhead.addEventListener('mousedown', e => { state.seeking = true; e.stopPropagation(); });
document.addEventListener('mousemove', e => { if (state.seeking) scrubAt(e); });
document.addEventListener('mouseup',   () => { state.seeking = false; });

let _scrubTime = null;
let _scrubRaf  = null;

function scrubAt(e) {
  const rect = tlScroll.getBoundingClientRect();
  const x    = e.clientX - rect.left + tlScroll.scrollLeft;
  const t    = clamp(x / (PX_PER_SEC * state.zoom), 0, state.project?.totalDuration || 0);

  // mousemove dispara bem mais que 60×/s: o playhead anda na hora, mas o seek
  // dos iframes/vídeo (caro) acontece no máximo 1× por quadro, com o último t
  updatePlayhead(t);
  _scrubTime = t;
  if (_scrubRaf) return;
  _scrubRaf = requestAnimationFrame(() => {
    _scrubRaf = null;
    if (_scrubTime != null && typeof window.seekTo === 'function') window.seekTo(_scrubTime);
    _scrubTime = null;
  });
}

// #endregion

// #region Preview — Zoom Automático (fit)

document.addEventListener('selectstart', e => e.preventDefault());
document.addEventListener('contextmenu', e => {
  // Permite apenas em inputs/textareas
  if (!['INPUT','TEXTAREA'].includes(e.target.tagName)) e.preventDefault();
});

// #endregion

// #region Zoom da Timeline
function setTimelineZoom(nextZoom, anchor = 'center') {
  if (!state.project) return;

  const timelineScroll = document.getElementById('tlScroll');
  const oldZoom = state.zoom || 1;
  const oldPxPerSec = PX_PER_SEC * oldZoom;

  let mouseX = 0;
  let timeAnchor = state.time || 0;

  if (timelineScroll) {
    const rect = timelineScroll.getBoundingClientRect();
    if (anchor === 'center') {
      mouseX = rect.width / 2;
    } else if (typeof anchor === 'number') {
      mouseX = anchor;
    }
    timeAnchor = (timelineScroll.scrollLeft + mouseX) / oldPxPerSec;
  }

  state.zoom = clamp(nextZoom, 0.1, 16);

  if (zoomLabel) {
    zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
  }
  window.__syncZoomThumb?.();

  renderTimeline();

  requestAnimationFrame(() => {
    if (!timelineScroll) return;
    const newPxPerSec = PX_PER_SEC * state.zoom;
    timelineScroll.scrollLeft = (timeAnchor * newPxPerSec) - mouseX;
    updatePlayhead?.(state.time);
  });
}

$('btnZoomIn')?.addEventListener('click', () => {
  setTimelineZoom((state.zoom || 1) * 1.5);
});

$('btnZoomOut')?.addEventListener('click', () => {
  setTimelineZoom((state.zoom || 1) / 1.5);
});

/** Ajusta o zoom para o projeto inteiro caber na largura visível */
window.zoomTimelineToFit = function zoomTimelineToFit() {
  if (!state.project) return;
  const total = Math.max(1, state.project.totalDuration || 1);
  const width = Math.max(200, tlScroll.clientWidth - 60);
  setTimelineZoom(width / (total * PX_PER_SEC), 0);
  requestAnimationFrame(() => { tlScroll.scrollLeft = 0; });
};
$('btnZoomFit')?.addEventListener('click', () => window.zoomTimelineToFit());
window.__setTimelineZoom = setTimelineZoom;
// #endregion

//#region Divisão de Clips (Split)

/**
 * Cópia independente do template para clips HTML/texto. Antes, split e
 * duplicar compartilhavam o mesmo template: editar/trimar um alterava o outro.
 * Vídeo/imagem continuam compartilhando (template = só a mídia).
 */
function cloneTemplateForClip(tmpl) {
  if (!tmpl || (tmpl.type !== 'html' && tmpl.type !== 'text')) return tmpl;
  const copy = {
    ...tmpl,
    id: mkId(),
    textParams: tmpl.textParams ? { ...tmpl.textParams } : tmpl.textParams,
    // Cópia de um clip, não um asset novo: a biblioteca conta o uso pelo original
    inLibrary: false,
    libraryId: tmpl.libraryId || (tmpl.inLibrary ? tmpl.id : undefined),
  };
  state.templates.push(copy);
  return copy;
}

function rebuildTextTemplate(tmpl, params) {
  if (!tmpl?.textTmplId) return;
  tmpl.textParams     = { ...tmpl.textParams, ...params };
  tmpl.sourceDuration = tmpl.textParams.duration;
  tmpl.html = window.__TextRegistry.buildHtml(tmpl.textTmplId, tmpl.textParams, state.project?.res);
}
window.__rebuildTextTemplate = rebuildTextTemplate;

/** Divide as palavras de uma legenda (tempos relativos ao início do clip) */
function splitCaptionWords(words, rel) {
  const left = [], right = [];
  (words || []).forEach(w => {
    if (w.start < rel) left.push({ ...w, end: Math.min(w.end, rel) });
    else right.push({ ...w, start: +(w.start - rel).toFixed(3), end: +(w.end - rel).toFixed(3) });
  });
  return { left, right };
}

function splitClipAt(clip, time) {
  const rel = time - clip.start;
  if (rel <= MIN_CLIP_DURATION || rel >= clip.duration - MIN_CLIP_DURATION) return null;

  const idx  = state.clips.indexOf(clip);
  const tmpl = state.templates.find(t => t.id === clip.templateId);
  const origTrimStart = clip.trimStart || 0;
  const isTextLike = clip.isText || tmpl?.type === 'text';

  const leftClip = {
    ...clip,
    id:        mkId(),
    duration:  rel,
    trimStart: isTextLike ? 0 : origTrimStart,
    trimEnd:   isTextLike ? rel : origTrimStart + rel,
    fadeOut:   0,
  };

  const rightTmpl = cloneTemplateForClip(tmpl);
  const rightClip = {
    ...clip,
    id:         mkId(),
    templateId: rightTmpl?.id ?? clip.templateId,
    label:      clip.label + ' (2)',
    start:      clip.start + rel,
    duration:   clip.duration - rel,
    trimStart:  isTextLike ? 0 : origTrimStart + rel,   // offset real dentro do arquivo
    trimEnd:    isTextLike ? clip.duration - rel : origTrimStart + clip.duration,
    color:      SCENE_COLORS[(idx + 1) % SCENE_COLORS.length],
    fadeIn:     0,
    _tx:        clip._tx    ? { ...clip._tx }    : clip._tx,
    _txNat:     clip._txNat ? { ...clip._txNat } : clip._txNat,
  };
  window.ClipKF?.onSplit(rightClip, rel);   // keyframes de imagem/texto recomeçam em 0 na metade da direita

  leftClip.duration  = Math.max(MIN_CLIP_DURATION, leftClip.duration);
  rightClip.duration = Math.max(MIN_CLIP_DURATION, rightClip.duration);

  // Efeitos seguem nas duas metades; saída fica só no fim, entrada só no começo
  if (clip.fx) {
    leftClip.fx  = { ...clip.fx, out: undefined };
    rightClip.fx = { ...clip.fx, in: undefined, transition: undefined };
  }

  // Legenda: cada metade fica com as suas palavras e o seu texto
  if (isTextLike && tmpl?.textTmplId) {
    const { left, right } = splitCaptionWords(clip.words, rel);
    const leftText  = left.length  ? left.map(w => w.word).join(' ')  : tmpl.textParams?.text;
    const rightText = right.length ? right.map(w => w.word).join(' ') : tmpl.textParams?.text;
    const wordsJson = ws => JSON.stringify(ws).replace(/</g, '\\u003c');

    leftClip.words  = left.length ? left : clip.words;
    rightClip.words = right.length ? right : clip.words;
    if (left.length)  leftClip.label  = leftText.slice(0, 32);
    if (right.length) rightClip.label = rightText.slice(0, 32);

    rebuildTextTemplate(tmpl, {
      text: leftText, duration: leftClip.duration,
      ...(left.length ? { wordsJson: wordsJson(left) } : {}),
    });
    rebuildTextTemplate(rightTmpl, {
      text: rightText, duration: rightClip.duration,
      ...(right.length ? { wordsJson: wordsJson(right) } : {}),
    });
  }

  window.__Compositor?.unmount(clip.id);
  state.clips.splice(idx, 1, leftClip, rightClip);
  return { leftClip, rightClip };
}

/**
 * Corta no playhead: os clips selecionados que estão sob o playhead;
 * sem seleção válida, o clip mais alto sob o playhead.
 */
window.splitCurrentScene = function splitCurrentScene() {
  if (!state.project || !state.clips.length) return;

  const under = c =>
    state.time > c.start + MIN_CLIP_DURATION &&
    state.time < c.start + c.duration - MIN_CLIP_DURATION &&
    !isClipLocked(c);

  const selected = state.clips.filter(c => getSelectedIds().has(c.id) && under(c));
  const onTrack  = state.selectedTrack == null
    ? []
    : state.clips.filter(c => (Number(c.trackIndex) || 0) === state.selectedTrack && under(c));
  // Track ativa: só ela (nunca corta outra track por engano)
  const targets  = selected.length
    ? selected
    : state.selectedTrack != null
      ? onTrack
      : state.clips.filter(under).sort((a, b) => b.trackIndex - a.trackIndex).slice(0, 1);

  if (!targets.length) {
    const trackName = state.selectedTrack != null ? ` na track ${getTrack(state.selectedTrack).name}` : '';
    if ($('mbStatus')) $('mbStatus').textContent = `Nada para cortar no playhead${trackName}`;
    return;
  }

  tlPushUndo();

  const rightIds = [];
  targets.forEach(clip => {
    const parts = splitClipAt(clip, state.time);
    if (parts) rightIds.push(parts.rightClip.id);
  });

  recalcProjectDuration();
  syncProjectGlobals();
  renderSceneList();
  renderProjectSettings();

  getSelectedIds().clear();
  rightIds.forEach(id => getSelectedIds().add(id));
  state.currentClipId = rightIds[0] || null;

  renderTimeline();
  window.mountAllClips?.();
  updateSelectionFeedback();
};

//#endregion

// #region Snapping da Timeline

function getSnapCandidates(
  excludeIds = [],
  trackIndexes = null
) {
  const candidates = new Set();

  const excluded =
    new Set(excludeIds);

  const allowedTracks =
    Array.isArray(trackIndexes) &&
    trackIndexes.length
      ? new Set(
          trackIndexes.map(Number)
        )
      : null;

  candidates.add(
    Math.max(
      0,
      Number(state.time) || 0
    )
  );
  // Marcadores e bordas de região (markers.js)
  (window.__mkTimes?.() || []).forEach(t => candidates.add(t));

  state.clips.forEach(clip => {
    if (excluded.has(clip.id)) {
      return;
    }

    const clipTrack =
      Number(clip.trackIndex) || 0;

    if (
      allowedTracks &&
      !allowedTracks.has(clipTrack)
    ) {
      return;
    }

    const start =
      Math.max(
        0,
        Number(clip.start) || 0
      );

    const duration =
      Math.max(
        MIN_CLIP_DURATION,
        Number(clip.duration) ||
          MIN_CLIP_DURATION
      );

    candidates.add(start);
    candidates.add(
      start + duration
    );
  });

  return [...candidates];
}

function snapTime(time, excludeIds = [], action = 'move', trackIndexes = null) {
  return snapTimeInfo(time, excludeIds, trackIndexes).time;
}

/** Como snapTime, mas informa se o snap foi numa borda/playhead (guia visível) */
function snapTimeInfo(
  time,
  excludeIds = [],
  trackIndexes = null
) {
  if (!state.snapEnabled) {
    return {
      time: Math.max(0, Number(time) || 0),
      edge: false,
    };
  }

  const value =
    Math.max(
      0,
      Number(time) || 0
    );

  const toleranceSeconds =
    SNAP_TOLERANCE_PX /
    (
      PX_PER_SEC *
      Math.max(
        0.01,
        Number(state.zoom) || 1
      )
    );

  const candidates =
    getSnapCandidates(
      excludeIds,
      trackIndexes
    );

  const fps =
    state.project?.fps ||
    DEFAULT_FPS;

  /*
   * Em vez de criar um candidato para cada frame
   * do projeto inteiro, calcula apenas o frame mais
   * próximo do tempo atual.
   */
  const nearestFrame =
    Math.round(value * fps) / fps;

  let bestTime = nearestFrame;
  let bestDistance =
    toleranceSeconds;
  let edge = false;

  candidates.forEach(candidate => {
    const distance =
      Math.abs(candidate - value);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestTime = candidate;
      edge = true;
    }
  });

  return {
    time: Math.max(0, bestTime),
    edge,
  };
}

/**
 * Atualiza a linha de guia de snap na timeline.
 * @param {number|null} snapX - posição em px ou null para ocultar
 */
function showSnapGuide(snapX) {
  let guide = document.getElementById('tlSnapGuide');
  if (!guide) {
    guide = document.createElement('div');
    guide.id = 'tlSnapGuide';
    guide.style.cssText = [
      'position:absolute', 'top:0', 'width:1px', 'bottom:0',
      'background:var(--accent)', 'opacity:0.8', 'pointer-events:none',
      'z-index:30', 'display:none',
      'box-shadow:0 0 4px var(--accent)',
    ].join(';');
    tlTracks.appendChild(guide);
  }
  if (snapX === null) {
    guide.style.display = 'none';
  } else {
    guide.style.display = 'block';
    guide.style.left    = snapX + 'px';
    guide.style.height  = tlTracks.scrollHeight + 'px';
  }
}

function hideSnapGuide() { showSnapGuide(null); }
// #endregion

// #region Movimentação de Clips na Timeline (horizontal + vertical)
let _moveData = null;

function timelineIntervalsOverlap(
  firstStart,
  firstEnd,
  secondStart,
  secondEnd
) {
  const epsilon = 0.000001;

  return (
    firstStart <
      secondEnd - epsilon &&
    firstEnd >
      secondStart + epsilon
  );
}

function createDragTargetTrackMap(
  dragIds,
  origStates,
  primaryClipId,
  targetTrackIndex,
  minIndex = 0
) {
  const result = new Map();

  const primaryState =
    origStates.get(primaryClipId);

  if (!primaryState) {
    return result;
  }

  dragIds.forEach(id => {
    const original =
      origStates.get(id);

    if (!original) return;

    const relativeTrack =
      original.trackIndex -
      primaryState.trackIndex;

    const target = targetTrackIndex + relativeTrack;
    if (target < minIndex) result.__clamped = true;
    result.set(id, Math.max(minIndex, target));
  });

  return result;
}

/**
 * Índice dos clips que NÃO estão sendo arrastados, por track, ordenados.
 * Montado uma vez por gesto: a validação a cada mousemove fica O(k·log n)
 * em vez de varrer todos os clips para cada candidato.
 */
function buildStaticTrackIndex(dragIds) {
  const dragged = new Set(dragIds);
  const byTrack = new Map();
  state.clips.forEach(clip => {
    if (dragged.has(clip.id)) return;
    const ti = Number(clip.trackIndex) || 0;
    if (!byTrack.has(ti)) byTrack.set(ti, []);
    const start = Number(clip.start) || 0;
    byTrack.get(ti).push({
      start,
      end: start + Math.max(MIN_CLIP_DURATION, Number(clip.duration) || MIN_CLIP_DURATION),
    });
  });
  byTrack.forEach(list => list.sort((x, y) => x.start - y.start));
  return byTrack;
}

function overlapsStatic(list, start, end) {
  if (!list?.length) return false;
  // Primeiro intervalo cujo fim passa do início pedido (busca binária)
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].end <= start + 0.000001) lo = mid + 1; else hi = mid;
  }
  return lo < list.length && timelineIntervalsOverlap(start, end, list[lo].start, list[lo].end);
}

function isDragPlacementValid(
  delta,
  dragIds,
  origStates,
  targetTrackMap,
  staticIndex = buildStaticTrackIndex(dragIds)
) {
  const movingItems = [];

  for (const id of dragIds) {
    const original = origStates.get(id);
    if (!original) continue;

    const start = original.start + delta;
    const end   = start + original.duration;
    if (start < -0.000001) return false;

    const trackIndex = targetTrackMap.get(id) ?? original.trackIndex;
    // Track bloqueada não recebe clips
    if (state.tracks.some(t => t.index === trackIndex && t.locked)) return false;
    if (overlapsStatic(staticIndex.get(trackIndex), start, end)) return false;

    movingItems.push({ start, end, trackIndex });
  }

  /*
   * Clips arrastados juntos mantêm as distâncias entre si; só podem
   * colidir quando o clamp na track 0 junta tracks diferentes.
   */
  if (targetTrackMap.__clamped) {
    for (let i = 0; i < movingItems.length; i++) {
      for (let j = i + 1; j < movingItems.length; j++) {
        const first = movingItems[i], second = movingItems[j];
        if (first.trackIndex === second.trackIndex &&
            timelineIntervalsOverlap(first.start, first.end, second.start, second.end)) {
          return false;
        }
      }
    }
  }

  return true;
}

function snapDragDelta(
  desiredDelta,
  dragIds,
  origStates,
  targetTrackMap
) {
  const minimumDelta =
    -Math.min(
      ...dragIds.map(id =>
        origStates.get(id)?.start || 0
      )
    );

  const normalizedDesired =
    Math.max(
      minimumDelta,
      desiredDelta
    );

  if (!state.snapEnabled) {
    return {
      delta: normalizedDesired,
      snapped: false,
      guideTime: null,
    };
  }

  const targetTracks = [
    ...new Set(
      [...targetTrackMap.values()]
    ),
  ];

  const candidates =
    getSnapCandidates(
      dragIds,
      targetTracks
    );

  const toleranceSeconds =
    SNAP_TOLERANCE_PX /
    (
      PX_PER_SEC *
      Math.max(
        0.01,
        Number(state.zoom) || 1
      )
    );

  const fps =
    state.project?.fps ||
    DEFAULT_FPS;

  let bestDelta =
    normalizedDesired;

  let bestDistance =
    toleranceSeconds;

  let guideTime = null;

  dragIds.forEach(id => {
    const clip =
      state.clips.find(
        item => item.id === id
      );

    const original =
      origStates.get(id);

    if (!clip || !original) {
      return;
    }

    const duration =
      Math.max(
        MIN_CLIP_DURATION,
        Number(clip.duration) ||
          MIN_CLIP_DURATION
      );

    const proposedStart =
      original.start +
      normalizedDesired;

    const movingEdges = [
      proposedStart,
      proposedStart + duration,
    ];

    movingEdges.forEach(edge => {
      const nearestFrame =
        Math.round(edge * fps) / fps;

      // [tempo, éBorda] — snap no frame alinha, mas não mostra guia
      const edgeCandidates = [
        ...candidates.map(candidate => [candidate, true]),
        [nearestFrame, false],
      ];

      edgeCandidates.forEach(
        ([candidate, isEdge]) => {
          const correction =
            candidate - edge;

          const distance =
            Math.abs(correction);

          if (
            distance <
            bestDistance
          ) {
            bestDistance = distance;

            bestDelta =
              normalizedDesired +
              correction;

            guideTime = isEdge ? candidate : null;
          }
        }
      );
    });
  });

  return {
    delta: Math.max(
      minimumDelta,
      bestDelta
    ),

    snapped:
      guideTime !== null,

    guideTime,
  };
}

function resolveNonOverlappingDragDelta(
  desiredDelta,
  dragIds,
  origStates,
  targetTrackMap,
  staticIndex = buildStaticTrackIndex(dragIds)
) {
  const minimumDelta =
    -Math.min(...dragIds.map(id => origStates.get(id)?.start || 0));

  const normalizedDesired = Math.max(minimumDelta, desiredDelta);

  // Sobreposição é proibida com ou sem snap (antes só valia com snap ligado)
  if (isDragPlacementValid(normalizedDesired, dragIds, origStates, targetTrackMap, staticIndex)) {
    return normalizedDesired;
  }

  const candidateDeltas = new Set([minimumDelta, 0]);

  dragIds.forEach(id => {
    const original = origStates.get(id);
    if (!original) return;
    const targetTrack = targetTrackMap.get(id) ?? original.trackIndex;

    (staticIndex.get(targetTrack) || []).forEach(blocker => {
      candidateDeltas.add(blocker.start - original.start - original.duration); // encostado antes
      candidateDeltas.add(blocker.end - original.start);                       // encostado depois
    });
  });

  const ordered = [...candidateDeltas]
    .filter(delta => delta >= minimumDelta)
    .sort((x, y) => Math.abs(x - normalizedDesired) - Math.abs(y - normalizedDesired));

  for (const delta of ordered) {
    if (isDragPlacementValid(delta, dragIds, origStates, targetTrackMap, staticIndex)) return delta;
  }

  // Sem espaço na track: não move (posição original sempre é válida na track original)
  return null;
}

function startClipDrag(
  clipId,
  startX,
  startY
) {
  _isInteracting = true;

  const primaryClip =
    state.clips.find(
      clip => clip.id === clipId
    );

  if (!primaryClip) {
    _isInteracting = false;
    return;
  }

  const currentSelection =
    getSelectedIds();

  const dragIds =
    currentSelection?.has(clipId)
      ? [...currentSelection]
      : [clipId];

  const validDragIds =
    dragIds.filter(id =>
      state.clips.some(
        clip => clip.id === id
      )
    );

  const origStates =
    new Map(
      validDragIds.map(id => {
        const clip =
          state.clips.find(
            item => item.id === id
          );

        return [
          id,
          {
            start:
              Number(clip.start) || 0,

            duration:
              Math.max(MIN_CLIP_DURATION, Number(clip.duration) || MIN_CLIP_DURATION),

            trackIndex:
              Number(
                clip.trackIndex
              ) || 0,
          },
        ];
      })
    );

  _moveData = {
    clipId,
    startX,
    startY,
    origStates,
    dragging: false,
  };

  document.body.style.cursor =
    'grabbing';

  let newTrackHint = null;
  let lastTrackResolution = null;
  let lastTargetTrackMap = null;
  let lastSafeDelta = 0;
  let lastEvent = null;
  let autoScrollRaf = null;
  // Rolagem no início: o delta conta o quanto a timeline andou durante o arraste
  const startScrollLeft = tlScroll.scrollLeft;
  const staticIndex = buildStaticTrackIndex(validDragIds);

  /**
   * Sombra do clip na faixa da track nova (acima de todas ou abaixo da
   * última): o bloco real fica apagado na track de origem até soltar.
   */
  function showNewTrackHint(y, above) {
    if (!newTrackHint) {
      newTrackHint = document.createElement('div');
      newTrackHint.className = 'tl-newtrack-ghost';
      newTrackHint.innerHTML = '<span>Nova track</span>';
      tlTracks.appendChild(newTrackHint);
    }

    const primary = state.clips.find(clip => clip.id === clipId);
    const pxPerSec = PX_PER_SEC * state.zoom;
    const height = Math.round(trackRowHeight() * 0.7);
    newTrackHint.style.left = `${(primary?.start || 0) * pxPerSec}px`;
    newTrackHint.style.width = `${Math.max(8, (primary?.duration || 1) * pxPerSec)}px`;
    newTrackHint.style.height = `${height}px`;
    // Acima: sobre o topo da 1ª track (acima dela fica a régua, que esconderia a sombra)
    newTrackHint.style.top = `${above ? 2 : y + 2}px`;
    newTrackHint.querySelector('span').textContent = above ? 'Nova track acima' : 'Nova track abaixo';
    newTrackHint.style.display = 'block';
    setDragAway(true);
  }

  function hideNewTrackHint() {
    if (newTrackHint) {
      newTrackHint.style.display =
        'none';
    }
    setDragAway(false);
  }

  function setDragAway(on) {
    validDragIds.forEach(id => {
      tlTracks.querySelector(`[data-clip-id="${id}"]`)?.classList.toggle('tl-drag-away', on);
    });
  }

  function setDragBlocked(on) {
    validDragIds.forEach(id => {
      tlTracks.querySelector(`[data-clip-id="${id}"]`)?.classList.toggle('tl-drag-blocked', on);
    });
  }

  /**
   * Perto das bordas da timeline: rola e reaplica o último movimento.
   * Um loop só: autoScrollRaf fica preenchido durante a chamada, então o
   * onMove reaplicado não agenda outro (antes os loops se multiplicavam).
   */
  function autoScroll() {
    if (!_moveData?.dragging || !lastEvent) { autoScrollRaf = null; return; }
    const rect = tlScroll.getBoundingClientRect();
    const EDGE = 48;
    const MAX_STEP = 24;   // px por quadro (~1400 px/s)
    let speed = 0;
    if (lastEvent.clientX < rect.left + EDGE) speed = -Math.min(MAX_STEP, Math.ceil((rect.left + EDGE - lastEvent.clientX) / 2));
    if (lastEvent.clientX > rect.right - EDGE) speed = Math.min(MAX_STEP, Math.ceil((lastEvent.clientX - rect.right + EDGE) / 2));
    if (!speed) { autoScrollRaf = null; return; }
    const before = tlScroll.scrollLeft;
    tlScroll.scrollLeft = Math.max(0, before + speed);
    if (tlScroll.scrollLeft !== before) {
      updateTimelineWidth();
      onMove(lastEvent);
    }
    autoScrollRaf = requestAnimationFrame(autoScroll);
  }

  function resolveTargetTrack(
    clientY
  ) {
    const rowHeight =
      trackRowHeight();

    const tracksRect =
      tlTracks.getBoundingClientRect();

    const relativeY =
      clientY - tracksRect.top;

    const trackIndexes =
      getTrackIndexes();

    const rows =
      trackIndexes.map(
        (trackIndex, index) => ({
          trackIndex,
          top: index * rowHeight,
          bottom:
            (index + 1) *
            rowHeight,
        })
      );

    const hit = rows.find(
      row =>
        relativeY >= row.top &&
        relativeY < row.bottom
    );

    if (hit) {
      hideNewTrackHint();

      return {
        type: 'existing',
        trackIndex:
          hit.trackIndex,
      };
    }

    const totalHeight =
      rows.length * rowHeight;

    const maxTrackIndex =
      trackIndexes.length
        ? Math.max(
            ...trackIndexes
          )
        : 0;

    const minTrackIndex =
      trackIndexes.length
        ? Math.min(
            ...trackIndexes
          )
        : 0;

    if (relativeY < 0) {
      showNewTrackHint(0, true);

      return {
        type: 'new',
        trackIndex:
          maxTrackIndex + 1,
      };
    }

    if (
      relativeY >= totalHeight
    ) {
      showNewTrackHint(
        totalHeight,
        false
      );

      // Abaixo da 0 não há índice livre: track virtual -1, aberta ao soltar
      // (insertTrackAt(0) empurra as outras uma posição para cima)
      return minTrackIndex > 0
        ? { type: 'new', trackIndex: minTrackIndex - 1 }
        : { type: 'new', trackIndex: -1, insertBottom: true };
    }

    hideNewTrackHint();

    return {
      type: 'existing',

      trackIndex:
        rows[
          rows.length - 1
        ]?.trackIndex ?? 0,
    };
  }

  function moveBlocksToTargetRows(
    targetTrackMap
  ) {
    validDragIds.forEach(id => {
      const block =
        tlTracks.querySelector(
          `[data-clip-id="${id}"]`
        );

      if (!block) return;

      const targetTrack =
        targetTrackMap.get(id);

      const destinationRow =
        tlTracks.querySelector(
          `.tl-row[data-track="${targetTrack}"]`
        );

      if (
        destinationRow &&
        block.parentElement !==
          destinationRow
      ) {
        destinationRow.appendChild(
          block
        );
      }
    });
  }

  function updateDropHighlight(
    resolution
  ) {
    tlTracks
      .querySelectorAll(
        '.tl-row-drop'
      )
      .forEach(row =>
        row.classList.remove(
          'tl-row-drop'
        )
      );

    if (
      resolution.type ===
      'existing'
    ) {
      tlTracks
        .querySelector(
          `.tl-row[data-track="${resolution.trackIndex}"]`
        )
        ?.classList.add(
          'tl-row-drop'
        );
    }
  }

  const onMove = event => {
    if (!_moveData) return;

    const dx =
      event.clientX -
      _moveData.startX;

    const dy =
      event.clientY -
      _moveData.startY;

    if (
      !_moveData.dragging &&
      Math.hypot(dx, dy) < 4
    ) {
      return;
    }

    if (!_moveData.dragging) {
      // Undo só quando o arraste começa de fato (clique simples não gera passo)
      tlPushUndo();
      _moveData.dragging = true;
    }

    lastEvent = event;
    if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScroll);

    const resolution =
      resolveTargetTrack(
        event.clientY
      );

    lastTrackResolution =
      resolution;

    const targetTrackMap =
      createDragTargetTrackMap(
        validDragIds,
        origStates,
        clipId,
        resolution.trackIndex,
        resolution.insertBottom ? -1 : 0
      );

    lastTargetTrackMap =
      targetTrackMap;

    const desiredDelta =
      (dx + tlScroll.scrollLeft - startScrollLeft) /
      (
        PX_PER_SEC *
        Math.max(
          0.01,
          Number(state.zoom) || 1
        )
      );

    const snapResult =
      snapDragDelta(
        desiredDelta,
        validDragIds,
        origStates,
        targetTrackMap
      );

    let safeDelta =
      resolveNonOverlappingDragDelta(
        snapResult.delta,
        validDragIds,
        origStates,
        targetTrackMap,
        staticIndex
      );

    // Destino impossível (track bloqueada / sem espaço): fica na track de origem
    setDragBlocked(safeDelta === null);
    if (safeDelta === null) {
      targetTrackMap.clear();
      validDragIds.forEach(id => targetTrackMap.set(id, origStates.get(id).trackIndex));
      safeDelta = resolveNonOverlappingDragDelta(
        snapResult.delta, validDragIds, origStates, targetTrackMap, staticIndex
      ) ?? 0;
      lastTargetTrackMap = targetTrackMap;
    }

    lastSafeDelta = safeDelta;

    validDragIds.forEach(id => {
      const clip =
        state.clips.find(
          item => item.id === id
        );

      const original =
        origStates.get(id);

      if (!clip || !original) {
        return;
      }

      clip.start =
        Math.max(
          0,
          original.start +
            safeDelta
        );

      normalizeClip(clip);

      const block =
        tlTracks.querySelector(
          `[data-clip-id="${id}"]`
        );

      if (block) {
        block.style.left =
          (
            clip.start *
            PX_PER_SEC *
            state.zoom
          ) + 'px';
      }
    });

    moveBlocksToTargetRows(
      targetTrackMap
    );

    updateDropHighlight(
      resolution
    );

    scrollToTrack(
      resolution.trackIndex
    );

    const primary =
      state.clips.find(
        clip => clip.id === clipId
      );

    // Guia só quando houve snap de verdade e a posição final é a do snap
    if (
      primary &&
      snapResult.snapped &&
      Math.abs(safeDelta - snapResult.delta) < 0.000001
    ) {
      showSnapGuide(
        snapResult.guideTime *
        PX_PER_SEC *
        state.zoom
      );
    } else {
      hideSnapGuide();
    }

    recalcProjectDuration();
    updatePlayhead(state.time);
  };

  const onUp = () => {
    if (!_moveData) return;

    if (
      _moveData.dragging &&
      lastTrackResolution &&
      lastTargetTrackMap
    ) {
      // Track nova abaixo da 0: todas sobem uma posição e -1 vira 0
      const insertedBottom =
        lastTrackResolution.insertBottom &&
        [...lastTargetTrackMap.values()].some(index => index < 0);
      if (insertedBottom) {
        insertTrackAt(0);
        lastTargetTrackMap.forEach((index, id) => lastTargetTrackMap.set(id, index + 1));
      }

      validDragIds.forEach(id => {
        const clip =
          state.clips.find(
            item => item.id === id
          );

        if (!clip) return;

        const destinationTrack =
          lastTargetTrackMap.get(id);

        if (
          destinationTrack == null
        ) {
          return;
        }

        clip.start =
          Math.max(
            0,
            (
              origStates.get(id)
                ?.start || 0
            ) +
            lastSafeDelta
          );

        clip.trackIndex =
          destinationTrack;

        if (
          !state.tracks.some(
            track =>
              track.index ===
              destinationTrack
          )
        ) {
          state.tracks.push(
            createTrack(
              destinationTrack
            )
          );
        }

        const compositorEntry =
          window.__Compositor?.get(
            id
          );

        if (compositorEntry) {
          compositorEntry
            ._transformApplied =
            false;
        }
      });

      state.tracks.sort(
        (first, second) =>
          second.index -
          first.index
      );
    }

    hideNewTrackHint();
    setDragBlocked(false);
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = null;
    lastEvent = null;

    if (newTrackHint) {
      newTrackHint.remove();
      newTrackHint = null;
    }

    _moveData = null;
    _isInteracting = false;
    lastTrackResolution = null;
    lastTargetTrackMap = null;

    document.body.style.cursor =
      '';

    hideSnapGuide();

    tlTracks
      .querySelectorAll(
        '.tl-row-drop'
      )
      .forEach(row =>
        row.classList.remove(
          'tl-row-drop'
        )
      );

    recalcProjectDuration();
    syncProjectGlobals();

    renderSceneList();
    renderProjectSettings();
    renderTimeline();

    window
      .__syncCompositorToTime
      ?.(state.time);

    updateSelectionFeedback();

    document.removeEventListener(
      'mousemove',
      onMove
    );

    document.removeEventListener(
      'mouseup',
      onUp
    );
  };

  document.addEventListener(
    'mousemove',
    onMove
  );

  document.addEventListener(
    'mouseup',
    onUp
  );
}

// ── Auto-scroll vertical em direção à track de destino ───────────────────
function scrollToTrack(trackIndex) {
  const tlScroll = document.getElementById('tlScroll');
  if (!tlScroll) return;

  const trackIndexes = getTrackIndexes();
  const rowH  = trackRowHeight();
  const rowPos = trackIndexes.indexOf(trackIndex);
  if (rowPos === -1) return;

  // Centro da row de destino
  const rowCenterY = rowPos * rowH + rowH / 2;

  // Centro visível atual do scroll
  const visibleCenter = tlScroll.scrollTop + tlScroll.clientHeight / 2;

  // Só scrolla se a row estiver fora da metade visível (evita jitter)
  const deadzone = tlScroll.clientHeight * 0.25;
  if (Math.abs(rowCenterY - visibleCenter) < deadzone) return;

  const targetScrollTop = rowCenterY - tlScroll.clientHeight / 2;

  tlScroll.scrollTo({
    top:      Math.max(0, targetScrollTop),
    behavior: 'smooth',
  });
}

(function syncLabelsScroll() {
  const tlScroll = document.getElementById('tlScroll');
  const tlLabels = document.getElementById('tlLabels');
  if (!tlScroll || !tlLabels) return;

  tlScroll.addEventListener('scroll', () => {
    tlLabels.scrollTop = tlScroll.scrollTop;
  });
})();

// #endregion

// #region Gerenciamento de Clips (rename, recolor, resize, delete)
window.renameClip = (id, val) => {
  const clip = state.clips.find(c => c.id === id);
  if (clip) { clip.label = val.trim() || clip.label; renderSceneList(); renderTimeline(); }
};

window.recolorClip = (id, val) => {
  const clip = state.clips.find(c => c.id === id);
  if (clip) { clip.color = val; renderSceneList(); renderTimeline(); }
};

window.resizeClip =
function resizeClip(
  id,
  durationValue
) {
  const clip = state.clips.find(
    item => item.id === id
  );

  if (!clip) return;

  const requestedDuration =
    Number.parseFloat(durationValue);

  if (
    !Number.isFinite(
      requestedDuration
    ) ||
    requestedDuration <
      MIN_CLIP_DURATION
  ) {
    renderProjectSettings();
    return;
  }

  const tmpl = state.templates.find(
    template =>
      template.id === clip.templateId
  );

  const isText =
    Boolean(clip.isText);

  const isImage =
    tmpl?.type === 'image';

  const isHtmlFit = Boolean(
    tmpl?.type === 'html' &&
    !isText &&
    clip.fitAnimationToClip
  );

  const sourceDuration = Math.max(
    MIN_CLIP_DURATION,
    Number(tmpl?.sourceDuration) ||
      requestedDuration
  );

  const hasFreeDuration =
    isText ||
    isImage ||
    isHtmlFit;

  const maxDuration =
    hasFreeDuration
      ? Infinity
      : Math.max(
          MIN_CLIP_DURATION,
          sourceDuration -
            (
              Number(clip.trimStart) ||
              0
            )
        );

  tlPushUndo();

  clip.duration = clamp(
    requestedDuration,
    MIN_CLIP_DURATION,
    maxDuration
  );

  if (isHtmlFit) {
    /*
     * Mantém a faixa original completa.
     * A duração editada controla apenas
     * a velocidade da animação.
     */
    clip.trimStart = clamp(
      Number(clip.trimStart) || 0,
      0,
      sourceDuration
    );

    clip.trimEnd = clamp(
      Number(clip.trimEnd) ||
        sourceDuration,
      clip.trimStart,
      sourceDuration
    );
  } else if (
    isText ||
    isImage
  ) {
    clip.trimStart = 0;
    clip.trimEnd = clip.duration;
  } else {
    clip.trimEnd =
      (
        Number(clip.trimStart) ||
        0
      ) +
      clip.duration;
  }

  normalizeClip(
    clip,
    maxDuration
  );

  /*
   * Mantém o comportamento especial
   * dos templates de texto.
   */
  if (
    isText &&
    tmpl?.textParams
  ) {
    tmpl.textParams.duration =
      clip.duration;

    tmpl.sourceDuration =
      clip.duration;

    tmpl.html =
      window.__TextRegistry.buildHtml(
        tmpl.textTmplId,
        tmpl.textParams,
        state.project?.res
      );

    window.remountClip?.(
      clip.id
    );
  }

  const entry =
    window.__Compositor?.get(
      clip.id
    );

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

// deleteClip / deleteSelectedClips: ver "Ações em grupo"

// #endregion

// #region Seleção Múltipla

window.__selectedClipIds = new Set();

function getSelectedIds() { return window.__selectedClipIds; }

function selectClip(clipId, additive = false) {
  const sel = getSelectedIds();

  if (!additive) {
    sel.clear();
    if (clipId) sel.add(clipId);
  } else {
    // Ctrl+clique: toggle
    if (sel.has(clipId)) sel.delete(clipId);
    else if (clipId)     sel.add(clipId);
  }

  // currentClipId = último clicado (ou null se desmarcou o único)
  state.currentClipId = sel.size ? (sel.has(clipId) ? clipId : [...sel][0]) : null;

  // A track do clip vira a ativa (cortar/apagar seguem nela depois de desmarcar)
  const current = state.clips.find(c => c.id === state.currentClipId);
  if (current) {
    state.selectedTrack = Number(current.trackIndex) || 0;
    markSelectedTrack();
  }

  // Só troca classes — antes re-renderizava timeline e biblioteca inteiras por clique
  mediaGrid?.querySelectorAll('.media-card').forEach(card => {
    card.classList.toggle('active', card.dataset.clipId === state.currentClipId);
  });
  renderProjectSettings();
  updateSelectionFeedback();
  window.__onSelectionChange?.(sel);
}

function deselectClip() {
  if (!state.currentClipId && getSelectedIds().size === 0) return;
  getSelectedIds().clear();
  state.currentClipId = null;
  document.querySelectorAll('.tl-block.tl-selected')
    .forEach(el => el.classList.remove('tl-selected'));
  // Track ativa continua: o painel mostra a track (áudio/dB)
  if (propsContent)
    propsContent.innerHTML = window.__renderTrackPanel?.(state.selectedTrack) ||
      '<div class="props-empty">Selecione um clip ou uma track</div>';
  renderMediaPanel();
  updateSelectionFeedback();
  window.__clearTransformOverlay?.();
}


// Expõe para transform.js
window.__getSelectedClipIds = () => [...getSelectedIds()];

// #endregion

// #region Marquee (retângulo de seleção)
// ─────────────────────────────────────────────────────────────────────────────

(function initMarquee() {
  let marquee = null;

  tlTracks.addEventListener('mousedown', e => {
    // Só inicia marquee em área vazia (não em bloco ou handle)
    if (e.target.closest('.tl-block, .tl-resize-handle')) return;
    if (e.button !== 0 || !state.project) return;

    const rect     = tlTracks.getBoundingClientRect();
    const startX   = e.clientX - rect.left;
    const startY   = e.clientY - rect.top;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const downRow  = e.target.closest('.tl-row[data-track]');
    const base     = additive ? new Set(getSelectedIds()) : new Set();
    let active     = false;

    // Calculados uma vez por gesto (antes: a cada clip, a cada mousemove)
    const pxPerSec = PX_PER_SEC * state.zoom;
    const rowH     = trackRowHeight();
    const rowOf    = new Map(getTrackIndexes().map((ti, i) => [ti, i]));

    const onMove = ev => {
      const r    = tlTracks.getBoundingClientRect();
      const curX = ev.clientX - r.left;
      const curY = ev.clientY - r.top;

      if (!active && Math.abs(curX - startX) < 4 && Math.abs(curY - startY) < 4) return;
      active = true;

      if (!marquee) {
        marquee = document.createElement('div');
        marquee.id = 'tlMarquee';
        marquee.style.cssText = `
          position:absolute; pointer-events:none; z-index:50;
          border:1px solid var(--accent); background:rgba(130,234,0,0.08);
          box-sizing:border-box;
        `;
        tlTracks.appendChild(marquee);
      }

      const x1 = Math.min(startX, curX), x2 = Math.max(startX, curX);
      const y1 = Math.min(startY, curY), y2 = Math.max(startY, curY);

      marquee.style.left   = x1 + 'px';
      marquee.style.top    = y1 + 'px';
      marquee.style.width  = (x2 - x1) + 'px';
      marquee.style.height = (y2 - y1) + 'px';

      const sel = getSelectedIds();
      sel.clear();
      base.forEach(id => sel.add(id));

      state.clips.forEach(clip => {
        const cx1 = clip.start * pxPerSec;
        const cx2 = cx1 + clip.duration * pxPerSec;
        const row = rowOf.get(Number(clip.trackIndex) || 0) ?? -1;
        const cy1 = row * rowH;
        const cy2 = cy1 + rowH;
        if (row >= 0 && cx2 > x1 && cx1 < x2 && cy2 > y1 && cy1 < y2) sel.add(clip.id);
      });

      state.currentClipId = sel.size ? [...sel][0] : null;
      updateSelectionFeedback();
    };

    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      if (marquee) {
        marquee.remove();
        marquee = null;
      }

      if (active) {
        renderProjectSettings();
        updateSelectionFeedback();
        window.__onSelectionChange?.(getSelectedIds());
      } else {
        // Clique simples em área vazia: desmarca, ativa a track e move o playhead até ali
        if (!additive) deselectClip();
        selectTrack(downRow ? Number(downRow.dataset.track) : null);
        scrubAt(ev);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// #endregion

// #region Ações em grupo: delete, ripple, duplicate, move track
// ─────────────────────────────────────────────────────────────────────────────

/** Ids a operar: seleção válida ou, na falta dela, o clip atual */
function getActionClipIds() {
  const validIds = [...getSelectedIds()].filter(id => state.clips.some(c => c.id === id));
  if (validIds.length) return validIds;
  if (state.currentClipId && state.clips.some(c => c.id === state.currentClipId)) return [state.currentClipId];
  const onTrack = selectedTrackClipAt();
  return onTrack ? [onTrack.id] : [];
}

/** Primeira track (a partir de `preferred`, subindo) livre no intervalo */
function findFreeTrack(start, end, preferred = 0, excludeIds = []) {
  ensureTracksState();   // projeto recém-criado ainda sem tracks
  const excluded = new Set(excludeIds);
  for (let ti = Math.max(0, preferred); ti < preferred + 200; ti++) {
    const track = state.tracks.find(t => t.index === ti);
    if (track?.locked) continue;
    const busy = state.clips.some(c =>
      !excluded.has(c.id) &&
      (Number(c.trackIndex) || 0) === ti &&
      timelineIntervalsOverlap(start, end, c.start, c.start + c.duration)
    );
    if (!busy) return ti;
  }
  return nextTrackIndex();
}
window.__findFreeTrack = findFreeTrack;

/**
 * Timeline sem clips. O projeto continua aberto (biblioteca, configurações,
 * autosave): antes ele era anulado aqui, a interface congelava e o próximo
 * import criava um projeto novo com nome e resolução padrão.
 */
function resetUiWhenProjectEmpty() {
  state.currentClipId = null;
  getSelectedIds().clear();
  Compositor.allIds().forEach(id => Compositor.unmount(id));
  window.__clearTransformOverlay?.();

  recalcProjectDuration();
  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  renderMediaPanel();

  emptyState.style.display  = 'flex';
  previewCont.style.display = 'none';
  if (propsContent) propsContent.innerHTML = '<div class="props-empty">Selecione um clip</div>';
  if ($('mbStatus')) $('mbStatus').textContent = 'Timeline vazia';
  updateSelectionFeedback();
}

function afterClipsRemoved() {
  getSelectedIds().clear();
  state.currentClipId = null;

  if (!state.clips.length) return resetUiWhenProjectEmpty();

  recalcProjectDuration();
  syncProjectGlobals();
  renderMediaPanel();
  renderTimeline();
  renderProjectSettings();
  window.__clearTransformOverlay?.();
  window.__syncCompositorToTime?.(state.time);
  updateSelectionFeedback();
  if ($('mbStatus')) $('mbStatus').textContent = `${state.clips.length} clip(s)`;
}

function removeClipsById(ids) {
  const set = new Set(ids);
  state.clips = state.clips.filter(c => !set.has(c.id));
  ids.forEach(id => Compositor.unmount(id));
}

/**
 * Remove a seleção (ou o clip atual). Clips em tracks bloqueadas ficam.
 * Toolbar, menu, contexto e tecla Del passam todos por aqui.
 */
window.deleteSelectedClips = function deleteSelectedClips() {
  const ids = getActionClipIds().filter(id => !isClipLocked(state.clips.find(c => c.id === id)));
  if (!ids.length) return;

  // Snapshot ANTES de qualquer mutação — project ainda existe aqui
  tlPushUndo();
  removeClipsById(ids);
  afterClipsRemoved();
};

/** Remove e fecha o buraco: clips seguintes da mesma track andam para a esquerda */
window.rippleDeleteSelectedClips = function rippleDeleteSelectedClips() {
  const ids = getActionClipIds().filter(id => !isClipLocked(state.clips.find(c => c.id === id)));
  if (!ids.length) return;

  tlPushUndo();

  const removed = state.clips.filter(c => ids.includes(c.id));
  removeClipsById(ids);

  const gapsByTrack = new Map();
  removed.forEach(c => {
    const ti = Number(c.trackIndex) || 0;
    if (!gapsByTrack.has(ti)) gapsByTrack.set(ti, []);
    gapsByTrack.get(ti).push({ start: c.start, duration: c.duration });
  });

  state.clips.forEach(clip => {
    const gaps = gapsByTrack.get(Number(clip.trackIndex) || 0);
    if (!gaps) return;
    const shift = gaps
      .filter(g => g.start + g.duration <= clip.start + 0.000001)
      .reduce((sum, g) => sum + g.duration, 0);
    if (shift > 0) clip.start = Math.max(0, clip.start - shift);
  });

  afterClipsRemoved();
};

/** Clique em "Excluir" num clip: se ele faz parte da seleção, exclui a seleção toda */
window.deleteClip = id => {
  if (!state.clips.some(c => c.id === id)) return;
  const sel = getSelectedIds();
  if (!(sel.has(id) && sel.size > 1)) {
    sel.clear();
    sel.add(id);
    state.currentClipId = id;
  }
  window.deleteSelectedClips();
};
window.deleteScene = window.deleteClip;

window.duplicateSelectedClips = function() {
  const ids = getActionClipIds();
  if (!ids.length) return;

  tlPushUndo();

  const newIds = [];
  ids.forEach(id => {
    const clip = state.clips.find(c => c.id === id);
    if (!clip) return;
    const tmpl  = state.templates.find(t => t.id === clip.templateId);
    const copyT = cloneTemplateForClip(tmpl);
    const start = clip.start + clip.duration;
    const dup = {
      ...clip,
      id:         mkId(),
      templateId: copyT?.id ?? clip.templateId,
      start,
      trackIndex: findFreeTrack(start, start + clip.duration, Number(clip.trackIndex) || 0),
      label:      clip.label + ' (cópia)',
      words:      clip.words ? clip.words.map(w => ({ ...w })) : clip.words,
      _tx:        clip._tx    ? { ...clip._tx }    : null,
      _txNat:     clip._txNat ? { ...clip._txNat } : null,
    };
    getTrack(dup.trackIndex);
    state.clips.push(dup);
    newIds.push(dup.id);
  });

  getSelectedIds().clear();
  newIds.forEach(id => getSelectedIds().add(id));
  state.currentClipId = newIds[0] || null;

  recalcProjectDuration();
  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  window.mountAllClips?.();
  window.__onSelectionChange?.(getSelectedIds());
  updateSelectionFeedback();
};


/**
 * Abre uma track vazia na posição `index`: ela e as de cima sobem uma posição
 * (clips e propriedades das tracks juntos). Nomes padrão (V1, V2…) acompanham.
 */
function insertTrackAt(index) {
  index = Math.max(0, Number(index) || 0);
  ensureTracksState();
  state.clips.forEach(c => {
    const ti = Number(c.trackIndex) || 0;
    if (ti >= index) c.trackIndex = ti + 1;
  });
  state.tracks.forEach(t => {
    if (t.index < index) return;
    t.index += 1;
    t.id = 'track_' + t.index;
    if (/^V\d+$/.test(t.name || '')) t.name = `V${t.index + 1}`;
  });
  state.tracks.push(createTrack(index));
  state.tracks.sort((a, b) => b.index - a.index);
  if (state.selectedTrack != null && state.selectedTrack >= index) state.selectedTrack += 1;
  Compositor.allIds().forEach(id => { const e = Compositor.get(id); if (e) e._transformApplied = false; });
}
window.__insertTrackAt = insertTrackAt;

function isTrackLocked(trackIndex) {
  return Boolean(state.tracks?.find(t => t.index === trackIndex)?.locked);
}

/**
 * Move a seleção inteira para cima/baixo como um bloco: todos andam o mesmo
 * número de tracks (a forma do grupo é mantida), pulando tracks ocupadas ou
 * travadas. Subindo sempre cabe (acima da última há espaço); descendo sem
 * espaço, um grupo de uma track só ganha uma track nova abaixo.
 */
window.moveSelectedToTrack = function(direction) {
  const ids = getActionClipIds();
  if (!ids.length) return;
  const idSet  = new Set(ids);
  const moving = state.clips.filter(c => idSet.has(c.id));
  const others = state.clips.filter(c => !idSet.has(c.id));
  const trackOf = c => Number(c.trackIndex) || 0;
  if (moving.some(c => isTrackLocked(trackOf(c)))) {
    if ($('mbStatus')) $('mbStatus').textContent = 'Há clips em track travada na seleção';
    return;
  }

  const fits = delta => moving.every(c => {
    const ti = trackOf(c) + delta;
    if (ti < 0 || isTrackLocked(ti)) return false;
    return !others.some(o => trackOf(o) === ti &&
      timelineIntervalsOverlap(c.start, c.start + c.duration, o.start, o.start + o.duration));
  });

  const step = direction > 0 ? 1 : -1;
  const maxTrack = Math.max(0, ...state.clips.map(trackOf));
  let delta = null;
  for (let d = step; Math.abs(d) <= maxTrack + 2; d += step) {
    if (fits(d)) { delta = d; break; }
  }

  const rows = new Set(moving.map(trackOf));
  if (delta === null && !(step < 0 && rows.size === 1)) {
    if ($('mbStatus')) $('mbStatus').textContent = 'Sem espaço abaixo para o grupo';
    return;
  }

  tlPushUndo();
  if (delta === null) {
    // Abre uma track abaixo: os outros clips da mesma track sobem junto com o resto
    const row = [...rows][0];
    insertTrackAt(row);
    moving.forEach(c => { c.trackIndex = row; });
  } else {
    moving.forEach(c => { c.trackIndex = trackOf(c) + delta; });
    moving.forEach(c => getTrack(trackOf(c)));
  }
  moving.forEach(c => { const e = Compositor.get(c.id); if (e) e._transformApplied = false; });

  syncProjectGlobals();
  renderTimeline();
  renderProjectSettings();
  window.__syncCompositorToTime?.(state.time);
};

// #endregion

// #region Feedback visual de seleção múltipla

function updateSelectionFeedback() {
  const sel = getSelectedIds();

  // Atualiza highlight dos blocos
  tlTracks.querySelectorAll('.tl-block').forEach(el => {
    el.classList.toggle('tl-selected', sel.has(el.dataset.clipId));
  });

  // Badge de contagem — cria se não existir
  let badge = document.getElementById('tlSelBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'tlSelBadge';
    badge.style.cssText = `
      position:fixed;
      bottom:18px; left:50%;
      transform:translateX(-50%);
      background:rgba(20,20,20,0.92);
      border:1px solid rgba(130,234,0,0.4);
      color:#82ea00;
      font-family:Inter,sans-serif;
      font-size:11px;
      padding:4px 12px;
      border-radius:20px;
      pointer-events:none;
      z-index:9999;
      display:none;
      white-space:nowrap;
      gap:8px;
      align-items:center;
    `;
    document.body.appendChild(badge);
  }

  if (sel.size > 1) {
    badge.style.display = 'flex';
    badge.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
           stroke="#82ea00" stroke-width="2.5">
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
      </svg>
      <span>${sel.size} clips selecionados</span>
      <span style="color:#666;margin:0 2px">·</span>
      <span style="color:#aaa;cursor:pointer" id="tlSelClear">✕ limpar</span>
    `;
    document.getElementById('tlSelClear')?.addEventListener('click', () => {
      deselectClip();
      renderTimeline();
    });
  } else {
    badge.style.display = 'none';
  }
}

//#endregion

// #region Timeline Undo / Redo
//
// Contrato: chame tlPushUndo() ANTES de mutar o estado. A pilha de undo guarda
// os estados "antes"; ao desfazer, o estado atual vai para a pilha de redo.
// (Antes, o undo descartava o topo e restaurava o anterior — pulava um passo.)

const TIMELINE_UNDO_LIMIT = 80;
const _timelineUndoStack  = [];
const _timelineRedoStack  = [];
let   _timelineUndoPaused = false;

function tlSnapshot() {
  const clipTemplateIds = new Set(state.clips.map(c => c.templateId));
  const templateSnaps = state.templates
    .filter(t => clipTemplateIds.has(t.id))
    .map(t => ({
      ...t,
      textParams: t.textParams ? { ...t.textParams } : t.textParams,
      // dataUrl/html são strings imutáveis: copiar a referência é barato
    }));

  const clips  = state.clips.map(c => ({
    ...c,
    _tx:    c._tx    ? { ...c._tx }    : null,
    _txNat: c._txNat ? { ...c._txNat } : null,
    words:  c.words  ? c.words.map(w => ({ ...w })) : c.words,
  }));
  const tracks = (state.tracks || []).map(t => ({ ...t }));
  // Resolução/fps/fundo: desfazer "mudar formato" também volta o formato
  const project = state.project
    ? { res: { ...state.project.res }, fps: state.project.fps, background: state.project.background }
    : null;

  // Chave barata para detectar "nada mudou" (html entra por tamanho + pontas)
  const key = JSON.stringify([
    project,
    clips.map(c => [c.id, c.templateId, c.start, c.duration, c.trimStart, c.trimEnd,
      c.trackIndex, c.label, c.color, c.volume, c.muted, c.fadeIn, c.fadeOut,
      c.fitAnimationToClip, c._tx, c.fx, c.audioFx, c.keyframes, c.blend, c.cam]),
    tracks.map(t => [t.index, t.name, t.hidden, t.locked, t.muted, t.solo, t.volume]),
    templateSnaps.map(t => [t.id, t.textParams, t.html?.length, t.html?.slice(0, 64), t.html?.slice(-64), t.layer]),
  ]);

  const markers = window.__mkSnap?.() || [];
  return { key: key + JSON.stringify(markers), clips, tracks, project, templateSnaps, markers, currentClipId: state.currentClipId };
}

/** Troca de projeto: o histórico do anterior não vale no novo */
window.__tlResetHistory = () => {
  _timelineUndoStack.length = 0;
  _timelineRedoStack.length = 0;
  tlUpdateUndoUi();
};

function tlUpdateUndoUi() {
  $('mbUndo')?.classList.toggle('disabled', !_timelineUndoStack.length);
  $('mbRedo')?.classList.toggle('disabled', !_timelineRedoStack.length);
}

function tlPushUndo() {
  if (_timelineUndoPaused || !state.clips) return;

  const snap = tlSnapshot();
  const top  = _timelineUndoStack[_timelineUndoStack.length - 1];
  if (top?.key === snap.key) return;

  _timelineUndoStack.push(snap);
  _timelineRedoStack.length = 0;
  if (_timelineUndoStack.length > TIMELINE_UNDO_LIMIT) _timelineUndoStack.shift();
  tlUpdateUndoUi();
}

function tlRestore(snap) {
  _timelineUndoPaused = true;
  const prevSelection = [...getSelectedIds()];

  Compositor.allIds().forEach(id => Compositor.unmount(id));

  state.clips = snap.clips.map(c => ({
    ...c,
    _tx:    c._tx    ? { ...c._tx }    : null,
    _txNat: c._txNat ? { ...c._txNat } : null,
    words:  c.words  ? c.words.map(w => ({ ...w })) : c.words,
  }));
  state.tracks        = snap.tracks.map(t => ({ ...t }));
  state.currentClipId = snap.currentClipId;
  window.__mkRestore?.(snap.markers);

  // Antes dos templates: textos são refeitos na resolução restaurada
  const resChanged = Boolean(snap.project && state.project && (
    snap.project.res.w !== state.project.res.w || snap.project.res.h !== state.project.res.h));
  if (snap.project && state.project) {
    state.project.res        = { ...snap.project.res };
    state.project.fps        = snap.project.fps;
    state.project.background = snap.project.background;
  }
  if (resChanged) {
    state.templates.forEach(t => {
      if (t.type === 'text' && t.textTmplId && t.textParams) {
        t.html = window.__TextRegistry.buildHtml(t.textTmplId, t.textParams, state.project.res) || t.html;
      }
    });
  }

  // Marca clips de texto para que o primeiro __TEXT_SIZE após o remount
  // não sobrescreva o _tx restaurado.
  state.clips.forEach(c => { if (c.isText) c._txLocked = true; });

  // Templates: atualiza os vivos e recria os que sumiram (redo de split/AI/colar)
  snap.templateSnaps.forEach(saved => {
    let live = state.templates.find(t => t.id === saved.id);
    if (!live) {
      live = { ...saved };
      state.templates.push(live);
    }
    live.textParams     = saved.textParams ? { ...saved.textParams } : live.textParams;
    live.sourceDuration = saved.sourceDuration;
    // Camadas especiais (sólido, gradiente, forma…): parâmetros e a imagem SVG gerada
    if (saved.layer) { live.layer = { ...saved.layer }; live.dataUrl = saved.dataUrl; }

    if (live.type === 'text' && live.textTmplId && live.textParams) {
      live.html = window.__TextRegistry.buildHtml(
        live.textTmplId, live.textParams, state.project?.res || { w: 1080, h: 1920 },
      ) || saved.html || live.html;
    } else {
      live.html = saved.html || live.html;
    }
  });

  // Templates de texto/HTML que nenhum clip usa (ex.: legendas desfeitas) saem da memória
  const used = new Set(state.clips.map(c => c.templateId));
  const keep = new Set(snap.templateSnaps.map(t => t.id));
  state.templates = state.templates.filter(t =>
    used.has(t.id) || keep.has(t.id) || t.inLibrary || (t.type !== 'text' && t.type !== 'html') ||
    _timelineUndoStack.some(s => s.templateSnaps.some(x => x.id === t.id)) ||
    _timelineRedoStack.some(s => s.templateSnaps.some(x => x.id === t.id))
  );

  if (!state.project && state.clips.length) {
    const tmpl0 = state.templates.find(t => t.id === state.clips[0].templateId);
    const res   = (tmpl0?.type === 'html' ? extractResolution?.(tmpl0.html) : null) || { w: 1080, h: 1920 };
    const fps   = (tmpl0?.type === 'html' ? extractFps?.(tmpl0.html) : null) || DEFAULT_FPS;
    state.project = { res, fps, totalDuration: 0 };
  }

  // Mantém a seleção (ex.: desfazer uma transformação em grupo continua com o grupo)
  getSelectedIds().clear();
  prevSelection.filter(id => state.clips.some(c => c.id === id)).forEach(id => getSelectedIds().add(id));
  if (!getSelectedIds().size && state.currentClipId) getSelectedIds().add(state.currentClipId);
  if (state.currentClipId && !getSelectedIds().has(state.currentClipId)) state.currentClipId = [...getSelectedIds()][0] || null;

  if (!state.clips.length) {
    resetUiWhenProjectEmpty();
    _timelineUndoPaused = false;
    tlUpdateUndoUi();
    return;
  }

  $('emptyState') && ($('emptyState').style.display = 'none');
  $('previewContainer') && ($('previewContainer').style.display = '');
  $('mediaEmpty') && ($('mediaEmpty').style.display = 'none');

  recalcProjectDuration();
  syncProjectGlobals();
  // Formato restaurado: palco do preview e fundo acompanham
  syncProjectFormFields();
  syncPreviewSize();

  renderTimeline();
  renderProjectSettings();
  renderMediaPanel();

  // Remonta só a janela de tempo atual (antes montava um iframe por clip)
  window.mountAllClips?.();
  window.__updatePlayhead?.(state.time);

  updateSelectionFeedback();
  if (getSelectedIds().size) window.__onSelectionChange?.(getSelectedIds());
  else window.__clearTransformOverlay?.();

  _timelineUndoPaused = false;
  tlUpdateUndoUi();
}

function tlUndo() {
  const current = tlSnapshot();
  while (_timelineUndoStack.length && _timelineUndoStack[_timelineUndoStack.length - 1].key === current.key) {
    _timelineUndoStack.pop();   // passos que não mudaram nada
  }
  const prev = _timelineUndoStack.pop();
  if (!prev) return tlUpdateUndoUi();

  _timelineRedoStack.push(current);
  tlRestore(prev);
  if ($('mbStatus')) $('mbStatus').textContent = 'Desfeito';
}

function tlRedo() {
  const current = tlSnapshot();
  while (_timelineRedoStack.length && _timelineRedoStack[_timelineRedoStack.length - 1].key === current.key) {
    _timelineRedoStack.pop();
  }
  const next = _timelineRedoStack.pop();
  if (!next) return tlUpdateUndoUi();

  _timelineUndoStack.push(current);
  tlRestore(next);
  if ($('mbStatus')) $('mbStatus').textContent = 'Refeito';
}

window.__tlPushUndo = tlPushUndo;
window.__tlUndo     = tlUndo;
window.__tlRedo     = tlRedo;
// #endregion

// #region Context Menu

function createContextEditItem(menu) {
  let editItem =
    document.getElementById('ctxEdit');

  if (editItem) {
    return editItem;
  }

  editItem =
    document.createElement('div');

  editItem.className = 'ctx-item';
  editItem.id = 'ctxEdit';

  editItem.innerHTML = `
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    >
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>

    Editar HTML
  `;

  menu.insertBefore(
    editItem,
    menu.firstChild
  );

  return editItem;
}

function initContextMenu() {
  const menu =
    document.getElementById(
      'clipContextMenu'
    );

  if (!menu) return;

  window
    .__motionStudioContextMenuController
    ?.abort();

  const controller =
    new AbortController();

  window.__motionStudioContextMenuController =
    controller;

  const eventOptions = {
    signal: controller.signal,
  };

  const editItem =
    createContextEditItem(menu);

  let targetClipId = null;
  let isOpen = false;

  function getTargetClip() {
    return state.clips.find(
      clip => clip.id === targetClipId
    ) || null;
  }

  function targetCanEditHtml() {
    const clip = getTargetClip();

    if (!clip || clip.isText) {
      return false;
    }

    const template =
      state.templates.find(
        item =>
          item.id === clip.templateId
      );

    return template?.type === 'html';
  }

  function updateAvailableActions() {
    const canEdit =
      targetCanEditHtml();

    /*
     * Para vídeos, imagens e textos gerados,
     * a opção não é mostrada.
     */
    editItem.style.display =
      canEdit ? '' : 'none';

    const clip = getTargetClip();
    const tmpl = clip && state.templates.find(item => item.id === clip.templateId);
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? '' : 'none';
    };
    show('ctxTranscribe', tmpl?.type === 'video' || tmpl?.type === 'audio');
    show('ctxAiScenes', tmpl?.type === 'video' || tmpl?.type === 'audio');
    show('ctxExtractAudio', Boolean(clip && window.__canExtractAudio?.(clip)));
    // Sons com IA: vale para a seleção inteira quando o clip clicado faz parte dela
    const sfxIds = sfxTargetIds();
    show('ctxAiSfx', sfxIds.length > 0);
    const sfxLabel = document.getElementById('ctxAiSfxLabel');
    if (sfxLabel) sfxLabel.textContent = sfxIds.length > 1 ? `Gerar efeitos sonoros com IA (${sfxIds.length} clips)` : 'Gerar efeitos sonoros com IA';
    show('ctxAiEdit', canEdit);
    show('ctxCaptions', Boolean(clip?.captionGroupId || (clip?.isText && clip?.words?.length)));
    menu.querySelector('[data-action="paste"]')
      ?.classList.toggle('disabled', !window.__hasClipClipboard?.());
  }

  function openAt(
    x,
    y,
    clipId
  ) {
    targetClipId = clipId;
    isOpen = true;

    updateAvailableActions();

    menu.style.display = 'block';
    menu.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      const menuWidth =
        menu.offsetWidth || 190;

      const menuHeight =
        menu.offsetHeight || 100;

      menu.style.left =
        Math.max(
          6,
          Math.min(
            x,
            window.innerWidth -
              menuWidth -
              6
          )
        ) + 'px';

      menu.style.top =
        Math.max(
          6,
          Math.min(
            y,
            window.innerHeight -
              menuHeight -
              6
          )
        ) + 'px';

      menu.style.visibility =
        'visible';
    });
  }

  function close() {
    if (!isOpen) return;

    isOpen = false;
    menu.style.display = 'none';
    menu.style.visibility = 'hidden';
    targetClipId = null;
  }

  document.addEventListener(
    'mousedown',
    event => {
      if (!isOpen) return;

      if (!menu.contains(event.target)) {
        close();
      }
    },
    {
      ...eventOptions,
      passive: true,
    }
  );

  document.addEventListener(
    'keydown',
    event => {
      if (
        isOpen &&
        event.key === 'Escape'
      ) {
        close();
      }
    },
    eventOptions
  );

  document.addEventListener(
    'contextmenu',
    event => {
      const block =
        event.target.closest(
          '.tl-block'
        );

      if (!block) {
        close();
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const clipId =
        block.dataset.clipId;

      if (!clipId) return;

      // Mantém a seleção múltipla se o clique foi num clip já selecionado
      if (!getSelectedIds().has(clipId)) {
        window.__selectClip?.(clipId);
      }

      openAt(
        event.clientX,
        event.clientY,
        clipId
      );
    },
    eventOptions
  );

  editItem.addEventListener(
    'click',
    () => {
      const clipId =
        targetClipId;

      close();

      if (!clipId) return;

      window.openHtmlClipEditor?.(
        clipId
      );
    },
    eventOptions
  );

  document
    .getElementById('ctxTranscribe')
    ?.addEventListener(
      'click',
      () => {
        const clipId =
          targetClipId;

        close();

        if (!clipId) return;

        window.__onClipTranscribe?.(
          clipId
        );
      },
      eventOptions
    );

  // Itens genéricos: <div class="ctx-item" data-action="copy">…
  menu.addEventListener(
    'click',
    event => {
      const item = event.target.closest('[data-action]');
      if (!item || item.classList.contains('disabled')) return;
      const clipId = targetClipId;
      close();
      window.__runTimelineAction?.(item.dataset.action, clipId);
    },
    eventOptions
  );

  function sfxTargetIds() {
    const sel = getSelectedIds();
    const ids = targetClipId && sel.has(targetClipId) ? [...sel] : (targetClipId ? [targetClipId] : []);
    return ids.filter(id => window.__canAiSfx?.(state.clips.find(c => c.id === id)));
  }

  document
    .getElementById('ctxAiSfx')
    ?.addEventListener(
      'click',
      () => {
        const ids = sfxTargetIds();
        close();
        if (ids.length) window.__aiSfxForClips?.(ids);
      },
      eventOptions
    );

  document
    .getElementById('ctxExtractAudio')
    ?.addEventListener(
      'click',
      () => {
        const clipId = targetClipId;
        close();
        if (clipId) window.__extractClipAudio?.(clipId);
      },
      eventOptions
    );

  document
    .getElementById('ctxAiScenes')
    ?.addEventListener(
      'click',
      () => {
        // Clicou num clip da seleção: todos os clips selecionados viram um vídeo só
        const sel = getSelectedIds();
        const ids = targetClipId && sel.has(targetClipId) ? [...sel] : (targetClipId ? [targetClipId] : []);
        close();
        if (ids.length) window.__onClipAIScenes?.(ids);
      },
      eventOptions
    );

  document
    .getElementById('ctxCaptions')
    ?.addEventListener(
      'click',
      () => {
        const clipId = targetClipId;
        close();
        if (clipId) window.openCaptionsEditor?.(clipId);
      },
      eventOptions
    );

  document
    .getElementById('ctxAiEdit')
    ?.addEventListener(
      'click',
      () => {
        const clipId = targetClipId;
        close();
        if (clipId) window.__onClipAIEdit?.(clipId);
      },
      eventOptions
    );

  document
    .getElementById('ctxDelete')
    ?.addEventListener(
      'click',
      () => {
        const clipId =
          targetClipId;

        close();

        if (!clipId) return;

        window.deleteClip?.(
          clipId
        );
      },
      eventOptions
    );
}

initContextMenu();

// #endregion

// #region Audio Recovery System
(function initAudioRecovery() {

  // Retoma AudioContext suspenso (Web Audio API)
  function resumeAudioContexts() {
    // Cobre AudioContext global e qualquer um pendurado em elementos de mídia
    const contexts = [
      window.AudioContext,
      window.webkitAudioContext,
    ].filter(Boolean);

    // Instâncias conhecidas no window
    ['_audioCtx', 'audioContext', 'audioCtx', '__audioContext'].forEach(key => {
      if (window[key] instanceof (window.AudioContext || window.webkitAudioContext || Function)) {
        try { window[key].resume?.(); } catch(_) {}
      }
    });

    // Percorre todos os vídeos do compositor e reconecta se necessário
    Compositor.allIds().forEach(id => {
      const entry = Compositor.get(id);
      if (!entry?.isNative || entry.nativeType !== 'video') return;
      const video = entry.iframe;
      if (!video) return;

      // Se o vídeo está mudo por falha (não por escolha), desmuta
      if (video.muted && !entry._userMuted) {
        video.muted = false;
      }

      // Se estava tocando mas pausou sozinho (browser throttle)
      if (entry.isPlaying && video.paused) {
        video.play().catch(() => {
          video.muted = true;
          entry._userMuted = false; // mudo por recovery, não por escolha
          video.play().catch(() => {});
        });
      }
    });
  }

  // Retoma no primeiro gesto do usuário (browser exige interação)
  const gestureEvents = ['mousedown', 'keydown', 'pointerdown', 'click'];
  gestureEvents.forEach(evt => {
    document.addEventListener(evt, resumeAudioContexts, { passive: true });
  });

  // Verifica periodicamente se algum vídeo perdeu o áudio
  setInterval(() => {
    const state = window.__appState;
    if (!state?.playing) return;
    resumeAudioContexts();
  }, 2000);

  // Expõe para uso manual se necessário
  window.__resumeAudio = resumeAudioContexts;

  // Retoma sempre que o app volta ao foco (tab switching)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudioContexts();
  });

  window.addEventListener('focus', resumeAudioContexts);

})();

//#endregion

// #region Controles do Player (botões)
document.getElementById('btnPlay')?.addEventListener('click', window.togglePlay);

document.getElementById('btnSkipStart')?.addEventListener('click', () => {
  _pause();
  window.seekTo(0);
});

document.getElementById('btnSkipEnd')?.addEventListener('click', () => {
  const p = window.__appState?.project;
  if (p) { _pause(); window.seekTo(p.totalDuration); }
});
// #endregion

// #region Compatibilidade retroativa (app.js usa estas funções)

window.loadClipIntoFrame = function(clipId) {
  // No novo modelo, não fazemos nada aqui.
  // O clip já está montado no compositor desde que foi adicionado.
  // Deixamos a função existir para não quebrar chamadas em app.js.
};

window.loadSceneIntoFrame = function(idx) {
  // Compatibilidade — não faz nada no novo modelo.
};

window.jumpToScene = function(idx) {
  const clip = window.__appState?.clips[idx];
  if (clip) window.seekTo(clip.start);
};

window.highlightScene = function(idx) {
  const clip = window.__appState?.clips[idx];
  if (clip) window.__selectClip?.(clip.id);
};
// #endregion

window.__renderTimeline = renderTimeline;
window.__applyClipTransformStyle = applyClipTransformStyle;
window.__updatePlayhead   = updatePlayhead;
window.__tlWidth          = tlWidth;
window.__trackRowHeight  = trackRowHeight;
window.__selectClip       = selectClip;
window.__deselectClip = deselectClip;
window.__mapClipTimeToSource =
  mapClipTimeToSource;
  window.validateMotionHtml = function(html) {
    const issues = [];
    if (!html.includes('window.Motion') && !html.includes('window.MotionAPI'))
      issues.push('Nenhuma API Motion encontrada (window.Motion ou window.MotionAPI)');
    if (!html.includes('durationInSeconds') && !html.includes('totalDuration'))
      issues.push('Duração não declarada');
    if (!html.includes('seek'))
      issues.push('Método seek não encontrado');
    return { valid: issues.length === 0, issues };
  };