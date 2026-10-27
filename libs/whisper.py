#!/usr/bin/env python3
"""
whisper.py — Servidor de transcrição (faster-whisper + word timestamps)
Porta: 9099 (ou env WHISPER_PORT)

v4 — multiplataforma (Windows / macOS Intel / macOS Apple Silicon / Linux):
- Motor: faster-whisper (CTranslate2). Não depende de torch → roda até em Mac Intel,
  onde o PyTorch novo (exigido pelo whisperx) não existe mais.
- Se o whisperx estiver instalado, é usado só para refinar o tempo das palavras (wav2vec2).
- Modelos ficam em <projeto>/models (ou env WHISPER_MODELS_DIR). Na primeira execução são
  baixados automaticamente com progresso; depois carregam offline.
- GPU NVIDIA quando disponível (com teste real de inferência); senão CPU int8.
- Linhas de controle para o Node: @@STAGE, @@DOWNLOAD, @@DEVICE, @@READY, @@FATAL
"""
from __future__ import annotations

import sys, os, re, json, glob, wave, time, threading, traceback, warnings
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

warnings.filterwarnings("ignore", message="torchcodec is not installed correctly")
warnings.filterwarnings("ignore", category=UserWarning, module="pyannote")
warnings.filterwarnings("ignore", message=".*local_dir_use_symlinks.*")

# Códigos de saída que o Node entende
EXIT_DEPS_MISSING = 3   # dependência ausente → não adianta reiniciar com o mesmo Python
EXIT_LOAD_FAILED  = 4   # falha ao carregar/baixar modelo

ROOT_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.abspath(os.environ.get("WHISPER_MODELS_DIR") or os.path.join(ROOT_DIR, "models"))

# Tudo que o Hugging Face / torch baixar fica dentro de models/, não no cache do usuário
os.environ.setdefault("HF_HOME",    os.path.join(MODELS_DIR, "hf"))
os.environ.setdefault("TORCH_HOME", os.path.join(MODELS_DIR, "torch"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ── Safe print ─────────────────────────────────────────────────────────────────
def _print(msg: str):
    enc  = sys.stdout.encoding or "utf-8"
    safe = msg.encode(enc, errors="replace").decode(enc, errors="replace")
    print(safe, flush=True)

def _control(tag: str, payload: dict):
    _print(f"@@{tag} {json.dumps(payload, ensure_ascii=True)}")

PORT = int(os.environ.get("WHISPER_PORT", "9099"))
SAMPLE_RATE = 16000

# ── Parâmetros ASR ─────────────────────────────────────────────────────────────
NO_SPEECH_THRESHOLD   = 0.45
LOGPROB_THRESHOLD     = -1.2
COMPRESSION_RATIO_THR = 2.4

# Temperatura fixa em 0; só repete (com busca mais ampla) se o resultado parecer
# alucinação ou incompleto. As repetições usam o modelo sem lote (outro caminho na GPU).
RETRY_CONFIGS = [
    {"beam_size": 5,  "patience": 1.0},
    {"beam_size": 5,  "patience": 1.5, "plain": True},
    {"beam_size": 10, "patience": 2.0, "plain": True},
]
VAD_PARAMS = {"threshold": 0.4, "min_silence_duration_ms": 500, "speech_pad_ms": 200}
# Fala normal tem 2–3 palavras/s; abaixo disto a transcrição perdeu trechos
MIN_WORDS_PER_SPEECH_SEC = 0.8

# ── Anti-alucinação ────────────────────────────────────────────────────────────
# Só frases que o Whisper inventa em silêncio/música. Falas curtas são legítimas.
HALLUCINATION_PATTERNS = [
    r"^[\W\d_]*$",                                    # sem nenhuma letra
    r"\b(thanks? for watching|subscribe|like and subscribe)\b",
    r"\b(obrigad[oa] por assistir|inscreva-se|se inscreva|ative o sininho)\b",
    r"\b(legendas? (pela|por|da) comunidade|amara\.org|legendado por|legendas? por)\b",
    r"^\s*(legendas?|legendado|subtitles?|tradução|translation|transcription|transcrição)\s*[.!]?\s*$",
]
_hallucination_re = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_PATTERNS]
_REPEAT_RE = re.compile(r"\b(\w+(?:\s+\w+){0,3})(?:[\s,.]+\1\b){4,}", re.IGNORECASE)

def _is_hallucination(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if any(p.search(t) for p in _hallucination_re):
        return True
    # mesma palavra/frase repetida 5+ vezes ("não não não não não…")
    return bool(_REPEAT_RE.search(t))

def _score_result(segments: list) -> dict:
    if not segments:
        return {"valid": False, "reason": "sem_segmentos", "clean_segments": [], "hallucination_ratio": 1.0}

    clean = [s for s in segments if not _is_hallucination(s.get("text", ""))]
    total = len(segments)
    ratio = (total - len(clean)) / total

    if not clean:
        return {"valid": False, "reason": "todos_filtrados", "clean_segments": [], "hallucination_ratio": 1.0}
    if ratio > 0.6:
        return {"valid": False, "reason": f"muitas_alucinacoes ({total - len(clean)}/{total})",
                "clean_segments": clean, "hallucination_ratio": ratio}
    return {"valid": True, "reason": None, "clean_segments": clean, "hallucination_ratio": ratio}

# ── Hardware ───────────────────────────────────────────────────────────────────
def _total_ram_gb() -> float | None:
    try:
        if sys.platform == "win32":
            import ctypes
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = MEMORYSTATUSEX()
            st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return st.ullTotalPhys / 1e9
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9
    except Exception:
        return None

def _prepare_cuda_libs():
    """
    Windows: o CTranslate2 precisa achar cuBLAS/cuDNN. Vêm dos pacotes pip
    nvidia-cublas-cu12 / nvidia-cudnn-cu12 ou do torch (venv antigo com whisperx).
    """
    if sys.platform != "win32":
        return
    import sysconfig
    sp = sysconfig.get_paths()["purelib"]
    dirs = glob.glob(os.path.join(sp, "nvidia", "*", "bin")) + [os.path.join(sp, "torch", "lib")]
    for d in dirs:
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except Exception:
                pass
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")

def _pick_device(ctranslate2) -> str:
    forced = os.environ.get("WHISPER_DEVICE", "").strip().lower()
    if forced in ("cpu", "cuda"):
        return forced
    try:
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception as e:
        _print(f"[Whisper] Falha ao checar CUDA ({e}) — usando CPU")
    # macOS (Intel ou Apple Silicon) e PCs sem NVIDIA caem aqui
    return "cpu"

def _pick_compute(device: str, ctranslate2) -> str:
    forced = os.environ.get("WHISPER_COMPUTE", "").strip()
    if forced:
        return forced
    try:
        supported = set(ctranslate2.get_supported_compute_types(device))
    except Exception:
        supported = set()
    # int8_float16 antes de float16: em float16 puro o large-v3 dá resultados
    # instáveis em algumas GPUs (RTX 20xx: o mesmo áudio saía inteiro, pela
    # metade ou vazio). int8_float16 é estável, usa menos VRAM e tem a mesma
    # velocidade. GPUs antigas (GTX 9xx/10xx) caem em int8_float32.
    prefs = ["int8_float16", "float16", "int8_float32", "int8", "float32"] if device == "cuda" \
        else ["int8", "int8_float32", "float32"]
    for p in prefs:
        if p in supported:
            return p
    return "float32"

def _pick_model(device: str) -> str:
    forced = os.environ.get("WHISPER_MODEL", "").strip()
    if forced:
        return forced
    if device == "cuda":
        return "large-v3"
    # CPU: turbo tem qualidade próxima do large-v3 com decoder 8× menor.
    ram = _total_ram_gb()
    if ram is not None and ram < 7.5:
        return "small"
    return "large-v3-turbo"

# ── Modelos locais (download automático) ───────────────────────────────────────
_MODEL_FILE_RE = re.compile(r"^(config\.json|preprocessor_config\.json|model\.bin|tokenizer\.json|vocabulary\..+)$")
_MARKER = ".complete.json"

def _model_dir(name: str) -> str:
    return os.path.join(MODELS_DIR, "whisper", name.replace("/", "--"))

def _model_is_complete(path: str) -> bool:
    if not os.path.isfile(os.path.join(path, _MARKER)):
        return False
    needed = ["config.json", "model.bin", "tokenizer.json"]
    return all(os.path.isfile(os.path.join(path, f)) and os.path.getsize(os.path.join(path, f)) > 0 for f in needed) \
        and bool(glob.glob(os.path.join(path, "vocabulary.*")))

def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total

def ensure_model(name: str) -> str:
    """
    Garante o modelo em models/whisper/<nome>. Se já foi baixado (marcador presente),
    não acessa a internet. Senão baixa (retomando downloads parciais) e reporta progresso.
    """
    from faster_whisper.utils import download_model, _MODELS

    path = _model_dir(name)
    if _model_is_complete(path):
        _print(f"[Whisper] Modelo '{name}' encontrado em {path}")
        _control("STAGE", {"stage": "model_cached", "model": name, "path": path})
        return path

    repo = name if "/" in name else _MODELS.get(name)
    if not repo:
        raise ValueError(f"Modelo desconhecido: {name}")

    total = None
    try:
        from huggingface_hub import HfApi
        info  = HfApi().model_info(repo, files_metadata=True)
        total = sum((s.size or 0) for s in info.siblings if _MODEL_FILE_RE.match(s.rfilename)) or None
    except Exception as e:
        _print(f"[Whisper] Não consegui obter o tamanho do modelo ({e})")

    os.makedirs(path, exist_ok=True)
    _print(f"[Whisper] Baixando '{name}' ({repo})" + (f" — {total/1e9:.2f} GB" if total else "") + f" para {path}")
    _control("STAGE", {"stage": "downloading", "model": name, "total": total})

    stop = threading.Event()
    def _report():
        while not stop.wait(1.0):
            _control("DOWNLOAD", {"model": name, "done": _dir_size(path), "total": total})
    threading.Thread(target=_report, daemon=True).start()

    try:
        for attempt in range(1, 4):
            try:
                download_model(name, output_dir=path)
                break
            except Exception as e:
                if attempt == 3:
                    raise RuntimeError(f"Falha ao baixar o modelo '{name}': {e}. Verifique a conexão.") from e
                _print(f"[Whisper] Download falhou ({e}) — tentando de novo ({attempt}/3)…")
                time.sleep(3 * attempt)
    finally:
        stop.set()

    with open(os.path.join(path, _MARKER), "w") as f:
        json.dump({"model": name, "repo": repo, "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
    if not _model_is_complete(path):
        raise RuntimeError(f"Download do modelo '{name}' incompleto em {path}")

    _control("DOWNLOAD", {"model": name, "done": total or _dir_size(path), "total": total})
    _print(f"[Whisper] Modelo '{name}' salvo em {path}")
    return path

# ── Modelo global ──────────────────────────────────────────────────────────────
whisperx = None            # opcional: só para refinar tempo das palavras
np = None
DEVICE = COMPUTE = MODEL_SIZE = None
ALIGN_DEVICE = "cpu"
BATCH_SIZE = 8
_model    = None
_pipeline = None           # BatchedInferencePipeline (só GPU)
_aligners = {}
_lock     = threading.Lock()

def _import_deps():
    global np
    try:
        import numpy as _np
        import ctranslate2 as _ct2
        import faster_whisper
    except Exception as e:
        traceback.print_exc()
        _control("FATAL", {"code": "deps_missing", "python": sys.executable,
                           "error": f"{type(e).__name__}: {e}"})
        sys.exit(EXIT_DEPS_MISSING)
    np = _np
    _print(f"[Whisper] Python {sys.version.split()[0]} ({sys.executable}) | {sys.platform}")
    _print(f"[Whisper] faster-whisper {faster_whisper.__version__} | ctranslate2 {_ct2.__version__}")
    return _ct2

def _import_aligner():
    """whisperx (wav2vec2) melhora o tempo de cada palavra, mas é opcional."""
    global whisperx, ALIGN_DEVICE
    if os.environ.get("WHISPER_ALIGN", "1") == "0":
        return
    try:
        import torch
        import whisperx as _wx
        whisperx = _wx
        ALIGN_DEVICE = "cuda" if DEVICE == "cuda" and torch.cuda.is_available() else "cpu"
        _print(f"[Whisper] whisperx disponível — alinhamento wav2vec2 em {ALIGN_DEVICE}")
    except Exception:
        _print("[Whisper] whisperx não instalado — usando timestamps de palavra do faster-whisper")

def _load_model():
    global _model, _pipeline, DEVICE, COMPUTE, MODEL_SIZE, BATCH_SIZE
    ct2 = _import_deps()
    from faster_whisper import WhisperModel, BatchedInferencePipeline

    DEVICE   = _pick_device(ct2)
    if DEVICE == "cuda":
        _prepare_cuda_libs()
    attempts = [DEVICE] if DEVICE == "cpu" else ["cuda", "cpu"]
    last_err = None

    for dev in attempts:
        DEVICE     = dev
        COMPUTE    = _pick_compute(dev, ct2)
        MODEL_SIZE = _pick_model(dev)
        threads    = max(1, (os.cpu_count() or 4) - (0 if dev == "cuda" else 1))
        ram        = _total_ram_gb()
        _print(f"[Whisper] Dispositivo: {dev.upper()} | {os.cpu_count()} CPUs"
               + (f" | RAM {ram:.1f} GB" if ram else ""))
        _control("DEVICE", {"device": DEVICE, "model": MODEL_SIZE, "compute": COMPUTE})

        try:
            path = ensure_model(MODEL_SIZE)
            _control("STAGE", {"stage": "loading", "model": MODEL_SIZE})
            _print(f"[Whisper] Carregando {MODEL_SIZE} | device={DEVICE} | compute={COMPUTE}…")
            model = WhisperModel(path, device=dev, compute_type=COMPUTE, cpu_threads=threads,
                                 local_files_only=True)
            if dev == "cuda":
                # Teste real: cuDNN/cuBLAS ausentes só aparecem na primeira inferência
                segs, _ = model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32),
                                           vad_filter=False, without_timestamps=True)
                list(segs)
                BATCH_SIZE = int(os.environ.get("WHISPER_BATCH", "8"))
                _pipeline  = BatchedInferencePipeline(model)
            _model = model
            _print("[Whisper] Modelo pronto!")
            break
        except Exception as e:
            last_err = e
            traceback.print_exc()
            _print(f"[Whisper] Falha em {dev}: {e}")
            if dev == "cuda":
                # Python do sistema (não o ambiente do app) não recebe as libs CUDA na instalação automática
                if re.search(r"cublas|cudnn", str(e), re.I):
                    _print(f'[Whisper] Faltam as bibliotecas CUDA. Rode: "{sys.executable}" -m pip install '
                           'nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"')
                _print("[Whisper] Tentando novamente em CPU…")
    else:
        _control("FATAL", {"code": "load_failed", "error": f"{type(last_err).__name__}: {last_err}"})
        sys.exit(EXIT_LOAD_FAILED)

    _import_aligner()
    # Pré-carrega (e baixa, se preciso) o alinhador do idioma padrão já na inicialização
    lang = os.environ.get("WHISPER_PRELOAD_LANG", "pt")
    if whisperx and lang:
        _control("STAGE", {"stage": "aligner", "language": lang})
        try:
            _get_aligner(lang)
        except Exception as e:
            _print(f"[Whisper] Alinhador '{lang}' indisponível ({e}) — seguirá sem ele")

def _get_aligner(lang: str):
    if lang not in _aligners:
        _print(f"[Whisper] Carregando alinhador wav2vec2 para '{lang}'...")
        _aligners[lang] = whisperx.load_align_model(language_code=lang, device=ALIGN_DEVICE,
                                                    model_dir=os.path.join(MODELS_DIR, "align"))
        _print(f"[Whisper] Alinhador '{lang}' pronto.")
    return _aligners[lang]

# ── Áudio ──────────────────────────────────────────────────────────────────────
def _load_wav(path: str):
    """Lê o WAV PCM 16-bit mono 16kHz gerado pelo Node — sem precisar de ffmpeg aqui."""
    import numpy as np
    with wave.open(path, "rb") as wf:
        if wf.getsampwidth() != 2 or wf.getnchannels() != 1 or wf.getframerate() != SAMPLE_RATE:
            raise ValueError("WAV precisa ser PCM 16-bit mono 16kHz")
        frames = wf.readframes(wf.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

# ── Palavras ───────────────────────────────────────────────────────────────────
def _timed_words(segments: list) -> list:
    """
    Lista plana de palavras com start/end garantidos.
    O wav2vec2 não alinha números/siglas ("500", "4K") — antes eram descartados
    e sumiam da legenda. Agora o horário é interpolado entre os vizinhos.
    """
    out = []
    for seg in segments:
        s_start, s_end = float(seg.get("start", 0)), float(seg.get("end", 0))
        words = [w for w in (seg.get("words") or []) if str(w.get("word", "")).strip()]

        if not words:
            # Sem alinhamento: distribui a duração do segmento pelo tamanho das palavras
            tokens = seg.get("text", "").split()
            total  = sum(len(t) for t in tokens) or 1
            t = s_start
            for tok in tokens:
                d = (s_end - s_start) * len(tok) / total
                out.append({"word": tok, "start": t, "end": t + d})
                t += d
            continue

        i = 0
        while i < len(words):
            if "start" in words[i] and "end" in words[i]:
                w = words[i]
                out.append({"word": w["word"].strip(), "start": float(w["start"]), "end": float(w["end"])})
                i += 1
                continue
            # bloco de palavras sem horário: [i, j)
            j = i
            while j < len(words) and not ("start" in words[j] and "end" in words[j]):
                j += 1
            left  = out[-1]["end"] if out and out[-1]["end"] >= s_start else s_start
            right = float(words[j]["start"]) if j < len(words) else s_end
            right = max(right, left)
            n = j - i
            for k in range(n):
                out.append({"word": words[i + k]["word"].strip(),
                            "start": left + (right - left) * k / n,
                            "end":   left + (right - left) * (k + 1) / n})
            i = j
    return out

_SENTENCE_END = re.compile(r"[.!?…]$")
_SOFT_BREAK   = re.compile(r"[,;:]$")

def _words_to_captions(words: list, max_words: int = 4, max_chars: int = 24,
                       max_gap: float = 0.5, hold: float = 0.35) -> list:
    """
    Agrupa palavras em legendas curtas (estilo CapCut):
    quebra por nº de palavras, nº de caracteres, pausa na fala e pontuação.
    Depois estende cada legenda até a próxima (ou +hold s) para não piscar.
    """
    groups, bucket = [], []

    for w in words:
        if bucket:
            gap   = w["start"] - bucket[-1]["end"]
            chars = sum(len(b["word"]) + 1 for b in bucket) + len(w["word"])
            prev  = bucket[-1]["word"]
            if (gap > max_gap or len(bucket) >= max_words or chars > max_chars
                    or _SENTENCE_END.search(prev)
                    or (_SOFT_BREAK.search(prev) and len(bucket) >= 2)):
                groups.append(bucket)
                bucket = []
        bucket.append(w)
    if bucket:
        groups.append(bucket)

    captions = []
    for gi, g in enumerate(groups):
        start = g[0]["start"]
        end   = g[-1]["end"]
        nxt   = groups[gi + 1][0]["start"] if gi + 1 < len(groups) else None
        end   = min(end + hold, nxt) if nxt is not None else end + hold
        end   = max(end, start + 0.3)
        captions.append({
            "start":    round(start, 3),
            "end":      round(end, 3),
            "duration": round(end - start, 3),
            "text":     " ".join(w["word"] for w in g),
            "words":    [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in g],
        })
    return captions

def _shift(items: list, offset: float, limit: float) -> list:
    """Desconta o padding de silêncio adicionado pelo Node e limita à duração real."""
    def fix(t):
        return round(min(max(0.0, float(t) - offset), limit), 3)
    out = []
    for it in items:
        s = {**it, "start": fix(it.get("start", 0)), "end": fix(it.get("end", 0))}
        if it.get("words"):
            s["words"] = [{**w, **({"start": fix(w["start"]), "end": fix(w["end"])} if "start" in w and "end" in w else {})}
                          for w in it["words"]]
        out.append(s)
    return out

# ── Transcrição ────────────────────────────────────────────────────────────────
def _merge_word_pieces(words) -> list:
    """
    O Whisper às vezes quebra uma palavra em pedaços sem espaço ("Há" + "-la,",
    "netvale" + ".com" + ".br"). Palavra nova começa com espaço; o resto é continuação.
    """
    out = []
    for w in words:
        if out and not w.word.startswith(" "):
            out[-1]["word"] += w.word.strip()
            out[-1]["end"]   = w.end
        elif w.word.strip():
            out.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    return out

def _count_words(segments: list) -> int:
    return sum(len(s.get("words") or []) for s in segments)

def _speech_seconds(audio) -> float:
    """Segundos de fala segundo o VAD (o mesmo que a transcrição usa)."""
    try:
        from faster_whisper.vad import VadOptions, get_speech_timestamps
        stamps = get_speech_timestamps(audio, VadOptions(**VAD_PARAMS))
        return sum(t["end"] - t["start"] for t in stamps) / SAMPLE_RATE
    except Exception as e:
        _print(f"[Whisper] VAD indisponível para conferir a transcrição ({e})")
        return 0.0

def _transcribe_once(audio, language, cfg: dict) -> dict:
    kwargs = dict(
        language=language,
        beam_size=cfg["beam_size"],
        patience=cfg["patience"],
        temperature=0.0,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=VAD_PARAMS,
        condition_on_previous_text=False,
        no_speech_threshold=NO_SPEECH_THRESHOLD,
        log_prob_threshold=LOGPROB_THRESHOLD,
        compression_ratio_threshold=COMPRESSION_RATIO_THR,
        # pula trechos inventados em silêncios longos (precisa de word_timestamps)
        hallucination_silence_threshold=2.0,
    )
    if _pipeline is not None and not cfg.get("plain"):
        segs, info = _pipeline.transcribe(audio, batch_size=BATCH_SIZE, **kwargs)
    else:
        segs, info = _model.transcribe(audio, **kwargs)

    segments = [{
        "start": s.start, "end": s.end, "text": s.text.strip(), "words": _merge_word_pieces(s.words or []),
    } for s in segs]   # generator — a transcrição acontece aqui
    return {"segments": segments, "language": info.language,
            "language_probability": info.language_probability}

def transcribe(audio_path: str, language: str | None = None, padding: float = 0.0,
               max_words: int = 4) -> dict:
    audio    = _load_wav(audio_path)
    duration = max(0.0, round(len(audio) / SAMPLE_RATE - padding * 2, 3))
    detected_lang = language
    t0 = time.time()

    best_result, best_clean = None, []
    # Em CPU cada tentativa custa caro — no máximo 2
    configs = RETRY_CONFIGS if DEVICE == "cuda" else RETRY_CONFIGS[:2]
    speech_sec = _speech_seconds(audio)

    for attempt, cfg in enumerate(configs, start=1):
        _print(f"[Whisper] Tentativa {attempt}/{len(configs)} | beam={cfg['beam_size']} patience={cfg['patience']}")
        raw = _transcribe_once(audio, detected_lang, cfg)
        if detected_lang is None:
            detected_lang = raw.get("language") or "pt"
            _print(f"[Whisper] Idioma detectado: {detected_lang}")

        score = _score_result(raw.get("segments", []))
        n_filtered = len(raw.get("segments", [])) - len(score["clean_segments"])
        if n_filtered:
            _print(f"[Whisper] {n_filtered} segmento(s) filtrados como alucinação")

        n_words = _count_words(score["clean_segments"])
        # Poucas palavras para o tanto de fala que o VAD achou = transcrição
        # que perdeu trechos (acontece na GPU de forma intermitente): repete
        incomplete = speech_sec >= 3 and n_words < speech_sec * MIN_WORDS_PER_SPEECH_SEC
        if score["valid"] and not incomplete:
            best_result, best_clean = raw, score["clean_segments"]
            break
        if score["valid"]:
            _print(f"[Whisper] Incompleta — {n_words} palavras para {speech_sec:.1f}s de fala")
        else:
            _print(f"[Whisper] Rejeitado — {score['reason']}")
            if score["reason"] == "sem_segmentos" and speech_sec < 3:
                break  # VAD não achou fala: repetir não muda nada
        if best_result is None or n_words > _count_words(best_clean):
            best_result, best_clean = raw, score["clean_segments"]

    detected_lang = detected_lang or language or "pt"
    if not best_clean:
        _print("[Whisper] Nenhuma fala detectada.")
        return {"language": detected_lang, "probability": None, "duration": duration,
                "segments": [], "captions": [], "device": DEVICE, "model": MODEL_SIZE}

    # ── Refinamento opcional do tempo das palavras (whisperx / wav2vec2) ───────
    aligned_segs = best_clean
    if whisperx is not None:
        try:
            align_model, align_meta = _get_aligner(detected_lang)
            aligned_segs = whisperx.align(best_clean, align_model, align_meta, audio, ALIGN_DEVICE,
                                          return_char_alignments=False).get("segments", []) or best_clean
            _print("[Whisper] Alinhamento wav2vec2 concluido.")
        except Exception as e:
            _print(f"[Whisper] Alinhamento indisponível para '{detected_lang}' ({e}) — usando timestamps do Whisper.")

    aligned_segs = _shift(aligned_segs, padding, duration)
    words        = _shift(_timed_words(aligned_segs), 0, duration)
    captions     = _words_to_captions(words, max_words=max_words)

    for seg in aligned_segs:
        _print(f"  [{seg['start']:6.2f} -> {seg['end']:6.2f}]  {seg.get('text', '').strip()}")
    _print(f"[Whisper] Concluido em {time.time() - t0:.1f}s — {len(aligned_segs)} segmentos | {len(captions)} legendas")

    return {
        "language":    detected_lang,
        "probability": best_result.get("language_probability"),
        "duration":    duration,
        "segments":    [{"start": s["start"], "end": s["end"], "duration": round(s["end"] - s["start"], 3),
                         "text": s.get("text", "").strip()} for s in aligned_segs],
        "captions":    captions,
        "device":      DEVICE,
        "model":       MODEL_SIZE,
    }

# ── HTTP Handler ───────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if len(args) >= 2:
            _print(f'[Whisper] "{self.requestline}" {args[1]}')

    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _health(self):
        self._send_json(200, {"ok": True, "model": MODEL_SIZE, "device": DEVICE,
                              "compute": COMPUTE, "busy": _lock.locked()})

    def do_GET(self):
        if self.path == "/health":
            self._health()
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/health":
            self._health()
            return
        if self.path != "/transcribe":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send_json(400, {"error": "JSON inválido"})
            return

        file_path = body.get("file")
        if not file_path or not os.path.exists(file_path):
            self._send_json(400, {"error": "Informe 'file' (WAV 16kHz mono existente)"})
            return

        try:
            with _lock:
                result = transcribe(
                    file_path,
                    language=body.get("language") or None,
                    padding=float(body.get("padding") or 0),
                    max_words=int(body.get("maxWords") or 4),
                )
            self._send_json(200, result)
        except Exception as e:
            traceback.print_exc()
            self._send_json(500, {"error": str(e)})

# ── Entrypoint ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _print(f"[Whisper] Pasta de modelos: {MODELS_DIR}")
    _load_model()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    _control("READY", {"device": DEVICE, "model": MODEL_SIZE, "compute": COMPUTE, "port": PORT,
                       "aligner": whisperx is not None, "modelsDir": MODELS_DIR})
    _print(f"[Whisper] Servidor rodando em http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _print("[Whisper] Encerrando...")
