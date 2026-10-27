window.__TextRegistry = (() => {
  const _templates = [];

  let _loadingPromise = null;
  const _loadedIndexes = new Set();

  function _normalizeTemplate(meta, htmlSource = null, builderFn = null) {
    return {
      ...meta,
      htmlSource,
      _builderFn: builderFn || null,
    };
  }

  function _findIndexById(id) {
    return _templates.findIndex(t => t.id === id);
  }

  function _upsertTemplate(tmpl) {
    if (!tmpl?.id) return false;

    const i = _findIndexById(tmpl.id);

    if (i >= 0) {
      // Atualiza o existente em vez de duplicar
      _templates[i] = {
        ..._templates[i],
        ...tmpl,
      };
      return false;
    }

    _templates.push(tmpl);
    return true;
  }

  async function loadAll(indexUrl = 'text-templates/index.json', options = {}) {
    const { force = false } = options;

    // Evita duas chamadas simultâneas carregarem o mesmo index ao mesmo tempo
    if (_loadingPromise && !force) {
      return _loadingPromise;
    }

    // Se esse index já foi carregado, não carrega de novo
    if (_loadedIndexes.has(indexUrl) && !force) {
      return;
    }

    _loadingPromise = (async () => {
      let index;

      try {
        const res = await fetch(indexUrl, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Falha ao carregar ${indexUrl}: HTTP ${res.status}`);
        index = await res.json();
      } catch (err) {
        console.warn('[TextRegistry] Falha ao carregar index:', indexUrl, err);
        return;
      }

      if (!Array.isArray(index)) {
        console.warn('[TextRegistry] index.json inválido: esperado array');
        return;
      }

      const loaded = await Promise.all(index.map(async meta => {
        if (!meta?.id) {
          console.warn('[TextRegistry] Template ignorado sem id:', meta);
          return null;
        }

        let htmlSource = null;

        if (meta.file) {
          try {
            const res = await fetch(meta.file, { cache: 'no-cache' });
            if (res.ok) {
              htmlSource = await res.text();
            } else {
              console.warn(`[TextRegistry] Falha ao carregar template ${meta.id}: HTTP ${res.status}`, meta.file);
            }
          } catch (err) {
            console.warn(`[TextRegistry] Erro ao carregar template ${meta.id}:`, meta.file, err);
          }
        }

        if (!htmlSource && meta.html) {
          htmlSource = meta.html;
        }

        if (!htmlSource) {
          console.warn('[TextRegistry] Template ignorado sem htmlSource:', meta.id);
          return null;
        }

        return _normalizeTemplate(meta, htmlSource);
      }));

      loaded.forEach(tmpl => {
        if (tmpl) _upsertTemplate(tmpl);
      });

      // Mantém a ordem do index.json, sem duplicar os que foram registrados via JS
      const order = new Map(index.map((m, i) => [m.id, i]));

      _templates.sort((a, b) => {
        const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
        const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });

      _loadedIndexes.add(indexUrl);
    })();

    try {
      await _loadingPromise;
    } finally {
      _loadingPromise = null;
    }
  }

  // Registra template com builder function embutido, sem arquivo externo
  function register(meta, builderFn) {
    if (!meta?.id) {
      console.warn('[TextRegistry] register ignorado: meta.id ausente', meta);
      return;
    }

    const tmpl = _normalizeTemplate(meta, null, builderFn);
    _upsertTemplate(tmpl);
  }

  function buildHtml(tmplId, params = {}, res) {
    const tmpl = getById(tmplId);
    if (!tmpl) return '';

    const merged = {
      ...tmpl.defaults,
      ...params,
      w: res?.w || 1080,
      h: res?.h || 1920,
    };

    // Builder JS direto tem prioridade
    if (typeof tmpl._builderFn === 'function') {
      return tmpl._builderFn(merged, res);
    }

    if (!tmpl.htmlSource) return '';

    return tmpl.htmlSource.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = merged[key];
      return val !== undefined ? String(val) : '';
    });
  }

  // Template com HTML já em mãos (ex.: criado pelo usuário em custom-assets.js)
  function addSource(meta, htmlSource) {
    if (!meta?.id || !htmlSource) return;
    _upsertTemplate(_normalizeTemplate(meta, htmlSource));
  }

  function remove(id) {
    const i = _findIndexById(id);
    if (i >= 0) _templates.splice(i, 1);
  }

  function getAll() {
    return [..._templates];
  }

  function getById(id) {
    return _templates.find(t => t.id === id) || null;
  }

  function clear() {
    _templates.length = 0;
    _loadedIndexes.clear();
    _loadingPromise = null;
  }

  return {
    loadAll,
    register,
    addSource,
    remove,
    buildHtml,
    getAll,
    getById,
    clear,
  };
})();