// ═══════════════════════════════════════════════════════════════════════════
//  FFmpeg do projeto: onde está o binário e como baixar a versão fixada.
//
//  O ffmpeg-static (npm) parou na 6.1.1. O app usa o FFmpeg 9 baixado para
//  <raiz>/.bin/ffmpeg (ffmpeg + ffprobe):
//    Windows/Linux → builds estáticos BtbN (ramo n9.0: recebe os 9.0.x)
//    macOS arm64   → osxexperts.net
//    macOS Intel   → osxexperts.net ainda não tem a 9: fica na 8.0
//
//  Ordem de busca: FFMPEG_PATH/FFPROBE_PATH → .bin/ffmpeg → ffmpeg-static/
//  ffprobe-static → PATH do sistema.
//
//  Instalar/atualizar:  npm run ffmpeg:install   (roda sozinho no npm install)
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pipeline } = require('stream/promises');

const FFMPEG_VERSION = '9.0';
const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, '.bin', 'ffmpeg');
const EXE = process.platform === 'win32' ? '.exe' : '';

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
/** Pacotes por plataforma (`${os}-${arch}` do Node) */
const SOURCES = {
  'win32-x64':   { version: '9.0', archive: `${BTBN}/ffmpeg-n9.0-latest-win64-gpl-9.0.zip` },
  'win32-arm64': { version: '9.0', archive: `${BTBN}/ffmpeg-n9.0-latest-winarm64-gpl-9.0.zip` },
  'linux-x64':   { version: '9.0', archive: `${BTBN}/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz` },
  'linux-arm64': { version: '9.0', archive: `${BTBN}/ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz` },
  'darwin-arm64': { version: '9.0', ffmpeg: 'https://www.osxexperts.net/ffmpeg9arm.zip', ffprobe: 'https://www.osxexperts.net/ffprobe9arm.zip' },
  'darwin-x64':   { version: '8.0', ffmpeg: 'https://www.osxexperts.net/ffmpeg80intel.zip', ffprobe: 'https://www.osxexperts.net/ffprobe80intel.zip' },
};

// #region Caminhos
const exists = p => { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } };

function bundled(name, dir = BIN_DIR) {
  const p = path.join(dir, name + EXE);
  return exists(p) ? p : null;
}

let _ffmpeg = null;
let _ffprobe = null;

/** Binário do ffmpeg a usar (resolvido uma vez) */
function ffmpegPath() {
  if (_ffmpeg) return _ffmpeg;
  let legacy = null;
  try { legacy = require('ffmpeg-static'); } catch (_) { /* opcional */ }
  _ffmpeg = [process.env.FFMPEG_PATH, bundled('ffmpeg'), legacy].find(exists) || 'ffmpeg' + EXE;
  return _ffmpeg;
}

/** Binário do ffprobe a usar */
function ffprobePath() {
  if (_ffprobe) return _ffprobe;
  let legacy = null;
  try { legacy = require('ffprobe-static').path; } catch (_) { /* opcional */ }
  _ffprobe = [process.env.FFPROBE_PATH, bundled('ffprobe'), legacy].find(exists) || 'ffprobe' + EXE;
  return _ffprobe;
}

/** Versão instalada em .bin/ffmpeg (ou null) */
function installedVersion(dir = BIN_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version || null; } catch (_) { return null; }
}

/** "9.0.2" etc. — o que o binário diz de si */
function binaryVersion(bin = ffmpegPath()) {
  try {
    const out = cp.execFileSync(bin, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const m = /version\s+n?([\w.\-]+)/.exec(out);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
// #endregion

// #region Instalação
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: { 'user-agent': 'motion-studio' } });
  if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
  const tmp = dest + '.part';
  await pipeline(res.body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

/** Extrai .zip/.tar.xz com o tar do sistema (bsdtar no Windows 10+ e macOS lê zip) */
function extract(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const zip = /\.zip$/i.test(file);
  const args = zip ? ['-xf', file, '-C', dir] : ['-xJf', file, '-C', dir];
  const r = cp.spawnSync(zip && process.platform === 'linux' ? 'unzip' : 'tar',
    zip && process.platform === 'linux' ? ['-q', '-o', file, '-d', dir] : args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`não consegui extrair ${path.basename(file)}`);
}

/** Procura um arquivo pelo nome dentro de uma pasta extraída */
function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name === name) return p;
  }
  return null;
}

/**
 * Baixa o ffmpeg/ffprobe da plataforma para `dest`.
 * @param {{platform?: string, arch?: string, dest?: string, cache?: string, force?: boolean, log?: Function}} [opts]
 * @returns {Promise<{dir: string, version: string, ffmpeg: string, ffprobe: string}>}
 */
async function install(opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const dest = opts.dest || BIN_DIR;
  const log = opts.log || ((...a) => console.log('[ffmpeg]', ...a));
  const key = `${platform}-${arch}`;
  const src = SOURCES[key];
  if (!src) throw new Error(`Sem FFmpeg ${FFMPEG_VERSION} para ${key}`);

  const exe = platform === 'win32' ? '.exe' : '';
  const result = { dir: dest, version: src.version, ffmpeg: path.join(dest, 'ffmpeg' + exe), ffprobe: path.join(dest, 'ffprobe' + exe) };
  if (!opts.force && installedVersion(dest) === src.version && exists(result.ffmpeg) && exists(result.ffprobe)) return result;

  const cache = opts.cache || path.join(os.tmpdir(), 'motion-studio-ffmpeg');
  const work = path.join(cache, `${key}-${src.version}-${Date.now()}`);
  try {
    const parts = src.archive ? [src.archive] : [src.ffmpeg, src.ffprobe];
    for (const url of parts) {
      log(`baixando FFmpeg ${src.version} (${key}): ${url}`);
      const file = await download(url, path.join(work, path.basename(url)));
      extract(file, path.join(work, 'x'));
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const name of ['ffmpeg', 'ffprobe']) {
      const found = findFile(path.join(work, 'x'), name + exe);
      if (!found) throw new Error(`${name}${exe} não veio no pacote`);
      const out = path.join(dest, name + exe);
      fs.copyFileSync(found, out);
      fs.chmodSync(out, 0o755);
    }
    fs.writeFileSync(path.join(dest, 'version.json'), JSON.stringify({ version: src.version, source: src.archive || src.ffmpeg, installedAt: new Date().toISOString() }, null, 2));
    if (dest === BIN_DIR) { _ffmpeg = null; _ffprobe = null; }
    log(`FFmpeg ${src.version} pronto em ${dest}`);
    return result;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
// #endregion

module.exports = { FFMPEG_VERSION, SOURCES, BIN_DIR, ffmpegPath, ffprobePath, installedVersion, binaryVersion, install };

// node libs/ffmpeg.js [install] [--force] [--soft]
if (require.main === module) {
  const argv = process.argv.slice(2);
  install({ force: argv.includes('--force') })
    .then(r => console.log(`[ffmpeg] ${binaryVersion(r.ffmpeg) || r.version} → ${r.ffmpeg}`))
    .catch(err => {
      console.error('[ffmpeg] falhou:', err.message);
      // --soft (npm install): não derruba a instalação; o app usa o ffmpeg-static até lá
      process.exit(argv.includes('--soft') ? 0 : 1);
    });
}
