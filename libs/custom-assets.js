'use strict';
// custom-assets.js
//
//  Efeitos, transições e textos criados pelo usuário (colando HTML ou com IA).
//  Valem para todos os projetos: ficam em custom-assets/ (index.json + um .html
//  por item), ao lado da pasta de projetos. O HTML segue o mesmo contrato dos
//  clips (window.Motion) e passa pelo mesmo validador da IA.
//    effect     → clip HTML de sobreposição (fundo transparente) sobre o clip
//    transition → clip HTML de sobreposição centrado no corte entre dois clips
//    text       → template do TextRegistry ({{text}}, {{color}}… como os de text-templates/)
//    curve      → curva de animação (JSON { p } | { pts }, ver libs/curve-spec.js); vale para os keyframes
//
//  Dois lugares, mesmo formato:
//    usuário (scope "user") → custom-assets/, fora do git (dados de quem usa)
//    app     (scope "app")  → catalog/ na raiz do código, versionado: o que
//                             entra no commit e vem embutido para todos

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = ['effect', 'transition', 'text', 'curve'];
const MAX_HTML = 2_000_000;

function resolveDir(root) {
  if (process.env.MS_CUSTOM_DIR) return path.resolve(process.env.MS_CUSTOM_DIR);
  if (process.env.MS_PROJECTS_DIR) return path.join(path.dirname(path.resolve(process.env.MS_PROJECTS_DIR)), 'custom-assets');
  return path.join(root, 'custom-assets');
}

/** Duração literal do config (durationInSeconds: 1.2); {{duration}} → null */
function literalDuration(html) {
  const m = String(html).match(/durationInSeconds\s*:\s*([\d.]+)/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** clip-fx.js é o mesmo arquivo do editor e do export; carregado no Node ele expõe globalThis.ClipFX */
function clipFx(root) {
  if (!globalThis.ClipFX) require(path.join(root, 'Interface', 'clip-fx.js'));
  return globalThis.ClipFX;
}

const CATEGORY = {
  user: { text: 'Meus textos', effect: 'Meus efeitos', curve: 'Minhas curvas', transition: 'Minhas transições' },
  app:  { text: 'Textos do app', effect: 'Efeitos do app', curve: 'Curvas do app', transition: 'Transições do app' },
};

/** index.json + um arquivo por item numa pasta */
function store(dir) {
  const indexFile = path.join(dir, 'index.json');
  return {
    dir,
    read() {
      try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (_) { return []; }
    },
    write(list) {
      fs.mkdirSync(dir, { recursive: true });
      // Fim de linha e indentação estáveis: o catálogo do app vai para o git
      fs.writeFileSync(indexFile + '.tmp', JSON.stringify(list, null, 2) + '\n');
      fs.renameSync(indexFile + '.tmp', indexFile);
    },
    withHtml(item) {
      try { return { ...item, html: fs.readFileSync(path.join(dir, item.file), 'utf8') }; } catch (_) { return null; }
    },
  };
}

function register(app, { root, validateClip, validateTextTemplate }) {
  const stores = { user: store(resolveDir(root)), app: store(path.join(root, 'catalog')) };
  const scopeOf = id => (stores.app.read().some(i => i.id === id) ? 'app' : 'user');

  /**
   * GET /api/custom-assets → [{ id, kind, name, category, defaults, duration, html, createdAt, builtin }]
   * Primeiro os do catálogo do app (builtin: true), depois os do usuário.
   */
  app.get('/api/custom-assets', (req, res) => {
    res.json([
      ...stores.app.read().map(i => stores.app.withHtml(i)).filter(Boolean).map(i => ({ ...i, builtin: true })),
      ...stores.user.read().map(i => stores.user.withHtml(i)).filter(Boolean),
    ]);
  });

  /**
   * POST /api/custom-assets { kind, name, html, defaults?, id?, scope? }
   * id existente = atualizar. scope "app" grava em catalog/ (versionado).
   * Erros do contrato window.Motion → 422 com a lista.
   */
  app.post('/api/custom-assets', (req, res) => {
    const body = req.body || {};
    const kind = String(body.kind || '');
    let html = typeof body.html === 'string' ? body.html.trim() : '';
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!KINDS.includes(kind)) return res.status(400).json({ error: 'Tipo inválido.' });
    if (!name) return res.status(400).json({ error: 'Dê um nome.' });
    if (!html) return res.status(400).json({ error: 'HTML vazio.' });
    if (html.length > MAX_HTML) return res.status(413).json({ error: 'HTML grande demais (máx. 2 MB).' });

    // Curva: o "html" é o JSON da curva, normalizado pelo mesmo código do editor
    let check;
    if (kind === 'curve') {
      let raw = null;
      try { raw = JSON.parse(html); } catch (_) { /* inválido abaixo */ }
      const curve = clipFx(root).normalizeCurve(raw);
      if (!curve) return res.status(422).json({ error: 'Curva inválida: use { "p": [x1, y1, x2, y2] } ou { "pts": [[x, y], …] }.', issues: ['formato'] });
      html = JSON.stringify(curve);
      check = { fatal: [], warnings: [] };
    } else {
      check = (kind === 'text' ? validateTextTemplate : validateClip)(html);
    }
    if (check.fatal.length) {
      return res.status(422).json({ error: `O HTML não segue o formato do Motion Studio: ${check.fatal.join('; ')}.`, issues: check.fatal });
    }

    const scope = body.scope === 'app' ? 'app' : 'user';
    const target = stores[scope];
    const list = target.read();
    const existing = body.id ? list.find(i => i.id === body.id) : null;
    // No catálogo do app o id nasce do nome (arquivo legível no diff); repetido ganha sufixo
    const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'item';
    const appId = base => (list.some(i => i.id === base) ? `${base}_${crypto.randomBytes(2).toString('hex')}` : base);
    const id = existing?.id || (scope === 'app' ? appId(`app_${kind}_${slug}`) : `cx_${kind}_${crypto.randomBytes(5).toString('hex')}`);
    const duration = kind === 'curve' ? 0 : literalDuration(html) || (kind === 'transition' ? 1 : kind === 'effect' ? 4 : 3);
    const item = {
      id,
      kind,
      name,
      category: CATEGORY[scope][kind],
      duration,
      ...(kind === 'text' ? { defaults: { ...(body.defaults || {}), duration: Number(body.defaults?.duration) || duration } } : {}),
      file: `${id}.html`,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(target.dir, { recursive: true });
    fs.writeFileSync(path.join(target.dir, item.file), html);   // curva: .html com o JSON (o nome é o mesmo dos outros tipos)
    target.write(existing ? list.map(i => (i.id === id ? item : i)) : [...list, item]);
    res.json({ ...item, html, warnings: check.warnings, ...(scope === 'app' ? { builtin: true, path: `catalog/${item.file}` } : {}) });
  });

  app.delete('/api/custom-assets/:id', (req, res) => {
    const target = stores[scopeOf(req.params.id)];
    const list = target.read();
    const item = list.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Não encontrado.' });
    target.write(list.filter(i => i !== item));
    fs.rm(path.join(target.dir, item.file), { force: true }, () => {});
    res.json({ ok: true });
  });
}

module.exports = { register };
