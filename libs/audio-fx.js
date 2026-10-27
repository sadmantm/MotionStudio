'use strict';
// audio-fx.js
//
//  Ajustes de clip de áudio (velocidade, tom, redutor de ruído, corte de
//  graves, nivelar voz) aplicados pelo ffmpeg sobre o arquivo ORIGINAL.
//  O editor recebe a versão processada como uma mídia nova e o clip passa a
//  apontar para ela: preview, forma de onda, cortes, transcrição e export
//  usam o mesmo arquivo — o que se ouve é o que sai no vídeo.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Valores válidos e arredondados (o editor usa a mesma regra para comparar) */
function normalizeFx(raw = {}) {
  const denoise = raw.denoise || {};
  return {
    speed:  Math.round(clamp(num(raw.speed, 1), 0.25, 4) * 100) / 100,
    pitch:  Math.round(clamp(num(raw.pitch, 0), -12, 12) * 2) / 2,
    denoise: {
      on:     Boolean(denoise.on),
      amount: Math.round(clamp(num(denoise.amount, 50), 0, 100)),
      floor:  Math.round(clamp(num(denoise.floor, -50), -80, -20)),
    },
    lowcut: Math.round(clamp(num(raw.lowcut, 0), 0, 300)),
    level:  Boolean(raw.level),
  };
}

/** atempo aceita 0,5–2 por estágio: encadeia para 0,25–4 */
function atempoChain(factor) {
  const out = [];
  let x = factor;
  while (x > 2.0001) { out.push('atempo=2'); x /= 2; }
  while (x < 0.4999) { out.push('atempo=0.5'); x /= 0.5; }
  if (Math.abs(x - 1) > 1e-4) out.push(`atempo=${x.toFixed(5)}`);
  return out;
}

/** Cadeia -af para os ajustes (vazia = nada a fazer) */
function buildFilter(rawFx, { rubberband = false } = {}) {
  const fx = normalizeFx(rawFx);
  const chain = [];

  if (fx.lowcut > 0) chain.push(`highpass=f=${fx.lowcut}:poles=2`);
  if (fx.denoise.on) {
    // Intensidade 0–100 % → 6–40 dB de redução; piso = nível abaixo do qual é ruído
    const nr = (6 + fx.denoise.amount * 0.34).toFixed(1);
    chain.push(`afftdn=nr=${nr}:nf=${fx.denoise.floor}:tn=1`);
  }

  const k = Math.pow(2, fx.pitch / 12);
  if (fx.pitch !== 0 && rubberband) {
    chain.push(`rubberband=tempo=${fx.speed}:pitch=${k.toFixed(6)}`);
  } else if (fx.pitch !== 0) {
    // Sem rubberband: reamostra (muda tom e tempo) e corrige o tempo com atempo
    chain.push('aresample=48000', `asetrate=${Math.round(48000 * k)}`, 'aresample=48000', ...atempoChain(fx.speed / k));
  } else {
    chain.push(...atempoChain(fx.speed));
  }

  if (fx.level) chain.push('dynaudnorm=f=200:g=15:p=0.9');
  return chain.join(',');
}

function register(app, { ffmpegPath, saveUpload }) {
  let rubberband = null;
  const hasRubberband = () => rubberband || (rubberband = new Promise(resolve => {
    execFile(ffmpegPath(), ['-hide_banner', '-filters'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, out) => resolve(!err && /\brubberband\b/.test(String(out))));
  }));

  /**
   * POST /api/audio/process?ext=mp3&fx={json}   Body: arquivo de áudio original
   * → áudio processado (audio/mp4, AAC 256k). Sempre a partir do original:
   * mudar os ajustes de novo não acumula perdas.
   */
  app.post('/api/audio/process', async (req, res) => {
    const ext = String(req.query.ext || 'mp3').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp3';
    let fx;
    try { fx = JSON.parse(String(req.query.fx || '{}')); } catch (_) { return res.status(400).json({ error: 'Ajustes inválidos.' }); }

    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const input  = path.join(os.tmpdir(), `ms_afx_${tag}_in.${ext}`);
    const output = path.join(os.tmpdir(), `ms_afx_${tag}_out.m4a`);
    const cleanup = () => { fs.rm(input, { force: true }, () => {}); fs.rm(output, { force: true }, () => {}); };

    try {
      await saveUpload(req, input);
      if (!fs.statSync(input).size) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });

      const filter = buildFilter(fx, { rubberband: await hasRubberband() });
      const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-vn', '-map', '0:a:0',
        ...(filter ? ['-af', filter] : []),
        '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', output];
      const started = Date.now();
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath(), args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) => {
          if (err) reject(Object.assign(new Error('O ffmpeg não conseguiu processar o áudio.'), { detail: String(stderr || '').slice(-600) }));
          else resolve();
        });
      });
      console.log(`[Audio] Ajustes aplicados em ${((Date.now() - started) / 1000).toFixed(1)}s: ${filter || '(nenhum)'}`);
      res.type('audio/mp4');
      res.sendFile(output, cleanup);
    } catch (err) {
      cleanup();
      console.error('[Audio] Processamento falhou:', err.message, err.detail || '');
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = { register, buildFilter, normalizeFx, atempoChain };
