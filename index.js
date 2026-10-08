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
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL || '240000'),
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000,
  // 🎯 Modelos configuráveis
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'nousresearch/hermes-3-llama-3.1-405b',
  NVIDIA_MODEL: process.env.NVIDIA_MODEL || 'meta/llama3-70b-instruct',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'nvidia/embed-text-1024'
}

console.log(`🤖 Modelo OpenRouter: ${CONFIG.OPENROUTER_MODEL}`)
console.log(`🤖 Modelo NVIDIA: ${CONFIG.NVIDIA_MODEL}`)

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
// 🧠 PASSO 1: BANCO DE DADOS VETORIAL + EMBEDDINGS
// ==========================================
class VectorStore {
  constructor() {
    this.documents = [] // { id, texto, metadados, vetor }
    this.cacheEmbeddings = new Map()
  }

  // 📐 Calcula similaridade cosseno entre dois vetores
  similaridadeCosseno(a, b) {
    let dot = 0, normaA = 0, normaB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normaA += a[i] * a[i]
      normaB += b[i] * b[i]
    }
    return dot / (Math.sqrt(normaA) * Math.sqrt(normaB))
  }

  // 🔢 Gera embedding usando API da NVIDIA
  async gerarEmbedding(texto) {
    if (!CONFIG.NVIDIA_API_KEY) {
      // Fallback simples se não tiver chave da NVIDIA
      return this.embeddingSimples(texto)
    }
    
    const cacheKey = texto.slice(0, 100)
    if (this.cacheEmbeddings.has(cacheKey)) {
      return this.cacheEmbeddings.get(cacheKey)
    }

    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: texto,
          model: 'nvidia/embed-text-1024'
        }),
        signal: AbortSignal.timeout(20000)
      })
      
      if (!res.ok) throw new Error(`Embedding API: ${res.status}`)
      const dados = await res.json()
      const vetor = dados.data[0].embedding
      this.cacheEmbeddings.set(cacheKey, vetor)
      if (this.cacheEmbeddings.size > 100) this.cacheEmbeddings.clear()
      return vetor
    } catch (err) {
      console.warn(`⚠️ Embedding API falhou: ${err.message} — usando método local`)
      return this.embeddingSimples(texto)
    }
  }

  // 🛠️ Embedding simples baseado em hash (fallback confiável)
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
    // Normaliza
    const norma = Math.sqrt(vetor.reduce((s, v) => s + v * v, 0))
    return norma > 0 ? vetor.map(v => v / norma) : vetor
  }

  // 📥 Adiciona documento ao banco vetorial
  async adicionar(texto, metadados = {}) {
    const vetor = await this.gerarEmbedding(texto)
    this.documents.push({
      id: crypto.randomUUID(),
      texto,
      metadados,
      vetor
    })
  }

  // 🔍 PASSO 2: BUSCA SEMÂNTICA
  async buscar(pergunta, limite = 4) {
    if (this.documents.length === 0) return []
    
    const vetorPergunta = await this.gerarEmbedding(pergunta)
    
    const resultados = this.documents.map(doc => ({
      ...doc,
      relevancia: this.similaridadeCosseno(vetorPergunta, doc.vetor)
    }))
    
    return resultados
      .sort((a, b) => b.relevancia - a.relevancia)
      .filter(r => r.relevancia > 0.25) // Filtra resultados irrelevantes
      .slice(0, limite)
  }

  // 💾 Salva banco vetorial em arquivo
  salvar() {
    try {
      const arquivo = path.join(DATA_DIR, 'vector_store.json')
      fs.writeFileSync(arquivo, JSON.stringify({
        documentos: this.documents.map(d => ({
          texto: d.texto,
          metadados: d.metadados
        }))
      }, null, 2))
      return true
    } catch { return false }
  }

  // 📄 Carrega base de conhecimento
  carregarBase() {
    console.log('📂 Carregando base de conhecimento...')
    
    // Base padrão
    const base = [
      { texto: 'Winlator é um aplicativo que permite rodar jogos de Windows no Android. Requer Android 10 ou superior. Site oficial: winlator.dev', fonte: 'winlator' },
      { texto: 'GameHub é um novo aplicativo desenvolvido pela mesma equipe do Winlator. Também roda jogos de Windows no Android e exige Android 10+. Disponível em: winlator.dev/gamehub', fonte: 'gamehub' },
      { texto: 'Eden é um emulador de Nintendo Switch para Android. É considerado atualmente o melhor emulador de Switch para celular. Site: eden-emu.dev', fonte: 'eden' },
      { texto: 'PPSSPP é o melhor emulador de PSP disponível para Android, Windows e outras plataformas. É gratuito e open source. Site oficial: ppsspp.org', fonte: 'ppsspp' }
    ]

    base.forEach(item => this.adicionar(item.texto, { fonte: item.fonte }))
    console.log(`✅ Base carregada: ${base.length} documentos indexados`)
  }
}

// Inicializa banco vetorial
const VectorDB = new VectorStore()
VectorDB.carregarBase()

// ==========================================
// 🤖 SISTEMA DE GERAÇÃO — PASSO 3 e 4
// ==========================================
const GeradorResposta = {
  cache: new Map(),

  async chamarOpenRouter(prompt) {
    if (!CONFIG.OPENROUTER_API_KEY) return null
    
    try {
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
              content: `Você é um assistente útil, preciso e confiável. Responda SEMPRE em português.

📌 REGRAS IMPORTANTES:
1. Use APENAS as informações fornecidas no CONTEXTO abaixo para responder
2. Se a resposta não estiver no CONTEXTO, diga honestamente que não tem essa informação
3. Não invente fatos, nomes, versões ou dados que não estão no contexto
4. Seja claro, direto e amigável
5. Cite a fonte quando houver várias informações`
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 100,
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(45000)
      })
      
      if (!res.ok) throw new Error(`OpenRouter: ${res.status}`)
      const dados = await res.json()
      return dados.choices?.[0]?.message?.content
    } catch (err) {
      console.warn(`⚠️ OpenRouter falhou: ${err.message}`)
      return null
    }
  },

  async chamarNVIDIA(prompt) {
    if (!CONFIG.NVIDIA_API_KEY) return null
    
    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: CONFIG.NVIDIA_MODEL,
          messages: [
            {
              role: 'system',
              content: `Você é um assistente útil, preciso e confiável. Responda SEMPRE em português.

📌 REGRAS IMPORTANTES:
1. Use APENAS as informações fornecidas no CONTEXTO abaixo para responder
2. Se a resposta não estiver no CONTEXTO, diga honestamente que não tem essa informação
3. Não invente fatos, nomes, versões ou dados que não estão no contexto
4. Seja claro, direto e amigável`
            },
            { role: 'user', content: prompt }
          ],
          max_tokens: 1100,
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(45000)
      })
      
      if (!res.ok) throw new Error(`NVIDIA: ${res.status}`)
      const dados = await res.json()
      return dados.choices?.[0]?.message?.content
    } catch (err) {
      console.warn(`⚠️ NVIDIA falhou: ${err.message}`)
      return null
    }
  },

  // 🚀 FLUXO COMPLETO: RAG - Busca → Contexto → Geração
  async responder(pergunta) {
    const cacheKey = pergunta.toLowerCase().trim()
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    console.log(`\n📥 Pergunta: "${pergunta}"`)

    // PASSO 1: Busca semântica no banco vetorial
    const resultados = await VectorDB.buscar(pergunta)
    console.log(`🔍 Encontrados: ${resultados.length} trechos relevantes`)

    // PASSO 2: Monta o contexto
    let contexto = ''
    if (resultados.length > 0) {
      contexto = resultados.map((r, i) => 
        `[Fonte ${i+1}] ${r.texto}`
      ).join('\n\n')
    } else {
      contexto = 'Nenhuma informação específica encontrada na base de dados.'
    }

    // PASSO 3: Monta o prompt completo
    const promptCompleto = `=== CONTEXTO ===
${contexto}
===============

Com base APENAS nas informações acima, responda: ${pergunta}`

    // PASSO 4: Tenta OpenRouter primeiro, depois NVIDIA
    let resposta = await this.chamarOpenRouter(promptCompleto)
    
    if (!resposta) {
      console.log(`🔄 Usando NVIDIA como fallback...`)
      resposta = await this.chamarNVIDIA(promptCompleto)
    }

    // Fallback final: se não tiver IA, usa os dados brutos
    if (!resposta) {
      if (resultados.length > 0) {
        resposta = resultados.map(r => r.texto).join('\n\n')
      } else {
        resposta = `🤔 Não tenho informações sobre isso no momento. Tente perguntar sobre: Winlator, GameHub, Eden ou PPSSPP 😊`
      }
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
      const prompt = encodeURIComponent(`${termo}`)
      const img = {
        url: `https://image.pollinations.ai/prompt/${prompt}?width=800&height=600&nologo=true`,
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

    // 🔐 COMANDOS DE DONO
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

    // 🚫 Se o grupo está bloqueado e não é comando de dono → ignora
    if (ehGrupo && GrupoManager.estaBloqueado(remetente)) return

    // ✅ Comandos administrativos
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
🤖 Modelo OpenRouter: ${CONFIG.OPENROUTER_MODEL}
🤖 Modelo NVIDIA: ${CONFIG.NVIDIA_MODEL}
🔒 Grupos bloqueados: ${GrupoManager.bloqueados.size}`)
      return
    }

    // 🚀 FLUXO RAG COMPLETO
    console.log(`💬 Pergunta recebida: "${pergunta}"`)
    const resposta = await GeradorResposta.responder(pergunta)
    await responder(resposta)
  })
}

// 🚨 Tratamento de erros
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro fatal:', err.message)
  if (timerReconexao) clearTimeout(timerReconexao)
  setTimeout(() => { iniciando = false; iniciarBot() }, 5000)
})

process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Rejeição não tratada:', reason?.message || reason)
})

// 🚀 Iniciar o bot
iniciarBot().catch(err => {
  console.error('❌ Falha crítica:', err.message)
  iniciando = false
  setTimeout(iniciarBot, 10000)
})
