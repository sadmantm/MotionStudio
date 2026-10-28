'use strict';
// desktop/build-stub.js
//
//  Gera o executável "casca" na pasta do projeto (npm run desktop:stub):
//    Windows: Motion Studio.exe      macOS: Motion Studio.app
//  Ele roda desktop/launcher.js direto da pasta do projeto (ver stub.js):
//  atualizar scripts, interface ou servidor NÃO exige gerar de novo. Só rode
//  outra vez ao trocar a versão do Node ou o Icon.png.
//  Para distribuir o app completo (com node_modules, Chrome e Python dentro)
//  continua valendo o npm run desktop:build.

const fs   = require('fs');
const path = require('path');
const B    = require('./build');

const IS_WIN = process.platform === 'win32';

/** stub.js com a pasta do projeto gravada (fallback se o .exe for movido) */
function stubSource() {
  const src = fs.readFileSync(path.join(__dirname, 'stub.js'), 'utf8')
    .replace("'__MS_PROJECT_DIR__'", JSON.stringify(B.ROOT));
  fs.mkdirSync(B.CACHE, { recursive: true });
  const out = path.join(B.CACHE, 'stub.gen.js');
  fs.writeFileSync(out, src);
  return out;
}

async function buildWindows(main) {
  const exe = path.join(B.ROOT, `${B.APP_NAME}.exe`);
  const tmp = path.join(B.CACHE, `${B.APP_NAME}.exe`);
  B.log(`gerando ${path.basename(exe)} (Node ${B.NODE_VER})…`);
  fs.copyFileSync(process.execPath, tmp);   // o próprio node.exe que roda este script
  B.postject(tmp, [], main);
  await B.brandWindowsExe(tmp);
  B.setWindowsGuiSubsystem(tmp);
  B.assertPeRelocations(tmp);
  try {
    fs.copyFileSync(tmp, exe);
  } catch (err) {
    throw new Error(`não consegui substituir ${path.basename(exe)} — feche o Motion Studio e rode de novo (${err.code || err.message})`);
  }
  return exe;
}

function buildMac(main) {
  const app = path.join(B.ROOT, `${B.APP_NAME}.app`);
  const contents = path.join(app, 'Contents');
  const exe = path.join(contents, 'MacOS', B.APP_NAME);
  B.rm(app);
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), B.infoPlist(B.macIcon(path.join(contents, 'Resources'))));
  fs.copyFileSync(process.execPath, exe);
  fs.chmodSync(exe, 0o755);
  B.run('codesign', ['--remove-signature', exe]);
  B.postject(exe, ['--macho-segment-name', 'NODE_SEA'], main);
  B.run('codesign', ['--sign', '-', '--force', exe]);
  return app;
}

(async () => {
  if (!IS_WIN && process.platform !== 'darwin') throw new Error('só Windows e macOS');
  // Windows: o .exe é o bootstrap (instala Node, pacotes e Python sozinho) — ver build-bootstrap.js
  if (IS_WIN) {
    require('./build-bootstrap').buildBootstrap();
    return;
  }
  const main = stubSource();
  const out = IS_WIN ? await buildWindows(main) : buildMac(main);
  B.log(`pronto: ${out}`);
  B.log('crie um atalho dele na Área de Trabalho/Menu Iniciar; atualizações do código valem sem gerar de novo.');
})().catch(err => {
  console.error('[build] ERRO:', err.message);
  process.exit(1);
});
