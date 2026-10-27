'use strict';
// clip-fx.js
//
//  Efeitos e transições de clips — funções puras do tempo, usadas pelo
//  preview (compositor.js, a cada quadro) e pelo export (exporter.js embute
//  este arquivo na cena): o vídeo final sai igual ao que se vê no editor.
//
//  clip.fx = {
//    look:       'none' | id de LOOKS          filtro pronto
//    adjust:     { brightness, contrast, saturation, hue, blur, opacity }
//    motion:     { type, strength }            animação ao longo do clip
//    in / out:   { type, duration }            entrada / saída do próprio clip
//    transition: { type, duration }            com o clip anterior da mesma track
//    flipH / flipV: true                       espelhar
//  }
//  Transição entre clips: o clip anterior continua visível por baixo durante
//  `duration` depois do próprio fim (tailFx), e o novo aparece por cima.
//
//  style(c, t, pxScale) → { visible, opacity, filter, transform, clipPath, front, rotation }
//    c = { start, duration, fx, tailFx, kf?, base? }; transform não inclui a rotação do
//    clip (quem aplica concatena; se `rotation` vier, é a rotação animada em graus e
//    substitui a fixa); pxScale converte px do projeto (blur, deslocamento).
//
//  Mesclagem (c.blend: id de BLENDS) e camada de ajuste (c.adj): style() devolve `blend` e, na
//  camada de ajuste, `backdropFilter` (o filtro age sobre o que está ABAIXO, não no próprio clip).
//  Câmera 2D (c.cams + c.center + c.frame): cada camada abaixo de uma câmera ganha, antes de todos
//  os outros transforms, o deslocamento/zoom/giro da câmera (ver cameraTransform).
//
//  Animação por keyframes (c.kf): { prop: [{ t, v, e }] } com t em segundos desde o início
//  do clip, ordenado. Propriedades: scale (%), x, y (px do centro, em relação ao centro do
//  quadro), r (graus) e os ajustes brightness/contrast/saturation/hue/blur/opacity. c.base
//  = { x, y, scale, r } é o enquadramento fixo da caixa (o deslocamento/escala animados são
//  relativos a ele). `e` = curva do trecho que COMEÇA nesse keyframe (ver curve()).

(function (root) {
  const LOOKS = {
    none:     { label: 'Original' },
    bw:       { label: 'P&B',       grayscale: 1, contrast: 1.08 },
    noir:     { label: 'Noir',      grayscale: 1, contrast: 1.45, brightness: 0.92 },
    sepia:    { label: 'Sépia',     sepia: 0.85, contrast: 1.05 },
    vintage:  { label: 'Vintage',   sepia: 0.35, saturate: 0.75, contrast: 0.92, brightness: 1.05, hue: -8 },
    warm:     { label: 'Quente',    sepia: 0.18, saturate: 1.2, hue: -10, brightness: 1.03 },
    cold:     { label: 'Frio',      saturate: 0.95, hue: 12, brightness: 1.02, contrast: 1.05 },
    vivid:    { label: 'Vívido',    saturate: 1.6, contrast: 1.12 },
    dramatic: { label: 'Dramático', contrast: 1.4, saturate: 0.85, brightness: 0.9 },
    faded:    { label: 'Desbotado', contrast: 0.8, saturate: 0.7, brightness: 1.1 },
    neon:     { label: 'Neon',      saturate: 2, contrast: 1.25, hue: 25 },
    invert:   { label: 'Negativo',  invert: 1 },
    // Mais filtros (mesmas ferramentas: brilho, contraste, saturação, matiz, sépia, P&B, desfoque)
    cinema:   { label: 'Cinema',        contrast: 1.18, saturate: 0.88, sepia: 0.1, hue: -6, brightness: 0.95 },
    cyber:    { label: 'Cyberpunk',     saturate: 1.9, contrast: 1.25, hue: -50, brightness: 0.95 },
    dream:    { label: 'Sonho',         brightness: 1.08, saturate: 1.25, contrast: 0.88, blur: 0.8 },
    sunset:   { label: 'Pôr do sol',    sepia: 0.35, saturate: 1.6, hue: -18, brightness: 1.04, contrast: 1.06 },
    ice:      { label: 'Gelo',          saturate: 0.75, hue: 15, brightness: 1.1, contrast: 1.1 },
    polaroid: { label: 'Polaroid',      sepia: 0.22, contrast: 0.88, saturate: 1.4, brightness: 1.1, hue: -5 },
    vhs:      { label: 'VHS',           saturate: 1.5, contrast: 1.18, hue: 6, brightness: 1.02, blur: 0.5 },
    matrix:   { label: 'Matrix',        sepia: 1, hue: 85, saturate: 2.6, contrast: 1.25, brightness: 0.85 },
    gold:     { label: 'Ouro',          sepia: 0.7, saturate: 1.8, contrast: 1.12, brightness: 1.05, hue: -10 },
    forest:   { label: 'Floresta',      sepia: 0.2, saturate: 1.35, hue: 30, contrast: 1.06 },
    pastel:   { label: 'Pastel',        saturate: 0.65, brightness: 1.2, contrast: 0.82 },
    hdr:      { label: 'HDR',           contrast: 1.32, saturate: 1.4, brightness: 1.02 },
    softbw:   { label: 'P&B suave',     grayscale: 1, contrast: 0.88, brightness: 1.12 },
    xray:     { label: 'Raio-X',        invert: 1, grayscale: 1, contrast: 1.25 },
    rose:     { label: 'Rosado',        sepia: 0.2, saturate: 1.4, hue: -35, brightness: 1.05 },
    ocean:    { label: 'Oceano',        saturate: 1.3, hue: 20, contrast: 1.08, brightness: 1.02 },
    autumn:   { label: 'Outono',        sepia: 0.45, saturate: 1.5, hue: -25, contrast: 1.05 },
    moody:    { label: 'Sombrio',       contrast: 1.3, saturate: 0.7, brightness: 0.82 },
    bleach:   { label: 'Bleach bypass', contrast: 1.5, saturate: 0.55, brightness: 1.02 },
    lomo:     { label: 'Lomo',          saturate: 1.7, contrast: 1.35, brightness: 0.9, hue: -8 },
  };

  // Modos de mesclagem (mix-blend-mode): como a camada se combina com o que está abaixo dela
  const BLENDS = {
    normal:        'Normal',
    darken:        'Escurecer',
    multiply:      'Multiplicar',
    'color-burn':  'Subexposição de cor',
    lighten:       'Clarear',
    screen:        'Tela',
    'color-dodge': 'Superexposição de cor',
    'plus-lighter': 'Adicionar (Linear Dodge)',
    overlay:       'Sobrepor',
    'soft-light':  'Luz suave',
    'hard-light':  'Luz intensa',
    difference:    'Diferença',
    exclusion:     'Exclusão',
    hue:           'Matiz',
    saturation:    'Saturação',
    color:         'Cor',
    luminosity:    'Luminosidade',
  };

  const MOTIONS = {
    none:     'Nenhum',
    zoomIn:   'Zoom lento (aproximar)',
    zoomOut:  'Zoom lento (afastar)',
    panLeft:  'Pan para a esquerda',
    panRight: 'Pan para a direita',
    panUp:    'Pan para cima',
    panDown:  'Pan para baixo',
    shake:    'Tremor',
    pulse:    'Pulsar',
    sway:     'Balançar',
    flicker:  'Piscar',
    glitch:   'Glitch',
    // Mais movimentos
    kenBurns: 'Ken Burns (zoom + pan)',
    drift:    'Deriva suave',
    float:    'Flutuar',
    orbit:    'Órbita',
    swing:    'Pêndulo',
    heartbeat: 'Batimento',
    bounce:   'Quicar',
    handheld: 'Câmera na mão',
    punch:    'Soco de zoom',
    whip:     'Chicote (pan rápido)',
    spinSlow: 'Giro lento',
    tilt:     'Inclinar',
    pushIn:   'Aproximar forte',
    pullOut:  'Afastar forte',
    breathe:  'Respirar',
    wobble:   'Gelatina',
  };

  // Entrada/saída de um clip (também servem de transição entre clips)
  const IN_OUT = {
    none:       'Nenhuma',
    fade:       'Esmaecer',
    slideLeft:  'Deslizar ←',
    slideRight: 'Deslizar →',
    slideUp:    'Deslizar ↑',
    slideDown:  'Deslizar ↓',
    zoomIn:     'Zoom (crescer)',
    zoomOut:    'Zoom (encolher)',
    blur:       'Desfoque',
    wipeLeft:   'Cortina ←',
    wipeRight:  'Cortina →',
    wipeUp:     'Cortina ↑',
    wipeDown:   'Cortina ↓',
    circle:     'Círculo',
    spin:       'Girar',
    flash:      'Flash',
  };

  // Entre clips: o anterior reage junto (empurrar, zoom, desfoque…)
  const TRANSITIONS = {
    none:      'Nenhuma',
    dissolve:  'Dissolver',
    pushLeft:  'Empurrar ←',
    pushRight: 'Empurrar →',
    pushUp:    'Empurrar ↑',
    pushDown:  'Empurrar ↓',
    slideLeft: 'Deslizar sobre ←',
    slideRight:'Deslizar sobre →',
    wipeLeft:  'Cortina ←',
    wipeRight: 'Cortina →',
    wipeUp:    'Cortina ↑',
    wipeDown:  'Cortina ↓',
    circle:    'Círculo',
    zoom:      'Zoom',
    blur:      'Desfoque',
    flash:     'Flash branco',
  };

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const easeInOut = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  // Ruído determinístico (mesmo valor no preview e no export para o mesmo t)
  const noise = x => {
    const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };

  // #region Curvas e keyframes
  /**
   * Curva de easing: { p: [x1, y1, x2, y2] } (cubic-bezier do CSS; y pode passar de 0–1 = overshoot)
   * ou { pts: [[x, y], …] } (polilinha com x crescente em 0–1: quicar, elástico…). null = linear.
   * Dado puro (JSON): vai dentro do keyframe, então salva com o projeto e embute no export.
   */
  function bezierY(p, u) {
    const x1 = p[0], y1 = p[1], x2 = p[2], y2 = p[3];
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    // x(t) = u → t (Newton com bisseção de reserva)
    let t = u;
    for (let i = 0; i < 6; i++) {
      const x = ((ax * t + bx) * t + cx) * t - u;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(x) < 1e-6) break;
      if (Math.abs(d) < 1e-6) break;
      t -= x / d;
    }
    if (!(t >= 0 && t <= 1) || Math.abs(((ax * t + bx) * t + cx) * t - u) > 1e-4) {
      let lo = 0, hi = 1;
      t = u;
      for (let i = 0; i < 24; i++) {
        const x = ((ax * t + bx) * t + cx) * t;
        if (x < u) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return ((ay * t + by) * t + cy) * t;
  }

  /** Progresso eased (0–1, pode passar disso) para o progresso linear u do trecho */
  function curve(e, u) {
    u = clamp01(u);
    if (!e) return u;
    if (e.pts && e.pts.length >= 2) {
      const pts = e.pts;
      if (u <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (u <= pts[i][0]) {
          const a = pts[i - 1], b = pts[i];
          const span = b[0] - a[0];
          return span <= 1e-9 ? b[1] : a[1] + (b[1] - a[1]) * ((u - a[0]) / span);
        }
      }
      return pts[pts.length - 1][1];
    }
    if (e.p && e.p.length === 4) {
      if (e.p[0] === e.p[1] && e.p[2] === e.p[3]) return u;   // linear
      return bezierY(e.p, u);
    }
    return u;
  }

  /** Valida/normaliza uma curva vinda do usuário ou da IA → { p } | { pts } | null */
  function normalizeCurve(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    const lim = v => Math.max(-2, Math.min(3, v));
    if (Array.isArray(raw.p) && raw.p.length === 4) {
      const p = raw.p.map(num);
      if (p.some(Number.isNaN)) return null;
      return { p: [clamp01(p[0]), lim(p[1]), clamp01(p[2]), lim(p[3])].map(v => Math.round(v * 1000) / 1000) };
    }
    if (Array.isArray(raw.pts) && raw.pts.length >= 2 && raw.pts.length <= 400) {
      const pts = raw.pts.map(q => [num(q && q[0]), num(q && q[1])]);
      if (pts.some(q => Number.isNaN(q[0]) || Number.isNaN(q[1]))) return null;
      pts.sort((a, b) => a[0] - b[0]);
      return { pts: pts.map(q => [Math.round(clamp01(q[0]) * 10000) / 10000, Math.round(lim(q[1]) * 10000) / 10000]) };
    }
    return null;
  }

  /** Valor da propriedade no tempo s (mesma unidade das chaves); chaves ordenadas por t */
  function evalKeys(keys, s) {
    if (!keys || !keys.length) return undefined;
    if (s <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (s >= last.t) return last.v;
    for (let i = 1; i < keys.length; i++) {
      if (s <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        const span = b.t - a.t;
        if (span <= 1e-6) return b.v;
        return a.v + (b.v - a.v) * curve(a.e, (s - a.t) / span);
      }
    }
    return last.v;
  }

  const ANIM_ADJUST = ['brightness', 'contrast', 'saturation', 'hue', 'blur', 'opacity'];
  // #endregion

  function blank() {
    return { opacity: 1, tx: 0, ty: 0, scale: 1, rot: 0, blur: 0, bright: 1, clip: '' };
  }

  /**
   * Estado de uma entrada/saída/transição com visibilidade e ∈ [0,1]
   * (0 = totalmente fora, 1 = normal). dir: 'in' entra, 'out' sai.
   */
  function applyInOut(acc, type, e, dir) {
    const off = 1 - e;   // quanto falta para o estado normal
    const sign = dir === 'in' ? 1 : -1;
    switch (type) {
      case 'fade': case 'dissolve': acc.opacity *= e; break;
      case 'slideLeft':  acc.tx += sign * off * 100; break;    // entra pela direita, sai pela esquerda
      case 'slideRight': acc.tx -= sign * off * 100; break;
      case 'slideUp':    acc.ty += sign * off * 100; break;
      case 'slideDown':  acc.ty -= sign * off * 100; break;
      case 'zoomIn':     acc.scale *= 0.6 + 0.4 * e; acc.opacity *= e; break;
      case 'zoomOut':    acc.scale *= 1 + 0.5 * off; acc.opacity *= e; break;
      case 'blur':       acc.blur += off * 40; acc.opacity *= Math.min(1, e * 1.6); break;
      case 'wipeLeft':   acc.clip = `inset(0 0 0 ${off * 100}%)`; break;   // revela da direita p/ esquerda
      case 'wipeRight':  acc.clip = `inset(0 ${off * 100}% 0 0)`; break;
      case 'wipeUp':     acc.clip = `inset(${off * 100}% 0 0 0)`; break;
      case 'wipeDown':   acc.clip = `inset(0 0 ${off * 100}% 0)`; break;
      case 'circle':     acc.clip = `circle(${(e * 75).toFixed(2)}% at 50% 50%)`; break;
      case 'spin':       acc.rot += sign * -off * 120; acc.scale *= 0.4 + 0.6 * e; acc.opacity *= e; break;
      case 'flash':      acc.bright *= 1 + off * 2.5; acc.opacity *= Math.min(1, e * 2); break;
      default: break;
    }
  }

  function applyMotion(acc, motion, local, duration) {
    const type = motion?.type;
    if (!type || type === 'none') return;
    const k = Math.max(0.1, Math.min(3, Number(motion.strength) || 1));
    const p = clamp01(local / Math.max(0.001, duration));
    switch (type) {
      case 'zoomIn':   acc.scale *= 1 + 0.15 * k * easeInOut(p); break;
      case 'zoomOut':  acc.scale *= 1 + 0.15 * k * (1 - easeInOut(p)); break;
      case 'panLeft':  acc.scale *= 1 + 0.12 * k; acc.tx += (0.5 - p) * 10 * k; break;
      case 'panRight': acc.scale *= 1 + 0.12 * k; acc.tx -= (0.5 - p) * 10 * k; break;
      case 'panUp':    acc.scale *= 1 + 0.12 * k; acc.ty += (0.5 - p) * 10 * k; break;
      case 'panDown':  acc.scale *= 1 + 0.12 * k; acc.ty -= (0.5 - p) * 10 * k; break;
      case 'shake': {
        const f = Math.floor(local * 24);   // 24 sacudidas por segundo
        acc.tx += noise(f) * 1.6 * k;
        acc.ty += noise(f + 91) * 1.6 * k;
        acc.rot += noise(f + 7) * 0.8 * k;
        break;
      }
      case 'pulse': acc.scale *= 1 + 0.045 * k * (0.5 - 0.5 * Math.cos(2 * Math.PI * local / 0.9)); break;
      case 'sway':  acc.rot += 4 * k * Math.sin(2 * Math.PI * local / 2.4); break;
      case 'flicker': {
        const f = Math.floor(local * 12);
        if (noise(f) > 0.55) acc.opacity *= 1 - 0.45 * Math.min(1, k);
        break;
      }
      case 'glitch': {
        const cycle = (local * 1.4) % 1;
        if (cycle < 0.14) {
          const f = Math.floor(local * 30);
          acc.tx += noise(f) * 3 * k;
          acc.glitch = true;
        }
        break;
      }
      // Todos escalam um pouco para esconder as bordas enquanto a imagem se move (3 % de folga por lado por 0,06 de escala)
      case 'kenBurns':
        acc.scale *= 1 + 0.06 * k + 0.14 * k * easeInOut(p);
        acc.tx += (0.5 - p) * 5 * k;
        acc.ty += (0.5 - p) * 3 * k;
        break;
      case 'drift':
        acc.scale *= 1 + 0.06 * k;
        acc.tx += 2.2 * k * Math.sin(2 * Math.PI * local / 6);
        acc.ty += 1.6 * k * Math.cos(2 * Math.PI * local / 7.5);
        break;
      case 'float':
        acc.scale *= 1 + 0.03 * k;
        acc.ty += 1.4 * k * Math.sin(2 * Math.PI * local / 2.2);
        acc.rot += 0.4 * k * Math.sin(2 * Math.PI * local / 3.1);
        break;
      case 'orbit':
        acc.scale *= 1 + 0.06 * k;
        acc.tx += 2.6 * k * Math.cos(2 * Math.PI * local / 4);
        acc.ty += 2.6 * k * Math.sin(2 * Math.PI * local / 4);
        break;
      case 'swing':
        acc.scale *= 1 + 0.08 * k;
        acc.rot += 6 * k * Math.sin(2 * Math.PI * local / 1.8);
        break;
      case 'heartbeat': {
        const x = local % 1.1;
        const beat = Math.exp(-(((x - 0.06) / 0.045) ** 2)) + 0.7 * Math.exp(-(((x - 0.26) / 0.05) ** 2));
        acc.scale *= 1 + 0.06 * k * beat;
        break;
      }
      case 'bounce':
        acc.scale *= 1 + 0.02 * k;
        acc.ty -= 3 * k * Math.abs(Math.sin(Math.PI * local / 0.9));
        break;
      case 'handheld':
        acc.scale *= 1 + 0.05 * k;
        acc.tx += k * (1.0 * Math.sin(1.3 * local) + 0.6 * Math.sin(2.9 * local + 1) + 0.35 * Math.sin(5.3 * local + 2));
        acc.ty += k * (0.9 * Math.sin(1.7 * local + 0.5) + 0.5 * Math.sin(3.1 * local + 1.5) + 0.3 * Math.sin(6.1 * local));
        acc.rot += 0.25 * k * Math.sin(1.1 * local + 2) + 0.12 * k * Math.sin(3.7 * local);
        break;
      case 'punch': {
        const u = local % 1.5;
        const hit = u < 0.06 ? u / 0.06 : Math.exp(-(u - 0.06) / 0.14);
        acc.scale *= 1 + 0.12 * k * hit;
        break;
      }
      case 'whip': {
        const u = clamp01(local / 0.4);
        const off = 1 - easeOut(u);
        acc.tx -= 60 * k * off;
        acc.blur += 14 * off;
        break;
      }
      case 'spinSlow': acc.rot += 90 * k * p; break;
      case 'tilt':
        acc.scale *= 1 + 0.1 * k;
        acc.rot += -3 * k + 6 * k * easeInOut(p);
        break;
      case 'pushIn':  acc.scale *= 1 + 0.4 * k * easeOut(p); break;
      case 'pullOut': acc.scale *= 1 + 0.4 * k * (1 - easeOut(p)); break;
      case 'breathe': acc.scale *= 1 + 0.035 * k * (0.5 - 0.5 * Math.cos(2 * Math.PI * local / 3.2)); break;
      case 'wobble': {
        const decay = Math.exp(-local / 0.9);
        const osc = Math.sin(2 * Math.PI * local / 0.55);
        acc.rot += 5 * k * decay * osc;
        acc.scale *= 1 + 0.04 * k * decay * Math.abs(osc);
        break;
      }
      default: break;
    }
  }

  // #region Câmera 2D
  const CAM_DEF = { camX: 0, camY: 0, camZoom: 100, camR: 0 };

  /** Câmera ativa no tempo t: a de maior track que cobre t (cams: [{ start, duration, track, kf, base }]) */
  function pickCamera(cams, t) {
    if (!cams || !cams.length) return null;
    let best = null;
    for (const cam of cams) {
      if (t >= cam.start && t < cam.start + cam.duration && (!best || (cam.track || 0) > (best.track || 0))) best = cam;
    }
    return best;
  }

  /** { camX, camY, camZoom, camR } da câmera no tempo t (keyframes, senão o valor fixo) */
  function cameraStateAt(cam, t) {
    const local = t - cam.start;
    const out = {};
    for (const prop in CAM_DEF) {
      const keys = cam.kf && cam.kf[prop];
      const v = keys && keys.length ? evalKeys(keys, local) : undefined;
      out[prop] = v !== undefined ? v : (cam.base && cam.base[prop] != null ? cam.base[prop] : CAM_DEF[prop]);
    }
    return out;
  }

  /**
   * Transform CSS que leva uma camada (de centro `center`, em px do projeto) para o que a câmera enxerga.
   * A câmera olha para o ponto (centro do quadro + camX/camY), aproxima por camZoom % e gira camR graus
   * (positivo = a visão gira no sentido horário, então o mundo gira ao contrário). Neutra → ''.
   */
  function cameraTransform(state, center, frame, pxScale = 1) {
    const z = Math.max(0.05, (Number(state.camZoom) || 100) / 100);
    const phi = -(Number(state.camR) || 0);
    const Cx = frame.w / 2, Cy = frame.h / 2;
    const vx = center.x - (Cx + (Number(state.camX) || 0));
    const vy = center.y - (Cy + (Number(state.camY) || 0));
    const rad = phi * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = (Cx + z * (vx * cos - vy * sin) - center.x) * pxScale;
    const dy = (Cy + z * (vx * sin + vy * cos) - center.y) * pxScale;
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(z - 1) < 1e-4 && Math.abs(phi) < 1e-3) return '';
    return `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px) rotate(${phi.toFixed(3)}deg) scale(${z.toFixed(5)})`;
  }
  // #endregion

  function hasFx(fx) {
    if (!fx) return false;
    const a = fx.adjust || {};
    return Boolean(
      (fx.look && fx.look !== 'none') ||
      (fx.motion?.type && fx.motion.type !== 'none') ||
      a.brightness || a.contrast || a.saturation || a.hue || a.blur ||
      (a.opacity != null && Number(a.opacity) !== 100)
    );
  }

  const active = tr => Boolean(tr && tr.type && tr.type !== 'none' && Number(tr.duration) > 0);

  /** Qualquer efeito visível no clip (hasFx só olha filtro/ajustes/movimento; aqui entram também entrada, saída, transição e espelho) */
  function anyFx(fx) {
    return Boolean(fx && (hasFx(fx) || active(fx.in) || active(fx.out) || active(fx.transition) || fx.flipH || fx.flipV));
  }

  /** Quanto tempo o clip fica visível depois do fim (transição do próximo) */
  function tailOf(c) {
    return active(c.tailFx) ? Number(c.tailFx.duration) : 0;
  }

  function style(c, t, pxScale = 1) {
    const fx = c.fx || {};
    const duration = Math.max(0.001, Number(c.duration) || 0.001);
    const local = t - (Number(c.start) || 0);
    const tail = tailOf(c);
    const out = { visible: local >= 0 && local < duration + tail, opacity: 1, filter: '', transform: '', clipPath: '', front: false, blend: '', backdropFilter: '' };
    if (!out.visible) return out;

    // Keyframes: valores animados no instante (só das propriedades que têm chaves)
    let anim = null;
    if (c.kf) {
      for (const prop in c.kf) {
        const v = evalKeys(c.kf[prop], local);
        if (v !== undefined) (anim || (anim = {}))[prop] = v;
      }
    }

    const acc = blank();
    applyMotion(acc, fx.motion, Math.min(local, duration), duration);

    // Entrada: transição entre clips tem prioridade sobre a entrada simples
    if (active(fx.transition) && local < Number(fx.transition.duration)) {
      const e = easeInOut(clamp01(local / Number(fx.transition.duration)));
      const type = fx.transition.type;
      const map = { pushLeft: 'slideLeft', pushRight: 'slideRight', pushUp: 'slideUp', pushDown: 'slideDown', zoom: 'zoomIn' };
      applyInOut(acc, map[type] || type, e, 'in');
      out.front = true;
    } else if (active(fx.in) && local < Number(fx.in.duration)) {
      applyInOut(acc, fx.in.type, easeOut(clamp01(local / Number(fx.in.duration))), 'in');
    }

    // Saída do próprio clip
    if (local < duration && active(fx.out) && local > duration - Number(fx.out.duration)) {
      const e = easeOut(clamp01((duration - local) / Number(fx.out.duration)));
      applyInOut(acc, fx.out.type, e, 'out');
    }

    // Rabo: o próximo clip está entrando por cima; o anterior reage
    if (local >= duration && tail) {
      const p = easeInOut(clamp01((local - duration) / tail));
      switch (c.tailFx.type) {
        case 'pushLeft':  acc.tx -= p * 100; break;
        case 'pushRight': acc.tx += p * 100; break;
        case 'pushUp':    acc.ty -= p * 100; break;
        case 'pushDown':  acc.ty += p * 100; break;
        case 'zoom':      acc.scale *= 1 + 0.25 * p; acc.opacity *= 1 - p; break;
        case 'blur':      acc.blur += p * 40; break;
        case 'flash':     acc.bright *= 1 + p * 2.5; break;
        default: break;
      }
    }

    // Filtros: look + ajustes + o que as transições pediram
    const look = LOOKS[fx.look] || LOOKS.none;
    let a = fx.adjust || {};
    if (anim && ANIM_ADJUST.some(k => k in anim)) {
      a = { ...a };
      ANIM_ADJUST.forEach(k => { if (k in anim) a[k] = anim[k]; });
    }
    const brightness = (look.brightness ?? 1) * (1 + (Number(a.brightness) || 0) / 100) * acc.bright;
    const contrast = (look.contrast ?? 1) * (1 + (Number(a.contrast) || 0) / 100);
    const saturate = (look.saturate ?? 1) * (1 + (Number(a.saturation) || 0) / 100);
    const hue = (look.hue || 0) + (Number(a.hue) || 0) + (acc.glitch ? 90 : 0);
    const blur = ((Number(a.blur) || 0) + acc.blur + (look.blur || 0)) * pxScale;
    const parts = [];
    if (Math.abs(brightness - 1) > 1e-3) parts.push(`brightness(${brightness.toFixed(3)})`);
    if (Math.abs(contrast - 1) > 1e-3 || acc.glitch) parts.push(`contrast(${(contrast * (acc.glitch ? 1.35 : 1)).toFixed(3)})`);
    if (Math.abs(saturate - 1) > 1e-3) parts.push(`saturate(${Math.max(0, saturate).toFixed(3)})`);
    if (hue) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
    if (look.grayscale) parts.push(`grayscale(${look.grayscale})`);
    if (look.sepia) parts.push(`sepia(${look.sepia})`);
    if (look.invert) parts.push(`invert(${look.invert})`);
    if (blur > 0.05) parts.push(`blur(${blur.toFixed(2)}px)`);
    out.filter = parts.join(' ');

    const baseOpacity = a.opacity == null ? 1 : clamp01(Number(a.opacity) / 100);
    out.opacity = clamp01(acc.opacity * baseOpacity);

    const tf = [];
    if (acc.tx || acc.ty) tf.push(`translate(${acc.tx.toFixed(3)}%, ${acc.ty.toFixed(3)}%)`);
    if (Math.abs(acc.scale - 1) > 1e-4) tf.push(`scale(${acc.scale.toFixed(4)})`);
    if (acc.rot) tf.push(`rotate(${acc.rot.toFixed(3)}deg)`);
    if (fx.flipH || fx.flipV) tf.push(`scale(${fx.flipH ? -1 : 1}, ${fx.flipV ? -1 : 1})`);
    // Posição/escala/rotação animadas: relativas à caixa fixa (c.base); vêm antes dos demais (mais externas)
    if (anim && c.base) {
      const b = c.base;
      const dx = ('x' in anim ? anim.x - b.x : 0) * pxScale;
      const dy = ('y' in anim ? anim.y - b.y : 0) * pxScale;
      const ratio = 'scale' in anim && b.scale > 0 ? Math.max(0.01, anim.scale) / b.scale : 1;
      const pre = [];
      if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) pre.push(`translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px)`);
      if (Math.abs(ratio - 1) > 1e-4) pre.push(`scale(${ratio.toFixed(4)})`);
      if (pre.length) tf.unshift(...pre);
      if ('r' in anim) out.rotation = anim.r;
    }
    out.transform = tf.join(' ');
    out.clipPath = acc.clip;
    // Câmera 2D: o mais externo de todos os transforms
    if (c.cams && c.cams.length && c.center && c.frame) {
      const cam = pickCamera(c.cams, t);
      if (cam) {
        const pre = cameraTransform(cameraStateAt(cam, t), c.center, c.frame, pxScale);
        if (pre) out.transform = pre + (out.transform ? ' ' + out.transform : '');
      }
    }
    out.blend = c.blend && c.blend !== 'normal' && BLENDS[c.blend] ? c.blend : '';
    // Camada de ajuste: o filtro age sobre o que está abaixo (backdrop-filter), não no próprio clip
    if (c.adj) { out.backdropFilter = out.filter; out.filter = ''; }
    return out;
  }

  root.ClipFX = { style, curve, normalizeCurve, evalKeys, pickCamera, cameraStateAt, cameraTransform, BLENDS, hasFx, anyFx, tailOf, active, LOOKS, MOTIONS, IN_OUT, TRANSITIONS };
})(typeof window !== 'undefined' ? window : globalThis);
