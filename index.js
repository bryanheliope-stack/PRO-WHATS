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

// 📂 Pasta temporária
const TEMP_DIR = path.join(__dirname, 'temp_files')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })

// ======================================
// 🌐 SERVIDOR + AUTO-PING INTELIGENTE
// ======================================
const PORT = process.env.PORT || 3000

http
  .createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ 
        status: 'alive', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('✅ Bot Online — Sistema de Aprendizado Ativo!')
    }
  })
  .listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`)
  })

// 🔄 AUTO-PING — MANTER O SERVIDOR LIGADO 24h
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000

if (SELF_URL) {
  console.log(`🔄 Auto-ping configurado: a cada ${PING_INTERVAL/60000} minutos`)
  
  setInterval(async () => {
    try {
      const inicio = Date.now()
      const res = await fetch(`${SELF_URL}/ping`)
      const tempo = Date.now() - inicio
      if (res.ok) {
        console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ✅ Servidor ativo (${tempo}ms)`)
      }
    } catch (err) {
      console.warn(`⚠️ Ping falhou: ${err.message}`)
    }
  }, PING_INTERVAL)
} else {
  console.log('⚠️ RENDER_EXTERNAL_URL não configurada — servidor pode dormir!')
  console.log('💡 Adicione a variável com a URL do seu app no Render')
}

// ======================================
// 🗄️ BANCO DE DADOS
// ======================================
const {
  PHONE_NUMBER,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'nousresearch/hermes-3-llama-3.1-8b:free,mistralai/mistral-small-3.1-24b-instruct:free',
  TRIGGER = 'nexos',
  COOLDOWN = '2',
  MONGODB_URI,
  ALLOWED_USERS = '',
  ALLOWED_GROUPS = '',
  AI_TIMEOUT = '180000',
  AUTO_IMPROVEMENT_HOUR = '3', // ⏰ Horário da auto-análise (3h da manhã)
} = process.env

const TRIGGER_LOWER = TRIGGER.toLowerCase()
let mongoClient, dbKnowledge, dbLogs

async function initDB() {
  try {
    mongoClient = new MongoClient(MONGODB_URI)
    await mongoClient.connect()
    dbKnowledge = mongoClient.db('bot_knowledge')
    dbLogs = mongoClient.db('bot_knowledge').collection('activity_logs')
    
    await dbKnowledge.collection('corrections').createIndex({ userId: 1, grupoId: 1 })
    await dbKnowledge.collection('corrections').createIndex({ palavrasChave: 1 })
    await dbKnowledge.collection('conversations').createIndex({ userId: 1, timestamp: -1 })
    
    console.log('🧠 Sistema de Aprendizado + Auto-Melhoria ATIVO!')
    return true
  } catch (err) {
    console.error('❌ Erro no banco:', err.message)
    return false
  }
}

// ======================================
// 🧠 SISTEMA DE MEMÓRIA + AUTO-MELHORIA
// ======================================
const Memory = {
  async saveCorrection(userId, grupoId, assunto, respostaErrada, respostaCorreta) {
    const palavrasChave = assunto.toLowerCase()
      .replace(/[^\w\sàáâãäçèéêëìíîïòóôõöùúûü]/g, ' ')
      .split(/\s+/)
      .filter(p => p.length > 2)

    return dbKnowledge.collection('corrections').insertOne({
      userId, grupoId, assunto: assunto.trim(),
      respostaErrada: respostaErrada?.trim() || '',
      respostaCorreta: respostaCorreta.trim(),
      palavrasChave, vezesUsada: 0, vezesCorrigida: 0,
      criadoEm: new Date(), atualizadoEm: new Date(),
    })
  },

  async checkCorrection(userId, grupoId, pergunta) {
    const palavras = pergunta.toLowerCase()
      .replace(/[^\w\sàáâãäçèéêëìíîïòóôõöùúûü]/g, ' ')
      .split(/\s+/)
      .filter(p => p.length > 2)

    if (palavras.length === 0) return null

    const resultado = await dbKnowledge.collection('corrections').find({
      $and: [
        { $or: [{ userId }, { userId: 'geral' }] },
        { $or: [{ grupoId }, { grupoId: 'geral' }] },
        { palavrasChave: { $in: palavras } },
      ],
    }).sort({ vezesUsada: -1, criadoEm: -1 }).limit(1).toArray()

    if (resultado.length > 0) {
      await dbKnowledge.collection('corrections').updateOne(
        { _id: resultado[0]._id }, { $inc: { vezesUsada: 1 } }
      )
      return resultado[0]
    }
    return null
  },

  async saveConversation(userId, grupoId, pergunta, resposta, foiCorrigida = false) {
    return dbKnowledge.collection('conversations').insertOne({
      userId, grupoId, pergunta, resposta, foiCorrigida,
      timestamp: new Date(),
    })
  },

  async listAll(userId, grupoId) {
    return dbKnowledge.collection('corrections').find({
      $or: [{ userId }, { userId: 'geral' }],
      $or: [{ grupoId }, { grupoId: 'geral' }],
    }).sort({ criadoEm: -1 }).toArray()
  },

  async delete(userId, grupoId, assunto) {
    return dbKnowledge.collection('corrections').deleteOne({
      $or: [{ userId }, { userId: 'geral' }],
      $or: [{ grupoId }, { grupoId: 'geral' }],
      assunto: { $regex: new RegExp(`^${assunto}$`, 'i') },
    })
  },

  async clearAll(userId, grupoId) {
    return dbKnowledge.collection('corrections').deleteMany({
      $or: [{ userId }, { userId: 'geral' }],
      $or: [{ grupoId }, { grupoId: 'geral' }],
    })
  },

  // 📈 AUTO-ANÁLISE: Revisar conversas e identificar padrões
  async runSelfImprovement() {
    console.log('🔍 Iniciando auto-análise...')
    try {
      const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const conversas = await dbKnowledge.collection('conversations').find({
        timestamp: { $gte: ontem },
      }).limit(100).toArray()

      const corrigidas = conversas.filter(c => c.foiCorrigida).length
      const taxaCorrecao = conversas.length > 0 ? (corrigidas / conversas.length * 100).toFixed(1) : 0

      await dbLogs.insertOne({
        tipo: 'auto-analise', data: new Date(),
        totalConversas: conversas.length, corrigidas, taxaCorrecao,
      })

      console.log(`📊 Auto-análise concluída: ${conversas.length} conversas, ${corrigidas} corrigidas (${taxaCorrecao}%)`)
      return { total: conversas.length, corrigidas, taxaCorrecao }
    } catch (err) {
      console.error('❌ Erro na auto-análise:', err.message)
    }
  },
}

// ⏰ AGENDAR AUTO-ANÁLISE DIÁRIA
let ultimaAutoMelhoria = null
async function verificarAutoMelhoria() {
  const agora = new Date()
  const horaAtual = agora.getUTCHours() - 3 // Horário de Brasília
  const alvo = parseInt(AUTO_IMPROVEMENT_HOUR)
  
  // Executa uma vez por dia no horário definido
  if (horaAtual === alvo && (!ultimaAutoMelhoria || ultimaAutoMelhoria.toDateString() !== agora.toDateString())) {
    console.log(`⏰ Executando auto-melhoria diária (${alvo}h)`)
    ultimaAutoMelhoria = agora
    await Memory.runSelfImprovement()
  }
}
setInterval(verificarAutoMelhoria, 60 * 60 * 1000) // Verifica a cada hora

// ======================================
// 🤖 IA
// ======================================
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS = OPENROUTER_MODEL.split(',').map(m => m.trim()).filter(Boolean)

async function getAIResponse(pergunta, correcao = null) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY não configurada')

  let systemPrompt = 'Você é um assistente útil. Responda em português do Brasil de forma clara e direta.'
  
  if (correcao) {
    systemPrompt += `\n\n⚠️ INFORMAÇÃO CONFIRMADA PELO USUÁRIO:\nPergunta: ${correcao.assunto}\nResposta correta: ${correcao.respostaCorreta}\nUse SEMPRE essa informação.`
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': SELF_URL || 'https://localhost',
      'X-OpenRouter-Title': 'Nexos Bot',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODELS[0],
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: pergunta },
      ],
      max_tokens: 2000,
      temperature: 0.5,
    }),
    signal: AbortSignal.timeout(parseInt(AI_TIMEOUT)),
  })

  if (!res.ok) throw new Error(`Erro na IA: ${res.status}`)
  const data = await res.json()
  return data?.choices?.[0]?.message?.content?.trim() || 'Desculpe, não consegui responder.'
}

// ======================================
// 🛡️ UTILIDADES
// ======================================
const getText = (msg) => msg?.conversation || msg?.extendedTextMessage?.text || msg?.imageMessage?.caption || ''
const digits = (jid = '') => jid.split('@')[0].split(':')[0]
const parseList = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean)
const onlyDigits = (v) => String(v || '').replace(/\D/g, '')

function brVariants(id) {
  const out = new Set([id])
  const m = id.match(/^(55\d{2})9?(\d{8})$/)
  if (m) { out.add(`${m[1]}9${m[2]}`); out.add(`${m[1]}${m[2]}`) }
  return out
}

const ALLOWED_USER_IDS = new Set(parseList(ALLOWED_USERS).flatMap(x => [...brVariants(onlyDigits(x))]).filter(Boolean))
const ALLOWED_GROUP_IDS = new Set(parseList(ALLOWED_GROUPS).map(x => x.split('@')[0]))

if (!ALLOWED_USER_IDS.size) console.warn('[Segurança] ⚠️ Defina ALLOWED_USERS!')

const senderIds = (msg) => [msg.key.participant, msg.participant].filter(Boolean).map(digits).filter(Boolean)
const userAllowed = (ids) => !ALLOWED_USER_IDS.size || ids.some(id => [...brVariants(id)].some(v => ALLOWED_USER_IDS.has(v)))
const groupAllowed = (chatId) => !ALLOWED_GROUP_IDS.size || ALLOWED_GROUP_IDS.has(chatId.split('@')[0])

function hasTrigger(text, mentioned) {
  const t = text.toLowerCase()
  return t.startsWith(TRIGGER_LOWER) || t.includes(TRIGGER_LOWER) || mentioned
}

// ======================================
// 📋 COMANDOS
// ======================================
async function processCommand(text, userId, grupoId, quotedText = '') {
  const cmd = text.toLowerCase().replace(new RegExp(TRIGGER_LOWER, 'gi'), '').trim()
  const parts = cmd.split(/\s+/)
  const acao = parts[0]
  const resto = parts.slice(1).join(' ').trim()

  switch (acao) {
    case 'corrija': case 'aprenda': case 'lembre':
      let assunto, respostaCorreta
      if (resto.includes('=') || resto.includes('é') || resto.includes(':')) {
        const separador = resto.includes('=') ? '=' : resto.includes(':') ? ':' : 'é'
        const separado = resto.split(new RegExp(` ${separador} `), 2)
        assunto = separado[0]?.trim()
        respostaCorreta = separado[1]?.trim()
      }
      if (!respostaCorreta && quotedText) {
        assunto = resto || 'essa informação'
        respostaCorreta = quotedText
      }
      if (!assunto || !respostaCorreta) {
        return `📝 **Como me corrigir:**

• ${TRIGGER} corrija [o que] = [resposta certa]
• Ou me cite uma mensagem e diga: "${TRIGGER} não, é assim!"`
      }
      await Memory.saveCorrection(userId, grupoId, assunto, '', respostaCorreta)
      return `✅ **Anotado! Vou usar isso da próxima vez!** 🧠

📌 ${assunto}
✅ ${respostaCorreta}`

    case 'memoria': case 'lembrancas': case 'aprendizado':
      const correcoes = await Memory.listAll(userId, grupoId)
      return correcoes.length === 0
        ? `📚 Ainda não aprendi nada! Quando eu errar, me corrija usando:\n${TRIGGER} corrija isso = resposta certa`
        : `📚 **O que aprendi (${correcoes.length}):**\n\n${correcoes.map((c, i) => `${i + 1}. ❓ ${c.assunto}\n   ✅ ${c.respostaCorreta}`).join('\n\n')}`

    case 'estatisticas': case 'stats':
      const hoje = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const logs = await dbLogs.find({ tipo: 'auto-analise', data: { $gte: hoje } }).sort({ data: -1 }).limit(7).toArray()
      return `📊 **Estatísticas dos últimos 7 dias:**

${logs.length === 0 ? 'Sem dados ainda. A auto-análise roda diariamente às ' + AUTO_IMPROVEMENT_HOUR + 'h.' 
  : logs.map(l => `📅 ${l.data.toLocaleDateString('pt-BR')}: ${l.totalConversas} msgs, ${l.corrigidas} correções (${l.taxaCorrecao}%)`).join('\n')}

🔄 Auto-análise roda todo dia às ${AUTO_IMPROVEMENT_HOUR}h`

    case 'esquece': case 'esqueça':
      if (!resto || resto === 'tudo') {
        if (resto === 'tudo') {
          await Memory.clearAll(userId, grupoId)
          return '🗑️ Esqueci TUDO!'
        }
        return `Uso: ${TRIGGER} esquece [assunto]`
      }
      await Memory.delete(userId, grupoId, resto)
      return `🗑️ Esqueci: "${resto}"`

    case 'ajuda': default:
      return `🧠 **Sistema de Aprendizado + Auto-Melhoria 24/7**

✨ **Comandos:**
• ${TRIGGER} corrija [o que] = [resposta] → Me ensina
• ${TRIGGER} memoria → Veja o que aprendi
• ${TRIGGER} estatisticas → Veja minha evolução
• ${TRIGGER} esquece tudo → Limpa memória

🔄 **Auto-ping ativo:** a cada ${PING_INTERVAL/60000}min
⏰ **Auto-análise diária:** às ${AUTO_IMPROVEMENT_HOUR}h
🌐 **Servidor:** ${SELF_URL || 'Não configurado'}`
  }
}

// ======================================
// 🚀 INICIAR BOT
// ======================================
async function start() {
  try {
    await initDB()

    const { state, saveCreds } = MONGODB_URI 
      ? await (async () => {
          const uri = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
          const client = new MongoClient(uri)
          await client.connect()
          return useMongoAuthState(client.db('whatsapp_bot').collection('auth'))
        })()
      : await useMultiFileAuthState('./auth')

    const { version } = await fetchLatestBaileysVersion()
    console.log(`🤖 Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'], markOnlineOnConnect: false,
    })

    if (!sock.authState.creds.registered) {
      if (!PHONE_NUMBER) { console.error('❌ Defina PHONE_NUMBER!'); process.exit(1) }
      await new Promise(r => setTimeout(r, 2000))
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      console.log('\n=====================================')
      console.log(`📲 Código: ${code}`)
      console.log('👉 WhatsApp > Aparelhos > Conectar com número')
      console.log('=====================================\n')
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') console.log('✅ CONECTADO — 24h Online + Auto-Melhoria ATIVA!')
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code !== DisconnectReason.connectionReplaced) {
          console.log('[Conexão] Reiniciando...')
          setTimeout(start, 5000)
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
          const botNumber = digits(sock.user?.id)
          const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid
            ?.some(jid => digits(jid) === botNumber) ?? false
          
          if (!hasTrigger(text, mentioned)) continue
          if (!groupAllowed(chatId)) continue

          const ids = senderIds(msg)
          const userId = ids[0] || 'geral'
          const grupoId = chatId.split('@')[0]
          const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const quotedText = getText(quotedMsg).trim()

          if (!userAllowed(ids)) continue

          const cleanText = text.replace(new RegExp(TRIGGER_LOWER, 'gi'), '').replace(/@\d+\s*/g, '').trim()
          
          const respostaComando = await processCommand(cleanText, userId, grupoId, quotedText)
          if (respostaComando) {
            await sock.sendMessage(chatId, { text: respostaComando }, { quoted: msg })
            continue
          }

          const correcao = await Memory.checkCorrection(userId, grupoId, cleanText)
          const agora = Date.now()
          const ultimoUso = lastUse.get(chatId) || 0
          if (agora - ultimoUso < parseInt(COOLDOWN) * 1000) {
            await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } })
            continue
          }
          lastUse.set(chatId, agora)

          await sock.sendPresenceUpdate('composing', chatId)
          
          let resposta
          if (correcao) {
            resposta = `📝 **Como você me ensinou:**\n\n${correcao.respostaCorreta}`
          } else {
            resposta = await getAIResponse(cleanText)
          }

          // Salvar conversa para auto-análise
          await Memory.saveConversation(userId, grupoId, cleanText, resposta, !!correcao)

          await sock.sendMessage(chatId, { text: resposta }, { quoted: msg })
          await sock.sendPresenceUpdate('paused', chatId)

        } catch (err) {
          console.error('❌ Erro:', err.message)
        }
      }
    })
  } catch (err) {
    console.error('[Inicialização]', err)
    setTimeout(start, 5000)
  }
}

const lastUse = new Map()
start().catch(console.error)

process.on('SIGTERM', async () => {
  console.log('\n🛑 Encerrando...')
  if (mongoClient) await mongoClient.close()
  process.exit(0)
})
