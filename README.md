# Motion Studio

Editor de vídeo com templates HTML animados, legendas automáticas (Whisper), biblioteca de SFX e exportação via Puppeteer/FFmpeg.

## Requisitos

- Node.js 20+
- Python 3.9+ (para a transcrição com Whisper)
- FFmpeg 9.0.2 (baixado para `.bin/ffmpeg` no `npm install`; `npm run ffmpeg:update` baixa de novo, `FFMPEG_PATH`/`FFPROBE_PATH` sobrescrevem)

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

### Remoção de fundo

"Remover fundo" (propriedades de um clip de vídeo ou imagem) usa o mesmo ambiente Python
da transcrição (`onnxruntime` + `numpy`) e baixa no primeiro uso o modelo
[Robust Video Matting](https://github.com/PeterL1n/RobustVideoMatting) (~15 MB, GPL-3.0)
para `models/rvm/`.

### Código e conteúdo de terceiros

- `libs/vendor/onetake/` — biblioteca de movimentos do [OneTake](https://github.com/feitangyuan/onetake), PolyForm Noncommercial (uso não comercial; ver `libs/vendor/README.md`).
- Blocos importados da aba **Blocos → Catálogo HyperFrames** vêm do [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) e levam a atribuição no próprio HTML.

### Configuração de IA (opcional)

Crie `config/ai.local.json` com suas credenciais. Esse arquivo está no `.gitignore` e nunca deve ser commitado.

## Executando

**Windows, sem instalar nada antes:** abra o `Motion Studio.exe` na pasta do
projeto. Na primeira vez ele baixa o Node.js (se faltar), instala os pacotes,
o FFmpeg e o Python da transcrição, e abre o editor. Erros aparecem numa
janela com código (tabela em [desktop/bootstrap/README.md](desktop/bootstrap/README.md)).

Pelo terminal:

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
