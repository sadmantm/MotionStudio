'use strict';
// libs/sfx-library.js
//
//  Bibliotecas externas de efeitos sonoros (arquivos reais, licença livre)
//  servidas por CDN com versão fixa. O catálogo vai para o prompt da IA
//  (ela escolhe sons por nome: sound: "<pacote>/<som>") e para o editor, que
//  baixa os arquivos e mistura junto com os sons sintetizados (libs/sfx.js).
//
//  Para adicionar outra biblioteca: um item em SOURCES com um adaptador que
//  converte o manifesto dela em { packs, cues, available }.

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SOURCES = [
  {
    id: 'uisfx',
    name: 'uisfx',
    version: '0.4.0',
    license: 'CC0-1.0 (áudio) · MIT (código)',
    homepage: 'https://github.com/romainsimon/uisfx',
    base: 'https://cdn.jsdelivr.net/npm/uisfx@0.4.0/',
    manifest: 'manifest.json',
    adapt(m) {
      return {
        packs: (m.packs || []).map(p => ({ name: p.name, description: p.description, bestFor: p.bestFor })),
        cues: (m.cues || []).map(c => ({ name: c.name, category: c.category, description: c.description })),
        // pack/cue → caminho do mp3 (mp3 toca no Chrome e no Firefox)
        files: Object.fromEntries((m.assets || [])
          .filter(a => a.files?.mp3?.path)
          .map(a => [`${a.pack}/${a.cue}`, { path: a.files.mp3.path, duration: a.duration }])),
      };
    },
  },
];

const CACHE_DIR = path.join(os.tmpdir(), 'motion-studio-sfx');
let loading = null;

async function loadSource(src) {
  const cacheFile = path.join(CACHE_DIR, `${src.id}-${src.version}.json`);
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (_) { /* sem cache */ }
  const resp = await fetch(src.base + src.manifest, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`manifesto ${src.id}: HTTP ${resp.status}`);
  const data = {
    id: src.id, name: src.name, version: src.version, license: src.license,
    homepage: src.homepage, base: src.base, ...src.adapt(await resp.json()),
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

/** Catálogo de todas as bibliotecas (as que falharem — sem internet — ficam de fora) */
function catalog() {
  if (!loading) {
    loading = Promise.all(SOURCES.map(s => loadSource(s).catch(err => {
      console.warn(`[SFX] Biblioteca ${s.id} indisponível: ${err.message}`);
      return null;
    }))).then(list => {
      const ok = list.filter(Boolean);
      if (ok.length < SOURCES.length) loading = null;   // tenta de novo no próximo pedido
      return ok;
    });
  }
  return loading;
}

/** Trecho do prompt: pacotes + sons por categoria (compacto, ~1,5 KB) */
async function promptText() {
  const libs = await catalog();
  if (!libs.length) return '';
  return libs.map(lib => {
    const byCat = {};
    lib.cues.forEach(c => { (byCat[c.category] ||= []).push(c.name); });
    return [
      `Biblioteca "${lib.name}" (${lib.license}) — use sound: "<pacote>/<som>".`,
      `Pacotes (escolha UM e use em tudo, para os sons combinarem): ${lib.packs.map(p => `${p.name} (${p.description})`).join('; ')}.`,
      `Sons: ${Object.entries(byCat).map(([cat, names]) => `${cat}: ${names.join(', ')}`).join(' · ')}.`,
    ].join('\n');
  }).join('\n');
}

function register(app) {
  // Catálogo para o editor resolver sound → URL do arquivo
  app.get('/api/sfx/library', async (req, res) => {
    const libs = await catalog();
    res.json({ libraries: libs.map(({ id, name, version, license, homepage, base, packs, cues, files }) => ({ id, name, version, license, homepage, base, packs, cues, files })) });
  });
}

module.exports = { register, catalog, promptText };
