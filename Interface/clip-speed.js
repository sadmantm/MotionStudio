'use strict';
// clip-speed.js
//
//  Velocidade do clip — "Tempo de animação" no menu de contexto:
//   - HTML: time stretch (fitAnimationToClip). A animação inteira passa a
//     caber em faixa ÷ velocidade, sem processar nada.
//   - vídeo: o servidor gera a versão acelerada/desacelerada com o áudio
//     junto (libs/audio-fx.js → /api/video/speed) e o clip passa a usar essa
//     mídia, como os ajustes de áudio (audio-tools.js): preview, miniaturas,
//     transcrição e export usam o mesmo arquivo. 1× volta ao original.
//   - áudio: a velocidade do audio-tools (mantém tom, redutor etc.).
//  A duração muda e os clips seguintes da mesma track andam junto.

(() => {
  const st = () => window.__appState;
  const status = text => { const el = document.getElementById('mbStatus'); if (el) el.textContent = text; };
  const PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const MIN_DUR = 0.2;
  const round = v => Math.round(v * 100) / 100;

  const tmplOf = clip => st().templates.find(t => t.id === clip?.templateId) || null;

  /** 'html' | 'video' | 'audio' | null (texto, imagem e camadas não têm velocidade) */
  function kindOf(clip) {
    const t = tmplOf(clip);
    if (!t || clip.isText) return null;
    return ['html', 'video', 'audio'].includes(t.type) ? t.type : null;
  }

  /** Template do arquivo original (o clip pode estar numa versão acelerada) */
  function originOf(tmpl) {
    if (!tmpl?.videoSpeedOf) return tmpl;
    return st().templates.find(t => t.id === tmpl.videoSpeedOf) || tmpl;
  }

  /** Velocidade atual: HTML = faixa da animação ÷ duração; vídeo/áudio = a da mídia */
  function speedOf(clip) {
    const kind = kindOf(clip);
    if (kind === 'html') {
      if (!clip.fitAnimationToClip) return 1;
      const t = tmplOf(clip);
      const span = (Number(clip.trimEnd) || Number(t.sourceDuration) || clip.duration) - (Number(clip.trimStart) || 0);
      return span / Math.max(0.001, clip.duration);
    }
    if (kind === 'video') return Number(tmplOf(clip)?.videoSpeed) || 1;
    if (kind === 'audio') return window.MSAudioTools?.fxOf(clip).speed || 1;
    return 1;
  }

  /** Aplica `apply` em cada alvo e empurra os clips seguintes da mesma track pela diferença */
  function resize(targets, apply) {
    const ids = new Set(targets.map(c => c.id));
    const tracks = new Set(targets.map(c => Number(c.trackIndex) || 0));
    tracks.forEach(track => {
      let shift = 0;
      st().clips
        .filter(c => (Number(c.trackIndex) || 0) === track)
        .sort((a, b) => a.start - b.start)
        .forEach(c => {
          c.start = Math.max(0, c.start + shift);
          if (!ids.has(c.id)) return;
          const before = c.duration;
          apply(c);
          c.fadeIn = Math.min(Number(c.fadeIn) || 0, c.duration / 2);
          c.fadeOut = Math.min(Number(c.fadeOut) || 0, c.duration / 2);
          shift += c.duration - before;
        });
    });
  }

  // #region HTML (time stretch)
  function setHtmlSpeed(clips, speed) {
    resize(clips, c => {
      const src = Number(tmplOf(c).sourceDuration) || c.duration;
      const sourceIn = Number(c.trimStart) || 0;
      // Sem stretch, o clip mostra [trimStart, trimStart + duração] da animação
      const sourceOut = c.fitAnimationToClip ? (Number(c.trimEnd) || src) : Math.min(src, sourceIn + c.duration);
      c.fitAnimationToClip = true;
      c.trimEnd = sourceOut;
      c.duration = Math.max(MIN_DUR, (sourceOut - sourceIn) / speed);
      if (typeof normalizeClip === 'function') normalizeClip(c, Infinity);
      // Força o próximo seek (o tempo da timeline é o mesmo, o da animação mudou)
      const entry = window.__Compositor?.get(c.id);
      if (entry) entry._lastSeekSent = undefined;
    });
  }
  // #endregion

  // #region Vídeo (versão processada no servidor)
  const jobs = new Map();   // origem|velocidade → Promise<template>

  function derivedVideo(origin, speed) {
    if (speed === 1) return Promise.resolve(origin);
    const found = st().templates.find(t => t.videoSpeedOf === origin.id && t.videoSpeed === speed);
    if (found) return Promise.resolve(found);
    const key = `${origin.id}|${speed}`;
    if (jobs.has(key)) return jobs.get(key);

    const job = (async () => {
      const blob = await (await fetch(origin.dataUrl || origin.objectUrl)).blob();
      const sub = (origin.mimeType || blob.type || 'video/mp4').split('/')[1]?.split(';')[0] || 'mp4';
      const ext = sub === 'quicktime' ? 'mov' : sub === 'x-matroska' ? 'mkv' : sub;
      const resp = await fetch(`/api/video/speed?${new URLSearchParams({ ext, speed })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      const out = await resp.blob();
      const url = URL.createObjectURL(out);
      const expected = (Number(origin.sourceDuration) || 0) / speed;
      const measured = typeof probeVideoDuration === 'function' ? await probeVideoDuration(url).catch(() => 0) : 0;
      const template = {
        id: window.mkId(),
        name: `${origin.name || 'Vídeo'} (${speed}×)`,
        type: 'video',
        dataUrl: url,
        objectUrl: url,
        isObjectUrl: true,
        mimeType: out.type || 'video/mp4',
        fileSize: out.size,
        sourceDuration: measured > 0 ? measured : expected,
        fps: origin.fps,
        color: origin.color,
        res: origin.res ? { ...origin.res } : undefined,
        ...(origin.alphaPacked ? { alphaPacked: origin.alphaPacked } : {}),
        // Versão de um asset, não um asset novo: a biblioteca conta o uso pelo original
        inLibrary: false,
        libraryId: origin.libraryId || (origin.inLibrary ? origin.id : undefined),
        videoSpeedOf: origin.id,
        videoSpeed: speed,
      };
      st().templates.push(template);
      return template;
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  }

  /** Versões que nenhum clip usa saem da memória (o undo recria pelo snapshot) */
  function pruneDerived() {
    const used = new Set(st().clips.map(c => c.templateId));
    st().templates = st().templates.filter(t => !t.videoSpeedOf || used.has(t.id));
  }

  async function setVideoSpeed(clips, speed, pushUndo) {
    const byOrigin = new Map();
    clips.forEach(c => {
      const origin = originOf(tmplOf(c));
      if (!byOrigin.has(origin)) byOrigin.set(origin, []);
      byOrigin.get(origin).push(c);
    });
    const task = speed === 1 ? null : window.MSUI.task({ title: `Vídeo a ${speed}×`, detail: 'Processando no servidor…', progress: null });
    try {
      let done = 0;
      for (const [origin, list] of byOrigin) {
        task?.update({ detail: `${origin.name || 'Vídeo'} (${++done}/${byOrigin.size})` });
        const template = await derivedVideo(origin, speed);
        const live = list.filter(c => st().clips.includes(c));
        if (!live.length) continue;
        pushUndo();
        resize(live, c => {
          // f = antiga/nova: o mesmo trecho do arquivo, na base de tempo da nova versão
          const f = speedOf(c) / speed;
          c.trimStart = Math.max(0, (Number(c.trimStart) || 0) * f);
          const maxDur = Math.max(MIN_DUR, (Number(template.sourceDuration) || Infinity) - c.trimStart);
          c.duration = Math.min(maxDur, Math.max(MIN_DUR, c.duration * f));
          c.trimEnd = c.trimStart + c.duration;
          window.ClipKF?.rescaleSource(c, f);
          c.templateId = template.id;
          window.__Compositor?.unmount(c.id);
        });
      }
      pruneDerived();
      task?.done('Velocidade aplicada');
    } catch (err) {
      task?.fail(err.message || 'Falhou');
      throw err;
    }
  }
  // #endregion

  /** Muda a velocidade dos clips (ids); devolve quantos mudaram */
  async function setSpeed(ids, rawSpeed) {
    const speed = round(Math.min(4, Math.max(0.25, Number(rawSpeed) || 1)));
    const clips = ids.map(id => st().clips.find(c => c.id === id)).filter(c => kindOf(c) && Math.abs(speedOf(c) - speed) > 0.001);
    if (!clips.length) return 0;
    let undone = false;
    const pushUndo = () => { if (!undone) { window.__tlPushUndo?.(); undone = true; } };

    try {
      const html = clips.filter(c => kindOf(c) === 'html');
      if (html.length) { pushUndo(); setHtmlSpeed(html, speed); }

      const video = clips.filter(c => kindOf(c) === 'video');
      if (video.length) await setVideoSpeed(video, speed, pushUndo);

      // Áudio: cada clip mantém os outros ajustes dele (tom, redutor…)
      for (const c of clips.filter(c => kindOf(c) === 'audio')) {
        await window.MSAudioTools?.applyFx([c.id], { ...window.MSAudioTools.fxOf(c), speed });
      }
    } catch (err) {
      console.error('[Velocidade]', err);
      window.MSUI.notify(`Não foi possível mudar a velocidade.\n\n${err.message}`);
    }

    if (typeof recalcProjectDuration === 'function') recalcProjectDuration();
    window.refreshEditorAfterProjectChange?.({ mount: true, seek: false });
    window.__syncCompositorToTime?.(st().time);
    status(`⏱ Velocidade ${speed}× em ${clips.length} clip(s)`);
    return clips.length;
  }

  async function askCustom(ids) {
    const first = st().clips.find(c => c.id === ids[0]);
    const value = await window.MSUI.prompt({
      title: 'Tempo de animação',
      label: 'Velocidade (0,25× a 4×)',
      value: String(round(first ? speedOf(first) : 1)).replace('.', ','),
      confirmLabel: 'Aplicar',
      maxLength: 6,
    });
    if (value == null) return;
    const speed = Number(String(value).replace(',', '.').replace(/[×x\s]/gi, ''));
    if (!Number.isFinite(speed) || speed <= 0) return window.MSUI.notify('Velocidade inválida.');
    return setSpeed(ids, speed);
  }

  /** Itens do submenu: presets + personalizado (✓ na velocidade atual) */
  function menuItems(ids) {
    const first = st().clips.find(c => c.id === ids[0]);
    const current = first ? round(speedOf(first)) : 1;
    return [
      ...PRESETS.map(s => ({ label: `${s === current ? '✓ ' : ''}${s}×${s === 1 ? ' (normal)' : ''}`, run: () => setSpeed(ids, s) })),
      { label: `Personalizado…${PRESETS.includes(current) ? '' : ` (${current}×)`}`, run: () => askCustom(ids) },
    ];
  }

  window.MSClipSpeed = { setSpeed, speedOf, kindOf, menuItems, askCustom };
})();
