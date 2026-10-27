'use strict';
// matting.js
//
//  "Remover fundo" de um vídeo ou imagem do projeto (libs/matting.py, RVM):
//
//    POST /api/projects/:id/media/:file/matte   → { jobId }
//    GET  /api/matte/:jobId                     → { status, stage, progress, url, file, error }
//    POST /api/matte/:jobId/cancel
//
//  Roda no computador do usuário com o Python do ambiente do Whisper
//  (onnxruntime + numpy). O modelo (RVM MobileNetV3, ~15 MB, GPL-3.0) é
//  baixado no primeiro uso para a pasta de modelos. Saída na pasta de mídia
//  do projeto: vídeo → <nome>.nobg.mp4 (cor | alpha lado a lado, ver
//  Interface/media-fx.js); imagem → <nome>.nobg.png (com transparência).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { ffmpegPath } = require('./ffmpeg-bin');
const MediaProxy = require('./media-proxy');

const MODEL_URL = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx';
const MODEL_MIN_BYTES = 10 * 1024 * 1024;
const SCRIPT = path.join(__dirname, 'matting.py');
const MAX_SIDE = 1920;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|avif|bmp|tiff?|heic)$/i;

const jobs = new Map();

function runQuiet(cmd, args, timeout = 600000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
  });
}

async function ensureModel(modelsDir, job) {
  const file = path.join(modelsDir, 'rvm', 'rvm_mobilenetv3_fp32.onnx');
  if (fs.existsSync(file) && fs.statSync(file).size > MODEL_MIN_BYTES) return file;
  job.stage = 'Baixando o modelo de recorte (1ª vez, ~15 MB)…';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const res = await fetch(MODEL_URL, { headers: { 'user-agent': 'motion-studio' }, signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`download do modelo falhou (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const tmp = `${file}.part`;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      got += chunk.length;
      if (total) job.progress = 0.1 * Math.min(0.99, got / total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  if (fs.statSync(tmp).size < MODEL_MIN_BYTES) throw new Error('modelo baixado incompleto');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Python com onnxruntime: o do ambiente do app (pode instalar o que faltar)
 * ou o que o Whisper usa (só se já tiver os pacotes — nada é instalado num
 * Python do sistema).
 */
async function ensurePython(python, job) {
  const { path: py, managed } = python() || {};
  if (!py) throw new Error('Ambiente Python não encontrado. Abra a transcrição (Whisper) uma vez para o app instalar o Python e tente de novo.');
  const check = await runQuiet(py, ['-c', 'import onnxruntime, numpy'], 60000);
  if (check.ok) return py;
  if (!managed) throw new Error('O Python em uso não tem onnxruntime. Instale com: python -m pip install onnxruntime numpy');
  job.stage = 'Instalando o onnxruntime no ambiente Python…';
  const pip = await runQuiet(py, ['-m', 'pip', 'install', '--disable-pip-version-check', 'onnxruntime', 'numpy']);
  if (!pip.ok) throw new Error(`não foi possível instalar o onnxruntime: ${pip.out.trim().split('\n').pop()}`);
  return py;
}

/** Dimensões de trabalho: até 1920 no lado maior, pares (H.264) */
function workSize(w, h) {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const even = v => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(w), height: even(h) };
}

async function runJob(job, { python, modelsDir }) {
  const model = await ensureModel(modelsDir, job);
  const py = await ensurePython(python, job);
  job.stage = job.image ? 'Recortando a imagem…' : 'Recortando o vídeo quadro a quadro…';
  const info = job.image ? null : (await MediaProxy.probe(job.src)).info;
  const dims = job.image ? await imageSize(job.src) : { w: info.width, h: info.height };
  if (!dims.w || !dims.h) throw new Error('não foi possível ler as dimensões da mídia');
  const { width, height } = workSize(dims.w, dims.h);
  const fps = info?.fps && isFinite(info.fps) ? Math.min(120, info.fps) : 30;
  const frames = job.image ? 1 : Math.max(1, Math.round((info.duration || 0) * fps));
  const tmp = `${job.dst}.part${path.extname(job.dst)}`;
  const args = [SCRIPT, '--ffmpeg', ffmpegPath(), '--model', model, '--input', job.src, '--output', tmp,
    '--width', String(width), '--height', String(height), '--fps', String(fps), '--frames', String(frames)];
  if (job.image) args.push('--image');
  else if (info.hasAudio) args.push('--audio');

  await new Promise((resolve, reject) => {
    const proc = spawn(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    job.proc = proc;
    let error = null, stderr = '', buf = '';
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.progress != null) job.progress = 0.1 + 0.9 * msg.progress;
          if (msg.error) error = msg.error;
        } catch (_) { /* linha de log */ }
      }
    });
    proc.stderr.on('data', c => { stderr = (stderr + c).slice(-3000); });
    proc.on('error', reject);
    proc.on('close', code => {
      job.proc = null;
      if (job.canceled) return reject(new Error('cancelado'));
      if (code !== 0 || error) return reject(new Error(error || stderr.trim().split('\n').pop() || `python saiu com ${code}`));
      resolve();
    });
  });
  fs.renameSync(tmp, job.dst);
  job.res = { w: width, h: height };
}

function imageSize(file) {
  return new Promise(resolve => {
    execFile(require('./ffmpeg-bin').ffprobePath(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
      { windowsHide: true, timeout: 20000 }, (err, out) => {
        const [w, h] = String(out || '').trim().split(',').map(Number);
        resolve({ w: w || 0, h: h || 0 });
      });
  });
}

function register(app, { projects, python, modelsDir }) {
  app.post('/api/projects/:id/media/:file/matte', (req, res) => {
    const { id, file } = req.params;
    const src = projects.mediaPath(id, file);
    if (!src) return res.status(404).json({ error: 'Mídia não encontrada no projeto.' });
    const image = IMAGE_EXT_RE.test(file);
    const key = `${id}/${file}`;
    const running = [...jobs.values()].find(j => j.key === key && j.status === 'running');
    if (running) return res.json({ jobId: running.id });

    const outName = projects.freeMediaName(id, `${file.replace(/\.[^.]+$/, '')}.nobg.${image ? 'png' : 'mp4'}`);
    const job = {
      id: crypto.randomBytes(6).toString('hex'), key, image, src,
      dst: path.join(path.dirname(src), outName), file: outName,
      url: projects.mediaUrl(id, outName),
      status: 'running', stage: 'Preparando…', progress: 0, error: null, proc: null, canceled: false,
    };
    jobs.set(job.id, job);
    runJob(job, { python, modelsDir })
      .then(() => { job.status = 'done'; job.progress = 1; job.stage = 'Pronto'; })
      .catch(err => {
        job.status = job.canceled ? 'canceled' : 'error';
        job.error = err.message;
        fs.rm(`${job.dst}.part${path.extname(job.dst)}`, { force: true }, () => {});
        if (!job.canceled) console.warn(`[Recorte] ${file}: ${err.message}`);
      });
    res.json({ jobId: job.id });
  });

  app.get('/api/matte/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Tarefa não encontrada.' });
    res.json({
      status: job.status, stage: job.stage, progress: job.progress, error: job.error,
      url: job.status === 'done' ? job.url : null, file: job.file, image: job.image, res: job.res || null,
    });
  });

  app.post('/api/matte/:jobId/cancel', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job && job.status === 'running') {
      job.canceled = true;
      try { job.proc?.kill(); } catch (_) { /* já saiu */ }
    }
    res.json({ ok: true });
  });
}

module.exports = { register, workSize };
