import pino from 'pino'
import http from 'node:http'
import { MongoClient } from 'mongodb'
import { useMongoAuthState } from './mongoAuth.js'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from './baileys.js'

// Servidor mínimo para manter a porta do Render aberta.
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('bot online')
  })
  .listen(process.env.PORT || 3000)

// Auto-ping opcional.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL).catch((error) =>
      console.log('auto-ping falhou:', error.message)
    )
  }, 10 * 60 * 1000)
}

const {
  PHONE_NUMBER,
  AI_PROVIDER = 'nvidia',
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL = 'deepseek-chat',
  NVIDIA_API_KEY,
  NVIDIA_MODEL = 'z-ai/glm-5.3-flash,z-ai/glm-5.3',
  TRIGGER = 'nexos',
  COOLDOWN = '2',
  MONGODB_URI,
  MODEL_COOLDOWN_MS = '300000',
  MODEL_RETRIES = '1',
  AI_TOTAL_TIMEOUT_MS = '180000',
  NVIDIA_CATALOG_CACHE_MS = '3600000',
  // --- NOVOS ---
  WEB_SEARCH_ENABLED = 'true',
  SEARCH_PROVIDER = 'auto', // auto | serper | tavily | duckduckgo
  SERPER_API_KEY,
  TAVILY_API_KEY,
  BRAVE_API_KEY,
} = process.env

const SYSTEM_PROMPT =
  'Você é um assistente dentro de um grupo de WhatsApp chamado Nexos. Responda em português do Brasil, ' +
  'de forma curta, direta e simpática. Sem markdown pesado (WhatsApp só suporta *negrito* e _itálico_). ' +
  'Quando receber CONTEXTO DA WEB, use-o para dar respostas atualizadas e cite a fonte de forma curta se for útil.'

const MAX_HISTORY = 20 // aumentado
const history = new Map()
const lastUse = new Map()

// ---------- IA ----------
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_MODELS_URL = `${NVIDIA_BASE_URL}/models`
const NVIDIA_FALLBACK_MODELS = NVIDIA_MODEL.split(',').map((x) => x.trim()).filter(Boolean)

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const unavailableUntil = new Map()
const modelCursor = new Map()
let nvidiaCatalogCache = { models: [], expiresAt: 0 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const positiveNumber = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const TOTAL_TIMEOUT = positiveNumber(AI_TOTAL_TIMEOUT_MS, 180000)
const MODEL_TIMEOUT = Math.min(40000, TOTAL_TIMEOUT)
const FAILURE_COOLDOWN = positiveNumber(MODEL_COOLDOWN_MS, 300000)
const RETRIES_PER_MODEL = Math.max(1, Math.floor(positiveNumber(MODEL_RETRIES, 1)))
const CATALOG_CACHE_TIME = positiveNumber(NVIDIA_CATALOG_CACHE_MS, 3600000)

function createError(message, status) {
  const error = new Error(message)
  if (status) error.status = status
  return error
}

function errorStatus(error) {
  return error?.status || error?.cause?.status || error?.response?.status
}

function retryable(error) {
  const status = errorStatus(error)
  return !status || RETRYABLE_STATUS.has(status)
}

async function httpFail(name, res) {
  let body = ''
  try {
    body = await res.text()
  } catch {}

  return createError(`${name} ${res.status}: ${body.slice(0, 500)}`, res.status)
}

function rotate(models, namespace) {
  if (models.length < 2) return models
  const start = (modelCursor.get(namespace) || 0) % models.length
  modelCursor.set(namespace, (start + 1) % models.length)
  return [...models.slice(start), ...models.slice(0, start)]
}

function modelKey(provider, model) {
  return `${provider}:${model}`
}

function markUnavailable(provider, model, error) {
  const status = errorStatus(error)
  const cooldown = status && !retryable(error)
    ? Math.max(FAILURE_COOLDOWN, 15 * 60 * 1000)
    : FAILURE_COOLDOWN

  unavailableUntil.set(modelKey(provider, model), Date.now() + cooldown)
  console.warn(
    `[IA] ${provider}/${model} indisponível por ${Math.ceil(cooldown / 60000)} min: ` +
      `${error?.message || error}`.slice(0, 300)
  )
}

function clearUnavailable(provider, model) {
  unavailableUntil.delete(modelKey(provider, model))
}

function availableNow(provider, model) {
  const key = modelKey(provider, model)
  const until = unavailableUntil.get(key) || 0
  if (until <= Date.now()) {
    unavailableUntil.delete(key)
    return true
  }
  return false
}

function remainingTime(deadline) {
  return Math.max(0, deadline - Date.now())
}

async function getNvidiaModels(deadline) {
  if (nvidiaCatalogCache.models.length && nvidiaCatalogCache.expiresAt > Date.now()) {
    return nvidiaCatalogCache.models
  }

  const timeLeft = remainingTime(deadline)
  if (timeLeft <= 0) throw createError('Tempo total da IA esgotado', 408)

  try {
    const res = await fetch(NVIDIA_MODELS_URL, {
      headers: { Authorization: `Bearer ${NVIDIA_API_KEY}` },
      signal: AbortSignal.timeout(Math.min(15000, timeLeft)),
    })

    if (!res.ok) throw await httpFail('NVIDIA catálogo', res)

    const data = await res.json()
    const discovered = Array.isArray(data?.data)
      ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.trim())
      : []

    const models = [...new Set([...NVIDIA_FALLBACK_MODELS, ...discovered])]
    if (!models.length) throw createError('Catálogo da NVIDIA retornou vazio', 502)

    nvidiaCatalogCache = {
      models,
      expiresAt: Date.now() + CATALOG_CACHE_TIME,
    }

    console.log(`[IA] catálogo NVIDIA carregado: ${models.length} modelos`)
    // persiste cache
    if (mongoDb) {
      await mongoDb.collection('bot_state').updateOne(
        { _id: 'nvidia_catalog' },
        { $set: { models, expiresAt: nvidiaCatalogCache.expiresAt, updatedAt: new Date() } },
        { upsert: true }
      ).catch(()=>{})
    }
    return models
  } catch (error) {
    // tenta restaurar do mongo
    if (mongoDb && !nvidiaCatalogCache.models.length) {
      try {
        const saved = await mongoDb.collection('bot_state').findOne({ _id: 'nvidia_catalog' })
        if (saved?.models?.length) {
          console.log('[IA] usando catálogo salvo no MongoDB')
          nvidiaCatalogCache = { models: saved.models, expiresAt: saved.expiresAt || Date.now()+CATALOG_CACHE_TIME }
          return saved.models
        }
      } catch {}
    }
    if (NVIDIA_FALLBACK_MODELS.length) {
      console.warn(
        `[IA] não foi possível atualizar o catálogo NVIDIA; usando a lista reserva: ${error.message}`
      )
      return NVIDIA_FALLBACK_MODELS
    }
    throw error
  }
}

async function askOpenAICompat(name, url, key, model, messages, timeoutMs) {
  if (!key) throw createError(`Chave da ${name} não configurada`, 401)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
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

async function tryModel(provider, model, messages, deadline, request) {
  let lastError

  for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
    const timeLeft = remainingTime(deadline)
    if (timeLeft <= 0) throw createError('Tempo total da IA esgotado', 408)

    try {
      console.log(`[IA] tentando ${provider}/${model} (${attempt}/${RETRIES_PER_MODEL})`)
      const answer = await request(model, messages, Math.min(MODEL_TIMEOUT, timeLeft))
      clearUnavailable(provider, model)
      console.log(`[IA] resposta obtida com ${provider}/${model}`)
      return answer
    } catch (error) {
      lastError = error
      console.error(`[IA] falha em ${provider}/${model}:`, error.message)

      if (retryable(error) && attempt < RETRIES_PER_MODEL && remainingTime(deadline) > 1000) {
        await sleep(Math.min(1000 * attempt, remainingTime(deadline)))
        continue
      }

      markUnavailable(provider, model, error)
      break
    }
  }

  throw lastError
}

async function askWithRotation({ provider, models, messages, deadline, request }) {
  const uniqueModels = [...new Set(models.map((x) => x.trim()).filter(Boolean))]
  if (!uniqueModels.length) throw createError(`Nenhum modelo configurado para ${provider}`, 500)

  let lastError
  let round = 0

  while (remainingTime(deadline) > 0) {
    round++
    const ordered = rotate(uniqueModels, provider)
    let candidates = ordered.filter((model) => availableNow(provider, model))

    if (!candidates.length) {
      candidates = ordered
      console.warn(`[IA] todos os modelos de ${provider} estão indisponíveis; iniciando nova rodada`)
    }

    for (const model of candidates) {
      if (remainingTime(deadline) <= 0) break
      try {
        return await tryModel(provider, model, messages, deadline, request)
      } catch (error) {
        lastError = error
      }
    }

    if (remainingTime(deadline) <= 0) break

    const pause = Math.min(2000, remainingTime(deadline))
    console.warn(`[IA] rodada ${round} de ${provider} falhou; nova tentativa em ${pause} ms`)
    await sleep(pause)
  }

  throw lastError || createError(`Tempo máximo de ${TOTAL_TIMEOUT} ms atingido`, 408)
}

const providers = {
  nvidia: {
    key: NVIDIA_API_KEY,
    async ask(messages, deadline) {
      const models = await getNvidiaModels(deadline)
      return askWithRotation({
        provider: 'NVIDIA',
        models,
        messages,
        deadline,
        request: (model, currentMessages, timeoutMs) =>
          askOpenAICompat(
            'NVIDIA',
            `${NVIDIA_BASE_URL}/chat/completions`,
            NVIDIA_API_KEY,
            model,
            currentMessages,
            timeoutMs
          ),
      })
    },
  },
  deepseek: {
    key: DEEPSEEK_API_KEY,
    async ask(messages, deadline) {
      return askWithRotation({
        provider: 'DeepSeek',
        models: DEEPSEEK_MODEL.split(','),
        messages,
        deadline,
        request: (model, currentMessages, timeoutMs) =>
          askOpenAICompat(
            'DeepSeek',
            'https://api.deepseek.com/chat/completions',
            DEEPSEEK_API_KEY,
            model,
            currentMessages,
            timeoutMs
          ),
      })
    },
  },
}

async function askAI(messages) {
  const preferred = String(AI_PROVIDER || 'nvidia').toLowerCase()
  const order = [preferred, ...Object.keys(providers).filter((name) => name !== preferred)]
    .filter((name, index, list) => list.indexOf(name) === index && providers[name]?.key)

  if (!order.length) throw new Error('Nenhuma chave de IA configurada')

  const deadline = Date.now() + TOTAL_TIMEOUT
  let lastError

  for (const name of order) {
    if (remainingTime(deadline) <= 0) break
    try {
      return await providers[name].ask(messages, deadline)
    } catch (error) {
      lastError = error
      console.error(`[IA] provedor ${name} falhou:`, error.message)
    }
  }

  throw lastError || createError(`A IA não respondeu em ${TOTAL_TIMEOUT} ms`, 408)
}

// ---------- WEB SEARCH ----------
const WEB_ENABLED = String(WEB_SEARCH_ENABLED).toLowerCase() !== 'false'

function shouldSearch(text) {
  if (!WEB_ENABLED) return false
  const t = text.toLowerCase()
  // gatilhos explícitos
  if (/^pesquis[ae]|^busca|!search|!web|!google/.test(t)) return true
  // perguntas que precisam de dados atuais
  const triggers = [
    'quem é', 'o que é', 'quando', 'onde', 'cotação', 'preço', 'valor',
    'dólar', 'bitcoin', 'clima', 'tempo hoje', 'notícia', 'notícias',
    'hoje', 'atual', '2024', '2025', '2026', 'lançamento', 'resultado',
    'placar', 'jogo', 'campeonato', 'eleição', 'morreu', 'aconteceu',
    'como está', 'quantos', 'qual o valor', 'traduza', 'definição'
  ]
  return triggers.some(k => t.includes(k)) || t.split(' ').length > 6 && t.includes('?')
}

async function webSearch(query) {
  const q = query.slice(0, 300)
  console.log(`[SEARCH] buscando: ${q}`)

  // 1) SERPER (google) - melhor custo benefício
  if ((SEARCH_PROVIDER === 'auto' || SEARCH_PROVIDER === 'serper') && SERPER_API_KEY) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, gl: 'br', hl: 'pt-br', num: 5 }),
        signal: AbortSignal.timeout(10000)
      })
      if (res.ok) {
        const data = await res.json()
        const results = [...(data.organic||[]), ...(data.answerBox? [data.answerBox]: [])]
          .slice(0,5).map(r=> `• ${r.title}: ${r.snippet||r.answer||''} (${r.link||''})`).join('\n')
        if (results) return `RESULTADOS DA WEB para "${q}":\n${results}`
      }
    } catch (e) { console.warn('[SEARCH serper falhou]', e.message) }
  }

  // 2) TAVILY
  if ((SEARCH_PROVIDER === 'auto' || SEARCH_PROVIDER === 'tavily') && TAVILY_API_KEY) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_API_KEY, query: q, max_results: 5, include_answer: true, search_depth: 'basic' }),
        signal: AbortSignal.timeout(10000)
      })
      if (res.ok) {
        const data = await res.json()
        const results = (data.results||[]).slice(0,5).map(r=> `• ${r.title}: ${r.content?.slice(0,200)} (${r.url})`).join('\n')
        if (results) return `RESULTADOS DA WEB para "${q}":\n${results}\nResposta direta: ${data.answer||''}`
      }
    } catch (e) { console.warn('[SEARCH tavily falhou]', e.message) }
  }

  // 3) BRAVE
  if ((SEARCH_PROVIDER === 'auto' || SEARCH_PROVIDER === 'brave') && BRAVE_API_KEY) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
        signal: AbortSignal.timeout(10000)
      })
      if (res.ok) {
        const data = await res.json()
        const results = (data.web?.results||[]).slice(0,5).map(r=> `• ${r.title}: ${r.description?.slice(0,200)} (${r.url})`).join('\n')
        if (results) return `RESULTADOS DA WEB para "${q}":\n${results}`
      }
    } catch (e) { console.warn('[SEARCH brave falhou]', e.message) }
  }

  // 4) DUCKDUCKGO fallback grátis (sem key)
  try {
    const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const data = await res.json()
      let out = []
      if (data.AbstractText) out.push(`• ${data.Heading}: ${data.AbstractText} (${data.AbstractURL})`)
      if (data.RelatedTopics) {
        for (const t of data.RelatedTopics.slice(0,4)) {
          if (t.Text) out.push(`• ${t.Text.slice(0,200)} (${t.FirstURL||''})`)
        }
      }
      if (out.length) return `RESULTADOS DA WEB (DuckDuckGo) para "${q}":\n${out.join('\n')}`
    }
  } catch (e) { console.warn('[SEARCH ddg falhou]', e.message) }

  return null
}

// ---------- Helpers ----------
const getText = (m) =>
  m?.conversation ||
  m?.extendedTextMessage?.text ||
  m?.imageMessage?.caption ||
  m?.videoMessage?.caption ||
  ''

const digits = (jid = '') => jid.split('@')[0].split(':')[0]

// ---------- Sessão + Persistência ----------
let mongoClient
let mongoCol
let mongoDb
let mongoHistoryCol
let mongoCooldownCol

async function getAuth() {
  if (!MONGODB_URI) {
    console.warn('MONGODB_URI não definido, usando auth em arquivo local (sem persistência)')
    return useMultiFileAuthState('./auth')
  }

  if (!mongoCol) {
    const uri = MONGODB_URI.trim()
      .replace(/^MONGODB_URI\s*=\s*/, '')
      .replace(/^["']|["']$/g, '')

    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
      console.error(
        `MONGODB_URI inválida: precisa começar com mongodb+srv:// (o seu começa com "${uri.slice(0, 12)}")`
      )
      process.exit(1)
    }

    mongoClient = new MongoClient(uri)
    await mongoClient.connect()
    mongoDb = mongoClient.db('whatsapp_bot')
    mongoCol = mongoDb.collection('auth')
    mongoHistoryCol = mongoDb.collection('chats')
    mongoCooldownCol = mongoDb.collection('cooldowns')

    // índices para performance + limpeza automática
    await mongoHistoryCol.createIndex({ updatedAt: 1 }).catch(()=>{})
    await mongoHistoryCol.createIndex({ chatId: 1 }, { unique: true }).catch(()=>{})
    await mongoCooldownCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(()=>{})

    // restaurar cache da NVIDIA salvo
    try {
      const savedCatalog = await mongoDb.collection('bot_state').findOne({ _id: 'nvidia_catalog' })
      if (savedCatalog?.models?.length && savedCatalog.expiresAt > Date.now()) {
        nvidiaCatalogCache = { models: savedCatalog.models, expiresAt: savedCatalog.expiresAt }
        console.log(`[PERSIST] catálogo restaurado do MongoDB com ${savedCatalog.models.length} modelos`)
      }
    } catch {}

    console.log('[PERSIST] MongoDB conectado')
  }

  return useMongoAuthState(mongoCol)
}

async function loadChatHistory(chatId) {
  if (history.has(chatId)) return history.get(chatId)

  if (mongoHistoryCol) {
    try {
      const doc = await mongoHistoryCol.findOne({ chatId })
      if (doc?.messages?.length) {
        history.set(chatId, doc.messages)
        return doc.messages
      }
    } catch (e) { console.warn('[PERSIST] erro ao carregar histórico', e.message) }
  }
  return []
}

async function saveChatHistory(chatId, messages) {
  const sliced = messages.slice(-MAX_HISTORY)
  history.set(chatId, sliced)

  if (mongoHistoryCol) {
    try {
      await mongoHistoryCol.updateOne(
        { chatId },
        { $set: { messages: sliced, updatedAt: new Date(), lastActive: Date.now() } },
        { upsert: true }
      )
    } catch (e) { console.warn('[PERSIST] erro ao salvar histórico', e.message) }
  }
}

async function checkCooldown(sender) {
  const now = Date.now()
  const cooldownMs = Number(COOLDOWN) * 1000

  // memória primeiro (rápido)
  const memLast = lastUse.get(sender) || 0
  if (now - memLast < cooldownMs) return cooldownMs - (now - memLast)

  if (mongoCooldownCol) {
    try {
      const doc = await mongoCooldownCol.findOne({ sender })
      if (doc && now - doc.lastUse < cooldownMs) {
        return cooldownMs - (now - doc.lastUse)
      }
    } catch {}
  }
  return 0
}

async function setCooldown(sender) {
  const now = Date.now()
  lastUse.set(sender, now)
  if (mongoCooldownCol) {
    mongoCooldownCol.updateOne(
      { sender },
      { $set: { lastUse: now, expiresAt: new Date(now + Number(COOLDOWN)*1000*2) } },
      { upsert: true }
    ).catch(()=>{})
  }
}

// ---------- Bot ----------
async function start() {
  const { state, saveCreds } = await getAuth()
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false,
  })

  let currentSock = sock

  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error('Defina PHONE_NUMBER no .env')
      process.exit(1)
    }

    await sleep(3000)
    const code = await sock.requestPairingCode(PHONE_NUMBER)
    console.log(`\nCódigo de pareamento: ${code}`)
    console.log('WhatsApp > Aparelhos conectados > Conectar com número de telefone\n')
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('Bot conectado')

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode

      if (code === DisconnectReason.loggedOut) {
        console.log('Sessão encerrada. Limpando sessão e gerando novo pareamento em 5s...')
        mongoCol?.deleteMany({}).catch(() => {})
        mongoCol = null
        mongoDb = null
        setTimeout(start, 5000)
      } else {
        console.log('Conexão caiu, reconectando em 3s...')
        setTimeout(start, 3000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue

        const chatId = msg.key.remoteJid
        if (!chatId?.endsWith('@g.us')) continue

        const text = getText(msg.message).trim()
        if (!text) continue

        const botNumber = digits(sock.user?.id)
        const botLid = digits(sock.user?.lid)
        const mentioned =
          msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some((jid) =>
            [botNumber, botLid].includes(digits(jid))
          ) ?? false

        const hasPrefix = text.toLowerCase().startsWith(TRIGGER.toLowerCase())
        if (!hasPrefix && !mentioned) continue

        let question = text
          .slice(hasPrefix ? TRIGGER.length : 0)
          .replace(/@\d+/g, '')
          .trim()

        const quotedRaw = getText(
          msg.message.extendedTextMessage?.contextInfo?.quotedMessage
        ).trim()
        const quoted = quotedRaw
          .replace(new RegExp(`^${TRIGGER}\\s*`, 'i'), '')
          .trim()

        if (quoted) {
          question = question ? `${question}\n\n(Mensagem citada: ${quoted})` : quoted
        }

        if (!question) {
          await sock.sendMessage(
            chatId,
            { text: 'Fala aí, o que você quer saber? 😄' },
            { quoted: msg }
          )
          continue
        }

        // comandos especiais
        if (question.toLowerCase() === '!limpar' || question.toLowerCase() === '!clear') {
          history.delete(chatId)
          if (mongoHistoryCol) await mongoHistoryCol.deleteOne({ chatId }).catch(()=>{})
          await sock.sendMessage(chatId, { text: '🧹 Histórico limpo!' }, { quoted: msg })
          continue
        }

        const sender = msg.key.participant || chatId
        const remaining = await checkCooldown(sender)
        if (remaining > 0) {
          await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } })
          continue
        }

        await setCooldown(sender)
        await sock.sendPresenceUpdate('composing', chatId)

        const name = msg.pushName || 'Alguém'
        const chat = await loadChatHistory(chatId)

        // WEB SEARCH
        let searchContext = null
        if (shouldSearch(question)) {
          await sock.sendMessage(chatId, { react: { text: '🔍', key: msg.key } }).catch(()=>{})
          searchContext = await webSearch(question)
          if (searchContext) {
            console.log(`[SEARCH] encontrado contexto para "${question.slice(0,50)}"`)
          }
        }

        // monta mensagens para IA com contexto de busca
        const messagesForAI = [...chat]
        if (searchContext) {
          messagesForAI.push({
            role: 'system',
            content: `${searchContext}\n\nUse essas informações para responder a pergunta do usuário de forma atualizada.`
          })
        }
        messagesForAI.push({ role: 'user', content: `${name}: ${question}` })

        let answer
        try {
          // se tiver contexto, manda as mensagens com contexto, senão manda só o histórico + pergunta
          const payload = searchContext ? messagesForAI : [...chat, { role: 'user', content: `${name}: ${question}` }]
          answer = (await askAI(payload)).trim() || 'Não consegui pensar numa resposta 😅'
        } catch (error) {
          console.error('[IA] desistiu da solicitação:', error.message)
          await sock.sendMessage(
            chatId,
            { text: 'A IA tentou os modelos disponíveis, mas demorou demais ou todos falharam 😅 Tente novamente daqui a pouco.' },
            { quoted: msg }
          )
          await sock.sendPresenceUpdate('paused', chatId)
          continue
        }

        chat.push({ role: 'user', content: `${name}: ${question}` })
        chat.push({ role: 'assistant', content: answer })
        await saveChatHistory(chatId, chat)

        await sock.sendMessage(chatId, { text: answer }, { quoted: msg })
        await sock.sendPresenceUpdate('paused', chatId)
      } catch (error) {
        console.error('Erro:', error.message)
      }
    }
  })
}

process.on('SIGTERM', () => {
  try {
    mongoClient?.close()
  } catch {}
  process.exit(0)
})

setTimeout(start, process.env.RENDER ? 15000 : 0)
