# Motion Studio

Editor de vídeo com templates HTML animados, legendas automáticas (Whisper), biblioteca de SFX e exportação via Puppeteer/FFmpeg.

## Requisitos

- Node.js 20+
- Python 3.9+ (para a transcrição com Whisper)
- FFmpeg (já incluído via `ffmpeg-static`)

## Instalação

```bash
npm install

# ambiente Python da transcrição
python3 -m venv venv
source venv/bin/activate
pip install -r libs/requirements-whisper.txt
```

### Modelo Whisper

O modelo **não** está no repositório (é grande). Ele é o `faster-whisper large-v3-turbo`
e deve ficar em `models/whisper/large-v3-turbo/` (ou ser baixado pelo Hugging Face na primeira execução).

### Configuração de IA (opcional)

Crie `config/ai.local.json` com suas credenciais. Esse arquivo está no `.gitignore` e nunca deve ser commitado.

## Executando

```bash
npm start          # servidor + interface
npm run desktop    # app desktop
npm run desktop:build
```

No macOS também é possível abrir o `Motion Studio.command`.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `Interface/` | Front-end (timeline, compositor, export) |
| `libs/` | Servidor, IA, transcrição, SFX |
| `templates/`, `text-templates/` | Templates HTML |
| `desktop/` | Launcher e build do app desktop |
| `fonts/` | Fontes |

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Licença: [MIT](LICENSE).
