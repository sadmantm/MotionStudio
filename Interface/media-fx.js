'use strict';
// media-fx.js
//
//  Efeitos de pixel em vídeo e imagem (WebGL) — os mesmos no preview
//  (compositor.js) e no export (exporter.js embute este arquivo na cena):
//    pixelate  pixelizar (inteiro ou só numa região: esconder um e-mail, placa…)
//    halftone  meio-tom de jornal
//    ascii     caracteres no lugar dos pixels
//    crt       tela de tubo: curvatura, linhas, máscara RGB, vinheta
//    glitch    blocos deslocados e RGB separado (determinístico pelo tempo)
//  Também desempacota vídeo sem fundo (remoção de fundo): o arquivo traz a cor
//  à esquerda e o alpha (em cinza) à direita, lado a lado — toca em qualquer
//  navegador e no Chrome do export, que não decodificam vídeo com alpha.
//
//  clip.fx.pixel = { type, amount (0–1), region?: { x, y, w, h } (0–1, do canto
//  superior esquerdo da caixa do clip) }
//
//    MediaFX.attach(source, host) → { set(params), render(t), destroy() } | null
//      source: <video>, <img> ou <canvas> (o do WVC no export); host: a caixa
//      do clip, onde o <canvas> do efeito entra por cima (a mídia fica invisível)

(function (root) {
  const EFFECTS = {
    pixelate: 'Pixelizar',
    halftone: 'Meio-tom',
    ascii: 'ASCII',
    crt: 'Tela CRT',
    glitch: 'Glitch',
  };
  const CODE = { pixelate: 1, halftone: 2, ascii: 3, crt: 4, glitch: 5 };
  const GLYPHS = ' .:-=+*#%@';

  const VERT = 'attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';

  const FRAG = `
precision highp float;
varying vec2 v;
uniform sampler2D u_tex;
uniform sampler2D u_glyphs;
uniform vec2 u_res;
uniform float u_time;
uniform float u_amount;
uniform int u_effect;
uniform float u_packed;
uniform vec4 u_region;
uniform float u_glyphCount;

vec4 src(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  if (u_packed > 0.5) {
    vec3 c = texture2D(u_tex, vec2(uv.x * 0.5, uv.y)).rgb;
    float a = texture2D(u_tex, vec2(0.5 + uv.x * 0.5, uv.y)).r;
    return vec4(c, a);
  }
  return texture2D(u_tex, uv);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = v;
  vec2 px = uv * u_res;
  vec4 col = src(uv);

  if (u_effect == 1) {
    vec2 tl = vec2(uv.x, 1.0 - uv.y);
    if (tl.x >= u_region.x && tl.x <= u_region.x + u_region.z && tl.y >= u_region.y && tl.y <= u_region.y + u_region.w) {
      float block = max(2.0, mix(0.008, 0.07, u_amount) * u_res.y);
      col = src((floor(px / block) + 0.5) * block / u_res);
    }
  } else if (u_effect == 2) {
    float cell = max(3.0, mix(0.006, 0.03, u_amount) * u_res.y);
    float s = 0.70710678;
    vec2 q = vec2(s * px.x - s * px.y, s * px.x + s * px.y);
    vec2 cc = (floor(q / cell) + 0.5) * cell;
    vec2 back = vec2(s * cc.x + s * cc.y, -s * cc.x + s * cc.y);
    vec4 c = src(back / u_res);
    float r = cell * 0.62 * sqrt(clamp(1.0 - luma(c.rgb), 0.0, 1.0));
    float ink = 1.0 - smoothstep(r - 0.8, r + 0.8, length(q - cc));
    col = vec4(mix(vec3(0.96, 0.95, 0.91), c.rgb * 0.82, ink), c.a);
  } else if (u_effect == 3) {
    float h = max(4.0, mix(0.008, 0.026, u_amount) * u_res.y);
    vec2 cs = vec2(h * 0.6, h);
    vec2 cc = (floor(px / cs) + 0.5) * cs;
    vec4 c = src(cc / u_res);
    float gi = floor(clamp(luma(c.rgb), 0.0, 0.999) * u_glyphCount);
    vec2 local = fract(px / cs);
    float g = texture2D(u_glyphs, vec2((gi + local.x) / u_glyphCount, local.y)).r;
    col = vec4(c.rgb * g * 1.25, c.a);
  } else if (u_effect == 4) {
    float k = mix(0.04, 0.24, u_amount);
    vec2 cc = uv - 0.5;
    vec2 duv = 0.5 + cc * (1.0 + k * dot(cc, cc)) * (1.0 - k * 0.22);
    if (duv.x < 0.0 || duv.x > 1.0 || duv.y < 0.0 || duv.y > 1.0) {
      col = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
      float ab = mix(0.0008, 0.004, u_amount);
      vec4 base = src(duv);
      vec3 c = vec3(src(duv + vec2(ab, 0.0)).r, base.g, src(duv - vec2(ab, 0.0)).b);
      float lines = mix(540.0, 260.0, u_amount);
      float scan = 0.78 + 0.22 * sin(duv.y * lines * 6.2831853);
      float m = mod(floor(px.x), 3.0);
      vec3 mask = m < 1.0 ? vec3(1.0, 0.82, 0.82) : m < 2.0 ? vec3(0.82, 1.0, 0.82) : vec3(0.82, 0.82, 1.0);
      float vig = smoothstep(0.95, 0.35, length(cc * vec2(1.0, 1.15)) * 1.15);
      float flicker = 1.0 + 0.025 * sin(u_time * 50.0);
      col = vec4(c * scan * mask * vig * flicker * 1.22, base.a);
    }
  } else if (u_effect == 5) {
    float tick = floor(u_time * 12.0);
    float burst = step(1.0 - (0.3 + 0.55 * u_amount), hash(vec2(tick, 1.7)));
    float row = floor((1.0 - uv.y) * 22.0 + hash(vec2(tick, 3.1)) * 3.0);
    float moved = step(0.55, hash(vec2(row * 1.3, tick + 7.0)));
    float shift = (hash(vec2(row, tick)) - 0.5) * 0.14 * u_amount * burst * moved;
    vec2 guv = vec2(fract(uv.x + shift), uv.y);
    float split = 0.003 + 0.022 * u_amount * burst;
    vec4 base = src(guv);
    vec3 c = vec3(src(guv + vec2(split, 0.0)).r, base.g, src(guv - vec2(split, 0.0)).b);
    c += (hash(vec2(floor(px.y / 2.0), tick)) - 0.5) * 0.09 * u_amount;
    col = vec4(c, base.a);
  }
  gl_FragColor = vec4(col.rgb * col.a, col.a);
}`;

  function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    return sh;
  }

  function glyphAtlas(doc) {
    const c = doc.createElement('canvas');
    const w = 32, h = 48;
    c.width = w * GLYPHS.length;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.font = `bold ${Math.round(h * 0.8)}px ui-monospace, Menlo, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < GLYPHS.length; i++) g.fillText(GLYPHS[i], i * w + w / 2, h / 2 + 1);
    return c;
  }

  function texture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  const sourceSize = el => ({
    w: el.videoWidth || el.naturalWidth || el.width || 0,
    h: el.videoHeight || el.naturalHeight || el.height || 0,
  });

  /** Canvas WebGL por cima da mídia; null sem WebGL (a mídia continua aparecendo) */
  function attach(source, host, { maxSide = 0 } = {}) {
    if (!source || !host) return null;
    const doc = host.ownerDocument || document;
    const canvas = doc.createElement('canvas');
    canvas.className = 'ms-mediafx';
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false })
      || canvas.getContext('experimental-webgl');
    if (!gl) return null;

    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    } catch (err) {
      console.warn('[MediaFX] WebGL indisponível:', err.message);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    const U = name => gl.getUniformLocation(prog, name);
    const u = {
      tex: U('u_tex'), glyphs: U('u_glyphs'), res: U('u_res'), time: U('u_time'), amount: U('u_amount'),
      effect: U('u_effect'), packed: U('u_packed'), region: U('u_region'), glyphCount: U('u_glyphCount'),
    };
    const tex = texture(gl);
    const glyphTex = texture(gl);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, glyphTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphAtlas(doc));
    gl.uniform1i(u.tex, 0);
    gl.uniform1i(u.glyphs, 1);
    gl.uniform1f(u.glyphCount, GLYPHS.length);

    host.appendChild(canvas);
    const params = { effect: null, amount: 0.5, packed: false, region: null };
    let lastT = 0;

    function render(t = lastT) {
      lastT = t;
      const { w: sw, h: sh } = sourceSize(source);
      if (!sw || !sh) return false;
      // Resolução do canvas: a da caixa na tela do projeto (limitada no preview)
      let cw = Math.max(2, Math.round(host.clientWidth || sw));
      let ch = Math.max(2, Math.round(host.clientHeight || sh));
      if (maxSide && Math.max(cw, ch) > maxSide) {
        const k = maxSide / Math.max(cw, ch);
        cw = Math.round(cw * k);
        ch = Math.round(ch * k);
      }
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      gl.viewport(0, 0, cw, ch);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch (_) {
        return false;   // quadro ainda indisponível
      }
      const r = params.region || { x: 0, y: 0, w: 1, h: 1 };
      gl.uniform2f(u.res, cw, ch);
      gl.uniform1f(u.time, t);
      gl.uniform1f(u.amount, Math.max(0, Math.min(1, Number(params.amount ?? 0.5))));
      gl.uniform1i(u.effect, CODE[params.effect] || 0);
      gl.uniform1f(u.packed, params.packed ? 1 : 0);
      gl.uniform4f(u.region, r.x, r.y, r.w, r.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    // O quadro novo do vídeo só pode ser lido quando é apresentado: o
    // requestVideoFrameCallback avisa (no play e depois de cada busca); o
    // 'seeked'/'loadeddata' cobrem navegadores sem ele
    const redraw = () => render();
    if (source.addEventListener) {
      source.addEventListener('seeked', redraw);
      source.addEventListener('loadeddata', redraw);
      source.addEventListener('load', redraw);
    }
    let frameCb = null;
    if (typeof source.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        render();
        frameCb = source.requestVideoFrameCallback(onFrame);
      };
      frameCb = source.requestVideoFrameCallback(onFrame);
    }

    return {
      canvas,
      set(next) { Object.assign(params, next); },
      render,
      destroy() {
        if (frameCb != null && source.cancelVideoFrameCallback) source.cancelVideoFrameCallback(frameCb);
        if (source.removeEventListener) {
          source.removeEventListener('seeked', redraw);
          source.removeEventListener('loadeddata', redraw);
          source.removeEventListener('load', redraw);
        }
        canvas.remove();
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      },
    };
  }

  /** Parâmetros do efeito a partir do clip e do template (null = nada a fazer) */
  function paramsFor(fx, tmpl) {
    const pixel = fx && fx.pixel && EFFECTS[fx.pixel.type] ? fx.pixel : null;
    const packed = Boolean(tmpl && tmpl.alphaPacked === 'sbs');
    if (!pixel && !packed) return null;
    return {
      effect: pixel ? pixel.type : null,
      amount: pixel ? Number(pixel.amount ?? 0.5) : 0,
      region: pixel && pixel.type === 'pixelate' && pixel.region ? pixel.region : null,
      packed,
    };
  }

  root.MediaFX = { EFFECTS, attach, paramsFor };
})(typeof window !== 'undefined' ? window : globalThis);
