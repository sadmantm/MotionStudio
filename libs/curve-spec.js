'use strict';
// libs/curve-spec.js
//
//  Especificação das curvas de animação (easing) do Motion Studio, escrita para uma IA
//  ler: serve de instrução do Gemini integrado (/api/ai/curve) e de texto para copiar e
//  colar em QUALQUER outra IA (botão "Copiar instruções" no editor de curvas). O formato é
//  o mesmo que Interface/clip-fx.js (curve / normalizeCurve) entende — mudou lá, mude aqui.

const SPEC = `# Curvas de animação do Motion Studio

Uma curva diz COMO um valor anima entre dois keyframes: ela transforma o progresso de tempo
linear u (0 → 1) num progresso do valor y (0 = valor do 1º keyframe, 1 = valor do 2º).
y pode passar de 1 ou ficar abaixo de 0 (overshoot / antecipação). y(0) deve ser 0 e y(1) deve ser 1.

## Formatos aceitos (escolha UM, responda só com o JSON)

1) Bezier cúbica (igual ao cubic-bezier() do CSS) — para easings suaves:
   { "name": "Suave", "p": [x1, y1, x2, y2] }
   - x1 e x2 ficam entre 0 e 1. y1 e y2 podem ir de -2 a 3 (y > 1 = ultrapassa e volta).
   - Exemplos:  linear [0,0,1,1] · ease-in-out [0.65,0,0.35,1] · ease-out forte [0.16,1,0.3,1]
                ease-in [0.7,0,0.84,0] · overshoot (back-out) [0.34,1.56,0.64,1] · antecipa e dispara [0.68,-0.55,0.27,1.55]

2) Polilinha de pontos — para movimentos que a bezier não faz (quicar, elástico, mola, degraus):
   { "name": "Quicar", "pts": [[0,0],[0.1,0.1],[0.36,1],[0.5,0.75],[0.64,1],[0.8,0.94],[1,1]] }
   - Cada ponto é [x, y]: x = progresso do tempo (de 0 a 1, em ordem crescente), y = progresso do valor.
   - Primeiro ponto [0,0], último [1,1]. Use de 12 a 60 pontos; mais pontos = curva mais fiel.
   - O valor entre dois pontos é interpolado em linha reta.

## Como escolher
- Entrada que "chega e assenta": ease-out (começa rápido, termina devagar), ex. [0.16,1,0.3,1].
- Saída que "acelera para fora": ease-in, ex. [0.7,0,0.84,0].
- Movimento natural de câmera/zoom: ease-in-out suave, ex. [0.45,0,0.55,1].
- Chegada com energia: overshoot, ex. [0.34,1.56,0.64,1]. Mola/elástico/quicar: use "pts".
- Dê um "name" curto em português (1 a 3 palavras).

## Resposta
Somente o JSON do formato escolhido, sem texto em volta e sem comentários.
Também é aceita uma função JavaScript pura de t (0 a 1) que devolve y, por exemplo:
  t => 1 - Math.pow(1 - t, 3)
(o editor amostra essa função em pontos; não use nada além de Math e operadores).`;

function register(app) {
  /** Texto para copiar para outra IA */
  app.get('/api/curves/spec', (req, res) => {
    res.type('text/plain; charset=utf-8').send(SPEC);
  });
}

module.exports = { SPEC, register };
