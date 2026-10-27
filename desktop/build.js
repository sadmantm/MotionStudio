'use strict';
// desktop/build.js
//
//  Gera o app desktop (launcher + Firefox) para macOS e Windows:
//
//    npm run desktop:build                         → mac-x64, mac-arm64 e win-x64
//    npm run desktop:build -- --target win-x64     → só um alvo
//    opções: --no-python  --no-zip
//
//  Saída em dist/:
//    mac-<arch>/Motion Studio.app   (Contents/MacOS/Motion Studio + Resources/app)
//    win-x64/Motion Studio/          (Motion Studio.exe + resources/app)
//    Motion-Studio-<alvo>.zip
//
//  Cada alvo leva: launcher (Node SEA), servidor + node_modules, ffmpeg/ffprobe
//  da plataforma, Chrome do export (web-video-creator) e um Python 3.12 para o
//  Whisper. O Firefox NÃO é embutido: o launcher usa o instalado no sistema.
//  Downloads ficam em cache em desktop/.cache.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');
const cp   = require('child_process');
const { pipeline } = require('stream/promises');

const ROOT      = path.resolve(__dirname, '..');
const DIST      = path.join(ROOT, 'dist');
const CACHE     = path.join(__dirname, '.cache');
const APP_NAME  = 'Motion Studio';
const BUNDLE_ID = 'com.netvale.motionstudio';
const VERSION   = require(path.join(ROOT, 'package.json')).version || '1.0.0';
const NODE_VER  = process.version;              // o blob SEA precisa da MESMA versão do Node
const CHROME_BUILD = '119.0.6029.0';            // versão fixada pelo web-video-creator
const FFMPEG_RELEASE = 'b6.1.1';                // ffmpeg-static
const PYTHON_MINOR = '3.12';                    // há wheels do CTranslate2 para os 3 alvos
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const TARGETS = {
  'mac-x64':   { os: 'mac', arch: 'x64',   node: 'darwin-x64',  ffmpeg: 'darwin-x64',  probe: ['darwin', 'x64'],   chrome: 'mac',     python: 'x86_64-apple-darwin' },
  'mac-arm64': { os: 'mac', arch: 'arm64', node: 'darwin-arm64', ffmpeg: 'darwin-arm64', probe: ['darwin', 'arm64'], chrome: 'mac_arm', python: 'aarch64-apple-darwin' },
  'win-x64':   { os: 'win', arch: 'x64',   node: 'win-x64',     ffmpeg: 'win32-x64',   probe: ['win32', 'x64'],    chrome: 'win64',   python: 'x86_64-pc-windows-msvc' },
};

// Arquivos do projeto que vão no app (o resto — models/, venv, config com a
// chave da IA, tmp/, dist/ — fica de fora)
const APP_ENTRIES = ['index.js', 'exporter.js', 'package.json', 'Interface', 'libs', 'templates', 'text-templates', 'fonts', 'assets', 'logo.png', 'logoplus.png', 'Icon.png'];
const SKIP_NAMES  = new Set(['.DS_Store', 'Thumbs.db', '__pycache__']);

const IS_MAC_HOST = process.platform === 'darwin';

// #region Utilidades
const log = (...a) => console.log('[build]', ...a);

function run(cmd, args, opts = {}) {
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} → código ${r.status}`);
}

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

function copy(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    verbatimSymlinks: true,           // Chrome.app e Python usam symlinks
    filter: s => !SKIP_NAMES.has(path.basename(s)),
  });
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function extractTar(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  run('tar', ['-xzf', file, '-C', destDir]);   // tar existe no macOS e no Windows 10+
}

function dirSize(p) {
  let total = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(f); else total += fs.statSync(f).size;
    }
  };
  walk(p);
  return total;
}
// #endregion

// #region Componentes por plataforma
/** Binário do Node da plataforma alvo (mesma versão do Node que roda o build) */
async function nodeBinary(t) {
  const dir = path.join(CACHE, `node-${NODE_VER}-${t.node}`);
  if (t.os === 'win') {
    return download(`https://nodejs.org/dist/${NODE_VER}/${t.node}/node.exe`, path.join(dir, 'node.exe'));
  }
  const bin = path.join(dir, 'bin', 'node');
  if (fs.existsSync(bin)) return bin;
  const tgz = await download(`https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-${t.node}.tar.gz`, path.join(CACHE, `node-${NODE_VER}-${t.node}.tar.gz`));
  extractTar(tgz, CACHE);
  fs.renameSync(path.join(CACHE, `node-${NODE_VER}-${t.node}`), dir + '.tmp');
  fs.renameSync(dir + '.tmp', dir);
  return bin;
}

/** ffmpeg da plataforma (o de node_modules é o da máquina que instalou) */
async function ffmpegBinary(t) {
  const hostKey = `${process.platform}-${process.arch}`;
  const local = path.join(ROOT, 'node_modules', 'ffmpeg-static', t.os === 'win' ? 'ffmpeg.exe' : 'ffmpeg');
  if (hostKey === t.ffmpeg && fs.existsSync(local)) return local;
  const out = path.join(CACHE, `ffmpeg-${FFMPEG_RELEASE}-${t.ffmpeg}`, t.os === 'win' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(out)) return out;
  const gz = await download(
    `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/ffmpeg-${t.ffmpeg}.gz`,
    path.join(CACHE, `ffmpeg-${FFMPEG_RELEASE}-${t.ffmpeg}.gz`)
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await pipeline(fs.createReadStream(gz), zlib.createGunzip(), fs.createWriteStream(out));
  fs.chmodSync(out, 0o755);
  return out;
}

/** Chrome do web-video-creator: usa o .bin do projeto ou baixa para o cache */
async function chromeDir(t) {
  const name = `${t.chrome}-${CHROME_BUILD}`;
  const local = path.join(ROOT, '.bin', 'chrome', name);
  if (fs.existsSync(local)) return local;
  const cached = path.join(CACHE, 'chrome', 'chrome', name);
  if (fs.existsSync(cached)) return cached;
  log(`baixando Chrome ${CHROME_BUILD} (${t.chrome})…`);
  const { install } = require(path.join(ROOT, 'node_modules', '@puppeteer', 'browsers'));
  await install({ cacheDir: path.join(CACHE, 'chrome'), browser: 'chrome', platform: t.chrome, buildId: CHROME_BUILD });
  return cached;
}

/** Python 3.12 portátil (python-build-standalone, "install_only") */
async function pythonArchive(t) {
  const meta = path.join(CACHE, `python-${t.python}.json`);
  let asset = fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')) : null;
  if (!asset) {
    const res = await fetch('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', {
      headers: { 'user-agent': 'motion-studio-build', accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} (python-build-standalone)`);
    const release = await res.json();
    const re = new RegExp(`^cpython-${PYTHON_MINOR.replace('.', '\\.')}\\.\\d+\\+\\d+-${t.python}-install_only\\.tar\\.gz$`);
    const found = release.assets.find(a => re.test(a.name));
    if (!found) throw new Error(`Python ${PYTHON_MINOR} para ${t.python} não encontrado no release ${release.tag_name}`);
    asset = { name: found.name, url: found.browser_download_url };
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(meta, JSON.stringify(asset));
  }
  return download(asset.url, path.join(CACHE, asset.name));
}
// #endregion

// #region App (servidor + node_modules)
async function stageApp(t, appDir) {
  log('copiando o app…');
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of APP_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (fs.existsSync(src)) copy(src, path.join(appDir, entry));
  }

  log('copiando node_modules…');
  const nm = path.join(appDir, 'node_modules');
  fs.cpSync(path.join(ROOT, 'node_modules'), nm, {
    recursive: true,
    verbatimSymlinks: true,
    filter: s => {
      const rel = path.relative(path.join(ROOT, 'node_modules'), s).split(path.sep);
      if (SKIP_NAMES.has(rel[rel.length - 1])) return false;
      // Ferramentas de build não vão no app
      if (['postject', 'resedit', 'pe-library', '.cache'].includes(rel[0])) return false;
      // ffprobe-static traz todas as plataformas: fica só a do alvo
      if (rel[0] === 'ffprobe-static' && rel[1] === 'bin' && rel.length >= 3) {
        if (rel[2] !== t.probe[0]) return false;
        if (rel.length >= 4 && rel[3] !== t.probe[1]) return false;
      }
      // ffmpeg-static: o binário da plataforma entra abaixo
      if (rel[0] === 'ffmpeg-static' && /^ffmpeg(\.exe)?$/.test(rel[1] || '')) return false;
      return true;
    },
  });
  const ffmpeg = await ffmpegBinary(t);
  fs.copyFileSync(ffmpeg, path.join(nm, 'ffmpeg-static', path.basename(ffmpeg)));
  fs.chmodSync(path.join(nm, 'ffmpeg-static', path.basename(ffmpeg)), 0o755);

  log('copiando o Chrome do export…');
  copy(await chromeDir(t), path.join(appDir, '.bin', 'chrome', `${t.chrome}-${CHROME_BUILD}`));

  if (!opts.noPython) {
    log(`extraindo Python ${PYTHON_MINOR}…`);
    const runtime = path.join(appDir, 'runtime');
    extractTar(await pythonArchive(t), runtime);   // cria runtime/python
  }
}
// #endregion

// #region Launcher (Node SEA)
const blobs = new Map();

/** O blob independe da plataforma (sem code cache/snapshot): gera uma vez por main */
function seaBlob(main = path.join(__dirname, 'launcher.js')) {
  if (blobs.has(main)) return blobs.get(main);
  fs.mkdirSync(CACHE, { recursive: true });
  const blobPath = path.join(CACHE, `sea-${path.basename(main, '.js')}.blob`);
  const config = path.join(CACHE, `sea-${path.basename(main, '.js')}.json`);
  fs.writeFileSync(config, JSON.stringify({
    main,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }));
  run(process.execPath, ['--experimental-sea-config', config]);
  blobs.set(main, blobPath);
  return blobPath;
}

function postject(exe, extra = [], main = undefined) {
  const bin = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  run(process.execPath, [bin, exe, 'NODE_SEA_BLOB', seaBlob(main), '--sentinel-fuse', SEA_FUSE, ...extra]);
}

/** Confere que o diretório de realocações continua íntegro (o loader do Windows o percorre) */
function assertPeRelocations(exe) {
  const buf = fs.readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  const opt = pe + 24;
  const optSize = buf.readUInt16LE(pe + 20);
  const dataDir = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const relRva = buf.readUInt32LE(dataDir + 5 * 8);
  const relSize = buf.readUInt32LE(dataDir + 5 * 8 + 4);
  const sizeOfImage = buf.readUInt32LE(opt + 56);
  const sections = Array.from({ length: buf.readUInt16LE(pe + 6) }, (_, i) => {
    const s = pe + 24 + optSize + i * 40;
    return { va: buf.readUInt32LE(s + 12), vsize: buf.readUInt32LE(s + 8), raw: buf.readUInt32LE(s + 20), rawSize: buf.readUInt32LE(s + 16) };
  });
  const sec = sections.find(s => relRva >= s.va && relRva < s.va + Math.max(s.vsize, s.rawSize));
  if (!sec) throw new Error('PE inválido: realocações fora das seções');
  let off = sec.raw + (relRva - sec.va);
  const end = off + relSize;
  while (off < end) {
    const page = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > end || page >= sizeOfImage) throw new Error('PE inválido: tabela de realocações corrompida');
    off += size;
  }
}

/** Windows: subsistema GUI (2) em vez de console (3) — sem janela preta ao abrir */
function setWindowsGuiSubsystem(exe) {
  const fd = fs.openSync(exe, 'r+');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0x3c);
    const peOffset = buf.readUInt32LE(0);
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peOffset);
    if (sig.toString('binary') !== 'PE\0\0') throw new Error('assinatura PE inválida');
    const subsystemOffset = peOffset + 4 + 20 + 68;   // optional header + 68
    const value = Buffer.alloc(2);
    value.writeUInt16LE(2);
    fs.writeSync(fd, value, 0, 2, subsystemOffset);
  } finally {
    fs.closeSync(fd);
  }
}

/** PNG quadrado redimensionado do Icon.png: sips no macOS, ffmpeg nos outros */
function resizeIcon(size, out) {
  const src = path.join(ROOT, 'Icon.png');
  if (IS_MAC_HOST) {
    run('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' });
  } else {
    const ffmpeg = require(path.join(ROOT, 'node_modules', 'ffmpeg-static'));
    run(ffmpeg, ['-v', 'error', '-y', '-i', src, '-vf', `scale=${size}:${size}:flags=lanczos`, '-pix_fmt', 'rgba', out], { stdio: 'ignore' });
  }
}

/** .ico com PNGs (256/48/32/16) gerados do Icon.png (refeito se o Icon.png mudar) */
function buildIco() {
  const out = path.join(CACHE, 'icon.ico');
  const srcTime = fs.statSync(path.join(ROOT, 'Icon.png')).mtimeMs;
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcTime) return out;
  fs.mkdirSync(CACHE, { recursive: true });
  const sizes = [256, 48, 32, 16];
  const pngs = sizes.map(size => {
    const f = path.join(CACHE, `icon-${size}.png`);
    resizeIcon(size, f);
    return fs.readFileSync(f);
  });
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);       // planes
    header.writeUInt16LE(32, e + 6);      // bpp
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(out, Buffer.concat([header, ...pngs]));
  return out;
}

/**
 * Ícone e informações de versão no .exe. Roda DEPOIS do postject: o LIEF
 * (dentro do postject) reconstrói o PE e, lendo um binário já reescrito pelo
 * resedit, deixava o diretório de realocações apontando para a seção errada —
 * o Windows não carregaria o executável.
 */
async function brandWindowsExe(exe) {
  const ResEdit = await import('resedit');
  const peExe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(peExe);

  const ico = buildIco();
  if (ico) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
    const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, group ? group.id : 1, group ? group.lang : 1033,
      iconFile.icons.map(i => i.data)
    );
  }

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const [maj, min, pat] = VERSION.split('.').map(n => Number(n) || 0);
    vi.setFileVersion(maj, min, pat, 0, 1033);
    vi.setProductVersion(maj, min, pat, 0, 1033);
    for (const lang of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(lang, {
        ProductName: APP_NAME,
        FileDescription: APP_NAME,
        CompanyName: 'Netvale',
        InternalName: APP_NAME,
        OriginalFilename: `${APP_NAME}.exe`,
        LegalCopyright: '',
        FileVersion: VERSION,
        ProductVersion: VERSION,
      });
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(peExe);
  fs.writeFileSync(exe, Buffer.from(peExe.generate()));
}

async function buildLauncher(t, exe) {
  log('gerando o executável (Node SEA)…');
  fs.copyFileSync(await nodeBinary(t), exe);
  fs.chmodSync(exe, 0o755);
  if (t.os === 'mac') {
    if (IS_MAC_HOST) run('codesign', ['--remove-signature', exe]);
    postject(exe, ['--macho-segment-name', 'NODE_SEA']);
    // Apple Silicon recusa binário sem assinatura: ad-hoc basta para rodar
    if (IS_MAC_HOST) run('codesign', ['--sign', '-', '--force', exe]);
    else log('aviso: build do Mac fora do macOS — assine com "codesign --sign - --force" antes de distribuir');
  } else {
    postject(exe);
    await brandWindowsExe(exe);
    setWindowsGuiSubsystem(exe);
    assertPeRelocations(exe);
  }
}
// #endregion

// #region Empacotamento
function macIcon(resourcesDir) {
  if (!IS_MAC_HOST) return false;
  const iconset = path.join(CACHE, 'AppIcon.iconset');
  if (!fs.existsSync(path.join(CACHE, 'AppIcon.icns'))) {
    rm(iconset);
    fs.mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        run('sips', ['-z', String(px), String(px), path.join(ROOT, 'Icon.png'), '--out', path.join(iconset, name)], { stdio: 'ignore' });
      }
    }
    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(CACHE, 'AppIcon.icns')]);
  }
  fs.copyFileSync(path.join(CACHE, 'AppIcon.icns'), path.join(resourcesDir, 'AppIcon.icns'));
  return true;
}

function infoPlist(hasIcon) {
  const entries = {
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: APP_NAME,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: VERSION,
    LSMinimumSystemVersion: '11.0',
    NSHighResolutionCapable: true,
    // O launcher não tem janela: o editor abre no Firefox (sem ícone extra no Dock)
    LSUIElement: true,
    ...(hasIcon ? { CFBundleIconFile: 'AppIcon' } : {}),
  };
  const xml = Object.entries(entries).map(([k, v]) =>
    `  <key>${k}</key>\n  ${typeof v === 'boolean' ? `<${v}/>` : `<string>${v}</string>`}`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${xml}
</dict>
</plist>
`;
}

const README_MAC = `Motion Studio para macOS
========================

1. Instale o Firefox (https://www.mozilla.org/firefox/) — o editor abre nele.
2. Arraste "Motion Studio.app" para Aplicativos.
3. Na 1ª abertura o macOS avisa que o app não é de um desenvolvedor
   identificado: clique com o botão direito em Motion Studio → Abrir → Abrir
   (ou Ajustes do Sistema → Privacidade e Segurança → "Abrir Mesmo Assim").
   Se preferir pelo Terminal:  xattr -dr com.apple.quarantine "/Applications/Motion Studio.app"

Na 1ª transcrição o app prepara o Whisper (alguns minutos, precisa de internet).
Dados (modelos, chave da IA, logs): ~/Library/Application Support/Motion Studio
`;

const README_WIN = `Motion Studio para Windows
==========================

1. Instale o Firefox (https://www.mozilla.org/firefox/) — o editor abre nele.
2. Extraia esta pasta onde quiser (ex.: C:\\Program Files\\Motion Studio ou Documentos)
   e abra "Motion Studio.exe". Dica: botão direito → Mostrar mais opções →
   Enviar para → Área de trabalho (criar atalho).
3. Se o SmartScreen avisar "O Windows protegeu o computador": Mais informações →
   Executar assim mesmo (o executável não tem assinatura digital).

Na 1ª transcrição o app prepara o Whisper (alguns minutos, precisa de internet).
Dados (modelos, chave da IA, logs): %LOCALAPPDATA%\\Motion Studio
`;

async function buildTarget(name) {
  const t = TARGETS[name];
  const outDir = path.join(DIST, name);
  rm(outDir);
  log(`===== ${name} =====`);

  let appDir, exe, root;
  if (t.os === 'mac') {
    root = path.join(outDir, `${APP_NAME}.app`);
    const contents = path.join(root, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    appDir = path.join(contents, 'Resources', 'app');
    exe = path.join(contents, 'MacOS', APP_NAME);
    const hasIcon = macIcon(path.join(contents, 'Resources'));
    fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist(hasIcon));
    fs.writeFileSync(path.join(outDir, 'LEIA-ME.txt'), README_MAC);
  } else {
    root = path.join(outDir, APP_NAME);
    appDir = path.join(root, 'resources', 'app');
    exe = path.join(root, `${APP_NAME}.exe`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'LEIA-ME.txt'), README_WIN.replace(/\n/g, '\r\n'));
  }

  await stageApp(t, appDir);
  await buildLauncher(t, exe);

  log(`${name}: ${(dirSize(outDir) / 1e6).toFixed(0)} MB em ${path.relative(ROOT, outDir)}`);

  if (!opts.noZip) {
    const zip = path.join(DIST, `Motion-Studio-${VERSION}-${name}.zip`);
    rm(zip);
    log('compactando…');
    if (IS_MAC_HOST) {
      // ditto preserva symlinks e permissões (Chrome.app, Python)
      const items = t.os === 'mac' ? [root, path.join(outDir, 'LEIA-ME.txt')] : [root];
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', items[0], zip]);
      if (items[1]) run('zip', ['-j', '-q', zip, items[1]]);
    } else if (process.platform === 'win32') {
      run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${root}' -DestinationPath '${zip}' -Force`]);
    } else {
      run('zip', ['-r', '-y', '-q', zip, path.basename(root)], { cwd: path.dirname(root) });
    }
    log(`zip: ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
  }
}
// #endregion

let opts = { noPython: false, noZip: true, targets: [] };

module.exports = { ROOT, CACHE, APP_NAME, NODE_VER, IS_MAC_HOST, log, run, rm, postject, brandWindowsExe, setWindowsGuiSubsystem, assertPeRelocations, macIcon, infoPlist };

// #region CLI
if (require.main === module) {
const argv = process.argv.slice(2);
opts = {
  noPython: argv.includes('--no-python'),
  noZip: argv.includes('--no-zip'),
  targets: (() => {
    const i = argv.indexOf('--target');
    const list = i >= 0 ? argv[i + 1].split(',') : Object.keys(TARGETS);
    for (const name of list) if (!TARGETS[name]) throw new Error(`alvo desconhecido: ${name} (use ${Object.keys(TARGETS).join(', ')})`);
    return list;
  })(),
};

(async () => {
  log(`Node ${NODE_VER} · alvos: ${opts.targets.join(', ')}`);
  for (const name of opts.targets) await buildTarget(name);
  log('pronto.');
})().catch(err => {
  console.error('[build] ERRO:', err.message);
  process.exit(1);
});
}
// #endregion
