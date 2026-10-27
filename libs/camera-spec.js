'use strict';
// libs/camera-spec.js
//
//  Câmera 2D controlada por IA: a especificação (lida pelo Gemini integrado em /api/ai/camera E
//  copiável para qualquer outra IA no botão "Copiar prompt de explicação") e a normalização do
//  resultado — a mesma para o que vem do Gemini e para o JSON colado de outra IA. Mudou o formato
//  aqui, mude também Interface/camera.js (aplicar os keyframes) e Interface/camera-ai.js (dados).

const EASES = ['linear', 'smooth', 'ease-out', 'ease-in', 'overshoot', 'hold'];

const SPEC = `# Câmera 2D do Motion Studio — pedido para a IA

Você é diretor de fotografia / motion designer. Planeje os MOVIMENTOS DA CÂMERA 2D de um vídeo feito de
cenas HTML animadas, de acordo com o que o áudio FALA e com ONDE cada elemento está na tela em cada momento.
Exemplo: o áudio fala de um mapa no segundo 12; o elemento do mapa aparece na posição (780, 640) a partir
do segundo 11,5 — a câmera se move até ele um pouco ANTES da menção e aproxima, e depois volta ao enquadramento geral.

## Como a câmera funciona
- Coordenadas em pixels do quadro do projeto: origem no canto superior esquerdo, x para a direita, y para baixo.
  O quadro tem frame.w × frame.h px (ex.: 1080 × 1920).
- A câmera "olha" para um ponto de foco (x, y) do quadro. zoom = 1 mostra o quadro inteiro; zoom = 2 mostra
  um recorte de metade da largura e da altura, centrado no foco. rotation (graus, padrão 0) gira a visão
  (positivo = horário); use no máximo ±8 e só quando o estilo pedir.
- O foco é limitado para a visão não sair do quadro (com zoom 2 em um quadro 1080×1920, x vai de 270 a 810).
  Elementos perto da borda ficam o mais centralizados que o limite permitir.
- Entre dois keyframes a câmera se move com a curva "ease" do keyframe de CHEGADA.

## Dados que você recebe (JSON)
{
  "frame": { "w": 1080, "h": 1920 },
  "camera": { "duration": 24.5 },                       // duração do trecho em segundos (t = 0 é o início da câmera)
  "speech": [ { "t": 2.1, "end": 5.4, "text": "…" } ],  // o que é dito, em segundos desde o início da câmera (pode estar vazio)
  "elements": [ { "id": "e1", "clip": "abertura", "label": "svg#mapa", "kind": "svg", "text": "" } ],
  "samples": [ { "t": 0, "on": [ ["e1", 540, 900, 700, 600], ["e2", 540, 300, 800, 120] ] } ]
}
- "elements": cada item da tela, com um id estável, o clip HTML de onde vem, um rótulo (tag#id.classe), o tipo
  (texto, imagem, svg, canvas, vídeo, caixa) e o texto que ele mostra.
- "samples": em cada instante t, os elementos visíveis como [id, x, y, w, h] — (x, y) é o CENTRO do elemento no
  quadro, w × h o tamanho. Entre amostras, assuma que o elemento fica onde estava (ou interpole a posição).
- Ligue a fala ao elemento pelo SENTIDO: o texto do elemento, o rótulo (ex.: "mapa", "preço", "logo") e o assunto da frase.

## O que você deve devolver (somente JSON, sem texto em volta, sem comentários)
{
  "summary": "uma frase sobre o plano de câmera",
  "keyframes": [
    { "t": 0,   "focus": { "x": 540, "y": 960 }, "zoom": 1,   "rotation": 0, "ease": "smooth",   "reason": "visão geral" },
    { "t": 11.2, "focus": { "x": 780, "y": 640 }, "zoom": 1.8, "rotation": 0, "ease": "ease-out", "reason": "vai ao mapa antes da menção" },
    { "t": 15.0, "focus": { "x": 780, "y": 640 }, "zoom": 1.8, "rotation": 0, "ease": "linear",   "reason": "segura no mapa enquanto fala dele" },
    { "t": 16.5, "focus": { "x": 540, "y": 960 }, "zoom": 1,   "rotation": 0, "ease": "smooth",   "reason": "volta ao geral" }
  ]
}
- t: segundos desde o início da câmera (0 a camera.duration), em ordem crescente. Comece em t = 0 e termine em t = camera.duration.
- ease: como a câmera CHEGA a este keyframe vindo do anterior — "linear", "smooth" (suave, padrão), "ease-out"
  (chega rápido e assenta; bom para aproximar), "ease-in" (acelera; bom para sair), "overshoot" (passa um pouco e
  volta; use raramente), "hold" (corte seco, sem deslizar).
- Para SEGURAR a câmera em um enquadramento, repita o mesmo foco/zoom em dois keyframes seguidos.

## Regras de direção
1. Chegue ao elemento 0,3 a 0,6 s ANTES de ele ser citado; segure enquanto se fala dele; saia quando o assunto mudar.
2. Enquadre pelo tamanho do elemento: zoom ≈ min(frame.w / (w · m), frame.h / (h · m)) com margem m entre 1,25 (justo)
   e 1,8 (folgado); mantenha zoom entre 1 e 3 (acima de 2,5 só em detalhes pequenos).
3. Entre assuntos sem elemento visual, ou em pausas de 1,5 s ou mais, volte ao enquadramento geral (foco no centro, zoom 1).
4. Não faça mais de um movimento a cada ~1,2 s; movimentos curtos de câmera parecem tremor. Prefira poucos movimentos claros.
5. Se um elemento se move na tela, acompanhe a posição dele entre as amostras (keyframes extras).
6. Respeite o pedido do usuário (estilo, intensidade, o que destacar) — ele vem depois dos dados.
7. Sem fala ou sem elementos relevantes: faça um movimento sutil (zoom 1 → 1,15) e explique no "reason".`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Texto em JSON (com ``` ou texto em volta) → objeto/array, ou null */
function parseLoose(text) {
  const src = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(src); } catch (_) { /* recorta o primeiro objeto/array */ }
  const a = src.search(/[\[{]/);
  const closeObj = src.lastIndexOf('}');
  const closeArr = src.lastIndexOf(']');
  const b = Math.max(closeObj, closeArr);
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(src.slice(a, b + 1)); } catch (_) { return null; }
}

/**
 * Resposta da IA (objeto { keyframes } ou lista) → keyframes válidos e seguros.
 * ctx = { duration, frame: { w, h } }. → { summary, keyframes: [{ t, x, y, zoom, rotation, ease, reason, camX, camY, camZoom, camR }] } | null
 */
function normalizeCamera(raw, ctx) {
  const W = Math.max(1, num(ctx?.frame?.w) || 1080);
  const H = Math.max(1, num(ctx?.frame?.h) || 1920);
  const D = Math.max(0.1, num(ctx?.duration) || 10);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.keyframes) ? raw.keyframes : Array.isArray(raw?.keys) ? raw.keys : null;
  if (!list || !list.length) return null;

  let keys = list.map(k => {
    const t = num(k?.t ?? k?.time ?? k?.at);
    const fx = num(k?.focus?.x ?? k?.focusX ?? k?.x);
    const fy = num(k?.focus?.y ?? k?.focusY ?? k?.y);
    let zoom = num(k?.zoom ?? k?.scale);
    if (zoom > 8) zoom /= 100;   // "200" querendo dizer 200 %
    return { t, fx, fy, zoom, rot: num(k?.rotation ?? k?.rot ?? k?.angle), ease: String(k?.ease || 'smooth').toLowerCase(), reason: String(k?.reason || k?.why || '').slice(0, 140) };
  }).filter(k => Number.isFinite(k.t));
  if (!keys.length) return null;

  keys.forEach(k => {
    k.t = clamp(k.t, 0, D);
    k.zoom = clamp(Number.isFinite(k.zoom) ? k.zoom : 1, 0.5, 4);
    k.rot = clamp(Number.isFinite(k.rot) ? k.rot : 0, -15, 15);
    if (!EASES.includes(k.ease)) k.ease = 'smooth';
    // o foco default é o centro; com zoom ≥ 1 a visão não sai do quadro
    const halfW = W / (2 * Math.max(1, k.zoom)), halfH = H / (2 * Math.max(1, k.zoom));
    k.fx = clamp(Number.isFinite(k.fx) ? k.fx : W / 2, halfW, W - halfW);
    k.fy = clamp(Number.isFinite(k.fy) ? k.fy : H / 2, halfH, H - halfH);
  });
  keys.sort((a, b) => a.t - b.t);

  // keyframes colados (< 50 ms) viram um só (vale o último)
  const merged = [];
  keys.forEach(k => {
    if (merged.length && k.t - merged[merged.length - 1].t < 0.05) merged[merged.length - 1] = k; else merged.push(k);
  });
  keys = merged.slice(0, 80);

  // começa na visão geral e termina segurando o último enquadramento
  if (keys[0].t > 0.05) keys.unshift({ t: 0, fx: W / 2, fy: H / 2, zoom: 1, rot: 0, ease: 'smooth', reason: 'visão geral' });
  else keys[0].t = 0;
  const last = keys[keys.length - 1];
  if (last.t < D - 0.05) keys.push({ ...last, t: D, ease: 'linear', reason: 'segura' });

  return {
    summary: String(raw?.summary || '').slice(0, 300),
    keyframes: keys.map(k => ({
      t: round(k.t), x: round(k.fx, 1), y: round(k.fy, 1), zoom: round(k.zoom), rotation: round(k.rot, 2), ease: k.ease, reason: k.reason,
      // valores prontos para as propriedades da câmera (pan em relação ao centro do quadro, zoom em %)
      camX: round(k.fx - W / 2, 1), camY: round(k.fy - H / 2, 1), camZoom: round(k.zoom * 100, 1), camR: round(k.rot, 2),
    })),
  };
}

function register(app) {
  /** Texto para copiar para outra IA (a especificação sem os dados do projeto) */
  app.get('/api/camera/spec', (req, res) => res.type('text/plain; charset=utf-8').send(SPEC));

  /** Valida a resposta de qualquer IA: { raw (objeto ou texto), duration, frame } → { summary, keyframes } */
  app.post('/api/camera/normalize', (req, res) => {
    const body = req.body || {};
    const raw = typeof body.raw === 'string' ? parseLoose(body.raw) : body.raw;
    if (!raw) return res.status(422).json({ error: 'Não encontrei JSON na resposta. Cole o JSON que a outra IA devolveu.' });
    const out = normalizeCamera(raw, { duration: body.duration, frame: body.frame });
    if (!out) return res.status(422).json({ error: 'O JSON não tem "keyframes" válidos (cada um precisa de "t" e "focus").' });
    res.json(out);
  });
}

module.exports = { SPEC, EASES, normalizeCamera, parseLoose, register };
