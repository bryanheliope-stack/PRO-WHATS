import pino from 'pino'
import http from 'node:http'
import fetch from 'node-fetch'
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

// 📂 Pastas
const TEMP_DIR = path.join(__dirname, 'temp_files')
const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge')
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true })
if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true })

// ======================================
// 🛡️ IGNORAR ERROS DE DESCRIPTOGRAFIA
// ======================================
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason)
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt') || msg.includes('link dead')) return
  console.error('❌ Erro:', msg)
})

// ======================================
// 🔧 SISTEMA DE PING MELHORADO E CORRIGIDO
// ======================================
const PING_SYSTEM = {
  url: process.env.RENDER_EXTERNAL_URL || process.env.PING_URL || '',
  interval: parseInt(process.env.PING_INTERVAL_MINUTES || '5') * 60 * 1000,
  ultimoPing: null,
  proximoPing: null,
  falhasConsecutivas: 0,
  maxFalhas: 5,
  timer: null,

  async ping() {
    if (!this.url) return false
    try {
      const inicio = Date.now()
      const res = await fetch(`${this.url}/ping`, {
        method: 'GET',
        timeout: 15000,
        headers: { 'User-Agent': 'NexosBot-PingSystem/1.0' }
      })
      const tempo = Date.now() - inicio
      this.ultimoPing = {
        status: res.ok ? '✅ ONLINE' : '⚠️ RESPONDEU',
        codigo: res.status,
        tempo: `${tempo}ms`,
        hora: new Date().toLocaleString('pt-BR')
      }
      this.falhasConsecutivas = 0
      console.log(`🏓 Ping: ${this.ultimoPing.status} | ${tempo}ms | ${this.ultimoPing.hora}`)
      return true
    } catch (err) {
      this.falhasConsecutivas++
      this.ultimoPing = {
        status: '❌ OFFLINE',
        erro: err.message,
        hora: new Date().toLocaleString('pt-BR')
      }
      console.warn(`🏓 Ping falhou (${this.falhasConsecutivas}/${this.maxFalhas}): ${err.message}`)
      
      // ⚠️ Se falhar muito, avisa no log
      if (this.falhasConsecutivas >= this.maxFalhas) {
        console.error('🚨 Muitas falhas no ping! Verifique a conexão ou a URL.')
      }
      return false
    }
  },

  iniciar() {
    if (!this.url) {
      console.log('ℹ️ PING: Nenhuma URL configurada — sistema de ping desativado.')
      return
    }
    console.log(`🏓 Sistema de ping iniciado: ${this.url} (a cada ${this.interval/60000}min)`)
    this.ping() // Primeiro ping imediato
    this.timer = setInterval(() => this.ping(), this.interval)
  },

  parar() {
    if (this.timer) clearInterval(this.timer)
    console.log('🏓 Sistema de ping parado.')
  },

  status() {
    return this.ultimoPing || { status: '⏳ Aguardando primeiro ping...' }
  }
}

// ======================================
// 🎮 BASE DE CONHECIMENTO DE EMULADORES
// ======================================
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
        console.log(`🎮 Base de emuladores carregada: ${this.dados.size} verbetes`)
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
        descricao: 'Emulador de PlayStation 2 para PC',
        configuracoes: {
          requisitos: 'CPU: SSE2 suportado, GPU: Direct3D/OpenGL, RAM: 2GB+',
          melhores_plugins: 'GSdx (gráficos), SPU2-X (áudio), LilyPad (controles)',
          dicas_performance: 'Ative o MTVU e EE Cyclerate para jogos lentos. Use modo de thread seguro.',
          resolucao_recomendada: '1x Nativo (720p) → 2x (1080p) → 3x (4K)'
        },
        fonte: 'base-conhecimento'
      },
      'dolphin': {
        categoria: 'emulador',
        nome: 'Dolphin',
        descricao: 'Emulador de GameCube e Wii',
        configuracoes: {
          requisitos: 'CPU: Intel Core i5-4670K ou equivalente, GPU: OpenGL 4.4',
          melhor_config: 'Backend: D3D11, Internal Resolution: 3x, Ubershaders: Síncrono',
          controles: 'Suporta Wiimote, controle de GameCube, teclado e joystick',
          compatibilidade: '98% dos jogos jogáveis'
        },
        fonte: 'base-conhecimento'
      },
      'yuzu': {
        categoria: 'emulador',
        nome: 'Yuzu',
        descricao: 'Emulador de Nintendo Switch',
        configuracoes: {
          requisitos: 'CPU: 4 núcleos com ARM64 ou x86-64, GPU: Vulkan/OpenGL 4.6',
          backend_recomendado: 'Vulkan (melhor performance)',
          resolucao: '1x, 2x, 3x, 4x',
          dicas: 'Ative o Fast Memory. Use multicore para melhor velocidade.'
        },
        fonte: 'base-conhecimento'
      },
      'ryujinx': {
        categoria: 'emulador',
        nome: 'Ryujinx',
        descricao: 'Emulador de Nintendo Switch — alternativa ao Yuzu',
        configuracoes: {
          requisitos: '.NET 8, GPU com Vulkan',
          diferencas: 'Mais preciso, compatibilidade ligeiramente diferente, foco em precisão',
          performance: 'Depende do jogo — alguns mais rápidos que Yuzu, outros mais lentos'
        },
        fonte: 'base-conhecimento'
      },
      'ppsspp': {
        categoria: 'emulador',
        nome: 'PPSSPP',
        descricao: 'Emulador de PlayStation Portable (PSP)',
        configuracoes: {
          requisitos: 'Muito leve — roda em celular antigo',
          resolucao: '1x, 2x, 3x, até 5x',
          dicas: 'Ative o Buffering de Quadros para reduzir tremores. Use o backend OpenGL ES em mobile.'
        },
        fonte: 'base-conhecimento'
      },
      'melhores emuladores por plataforma': {
        categoria: 'guia',
        titulo: 'Melhores Emuladores por Plataforma',
        lista: [
          '🎮 PS1: DuckStation / ePSXe',
          '🎮 PS2: PCSX2',
          '🎮 PSP: PPSSPP',
          '🎮 GameCube/Wii: Dolphin',
          '🎮 Switch: Yuzu / Ryujinx',
          '🎮 N64: Project64 / Simple64',
          '🎮 GBA/DS: mGBA / DeSmuME',
          '🎮 SNES: Snes9x / bsnes'
        ]
      },
      'configurar controles emulador': {
        categoria: 'tutorial',
        titulo: 'Como Configurar Controles no Emulador',
        passos: [
          '1. Conecte o controle antes de abrir o emulador',
          '2. Vá em Configurações > Controles / Pad',
          '3. Selecione o dispositivo (seu controle)',
          '4. Clique em cada botão e pressione no controle',
          '5. Salve o perfil de configuração',
          '6. Ajuste deadzone se necessário'
        ]
      },
      'melhorar performance emulador': {
        categoria: 'otimizacao',
        titulo: 'Dicas para Melhorar Performance',
        dicas: [
          '🔹 Reduza a resolução interna',
          '🔹 Mude o backend de renderização (OpenGL ↔ DirectX ↔ Vulkan)',
          '🔹 Ative o modo de threading/multicore',
          '🔹 Desative filtros e efeitos gráficos extras',
          '🔹 Feche outros programas pesados',
          '🔹 Ative o Fast Memory se disponível',
          '🔹 Ative o Ubershaders para evitar travamentos'
        ]
      }
    }

    for (const [chave, valor] of Object.entries(baseInicial)) {
      this.dados.set(chave.toLowerCase(), valor)
    }
    console.log(`🎮 Base inicial de emuladores carregada: ${this.dados.size} verbetes`)
  },

  salvar() {
    try {
      const dadosObj = Object.fromEntries(this.dados)
      fs.writeFileSync(this.arquivo, JSON.stringify(dadosObj, null, 2))
      return true
    } catch (err) {
      console.warn(`⚠️ Não foi possível salvar base: ${err.message}`)
      return false
    }
  },

  buscar(consulta, limite = 3) {
    const resultados = []
    const termos = consulta.toLowerCase()
      .replace(/[^\w\sàáâãäçèéêëìíîïòóôõöùúûü]/g, ' ')
      .split(/\s+/).filter(t => t.length > 2)

    for (const [chave, item] of this.dados) {
      let relevancia = 0
      for (const termo of termos) {
        if (chave.includes(termo)) relevancia += 5
        if (JSON.stringify(item).toLowerCase().includes(termo)) relevancia += 1
      }
      if (relevancia > 0) {
        resultados.push({ chave, item, relevancia })
      }
    }
    return resultados.sort((a, b) => b.relevancia - a.relevancia).slice(0, limite)
  },

  adicionar(pergunta, resposta, fonte = 'aprendizado-automático') {
    const chave = pergunta.toLowerCase().trim()
    this.dados.set(chave, {
      categoria: 'aprendido',
      pergunta: pergunta,
      resposta: resposta,
      fonte: fonte,
      aprendidoEm: new Date().toISOString()
    })
    this.salvar()
    console.log(`🧠 Novo conhecimento salvo: "${pergunta.slice(0, 40)}..."`)
  },

  contar() {
    return this.dados.size
  }
}

// ======================================
// 🧠 SISTEMA DE AUTO-APRENDIZADO ESTILO HERMES
// ======================================
const AutoAprendizado = {
  historico: [],
  metricas: {
    totalPerguntas: 0,
    respostasAprendidas: 0,
    corrigidas: 0,
    taxaUtilizacao: 0,
    ultimasAtualizacoes: []
  },
  arquivo: path.join(KNOWLEDGE_DIR, 'aprendizado.json'),

  carregar() {
    try {
      if (fs.existsSync(this.arquivo)) {
        const dados = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'))
        this.historico = dados.historico || []
        this.metricas = { ...this.metricas, ...dados.metricas }
      }
    } catch (err) {
      console.warn(`⚠️ Histórico de aprendizado não carregado: ${err.message}`)
    }
  },

  salvar() {
    try {
      fs.writeFileSync(this.arquivo, JSON.stringify({
        historico: this.historico.slice(-200),
        metricas: this.metricas
      }, null, 2))
    } catch (err) {}
  },

  registrarPergunta(pergunta, resposta, fonte, foiCorrigida = false) {
    this.metricas.totalPerguntas++
    
    const registro = {
      id: Date.now(),
      pergunta,
      resposta,
      fonte,
      foiCorrigida,
      data: new Date().toISOString()
    }
    
    this.historico.push(registro)
    
    if (foiCorrigida) {
      this.metricas.corrigidas++
      EmuladorBase.adicionar(pergunta, resposta, 'correcao-comunidade')
    }
    
    // ✅ Auto-aprendizado inteligente: se resposta vier de fonte confiável, salva
    if (fonte === 'local' || fonte === 'comunidade' || fonte === 'auto-aprendizado') {
      const existe = EmuladorBase.buscar(pergunta, 1)
      if (existe.length === 0 || existe[0].relevancia < 3) {
        EmuladorBase.adicionar(pergunta, resposta, `ia-${fonte}`)
        this.metricas.respostasAprendidas++
        this.metricas.ultimasAtualizacoes.unshift({ pergunta, data: new Date().toLocaleString('pt-BR') })
        if (this.metricas.ultimasAtualizacoes.length > 5) this.metricas.ultimasAtualizacoes.pop()
      }
    }
    
    this.metricas.taxaUtilizacao = EmuladorBase.contar() > 0
      ? ((this.metricas.totalPerguntas - this.metricas.corrigidas) / this.metricas.totalPerguntas * 100).toFixed(1)
      : 100
    
    this.salvar()
    return registro
  },

  avaliarResposta(pergunta, resposta) {
    const analise = {
      comprimento: resposta.length,
      detalhada: resposta.length > 150,
      temPassos: /passo|1\.|2\.|3\./i.test(resposta),
      temConfiguracao: /configur|resolução|plugin|versão|requisito/i.test(resposta),
      qualidade: 'boa'
    }
    
    if (resposta.length < 30) analise.qualidade = 'muito_curta'
    if (!analise.detalhada && !analise.temConfiguracao) analise.qualidade = 'pode_melhorar'
    
    return analise
  },

  getRelatorio() {
    return `📊 **Sistema de Auto-Aprendizado — Relatório**

📈 Estatísticas:
• Total de perguntas: ${this.metricas.totalPerguntas}
• Respostas corrigidas: ${this.metricas.corrigidas}
• Novos conhecimentos: ${this.metricas.respostasAprendidas}
• Taxa de acerto: ${this.metricas.taxaUtilizacao}%
• Base de dados: ${EmuladorBase.contar()} verbetes

🧠 Últimas aquisições:
${this.metricas.ultimasAtualizacoes.length > 0 
  ? this.metricas.ultimasAtualizacoes.map(a => `• ${a.pergunta.slice(0,45)}...`).join('\n')
  : '• Ainda sem aquisições — comece perguntando!'}

💡 Como funciona:
• Cada resposta correta é salva automaticamente
• Correções da comunidade têm prioridade máxima
• Respostas futuras usam o conhecimento acumulado primeiro`
  }
}

// ======================================
// 🤖 SISTEMA DE IA COM MELHORES MODELOS E ESPECIALIZAÇÃO
// ======================================
const MODELOS_INTELIGENTES = [
  'meta/llama-3.1-70b-instruct',
  'nousresearch/hermes-3-llama-3.1-70b',
  'mistralai/mistral-large-2-instruct',
  'nousresearch/hermes-2-pro-llama-3-8b',
  'mistralai/mistral-small-3.1-24b-instruct:free'
]

// Prompt de sistema ESPECIALIZADO EM EMULADORES
const SISTEMA_ESPECIALIZACAO = `Você é o **EmuladorHelper**, um assistente ESPECIALIZADO em emuladores, configurações de jogos e otimização de performance.

📚 SEU CONHECIMENTO INCLUI:
• Emuladores: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP, DuckStation, ePSXe, Project64, mGBA, RetroArch e outros
• Plataformas: PS1, PS2, PSP, GameCube, Wii, Switch, N64, GBA, SNES, NES, DS
• Configurações: resolução, plugins, controles, shaders, backends gráficos, áudio, controles
• Performance: requisitos de sistema, otimização, resolução interna, filtros, compatibilidade de jogos
• Tutoriais: passo a passo de instalação, configuração de controles, instalação de bios, dumps de jogos

🎯 REGRAS DE RESPOSTA:
1. Responda SEMPRE em português do Brasil, claro e direto
2. Dê respostas PRÁTICAS e passo a passo quando possível
3. Se não souber, diga honestamente — não invente configurações
4. Destaque: requisitos mínimos, resolução recomendada, melhores plugins, dicas de performance
5. Seja amigável e acolhedor
6. Quando alguém te ensinar algo NOVO, você lembra disso para sempre
7. Sempre que aplicável, sugira alternativas e comparações entre opções

🧠 VOCÊ APRENDE: Cada correção ou informação confirmada é salva automaticamente e usada em respostas futuras.`

async function getRespostaIA(pergunta, correcao = null) {
  // 🔍 PASSO 1: Busca na base local de emuladores (MAIOR PRIORIDADE)
  const buscaLocal = EmuladorBase.buscar(pergunta, 2)
  if (buscaLocal.length > 0 && buscaLocal[0].relevancia >= 3) {
    const item = buscaLocal[0].item
    console.log(`📚 Encontrado na base local: "${buscaLocal[0].chave}"`)
    
    let resposta = ''
    if (item.categoria === 'emulador') {
      resposta = `🎮 **${item.nome}** — ${item.descricao}

📋 Configurações:
• Requisitos: ${item.configuracoes.requisitos || 'Consulte a documentação oficial'}
• Melhores configurações: ${item.configuracoes.melhor_config || item.configuracoes.resolucao_recomendada || 'Varia por jogo'}
• Dicas: ${item.configuracoes.dicas_performance || item.configuracoes.dicas || 'Ative as otimizações disponíveis'}

💡 Fonte: Conhecimento acumulado | ${item.fonte}`
    } else if (item.categoria === 'guia' && item.lista) {
      resposta = `📖 **${item.titulo}**

${item.lista.join('\n')}

💡 Fonte: Conhecimento acumulado`
    } else if (item.categoria === 'tutorial' && item.passos) {
      resposta = `📝 **${item.titulo}**

${item.passos.join('\n')}

💡 Fonte: Conhecimento acumulado`
    } else if (item.categoria === 'otimizacao' && item.dicas) {
      resposta = `⚡ **${item.titulo}**

${item.dicas.join('\n')}

💡 Fonte: Conhecimento acumulado`
    } else if (item.resposta) {
      resposta = item.resposta
    }

    AutoAprendizado.registrarPergunta(pergunta, resposta, 'local')
    return resposta
  }

  // ✅ PASSO 2: Se houver correção da comunidade, usa ela
  if (correcao) {
    console.log(`🧠 Usando conhecimento da comunidade: "${correcao.assunto}"`)
    const respostaComunidade = `📝 **Informação confirmada pela comunidade:**

${correcao.respostaCorreta}

💡 Essa informação foi salva e será usada em respostas futuras! ✅`
    
    AutoAprendizado.registrarPergunta(pergunta, correcao.respostaCorreta, 'comunidade', true)
    return respostaComunidade
  }

  // 🌐 PASSO 3: Tenta modelos inteligentes do OpenRouter
  if (!process.env.OPENROUTER_API_KEY) {
    return '⚠️ Sem conexão com a IA. Mas tenho informações salvas! Tente perguntar sobre: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP ou digite "ajuda"'
  }

  const systemPrompt = SISTEMA_ESPECIALIZACAO + (correcao 
    ? `\n\n⚠️ INFORMAÇÃO CONFIRMADA:\nPergunta: ${correcao.assunto}\nResposta correta: ${correcao.respostaCorreta}\nUse essa informação!`
    : '')

  for (const modelo of MODELOS_INTELIGENTES) {
    try {
      console.log(`🤖 Tentando: ${modelo}`)
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.RENDER_EXTERNAL_URL || 'https://localhost',
          'X-OpenRouter-Title': 'EmuladorHelper Bot',
        },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: pergunta }
          ],
          max_tokens: 1200,
          temperature: 0.7,
          timeout: 120000
        }),
        signal: AbortSignal.timeout(25000)
      })

      if (!res.ok) throw new Error(`Status ${res.status}`)
      const dados = await res.json()
      const resposta = dados?.choices?.[0]?.message?.content?.trim()
      
      if (resposta) {
        console.log(`✅ Resposta de: ${modelo}`)
        AutoAprendizado.registrarPergunta(pergunta, resposta, modelo.split('/')[0])
        
        // 🧠 Auto-aprendizado: se resposta for boa, salva na base local
        const analise = AutoAprendizado.avaliarResposta(pergunta, resposta)
        if (analise.qualidade === 'boa' && analise.temConfiguracao) {
          const existe = EmuladorBase.buscar(pergunta, 1)
          if (existe.length === 0) {
            EmuladorBase.adicionar(pergunta, resposta, `ia-${modelo.split('/')[0]}`)
          }
        }
        
        return resposta
      }
    } catch (err) {
      console.warn(`⚠️ ${modelo}: ${err.message}`)
    }
  }

  // ❌ Fallback
  return '🤔 Desculpe, estou com dificuldades de conexão. Mas tenho informações salvas! Pergunte sobre: PCSX2, Dolphin, Yuzu, Ryujinx, PPSSPP, ou "melhores emuladores"'
}

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
      analise: `📋 **Arquivo recebido:**

• Tipo: ${tipo}
• Tamanho: ${tamanhoKB} KB
• ✅ Arquivo processado e excluído com segurança

💡 Se é uma configuração de emulador, me pergunte sobre ela!`,
      resumo: `${tipo} (${tamanhoKB} KB)`
    }
  } catch (err) {
    return { seguro: false, analise: '❌ Não foi possível analisar o arquivo.', resumo: 'Erro' }
  } finally {
    try { if (fs.existsSync(caminhoArquivo)) fs.unlinkSync(caminhoArquivo) } catch {}
  }
}

// ======================================
// 🌐 SERVIDOR COM ENDPOINT DE PING
// ======================================
const PORT = process.env.PORT || 3000
http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'alive',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      pingSystem: PING_SYSTEM.status(),
      knowledge: EmuladorBase.contar()
    }))
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('✅ EmuladorHelper Online — Especialista em Emuladores Ativo! 🎮')
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor na porta ${PORT}`)
  PING_SYSTEM.iniciar()
})

// ======================================
// ⚙️ CONFIGURAÇÕES
// ======================================
const {
  PHONE_NUMBER,
  TRIGGER = 'nexos',
  COOLDOWN = '3',
  MONGODB_URI,
  ALLOWED_USERS = '',
  ALLOWED_GROUPS = '',
} = process.env

const TRIGGER_LOWER = TRIGGER.toLowerCase()

// ======================================
// 🗄️ BANCO DE DADOS
// ======================================
let mongoClient, dbKnowledge
async function initDB() {
  try {
    if (!MONGODB_URI) return false
    const uri = MONGODB_URI.trim().replace(/^["']|["']$/g, '')
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) return false
    mongoClient = new MongoClient(uri)
    await mongoClient.connect()
    dbKnowledge = mongoClient.db('emulador_bot')
    await dbKnowledge.collection('corrections').createIndex({ userId: 1, grupoId: 1 })
    console.log('🧠 Banco de dados conectado')
    return true
  } catch (err) {
    console.warn('⚠️ Banco indisponível — usando apenas memória local')
    return false
  }
}

// ======================================
// 📝 MEMÓRIA PERSISTENTE
// ======================================
const Memory = {
  async saveCorrection(userId, grupoId, assunto, respostaCorreta) {
    EmuladorBase.adicionar(assunto, respostaCorreta, 'comunidade')
    if (!dbKnowledge) return
    await dbKnowledge.collection('corrections').insertOne({
      userId, grupoId, assunto: assunto.trim(), respostaCorreta: respostaCorreta.trim(),
      criadoEm: new Date()
    })
  },
  async checkCorrection(userId, grupoId, pergunta) {
    const local = EmuladorBase.buscar(pergunta, 1)
    if (local.length > 0 && local[0].relevancia >= 3) {
      return { assunto: local[0].chave, respostaCorreta: local[0].item.resposta || JSON.stringify(local[0].item) }
    }
    if (!dbKnowledge) return null
    const res = await dbKnowledge.collection('corrections').find({
      $or: [{ userId }, { userId: 'geral' }],
      $or: [{ grupoId }, { grupoId: 'geral' }]
    }).limit(5).toArray()
    for (const r of res) {
      if (pergunta.toLowerCase().includes(r.assunto.toLowerCase().slice(0, 15))) return r
    }
    return null
  },
  async listAll(userId, grupoId) {
    const locais = Array.from(EmuladorBase.dados.entries())
      .map(([chave, val]) => ({ assunto: chave, respostaCorreta: val.resposta || val.descricao || JSON.stringify(val).slice(0,100), fonte: val.fonte || 'local' }))
    if (!dbKnowledge) return locais
    const doBanco = await dbKnowledge.collection('corrections').find({
      $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }]
    }).sort({ criadoEm: -1 }).toArray()
    return [...locais, ...doBanco]
  },
  async delete(userId, grupoId, assunto) {
    if (dbKnowledge) await dbKnowledge.collection('corrections').deleteOne({
      $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }],
      assunto: { $regex: new RegExp(`^${assunto}$`, 'i') }
    })
    for (const k of EmuladorBase.dados.keys()) {
      if (k.includes(assunto.toLowerCase())) EmuladorBase.dados.delete(k)
    }
    EmuladorBase.salvar()
  },
  async clearAll(userId, grupoId) {
    if (dbKnowledge) await dbKnowledge.collection('corrections').deleteMany({
      $or: [{ userId }, { userId: 'geral' }], $or: [{ grupoId }, { grupoId: 'geral' }]
    })
    EmuladorBase.dados.clear()
    EmuladorBase.inicializarBase()
    EmuladorBase.salvar()
  }
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
    case 'corrija': case 'aprenda': case 'salve':
      let assunto, respostaCorreta
      if (resto.includes('=') || resto.includes('é') || resto.includes(':')) {
        const sep = resto.includes('=') ? '=' : resto.includes(':') ? ':' : 'é'
        const s = resto.split(new RegExp(` ${sep} `), 2)
        assunto = s[0]?.trim()
        respostaCorreta = s[1]?.trim()
      }
      if (!respostaCorreta && quotedText) { assunto = resto || 'nova informação'; respostaCorreta = quotedText }
      if (!assunto || !respostaCorreta) {
        return `📝 **Como me ensinar:**

• ${TRIGGER} corrija [o que] = [resposta correta]
• Exemplo: ${TRIGGER} corrija resolução PCSX2 = 2x para 1080p`
      }
      await Memory.saveCorrection(userId, grupoId, assunto, respostaCorreta)
      return `✅ **SALVO E APRENDIDO! 🧠🎮**

📌 ${assunto}
✅ ${respostaCorreta}

💡 Agora eu usarei essa informação em respostas futuras automaticamente!`

    case 'memoria': case 'conhecimento':
      const itens = await Memory.listAll(userId, grupoId)
      return itens.length === 0
        ? `📚 Minha base de conhecimento está vazia! Me ensine algo com:\n${TRIGGER} corrija [assunto] = [resposta]`
        : `📚 **Base de Conhecimento (${itens.length} itens):**

${itens.slice(0,15).map((c, i) => `${i+1}. ❓ ${c.assunto}\n   ✅ ${c.respostaCorreta.slice(0,60)}...`).join('\n\n')}

💡 Total: ${itens.length} verbetes salvos`

    case 'estatisticas': case 'evolucao': case 'sistema':
      return AutoAprendizado.getRelatorio()

    case 'ping': case 'status':
      const status = PING_SYSTEM.status()
      return `🏓 **Status do Sistema:**

• Conexão: ${status.status || 'Verificando...'}
• Último ping: ${status.hora || 'Ainda não executado'}
• Código: ${status.codigo || '—'}
• Tempo: ${status.tempo || '—'}
• Conhecimento: ${EmuladorBase.contar()} verbetes
• Modelos inteligentes: ${MODELOS_INTELIGENTES.length} disponíveis`

    case 'busca': case 'pesquise': case 'procure':
      if (!resto) return `🔍 O que você quer buscar?\nExemplo: ${TRIGGER} busca PCSX2 configuração`
      const resultados = EmuladorBase.buscar(resto, 5)
      if (resultados.length === 0) return `🔍 Nada encontrado sobre: "${resto}"\nPergunte para eu buscar na internet! 🌐`
      return `🔍 **Resultados para: "${resto}"**

${resultados.map((r, i) => `${i+1}. 📌 ${r.chave}\n   Relevância: ${r.relevancia}/5`).join('\n\n')}`

    case 'esquece': case 'apague':
      if (!ehDono) return '🔒 Apenas o dono pode apagar conhecimentos.'
      if (!resto || resto === 'tudo') {
        if (resto === 'tudo') { await Memory.clearAll(userId, grupoId); return '🗑️ **Memória limpa! Base de conhecimento restaurada.** ✅' }
        return `Uso: ${TRIGGER} esquece [assunto]\nOu: ${TRIGGER} esquece tudo`
      }
      await Memory.delete(userId, grupoId, resto)
      return `🗑️ Esqueci: "${resto}" ✅`

    case 'ajuda': case 'comandos':
      return `🎮 **EmuladorHelper — Especialista em Emuladores**

✨ **Comandos:**
• ${TRIGGER} [sua pergunta] → Pergunte sobre qualquer emulador
• ${TRIGGER} corrija [o que] = [resposta] → Me ensine algo novo
• ${TRIGGER} busca [termo] → Pesquise na minha base de conhecimento
• ${TRIGGER} memoria → Veja tudo que aprendi
• ${TRIGGER} estatisticas → Veja minha evolução e aprendizado
• ${TRIGGER} ping → Verifique se estou online

👑 **Apenas o dono:**
• ${TRIGGER} esquece [assunto] → Apague uma informação
• ${TRIGGER} esquece tudo → Limpe toda a memória

💡 **Exemplos de perguntas:**
• ${TRIGGER} como configurar PCSX2 para jogos leves
• ${TRIGGER} qual a melhor resolução para Dolphin
• ${TRIGGER} Yuzu vs Ryujinx qual é melhor
• ${TRIGGER} como melhorar performance no PPSSPP

🧠 **Auto-Aprendizado Ativo:** Cada correção que você me faz, eu aprendo para sempre! ✅`

    default:
      return null
  }
}

// ======================================
// 🚀 INICIAR BOT
// ======================================
async function start() {
  try {
    await initDB()
    EmuladorBase.carregar()
    AutoAprendizado.carregar()
    console.log('🎮 EmuladorHelper — Sistema de especialização carregado')
    console.log(`🧠 Base de conhecimento: ${EmuladorBase.contar()} verbetes`)
    console.log(`🤖 Modelos inteligentes: ${MODELOS_INTELIGENTES.length} disponíveis`)

    const { state, saveCreds } = await useMultiFileAuthState('./auth')

    const { version } = await fetchLatestBaileysVersion()
    console.log(`📱 Baileys v${version.join('.')}`)

    const sock = makeWASocket({
      version, auth: state, logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })

    if (!sock.authState.creds.registered) {
      const telefone = onlyDigits(PHONE_NUMBER || '')
      if (!telefone) {
        console.error('❌ Configure PHONE_NUMBER nas variáveis de ambiente!')
        process.exit(1)
      }
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(telefone)
          console.log('\n' + '='.repeat(55))
          console.log(`📲 CÓDIGO DE PAREAMENTO: ${code}`)
          console.log(`📱 Número: ${telefone.slice(0, 4)}...${telefone.slice(-4)}`)
          console.log('👉 Abra o WhatsApp → Aparelhos → Conectar com número')
          console.log('='.repeat(55) + '\n')
        } catch (err) {
          console.error('❌ Erro ao gerar código:', err.message)
        }
      }, 3000)
    }

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        console.log('✅ CONECTADO COM SUCESSO! 🎮🧠')
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.log('🔑 Deslogado — limpando sessão e reiniciando...')
          setTimeout(start, 5000)
          return
        }
        if (code !== DisconnectReason.connectionReplaced) {
          console.log('⚠️ Desconectado — reconectando em 5s...')
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
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {})
              const extensao = msg.message.documentMessage?.fileName?.split('.').pop() || 'bin'
              const caminho = path.join(TEMP_DIR, `arquivo_${Date.now()}.${extensao}`)
              fs.writeFileSync(caminho, buffer)
              const res = await analisarArquivo(caminho, 'arquivo')
              await sock.sendMessage(chatId, { text: res.analise }, { quoted: msg })
            } catch (err) {
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
          
          // 🤖 Perguntas para a IA
          const correcao = await Memory.checkCorrection(userId, grupoId, cleanText)
          const agora = Date.now()
          const ultimoUso = lastUse.get(chatId) || 0
          if (agora - ultimoUso < parseInt(COOLDOWN) * 1000) {
            await sock.sendMessage(chatId, { react: { text: '⏳', key: msg.key } })
            continue
          }
          lastUse.set(chatId, agora)

          await sock.sendPresenceUpdate('composing', chatId)
          
          console.log(`💬 Pergunta: "${cleanText}"`)
          const resposta = await getRespostaIA(cleanText, correcao)
          
          await sock.sendMessage(chatId, { text: resposta }, { quoted: msg })
          await sock.sendPresenceUpdate('paused', chatId)

        } catch (err) {
          if (err.message?.includes('Bad MAC') || err.message?.includes('link dead')) return
          console.error('❌ Erro na mensagem:', err.message)
        }
      }
    })
  } catch (err) {
    console.error('[Inicialização]', err.message)
    setTimeout(start, 5000)
  }
}

const lastUse = new Map()
start().catch(console.error)

process.on('SIGTERM', async () => {
  console.log('\n🛑 Encerrando...')
  PING_SYSTEM.parar()
  if (mongoClient) await mongoClient.close()
  process.exit(0)
})
