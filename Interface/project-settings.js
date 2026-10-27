'use strict';
// project-settings.js
//
//  Configurações do projeto (modal com abas) e guias do preview.
//    Geral      nome, pasta do projeto, espaço usado, limpar mídias órfãs
//    Vídeo      resolução (formatos + personalizado), fps, cor de fundo
//    Editor     duração padrão de imagem, snap, guias (área segura, terços)
//    Exportação formato e qualidade padrão
//  Tudo fica em state.project (settings) e vai junto no autosave.

(() => {
  const FORMATS = [
    { label: '9:16',  hint: 'Reels · TikTok', w: 1080, h: 1920 },
    { label: '16:9',  hint: 'YouTube',        w: 1920, h: 1080 },
    { label: '1:1',   hint: 'Quadrado',       w: 1080, h: 1080 },
    { label: '4:5',   hint: 'Feed',           w: 1080, h: 1350 },
    { label: '4:3',   hint: 'Clássico',       w: 1440, h: 1080 },
    { label: '21:9',  hint: 'Cinema',         w: 2560, h: 1080 },
    { label: '4K',    hint: '16:9 UHD',       w: 3840, h: 2160 },
  ];
  const FPS_OPTIONS = [24, 25, 30, 50, 60];
  const QUALITY = [
    ['normal', 'Normal — arquivo menor'],
    ['high', 'Alta — recomendado'],
    ['max', 'Máxima — arquivo maior'],
  ];
  const DEFAULTS = {
    imageDuration: 5,
    guides: { safeArea: false, thirds: false },
    export: { format: 'mp4', quality: 'high' },
  };

  const st = () => window.__appState;
  let el = null;
  let tab = 'video';
  let lockRatio = true;

  /** Configurações do projeto com os padrões preenchidos */
  function settings() {
    const project = st()?.project;
    if (!project) return structuredClone(DEFAULTS);
    const s = project.settings || {};
    project.settings = {
      ...DEFAULTS,
      ...s,
      guides: { ...DEFAULTS.guides, ...(s.guides || {}) },
      export: { ...DEFAULTS.export, ...(s.export || {}) },
    };
    return project.settings;
  }

  // #region Modal
  function build() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'psModal';
    el.className = 'modal-overlay ps-overlay';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal ps-modal" role="dialog" aria-labelledby="psTitle">
        <div class="modal-header">
          <div class="modal-header-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </div>
          <span id="psTitle">Configurações do projeto</span>
          <button class="icon-btn" data-ps="close" aria-label="Fechar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="ps-body">
          <nav class="ps-tabs">
            <button data-tab="general">Geral</button>
            <button data-tab="video">Vídeo</button>
            <button data-tab="editor">Editor</button>
            <button data-tab="export">Exportação</button>
          </nav>

          <form class="ps-panes" id="psForm" autocomplete="off">
            <section data-pane="general">
              <label class="ps-field">Nome do projeto
                <input name="name" class="prop-input full" maxlength="120">
              </label>
              <div class="ps-info" id="psInfo"></div>
              <div class="ps-actions">
                <button type="button" class="btn-secondary" data-ps="reveal">Abrir pasta do projeto</button>
                <button type="button" class="btn-secondary" data-ps="cleanup">Remover mídias não usadas</button>
              </div>
              <p class="ps-note" id="psCleanupMsg"></p>
            </section>

            <section data-pane="video">
              <div class="ps-label">Formato</div>
              <div class="ps-formats">
                ${FORMATS.map(f => `
                  <button type="button" class="ps-format" data-w="${f.w}" data-h="${f.h}">
                    <span class="ps-shape" style="aspect-ratio:${f.w}/${f.h}"></span>
                    <strong>${f.label}</strong><small>${f.hint}</small>
                  </button>`).join('')}
              </div>
              <div class="ps-row ps-res">
                <label class="ps-field">Largura (px)<input name="w" type="number" class="prop-input full" min="16" max="7680" step="2"></label>
                <button type="button" class="ps-lock is-on" data-ps="lock" title="Manter a proporção">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
                </button>
                <label class="ps-field">Altura (px)<input name="h" type="number" class="prop-input full" min="16" max="7680" step="2"></label>
                <button type="button" class="ps-lock" data-ps="swap" title="Trocar orientação (vertical ↔ horizontal)">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4"/></svg>
                </button>
              </div>
              <div class="ps-row">
                <label class="ps-field">Quadros por segundo
                  <select name="fps" class="prop-input full">
                    ${FPS_OPTIONS.map(f => `<option value="${f}">${f} fps</option>`).join('')}
                  </select>
                </label>
                <label class="ps-field">Cor de fundo
                  <span class="ps-color"><input name="background" type="color"><input name="backgroundHex" class="prop-input full" maxlength="7"></span>
                </label>
              </div>
              <p class="ps-note">Ao mudar o formato, os clips são reenquadrados sem distorcer: quadro inteiro continua inteiro, vídeos e imagens são reencaixados.</p>
            </section>

            <section data-pane="editor">
              <label class="ps-field ps-inline">Duração padrão de imagens (s)
                <input name="imageDuration" type="number" class="prop-input" min="0.5" max="120" step="0.5">
              </label>
              <label class="ps-check"><input type="checkbox" name="snap"> Snap: grudar nas bordas dos clips e no playhead</label>
              <div class="ps-label">Guias no preview</div>
              <label class="ps-check"><input type="checkbox" name="safeArea"> Área segura (interface do Reels/TikTok, margem de título)</label>
              <label class="ps-check"><input type="checkbox" name="thirds"> Grade de terços</label>
            </section>

            <section data-pane="export">
              <div class="ps-row">
                <label class="ps-field">Formato padrão
                  <select name="exportFormat" class="prop-input full">
                    <option value="mp4">MP4 (H.264)</option>
                    <option value="webm">WebM (VP9)</option>
                  </select>
                </label>
                <label class="ps-field">Qualidade padrão
                  <select name="exportQuality" class="prop-input full">
                    ${QUALITY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
                  </select>
                </label>
              </div>
              <p class="ps-note">A exportação usa a resolução, o fps e a cor de fundo do projeto. Dá para mudar tudo isso só para um export, na própria janela de exportação.</p>
            </section>
          </form>
        </div>

        <div class="modal-footer">
          <button class="btn-secondary" data-ps="close">Cancelar</button>
          <button class="export-btn" data-ps="apply">Aplicar</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    el.addEventListener('click', onClick);
    const form = el.querySelector('#psForm');
    form.addEventListener('submit', e => { e.preventDefault(); apply(); });
    form.w.addEventListener('input', () => keepRatio('w'));
    form.h.addEventListener('input', () => keepRatio('h'));
    form.background.addEventListener('input', () => { form.backgroundHex.value = form.background.value; });
    form.backgroundHex.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(form.backgroundHex.value)) form.background.value = form.backgroundHex.value;
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && el.style.display !== 'none') close();
    });
  }

  function onClick(e) {
    if (e.target === el) return close();
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) return showTab(tabBtn.dataset.tab);
    const fmt = e.target.closest('.ps-format');
    if (fmt) {
      const form = el.querySelector('#psForm');
      form.w.value = fmt.dataset.w;
      form.h.value = fmt.dataset.h;
      markFormat();
      return;
    }
    const btn = e.target.closest('[data-ps]');
    if (!btn) return;
    const act = btn.dataset.ps;
    const form = el.querySelector('#psForm');
    if (act === 'close') close();
    if (act === 'apply') apply();
    if (act === 'lock') { lockRatio = !lockRatio; btn.classList.toggle('is-on', lockRatio); }
    if (act === 'swap') { [form.w.value, form.h.value] = [form.h.value, form.w.value]; markFormat(); }
    if (act === 'reveal') window.MSProjects?.reveal();
    if (act === 'cleanup') cleanup();
  }

  function keepRatio(changed) {
    const form = el.querySelector('#psForm');
    const res = st().project.res;
    if (lockRatio) {
      const ratio = (Number(form.dataset.ratio) || res.w / res.h);
      if (changed === 'w') form.h.value = Math.round(Number(form.w.value) / ratio / 2) * 2;
      else form.w.value = Math.round(Number(form.h.value) * ratio / 2) * 2;
    }
    markFormat();
  }

  function markFormat() {
    const form = el.querySelector('#psForm');
    const w = Number(form.w.value), h = Number(form.h.value);
    if (w > 0 && h > 0) form.dataset.ratio = String(w / h);
    el.querySelectorAll('.ps-format').forEach(b => {
      b.classList.toggle('is-active', +b.dataset.w === w && +b.dataset.h === h);
    });
  }

  function showTab(name) {
    tab = name;
    el.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
    el.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== name; });
    if (name === 'general') loadUsage();
  }

  function fill() {
    const project = st().project;
    const s = settings();
    const form = el.querySelector('#psForm');
    form.name.value = project.name || '';
    form.w.value = project.res.w;
    form.h.value = project.res.h;
    form.dataset.ratio = String(project.res.w / project.res.h);
    if (![...form.fps.options].some(o => +o.value === project.fps)) {
      form.fps.insertAdjacentHTML('beforeend', `<option value="${project.fps}">${project.fps} fps</option>`);
    }
    form.fps.value = String(project.fps);
    form.background.value = project.background || '#000000';
    form.backgroundHex.value = project.background || '#000000';
    form.imageDuration.value = s.imageDuration;
    form.snap.checked = st().snapEnabled !== false;
    form.safeArea.checked = s.guides.safeArea;
    form.thirds.checked = s.guides.thirds;
    form.exportFormat.value = s.export.format;
    form.exportQuality.value = s.export.quality;
    markFormat();
    el.querySelector('#psCleanupMsg').textContent = '';
  }

  async function loadUsage() {
    const info = el.querySelector('#psInfo');
    const project = st().project;
    const dates = [
      project.createdAt && `Criado em ${new Date(project.createdAt).toLocaleString('pt-BR')}`,
      project.updatedAt && `Editado em ${new Date(project.updatedAt).toLocaleString('pt-BR')}`,
    ].filter(Boolean).join('<br>');
    info.innerHTML = `${dates}<br>${st().clips.length} clip(s) · ${st().templates.filter(t => t.type !== 'text').length} mídia(s) na biblioteca`;
    try {
      const usage = await window.MSProjects?.usage();
      if (usage) {
        info.innerHTML += `<br>${usage.mediaFiles} arquivo(s) de mídia · ${window.MSProjects.fmtBytes(usage.mediaBytes)}<br><span class="ps-path">${escapeHtml(usage.dir)}</span>`;
      }
    } catch (_) { /* servidor sem a rota (projeto antigo) */ }
  }

  async function cleanup() {
    const msg = el.querySelector('#psCleanupMsg');
    msg.textContent = 'Limpando…';
    try {
      const out = await window.MSProjects.cleanupMedia();
      msg.textContent = out?.removed
        ? `${out.removed} arquivo(s) removido(s) · ${window.MSProjects.fmtBytes(out.freed)} liberados.`
        : 'Nenhuma mídia sobrando.';
      loadUsage();
    } catch (err) {
      msg.textContent = `Falha: ${err.message}`;
    }
  }

  function open(initialTab = 'video') {
    if (!st()?.project) return;
    build();
    fill();
    showTab(initialTab);
    el.style.display = 'flex';
  }

  function close() {
    if (el) el.style.display = 'none';
  }

  function apply() {
    const form = el.querySelector('#psForm');
    const project = st().project;
    const s = settings();

    const name = form.name.value.trim();
    if (name && name !== project.name) {
      project.name = name;
      window.MSProjects?.refreshChip();
    }

    s.imageDuration = Math.min(120, Math.max(0.5, Number(form.imageDuration.value) || DEFAULTS.imageDuration));
    s.guides = { safeArea: form.safeArea.checked, thirds: form.thirds.checked };
    s.export = { format: form.exportFormat.value, quality: form.exportQuality.value };
    st().snapEnabled = form.snap.checked;
    const snapBtn = document.getElementById('btnTlSnap');
    if (snapBtn) snapBtn.dataset.active = String(form.snap.checked);

    applyProjectSettings({
      width: Number(form.w.value),
      height: Number(form.h.value),
      fps: Number(form.fps.value),
      background: /^#[0-9a-f]{6}$/i.test(form.backgroundHex.value) ? form.backgroundHex.value : form.background.value,
    });
    renderGuides();
    close();
  }
  // #endregion

  // #region Guias do preview
  function renderGuides() {
    const outer = document.getElementById('previewOuter');
    if (!outer) return;
    let layer = document.getElementById('psGuides');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'psGuides';
      layer.className = 'ps-guides';
      outer.appendChild(layer);
    }
    const project = st()?.project;
    const g = project ? settings().guides : { safeArea: false, thirds: false };
    layer.hidden = !(g.safeArea || g.thirds);
    if (layer.hidden) return;

    const vertical = project.res.h > project.res.w * 1.2;
    layer.className = 'ps-guides' + (g.thirds ? ' has-thirds' : '');
    // Vertical: faixas da interface das redes (topo, legenda/botões embaixo, ações à direita).
    // Outros formatos: margem de título de 10%.
    layer.innerHTML = g.safeArea
      ? (vertical
          ? `<div class="ps-safe" style="top:10%;bottom:22%;left:5%;right:14%"><span>área segura</span></div>
             <div class="ps-ui ps-ui-top"></div><div class="ps-ui ps-ui-bottom"></div><div class="ps-ui ps-ui-right"></div>`
          : '<div class="ps-safe" style="inset:10%"><span>margem de título</span></div>')
      : '';
  }
  // #endregion

  window.MSProjectSettings = { open, close, settings, renderGuides };

  // Guias acompanham troca de projeto / redimensionamento do preview
  const syncGuides = () => requestAnimationFrame(renderGuides);
  window.addEventListener('resize', syncGuides);
  document.addEventListener('click', e => {
    if (e.target.closest('#mbProjectProps, #btnQuickProject, [data-action="project-settings"]')) {
      e.preventDefault();
      open();
    }
  });
  setInterval(() => {
    // Barato: só recria se o projeto/ajuste mudou
    const project = st()?.project;
    const key = project ? `${project.id}|${project.res.w}x${project.res.h}|${JSON.stringify(project.settings?.guides || {})}` : '';
    if (key !== renderGuides.key) { renderGuides.key = key; renderGuides(); }
  }, 800);
})();
