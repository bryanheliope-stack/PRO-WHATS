// Carrega o Baileys funcionando tanto se o pacote for ESM quanto CommonJS
import * as ns from '@whiskeysockets/baileys'

const pkg = ns.proto ? ns : ns.default

export const makeWASocket = typeof ns.default === 'function' ? ns.default : pkg.default
export const {
  initAuthCreds,
  BufferJSON,
  proto,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = pkg
