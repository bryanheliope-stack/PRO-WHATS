import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup
} from '@whiskeysockets/baileys'

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

function apenasDigitos(texto) {
  return String(texto || '').replace(/\D/g, '')
}

const CONFIG = {
  GATILHO: (process.env.GATILHO || 'nexos').toLowerCase(),
  PHONE_NUMBER: apenasDigitos(process.env.PHONE_NUMBER || ''),
  DONO_NUMERO: apenasDigitos(process.env.DONO_NUMERO || ''),
  PAIRING_TOKEN: process.env.PAIRING_TOKEN || '',

  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY || '',

  OPENROUTER_MODEL:
    process.env.OPENROUTER_MODEL || 'openrouter/free',

  NVIDIA_MODEL:
    process.env.NVIDIA_MODEL || 'meta/llama3-70b-instruct',

  NVIDIA_EMBEDDING_MODEL:
    process.env.NVIDIA_EMBEDDING_MODEL ||
    'nvidia/nv-embedqa-e5-v5',

  PING_INTERVAL:
    parseInt(process.env.PING_INTERVAL || '240000'),

  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY: 5000
}

console.log(`🤖 OpenRouter: ${CONFIG.OPENROUTER_MODEL}`)
console.log(`🤖 NVIDIA: ${CONFIG.NVIDIA_MODEL}`)
console.log(`🧠 NVIDIA Embedding: ${CONFIG.NVIDIA_EMBEDDING_MODEL}`)

// ==========================================
// 📡 ESTADO
// ==========================================

const ESTADO = {
  status: 'iniciando',
  conectado: false,
  codigo: null,
  codigoEm: 0
}

console.log(
  `🔐 Gatilho: "${CONFIG.GATILHO}" — só respondo com essa palavra!`
)

console.log(`🚫 Bloqueio de grupos: ✅ Ativado`)
console.log(`🖼️ Ignora GIFs: ✅ Ativado`)

if (CONFIG.DONO_NUMERO) {
  console.log(`👑 Dono configurado: ✅`)
}

// ==========================================
// 🔐 VERIFICAÇÃO DE DONO
// ==========================================

function ehDono(usuarioJid) {
  if (!CONFIG.DONO_NUMERO) return true

  const usuario = apenasDigitos(usuarioJid || '')

  return (
    usuario === CONFIG.DONO_NUMERO ||
    usuario.includes(CONFIG.DONO_NUMERO)
  )
}

// ==========================================
// 🔒 GRUPOS BLOQUEADOS
// ==========================================

const GRUPOS_BLOQUEADOS_ARQUIVO =
  path.join(DATA_DIR, 'grupos_bloqueados.json')

const GrupoManager = {
  bloqueados: new Set(),

  carregar() {
    try {
      if (fs.existsSync(GRUPOS_BLOQUEADOS_ARQUIVO)) {
        const dados = JSON.parse(
          fs.readFileSync(
            GRUPOS_BLOQUEADOS_ARQUIVO,
            'utf8'
          )
        )

        this.bloqueados = new Set(dados)
      }
    } catch (err) {
      console.warn(
        `⚠️ Erro ao carregar grupos bloqueados: ${err.message}`
      )

      this.bloqueados = new Set()
    }

    console.log(
      `🔒 Grupos bloqueados: ${this.bloqueados.size}`
    )
  },

  salvar() {
    try {
      fs.writeFileSync(
        GRUPOS_BLOQUEADOS_ARQUIVO,
        JSON.stringify([...this.bloqueados], null, 2)
      )

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
// 🧠 BANCO VETORIAL + EMBEDDINGS
// ==========================================

class VectorStore {
  constructor() {
    this.documents = []
    this.cacheEmbeddings = new Map()
  }

  similaridadeCosseno(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return 0
    }

    if (a.length !== b.length || a.length === 0) {
      return 0
    }

    let dot = 0
    let normaA = 0
    let normaB = 0

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normaA += a[i] * a[i]
      normaB += b[i] * b[i]
    }

    if (normaA === 0 || normaB === 0) {
      return 0
    }

    return (
      dot /
      (Math.sqrt(normaA) * Math.sqrt(normaB))
    )
  }

  // ==================================================
  // 🧠 EMBEDDING NVIDIA CORRIGIDO
  // ==================================================

  async gerarEmbedding(texto, inputType = 'query') {
    if (!CONFIG.NVIDIA_API_KEY) {
      return this.embeddingSimples(texto)
    }

    const cacheKey =
      `${inputType}:${texto.slice(0, 100)}`

    if (this.cacheEmbeddings.has(cacheKey)) {
      return this.cacheEmbeddings.get(cacheKey)
    }

    try {
      const res = await fetch(
        'https://integrate.api.nvidia.com/v1/embeddings',
        {
          method: 'POST',

          headers: {
            'Authorization':
              `Bearer ${CONFIG.NVIDIA_API_KEY}`,

            'Content-Type':
              'application/json',

            'Accept':
              'application/json'
          },

          body: JSON.stringify({
            input: texto,

            model:
              CONFIG.NVIDIA_EMBEDDING_MODEL,

            input_type:
              inputType,

            encoding_format:
              'float'
          }),

          signal:
            AbortSignal.timeout(20000)
        }
      )

      if (!res.ok) {
        const erro = await res.text()

        throw new Error(
          `API ${res.status}: ${erro}`
        )
      }

      const dados = await res.json()

      const vetor =
        dados.data?.[0]?.embedding

      if (
        !Array.isArray(vetor) ||
        vetor.length === 0
      ) {
        throw new Error(
          'Resposta da NVIDIA não contém embedding válido'
        )
      }

      this.cacheEmbeddings.set(
        cacheKey,
        vetor
      )

      if (
        this.cacheEmbeddings.size > 100
      ) {
        this.cacheEmbeddings.clear()
      }

      return vetor

    } catch (err) {
      console.warn(
        `⚠️ Embedding API: ${err.message} — usando método local`
      )

      return this.embeddingSimples(texto)
    }
  }

  // ==================================================
  // 🧮 EMBEDDING LOCAL DE FALLBACK
  // ==================================================

  embeddingSimples(texto) {
    const vetor =
      new Array(128).fill(0)

    const palavras =
      texto
        .toLowerCase()
        .split(/\W+/)
        .filter(p => p.length > 1)

    palavras.forEach((palavra, i) => {
      let hash = 0

      for (
        let c = 0;
        c < palavra.length;
        c++
      ) {
        hash =
          ((hash << 5) - hash) +
          palavra.charCodeAt(c)

        hash |= 0
      }

      const idx =
        Math.abs(hash) %
        vetor.length

      vetor[idx] +=
        Math.sin(
          i * 0.5 +
          Math.abs(hash) * 0.01
        )
    })

    const norma =
      Math.sqrt(
        vetor.reduce(
          (s, v) => s + v * v,
          0
        )
      )

    return norma > 0
      ? vetor.map(v => v / norma)
      : vetor
  }

  // ==================================================
  // 📥 ADICIONAR DOCUMENTO
  // ==================================================

  async adicionar(
    texto,
    metadados = {}
  ) {
    const vetor =
      await this.gerarEmbedding(
        texto,
        'passage'
      )

    this.documents.push({
      id: crypto.randomUUID(),
      texto,
      metadados,
      vetor
    })
  }

  // ==================================================
  // 🔎 BUSCAR
  // ==================================================

  async buscar(
    pergunta,
    limite = 4
  ) {
    if (
      this.documents.length === 0
    ) {
      return []
    }

    const vetorPergunta =
      await this.gerarEmbedding(
        pergunta,
        'query'
      )

    return this.documents
      .map(doc => ({
        ...doc,

        relevancia:
          this.similaridadeCosseno(
            vetorPergunta,
            doc.vetor
          )
      }))

      .sort(
        (a, b) =>
          b.relevancia -
          a.relevancia
      )

      .filter(
        r => r.relevancia > 0.25
      )

      .slice(0, limite)
  }

  // ==================================================
  // 📚 BASE
  // ==================================================

  async carregarBase() {
    console.log(
      '📂 Carregando base de conhecimento...'
    )

    const base = [
      {
        texto:
          'Winlator é um aplicativo que permite rodar jogos de Windows no Android. Requer Android 10 ou superior. Site oficial: winlator.dev',

        fonte: 'winlator'
      },

      {
        texto:
          'GameHub é um aplicativo desenvolvido pela mesma equipe do Winlator. Também roda jogos de Windows no Android e exige Android 10+. Disponível em: winlator.dev/gamehub',

        fonte: 'gamehub'
      },

      {
        texto:
          'Eden é um emulador de Nintendo Switch para Android. Site: eden-emu.dev',

        fonte: 'eden'
      },

      {
        texto:
          'PPSSPP é um emulador de PSP disponível para Android, Windows e outras plataformas. É gratuito e open source. Site oficial: ppsspp.org',

        fonte: 'ppsspp'
      }
    ]

    for (const item of base) {
      await this.adicionar(
        item.texto,
        {
          fonte: item.fonte
        }
      )
    }

    console.log(
      `✅ Base carregada: ${base.length} documentos indexados`
    )
  }
}

const VectorDB =
  new VectorStore()

// IMPORTANTE:
// agora aguardamos os embeddings antes
// de iniciar o WhatsApp.
await VectorDB.carregarBase()

// ==========================================
// 🤖 GERAÇÃO — OPENROUTER + NVIDIA
// ==========================================

const GeradorResposta = {
  cache: new Map(),

  async chamarOpenRouter(prompt) {
    if (
      !CONFIG.OPENROUTER_API_KEY
    ) {
      return null
    }

    const modelo =
      CONFIG.OPENROUTER_MODEL

    try {
      console.log(
        `🤖 Usando OpenRouter: ${modelo}`
      )

      const res = await fetch(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',

          headers: {
            'Authorization':
              `Bearer ${CONFIG.OPENROUTER_API_KEY}`,

            'Content-Type':
              'application/json',

            'HTTP-Referer':
              process.env.RENDER_EXTERNAL_URL ||
              'https://localhost'
          },

          body: JSON.stringify({
            model: modelo,

            messages: [
              {
                role: 'system',

                content:
                  `Você é um assistente útil, preciso e confiável. Responda SEMPRE em português.

📌 REGRAS:
1. Use APENAS as informações do CONTEXTO para responder.
2. Se não tiver a informação, diga honestamente que não sabe.
3. Não invente informações.
4. Seja claro, direto e amigável.`
              },

              {
                role: 'user',
                content: prompt
              }
            ],

            max_tokens: 800,
            temperature: 0.7
          }),

          signal:
            AbortSignal.timeout(30000)
        }
      )

      if (!res.ok) {
        const erro =
          await res.text()

        throw new Error(
          `Status ${res.status}: ${erro}`
        )
      }

      const dados =
        await res.json()

      if (dados.error) {
        throw new Error(
          dados.error.message
        )
      }

      return (
        dados.choices?.[0]
          ?.message?.content ||
        null
      )

    } catch (err) {
      console.warn(
        `⚠️ OpenRouter (${modelo}) falhou: ${err.message}`
      )

      return null
    }
  },

  async chamarNVIDIA(prompt) {
    if (
      !CONFIG.NVIDIA_API_KEY
    ) {
      return null
    }

    const modelo =
      CONFIG.NVIDIA_MODEL

    try {
      console.log(
        `🤖 Usando NVIDIA: ${modelo}`
      )

      const res = await fetch(
        'https://integrate.api.nvidia.com/v1/chat/completions',
        {
          method: 'POST',

          headers: {
            'Authorization':
              `Bearer ${CONFIG.NVIDIA_API_KEY}`,

            'Content-Type':
              'application/json',

            'Accept':
              'application/json'
          },

          body: JSON.stringify({
            model: modelo,

            messages: [
              {
                role: 'system',

                content:
                  'Você é um assistente útil, preciso e confiável. Responda SEMPRE em português. Use apenas as informações do contexto fornecido.'
              },

              {
                role: 'user',
                content: prompt
              }
            ],

            max_tokens: 800,
            temperature: 0.7
          }),

          signal:
            AbortSignal.timeout(30000)
        }
      )

      if (!res.ok) {
        const erro =
          await res.text()

        throw new Error(
          `NVIDIA ${res.status}: ${erro}`
        )
      }

      const dados =
        await res.json()

      return (
        dados.choices?.[0]
          ?.message?.content ||
        null
      )

    } catch (err) {
      console.warn(
        `⚠️ NVIDIA falhou: ${err.message}`
      )

      return null
    }
  },

  async responder(pergunta) {
    const cacheKey =
      pergunta
        .toLowerCase()
        .trim()

    if (
      this.cache.has(cacheKey)
    ) {
      return this.cache.get(
        cacheKey
      )
    }

    console.log(
      `\n📥 Pergunta: "${pergunta}"`
    )

    const resultados =
      await VectorDB.buscar(
        pergunta
      )

    console.log(
      `🔍 Encontrados: ${resultados.length} trecho(s) relevante(s)`
    )

    const contexto =
      resultados.length > 0

        ? resultados
            .map(
              (r, i) =>
                `[Fonte ${i + 1}] ${r.texto}`
            )
            .join('\n\n')

        : 'Nenhuma informação específica encontrada na base de dados.'

    const promptCompleto =
      `=== CONTEXTO ===
${contexto}
===============

Com base APENAS nas informações acima, responda: ${pergunta}`

    let resposta =
      await this.chamarOpenRouter(
        promptCompleto
      )

    if (!resposta) {
      console.log(
        `🔄 Alternando para NVIDIA...`
      )

      resposta =
        await this.chamarNVIDIA(
          promptCompleto
        )
    }

    if (!resposta) {
      if (
        resultados.length === 1
      ) {
        resposta =
          resultados[0].texto

      } else if (
        resultados.length > 1
      ) {
        resposta =
          `🔍 Encontrei ${resultados.length} opções:\n\n` +
          resultados
            .map(
              (r, i) =>
                `${i + 1}. ${r.texto.split('\n')[0]}`
            )
            .join('\n')

      } else {
        resposta =
          `🤔 Não tenho informações sobre isso. Tente: Winlator, GameHub, Eden ou PPSSPP 😊`
      }
    }

    this.cache.set(
      cacheKey,
      resposta
    )

    if (
      this.cache.size > 50
    ) {
      this.cache.clear()
    }

    return resposta
  }
}

// ==========================================
// 🏓 PING
// ==========================================

const PING_SYSTEM = {
  url:
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PING_URL ||
    '',

  interval:
    CONFIG.PING_INTERVAL,

  timer: null,

  async ping() {
    if (!this.url) {
      return false
    }

    try {
      const inicio =
        Date.now()

      const res =
        await fetch(
          `${this.url}/ping`,
          {
            signal:
              AbortSignal.timeout(20000)
          }
        )

      console.log(
        `🏓 Ping: ${res.ok ? '✅ ONLINE' : '⚠️ OK'} | ${Date.now() - inicio}ms`
      )

      return true

    } catch (err) {
      console.warn(
        `🏓 Ping falhou: ${err.message}`
      )

      return false
    }
  },

  iniciar() {
    if (!this.url) {
      return
    }

    console.log(
      `🏓 Ping a cada ${Math.round(
        this.interval / 60000
      )}min`
    )

    this.ping()

    this.timer =
      setInterval(
        () => this.ping(),
        this.interval
      )
  }
}

// ==========================================
// 🖼️ IMAGENS
// ==========================================

const BuscaImagens = {
  cache: new Map(),

  async buscar(termo) {
    const cacheKey =
      termo.toLowerCase()

    if (
      this.cache.has(cacheKey)
    ) {
      return [
        this.cache.get(cacheKey)
      ]
    }

    try {
      const img = {
        url:
          `https://image.pollinations.ai/prompt/${encodeURIComponent(termo)}?width=800&height=600&nologo=true`,

        autor:
          'Pollinations AI'
      }

      this.cache.set(
        cacheKey,
        img
      )

      if (
        this.cache.size > 50
      ) {
        this.cache.clear()
      }

      return [img]

    } catch {
      return []
    }
  }
}

// ==========================================
// 🌐 SERVIDOR
// ==========================================

const PORT =
  process.env.PORT || 10000

http
  .createServer(
    (req, res) => {
      const url =
        new URL(
          req.url,
          `http://localhost:${PORT}`
        )

      // --------------------------
      // PING
      // --------------------------

      if (
        url.pathname === '/ping'
      ) {
        res.writeHead(
          200,
          {
            'Content-Type':
              'application/json'
          }
        )

        res.end(
          JSON.stringify({
            status:
              'online',

            whatsapp:
              ESTADO.status,

            conectado:
              ESTADO.conectado,

            documentosIndexados:
              VectorDB.documents.length,

            openRouterModel:
              CONFIG.OPENROUTER_MODEL,

            nvidiaModel:
              CONFIG.NVIDIA_MODEL,

            embeddingModel:
              CONFIG.NVIDIA_EMBEDDING_MODEL,

            gatilho:
              CONFIG.GATILHO,

            gruposBloqueados:
              GrupoManager
                .listarBloqueados()
                .length
          })
        )

        return
      }

      // --------------------------
      // CÓDIGO
      // --------------------------

      if (
        url.pathname === '/codigo'
      ) {
        const enviado =
          Buffer.from(
            url.searchParams.get(
              'token'
            ) || ''
          )

        const esperado =
          Buffer.from(
            CONFIG.PAIRING_TOKEN
          )

        const autorizado =
          CONFIG.PAIRING_TOKEN &&
          esperado.length > 0 &&
          enviado.length ===
            esperado.length &&
          crypto.timingSafeEqual(
            enviado,
            esperado
          )

        if (!autorizado) {
          res.writeHead(
            404,
            {
              'Content-Type':
                'text/plain'
            }
          )

          res.end(
            'Not found'
          )

          return
        }

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/plain; charset=utf-8'
          }
        )

        if (
          ESTADO.conectado
        ) {
          res.end(
            '✅ Já conectado!'
          )

        } else if (
          ESTADO.codigo
        ) {
          res.end(
            `📲 CÓDIGO: ${ESTADO.codigo}`
          )

        } else {
          res.e
