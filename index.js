'use strict';

// #region Dependências
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { renderJob, getJob, createJob, downloadJob, cleanupJob, setProjectRoot, registerExportMediaRoutes } = require('./exporter');
setProjectRoot(__dirname);

// #endregion

// #region Configuração
const app  = express();
const PORT = process.env.PORT || 3001;
// #endregion

// #region Whisper Process Manager
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const WHISPER_PORT    = Number(process.env.WHISPER_PORT) || 9099;
const WHISPER_SCRIPT  = path.join(__dirname, 'libs', 'whisper.py');

// Códigos de saída do whisper.py
const EXIT_DEPS_MISSING = 3;
const EXIT_LOAD_FAILED  = 4;
const MAX_RESTARTS      = 3;

// Ambiente Python próprio do app, um por plataforma (a pasta pode ser compartilhada entre Windows e Mac).
// WHISPER_ENV_DIR: o app empacotado guarda o ambiente na pasta de dados do usuário.
const PY_ENV_DIR   = path.join(process.env.WHISPER_ENV_DIR || path.join(__dirname, '.whisper-env'), `${process.platform}-${process.arch}`);
const PY_ENV_BIN   = process.platform === 'win32'
  ? path.join(PY_ENV_DIR, 'Scripts', 'python.exe')
  : path.join(PY_ENV_DIR, 'bin', 'python3');
const REQUIREMENTS = path.join(__dirname, 'libs', 'requirements-whisper.txt');

/**
 * Estado do Whisper:
 *   idle       → ainda não iniciado
 *   installing → criando o ambiente Python e instalando dependências (1ª vez)
 *   starting   → processo vivo, baixando/carregando modelo (ver `progress`)
 *   ready    → aceitando transcrições
 *   failed   → desistiu; `error` explica o motivo
 */
const whisper = {
  process:   null,
  state:     'idle',
  error:     null,
  info:      {},        // { device, model, compute }
  restarts:  0,
  forceCpu:  process.env.WHISPER_DEVICE === 'cpu',
  pythons:   null,      // candidatos restantes
  python:    null,      // Python em uso
  stopping:  false,
  stderrTail: [],
  depsError: null,     // último erro de import (preservado entre candidatos)
  progress:  null,     // { stage, model, done, total, language }
  install:   null,     // { step, line }
  bootstrapTried: false,
};

/**
 * Ordem: WHISPER_PYTHON → ambiente do app (.whisper-env) → venv/ → .venv/ → Python do sistema.
 * Se nenhum tiver faster-whisper, o ambiente do app é criado automaticamente.
 */
function pythonCandidates() {
  const win  = process.platform === 'win32';
  const list = [];
  if (process.env.WHISPER_PYTHON) list.push(process.env.WHISPER_PYTHON);
  if (fs.existsSync(PY_ENV_BIN)) list.push(PY_ENV_BIN);
  for (const dir of ['venv', '.venv']) {
    const bin = win
      ? path.join(__dirname, dir, 'Scripts', 'python.exe')
      : path.join(__dirname, dir, 'bin', 'python3');
    if (fs.existsSync(bin)) list.push(bin);
  }
  list.push(...(win ? ['python', 'py'] : ['python3', 'python']));
  return [...new Set(list)];
}

function whisperFail(message) {
  whisper.state = 'failed';
  whisper.error = message;
  console.error(`[Whisper] ❌ ${message}`);
}

function startWhisper() {
  if (whisper.process) return;

  if (!whisper.pythons) whisper.pythons = pythonCandidates();
  if (!whisper.python)  whisper.python  = whisper.pythons.shift();
  if (!whisper.python) {
    return whisperFail('Nenhum Python encontrado. Defina WHISPER_PYTHON.');
  }

  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', WHISPER_PORT: String(WHISPER_PORT) };
  if (whisper.forceCpu) env.WHISPER_DEVICE = 'cpu';

  console.log(`[Whisper] Iniciando com ${whisper.python}${whisper.forceCpu ? ' (forçado CPU)' : ''}…`);
  whisper.state      = 'starting';
  whisper.error      = null;
  whisper.stderrTail = [];
  whisper.info       = {};
  whisper.progress   = null;

  const proc = spawn(whisper.python, [WHISPER_SCRIPT], {
    windowsHide: true,
    cwd:   path.dirname(WHISPER_SCRIPT),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });
  whisper.process = proc;

  // Linha a linha: chunks podem cortar ou juntar linhas
  let sawStdout = false;
  readline.createInterface({ input: proc.stdout }).on('line', line => {
    sawStdout = true;
    const ctl = line.match(/^@@(\w+) (.*)$/);
    if (!ctl) return console.log(line.startsWith('[') ? line : `[Whisper] ${line}`);

    let payload = {};
    try { payload = JSON.parse(ctl[2]); } catch {}

    if (ctl[1] === 'DEVICE') {
      whisper.info = payload;
    } else if (ctl[1] === 'STAGE') {
      whisper.progress = { ...whisper.progress, ...payload };
    } else if (ctl[1] === 'DOWNLOAD') {
      const prev = whisper.progress?.total ? Math.floor(100 * whisper.progress.done / whisper.progress.total / 10) : -1;
      whisper.progress = { ...whisper.progress, stage: 'downloading', ...payload };
      const pct = payload.total ? Math.min(100, Math.floor(100 * payload.done / payload.total)) : null;
      if (pct != null && Math.floor(pct / 10) !== prev) {
        console.log(`[Whisper] ⬇ Baixando ${payload.model}: ${pct}% (${(payload.done / 1e6).toFixed(0)}/${(payload.total / 1e6).toFixed(0)} MB)`);
      }
    } else if (ctl[1] === 'READY') {
      whisper.info     = payload;
      whisper.state    = 'ready';
      whisper.restarts = 0;
      whisper.progress = null;
      console.log(`[Whisper] ✅ Pronto — ${payload.model} em ${payload.device} (${payload.compute})`);
    } else if (ctl[1] === 'FATAL') {
      whisper.error = payload.error || 'erro desconhecido';
      if (payload.code === 'deps_missing') whisper.depsError = `${payload.python}: ${payload.error}`;
    }
  });

  readline.createInterface({ input: proc.stderr }).on('line', line => {
    whisper.stderrTail.push(line);
    if (whisper.stderrTail.length > 15) whisper.stderrTail.shift();
    console.error(`[Whisper ERR] ${line}`);
  });

  let handled = false;
  const onDeath = (code, signal, spawnErr) => {
    if (handled) return;
    handled = true;
    const lastError = whisper.error;
    const wasState  = whisper.state;
    whisper.process = null;
    console.warn(`[Whisper] Processo encerrado (code=${code}, signal=${signal}${spawnErr ? `, ${spawnErr.code}` : ''})`);

    if (whisper.stopping) { whisper.state = 'idle'; return; }

    // Python inexistente (ENOENT / alias da Microsoft Store = 9009), venv quebrado
    // (morreu sem imprimir nada, ex.: venv criado em outro PC) ou sem whisperx → próximo candidato
    if (spawnErr || code === EXIT_DEPS_MISSING || code === 9009 || (!sawStdout && wasState === 'starting')) {
      const tried = whisper.python;
      whisper.python = null;
      if (whisper.pythons.length) {
        console.warn(`[Whisper] ${tried} indisponível ou sem dependências — tentando próximo Python…`);
        return startWhisper();
      }
      // Nenhum Python serve → cria o ambiente do app e instala as dependências (só na 1ª vez)
      if (!whisper.bootstrapTried && process.env.WHISPER_AUTO_INSTALL !== '0') {
        whisper.bootstrapTried = true;
        return bootstrapPythonEnv()
          .then(() => {
            whisper.pythons = [PY_ENV_BIN];
            whisper.python  = null;
            startWhisper();
          })
          .catch(err => whisperFail(`Instalação automática falhou: ${err.message}`));
      }
      return whisperFail(
        `Dependências do Whisper ausentes (${whisper.depsError || lastError || 'Python não encontrado'}). ` +
        `Rode: <python> -m pip install -r libs/requirements-whisper.txt`
      );
    }

    // Crash nativo com GPU (cuDNN ausente, VRAM esgotada…) → reinicia em CPU
    if (whisper.info.device === 'cuda' && !whisper.forceCpu) {
      console.warn('[Whisper] Falha usando a GPU — reiniciando em modo CPU.');
      whisper.forceCpu = true;
      whisper.restarts = 0;
      return startWhisper();
    }

    if (code === EXIT_LOAD_FAILED || ++whisper.restarts > MAX_RESTARTS) {
      const tail = whisper.stderrTail.slice(-3).join(' | ');
      return whisperFail(`Whisper não conseguiu iniciar: ${lastError || tail || `code ${code}`}`);
    }

    // Caiu depois de pronto (ex.: falta de RAM) ou durante o load → tenta de novo
    console.log(`[Whisper] Reiniciando (${whisper.restarts}/${MAX_RESTARTS})… estado anterior: ${wasState}`);
    whisper.state = 'starting';
    setTimeout(startWhisper, 2000 * whisper.restarts);
  };

  proc.on('error', err => onDeath(null, null, err));
  proc.on('exit',  (code, signal) => onDeath(code, signal, null));
}

/** Executa um comando mostrando a saída no terminal; rejeita com o fim do log se falhar */
function runLogged(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const proc = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const onLine = line => {
      if (!line.trim()) return;
      tail.push(line); if (tail.length > 8) tail.shift();
      whisper.install = { ...whisper.install, line: line.slice(0, 160) };
      console.log(`[Whisper setup] ${line}`);
    };
    readline.createInterface({ input: proc.stdout }).on('line', onLine);
    readline.createInterface({ input: proc.stderr }).on('line', onLine);
    proc.on('error', reject);
    proc.on('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${label} (code ${code}): ${tail.slice(-3).join(' | ')}`)));
  });
}

function execQuiet(cmd, args, timeout = 20_000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

/** Acha um Python 3.9–3.13 do sistema para criar o ambiente do app */
async function findBasePython() {
  const cands = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['/opt/homebrew/bin/python3', []], ['/usr/local/bin/python3', []], ['/usr/bin/python3', []], ['python', []]];
  // App empacotado traz um Python próprio: funciona sem nada instalado no sistema
  if (process.env.WHISPER_BASE_PYTHON) cands.unshift([process.env.WHISPER_BASE_PYTHON, []]);

  for (const [cmd, pre] of cands) {
    const out = await execQuiet(cmd, [...pre, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])']);
    const [maj, min] = (out || '').split('.').map(Number);
    if (maj === 3 && min >= 9 && min <= 13) return { cmd, pre, version: out };
  }
  return null;
}

/**
 * 1ª execução numa máquina sem Python pronto: cria .whisper-env/<plataforma>
 * e instala faster-whisper (sem torch — funciona em Mac Intel, Apple Silicon e Windows).
 * Em Windows com NVIDIA instala também cuBLAS/cuDNN para usar a GPU.
 */
async function bootstrapPythonEnv() {
  whisper.state   = 'installing';
  whisper.error   = null;
  whisper.install = { step: 'Procurando Python no sistema…' };

  const base = await findBasePython();
  if (!base) {
    throw new Error(process.platform === 'darwin'
      ? 'Python 3 não encontrado. Instale pelo python.org ou rode "xcode-select --install".'
      : 'Python 3.10+ não encontrado. Instale pelo python.org marcando "Add Python to PATH".');
  }
  console.log(`[Whisper setup] Criando ambiente com Python ${base.version} (${base.cmd}) em ${PY_ENV_DIR}`);

  whisper.install = { step: 'Criando ambiente Python…' };
  fs.rmSync(PY_ENV_DIR, { recursive: true, force: true });
  await runLogged(base.cmd, [...base.pre, '-m', 'venv', PY_ENV_DIR], 'Falha ao criar venv');

  whisper.install = { step: 'Atualizando pip…' };
  await runLogged(PY_ENV_BIN, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Falha ao atualizar pip');

  const extra = [];
  if (process.platform === 'win32' && await execQuiet('nvidia-smi', ['-L'])) {
    extra.push('nvidia-cublas-cu12', 'nvidia-cudnn-cu12==9.*');
    console.log('[Whisper setup] GPU NVIDIA detectada — instalando cuBLAS/cuDNN');
  }

  whisper.install = { step: 'Instalando faster-whisper (1ª vez, alguns minutos)…' };
  await runLogged(PY_ENV_BIN, ['-m', 'pip', 'install', '-r', REQUIREMENTS, ...extra], 'Falha no pip install');

  whisper.install = null;
  console.log('[Whisper setup] ✅ Ambiente Python pronto.');
}

// Garante que o processo filho é encerrado junto com o servidor
['exit', 'SIGINT', 'SIGTERM'].forEach(evt =>
  process.on(evt, () => {
    if (whisper.process) {
      whisper.stopping = true;
      console.log('[Whisper] Encerrando processo filho…');
      whisper.process.kill('SIGTERM');
    }
  })
);
process.on('unhandledRejection', reason => {
  console.error('[Servidor] unhandledRejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('[Servidor] uncaughtException:', err.message);
});
// #endregion

// #region Middlewares
app.use(cors());
registerExportMediaRoutes(app);
app.use(express.json({ limit: '900mb' }));
require('./libs/ai-server').register(app, { root: __dirname });
require('./libs/sfx-library').register(app);

// #region Preview isolado
// O editor carrega cada clipe HTML de outro "site" (127.0.0.1 ↔ localhost):
// o Chrome o roda em outro processo, e um template pesado não trava a interface.
// Conteúdo endereçado por hash (sha1) — o mesmo HTML não é reenviado.
const crypto = require('crypto');
const htmlThumbs = require('./libs/html-thumbs');
const previewClips = new Map();          // hash → html (LRU simples)
const PREVIEW_CLIPS_MAX = 300;

app.post('/api/preview/clip', (req, res) => {
  const html = typeof req.body?.html === 'string' ? req.body.html : '';
  if (!html) return res.status(400).json({ error: 'html vazio' });
  const id = crypto.createHash('sha1').update(html).digest('hex');
  previewClips.delete(id);
  previewClips.set(id, html);
  if (previewClips.size > PREVIEW_CLIPS_MAX) previewClips.delete(previewClips.keys().next().value);
  res.json({ id });
});

app.get('/preview/clip/:id', (req, res) => {
  const html = previewClips.get(req.params.id);
  if (!html) return res.status(404).send('clip não encontrado');
  // URLs relativas (assets/logo.png) continuam resolvendo na raiz do projeto
  const withBase = /<base\s/i.test(html)
    ? html
    : html.replace(/<head([^>]*)>/i, '<head$1><base href="/">') || html;
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('html').send(withBase);
});

// #region App desktop (Firefox)
// Cada janela do editor mantém um EventSource aberto aqui. O launcher
// (desktop/launcher.js) ouve 'motion-studio:presence' e encerra o app quando
// a última janela fecha — no macOS o Firefox continua aberto sem janelas.
const desktopMode = process.env.MS_DESKTOP === '1';
let desktopClients = 0;

app.get('/desktop.js', (req, res) => {
  res.type('application/javascript').setHeader('Cache-Control', 'no-store');
  if (!desktopMode) return res.send('');
  res.send(`(function () {
  function connect() {
    var es = new EventSource('/api/desktop/presence');
    es.onerror = function () { es.close(); setTimeout(connect, 1000); };
  }
  connect();
})();`);
});

app.get('/api/desktop/presence', (req, res) => {
  if (!desktopMode) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': ok\n\n');
  desktopClients++;
  process.emit('motion-studio:presence', desktopClients);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    desktopClients--;
    process.emit('motion-studio:presence', desktopClients);
  });
});
// #endregion

/**
 * POST /api/thumbs/html  { html, w, h, times: [s…], height }
 * → { frames: [{ t, url }] }  quadros WebP do clipe para a filmstrip da timeline
 */
app.post('/api/thumbs/html', async (req, res) => {
  const body   = req.body || {};
  const html   = typeof body.html === 'string' ? body.html : '';
  const times  = (Array.isArray(body.times) ? body.times : [])
    .map(Number).filter(t => Number.isFinite(t) && t >= 0).slice(0, 40);
  if (!html || !times.length) return res.status(400).json({ error: 'html e times são obrigatórios' });

  const w      = Math.min(7680, Math.max(16, Math.round(Number(body.w) || 1080)));
  const h      = Math.min(7680, Math.max(16, Math.round(Number(body.h) || 1920)));
  const height = Math.min(240, Math.max(24, Math.round(Number(body.height) || 90)));

  // Mesma rota do preview isolado: <base href="/"> resolve os assets do projeto
  const id = crypto.createHash('sha1').update(html).digest('hex');
  previewClips.delete(id);
  previewClips.set(id, html);
  if (previewClips.size > PREVIEW_CLIPS_MAX) previewClips.delete(previewClips.keys().next().value);

  try {
    const frames = await htmlThumbs.render({
      key: id, w, h, times, height,
      url: `http://127.0.0.1:${PORT}/preview/clip/${id}`,
    });
    res.json({ frames });
  } catch (err) {
    console.warn('[Thumbs] falha:', err?.message || err);
    res.status(500).json({ error: err?.message || 'falha ao gerar miniaturas' });
  }
});
// #endregion
// Fallback: se um arquivo não existe na raiz, tenta em /assets/
// Útil para templates que referenciam <img src="logo.png"> sem prefixo.
app.use((req, res, next) => {
  // Só GETs de arquivos (com extensão)
  if (req.method !== 'GET' || !path.extname(req.path)) return next();

  const rootFile  = path.join(__dirname, req.path);
  if (fs.existsSync(rootFile)) return next();   // existe na raiz, segue fluxo normal

  const assetFile = path.join(__dirname, 'assets', path.basename(req.path));
  if (fs.existsSync(assetFile)) {
    return res.sendFile(assetFile);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'Interface')));

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Interface', 'index.html'));
});

app.use(express.static(path.join(__dirname)));
// #endregion

// #region Rotas — Health
app.get('/api/health', (_, res) => res.json({ ok: true, cpus: os.cpus().length }));
// #endregion

// #region Rotas — Validação de Template
app.post('/api/motion/validate', (req, res) => {
  const { html } = req.body || {};
  if (!html) return res.status(400).json({ valid: false, issues: ['HTML não fornecido'] });

  const issues = [];
  if (!html.includes('window.Motion'))      issues.push('window.Motion não encontrado');
  if (!html.includes('Motion.config'))      issues.push('Motion.config ausente');
  if (!html.includes('renderFrame'))        issues.push('renderFrame ausente');
  if (!html.includes('seek'))              issues.push('seek ausente');
  if (!html.includes('whenReady'))         issues.push('whenReady ausente');
  if (!html.includes('durationInSeconds')) issues.push('durationInSeconds ausente em config');
  if (!html.includes('fps'))              issues.push('fps ausente em config');
  if (!html.includes('totalFrames'))       issues.push('totalFrames ausente em config');

  res.json({ valid: issues.length === 0, issues });
});
// #endregion

// #region Rotas — Export
/**
 * POST /api/export/start
 * Body: { scenes, fps, format, width, height, workersPerScene }
 */
app.post('/api/export/start', async (req, res) => {
  const { clips, fps, format, width, height, projectRes, workersPerScene } = req.body || {};

  if (!Array.isArray(clips) || clips.length === 0)
    return res.status(400).json({ error: 'clips[] é obrigatório e não pode estar vazio' });

  const safeFps    = Number.isFinite(+fps)    && +fps    > 0 ? Math.min(+fps, 120)     : 30;
  const safeW      = Number.isFinite(+width)  && +width  > 0 ? Math.min(+width, 7680)  : 1920;
  const safeH      = Number.isFinite(+height) && +height > 0 ? Math.min(+height, 7680) : 1080;
  const safeFormat = format === 'webm' ? 'webm' : 'mp4';
  const safeRes    = (projectRes && +projectRes.w > 0 && +projectRes.h > 0)
    ? { w: +projectRes.w, h: +projectRes.h }
    : { w: safeW, h: safeH };

  const jobId = createJob({ fps: safeFps, format: safeFormat, width: safeW, height: safeH });
  res.json({ jobId });

  setImmediate(() =>
    renderJob(jobId, clips, {
      fps: safeFps, format: safeFormat,
      width: safeW, height: safeH,
      projectRes: safeRes,
      workersPerScene,
    }).catch(err => console.error(`[Job ${jobId}] Falha fatal:`, err.message))
  );
});

app.get('/api/export/status/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json({ status: job.status, progress: job.progress, message: job.message, error: job.error });
});

app.get('/api/export/download/:id', (req, res) => {
  const jobId  = req.params.id;
  const result = downloadJob(jobId);
  if (!result) return res.status(404).json({ error: 'Arquivo não disponível' });

  const { outputPath, format } = result;
  const mime = format === 'mp4' ? 'video/mp4' : 'video/webm';

  let stat;
  try { stat = fs.statSync(outputPath); }
  catch { return res.status(404).json({ error: 'Arquivo de saída não existe mais' }); }

  res.setHeader('Content-Disposition', `attachment; filename="motion-export.${format}"`);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', stat.size);   // permite barra de progresso no browser

  const stream = fs.createReadStream(outputPath);
  stream.on('error', err => {
    console.error(`[Download ${jobId}] Erro no stream:`, err.message);
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
  });
  stream.pipe(res);

  // 'close' dispara tanto em download completo quanto abortado pelo cliente.
  // Os 5s de margem cobrem flush de buffers do SO antes do rmSync.
  res.on('close', () => setTimeout(() => cleanupJob(jobId), 5000));
});
// #endregion

// #region Rotas — Whisper / Transcrição
const http = require('http');

/** Faz proxy de uma requisição JSON para o servidor Whisper em Python */
function proxyToWhisper(endpoint, bodyObj) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify(bodyObj);
    const opts   = {
      hostname: '127.0.0.1',
      port:     WHISPER_PORT,
      path:     endpoint,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };

    const req = http.request(opts, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: { error: 'Resposta inválida do Whisper' } }); }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getFfmpegPath() {
  try {
    const p = process.env.FFMPEG_PATH || require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

// Silêncio adicionado antes/depois da fala — estabiliza o VAD em clips curtos.
// O Python desconta esse offset dos timestamps.
const AUDIO_PADDING = 0.5;

/**
 * Extrai só o trecho usado do clip como WAV 16kHz mono normalizado.
 * Antes isso era feito no Python com o ffmpeg do PATH — que não existe na
 * maioria das máquinas Windows e quebrava a transcrição com erro genérico.
 */
function extractAudio(inputPath, outputPath, { start = 0, duration = 0 } = {}) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  // -ss/-t como opções de ENTRADA: limitam o trecho lido, não a saída (que inclui o padding)
  if (start > 0) args.push('-ss', start.toFixed(3));
  if (duration > 0) args.push('-t', duration.toFixed(3));
  args.push('-i', inputPath);
  args.push(
    '-vn',
    '-af', `adelay=${AUDIO_PADDING * 1000}:all=1,dynaudnorm=f=300:g=15,apad=pad_dur=${AUDIO_PADDING}`,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav',
    outputPath,
  );

  return new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve();
      if (/does not contain any stream|matches no streams|Output file is empty/i.test(stderr)) {
        return reject(new Error('Este vídeo não tem faixa de áudio.'));
      }
      const last = String(stderr).trim().split('\n').slice(-2).join(' ');
      reject(new Error(`Falha ao extrair áudio: ${last || err.message}`));
    });
  });
}

/** Grava o corpo binário da requisição direto no disco (sem base64 / sem RAM extra) */
function saveUpload(req, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Upload cancelado')));
  });
}

function startingMessage() {
  const p  = whisper.progress || {};
  const hw = whisper.info.device === 'cuda' ? 'GPU' : 'CPU';
  if (p.stage === 'downloading') {
    if (!p.total) return `Baixando modelo ${p.model} (1ª vez)…`;
    const pct = Math.min(99, Math.floor(100 * (p.done || 0) / p.total));
    return `Baixando modelo ${p.model} (1ª vez): ${pct}% — ${((p.done || 0) / 1e6).toFixed(0)}/${(p.total / 1e6).toFixed(0)} MB`;
  }
  if (p.stage === 'aligner') return `Preparando alinhador de palavras (${p.language})…`;
  if (p.stage === 'loading' || p.stage === 'model_cached') return `Carregando ${p.model || whisper.info.model} (${hw})…`;
  return whisper.info.model ? `Verificando modelo ${whisper.info.model}…` : 'Iniciando Whisper…';
}

function whisperStatus() {
  const p = whisper.progress;
  return {
    state:    whisper.state,
    ready:    whisper.state === 'ready',
    error:    whisper.error,
    device:   whisper.info.device || null,
    model:    whisper.info.model || null,
    compute:  whisper.info.compute || null,
    progress: p?.stage === 'downloading' && p.total
      ? { done: p.done || 0, total: p.total, percent: Math.min(99, Math.floor(100 * (p.done || 0) / p.total)) }
      : null,
    message: {
      idle:       'Whisper ainda não iniciado.',
      installing: `${whisper.install?.step || 'Instalando dependências…'}`,
      starting:   startingMessage(),
      ready:      'Whisper pronto.',
      failed:     whisper.error,
    }[whisper.state],
  };
}

/**
 * GET /api/whisper/status[?retry=1]
 * O Whisper já sobe junto com o servidor; isto só reporta (e reinicia se falhou e retry=1).
 */
app.get('/api/whisper/status', (req, res) => {
  if (whisper.state === 'failed' && req.query.retry) {
    whisper.restarts = 0;
    whisper.pythons  = null;
    whisper.python   = null;
    whisper.bootstrapTried = false;
    whisper.state    = 'idle';
  }
  if (whisper.state === 'idle') startWhisper();
  res.json(whisperStatus());
});

// Compatibilidade com a checagem antiga
app.get('/api/whisper/health', (_req, res) => {
  const s = whisperStatus();
  res.status(s.ready ? 200 : 503).json({ ok: s.ready, ...s });
});

/**
 * POST /api/transcribe?clipId=&lang=&ext=&start=&duration=&maxWords=
 * Body: arquivo de mídia bruto (application/octet-stream)
 *
 * Os timestamps retornados são relativos a `start` (início do trecho usado do clip).
 */
/**
 * POST /api/audio/extract?ext=mp4   Body: arquivo de vídeo bruto
 * → arquivo de áudio (audio/mp4) com a 1ª faixa de áudio do vídeo.
 * Copia sem recodificar quando o codec cabe em MP4 (rápido, sem perda); senão AAC.
 */
app.post('/api/audio/extract', async (req, res) => {
  const ext = String(req.query.ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const input  = path.join(os.tmpdir(), `ms_ax_${tag}.${ext}`);
  const output = path.join(os.tmpdir(), `ms_ax_${tag}.m4a`);
  const cleanup = () => { fs.rm(input, { force: true }, () => {}); fs.rm(output, { force: true }, () => {}); };

  const ffmpeg = args => new Promise(resolve => {
    execFile(getFfmpegPath(), ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-map', '0:a:0', ...args, output],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr || '') }));
  });

  try {
    await saveUpload(req, input);
    if (!fs.statSync(input).size) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });

    let run = await ffmpeg(['-c:a', 'copy', '-movflags', '+faststart']);
    if (!run.ok && !/matches no streams|does not contain any stream/i.test(run.stderr)) {
      run = await ffmpeg(['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']);
    }
    if (!run.ok) {
      const noAudio = /matches no streams|does not contain any stream/i.test(run.stderr);
      throw Object.assign(new Error(noAudio ? 'Este vídeo não tem faixa de áudio.' : 'O ffmpeg não conseguiu extrair o áudio.'), { status: noAudio ? 422 : 500 });
    }
    res.type('audio/mp4');
    res.sendFile(output, cleanup);
  } catch (err) {
    cleanup();
    console.error('[Audio] Extração falhou:', err.message);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  if (whisper.state !== 'ready') {
    if (whisper.state === 'idle') startWhisper();
    return res.status(503).json({ error: whisperStatus().message, ...whisperStatus() });
  }

  const q        = req.query;
  const ext      = String(q.ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
  const start    = Math.max(0, Number(q.start) || 0);
  const duration = Math.max(0, Number(q.duration) || 0);
  const tag      = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const mediaPath = path.join(os.tmpdir(), `ms_tx_${tag}.${ext}`);
  const wavPath   = path.join(os.tmpdir(), `ms_tx_${tag}.wav`);

  try {
    await saveUpload(req, mediaPath);
    if (!fs.statSync(mediaPath).size) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });

    await extractAudio(mediaPath, wavPath, { start, duration });
    fs.rm(mediaPath, { force: true }, () => {});

    let response;
    try {
      response = await proxyToWhisper('/transcribe', {
        file:     wavPath,
        language: q.lang || null,      // null = auto-detectar (antes era forçado 'pt')
        padding:  AUDIO_PADDING,
        maxWords: Number(q.maxWords) || 4,
      });
    } catch (err) {
      // Conexão caiu no meio → o processo Python morreu (RAM/VRAM). O manager já reinicia.
      throw Object.assign(new Error(
        'O processo de transcrição caiu (provável falta de memória' +
        (whisper.info.device === 'cuda' ? ' na GPU — reiniciando em modo CPU' : '') +
        '). Aguarde ele reiniciar e tente novamente.'
      ), { status: 503 });
    }

    const { status, data: result } = response;
    if (status !== 200) throw Object.assign(new Error(result.error || 'Erro no Whisper'), { status });

    console.log(`[Transcribe] ✅ clipId=${q.clipId} — ${result.captions?.length ?? 0} legendas (${result.device}/${result.model})`);
    res.json({ clipId: q.clipId, offset: start, ...result });

  } catch (err) {
    console.error('[Transcribe] Falha:', err.message);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  } finally {
    fs.rm(mediaPath, { force: true }, () => {});
    fs.rm(wavPath,   { force: true }, () => {});
  }
});
// #endregion

// #region Tratamento de Erros Global
app.use((err, req, res, _next) => {
  console.error('[Servidor] Erro não tratado:', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});
// #endregion

// #region Inicialização do Servidor
const server = app.listen(PORT, () => {
  console.log(`\n🎬 Motion Studio Export Server — http://localhost:${PORT}`);
  console.log(`   CPUs disponíveis: ${os.cpus().length}\n`);
});
// Upload de vídeos grandes para transcrição pode passar dos 5 min padrão do Node
server.requestTimeout = 0;

// Sobe o Whisper junto com o servidor: verifica/baixa o modelo já na inicialização,
// para a 1ª transcrição não esperar. WHISPER_AUTOSTART=0 volta ao modo sob demanda.
if (process.env.WHISPER_AUTOSTART !== '0') startWhisper();
// #endregion