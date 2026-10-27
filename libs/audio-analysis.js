'use strict';
// audio-analysis.js
//
//  Áudio do projeto quadro a quadro para MS.audio(t) (libs/motion-kit.js):
//  o ffmpeg mistura as faixas em mono 22 kHz, uma FFT por quadro dá 16 bandas
//  em escala log (40 Hz–11 kHz), mais nível, graves/médios/agudos e batidas.
//  Tudo normalizado pela própria faixa (0–1, faixa de 40 dB a partir do pico
//  de 98 %) e suavizado (ataque 30 ms, soltura 150 ms) — visual vivo em
//  música alta ou baixa.
//
//  Saída compacta: 22 bytes por quadro em base64 —
//    [level, pulse, beat, bass, mid, treble, banda0 … banda15]

const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg-bin');

const RATE = 22050;
const WIN = 2048;
const BANDS = 16;
const STRIDE = 6 + BANDS;
const F_MIN = 40;
const F_MAX = 11000;
const RANGE_DB = 40;
const MAX_SECONDS = 3600;

const cache = new Map();
const CACHE_MAX = 12;

const finite = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * sources: [{ src (arquivo ou URL http), start, trimStart, duration, volume }]
 * → Float32Array mono em RATE Hz cobrindo [0, totalDuration)
 */
function decodeMix(sources, totalDuration) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-v', 'error'];
    sources.forEach(s => args.push('-i', s.src));
    const labels = [];
    const filters = sources.map((s, i) => {
      const start = Math.max(0, finite(s.trimStart));
      const dur = Math.max(0.001, finite(s.duration, 1));
      const delay = Math.max(0, Math.round(finite(s.start) * 1000));
      const vol = Math.max(0, Math.min(4, finite(s.volume, 1)));
      labels.push(`[a${i}]`);
      return `[${i}:a:0]atrim=start=${start}:duration=${dur},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)},aresample=${RATE},adelay=${delay}:all=1[a${i}]`;
    });
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=0:${totalDuration.toFixed(3)}[mix]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[mix]', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1');

    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', c => { stderr = (stderr + c).slice(-2000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg (áudio) saiu com ${code}: ${stderr.trim().split('\n').pop() || ''}`));
      const buf = Buffer.concat(chunks);
      const out = new Float32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

// #region FFT (radix-2, real → potência)
const fftPlan = (() => {
  const levels = Math.log2(WIN);
  const rev = new Uint32Array(WIN);
  for (let i = 0; i < WIN; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(WIN / 2), sin = new Float64Array(WIN / 2);
  for (let i = 0; i < WIN / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / WIN);
    sin[i] = Math.sin((2 * Math.PI * i) / WIN);
  }
  const hann = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  return { rev, cos, sin, hann };
})();

function powerSpectrum(re, im, out) {
  const { rev, cos, sin } = fftPlan;
  for (let i = 0; i < WIN; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= WIN; size *= 2) {
    const half = size / 2, step = WIN / size;
    for (let i = 0; i < WIN; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j, b = a + half;
        const tr = re[b] * cos[k] + im[b] * sin[k];
        const ti = -re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let i = 0; i <= WIN / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}
// #endregion

function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/** Amostras mono → bytes por quadro (ver cabeçalho) */
function analyze(samples, fps, totalDuration) {
  const frames = Math.max(1, Math.ceil(totalDuration * fps));
  const edges = Array.from({ length: BANDS + 1 }, (_, k) => F_MIN * Math.pow(F_MAX / F_MIN, k / BANDS));
  const binHz = RATE / WIN;
  const bandBins = edges.slice(0, -1).map((lo, k) => {
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.max(a + 1, Math.floor(edges[k + 1] / binHz));
    return [a, Math.min(WIN / 2, b)];
  });

  const re = new Float64Array(WIN), im = new Float64Array(WIN), pow = new Float64Array(WIN / 2 + 1);
  const bandDb = Array.from({ length: BANDS }, () => new Float64Array(frames));
  const levelDb = new Float64Array(frames);

  for (let f = 0; f < frames; f++) {
    const center = Math.round((f / fps) * RATE);
    let sumSq = 0;
    for (let i = 0; i < WIN; i++) {
      const s = samples[center - WIN / 2 + i] || 0;
      sumSq += s * s;
      re[i] = s * fftPlan.hann[i];
      im[i] = 0;
    }
    levelDb[f] = 10 * Math.log10(sumSq / WIN + 1e-12);
    powerSpectrum(re, im, pow);
    for (let k = 0; k < BANDS; k++) {
      const [a, b] = bandBins[k];
      let e = 0;
      for (let i = a; i < b; i++) e += pow[i];
      bandDb[k][f] = 10 * Math.log10(e / (b - a) + 1e-12);
    }
  }

  // Normalização pela própria faixa. As bandas juntas (uma banda quase muda
  // continua baixa), com +3 dB/oitava: música cai ~3 dB/oitava e sem isso os
  // agudos nunca acendem.
  const scaleFrom = values => {
    const audible = values.filter(v => v > -110);
    const top = audible.length ? percentile(audible, 0.98) : 0;
    return v => Math.max(0, Math.min(1, (v - (top - RANGE_DB)) / RANGE_DB));
  };
  const level = levelDb.map(scaleFrom(Array.from(levelDb)));
  bandDb.forEach((series, k) => {
    const center = Math.sqrt(edges[k] * edges[k + 1]);
    const tilt = 3 * Math.log2(center / 1000);
    for (let f = 0; f < frames; f++) series[f] += tilt;
  });
  const bandScale = scaleFrom(bandDb.flatMap(series => Array.from(series)));
  const bands = bandDb.map(series => series.map(bandScale));

  // Suavização: ataque rápido, soltura lenta
  const attack = 1 - Math.exp(-1 / (fps * 0.03));
  const release = 1 - Math.exp(-1 / (fps * 0.15));
  const smooth = series => {
    let y = 0;
    return series.map(x => (y += (x > y ? attack : release) * (x - y)));
  };

  // Batidas: fluxo espectral nos graves acima da média local
  const flux = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    let v = 0;
    for (let k = 0; k < 5; k++) v += Math.max(0, bands[k][f] - bands[k][f - 1]);
    flux[f] = v;
  }
  const win = Math.max(2, Math.round(fps * 0.5));
  const refractory = Math.max(1, Math.round(fps * 0.12));
  const beat = new Uint8Array(frames);
  let last = -Infinity;
  for (let f = 1; f < frames - 1; f++) {
    let sum = 0, sum2 = 0, n = 0;
    for (let j = Math.max(0, f - win); j <= Math.min(frames - 1, f + win); j++) {
      sum += flux[j]; sum2 += flux[j] * flux[j]; n++;
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const peak = flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1];
    if (peak && flux[f] > Math.max(0.12, mean + 1.4 * std) && f - last >= refractory) {
      beat[f] = 1;
      last = f;
    }
  }
  const decay = Math.exp(-1 / (fps * 0.18));
  let p = 0;
  const pulse = Array.from(beat, b => (p = b ? 1 : p * decay));

  const sLevel = smooth(level);
  const sBands = bands.map(smooth);
  const avg = (from, to, f) => {
    let v = 0;
    for (let k = from; k <= to; k++) v += sBands[k][f];
    return v / (to - from + 1);
  };

  const out = new Uint8Array(frames * STRIDE);
  const byte = v => Math.round(Math.max(0, Math.min(1, v)) * 255);
  for (let f = 0; f < frames; f++) {
    const o = f * STRIDE;
    out[o] = byte(sLevel[f]);
    out[o + 1] = byte(pulse[f]);
    out[o + 2] = beat[f] ? 255 : 0;
    out[o + 3] = byte(avg(0, 3, f));
    out[o + 4] = byte(avg(4, 9, f));
    out[o + 5] = byte(avg(10, 15, f));
    for (let k = 0; k < BANDS; k++) out[o + 6 + k] = byte(sBands[k][f]);
  }
  return { fps, bands: BANDS, stride: STRIDE, frames, duration: totalDuration, data: Buffer.from(out).toString('base64') };
}

/**
 * Áudio do projeto para MS.audio: sources como em decodeMix, fps do projeto.
 * Resultado em cache pelo pedido (mesmas faixas → mesma análise).
 */
async function analyzeProjectAudio(sources, { fps = 30, duration } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(s => s && typeof s.src === 'string' && s.src);
  const total = Math.min(MAX_SECONDS, Math.max(0.1, finite(duration) || Math.max(0, ...list.map(s => finite(s.start) + finite(s.duration)))));
  fps = Math.min(120, Math.max(1, Math.round(finite(fps, 30))));
  if (!list.length) return null;
  const key = crypto.createHash('sha1').update(JSON.stringify({ list, fps, total })).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const pending = decodeMix(list, total).then(samples => analyze(samples, fps, total));
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return pending;
}

module.exports = { analyzeProjectAudio, analyze, BANDS, STRIDE };
