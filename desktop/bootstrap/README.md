# Motion Studio.exe (Windows)

Executável que vai no repositório. Quem baixa o código do GitHub só abre ele:
na primeira vez (e quando o `package.json` muda) ele prepara tudo sozinho e
depois abre o editor.

1. **Node.js**: usa o do sistema (versão 20 ou mais nova) ou baixa o portátil.
2. **Pacotes**: `npm install`. O postinstall baixa o FFmpeg; o puppeteer baixa o Chrome do export.
3. **FFmpeg**: se o postinstall falhou, baixa de novo.
4. **Python** (transcrição): usa o do sistema (3.10 ou mais novo) ou baixa o portátil.
   O ambiente do Whisper se instala sozinho depois, dentro do app.
5. Abre `desktop/launcher.js` (servidor + janela do editor).

Node e Python portáteis ficam em `%LOCALAPPDATA%\Motion Studio\runtime`, e os
logs em `%LOCALAPPDATA%\Motion Studio\logs` (`setup.log` da preparação,
`motion-studio.log` do app).

Fonte: `MotionStudio.cs` (C# 5, compilado pelo `csc.exe` do .NET Framework 4,
que vem no Windows). Para gerar de novo depois de mudar o `.cs` ou o `Icon.png`:

```
npm run desktop:bootstrap
```

## Códigos de erro

| Código | O que aconteceu | O que fazer |
| --- | --- | --- |
| MS-101 | Pasta do Motion Studio incompleta | Deixe o `.exe` na pasta do projeto baixado (ou use um atalho) |
| MS-102 | Sem permissão de escrita na pasta | Mova a pasta para Documentos/Área de Trabalho |
| MS-201 | Falha ao baixar o Node.js | Confira a internet / proxy |
| MS-202 | Falha ao extrair o Node.js | Espaço em disco, antivírus |
| MS-203 | O Node.js não executa | Antivírus bloqueou `node.exe` |
| MS-301 | `npm install` falhou | Internet; as últimas linhas do npm aparecem na janela |
| MS-302 | Pacotes incompletos após instalar | Apague `node_modules` e abra de novo |
| MS-501 | Python para a transcrição não baixado (aviso; o app abre) | Internet, ou instale o Python 3.10+ |
| MS-502 | Sem `tar.exe` (Windows anterior ao 10 1803) (aviso) | Instale o Python 3.10+ manualmente |
| MS-610 | Nenhum navegador (Chrome, Edge ou Firefox) | Instale o Chrome |
| MS-620 | Nenhuma porta de rede livre | Feche outros programas |
| MS-630 | O servidor não iniciou | Veja `motion-studio.log` |
| MS-631 | O servidor não respondeu em 60 s | Veja `motion-studio.log` |
| MS-640 | O navegador não abriu | Veja `motion-studio.log` |
| MS-699 | O app fechou com erro | Veja `motion-studio.log` |
| MS-900 | Erro inesperado na preparação | Veja `setup.log` |

A janela de erro mostra o código, a mensagem, as últimas linhas do log e tem
os botões **Copiar detalhes**, **Abrir pasta de logs** e **Tentar de novo**.
