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
// ⚙️ CONFIGURAÇÕES
// ==========================================
const CONFIG = {
  GATILHO: (process.env.GATILHO || 'nexos').toLowerCase(),
  PREFIXO_COMANDOS: (process.env.TRIGGER || '!').toLowerCase(),
  PHONE_NUMBER: process.env.PHONE_NUMBER || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'meta/llama-3.1-70b-instruct',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || ''
}

console.log(`🔐 Gatilho: "${CONFIG.GATILHO}" — só respondo com essa palavra!`)
console.log(`🤖 OpenRouter: ${CONFIG.OPENROUTER_API_KEY ? '✅ Ativado' : '❌ Sem chave'}`)
console.log(`🧠 NVIDIA: ${CONFIG.NVIDIA_API_KEY ? '✅ Ativado' : '❌ Sem chave'}`)

// ==========================================
// 🤖 SISTEMA DE IA — OpenRouter + NVIDIA
// ==========================================
const IA_Generativa = {
  cache: new Map(),

  async perguntarOpenRouter(pergunta) {
    if (!CONFIG.OPENROUTER_API_KEY) return null
    
    const cacheKey = `or:${pergunta.toLowerCase()}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    try {
      console.log(`🤖 Consultando OpenRouter: "${pergunta}"`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://localhost'
        },
        body: JSON.stringify({
          model: CONFIG.OPENROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content: 'Você é um assistente útil, amigável e direto. Responda de forma clara e concisa em português. Seja educado e não use texto muito longo. Evite jargões desnecessários.'
            },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      })

      if (!res.ok) throw new Error(`OpenRouter: ${res.status}`)
      const dados = await res.json()
      const resposta = dados.choices?.[0]?.message?.content
      
      if (resposta) {
        this.cache.set(cacheKey, resposta)
        if (this.cache.size > 30) this.cache.clear()
      }
      return resposta
    } catch (err) {
      console.warn(`⚠️ OpenRouter falhou: ${err.message}`)
      return null
    }
  },

  async perguntarNVIDIA(pergunta) {
    if (!CONFIG.NVIDIA_API_KEY) return null
    
    const cacheKey = `nvidia:${pergunta.toLowerCase()}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    try {
      console.log(`🧠 Consultando NVIDIA: "${pergunta}"`)
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta/llama3-70b-instruct',
          messages: [
            {
              role: 'system',
              content: 'Você é um assistente útil, amigável e direto. Responda de forma clara e concisa em português. Seja educado e objetivo.'
            },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      })

      if (!res.ok) throw new Error(`NVIDIA: ${res.status}`)
      const dados = await res.json()
      const resposta = dados.choices?.[0]?.message?.content
      
      if (resposta) {
        this.cache.set(cacheKey, resposta)
        if (this.cache.size > 30) this.cache.clear()
      }
      return resposta
    } catch (err) {
      console.warn(`⚠️ NVIDIA falhou: ${err.message}`)
      return null
    }
  },

  async perguntar(pergunta) {
    // Tenta OpenRouter primeiro, depois NVIDIA como fallback
    let resposta = await this.perguntarOpenRouter(pergunta)
    if (!resposta) resposta = await this.perguntarNVIDIA(pergunta)
    return resposta
  }
}

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
// 🖼️ SISTEMA DE IMAGENS
// ==========================================
const BuscaImagens = {
  cache: new Map(),

  getImagemAleatoria(termo = '') {
    const seed = encodeURIComponent(termo || Math.random().toString(36).substring(7))
    return {
      url: `https://picsum.photos/seed/${seed}/600/400`,
      autor: 'Picsum Photos',
      pagina: 'https://picsum.photos',
      alt: termo
    }
  },

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
      return null
    }
  },

  async buscar(termo, limite = 1) {
    const cacheKey = termo.toLowerCase()
    if (this.cache.has(cacheKey)) return [this.cache.get(cacheKey)]

    let imagem = await this.gerarImagem(termo)
    if (!imagem) imagem = this.getImagemAleatoria(termo)

    this.cache.set(cacheKey, imagem)
    if (this.cache.size > 50) this.cache.clear()
    return [imagem]
  }
}

// ==========================================
// 🧠 BASE DE CONHECIMENTO
// ==========================================
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const STOPWORDS = new Set(['de','do','da','no','na','em','um','uma','os','as','ou','se','eu','me','meu','minha','pra','para','com','que','qual','como','sobre','é','a','o','que','quais','quem','onde','quando','por','porque'])

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
        descricao: 'Winlator é um app que permite rodar jogos e programas de Windows diretamente no celular Android. Combina Box64 + Wine.',
        requisitos: 'Android 10+ | Snapdragon 720G ou melhor | Mínimo 4GB RAM',
        resolucao: '📱 Básico: 800×600 | Intermediário: 960×544 | Bom: 1280×720',
        dicas: ['🔹 Crie um container diferente para cada jogo', '🔹 Lento? Abaixe a resolução primeiro'],
        site: 'winlator.dev',
        termoImagem: 'Winlator Android app interface'
      },
      'gamehub': {
        titulo: '🎮 GameHub — Emulador de Windows para Celular',
        descricao: 'GameHub é um app novo da mesma equipe do Winlator. Interface mais bonita, usa Proton em vez de Wine.',
        requisitos: 'Android 10+ | Snapdragon 8 Gen 1+ ideal | 6GB RAM mínimo',
        vantagens: ['✅ Interface mais fácil de usar', '✅ Organiza os jogos em biblioteca', '✅ Mais jogos funcionam de primeira'],
        site: 'winlator.dev/gamehub',
        termoImagem: 'GameHub Android app emulator'
      },
      'eden': {
        titulo: '🔵 Eden — Emulador de Switch para Celular',
        descricao: 'Eden é atualmente o melhor emulador de Switch para Android. Gratuito e de código aberto.',
        requisitos: 'Android com Vulkan 1.1+ | Snapdragon 8 Gen 1+ ideal | 8GB RAM mínimo',
        precisa: 'prod.keys + firmware extraídos do SEU próprio console',
        site: 'eden-emu.dev',
        termoImagem: 'Eden Emulator Nintendo Switch Android'
      },
      'ppsspp': {
        titulo: '🎮 PPSSPP — O Melhor Emulador de PSP',
        descricao: 'PPSSPP é o melhor emulador de PSP que existe! Roda praticamente todos os jogos e é bem leve.',
        resolucao: '📱 1x a 5x conforme seu celular',
        site: 'ppsspp.org',
        termoImagem: 'PPSSPP emulator PSP interface'
      },
      'dxvk': {
        titulo: '🔷 DXVK — Guia Completo',
        o_que_e: 'Ferramenta que converte gráficos DirectX para Vulkan. Sem ela, jogos ficam lentos ou não abrem.',
        versoes: ['1.10.3 → jogos antigos (DirectX 9)', '2.3.1 → recomendado para maioria', '2.4+ → jogos modernos'],
        dicas: ['🔹 Jogo não abre? Troque a versão do DXVK', '🔹 Prefira versões com Async']
      },
      'winlator vs gamehub': {
        titulo: '🪟 Winlator vs GameHub — Qual Escolher?',
        winlator: ['✅ Mais leve e rápido', '✅ Mais opções avançadas', '❌ Interface mais técnica'],
        gamehub: ['✅ Mais fácil de usar', '✅ Organiza os jogos', '✅ Usa Proton', '❌ Um pouquinho mais pesado'],
        conclusao: 'Iniciante → comece com GameHub. Quer mais controle → use Winlator. Pode usar os dois!'
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

  buscar(pergunta, limite = 5) {
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
// 🧠 GERADOR DE RESPOSTAS
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

  gerar(item) {
    let resposta = ''
    if (item.titulo) resposta += `${item.titulo}\n\n`
    if (item.descricao) resposta += `${item.descricao}\n\n`
    if (item.o_que_e) resposta += `ℹ️ ${item.o_que_e}\n\n`
    if (item.requisitos) resposta += `📋 Requisitos: ${item.requisitos}\n\n`
    if (item.resolucao) resposta += `🖥️ Resolução ideal:\n${item.resolucao}\n\n`
    if (item.dicas) resposta += `💡 Dicas:\n${Array.isArray(item.dicas) ? item.dicas.join('\n') : item.dicas}\n\n`
    if (item.vantagens) resposta += `✅ Vantagens:\n${item.vantagens.join('\n')}\n\n`
    if (item.winlator) resposta += `🪟 Winlator:\n${item.winlator.join('\n')}\n\n`
    if (item.gamehub) resposta += `🎮 GameHub:\n${item.gamehub.join('\n')}\n\n`
    if (item.conclusao) resposta += `💡 ${item.conclusao}\n`
    if (item.versoes) resposta += `📦 Versões recomendadas:\n${item.versoes.join('\n')}\n`
    if (item.site) resposta += `\n🌐 Site oficial: ${item.site}\n`
    return resposta.trim()
  }
}

// ==========================================
// 💬 PROCESSADOR PRINCIPAL
// ==========================================
async function processarMensagem(pergunta) {
  const resultados = EmuladorBase.buscar(pergunta, 5)

  // ✅ Nenhum resultado → usa IA externa
  if (resultados.length === 0) {
    console.log(`🤖 Sem resultado na base — consultando IA...`)
    const respostaIA = await IA_Generativa.perguntar(pergunta)
    if (respostaIA) {
      return { tipo: 'ia', texto: respostaIA, imagem: null }
    }
    return { 
      tipo: 'nenhum', 
      texto: `🤔 Não tenho informações específicas sobre isso.\n\nPosso ajudar com emuladores:\n🪟 Winlator • GameHub\n🔷 DXVK • Wine • Proton\n🎮 Eden • PPSSPP • Dolphin\n\nOu pergunte qualquer coisa que eu busco pra você! 😊`,
      imagem: null 
    }
  }

  // ✅ Um resultado → mostra direto
  if (resultados.length === 1) {
    const item = resultados[0].item
    const texto = GeradorResposta.gerar(item)
    let imagem = null
    if (GeradorResposta.querImagem(pergunta) && item.termoImagem) {
      const imgs = await BuscaImagens.buscar(item.termoImagem, 1)
      imagem = imgs[0] || null
    }
    return { tipo: 'unico', texto, imagem }
  }

  // ✅ Múltiplos resultados → lista bonita e pergunta qual quer
  let texto = `🔍 Encontrei ${resultados.length} coisas relacionadas:\n\n`
  resultados.forEach((r, i) => {
    const titulo = r.item.titulo || r.chave
    texto += `${i + 1}. ${titulo}\n`
  })
  texto += `\n👉 Me diga o número ou o nome do que você quer ver em detalhes! 😊`
  
  return { tipo: 'multiplo', texto, imagem: null, opcoes: resultados }
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
      versao: '6.0-ia-hibrida',
      gatilho: CONFIG.GATILHO,
      openrouter: CONFIG.OPENROUTER_API_KEY ? '✅' : '❌',
      nvidia: CONFIG.NVIDIA_API_KEY ? '✅' : '❌'
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`🎮 IA Híbrida v6.0\n✅ Gatilho: "${CONFIG.GATILHO}"\n✅ OpenRouter + NVIDIA\n✅ Base de conhecimento + IA geral`)
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  console.log(`🚀 Sistema híbrido iniciado com sucesso!`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP
// ==========================================
let codigoGerado = false

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

async function iniciarBot() {
  EmuladorBase.carregar()

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
      console.log(`🔐 LEMBRETE: Sempre comece com "${CONFIG.GATILHO}"`)
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
      if (!CONFIG.PHONE_NUMBER) {
        console.error('❌ Configure PHONE_NUMBER! Ex: 5511999999999')
        return
      }
      const telefone = apenasDigitos(CONFIG.PHONE_NUMBER)
      if (telefone.length < 10) return
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

    const textoCompleto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const textoLimpo = textoCompleto.trim()
    const textoMinusculo = textoLimpo.toLowerCase()

    // 🛡️ SEM GATILHO = SILÊNCIO TOTAL
    if (!textoMinusculo.startsWith(CONFIG.GATILHO)) {
      console.log(`🙈 Sem gatilho — ignorando mensagem`)
      return
    }

    const pergunta = textoLimpo.slice(CONFIG.GATILHO.length).trim()
    console.log(`💬 Pergunta: "${pergunta}"`)

    const responder = (txt) => sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg })
    const responderComImagem = async (txt, img) => {
      if (img) {
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            image: { url: img.url },
            caption: txt + `\n📸 ${img.autor}\n🔗 ${img.pagina}`
          }, { quoted: msg })
        } catch {
          await responder(txt + `\n🖼️ ${img.url}`)
        }
      } else {
        await responder(txt)
      }
    }

    // ⚠️ Só "nexos" sem pergunta
    if (!pergunta) {
      await responder('👋 Olá! Em que posso te ajudar? 😊\nExemplo: nexos o que é o Winlator?')
      return
    }

    // ⚙️ Comandos
    if (pergunta.startsWith(CONFIG.PREFIXO_COMANDOS)) {
      const cmd = pergunta.slice(CONFIG.PREFIXO_COMANDOS.length).trim().toLowerCase()
      const [acao, ...resto] = cmd.split(/\s+/)
      const args = resto.join(' ')

      switch (acao) {
        case 'ajuda':
          await responder(`📋 **Como usar:**

Sempre comece com: **${CONFIG.GATILHO}**

Exemplos:
• ${CONFIG.GATILHO} o que é o Winlator?
• ${CONFIG.GATILHO} mostre o Eden
• ${CONFIG.GATILHO} qual a diferença entre Winlator e GameHub?
• ${CONFIG.GATILHO} me explique o que é inteligência artificial

Comandos:
${CONFIG.GATILHO} !ajuda — Mostra isto
${CONFIG.GATILHO} !ping — Verifica se estou online
${CONFIG.GATILHO} !lista — Lista tópicos de emuladores
${CONFIG.GATILHO} !imagem [termo] — Mostra uma imagem
${CONFIG.GATILHO} !corrige pergunta = resposta — Me ensina 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Online e pronto pra te ajudar! 🎮')
          break

        case 'lista':
          const itens = [...EmuladorBase.dados.keys()]
          await responder(`📚 ${EmuladorBase.contar()} tópicos:\n\n${itens.map((k,i)=>`${i+1}. ${k}`).join('\n')}\n\nPergunte: ${CONFIG.GATILHO} [seu tópico]`)
          break

        case 'imagem':
          if (!args) {
            await responder('🖼️ Use: nexos !imagem winlator')
            break
          }
          await responder(`🔍 Buscando imagem de "${args}"...`)
          const imgs = await BuscaImagens.buscar(args, 1)
          if (imgs[0]) {
            await responderComImagem(`✅ Aqui está!`, imgs[0])
          } else {
            await responder(`😕 Não encontrei imagem para "${args}"`)
          }
          break

        case 'corrige':
          if (!args.includes('=')) {
            await responder('📝 Use: nexos !corrige pergunta = resposta')
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
          await responder('🤔 Comando não reconhecido. Use: nexos !ajuda')
      }
      return
    }

    // 💬 Processa a pergunta
    await sock.readMessages([msg.key])
    const resultado = await processarMensagem(pergunta)
    await responderComImagem(resultado.texto, resultado.imagem)
  })
}

iniciarBot().catch(err => console.error('❌ Erro:', err))
