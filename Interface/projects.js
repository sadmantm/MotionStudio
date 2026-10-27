'use strict';
// projects.js
//
//  Biblioteca de projetos (estilo CapCut): a tela inicial lista os projetos
//  salvos pelo servidor (libs/projects.js), cria, abre, renomeia, duplica e
//  exclui. Com um projeto aberto:
//    • as mídias importadas são copiadas para a pasta do projeto
//      (template.mediaUrl) — blob: não sobrevive a um reload;
//    • autosave: assinatura barata do estado a cada segundo, PUT quando muda;
//    • capa da lista gerada a partir do primeiro clip visual.

(() => {
  const API          = '/api/projects';
  const AUTOSAVE_MS  = 1200;          // espera depois da última mudança
  const THUMB_EVERY  = 45_000;        // capa no máximo a cada 45 s
  const LAST_KEY     = 'ms.lastProjectId';

  const PRESETS = [
    { id: 'reels',   label: 'Reels · TikTok · Shorts', ratio: '9:16', w: 1080, h: 1920 },
    { id: 'youtube', label: 'YouTube · Paisagem',      ratio: '16:9', w: 1920, h: 1080 },
    { id: 'square',  label: 'Quadrado',                ratio: '1:1',  w: 1080, h: 1080 },
    { id: 'feed',    label: 'Feed Instagram',          ratio: '4:5',  w: 1080, h: 1350 },
  ];

  const S = {
    id: null,            // projeto aberto (id do servidor)
    lastSig: '',
    changedAt: 0,
    saving: null,        // Promise do save em andamento
    again: false,
    uploads: new Map(),  // templateId → Promise do envio da mídia
    lastThumb: 0,
    list: [],
    query: '',
    el: null,
  };

  // #region API
  async function api(method, url, body, headers = {}) {
    const opts = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (body instanceof Blob) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    const resp = await fetch(url, opts);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }
  // #endregion

  // #region Utilitários
  const esc = v => window.escapeHtml ? escapeHtml(v) : String(v ?? '');
  const st  = () => window.__appState;

  function setSaveState(kind, text) {
    const chip = document.getElementById('mbProject');
    if (!chip) return;
    chip.dataset.state = kind;
    chip.querySelector('.mbp-state').textContent = text;
  }

  function renderProjectChip() {
    let chip = document.getElementById('mbProject');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'mbProject';
      chip.className = 'mb-project';
      chip.innerHTML = `
        <button class="mbp-home" title="Todos os projetos">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </button>
        <span class="mbp-name" title="Clique duas vezes para renomear"></span>
        <span class="mbp-state"></span>`;
      document.querySelector('.mb-status')?.before(chip);
      chip.querySelector('.mbp-home').addEventListener('click', () => showHome());
      chip.querySelector('.mbp-name').addEventListener('dblclick', renameCurrent);
    }
    chip.hidden = !S.id;
    chip.querySelector('.mbp-name').textContent = st()?.project?.name || '';
    document.title = S.id ? `${st().project.name} — Motion Studio` : 'Motion Studio';
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'agora mesmo';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    if (s < 172800) return 'ontem';
    return new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtBytes(n) {
    if (!(n > 0)) return '0 MB';
    return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
  }

  function ratioLabel(w, h) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(w, h) || 1;
    const known = PRESETS.find(p => p.w * h === p.h * w);
    return known ? known.ratio : `${w / g}:${h / g}`;
  }
  // #endregion

  // #region Mídia → pasta do projeto
  // Camadas SVG (sólido, forma…) vivem inline no projeto: não são arquivos de mídia
  const isMedia = t => t && !t.layer && (t.type === 'video' || t.type === 'audio' || t.type === 'image');

  /** Envia o arquivo/Blob de um template para a pasta do projeto (uma vez) */
  function persistMedia(template, source = null) {
    if (!S.id || !isMedia(template) || template.mediaUrl) return Promise.resolve();
    if (S.uploads.has(template.id)) return S.uploads.get(template.id);
    const projectId = S.id;
    const job = (async () => {
      const blob = source instanceof Blob
        ? source
        : await (await fetch(template.dataUrl || template.objectUrl)).blob();
      const ext = (blob.type.split('/')[1] || '').split(';')[0].replace('mpeg', 'mp3').replace('x-wav', 'wav');
      const name = source?.name || `${template.name || 'media'}${ext ? '.' + ext : ''}`;
      const out = await api('POST', `${API}/${projectId}/media?name=${encodeURIComponent(name)}`, blob,
        { 'Content-Type': blob.type || 'application/octet-stream' });
      // Trocou de projeto no meio do envio: o arquivo fica no projeto antigo
      if (S.id !== projectId) return;
      template.mediaUrl  = out.url;
      template.mediaFile = out.file;
      template.fileSize  = template.fileSize || out.size;
      // Mídia já no servidor: a URL de lá é a fonte (blob: continua valendo até o reload)
      if (!/^blob:/i.test(template.dataUrl || '')) template.dataUrl = out.url;
      if (out.proxy?.needed) watchProxy(template, projectId, out.proxy);
    })().finally(() => S.uploads.delete(template.id));
    S.uploads.set(template.id, job);
    job.catch(err => {
      console.warn('[Projetos] mídia não enviada:', template.name, err.message);
      setSaveState('error', 'mídia não salva');
    });
    return job;
  }

  /**
   * Proxy H.264 de vídeo que o navegador não toca (libs/media-proxy.js): o
   * servidor gera em segundo plano; quando fica pronto o preview e o export
   * passam a usar a cópia (template.proxyUrl) e os clips são remontados.
   */
  const proxyWatch = new Map();   // template.id → true
  function watchProxy(template, projectId, first = null) {
    if (proxyWatch.has(template.id) || template.proxyUrl) return;
    proxyWatch.set(template.id, true);
    const url = `${API}/${projectId}/media/${encodeURIComponent(template.mediaFile)}/proxy`;
    const why = first?.reasons?.length ? ` (${first.reasons.join(', ')})` : '';
    let task = null;
    const finish = info => {
      proxyWatch.delete(template.id);
      if (S.id !== projectId) return;
      template.proxyUrl = info.url;
      template.proxyFile = decodeURIComponent(String(info.url).split('/').pop());
      (st()?.clips || []).filter(c => c.templateId === template.id).forEach(c => window.remountClip?.(c.id));
      window.__refreshTimelineThumbs?.();
      S.changedAt = Date.now();
      task?.done('Pronto: o preview já usa a cópia otimizada');
    };
    const tick = async () => {
      if (S.id !== projectId) { proxyWatch.delete(template.id); task?.close(); return; }
      try {
        const info = await api('GET', url);
        if (!info.needed) { proxyWatch.delete(template.id); task?.close(); return; }
        if (info.status === 'done') return finish(info);
        if (info.status === 'error') {
          proxyWatch.delete(template.id);
          (task || window.MSUI.task({ title: `Otimizando "${template.name}"` })).fail(`Falha ao converter: ${info.error || 'erro no ffmpeg'}`);
          return;
        }
        task = task || window.MSUI.task({ title: `Otimizando "${template.name}" para o editor`, detail: `Convertendo para H.264${why || (info.reasons?.length ? ` (${info.reasons.join(', ')})` : '')}…`, progress: 0 });
        task.update({ progress: info.progress || 0 });
      } catch (_) { /* servidor ocupado: tenta de novo */ }
      setTimeout(tick, 1500);
    };
    tick();
  }

  /** Projeto aberto: vídeos antigos sem proxy ganham um se precisarem */
  function checkProxies() {
    const projectId = S.id;
    (st()?.templates || [])
      .filter(t => t.type === 'video' && t.mediaFile && !t.proxyUrl)
      .forEach(t => watchProxy(t, projectId));
  }

  /** Templates de mídia criados por outras partes (SFX, áudio extraído, gravação) */
  function persistPendingMedia() {
    return Promise.all((st()?.templates || [])
      .filter(t => isMedia(t) && !t.mediaUrl && /^(blob|data):/i.test(t.dataUrl || t.objectUrl || ''))
      .map(t => persistMedia(t).catch(() => {})));
  }
  // #endregion

  // #region Serialização e autosave
  function portableTemplate(t) {
    const out = { ...t };
    delete out.objectUrl;
    delete out.isObjectUrl;
    if (out.mediaUrl) out.dataUrl = out.mediaUrl;
    delete out.mediaUrl;
    return out;
  }

  function payload() {
    const state = st();
    return {
      signature: 'MOTION_STUDIO_PROJECT',
      format: 'motion-studio-project',
      version: 1,
      savedAt: new Date().toISOString(),
      project: { ...state.project, id: S.id },
      templates: state.templates.map(portableTemplate),
      clips: state.clips,
      tracks: state.tracks || [],
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

  /** Muda quando algo que vale salvar muda (não inclui playhead/zoom) */
  function signature() {
    const state = st();
    if (!state?.project) return '';
    const { totalDuration, updatedAt, ...project } = state.project;
    return JSON.stringify([
      project,
      state.clips,
      state.tracks,
      state.markers,
      state.templates.map(t => [t.id, t.name, t.type, t.mediaUrl || '', t.color, t.sourceDuration,
        t.textParams, t.html?.length, t.html?.slice(0, 48), t.html?.slice(-48), t.layer]),
    ]);
  }

  async function saveNow({ thumb = false } = {}) {
    if (!S.id || !st()?.project) return;
    if (S.saving) { S.again = true; return S.saving; }
    S.saving = (async () => {
      setSaveState('saving', 'Salvando…');
      try {
        await persistPendingMedia();
        await Promise.all([...S.uploads.values()].map(p => p.catch(() => {})));
        const sig = signature();
        await api('PUT', `${API}/${S.id}`, payload());
        S.lastSig = sig;
        setSaveState('saved', 'Salvo');
        if (thumb || Date.now() - S.lastThumb > THUMB_EVERY) updateThumb();
      } catch (err) {
        console.warn('[Projetos] autosave:', err.message);
        setSaveState('error', 'Erro ao salvar');
        throw err;
      }
    })().finally(() => {
      S.saving = null;
      if (S.again) { S.again = false; saveNow().catch(() => {}); }
    });
    return S.saving;
  }

  function autosaveTick() {
    if (!S.id || !st()?.project) return;
    // Arrastando/redimensionando: espera soltar
    if (typeof _isInteracting !== 'undefined' && _isInteracting) return;
    const sig = signature();
    if (sig === S.lastSig) return;
    if (!S.changedAt) { S.changedAt = Date.now(); setSaveState('dirty', 'Alterações'); return; }
    if (Date.now() - S.changedAt < AUTOSAVE_MS) return;
    S.changedAt = 0;
    saveNow().catch(() => {});
  }
  // #endregion

  // #region Capa do projeto
  function firstVisualClip() {
    const state = st();
    const typeOf = c => state.templates.find(t => t.id === c.templateId)?.type;
    return [...state.clips]
      .filter(c => typeOf(c) && typeOf(c) !== 'audio')
      .sort((a, b) => a.start - b.start || (b.trackIndex || 0) - (a.trackIndex || 0))[0];
  }

  async function updateThumb() {
    const state = st();
    const clip = state && firstVisualClip();
    if (!clip || !S.id) return;
    S.lastThumb = Date.now();
    const tmpl = state.templates.find(t => t.id === clip.templateId);
    const { w, h } = state.project.res;
    try {
      let blob;
      if (tmpl.type === 'html' || tmpl.type === 'text') {
        const t = Math.min((Number(clip.trimStart) || 0) + Math.min(clip.duration * 0.5, 2), (tmpl.sourceDuration || clip.duration) - 0.05);
        const resp = await api('POST', '/api/thumbs/html', { html: tmpl.html, w, h, times: [Math.max(0, t)], height: 240 });
        blob = await (await fetch(resp.frames[0].url)).blob();
      } else {
        blob = await mediaFrameBlob(tmpl, clip, w, h);
      }
      if (blob) await api('POST', `${API}/${S.id}/thumb`, blob, { 'Content-Type': blob.type });
    } catch (err) {
      console.warn('[Projetos] capa:', err.message);
    }
  }

  /** Quadro de vídeo/imagem no enquadramento do projeto (fundo + caixa do clip) */
  async function mediaFrameBlob(tmpl, clip, w, h) {
    const H = 240, W = Math.round(H * w / h);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = st().project.background || '#000';
    ctx.fillRect(0, 0, W, H);
    const src = tmpl.dataUrl || tmpl.objectUrl;
    let el;
    if (tmpl.type === 'image') {
      el = new Image();
      el.src = src;
      await el.decode();
    } else {
      el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      el.src = src;
      await new Promise((ok, fail) => { el.onloadeddata = ok; el.onerror = fail; setTimeout(fail, 8000); });
      el.currentTime = Math.min((Number(clip.trimStart) || 0) + 0.5, (el.duration || 1) - 0.05);
      await new Promise((ok, fail) => { el.onseeked = ok; setTimeout(fail, 8000); });
    }
    const tx = clip._tx || { x: 0, y: 0, w, h };
    const k = W / w;
    ctx.drawImage(el, tx.x * k, tx.y * k, tx.w * k, tx.h * k);
    if (el.tagName === 'VIDEO') { el.removeAttribute('src'); el.load(); }
    return new Promise(ok => canvas.toBlob(ok, 'image/jpeg', 0.82));
  }
  // #endregion

  // #region Abrir / criar
  async function leaveCurrent() {
    if (!S.id) return;
    try { await saveNow({ thumb: true }); } catch (_) { /* segue: o usuário vê "Erro ao salvar" */ }
  }

  async function open(id) {
    await leaveCurrent();
    setHomeBusy(true, 'Abrindo projeto…');
    try {
      const data = await api('GET', `${API}/${id}`);
      // Mídias da pasta do projeto: a URL do servidor é a fonte e o endereço salvo
      (data.templates || []).forEach(t => {
        if (isMedia(t) && /^\/api\/projects\//.test(t.dataUrl || '')) t.mediaUrl = t.dataUrl;
      });
      S.id = id;
      applyProjectPayload(data, data.project?.name || 'Projeto');
      // Pôsteres da aba Texto dependem da resolução do projeto
      if (typeof renderTextPanel === 'function') renderTextPanel();
      S.lastSig = signature();
      S.changedAt = 0;
      S.lastThumb = 0;   // capa no primeiro save (projeto antigo pode não ter)
      checkProxies();
      try { localStorage.setItem(LAST_KEY, id); } catch (_) { /* sem storage */ }
      renderProjectChip();
      setSaveState('saved', 'Salvo');
      hideHome();
    } catch (err) {
      window.MSUI.notify(`Não foi possível abrir o projeto: ${err.message}`);
      S.id = null;
    } finally {
      setHomeBusy(false);
    }
  }

  async function create(opts) {
    setHomeBusy(true, 'Criando projeto…');
    try {
      const meta = await api('POST', API, opts);
      await open(meta.id);
    } catch (err) {
      window.MSUI.notify(`Não foi possível criar o projeto: ${err.message}`);
    } finally {
      setHomeBusy(false);
    }
  }

  /** .ms (arquivo exportado) → projeto novo na biblioteca */
  async function importPayload(data, name) {
    setHomeBusy(true, 'Importando projeto…');
    try {
      data.project = { ...data.project, name: data.project?.name || name || 'Projeto importado' };
      const meta = await api('POST', `${API}/import`, data);
      await open(meta.id);
      return true;
    } catch (err) {
      window.MSUI.notify(`Não foi possível importar: ${err.message}`);
      return false;
    } finally {
      setHomeBusy(false);
    }
  }

  /**
   * Arquivo .ms → projeto novo, com progresso: o arquivo sobe cru (sem
   * JSON.parse/stringify aqui, que travavam a página com mídias grandes) e o
   * servidor conta as mídias gravadas. Faixas da barra: envio 0–70 %,
   * leitura no servidor 70–76 %, mídias 76–94 %, abertura 94–100 %.
   */
  async function importFile(file) {
    const prog = importProgress(file);
    try {
      prog.phase('upload', 'Enviando arquivo…', 0, 70);
      const meta = await postImport(file, {
        upload: (loaded, total) => prog.set(loaded / total, `${fmtBytes(loaded)} de ${fmtBytes(total)}`),
        uploaded: () => { prog.cancellable(false); prog.phase('media', 'Lendo o projeto…', 70, 76, { creep: true }); },
        media: ({ done, total, name }) => {
          if (!total) return;
          prog.phase('media', 'Gravando mídias…', 76, 94);
          prog.set(done / total, `${done} de ${total}${name ? ` · ${name}` : ''}`);
        },
      }, prog);
      prog.phase('open', 'Abrindo projeto…', 94, 100, { creep: true });
      await open(meta.id);
      if (S.id !== meta.id) { prog.close(); return false; }   // open() já avisou o erro
      await prog.finish();
      return true;
    } catch (err) {
      prog.close();
      if (!err.aborted) window.MSUI.notify(`Não foi possível importar: ${err.message}`);
      return false;
    }
  }

  /** POST do arquivo com progresso de envio (XHR) e leitura do NDJSON do servidor */
  function postImport(file, hooks, prog) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/import?name=${encodeURIComponent(file.name.replace(/\.ms$/i, ''))}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('Accept', 'application/x-ndjson');
      prog.onCancel(() => xhr.abort());

      let seen = 0;
      let meta = null;
      let error = null;
      const readLines = () => {
        const text = xhr.responseText || '';
        const end = text.lastIndexOf('\n');
        if (end < seen) return;
        for (const line of text.slice(seen, end).split('\n')) {
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (msg.type === 'progress') hooks.media(msg);
          else if (msg.type === 'done') meta = msg.meta;
          else if (msg.type === 'error') error = msg.error;
        }
        seen = end + 1;
      };

      xhr.upload.onprogress = e => { if (e.lengthComputable && e.total) hooks.upload(e.loaded, e.total); };
      xhr.upload.onload = () => hooks.uploaded();
      xhr.onprogress = readLines;
      xhr.onload = () => {
        if (xhr.status >= 400) {
          let msg = '';
          try { msg = JSON.parse(xhr.responseText).error; } catch (_) { /* página de erro do express */ }
          if (!msg && xhr.status === 413) msg = 'arquivo grande demais.';
          if (!msg && xhr.status === 400) msg = 'o arquivo não é um JSON válido (corrompido?).';
          return reject(new Error(msg || `HTTP ${xhr.status}`));
        }
        readLines();
        if (error) reject(new Error(error));
        else if (meta) resolve(meta);
        else reject(new Error('resposta incompleta do servidor.'));
      };
      xhr.onerror = () => reject(new Error('sem conexão com o servidor.'));
      xhr.onabort = () => reject(Object.assign(new Error('Importação cancelada.'), { aborted: true }));
      xhr.send(file);
    });
  }

  /**
   * Overlay de importação. A barra é desenhada a cada quadro e persegue o
   * valor real com suavização; nas fases sem eventos (servidor lendo o JSON,
   * abertura) avança sozinha devagar rumo a um teto que nunca alcança.
   */
  function importProgress(file) {
    const el = document.createElement('div');
    el.className = 'ms-import';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'msImportTitle');
    el.innerHTML = `
      <div class="ms-import-card">
        <div class="ms-import-head">
          <div class="ms-import-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
          </div>
          <div class="ms-import-titles">
            <div class="ms-import-title" id="msImportTitle">Importando projeto</div>
            <div class="ms-import-file"></div>
          </div>
          <div class="ms-import-pct">0%</div>
        </div>
        <div class="ms-import-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
        <div class="ms-import-foot">
          <span class="ms-import-stage" aria-live="polite"></span>
          <span class="ms-import-detail"></span>
        </div>
        <ol class="ms-import-steps">
          <li data-step="upload">Envio</li>
          <li data-step="media">Mídias</li>
          <li data-step="open">Abertura</li>
        </ol>
        <button type="button" class="ms-import-cancel">Cancelar</button>
      </div>`;
    el.querySelector('.ms-import-file').textContent = `${file.name} · ${fmtBytes(file.size)}`;
    document.body.appendChild(el);

    const $ = sel => el.querySelector(sel);
    const bar = $('.ms-import-bar');
    const fill = $('.ms-import-bar i');
    const pct = $('.ms-import-pct');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const steps = ['upload', 'media', 'open'];

    let shown = 0;         // valor desenhado
    let target = 0;        // valor real (ou estimado) a alcançar
    let cap = 0;           // teto da subida automática da fase atual
    let range = [0, 0];
    let current = '';
    let last = performance.now();
    let raf = 0;
    let cancel = null;

    function frame(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (cap > target) target += (cap - target) * (1 - Math.exp(-dt / 2.5));
      shown = reduce ? target : shown + (target - shown) * (1 - Math.exp(-dt / 0.14));
      if (Math.abs(target - shown) < 0.05) shown = target;
      fill.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
      const value = Math.floor(shown);
      if (pct.textContent !== `${value}%`) {
        pct.textContent = `${value}%`;
        bar.setAttribute('aria-valuenow', String(value));
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    requestAnimationFrame(() => el.classList.add('is-open'));

    $('.ms-import-cancel').addEventListener('click', () => cancel?.());

    return {
      /** Fase from–to (%). creep: sem eventos reais, a barra anda sozinha até ~85 % da faixa */
      phase(step, label, from, to, { creep = false } = {}) {
        $('.ms-import-stage').textContent = label;
        if (step !== current) {
          current = step;
          $('.ms-import-detail').textContent = '';
          steps.forEach((s, i) => {
            const li = $(`[data-step="${s}"]`);
            li.classList.toggle('is-done', i < steps.indexOf(step));
            li.classList.toggle('is-active', s === step);
          });
        }
        range = [from, to];
        target = Math.max(target, from);
        cap = creep ? from + (to - from) * 0.85 : target;
      },
      set(fraction, detail) {
        const [from, to] = range;
        target = Math.max(target, from + (to - from) * Math.min(1, Math.max(0, fraction)));
        cap = Math.max(cap, target);
        if (detail != null) $('.ms-import-detail').textContent = detail;
      },
      cancellable(on) { $('.ms-import-cancel').hidden = !on; },
      onCancel(fn) { cancel = fn; },
      /** Completa a barra e fecha com um breve estado de concluído */
      async finish() {
        target = cap = 100;
        $('.ms-import-cancel').hidden = true;
        $('.ms-import-stage').textContent = 'Projeto importado';
        $('.ms-import-detail').textContent = '';
        steps.forEach(s => { const li = $(`[data-step="${s}"]`); li.classList.remove('is-active'); li.classList.add('is-done'); });
        const started = performance.now();
        while (shown < 99.9 && performance.now() - started < 700) await new Promise(r => requestAnimationFrame(r));
        el.classList.add('is-done');
        await new Promise(r => setTimeout(r, reduce ? 150 : 450));
        this.close();
      },
      close() {
        el.classList.remove('is-open');
        el.classList.add('is-leaving');
        setTimeout(() => { cancelAnimationFrame(raf); el.remove(); }, reduce ? 0 : 220);
      },
    };
  }

  async function renameCurrent() {
    if (!S.id) return;
    const name = await window.MSUI.prompt({ title: 'Renomear projeto', label: 'Nome do projeto', value: st().project.name, confirmLabel: 'Renomear' });
    if (!name?.trim()) return;
    st().project.name = name.trim();
    renderProjectChip();
    await saveNow().catch(() => {});
  }
  // #endregion

  // #region Tela inicial
  function buildHome() {
    if (S.el) return S.el;
    const el = document.createElement('div');
    el.id = 'projectHome';
    el.className = 'ph';
    el.innerHTML = `
      <header class="ph-top">
        <div class="ph-brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" stroke="#82ea00" stroke-width="2"/><polygon points="10,7 17,12 10,17" fill="#82ea00"/></svg>
          <div><strong>Motion Studio</strong><span>Editor de vídeo com HTML, mídia e IA</span></div>
        </div>
        <button class="ph-back" data-ph="back" hidden>Voltar ao projeto aberto ›</button>
      </header>

      <main class="ph-main">
        <section class="ph-new">
          <h2>Novo projeto</h2>
          <div class="ph-presets">
            ${PRESETS.map(p => `
              <button class="ph-preset" data-ph="preset" data-w="${p.w}" data-h="${p.h}">
                <span class="ph-preset-shape" style="aspect-ratio:${p.w}/${p.h}"></span>
                <span class="ph-preset-ratio">${p.ratio}</span>
                <span class="ph-preset-label">${p.label}</span>
                <span class="ph-preset-res">${p.w} × ${p.h}</span>
              </button>`).join('')}
            <button class="ph-preset ph-preset-custom" data-ph="custom">
              <span class="ph-preset-plus">+</span>
              <span class="ph-preset-ratio">Personalizado</span>
              <span class="ph-preset-label">Resolução, fps e fundo</span>
            </button>
          </div>
        </section>

        <section class="ph-list">
          <div class="ph-list-head">
            <h2>Projetos <small id="phCount"></small></h2>
            <div class="ph-list-tools">
              <input id="phSearch" class="ph-search" placeholder="Buscar projetos…" autocomplete="off">
              <button class="ph-btn" data-ph="import" title="Abrir um arquivo .ms exportado">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                Importar .ms
              </button>
            </div>
          </div>
          <div class="ph-grid" id="phGrid"></div>
          <div class="ph-empty" id="phEmpty" hidden>
            <p>Nenhum projeto ainda.</p>
            <small>Escolha um formato acima para começar.</small>
          </div>
        </section>
      </main>

      <div class="ph-busy" id="phBusy" hidden><div class="ph-spinner"></div><span></span></div>

      <div class="ph-dialog-wrap" id="phDialog" hidden>
        <form class="ph-dialog" id="phNewForm">
          <h3>Novo projeto</h3>
          <label>Nome<input name="name" class="prop-input full" value="Projeto sem título" maxlength="120" required></label>
          <div class="ph-row">
            <label>Largura<input name="w" type="number" class="prop-input full" value="1080" min="16" max="7680" step="2"></label>
            <label>Altura<input name="h" type="number" class="prop-input full" value="1920" min="16" max="7680" step="2"></label>
          </div>
          <div class="ph-row">
            <label>Quadros por segundo
              <select name="fps" class="prop-input full">
                ${[24, 25, 30, 50, 60].map(f => `<option value="${f}"${f === 30 ? ' selected' : ''}>${f} fps</option>`).join('')}
              </select>
            </label>
            <label>Fundo<input name="background" type="color" value="#000000" class="ph-color"></label>
          </div>
          <div class="ph-dialog-foot">
            <button type="button" class="btn-secondary" data-ph="cancel">Cancelar</button>
            <button type="submit" class="export-btn">Criar projeto</button>
          </div>
        </form>
      </div>

      <div class="ph-menu" id="phMenu" hidden>
        <button data-act="open">Abrir</button>
        <button data-act="rename">Renomear</button>
        <button data-act="duplicate">Duplicar</button>
        <button data-act="reveal">Mostrar na pasta</button>
        <hr>
        <button data-act="delete" class="danger">Excluir</button>
      </div>`;
    document.body.appendChild(el);
    S.el = el;

    el.addEventListener('click', onHomeClick);
    el.querySelector('#phSearch').addEventListener('input', e => { S.query = e.target.value.trim().toLowerCase(); renderList(); });
    el.querySelector('#phNewForm').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target);
      el.querySelector('#phDialog').hidden = true;
      create({
        name: String(f.get('name') || '').trim() || 'Projeto sem título',
        res: { w: Number(f.get('w')), h: Number(f.get('h')) },
        fps: Number(f.get('fps')),
        background: String(f.get('background')),
      });
    });
    document.addEventListener('keydown', e => {
      if (el.hidden || e.key !== 'Escape') return;
      if (!el.querySelector('#phDialog').hidden) el.querySelector('#phDialog').hidden = true;
      else if (!el.querySelector('#phMenu').hidden) el.querySelector('#phMenu').hidden = true;
      else if (S.id) hideHome();
    });
    return el;
  }

  function onHomeClick(e) {
    const el = S.el;
    const menu = el.querySelector('#phMenu');
    if (!e.target.closest('#phMenu') && !e.target.closest('[data-ph="more"]')) menu.hidden = true;

    const btn = e.target.closest('[data-ph]');
    if (btn) {
      const kind = btn.dataset.ph;
      if (kind === 'back') return hideHome();
      if (kind === 'preset') {
        const preset = PRESETS.find(p => p.w === +btn.dataset.w && p.h === +btn.dataset.h);
        return create({ name: `${preset?.ratio === '9:16' ? 'Vídeo vertical' : 'Projeto'} ${new Date().toLocaleDateString('pt-BR')}`, res: { w: +btn.dataset.w, h: +btn.dataset.h }, fps: 30 });
      }
      if (kind === 'custom') {
        el.querySelector('#phDialog').hidden = false;
        el.querySelector('#phNewForm [name="name"]').select();
        return;
      }
      if (kind === 'cancel') { el.querySelector('#phDialog').hidden = true; return; }
      if (kind === 'import') return chooseMsFile();
      if (kind === 'more') {
        e.stopPropagation();
        const r = btn.getBoundingClientRect();
        menu.dataset.id = btn.closest('[data-id]').dataset.id;
        menu.style.left = Math.min(window.innerWidth - 180, r.left) + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.hidden = false;
        return;
      }
    }

    const act = e.target.closest('#phMenu [data-act]');
    if (act) {
      menu.hidden = true;
      return projectAction(act.dataset.act, menu.dataset.id);
    }

    const card = e.target.closest('.ph-card[data-id]');
    if (card) open(card.dataset.id);
  }

  async function projectAction(act, id) {
    const meta = S.list.find(p => p.id === id);
    if (!meta) return;
    try {
      if (act === 'open') return open(id);
      if (act === 'rename') {
        const name = await window.MSUI.prompt({ title: 'Renomear projeto', label: 'Nome do projeto', value: meta.name, confirmLabel: 'Renomear' });
        if (!name?.trim()) return;
        await api('PATCH', `${API}/${id}`, { name: name.trim() });
        if (S.id === id) { st().project.name = name.trim(); S.lastSig = signature(); renderProjectChip(); }
      }
      if (act === 'duplicate') await api('POST', `${API}/${id}/duplicate`);
      if (act === 'reveal') await api('POST', `${API}/${id}/reveal`);
      if (act === 'delete') {
        // Sem pergunta: o projeto vai para a lixeira e o aviso oferece Desfazer
        const gone = await api('DELETE', `${API}/${id}`);
        if (S.id === id) closeCurrentProject();
        window.MSUI.toast({
          message: `Projeto “${meta.name}” excluído.`,
          kind: 'info',
          duration: 9000,
          action: gone?.trash ? {
            label: 'Desfazer',
            onClick: async () => {
              try { await api('POST', `${API}/restore`, { trash: gone.trash }); await refreshList(); window.MSUI.toast({ message: `Projeto “${meta.name}” restaurado.`, kind: 'ok' }); }
              catch (err) { window.MSUI.notify(err.message); }
            },
          } : null,
        });
      }
      await refreshList();
    } catch (err) {
      window.MSUI.notify(err.message);
    }
  }

  function closeCurrentProject() {
    S.id = null;
    S.lastSig = '';
    clearCurrentProjectRuntime();
    renderProjectChip();
  }

  async function refreshList() {
    try {
      const { projects } = await api('GET', API);
      S.list = projects;
    } catch (err) {
      S.list = [];
      console.warn('[Projetos] lista:', err.message);
    }
    renderList();
  }

  function renderList() {
    const el = S.el;
    const grid = el.querySelector('#phGrid');
    const items = S.list.filter(p => !S.query || p.name.toLowerCase().includes(S.query));
    el.querySelector('#phCount').textContent = S.list.length ? `· ${S.list.length}` : '';
    el.querySelector('#phEmpty').hidden = S.list.length > 0;
    grid.innerHTML = items.map(p => {
      const portrait = p.res.h > p.res.w;
      return `
        <div class="ph-card${p.id === S.id ? ' is-open' : ''}" data-id="${esc(p.id)}" tabindex="0">
          <div class="ph-thumb">
            ${p.thumb
              ? `<img src="${esc(p.thumb)}" alt="" class="${portrait ? 'is-portrait' : ''}" loading="lazy">`
              : `<span class="ph-thumb-empty" style="aspect-ratio:${p.res.w}/${p.res.h}"></span>`}
            <span class="ph-dur">${fmtDur(p.duration)}</span>
            ${p.id === S.id ? '<span class="ph-open-tag">Aberto</span>' : ''}
          </div>
          <div class="ph-card-info">
            <div class="ph-card-name" title="${esc(p.name)}">${esc(p.name)}</div>
            <div class="ph-card-meta">${relTime(p.updatedAt)} · ${ratioLabel(p.res.w, p.res.h)} · ${p.fps} fps</div>
          </div>
          <button class="ph-more" data-ph="more" title="Mais opções">⋯</button>
        </div>`;
    }).join('');
  }

  function setHomeBusy(on, text = '') {
    if (!S.el) return;
    const busy = S.el.querySelector('#phBusy');
    busy.hidden = !on;
    busy.querySelector('span').textContent = text;
  }

  async function showHome({ create: newDialog = false } = {}) {
    if (S.id) await leaveCurrent();
    const el = buildHome();
    el.hidden = false;
    el.querySelector('[data-ph="back"]').hidden = !S.id;
    document.body.classList.add('ph-open');
    await refreshList();
    if (newDialog) {
      el.querySelector('#phDialog').hidden = false;
      el.querySelector('#phNewForm [name="name"]').select();
    } else {
      el.querySelector('#phSearch').focus({ preventScroll: true });
    }
  }

  function hideHome() {
    if (!S.el) return;
    S.el.hidden = true;
    document.body.classList.remove('ph-open');
  }

  function chooseMsFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ms,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) openMotionStudioProject(file);
    }, { once: true });
    input.click();
  }
  // #endregion

  // #region Boot
  function boot() {
    renderProjectChip();
    setInterval(autosaveTick, 500);
    // Fechar a janela: última tentativa de salvar (mudanças dos últimos segundos)
    window.addEventListener('beforeunload', () => {
      if (S.id && signature() !== S.lastSig) {
        try {
          const body = JSON.stringify(payload());
          if (body.length < 60_000) fetch(`${API}/${S.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
        } catch (_) { /* sem rede */ }
      }
    });
    showHome();
  }

  window.MSProjects = {
    showHome, hideHome, open, create, saveNow, importPayload, importFile, persistMedia,
    currentId: () => S.id,
    usage: () => (S.id ? api('GET', `${API}/${S.id}/usage`) : Promise.resolve(null)),
    cleanupMedia: () => (S.id ? saveNow().then(() => api('POST', `${API}/${S.id}/media/cleanup`)) : Promise.resolve(null)),
    reveal: () => S.id && api('POST', `${API}/${S.id}/reveal`),
    rename: renameCurrent,
    refreshChip: renderProjectChip,
    fmtBytes,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  // #endregion
})();
