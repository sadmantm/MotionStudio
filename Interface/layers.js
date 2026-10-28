'use strict';
// layers.js
//
//  Camadas criadas no editor, no estilo After Effects / Photoshop:
//    • botão direito na área vazia da timeline → "Nova camada": Sólido (cor), Gradiente, Forma
//      (retângulo/elipse), Camada de ajuste, Câmera 2D e Efeitos de imagem (vinheta, grão de filme,
//      barras de cinema). A camada nasce no instante e na track do clique.
//    • botão direito num clip → "Modo de mesclagem" (também em Efeitos › Mesclagem): Multiplicar,
//      Tela, Sobrepor, Luz suave… (mix-blend-mode, igual no preview e no export)
//    • seção "Camada" no painel: cor, gradiente, forma… editáveis depois de criar
//  Sólido, gradiente, forma, vinheta, grão e barras são imagens SVG (data URL) — entram na timeline,
//  no preview e no export como qualquer imagem, com transformar, efeitos, keyframes e mesclagem.
//  A camada de ajuste é uma imagem vazia cujo filtro age sobre TUDO que está abaixo dela (backdrop-filter).
//  A câmera 2D é uma imagem vazia que move/aproxima/gira as camadas abaixo (camera.js).
//  template.layer = { kind, ...parâmetros } guarda como regenerar a imagem.

(() => {
  const st = () => window.__appState;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const pushUndo = () => window.__tlPushUndo?.();
  const mk = () => (window.mkId ? window.mkId() : Math.random().toString(36).slice(2, 11));
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : d);
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

  // #region Camadas: padrões, nomes e a imagem SVG de cada uma
  const NAMES = { solid: 'Sólido', gradient: 'Gradiente', shape: 'Forma', vignette: 'Vinheta', grain: 'Grão de filme', bars: 'Barras de cinema', adjustment: 'Camada de ajuste', camera: 'Câmera 2D' };
  const DEFAULTS = {
    solid:      { color: '#82ea00' },
    gradient:   { type: 'linear', color1: '#7c3aed', color2: '#22d3ee', angle: 135, cx: 50, cy: 50 },
    shape:      { shape: 'rect', fill: '#82ea00', stroke: '#ffffff', strokeWidth: 0, w: 60, h: 30, radius: 8 },
    vignette:   { color: '#000000', strength: 70, size: 40 },
    grain:      { strength: 55, size: 50, seed: 3 },
    bars:       { ratio: 2.39, color: '#000000' },
    adjustment: {},
    camera:     {},
  };
  const COLORS = { adjustment: '#a78bfa', camera: '#22d3ee', vignette: '#6b7280', grain: '#9ca3af', bars: '#374151' };

  const svgWrap = (W, H, inner, defs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ''}${inner}</svg>`;

  /** Imagem SVG (texto) da camada, no tamanho do projeto */
  function svgFor(layer, res) {
    const W = Math.max(1, Math.round(res.w)), H = Math.max(1, Math.round(res.h));
    const k = layer.kind;
    const P = { ...DEFAULTS[k], ...layer };
    if (k === 'solid') return svgWrap(W, H, `<rect width="${W}" height="${H}" fill="${hex(P.color, '#82ea00')}"/>`);

    if (k === 'gradient') {
      const c1 = hex(P.color1, '#7c3aed'), c2 = hex(P.color2, '#22d3ee');
      if (P.type === 'radial') {
        const cx = num(P.cx, 50, 0, 100) / 100 * W, cy = num(P.cy, 50, 0, 100) / 100 * H;
        const r = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
        return svgWrap(W, H, `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
          `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient>`);
      }
      // linear: mesmo ângulo do CSS (0° = para cima, 90° = para a direita), cobrindo o quadro inteiro
      const a = num(P.angle, 135, -360, 360) * Math.PI / 180;
      const dx = Math.sin(a), dy = -Math.cos(a);
      const L = Math.abs(W * dx) + Math.abs(H * dy);
      const x1 = W / 2 - dx * L / 2, y1 = H / 2 - dy * L / 2, x2 = W / 2 + dx * L / 2, y2 = H / 2 + dy * L / 2;
      return svgWrap(W, H, `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
        `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
    }

    if (k === 'shape') {
      const w = num(P.w, 60, 1, 100) / 100 * W, h = num(P.h, 30, 1, 100) / 100 * H;
      const x = (W - w) / 2, y = (H - h) / 2;
      const sw = num(P.strokeWidth, 0, 0, 200);
      const paint = `fill="${hex(P.fill, '#82ea00')}"${sw > 0 ? ` stroke="${hex(P.stroke, '#ffffff')}" stroke-width="${sw}"` : ''}`;
      if (P.shape === 'ellipse') return svgWrap(W, H, `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${(w / 2).toFixed(1)}" ry="${(h / 2).toFixed(1)}" ${paint}/>`);
      const rx = num(P.radius, 8, 0, 50) / 100 * Math.min(w, h);
      return svgWrap(W, H, `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx.toFixed(1)}" ${paint}/>`);
    }

    if (k === 'vignette') {
      const inner = Math.min(0.9, Math.max(0, num(P.size, 40, 0, 100) / 100 * 0.9));
      const color = hex(P.color, '#000000');
      return svgWrap(W, H, `<rect width="${W}" height="${H}" fill="url(#v)"/>`,
        `<radialGradient id="v" cx="0.5" cy="0.5" r="0.75"><stop offset="${inner.toFixed(2)}" stop-color="${color}" stop-opacity="0"/><stop offset="1" stop-color="${color}" stop-opacity="${(num(P.strength, 70, 0, 100) / 100).toFixed(2)}"/></radialGradient>`);
    }

    if (k === 'grain') {
      const freq = (0.5 + (100 - num(P.size, 50, 0, 100)) / 100).toFixed(3);
      const seed = Math.round(num(P.seed, 3, 0, 9999));
      // ruído cinza opaco; a intensidade é a opacidade do retângulo (combine com o modo "Sobrepor")
      return svgWrap(W, H, `<rect width="${W}" height="${H}" filter="url(#n)" opacity="${(num(P.strength, 55, 0, 100) / 100).toFixed(2)}"/>`,
        `<filter id="n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" stitchTiles="stitch"/><feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1"/></filter>`);
    }

    if (k === 'bars') {
      const bar = Math.max(0, (H - W / num(P.ratio, 2.39, 1, 4)) / 2);
      const c = hex(P.color, '#000000');
      return svgWrap(W, H, bar > 0.5 ? `<rect width="${W}" height="${bar.toFixed(1)}" fill="${c}"/><rect y="${(H - bar).toFixed(1)}" width="${W}" height="${bar.toFixed(1)}" fill="${c}"/>` : '');
    }
    // ajuste e câmera: sem imagem (o que importa é a caixa da camada)
    return svgWrap(W, H, '');
  }

  const dataUrlFor = (layer, res) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(layer, res));

  /** Cor do clip na timeline (a própria cor do sólido/forma/gradiente) */
  const clipColor = layer => (layer.kind === 'solid' ? hex(layer.color, '#82ea00') : layer.kind === 'gradient' ? hex(layer.color1, '#7c3aed') : layer.kind === 'shape' ? hex(layer.fill, '#82ea00') : COLORS[layer.kind] || '#82ea00');

  /** HTML mínimo para o export: a imagem SVG ocupando a caixa da camada (contrato window.Motion) */
  function exportHtml(tmpl, duration) {
    const d = Math.max(0.1, Number(duration) || 1);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}img{display:block;width:100%;height:100%;object-fit:fill}</style></head>` +
      `<body><img src="${tmpl.dataUrl}" alt=""><script>window.Motion={config:{fps:30,durationInSeconds:${d},totalFrames:${Math.round(d * 30)}},seek:function(){},renderFrame:function(){},whenReady:function(){return Promise.resolve()}};<\/script></body></html>`;
  }
  // #endregion

  // #region Criar camada na timeline
  const snapT = t => { const fps = st().project?.fps || 30; return Math.max(0, Math.round(t * fps) / fps); };

  /**
   * Track da nova camada em [start, end]. Sólido/forma/…: a track clicada, se estiver livre. Ajuste e câmera
   * (e o resto, quando a track clicada está ocupada): logo ACIMA do conteúdo (vídeos, imagens, cenas HTML,
   * outras camadas) e ABAIXO dos textos/legendas — assim legendas e títulos ficam fora do filtro e da câmera.
   * Se essa posição já é de um texto, abre uma track nova ali (as de cima sobem).
   */
  function trackFor(kind, start, end, preferred) {
    const track = c => Number(c.trackIndex) || 0;
    const isText = c => c.isText || st().templates.find(t => t.id === c.templateId)?.type === 'text';
    const locked = ti => Boolean((st().tracks || []).find(t => t.index === ti)?.locked);
    const overlapping = st().clips.filter(c => c.start < end - 1e-4 && start < c.start + c.duration - 1e-4);
    const free = ti => !locked(ti) && !overlapping.some(c => track(c) === ti);
    if (kind !== 'adjustment' && kind !== 'camera' && preferred != null && free(preferred)) return preferred;
    const content = overlapping.filter(c => !isText(c));
    const pos = content.length ? Math.max(...content.map(track)) + 1 : (overlapping.length ? Math.max(...overlapping.map(track)) + 1 : (preferred ?? 0));
    if (free(pos)) return pos;
    window.__insertTrackAt?.(pos);   // legendas ocupam esse lugar: abre uma track nova
    return pos;
  }

  function defaultDuration(start) {
    const total = st().project?.totalDuration || 0;
    return total - start >= 1 ? total - start : 5;
  }

  /** Cria a camada; opts: { start, duration, track, params, name, blend } → clip */
  function addLayer(kind, opts = {}) {
    const state = st();
    if (!state?.project) { window.MSUI?.toast({ message: 'Abra ou crie um projeto primeiro.', kind: 'info' }); return null; }
    const res = state.project.res;
    const layer = { kind, ...DEFAULTS[kind], ...(opts.params || {}) };
    const start = snapT(opts.start ?? state.time);
    const duration = Math.max(0.2, Number(opts.duration) || defaultDuration(start));
    const name = opts.name || NAMES[kind];
    const color = clipColor(layer);

    pushUndo();   // antes de abrir uma track nova: o desfazer devolve tudo
    const track = trackFor(kind, start, start + duration, opts.track);
    const template = {
      id: mk(), name, type: 'image', dataUrl: dataUrlFor(layer, res), mimeType: 'image/svg+xml',
      sourceDuration: duration, fps: state.project.fps, color, inLibrary: false, layer,
    };
    state.templates.push(template);
    const clip = {
      id: mk(), templateId: template.id, label: name, start, duration, trimStart: 0, trimEnd: duration,
      trackIndex: track, color,
      ...(opts.blend ? { blend: opts.blend } : {}),
    };
    state.clips.push(window.normalizeClip ? window.normalizeClip(clip) : clip);
    window.getTrack?.(track);
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
    window.__syncCompositorToTime?.(state.time);
    window.selectClip?.(clip.id);
    window.MSUI?.toast({ message: `Camada “${name}” criada${kind === 'camera' ? ' — mova a agulha e use ◇ para criar keyframes' : ''}.`, kind: 'ok', duration: 2600 });
    return clip;
  }
  // #endregion

  // #region Diálogos (Sólido e Gradiente)
  const PRESETS = ['#000000', '#ffffff', '#ff5d6c', '#ffb02e', '#ffd34d', '#82ea00', '#22d3ee', '#3a8ee6', '#7c3aed', '#f472b6'];

  const colorField = (name, label, value) => `
    <div class="ly-field"><label>${label}</label>
      <div class="ly-color">
        <input type="color" data-ly="${name}" value="${value}">
        <input type="text" class="prop-input" data-ly-hex="${name}" maxlength="7" value="${value}" spellcheck="false">
      </div>
    </div>`;

  function bindColors(root, onChange) {
    root.querySelectorAll('[data-ly]').forEach(c => {
      const hexInput = root.querySelector(`[data-ly-hex="${c.dataset.ly}"]`);
      c.addEventListener('input', () => { hexInput.value = c.value; onChange(); });
      hexInput.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hexInput.value)) { c.value = hexInput.value; onChange(); } });
    });
    root.querySelectorAll('[data-ly-preset]').forEach(b => b.addEventListener('click', () => {
      const target = root.querySelector(`[data-ly="${b.closest('[data-ly-for]').dataset.lyFor}"]`);
      target.value = b.dataset.lyPreset;
      target.dispatchEvent(new Event('input'));
    }));
  }
  const presetsRow = name => `<div class="ly-presets" data-ly-for="${name}">${PRESETS.map(c => `<button type="button" class="ly-swatch" data-ly-preset="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div>`;

  /** Pede nome, cor(es) e duração; devolve { name, duration, params } ou null */
  function askLayer(kind, at) {
    const defaults = { ...DEFAULTS[kind] };
    const dur = defaultDuration(snapT(at.t));
    const isGrad = kind === 'gradient';
    const d = window.MSUI.dialog({
      title: isGrad ? 'Novo gradiente' : 'Novo sólido',
      confirmLabel: 'Criar',
      bodyHtml: `
        <div class="ly-form">
          <div class="ly-field"><label>Nome</label><input type="text" class="prop-input full" data-ly-name maxlength="40" value="${NAMES[kind]}"></div>
          ${isGrad ? `
            <div class="ly-field"><label>Tipo</label><select class="prop-input full" data-ly-type><option value="linear">Linear</option><option value="radial">Radial</option></select></div>
            ${colorField('color1', 'Cor inicial', defaults.color1)}
            ${colorField('color2', 'Cor final', defaults.color2)}
            <div class="ly-field" data-ly-angle><label>Ângulo <span data-ly-angle-val>${defaults.angle}°</span></label><input type="range" class="prop-range" min="0" max="360" step="1" value="${defaults.angle}" data-ly-angle-input></div>
          ` : `
            ${colorField('color', 'Cor', defaults.color)}
            ${presetsRow('color')}
          `}
          <div class="ly-field"><label>Duração (s)</label><input type="number" class="prop-input" data-ly-dur min="0.2" step="0.1" value="${dur.toFixed(2)}"></div>
          <div class="ly-preview" data-ly-preview></div>
        </div>`,
      onReady: (el, close) => {
        const q = s => el.querySelector(s);
        const read = () => {
          const p = {};
          el.querySelectorAll('[data-ly]').forEach(c => { p[c.dataset.ly] = c.value; });
          if (isGrad) { p.type = q('[data-ly-type]').value; p.angle = Number(q('[data-ly-angle-input]').value); }
          return p;
        };
        const paint = () => {
          const p = read();
          q('[data-ly-preview]').style.background = isGrad
            ? (p.type === 'radial' ? `radial-gradient(circle at 50% 50%, ${p.color1}, ${p.color2})` : `linear-gradient(${p.angle}deg, ${p.color1}, ${p.color2})`)
            : p.color;
          if (isGrad) q('[data-ly-angle-val]').textContent = `${p.angle}°`;
        };
        bindColors(el, paint);
        el.querySelectorAll('[data-ly-type], [data-ly-angle-input]').forEach(c => c.addEventListener('input', () => {
          paint();
          if (isGrad) q('[data-ly-angle]').style.opacity = q('[data-ly-type]').value === 'radial' ? '.35' : '';
        }));
        paint();
        q('[data-ly-name]').select();
        q('[data-ui="ok"]').addEventListener('click', () => close({
          name: q('[data-ly-name]').value.trim() || NAMES[kind],
          duration: Math.max(0.2, Number(q('[data-ly-dur]').value) || dur),
          params: read(),
        }));
        el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'range') { e.preventDefault(); q('[data-ui="ok"]').click(); } });
      },
    });
    return d.promise;
  }

  async function createWithDialog(kind, at) {
    const out = await askLayer(kind, at);
    if (!out) return null;
    return addLayer(kind, { start: at.t, track: at.track, duration: out.duration, name: out.name, params: out.params });
  }
  // #endregion

  // #region Modo de mesclagem
  const blendOf = clip => clip?.blend || 'normal';

  /** Aplica o modo a clips (não áudio), com um passo de undo */
  function setBlend(clips, mode) {
    const list = clips.filter(c => c && st().templates.find(t => t.id === c.templateId)?.type !== 'audio');
    if (!list.length) return;
    pushUndo();
    list.forEach(c => {
      if (mode && mode !== 'normal') c.blend = mode; else delete c.blend;
      window.__reapplyClipFx?.(c.id);
      if (typeof refreshClipBlock === 'function') refreshClipBlock(c.id);
    });
    window.__syncCompositorToTime?.(st().time);
    window.__renderProps?.();
  }
  const selectedClips = () => [...(window.__selectedClipIds || [])].map(id => st().clips.find(c => c.id === id)).filter(Boolean);
  // #endregion

  // #region Painel: seção "Camada" (editar cor, gradiente, forma…)
  const isEditable = k => ['solid', 'gradient', 'shape', 'vignette', 'grain', 'bars'].includes(k);

  const colorRow = (label, key, value) => `
    <div class="prop-row"><label>${label}</label>
      <input type="color" class="prop-color" data-ly-prop="${key}" value="${value}">
      <input type="text" class="prop-input" data-ly-prop-hex="${key}" maxlength="7" value="${value}" style="flex:1" spellcheck="false"></div>`;
  const sliderRow = (label, key, min, max, step, value, unit = '') => `
    <div class="prop-row fx-slider"><label>${label}</label>
      <input type="range" class="prop-range" min="${min}" max="${max}" step="${step}" value="${value}" data-ly-prop="${key}" data-default="${DEFAULTS_BY_KEY[key] ?? value}">
      <span class="fx-val" data-unit="${unit}">${value}${unit}</span></div>`;
  const DEFAULTS_BY_KEY = { angle: 135, cx: 50, cy: 50, strokeWidth: 0, w: 60, h: 30, radius: 8, strength: 70, size: 40, seed: 3, ratio: 2.39 };

  function renderProps(clip, tmpl) {
    const L = tmpl?.layer;
    if (!clip || !L || !isEditable(L.kind)) return '';
    let body = '';
    if (L.kind === 'solid') body = colorRow('Cor', 'color', hex(L.color, '#82ea00'));
    if (L.kind === 'gradient') {
      body = `
        <div class="prop-row"><label>Tipo</label><select class="prop-input" data-ly-prop="type"><option value="linear"${L.type !== 'radial' ? ' selected' : ''}>Linear</option><option value="radial"${L.type === 'radial' ? ' selected' : ''}>Radial</option></select></div>
        ${colorRow('Cor inicial', 'color1', hex(L.color1, '#7c3aed'))}
        ${colorRow('Cor final', 'color2', hex(L.color2, '#22d3ee'))}
        ${L.type === 'radial'
          ? sliderRow('Centro X', 'cx', 0, 100, 1, Math.round(L.cx ?? 50), '%') + sliderRow('Centro Y', 'cy', 0, 100, 1, Math.round(L.cy ?? 50), '%')
          : sliderRow('Ângulo', 'angle', 0, 360, 1, Math.round(L.angle ?? 135), '°')}`;
    }
    if (L.kind === 'shape') {
      body = `
        <div class="prop-row"><label>Forma</label><select class="prop-input" data-ly-prop="shape"><option value="rect"${L.shape !== 'ellipse' ? ' selected' : ''}>Retângulo</option><option value="ellipse"${L.shape === 'ellipse' ? ' selected' : ''}>Elipse</option></select></div>
        ${colorRow('Preenchimento', 'fill', hex(L.fill, '#82ea00'))}
        ${colorRow('Traço', 'stroke', hex(L.stroke, '#ffffff'))}
        ${sliderRow('Espessura', 'strokeWidth', 0, 80, 1, Math.round(L.strokeWidth ?? 0), ' px')}
        ${sliderRow('Largura', 'w', 1, 100, 1, Math.round(L.w ?? 60), '%')}
        ${sliderRow('Altura', 'h', 1, 100, 1, Math.round(L.h ?? 30), '%')}
        ${L.shape !== 'ellipse' ? sliderRow('Cantos', 'radius', 0, 50, 1, Math.round(L.radius ?? 8), '%') : ''}`;
    }
    if (L.kind === 'vignette') {
      body = `${colorRow('Cor', 'color', hex(L.color, '#000000'))}${sliderRow('Intensidade', 'strength', 0, 100, 1, Math.round(L.strength ?? 70), '%')}${sliderRow('Tamanho', 'size', 0, 100, 1, Math.round(L.size ?? 40), '%')}`;
    }
    if (L.kind === 'grain') {
      body = `${sliderRow('Intensidade', 'strength', 0, 100, 1, Math.round(L.strength ?? 55), '%')}${sliderRow('Finura', 'size', 0, 100, 1, Math.round(L.size ?? 50), '%')}${sliderRow('Variação', 'seed', 0, 99, 1, Math.round(L.seed ?? 3))}<p class="fx-hint">Dica: use a mesclagem <b>Sobrepor</b> e pouca opacidade.</p>`;
    }
    if (L.kind === 'bars') {
      body = `${colorRow('Cor', 'color', hex(L.color, '#000000'))}
        <div class="prop-row"><label>Proporção</label><select class="prop-input" data-ly-prop="ratio">${[['2.39', '2,39:1 (cinema)'], ['2', '2:1'], ['1.85', '1,85:1'], ['1.5', '3:2'], ['1.78', '16:9']].map(([v, l]) => `<option value="${v}"${Math.abs(Number(L.ratio) - Number(v)) < 0.01 ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
    }
    return `<div class="prop-section ly-props" data-clip-id="${esc(clip.id)}"><div class="prop-title">${esc(NAMES[L.kind])}</div>${body}</div>`;
  }

  /** Atualiza a camada com os novos parâmetros (copy-on-write) e a imagem no preview */
  function updateLayer(clip, patch, { undo = true, rerender = false } = {}) {
    const tmpl = st().templates.find(t => t.id === clip.templateId);
    if (!tmpl?.layer) return;
    if (undo) pushUndo();
    tmpl.layer = { ...tmpl.layer, ...patch };
    tmpl.dataUrl = dataUrlFor(tmpl.layer, st().project.res);
    const color = clipColor(tmpl.layer);
    tmpl.color = color;
    clip.color = color;
    const entry = window.__Compositor?.get(clip.id);
    if (entry?.iframe) entry.iframe.src = tmpl.dataUrl;
    if (typeof refreshClipBlock === 'function') refreshClipBlock(clip.id);
    window.__syncCompositorToTime?.(st().time);
    if (rerender) window.__renderProps?.();
  }

  let armed = false;
  function initPanelEvents() {
    const props = document.getElementById('propsContent');
    if (!props) return;
    const clipOf = el => st().clips.find(c => c.id === el.closest('.ly-props')?.dataset.clipId);
    const valueOf = ctl => (ctl.type === 'range' || ctl.type === 'number' ? Number(ctl.value) : ctl.value);

    props.addEventListener('input', e => {
      const ctl = e.target.closest('.ly-props [data-ly-prop], .ly-props [data-ly-prop-hex]');
      const clip = ctl && clipOf(ctl);
      if (!clip) return;
      if (ctl.dataset.lyPropHex) {
        if (!/^#[0-9a-f]{6}$/i.test(ctl.value)) return;
        const picker = ctl.parentElement.querySelector('[data-ly-prop]');
        picker.value = ctl.value;
        updateLayer(clip, { [ctl.dataset.lyPropHex]: ctl.value }, { undo: !armed });
        armed = true;
        return;
      }
      if (ctl.tagName === 'SELECT') return;   // tratado no change (refaz o painel)
      updateLayer(clip, { [ctl.dataset.lyProp]: valueOf(ctl) }, { undo: !armed });
      armed = true;
      const hexBox = ctl.parentElement.querySelector('[data-ly-prop-hex]');
      if (hexBox) hexBox.value = ctl.value;
      const label = ctl.parentElement.querySelector('.fx-val');
      if (label) label.textContent = `${ctl.value}${label.dataset.unit || ''}`;
    });
    props.addEventListener('change', e => {
      const ctl = e.target.closest('.ly-props [data-ly-prop]');
      const clip = ctl && clipOf(ctl);
      if (!clip) return;
      if (ctl.tagName === 'SELECT') updateLayer(clip, { [ctl.dataset.lyProp]: ctl.value === '' ? ctl.value : (isNaN(Number(ctl.value)) ? ctl.value : Number(ctl.value)) }, { undo: true, rerender: true });
      armed = false;
    });

    // Mesclagem (Efeitos › Mesclagem)
    props.addEventListener('change', e => {
      const sel = e.target.closest('[data-blend]');
      if (!sel) return;
      const clip = st().clips.find(c => c.id === sel.closest('[data-clip-id]')?.dataset.clipId);
      if (clip) setBlend([clip], sel.value);
    });
  }
  // #endregion

  // #region Menu de contexto da timeline ("Nova camada")
  let menu = null;
  const closeMenu = () => { document.querySelectorAll('.ly-menu').forEach(m => m.remove()); menu = null; };
  const ICON = (d, extra = '') => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const ICONS = {
    solid: ICON('<rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" fill-opacity=".35"/>'),
    gradient: ICON('<defs><linearGradient id="mg" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".1"/><stop offset="1" stop-color="currentColor"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="2" fill="url(#mg)"/>'),
    adjustment: ICON('<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" fill-opacity=".4"/>'),
    shape: ICON('<rect x="3" y="9" width="11" height="11" rx="1"/><circle cx="16" cy="8" r="5"/>'),
    camera: ICON('<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
    fxi: ICON('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'),
    text: ICON('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  };

  function menuModel(at) {
    const hasClip = Boolean(window.__hasClipClipboard?.());
    return [
      { head: 'Nova camada' },
      { id: 'solid', icon: ICONS.solid, label: 'Sólido…', run: () => createWithDialog('solid', at) },
      { id: 'gradient', icon: ICONS.gradient, label: 'Gradiente…', run: () => createWithDialog('gradient', at) },
      { id: 'adjustment', icon: ICONS.adjustment, label: 'Camada de ajuste', hint: 'filtra tudo abaixo', run: () => addLayer('adjustment', { start: at.t, track: at.track }) },
      { id: 'shape', icon: ICONS.shape, label: 'Forma', sub: [
        { label: 'Retângulo', run: () => addLayer('shape', { start: at.t, track: at.track, params: { shape: 'rect' }, name: 'Retângulo' }) },
        { label: 'Elipse', run: () => addLayer('shape', { start: at.t, track: at.track, params: { shape: 'ellipse', w: 40, h: 22 }, name: 'Elipse' }) },
      ] },
      { id: 'camera', icon: ICONS.camera, label: 'Câmera 2D', hint: 'move o que está abaixo', run: () => addLayer('camera', { start: at.t, track: at.track }) },
      { id: 'fxi', icon: ICONS.fxi, label: 'Efeitos de imagem', sub: [
        { label: 'Vinheta', run: () => addLayer('vignette', { start: at.t, track: at.track }) },
        { label: 'Grão de filme', run: () => addLayer('grain', { start: at.t, track: at.track, blend: 'overlay' }) },
        { label: 'Barras de cinema', run: () => addLayer('bars', { start: at.t, track: at.track }) },
      ] },
      { id: 'text', icon: ICONS.text, label: 'Texto', run: () => addText(at) },
      { sep: true },
      { label: 'Colar aqui', disabled: !hasClip, run: () => { window.seekTo?.(at.t); window.__runTimelineAction?.('paste'); } },
      { label: 'Colar clipe HTML', hint: 'da área de transferência', run: () => pasteHtmlAt(at) },
      { label: 'Selecionar todos', run: () => window.__runTimelineAction?.('selectAll') },
      { label: 'Adicionar marcador aqui', run: () => { window.__tlPushUndo?.(); window.MSMarkers?.add({ t: at.t }); window.MSMarkers?.render(); } },
      { label: 'Adicionar track', run: () => window.__runTimelineAction?.('addTrack') },
      { label: 'Ajustar a timeline à tela', run: () => window.__runTimelineAction?.('zoomFit') },
    ];
  }

  /**
   * HTML da área de transferência vira clip no ponto/track clicados. Sem HTML
   * (ou sem permissão de leitura) abre o modal de colar já com a posição.
   */
  async function pasteHtmlAt(at) {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (_) { /* sem permissão: o modal recebe o Ctrl+V */ }
    const where = { at: at.t, trackIndex: at.track };
    if (!window.isHtmlSource?.(text)) return window.openPasteHtmlModal?.(where);
    const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(text) || [])[1]?.replace(/[\/:*?"<>|]+/g, '-').trim();
    const ids = await window.loadScenes?.([{ type: 'html', name: `${title || 'Clip HTML'}.html`, html: text }], where);
    if (ids?.length) window.MSUI.toast({ message: 'Clipe HTML colado na timeline.', kind: 'info' });
  }

  function addText(at) {
    const reg = window.__TextRegistry;
    const tmpl = reg?.getById('txt_kinetic_bold') || reg?.getAll()[0];
    if (!tmpl || typeof addTextClipFromTemplate !== 'function') return window.MSUI.toast({ message: 'Os modelos de texto ainda não carregaram.', kind: 'warn' });
    addTextClipFromTemplate(tmpl, { at: at.t, ...(at.track != null ? { trackIndex: at.track } : {}), undo: true });
  }

  function renderMenu(items, parent, x, y) {
    const el = document.createElement('div');
    el.className = 'ctx-menu ly-menu';
    el.style.cssText = `display:block;visibility:hidden;left:${x}px;top:${y}px`;
    el.innerHTML = items.map((it, i) => {
      if (it.sep) return '<div class="ctx-divider"></div>';
      if (it.head) return `<div class="ly-head">${esc(it.head)}</div>`;
      return `<div class="ctx-item ly-item${it.disabled ? ' disabled' : ''}${it.sub ? ' has-sub' : ''}" data-i="${i}">
        ${it.icon || '<span class="ly-noicon"></span>'}<span class="ly-label">${esc(it.label)}</span>${it.hint ? `<span class="ctx-shortcut">${esc(it.hint)}</span>` : ''}${it.sub ? '<span class="ly-arrow">▸</span>' : ''}
      </div>`;
    }).join('');
    document.body.appendChild(el);
    // cabe na janela
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - w - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(y, window.innerHeight - h - 6))}px`;
    el.style.visibility = 'visible';

    let subEl = null;
    const closeSub = () => { subEl?.remove(); subEl = null; };
    el.addEventListener('mouseover', e => {
      const row = e.target.closest('.ly-item');
      if (!row) return;
      const it = items[Number(row.dataset.i)];
      if (!it?.sub) { if (!e.target.closest('.ly-menu.ly-sub')) closeSub(); return; }
      if (subEl && subEl._for === row) return;
      closeSub();
      const r = row.getBoundingClientRect();
      subEl = renderMenu(it.sub.map(s => ({ ...s, icon: null })), el, r.right - 2, r.top - 4);
      subEl.classList.add('ly-sub');
      subEl._for = row;
    });
    el.addEventListener('click', e => {
      const row = e.target.closest('.ly-item');
      if (!row || row.classList.contains('disabled')) return;
      const it = items[Number(row.dataset.i)];
      if (!it || it.sub) return;
      closeMenu();
      try { it.run?.(); } catch (err) { console.error('[Camadas]', err); window.MSUI.toast({ message: 'Não foi possível criar a camada.', kind: 'error' }); }
    });
    return el;
  }

  function openMenu(e) {
    closeMenu();
    const scroll = document.getElementById('tlScroll');
    const r = scroll.getBoundingClientRect();
    const pps = (window.__PX_PER_SEC || 80) * (st().zoom || 1);
    const t = snapT((e.clientX - r.left + scroll.scrollLeft) / pps);
    const row = e.target.closest('.tl-row[data-track]');
    const at = { t, track: row ? Number(row.dataset.track) : null };
    menu = renderMenu(menuModel(at), null, e.clientX, e.clientY);
    // mostra o submenu aberto junto e fecha ao clicar fora / Esc
    const off = ev => {
      if (menu && !ev.target.closest('.ly-menu')) { closeMenu(); document.removeEventListener('mousedown', off, true); }
    };
    setTimeout(() => document.addEventListener('mousedown', off, true), 0);
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { closeMenu(); document.removeEventListener('keydown', esc); } });
  }

  function initTimelineMenu() {
    const scroll = document.getElementById('tlScroll');
    if (!scroll) return;
    scroll.addEventListener('contextmenu', e => {
      if (!st().project) return;
      if (e.target.closest('.tl-block, #tlRuler, .tl-mk, .tl-mk-region, .tl-mk-menu, .tl-mk-pop')) return;
      e.preventDefault();
      openMenu(e);
    });
  }
  // #endregion

  // #region Menu de contexto do clip: modo de mesclagem
  function initClipMenu() {
    const menuEl = document.getElementById('clipContextMenu');
    if (!menuEl) return;
    const item = document.createElement('div');
    item.className = 'ctx-item ly-blend-item';
    item.id = 'ctxBlend';
    item.innerHTML = `${ICON('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>')}<span class="ly-label">Modo de mesclagem</span><span class="ly-arrow">▸</span>`;
    const divider = menuEl.querySelector('.ctx-divider');
    menuEl.insertBefore(item, divider);
    let sub = null;
    const closeSub = () => { sub?.remove(); sub = null; };

    item.addEventListener('mouseenter', () => {
      closeSub();
      const clips = selectedClips();
      const current = clips.length ? blendOf(clips[0]) : 'normal';
      const r = item.getBoundingClientRect();
      const entries = Object.entries(window.ClipFX?.BLENDS || {});
      sub = renderMenu(entries.map(([id, label]) => ({ label: `${id === current ? '✓ ' : ''}${label}`, run: () => setBlend(selectedClips(), id) })), null, r.right - 2, r.top - 4);
      sub.classList.add('ly-sub');
      sub.addEventListener('click', () => { closeSub(); menuEl.style.display = 'none'; });
    });
    menuEl.addEventListener('mouseleave', e => { if (!e.relatedTarget?.closest?.('.ly-sub')) closeSub(); });

    // Câmera 2D: atalho para o planejamento com IA
    const camItem = document.createElement('div');
    camItem.className = 'ctx-item';
    camItem.id = 'ctxCameraAI';
    camItem.innerHTML = `${ICONS.camera}<span class="ly-label">Câmera com IA…</span>`;
    menuEl.insertBefore(camItem, item);
    camItem.addEventListener('click', () => {
      const cam = selectedClips().find(c => window.ClipKF?.isCamera(c));
      menuEl.style.display = 'none';
      if (cam) window.MSCameraAI?.open(cam.id);
    });

    // Velocidade de HTML, vídeo e áudio (clip-speed.js)
    const speedItem = document.createElement('div');
    speedItem.className = 'ctx-item ly-blend-item';
    speedItem.id = 'ctxSpeed';
    speedItem.innerHTML = `${ICON('<circle cx="12" cy="13" r="8"/><path d="M12 13l3.5-3.5M9 2h6"/>')}<span class="ly-label">Tempo de animação</span><span class="ly-arrow">▸</span>`;
    menuEl.insertBefore(speedItem, item);
    const speedIds = () => selectedClips().filter(c => window.MSClipSpeed?.kindOf(c)).map(c => c.id);
    speedItem.addEventListener('mouseenter', () => {
      closeSub();
      if (menuEl.style.display === 'none') return;
      const r = speedItem.getBoundingClientRect();
      sub = renderMenu(window.MSClipSpeed.menuItems(speedIds()), null, r.right - 2, r.top - 4);
      sub.classList.add('ly-sub');
      sub.addEventListener('click', () => { closeSub(); menuEl.style.display = 'none'; });
    });
    speedItem.addEventListener('click', () => { closeSub(); menuEl.style.display = 'none'; window.MSClipSpeed?.askCustom(speedIds()); });
    // Os outros itens fecham o submenu ao passar o mouse
    menuEl.addEventListener('mouseover', e => {
      const row = e.target.closest('.ctx-item');
      if (row && row !== item && row !== speedItem) closeSub();
    });

    // Só para clips que não são áudio: acompanha a abertura do menu
    new MutationObserver(() => {
      if (menuEl.style.display === 'none') { closeSub(); return; }
      const clips = selectedClips();
      item.style.display = clips.some(c => st().templates.find(t => t.id === c.templateId)?.type !== 'audio') ? '' : 'none';
      camItem.style.display = clips.some(c => window.ClipKF?.isCamera(c)) ? '' : 'none';
      speedItem.style.display = clips.some(c => window.MSClipSpeed?.kindOf(c)) ? '' : 'none';
    }).observe(menuEl, { attributes: true, attributeFilter: ['style'] });
  }
  // #endregion

  // #region Comandos (paleta Ctrl+K)
  function registerCommands() {
    const R = window.MSCmd?.register;
    if (!R) return;
    const has = () => Boolean(st().project);
    const here = () => ({ t: st().time, track: null });
    R({ id: 'layer-solid', title: 'Nova camada: Sólido…', group: 'Efeitos e IA', keywords: 'preenchimento cor fundo', when: has, run: () => createWithDialog('solid', here()) });
    R({ id: 'layer-gradient', title: 'Nova camada: Gradiente…', group: 'Efeitos e IA', when: has, run: () => createWithDialog('gradient', here()) });
    R({ id: 'layer-adjustment', title: 'Nova camada: Camada de ajuste', group: 'Efeitos e IA', keywords: 'filtro corrigir', when: has, run: () => addLayer('adjustment', {}) });
    R({ id: 'layer-rect', title: 'Nova camada: Forma retângulo', group: 'Efeitos e IA', when: has, run: () => addLayer('shape', { params: { shape: 'rect' }, name: 'Retângulo' }) });
    R({ id: 'layer-ellipse', title: 'Nova camada: Forma elipse', group: 'Efeitos e IA', keywords: 'circulo', when: has, run: () => addLayer('shape', { params: { shape: 'ellipse', w: 40, h: 22 }, name: 'Elipse' }) });
    R({ id: 'layer-vignette', title: 'Nova camada: Vinheta', group: 'Efeitos e IA', when: has, run: () => addLayer('vignette', {}) });
    R({ id: 'layer-grain', title: 'Nova camada: Grão de filme', group: 'Efeitos e IA', keywords: 'ruido textura', when: has, run: () => addLayer('grain', { blend: 'overlay' }) });
    R({ id: 'layer-bars', title: 'Nova camada: Barras de cinema', group: 'Efeitos e IA', keywords: 'letterbox', when: has, run: () => addLayer('bars', {}) });
    R({ id: 'layer-camera', title: 'Nova camada: Câmera 2D', group: 'Efeitos e IA', keywords: 'camera pan zoom', when: has, run: () => addLayer('camera', {}) });
  }
  // #endregion

  window.MSLayers = { addLayer, setBlend, svgFor, dataUrlFor, exportHtml, renderProps, updateLayer, createWithDialog, NAMES, DEFAULTS };
  window.__renderLayerProps = renderProps;

  function boot() {
    initPanelEvents();
    initTimelineMenu();
    initClipMenu();
    registerCommands();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
