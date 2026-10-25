'use strict';
// ai-scenes.js
//
//  Cenas com IA a partir de um áudio (ou vídeo com fala):
//    1. transcreve o trecho usado do clip (tempo de cada fala)
//    2. /api/ai/scenes/plan divide em cenas nas pausas e fixa UM guia de estilo
//       (paleta, fontes e :root idênticos em todas as cenas)
//    3. gera as cenas EM ORDEM em /api/ai/generate com a duração exata do trecho:
//       a 1ª (âncora) completa e detalhada; cada seguinte recebe o HTML da
//       anterior e só edita o que muda (mesmo <head>/estilo, menos tokens,
//       e começa do quadro onde a anterior terminou)
//    4. coloca cada clipe na timeline alinhado ao trecho do áudio, assim que fica pronto

(() => {
  const PREFS_KEY   = 'ms.aiScenesPrefs';

  const STYLE_PRESETS = [
    ['Minimalista escuro', 'Minimalista e elegante: fundo quase preto, um único acento vibrante, muito espaço vazio, tipografia sans grotesca grande, linhas finas e animações suaves com easing expo.'],
    ['Corporativo clean', 'Corporativo moderno e confiável: fundo claro, azul e verde institucionais, cards com cantos arredondados e sombra suave, ícones lineares, transições deslizando com elegância.'],
    ['Neon tech', 'Tecnológico com neon: fundo azul-escuro profundo, ciano e magenta brilhantes com glow, grid em perspectiva, partículas, tipografia geométrica, cortes rápidos com glitch sutil.'],
    ['Editorial', 'Editorial de revista: fundo off-white, preto e um vermelho de destaque, serifa display enorme contrastando com sans pequena, layout em colunas, máscaras de revelação.'],
    ['Pop colorido', 'Pop e enérgico: cores saturadas (amarelo, rosa, azul), formas geométricas chapadas, contornos grossos, tipografia bold arredondada, animações elásticas com overshoot.'],
  ];

  const SCENE_LENGTHS = [
    ['auto',   'Automático (IA decide pelas pausas)'],
    ['short',  'Curtas · 3–5 s'],
    ['medium', 'Médias · 6–10 s'],
    ['long',   'Longas · 12–20 s'],
    ['single', 'Uma cena só'],
  ];

  const S = {
    clipId:   null,
    job:      null,   // execução atual (ver run())
    styleMode: 'auto',
  };
  let els = null;

  // #region Utilidades
  const $q = sel => els.modal.querySelector(sel);
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const fmt = t => (window.fmtTime ? window.fmtTime(t) : `${Number(t).toFixed(2)}s`);
  /** 0:05.3 — compacto para a lista de cenas */
  const fmtShort = t => {
    const s = Math.max(0, Number(t) || 0);
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  };
  const appState = () => window.__appState;

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* sem storage */ }
  }

  function sourceOf(clipId) {
    const st = appState();
    const clip = st?.clips.find(c => c.id === clipId);
    const tmpl = clip && st.templates.find(t => t.id === clip.templateId);
    return clip && (tmpl?.type === 'audio' || tmpl?.type === 'video') ? { clip, tmpl } : null;
  }

  /** POST com resposta NDJSON → evento 'done' (status/progress vão para onEvent) */
  async function streamNdjson(url, body, { signal, onEvent } = {}) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok || !resp.body) {
      let data = {};
      try { data = await resp.json(); } catch (_) { /* corpo vazio */ }
      throw Object.assign(new Error(data.error || `Erro ${resp.status} no servidor`), { code: data.code });
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    const handle = line => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { return; }
      if (ev.type === 'error') throw Object.assign(new Error(ev.error), { code: ev.code });
      if (ev.type === 'done') done = ev;
      else onEvent?.(ev);
    };
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    handle(buf + decoder.decode());
    if (!done) throw new Error('A resposta terminou antes do fim. Tente novamente.');
    return done;
  }

  /** Carrega as fontes do estilo na página para a prévia do guia */
  function loadFontsLink(href) {
    if (!href || document.querySelector(`link[data-ms-scene-fonts="${CSS.escape(href)}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.msSceneFonts = href;
    document.head.appendChild(link);
  }
  // #endregion

  // #region Modal
  function build() {
    if (els) return;
    const modal = document.createElement('div');
    modal.id = 'aiScenesModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal sc-modal" role="dialog" aria-labelledby="scTitle">
        <div class="modal-header">
          <div class="modal-header-icon accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M7 4v5M17 4v5"/></svg>
          </div>
          <span id="scTitle">Cenas com IA</span>
          <span class="sc-source" id="scSource"></span>
          <button class="icon-btn" data-sc="close" aria-label="Fechar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="modal-body sc-body">
          <section class="sc-config">
            <p class="sc-lead">A IA transcreve o áudio, divide em cenas nas pausas da fala e gera um clipe para cada trecho, já posicionado na timeline em cima do áudio. A 1ª cena define o visual; cada cena seguinte parte da anterior, para o estilo e as transições ficarem contínuos.</p>

            <div class="form-group">
              <label>Estilo visual</label>
              <div class="sc-seg" role="radiogroup">
                <button type="button" class="sc-seg-btn" data-style-mode="auto" role="radio">✦ IA decide o estilo</button>
                <button type="button" class="sc-seg-btn" data-style-mode="custom" role="radio">✎ Descrever o estilo</button>
              </div>
              <p class="sc-hint" data-for="auto">A IA cria uma paleta, fontes e linguagem de movimento únicas para o conteúdo, e aplica exatamente as mesmas em todas as cenas.</p>
              <div data-for="custom">
                <div class="sc-presets">
                  ${STYLE_PRESETS.map(([name], i) => `<button type="button" class="sc-chip" data-preset="${i}">${esc(name)}</button>`).join('')}
                </div>
                <textarea id="scStyleText" class="prop-input full sc-textarea" rows="3"
                  placeholder="Ex.: fundo preto, verde-limão #82ea00 como destaque, tipografia Montserrat Black, linhas finas, animações rápidas e precisas…"></textarea>
              </div>
            </div>

            <div class="form-group">
              <label for="scBrief">Briefing <small>opcional</small></label>
              <textarea id="scBrief" class="prop-input full sc-textarea" rows="2"
                placeholder="Do que é o vídeo, para quem, o que destacar (preços, CTA, marca)…"></textarea>
            </div>

            <div class="sc-row">
              <div class="form-group">
                <label for="scLength">Duração das cenas</label>
                <select id="scLength" class="prop-input full">
                  ${SCENE_LENGTHS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="scBackground">Fundo</label>
                <select id="scBackground" class="prop-input full">
                  <option value="full">Cena completa</option>
                  <option value="transparent">Transparente (sobre vídeo)</option>
                </select>
              </div>
              <div class="form-group">
                <label for="scLang">Idioma da fala</label>
                <select id="scLang" class="prop-input full">
                  <option value="">Auto-detectar</option>
                  <option value="pt">Português</option>
                  <option value="en">Inglês</option>
                  <option value="es">Espanhol</option>
                </select>
              </div>
            </div>
            <label class="sc-check">
              <input type="checkbox" id="scSfx">
              <span><b>🔊 Efeitos sonoros</b> — a IA cria sons sincronizados com cada cena (whoosh, impacto, pop…) numa faixa de áudio abaixo das cenas</span>
            </label>
          </section>

          <section class="sc-run" hidden>
            <ol class="sc-steps">
              <li data-step="transcribe">Transcrever</li>
              <li data-step="plan">Planejar cenas e estilo</li>
              <li data-step="generate">Gerar cenas</li>
            </ol>
            <p class="sc-status" id="scStatus" aria-live="polite"></p>
            <div class="sc-style" id="scStyle" hidden></div>
            <ul class="sc-list" id="scList"></ul>
          </section>
        </div>

        <div class="modal-footer">
          <span class="sc-footnote" id="scFootnote"></span>
          <button class="btn-secondary" data-sc="cancel">Cancelar</button>
          <button class="btn-secondary" data-sc="retry" hidden>Tentar as que falharam</button>
          <button class="export-btn" data-sc="start">Gerar cenas</button>
          <button class="export-btn" data-sc="done" hidden>Concluir</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    els = { modal };

    modal.addEventListener('click', e => {
      if (e.target === modal && !S.job?.running) return close();
      const mode = e.target.closest('[data-style-mode]');
      if (mode) return setStyleMode(mode.dataset.styleMode);
      const preset = e.target.closest('[data-preset]');
      if (preset) {
        $q('#scStyleText').value = STYLE_PRESETS[+preset.dataset.preset][1];
        $q('#scStyleText').focus();
        return;
      }
      const btn = e.target.closest('[data-sc]');
      if (!btn) return;
      const action = btn.dataset.sc;
      if (action === 'close' || action === 'done') close();
      if (action === 'cancel') S.job?.running ? cancel() : close();
      if (action === 'start') start();
      if (action === 'retry') retryFailed();
      if (action === 'retry-one') retryFailed(+btn.dataset.index);
      if (action === 'ai-settings') { close(); window.MotionAI?.open?.(); }
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.style.display !== 'none' && !S.job?.running) close();
    });
  }

  function setStyleMode(mode) {
    S.styleMode = mode === 'custom' ? 'custom' : 'auto';
    els.modal.querySelectorAll('[data-style-mode]').forEach(b => {
      const on = b.dataset.styleMode === S.styleMode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    els.modal.querySelectorAll('[data-for]').forEach(el => { el.hidden = el.dataset.for !== S.styleMode; });
    if (S.styleMode === 'custom') $q('#scStyleText').focus();
  }

  function showView(view) {
    $q('.sc-config').hidden = view !== 'config';
    $q('.sc-run').hidden = view === 'config';
    const running = view === 'run';
    $q('[data-sc="start"]').hidden = view !== 'config';
    $q('[data-sc="done"]').hidden = view !== 'finished';
    $q('[data-sc="cancel"]').hidden = view === 'finished';
    $q('[data-sc="cancel"]').textContent = running ? 'Parar' : 'Cancelar';
    $q('[data-sc="retry"]').hidden = !(view === 'finished' && S.job?.scenes.some(s => s.status === 'error'));
  }

  function open(clipId) {
    build();
    // Uma geração por vez: reabre a que está rodando
    if (S.job?.running) {
      els.modal.style.display = 'flex';
      return;
    }
    const src = sourceOf(clipId);
    if (!src) return;
    S.clipId = clipId;
    S.job = null;

    const prefs = loadPrefs();
    $q('#scStyleText').value = prefs.styleText || '';
    $q('#scBrief').value = prefs.brief || '';
    $q('#scLength').value = prefs.sceneLength || 'auto';
    $q('#scBackground').value = prefs.background || (src.tmpl.type === 'video' ? 'transparent' : 'full');
    $q('#scLang').value = prefs.language ?? 'pt';
    $q('#scSfx').checked = Boolean(prefs.sfx);
    setStyleMode(prefs.styleMode || 'auto');

    $q('#scSource').textContent = `${src.tmpl.type === 'audio' ? '♪' : '▶'} ${src.clip.label} · ${fmt(src.clip.duration)}`;
    $q('#scFootnote').textContent = '';
    showView('config');
    els.modal.style.display = 'flex';
  }

  function close() {
    if (els) els.modal.style.display = 'none';
  }
  // #endregion

  // #region Execução
  function setStep(step, state) {
    const li = $q(`.sc-steps [data-step="${step}"]`);
    if (li) li.dataset.state = state;
  }

  function setStatus(text, kind = '') {
    const el = $q('#scStatus');
    el.textContent = text;
    el.classList.toggle('is-error', kind === 'error');
  }

  function readForm() {
    return {
      styleMode:   S.styleMode,
      styleText:   $q('#scStyleText').value.trim(),
      brief:       $q('#scBrief').value.trim(),
      sceneLength: $q('#scLength').value,
      background:  $q('#scBackground').value,
      language:    $q('#scLang').value,
      sfx:         $q('#scSfx').checked,
    };
  }

  async function start() {
    const src = sourceOf(S.clipId);
    if (!src) { close(); return; }
    const form = readForm();
    if (form.styleMode === 'custom' && !form.styleText) {
      $q('#scStyleText').focus();
      $q('#scStyleText').classList.add('is-invalid');
      setTimeout(() => $q('#scStyleText').classList.remove('is-invalid'), 1200);
      return;
    }
    savePrefs(form);

    const st = appState();
    const job = {
      running: true,
      controller: new AbortController(),
      form,
      clipId: src.clip.id,
      base: src.clip.start,
      duration: src.clip.duration,
      groupId: 'aiscene_' + (window.mkId ? window.mkId() : Date.now().toString(36)),
      trackIndex: null,
      style: null,
      scenes: [],
      undoPushed: false,
      usage: { input: 0, output: 0 },
      project: { w: st.project.res.w, h: st.project.res.h, fps: st.project.fps },
    };
    S.job = job;

    showView('run');
    ['transcribe', 'plan', 'generate'].forEach(s => setStep(s, ''));
    $q('#scStyle').hidden = true;
    $q('#scList').innerHTML = '';

    try {
      // 1. Transcrição (reaproveita se o mesmo trecho já foi transcrito)
      setStep('transcribe', 'active');
      setStatus('Preparando a transcrição…');
      const transcript = await window.__transcribeClip(src.clip.id, {
        language: form.language,
        onProgress: ({ stage, status }) => {
          if (stage === 'model') setStatus(status?.message || 'Carregando o modelo de transcrição…');
          if (stage === 'transcribe') setStatus(status?.device === 'cuda' ? 'Transcrevendo (GPU)…' : 'Transcrevendo em CPU — pode levar alguns minutos…');
        },
      });
      if (!job.running) return;
      const segments = (transcript.segments || []).map(s => ({
        start: +s.start, end: +s.start + +s.duration, text: s.text,
      }));
      setStep('transcribe', 'done');

      // 2. Plano: cenas + guia de estilo único
      setStep('plan', 'active');
      setStatus(segments.length ? `${segments.length} falas transcritas · planejando as cenas…` : 'Sem fala detectada · planejando pela duração…');
      const plan = await streamNdjson('/api/ai/scenes/plan', {
        transcript: { duration: job.duration, segments },
        style: { mode: form.styleMode, text: form.styleText },
        brief: form.brief,
        sceneLength: form.sceneLength,
        background: form.background,
        project: job.project,
      }, { signal: job.controller.signal, onEvent: ev => { if (ev.type === 'status') setStatus(ev.message); } });
      if (!job.running) return;
      addUsage(job, plan.usage);
      job.style = plan.style;
      job.scenes = plan.scenes.map((s, index) => ({ ...s, index, status: 'pending', message: '' }));
      job.trackIndex = pickTrack(job);
      setStep('plan', 'done');
      renderStyle(job.style);
      renderScenes();

      // 3. Cenas em ordem, cada uma a partir da anterior; entram na timeline ao terminar
      await generatePending(job);
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'aborted') {
        setStatus('Geração interrompida. As cenas prontas continuam na timeline.');
      } else {
        const step = job.scenes.length ? 'generate' : (job.style ? 'plan' : ($q('[data-step="transcribe"]').dataset.state === 'done' ? 'plan' : 'transcribe'));
        setStep(step, 'error');
        setStatus(err.message || 'Falha ao gerar as cenas.', 'error');
        if (err.code === 'no_key' || err.code === 'invalid_key') {
          $q('#scStatus').insertAdjacentHTML('beforeend', ' <button class="sc-link" data-sc="ai-settings">Configurar a chave do Gemini</button>');
        }
      }
    } finally {
      finish(job);
    }
  }

  async function generatePending(job) {
    setStep('generate', 'active');
    updateProgress(job);
    // Uma por vez e em ordem: cada cena precisa do HTML pronto da anterior
    for (const scene of job.scenes) {
      if (!job.running) return;
      if (scene.status !== 'pending') continue;   // pronta, ou falhou por falta de cota
      await generateScene(job, scene);
      updateProgress(job);
    }
    if (!job.running) return;
    const failed = job.scenes.filter(s => s.status === 'error').length;
    setStep('generate', failed ? 'error' : 'done');
  }

  /** Cena pronta mais próxima antes desta: a referência que ela vai editar */
  function referenceFor(job, scene) {
    for (let i = scene.index - 1; i >= 0; i--) {
      const s = job.scenes[i];
      if (s.status === 'done' && s.html) return s;
    }
    return null;
  }

  async function generateScene(job, scene) {
    const ref = referenceFor(job, scene);
    const label = ref ? `a partir da cena ${ref.index + 1}` : (job.scenes.length > 1 ? 'cena-âncora' : '');
    scene.status = 'running';
    scene.message = label ? `Gerando (${label})…` : 'Gerando…';
    renderScene(scene);
    try {
      const result = await streamNdjson('/api/ai/generate', {
        mode: 'create',
        prompt: '',
        name: scene.title,
        project: job.project,
        sfx: Boolean(job.form.sfx),
        scene: {
          index: scene.index,
          total: job.scenes.length,
          duration: +(scene.end - scene.start).toFixed(3),
          title: scene.title,
          visual: scene.visual,
          onScreenText: scene.onScreenText,
          speech: scene.speech,
          outline: job.scenes.map(s => ({ start: s.start, end: s.end, title: s.title })),
          brief: job.form.brief,
          style: job.style,
          previous: ref
            ? { html: ref.html, index: ref.index, title: ref.title, duration: +(ref.end - ref.start).toFixed(3) }
            : null,
        },
      }, {
        signal: job.controller.signal,
        onEvent: ev => {
          if (ev.type === 'progress') {
            scene.message = `Gerando${label ? ` (${label})` : ''}… ${ev.chars.toLocaleString('pt-BR')} caracteres`;
            renderScene(scene);
          }
          if (ev.type === 'status' && (ev.rotatedFrom || ev.waiting || ev.issues)) {
            scene.message = ev.message;
            renderScene(scene);
          }
        },
      });
      addUsage(job, result.usage);
      await placeSerial(job, scene, result);
      scene.html = result.html;
      scene.status = 'done';
      const edited = result.edit?.mode === 'patch' ? ` · ${result.edit.blocks} blocos editados` : '';
      scene.message = `pronta · ${result.model}${edited}${scene.sounds ? ` · ${scene.sounds} sons` : ''}`;
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'aborted') {
        scene.status = 'pending';
        scene.message = 'interrompida';
      } else {
        scene.status = 'error';
        scene.message = err.message || 'falhou';
        // Sem cota em nenhum modelo: as próximas falhariam igual
        if (err.code === 'all_models_exhausted' || err.code === 'no_key' || err.code === 'invalid_key') {
          job.scenes.forEach(s => { if (s.status === 'pending') { s.status = 'error'; s.message = 'não gerada (sem cota)'; renderScene(s); } });
        }
      }
    }
    renderScene(scene);
  }

  async function retryFailed(index = null) {
    const job = S.job;
    if (!job || job.running) return;
    job.scenes.forEach(s => {
      if (s.status === 'error' && (index == null || s.index === index)) { s.status = 'pending'; s.message = ''; renderScene(s); }
    });
    job.running = true;
    job.controller = new AbortController();
    showView('run');
    try {
      await generatePending(job);
    } finally {
      finish(job);
    }
  }

  function cancel() {
    const job = S.job;
    if (!job?.running) return;
    job.running = false;
    job.controller.abort();
  }

  function finish(job) {
    job.running = false;
    const done = job.scenes.filter(s => s.status === 'done').length;
    const failed = job.scenes.filter(s => s.status === 'error').length;
    if (job.scenes.length) {
      const tokens = job.usage.input + job.usage.output;
      $q('#scFootnote').textContent = tokens ? `${tokens.toLocaleString('pt-BR')} tokens` : '';
      if (!$q('#scStatus').classList.contains('is-error') || done) {
        setStatus(failed
          ? `${done} de ${job.scenes.length} cenas prontas · ${failed} falharam (tente de novo)`
          : `${done} cenas prontas na timeline, alinhadas ao áudio.`, failed ? 'error' : '');
      }
    }
    showView('finished');
  }

  function addUsage(job, usage) {
    job.usage.input += Number(usage?.input) || 0;
    job.usage.output += Number(usage?.output) || 0;
  }

  function updateProgress(job) {
    const total = job.scenes.length;
    const done = job.scenes.filter(s => s.status === 'done').length;
    if (job.running) setStatus(`Gerando cenas · ${done} de ${total} prontas`);
  }
  // #endregion

  // #region Timeline
  /**
   * Track para todas as cenas, livre no trecho inteiro e SEMPRE abaixo dos
   * textos/legendas (cena opaca por cima cobriria as legendas). Cena completa:
   * o mais baixo possível; transparente: acima dos vídeos/imagens. Sem track
   * livre nessa faixa, abre uma logo abaixo dos textos (empurra as de cima).
   */
  function pickTrack(job) {
    const st = appState();
    const t0 = job.base;
    const t1 = job.base + job.duration;
    const trackOf = c => Number(c.trackIndex) || 0;
    const typeOf = c => st.templates.find(t => t.id === c.templateId)?.type;
    const overlapping = st.clips.filter(c => c.start < t1 - 1e-4 && t0 < c.start + c.duration - 1e-4);
    const texts = overlapping.filter(c => c.isText);
    const media = overlapping.filter(c => !c.isText && typeOf(c) !== 'audio');

    const ceiling = texts.length ? Math.min(...texts.map(trackOf)) : Infinity;
    const floor = job.form.background === 'transparent' && media.length
      ? Math.max(...media.map(trackOf)) + 1
      : 0;
    const isFree = ti =>
      !(st.tracks || []).find(t => t.index === ti)?.locked &&
      !overlapping.some(c => trackOf(c) === ti);

    for (let ti = floor; ti < Math.min(ceiling, floor + 200); ti++) {
      if (isFree(ti)) return ti;
    }
    if (!Number.isFinite(ceiling) || floor > ceiling) {
      return window.__findFreeTrack ? window.__findFreeTrack(t0, t1, floor) : floor;
    }

    window.__tlPushUndo?.();
    job.undoPushed = true;
    shiftTracksUp(ceiling);
    return ceiling;
  }

  /** Abre espaço na track `from`: ela e as de cima sobem uma posição */
  function shiftTracksUp(from) {
    const st = appState();
    st.clips.forEach(c => {
      if ((Number(c.trackIndex) || 0) >= from) c.trackIndex = (Number(c.trackIndex) || 0) + 1;
    });
    (st.tracks || []).forEach(t => {
      if (t.index < from) return;
      t.index += 1;
      t.id = 'track_' + t.index;
      if (/^V\d+$/.test(t.name || '')) t.name = `V${t.index + 1}`;   // nome personalizado fica
    });
    st.tracks?.sort((a, b) => b.index - a.index);
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
  }

  /**
   * Insere uma cena por vez (as gerações rodam em paralelo). Com sons, a 1ª
   * faixa de áudio pode abrir uma track e empurrar as cenas: a track das
   * próximas é relida do clip recém-colocado.
   */
  function placeSerial(job, scene, result) {
    job.placing = (job.placing || Promise.resolve()).then(async () => {
      placeScene(job, scene, result);
      if (!job.form.sfx || !result.hasSfx || !window.__buildClipSfx) return;
      scene.message = 'criando efeitos sonoros…';
      renderScene(scene);
      scene.sounds = await window.__buildClipSfx(scene.clipId);
      const clip = appState().clips.find(c => c.id === scene.clipId);
      if (clip) job.trackIndex = Number(clip.trackIndex) || 0;
    });
    return job.placing;
  }

  function placeScene(job, scene, result) {
    const st = appState();
    if (!st?.project) throw new Error('o projeto foi fechado');
    if (!job.undoPushed) {
      window.__tlPushUndo?.();
      job.undoPushed = true;
    }

    const html = result.html;
    const duration = +(scene.end - scene.start).toFixed(3);
    const minDur = typeof MIN_CLIP_DURATION === 'number' ? MIN_CLIP_DURATION : 0.2;
    const sourceDuration = Math.max(minDur, Number(result.duration) || window.extractDuration?.(html) || duration);
    // A IA às vezes erra a duração por frações: estica a animação para caber no trecho
    const stretch = Math.abs(sourceDuration - duration) > 0.05;
    const colors = window.SCENE_COLORS || ['#82ea00'];
    const color = job.style?.primary || colors[scene.index % colors.length];
    const id = () => (window.mkId ? window.mkId() : Math.random().toString(36).slice(2));

    const template = {
      id: id(),
      name: result.name || scene.title,
      type: 'html',
      html,
      sourceDuration,
      fps: window.extractFps?.(html) || st.project.fps,
      color,
    };
    st.templates.push(template);

    const clip = {
      id: id(),
      templateId: template.id,
      label: `${scene.index + 1}. ${scene.title}`,
      trackIndex: job.trackIndex,
      start: +(job.base + scene.start).toFixed(3),
      duration,
      trimStart: 0,
      trimEnd: stretch ? sourceDuration : duration,
      fitAnimationToClip: stretch,
      color,
      aiSceneGroupId: job.groupId,
    };
    st.clips.push(window.normalizeClip ? window.normalizeClip(clip) : clip);
    window.getTrack?.(job.trackIndex);

    if (window.refreshEditorAfterProjectChange) {
      window.refreshEditorAfterProjectChange({ mount: true, seek: false });
    } else {
      window.recalcProjectDuration?.();
      window.__renderTimeline?.();
      window.mountAllClips?.();
    }
    window.__syncCompositorToTime?.(st.time);
    scene.clipId = clip.id;
  }
  // #endregion

  // #region Render do progresso
  function renderStyle(style) {
    loadFontsLink(style.fontsLink);
    const swatches = ['background', 'surface', 'primary', 'secondary', 'accent', 'text']
      .map(k => `<span class="sc-swatch" style="background:${esc(style[k])}" title="${k} ${esc(style[k])}"></span>`).join('');
    const box = $q('#scStyle');
    box.innerHTML = `
      <div class="sc-style-head">
        <div class="sc-swatches">${swatches}</div>
        <div class="sc-style-name">${esc(style.name)}</div>
      </div>
      <div class="sc-style-fonts">
        <span style="font-family:'${esc(style.fontHeading)}',sans-serif;font-weight:800">${esc(style.fontHeading)}</span>
        <span style="font-family:'${esc(style.fontBody)}',sans-serif">${esc(style.fontBody)}</span>
      </div>
      <p class="sc-style-desc">${esc(style.description)}</p>`;
    box.hidden = false;
  }

  const STATUS_ICON = { pending: '○', running: '◌', done: '✓', error: '✕' };

  function renderScenes() {
    const job = S.job;
    $q('#scList').innerHTML = job.scenes.map(s => `<li class="sc-item" data-index="${s.index}"></li>`).join('');
    job.scenes.forEach(renderScene);
  }

  function renderScene(scene) {
    const li = $q(`#scList [data-index="${scene.index}"]`);
    if (!li) return;
    li.dataset.state = scene.status;
    li.innerHTML = `
      <span class="sc-item-icon" aria-hidden="true">${STATUS_ICON[scene.status]}</span>
      <span class="sc-item-time">${fmtShort(scene.start)} – ${fmtShort(scene.end)}</span>
      <span class="sc-item-title">${scene.index + 1}. ${esc(scene.title)}</span>
      <span class="sc-item-msg" title="${esc(scene.message)}">${esc(scene.message)}</span>
      ${scene.status === 'error' && !S.job?.running ? `<button class="sc-link" data-sc="retry-one" data-index="${scene.index}">tentar de novo</button>` : ''}`;
  }
  // #endregion

  window.__onClipAIScenes = open;
  window.MotionAIScenes = { open, close, cancel };
})();
