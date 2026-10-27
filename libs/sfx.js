'use strict';
// sfx.js
//
//  Efeitos sonoros dos clipes HTML. O clipe declara as deixas em
//  window.Motion.sfx = [{ t, type | sound, gain?, pitch?, dur?, pan? }, …] (t em
//  segundos do próprio clipe):
//   - type: som sintetizado aqui (WebAudio offline, ruído de seed fixa — o
//     mesmo clipe sempre gera o mesmo som)
//   - sound: "<pacote>/<som>" de uma biblioteca externa CC0 (libs/sfx-library.js),
//     baixado da CDN e mixado junto
//  O resultado vira um WAV numa faixa de áudio normal (preview, waveform,
//  volume, export) — ver Interface/audio-extract.js.

(() => {
  const TYPES = {
    whoosh:       { dur: 0.6,  desc: 'passagem de ar (entradas/saídas rápidas)' },
    swipe:        { dur: 0.25, desc: 'deslize curto (cards, troca de tela)' },
    riser:        { dur: 1.5,  desc: 'subida de tensão antes de uma revelação (termina no impacto)' },
    impact:       { dur: 1.2,  desc: 'batida grave (revelação, título, logo)' },
    bass:         { dur: 1.0,  desc: 'sub grave 808 (drop, ênfase)' },
    pop:          { dur: 0.15, desc: 'bolha/pop (elemento aparecendo)' },
    click:        { dur: 0.05, desc: 'clique de interface' },
    tick:         { dur: 0.03, desc: 'tique curto (contador, relógio)' },
    typing:       { dur: 1.0,  desc: 'teclado digitando (dur = tempo de digitação)' },
    ding:         { dur: 1.2,  desc: 'sino limpo (acerto, destaque)' },
    chime:        { dur: 1.0,  desc: 'brilho/sparkle em arpejo agudo' },
    success:      { dur: 0.8,  desc: 'acorde ascendente de conquista' },
    notification: { dur: 0.45, desc: 'notificação de mensagem (duas notas)' },
    coin:         { dur: 0.45, desc: 'moeda/dinheiro (preço, desconto)' },
    glitch:       { dur: 0.35, desc: 'ruído digital picotado' },
  };

  // #region Utilidades de síntese
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function noise(ctx, seconds, seed) {
    const len = Math.max(1, Math.ceil(seconds * ctx.sampleRate));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const rnd = mulberry32(seed);
    for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  /** Envelope: sobe até `peak` em `attack` e cai exponencialmente até `end` */
  function envelope(param, t, attack, end, peak) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.002, attack));
    param.exponentialRampToValueAtTime(0.0001, Math.max(t + attack + 0.005, end));
  }

  function osc(ctx, type, freq, t, end) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    o.stop(end + 0.05);
    return o;
  }

  function voice(ctx, dest, t, end, peak, attack = 0.005) {
    const g = ctx.createGain();
    envelope(g.gain, t, attack, end, peak);
    g.connect(dest);
    return g;
  }
  // #endregion

  // #region Receitas
  const RECIPES = {
    whoosh(ctx, out, t, { dur, pitch, seed }) {
      const src = noise(ctx, dur, seed);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(350 * pitch, t);
      bp.frequency.exponentialRampToValueAtTime(3200 * pitch, t + dur * 0.55);
      bp.frequency.exponentialRampToValueAtTime(500 * pitch, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + dur * 0.55);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp).connect(g).connect(out);
      src.start(t); src.stop(t + dur + 0.05);
    },
    swipe(ctx, out, t, { dur, pitch, seed }) {
      const src = noise(ctx, dur, seed);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200 * pitch;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(1800 * pitch, t);
      bp.frequency.exponentialRampToValueAtTime(6500 * pitch, t + dur);
      src.connect(hp).connect(bp).connect(voice(ctx, out, t, t + dur, 0.8, dur * 0.3));
      src.start(t); src.stop(t + dur + 0.05);
    },
    riser(ctx, out, t, { dur, pitch, seed }) {
      const end = t + dur;
      const o = osc(ctx, 'sawtooth', 110 * pitch, t, end);
      o.frequency.exponentialRampToValueAtTime(880 * pitch, end);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.exponentialRampToValueAtTime(6000, end);
      const n = noise(ctx, dur, seed);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(800, t);
      hp.frequency.exponentialRampToValueAtTime(8000, end);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55, end - 0.02);
      g.gain.linearRampToValueAtTime(0, end + 0.02);   // corta seco no impacto
      o.connect(lp).connect(g);
      n.connect(hp).connect(g);
      g.connect(out);
      n.start(t); n.stop(end + 0.05);
    },
    impact(ctx, out, t, { dur, pitch, seed }) {
      const o = osc(ctx, 'sine', 120 * pitch, t, t + dur);
      o.frequency.exponentialRampToValueAtTime(38 * pitch, t + 0.3);
      o.connect(voice(ctx, out, t, t + dur, 1, 0.003));
      const n = noise(ctx, 0.25, seed);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      n.connect(lp).connect(voice(ctx, out, t, t + 0.25, 0.6, 0.002));
      n.start(t); n.stop(t + 0.3);
    },
    bass(ctx, out, t, { dur, pitch }) {
      const o = osc(ctx, 'sine', 58 * pitch, t, t + dur);
      o.frequency.exponentialRampToValueAtTime(44 * pitch, t + dur);
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(2.2 * x); }
      shaper.curve = curve;
      o.connect(shaper).connect(voice(ctx, out, t, t + dur, 0.9, 0.01));
    },
    pop(ctx, out, t, { dur, pitch }) {
      const o = osc(ctx, 'sine', 380 * pitch, t, t + dur);
      o.frequency.exponentialRampToValueAtTime(1400 * pitch, t + 0.05);
      o.connect(voice(ctx, out, t, t + dur, 0.8, 0.002));
    },
    click(ctx, out, t, { dur, pitch, seed }) {
      const n = noise(ctx, 0.03, seed);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500 * pitch;
      n.connect(hp).connect(voice(ctx, out, t, t + Math.min(dur, 0.03), 0.7, 0.001));
      n.start(t); n.stop(t + 0.05);
      osc(ctx, 'sine', 1800 * pitch, t, t + 0.02).connect(voice(ctx, out, t, t + 0.02, 0.35, 0.001));
    },
    tick(ctx, out, t, { dur, pitch }) {
      osc(ctx, 'square', 3200 * pitch, t, t + dur).connect(voice(ctx, out, t, t + Math.max(0.012, dur), 0.35, 0.001));
    },
    typing(ctx, out, t, { dur, pitch, seed }) {
      const rnd = mulberry32(seed);
      for (let k = t; k < t + dur; k += 0.06 + rnd() * 0.07) {
        RECIPES.click(ctx, out, k, { dur: 0.03, pitch: pitch * (0.8 + rnd() * 0.5), seed: Math.floor(rnd() * 1e9) });
      }
    },
    ding(ctx, out, t, { dur, pitch }) {
      osc(ctx, 'sine', 1318.5 * pitch, t, t + dur).connect(voice(ctx, out, t, t + dur, 0.6, 0.003));
      osc(ctx, 'sine', 1318.5 * 2.76 * pitch, t, t + dur * 0.5).connect(voice(ctx, out, t, t + dur * 0.5, 0.15, 0.003));
    },
    chime(ctx, out, t, { dur, pitch }) {
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => {
        const s = t + i * 0.06;
        osc(ctx, 'triangle', f * pitch, s, s + dur).connect(voice(ctx, out, s, s + dur, 0.35, 0.003));
      });
    },
    success(ctx, out, t, { dur, pitch }) {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const s = t + i * 0.08;
        const end = s + Math.max(0.2, dur - i * 0.08);
        osc(ctx, 'triangle', f * pitch, s, end).connect(voice(ctx, out, s, end, 0.4, 0.004));
      });
    },
    notification(ctx, out, t, { pitch }) {
      osc(ctx, 'sine', 880 * pitch, t, t + 0.18).connect(voice(ctx, out, t, t + 0.18, 0.5, 0.003));
      osc(ctx, 'sine', 1320 * pitch, t + 0.13, t + 0.45).connect(voice(ctx, out, t + 0.13, t + 0.45, 0.5, 0.003));
    },
    coin(ctx, out, t, { pitch }) {
      osc(ctx, 'square', 988 * pitch, t, t + 0.08).connect(voice(ctx, out, t, t + 0.08, 0.25, 0.002));
      osc(ctx, 'square', 1319 * pitch, t + 0.08, t + 0.45).connect(voice(ctx, out, t + 0.08, t + 0.45, 0.25, 0.002));
    },
    glitch(ctx, out, t, { dur, pitch, seed }) {
      const rnd = mulberry32(seed);
      for (let k = t; k < t + dur; k += 0.025 + rnd() * 0.04) {
        const len = 0.015 + rnd() * 0.03;
        if (rnd() < 0.5) {
          osc(ctx, 'square', (200 + rnd() * 2400) * pitch, k, k + len).connect(voice(ctx, out, k, k + len, 0.25, 0.001));
        } else {
          const n = noise(ctx, len, Math.floor(rnd() * 1e9));
          n.connect(voice(ctx, out, k, k + len, 0.3, 0.001));
          n.start(k); n.stop(k + len + 0.01);
        }
      }
    },
  };
  // #endregion

  // #region API
  const SOUND_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

  /** Valida e completa as deixas (tipos/sons desconhecidos são descartados) */
  function normalizeCues(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c, i) => {
        const type = String(c?.type || '').toLowerCase();
        const sound = String(c?.sound || '').toLowerCase().trim();
        const isSample = SOUND_RE.test(sound);
        if (!TYPES[type] && !isSample) return null;
        const t = Number(c.t ?? c.time ?? c.at);
        if (!Number.isFinite(t) || t < 0) return null;
        const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
        return {
          t,
          type: isSample ? 'sample' : type,
          sound: isSample ? sound : undefined,
          gain: num(c.gain ?? c.volume, 0.8, 0, 1.5),
          pitch: num(c.pitch, 1, 0.25, 4),
          dur: num(c.dur ?? c.duration, isSample ? 0 : TYPES[type].dur, 0, 30),
          pan: num(c.pan, 0, -1, 1),
          seed: 1 + i * 7919 + Math.round(t * 1000),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);
  }

  // #region Biblioteca externa
  let libraryPromise = null;
  const sampleBytes = new Map();   // url → ArrayBuffer (cópia; decodeAudioData consome o original)
  const sampleMeta = new Map();    // id → { sync, … } (ponto de sincronia do sfxkit)
  const external = new Map();      // id → { url, … } (Openverse: baixado pelo servidor)

  /** Sons de busca (Openverse) devolvidos pela IA: "ov/<id>" → { url, title, license… } */
  function addExternal(map) {
    Object.entries(map || {}).forEach(([id, info]) => { if (info?.url) external.set(id, info); });
  }

  /** "<pacote>/<som>" → URL do arquivo (null se a biblioteca não tiver) */
  function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = fetch('/api/sfx/library')
        .then(r => (r.ok ? r.json() : { libraries: [] }))
        .catch(() => ({ libraries: [] }))
        .then(({ libraries = [] }) => {
          const urls = new Map();
          libraries.forEach(lib => Object.entries(lib.files || {}).forEach(([id, f]) => {
            if (!urls.has(id)) urls.set(id, lib.base + f.path);
            if (f.sync) sampleMeta.set(id, { sync: f.sync });
          }));
          if (!urls.size) libraryPromise = null;   // offline: tenta de novo depois
          return urls;
        });
    }
    return libraryPromise;
  }

  /** Mesmo som em outro pacote quando o pedido não existe no pacote escolhido */
  function resolveSound(urls, id) {
    if (external.has(id)) return external.get(id).url;
    if (urls.has(id)) return urls.get(id);
    const cue = id.split('/')[1];
    for (const [key, url] of urls) if (key.endsWith('/' + cue)) return url;
    return null;
  }

  /** Pico e começo audível (>3% do pico) de um som baixado: gravações externas vêm em níveis e com silêncios diferentes */
  function measure(buffer) {
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    let onset = 0;
    const lim = peak * 0.03;
    const d0 = buffer.getChannelData(0);
    for (let i = 0; i < d0.length; i++) { if (Math.abs(d0[i]) > lim) { onset = i / buffer.sampleRate; break; } }
    return { peak, onset: Math.max(0, onset - 0.005) };
  }

  async function sampleBuffer(ctx, url) {
    if (!sampleBytes.has(url)) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`som ${url}: HTTP ${resp.status}`);
      sampleBytes.set(url, await resp.arrayBuffer());
    }
    return ctx.decodeAudioData(sampleBytes.get(url).slice(0));
  }
  // #endregion

  /**
   * Sintetiza as deixas num AudioBuffer estéreo de `duration` segundos.
   * `stats` (opcional) recebe { used, skipped }: sons de biblioteca que não
   * existem ou não baixaram ficam de fora.
   */
  async function render(cues, duration, { sampleRate = 44100, stats = null } = {}) {
    const length = Math.max(1, Math.ceil(duration * sampleRate));
    const ctx = new OfflineAudioContext(2, length, sampleRate);
    // Compressor no master: vários sons juntos não estouram
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    const master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(comp).connect(ctx.destination);

    // Sons de biblioteca: baixa e decodifica antes de agendar
    const samples = new Map();
    const wanted = [...new Set(cues.filter(c => c.type === 'sample' && c.t < duration).map(c => c.sound))];
    if (wanted.length) {
      const urls = await loadLibrary();
      await Promise.all(wanted.map(async id => {
        const url = resolveSound(urls, id);
        if (!url) return console.warn(`[SFX] som "${id}" não existe na biblioteca`);
        try { samples.set(id, await sampleBuffer(ctx, url)); } catch (err) { console.warn('[SFX]', err.message); }
      }));
    }

    let used = 0;
    let skipped = 0;
    for (const cue of cues) {
      if (cue.t >= duration) continue;
      if (cue.type === 'sample' && !samples.has(cue.sound)) { skipped++; continue; }
      used++;
      const g = ctx.createGain();
      g.gain.value = cue.gain;
      let buf = null;
      let sync = 0;
      if (cue.type === 'sample') {
        buf = samples.get(cue.sound);
        if (external.has(cue.sound)) {
          // Openverse: nivela o pico (~-3 dB) e corta o silêncio inicial → t = quando o som é ouvido
          const m = measure(buf);
          if (m.peak > 0.001) g.gain.value *= Math.min(4, 0.7 / m.peak);
          sync = m.onset;
        } else {
          sync = sampleMeta.get(cue.sound)?.sync || 0;   // sfxkit: o ponto que encontra o momento
        }
        sync /= cue.pitch;
      }
      const pan = ctx.createStereoPanner();
      pan.pan.value = cue.pan;
      g.connect(pan).connect(master);
      if (cue.type === 'sample') {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = cue.pitch;
        src.connect(g);
        // começa `sync` antes do momento; se não cabe antes do 0, pula o início do arquivo
        const at = cue.t - sync;
        const skip = at < 0 ? -at * cue.pitch : 0;
        const start = Math.max(0, at);
        if (cue.dur > 0) {
          // fade curto no corte (dur limita a duração do som)
          const end = start + cue.dur;
          g.gain.setValueAtTime(g.gain.value, Math.max(start, end - 0.04));
          g.gain.linearRampToValueAtTime(0, end);
          src.start(start, skip);
          src.stop(end + 0.01);
        } else {
          src.start(start, skip);
        }
      } else {
        RECIPES[cue.type](ctx, g, cue.t, cue);
      }
    }
    if (stats) Object.assign(stats, { used, skipped });
    return ctx.startRendering();
  }

  /** WAV PCM 16-bit */
  function toWav(buffer) {
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const bytes = 44 + len * ch * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * ch * 2, true);
    view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, len * ch * 2, true);
    const data = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        o += 2;
      }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }

  /**
   * Lê window.Motion.sfx rodando o HTML num iframe invisível (o array pode ser
   * calculado pelo script do clipe). Aceita array ou função que devolve array.
   */
  function readCues(html, { timeout = 10000 } = {}) {
    return new Promise(resolve => {
      const iframe = document.createElement('iframe');
      iframe.sandbox = 'allow-scripts allow-same-origin';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:64px;height:64px;border:0;visibility:hidden;pointer-events:none';
      let done = false;
      const finish = cues => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        iframe.remove();
        resolve(normalizeCues(cues));
      };
      const timer = setTimeout(() => finish(read()), timeout);
      const read = () => {
        try {
          const sfx = iframe.contentWindow?.Motion?.sfx;
          return typeof sfx === 'function' ? sfx() : sfx;
        } catch (_) {
          return [];
        }
      };
      iframe.addEventListener('load', async () => {
        try {
          const ready = iframe.contentWindow?.Motion?.whenReady?.();
          await Promise.race([Promise.resolve(ready).catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
        } catch (_) { /* clipe sem whenReady */ }
        finish(read());
      }, { once: true });
      iframe.srcdoc = window.ClipHost ? window.ClipHost.injectRuntime(html) : html;
      document.body.appendChild(iframe);
    });
  }

  window.MotionSFX = { TYPES, normalizeCues, render, toWav, readCues, loadLibrary, addExternal };
  // #endregion
})();
