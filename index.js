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
// 🖼️ SISTEMA DE IMAGENS — SEM API KEY!
// ==========================================
const BuscaImagens = {
  cache: new Map(),

  // 🖼️ Fonte 1: Picsum Photos — fotos reais aleatórias, sem chave
  getImagemAleatoria(termo = '') {
    const seed = encodeURIComponent(termo || Math.random().toString(36).substring(7))
    return {
      url: `https://picsum.photos/seed/${seed}/600/400`,
      autor: 'Picsum Photos',
      pagina: 'https://picsum.photos',
      alt: termo
    }
  },

  // 🎨 Fonte 2: Pollinations AI — gera imagem com IA, sem chave
  async gerarImagem(termo) {
    try {
      const prompt = encodeURIComponent(`${termo}, emulator, screenshot, clean interface, high quality`)
      return {
        url: `https://image.pollinations.ai/prompt/${prompt}?width=800&height=600&nologo=true`,
        autor: 'Gerado por IA — Pollinations',
        pagina: 'https://pollinations.ai',
        alt: termo
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao gerar imagem: ${err.message}`)
      return null
    }
  },

  // 🔄 Sistema inteligente de fallback
  async buscar(termo, limite = 1) {
    const cacheKey = termo.toLowerCase()
    if (this.cache.has(cacheKey)) {
      return [this.cache.get(cacheKey)]
    }

    console.log(`🖼️ Buscando imagem para: "${termo}"`)
    
    // Tenta primeiro gerar uma imagem relevante com IA
    let imagem = await this.gerarImagem(termo)
    
    // Se falhar, usa Picsum como fallback garantido
    if (!imagem) {
      imagem = this.getImagemAleatoria(termo)
    }

    this.cache.set(cacheKey, imagem)
    if (this.cache.size > 50) this.cache.clear() // Limpeza de cache

    return [imagem]
  },

  formatarLink(imagem) {
    if (!imagem) return ''
    return `\n📸 ${imagem.autor}\n🔗 ${imagem.pagina}`
  }
}

// ==========================================
// 🧠 SISTEMA DE RESPOSTAS INTELIGENTES
// ==========================================
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

const STOPWORDS = new Set(['de','do','da','no','na','em','um','uma','os','as','ou','se','eu','me','meu','minha','pra','para','com','que','qual','como','sobre','é','a','o','que','quais','quem','onde','quando','por','porque'])

const CONVERSA_NATURAL = {
  saudações: {
    oi: 'Oi! 😊 Tudo bem? Sou seu assistente de emuladores! É só perguntar que eu te ajudo!',
    olá: 'Olá! 👋 Como está? Precisa de ajuda com algum emulador? Estou aqui!',
    'bom dia': 'Bom dia! ☀️ Bora configurar aquele emulador? É só mandar a pergunta!',
    'boa tarde': 'Boa tarde! 😜 Tudo bem? Qual é a dúvida de hoje?',
    'boa noite': 'Boa noite! 🌙 Hora de jogar? Me pergunta qualquer coisa!'
  },
  despedidas: {
    valeu: 'De nada! 😎 Bora jogar! Qualquer coisa é só chamar! 🎮',
    obrigado: 'Que isso! 😊 Sempre às ordens! Divirta-se! 🎮',
    obrigada: 'De nada! 😘 Qualquer dúvida, é só falar!',
    vlw: '✌️ Bora jogar! Até mais!',
    tchau: '👋 Até mais! Bom jogo!'
  },
  apresentacao: {
    'quem é você': 'Sou seu assistente de emuladores! 🎮 Ajudo com tudo sobre jogos no celular e PC — Winlator, GameHub, Eden, PPSSPP, configurações, DXVK, drivers e muito mais. Agora também mostro imagens! É só perguntar naturalmente!',
    'o que você faz': 'Te ajudo com emuladores! 🎮 Qual usar, como configurar, melhorar performance, resolver problemas... e ainda mostro imagens! É só perguntar!',
    'ajuda': 'Claro! 😊 Você pode me perguntar coisas como:\n• "Como configurar o Winlator?"\n• "Mostre-me o Eden Emulator"\n• "Qual DXVK usar no GameHub?"\n\nComandos:\n!ajuda — lista de comandos\n!ping — verifica se estou online\n!imagem [termo] — Mostra uma imagem\n!lista — tópicos que conheço'
  }
}

// ==========================================
// 🧠 MOTOR DE RESPOSTAS INTELIGENTES
// ==========================================
const GeradorResposta = {
  termosImagem: new Set(['mostre', 'imagem', 'foto', 'print', 'captura', 'como é', 'interface', 'tela', 'visual', 'ver', 'olha']),

  querImagem(pergunta) {
    const p = normalizar(pergunta)
    for (const termo of this.termosImagem) {
      if (p.includes(termo)) return true
    }
    return false
  },

  gerar(pergunta, item, chave) {
    const perguntaNorm = normalizar(pergunta)
    
    let resposta = ''
    if (item.titulo) resposta += `${item.titulo}\n\n`
    if (item.descricao) resposta += `${item.descricao}\n\n`
    if (item.o_que_e) resposta += `ℹ️ ${item.o_que_e}\n\n`
    if (item.requisitos) resposta += `📋 Requisitos: ${item.requisitos}\n\n`
    if (item.resolucao) resposta += `🖥️ Resolução ideal:\n${item.resolucao}\n\n`
    if (item.dicas) {
      resposta += `💡 Dicas:\n${Array.isArray(item.dicas) ? item.dicas.join('\n') : item.dicas}\n\n`
    }
    if (item.lista) resposta += `${item.lista.join('\n')}\n\n`
    if (item.versoes && Array.isArray(item.versoes)) resposta += `📦 Versões:\n${item.versoes.join('\n')}\n\n`
    if (item.modos && !Array.isArray(item.modos)) {
      resposta += `🔧 Modos:\n${Object.entries(item.modos).map(([n,d])=>`• ${n}: ${d}`).join('\n')}\n\n`
    }
    if (item.tela_preta) resposta += `🖤 Tela preta?\n${item.tela_preta.join('\n')}\n\n`
    if (item.jogo_não_abre) resposta += `❌ Não abre?\n${item.jogo_não_abre.join('\n')}\n\n`
    if (item.lento) resposta += `🐌 Lento?\n${item.lento.join('\n')}\n\n`
    if (item.dica) resposta += `💡 ${item.dica}\n`
    if (item.observacao) resposta += `ℹ️ ${item.observacao}\n`
    if (item.site) resposta += `🌐 Site oficial: ${item.site}\n`

    return resposta.trim() || this.fallback(chave, item)
  },

  semResposta(pergunta) {
    return `🤔 Entendi sua pergunta: "${pergunta}"\n\nPosso ajudar com:\n\n🪟 Winlator / GameHub — jogos de PC no celular\n🔷 DXVK, Wine, Proton, Box64 — configurações\n🎮 Eden (Switch), PPSSPP (PSP), Dolphin\n🖼️ Peça imagens: "Mostre-me o Winlator"\n\nTente perguntar de forma simples! 😊`
  },

  fallback(chave, item) {
    if (typeof item === 'string') return item
    return JSON.stringify(item, null, 2).slice(0, 500)
  }
}

// ==========================================
// 📚 BASE DE CONHECIMENTO
// ==========================================
const EmuladorBase = {
  dados: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),

  carregar() {
    this.inicializarBaseCompleta()
    try {
      if (fs.existsSync(this.arquivo)) {
        const salvos = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        for (const [chave, valor] of Object.entries(salvos)) {
          if (valor && valor.custom) this.dados.set(chave.toLowerCase(), valor)
        }
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao ler base: ${err.message}`)
    }
    this.salvar()
  },

  inicializarBaseCompleta() {
    const base = {
      'winlator': {
        titulo: '🪟 Winlator — Jogos de Windows no Celular!',
        plataforma: 'Android',
        sistema: 'Windows (PC)',
        descricao: 'Winlator é um app que permite rodar jogos de Windows diretamente no celular Android. Usa Box64 + Wine.',
        requisitos: 'Android 10+ | Snapdragon 720G+ | 4GB RAM mínimo',
        resolucao: '📱 Básico: 800×600 | Intermediário: 960×544 | Bom: 1280×720',
        dicas: ['🔹 Crie um container por jogo', '🔹 Lento? Abaixe a resolução primeiro'],
        site: 'winlator.dev',
        termoImagem: 'Winlator Android app interface'
      },
      'gamehub': {
        titulo: '🎮 GameHub — Emulador de Windows para Celular',
        plataforma: 'Android',
        sistema: 'Windows (PC)',
        descricao: 'GameHub é um app novo da mesma equipe do Winlator. Mais bonito e fácil de usar, com Proton.',
        requisitos: 'Android 10+ | Snapdragon 8 Gen 1+ ideal | 6GB RAM mínimo',
        vantagens: ['✅ Interface amigável', '✅ Organiza os jogos', '✅ Usa Proton — mais jogos funcionam'],
        site: 'winlator.dev/gamehub',
        termoImagem: 'GameHub Android app emulator'
      },
      'eden': {
        titulo: '🔵 Eden — Emulador de Switch para Celular',
        plataforma: 'Android',
        sistema: 'Nintendo Switch',
        descricao: 'Eden é o melhor emulador de Switch para Android. Gratuito e de código aberto.',
        requisitos: 'Android com Vulkan 1.1+ | Snapdragon 8 Gen 1+ ideal | 8GB RAM',
        precisa: 'prod.keys + firmware do SEU próprio console',
        site: 'eden-emu.dev',
        termoImagem: 'Eden Emulator Nintendo Switch Android'
      },
      'ppsspp': {
        titulo: '🎮 PPSSPP — O Melhor Emulador de PSP',
        plataforma: 'Android e PC',
        sistema: 'PlayStation Portable (PSP)',
        descricao: 'PPSSPP é o melhor emulador de PSP que existe! Roda em qualquer celular.',
        resolucao: '📱 1x a 5x conforme seu celular',
        site: 'ppsspp.org',
        termoImagem: 'PPSSPP emulator PSP interface'
      },
      'dxvk': {
        titulo: '🔷 DXVK — Guia Completo',
        o_que_e: 'Converte DirectX para Vulkan — sem ele os jogos ficam lentos ou não abrem.',
        versoes: ['1.10.3 → jogos antigos DX9', '2.3.1 → recomendado para maioria', '2.4+ → jogos modernos'],
        dicas: ['🔹 Não abre? Troque a versão', '🔹 Prefira sempre versões com Async']
      },
      'winlator vs gamehub': {
        titulo: '🪟 Winlator vs GameHub — Qual Escolher?',
        winlator: ['✅ Mais leve', '✅ Mais opções avançadas', '❌ Interface mais técnica'],
        gamehub: ['✅ Mais fácil de usar', '✅ Organiza os jogos', '✅ Usa Proton', '❌ Um pouquinho mais pesado'],
        conclusao: 'Iniciante → GameHub. Controle total → Winlator. Pode usar os dois!'
      }
    }

    for (const [chave, valor] of Object.entries(base)) {
      this.dados.set(chave.toLowerCase(), valor)
    }
    console.log(`🎮 Base carregada: ${this.dados.size} tópicos`)
  },

  salvar() {
    try { fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.dados), null, 2)); return true }
    catch { return false }
  },

  buscar(pergunta, limite = 3) {
    const resultados = []
    const perguntaNorm = normalizar(pergunta)
    const termos = perguntaNorm.split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t))

    for (const [chave, item] of this.dados) {
      let relevancia = 0
      const chaveNorm = normalizar(chave)
      const textoItem = normalizar(JSON.stringify(item))

      if (chaveNorm === perguntaNorm) relevancia += 100
      else if (chaveNorm.includes(perguntaNorm) || perguntaNorm.includes(chaveNorm)) relevancia += 50

      for (const termo of termos) {
        if (chaveNorm.includes(termo)) relevancia += 15
        if (textoItem.includes(termo)) relevancia += 3
      }

      if (relevancia > 0) resultados.push({ chave, item, relevancia })
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, limite)
  },

  adicionar(pergunta, resposta) {
    this.dados.set(pergunta.toLowerCase().trim(), { custom: true, resposta, data: new Date().toLocaleString('pt-BR') })
    this.salvar()
  },

  contar() { return this.dados.size }
}

// ==========================================
// 💬 PROCESSADOR DE MENSAGENS
// ==========================================
async function processarMensagem(texto) {
  const textoLimpo = texto.trim()
  const textoNorm = normalizar(textoLimpo)

  // 1️⃣ Conversa natural
  for (const [categoria, mapa] of Object.entries(CONVERSA_NATURAL)) {
    for (const [padrao, resposta] of Object.entries(mapa)) {
      if (textoNorm.includes(normalizar(padrao)) || normalizar(padrao).includes(textoNorm)) {
        return { texto: resposta, imagem: null }
      }
    }
  }

  // 2️⃣ Busca na base
  const resultados = EmuladorBase.buscar(textoLimpo, 3)
  
  if (resultados.length === 1) {
    const item = resultados[0].item
    const respostaTexto = GeradorResposta.gerar(textoLimpo, item, resultados[0].chave)
    
    let imagem = null
    if (GeradorResposta.querImagem(textoLimpo) && item.termoImagem) {
      const imagens = await BuscaImagens.buscar(item.termoImagem, 1)
      imagem = imagens[0] || null
    }
    return { texto: respostaTexto, imagem }
  } else if (resultados.length > 1) {
    let resposta = `🔍 Encontrei ${resultados.length} coisas:\n\n`
    resultados.forEach((r, i) => {
      resposta += `${i + 1}. ${r.item.titulo || r.chave}\n`
    })
    resposta += '\nMe diga qual você quer ver! 😊'
    return { texto: resposta, imagem: null }
  }

  return { texto: GeradorResposta.semResposta(textoLimpo), imagem: null }
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
      versao: '5.1-imagens-sem-chave',
      imagens: '✅ ATIVADO — Sem API Key!'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('🎮 EmuladorHelper v5.1 — Imagens Sem API Key!')
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  console.log(`🖼️ Sistema de imagens: ✅ ATIVADO — Sem chave necessária!`)
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
  console.log(`🧠 Sistema iniciado — ${EmuladorBase.contar()} tópicos`)

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
      console.log('✅ CONECTADO! 🎮')
      codigoGerado = false
    }

    if (connection === 'close') {
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — código: ${codigoErro}`)
      
      if (codigoErro === DisconnectReason.loggedOut || codigoErro === DisconnectReason.badSession) {
        console.log('🔑 Reiniciando...')
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
          console.log('👉 WhatsApp → Configurações → Aparelhos Conectados')
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
    
    const responder = (txt) => sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg })
    const responderComImagem = async (txt, img) => {
      if (img) {
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            image: { url: img.url },
            caption: txt + `\n📸 ${img.autor}\n🔗 ${img.pagina}`
          }, { quoted: msg })
        } catch (err) {
          console.warn(`⚠️ Não enviei imagem: ${err.message}`)
          await responder(txt + `\n🖼️ Imagem: ${img.url}`)
        }
      } else {
        await responder(txt)
      }
    }

    // ⚙️ Comandos
    if (textoLimpo.startsWith(TRIGGER)) {
      const cmd = textoLimpo.slice(TRIGGER.length).trim().toLowerCase()
      const [acao, ...resto] = cmd.split(/\s+/)
      const args = resto.join(' ')

      switch (acao) {
        case 'ajuda':
          await responder(`📋 **Comandos:**

!ajuda — Mostra isto
!ping — Verifica se estou online
!imagem [termo] — Mostra uma imagem
!lista — Lista tópicos
!corrige pergunta = resposta — Me ensina

💡 Peça imagens assim:
• "Mostre-me o Winlator"
• "Imagem do Eden Emulator" 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Online e pronto! 🎮')
          break

        case 'lista':
          const itens = [...EmuladorBase.dados.keys()].slice(0, 25)
          await responder(`📚 ${EmuladorBase.contar()} tópicos:\n\n${itens.map((k,i)=>`${i+1}. ${k}`).join('\n')}`)
          break

        case 'imagem':
          if (!args) {
            await responder('🖼️ Use: !imagem winlator')
            break
          }
          await responder(`🔍 Buscando imagem de "${args}"...`)
          const imagens = await BuscaImagens.buscar(args, 1)
          if (imagens[0]) {
            await responderComImagem(`✅ Aqui está!`, imagens[0])
          } else {
            await responder(`😕 Não encontrei imagem para "${args}"`)
          }
          break

        case 'corrige':
          if (!args.includes('=')) {
            await responder('📝 Use: !corrige pergunta = resposta')
            break
          }
          const [perg, resp] = args.split('=').map(s => s.trim())
          if (!perg || !resp) {
            await responder('⚠️ Falta pergunta ou resposta!')
            break
          }
          EmuladorBase.adicionar(perg, resp)
          await responder(`✅ Salvo!\n📌 ${perg}\n💬 ${resp}`)
          break

        default:
          await responder('🤔 Comando desconhecido. Use !ajuda')
      }
      return
    }

    // 💬 Perguntas normais
    console.log(`💬 Pergunta: ${texto}`)
    await sock.readMessages([msg.key])
    
    const { texto: respostaTexto, imagem } = await processarMensagem(textoLimpo)
    await responderComImagem(respostaTexto, imagem)
  })
}

iniciarBot().catch(err => console.error('❌ Erro:', err))
