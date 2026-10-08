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
function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

const CONFIG = {
  GATILHO: (process.env.GATILHO || 'nexos').toLowerCase(),
  PHONE_NUMBER: apenasDigitos(process.env.PHONE_NUMBER || ''),
  DONO_NUMERO: apenasDigitos(process.env.DONO_NUMERO || ''),
  PAIRING_TOKEN: process.env.PAIRING_TOKEN || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'openrouter/free',
  NVIDIA_MODEL: process.env.NVIDIA_MODEL || 'meta/llama3-70b-instruct',
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL || '240000'),
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000
}

console.log(`🤖 OpenRouter: ${CONFIG.OPENROUTER_MODEL}`)
console.log(`🤖 NVIDIA: ${CONFIG.NVIDIA_MODEL}`)

// 📡 Estado da conexão
const ESTADO = { status: 'iniciando', conectado: false, codigo: null, codigoEm: 0 }

console.log(`🔐 Gatilho: "${CONFIG.GATILHO}" — só respondo com essa palavra!`)
console.log(`🚫 Bloqueio de grupos: ✅ Ativado`)
console.log(`🖼️ Ignora GIFs: ✅ Ativado`)
if (CONFIG.DONO_NUMERO) console.log(`👑 Dono configurado: ✅`)

// ==========================================
// 🔐 VERIFICAÇÃO DE DONO
// ==========================================
function ehDono(usuarioJid) {
  if (!CONFIG.DONO_NUMERO) return true
  const usuario = apenasDigitos(usuarioJid || '')
  return usuario === CONFIG.DONO_NUMERO || usuario.includes(CONFIG.DONO_NUMERO)
}

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
// 🧠 BANCO DE DADOS VETORIAL + EMBEDDINGS
// ==========================================
class VectorStore {
  constructor() {
    this.documents = []
    this.cacheEmbeddings = new Map()
    this.apiEmbeddingDesativada = false
  }

  similaridadeCosseno(a, b) {
    if (a.length !== b.length) return 0
    let dot = 0, normaA = 0, normaB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normaA += a[i] * a[i]
      normaB += b[i] * b[i]
    }
    const den = Math.sqrt(normaA) * Math.sqrt(normaB)
    return den > 0 ? dot / den : 0
  }

  async gerarEmbedding(texto, tipo = 'passage') {
    // Se a API já falhou, usa só o método local (evita misturar vetores de tamanhos diferentes)
    if (!CONFIG.NVIDIA_API_KEY || this.apiEmbeddingDesativada) return this.embeddingSimples(texto)

    const cacheKey = `${tipo}:${texto.slice(0, 100)}`
    if (this.cacheEmbeddings.has(cacheKey)) return this.cacheEmbeddings.get(cacheKey)

    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: [texto],
          model: 'nvidia/nv-embedqa-e5-v5',
          input_type: tipo, // 'passage' para documentos, 'query' para perguntas
          encoding_format: 'float',
          truncate: 'END'
        }),
        signal: AbortSignal.timeout(20000)
      })

      if (!res.ok) throw new Error(`API ${res.status}`)
      const dados = await res.json()
      const vetor = dados.data[0].embedding
      this.cacheEmbeddings.set(cacheKey, vetor)
      if (this.cacheEmbeddings.size > 100) this.cacheEmbeddings.clear()
      return vetor
    } catch (err) {
      console.warn(`⚠️ Embedding API: ${err.message} — usando método local (desativada nesta sessão)`)
      this.apiEmbeddingDesativada = true
      return this.embeddingSimples(texto)
    }
  }

  embeddingSimples(texto) {
    const vetor = new Array(128).fill(0)
    const palavras = texto.toLowerCase().split(/\W+/).filter(p => p.length > 1)
    palavras.forEach((palavra, i) => {
      let hash = 0
      for (let c = 0; c < palavra.length; c++) {
        hash = ((hash << 5) - hash) + palavra.charCodeAt(c)
        hash |= 0
      }
      const idx = Math.abs(hash) % vetor.length
      vetor[idx] += Math.sin(i * 0.5 + Math.abs(hash) * 0.01)
    })
    const norma = Math.sqrt(vetor.reduce((s, v) => s + v * v, 0))
    return norma > 0 ? vetor.map(v => v / norma) : vetor
  }

  async adicionar(texto, metadados = {}) {
    const vetor = await this.gerarEmbedding(texto)
    this.documents.push({ id: crypto.randomUUID(), texto, metadados, vetor })
  }

  async buscar(pergunta, limite = 4) {
    if (this.documents.length === 0) return []
    const vetorPergunta = await this.gerarEmbedding(pergunta, 'query')
    return this.documents
      .map(doc => ({ ...doc, relevancia: this.similaridadeCosseno(vetorPergunta, doc.vetor) }))
      .sort((a, b) => b.relevancia - a.relevancia)
      .filter(r => r.relevancia > 0.25)
      .slice(0, limite)
  }

  async carregarBase() {
    console.log('📂 Carregando base de conhecimento...')
    const base = [
      { texto: 'Winlator é um aplicativo que permite rodar jogos de Windows no Android. Requer Android 10 ou superior. Site oficial: winlator.dev', fonte: 'winlator' },
      { texto: 'GameHub é um novo aplicativo desenvolvido pela mesma equipe do Winlator. Também roda jogos de Windows no Android e exige Android 10+. Disponível em: winlator.dev/gamehub', fonte: 'gamehub' },
      { texto: 'Eden é um emulador de Nintendo Switch para Android. É considerado atualmente o melhor emulador de Switch para celular. Site: eden-emu.dev', fonte: 'eden' },
      { texto: 'PPSSPP é o melhor emulador de PSP disponível para Android, Windows e outras plataformas. É gratuito e open source. Site oficial: ppsspp.org', fonte: 'ppsspp' }
    ]
    for (const item of base) await this.adicionar(item.texto, { fonte: item.fonte })
    console.log(`✅ Base carregada: ${base.length} documentos indexados`)
  }
}

const VectorDB = new VectorStore()
await VectorDB.carregarBase()

// ==========================================
// 🤖 SISTEMA DE GERAÇÃO — OpenRouter + NVIDIA Fallback
// ==========================================
const GeradorResposta = {
  cache: new Map(),

  async chamarOpenRouter(prompt) {
    if (!CONFIG.OPENROUTER_API_KEY) return null
    const modelo = CONFIG.OPENROUTER_MODEL
    
    try {
      console.log(`🤖 Usando OpenRouter: ${modelo}`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://localhost'
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            {
              role: 'system',
              content: `Você é um assistente útil, preciso e confiável. Responda SEMPRE em português.

📌 REGRAS:
1. Use APENAS as informações do CONTEXTO para responder
2. Se não tiver a informação, diga honestamente — não invente nada
3. Seja claro, direto e amigável`
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 800,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(30000)
      })
      
      if (!res.ok) throw new Error(`Status: ${res.status}`)
      const dados = await res.json()
      if (dados.error) throw new Error(dados.error.message)
      return dados.choices?.[0]?.message?.content
    } catch (err) {
      console.warn(`⚠️ OpenRouter (${modelo}) falhou: ${err.message}`)
      return null
    }
  },

  async chamarNVIDIA(prompt) {
    if (!CONFIG.NVIDIA_API_KEY) return null
    const modelo = CONFIG.NVIDIA_MODEL
    
    try {
      console.log(`🤖 Usando NVIDIA: ${modelo}`)
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            {
              role: 'system',
              content: `Você é um assistente útil, preciso e confiável. Responda SEMPRE em português. Use apenas as informações do contexto fornecido.`
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 800,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(30000)
      })
      
      if (!res.ok) throw new Error(`NVIDIA: ${res.status}`)
      const dados = await res.json()
      return dados.choices?.[0]?.message?.content
    } catch (err) {
      console.warn(`⚠️ NVIDIA falhou: ${err.message}`)
      return null
    }
  },

  async responder(pergunta) {
    const cacheKey = pergunta.toLowerCase().trim()
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    console.log(`\n📥 Pergunta: "${pergunta}"`)

    const resultados = await VectorDB.buscar(pergunta)
    console.log(`🔍 Encontrados: ${resultados.length} trecho(s) relevante(s)`)

    const contexto = resultados.length > 0
      ? resultados.map((r, i) => `[Fonte ${i+1}] ${r.texto}`).join('\n\n')
      : 'Nenhuma informação específica encontrada na base de dados.'

    const promptCompleto = `=== CONTEXTO ===
${contexto}
===============

Com base APENAS nas informações acima, responda: ${pergunta}`

    let resposta = await this.chamarOpenRouter(promptCompleto)
    
    if (!resposta) {
      console.log(`🔄 Alternando para NVIDIA...`)
      resposta = await this.chamarNVIDIA(promptCompleto)
    }

    if (!resposta) {
      if (resultados.length === 1) resposta = resultados[0].texto
      else if (resultados.length > 1) resposta = `🔍 Encontrei ${resultados.length} opções:\n\n` +
        resultados.map((r, i) => `${i + 1}. ${r.texto.split('\n')[0]}`).join('\n')
      else resposta = `🤔 Não tenho informações sobre isso. Tente: Winlator, GameHub, Eden ou PPSSPP 😊`
    }

    this.cache.set(cacheKey, resposta)
    if (this.cache.size > 50) this.cache.clear()
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
  async ping() {
    if (!this.url) return false
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, { signal: AbortSignal.timeout(20000) })
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
      const img = {
        url: `https://image.pollinations.ai/prompt/${encodeURIComponent(termo)}?width=800&height=600&nologo=true`,
        autor: 'Pollinations AI'
      }
      this.cache.set(cacheKey, img)
      if (this.cache.size > 50) this.cache.clear()
      return [img]
    } catch { return [] }
  }
}

// ==========================================
// 🌐 SERVIDOR
// ==========================================
const PORT = process.env.PORT || 10000
http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      whatsapp: ESTADO.status,
      conectado: ESTADO.conectado,
      documentosIndexados: VectorDB.documents.length,
      openRouterModel: CONFIG.OPENROUTER_MODEL,
      nvidiaModel: CONFIG.NVIDIA_MODEL,
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
    res.end('✅ Bot Online ✅')
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP
// ==========================================
let sockInstance = null
let iniciando = false
let timerReconexao = null
let falhasSeguidas = 0

function ehGif(mensagem) {
  return !!(mensagem.gifPlayback || mensagem.message?.gifPlayback || mensagem.message?.videoMessage?.gifPlayback)
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
    console.log('🔑 Sessão encontrada! Não precisa gerar código de novo ✅')
  } else {
    console.log('🔑 Nova sessão — será necessário parear uma vez só')
  }

  ESTADO.status = 'conectando'
  console.log(`📱 Conectando ao WhatsApp...`)
  
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
      console.log(`📊 Base vetorial: ${VectorDB.documents.length} documentos indexados`)
      iniciando = false
      return
    }

    if (connection === 'close') {
      ESTADO.conectado = false
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — Código: ${codigoErro || 'desconhecido'} | Motivo: ${DisconnectReason[codigoErro] || 'desconhecido'}`)

      if (codigoErro === DisconnectReason.loggedOut || codigoErro === DisconnectReason.badSession) {
        console.log(`⚠️ Sessão inválida/encerrada — excluindo sessão antiga...`)
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          fs.mkdirSync(AUTH_DIR, { recursive: true })
        } catch (e) {}
        console.log(`🔑 Sessão reiniciada — será necessário parear novamente`)
      }

      falhasSeguidas++
      const espera = codigoErro === DisconnectReason.restartRequired ? 0 : Math.min(5000 * falhasSeguidas, 30000)
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
      if (!sock.authState.creds.registered) {
        setTimeout(async () => {
          try {
            const codigo = await sock.requestPairingCode(telefone)
            ESTADO.codigo = codigo
            console.log('\n' + '═'.repeat(60))
            console.log(`📲 CÓDIGO DE PAREAMENTO: ${codigo}`)
            console.log(`👉 Abra o WhatsApp → Configurações → Aparelhos Conectados`)
            console.log(`⚠️  GUARDE ESTE CÓDIGO — SÓ PRECISA USAR UMA VEZ!`)
            console.log('═'.repeat(60) + '\n')
          } catch (erro) {
            console.error(`❌ Erro ao solicitar código: ${erro.message}`)
          }
        }, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const remetente = msg.key.remoteJid
    const ehGrupo = isJidGroup(remetente)
    const participante = msg.key.participant || remetente

    if (ehGif(msg)) return

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    if (!texto.trim().toLowerCase().startsWith(CONFIG.GATILHO)) return

    const pergunta = texto.trim().slice(CONFIG.GATILHO.length).trim()
    const responder = (txt) => sock.sendMessage(remetente, { text: txt }, { quoted: msg })

    if (!pergunta) {
      await responder('👋 Olá! Faça sua pergunta e eu buscarei nas informações disponíveis para você 😊')
      return
    }

    if (pergunta === 'bloquear grupo' && ehGrupo) {
      if (!ehDono(participante)) {
        await responder('🚫 Apenas o dono do bot pode bloquear grupos!')
        return
      }
      GrupoManager.bloquear(remetente)
      await responder('🔒 Grupo BLOQUEADO! Não vou mais responder aqui.')
      return
    }
    if (pergunta === 'liberar grupo' && ehGrupo) {
      if (!ehDono(participante)) {
        if (ehGrupo && GrupoManager.estaBloqueado(remetente)) return
        await responder('🚫 Apenas o dono do bot pode liberar grupos!')
        return
      }
      GrupoManager.liberar(remetente)
      await responder('🔓 Grupo LIBERADO! Voltando a responder.')
      return
    }

    if (pergunta === '!ajuda') {
      await responder(`📋 Comandos:
nexos bloquear grupo — 🔒 Bloqueia grupo (SÓ DONO)
nexos liberar grupo — 🔓 Libera grupo (SÓ DONO)
nexos !ping — 🏓 Verifica se estou online
nexos !gruposs — 🔒 Lista grupos bloqueados
nexos !limparcache — 🧹 Limpa cache da IA
nexos !status — 📊 Status do sistema`)
      return
    }
    if (pergunta === '!ping') {
      await responder('🏓 Pong! Online e funcionando! 🎮')
      return
    }
    if (pergunta === '!gruposs') {
      if (!ehDono(participante)) {
        await responder('🚫 Apenas o dono pode ver esta lista!')
        return
      }
      const lista = GrupoManager.listarBloqueados()
      await responder(lista.length === 0 
        ? '✅ Nenhum grupo bloqueado!'
        : `🔒 Grupos bloqueados:\n${lista.map(g=>`• ${g}`).join('\n')}`)
      return
    }
    if (pergunta === '!limparcache') {
      GeradorResposta.cache.clear()
      VectorDB.cacheEmbeddings.clear()
      await responder('✅ Cache limpo!')
      return
    }
    if (pergunta === '!status') {
      await responder(`📊 Status do Sistema:
✅ Online: Sim
📚 Documentos indexados: ${VectorDB.documents.length}
🤖 OpenRouter: ${CONFIG.OPENROUTER_MODEL}
🤖 NVIDIA: ${CONFIG.NVIDIA_MODEL}
🔒 Grupos bloqueados: ${GrupoManager.bloqueados.size}`)
      return
    }

    console.log(`💬 Pergunta recebida: "${pergunta}"`)
    const resposta = await GeradorResposta.responder(pergunta)
    await responder(resposta)
  })
}

process.on('uncaughtException', (err) => {
  console.error('🚨 Erro fatal:', err.message)
  if (timerReconexao) clearTimeout(timerReconexao)
  setTimeout(() => { iniciando = false; iniciarBot() }, 5000)
})

process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Rejeição não tratada:', reason?.message || reason)
})

iniciarBot().catch(err => {
  console.error('❌ Falha crítica:', err.message)
  iniciando = false
  setTimeout(iniciarBot, 10000)
})
