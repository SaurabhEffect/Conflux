import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { CLOSE_CODES, CLOSE_REASONS, can, parseDocName, workspaceDocName, type Role, type WorkspaceEvent } from '@conflux/shared'
import { Hocuspocus, type Connection } from '@hocuspocus/server'
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import * as Y from 'yjs'
import { docAccess } from '../access'
import { isAllowedOrigin } from '../allowedOrigins'
import { verifySyncToken } from '../auth/syncToken'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { memberships, pageDocs, pages, sessions, users } from '../db/schema'
import { addressKey } from '../util/address'
import { RateLimiter } from '../util/limiter'
import { cleanPresence } from './presence'

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const PING_EVERY_MS = 15_000
const FORCE_CLOSE_AFTER_MS = 2_000

type SocketInfo = {
  id: string
  ws: WebSocket
  ip: string
  authenticated: boolean
  alive: boolean
}

type ConnMeta = {
  socket: SocketInfo
  docName: string
  kind: 'page' | 'workspace'
  userId: string
  sessionId: string
  workspaceId: string
  pageId: string | null
  role: Role
  displayName: string
  cursorColor: string
  /** The Yjs client ids this connection may use in presence updates. */
  awarenessIds: Set<number>
  connection: Connection | null
  registered: boolean
}

type SyncContext = { socket: SocketInfo; meta?: ConnMeta }

export type Sync = {
  attach: (server: HttpServer) => void
  sweepNow: () => Promise<void>
  notifyWorkspace: (workspaceId: string, type: WorkspaceEvent['type']) => void
  stats: () => { sockets: number; connections: number; documents: number }
  close: () => Promise<void>
}

export type SyncDeps = { config: Config; db: Db; log: FastifyBaseLogger }

const deny = (reason: string) => ({ reason })

export function createSync({ config, db, log }: SyncDeps): Sync {
  const sockets = new Set<SocketInfo>()
  const live = new Set<ConnMeta>()
  const awarenessOwners = new Map<string, Map<number, ConnMeta>>()
  const perIp = new Map<string, number>()
  const upgrades = new RateLimiter(config.limits.socketUpgrades)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false })
  let closing = false

  const hocuspocus = new Hocuspocus<SyncContext>({
    name: 'conflux',
    quiet: true,
    debounce: 1000,
    maxDebounce: 5000,
    timeout: 30_000,

    async onConnect({ documentName, context }) {
      if (parseDocName(documentName)) return
      setImmediate(() => closeSocket(context.socket.ws, CLOSE_CODES.forbidden, 'unknown-document'))
      throw deny('unknown-document')
    },

    async onAuthenticate({ token, documentName, connectionConfig, context }) {
      const { socket } = context
      try {
        return await authenticate(token, documentName, socket, (readOnly) => (connectionConfig.readOnly = readOnly))
      } catch (error) {
        let reason = (error as { reason?: string }).reason
        if (!reason) {
          log.error({ err: error, conn: socket.id }, 'sync authentication failed unexpectedly')
          reason = 'server-error'
        }
        // Close the socket right after Hocuspocus has sent its "permission denied" answer.
        const closeWith = reasonToClose(reason)
        setImmediate(() => closeSocket(socket.ws, closeWith.code, closeWith.reason))
        throw deny(reason)
      }
    },

    async connected({ connection, context }) {
      const meta = context.meta
      if (!meta) return
      meta.connection = connection
      meta.socket.authenticated = true
      meta.registered = true
      live.add(meta)
      log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName, role: meta.role, readOnly: connection.readOnly }, 'sync connect')
    },

    async onDisconnect({ context }) {
      const meta = context.meta
      if (!meta || !meta.registered) return
      meta.registered = false
      live.delete(meta)
      releaseAwarenessIds(meta)
      log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName }, 'sync disconnect')
    },

    async beforeHandleAwareness({ states, removedClients, context }) {
      const meta = context?.meta
      if (!meta) {
        states.clear()
        removedClients.clear()
        return
      }
      for (const [clientId, state] of [...states]) {
        if (!claimAwarenessId(meta, clientId)) {
          states.delete(clientId)
          continue
        }
        states.set(clientId, cleanPresence(state, { name: meta.displayName, color: meta.cursorColor }))
      }
      for (const clientId of [...removedClients]) if (!meta.awarenessIds.has(clientId)) removedClients.delete(clientId)
    },

    async onLoadDocument({ documentName, document }) {
      const ref = parseDocName(documentName)
      if (ref?.kind !== 'page') return
      const [saved] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, ref.id))
      if (saved) Y.applyUpdate(document, saved.state)
    },

    async onStoreDocument({ documentName, document }) {
      const ref = parseDocName(documentName)
      if (ref?.kind !== 'page') return
      const state = Y.encodeStateAsUpdate(document)
      await db.execute(sql`
        insert into page_docs (page_id, state, updated_at)
        select ${ref.id}::uuid, ${Buffer.from(state)}, now()
        where exists (select 1 from pages where id = ${ref.id}::uuid)
        on conflict (page_id) do update set state = excluded.state, updated_at = excluded.updated_at
      `)
      await db.update(pages).set({ updatedAt: sql`now()` }).where(eq(pages.id, ref.id))
      log.debug({ doc: documentName, bytes: state.byteLength }, 'sync saved')
    },
  })

  async function authenticate(
    token: string,
    docName: string,
    socket: SocketInfo,
    setReadOnly: (readOnly: boolean) => void,
  ): Promise<SyncContext> {
    const ref = parseDocName(docName)
    if (!ref) throw deny('unknown-document')

    let claims
    try {
      claims = await verifySyncToken(config.secret, token)
    } catch {
      throw deny('token-invalid')
    }
    if (claims.doc !== docName) throw deny('token-invalid')

    const [session] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, claims.sessionId), eq(sessions.userId, claims.userId), gt(sessions.expiresAt, sql`now()`)))
    if (!session) throw deny(CLOSE_REASONS.sessionEnded)

    const access = await docAccess(db, claims.userId, docName)
    if (!access || !can(access.role, 'page:read')) throw deny(CLOSE_REASONS.accessRevoked)

    let openByUser = 0
    for (const other of live) if (other.userId === claims.userId) openByUser += 1
    if (openByUser >= config.limits.socketsPerUser) throw deny(CLOSE_REASONS.tooManyConnections)

    const [user] = await db
      .select({ displayName: users.displayName, cursorColor: users.cursorColor })
      .from(users)
      .where(eq(users.id, claims.userId))
    if (!user) throw deny(CLOSE_REASONS.sessionEnded)
    setReadOnly(access.kind === 'workspace' || !can(access.role, 'page:edit'))

    const meta: ConnMeta = {
      socket,
      docName,
      kind: access.kind,
      userId: claims.userId,
      sessionId: claims.sessionId,
      workspaceId: access.workspaceId,
      pageId: access.pageId,
      role: access.role,
      displayName: user.displayName,
      cursorColor: user.cursorColor,
      awarenessIds: new Set(),
      connection: null,
      registered: false,
    }
    return { socket, meta }
  }

  function claimAwarenessId(meta: ConnMeta, clientId: number): boolean {
    if (meta.awarenessIds.has(clientId)) return true
    if (meta.awarenessIds.size >= 2) return false
    let owners = awarenessOwners.get(meta.docName)
    if (!owners) awarenessOwners.set(meta.docName, (owners = new Map()))
    if (owners.has(clientId)) return false
    owners.set(clientId, meta)
    meta.awarenessIds.add(clientId)
    return true
  }

  function releaseAwarenessIds(meta: ConnMeta) {
    const owners = awarenessOwners.get(meta.docName)
    if (!owners) return
    for (const id of meta.awarenessIds) if (owners.get(id) === meta) owners.delete(id)
    if (owners.size === 0) awarenessOwners.delete(meta.docName)
  }

  function kick(meta: ConnMeta, code: number, reason: string) {
    live.delete(meta)
    releaseAwarenessIds(meta)
    meta.registered = false
    log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName, reason }, 'sync closed by server')
    try {
      meta.connection?.close({ code, reason })
    } catch (error) {
      log.warn({ err: error }, 'closing a document connection failed')
    }
    closeSocket(meta.socket.ws, code, reason)
  }

  async function sweepOnce(): Promise<void> {
    const open = [...live]
    if (open.length === 0) return
    const unique = <T>(values: T[]) => [...new Set(values)]
    const sessionRows = await db
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .where(and(inArray(sessions.id, unique(open.map((m) => m.sessionId))), gt(sessions.expiresAt, sql`now()`)))
    const sessionOwner = new Map(sessionRows.map((row) => [row.id, row.userId]))
    const memberRows = await db
      .select({ workspaceId: memberships.workspaceId, userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(
        and(
          inArray(memberships.workspaceId, unique(open.map((m) => m.workspaceId))),
          inArray(memberships.userId, unique(open.map((m) => m.userId))),
        ),
      )
    const roles = new Map(memberRows.map((row) => [`${row.workspaceId}|${row.userId}`, row.role]))
    const pageIds = unique(open.flatMap((m) => (m.pageId ? [m.pageId] : [])))
    const pageRows = pageIds.length
      ? await db.select({ id: pages.id }).from(pages).where(and(inArray(pages.id, pageIds), isNull(pages.deletedAt)))
      : []
    const alivePages = new Set(pageRows.map((row) => row.id))
    for (const meta of open) {
      if (!live.has(meta)) continue
      if (sessionOwner.get(meta.sessionId) !== meta.userId) {
        kick(meta, CLOSE_CODES.unauthorized, CLOSE_REASONS.sessionEnded)
        continue
      }
      const role = roles.get(`${meta.workspaceId}|${meta.userId}`)
      if (!role || (meta.pageId && !alivePages.has(meta.pageId))) {
        kick(meta, CLOSE_CODES.forbidden, CLOSE_REASONS.accessRevoked)
      } else if (role !== meta.role) {
        // The browser reconnects at once and is let in with its new role.
        kick(meta, CLOSE_CODES.roleChanged, CLOSE_REASONS.roleChanged)
      }
    }
  }

  let running: Promise<void> | null = null
  let again = false
  function sweepNow(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      do {
        again = false
        try {
          await sweepOnce()
        } catch (error) {
          log.error({ err: error }, 'sync sweep failed')
        }
      } while (again && !closing)
    })().finally(() => {
      running = null
    })
    return running
  }

  const sweepTimer = setInterval(() => void sweepNow(), config.sweepIntervalMs)
  sweepTimer.unref()

  function clientIp(req: IncomingMessage): string {
    const direct = req.socket.remoteAddress ?? 'unknown'
    if (!config.trustProxy) return direct
    const forwarded = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    const hops = config.trustProxy === true ? 1 : config.trustProxy
    // Each proxy adds the address it saw on the right-hand end.
    return forwarded[forwarded.length - hops] ?? direct
  }

  function refuse(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (closing) return refuse(socket, 503, 'Service Unavailable')
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/collab') return refuse(socket, 404, 'Not Found')
    // Stops other websites from opening a connection using a visitor's browser.
    if (!isAllowedOrigin(req.headers.origin ?? null, config.allowedOrigins)) return refuse(socket, 403, 'Forbidden')
    const ip = addressKey(clientIp(req))
    if (!upgrades.take(ip).ok) return refuse(socket, 429, 'Too Many Requests')
    if ((perIp.get(ip) ?? 0) >= config.limits.socketsPerIp) return refuse(socket, 429, 'Too Many Requests')
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req, ip))
  }

  function accept(ws: WebSocket, req: IncomingMessage, ip: string) {
    const info: SocketInfo = { id: randomBytes(4).toString('hex'), ws, ip, authenticated: false, alive: true }
    sockets.add(info)
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1)
    const headers = new Headers()
    if (req.headers.origin) headers.set('origin', req.headers.origin)
    const request = new Request(`http://localhost${req.url ?? '/collab'}`, { headers })
    const client = hocuspocus.handleConnection(ws, request, { socket: info })
    const pinger = setInterval(() => {
      if (!info.alive) return ws.terminate()
      info.alive = false
      ws.ping()
    }, PING_EVERY_MS)
    const deadline = setTimeout(() => {
      if (!info.authenticated) closeSocket(ws, CLOSE_CODES.unauthorized, 'auth-timeout')
    }, config.authDeadlineMs)
    ws.on('message', (data: RawData) => client.handleMessage(toBytes(data)))
    ws.on('pong', () => {
      info.alive = true
      client.touch()
    })
    ws.on('error', (error) => log.debug({ err: error, conn: info.id }, 'websocket error'))
    ws.on('close', (code, reason) => {
      clearInterval(pinger)
      clearTimeout(deadline)
      sockets.delete(info)
      const left = (perIp.get(ip) ?? 1) - 1
      if (left <= 0) perIp.delete(ip)
      else perIp.set(ip, left)
      client.handleClose({ code, reason: reason.toString() })
    })
  }

  return {
    attach(server) {
      server.on('upgrade', onUpgrade)
    },
    sweepNow,
    notifyWorkspace(workspaceId, type) {
      const doc = hocuspocus.documents.get(workspaceDocName(workspaceId))
      const event: WorkspaceEvent = { type }
      doc?.broadcastStateless(JSON.stringify(event))
    },
    stats: () => ({ sockets: sockets.size, connections: live.size, documents: hocuspocus.getDocumentsCount() }),
    async close() {
      closing = true
      clearInterval(sweepTimer)
      // Closing the connections makes Hocuspocus save every open page before it lets go of it.
      hocuspocus.closeConnections()
      hocuspocus.flushPendingStores()
      for (const info of sockets) closeSocket(info.ws, 1001, 'server-shutdown')
      const waitUntil = Date.now() + 8000
      while (hocuspocus.getDocumentsCount() > 0 && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 50))
      if (hocuspocus.getDocumentsCount() > 0) log.warn({ documents: hocuspocus.getDocumentsCount() }, 'some documents were still saving at shutdown')
      wss.close()
    },
  }
}

function reasonToClose(reason: string): { code: number; reason: string } {
  switch (reason) {
    case CLOSE_REASONS.sessionEnded:
      return { code: CLOSE_CODES.unauthorized, reason }
    case CLOSE_REASONS.tooManyConnections:
      return { code: CLOSE_CODES.tooManyConnections, reason }
    case 'token-invalid':
      return { code: CLOSE_CODES.unauthorized, reason }
    case 'server-error':
      return { code: 1011, reason }
    default:
      return { code: CLOSE_CODES.forbidden, reason: CLOSE_REASONS.accessRevoked }
  }
}

function closeSocket(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason)
  } catch {
    ws.terminate()
    return
  }
  setTimeout(() => ws.terminate(), FORCE_CLOSE_AFTER_MS).unref()
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  return new Uint8Array(data as Buffer | ArrayBuffer)
}
