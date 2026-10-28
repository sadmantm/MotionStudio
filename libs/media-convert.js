// ═══════════════════════════════════════════════════════════════════════════
//  Conversões de mídia na importação.
//
//  WebP animado → vídeo. O FFmpeg 9 ganhou decoder/demuxer de WebP animado;
//  antes o arquivo entrava como imagem e animava pelo relógio do navegador
//  (sem duração na timeline, sem corte e fora de sincronia no export, que
//  captura quadro a quadro). Como vídeo ele tem duração, corte e velocidade.
//  Com transparência sai WebM VP9 com alfa; sem, MP4 H.264.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function register(app, { ffmpegPath, saveUpload }) {
  /**
   * POST /api/media/animated-to-video?alpha=1   Body: arquivo .webp animado
   * → video/webm (alpha=1) ou video/mp4. 422 quando o ffmpeg não decodifica
   * (FFmpeg < 9): o cliente mantém o arquivo como imagem.
   */
  app.post('/api/media/animated-to-video', async (req, res) => {
    const alpha = req.query.alpha === '1';
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const input  = path.join(os.tmpdir(), `ms_anim_${tag}_in.webp`);
    const output = path.join(os.tmpdir(), `ms_anim_${tag}_out.${alpha ? 'webm' : 'mp4'}`);
    const cleanup = () => { fs.rm(input, { force: true }, () => {}); fs.rm(output, { force: true }, () => {}); };

    // Dimensões pares (yuv420); durações de quadro variáveis são mantidas
    const codec = alpha
      ? ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuva420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-deadline', 'good', '-cpu-used', '4', '-auto-alt-ref', '0']
      : ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-movflags', '+faststart'];
    const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-an', ...codec, output];

    try {
      await saveUpload(req, input);
      if (!fs.statSync(input).size) throw Object.assign(new Error('Arquivo vazio.'), { status: 400 });
      const started = Date.now();
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath(), args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 5 * 60e3 }, (err, _out, stderr) => {
          if (!err && fs.existsSync(output) && fs.statSync(output).size) return resolve();
          const text = String(stderr || '');
          const unsupported = /Invalid data found|could not find codec|unsupported|no decoder|ANIM/i.test(text);
          reject(Object.assign(new Error(unsupported
            ? 'Este ffmpeg não lê WebP animado (precisa do FFmpeg 9: npm run ffmpeg:install).'
            : 'O ffmpeg não conseguiu converter o WebP animado.'), { status: unsupported ? 422 : 500, detail: text.slice(-600) }));
        });
      });
      console.log(`[Mídia] WebP animado → ${alpha ? 'WebM (alfa)' : 'MP4'} em ${((Date.now() - started) / 1000).toFixed(1)}s`);
      res.type(alpha ? 'video/webm' : 'video/mp4');
      res.sendFile(output, cleanup);
    } catch (err) {
      cleanup();
      console.error('[Mídia] Conversão falhou:', err.message, err.detail || '');
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = { register };
