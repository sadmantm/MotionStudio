'use strict';
// camera-ai.js
//
//  Câmera 2D com IA: a IA decide os keyframes da câmera (posição, zoom, giro) a partir de
//    1) a transcrição do áudio (o que é dito e quando),
//    2) o tempo e a POSIÇÃO dos elementos nas cenas HTML abaixo da câmera (cada cena é aberta num
//       iframe invisível, posta em vários instantes e medida: texto, imagens, svg, caixas…),
//    3) opcionalmente quadros reais da cena (o Gemini enxerga o que cada elemento é).
//  Exemplo: o áudio fala do mapa no segundo 12, o elemento do mapa aparece em (780, 640) → a câmera
//  vai até ele um pouco antes e aproxima; depois volta ao enquadramento geral.
//  Mesmo padrão dos outros recursos de IA do app:
//    ✨ Gemini integrado (/api/ai/camera)  ·  📋 Copiar prompt de explicação (com os dados deste projeto)
//    ·  📥 Colar o JSON que outra IA devolveu (validado em /api/camera/normalize).
//  O formato e as regras ficam em libs/camera-spec.js (também em /api/camera/spec).

(() => {
  const st = () => window.__appState;
  const KF = () => window.ClipKF;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const r2 = v => Math.round(v * 100) / 100;
  const fmtT = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const tmplOf = c => st().templates.find(t => t.id === c.templateId);

  // #region Sondagem da cena: onde cada elemento está, em cada instante
  const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'NOSCRIPT', 'HTML', 'BODY', 'DEFS', 'SOURCE', 'TRACK']);
  const MEDIA = new Set(['IMG', 'PICTURE', 'svg', 'SVG', 'CANVAS', 'VIDEO']);

  function pathKey(el) {
    const parts = [];
    let p = el;
    for (let i = 0; i < 5 && p && p.tagName !== 'BODY'; i++) {
      const idx = p.parentElement ? Array.prototype.indexOf.call(p.parentElement.children, p) : 0;
      parts.unshift(`${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}${p.classList && p.classList[0] ? '.' + p.classList[0] : ''}:${idx}`);
      p = p.parentElement;
    }
    return parts.join('>');
  }

  const rgbaAlpha = c => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[1].split(',').map(Number);
    return parts.length > 3 ? parts[3] : 1;
  };

  /** Elementos visíveis do documento, em px do quadro do iframe (centro + tamanho) */
  function collect(win, doc, W, H) {
    const out = [];
    if (!doc?.body) return out;
    const opCache = new Map();
    const opacityOf = el => {
      if (!el || el === doc.documentElement) return 1;
      if (opCache.has(el)) return opCache.get(el);
      const o = parseFloat(win.getComputedStyle(el).opacity);
      const v = (Number.isNaN(o) ? 1 : o) * opacityOf(el.parentElement);
      opCache.set(el, v);
      return v;
    };
    const frameArea = W * H;
    for (const el of doc.body.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'svg' && el.closest('svg')) continue;   // só o svg inteiro, não cada forma dentro dele
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (opacityOf(el) < 0.12) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.height < 14) continue;
      const area = r.width * r.height;
      const ix = Math.max(0, Math.min(r.right, W) - Math.max(r.left, 0));
      const iy = Math.max(0, Math.min(r.bottom, H) - Math.max(r.top, 0));
      if (ix * iy < 0.25 * area) continue;            // praticamente fora do quadro
      if (area > 0.85 * frameArea) continue;           // fundo
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.nodeValue.trim()).filter(Boolean).join(' ');
      const isMedia = MEDIA.has(el.tagName) || MEDIA.has(tag);
      const hasBox = rgbaAlpha(cs.backgroundColor) > 0.15 || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' ||
        (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && rgbaAlpha(cs.borderTopColor) > 0.15);
      if (!own && !isMedia && !(hasBox && area >= 0.004 * frameArea)) continue;
      // Decoração (brilhos desfocados, anéis enormes, fundos): não é algo para a câmera mirar
      if (!own && !isMedia && (/blur\(/.test(cs.filter) || area > 0.35 * frameArea)) continue;
      const kind = tag === 'img' || tag === 'picture' ? 'imagem' : tag === 'svg' ? 'svg' : tag === 'canvas' ? 'canvas' : tag === 'video' ? 'vídeo' : own ? 'texto' : 'caixa';
      out.push({
        key: pathKey(el),
        label: `${tag}${el.id ? '#' + el.id : ''}${el.classList && el.classList[0] ? '.' + el.classList[0] : ''}`,
        text: own.slice(0, 60),
        kind,
        x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
        score: Math.sqrt(area) * (kind === 'caixa' ? (cs.pointerEvents === 'none' ? 0.35 : 0.7) : kind === 'texto' ? 1.15 : 1.2),
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 22);
  }

  function loadFrame(html, res) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.sandbox = 'allow-scripts allow-same-origin';
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      f.style.cssText = `position:fixed;left:-30000px;top:0;width:${res.w}px;height:${res.h}px;border:0;visibility:hidden;pointer-events:none`;
      const timer = setTimeout(() => { f.remove(); reject(new Error('a cena demorou demais para carregar')); }, 15000);
      f.addEventListener('load', async () => {
        try {
          const ready = f.contentWindow?.Motion?.whenReady?.();
          await Promise.race([Promise.resolve(ready).catch(() => {}), sleep(5000)]);
        } catch (_) { /* sem whenReady */ }
        clearTimeout(timer);
        resolve(f);
      }, { once: true });
      // O preview serve os clips com <base href="/"> (imagens e fontes do projeto resolvem do mesmo jeito)
      const withKit = window.ClipHost ? window.ClipHost.injectRuntime(html) : html;
      f.srcdoc = /<base[\s>]/i.test(withKit) ? withKit : /<head[^>]*>/i.test(withKit) ? withKit.replace(/<head[^>]*>/i, m => `${m}<base href="/">`) : `<base href="/">${withKit}`;
      document.body.appendChild(f);
    });
  }

  /** Cenas HTML (não texto) abaixo da câmera que aparecem em algum momento de [t0, t1] */
  function sceneClips(cam, t0 = cam.start, t1 = cam.start + cam.duration) {
    const camTrack = Number(cam.trackIndex) || 0;
    const hidden = new Set((st().tracks || []).filter(t => t.hidden).map(t => t.index));
    return st().clips.filter(c => {
      const tm = tmplOf(c);
      const track = Number(c.trackIndex) || 0;
      return tm?.type === 'html' && !c.isText && !tm.textTmplId && !tm.layer && track < camTrack && !hidden.has(track) &&
        c.start < t1 - 1e-4 && c.start + c.duration > t0 + 1e-4;
    }).sort((a, b) => (Number(a.trackIndex) || 0) - (Number(b.trackIndex) || 0));
  }

  async function probeClip(clip, times, res, tick) {
    const tm = tmplOf(clip);
    const samples = [];
    let frame;
    try { frame = await loadFrame(tm.html, res); } catch (err) { console.warn('[Câmera] cena não abriu:', clip.label, err.message); return samples; }
    try {
      for (const t of times) {
        if (t < clip.start || t >= clip.start + clip.duration) continue;
        const local = typeof mapClipTimeToSource === 'function' ? mapClipTimeToSource(clip, t, tm) : t - clip.start;
        try { frame.contentWindow.Motion?.seek?.(local); } catch (_) { /* sem seek */ }
        await sleep(45);
        const items = collect(frame.contentWindow, frame.contentDocument, res.w, res.h);
        // do quadro do iframe para o quadro do projeto (a caixa do clip pode ter sido movida/escalada)
        const box = KF().animatedBox(clip, t);
        const sx = box.w / res.w, sy = box.h / res.h;
        samples.push({ t, items: items.map(it => ({ ...it, x: box.x + it.x * sx, y: box.y + it.y * sy, w: it.w * sx, h: it.h * sy })) });
        tick?.();
      }
    } finally { frame.remove(); }
    return samples;
  }

  /** Elementos na posição `time` da agulha (para "Mirar em elemento") */
  async function probeAt(cam, time) {
    const res = st().project.res;
    const scenes = sceneClips(cam, time, time + 0.001);
    const items = [];
    for (const clip of scenes) {
      const s = await probeClip(clip, [time], res);
      s.forEach(x => items.push(...x.items));
    }
    return items.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 24);
  }
  // #endregion

  // #region Fala (transcrição do áudio) e contexto
  /** Falas dentro do trecho da câmera, em segundos desde o início dela */
  async function gatherSpeech(cam, onStatus) {
    const t0 = cam.start, t1 = cam.start + cam.duration;
    const sources = st().clips.filter(c => {
      const type = tmplOf(c)?.type;
      return (type === 'audio' || type === 'video') && !c.muted && c.start < t1 - 0.05 && c.start + c.duration > t0 + 0.05;
    }).sort((a, b) => a.start - b.start);
    const speech = [];
    if (!sources.length || !window.__transcribeClip) return { speech, sources: sources.length };
    for (const [i, src] of sources.entries()) {
      onStatus?.(`Transcrevendo o áudio${sources.length > 1 ? ` (${i + 1} de ${sources.length})` : ''}…`);
      let tr;
      try {
        tr = await window.__transcribeClip(src.id, { language: '', onProgress: ({ stage, status }) => {
          if (stage === 'model') onStatus?.(status?.message || 'Carregando o modelo de transcrição…');
        } });
      } catch (err) { console.warn('[Câmera] transcrição falhou:', err.message); continue; }
      (tr.segments || []).forEach(sg => {
        const s = src.start + Math.max(0, +sg.start) - t0;
        const e = src.start + Math.min(src.duration, +sg.start + +sg.duration) - t0;
        if (e > 0 && s < cam.duration && sg.text) speech.push({ t: r2(Math.max(0, s)), end: r2(Math.min(cam.duration, e)), text: String(sg.text).trim().slice(0, 220) });
      });
    }
    speech.sort((a, b) => a.t - b.t);
    return { speech, sources: sources.length };
  }

  /** Instantes (segundos desde o início da câmera) em que a cena é medida: a grade + o começo de cada fala */
  function planTimes(cam, speech) {
    const D = cam.duration;
    const step = Math.min(3, Math.max(1, D / 10));
    const grid = [];
    for (let t = 0; t < D - 0.05; t += step) grid.push(r2(t));
    grid.push(r2(Math.max(0, D - 0.3)));
    const fromSpeech = [];
    speech.slice(0, 14).forEach(s => {
      fromSpeech.push(r2(s.t));
      if (s.end - s.t > 3.5) fromSpeech.push(r2((s.t + s.end) / 2));
    });
    const all = [...new Set([...fromSpeech, ...grid])].sort((a, b) => a - b);
    const kept = [];
    all.forEach(t => { if (!kept.length || t - kept[kept.length - 1] >= 0.35) kept.push(t); });
    // no máximo 22 instantes: tira primeiro os da grade mais apertados
    while (kept.length > 22) {
      let worst = 1, gap = Infinity;
      for (let i = 1; i < kept.length - 1; i++) { const g = kept[i + 1] - kept[i - 1]; if (g < gap) { gap = g; worst = i; } }
      kept.splice(worst, 1);
    }
    return kept;
  }

  function buildContext(cam, probes, speech) {
    const res = st().project.res;
    const registry = new Map();
    const elements = [];
    const bySample = new Map();
    probes.forEach(({ clip, samples }) => samples.forEach(s => {
      const rel = r2(s.t - cam.start);
      if (!bySample.has(rel)) bySample.set(rel, []);
      s.items.forEach(it => {
        const key = `${clip.id}|${it.key}`;
        let rec = registry.get(key);
        if (!rec) {
          rec = { id: `e${registry.size + 1}`, clip: String(clip.label || '').slice(0, 28), label: it.label, kind: it.kind, text: it.text };
          registry.set(key, rec);
          elements.push(rec);
        }
        bySample.get(rel).push([rec.id, Math.round(it.x), Math.round(it.y), Math.round(it.w), Math.round(it.h)]);
      });
    }));
    const per = 22;
    const samples = [...bySample.entries()].sort((a, b) => a[0] - b[0]).map(([t, on]) => ({ t, on: on.slice(0, per) }));
    const used = new Set(samples.flatMap(s => s.on.map(o => o[0])));
    return {
      frame: { w: res.w, h: res.h },
      camera: { duration: r2(cam.duration) },
      speech,
      elements: elements.filter(e => used.has(e.id)),
      samples,
    };
  }

  const STYLE_TEXT = {
    intensity: {
      subtle: 'Intensidade SUTIL: poucos movimentos, zoom até ~1,5, curvas suaves.',
      balanced: 'Intensidade EQUILIBRADA: movimentos claros nos momentos importantes, zoom até ~2,2.',
      dynamic: 'Intensidade DINÂMICA: movimentos mais ousados e rápidos, zoom até ~3; pode usar "ease-out" e "overshoot".',
    },
    margin: {
      loose: 'Enquadramento FOLGADO (margem m ≈ 1,8): o elemento aparece com bastante ar em volta.',
      tight: 'Enquadramento JUSTO (margem m ≈ 1,25): o elemento ocupa quase toda a visão.',
    },
  };

  async function externalPrompt(context, instruction, style) {
    const spec = await (await fetch('/api/camera/spec')).text();
    return [
      spec, '', '---', 'DADOS DO PROJETO (JSON):', JSON.stringify(context), '',
      STYLE_TEXT.intensity[style.intensity] || STYLE_TEXT.intensity.balanced,
      STYLE_TEXT.margin[style.margin] || STYLE_TEXT.margin.loose,
      instruction ? `PEDIDO DO USUÁRIO: ${instruction}` : '',
      'Responda somente com o JSON dos keyframes.',
    ].filter(x => x !== '').join('\n');
  }

  /** Quadros reais da cena (todas as cenas ativas empilhadas) para o Gemini ver os elementos */
  async function captureImages(cam, scenes, timesRel) {
    const res = st().project.res;
    const H = 480, W = Math.round(H * res.w / res.h);
    const picks = [...new Set([0, ...timesRel])].sort((a, b) => a - b).slice(0, 5);
    const frames = new Map();   // clipId → [{ img, t (timeline) }]
    for (const clip of scenes) {
      const tm = tmplOf(clip);
      const tl = picks.map(t => cam.start + t).filter(t => t >= clip.start && t < clip.start + clip.duration);
      if (!tl.length) continue;
      const src = tl.map(t => (typeof mapClipTimeToSource === 'function' ? mapClipTimeToSource(clip, t, tm) : t - clip.start));
      try {
        const resp = await fetch('/api/thumbs/html', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: tm.html, w: res.w, h: res.h, times: src, height: H }) });
        if (!resp.ok) continue;
        const { frames: list } = await resp.json();
        const out = [];
        for (let i = 0; i < (list || []).length; i++) {
          const img = new Image();
          await new Promise(done => { img.onload = done; img.onerror = done; img.src = list[i].url; });
          out.push({ img, t: tl[i] });
        }
        frames.set(clip.id, out);
      } catch (_) { /* sem quadro desta cena */ }
    }
    const images = [];
    for (const rel of picks) {
      const t = cam.start + rel;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#14141a';
      ctx.fillRect(0, 0, W, H);
      let drew = false;
      scenes.forEach(clip => {
        const f = (frames.get(clip.id) || []).find(x => Math.abs(x.t - t) < 1e-3);
        if (f?.img?.naturalWidth) { ctx.drawImage(f.img, 0, 0, W, H); drew = true; }
      });
      if (drew) images.push({ t: rel, dataUrl: canvas.toDataURL('image/jpeg', 0.72) });
    }
    return images;
  }
  // #endregion

  // #region Aplicar o resultado na câmera
  const EASE = {
    linear: null,
    smooth: { p: [0.65, 0, 0.35, 1] },
    'ease-out': { p: [0.16, 1, 0.3, 1] },
    'ease-in': { p: [0.7, 0, 0.84, 0] },
    overshoot: { p: [0.34, 1.56, 0.64, 1] },
    hold: { pts: [[0, 0], [0.999, 0], [1, 1]] },
  };

  function applyResult(clip, result) {
    window.__tlPushUndo?.();
    const keys = result.keyframes;
    // a curva do trecho A→B é a "ease" do keyframe B (como a câmera CHEGA nele); no dado fica no keyframe A
    ['camX', 'camY', 'camZoom', 'camR'].forEach(prop => {
      KF().setKeys(clip, prop, keys.map((k, i) => ({ t: k.t, v: k[prop], e: EASE[keys[i + 1]?.ease] || undefined })));
    });
    KF().syncAfterEdit(clip);
    window.seekTo?.(clip.start);
    window.__renderProps?.();
    window.MSUI?.toast({ message: `${keys.length} keyframes de câmera aplicados. Ajuste os losangos ou as curvas se quiser.`, kind: 'ok', duration: 4500, action: { label: 'Desfazer', onClick: () => window.__tlUndo?.() } });
  }
  // #endregion

  // #region Modal
  let M = null;   // { modal, clipId, context, ctxKey, result, probes }

  function build() {
    if (M?.modal) return;
    const modal = document.createElement('div');
    modal.id = 'camModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal cam-modal" role="dialog" aria-labelledby="camTitle">
        <div class="modal-header">
          <div class="modal-header-icon accent"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg></div>
          <span id="camTitle">Câmera 2D com IA</span>
          <span class="sc-source" id="camSub"></span>
          <button class="icon-btn" data-camm="close" aria-label="Fechar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body cam-body">
          <div class="cam-left">
            <p class="cam-lead">A IA lê o que o áudio fala e onde cada elemento das cenas HTML está na tela em cada instante, e cria os keyframes da câmera (para onde olhar, zoom e giro).</p>
            <div class="cx-tabs cv-tabs" role="tablist">
              <button type="button" data-camm-tab="ai" aria-selected="true">✨ Gerar com IA</button>
              <button type="button" data-camm-tab="code" aria-selected="false">📋 Colar código de outra IA</button>
            </div>
            <div class="cv-pane" data-camm-pane="ai">
              <label class="cam-label" for="camPrompt">O que a câmera deve fazer <small>opcional</small></label>
              <textarea id="camPrompt" class="prop-input full cv-prompt" rows="3" placeholder="Ex.: dê destaque ao mapa e aos preços quando forem citados; movimentos suaves; volte ao geral entre os assuntos…"></textarea>
              <div class="cam-row2">
                <div><label class="cam-label" for="camIntensity">Intensidade</label>
                  <select id="camIntensity" class="prop-input full"><option value="subtle">Sutil</option><option value="balanced" selected>Equilibrada</option><option value="dynamic">Dinâmica</option></select></div>
                <div><label class="cam-label" for="camMargin">Enquadramento</label>
                  <select id="camMargin" class="prop-input full"><option value="loose" selected>Folgado</option><option value="tight">Justo</option></select></div>
              </div>
              <label class="sc-check"><input type="checkbox" id="camSpeech" checked><span><b>Usar a transcrição do áudio</b> — transcreve o áudio sob a câmera (se ainda não foi transcrito)</span></label>
              <label class="sc-check"><input type="checkbox" id="camImages" checked><span><b>Enviar quadros da cena</b> — o Gemini vê o que é cada elemento (mapa, logo, gráfico…)</span></label>
              <div class="cv-row"><button class="export-btn" data-camm="generate">Gerar movimentos de câmera</button><span class="cv-status" id="camStatus"></span></div>
            </div>
            <div class="cv-pane" data-camm-pane="code" hidden>
              <ol class="cam-steps">
                <li><b>Copie o prompt</b> — ele já traz a explicação completa e os dados deste projeto (fala e posição dos elementos).</li>
                <li><b>Cole na IA que preferir</b> (ChatGPT, Claude, Gemini…) e peça os keyframes.</li>
                <li><b>Cole aqui o JSON</b> que ela devolver.</li>
              </ol>
              <div class="cv-row">
                <button class="btn-secondary" data-camm="copy-prompt" title="Copia a explicação + os dados do projeto para você colar em outra IA">📋 Copiar prompt de explicação</button>
                <button class="cv-link" data-camm="show-prompt">ver o prompt</button>
                <span class="cv-status" id="camCopyStatus"></span>
              </div>
              <pre class="cv-spec" id="camPromptView" hidden></pre>
              <textarea id="camCode" class="prop-input full cv-code" rows="8" spellcheck="false" placeholder='{"summary":"…","keyframes":[{"t":0,"focus":{"x":540,"y":960},"zoom":1,"ease":"smooth","reason":"visão geral"}, …]}'></textarea>
              <div class="cv-row"><span class="cv-status" id="camCodeStatus"></span></div>
            </div>
          </div>
          <div class="cam-right">
            <div class="cam-result-head"><b>Movimentos</b> <span id="camCount"></span></div>
            <svg class="cam-map" id="camMap" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet"></svg>
            <div class="cam-list" id="camList"><p class="cam-empty">Os keyframes aparecem aqui. Passe o mouse numa linha para ver o enquadramento sobre os elementos.</p></div>
            <p class="cam-summary" id="camSummary"></p>
          </div>
        </div>
        <div class="modal-footer">
          <span class="cv-msg" id="camMsg"></span>
          <button class="btn-secondary" data-camm="close">Fechar</button>
          <button class="export-btn" data-camm="apply" disabled>Aplicar na câmera</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    M = { modal, clipId: null, context: null, ctxKey: '', result: null };
    const q = s => modal.querySelector(s);
    modal.addEventListener('click', e => {
      if (e.target === modal) return close();
      const tab = e.target.closest('[data-camm-tab]');
      if (tab) return setTab(tab.dataset.cammTab);
      const btn = e.target.closest('[data-camm]');
      if (!btn) return;
      const a = btn.dataset.camm;
      if (a === 'close') close();
      if (a === 'generate') generate();
      if (a === 'copy-prompt') copyPrompt();
      if (a === 'show-prompt') showPrompt();
      if (a === 'apply') apply();
    });
    let timer = null;
    q('#camCode').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(parsePasted, 400); });
    q('#camList').addEventListener('mouseover', e => { const row = e.target.closest('[data-i]'); if (row) drawMap(Number(row.dataset.i)); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display !== 'none') close(); });
  }

  const $m = s => M.modal.querySelector(s);
  const camClip = () => st().clips.find(c => c.id === M.clipId);

  function setTab(tab) {
    M.modal.querySelectorAll('[data-camm-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.cammTab === tab)));
    M.modal.querySelectorAll('[data-camm-pane]').forEach(p => { p.hidden = p.dataset.cammPane !== tab; });
  }
  const msg = (text, kind = '') => { const el = $m('#camMsg'); el.textContent = text; el.dataset.kind = kind; };
  const status = (id, text, kind = '') => { const el = $m(id); el.textContent = text; el.dataset.kind = kind; };

  function close() { if (M) M.modal.style.display = 'none'; }

  function open(clipId) {
    build();
    const clip = st().clips.find(c => c.id === clipId);
    if (!clip || !KF().isCamera(clip)) return window.MSUI.toast({ message: 'Selecione uma camada de câmera 2D.', kind: 'info' });
    M.clipId = clipId;
    M.result = null;
    M.context = null;
    M.ctxKey = '';
    const scenes = sceneClips(clip);
    const audio = st().clips.filter(c => ['audio', 'video'].includes(tmplOf(c)?.type) && c.start < clip.start + clip.duration && c.start + c.duration > clip.start).length;
    $m('#camSub').textContent = `${fmtT(clip.duration)} · ${scenes.length} cena(s) HTML abaixo · ${audio} fonte(s) de áudio`;
    $m('#camList').innerHTML = '<p class="cam-empty">Os keyframes aparecem aqui. Passe o mouse numa linha para ver o enquadramento sobre os elementos.</p>';
    $m('#camMap').innerHTML = '';
    $m('#camCount').textContent = '';
    $m('#camSummary').textContent = '';
    $m('#camCode').value = '';
    $m('#camPromptView').hidden = true;
    status('#camStatus', '');
    status('#camCodeStatus', '');
    status('#camCopyStatus', '');
    $m('[data-camm="apply"]').disabled = true;
    msg(scenes.length ? '' : 'Não há cena HTML abaixo desta câmera neste trecho — a câmera precisa ficar numa track ACIMA das cenas. Sem elementos, a IA não sabe onde mirar.', scenes.length ? '' : 'error');
    setTab('ai');
    M.modal.style.display = 'flex';
    $m('#camPrompt').focus();
  }

  /** Mede a cena e junta fala + posições (cache enquanto o trecho/opções não mudam) */
  async function ensureContext(onStatus) {
    const clip = camClip();
    const useSpeech = $m('#camSpeech').checked;
    const key = `${clip.start}|${clip.duration}|${useSpeech}|${st().clips.length}`;
    if (M.context && M.ctxKey === key) return M.context;
    const scenes = sceneClips(clip);
    if (!scenes.length) throw new Error('Não há cena HTML abaixo da câmera neste trecho. Coloque a câmera numa track acima das cenas.');
    let speech = [];
    if (useSpeech) ({ speech } = await gatherSpeech(clip, onStatus));
    const timesRel = planTimes(clip, speech);
    const times = timesRel.map(t => clip.start + t);
    const res = st().project.res;
    const probes = [];
    let done = 0;
    const total = scenes.length * times.length;
    for (const scene of scenes) {
      onStatus?.(`Medindo a posição dos elementos de “${scene.label}”…`);
      const samples = await probeClip(scene, times, res, () => { done++; if (done % 4 === 0) onStatus?.(`Medindo os elementos da cena… ${Math.min(100, Math.round(done / total * 100))}%`); });
      probes.push({ clip: scene, samples });
    }
    const context = buildContext(clip, probes, speech);
    if (!context.samples.some(s => s.on.length)) throw new Error('Não encontrei elementos visíveis nas cenas HTML neste trecho.');
    M.context = context;
    M.ctxKey = key;
    M.probes = probes;
    M.scenes = scenes;
    M.timesRel = timesRel;
    return context;
  }

  const readOptions = () => ({
    instruction: $m('#camPrompt').value.trim(),
    style: { intensity: $m('#camIntensity').value, margin: $m('#camMargin').value },
  });

  async function generate() {
    const btn = $m('[data-camm="generate"]');
    btn.disabled = true;
    status('#camStatus', 'Preparando…');
    msg('');
    try {
      const context = await ensureContext(t => status('#camStatus', t));
      const { instruction, style } = readOptions();
      let images = [];
      if ($m('#camImages').checked) {
        status('#camStatus', 'Capturando quadros da cena…');
        images = await captureImages(camClip(), M.scenes, M.timesRel).catch(() => []);
      }
      status('#camStatus', 'Planejando a câmera com o Gemini…');
      const resp = await fetch('/api/ai/camera', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context, instruction, style, images }) });
      if (!resp.ok || !resp.body) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Erro ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let done = null;
      const handle = line => {
        if (!line.trim()) return;
        const ev = JSON.parse(line);
        if (ev.type === 'error') throw Object.assign(new Error(ev.error), { code: ev.code });
        if (ev.type === 'done') done = ev; else if (ev.type === 'status') status('#camStatus', ev.message);
      };
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      handle(buf + decoder.decode());
      if (!done) throw new Error('A resposta terminou antes do fim.');
      setResult(done);
      status('#camStatus', `Pronto · ${done.model}${images.length ? ` · ${images.length} quadro(s) enviados` : ''}`);
    } catch (err) {
      status('#camStatus', err.message || 'Falhou.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function copyPrompt() {
    status('#camCopyStatus', 'Preparando os dados…');
    try {
      const context = await ensureContext(t => status('#camCopyStatus', t));
      const { instruction, style } = readOptions();
      const text = await externalPrompt(context, instruction, style);
      M.lastPrompt = text;
      try {
        await navigator.clipboard.writeText(text);
        status('#camCopyStatus', `Copiado (${Math.round(text.length / 1000)} mil caracteres). Cole na outra IA e traga o JSON de volta.`, 'ok');
        window.MSUI?.toast({ message: 'Prompt copiado. Cole na outra IA e depois cole aqui o JSON que ela devolver.', kind: 'ok' });
      } catch (_) {
        $m('#camPromptView').textContent = text;
        $m('#camPromptView').hidden = false;
        status('#camCopyStatus', 'Não consegui copiar sozinho: selecione o texto abaixo e copie.', 'error');
      }
    } catch (err) {
      status('#camCopyStatus', err.message, 'error');
    }
  }

  async function showPrompt() {
    const pre = $m('#camPromptView');
    if (!pre.hidden) { pre.hidden = true; return; }
    try {
      const context = await ensureContext(t => status('#camCopyStatus', t));
      const { instruction, style } = readOptions();
      pre.textContent = await externalPrompt(context, instruction, style);
      pre.hidden = false;
      status('#camCopyStatus', '');
    } catch (err) { status('#camCopyStatus', err.message, 'error'); }
  }

  async function parsePasted() {
    const raw = $m('#camCode').value;
    if (!raw.trim()) { status('#camCodeStatus', ''); return; }
    const clip = camClip();
    const res = st().project.res;
    try {
      const resp = await fetch('/api/camera/normalize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw, duration: clip.duration, frame: { w: res.w, h: res.h } }) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
      setResult(data);
      status('#camCodeStatus', `${data.keyframes.length} keyframes reconhecidos.`, 'ok');
    } catch (err) {
      status('#camCodeStatus', err.message, 'error');
    }
  }

  function setResult(result) {
    M.result = result;
    $m('[data-camm="apply"]').disabled = !result?.keyframes?.length;
    $m('#camCount').textContent = result ? `${result.keyframes.length} keyframes` : '';
    $m('#camSummary').textContent = result?.summary || '';
    const EASE_PT = { linear: 'linear', smooth: 'suave', 'ease-out': 'chega rápido', 'ease-in': 'acelera', overshoot: 'passa e volta', hold: 'corte seco' };
    $m('#camList').innerHTML = (result?.keyframes || []).map((k, i) => `
      <div class="cam-row-k" data-i="${i}">
        <span class="cam-t">${fmtT(k.t)}</span>
        <span class="cam-f">foco ${Math.round(k.x)}, ${Math.round(k.y)} · ${k.zoom.toFixed(2)}×${Math.abs(k.rotation) > 0.05 ? ` · ${k.rotation}°` : ''}</span>
        <span class="cam-e">${esc(EASE_PT[k.ease] || k.ease)}</span>
        <span class="cam-why">${esc(k.reason)}</span>
      </div>`).join('') || '<p class="cam-empty">Sem keyframes.</p>';
    drawMap(0);
  }

  /** Quadro do projeto com os elementos da amostra mais próxima e o retângulo que a câmera enxerga no keyframe */
  function drawMap(i) {
    const svg = $m('#camMap');
    const res = st().project.res;
    const k = M.result?.keyframes?.[i];
    const W = res.w, H = res.h;
    svg.setAttribute('viewBox', `-${W * 0.04} -${H * 0.04} ${W * 1.08} ${H * 1.08}`);
    let html = `<rect x="0" y="0" width="${W}" height="${H}" class="cam-frame"/>`;
    const ctx = M.context;
    if (ctx && k) {
      const sample = ctx.samples.reduce((best, s) => (!best || Math.abs(s.t - k.t) < Math.abs(best.t - k.t) ? s : best), null);
      (sample?.on || []).forEach(o => {
        const el = ctx.elements.find(e => e.id === o[0]);
        html += `<rect x="${o[1] - o[3] / 2}" y="${o[2] - o[4] / 2}" width="${o[3]}" height="${o[4]}" class="cam-el"/>`;
        if (el && o[3] > W * 0.12) html += `<text x="${o[1]}" y="${o[2]}" class="cam-eltxt" font-size="${Math.max(28, H * 0.018)}">${esc((el.text || el.label).slice(0, 18))}</text>`;
      });
    }
    if (M.result) {
      const pts = M.result.keyframes.map(p => `${p.x},${p.y}`).join(' ');
      html += `<polyline points="${pts}" class="cam-path"/>`;
      if (k) {
        const vw = W / k.zoom, vh = H / k.zoom;
        html += `<rect x="${k.x - vw / 2}" y="${k.y - vh / 2}" width="${vw}" height="${vh}" class="cam-view"/><circle cx="${k.x}" cy="${k.y}" r="${W * 0.012}" class="cam-focus"/>`;
      }
    }
    svg.innerHTML = html;
    $m('#camList').querySelectorAll('.cam-row-k').forEach(r => r.classList.toggle('is-on', Number(r.dataset.i) === i));
  }

  function apply() {
    const clip = camClip();
    if (!clip || !M.result) return;
    applyResult(clip, M.result);
    close();
  }
  // #endregion

  window.MSCameraAI = { open, probeAt, sceneClips, collect, normalizeContext: buildContext };
})();
