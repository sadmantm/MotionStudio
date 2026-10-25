// text-templates/texts.js
function buildTextClipHtml(
  params,
  res
) {
  const {
    text = 'Texto',
    fontFamily =
      'Inter, sans-serif',
    fontSize = 80,
    fontWeight = '700',
    color = '#ffffff',
    align = 'center',
    bg = 'transparent',
    duration = 4,
    animation = 'fadeIn',
  } = params || {};

  const width =
    Math.max(
      1,
      Number(res?.w) || 1080
    );

  const height =
    Math.max(
      1,
      Number(res?.h) || 1920
    );

  const clipDuration =
    Math.max(
      0.001,
      Number(duration) || 4
    );

  const selectedAnimation =
    [
      'fadeIn',
      'slideUp',
      'slideLeft',
    ].includes(animation)
      ? animation
      : 'fadeIn';

  const textAlign =
    [
      'left',
      'center',
      'right',
      'justify',
    ].includes(align)
      ? align
      : 'center';

  const background =
    sanitizeTextCss(
      bg,
      'transparent'
    );

  const safeFamily =
    sanitizeTextCss(
      fontFamily,
      'Inter, sans-serif'
    );

  const safeWeight =
    sanitizeTextCss(
      fontWeight,
      '700'
    );

  const safeColor =
    sanitizeTextCss(
      color,
      '#ffffff'
    );

  const safeSize =
    Math.max(
      1,
      Number(fontSize) || 80
    );

  const textHtml =
    escapeTextHtml(text)
      .replace(
        /\r?\n/g,
        '<br>'
      );

  let containerStyle = '';
  let baseTransform = '';

  if (
    selectedAnimation ===
    'slideLeft'
  ) {
    containerStyle =
      `position:absolute;` +
      `bottom:160px;` +
      `left:0;right:0;` +
      `padding:22px 60px;` +
      `background:${background};` +
      `text-align:${textAlign};`;
  } else if (
    selectedAnimation ===
      'fadeIn' &&
    background !==
      'transparent' &&
    background !== ''
  ) {
    containerStyle =
      `position:absolute;` +
      `bottom:100px;` +
      `left:40px;right:40px;` +
      `padding:16px 28px;` +
      `background:${background};` +
      `border-radius:10px;` +
      `text-align:${textAlign};`;
  } else {
    containerStyle =
      `position:absolute;` +
      `top:50%;left:50%;` +
      `width:90%;` +
      `text-align:${textAlign};`;

    baseTransform =
      'translate(-50%, -50%)';
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html,
body {
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: transparent;
}

#__txt_el {
  ${containerStyle}
  font-family: ${safeFamily};
  font-size: ${safeSize}px;
  font-weight: ${safeWeight};
  color: ${safeColor};
  line-height: 1.2;
  opacity: 0;
  will-change: opacity, transform;
}
</style>
</head>
<body>
<div id="__txt_el">${textHtml}</div>

<script>
(function () {
  'use strict';

  const element =
    document.getElementById(
      '__txt_el'
    );

  const ANIMATION =
    ${JSON.stringify(
      selectedAnimation
    )};

  const BASE_TRANSFORM =
    ${JSON.stringify(
      baseTransform
    )};

  let DURATION =
    ${JSON.stringify(
      clipDuration
    )};

  let animationIn = 0;
  let animationOut = 0;

  function clamp(
    value,
    minimum,
    maximum
  ) {
    return Math.max(
      minimum,
      Math.min(maximum, value)
    );
  }

  function easeOut(value) {
    const progress =
      clamp(value, 0, 1);

    return 1 -
      Math.pow(
        1 - progress,
        3
      );
  }

  function recalculate() {
    animationIn =
      Math.min(
        0.6,
        DURATION * 0.15
      );

    animationOut =
      Math.min(
        0.5,
        DURATION * 0.12
      );
  }

  function reportSize() {
    const rect =
      element
        .getBoundingClientRect();

    if (
      rect.width < 1 ||
      rect.height < 1
    ) {
      return;
    }

    const clipId =
      window.__clipId_injected ||
      null;

    window.top?.postMessage(
      {
        type:
          '__TEXT_SIZE',

        __clipId:
          clipId,

        clipId,

        x:
          rect.left,

        y:
          rect.top,

        w:
          rect.width,

        h:
          rect.height,
      },
      '*'
    );
  }

  function seek(time) {
    const currentTime =
      clamp(
        Number(time) || 0,
        0,
        DURATION
      );

    let opacity = 1;
    let extraTransform = '';

    if (currentTime <= 0) {
      opacity = 0;
    } else if (
      currentTime <
      animationIn
    ) {
      const progress =
        easeOut(
          currentTime /
          Math.max(
            0.001,
            animationIn
          )
        );

      opacity = progress;

      if (
        ANIMATION ===
        'slideUp'
      ) {
        extraTransform =
          ' translateY(' +
          ((1 - progress) * 60) +
          'px)';
      } else if (
        ANIMATION ===
        'slideLeft'
      ) {
        extraTransform =
          ' translateX(' +
          ((1 - progress) * -80) +
          'px)';
      }
    } else if (
      currentTime >
      DURATION -
        animationOut
    ) {
      opacity =
        1 -
        clamp(
          (
            currentTime -
            (
              DURATION -
              animationOut
            )
          ) /
          Math.max(
            0.001,
            animationOut
          ),
          0,
          1
        );
    }

    element.style.opacity =
      String(opacity);

    element.style.transform =
      (
        BASE_TRANSFORM +
        extraTransform
      ).trim();
  }

  recalculate();

  window.Motion = {
    config: {
      get durationInSeconds() {
        return DURATION;
      },

      fps:
        30,
    },

    whenReady() {
      const fontsReady =
        document.fonts?.ready ||
        Promise.resolve();

      const timeout =
        new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500
            )
        );

      return Promise.race([
        fontsReady,
        timeout,
      ]);
    },

    setDuration(value) {
      const nextDuration =
        Number(value);

      if (!(nextDuration > 0)) {
        return;
      }

      DURATION =
        nextDuration;

      recalculate();
      seek(0);
    },

    seek,
  };

  seek(0);

  window.Motion
    .whenReady()
    .then(() => {
      reportSize();

      requestAnimationFrame(
        reportSize
      );
    });
})();
<\/script>
</body>
</html>`;
}

function renderTextPanel() {
  const tab = document.getElementById('tabtext');
  if (!tab) return;

  const templates = window.__TextRegistry.getAll();

  const categories = {};
  templates.forEach(tmpl => {
    const cat = tmpl.category || 'Geral';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(tmpl);
  });

  tab.innerHTML = '';

  if (!templates.length) {
    tab.innerHTML = `<div class="text-panel-empty">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.2">
        <path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>
      </svg>
      <span>Nenhum template registrado</span>
    </div>`;
    return;
  }

  Object.entries(categories).forEach(([cat, tmpls]) => {
    const section = document.createElement('div');
    section.innerHTML = `<div class="text-tmpl-section">${cat}</div>`;

    const grid = document.createElement('div');
    grid.className = 'text-tmpl-visual-grid';
    tmpls.forEach(tmpl => grid.appendChild(_buildTextPreviewCard(tmpl)));

    section.appendChild(grid);
    tab.appendChild(section);
  });
}

function _buildTextPreviewCard(tmpl) {
  const card        = document.createElement('div');
  card.className    = 'text-preview-card';
  card.draggable    = true;
  card.dataset.tmplId = tmpl.id;
  card.title        = tmpl.name;

  const res    = window.__appState?.project?.res || { w: 1080, h: 1920 };
  const CARD_W = 120;
  const CARD_H = Math.round(CARD_W * (res.h / res.w));
  const scale  = CARD_W / res.w;

  const previewWrap = document.createElement('div');
  previewWrap.className = 'text-preview-wrap';
  Object.assign(previewWrap.style, {
    width: CARD_W + 'px', height: CARD_H + 'px',
    position: 'relative', overflow: 'hidden', flexShrink: '0',
  });

  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts allow-same-origin';
  iframe.style.cssText = `position:absolute;border:none;pointer-events:none;top:0;left:0;width:${res.w}px;height:${res.h}px;transform-origin:top left;transform:scale(${scale})`;
  previewWrap.appendChild(iframe);

  const info = document.createElement('div');
  info.className = 'text-preview-info';
  info.innerHTML = `
    <span class="text-preview-name">${tmpl.name}</span>
    <button class="text-preview-add" title="Adicionar à timeline">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>`;

  card.appendChild(previewWrap);
  card.appendChild(info);

  let _raf = null, _clock = 0, _playing = false, _loaded = false;

  function _loadPreview() {
    iframe.srcdoc = window.__TextRegistry.buildHtml(tmpl.id, tmpl.defaults, res);
  }

  iframe.addEventListener('load', () => {
    _loaded = true;
    try { iframe.contentWindow?.Motion?.seek(0); } catch(_) {}
  });

  card.addEventListener('mouseenter', () => {
    if (!_loaded) return;
    _clock = 0; _playing = true;
    let last = null;
    const dur = tmpl.defaults?.duration || 4;
    function tick(ts) {
      if (!_playing) return;
      if (last != null) _clock += (ts - last) / 1000;
      last = ts;
      if (_clock > dur) _clock = 0;
      try { iframe.contentWindow?.Motion?.seek(_clock); } catch(_) {}
      _raf = requestAnimationFrame(tick);
    }
    _raf = requestAnimationFrame(tick);
  });

  card.addEventListener('mouseleave', () => {
    _playing = false;
    cancelAnimationFrame(_raf);
    _clock = 0;
    try { iframe.contentWindow?.Motion?.seek(0); } catch(_) {}
  });

  info.querySelector('.text-preview-add').addEventListener('click', e => {
    e.stopPropagation();
    addTextClipFromTemplate(tmpl);
  });

  card.addEventListener('dblclick', () => addTextClipFromTemplate(tmpl));

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/x-mstudio-tmpl', tmpl.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  _loadPreview();
  return card;
}

function addTextClipFromTemplate(tmpl) {
  if (!state.project) return;

  if (typeof tmpl === 'string') {
    tmpl = window.__TextRegistry.getById(tmpl);
    if (!tmpl) return;
  }

  const res    = state.project.res;
  const params = { ...tmpl.defaults };
  const html   = window.__TextRegistry.buildHtml(tmpl.id, params, res);
  const dur    = params.duration || 4;

  const insertAt = state.clips.length
    ? Math.max(...state.clips.map(c => c.start + c.duration))
    : state.time;

  const templateId = mkId();
  const clipId     = mkId();

  state.templates.push({
    id:             templateId,
    type:           'text',
    html,
    textParams:     { ...params },
    textTmplId:     tmpl.id,
    sourceDuration: dur,
    fps:            30,
    label:          tmpl.name,
    color:          SCENE_COLORS[state.clips.length % SCENE_COLORS.length],
  });

  const newClip = normalizeClip({
    id:         clipId,
    templateId,
    label:      tmpl.name,
    start:      insertAt,
    duration:   dur,
    trimStart:  0,
    trimEnd:    dur,
    trackIndex: 0,
    color:      SCENE_COLORS[state.clips.length % SCENE_COLORS.length],
    _tx:        { x: 0, y: 0, w: res.w, h: res.h, r: 0 },
    isText:     true,
  });

  state.clips.push(newClip);

  recalcProjectDuration?.();
  syncProjectGlobals?.();
  renderSceneList?.();
  renderTimeline?.();
  window.mountAllClips?.();
  selectClip?.(clipId);

  document.getElementById('emptyState').style.display       = 'none';
  document.getElementById('previewContainer').style.display = '';
  syncPreviewSize?.();
}

function escapeTextHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeTextCss(
  value,
  fallback = ''
) {
  const sanitized =
    String(value ?? fallback)
      .replace(/[;{}<>]/g, '')
      .trim();

  return sanitized || fallback;
}
window.renderTextClipProps = function renderTextClipProps(clip) {
  const propsContent = document.getElementById('propsContent');
  if (!propsContent) return;

  const tmpl = state.templates.find(t => t.id === clip.templateId);
  if (!tmpl?.textParams) return;

  const p = tmpl.textParams;

  // Campos editáveis declarados — facilita leitura e adição futura
  const fontFamilies = [
    ['Inter, sans-serif',          'Inter'],
    ['Georgia, serif',             'Georgia'],
    ["'Courier New', monospace",   'Courier New'],
    ['Impact, sans-serif',         'Impact'],
    ['Arial Black, sans-serif',    'Arial Black'],
  ];

  // Fonte atual fora da lista (ex.: "'Montserrat', sans-serif" dos templates)
  // entra como opção — senão o <select> cai na 1ª opção e troca a fonte
  // silenciosamente ao editar qualquer outro campo.
  if (p.fontFamily && !fontFamilies.some(([v]) => v === p.fontFamily)) {
    fontFamilies.unshift([p.fontFamily, String(p.fontFamily).split(',')[0].replace(/['"]/g, '').trim() || p.fontFamily]);
  }

  // Campos específicos de alguns templates (ex.: legendas palavra a palavra)
  const tmplDefaults = window.__TextRegistry?.getById(tmpl.textTmplId)?.defaults || {};
  const hasHighlight = Object.prototype.hasOwnProperty.call(tmplDefaults, 'highlightColor');
  const highlightColor = sanitizeTextCss(p.highlightColor ?? tmplDefaults.highlightColor, '#82ea00');

  const animations = [
    ['fadeIn',    'Fade In'],
    ['slideUp',   'Slide Up'],
    ['slideLeft', 'Slide Left'],
  ];

  propsContent.innerHTML = `
    <div class="prop-section">
      <div class="prop-title">Clip</div>
      <div class="prop-row">
        <label>Nome</label>
        <input class="prop-input" id="tp_label" value="${escapeHtml(clip.label)}">
      </div>
      <div class="prop-row">
        <label>Início</label>
        <span class="prop-val">${fmtTime(clip.start)}</span>
      </div>
      <div class="prop-row">
        <label>Duração</label>
        <input class="prop-input" id="tp_dur" type="number" step="0.5" min="0.5" max="3600" value="${clip.duration.toFixed(2)}">
      </div>
      <div class="prop-row">
        <label>Cor</label>
        <input type="color" class="prop-color" id="tp_clip_color" value="${clip.color}">
      </div>
    </div>

    <div class="prop-section">
      <div class="prop-title">Conteúdo</div>
      <div class="prop-row">
        <textarea id="tp_text" class="text-prop-textarea" rows="3">${escapeTextHtml(p.text)}</textarea>
      </div>
    </div>

    <div class="prop-section">
      <div class="prop-title">Tipografia</div>
      <div class="prop-row">
        <label>Família</label>
        <select id="tp_family" class="prop-input" style="flex:1">
          ${fontFamilies.map(([v, l]) => `<option value="${escapeTextHtml(v)}" ${p.fontFamily === v ? 'selected' : ''}>${escapeTextHtml(l)}</option>`).join('')}
        </select>
      </div>
      <div class="prop-row">
        <label>Tamanho</label>
        <input id="tp_size" type="number" class="prop-input" style="width:64px" value="${p.fontSize}" min="8" max="400" step="2">
      </div>
      <div class="prop-row">
        <label>Peso</label>
        <select id="tp_weight" class="prop-input" style="flex:1">
          ${['300','400','500','600','700','800','900'].map(w =>
            `<option value="${w}" ${p.fontWeight === w ? 'selected' : ''}>${w}</option>`
          ).join('')}
        </select>
      </div>
      <div class="prop-row">
        <label>Cor</label>
        <input id="tp_color" type="color" class="prop-color" value="${p.color}">
        <input id="tp_color_hex" type="text" class="prop-input" value="${p.color}" maxlength="9" style="flex:1">
      </div>
      <div class="prop-row">
        <label>Alinha.</label>
        <select id="tp_align" class="prop-input" style="flex:1">
          ${['left','center','right'].map(a =>
            `<option value="${a}" ${p.align === a ? 'selected' : ''}>${a}</option>`
          ).join('')}
        </select>
      </div>
      ${hasHighlight ? `
      <div class="prop-row">
        <label>Destaque</label>
        <input id="tp_hl" type="color" class="prop-color" value="${escapeTextHtml(/^#[0-9a-f]{6}/i.test(highlightColor) ? highlightColor.slice(0, 7) : '#82ea00')}">
        <input id="tp_hl_hex" type="text" class="prop-input" value="${escapeTextHtml(highlightColor)}" maxlength="32" style="flex:1">
      </div>` : ''}
    </div>

    <div class="prop-section">
      <div class="prop-title">Fundo</div>
      <div class="prop-row">
        <label>Cor/CSS</label>
        <input id="tp_bg" type="color" class="prop-color" value="${p.bg && p.bg !== 'transparent' ? p.bg.slice(0,7) : '#000000'}">
        <input id="tp_bg_hex" type="text" class="prop-input" value="${p.bg}" maxlength="32" style="flex:1" placeholder="transparent">
      </div>
    </div>

    <div class="prop-section">
      <div class="prop-title">Animação</div>
      <div class="prop-row">
        <label>Tipo</label>
        <select id="tp_anim" class="prop-input" style="flex:1">
          ${animations.map(([v, l]) =>
            `<option value="${v}" ${p.animation === v ? 'selected' : ''}>${l}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="prop-section">
      <div class="prop-row prop-row-btn">
        <button class="btn-danger" onclick="window.deleteClip('${clip.id}')">🗑 Remover clip</button>
      </div>
    </div>
  `;

  // ── Sync color pickers ↔ hex ─────────────────────────────
  const colorPairs = [
    ['tp_color', 'tp_color_hex'],
    ['tp_bg',    'tp_bg_hex'],
  ];
  colorPairs.forEach(([pickerId, hexId]) => {
    const picker = document.getElementById(pickerId);
    const hex    = document.getElementById(hexId);
    picker?.addEventListener('input', e => { hex.value = e.target.value; _applyLive(); });
    hex?.addEventListener('input', e => {
      if (/^#[0-9a-f]{3,8}$/i.test(e.target.value))
        picker.value = e.target.value.slice(0, 7);
      _applyLiveSoon();   // hex é texto digitado → debounce
    });
  });

  // ── Live update ao mudar qualquer campo ──────────────────
  // ── Conteúdo + tamanho digitados: preview AO VIVO no DOM (sem remount → sem
  //    perder foco). O rebuild "real" do HTML acontece só no blur. ──
  ['tp_text','tp_size'].forEach(id => {
    const e = document.getElementById(id);
    e?.addEventListener('input', _liveDomUpdate);
    e?.addEventListener('blur',  _applyLive);
  });

  // Selects (família/peso/alinhamento/animação) → rebuild no change (sem caret a perder).
  ['tp_family','tp_weight','tp_align','tp_anim'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', _applyLive);
  });

  // ── Cor do TEXTO → live no DOM (sem remount) ──
  const tColor = document.getElementById('tp_color');
  const tHex   = document.getElementById('tp_color_hex');
  tColor?.addEventListener('input',  e => { tHex.value = e.target.value; _liveDomUpdate(); });
  tColor?.addEventListener('change', _applyLive);
  tHex?.addEventListener('input', e => {
    if (/^#[0-9a-f]{3,8}$/i.test(e.target.value)) tColor.value = e.target.value.slice(0, 7);
    _liveDomUpdate();
  });
  tHex?.addEventListener('blur', _applyLive);

  // ── Cor de FUNDO → estrutural (layout): rebuild no change ──
  const bPick = document.getElementById('tp_bg');
  const bHex  = document.getElementById('tp_bg_hex');
  bPick?.addEventListener('input',  e => { bHex.value = e.target.value; });
  bPick?.addEventListener('change', _applyLive);
  bHex?.addEventListener('change',  _applyLive);

  // ── Cor de DESTAQUE (só templates com highlightColor) → rebuild no change ──
  const hPick = document.getElementById('tp_hl');
  const hHex  = document.getElementById('tp_hl_hex');
  hPick?.addEventListener('input',  e => { hHex.value = e.target.value; });
  hPick?.addEventListener('change', _applyLive);
  hHex?.addEventListener('change', e => {
    if (/^#[0-9a-f]{6}/i.test(e.target.value)) hPick.value = e.target.value.slice(0, 7);
    _applyLive();
  });

  // Duração e cor do clip têm efeito separado
  document.getElementById('tp_dur')?.addEventListener('change', _applyDuration);
  document.getElementById('tp_clip_color')?.addEventListener('input', e => {
    window.recolorClip(clip.id, e.target.value);
  });
  document.getElementById('tp_label')?.addEventListener('change', e => {
    window.renameClip(clip.id, e.target.value);
  });

  // Mescla sobre os params atuais: preserva wordsJson, highlightColor e
  // qualquer outro param específico do template que o painel não edita.
  // (Ao editar o texto, wordsJson fica — o template cai no timing uniforme
  // se a contagem de palavras não bater mais.)
  function _readParams() {
    const read = {
      text:       document.getElementById('tp_text')?.value      ?? p.text,
      fontFamily: document.getElementById('tp_family')?.value    ?? p.fontFamily,
      fontSize:   parseInt(document.getElementById('tp_size')?.value) || p.fontSize,
      fontWeight: document.getElementById('tp_weight')?.value    ?? p.fontWeight,
      color:      document.getElementById('tp_color_hex')?.value || document.getElementById('tp_color')?.value || p.color,
      align:      document.getElementById('tp_align')?.value     ?? p.align,
      bg:         document.getElementById('tp_bg_hex')?.value    || 'transparent',
      animation:  document.getElementById('tp_anim')?.value      ?? p.animation,
      duration:   clip.duration,
    };

    const hl = document.getElementById('tp_hl_hex')?.value || document.getElementById('tp_hl')?.value;
    if (hl) read.highlightColor = sanitizeTextCss(hl, '#82ea00');

    return { ...(tmpl.textParams || p), ...read };
  }

  let _liveTimer = null;

  function _applyLive() {
    tmpl.textParams = _readParams();
    tmpl.html = window.__TextRegistry.buildHtml(tmpl.textTmplId, tmpl.textParams, state.project?.res);

    // Preserva foco + caret de campos de texto — recriar o iframe no remount
    // estava roubando o foco do campo ativo a cada tecla.
    const a = document.activeElement;
    const isTextField = a && (a.tagName === 'TEXTAREA' ||
      (a.tagName === 'INPUT' && /^(text|number|search|)$/i.test(a.type)));
    const id = isTextField ? a.id : null;
    let caret = null;
    if (id) { try { caret = [a.selectionStart, a.selectionEnd]; } catch (_) {} }

    window.remountClip?.(clip.id);
    window.__syncCompositorToTime?.(state.time);

    if (id) {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        if (caret && caret[0] != null) { try { el.setSelectionRange(caret[0], caret[1]); } catch (_) {} }
      }
    }
  }

  // Debounce para campos digitados — não recria o iframe a cada tecla.
  function _applyLiveSoon() {
    clearTimeout(_liveTimer);
    _liveTimer = setTimeout(_applyLive, 180);
  }

  function _liveDomUpdate() {
    const params = _readParams();
    tmpl.textParams = params; // mantém o estado em dia p/ o rebuild final no blur
  
    const entry = window.__Compositor?.get(clip.id);
    let doc = null;
    try { doc = entry?.iframe?.contentDocument; } catch (_) {}
    const el = doc?.getElementById('__txt_el');
    if (!el) { _applyLiveSoon(); return; } // sem acesso → fallback (rebuild debounced)
  
    el.innerHTML        = escapeTextHtml(params.text).replace(/\n/g, '<br>');
    el.style.fontFamily = params.fontFamily;
    el.style.fontSize   = params.fontSize + 'px';
    el.style.fontWeight = params.fontWeight;
    el.style.color      = params.color;
    el.style.textAlign  = params.align;
  
    // Re-mede e faz o TransformBox acompanhar o novo tamanho/quebra de linha.
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      window.postMessage({
        type: '__TEXT_SIZE', __clipId: clip.id, clipId: clip.id,
        x: r.left, y: r.top, w: r.width, h: r.height,
      }, '*');
    });
  }

  function _applyDuration() {
    const dur = parseFloat(document.getElementById('tp_dur')?.value) || clip.duration;
    if (dur < 0.5) return;
    clip.trimStart = 0;

    clip.duration           = dur;
    clip.trimEnd            = dur;
    tmpl.sourceDuration     = dur;
    tmpl.textParams.duration = dur;
    tmpl.html = window.__TextRegistry.buildHtml(tmpl.textTmplId, { ...tmpl.textParams, duration: dur }, state.project?.res);

    recalcProjectDuration?.();
    syncProjectGlobals?.();
    renderTimeline?.();
    window.remountClip?.(clip.id);
    window.__syncCompositorToTime?.(state.time);
  }
};

const _origStartTrim = window.__startTrim;
window.__patchTextTrim = function(clipId, side, startX) {
  const clip = state?.clips.find(c => c.id === clipId);
  if (!clip?.isText) return false;
  const tmpl = state.templates.find(t => t.id === clip.templateId);
  if (!tmpl) return false;

  // Para clips de texto o maxTmpl é sempre Infinity
  // (o template não tem duração fixa — acompanha o clip)
  // Precisamos interceptar o startTrim original e forçar maxTmpl=Infinity.
  // A forma mais limpa: temporariamente definir sourceDuration=Infinity,
  // rodar o trim, e depois sincronizar de volta.
  const origSD = tmpl.sourceDuration;
  tmpl.sourceDuration = Infinity;

  const cleanup = () => {
    tmpl.sourceDuration     = clip.duration;
    tmpl.textParams.duration = clip.duration;
    tmpl.html = window.__TextRegistry.buildHtml(tmpl.textTmplId, tmpl.textParams, state.project?.res);
    window.remountClip?.(clipId);
    window.__syncCompositorToTime?.(state.time);
    renderProjectSettings?.();
  };

  // Hook no mouseup para restaurar
  const onUp = () => {
    cleanup();
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mouseup', onUp);

  return false; // deixa o startTrim original rodar normalmente
};

document.getElementById('tlTracks')?.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('text/x-mstudio-tmpl')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});

document.getElementById('tlTracks')?.addEventListener('drop', e => {
  const id = e.dataTransfer.getData('text/x-mstudio-tmpl');
  if (!id) return;
  e.preventDefault();
  const tmpl = window.__TextRegistry.getById(id);
  if (tmpl) addTextClipFromTemplate(tmpl);
});

window.__TextRegistry
  .loadAll('text-templates/index.json')
  .then(renderTextPanel)
  .catch(renderTextPanel);