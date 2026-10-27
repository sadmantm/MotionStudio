'use strict';
// desktop/launcher.js
//
//  Executável do Motion Studio (macOS e Windows). Vira um binário único com
//  Node SEA (ver desktop/build.js) ou roda direto: `node desktop/launcher.js`.
//
//  1. Prepara a pasta de dados do usuário (modelos, ambiente Python, chave da IA,
//     perfis do navegador, logs) — a pasta do app pode ser somente leitura.
//  2. Sobe o servidor (index.js) dentro deste mesmo processo.
//  3. Abre o editor no Chrome (ou Edge) em modo app, com perfil próprio. A página
//     testa o WebGL: em algumas máquinas ele não funciona no Chrome mas funciona
//     no Firefox — aí o launcher troca para o Firefox e lembra a escolha.
//  4. Quando a última janela do editor fecha, encerra navegador, Whisper e servidor.
//
//  Só usa módulos nativos do Node: o SEA embute um único arquivo.

const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');
const http = require('http');
const cp   = require('child_process');
const { createRequire } = require('module');

const APP_NAME   = 'Motion Studio';
const IS_WIN     = process.platform === 'win32';
const IS_MAC     = process.platform === 'darwin';
const IDLE_GRACE = 5000;    // recarregar a página reconecta bem antes disso
const FIREFOX_DOWNLOAD = 'https://www.mozilla.org/firefox/download/';
const CHROME_DOWNLOAD  = 'https://www.google.com/chrome/';

// #region Caminhos
function isSea() {
  try { return require('node:sea').isSea(); } catch (_) { return false; }
}

/** Pasta com index.js, Interface/, node_modules/… */
function resolveAppDir() {
  if (process.env.MS_APP_DIR) return path.resolve(process.env.MS_APP_DIR);
  if (!isSea()) return path.resolve(__dirname, '..');
  const exeDir = path.dirname(process.execPath);
  // macOS: Motion Studio.app/Contents/MacOS/<exe> → Contents/Resources/app
  // Windows: <pasta>/Motion Studio.exe → <pasta>/resources/app
  return IS_MAC
    ? path.resolve(exeDir, '..', 'Resources', 'app')
    : path.join(exeDir, 'resources', 'app');
}

function resolveDataDir() {
  if (process.env.MS_DATA_DIR) return path.resolve(process.env.MS_DATA_DIR);
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_NAME);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'motion-studio');
}

/** Chrome do export (web-video-creator) empacotado em <app>/.bin/chrome */
function findBundledChrome(appDir) {
  const root = path.join(appDir, '.bin', 'chrome');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return null; }
  const prefix = IS_WIN ? 'win64-' : IS_MAC ? (process.arch === 'arm64' ? 'mac_arm-' : 'mac-') : 'linux-';
  const rel = IS_WIN
    ? ['chrome-win64', 'chrome.exe']
    : IS_MAC
      ? [process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']
      : ['chrome-linux64', 'chrome'];
  for (const dir of dirs.filter(d => d.startsWith(prefix)).sort().reverse()) {
    const exe = path.join(root, dir, ...rel);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** Python embutido (python-build-standalone) para criar o ambiente do Whisper */
function findBundledPython(appDir) {
  const exe = IS_WIN
    ? path.join(appDir, 'runtime', 'python', 'python.exe')
    : path.join(appDir, 'runtime', 'python', 'bin', 'python3');
  return fs.existsSync(exe) ? exe : null;
}
// #endregion

// #region Chrome
function chromeCandidates() {
  const list = [];
  if (process.env.MS_CHROME_BROWSER) list.push(process.env.MS_CHROME_BROWSER);
  if (IS_MAC) {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      list.push(path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      list.push(path.join(base, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
    }
  } else if (IS_WIN) {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    bases.forEach(base => list.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    for (const hive of ['HKLM', 'HKCU']) {
      const out = execText('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve']);
      const m = out.match(/REG_SZ\s+(.+chrome\.exe)/i);
      if (m) list.push(m[1].trim().replace(/^"|"$/g, ''));
    }
    // Edge vem em todo Windows e usa o mesmo motor do Chrome
    bases.forEach(base => list.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return [...new Set(list)];
}

function findChrome() {
  return chromeCandidates().find(p => {
    try { return fs.statSync(p).isFile(); } catch (_) { return false; }
  }) || null;
}

/** Janela de app (sem abas/endereço), perfil próprio, sem telas de boas-vindas */
function chromeArgs(profileDir, url) {
  return [
    `--user-data-dir=${profileDir}`,
    `--app=${url}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--autoplay-policy=no-user-gesture-required',
    '--start-maximized',
  ];
}
// #endregion

// #region Firefox
function firefoxCandidates() {
  const list = [];
  if (process.env.MS_FIREFOX) list.push(process.env.MS_FIREFOX);
  if (IS_MAC) {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const app of ['Firefox.app', 'Firefox ESR.app', 'Firefox Developer Edition.app', 'Firefox Nightly.app']) {
        list.push(path.join(base, app, 'Contents', 'MacOS', 'firefox'));
      }
    }
    // Instalado em outro lugar: pergunta ao Spotlight pelo bundle id
    const found = execText('mdfind', ['kMDItemCFBundleIdentifier == "org.mozilla.firefox"']);
    found.split('\n').filter(Boolean).forEach(app => list.push(path.join(app, 'Contents', 'MacOS', 'firefox')));
  } else if (IS_WIN) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      for (const dir of ['Mozilla Firefox', 'Firefox Developer Edition', 'Firefox Nightly']) {
        list.push(path.join(base, dir, 'firefox.exe'));
      }
    }
    for (const hive of ['HKLM', 'HKCU']) {
      const out = execText('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, '/ve']);
      const m = out.match(/REG_SZ\s+(.+firefox\.exe)/i);
      if (m) list.push(m[1].trim().replace(/^"|"$/g, ''));
    }
  } else {
    list.push('/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox');
  }
  return [...new Set(list)];
}

function findFirefox() {
  return firefoxCandidates().find(p => {
    try { return fs.statSync(p).isFile(); } catch (_) { return false; }
  }) || null;
}

/**
 * Perfil dedicado: sem barras de abas/endereço, sem telas de boas-vindas,
 * áudio liberado e "Salvar como" nos downloads (projetos e exports).
 * user.js é reaplicado a cada abertura, então a porta pode mudar.
 */
function prepareFirefoxProfile(profileDir, url) {
  fs.mkdirSync(path.join(profileDir, 'chrome'), { recursive: true });
  const prefs = {
    'toolkit.legacyUserProfileCustomizations.stylesheets': true,
    'browser.startup.homepage': url,
    'browser.startup.page': 1,
    'browser.newtabpage.enabled': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'startup.homepage_welcome_url': '',
    'startup.homepage_welcome_url.additional': '',
    'browser.aboutwelcome.enabled': false,
    'trailhead.firstrun.didSeeAboutWelcome': true,
    'browser.uitour.enabled': false,
    'browser.messaging-system.whatsNewPanel.enabled': false,
    'browser.vpn_promo.enabled': false,
    'extensions.pocket.enabled': false,
    'browser.translations.automaticallyPopup': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.normandy.enabled': false,
    'browser.sessionstore.resume_from_crash': false,
    'browser.sessionstore.max_resumed_crashes': 0,
    'browser.tabs.warnOnClose': false,
    'browser.warnOnQuit': false,
    'browser.warnOnQuitShortcut': false,
    'browser.tabs.inTitlebar': 0,               // barra de título nativa: a janela continua arrastável
    'browser.toolbars.bookmarks.visibility': 'never',
    'browser.link.open_newwindow': 3,
    'ui.key.menuAccessKeyFocuses': false,       // Alt (Windows) não abre a barra de menus
    'signon.rememberSignons': false,            // campo da chave do Gemini não vira "salvar senha"
    'browser.formfill.enable': false,
    'browser.download.useDownloadDir': false,   // projeto .ms e vídeo exportado → "Salvar como"
    'browser.download.always_ask_before_handling_new_types': true,
    'media.autoplay.default': 0,                // o editor controla o play do áudio/vídeo
    'media.autoplay.blocking_policy': 0,
    'webgl.force-enabled': true,                // clipes 3D mesmo com GPU na lista de bloqueio
    'full-screen-api.warning.timeout': 0,
  };
  const userJs = Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join('\n');
  fs.writeFileSync(path.join(profileDir, 'user.js'), `// Gerado pelo Motion Studio a cada abertura\n${userJs}\n`);

  fs.writeFileSync(path.join(profileDir, 'chrome', 'userChrome.css'), `/* Motion Studio: janela sem a interface do navegador */
#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-main, #sidebar-box, #sidebar-splitter,
#vertical-tabs { visibility: collapse !important; }
#navigator-toolbox { border: 0 !important; }
`);

  // 1ª abertura: janela maximizada (depois o Firefox lembra o tamanho)
  const xulstore = path.join(profileDir, 'xulstore.json');
  if (!fs.existsSync(xulstore)) {
    fs.writeFileSync(xulstore, JSON.stringify({
      'chrome://browser/content/browser.xhtml': { 'main-window': { sizemode: 'maximized' } },
    }));
  }
}
// #endregion

// #region Utilidades
function execText(cmd, args) {
  try {
    return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true });
  } catch (_) {
    return '';
  }
}

function portFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

async function pickPort(preferred, span = 50) {
  for (let p = preferred; p < preferred + span; p++) if (await portFree(p)) return p;
  return 0;
}

function httpOk(url, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get(url, { timeout }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await httpOk(url)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function openExternal(url) {
  if (IS_MAC) cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else if (IS_WIN) cp.spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** Caixa de diálogo nativa (o app não tem console). Retorna true no botão de ação. */
function dialog(message, actionLabel = null) {
  console.error(`[Launcher] ${message.replace(/\n/g, ' ')}`);
  if (process.env.MS_NO_DIALOG === '1') return false;
  if (IS_MAC) {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const buttons = actionLabel ? `{"Fechar", "${esc(actionLabel)}"}` : '{"OK"}';
    const out = execTextLong('osascript', ['-e',
      `display dialog "${esc(message)}" with title "${APP_NAME}" buttons ${buttons} default button ${actionLabel ? 2 : 1} with icon caution`]);
    return Boolean(actionLabel) && out.includes(actionLabel);
  }
  if (IS_WIN) {
    const esc = s => s.replace(/'/g, "''");
    const text = actionLabel ? `${message}\n\n${actionLabel}?` : message;
    const out = execTextLong('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${esc(text)}', '${APP_NAME}', '${actionLabel ? 'YesNo' : 'OK'}', 'Warning')`]);
    return Boolean(actionLabel) && /Yes/i.test(out);
  }
  return false;
}

function execTextLong(cmd, args) {
  try {
    return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (_) {
    return '';
  }
}

/** Sem console (app empacotado): tudo vai para <dados>/logs/motion-studio.log */
function redirectLogs(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'motion-studio.log');
  try { fs.renameSync(file, file + '.1'); } catch (_) { /* 1ª execução */ }
  const out = fs.createWriteStream(file, { flags: 'a' });
  const tee = (stream, orig) => (chunk, enc, cb) => {
    out.write(chunk);
    if (process.env.MS_LOG_STDOUT === '1') { try { return orig(chunk, enc, cb); } catch (_) { /* sem console */ } }
    if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb();
    return true;
  };
  process.stdout.write = tee(process.stdout, process.stdout.write.bind(process.stdout));
  process.stderr.write = tee(process.stderr, process.stderr.write.bind(process.stderr));
  return file;
}

/**
 * Windows: o executável é um app de janela (sem console). Sem windowsHide,
 * cada ffmpeg/python/pip abriria uma janela preta piscando.
 */
function hideChildConsoles() {
  if (!IS_WIN) return;
  const withHide = (args, hasArgv) => {
    const i = hasArgv && Array.isArray(args[1]) ? 2 : 1;
    const opt = args[i];
    if (opt && typeof opt === 'object' && !Array.isArray(opt)) args[i] = { windowsHide: true, ...opt };
    else if (opt == null && args.length > i) args[i] = { windowsHide: true };
    else args.splice(i, 0, { windowsHide: true });
    return args;
  };
  for (const [name, hasArgv] of [['spawn', true], ['execFile', true], ['exec', false], ['spawnSync', true], ['execFileSync', true], ['execSync', false]]) {
    const orig = cp[name];
    cp[name] = function (...args) { return orig.apply(this, withHide(args, hasArgv)); };
  }
  require('module').syncBuiltinESMExports();   // `import { spawn }` também vê a versão nova
}
// #endregion

// #region Principal
async function main() {
  const appDir  = resolveAppDir();
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  hideChildConsoles();

  const profileDir   = path.join(dataDir, 'firefox-profile');
  const chromeDir    = path.join(dataDir, 'chrome-profile');
  const instanceFile = path.join(dataDir, 'instance.json');
  const stateFile    = path.join(dataDir, 'state.json');

  const firefox = findFirefox();
  const chromeBrowser = findChrome();
  const saved = readJson(stateFile) || {};
  // Chrome por padrão; Firefox só quando o WebGL falhou no Chrome desta máquina
  // (lembrado em state.json) ou sem Chrome/Edge. MS_BROWSER=chrome|firefox força.
  const wanted = process.env.MS_BROWSER || (saved.browser === 'firefox' ? 'firefox' : 'chrome');
  let browserKind = (wanted === 'firefox' && firefox) || !chromeBrowser ? 'firefox' : 'chrome';
  if (browserKind === 'firefox' && !firefox) {
    const go = dialog('O Motion Studio precisa do Google Chrome (ou do Firefox) para abrir o editor, e nenhum dos dois foi encontrado.\nInstale o Chrome e abra o Motion Studio de novo.', 'Baixar Chrome');
    if (go) openExternal(CHROME_DOWNLOAD);
    process.exit(1);
  }
  const openWindow = (kind, url, extra = []) => kind === 'chrome'
    ? cp.spawn(chromeBrowser, [...extra, ...chromeArgs(chromeDir, url)], { stdio: 'ignore' })
    : cp.spawn(firefox, [...extra, '--profile', profileDir, url], { stdio: 'ignore' });

  // Já aberto: só abre outra janela no navegador do app (antes de mexer no log da instância viva)
  const running = readJson(instanceFile);
  if (running?.pid && pidAlive(running.pid) && await httpOk(`http://127.0.0.1:${running.port}/desktop.js`)) {
    console.log(`[Launcher] Já em execução (pid ${running.pid}, porta ${running.port}) — abrindo nova janela`);
    const kind = running.browser === 'firefox' && firefox ? 'firefox' : (chromeBrowser ? 'chrome' : 'firefox');
    openWindow(kind, `http://localhost:${running.port}/`).unref();
    process.exit(0);
  }

  const logFile = redirectLogs(path.join(dataDir, 'logs'));
  console.log(`[Launcher] ${new Date().toISOString()} · ${process.platform}-${process.arch} · Node ${process.version}`);
  console.log(`[Launcher] app: ${appDir}`);
  console.log(`[Launcher] dados: ${dataDir}`);
  console.log(`[Launcher] Chrome: ${chromeBrowser || '(não encontrado)'} · Firefox: ${firefox || '(não encontrado)'} · usando: ${browserKind}`);

  // Mesma porta da última vez: o localStorage do editor é por origem (localhost:porta)
  const state = saved;
  const port = await pickPort(Number(process.env.PORT) || state.port || 3001);
  const whisperPort = await pickPort(Number(process.env.WHISPER_PORT) || 9099);
  if (!port || !whisperPort) {
    dialog('Não há porta de rede livre para iniciar o Motion Studio. Feche outros programas e tente de novo.');
    process.exit(1);
  }
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, port }));

  const chrome = findBundledChrome(appDir);
  const python = findBundledPython(appDir);
  Object.assign(process.env, {
    MS_DESKTOP:         '1',
    PORT:               String(port),
    WHISPER_PORT:       String(whisperPort),
    WHISPER_MODELS_DIR: process.env.WHISPER_MODELS_DIR || path.join(dataDir, 'models'),
    WHISPER_ENV_DIR:    process.env.WHISPER_ENV_DIR || path.join(dataDir, 'whisper-env'),
    AI_CONFIG_PATH:     process.env.AI_CONFIG_PATH || path.join(dataDir, 'config', 'ai.local.json'),
    MS_PROJECTS_DIR:    process.env.MS_PROJECTS_DIR || path.join(dataDir, 'projects'),
  });
  if (chrome) process.env.MS_CHROME_PATH = chrome;
  if (python && !process.env.WHISPER_BASE_PYTHON) process.env.WHISPER_BASE_PYTHON = python;
  console.log(`[Launcher] Chrome do export: ${chrome || '(baixado na 1ª exportação)'}`);
  console.log(`[Launcher] Python embutido: ${python || '(usa o do sistema)'}`);

  // O web-video-creator grava tmp/ e .bin/ relativos à pasta atual: precisa ser gravável
  process.chdir(dataDir);

  let clients = 0;
  let everConnected = false;
  let idleTimer = null;
  let ff = null;          // processo do navegador aberto (Chrome ou Firefox)
  let switching = false;  // trocando Chrome → Firefox: o Chrome fechar não encerra o app
  let shuttingDown = false;

  const shutdown = reason => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Launcher] Encerrando: ${reason}`);
    try { if (readJson(instanceFile)?.pid === process.pid) fs.rmSync(instanceFile, { force: true }); } catch (_) { /* ok */ }
    if (ff && ff.exitCode === null) {
      if (IS_WIN) execText('taskkill', ['/pid', String(ff.pid), '/T', '/F']);
      else ff.kill('SIGTERM');
    }
    // index.js encerra o Whisper no 'exit'
    setTimeout(() => process.exit(0), 300);
  };

  process.on('motion-studio:presence', n => {
    clients = n;
    if (n > 0) {
      everConnected = true;
      clearTimeout(idleTimer);
      idleTimer = null;
    } else if (!idleTimer) {
      idleTimer = setTimeout(() => { idleTimer = null; if (clients === 0) shutdown('última janela do editor fechada'); }, IDLE_GRACE);
    }
  });
  ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));

  // Servidor no mesmo processo (index.js lê PORT etc. do ambiente)
  try {
    createRequire(path.join(appDir, 'index.js'))('./index.js');
  } catch (err) {
    console.error(err);
    dialog(`O servidor do Motion Studio não iniciou:\n${err.message}\n\nDetalhes em ${logFile}`);
    process.exit(1);
  }
  const url = `http://localhost:${port}/`;
  if (!await waitHttp(`http://127.0.0.1:${port}/desktop.js`, 60000)) {
    dialog(`O servidor do Motion Studio não respondeu.\nDetalhes em ${logFile}`);
    process.exit(1);
  }
  const writeInstance = () => fs.writeFileSync(instanceFile, JSON.stringify({ pid: process.pid, port, browser: browserKind }));
  writeInstance();

  const label = kind => (kind === 'chrome' ? path.basename(chromeBrowser, path.extname(chromeBrowser)) : 'Firefox');
  const launch = kind => {
    if (kind === 'firefox') prepareFirefoxProfile(profileDir, url);
    console.log(`[Launcher] Abrindo ${url} no ${label(kind)}`);
    // MS_BROWSER_ARGS: argumentos extras (ex.: --headless nos testes)
    const extra = (process.env.MS_BROWSER_ARGS || process.env.MS_FIREFOX_ARGS || '').split(' ').filter(Boolean);
    const proc = openWindow(kind, url, extra);
    ff = proc;
    proc.on('error', err => {
      dialog(`Não foi possível abrir o ${label(kind)}:\n${err.message}`);
      shutdown(`falha ao abrir o ${label(kind)}`);
    });
    proc.on('exit', code => {
      console.log(`[Launcher] ${label(kind)} saiu (código ${code})`);
      if (switching || proc !== ff) return;
      // Saída imediata = o perfil já estava aberto e o navegador só repassou a URL
      // para a instância existente: segue enquanto houver janela conectada.
      if (everConnected && clients === 0) shutdown(`${label(kind)} fechado`);
    });
  };

  // A página informa se o WebGL funciona (desktop.js). No Chrome sem WebGL:
  // troca para o Firefox e lembra; sem Firefox, avisa e segue no Chrome.
  let webglChecked = false;
  process.on('motion-studio:webgl', ({ ok }) => {
    if (webglChecked || browserKind !== 'chrome') return;
    webglChecked = true;
    console.log(`[Launcher] WebGL no ${label('chrome')}: ${ok ? 'ok' : 'indisponível'}`);
    if (ok) return;
    if (!firefox) {
      const go = dialog('O WebGL não funciona no Chrome deste computador: clipes 3D não vão aparecer no preview.\nO Firefox costuma resolver. Quer baixar o Firefox? Depois é só abrir o Motion Studio de novo.', 'Baixar Firefox');
      if (go) openExternal(FIREFOX_DOWNLOAD);
      return;
    }
    console.log('[Launcher] Trocando para o Firefox (WebGL indisponível no Chrome)');
    fs.writeFileSync(stateFile, JSON.stringify({ ...readJson(stateFile), browser: 'firefox' }));
    switching = true;
    const old = ff;
    browserKind = 'firefox';
    writeInstance();
    launch('firefox');
    // Fecha o Chrome depois que a janela do Firefox conectar (o app não "pisca" fechado)
    const started = Date.now();
    const wait = setInterval(() => {
      if (clients < 2 && Date.now() - started < 15000) return;
      clearInterval(wait);
      if (old && old.exitCode === null) {
        if (IS_WIN) execText('taskkill', ['/pid', String(old.pid), '/T', '/F']);
        else old.kill('SIGTERM');
      }
      setTimeout(() => { switching = false; }, 2000);
    }, 300);
  });

  launch(browserKind);

  // Nenhuma janela conectou (navegador fechado na hora, perfil travado…)
  setTimeout(() => { if (!everConnected) shutdown('nenhuma janela do editor conectou'); }, 120000);
}

main().catch(err => {
  console.error('[Launcher] Erro fatal:', err);
  dialog(`Erro ao iniciar o Motion Studio:\n${err.message}`);
  process.exit(1);
});
// #endregion
