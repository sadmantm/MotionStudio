'use strict';
// clip-lint-ui.js
//
//  Diagnóstico dos clipes HTML (libs/clip-lint.js) no editor:
//    • seção "Diagnóstico" nas propriedades do clipe, com código, explicação,
//      linha e dica; "Corrigir com IA" abre a barra de IA já com o pedido;
//    • checagem antes do export: erro (ex.: script com erro de sintaxe) pede
//      confirmação, listando os clipes e os problemas.

(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const ICON = { error: '✕', warning: '!', info: 'i' };
  const LABEL = { error: 'erro', warning: 'aviso', info: 'info' };
  const cache = new Map();   // html → resultado

  function lintOf(html) {
    if (!window.ClipLint) return null;
    let r = cache.get(html);
    if (!r) {
      r = window.ClipLint.lint(html);
      if (cache.size > 80) cache.delete(cache.keys().next().value);
      cache.set(html, r);
    }
    return r;
  }

  const isLintable = (clip, tmpl) => tmpl?.type === 'html' && !clip?.isText && typeof tmpl.html === 'string';

  /** Pedido para a barra de IA a partir dos problemas (sem os informativos) */
  function fixPrompt(result) {
    const items = result.findings.filter(f => f.severity !== 'info');
    return 'Corrija estes problemas do clipe sem mudar o visual nem o tempo da animação:\n' +
      items.map(f => `- [${f.code}${f.line ? `, linha ${f.line}` : ''}] ${f.message} ${f.fix}`).join('\n');
  }

  function renderLintProps(clip, tmpl) {
    if (!isLintable(clip, tmpl)) return '';
    const r = lintOf(tmpl.html);
    if (!r) return '';
    const shown = r.findings.filter(f => f.severity !== 'info');
    const infos = r.findings.filter(f => f.severity === 'info');
    const summary = r.errors
      ? `${r.errors} erro(s)${r.warnings ? ` · ${r.warnings} aviso(s)` : ''}`
      : r.warnings ? `${r.warnings} aviso(s)` : 'Sem problemas';
    const state = r.errors ? 'error' : r.warnings ? 'warning' : 'ok';
    const item = f => `
      <li class="lint-item" data-severity="${f.severity}">
        <span class="lint-badge" aria-label="${LABEL[f.severity]}">${ICON[f.severity]}</span>
        <div>
          <div class="lint-msg">${esc(f.message)}</div>
          <div class="lint-fix">${esc(f.fix)}</div>
          <div class="lint-code">${esc(f.code)}${f.line ? ` · linha ${f.line}` : ''}</div>
        </div>
      </li>`;
    return `
      <div class="prop-section lint-section" data-lint-clip="${esc(clip.id)}">
        <div class="prop-title">Diagnóstico <span class="lint-summary" data-state="${state}">${esc(summary)}</span></div>
        ${shown.length ? `<ul class="lint-list">${shown.map(item).join('')}</ul>` : ''}
        ${infos.length ? `<ul class="lint-list is-info">${infos.map(item).join('')}</ul>` : ''}
        ${shown.length && typeof window.__onClipAIEdit === 'function'
          ? '<button type="button" class="lint-fix-btn" data-lint-action="fix">Corrigir com IA</button>'
          : ''}
      </div>`;
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-lint-action="fix"]');
    if (!btn) return;
    const clipId = btn.closest('[data-lint-clip]')?.dataset.lintClip;
    const state = window.__appState;
    const clip = state?.clips.find(c => c.id === clipId);
    const tmpl = clip && state.templates.find(t => t.id === clip.templateId);
    if (!isLintable(clip, tmpl)) return;
    window.__onClipAIEdit(clipId, { prompt: fixPrompt(lintOf(tmpl.html)) });
  });

  /**
   * Antes do export: clipes HTML com erro → confirmação com a lista.
   * Resolve true para seguir. Avisos não interrompem.
   */
  async function checkBeforeExport() {
    const state = window.__appState;
    if (!state || !window.ClipLint) return true;
    const problems = [];
    const seen = new Set();
    state.clips.forEach(clip => {
      const tmpl = state.templates.find(t => t.id === clip.templateId);
      if (!isLintable(clip, tmpl) || seen.has(tmpl.id)) return;
      seen.add(tmpl.id);
      const errors = lintOf(tmpl.html).findings.filter(f => f.severity === 'error');
      if (errors.length) problems.push({ clip, errors });
    });
    if (!problems.length) return true;
    const body = `
      <p class="ui-dialog-msg">${problems.length === 1 ? 'Um clipe tem erro' : `${problems.length} clipes têm erros`} que costumam deixar o vídeo errado (clipe parado ou em branco):</p>
      <ul class="lint-export-list">
        ${problems.map(p => `<li><b>${esc(p.clip.label || 'Clipe')}</b><ul>${p.errors.map(f => `<li>${esc(f.message)} <span class="lint-code">${esc(f.code)}${f.line ? ` · linha ${f.line}` : ''}</span></li>`).join('')}</ul></li>`).join('')}
      </ul>
      <p class="ui-dialog-msg">Selecione o clipe e use <b>Diagnóstico → Corrigir com IA</b>, ou exporte assim mesmo.</p>`;
    const d = window.MSUI.dialog({
      title: 'Clipes com erro',
      bodyHtml: body,
      confirmLabel: 'Exportar assim mesmo',
      cancelLabel: 'Voltar e corrigir',
      onReady: (el, close) => el.querySelector('[data-ui="ok"]').addEventListener('click', () => close(true)),
    });
    return (await d.promise) === true;
  }

  window.__renderLintProps = renderLintProps;
  window.MSLint = { lint: lintOf, checkBeforeExport, fixPrompt };
})();
