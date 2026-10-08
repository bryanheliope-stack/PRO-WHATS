import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 📂 Pastas
const TEMP_DIR = path.join(__dirname, 'temp')
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge')
const AUTH_DIR = path.join(__dirname, 'auth')
;[TEMP_DIR, KNOWLEDGE_DIR, AUTH_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ==========================================
// 🏓 SISTEMA DE PING
// ==========================================
const PING_SYSTEM = {
  url: process.env.RENDER_EXTERNAL_URL || process.env.PING_URL || '',
  interval: parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000,
  timer: null,

  async ping() {
    if (!this.url) return false
    try {
      const res = await fetch(`${this.url}/ping`, { signal: AbortSignal.timeout(15000) })
      console.log(`🏓 Ping: ${res.ok ? '✅ ONLINE' : '⚠️ OK'}`)
      return true
    } catch (err) {
      console.warn(`🏓 Ping falhou: ${err.message}`)
      return false
    }
  },

  iniciar() {
    if (!this.url) return
    this.ping()
    this.timer = setInterval(() => this.ping(), this.interval)
  }
}

// ==========================================
// 🎮 BASE DE CONHECIMENTO — ATUALIZADA!
// ==========================================
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const STOPWORDS = new Set(['de','do','da','no','na','em','um','uma','os','as','ou','se','eu','me','meu','minha','pra','para','com','que','qual','como','sobre'])
const TERMOS_GENERICOS = new Set(['emulador','emuladores','emular','emulacao'])
const TERMOS_PC_FORTES = new Set(['computador','notebook','desktop','pcsx2','rpcs3','cemu','xenia','xemu','ryubing','ryujinx','duckstation'])
const TERMOS_MOBILE = new Set(['celular','android','mobile','termux','telefone','smartphone','winlator','gamehub'])

const EmuladorBase = {
  dados: new Map(),
  aliases: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),

  carregar() {
    // Sempre começa da base atualizada do código...
    this.inicializarBaseCompleta()
    // ...e só reaproveita do arquivo o que foi ensinado com !corrige
    try {
      if (fs.existsSync(this.arquivo)) {
        const salvos = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        let custom = 0
        for (const [chave, valor] of Object.entries(salvos)) {
          if (valor && valor.custom) {
            this.dados.set(chave.toLowerCase(), valor)
            custom++
          }
        }
        console.log(`🎮 Base carregada: ${this.dados.size} verbetes (${custom} ensinados por você)`)
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao ler base salva: ${err.message}`)
    }
    this.salvar()
  },

  inicializarBaseCompleta() {
    const base = {
      // ===== WINLATOR =====
      'winlator': {
        plataforma: 'Android',
        sistema: 'Windows (PC)',
        descricao: 'Emulador que roda programas e jogos de Windows no celular Android. Usa Box64 + Wine.',
        requisitos: 'Android 10+ | Snapdragon 720G+ recomendado | 4GB RAM mínimo',
        resolucao: '800×600 (baixa) | 960×544 (média) | 1280×720 (alta)',
        dicas: 'Crie containers separados para jogos diferentes. Use resolução menor se lento.',
        site: 'winlator.dev'
      },
      'winlator configuração': {
        titulo: '⚙️ Winlator — Configuração Ideal',
        resolucao: '📱 Celular básico: 800×600\n📱 Intermediário: 960×544\n📱 Top de linha: 1280×720',
        memoria: '4GB em celulares com 8GB RAM | 2-3GB em celulares com 6GB RAM',
        wow64: 'ON para jogos 32-bit | OFF para 64-bit (mais rápido)',
        msync_esync: 'ATIVADO — reduz uso de CPU',
        audio: 'ALSA (baixa latência) → mude para Pulse se não tiver som'
      },
      'winlator driver gráfico': {
        titulo: '🎮 Driver Gráfico — Winlator',
        snapdragon_adreno: '✅ Turnip (mais rápido) — Vulkan nativo',
        mediatek_exynos_mali: '✅ VirGL (compatibilidade melhor)',
        fallback: 'LLVMpipe — apenas para teste (muito lento)',
        observacao: 'Turnip = 2-3x mais rápido que renderizador padrão no Adreno!'
      },
      'winlator dxvk': {
        titulo: '🔷 DXVK no Winlator',
        o_que_e: 'Traduz DirectX para Vulkan — essencial para performance',
        dx10_dx11: 'DXVK 2.4+ (mais novo e estável)',
        dx9_antigos: 'DXVK 1.10.3 (mais compatível com jogos antigos)',
        d3d12: 'VKD3D-Proton 2.14.1+',
        dicas: 'Se o jogo travar, troque a versão do DXVK. Cada jogo gosta de uma versão diferente!'
      },
      'winlator box64': {
        titulo: '📦 Box64 — O que é e como configurar',
        o_que_e: 'Converte instruções x86/x64 do Windows para ARM do celular — sem ele nada funciona!',
        perfis: [
          '⚡ Rápido — mais velocidade, pode ter instabilidade',
          '⚖️ Equilibrado — recomendado para maioria dos jogos (PADRÃO)',
          '🛡️ Estável — mais seguro, mas um pouco mais lento',
          '🔬 Conservador — máxima compatibilidade, mais lento'
        ],
        dica: 'Comece com "Equilibrado". Se o jogo travar, mude para "Estável". Se for lento, tente "Rápido".'
      },
      'winlator wine': {
        titulo: '🍷 Wine — Camada de Compatibilidade',
        o_que_e: 'Faz o Windows entender os programas — não é um emulador, é uma tradução de chamadas',
        versoes: [
          'Wine 7.x — Melhor para jogos antigos (antes de 2010)',
          'Wine 9.x — Bom equilíbrio',
          'Wine 10.x — Mais novo, melhor para jogos modernos'
        ],
        dica: 'Jogo antigo = Wine 7.x. Jogo novo = Wine 10.x. Teste ambas se tiver problema!'
      },

      // ===== GAMEHUB =====
      'gamehub': {
        plataforma: 'Android',
        sistema: 'Windows (PC)',
        descricao: 'Novo emulador de Windows para Android. Mais moderno que o Winlator, usa Proton + FEX.',
        requisitos: 'Android 10+ | Snapdragon 8 Gen 1+ ideal | 6GB RAM mínimo',
        vantagens: 'Interface mais amigável, suporte a Proton, gerenciador de biblioteca de jogos',
        site: 'winlator.dev/gamehub'
      },
      'gamehub configuração': {
        titulo: '⚙️ GameHub — Melhores Configurações',
        resolucao: '📱 Celular básico: 800×600\n📱 Intermediário: 800×600 ou 960×540\n📱 Top de linha: 1280×720',
        driver_grafico: 'Snapdragon: Turnip v26+ | MediaTek/Exynos: Driver do Sistema',
        dxvk: 'DXVK 2.3.1 Async (recomendado) ou 2.6.2+ se tiver problema',
        vkd3d: 'VKD3D-Proton 3.0b para jogos DirectX 12',
        compatibilidade: 'Proton 11 arm64 (mais recente) — mude para versões antigas se travar',
        cpu_translator: 'FEX — use a versão mais recente disponível'
      },
      'gamehub dxvk': {
        titulo: '🔷 DXVK no GameHub',
        versoes_recomendadas: [
          '✅ DXVK 2.3.1 Async — Recomendado para maioria dos jogos',
          '✅ DXVK 2.6.2 Async — Se tiver problemas gráficos',
          '✅ DXVK 1.10.3 Async — Jogos antigos DirectX 9',
          '⚠️ Sempre teste: não existe uma versão perfeita para todos os jogos!'
        ],
        dicas: 'Async = evita micro-travamentos ao carregar texturas. Sempre prefira versões Async!'
      },
      'gamehub proton': {
        titulo: '🍷 Proton — Camada de Compatibilidade',
        o_que_e: 'Versão modificada do Wine, desenvolvida pela Valve. Melhora compatibilidade e performance.',
        versoes: [
          'Proton 11 arm64 — Mais recente, melhor para jogos novos',
          'Proton 10 arm64 v2 — Se o mais novo travar, tente este'
        ],
        dica: 'Sempre comece pela versão mais nova. Se o jogo não abrir, baixe uma versão e teste de novo!'
      },
      'gamehub driver': {
        titulo: '🎮 Driver Gráfico — GameHub',
        snapdragon: '✅ Turnip v26+ — melhor performance e compatibilidade',
        mediatek_exynos: '✅ Driver do Sistema — Turnip pode não funcionar bem',
        mali: '✅ Driver do Sistema — VirGL como alternativa',
        observacao: 'Se aparecer tela preta ou glitches, troque o driver!'
      },

      // ===== DXVK — COMPLETO =====
      'dxvk': {
        titulo: '🔷 DXVK — Guia Completo',
        o_que_e: 'DirectX Vulkan — traduz comandos DirectX do jogo para Vulkan nativo do celular',
        versoes: {
          'DXVK 1.10.3': '✅ Melhor para jogos antigos DirectX 9 (2010 ou antes)',
          'DXVK 2.3.1': '✅ Recomendado para maioria dos jogos DirectX 10/11',
          'DXVK 2.4+': '✅ Mais novo, melhor para jogos modernos',
          'DXVK 2.6+': '✅ Correções recentes — teste se tiver problemas'
        },
        async: 'Versões com "Async" evitam travamentos ao carregar texturas — sempre prefira!',
        dicas: [
          '🔹 Jogo não abre? → Troque a versão do DXVK',
          '🔹 Tela preta? → Mude o driver gráfico',
          '🔹 Lento? → Resolução menor + DXVK 2.x + Turnip',
          '🔹 Sempre teste mais de uma versão — cada jogo é diferente!'
        ]
      },

      // ===== WINE =====
      'wine': {
        titulo: '🍷 Wine — Camada de Compatibilidade',
        o_que_e: '"Wine Is Not an Emulator" — traduz chamadas do Windows para Linux/Android',
        versoes: {
          'Wine 7.x': 'Jogos antigos, compatibilidade excelente',
          'Wine 8.x': 'Equilíbrio entre compatibilidade e recursos',
          'Wine 9.x': 'Melhorias de performance',
          'Wine 10.x': 'Suporte a jogos mais novos e DirectX atualizado'
        },
        wine_vs_proton: 'Proton = Wine + patches da Valve → mais compatível com jogos',
        dica: 'Se um jogo não funciona com Wine puro, tente uma versão do Proton!'
      },

      // ===== BOX64 =====
      'box64': {
        titulo: '📦 Box64 — Tradutor de CPU',
        o_que_e: 'Converte código x86/x64 (PC) para ARM (celular). Sem ele, nenhum jogo roda!',
        modos: {
          'Rápido': 'Máxima velocidade, pode travar em alguns jogos',
          'Equilibrado': 'Recomendado — bom desempenho e estabilidade',
          'Estável': 'Mais seguro, um pouco mais lento',
          'Conservador': 'Máxima compatibilidade, mais lento'
        },
        dicas: [
          '🔹 Comece no modo Equilibrado',
          '🔹 Se travar → mude para Estável',
          '🔹 Se lento → tente Rápido',
          '🔹 Cada jogo pode precisar de uma configuração diferente!'
        ]
      },

      // ===== DRIVERS GRÁFICOS =====
      'drivers gráficos': {
        titulo: '🎮 Drivers Gráficos — Qual Escolher',
        turnip: {
          para: 'Snapdragon / Adreno',
          vantagens: '2-3x mais rápido que o driver padrão! Melhor compatibilidade com DXVK',
          versoes: 'v24, v25, v26 — sempre use a mais recente disponível'
        },
        vortek: {
          para: 'MediaTek / Exynos / Mali',
          vantagens: 'Driver Vulkan alternativo quando Turnip não funciona bem'
        },
        virgl: {
          para: 'Qualquer GPU — fallback universal',
          vantagens: 'Funciona em tudo',
          desvantagem: 'Mais lento'
        },
        sistema: {
          para: 'MediaTek, Exynos, Mali',
          vantagens: 'Mais estável',
          desvantagem: 'Mais lento que Turnip'
        },
        dica_ouro: '📌 Snapdragon = SEMPRE Turnip. Outros = teste Sistema → VirGL → Vortek'
      },

      // ===== COMPARAÇÃO =====
      'winlator vs gamehub': {
        titulo: 'Winlator vs GameHub — Qual Escolher?',
        winlator: [
          '✅ Mais leve e rápido',
          '✅ Mais opções de configuração avançada',
          '✅ Mais versões de DXVK e Wine',
          '❌ Interface mais técnica'
        ],
        gamehub: [
          '✅ Interface mais amigável',
          '✅ Gerenciador de jogos automático',
          '✅ Suporte nativo a Proton',
          '✅ Mais fácil para iniciantes',
          '❌ Um pouco mais pesado'
        ],
        conclusao: 'Comece com GameHub se for iniciante. Use Winlator se quiser mais controle e performance.'
      },

      // ===== DICAS DE PERFORMANCE =====
      'melhorar performance winlator gamehub': {
        titulo: '⚡ Melhorar Velocidade — Winlator / GameHub',
        lista: [
          '🔹 Resolução: abaixe para 800×600 ou 960×540',
          '🔹 Driver: Snapdragon = Turnip | Outros = Sistema/VirGL',
          '🔹 DXVK: Use versão Async (2.3.1 ou 2.4+)',
          '🔹 Box64: Modo Equilibrado ou Rápido',
          '🔹 MSync/ESync: ATIVADO — reduz uso de CPU',
          '🔹 WOW64: OFF se jogo for 64-bit (mais rápido!)',
          '🔹 Feche outros apps antes de jogar',
          '🔹 Ative modo de performance do celular',
          '🔹 Se o jogo travar → troque versão do DXVK ou do Wine/Proton'
        ]
      },

      // ===== PROBLEMAS COMUNS =====
      'problemas comuns winlator gamehub': {
        titulo: '🔧 Problemas Comuns e Soluções',
        tela_preta: [
          '✅ Troque o driver gráfico (Turnip → Sistema)',
          '✅ Mude a versão do DXVK',
          '✅ Reduza a resolução',
          '✅ Reinicie o celular'
        ],
        jogo_não_abre: [
          '✅ Mude a versão do DXVK',
          '✅ Troque a versão do Wine/Proton',
          '✅ Ative/desative WOW64',
          '✅ Verifique se o jogo é 32-bit ou 64-bit'
        ],
        lento: [
          '✅ Resolução mais baixa',
          '✅ Driver Turnip (Snapdragon)',
          '✅ Feche outros apps',
          '✅ Ative modo de performance',
          '✅ Box64 no modo Rápido'
        ],
        sem_som: [
          '✅ Troque driver de áudio: ALSA → PulseAudio'
        ]
      },

      // ==========================================================
      // 📱 EMULADORES ANDROID (PRIORIDADE)
      // ==========================================================
      'emuladores android': {
        categoria: 'android',
        titulo: '📱 Emuladores no Android — Qual usar pra cada console',
        lista: [
          '🔹 Nintendo Switch → Eden',
          '🔹 PSP → PPSSPP',
          '🔹 GameCube / Wii → Dolphin',
          '🔹 PS2 → NetherSX2 / ARMSX2',
          '🔹 Nintendo 3DS → Azahar',
          '🔹 Nintendo DS → melonDS / DraStic',
          '🔹 Dreamcast → Flycast',
          '🔹 PS Vita → Vita3K (experimental)',
          '🔹 PS1, N64, SNES, GBA, Mega Drive… → RetroArch',
          '🔹 Jogos de PC → Winlator / GameHub'
        ],
        dica: 'Pergunte "[emulador] configuração". Ex: "Eden configuração", "PPSSPP configuração", "Dolphin configuração".',
        observacao: 'PS3, Xbox 360 e Wii U não têm emulador nativo viável no Android. Pergunte "emuladores pc" pra ver as opções de computador (secundárias aqui).'
      },

      'bios keys firmware': {
        categoria: 'android',
        aliases: ['bios', 'firmware', 'keys', 'prod.keys'],
        titulo: '🔑 BIOS, Keys e Firmware',
        o_que_e: 'Alguns emuladores precisam de arquivos do console original pra funcionar.',
        lista: [
          '🔹 Switch (Eden): prod.keys + firmware',
          '🔹 PS2: BIOS',
          '🔹 PS Vita (Vita3K): firmware + pacote de fontes',
          '🔹 PS1 (RetroArch): BIOS em alguns jogos',
          '🔹 Dreamcast (Flycast): opcional',
          '🔹 PSP, GameCube/Wii, 3DS: normalmente não precisam'
        ],
        observacao: 'Esses arquivos devem ser extraídos do SEU próprio console. Eu não passo nem indico download de BIOS, keys ou jogos.'
      },

      'mali emuladores': {
        categoria: 'android',
        aliases: ['mali', 'mediatek', 'dimensity', 'exynos', 'helio'],
        titulo: '🟧 Emuladores em Mali / MediaTek / Exynos',
        roda_bem: 'PPSSPP, Flycast, RetroArch, melonDS, Dolphin (jogos leves) e PS2 com OpenGL costumam rodar bem.',
        limitado: 'Switch (Eden): em Mali de entrada/média só jogos leves. Mali topo de linha (G710 / Immortalis) vai bem melhor.',
        driver_grafico: 'Use o driver do sistema. Turnip é só pra Snapdragon/Adreno.',
        vulkan_vs_opengl: 'Vulkan costuma ser melhor, mas em Mali antigo/médio alguns emuladores dão glitch — se acontecer, troque pra OpenGL ES.',
        dicas: [
          '🔹 Atualize o Android do aparelho — o driver da GPU vem junto',
          '🔹 Comece na resolução nativa (1x) e vá subindo',
          '🔹 Esquentar derruba o desempenho: tire a capinha e evite carregar jogando'
        ]
      },

      // ----- EDEN (Switch) -----
      'eden': {
        categoria: 'android',
        aliases: ['switch', 'nintendo switch', 'yuzu', 'nsw'],
        plataforma: 'Android (também tem versão PC)',
        sistema: 'Nintendo Switch',
        descricao: 'Emulador de Switch de código aberto, baseado no código do Yuzu (que foi descontinuado em 2024). No Android é hoje o emulador de Switch mais ativo.',
        requisitos: 'Android com Vulkan 1.1+ | Snapdragon 8 Gen 1 ou melhor ideal | 8GB RAM+ recomendado',
        precisa: 'prod.keys + firmware extraídos do SEU Switch (o Eden não fornece)',
        dicas: [
          '🔹 No Android só existe Vulkan (sem OpenGL)',
          '🔹 Tem baixador de driver embutido — ele sugere o driver pro seu aparelho',
          '🔹 Jogos pesados pedem Snapdragon topo de linha'
        ],
        site: 'eden-emu.dev'
      },
      'eden configuração': {
        categoria: 'android',
        titulo: '⚙️ Eden (Switch) — Configuração Ideal',
        api_grafica: 'Vulkan (única opção no Android)',
        resolucao: '📱 Básico / Mali: 0.75x\n📱 Intermediário: 1x (720p)\n📱 Top de linha: 1x a 1.5x',
        modo_docked: 'DESLIGADO (modo portátil) — mais leve. Só ligue em aparelho forte.',
        precisao_gpu: 'Normal (mude pra Performance se estiver lento)',
        shaders: 'Cache de shader em disco LIGADO + compilação assíncrona (se existir a opção) — reduz travadinhas',
        cpu: 'Se aparecer a opção de execução nativa (NCE), ative — rende bem mais em ARM',
        astc: 'Decodificação ASTC: GPU se o driver aguentar, senão CPU assíncrona',
        driver_grafico: 'Snapdragon: Turnip (pelo baixador embutido) | MediaTek/Exynos/Mali: Driver do Sistema',
        memoria: '8GB é o mínimo confortável | 12GB+ pra jogos pesados',
        dica: 'Dá pra ajustar por jogo (segure o jogo na lista e abra as configurações dele) — cada jogo gosta de uma coisa.'
      },
      'eden driver': {
        categoria: 'android',
        titulo: '🎮 Eden — Driver Gráfico',
        snapdragon: '✅ Turnip — use o baixador de driver embutido e pegue o mais recente',
        mediatek_exynos_mali: '✅ Driver do Sistema (Turnip não funciona fora de Adreno)',
        observacao: 'Em Mali de entrada/média o desempenho é limitado: foque em jogos leves e indies. Mantenha o Eden sempre na versão mais nova — o suporte a Mali vem melhorando.'
      },
      'eden problemas': {
        categoria: 'android',
        titulo: '🔧 Eden — Problemas Comuns',
        tela_preta: [
          '✅ Troque o driver (Turnip ↔ Sistema)',
          '✅ Apague o cache de shader do jogo',
          '✅ Reduza a resolução'
        ],
        jogo_não_abre: [
          '✅ Confira se prod.keys e firmware estão instalados',
          '✅ Jogo novo pode pedir firmware mais atual',
          '✅ Atualize o Eden pra versão mais recente'
        ],
        lento: [
          '✅ Resolução menor + modo Docked desligado',
          '✅ Precisão da GPU em Performance',
          '✅ Feche outros apps e ative modo desempenho'
        ],
        glitches: [
          '✅ Limpe o cache de shader',
          '✅ Teste outra versão do driver'
        ]
      },

      // ----- PPSSPP (PSP) -----
      'ppsspp': {
        categoria: 'android',
        aliases: ['psp', 'playstation portable'],
        plataforma: 'Android (também PC, iOS)',
        sistema: 'PlayStation Portable (PSP)',
        descricao: 'O melhor emulador de PSP. Gratuito, de código aberto e roda bem em praticamente qualquer celular. Existe o "PPSSPP Gold" pra quem quer apoiar o projeto.',
        requisitos: 'Qualquer celular intermediário já joga bem | Vulkan recomendado',
        precisa: 'Só o jogo (ISO / CSO / CHD) — não precisa de BIOS',
        site: 'ppsspp.org'
      },
      'ppsspp configuração': {
        categoria: 'android',
        titulo: '⚙️ PPSSPP — Configuração Ideal',
        backend: 'Vulkan (padrão). Se der tela preta/glitch em Mali antigo → OpenGL',
        resolucao: '📱 Básico: 1x a 2x\n📱 Intermediário: 2x a 3x\n📱 Top de linha: 4x a 5x',
        renderizacao: 'Buffered rendering (padrão — não mude)',
        frameskip: 'DESLIGADO. Só use Auto Frameskip se o jogo ficar abaixo de 60 FPS e nada mais resolver',
        filtros: 'Anisotrópico 4x–16x é barato e melhora muito | Texture scaling: DESLIGADO em celular fraco',
        hacks_velocidade: 'Lazy texture caching ligado | "Skip GPU readbacks" só se precisar (pode quebrar efeitos)',
        cpu: 'JIT (padrão). "Multithreaded (experimental)" pode dar FPS em alguns jogos — teste',
        audio: 'Latência de áudio baixa; se estalar o som, aumente o buffer',
        dica: 'Resolução é o que mais pesa. Se travar, baixe ela antes de mexer em outras coisas.'
      },
      'ppsspp problemas': {
        categoria: 'android',
        titulo: '🔧 PPSSPP — Problemas Comuns',
        tela_preta: [
          '✅ Troque o backend (Vulkan ↔ OpenGL)',
          '✅ Desligue shaders de pós-processamento'
        ],
        texturas_quebradas: [
          '✅ Desligue Texture scaling',
          '✅ Desative hacks de velocidade ("Skip GPU readbacks")',
          '✅ Teste o outro backend'
        ],
        lento: [
          '✅ Baixe a resolução de renderização',
          '✅ Frameskip como último recurso',
          '✅ Desligue shaders de pós-processamento'
        ],
        jogo_não_abre: [
          '✅ Confira se a ISO/CSO/CHD não está corrompida',
          '✅ Teste o jogo em outro formato (ISO → CSO/CHD ou o contrário)'
        ],
        sem_som: [
          '✅ Confira se o som está ligado nas configurações',
          '✅ Aumente o buffer de áudio'
        ]
      },

      // ----- DOLPHIN (GameCube / Wii) -----
      'dolphin': {
        categoria: 'android',
        aliases: ['gamecube', 'wii', 'gc', 'ngc'],
        plataforma: 'Android (também PC)',
        sistema: 'Nintendo GameCube e Wii',
        descricao: 'Emulador de GameCube e Wii, gratuito e de código aberto. Muito maduro: a maioria dos jogos roda bem em celular forte.',
        requisitos: 'Aparelho 64-bit | Snapdragon 8xx / Dimensity topo ideal | 4GB RAM+',
        precisa: 'Só o jogo (ISO / RVZ / GCZ) — não precisa de BIOS',
        site: 'dolphin-emu.org'
      },
      'dolphin configuração': {
        categoria: 'android',
        titulo: '⚙️ Dolphin (GC/Wii) — Configuração Ideal',
        backend: 'Vulkan (Snapdragon com Turnip e Mali recente) | OpenGL ES se der glitch',
        resolucao: '📱 Básico: Nativa (1x)\n📱 Intermediário: 1x a 2x\n📱 Top de linha: 2x a 3x',
        shaders: '"Asynchronous (Ubershaders)" evita travadinhas | Celular fraco: "Asynchronous (Skip Drawing)"',
        cpu: 'Dual Core LIGADO | JIT ARM64 | DSP em HLE (mais rápido que LLE)',
        hacks_velocidade: 'Skip EFB Access from CPU: ligado | Ignore Format Changes: ligado (pode quebrar efeito em poucos jogos)',
        dica: 'Wii: o controle é emulado na tela ou por Bluetooth. Se o jogo exigir sensor, mapeie o giroscópio do celular.'
      },
      'dolphin problemas': {
        categoria: 'android',
        titulo: '🔧 Dolphin — Problemas Comuns',
        lento: [
          '✅ Resolução nativa (1x)',
          '✅ Shader em "Asynchronous (Skip Drawing)"',
          '✅ Dual Core ligado'
        ],
        tela_preta: [
          '✅ Troque Vulkan ↔ OpenGL ES',
          '✅ Atualize o driver gráfico (Turnip em Snapdragon)'
        ],
        travadinhas: [
          '✅ Use Ubershaders assíncronos',
          '✅ A primeira vez que cada efeito aparece sempre trava um pouco — melhora com o cache'
        ],
        jogo_não_abre: [
          '✅ Confira se a ISO não está corrompida',
          '✅ Tente converter pra RVZ'
        ]
      },

      // ----- PS2 -----
      'nethersx2': {
        categoria: 'android',
        aliases: ['ps2', 'playstation 2', 'aethersx2', 'armsx2'],
        plataforma: 'Android',
        sistema: 'PlayStation 2',
        descricao: 'O AetherSX2 foi descontinuado. O NetherSX2 é uma versão corrigida dele e o ARMSX2 é um projeto mais novo baseado no PCSX2. Funcionam de forma parecida.',
        requisitos: 'Snapdragon 7xx/8xx ideal | 4GB RAM+ | Mali: depende muito do jogo',
        precisa: 'BIOS do seu próprio PS2',
        dicas: [
          '🔹 PS2 é pesado: nem todo jogo roda a 60 FPS em celular mediano',
          '🔹 Celular de entrada: prefira jogos leves'
        ]
      },
      'nethersx2 configuração': {
        categoria: 'android',
        titulo: '⚙️ NetherSX2 / ARMSX2 (PS2) — Configuração Ideal',
        renderizador: 'Snapdragon: Vulkan | Mali/MediaTek: teste OpenGL primeiro (Vulkan pode dar glitch)',
        resolucao: '📱 Básico/Intermediário: Nativa (1x)\n📱 Top de linha: 2x (3x só em flagship)',
        mtvu: 'MTVU (VU1 multithread): LIGADO',
        ee_cycle_rate: '100% (padrão). Abaixar pode dar FPS, mas pode bugar jogos',
        qualidade: 'Blending: Basic | Mipmapping: desligado | Filtro de textura: Bilinear (PS2)',
        extras: 'Patches de widescreen: ligue se o jogo tiver',
        dica: 'Configure por jogo: cada jogo de PS2 se comporta de um jeito.'
      },
      'nethersx2 problemas': {
        categoria: 'android',
        titulo: '🔧 PS2 no Android — Problemas Comuns',
        tela_preta: [
          '✅ Troque o renderizador (Vulkan ↔ OpenGL)',
          '✅ Confira se a BIOS foi carregada corretamente'
        ],
        lento: [
          '✅ Resolução nativa (1x)',
          '✅ MTVU ligado',
          '✅ Abaixe o EE Cycle Rate aos poucos'
        ],
        graficos_bugados: [
          '✅ Troque o renderizador',
          '✅ Aumente a precisão do Blending um nível'
        ]
      },

      // ----- 3DS -----
      'azahar': {
        categoria: 'android',
        aliases: ['3ds', 'nintendo 3ds', 'citra', 'lime3ds'],
        plataforma: 'Android (também PC)',
        sistema: 'Nintendo 3DS',
        descricao: 'Continuação do Citra (descontinuado em 2024). Roda a maioria dos jogos de 3DS bem em celular intermediário.',
        requisitos: 'Aparelho intermediário ou melhor | Vulkan ou OpenGL ES',
        precisa: 'Só o jogo (de preferência descriptografado)',
        configuracao: [
          '🔹 API gráfica: Vulkan (OpenGL ES se der glitch)',
          '🔹 Resolução: 1x (básico) | 2x (intermediário) | 3x–4x (top)',
          '🔹 Cache de shader em disco: LIGADO',
          '🔹 Compilação assíncrona de shader: LIGADA',
          '🔹 GPU assíncrona: LIGADA',
          '🔹 Filtro de textura: nenhum em celular fraco',
          '🔹 Limite de frames: 100%'
        ],
        dica: 'Se travar, o que mais pesa é a resolução. Comece em 1x.'
      },

      // ----- NDS -----
      'nds': {
        categoria: 'android',
        aliases: ['ds', 'nintendo ds', 'melonds', 'drastic'],
        plataforma: 'Android',
        sistema: 'Nintendo DS',
        descricao: 'Opções: melonDS (gratuito, muito preciso) e DraStic (pago, bem leve e rápido). Os dois rodam bem em quase todo celular.',
        configuracao: [
          '🔹 melonDS: renderizador OpenGL/Vulkan se disponível, senão Software',
          '🔹 Resolução: 2x–3x nos aparelhos bons, 1x nos fracos',
          '🔹 Frameskip: desligado (ligue só se precisar)',
          '🔹 Layout de telas: escolha conforme o jogo (vertical, lado a lado…)'
        ],
        observacao: 'BIOS é opcional no melonDS (ele tem alternativa interna), mas alguns jogos funcionam melhor com a BIOS original.'
      },

      // ----- DREAMCAST -----
      'flycast': {
        categoria: 'android',
        aliases: ['dreamcast', 'dc', 'naomi'],
        plataforma: 'Android (também PC)',
        sistema: 'Sega Dreamcast (e Naomi / Atomiswave)',
        descricao: 'Emulador de Dreamcast leve e muito compatível. Roda bem até em celular intermediário.',
        precisa: 'Só o jogo — BIOS é opcional',
        configuracao: [
          '🔹 Renderizador: Vulkan (ou OpenGL se der glitch)',
          '🔹 Resolução interna: 1x a 2x',
          '🔹 Renderização em thread separada: LIGADA',
          '🔹 Frameskip: desligado',
          '🔹 Per-pixel sorting: desligado (só ligue se tiver transparência bugada)'
        ]
      },

      // ----- PS VITA -----
      'vita3k': {
        categoria: 'android',
        aliases: ['vita', 'psvita', 'ps vita'],
        plataforma: 'Android (experimental) / PC',
        sistema: 'PlayStation Vita',
        descricao: 'Emulador de PS Vita. No Android ainda é experimental: poucos jogos rodam bem.',
        requisitos: 'Snapdragon topo de linha | Vulkan | 8GB RAM+',
        precisa: 'Firmware + pacote de fontes do PS Vita (do site oficial da Sony)',
        configuracao: [
          '🔹 Renderizador: Vulkan',
          '🔹 Resolução: 1x',
          '🔹 Cache de shader: LIGADO'
        ],
        observacao: 'Se der problema, confira a lista de compatibilidade do projeto antes de insistir no jogo.'
      },

      // ----- RETROARCH -----
      'retroarch': {
        categoria: 'android',
        aliases: ['ps1', 'psx', 'playstation 1', 'n64', 'snes', 'gba', 'mega drive', 'megadrive', 'nes', 'gameboy', 'retro'],
        plataforma: 'Android (e quase tudo)',
        sistema: 'Vários consoles clássicos (PS1, N64, SNES, GBA, Mega Drive…)',
        descricao: 'Programa único que carrega "cores" (emuladores) de vários consoles antigos. Leve e roda em qualquer celular.',
        cores_sugeridos: [
          '🔹 PS1: SwanStation / Beetle PSX HW',
          '🔹 N64: Mupen64Plus-Next',
          '🔹 SNES: Snes9x',
          '🔹 GBA: mGBA',
          '🔹 Mega Drive / Master System: Genesis Plus GX',
          '🔹 NES: Mesen / FCEUmm'
        ],
        configuracao: [
          '🔹 Driver de vídeo: Vulkan (ou GL se der problema)',
          '🔹 Vídeo em thread: LIGADO em celular fraco',
          '🔹 Shaders: desligados em aparelho fraco',
          '🔹 Run-Ahead: desligado (pesa na CPU)'
        ],
        precisa: 'PS1 precisa de BIOS em alguns jogos'
      },

      // ==========================================================
      // 🖥️ EMULADORES DE PC (SECUNDÁRIO)
      // ==========================================================
      'emuladores pc': {
        categoria: 'pc',
        titulo: '🖥️ Emuladores de PC — Visão Geral',
        observacao: 'Secundário aqui: o foco do bot é celular. Mas dá pra consultar.',
        lista: [
          '🔹 Switch → Eden (PC) / Ryubing',
          '🔹 PS2 → PCSX2',
          '🔹 PS3 → RPCS3',
          '🔹 GameCube / Wii → Dolphin (PC)',
          '🔹 Wii U → Cemu',
          '🔹 Xbox 360 → Xenia (Canary)',
          '🔹 Xbox original → xemu',
          '🔹 PS1 → DuckStation',
          '🔹 PSP → PPSSPP (PC)'
        ],
        dica: 'Pergunte pelo nome. Ex: "PCSX2", "RPCS3", "Cemu". Pra configuração geral: "emuladores pc configuração".'
      },
      'emuladores pc configuração': {
        categoria: 'pc',
        titulo: '🖥️ Emuladores de PC — Configuração Geral',
        api_grafica: 'NVIDIA: Vulkan ou Direct3D 12 | AMD: Vulkan | Intel: Direct3D 11/12',
        resolucao: 'Mire em 1080p–1440p: ~3x nativa em PS2/GC/Wii e 2x–3x no Switch. Resolução pesa na GPU, não na CPU.',
        cpu: 'Emulador depende do desempenho POR NÚCLEO. PS3 e Switch pedem CPU forte.',
        shaders: 'Cache de shader + compilação assíncrona LIGADOS (a 1ª vez de cada jogo sempre trava um pouco)',
        memoria: '16GB recomendado | 8GB só pros emuladores leves',
        drivers: 'Mantenha o driver da placa de vídeo atualizado',
        sincronismo: 'VSync ligado + limitador de FPS do emulador em 100%',
        dica: 'Antes de gastar tempo configurando, veja a lista de compatibilidade do emulador pro jogo.'
      },
      'pcsx2': {
        categoria: 'pc',
        aliases: ['ps2', 'playstation 2'],
        titulo: '🖥️ PCSX2 — PS2 no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'PlayStation 2',
        descricao: 'O emulador de PS2 mais completo. Roda a maioria dos jogos em resolução bem maior que a original.',
        requisitos: 'CPU com bom desempenho por núcleo (4 núcleos+) | GPU com Vulkan ou Direct3D 12 | 8GB RAM+',
        precisa: 'BIOS do seu próprio PS2',
        configuracao: [
          '🔹 Renderer: Vulkan (ou Direct3D 12)',
          '🔹 Resolução interna: 3x (≈1080p) — 2x se a GPU for fraca',
          '🔹 Blending Accuracy: Basic — suba só se houver bug visual',
          '🔹 Filtro de textura: Bilinear (PS2)',
          '🔹 MTVU (VU1 multithread): LIGADO',
          '🔹 Patches de widescreen/60 FPS: LIGUE se o jogo tiver'
        ]
      },
      'rpcs3': {
        categoria: 'pc',
        aliases: ['ps3', 'playstation 3'],
        titulo: '🖥️ RPCS3 — PS3 no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'PlayStation 3',
        descricao: 'O único emulador de PS3 realmente funcional. Muito pesado: exige PC potente.',
        requisitos: 'CPU com AVX2 (6+ núcleos de preferência) | GPU com Vulkan | 16GB RAM',
        precisa: 'Firmware oficial do PS3 (site da Sony) + jogos do seu console',
        configuracao: [
          '🔹 Renderer: Vulkan',
          '🔹 PPU / SPU: Recompiler (LLVM)',
          '🔹 Shader mode: Async (evita travadas)',
          '🔹 Resolução: 100% (suba só se sobrar GPU)',
          '🔹 Config personalizada por jogo (cada jogo pede ajustes)'
        ],
        dica: 'Na primeira abertura de cada jogo ele compila muita coisa e demora — é normal.'
      },
      'dolphin pc': {
        categoria: 'pc',
        titulo: '🖥️ Dolphin (PC) — GameCube / Wii',
        plataforma: 'Windows / Linux / macOS',
        configuracao: [
          '🔹 Backend: Vulkan (ou Direct3D 12 no Windows)',
          '🔹 Resolução interna: 3x (1080p)',
          '🔹 Shader Compilation: Hybrid Ubershaders (sem travadinhas)',
          '🔹 Anisotrópico: 16x',
          '🔹 Dual Core: LIGADO | CPU: JIT64 (padrão)',
          '🔹 MSAA/SSAA: só com GPU forte'
        ]
      },
      'cemu': {
        categoria: 'pc',
        aliases: ['wii u', 'wiiu'],
        titulo: '🖥️ Cemu — Wii U no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'Nintendo Wii U',
        descricao: 'O emulador de Wii U. Roda muitos jogos em 60 FPS no PC.',
        precisa: 'Jogos (e chaves necessárias) extraídos do seu Wii U',
        configuracao: [
          '🔹 API gráfica: Vulkan (NVIDIA/AMD) ou OpenGL',
          '🔹 Compilação assíncrona de shader: LIGADA',
          '🔹 Cache de shader: pré-carregar LIGADO',
          '🔹 Graphic packs: resolução, 60 FPS, widescreen',
          '🔹 VSync: ligado'
        ]
      },
      'xenia': {
        categoria: 'pc',
        aliases: ['xbox 360', 'x360'],
        titulo: '🖥️ Xenia (Canary) — Xbox 360 no PC',
        plataforma: 'Windows',
        sistema: 'Xbox 360',
        descricao: 'Emulador de Xbox 360. A versão Canary costuma ter a melhor compatibilidade.',
        requisitos: 'GPU com Direct3D 12 ou Vulkan | CPU com AVX | 8GB RAM+',
        configuracao: [
          '🔹 Backend: Direct3D 12 (padrão no Windows) | Vulkan como alternativa',
          '🔹 Resolução: 1x a 2x (escala maior é experimental)',
          '🔹 Patches de jogo (60 FPS, correções): use a pasta de patches do Xenia',
          '🔹 Configuração por jogo pelo arquivo .toml'
        ],
        observacao: 'Compatibilidade varia muito por jogo: confira a lista antes.'
      },
      'xemu': {
        categoria: 'pc',
        aliases: ['xbox', 'xbox original'],
        titulo: '🖥️ xemu — Xbox Original no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'Xbox (original)',
        descricao: 'Emulador do Xbox original.',
        precisa: 'BIOS, MCPX e imagem de HDD extraídos do seu próprio Xbox',
        configuracao: [
          '🔹 Escala de resolução: 2x a 3x',
          '🔹 Renderizador: OpenGL (ou Vulkan nas versões mais novas)',
          '🔹 Memória do sistema: 128MB se o jogo pedir'
        ]
      },
      'duckstation pc': {
        categoria: 'pc',
        aliases: ['ps1', 'psx', 'playstation 1'],
        titulo: '🖥️ DuckStation — PS1 no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'PlayStation 1',
        precisa: 'BIOS do seu próprio PS1',
        configuracao: [
          '🔹 Renderer: Vulkan (ou Direct3D 12)',
          '🔹 Resolução: 3x a 5x',
          '🔹 PGXP geometria: LIGADO (corrige tremedeira de polígonos)',
          '🔹 Correção de textura PGXP: LIGADO',
          '🔹 Renderização multithread: LIGADA'
        ]
      },
      'eden pc': {
        categoria: 'pc',
        titulo: '🖥️ Eden (PC) — Switch',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'Nintendo Switch',
        precisa: 'prod.keys + firmware do seu Switch',
        configuracao: [
          '🔹 API gráfica: Vulkan (padrão) — OpenGL existe no PC, mas não rende igual',
          '🔹 Resolução: 2x (1080p) com GPU forte | 1x se for fraca',
          '🔹 Precisão da GPU: Normal',
          '🔹 Cache de shader + compilação assíncrona: LIGADOS',
          '🔹 Anisotrópico: Auto ou 16x'
        ]
      },
      'ryubing': {
        categoria: 'pc',
        aliases: ['ryujinx'],
        titulo: '🖥️ Ryubing — Switch no PC',
        plataforma: 'Windows / Linux / macOS',
        sistema: 'Nintendo Switch',
        descricao: 'Continuação mantida pela comunidade do Ryujinx (que foi descontinuado em 2024).',
        precisa: 'prod.keys + firmware do seu Switch',
        configuracao: [
          '🔹 API gráfica: Vulkan',
          '🔹 Resolução: 1x a 2x',
          '🔹 PPTC (cache de tradução da CPU): LIGADO',
          '🔹 Cache de shader: LIGADO'
        ]
      },
      'ppsspp pc': {
        categoria: 'pc',
        titulo: '🖥️ PPSSPP (PC) — PSP',
        plataforma: 'Windows / Linux / macOS',
        configuracao: [
          '🔹 Backend: Vulkan (ou Direct3D 11)',
          '🔹 Resolução de renderização: 4x (≈1080p)',
          '🔹 Anisotrópico: 16x',
          '🔹 Texture scaling: opcional (xBRZ/hybrid) em jogos de textura simples',
          '🔹 Patches de 60 FPS: existem pra alguns jogos'
        ]
      },
    }

    this.aliases.clear()
    for (const [chave, valor] of Object.entries(base)) {
      this.dados.set(chave.toLowerCase(), valor)
      if (valor.aliases) {
        const raiz = normalizar(chave).split(' ')[0]
        const atuais = this.aliases.get(raiz) || []
        this.aliases.set(raiz, atuais.concat(valor.aliases.map(normalizar)))
      }
    }
    console.log(`🎮 Base completa carregada: ${this.dados.size} verbetes!`)
  },

  salvar() {
    try {
      fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.dados), null, 2))
      return true
    } catch { return false }
  },

  buscar(consulta, limite = 5) {
    const norm = normalizar(consulta).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    let termos = norm.split(' ').filter(t => t.length > 1)
    const uteis = termos.filter(t => !STOPWORDS.has(t) && !TERMOS_GENERICOS.has(t))
    if (uteis.length > 0) termos = uteis

    // Pergunta sobre emulador de PC? ("pcsx2", "emuladores pc"...) — mas "jogo de PC no celular" NÃO conta
    const falaDeCelular = termos.some(t => TERMOS_MOBILE.has(t))
    const querPC = termos.some(t => TERMOS_PC_FORTES.has(t)) || (termos.includes('pc') && !falaDeCelular)

    const resultados = []
    for (const [chave, item] of this.dados) {
      const chaveN = normalizar(chave)
      const textoCompleto = `${chaveN} ${normalizar(JSON.stringify(item))}`
      let relevancia = 0

      for (const termo of termos) {
        if (chaveN.includes(termo)) relevancia += 10
        if (textoCompleto.includes(termo)) relevancia += 2
      }

      const aliases = this.aliases.get(chaveN.split(' ')[0]) || []
      for (const alias of aliases) {
        if ((' ' + norm + ' ').includes(' ' + alias + ' ')) { relevancia += 12 * alias.split(' ').length; break }
      }

      if (relevancia > 0) resultados.push({ chave, item, relevancia, bruta: relevancia })
    }

    // Emuladores de PC são secundários: só passam na frente quando a pessoa pergunta por eles
    // (ou quando não existe nada de celular que combine de verdade, ex: Xbox 360)
    const melhorMobile = Math.max(0, ...resultados.filter(r => r.item.categoria !== 'pc').map(r => r.bruta))
    for (const r of resultados) {
      if (r.item.categoria !== 'pc') continue
      if (querPC) r.relevancia = r.bruta + 15
      else if (melhorMobile >= 10 && r.bruta < melhorMobile * 1.5) r.relevancia = Math.ceil(r.bruta * 0.4)
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, limite)
  },

  adicionar(pergunta, resposta) {
    this.dados.set(pergunta.toLowerCase().trim(), {
      custom: true,
      resposta,
      data: new Date().toLocaleString('pt-BR')
    })
    this.salvar()
  },

  contar() { return this.dados.size }
}

// ==========================================
// 🧠 RESPOSTAS NORMAIS
// ==========================================
const RespostasNormais = {
  respostas: new Map(),

  init() {
    const respostasPadrao = {
      'oi': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre Winlator, GameHub, Eden, PPSSPP, Dolphin, DXVK, drivers, ou qualquer emulador! 😊',
      'olá': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre Winlator, GameHub, DXVK, drivers, ou qualquer emulador! 😊',
      'bom dia': '🌅 Bom dia! Como posso ajudar com emuladores hoje? Precisa de ajuda com Winlator ou GameHub? 😊',
      'boa tarde': '☀️ Boa tarde! Precisa de ajuda com Winlator, GameHub, DXVK, configurações de drivers? Estou aqui! 🎮',
      'boa noite': '🌙 Boa noite! Bora jogar no celular? Precisa de ajuda com Winlator ou GameHub? 🎮',
      'quem é você': 'Sou o EmuladorHelper! 🎮 Ajudo com tudo sobre emuladores — incluindo Winlator e GameHub para rodar jogos de PC no celular! Pergunte sobre configurações de DXVK, drivers, Box64 e muito mais!',
      'obrigado': 'De nada! 😊 Qualquer dúvida com Winlator, GameHub, DXVK ou drivers, é só chamar! Bora jogar! 🎮',
      'obrigada': 'De nada! 😊 Qualquer dúvida com Winlator, GameHub, DXVK ou drivers, é só chamar! Bora jogar! 🎮',
      'vlw': 'De nada! Bora jogar no celular! 🎮',
      'o que é winlator': '🎮 *Winlator* é um emulador que roda jogos e programas de Windows no Android! Usa Box64 + Wine para traduzir os comandos do PC para o celular. Funciona bem em celulares intermediários ou melhores. Quer saber mais sobre configuração? 😊',
      'o que é gamehub': '🎮 *GameHub* é um emulador de Windows para Android, feito pela mesma equipe do Winlator. Mais moderno, usa Proton + FEX e tem interface mais amigável. Ótimo para iniciantes! Quer saber as configurações ideais? 😊',
      'diferença winlator gamehub': '🎮 *Winlator* = mais leve, mais opções avançadas\n🎮 *GameHub* = mais fácil de usar, usa Proton nativo\n\nPergunte "Winlator vs GameHub" para detalhes completos! 😊'
    }
    for (const [k, v] of Object.entries(respostasPadrao)) {
      this.respostas.set(k, v)
    }
  },

  buscar(texto) {
    const t = normalizar(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    const palavras = t ? t.split(' ').length : 0
    for (const [chave, resp] of this.respostas) {
      const k = normalizar(chave)
      const frase = k.split(' ').length >= 3
      // Frases específicas ("o que é winlator") valem em qualquer lugar; saudações só em mensagens curtas
      if (frase ? t.includes(k) : (palavras <= 3 && new RegExp(`\\b${k}\\b`).test(t))) return resp
    }
    return null
  }
}

const ROTULOS = {
  plataforma: '💻 Plataforma', sistema: '🎮 Sistema', descricao: '📝 Sobre', requisitos: '⚙️ Requisitos',
  precisa: '🔑 Precisa de', resolucao: '🖥️ Resolução', o_que_e: 'ℹ️ O que é', versoes: '📦 Versões',
  versoes_recomendadas: '📦 Versões recomendadas', modos: '🔧 Modos', perfis: '🔧 Perfis',
  snapdragon: '📱 Snapdragon', snapdragon_adreno: '📱 Snapdragon/Adreno',
  mediatek_exynos_mali: '📱 MediaTek/Exynos/Mali', mediatek_exynos: '📱 MediaTek/Exynos', mali: '📱 Mali',
  dicas: '💡 Dicas', dica: '💡 Dica', dica_ouro: '💡 Dica de ouro', lista: '📋 Lista',
  vantagens: '✅ Vantagens', desvantagem: '⚠️ Desvantagem', memoria: '🧠 Memória', wow64: '🔧 WOW64',
  msync_esync: '🔧 MSync/ESync', audio: '🔊 Áudio', driver_grafico: '🎮 Driver', dxvk: '🔷 DXVK',
  vkd3d: '🔷 VKD3D', compatibilidade: '🔧 Compatibilidade', cpu_translator: '📦 Tradutor CPU',
  cpu: '🧮 CPU', async: '⚡ Async', observacao: '📌 Obs', fallback: '↩️ Alternativa',
  tela_preta: '🖤 Tela preta', jogo_não_abre: '❌ Jogo não abre', lento: '🐌 Lento', sem_som: '🔇 Sem som',
  glitches: '🧩 Glitches', travadinhas: '⏱️ Travadinhas', texturas_quebradas: '🧱 Texturas quebradas',
  graficos_bugados: '🧩 Gráficos bugados', configuracao: '⚙️ Configuração', cores_sugeridos: '🧩 Cores sugeridos',
  api_grafica: '🎮 API gráfica', backend: '🎮 Backend', renderizador: '🎮 Renderizador',
  modo_docked: '📺 Modo Docked', precisao_gpu: '🎯 Precisão da GPU', shaders: '✨ Shaders', astc: '🗜️ ASTC',
  filtros: '🔍 Filtros', hacks_velocidade: '🚀 Hacks de velocidade', renderizacao: '🖼️ Renderização',
  frameskip: '⏭️ Frameskip', roda_bem: '✅ Roda bem', limitado: '⚠️ Limitado',
  vulkan_vs_opengl: '🔀 Vulkan x OpenGL', mtvu: '🧵 MTVU', ee_cycle_rate: '⏱️ EE Cycle Rate',
  qualidade: '🎨 Qualidade', extras: '➕ Extras', drivers: '🎮 Drivers', sincronismo: '🔄 Sincronismo',
  turnip: '🟦 Turnip', vortek: '🟪 Vortek', virgl: '🟩 VirGL', winlator: '🪟 Winlator', gamehub: '🎮 GameHub',
  wine_vs_proton: '🍷 Wine x Proton', extras_pc: '🖥️ PC'
}
const IGNORAR = new Set(['titulo', 'custom', 'resposta', 'data', 'categoria', 'aliases', 'site', 'conclusao'])

function textoDe(valor) {
  if (Array.isArray(valor)) return valor.join('\n')
  if (valor && typeof valor === 'object') {
    return Object.entries(valor)
      .map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join('; ') : v}`)
      .join('\n')
  }
  return String(valor)
}

function rotuloDe(chave, valor) {
  // "sistema" pode ser o nome do console (texto) ou o driver de sistema (objeto)
  if (chave === 'sistema' && valor && typeof valor === 'object') return '⬜ Driver do Sistema'
  if (ROTULOS[chave]) return ROTULOS[chave]
  const nome = chave.replace(/_/g, ' ')
  return '🔸 ' + nome.charAt(0).toUpperCase() + nome.slice(1)
}

function formatarResposta(item, termo = '') {
  if (typeof item === 'string') return item
  if (item.custom) return item.resposta

  const blocos = []
  if (item.titulo) blocos.push(`📌 *${item.titulo}*\n`)
  if (item.categoria === 'pc') blocos.push('🖥️ _Emulador de PC (secundário)_\n')

  for (const [chave, valor] of Object.entries(item)) {
    if (IGNORAR.has(chave) || valor === undefined || valor === null || valor === '') continue
    const texto = textoDe(valor)
    const rotulo = rotuloDe(chave, valor)
    if (texto.includes('\n')) blocos.push(`${rotulo}:\n${texto}\n`)
    else blocos.push(`${rotulo}: ${texto}`)
  }

  if (item.conclusao) blocos.push(`\n✅ ${item.conclusao}`)
  if (item.site) blocos.push(`🌐 Site oficial: ${item.site}`)

  return blocos.join('\n').trim() || JSON.stringify(item, null, 2).slice(0, 600)
}

async function processarPergunta(texto) {
  const respostaNormal = RespostasNormais.buscar(texto)
  if (respostaNormal) return respostaNormal

  const resultados = EmuladorBase.buscar(texto, 3)
  if (resultados.length > 0) {
    const [primeiro, segundo] = resultados
    // Um resultado claramente melhor que os outros? Responde direto.
    if (!segundo || primeiro.relevancia >= segundo.relevancia * 1.5) {
      return formatarResposta(primeiro.item, texto)
    }
    // Todos do mesmo emulador (ex: "eden", "eden configuração", "eden driver")? Responde o melhor e avisa dos outros.
    const raiz = (c) => c.split(' ')[0]
    if (resultados.every(r => raiz(r.chave) === raiz(primeiro.chave))) {
      const outros = resultados.slice(1).map(r => `• ${r.chave}`).join('\n')
      return `${formatarResposta(primeiro.item, texto)}\n\n💡 Também tenho:\n${outros}`
    }
    let msg = `🔍 Encontrei ${resultados.length} resultados:\n\n`
    resultados.forEach((r, i) => {
      msg += `${i+1}. *${r.chave}*${r.item.categoria === 'pc' ? ' 🖥️ (PC)' : ''}\n`
    })
    msg += '\nDigite o nome completo para detalhes! 😊'
    return msg
  }

  return `🤔 Ainda não tenho informação exata sobre isso, mas posso ajudar com:\n\n📱 *Emuladores de celular:* Eden (Switch), PPSSPP (PSP), Dolphin (GC/Wii), NetherSX2 (PS2), Azahar (3DS), Flycast, RetroArch\n🪟 *PC no Celular:* Winlator, GameHub\n🔷 *DXVK / Wine / Proton / Box64*\n🎮 *Drivers:* Turnip, VirGL, Vortek, Mali\n🖥️ *Emuladores de PC* (secundário): PCSX2, RPCS3, Cemu...\n\n📌 Pergunte de forma simples, por exemplo:\n"Eden configuração"\n"PPSSPP configuração"\n"Dolphin no Mali"\n"Configuração Winlator Snapdragon"\n"Emuladores PC"\n\nOu me ensine com: !corrige sua pergunta = resposta 😊`
}

// ==========================================
// 🌐 SERVIDOR HTTP
// ==========================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ 
      status: 'online', 
      base: EmuladorBase.contar(),
      versao: '4.0-multi-emuladores'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('🎮 EmuladorHelper v4.0 — Emuladores Android + Winlator + GameHub Online!')
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP
// ==========================================
const TRIGGER = (process.env.TRIGGER || '!').toLowerCase()
const PHONE_NUMBER = process.env.PHONE_NUMBER || ''
let codigoGerado = false

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

async function iniciarBot() {
  EmuladorBase.carregar()
  RespostasNormais.init()
  console.log(`🎮 EmuladorHelper v4.0 iniciado — ${EmuladorBase.contar()} verbetes`)

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('✅ CONECTADO COM SUCESSO! 🎮')
      codigoGerado = false
    }

    if (connection === 'close') {
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — código: ${codigoErro}`)
      
      if (codigoErro === DisconnectReason.loggedOut || codigoErro === DisconnectReason.badSession) {
        console.log('🔑 Sessão encerrada — reiniciando...')
        codigoGerado = false
        setTimeout(iniciarBot, 5000)
        return
      }
      if (codigoErro !== DisconnectReason.connectionReplaced) {
        setTimeout(iniciarBot, 5000)
      }
    }

    if (connection === 'connecting' && !sock.authState.creds.registered && !codigoGerado) {
      if (!PHONE_NUMBER) {
        console.error('❌ Configure PHONE_NUMBER no Render! Ex: 5511999999999')
        return
      }
      const telefone = apenasDigitos(PHONE_NUMBER)
      if (telefone.length < 10) {
        console.error(`❌ Número inválido: ${PHONE_NUMBER}`)
        return
      }
      codigoGerado = true
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(telefone)
          console.log('\n' + '═'.repeat(55))
          console.log('📲 CÓDIGO DE PAREAMENTO: ' + codigo)
          console.log('👉 Abra WhatsApp → Configurações → Aparelhos Conectados')
          console.log('👉 Conectar com número de telefone → digite o código')
          console.log('═'.repeat(55) + '\n')
        } catch (err) {
          codigoGerado = false
          console.error(`❌ Erro: ${err.message}`)
        }
      }, 3000)
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const textoLimpo = texto.trim()
    const responder = (resposta) => sock.sendMessage(msg.key.remoteJid, { text: resposta }, { quoted: msg })

    if (textoLimpo.startsWith(TRIGGER)) {
      const cmd = textoLimpo.slice(TRIGGER.length).trim().toLowerCase()
      const [acao, ...resto] = cmd.split(/\s+/)
      const args = resto.join(' ')

      switch (acao) {
        case 'ajuda':
        case 'comandos':
          await responder(`📋 *Comandos:*

!ajuda — Mostra isto
!ping — Verifica se estou online
!lista — Lista os tópicos (use !lista 2 ou !lista pc)
!busca [termo] — Pesquisa
!corrige pergunta = resposta — Me ensina

💡 Sem comando: é só perguntar normalmente! 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Estou online e pronto! 🎮')
          break

        case 'lista': {
          const querPC = args.trim() === 'pc'
          const pagina = Math.max(1, parseInt(args) || 1)
          const porPagina = 20
          const todas = [...EmuladorBase.dados.entries()]
          const chaves = todas
            .filter(([, v]) => (v.categoria === 'pc') === querPC)
            .map(([k]) => k)
          const totalPaginas = Math.max(1, Math.ceil(chaves.length / porPagina))
          const itens = chaves.slice((pagina - 1) * porPagina, pagina * porPagina)
          const titulo = querPC ? '🖥️ *Emuladores de PC (secundário)*' : '📚 *Base de Conhecimento (celular)*'
          await responder(`${titulo}: ${chaves.length} itens — página ${Math.min(pagina, totalPaginas)}/${totalPaginas}\n\n${itens.map((k, i) => `${(pagina - 1) * porPagina + i + 1}. ${k}`).join('\n')}\n\n💡 !lista 2 → próxima página | !lista pc → emuladores de PC`)
          break
        }

        case 'busca':
          if (!args) {
            await responder('🔍 Use: !busca winlator')
            break
          }
          const res = EmuladorBase.buscar(args, 3)
          if (res.length === 0) {
            await responder(`🔍 Nada encontrado para: "${args}"`)
          } else {
            await responder(formatarResposta(res[0].item, args))
          }
          break

        case 'corrige':
          if (!args.includes('=')) {
            await responder('📝 Use: !corrige sua pergunta = resposta correta')
            break
          }
          const [perg, resp] = args.split('=').map(s => s.trim())
          if (!perg || !resp) {
            await responder('⚠️ Falta pergunta ou resposta!')
            break
          }
          EmuladorBase.adicionar(perg, resp)
          await responder(`✅ *SALVO! 🧠*\n\n📌 ${perg}\n✅ ${resp}`)
          break

        default:
          await responder('🤔 Comando não reconhecido. Use !ajuda')
      }
      return
    }

    console.log(`💬 Pergunta: ${texto}`)
    await sock.readMessages([msg.key])
    
    const resposta = await processarPergunta(texto)
    await responder(resposta)
  })
}

iniciarBot().catch(err => console.error('❌ Erro:', err))
