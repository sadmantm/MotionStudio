'use strict';
// ai-scenes.js
//
//  Cenas com IA a partir de um áudio (ou vídeo com fala):
//    1. transcreve o trecho usado de cada clip selecionado (ex.: os trechos de
//       uma narração cortada) e junta as falas no tempo da timeline
//    2. /api/ai/scenes/plan divide em cenas nas pausas e fixa UM guia de estilo
//       (paleta, fontes e :root idênticos em todas as cenas)
//    3. gera as cenas EM ORDEM em /api/ai/generate com a duração exata do trecho:
//       a 1ª (âncora) completa e detalhada; cada seguinte recebe o HTML da
//       anterior e só edita o que muda (mesmo <head>/estilo, menos tokens,
//       e começa do quadro onde a anterior terminou)
//    4. coloca cada clipe na timeline alinhado ao trecho do áudio, assim que fica pronto
//
//  Progresso salvo no projeto (transcrição, plano/estilo e o HTML de cada cena):
//  se a IA falhar (cota, sobrecarga) ou o modal/projeto for fechado, "Continuar"
//  retoma do ponto onde parou, sem transcrever nem planejar de novo — as cenas
//  já geradas ficam como estão e as novas seguem o mesmo estilo.

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
    clipIds:  [],
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
  /** Preferência da barra de IA (libs/ai.js) enquanto o formulário não tem a própria */
  function barLibs() {
    try { const arr = JSON.parse(localStorage.getItem('ms.aiLibs') || '[]'); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
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

  /** Clips de áudio/vídeo válidos, em ordem na timeline */
  function sourcesOf(clipIds) {
    return clipIds.map(sourceOf).filter(Boolean).sort((a, b) => a.clip.start - b.clip.start);
  }

  /** Trecho da timeline coberto pelos clips: { base, duration } */
  function spanOf(sources) {
    const base = Math.min(...sources.map(s => s.clip.start));
    const end = Math.max(...sources.map(s => s.clip.start + s.clip.duration));
    return { base, duration: end - base };
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

  // #region Progresso salvo (retomar)
  const projectId = () => window.MSProjects?.currentId?.() || null;
  const jobUrl = id => `/api/projects/${encodeURIComponent(id)}/ai-job`;
  let saveTimer = null;

  function snapshot(job) {
    return {
      v: 1,
      savedAt: Date.now(),
      clipIds: job.clipIds,
      base: job.base,
      duration: job.duration,
      groupId: job.groupId,
      trackIndex: job.trackIndex,
      form: job.form,
      project: job.project,
      segments: job.segments || null,
      style: job.style || null,
      usage: job.usage,
      scenes: job.scenes.map(sc => ({
        ...sc,
        status: sc.status === 'done' ? 'done' : 'pending',   // em andamento/falha → refazer na retomada
        message: sc.status === 'done' ? sc.message : '',
      })),
    };
  }

  /** Salva (com debounce) o estado do trabalho no projeto; `now` grava já */
  function persist(job, { now = false } = {}) {
    if (!job?.projectId || (!job.segments && !job.scenes.length)) return;
    clearTimeout(saveTimer);
    const run = () => fetch(jobUrl(job.projectId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: snapshot(job) }),
    }).catch(() => { /* sem servidor: segue sem salvar */ });
    if (now) run(); else saveTimer = setTimeout(run, 400);
  }

  function discardSaved(id = projectId()) {
    clearTimeout(saveTimer);
    if (id) fetch(jobUrl(id), { method: 'DELETE' }).catch(() => {});
  }

  async function loadSaved(id = projectId()) {
    if (!id) return null;
    try {
      const resp = await fetch(jobUrl(id), { cache: 'no-store' });
      return resp.ok ? (await resp.json()).job : null;
    } catch (_) { return null; }
  }

  /** Lista de modelos para escolher na recuperação ("" = automático, com rotação) */
  async function fillModelSelect() {
    const sel = $q('#scModel');
    if (!sel) return;
    try {
      const data = await (await fetch('/api/ai/models')).json();
      const cool = new Map((data.cooldowns || []).map(c => [c.model, c.secondsLeft]));
      const wait = sec => (sec >= 5400 ? `${Math.round(sec / 3600)} h` : sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec}s`);
      const current = sel.value;
      sel.innerHTML = `<option value="">Automático (troca de modelo sozinha)</option>${(data.models || []).map(m =>
        `<option value="${esc(m.id)}">${esc(m.id)}${cool.has(m.id) ? ` · em espera ${wait(cool.get(m.id))}` : ''}</option>`).join('')}`;
      sel.value = [...sel.options].some(o => o.value === current) ? current : '';
    } catch (_) { /* sem lista: fica só o automático */ }
  }
  // #endregion

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
            <div class="sc-resume" id="scResume" hidden>
              <div class="sc-resume-text" id="scResumeText"></div>
              <div class="sc-resume-actions">
                <button class="export-btn" data-sc="resume">Continuar de onde parou</button>
                <button class="btn-secondary" data-sc="discard">Descartar e começar de novo</button>
              </div>
            </div>
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
            <div class="sc-libs">
              <span class="sc-libs-title">Bibliotecas preferidas <small>nenhuma = a IA escolhe</small></span>
              <label class="sc-check"><input type="checkbox" class="sc-lib" value="gsap"><span><b>GSAP</b> — timelines, texto por letra/palavra, traços e morph SVG</span></label>
              <label class="sc-check"><input type="checkbox" class="sc-lib" value="three"><span><b>Three.js</b> — camada 3D, partículas e bloom</span></label>
              <label class="sc-check"><input type="checkbox" class="sc-lib" value="onetake"><span><b>OneTake</b> — take contínuo: uma câmera só, cada cena nasce da anterior</span></label>
            </div>
          </section>

          <section class="sc-run" hidden>
            <ol class="sc-steps">
              <li data-step="transcribe">Transcrever</li>
              <li data-step="plan">Planejar cenas e estilo</li>
              <li data-step="generate">Gerar cenas</li>
            </ol>
            <p class="sc-status" id="scStatus" aria-live="polite"></p>
            <div class="sc-recover" id="scRecover" hidden>
              <div class="sc-recover-text">Progresso salvo no projeto. Tente de novo agora (pode escolher o modelo) ou feche e volte depois em <b>Gerar cenas com IA → Continuar de onde parou</b>: nada é transcrito nem planejado outra vez e as cenas prontas continuam iguais.</div>
              <label class="sc-recover-row">Modelo
                <select id="scModel" class="prop-input"><option value="">Automático (troca de modelo sozinha)</option></select>
              </label>
              <div class="sc-recover-actions">
                <button class="export-btn" data-sc="retry">Tentar de novo</button>
                <button class="btn-secondary" data-sc="ai-settings">Chave e modelo padrão…</button>
              </div>
            </div>
            <div class="sc-style" id="scStyle" hidden></div>
            <ul class="sc-list" id="scList"></ul>
          </section>
        </div>

        <div class="modal-footer">
          <span class="sc-footnote" id="scFootnote"></span>
          <button class="btn-secondary" data-sc="cancel">Cancelar</button>
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
      if (action === 'retry') retry();
      if (action === 'retry-one') retry(+btn.dataset.index);
      if (action === 'resume') resume();
      if (action === 'discard') { discardSaved(); $q('#scResume').hidden = true; }
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
    // Falha: painel de recuperação (tentar de novo / trocar o modelo)
    const failed = view === 'finished' && Boolean(S.job?.failure || S.job?.scenes.some(s => s.status === 'error'));
    $q('#scRecover').hidden = !failed || ['no_key', 'invalid_key'].includes(S.job?.failure?.code);
    if (failed) fillModelSelect();
  }

  /** clipIds: o clip clicado ou a seleção inteira (todos viram um vídeo só) */
  function open(clipIds) {
    build();
    // Uma geração por vez: reabre a que está rodando
    if (S.job?.running) {
      els.modal.style.display = 'flex';
      return;
    }
    const sources = sourcesOf([].concat(clipIds || []));
    if (!sources.length) return;
    const src = sources[0];
    const hasVideo = sources.some(s => s.tmpl.type === 'video');
    S.clipIds = sources.map(s => s.clip.id);
    S.job = null;

    const prefs = loadPrefs();
    $q('#scStyleText').value = prefs.styleText || '';
    $q('#scBrief').value = prefs.brief || '';
    $q('#scLength').value = prefs.sceneLength || 'auto';
    $q('#scBackground').value = prefs.background || (hasVideo ? 'transparent' : 'full');
    $q('#scLang').value = prefs.language ?? 'pt';
    $q('#scSfx').checked = Boolean(prefs.sfx);
    const libs = Array.isArray(prefs.libs) ? prefs.libs : barLibs();
    els.modal.querySelectorAll('.sc-lib').forEach(input => { input.checked = libs.includes(input.value); });
    setStyleMode(prefs.styleMode || 'auto');

    $q('#scSource').textContent = sources.length > 1
      ? `${hasVideo ? '▶' : '♪'} ${sources.length} clips · ${src.clip.label} · ${fmt(spanOf(sources).duration)}`
      : `${src.tmpl.type === 'audio' ? '♪' : '▶'} ${src.clip.label} · ${fmt(src.clip.duration)}`;
    $q('#scFootnote').textContent = '';
    showView('config');
    els.modal.style.display = 'flex';
    showResumeOffer();
  }

  /** Há um trabalho salvo para estes clips? Oferece continuar */
  async function showResumeOffer() {
    const box = $q('#scResume');
    box.hidden = true;
    const saved = await loadSaved();
    if (!saved || S.job || els.modal.style.display === 'none') return;
    const st = appState();
    const sameClips = (saved.clipIds || []).some(id => S.clipIds.includes(id)) && (saved.clipIds || []).every(id => st.clips.some(c => c.id === id));
    const scenes = saved.scenes || [];
    const done = scenes.filter(sc => sc.status === 'done').length;
    if (!sameClips || (scenes.length && done === scenes.length)) return;
    S.saved = saved;
    $q('#scResumeText').innerHTML = scenes.length
      ? `<b>Geração anterior salva</b> · ${done} de ${scenes.length} cenas prontas${saved.style?.name ? ` · estilo “${esc(saved.style.name)}”` : ''}. Continue de onde parou: a transcrição, o plano e as cenas prontas são aproveitados.`
      : `<b>Geração anterior salva</b> · transcrição pronta (${(saved.segments || []).length} falas). Continue para planejar e gerar as cenas sem transcrever de novo.`;
    box.hidden = false;
  }

  /** Retoma o trabalho salvo: pula as etapas prontas e gera só o que falta */
  function resume() {
    const saved = S.saved;
    if (!saved || S.job?.running) return;
    const st = appState();
    const job = {
      running: false,
      controller: null,
      projectId: projectId(),
      form: saved.form,
      clipIds: saved.clipIds,
      base: saved.base,
      duration: saved.duration,
      groupId: saved.groupId,
      trackIndex: saved.trackIndex,
      segments: saved.segments,
      style: saved.style,
      scenes: (saved.scenes || []).map(sc => ({ ...sc, status: sc.status === 'done' ? 'done' : 'pending', message: sc.status === 'done' ? (sc.message || 'pronta') : '' })),
      undoPushed: false,
      usage: saved.usage || { input: 0, output: 0 },
      project: { w: st.project.res.w, h: st.project.res.h, fps: st.project.fps },
      model: '',
    };
    // Mesma track das cenas que já estão na timeline
    const placed = st.clips.find(c => c.aiSceneGroupId === job.groupId);
    job.trackIndex = placed ? placed.trackIndex : pickTrack(job);
    S.job = job;
    S.saved = null;
    runPipeline(job);
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
    S.job?.task?.update({ detail: text });
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
      libs:        [...els.modal.querySelectorAll('.sc-lib')].filter(i => i.checked).map(i => i.value),
    };
  }

  function start() {
    const sources = sourcesOf(S.clipIds);
    if (!sources.length) { close(); return; }
    const span = spanOf(sources);
    const form = readForm();
    if (form.styleMode === 'custom' && !form.styleText) {
      $q('#scStyleText').focus();
      $q('#scStyleText').classList.add('is-invalid');
      setTimeout(() => $q('#scStyleText').classList.remove('is-invalid'), 1200);
      return;
    }
    savePrefs(form);
    discardSaved();   // começar de novo substitui o trabalho salvo
    S.saved = null;

    const st = appState();
    const job = {
      running: true,
      controller: new AbortController(),
      projectId: projectId(),
      form,
      clipIds: sources.map(s => s.clip.id),
      base: span.base,
      duration: span.duration,
      groupId: 'aiscene_' + (window.mkId ? window.mkId() : Date.now().toString(36)),
      trackIndex: null,
      segments: null,
      style: null,
      scenes: [],
      undoPushed: false,
      usage: { input: 0, output: 0 },
      project: { w: st.project.res.w, h: st.project.res.h, fps: st.project.fps },
      model: '',
    };
    S.job = job;
    runPipeline(job);
  }

  function startTask(job) {
    job.task?.close();
    job.task = window.MSUI.task({
      title: 'Cenas com IA',
      detail: 'Preparando…',
      progress: job.scenes.length ? job.scenes.filter(s => s.status === 'done').length / job.scenes.length : null,
      onCancel: () => cancel(),
      onOpen: () => { els.modal.style.display = 'flex'; },
    });
  }

  /** transcrever → planejar → gerar; etapas já prontas no job (retomada/nova tentativa) são puladas */
  async function runPipeline(job) {
    job.running = true;
    job.failure = null;
    job.controller = new AbortController();
    const form = job.form;

    // Cartão de progresso fixo: o modal pode ser fechado e a geração segue (clicar no cartão reabre)
    startTask(job);

    showView('run');
    setStep('transcribe', job.segments ? 'done' : '');
    setStep('plan', job.scenes.length ? 'done' : '');
    setStep('generate', '');
    $q('#scStyle').hidden = true;
    $q('#scList').innerHTML = '';
    if (job.style) renderStyle(job.style);
    if (job.scenes.length) renderScenes();

    try {
      // 1. Transcrição (reaproveita se o mesmo trecho já foi transcrito)
      if (!job.segments) {
        const sources = sourcesOf(job.clipIds);
        if (!sources.length) throw new Error('Os clips de áudio desta geração não estão mais na timeline.');
        setStep('transcribe', 'active');
        setStatus('Preparando a transcrição…');
        // Cada clip é transcrito no seu trecho; as falas vão para o tempo da
        // timeline (relativo ao início do 1º clip) e formam um roteiro só
        const segments = [];
        for (const [i, src] of sources.entries()) {
          const part = sources.length > 1 ? ` ${i + 1} de ${sources.length}` : '';
          const transcript = await window.__transcribeClip(src.clip.id, {
            language: form.language,
            onProgress: ({ stage, status }) => {
              if (stage === 'model') setStatus(status?.message || 'Carregando o modelo de transcrição…');
              if (stage === 'transcribe') setStatus(status?.device === 'cuda' ? `Transcrevendo${part} (GPU)…` : `Transcrevendo${part} em CPU — pode levar alguns minutos…`);
            },
          });
          if (!job.running) return;
          const offset = src.clip.start - job.base;
          (transcript.segments || []).forEach(sg => {
            const a = Math.max(0, +sg.start);
            const b = Math.min(src.clip.duration, +sg.start + +sg.duration);
            if (b > a) segments.push({ start: +(offset + a).toFixed(3), end: +(offset + b).toFixed(3), text: sg.text });
          });
        }
        segments.sort((a, b) => a.start - b.start);
        job.segments = segments;
        persist(job, { now: true });
      }
      setStep('transcribe', 'done');

      // 2. Plano: cenas + guia de estilo único
      if (!job.scenes.length) {
        setStep('plan', 'active');
        setStatus(job.segments.length ? `${job.segments.length} falas transcritas · planejando as cenas…` : 'Sem fala detectada · planejando pela duração…');
        const plan = await streamNdjson('/api/ai/scenes/plan', {
          transcript: { duration: job.duration, segments: job.segments },
          style: { mode: form.styleMode, text: form.styleText },
          brief: form.brief,
          sceneLength: form.sceneLength,
          background: form.background,
          project: job.project,
          model: job.model || undefined,
        }, { signal: job.controller.signal, onEvent: ev => { if (ev.type === 'status') setStatus(ev.message); } });
        if (!job.running) return;
        addUsage(job, plan.usage);
        job.style = plan.style;
        job.scenes = plan.scenes.map((sc, index) => ({ ...sc, index, status: 'pending', message: '' }));
        job.trackIndex = pickTrack(job);
        persist(job, { now: true });
        renderStyle(job.style);
        renderScenes();
      }
      setStep('plan', 'done');

      // 3. Cenas em ordem, cada uma a partir da anterior; entram na timeline ao terminar
      await generatePending(job);
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'aborted') {
        setStatus('Geração interrompida. O progresso está salvo — dá para continuar depois.');
      } else {
        const stage = job.scenes.length ? 'generate' : (job.segments ? 'plan' : 'transcribe');
        setStep(stage, 'error');
        job.failure = { stage, code: err.code, message: err.message };
        setStatus(`${err.message || 'Falha ao gerar as cenas.'}${job.segments ? ' O progresso foi salvo.' : ''}`, 'error');
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
      persist(job);
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
        libs: Array.isArray(job.form.libs) ? job.form.libs : [],
        model: job.model || undefined,
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
          if (ev.type === 'status' && (ev.rotatedFrom || ev.retrying || ev.waiting || ev.issues)) {
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
        // Sem cota/resposta em nenhum modelo: as próximas falhariam igual
        if (err.code === 'all_models_exhausted' || err.code === 'no_key' || err.code === 'invalid_key') {
          job.failure = { stage: 'generate', code: err.code, message: err.message };
          job.scenes.forEach(s => { if (s.status === 'pending') { s.status = 'error'; s.message = 'não gerada (modelo indisponível)'; renderScene(s); } });
        }
      }
    }
    renderScene(scene);
  }

  /** Nova tentativa: do estágio que falhou (transcrição/plano) ou só das cenas que falharam */
  async function retry(index = null) {
    const job = S.job;
    if (!job || job.running) return;
    // Modelo escolhido na tela de recuperação ('' = automático)
    const sel = $q('#scModel');
    if (sel && !$q('#scRecover').hidden) job.model = sel.value;
    if (!job.scenes.length) return runPipeline(job);
    return retryFailed(index);
  }

  async function retryFailed(index = null) {
    const job = S.job;
    if (!job || job.running) return;
    job.scenes.forEach(sc => {
      if (sc.status === 'error' && (index == null || sc.index === index)) { sc.status = 'pending'; sc.message = ''; renderScene(sc); }
    });
    job.running = true;
    job.failure = null;
    job.controller = new AbortController();
    startTask(job);
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
    // Tudo pronto: não há o que retomar. Senão, guarda o progresso para continuar depois
    if (job.scenes.length && done === job.scenes.length) discardSaved(job.projectId);
    else persist(job, { now: true });
    if (job.scenes.length) {
      const tokens = job.usage.input + job.usage.output;
      $q('#scFootnote').textContent = tokens ? `${tokens.toLocaleString('pt-BR')} tokens` : '';
      if (!$q('#scStatus').classList.contains('is-error') || done) {
        setStatus(failed
          ? `${done} de ${job.scenes.length} cenas prontas · ${failed} não foram geradas. O progresso está salvo.`
          : `${done} cenas prontas na timeline, alinhadas ao áudio.`, failed ? 'error' : '');
      }
    }
    showView('finished');
    // Cartão: concluído, ou falha (o quadro de recuperação continua disponível no modal)
    if (job.scenes.length && done === job.scenes.length) job.task?.done(`${done} cenas na timeline`);
    else if (job.failure) job.task?.fail(job.failure.message || 'Falhou — o progresso está salvo');
    else if (failed) job.task?.fail(`${failed} cena(s) não geradas — o progresso está salvo`);
    else job.task?.close();
  }

  function addUsage(job, usage) {
    job.usage.input += Number(usage?.input) || 0;
    job.usage.output += Number(usage?.output) || 0;
  }

  function updateProgress(job) {
    const total = job.scenes.length;
    const done = job.scenes.filter(s => s.status === 'done').length;
    if (job.running) setStatus(`Gerando cenas · ${done} de ${total} prontas`);
    job.task?.update({ progress: total ? done / total : null });
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
  window.MotionAIScenes = { open, close, cancel, resume };
})();
