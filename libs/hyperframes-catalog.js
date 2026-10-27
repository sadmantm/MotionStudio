'use strict';
// hyperframes-catalog.js
//
//  Catálogo de blocos do HyperFrames (github.com/heygen-com/hyperframes,
//  Apache-2.0) dentro do editor:
//
//    GET  /api/hyperframes/catalog        → { revision, blocks: [{ name, title, description, tags, duration, width, height, poster, video, warn }] }
//    POST /api/hyperframes/import {name}  → { name, title, html, duration, width, height }
//
//  Os blocos são composições HTML completas (GSAP pausado em
//  window.__timelines, raiz [data-composition-id] com data-duration). O
//  motion-kit (libs/motion-kit.js) já dirige esse formato, então o HTML entra
//  como clipe sem conversão: só os caminhos relativos viram
//  /api/hyperframes/asset/<commit>/<caminho> (proxy deste servidor com o
//  Content-Type certo — o raw do GitHub entrega .js/.css como text/plain e o
//  jsDelivr recusa o repositório, maior que 50 MB) e o cabeçalho ganha
//  atribuição. Lista, itens e assets ficam em cache em disco (tmp do sistema).
//
//    GET  /api/hyperframes/asset/:rev/*   → arquivo do repositório no commit :rev

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'heygen-com/hyperframes';
const CACHE_DIR = path.join(os.tmpdir(), 'motion-studio-hyperframes');
const CACHE_FILE = path.join(CACHE_DIR, 'catalog.json');
const MAX_AGE_MS = 24 * 3600 * 1000;
const CONCURRENCY = 16;
const UA = { 'user-agent': 'motion-studio' };

const raw = (rev, p) => `https://raw.githubusercontent.com/${REPO}/${rev}/${p}`;
const assetUrl = (rev, p) => `/api/hyperframes/asset/${rev}/${p}`;
const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.glsl': 'text/plain', '.lottie': 'application/zip',
};

async function getText(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}
const getJson = async url => JSON.parse(await getText(url));

/** Commit atual do main (fixa as URLs); sem API do GitHub, usa "main" */
async function latestRevision() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { ...UA, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return (await res.json()).sha;
  } catch (_) { /* sem rede para a API */ }
  return 'main';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i).catch(() => null);
    }
  }));
  return out;
}

let building = null;

async function buildCatalog() {
  const revision = await latestRevision();
  const registry = await getJson(raw(revision, 'registry/registry.json'));
  const names = (registry.items || []).filter(i => i.type === 'hyperframes:block').map(i => i.name);
  const items = await mapLimit(names, CONCURRENCY, name => getJson(raw(revision, `registry/blocks/${name}/registry-item.json`)));
  const blocks = items.filter(Boolean).map(item => {
    const tags = Array.isArray(item.tags) ? item.tags : [];
    return {
      name: item.name,
      title: item.title || item.name,
      description: item.description || '',
      tags,
      duration: Number(item.duration) || null,
      width: item.dimensions?.width || null,
      height: item.dimensions?.height || null,
      poster: item.preview?.poster || null,
      video: item.preview?.video || null,
      // Captura HTML→canvas: experimental no Chrome; o export pode sair sem o efeito
      warn: tags.some(t => /html-in-canvas|shader|webgpu/i.test(t)) ? 'Usa recursos experimentais do Chrome: confira o resultado no export.' : null,
    };
  });
  const catalog = { revision, builtAt: Date.now(), blocks };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog));
  return catalog;
}

async function getCatalog({ refresh = false } = {}) {
  if (!refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - cached.builtAt < MAX_AGE_MS && Array.isArray(cached.blocks) && cached.blocks.length) return cached;
    } catch (_) { /* sem cache */ }
  }
  if (!building) building = buildCatalog().finally(() => { building = null; });
  return building;
}

/**
 * Caminhos relativos do HTML → URLs absolutas no CDN. O HTML é instalado em
 * `target` (ex.: compositions/x.html) e referencia outros arquivos do item
 * pelos targets deles; o que não for do item resolve na pasta do bloco.
 */
function absolutize(html, { revision, blockDir, htmlTarget, files }) {
  // files[].path já vem com a pasta do bloco (registry/blocks/<nome>/…)
  const byTarget = new Map(files.map(f => [path.posix.normalize(f.target || f.path), f.path]));
  const baseDir = path.posix.dirname(htmlTarget || '');
  const resolve = ref => {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#|\/)/i.test(ref) || !ref.trim() || /[{}$]/.test(ref)) return null;
    const cut = ref.search(/[?#]/);
    const clean = cut >= 0 ? ref.slice(0, cut) : ref;
    const suffix = cut >= 0 ? ref.slice(cut) : '';
    const source = byTarget.get(path.posix.normalize(path.posix.join(baseDir, clean)))
      || path.posix.normalize(path.posix.join(blockDir, clean));
    return assetUrl(revision, source) + suffix;
  };
  const swap = (whole, attr, q, ref) => {
    const abs = resolve(ref);
    return abs ? `${attr}=${q}${abs}${q}` : whole;
  };
  return html
    .replace(/\b(src|href|poster|data-src)=(["'])([^"']+)\2/gi, (m, attr, q, ref) => swap(m, attr, q, ref))
    .replace(/url\((["']?)([^"')]+)\1\)/gi, (m, q, ref) => {
      const abs = resolve(ref);
      return abs ? `url(${q}${abs}${q})` : m;
    });
}

async function importBlock(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(String(name || ''))) throw Object.assign(new Error('Nome de bloco inválido.'), { status: 400 });
  const catalog = await getCatalog();
  const revision = catalog.revision;
  const blockDir = `registry/blocks/${name}`;
  const item = await getJson(raw(revision, `${blockDir}/registry-item.json`));
  const files = (item.files || []).map(f => ({ path: f.path, target: f.target || f.path, type: f.type }));
  const main = files.find(f => f.type === 'hyperframes:composition') || files.find(f => /\.html?$/i.test(f.path));
  if (!main) throw new Error('O bloco não tem HTML de composição.');
  let html = await getText(raw(revision, `${blockDir}/${main.path}`));
  html = absolutize(html, { revision, blockDir, htmlTarget: main.target, files: files.map(f => ({ ...f, path: `${blockDir}/${f.path}` })) });

  const duration = Number(item.duration) || Number((/data-duration=["']([\d.]+)/.exec(html) || [])[1]) || 5;
  const fps = Number((/data-fps=["']([\d.]+)/.exec(html) || [])[1]) || 30;
  // Atribuição (Apache-2.0) + duração legível pelo editor (extractDuration)
  const header = `<!-- Bloco "${item.name}" do catálogo HyperFrames · github.com/${REPO} @ ${String(revision).slice(0, 7)} · Apache-2.0 · durationInSeconds: ${duration} · fps: ${fps} -->\n`;
  html = /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^\s*<!doctype[^>]*>/i, m => `${m}\n${header}`) : header + html;
  return {
    name: item.name,
    title: item.title || item.name,
    html,
    duration,
    width: item.dimensions?.width || null,
    height: item.dimensions?.height || null,
  };
}

/**
 * Arquivo do repositório no commit `rev`, com cache em disco. Usado pela rota
 * do app e pelo servidor interno do export (mesma URL nos dois).
 */
async function serveAsset(rev, relPath, res) {
  const clean = path.posix.normalize(String(relPath || '')).replace(/^(\.\.\/)+/, '');
  if (!/^[0-9a-f]{7,40}$|^main$/.test(String(rev)) || !clean.startsWith('registry/') || clean.includes('..')) {
    res.statusCode = 400;
    return res.end('caminho inválido');
  }
  const file = path.join(CACHE_DIR, 'assets', rev, ...clean.split('/'));
  try {
    if (!fs.existsSync(file)) {
      const r = await fetch(raw(rev, clean), { headers: UA, signal: AbortSignal.timeout(60000) });
      if (!r.ok) {
        res.statusCode = r.status;
        return res.end(`HTTP ${r.status}`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.part`;
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      fs.renameSync(tmp, file);
    }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.statusCode = 502;
    res.end(`falha ao buscar o asset: ${err.message}`);
  }
}

function register(app) {
  app.get(/^\/api\/hyperframes\/asset\/([^/]+)\/(.+)$/, (req, res) => serveAsset(req.params[0], decodeURIComponent(req.params[1]), res));

  app.get('/api/hyperframes/catalog', async (req, res) => {
    try {
      res.json(await getCatalog({ refresh: req.query.refresh === '1' }));
    } catch (err) {
      console.warn('[HyperFrames] Catálogo indisponível:', err.message);
      res.status(502).json({ error: `Não foi possível carregar o catálogo do HyperFrames (${err.message}).` });
    }
  });

  app.post('/api/hyperframes/import', async (req, res) => {
    try {
      res.json(await importBlock(req.body?.name));
    } catch (err) {
      console.warn('[HyperFrames] Importação falhou:', err.message);
      res.status(err.status || 502).json({ error: `Não foi possível importar o bloco: ${err.message}` });
    }
  });
}

module.exports = { register, getCatalog, importBlock, absolutize, serveAsset };
