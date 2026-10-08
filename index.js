import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
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
const CONFIG = {
  GATILHO: (process.env.GATILHO || 'nexos').toLowerCase(),
  PREFIXO_COMANDOS: (process.env.TRIGGER || '!').toLowerCase(),
  PHONE_NUMBER: process.env.PHONE_NUMBER || '',
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',
  PING_INTERVAL: parseInt(process.env.PING_INTERVAL || '240000'),
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000
}

console.log(`🔐 Gatilho: "${CONFIG.GATILHO}"`)
console.log(`🚫 Bloqueio de grupos: ✅`)
console.log(`🖼️ Ignora GIFs: ✅`)

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
    } catch {
      return false
    }
  },

  bloquear(grupoJid) {
    this.bloqueados.add(grupoJid)
    this.salvar()
  },

  liberar(grupoJid) {
    this.bloqueados.delete(grupoJid)
    this.salvar()
  },

  estaBloqueado(grupoJid) {
    return this.bloqueados.has(grupoJid)
  },

  listarBloqueados() {
    return [...this.bloqueados]
  }
}

GrupoManager.carregar()

// ==========================================
// 🤖 SISTEMA DE IA — OpenRouter + NVIDIA
// ==========================================
const IA_Generativa = {
  cache: new Map(),

  async perguntarOpenRouter(pergunta) {
    if (!CONFIG.OPENROUTER_API_KEY) return null
    const cacheKey = `or:${pergunta.toLowerCase()}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://localhost'
        },
        body: JSON.stringify({
          model: CONFIG.OPENROUTER_MODEL || 'meta/llama-3.1-70b-instruct',
          messages: [
            { role: 'system', content: 'Você é um assistente útil, amigável e direto. Responda em português, claro e conciso.' },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      })
      if (!res.ok) throw new Error(`OpenRouter: ${res.status}`)
      const dados = await res.json()
      const resposta = dados.choices?.[0]?.message?.content
      if (resposta) {
        this.cache.set(cacheKey, resposta)
        if (this.cache.size > 30) this.cache.clear()
      }
      return resposta
    } catch (err) {
      console.warn(`⚠️ OpenRouter falhou: ${err.message}`)
      return null
    }
  },

  async perguntarNVIDIA(pergunta) {
    if (!CONFIG.NVIDIA_API_KEY) return null
    const cacheKey = `nvidia:${pergunta.toLowerCase()}`
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta/llama3-70b-instruct',
          messages: [
            { role: 'system', content: 'Você é um assistente útil, amigável e direto. Responda em português.' },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 600,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      })
      if (!res.ok) throw new Error(`NVIDIA: ${res.status}`)
      const dados = await res.json()
      const resposta = dados.choices?.[0]?.message?.content
      if (resposta) {
        this.cache.set(cacheKey, resposta)
        if (this.cache.size > 30) this.cache.clear()
      }
      return resposta
    } catch (err) {
      console.warn(`⚠️ NVIDIA falhou: ${err.message}`)
      return null
    }
  },

  async perguntar(pergunta) {
    let resposta = await this.perguntarOpenRouter(pergunta)
    if (!resposta) resposta = await this.perguntarNVIDIA(pergunta)
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
  ultimoPing: null,

  async ping() {
    if (!this.url) return false
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, { 
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'WhatsApp-Bot-Ping/1.0' }
      })
      this.ultimoPing = new Date().toLocaleTimeString('pt-BR')
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
      const prompt = encodeURIComponent(`${termo}, interface limpa, alta qualidade`)
      const img = {
        url: `https://image.pollinations.ai/prompt/${prompt}?width=800&height=600&nologo=true`,
        autor: 'Pollinations AI',
        pagina: 'https://pollinations.ai'
      }
      this.cache.set(cacheKey, img)
      if (this.cache.size > 50) this.cache.clear()
      return [img]
    } catch {
      return []
    }
  }
}

// ==========================================
// 🧠 BASE DE CONHECIMENTO
// ==========================================
const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const STOPWORDS = new Set(['de','do','da','no','na','em','um','uma','os','as','ou','se','eu','me','pra','para','com','que','qual','como','sobre','é','a','o','quais','quem','onde','quando','por'])

const EmuladorBase = {
  dados: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),

  carregar() {
    this.inicializarBase()
    try {
      if (fs.existsSync(this.arquivo)) {
        const salvos = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        for (const [chave, valor] of Object.entries(salvos)) {
          if (valor.custom) this.dados.set(chave.toLowerCase(), valor)
        }
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao ler base: ${err.message}`)
    }
    this.salvar()
  },

  inicializarBase() {
    const base = {
      'winlator': {
        titulo: '🪟 Winlator — Jogos de Windows no Celular!',
        descricao: 'App que roda jogos de Windows no Android. Combina Box64 + Wine.',
        requisitos: 'Android 10+ | Snapdragon 720G+ | 4GB RAM mínimo',
        site: 'winlator.dev',
        termoImagem: 'Winlator Android app'
      },
      'gamehub': {
        titulo: '🎮 GameHub — Emulador de Windows',
        descricao: 'Novo app da mesma equipe do Winlator. Mais fácil de usar, usa Proton.',
        requisitos: 'Android 10+ | Snapdragon 8 Gen 1+ ideal | 6GB RAM',
        site: 'winlator.dev/gamehub',
        termoImagem: 'GameHub Android app'
      },
      'winlator vs gamehub': {
        titulo: '🪟 Winlator vs GameHub — Qual Escolher?',
        winlator: ['✅ Mais leve', '✅ Mais opções avançadas', '❌ Interface técnica'],
        gamehub: ['✅ Mais fácil', '✅ Organiza jogos', '✅ Usa Proton', '❌ Um pouco mais pesado'],
        conclusao: 'Iniciante → GameHub. Controle total → Winlator. Pode usar os dois!'
      }
    }
    for (const [chave, valor] of Object.entries(base)) {
      this.dados.set(chave.toLowerCase(), valor)
    }
    console.log(`🎮 Base carregada: ${this.dados.size} tópicos`)
  },

  salvar() {
    try { fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.dados), null, 2)); return true }
    catch { return false }
  },

  buscar(pergunta, limite = 5) {
    const resultados = []
    const perguntaNorm = normalizar(pergunta)
    const termos = perguntaNorm.split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t))

    for (const [chave, item] of this.dados) {
      let relevancia = 0
      const chaveNorm = normalizar(chave)
      const textoItem = normalizar(JSON.stringify(item))

      if (chaveNorm === perguntaNorm) relevancia += 100
      else if (chaveNorm.includes(perguntaNorm) || perguntaNorm.includes(chaveNorm)) relevancia += 50
      for (const termo of termos) {
        if (chaveNorm.includes(termo)) relevancia += 15
        if (textoItem.includes(termo)) relevancia += 3
      }
      if (relevancia > 0) resultados.push({ chave, item, relevancia })
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, limite)
  }
}

// ==========================================
// 🧠 GERADOR DE RESPOSTAS
// ==========================================
const GeradorResposta = {
  gerar(item) {
    let r = ''
    if (item.titulo) r += `${item.titulo}\n\n`
    if (item.descricao) r += `${item.descricao}\n\n`
    if (item.requisitos) r += `📋 Requisitos: ${item.requisitos}\n\n`
    if (item.winlator) r += `🪟 Winlator:\n${item.winlator.join('\n')}\n\n`
    if (item.gamehub) r += `🎮 GameHub:\n${item.gamehub.join('\n')}\n\n`
    if (item.conclusao) r += `💡 ${item.conclusao}\n`
    if (item.site) r += `🌐 ${item.site}\n`
    return r.trim()
  }
}

// ==========================================
// 💬 PROCESSADOR
// ==========================================
async function processarMensagem(pergunta) {
  const resultados = EmuladorBase.buscar(pergunta, 5)

  if (resultados.length === 0) {
    const respostaIA = await IA_Generativa.perguntar(pergunta)
    if (respostaIA) return { tipo: 'ia', texto: respostaIA }
    return { tipo: 'nenhum', texto: `🤔 Não tenho isso.\nTente: Winlator, GameHub, DXVK, Eden, PPSSPP 😊` }
  }

  if (resultados.length === 1) {
    return { tipo: 'unico', texto: GeradorResposta.gerar(resultados[0].item), item: resultados[0].item }
  }

  let texto = `🔍 Encontrei ${resultados.length} coisas:\n\n`
  resultados.forEach((r, i) => texto += `${i + 1}. ${r.item.titulo || r.chave}\n`)
  texto += `\n👉 Me diga qual você quer ver!`
  return { tipo: 'multiplo', texto }
}

// ==========================================
// 🌐 SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'online', versao: '8.1-pareamento-fix' }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`✅ Bot Online — Pareamento Corrigido`)
  }
}).listen(PORT, () => PING_SYSTEM.iniciar())

// ==========================================
// 📱 FUNÇÕES AUXILIARES
// ==========================================
function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

function ehGif(mensagem) {
  if (mensagem.message?.gifPlayback) return true
  if (mensagem.message?.videoMessage?.gifPlayback) return true
  return false
}

// ==========================================
// 📱 BOT WHATSAPP — PAREAMENTO CORRIGIDO
// ==========================================
let codigoJaGerado = false
let reconectarTentativas = 0

async function iniciarBot() {
  EmuladorBase.carregar()

  // ✅ Verifica se já tem sessão salva
  const temSessao = fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
  if (temSessao) {
    console.log('✅ Sessão encontrada — reconectando...')
  } else {
    console.log('🔑 Nova sessão — será necessário parear')
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    // ✅ CONECTADO COM SUCESSO
    if (connection === 'open') {
      console.log('✅✅✅ CONECTADO AO WHATSAPP!')
      codigoJaGerado = false
      reconectarTentativas = 0
      return
    }

    // 🔌 DESCONECTADO — TRATAMENTO
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — Código: ${codigo}`)

      // Se deslogado de verdade → limpa sessão
      if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.badSession) {
        console.log('⚠️ Sessão encerrada — limpando...')
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
        codigoJaGerado = false
      }

      // Reconecta depois de 5s
      reconectarTentativas++
      const espera = Math.min(5000 * reconectarTentativas, 30000)
      console.log(`🔄 Reconectando em ${espera/1000}s...`)
      setTimeout(iniciarBot, espera)
      return
    }

    // 📱 GERAR CÓDIGO DE PAREAMENTO — SIMPLES E DIRETO
    if (connection === 'connecting') {
      // Se JÁ tem sessão salva → não precisa de código
      if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('🔑 Usando sessão existente...')
        return
      }

      // Se JÁ gerou o código antes → não gera de novo
      if (codigoJaGerado) {
        console.log('📲 Código já foi enviado — aguardando pareamento...')
        return
      }

      // Valida número de telefone
      if (!CONFIG.PHONE_NUMBER) {
        console.error('❌ ERRO: Configure PHONE_NUMBER nas variáveis de ambiente!')
        console.error('👉 Exemplo: PHONE_NUMBER=5511999999999')
        return
      }

      const telefone = apenasDigitos(CONFIG.PHONE_NUMBER)
      if (telefone.length < 10) {
        console.error(`❌ Número inválido: "${CONFIG.PHONE_NUMBER}"`)
        console.error('👉 Use código do país + DDD + número. Ex: 5511999999999')
        return
      }

      // ✅ TUDO CERTO → GERA O CÓDIGO
      codigoJaGerado = true
      console.log('📲 Gerando código de pareamento...')

      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(telefone)
          console.log('\n' + '╔' + '═'.repeat(48) + '╗')
          console.log('║' + ' '.repeat(10) + '📲 CÓDIGO DE PAREAMENTO' + ' '.repeat(11) + '║')
          console.log('╠' + '═'.repeat(48) + '╣')
          console.log(`║  🔑 ${codigo}${' '.repeat(40 - codigo.length)}║`)
          console.log('╠' + '═'.repeat(48) + '╣')
          console.log('║  📱 Abra o WhatsApp no seu celular               ║')
          console.log('║  → Configurações → Aparelhos Conectados        ║')
          console.log('║  → Toque em "Conectar um aparelho"             ║')
          console.log('║  → Digite o código acima                       ║')
          console.log('╚' + '═'.repeat(48) + '╝\n')
        } catch (erro) {
          codigoJaGerado = false
          console.error(`❌ Erro ao gerar código: ${erro.message}`)
          console.log('🔄 Tentando novamente em 5 segundos...')
          setTimeout(iniciarBot, 5000)
        }
      }, 2000)
    }
  })

  // 💬 MENSAGENS RECEBIDAS
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const remetente = msg.key.remoteJid
    const ehGrupo = isJidGroup(remetente)

    // 🚫 Ignora GIFs
    if (ehGif(msg)) return

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const textoTrim = texto.trim()

    // 🛡️ Sem gatilho = silêncio
    if (!textoTrim.toLowerCase().startsWith(CONFIG.GATILHO)) return

    // 🔒 Grupo bloqueado = ignora
    if (ehGrupo && GrupoManager.estaBloqueado(remetente)) {
      console.log(`🚫 Grupo bloqueado: ${remetente}`)
      return
    }

    const pergunta = textoTrim.slice(CONFIG.GATILHO.length).trim()
    const responder = (txt) => sock.sendMessage(remetente, { text: txt }, { quoted: msg })

    // 📋 Comandos diretos
    if (pergunta === 'bloquear grupo') {
      if (ehGrupo) {
        GrupoManager.bloquear(remetente)
        await responder('🔒 Grupo BLOQUEADO! Não vou mais responder aqui.\nPara liberar: nexos liberar grupo')
      } else {
        await responder('⚠️ Só funciona em grupos!')
      }
      return
    }

    if (pergunta === 'liberar grupo') {
      if (ehGrupo) {
        GrupoManager.liberar(remetente)
        await responder('🔓 Grupo LIBERADO! Voltando a responder normalmente.')
      } else {
        await responder('⚠️ Só funciona em grupos!')
      }
      return
    }

    if (pergunta === '!ajuda' || pergunta === 'ajuda') {
      await responder(`📋 **Comandos:**

nexos bloquear grupo → IA para de responder aqui
nexos liberar grupo → IA volta a responder
nexos !ping → Verifica se estou online
nexos !gruposs → Ver grupos bloqueados

💡 Sempre comece com: **nexos**`)
      return
    }

    if (pergunta === '!ping' || pergunta === 'ping') {
      await responder('🏓 Pong! Online e pronto! 🎮')
      return
    }

    if (pergunta === '!gruposs' || pergunta === 'gruposs') {
      const lista = GrupoManager.listarBloqueados()
      await responder(lista.length === 0 
        ? '✅ Nenhum grupo bloqueado!'
        : `🔒 Grupos bloqueados:\n${lista.map(g=>`• ${g}`).join('\n')}`)
      return
    }

    if (!pergunta) {
      await responder('👋 Olá! Em que posso te ajudar? 😊')
      return
    }

    // 💬 Processa pergunta
    const resultado = await processarMensagem(pergunta)
    
    if (resultado.tipo === 'unico' && resultado.item?.termoImagem) {
      const imgs = await BuscaImagens.buscar(resultado.item.termoImagem)
      if (imgs[0]) {
        try {
          await sock.sendMessage(remetente, {
            image: { url: imgs[0].url },
            caption: resultado.texto + `\n📸 ${imgs[0].autor}`
          }, { quoted: msg })
          return
        } catch {
          await responder(resultado.texto + `\n🖼️ ${imgs[0].url}`)
          return
        }
      }
    }
    
    await responder(resultado.texto)
  })
}

// 🚨 PROTEÇÃO
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro fatal:', err.message)
  setTimeout(iniciarBot, 5000)
})

// 🚀 INICIA
iniciarBot().catch(err => {
  console.error('❌ Falha crítica:', err.message)
  setTimeout(iniciarBot, 10000)
})
