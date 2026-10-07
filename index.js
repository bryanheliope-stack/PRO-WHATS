import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoClient } from 'mongodb'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from './baileys.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 📂 Pastas
const TEMP_DIR = path.join(__dirname, 'temp_files')
const AUTH_DIR = path.join(__dirname, 'auth')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

// ======================================
// 🛡️ IGNORAR ERROS DE DESCRIPTOGRAFIA (Bad MAC)
// ======================================
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason)
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt') || msg.includes('decrypt message')) {
    return // Ignora sem encher o log
  }
  console.error('❌ Erro:', msg)
})

process.on('uncaughtException', (err) => {
  if (err.message?.includes('Bad MAC') || err.message?.includes('decrypt')) return
  console.error('❌ Erro fatal:', err)
})

// ======================================
// 🛡️ SISTEMA DE SEGURANÇA
// ======================================
const PALAVRAS_PERIGOSAS = [
  'senha', 'cartão', 'cpf', 'rg', 'documento', 'dados bancários',
  'hackear', 'invadir', 'roubar', 'vazamento', 'phishing', 'golpe',
  'vírus', 'malware', 'exploit', 'ddos', 'ataque', 'injetar',
  'quebrar', 'destruir', 'apagar tudo', 'formatar', 'deletar sistema'
]

function verificarSeguranca(texto) {
  if (!texto) return { seguro: true, motivo: '' }
  const textoVerificar = texto.toLowerCase()
  for (const palavra of PALAVRAS_PERIGOSAS) {
    if (textoVerificar.includes(palavra.toLowerCase())) {
      return { seguro: false, motivo: `⚠️ Conteúdo perigoso: "${palavra}". Não posso processar isso.` }
    }
  }
  const padroesProibidos = [/como (hackear|invadir|roubar)/i, /me dê (senha|chave|token)/i, /crie um (vírus|malware)/i]
  for (const p of padroesProibidos) if (p.test(texto)) return { seguro: false, motivo: '⚠️ Solicitação bloqueada.' }
  return { seguro: true, motivo: '' }
}

// ======================================
// 📄 ANÁLISE DE ARQUIVOS
// ======================================
async function analisarArquivo(caminhoArquivo, tipo = 'arquivo') {
  try {
    const stats = fs.statSync(caminhoArquivo)
    const tamanhoKB = (stats.size / 1024).toFixed(2)
    return { seguro: true, analise: `📋 ${tipo} — ${tamanhoKB} KB\n✅ Processado e excluído`, resumo: '' }
  } catch (err) {
    return { seguro: false, analise: '❌ Erro ao analisar', resumo: '' }
  } finally {
    try { if (fs.existsSync(caminhoArquivo)) fs.unlinkSync(caminhoArquivo) } catch {}
  }
}

// ======================================
// 🌐 SERVIDOR
// ======================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('✅ Bot Online')
}).listen(PORT, () => console.log(`🌐 Porta ${PORT}`))

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

const requiredEnv = ['PHONE_NUMBER', 'OPENROUTER_API_KEY']
const faltando = requiredEnv.filter(v => !process.env[v])
if (faltando.length > 0) {
  console.warn(`⚠️ Faltando: ${faltando.join(', ')}`)
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
    console.log('🧠 Banco conectado!')
    return true
  } catch (err) {
    console.warn('⚠️ Banco não disponível — funcionando sem memória')
    return false
  }
}

// ======================================
// 🧠 MEMÓRIA
// ======================================
const Memory = {
  async saveCorrection(userId, grupoId, assunto, respostaCorreta) {
    if (!dbKnowledge) return
    const palavrasChave = assunto.toLowerCase().replace(/[^\w\sàáâãçéêíóôõú]/g, ' ').split(/\s+/).filter(p => p.length > 2)
    return dbKnowledge.collection('corrections').insertOne({ userId, grupoId, assunto: assunto.trim(), respostaCorreta: respostaCorreta.trim(), palavrasChave, vezesUsada: 0, criadoEm: new Date() })
  },
  async checkCorrection(userId, grupoId, pergunta) {
    if (!dbKnowledge) return null
    const palavras = pergunta.toLowerCase().replace(/[^\w\sàáâãçéêíóôõú]/g, ' ').split(/\s+/).filter(p => p.length > 2)
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
    if (!dbKnowledge) return
    return dbKnowledge.collection('conversations').insertOne({ userId, grupoId, pergunta, resposta, foiCorrigida, timestamp: new Date() })
  },
  async listAll(userId, grupoId) {
    if (!dbKnowledge) return []
    return dbKnowledge.collection('corrections').find({ $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }] }).sort({ criadoEm: -1 }).toArray()
  },
  async delete(userId, grupoId, assunto) {
    if (!dbKnowledge) return
    return dbKnowledge.collection('corrections').deleteOne({ $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }], assunto: { $regex: new RegExp(`^${assunto}$`, 'i') } })
  },
  async clearAll(userId, grupoId) {
    if (!dbKnowledge) return
    return dbKnowledge.collection('corrections').deleteMany({ $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }] })
  },
}

// ======================================
// 🤖 IA
// ======================================
async function getOpenRouterResponse(pergunta, correcao = null) {
  if (!OPENROUTER_API_KEY) return null
  let systemPrompt = 'Você é um assistente útil. Responda SEMPRE em português do Brasil de forma clara e natural. Seja direto e amigável.'
  if (correcao) systemPrompt += `\n\nINFORMAÇÃO CONFIRMADA:\n${correcao.assunto} = ${correcao.respostaCorreta}`

  const modelos = OPENROUTER_MODEL.split(',').map(m => m.trim()).filter(Boolean)
  for (const modelo of modelos) {
    try {
      console.log(`🤖 IA: ${modelo}`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://localhost',
        },
        body: JSON.stringify({ model: modelo, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: pergunta }], max_tokens: 1500, temperature: 0.7 }),
        signal: AbortSignal.timeout(parseInt(AI_TIMEOUT)),
      })
      if (!res.ok) throw new Error(`Status: ${res.status}`)
      const data = await res.json()
      const r = data?.choices?.[0]?.message?.content?.trim()
      if (r) return r
    } catch (err) {
      console.warn(`⚠️ ${modelo}: ${err.message}`)
    }
  }
  return null
}

async function getNVIDIAResponse(pergunta, correcao = null) {
  if (!NVIDIA_API_KEY) return null
  let systemPrompt = 'Responda em português do Brasil de forma clara.'
  if (correcao) systemPrompt += `\n${correcao.assunto} = ${correcao.respostaCorreta}`
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${NVIDIA_API_KEY}` },
      body: JSON.stringify({ model: 'meta/llama-3.1-70b-instruct', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: pergunta }], max_tokens: 1024, temperature: 0.7 }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new Error()
    const data = await res.json()
    return data?.choices?.[0]?.message?.content?.trim()
  } catch { return null }
}

async function getAIResponse(pergunta, correcao = null) {
  let r = await getOpenRouterResponse(pergunta, correcao)
  if (r) return r
  r = await getNVIDIAResponse(pergunta, correcao)
  if (r) return r
  return '🤔 Desculpe, estou com dificuldades. Tente novamente em instantes.'
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
    case 'corrija': case 'aprenda':
      let assunto, respostaCorreta
      if (resto.includes('=') || resto.includes('é')) {
        const sep = resto.includes('=') ? '=' : 'é'
        const s = resto.split(new RegExp(` ${sep} `), 2)
        assunto = s[0]?.trim()
        respostaCorreta = s[1]?.trim()
      }
      if (!respostaCorreta && quotedText) { assunto = resto || 'info'; respostaCorreta = quotedText }
      if (!assunto || !respostaCorreta) return `📝 Use: ${TRIGGER} corrija [o que] = [resposta]`
      await Memory.saveCorrection(userId, grupoId, assunto, respostaCorreta)
      return `✅ Anotado! 🧠\n📌 ${assunto}\n✅ ${respostaCorreta}`

    case 'memoria':
      const correcoes = await Memory.listAll(userId, grupoId)
      return correcoes.length === 0 ? `📚 Ainda não aprendi nada!` : `📚 Memória (${correcoes.length}):\n\n${correcoes.map((c, i) => `${i+1}. ${c.assunto}\n   → ${c.respostaCorreta}`).join('\n\n')}`

    case 'esquece': case 'apague':
      if (!ehDono) return '🔒 Apenas o dono pode apagar.'
      if (!resto || resto === 'tudo') {
        if (resto === 'tudo') { await Memory.clearAll(userId, grupoId); return '🗑️ Memória limpa! ✅' }
        return `Uso: ${TRIGGER} esquece [assunto]`
      }
      await Memory.delete(userId, grupoId, resto)
      return `🗑️ Esqueci: "${resto}" ✅`

    case 'ajuda':
      return `🧠 **Nexos — IA Comunitária**

✨ Todos:
• ${TRIGGER} [pergunta] → Falar comigo
• ${TRIGGER} corrija [o que] = [resposta] → Me ensinar
• ${TRIGGER} + arquivo/imagem → Analisar
• ${TRIGGER} memoria → Ver o que aprendi

👑 Dono:
• ${TRIGGER} esquece [assunto] → Apagar
• ${TRIGGER} esquece tudo → Limpar tudo`

    default:
      return null
  }
}

// ======================================
// 🚀 INICIAR BOT — CORRIGIDO COM RECONEXÃO
// ======================================
async function start() {
  try {
    await initDB()

    // ✅ USANDO ARQUIVOS LOCAIS DE AUTENTICAÇÃO (mais estável que MongoDB)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const { version } = await fetchLatestBaileysVersion()
    console.log(`🤖 Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      markOnlineOnConnect: false,
      syncFullHistory: false, // ✅ Mais rápido
    })

    // ✅ Código de pareamento
    if (!sock.authState.creds.registered) {
      if (!PHONE_NUMBER) {
        console.error('❌ Configure PHONE_NUMBER! Ex: 5511999999999')
        process.exit(1)
      }
      await new Promise(r => setTimeout(r, 3000))
      console.log('🔍 Solicitando código de pareamento...')
      const code = await sock.requestPairingCode(PHONE_NUMBER)
      console.log('\n' + '='.repeat(50))
      console.log(`📲 CÓDIGO: ${code}`)
      console.log('👉 Abra o WhatsApp → Aparelhos → Conectar com número')
      console.log('👉 Digite o código acima')
      console.log('='.repeat(50) + '\n')
    }

    sock.ev.on('creds.update', saveCreds)

    // ✅ Conexão com reconexão inteligente
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      console.log(`🔌 Status: ${connection}`)
      
      if (connection === 'open') {
        console.log('✅ CONECTADO COM SUCESSO! 🎉')
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        const erroMsg = lastDisconnect?.error?.message || 'Desconhecido'
        console.log(`⚠️ Desconectado. Código: ${code} — ${erroMsg}`)

        // ✅ Se for erro de autenticação LIMPA TUDO e recomeça
        const deveReconectar = [
          DisconnectReason.loggedOut,
          DisconnectReason.connectionReplaced,
          DisconnectReason.badSession,
          DisconnectReason.multideviceMismatch,
        ].includes(code)

        if (deveReconectar) {
          console.log('🔄 Sessão inválida — limpando credenciais...')
          // Limpa pasta de autenticação
          try {
            for (const f of fs.readdirSync(AUTH_DIR)) {
              if (f !== 'creds.json') fs.unlinkSync(path.join(AUTH_DIR, f))
            }
          } catch {}
          console.log('⏳ Reiniciando em 5 segundos...')
          setTimeout(start, 5000)
        } else if (code !== DisconnectReason.connectionReplaced) {
          console.log('⏳ Reconectando em 5 segundos...')
          setTimeout(start, 5000)
        }
      }
    })

    // ✅ Processar mensagens
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
          
          if (temArquivo && !temTrigger) continue
          if (!temTrigger && !temArquivo) continue
          if (!groupAllowed(chatId)) continue

          const ids = senderIds(msg)
          const userId = ids[0] || 'geral'
          const grupoId = chatId.split('@')[0]
          const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage
          const quotedText = getText(quotedMsg).trim()

          if (!userAllowed(ids)) continue

          const cleanText = text.replace(new RegExp(TRIGGER_LOWER, 'gi'), '').replace(/@\d+\s*/g, '').trim()
          
          // 🛡️ Segurança
          const verificacao = verificarSeguranca(cleanText)
          if (!verificacao.seguro) {
            await sock.sendMessage(chatId, { text: `🛡️ ${verificacao.motivo}` }, { quoted: msg })
            continue
          }
          
          // 📄 Arquivos
          if (temArquivo && temTrigger) {
            await sock.sendMessage(chatId, { react: { text: '🔍', key: msg.key } })
            let caminhoArquivo = null
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {})
              const extensao = msg.message.documentMessage?.fileName?.split('.').pop() || 
                              msg.message.imageMessage?.mimetype?.split('/').pop() || 'bin'
              caminhoArquivo = path.join(TEMP_DIR, `arquivo_${Date.now()}.${extensao}`)
              fs.writeFileSync(caminhoArquivo, buffer)
              const tipo = msg.message.imageMessage ? 'imagem' : 'arquivo'
              const res = await analisarArquivo(caminhoArquivo, tipo)
              await sock.sendMessage(chatId, { text: res.analise }, { quoted: msg })
            } catch (err) {
              console.error('❌ Arquivo:', err.message)
              await sock.sendMessage(chatId, { text: '⚠️ Não foi possível processar o arquivo.' }, { quoted: msg })
            }
            continue
          }
          
          // 📋 Comandos
          const respostaComando = await processCommand(cleanText, userId, grupoId, quotedText)
          if (respostaComando) {
            await sock.sendMessage(chatId, { text: respostaComando }, { quoted: msg })
            continue
          }
          
          // 🤖 IA
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
            console.log(`💬 Pergunta: "${cleanText}"`)
            resposta = await getAIResponse(cleanText)
          }

          await Memory.saveConversation(userId, grupoId, cleanText, resposta, !!correcao)
          await sock.sendMessage(chatId, { text: resposta }, { quoted: msg })
          await sock.sendPresenceUpdate('paused', chatId)

        } catch (err) {
          // Ignora erros de descriptografia silenciosamente
          if (err.message?.includes('Bad MAC') || err.message?.includes('decrypt')) return
          console.error('❌ Erro na mensagem:', err.message)
        }
      }
    })
  } catch (err) {
    console.error('[Inicialização]', err.message)
    console.log('⏳ Reiniciando em 5 segundos...')
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
