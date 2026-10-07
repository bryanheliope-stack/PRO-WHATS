import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { useMongoAuthState, flushAuthWrites } from './mongoAuth.js'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from './baileys.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 📂 Pasta temporária para arquivos
const TEMP_DIR = path.join(__dirname, 'temp_files')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })

// Servidor mínimo
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Bot online - funcionando!')
  })
  .listen(process.env.PORT || 3000, () => {
    console.log(`🌐 Servidor rodando na porta ${process.env.PORT || 3000}`)
  })

// Auto-ping
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL).catch((error) => console.log('🔄 Auto-ping falhou:', error.message))
  }, 10 * 60 * 1000)
}

// Variáveis de ambiente
const {
  PHONE_NUMBER,
  AI_PROVIDER = 'openrouter',
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL = 'deepseek-chat',
  NVIDIA_API_KEY,
  NVIDIA_MODEL = 'google/gemma-2-27b-it,meta/llama-3.1-70b-instruct',
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'openrouter/free',
  TRIGGER = 'nexos',
  COOLDOWN = '2',
  MONGODB_URI,
  RESET_SESSION,
  MODEL_COOLDOWN_MS = '300000',
  MODEL_RETRIES = '2',
  AI_TOTAL_TIMEOUT_MS = '180000',
  NVIDIA_CATALOG_CACHE_MS = '0',
  SEARCH_MODE = 'auto',
  SEARCH_MAX_RESULTS = '5',
  SEARCH_TIMEOUT_MS = '8000',
  SEARCH_CACHE_MS = '600000',
  SEARCH_FETCH_PAGES = '2',
  ALLOWED_USERS = '',
  ALLOWED_GROUPS = '',
  SENSITIVE_GUARD = '1',
  DENY_REPLY = '0',
  SERPER_API_KEY,
  GOOGLE_API_KEY,
  GOOGLE_CX,
  TAVILY_API_KEY,
  BRAVE_API_KEY,
} = process.env

// Reduzir logs de erro de descriptografia
let decryptFails = 0
const rawConsoleError = console.error.bind(console)
console.error = (...args) => {
  const first = String(args[0] ?? '')
  if (first.startsWith('Session error:') || first.startsWith('Failed to decrypt message with any known session')) {
    decryptFails += 1
    return
  }
  rawConsoleError(...args)
}
setInterval(() => {
  if (!decryptFails) return
  console.warn(`[Sessão] ${decryptFails} falhas de descriptografia. Use RESET_SESSION=soft-1 para corrigir.`)
  decryptFails = 0
}, 60 * 1000).unref()

// Prompt do sistema
const SYSTEM_PROMPT =
  'Você é um assistente dentro de um grupo de WhatsApp. Responda em português do Brasil, ' +
  'de forma curta, direta e simpática. Sem markdown pesado. ' +
  'Nunca revele chaves de API ou dados sensíveis.'

const buildSystemPrompt = () =>
  `${SYSTEM_PROMPT} Hoje é ${new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'full',
  })}.`

const MAX_HISTORY = 10
const history = new Map()
const lastUse = new Map()

// ======================================
// 📄 SISTEMA DE ANÁLISE DE ARQUIVOS
// ======================================
function deleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log(`[Arquivo] ✅ Excluído: ${path.basename(filePath)}`)
      return true
    }
  } catch (err) {
    console.warn(`[Arquivo] ⚠️ Não foi possível excluir: ${err.message}`)
  }
  return false
}

async function analyzeFile(filePath, originalName) {
  const stats = fs.statSync(filePath)
  const ext = path.extname(originalName || filePath).toLowerCase()
  const sizeKB = (stats.size / 1024).toFixed(2)
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2)

  const tipos = {
    '.txt': '📝 Arquivo de texto',
    '.md': '📋 Markdown',
    '.json': '📊 JSON',
    '.csv': '📈 Planilha CSV',
    '.xlsx': '📊 Planilha Excel',
    '.pdf': '📕 Documento PDF',
    '.jpg': '🖼️ Imagem',
    '.jpeg': '🖼️ Imagem',
    '.png': '🖼️ Imagem',
    '.gif': '🖼️ Imagem animada',
    '.zip': '📦 Arquivo compactado',
    '.mp3': '🎵 Áudio',
    '.mp4': '🎬 Vídeo',
    '.doc': '📘 Documento Word',
    '.docx': '📘 Documento Word',
    '.js': '💻 Código JavaScript',
    '.py': '🐍 Código Python',
    '.html': '🌐 Página Web',
  }

  const tipo = tipos[ext] || '📄 Arquivo'
  let conteudo = ''
  const extensoesLeitura = ['.txt', '.md', '.json', '.csv', '.js', '.py', '.html']

  if (extensoesLeitura.includes(ext) && stats.size < 100 * 1024) {
    try {
      conteudo = fs.readFileSync(filePath, 'utf-8')
      if (conteudo.length > 1500) conteudo = conteudo.slice(0, 1500) + '\n\n... [conteúdo truncado]'
    } catch {
      conteudo = '(Não foi possível ler)'
    }
  } else if (extensoesLeitura.includes(ext)) {
    conteudo = '(Arquivo muito grande)'
  } else {
    conteudo = '(Arquivo binário)'
  }

  return {
    nome: originalName,
    tipo,
    extensao: ext || 'sem extensão',
    tamanho: sizeMB < 1 ? `${sizeKB} KB` : `${sizeMB} MB`,
    modificado: stats.mtime.toLocaleString('pt-BR'),
    conteudo,
  }
}

async function processarArquivo(msg) {
  const tiposMidia = ['documentMessage', 'imageMessage', 'videoMessage', 'audioMessage']
  let tipoMidia = tiposMidia.find((t) => msg.message[t])
  if (!tipoMidia) return null

  const midia = msg.message[tipoMidia]
  const nomeArquivo = midia.fileName || `arquivo_${Date.now()}`
  const caminhoArquivo = path.join(TEMP_DIR, `${Date.now()}_${nomeArquivo}`)

  try {
    console.log(`[Arquivo] 📥 Baixando: ${nomeArquivo}`)
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: currentSock.updateMediaMessage })
    fs.writeFileSync(caminhoArquivo, buffer)
    const analise = await analyzeFile(caminhoArquivo, nomeArquivo)
    deleteFile(caminhoArquivo)
    return analise
  } catch (erro) {
    console.error(`[Arquivo] ❌ Erro: ${erro.message}`)
    deleteFile(caminhoArquivo)
    return { erro: erro.message }
  }
}

// ======================================
// FUNÇÕES AUXILIARES
// ======================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const positiveNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
function createError(message, status) {
  const error = new Error(message)
  if (status) error.status = status
  return error
}
function errorStatus(error) {
  return error?.status || error?.cause?.status || error?.response?.status
}
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
function retryable(error) {
  const status = errorStatus(error)
  return !status || RETRYABLE_STATUS.has(status)
}
function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now())
}

const TOTAL_TIMEOUT = positiveNumber(AI_TOTAL_TIMEOUT_MS, 180000)
const MODEL_TIMEOUT = Math.min(40000, TOTAL_TIMEOUT)
const FAILURE_COOLDOWN = positiveNumber(MODEL_COOLDOWN_MS, 300000)
const RETRIES_PER_MODEL = Math.max(1, Math.floor(positiveNumber(MODEL_RETRIES, 2)))

async function httpFail(name, res) {
  let body = ''
  try { body = await res.text() } catch {}
  return createError(`${name} ${res.status}: ${body.slice(0, 500)}`, res.status)
}

const unavailableUntil = new Map()
function markUnavailable(provider, model, error) {
  const status = errorStatus(error)
  const cooldown = status && !retryable(error) ? Math.max(FAILURE_COOLDOWN, 15 * 60 * 1000) : FAILURE_COOLDOWN
  unavailableUntil.set(`${provider}:${model}`, Date.now() + cooldown)
  console.warn(`[IA] ${provider}/${model} indisponível por ${Math.ceil(cooldown / 60000)} min: ${error?.message}`)
}
function clearUnavailable(provider, model) {
  unavailableUntil.delete(`${provider}:${model}`)
}
function availableNow(provider, model) {
  const until = unavailableUntil.get(`${provider}:${model}`) || 0
  if (until <= Date.now()) {
    unavailableUntil.delete(`${provider}:${model}`)
    return true
  }
  return false
}

// ======================================
// 🤖 PROVEDORES DE IA (INCLUINDO OPENROUTER)
// ======================================
async function askOpenAICompat(name, url, key, model, messages, timeoutMs, extraHeaders = {}) {
  if (!key) throw createError(`Chave da ${name} não configurada`, 401)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) throw await httpFail(`${name}/${model}`, res)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw createError(`${name}/${model} retornou resposta vazia`, 502)
  }
  return content.trim()
}

async function tryModels(providerName, models, requestFn, deadline) {
  const modelList = models.filter(Boolean)
  if (!modelList.length) throw createError(`Nenhum modelo configurado para ${providerName}`, 500)

  let lastError
  for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
    for (const model of modelList) {
      if (remainingTime(deadline) <= 0) throw createError('Tempo esgotado', 408)
      if (!availableNow(providerName, model)) continue

      try {
        console.log(`[IA] tentando ${providerName}/${model} (tentativa ${attempt}/${RETRIES_PER_MODEL})`)
        const answer = await requestFn(model, Math.min(MODEL_TIMEOUT, remainingTime(deadline)))
        clearUnavailable(providerName, model)
        console.log(`[IA] ✅ Resposta de ${providerName}/${model}`)
        return answer
      } catch (error) {
        lastError = error
        console.warn(`[IA] ${providerName}/${model} falhou: ${error.message}`)
        markUnavailable(providerName, model, error)
      }
    }
    if (attempt < RETRIES_PER_MODEL && remainingTime(deadline) > 2000) {
      console.log(`[IA] Pausa de 2s antes de tentar novamente...`)
      await sleep(2000)
    }
  }
  throw lastError || createError(`${providerName}: todos os modelos falharam`, 503)
}

// NVIDIA
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_MODELS = NVIDIA_MODEL.split(',').map((m) => m.trim()).filter(Boolean)

const nvidia = {
  key: NVIDIA_API_KEY,
  async ask(messages, deadline) {
    if (!NVIDIA_API_KEY) throw createError('NVIDIA_API_KEY não configurada', 401)
    return tryModels('NVIDIA', NVIDIA_MODELS, (model, t) =>
      askOpenAICompat(
        'NVIDIA',
        `${NVIDIA_BASE_URL}/chat/completions`,
        NVIDIA_API_KEY,
        model,
        messages,
        t
      ), deadline
    )
  },
}

// DeepSeek
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODELS = DEEPSEEK_MODEL.split(',').map((m) => m.trim()).filter(Boolean)

const deepseek = {
  key: DEEPSEEK_API_KEY,
  async ask(messages, deadline) {
    if (!DEEPSEEK_API_KEY) throw createError('DEEPSEEK_API_KEY não configurada', 401)
    return tryModels('DeepSeek', DEEPSEEK_MODELS, (model, t) =>
      askOpenAICompat('DeepSeek', DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY, model, messages, t), deadline
    )
  },
}

// 🌟 OPENROUTER (SISTEMA SECUNDÁRIO - MODELOS GRATUITOS)
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS = OPENROUTER_MODEL.split(',').map((m) => m.trim()).filter(Boolean)

const openrouter = {
  key: OPENROUTER_API_KEY,
  async ask(messages, deadline) {
    if (!OPENROUTER_API_KEY) throw createError('OPENROUTER_API_KEY não configurada — pegue em openrouter.ai/keys', 401)
    return tryModels('OpenRouter', OPENROUTER_MODELS, (model, t) =>
      askOpenAICompat('OpenRouter', OPENROUTER_URL, OPENROUTER_API_KEY, model, messages, t, {
        'HTTP-Referer': SELF_URL || 'https://localhost',
        'X-OpenRouter-Title': 'WhatsApp AI Bot',
      }), deadline
    )
  },
}

// Provedores em ordem de prioridade
const providers = { nvidia, deepseek, openrouter }

async function askAI(messages) {
  const preferred = String(AI_PROVIDER || 'openrouter').toLowerCase()
  const order = [preferred, ...Object.keys(providers).filter((p) => p !== preferred)]
    .filter((name, i, arr) => arr.indexOf(name) === i && providers[name]?.key)

  if (!order.length) throw new Error('Nenhuma chave de IA configurada. Configure OPENROUTER_API_KEY.')

  const deadline = Date.now() + TOTAL_TIMEOUT
  let lastError

  for (const name of order) {
    if (remainingTime(deadline) <= 0) break
    try {
      console.log(`[IA] Tentando provedor: ${name}`)
      return await providers[name].ask(messages, deadline)
    } catch (error) {
      lastError = error
      console.error(`[IA] ❌ ${name} falhou: ${error.message}`)
      if (name !== order[order.length - 1]) console.log(`[IA] ⏳ Alternando para próximo provedor...`)
    }
  }

  throw lastError || createError(`Todos os provedores falharam. Tempo limite: ${TOTAL_TIMEOUT}ms`, 503)
}

// ======================================
// PESQUISA NA WEB (simplificada)
// ======================================
const SEARCH_MODE_NORM = String(SEARCH_MODE).toLowerCase()
const SEARCH_MAX = Math.min(8, Math.max(1, Number(SEARCH_MAX_RESULTS) || 5))
const SEARCH_TIMEOUT = Number(SEARCH_TIMEOUT_MS) || 8000
const SEARCH_CACHE = Number(SEARCH_CACHE_MS) || 600000
const searchCache = new Map()

async function searchDuckDuckGo(query) {
  try {
    const url = new URL('https://html.duckduckgo.com/html/')
    url.searchParams.set('q', query)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    })
    if (!res.ok) return []
    const html = await res.text()
    const results = []
    const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    let match
    while ((match = regex.exec(html)) !== null && results.length < SEARCH_MAX) {
      results.push({ title: match[2].replace(/<[^>]*>/g, '').trim(), url: match[1] })
    }
    return results
  } catch {
    return []
  }
}

async function webSearch(query) {
  if (!query || SEARCH_MODE_NORM === 'off') return []
  const cached = searchCache.get(query.toLowerCase())
  if (cached && cached.expiresAt > Date.now()) return cached.results

  const results = await searchDuckDuckGo(query)
  if (results.length) {
    searchCache.set(query.toLowerCase(), { results, expiresAt: Date.now() + SEARCH_CACHE })
    console.log(`[Busca] ${results.length} resultados para: "${query}"`)
  }
  return results
}

// ======================================
// SEGURANÇA E PERMISSÕES
// ======================================
const getText = (m) =>
  m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || ''
const digits = (jid = '') => jid.split('@')[0].split(':')[0]
const parseList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean)
const onlyDigits = (v) => String(v || '').replace(/\D/g, '')

function brVariants(id) {
  const out = new Set([id])
  const m = id.match(/^(55\d{2})9?(\d{8})$/)
  if (m) { out.add(`${m[1]}9${m[2]}`); out.add(`${m[1]}${m[2]}`) }
  return out
}

const ALLOWED_USER_IDS = new Set(
  parseList(ALLOWED_USERS).flatMap((x) => [...brVariants(onlyDigits(x))]).filter(Boolean)
)
const ALLOWED_GROUP_IDS = new Set(parseList(ALLOWED_GROUPS).map((x) => x.split('@')[0]))

if (!ALLOWED_USER_IDS.size) {
  console.warn('[Segurança] ⚠️ ALLOWED_USERS vazio: QUALQUER pessoa pode usar o bot! Configure essa variável.')
}

const senderIds = (msg) =>
  [msg.key.participant, msg.participant].filter(Boolean).map(digits).filter(Boolean)

const userAllowed = (ids) =>
  !ALLOWED_USER_IDS.size || ids.some((id) => [...brVariants(id)].some((v) => ALLOWED_USER_IDS.has(v)))

const groupAllowed = (chatId) =>
  !ALLOWED_GROUP_IDS.size || ALLOWED_GROUP_IDS.has(chatId.split('@')[0])

const SENSITIVE_PATTERNS = [
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
  /sk-|nvapi-|ghp_|gho_|xox[bp]-|AIza[a-zA-Z0-9_-]{16,}/,
  /mongodb(\+srv)?:\/\//i,
]
function findSensitive(text) {
  return SENSITIVE_PATTERNS.some((re) => re.test(text))
}

// ======================================
// CONEXÃO WHATSAPP
// ======================================
let mongoCol
let currentSock
let shuttingDown = false

async function getAuth() {
  if (!MONGODB_URI) {
    console.log('[Auth] Usando arquivos locais para sessão (pasta ./auth)')
    return useMultiFileAuthState('./auth')
  }
  if (!mongoCol) {
    const uri = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
      console.error('❌ MONGODB_URI inválida')
      process.exit(1)
    }
    const client = new MongoClient(uri)
    await client.connect()
    mongoCol = client.db('whatsapp_bot').collection('auth')

    if (RESET_SESSION) {
      const meta = client.db('whatsapp_bot').collection('meta')
      const done = await meta.findOne({ _id: 'reset-session' })
      if (done?.token !== RESET_SESSION) {
        if (RESET_SESSION.toLowerCase().startsWith('soft')) {
          const r = await mongoCol.deleteMany({ _id: { $regex: '^(session|sender-key)-' } })
          console.log(`[Sessão] Reset leve: ${r.deletedCount} itens`)
        } else {
          await mongoCol.deleteMany({})
          console.log('[Sessão] Reset completo — pareie novamente')
        }
        await meta.updateOne({ _id: 'reset-session' }, { $set: { token: RESET_SESSION } }, { upsert: true })
      }
    }
  }
  return useMongoAuthState(mongoCol)
}

async function start() {
  try {
    const { state, saveCreds } = await getAuth()
    const { version } = await fetchLatestBaileysVersion()
    console.log(`[Baileys] Versão: ${version.join('.')}`)

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      markOnlineOnConnect: false,
    })
    currentSock = sock

    if (!sock.authState.creds.registered) {
      if (!PHONE_NUMBER) {
        console.error('❌ Defina PHONE_NUMBER nas variáveis de ambiente!')
        process.exit(1)
      }
      await sleep(3000)
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      console.log('\n=====================================')
      console.log(`📲 Código de pareamento: ${code}`)
      console.log('👉 Abra o WhatsApp > Aparelhos conectados > Conectar com número')
      console.log('=====================================\n')
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        console.log('✅ Bot CONECTADO no WhatsApp!')
      }
      if (connection === 'close' && !shuttingDown) {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.connectionReplaced) {
          console.warn('[Conexão] Substituída — reconectando em 60s...')
          setTimeout(start, 60000)
        } else if (code === DisconnectReason.loggedOut) {
          console.log('[Conexão] Desconectado — reiniciando em 5s...')
          mongoCol = null
          setTimeout(start, 5000)
        } else {
          console.log('[Conexão] Caiu — reconectando em 3s...')
          setTimeout(start, 3000)
        }
      }
    })

    // Mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue
          const chatId = msg.key.remoteJid
          if (!chatId?.endsWith('@g.us')) continue

          const text = getText(msg.message).trim()
          const botNumber = digits(sock.user?.id)
          const mentioned =
            msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some(
              (jid) => digits(jid) === botNumber
            ) ?? false
          const hasPrefix = text.toLowerCase().startsWith(TRIGGER.toLowerCase())

          // Processa arquivo se houver
          const analiseArquivo = await processarArquivo(msg)
          if (analiseArquivo && (hasPrefix || mentioned || text)) {
            let respostaArquivo = `📁 **Análise do Arquivo**\n\n`
            respostaArquivo += `📝 Nome: ${analiseArquivo.nome}\n`
            respostaArquivo += `📂 Tipo: ${analiseArquivo.tipo}\n`
            respostaArquivo += `📏 Tamanho: ${analiseArquivo.tamanho}\n`
            if (analiseArquivo.conteudo) {
              respostaArquivo += `\n📄 Conteúdo:\n${analiseArquivo.conteudo}`
            }
            await sock.sendMessage(chatId, { text: respostaArquivo }, { quoted: msg })
            if (!text && !mentioned) continue
          }

          if (!hasPrefix && !mentioned && !analiseArquivo) continue
          if (!groupAllowed(chatId)) continue

          const ids = senderIds(msg)
          console.log(`[${new Date().toLocaleTimeString('pt-BR')}] De: ${ids.join('/')} | Grupo: ${chatId.split('@')[0]}`)

          // Comando: meu ID
          if (text.trim().toLowerCase() === 'meuid' || text.trim().toLowerCase() === `${TRIGGER} meuid`) {
            await sock.sendMessage(chatId,
              { text: `🆔 Seu ID: ${ids.join(' / ') || 'Desconhecido'}\n👥 Grupo: ${chatId.split('@')[0]}` },
              { quoted: msg }
            )
            continue
          }

          if (!userAllowed(ids)) {
            console.log(`[Segurança] Acesso negado para: ${ids.join('/')}`)
            if (DENY_REPLY === '1') {
              await sock.sendMessage(chatId,
                { text: '🔒 Você não tem permissão para usar este bot.' },
                { quoted: msg }
              )
            }
            continue
          }

          let question = text
            .slice(hasPrefix ? TRIGGER.length : 0)
            .replace(/@\d+\s*/g, '')
            .trim()

          const quotedText = getText(
            msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          ).trim()
          if (quotedText) {
            question = question ? `${question}\n\n(Mensagem citada: ${quotedText})` : quotedText
          }

          if (analiseArquivo) {
            question = `[Arquivo: ${analiseArquivo.nome} - ${analiseArquivo.tipo}]\n${analiseArquivo.conteudo || ''}\n\nPergunta: ${question || 'Analise este arquivo'}`
          }

          if (!question) {
            await sock.sendMessage(chatId,
              { text: `Fala! 😄 Use *${TRIGGER}* + sua pergunta. Exemplo:\n${TRIGGER} quanto está o dólar hoje?` },
              { quoted: msg }
            )
            continue
          }

          // Bloqueio de dados sensíveis
          if (SENSITIVE_GUARD === '1' && findSensitive(question)) {
            await sock.sendMessage(chatId,
              { text: '⚠️ Detectei dados sensíveis na mensagem. Por segurança, não enviei para a IA. Remova e tente novamente.' },
              { quoted: msg }
            )
            continue
          }

          // Cooldown
          const sender = msg.key.participant || chatId
          const now = Date.now()
          if (now - (lastUse.get(sender) || 0) < Number(COOLDOWN) * 1000) {
            await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } })
            continue
          }
          lastUse.set(sender, now)

          await sock.sendPresenceUpdate('composing', chatId)

          const name = msg.pushName || 'Alguém'
          const chat = history.get(chatId) || []
          chat.push({ role: 'user', content: `${name}: ${question}` })

          // Pesquisa na web
          let searchResults = []
          if (question.length > 10 && SEARCH_MODE_NORM !== 'off') {
            searchResults = await webSearch(question)
            if (searchResults.length) {
              const searchContext = `\n\n[RESULTADOS DA PESQUISA]\n${searchResults.map((r, i) => `${i + 1}. ${r.title}\n${r.url}`).join('\n\n')}\n\nUse essas informações se forem úteis.`
              chat[chat.length - 1].content += searchContext
            }
          }

          const aiMessages = chat.slice(-MAX_HISTORY)
          let answer

          try {
            answer = await askAI(aiMessages)
            if (!answer || answer.length < 2) throw new Error('Resposta vazia')
            chat.push({ role: 'assistant', content: answer })
            history.set(chatId, chat.slice(-MAX_HISTORY))
          } catch (error) {
            console.error('[IA] Erro final:', error.message)
            answer = `😅 ${error.message}. Tente novamente em alguns instantes!`
          }

          await sock.sendMessage(chatId, { text: answer }, { quoted: msg })
          console.log(`[Bot] ✅ Resposta enviada — ${chatId.split('@')[0]}`)
          await sock.sendPresenceUpdate('paused', chatId)
        } catch (error) {
          console.error('[Mensagem] Erro ao processar:', error.message)
        }
      }
    })
  } catch (error) {
    console.error('[Inicialização] Erro:', error)
    console.log('🔄 Reiniciando em 5s...')
    setTimeout(start, 5000)
  }
}

// Inicia o bot
start().catch(console.error)

// Encerramento gracioso
process.on('SIGTERM', async () => {
  shuttingDown = true
  console.log('\n🛑 Encerrando...')
  if (mongoCol) await flushAuthWrites()
  process.exit(0)
})
