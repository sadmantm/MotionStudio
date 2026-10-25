// exporter.js
'use strict';

// #region Dependências
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const exportMediaUploads =
  new Map();

  function extensionForMime(
    mimeType,
    fallbackType = 'bin'
  ) {
    return {
      'video/mp4':       'mp4',
      'video/webm':      'webm',
      'video/quicktime': 'mov',
      'image/png':       'png',
      'image/jpeg':      'jpg',
      'image/jpg':       'jpg',
      'image/webp':      'webp',
      'image/gif':       'gif',
      'image/avif':      'avif',
      'audio/mpeg':      'mp3',
      'audio/mp3':       'mp3',
      'audio/wav':       'wav',
      'audio/x-wav':     'wav',
      'audio/wave':      'wav',
      'audio/mp4':       'm4a',
      'audio/x-m4a':     'm4a',
      'audio/aac':       'aac',
      'audio/ogg':       'ogg',
      'audio/opus':      'opus',
      'audio/flac':      'flac',
      'audio/x-flac':    'flac',
      'audio/webm':      'webm',
    }[
      String(mimeType || '')
        .toLowerCase()
    ] || fallbackType;
  }

  function registerExportMediaRoutes(app) {
    const uploadDir =
      path.join(
        os.tmpdir(),
        'mstudio-uploads'
      );
  
    fs.mkdirSync(
      uploadDir,
      { recursive: true }
    );
  
    app.post(
      '/api/export/media/upload',
      (req, res) => {
        const maxBytes =
          2 * 1024 * 1024 * 1024;
  
        const declaredSize =
          Number(
            req.headers[
              'content-length'
            ] || 0
          );
  
        if (declaredSize > maxBytes) {
          res.status(413).json({
            error:
              'Arquivo maior que 2 GB.',
          });
  
          return;
        }
  
        const mimeType =
          String(
            req.headers[
              'content-type'
            ] ||
            'application/octet-stream'
          )
            .split(';')[0]
            .trim();
  
        const uploadId =
          crypto
            .randomBytes(12)
            .toString('hex');
  
        const extension =
          extensionForMime(
            mimeType,
            'bin'
          );
  
        const filePath =
          path.join(
            uploadDir,
            `${uploadId}.${extension}`
          );
  
        const output =
          fs.createWriteStream(
            filePath,
            { flags: 'wx' }
          );
  
        let received = 0;
        let settled = false;
  
        function fail(
          status,
          message
        ) {
          if (settled) return;
  
          settled = true;
          output.destroy();
  
          fs.rm(
            filePath,
            { force: true },
            () => {}
          );
  
          if (!res.headersSent) {
            res
              .status(status)
              .json({ error: message });
          }
        }
  
        req.on(
          'data',
          chunk => {
            received += chunk.length;
  
            if (received > maxBytes) {
              req.destroy();
  
              fail(
                413,
                'Arquivo maior que 2 GB.'
              );
            }
          }
        );
  
        req.on(
          'aborted',
          () => {
            fail(
              499,
              'Upload cancelado.'
            );
          }
        );
  
        req.on(
          'error',
          err => {
            fail(
              500,
              err.message
            );
          }
        );
  
        output.on(
          'error',
          err => {
            fail(
              500,
              err.message
            );
          }
        );
  
        output.on(
          'finish',
          () => {
            if (settled) return;
  
            settled = true;
  
            exportMediaUploads.set(
              uploadId,
              {
                filePath,
                mimeType,
                size: received,
                createdAt: Date.now(),
              }
            );
  
            res.json({
              uploadId,
              size: received,
              mimeType,
            });
          }
        );
  
        req.pipe(output);
      }
    );
  
    setInterval(
      () => {
        const now = Date.now();
  
        for (
          const [id, item]
          of exportMediaUploads
        ) {
          if (
            now - item.createdAt <
            60 * 60 * 1000
          ) {
            continue;
          }
  
          exportMediaUploads.delete(id);
  
          fs.rm(
            item.filePath,
            { force: true },
            () => {}
          );
        }
      },
      5 * 60 * 1000
    ).unref();
  }


// PROJECT_ROOT é definido externamente via setProjectRoot() pelo server.js.
// O server.js mora na raiz do projeto, então passa o próprio __dirname.
// Fallback: tenta deduzir subindo a partir de __dirname até encontrar package.json.
let PROJECT_ROOT = null;

function setProjectRoot(root) {
  PROJECT_ROOT = path.resolve(root);
  console.log(`[WVC] PROJECT_ROOT definido: ${PROJECT_ROOT}`);
}

function getProjectRoot() {
  if (PROJECT_ROOT) return PROJECT_ROOT;

  // Fallback: sobe a partir do __dirname procurando package.json
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      PROJECT_ROOT = dir;
      console.log(`[WVC] PROJECT_ROOT auto-detectado via package.json: ${dir}`);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Último recurso: __dirname mesmo
  PROJECT_ROOT = __dirname;
  console.warn(`[WVC] PROJECT_ROOT não definido, usando __dirname: ${__dirname}`);
  return __dirname;
}
// #endregion

// #region Configuração
const CPUS          = os.cpus().length;
const CLEANUP_DELAY = 30_000;
const VIDEO_ENCODER_KEY = process.env.HW_ENCODER || 'CPU_X264';
 
/**
 * Bitrate de vídeo (kbps) proporcional à área × fps.
 * ~0.20 bit/pixel/frame ≈ 25 Mbps em 1080p60. Encoders de hardware
 * (NVENC/QSV/AMF/VideoToolbox) recebem +30% porque comprimem pior que x264
 * no mesmo bitrate. Limites: 12–60 Mbps. VIDEO_BITRATE_KBPS=30000 fixa o valor.
 */
function computeVideoBitrateKbps(width, height, fps, encoderName) {
  if (process.env.VIDEO_BITRATE_KBPS) return Number(process.env.VIDEO_BITRATE_KBPS);
  const bitsPerPixelFrame = 0.20;
  const isHardware = /nvenc|qsv|amf|videotoolbox/i.test(String(encoderName));
  let kbps = (width * height * fps * bitsPerPixelFrame) / 1000;
  if (isHardware) kbps *= 1.3;
  return Math.round(Math.max(12000, Math.min(60000, kbps)));
}
// #endregion

// #region Dynamic import do WebVideoCreator (ESM em projeto CJS)
// Com guard rails: se WVC falhar em qualquer ponto, capturamos o motivo
// real e podemos cair em fallback.
let _wvcPromise = null;
let _wvcError   = null;

async function getWVC() {
  if (_wvcPromise) return _wvcPromise;
  if (_wvcError)   throw _wvcError;
 
  _wvcPromise = (async () => {
    // Node >= 23 removeu util.isString, que o logger do WVC
    // (web-video-creator/lib/logger.js) ainda usa → todo export quebrava com
    // "util.isString is not a function". O default export ESM de "util" é o
    // mesmo objeto do require, então o shim vale para o WVC.
    const nodeUtil = require('util');
    if (typeof nodeUtil.isString !== 'function') {
      nodeUtil.isString = value => typeof value === 'string';
    }

    // macOS: o WVC trata tudo que não é win32 como Linux e lança o Chrome com
    // --single-process, que derruba o Chrome 119 no Mac logo ao abrir a página
    // ("Requesting main frame too early" / "Session closed"). Só usa
    // --single-process no Linux de verdade.
    if (os.platform() === 'darwin') {
      try {
        const wvcUtil =
          (await import('web-video-creator/lib/util.js')).default;
        if (wvcUtil && typeof wvcUtil.isLinux === 'function') {
          wvcUtil.isLinux = () => false;
        }
      } catch (_) {}
    }

    let mod;
    try {
      mod = await import('web-video-creator');
    } catch (err) {
      throw new Error(
        `[WVC] Falha ao importar 'web-video-creator': ${err.message}\n` +
        `Solução: rode "npm install web-video-creator" e verifique se o pacote ` +
        `está no package.json. Se ffmpeg-static falhou, defina ` +
        `FFMPEG_BINARIES_URL=https://cdn.npmmirror.com/binaries/ffmpeg-static`
      );
    }
 
    const WebVideoCreator = mod.default || mod.WebVideoCreator;
    const VIDEO_ENCODER   = mod.VIDEO_ENCODER;
    const AUDIO_ENCODER   = mod.AUDIO_ENCODER;
    const TRANSITION      = mod.TRANSITION;
    const logger          = mod.logger;
 
    if (typeof WebVideoCreator !== 'function') {
      console.error('[WVC] Exports recebidos:', Object.keys(mod));
      throw new Error(
        `[WVC] 'web-video-creator' não exportou WebVideoCreator como default. ` +
        `Verifique a versão instalada com: npm list web-video-creator`
      );
    }
    if (!VIDEO_ENCODER || typeof VIDEO_ENCODER !== 'object') {
      console.error('[WVC] Exports recebidos:', Object.keys(mod));
      throw new Error(
        `[WVC] VIDEO_ENCODER não foi exportado. Versão incompatível. ` +
        `Use: npm install web-video-creator@latest`
      );
    }
 
    function resolveEncoder(key) {
      const path = {
        CPU_X264:    ['CPU',    'H264'],
        NVIDIA_H264: ['NVIDIA', 'H264'],
        NVIDIA_H265: ['NVIDIA', 'H265'],
        INTEL_H264:  ['INTEL',  'H264'],
        AMD_H264:    ['AMD',    'H264'],
        MAC_H264:    ['OMX',    'H264'],
      }[key];
      if (!path) return null;
      const [vendor, codec] = path;
      return VIDEO_ENCODER?.[vendor]?.[codec] || null;
    }
 
    const encoder = process.env.HW_ENCODER
      ? (resolveEncoder(process.env.HW_ENCODER) || process.env.HW_ENCODER)
      : await detectBestEncoder();
 
    // Modo rápido (preview): volta para JPEG. Padrão: PNG lossless.
    const fastMode = process.env.WVC_FAST === '1';
 
    console.log(`[WVC] Encoder selecionado: ${encoder}`);
    console.log(`[WVC] Plataforma: ${os.platform()}, CPUs: ${CPUS}`);
    console.log(`[WVC] Captura de frames: ${fastMode ? 'JPEG 90 (rápido)' : 'PNG lossless (qualidade)'}`);
 
    const wvc = new WebVideoCreator();
 
    wvc.config({
      mp4Encoder:      encoder,
      browserHeadless: true,
 
      // GPU ligada por padrão; WVC_GPU=0 desliga.
      browserUseGPU:   process.env.WVC_GPU !== '0',
      browserUseAngle: false,
      compatibleRenderingMode: os.platform() === 'darwin',
 
      numBrowserMin: 1,
      numBrowserMax: 1,
      numPageMin:    1,
      numPageMax:    1,
 
      // ── Qualidade da captura ──────────────────────────────────
      // PNG = sem perda entre o Chromium e o ffmpeg. Só o H.264 final comprime.
      frameFormat:  fastMode ? 'jpeg' : 'png',
      frameQuality: fastMode ? 90 : 100,
 
      // Flags extras do Chromium para rasterização estável e nítida.
      browserLaunchOptions: {
        args: [
          '--force-color-profile=srgb',
          '--font-render-hinting=none',
          '--disable-font-subpixel-positioning',
          '--disable-lcd-text',
          '--enable-gpu-rasterization',
          '--enable-zero-copy',
          '--ignore-gpu-blocklist',
          '--disable-partial-raster',
          // PCs sem GPU: o Chrome atual só cria WebGL por software (SwiftShader)
          // com esta flag — sem ela, clipes 3D/WebGL saem em branco no export.
          ...(process.env.WVC_SWIFTSHADER === '0' ? [] : ['--enable-unsafe-swiftshader']),
        ],
      },
 
      browserDisableDevShm: process.env.IN_DOCKER === '1',
      // App desktop: Chrome do export vem empacotado (sem download na 1ª exportação)
      ...(process.env.MS_CHROME_PATH ? { browserExecutablePath: process.env.MS_CHROME_PATH } : {}),
      debug:       process.env.WVC_DEBUG === '1',
      ffmpegDebug: process.env.WVC_DEBUG === '1',
    });
 
    return {
      wvc,
      VIDEO_ENCODER,
      AUDIO_ENCODER,
      TRANSITION,
      logger,
      encoderName: String(encoder),   // ← usado pelo renderJob para calibrar o bitrate
    };

  })();
 
  _wvcPromise.catch(err => { _wvcError = err; _wvcPromise = null; });
 
  return _wvcPromise;
}

// #endregion

// #region Servidor HTTP interno para servir HTML das cenas + assets do projeto
//
// Estratégia: o servidor interno emula a raiz do projeto.
//   - GET /job/<jobId>/scene-<idx>.html  → HTML patcheado da cena
//   - GET /assets/<arquivo>              → arquivo de PROJECT_ROOT/assets/...
//   - GET /<qualquer-outro>              → arquivo relativo a PROJECT_ROOT (fontes, css, js)
//
// Como o HTML da cena é servido em /job/<jobId>/scene-<idx>.html, caminhos
// relativos no template funcionam naturalmente:
//   <img src="assets/logo.png">     → /job/<jobId>/assets/logo.png   (resolvido abaixo)
//   <img src="../assets/logo.png">  → /job/assets/logo.png            (resolvido abaixo)
//   <img src="/assets/logo.png">    → /assets/logo.png                (servido direto)

const sceneStore = new Map();
const jobMediaDirs = new Map();
let _internalServer = null;
let _internalPort   = null;

// MIME types suportados
const MIME_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.avif': 'image/avif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function mimeOf(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function safeResolve(relPath) {
  const root    = getProjectRoot();
  const decoded = decodeURIComponent(relPath.split('?')[0].split('#')[0]);
  const clean   = path.posix.normalize('/' + decoded).replace(/^\/+/, '');
  const abs     = path.resolve(root, clean);
  const rootAbs = path.resolve(root) + path.sep;
  if (!abs.startsWith(rootAbs) && abs !== path.resolve(root)) {
    return null;
  }
  return abs;
}


function serveFile(
  req,
  res,
  absPath
) {
  fs.stat(
    absPath,
    (err, stat) => {
      if (
        err ||
        !stat.isFile()
      ) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }

      const fileSize =
        stat.size;

      const range =
        req.headers.range;

      res.setHeader(
        'Content-Type',
        mimeOf(absPath)
      );

      res.setHeader(
        'Accept-Ranges',
        'bytes'
      );

      res.setHeader(
        'Cache-Control',
        'private, max-age=3600'
      );

      if (req.method === 'HEAD') {
        res.setHeader(
          'Content-Length',
          fileSize
        );

        res.end();
        return;
      }

      if (!range) {
        res.statusCode = 200;

        res.setHeader(
          'Content-Length',
          fileSize
        );

        fs.createReadStream(
          absPath
        ).pipe(res);

        return;
      }

      const match =
        /^bytes=(\d*)-(\d*)$/
          .exec(range);

      if (!match) {
        res.statusCode = 416;

        res.setHeader(
          'Content-Range',
          `bytes */${fileSize}`
        );

        res.end();
        return;
      }

      let start =
        match[1]
          ? Number(match[1])
          : 0;

      let end =
        match[2]
          ? Number(match[2])
          : fileSize - 1;

      if (
        !match[1] &&
        match[2]
      ) {
        const suffixLength =
          Math.min(
            fileSize,
            Number(match[2])
          );

        start =
          fileSize -
          suffixLength;

        end =
          fileSize - 1;
      }

      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        start >= fileSize
      ) {
        res.statusCode = 416;

        res.setHeader(
          'Content-Range',
          `bytes */${fileSize}`
        );

        res.end();
        return;
      }

      end =
        Math.min(
          end,
          fileSize - 1
        );

      res.statusCode = 206;

      res.setHeader(
        'Content-Range',
        `bytes ${start}-${end}/${fileSize}`
      );

      res.setHeader(
        'Content-Length',
        end - start + 1
      );

      fs.createReadStream(
        absPath,
        { start, end }
      ).pipe(res);
    }
  );
}

function ensureInternalServer() {
  if (_internalServer) return Promise.resolve(_internalPort);

  return new Promise((resolve, reject) => {
    _internalServer = http.createServer((req, res) => {
      const url = req.url || '/';
      const logMatch = /^\/__log\?(.+)$/.exec(url);
if (logMatch) {
  console.log(`[PAGE LOG] ${decodeURIComponent(logMatch[1])}`);
  res.statusCode = 204;
  return res.end();
}
    
      // 0) Mídia do job (vídeo/imagem materializados em tmpDir)  ← NOVO
      const mediaMatch = /^\/job\/([^/]+)\/media\/([^/?#]+)$/.exec(url);
      if (mediaMatch) {
        const dir = jobMediaDirs.get(mediaMatch[1]);
        if (!dir) { res.statusCode = 404; return res.end('no media dir'); }
        const file = path.join(dir, path.basename(decodeURIComponent(mediaMatch[2])));
        return serveFile(
          req,
          res,
          file
        );   // serveFile já faz stat + stream + mime
      }
    
      // 1) HTML da cena
      const sceneMatch = /^\/job\/([^/]+)\/scene-(\d+)\.html$/.exec(url);
      if (sceneMatch) {
        const html = sceneStore.get(`${sceneMatch[1]}_${sceneMatch[2]}`);
        if (!html) { res.statusCode = 404; return res.end('scene not found'); }
        res.setHeader('Content-Type',  'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(html);
      }
    
      // 2) Caminhos resolvidos a partir da URL da cena (com /job/...)
      const jobScopedMatch = /^\/job\/[^/]+\/(.+)$/.exec(url) || /^\/job\/(.+)$/.exec(url);
      if (jobScopedMatch) {
        res.statusCode = 302;
        res.setHeader('Location', '/' + jobScopedMatch[1]);
        return res.end();
      }
    
      // 3) Servir arquivos da raiz com fallback automático para /assets/
      const abs = safeResolve(url);
      if (!abs) { res.statusCode = 403; return res.end('forbidden'); }
    
      fs.stat(abs, (err, stat) => {
        if (!err && stat.isFile()) {
          return serveFile(
            req,
            res,
            abs
          );
        }
    
        // Fallback: tenta a mesma URL dentro de /assets/
        // Útil quando template tem <img src="logo.png"> sem o prefixo assets/
        const root = getProjectRoot();
        const filename = path.basename(url.split('?')[0].split('#')[0]);
        const fallback = path.join(root, 'assets', filename);
    
        fs.stat(fallback, (err2, stat2) => {
          if (!err2 && stat2.isFile()) {
            console.log(`[WVC] Fallback: ${url} → /assets/${filename}`);
            return serveFile(
              req,
              res,
              fallback
            );
          }
          console.warn(`[WVC] 404: ${url} (tentou também ${fallback})`);
          res.statusCode = 404;
          res.end('not found');
        });
      });
    });

    _internalServer.listen(0, '127.0.0.1', () => {
      _internalPort = _internalServer.address().port;
      const root = getProjectRoot();
      console.log(`[WVC] Servidor interno escutando em http://127.0.0.1:${_internalPort}`);
      console.log(`[WVC] PROJECT_ROOT = ${root}`);
      const assetsDir = path.join(root, 'assets');
      if (fs.existsSync(assetsDir)) {
        console.log(`[WVC] ✓ Pasta assets encontrada: ${assetsDir}`);
      } else {
        console.warn(`[WVC] ⚠ Pasta assets NÃO encontrada em: ${assetsDir}`);
      }
      resolve(_internalPort);
    });
    _internalServer.on('error', reject);
  });
}
// #endregion

// #region Gerenciamento de Jobs (mantido igual à sua API)
const jobs = new Map();
const mkId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function createJob(opts) {
  const id = mkId();
  jobs.set(id, {
    id, ...opts,
    tmpDir: null, status: 'pending', progress: 0,
    message: 'Aguardando início…', outputPath: null,
    error: null, createdAt: Date.now(),
  });
  return id;
}
const getJob      = id => jobs.get(id) || null;
const updateJob   = (id, patch) => { const j = jobs.get(id); if (j) Object.assign(j, patch); };
const finalizeJob = (id, outputPath) => updateJob(id, { status: 'done', progress: 100, message: 'Concluído!', outputPath });
const failJob     = (id, errMsg) => updateJob(id, { status: 'error', error: errMsg });

function downloadJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'done') return null;
  // NÃO agenda mais cleanup aqui — o server.js limpa após o stream fechar.
  return { outputPath: job.outputPath, format: job.format };
}

function cleanupJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  for (const key of Array.from(sceneStore.keys())) {
    if (key.startsWith(`${id}_`)) sceneStore.delete(key);
  }
  jobMediaDirs.delete(id);   // ← NOVO
  if (job.tmpDir) {
    try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch {}
  }
  jobs.delete(id);
}

// GC de jobs terminados/abandonados. Necessário porque:
//  - jobs com status 'error' nunca passam por downloadJob;
//  - jobs 'done' que o usuário nunca baixou também não.
// Sem isso, sceneStore/jobMediaDirs/tmpDir vazam para sempre.
const JOB_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const terminal = job.status === 'error' || job.status === 'done';
    if (terminal && now - job.createdAt > JOB_TTL_MS) {
      console.log(`[GC] Limpando job ${id} (status=${job.status})`);
      cleanupJob(id);
    }
  }
}, 60_000).unref();
// #endregion

// #region Composição por fronteira temporal (tracks inline no topo)


// Separa o miolo de <head> e <body> mantendo <style>/<link>/<script> INTACTOS.

function htmlLayerTransform(
  clip,
  width,
  height,
  projectRes
) {
  const res =
    projectRes || {
      w: width,
      h: height,
    };

  const projectW =
    Math.max(
      1,
      finiteNumber(
        res.w,
        width
      )
    );

  const projectH =
    Math.max(
      1,
      finiteNumber(
        res.h,
        height
      )
    );

  const scaleX =
    width / projectW;

  const scaleY =
    height / projectH;

  const sourceTransform =
    clip._tx ||
    clip.tx || {
      x: 0,
      y: 0,
      w: projectW,
      h: projectH,
      r: 0,
    };

  const transform = {
    x:
      finiteNumber(
        sourceTransform.x
      ) * scaleX,

    y:
      finiteNumber(
        sourceTransform.y
      ) * scaleY,

    w:
      Math.max(
        1,
        finiteNumber(
          sourceTransform.w,
          projectW
        )
      ) * scaleX,

    h:
      Math.max(
        1,
        finiteNumber(
          sourceTransform.h,
          projectH
        )
      ) * scaleY,

    r:
      finiteNumber(
        sourceTransform.r
      ),
  };

  const zIndex =
    finiteNumber(
      clip.trackIndex,
      0
    ) + 1;

  const innerScaleX =
    transform.w / projectW;

  const innerScaleY =
    transform.h / projectH;

  return {
    wrapStyle:
      `position:absolute;` +
      `left:${transform.x}px;` +
      `top:${transform.y}px;` +
      `width:${transform.w}px;` +
      `height:${transform.h}px;` +
      `transform:rotate(${transform.r}deg);` +
      `transform-origin:center center;` +
      `overflow:hidden;` +
      `z-index:${zIndex};` +
      `display:none;`,

    frameStyle:
      `position:absolute;` +
      `left:0;top:0;` +
      `width:${projectW}px;` +
      `height:${projectH}px;` +
      `transform:scale(${innerScaleX},${innerScaleY});` +
      `transform-origin:0 0;` +
      `border:0;` +
      `background:transparent;` +
      `overflow:hidden;`,
  };
}

function buildTextLayerHtmlGlobal(
  clip,
  width,
  height,
  projectRes
) {
  const {
    wrapStyle,
    frameStyle,
  } = htmlLayerTransform(
    clip,
    width,
    height,
    projectRes
  );

  const params =
    clip.textParams || {};

  const animation =
    [
      'fadeIn',
      'slideUp',
      'slideLeft',
    ].includes(params.animation)
      ? params.animation
      : 'fadeIn';

  const align =
    [
      'left',
      'center',
      'right',
      'justify',
    ].includes(params.align)
      ? params.align
      : 'center';

  const background =
    safeCssValue(
      params.bg,
      'transparent'
    );

  let layoutStyle = '';
  let baseTransform = '';

  if (animation === 'slideLeft') {
    layoutStyle =
      `position:absolute;` +
      `bottom:160px;` +
      `left:0;right:0;` +
      `padding:22px 60px;` +
      `background:${background};` +
      `text-align:${align};`;
  } else if (
    animation === 'fadeIn' &&
    background !== 'transparent' &&
    background !== ''
  ) {
    layoutStyle =
      `position:absolute;` +
      `bottom:100px;` +
      `left:40px;right:40px;` +
      `padding:16px 28px;` +
      `background:${background};` +
      `border-radius:10px;` +
      `text-align:${align};`;
  } else {
    layoutStyle =
      `position:absolute;` +
      `top:50%;left:50%;` +
      `width:90%;` +
      `text-align:${align};`;

    baseTransform =
      'translate(-50%, -50%)';
  }

  const style =
    layoutStyle +
    `font-family:${safeCssValue(
      params.fontFamily,
      'Inter, sans-serif'
    )};` +
    `font-size:${Math.max(
      1,
      finiteNumber(
        params.fontSize,
        80
      )
    )}px;` +
    `font-weight:${safeCssValue(
      params.fontWeight,
      '700'
    )};` +
    `color:${safeCssValue(
      params.color,
      '#ffffff'
    )};` +
    `line-height:1.2;` +
    `opacity:0;` +
    `will-change:opacity,transform;`;

  const text =
    escHtml(
      params.text ??
      clip.label ??
      'Texto'
    ).replace(
      /\r?\n/g,
      '<br>'
    );

  return `
<div
  data-ms-layer
  data-type="text"
  data-start="${Math.max(
    0,
    finiteNumber(clip.start)
  )}"
  data-dur="${Math.max(
    0.001,
    finiteNumber(
      clip.duration,
      1
    )
  )}"
  style="${escAttr(wrapStyle)}"
>
  <div style="${escAttr(frameStyle)}">
    <div
      data-ms-text
      data-animation="${animation}"
      data-base-transform="${escAttr(
        baseTransform
      )}"
      style="${escAttr(style)}"
    >${text}</div>
  </div>
</div>`;
}

function buildHtmlLayerHtmlGlobal(
  clip,
  width,
  height,
  projectRoot,
  projectRes
) {
  const {
    wrapStyle,
    frameStyle,
  } = htmlLayerTransform(
    clip,
    width,
    height,
    projectRes
  );

  const html =
    inlineLocalAssets(
      String(clip.html || ''),
      projectRoot
    );

  const payload =
    Buffer.from(
      html,
      'utf8'
    ).toString('base64');

  /*
   * Texto: o template é reconstruído com duration = clip.duration, então o
   * tempo é 1:1 com a timeline e sem trim/stretch — igual ao preview
   * (compositor: isText nunca usa fitAnimationToClip e trimStart = 0).
   */
  const isText =
    Boolean(clip.isText);

  const sourceIn =
    isText
      ? 0
      : Math.max(
          0,
          finiteNumber(
            clip.trimStart
          )
        );

  const sourceOut =
    Math.max(
      sourceIn,
      finiteNumber(
        clip.trimEnd,
        finiteNumber(
          clip.sourceDuration,
          clip.duration
        )
      )
    );

  return `
<div
  data-ms-layer
  data-type="html"
  data-start="${Math.max(
    0,
    finiteNumber(clip.start)
  )}"
  data-dur="${Math.max(
    0.001,
    finiteNumber(
      clip.duration,
      1
    )
  )}"
  data-source-in="${sourceIn}"
  data-source-out="${sourceOut}"
  data-fit="${
    clip.fitAnimationToClip &&
    !isText
      ? '1'
      : '0'
  }"
  data-text="${isText ? '1' : '0'}"
  style="${escAttr(wrapStyle)}"
>
  <div
    class="__ms_html_host"
    style="${escAttr(frameStyle)}"
  ></div>

  <script
    type="application/octet-stream"
    class="__ms_html_payload"
  >${payload}</script>
</div>`;
}
// #endregion

// #region renderJob — orquestração via WVC (composição por tracks)
async function renderJob(jobId, clips, opts) {
  const { fps, format, width, height, projectRes } = opts;
 
  clips.forEach((c, i) => {
    console.log(
      `[Job ${jobId}] clip[${i}] label="${c.label}" type="${c.type}" ` +
      `isText=${!!c.isText} hasHtml=${!!c.html} hasDataUrl=${!!c.dataUrl} ` +
      `start=${c.start} dur=${c.duration} trackIndex=${c.trackIndex}`
    );
  });
 
  // Modo de diagnóstico: renderiza só a primeira camada HTML isolada.
  const firstHtml = clips.find(c => c.type === 'html' && c.html);
  if (firstHtml && process.env.TEST_SINGLE === '1') {
    return testSingleLayer(jobId, firstHtml, { fps, width, height });
  }
 
  const tmpDir = path.join(os.tmpdir(), `mstudio-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  updateJob(jobId, {
    tmpDir,
    status:  'rendering',
    message: `Compondo ${clips.length} clip(s)…`,
  });
 
  try {
    const { wvc, encoderName } = await getWVC();
    const port = await ensureInternalServer();
    const root = getProjectRoot();
 
    jobMediaDirs.set(jobId, tmpDir);
 
    // 0. Materializa vídeo/imagem (upload ou data: URI) em arquivo e serve via http.
    await materializeMediaForJob(jobId, clips, tmpDir, port);
 
    // 1. Duração total = fim do clipe que termina mais tarde.
    const totalDuration = clips.reduce(
      (mx, c) => Math.max(mx, (c.start || 0) + (c.duration || 0)),
      0
    );
    if (!(totalDuration > 0)) throw new Error('Duração total inválida.');
 
    // 2. UMA cena composta com todas as camadas, dirigida pelo relógio virtual do WVC.
    const html = buildFullScene(clips, width, height, root, projectRes, fps);
 
    // 3. Publica a cena no servidor interno. Sem isto o Chromium recebe 404
    //    e o vídeo sai preto.
    sceneStore.set(`${jobId}_0`, html);
 
    const url        = `http://127.0.0.1:${port}/job/${jobId}/scene-0.html`;
    const outputPath = path.join(tmpDir, `output.${format}`);
 
    // 4. Bitrate calibrado pela resolução/fps/encoder deste export.
    const bitrateKbps = computeVideoBitrateKbps(width, height, fps, encoderName);
    console.log(
      `[Job ${jobId}] ${width}x${height}@${fps} · ${totalDuration.toFixed(2)}s · ` +
      `encoder=${encoderName} · bitrate=${bitrateKbps}k`
    );
 
    const video = wvc.createSingleVideo({
      url, width, height, fps,
      duration:     Math.round(totalDuration * 1000),
      outputPath,
      showProgress: true,
      // O padrão do WVC é 'prefer-hardware': sem decodificador de vídeo por
      // hardware (PCs sem GPU, Chromium headless no macOS) o VideoDecoder recusa a
      // configuração e o export trava esperando o 1º quadro. 'no-preference' usa
      // hardware quando existe e software quando não. WVC_VIDEO_DECODER sobrescreve.
      videoDecoderHardwareAcceleration: process.env.WVC_VIDEO_DECODER || 'no-preference',

      // WVC_DEBUG=1: console da página do export + pré-processamento de vídeo no terminal
      consoleLog:         process.env.WVC_DEBUG === '1',
      videoPreprocessLog: process.env.WVC_DEBUG === '1',
      startTime:    0,
      timeout:      30 * 60 * 1000,
 
      videoBitrate: `${bitrateKbps}k`,
      audioBitrate: '320k',
      // yuv420p roda em qualquer player/telão. yuv444p preserva mais cor,
      // mas muitos players de mídia não reproduzem.
      pixelFormat:  'yuv420p',
    });
 
    video.on('progress', (...args) => {
      const pct = Number(args[0]);
      if (!Number.isFinite(pct)) return;
      updateJob(jobId, {
        progress: Math.max(0, Math.min(99, Math.round(pct))),
        message:  `Renderizando… ${Math.round(pct)}%`,
      });
    });
 
    // 5. Aguarda o WVC, com watchdog de inatividade (5 min sem progresso = travou).
    await new Promise((resolve, reject) => {
      let settled  = false;
      let watchdog = null;
      const IDLE_MS = 5 * 60 * 1000;
 
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        fn(arg);
      };
 
      const arm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          finish(reject, new Error(
            `Timeout: render sem progresso há ${IDLE_MS / 60000} minutos ` +
            `(provável crash do Chromium/ffmpeg).`
          ));
        }, IDLE_MS);
      };
      arm();
 
      video.on('progress', arm);
 
      video.once('completed', result => {
        console.log(`[Job ${jobId}] RTF: ${result?.rtf}, took: ${result?.takes}ms`);
        finish(resolve);
      });
      video.once('error', err => finish(reject, err));
 
      Promise.resolve(video.start()).catch(err => finish(reject, err));
    });
 
    // 6. Áudio dos clipes de vídeo e de áudio (o WVC captura só imagem).
    //    Volume 0 = mudo (clip, track mutada ou fora do solo): fica fora da mixagem.
    const soundClips = clips.filter(c =>
      (c.type === 'video' || c.type === 'audio') && finiteNumber(c.volume, 1) > 0
    );
    if (soundClips.length > 0) {
      updateJob(jobId, { progress: 99, message: 'Mixando áudio…' });
      await mixAudioTracks(soundClips, outputPath, format);
    }
 
    finalizeJob(jobId, outputPath);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[Job ${jobId}] ERRO:`, msg);
    if (err?.stack) console.error(err.stack);
    failJob(jobId, msg);
  }
}

function buildMediaLayerHtmlGlobal(
  clip,
  width,
  height,
  projectRes
) {
  const { wrapStyle } =
    htmlLayerTransform(
      clip,
      width,
      height,
      projectRes
    );

  const start =
    Math.max(
      0,
      finiteNumber(clip.start)
    );

  const duration =
    Math.max(
      0.001,
      finiteNumber(
        clip.duration,
        1
      )
    );

  const trimStart =
    Math.max(
      0,
      finiteNumber(
        clip.trimStart
      )
    );

  const attributes =
    `data-ms-layer ` +
    `data-type="${escAttr(
      clip.type
    )}" ` +
    `data-start="${start}" ` +
    `data-dur="${duration}" ` +
    `data-trim="${trimStart}"`;

  if (clip.type === 'image') {
    return `
<div
  ${attributes}
  style="${escAttr(wrapStyle)}"
>
  <img
    src="${escAttr(clip.dataUrl)}"
    decoding="async"
    style="width:100%;height:100%;object-fit:fill;display:block"
  >
</div>`;
  }

  return `
<div
  ${attributes}
  style="${escAttr(wrapStyle)}"
>
  <video
    src="${escAttr(clip.dataUrl)}"
    capture
    muted
    preload="auto"
    playsinline
    startTime="${Math.round(
      start * 1000
    )}"
    endTime="${Math.round(
      (start + duration) * 1000
    )}"
    seekStart="${Math.round(
      trimStart * 1000
    )}"
    seekEnd="${Math.round(
      (trimStart + duration) * 1000
    )}"
    style="width:100%;height:100%;object-fit:fill;display:block"
  ></video>
</div>`;
}

function buildSceneRuntimeScript(totalDuration, fps) {
  return `
<script>
(function () {
  'use strict';

  var TOTAL = ${JSON.stringify(totalDuration)};
  var FPS   = ${JSON.stringify(fps)};
  // Modelos 3D/texturas/bibliotecas de CDN podem levar mais que fontes
  var READY_TIMEOUT_MS = 45000;

  // Camadas HTML (templates e textos) são montadas sob demanda: o iframe só
  // existe de PRELOAD_S antes do início até KEEP_S depois do fim. Com 100+
  // legendas, montar tudo de uma vez = 100+ documentos carregando fontes no
  // load e 100+ Motion.seek por frame. Assim só ~2–4 iframes vivem por vez.
  var PRELOAD_S = 1.5;
  var KEEP_S    = 0.25;

  // Timers reais: o WVC virtualiza setTimeout/rAF da página e, com a captura
  // pausada esperando um iframe, um timeout virtual nunca dispararia.
  var realSetTimeout = window.____setTimeout || window.setTimeout;
  function later(fn, ms) { return realSetTimeout.call(window, fn, ms); }

  var layers = Array.prototype.slice.call(
    document.querySelectorAll('[data-ms-layer]')
  );

  function number(value, fallback) {
    value = Number(value);
    return isFinite(value) ? value : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function easeOut(value) {
    var progress = clamp(value, 0, 1);
    return 1 - Math.pow(1 - progress, 3);
  }

  function decodeBase64(value) {
    var binary = atob(value.trim());
    var bytes  = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  layers.forEach(function (layer) {
    layer.__start = number(layer.dataset.start, 0);
    layer.__dur   = Math.max(0.001, number(layer.dataset.dur, 1));
    layer.__end   = layer.__start + layer.__dur;
  });

  var htmlLayers = layers.filter(function (layer) {
    return layer.dataset.type === 'html';
  });

  // ── Camada de texto (fallback genérico, sem HTML de template) ─
  function renderText(layer, localTime) {
    var element = layer.querySelector('[data-ms-text]');
    if (!element) return;

    var duration     = layer.__dur;
    var animationIn  = Math.min(0.6, duration * 0.15);
    var animationOut = Math.min(0.5, duration * 0.12);
    var animation    = element.dataset.animation || 'fadeIn';
    var baseTransform = element.dataset.baseTransform || '';

    var opacity = 1;
    var extraTransform = '';

    if (localTime <= 0) {
      opacity = 0;
    } else if (localTime < animationIn) {
      var progress = easeOut(localTime / Math.max(0.001, animationIn));
      opacity = progress;
      if (animation === 'slideUp') {
        extraTransform = ' translateY(' + ((1 - progress) * 60) + 'px)';
      } else if (animation === 'slideLeft') {
        extraTransform = ' translateX(' + ((1 - progress) * -80) + 'px)';
      }
    } else if (localTime > duration - animationOut) {
      opacity = 1 - clamp(
        (localTime - (duration - animationOut)) / Math.max(0.001, animationOut),
        0, 1
      );
    }

    element.style.opacity   = String(opacity);
    element.style.transform = (baseTransform + extraTransform).trim();
  }

  // ── Camada HTML (template Motion dentro de iframe) ──────────
  function seekHtml(frame, time) {
    if (!frame) return;

    if (!frame.__ready) {
      frame.__pendingTime = time;
      return;
    }

    try {
      var w = frame.contentWindow;
      if (w.Motion && typeof w.Motion.seek === 'function') {
        w.Motion.seek(time);
      } else if (w.MotionAPI && typeof w.MotionAPI.seek === 'function') {
        w.MotionAPI.seek(time);
      } else if (frame.contentDocument && frame.contentDocument.getAnimations) {
        frame.contentDocument.getAnimations().forEach(function (animation) {
          try {
            animation.pause();
            animation.currentTime = time * 1000;
          } catch (_) {}
        });
      }
    } catch (_) {}
  }

  // Cria o iframe da camada e devolve uma Promise que resolve quando o
  // template terminou de carregar (load + Motion.whenReady + fontes).
  function createHtmlFrame(layer) {
    if (layer.__frame) return layer.__frame.__readyPromise;

    var host    = layer.querySelector('.__ms_html_host');
    var payload = layer.querySelector('.__ms_html_payload');
    if (!host || !payload) return Promise.resolve();

    if (layer.__srcdoc == null) {
      layer.__srcdoc = decodeBase64(payload.textContent || '');
    }

    var frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts allow-same-origin';
    frame.__ready = false;

    // Montada mas ainda fora do tempo: com layout (fontes são pedidas e o
    // template mede no tamanho certo), porém invisível.
    layer.style.display = '';
    layer.style.visibility = 'hidden';

    frame.__readyPromise = new Promise(function (resolve) {
      var settled = false;
      function done() {
        if (settled) return;
        settled = true;
        frame.__ready = true;
        if (isFinite(frame.__pendingTime)) {
          seekHtml(frame, frame.__pendingTime);
        } else {
          seekHtml(frame, 0);
        }
        resolve();
      }

      frame.addEventListener('load', function () {
        var w = frame.contentWindow;
        var d = frame.contentDocument;
        var M = w && (w.Motion || w.MotionAPI);
        try {
          if (M && typeof M.init === 'function') M.init();
        } catch (_) {}
        var p;
        try {
          p = (M && typeof M.whenReady === 'function') ? M.whenReady() : null;
        } catch (_) { p = null; }
        Promise.resolve(p).catch(function () {}).then(function () {
          // Fontes web usadas pelo texto: força layout e espera o carregamento,
          // senão os primeiros frames saem com a fonte de fallback.
          try { if (d && d.body) void d.body.offsetHeight; } catch (_) {}
          var fonts = null;
          try { fonts = d && d.fonts ? d.fonts.ready : null; } catch (_) {}
          return Promise.resolve(fonts).catch(function () {});
        }).then(done);
      }, { once: true });

      // Rede de segurança: fonte externa que não responde não trava o export
      later(done, READY_TIMEOUT_MS);
    });

    frame.srcdoc = layer.__srcdoc;
    host.appendChild(frame);
    layer.__frame = frame;
    layer.__lastSeek = undefined;

    return frame.__readyPromise;
  }

  function destroyHtmlFrame(layer) {
    var frame = layer.__frame;
    if (!frame) return;
    layer.__frame = null;
    layer.__lastSeek = undefined;
    layer.style.display = 'none';
    try { frame.srcdoc = ''; } catch (_) {}
    if (frame.parentNode) frame.parentNode.removeChild(frame);
  }

  function mapHtmlTime(layer, elapsed) {
    var duration = layer.__dur;
    var sourceIn = Math.max(0, number(layer.dataset.sourceIn, 0));

    if (layer.dataset.fit !== '1') return sourceIn + elapsed;

    var sourceOut = Math.max(sourceIn, number(layer.dataset.sourceOut, sourceIn + duration));
    return sourceIn + (sourceOut - sourceIn) * clamp(elapsed / duration, 0, 1);
  }

  function inWindow(layer, time) {
    return time >= layer.__start - PRELOAD_S && time < layer.__end + KEEP_S;
  }

  // Monta/desmonta iframes conforme a janela de tempo e devolve a Promise de
  // prontidão das camadas que precisam estar visíveis em "time".
  function prepare(time) {
    var waits = [];
    for (var i = 0; i < htmlLayers.length; i++) {
      var layer = htmlLayers[i];
      if (inWindow(layer, time)) {
        var p = createHtmlFrame(layer);
        if (time >= layer.__start && time < layer.__end && !layer.__frame.__ready) {
          waits.push(p);
        }
      } else if (layer.__frame) {
        destroyHtmlFrame(layer);
      }
    }
    return waits.length ? Promise.all(waits) : null;
  }

  // ── Render principal: estado completo é função de time ──────
  function renderAt(time) {
    time = clamp(number(time, 0), 0, TOTAL);

    for (var i = 0; i < layers.length; i++) {
      var layer  = layers[i];
      var active = time >= layer.__start && time < layer.__end;
      var type   = layer.dataset.type;

      if (type === 'html') {
        if (!layer.__frame) {
          layer.style.display = 'none';
          continue;
        }
        layer.style.display = '';
        layer.style.visibility = active ? '' : 'hidden';

        // Inativa: fica posicionada no limite (0 antes, fim depois) para o
        // primeiro frame visível já sair certo; só re-seek se mudou.
        var local  = clamp(time - layer.__start, 0, layer.__dur);
        var mapped = mapHtmlTime(layer, local);
        if (active || layer.__lastSeek !== mapped || !layer.__frame.__ready) {
          seekHtml(layer.__frame, mapped);
          if (layer.__frame.__ready) layer.__lastSeek = mapped;
        }
        continue;
      }

      layer.style.display = active ? '' : 'none';
      if (type === 'text' && active) renderText(layer, time - layer.__start);
    }
  }

  // ── Prontidão inicial: vídeos, fontes do pai e iframes do início ──
  var mediaReady = Array.prototype.slice.call(document.querySelectorAll('video'))
    .map(function (video) {
      if (video.readyState >= 1) return Promise.resolve();
      return new Promise(function (resolve) {
        var done = function () { resolve(); };
        video.addEventListener('loadedmetadata', done, { once: true });
        video.addEventListener('error', done, { once: true });
        later(done, 10000);
      });
    });

  var ready = Promise.all(
    [document.fonts ? document.fonts.ready : Promise.resolve(), prepare(0)]
      .concat(mediaReady)
  ).catch(function () {});

  // Contrato Motion exposto pela cena composta (o WVC/editor pode usar)
  window.Motion = {
    config: {
      durationInSeconds: TOTAL,
      fps: FPS,
      totalFrames: Math.round(TOTAL * FPS),
    },
    whenReady: function () { return ready; },
    seek: function (time) {
      var p = prepare(clamp(number(time, 0), 0, TOTAL));
      renderAt(time);
      return p ? p.then(function () { renderAt(time); }) : Promise.resolve();
    },
    renderFrame: function (f) { return window.Motion.seek(f / FPS); },
  };

  // ── Integração com o WVC ────────────────────────────────────
  // Renderiza de forma síncrona logo antes de cada captura, no tempo exato do
  // frame (frameIndex / fps) — o mesmo instante em que o WVC posiciona os
  // vídeos. Se alguma camada visível ainda não está pronta, a captura espera.
  var ctx = window.captureCtx;
  var hooked = false;

  if (ctx && typeof window.____captureFrame === 'function') {
    var originalCapture = window.____captureFrame;
    window.____captureFrame = function () {
      var self = this;
      var args = arguments;
      var time = number(ctx.frameIndex, 0) / FPS;
      var pending = prepare(time);
      var capture = function () {
        renderAt(time);
        // Pré-carrega o que vem a seguir sem bloquear este frame
        prepare(time + 1 / FPS);
        return originalCapture.apply(self, args);
      };
      return pending ? pending.then(capture) : capture();
    };

    // Não deixa a captura começar antes dos iframes iniciais.
    if (typeof ctx.start === 'function') {
      var originalStart = ctx.start;
      ctx.start = function () {
        var self = this;
        var args = arguments;
        ready.then(function () {
          renderAt(0);
          originalStart.apply(self, args);
        });
      };
    }

    // O WVC também pausa/avança via CDP as animações CSS que encontra
    // (inclusive dentro dos iframes), com o relógio dele. Os templates já
    // controlam as próprias animações em Motion.seek (animation-delay
    // negativo + paused), e as camadas sem Motion são posicionadas acima via
    // getAnimations() — o seek do WVC por cima só desalinharia.
    if (typeof window.____seekCSSAnimations === 'function') {
      window.____seekCSSAnimations = function () { return Promise.resolve(); };
    }

    hooked = true;
  }

  ready.then(function () {
    renderAt(0);
    if (hooked) return;

    // Fora do WVC (ex.: abrir a cena no navegador): relógio real via rAF.
    var origin = null;
    function loop() {
      var now = performance.now();
      if (origin === null) origin = now;
      var t = (now - origin) / 1000;
      if (!(t >= 0)) t = 0;
      prepare(t);
      renderAt(t);
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
})();
<\/script>`;
}
 
module.exports = { buildSceneRuntimeScript };

// #endregion

// #region Inline de assets locais e fontes
/**
 * Substitui src/href relativos de imagens por data URIs base64
 * e reescreve @import de Google Fonts para que o headless browser
 * consiga buscar corretamente.
 *
 * @param {string} html        HTML original da cena
 * @param {string} projectRoot Caminho absoluto da raiz do projeto
 *                             (onde ficam logo.png, etc.)
 */
function inlineLocalAssets(html, projectRoot) {
  // ── 1. Imagens: <img src="...">, url("...") em style ──────────────────────
  // Captura qualquer src/href/url() que NÃO comece com http(s), data:, // ou #
  const ASSET_RE = /(?:src|href)=["'](?!https?:\/\/|data:|\/\/|#)([^"'?#]+\.(png|jpe?g|gif|webp|svg|ico|avif))["']/gi;
  const URL_RE   = /url\(["']?(?!https?:\/\/|data:|\/\/|#)([^"')]+\.(png|jpe?g|gif|webp|svg|ico|avif))["']?\)/gi;

  const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    ico: 'image/x-icon', avif: 'image/avif',
  };

  function toDataURI(relPath) {
    const root = projectRoot;
    // Normaliza: remove ./ inicial, ../ é resolvido pelo path.resolve
    const clean = relPath.replace(/^\.\//, '');
    
    // Tenta caminhos em ordem:
    //   1. Como está (relativo à raiz do projeto)
    //   2. Dentro de assets/ (caso template esqueceu o prefixo)
    const candidates = [
      path.resolve(root, clean),
      path.resolve(root, 'assets', path.basename(clean)),
    ];
  
    for (const abs of candidates) {
      if (fs.existsSync(abs)) {
        const ext  = path.extname(abs).slice(1).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const b64  = fs.readFileSync(abs).toString('base64');
        if (abs !== candidates[0]) {
          console.log(`[WVC] Asset resolvido via fallback assets/: ${relPath} → ${abs}`);
        }
        return `data:${mime};base64,${b64}`;
      }
    }
  
    console.warn(`[WVC] Asset não encontrado: ${relPath}`);
    console.warn(`[WVC]   Tentou: ${candidates.join(', ')}`);
    return null;
  }

  html = html.replace(ASSET_RE, (match, relPath) => {
    const uri = toDataURI(relPath);
    return uri ? match.replace(relPath, uri) : match;
  });

  html = html.replace(URL_RE, (match, relPath) => {
    const uri = toDataURI(relPath);
    return uri ? match.replace(relPath, uri) : match;
  });

  // ── 2. Google Fonts — problema: headless sem acesso à internet ────────────
  //
  // O Chromium headless do WVC roda em sandbox e frequentemente falha em
  // resolver DNS / fazer requests externos, especialmente Google Fonts.
  //
  // Estratégia: substitui @import do Google Fonts pela versão com
  // display=swap e adiciona um preconnect, que aumenta a chance de resolver.
  // Para 100% de garantia use a Solução B (download local das fontes).
  //
  // Substitui tanto <link> quanto @import do Google Fonts adicionando
  // &display=swap se não tiver, e troca fonts.googleapis.com por
  // fonts.googleapis.com (keep) — o fix real é o preconnect abaixo.
  const GF_LINK_RE = /<link[^>]+href=["'](https:\/\/fonts\.googleapis\.com\/css[^"']*)["'][^>]*>/gi;
  const GF_IMPORT_RE = /@import\s+url\(["']?(https:\/\/fonts\.googleapis\.com\/css[^"')]+)["']?\)\s*;/gi;

  function patchGFUrl(url) {
    if (!url.includes('display=')) url += (url.includes('?') ? '&' : '?') + 'display=swap';
    return url;
  }

  // Adiciona preconnects antes do </head> se houver Google Fonts
  const hasGF = GF_LINK_RE.test(html) || GF_IMPORT_RE.test(html);
  GF_LINK_RE.lastIndex = 0;
  GF_IMPORT_RE.lastIndex = 0;

  html = html.replace(GF_LINK_RE, (match, url) =>
    match.replace(url, patchGFUrl(url))
  );
  html = html.replace(GF_IMPORT_RE, (match, url) =>
    match.replace(url, patchGFUrl(url))
  );

  if (hasGF) {
    const preconnects = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`;
    html = html.replace('<head>', '<head>' + preconnects);
  }

  return html;
}
// #endregion

async function testSingleLayer(jobId, clip, opts) {
  const { fps, width, height } = opts;
  const { wvc } = await getWVC();
  const port = await ensureInternalServer();
  const root = getProjectRoot();

  const tmpDir = path.join(os.tmpdir(), `mstudio-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  jobMediaDirs.set(jobId, tmpDir);

  const full = inlineLocalAssets(clip.html, root);

  const selfDriver = `
<script>
(function(){
  var inited = false, t0 = null;
  function loop(){
    var M = window.Motion || window.MotionAPI;
    if (M){
      if (!inited && typeof M.init === 'function'){ inited = true; try{ M.init(); }catch(e){} }
      if (t0 === null) t0 = performance.now();
      var t = (performance.now() - t0) / 1000;   // relógio VIRTUAL do WVC
      if (!(t >= 0)) t = 0;
      try {
        if (typeof M.seek === 'function') M.seek(t);
        else if (typeof M.renderFrame === 'function') {
          var MFPS = (M.config && M.config.fps) || 60;
          M.renderFrame(Math.round(t * MFPS));
        }
      } catch(e){}
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
<\/script>`;

  const full2 = full.includes('</body>')
    ? full.replace('</body>', selfDriver + '</body>')
    : full + selfDriver;

  sceneStore.set(`${jobId}_0`, full2);

  const outputPath = path.join(tmpDir, `output.mp4`);
  const dur = Math.round((clip.duration || 5) * 1000);

  const video = wvc.createSingleVideo({
    url: `http://127.0.0.1:${port}/job/${jobId}/scene-0.html`,
    width, height, fps,
    duration: dur,
    outputPath,
    showProgress: true,
    startTime: 0,
    timeout: 10 * 60 * 1000,
  });

  await new Promise((resolve, reject) => {
    video.once('completed', r => { console.log(`[TESTE] RTF=${r?.rtf} took=${r?.takes}ms`); resolve(); });
    video.once('error', reject);
    video.start();
  });

  console.log(`[TESTE] Vídeo isolado em: ${outputPath}`);
  finalizeJob(jobId, outputPath);
}

async function materializeMediaForJob(
  jobId,
  clips,
  tmpDir,
  internalPort
) {
  const dataUriPattern =
    /^data:([^;,]+)(;base64)?,([\s\S]*)$/;

  for (
    let index = 0;
    index < clips.length;
    index++
  ) {
    const clip =
      clips[index];

    if (
      clip.type !== 'video' &&
      clip.type !== 'image' &&
      clip.type !== 'audio'
    ) {
      continue;
    }

    let mimeType =
      clip.mimeType || null;

    let uploadedPath = null;

    if (clip.uploadId) {
      const upload =
        exportMediaUploads.get(
          clip.uploadId
        );

      if (!upload) {
        throw new Error(
          `Upload expirado ou inválido para "${clip.label}".`
        );
      }

      uploadedPath =
        upload.filePath;

      mimeType =
        mimeType ||
        upload.mimeType;

      exportMediaUploads.delete(
        clip.uploadId
      );
    }

    const dataUriMatch =
      !uploadedPath &&
      typeof clip.dataUrl === 'string'
        ? dataUriPattern.exec(
            clip.dataUrl
          )
        : null;

    const extension =
      extensionForMime(
        mimeType ||
        dataUriMatch?.[1],

        clip.type === 'video'
          ? 'mp4'
          : clip.type === 'audio'
            ? 'mp3'
            : 'png'
      );

    const fileName =
      `clip-${index}.${extension}`;

    const destination =
      path.join(
        tmpDir,
        fileName
      );

    if (uploadedPath) {
      try {
        fs.linkSync(
          uploadedPath,
          destination
        );
      } catch (_) {
        fs.copyFileSync(
          uploadedPath,
          destination
        );
      }

      fs.rmSync(
        uploadedPath,
        { force: true }
      );
    } else if (dataUriMatch) {
      const buffer =
        dataUriMatch[2]
          ? Buffer.from(
              dataUriMatch[3],
              'base64'
            )
          : Buffer.from(
              decodeURIComponent(
                dataUriMatch[3]
              ),
              'utf8'
            );

      fs.writeFileSync(
        destination,
        buffer
      );
    } else if (
      typeof clip.dataUrl ===
        'string' &&
      /^https?:\/\//i.test(
        clip.dataUrl
      )
    ) {
      if (clip.type !== 'image') {
        clip._audioPath =
          clip.dataUrl;
      }

      continue;
    } else {
      throw new Error(
        `Mídia ausente para "${clip.label}".`
      );
    }

    clip.dataUrl =
      `http://127.0.0.1:${internalPort}` +
      `/job/${jobId}/media/${fileName}`;

    if (clip.type !== 'image') {
      clip._audioPath =
        destination;
    }
  }
}

function finiteNumber(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeCssValue(
  value,
  fallback = ''
) {
  const text =
    String(value ?? fallback)
      .replace(/[;{}<>]/g, '')
      .trim();

  return text || fallback;
}

function getFfmpegBinary() {
  try {
    return (
      process.env.FFMPEG_PATH ||
      require('ffmpeg-static') ||
      'ffmpeg'
    );
  } catch (_) {
    return (
      process.env.FFMPEG_PATH ||
      'ffmpeg'
    );
  }
}
// Shutdown gracioso
async function shutdown() {
  if (_internalServer) {
    await new Promise(r => _internalServer.close(r));
  }
  if (_wvcPromise) {
    const { wvc } = await _wvcPromise;
    if (wvc.destroy) await wvc.destroy();
  }
}
process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
process.on('SIGINT',  () => shutdown().then(() => process.exit(0)));

// #region Audio Mixing

/** Localiza o binário ffmpeg — primeiro tenta o bundled do WVC, depois o do sistema */
async function getFfmpegBin() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * Detecta o melhor encoder H.264 REALMENTE funcional na máquina,
 * fazendo um encode-teste de 0.2s. Listar com `-encoders` não basta:
 * h264_nvenc aparece listado mesmo sem GPU e falha em runtime.
 * Ganho típico sobre libx264: NVENC 5–10×, QSV/AMF/VideoToolbox 3–6×.
 */
let _encoderProbe = null;
async function detectBestEncoder() {
  if (_encoderProbe) return _encoderProbe;
  _encoderProbe = (async () => {
    const ffmpeg = await getFfmpegBin();
    const candidates = [
      'h264_nvenc',         // NVIDIA
      'h264_qsv',           // Intel QuickSync
      'h264_amf',           // AMD
      'h264_videotoolbox',  // macOS
    ];
    for (const enc of candidates) {
      const ok = await new Promise(resolve => {
        execFile(ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2:r=30',
          '-c:v', enc, '-f', 'null', '-',
        ], { timeout: 15000 }, err => resolve(!err));
      });
      if (ok) {
        console.log(`[WVC] ✅ Encoder de hardware detectado: ${enc}`);
        return enc;
      }
    }
    console.log('[WVC] Nenhum encoder de hardware disponível — usando libx264 (CPU).');
    return 'libx264';
  })();
  return _encoderProbe;
}

function probeAudio(ffmpegBin, filePath) {
  return new Promise(resolve => {
    execFile(ffmpegBin, ['-hide_banner', '-i', filePath],
      { timeout: 8000 },
      // ffmpeg -i sem output sai com erro, mas o stderr lista os streams
      (_err, _stdout, stderr) => resolve(/Stream #\d+:\d+.*Audio:/.test(stderr || ''))
    );
  });
}

async function mixAudioTracks(
  soundClips,
  outputPath,
  format = 'mp4'
) {
  let inputs =
    soundClips
      .map(clip => ({
        clip,

        source:
          clip._audioPath ||
          clip.dataUrl,
      }))
      .filter(item => {
        if (
          typeof item.source !==
          'string'
        ) {
          return false;
        }

        return (
          /^https?:\/\//i.test(
            item.source
          ) ||
          fs.existsSync(
            item.source
          )
        );
      });

  if (!inputs.length) {
    return;
  }

  // Vídeo sem faixa de áudio derrubaria o filtro [n:a:0] e a mixagem inteira
  const hasAudio = await Promise.all(
    inputs.map(item => probeAudio(getFfmpegBinary(), item.source))
  );
  inputs = inputs.filter((_, index) => hasAudio[index]);

  if (!inputs.length) {
    return;
  }

  const extension =
    format === 'webm'
      ? 'webm'
      : 'mp4';

  const temporaryPath =
    path.join(
      path.dirname(outputPath),
      `audio-${Date.now()}.${extension}`
    );

  const args = [
    '-y',
    '-i',
    outputPath,
  ];

  inputs.forEach(item => {
    args.push(
      '-i',
      item.source
    );
  });

  const filters = [];
  const labels = [];

  inputs.forEach(
    (item, index) => {
      const inputIndex =
        index + 1;

      const trimStart =
        Math.max(
          0,
          finiteNumber(
            item.clip.trimStart
          )
        );

      const duration =
        Math.max(
          0.001,
          finiteNumber(
            item.clip.duration,
            1
          )
        );

      const delay =
        Math.max(
          0,
          Math.round(
            finiteNumber(
              item.clip.start
            ) * 1000
          )
        );

      const label =
        `audio${index}`;

      // Volume e fades do clip (mesmos valores do preview)
      const volume  = Math.max(0, Math.min(1, finiteNumber(item.clip.volume, 1)));
      const fadeIn  = Math.min(duration / 2, Math.max(0, finiteNumber(item.clip.fadeIn)));
      const fadeOut = Math.min(duration / 2, Math.max(0, finiteNumber(item.clip.fadeOut)));
      const shaping =
        (volume < 1 ? `volume=${volume.toFixed(3)},` : '') +
        (fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn.toFixed(3)},` : '') +
        (fadeOut > 0 ? `afade=t=out:st=${(duration - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)},` : '');

      filters.push(
        `[${inputIndex}:a:0]` +
        `atrim=start=${trimStart}:duration=${duration},` +
        `asetpts=PTS-STARTPTS,` +
        shaping +
        `aresample=async=1:first_pts=0,` +
        `adelay=${delay}:all=1` +
        `[${label}]`
      );

      labels.push(
        `[${label}]`
      );
    }
  );

  const totalDuration =
    Math.max(
      ...inputs.map(item =>
        finiteNumber(
          item.clip.start
        ) +
        Math.max(
          0,
          finiteNumber(
            item.clip.duration
          )
        )
      )
    );

  filters.push(
    `${labels.join('')}` +
    `amix=inputs=${labels.length}:` +
    `duration=longest:` +
    `dropout_transition=0:` +
    // Sem isto o amix divide cada entrada por N: música + voz saíam a −6 dB
    `normalize=0,` +
    // Soma de várias fontes pode passar de 0 dBFS: limitador só nos picos
    `alimiter=limit=0.97:level=0:latency=1,` +
    `atrim=0:${Math.max(
      0.001,
      totalDuration
    )}` +
    `[mixedAudio]`
  );

  args.push(
    '-filter_complex',
    filters.join(';'),

    '-map',
    '0:v:0',

    '-map',
    '[mixedAudio]',

    '-c:v',
    'copy'
  );

  if (extension === 'webm') {
    args.push(
      '-c:a',
      'libopus',

      '-b:a',
      '192k'
    );
  } else {
    args.push(
      '-c:a',
      'aac',

      '-b:a',
      '320k',

      '-movflags',
      '+faststart'
    );
  }

  args.push(
    '-shortest',
    temporaryPath
  );

  await execFileAsync(
    getFfmpegBinary(),
    args
  );

  fs.rmSync(
    outputPath,
    { force: true }
  );

  fs.renameSync(
    temporaryPath,
    outputPath
  );
}

function buildFullScene(
  clips,
  width,
  height,
  projectRoot,
  projectRes,
  fps
) {
  // Áudio não tem camada visual: entra só na mixagem final
  const orderedClips =
    clips.filter(clip => clip.type !== 'audio').sort(
      (first, second) =>
        finiteNumber(
          first.trackIndex
        ) -
          finiteNumber(
            second.trackIndex
          ) ||
        finiteNumber(
          first.start
        ) -
          finiteNumber(
            second.start
          )
    );

  const layers =
    orderedClips
      .map(clip => {
        /*
         * Textos com HTML do template (o mesmo do preview) seguem o
         * caminho das camadas HTML. O renderizador genérico de texto
         * fica só como fallback quando o frontend não mandou html.
         */
        if (
          clip.isText &&
          !clip.html &&
          clip.textParams
        ) {
          return buildTextLayerHtmlGlobal(
            clip,
            width,
            height,
            projectRes
          );
        }

        if (clip.type === 'html') {
          return buildHtmlLayerHtmlGlobal(
            clip,
            width,
            height,
            projectRoot,
            projectRes
          );
        }

        return buildMediaLayerHtmlGlobal(
          clip,
          width,
          height,
          projectRes
        );
      })
      .join('\n');

  const totalDuration =
    clips.reduce(
      (maximum, clip) =>
        Math.max(
          maximum,
          finiteNumber(
            clip.start
          ) +
          Math.max(
            0,
            finiteNumber(
              clip.duration
            )
          )
        ),
      0
    );

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: #000;
}

#__ms_stage {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
}

.__ms_html_host iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}
</style>
</head>
<body>
<div id="__ms_stage">
${layers}
</div>
${buildSceneRuntimeScript(
  totalDuration,
  fps
)}
</body>
</html>`;
}

function execFileAsync(
  file,
  args,
  options = {}
) {
  return new Promise(
    (resolve, reject) => {
      execFile(
        file,
        args,
        {
          windowsHide: true,
          maxBuffer:
            16 * 1024 * 1024,
          ...options,
        },
        (
          error,
          stdout,
          stderr
        ) => {
          if (error) {
            if (stderr) {
              error.message +=
                '\n' +
                stderr.slice(-8000);
            }

            reject(error);
            return;
          }

          resolve({
            stdout,
            stderr,
          });
        }
      );
    }
  );
}
// #endregion


module.exports = {
  createJob, getJob, updateJob, finalizeJob, failJob,
  downloadJob, renderJob,
  setProjectRoot,
  encodeSceneFrames:  () => { throw new Error('Pipeline migrado para WVC — encodeSceneFrames removido'); },
  concatenateVideos:  () => { throw new Error('Pipeline migrado para WVC — concat é interno ao WVC'); },
  cleanupJob,
  registerExportMediaRoutes
};
