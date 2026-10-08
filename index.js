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
// 🎮 BASE DE CONHECIMENTO AMPLIADA
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
      // ===== PC =====
      'pcsx2': {
        plataforma: 'PC',
        sistema: 'PlayStation 2',
        melhorPara: 'PC',
        descricao: 'O melhor emulador de PS2 para PC. Roda quase todos os jogos em alta resolução.',
        requisitos: 'Mínimo: Core i3 / Ryzen 3 + GPU básica | Recomendado: i5/Ryzen 5 + GTX 1050',
        resolucao: '1x(720p) até 6x(4K)',
        dicas: 'Ative MTVU e EE Cyclerate para mais velocidade. Use Direct3D 11 ou Vulkan.'
      },
      'dolphin': {
        plataforma: 'PC / Android',
        sistema: 'GameCube / Wii',
        melhorPara: 'PC e Celular',
        descricao: 'Excelente compatibilidade e gráficos. Roda em PC e celular.',
        requisitos: 'PC: i5-4670K+ | Android: Snapdragon 845+',
        resolucao: '1x até 5x',
        dicas: 'Vulkan é mais rápido no Android. D3D11 no PC. Ative "Fast Memory".'
      },
      'yuzu': {
        plataforma: 'PC',
        sistema: 'Nintendo Switch',
        melhorPara: 'PC',
        descricao: 'Emulador de Switch para PC. Bom para jogos mais novos.',
        requisitos: 'Ryzen 5 ou i5+ | 8GB RAM | GPU com Vulkan',
        backend: 'Vulkan (recomendado)',
        dicas: 'Ative Multicore e Fast Memory. Use resolução 1x se lento.'
      },
      'ryujinx': {
        plataforma: 'PC',
        sistema: 'Nintendo Switch',
        melhorPara: 'PC',
        descricao: 'Foco em precisão e compatibilidade. Mais estável para muitos jogos.',
        requisitos: 'Ryzen 5 ou i5+ | 8GB RAM',
        backend: 'Vulkan',
        dicas: 'Boa precisão de áudio e controles. Mais compatível com atualizações de jogos.'
      },
      'duckstation': {
        plataforma: 'PC / Android',
        sistema: 'PlayStation 1',
        melhorPara: 'PC e Celular',
        descricao: 'O melhor emulador de PS1. Roda muito bem até em celulares mais fracos.',
        requisitos: 'PC: Dual Core | Celular: Qualquer celular moderno',
        resolucao: '1x até 8x',
        dicas: 'Auto-frameskip para jogos rápidos. Hacks de renderização melhoram performance.'
      },
      'retroarch': {
        plataforma: 'PC / Android / Multi',
        sistema: 'TODOS (PS1, SNES, GBA, NES, Mega Drive, etc)',
        melhorPara: 'PC e Celular',
        descricao: 'Pacote completo com vários núcleos em um só app. Muito personalizável.',
        requisitos: 'Varia conforme o núcleo. PS1/SNES roda em qualquer celular.',
        dicas: 'Baixe os "Cores" dentro do app. Use o núcleo PCSX-ReARMed para PS1 no celular.'
      },

      // ===== PSP =====
      'ppsspp': {
        plataforma: 'PC / Android / iOS',
        sistema: 'PSP',
        melhorPara: 'PC e Celular — Excelente nos dois!',
        descricao: 'O melhor emulador de PSP. Muito leve e com ótima compatibilidade.',
        requisitos: 'PC: Dual Core | Celular: Snapdragon 660+ roda perfeito',
        resolucao: '1x até 5x+',
        dicas: 'Ative "Frameskip" se lento. Use "Buffered Rendering". Salve estados com frequência.',
        celular: 'Roda muito bem em celulares intermediários. Um dos mais leves!'
      },

      // ===== CELULAR / ANDROID =====
      'aether sx2': {
        plataforma: 'Android',
        sistema: 'PlayStation 2',
        melhorPara: 'Celular Android',
        descricao: 'O primeiro e melhor emulador de PS2 para celular.',
        requisitos: 'Mínimo: Snapdragon 845 / Exynos 9810+ | Recomendado: Snapdragon 8 Gen 1+',
        dicas: 'Use resolução 1x se lento. Ative "Frame Skip". Jogos mais pesados precisam de celular top de linha.',
        observacao: 'Ainda em desenvolvimento — alguns jogos não funcionam bem.'
      },
      'nether sx2': {
        plataforma: 'Android',
        sistema: 'PlayStation 2',
        melhorPara: 'Celular Android',
        descricao: 'Versão melhorada do AetherSX2 com atualizações da comunidade.',
        requisitos: 'Mesmo que AetherSX2 — Snapdragon 845+',
        dicas: 'Melhorias de compatibilidade. Use a configuração recomendada para seu celular.'
      },
      'skyline': {
        plataforma: 'Android',
        sistema: 'Nintendo Switch',
        melhorPara: 'Celular Android top de linha',
        descricao: 'Emulador de Switch para Android. Em desenvolvimento.',
        requisitos: 'Snapdragon 8 Gen 1+ ou Dimensity 9000+ | 8GB RAM mínimo',
        dicas: 'Ainda em fase inicial — poucos jogos funcionam bem. Exige celular muito potente.',
        observacao: 'Não está disponível para todos os celulares ainda.'
      },
      'strato': {
        plataforma: 'Android',
        sistema: 'Nintendo Switch',
        melhorPara: 'Celular Android top de linha',
        descricao: 'Sucessor do Skyline — código aberto e em desenvolvimento ativo.',
        requisitos: 'Snapdragon 8 Gen 2+ recomendado',
        dicas: 'Projeto promissor. Sempre baixe a versão mais recente.',
        observacao: 'Exige celular muito potente.'
      },
      'mupen64plus': {
        plataforma: 'Android / PC',
        sistema: 'Nintendo 64',
        melhorPara: 'Celular e PC',
        descricao: 'Melhor emulador de N64. Roda bem em qualquer celular moderno.',
        dicas: 'Use com RetroArch para melhor experiência. Gráficos melhorados disponíveis.'
      },
      'snes9x': {
        plataforma: 'Android / PC',
        sistema: 'Super Nintendo',
        melhorPara: 'Qualquer celular',
        descricao: 'Emulador leve e compatível de SNES. Roda até em celular antigo.',
        requisitos: 'Quase nenhum requisito',
        dicas: 'Controles de tela funcionam bem. Salve a partida a qualquer momento.'
      },
      'mgba': {
        plataforma: 'Android / PC',
        sistema: 'Game Boy / GBA',
        melhorPara: 'Qualquer celular',
        descricao: 'Preciso e leve. Melhor para GBA e Game Boy Color.',
        dicas: 'Suporta códigos de trapaça. Salve estados. Roda em qualquer celular.'
      },
      'ppsspp celular': {
        plataforma: 'Android / iOS',
        sistema: 'PSP',
        descricao: 'Excelente no celular! Um dos mais bem otimizados.',
        requisitos: 'Celular intermediário já roda bem',
        dicas: '🔹 Resolução 2x = mais nítido\n🔹 Ative frameskip se lento\n🔹 Desative sombras para velocidade\n🔹 Salve com frequência',
        performance: 'Celular básico: 1x | Intermediário: 2x | Top de linha: 3x-4x'
      },

      // ===== DICAS GERAIS =====
      'melhores emuladores celular': {
        titulo: '🏆 Melhores Emuladores para Celular',
        lista: [
          '📱 PS1: DuckStation — Roda em qualquer celular',
          '📱 PS2: AetherSX2 / NetherSX2 — Exige celular mais potente',
          '📱 PSP: PPSSPP — Excelente e leve',
          '📱 Switch: Strato / Skyline — Apenas celulares top de linha',
          '📱 GameCube/Wii: Dolphin Emulator — Snapdragon 845+',
          '📱 SNES: Snes9x',
          '📱 GBA: mGBA',
          '📱 N64: Mupen64Plus'
        ]
      },
      'melhores emuladores pc': {
        titulo: '🏆 Melhores Emuladores para PC',
        lista: [
          '💻 PS1: DuckStation / ePSXe',
          '💻 PS2: PCSX2',
          '💻 PSP: PPSSPP',
          '💻 GameCube/Wii: Dolphin',
          '💻 Switch: Yuzu / Ryujinx',
          '💻 SNES: Snes9x',
          '💻 GBA: mGBA',
          '💻 RetroArch: Tudo em um!'
        ]
      },
      'celular fraco': {
        titulo: '📱 Celular Mais Simples / Antigo',
        recomendacoes: [
          '✅ PS1: DuckStation — Roda perfeito',
          '✅ PSP: PPSSPP — Em resolução 1x',
          '✅ SNES, GBA, NES, Mega Drive: RetroArch',
          '❌ PS2 e Switch: Ainda não funcionam bem em celular simples',
          '💡 Dica: Use resolução 1x e ative frameskip para mais velocidade'
        ]
      },
      'melhorar performance emulador': {
        titulo: '⚡ Melhorar Velocidade no Celular',
        dicas: [
          '🔹 Reduza resolução para 1x ou 2x',
          '🔹 Ative "Frameskip" se disponível',
          '🔹 Feche outros apps antes de jogar',
          '🔹 Use o modo de performance do celular',
          '🔹 Troque o backend gráfico (Vulkan/OpenGL)',
          '🔹 Diminua a qualidade de sombras',
          '🔹 Ative Fast Memory / Speed Hacks'
        ]
      },
      'arquivos necessarios': {
        titulo: '📁 Arquivos que você precisa',
        itens: [
          '🔹 ROMs/Jogos: Você precisa ter os arquivos dos jogos (.iso, .zip, .chd)',
          '🔹 BIOS: Alguns emuladores precisam da BIOS do console — baixe separadamente',
          '🔹 Salve os jogos: O emulador NÃO vem com jogos inclusos'
        ]
      },
      'formato jogos': {
        titulo: '📂 Formatos de Jogo Comuns',
        formatos: [
          'PSP: .iso .cso .chd',
          'PS1: .iso .bin .chd',
          'PS2: .iso',
          'Switch: .xci .nsp',
          'GBA/SNES/NES: .zip .smc .gba'
        ]
      },
      'switch no celular': {
        titulo: '🔵 Switch no Celular — Realidade Atual',
        status: '✅ Em desenvolvimento, exigindo celular MUITO potente',
        emuladores: ['Strato', 'Skyline'],
        requisitos_minimos: 'Snapdragon 8 Gen 1+ ou Dimensity 9000+ | 8GB RAM',
        observacoes: [
          '⚠️ Ainda não funciona em todos os celulares',
          '⚠️ Apenas alguns jogos funcionam bem',
          '⚠️ Sempre use a versão mais recente do app',
          '💡 Para jogar hoje com tranquilidade: use no PC ou compre um Switch'
        ]
      },
      'ps2 no celular': {
        titulo: '🎮 PS2 no Celular — Guia Completo',
        emuladores: ['AetherSX2', 'NetherSX2'],
        requisitos_minimos: 'Snapdragon 845 / Exynos 9810 (2018+)',
        recomendado: 'Snapdragon 8 Gen 1+ para jogar bem',
        dicas: [
          '🔹 Resolução 1x se estiver lento',
          '🔹 Ative frameskip para 1 ou 2 quadros',
          '🔹 Cada jogo pode precisar de configuração diferente',
          '🔹 Jogos pesados = precisa de celular mais potente'
        ]
      },
      'diferença yuzu ryujinx': {
        titulo: 'Yuzu vs Ryujinx — Qual escolher?',
        yuzu: '✅ Mais rápido e simples | ❌ Descontinuado',
        ryujinx: '✅ Mais preciso e compatível | ✅ Ativo e atualizado',
        conclusao: 'Prefira Ryujinx atualmente. Ambos exigem PC bom.'
      },
      'emulador seguro': {
        titulo: '🛡️ Baixe Sempre de Fontes Oficiais',
        avisos: [
          '✅ PPSSPP: site oficial ou Google Play',
          '✅ DuckStation: GitHub oficial',
          '✅ RetroArch: site oficial ou Google Play',
          '✅ Ryujinx: GitHub oficial',
          '⚠️ Cuidado com cópias falsas na internet — podem conter vírus!'
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
// 🧠 SISTEMA DE RESPOSTAS — PERGUNTAS NORMAIS TAMBÉM!
// ==========================================
const RespostasNormais = {
  respostas: new Map(),

  init() {
    const respostasPadrao = {
      'oi': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre qualquer emulador — para PC, celular, PSP, Switch, PS2, tudo! 😊',
      'olá': '👋 Olá! Tudo bem? Sou seu assistente de emuladores! Pergunte sobre qualquer emulador — para PC, celular, PSP, Switch, PS2, tudo! 😊',
      'bom dia': '🌅 Bom dia! Como posso ajudar com emuladores hoje? 😊',
      'boa tarde': '☀️ Boa tarde! Precisa de ajuda com algum emulador? Estou aqui! 🎮',
      'boa noite': '🌙 Boa noite! Bora jogar? Precisa de ajuda com emuladores? 🎮',
      'tudo bem': 'Tudo ótimo por aqui! 😊 E com você? Em que posso ajudar?',
      'quem é você': 'Sou o EmuladorHelper! 🎮 Ajudo com informações sobre emuladores para PC e Celular. PSP, PS2, Switch, GameCube, SNES e muito mais! É só perguntar!',
      'o que você faz': 'Ajudo com tudo sobre emuladores! 🎮\n• Qual emulador usar no celular\n• Requisitos e configurações\n• Dicas de performance\n• Melhores opções por plataforma\nÉ só perguntar!',
      'obrigado': 'De nada! 😊 Qualquer dúvida sobre emuladores, é só chamar! Bora jogar! 🎮',
      'obrigada': 'De nada! 😊 Qualquer dúvida sobre emuladores, é só chamar! Bora jogar! 🎮',
      'vlw': 'De nada! Bora jogar! 🎮',
      'ajuda': '📋 **Comandos disponíveis:**\n\n• !ajuda — Mostra os comandos\n• !ping — Verifica se estou online\n• !lista — Lista todos os emuladores que conheço\n• !busca [termo] — Pesquisa na base\n• !corrige = [info] — Me ensina algo novo\n\n💡 Sem usar comando: é só perguntar normalmente!',
      'quais emuladores você conhece': '🎮 Conheço vários! Veja:\n\n💻 PC: PCSX2, Dolphin, Yuzu, Ryujinx, DuckStation, PPSSPP, RetroArch\n📱 Celular: AetherSX2, NetherSX2, Strato, Skyline, Dolphin, PPSSPP, DuckStation, Snes9x, mGBA\n\nPergunte sobre qualquer um! 😊'
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
  if (item.sistema) msg += `🎮 Sistema: ${item.sistema}\n`
  if (item.plataforma) msg += `💻 Plataforma: ${item.plataforma}\n`
  if (item.melhorPara) msg += `📍 Ideal para: ${item.melhorPara}\n`
  if (item.descricao) msg += `📝 ${item.descricao}\n`
  if (item.requisitos) msg += `⚙️ Requisitos: ${item.requisitos}\n`
  if (item.resolucao) msg += `🖥️ Resolução: ${item.resolucao}\n`
  if (item.lista) msg += `${item.lista.join('\n')}\n`
  if (item.recomendacoes) msg += `${item.recomendacoes.join('\n')}\n`
  if (item.dicas) msg += `💡 Dicas:\n${item.dicas.join('\n')}\n`
  if (item.observacoes) msg += `\nℹ️ Observações:\n${item.observacoes.join('\n')}\n`
  if (item.requisitos_minimos) msg += `📊 Mínimo: ${item.requisitos_minimos}\n`
  if (item.recomendado) msg += `✅ Recomendado: ${item.recomendado}\n`
  if (item.emuladores) msg += `🔧 Emuladores: ${item.emuladores.join(', ')}\n`
  if (item.yuzu) msg += `🍊 Yuzu: ${item.yuzu}\n`
  if (item.ryujinx) msg += `🐉 Ryujinx: ${item.ryujinx}\n`
  if (item.conclusao) msg += `\n✅ ${item.conclusao}\n`
  if (item.formatos) msg += `📂 Formatos:\n${item.formatos.join('\n')}\n`
  if (item.itens) msg += `${item.itens.join('\n')}\n`
  if (item.avisos) msg += `🛡️ Segurança:\n${item.avisos.join('\n')}\n`
  if (item.performance) msg += `⚡ Performance: ${item.performance}\n`
  if (item.celular) msg += `📱 ${item.celular}\n`
  if (item.backend) msg += `🔧 Backend: ${item.backend}\n`

  return msg.trim() || JSON.stringify(item, null, 2).slice(0, 600)
}

async function processarPergunta(texto) {
  // 1️⃣ Respostas normais primeiro
  const respostaNormal = RespostasNormais.buscar(texto)
  if (respostaNormal) return respostaNormal

  // 2️⃣ Busca na base de emuladores
  const resultados = EmuladorBase.buscar(texto, 3)
  if (resultados.length > 0) {
    if (resultados.length === 1) {
      return formatarResposta(resultados[0].item, texto)
    }
    let msg = `🔍 Encontrei ${resultados.length} resultados:\n\n`
    resultados.forEach((r, i) => {
      msg += `${i+1}. **${r.chave}**\n${formatarResposta(r.item, texto).slice(0, 100)}...\n\n`
    })
    return msg
  }

  // 3️⃣ Resposta amigável se não encontrou
  return `🤔 Ainda não tenho informação exata sobre isso, mas posso ajudar com:\n\n• Emuladores para celular e PC\n• PS2, PSP, Switch, GameCube, SNES, GBA\n• Requisitos e configurações\n• Dicas de performance\n\n📌 Pergunte de forma simples, por exemplo:\n"Melhor emulador de PS2 para celular"\n"PPSSPP requisitos"\n"Switch no celular"\n\nOu me ensine com: !corrige sua pergunta = resposta correta 😊`
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
      versao: '2.0-ampliada'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('🎮 EmuladorHelper v2.0 — Base Ampliada Online!')
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP — CÓDIGO DE PAREAMENTO
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
  console.log(`🎮 EmuladorHelper v2.0 iniciado — ${EmuladorBase.contar()} verbetes`)

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

    // ⚙️ Comandos
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
!lista — Lista todos os emuladores
!busca [termo] — Pesquisa
!corrige pergunta = resposta — Me ensina

💡 Sem comando: é só perguntar normalmente! 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Estou online e pronto! 🎮')
          break

        case 'lista':
          const itens = [...EmuladorBase.dados.keys()].filter(k => !k.includes(' ') || k.length < 25).slice(0, 20)
          await responder(`📚 **Base de Conhecimento:** ${EmuladorBase.contar()} itens\n\n${itens.map((k, i) => `${i+1}. ${k}`).join('\n')}`)
          break

        case 'busca':
          if (!args) {
            await responder('🔍 Use: !busca ppsspp')
            break
          }
          const res = EmuladorBase.busca(args, 3)
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

    // 💬 PERGUNTAS NORMAIS — Qualquer mensagem que não seja comando!
    console.log(`💬 Pergunta: ${texto}`)
    await sock.readMessages([msg.key])
    
    const resposta = await processarPergunta(texto)
    await responder(resposta)
  })
}

iniciarBot().catch(err => console.error('❌ Erro:', err))
