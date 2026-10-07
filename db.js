import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// SQLITE_PATH: onde o arquivo do banco fica. Em Render sem disco persistente, o arquivo some a cada deploy.
const DB_PATH = process.env.SQLITE_PATH || './data/bot.db'
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true })

// Usa o SQLite embutido do Node (22.5+). Se não existir, cai pro better-sqlite3 (npm i better-sqlite3).
async function openDb(path) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path)
  } catch {
    const { default: Database } = await import('better-sqlite3')
    return new Database(path)
  }
}

const db = await openDb(DB_PATH)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, id);

  CREATE TABLE IF NOT EXISTS usage (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    sender     TEXT NOT NULL,
    name       TEXT,
    searched   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_usage_chat ON usage (chat_id, created_at);
`)

const q = {
  history: db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?'),
  insertMsg: db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)'),
  prune: db.prepare(
    'DELETE FROM messages WHERE chat_id = ? AND id NOT IN (SELECT id FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?)'
  ),
  clear: db.prepare('DELETE FROM messages WHERE chat_id = ?'),
  restoreMsg: db.prepare('INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)'),
  restoreUsage: db.prepare(
    'INSERT INTO usage (chat_id, sender, name, searched, created_at) VALUES (?, ?, ?, ?, ?)'
  ),
  countMsgs: db.prepare('SELECT COUNT(*) AS n FROM messages'),
  countUsage: db.prepare('SELECT COUNT(*) AS n FROM usage'),
  allMsgs: db.prepare('SELECT chat_id, role, content, created_at FROM messages ORDER BY id'),
  allUsage: db.prepare('SELECT chat_id, sender, name, searched, created_at FROM usage ORDER BY id'),
  insertUsage: db.prepare('INSERT INTO usage (chat_id, sender, name, searched) VALUES (?, ?, ?, ?)'),
  total: db.prepare('SELECT COUNT(*) AS n, SUM(searched) AS s FROM usage WHERE chat_id = ?'),
  top: db.prepare(
    'SELECT name, COUNT(*) AS n FROM usage WHERE chat_id = ? GROUP BY sender ORDER BY n DESC LIMIT 3'
  ),
  today: db.prepare('SELECT COUNT(*) AS n FROM usage WHERE chat_id = ? AND created_at >= ?'),
}

// ---------- MongoDB como armazenamento secundário ----------
// SQLite é o principal (leituras e escritas). O Mongo recebe uma cópia de tudo, em segundo plano.
// Ao iniciar: banco local vazio -> restaura do Mongo; Mongo vazio -> copia o local pra lá.
let mongo = null
const pending = new Set()
let lastMongoWarn = 0

function mirror(promise) {
  const p = Promise.resolve(promise)
    .catch((error) => {
      if (Date.now() - lastMongoWarn > 60000) {
        lastMongoWarn = Date.now()
        console.warn('[DB] cópia no MongoDB falhou:', error.message)
      }
    })
    .finally(() => pending.delete(p))
  pending.add(p)
}

export async function attachMongo(mongoDb, keep = 200) {
  if (mongo?.db === mongoDb) return
  const messages = mongoDb.collection('chat_messages')
  const usage = mongoDb.collection('chat_usage')
  await Promise.all([
    messages.createIndex({ chat_id: 1, _id: -1 }),
    usage.createIndex({ chat_id: 1, created_at: 1 }),
  ])

  const localMsgs = Number(q.countMsgs.get().n)
  const localUsage = Number(q.countUsage.get().n)
  const [remoteMsgs, remoteUsage] = await Promise.all([messages.countDocuments({}), usage.countDocuments({})])

  // Restaura (ex.: deploy novo no Render apagou o arquivo local).
  if (!localMsgs && !localUsage && (remoteMsgs || remoteUsage)) {
    const [ms, us] = await Promise.all([
      messages.find({}).sort({ _id: 1 }).toArray(),
      usage.find({}).sort({ _id: 1 }).toArray(),
    ])
    db.exec('BEGIN')
    try {
      for (const m of ms) q.restoreMsg.run(m.chat_id, m.role, m.content, m.created_at)
      for (const u of us) q.restoreUsage.run(u.chat_id, u.sender, u.name ?? null, u.searched ? 1 : 0, u.created_at)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    console.log(`[DB] restaurado do MongoDB: ${ms.length} mensagens, ${us.length} registros de uso`)
  } else if ((localMsgs && !remoteMsgs) || (localUsage && !remoteUsage)) {
    // Primeira vez com o Mongo ligado: envia o que já existe localmente.
    if (localMsgs && !remoteMsgs) await messages.insertMany(q.allMsgs.all().map((r) => ({ ...r })))
    if (localUsage && !remoteUsage) await usage.insertMany(q.allUsage.all().map((r) => ({ ...r })))
    console.log(`[DB] dados locais copiados pro MongoDB: ${localMsgs} mensagens, ${localUsage} registros de uso`)
  }

  mongo = { db: mongoDb, messages, usage, keep }
}

export function detachMongo() {
  mongo = null
}

export async function flushMongo() {
  await Promise.allSettled([...pending])
}

async function pruneMongo(chatId) {
  const old = await mongo.messages
    .find({ chat_id: chatId })
    .sort({ _id: -1 })
    .skip(mongo.keep)
    .project({ _id: 1 })
    .toArray()
  if (old.length) await mongo.messages.deleteMany({ _id: { $in: old.map((d) => d._id) } })
}

// Últimas N mensagens do chat, em ordem cronológica.
export function loadHistory(chatId, limit) {
  return q.history.all(chatId, limit).reverse().map((r) => ({ role: r.role, content: r.content }))
}

// Grava a pergunta e a resposta juntas e mantém só as últimas `keep` mensagens do chat.
export function saveExchange(chatId, userContent, answer, keep = 200) {
  db.exec('BEGIN')
  try {
    q.insertMsg.run(chatId, 'user', userContent)
    q.insertMsg.run(chatId, 'assistant', answer)
    q.prune.run(chatId, chatId, keep)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  if (mongo) {
    const now = Math.floor(Date.now() / 1000)
    const target = mongo
    mirror(
      target.messages
        .insertMany(
          [
            { chat_id: chatId, role: 'user', content: userContent, created_at: now },
            { chat_id: chatId, role: 'assistant', content: answer, created_at: now },
          ],
          { ordered: true }
        )
        .then(() => pruneMongo(chatId))
    )
  }
}

export function clearHistory(chatId) {
  const n = Number(q.clear.run(chatId).changes)
  if (mongo) mirror(mongo.messages.deleteMany({ chat_id: chatId }))
  return n
}

export function recordUsage(chatId, sender, name, searched) {
  q.insertUsage.run(chatId, sender, name || null, searched ? 1 : 0)
  if (mongo) {
    mirror(
      mongo.usage.insertOne({
        chat_id: chatId,
        sender,
        name: name || null,
        searched: searched ? 1 : 0,
        created_at: Math.floor(Date.now() / 1000),
      })
    )
  }
}

export function chatStats(chatId) {
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const total = q.total.get(chatId)
  return {
    total: Number(total.n || 0),
    searches: Number(total.s || 0),
    today: Number(q.today.get(chatId, Math.floor(startOfDay.getTime() / 1000)).n || 0),
    top: q.top.all(chatId).map((r) => ({ name: r.name || 'Alguém', n: Number(r.n) })),
  }
}

export function closeDb() {
  try {
    db.close()
  } catch {}
}
