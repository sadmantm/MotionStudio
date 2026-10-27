'use strict';
// curves.js
//
//  Curvas de animação (easing) dos keyframes — seção "Animação" do painel do clip:
//    • gráfico da curva do trecho que COMEÇA no keyframe em foco (o selecionado na
//      timeline ou o que está sob a agulha), com alças arrastáveis (bezier) e prévia
//    • 5 modelos prontos (Linear, Suave, Desacelerar, Overshoot, Quicar) + as curvas do usuário
//    • "+ Nova": gerar com o Gemini (descrevendo o movimento), colar código (JSON, cubic-bezier(),
//      função JS de t) ou copiar as instruções para pedir a curva a qualquer outra IA
//  A curva vai dentro do keyframe (key.e = { p } | { pts }, ver clip-fx.js curve()), então
//  salva com o projeto e sai igual no export. As curvas do usuário ficam no servidor
//  (custom-assets/, tipo "curve") e valem para todos os projetos.

(() => {
  const st = () => window.__appState;
  const KF = () => window.ClipKF;
  const FX = () => window.ClipFX;
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));

  // #region Modelos
  function bounce(n = 36) {
    const f = t => {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    };
    return Array.from({ length: n + 1 }, (_, i) => [i / n, Math.round(f(i / n) * 10000) / 10000]);
  }

  const BUILTIN = [
    { id: 'linear',   name: 'Linear',      p: [0, 0, 1, 1] },
    { id: 'smooth',   name: 'Suave',       p: [0.65, 0, 0.35, 1] },
    { id: 'expo-out', name: 'Desacelerar', p: [0.16, 1, 0.3, 1] },
    { id: 'overshoot', name: 'Overshoot',  p: [0.34, 1.56, 0.64, 1] },
    { id: 'bounce',   name: 'Quicar',      pts: bounce() },
  ];

  let custom = [];   // curvas do usuário: { id, name, p | pts }
  const all = () => [...BUILTIN, ...custom];
  const curveOf = m => (m.pts ? { pts: m.pts } : { p: m.p });

  async function reload() {
    try {
      const list = await (await fetch('/api/custom-assets')).json();
      custom = list.filter(i => i.kind === 'curve').map(i => {
        let c = null;
        try { c = JSON.parse(i.html); } catch (_) { /* ignora */ }
        return c ? { id: i.id, name: i.name, ...c, custom: true } : null;
      }).filter(Boolean);
    } catch (_) { custom = []; }
  }
  // #endregion

  // #region Gráfico
  const GW = 160, GH = 118, PL = 20, PT = 14, PW = 120, PH = 80;   // área do gráfico em px do viewBox
  const YMIN = -0.6, YMAX = 1.6;
  const gx = x => PL + x * PW;
  const gy = y => PT + (1 - (y - YMIN) / (YMAX - YMIN)) * PH;
  const fromGx = px => (px - PL) / PW;
  const fromGy = py => YMIN + (1 - (py - PT) / PH) * (YMAX - YMIN);

  function pathOf(curve) {
    const pts = [];
    for (let i = 0; i <= 60; i++) { const u = i / 60; pts.push(`${gx(u).toFixed(1)},${gy(FX().curve(curve, u)).toFixed(1)}`); }
    return 'M' + pts.join(' L');
  }

  /** Miniatura de um modelo (sem eixos) */
  function miniSvg(curve) {
    const pts = [];
    for (let i = 0; i <= 40; i++) { const u = i / 40; pts.push(`${(4 + u * 40).toFixed(1)},${(30 - ((FX().curve(curve, u) - YMIN) / (YMAX - YMIN)) * 26 + 0).toFixed(1)}`); }
    return `<svg viewBox="0 0 48 34" width="48" height="34"><line x1="4" x2="44" y1="${(30 - ((0 - YMIN) / (YMAX - YMIN)) * 26).toFixed(1)}" y2="${(30 - ((0 - YMIN) / (YMAX - YMIN)) * 26).toFixed(1)}" class="cv-m-grid"/><line x1="4" x2="44" y1="${(30 - ((1 - YMIN) / (YMAX - YMIN)) * 26).toFixed(1)}" y2="${(30 - ((1 - YMIN) / (YMAX - YMIN)) * 26).toFixed(1)}" class="cv-m-grid"/><path d="M${pts.join(' L')}" class="cv-m-line"/></svg>`;
  }

  function graphSvg(curve, { editable }) {
    const c = curve || { p: [0, 0, 1, 1] };
    const handles = editable && c.p
      ? `<line class="cv-arm" x1="${gx(0)}" y1="${gy(0)}" x2="${gx(c.p[0])}" y2="${gy(c.p[1])}"/><line class="cv-arm" x1="${gx(1)}" y1="${gy(1)}" x2="${gx(c.p[2])}" y2="${gy(c.p[3])}"/>` +
        `<circle class="cv-handle" data-h="0" cx="${gx(c.p[0])}" cy="${gy(c.p[1])}" r="5"/><circle class="cv-handle" data-h="1" cx="${gx(c.p[2])}" cy="${gy(c.p[3])}" r="5"/>`
      : '';
    return `<svg class="cv-graph" viewBox="0 0 ${GW} ${GH}" data-cv-graph>
      <rect x="${PL}" y="${PT}" width="${PW}" height="${PH}" class="cv-frame"/>
      <line x1="${PL}" x2="${PL + PW}" y1="${gy(0)}" y2="${gy(0)}" class="cv-guide"/><line x1="${PL}" x2="${PL + PW}" y1="${gy(1)}" y2="${gy(1)}" class="cv-guide"/>
      <text x="${PL - 4}" y="${gy(0) + 3}" class="cv-axis" text-anchor="end">0</text><text x="${PL - 4}" y="${gy(1) + 3}" class="cv-axis" text-anchor="end">1</text>
      <path class="cv-line" d="${pathOf(c)}"/>${handles}
      <circle class="cv-ball" r="4.5" cx="${gx(0)}" cy="${gy(0)}" hidden/>
    </svg>`;
  }

  /** Bolinha percorrendo a curva (prévia do movimento) */
  function playBall(svg, curve, ms = 1300) {
    const ball = svg?.querySelector('.cv-ball');
    if (!ball) return;
    ball.hidden = false;
    const t0 = performance.now();
    const step = now => {
      const u = Math.min(1, (now - t0) / ms);
      ball.setAttribute('cx', gx(u));
      ball.setAttribute('cy', gy(FX().curve(curve, u)));
      if (u < 1 && svg.isConnected) requestAnimationFrame(step); else setTimeout(() => { ball.hidden = true; }, 350);
    };
    requestAnimationFrame(step);
  }
  // #endregion

  // #region Painel "Animação"
  const sameCurve = (a, b) => {
    if (!a || !b) return false;
    if (a.p && b.p) return a.p.every((v, i) => Math.abs(v - b.p[i]) < 1e-3);
    if (a.pts && b.pts) return a.pts.length === b.pts.length && a.pts.every((q, i) => Math.abs(q[0] - b.pts[i][0]) < 1e-3 && Math.abs(q[1] - b.pts[i][1]) < 1e-3);
    return false;
  };
  const fmtT = t => (window.fmtTime ? window.fmtTime(t) : `${Number(t).toFixed(2)}s`);

  function render(clip) {
    if (!clip || !KF()?.has(clip)) return '';
    const s = KF().activeKeyTime(clip);
    const id = esc(clip.id);
    if (s == null) {
      return `<div class="prop-section cv-props" data-clip-id="${id}">
        <div class="prop-title">Animação</div>
        <p class="cv-hint">Clique num <b>losango</b> do clip na timeline (ou leve a agulha até um keyframe) para escolher a <b>curva</b> do trecho até o próximo keyframe.</p>
      </div>`;
    }
    const time = KF().keyTimes(clip).find(k => Math.abs(k.t - s) < 0.02);
    const e = time?.e || null;
    const bezier = !e || Boolean(e.p);
    const names = (time?.props || []).map(p => KF().PROPS[p].label).join(', ');
    const cards = all().map(m => `
      <button type="button" class="cv-card${sameCurve(e || { p: [0, 0, 1, 1] }, curveOf(m)) ? ' is-on' : ''}" data-cv-id="${esc(m.id)}" title="${esc(m.name)}">
        ${miniSvg(curveOf(m))}<span>${esc(m.name)}</span>${m.custom ? '<i class="cv-del" data-cv-del title="Excluir esta curva">✕</i>' : ''}
      </button>`).join('');
    return `<div class="prop-section cv-props" data-clip-id="${id}" data-key-s="${s}">
      <div class="prop-title">Animação <small class="cv-time">${fmtT(KF().toTimeline(clip, s))}</small></div>
      <p class="cv-hint">Keyframe: ${esc(names)}. Curva do trecho até o próximo keyframe${bezier ? ' — arraste as alças' : ' (por pontos)'}.</p>
      ${graphSvg(e, { editable: bezier })}
      <div class="cv-tools">
        <button type="button" class="tf-btn" data-cv="play" title="Ver o movimento">▶ Prévia</button>
        <button type="button" class="tf-btn" data-cv="new" title="Criar uma curva com IA ou colando código">＋ Nova curva</button>
      </div>
      <div class="cv-grid">${cards}</div>
    </div>`;
  }

  /** Aplica a curva (ou null = linear) no keyframe em foco */
  function applyCurve(clip, s, curve, { undo = true } = {}) {
    if (undo) window.__tlPushUndo?.();
    const e = curve && !sameCurve(curve, { p: [0, 0, 1, 1] }) ? curve : null;
    KF().setCurveAt(clip, s, e);
  }

  function onPanelClick(e) {
    const sec = e.target.closest('.cv-props');
    if (!sec) return;
    const clip = st().clips.find(c => c.id === sec.dataset.clipId);
    if (!clip) return;
    const s = Number(sec.dataset.keyS);
    if (e.target.closest('[data-cv-del]')) {
      e.stopPropagation();
      const m = custom.find(c => c.id === e.target.closest('.cv-card')?.dataset.cvId);
      if (m) deleteCustom(m);
      return;
    }
    const card = e.target.closest('.cv-card');
    if (card) {
      const m = all().find(c => c.id === card.dataset.cvId);
      if (!m) return;
      applyCurve(clip, s, curveOf(m));
      KF().syncAfterEdit(clip);
      playBall(document.querySelector('#propsContent .cv-graph'), curveOf(m), 900);
      return;
    }
    const btn = e.target.closest('[data-cv]');
    if (!btn) return;
    if (btn.dataset.cv === 'play') {
      const time = KF().keyTimes(clip).find(k => Math.abs(k.t - s) < 0.02);
      playBall(sec.querySelector('.cv-graph'), time?.e || null);
    }
    if (btn.dataset.cv === 'new') openModal({ clipId: clip.id, s });
  }

  /** Alças da bezier: arrastar muda a curva ao vivo (um passo de undo) */
  function onHandleDown(e) {
    const h = e.target.closest('.cv-handle');
    if (!h) return;
    const sec = h.closest('.cv-props');
    const clip = st().clips.find(c => c.id === sec?.dataset.clipId);
    if (!clip) return;
    e.preventDefault();
    const s = Number(sec.dataset.keyS);
    let svg = h.closest('svg');   // é recriado a cada movimento
    const idx = Number(h.dataset.h);
    const start = KF().keyTimes(clip).find(k => Math.abs(k.t - s) < 0.02)?.e;
    const p = [...(start?.p || [0, 0, 1, 1])];
    let pushed = false;
    const move = ev => {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      const q = pt.matrixTransform(svg.getScreenCTM().inverse());
      p[idx * 2] = Math.round(Math.max(0, Math.min(1, fromGx(q.x))) * 100) / 100;
      p[idx * 2 + 1] = Math.round(Math.max(-2, Math.min(3, fromGy(q.y))) * 100) / 100;
      if (!pushed) { window.__tlPushUndo?.(); pushed = true; }
      const curve = { p: [...p] };
      KF().setCurveAt(clip, s, sameCurve(curve, { p: [0, 0, 1, 1] }) ? null : curve);
      window.__syncCompositorToTime?.(st().time);
      // redesenha só o gráfico
      const wrap = document.createElement('div');
      wrap.innerHTML = graphSvg(curve, { editable: true });
      const fresh = wrap.firstElementChild;
      svg.replaceWith(fresh);
      svg = fresh;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (pushed) KF().syncAfterEdit(clip);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  let lastActive = null;
  /** A agulha entrou/saiu de um keyframe (parada): atualiza a seção */
  function onTime(clip) {
    if (st().playing) return;
    const act = KF().activeKeyTime(clip);
    const key = `${clip.id}|${act == null ? '' : Math.round(act * 1000)}`;
    if (key === lastActive) return;
    lastActive = key;
    if (document.querySelector('#propsContent .cv-props')) window.__renderProps?.();
  }
  // #endregion

  // #region Excluir curva do usuário
  async function deleteCustom(m) {
    await fetch(`/api/custom-assets/${encodeURIComponent(m.id)}`, { method: 'DELETE' }).catch(() => {});
    await reload();
    window.__renderProps?.();
    // Sem pergunta: Desfazer recria a curva (keyframes que já a usam guardam a própria cópia)
    window.MSUI.toast({
      message: `Curva “${m.name}” excluída.`,
      kind: 'info',
      duration: 8000,
      action: {
        label: 'Desfazer',
        onClick: async () => {
          const curve = m.pts ? { pts: m.pts } : { p: m.p };
          await fetch('/api/custom-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'curve', name: m.name, html: JSON.stringify(curve) }) });
          await reload();
          window.__renderProps?.();
        },
      },
    });
  }
  // #endregion

  // #region Interpretar código colado
  const stripFences = t => String(t).trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();

  /** Função JS de t → pontos, calculada num Worker (sem acesso à página) */
  function sampleFunction(code) {
    return new Promise((resolve, reject) => {
      const src = `self.onmessage = e => { try {
        const code = e.data; let f = null;
        try { const v = (0, eval)('(' + code + ')'); if (typeof v === 'function') f = v; } catch (_) {}
        if (!f) f = new Function('t', 'return (' + code + ')');
        const pts = [];
        for (let i = 0; i <= 48; i++) { const t = i / 48; const y = Number(f(t)); if (!isFinite(y)) throw new Error('a função não devolveu um número em t=' + t.toFixed(2)); pts.push([t, y]); }
        self.postMessage({ pts });
      } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const done = fn => v => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); fn(v); };
      const timer = setTimeout(done(reject).bind(null, new Error('a função demorou demais')), 1500);
      worker.onmessage = e => (e.data.error ? done(reject)(new Error(e.data.error)) : done(resolve)(e.data.pts));
      worker.onerror = e => done(reject)(new Error(e.message || 'erro na função'));
      worker.postMessage(code);
    });
  }

  /** Texto colado → { curve, name? } (JSON, array, cubic-bezier(), função/expressão de t) */
  async function parseCode(raw) {
    const text = stripFences(raw);
    if (!text) throw new Error('Cole o código da curva.');
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* tenta outros formatos */ }
    const fromJson = j => {
      if (Array.isArray(j)) {
        if (j.length === 4 && j.every(v => typeof v === 'number')) return { p: j };
        if (j.length >= 2 && Array.isArray(j[0])) return { pts: j };
        if (j.length >= 2 && typeof j[0] === 'object') return { pts: j.map(q => [q.x ?? q.t, q.y ?? q.v]) };
        return null;
      }
      if (j && typeof j === 'object') {
        if (j.curve) return fromJson(j.curve) || j.curve;
        if (Array.isArray(j.points)) return { pts: j.points.map(q => (Array.isArray(q) ? q : [q.x, q.y])) };
        return j;
      }
      return null;
    };
    if (json) {
      const curve = FX().normalizeCurve(fromJson(json));
      if (!curve) throw new Error('JSON sem "p" (4 números) nem "pts" (lista de [x, y]).');
      return { curve, name: typeof json?.name === 'string' ? json.name : '' };
    }
    const bez = text.match(/cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i);
    if (bez) return { curve: FX().normalizeCurve({ p: bez.slice(1, 5).map(Number) }), name: '' };
    if (/[=>]|function|Math\.|\bt\b/.test(text)) {
      const pts = await sampleFunction(text);
      const curve = FX().normalizeCurve({ pts });
      if (!curve) throw new Error('Não consegui montar a curva a partir da função.');
      return { curve, name: '' };
    }
    throw new Error('Formato não reconhecido. Use JSON ({"p":[…]} ou {"pts":[…]}), cubic-bezier(…) ou uma função de t.');
  }
  // #endregion

  // #region Modal "Nova curva"
  let M = null;   // estado: { modal, target: { clipId, s }, curve, name }

  function buildModal() {
    if (M?.modal) return;
    const modal = document.createElement('div');
    modal.id = 'cvModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal cv-modal" role="dialog" aria-labelledby="cvTitle">
        <div class="modal-header">
          <div class="modal-header-icon accent"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 20C8 20 8 4 21 4"/></svg></div>
          <span id="cvTitle">Nova curva de animação</span>
          <button class="icon-btn" data-cvm="close" aria-label="Fechar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body cv-body">
          <div class="cv-side">
            <div class="form-group"><label for="cvName">Nome</label><input id="cvName" class="prop-input full" maxlength="40" placeholder="Ex.: Rebote suave"></div>
            <div class="cx-tabs cv-tabs" role="tablist">
              <button type="button" data-cvm-tab="ai" aria-selected="true">✨ Gerar com IA</button>
              <button type="button" data-cvm-tab="code" aria-selected="false">📋 Colar código</button>
            </div>
            <div class="cv-pane" data-cvm-pane="ai">
              <textarea id="cvPrompt" class="prop-input full cv-prompt" rows="4" placeholder="Descreva o movimento: “começa devagar e dispara no fim”, “mola que oscila 3 vezes e assenta”, “bola que quica duas vezes”…"></textarea>
              <div class="cv-row"><button class="export-btn" data-cvm="generate">Gerar curva</button><span class="cv-status" id="cvStatus"></span></div>
            </div>
            <div class="cv-pane" data-cvm-pane="code" hidden>
              <textarea id="cvCode" class="prop-input full cv-code" rows="7" spellcheck="false" placeholder='{"p":[0.34,1.56,0.64,1]}   ou   cubic-bezier(0.16, 1, 0.3, 1)   ou   t => 1 - Math.pow(1 - t, 3)'></textarea>
              <p class="cv-hint">Aceita JSON (<code>{"p":[x1,y1,x2,y2]}</code> ou <code>{"pts":[[x,y],…]}</code>), <code>cubic-bezier()</code> do CSS ou uma função JavaScript de <code>t</code> (0 a 1).</p>
              <div class="cv-row">
                <button class="btn-secondary" data-cvm="copy-spec" title="Copia a explicação do formato para você colar em ChatGPT, Claude, Gemini etc.">📋 Copiar instruções para outra IA</button>
                <button class="cv-link" data-cvm="show-spec">ver instruções</button>
              </div>
              <pre class="cv-spec" id="cvSpec" hidden></pre>
            </div>
          </div>
          <div class="cv-preview">
            <div id="cvGraph"></div>
            <div class="cv-row"><button class="tf-btn" data-cvm="play">▶ Prévia</button><span class="cv-json" id="cvJson"></span></div>
          </div>
        </div>
        <div class="modal-footer">
          <span class="cv-msg" id="cvMsg"></span>
          <button class="btn-secondary" data-cvm="close">Cancelar</button>
          <button class="export-btn" data-cvm="save" disabled>Salvar curva</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    M = { modal, target: null, curve: null, name: '' };

    const q = sel => modal.querySelector(sel);
    modal.addEventListener('click', async e => {
      if (e.target === modal) return closeModal();
      const tab = e.target.closest('[data-cvm-tab]');
      if (tab) return setTab(tab.dataset.cvmTab);
      const btn = e.target.closest('[data-cvm]');
      if (!btn) return;
      const a = btn.dataset.cvm;
      if (a === 'close') closeModal();
      if (a === 'play') playBall(q('#cvGraph svg'), M.curve);
      if (a === 'generate') generate();
      if (a === 'save') save();
      if (a === 'copy-spec') copySpec();
      if (a === 'show-spec') toggleSpec();
    });
    let timer = null;
    q('#cvCode').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(parseCurrent, 350); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.style.display !== 'none') closeModal(); });
  }

  const $m = sel => M.modal.querySelector(sel);

  function setTab(tab) {
    M.modal.querySelectorAll('[data-cvm-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.cvmTab === tab)));
    M.modal.querySelectorAll('[data-cvm-pane]').forEach(p => { p.hidden = p.dataset.cvmPane !== tab; });
  }

  function setCurve(curve, name) {
    M.curve = curve;
    if (name && !$m('#cvName').value.trim()) $m('#cvName').value = name.slice(0, 40);
    $m('#cvGraph').innerHTML = curve ? graphSvg(curve, { editable: false }) : '';
    $m('#cvJson').textContent = curve ? (curve.p ? `p = [${curve.p.join(', ')}]` : `${curve.pts.length} pontos`) : '';
    $m('[data-cvm="save"]').disabled = !curve;
    if (curve) playBall($m('#cvGraph svg'), curve);
  }

  function msg(text, kind = '') {
    const el = $m('#cvMsg');
    el.textContent = text;
    el.dataset.kind = kind;
  }

  async function parseCurrent() {
    const code = $m('#cvCode').value;
    if (!code.trim()) { setCurve(null); msg(''); return; }
    try {
      const { curve, name } = await parseCode(code);
      setCurve(curve, name);
      msg('');
    } catch (err) {
      setCurve(null);
      msg(err.message, 'error');
    }
  }

  async function generate() {
    const prompt = $m('#cvPrompt').value.trim();
    if (!prompt) { $m('#cvPrompt').focus(); return; }
    const btn = $m('[data-cvm="generate"]');
    const status = $m('#cvStatus');
    btn.disabled = true;
    status.textContent = 'Gerando…';
    status.dataset.kind = '';
    try {
      const resp = await fetch('/api/ai/curve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, current: M.curve || undefined }) });
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
        if (ev.type === 'done') done = ev; else if (ev.type === 'status') status.textContent = ev.message;
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
      $m('#cvName').value = done.name || $m('#cvName').value;
      $m('#cvCode').value = JSON.stringify({ name: done.name, ...done.curve });
      setCurve(done.curve);
      status.textContent = `Pronta · ${done.model}. Dá para ajustar o código na aba “Colar código”.`;
    } catch (err) {
      status.textContent = err.message || 'Falhou.';
      status.dataset.kind = 'error';
    } finally {
      btn.disabled = false;
    }
  }

  let specText = '';
  async function loadSpec() {
    if (specText) return specText;
    try { specText = await (await fetch('/api/curves/spec')).text(); } catch (_) { specText = ''; }
    return specText;
  }

  async function copySpec() {
    const text = await loadSpec();
    if (!text) return msg('Não foi possível carregar as instruções.', 'error');
    try {
      await navigator.clipboard.writeText(`${text}\n\n---\nCrie a curva para este movimento: `);
      window.MSUI?.toast?.({ message: 'Instruções copiadas. Cole na outra IA, descreva o movimento e traga o JSON de volta.', kind: 'ok' });
      msg('Instruções copiadas — cole na outra IA e traga o JSON de volta aqui.', 'ok');
    } catch (_) {
      toggleSpec(true);
      msg('Não consegui copiar sozinho: selecione o texto abaixo e copie.', 'error');
    }
  }

  async function toggleSpec(force) {
    const pre = $m('#cvSpec');
    pre.textContent = await loadSpec();
    pre.hidden = force === true ? false : !pre.hidden;
  }

  async function save() {
    const name = $m('#cvName').value.trim();
    if (!M.curve) return;
    if (!name) { $m('#cvName').focus(); return msg('Dê um nome à curva.', 'error'); }
    const btn = $m('[data-cvm="save"]');
    btn.disabled = true;
    try {
      const resp = await fetch('/api/custom-assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'curve', name, html: JSON.stringify(M.curve) }) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `Erro ${resp.status}`);
      await reload();
      const target = M.target;
      closeModal();
      // Já aplica no keyframe de onde veio, se houver
      const clip = target && st().clips.find(c => c.id === target.clipId);
      if (clip) { applyCurve(clip, target.s, M.curve); KF().syncAfterEdit(clip); } else window.__renderProps?.();
      window.MSUI?.toast?.({ message: `Curva “${name}” salva.`, kind: 'ok' });
    } catch (err) {
      msg(err.message, 'error');
      btn.disabled = false;
    }
  }

  function openModal(target = null) {
    buildModal();
    M.target = target;
    M.curve = null;
    $m('#cvName').value = '';
    $m('#cvPrompt').value = '';
    $m('#cvCode').value = '';
    $m('#cvStatus').textContent = '';
    $m('#cvSpec').hidden = true;
    setTab('ai');
    setCurve(null);
    msg('');
    M.modal.style.display = 'flex';
    $m('#cvPrompt').focus();
  }
  function closeModal() { if (M) M.modal.style.display = 'none'; }
  // #endregion

  window.__renderAnimProps = render;
  window.__curvesOnTime = onTime;
  window.MSCurves = { BUILTIN, all, reload, open: openModal, parseCode };

  function boot() {
    reload();
    const props = document.getElementById('propsContent');
    props?.addEventListener('click', onPanelClick);
    props?.addEventListener('mousedown', onHandleDown);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
