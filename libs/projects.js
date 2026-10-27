'use strict';
// projects.js
//
//  Biblioteca de projetos do editor (tela inicial estilo CapCut). Cada projeto
//  é uma pasta:
//    <id>/project.json   timeline completa (templates, clips, tracks, editor)
//    <id>/meta.json      resumo para a lista (nome, datas, resolução, duração)
//    <id>/media/<arq>    vídeos, áudios e imagens importados (cópia do arquivo)
//    <id>/thumb.<ext>    capa do projeto na lista
//  O HTML dos clipes fica dentro do project.json; as mídias, como arquivo,
//  referenciadas por /api/projects/<id>/media/<arq>.
//  Pasta: MS_PROJECTS_DIR (app desktop: dados do usuário) ou <app>/projects.

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ID_RE        = /^p_[a-z0-9]{6,32}$/;
const MEDIA_RE     = /^[\w.-]{1,160}$/;
const THUMB_EXTS   = ['webp', 'jpg', 'png'];
const MAX_UPLOAD   = 8 * 1024 ** 3;   // 8 GB por arquivo de mídia

function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Nome de arquivo seguro, único na pasta, preservando a extensão */
function uniqueMediaName(dir, original) {
  const ext  = (path.extname(String(original || '')).toLowerCase().match(/^\.[a-z0-9]{1,6}$/) || [''])[0];
  const base = path.basename(String(original || 'media'), path.extname(String(original || '')))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 60) || 'media';
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  return name;
}

/** Escrita atômica: um save interrompido nunca deixa o project.json pela metade */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, file);
}

async function readJson(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

function metaFrom(id, payload, previous = {}) {
  const project = payload.project || {};
  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  const duration = clips.reduce((max, c) => Math.max(max, (Number(c.start) || 0) + (Number(c.duration) || 0)), 0);
  return {
    id,
    name: String(project.name || previous.name || 'Projeto sem título').slice(0, 120),
    createdAt: project.createdAt || previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    res: { w: Number(project.res?.w) || 1080, h: Number(project.res?.h) || 1920 },
    fps: Number(project.fps) || 30,
    duration,
    clipCount: clips.length,
    mediaCount: (payload.templates || []).filter(t => t && t.type !== 'text').length,
  };
}

function register(app, { root } = {}) {
  const baseDir = path.resolve(process.env.MS_PROJECTS_DIR || path.join(root, 'projects'));
  const trashDir = path.join(baseDir, '.trash');
  fs.mkdirSync(baseDir, { recursive: true });

  const dirOf = id => path.join(baseDir, id);
  const mediaUrl = (id, file) => `/api/projects/${id}/media/${encodeURIComponent(file)}`;

  /** Valida o :id e confirma que a pasta existe */
  function projectDir(req, res) {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id) || !fs.existsSync(path.join(dirOf(id), 'project.json'))) {
      res.status(404).json({ error: 'Projeto não encontrado.' });
      return null;
    }
    return dirOf(id);
  }

  function thumbFile(dir) {
    for (const ext of THUMB_EXTS) {
      const file = path.join(dir, `thumb.${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  async function createProject(payload) {
    const id = newId();
    const dir = dirOf(id);
    await fs.promises.mkdir(path.join(dir, 'media'), { recursive: true });
    payload.project = { ...(payload.project || {}), id };
    const meta = metaFrom(id, payload);
    payload.project.createdAt = meta.createdAt;
    await writeJsonAtomic(path.join(dir, 'project.json'), payload);
    await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
    return meta;
  }

  // ── Lista ──────────────────────────────────────────────────────────────
  app.get('/api/projects', async (req, res) => {
    const entries = await fs.promises.readdir(baseDir, { withFileTypes: true }).catch(() => []);
    const list = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const dir = dirOf(entry.name);
      try {
        const meta = await readJson(path.join(dir, 'meta.json'));
        const thumb = thumbFile(dir);
        list.push({
          ...meta,
          id: entry.name,
          thumb: thumb ? `/api/projects/${entry.name}/thumb?v=${Math.round(fs.statSync(thumb).mtimeMs)}` : null,
        });
      } catch (_) { /* pasta incompleta: fica fora da lista */ }
    }
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json({ projects: list, dir: baseDir });
  });

  // ── Criar ──────────────────────────────────────────────────────────────
  app.post('/api/projects', async (req, res) => {
    const body = req.body || {};
    const project = {
      name: String(body.name || 'Projeto sem título').trim().slice(0, 120) || 'Projeto sem título',
      res: {
        w: Math.min(7680, Math.max(16, Math.round(Number(body.res?.w) || 1080))),
        h: Math.min(7680, Math.max(16, Math.round(Number(body.res?.h) || 1920))),
      },
      fps: Math.min(240, Math.max(1, Math.round(Number(body.fps) || 30))),
      background: /^#[0-9a-f]{6}$/i.test(body.background || '') ? body.background : '#000000',
      settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
    };
    try {
      const meta = await createProject({
        signature: 'MOTION_STUDIO_PROJECT', format: 'motion-studio-project', version: 1,
        project, templates: [], clips: [], tracks: [], editor: {},
      });
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: `Não foi possível criar o projeto: ${err.message}` });
    }
  });

  // ── Importar um arquivo .ms (mídias embutidas em base64 viram arquivos) ──
  app.post('/api/projects/import', async (req, res) => {
    const payload = req.body;
    if (!payload || !payload.project || !Array.isArray(payload.templates) || !Array.isArray(payload.clips)) {
      return res.status(400).json({ error: 'Arquivo de projeto inválido.' });
    }
    try {
      const meta = await createProject({ ...payload, templates: [] });
      const dir = dirOf(meta.id);
      const templates = [];
      for (const tmpl of payload.templates) {
        const m = /^data:([\w/+.-]+)?(;base64)?,(.*)$/s.exec(String(tmpl?.dataUrl || ''));
        if (tmpl?.type !== 'html' && tmpl?.type !== 'text' && m) {
          const ext = (String(m[1] || '').split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
          const file = uniqueMediaName(path.join(dir, 'media'), `${tmpl.name || 'media'}.${ext}`);
          const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
          await fs.promises.writeFile(path.join(dir, 'media', file), data);
          templates.push({ ...tmpl, dataUrl: mediaUrl(meta.id, file), mediaFile: file, fileSize: data.length });
        } else {
          templates.push(tmpl);
        }
      }
      const full = await readJson(path.join(dir, 'project.json'));
      full.templates = templates;
      await writeJsonAtomic(path.join(dir, 'project.json'), full);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: `Falha ao importar: ${err.message}` });
    }
  });

  // ── Abrir ──────────────────────────────────────────────────────────────
  app.get('/api/projects/:id', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(dir, 'project.json'));
  });

  // ── Salvar (autosave) ──────────────────────────────────────────────────
  app.put('/api/projects/:id', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const payload = req.body;
    if (!payload?.project || !Array.isArray(payload.templates) || !Array.isArray(payload.clips)) {
      return res.status(400).json({ error: 'Projeto incompleto.' });
    }
    // blob:/data: não sobrevivem a um reload: o cliente precisa enviar a mídia antes
    const unsaved = payload.templates.find(t => /^(blob|data):/i.test(String(t?.dataUrl || '')) && t.type !== 'html' && t.type !== 'text' && !t.layer);   // camadas SVG (sólido, forma…) ficam inline no projeto
    if (unsaved) return res.status(409).json({ error: `A mídia "${unsaved.name}" ainda não foi enviada ao projeto.` });
    try {
      const id = req.params.id;
      const previous = await readJson(path.join(dir, 'meta.json')).catch(() => ({}));
      payload.project.id = id;
      const meta = metaFrom(id, payload, previous);
      payload.project.createdAt = meta.createdAt;
      payload.project.updatedAt = meta.updatedAt;
      await writeJsonAtomic(path.join(dir, 'project.json'), payload);
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      res.json({ ok: true, updatedAt: meta.updatedAt });
    } catch (err) {
      res.status(500).json({ error: `Falha ao salvar: ${err.message}` });
    }
  });

  // ── Renomear ───────────────────────────────────────────────────────────
  app.patch('/api/projects/:id', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'Nome vazio.' });
    try {
      const full = await readJson(path.join(dir, 'project.json'));
      full.project = { ...full.project, name };
      await writeJsonAtomic(path.join(dir, 'project.json'), full);
      const meta = await readJson(path.join(dir, 'meta.json')).catch(() => metaFrom(req.params.id, full));
      meta.name = name;
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Duplicar ───────────────────────────────────────────────────────────
  app.post('/api/projects/:id/duplicate', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    try {
      const id = newId();
      await fs.promises.cp(dir, dirOf(id), { recursive: true });
      const full = await readJson(path.join(dirOf(id), 'project.json'));
      const name = `${full.project?.name || 'Projeto'} (cópia)`.slice(0, 120);
      full.project = { ...full.project, id, name, createdAt: new Date().toISOString() };
      // As mídias apontam para a pasta do projeto: troca o id nas URLs
      full.templates = (full.templates || []).map(t => (t?.mediaFile
        ? { ...t, dataUrl: mediaUrl(id, t.mediaFile) }
        : t));
      await writeJsonAtomic(path.join(dirOf(id), 'project.json'), full);
      const meta = metaFrom(id, full);
      await writeJsonAtomic(path.join(dirOf(id), 'meta.json'), meta);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: `Falha ao duplicar: ${err.message}` });
    }
  });

  // ── Excluir (vai para .trash, recuperável pela pasta) ───────────────────
  app.delete('/api/projects/:id', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    try {
      await fs.promises.mkdir(trashDir, { recursive: true });
      const trash = `${req.params.id}-${Date.now()}`;
      await fs.promises.rename(dir, path.join(trashDir, trash));
      res.json({ ok: true, trash });   // o editor usa o nome para oferecer "Desfazer"
    } catch (err) {
      res.status(500).json({ error: `Falha ao excluir: ${err.message}` });
    }
  });

  // ── Restaurar da lixeira (Desfazer da exclusão) ─────────────────────────
  app.post('/api/projects/restore', async (req, res) => {
    const trash = String(req.body?.trash || '');
    const m = trash.match(/^(p_[a-z0-9]{6,32})-\d+$/);
    if (!m) return res.status(400).json({ error: 'Item da lixeira inválido.' });
    const from = path.join(trashDir, trash);
    const to = dirOf(m[1]);
    try {
      if (!fs.existsSync(from)) return res.status(404).json({ error: 'O projeto não está mais na lixeira.' });
      if (fs.existsSync(to)) return res.status(409).json({ error: 'Já existe um projeto com este identificador.' });
      await fs.promises.rename(from, to);
      res.json({ ok: true, id: m[1] });
    } catch (err) {
      res.status(500).json({ error: `Falha ao restaurar: ${err.message}` });
    }
  });

  // ── Mídia ──────────────────────────────────────────────────────────────
  // Corpo binário (sem JSON/base64): vídeos de vários GB passam direto para o disco
  app.post('/api/projects/:id/media', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const size = Number(req.headers['content-length'] || 0);
    if (size > MAX_UPLOAD) return res.status(413).json({ error: 'Arquivo maior que 8 GB.' });
    const mediaDir = path.join(dir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const file = uniqueMediaName(mediaDir, decodeURIComponent(String(req.query.name || 'media')));
    const target = path.join(mediaDir, file);
    const out = fs.createWriteStream(target);
    let written = 0;
    req.on('data', chunk => { written += chunk.length; });
    req.pipe(out);
    out.on('finish', () => res.json({ url: mediaUrl(req.params.id, file), file, size: written }));
    const fail = err => {
      out.destroy();
      fs.promises.unlink(target).catch(() => {});
      if (!res.headersSent) res.status(500).json({ error: `Falha ao gravar a mídia: ${err.message}` });
    };
    out.on('error', fail);
    req.on('aborted', () => fail(new Error('envio interrompido')));
  });

  app.get('/api/projects/:id/media/:file', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const file = String(req.params.file || '');
    if (!MEDIA_RE.test(file)) return res.status(400).end();
    // sendFile responde Range: o <video> consegue buscar sem baixar tudo
    res.sendFile(path.join(dir, 'media', file), { maxAge: '1y', immutable: true }, err => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  /** Mídias que nenhum template usa mais (sobras de imports desfeitos) */
  app.post('/api/projects/:id/media/cleanup', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    try {
      const full = await readJson(path.join(dir, 'project.json'));
      const used = new Set((full.templates || []).map(t => t?.mediaFile).filter(Boolean));
      const files = await fs.promises.readdir(path.join(dir, 'media')).catch(() => []);
      let freed = 0, removed = 0;
      for (const file of files) {
        if (used.has(file)) continue;
        const p = path.join(dir, 'media', file);
        freed += (await fs.promises.stat(p)).size;
        await fs.promises.unlink(p);
        removed++;
      }
      res.json({ removed, freed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Tamanho da pasta (configurações do projeto) */
  app.get('/api/projects/:id/usage', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const files = await fs.promises.readdir(path.join(dir, 'media')).catch(() => []);
    let bytes = 0;
    for (const file of files) bytes += (await fs.promises.stat(path.join(dir, 'media', file)).catch(() => ({ size: 0 }))).size;
    res.json({ mediaFiles: files.length, mediaBytes: bytes, dir });
  });

  // ── Capa ───────────────────────────────────────────────────────────────
  app.post('/api/projects/:id/thumb', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const ext = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[String(req.headers['content-type']).split(';')[0]];
    if (!ext) return res.status(415).json({ error: 'Use webp, jpeg ou png.' });
    THUMB_EXTS.forEach(e => { try { fs.unlinkSync(path.join(dir, `thumb.${e}`)); } catch (_) {} });
    const out = fs.createWriteStream(path.join(dir, `thumb.${ext}`));
    req.pipe(out);
    out.on('finish', () => res.json({ ok: true }));
    out.on('error', err => res.status(500).json({ error: err.message }));
  });

  app.get('/api/projects/:id/thumb', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const file = thumbFile(dir);
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  });

  // ── Cenas com IA em andamento (retomar depois de falha de cota/sobrecarga ou de fechar) ──
  // Um arquivo por projeto: transcrição, plano/estilo e o HTML de cada cena já gerada.
  const jobFile = dir => path.join(dir, 'ai-scenes-job.json');

  app.get('/api/projects/:id/ai-job', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    res.setHeader('Cache-Control', 'no-store');
    readJson(jobFile(dir)).then(job => res.json({ job: job || null })).catch(() => res.json({ job: null }));
  });

  app.put('/api/projects/:id/ai-job', async (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const job = req.body?.job;
    if (!job || typeof job !== 'object' || !Array.isArray(job.clipIds)) return res.status(400).json({ error: 'Job inválido.' });
    try {
      await writeJsonAtomic(jobFile(dir), job);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Não foi possível salvar o progresso: ${err.message}` });
    }
  });

  app.delete('/api/projects/:id/ai-job', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    fs.rm(jobFile(dir), { force: true }, () => res.json({ ok: true }));
  });

  // ── Abrir a pasta no gerenciador de arquivos ───────────────────────────
  app.post('/api/projects/:id/reveal', (req, res) => {
    const dir = projectDir(req, res);
    if (!dir) return;
    const [cmd, args] = process.platform === 'win32' ? ['explorer', [dir]]
      : process.platform === 'darwin' ? ['open', [dir]]
      : ['xdg-open', [dir]];
    // explorer.exe sai com código 1 mesmo quando abre: não trata como erro
    execFile(cmd, args, () => {});
    res.json({ ok: true, dir });
  });

  return { baseDir };
}

module.exports = { register };
