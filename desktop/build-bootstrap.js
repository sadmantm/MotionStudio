'use strict';
// desktop/build-bootstrap.js
//
//  Compila o "Motion Studio.exe" de Windows (desktop/bootstrap/MotionStudio.cs)
//  com o csc do .NET Framework 4, que vem no Windows: npm run desktop:bootstrap.
//  O .exe (~30 KB) vai no repositório — quem baixa do GitHub só abre ele, e ele
//  instala Node, pacotes, FFmpeg e Python na 1ª vez (ver o .cs).
//  Só precisa compilar de novo ao mudar o .cs ou o Icon.png.

const fs   = require('fs');
const path = require('path');
const B    = require('./build');

const SRC      = path.join(__dirname, 'bootstrap', 'MotionStudio.cs');
const MANIFEST = path.join(__dirname, 'bootstrap', 'app.manifest');
const OUT      = path.join(B.ROOT, `${B.APP_NAME}.exe`);

function findCsc() {
  const win = process.env.WINDIR || 'C:\Windows';
  return ['Framework64', 'Framework']
    .map(dir => path.join(win, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
    .find(p => fs.existsSync(p)) || null;
}

function buildBootstrap() {
  if (process.platform !== 'win32') throw new Error('o bootstrap é só para Windows (no macOS use npm run desktop:stub)');
  const csc = findCsc();
  if (!csc) throw new Error('csc.exe do .NET Framework 4 não encontrado em %WINDIR%\Microsoft.NET');

  let icon = null;
  try { icon = B.buildIco(); } catch (err) { B.log(`sem ícone (${err.message})`); }

  const tmp = path.join(B.CACHE, `${B.APP_NAME}.exe`);
  fs.mkdirSync(B.CACHE, { recursive: true });
  B.log(`compilando ${path.basename(OUT)} (${path.basename(csc)} · .NET Framework 4)…`);
  B.run(csc, [
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/codepage:65001',
    `/out:${tmp}`,
    `/win32manifest:${MANIFEST}`,
    ...(icon ? [`/win32icon:${icon}`] : []),
    '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    SRC,
  ]);
  try {
    fs.copyFileSync(tmp, OUT);
  } catch (err) {
    throw new Error(`não consegui substituir ${path.basename(OUT)} — feche o Motion Studio e rode de novo (${err.code || err.message})`);
  }
  B.log(`pronto: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
  return OUT;
}

module.exports = { buildBootstrap };

if (require.main === module) {
  try {
    buildBootstrap();
  } catch (err) {
    console.error('[build] ERRO:', err.message);
    process.exit(1);
  }
}
