'use strict';
// libs/sfx-openverse.js
//
//  Busca de efeitos sonoros no Openverse (https://openverse.org — Freesound,
//  Wikimedia etc., só licenças Creative Commons). A IA de efeitos sonoros pede
//  sons que as bibliotecas fixas não têm (porta, multidão, motor, animais…)
//  com { search: "door slam" }; o servidor acha o melhor resultado, baixa
//  para o cache local e o editor usa como sound: "ov/<id>" (arquivo servido
//  em /api/sfx/ov/<id>, mesma origem: sem CORS e sem depender do CDN depois).
//
//  Licenças aceitas por padrão: CC0 e domínio público (sem crédito). Com
//  OPENVERSE_LICENSES=cc0,pdm,by entra CC BY (exige crédito — a atribuição
//  volta junto para o editor guardar no clip).
//  Opcional: OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET sobem o limite de
//  pedidos (https://api.openverse.org/v1/#tag/auth).

const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const API       = 'https://api.openverse.org/v1';
// Padrão: só o que dispensa crédito. OPENVERSE_LICENSES=cc0,pdm,by inclui CC BY (a atribuição volta no clip: sfxCredits)
const LICENSES  = (process.env.OPENVERSE_LICENSES || 'cc0,pdm').replace(/[^a-z0-9,-]/gi, '');
const FORMATS   = new Set(['mp3', 'ogg', 'oga', 'wav', 'flac']);   // o que o navegador decodifica
const MIN_MS    = 60;
const MAX_MS    = 8000;                 // efeito, não música nem ambiente longo
const MAX_BYTES = 6 * 1024 * 1024;
const ID_RE     = /^[0-9a-f-]{36}$/;
const MIME      = { mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };

const CACHE_DIR = path.join(os.tmpdir(), 'motion-studio-sfx', 'openverse');
const found = new Map();                // consulta normalizada → entrada | null
let token = null;                       // { value, expires }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function authHeader() {
  const id = process.env.OPENVERSE_CLIENT_ID;
  const secret = process.env.OPENVERSE_CLIENT_SECRET;
  if (!id || !secret) return {};
  if (!token || token.expires < Date.now() + 60000) {
    const resp = await fetch(`${API}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`token Openverse: HTTP ${resp.status}`);
    const data = await resp.json();
    token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }
  return { Authorization: `Bearer ${token.value}` };
}

/** A API pública é lenta e às vezes dá 5xx/timeout: duas tentativas */
async function apiSearch(query) {
  const url = `${API}/audio/?${new URLSearchParams({ q: query, license: LICENSES, page_size: '20', mature: 'false' })}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = await authHeader().catch(() => ({}));
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(14000) });
      if (resp.status === 429) throw new Error('limite de pedidos do Openverse atingido');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()).results || [];
    } catch (err) {
      lastErr = err;
      if (/limite/.test(err.message)) break;
      await sleep(600);
    }
  }
  throw lastErr;
}

const words = s => String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];

/** Melhor candidato: duração de efeito, formato tocável, palavras da busca no título/tags, sem crédito primeiro */
function rank(results, query, want) {
  const q = new Set(words(query));
  return results
    .filter(r => r.url && FORMATS.has(String(r.filetype || '').toLowerCase()) && r.duration >= MIN_MS && r.duration <= MAX_MS && /^https:\/\//.test(r.url))
    .map(r => {
      const text = new Set([...words(r.title), ...(r.tags || []).flatMap(t => words(t.name))]);
      let hit = 0;
      q.forEach(w => { if (text.has(w)) hit++; });
      let score = (q.size ? hit / q.size : 0) * 4;
      if (r.license === 'cc0' || r.license === 'pdm') score += 1.5;
      if (want > 0) score += 1.5 / (1 + Math.abs(r.duration / 1000 - want));
      else score += 0.8 / (1 + r.duration / 1000);   // sem duração pedida: curto é mais útil
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.r);
}

function entryOf(r) {
  return {
    id: `ov/${r.id}`,
    url: `/api/sfx/ov/${r.id}`,
    duration: r.duration / 1000,
    title: String(r.title || '').slice(0, 120),
    creator: String(r.creator || '').slice(0, 80),
    license: `${String(r.license || '').toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`,
    attribution: ['cc0', 'pdm'].includes(r.license) ? '' : String(r.attribution || '').slice(0, 400),
    source: r.foreign_landing_url || '',
    provider: r.provider || r.source || '',
  };
}

const cachedFile = id => {
  for (const ext of Object.keys(MIME)) {
    const f = path.join(CACHE_DIR, `${id}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
};

async function download(r) {
  if (cachedFile(r.id)) return;
  const resp = await fetch(r.url, { signal: AbortSignal.timeout(25000) });
  if (!resp.ok) throw new Error(`download: HTTP ${resp.status}`);
  const declared = Number(resp.headers.get('content-length')) || 0;
  if (declared > MAX_BYTES) throw new Error('arquivo grande demais');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('arquivo inválido');
  const ext = String(r.filetype).toLowerCase();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${r.id}.${ext}`);
  fs.writeFileSync(file + '.tmp', buf);
  fs.renameSync(file + '.tmp', file);
}

/** Pesquisa e baixa o melhor som. → entrada | null (sem internet, sem resultado…) */
async function find(query, want = 0) {
  const key = `${String(query).toLowerCase().trim()}|${Math.round(want * 2) / 2}`;
  if (found.has(key)) {
    const hit = found.get(key);
    if (!hit || cachedFile(hit.id.slice(3))) return hit;
  }
  let entry = null;
  try {
    const ranked = rank(await apiSearch(String(query).slice(0, 80)), query, want);
    for (const r of ranked.slice(0, 3)) {     // o primeiro que baixar
      try { await download(r); entry = entryOf(r); break; } catch (err) { console.warn(`[SFX] Openverse ${r.id}: ${err.message}`); }
    }
  } catch (err) {
    console.warn(`[SFX] Openverse "${query}": ${err.message}`);
    return null;                              // falha de rede não vira cache
  }
  found.set(key, entry);
  return entry;
}

/**
 * Resolve várias buscas ({ search, want? }) em paralelo limitado.
 * → Map<consulta, entrada|null>
 */
async function resolve(requests, { max = 12, concurrency = 3 } = {}) {
  const uniq = new Map();
  for (const r of requests) {
    const q = String(r.search || '').trim();
    if (q && !uniq.has(q.toLowerCase())) uniq.set(q.toLowerCase(), { q, want: Number(r.want) || 0 });
  }
  const list = [...uniq.values()].slice(0, max);
  const out = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (next < list.length) {
      const { q, want } = list[next++];
      out.set(q.toLowerCase(), await find(q, want));
    }
  }));
  return out;
}

function register(app) {
  /** Arquivo baixado (cache local) */
  app.get('/api/sfx/ov/:id', (req, res) => {
    const file = ID_RE.test(req.params.id) ? cachedFile(req.params.id) : null;
    if (!file) return res.status(404).json({ error: 'Som não encontrado no cache.' });
    res.type(MIME[path.extname(file).slice(1)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  });

  /** Busca manual: GET /api/sfx/search?q=door+slam&want=1.2 → { sound } */
  app.get('/api/sfx/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Informe q.' });
    const entry = await find(q, Number(req.query.want) || 0);
    res.json({ sound: entry });
  });
}

module.exports = { register, find, resolve };
