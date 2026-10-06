import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys'

// Uma fila por chave: leituras e gravações da MESMA chave nunca se atropelam.
// (Sem isso, duas gravações seguidas da mesma sessão podem chegar ao MongoDB fora de ordem
// e a versão antiga sobrescreve a nova, o que causa "Bad MAC".)
// Fica no módulo (não dentro da função) pra valer também quando o bot reconecta.
const chains = new Map()

function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  chains.set(key, next)
  next
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
    .catch(() => {})
  return next
}

// Espera todas as gravações pendentes terminarem (usado antes de desligar o bot).
export const flushAuthWrites = () => Promise.allSettled([...chains.values()])

// Guarda a sessão do Baileys numa collection do MongoDB (mesma interface do useMultiFileAuthState)
export async function useMongoAuthState(collection) {
  const write = (data, id) => {
    const value = JSON.stringify(data, BufferJSON.replacer) // congela o valor agora
    return withLock(id, () => collection.replaceOne({ _id: id }, { _id: id, value }, { upsert: true }))
  }

  const read = (id) =>
    withLock(id, async () => {
      const doc = await collection.findOne({ _id: id })
      return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null
    })

  const remove = (id) => withLock(id, () => collection.deleteOne({ _id: id }))

  const creds = (await read('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const key = `${category}-${id}`
              tasks.push(value ? write(value, key) : remove(key))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => write(creds, 'creds'),
  }
}
