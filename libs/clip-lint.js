/* clip-lint.js — diagnóstico de clipes HTML (navegador e Node)
 *
 *  Mesma ideia do @hyperframes/lint: cada problema tem um código, uma
 *  severidade, a explicação e a dica de correção — usado pela geração com IA
 *  (libs/ai-server.js: erros viram rodada de correção), pelo painel "Diagnóstico"
 *  do clipe e pela checagem antes do export (Interface/clip-lint-ui.js).
 *
 *    lint(html, { strict }) → { ok, errors, warnings, infos, findings[] }
 *    finding: { code, severity: 'error'|'warning'|'info', message, fix, line }
 *
 *  strict (IA): o clipe TEM que trazer o contrato window.Motion e chegar
 *  inteiro até </html>. Fora do strict, HTML sem contrato é dirigido pelos
 *  adaptadores do motion-kit e só gera aviso informativo.
 */
(function (root) {
  'use strict';

  const SEVERITY = { error: 0, warning: 1, info: 2 };

  function lineAt(src, index) {
    if (!(index >= 0)) return null;
    let n = 1;
    for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
    return n;
  }

  /** Scripts inline clássicos (sem src, sem módulo, sem dados/shader) */
  function inlineScripts(src) {
    const out = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[1] || '';
      if (/\bsrc\s*=/i.test(attrs)) continue;
      const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
      out.push({
        code: m[2],
        index: m.index + m[0].indexOf('>') + 1,
        module: /^module$/i.test(type),
        classic: !type || /^(text|application)\/(java|ecma)script$/i.test(type),
      });
    }
    return out;
  }

  /** Erro de sintaxe de um script clássico, sem executar (Node: vm; navegador: Function) */
  function syntaxError(code) {
    try {
      if (typeof window === 'undefined' && typeof require === 'function') {
        const vm = require('vm');
        new vm.Script(code); // eslint-disable-line no-new
      } else {
        new Function(code); // eslint-disable-line no-new, no-new-func
      }
      return null;
    } catch (err) {
      return err && err.name === 'SyntaxError' ? err : null;
    }
  }

  /** Código JS do clipe (scripts inline) + atributos on* — onde procurar padrões */
  function jsText(src) {
    return inlineScripts(src).map(s => s.code).join('\n');
  }

  function lint(html, { strict = false } = {}) {
    const src = String(html || '');
    const js = jsText(src);
    const findings = [];
    const add = (code, severity, message, fix, index) => findings.push({ code, severity, message, fix, line: lineAt(src, index) });
    const find = (re, text = src) => { const m = re.exec(text); return m ? m.index : -1; };
    const at = re => find(re); // índice no documento inteiro

    const hasNative = /\bwindow\.Motion\b|\bMS\.motion\s*\(/.test(src);
    const usesKitContract = /\bMS\.motion\s*\(/.test(src);
    const adaptable = /\bgsap\b|__timelines|\blottie\b|bodymovin|\banime\s*[.(]|@keyframes|\banimation\s*:|\.animate\s*\(|requestAnimationFrame/.test(src);

    // ── Estrutura ─────────────────────────────────────────────
    if (!/<html[\s>]/i.test(src)) {
      add('html_missing', strict ? 'error' : 'warning', 'Documento sem <html>.', 'Envolva o clipe num documento HTML completo (<!DOCTYPE html><html>…</html>).', 0);
    } else if (!/<\/html>\s*$/i.test(src)) {
      add('html_incomplete', strict ? 'error' : 'info', 'Documento incompleto (sem </html> no final — resposta cortada?).', 'Gere de novo ou feche o documento; o fim do clipe pode ter se perdido.', src.length - 1);
    }

    inlineScripts(src).forEach(s => {
      if (!s.classic || s.module) return;
      const err = syntaxError(s.code);
      if (err) add('script_syntax_error', 'error', `Erro de sintaxe num <script>: ${err.message}`, 'Corrija o JavaScript: com erro de sintaxe o script inteiro não roda e o clipe sai parado.', s.index);
    });

    // ── Contrato ──────────────────────────────────────────────
    if (strict) {
      if (!hasNative) add('motion_missing', 'error', 'window.Motion não encontrado.', 'Defina window.Motion (ou use MS.motion({ fps, durationInSeconds, render })).', -1);
      else if (!usesKitContract) {
        const tokens = [
          ['Motion.config', 'motion_config_missing', 'Motion.config ausente'],
          ['renderFrame', 'render_frame_missing', 'renderFrame ausente'],
          ['seek', 'seek_missing', 'seek ausente'],
          ['whenReady', 'when_ready_missing', 'whenReady ausente'],
          ['durationInSeconds', 'duration_missing', 'durationInSeconds ausente em config'],
          ['fps', 'fps_missing', 'fps ausente em config'],
          ['totalFrames', 'total_frames_missing', 'totalFrames ausente em config'],
        ];
        tokens.forEach(([token, code, message]) => {
          if (!src.includes(token)) add(code, 'error', message, 'Siga o contrato window.Motion (config, seek, renderFrame, whenReady) ou use MS.motion.', -1);
        });
      }
    } else if (!hasNative && !adaptable) {
      add('static_clip', 'info', 'O clipe não tem animação controlável (sem window.Motion nem biblioteca/CSS animado).', 'Se ele deveria animar, use MS.motion({ render: t => … }) ou uma timeline GSAP.', -1);
    } else if (!hasNative) {
      add('adapter_driven', 'info', 'Sem window.Motion: o editor dirige a animação pelo adaptador (GSAP, Lottie, anime.js, CSS ou relógio virtual).', 'Funciona no preview e no export; para controle total, use MS.motion.', -1);
    }

    // ── Determinismo (mesmo t → mesmo quadro) ─────────────────
    const driven = hasNative ? 'warning' : 'info';
    let i;
    if ((i = at(/\brequestAnimationFrame\s*\(/)) >= 0) add('raf_driven', driven, 'Usa requestAnimationFrame.', 'Calcule o estado a partir de t dentro de seek(t); o rAF roda no relógio real e sai diferente no export.', i);
    if ((i = at(/\bsetInterval\s*\(/)) >= 0) add('set_interval', 'warning', 'Usa setInterval.', 'Timers não seguem o quadro do export; derive o estado de t.', i);
    if ((i = at(/\bDate\.now\s*\(/)) >= 0) add('date_now', driven, 'Usa Date.now().', 'Use o t recebido em seek(t).', i);
    if ((i = at(/\bperformance\.now\s*\(/)) >= 0) add('performance_now', driven, 'Usa performance.now().', 'Use o t recebido em seek(t).', i);
    if ((i = find(/\bMath\.random\s*\(/, js)) >= 0) add('math_random', 'warning', 'Usa Math.random() (cada render sai diferente).', 'Use MS.random("semente") ou const r = MS.rng("semente").', at(/\bMath\.random\s*\(/));
    if ((i = at(/transition\s*:\s*(?!\s*(none|0s?|all\s+0s?)\s*[;"'}])[^;"'}]*\d/i)) >= 0) {
      add('css_transition_used', 'warning', 'Usa transition CSS (roda no relógio do navegador).', 'Troque por estado calculado em seek(t) ou por uma timeline pausada.', i);
    }
    if ((i = at(/<video[\s>]/i)) >= 0) add('video_tag', 'warning', 'Contém <video> dentro do clipe.', 'Importe o vídeo como clip separado na timeline (o export sincroniza vídeos só fora dos clipes HTML).', i);
    if ((i = at(/<audio[\s>]/i)) >= 0) add('audio_tag', 'warning', 'Contém <audio> dentro do clipe.', 'Use Motion.sfx ou um clip de áudio na timeline.', i);

    // ── GSAP ──────────────────────────────────────────────────
    if ((i = find(/\bgsap\.(to|from|fromTo)\s*\(/, js)) >= 0) {
      add('gsap_direct_tween', hasNative ? 'warning' : 'info', 'gsap.to/from/fromTo direto (toca sozinho pelo ticker).', 'Coloque os tweens numa timeline pausada (gsap.timeline({ paused: true })) e faça seek(t) nela.', at(/\bgsap\.(to|from|fromTo)\s*\(/));
    }
    if ((i = at(/from\s*:\s*["']random["']|gsap\.utils\.random\s*\(|["']random\(/)) >= 0) {
      add('gsap_random', 'warning', 'Aleatoriedade do GSAP (random) não é determinística.', 'Sorteie com MS.rng("semente") antes de montar a timeline.', i);
    }
    if ((i = at(/repeat\s*:\s*-1/)) >= 0) add('gsap_repeat_infinite', 'warning', 'repeat: -1 (duração infinita).', 'Use um número de repetições que cubra a duração do clipe.', i);
    if ((i = at(/\bScrollTrigger\b/)) >= 0) add('scroll_trigger', 'warning', 'Usa ScrollTrigger (não há rolagem no export).', 'Dirija a animação por seek(t).', i);
    if ((i = at(/autoplay\s*:\s*true/)) >= 0) add('autoplay_true', 'warning', 'Biblioteca com autoplay: true.', 'Crie pausada e dirija por seek(t).', i);

    // ── three.js / WebGL ──────────────────────────────────────
    if ((i = at(/\bsetAnimationLoop\s*\(/)) >= 0) add('three_animation_loop', 'warning', 'Usa renderer.setAnimationLoop.', 'Chame renderer.render dentro de seek(t).', i);
    if ((i = at(/\.getDelta\s*\(|new\s+THREE\.Clock/)) >= 0) add('three_clock', 'warning', 'Usa THREE.Clock/getDelta.', 'Use o t recebido em seek(t) (o export pode pedir quadros fora de ordem).', i);
    if ((i = at(/new\s+THREE\.WebGLRenderer/)) >= 0 && !/try\s*\{[^]*?new\s+THREE\.WebGLRenderer/.test(src)) {
      add('webgl_no_fallback', 'warning', 'WebGLRenderer criado fora de try/catch.', 'Sem WebGL o clipe inteiro quebra: crie o renderer em try/catch e mantenha o 2D animando.', i);
    }
    if (/from\s+["']three["']/.test(src) && !/["']three["']\s*:\s*["']https:\/\/[^"']*three@\d/.test(src)) {
      add('three_unpinned', 'warning', 'three.js sem versão fixa no importmap.', 'Aponte "three" para …/three@<versão>/build/three.module.js.', at(/from\s+["']three["']/));
    }

    // ── Rede ──────────────────────────────────────────────────
    if ((i = at(/<script[^>]+src=["']http:\/\//i)) >= 0) add('http_script', 'warning', 'Script por http:// (bloqueado em https e instável).', 'Use https.', i);
    if ((i = at(/esm\.sh|skypack\.dev/i)) >= 0) add('esm_cdn', 'warning', 'CDN esm.sh/skypack (imports absolutos quebram no export).', 'Use cdn.jsdelivr.net, cdnjs ou unpkg com versão fixa.', i);
    const unpinned = /<script[^>]+src=["']https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/(@?[\w.-]+(?:\/[\w.-]+)?)(?!@)\//i.exec(src);
    if (unpinned && !/@\d/.test(unpinned[1])) add('cdn_unpinned', 'warning', `Biblioteca de CDN sem versão fixa (${unpinned[1]}).`, 'Fixe a versão na URL (ex.: gsap@3.15.0) para o clipe não mudar sozinho.', unpinned.index);

    if (strict && !/<title>[^<]+<\/title>/i.test(src)) add('title_missing', 'info', 'Sem <title>.', 'Dê um nome curto ao clipe em <title>.', -1);

    findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
    const count = s => findings.filter(f => f.severity === s).length;
    return { ok: !count('error'), errors: count('error'), warnings: count('warning'), infos: count('info'), findings };
  }

  const api = { lint };
  root.ClipLint = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
