import { existsSync } from 'node:fs'

// KNOWLEDGE_DB: caminho do seu arquivo .db (ex.: /sdcard/ppsspp.db). Vazio = desativado.
// KNOWLEDGE_MAX_ROWS: quantas linhas, no máximo, vão pro prompt da IA (padrão 5).
const KB_PATH = process.env.KNOWLEDGE_DB
const MAX_ROWS = Math.max(1, Math.min(15, Number(process.env.KNOWLEDGE_MAX_ROWS) || 5))
const MAX_CELL = 240
const MAX_CONTEXT = 3500

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`
const strip = (s) => s.normalize('NFD').replace(/\p{M}/gu, '')
const likeOf = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`

// Abre SOMENTE LEITURA: o bot nunca altera o seu banco.
async function openReadOnly(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    const { default: Database } = await import('better-sqlite3')
    return new Database(path, { readonly: true, fileMustExist: true })
  }
}

async function init() {
  if (!KB_PATH) return null
  if (!existsSync(KB_PATH)) {
    console.warn(`[KB] arquivo não encontrado: ${KB_PATH} (KNOWLEDGE_DB). Consulta ao banco desativada.`)
    return null
  }
  try {
    const db = await openReadOnly(KB_PATH)
    const all = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
    const virtual = all.filter((t) => /^\s*CREATE\s+VIRTUAL/i.test(t.sql || '')).map((t) => t.name)
    const isShadow = (n) =>
      virtual.some((v) => n.startsWith(`${v}_`) && /_(data|idx|content|docsize|config|segments|segdir|stat)$/.test(n))

    const tables = all
      .filter((t) => !virtual.includes(t.name) && !isShadow(t.name))
      .map((t) => {
        const cols = db.prepare(`PRAGMA table_info(${qi(t.name)})`).all()
        return {
          name: t.name,
          columns: cols.map((c) => c.name),
          // só colunas de texto entram na busca (BLOB e números ficam de fora)
          textCols: cols.filter((c) => !c.type || /CHAR|CLOB|TEXT/i.test(c.type)).map((c) => c.name),
        }
      })

    console.log(`[KB] banco carregado: ${tables.length} tabelas (${tables.map((t) => t.name).join(', ')})`)
    return { db, tables }
  } catch (error) {
    console.warn('[KB] não consegui abrir o banco:', error.message)
    return null
  }
}

const kb = await init()

export const knowledgeEnabled = Boolean(kb)

export function knowledgeInfo() {
  if (!kb) return null
  return kb.tables.map((t) => {
    let rows = '?'
    try {
      rows = kb.db.prepare(`SELECT COUNT(*) AS n FROM ${qi(t.name)}`).get().n
    } catch {}
    return { name: t.name, rows: Number(rows), columns: t.columns }
  })
}

const fmtCell = (v) => {
  if (v == null || typeof v === 'object') return '' // null e BLOB
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s
}

// keywords: lista de palavras da pergunta. Retorna { context, count } ou null.
export function searchKnowledge(keywords) {
  if (!kb) return null
  const kws = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))].slice(0, 8)
  if (!kws.length) return null

  const variants = kws.map((k) => [...new Set([k, strip(k)])].map(likeOf)) // com e sem acento
  const minScore = kws.length >= 3 ? 2 : 1 // perguntas longas: exige 2+ palavras na mesma linha
  const hits = []

  for (const t of kb.tables) {
    if (!t.textCols.length) continue
    const params = []
    const parts = variants.map((vs) => {
      const conds = []
      for (const col of t.textCols) {
        for (const v of vs) {
          conds.push(`${qi(col)} LIKE ? ESCAPE '\\'`)
          params.push(v)
        }
      }
      return `CASE WHEN ${conds.join(' OR ')} THEN 1 ELSE 0 END`
    })
    const sql =
      `SELECT * FROM (SELECT *, (${parts.join(' + ')}) AS _kb_score FROM ${qi(t.name)}) ` +
      'WHERE _kb_score >= ? ORDER BY _kb_score DESC LIMIT ?'
    try {
      for (const row of kb.db.prepare(sql).all(...params, minScore, MAX_ROWS)) {
        const { _kb_score: score, ...data } = row
        hits.push({ table: t.name, score: Number(score), data })
      }
    } catch (error) {
      console.warn(`[KB] erro buscando em ${t.name}:`, error.message)
    }
  }

  if (!hits.length) return null
  hits.sort((a, b) => b.score - a.score)

  const lines = []
  let size = 0
  for (const h of hits.slice(0, MAX_ROWS)) {
    const cells = Object.entries(h.data)
      .map(([k, v]) => [k, fmtCell(v)])
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
    const line = `[${h.table}] ${cells.join(' | ')}`
    if (size + line.length > MAX_CONTEXT) break
    lines.push(line)
    size += line.length
  }
  if (!lines.length) return null
  return { count: lines.length, context: lines.join('\n') }
}
