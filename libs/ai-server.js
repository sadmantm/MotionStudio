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
const sfxOpenverse = require('./sfx-openverse');
const { SPEC: CURVE_SPEC } = require('./curve-spec');
const { SPEC: CAMERA_SPEC, EASES: CAMERA_EASES, normalizeCamera } = require('./camera-spec');
const { normalizeLibs, libRules } = require('./motion-libs');
const ClipLint = require('./clip-lint');

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
    const timeout = code === 504 || /deadline/.test(raw);
    const err = new AiError(timeout
      ? 'O Gemini demorou demais para responder (timeout).'
      : 'O Gemini está instável ou sobrecarregado no momento. Tente novamente em instantes.', 502, timeout ? 'timeout' : 'overloaded');
    err.upstream = { status: code, name: status, message: String(msg).replace(/\s+/g, ' ').slice(0, 160) };
    Object.assign(err, parseRetryInfo(details, headers));
    return err;
  }
  return new AiError(`Erro da API do Gemini (${code})${msg ? ': ' + msg.slice(0, 300) : ''}`, 502, 'upstream');
}

function networkError(err) {
  if (err?.name === 'AbortError') return new AiError('Requisição cancelada.', 499, 'aborted');
  if (err instanceof AiError) return err;
  // Gemini não respondeu (cabeçalho/corpo parado, conexão derrubada): é instabilidade dele, não da internet
  const netCode = String(err?.cause?.code || err?.code || '');
  if (/UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT|^ETIMEDOUT$|^ECONNRESET$|UND_ERR_SOCKET|^EPIPE$/.test(netCode) || /^terminated$/i.test(String(err?.message))) {
    const e = new AiError(`O Gemini não respondeu a tempo (${netCode || 'conexão encerrada'}).`, 502, 'timeout');
    e.upstream = { status: 0, name: netCode, message: '' };
    return e;
  }
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

const ROTATABLE = new Set(['quota', 'overloaded', 'timeout', 'model_not_found']);
const HEADERS_TIMEOUT_MS = 150e3;               // Gemini sem iniciar a resposta (o padrão do Node é 300 s)
const IDLE_TIMEOUT_MS    = 150e3;               // resposta parada no meio (modelos pensando ficam quietos um tempo)
const RETRY_SAME_DELAY_MS = [2500, 6000];       // sobrecarga passageira (503): nova tentativa no MESMO modelo antes de trocar
const MAX_PARALLEL_AI    = 2;                   // chamadas simultâneas ao Gemini (cenas + sons + limpeza não se empilham)
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

const failStreaks = new Map(); // cooldownId → falhas seguidas de sobrecarga/timeout (espera cresce: 20 s, 40 s, 80 s… até 5 min)

function coolDown(apiKey, model, err) {
  // Cota diária: o RetryInfo às vezes vem em segundos, mas só volta no outro dia
  if (err.code === 'quota' && err.scope === 'day') {
    cooldowns.set(cooldownId(apiKey, model), { until: Date.now() + Math.max(err.retryAfterMs || 0, 6 * 3600e3), code: err.code });
    return;
  }
  let streak = 0;
  if (err.code === 'overloaded' || err.code === 'timeout') {
    streak = failStreaks.get(cooldownId(apiKey, model)) || 0;
    failStreaks.set(cooldownId(apiKey, model), streak + 1);
  }
  const ms = err.retryAfterMs
    || (err.code === 'model_not_found' ? 24 * 3600e3
      : err.code === 'quota' && err.scope === 'day' ? 6 * 3600e3
      : err.code === 'quota' ? 60e3
      : Math.min(20e3 * 2 ** streak, 5 * 60e3));
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
    : err.code === 'timeout' ? 'sem resposta'
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

/**
 * Como o movimento deve se comportar. Regras do guia de motion do
 * HyperFrames (docs/prompting/motion), escritas para o nosso contrato:
 * o que chega para; só se mexe o que está vivo.
 */
const MOTION_PRINCIPLES = [
  'PRINCÍPIOS DE MOVIMENTO (obrigatórios):',
  '- Chega e para: um elemento entra, assenta e FICA PARADO. O que continua se mexendo é só o que de fato muda (número contando, barra enchendo, gráfico crescendo, cursor, interface funcionando). Nada de flutuar, "respirar", girar ou dar zoom lento só para parecer vivo — isso denuncia vídeo gerado.',
  '- Sobreponha, não enfileire: o próximo elemento começa enquanto o anterior ainda assenta; o que acontece em sequência entra com stagger; o que já existia junto aparece junto.',
  '- Uma ideia por movimento: combine propriedades só quando dizem a mesma coisa (subir + aparecer = chegar). Giro + zoom num texto em movimento impede a leitura.',
  '- Peso só em objetos físicos: overshoot, quique e mola com balanço em cards, abas, ícones-objeto e personagens. NUNCA em texto, interface ou números (um contador que passa de 42 e volta mostra um número que nunca existiu): neles, desaceleração longa e suave (outExpo/outQuart).',
  '- A câmera se move para chegar a algum lugar: ela viaja entre coisas que vivem no mesmo espaço e para quando chega. Sem push-in lento e infinito por enfeite.',
  '- Profundidade: o que está perto anda mais rápido que o fundo (parallax em 2–3 planos). Um elemento desfocado em primeiro plano passando é o sinal mais forte de profundidade — um, não vários.',
  '- Cena viva = ação real: se nada acontece por mais de ~2 s, dê à cena algo para fazer (a interface trabalhando, um dado chegando, a câmera indo à próxima coisa) — não um enfeite em loop.',
  '- Transições causadas por algo na tela: a câmera atravessa um botão, um card cresce e vira a próxima tela, o fundo é inundado por outra cor enquanto o sujeito fica. Corte no meio do movimento. Nunca dissolva entre duas cenas sem relação.',
  '- Ritmo pelo formato: vinheta/rede social dá 1–4 s a cada ideia; demonstração de produto segura um enquadramento 7–10 s enquanto a interface trabalha.',
  '- Estilo feito à mão (stop-motion): posições que mudam em passos de 2 quadros, com a irregularidade vinda de uma semente.',
].join('\n');

/** API do libs/motion-kit.js, injetado pelo host em todo clipe */
const MOTION_KIT_DOCS = [
  'KIT DO MOTION STUDIO — window.MS já está carregado em todo clipe (não inclua <script> para ele). Use-o para escrever menos código e evitar bugs:',
  '- Contrato: MS.motion({ fps, durationInSeconds, ready: async () => { /* montar DOM, SplitText, carregar modelos */ }, render: t => { /* todo o estado a partir de t */ } }) cria window.Motion (config, seek, renderFrame, whenReady); render só roda depois de ready. Escreva fps e durationInSeconds como números literais.',
  '- Tempo: MS.seg(t, t0, t1) → progresso 0–1; MS.interpolate(t, [t0, t1, …], [v0, v1, …], { easing: MS.ease.outExpo }) (clampa nas pontas; easing pode ser um array, um por trecho; valores podem ser arrays); MS.interpolateColors(t, input, cores); MS.spring(t - t0, { stiffness: 100, damping: 10, from: 0, to: 1 }) (damping 26+ = sem balanço); MS.stagger(i, 0.08); MS.loop(t, período); MS.countUp(t, t0, t1, 1500, { prefix: "R$ ", decimals: 0 }) → texto formatado.',
  '- MS.ease: linear e in/out/inOut × Quad, Cubic, Quart, Quint, Sine, Expo, Circ, Back (ex.: MS.ease.outQuart), outElastic, outBounce, overshoot(s), bezier(x1, y1, x2, y2), steps(n).',
  '- Sorte e ruído com semente: MS.random("semente") → [0, 1); const r = MS.rng("estrelas"); r(); MS.noise2D(semente, x, y), MS.noise3D(semente, x, y, t) → [-1, 1]; MS.wiggle(t, { freq, amp, seed }).',
  '- Texto: MS.fitText(texto, { width, fontFamily, fontWeight }) → font-size que cabe numa linha; MS.fitElement(el); MS.split(el, "chars" | "words" | "lines") → <span>s para animar (chame em ready, depois das fontes).',
  '- SVG: MS.path.draw(elementoPath, p) desenha o traço até a fração p; MS.path.point(d, p) → { x, y, angle }; MS.path.morph(p, dA, dB) → d intermediário entre duas formas quaisquer; MS.shape.circle(r), rect(w, h, raio), polygon(n, r), star(pontas, ext, int) → d centrado em (0, 0).',
  '- Som do projeto: MS.audio(t) → { level, bass, mid, treble, bands[16], beat, pulse } (0–1, já suavizado; pulse decai depois de cada batida) e MS.audio.bars(t, n) → n barras. Use quando o pedido falar em música, batida, ritmo, visualizador ou "reagir ao som". Sem áudio no projeto tudo vem 0: o clipe precisa continuar bonito assim.',
].join('\n');

/** spec vazia: o HTML de referência no pedido já demonstra o contrato (cenas encadeadas) */
function buildSystemInstruction({ spec, w, h, fps, mode = 'create', libs = [], scene = false }) {
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
    '- Nível de motion designer sênior: composição em camadas com profundidade, tipografia cinética, grafismos feitos no código (SVG/canvas), easing de qualidade e entrada/saída coreografadas, seguindo os PRINCÍPIOS DE MOVIMENTO abaixo. Um título sozinho sobre fundo liso NÃO é aceitável.',
    '',
    MOTION_PRINCIPLES,
    '',
    MOTION_KIT_DOCS,
    '',
    mode === 'edit'
      ? PATCH_FORMAT
      : '- Responda SOMENTE com o documento HTML completo, começando em <!DOCTYPE html> e terminando em </html>. Sem explicações, sem markdown, sem cercas de código.',
    // Cena encadeada usa blocos SEARCH/REPLACE, mas cria conteúdo novo
    libRules(libs, { mode: scene ? 'create' : mode, scene }),
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
function sfxVocabulary(catalog, { search = false } = {}) {
  return [
    `Sons sintetizados — use type: ${SFX_TYPES}.`,
    catalog
      ? `${catalog}\nPrefira "sfxkit" quando houver o som; sintetizados (type) e os pacotes de estilo do uisfx completam. Num mesmo vídeo use no máximo UM pacote do uisfx.`
      : '',
    search
      ? 'Cada deixa tem type, sound OU search (busca no Openverse, CC; só quando nenhuma biblioteca serve — com type de reserva). gain 0.2–1 (padrão 0.8), pitch 0.5–2 (1 = normal), pan -1 (esquerda) a 1 (direita), dur em segundos (opcional; limita o som), want = duração desejada de uma busca.'
      : 'Cada deixa tem type OU sound. gain 0.2–1 (padrão 0.8), pitch 0.5–2 (1 = normal), pan -1 (esquerda) a 1 (direita), dur em segundos (opcional).',
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

// #region Itens da biblioteca (efeito / transição / texto do usuário)
const ASSET_RULES = {
  effect: [
    'TIPO: EFEITO DE SOBREPOSIÇÃO. O editor coloca este clipe numa track ACIMA de um vídeo/cena e o estica para a duração inteira desse clipe (o tempo é remapeado: a animação precisa funcionar comprimida ou esticada).',
    '- Fundo TRANSPARENTE obrigatório (html, body e qualquer container de tela cheia). O conteúdo de baixo tem que continuar visível: nada de cobrir o quadro com cor opaca.',
    '- Exemplos do que é um efeito: light leak, grão/película, poeira e arranhões, partículas, bokeh, chuva/neve, vinheta animada, glitch, flare, brilho percorrendo, moldura animada, VHS/scanlines. Use opacidade, gradientes e mix-blend-mode (screen, overlay, soft-light) para integrar com o vídeo de baixo.',
    '- Evolução contínua do início ao fim (nada que acabe na metade); sem texto, a não ser que seja pedido.',
    '- Duração padrão 4 s.',
  ],
  transition: [
    'TIPO: TRANSIÇÃO DE SOBREPOSIÇÃO. O editor coloca este clipe numa track ACIMA de dois clipes, CENTRADO no corte entre eles: o corte acontece exatamente em t = durationInSeconds / 2.',
    '- Início e fim TOTALMENTE transparentes (o vídeo de baixo aparece normal).',
    '- No meio (em volta de t = duração/2) o overlay COBRE O QUADRO INTEIRO, opaco, para esconder o corte; depois revela o quadro de novo.',
    '- Exemplos: wipe com formas geométricas, cortina de cores, zoom/flash de luz, tinta/manchas, shapes em diagonal, glitch, círculo que fecha e abre, faixas deslizando.',
    '- Movimento rápido e com energia (easing expo/back). Duração padrão 1 s (entre 0,6 e 1,5 s). Sem texto, a não ser que seja pedido.',
  ],
  text: [
    'TIPO: TEMPLATE DE TEXTO do Motion Studio, seguindo EXATAMENTE a especificação acima (text-templates/ia-base.html): é o HTML-fonte com placeholders {{campo}} que o editor substitui.',
    '- Use os placeholders {{text}}, {{fontFamily}}, {{fontSize}}, {{fontWeight}}, {{color}}, {{align}}, {{bg}}, {{duration}}, {{w}} e {{h}} (opcional {{highlightColor}}). durationInSeconds deve ser {{duration}}.',
    '- {{text}} pode ter várias linhas (white-space: pre-wrap). Fundo transparente via {{bg}}.',
    '- Entrada e saída animadas, design marcante; sem bibliotecas nem scripts externos (fontes do Google Fonts por <link> são ok).',
  ],
};

/** body.asset → { kind, images: [{ mimeType, data }], html } */
function normalizeAsset(raw) {
  if (!raw || !ASSET_RULES[raw.kind]) return null;
  const refs = raw.references || {};
  return {
    kind: raw.kind,
    images: (Array.isArray(refs.images) ? refs.images : []).slice(0, 4)
      .map(u => /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(u || '')))
      .filter(Boolean)
      .map(m => ({ mimeType: m[1], data: m[2] })),
    html: typeof refs.html === 'string' ? maskDataUris(refs.html).masked.slice(0, 60000) : '',
  };
}

function buildAssetPrompt({ asset, prompt, w, h, fps }) {
  return [
    ...ASSET_RULES[asset.kind],
    `Projeto: ${w}×${h} px, ${fps} fps.`,
    asset.images.length ? `Imagens de referência anexadas (${asset.images.length}): use como referência visual de estilo, cores, formas e movimento — não copie literalmente nem embuta as imagens.` : '',
    asset.html ? `HTML de referência (inspire-se no visual/técnica; o resultado precisa seguir as regras acima):\n${asset.html}` : '',
    '',
    'Pedido:',
    prompt || '(sem descrição: crie a partir das referências)',
  ].filter(Boolean).join('\n');
}

const textSpecCache = { mtime: 0, text: '' };
/** Base oficial dos templates de texto (as regras estão no próprio HTML) */
function loadTextSpec(root) {
  const file = path.join(root, 'text-templates', 'ia-base.html');
  try {
    const stat = fs.statSync(file);
    if (textSpecCache.mtime !== stat.mtimeMs) {
      textSpecCache.text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
      textSpecCache.mtime = stat.mtimeMs;
    }
    return textSpecCache.text;
  } catch (_) {
    return '';
  }
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

/**
 * Regras de libs/clip-lint.js em modo estrito (o clipe gerado TEM que trazer
 * o contrato): erros barram o clipe e viram rodada de correção; avisos também
 * entram na correção. Cada item leva a dica de como corrigir.
 */
function validateClip(html) {
  const { findings } = ClipLint.lint(html, { strict: true });
  const text = f => `${f.message} → ${f.fix}`;
  const fatal = findings.filter(f => f.severity === 'error').map(text);
  const warnings = findings.filter(f => f.severity === 'warning').map(text);
  return { fatal, warnings, issues: [...fatal, ...warnings], findings };
}

/**
 * Template de texto (text-templates/, ia-base.html): contrato mais leve que o
 * dos clips — window.Motion com seek(t); a duração vem de {{duration}}.
 */
function validateTextTemplate(html) {
  const src = String(html || '');
  const fatal = [];
  if (!src.includes('window.Motion')) fatal.push('window.Motion não encontrado');
  if (!/\bseek\b/.test(src)) fatal.push('seek ausente');
  if (!src.includes('{{text}}')) fatal.push('placeholder {{text}} ausente');
  if (!/<html[\s>]/i.test(src)) fatal.push('documento sem <html>');
  else if (!/<\/html>\s*$/i.test(src)) fatal.push('documento incompleto (sem </html> no final — resposta truncada?)');
  const base = validateClip(src);
  return { fatal, warnings: base.warnings, issues: [...fatal, ...base.warnings] };
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

  // Cancelamento do usuário + relógio: sem resposta em HEADERS_TIMEOUT_MS (ou parada no meio
  // por IDLE_TIMEOUT_MS) vira erro 'timeout' recuperável, em vez de esperar os 300 s do Node
  const ctl = new AbortController();
  let timedOut = false;
  let timer = null;
  const onUserAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', onUserAbort, { once: true });
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms); };
  const fail = err => {
    if (timedOut && !signal?.aborted) {
      const e = new AiError(`O Gemini não respondeu em ${Math.round((text ? IDLE_TIMEOUT_MS : HEADERS_TIMEOUT_MS) / 1000)} s.`, 502, 'timeout');
      e.upstream = { status: 0, name: 'TIMEOUT', message: '' };
      return e;
    }
    return networkError(err);
  };
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onUserAbort); };

  let text = '';
  let resp;
  try {
    arm(HEADERS_TIMEOUT_MS);
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig,
      }),
      signal: ctl.signal,
    });
  } catch (err) {
    cleanup();
    throw fail(err);
  }
  if (!resp.ok) {
    try { throw await upstreamError(resp); } finally { cleanup(); }
  }
  arm(IDLE_TIMEOUT_MS);

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
      arm(IDLE_TIMEOUT_MS);
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
    throw fail(err);
  } finally {
    cleanup();
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
let aiActive = 0;
const aiWaiting = [];

/** Vaga numa das MAX_PARALLEL_AI chamadas simultâneas; devolve a função que libera */
async function acquireAiSlot(signal, send) {
  if (aiActive >= MAX_PARALLEL_AI) {
    send({ type: 'status', message: 'Aguardando outra tarefa de IA terminar…' });
    await new Promise((resolve, reject) => {
      const entry = { resolve };
      aiWaiting.push(entry);
      signal?.addEventListener('abort', () => {
        const i = aiWaiting.indexOf(entry);
        if (i >= 0) { aiWaiting.splice(i, 1); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
      }, { once: true });
    });
  } else {
    aiActive++;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = aiWaiting.shift();
    if (next) next.resolve(); else aiActive--;   // a vaga passa direto para quem espera
  };
}

async function createRunner({ store, send, signal, model: forcedModel }) {
  const cfg = store.get();
  if (!cfg.apiKey) throw new AiError(NO_KEY_MESSAGE, 400, 'no_key');
  // Modelo escolhido na hora (tela de recuperação): só ele, sem rotação
  const forced = /^[\w.\-\/]{1,120}$/.test(String(forcedModel || '')) ? String(forcedModel).replace(/^models\//, '') : '';

  let models = [];
  try { models = await fetchModels(cfg.apiKey, { signal }); } catch (err) {
    if (err?.code === 'invalid_key' || err?.code === 'aborted') throw err;
    // Lista indisponível: segue com o modelo configurado/padrão
  }
  const primary = forced || cfg.model || pickDefaultModel(models) || 'gemini-2.5-flash';
  const order = forced ? [forced] : cfg.autoRotate ? rotationOrder(primary, models) : [primary];
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
    const release = await acquireAiSlot(signal, send);
    try {
      return await runRotating({ systemText, contents, verb, startAt, config });
    } finally {
      release();
    }
  };

  async function runRotating({ systemText, contents, verb, startAt, config }) {
    let waited = 0;
    let switches = 0;
    const attempts = forced ? RETRY_SAME_DELAY_MS.length + 1 : 2;
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
        for (let attempt = 1; ; attempt++) {
          try {
            send({ type: 'status', message: `${verb} com ${candidate}…`, model: candidate });
            lastProgress = 0;
            const out = await streamGemini({
              apiKey: cfg.apiKey, model: candidate, systemText, contents, config,
              maxOutputTokens: maxTokensFor(candidate), signal, onText,
            });
            runner.model = candidate;
            failStreaks.delete(cooldownId(cfg.apiKey, candidate));
            runner.usage.input  += Number(out.usage?.promptTokenCount) || 0;
            runner.usage.output += (Number(out.usage?.candidatesTokenCount) || 0) + (Number(out.usage?.thoughtsTokenCount) || 0);
            runner.usage.rounds += 1;
            return out;
          } catch (err) {
            const e = networkError(err);
            if (!ROTATABLE.has(e.code)) throw e;
            const detail = e.upstream ? ` [${[e.upstream.status || '', e.upstream.name, e.upstream.message].filter(Boolean).join(' ')}]` : '';
            const why = `${rotationReason(e)}${detail}`;
            // Sobrecarga passageira (503): quase sempre passa em segundos — tenta o mesmo modelo de novo
            // antes de trocar (trocar entre modelos da mesma família só espalha a carga)
            if (e.code === 'overloaded' && attempt < attempts) {
              const delay = (RETRY_SAME_DELAY_MS[attempt - 1] || 6000) + Math.random() * 1500;
              console.warn(`[AI] ${candidate}: ${why} — nova tentativa em ${Math.round(delay / 1000)}s`);
              send({ type: 'status', message: `${candidate}: ${rotationReason(e)} — nova tentativa em ${Math.round(delay / 1000)}s…`, retrying: candidate });
              await sleepAbortable(delay, signal);
              continue;
            }
            coolDown(cfg.apiKey, candidate, e);
            noteCooldown(candidate);
            runner.rotated.push({ model: candidate, reason: rotationReason(e) });
            const next = queue.slice(queue.indexOf(candidate) + 1).find(id => !cooldownOf(cfg.apiKey, id));
            console.warn(`[AI] ${candidate}: ${why}${next ? ` — próximo: ${next}` : ''}`);
            if (next) {
              const delay = ROTATE_DELAYS_MS[Math.min(switches++, ROTATE_DELAYS_MS.length - 1)];
              send({ type: 'status', message: `${candidate}: ${rotationReason(e)} — tentando ${next} em ${Math.round(delay / 1000)}s…`, rotatedFrom: candidate });
              await sleepAbortable(delay, signal);
            }
            break;
          }
        }
      }

      // Todos em espera: se a janela reabre logo (limite por minuto), aguarda e tenta de novo
      const wait = earliest - Date.now();
      if (Number.isFinite(wait) && wait <= MAX_QUOTA_WAIT_MS && waited + wait <= MAX_TOTAL_WAIT_MS) {
        const total = Math.max(1000, wait + 750);
        const end = Date.now() + total;
        while (Date.now() < end) {
          const left = Math.ceil((end - Date.now()) / 1000);
          send({ type: 'status', message: `${forced || 'Todos os modelos'} indisponível — nova tentativa em ${left}s…`, waiting: left });
          await sleepAbortable(Math.min(1000, end - Date.now()), signal);
        }
        waited += total;
        startAt = earliestModel || order[0];
        continue;
      }

      const waitMsg = Number.isFinite(earliest) ? ` Tente de novo em ~${waitText(earliest - Date.now())}.` : '';
      const err = new AiError(
        forced
          ? `O modelo ${forced} está sem cota ou sobrecarregado.${waitMsg} Escolha outro modelo ou tente de novo depois.`
          : `Todos os modelos disponíveis estão sem cota ou sobrecarregados (${order.join(', ')}).${waitMsg}`,
        429, 'all_models_exhausted'
      );
      err.retryAfterMs = Number.isFinite(earliest) ? Math.max(0, earliest - Date.now()) : 0;
      throw err;
    }
  }

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
  '- scenes: em ordem, cobrindo o áudio de 0 até a duração total, sem buracos e sem sobreposição (end de uma = start da próxima). Corte nas pausas entre falas, nunca no meio de uma frase. title: 2 a 5 palavras. onScreenText: texto curto que aparece na tela (pode ser vazio).',
  '- visual: roteiro visual DETALHADO da cena (3 a 5 frases), como um storyboard de motion design: o fundo e a atmosfera; o elemento principal que ilustra a fala (gráfico/contador para números, ícone ou ilustração vetorial para conceitos, mockup de interface para produto/tecnologia, linha do tempo ou cards para etapas, split screen para comparações); os grafismos de apoio; o tratamento da tipografia; e 2 a 4 momentos de animação amarrados às falas ("quando ele diz X, Y acontece"). Nada de "título centralizado com fundo" — cada cena precisa de uma ideia visual própria.',
  '- As cenas formam UM vídeo coerente: mesma paleta, tipografia e linguagem de movimento; varie a composição entre cenas para não ficar repetitivo.',
].join('\n');

const SFX_SYSTEM = [
  'Você é sound designer de motion graphics e vídeos curtos. Recebe clipes de uma timeline (código HTML animado, ou quadros de vídeo/imagem com o instante de cada um) e o contexto ao redor.',
  'Sua tarefa: criar os efeitos sonoros de cada clipe, sincronizados com o que acontece na tela.',
  '- Leia o código HTML para achar os instantes exatos: delays/durações de timelines (GSAP, keyframes, seek(t)), entradas de títulos, revelações, números, trocas de cena, CTA.',
  '- Um som por acontecimento visual relevante; nada de trilha contínua nem sons a cada frame. Tipicamente 3 a 10 por clipe; deixe respiro.',
  '- Entrada de elemento = whoosh/swipe/pop; revelação ou logo = impact (riser antes, terminando no impacto); preço/dinheiro = coin ou commerce/*; mensagem = notification; digitação = typing com dur.',
  '- Com narração ou legendas no mesmo trecho, mantenha gain ≤ 0.45 e evite sons longos por cima das falas.',
  '- Qualidade: prefira a biblioteca "sfxkit" (sons com ponto de sincronia e níveis calibrados) para movimento, impacto, interface, dados e notificações; escolha a intensidade pelo tom do vídeo (soft/subtle com narração ou corporativo, hard em edição enérgica) e a duração pelo movimento (fast/medium/slow).',
  '- Diversidade: não repita o mesmo som em sequência; alterne variações (ex.: pop-small-in, pop-medium-in) e varie gain/pitch levemente (0.9–1.1) nos repetidos.',
  '- Sons que nenhuma biblioteca tem (porta, multidão, motor, animais, objetos do mundo real…): use search com 1 a 4 palavras EM INGLÊS (ex.: "door slam", "camera shutter") e want = duração desejada em segundos; sempre inclua também type como reserva caso a busca falhe. No máximo 6 buscas no total.',
  '- Coerência: se usar os pacotes de estilo do uisfx, escolha UM para todos os clipes; sfxkit e buscas são neutros e combinam com qualquer pacote.',
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
                search: { type: 'STRING' }, want: { type: 'NUMBER' },
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

// #region Curvas de animação (easing) com IA
const CURVE_SYSTEM = [
  'Você cria curvas de animação (easing) para o editor de vídeo Motion Studio a partir de uma descrição em linguagem natural.',
  'Traduza o movimento descrito (ex.: "rebote suave", "começa devagar e dispara", "mola que oscila 3 vezes") na curva que melhor o reproduz.',
  'Use kind "bezier" (campo p com 4 números) sempre que uma bezier der conta; use kind "points" (campo points, 12 a 60 pontos {x,y}) para quicar, elástico, mola e degraus.',
  'Responda SOMENTE com JSON no formato pedido. A especificação completa:',
  CURVE_SPEC,
].join('\n');

const CURVE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name:   { type: 'STRING' },
    kind:   { type: 'STRING', enum: ['bezier', 'points'] },
    p:      { type: 'ARRAY', items: { type: 'NUMBER' } },
    points: { type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] } },
  },
  required: ['name', 'kind'],
};

/** Resposta da IA → { name, curve } válidos (mesmas regras do editor: clip-fx.js normalizeCurve) */
function curveFromAi(out) {
  if (!globalThis.ClipFX) require('../Interface/clip-fx.js');
  const F = globalThis.ClipFX;
  const name = String(out?.name || 'Minha curva').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Minha curva';
  let curve = null;
  if (out?.kind === 'points' || (!out?.p && Array.isArray(out?.points))) {
    let pts = (Array.isArray(out.points) ? out.points : []).map(q => [Number(q?.x), Number(q?.y)]);
    if (pts.length) {
      pts.sort((a, b) => a[0] - b[0]);
      if (pts[0][0] > 0.001) pts.unshift([0, 0]);
      if (pts[pts.length - 1][0] < 0.999) pts.push([1, 1]);
    }
    curve = F.normalizeCurve({ pts });
  } else {
    curve = F.normalizeCurve({ p: out?.p });
  }
  return curve ? { name, curve } : null;
}
// #endregion

// #region Câmera 2D com IA (movimentos a partir da fala e da posição dos elementos)
const CAMERA_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    keyframes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          t:        { type: 'NUMBER' },
          focus:    { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] },
          zoom:     { type: 'NUMBER' },
          rotation: { type: 'NUMBER' },
          ease:     { type: 'STRING', enum: CAMERA_EASES },
          reason:   { type: 'STRING' },
        },
        required: ['t', 'focus', 'zoom'],
      },
    },
  },
  required: ['keyframes'],
};

const CAMERA_STYLE_TEXT = {
  intensity: {
    subtle:   'Intensidade SUTIL: poucos movimentos, zoom até ~1,5, curvas suaves.',
    balanced: 'Intensidade EQUILIBRADA: movimentos claros nos momentos importantes, zoom até ~2,2.',
    dynamic:  'Intensidade DINÂMICA: movimentos mais ousados e rápidos, zoom até ~3, pode usar "ease-out" e "overshoot".',
  },
  margin: {
    loose: 'Enquadramento FOLGADO (margem m ≈ 1,8): o elemento aparece com bastante ar em volta.',
    tight: 'Enquadramento JUSTO (margem m ≈ 1,25): o elemento ocupa quase toda a visão.',
  },
};

// #endregion

// #region Limpeza de narração (cortes automáticos com IA)
const CLEANUP_SYSTEM = [
  'Você é editor de áudio de narrações, podcasts e vídeos falados. Recebe a transcrição de uma gravação palavra a palavra, cada palavra com um número (índice), e marcações de pausa.',
  'Sua tarefa: apontar os trechos que um editor profissional cortaria para a fala ficar limpa, fluida e sem erros — sem mudar o sentido nem reescrever nada.',
  'Corte (quando pedido):',
  '- hesitacao: sons de hesitação e muletas vazias ("éé", "ahn", "hum", "tipo", "né" e "então" quando não acrescentam nada), gaguejos e palavras cortadas pela metade.',
  '- repeticao: palavras ou frases repetidas sem querer e TOMADAS REPETIDAS — quando a pessoa erra e fala a mesma frase de novo, mantenha só a última versão completa e corte as anteriores inteiras.',
  '- erro: frases começadas e abandonadas, autocorreções ("dia cinco, quer dizer, dia seis" → fica "dia seis"), informação dita errada e corrigida logo depois.',
  '- fora: comentários fora do conteúdo ("pera, vou de novo", "corta isso", "deixa eu ver", conversa com outra pessoa, testes de microfone).',
  'Regras:',
  '- Cada corte é uma faixa contínua de índices (from..to, inclusive). Nunca corte uma palavra pela metade de uma frase que fica.',
  '- O que sobra precisa soar natural e gramatical quando as partes forem emendadas. Na dúvida, NÃO corte.',
  '- Não corte conteúdo real só para encurtar. Não invente palavras.',
  '- reason: frase curta em português explicando o corte (ex.: "tomada repetida", "muleta").',
  '- Responda SOMENTE com JSON no formato pedido.',
].join('\n');

const CLEANUP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cuts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          from: { type: 'INTEGER' }, to: { type: 'INTEGER' },
          kind: { type: 'STRING', enum: ['hesitacao', 'repeticao', 'erro', 'fora'] },
          reason: { type: 'STRING' },
        },
        required: ['from', 'to', 'kind'],
      },
    },
    summary: { type: 'STRING' },
  },
  required: ['cuts'],
};

const CLEANUP_KINDS = {
  hesitacao: 'hesitações, muletas e gaguejos',
  repeticao: 'repetições e tomadas repetidas (mantenha a última boa)',
  erro: 'frases abandonadas, autocorreções e erros corrigidos',
  fora: 'comentários fora do conteúdo',
};

/** Transcrição numerada: uma linha por frase/pausa, "[12.3s] 0:Olá 1:pessoal …" */
function buildCleanupPrompt({ words, kinds, prompt, language }) {
  const lines = [];
  let line = [];
  words.forEach((w, i) => {
    const gap = i ? w.s - words[i - 1].e : 0;
    if (line.length && (gap > 0.6 || line.length >= 30)) {
      lines.push(line.join(' '));
      line = [];
    }
    if (!line.length) line.push(`${gap > 0.6 ? `(pausa ${gap.toFixed(1)}s) ` : ''}[${w.s.toFixed(1)}s]`);
    line.push(`${i}:${w.w}`);
  });
  if (line.length) lines.push(line.join(' '));
  return [
    `Idioma: ${language || 'detectar'}. Total: ${words.length} palavras.`,
    `Corte SOMENTE estes tipos: ${kinds.map(k => `${k} (${CLEANUP_KINDS[k]})`).join('; ')}.`,
    prompt ? `Instruções do usuário: ${String(prompt).slice(0, 600)}` : '',
    'Silêncios longos já são removidos pelo editor — não precisa apontá-los.',
    '',
    'TRANSCRIÇÃO:',
    ...lines,
    '',
    'Responda com { cuts: [{ from, to, kind, reason }], summary }.',
  ].filter(x => x !== '').join('\n');
}
// #endregion

function buildSfxPrompt({ clips, context, pack, prompt, catalog }) {
  const ctx = context || {};
  const lines = [
    sfxVocabulary(catalog, { search: true }),
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

/**
 * Deixas com search ("door slam") → sound "ov/<id>" de um resultado do Openverse
 * (baixado para o cache local). Sem resultado: fica o type de reserva, ou a deixa sai.
 * → { 'ov/<id>': { url, duration, title, creator, license, attribution, source } }
 */
async function resolveSearchCues(clips, send) {
  const wanted = clips.flatMap(c => c.cues).filter(c => c && typeof c.search === 'string' && c.search.trim());
  if (!wanted.length) return {};
  send({ type: 'status', message: 'Buscando sons no Openverse…' });
  const found = await sfxOpenverse.resolve(wanted.map(c => ({ search: c.search, want: c.want ?? c.dur })), { max: 6 });
  const external = {};
  for (const clip of clips) {
    clip.cues = clip.cues.flatMap(cue => {
      if (!cue || typeof cue.search !== 'string' || !cue.search.trim()) return [cue];
      const { search, want, ...rest } = cue;
      const hit = found.get(search.trim().toLowerCase());
      if (hit) {
        const { id, ...info } = hit;
        external[id] = info;
        const dur = Number(rest.dur) > 0 ? Math.min(Number(rest.dur), hit.duration) : 0;
        return [{ ...rest, type: undefined, sound: id, dur }];
      }
      return rest.type ? [rest] : [];   // sem resultado: o som sintetizado de reserva
    });
  }
  return external;
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
    SCENE_CRAFT,
    sfx ? sfxRules('create', sfxCatalog) : '',
    scene.total > 1 ? ANCHOR_RULES : '',
    prompt ? `Pedido adicional: ${prompt}` : '',
    `Inclua <title>${scene.title}</title>.`,
  ].filter(Boolean).join('\n');
}

// Padrão de acabamento de TODAS as cenas (a 1ª e as editadas a partir dela)
const SCENE_CRAFT = [
  'PADRÃO DE QUALIDADE (motion design profissional — cena simples é inaceitável):',
  '- Camadas: (1) fundo com profundidade — gradientes da paleta, grão/textura sutil, formas em planos diferentes; (2) grafismos de apoio — linhas, molduras, formas geométricas, ícones SVG desenhados no código, rótulos, números, barras; (3) tipografia principal em destaque.',
  '- Movimento com propósito (PRINCÍPIOS DE MOVIMENTO): o que entra assenta e para; o que continua se mexendo é o que está mudando de verdade (contador, gráfico crescendo, interface trabalhando, a câmera indo para a próxima coisa). Nada de flutuação, rotação lenta ou zoom de enfeite.',
  '- Tipografia cinética: revele títulos por palavra ou letra (máscara/clip-path, deslize com blur, subida com desaceleração longa) com stagger; hierarquia clara (palavra-chave enorme, apoio pequeno), pesos variados. Sem overshoot em texto.',
  '- Ritmo: um acontecimento visual a cada frase ou palavra-chave da fala (novo elemento, troca de destaque, número contando, ícone desenhando o traço com stroke-dashoffset).',
  '- Técnica certa para o conteúdo: números → contador animado e/ou gráfico (barras, linhas, anéis de progresso); etapas → cards ou linha do tempo que se constrói; conceitos → ícone/ilustração SVG; comparação → split screen; produto/tecnologia → mockup de interface.',
  '- Acabamento: sombras suaves, glow nos acentos, desfoque nas camadas de trás, blend modes, bordas finas, espaçamento consistente; easing expo/quart (back e elastic só em objetos com peso); entradas sobrepostas (o próximo começa antes do anterior assentar) e saída coreografada no fim (não só fade).',
  '- Mínimo por cena: 3 camadas, 8 ou mais elementos animados em tempos diferentes e ao menos 1 grafismo SVG ou canvas feito no código.',
  '- Evite: título centralizado sozinho sobre fundo liso, bullets simples, emojis como ícones, texto demais, cena morta (mais de ~2 s sem nenhuma ação real) e movimento de enfeite em loop.',
].join('\n');

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
    '- Troque o que é da cena: o DOM, o CSS específico e a timeline em seek(t). Reescreva esses blocos POR COMPLETO (um REPLACE grande é esperado aqui) — editar pouco e deixar a cena mais pobre que a referência é um erro. A composição é NOVA (não repita o layout da referência); paleta, fontes, grafismos e linguagem de movimento continuam os mesmos, e o nível de detalhe é pelo menos o da referência.',
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
    SCENE_CRAFT,
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
    // Efeito / transição / texto para a biblioteca do usuário (custom-assets.js)
    const asset = mode === 'create' && !scene ? normalizeAsset(body.asset) : null;
    const validate = asset?.kind === 'text' ? validateTextTemplate : validateClip;
    const sfx = body.sfx === true;
    // Bibliotecas preferidas (GSAP, three.js, one take); templates de texto têm contrato próprio
    const libs = asset?.kind === 'text' ? [] : normalizeLibs(body.libs);

    if (!prompt && !scene && !(asset && (asset.images.length || asset.html))) return res.status(400).json({ error: 'Escreva o que você quer no clipe.' });
    if (mode === 'edit' && !currentHtml.trim()) {
      return res.status(400).json({ error: 'HTML do clipe atual não informado para edição.' });
    }

    const { send, finish, signal } = openNdjson(res);

    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal, model: req.body?.model });
      const verb = mode === 'edit' ? 'Editando' : 'Gerando';
      const generate = (startAt = runner.order[0]) => runner.run({ systemText, contents, verb, startAt });

      // Edição: base64 embutido vira marcador (a IA não precisa ler imagens/fontes).
      // Cena encadeada: a base dos blocos é o HTML da cena anterior.
      const chained = !!scene?.previous;
      const { masked: maskedHtml, store: dataStore } = maskDataUris(chained ? scene.previous.html : currentHtml);
      const patchMode = mode === 'edit' || chained;

      const spec = chained ? '' : asset?.kind === 'text' ? loadTextSpec(root) : loadSpec(root);
      const systemText = buildSystemInstruction({ spec, w, h, fps, mode: patchMode ? 'edit' : 'create', libs, scene: !!scene });
      const sfxCatalog = sfx ? await sfxLibrary.promptText() : '';
      const userText = chained
        ? buildSceneContinuePrompt({ scene, previousHtml: maskedHtml, prompt, fps, sfx, sfxCatalog })
        : scene
          ? buildScenePrompt({ scene, prompt, fps, sfx, sfxCatalog })
          : asset
            ? buildAssetPrompt({ asset, prompt, w, h, fps })
            : buildUserPrompt({ mode, prompt, html: maskedHtml, name: reqName, w, h, fps, playhead, sfx, sfxCatalog });
      const contents = [{ role: 'user', parts: [{ text: userText }, ...(asset?.images || []).map(img => ({ inlineData: img }))] }];

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
        check = validate(html);
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
        const fixedCheck = validate(fixedHtml);
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
      const runner = await createRunner({ store, send, signal, model: req.body?.model });
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
      const outClips = out.clips
        .filter(c => ids.has(String(c.id)))
        .map(c => ({ id: String(c.id), cues: (Array.isArray(c.cues) ? c.cues : []).slice(0, 60) }));
      const external = await resolveSearchCues(outClips, send);
      finish({
        type: 'done',
        pack: String(out.pack || body.pack || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || null,
        clips: outClips,
        external,
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
   * POST /api/ai/camera → NDJSON (status/done/error)
   * { context, instruction?, style?: { intensity, margin }, images?: [{ t, dataUrl }], model? }
   * context = { frame, camera: { duration }, speech, elements, samples } (ver libs/camera-spec.js)
   * done: { summary, keyframes: [{ t, x, y, zoom, rotation, ease, reason, camX, camY, camZoom, camR }] }
   */
  app.post('/api/ai/camera', async (req, res) => {
    const body = req.body || {};
    const ctx = body.context && typeof body.context === 'object' ? body.context : null;
    if (!ctx || !ctx.frame || !ctx.camera || !Number(ctx.camera.duration)) {
      return res.status(400).json({ error: 'Faltam os dados da cena (quadro, duração da câmera e elementos).' });
    }
    const ctxText = JSON.stringify(ctx);
    if (ctxText.length > 400_000) return res.status(413).json({ error: 'Os dados da cena são grandes demais. Reduza o trecho da câmera.' });
    const instruction = String(body.instruction || '').trim().slice(0, 1500);
    const style = body.style || {};
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, 6).map(img => {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(img?.dataUrl || ''));
      return m && m[2].length < 2_500_000 ? { t: Number(img.t) || 0, mimeType: m[1], data: m[2] } : null;
    }).filter(Boolean);

    const { send, finish, signal } = openNdjson(res);
    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal, model: body.model });
      const text = [
        'DADOS DO PROJETO (JSON):',
        ctxText,
        '',
        CAMERA_STYLE_TEXT.intensity[style.intensity] || CAMERA_STYLE_TEXT.intensity.balanced,
        CAMERA_STYLE_TEXT.margin[style.margin] || CAMERA_STYLE_TEXT.margin.loose,
        images.length ? 'Anexei quadros reais da cena (com o instante de cada um) para você ver o que são os elementos.' : '',
        instruction ? `PEDIDO DO USUÁRIO: ${instruction}` : '',
        'Responda somente com o JSON dos keyframes.',
      ].filter(Boolean).join('\n');
      const parts = [{ text }];
      images.forEach(img => {
        parts.push({ text: `[Quadro da cena em t = ${img.t.toFixed(2)} s]` });
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      });
      const result = await runner.run({
        systemText: CAMERA_SPEC,
        contents: [{ role: 'user', parts }],
        verb: 'Planejando a câmera',
        config: { responseMimeType: 'application/json', responseSchema: CAMERA_SCHEMA, temperature: 0.5 },
      });
      const made = normalizeCamera(parseJsonLoose(result.text), { duration: ctx.camera.duration, frame: ctx.frame });
      if (!made) throw new AiError('A IA não devolveu keyframes de câmera válidos. Tente de novo ou descreva melhor o que destacar.', 502, 'invalid_camera');
      finish({ type: 'done', ...made, model: runner.model, rotated: runner.rotated, usage: runner.usage });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Câmera falhou:', e.message);
      finish({ type: 'error', error: e.message, code: e.code });
    }
  });

  /**
   * POST /api/ai/curve → NDJSON (status/done/error)
   * { prompt, current?: { p } | { pts }, model? }   done: { name, curve: { p } | { pts } }
   */
  app.post('/api/ai/curve', async (req, res) => {
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim().slice(0, 1500);
    if (!prompt) return res.status(400).json({ error: 'Descreva a curva que você quer.' });
    const { send, finish, signal } = openNdjson(res);
    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal, model: body.model });
      const current = body.current && typeof body.current === 'object' ? JSON.stringify(body.current).slice(0, 4000) : '';
      const userText = [
        `Descrição do movimento: ${prompt}`,
        current ? `Curva atual (ajuste a partir dela se a descrição pedir uma mudança): ${current}` : '',
      ].filter(Boolean).join('\n');
      const result = await runner.run({
        systemText: CURVE_SYSTEM,
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        verb: 'Criando a curva',
        config: { responseMimeType: 'application/json', responseSchema: CURVE_SCHEMA, temperature: 0.4 },
      });
      const made = curveFromAi(parseJsonLoose(result.text));
      if (!made) throw new AiError('A IA não devolveu uma curva válida. Tente descrever de outro jeito.', 502, 'invalid_curve');
      finish({ type: 'done', ...made, model: runner.model, rotated: runner.rotated, usage: runner.usage });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Curva falhou:', e.message);
      finish({ type: 'error', error: e.message, code: e.code });
    }
  });

  /**
   * POST /api/ai/audio/cleanup → NDJSON (status/done/error)
   * { words: [{ w, s, e }], kinds: ['hesitacao'|'repeticao'|'erro'|'fora'], prompt?, language? }
   * done: { cuts: [{ from, to, kind, reason }], summary }  (índices das palavras)
   */
  app.post('/api/ai/audio/cleanup', async (req, res) => {
    const body = req.body || {};
    const words = (Array.isArray(body.words) ? body.words : []).slice(0, 12000).map(w => ({
      w: String(w.w || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      s: Number(w.s) || 0,
      e: Number(w.e) || 0,
    }));
    const kinds = (Array.isArray(body.kinds) ? body.kinds : []).filter(k => k in CLEANUP_KINDS);
    if (!words.length) return res.status(400).json({ error: 'Nenhuma fala na transcrição.' });
    if (!kinds.length) return res.status(400).json({ error: 'Escolha ao menos um tipo de corte.' });

    const { send, finish, signal } = openNdjson(res);
    try {
      send({ type: 'status', message: 'Preparando…' });
      const runner = await createRunner({ store, send, signal, model: req.body?.model });
      const contents = [{ role: 'user', parts: [{ text: buildCleanupPrompt({ words, kinds, prompt: body.prompt, language: body.language }) }] }];
      const config = { responseMimeType: 'application/json', responseSchema: CLEANUP_SCHEMA, temperature: 0.2 };
      const result = await runner.run({ systemText: CLEANUP_SYSTEM, contents, verb: 'Analisando a fala', config });
      const out = parseJsonLoose(result.text);
      if (!out || !Array.isArray(out.cuts)) throw new AiError('A IA não devolveu cortes válidos. Tente novamente.', 502, 'invalid_cleanup');

      const last = words.length - 1;
      const cuts = out.cuts
        .map(c => ({
          from: Math.round(Number(c.from)), to: Math.round(Number(c.to)),
          kind: kinds.includes(c.kind) ? c.kind : null,
          reason: String(c.reason || '').slice(0, 80),
        }))
        .filter(c => c.kind && Number.isFinite(c.from) && Number.isFinite(c.to))
        .map(c => ({ ...c, from: Math.max(0, Math.min(c.from, c.to)), to: Math.min(last, Math.max(c.from, c.to)) }))
        .filter(c => c.from <= last && c.to - c.from < 400)
        .sort((a, b) => a.from - b.from);
      finish({ type: 'done', cuts, summary: String(out.summary || '').slice(0, 400), model: runner.model, usage: runner.usage });
    } catch (err) {
      const e = networkError(err);
      if (e.code !== 'aborted') console.warn('[AI] Limpeza de áudio falhou:', e.message);
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
      const runner = await createRunner({ store, send, signal, model: req.body?.model });
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

module.exports = { register, _internal: { extractHtml, validateClip, validateTextTemplate, extractDurationSec, extractTitle, compareModels, pickDefaultModel, loadSpec, rotationOrder, classifyError, parseRetryInfo, normalizePlanScenes, normalizeSceneRequest, buildScenePrompt, buildSceneContinuePrompt, buildSystemInstruction, fixSceneDuration, parseJsonLoose, resolveSearchCues, buildSfxPrompt, createRunner, curveFromAi } };
