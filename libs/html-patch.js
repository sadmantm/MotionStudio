'use strict';
// html-patch.js
//
//  Edição por blocos para a IA: em vez de regerar o HTML inteiro do clipe, o
//  modelo devolve só os trechos que mudam, no formato SEARCH/REPLACE:
//
//    <<<<<<< SEARCH
//    trecho copiado do HTML atual
//    =======
//    trecho novo
//    >>>>>>> REPLACE
//
//  A aplicação tolera os erros típicos de LLM, em camadas:
//    1. exato  2. ignorando indentação  3. ignorando quebras/espaços
//    4. aproximado por linha (só quando há um único candidato claro)
//  Blocos que não casam voltam em `failed` para uma rodada de correção.

// #region Parser
const RE_START = /^\s*<{5,}\s*SEARCH\s*$/;
const RE_SPLIT = /^\s*={5,}\s*$/;
const RE_END   = /^\s*>{5,}\s*REPLACE\s*$/;

/** → { blocks: [{ search, replace }], unterminated } */
function parsePatchBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let mode = null;          // null | 'search' | 'replace'
  let search = [];
  let replace = [];

  for (const line of lines) {
    if (mode === null) {
      if (RE_START.test(line)) { mode = 'search'; search = []; replace = []; }
      continue;
    }
    if (mode === 'search') {
      if (RE_SPLIT.test(line)) mode = 'replace';
      else search.push(line);
      continue;
    }
    if (RE_END.test(line)) {
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      mode = null;
    } else if (RE_START.test(line)) {
      // Modelo esqueceu o fechamento: fecha o anterior e abre outro
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
      mode = 'search'; search = []; replace = [];
    } else {
      replace.push(line);
    }
  }

  // Resposta cortada no meio de um REPLACE: não aplica um bloco pela metade
  return { blocks, unterminated: mode !== null };
}

function looksLikePatch(text) {
  return /^\s*<{5,}\s*SEARCH\s*$/m.test(String(text || ''));
}
// #endregion

// #region Localização do trecho
function countOccurrences(hay, needle) {
  let count = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) count++;
  return count;
}

/** Remove linhas vazias nas pontas (o modelo costuma sobrar/faltar uma) */
function trimBlankLines(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** Offsets [início, fim) de cada linha do documento */
function lineOffsets(doc) {
  const out = [];
  let pos = 0;
  for (const line of doc.split('\n')) {
    out.push([pos, pos + line.length]);
    pos += line.length + 1;
  }
  return out;
}

const leadingWs = s => s.match(/^[ \t]*/)[0];

/**
 * Reindenta o REPLACE quando o SEARCH casou com indentação diferente
 * (ex.: modelo mandou o trecho sem os 4 espaços do <script>).
 */
function reindent(replace, searchIndent, docIndent) {
  if (searchIndent === docIndent) return replace;
  return replace.split('\n').map(line => {
    if (!line.trim()) return line;
    if (line.startsWith(searchIndent)) return docIndent + line.slice(searchIndent.length);
    return docIndent + line.trimStart();
  }).join('\n');
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Similaridade de Dice entre duas linhas (0–1) */
function lineSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a), gb = bigrams(b);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** → { start, end, replace } | { error } */
function locate(doc, search, replace) {
  if (!search.trim()) return { error: 'SEARCH vazio' };

  // 1. Exato
  const exact = countOccurrences(doc, search);
  if (exact === 1) {
    const start = doc.indexOf(search);
    return { start, end: start + search.length, replace, how: 'exato' };
  }
  if (exact > 1) return { error: `SEARCH aparece ${exact} vezes (ambíguo) — inclua mais linhas de contexto` };

  const docLines  = doc.split('\n');
  const offsets   = lineOffsets(doc);
  const needle    = trimBlankLines(search.split('\n'));
  const n         = needle.length;
  if (!n) return { error: 'SEARCH vazio' };
  const needleTrim = needle.map(l => l.trim());

  const rangeFor = (i, how, extra = {}) => {
    const start = offsets[i][0];
    const end   = offsets[i + n - 1][1];
    const firstDoc    = docLines.slice(i, i + n).find(l => l.trim()) || '';
    const firstSearch = needle.find(l => l.trim()) || '';
    return {
      start, end, how,
      replace: reindent(trimBlankLines(replace.split('\n')).join('\n'), leadingWs(firstSearch), leadingWs(firstDoc)),
      ...extra,
    };
  };

  // 2. Linha a linha, ignorando indentação e espaços nas pontas
  const trimmedHits = [];
  for (let i = 0; i + n <= docLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n && ok; j++) ok = docLines[i + j].trim() === needleTrim[j];
    if (ok) trimmedHits.push(i);
  }
  if (trimmedHits.length === 1) return rangeFor(trimmedHits[0], 'indentação');
  if (trimmedHits.length > 1) return { error: `SEARCH aparece ${trimmedHits.length} vezes (ambíguo) — inclua mais linhas de contexto` };

  // 3. Ignorando qualquer diferença de espaços/quebras de linha
  const collapsed = [];
  const map = [];
  let prevWs = true;
  for (let i = 0; i < doc.length; i++) {
    const ws = /\s/.test(doc[i]);
    if (ws) {
      if (!prevWs) { collapsed.push(' '); map.push(i); }
    } else {
      collapsed.push(doc[i]);
      map.push(i);
    }
    prevWs = ws;
  }
  const flatDoc    = collapsed.join('');
  const flatNeedle = search.replace(/\s+/g, ' ').trim();
  const flatCount  = countOccurrences(flatDoc, flatNeedle);
  if (flatCount === 1) {
    const at = flatDoc.indexOf(flatNeedle);
    return { start: map[at], end: map[at + flatNeedle.length - 1] + 1, replace, how: 'espaços' };
  }
  if (flatCount > 1) return { error: `SEARCH aparece ${flatCount} vezes (ambíguo) — inclua mais linhas de contexto` };

  // 4. Aproximado: janela de n linhas com maior similaridade média.
  //    Só aceita com nota alta e sem empate (senão substitui o trecho errado).
  if (n >= 2) {
    let best = -1, bestScore = 0, second = 0;
    for (let i = 0; i + n <= docLines.length; i++) {
      // Corte rápido: a 1ª linha precisa ser parecida
      const first = lineSimilarity(docLines[i].trim(), needleTrim[0]);
      if (first < 0.5) continue;
      let sum = first;
      for (let j = 1; j < n; j++) sum += lineSimilarity(docLines[i + j].trim(), needleTrim[j]);
      const score = sum / n;
      if (score > bestScore) { second = bestScore; bestScore = score; best = i; }
      else if (score > second) second = score;
    }
    if (best >= 0 && bestScore >= 0.85 && bestScore - second >= 0.05) {
      return rangeFor(best, 'aproximado', { score: bestScore });
    }
  }

  return { error: 'SEARCH não encontrado no HTML atual' };
}
// #endregion

// #region Aplicação
/**
 * Aplica os blocos em ordem, cada um sobre o resultado do anterior.
 * → { html, applied: [{ index, how }], failed: [{ index, search, error }] }
 */
function applyPatchBlocks(html, blocks) {
  const crlf = /\r\n/.test(html);
  let doc = String(html || '').replace(/\r\n?/g, '\n');
  const applied = [];
  const failed  = [];

  blocks.forEach((block, index) => {
    const search  = block.search.replace(/\r\n?/g, '\n');
    const replace = block.replace.replace(/\r\n?/g, '\n');
    const hit = locate(doc, search, replace);
    if (hit.error) {
      failed.push({ index, search, error: hit.error });
      return;
    }
    doc = doc.slice(0, hit.start) + hit.replace + doc.slice(hit.end);
    applied.push({ index, how: hit.how, ...(hit.score ? { score: +hit.score.toFixed(3) } : {}) });
  });

  return { html: crlf ? doc.replace(/\n/g, '\r\n') : doc, applied, failed };
}
// #endregion

// #region Máscara de data: URIs
// Imagens/fontes embutidas em base64 custam milhares de tokens e a IA nunca
// precisa lê-las: viram um marcador curto na ida e voltam no resultado.
const DATA_URI_RE = /data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=\s]{512,}/g;

function maskDataUris(html) {
  const store = [];
  const masked = String(html || '').replace(DATA_URI_RE, match => {
    const head = match.slice(0, match.indexOf(',') + 1);
    store.push(match);
    return `${head}__MS_DATA_${store.length}__`;
  });
  return { masked, store };
}

function unmaskDataUris(html, store) {
  if (!store?.length) return html;
  return String(html || '').replace(/data:[^,\s"')]*,__MS_DATA_(\d+)__/g, (match, n) => store[Number(n) - 1] || match);
}
// #endregion

module.exports = { parsePatchBlocks, looksLikePatch, applyPatchBlocks, maskDataUris, unmaskDataUris, _internal: { locate, lineSimilarity } };
