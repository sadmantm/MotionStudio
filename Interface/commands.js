'use strict';
// commands.js
//
//  Comandos do editor num registro só:
//    • todos os atalhos de teclado passam por aqui (um despachante global) — nada de
//      listeners espalhados; dá para reatribuir na Central de atalhos
//    • Paleta de comandos (Ctrl+K): busca por qualquer ação, efeito, projeto ou marcador
//    • Central de atalhos (?): todos os atalhos agrupados, com busca e reatribuição
//    • Reprodução e edição "de ilha de edição": J/K/L, setas por quadro, ↑/↓ entre cortes,
//      I/O, Q/W, M…
//  Combinações são texto: "Ctrl+Shift+Z" (Ctrl vale também como ⌘ no Mac), "Alt+ArrowUp", "?".
//  As escolhas do usuário ficam em localStorage (ms.shortcuts) e valem para todos os projetos.

(() => {
  const st = () => window.__appState;
  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || '');
  const LS_KEYS = 'ms.shortcuts';
  const LS_RECENT = 'ms.cmdRecent';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

  // #region Registro
  const commands = new Map();
  const providers = [];
  const GROUPS = ['Reprodução', 'Edição', 'Timeline', 'Marcadores', 'Projeto', 'Efeitos e IA', 'Ajuda'];

  /**
   * { id, title, group, keys: ['Ctrl+Z'], run(e), when(): bool, keywords, allowInInput, allowInControls }
   * allowInControls: vale também com o foco num slider/select (não num campo de texto)
   */
  function register(cmd) {
    commands.set(cmd.id, { group: 'Edição', keys: [], keywords: '', when: () => Boolean(st().project), ...cmd });
  }
  /** Fonte de comandos dinâmicos (projetos, marcadores, efeitos…): fn() → [{ id?, title, group, run }] */
  function provide(fn) { providers.push(fn); }

  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem(LS_KEYS) || '{}') || {}; } catch (_) { overrides = {}; }
  const saveOverrides = () => { try { localStorage.setItem(LS_KEYS, JSON.stringify(overrides)); } catch (_) { /* sem storage */ } };
  const keysOf = id => overrides[id] ?? commands.get(id)?.keys ?? [];
  // #endregion

  // #region Combinações de teclas
  const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];
  const PLAIN = { Space: 'Space', Delete: 'Delete', Backspace: 'Backspace', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown' };

  /** KeyboardEvent → "Ctrl+Shift+Z" (null para tecla de modificador sozinha) */
  function comboOf(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
    let token = null;
    if (/^Key[A-Z]$/.test(e.code)) token = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) token = e.code.slice(5);
    else if (/^F\d{1,2}$/.test(e.code)) token = e.code;
    else if (PLAIN[e.code]) token = PLAIN[e.code];
    else if (e.key && e.key.length === 1) token = e.key;   // símbolos: ? / = - , . [ ]
    if (!token) return null;
    const symbol = token.length === 1 && !/[A-Z0-9]/.test(token);
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && !symbol) mods.push('Shift');   // o shift de "?" já faz parte do símbolo
    return [...mods, token].join('+');
  }

  const PRETTY = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Delete: 'Del', Backspace: '⌫', Escape: 'Esc', Space: 'Espaço', PageUp: 'PgUp', PageDown: 'PgDn' };
  function pretty(combo) {
    return combo.split('+').map(p => (p === 'Ctrl' && IS_MAC ? '⌘' : p === 'Alt' && IS_MAC ? '⌥' : p === 'Shift' && IS_MAC ? '⇧' : PRETTY[p] || p)).join(IS_MAC ? '' : '+');
  }
  const kbd = combo => `<kbd class="kbd">${esc(pretty(combo))}</kbd>`;
  // #endregion

  // #region Despachante global
  const isEditable = t => Boolean(t) && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
  const isTextEntry = t => {
    if (!t) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
    return t.tagName === 'INPUT' && ['text', 'number', 'search', 'email', 'url', 'password', 'tel', ''].includes(t.type);
  };
  const paletteOpen = () => Boolean(document.getElementById('cmdPalette')?.classList.contains('is-open'));
  const centerOpen = () => Boolean(document.getElementById('shortcutCenter')?.classList.contains('is-open'));
  /** Algum modal/tela cheia aberto (os atalhos do editor ficam quietos; o próprio modal cuida do teclado) */
  function modalOpen() {
    const open = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
    if ([...document.querySelectorAll('.modal-overlay')].some(open)) return true;
    return open(document.getElementById('projectHome'));
  }

  let capture = null;   // quando a Central está gravando uma nova combinação

  function onKeyDown(e) {
    if (capture) return capture(e);
    if (paletteOpen() || centerOpen()) return;
    const combo = comboOf(e);
    if (!combo) return;
    // candidatos: comandos cujas teclas incluem a combinação
    const hits = [...commands.values()].filter(c => keysOf(c.id).includes(combo));
    if (!hits.length) return;
    const cmd = hits.find(c => { try { return c.when(); } catch (_) { return false; } });
    if (!cmd) return;
    const target = e.target;
    if (isEditable(target)) {
      const ok = cmd.allowInInput || (cmd.allowInControls && !isTextEntry(target));
      if (!ok) return;
    }
    if (modalOpen() && !cmd.allowInModal) return;
    e.preventDefault();
    e.stopPropagation();
    if (cmd.allowInControls && target instanceof HTMLElement && target !== document.body) target.blur();
    try { cmd.run(e); } catch (err) { console.error('[Comando]', cmd.id, err); window.MSUI?.toast({ message: `Não foi possível executar “${cmd.title}”.`, kind: 'error' }); }
  }
  // #endregion

  // #region Reprodução (J/K/L, quadro a quadro, entre cortes)
  const fps = () => st().project?.fps || 30;
  const total = () => st().project?.totalDuration || 0;
  const seek = t => window.seekTo?.(Math.max(0, Math.min(total(), t)));

  const shuttle = { dir: 0, rate: 1, timer: null };
  function stopShuttle() {
    clearInterval(shuttle.timer);
    shuttle.timer = null;
    shuttle.dir = 0;
    shuttle.rate = 1;
    window.__playRate = 1;
  }
  function pauseIfPlaying() { if (st().playing) window.togglePlay(); }
  const rateToast = r => window.MSUI?.toast({ message: `Velocidade ${r}×`, kind: 'info', duration: 1200 });

  function shuttleForward() {
    clearInterval(shuttle.timer);
    shuttle.timer = null;
    if (shuttle.dir === -1) { shuttle.dir = 0; shuttle.rate = 1; }
    if (!st().playing) {
      window.__playRate = 1;
      shuttle.dir = 1;
      shuttle.rate = 1;
      window.togglePlay();
    } else {
      shuttle.rate = Math.min(4, (window.__playRate || 1) * 2);
      window.__playRate = shuttle.rate;
      rateToast(shuttle.rate);
    }
  }
  function shuttleReverse() {
    pauseIfPlaying();
    shuttle.rate = shuttle.dir === -1 ? Math.min(4, shuttle.rate * 2) : 1;
    shuttle.dir = -1;
    window.__playRate = 1;
    if (shuttle.rate > 1) rateToast(`−${shuttle.rate}`);
    clearInterval(shuttle.timer);
    let last = performance.now();
    shuttle.timer = setInterval(() => {
      const now = performance.now();
      const t = st().time - ((now - last) / 1000) * shuttle.rate;
      last = now;
      if (t <= 0) { seek(0); stopShuttle(); } else seek(t);
    }, 60);
  }
  /** Qualquer clique na timeline/preview encerra o vai-e-volta de J */
  document.addEventListener('mousedown', () => { if (shuttle.dir === -1) stopShuttle(); }, true);

  /** Instantes de corte: começo e fim de cada clip */
  function editPoints() {
    const set = new Set([0]);
    st().clips.forEach(c => { set.add(Math.round(c.start * 1000) / 1000); set.add(Math.round((c.start + c.duration) * 1000) / 1000); });
    return [...set].sort((a, b) => a - b);
  }
  function jumpEdit(dir) {
    const t = st().time;
    const pts = editPoints();
    const target = dir > 0 ? pts.find(x => x > t + 0.001) : [...pts].reverse().find(x => x < t - 0.001);
    if (target != null) seek(target);
  }

  /** Q / W: corta na agulha e remove o trecho antes / depois (sem fechar o espaço) */
  function trimAtPlayhead(side) {
    const s = st();
    const t = s.time;
    const MIN = typeof MIN_CLIP_DURATION === 'number' ? MIN_CLIP_DURATION : 0.1;
    const under = c => t > c.start + MIN && t < c.start + c.duration - MIN && !(typeof isClipLocked === 'function' && isClipLocked(c));
    const sel = window.__selectedClipIds || new Set();
    let targets = s.clips.filter(c => sel.has(c.id) && under(c));
    if (!targets.length) targets = s.clips.filter(under).sort((a, b) => b.trackIndex - a.trackIndex).slice(0, 1);
    if (!targets.length) return window.MSUI?.toast({ message: 'Coloque a agulha sobre um clip.', kind: 'info', duration: 2200 });
    window.__tlPushUndo?.();
    const gone = [];
    targets.forEach(c => {
      const parts = splitClipAt(c, t);
      if (parts) gone.push(side === 'before' ? parts.leftClip.id : parts.rightClip.id);
    });
    removeClipsById(gone);
    afterClipsRemoved();
  }
  // #endregion

  // #region Definição dos comandos
  const act = name => () => window.__runTimelineAction?.(name);
  const hasProject = () => Boolean(st().project);
  const hasSelection = () => Boolean(st().project) && (window.__selectedClipIds?.size > 0 || st().currentClipId);
  const selectedIds = () => [...(window.__selectedClipIds || [])].filter(id => st().clips.some(c => c.id === id));
  const click = id => document.getElementById(id)?.click();

  function defineCommands() {
    // Reprodução
    register({ id: 'play', title: 'Reproduzir / pausar', group: 'Reprodução', keys: ['Space'], when: hasProject, run: () => { stopShuttle(); window.togglePlay(); } });
    register({ id: 'shuttle-fwd', title: 'Avançar tocando (repetir acelera 2×, 4×)', group: 'Reprodução', keys: ['L'], keywords: 'play forward rapido', when: hasProject, run: shuttleForward });
    register({ id: 'shuttle-rev', title: 'Voltar tocando (repetir acelera)', group: 'Reprodução', keys: ['J'], keywords: 'reverse retroceder', when: hasProject, run: shuttleReverse });
    register({ id: 'shuttle-stop', title: 'Parar', group: 'Reprodução', keys: ['K'], keywords: 'pausar', when: hasProject, run: () => { stopShuttle(); pauseIfPlaying(); } });
    register({ id: 'frame-prev', title: 'Voltar 1 quadro', group: 'Reprodução', keys: ['ArrowLeft'], when: hasProject, run: () => { stopShuttle(); seek(st().time - 1 / fps()); } });
    register({ id: 'frame-next', title: 'Avançar 1 quadro', group: 'Reprodução', keys: ['ArrowRight'], when: hasProject, run: () => { stopShuttle(); seek(st().time + 1 / fps()); } });
    register({ id: 'sec-prev', title: 'Voltar 1 segundo', group: 'Reprodução', keys: ['Shift+ArrowLeft'], when: hasProject, run: () => seek(st().time - 1) });
    register({ id: 'sec-next', title: 'Avançar 1 segundo', group: 'Reprodução', keys: ['Shift+ArrowRight'], when: hasProject, run: () => seek(st().time + 1) });
    register({ id: 'edit-prev', title: 'Ir para o corte anterior', group: 'Reprodução', keys: ['ArrowUp'], keywords: 'ponto de edicao inicio clip', when: hasProject, run: () => jumpEdit(-1) });
    register({ id: 'edit-next', title: 'Ir para o próximo corte', group: 'Reprodução', keys: ['ArrowDown'], keywords: 'ponto de edicao fim clip', when: hasProject, run: () => jumpEdit(1) });
    register({ id: 'go-start', title: 'Ir para o início', group: 'Reprodução', keys: ['Home'], when: hasProject, run: () => seek(0) });
    register({ id: 'go-end', title: 'Ir para o fim', group: 'Reprodução', keys: ['End'], when: hasProject, run: () => seek(total()) });

    // Edição
    register({ id: 'undo', title: 'Desfazer', group: 'Edição', keys: ['Ctrl+Z'], allowInControls: true, when: hasProject, run: () => window.__tlUndo?.() });
    register({ id: 'redo', title: 'Refazer', group: 'Edição', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], allowInControls: true, when: hasProject, run: () => window.__tlRedo?.() });
    register({ id: 'split', title: 'Cortar na agulha', group: 'Edição', keys: ['S'], keywords: 'dividir split', when: hasProject, run: () => window.splitCurrentScene?.() });
    register({ id: 'trim-before', title: 'Cortar e remover o trecho antes da agulha', group: 'Edição', keys: ['Q'], keywords: 'aparar inicio', when: hasProject, run: () => trimAtPlayhead('before') });
    register({ id: 'trim-after', title: 'Cortar e remover o trecho depois da agulha', group: 'Edição', keys: ['W'], keywords: 'aparar fim', when: hasProject, run: () => trimAtPlayhead('after') });
    register({ id: 'delete', title: 'Excluir clip', group: 'Edição', keys: ['Delete', 'Backspace'], keywords: 'apagar remover', when: () => hasProject() && (hasSelection() || st().selectedTrack != null), run: () => window.deleteSelectedClips?.() });
    register({ id: 'ripple', title: 'Excluir e fechar o espaço', group: 'Edição', keys: ['Shift+Delete', 'Shift+Backspace'], keywords: 'ripple', when: () => hasProject() && (hasSelection() || st().selectedTrack != null), run: () => window.rippleDeleteSelectedClips?.() });
    register({ id: 'copy', title: 'Copiar', group: 'Edição', keys: ['Ctrl+C'], when: hasSelection, run: act('copy') });
    register({ id: 'cut', title: 'Recortar', group: 'Edição', keys: ['Ctrl+X'], when: hasSelection, run: act('cut') });
    register({ id: 'paste', title: 'Colar na agulha', group: 'Edição', keys: [], when: hasProject, run: act('paste') });
    register({ id: 'duplicate', title: 'Duplicar', group: 'Edição', keys: ['Ctrl+D'], when: hasSelection, run: act('duplicate') });
    register({ id: 'select-all', title: 'Selecionar todos os clips', group: 'Edição', keys: ['Ctrl+A'], when: hasProject, run: act('selectAll') });
    register({ id: 'deselect', title: 'Limpar a seleção', group: 'Edição', keys: ['Escape'], when: hasProject, run: () => { if (window.__selectedClipIds?.size) window.deselectClip?.(); else window.selectTrack?.(null); } });
    register({ id: 'rename', title: 'Renomear clip', group: 'Edição', keys: ['F2'], when: hasSelection, run: act('rename') });
    register({ id: 'track-up', title: 'Mover para a track acima', group: 'Edição', keys: ['Alt+ArrowUp'], when: hasSelection, run: act('trackUp') });
    register({ id: 'track-down', title: 'Mover para a track abaixo', group: 'Edição', keys: ['Alt+ArrowDown'], when: hasSelection, run: act('trackDown') });
    register({ id: 'captions', title: 'Editar legendas', group: 'Edição', keys: [], when: hasSelection, run: act('captions') });
    register({ id: 'add-track', title: 'Adicionar track', group: 'Edição', keys: [], when: hasProject, run: act('addTrack') });

    // Timeline
    register({ id: 'zoom-fit', title: 'Ajustar a timeline à tela', group: 'Timeline', keys: ['Shift+Z'], when: hasProject, run: act('zoomFit') });
    register({ id: 'zoom-in', title: 'Aproximar a timeline', group: 'Timeline', keys: ['='], when: hasProject, run: () => click('btnZoomIn') });
    register({ id: 'zoom-out', title: 'Afastar a timeline', group: 'Timeline', keys: ['-'], when: hasProject, run: () => click('btnZoomOut') });
    register({ id: 'snap', title: 'Ligar / desligar o snap (ímã)', group: 'Timeline', keys: ['N'], keywords: 'imã encaixe', when: hasProject, run: () => click('btnTlSnap') });

    // Marcadores e regiões
    const M = () => window.MSMarkers;
    register({ id: 'marker-add', title: 'Adicionar marcador na agulha', group: 'Marcadores', keys: ['M'], when: hasProject, run: () => { window.__tlPushUndo?.(); M().add({}); M().render(); } });
    register({ id: 'marker-prev', title: 'Ir para o marcador anterior', group: 'Marcadores', keys: ['Shift+ArrowUp'], when: hasProject, run: () => M().jump(-1) });
    register({ id: 'marker-next', title: 'Ir para o próximo marcador', group: 'Marcadores', keys: ['Shift+ArrowDown'], when: hasProject, run: () => M().jump(1) });
    register({ id: 'region-in', title: 'Marcar o início da região', group: 'Marcadores', keys: ['I'], keywords: 'in ponto de entrada', when: hasProject, run: () => M().setIn() });
    register({ id: 'region-out', title: 'Marcar o fim da região', group: 'Marcadores', keys: ['O'], keywords: 'out ponto de saida', when: hasProject, run: () => M().setOut() });
    register({ id: 'region-clear', title: 'Limpar a região', group: 'Marcadores', keys: ['Alt+X'], when: hasProject, run: () => M().clearWork() });
    register({ id: 'region-from-clip', title: 'Criar região a partir do clip selecionado', group: 'Marcadores', keys: [], when: hasSelection, run: () => M().regionFromSelection() });
    register({ id: 'region-ripple', title: 'Remover a região e fechar o espaço', group: 'Marcadores', keys: [], keywords: 'cortar trecho ripple', when: () => hasProject() && Boolean(M()?.work()), run: () => M().rippleRemoveRegion() });

    // Projeto
    const pc = name => () => (typeof projectCommands !== 'undefined' ? projectCommands[name]?.() : null);
    register({ id: 'project-new', title: 'Novo projeto', group: 'Projeto', keys: ['Ctrl+N'], when: () => true, run: pc('create') });
    register({ id: 'project-open', title: 'Abrir projeto…', group: 'Projeto', keys: ['Ctrl+O'], when: () => true, run: pc('open') });
    register({ id: 'project-save', title: 'Salvar projeto agora', group: 'Projeto', keys: ['Ctrl+S'], when: hasProject, run: pc('save') });
    register({ id: 'project-home', title: 'Ir para a tela de projetos', group: 'Projeto', keys: [], when: () => Boolean(window.MSProjects), run: () => window.MSProjects.showHome() });
    register({ id: 'export', title: 'Exportar vídeo…', group: 'Projeto', keys: ['Ctrl+E'], when: hasProject, run: () => click('btnExport') });
    register({ id: 'export-frame', title: 'Exportar quadro atual (PNG)', group: 'Projeto', when: hasProject, run: () => window.runFrameExport?.() });

    // Efeitos e IA
    register({ id: 'ai-scenes', title: 'Gerar cenas com IA a partir do áudio selecionado', group: 'Efeitos e IA', keys: [], keywords: 'cenas ia gemini', when: () => hasSelection() && Boolean(window.__onClipAIScenes), run: () => window.__onClipAIScenes(selectedIds()) });
    register({ id: 'ai-sfx', title: 'Gerar efeitos sonoros com IA para o clip selecionado', group: 'Efeitos e IA', keys: [], keywords: 'sons sfx ia', when: () => hasSelection() && Boolean(window.__aiSfxForClips), run: () => window.__aiSfxForClips(selectedIds()) });
    register({ id: 'extract-audio', title: 'Extrair o áudio do clip', group: 'Efeitos e IA', keys: [], when: () => hasSelection() && Boolean(window.__extractClipAudio), run: act('extractAudio') });
    register({ id: 'ai-settings', title: 'Configurações da IA (chave e modelo)', group: 'Efeitos e IA', keys: [], keywords: 'gemini api', when: () => Boolean(window.MotionAI), run: () => window.MotionAI.open() });
    register({ id: 'new-effect', title: 'Novo efeito (colar HTML ou IA)…', group: 'Efeitos e IA', keys: [], when: () => Boolean(window.MSCustomAssets), run: () => window.MSCustomAssets.open('effect') });
    register({ id: 'new-transition', title: 'Nova transição (colar HTML ou IA)…', group: 'Efeitos e IA', keys: [], when: () => Boolean(window.MSCustomAssets), run: () => window.MSCustomAssets.open('transition') });
    register({ id: 'new-text', title: 'Novo texto animado (colar HTML ou IA)…', group: 'Efeitos e IA', keys: [], when: () => Boolean(window.MSCustomAssets), run: () => window.MSCustomAssets.open('text') });
    register({ id: 'new-curve', title: 'Nova curva de animação (IA ou código)…', group: 'Efeitos e IA', keys: [], when: () => Boolean(window.MSCurves), run: () => window.MSCurves.open() });

    // Ajuda
    register({ id: 'palette', title: 'Paleta de comandos', group: 'Ajuda', keys: ['Ctrl+K'], when: () => true, allowInInput: true, run: () => openPalette() });
    register({ id: 'shortcuts', title: 'Central de atalhos de teclado', group: 'Ajuda', keys: ['?'], keywords: 'ajuda teclas', when: () => true, run: () => openCenter() });
  }

  // Comandos dinâmicos da paleta
  function defineProviders() {
    // Biblioteca e painéis
    provide(() => [
      ['media', 'Mídia'], ['effects', 'Efeitos'], ['text', 'Texto'], ['transitions', 'Transições'],
    ].map(([tab, name]) => ({ title: `Biblioteca: ${name}`, group: 'Ir para', run: () => document.querySelector(`.ptab[data-tab="${tab}"]`)?.click() }))
      .concat([['props', 'Painel do clip'], ['project', 'Painel do projeto']].map(([tab, name]) => ({ title: `Abrir: ${name}`, group: 'Ir para', run: () => document.querySelector(`.ptab[data-tab="${tab}"]`)?.click() }))));
    // Efeitos nos clips selecionados
    provide(() => {
      const FX = window.ClipFX;
      if (!FX || !window.__fxApply || !hasSelection()) return [];
      const out = [];
      const add = (kind, map, label) => Object.entries(map).forEach(([id, v]) => {
        const name = typeof v === 'string' ? v : v.label;
        if (id === 'none' || !name) return;
        out.push({ title: `${label}: ${name}`, group: 'Aplicar efeito', run: () => window.__fxApply(kind, id) });
      });
      add('look', FX.LOOKS, 'Filtro');
      add('motion', FX.MOTIONS, 'Movimento');
      add('in', FX.IN_OUT, 'Entrada');
      add('out', FX.IN_OUT, 'Saída');
      add('transition', FX.TRANSITIONS, 'Transição');
      return out;
    });
    // Marcadores e regiões
    provide(() => (window.MSMarkers?.sorted() || []).map(m => ({
      title: `Ir para ${m.end != null ? 'a região' : 'o marcador'}: ${m.label}`, group: 'Ir para', hint: window.fmtTime ? window.fmtTime(m.t) : '', run: () => window.seekTo(m.t),
    })));
    // Projetos (cache preenchido ao abrir a paleta)
    provide(() => projectCache.map(p => ({ title: `Abrir projeto: ${p.name}`, group: 'Projetos', run: () => window.MSProjects?.open(p.id) })));
  }
  let projectCache = [];
  async function refreshProjects() {
    try {
      const data = await (await fetch('/api/projects')).json();
      projectCache = (Array.isArray(data) ? data : data.projects || []).filter(p => p?.id && p.name && p.id !== window.MSProjects?.currentId?.()).slice(0, 30);
    } catch (_) { projectCache = []; }
  }
  // #endregion

  // #region Paleta (Ctrl+K)
  const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(LS_RECENT) || '[]') || []; } catch (_) { recent = []; }
  const remember = key => {
    recent = [key, ...recent.filter(k => k !== key)].slice(0, 8);
    try { localStorage.setItem(LS_RECENT, JSON.stringify(recent)); } catch (_) { /* sem storage */ }
  };

  function allEntries() {
    const out = [];
    commands.forEach(c => {
      let ok = false;
      try { ok = c.when(); } catch (_) { ok = false; }
      if (ok) out.push({ key: c.id, title: c.title, group: c.group, keywords: c.keywords, keys: keysOf(c.id), run: () => c.run() });
    });
    providers.forEach(fn => { try { fn().forEach(p => out.push({ key: `${p.group}:${p.title}`, title: p.title, group: p.group, keywords: p.keywords || '', keys: [], hint: p.hint, run: p.run })); } catch (_) { /* provedor falhou */ } });
    return out;
  }

  function score(entry, tokens) {
    const hay = norm(`${entry.title} ${entry.group} ${entry.keywords || ''}`);
    const title = norm(entry.title);
    let s = 0;
    for (const t of tokens) {
      const i = hay.indexOf(t);
      if (i < 0) return -1;
      s += title.startsWith(t) ? 6 : title.split(/[\s:]+/).some(w => w.startsWith(t)) ? 4 : title.includes(t) ? 2 : 1;
    }
    const r = recent.indexOf(entry.key);
    if (r >= 0) s += 3 - Math.min(2, r * 0.3);
    return s;
  }

  let P = null;   // { el, input, list, items, index }
  function buildPalette() {
    if (P) return P;
    const el = document.createElement('div');
    el.id = 'cmdPalette';
    el.className = 'cmd-overlay';
    el.innerHTML = `
      <div class="cmd-box" role="dialog" aria-label="Paleta de comandos">
        <input class="cmd-input" type="text" placeholder="Digite um comando, efeito, projeto ou marcador…" autocomplete="off" spellcheck="false" aria-label="Buscar comando">
        <div class="cmd-list" role="listbox"></div>
        <div class="cmd-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navegar</span><span><kbd class="kbd">Enter</kbd> executar</span><span><kbd class="kbd">Esc</kbd> fechar</span><span class="cmd-foot-r"><button type="button" class="cv-link" data-cmd="shortcuts">Atalhos ?</button></span></div>
      </div>`;
    document.body.appendChild(el);
    P = { el, input: el.querySelector('.cmd-input'), list: el.querySelector('.cmd-list'), items: [], index: 0 };
    P.input.addEventListener('input', renderPalette);
    P.input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runSel(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); }
      else if (e.key === 'Tab') e.preventDefault();
    });
    el.addEventListener('mousedown', e => { if (e.target === el) closePalette(); });
    el.addEventListener('click', e => {
      if (e.target.closest('[data-cmd="shortcuts"]')) { closePalette(); openCenter(); return; }
      const row = e.target.closest('.cmd-row');
      if (row) { P.index = Number(row.dataset.i); runSel(); }
    });
    el.addEventListener('mousemove', e => {
      const row = e.target.closest('.cmd-row');
      if (row && Number(row.dataset.i) !== P.index) { P.index = Number(row.dataset.i); paintSel(); }
    });
    return P;
  }

  function renderPalette() {
    const q = norm(P.input.value).trim();
    const tokens = q.split(/\s+/).filter(Boolean);
    let items = allEntries();
    if (tokens.length) {
      items = items.map(e => ({ e, s: score(e, tokens) })).filter(x => x.s >= 0).sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title)).map(x => x.e).slice(0, 60);
    } else {
      // Sem busca: recentes e depois os comandos com atalho, por grupo
      const rank = e => { const r = recent.indexOf(e.key); return r >= 0 ? r : 100 + Math.max(0, GROUPS.indexOf(e.group)); };
      items = items.filter(e => commands.has(e.key)).sort((a, b) => rank(a) - rank(b)).slice(0, 40);
    }
    P.items = items;
    P.index = 0;
    const recentKeys = new Set(recent);
    let lastGroup = null;
    P.list.innerHTML = items.length ? items.map((e, i) => {
      const group = !tokens.length && recentKeys.has(e.key) ? 'Recentes' : e.group;
      const head = group !== lastGroup ? `<div class="cmd-group">${esc(group)}</div>` : '';
      lastGroup = group;
      return `${head}<div class="cmd-row" role="option" data-i="${i}">
        <span class="cmd-title">${esc(e.title)}</span>
        <span class="cmd-meta">${e.hint ? `<span class="cmd-hint">${esc(e.hint)}</span>` : ''}${(e.keys || []).slice(0, 2).map(kbd).join('')}</span>
      </div>`;
    }).join('') : '<div class="cmd-empty">Nada encontrado. Tente outra palavra.</div>';
    paintSel();
  }

  function paintSel() {
    P.list.querySelectorAll('.cmd-row').forEach(r => r.classList.toggle('is-sel', Number(r.dataset.i) === P.index));
    P.list.querySelector('.cmd-row.is-sel')?.scrollIntoView({ block: 'nearest' });
  }
  function moveSel(d) {
    if (!P.items.length) return;
    P.index = (P.index + d + P.items.length) % P.items.length;
    paintSel();
  }
  function runSel() {
    const e = P.items[P.index];
    if (!e) return;
    closePalette();
    remember(e.key);
    setTimeout(() => { try { e.run(); } catch (err) { console.error('[Paleta]', err); window.MSUI?.toast({ message: `Não foi possível executar “${e.title}”.`, kind: 'error' }); } }, 0);
  }

  function openPalette() {
    buildPalette();
    P.el.classList.add('is-open');
    P.input.value = '';
    renderPalette();
    P.input.focus();
    refreshProjects().then(() => { if (P.el.classList.contains('is-open') && !P.input.value) renderPalette(); else if (P.el.classList.contains('is-open')) renderPalette(); });
  }
  function closePalette() { P?.el.classList.remove('is-open'); }
  // #endregion

  // #region Central de atalhos (?)
  let C = null;
  function buildCenter() {
    if (C) return C;
    const el = document.createElement('div');
    el.id = 'shortcutCenter';
    el.className = 'cmd-overlay';
    el.innerHTML = `
      <div class="cmd-box sc-box" role="dialog" aria-label="Central de atalhos">
        <div class="sc-head">
          <b>Atalhos de teclado</b>
          <input class="cmd-input sc-search" type="text" placeholder="Filtrar…" autocomplete="off" aria-label="Filtrar atalhos">
          <button type="button" class="btn-secondary sc-reset-all" data-sc="reset-all" title="Voltar todos os atalhos ao padrão">Restaurar padrão</button>
          <button type="button" class="icon-btn" data-sc="close" aria-label="Fechar"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="sc-body"></div>
        <div class="cmd-foot"><span>Clique num atalho para trocá-lo · <kbd class="kbd">＋</kbd> adiciona outro · <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">K</kbd> abre a paleta de comandos</span></div>
      </div>`;
    document.body.appendChild(el);
    C = { el, body: el.querySelector('.sc-body'), search: el.querySelector('.sc-search') };
    C.search.addEventListener('input', renderCenter);
    el.addEventListener('mousedown', e => { if (e.target === el && !capture) closeCenter(); });
    el.addEventListener('click', onCenterClick);
    el.addEventListener('keydown', e => { if (e.key === 'Escape' && !capture) { e.stopPropagation(); closeCenter(); } });
    return C;
  }

  function renderCenter() {
    const q = norm(C.search.value).trim();
    const byGroup = new Map();
    commands.forEach(c => {
      if (q && !norm(`${c.title} ${c.group} ${keysOf(c.id).map(pretty).join(' ')}`).includes(q)) return;
      if (!byGroup.has(c.group)) byGroup.set(c.group, []);
      byGroup.get(c.group).push(c);
    });
    const order = [...GROUPS, ...[...byGroup.keys()].filter(g => !GROUPS.includes(g))];
    C.body.innerHTML = order.filter(g => byGroup.has(g)).map(g => `
      <section class="sc-group"><h4>${esc(g)}</h4>${byGroup.get(g).map(c => {
        const keys = keysOf(c.id);
        const changed = overrides[c.id] !== undefined;
        return `<div class="sc-row" data-id="${c.id}">
          <span class="sc-title">${esc(c.title)}</span>
          <span class="sc-keys">
            ${keys.map((k, i) => `<button type="button" class="sc-key" data-sc="rebind" data-i="${i}" title="Clique para trocar este atalho">${kbd(k)}</button>`).join('')}
            <button type="button" class="sc-add" data-sc="add" title="Adicionar um atalho">＋</button>
            ${changed ? '<button type="button" class="sc-undo" data-sc="reset" title="Voltar ao padrão">↺</button>' : ''}
          </span>
        </div>`;
      }).join('')}</section>`).join('') || '<p class="cmd-empty">Nenhum atalho encontrado.</p>';
  }

  function conflictOf(combo, exceptId) {
    for (const c of commands.values()) if (c.id !== exceptId && keysOf(c.id).includes(combo)) return c;
    return null;
  }

  /** Grava a próxima combinação digitada para o comando (substitui a de índice `index`, ou acrescenta) */
  function rebind(id, index) {
    const row = C.body.querySelector(`.sc-row[data-id="${id}"]`);
    const slot = index == null ? row.querySelector('.sc-add') : row.querySelectorAll('.sc-key')[index];
    slot.classList.add('is-listening');
    slot.textContent = 'Digite a combinação… (Esc cancela)';
    capture = e => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { capture = null; return renderCenter(); }
      const combo = comboOf(e);
      if (!combo) return;
      capture = null;
      apply(combo);
    };
    async function apply(combo) {
      if (combo === 'Ctrl+Space') { window.MSUI.toast({ message: 'Ctrl+Espaço é da barra de IA.', kind: 'warn' }); return renderCenter(); }
      const other = conflictOf(combo, id);
      if (other) {
        const ok = await window.MSUI.confirm({ title: 'Atalho em uso', message: `${pretty(combo)} já é o atalho de “${other.title}”. Passar para “${commands.get(id).title}”?`, confirmLabel: 'Substituir' });
        if (!ok) return renderCenter();
        overrides[other.id] = keysOf(other.id).filter(k => k !== combo);
      }
      const keys = [...keysOf(id)];
      if (index == null) { if (!keys.includes(combo)) keys.push(combo); } else keys[index] = combo;
      overrides[id] = keys;
      saveOverrides();
      renderCenter();
    }
  }

  function onCenterClick(e) {
    const btn = e.target.closest('[data-sc]');
    if (!btn) return;
    const a = btn.dataset.sc;
    const id = btn.closest('.sc-row')?.dataset.id;
    if (a === 'close') closeCenter();
    if (a === 'rebind') rebind(id, Number(btn.dataset.i));
    if (a === 'add') rebind(id, null);
    if (a === 'reset') { delete overrides[id]; saveOverrides(); renderCenter(); }
    if (a === 'reset-all') {
      window.MSUI.confirm({ title: 'Restaurar atalhos', message: 'Voltar todos os atalhos ao padrão?', confirmLabel: 'Restaurar' }).then(ok => { if (ok) { overrides = {}; saveOverrides(); renderCenter(); } });
    }
  }

  function openCenter() {
    buildCenter();
    C.el.classList.add('is-open');
    C.search.value = '';
    renderCenter();
    C.search.focus();
  }
  function closeCenter() { capture = null; C?.el.classList.remove('is-open'); }
  // #endregion

  document.addEventListener('keydown', onKeyDown, true);
  defineCommands();
  defineProviders();

  window.MSCmd = { register, provide, keysOf, run: id => commands.get(id)?.run(), openPalette, openCenter, pretty, stopShuttle, commands };
})();
