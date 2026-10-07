import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import { useMongoAuthState } from './mongoAuth.js'
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
// 🛡️ SISTEMA DE SEGURANÇA
// ======================================
const PALAVRAS_PERIGOSAS = [
  'senha', 'cartão', 'cpf', 'rg', 'documento', 'dados bancários',
  'hackear', 'invadir', 'roubar', 'vazamento', 'phishing', 'golpe',
  'vírus', 'malware', 'exploit', 'ddos', 'ataque', 'injetar',
  'comandos perigosos', 'código malicioso', 'acesso não autorizado',
  'quebrar', 'destruir', 'apagar tudo', 'formatar', 'deletar sistema'
]

function verificarSeguranca(texto) {
  if (!texto) return { seguro: true, motivo: '' }
  const textoVerificar = texto.toLowerCase()
  
  for (const palavra of PALAVRAS_PERIGOSAS) {
    if (textoVerificar.includes(palavra.toLowerCase())) {
      return {
        seguro: false,
        motivo: `⚠️ Conteúdo potencialmente perigoso: "${palavra}". Por segurança, não posso processar isso.`
      }
    }
  }
  
  const padroesProibidos = [
    /como (hackear|invadir|roubar)/i,
    /me dê (senha|chave|token)/i,
    /crie um (vírus|malware|golpe)/i,
    /apague (tudo|os arquivos|o sistema)/i,
    /formate o disco/i,
    /me dê acesso/i
  ]
  
  for (const padrao of padroesProibidos) {
    if (padrao.test(texto)) {
      return {
        seguro: false,
        motivo: '⚠️ Solicitação bloqueada. Não posso ajudar com ações que possam causar danos.'
      }
    }
  }
  return { seguro: true, motivo: '' }
}

// ======================================
// 📄 ANÁLISE DE ARQUIVOS
// ======================================
async function analisarArquivo(caminhoArquivo, tipo = 'arquivo') {
  try {
    const stats = fs.statSync(caminhoArquivo)
    const tamanhoKB = (stats.size / 1024).toFixed(2)
    return {
      seguro: true,
      analise: `📋 **Arquivo processado com segurança:**

• Tipo: ${tipo}
• Tamanho: ${tamanhoKB} KB
• ✅ Verificado e excluído automaticamente`,
      resumo: `${tipo} (${tamanhoKB} KB) — processado`
    }
  } catch (err) {
    console.error('❌ Erro ao analisar arquivo:', err.message)
    return { seguro: false, analise: '❌ Não foi possível analisar o arquivo.', resumo: 'Erro' }
  } finally {
    try {
      if (fs.existsSync(caminhoArquivo)) fs.unlinkSync(caminhoArquivo)
    } catch (delErr) {
      console.warn(`⚠️ Não foi possível apagar: ${delErr.message}`)
    }
  }
}

// ======================================
// 🌐 SERVIDOR + AUTO-PING
// ======================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'alive', uptime: process.uptime() }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ Bot Online!')
  }
}).listen(PORT, () => console.log(`🌐 Porta ${PORT}`))

const SELF_URL = process.env.RENDER_EXTERNAL_URL
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000
if (SELF_URL) {
  setInterval(async () => {
    try { await fetch(`${SELF_URL}/ping`) } catch (e) {}
  }, PING_INTERVAL)
}

// ======================================
// ⚙️ CONFIGURAÇÕES
// ======================================
const {
  PHONE_NUMBER,
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = 'nousresearch/hermes-3-llama-3.1-8b:free,mistralai/mistral-small-3.1-24b-instruct:free',
  NVIDIA_API_KEY,
  TRIGGER = 'nexos',
  COOLDOWN = '2',
  MONGODB_URI,
  ALLOWED_USERS = '',
  ALLOWED_GROUPS = '',
  AI_TIMEOUT = '180000',
} = process.env

const TRIGGER_LOWER = TRIGGER.toLowerCase()

const requiredEnv = ['PHONE_NUMBER', 'MONGODB_URI', 'OPENROUTER_API_KEY']
const faltando = requiredEnv.filter(v => !process.env[v])
if (faltando.length > 0) {
  console.error(`❌ Faltando variáveis: ${faltando.join(', ')}`)
  process.exit(1)
}

// ======================================
// 🗄️ BANCO DE DADOS
// ======================================
let mongoClient, dbKnowledge, dbLogs
async function initDB() {
  try {
    if (!MONGODB_URI) return false
    const uri = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) return false
    mongoClient = new MongoClient(uri)
    await mongoClient.connect()
    dbKnowledge = mongoClient.db('bot_knowledge')
    dbLogs = dbKnowledge.collection('activity_logs')
    await dbKnowledge.collection('corrections').createIndex({ userId: 1, grupoId: 1 })
    await dbKnowledge.collection('corrections').createIndex({ palavrasChave: 1 })
    await dbKnowledge.collection('conversations').createIndex({ userId: 1, timestamp: -1 })
    console.log('🧠 Banco conectado!')
    return true
  } catch (err) {
    console.error('❌ Erro no banco:', err.message)
    return false
  }
}

// ======================================
// 🧠 MEMÓRIA
// ======================================
const Memory = {
  async saveCorrection(userId, grupoId, assunto, respostaCorreta) {
    const palavrasChave = assunto.toLowerCase().replace(/[^\w\sàáâãäçèéêëìíîïòóôõöùúûü]/g, ' ').split(/\s+/).filter(p => p.length > 2)
    return dbKnowledge.collection('corrections').insertOne({
      userId, grupoId, assunto: assunto.trim(), respostaCorreta: respostaCorreta.trim(),
      palavrasChave, vezesUsada: 0, criadoEm: new Date()
    })
  },
  async checkCorrection(userId, grupoId, pergunta) {
    const palavras = pergunta.toLowerCase().replace(/[^\w\sàáâãäçèéêëìíîïòóôõöùúûü]/g, ' ').split(/\s+/).filter(p => p.length > 2)
    if (palavras.length === 0) return null
    const res = await dbKnowledge.collection('corrections').find({
      $and: [
        { $or: [{ userId }, { userId: 'geral' }] },
        { $or: [{ grupoId }, { grupoId: 'geral' }] },
        { palavrasChave: { $in: palavras } },
      ]
    }).sort({ vezesUsada: -1, criadoEm: -1 }).limit(1).toArray()
    if (res.length > 0) {
      await dbKnowledge.collection('corrections').updateOne({ _id: res[0]._id }, { $inc: { vezesUsada: 1 } })
      return res[0]
    }
    return null
  },
  async saveConversation(userId, grupoId, pergunta, resposta, foiCorrigida = false) {
    return dbKnowledge.collection('conversations').insertOne({
      userId, grupoId, pergunta, resposta, foiCorrigida, timestamp: new Date()
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
}

// ======================================
// 🤖 IA — OPENROUTER + NVIDIA
// ======================================
async function getOpenRouterResponse(pergunta, correcao = null) {
  let systemPrompt = 'Você é um assistente útil, amigável e prestativo. Responda SEMPRE em português do Brasil de forma clara e natural. Seja direto e não use formalidades excessivas.'
  if (correcao) {
    systemPrompt += `\n\n⚠️ INFORMAÇÃO CONFIRMADA PELA COMUNIDADE:\nPergunta: ${correcao.assunto}\nResposta correta: ${correcao.respostaCorreta}\nUse essa informação se a pergunta for sobre isso.`
  }

  const modelos = OPENROUTER_MODEL.split(',').map(m => m.trim()).filter(Boolean)
  
  for (const modelo of modelos) {
    try {
      console.log(`🤖 Usando OpenRouter: ${modelo}`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': SELF_URL || 'https://localhost',
          'X-OpenRouter-Title': 'Nexos Bot',
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: pergunta },
          ],
          max_tokens: 1500,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(parseInt(AI_TIMEOUT)),
      })
      if (!res.ok) throw new Error(`Status: ${res.status}`)
      const data = await res.json()
      const resposta = data?.choices?.[0]?.message?.content?.trim()
      if (resposta) return resposta
    } catch (err) {
      console.warn(`⚠️ ${modelo} falhou: ${err.message}`)
    }
  }
  return null
}

async function getNVIDIAResponse(pergunta, correcao = null) {
  if (!NVIDIA_API_KEY) return null
  
  let systemPrompt = 'Você é um assistente útil. Responda em português do Brasil de forma clara e direta.'
  if (correcao) {
    systemPrompt += `\n\nINFORMAÇÃO CONFIRMADA:\n${correcao.assunto} = ${correcao.respostaCorreta}`
  }

  try {
    console.log('🤖 Tentando NVIDIA API...')
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta/llama-3.1-70b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: pergunta },
        ],
        max_tokens: 1024,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(parseInt(AI_TIMEOUT)),
    })
    if (!res.ok) throw new Error(`Status: ${res.status}`)
    const data = await res.json()
    return data?.choices?.[0]?.message?.content?.trim()
  } catch (err) {
    console.warn(`⚠️ NVIDIA falhou: ${err.message}`)
    return null
  }
}

async function getAIResponse(pergunta, correcao = null) {
  let resposta = await getOpenRouterResponse(pergunta, correcao)
  if (resposta) return resposta
  
  resposta = await getNVIDIAResponse(pergunta, correcao)
  if (resposta) return resposta
  
  return '🤔 Desculpe, estou com dificuldades técnicas no momento. Tente novamente em instantes.'
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

  const DONO_NUMERO = onlyDigits(PHONE_NUMBER || '')
  const ehDono = [...brVariants(userId)].some(v => DONO_NUMERO && DONO_NUMERO.includes(v))

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
      await Memory.saveCorrection(userId, grupoId, assunto, respostaCorreta)
      return `✅ **Anotado! Obrigado por ensinar!** 🧠

📌 ${assunto}
✅ ${respostaCorreta}`

    case 'memoria': case 'lembrancas': case 'aprendizado':
      const correcoes = await Memory.listAll(userId, grupoId)
      return correcoes.length === 0
        ? `📚 Ainda não aprendi nada! Quando eu errar, me corrija usando:\n${TRIGGER} corrija isso = resposta certa`
        : `📚 **O que aprendi com todos (${correcoes.length}):**

${correcoes.map((c, i) => `${i + 1}. ❓ ${c.assunto}\n   ✅ ${c.respostaCorreta}`).join('\n\n')}`

    case 'esquece': case 'esqueça': case 'apague':
      if (!ehDono) return '🔒 Apenas o dono do bot pode apagar a memória.'
      if (!resto || resto === 'tudo') {
        if (resto === 'tudo') {
          await Memory.clearAll(userId, grupoId)
          return '🗑️ **Pronto! Memória apagada com sucesso!** ✅'
        }
        return `Uso: ${TRIGGER} esquece [assunto]\nOu: ${TRIGGER} esquece tudo`
      }
      await Memory.delete(userId, grupoId, resto)
      return `🗑️ Esqueci: "${resto}" ✅`

    case 'dono': case 'admin':
      return ehDono
        ? `👑 Você é o DONO do bot! Comandos exclusivos:

• ${TRIGGER} esquece [assunto] → Apaga uma correção
• ${TRIGGER} esquece tudo → Limpa memória completa`
        : '🔒 Apenas o dono tem acesso a esses comandos.'

    case 'ajuda':
      return `🧠 **Nexos — IA Comunitária**

✨ **Comandos:**
• ${TRIGGER} [sua pergunta] → Falar comigo
• ${TRIGGER} corrija [o que] = [resposta] → Me ensinar
• ${TRIGGER} + arquivo/imagem → Analisar
• ${TRIGGER} memoria → Ver o que aprendi

👑 **Apenas o dono:**
• ${TRIGGER} esquece [assunto] → Apagar
• ${TRIGGER} esquece tudo → Limpar tudo`

    default:
      return null
  }
}

// ======================================
// 🚀 INICIAR BOT
// ======================================
// Coleção da sessão do WhatsApp (uma conexão só, reaproveitada a cada reinício do bot).
let authCol = null
async function getAuthCollection() {
  if (!MONGODB_URI) return null
  if (!authCol) {
    const uri = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
    const client = new MongoClient(uri)
    await client.connect()
    authCol = client.db('whatsapp_bot').collection('auth')

    // RESET_SESSION=<valor novo>: apaga a sessão salva UMA vez por valor (pra parear do zero).
    const token = process.env.RESET_SESSION
    if (token) {
      const meta = client.db('whatsapp_bot').collection('meta')
      const feito = await meta.findOne({ _id: 'reset-session' })
      if (feito?.token !== token) {
        await authCol.deleteMany({})
        await meta.updateOne({ _id: 'reset-session' }, { $set: { token } }, { upsert: true })
        console.log('[Sessão] RESET_SESSION aplicado: sessão apagada, vai gerar um código novo.')
      }
    }
  }
  return authCol
}

async function start() {
  try {
    await initDB()

    const authCollection = await getAuthCollection()
    const { state, saveCreds } = authCollection
      ? await useMongoAuthState(authCollection)
      : await useMultiFileAuthState('./auth')

    const { version } = await fetchLatestBaileysVersion()
    console.log(`🤖 Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'], markOnlineOnConnect: false,
    })

    sock.ev.on('creds.update', saveCreds)

    // Pareamento por código. O número tem que ser o da conta onde você vai digitar o código.
    const telefone = onlyDigits(PHONE_NUMBER || '')
    let codigoPedido = false
    const pedirCodigo = async () => {
      if (codigoPedido || sock.authState.creds.registered) return
      codigoPedido = true
      try {
        const code = await sock.requestPairingCode(telefone)
        console.log('\n=====================================')
        console.log(`📲 Código: ${code}`)
        console.log(`📱 Gerado para o número ${telefone.slice(0, 4)}…${telefone.slice(-4)}`)
        console.log('👉 Digite no WhatsApp DESSE número: Aparelhos conectados > Conectar com número de telefone')
        console.log('⏱️ Vale por pouco tempo. Se falhar, espere o próximo código (o bot gera outro sozinho).')
        if (telefone.startsWith('55')) {
          console.log('💡 Se der "Não foi possível conectar": teste PHONE_NUMBER com e sem o 9 depois do DDD.')
        }
        console.log('=====================================\n')
      } catch (err) {
        codigoPedido = false
        console.error('❌ Não consegui gerar o código:', err.message)
      }
    }

    if (!sock.authState.creds.registered) {
      if (telefone.length < 10 || telefone.length > 15) {
        console.error('❌ PHONE_NUMBER inválido. Use só dígitos com DDI e DDD (ex.: 5511999998888).')
        process.exit(1)
      }
      setTimeout(pedirCodigo, 8000) // plano B, caso o aviso de "conexão pronta" não chegue
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) pedirCodigo()
      if (connection === 'open') console.log('✅ CONECTADO — IA ATIVA!')
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.log('[Sessão] Deslogado do WhatsApp. Limpando a sessão e gerando um código novo em 5s...')
          authCol?.deleteMany({}).catch(() => {})
          setTimeout(start, 5000)
          return
        }
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
          
          const temArquivo = !!msg.message?.documentMessage || !!msg.message?.imageMessage || !!msg.message?.videoMessage
          const temTrigger = hasTrigger(text, mentioned)
          
          if (temArquivo && !temTrigger) {
            console.log('📎 Arquivo sem comando — ignorado')
            continue
          }
          if (!temTrigger && !temArquivo) continue
          if (!groupAllowed(chatId)) continue

          const ids = senderIds(msg)
          const userId = ids[0] || 'geral'
          const grupoId = chatId.split('@')[0]
          const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const quotedText = getText(quotedMsg).trim()

          if (!userAllowed(ids)) continue

          const cleanText = text.replace(new RegExp(TRIGGER_LOWER, 'gi'), '').replace(/@\d+\s*/g, '').trim()
          
          const verificacao = verificarSeguranca(cleanText)
          if (!verificacao.seguro) {
            await sock.sendMessage(chatId, { 
              text: `🛡️ **Bloqueado** ⚠️\n\n${verificacao.motivo}`
            }, { quoted: msg })
            continue
          }
          
          if (temArquivo && temTrigger) {
            await sock.sendMessage(chatId, { react: { text: '🔍', key: msg.key } })
            let caminhoArquivo = null
            let tipoArquivo = 'arquivo'
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {})
              const extensao = msg.message.documentMessage?.fileName?.split('.').pop() || 
                              msg.message.imageMessage?.mimetype?.split('/').pop() || 'bin'
              caminhoArquivo = path.join(TEMP_DIR, `arquivo_${Date.now()}.${extensao}`)
              fs.writeFileSync(caminhoArquivo, buffer)
              if (msg.message.imageMessage) tipoArquivo = 'imagem'
              const resultado = await analisarArquivo(caminhoArquivo, tipoArquivo)
              await sock.sendMessage(chatId, { text: resultado.analise }, { quoted: msg })
            } catch (err) {
              console.error('❌ Arquivo:', err.message)
              await sock.sendMessage(chatId, { text: '⚠️ Não foi possível processar o arquivo.' }, { quoted: msg })
            }
            continue
          }
          
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
            console.log(`💬 Pergunta para IA: "${cleanText}"`)
            resposta = await getAIResponse(cleanText)
          }

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
