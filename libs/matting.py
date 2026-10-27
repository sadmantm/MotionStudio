"""matting.py — remove o fundo de vídeo/imagem com o Robust Video Matting (RVM).

Chamado por libs/matting.js com o Python do ambiente do Whisper (já tem
onnxruntime e numpy). Os quadros entram e saem pelo ffmpeg do app:

  vídeo  → MP4 H.264 com a cor à esquerda e o alpha (cinza) à direita, lado a
           lado (Interface/media-fx.js desempacota no preview e no export)
  imagem → PNG com transparência

O RVM é recorrente: o estado de um quadro alimenta o próximo, então o recorte
não "pisca" entre quadros (diferente de modelos de imagem aplicados quadro a
quadro). Modelo: github.com/PeterL1n/RobustVideoMatting (GPL-3.0), baixado no
primeiro uso.

Progresso em stdout, uma linha JSON por evento:
  {"progress": 0.42}  ·  {"done": true}  ·  {"error": "..."}
"""

import argparse
import json
import subprocess
import sys

import numpy as np


def emit(**payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def session(model_path):
    import onnxruntime as ort

    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model_path, sess_options=opts, providers=providers)


def read_exact(stream, size):
    buf = bytearray()
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--frames", type=int, default=0)
    ap.add_argument("--image", action="store_true")
    ap.add_argument("--audio", action="store_true")
    args = ap.parse_args()

    W, H = args.width, args.height
    sess = session(args.model)
    ratio = np.array([min(1.0, 512.0 / max(W, H))], dtype=np.float32)
    rec = [np.zeros((1, 1, 1, 1), dtype=np.float32)] * 4

    dec_cmd = [args.ffmpeg, "-v", "error", "-nostdin", "-i", args.input, "-an",
               "-vf", f"scale={W}:{H}:flags=bicubic,format=rgb24"]
    if not args.image:
        dec_cmd += ["-fps_mode", "cfr", "-r", f"{args.fps:.6f}"]
    else:
        dec_cmd += ["-frames:v", "1"]
    dec_cmd += ["-f", "rawvideo", "pipe:1"]

    if args.image:
        enc_cmd = [args.ffmpeg, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
                   "-s", f"{W}x{H}", "-i", "pipe:0", "-frames:v", "1", args.output]
    else:
        enc_cmd = [args.ffmpeg, "-v", "error", "-y",
                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{2 * W}x{H}", "-r", f"{args.fps:.6f}", "-i", "pipe:0"]
        if args.audio:
            enc_cmd += ["-i", args.input, "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k"]
        enc_cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
                    "-g", str(max(1, round(args.fps))), "-movflags", "+faststart", "-shortest", args.output]

    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = W * H * 3
    done = 0
    try:
        while True:
            raw = read_exact(dec.stdout, frame_bytes)
            if len(raw) < frame_bytes:
                break
            rgb = np.frombuffer(raw, dtype=np.uint8).reshape(H, W, 3)
            src = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
            fgr, pha, *rec = sess.run(None, {
                "src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio,
            })
            alpha = np.clip(pha[0, 0], 0.0, 1.0)
            # Cor do primeiro plano estimada pelo RVM (sem o fundo vazando nas bordas)
            color = (np.clip(fgr[0].transpose(1, 2, 0), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
            a8 = (alpha * 255.0 + 0.5).astype(np.uint8)
            if args.image:
                out = np.dstack([color, a8])
            else:
                out = np.concatenate([color, np.repeat(a8[:, :, None], 3, axis=2)], axis=1)
            enc.stdin.write(np.ascontiguousarray(out).tobytes())
            done += 1
            if args.frames and (done % 5 == 0 or done == args.frames):
                emit(progress=min(0.999, done / args.frames))
            if args.image:
                break
    except BrokenPipeError:
        pass
    finally:
        try:
            enc.stdin.close()
        except Exception:
            pass
        dec.stdout.close()
        dec.wait()
        err = enc.stderr.read().decode("utf-8", "replace")
        code = enc.wait()

    if done == 0:
        emit(error="Nenhum quadro foi lido do arquivo.")
        sys.exit(2)
    if code != 0:
        emit(error=f"ffmpeg (saída) falhou: {err.strip().splitlines()[-1] if err.strip() else code}")
        sys.exit(3)
    emit(done=True, frames=done)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — erro vai para o editor
        emit(error=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
