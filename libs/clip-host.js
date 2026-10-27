/* clip-host.js — o que todo host de clipe HTML injeta antes dos scripts do clipe
 *
 *  Usado no preview (Interface/compositor.js, custom-assets.js), no export
 *  (exporter.js) e nas miniaturas (index.js → libs/html-thumbs.js). Os
 *  caminhos são absolutos na raiz do servidor: o app e o servidor interno do
 *  export servem a raiz do projeto, então /libs/... resolve nos dois.
 *
 *    injectRuntime(html, { audio }) → html com:
 *      - window.__msAudio (opcional): áudio do projeto para MS.audio(t)
 *      - libs/motion-kit.js: window.MS + adaptadores de window.Motion
 *      - libs/vendor/onetake/motion.js (window.OM), se o clipe usa OM.*
 */
(function (root) {
  'use strict';

  const KIT_SRC = '/libs/motion-kit.js';
  const ONETAKE_SRC = '/libs/vendor/onetake/motion.js';
  const MARK = 'data-ms-runtime';

  const usesOneTake = html => /\bOM\.[A-Za-z_]/.test(html) && !/onetake\/motion\.js/.test(html);
  const usesAudio = html => /\bMS\.audio\b/.test(html);

  /** JSON seguro dentro de <script> (sem </script> nem <!-- no meio) */
  const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c');

  function injectRuntime(html, { audio = null } = {}) {
    html = String(html || '');
    if (html.indexOf(MARK) !== -1) return html;
    let tags = '';
    if (audio) tags += `<script ${MARK}>window.__msAudio=${scriptJson(audio)};</script>`;
    tags += `<script ${MARK} src="${KIT_SRC}"></script>`;
    if (usesOneTake(html)) tags += `<script ${MARK} src="${ONETAKE_SRC}"></script>`;

    // Logo depois de <head> (antes de qualquer <base> e dos scripts do clipe)
    const head = /<head(\s[^>]*)?>/i.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
    const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
    if (htmlTag) {
      const at = htmlTag.index + htmlTag[0].length;
      return html.slice(0, at) + `<head>${tags}</head>` + html.slice(at);
    }
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    const at = doctype ? doctype[0].length : 0;
    return html.slice(0, at) + tags + html.slice(at);
  }

  const api = { injectRuntime, usesAudio, usesOneTake, KIT_SRC, ONETAKE_SRC };
  root.ClipHost = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
