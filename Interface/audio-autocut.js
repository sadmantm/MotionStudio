'use strict';
// audio-autocut.js
//
//  Cortes automáticos de um clip de áudio (painel do clip → "Cortes automáticos"):
//   1. Remover silêncios: acha as pausas pelo volume (níveis RMS que a timeline
//      já calcula, 20/s) e corta, deixando uma margem antes/depois da fala.
//   2. Limpar com IA: transcreve (Whisper, palavra a palavra), a IA aponta
//      hesitações, repetições/tomadas erradas, erros e comentários fora do
//      conteúdo (/api/ai/audio/cleanup); os silêncios também saem, sem nunca
//      cortar uma palavra mantida. Cada corte pode ser desfeito clicando na palavra.
//  Aplicar troca o clip pelos trechos mantidos, encostados, e puxa os clips
//  seguintes da mesma track. Um passo de undo.

(() => {
  const st = () => window.__appState;
  const status = text => { const el = document.getElementById('mbStatus'); if (el) el.textContent = text; };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s));
  const toDb = v => 20 * Math.log10(Math.max(1e-6, v));
  const fmtDur = s => {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${r.toFixed(1)} s`;
  };

  const MIN_PIECE = 0.08;      // trecho mantido menor que isto é descartado
  const WORD_GUARD = 0.04;     // folga em volta de palavra mantida
  const KINDS = {
    hesitacao: 'Hesitações e muletas',
    repeticao: 'Repetições e tomadas repetidas',
    erro: 'Frases abandonadas e autocorreções',
    fora: 'Comentários fora do conteúdo',
  };

  const A = {
    modal: null,
    clipId: null,
    mode: 'silence',
    range: [0, 0],
    levels: null,
    params: { threshold: -40, minSilence: 0.5, margin: 0.15 },
    auto: true,
    ai: null,         // { words, removed: [kind|null], reasons: [], summary }
    aiKinds: new Set(['hesitacao', 'repeticao', 'erro', 'fora']),
    aiSilence: true,
    busy: false,
    cuts: [],
    keep: [],
  };

  // #region Análise
  function autoThreshold(levels, [s, e]) {
    const dbs = [];
    for (let i = Math.floor(s * levels.rate), end = Math.ceil(e * levels.rate); i < end && i < levels.rms.length; i++) {
      dbs.push(toDb(levels.rms[i]));
    }
    if (dbs.length < 4) return -40;
    dbs.sort((a, b) => a - b);
    const floor = dbs[Math.floor(dbs.length * 0.1)];
    const speech = dbs[Math.floor(dbs.length * 0.9)];
    const thr = speech - floor < 6 ? floor + 3 : floor + (speech - floor) * 0.3;
    return Math.round(clamp(thr, -65, -15));
  }

  /** Faixas silenciosas a cortar ([a, b] em segundos da mídia) */
  function silenceCuts(levels, [s, e], { threshold, minSilence, margin }) {
    const rate = levels.rate;
    const cuts = [];
    let runStart = null;
    const i0 = Math.floor(s * rate);
    const i1 = Math.ceil(e * rate);
    const close = runEnd => {
      const leading = runStart <= s + 1e-3;
      const trailing = runEnd >= e - 1e-3;
      const len = runEnd - runStart;
      if (len >= ((leading || trailing) ? Math.min(minSilence, 0.2) : minSilence)) {
        const a = leading ? s : runStart + margin;
        const b = trailing ? e : runEnd - margin;
        if (b - a > 0.04) cuts.push([a, b]);
      }
      runStart = null;
    };
    for (let i = i0; i <= i1; i++) {
      const t = clamp(i / rate, s, e);
      const quiet = i < levels.rms.length && toDb(levels.rms[i]) < threshold;
      if (quiet && runStart === null) runStart = t;
      if (!quiet && runStart !== null) close(t);
    }
    if (runStart !== null) close(e);
    return cuts;
  }

  /**
   * Palavras cortadas pela IA (ou à mão) → faixas. Só as próprias palavras (com
   * uma folga, sem encostar nas vizinhas): a pausa em volta fica com a detecção
   * por volume — se a transcrição perdeu fala ali, ela não é cortada junto.
   */
  function wordCuts(words, removed, [s, e], credible) {
    const cuts = [];
    for (let i = 0; i < words.length; i++) {
      if (!removed[i]) continue;
      let j = i;
      while (j + 1 < words.length && removed[j + 1]) j++;
      // Vizinha com o tempo errado não limita o corte
      const prev = credible[i - 1] ? words[i - 1] : null;
      const next = credible[j + 1] ? words[j + 1] : null;
      const a = Math.max(prev ? prev.e + 0.02 : s, words[i].s - 0.06);
      const b = Math.min(next ? next.s - 0.02 : e, words[j].e + 0.06);
      if (b > a) cuts.push([a, b]);
      i = j;
    }
    return cuts;
  }

  /** Fração dos quadros do trecho que chegam ao limite (dB) */
  function loudFraction(levels, a, b, limit) {
    let loud = 0, total = 0;
    for (let i = Math.floor(a * levels.rate), end = Math.max(Math.floor(a * levels.rate) + 1, Math.ceil(b * levels.rate)); i < end && i < levels.rms.length; i++) {
      total++;
      if (toDb(levels.rms[i]) >= limit) loud++;
    }
    return total ? loud / total : 0;
  }

  /** Nenhum quadro do trecho chega ao limite (dB) */
  function isQuiet(levels, a, b, limit) {
    for (let i = Math.floor(a * levels.rate), end = Math.max(Math.floor(a * levels.rate) + 1, Math.ceil(b * levels.rate)); i < end && i < levels.rms.length; i++) {
      if (toDb(levels.rms[i]) >= limit) return false;
    }
    return true;
  }

  /**
   * Palavras com o tempo confiável: som em pelo menos metade do trecho. O
   * Whisper às vezes joga uma palavra dentro da pausa (ou da cauda da anterior).
   */
  function credibleWords(words, levels, threshold) {
    return words.map(w => !levels || loudFraction(levels, w.s, w.e, threshold) >= 0.5);
  }

  /** Tira das faixas de silêncio as palavras mantidas e confiáveis (nunca corta fala) */
  function subtractWords(cuts, words, removed, credible) {
    let out = cuts;
    words.forEach((w, i) => {
      if (removed[i] || !credible[i]) return;
      const a = w.s - WORD_GUARD;
      const b = w.e + WORD_GUARD;
      out = out.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [[x, a], [b, y]].filter(([p, q]) => q - p > 0.04)));
    });
    return out;
  }

  function mergeCuts(cuts) {
    const sorted = cuts.slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    sorted.forEach(([a, b]) => {
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.02) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    });
    return out;
  }

  function keepRanges(cuts, [s, e]) {
    const keep = [];
    let cursor = s;
    cuts.forEach(([a, b]) => {
      if (a - cursor >= MIN_PIECE) keep.push([cursor, Math.min(a, e)]);
      cursor = Math.max(cursor, b);
    });
    if (e - cursor >= MIN_PIECE) keep.push([cursor, e]);
    return keep;
  }

  function compute() {
    const { range, params } = A;
    let cuts = [];
    if (A.mode === 'silence' || A.aiSilence) {
      cuts = A.levels ? silenceCuts(A.levels, range, params) : [];
    }
    if (A.mode === 'ai' && A.ai) {
      const { words, removed } = A.ai;
      const credible = credibleWords(words, A.levels, params.threshold);
      cuts = subtractWords(cuts, words, removed, credible);
      cuts = cuts.concat(wordCuts(words, removed, range, credible));
      // Sobras entre um corte da IA e um silêncio (cauda de palavra cortada,
      // respiração): sem palavra mantida e curtas ou sem som, também saem
      if (A.aiSilence && A.levels) {
        const kept = keepRanges(mergeCuts(cuts), range);
        kept.forEach(([a, b]) => {
          const hasWord = words.some((w, i) => !removed[i] && credible[i] && w.e > a && w.s < b);
          if (!hasWord && (b - a < 0.6 || isQuiet(A.levels, a, b, params.threshold + 6))) cuts.push([a, b]);
        });
      }
    }
    A.cuts = mergeCuts(cuts);
    A.keep = keepRanges(A.cuts, range);
  }
  // #endregion

  // #region Interface
  function build() {
    if (A.modal) return A.modal;
    const modal = document.createElement('div');
    modal.id = 'autoCutModal';
    modal.className = 'modal-overlay';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal ac-modal" role="dialog" aria-label="Cortes automáticos">
        <div class="modal-header">
          <div class="modal-header-icon accent">✂</div>
          <span>Cortes automáticos</span>
          <span class="ac-clip-name" id="acClipName"></span>
          <button class="icon-btn" data-ac="close" title="Fechar (Esc)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="ac-tabs" role="tablist">
          <button data-ac-mode="silence" role="tab">Remover silêncios</button>
          <button data-ac-mode="ai" role="tab">✨ Limpar com IA</button>
        </div>
        <div class="modal-body ac-body">
          <div class="ac-wave-wrap"><canvas class="ac-wave" id="acWave"></canvas></div>
          <div class="ac-stats" id="acStats"></div>

          <div class="ac-params">
            <div class="ac-param">
              <label title="Abaixo deste volume conta como silêncio">Volume do silêncio</label>
              <input type="range" min="-70" max="-10" step="1" data-ac-param="threshold">
              <span class="ac-val" id="acThresholdVal"></span>
              <button class="ac-auto" data-ac="auto" title="Calcular pelo ruído de fundo da gravação">auto</button>
            </div>
            <div class="ac-param">
              <label title="Pausas menores que isto ficam (respiração natural)">Pausa mínima</label>
              <input type="range" min="0.2" max="2" step="0.05" data-ac-param="minSilence">
              <span class="ac-val" id="acMinSilenceVal"></span>
            </div>
            <div class="ac-param">
              <label title="Quanto da pausa fica antes e depois de cada fala">Margem</label>
              <input type="range" min="0" max="0.5" step="0.01" data-ac-param="margin">
              <span class="ac-val" id="acMarginVal"></span>
            </div>
          </div>

          <div class="ac-ai" id="acAi">
            <div class="ac-kinds">
              ${Object.entries(KINDS).map(([k, label]) => `
                <label class="ac-kind k-${k}"><input type="checkbox" data-ac-kind="${k}"> ${label}</label>`).join('')}
              <label class="ac-kind"><input type="checkbox" data-ac="ai-silence"> Remover silêncios também</label>
            </div>
            <textarea class="prop-input ac-prompt" id="acPrompt" rows="2"
              placeholder="Instruções extras (opcional) — ex.: mantenha as gírias; corte quando eu disser &quot;de novo&quot;"></textarea>
            <div class="ac-ai-row">
              <button class="export-btn" data-ac="analyze">Transcrever e analisar</button>
              <span class="ac-progress" id="acProgress"></span>
            </div>
            <div class="ac-summary" id="acSummary" hidden></div>
            <div class="ac-transcript" id="acTranscript" hidden></div>
          </div>
        </div>
        <div class="modal-footer">
          <span class="ac-foot-hint">Ctrl+Z desfaz depois de aplicar</span>
          <button class="btn-secondary" data-ac="close">Cancelar</button>
          <button class="export-btn" data-ac="apply" id="acApply">Aplicar cortes</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    A.modal = modal;

    modal.addEventListener('click', e => {
      if (e.target === modal) return close();
      const tab = e.target.closest('[data-ac-mode]');
      if (tab) return setMode(tab.dataset.acMode);
      const word = e.target.closest('.ac-w');
      if (word) return toggleWord(Number(word.dataset.i));
      const action = e.target.closest('[data-ac]')?.dataset.ac;
      if (action === 'close') close();
      if (action === 'auto') { A.auto = true; A.params.threshold = autoThreshold(A.levels, A.range); syncParams(); update(); }
      if (action === 'analyze') analyze();
      if (action === 'apply') apply();
    });
    modal.addEventListener('input', e => {
      const key = e.target.dataset.acParam;
      if (!key) return;
      A.params[key] = Number(e.target.value);
      if (key === 'threshold') A.auto = false;
      syncParams();
      update();
    });
    modal.addEventListener('change', e => {
      if (e.target.dataset.acKind) {
        if (e.target.checked) A.aiKinds.add(e.target.dataset.acKind);
        else A.aiKinds.delete(e.target.dataset.acKind);
      }
      if (e.target.dataset.ac === 'ai-silence') { A.aiSilence = e.target.checked; update(); }
    });
    modal.addEventListener('keydown', e => {
      e.stopPropagation();   // atalhos do editor não disparam com o modal aberto
      if (e.key === 'Escape') close();
    });
    window.addEventListener('resize', () => { if (!modal.hidden) drawWave(); });
    return modal;
  }

  function syncParams() {
    const m = A.modal;
    const { threshold, minSilence, margin } = A.params;
    m.querySelector('[data-ac-param="threshold"]').value = threshold;
    m.querySelector('[data-ac-param="minSilence"]').value = minSilence;
    m.querySelector('[data-ac-param="margin"]').value = margin;
    m.querySelector('#acThresholdVal').textContent = `${threshold} dB`;
    m.querySelector('#acMinSilenceVal').textContent = `${minSilence.toFixed(2)} s`;
    m.querySelector('#acMarginVal').textContent = `${margin.toFixed(2)} s`;
    m.querySelector('[data-ac="auto"]').toggleAttribute('data-on', A.auto);
    m.querySelectorAll('[data-ac-kind]').forEach(c => { c.checked = A.aiKinds.has(c.dataset.acKind); });
    m.querySelector('[data-ac="ai-silence"]').checked = A.aiSilence;
  }

  function setMode(mode) {
    A.mode = mode;
    A.modal.querySelectorAll('[data-ac-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.acMode === mode)));
    A.modal.querySelector('#acAi').hidden = mode !== 'ai';
    A.modal.querySelector('.ac-params').classList.toggle('ac-dim', mode === 'ai' && !A.aiSilence);
    update();
  }

  function update() {
    if (!A.modal || A.modal.hidden) return;
    compute();
    const [s, e] = A.range;
    const total = e - s;
    const kept = A.keep.reduce((sum, [a, b]) => sum + b - a, 0);
    const stats = A.modal.querySelector('#acStats');
    const apply = A.modal.querySelector('#acApply');
    const needsAi = A.mode === 'ai' && !A.ai;
    if (!A.levels) {
      stats.textContent = 'Analisando o volume do áudio…';
    } else if (needsAi) {
      stats.textContent = A.aiSilence && A.cuts.length
        ? `Silêncios: ${A.cuts.length} corte(s). Clique em "Transcrever e analisar" para a IA revisar a fala.`
        : 'Clique em "Transcrever e analisar" para a IA revisar a fala.';
    } else {
      const removed = total - kept;
      stats.innerHTML = A.cuts.length
        ? `<b>${A.cuts.length}</b> corte(s) · ${fmtDur(total)} → <b>${fmtDur(kept)}</b> <span class="ac-saved">−${fmtDur(removed)} (${Math.round(100 * removed / Math.max(0.001, total))}%)</span>`
        : 'Nada para cortar com estes ajustes.';
    }
    apply.disabled = A.busy || needsAi || !A.cuts.length || !A.keep.length;
    A.modal.querySelector('.ac-params').classList.toggle('ac-dim', A.mode === 'ai' && !A.aiSilence);
    drawWave();
    if (A.mode === 'ai' && A.ai) renderTranscript();
  }

  function drawWave() {
    const canvas = A.modal.querySelector('#acWave');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 90;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const [s, e] = A.range;
    const span = Math.max(0.001, e - s);
    const x = t => ((t - s) / span) * w;

    // Faixas cortadas
    ctx.fillStyle = 'rgba(255, 68, 85, 0.16)';
    A.cuts.forEach(([a, b]) => ctx.fillRect(x(a), 0, Math.max(1, x(b) - x(a)), h));

    const lv = A.levels;
    if (lv) {
      // Forma de onda em dB (−60…0) para pausas e fala ficarem legíveis
      const norm = v => clamp((toDb(v) + 60) / 60, 0, 1);
      let c = 0;
      for (let px = 0; px < w; px++) {
        const t0 = s + (px / w) * span;
        const t1 = s + ((px + 1) / w) * span;
        let peak = 0;
        for (let i = Math.floor(t0 * lv.rate), end = Math.max(i + 1, Math.ceil(t1 * lv.rate)); i < end && i < lv.peak.length; i++) {
          if (lv.peak[i] > peak) peak = lv.peak[i];
        }
        while (c < A.cuts.length && A.cuts[c][1] < t0) c++;
        const cut = c < A.cuts.length && A.cuts[c][0] <= t0;
        const amp = norm(peak) * (h - 6);
        ctx.fillStyle = cut ? 'rgba(255, 90, 105, 0.55)' : 'rgba(120, 200, 255, 0.9)';
        ctx.fillRect(px, (h - amp) / 2, 1, Math.max(1, amp));
      }
      // Linha do limite de silêncio
      if (A.mode === 'silence' || A.aiSilence) {
        const y = (1 - norm(Math.pow(10, A.params.threshold / 20))) * (h - 6) / 2;
        ctx.strokeStyle = 'rgba(130, 234, 0, 0.7)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.moveTo(0, h - y); ctx.lineTo(w, h - y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function renderTranscript() {
    const box = A.modal.querySelector('#acTranscript');
    const { words, removed, reasons } = A.ai;
    box.hidden = false;
    if (!words.length) { box.textContent = 'Nenhuma fala detectada.'; return; }
    const parts = [];
    words.forEach((w, i) => {
      const gap = i ? w.s - words[i - 1].e : 0;
      if (gap >= A.params.minSilence) parts.push(`<span class="ac-gap">${gap.toFixed(1)}s</span>`);
      const kind = removed[i];
      const title = kind ? `${KINDS[kind] || 'Cortado à mão'}${reasons[i] ? ` — ${reasons[i]}` : ''} · clique para manter` : 'Clique para cortar';
      parts.push(`<span class="ac-w${kind ? ` cut k-${kind}` : ''}" data-i="${i}" title="${esc(title)}">${esc(w.w)}</span>`);
    });
    box.innerHTML = parts.join(' ');
  }

  function toggleWord(i) {
    if (!A.ai) return;
    A.ai.removed[i] = A.ai.removed[i] ? null : 'manual';
    A.ai.reasons[i] = '';
    update();
  }
  // #endregion

  // #region IA
  async function streamNdjson(url, body, onStatus) {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    const handle = line => {
      if (!line.trim()) return;
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw new Error(ev.error);
      if (ev.type === 'done') done = ev;
      else if (ev.type === 'status') onStatus(ev.message);
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
    return done;
  }

  async function analyze() {
    if (A.busy) return;
    const clip = st().clips.find(c => c.id === A.clipId);
    if (!clip) return;
    if (!A.aiKinds.size) return progress('Escolha ao menos um tipo de corte.', true);
    A.busy = true;
    const button = A.modal.querySelector('[data-ac="analyze"]');
    button.disabled = true;
    update();
    try {
      progress('Preparando a transcrição…');
      const result = await window.__transcribeClip(clip.id, {
        onProgress: p => progress({
          model: p.status?.message || 'Carregando o Whisper…',
          read: 'Lendo o áudio…',
          transcribe: 'Transcrevendo (palavra a palavra)…',
        }[p.stage] || 'Transcrevendo…'),
      });
      const offset = Number(clip.trimStart) || 0;
      const words = (result.captions || [])
        .flatMap(c => c.words || [])
        .filter(w => String(w.word || '').trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map(w => ({ w: String(w.word).trim(), s: w.start + offset, e: Math.max(w.start, w.end) + offset }));
      if (!words.length) throw new Error('Nenhuma fala detectada neste áudio.');

      const out = await streamNdjson('/api/ai/audio/cleanup', {
        words: words.map(w => ({ w: w.w, s: +w.s.toFixed(2), e: +w.e.toFixed(2) })),
        kinds: [...A.aiKinds],
        prompt: A.modal.querySelector('#acPrompt').value.trim(),
        language: result.language || '',
      }, msg => progress(msg));

      const removed = words.map(() => null);
      const reasons = words.map(() => '');
      out.cuts.forEach(c => {
        for (let i = c.from; i <= c.to && i < words.length; i++) { removed[i] = c.kind; reasons[i] = c.reason; }
      });
      A.ai = { words, removed, reasons, summary: out.summary };
      const summary = A.modal.querySelector('#acSummary');
      summary.hidden = false;
      summary.innerHTML = `<b>${out.cuts.length}</b> trecho(s) apontado(s) pela IA${out.summary ? ` — ${esc(out.summary)}` : ''}
        <span class="ac-legend">${Object.entries(KINDS).map(([k, l]) => `<span><i class="k-${k}"></i>${l}</span>`).join('')}</span>`;
      progress(`Pronto (${out.model || 'IA'}). Clique numa palavra para cortar ou manter.`);
    } catch (err) {
      console.error('[Cortes] IA:', err);
      progress(err.message, true);
    } finally {
      A.busy = false;
      button.disabled = false;
      button.textContent = A.ai ? 'Analisar de novo' : 'Transcrever e analisar';
      update();
    }
  }

  function progress(text, isError = false) {
    const el = A.modal?.querySelector('#acProgress');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ac-error', isError);
  }
  // #endregion

  // #region Aplicar
  function apply() {
    const state = st();
    const clip = state.clips.find(c => c.id === A.clipId);
    if (!clip || !A.cuts.length || !A.keep.length) return;

    window.__tlPushUndo?.();
    let cursor = clip.start;
    const pieces = A.keep.map(([a, b], k) => {
      const piece = {
        ...clip,
        id: k === 0 ? clip.id : window.mkId(),
        start: cursor,
        trimStart: a,
        trimEnd: b,
        duration: b - a,
        fadeIn: k === 0 ? Math.min(Number(clip.fadeIn) || 0, (b - a) / 2) : 0,
        fadeOut: k === A.keep.length - 1 ? Math.min(Number(clip.fadeOut) || 0, (b - a) / 2) : 0,
      };
      if (k > 0) delete piece.linkedClipId;   // o vínculo com o vídeo fica no 1º trecho
      cursor += b - a;
      return piece;
    });

    // Os clips seguintes da mesma track andam junto (fecha o espaço cortado)
    const oldEnd = clip.start + clip.duration;
    const delta = cursor - oldEnd;
    const track = Number(clip.trackIndex) || 0;
    state.clips.forEach(c => {
      if (c !== clip && (Number(c.trackIndex) || 0) === track && c.start >= oldEnd - 1e-3) c.start = Math.max(0, c.start + delta);
    });

    window.__Compositor?.unmount(clip.id);
    state.clips.splice(state.clips.indexOf(clip), 1, ...pieces);
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
    window.__syncCompositorToTime?.(state.time);
    const before = oldEnd - clip.start;
    status(`✂ ${A.cuts.length} corte(s) · ${fmtDur(before)} → ${fmtDur(cursor - clip.start)}`);
    close();
  }
  // #endregion

  // #region Abrir / fechar
  async function open(clipId, mode = 'silence') {
    const clip = st().clips.find(c => c.id === clipId);
    const tmpl = clip && st().templates.find(t => t.id === clip.templateId);
    if (!tmpl || tmpl.type !== 'audio') return;
    build();
    const sameClip = A.clipId === clipId;
    A.clipId = clipId;
    A.range = [Number(clip.trimStart) || 0, (Number(clip.trimStart) || 0) + clip.duration];
    if (!sameClip) {
      A.ai = null;
      A.auto = true;
      A.modal.querySelector('#acSummary').hidden = true;
      A.modal.querySelector('#acTranscript').hidden = true;
      A.modal.querySelector('[data-ac="analyze"]').textContent = 'Transcrever e analisar';
      progress('');
    }
    A.modal.querySelector('#acClipName').textContent = clip.label || '';
    A.modal.hidden = false;
    A.modal.style.display = 'flex';
    syncParams();
    setMode(mode);

    // Níveis vêm da análise da timeline (pode ainda estar rodando)
    A.levels = window.__mediaLevels?.(tmpl) || null;
    for (let tries = 0; !A.levels && tries < 150 && A.clipId === clipId && !A.modal.hidden; tries++) {
      await new Promise(r => setTimeout(r, 200));
      A.levels = window.__mediaLevels?.(tmpl) || null;
    }
    if (!A.levels) return progress('Não foi possível analisar o volume deste áudio.', true);
    if (A.auto) A.params.threshold = autoThreshold(A.levels, A.range);
    syncParams();
    update();
  }

  function close() {
    if (!A.modal) return;
    A.modal.hidden = true;
    A.modal.style.display = 'none';
  }
  // #endregion

  window.MSAutoCut = { open, close, _internal: { silenceCuts, wordCuts, subtractWords, mergeCuts, keepRanges, autoThreshold, isQuiet, loudFraction, credibleWords } };
})();
