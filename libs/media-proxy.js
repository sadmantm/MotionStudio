'use strict';
// media-proxy.js
//
//  Vídeo que o navegador não toca (HEVC, ProRes, DNxHD, H.264 10 bits ou
//  4:2:2, áudio PCM, MKV/AVI/MTS…) ganha uma cópia H.264 8 bits 4:2:0 na
//  mesma resolução ("proxy"): o preview e o export usam a cópia, o original
//  fica intacto na pasta do projeto. HDR (PQ/HLG — o vídeo do iPhone) passa
//  por tone mapping para SDR, senão sairia lavado.
//
//    probe(file)                  → { needsProxy, reasons[], info }
//    startProxy(key, src, dst)    → transcodifica em segundo plano (uma vez por key)
//    proxyStatus(key)             → { status: 'running'|'done'|'error', progress, error }

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { ffmpegPath, ffprobePath } = require('./ffmpeg-bin');

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const PLAYABLE_PIX = new Set(['yuv420p', 'yuvj420p']);
const RISKY_EXT = /\.(mkv|avi|mts|m2ts|wmv|flv|3gp|mxf|mpg|mpeg|ts|dv)$/i;

const jobs = new Map();   // key → { status, progress, error, promise }

function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath(), [
      '-v', 'error', '-print_format', 'json', '-show_format',
      '-show_entries', 'stream=index,codec_type,codec_name,profile,pix_fmt,width,height,color_transfer,color_primaries,avg_frame_rate,duration',
      file,
    ], { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

async function probe(file) {
  const data = await ffprobeJson(file);
  const streams = data.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !/^(mjpeg|png)$/.test(s.codec_name));
  const a = streams.find(s => s.codec_type === 'audio');
  const reasons = [];
  if (!v) return { needsProxy: false, reasons, info: { audioOnly: true } };
  if (!PLAYABLE_VIDEO.has(v.codec_name)) reasons.push(`vídeo ${String(v.codec_name).toUpperCase()}`);
  else if (v.pix_fmt && !PLAYABLE_PIX.has(v.pix_fmt)) reasons.push(`formato de cor ${v.pix_fmt}`);
  if (a && !PLAYABLE_AUDIO.has(a.codec_name)) reasons.push(`áudio ${String(a.codec_name).toUpperCase()}`);
  if (RISKY_EXT.test(file)) reasons.push(`contêiner ${path.extname(file).slice(1).toUpperCase()}`);
  const hdr = /smpte2084|arib-std-b67/.test(v.color_transfer || '');
  if (hdr) reasons.push('HDR');
  const [num, den] = String(v.avg_frame_rate || '30/1').split('/').map(Number);
  return {
    needsProxy: reasons.length > 0,
    reasons,
    info: {
      codec: v.codec_name, pixFmt: v.pix_fmt, width: v.width, height: v.height, hdr,
      fps: den ? num / den : 30, duration: Number(data.format?.duration) || Number(v.duration) || 0, hasAudio: Boolean(a),
    },
  };
}

/** Filtros: limite 4K (lado maior), HDR → SDR (bt709) e 8 bits 4:2:0 */
function videoFilter({ width, height, hdr }) {
  const chain = [];
  if (Math.max(width || 0, height || 0) > 3840) chain.push(width >= height ? 'scale=3840:-2' : 'scale=-2:3840');
  if (hdr) {
    chain.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
  }
  chain.push('format=yuv420p');
  return chain.join(',');
}

function transcode(src, dst, info, onProgress) {
  return new Promise((resolve, reject) => {
    const fps = Math.max(1, Math.round(info.fps || 30));
    const tmp = `${dst}.part.mp4`;
    const args = [
      '-hide_banner', '-nostdin', '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', videoFilter(info),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-profile:v', 'high',
      // Keyframe a cada segundo: o scrub na timeline busca rápido
      '-g', String(fps), '-keyint_min', String(fps),
      '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      tmp,
    ];
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    proc.stdout.on('data', chunk => {
      const m = /out_time_us=(\d+)/g;
      let match, last = null;
      while ((match = m.exec(String(chunk)))) last = match;
      if (last && info.duration > 0) onProgress(Math.min(0.99, Number(last[1]) / 1e6 / info.duration));
    });
    proc.stderr.on('data', c => { stderr = (stderr + c).slice(-3000); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) {
        fs.rm(tmp, { force: true }, () => {});
        return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg saiu com ${code}`));
      }
      fs.rename(tmp, dst, err => (err ? reject(err) : resolve()));
    });
  });
}

/** Começa (ou reaproveita) o proxy de `src` em `dst` */
function startProxy(key, src, dst, info) {
  const current = jobs.get(key);
  if (current && current.status !== 'error') return current;
  if (fs.existsSync(dst)) {
    const done = { status: 'done', progress: 1 };
    jobs.set(key, done);
    return done;
  }
  const job = { status: 'running', progress: 0, error: null };
  job.promise = transcode(src, dst, info, p => { job.progress = p; })
    .then(() => { job.status = 'done'; job.progress = 1; })
    .catch(err => {
      job.status = 'error';
      job.error = err.message;
      console.warn(`[Proxy] ${path.basename(src)}: ${err.message}`);
    });
  jobs.set(key, job);
  return job;
}

function proxyStatus(key) {
  const job = jobs.get(key);
  return job ? { status: job.status, progress: job.progress, error: job.error } : null;
}

/** Nome do proxy ao lado do original: clipe.mov → clipe.proxy.mp4 */
const proxyName = file => `${file.replace(/\.[^.]+$/, '')}.proxy.mp4`;

module.exports = { probe, startProxy, proxyStatus, proxyName };
