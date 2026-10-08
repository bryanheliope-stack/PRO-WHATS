import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, isJidGroup } from '@whiskeysockets/baileys'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 📂 Pastas
const TEMP_DIR = path.join(__dirname, 'temp')
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge')
const AUTH_DIR = path.join(__dirname, 'auth')
const DATA_DIR = path.join(__dirname, 'data')
;[TEMP_DIR, KNOWLEDGE_DIR, AUTH_DIR, DATA_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ==========================================
// ⚙️ CONFIGURAÇÕES
// ==========================================
const CONFIG = {
  GATILHO: (process.env.GATILHO || 'nexos').toLowerCase(),
  PREFIXO_COMANDOS: (process.env.TRIGGER || '!').toLowerCase(),
  PHONE_NUMBER: process.env.PHONE_NUMBER || '',
  PAIRING_TOKEN: process.env.PAIRING_TOKEN || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL || '240000'),
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000
}

// 📡 Estado da conexão com o WhatsApp
const ESTADO = { status: 'iniciando', conectado: false, codigo: null, codigoEm: 0 }

console.log(`🔐 Gatilho: "${CONFIG.GATILHO}" — só respondo com essa palavra!`)
console.log(`🚫 Bloqueio de grupos: ✅ Ativado`)
console.log(`🖼️ Ignora GIFs: ✅ Ativado`)

// ==========================================
// 🔒 SISTEMA DE BLOQUEIO DE GRUPOS
// ==========================================
const GRUPOS_BLOQUEADOS_ARQUIVO = path.join(DATA_DIR, 'grupos_bloqueados.json')

const GrupoManager = {
  bloqueados: new Set(),

  carregar() {
    try {
      if (fs.existsSync(GRUPOS_BLOQUEADOS_ARQUIVO)) {
        const dados = JSON.parse(fs.readFileSync(GRUPOS_BLOQUEADOS_ARQUIVO, 'utf8'))
        this.bloqueados = new Set(dados)
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao carregar grupos bloqueados: ${err.message}`)
      this.bloqueados = new Set()
    }
    console.log(`🔒 Grupos bloqueados: ${this.bloqueados.size}`)
  },

  salvar() {
    try {
      fs.writeFileSync(GRUPOS_BLOQUEADOS_ARQUIVO, JSON.stringify([...this.bloqueados], null, 2))
      return true
    } catch {
      return false
    }
  },

  bloquear(grupoJid) {
    this.bloqueados.add(grupoJid)
    this.salvar()
  },

  liberar(grupoJid) {
    this.bloqueados.delete(grupoJid)
    this.salvar()
  },

  estaBloqueado(grupoJid) {
    return this.bloqueados.has(grupoJid)
  },

  listarBloqueados() {
    return [...this.bloqueados]
  }
}

GrupoManager.carregar()

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
          model: CONFIG.OPENROUTER_MODEL || 'meta/llama-3.1-70b-instruct',
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
    let resposta = await this.perguntarOpenRouter(pergunta)
    if (!resposta) resposta = await this.perguntarNVIDIA(pergunta)
    return resposta
  }
}

// ==========================================
// 🏓 SISTEMA DE PING — MANTÉM BOT ONLINE 24h
// ==========================================
const PING_SYSTEM = {
  url: process.env.RENDER_EXTERNAL_URL || process.env.PING_URL || '',
  interval: CONFIG.PING_INTERVAL,
  timer: null,
  ultimoPing: null,

  async ping() {
    if (!this.url) {
      console.log(`🏓 ⚠️ Sem URL de ping — configure RENDER_EXTERNAL_URL nas variáveis de ambiente`)
      return false
    }
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, { 
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'WhatsApp-Bot-Ping/1.0' }
      })
      this.ultimoPing = new Date().toLocaleTimeString('pt-BR')
      const tempo = Date.now() - inicio
      console.log(`🏓 Ping: ${res.ok ? '✅ ONLINE' : '⚠️ OK'} | ${tempo}ms | ${this.ultimoPing}`)
      return true
    } catch (err) {
      console.warn(`🏓 Ping falhou: ${err.message} — ${new Date().toLocaleTimeString('pt-BR')}`)
      return false
    }
  },

  iniciar() {
    if (!this.url) {
      console.log(`🏓 ⚠️ Para manter 24h, configure a variável RENDER_EXTERNAL_URL no Render`)
      console.log(`🏓 Exemplo: https://seu-bot.onrender.com`)
      return
    }
    console.log(`🏓 Sistema de ping ativado — a cada ${Math.round(this.interval/60000)}min`)
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
        o_que_e: 'Ferramenta que converte DirectX para Vulkan. Sem ela, jogos ficam lentos ou não abrem.',
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

  let texto = `🔍 Encontrei ${resultados.length} coisas relacionadas:\n\n`
  resultados.forEach((r, i) => {
    const titulo = r.item.titulo || r.chave
    texto += `${i + 1}. ${titulo}\n`
  })
  texto += `\n👉 Me diga o número ou o nome do que você quer ver! 😊`
  
  return { tipo: 'multiplo', texto, imagem: null, opcoes: resultados }
}

// ==========================================
// 🌐 SERVIDOR HTTP — MANTÉM BOT ACORDADO
// ==========================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      whatsapp: ESTADO.status,
      conectado: ESTADO.conectado,
      base: EmuladorBase.contar(),
      versao: '8.3-pareamento-robusto',
      gatilho: CONFIG.GATILHO,
      gruposBloqueados: GrupoManager.listarBloqueados().length,
      ignoraGif: true
    }))
  } else if (url.pathname === '/codigo') {
    const enviado = Buffer.from(url.searchParams.get('token') || '')
    const esperado = Buffer.from(CONFIG.PAIRING_TOKEN)
    const autorizado = CONFIG.PAIRING_TOKEN && esperado.length > 0 && 
      enviado.length === esperado.length && 
      crypto.timingSafeEqual(enviado, esperado)
    if (!autorizado) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    if (ESTADO.conectado) res.end('✅ WhatsApp já está conectado — nada a fazer.')
    else if (ESTADO.codigo) res.end(`📲 CÓDIGO: ${ESTADO.codigo}\n(gerado há ${Math.round((Date.now() - ESTADO.codigoEm) / 1000)}s)`)
    else res.end(`⏳ Sem código no momento. Status: ${ESTADO.status}`)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`🎮 Bot 24h — pareamento robusto ✅\n✅ Bloqueio de grupos\n✅ Ignora GIFs\n✅ Só respondo com: "${CONFIG.GATILHO}"`)
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  console.log(`🚀 Pareamento robusto ativo`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP — CONEXÃO E PAREAMENTO ROBUSTOS
// ==========================================
let sockInstance = null
let iniciando = false
let timerReconexao = null
let falhasSeguidas = 0
let ciclosSemParear = 0
let falhasBadSession = 0
let substituicoes = 0
let ultimoCodigoGerado = 0

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 🚫 VERIFICA SE É GIF
function ehGif(mensagem) {
  if (mensagem.gifPlayback || mensagem.message?.gifPlayback) return true
  const mtype = mensagem.message?.conversation ? null : Object.keys(mensagem.message || {})[0]
  if (mtype === 'videoMessage' && mensagem.message?.videoMessage?.gifPlayback) return true
  return false
}

function validarTelefone(bruto) {
  const digitos = apenasDigitos(bruto)
  if (!digitos) return { ok: false, erro: 'Número vazio' }
  if (digitos.length < 10 || digitos.length > 15) return { ok: false, erro: `Número com ${digitos.length} dígitos — esperado 10-15` }
  return { ok: true, digitos }
}

async function iniciarBot() {
  if (iniciando) return
  iniciando = true

  ESTADO.status = 'carregando'
  if (!baseCarregada) {
    EmuladorBase.carregar()
    baseCarregada = true
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const valido = validarTelefone(CONFIG.PHONE_NUMBER)
  if (!valido.ok) {
    console.error(`❌ PHONE_NUMBER inválido: ${valido.erro}`)
    console.error('👉 Use: 55DDDNÚMERO (ex: 5511999999999)')
    iniciando = false
    return
  }
  const telefone = valido.digitos

  const temSessao = fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
  if (temSessao) {
    console.log('🔑 Sessão existente encontrada — reconectando...')
  } else {
    console.log('📱 Nova sessão iniciada')
  }

  ESTADO.status = 'conectando'
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  sockInstance = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      ESTADO.status = 'conectado'
      ESTADO.conectado = true
      ESTADO.codigo = null
      falhasSeguidas = 0
      ciclosSemParear = 0
      console.log('✅✅✅ CONECTADO AO WHATSAPP!')
      iniciando = false
      return
    }

    if (connection === 'close') {
      ESTADO.conectado = false
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      const mensagemErro = lastDisconnect?.error?.message || 'Desconhecido'
      ESTADO.status = `desconectado (${codigoErro || mensagemErro})`
      console.log(`🔌 Desconectado — Código: ${codigoErro} | Motivo: ${mensagemErro}`)

      const deveLimparSessao = (
        codigoErro === DisconnectReason.loggedOut || 
        codigoErro === DisconnectReason.badSession ||
        codigoErro === 401
      )

      if (deveLimparSessao) {
        if (codigoErro === DisconnectReason.badSession) falhasBadSession++
        console.log('⚠️ Sessão encerrada/inválida — limpando...')
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          fs.mkdirSync(AUTH_DIR, { recursive: true })
        } catch {}
        ESTADO.codigo = null
        ESTADO.codigoEm = 0
        ciclosSemParear = 0
        falhasSeguidas = 0
        ultimoCodigoGerado = 0
      } else if (codigoErro === DisconnectReason.connectionReplaced) {
        substituicoes++
        console.log('⚠️ Outra instância assumiu a conexão')
      } else {
        falhasSeguidas++
      }

      const espera = Math.min(CONFIG.RECONNECT_DELAY * falhasSeguidas, 30000)
      console.log(`🔄 Reconectando em ${espera/1000}s... (tentativa ${falhasSeguidas})`)
      
      if (timerReconexao) clearTimeout(timerReconexao)
      timerReconexao = setTimeout(() => {
        iniciando = false
        iniciarBot()
      }, espera)
      return
    }

    if (connection === 'connecting') {
      ESTADO.status = 'conectando'
      
      const jaRegistrado = sock.authState.creds.registered
      if (jaRegistrado) {
        console.log('🔑 Usando credenciais salvas...')
        return
      }

      const agora = Date.now()
      if (ESTADO.codigo && (agora - ultimoCodigoGerado) < 60000) {
        console.log('📲 Código já foi gerado recentemente — aguardando...')
        return
      }

      if (ESTADO.codigo && (agora - ultimoCodigoGerado) >= 60000) {
        ciclosSemParear++
        console.log(`⏳ Código anterior expirou (${ciclosSemParear}x sem parear) — gerando novo...`)
      }

      ultimoCodigoGerado = agora
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(telefone)
          ESTADO.codigo = codigo
          ESTADO.codigoEm = Date.now()
          console.log('\n' + '═'.repeat(55))
          console.log('📲 CÓDIGO DE PAREAMENTO: ' + codigo)
          console.log('👉 WhatsApp → Configurações → Aparelhos Conectados')
          if (CONFIG.PAIRING_TOKEN) {
            console.log(`🔗 Ver código online: ${process.env.RENDER_EXTERNAL_URL || ''}/codigo?token=${CONFIG.PAIRING_TOKEN}`)
          }
          console.log('═'.repeat(55) + '\n')
        } catch (erro) {
          ESTADO.codigo = null
          console.error(`❌ Erro ao gerar código: ${erro.message}`)
          ultimoCodigoGerado = 0
        }
      }, 2000)
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const remetente = msg.key.remoteJid
    const ehGrupo = isJidGroup(remetente)

    // 🚫 Ignora GIFs
    if (ehGif(msg)) {
      console.log(`🖼️ GIF detectado — ignorando ✅`)
      return
    }

    const textoCompleto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const textoLimpo = textoCompleto.trim()
    const textoMinusculo = textoLimpo.toLowerCase()

    // 🛡️ Sem gatilho = silêncio
    if (!textoMinusculo.startsWith(CONFIG.GATILHO)) return

    // 🔒 Bloqueio de grupo
    if (ehGrupo && GrupoManager.estaBloqueado(remetente)) {
      console.log(`🚫 Grupo bloqueado: ${remetente}`)
      return
    }

    const pergunta = textoLimpo.slice(CONFIG.GATILHO.length).trim()
    console.log(`💬 Pergunta: "${pergunta}"`)

    const responder = (txt) => sock.sendMessage(remetente, { text: txt }, { quoted: msg })
    const responderComImagem = async (txt, img) => {
      if (img) {
        try {
          await sock.sendMessage(remetente, {
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

Comandos de Grupo:
• ${CONFIG.GATILHO} bloquear grupo — IA para de responder aqui
• ${CONFIG.GATILHO} liberar grupo — IA volta a responder aqui

Outros comandos:
${CONFIG.GATILHO} !ajuda — Mostra isto
${CONFIG.GATILHO} !ping — Verifica se estou online
${CONFIG.GATILHO} !lista — Lista tópicos
${CONFIG.GATILHO} !gruposs — Ver grupos bloqueados
${CONFIG.GATILHO} !imagem [termo] — Mostra imagem
${CONFIG.GATILHO} !corrige pergunta = resposta — Me ensina 😊`)
          break

        case 'ping':
          await responder('🏓 Pong! Online e pronto pra te ajudar! 🎮')
          break

        case 'lista':
          const itens = [...EmuladorBase.dados.keys()]
          await responder(`📚 ${EmuladorBase.contar()} tópicos:\n\n${itens.map((k,i)=>`${i+1}. ${k}`).join('\n')}`)
          break

        case 'gruposs':
          const bloqueados = GrupoManager.listarBloqueados()
          if (bloqueados.length === 0) {
            await responder(`✅ Nenhum grupo está bloqueado no momento!`)
          } else {
            await responder(`🔒 Grupos bloqueados (${bloqueados.length}):\n${bloqueados.map(g=>`• ${g}`).join('\n')}`)
          }
          break

        case 'bloquear':
          if (ehGrupo && (args === 'grupo' || args === '')) {
            GrupoManager.bloquear(remetente)
            await responder(`🔒 Este grupo foi BLOQUEADO!\nNão vou mais responder mensagens aqui.\n\nPara liberar: ${CONFIG.GATILHO} liberar grupo`)
            console.log(`🔒 Grupo bloqueado: ${remetente}`)
          } else if (!ehGrupo) {
            await responder(`⚠️ Esse comando só funciona em grupos!`)
          }
          break

        case 'liberar':
          if (ehGrupo && (args === 'grupo' || args === '')) {
            GrupoManager.liberar(remetente)
            await responder(`🔓 Este grupo foi LIBERADO!\nAgora vou responder normalmente!\n\nPara bloquear: ${CONFIG.GATILHO} bloquear grupo`)
            console.log(`🔓 Grupo liberado: ${remetente}`)
          } else if (!ehGrupo) {
            await responder(`⚠️ Esse comando só funciona em grupos!`)
          }
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

    // 🔒 Comandos diretos
    if (pergunta === 'bloquear grupo') {
      if (ehGrupo) {
        GrupoManager.bloquear(remetente)
        await responder(`🔒 Grupo BLOQUEADO! Não vou mais responder aqui.\nPara liberar: ${CONFIG.GATILHO} liberar grupo`)
        return
      } else {
        await responder(`⚠️ Só funciona em grupos!`)
        return
      }
    }
    if (pergunta === 'liberar grupo') {
      if (ehGrupo) {
        GrupoManager.liberar(remetente)
        await responder(`🔓 Grupo LIBERADO! Voltando a responder normalmente.`)
        return
      } else {
        await responder(`⚠️ Só funciona em grupos!`)
        return
      }
    }

    // 💬 Processa pergunta
    await sock.readMessages([msg.key])
    const resultado = await processarMensagem(pergunta)
    await responderComImagem(resultado.texto, resultado.imagem)
  })
}

// 🚨 Tratamento de erros
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro fatal:', err.message)
  ESTADO.status = 'erro'
  if (timerReconexao) clearTimeout(timerReconexao)
  setTimeout(() => {
    iniciando = false
    iniciarBot()
  }, 5000)
})

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Rejeição não tratada:', reason?.message || reason)
})

// 🚀 Inicia
iniciarBot().catch(err => {
  console.error('❌ Falha crítica:', err.message)
  iniciando = false
  setTimeout(iniciarBot, 10000)
})
