'use strict';
// audio-extract.js
//
//  "Extrair áudio" de um clip:
//   - vídeo: o servidor tira a faixa de áudio do arquivo; o vídeo fica mudo e o
//     áudio vira um clip próprio numa track logo abaixo, no mesmo trecho
//   - HTML: sintetiza os efeitos sonoros declarados em Motion.sfx (libs/sfx.js)
//   - "Gerar efeitos sonoros com IA": a IA analisa os clips (código HTML ou
//     quadros do vídeo) e o contexto da timeline e devolve as deixas de som
//  O clip de áudio fica ligado à origem (linkedClipId + audioClipId para o áudio
//  extraído, sfxClipId para os efeitos): repetir — ou a IA editar o clipe —
//  atualiza o mesmo áudio em vez de duplicar.

(() => {
  const appState = () => window.__appState;
  const status = text => { const el = document.getElementById('mbStatus'); if (el) el.textContent = text; };
  const newId = () => (window.mkId ? window.mkId() : Math.random().toString(36).slice(2));
  const typeOf = clip => appState().templates.find(t => t.id === clip?.templateId)?.type;
  const trackOf = clip => Number(clip?.trackIndex) || 0;

  function overlaps(a0, a1, b0, b1) {
    return a0 < b1 - 1e-4 && b0 < a1 - 1e-4;
  }

  /**
   * Track para o áudio de `source`: a de baixo se estiver livre no trecho e só
   * tiver áudio; senão abre uma track nova logo abaixo (a origem sobe uma).
   */
  function trackBelow(source) {
    const st = appState();
    const below = trackOf(source) - 1;
    if (below >= 0) {
      const locked = st.tracks?.find(t => t.index === below)?.locked;
      const onTrack = st.clips.filter(c => trackOf(c) === below);
      const free = !onTrack.some(c => overlaps(c.start, c.start + c.duration, source.start, source.start + source.duration));
      if (!locked && free && onTrack.every(c => typeOf(c) === 'audio')) return below;
    }
    const at = trackOf(source);
    window.__insertTrackAt(at);   // a origem passa para at + 1
    return at;
  }

  /** Cria ou atualiza o clip de áudio ligado a `source` (link: 'audioClipId' | 'sfxClipId') */
  function upsertLinkedAudio(source, template, clipFields, link = 'audioClipId') {
    const st = appState();
    // Áudio extraído vira asset da biblioteca; a faixa de efeitos sonoros, não
    template.inLibrary = link === 'audioClipId';
    st.templates.push(template);
    const existing = st.clips.find(c => c.id === source[link] && c.linkedClipId === source.id);
    if (existing) {
      existing.templateId = template.id;
      Object.assign(existing, clipFields, { trackIndex: existing.trackIndex });
      window.__Compositor?.unmount(existing.id);
      return existing;
    }
    const clip = {
      id: newId(),
      templateId: template.id,
      color: template.color,
      linkedClipId: source.id,
      ...clipFields,
      trackIndex: trackBelow(source),
    };
    st.clips.push(window.normalizeClip ? window.normalizeClip(clip) : clip);
    window.getTrack?.(clip.trackIndex);
    source[link] = clip.id;
    return clip;
  }

  function refresh() {
    if (window.refreshEditorAfterProjectChange) window.refreshEditorAfterProjectChange({ mount: true, seek: false });
    else { window.recalcProjectDuration?.(); window.__renderTimeline?.(); window.mountAllClips?.(); }
    window.__syncCompositorToTime?.(appState().time);
  }

  // #region Vídeo
  async function extractVideoAudio(clip, tmpl) {
    const st = appState();
    status('Extraindo áudio do vídeo…');
    const blob = await (await fetch(tmpl.dataUrl || tmpl.objectUrl)).blob();
    const rawExt = (tmpl.mimeType || blob.type || 'video/mp4').split('/')[1]?.split(';')[0] || 'mp4';
    const resp = await fetch(`/api/audio/extract?ext=${encodeURIComponent(rawExt)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const audioBlob = await resp.blob();
    const url = URL.createObjectURL(audioBlob);

    window.__tlPushUndo?.();
    const template = {
      id: newId(),
      name: `${tmpl.name || clip.label} (áudio)`,
      type: 'audio',
      dataUrl: url,
      objectUrl: url,
      isObjectUrl: true,
      mimeType: audioBlob.type || 'audio/mp4',
      fileSize: audioBlob.size,
      sourceDuration: Number(tmpl.sourceDuration) || clip.duration,
      fps: st.project.fps,
      color: clip.color,
    };
    // Mesmo trecho da origem: cortar/mover depois continua alinhado
    const audio = upsertLinkedAudio(clip, template, {
      label: `${clip.label} (áudio)`,
      start: clip.start,
      duration: clip.duration,
      trimStart: Number(clip.trimStart) || 0,
      trimEnd: Number(clip.trimEnd) || (Number(clip.trimStart) || 0) + clip.duration,
      volume: clip.volume ?? 1,
      fadeIn: clip.fadeIn || 0,
      fadeOut: clip.fadeOut || 0,
      muted: false,
    });
    clip.muted = true;          // o som agora vem do clip de áudio
    clip.audioExtracted = true;
    refresh();
    status(`Áudio extraído para a track V${trackOf(audio) + 1} · o vídeo ficou mudo`);
    return audio;
  }
  // #endregion

  // #region HTML (efeitos sonoros)
  /**
   * Converte o tempo de uma deixa (segundos do HTML) para o tempo dentro do
   * clip, respeitando corte (trimStart) e time stretch (ajustar ao clip).
   */
  function cueOffset(clip, tmpl, t) {
    const trimStart = Number(clip.trimStart) || 0;
    if (clip.fitAnimationToClip && tmpl.type === 'html' && !clip.isText) {
      const sourceEnd = Number(clip.trimEnd) || Number(tmpl.sourceDuration) || clip.duration;
      const span = Math.max(0.001, sourceEnd - trimStart);
      return (t - trimStart) * clip.duration / span;
    }
    return t - trimStart;
  }

  /**
   * Sintetiza `cues` (já em segundos do clip na timeline) numa faixa ligada a
   * `clip` por sfxClipId. → número de sons usados.
   */
  async function renderSfxTrack(clip, cues, { pushUndo = false, pack = null, credits = null } = {}) {
    const st = appState();
    const placed = cues.filter(c => c.t >= 0 && c.t < clip.duration);
    if (!placed.length) return 0;
    const stats = {};
    const buffer = await window.MotionSFX.render(placed, clip.duration, { stats });
    if (!st.clips.includes(clip) || !stats.used) return 0;   // apagado enquanto renderizava / nada tocou
    const wav = window.MotionSFX.toWav(buffer);
    const url = URL.createObjectURL(wav);
    if (pushUndo) window.__tlPushUndo?.();
    const template = {
      id: newId(),
      name: `Sons · ${clip.label}`,
      type: 'audio',
      dataUrl: url,
      objectUrl: url,
      isObjectUrl: true,
      mimeType: 'audio/wav',
      fileSize: wav.size,
      sourceDuration: clip.duration,
      fps: st.project.fps,
      color: clip.color,
      sfxCues: stats.used,
      sfxPack: pack,
      // Sons do Openverse usados aqui (título, autor, licença): CC BY pede crédito
      ...(credits?.length ? { sfxCredits: credits } : {}),
    };
    upsertLinkedAudio(clip, template, {
      label: `🔊 ${clip.label}`,
      start: clip.start,
      duration: clip.duration,
      trimStart: 0,
      trimEnd: clip.duration,
    }, 'sfxClipId');
    return stats.used;
  }

  /** → número de sons criados (0 = o clipe não declara Motion.sfx) */
  async function buildHtmlSfx(clip, tmpl, { quiet = false } = {}) {
    if (!window.MotionSFX) throw new Error('Sintetizador de efeitos não carregado.');
    if (!quiet) status('Lendo os efeitos sonoros do clipe…');
    const cues = await window.MotionSFX.readCues(tmpl.html);
    if (!appState().clips.includes(clip)) return 0;
    if (cues.error) {
      if (!quiet) status(`O script do clipe quebra ao animar (${cues.error}) — corrija o clipe antes dos sons`);
      return 0;
    }
    const placed = cues.map(c => ({ ...c, t: cueOffset(clip, tmpl, c.t) }));
    const n = await renderSfxTrack(clip, placed, { pushUndo: !quiet });
    if (!n) {
      if (!quiet) status('Este clipe não declara efeitos sonoros — use "Gerar efeitos sonoros com IA"');
      return 0;
    }
    refresh();
    if (!quiet) status(`${n} efeito(s) sonoro(s) na track abaixo do clipe`);
    return n;
  }
  // #endregion

  // #region Efeitos sonoros com IA
  const SFX_BATCH = 6;

  /** Quadros JPEG pequenos de um vídeo/imagem nos instantes do clip (t = s desde o início do clip) */
  async function captureFrames(clip, tmpl, count = 6) {
    const W = 320;
    const canvas = document.createElement('canvas');
    const ctx2d = canvas.getContext('2d');
    const shot = (el, w, h) => {
      canvas.width = W;
      canvas.height = Math.max(1, Math.round(W * h / w));
      ctx2d.drawImage(el, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.7);
    };
    if (tmpl.type === 'image') {
      const img = new Image();
      img.src = tmpl.dataUrl;
      await img.decode();
      return [{ t: 0, dataUrl: shot(img, img.naturalWidth, img.naturalHeight) }];
    }
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = tmpl.dataUrl || tmpl.objectUrl;
    await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error('vídeo ilegível')); setTimeout(() => fail(new Error('vídeo demorou a carregar')), 15000); });
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) * clip.duration / count;
      video.currentTime = (Number(clip.trimStart) || 0) + t;
      await new Promise(ok => { video.onseeked = ok; setTimeout(ok, 4000); });
      frames.push({ t: +t.toFixed(2), dataUrl: shot(video, video.videoWidth, video.videoHeight) });
    }
    video.removeAttribute('src');
    video.load();
    return frames;
  }

  /** O que está ao redor dos clips: vizinhos, falas (legendas) e se há narração/música */
  function timelineContext(clips) {
    const st = appState();
    const ids = new Set(clips.map(c => c.id));
    const t0 = Math.min(...clips.map(c => c.start)) - 1;
    const t1 = Math.max(...clips.map(c => c.start + c.duration)) + 1;
    const near = st.clips.filter(c => !ids.has(c.id) && c.start < t1 && t0 < c.start + c.duration);
    const kind = c => (c.isText ? 'texto' : typeOf(c) || 'clip');
    const local = 0;   // tempos absolutos da timeline (o prompt informa onde cada clip está)
    return {
      neighbors: near.filter(c => !c.captionGroupId && !c.linkedClipId).map(c => ({
        label: c.label, kind: kind(c), track: trackOf(c),
        start: +(c.start - local).toFixed(2), end: +(c.start + c.duration - local).toFixed(2),
      })),
      speech: near.filter(c => c.captionGroupId).map(c => ({
        text: st.templates.find(t => t.id === c.templateId)?.textParams?.text || c.label,
        start: +(c.start - local).toFixed(2), end: +(c.start + c.duration - local).toFixed(2),
      })),
      narration: near.some(c => typeOf(c) === 'audio' && !st.templates.find(t => t.id === c.templateId)?.sfxCues)
        || near.some(c => typeOf(c) === 'video' && !c.muted),
    };
  }

  async function sfxPayload(clip) {
    const tmpl = appState().templates.find(t => t.id === clip.templateId);
    const base = { id: clip.id, label: clip.label, duration: +clip.duration.toFixed(3), start: +clip.start.toFixed(3) };
    if (tmpl.type === 'html') {
      const trimStart = Number(clip.trimStart) || 0;
      const sourceEnd = clip.fitAnimationToClip ? (Number(clip.trimEnd) || tmpl.sourceDuration) : trimStart + clip.duration;
      return { ...base, kind: 'html', html: tmpl.html, timeBase: 'source', sourceStart: trimStart, sourceEnd: +sourceEnd.toFixed(3) };
    }
    return { ...base, kind: tmpl.type, frames: await captureFrames(clip, tmpl), timeBase: 'clip' };
  }

  /** POST NDJSON → evento 'done' (status vai para a barra de status) */
  async function streamAi(url, body) {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { code: data.code });
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    const handle = line => {
      if (!line.trim()) return;
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw Object.assign(new Error(ev.error), { code: ev.code });
      if (ev.type === 'done') done = ev;
      else if (ev.type === 'status') status(`🔊 ${ev.message}`);
    };
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    handle(buf + decoder.decode());
    if (!done) throw new Error('A resposta terminou antes do fim.');
    return done;
  }

  let sfxBusy = false;

  /**
   * "Gerar efeitos sonoros com IA": analisa os clips visuais e cria uma faixa
   * de sons ligada a cada um (substitui a anterior). Um passo de undo.
   */
  window.__aiSfxForClips = async function aiSfxForClips(clipIds, { prompt = '' } = {}) {
    const st = appState();
    if (sfxBusy) return status('🔊 Já estou gerando efeitos sonoros — aguarde');
    const clips = clipIds.map(id => st.clips.find(c => c.id === id)).filter(c => c && window.__canAiSfx(c));
    if (!clips.length) return status('Selecione clips de vídeo, imagem ou HTML para gerar efeitos sonoros');
    sfxBusy = true;
    let total = 0;
    let done = 0;
    let pack = null;
    let undoPushed = false;
    const openverse = new Set();
    const attributions = new Set();
    try {
      status(`🔊 Preparando ${clips.length} clip(s)…`);
      for (let i = 0; i < clips.length; i += SFX_BATCH) {
        const batch = clips.slice(i, i + SFX_BATCH);
        const payload = await Promise.all(batch.map(sfxPayload));
        const res = await streamAi('/api/ai/sfx', {
          clips: payload,
          context: timelineContext(batch),
          pack,
          prompt,
          project: { w: st.project.res.w, h: st.project.res.h, fps: st.project.fps },
        });
        pack = pack || res.pack;
        window.MotionSFX.addExternal(res.external);
        for (const item of res.clips) {
          const clip = st.clips.find(c => c.id === item.id);
          const tmpl = clip && st.templates.find(t => t.id === clip.templateId);
          if (!tmpl) continue;
          const cues = window.MotionSFX.normalizeCues(item.cues)
            .map(c => ({ ...c, t: tmpl.type === 'html' ? cueOffset(clip, tmpl, c.t) : c.t }));
          if (!undoPushed) { window.__tlPushUndo?.(); undoPushed = true; }
          const credits = [...new Set(cues.filter(c => res.external?.[c.sound]).map(c => c.sound))].map(id => ({ id, ...res.external[id] }));
          credits.forEach(c => { openverse.add(c.id); if (c.attribution) attributions.add(c.attribution); });
          const n = await renderSfxTrack(clip, cues, { pack, credits });
          total += n;
          if (n) done++;
        }
      }
      refresh();
      status(total
        ? `🔊 ${total} efeitos sonoros em ${done} clip(s)${pack ? ` · pacote ${pack}` : ''}${openverse.size ? ` · ${openverse.size} do Openverse` : ''}${attributions.size ? ` · crédito necessário (CC BY): ${[...attributions].join(' ')}` : ''}`
        : '🔊 A IA não sugeriu sons para esses clips');
      return { total, clips: done, pack };
    } catch (err) {
      console.error('[Áudio] Efeitos sonoros com IA:', err);
      if (undoPushed) refresh();
      status(`🔊 Falha: ${err.message}`);
      window.MSUI.notify(`Não foi possível gerar os efeitos sonoros:\n${err.message}`);
      return { total, clips: done, pack, error: err.message };
    } finally {
      sfxBusy = false;
    }
  };

  window.__canAiSfx = clip => {
    const type = typeOf(clip);
    return type === 'video' || type === 'image' || (type === 'html' && !clip?.isText);
  };
  // #endregion

  /** Context menu / atalho: escolhe o caminho pelo tipo do clip */
  window.__extractClipAudio = async function extractClipAudio(clipId) {
    const st = appState();
    const clip = st?.clips.find(c => c.id === clipId);
    const tmpl = clip && st.templates.find(t => t.id === clip.templateId);
    if (!clip || !tmpl) return;
    try {
      if (tmpl.type === 'video') return await extractVideoAudio(clip, tmpl);
      if (tmpl.type === 'html' && !clip.isText) return await buildHtmlSfx(clip, tmpl);
      status('Extrair áudio funciona em clips de vídeo e HTML');
    } catch (err) {
      console.error('[Áudio] Falha ao extrair:', err);
      status(`Falha ao extrair áudio: ${err.message}`);
      window.MSUI.notify(`Não foi possível extrair o áudio:\n${err.message}`);
    }
  };

  /** Usado pela IA após criar/editar um clipe com sons (sem passo de undo próprio) */
  window.__buildClipSfx = async function buildClipSfx(clipId, opts = {}) {
    const st = appState();
    const clip = st?.clips.find(c => c.id === clipId);
    const tmpl = clip && st.templates.find(t => t.id === clip.templateId);
    if (!clip || tmpl?.type !== 'html') return 0;
    try {
      return await buildHtmlSfx(clip, tmpl, { quiet: true, ...opts });
    } catch (err) {
      console.warn('[Áudio] Efeitos sonoros:', err.message);
      return 0;
    }
  };

  window.__canExtractAudio = clip => {
    const type = typeOf(clip);
    return type === 'video' || (type === 'html' && !clip?.isText);
  };
})();
