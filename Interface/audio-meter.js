'use strict';
// audio-meter.js
//
//  Medidor de dB da track selecionada (painel direito) e no painel de clips
//  de áudio. Os níveis vêm da análise que timeline-pro.js já faz das mídias
//  (pico e RMS absolutos a 20/s), multiplicados pelo ganho que o preview e o
//  export aplicam (volume do clip e da track, fades, mudo/solo) — o medidor
//  mostra o que vai sair no vídeo, tocando ou parado no playhead.

(() => {
  const DB_MIN = -60;          // fundo da escala
  const PEAK_FALL = 24;        // dB/s de queda do pico exibido
  const HOLD_MS = 1500;        // retenção do pico máximo
  const TARGET_PEAK = -1;      // "ajustar pico" mira -1 dBFS
  const SCALE = [-48, -36, -24, -12, 0];

  const st = () => window.__appState;
  const meters = new Map();    // elemento → { shown, hold, holdAt, clipped }
  let raf = null;
  let undoArmed = false;

  const toDb = v => (v > 1e-6 ? 20 * Math.log10(v) : -Infinity);
  const fromDb = db => (db <= DB_MIN ? 0 : Math.pow(10, db / 20));
  const pct = db => (Number.isFinite(db) ? Math.max(0, Math.min(100, (db - DB_MIN) / -DB_MIN * 100)) : 0);
  const fmtDb = db => (Number.isFinite(db) ? `${db > 0 ? '+' : ''}${db.toFixed(1)} dB` : '−∞');

  function hasAudio(tmpl) {
    return tmpl?.type === 'audio' || tmpl?.type === 'video';
  }

  /** Nível linear (pico, RMS) da track — ou da mixagem, com trackIndex null — no tempo t */
  function levelAt(t, trackIndex) {
    const state = st();
    let power = 0, peak = 0, analyzing = false, any = false;
    state.clips.forEach(clip => {
      if (trackIndex != null && (Number(clip.trackIndex) || 0) !== trackIndex) return;
      if (t < clip.start || t >= clip.start + clip.duration) return;
      const tmpl = state.templates.find(x => x.id === clip.templateId);
      if (!hasAudio(tmpl)) return;
      any = true;
      const levels = window.__mediaLevels?.(tmpl);
      if (!levels) { analyzing = true; return; }
      const index = Math.floor(((Number(clip.trimStart) || 0) + (t - clip.start)) * levels.rate);
      if (index < 0 || index >= levels.rms.length) return;
      const gain = window.__previewMuted ? 0 : (window.__clipAudioGain ? window.__clipAudioGain(clip, t) : 1);
      power += (levels.rms[index] * gain) ** 2;
      peak += levels.peak[index] * gain;   // soma de picos: pior caso da mixagem
    });
    return { rms: Math.sqrt(power), peak, analyzing, any };
  }

  /** Pico máximo e média RMS (só trechos com som) da track inteira */
  function trackStats(trackIndex) {
    const state = st();
    const clips = state.clips.filter(c => (Number(c.trackIndex) || 0) === trackIndex &&
      hasAudio(state.templates.find(x => x.id === c.templateId)));
    if (!clips.length) return null;
    const t0 = Math.min(...clips.map(c => c.start));
    const t1 = Math.max(...clips.map(c => c.start + c.duration));
    let maxPeak = 0, power = 0, n = 0, analyzing = false;
    for (let t = t0; t < t1; t += 0.05) {
      const lv = levelAt(t, trackIndex);
      if (lv.analyzing) analyzing = true;
      if (lv.peak > maxPeak) maxPeak = lv.peak;
      if (toDb(lv.rms) > -50) { power += lv.rms * lv.rms; n++; }
    }
    return { maxPeakDb: toDb(maxPeak), avgRmsDb: n ? toDb(Math.sqrt(power / n)) : -Infinity, analyzing, clipCount: clips.length };
  }

  // #region HTML
  function meterHtml(scope, label) {
    return `
      <div class="am-meter" data-scope="${scope}">
        <span class="am-label">${label}</span>
        <div class="am-bar">
          <div class="am-rms"></div><div class="am-peak"></div><div class="am-hold"></div>
        </div>
        <button class="am-clip" title="Passou de 0 dB (distorce no vídeo final). Clique para limpar."></button>
      </div>`;
  }

  function scaleHtml() {
    return `<div class="am-scale">${SCALE.map(db => `<span style="left:${pct(db)}%">${db}</span>`).join('')}</div>`;
  }

  /** Bloco de medidores (usado no painel da track e no do clip de áudio) */
  function renderMeter(trackIndex) {
    if (trackIndex == null) return '';
    return `
      <div class="am-meters" data-track="${trackIndex}">
        ${meterHtml('track', 'Track')}
        ${meterHtml('mix', 'Mix')}
        ${scaleHtml()}
        <div class="am-readout">
          <span>Pico <b data-am="peak">−∞</b></span>
          <span>RMS <b data-am="rms">−∞</b></span>
          <span class="am-status" data-am="status"></span>
        </div>
      </div>`;
  }

  function renderTrackPanel(trackIndex) {
    if (trackIndex == null || !st()?.project) return '';
    const state = st();
    const track = window.getTrack ? getTrack(trackIndex) : { name: `V${trackIndex + 1}` };
    const clips = state.clips.filter(c => (Number(c.trackIndex) || 0) === trackIndex);
    const stats = trackStats(trackIndex);
    queueMicrotask(startLoop);

    if (!stats) {
      return `
        <div class="prop-section">
          <div class="prop-title">Track ${escapeHtml(track.name)}</div>
          <p class="am-note">${clips.length} clip(s) · sem áudio nesta track.</p>
          <p class="am-note">Cortar (S) e apagar (Del) agem só nos clips desta track. Esc desmarca.</p>
        </div>`;
    }

    const volDb = toDb(Number(track.volume ?? 1));
    const headroom = -stats.maxPeakDb;
    const advice = !Number.isFinite(stats.maxPeakDb)
      ? 'Sem som audível na track.'
      : stats.maxPeakDb > -0.3
        ? `<b class="am-bad">Passa de 0 dB</b>: abaixe ${(stats.maxPeakDb - TARGET_PEAK).toFixed(1)} dB para não distorcer.`
        : stats.maxPeakDb < -12
          ? 'Baixo: dá para subir o volume dos clips (o da track vai até 0 dB).'
          : 'Bom nível.';
    return `
      <div class="am-panel" data-track="${trackIndex}">
        <div class="prop-section">
          <div class="prop-title">Áudio · Track ${escapeHtml(track.name)}</div>
          ${renderMeter(trackIndex)}
        </div>

        <div class="prop-section">
          <div class="prop-title">Volume da track</div>
          <div class="prop-row am-vol">
            <input type="range" class="prop-range" min="${DB_MIN}" max="0" step="0.5" value="${Number.isFinite(volDb) ? volDb.toFixed(1) : DB_MIN}" data-am="vol" title="Clique duplo: 0 dB">
            <span class="am-vol-val" data-am="volval">${fmtDb(volDb)}</span>
          </div>
          <div class="am-toggles">
            <button class="am-toggle${track.muted ? ' is-on' : ''}" data-am="mute">Mudo</button>
            <button class="am-toggle${track.solo ? ' is-on' : ''}" data-am="solo">Solo</button>
          </div>
        </div>

        <div class="prop-section">
          <div class="prop-title">Análise da track${stats.analyzing ? ' <small>(analisando…)</small>' : ''}</div>
          <div class="prop-row"><label>Pico máximo</label><span class="prop-val">${fmtDb(stats.maxPeakDb)}</span></div>
          <div class="prop-row"><label>Volume médio (RMS)</label><span class="prop-val">${fmtDb(stats.avgRmsDb)}</span></div>
          <div class="prop-row"><label>Margem até 0 dB</label><span class="prop-val">${Number.isFinite(headroom) ? `${headroom.toFixed(1)} dB` : '—'}</span></div>
          <p class="am-note">${advice}</p>
          <button class="btn-secondary am-normalize" data-am="normalize" title="Ajusta o volume da track para o pico ficar em ${TARGET_PEAK} dB">Ajustar pico para ${TARGET_PEAK} dB</button>
          <p class="am-note" data-am="normmsg"></p>
        </div>
      </div>`;
  }
  // #endregion

  // #region Atualização ao vivo
  function startLoop() {
    if (raf) return;
    let last = performance.now();
    const tick = now => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const blocks = document.querySelectorAll('.am-meters');
      if (!blocks.length || !st()?.project) { raf = null; meters.clear(); return; }
      blocks.forEach(block => updateBlock(block, dt, now));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function updateBlock(block, dt, now) {
    const t = st().time;
    const trackIndex = Number(block.dataset.track);
    let readout = null;
    block.querySelectorAll('.am-meter').forEach(meter => {
      const lv = levelAt(t, meter.dataset.scope === 'mix' ? null : trackIndex);
      const peakDb = toDb(lv.peak);
      const rmsDb = toDb(lv.rms);
      let m = meters.get(meter);
      if (!m) { m = { shown: DB_MIN, hold: DB_MIN, holdAt: 0 }; meters.set(meter, m); }
      // Pico sobe na hora e cai devagar; retenção do máximo por HOLD_MS
      m.shown = Math.max(Number.isFinite(peakDb) ? peakDb : DB_MIN, m.shown - PEAK_FALL * dt);
      if (peakDb >= m.hold || now - m.holdAt > HOLD_MS) { m.hold = Number.isFinite(peakDb) ? peakDb : DB_MIN; m.holdAt = now; }
      meter.querySelector('.am-rms').style.clipPath = `inset(0 ${100 - pct(rmsDb)}% 0 0)`;
      meter.querySelector('.am-peak').style.clipPath = `inset(0 ${100 - pct(m.shown)}% 0 0)`;
      const hold = meter.querySelector('.am-hold');
      hold.style.left = `${pct(m.hold)}%`;
      hold.classList.toggle('is-hot', m.hold > -3);
      if (peakDb > -0.3) meter.querySelector('.am-clip').classList.add('is-on');
      if (meter.dataset.scope === 'track') readout = { peakDb, rmsDb, lv };
    });
    if (readout) {
      block.querySelector('[data-am="peak"]').textContent = fmtDb(readout.peakDb);
      block.querySelector('[data-am="rms"]').textContent = fmtDb(readout.rmsDb);
      block.querySelector('[data-am="status"]').textContent = readout.lv.analyzing
        ? 'analisando o áudio…'
        : readout.lv.any ? '' : 'sem áudio no playhead';
    }
  }
  // #endregion

  // #region Controles
  function setTrackVolume(trackIndex, db, { undo }) {
    if (undo) window.__tlPushUndo?.();
    const track = getTrack(trackIndex);
    track.volume = Math.round(fromDb(db) * 10000) / 10000;
    window.__syncCompositorToTime?.(st().time);
    if (typeof refreshClipBlock === 'function') {
      st().clips.filter(c => (Number(c.trackIndex) || 0) === trackIndex).forEach(c => refreshClipBlock(c.id));
    }
  }

  function initEvents() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    props.addEventListener('input', e => {
      if (e.target.dataset.am !== 'vol') return;
      const panel = e.target.closest('.am-panel');
      setTrackVolume(Number(panel.dataset.track), Number(e.target.value), { undo: !undoArmed });
      undoArmed = true;
      panel.querySelector('[data-am="volval"]').textContent = fmtDb(Number(e.target.value) <= DB_MIN ? -Infinity : Number(e.target.value));
    });
    props.addEventListener('change', e => {
      if (e.target.dataset.am !== 'vol') return;
      undoArmed = false;
      window.__renderProps?.();   // atualiza a análise com o volume novo
    });
    props.addEventListener('dblclick', e => {
      if (e.target.dataset.am !== 'vol') return;
      e.target.value = 0;
      e.target.dispatchEvent(new Event('input', { bubbles: true }));
      e.target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    props.addEventListener('click', e => {
      const btn = e.target.closest('[data-am]');
      if (!btn) return;
      const panel = btn.closest('.am-panel');
      if (!panel) return;
      const ti = Number(panel.dataset.track);
      if (btn.dataset.am === 'mute') { window.toggleTrackMuted?.(ti); window.__renderProps?.(); }
      if (btn.dataset.am === 'solo') { window.toggleTrackSolo?.(ti); window.__renderProps?.(); }
      if (btn.dataset.am === 'normalize') normalize(ti, panel);
    });
    // Indicador de clipagem: clique limpa
    document.addEventListener('click', e => {
      e.target.closest('.am-clip')?.classList.remove('is-on');
    });
  }

  function normalize(trackIndex, panel) {
    const stats = trackStats(trackIndex);
    const msg = panel.querySelector('[data-am="normmsg"]');
    if (!stats || !Number.isFinite(stats.maxPeakDb)) { msg.textContent = 'Sem áudio para medir.'; return; }
    if (stats.analyzing) { msg.textContent = 'Aguarde a análise do áudio terminar.'; return; }
    const track = getTrack(trackIndex);
    const current = Number(track.volume ?? 1);
    const next = Math.min(1, current * fromDb(TARGET_PEAK - stats.maxPeakDb));
    if (Math.abs(next - current) < 1e-4) {
      msg.textContent = current >= 1
        ? 'O volume da track já está em 0 dB (máximo). Para subir mais, aumente o volume dos clips.'
        : 'Já está no ponto.';
      return;
    }
    setTrackVolume(trackIndex, toDb(next), { undo: true });
    window.__renderProps?.();
  }
  // #endregion

  window.__renderTrackPanel = renderTrackPanel;
  window.__renderAudioMeter = trackIndex => {
    queueMicrotask(startLoop);
    return `<div class="prop-section"><div class="prop-title">Nível</div>${renderMeter(Number(trackIndex) || 0)}</div>`;
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEvents, { once: true });
  else initEvents();
})();
