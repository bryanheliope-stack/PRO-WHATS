
import pino from 'pino'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MongoClient } from 'mongodb'
import unzipper from 'unzipper'
import { downloadContentFromMessage } from '@whiskeysockets/baileys'
import { useMongoAuthState } from './mongoAuth.js'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from './baileys.js'

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
  TRIGGER = '!ia',
  COOLDOWN = '2',
  MONGODB_URI,
  MODEL_COOLDOWN_MS = '300000',
  MODEL_RETRIES = '1',
  AI_TOTAL_TIMEOUT_MS = '180000',
  NVIDIA_CATALOG_CACHE_MS = '3600000',
  SEARCH_MODE = 'auto',
  SEARCH_MAX_RESULTS = '5',
  SEARCH_TIMEOUT_MS = '10000',
  SEARCH_CACHE_MS = '600000',
  SEARCH_FETCH_PAGES = '1',
  SEARCH_SHOW_REASONING = '1',
  SERPER_API_KEY,
  GOOGLE_API_KEY,
  GOOGLE_CX,
  TAVILY_API_KEY,
  BRAVE_API_KEY,
  ALLOWED_USERS = '',
  ONLY_ADMINS = 'true',
} = process.env

const SYSTEM_PROMPT =
  'Você é um assistente especialista em emulação de PC no Android (Winlator, Mobox, Horizon, etc) dentro de um grupo de WhatsApp. ' +
  'Responda em português do Brasil, de forma curta, direta e simpática. Sem markdown pesado (use apenas *negrito* e _itálico_). ' +
  'Se o usuário fornecer uma configuração completa de jogo/aparelho ou arquivo zip/imagem com configs, extraia apenas os dados técnicos necessários. ' +
  'REGRA CRÍTICA DE SEGURANÇA: NUNCA compartilhe chaves de API, senhas, URLs de banco de dados, dados pessoais de usuários ou informações de autenticação do sistema.'

const buildSystemPrompt = () =>
  `${SYSTEM_PROMPT} Hoje é ${new Date().toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'full',
  })}.`

const MAX_HISTORY = 10
const history = new Map()
const lastUse = new Map()
const allowedList = new Set(ALLOWED_USERS.split(',').map((u) => u.trim()).filter(Boolean))

// ---------- IA ----------
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_MODELS_URL = `${NVIDIA_BASE_URL}/models`
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
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
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

  while (remainingTime(deadline) > 0) {
    round++
    const ordered = rotate(uniqueModels, provider)
    let candidates = ordered.filter((model) => availableNow(provider, model))

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

// ---------- Pesquisa na Web ----------
const SEARCH_MODE_NORM = String(SEARCH_MODE).toLowerCase()
const SEARCH_MAX = Math.min(8, Math.max(1, Math.floor(positiveNumber(SEARCH_MAX_RESULTS, 5))))
const SEARCH_TIMEOUT = positiveNumber(SEARCH_TIMEOUT_MS, 10000)
const SEARCH_CACHE = positiveNumber(SEARCH_CACHE_MS, 600000)
const SEARCH_FETCH = Math.max(0, Math.floor(Number(SEARCH_FETCH_PAGES) || 0))
const searchCache = new Map()

const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

const decodeEntities = (str = '') =>
  str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

const stripTags = (str = '') => decodeEntities(str.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

const cut = (str = '', max) => (str.length > max ? `${str.slice(0, max - 1)}…` : str)

async function searchSerper(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
    body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: SEARCH_MAX }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  })
  if (!res.ok) throw await httpFail('Serper', res)
  const data = await res.json()
  return (data?.organic || []).map((r) => ({
    title: stripTags(r.title),
    url: r.link,
    snippet: stripTags(r.snippet),
  }))
}

async function searchGoogleCSE(query) {
  const url = new URL('https://www.googleapis.com/customsearch/v1')
  url.searchParams.set('key', GOOGLE_API_KEY)
  url.searchParams.set('cx', GOOGLE_CX)
  url.searchParams.set('q', query)
  url.searchParams.set('num', String(Math.min(SEARCH_MAX, 10)))
  url.searchParams.set('gl', 'br')
  url.searchParams.set('lr', 'lang_pt')

  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT) })
  if (!res.ok) throw await httpFail('Google CSE', res)
  const data = await res.json()
  return (data?.items || []).map((r) => ({
    title: stripTags(r.title),
    url: r.link,
    snippet: stripTags(r.snippet),
  }))
}

async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: SEARCH_MAX, search_depth: 'basic' }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  })
  if (!res.ok) throw await httpFail('Tavily', res)
  const data = await res.json()
  return (data?.results || []).map((r) => ({
    title: stripTags(r.title),
    url: r.url,
    snippet: stripTags(r.content),
  }))
}

async function searchBrave(query) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(SEARCH_MAX))
  url.searchParams.set('country', 'BR')
  url.searchParams.set('search_lang', 'pt')

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  })
  if (!res.ok) throw await httpFail('Brave', res)
  const data = await res.json()
  return (data?.web?.results || []).map((r) => ({
    title: stripTags(r.title),
    url: r.url,
    snippet: stripTags(r.description),
  }))
}

async function searchDuckDuckGo(query) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'pt-BR,pt;q=0.9',
    },
    body: new URLSearchParams({ q: query, kl: 'br-pt' }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  })
  if (!res.ok) throw await httpFail('DuckDuckGo', res)

  const html = await res.text()
  if (html.includes('anomaly-modal')) throw createError('DuckDuckGo pediu captcha', 429)

  const results = []
  for (const chunk of html.split('class="result__a"').slice(1)) {
    const href = chunk.match(/href="([^"]+)"/)?.[1]
    const title = chunk.match(/>([\s\S]*?)<\/a>/)?.[1]
    const snippet = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1]
    if (!href || !title) continue

    let target = decodeEntities(href)
    try {
      const u = new URL(target.startsWith('//') ? `https:${target}` : target)
      if (u.hostname.endsWith('duckduckgo.com')) {
        if (u.pathname.startsWith('/y.js')) continue
        target = u.searchParams.get('uddg') || ''
      }
    } catch {
      continue
    }
    if (!/^https?:\/\//.test(target)) continue

    results.push({ title: stripTags(title), url: target, snippet: stripTags(snippet || '') })
    if (results.length >= SEARCH_MAX) break
  }
  return results
}

async function searchWikipedia(query) {
  const url = new URL('https://pt.wikipedia.org/w/api.php')
  url.searchParams.set('action', 'query')
  url.searchParams.set('list', 'search')
  url.searchParams.set('srsearch', query)
  url.searchParams.set('srlimit', String(SEARCH_MAX))
  url.searchParams.set('format', 'json')
  url.searchParams.set('utf8', '1')

  const res = await fetch(url, {
    headers: { 'User-Agent': 'whatsapp-bot/1.0 (bot de grupo)' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
  })
  if (!res.ok) throw await httpFail('Wikipedia', res)
  const data = await res.json()
  return (data?.query?.search || []).map((r) => ({
    title: stripTags(r.title),
    url: `https://pt.wikipedia.org/?curid=${r.pageid}`,
    snippet: stripTags(r.snippet),
  }))
}

const searchProviders = [
  SERPER_API_KEY && ['Google', searchSerper],
  GOOGLE_API_KEY && GOOGLE_CX && ['Google', searchGoogleCSE],
  TAVILY_API_KEY && ['Tavily', searchTavily],
  BRAVE_API_KEY && ['Brave', searchBrave],
  ['DuckDuckGo', searchDuckDuckGo],
  ['Wikipedia', searchWikipedia],
].filter(Boolean)

function safePublicUrl(raw) {
  try {
    const u = new URL(raw)
    if (!/^https?:$/.test(u.protocol)) return false
    const h = u.hostname
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h)) return false
    return true
  } catch {
    return false
  }
}

async function fetchPageText(url) {
  if (!safePublicUrl(url)) return ''
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT),
    redirect: 'follow',
  })
  if (!res.ok) return ''
  if (!/text\/html|text\/plain/i.test(res.headers.get('content-type') || '')) return ''

  const html = (await res.text()).slice(0, 600000)
  const text = stripTags(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
  )
  return cut(text, 1500)
}

async function webSearch(query) {
  const key = query.toLowerCase()
  const cached = searchCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.results

  let results = []
  for (const [name, fn] of searchProviders) {
    try {
      results = (await fn(query)).filter((r) => r.url && r.title).slice(0, SEARCH_MAX)
      if (results.length) {
        console.log(`[Busca] ${name}: ${results.length} resultados para "${query}"`)
        results.provider = name
        break
      }
    } catch (error) {
      console.warn(`[Busca] ${name} falhou:`, error.message)
    }
  }

  if (results.length && SEARCH_FETCH > 0) {
    const pages = await Promise.allSettled(results.slice(0, SEARCH_FETCH).map((r) => fetchPageText(r.url)))
    pages.forEach((p, i) => {
      if (p.status === 'fulfilled' && p.value) results[i].extract = p.value
    })
  }

  if (results.length) {
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value)
    searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE })
  }
  return results
}

const SEARCH_COMMAND = new RegExp(
  '^\\s*(?:' +
    [
      '\\/web',
      '\\/pesquisa',
      'pesquis(?:a|e|ar)',
      'busque',
      'busca',
      'buscar',
      'procur(?:a|e|ar)',
      'googl(?:a|e|ar)',
      'google',
    ].join('|') +
    ')(?![\\p{L}\\d])[\\s:,-]*',
  'iu'
)

const FRESH_HINTS = new RegExp(
  '(?<![\\p{L}\\d])(?:' +
    [
      'hoje',
      'agora',
      'atualmente',
      'atual',
      'recentes?',
 
