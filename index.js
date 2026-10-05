import pino from 'pino'
import http from 'node:http'
import { MongoClient } from 'mongodb'
import { useMongoAuthState } from './mongoAuth.js'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from './baileys.js'

// Servidor mínimo: o Render (Web Service) exige uma porta aberta, e dá pra
// usar essa URL num pinger (UptimeRobot) pra evitar que o plano free durma.
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('bot online')
  })
  .listen(process.env.PORT || 3000)

// Auto-ping: bate na própria URL pública a cada 10 min pra o Render não dormir o serviço.
// O Render define RENDER_EXTERNAL_URL sozinho; fora dele, use a variável PING_URL.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL).catch((e) => console.log('auto-ping falhou:', e.message))
  }, 10 * 60 * 1000)
}

const {
  PHONE_NUMBER,
  AI_PROVIDER = 'gemini',
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.8-flash',
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL = 'deepseek-chat',
  TRIGGER = '!ia',
  COOLDOWN = '2',
  MONGODB_URI,
} = process.env

const SYSTEM_PROMPT =
  'Você é um assistente dentro de um grupo de WhatsApp. Responda em português do Brasil, ' +
  'de forma curta, direta e simpática. Sem markdown pesado (WhatsApp só suporta *negrito* e _itálico_).'

const MAX_HISTORY = 10
const history = new Map() // chatId -> [{ role: 'user' | 'assistant', content }]
const lastUse = new Map() // sender -> timestamp

// ---------- IA ----------
async function askGemini(messages) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
      }),
    }
  )
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? ''
}

async function askDeepseek(messages) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    }),
  })
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

const askAI = (messages) =>
  AI_PROVIDER === 'deepseek' ? askDeepseek(messages) : askGemini(messages)

// ---------- Helpers ----------
const getText = (m) =>
  m?.conversation ||
  m?.extendedTextMessage?.text ||
  m?.imageMessage?.caption ||
  m?.videoMessage?.caption ||
  ''

const digits = (jid = '') => jid.split('@')[0].split(':')[0]

// ---------- Sessão (MongoDB se tiver MONGODB_URI, senão pasta ./auth) ----------
let mongoCol
async function getAuth() {
  if (!MONGODB_URI) return useMultiFileAuthState('./auth')
  if (!mongoCol) {
    // limpa erros comuns de colagem: espaços, aspas, "MONGODB_URI=" na frente
    const uri = MONGODB_URI.trim().replace(/^MONGODB_URI\s*=\s*/, '').replace(/^["']|["']$/g, '')
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

  // Pareamento por código (sem QR) — ideal quando o WhatsApp está no mesmo aparelho
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error('Defina PHONE_NUMBER no .env')
      process.exit(1)
    }
    await new Promise((r) => setTimeout(r, 3000))
    const code = await sock.requestPairingCode(PHONE_NUMBER)
    console.log(`\nCódigo de pareamento: ${code}`)
    console.log('WhatsApp > Aparelhos conectados > Conectar com número de telefone\n')
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('✅ Bot conectado')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Sessão encerrada. Limpando sessão salva, reinicie pra parear de novo.')
        mongoCol?.deleteMany({}).catch(() => {})
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
        if (!chatId?.endsWith('@g.us')) continue // só grupos

        const text = getText(msg.message).trim()
        if (!text) continue

        // Ativação: prefixo ou @menção ao bot
        const botNumber = digits(sock.user?.id)
        const botLid = digits(sock.user?.lid)
        const mentioned =
          msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.some((j) =>
            [botNumber, botLid].includes(digits(j))
          ) ?? false
        const hasPrefix = text.toLowerCase().startsWith(TRIGGER.toLowerCase())
        if (!hasPrefix && !mentioned) continue

        // Texto da pergunta (tira prefixo e menções)
        let question = text
          .slice(hasPrefix ? TRIGGER.length : 0)
          .replace(/@\d+/g, '')
          .trim()

        // Se for resposta a outra mensagem, usa o texto citado como contexto
        const quotedRaw = getText(msg.message.extendedTextMessage?.contextInfo?.quotedMessage).trim()
        const quoted = quotedRaw.replace(new RegExp(`^${TRIGGER}\\s*`, 'i'), '').trim()
        if (quoted) {
          question = question
            ? `${question}\n\n(Mensagem citada: ${quoted})`
            : quoted
        }

        if (!question) {
          await sock.sendMessage(chatId, { text: 'Fala aí, o que você quer saber? 😄' }, { quoted: msg })
          continue
        }

        // Cooldown anti-spam (só conta pra perguntas de verdade)
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

        const answer = (await askAI(chat)).trim() || 'Não consegui pensar numa resposta 😅'

        chat.push({ role: 'assistant', content: answer })
        history.set(chatId, chat.slice(-MAX_HISTORY))

        await sock.sendMessage(chatId, { text: answer }, { quoted: msg })
        await sock.sendPresenceUpdate('paused', chatId)
      } catch (err) {
        console.error('Erro:', err.message)
      }
    }
  })
}

start()
