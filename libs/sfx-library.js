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
  {
    // 320 sons CC0 com dados para a IA escolher, sincronizar (sync.at) e mixar
    id: 'sfxkit',
    name: 'sfxkit',
    version: '1.0.0',
    license: 'CC0-1.0',
    homepage: 'https://github.com/wyzowl/sfx-kit',
    // jsDelivr recusa o pacote (67 MB > limite de 50 MB); o raw do GitHub, com a tag fixa, libera CORS
    base: 'https://raw.githubusercontent.com/wyzowl/sfx-kit/v1.0.0/',
    manifest: 'sounds.json',
    adapt(m) {
      return {
        packs: [{ name: 'sfxkit', description: 'sons sintetizados de alta qualidade, neutros — combinam com qualquer estilo e entre si', bestFor: ['motion graphics', 'interfaces', 'explicadores', 'trailers'] }],
        cues: (m.sounds || []).map(s => ({
          name: s.id,
          category: s.category,
          description: (s.use_for || []).slice(0, 3).join('; '),
          duration: s.duration,
          fits: s.fits_seconds || null,
          avoid: (s.avoid_for || []).slice(0, 2).join('; '),
        })),
        files: Object.fromEntries((m.sounds || []).filter(s => s.file).map(s => [`sfxkit/${s.id}`, {
          path: s.file,
          duration: s.duration,
          sync: s.sync?.at ?? 0,                 // segundos do arquivo até o ponto que encontra o momento
          underVoice: s.under_voiceover_db ?? null,
          rate: s.adapt?.rate || null,
        }])),
      };
    },
    /** Catálogo compacto: categoria → sons com duração e, quando há, o intervalo de movimento que cobrem */
    prompt(lib) {
      const byCat = {};
      lib.cues.forEach(c => { (byCat[c.category] ||= []).push(c); });
      const line = c => `${c.name}(${Number(c.duration).toFixed(1)}s${c.fits ? `, cobre ${c.fits[0]}–${c.fits[1]}s` : ''})`;
      return [
        `Biblioteca "${lib.name}" (${lib.license}) — 320 sons; use sound: "sfxkit/<som>". NEUTRA: combina com qualquer pacote e pode ser a única fonte.`,
        'O editor posiciona cada som pelo ponto de sincronia dele (o pico/ação): o t da deixa é o INSTANTE da tela que o som deve encontrar, não o início do arquivo. Variações: soft/subtle = discreto (voz, corporativo), hard = enérgico; fast/medium/slow = duração do movimento.',
        Object.entries(byCat).map(([cat, list]) => `${cat}: ${list.map(line).join(', ')}`).join('\n'),
      ].join('\n');
    },
  },
];

const CACHE_DIR = path.join(os.tmpdir(), 'motion-studio-sfx');
let loading = null;

async function loadSource(src) {
  const cacheFile = path.join(CACHE_DIR, `${src.id}-${src.version}-r2.json`);
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
    const src = SOURCES.find(x => x.id === lib.id);
    if (src?.prompt) return src.prompt(lib);
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
