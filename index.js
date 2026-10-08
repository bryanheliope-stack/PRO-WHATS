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

// 📡 Estado da conexão
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
    } catch { return false }
  },
  bloquear(grupoJid) { this.bloqueados.add(grupoJid); this.salvar() },
  liberar(grupoJid) { this.bloqueados.delete(grupoJid); this.salvar() },
  estaBloqueado(grupoJid) { return this.bloqueados.has(grupoJid) },
  listarBloqueados() { return [...this.bloqueados] }
}
GrupoManager.carregar()

// ==========================================
// 🤖 SISTEMA DE IA
// ==========================================
const IA_Generativa = {
  cache: new Map(),
  async perguntarOpenRouter(pergunta) {
    if (!CONFIG.OPENROUTER_API_KEY) return null
    const cacheKey = `or:${pergunta.toLowerCase()}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)
    try {
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
            { role: 'system', content: 'Você é um assistente útil, amigável e direto. Responda em português.' },
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
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta/llama3-70b-instruct',
          messages: [
            { role: 'system', content: 'Você é um assistente útil, amigável e direto. Responda em português.' },
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
// 🏓 SISTEMA DE PING
// ==========================================
const PING_SYSTEM = {
  url: process.env.RENDER_EXTERNAL_URL || process.env.PING_URL || '',
  interval: CONFIG.PING_INTERVAL,
  timer: null,
  ultimoPing: null,
  async ping() {
    if (!this.url) return false
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, { signal: AbortSignal.timeout(20000) })
      this.ultimoPing = new Date().toLocaleTimeString('pt-BR')
      console.log(`🏓 Ping: ${res.ok ? '✅ ONLINE' : '⚠️ OK'} | ${Date.now() - inicio}ms`)
      return true
    } catch (err) {
      console.warn(`🏓 Ping falhou: ${err.message}`)
      return false
    }
  },
  iniciar() {
    if (!this.url) return
    console.log(`🏓 Ping a cada ${Math.round(this.interval/60000)}min`)
    this.ping()
    this.timer = setInterval(() => this.ping(), this.interval)
  }
}

// ==========================================
// 🖼️ SISTEMA DE IMAGENS
// ==========================================
const BuscaImagens = {
  cache: new Map(),
  async buscar(termo) {
    const cacheKey = termo.toLowerCase()
    if (this.cache.has(cacheKey)) return [this.cache.get(cacheKey)]
    try {
      const prompt = encodeURIComponent(`${termo}, interface limpa`)
      const img = {
        url: `https://image.pollinations.ai/prompt/${prompt}?width=800&height=600&nologo=true`,
        autor: 'Pollinations AI',
        pagina: 'https://pollinations.ai'
      }
      this.cache.set(cacheKey, img)
      if (this.cache.size > 50) this.cache.clear()
      return [img]
    } catch { return [] }
  }
}

// ==========================================
// 🧠 BASE DE CONHECIMENTO
// ==========================================
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const STOPWORDS = new Set(['de','do','da','no','na','em','um','uma','os','as','ou','se','eu','me','pra','para','com','que','qual','como','sobre','é','a','o','quem','onde','quando','por'])

const EmuladorBase = {
  dados: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),
  carregar() {
    this.inicializarBase()
    try {
      if (fs.existsSync(this.arquivo)) {
        const salvos = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        for (const [chave, valor] of Object.entries(salvos)) {
          if (valor.custom) this.dados.set(chave.toLowerCase(), valor)
        }
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao ler base: ${err.message}`)
    }
    this.salvar()
  },
  inicializarBase() {
    const base = {
      'winlator': { titulo: '🪟 Winlator', descricao: 'Roda jogos de Windows no Android', requisitos: 'Android 10+', site: 'winlator.dev', termoImagem: 'Winlator Android' },
      'gamehub': { titulo: '🎮 GameHub', descricao: 'Novo app da equipe do Winlator', requisitos: 'Android 10+', site: 'winlator.dev/gamehub', termoImagem: 'GameHub Android' },
      'eden': { titulo: '🔵 Eden — Emulador de Switch', descricao: 'Melhor emulador de Switch para Android', site: 'eden-emu.dev', termoImagem: 'Eden Emulator Switch' },
      'ppsspp': { titulo: '🎮 PPSSPP', descricao: 'Melhor emulador de PSP', site: 'ppsspp.org', termoImagem: 'PPSSPP emulator' }
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
  buscar(pergunta) {
    const resultados = []
    const perguntaNorm = normalizar(pergunta)
    const termos = perguntaNorm.split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t))
    for (const [chave, item] of this.dados) {
      let relevancia = 0
      const chaveNorm = normalizar(chave)
      if (chaveNorm === perguntaNorm) relevancia += 100
      else if (chaveNorm.includes(perguntaNorm)) relevancia += 50
      for (const termo of termos) {
        if (chaveNorm.includes(termo)) relevancia += 15
      }
      if (relevancia > 0) resultados.push({ chave, item, relevancia })
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, 5)
  }
}

// ==========================================
// 🧠 GERADOR DE RESPOSTAS
// ==========================================
const GeradorResposta = {
  gerar(item) {
    let r = ''
    if (item.titulo) r += `${item.titulo}\n\n`
    if (item.descricao) r += `${item.descricao}\n\n`
    if (item.requisitos) r += `📋 Requisitos: ${item.requisitos}\n\n`
    if (item.site) r += `🌐 ${item.site}\n`
    return r.trim()
  }
}

// ==========================================
// 💬 PROCESSADOR
// ==========================================
async function processarMensagem(pergunta) {
  const resultados = EmuladorBase.buscar(pergunta)
  if (resultados.length === 0) {
    const respostaIA = await IA_Generativa.perguntar(pergunta)
    if (respostaIA) return { tipo: 'ia', texto: respostaIA }
    return { tipo: 'nenhum', texto: `🤔 Não tenho isso. Tente: Winlator, GameHub, Eden, PPSSPP 😊` }
  }
  if (resultados.length === 1) {
    return { tipo: 'unico', texto: GeradorResposta.gerar(resultados[0].item), item: resultados[0].item }
  }
  let texto = `🔍 Encontrei ${resultados.length} coisas:\n\n`
  resultados.forEach((r, i) => texto += `${i + 1}. ${r.item.titulo || r.chave}\n`)
  texto += `\n👉 Me diga qual você quer ver!`
  return { tipo: 'multiplo', texto }
}

// ==========================================
// 🌐 SERVIDOR — CORRIGIDO PARA RENDER
// ==========================================
const PORT = process.env.PORT || 10000  // ✅ Render usa 10000 por padrão!
http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      whatsapp: ESTADO.status,
      conectado: ESTADO.conectado,
      base: EmuladorBase.dados.size,
      versao: '8.4-fix',
      gatilho: CONFIG.GATILHO,
      gruposBloqueados: GrupoManager.listarBloqueados().length
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
    if (ESTADO.conectado) res.end('✅ Já conectado!')
    else if (ESTADO.codigo) res.end(`📲 CÓDIGO: ${ESTADO.codigo}`)
    else res.end(`⏳ Aguardando código...`)
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Bot Online — Render Fix ✅')
  }
}).listen(PORT, '0.0.0.0', () => {  // ✅ Bind em 0.0.0.0 obrigatório no Render!
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP — CORRIGIDO
// ==========================================
let sockInstance = null
let iniciando = false
let timerReconexao = null
let falhasSeguidas = 0
let ultimoCodigoGerado = 0

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function ehGif(mensagem) {
  if (mensagem.gifPlayback || mensagem.message?.gifPlayback) return true
  if (mensagem.message?.videoMessage?.gifPlayback) return true
  return false
}

function validarTelefone(bruto) {
  const digitos = apenasDigitos(bruto)
  if (!digitos) return { ok: false, erro: 'Número vazio' }
  if (digitos.length < 10 || digitos.length > 15) return { ok: false, erro: `Número inválido: ${digitos.length} dígitos` }
  return { ok: true, digitos }
}

async function iniciarBot() {
  if (iniciando) return
  iniciando = true

  ESTADO.status = 'carregando'
  EmuladorBase.carregar()  // ✅ Movido para cá — antes de usar!

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const valido = validarTelefone(CONFIG.PHONE_NUMBER)
  if (!valido.ok) {
    console.error(`❌ PHONE_NUMBER: ${valido.erro}`)
    console.error('👉 Exemplo: 5511999999999')
    iniciando = false
    return
  }
  const telefone = valido.digitos

  const temSessao = fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
  if (temSessao) {
    console.log('🔑 Sessão encontrada — reconectando...')
  } else {
    console.log('📱 Nova sessão iniciada')
  }

  ESTADO.status = 'conectando'
  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false
  })

  sockInstance = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      ESTADO.status = 'conectado'
      ESTADO.conectado = true
      ESTADO.codigo = null
      falhasSeguidas = 0
      console.log('✅✅✅ CONECTADO AO WHATSAPP!')
      iniciando = false
      return
    }

    if (connection === 'close') {
      ESTADO.conectado = false
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — Código: ${codigoErro}`)

      const deveLimparSessao = (
        codigoErro === DisconnectReason.loggedOut || 
        codigoErro === DisconnectReason.badSession ||
        codigoErro === 401
      )

      if (deveLimparSessao) {
        console.log('⚠️ Sessão encerrada — limpando...')
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          fs.mkdirSync(AUTH_DIR, { recursive: true })
        } catch {}
        ESTADO.codigo = null
        ultimoCodigoGerado = 0
      }

      falhasSeguidas++
      const espera = Math.min(CONFIG.RECONNECT_DELAY * falhasSeguidas, 30000)
      console.log(`🔄 Reconectando em ${espera/1000}s...`)
      
      if (timerReconexao) clearTimeout(timerReconexao)
      timerReconexao = setTimeout(() => {
        iniciando = false
        iniciarBot()
      }, espera)
      return
    }

    if (connection === 'connecting') {
      ESTADO.status = 'conectando'
      
      if (sock.authState.creds.registered) {
        console.log('🔑 Usando credenciais salvas...')
        return
      }

      const agora = Date.now()
      if (ESTADO.codigo && (agora - ultimoCodigoGerado) < 120000) {  // ✅ 2 minutos antes de gerar outro
        console.log('📲 Código já gerado — aguardando...')
        return
      }

      ultimoCodigoGerado = agora
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(telefone)
          ESTADO.codigo = codigo
          ESTADO.codigoEm = agora
          console.log('\n' + '═'.repeat(50))
          console.log('📲 CÓDIGO DE PAREAMENTO: ' + codigo)
          console.log('👉 WhatsApp → Configurações → Aparelhos Conectados')
          if (CONFIG.PAIRING_TOKEN && process.env.RENDER_EXTERNAL_URL) {
            console.log(`🔗 Ver código: ${process.env.RENDER_EXTERNAL_URL}/codigo?token=${CONFIG.PAIRING_TOKEN}`)
          }
          console.log('⏳ Você tem 2 minutos para digitar antes de expirar!')
          console.log('═'.repeat(50) + '\n')
        } catch (erro) {
          ESTADO.codigo = null
          ultimoCodigoGerado = 0
          console.error(`❌ Erro ao gerar código: ${erro.message}`)
        }
      }, 3000)
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const remetente = msg.key.remoteJid
    const ehGrupo = isJidGroup(remetente)

    if (ehGif(msg)) return

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    if (!texto.trim().toLowerCase().startsWith(CONFIG.GATILHO)) return

    if (ehGrupo && GrupoManager.estaBloqueado(remetente)) return

    const pergunta = texto.trim().slice(CONFIG.GATILHO.length).trim()
    const responder = (txt) => sock.sendMessage(remetente, { text: txt }, { quoted: msg })

    if (!pergunta) {
      await responder('👋 Olá! Em que posso ajudar? 😊')
      return
    }

    if (pergunta === 'bloquear grupo' && ehGrupo) {
      GrupoManager.bloquear(remetente)
      await responder('🔒 Grupo BLOQUEADO! Não vou mais responder aqui.')
      return
    }
    if (pergunta === 'liberar grupo' && ehGrupo) {
      GrupoManager.liberar(remetente)
      await responder('🔓 Grupo LIBERADO! Voltando a responder.')
      return
    }
    if (pergunta === '!ajuda') {
      await responder(`📋 Comandos:
nexos bloquear grupo — bloqueia este grupo
nexos liberar grupo — libera este grupo
nexos !ping — verifica se estou online
nexos !gruposs — ver grupos bloqueados`)
      return
    }
    if (pergunta === '!ping') {
      await responder('🏓 Pong! Online! 🎮')
      return
    }
    if (pergunta === '!gruposs') {
      const lista = GrupoManager.listarBloqueados()
      await responder(lista.length === 0 
        ? '✅ Nenhum grupo bloqueado!'
        : `🔒 Grupos bloqueados:\n${lista.map(g=>`• ${g}`).join('\n')}`)
      return
    }

    const resultado = await processarMensagem(pergunta)
    if (resultado.tipo === 'unico' && resultado.item?.termoImagem) {
      const imgs = await BuscaImagens.buscar(resultado.item.termoImagem)
      if (imgs[0]) {
        try {
          await sock.sendMessage(remetente, {
            image: { url: imgs[0].url },
            caption: resultado.texto + `\n📸 ${imgs[0].autor}`
          }, { quoted: msg })
          return
        } catch {}
      }
    }
    await responder(resultado.texto)
  })
}

// 🚨 Tratamento de erros
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro fatal:', err.message)
  if (timerReconexao) clearTimeout(timerReconexao)
  setTimeout(() => {
    iniciando = false
    iniciarBot()
  }, 5000)
})

process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Rejeição:', reason?.message || reason)
})

// 🚀 Inicia
iniciarBot().catch(err => {
  console.error('❌ Falha crítica:', err.message)
  iniciando = false
  setTimeout(iniciarBot, 10000)
})
