'use strict';
// motion-libs.js
//
//  Bibliotecas preferidas nos clipes com IA (escolhidas pelo usuário na barra
//  de IA e no "Gerar cenas com IA"). Cada uma traz as regras que entram nas
//  instruções do modelo — sempre respeitando o contrato window.Motion: a
//  biblioteca nunca toca sozinha, seek(t) posiciona tudo.
//
//  "onetake" é a linguagem de take contínuo (sem cortes) do projeto
//  github.com/feitangyuan/onetake, com a biblioteca de movimentos dele
//  (libs/vendor/onetake/motion.js → window.OM, licença não comercial —
//  o Motion Studio é não comercial). O host carrega o OM quando o clipe usa OM.*.

const GSAP_VERSION  = '3.15.0';
const THREE_VERSION = '0.186.1';
const GSAP_CDN  = `https://cdnjs.cloudflare.com/ajax/libs/gsap/${GSAP_VERSION}`;
const THREE_CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;

const MOTION_LIBS = {
  gsap: {
    label: 'GSAP',
    rules: [
      `GSAP ${GSAP_VERSION} é o MOTOR DE TEMPO do clipe: toda entrada, saída e movimento secundário numa timeline GSAP (sem interpolação escrita à mão).`,
      `- <script src="${GSAP_CDN}/gsap.min.js"></script>. Plugins (gratuitos) do mesmo diretório quando enriquecerem: SplitText.min.js (texto por letra/palavra/linha), CustomEase.min.js, DrawSVGPlugin.min.js (traço SVG), MorphSVGPlugin.min.js, MotionPathPlugin.min.js. Registre com gsap.registerPlugin(...).`,
      '- Uma timeline mestre const master = gsap.timeline({ paused: true }) (sub-timelines com master.add(tl, posição)). seek(t) { master.seek(t, false); } — nada mais dirige o tempo.',
      '- Proibido: gsap.to/from/fromTo direto (tocam sozinhos pelo ticker) — use master.to/... ; ScrollTrigger, Observer, Draggable, quickTo, delayedCall; repeat: -1 (use repetições finitas que cubram a duração); stagger from:"random", gsap.utils.random e valores "random(...)" (não determinísticos — use PRNG com seed). gsap.set é permitido.',
      '- SplitText e medidas de layout só depois de document.fonts.ready: monte a timeline dentro da Promise de whenReady e faça seek(t) ignorar chamadas antes disso.',
      '- Estado nunca em onUpdate/onComplete: o resultado precisa depender só de t (o export pode pedir quadros fora de ordem).',
      '- Aproveite: eases expressivos (expo.out, back.out(1.6), power4.inOut, CustomEase), stagger com each/amount e from:"center"/"edges", parâmetro de posição ("<", "-=0.3") para sobrepor movimentos.',
    ],
  },
  three: {
    label: 'Three.js',
    rules: [
      `Three.js ${THREE_VERSION} para profundidade REAL: inclua uma camada 3D sempre que fizer sentido (objeto herói, fundo volumétrico, partículas, logotipo extrudado, dispositivo/produto, gráficos 3D). Tipografia principal continua em HTML/CSS por cima do canvas (nítida e com as fontes do projeto).`,
      `- <script type="importmap">{"imports":{"three":"${THREE_CDN}/build/three.module.js","three/addons/":"${THREE_CDN}/examples/jsm/"}}</script> e o código em <script type="module">. Exatamente esta versão.`,
      '- Renderer dentro de try/catch: new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }), setPixelRatio(1), setSize(W, H), outputColorSpace = THREE.SRGBColorSpace, toneMapping = THREE.ACESFilmicToneMapping. Sem WebGL: renderer = null e o 2D continua.',
      '- window.Motion é definido FORA do try/catch do 3D (um módulo que falha não pode impedir o contrato).',
      '- Tudo função de t: câmera e objetos posicionados a partir de t; ShaderMaterial com uniform uTime = t; mixer.setTime(t) para animações glTF; partículas com posição = f(semente, t) — nunca acumule velocidade quadro a quadro (o export renderiza trechos em paralelo, começando no meio). renderer.render (ou composer.render) dentro de seek(t). Nunca setAnimationLoop, Clock ou getDelta.',
      '- Acabamento: luz de ambiente PBR com RoomEnvironment + PMREMGenerator (sem baixar HDR), MeshPhysicalMaterial (clearcoat, transmission, iridescence), névoa para profundidade, pós-processamento com EffectComposer + RenderPass + UnrealBloomPass (three/addons/postprocessing/) com moderação. A câmera viaja entre os assuntos e para quando chega (sem deriva de enfeite); o objeto herói gira só se girar mostrar algo novo.',
      '- Modelos: GLTFLoader().loadAsync(url) dentro de whenReady; sem modelo adequado, geometria procedural (ExtrudeGeometry, TubeGeometry, InstancedMesh para muitas cópias).',
      '- whenReady resolve só depois de modelos/texturas carregados e de um primeiro render.',
    ],
  },
  onetake: {
    label: 'OneTake (take contínuo)',
    rules: [
      'LINGUAGEM "ONE TAKE": o clipe é UM plano contínuo, sem cortes nem troca de slides. Cada momento nasce do anterior.',
      '- Biblioteca OneTake disponível como window.OM (o editor carrega sozinho quando o código usa OM.*; não inclua <script>). Todas são funções puras de t (segundos) — chame dentro de seek/render.',
      '- Câmera: monte um mundo maior que o quadro (#world) com as composições espalhadas nele. const cam = OM.camera(t, [{ t: 0, x, y, zoom: 1 }, { t: 2.4, x: x2, y: y2, zoom: 1.6, rot: 0 }, …], { W, H }) (x, y = ponto do mundo no centro do quadro; zoom em escala log; curve opcional por key) e world.style.transform = `matrix(${OM.view(cam, { W, H }).join(",")})` com transform-origin 0 0. Camadas de parallax: OM.view(cam, { W, H, depth: 0.6 }) (depth > 0 = mais longe, anda menos; < 0 = mais perto). OM.dof(depth, foco) → blur em px.',
      '- Entradas (retornam números para aplicar): OM.wordRise(t, t0) → { op, y, s } (palavra subindo com mola); OM.letterDrop(t, t0, i) → { op, y, sx, sy } (letra caindo com squash); OM.popIn(t, t0) → { op, s, dy }; OM.maskRise(t, t0, i) → { y (fração), visible }; OM.typeOn(t, t0, texto) → { str, caret }; OM.liftOut(t, t1) → { op, dy, blur, s } (saída).',
      '- Passagens (carry): OM.morphRect(t, t0, t1, A, B) → { x, y, w, h, r } (um card/botão vira a próxima tela; A e B = { x, y, w, h, r }); OM.iris(t, t0, t1, cx, cy, { W, H }) → { r } (círculo que abre do sujeito até cobrir o quadro); OM.zoomThrough(t, t0, t1, alvo, { W, H }) → { matrix } (a câmera mergulha num retângulo e o de dentro vira a próxima cena); OM.hop(t, t0, t1, de, para, { height }) → { x, y }; OM.gather(t, t0, t1, i, n, de, para) → { x, y, rot }.',
      '- Contato e física: OM.impact(t, tBatida) → { sx, sy } (squash no impacto); OM.press(t, tClique) → { s }; OM.cursor(t, [{ t, x, y }, …], [tClique, …]) → { x, y, s } (mão/cursor numa spline com cliques); OM.shake(t, tBatida, { amp }) → { x, y, rot }; OM.whip(t, t0, dur, dist) → { d } (chicote de câmera).',
      '- Curvas: OM.tween(t, t0, t1, OM.ease.expoOut) → 0–1; OM.spring(t - t0, zeta, omega) → 0–1 com balanço (zeta 0.6 / omega 20 padrão); OM.ease: smooth, smoother, cubicInOut, quintInOut, quartOut, quintOut, expoOut, expoInOut, backOut…',
      '- Divida em 3–6 "beats". A câmera viaja ENTRE os beats, chegando um pouco antes do sujeito, e PARA (≥ 0,4 s) quando a ação principal do beat acontece — movimento de câmera e ação principal não competem.',
      '- Continuidade (carry): em toda passagem de beat pelo menos um elemento visível sobrevive e se TRANSFORMA no protagonista do próximo (o card vira o gráfico, o ponto vira o botão, a palavra-chave encolhe e vira rótulo, a linha se estende e vira a moldura). Proibido: apagar tudo e montar uma composição nova (fade-out geral + fade-in).',
      '- Física crível: chegadas com mola (OM.spring / OM.wordRise), contato (um elemento empurra, encaixa ou desloca outro — OM.impact, OM.press), massa (objetos grandes aceleram devagar), sobreposição de movimentos.',
      '- Fundo contínuo: o fundo do mundo não troca de uma vez — gradiente, grade ou textura que acompanha a câmera (parallax em 2–3 profundidades).',
    ],
    sceneRule: 'ONE TAKE entre cenas: o quadro final da cena anterior é o quadro inicial desta — mesma posição de câmera e os elementos que ficaram na tela continuam e se transformam; nunca recomece do vazio.',
  },
};

/** Ids conhecidos, sem repetição, na ordem canônica */
function normalizeLibs(raw) {
  const wanted = new Set(Array.isArray(raw) ? raw.map(x => String(x).toLowerCase()) : []);
  return Object.keys(MOTION_LIBS).filter(id => wanted.has(id));
}

/** Bloco das instruções do modelo (vazio = IA escolhe livremente, como antes) */
function libRules(libs, { mode = 'create', scene = false } = {}) {
  if (!libs.length) return '';
  const names = libs.map(id => MOTION_LIBS[id].label).join(', ');
  return [
    '',
    `===== PREFERÊNCIAS DE ANIMAÇÃO DO USUÁRIO: ${names} (obrigatório) =====`,
    mode === 'edit'
      ? 'Na edição: use estas bibliotecas/linguagens no que você criar ou refizer; não reescreva o que já funciona só para trocar de biblioteca, a menos que o pedido peça.'
      : 'Use-as como base do clipe (combinam entre si: GSAP pode animar propriedades de objetos three.js e a câmera do one take).',
    ...libs.flatMap(id => ['', ...MOTION_LIBS[id].rules]),
    ...(scene ? libs.map(id => MOTION_LIBS[id].sceneRule).filter(Boolean) : []),
    '===== FIM DAS PREFERÊNCIAS =====',
  ].join('\n');
}

module.exports = { MOTION_LIBS, GSAP_VERSION, THREE_VERSION, normalizeLibs, libRules };
