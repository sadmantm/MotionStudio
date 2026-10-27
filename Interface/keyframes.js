'use strict';
// keyframes.js
//
//  Keyframes no estilo do CapCut, para volume (áudio/vídeo) e para a animação de
//  vídeo, imagem, HTML e texto: escala, posição, rotação e os ajustes de cor
//  (brilho, contraste, saturação, matiz, desfoque, opacidade).
//    • painel do clip: ◇ ao lado de cada controle põe/tira um keyframe na agulha;
//      ‹ › pulam entre keyframes. Com keyframes, mexer no controle (slider, número ou
//      a caixa do preview) cria/atualiza o keyframe da agulha.
//    • bloco da timeline (clip selecionado): linha de volume (áudio/vídeo) e uma faixa
//      de losangos com os keyframes de animação — arrastar move no tempo, duplo clique
//      remove, clicar seleciona (e abre a curva em "Animação", curves.js).
//  Dado: clip.keyframes = { prop: [{ t, v, e? }] } — t em segundos da MÍDIA (como o
//  trimStart; imagem/texto: do clip), então cortar, aparar e mover mantém cada keyframe
//  no mesmo ponto do conteúdo. `e` = curva do trecho que começa nesse keyframe (clip-fx.js:
//  curve()); ausente = linear. As listas são imutáveis (sempre substituídas): split,
//  duplicar e o snapshot do undo compartilham a referência com segurança.
//  Câmera 2D (camada "Câmera", camera.js): camX/camY (pan em px do centro do quadro), camZoom (%) e
//  camR (graus) usam o mesmo sistema; ClipKF.cameras() entrega as câmeras já em segundos do clip.
//  Cálculo (preview, forma de onda, medidor e export): ClipFX.evalKeys/style (clip-fx.js);
//  o export recebe volumeKeys (áudio) e kf + kfBase (animação visual) já em segundos do clip.

(() => {
  const st = () => window.__appState;
  const FX = () => window.ClipFX;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r3 = v => Math.round(v * 1000) / 1000;
  const PAD_T = 8;
  const PAD_B = 8;

  // #region Propriedades
  const PROPS = {
    volume:     { label: 'Volume',     min: 0,    max: 1,    def: 1 },
    scale:      { label: 'Escala',     min: 5,    max: 400,  def: 100 },
    x:          { label: 'Posição X',  min: -4000, max: 4000, def: 0 },
    y:          { label: 'Posição Y',  min: -4000, max: 4000, def: 0 },
    r:          { label: 'Rotação',    min: -720, max: 720,  def: 0 },
    brightness: { label: 'Brilho',     min: -100, max: 100,  def: 0 },
    contrast:   { label: 'Contraste',  min: -100, max: 100,  def: 0 },
    saturation: { label: 'Saturação',  min: -100, max: 100,  def: 0 },
    hue:        { label: 'Matiz',      min: -180, max: 180,  def: 0 },
    blur:       { label: 'Desfoque',   min: 0,    max: 40,   def: 0 },
    opacity:    { label: 'Opacidade',  min: 0,    max: 100,  def: 100 },
    // Câmera 2D
    camX:       { label: 'Câmera X',   min: -4000, max: 4000, def: 0 },
    camY:       { label: 'Câmera Y',   min: -4000, max: 4000, def: 0 },
    camZoom:    { label: 'Zoom da câmera', min: 25, max: 800, def: 100 },
    camR:       { label: 'Rotação da câmera', min: -180, max: 180, def: 0 },
  };
  const CAMERA = ['camX', 'camY', 'camZoom', 'camR'];
  /** Um losango por linha do painel: posição liga X e Y juntos */
  const GROUPS = { volume: ['volume'], scale: ['scale'], pos: ['x', 'y'], r: ['r'] };
  ['brightness', 'contrast', 'saturation', 'hue', 'blur', 'opacity'].forEach(k => { GROUPS[k] = [k]; });
  GROUPS.camPos = ['camX', 'camY'];
  GROUPS.camZoom = ['camZoom'];
  GROUPS.camR = ['camR'];
  const VISUAL = Object.keys(PROPS).filter(p => p !== 'volume' && !CAMERA.includes(p));
  const ADJUST = new Set(['brightness', 'contrast', 'saturation', 'hue', 'blur', 'opacity']);
  // #endregion

  // #region Dados
  const keysOf = (clip, prop = 'volume') => (Array.isArray(clip?.keyframes?.[prop]) && clip.keyframes[prop].length ? clip.keyframes[prop] : null);
  /** prop omitida = qualquer propriedade; 'anim' = alguma de animação visual */
  const has = (clip, prop) => (prop === 'anim' ? VISUAL.some(p => keysOf(clip, p)) : prop ? Boolean(keysOf(clip, prop)) : Object.keys(PROPS).some(p => keysOf(clip, p)));
  const hasAnim = clip => has(clip, 'anim');
  const hasTransformKeys = clip => ['scale', 'x', 'y', 'r'].some(p => keysOf(clip, p));
  const trimOf = clip => Number(clip.trimStart) || 0;
  const tmplOf = clip => st().templates.find(t => t.id === clip.templateId);
  const eps = () => 0.5 / (st().project?.fps || 30);

  /** Base de tempo das chaves: 'media' (vídeo/áudio/HTML: trimStart + posição), 'fit' (HTML esticado) ou 'clip' (imagem/texto) */
  function basis(clip) {
    const t = tmplOf(clip);
    if (clip.isText || t?.type === 'image' || t?.type === 'text') return 'clip';
    if (t?.type === 'html' && clip.fitAnimationToClip) return 'fit';
    return 'media';
  }
  function fitRatio(clip) {   // segundos da fonte por segundo do clip (HTML esticado)
    const span = (Number(clip.trimEnd) || 0) - trimOf(clip);
    return span > 0.001 && clip.duration > 0.001 ? span / clip.duration : 1;
  }
  function toSource(clip, t) {
    const b = basis(clip);
    if (b === 'clip') return t - clip.start;
    if (b === 'fit') return trimOf(clip) + (t - clip.start) * fitRatio(clip);
    return trimOf(clip) + (t - clip.start);
  }
  function toTimeline(clip, s) {
    const b = basis(clip);
    if (b === 'clip') return clip.start + s;
    if (b === 'fit') return clip.start + (s - trimOf(clip)) / fitRatio(clip);
    return clip.start + (s - trimOf(clip));
  }
  const srcRange = clip => [toSource(clip, clip.start), toSource(clip, clip.start + clip.duration)];

  const resOf = () => st().project?.res || { w: 1080, h: 1920 };
  const wrap180 = r => ((((Number(r) || 0) + 180) % 360) + 360) % 360 - 180;
  const fitOf = clip => window.__frameClip?.(clip.id, 'fit') || { w: resOf().w, h: resOf().h };
  const baseBox = clip => clip._tx || window.__frameClip?.(clip.id, 'fit') || { x: 0, y: 0, w: resOf().w, h: resOf().h, r: 0 };
  /** Caixa → { scale %, x, y (centro em relação ao centro do quadro), r } */
  function boxMetrics(clip, tx) {
    const R = resOf();
    const fit = fitOf(clip);
    return { scale: tx.w / Math.max(1, fit.w) * 100, x: tx.x + tx.w / 2 - R.w / 2, y: tx.y + tx.h / 2 - R.h / 2, r: wrap180(tx.r) };
  }
  const baseMetrics = clip => boxMetrics(clip, baseBox(clip));

  /** Valor fixo (sem keyframes) da propriedade */
  function staticValue(clip, prop) {
    if (prop === 'volume') return clamp(Number(clip.volume ?? 1), 0, 1);
    if (ADJUST.has(prop)) return Number(clip.fx?.adjust?.[prop] ?? PROPS[prop].def);
    if (CAMERA.includes(prop)) return Number(clip.cam?.[prop] ?? PROPS[prop].def);
    return baseMetrics(clip)[prop];
  }

  /** Valor da propriedade no tempo t da timeline: keyframes, ou o valor fixo */
  function valueAt(clip, prop, t) {
    const keys = keysOf(clip, prop);
    if (!keys) return staticValue(clip, prop);
    const P = PROPS[prop];
    const v = FX().evalKeys(keys, toSource(clip, t));
    return prop === 'volume' ? clamp(v, 0, 1) : clamp(v, P.min, P.max);
  }
  /** Volume dos keyframes no tempo t (null = sem keyframes): usado por __clipAudioGain */
  const volumeAt = (clip, t) => (keysOf(clip, 'volume') ? valueAt(clip, 'volume', t) : null);

  /** Troca a lista de uma propriedade (copy-on-write); vazia remove */
  function write(clip, prop, list) {
    const next = { ...(clip.keyframes || {}) };
    if (list.length) next[prop] = [...list].sort((a, b) => a.t - b.t);
    else delete next[prop];
    if (Object.keys(next).length) clip.keyframes = next; else delete clip.keyframes;
  }

  const insideClip = (clip, t) => t >= clip.start - 1e-6 && t <= clip.start + clip.duration + 1e-6;
  const indexAt = (clip, prop, t) => {
    const keys = keysOf(clip, prop);
    if (!keys) return -1;
    const s = toSource(clip, t);
    return keys.findIndex(k => Math.abs(k.t - s) < eps() * (basis(clip) === 'fit' ? fitRatio(clip) : 1));
  };

  function clampValue(prop, v) {
    const P = PROPS[prop];
    return r3(clamp(Number(v), P.min, P.max));
  }

  /** Cria (ou atualiza) o keyframe de `prop` no tempo t da timeline */
  function addKey(clip, prop, t, v) {
    const [lo, hi] = srcRange(clip);
    const s = clamp(toSource(clip, t), Math.min(lo, hi), Math.max(lo, hi));
    const keys = [...(keysOf(clip, prop) || [])];
    const i = keys.findIndex(k => Math.abs(k.t - s) < eps());
    const key = { ...(i >= 0 ? keys[i] : {}), t: r3(i >= 0 ? keys[i].t : s), v: clampValue(prop, v) };
    if (i >= 0) keys[i] = key; else keys.push(key);
    write(clip, prop, keys);
    return key;
  }

  /** Troca TODOS os keyframes de `prop` por list = [{ t (segundos desde o início do clip), v, e? }] (ex.: câmera com IA) */
  function setKeys(clip, prop, list) {
    const [lo, hi] = srcRange(clip);
    write(clip, prop, list.map(k => ({
      t: r3(clamp(toSource(clip, clip.start + k.t), Math.min(lo, hi), Math.max(lo, hi))),
      v: clampValue(prop, k.v),
      ...(k.e ? { e: k.e } : {}),
    })));
  }

  function removeKey(clip, prop, index) {
    const keys = [...(keysOf(clip, prop) || [])];
    if (!keys[index]) return;
    const [gone] = keys.splice(index, 1);
    if (!keys.length) setStatic(clip, prop, gone.v);   // o último valor vira o valor fixo
    write(clip, prop, keys);
  }

  /** Grava o valor fixo (sem keyframes) da propriedade no clip */
  function setStatic(clip, prop, v) {
    if (prop === 'volume') { clip.volume = r3(clamp(v, 0, 1)); return; }
    if (CAMERA.includes(prop)) { clip.cam = { ...(clip.cam || {}), [prop]: r3(v) }; return; }
    if (ADJUST.has(prop)) {
      const fx = JSON.parse(JSON.stringify(clip.fx || {}));
      fx.adjust = { ...(fx.adjust || {}), [prop]: v };
      if (v === PROPS[prop].def) delete fx.adjust[prop];
      if (!Object.keys(fx.adjust).length) delete fx.adjust;
      if (Object.keys(fx).length) clip.fx = fx; else delete clip.fx;
      return;
    }
    // Caixa: mantém o resto e troca só esta medida
    const R = resOf();
    const m = { ...baseMetrics(clip), [prop]: v };
    const fit = fitOf(clip);
    const b = baseBox(clip);
    const aspect = b.w / Math.max(1, b.h);
    const w = Math.max(4, fit.w * m.scale / 100);
    const h = w / aspect;
    clip._tx = { x: R.w / 2 + m.x - w / 2, y: R.h / 2 + m.y - h / 2, w, h, r: ((m.r % 360) + 360) % 360 };
  }

  /** Remove todas as chaves de uma lista de propriedades no tempo t */
  function removeAt(clip, props, t) {
    props.forEach(p => { const i = indexAt(clip, p, t); if (i >= 0) removeKey(clip, p, i); });
  }

  /** Velocidade mudou (a mídia foi reescalada em f): os keyframes acompanham o áudio */
  function rescaleSource(clip, f) {
    Object.keys(PROPS).forEach(p => {
      const keys = keysOf(clip, p);
      if (keys) write(clip, p, keys.map(k => ({ ...k, t: r3(k.t * f) })));
    });
  }

  /**
   * Corte: a metade da direita de uma imagem/texto recomeça em t=0 do clip; as chaves
   * deslocam (as de antes do corte ficam como "fora do quadro" e mantêm a continuidade).
   * Vídeo/áudio/HTML usam o tempo da mídia e não precisam de ajuste.
   */
  function onSplit(rightClip, rel) {
    if (basis(rightClip) !== 'clip') return;
    Object.keys(PROPS).forEach(p => {
      const keys = keysOf(rightClip, p);
      if (keys) write(rightClip, p, keys.map(k => ({ ...k, t: r3(k.t - rel) })));
    });
  }

  /** Curva do trecho que começa no keyframe do tempo (fonte) s — em todas as propriedades */
  function setCurveAt(clip, s, curve) {
    Object.keys(PROPS).forEach(p => {
      const keys = keysOf(clip, p);
      if (!keys) return;
      const i = keys.findIndex(k => Math.abs(k.t - s) < eps() * 1.5);
      if (i < 0) return;
      const next = [...keys];
      const { e, ...rest } = next[i];
      next[i] = curve ? { ...rest, e: curve } : rest;
      write(clip, p, next);
    });
  }

  /** Tempos (fonte) com keyframe em qualquer propriedade, sem repetir (para a faixa de losangos) */
  function keyTimes(clip, props = Object.keys(PROPS)) {
    const out = [];
    props.forEach(p => (keysOf(clip, p) || []).forEach(k => {
      if (!out.some(o => Math.abs(o.t - k.t) < eps())) out.push({ t: k.t, props: [p], e: k.e });
      else {
        const o = out.find(q => Math.abs(q.t - k.t) < eps());
        o.props.push(p);
        if (k.e && !o.e) o.e = k.e;
      }
    }));
    return out.sort((a, b) => a.t - b.t);
  }

  // ── Para o preview e o export ──
  const toRel = (clip, s) => toTimeline(clip, s) - clip.start;

  /** Chaves de animação visual com t em segundos desde o início do clip (null se não há) */
  function relKeys(clip) {
    if (!hasAnim(clip)) return null;
    const out = {};
    VISUAL.forEach(p => {
      const keys = keysOf(clip, p);
      if (keys) out[p] = keys.map(k => ({ t: r3(toRel(clip, k.t)), v: k.v, ...(k.e ? { e: k.e } : {}) }));
    });
    return out;
  }
  const baseOf = clip => baseMetrics(clip);

  /** Dados que o ClipFX.style espera além do fx: { kf, base } (vazio sem animação) */
  function styleInput(clip) {
    return hasAnim(clip) ? { kf: relKeys(clip), base: baseOf(clip) } : {};
  }

  /** Caixa animada no tempo t (para a caixa de seleção do preview) */
  function animatedBox(clip, t) {
    const b = baseBox(clip);
    if (!hasTransformKeys(clip)) return { ...b };
    const R = resOf();
    const fit = fitOf(clip);
    const m = baseMetrics(clip);
    ['scale', 'x', 'y', 'r'].forEach(p => { if (keysOf(clip, p)) m[p] = valueAt(clip, p, t); });
    const w = Math.max(4, fit.w * m.scale / 100);
    const h = w * (b.h / Math.max(1, b.w));
    return { x: R.w / 2 + m.x - w / 2, y: R.h / 2 + m.y - h / 2, w, h, r: ((m.r % 360) + 360) % 360 };
  }

  /**
   * Caixa do preview mexida por um clip com keyframes de transformação: as propriedades
   * animadas viram keyframe na agulha; as demais vão para a caixa fixa.
   */
  function commitBox(clip, tx) {
    if (!hasTransformKeys(clip)) return false;
    const m = boxMetrics(clip, tx);
    const t = st().time;
    const fixed = { ...baseMetrics(clip) };
    let changedFixed = false;
    ['scale', 'x', 'y', 'r'].forEach(p => {
      if (keysOf(clip, p)) {
        if (insideClip(clip, t)) addKey(clip, p, t, m[p]);
      } else if (Math.abs(fixed[p] - m[p]) > 1e-6) { fixed[p] = m[p]; changedFixed = true; }
    });
    if (changedFixed) {
      const base = { ...baseBox(clip) };
      const R = resOf();
      const fit = fitOf(clip);
      const w = Math.max(4, fit.w * fixed.scale / 100);
      const h = w * (base.h / Math.max(1, base.w));
      clip._tx = { x: R.w / 2 + fixed.x - w / 2, y: R.h / 2 + fixed.y - h / 2, w, h, r: ((fixed.r % 360) + 360) % 360 };
    }
    return true;
  }

  /** Curva de volume para o export: pontos (t em segundos do clip) já com o ganho da track; trechos com curva viram vários pontos */
  function exportKeys(clip, gain = 1) {
    const keys = keysOf(clip, 'volume');
    if (!keys) return null;
    const d = clip.duration;
    const out = [{ t: 0, v: r3(valueAt(clip, 'volume', clip.start) * gain) }];
    const pushAt = rel => out.push({ t: r3(rel), v: r3(valueAt(clip, 'volume', clip.start + rel) * gain) });
    const inside = keys.map(k => ({ ...k, rel: toRel(clip, k.t) }));
    inside.forEach((k, i) => {
      if (k.rel > 0.001 && k.rel < d - 0.001) pushAt(k.rel);
      const next = inside[i + 1];
      if (k.e && next) {   // trecho curvo: subpontos (o filtro do ffmpeg interpola em reta)
        const steps = 14;
        for (let n = 1; n < steps; n++) {
          const rel = k.rel + (next.rel - k.rel) * n / steps;
          if (rel > 0.001 && rel < d - 0.001) pushAt(rel);
        }
      }
    });
    out.push({ t: r3(d), v: r3(valueAt(clip, 'volume', clip.start + d) * gain) });
    return out.sort((a, b) => a.t - b.t).filter((p, i, arr) => !i || p.t > arr[i - 1].t + 1e-4);
  }
  // #endregion

  // #region Camadas especiais e câmera 2D
  /** 'solid' | 'gradient' | 'shape' | 'vignette' | 'grain' | 'bars' | 'adjustment' | 'camera' | null */
  const layerKind = clip => tmplOf(clip)?.layer?.kind || null;
  const isCamera = clip => layerKind(clip) === 'camera';
  const lanePropsOf = clip => (isCamera(clip) ? CAMERA : VISUAL);
  const hasLane = clip => lanePropsOf(clip).some(p => keysOf(clip, p));

  /** Todas as câmeras do projeto, prontas para o ClipFX (chaves em segundos do clip); [] sem câmera */
  function cameras() {
    const out = [];
    for (const clip of st().clips) {
      if (!isCamera(clip)) continue;
      const track = Number(clip.trackIndex) || 0;
      if ((st().tracks || []).find(t => t.index === track)?.hidden) continue;
      const kf = {};
      CAMERA.forEach(p => {
        const keys = keysOf(clip, p);
        if (keys) kf[p] = keys.map(k => ({ t: r3(toRel(clip, k.t)), v: k.v, ...(k.e ? { e: k.e } : {}) }));
      });
      out.push({
        id: clip.id, start: clip.start, duration: clip.duration, track, kf,
        base: { camX: staticValue(clip, 'camX'), camY: staticValue(clip, 'camY'), camZoom: staticValue(clip, 'camZoom'), camR: staticValue(clip, 'camR') },
      });
    }
    return out;
  }

  /** Centro da caixa fixa da camada, em px do projeto (referência da câmera) */
  function centerOf(clip) {
    const b = baseBox(clip);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  /**
   * Caixa da camada como ela aparece na tela com a câmera 2D ativa no tempo t (para a caixa de seleção
   * do preview, só leitura); null sem câmera, com a câmera neutra ou com "Ver sem câmera".
   */
  function cameraViewBox(clip, tx, t) {
    if (window.__cameraBypass || !FX()) return null;
    const kind = layerKind(clip);
    if (kind === 'camera' || kind === 'adjustment') return null;
    const track = Number(clip.trackIndex) || 0;
    const cam = FX().pickCamera(cameras().filter(c => c.track > track), t);
    if (!cam) return null;
    const s = FX().cameraStateAt(cam, t);
    const z = Math.max(0.05, s.camZoom / 100);
    if (Math.abs(s.camX) < 0.01 && Math.abs(s.camY) < 0.01 && Math.abs(z - 1) < 1e-4 && Math.abs(s.camR) < 0.01) return null;
    const R = resOf();
    const phi = -s.camR * Math.PI / 180;
    const cos = Math.cos(phi), sin = Math.sin(phi);
    const vx = tx.x + tx.w / 2 - (R.w / 2 + s.camX), vy = tx.y + tx.h / 2 - (R.h / 2 + s.camY);
    const nx = R.w / 2 + z * (vx * cos - vy * sin), ny = R.h / 2 + z * (vx * sin + vy * cos);
    return { x: nx - tx.w * z / 2, y: ny - tx.h * z / 2, w: tx.w * z, h: tx.h * z, r: (tx.r || 0) - s.camR };
  }

  /**
   * Dados extras que o ClipFX.style usa além de fx/kf: câmeras acima desta camada, mesclagem e
   * camada de ajuste. `all` = cameras() (calculado uma vez por quadro). Câmeras e camadas de
   * ajuste ficam fora da câmera: o ajuste filtra o que está abaixo, em tela.
   */
  function fxExtras(clip, all) {
    const kind = layerKind(clip);
    const out = {};
    if (clip.blend && clip.blend !== 'normal') out.blend = clip.blend;
    if (kind === 'adjustment') out.adj = true;
    if (all && all.length && kind !== 'camera' && kind !== 'adjustment') {
      const track = Number(clip.trackIndex) || 0;
      const list = all.filter(c => c.track > track);
      if (list.length) {
        out.cams = list;
        out.center = centerOf(clip);
        out.frame = { w: resOf().w, h: resOf().h };
      }
    }
    return out;
  }
  // #endregion

  // #region Estado de seleção de keyframe (a curva em "Animação" age nele)
  const sel = { clipId: null, s: null };
  /** Tempo (fonte) do keyframe em foco: o selecionado na timeline ou o que está sob a agulha */
  function activeKeyTime(clip) {
    if (!clip || !has(clip)) return null;
    if (sel.clipId === clip.id && sel.s != null && keyTimes(clip).some(k => Math.abs(k.t - sel.s) < eps())) return sel.s;
    const under = keyTimes(clip).find(k => insideClip(clip, toTimeline(clip, k.t)) && Math.abs(toTimeline(clip, k.t) - st().time) < eps());
    return under ? under.t : null;
  }
  /** Losango em foco (selecionado ou sob a agulha) destacado na faixa do bloco, sem refazer o bloco */
  function markActiveDot(clip) {
    const block = clip && document.querySelector(`#tlTracks .tl-block[data-clip-id="${CSS.escape(clip.id)}"]`);
    if (!block) return;
    const act = activeKeyTime(clip);
    block.querySelectorAll('.tl-kfl-dot').forEach(d => d.classList.toggle('is-active', act != null && Math.abs(Number(d.dataset.s) - act) < eps()));
  }
  const selectKey = (clipId, s) => { sel.clipId = clipId; sel.s = s; };
  // #endregion

  // #region Painel: ‹ ◇ › ao lado de cada controle
  const DIAMOND = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1.2 10.8 6 6 10.8 1.2 6Z"/></svg>';
  const groupHas = (clip, group) => GROUPS[group].some(p => keysOf(clip, p));
  const groupOn = (clip, group, t) => GROUPS[group].some(p => indexAt(clip, p, t) >= 0);

  function controls(clip, group) {
    const t = st().time;
    const inside = insideClip(clip, t);
    const keyed = groupHas(clip, group);
    const on = keyed && inside && groupOn(clip, group, t);
    const id = (window.escapeHtml || String)(clip.id);
    return `<span class="kf-ctl" data-clip-id="${id}" data-group="${group}">
      ${keyed ? '<button type="button" class="kf-nav" data-kf="prev" title="Keyframe anterior">‹</button>' : ''}
      <button type="button" class="kf-diamond${on ? ' is-on' : ''}" data-kf="toggle"${inside ? '' : ' disabled'}
        title="${inside ? (on ? 'Remover o keyframe desta posição' : 'Adicionar um keyframe na posição da agulha') : 'Mova a agulha para dentro do clip'}">${DIAMOND}</button>
      ${keyed ? '<button type="button" class="kf-nav" data-kf="next" title="Próximo keyframe">›</button>' : ''}
    </span>`;
  }

  /**
   * Controle mexido com a propriedade em keyframes: vira keyframe na agulha.
   * true = tratado aqui. opts.undo = empilha o passo de undo (primeiro movimento do gesto)
   */
  function handleInput(clip, prop, v, { undo = false } = {}) {
    if (!keysOf(clip, prop)) return false;
    if (insideClip(clip, st().time)) {
      if (undo) window.__tlPushUndo?.();
      addKey(clip, prop, st().time, v);
      syncAfterEdit(clip, { full: false });
    }
    return true;
  }
  /** Volume (slider do painel de áudio): mesmo comportamento, undo já tratado pelo chamador */
  const handleVolumeInput = (clip, v) => handleInput(clip, 'volume', v);

  function syncAfterEdit(clip, { full = true } = {}) {
    window.__syncCompositorToTime?.(st().time);
    window.__reapplyClipFx?.(clip.id);
    if (full) {
      if (typeof refreshClipBlock === 'function') refreshClipBlock(clip.id);
      window.__refreshTransformOverlay?.();
      window.__renderProps?.();
    } else {
      refreshOverlay(clip);
    }
  }

  function panelClip(ctl) {
    return st().clips.find(c => c.id === ctl.dataset.clipId);
  }

  function onPanelClick(e) {
    const btn = e.target.closest('[data-kf]');
    if (!btn || btn.disabled) return;
    const ctl = btn.closest('.kf-ctl');
    const clip = ctl && panelClip(ctl);
    if (!clip) return;
    const group = ctl.dataset.group;
    const props = GROUPS[group];
    const t = st().time;
    if (btn.dataset.kf === 'toggle') {
      window.__tlPushUndo?.();
      if (groupOn(clip, group, t)) {
        removeAt(clip, props, t);
      } else {
        props.forEach(p => addKey(clip, p, t, valueAt(clip, p, t)));
        selectKey(clip.id, toSource(clip, t));
      }
      syncAfterEdit(clip);
      return;
    }
    // ‹ › : keyframe anterior/seguinte (do grupo) dentro do clip
    const times = keyTimes(clip, props).map(k => toTimeline(clip, k.t)).filter(x => insideClip(clip, x));
    const target = btn.dataset.kf === 'prev'
      ? [...times].reverse().find(x => x < t - eps())
      : times.find(x => x > t + eps());
    if (target != null) { selectKey(clip.id, toSource(clip, target)); window.seekTo?.(target); }
  }

  const SELECTORS = {
    scale: '.tf-props [data-tf="scale"]', x: '.tf-props [data-tf="x"]', y: '.tf-props [data-tf="y"]', r: '.tf-props [data-tf="r"]',
  };
  CAMERA.forEach(p => { SELECTORS[p] = `.cam-props [data-cam="${p}"]`; });
  const inputFor = prop => document.querySelector(`#propsContent ${SELECTORS[prop] || `.fx-props [data-fx="adjust.${prop}"]`}`);
  const LABEL_FMT = { scale: v => `${Math.round(v)}%`, camZoom: v => `${Math.round(v)}%`, r: v => `${Math.round(v * 10) / 10}°`, camR: v => `${Math.round(v * 10) / 10}°` };

  /** A agulha andou: losangos e valores mostram a posição (sem refazer o painel) */
  function onTime() {
    const props = document.getElementById('propsContent');
    const ctls = props ? props.querySelectorAll('.kf-ctl') : [];
    const clipId = ctls[0]?.dataset.clipId;
    const clip = clipId && st().clips.find(c => c.id === clipId);
    if (clip) {
      const t = st().time;
      const inside = insideClip(clip, t);
      ctls.forEach(ctl => {
        const group = ctl.dataset.group;
        const diamond = ctl.querySelector('.kf-diamond');
        if (diamond) {
          diamond.disabled = !inside;
          diamond.classList.toggle('is-on', Boolean(inside && groupHas(clip, group) && groupOn(clip, group, t)));
        }
        GROUPS[group].forEach(p => {
          if (!keysOf(clip, p)) return;
          const v = valueAt(clip, p, t);
          if (p === 'volume') {
            const range = ctl.closest('.prop-row')?.querySelector('input[type="range"]');
            const pct = Math.round(v * 100);
            if (range && document.activeElement !== range && Number(range.value) !== pct) range.value = pct;
            const label = document.getElementById('apVolumeVal');
            if (label) label.textContent = `${pct}%`;
            return;
          }
          const input = inputFor(p);
          if (!input || document.activeElement === input) return;
          const shown = Math.round(v * 10) / 10;
          if (Number(input.value) !== shown) input.value = shown;
          const label = input.parentElement?.querySelector('.fx-val');
          if (label) label.textContent = (LABEL_FMT[p] || (x => `${Math.round(x * 10) / 10}`))(v);
        });
      });
      // Caixa do preview e editor de curva acompanham a agulha
      markActiveDot(clip);
      if (hasTransformKeys(clip) || (!isCamera(clip) && cameras().length)) window.__refreshTransformOverlay?.();
      window.__curvesOnTime?.(clip);
    }
  }
  // #endregion

  // #region Timeline: linha de volume e faixa de losangos
  const fmtT = t => (window.fmtTime ? window.fmtTime(t) : `${Number(t).toFixed(2)}s`);
  const blockOf = clipId => document.querySelector(`#tlTracks .tl-block[data-clip-id="${CSS.escape(clipId)}"]`);
  const pxPerSec = () => (window.__PX_PER_SEC || 80) * st().zoom;

  function decorateBlock(block, clip, tmpl, pps) {
    block.querySelectorAll(':scope > .tl-kf, :scope > .tl-kfl').forEach(el => el.remove());
    if (!tmpl) return;
    const W = Math.max(4, clip.duration * pps - 1);
    const H = Math.max(24, parseFloat(block.style.height) || block.clientHeight || 64);

    // Volume (áudio/vídeo): linha sobre a forma de onda
    if (tmpl.type === 'audio' || tmpl.type === 'video') {
      const keys = keysOf(clip, 'volume');
      const yOf = v => PAD_T + (1 - v) * (H - PAD_T - PAD_B);
      const pts = [[0, valueAt(clip, 'volume', clip.start)]];
      const dots = [];
      (keys || []).forEach((k, i) => {
        const x = (toTimeline(clip, k.t) - clip.start) * pps;
        if (x >= -0.5 && x <= W + 0.5) { pts.push([clamp(x, 0, W), k.v]); dots.push({ i, x: clamp(x, 0, W), v: k.v, t: toTimeline(clip, k.t) }); }
      });
      // Trechos curvos: pontos intermediários para a linha seguir a curva
      const line = [];
      for (let i = 0; i < pts.length - 1; i++) {
        line.push(pts[i]);
        const k = keys && i > 0 ? keys[i - 1] : null;
        if (k?.e) for (let n = 1; n < 12; n++) {
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * n / 12;
          line.push([x, valueAt(clip, 'volume', clip.start + x / pps)]);
        }
      }
      pts.push([W, valueAt(clip, 'volume', clip.start + clip.duration)]);
      line.push(pts[pts.length - 2], pts[pts.length - 1]);
      const poly = line.map(([x, v]) => `${x.toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
      const root = document.createElement('div');
      root.className = `tl-kf${keys ? ' has-keys' : ''}`;
      root.innerHTML =
        `<svg class="tl-kf-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
        `<polyline class="tl-kf-hit" points="${poly}"/><polyline class="tl-kf-line" points="${poly}"/></svg>` +
        dots.map(d => `<div class="tl-kf-dot" data-i="${d.i}" style="left:${d.x.toFixed(1)}px;top:${yOf(d.v).toFixed(1)}px" title="${fmtT(d.t)} · ${Math.round(d.v * 100)}% — arraste; duplo clique remove"></div>`).join('');
      block.appendChild(root);
    }

    // Animação visual (ou da câmera): faixa de losangos (todas as propriedades juntas)
    if (hasLane(clip)) {
      const times = keyTimes(clip, lanePropsOf(clip));
      const lane = document.createElement('div');
      lane.className = 'tl-kfl';
      const segs = [];
      times.forEach((k, i) => {
        const x = (toTimeline(clip, k.t) - clip.start) * pps;
        const next = times[i + 1];
        if (next && x < W + 1) {
          const x2 = (toTimeline(clip, next.t) - clip.start) * pps;
          const a = clamp(x, 0, W), b = clamp(x2, 0, W);
          if (b > a) segs.push(`<span class="tl-kfl-seg${k.e ? ' has-curve' : ''}" style="left:${a.toFixed(1)}px;width:${(b - a).toFixed(1)}px"></span>`);
        }
      });
      const diamonds = times.map(k => {
        const x = (toTimeline(clip, k.t) - clip.start) * pps;
        if (x < -2 || x > W + 2) return '';
        const names = k.props.map(p => PROPS[p].label).join(', ');
        const focus = activeKeyTime(clip);
        const active = focus != null && Math.abs(focus - k.t) < eps();
        return `<div class="tl-kfl-dot${active ? ' is-active' : ''}${k.e ? ' has-curve' : ''}" data-s="${k.t}" style="left:${clamp(x, 0, W).toFixed(1)}px" title="${names} · ${fmtT(toTimeline(clip, k.t))}${k.e ? ' · com curva' : ''} — clique para editar a curva; arraste para mover; duplo clique remove"></div>`;
      }).join('');
      lane.innerHTML = segs.join('') + diamonds;
      block.appendChild(lane);
    }
  }

  function refreshOverlay(clip) {
    const block = blockOf(clip.id);
    if (block) decorateBlock(block, clip, tmplOf(clip), pxPerSec());
  }

  let tip = null;
  const showTip = (x, y, text) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'tl-fx-tip'; document.body.appendChild(tip); }
    tip.textContent = text;
    tip.style.left = `${x + 14}px`;
    tip.style.top = `${y - 30}px`;
  };
  const hideTip = () => { tip?.remove(); tip = null; };

  /** Ponteiro → { t, v } sobre o bloco (volume) */
  function pointAt(ev, clip, root) {
    const rect = root.getBoundingClientRect();
    const fps = st().project?.fps || 30;
    const t = clip.start + (ev.clientX - rect.left) / pxPerSec();
    const raw = 1 - (ev.clientY - rect.top - PAD_T) / Math.max(1, rect.height - PAD_T - PAD_B);
    let v = clamp(raw, 0, 1);
    if (v < 0.03) v = 0; else if (v > 0.97) v = 1;
    return { t: clamp(Math.round(t * fps) / fps, clip.start, clip.start + clip.duration), v };
  }

  function drag(e, clip, rootSel, onMove, onEnd) {
    let pushed = false;
    const start = { x: e.clientX, y: e.clientY };
    const move = ev => {
      if (!pushed && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 3) return;
      if (!pushed) { window.__tlPushUndo?.(); pushed = true; }
      // O overlay é refeito a cada movimento: mede sempre o atual
      onMove(ev, pointAt(ev, clip, blockOf(clip.id)?.querySelector(rootSel)));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      hideTip();
      document.body.classList.remove('tl-kf-dragging');
      if (pushed) onEnd?.();
    };
    document.body.classList.add('tl-kf-dragging');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function startVolumeDotDrag(e, clip, index) {
    let cur = keysOf(clip, 'volume')?.[index];
    if (!cur) return;
    window.seekTo?.(toTimeline(clip, cur.t));
    drag(e, clip, '.tl-kf', (ev, p) => {
      const others = (keysOf(clip, 'volume') || []).filter(k => k !== cur);
      const [lo, hi] = srcRange(clip);
      cur = { ...cur, t: r3(clamp(toSource(clip, p.t), Math.min(lo, hi), Math.max(lo, hi))), v: r3(p.v) };
      write(clip, 'volume', [...others, cur]);
      syncAfterEdit(clip, { full: false });
      showTip(ev.clientX, ev.clientY, `${fmtT(p.t)} · ${Math.round(p.v * 100)}%`);
    }, () => syncAfterEdit(clip));
  }

  /** Sem keyframes: arrastar a linha para cima/baixo muda o volume do clip */
  function startLineDrag(e, clip) {
    drag(e, clip, '.tl-kf', (ev, p) => {
      clip.volume = r3(p.v);
      window.__syncCompositorToTime?.(st().time);
      refreshOverlay(clip);
      const range = document.querySelector('#propsContent .kf-ctl[data-group="volume"]')?.closest('.prop-row')?.querySelector('input[type="range"]');
      if (range) range.value = Math.round(p.v * 100);
      const label = document.getElementById('apVolumeVal');
      if (label) label.textContent = `${Math.round(p.v * 100)}%`;
      showTip(ev.clientX, ev.clientY, `${Math.round(p.v * 100)}%`);
    }, () => syncAfterEdit(clip));
  }

  /** Losango da faixa de animação: arrasta todos os keyframes daquele instante */
  function startAnimDotDrag(e, clip, s0) {
    selectKey(clip.id, s0);
    window.seekTo?.(toTimeline(clip, s0));
    refreshOverlay(clip);
    window.__renderProps?.();
    let cur = s0;
    drag(e, clip, '.tl-kfl', (ev, p) => {
      const [lo, hi] = srcRange(clip);
      const next = r3(clamp(toSource(clip, p.t), Math.min(lo, hi), Math.max(lo, hi)));
      if (Math.abs(next - cur) < 1e-6) return;
      lanePropsOf(clip).forEach(prop => {
        const keys = keysOf(clip, prop);
        if (!keys) return;
        const i = keys.findIndex(k => Math.abs(k.t - cur) < eps());
        if (i < 0) return;
        const moved = { ...keys[i], t: next };
        write(clip, prop, [...keys.filter((_, n) => n !== i), moved]);
      });
      cur = next;
      selectKey(clip.id, cur);
      syncAfterEdit(clip, { full: false });
      showTip(ev.clientX, ev.clientY, fmtT(toTimeline(clip, cur)));
    }, () => syncAfterEdit(clip));
  }

  function ctxOf(el) {
    const block = el.closest('.tl-block');
    const clip = block && st().clips.find(c => c.id === block.dataset.clipId);
    return clip ? { block, clip } : null;
  }

  function initTimelineEvents() {
    const tracks = document.getElementById('tlTracks');
    if (!tracks) return;
    // Captura: roda antes de o bloco iniciar o arrastar do clip
    tracks.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const vdot = e.target.closest('.tl-kf-dot');
      const vhit = !vdot && e.target.closest('.tl-kf-hit');
      const adot = e.target.closest('.tl-kfl-dot');
      if (!vdot && !vhit && !adot) return;
      const ctx = ctxOf(e.target);
      if (!ctx) return;
      e.stopPropagation();
      e.preventDefault();
      if (!window.__selectedClipIds?.has(ctx.clip.id)) window.selectClip?.(ctx.clip.id);
      if (adot) return startAnimDotDrag(e, ctx.clip, Number(adot.dataset.s));
      if (vdot) return startVolumeDotDrag(e, ctx.clip, Number(vdot.dataset.i));
      if (!keysOf(ctx.clip, 'volume')) startLineDrag(e, ctx.clip);
    }, true);

    tracks.addEventListener('dblclick', e => {
      const vdot = e.target.closest('.tl-kf-dot');
      const vhit = !vdot && e.target.closest('.tl-kf-hit');
      const adot = e.target.closest('.tl-kfl-dot');
      if (!vdot && !vhit && !adot) return;
      const ctx = ctxOf(e.target);
      if (!ctx) return;
      e.stopPropagation();
      e.preventDefault();
      window.__tlPushUndo?.();
      if (adot) {
        const s = Number(adot.dataset.s);
        lanePropsOf(ctx.clip).forEach(p => {
          const i = (keysOf(ctx.clip, p) || []).findIndex(k => Math.abs(k.t - s) < eps());
          if (i >= 0) removeKey(ctx.clip, p, i);
        });
        if (sel.s != null && Math.abs(sel.s - s) < eps()) selectKey(null, null);
      } else if (vdot) {
        removeKey(ctx.clip, 'volume', Number(vdot.dataset.i));
      } else {
        const p = pointAt(e, ctx.clip, ctx.block.querySelector('.tl-kf'));
        addKey(ctx.clip, 'volume', p.t, valueAt(ctx.clip, 'volume', p.t));
      }
      syncAfterEdit(ctx.clip);
    }, true);
  }
  // #endregion

  window.ClipKF = {
    PROPS, GROUPS, VISUAL, CAMERA,
    layerKind, isCamera, lanePropsOf, cameras, centerOf, fxExtras, cameraViewBox,
    has, hasAnim, hasTransformKeys, keys: keysOf, valueAt, volumeAt, staticValue, addKey, setKeys, removeKey, removeAt, indexAt, setStatic,
    toSource, toTimeline, keyTimes, setCurveAt, activeKeyTime, selectKey, selected: () => ({ ...sel }), insideClip,
    relKeys, baseOf, styleInput, animatedBox, commitBox, exportKeys, rescaleSource, onSplit,
    controls, handleInput, handleVolumeInput, syncAfterEdit, onPanelClick,
  };
  window.__decorateKfBlock = decorateBlock;
  window.__kfOnTime = onTime;

  function boot() {
    initTimelineEvents();
    document.getElementById('propsContent')?.addEventListener('click', onPanelClick);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
