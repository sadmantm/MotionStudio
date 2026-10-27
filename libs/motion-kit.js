/* motion-kit.js — kit de animação dos clipes HTML (window.MS)
 *
 *  Injetado pelo editor, pelo export e pelas miniaturas em todo clipe HTML
 *  (libs/clip-host.js), ANTES dos scripts do clipe. Três partes:
 *
 *  1. Funções puras do tempo (mesmo t → mesmo quadro): interpolate, spring,
 *     easings, ruído e sorteio com semente, texto que cabe na caixa, caminhos
 *     e formas SVG, contadores. MS.motion({...}) monta o contrato window.Motion.
 *
 *  2. Adaptadores: um clipe SEM window.Motion.seek é dirigido pelo que já usa —
 *     timelines GSAP (inclusive window.__timelines do HyperFrames, com os
 *     .clip[data-start][data-duration]), Lottie, anime.js, animações CSS/Web
 *     Animations ou, em último caso, um relógio virtual para
 *     requestAnimationFrame/performance.now/Date.now. O window.Motion criado
 *     aqui é o mesmo contrato que o preview e o export já usam.
 *
 *  3. Áudio do projeto: MS.audio(t) → nível, graves/médios/agudos, 16 bandas
 *     e batidas, pré-calculados no servidor (libs/audio-analysis.js) e
 *     entregues pelo host em window.__msAudio.
 */
(function (root) {
  'use strict';

  if (root.MS && root.MS.kit) return;
  const hasDOM = typeof document !== 'undefined';

  // #region Escalares e easings
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, t0, t1) => (t1 <= t0 ? (t >= t1 ? 1 : 0) : clamp((t - t0) / (t1 - t0)));

  /** Curva cúbica de Bézier como no CSS (x1, y1, x2, y2) */
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = u => ((ax * u + bx) * u + cx) * u;
    const sy = u => ((ay * u + by) * u + cy) * u;
    const dx = u => (3 * ax * u + 2 * bx) * u + cx;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let u = x;
      for (let i = 0; i < 8; i++) {
        const err = sx(u) - x;
        if (Math.abs(err) < 1e-6) return sy(u);
        const d = dx(u);
        if (Math.abs(d) < 1e-6) break;
        u -= err / d;
      }
      let lo = 0, hi = 1;
      u = x;
      for (let i = 0; i < 30; i++) {
        const v = sx(u);
        if (Math.abs(v - x) < 1e-6) break;
        if (x > v) lo = u; else hi = u;
        u = (lo + hi) / 2;
      }
      return sy(u);
    };
  }

  const powIn = n => u => Math.pow(u, n);
  const powOut = n => u => 1 - Math.pow(1 - u, n);
  const powInOut = n => u => (u < 0.5 ? Math.pow(2, n - 1) * Math.pow(u, n) : 1 - Math.pow(-2 * u + 2, n) / 2);
  const BACK = 1.70158;
  const outBounce = u => {
    const n = 7.5625, d = 2.75;
    if (u < 1 / d) return n * u * u;
    if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
    if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
    return n * (u -= 2.625 / d) * u + 0.984375;
  };
  const ease = {
    linear: u => u,
    inQuad: powIn(2), outQuad: powOut(2), inOutQuad: powInOut(2),
    inCubic: powIn(3), outCubic: powOut(3), inOutCubic: powInOut(3),
    inQuart: powIn(4), outQuart: powOut(4), inOutQuart: powInOut(4),
    inQuint: powIn(5), outQuint: powOut(5), inOutQuint: powInOut(5),
    inSine: u => 1 - Math.cos((u * Math.PI) / 2),
    outSine: u => Math.sin((u * Math.PI) / 2),
    inOutSine: u => -(Math.cos(Math.PI * u) - 1) / 2,
    inExpo: u => (u <= 0 ? 0 : Math.pow(2, 10 * u - 10)),
    outExpo: u => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u)),
    inOutExpo: u => (u <= 0 ? 0 : u >= 1 ? 1 : u < 0.5 ? Math.pow(2, 20 * u - 10) / 2 : (2 - Math.pow(2, -20 * u + 10)) / 2),
    inCirc: u => 1 - Math.sqrt(1 - u * u),
    outCirc: u => Math.sqrt(1 - Math.pow(u - 1, 2)),
    inOutCirc: u => (u < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * u, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * u + 2, 2)) + 1) / 2),
    inBack: u => (BACK + 1) * u * u * u - BACK * u * u,
    outBack: u => 1 + (BACK + 1) * Math.pow(u - 1, 3) + BACK * Math.pow(u - 1, 2),
    inOutBack: u => {
      const c = BACK * 1.525;
      return u < 0.5
        ? (Math.pow(2 * u, 2) * ((c + 1) * 2 * u - c)) / 2
        : (Math.pow(2 * u - 2, 2) * ((c + 1) * (u * 2 - 2) + c) + 2) / 2;
    },
    outElastic: u => (u <= 0 ? 0 : u >= 1 ? 1 : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
    outBounce,
    /** out com overshoot ajustável (s = 1.70158 padrão) */
    overshoot: (s = BACK) => u => 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2),
    bezier,
    steps: n => u => Math.min(1, Math.floor(u * n) / (n - 1 || 1)),
  };
  // #endregion

  // #region interpolate / cores / spring
  /**
   * Interpolação por trechos (como no Remotion): input crescente, output de
   * números (ou arrays de números). Clampa nas pontas por padrão; extrapolate
   * 'extend' continua a reta. easing: função ou uma por trecho.
   */
  function interpolate(x, input, output, opts = {}) {
    const n = input.length;
    if (n < 2 || !output || output.length !== n) throw new Error('MS.interpolate: input e output precisam ter o mesmo tamanho (>= 2)');
    const left = opts.extrapolateLeft || opts.extrapolate || (opts.clamp === false ? 'extend' : 'clamp');
    const right = opts.extrapolateRight || opts.extrapolate || (opts.clamp === false ? 'extend' : 'clamp');
    let i = 1;
    while (i < n - 1 && x > input[i]) i++;
    const x0 = input[i - 1], x1 = input[i];
    let u = x1 === x0 ? (x >= x1 ? 1 : 0) : (x - x0) / (x1 - x0);
    if (u < 0 && left === 'clamp') u = 0;
    if (u > 1 && right === 'clamp') u = 1;
    const easing = Array.isArray(opts.easing) ? opts.easing[i - 1] : opts.easing;
    if (typeof easing === 'function' && u >= 0 && u <= 1) u = easing(u);
    const a = output[i - 1], b = output[i];
    return Array.isArray(a) ? a.map((v, k) => lerp(v, b[k], u)) : lerp(a, b, u);
  }

  let colorCtx = null;
  /** Cor CSS → [r, g, b, a] (hex, rgb(a), hsl(a) e nomes no navegador) */
  function parseColor(c) {
    let s = String(c || '').trim();
    if (!/^#|^rgb/i.test(s) && hasDOM) {
      try {
        colorCtx = colorCtx || document.createElement('canvas').getContext('2d');
        colorCtx.fillStyle = '#000';
        colorCtx.fillStyle = s;
        s = colorCtx.fillStyle;
      } catch (_) { /* sem canvas */ }
    }
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(ch => ch + ch).join('');
      const v = parseInt(h.slice(0, 6), 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
    }
    return [0, 0, 0, 1];
  }
  const rgba = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;
  const mixColor = (a, b, k) => {
    const A = parseColor(a), B = parseColor(b);
    return rgba(A.map((v, i) => lerp(v, B[i], clamp(k))));
  };
  function interpolateColors(x, input, colors, opts = {}) {
    const parsed = colors.map(parseColor);
    return rgba(interpolate(x, input, parsed, opts));
  }

  /**
   * Mola amortecida em forma fechada (sem simular quadro a quadro): valor no
   * tempo t (s) indo de `from` a `to`. Padrões do Remotion: stiffness 100,
   * damping 10, mass 1 (ζ = 0,5).
   */
  function spring(t, cfg = {}) {
    const { stiffness = 100, damping = 10, mass = 1, from = 0, to = 1, velocity = 0, delay = 0, overshootClamping = false } = cfg;
    const tt = t - delay;
    if (!(tt > 0)) return from;
    const w0 = Math.sqrt(stiffness / mass);
    const zeta = damping / (2 * Math.sqrt(stiffness * mass));
    const d = from - to;
    let x;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = Math.exp(-zeta * w0 * tt) * (d * Math.cos(wd * tt) + ((velocity + zeta * w0 * d) / wd) * Math.sin(wd * tt));
    } else if (zeta === 1) {
      x = Math.exp(-w0 * tt) * (d + (velocity + w0 * d) * tt);
    } else {
      const s = Math.sqrt(zeta * zeta - 1);
      const r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s);
      const c1 = (velocity - r2 * d) / (r1 - r2);
      x = c1 * Math.exp(r1 * tt) + (d - c1) * Math.exp(r2 * tt);
    }
    let v = to + x;
    if (overshootClamping) v = from < to ? Math.min(v, to) : Math.max(v, to);
    return v;
  }
  /** Quanto tempo (s) a mola leva para assentar (|erro| < eps da distância) */
  spring.duration = function (cfg = {}, eps = 0.005) {
    const span = Math.abs((cfg.to ?? 1) - (cfg.from ?? 0)) || 1;
    let quiet = 0;
    for (let t = 0; t < 20; t += 1 / 120) {
      const err = Math.abs(spring(t, { ...cfg, delay: 0 }) - (cfg.to ?? 1)) / span;
      quiet = err < eps ? quiet + 1 : 0;
      if (quiet > 12) return Math.max(0, t - 0.1);
    }
    return 20;
  };
  // #endregion

  // #region Sorteio e ruído com semente
  function hashSeed(seed) {
    let h = 2166136261 >>> 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Número em [0, 1) sempre igual para a mesma semente (string ou número) */
  const random = seed => mulberry(hashSeed(seed))();
  /** Gerador com semente: const r = MS.rng('estrelas'); r() → [0, 1) */
  const rng = seed => mulberry(hashSeed(seed));

  const perms = new Map();
  function perm(seed) {
    const key = String(seed);
    let p = perms.get(key);
    if (p) return p;
    const r = rng('noise:' + key);
    const base = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [base[i], base[j]] = [base[j], base[i]];
    }
    p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    perms.set(key, p);
    return p;
  }
  const GRAD3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const F3 = 1 / 3, G3 = 1 / 6;

  /** Ruído simplex 2D em [-1, 1] (semente, x, y) */
  function noise2D(seed, x, y) {
    const p = perm(seed);
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const corner = (gx, gy, g) => {
      let tt = 0.5 - gx * gx - gy * gy;
      if (tt < 0) return 0;
      tt *= tt;
      const gr = GRAD3[g % 12];
      return tt * tt * (gr[0] * gx + gr[1] * gy);
    };
    return 70 * (
      corner(x0, y0, p[ii + p[jj]]) +
      corner(x1, y1, p[ii + i1 + p[jj + j1]]) +
      corner(x2, y2, p[ii + 1 + p[jj + 1]])
    );
  }

  /** Ruído simplex 3D em [-1, 1] (semente, x, y, z) — use z = t para evoluir no tempo */
  function noise3D(seed, x, y, z) {
    const p = perm(seed);
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const corner = (gx, gy, gz, g) => {
      let tt = 0.6 - gx * gx - gy * gy - gz * gz;
      if (tt < 0) return 0;
      tt *= tt;
      const gr = GRAD3[g % 12];
      return tt * tt * (gr[0] * gx + gr[1] * gy + gr[2] * gz);
    };
    return 32 * (
      corner(x0, y0, z0, p[ii + p[jj + p[kk]]]) +
      corner(x1, y1, z1, p[ii + i1 + p[jj + j1 + p[kk + k1]]]) +
      corner(x2, y2, z2, p[ii + i2 + p[jj + j2 + p[kk + k2]]]) +
      corner(x3, y3, z3, p[ii + 1 + p[jj + 1 + p[kk + 1]]])
    );
  }

  /** Tremida orgânica e determinística (px ou graus) */
  function wiggle(t, { freq = 2, amp = 10, seed = 1, octaves = 2 } = {}) {
    let v = 0, a = 1, f = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      v += a * noise2D(seed, t * freq * f, o * 31.7);
      norm += a;
      a *= 0.5;
      f *= 2;
    }
    return (v / norm) * amp;
  }
  // #endregion

  // #region Tempo
  const stagger = (i, each, from = 0) => from + i * each;
  const loop = (t, period) => ((t % period) + period) % period;
  const pingpong = (t, period) => {
    const p = loop(t, 2 * period);
    return p > period ? 2 * period - p : p;
  };
  /** Número contando de `from` até `to` entre t0 e t1, já formatado (pt-BR) */
  function countUp(t, t0, t1, to, { from = 0, decimals = 0, easing = ease.outExpo, locale = 'pt-BR', prefix = '', suffix = '' } = {}) {
    const v = lerp(from, to, easing(seg(t, t0, t1)));
    return prefix + v.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  }
  // #endregion

  // #region Texto
  let textCtx = null;
  const fontString = ({ fontSize = 100, fontFamily = 'sans-serif', fontWeight = 400, fontStyle = 'normal' } = {}) =>
    `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;

  /** Largura/altura de uma linha de texto (fontes já carregadas: use em whenReady) */
  function measureText(text, opts = {}) {
    if (!hasDOM) return { width: 0, height: 0 };
    textCtx = textCtx || document.createElement('canvas').getContext('2d');
    textCtx.font = fontString(opts);
    const s = String(text);
    const w = textCtx.measureText(s).width + (opts.letterSpacing || 0) * Math.max(0, s.length - 1);
    return { width: w, height: (opts.fontSize || 100) * 1.2 };
  }

  /** Maior fontSize (px) em que o texto cabe numa linha de `width` px */
  function fitText(text, { width, fontFamily = 'sans-serif', fontWeight = 400, fontStyle = 'normal', letterSpacing = 0, min = 8, max = 1000 } = {}) {
    const at100 = measureText(text, { fontSize: 100, fontFamily, fontWeight, fontStyle }).width;
    if (!at100 || !width) return min;
    const chars = Math.max(0, String(text).length - 1);
    const size = (100 * (width - letterSpacing * chars)) / at100;
    return clamp(Math.floor(size * 100) / 100, min, max);
  }

  /** Ajusta o font-size de um elemento para o texto caber em `width` (padrão: largura do pai) */
  function fitElement(el, { width, min = 8, max = 1000 } = {}) {
    if (!el || !hasDOM) return 0;
    const cs = getComputedStyle(el);
    const w = width || (el.parentElement ? el.parentElement.clientWidth : el.clientWidth);
    const size = fitText(el.textContent, {
      width: w, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
      letterSpacing: parseFloat(cs.letterSpacing) || 0, min, max,
    });
    el.style.fontSize = size + 'px';
    return size;
  }

  /**
   * Quebra o texto em <span> por 'chars', 'words' ou 'lines' (linhas medidas
   * no layout atual). Idempotente. Palavras nunca quebram no meio.
   */
  function split(el, by = 'chars') {
    if (!el || !hasDOM) return [];
    if (el.__msSplit && el.__msSplit.by === by) return el.__msSplit.items;
    const text = el.__msText != null ? el.__msText : (el.__msText = el.textContent);
    el.textContent = '';
    const words = [];
    const chars = [];
    text.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        el.appendChild(document.createTextNode(part));
        return;
      }
      const w = document.createElement('span');
      w.className = 'ms-word';
      w.style.display = 'inline-block';
      w.style.whiteSpace = 'nowrap';
      if (by === 'chars') {
        for (const ch of part) {
          const c = document.createElement('span');
          c.className = 'ms-char';
          c.style.display = 'inline-block';
          c.textContent = ch;
          w.appendChild(c);
          chars.push(c);
        }
      } else {
        w.textContent = part;
      }
      el.appendChild(w);
      words.push(w);
    });
    let items = by === 'chars' ? chars : words;
    if (by === 'lines') {
      const lines = [];
      let top = null, cur = null;
      words.forEach(w => {
        if (top === null || Math.abs(w.offsetTop - top) > 2) {
          top = w.offsetTop;
          cur = [];
          lines.push(cur);
        }
        cur.push(w);
      });
      el.textContent = '';
      items = lines.map((ws, i) => {
        const line = document.createElement('span');
        line.className = 'ms-line';
        line.style.display = 'block';
        line.textContent = ws.map(w => w.textContent).join(' ');
        el.appendChild(line);
        if (i < lines.length - 1) el.appendChild(document.createTextNode(' '));
        return line;
      });
    }
    el.__msSplit = { by, items };
    return items;
  }
  // #endregion

  // #region Caminhos e formas SVG
  const SVGNS = 'http://www.w3.org/2000/svg';
  let scratchPath = null;
  function pathEl(d) {
    if (!hasDOM) throw new Error('MS.path precisa de DOM');
    scratchPath = scratchPath || document.createElementNS(SVGNS, 'path');
    if (scratchPath.getAttribute('d') !== d) scratchPath.setAttribute('d', d);
    return scratchPath;
  }
  const lengthCache = new Map();
  function pathLength(d) {
    let L = lengthCache.get(d);
    if (L == null) {
      L = pathEl(d).getTotalLength();
      if (lengthCache.size > 300) lengthCache.clear();
      lengthCache.set(d, L);
    }
    return L;
  }
  const path = {
    length: pathLength,
    /** Ponto e ângulo (graus) na fração p do caminho */
    point(d, p) {
      const el = pathEl(d);
      const L = pathLength(d);
      const at = clamp(p) * L;
      const a = el.getPointAtLength(at);
      const b = el.getPointAtLength(Math.min(L, at + 0.5));
      const c = el.getPointAtLength(Math.max(0, at - 0.5));
      return { x: a.x, y: a.y, angle: (Math.atan2(b.y - c.y, b.x - c.x) * 180) / Math.PI };
    },
    /** Desenho do traço: { strokeDasharray, strokeDashoffset } para a fração p */
    evolve(p, d) {
      const L = pathLength(d);
      return { strokeDasharray: `${L} ${L}`, strokeDashoffset: L * (1 - clamp(p)) };
    },
    /** Desenha o traço de um <path>/<line>/<circle> do DOM até a fração p */
    draw(el, p) {
      if (!el) return 0;
      if (el.__msLen == null) el.__msLen = el.getTotalLength ? el.getTotalLength() : 0;
      const L = el.__msLen;
      el.style.strokeDasharray = `${L} ${L}`;
      el.style.strokeDashoffset = String(L * (1 - clamp(p)));
      return L;
    },
    /** Morph entre dois caminhos quaisquer (reamostrados em `samples` pontos) */
    morph(p, a, b, samples = 96) {
      const key = a + '|' + b + '|' + samples;
      let pts = morphCache.get(key);
      if (!pts) {
        const sample = d => {
          const el = pathEl(d);
          const L = el.getTotalLength();
          return Array.from({ length: samples }, (_, i) => {
            const q = el.getPointAtLength((L * i) / (samples - 1));
            return [q.x, q.y];
          });
        };
        pts = [sample(a), sample(b)];
        if (morphCache.size > 60) morphCache.clear();
        morphCache.set(key, pts);
      }
      const k = clamp(p);
      return pts[0].map((q, i) => `${i ? 'L' : 'M'}${lerp(q[0], pts[1][i][0], k).toFixed(2)} ${lerp(q[1], pts[1][i][1], k).toFixed(2)}`).join(' ') + (/z\s*$/i.test(a) && /z\s*$/i.test(b) ? ' Z' : '');
    },
  };
  const morphCache = new Map();

  /** Formas como string de path, centradas em (0, 0) */
  const shape = {
    circle: r => `M ${-r} 0 A ${r} ${r} 0 1 0 ${r} 0 A ${r} ${r} 0 1 0 ${-r} 0 Z`,
    rect(w, h, r = 0) {
      const x = -w / 2, y = -h / 2;
      r = Math.min(r, w / 2, h / 2);
      if (!r) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      return `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`;
    },
    polygon(n, r, rotation = -90) {
      return Array.from({ length: n }, (_, i) => {
        const a = ((rotation + (360 * i) / n) * Math.PI) / 180;
        return `${i ? 'L' : 'M'} ${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
      }).join(' ') + ' Z';
    },
    star(points = 5, outer = 100, inner = 45, rotation = -90) {
      return Array.from({ length: points * 2 }, (_, i) => {
        const r = i % 2 ? inner : outer;
        const a = ((rotation + (180 * i) / points) * Math.PI) / 180;
        return `${i ? 'L' : 'M'} ${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
      }).join(' ') + ' Z';
    },
  };
  // #endregion

  // #region Áudio do projeto
  const BANDS = 16;
  const silent = () => ({ level: 0, bass: 0, mid: 0, treble: 0, beat: false, pulse: 0, bands: new Array(BANDS).fill(0), active: false });
  let audioCache = null;
  function audioTrack() {
    const a = root.__msAudio;
    if (!a || !a.data) return null;
    if (audioCache && audioCache.src === a) return audioCache;
    let bytes;
    try {
      const bin = atob(a.data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (_) {
      return null;
    }
    audioCache = { src: a, bytes, fps: a.fps || 30, stride: a.stride || 6 + BANDS, frames: a.frames || 0, bands: a.bands || BANDS };
    return audioCache;
  }
  /**
   * Áudio do projeto no tempo t DESTE clipe (o host informa onde o clipe está
   * na timeline). Tudo em 0–1: level, bass, mid, treble, bands[16] (grave →
   * agudo), pulse (decai depois de cada batida) e beat (true no quadro da batida).
   */
  function audio(t) {
    const d = audioTrack();
    if (!d) return silent();
    const map = d.src.map || {};
    const pt = (map.offset || 0) + (t - (map.sourceIn || 0)) * (map.scale || 1);
    const f = Math.floor(pt * d.fps + 1e-6);
    if (!(f >= 0 && f < d.frames)) return silent();
    const o = f * d.stride, b = d.bytes;
    const bands = [];
    for (let i = 0; i < d.bands; i++) bands.push(b[o + 6 + i] / 255);
    return { level: b[o] / 255, pulse: b[o + 1] / 255, beat: b[o + 2] > 127, bass: b[o + 3] / 255, mid: b[o + 4] / 255, treble: b[o + 5] / 255, bands, active: true };
  }
  /** n barras (reamostra as 16 bandas) — para visualizadores */
  audio.bars = function (t, n = 32) {
    const { bands } = audio(t);
    return Array.from({ length: n }, (_, i) => {
      const x = (i / Math.max(1, n - 1)) * (bands.length - 1);
      const j = Math.floor(x);
      return lerp(bands[j], bands[Math.min(bands.length - 1, j + 1)], x - j);
    });
  };
  audio.available = () => !!audioTrack();
  // #endregion

  // #region Contrato
  /**
   * Monta window.Motion: MS.motion({ fps, durationInSeconds, render(t), ready? }).
   * render só roda depois de ready (fontes, imagens, modelos…); seeks
   * anteriores ficam guardados e o último é aplicado ao ficar pronto.
   */
  function motion({ fps = 30, durationInSeconds = 5, render, ready } = {}) {
    const config = { fps, durationInSeconds, totalFrames: Math.round(fps * durationInSeconds) };
    let isReady = false, pending = 0, readyPromise = null;
    const draw = t => {
      try { render && render(clamp(t, 0, durationInSeconds)); } catch (err) { console.error('[MS.motion] render:', err); }
    };
    const M = {
      config,
      whenReady() {
        if (!readyPromise) {
          readyPromise = Promise.resolve(hasDOM && document.fonts ? document.fonts.ready : null)
            .then(() => (ready ? ready() : null))
            .catch(err => console.error('[MS.motion] ready:', err))
            .then(() => { isReady = true; draw(pending); });
        }
        return readyPromise;
      },
      seek(t) {
        pending = Number(t) || 0;
        if (isReady) draw(pending);
      },
      renderFrame(f) { return M.seek(f / fps); },
    };
    root.Motion = M;
    M.whenReady();
    return M;
  }
  // #endregion

  // #region Adaptadores (clipe sem window.Motion.seek)
  const real = {
    raf: root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : null,
    caf: root.cancelAnimationFrame ? root.cancelAnimationFrame.bind(root) : null,
    perfNow: root.performance && root.performance.now ? root.performance.now.bind(root.performance) : () => Date.now(),
    dateNow: Date.now,
  };
  // Relógio virtual: só liga quando nada mais dirige o clipe e ele usa rAF.
  // realPending: callbacks já entregues ao rAF real (migram na troca);
  // firstTs: 1º timestamp entregue — a base do relógio, então o padrão
  // "t0 = primeiro ts" do clipe vê exatamente t * 1000 ms.
  const clock = { on: false, t: 0, perfBase: 0, dateBase: 0, queue: new Map(), realPending: new Map(), seq: 1e9, rafCalls: 0, firstTs: null };

  function startClock() {
    if (clock.on) return;
    clock.on = true;
    const now = real.perfNow();
    clock.perfBase = clock.firstTs != null ? clock.firstTs : now;
    clock.dateBase = real.dateNow() - (now - clock.perfBase);
    clock.realPending.forEach((cb, id) => {
      if (real.caf) real.caf(id);
      clock.queue.set(id, cb);
    });
    clock.realPending.clear();
  }

  if (hasDOM && real.raf) {
    root.requestAnimationFrame = function (cb) {
      clock.rafCalls++;
      if (!clock.on) {
        const id = real.raf(ts => {
          clock.realPending.delete(id);
          if (clock.firstTs == null) clock.firstTs = ts;
          cb(ts);
        });
        clock.realPending.set(id, cb);
        return id;
      }
      const id = ++clock.seq;
      clock.queue.set(id, cb);
      return id;
    };
    root.cancelAnimationFrame = function (id) {
      if (clock.queue.has(id)) clock.queue.delete(id);
      else {
        clock.realPending.delete(id);
        if (real.caf) real.caf(id);
      }
    };
    try { root.performance.now = () => (clock.on ? clock.perfBase + clock.t * 1000 : real.perfNow()); } catch (_) { /* somente leitura */ }
    Date.now = () => (clock.on ? clock.dateBase + clock.t * 1000 : real.dateNow());
  }

  // anime.js (v3 e v4 UMD): registra as instâncias criadas
  const animeInstances = [];
  function wrapAnime(lib) {
    if (!lib || lib.__msWrapped) return lib;
    const track = inst => {
      if (inst && typeof inst.seek === 'function') animeInstances.push(inst);
      return inst;
    };
    let out = lib;
    if (typeof lib === 'function') {
      out = function () { return track(lib.apply(this, arguments)); };
      Object.assign(out, lib);
      if (typeof lib.timeline === 'function') out.timeline = function () { return track(lib.timeline.apply(lib, arguments)); };
    } else if (typeof lib === 'object') {
      ['animate', 'createTimeline', 'createTimer', 'timeline'].forEach(k => {
        if (typeof lib[k] === 'function') {
          const fn = lib[k];
          lib[k] = function () { return track(fn.apply(this, arguments)); };
        }
      });
    }
    try { Object.defineProperty(out, '__msWrapped', { value: true }); } catch (_) { /* congelado */ }
    return out;
  }
  if (hasDOM) {
    let animeLib = root.anime;
    try {
      Object.defineProperty(root, 'anime', {
        configurable: true,
        get: () => animeLib,
        set: v => { animeLib = wrapAnime(v); },
      });
      if (animeLib) animeLib = wrapAnime(animeLib);
    } catch (_) { /* propriedade fixa */ }
  }

  // window.Motion: o do clipe sempre vence; sem ele, o adaptador
  let nativeMotion = root.Motion;
  let adapterMotion = null;
  if (hasDOM) {
    try {
      Object.defineProperty(root, 'Motion', {
        configurable: true,
        get() {
          if (nativeMotion) return nativeMotion;
          if (!adapterMotion && document.readyState === 'complete') adapterMotion = buildAdapter();
          return adapterMotion || undefined;
        },
        set(v) {
          nativeMotion = v;
          if (v) clock.on = false;
        },
      });
    } catch (_) { /* propriedade fixa */ }
  }

  /** Início de um .clip do HyperFrames: número ou "id", "id + 0,5", "id - 0,5" */
  function hfStart(el, byId, seen = new Set()) {
    const raw = String(el.getAttribute('data-start') || '0').trim();
    if (/^-?[\d.]+$/.test(raw)) return parseFloat(raw);
    const m = /^([A-Za-z_][\w-]*)\s*(?:([+-])\s*([\d.]+))?$/.exec(raw);
    if (!m || seen.has(m[1])) return 0;
    const ref = byId(m[1]);
    if (!ref) return 0;
    seen.add(m[1]);
    const end = hfStart(ref, byId, seen) + (parseFloat(ref.getAttribute('data-duration')) || 0);
    const delta = m[3] ? parseFloat(m[3]) * (m[2] === '-' ? -1 : 1) : 0;
    return end + delta;
  }

  function buildAdapter() {
    const hfRoot = document.querySelector('[data-composition-id]');
    const gsapBatches = [];
    const used = new Set();
    let timedEls = null;

    // Composição do HyperFrames feita para outro tamanho: cabe inteira no quadro
    function fitRoot() {
      if (!hfRoot) return;
      const w = parseFloat(hfRoot.getAttribute('data-width')) || hfRoot.offsetWidth;
      const h = parseFloat(hfRoot.getAttribute('data-height')) || hfRoot.offsetHeight;
      const W = root.innerWidth, H = root.innerHeight;
      if (!w || !h || !W || !H) return;
      const s = Math.min(W / w, H / h);
      const de = document.documentElement, body = document.body;
      de.style.width = body.style.width = W + 'px';
      de.style.height = body.style.height = H + 'px';
      de.style.overflow = body.style.overflow = 'hidden';
      body.style.margin = '0';
      body.style.position = 'relative';
      hfRoot.style.position = 'absolute';
      hfRoot.style.left = (W - w * s) / 2 + 'px';
      hfRoot.style.top = (H - h * s) / 2 + 'px';
      hfRoot.style.width = w + 'px';
      hfRoot.style.height = h + 'px';
      hfRoot.style.transformOrigin = '0 0';
      hfRoot.style.transform = `scale(${s})`;
    }
    if (hfRoot && Math.abs(root.innerWidth - (parseFloat(hfRoot.getAttribute('data-width')) || 0)) + Math.abs(root.innerHeight - (parseFloat(hfRoot.getAttribute('data-height')) || 0)) > 1) {
      fitRoot();
      root.addEventListener('resize', fitRoot);
    }

    function registered() {
      const reg = root.__timelines;
      if (!reg) return [];
      return (Array.isArray(reg) ? reg : Object.values(reg)).filter(tl => tl && typeof tl.seek === 'function');
    }

    // Tweens soltos no root do GSAP: viram timelines pausadas (uma por lote)
    function collectGsap() {
      const g = root.gsap;
      if (!g || !g.globalTimeline || typeof g.exportRoot !== 'function' || registered().length) return;
      const children = g.globalTimeline.getChildren(false, true, true);
      if (!children.length) return;
      const tl = g.exportRoot({ paused: true }, false);
      g.globalTimeline.remove(tl);
      let offset = Infinity;
      tl.getChildren(false, true, true).forEach(c => {
        offset = Math.min(offset, c.startTime() - (typeof c.delay === 'function' ? c.delay() : 0));
      });
      gsapBatches.push({ tl, offset: isFinite(offset) ? Math.max(0, offset) : 0 });
    }

    function lotties() {
      const L = root.lottie || root.bodymovin;
      if (!L || typeof L.getRegisteredAnimations !== 'function') return [];
      try { return L.getRegisteredAnimations() || []; } catch (_) { return []; }
    }

    function webAnimations() {
      try { return document.getAnimations ? document.getAnimations() : []; } catch (_) { return []; }
    }

    function hfTimed() {
      if (timedEls) return timedEls;
      const byId = id => document.getElementById(id);
      timedEls = Array.prototype.slice.call(document.querySelectorAll('[data-start][data-duration]'))
        .filter(el => el !== hfRoot)
        .map(el => ({ el, start: hfStart(el, byId), dur: parseFloat(el.getAttribute('data-duration')) || 0 }));
      return timedEls;
    }

    function durations() {
      const out = [];
      registered().forEach(tl => out.push(typeof tl.duration === 'function' ? tl.duration() : 0));
      gsapBatches.forEach(b => out.push(b.tl.duration() - b.offset));
      lotties().forEach(a => out.push(a.totalFrames / (a.frameRate || 30)));
      animeInstances.forEach(a => out.push((a.duration || 0) / 1000));
      webAnimations().forEach(a => {
        try { out.push(a.effect.getComputedTiming().endTime / 1000); } catch (_) { /* sem effect */ }
      });
      hfTimed().forEach(c => out.push(c.start + c.dur));
      return out.filter(v => isFinite(v) && v > 0);
    }

    const rootDur = hfRoot ? parseFloat(hfRoot.getAttribute('data-duration')) : NaN;
    collectGsap();
    const fps = (hfRoot && parseFloat(hfRoot.getAttribute('data-fps'))) || 30;
    const dur = isFinite(rootDur) && rootDur > 0 ? rootDur : Math.min(600, Math.max(0, ...durations()) || 5);

    function seek(t) {
      t = Math.max(0, Number(t) || 0);
      collectGsap();
      registered().forEach(tl => {
        used.add('timeline');
        try { if (typeof tl.pause === 'function' && !tl.paused()) tl.pause(); tl.seek(t, false); } catch (_) { /* timeline quebrada */ }
      });
      gsapBatches.forEach(b => {
        used.add('gsap');
        try { b.tl.seek(b.offset + t, false); } catch (_) { /* ignora */ }
      });
      lotties().forEach(a => {
        used.add('lottie');
        try {
          const frames = Math.max(1, a.totalFrames || 1);
          let f = t * (a.frameRate || 30);
          f = a.loop ? f % frames : Math.min(frames - 0.001, f);
          a.goToAndStop(f, true);
        } catch (_) { /* ainda carregando */ }
      });
      animeInstances.forEach(a => {
        used.add('anime');
        try {
          if (typeof a.pause === 'function') a.pause();
          a.seek(Math.min(t * 1000, a.duration || t * 1000));
        } catch (_) { /* ignora */ }
      });
      webAnimations().forEach(a => {
        used.add('css');
        try { a.pause(); a.currentTime = t * 1000; } catch (_) { /* ignora */ }
      });
      hfTimed().forEach(c => {
        const on = t >= c.start && t < c.start + c.dur;
        c.el.style.visibility = on ? '' : 'hidden';
        if (c.el.tagName === 'VIDEO' || c.el.tagName === 'AUDIO') {
          try {
            c.el.pause();
            const local = Math.max(0, t - c.start) + (parseFloat(c.el.getAttribute('data-media-start')) || 0);
            if (Math.abs(c.el.currentTime - local) > 0.02) c.el.currentTime = local;
          } catch (_) { /* sem mídia */ }
        }
      });
      // Nada acima e o clipe anima por rAF: relógio virtual
      if (!used.size && clock.rafCalls > 0) {
        startClock();
        used.add('clock');
      }
      if (clock.on) {
        clock.t = t;
        const ts = clock.perfBase + t * 1000;
        const pending = Array.from(clock.queue.values());
        clock.queue.clear();
        pending.forEach(cb => { try { cb(ts); } catch (err) { console.error(err); } });
      }
    }

    let readyPromise = null;
    const M = {
      __adapter: true,
      config: { fps, durationInSeconds: dur, totalFrames: Math.round(fps * dur) },
      seek,
      renderFrame: f => seek(f / fps),
      whenReady() {
        if (readyPromise) return readyPromise;
        const waits = [document.fonts ? document.fonts.ready : null];
        lotties().forEach(a => {
          if (!a.isLoaded) waits.push(new Promise(res => { try { a.addEventListener('DOMLoaded', res); } catch (_) { res(); } }));
        });
        Array.prototype.forEach.call(document.images || [], img => {
          if (!img.complete) waits.push(new Promise(res => { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); }));
        });
        readyPromise = Promise.race([
          Promise.all(waits.map(p => Promise.resolve(p).catch(() => {}))),
          new Promise(res => setTimeout(res, 15000)),
        ]).then(() => seek(0));
        return readyPromise;
      },
      /** Quais motores o adaptador está dirigindo (diagnóstico) */
      drivers: () => Array.from(used),
    };
    seek(0);
    return M;
  }
  // #endregion

  const MS = {
    kit: '1.0.0',
    clamp, lerp, seg, ease, bezier, interpolate, interpolateColors, mixColor, parseColor,
    spring, random, rng, noise2D, noise3D, wiggle,
    stagger, loop, pingpong, countUp,
    measureText, fitText, fitElement, split,
    path, shape, audio, motion,
    /** Força a criação do adaptador (diagnóstico); devolve window.Motion */
    adapt: () => root.Motion,
    /** rAF real (o do relógio virtual pode estar desligado da tela) */
    realRequestAnimationFrame: real.raf,
  };
  root.MS = MS;
  if (typeof module === 'object' && module.exports) module.exports = MS;
})(typeof window !== 'undefined' ? window : globalThis);
