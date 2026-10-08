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
const EmuladorBase = {
  dados: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),

  carregar() {
    try {
      if (fs.existsSync(this.arquivo)) {
        const dados = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        for (const [chave, valor] of Object.entries(dados)) this.dados.set(chave.toLowerCase(), valor)
        console.log(`🎮 Base carregada: ${this.dados.size} verbetes`)
      } else {
        this.inicializarBaseCompleta()
        this.salvar()
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao carregar base: ${err.message}`)
      this.inicializarBaseCompleta()
    }
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
      }
    }

    for (const [chave, valor] of Object.entries(base)) {
      this.dados.set(chave.toLowerCase(), valor)
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
    const resultados = []
    const termos = consulta.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
    
    for (const [chave, item] of this.dados) {
      let relevancia = 0
      const textoCompleto = `${chave} ${JSON.stringify(item).toLowerCase()}`
      
      for (const termo of termos) {
        if (chave.includes(termo)) relevancia += 10
        if (textoCompleto.includes(termo)) relevancia += 2
      }
      
      if (relevancia > 0) {
        resultados.push({ chave, item, relevancia })
      }
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
      'oi': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre Winlator, GameHub, DXVK, drivers, ou qualquer emulador! 😊',
      'olá': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre Winlator, GameHub, DXVK, drivers, ou qualquer emulador! 😊',
      'bom dia': '🌅 Bom dia! Como posso ajudar com emuladores hoje? Precisa de ajuda com Winlator ou GameHub? 😊',
      'boa tarde': '☀️ Boa tarde! Precisa de ajuda com Winlator, GameHub, DXVK, configurações de drivers? Estou aqui! 🎮',
      'boa noite': '🌙 Boa noite! Bora jogar no celular? Precisa de ajuda com Winlator ou GameHub? 🎮',
      'quem é você': 'Sou o EmuladorHelper! 🎮 Ajudo com tudo sobre emuladores — incluindo Winlator e GameHub para rodar jogos de PC no celular! Pergunte sobre configurações de DXVK, drivers, Box64 e muito mais!',
      'obrigado': 'De nada! 😊 Qualquer dúvida com Winlator, GameHub, DXVK ou drivers, é só chamar! Bora jogar! 🎮',
      'obrigada': 'De nada! 😊 Qualquer dúvida com Winlator, GameHub, DXVK ou drivers, é só chamar! Bora jogar! 🎮',
      'vlw': 'De nada! Bora jogar no celular! 🎮',
      'o que é winlator': '🎮 **Winlator** é um emulador que roda jogos e programas de Windows no Android! Usa Box64 + Wine para traduzir os comandos do PC para o celular. Funciona bem em celulares intermediários ou melhores. Quer saber mais sobre configuração? 😊',
      'o que é gamehub': '🎮 **GameHub** é um emulador de Windows para Android, feito pela mesma equipe do Winlator. Mais moderno, usa Proton + FEX e tem interface mais amigável. Ótimo para iniciantes! Quer saber as configurações ideais? 😊',
      'diferença winlator gamehub': '🎮 **Winlator** = mais leve, mais opções avançadas\n🎮 **GameHub** = mais fácil de usar, usa Proton nativo\n\nPergunte "Winlator vs GameHub" para detalhes completos! 😊'
    }
    for (const [k, v] of Object.entries(respostasPadrao)) {
      this.respostas.set(k, v)
    }
  },

  buscar(texto) {
    const t = texto.toLowerCase().trim()
    for (const [chave, resp] of this.respostas) {
      if (t.includes(chave) || chave.includes(t)) {
        return resp
      }
    }
    return null
  }
}

function formatarResposta(item, termo = '') {
  if (typeof item === 'string') return item
  if (item.custom) return item.resposta

  let msg = ''
  if (item.titulo) msg += `📌 **${item.titulo}**\n\n`
  if (item.plataforma) msg += `💻 Plataforma: ${item.plataforma}\n`
  if (item.sistema) msg += `🎮 Sistema: ${item.sistema}\n`
  if (item.descricao) msg += `📝 ${item.descricao}\n`
  if (item.requisitos) msg += `⚙️ Requisitos: ${item.requisitos}\n`
  if (item.resolucao) msg += `🖥️ Resolução:\n${item.resolucao}\n`
  if (item.o_que_e) msg += `ℹ️ ${item.o_que_e}\n`
  if (item.versaoes) msg += `📦 Versões:\n${Object.entries(item.versaoes).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`
  if (item.versoes) msg += `📦 Versões:\n${item.versoes.join('\n')}\n`
  if (item.modos) msg += `🔧 Modos:\n${Object.entries(item.modos).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`
  if (item.snapdragon) msg += `📱 Snapdragon: ${item.snapdragon}\n`
  if (item.snapdragon_adreno) msg += `📱 Snapdragon/Adreno: ${item.snapdragon_adreno}\n`
  if (item.mediatek_exynos_mali) msg += `📱 MediaTek/Exynos/Mali: ${item.mediatek_exynos_mali}\n`
  if (item.mediatek_exynos) msg += `📱 MediaTek/Exynos: ${item.mediatek_exynos}\n`
  if (item.dicas) msg += `💡 Dicas:\n${item.dicas.join('\n')}\n`
  if (item.dica) msg += `💡 ${item.dica}\n`
  if (item.dica_ouro) msg += `💡 ${item.dica_ouro}\n`
  if (item.lista) msg += `${item.lista.join('\n')}\n`
  if (item.vantagens) msg += `✅ Vantagens:\n${item.vantagens.join('\n')}\n`
  if (item.conclusao) msg += `\n✅ ${item.conclusao}\n`
  if (item.tela_preta) msg += `🖤 Tela preta:\n${item.tela_preta.join('\n')}\n\n`
  if (item.jogo_não_abre) msg += `❌ Jogo não abre:\n${item.jogo_não_abre.join('\n')}\n\n`
  if (item.lento) msg += `🐌 Lento:\n${item.lento.join('\n')}\n\n`
  if (item.sem_som) msg += `🔇 Sem som:\n${item.sem_som.join('\n')}\n`
  if (item.memoria) msg += `🧠 Memória: ${item.memoria}\n`
  if (item.wow64) msg += `🔧 WOW64: ${item.wow64}\n`
  if (item.msync_esync) msg += `🔧 MSync/ESync: ${item.msync_esync}\n`
  if (item.audio) msg += `🔊 Áudio: ${item.audio}\n`
  if (item.driver_grafico) msg += `🎮 Driver: ${item.driver_grafico}\n`
  if (item.dxvk) msg += `🔷 DXVK: ${item.dxvk}\n`
  if (item.vkd3d) msg += `🔷 VKD3D: ${item.vkd3d}\n`
  if (item.compatibilidade) msg += `🔧 Compatibilidade: ${item.compatibilidade}\n`
  if (item.cpu_translator) msg += `📦 Tradutor CPU: ${item.cpu_translator}\n`
  if (item.async) msg += `⚡ Async: ${item.async}\n`
  if (item.site) msg += `🌐 Site oficial: ${item.site}\n`
  if (item.Turnip) msg += `🟦 Turnip:\n${Object.entries(item.Turnip).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`
  if (item.Vortek) msg += `🟪 Vortek:\n${Object.entries(item.Vortek).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`
  if (item.VirGL) msg += `🟩 VirGL:\n${Object.entries(item.VirGL).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`
  if (item.Sistema) msg += `⬜ Sistema:\n${Object.entries(item.Sistema).map(([k,v])=>`• ${k}: ${v}`).join('\n')}\n`

  return msg.trim() || JSON.stringify(item, null, 2).slice(0, 600)
}

async function processarPergunta(texto) {
  const respostaNormal = RespostasNormais.buscar(texto)
  if (respostaNormal) return respostaNormal

  const resultados = EmuladorBase.buscar(texto, 3)
  if (resultados.length > 0) {
    if (resultados.length === 1) {
      return formatarResposta(resultados[0].item, texto)
    }
    let msg = `🔍 Encontrei ${resultados.length} resultados:\n\n`
    resultados.forEach((r, i) => {
      msg += `${i+1}. **${r.chave}**\n`
    })
    msg += '\nDigite o nome completo para detalhes! 😊'
    return msg
  }

  return `🤔 Ainda não tenho informação exata sobre isso, mas posso ajudar com:\n\n🪟 **PC no Celular:** Winlator, GameHub\n🔷 **DXVK:** Versões, configuração, problemas\n🍷 **Wine/Proton:** Versões e compatibilidade\n📦 **Box64:** Modos de performance\n🎮 **Drivers:** Turnip, VirGL, Vortek\n\n📌 Pergunte de forma simples, por exemplo:\n"Configuração Winlator Snapdragon"\n"Melhor DXVK para jogos antigos"\n"Driver para MediaTek no GameHub"\n"Box64 modo rápido ou estável"\n\nOu me ensine com: !corrige sua pergunta = resposta 😊`
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
      versao: '3.0-winlator-gamehub'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('🎮 EmuladorHelper v3.0 — Winlator + GameHub Online!')
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
  console.log(`🎮 EmuladorHelper v3.0 iniciado — ${EmuladorBase.contar()} verbetes`)

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
          await responder(`📋 **Comandos:**

!ajuda — Mostra isto
!ping — Verifica se estou online
!lista — Lista todos os tópicos
!busca [termo] — Pesquisa
!corrige pergunta = resposta — Me ensina

💡 Sem comando: é só perguntar normalmente! 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Estou online e pronto! 🎮')
          break

        case 'lista':
          const itens = [...EmuladorBase.dados.keys()].slice(0, 25)
          await responder(`📚 **Base de Conhecimento:** ${EmuladorBase.contar()} itens\n\n${itens.map((k, i) => `${i+1}. ${k}`).join('\n')}`)
          break

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
          await responder(`✅ **SALVO! 🧠**\n\n📌 ${perg}\n✅ ${resp}`)
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
