'use strict';
// desktop/stub.js
//
//  Executável "casca" (Node SEA): não leva o app dentro. Ao abrir, acha a pasta
//  do projeto e roda desktop/launcher.js de lá — editar index.js, Interface/,
//  libs/ ou o próprio launcher vale na próxima abertura, sem rebuild.
//  Só precisa gerar de novo (npm run desktop:stub) ao trocar a versão do Node.
//
//  Pasta do projeto, nesta ordem: MS_APP_DIR → pasta do .exe e as de cima →
//  a pasta onde o .exe foi gerado (gravada no build).

const fs   = require('fs');
const path = require('path');
const { createRequire } = require('module');

const BUILT_FROM = '__MS_PROJECT_DIR__';   // trocado pelo build-stub.js

const isProject = dir => fs.existsSync(path.join(dir, 'desktop', 'launcher.js')) && fs.existsSync(path.join(dir, 'index.js'));

function findProject() {
  const candidates = [];
  if (process.env.MS_APP_DIR) candidates.push(process.env.MS_APP_DIR);
  for (let dir = path.dirname(process.execPath); ; dir = path.dirname(dir)) {
    candidates.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  candidates.push(BUILT_FROM);
  return candidates.map(d => path.resolve(d)).find(isProject) || null;
}

function fail(message) {
  // Sem console (app de janela): avisa numa caixa de diálogo do sistema
  try {
    if (process.platform === 'win32') {
      require('child_process').spawnSync('powershell', ['-NoProfile', '-Command',
        `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${message.replace(/'/g, "''")}', 'Motion Studio')`],
      { windowsHide: true });
    } else if (process.platform === 'darwin') {
      require('child_process').spawnSync('osascript', ['-e', `display alert "Motion Studio" message ${JSON.stringify(message)}`]);
    }
  } catch (_) { /* sem diálogo */ }
  console.error(message);
  process.exit(1);
}

const dir = findProject();
if (!dir) {
  fail('Pasta do Motion Studio não encontrada.\n\nDeixe o "Motion Studio.exe" dentro da pasta do projeto (ou crie um atalho para ele), ou defina a variável MS_APP_DIR.');
}

process.env.MS_APP_DIR = dir;
process.chdir(dir);
const launcher = path.join(dir, 'desktop', 'launcher.js');
// require "de verdade" a partir do projeto: o launcher e o servidor carregam
// node_modules e os próprios arquivos do disco
createRequire(launcher)(launcher);
