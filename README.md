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

## Teclado e comandos

- **Ctrl+K** abre a paleta de comandos (busca ações, efeitos, projetos e marcadores) e **?** abre a Central de atalhos, onde cada atalho pode ser trocado.
- Reprodução: **Espaço**, **J / K / L** (voltar / parar / avançar; repetir acelera), **← →** um quadro, **Shift+← →** um segundo, **↑ ↓** entre cortes.
- Edição: **S** corta, **Q / W** cortam e removem antes / depois da agulha, **Del** exclui, **Shift+Del** fecha o espaço.
- Marcadores: **M** marca, **I / O** definem uma região de trabalho, **Shift+↑ ↓** pulam entre marcadores.

## Camadas, mesclagem e câmera 2D

- **Botão direito numa área vazia da timeline → Nova camada** (estilo After Effects / Photoshop): Sólido (cor), Gradiente, Forma, Camada de ajuste (o filtro age sobre tudo abaixo), Câmera 2D, Vinheta, Grão de filme, Barras de cinema e Texto. Tudo editável depois no painel da direita.
- **Mesclagem:** botão direito num clip → Modo de mesclagem (ou Efeitos › Mesclagem): Multiplicar, Tela, Sobrepor, Luz suave…
- **Câmera 2D:** move, aproxima e gira o que está *abaixo* dela (o que está acima fica fixo), com keyframes e curvas. A IA planeja os movimentos pela fala e pela posição dos elementos das cenas HTML: **Gemini integrado**, **Copiar prompt de explicação** (`libs/camera-spec.js`, também em `/api/camera/spec`) e **Colar o JSON de outra IA**.

## Curvas de animação

Cada keyframe aceita uma curva (bezier ou por pontos). Para criar curvas novas com outra IA, use **＋ Nova curva → Colar código → Copiar instruções para outra IA**: o texto explica o formato (`libs/curve-spec.js`, também servido em `/api/curves/spec`).

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
