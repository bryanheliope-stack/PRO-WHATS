import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 📂 Pastas necessárias
const TEMP_DIR = path.join(__dirname, 'temp')
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge')
const AUTH_DIR = path.join(__dirname, 'auth')
;[TEMP_DIR, KNOWLEDGE_DIR, AUTH_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
})

// ==========================================
// 🏓 SISTEMA DE PING
// ==========================================
const PING_SYSTEM = {
  url: process.env.RENDER_EXTERNAL_URL || process.env.PING_URL || '',
  interval: parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000,
  ultimoPing: null,
  falhasConsecutivas: 0,
  maxFalhas: 5,
  timer: null,

  async ping() {
    if (!this.url) return false
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, {
        method: 'GET',
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'EmuladorHelper/1.0' }
      })
      const tempo = Date.now() - inicio
      this.ultimoPing = {
        status: res.ok ? '✅ ONLINE' : '⚠️ RESPONDEU',
        codigo: res.status,
        tempo: `${tempo}ms`,
        hora: new Date().toLocaleString('pt-BR')
      }
      this.falhasConsecutivas = 0
      console.log(`🏓 Ping: ${this.ultimoPing.status} | ${tempo}ms`)
      return true
    } catch (err) {
      this.falhasConsecutivas++
      this.ultimoPing = {
        status: '❌ OFFLINE',
        erro: err.message,
        hora: new Date().toLocaleString('pt-BR')
      }
      console.warn(`🏓 Ping falhou (${this.falhasConsecutivas}/${this.maxFalhas}): ${err.message}`)
      return false
    }
  },

  iniciar() {
    if (!this.url) {
      console.log('ℹ️ Ping: Sem URL configurada — desativado.')
      return
    }
    console.log(`🏓 Ping iniciado: ${this.url} (a cada ${this.interval/60000}min)`)
    this.ping()
    this.timer = setInterval(() => this.ping(), this.interval)
  }
}

// ==========================================
// 🎮 BASE DE CONHECIMENTO DE EMULADORES
// ==========================================
const EmuladorBase = {
  dados: new Map(),
  arquivo: path.join(KNOWLEDGE_DIR, 'emulador_base.json'),

  carregar() {
    try {
      if (fs.existsSync(this.arquivo)) {
        const conteudo = fs.readFileSync(this.arquivo, 'utf8')
        const dados = JSON.parse(conteudo)
        for (const [chave, valor] of Object.entries(dados)) {
          this.dados.set(chave.toLowerCase(), valor)
        }
        console.log(`🎮 Base carregada: ${this.dados.size} verbetes`)
      } else {
        this.inicializarBase()
        this.salvar()
      }
    } catch (err) {
      console.warn(`⚠️ Erro ao carregar base: ${err.message}`)
      this.inicializarBase()
    }
  },

  inicializarBase() {
    const baseInicial = {
      'pcsx2': {
        categoria: 'emulador',
        nome: 'PCSX2',
        descricao: 'Emulador de PlayStation 2',
        configuracoes: {
          requisitos: 'CPU com SSE2, GPU OpenGL/Direct3D, 2GB+ RAM',
          resolucao: '1x (720p), 2x (1080p), 3x (4K)',
          dicas: 'Ative MTVU e EE Cyclerate para performance'
        },
        fonte: 'base'
      },
      'dolphin': {
        categoria: 'emulador',
        nome: 'Dolphin',
        descricao: 'Emulador de GameCube e Wii',
        configuracoes: {
          requisitos: 'CPU: i5-4670K+, GPU: OpenGL 4.4',
          backend: 'D3D11/Vulkan',
          resolucao: '1x a 5x'
        },
        fonte: 'base'
      },
      'yuzu': {
        categoria: 'emulador',
        nome: 'Yuzu',
        descricao: 'Emulador de Nintendo Switch',
        configuracoes: {
          backend: 'Vulkan recomendado',
          dicas: 'Ative Fast Memory e Multicore'
        },
        fonte: 'base'
      },
      'ryujinx': {
        categoria: 'emulador',
        nome: 'Ryujinx',
        descricao: 'Emulador de Switch — foco em precisão',
        fonte: 'base'
      },
      'ppsspp': {
        categoria: 'emulador',
        nome: 'PPSSPP',
        descricao: 'Emulador de PSP — leve e multiplataforma',
        resolucao: '1x a 5x',
        fonte: 'base'
      },
      'melhores emuladores': {
        categoria: 'guia',
        titulo: 'Melhores Emuladores',
        lista: [
          'PS1: DuckStation',
          'PS2: PCSX2',
          'PSP: PPSSPP',
          'GameCube/Wii: Dolphin',
          'Switch: Yuzu/Ryujinx',
          'SNES: Snes9x',
          'GBA: mGBA'
        ]
      },
      'melhorar performance': {
        categoria: 'dicas',
        titulo: 'Melhorar Performance',
        dicas: [
          '🔹 Reduza resolução interna',
          '🔹 Troque backend gráfico',
          '🔹 Ative multithreading',
          '🔹 Feche outros programas',
          '🔹 Ative Fast Memory'
        ]
      }
    }
    for (const [chave, valor] of Object.entries(baseInicial)) {
      this.dados.set(chave.toLowerCase(), valor)
    }
    console.log(`🎮 Base inicial: ${this.dados.size} verbetes`)
  },

  salvar() {
    try {
      fs.writeFileSync(this.arquivo, JSON.stringify(Object.fromEntries(this.dados), null, 2))
      return true
    } catch (err) { return false }
  },

  buscar(consulta, limite = 3) {
    const resultados = []
    const termos = consulta.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length > 2)
    for (const [chave, item] of this.dados) {
      let relevancia = 0
      for (const termo of termos) {
        if (chave.includes(termo)) relevancia += 5
        if (JSON.stringify(item).toLowerCase().includes(termo)) relevancia += 1
      }
      if (relevancia > 0) resultados.push({ chave, item, relevancia })
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, limite)
  },

  adicionar(pergunta, resposta, fonte = 'aprendizado') {
    this.dados.set(pergunta.toLowerCase().trim(), {
      categoria: 'aprendido',
      pergunta, resposta, fonte,
      aprendidoEm: new Date().toISOString()
    })
    this.salvar()
  },

  contar() { return this.dados.size }
}

// ==========================================
// 🧠 AUTO-APRENDIZADO
// ==========================================
const AutoAprendizado = {
  metricas: { total: 0, aprendidos: 0, corrigidos: 0 },
  arquivo: path.join(KNOWLEDGE_DIR, 'aprendizado.json'),

  carregar() {
    try {
      if (fs.existsSync(this.arquivo)) {
        const d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        this.metricas = { ...this.metricas, ...d.metricas }
      }
    } catch {}
  },

  salvar() {
    try {
      fs.writeFileSync(this.arquivo, JSON.stringify({ metricas: this.metricas }, null, 2))
    } catch {}
  },

  registrar(pergunta, resposta, foiCorrigida = false) {
    this.metricas.total++
    if (foiCorrigida) {
      this.metricas.corrigidos++
      EmuladorBase.adicionar(pergunta, resposta, 'comunidade')
    }
    this.salvar()
  }
}

// ==========================================
// 🤖 IA — MODELOS E SISTEMA
// ==========================================
const MODELOS = [
  'meta/llama-3.1-70b-instruct',
  'nousresearch/hermes-3-llama-3.1-70b',
  'mistralai/mistral-large-2-instruct',
  'nousresearch/hermes-2-pro-llama-3-8b',
  'mistralai/mistral-small-3.1-24b-instruct:free'
]

const SISTEMA_PROMPT = `Você é o EmuladorHelper, especialista em emuladores e configurações.

Conhecimento: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP, DuckStation, RetroArch.
Responda em português, claro e prático. Dê configurações, requisitos e dicas de performance.
Se não souber, seja honesto. Cada informação correta é salva automaticamente.`

async function getRespostaIA(pergunta, correcao = null) {
  // 🔍 Busca local primeiro
  const local = EmuladorBase.buscar(pergunta, 2)
  if (local.length > 0 && local[0].relevancia >= 3) {
    const item = local[0].item
    let resposta = ''
    if (item.categoria === 'emulador') {
      resposta = `🎮 **${item.nome}** — ${item.descricao}

📋 Requisitos: ${item.configuracoes?.requisitos || 'Consulte a documentação'}
💡 Dicas: ${item.configuracoes?.dicas || 'Ajuste conforme seu jogo'}`
    } else if (item.categoria === 'guia' && item.lista) {
      resposta = `📖 **${item.titulo}**\n\n${item.lista.join('\n')}`
    } else if (item.resposta) {
      resposta = item.resposta
    } else {
      resposta = JSON.stringify(item, null, 2).slice(0, 500)
    }
    AutoAprendizado.registrar(pergunta, resposta)
    return resposta
  }

  // ✅ Correção da comunidade
  if (correcao) {
    AutoAprendizado.registrar(pergunta, correcao.respostaCorreta, true)
    return `📝 **Informação salva!**\n\n${correcao.respostaCorreta}`
  }

  // 🌐 IA — OpenRouter
  const API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY
  if (!API_KEY) {
    return `🤔 Não tenho conexão com a IA no momento. Mas tenho informações salvas! Pergunte sobre: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP`
  }

  const systemPrompt = SISTEMA_PROMPT + (correcao 
    ? `\n\nINFORMAÇÃO CONFIRMADA:\n${correcao.assunto}: ${correcao.respostaCorreta}`
    : '')

  for (const modelo of MODELOS) {
    try {
      console.log(`🤖 Tentando: ${modelo}`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'http://localhost'
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 1200,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(25000)
      })

      if (!res.ok) throw new Error(`Status ${res.status}`)
      const dados = await res.json()
      const resposta = dados?.choices?.[0]?.message?.content?.trim()
      
      if (resposta) {
        console.log(`✅ Resposta de: ${modelo}`)
        AutoAprendizado.registrar(pergunta, resposta)
        return resposta
      }
    } catch (err) {
      console.warn(`⚠️ ${modelo}: ${err.message}`)
    }
  }

  return `🤔 Estou com dificuldades de conexão. Pergunte sobre emuladores que já conheço: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP`
}

// ==========================================
// 🛡️ SEGURANÇA
// ==========================================
const PALAVRAS_PROIBIDAS = ['senha', 'cartão', 'cpf', 'hackear', 'roubar', 'vírus', 'apagar tudo', 'formatar']
function verificarSeguranca(texto) {
  if (!texto) return true
  const lower = texto.toLowerCase()
  return !PALAVRAS_PROIBIDAS.some(p => lower.includes(p))
}

// ==========================================
// 🌐 SERVIDOR HTTP
// ==========================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'alive',
      timestamp: new Date().toISOString(),
      conhecimento: EmuladorBase.contar()
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('🎮 EmuladorHelper Online — Especialista em Emuladores')
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ==========================================
// 📱 BOT WHATSAPP — CÓDIGO DE PAREAMENTO (SEM QR CODE)
// ==========================================
const TRIGGER = (process.env.TRIGGER || '!').toLowerCase()
const PHONE_NUMBER = process.env.PHONE_NUMBER || ''
let codigoGerado = false

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

async function iniciarBot() {
  EmuladorBase.carregar()
  AutoAprendizado.carregar()
  console.log(`🎮 EmuladorHelper iniciado — ${EmuladorBase.contar()} verbetes`)

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
    if (connection === 'open') {
      console.log('✅ CONECTADO COM SUCESSO! 🎮')
      codigoGerado = false
    }

    if (connection === 'close') {
      const codigoErro = lastDisconnect?.error?.output?.statusCode
      console.log(`🔌 Desconectado — código: ${codigoErro}`)
      
      if (codigoErro === DisconnectReason.loggedOut || codigoErro === DisconnectReason.badSession) {
        console.log('🔑 Sessão inválida — reiniciando para gerar novo código...')
        codigoGerado = false
        setTimeout(iniciarBot, 5000)
        return
      }
      
      if (codigoErro !== DisconnectReason.connectionReplaced) {
        console.log('⏳ Reconectando em 5s...')
        setTimeout(iniciarBot, 5000)
      }
    }

    // 📲 GERAR CÓDIGO DE PAREAMENTO (SEM QR CODE)
    if (connection === 'connecting' && !sock.authState.creds.registered && !codigoGerado) {
      if (!PHONE_NUMBER) {
        console.error('❌ ERRO: Configure a variável PHONE_NUMBER!')
        console.error('👉 Formato: 55DD999999999 (apenas números, sem + e sem espaços)')
        return
      }

      const telefone = apenasDigitos(PHONE_NUMBER)
      if (telefone.length < 10 || telefone.length > 15) {
        console.error(`❌ Número inválido: "${PHONE_NUMBER}"`)
        console.error('👉 Formato correto: 5511999999999')
        return
      }

      codigoGerado = true
      console.log('⏳ Solicitando código de pareamento...')
      
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(telefone)
          console.log('\n' + '═'.repeat(55))
          console.log('📲 CÓDIGO DE PAREAMENTO GERADO!')
          console.log(`📱 Para o número: ${telefone.slice(0, 4)}...${telefone.slice(-4)}`)
          console.log(`🔑 CÓDIGO: ${codigo}`)
          console.log('')
          console.log('👉 ABRA O WHATSAPP NO SEU CELULAR:')
          console.log('   1. Toque em Configurações ⚙️')
          console.log('   2. Aparelhos Conectados')
          console.log('   3. Conectar com número de telefone')
          console.log('   4. Digite o código acima')
          console.log('═'.repeat(55) + '\n')
        } catch (err) {
          codigoGerado = false
          console.error(`❌ Erro ao gerar código: ${err.message}`)
        }
      }, 3000)
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
    const textoLimpo = texto.trim()
    const responder = (resposta) => {
      return sock.sendMessage(msg.key.remoteJid, { text: resposta }, { quoted: msg })
    }

    // 📋 Comandos
    if (textoLimpo.startsWith(TRIGGER)) {
      const cmd = textoLimpo.slice(TRIGGER.length).trim().toLowerCase()
      const [acao, ...resto] = cmd.split(/\s+/)
      const args = resto.join(' ')

      switch (acao) {
        case 'ajuda':
        case 'comandos':
          await responder(`🎮 **Comandos Disponíveis:**

${TRIGGER}ajuda — Mostra esta mensagem
${TRIGGER}ping — Verifica se estou online
${TRIGGER}memoria — Lista conhecimentos salvos
${TRIGGER}busca [termo] — Pesquisa na base local
${TRIGGER}corrige [assunto] = [resposta] — Me ensina algo novo

💡 Sem o comando, é só perguntar normalmente!`)
          break

        case 'ping':
          await responder(`🏓 **Pong!** Estou online e funcionando! 🎮`)
          break

        case 'memoria':
        case 'conhecimento':
          const itens = Array.from(EmuladorBase.dados.keys())
          await responder(`📚 **Base de Conhecimento:** ${itens.length} itens

${itens.slice(0, 15).map((k, i) => `${i+1}. ${k}`).join('\n')}

💡 Use "${TRIGGER}busca palavra" para detalhes`)
          break

        case 'busca':
          if (!args) {
            await responder(`🔍 Digite o que quer buscar:\n${TRIGGER}busca PCSX2`)
            break
          }
          const res = EmuladorBase.busca(args, 5)
          if (res.length === 0) {
            await responder(`🔍 Nada encontrado para: "${args}"`)
          } else {
            await responder(`🔍 **Resultados para "${args}":**\n\n${res.map((r, i) => `${i+1}. ${r.chave}`).join('\n')}`)
          }
          break

        case 'corrige':
        case 'salve':
          if (!args.includes('=')) {
            await responder(`📝 Use assim:\n${TRIGGER}corrige PCSX2 resolução = 2x para 1080p`)
            break
          }
          const [assunto, resp] = args.split('=').map(s => s.trim())
          if (!assunto || !resp) {
            await responder(`⚠️ Falta assunto ou resposta! Use: ${TRIGGER}corrige assunto = resposta`)
            break
          }
          EmuladorBase.adicionar(assunto, resp, 'comunidade')
          AutoAprendizado.registrar(assunto, resp, true)
          await responder(`✅ **SALVO E APRENDIDO! 🧠**\n\n📌 ${assunto}\n✅ ${resp}`)
          break

        default:
          await responder(`🤔 Comando não reconhecido. Use "${TRIGGER}ajuda" para ver os comandos.`)
      }
      return
    }

    // 💬 Perguntas normais
    if (!verificarSeguranca(texto)) {
      await responder('⚠️ Não posso ajudar com isso. Pergunte sobre emuladores! 🎮')
      return
    }

    console.log(`💬 Pergunta: ${texto}`)
    await sock.readMessages([msg.key])
    
    const resposta = await getRespostaIA(texto)
    await responder(resposta)
  })
}

iniciarBot().catch(err => {
  console.error('❌ Erro ao iniciar bot:', err)
})
