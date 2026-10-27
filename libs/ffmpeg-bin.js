'use strict';
// ffmpeg-bin.js
//
//  Caminho único do ffmpeg/ffprobe para o servidor e o export:
//  FFMPEG_PATH/FFPROBE_PATH → .bin/ffmpeg (9.x, desktop/ffmpeg.js) →
//  ffmpeg-static/ffprobe-static (6.1 / 4.0, legado) → PATH do sistema.

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', '.bin', 'ffmpeg');
const EXE = process.platform === 'win32' ? '.exe' : '';

function legacy(name) {
  try {
    const p = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  return null;
}

const cache = {};
function resolveBin(name) {
  if (cache[name]) return cache[name];
  const env = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  const bundled = path.join(BIN_DIR, name + EXE);
  cache[name] = env || (fs.existsSync(bundled) ? bundled : null) || legacy(name) || name + EXE;
  return cache[name];
}

const ffmpegPath  = () => resolveBin('ffmpeg');
const ffprobePath = () => resolveBin('ffprobe');

/** Versão principal do ffmpeg em uso (0 se não der para ler) */
let _major = null;
function ffmpegMajor() {
  if (_major !== null) return _major;
  try {
    const out = execFileSync(ffmpegPath(), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    _major = Number((/ffmpeg version n?(\d+)\./.exec(out) || [])[1]) || 0;
  } catch (_) {
    _major = 0;
  }
  return _major;
}

module.exports = { ffmpegPath, ffprobePath, ffmpegMajor };
