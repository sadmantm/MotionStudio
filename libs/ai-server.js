'use strict';
/**
 * libs/ai-server.js — Geração/edição de clipes Motion com a API do Gemini.
 *
 * Rotas:
 *   GET  /api/ai/config    → { hasKey, keyHint, model, source }
 *   POST /api/ai/config    → salva { apiKey?, model? } (valida a chave)
 *   GET  /api/ai/models    → modelos Gemini com generateContent
 *   POST /api/ai/generate  → stream NDJSON (status/progress/done/error)
 *
 * Config: arquivo <root>/config/ai.local.json ({ apiKey, model }) ou env
 * GEMINI_API_KEY / GEMINI_MODEL. GEMINI_BASE_URL aponta para outro host
 * (testes). AI_CONFIG_PATH sobrescreve o caminho do arquivo de config.
 * A chave nunca é enviada ao navegador.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { parsePatchBlocks, looksLikePatch, applyPatchBlocks, maskDataUris, unmaskDataUris } = require('./html-patch');
const sfxLibrary = require('./sfx-library');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const MODELS_TTL_MS    = 10 * 60 * 1000;

// #region Config
function createConfigStore(root) {
  const file = process.env.AI_CONFIG_PATH
    ? path.resolve(process.env.AI_CONFIG_PATH)
    : path.join(root, 'config', 'ai.local.json');

  let readError = null;   // arquivo existe mas não pode ser lido (ex.: criado com sudo)

  function readFile() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      readError = null;
      return data && typeof data === 'object' ? data : {};
    } catch (err) {
      readError = err.code === 'ENOENT' ? null : permissionError(err, 'ler');
      return {};
    }
  }

  function writeFile(data) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
      throw permissionError(err, 'gravar');
    }
  }

  /** EACCES/EPERM costuma ser arquivo criado por outro usuário (servidor rodado com sudo) */
  function permissionError(err, verb) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return new AiError(
        `Sem permissão para ${verb} ${file}. O arquivo pertence a outro usuário (o servidor já foi iniciado com sudo?). ` +
        `Corrija no Terminal: sudo chown -R "$(whoami)" "${path.dirname(file)}"`,
        500, 'config_permission'
      );
    }
    return new AiError(`Não foi possível ${verb} ${file}: ${err.message}`, 500, 'config_io');
  }

  function get() {
    const f = readFile();
    const fileKey = typeof f.apiKey === 'string' ? f.apiKey.trim() : '';
    const envKey  = (process.env.GEMINI_API_KEY || '').trim();
    const apiKey  = fileKey || envKey || '';
    const source  = fileKey ? 'file' : envKey ? 'env' : null;
    const model   = (typeof f.model === 'string' && f.model.trim())
      || (process.env.GEMINI_MODEL || '').trim()
      || '';
    // Rotação automática de modelo quando a cota estoura (padrão: ligada)
    const autoRotate = f.autoRotate !== false && process.env.GEMINI_AUTO_ROTATE !== '0';
    return { apiKey, source, model, autoRotate };
  }

  function save(patch) {
    const cur = readFile();
    const next = { ...cur };
    if (patch.apiKey !== undefined) {
      if (patch.apiKey) next.apiKey = patch.apiKey; else delete next.apiKey;
    }
    if (patch.model !== undefined) {
      if (patch.model) next.model = patch.model; else delete next.model;
    }
    if (patch.autoRotate !== undefined) next.autoRotate = Boolean(patch.autoRotate);
    writeFile(next);
  }

  return { get, save, file, readError: () => (readFile(), readError) };
}

function maskKey(key) {
  if (!key) return '';
  return '…' + key.slice(-4);
}

function baseUrl() {
  return (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}
// #endregion

// #region Erros amigáveis
class AiError extends Error {
  constructor(message, status = 500, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const NO_KEY_MESSAGE =
  'Nenhuma chave da API do Gemini configurada. Abra as configurações da IA (engrenagem) e cole sua chave, ' +
  'ou defina a variável de ambiente GEMINI_API_KEY. Obtenha uma chave em aistudio.google.com/apikey.';

/** Tempo sugerido pelo Gemini para tentar de novo (RetryInfo) e se a cota é diária */
function parseRetryInfo(details = [], headers = null) {
  let retryAfterMs = null;
  let scope = 'minute';
  for (const d of Array.isArray(details) ? details : []) {
    if (/RetryInfo/.test(d?.['@type'] || '') && d.retryDelay) {
      const s = parseFloat(String(d.retryDelay));
      if (Number.isFinite(s)) retryAfterMs = Math.ceil(s * 1000);
    }
    if (/QuotaFailure/.test(d?.['@type'] || '')) {
      const ids = (d.violations || []).map(v => `${v.quotaId || ''} ${v.quotaMetric || ''}`).join(' ');
      if (/PerDay|per_day|daily/i.test(ids)) scope = 'day';
    }
  }
  const header = headers?.get?.('retry-after');
  if (retryAfterMs == null && header && Number.isFinite(+header)) retryAfterMs = +header * 1000;
  return { retryAfterMs, scope };
}

async function upstreamError(resp) {
  let msg = '';
  let status = '';
  let details = [];
  try {
    const body = await resp.json();
    msg = body?.error?.message || '';
    status = body?.error?.status || '';
    details = body?.error?.details || [];
  } catch {
    try { msg = await resp.text(); } catch { /* ignore */ }
  }
  return classifyError(resp.status, msg, status, details, resp.headers);
}

function classifyError(code, msg = '', status = '', details = [], headers = null) {
  const raw = `${msg} ${status}`.toLowerCase();

  if (code === 400 && /api key|api_key/.test(raw)) {
    return new AiError('Chave da API do Gemini inválida. Verifique a chave nas configurações da IA.', 401, 'invalid_key');
  }
  if (code === 401 || code === 403) {
    return new AiError('Chave da API do Gemini inválida ou sem permissão para este modelo. Verifique a chave nas configurações da IA.', 401, 'invalid_key');
  }
  if (code === 429 || /resource_exhausted|quota/.test(raw)) {
    const err = new AiError('Limite de uso (cota) da API do Gemini atingido. Aguarde um pouco ou escolha outro modelo nas configurações.', 429, 'quota');
    Object.assign(err, parseRetryInfo(details, headers));
    return err;
  }
  if (code === 404) {
    return new AiError('Modelo não encontrado na API do Gemini. Escolha outro modelo nas configurações da IA.', 404, 'model_not_found');
  }
  if (code >= 500) {
    const err = new AiError('O Gemini está instável ou sobrecarregado no momento. Tente novamente em instantes.', 502, 'overloaded');
    Object.assign(err, parseRetryInfo(details, headers));
    return err;
  }
  return new AiError(`Erro da API do Gemini (${code})${msg ? ': ' + msg.slice(0, 300) : ''}`, 502, 'upstream');
}

function networkError(err) {
  if (err?.name === 'AbortError') return new AiError('Requisição cancelada.', 499, 'aborted');
  if (err instanceof AiError) return err;
  // Só falha do fetch é "sem conexão"; o resto (arquivo, bug) aparece como é
  const isFetchFailure = err?.cause || /fetch failed|network|socket|ECONN|ENOTFOUND|ETIMEDOUT/i.test(String(err?.message));
  if (!isFetchFailure) {
    console.error('[AI] Erro interno:', err);
    return new AiError(`Erro interno no servidor: ${err?.message || err}`, 500, 'internal');
  }
  return new AiError(
    'Não foi possível conectar à API do Gemini. Verifique sua conexão com a internet.' +
    (err?.cause?.code ? ` (${err.cause.code})` : ''),
    502,
    'network'
  );
}
// #endregion

// #region Modelos
const modelsCache = new Map(); // apiKey → { at, models }

function scoreModel(id) {
  // Versão: gemini-2.5-pro → 2.5 ; gemini-pro-latest → 99 (alias do mais novo)
  const vm_ = id.match(/^gemini-(\d+(?:\.\d+)?)/);
  const version = vm_ ? parseFloat(vm_[1]) : (/latest/.test(id) ? 0.5 : 0);
  const tier = /-pro\b/.test(id) ? 3 : /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 0;
  const unstable = /preview|exp/.test(id) ? 1 : 0;
  const dated = /-\d{2}-\d{2}|-\d{3}$/.test(id) ? 1 : 0;
  return { version, tier, unstable, dated };
}

function compareModels(a, b) {
  const sa = scoreModel(a.id), sb = scoreModel(b.id);
  return (sb.version - sa.version)
    || (sb.tier - sa.tier)
    || (sa.unstable - sb.unstable)
    || (sa.dated - sb.dated)
    || a.id.localeCompare(b.id);
}

const EXCLUDE_MODEL = /embedding|aqa|imagen|image|tts|audio|live|robotics|computer-use|learnlm|gemma|veo|nano/i;

async function fetchModels(apiKey, { force = false, signal } = {}) {
  const cached = modelsCache.get(apiKey);
  if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) return cached.models;

  const all = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const url = `${baseUrl()}/v1beta/models?pageSize=200${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`;
    let resp;
    try {
      resp = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    } catch (err) {
      throw networkError(err);
    }
    if (!resp.ok) throw await upstreamError(resp);
    const body = await resp.json();
    all.push(...(body.models || []));
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }

  const models = all
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: String(m.name || '').replace(/^models\//, ''),
      displayName: m.displayName || '',
      inputTokenLimit: m.inputTokenLimit || null,
      outputTokenLimit: m.outputTokenLimit || null,
    }))
    .filter(m => /^gemini-/i.test(m.id) && !EXCLUDE_MODEL.test(m.id))
    .sort(compareModels);

  modelsCache.set(apiKey, { at: Date.now(), models });
  return models;
}

function pickDefaultModel(models) {
  const pro = models.filter(m => /^gemini-[\d.]+-pro/.test(m.id));
  if (pro.length) return pro[0].id; // já ordenado: mais novo, estável primeiro
  const flash = models.filter(m => /^gemini-[\d.]+-flash(?!-lite)/.test(m.id));
  if (flash.length) return flash[0].id;
  return models[0]?.id || '';
}
// #endregion

// #region Rotação de modelos
//
// Quando um modelo estoura a cota (429), está sobrecarregado (5xx) ou deixou de
// existir (404), ele entra em "espera" e a geração continua no próximo modelo.
// A espera usa o RetryInfo do Gemini; cota diária → horas; sem info → 60 s.

const ROTATABLE = new Set(['quota', 'overloaded', 'model_not_found']);
const ROTATE_DELAYS_MS  = [1500, 3000, 5000];   // pausa antes do próximo modelo (cresce a cada troca seguida)
const MAX_QUOTA_WAIT_MS = 2 * 60e3;             // espera máxima por uma janela de cota (limites por minuto)
const MAX_TOTAL_WAIT_MS = 6 * 60e3;             // soma das esperas num mesmo pedido

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
const cooldowns = new Map(); // `${fim da chave}|${modelo}` → { until, code }

function cooldownId(apiKey, model) { return `${String(apiKey).slice(-8)}|${model}`; }

function cooldownOf(apiKey, model) {
  const c = cooldowns.get(cooldownId(apiKey, model));
  if (!c) return null;
  if (c.until <= Date.now()) { cooldowns.delete(cooldownId(apiKey, model)); return null; }
  return c;
}

function coolDown(apiKey, model, err) {
  // Cota diária: o RetryInfo às vezes vem em segundos, mas só volta no outro dia
  if (err.code === 'quota' && err.scope === 'day') {
    cooldowns.set(cooldownId(apiKey, model), { until: Date.now() + Math.max(err.retryAfterMs || 0, 6 * 3600e3), code: err.code });
    return;
  }
  const ms = err.retryAfterMs
    || (err.code === 'model_not_found' ? 24 * 3600e3
      : err.code === 'quota' && err.scope === 'day' ? 6 * 3600e3
      : err.code === 'quota' ? 60e3
      : 20e3);
  cooldowns.set(cooldownId(apiKey, model), { until: Date.now() + ms, code: err.code });
}

function listCooldowns(apiKey) {
  const prefix = `${String(apiKey).slice(-8)}|`;
  const out = [];
  for (const [id, c] of cooldowns) {
    if (!id.startsWith(prefix) || c.until <= Date.now()) continue;
    out.push({ model: id.slice(prefix.length), secondsLeft: Math.ceil((c.until - Date.now()) / 1000), code: c.code });
  }
  return out;
}

/** Ordem de tentativa: o modelo escolhido primeiro; depois pro → flash → flash-lite, estáveis antes de preview */
function rotationOrder(primary, models) {
  const tier    = id => /-pro\b/.test(id) ? 3 : /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 2 : 0;
  const version = id => parseFloat((id.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const preview = id => /preview|exp/.test(id) ? 1 : 0;
  const ids = models
    .map(m => m.id)
    .filter(id => tier(id) > 0 && !/-\d{3}$|-\d{2}-\d{2}/.test(id)) // sem variantes datadas
    .sort((a, b) => tier(b) - tier(a) || preview(a) - preview(b) || version(b) - version(a));
  const fallback = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
  return [...new Set([primary, ...(ids.length ? ids : fallback)])].filter(Boolean).slice(0, 8);
}

function waitText(ms) {
  const s = Math.ceil(ms / 1000);
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

function rotationReason(err) {
  return err.code === 'quota' ? (err.scope === 'day' ? 'cota diária esgotada' : 'cota/limite atingido')
    : err.code === 'overloaded' ? 'sobrecarregado'
    : 'indisponível';
}
// #endregion

// #region Especificação (template-ia.html)
let specCache = { mtime: 0, text: '' };

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&ensp;|&nbsp;|&emsp;/g, ' ')
    .replace(/&rarr;/g, '→').replace(/&times;/g, '×')
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<\/(td|th)>/gi, ' | ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<h[1-4][^>]*>/gi, '\n\n## ')
      .replace(/<br\s*\/?>|<\/(p|tr|div|h[1-4]|li|header|section|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function loadSpec(root) {
  const file = path.join(root, 'templates', 'template-ia.html');
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  if (specCache.text && specCache.mtime === stat.mtimeMs) return specCache.text;

  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  let text = raw;
  try {
    // Corpo legível sem o CSS da página nem a demo interativa
    const body = (raw.match(/<body[^>]*>([\s\S]*?)<script/i) || [])[1] || '';
    const withoutDemo = body.replace(/<section id="demo">[\s\S]*?<\/section>/i, '');
    const specText = htmlToText(withoutDemo);

    // Template de referência: avalia o array TEMPLATE_SRC do próprio arquivo
    let reference = '';
    const m = raw.match(/var\s+TEMPLATE_SRC\s*=\s*(\[[\s\S]*?\]\.join\('\\n'\))\s*;/);
    if (m) reference = String(vm.runInNewContext(m[1], {}, { timeout: 500 }));

    if (specText && reference) {
      text = `${specText}\n\n## Template de referência completo (template-referencia.html)\n\n${reference}`;
    }
  } catch {
    text = raw;
  }

  specCache = { mtime: stat.mtimeMs, text };
  return text;
}
// #endregion

// #region Prompting
const PATCH_FORMAT = [
  'FORMATO DA RESPOSTA — EDIÇÃO POR BLOCOS (obrigatório; economiza tokens):',
  '- NÃO reescreva o documento. Responda SOMENTE com um ou mais blocos assim:',
  '<<<<<<< SEARCH',
  '(linhas copiadas EXATAMENTE do HTML atual, com a mesma indentação)',
  '=======',
  '(as linhas novas que substituem esse trecho)',
  '>>>>>>> REPLACE',
  '- Cada SEARCH deve ser curto (só as linhas que mudam) e ÚNICO no documento: se o trecho se repetir, inclua 1–2 linhas vizinhas de contexto.',
  '- Para INSERIR, use como SEARCH uma linha existente vizinha e repita-a no REPLACE junto com o conteúdo novo. Para REMOVER, deixe o REPLACE vazio.',
  '- Os blocos são aplicados em ordem, um após o outro; não sobreponha trechos. Faça todas as mudanças necessárias (CSS, HTML e JS) para o pedido funcionar.',
  '- Marcadores __MS_DATA_n__ representam dados base64 omitidos: nunca os altere nem os remova.',
  '- Só se o pedido exigir reescrever a maior parte do clipe, responda com o documento HTML completo (<!DOCTYPE html> … </html>) em vez de blocos.',
  '- Nada de explicações fora dos blocos.',
].join('\n');

/** spec vazia: o HTML de referência no pedido já demonstra o contrato (cenas encadeadas) */
function buildSystemInstruction({ spec, w, h, fps, mode = 'create' }) {
  return [
    'Você é um motion designer sênior e desenvolvedor front-end que escreve UM ÚNICO clipe de vídeo autocontido para o Motion Studio (formato "Video HTML").',
    spec
      ? 'Siga ESTRITAMENTE a especificação abaixo (contrato window.Motion, determinismo, layout).'
      : 'Siga ESTRITAMENTE o contrato window.Motion do HTML de referência enviado no pedido (determinismo, layout).',
    '',
    'Regras obrigatórias:',
    `- Resolução do projeto: ${w}×${h} px. html e body devem ter exatamente width:${w}px; height:${h}px; margin:0; overflow:hidden. Nunca use vw/vh como base do layout.`,
    `- Motion.config.fps = ${fps}; escolha durationInSeconds adequado ao pedido (padrão 5 s se não especificado) e totalFrames = fps * durationInSeconds. Escreva os valores de fps e durationInSeconds como números literais no objeto de config.`,
    '- Fundo transparente (background: transparent) a menos que o usuário peça explicitamente uma cena completa / fundo.',
    '- Todo o estado visual calculado dentro de seek(t), de forma pura e determinística. Proibido: requestAnimationFrame, setInterval, setTimeout dirigindo animação, Date.now(), performance.now(), Math.random() (use PRNG com seed fixa se precisar), transitions CSS, <video>, <audio>.',
    '- Google Fonts via <link> são permitidas (aguarde document.fonts.ready em whenReady).',
    '- VOCÊ PODE (e deve, quando enriquecer o resultado) usar BIBLIOTECAS EXTERNAS, EFEITOS e 3D: three.js (cenas 3D, modelos glTF/GLB, shaders, pós-processamento/bloom), GSAP, anime.js, Lottie, PixiJS, D3, canvas 2D, WebGL, filtros CSS/SVG, blend modes, partículas. Carregue de CDN https com versão fixa (cdn.jsdelivr.net, cdnjs.cloudflare.com ou unpkg.com); para three.js use importmap + <script type="module"> conforme a especificação. Imagens, texturas e modelos 3D por URL https com CORS são permitidos.',
    '- Toda biblioteca é DIRIGIDA por seek(t): timelines pausadas + seek, mixer.setTime(t), renderer.render() dentro de seek, uniforms de tempo = t. Nunca setAnimationLoop, autoplay, Clock/getDelta ou timeline tocando sozinha.',
    '- whenReady() deve resolver só depois que bibliotecas, modelos, texturas e fontes carregarem (o export fotografa logo em seguida). Para WebGL use preserveDrawingBuffer:true, alpha:true e setPixelRatio(1).',
    '- WebGL pode não existir no navegador do usuário (sem aceleração por hardware): crie o renderer dentro de try/catch e, se falhar, mantenha o clipe funcionando (renderer = null; seek pula o render 3D e continua animando textos/2D). Um erro no renderer nunca pode impedir que window.Motion seja definido.',
    '- Os tokens literais do validador (window.Motion, Motion.config, seek, renderFrame, whenReady, durationInSeconds, fps, totalFrames) devem aparecer no código.',
    '- Inclua <title> com um nome curto e descritivo do clipe (2 a 5 palavras, em português).',
    '- Capriche no design: tipografia forte, easing suave, entrada e saída animadas, composição equilibrada para a resolução.',
    mode === 'edit'
      ? PATCH_FORMAT
      : '- Responda SOMENTE com o documento HTML completo, começando em <!DOCTYPE html> e terminando em </html>. Sem explicações, sem markdown, sem cercas de código.',
    ...(spec ? [
      '',
      '===== ESPECIFICAÇÃO (templates/template-ia.html) =====',
      spec,
      '===== FIM DA ESPECIFICAÇÃO =====',
    ] : []),
  ].join('\n');
}

// Mesmos tipos de libs/sfx.js (o sintetizador do editor)
const SFX_TYPES = 'whoosh (passagem de ar), swipe (deslize curto), riser (subida de tensão; termina na revelação), impact (batida grave), bass (sub 808), pop (elemento surgindo), click (interface), tick (contador), typing (digitação; dur = tempo digitando), ding (sino/acerto), chime (brilho), success (conquista), notification (mensagem), coin (dinheiro/preço), glitch (ruído digital)';

/** Como escrever deixas de som: sintetizados (type) + biblioteca externa (sound) */
function sfxVocabulary(catalog) {
  return [
    `Sons sintetizados — use type: ${SFX_TYPES}.`,
    catalog
      ? `${catalog}\nCombine: sintetizados para movimento e impacto (whoosh, riser, impact, bass), biblioteca para ações e significados (notification, success, purchase, typing…), sempre do MESMO pacote.`
      : '',
    'Cada deixa tem type OU sound. gain 0.2–1 (padrão 0.8), pitch 0.5–2 (1 = normal), pan -1 (esquerda) a 1 (direita), dur em segundos (opcional).',
  ].filter(Boolean).join('\n');
}

/** Regras de efeitos sonoros (só quando o usuário ativa "Sons") */
function sfxRules(mode, catalog = '') {
  return [
    'EFEITOS SONOROS (ativado pelo usuário): declare os sons sincronizados com a animação em window.Motion.sfx —',
    'um array de { t, type | sound, gain?, pitch?, dur?, pan? } com t em segundos do clipe (mesmo relógio de seek).',
    sfxVocabulary(catalog),
    'O editor sintetiza os sons e cria a faixa de áudio sozinho: NÃO use <audio>, WebAudio, Tone.js nem arquivos de som.',
    'Um som por acontecimento visual relevante (entradas, revelações, números, transições, CTA), sem poluir: tipicamente 3 a 10 por clipe.',
    'Alinhe t ao instante exato do movimento (início de uma entrada = whoosh/swipe/pop; revelação = impact; riser começa antes e termina no impacto).',
    'Exemplo: window.Motion = { config: CONFIG, sfx: [{ t: 0.15, type: "whoosh" }, { t: 0.9, sound: "glass/notification", gain: 0.6 }, { t: 2.0, type: "riser", dur: 1.2 }, { t: 3.2, type: "impact" }], seek, renderFrame, whenReady };',
    mode === 'edit' ? 'Na edição: mantenha Motion.sfx coerente com as mudanças (crie se não existir, ajuste os tempos se a animação mudar).' : '',
  ].filter(Boolean).join('\n');
}

function buildUserPrompt({ mode, prompt, html, name, w, h, fps, playhead, sfx = false, sfxCatalog = '' }) {
  if (mode === 'edit') {
    // HTML antes do pedido: contexto longo primeiro, instrução no fim
    return [
      `HTML atual do clipe "${name || 'Clipe'}":`,
      html,
      '',
      `Projeto: ${w}×${h} px, ${fps} fps.`,
      'Preserve tudo o que não foi pedido para mudar e mantenha o contrato window.Motion.',
      'Responda com blocos SEARCH/REPLACE (veja o formato nas instruções).',
      sfx ? `\n${sfxRules('edit', sfxCatalog)}` : null,
      '',
      'Alteração pedida:',
      prompt,
    ].filter(x => x !== null).join('\n');
  }
  return [
    'Crie um novo clipe conforme o pedido abaixo.',
    `Projeto: ${w}×${h} px, ${fps} fps.` + (Number.isFinite(playhead) ? ` (O clipe será inserido em ${playhead.toFixed(2)} s da timeline.)` : ''),
    '',
    sfx ? `${sfxRules('create', sfxCatalog)}\n` : null,
    'Pedido:',
    prompt,
  ].filter(x => x !== null).join('\n');
}
// #endregion

// #region Pós-processamento
function extractHtml(text) {
  const src = String(text || '');
  const fence = src.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  let out = fence ? fence[1] : src;
  const lower = out.toLowerCase();
  let start = lower.indexOf('<!doctype');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0 && fence) start = 0;
  if (start < 0) {
    // Sem cerca e sem <html>: pode ter vindo truncado após o início do fence
    const open = src.match(/```(?:html)?\s*\n([\s\S]*)$/i);
    if (open) out = open[1];
    return out.trim();
  }
  const end = lower.lastIndexOf('</html>');
  out = end > start ? out.slice(start, end + 7) : out.slice(start);
  return out.trim();
}

function validateClip(html) {
  const fatal = [];
  const warnings = [];
  const src = String(html || '');

  // Mesmas regras de /api/motion/validate
  if (!src.includes('window.Motion'))      fatal.push('window.Motion não encontrado');
  if (!src.includes('Motion.config'))      fatal.push('Motion.config ausente');
  if (!src.includes('renderFrame'))       fatal.push('renderFrame ausente');
  if (!src.includes('seek'))              fatal.push('seek ausente');
  if (!src.includes('whenReady'))         fatal.push('whenReady ausente');
  if (!src.includes('durationInSeconds')) fatal.push('durationInSeconds ausente em config');
  if (!src.includes('fps'))               fatal.push('fps ausente em config');
  if (!src.includes('totalFrames'))       fatal.push('totalFrames ausente em config');

  if (!/<html[\s>]/i.test(src))           fatal.push('documento sem <html>');
  else if (!/<\/html>\s*$/i.test(src))    fatal.push('documento incompleto (sem </html> no final — resposta truncada?)');

  if (/\brequestAnimationFrame\s*\(/.test(src)) warnings.push('usa requestAnimationFrame (proibido: animação deve vir só de seek(t))');
  if (/\bsetInterval\s*\(/.test(src))           warnings.push('usa setInterval (proibido)');
  if (/\bDate\.now\s*\(/.test(src))             warnings.push('usa Date.now() (proibido)');
  if (/\bperformance\.now\s*\(/.test(src))      warnings.push('usa performance.now() (proibido)');
  if (/\bMath\.random\s*\(/.test(src))          warnings.push('usa Math.random() (use PRNG com seed fixa)');
  if (/<video[\s>]/i.test(src))                 warnings.push('contém <video> (proibido)');
  if (/<audio[\s>]/i.test(src))                 warnings.push('contém <audio> (proibido)');
  if (/\bsetAnimationLoop\s*\(/.test(src))      warnings.push('usa renderer.setAnimationLoop (renderize dentro de seek(t))');
  if (/new\s+THREE\.WebGLRenderer/.test(src) && !/try\s*\{[^]*?new\s+THREE\.WebGLRenderer/.test(src)) {
    warnings.push('WebGLRenderer criado fora de try/catch (sem WebGL o clipe inteiro quebra; crie com fallback)');
  }
  if (/autoplay\s*:\s*true/.test(src))          warnings.push('biblioteca com autoplay:true (pause e dirija por seek(t))');
  if (/\.getDelta\s*\(|new\s+THREE\.Clock/.test(src)) warnings.push('usa THREE.Clock/getDelta (use o t recebido em seek)');
  if (/<script[^>]+src=["']http:\/\//i.test(src)) warnings.push('script por http:// (use https)');
  if (/esm\.sh|skypack\.dev/i.test(src))        warnings.push('CDN esm.sh/skypack (imports absolutos quebram; use jsdelivr/unpkg)');

  return { fatal, warnings, issues: [...fatal, ...warnings] };
}

/**
 * Correções determinísticas que não justificam uma rodada de reparo:
 * o validador exige o literal "Motion.config", que some quando o config
 * é declarado dentro do objeto (window.Motion = { config: CONFIG, ... }).
 */
function autoFix(html) {
  let out = String(html || '');
  if (!out.includes('Motion.config') && /window\.Motion\s*=\s*\{[\s\S]*?\bconfig\s*:/.test(out)) {
    const idx = out.toLowerCase().lastIndexOf('</script>');
    if (idx >= 0) out = out.slice(0, idx) + '// window.Motion.config: { fps, durationInSeconds, totalFrames }\n' + out.slice(idx);
  }
  return out;
}

/**
 * Edição por blocos: aplica os SEARCH/REPLACE da resposta sobre o HTML atual.
 * Rodadas extras só quando precisa — blocos que não casaram → reenvio só
 * deles; problemas NOVOS no validador → blocos de correção; patch
 * irrecuperável → documento completo como último recurso.
 * `generate()` faz a próxima chamada com o histórico em `contents`.
 */
async function resolveEdit({ result, baseHtml, contents, send, generate }) {
  // Avisos que o clipe já tinha antes da edição não custam rodada de reparo
  const baseline = new Set(validateClip(baseHtml).issues);
  const edit = { mode: 'patch', blocks: 0, outputChars: 0, htmlChars: baseHtml.length };
  let doc = baseHtml;
  let repaired = false;

  const askAgain = async lines => {
    repaired = true;
    contents.push({ role: 'model', parts: [{ text: result.text }] });
    contents.push({ role: 'user', parts: [{ text: lines.filter(x => x !== null).join('\n') }] });
    result = await generate();
  };

  // Aplica a resposta atual (blocos ou documento completo) sobre `doc`
  const consume = () => {
    edit.outputChars += result.text.length;
    if (looksLikePatch(result.text)) {
      const { blocks, unterminated } = parsePatchBlocks(result.text);
      const out = applyPatchBlocks(doc, blocks);
      doc = out.html;
      edit.blocks += out.applied.length;
      return { failed: out.failed, unterminated, empty: !blocks.length };
    }
    const full = autoFix(extractHtml(result.text));
    if (/<html[\s>]/i.test(full)) {
      doc = full;
      edit.mode = 'full';
      return { failed: [], unterminated: false, empty: false };
    }
    return { failed: [], unterminated: false, empty: true };
  };
  const pending = s => s.failed.length || s.unterminated || s.empty;

  let step = consume();

  if (pending(step)) {
    send({ type: 'status', message: `Reajustando ${step.failed.length || 1} bloco(s) da edição…` });
    await askAgain([
      step.empty ? 'A resposta não trouxe blocos SEARCH/REPLACE válidos.' : 'Alguns blocos não puderam ser aplicados:',
      ...step.failed.map(f => `- Bloco ${f.index + 1}: ${f.error}. SEARCH enviado:\n${f.search}`),
      step.unterminated ? '- O último bloco ficou incompleto (sem a linha >>>>>>> REPLACE).' : null,
      '',
      step.empty ? null : 'Os demais blocos JÁ FORAM aplicados — não os repita.',
      'Reenvie SOMENTE os blocos que faltam, copiando cada SEARCH exatamente do HTML atual abaixo:',
      doc,
    ]);
    step = consume();
  }

  if (pending(step)) {
    send({ type: 'status', message: 'Blocos não aplicáveis — pedindo o clipe completo…' });
    doc = baseHtml;
    edit.blocks = 0;
    await askAgain([
      'Ainda não foi possível aplicar os blocos.',
      'Retorne agora o documento HTML COMPLETO (de <!DOCTYPE html> até </html>), partindo do HTML original do início da conversa e já com TODAS as alterações pedidas. Sem explicações.',
    ]);
    step = consume();
    if (pending(step)) {
      throw new AiError('Não foi possível aplicar a edição da IA ao clipe. Tente reformular o pedido.', 422, 'patch_failed');
    }
  }

  let check = validateClip(doc);
  const fresh = check.issues.filter(i => check.fatal.includes(i) || !baseline.has(i));
  if (fresh.length) {
    send({ type: 'status', message: `Corrigindo ${fresh.length} problema(s) da edição…`, issues: fresh });
    const before = doc;
    await askAgain([
      'O HTML resultante tem problemas em relação à especificação:',
      ...fresh.map(i => `- ${i}`),
      result.finishReason === 'MAX_TOKENS' ? '- A resposta foi cortada por limite de tamanho: seja mais enxuto.' : null,
      '',
      'Corrija TODOS com blocos SEARCH/REPLACE sobre o HTML atual abaixo:',
      doc,
    ]);
    const fixStep = consume();
    const fixedCheck = validateClip(doc);
    // Mantém a versão anterior se a correção não aplicou ou piorou
    if (fixStep.empty || fixedCheck.fatal.length > check.fatal.length) doc = before;
    else check = fixedCheck;
  }

  check = { ...check, warnings: check.warnings.filter(w => !baseline.has(w)) };
  return { html: doc, check, repaired, edit };
}

function extractDurationSec(html) {
  const direct = html.match(/durationInSeconds\s*:\s*([\d.]+)/);
  if (direct) return parseFloat(direct[1]);
  const ref = html.match(/durationInSeconds\s*:\s*([A-Za-z_$][\w$]*)/);
  if (ref) {
    const decl = html.match(new RegExp(`(?:const|let|var)\\s+${ref[1].replace(/\$/g, '\\$')}\\s*=\\s*([\\d.]+)`));
    if (decl) return parseFloat(decl[1]);
  }
  return null;
}

function extractTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
}

function cleanName(s) {
  return String(s || '')
    .replace(/\.html?$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function nameFromPrompt(prompt) {
  const words = String(prompt || '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().split(/\s+/).slice(0, 4).join(' ');
  return cleanName(words) || 'Clipe IA';
}
// #endregion

// #region Chamada ao Gemini (streaming SSE)
async function streamGemini({ apiKey, model, systemText, contents, maxOutputTokens, signal, onText, config }) {
  const url = `${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const generationConfig = { temperature: 0.7, ...config };
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig,
      }),
      signal,
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!resp.ok) throw await upstreamError(resp);

  let text = '';
  let finishReason = '';
  let blockReason = '';
  let usage = null;
  let buf = '';
  const decoder = new TextDecoder();

  const handleEvent = data => {
    if (!data || data === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    if (obj.error) throw classifyError(Number(obj.error.code) || 500, obj.error.message || '', obj.error.status || '', obj.error.details || []);
    if (obj.promptFeedback?.blockReason) blockReason = obj.promptFeedback.blockReason;
    if (obj.usageMetadata) usage = obj.usageMetadata;   // acumulado: o último evento vale
    const cand = obj.candidates?.[0];
    if (cand?.finishReason) finishReason = cand.finishReason;
    for (const part of cand?.content?.parts || []) {
      if (part.thought) continue;
      if (typeof part.text === 'string' && part.text) {
        text += part.text;
        onText?.(text.length);
      }
    }
  };

  try {
    for await (const chunk of resp.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      // Eventos SSE separados por linha em branco
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/)
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^ /, ''))
          .join('\n');
        handleEvent(data);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      handleEvent(buf.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'));
    }
  } catch (err) {
    throw networkError(err);
  }

  if (blockReason) {
    throw new AiError(`O Gemini bloqueou o pedido por política de segurança (${blockReason}). Reformule o pedido.`, 422, 'safety');
  }
  if (!text.trim()) {
    if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finishReason)) {
      throw new AiError(`O Gemini bloqueou a resposta (${finishReason}). Reformule o pedido.`, 422, 'safety');
    }
    throw new AiError('O Gemini retornou uma resposta vazia. Tente novamente ou reformule o pedido.', 502, 'empty');
  }
  return { text, finishReason, usage };
}
// #endregion

// #region Execução com rotação de modelos
/** Resposta NDJSON; aborta a chamada ao Gemini se o cliente desconectar */
function openNdjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) { closed = true; controller.abort(); }
  });
  const send = obj => { if (!closed) res.write(JSON.stringify(obj) + '\n'); };
  const finish = obj => { send(obj); if (!closed) res.end(); };
  return { send, finish, signal: controller.signal };
}

/**
 * Chave, modelos e ordem de rotação de um pedido. run() tenta os modelos em
 * ordem: cota/sobrecarga/404 → cooldown + próximo. `startAt` mantém as rodadas
 * de correção no modelo que funcionou. runner.model/rotated/usage acumulam.
 */
async function createRunner({ store, send, signal }) {
  const cfg = store.get();
  if (!cfg.apiKey) throw new AiError(NO_KEY_MESSAGE, 400, 'no_key');

  let models = [];
  try { models = await fetchModels(cfg.apiKey, { signal }); } catch (err) {
    if (err?.code === 'invalid_key' || err?.code === 'aborted') throw err;
    // Lista indisponível: segue com o modelo configurado/padrão
  }
  const primary = cfg.model || pickDefaultModel(models) || 'gemini-2.5-flash';
  const order = cfg.autoRotate ? rotationOrder(primary, models) : [primary];
  const maxTokensFor = id => {
    const info = models.find(m => m.id === id);
    return info?.outputTokenLimit ? Math.min(info.outputTokenLimit, 65536) : undefined;
  };

  let lastProgress = 0;
  const onText = chars => {
    const now = Date.now();
    if (now - lastProgress > 200) { lastProgress = now; send({ type: 'progress', chars }); }
  };

  const runner = {
    order,
    model: primary,
    rotated: [],
    usage: { input: 0, output: 0, rounds: 0 },
  };

  /**
   * Tenta os modelos em ordem. Erro de cota/sobrecarga: põe o modelo em espera,
   * pausa um pouco (ROTATE_DELAYS_MS) e tenta o próximo — sem martelar a API.
   * Todos em espera por pouco tempo (limite por minuto): aguarda a janela
   * reabrir e tenta de novo, começando pelo modelo que libera primeiro.
   */
  runner.run = async ({ systemText, contents, verb = 'Gerando', startAt = order[0], config }) => {
    let waited = 0;
    let switches = 0;
    for (;;) {
      const queue = [startAt, ...order.filter(id => id !== startAt)];
      let earliest = Infinity;
      let earliestModel = null;
      const noteCooldown = id => {
        const until = cooldownOf(cfg.apiKey, id)?.until;
        if (until && until < earliest) { earliest = until; earliestModel = id; }
      };

      for (const candidate of queue) {
        if (cooldownOf(cfg.apiKey, candidate)) { noteCooldown(candidate); continue; }
        try {
          send({ type: 'status', message: `${verb} com ${candidate}…`, model: candidate });
          lastProgress = 0;
          const out = await streamGemini({
            apiKey: cfg.apiKey, model: candidate, systemText, contents, config,
            maxOutputTokens: maxTokensFor(candidate), signal, onText,
          });
          runner.model = candidate;
          runner.usage.input  += Number(out.usage?.promptTokenCount) || 0;
          runner.usage.output += (Number(out.usage?.candidatesTokenCount) || 0) + (Number(out.usage?.thoughtsTokenCount) || 0);
          runner.usage.rounds += 1;
          return out;
        } catch (err) {
          const e = networkError(err);
          if (!ROTATABLE.has(e.code)) throw e;
          coolDown(cfg.apiKey, candidate, e);
          noteCooldown(candidate);
          runner.rotated.push({ model: candidate, reason: rotationReason(e) });
          const next = queue.slice(queue.indexOf(candidate) + 1).find(id => !cooldownOf(cfg.apiKey, id));
          console.warn(`[AI] ${candidate}: ${rotationReason(e)}${next ? ` — próximo: ${next}` : ''}`);
          if (!next) break;
          const delay = ROTATE_DELAYS_MS[Math.min(switches++, ROTATE_DELAYS_MS.length - 1)];
          send({ type: 'status', message: `${candidate}: ${rotationReason(e)} — tentando ${next} em ${Math.round(delay / 1000)}s…`, rotatedFrom: candidate });
          await sleepAbortable(delay, signal);
        }
      }

      // Todos em espera: se a janela reabre logo (limite por minuto), aguarda e tenta de novo
      const wait = earliest - Date.now();
      if (Number.isFinite(wait) && wait <= MAX_QUOTA_WAIT_MS && waited + wait <= MAX_TOTAL_WAIT_MS) {
        const total = Math.max(1000, wait + 750);
        const end = Date.now() + total;
        while (Date.now() < end) {
          const left = Math.ceil((end - Date.now()) / 1000);
          send({ type: 'status', message: `Limite de uso atingido em todos os modelos — nova tentativa em ${left}s…`, waiting: left });
          await sleepAbortable(Math.min(1000, end - Date.now()), signal);
        }
        waited += total;
        startAt = earliestModel || order[0];
        continue;
      }

      const waitMsg = Number.isFinite(earliest) ? ` Tente de novo em ~${waitText(earliest - Date.now())}.` : '';
      throw new AiError(
        `Todos os modelos disponíveis estão sem cota ou sobrecarregados (${order.join(', ')}).${waitMsg}`,
        429, 'all_models_exhausted'
      );
    }
  };

  return runner;
}
// #endregion

// #region Cenas a partir de áudio
// Fluxo: o editor transcreve o áudio → /api/ai/scenes/plan divide em cenas e
// fixa UM guia de estilo (paleta, fontes, :root) → cada cena é gerada em
// /api/ai/generate com body.scene, em ordem. A 1ª (âncora) sai completa com o
// guia; as seguintes recebem o HTML da anterior (scene.previous) e respondem só
// com blocos SEARCH/REPLACE sobre ele: herdam <head>, :root, fontes e helpers
// sem reescrevê-los e continuam do quadro onde a anterior terminou.

const SCENE_LENGTHS = {
  auto:   'entre 3 e 12 s, cortando onde a ideia/assunto da fala muda',
  short:  'curtas, entre 3 e 5 s (ritmo rápido, estilo reels)',
  medium: 'médias, entre 6 e 10 s',
  long:   'longas, entre 12 e 20 s',
  single: 'UMA ÚNICA cena cobrindo o áudio inteiro',
};
const MAX_SCENES = 40;
const MAX_PREVIOUS_HTML = 300_000;

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    style: {
      type: 'OBJECT',
      properties: {
        name:        { type: 'STRING' },
        description: { type: 'STRING' },
        background:  { type: 'STRING' },
        surface:     { type: 'STRING' },
        primary:     { type: 'STRING' },
        secondary:   { type: 'STRING' },
        accent:      { type: 'STRING' },
        text:        { type: 'STRING' },
        fontHeading: { type: 'STRING' },
        fontBody:    { type: 'STRING' },
        motion:      { type: 'STRING' },
        motifs:      { type: 'STRING' },
      },
      required: ['name', 'description', 'background', 'surface', 'primary', 'secondary', 'accent', 'text', 'fontHeading', 'fontBody', 'motion', 'motifs'],
    },
    scenes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start:        { type: 'NUMBER' },
          end:          { type: 'NUMBER' },
          title:        { type: 'STRING' },
          visual:       { type: 'STRING' },
          onScreenText: { type: 'STRING' },
        },
        required: ['start', 'end', 'title', 'visual'],
      },
    },
  },
  required: ['style', 'scenes'],
};

const PLAN_SYSTEM = [
  'Você é diretor de arte e roteirista de motion graphics. Recebe a transcrição de um áudio (com o tempo de cada fala) e planeja um vídeo em cenas que acompanham a narração.',
  'Responda SOMENTE com JSON no formato pedido.',
  '- style: UM estilo visual para o vídeo inteiro. Cores em hexadecimal #rrggbb com bom contraste (text sobre background legível). fontHeading e fontBody: nomes EXATOS de famílias do Google Fonts. motion: linguagem de movimento (easing, ritmo, tipo de transição de entrada/saída) que TODAS as cenas repetem. motifs: elementos gráficos recorrentes (formas, texturas, ícones, grafismos) que dão identidade.',
  '- scenes: em ordem, cobrindo o áudio de 0 até a duração total, sem buracos e sem sobreposição (end de uma = start da próxima). Corte nas pausas entre falas, nunca no meio de uma frase. title: 2 a 5 palavras. visual: o que a cena mostra (composição, elementos, animação), ilustrando o que está sendo dito. onScreenText: texto curto que aparece na tela (pode ser vazio).',
  '- As cenas formam UM vídeo coerente: mesma paleta, tipografia e linguagem de movimento; varie a composição entre cenas para não ficar repetitivo.',
].join('\n');

const SFX_SYSTEM = [
  'Você é sound designer de motion graphics e vídeos curtos. Recebe clipes de uma timeline (código HTML animado, ou quadros de vídeo/imagem com o instante de cada um) e o contexto ao redor.',
  'Sua tarefa: criar os efeitos sonoros de cada clipe, sincronizados com o que acontece na tela.',
  '- Leia o código HTML para achar os instantes exatos: delays/durações de timelines (GSAP, keyframes, seek(t)), entradas de títulos, revelações, números, trocas de cena, CTA.',
  '- Um som por acontecimento visual relevante; nada de trilha contínua nem sons a cada frame. Tipicamente 3 a 10 por clipe; deixe respiro.',
  '- Entrada de elemento = whoosh/swipe/pop; revelação ou logo = impact (riser antes, terminando no impacto); preço/dinheiro = coin ou commerce/*; mensagem = notification; digitação = typing com dur.',
  '- Com narração ou legendas no mesmo trecho, mantenha gain ≤ 0.45 e evite sons longos por cima das falas.',
  '- Coerência: escolha UM pacote da biblioteca para todos os clipes (combine com o estilo visual) e use-o em todo sound.',
  '- Responda SOMENTE com JSON no formato pedido. t sempre no relógio indicado para cada clipe.',
].join('\n');

const SFX_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pack: { type: 'STRING' },
    clips: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          cues: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                t: { type: 'NUMBER' }, type: { type: 'STRING' }, sound: { type: 'STRING' },
                gain: { type: 'NUMBER' }, pitch: { type: 'NUMBER' }, dur: { type: 'NUMBER' }, pan: { type: 'NUMBER' },
              },
              required: ['t'],
            },
          },
        },
        required: ['id', 'cues'],
      },
    },
  },
  required: ['clips'],
};

function buildSfxPrompt({ clips, context, pack, prompt, catalog }) {
  const ctx = context || {};
  const lines = [
    sfxVocabulary(catalog),
    pack ? `Pacote já escolhido para este vídeo (mantenha): ${pack}.` : '',
    prompt ? `Pedido do usuário: ${String(prompt).slice(0, 500)}` : '',
    '',
    'CONTEXTO NA TIMELINE (segundos absolutos da timeline):',
    (ctx.neighbors || []).length
      ? (ctx.neighbors || []).slice(0, 30).map(n => `- ${n.kind} "${String(n.label || '').slice(0, 60)}" de ${fmtSec(n.start)} a ${fmtSec(n.end)} s (track ${n.track})`).join('\n')
      : '- (nenhum outro clip por perto)',
    (ctx.speech || []).length
      ? `Falas/legendas no trecho:\n${(ctx.speech || []).slice(0, 60).map(s => `[${fmtSec(s.start)}–${fmtSec(s.end)}] ${String(s.text || '').slice(0, 120)}`).join('\n')}`
      : '',
    ctx.narration ? 'Há narração/música por baixo: sons discretos.' : '',
    '',
    'CLIPES:',
  ];
  clips.forEach(c => {
    lines.push(`### id ${c.id} — ${c.kind} "${c.label}", na timeline de ${fmtSec(c.start)} a ${fmtSec(c.start + c.duration)} s (${fmtSec(c.duration)} s)`);
    if (c.timeBase === 'source') {
      lines.push(`Relógio de t: segundos do HTML (o mesmo de seek). Trecho usado: ${fmtSec(c.sourceStart)} a ${fmtSec(c.sourceEnd)} s.`);
    } else {
      lines.push(`Relógio de t: segundos desde o início do clipe (0 a ${fmtSec(c.duration)}).`);
    }
    if (c.html) lines.push('Código:', c.html);
    if (c.frames.length) lines.push(`Quadros anexados (${c.frames.length}) com os instantes: ${c.frames.map(f => fmtSec(f.t)).join(', ')} s.`);
  });
  lines.push('', 'Responda com { pack, clips: [{ id, cues: [...] }] } cobrindo todos os ids.');
  return lines.filter(x => x !== '').join('\n');
}

function fmtSec(t) {
  return Number(t).toFixed(2);
}

function buildPlanPrompt({ duration, segments, styleMode, styleText, brief, sceneLength, background }) {
  const lines = segments.map(s => `[${fmtSec(s.start)}–${fmtSec(s.end)}] (${fmtSec(s.end - s.start)}s) ${s.text}`);
  return [
    `Duração total do áudio: ${fmtSec(duration)} s.`,
    `Tamanho das cenas: ${SCENE_LENGTHS[sceneLength]}.`,
    background === 'transparent'
      ? 'As cenas serão sobrepostas a um vídeo: fundo transparente; "background" é só a cor de apoio para painéis.'
      : 'As cenas são o vídeo inteiro: fundo opaco usando a cor "background".',
    styleMode === 'custom'
      ? `Estilo pedido pelo usuário (converta em paleta/fontes concretas, fiel ao pedido):\n${styleText}`
      : 'Estilo: crie um estilo original e marcante que combine com o conteúdo e o tom da fala.',
    brief ? `Briefing do vídeo:\n${brief}` : null,
    '',
    'Transcrição (tempos em segundos desde o início do áudio):',
    lines.length ? lines.join('\n') : '(sem fala detectada — planeje cenas pela duração)',
  ].filter(x => x !== null).join('\n');
}

function parseJsonLoose(text) {
  const src = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(src); } catch (_) { /* tenta recortar */ }
  const a = src.indexOf('{');
  const b = src.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(src.slice(a, b + 1)); } catch (_) { return null; }
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const STYLE_FALLBACK = {
  background: '#0b0d12', surface: '#161a22', primary: '#82ea00',
  secondary: '#3aa0ff', accent: '#ffcc00', text: '#ffffff',
};

function cleanFont(name, fallback) {
  const out = String(name || '').replace(/['"]/g, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return out || fallback;
}

/** Link do Google Fonts que realmente existe (fontes sem peso 900/700 dão 400 no css2) */
async function resolveFontsLink(families) {
  const variants = [':wght@400;700;900', ':wght@400;700', ''];
  for (const v of variants) {
    const url = 'https://fonts.googleapis.com/css2?' +
      [...new Set(families)].map(f => `family=${encodeURIComponent(f).replace(/%20/g, '+')}${v}`).join('&') + '&display=swap';
    try {
      const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
      if (r.ok) return url;
    } catch (_) {
      return url;   // sem internet aqui: o navegador tenta mesmo assim
    }
  }
  return 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&family=Inter:wght@400;700&display=swap';
}

async function normalizeStyle(raw, { background }) {
  const style = { name: String(raw.name || 'Estilo do vídeo').slice(0, 60) };
  for (const key of Object.keys(STYLE_FALLBACK)) {
    const v = String(raw[key] || '').trim();
    style[key] = HEX_RE.test(v) ? v.toLowerCase() : STYLE_FALLBACK[key];
  }
  style.fontHeading = cleanFont(raw.fontHeading, 'Montserrat');
  style.fontBody    = cleanFont(raw.fontBody, 'Inter');
  style.description = String(raw.description || '').slice(0, 800);
  style.motion      = String(raw.motion || '').slice(0, 500);
  style.motifs      = String(raw.motifs || '').slice(0, 500);
  style.backgroundMode = background;
  style.fontsLink = await resolveFontsLink([style.fontHeading, style.fontBody]);
  // Bloco idêntico em todas as cenas: a coerência não depende da IA "lembrar" as cores
  style.css = [
    ':root {',
    `  --ms-bg: ${style.background};`,
    `  --ms-surface: ${style.surface};`,
    `  --ms-primary: ${style.primary};`,
    `  --ms-secondary: ${style.secondary};`,
    `  --ms-accent: ${style.accent};`,
    `  --ms-text: ${style.text};`,
    `  --ms-font-heading: '${style.fontHeading}', sans-serif;`,
    `  --ms-font-body: '${style.fontBody}', sans-serif;`,
    '}',
  ].join('\n');
  return style;
}

/**
 * Cenas contíguas de 0 até a duração, com cortes encaixados nas pausas da fala
 * (até 0,75 s de distância) e sem cenas minúsculas.
 */
function normalizePlanScenes(rawScenes, { duration, segments, sceneLength }) {
  const D = duration;
  const MIN = Math.min(1.2, D);
  let scenes = (Array.isArray(rawScenes) ? rawScenes : [])
    .map(s => ({
      start: Number(s.start), end: Number(s.end),
      title: String(s.title || '').trim().slice(0, 60),
      visual: String(s.visual || '').trim().slice(0, 1200),
      onScreenText: String(s.onScreenText || '').trim().slice(0, 300),
    }))
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);

  if (sceneLength === 'single' && scenes.length > 1) {
    scenes = [{ ...scenes[0], visual: scenes.map(s => s.visual).join(' Depois: '), onScreenText: scenes[0].onScreenText }];
  }
  if (!scenes.length) scenes = [{ start: 0, end: D, title: 'Cena 1', visual: '', onScreenText: '' }];

  // Pontos de corte "naturais": meio das pausas entre falas
  const cuts = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const gapA = segments[i].end;
    const gapB = segments[i + 1].start;
    if (gapB >= gapA) cuts.push((gapA + gapB) / 2);
  }

  // Corte que já cai numa pausa fica; no meio de uma fala vai para a pausa mais próxima
  const inSpeech = t => segments.some(seg => t > seg.start + 0.05 && t < seg.end - 0.05);
  const bounds = scenes.slice(1).map(s => Math.min(D, Math.max(0, s.start)));
  const snapped = bounds.map(b => {
    if (!inSpeech(b)) return b;
    let best = b;
    let bestDist = 0.75;
    for (const c of cuts) {
      if (Math.abs(c - b) <= bestDist) { best = c; bestDist = Math.abs(c - b); }
    }
    return best;
  });

  let out = scenes.map((s, i) => ({
    ...s,
    start: i === 0 ? 0 : snapped[i - 1],
    end:   i === scenes.length - 1 ? D : snapped[i],
  }));

  // Junta cenas curtas demais (ou invertidas) na anterior
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.end - s.start < MIN) {
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    if (prev) s.start = prev.end;
    merged.push(s);
  }
  if (merged.length > 1 && merged[0].end - merged[0].start < MIN) {
    merged[1].start = 0;
    merged.shift();
  }
  out = merged.slice(0, MAX_SCENES);
  out[out.length - 1].end = D;

  return out.map((s, i) => ({
    ...s,
    start: +s.start.toFixed(3),
    end: +s.end.toFixed(3),
    title: s.title || `Cena ${i + 1}`,
    speech: segments
      .filter(seg => seg.end > s.start && seg.start < s.end)
      .map(seg => ({
        start: +Math.max(0, seg.start - s.start).toFixed(2),
        end:   +Math.min(s.end - s.start, seg.end - s.start).toFixed(2),
        text:  seg.text,
      })),
  }));
}

/** Valida body.scene do /api/ai/generate */
function normalizeSceneRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const duration = Number(raw.duration);
  if (!(duration > 0) || !raw.style) return null;
  const st = raw.style;
  const prev = raw.previous;
  const prevHtml = typeof prev?.html === 'string' ? prev.html : '';
  return {
    index: Math.max(0, Math.round(+raw.index || 0)),
    total: Math.max(1, Math.round(+raw.total || 1)),
    duration: +duration.toFixed(3),
    title: String(raw.title || '').slice(0, 60),
    visual: String(raw.visual || '').slice(0, 1200),
    onScreenText: String(raw.onScreenText || '').slice(0, 300),
    speech: (Array.isArray(raw.speech) ? raw.speech : []).slice(0, 200)
      .map(s => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').slice(0, 400) })),
    outline: (Array.isArray(raw.outline) ? raw.outline : []).slice(0, MAX_SCENES)
      .map(o => ({ start: +o.start || 0, end: +o.end || 0, title: String(o.title || '').slice(0, 60) })),
    brief: String(raw.brief || '').slice(0, 2000),
    style: {
      name: String(st.name || '').slice(0, 60),
      description: String(st.description || '').slice(0, 800),
      motion: String(st.motion || '').slice(0, 500),
      motifs: String(st.motifs || '').slice(0, 500),
      fontHeading: cleanFont(st.fontHeading, 'Montserrat'),
      fontBody: cleanFont(st.fontBody, 'Inter'),
      fontsLink: /^https:\/\/fonts\.googleapis\.com\/css2\?[^"'<>\s]+$/.test(st.fontsLink || '') ? st.fontsLink : '',
      css: /^:root \{[^<>{}]*\}$/.test(String(st.css || '').trim()) ? String(st.css).trim() : '',
      backgroundMode: st.backgroundMode === 'transparent' ? 'transparent' : 'full',
    },
    // HTML da cena anterior (a nova cena é uma edição dele); grande demais = cena completa
    previous: /<html[\s>]/i.test(prevHtml) && prevHtml.length <= MAX_PREVIOUS_HTML
      ? {
          html: prevHtml,
          index: Math.max(0, Math.round(+prev.index || 0)),
          title: String(prev.title || '').slice(0, 60),
          duration: Math.max(0, +prev.duration || 0),
        }
      : null,
  };
}

/**
 * Prompt de uma cena. Tudo que é igual entre as cenas (guia de estilo,
 * briefing, roteiro) vem primeiro: o prefixo repetido aproveita o cache
 * implícito do Gemini nas chamadas seguintes.
 */
function buildScenePrompt({ scene, prompt, fps, sfx = false, sfxCatalog = '' }) {
  const st = scene.style;
  const D = scene.duration;
  const prev = scene.outline[scene.index - 1];
  const next = scene.outline[scene.index + 1];
  return [
    `GUIA DE ESTILO DO VÍDEO "${st.name}" — obrigatório e idêntico em todas as cenas (coerência entre clipes):`,
    st.description,
    `Movimento (repita em todas as cenas): ${st.motion}`,
    `Elementos recorrentes: ${st.motifs}`,
    'Cole EXATAMENTE estas duas linhas no <head> e use SOMENTE as variáveis CSS abaixo para cores e fontes (sem cores fora da paleta; tons derivados com color-mix/opacidade são ok):',
    st.fontsLink ? `<link rel="stylesheet" href="${st.fontsLink}">` : '',
    `<style>\n${st.css}\n</style>`,
    st.backgroundMode === 'transparent'
      ? 'Fundo: TRANSPARENTE (a cena vai sobre um vídeo); use var(--ms-surface)/var(--ms-bg) só em painéis e faixas.'
      : 'Fundo: cena completa e OPACA preenchendo todo o quadro com var(--ms-bg) (pode ter gradientes/texturas da paleta).',
    scene.brief ? `Briefing do vídeo: ${scene.brief}` : '',
    'Roteiro completo (para contexto):',
    scene.outline.map((o, i) => `${i + 1}. [${fmtSec(o.start)}–${fmtSec(o.end)}] ${o.title}`).join('\n'),
    '',
    `===== CENA ${scene.index + 1} DE ${scene.total}: "${scene.title}" =====`,
    `Duração EXATA: ${D} s → no config escreva literalmente durationInSeconds: ${D} e totalFrames: ${Math.round(D * fps)} (fps ${fps}).`,
    `O que mostrar: ${scene.visual || 'ilustre o que está sendo dito.'}`,
    scene.onScreenText ? `Texto na tela: ${scene.onScreenText}` : '',
    'Fala durante esta cena (segundos desde o início DESTA cena). Sincronize as entradas dos elementos com esses momentos:',
    scene.speech.length
      ? scene.speech.map(s => `[${fmtSec(s.start)}–${fmtSec(s.end)}] ${s.text}`).join('\n')
      : '(sem fala nesta cena)',
    `Encadeamento: ${prev ? `vem depois de "${prev.title}"` : 'é a abertura do vídeo'}; ${next ? `antes de "${next.title}"` : 'é o encerramento'}. A saída desta cena e a entrada da próxima usam a mesma linguagem de movimento.`,
    'Não escreva a fala inteira na tela (legendas são feitas à parte): destaque só palavras-chave, números e ideias.',
    sfx ? sfxRules('create', sfxCatalog) : '',
    scene.total > 1 ? ANCHOR_RULES : '',
    prompt ? `Pedido adicional: ${prompt}` : '',
    `Inclua <title>${scene.title}</title>.`,
  ].filter(Boolean).join('\n');
}

// A âncora vira o ponto de partida das próximas: código organizado = blocos menores
const ANCHOR_RULES = [
  'CENA-ÂNCORA: as próximas cenas do vídeo serão criadas EDITANDO este HTML. Capriche nos detalhes e organize o código para ser reaproveitado:',
  '- <head> com o link das fontes e o :root; CSS base de componentes reutilizáveis (títulos, destaques, cards, grafismos recorrentes) separado do CSS específico desta cena.',
  '- Helpers (easing, interpolação, PRNG) e o contrato window.Motion separados do conteúdo; o DOM desta cena num bloco próprio e a timeline desta cena numa função própria chamada por seek(t).',
].join('\n');

/**
 * Cena 2+ : o HTML da anterior vem primeiro (contexto longo antes da
 * instrução) e a resposta são blocos SEARCH/REPLACE sobre ele. Sem guia de
 * estilo nem especificação: a referência já carrega os dois.
 */
function buildSceneContinuePrompt({ scene, previousHtml, prompt, fps, sfx = false, sfxCatalog = '' }) {
  const D = scene.duration;
  const prev = scene.previous;
  const next = scene.outline[scene.index + 1];
  return [
    `HTML da cena ${prev.index + 1} ("${prev.title}", ${fmtSec(prev.duration)} s) — REFERÊNCIA do vídeo:`,
    previousHtml,
    '',
    'Roteiro completo:',
    scene.outline.map((o, i) => `${i + 1}. [${fmtSec(o.start)}–${fmtSec(o.end)}] ${o.title}`).join('\n'),
    scene.brief ? `Briefing do vídeo: ${scene.brief}` : '',
    '',
    `===== CENA ${scene.index + 1} DE ${scene.total}: "${scene.title}" =====`,
    'Crie esta cena EDITANDO o HTML de referência com blocos SEARCH/REPLACE (formato nas instruções):',
    '- Mantenha IDÊNTICOS o <head> (link das fontes e :root com as variáveis --ms-*), o CSS base, os helpers e o contrato window.Motion: são a identidade do vídeo.',
    '- Troque o que é da cena: o DOM, o CSS específico e a timeline em seek(t). A composição é NOVA (não repita o layout da referência); paleta, fontes, grafismos e linguagem de movimento continuam os mesmos.',
    `- Continuidade: esta cena começa onde a referência termina (t = ${fmtSec(prev.duration)} s nela). Veja o que sai, o que fica na tela e como está o fundo, e faça o quadro t = 0 desta cena partir desse estado — o corte entre os clipes deve parecer uma transição única, sem salto de fundo nem de elementos.`,
    `- Duração EXATA: ${D} s → no config, durationInSeconds: ${D} e totalFrames: ${Math.round(D * fps)} (fps ${fps}).`,
    `- Troque o <title> por <title>${scene.title}</title>.`,
    '',
    `O que mostrar: ${scene.visual || 'ilustre o que está sendo dito.'}`,
    scene.onScreenText ? `Texto na tela: ${scene.onScreenText}` : '',
    'Fala durante esta cena (segundos desde o início DESTA cena). Sincronize as entradas dos elementos com esses momentos:',
    scene.speech.length
      ? scene.speech.map(s => `[${fmtSec(s.start)}–${fmtSec(s.end)}] ${s.text}`).join('\n')
      : '(sem fala nesta cena)',
    next
      ? `Depois desta vem "${next.title}": termine com a saída na linguagem de movimento do vídeo.`
      : 'É o encerramento do vídeo: feche com um final claro.',
    'Não escreva a fala inteira na tela (legendas são feitas à parte): destaque só palavras-chave, números e ideias.',
    sfx ? `${sfxRules('edit', sfxCatalog)}\nReescreva Motion.sfx para ESTA cena (os sons da referência não valem aqui).` : '',
    prompt ? `Pedido adicional: ${prompt}` : '',
  ].filter(Boolean).join('\n');
}

/** Garante a duração da cena quando o modelo escreve outro número literal */
function fixSceneDuration(html, duration, fps) {
  let out = String(html || '');
  const durRe = /(durationInSeconds\s*:\s*)([\d.]+)/g;
  const literals = out.match(durRe) || [];
  if (literals.length === 1) out = out.replace(durRe, `$1${duration}`);
  const framesRe = /(totalFrames\s*:\s*)(\d+)(?=\s*[,}\n])/g;
  if ((out.match(framesRe) || []).length === 1) out = out.replace(framesRe, `$1${Math.round(duration * fps)}`);
  return out;
}
// #endregion

// #region Rotas
function register(app, { root } = {}) {
  root = root || path.join(__dirname, '..');
  const store = createConfigStore(root);

  async function configPayload() {
    const cfg = store.get();
    return {
      hasKey: !!cfg.apiKey,
      keyHint: maskKey(cfg.apiKey),
      model: cfg.model || '',
      source: cfg.source,
      autoRotate: cfg.autoRotate,
      configError: store.readError()?.message || null,
    };
  }

  app.get('/api/ai/config', async (req, res) => {
    res.json(await configPayload());
  });

  app.post('/api/ai/config', async (req, res) => {
    const body = req.body || {};
    const patch = {};
    try {
      if (typeof body.apiKey === 'string') {
        const key = body.apiKey.trim();
        if (key) {
          if (!/^[\w\-.]{10,200}$/.test(key)) {
            return res.status(400).json({ error: 'Formato de chave inválido.' });
          }
          await fetchModels(key, { force: true }); // valida a chave
        }
        patch.apiKey = key;
      }
      if (typeof body.model === 'string') {
        patch.model = body.model.trim().replace(/^models\//, '').slice(0, 120);
      }
      if (typeof body.autoRotate === 'boolean') patch.autoRotate = body.autoRotate;
      store.save(patch);
      res.json({ ok: true, ...(await configPayload()) });
    } catch (err) {
      const e = networkError(err);
      res.status(e.status === 401 ? 400 : (e.status || 500)).json({ error: e.message, code: e.code });
    }
  });

  app.get('/api/ai/models', async (req, res) => {
    const cfg = store.get();
    if (!cfg.apiKey) return res.status(400).json({ error: NO_KEY_MESSAGE, code: 'no_key', models: [] });
    try {
      const models = await fetchModels(cfg.apiKey, { force: req.query.refresh === '1' });
      const auto = pickDefaultModel(models);
      res.json({
        models, defaultModel: cfg.model || auto, autoModel: auto, configured: cfg.model || '',
        autoRotate: cfg.autoRotate,
        rotation: cfg.autoRotate ? rotationOrder(cfg.model || auto, models) : [cfg.model || auto],
        cooldowns: listCooldowns(cfg.apiKey),
      });
    } catch (err) {
      const e = networkError(err);
      res.status(e.status || 500).json({ error: e.message, code: e.code, models: [] });
    }
  });

  app.post('/api/ai/generate', async (req, res) => {
    const body = req.body || {};
    const mode = body.mode === 'edit' ? 'edit' : 'create';
    const prompt = String(body.prompt || '').trim();
    const project = body.project || {};
    const w   = Math.min(7680, Math.max(1, Math.round(+project.w || 1080)));
    const h   = Math.min(7680, Math.max(1, Math.round(+project.h || 1920)));
    const fps = Math.min(240, Math.max(1, Math.round(+project.fps || 60)));
    const playhead = Number.isFinite(+body.playhead) ? +body.playhead : undefined;
    const currentHtml = typeof body.html === 'string' ? body.html : '';
    const reqName = cleanName(body.name);
    // Cena de um vídeo gerado a partir de áudio (duração fixa + guia de estilo)
    const scene = mode === 'create' ? normalizeSceneRequest(body.scene) : null;
    const sfx = body.sfx === true;

    if (!prompt && !scene) return res.status(400).json({ error: 'Escreva o que você quer no clipe.' });
    if (mode === 'edit' && !currentHtml.trim()) {
      return res.status(400).json({ error: 'HTML do clipe atual não informado para edição.' });
    }

    const { send, finish, signal } = openNdjson(res);

    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal });
      const verb = mode === 'edit' ? 'Editando' : 'Gerando';
      const generate = (startAt = runner.order[0]) => runner.run({ systemText, contents, verb, startAt });

      // Edição: base64 embutido vira marcador (a IA não precisa ler imagens/fontes).
      // Cena encadeada: a base dos blocos é o HTML da cena anterior.
      const chained = !!scene?.previous;
      const { masked: maskedHtml, store: dataStore } = maskDataUris(chained ? scene.previous.html : currentHtml);
      const patchMode = mode === 'edit' || chained;

      const systemText = buildSystemInstruction({ spec: chained ? '' : loadSpec(root), w, h, fps, mode: patchMode ? 'edit' : 'create' });
      const sfxCatalog = sfx ? await sfxLibrary.promptText() : '';
      const userText = chained
        ? buildSceneContinuePrompt({ scene, previousHtml: maskedHtml, prompt, fps, sfx, sfxCatalog })
        : scene
          ? buildScenePrompt({ scene, prompt, fps, sfx, sfxCatalog })
          : buildUserPrompt({ mode, prompt, html: maskedHtml, name: reqName, w, h, fps, playhead, sfx, sfxCatalog });
      const contents = [{ role: 'user', parts: [{ text: userText }] }];

      let result = await generate();
      let html;
      let check;
      let repaired = false;
      let edit = null;

      if (patchMode) {
        ({ html, check, repaired, edit } = await resolveEdit({
          result, baseHtml: maskedHtml, contents, send,
          generate: () => generate(runner.model),
        }));
        if (chained) html = fixSceneDuration(html, scene.duration, fps);
      } else {
        html = autoFix(extractHtml(result.text));
        if (scene) html = fixSceneDuration(html, scene.duration, fps);
        check = validateClip(html);
      }

      if (!patchMode && check.issues.length) {
        repaired = true;
        send({ type: 'status', message: `Corrigindo ${check.issues.length} problema(s) do clipe…`, issues: check.issues });
        const truncated = result.finishReason === 'MAX_TOKENS';
        contents.push({ role: 'model', parts: [{ text: result.text }] });
        contents.push({
          role: 'user',
          parts: [{
            text: [
              'O documento acima tem os seguintes problemas em relação à especificação:',
              ...check.issues.map(i => `- ${i}`),
              truncated ? '- A resposta foi cortada por limite de tamanho: reescreva de forma mais enxuta.' : null,
              '',
              'Corrija TODOS e retorne SOMENTE o documento HTML completo corrigido, de <!DOCTYPE html> até </html>, sem explicações.',
            ].filter(x => x !== null).join('\n'),
          }],
        });
        result = await generate(runner.model);
        let fixedHtml = autoFix(extractHtml(result.text));
        if (scene) fixedHtml = fixSceneDuration(fixedHtml, scene.duration, fps);
        const fixedCheck = validateClip(fixedHtml);
        // Usa a versão corrigida se não piorou
        if (fixedCheck.fatal.length <= check.fatal.length) { html = fixedHtml; check = fixedCheck; }
      }

      if (check.fatal.length) {
        throw new AiError(`O clipe gerado não segue o formato do Motion Studio: ${check.fatal.join('; ')}. Tente novamente.`, 422, 'invalid_clip');
      }

      if (patchMode) html = unmaskDataUris(html, dataStore);

      const name = ((mode === 'edit' || scene) && reqName) ? reqName : (cleanName(extractTitle(html)) || reqName || nameFromPrompt(prompt));
      finish({
        type: 'done',
        html,
        name,
        duration: extractDurationSec(html),
        hasSfx: /\bsfx\s*:/.test(html),
        repaired,
        warnings: check.warnings,
        model: runner.model,
        rotated: runner.rotated,
        edit,
        usage: runner.usage,
      });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Falha:', e.message);
      finish({ type: 'error', error: e.message, code: e.code });
    }
  });

  /**
   * POST /api/ai/sfx → NDJSON (status/done/error)
   * { clips: [{ id, kind: 'html'|'video'|'image', label, duration, html?, frames?: [{ t, dataUrl }],
   *             timeBase: 'source'|'clip', sourceStart?, sourceEnd? }],
   *   context: { neighbors, speech, narration }, pack?, prompt?, project }
   * done: { pack, clips: [{ id, cues: [{ t, type|sound, gain, pitch, dur, pan }] }] }
   */
  app.post('/api/ai/sfx', async (req, res) => {
    const body = req.body || {};
    const clips = (Array.isArray(body.clips) ? body.clips : []).slice(0, 12).map(c => ({
      id: String(c.id || ''),
      kind: ['html', 'video', 'image'].includes(c.kind) ? c.kind : 'html',
      label: String(c.label || '').slice(0, 80),
      duration: Math.max(0.1, Number(c.duration) || 0),
      start: Math.max(0, Number(c.start) || 0),
      timeBase: c.timeBase === 'source' ? 'source' : 'clip',
      sourceStart: Number(c.sourceStart) || 0,
      sourceEnd: Number(c.sourceEnd) || 0,
      html: typeof c.html === 'string' ? maskDataUris(c.html).masked.slice(0, 24000) : '',
      frames: (Array.isArray(c.frames) ? c.frames : []).slice(0, 8)
        .map(f => ({ t: Number(f.t) || 0, m: /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(f.dataUrl || '')) }))
        .filter(f => f.m),
    })).filter(c => c.id);
    if (!clips.length) return res.status(400).json({ error: 'Nenhum clip para analisar.' });

    const { send, finish, signal } = openNdjson(res);
    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal });
      const catalog = await sfxLibrary.promptText();
      const parts = [{ text: buildSfxPrompt({ clips, context: body.context || {}, pack: body.pack, prompt: body.prompt, catalog }) }];
      // Quadros dos vídeos/imagens, na ordem citada no texto
      clips.forEach(c => c.frames.forEach(f => {
        parts.push({ text: `[${c.id} · ${fmtSec(f.t)} s]` });
        parts.push({ inlineData: { mimeType: f.m[1], data: f.m[2] } });
      }));
      const contents = [{ role: 'user', parts }];
      const config = { responseMimeType: 'application/json', responseSchema: SFX_SCHEMA, temperature: 0.6 };

      const result = await runner.run({ systemText: SFX_SYSTEM, contents, verb: 'Criando efeitos sonoros', config });
      const out = parseJsonLoose(result.text);
      if (!out || !Array.isArray(out.clips)) throw new AiError('A IA não devolveu efeitos sonoros válidos. Tente novamente.', 502, 'invalid_sfx');

      const ids = new Set(clips.map(c => c.id));
      finish({
        type: 'done',
        pack: String(out.pack || body.pack || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || null,
        clips: out.clips
          .filter(c => ids.has(String(c.id)))
          .map(c => ({ id: String(c.id), cues: (Array.isArray(c.cues) ? c.cues : []).slice(0, 60) })),
        model: runner.model,
        rotated: runner.rotated,
        usage: runner.usage,
      });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Efeitos sonoros falharam:', e.message);
      finish({ type: 'error', error: e.message, code: e.code });
    }
  });

  /**
   * POST /api/ai/scenes/plan → NDJSON (status/done/error)
   * { transcript: { duration, segments: [{ start, end, text }] }, style: { mode, text },
   *   brief, sceneLength, background, project }
   * done: { style (paleta, fontes, css), scenes: [{ start, end, title, visual, onScreenText }] }
   */
  app.post('/api/ai/scenes/plan', async (req, res) => {
    const body = req.body || {};
    const duration = Number(body.transcript?.duration);
    const segments = (Array.isArray(body.transcript?.segments) ? body.transcript.segments : [])
      .map(s => ({ start: +s.start, end: +s.end, text: String(s.text || '').trim() }))
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text)
      .sort((a, b) => a.start - b.start);
    if (!(duration > 0)) return res.status(400).json({ error: 'Duração do áudio inválida.' });

    const opts = {
      duration,
      segments,
      styleMode: body.style?.mode === 'custom' ? 'custom' : 'auto',
      styleText: String(body.style?.text || '').trim().slice(0, 2000),
      brief: String(body.brief || '').trim().slice(0, 2000),
      sceneLength: SCENE_LENGTHS[body.sceneLength] ? body.sceneLength : 'auto',
      background: body.background === 'transparent' ? 'transparent' : 'full',
    };
    if (opts.styleMode === 'custom' && !opts.styleText) {
      return res.status(400).json({ error: 'Descreva o estilo ou escolha "Automático".' });
    }

    const { send, finish, signal } = openNdjson(res);
    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal });
      const contents = [{ role: 'user', parts: [{ text: buildPlanPrompt(opts) }] }];
      const config = { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA, temperature: 0.8 };

      let result = await runner.run({ systemText: PLAN_SYSTEM, contents, verb: 'Planejando cenas', config });
      let plan = parseJsonLoose(result.text);
      if (!plan?.scenes?.length || !plan.style) {
        send({ type: 'status', message: 'Plano incompleto — pedindo de novo…' });
        contents.push({ role: 'model', parts: [{ text: result.text }] });
        contents.push({ role: 'user', parts: [{ text: 'A resposta não é um JSON válido com "style" e "scenes". Responda SOMENTE o JSON completo no formato pedido.' }] });
        result = await runner.run({ systemText: PLAN_SYSTEM, contents, verb: 'Planejando cenas', config, startAt: runner.model });
        plan = parseJsonLoose(result.text);
      }
      if (!plan?.style) throw new AiError('A IA não devolveu um plano de cenas válido. Tente novamente.', 502, 'invalid_plan');

      const style  = await normalizeStyle(plan.style, opts);
      const scenes = normalizePlanScenes(plan.scenes, opts);
      finish({ type: 'done', style, scenes, model: runner.model, rotated: runner.rotated, usage: runner.usage });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Plano de cenas falhou:', e.message);
      finish({ type: 'error', error: e.message, code: e.code });
    }
  });
}
// #endregion

module.exports = { register, _internal: { extractHtml, validateClip, extractDurationSec, extractTitle, compareModels, pickDefaultModel, loadSpec, rotationOrder, classifyError, parseRetryInfo, normalizePlanScenes, normalizeSceneRequest, buildScenePrompt, buildSceneContinuePrompt, buildSystemInstruction, fixSceneDuration, parseJsonLoose } };
