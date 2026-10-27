'use strict';
// matting-ui.js
//
//  "Remover fundo" nas propriedades de um clip de vídeo ou imagem
//  (servidor: libs/matting.js + libs/matting.py, RVM). Roda no computador:
//  imagem leva segundos, vídeo alguns minutos (cartão de progresso com
//  Cancelar). Pronto, o clip passa a usar um asset novo "<nome> (sem fundo)"
//  — o original continua na biblioteca e "Voltar ao original" desfaz.
//  Vídeo sem fundo é MP4 com cor | alpha lado a lado (media-fx.js desempacota).

(() => {
  const st = () => window.__appState;
  const esc = s => (window.escapeHtml ? window.escapeHtml(String(s ?? '')) : String(s ?? ''));
  const running = new Map();   // template.id → jobId

  function renderMattingProps(clip, tmpl) {
    if (!clip || !tmpl || (tmpl.type !== 'video' && tmpl.type !== 'image') || tmpl.layer) return '';
    const removed = Boolean(tmpl.sourceTemplateId);
    const busy = running.has(tmpl.id);
    return `
      <div class="prop-section matte-props" data-clip-id="${esc(clip.id)}">
        <div class="prop-title">Fundo</div>
        ${removed ? `
          <p class="matte-note">Fundo removido. O original continua na biblioteca.</p>
          <button type="button" class="matte-btn is-secondary" data-matte="restore">Voltar ao original</button>`
        : `
          <button type="button" class="matte-btn" data-matte="run"${busy ? ' disabled' : ''}>${busy ? 'Removendo o fundo…' : 'Remover fundo (IA)'}</button>
          <p class="matte-note">Funciona melhor com pessoas. Roda no seu computador: imagem em segundos, vídeo em alguns minutos.</p>`}
      </div>`;
  }

  async function run(clip) {
    const state = st();
    const tmpl = state.templates.find(t => t.id === clip.templateId);
    const projectId = window.MSProjects?.currentId?.();
    if (!tmpl || !projectId) return;
    if (!tmpl.mediaFile) await window.MSProjects.persistMedia(tmpl).catch(() => {});
    if (!tmpl.mediaFile) {
      window.MSUI.toast({ message: 'A mídia ainda não foi salva no projeto. Tente de novo em instantes.', kind: 'error' });
      return;
    }
    let jobId;
    try {
      const r = await fetch(`/api/projects/${projectId}/media/${encodeURIComponent(tmpl.mediaFile)}/matte`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      jobId = data.jobId;
    } catch (err) {
      window.MSUI.toast({ message: `Não foi possível começar: ${err.message}`, kind: 'error' });
      return;
    }
    running.set(tmpl.id, jobId);
    window.__renderProps?.();
    const task = window.MSUI.task({
      title: `Removendo o fundo de "${tmpl.name}"`,
      detail: 'Preparando…',
      progress: 0,
      onCancel: () => fetch(`/api/matte/${jobId}/cancel`, { method: 'POST' }).catch(() => {}),
    });
    const tick = async () => {
      let info;
      try {
        info = await (await fetch(`/api/matte/${jobId}`)).json();
      } catch (_) {
        return setTimeout(tick, 1500);
      }
      if (info.status === 'running') {
        task.update({ detail: info.stage, progress: info.progress || 0 });
        return setTimeout(tick, 1000);
      }
      running.delete(tmpl.id);
      if (info.status === 'done') {
        apply(clip.id, tmpl, info, projectId);
        task.done('Fundo removido');
      } else if (info.status === 'error') {
        task.fail(info.error || 'Falha ao remover o fundo');
      }
      window.__renderProps?.();
    };
    tick();
  }

  /** Asset novo "(sem fundo)" e o clip passa a usá-lo */
  function apply(clipId, tmpl, info, projectId) {
    const state = st();
    if (window.MSProjects?.currentId?.() !== projectId) return;
    const clip = state.clips.find(c => c.id === clipId);
    window.__tlPushUndo?.();
    const nobg = {
      ...tmpl,
      id: window.mkId ? window.mkId() : `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: `${tmpl.name} (sem fundo)`,
      dataUrl: info.url,
      mediaUrl: info.url,
      mediaFile: info.file,
      objectUrl: null,
      isObjectUrl: false,
      proxyUrl: undefined,
      proxyFile: undefined,
      mimeType: info.image ? 'image/png' : 'video/mp4',
      alphaPacked: info.image ? null : 'sbs',
      sourceTemplateId: tmpl.id,
      sourceFile: tmpl.mediaFile,
    };
    state.templates.push(nobg);
    if (clip) clip.templateId = nobg.id;
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: true });
    if (clip) window.remountClip?.(clip.id);
  }

  function restore(clip) {
    const state = st();
    const tmpl = state.templates.find(t => t.id === clip.templateId);
    const original = tmpl && state.templates.find(t => t.id === tmpl.sourceTemplateId);
    if (!original) return;
    window.__tlPushUndo?.();
    clip.templateId = original.id;
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: true });
    window.remountClip?.(clip.id);
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('.matte-props [data-matte]');
    if (!btn) return;
    const clip = st()?.clips.find(c => c.id === btn.closest('.matte-props').dataset.clipId);
    if (!clip) return;
    if (btn.dataset.matte === 'run') run(clip);
    else restore(clip);
  });

  window.__renderMattingProps = renderMattingProps;
})();
