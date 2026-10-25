'use strict';
// html-thumbs.js
//
//  Miniaturas de clipes HTML para a filmstrip da timeline. O navegador do
//  editor não consegue "fotografar" um iframe (muito menos canvas/WebGL), então
//  o servidor abre o clipe num Chromium headless, chama Motion.seek(t) e tira
//  prints WebP pequenos. Um navegador compartilhado, uma página por vez,
//  fechado após ociosidade; resultado em cache pelo hash do pedido.

const crypto = require('crypto');

const IDLE_CLOSE_MS   = 60_000;
const PAGE_TIMEOUT_MS = 20_000;
const READY_WAIT_MS   = 8_000;
const CACHE_MAX       = 200;

let browserPromise = null;
let idleTimer      = null;
let queue          = Promise.resolve();
const cache        = new Map();   // hash → frames (LRU simples)

function getBrowser() {
  clearTimeout(idleTimer);
  if (!browserPromise) {
    const puppeteer = require('puppeteer');
    browserPromise = puppeteer.launch({
      headless: true,
      // App desktop: mesmo Chrome empacotado do export (sem cache do puppeteer no usuário)
      ...(process.env.MS_CHROME_PATH ? { executablePath: process.env.MS_CHROME_PATH } : {}),
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--hide-scrollbars',
        // Mesmo WebGL por software do export: clipes 3D também ganham miniatura
        ...(process.env.WVC_SWIFTSHADER === '0' ? [] : ['--enable-unsafe-swiftshader']),
      ],
    }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const pending = browserPromise;
    browserPromise = null;
    try { await (await pending)?.close(); } catch (_) { /* já fechado */ }
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

async function renderFrames({ url, w, h, times, height }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // DPR fracionário: o layout roda na resolução do projeto e o print sai pequeno
    await page.setViewport({ width: w, height: h, deviceScaleFactor: height / h });
    await page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });

    // whenReady cobre fontes, modelos e texturas; não espera para sempre
    await page.evaluate(timeout => Promise.race([
      Promise.resolve(window.Motion?.whenReady?.()).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, timeout)),
    ]), READY_WAIT_MS);

    const frames = [];
    for (const t of times) {
      await page.evaluate(async time => {
        try {
          if (window.Motion?.seek) await window.Motion.seek(time);
          else if (window.MotionAPI?.seek) await window.MotionAPI.seek(time);
          else {
            document.getAnimations?.().forEach(a => {
              try { a.pause(); a.currentTime = time * 1000; } catch (_) { /* ignora */ }
            });
          }
        } catch (_) { /* um quadro com erro não derruba os outros */ }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, t);
      // WebP com alfa: clipe de fundo transparente fica sobre a cor do bloco
      const data = await page.screenshot({ type: 'webp', quality: 70, omitBackground: true, encoding: 'base64' });
      frames.push({ t, url: `data:image/webp;base64,${data}` });
    }
    return frames;
  } finally {
    page.close().catch(() => {});
  }
}

/**
 * opts: { key (hash do HTML), url, w, h, times: number[], height }
 * Pedidos são enfileirados: um Chromium com uma página por vez.
 */
function render(opts) {
  const hash = crypto.createHash('sha1')
    .update(JSON.stringify([opts.key, opts.w, opts.h, opts.height, opts.times]))
    .digest('hex');

  if (cache.has(hash)) {
    const frames = cache.get(hash);
    cache.delete(hash);
    cache.set(hash, frames);
    return Promise.resolve(frames);
  }

  const job = queue.then(() => renderFrames(opts)).finally(scheduleClose);
  queue = job.catch(() => {});
  return job.then(frames => {
    cache.set(hash, frames);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return frames;
  });
}

module.exports = { render };
