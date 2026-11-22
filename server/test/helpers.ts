import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import type { FastifyInstance } from 'fastify'
import { pageDocName } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { loadConfig, type Config } from '../src/config'
import { openDatabase, type Database, type Db } from '../src/db/client'
import { pageDocs } from '../src/db/schema'
import { buildApp } from '../src/http/app'
import type { Sync } from '../src/sync/server'

export const ORIGIN = 'http://localhost:5173'
export const PASSWORD = 'correct horse battery staple'

export type TestServer = {
  url: string
  wsUrl: string
  /** The scratch Postgres database this server uses, or null for the embedded one. */
  databaseUrl: string | null
  config: Config
  db: Db
  sync: Sync
  app: FastifyInstance
  /** Shuts the database but not the server. Used to test what happens when it breaks. */
  breakDatabase: () => Promise<void>
  close: () => Promise<void>
}

type Overrides = { env?: Record<string, string>; patch?: (config: Config) => Config; dataDir?: string }

/**
 * Boots the real server (real Fastify, real sync, real database) on a random
 * port. The database is an in-memory PGlite, or a brand-new database on the
 * Postgres named in TEST_DATABASE_URL.
 */
export async function startTestServer(overrides: Overrides = {}): Promise<TestServer> {
  let config = loadConfig(
    {
      NODE_ENV: 'test',
      PORT: '0',
      CONFLUX_DATA_DIR: 'memory://',
      CONFLUX_ALLOWED_ORIGINS: ORIGIN,
      CONFLUX_LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
      // Tests sign up dozens of people from one address. The limit tests turn this back to 1.
      CONFLUX_RATE_LIMIT_SCALE: '1000',
      ...overrides.env,
    },
    [],
  )
  config = { ...config, webDist: null }
  if (overrides.patch) config = overrides.patch(config)

  const scratch = overrides.dataDir ? { url: null, drop: async () => undefined } : await scratchDatabase()
  const database: Database = await openDatabase({ url: scratch.url, dataDir: overrides.dataDir ?? 'memory://' })
  const { app, sync } = await buildApp(config, database.db)
  sync.attach(app.server)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  let closed = false

  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/collab`,
    databaseUrl: scratch.url,
    config,
    db: database.db,
    sync,
    app,
    async breakDatabase() {
      await database.close()
      closed = true
    },
    async close() {
      await app.close()
      if (!closed) await database.close()
      await scratch.drop()
    },
  }
}

async function scratchDatabase(): Promise<{ url: string | null; drop: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL
  if (!base) return { url: null, drop: async () => undefined }
  const { default: pg } = await import('pg')
  const name = `conflux_test_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()
  const url = new URL(base)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    async drop() {
      const cleaner = new pg.Client({ connectionString: base })
      await cleaner.connect()
      await cleaner.query(`drop database if exists ${name} with (force)`)
      await cleaner.end()
    },
  }
}

export type Reply<T = any> = { status: number; body: T; headers: Headers; setCookies: string[] }

/** A tiny browser: keeps cookies between calls. */
export class Client {
  cookie: string | null = null
  extraHeaders: Record<string, string> = {}

  constructor(readonly server: TestServer) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const response = await fetch(this.server.url + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...this.extraHeaders,
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const setCookies = response.headers.getSetCookie()
    for (const line of setCookies) {
      const pair = line.split(';')[0]
      const [name, ...rest] = pair.split('=')
      const value = rest.join('=')
      if (value === '' || /expires=thu, 01 jan 1970/i.test(line)) this.cookie = null
      else this.cookie = `${name}=${value}`
    }
    const text = await response.text()
    let parsed: any = text
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // not JSON (static files, plain text)
    }
    return { status: response.status, body: parsed, headers: response.headers, setCookies }
  }

  get = <T = any>(path: string, headers?: Record<string, string>) => this.request<T>('GET', path, undefined, headers)
  post = <T = any>(path: string, body?: unknown, headers?: Record<string, string>) => this.request<T>('POST', path, body, headers)
  patch = <T = any>(path: string, body?: unknown) => this.request<T>('PATCH', path, body)
  delete = <T = any>(path: string) => this.request<T>('DELETE', path)

  async signup(displayName = 'Test User', email = `${randomBytes(5).toString('hex')}@example.com`, password = PASSWORD) {
    const reply = await this.post('/api/auth/signup', { email, password, displayName })
    if (reply.status !== 201) throw new Error(`signup failed: ${reply.status} ${JSON.stringify(reply.body)}`)
    return {
      email,
      password,
      user: reply.body.user as { id: string; displayName: string; email: string },
      workspace: reply.body.workspaces[0] as { id: string; name: string; role: string },
      welcomePageId: reply.body.welcomePageId as string,
    }
  }

  async createPage(workspaceId: string, title = 'A page') {
    const reply = await this.post(`/api/workspaces/${workspaceId}/pages`, { title })
    if (reply.status !== 201) throw new Error(`createPage failed: ${reply.status} ${JSON.stringify(reply.body)}`)
    return reply.body as { id: string; title: string }
  }

  /** Owner makes an invite link; `joiner` accepts it. Returns the joiner's role. */
  async invite(workspaceId: string, joiner: Client, role: 'editor' | 'viewer') {
    const made = await this.post(`/api/workspaces/${workspaceId}/invites`, { role })
    if (made.status !== 201) throw new Error(`invite failed: ${made.status} ${JSON.stringify(made.body)}`)
    const accepted = await joiner.post('/api/invites/accept', { token: made.body.token })
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`)
    return accepted.body as { id: string; role: string }
  }
}

/** Opens a WebSocket the way a browser on the allowed origin would. */
export class BrowserSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[]) {
    super(address, protocols, { headers: { Origin: ORIGIN } })
    // Tearing a test down while a socket is still connecting is normal; it must not crash the run.
    this.on('error', () => undefined)
  }
}

export type Peer = {
  doc: Y.Doc
  provider: HocuspocusProvider
  socket: HocuspocusProviderWebsocket
  closes: { code: number; reason: string }[]
  denied: string[]
  isReadOnly: () => boolean
  synced: Promise<void>
  destroy: () => void
}

/**
 * Connects like the web app does (one socket per document), but from Node.
 * `token` can be replaced to test bad tokens.
 */
export function openDoc(server: TestServer, client: Client, docName: string, options: { token?: () => Promise<string> } = {}): Peer {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({
    url: server.wsUrl,
    WebSocketPolyfill: BrowserSocket as never,
    maxAttempts: 3,
    delay: 100,
    minDelay: 100,
    maxDelay: 300,
    jitter: false,
  })
  const closes: { code: number; reason: string }[] = []
  const denied: string[] = []
  const provider = new HocuspocusProvider({
    name: docName,
    document: doc,
    websocketProvider: socket,
    token: options.token ?? (async () => (await client.post('/api/sync-token', { doc: docName })).body?.token ?? ''),
  })
  socket.on('close', ({ event }: { event: { code: number; reason: string } }) => closes.push({ code: event.code, reason: event.reason }))
  provider.on('authenticationFailed', ({ reason }: { reason: string }) => denied.push(reason))
  provider.attach()
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve()
    provider.on('synced', () => resolve())
  })
  return {
    doc,
    provider,
    socket,
    closes,
    denied,
    isReadOnly: () => provider.authorizedScope === 'readonly',
    synced,
    destroy() {
      provider.destroy()
      socket.destroy()
    },
  }
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return Date.now() - started
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lets a test prove that something does NOT happen, without a long fixed sleep elsewhere. */
export async function settle(ms = 400) {
  await sleep(ms)
}

// ------------------------------------------------------------------ people

export type Team = {
  owner: Client
  editor: Client
  viewer: Client
  ids: { owner: string; editor: string; viewer: string }
  ws: string
  pageId: string
  doc: string
}

/** One workspace with an owner, an editor and a viewer, and one page they all share. */
export async function makeTeam(server: TestServer): Promise<Team> {
  const owner = new Client(server)
  const editor = new Client(server)
  const viewer = new Client(server)
  const a = await owner.signup('Olive Owner')
  const b = await editor.signup('Eddie Editor')
  const c = await viewer.signup('Vera Viewer')
  const ws = a.workspace.id
  await owner.invite(ws, editor, 'editor')
  await owner.invite(ws, viewer, 'viewer')
  const page = await owner.createPage(ws, 'Shared page')
  return { owner, editor, viewer, ids: { owner: a.user.id, editor: b.user.id, viewer: c.user.id }, ws, pageId: page.id, doc: pageDocName(page.id) }
}

/** The page as stored in the database, i.e. what the next visitor (or a restart) would load. */
export async function savedText(db: Db, pageId: string, field = 't'): Promise<string | null> {
  const [row] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, pageId))
  if (!row) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, row.state)
  return doc.getText(field).toString()
}

/** Waits until nobody has any document open, which is when the server writes everything to disk. */
export const untilUnloaded = (server: TestServer) => waitFor(() => server.sync.stats().documents === 0, 5000, 'documents to unload')

export const typeInto = (peer: Peer, text: string, field = 't') => peer.doc.getText(field).insert(0, text)
export const textOf = (peer: Peer, field = 't') => peer.doc.getText(field).toString()

/** Resolves with how long it took (ms) for the peer's socket to be closed with this code. */
export const untilClosed = (peer: Peer, code: number, timeoutMs = 6000) => waitFor(() => peer.closes.some((close) => close.code === code), timeoutMs, `socket close ${code}`)

// ------------------------------------------------------------------ the wire protocol, by hand

/**
 * A client that speaks the sync protocol directly, without the provider
 * library. It lets tests send things our own web app never would: a viewer
 * pushing an edit, a stranger forging another person's cursor.
 */
export type Incoming =
  | { kind: 'authenticated'; scope: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'syncStatus'; saved: boolean }
  | { kind: 'sync' }
  | { kind: 'awareness' }
  | { kind: 'stateless'; payload: string }
  | { kind: 'close'; reason: string }
  | { kind: 'other'; type: number }

const T = { Sync: 0, Awareness: 1, Auth: 2, Stateless: 5, CLOSE: 7, SyncStatus: 8 } as const

function parseIncoming(data: Uint8Array): Incoming {
  const decoder = decoding.createDecoder(data)
  decoding.readVarString(decoder)
  const type = decoding.readVarUint(decoder)
  switch (type) {
    case T.Auth: {
      const sub = decoding.readVarUint(decoder)
      if (sub === 2) return { kind: 'authenticated', scope: decoding.readVarString(decoder) }
      if (sub === 1) return { kind: 'denied', reason: decoding.readVarString(decoder) }
      return { kind: 'other', type }
    }
    case T.SyncStatus:
      return { kind: 'syncStatus', saved: decoding.readVarUint(decoder) === 1 }
    case T.Sync:
    case 4:
      return { kind: 'sync' }
    case T.Awareness:
      return { kind: 'awareness' }
    case T.Stateless:
      return { kind: 'stateless', payload: decoding.readVarString(decoder) }
    case T.CLOSE:
      return { kind: 'close', reason: decoding.readVarString(decoder) }
    default:
      return { kind: 'other', type }
  }
}

export function frame(docName: string, type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, docName)
  encoding.writeVarUint(encoder, type)
  write(encoder)
  return encoding.toUint8Array(encoder)
}

/** "Here is my token": the first thing a client says about a document. */
export const authFrame = (docName: string, token: string) =>
  frame(docName, T.Auth, (e) => {
    encoding.writeVarUint(e, 0)
    encoding.writeVarString(e, token)
  })

/** "Tell me what you have": a request for a document's content (an empty state vector). */
export const syncStep1Frame = (docName: string) =>
  frame(docName, T.Sync, (e) => {
    encoding.writeVarUint(e, 0)
    encoding.writeVarUint8Array(e, new Uint8Array([0]))
  })

export class RawClient {
  readonly ws: WebSocket
  readonly received: Incoming[] = []
  closed: { code: number; reason: string } | null = null

  constructor(
    url: string,
    readonly docName: string,
    headers: Record<string, string> = { Origin: ORIGIN },
  ) {
    this.ws = new WebSocket(url, { headers })
    this.ws.on('message', (data: Buffer) => this.received.push(parseIncoming(new Uint8Array(data))))
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString() }
    })
    this.ws.on('error', () => undefined)
  }

  opened() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve()
      this.ws.once('open', () => resolve())
      this.ws.once('error', reject)
      this.ws.once('close', () => reject(new Error('closed before opening')))
    })
  }

  /** Sends the token and waits for the server's verdict. */
  async authenticate(token: string): Promise<Incoming> {
    await this.opened()
    const before = this.received.length
    this.send(authFrame(this.docName, token))
    await waitFor(() => this.received.slice(before).some((m) => m.kind === 'authenticated' || m.kind === 'denied'), 5000, 'an authentication answer')
    return this.received.slice(before).find((m) => m.kind === 'authenticated' || m.kind === 'denied')!
  }

  send(bytes: Uint8Array) {
    this.ws.send(bytes)
  }

  /** "Here is an edit", exactly as a provider would send it. */
  sendUpdate(update: Uint8Array) {
    this.send(frame(this.docName, T.Sync, (e) => {
      encoding.writeVarUint(e, 2)
      encoding.writeVarUint8Array(e, update)
    }))
  }

  /** The same edit, sent the other way a client may: as its half of the initial exchange. */
  sendSyncStep2(update: Uint8Array) {
    this.send(frame(this.docName, T.Sync, (e) => {
      encoding.writeVarUint(e, 1)
      encoding.writeVarUint8Array(e, update)
    }))
  }

  sendAwareness(update: Uint8Array) {
    this.send(frame(this.docName, T.Awareness, (e) => encoding.writeVarUint8Array(e, update)))
  }

  /** The nth answer of this kind from the server, waiting if it has not arrived yet. */
  async next<K extends Incoming['kind']>(kind: K, after = 0, timeoutMs = 3000): Promise<Extract<Incoming, { kind: K }>> {
    await waitFor(() => this.received.slice(after).some((m) => m.kind === kind), timeoutMs, `a "${kind}" message`)
    return this.received.slice(after).find((m) => m.kind === kind) as Extract<Incoming, { kind: K }>
  }

  close() {
    this.ws.terminate()
  }
}

/** An edit to a text field, as bytes: what one browser would send for typing "text". */
export function makeUpdate(text: string, field = 't'): Uint8Array {
  const doc = new Y.Doc()
  doc.getText(field).insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

export const onPostgres = Boolean(process.env.TEST_DATABASE_URL)

/**
 * Postgres only. Opens a second connection, starts a transaction there and runs
 * `statement` (usually a lock). Whatever the server then does is held up at the
 * point where it needs that lock, which makes a race happen on purpose instead
 * of by luck. `release()` commits and lets the server carry on.
 */
export async function holdOpen(server: TestServer, statement: string) {
  if (!server.databaseUrl) throw new Error('holdOpen needs Postgres (set TEST_DATABASE_URL)')
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: server.databaseUrl })
  await client.connect()
  await client.query('begin')
  await client.query(statement)
  return {
    query: (text: string) => client.query(text),
    async release() {
      try {
        await client.query('commit')
      } finally {
        await client.end()
      }
    },
  }
}
