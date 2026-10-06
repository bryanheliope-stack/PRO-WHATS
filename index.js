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
} = process.env

const SYSTEM_PROMPT =
  'Você é um assistente dentro de um grupo de WhatsApp. Responda em português do Brasil, ' +
  'de forma curta, direta e simpática. Sem markdown pesado (WhatsApp só suporta *negrito* e _itálico_).'

const MAX_HISTORY = 10
const history = new Map()
const lastUse = new Map()

// ---------- IA ----------
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_MODELS_URL = `${NVIDIA_BASE_URL}/models` // catálogo de todos os modelos liberados pela NVIDIA para a chave
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

    // Os modelos indicados no .env vêm primeiro; o restante do catálogo entra depois.
    const models = [...new Set([...NVIDIA_FALLBACK_MODELS, ...discovered])]
    if (!models.length) throw createError('Catálogo da NVIDIA retornou vazio', 502)

    nvidiaCatalogCache = {
      models,
      expiresAt: Date.now() + CATALOG_CACHE_TIME,
    }

    console.log(`[IA] catálogo NVIDIA carregado: ${models.length} modelos`)
    return models
  } catch (error) {
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

  // Continua rodando pelos modelos até algum responder ou o prazo total acabar.
  while (remainingTime(deadline) > 0) {
    round++
    const ordered = rotate(uniqueModels, provider)
    let candidates = ordered.filter((model) => availableNow(provider, model))

    // Se todos estiverem marcados como indisponíveis, tenta novamente em ordem rotativa.
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

    // Pequena pausa antes de revisitar modelos que já falharam.
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

// ---------- Helpers ----------
const getText = (m) =>
  m?.conversation ||
  m?.extendedTextMessage?.text ||
  m?.imageMessage?.caption ||
  m?.videoMessage?.caption ||
  ''

const digits = (jid = '') => jid.split('@')[0].split(':')[0]

// ---------- Sessão ----------
let mongoCol
let currentSock

async function getAuth() {
  if (!MONGODB_URI) return useMultiFileAuthState('./auth')

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

    const client = new MongoClient(uri)
    await client.connect()
    mongoCol = client.db('whatsapp_bot').collection('auth')
  }

  return useMongoAuthState(mongoCol)
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

  currentSock = sock

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
        mongoCol = null // força reconexão ao MongoDB na próxima chamada
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

        const sender = msg.key.participant || chatId
        const now = Date.now()

        if (now - (lastUse.get(sender) ?? 0) < Number(COOLDOWN) * 1000) {
          await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } })
          continue
        }

        lastUse.set(sender, now)
        await sock.sendPresenceUpdate('composing', chatId)

        const name = msg.pushName || 'Alguém'
        const chat = history.get(chatId) ?? []
        chat.push({ role: 'user', content: `${name}: ${question}` })

        let answer
        try {
          answer = (await askAI(chat)).trim() || 'Não consegui pensar numa resposta 😅'
        } catch (error) {
          chat.pop()
          console.error('[IA] desistiu da solicitação:', error.message)
          await sock.sendMessage(
            chatId,
            { text: 'A IA tentou os modelos disponíveis, mas demorou demais ou todos falharam 😅 Tente novamente daqui a pouco.' },
            { quoted: msg }
          )
          await sock.sendPresenceUpdate('paused', chatId)
          continue
        }

        chat.push({ role: 'assistant', content: answer })
        history.set(chatId, chat.slice(-MAX_HISTORY))

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
    currentSock?.ws?.close()
  } catch {}
  process.exit(0)
})

setTimeout(start, process.env.RENDER ? 15000 : 0)
