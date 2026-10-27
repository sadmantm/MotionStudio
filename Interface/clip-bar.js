'use strict';
// clip-bar.js
//
//  Barra de ações flutuante junto ao(s) clip(s) selecionado(s) na timeline: as ações do
//  momento (dividir na agulha, duplicar, silenciar, efeitos, excluir) ficam a um clique do
//  clip, sem ir ao menu de contexto nem procurar o atalho. Some enquanto se arrasta/apara.

(() => {
  const st = () => window.__appState;
  let bar = null;
  let raf = 0;
  let dragging = false;

  const ids = () => [...(window.__selectedClipIds || [])].filter(id => st().clips.some(c => c.id === id));
  const tmplOf = c => st().templates.find(t => t.id === c.templateId);
  const key = id => { const k = window.MSCmd?.keysOf(id)?.[0]; return k ? ` (${window.MSCmd.pretty(k)})` : ''; };

  const ICON = {
    split: '<path d="M12 2v20M3 8l4 4-4 4M21 8l-4 4 4 4"/>',
    dup: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    mute: '<path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/>',
    sound: '<path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"/>',
    fx: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"/>',
    del: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  };
  const btn = (act, title, icon, danger = false) =>
    `<button type="button" class="cb-btn${danger ? ' is-danger' : ''}" data-cb="${act}" title="${title}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></button>`;

  function build() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'clip-bar';
    bar.hidden = true;
    document.body.appendChild(bar);
    bar.addEventListener('mousedown', e => e.stopPropagation());
    bar.addEventListener('click', onClick);
    return bar;
  }

  function paint(selected) {
    const clips = selected.map(id => st().clips.find(c => c.id === id));
    const hasAudio = clips.some(c => ['audio', 'video'].includes(tmplOf(c)?.type));
    const allMuted = hasAudio && clips.filter(c => ['audio', 'video'].includes(tmplOf(c)?.type)).every(c => c.muted);
    const canSplit = clips.some(c => st().time > c.start + 0.1 && st().time < c.start + c.duration - 0.1);
    const visual = clips.some(c => tmplOf(c)?.type !== 'audio');
    bar.innerHTML =
      `<span class="cb-count">${selected.length > 1 ? `${selected.length} clips` : ''}</span>` +
      (canSplit ? btn('split', `Dividir na agulha${key('split')}`, ICON.split) : '') +
      btn('dup', `Duplicar${key('duplicate')}`, ICON.dup) +
      (hasAudio ? btn('mute', allMuted ? 'Ativar o som' : 'Silenciar', allMuted ? ICON.sound : ICON.mute) : '') +
      (visual ? btn('fx', 'Efeitos e transições (biblioteca)', ICON.fx) : '') +
      btn('del', `Excluir${key('delete')}`, ICON.del, true);
  }

  function place() {
    raf = 0;
    if (!bar) return;
    const selected = ids();
    if (!selected.length || dragging || !st().project || document.body.classList.contains('tl-kf-dragging')) { bar.hidden = true; return; }
    const blocks = selected.map(id => document.querySelector(`#tlTracks .tl-block[data-clip-id="${CSS.escape(id)}"]`)).filter(Boolean);
    const scroll = document.getElementById('tlScroll')?.getBoundingClientRect();
    if (!blocks.length || !scroll) { bar.hidden = true; return; }
    const rects = blocks.map(b => b.getBoundingClientRect());
    const left = Math.min(...rects.map(r => r.left));
    const right = Math.max(...rects.map(r => r.right));
    const top = Math.min(...rects.map(r => r.top));
    // Fora da janela visível da timeline: some
    if (right < scroll.left + 8 || left > scroll.right - 8 || top > scroll.bottom || top < scroll.top - 4) { bar.hidden = true; return; }
    paint(selected);
    bar.hidden = false;
    const w = bar.offsetWidth;
    const cx = Math.min(Math.max((Math.max(left, scroll.left) + Math.min(right, scroll.right)) / 2 - w / 2, scroll.left + 6), scroll.right - w - 6);
    // Acima do bloco; sem espaço (primeira track), logo abaixo dele
    const above = top - bar.offsetHeight - 6;
    const bottom = Math.max(...rects.map(r => r.bottom));
    bar.style.left = `${cx}px`;
    bar.style.top = `${above > scroll.top + 28 ? above : Math.min(bottom + 6, scroll.bottom - bar.offsetHeight - 4)}px`;
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };

  function onClick(e) {
    const b = e.target.closest('[data-cb]');
    if (!b) return;
    const a = b.dataset.cb;
    if (a === 'split') window.MSCmd?.run('split');
    if (a === 'dup') window.MSCmd?.run('duplicate');
    if (a === 'del') window.MSCmd?.run('delete');
    if (a === 'fx') document.querySelector('.ptab[data-tab="effects"]')?.click();
    if (a === 'mute') {
      const clips = ids().map(id => st().clips.find(c => c.id === id)).filter(c => ['audio', 'video'].includes(tmplOf(c)?.type));
      const mute = !clips.every(c => c.muted);
      window.__tlPushUndo?.();
      clips.forEach(c => { c.muted = mute; if (typeof refreshClipBlock === 'function') refreshClipBlock(c.id); });
      window.__syncCompositorToTime?.(st().time);
      window.__renderProps?.();
    }
    schedule();
  }

  function boot() {
    build();
    // seleção: encadeia com o ouvinte já existente (transform.js)
    const prev = window.__onSelectionChange;
    window.__onSelectionChange = function (sel) { try { prev?.apply(this, arguments); } finally { schedule(); } };
    const tracks = document.getElementById('tlTracks');
    const scroll = document.getElementById('tlScroll');
    scroll?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    if (tracks) new MutationObserver(schedule).observe(tracks, { childList: true, subtree: false });
    // Esconde durante arrastar/aparar
    tracks?.addEventListener('mousedown', e => { if (e.target.closest('.tl-block')) { dragging = true; bar.hidden = true; } }, true);
    document.addEventListener('mouseup', () => { if (dragging) { dragging = false; setTimeout(schedule, 60); } });
    // O tempo mudou (o botão Dividir depende da agulha) e as medidas do clip
    const upd = window.__updatePlayhead;
    window.__updatePlayhead = function () { const r = upd?.apply(this, arguments); if (!st().playing) schedule(); return r; };
    schedule();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
