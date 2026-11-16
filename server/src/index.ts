import { fileURLToPath } from 'node:url'
import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { isAllowedOrigin, parseAllowedOrigins } from './allowedOrigins'
import { isValidDocumentName } from './documentNames'
import { DocumentStore } from './store'

const PORT = Number(process.env.PORT ?? 1234)
const LAN = process.argv.includes('--lan')
const HOST = LAN ? '0.0.0.0' : '127.0.0.1'
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.CONFLUX_ALLOWED_ORIGINS)
const DB_FILE = process.env.CONFLUX_DB ?? fileURLToPath(new URL('../data/conflux.db', import.meta.url))
const store = new DocumentStore(DB_FILE)
const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`)
const server = new Server({
  name: 'conflux',
  port: PORT,
  address: HOST,
  quiet: true,
  debounce: 1000,
  maxDebounce: 5000,
  async onRequest({ response }) {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Conflux sync server is running.\n')
    throw undefined
  },

  async onConnect({ documentName, requestHeaders }) {
    if (!isAllowedOrigin(requestHeaders.get('origin'), ALLOWED_ORIGINS)) throw new Error('refused WebSocket connection from untrusted origin')
    if (!isValidDocumentName(documentName)) throw new Error(`refused unknown document "${documentName}"`)
  },

  async onLoadDocument({ documentName, document }) {
    const saved = store.load(documentName)
    if (saved) Y.applyUpdate(document, saved)
  },

  async onStoreDocument({ documentName, document }) {
    store.save(documentName, Y.encodeStateAsUpdate(document))
  },

  async connected({ documentName, instance }) {
    const here = instance.documents.get(documentName)?.getConnectionsCount() ?? 1
    log(`+ joined ${documentName} (${here} connected)`)
  },
  async onDisconnect({ documentName, clientsCount }) {
    log(`- left   ${documentName} (${clientsCount} still connected)`)
  },
  async afterStoreDocument({ documentName }) {
    log(`saved   ${documentName}`)
  },

  async onDestroy() {
    store.close()
    log('stopped. All documents are saved.')
  },
})

server.httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use. Another copy of Conflux (or another program) is running.\n` +
        `  Close it, or start on a different port with the PORT setting. See the README.\n`,
    )
  } else {
    console.error(error)
  }
  process.exit(1)
})

await server.listen()

console.log(`
  Conflux sync server is running
    WebSocket : ws://localhost:${PORT}
    Database  : ${DB_FILE}  (${store.count()} saved documents)
    Reachable : ${LAN ? 'from your whole network (--lan)' : 'from this computer only'}
`)
