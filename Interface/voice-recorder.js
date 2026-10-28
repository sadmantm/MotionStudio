'use strict';
// voice-recorder.js
//
//  Gravar voz direto no editor (narração): painel flutuante acima da
//  timeline, sem cobrir o preview. Fluxo:
//    escolher microfone → (contagem 3-2-1) → gravar a partir do playhead,
//    com o projeto tocando mudo por baixo (opcional) → ouvir → adicionar.
//  O resultado vira WAV (duração exata e busca precisa; o WebM do
//  MediaRecorder sai sem duração no cabeçalho) e entra como áudio na
//  biblioteca + timeline, no ponto onde a gravação começou.
//  Enquanto grava, a timeline mostra o clip crescendo na track onde ele vai
//  entrar, com a forma de onda ao vivo, e a visão acompanha o fim dele.

(() => {
  const PREFS_KEY = 'ms.voicePrefs';
  const S = {
    el: null,
    phase: 'idle',      // idle | countdown | recording | paused | review
    stream: null,
    ctx: null,
    analyser: null,
    recorder: null,
    chunks: [],
    startAt: 0,         // tempo da timeline onde a gravação começa
    startedMs: 0,
    elapsedMs: 0,
    raf: null,
    peaks: [],          // forma de onda ao vivo (um pico a cada ~40 ms)
    peakAt: [],         // segundo da gravação de cada pico
    live: null,         // clip ao vivo na timeline { el, canvas, track, created }
    blob: null,
    wav: null,
    duration: 0,
    countdownTimer: null,
    playedProject: false,
    preview: null,
  };

  const st  = () => window.__appState;
  const $q  = sel => S.el.querySelector(sel);

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        deviceId: $q('#vrDevice').value,
        playProject: $q('#vrPlay').checked,
        muteProject: $q('#vrMute').checked,
        countdown: $q('#vrCountdown').checked,
        cleanup: $q('#vrClean').checked,
      }));
    } catch (_) { /* sem storage */ }
  }

  function fmt(ms) {
    const s = Math.max(0, ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  }

  // #region Painel
  function build() {
    if (S.el) return;
    const el = document.createElement('div');
    el.id = 'voiceRecorder';
    el.className = 'vr';
    el.hidden = true;
    el.innerHTML = `
      <div class="vr-head">
        <span class="vr-dot"></span>
        <strong>Gravar voz</strong>
        <span class="vr-at" id="vrAt"></span>
        <button class="icon-btn" data-vr="close" title="Fechar (Esc)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="vr-body">
        <label class="vr-field">
          <span>Microfone</span>
          <select id="vrDevice" class="prop-input full"><option value="">Padrão do sistema</option></select>
        </label>

        <div class="vr-meter" title="Nível do microfone"><div class="vr-meter-fill" id="vrLevel"></div></div>

        <canvas class="vr-wave" id="vrWave" width="560" height="64"></canvas>

        <div class="vr-time" id="vrTime">0:00.0</div>
        <p class="vr-msg" id="vrMsg">Pronto para gravar a partir do playhead.</p>

        <div class="vr-opts" id="vrOpts">
          <label><input type="checkbox" id="vrPlay"> Tocar o projeto enquanto grava</label>
          <label><input type="checkbox" id="vrMute"> Projeto sem som durante a gravação</label>
          <label><input type="checkbox" id="vrCountdown"> Contagem regressiva (3 s)</label>
          <label><input type="checkbox" id="vrClean"> Reduzir ruído e eco do microfone</label>
        </div>
      </div>

      <div class="vr-foot">
        <button class="btn-secondary" data-vr="discard" hidden>Descartar</button>
        <button class="btn-secondary" data-vr="redo" hidden>Regravar</button>
        <button class="vr-btn-play" data-vr="listen" hidden title="Ouvir">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
        </button>
        <span class="vr-spacer"></span>
        <button class="vr-btn-pause" data-vr="pause" hidden title="Pausar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16"/><rect x="14" y="4" width="5" height="16"/></svg>
        </button>
        <button class="vr-rec" data-vr="rec" title="Gravar / parar">
          <span class="vr-rec-icon"></span>
        </button>
        <button class="export-btn" data-vr="add" hidden title="Adicionar à biblioteca e à timeline, onde a gravação começou">Adicionar</button>
      </div>`;
    document.body.appendChild(el);
    S.el = el;

    const prefs = loadPrefs();
    $q('#vrPlay').checked = prefs.playProject ?? true;
    $q('#vrMute').checked = prefs.muteProject ?? true;
    $q('#vrCountdown').checked = prefs.countdown ?? true;
    $q('#vrClean').checked = prefs.cleanup ?? true;

    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-vr]');
      if (!btn) return;
      const act = btn.dataset.vr;
      if (act === 'close') close();
      if (act === 'rec') onRecButton();
      if (act === 'pause') togglePause();
      if (act === 'discard') { resetTake(); setPhase('idle'); }
      if (act === 'redo') { resetTake(); onRecButton(); }
      if (act === 'listen') toggleListen();
      if (act === 'add') addToTimeline();
    });
    el.addEventListener('change', e => {
      if (e.target.id === 'vrDevice' || e.target.id === 'vrClean') openMic().catch(showMicError);
      savePrefs();
    });
    document.addEventListener('keydown', e => {
      if (el.hidden) return;
      if (e.key === 'Escape' && (S.phase === 'idle' || S.phase === 'review')) { e.preventDefault(); close(); }
    });
  }

  function setPhase(phase) {
    S.phase = phase;
    S.el.dataset.phase = phase;
    const show = (sel, on) => { $q(sel).hidden = !on; };
    show('[data-vr="discard"]', phase === 'review');
    show('[data-vr="redo"]', phase === 'review');
    show('[data-vr="listen"]', phase === 'review');
    show('[data-vr="add"]', phase === 'review');
    show('[data-vr="pause"]', phase === 'recording' || phase === 'paused');
    show('[data-vr="rec"]', phase !== 'review');
    $q('#vrOpts').classList.toggle('is-locked', phase !== 'idle');
    $q('#vrDevice').disabled = phase !== 'idle';
    $q('[data-vr="rec"]').title = phase === 'idle' ? 'Gravar' : 'Parar';
    const msg = {
      idle: 'Pronto para gravar a partir do playhead.',
      countdown: 'Prepare-se…',
      recording: 'Gravando…  clique no quadrado para parar.',
      paused: 'Pausado.',
      review: 'Ouça a gravação e adicione à timeline.',
    }[phase];
    $q('#vrMsg').textContent = msg;
  }
  // #endregion

  // #region Microfone e medidor
  async function listDevices() {
    const select = $q('#vrDevice');
    const saved = loadPrefs().deviceId || '';
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    select.innerHTML = '<option value="">Padrão do sistema</option>' + devices
      .filter(d => d.deviceId && d.deviceId !== 'default')
      .map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Microfone ${i + 1}`)}</option>`).join('');
    if ([...select.options].some(o => o.value === saved)) select.value = saved;
  }

  async function openMic() {
    stopMic();
    const clean = $q('#vrClean').checked;
    const deviceId = $q('#vrDevice').value;
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: clean,
        noiseSuppression: clean,
        autoGainControl: clean,
        channelCount: 1,
      },
    });
    S.ctx = S.ctx || new AudioContext();
    if (S.ctx.state === 'suspended') await S.ctx.resume().catch(() => {});
    const source = S.ctx.createMediaStreamSource(S.stream);
    S.analyser = S.ctx.createAnalyser();
    S.analyser.fftSize = 1024;
    source.connect(S.analyser);
    meterLoop();
    // Rótulos dos dispositivos só aparecem depois da permissão
    listDevices().catch(() => {});
  }

  function stopMic() {
    cancelAnimationFrame(S.raf);
    S.stream?.getTracks().forEach(t => t.stop());
    S.stream = null;
    S.analyser = null;
  }

  function showMicError(err) {
    const denied = /NotAllowed|Permission/i.test(err?.name || err?.message || '');
    $q('#vrMsg').textContent = denied
      ? 'Sem permissão para o microfone. Libere o acesso no navegador e tente de novo.'
      : `Microfone indisponível: ${err?.message || err}`;
    $q('#vrMsg').classList.add('is-error');
  }

  function meterLoop() {
    const buf = new Float32Array(S.analyser.fftSize);
    let lastPeakAt = 0;
    let windowPeak = 0;
    const tick = now => {
      if (!S.analyser) return;
      S.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const level = Math.min(1, Math.sqrt(peak) * 1.15);   // escala mais próxima da percepção
      const fill = $q('#vrLevel');
      fill.style.width = `${level * 100}%`;
      fill.classList.toggle('is-hot', peak > 0.92);

      if (S.phase === 'recording') {
        S.elapsedMs = S.elapsedBeforePause + (performance.now() - S.startedMs);
        $q('#vrTime').textContent = fmt(S.elapsedMs);
        windowPeak = Math.max(windowPeak, peak);
        if (now - lastPeakAt > 40) {
          S.peaks.push(windowPeak);
          S.peakAt.push(S.elapsedMs / 1000);
          windowPeak = 0;
          lastPeakAt = now;
          drawWave();
        }
        // Playhead acompanha a gravação mesmo depois do fim do projeto
        if (!st().playing) window.__updatePlayhead?.(S.startAt + S.elapsedMs / 1000);
      }
      S.raf = requestAnimationFrame(tick);
    };
    S.raf = requestAnimationFrame(tick);
  }

  /** Forma de onda: ao vivo mostra o fim da gravação; na revisão, ela inteira */
  function drawWave(progress = null) {
    const canvas = $q('#vrWave');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const bar = 3;
    const cols = Math.floor(W / bar);
    const peaks = S.phase === 'review'
      ? resample(S.peaks, cols)
      : S.peaks.slice(-cols);
    peaks.forEach((p, i) => {
      const h = Math.max(2, Math.min(1, Math.sqrt(p)) * (H - 4));
      const played = progress != null && i / peaks.length <= progress;
      ctx.fillStyle = S.phase === 'review'
        ? (played ? '#82ea00' : 'rgba(120,200,255,.85)')
        : '#ff5a6a';
      ctx.fillRect(i * bar, (H - h) / 2, bar - 1, h);
    });
  }

  function resample(arr, n) {
    if (arr.length <= n) return arr;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * arr.length / n), b = Math.floor((i + 1) * arr.length / n);
      let m = 0;
      for (let j = a; j < b; j++) m = Math.max(m, arr[j]);
      out.push(m);
    }
    return out;
  }
  // #endregion

  // #region Clip ao vivo na timeline
  const pxPerSec = () => (window.__PX_PER_SEC || 80) * (st().zoom || 1);
  const liveRow = () => document.querySelector(`#tlTracks .tl-row[data-track="${S.live.track}"]`);

  /** Track livre no trecho gravado até agora; sem row ainda, cria a track (vazia) */
  function pickLiveTrack() {
    const end = S.startAt + Math.max(1, S.elapsedMs / 1000);
    const track = window.__findFreeTrack?.(S.startAt, end, S.live?.track ?? 0) ?? 0;
    if (!st().tracks?.some(t => t.index === track)) {
      window.getTrack?.(track);
      S.live.created.add(track);
      window.renderTimeline?.();
    }
    if (track !== S.live.track) {
      S.live.track = track;
      revealRow();
    }
  }

  /** Rola a timeline na vertical até a row da gravação */
  function revealRow() {
    const row = liveRow();
    const scroll = document.getElementById('tlScroll');
    if (!row || !scroll) return;
    // A régua é sticky: a área útil começa abaixo dela
    const ruler = document.getElementById('tlRuler')?.offsetHeight || 0;
    const top = row.offsetTop + (document.getElementById('tlTracks')?.offsetTop || 0);
    if (top < scroll.scrollTop + ruler) scroll.scrollTop = Math.max(0, top - ruler);
    else if (top + row.offsetHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = top + row.offsetHeight - scroll.clientHeight;
  }

  function startLive() {
    if (!st()?.project) return;
    const el = document.createElement('div');
    el.className = 'vr-live-clip';
    el.innerHTML = '<canvas></canvas><span class="vr-live-label">● Gravando</span>';
    S.live = { el, canvas: el.querySelector('canvas'), label: el.querySelector('span'), track: null, created: new Set(), lastPick: 0, raf: null };
    pickLiveTrack();
    // Loop próprio: continua com o painel fechado (revisão pendente) e após re-render da timeline
    const loop = () => {
      if (!S.live) return;
      drawLive();
      S.live.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** Clip crescendo + forma de onda (só a parte visível vai para o canvas) */
  function drawLive() {
    const L = S.live;
    if (!L) return;
    const now = performance.now();
    if (S.phase === 'recording' && now - L.lastPick > 500) { L.lastPick = now; pickLiveTrack(); }
    const row = liveRow();
    if (!row) return;
    // renderTimeline refaz as rows: o clip volta para a dele
    if (L.el.parentElement !== row) row.appendChild(L.el);

    const pps = pxPerSec();
    const dur = S.phase === 'review' ? S.duration : S.elapsedMs / 1000;
    const width = Math.max(2, dur * pps);
    L.el.style.left = `${S.startAt * pps}px`;
    L.el.style.width = `${width}px`;
    L.el.classList.toggle('is-review', S.phase === 'review');
    L.label.textContent = S.phase === 'review' ? '◼ Gravação — ouça e adicione' : `● ${fmt(dur * 1000)}`;

    const scroll = document.getElementById('tlScroll');
    window.__tlMinEnd = S.startAt + dur + 2;
    window.updateTimelineWidth?.();
    // A visão acompanha o fim do clip enquanto grava
    const head = (S.startAt + dur) * pps;
    if (S.phase === 'recording' && scroll && head > scroll.scrollLeft + scroll.clientWidth * 0.9) {
      scroll.scrollLeft = head - scroll.clientWidth * 0.1;
    }

    // Canvas cobre só o trecho visível do clip (gravações longas passariam do limite de um canvas)
    const viewLeft = (scroll?.scrollLeft || 0) - S.startAt * pps;
    const x0 = Math.max(0, viewLeft);
    const x1 = Math.min(width, viewLeft + (scroll?.clientWidth || width));
    const w = Math.max(1, Math.round(x1 - x0));
    const h = Math.max(1, L.el.clientHeight);
    const c = L.canvas;
    c.style.left = `${x0}px`;
    L.label.style.left = `${x0 + 4}px`;   // rótulo no começo da parte visível
    c.style.width = `${w}px`;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = S.phase === 'review' ? 'rgba(120,200,255,.9)' : 'rgba(255,90,106,.95)';
    const bar = Math.max(1, Math.min(3, 0.04 * pps - 1));
    for (let i = 0; i < S.peaks.length; i++) {
      const x = S.peakAt[i] * pps - x0;
      if (x < -bar || x > w) continue;
      const ph = Math.max(1, Math.min(1, Math.sqrt(S.peaks[i])) * (h - 6));
      ctx.fillRect(x, (h - ph) / 2, bar, ph);
    }
  }

  /** Tira o clip ao vivo; keepTracks = a gravação entrou (as tracks criadas ficam) */
  function removeLive({ keepTracks = false } = {}) {
    const L = S.live;
    if (!L) return;
    S.live = null;
    cancelAnimationFrame(L.raf);
    L.el.remove();
    delete window.__tlMinEnd;
    const state = st();
    const empty = [...L.created].filter(ti => !state.clips.some(c => (Number(c.trackIndex) || 0) === ti));
    if (!keepTracks && empty.length) {
      state.tracks = state.tracks.filter(t => !empty.includes(t.index));
    }
    window.renderTimeline?.();
  }
  // #endregion

  // #region Gravação
  function onRecButton() {
    if (S.phase === 'idle') return startCountdown();
    if (S.phase === 'countdown') { clearInterval(S.countdownTimer); setPhase('idle'); $q('#vrTime').textContent = fmt(0); return; }
    if (S.phase === 'recording' || S.phase === 'paused') stopRecording();
  }

  function startCountdown() {
    if (!S.stream) return openMic().then(startCountdown, showMicError);
    S.startAt = Math.max(0, Number(st().time) || 0);
    $q('#vrAt').textContent = `a partir de ${fmtTime(S.startAt)}`;
    if (!$q('#vrCountdown').checked) return startRecording();
    setPhase('countdown');
    let n = 3;
    $q('#vrTime').textContent = String(n);
    S.countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) { $q('#vrTime').textContent = String(n); return; }
      clearInterval(S.countdownTimer);
      startRecording();
    }, 1000);
  }

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
    return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  }

  function startRecording() {
    resetTake();
    const mimeType = pickMime();
    S.recorder = new MediaRecorder(S.stream, mimeType ? { mimeType } : undefined);
    S.recorder.ondataavailable = e => { if (e.data.size) S.chunks.push(e.data); };
    S.recorder.onstop = finishTake;
    S.recorder.start(250);
    S.startedMs = performance.now();
    S.elapsedBeforePause = 0;
    setPhase('recording');
    startLive();

    // Narração por cima: projeto tocando do mesmo ponto (mudo, se pedido)
    S.playedProject = false;
    if ($q('#vrPlay').checked && st().project) {
      window.__previewMuted = $q('#vrMute').checked;
      window.__syncCompositorToTime?.(st().time);
      if (!st().playing) { window.togglePlay?.(); S.playedProject = true; }
    }
  }

  function togglePause() {
    if (!S.recorder) return;
    if (S.phase === 'recording') {
      S.recorder.pause();
      S.elapsedBeforePause = S.elapsedMs;
      if (st().playing) window.togglePlay?.();
      setPhase('paused');
    } else if (S.phase === 'paused') {
      S.recorder.resume();
      S.startedMs = performance.now();
      if (S.playedProject && !st().playing) window.togglePlay?.();
      setPhase('recording');
    }
  }

  function stopRecording() {
    if (S.playedProject && st().playing) window.togglePlay?.();
    window.__previewMuted = false;
    window.__syncCompositorToTime?.(st().time);
    if (S.recorder && S.recorder.state !== 'inactive') S.recorder.stop();
  }

  async function finishTake() {
    S.blob = new Blob(S.chunks, { type: S.recorder?.mimeType || 'audio/webm' });
    S.recorder = null;
    $q('#vrMsg').textContent = 'Processando…';
    try {
      const buffer = await S.ctx.decodeAudioData(await S.blob.arrayBuffer());
      S.duration = buffer.duration;
      S.wav = encodeWav(buffer);
      setPhase('review');
      $q('#vrTime').textContent = fmt(S.duration * 1000);
      drawWave(0);
    } catch (err) {
      removeLive();
      setPhase('idle');
      $q('#vrMsg').textContent = `Não foi possível ler a gravação: ${err.message}`;
      $q('#vrMsg').classList.add('is-error');
    }
    // O playhead volta ao ponto da gravação
    window.seekTo?.(S.startAt);
  }

  /** PCM 16 bits mono (mistura os canais) */
  function encodeWav(buffer) {
    const rate = buffer.sampleRate;
    const length = buffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    const out = new DataView(new ArrayBuffer(44 + length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
      const v = Math.max(-1, Math.min(1, mono[i]));
      out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  function resetTake() {
    removeLive();
    S.chunks = [];
    S.peaks = [];
    S.peakAt = [];
    S.blob = null;
    S.wav = null;
    S.duration = 0;
    S.elapsedMs = 0;
    stopListen();
    $q('#vrMsg').classList.remove('is-error');
    $q('#vrTime').textContent = fmt(0);
    drawWave();
  }

  function toggleListen() {
    if (S.preview) return stopListen();
    S.preview = new Audio(URL.createObjectURL(S.wav));
    S.preview.play().catch(() => stopListen());
    $q('[data-vr="listen"]').classList.add('is-on');
    const tick = () => {
      if (!S.preview) return;
      drawWave(S.preview.currentTime / Math.max(0.01, S.duration));
      if (S.preview.ended) return stopListen();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stopListen() {
    if (!S.preview) return;
    S.preview.pause();
    URL.revokeObjectURL(S.preview.src);
    S.preview = null;
    $q('[data-vr="listen"]')?.classList.remove('is-on');
    if (S.phase === 'review') drawWave(0);
  }

  async function addToTimeline() {
    if (!S.wav) return;
    stopListen();
    const n = st().templates.filter(t => /^Narração \d+$/.test(t.name || '')).length + 1;
    const file = new File([S.wav], `Narração ${n}.wav`, { type: 'audio/wav' });
    // Na track onde o clip ao vivo estava (a timeline já mostrava ali)
    const trackIndex = S.live?.track ?? null;
    removeLive({ keepTracks: true });
    await handleMediaFiles([file], { toTimeline: true, at: S.startAt, ...(trackIndex != null ? { trackIndex } : {}) });
    resetTake();
    setPhase('idle');
    close();
  }
  // #endregion

  async function open() {
    if (!st()?.project) return;
    build();
    S.el.hidden = false;
    $q('#vrAt').textContent = `a partir de ${fmtTime(st().time)}`;
    if (S.phase === 'review' || S.phase === 'recording' || S.phase === 'paused') return;
    setPhase('idle');
    resetTake();
    try {
      await openMic();
    } catch (err) {
      showMicError(err);
    }
  }

  function close() {
    if (!S.el) return;
    if (S.phase === 'recording' || S.phase === 'paused') stopRecording();
    clearInterval(S.countdownTimer);
    stopListen();
    stopMic();
    window.__previewMuted = false;
    S.el.hidden = true;
    if (S.phase === 'countdown') setPhase('idle');
  }

  window.MSVoice = { open, close };
})();
