'use strict';
// desktop/ffmpeg.js
//
//  FFmpeg/ffprobe estáticos da versão fixada abaixo, por plataforma.
//  O ffmpeg-static (npm) parou no 6.1.1 e o ffprobe-static no 4.0.2: os
//  binários agora vêm de builds estáticos conferidos por sha256.
//
//    node desktop/ffmpeg.js            → baixa para .bin/ffmpeg (máquina atual)
//    node desktop/ffmpeg.js --force    → baixa de novo mesmo se já existir
//    node desktop/ffmpeg.js --optional → falha só avisa (postinstall)
//
//  O desktop/build.js usa fetchFfmpeg() para cada alvo do app.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cp   = require('child_process');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const ROOT    = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, '.bin', 'ffmpeg');
const CACHE   = path.join(__dirname, '.cache');

const FFMPEG_VERSION = '9.0.2';

// macOS Intel: evermeet.cx (mesma origem do build antigo; tem rubberband)
// macOS Apple Silicon: martin-riedl.de (sem rubberband: o tom usa o fallback do audio-fx)
// Windows/Linux: BtbN "gpl" — release de fim de mês, que fica 2 anos no GitHub
const MR    = 'https://ffmpeg.martin-riedl.de/download/macos';
const BTBN  = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08';
const BTBN_NAME = 'ffmpeg-n9.0.2-17-g2a571b6068';

const SOURCES = {
  'darwin-x64': [
    { url: `https://evermeet.cx/ffmpeg/ffmpeg-${FFMPEG_VERSION}.zip`,  sha256: '4acc0be580f9b2788029eb7bd4d645ff87968911b0a62aeeb3940d42d54558d5', files: ['ffmpeg'] },
    { url: `https://evermeet.cx/ffmpeg/ffprobe-${FFMPEG_VERSION}.zip`, sha256: '24a9c968cd4da72d99c7245e914b921815835eb6dff01d99868031aebaf1d439', files: ['ffprobe'] },
  ],
  'darwin-arm64': [
    { url: `${MR}/arm64/1789931890_9.0.2/ffmpeg.zip`,  sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924', files: ['ffmpeg'] },
    { url: `${MR}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6', files: ['ffprobe'] },
  ],
  'win32-x64': [
    { url: `${BTBN}/${BTBN_NAME}-win64-gpl-9.0.zip`, sha256: 'a0e45723c72141975f51d8666302e614711745f3102b704ca3f82c897a58d278', files: ['ffmpeg.exe', 'ffprobe.exe'] },
  ],
  'linux-x64': [
    { url: `${BTBN}/${BTBN_NAME}-linux64-gpl-9.0.tar.xz`, sha256: '68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269', files: ['ffmpeg', 'ffprobe'] },
  ],
  'linux-arm64': [
    { url: `${BTBN}/${BTBN_NAME}-linuxarm64-gpl-9.0.tar.xz`, sha256: '91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46', files: ['ffmpeg', 'ffprobe'] },
  ],
};

const log = (...a) => console.log('[ffmpeg]', ...a);

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log('baixando', url);
  const res = await fetch(url, { headers: { 'user-agent': 'motion-studio-build' } });
  if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
  const tmp = dest + '.part';
  await pipeline(res.body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** zip: tar (bsdtar) no macOS/Windows 10+, unzip no Linux; .tar.xz: tar */
function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zipOnLinux = archive.endsWith('.zip') && process.platform === 'linux';
  const [cmd, args] = zipOnLinux ? ['unzip', ['-q', '-o', archive, '-d', destDir]] : ['tar', ['-xf', archive, '-C', destDir]];
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → código ${r.status}`);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const found = findFile(p, name); if (found) return found; }
  }
  return null;
}

/**
 * Garante ffmpeg e ffprobe do alvo ("darwin-arm64", "win32-x64"…) em destDir.
 * Retorna { ffmpeg, ffprobe } com os caminhos finais.
 */
async function fetchFfmpeg(target, destDir, { force = false } = {}) {
  const sources = SOURCES[target];
  if (!sources) throw new Error(`FFmpeg ${FFMPEG_VERSION}: sem build para ${target}`);
  const exe = target.startsWith('win32') ? '.exe' : '';
  const out = { ffmpeg: path.join(destDir, `ffmpeg${exe}`), ffprobe: path.join(destDir, `ffprobe${exe}`) };
  const stamp = path.join(destDir, 'VERSION');
  const current = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === `${FFMPEG_VERSION} ${target}`;
  if (!force && current && fs.existsSync(out.ffmpeg) && fs.existsSync(out.ffprobe)) return out;

  fs.mkdirSync(destDir, { recursive: true });
  for (const src of sources) {
    const archive = path.join(CACHE, 'ffmpeg', `${FFMPEG_VERSION}-${target}-${path.basename(new URL(src.url).pathname)}`);
    if (force) fs.rmSync(archive, { force: true });
    await download(src.url, archive);
    const hash = sha256(archive);
    if (hash !== src.sha256) {
      fs.rmSync(archive, { force: true });
      throw new Error(`sha256 não confere para ${src.url}\n  esperado ${src.sha256}\n  obtido   ${hash}`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-ffmpeg-'));
    try {
      extract(archive, tmp);
      for (const name of src.files) {
        const found = findFile(tmp, name);
        if (!found) throw new Error(`${name} não encontrado em ${src.url}`);
        fs.copyFileSync(found, path.join(destDir, name));
        fs.chmodSync(path.join(destDir, name), 0o755);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(stamp, `${FFMPEG_VERSION} ${target}\n`);
  return out;
}

module.exports = { FFMPEG_VERSION, SOURCES, fetchFfmpeg };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const optional = argv.includes('--optional');
  const target = `${process.platform}-${process.arch}`;
  fetchFfmpeg(target, BIN_DIR, { force: argv.includes('--force') })
    .then(p => log(`FFmpeg ${FFMPEG_VERSION} pronto em ${path.dirname(p.ffmpeg)}`))
    .catch(err => {
      if (!optional) { console.error('[ffmpeg]', err.message); process.exit(1); }
      console.warn(`[ffmpeg] Aviso: ${err.message}\n[ffmpeg] Usando o ffmpeg-static (6.1). Rode "npm run ffmpeg:update" depois.`);
    });
}
