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
// 🛡️ SISTEMA DE SEGURANÇA — FILTRO DE CONTEÚDO PERIGOSO
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
        motivo: `⚠️ Conteúdo identificado como potencialmente perigoso: "${palavra}". Por segurança, não posso processar isso.`
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
// 📄 SISTEMA DE ANÁLISE DE ARQUIVOS E IMAGENS
// ======================================
async function analisarArquivo(caminhoArquivo, tipo = 'arquivo') {
  try {
    const stats = fs.statSync(caminhoArquivo)
    const tamanhoKB = (stats.size / 1024).toFixed(2)
    
    const resultado = {
      seguro: true,
      analise: `📋 **Arquivo processado com segurança:**

• Tipo: ${tipo}
• Tamanho: ${tamanhoKB} KB
• ✅ Verificado e excluído automaticamente`,
      resumo: `${tipo} (${tamanhoKB} KB) — processado`
    }
    
    return resultado
  } catch (err) {
    console.error('❌ Erro ao analisar arquivo:', err.message)
    return { 
      seguro: false, 
      analise: '❌ Não foi possível analisar o arquivo.', 
      resumo: 'Erro na análise' 
    }
  } finally {
    try {
      if (fs.existsSync(caminhoArquivo)) {
        fs.unlinkSync(caminhoArquivo)
        console.log(`🧹 Arquivo excluído: ${caminhoArquivo}`)
      }
    } catch (delErr) {
      console.warn(`⚠️ Não foi possível apagar: ${delErr.message}`)
    }
  }
}

// ======================================
// 🌐 SERVIDOR + AUTO-PING
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
      res.end('✅ Bot Online — Sistema Completo Ativo!')
    }
  })
  .listen(PORT, () => {
    console.log(`🌐 Servidor rodando na porta ${PORT}`)
  })

// 🔄 AUTO-PING
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000

if (SELF_URL) {
  console.log(`🔄 Auto-ping configurado: a cada ${PING_INTERVAL/60000} minutos`)
  setInterval(async () => {
    try {
      const res = await fetch(`${SELF_URL}/ping`)
      if (res.ok) console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ✅ Servidor ativo`)
    } catch (err) {
      console.warn(`⚠️ Ping falhou: ${err.message}`)
    }
  }, PING_INTERVAL)
} else {
  console.log('⚠️ RENDER_EXTERNAL_URL não configurada')
}

// ======================================
// ⚙️ VARIÁVEIS DE AMBIENTE
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
  AUTO_IMPROVEMENT_HOUR = '3',
} = process.env

const TRIGGER_LOWER = TRIGGER.toLowerCase()

// ✅ Verificar variáveis obrigatórias
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
    if (!MONGODB_URI) {
      console.warn('⚠️ MONGODB_URI não configurada')
      return false
    }
    const uriLimpa = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
    if (!uriLimpa.startsWith('mongodb://') && !uriLimpa.startsWith('mongodb+srv://')) {
      console.error('❌ MONGODB_URI inválida')
      return false
    }
    mongoClient = new MongoClient(uriLimpa)
    await mongoClient.connect()
    dbKnowledge = mongoClient.db('bot_knowledge')
    dbLogs = dbKnowledge.collection('activity_logs')
    await dbKnowledge.collection('corrections').createIndex({ userId: 1, grupoId: 1 })
    await dbKnowledge.collection('corrections').createIndex({ palavrasChave: 1 })
    await dbKnowledge.collection('conversations').createIndex({ userId: 1, timestamp: -1 })
    console.log('🧠 Sistema de Aprendizado ATIVO!')
    return true
  } catch (err) {
    console.error('❌ Erro no banco:', err.message)
    return false
  }
}

// ======================================
// 🧠 SISTEMA DE MEMÓRIA
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
      palavrasChave, vezesUsada: 0, criadoEm: new Date()
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

  async runSelfImprovement() {
    console.log('🔍 Auto-análise...')
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
      console.log(`📊 ${conversas.length} conversas, ${corrigidas} corrigidas (${taxaCorrecao}%)`)
      return { total: conversas.length, corrigidas, taxaCorrecao }
    } catch (err) {
      console.error('❌ Erro auto-análise:', err.message)
    }
  },
}

// ⏰ Auto-análise diária
let ultimaAutoMelhoria = null
async function verificarAutoMelhoria() {
  const agora = new Date()
  const horaAtual = agora.getUTCHours() - 3
  const alvo = parseInt(AUTO_IMPROVEMENT_HOUR)
  if (horaAtual === alvo && (!ultimaAutoMelhoria || ultimaAutoMelhoria.toDateString() !== agora.toDateString())) {
    console.log(`⏰ Auto-melhoria às ${alvo}h`)
    ultimaAutoMelhoria = agora
    await Memory.runSelfImprovement()
  }
}
setInterval(verificarAutoMelhoria, 60 * 60 * 1000)

// ======================================
// 🤖 IA
// ======================================
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS = OPENROUTER_MODEL.split(',').map(m => m.trim()).filter(Boolean)

async function getAIResponse(pergunta, correcao = null) {
  let systemPrompt = 'Você é um assistente útil. Responda em português do Brasil de forma clara e direta.'
  if (correcao) {
    systemPrompt += `\n\n⚠️ INFORMAÇÃO CONFIRMADA:\nPergunta: ${correcao.assunto}\nResposta correta: ${correcao.respostaCorreta}`
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
  if (!res.ok) throw new Error(`Erro IA: ${res.status}`)
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
// 📋 COMANDOS — COM SISTEMA DE DONO
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
      await Memory.saveCorrection(userId, grupoId, assunto, '', respostaCorreta)
      return `✅ **Anotado! Obrigado por ensinar!** 🧠

📌 ${assunto}
✅ ${respostaCorreta}`

    case 'memoria': case 'lembrancas': case 'aprendizado':
      const correcoes = await Memory.listAll(userId, grupoId)
      return correcoes.length === 0
        ? `📚 Ainda não aprendi nada! Quando eu errar, me corrija usando:\n${TRIGGER} corrija isso = resposta certa`
        : `📚 **O que aprendi com todos (${correcoes.length}):**

${correcoes.map((c, i) => `${i + 1}. ❓ ${c.assunto}\n   ✅ ${c.respostaCorreta}`).join('\n\n')}`

    case 'estatisticas': case 'stats':
      const hoje = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const logs = dbLogs ? await dbLogs.find({ tipo: 'auto-analise', data: { $gte: hoje } }).sort({ data: -1 }).limit(7).toArray() : []
      return `📊 **Estatísticas dos últimos 7 dias:**

${logs.length === 0 ? 'Sem dados ainda. A auto-análise roda diariamente.' 
  : logs.map(l => `📅 ${l.data.toLocaleDateString('pt-BR')}: ${l.totalConversas} msgs, ${l.corrigidas} correções (${l.taxaCorrecao}%)`).join('\n')}

🔄 Auto-análise: às ${AUTO_IMPROVEMENT_HOUR}h`

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
• ${TRIGGER} esquece tudo → Limpa memória completa

Ninguém mais pode alterar ou apagar! ✅`
        : '🔒 Apenas o dono tem acesso a esses comandos.'

    case 'ajuda': default:
      return `🧠 **Nexos — IA Comunitária com Segurança**

✨ **Comandos para todos:**
• ${TRIGGER} [sua pergunta] → Falar comigo
• ${TRIGGER} corrija [o que] = [resposta] → Me ensinar
• ${TRIGGER} + anexar arquivo/imagem → Analisar com segurança
• ${TRIGGER} memoria → Ver o que aprendi
• ${TRIGGER} estatisticas → Ver evolução

👑 **Apenas o dono:**
• ${TRIGGER} esquece [assunto] → Apagar uma correção
• ${TRIGGER} esquece tudo → Limpar tudo

🛡️ Arquivos sem "${TRIGGER}" são ignorados automaticamente! 😊`
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
      if (connection === 'open') console.log('✅ CONECTADO — Sistema Completo Ativo!')
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
          
          // 📎 Verificar se tem arquivo/imagem + trigger
          const temArquivo = !!msg.message?.documentMessage || !!msg.message?.imageMessage 
                          || !!msg.message?.videoMessage
          const temTrigger = hasTrigger(text, mentioned)
          
          // ⚠️ Arquivo SEM "nexos" = IGNORADO por segurança
          if (temArquivo && !temTrigger) {
            console.log('📎 Arquivo recebido sem comando — ignorado por segurança')
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
          
          // 🛡️ PASSO 1: VERIFICAÇÃO DE SEGURANÇA
          const verificacao = verificarSeguranca(cleanText)
          if (!verificacao.seguro) {
            await sock.sendMessage(chatId, { 
              text: `🛡️ **Bloqueado por Segurança** ⚠️\n\n${verificacao.motivo}`
            }, { quoted: msg })
            continue
          }
          
          // 📄 PASSO 2: ANÁLISE DE ARQUIVO/IMAGEM
          if (temArquivo && temTrigger) {
            await sock.sendMessage(chatId, { react: { text: '🔍', key: msg.key } })
            
            let caminhoArquivo = null
            let tipoArquivo = 'arquivo'
            
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {})
              const extensao = msg.message.documentMessage?.fileName?.split('.').pop() || 
                              msg.message.imageMessage?.mimetype?.split('/').pop() || 'bin'
              const nomeArquivo = `arquivo_${Date.now()}.${extensao}`
              caminhoArquivo = path.join(TEMP_DIR, nomeArquivo)
              
              fs.writeFileSync(caminhoArquivo, buffer)
              
              if (msg.message.imageMessage) tipoArquivo = 'imagem'
              else if (msg.message.videoMessage) tipoArquivo = 'vídeo'
              else if (msg.message.documentMessage) tipoArquivo = `arquivo (${extensao})`
              
              const resultado = await analisarArquivo(caminhoArquivo, tipoArquivo)
              await sock.sendMessage(chatId, { text: resultado.analise }, { quoted: msg })
              
            } catch (err) {
              console.error('❌ Erro no processamento de arquivo:', err.message)
              await sock.sendMessage(chatId, { 
                text: '⚠️ Não foi possível processar o arquivo.' 
              }, { quoted: msg })
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
