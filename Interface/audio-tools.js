'use strict';
// audio-tools.js
//
//  Ajustes do clip de áudio no painel direito: velocidade, tom, redutor de
//  ruído (intensidade, sensibilidade), corte de graves e nivelar voz.
//  O servidor (libs/audio-fx.js) gera uma versão processada a partir do
//  arquivo ORIGINAL e o clip passa a usar essa mídia (template derivado,
//  fora da biblioteca). Velocidade muda o tamanho do clip: trim e duração são
//  reescalados e os clips seguintes da mesma track andam junto.
//  Voltar tudo ao padrão faz o clip usar o original de novo.

(() => {
  const st = () => window.__appState;
  const status = text => { const el = document.getElementById('mbStatus'); if (el) el.textContent = text; };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s));

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  // #region Ajustes (mesma regra de libs/audio-fx.js → normalizeFx)
  function normalizeFx(raw = {}) {
    const denoise = raw.denoise || {};
    return {
      speed: Math.round(clamp(num(raw.speed, 1), 0.25, 4) * 100) / 100,
      pitch: Math.round(clamp(num(raw.pitch, 0), -12, 12) * 2) / 2,
      denoise: {
        on: Boolean(denoise.on),
        amount: Math.round(clamp(num(denoise.amount, 50), 0, 100)),
        floor: Math.round(clamp(num(denoise.floor, -50), -80, -20)),
      },
      lowcut: Math.round(clamp(num(raw.lowcut, 0), 0, 300)),
      level: Boolean(raw.level),
    };
  }

  const isNeutral = fx => fx.speed === 1 && fx.pitch === 0 && !fx.denoise.on && !fx.lowcut && !fx.level;
  // Intensidade/sensibilidade só contam com o redutor ligado
  const fxSig = fx => JSON.stringify({ ...fx, denoise: fx.denoise.on ? fx.denoise : { on: false } });
  const fxOf = clip => normalizeFx(clip?.audioFx || {});

  const tmplOf = clip => st().templates.find(t => t.id === clip?.templateId) || null;
  /** Template do arquivo original (o clip pode estar num derivado) */
  function originOf(tmpl) {
    if (!tmpl?.audioFxOf) return tmpl;
    return st().templates.find(t => t.id === tmpl.audioFxOf) || tmpl;
  }

  /** Clips que vêm do mesmo arquivo (trechos de um corte automático, splits) */
  function siblingsOf(clip) {
    const origin = originOf(tmplOf(clip));
    if (!origin) return [clip];
    return st().clips.filter(c => originOf(tmplOf(c))?.id === origin.id);
  }
  // #endregion

  // #region Processamento no servidor
  const jobs = new Map();   // origem|ajustes → Promise<template>

  const MIME_EXT = { mpeg: 'mp3', 'x-wav': 'wav', wave: 'wav', 'x-m4a': 'm4a', mp4: 'm4a', 'x-matroska': 'mkv' };

  function derivedTemplate(origin, fx) {
    if (isNeutral(fx)) return Promise.resolve(origin);
    const sig = fxSig(fx);
    const found = st().templates.find(t => t.audioFxOf === origin.id && t.audioFxSig === sig);
    if (found) return Promise.resolve(found);
    const key = `${origin.id}|${sig}`;
    if (jobs.has(key)) return jobs.get(key);

    const job = (async () => {
      const blob = await (await fetch(origin.dataUrl || origin.objectUrl)).blob();
      const sub = (origin.mimeType || blob.type || 'audio/mpeg').split('/')[1]?.split(';')[0] || 'mp3';
      const qs = new URLSearchParams({ ext: MIME_EXT[sub] || sub, fx: JSON.stringify(fx) });
      const resp = await fetch(`/api/audio/process?${qs}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const out = await resp.blob();
      const url = URL.createObjectURL(out);
      const expected = (Number(origin.sourceDuration) || 0) / fx.speed;
      const measured = window.probeAudioDuration ? await window.probeAudioDuration(url).catch(() => 0) : 0;
      const template = {
        id: window.mkId(),
        name: `${origin.name || 'Áudio'} (ajustado)`,
        type: 'audio',
        dataUrl: url,
        objectUrl: url,
        isObjectUrl: true,
        mimeType: out.type || 'audio/mp4',
        fileSize: out.size,
        sourceDuration: measured > 0 ? measured : expected,
        fps: origin.fps,
        color: origin.color,
        // Versão de um asset, não um asset novo: a biblioteca conta o uso pelo original
        inLibrary: false,
        libraryId: origin.libraryId || (origin.inLibrary ? origin.id : undefined),
        audioFxOf: origin.id,
        audioFxSig: sig,
      };
      st().templates.push(template);
      return template;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }

  /** Versões que nenhum clip usa saem da memória (o undo recria pelo snapshot) */
  function pruneDerived() {
    const used = new Set(st().clips.map(c => c.templateId));
    st().templates = st().templates.filter(t => !t.audioFxOf || used.has(t.id));
  }
  // #endregion

  // #region Aplicar nos clips
  let applySeq = 0;
  let busy = null;          // { clipIds, fx } enquanto o servidor processa
  let applyAll = true;      // "aplicar a todos os trechos deste áudio"

  /**
   * Velocidade: trim e duração na base de tempo da nova versão (f = antiga/nova).
   * Os clips seguintes da mesma track andam junto, mantendo os espaços.
   */
  function rescale(targets, fxNew, template) {
    const ids = new Set(targets.map(c => c.id));
    const tracks = new Set(targets.map(c => Number(c.trackIndex) || 0));
    tracks.forEach(track => {
      const onTrack = st().clips
        .filter(c => (Number(c.trackIndex) || 0) === track)
        .sort((a, b) => a.start - b.start);
      let shift = 0;
      onTrack.forEach(c => {
        c.start = Math.max(0, c.start + shift);
        if (!ids.has(c.id)) return;
        const f = fxOf(c).speed / fxNew.speed;
        const before = c.duration;
        const maxDur = Math.max(0.05, (Number(template.sourceDuration) || Infinity) - c.trimStart * f);
        c.trimStart = Math.max(0, (Number(c.trimStart) || 0) * f);
        c.duration = Math.min(maxDur, Math.max(0.05, c.duration * f));
        c.trimEnd = c.trimStart + c.duration;
        window.ClipKF?.rescaleSource(c, f);   // keyframes de volume acompanham o áudio reescalado
        c.fadeIn = Math.min(Number(c.fadeIn) || 0, c.duration / 2);
        c.fadeOut = Math.min(Number(c.fadeOut) || 0, c.duration / 2);
        shift += c.duration - before;
      });
    });
  }

  /**
   * Edição em grupo: muda só `path` ('pitch', 'lowcut', 'denoise.on'…) e
   * mantém os outros ajustes de cada clip. Clips com o mesmo arquivo e o
   * mesmo resultado vão juntos ao servidor; um passo de undo para tudo.
   */
  async function applyField(clipIds, path, value) {
    const groups = new Map();
    clipIds.map(id => st().clips.find(c => c.id === id))
      .filter(c => originOf(tmplOf(c))?.type === 'audio')
      .forEach(c => {
        const cur = fxOf(c);
        const fx = normalizeFx(path.startsWith('denoise.')
          ? { ...cur, denoise: { ...cur.denoise, [path.slice(8)]: value } }
          : { ...cur, [path]: value });
        const key = `${originOf(tmplOf(c)).id}|${fxSig(fx)}`;
        if (!groups.has(key)) groups.set(key, { fx, ids: [] });
        groups.get(key).ids.push(c.id);
      });
    let first = true;
    for (const g of groups.values()) {
      await applyFx(g.ids, g.fx, { undo: first });
      first = false;
    }
  }

  async function applyFx(clipIds, rawFx, { undo = true } = {}) {
    const fx = normalizeFx(rawFx);
    const seq = ++applySeq;
    const targets = clipIds.map(id => st().clips.find(c => c.id === id)).filter(Boolean);
    if (!targets.length) return;
    const origin = originOf(tmplOf(targets[0]));
    if (!origin || origin.type !== 'audio') return;

    busy = { clipIds, fx };
    window.__renderProps?.();
    const t0 = performance.now();
    if (!isNeutral(fx)) status('🎚 Processando o áudio…');

    try {
      const template = await derivedTemplate(origin, fx);
      if (seq !== applySeq) return;   // outro ajuste chegou depois: vale o último

      const live = targets.filter(c => st().clips.includes(c));
      if (!live.length) return;
      if (undo) window.__tlPushUndo?.();
      rescale(live, fx, template);
      live.forEach(c => {
        c.templateId = template.id;
        if (isNeutral(fx)) delete c.audioFx;
        else c.audioFx = fx;
        window.__Compositor?.unmount(c.id);
      });
      pruneDerived();
      busy = null;
      window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
      window.__syncCompositorToTime?.(st().time);
      status(isNeutral(fx)
        ? '🎚 Áudio original restaurado'
        : `🎚 Ajustes aplicados em ${live.length} clip(s) · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      if (seq !== applySeq) return;
      busy = null;
      console.error('[Áudio] Ajustes:', err);
      status(`⚠ Não foi possível ajustar o áudio: ${err.message}`);
      window.MSUI.notify(`Não foi possível ajustar o áudio.\n\n${err.message}`);
    } finally {
      if (seq === applySeq) { busy = null; window.__renderProps?.(); }
    }
  }
  // #endregion

  // #region Painel
  const slider = (key, label, min, max, step, value, unit, hint = '') => `
    <div class="prop-row fx-slider">
      <label${hint ? ` title="${esc(hint)}"` : ''}>${label}</label>
      <input type="range" class="prop-range" min="${min}" max="${max}" step="${step}" value="${value}" data-at="${key}">
      <span class="fx-val" data-edit data-unit="${unit}" title="Clique para digitar">${fmt(key, value)}</span>
    </div>`;

  function fmt(key, value) {
    const v = Number(value);
    if (key === 'speed') return `${v.toFixed(2)}×`;
    if (key === 'pitch') return `${v > 0 ? '+' : ''}${v}`;
    if (key === 'lowcut') return v ? `${v} Hz` : 'off';
    if (key === 'denoise.floor') return `${v} dB`;
    return `${v}%`;
  }

  function renderProps(clip, tmpl) {
    if (tmpl?.type !== 'audio') return '';
    const pending = busy?.clipIds.includes(clip.id) ? busy.fx : null;
    const fx = pending || fxOf(clip);
    const siblings = siblingsOf(clip).length;
    const id = esc(clip.id);
    return `
      <div class="prop-section at-props" data-clip-id="${id}">
        <div class="prop-title fx-title">Velocidade e tom
          ${isNeutral(fxOf(clip)) ? '' : '<button class="fx-clear" data-at-action="reset" title="Voltar ao áudio original">original</button>'}
        </div>
        ${slider('speed', 'Velocidade', 0.25, 4, 0.05, fx.speed, '×', 'Muda a duração do clip sem mudar o tom')}
        <div class="at-chips">
          ${SPEEDS.map(s => `<button class="at-chip" data-at-speed="${s}"${s === fx.speed ? ' data-on' : ''}>${s}×</button>`).join('')}
        </div>
        ${slider('pitch', 'Tom', -12, 12, 0.5, fx.pitch, '', 'Semitons: deixa a voz mais grave ou mais aguda sem mudar a velocidade')}
      </div>

      <div class="prop-section at-props" data-clip-id="${id}">
        <div class="prop-title">Limpeza da voz</div>
        <div class="prop-row">
          <label title="Remove chiado, ventilador, ar-condicionado e ruído de fundo constante">Redutor de ruído</label>
          <input type="checkbox" data-at="denoise.on"${fx.denoise.on ? ' checked' : ''}>
        </div>
        <div class="at-sub"${fx.denoise.on ? '' : ' hidden'}>
          ${slider('denoise.amount', 'Intensidade', 0, 100, 1, fx.denoise.amount, '%', 'Quanto do ruído é removido (alto demais deixa a voz "metálica")')}
          ${slider('denoise.floor', 'Sensibilidade', -80, -20, 1, fx.denoise.floor, ' dB', 'Nível do ruído de fundo: suba se o ruído for alto, desça se a gravação for limpa')}
        </div>
        ${slider('lowcut', 'Corte de graves', 0, 300, 5, fx.lowcut, ' Hz', 'Remove ronco, vento e batidas no microfone abaixo desta frequência (voz: 80–120 Hz)')}
        <div class="prop-row">
          <label title="Equilibra partes baixas e altas da fala">Nivelar voz</label>
          <input type="checkbox" data-at="level"${fx.level ? ' checked' : ''}>
        </div>
        ${siblings > 1 ? `
          <label class="at-scope">
            <input type="checkbox" data-at-scope${applyAll ? ' checked' : ''}>
            Aplicar nos ${siblings} trechos deste áudio
          </label>` : ''}
        <div class="at-status"${pending ? '' : ' hidden'}><span class="at-spin"></span>Processando o áudio…</div>
      </div>

      <div class="prop-section at-props" data-clip-id="${id}">
        <div class="prop-title">Cortes automáticos</div>
        <div class="at-cut-buttons">
          <button class="at-cut" data-at-action="cut-silence" title="Detecta as pausas pelo volume e remove (rápido, sem internet)">
            <b>✂ Remover silêncios</b><span>Corta as pausas pelo volume</span>
          </button>
          <button class="at-cut" data-at-action="cut-ai" title="Transcreve, a IA aponta erros, repetições e hesitações; os silêncios também saem">
            <b>✨ Limpar com IA</b><span>Transcreve, corta erros, repetições e pausas</span>
          </button>
        </div>
      </div>`;
  }

  /** Ajustes atuais lidos do painel */
  function readPanel(root) {
    const get = key => root.querySelector(`[data-at="${key}"]`);
    return normalizeFx({
      speed: get('speed')?.value,
      pitch: get('pitch')?.value,
      denoise: {
        on: get('denoise.on')?.checked,
        amount: get('denoise.amount')?.value,
        floor: get('denoise.floor')?.value,
      },
      lowcut: get('lowcut')?.value,
      level: get('level')?.checked,
    });
  }

  let debounce = null;

  function schedule(clipId, fx) {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const clip = st().clips.find(c => c.id === clipId);
      if (!clip) return;
      const ids = applyAll ? siblingsOf(clip).map(c => c.id) : [clip.id];
      applyFx(ids, fx);
    }, 250);
  }

  function initPanel() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    props.addEventListener('input', e => {
      const input = e.target.closest('.at-props [data-at]');
      if (!input || input.type !== 'range') return;
      const val = input.parentElement.querySelector('.fx-val');
      if (val && !val.querySelector('input')) val.textContent = fmt(input.dataset.at, input.value);
    });
    props.addEventListener('change', e => {
      const section = e.target.closest('.at-props');
      if (!section) return;
      if (e.target.matches('[data-at-scope]')) { applyAll = e.target.checked; return; }
      if (!e.target.matches('[data-at]')) return;
      if (e.target.dataset.at === 'denoise.on') {
        const sub = props.querySelector('.at-sub');
        if (sub) sub.hidden = !e.target.checked;
      }
      schedule(section.dataset.clipId, readPanel(props));
    });
    props.addEventListener('click', e => {
      const btn = e.target.closest('.at-props [data-at-speed], .at-props [data-at-action]');
      if (!btn) return;
      const clipId = btn.closest('.at-props').dataset.clipId;
      if (btn.dataset.atSpeed) {
        const range = props.querySelector('[data-at="speed"]');
        if (range) range.value = btn.dataset.atSpeed;
        props.querySelectorAll('.at-chip').forEach(c => c.toggleAttribute('data-on', c === btn));
        schedule(clipId, readPanel(props));
      } else if (btn.dataset.atAction === 'reset') {
        schedule(clipId, normalizeFx({}));
      } else if (btn.dataset.atAction === 'cut-silence') {
        window.MSAutoCut?.open(clipId, 'silence');
      } else if (btn.dataset.atAction === 'cut-ai') {
        window.MSAutoCut?.open(clipId, 'ai');
      }
    });
  }
  // #endregion

  window.__renderAudioToolsProps = renderProps;
  window.MSAudioTools = { applyFx, applyField, normalizeFx, isNeutral, fxOf, originOf, siblingsOf };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel);
  else initPanel();
})();
