import { randomBytes } from 'node:crypto'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { CLOSE_CODES, CLOSE_REASONS, LIMITS, can, demoDocName, parseDemoDocName, parseDocName, workspaceDocName, type Role, type WorkspaceEvent } from '@conflux/shared'
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
import { demoDocAccess, endSandbox, isAlive, touchIntervalMs, touchSandbox } from '../demo/sandboxes'
import { memberships, pageDocs, pages, sandboxDocs, sandboxPages, sandboxParticipants, sandboxes, sessions, users } from '../db/schema'
import { addressKey } from '../util/address'
import { Budget, RateLimiter } from '../util/limiter'
import { createBots } from './bot'
import { cleanPresence } from './presence'

/**
 * The live-sync server: WebSocket connections that carry Yjs edits.
 *
 * Every connection is checked three times:
 *   1. when it opens (valid token, valid session, member of the workspace),
 *   2. on every message (viewers are connected read-only, so their edits are
 *      ignored by the server, not just hidden in the interface),
 *   3. every couple of seconds for as long as it stays open (the "sweep"), and
 *      immediately whenever the API removes someone, so a removed member loses
 *      access within seconds, not whenever they next reload.
 */

/** Largest single WebSocket message. A normal paste is far smaller. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
/** A guest's page is measured (to see whether it is still within its limit) every time this much has been typed or pasted. */
const MEASURE_DEMO_PAGE_EVERY_BYTES = 32 * 1024
const PING_EVERY_MS = 15_000
const FORCE_CLOSE_AFTER_MS = 2_000

type SocketInfo = {
  id: string
  ws: WebSocket
  ip: string
  authenticated: boolean
  alive: boolean
  /** How many messages this connection may still send. A flood closes it. */
  messages: Budget
  /** Set once the connection was closed for flooding, so the rest of the flood is ignored quietly. */
  flooding: boolean
  /** True once a guest demo page was opened on this connection: guests get a smaller message size limit. */
  demo: boolean
}

/** What we know about one open document connection. Created while authenticating. */
type ConnMeta = {
  socket: SocketInfo
  docName: string
  kind: 'page' | 'workspace' | 'demo'
  /** The account's id, or for a guest demo the visitor's id. */
  userId: string
  /** The sign-in session's id, or for a guest demo the demo's id. */
  sessionId: string
  /** The workspace's id, or for a guest demo the demo's id. */
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
  /** Re-check every open connection now and close the ones that lost access. */
  sweepNow: () => Promise<void>
  /** Tell everyone who has this workspace open to re-read the page list / members. */
  notifyWorkspace: (workspaceId: string, type: WorkspaceEvent['type']) => void
  stats: () => { sockets: number; connections: number; documents: number; bots: number }
  close: () => Promise<void>
}

export type SyncDeps = { config: Config; db: Db; log: FastifyBaseLogger }

/** Thrown from hooks: Hocuspocus turns it into a "permission denied" message for the browser. */
const deny = (reason: string) => ({ reason })

export function createSync({ config, db, log }: SyncDeps): Sync {
  const sockets = new Set<SocketInfo>()
  const live = new Set<ConnMeta>()
  /** document name -> (Yjs client id -> the one connection that speaks for it) */
  const awarenessOwners = new Map<string, Map<number, object>>()
  /** Stands in for "the bot" in `awarenessOwners`: no visitor may speak for the bot's cursor. */
  const BOT_OWNER = {}
  /** Demo id -> when we last told the database that somebody is typing in it. */
  const lastTouched = new Map<string, number>()
  /** Demo page -> bytes of edits that arrived since its size was last measured. */
  const unmeasured = new Map<string, number>()
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
      if (parseDocName(documentName) || parseDemoDocName(documentName)) return
      // Not a name this server ever hands out. Close the socket right after
      // Hocuspocus has sent its "permission denied" answer.
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
      if (meta.kind === 'demo') bots.humanJoined(meta.docName)
      log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName, role: meta.role, readOnly: connection.readOnly }, 'sync connect')
    },

    async onDisconnect({ context }) {
      const meta = context.meta
      if (!meta || !meta.registered) return
      forget(meta)
      log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName }, 'sync disconnect')
    },

    /**
     * Somebody typed in a demo page (the bot's own edits have no connection, so they are skipped here). Two jobs:
     *  - keep the demo from timing out for being idle, and
     *  - keep the page small. A guest is anonymous, so the page is measured as it grows and a demo that
     *    goes past its limit is ended at once, instead of at the next save.
     */
    async onChange({ context, documentName, document, update }) {
      const meta = (context as SyncContext | undefined)?.meta
      if (meta?.kind !== 'demo') return

      const unchecked = (unmeasured.get(documentName) ?? 0) + update.byteLength
      if (unchecked >= MEASURE_DEMO_PAGE_EVERY_BYTES) {
        unmeasured.set(documentName, 0)
        const size = Y.encodeStateAsUpdate(document).byteLength
        if (size > LIMITS.demoPageMaxBytes) {
          await endOversizedDemo(meta.workspaceId, documentName, size)
          return
        }
      } else {
        if (unmeasured.size > 1000) unmeasured.clear()
        unmeasured.set(documentName, unchecked)
      }

      const now = Date.now()
      if (now - (lastTouched.get(meta.workspaceId) ?? 0) < touchIntervalMs(config.demo)) return
      if (lastTouched.size > 1000) lastTouched.clear()
      lastTouched.set(meta.workspaceId, now)
      await touchSandbox(db, config.demo, meta.workspaceId).catch((error) => log.warn({ err: error }, 'could not mark the demo as active'))
    },

    /**
     * Presence (cursors and names) is a message the browser writes itself, so
     * it cannot be trusted. We overwrite the name and colour with what the
     * account says, drop updates about other people's cursors, and keep
     * nothing but the cursor position.
     */
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
      const demoPage = parseDemoDocName(documentName)
      if (demoPage) {
        const [saved] = await db.select({ state: sandboxDocs.state }).from(sandboxDocs).where(eq(sandboxDocs.pageId, demoPage))
        if (saved) Y.applyUpdate(document, saved.state)
        return
      }
      const ref = parseDocName(documentName)
      if (ref?.kind !== 'page') return
      const [saved] = await db.select({ state: pageDocs.state }).from(pageDocs).where(eq(pageDocs.pageId, ref.id))
      if (saved) Y.applyUpdate(document, saved.state)
    },

    async onStoreDocument({ documentName, document }) {
      const demoPage = parseDemoDocName(documentName)
      if (demoPage) return storeDemoPage(demoPage, Y.encodeStateAsUpdate(document))
      const ref = parseDocName(documentName)
      if (ref?.kind !== 'page') return
      const state = Y.encodeStateAsUpdate(document)
      // "insert ... select" writes nothing (and fails nothing) if the page was
      // deleted for good while people were still typing.
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

  /** The demo's bot. It lives in this process and talks to the same live documents as the visitors. */
  const bots = createBots({
    hocuspocus,
    demo: config.demo,
    log,
    reserveAwareness(docName, clientId) {
      let owners = awarenessOwners.get(docName)
      if (!owners) awarenessOwners.set(docName, (owners = new Map()))
      owners.set(clientId, BOT_OWNER)
    },
    releaseAwareness(docName, clientId) {
      const owners = awarenessOwners.get(docName)
      if (!owners) return
      if (owners.get(clientId) === BOT_OWNER) owners.delete(clientId)
      if (owners.size === 0) awarenessOwners.delete(docName)
    },
  })

  /** A demo is throw-away, so a demo whose page outgrew its limit is simply ended. This keeps memory and storage bounded. */
  async function endOversizedDemo(sandboxId: string, docName: string, bytes: number) {
    log.warn({ doc: docName, bytes }, 'a demo page grew too large; ending the demo')
    await endSandbox(db, sandboxId)
    await sweepNow()
  }

  /** Saves a demo page (the same size limit is checked here for pages that were not measured while they grew). */
  async function storeDemoPage(pageId: string, state: Uint8Array) {
    if (state.byteLength > LIMITS.demoPageMaxBytes) {
      const [page] = await db.select({ sandboxId: sandboxPages.sandboxId }).from(sandboxPages).where(eq(sandboxPages.id, pageId))
      if (page) await endOversizedDemo(page.sandboxId, demoDocName(pageId), state.byteLength)
      return
    }
    // Like page_docs: nothing is written (and nothing fails) if the demo was deleted while people were typing.
    await db.execute(sql`
      insert into sandbox_docs (page_id, state, updated_at)
      select ${pageId}::uuid, ${Buffer.from(state)}, now()
      where exists (select 1 from sandbox_pages where id = ${pageId}::uuid)
      on conflict (page_id) do update set state = excluded.state, updated_at = excluded.updated_at
    `)
  }

  async function authenticate(
    token: string,
    docName: string,
    socket: SocketInfo,
    setReadOnly: (readOnly: boolean) => void,
  ): Promise<SyncContext> {
    const demoPageId = parseDemoDocName(docName)
    if (!demoPageId && !parseDocName(docName)) throw deny('unknown-document')

    let claims
    try {
      claims = await verifySyncToken(config.secret, token)
    } catch {
      throw deny('token-invalid')
    }
    if (claims.doc !== docName) throw deny('token-invalid')
    // The two kinds of token are not interchangeable: a guest's token opens guest pages only, an account's opens account pages only.
    if (demoPageId) return authenticateDemo(claims, docName, demoPageId, socket, setReadOnly)
    if (claims.kind !== 'account') throw deny('token-invalid')

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

    // Only editors and owners may change a page. The workspace channel carries
    // no edits at all, so nobody may write to it.
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

  /** A guest demo visitor: the cookie-backed visitor, the page and the demo must all belong together, and the demo must be alive. */
  async function authenticateDemo(
    claims: { userId: string; sessionId: string; kind: string },
    docName: string,
    pageId: string,
    socket: SocketInfo,
    setReadOnly: (readOnly: boolean) => void,
  ): Promise<SyncContext> {
    if (claims.kind !== 'demo') throw deny('token-invalid')
    if (!config.demo.enabled) throw deny(CLOSE_REASONS.demoEnded)
    const access = await demoDocAccess(db, config.demo, claims.userId, claims.sessionId, pageId)
    if (!access) throw deny(CLOSE_REASONS.demoEnded)

    let openByVisitor = 0
    for (const other of live) if (other.userId === claims.userId) openByVisitor += 1
    if (openByVisitor >= LIMITS.demoSocketsPerParticipant) throw deny(CLOSE_REASONS.tooManyConnections)

    // Every visitor of a demo may edit. There is no read-only guest.
    setReadOnly(false)
    socket.demo = true
    const meta: ConnMeta = {
      socket,
      docName,
      kind: 'demo',
      userId: claims.userId,
      sessionId: access.sandboxId,
      workspaceId: access.sandboxId,
      pageId: access.pageId,
      role: 'editor',
      displayName: access.displayName,
      cursorColor: access.cursorColor,
      awarenessIds: new Set(),
      connection: null,
      registered: false,
    }
    return { socket, meta }
  }

  function claimAwarenessId(meta: ConnMeta, clientId: number): boolean {
    if (meta.awarenessIds.has(clientId)) return true
    // A browser tab has one Yjs client id; allow a spare in case it regenerates it.
    if (meta.awarenessIds.size >= 2) return false
    let owners = awarenessOwners.get(meta.docName)
    if (!owners) awarenessOwners.set(meta.docName, (owners = new Map()))
    // Somebody else already speaks for this id. Every peer can SEE everyone's
    // client id, so without this check one person could move or hide another
    // person's cursor by sending updates in their name.
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

  // ---------------------------------------------------------------- revoking access

  /** The connection is over (closed by the browser or by us): stop counting it. */
  function forget(meta: ConnMeta) {
    meta.registered = false
    live.delete(meta)
    releaseAwarenessIds(meta)
    if (meta.kind === 'demo') {
      let remaining = 0
      for (const other of live) if (other.docName === meta.docName) remaining += 1
      bots.humanLeft(meta.docName, remaining)
    }
  }

  function kick(meta: ConnMeta, code: number, reason: string) {
    forget(meta)
    log.info({ conn: meta.socket.id, user: meta.userId, doc: meta.docName, reason }, 'sync closed by server')
    try {
      meta.connection?.close({ code, reason })
    } catch (error) {
      log.warn({ err: error }, 'closing a document connection failed')
    }
    closeSocket(meta.socket.ws, code, reason)
  }

  async function sweepDemos(open: ConnMeta[]): Promise<void> {
    if (open.length === 0) return
    const rows = await db
      .select({ id: sandboxParticipants.id, sandboxId: sandboxParticipants.sandboxId })
      .from(sandboxParticipants)
      .innerJoin(sandboxes, eq(sandboxes.id, sandboxParticipants.sandboxId))
      .where(and(inArray(sandboxParticipants.id, [...new Set(open.map((m) => m.userId))]), isAlive(config.demo)))
    const home = new Map(rows.map((row) => [row.id, row.sandboxId]))
    for (const meta of open) {
      if (!live.has(meta)) continue
      if (home.get(meta.userId) !== meta.workspaceId || !config.demo.enabled) kick(meta, CLOSE_CODES.demoEnded, CLOSE_REASONS.demoEnded)
    }
  }

  async function sweepOnce(): Promise<void> {
    const all = [...live]
    if (all.length === 0) return
    await sweepDemos(all.filter((meta) => meta.kind === 'demo'))
    const open = all.filter((meta) => meta.kind !== 'demo')
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
    if (!isAllowedOrigin(req.headers.origin ?? null, config.allowedOrigins)) return refuse(socket, 403, 'Forbidden')
    const ip = addressKey(clientIp(req))
    if (!upgrades.take(ip).ok) return refuse(socket, 429, 'Too Many Requests')
    if ((perIp.get(ip) ?? 0) >= config.limits.socketsPerIp) return refuse(socket, 429, 'Too Many Requests')
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req, ip))
  }

  function accept(ws: WebSocket, req: IncomingMessage, ip: string) {
    const info: SocketInfo = {
      id: randomBytes(4).toString('hex'),
      ws,
      ip,
      authenticated: false,
      alive: true,
      messages: new Budget(config.limits.messagesPerSecond),
      flooding: false,
      demo: false,
    }
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

    ws.on('message', (data: RawData) => {
      if (info.flooding) return
      const bytes = toBytes(data)
      const tooMany = !info.messages.tryTake()
      const tooBig = info.demo && bytes.byteLength > LIMITS.demoMessageMaxBytes
      if (tooMany || tooBig) {
        info.flooding = true
        log.warn({ conn: info.id, bytes: bytes.byteLength }, tooMany ? 'sync connection closed for sending too many messages' : 'sync connection closed for sending a message that is too big')
        closeSocket(ws, CLOSE_CODES.tooManyConnections, tooMany ? 'too-many-messages' : 'message-too-large')
        return
      }
      client.handleMessage(bytes)
    })
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
    stats: () => ({ sockets: sockets.size, connections: live.size, documents: hocuspocus.getDocumentsCount(), bots: bots.stats().sessions }),
    async close() {
      closing = true
      clearInterval(sweepTimer)
      await bots.close()
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
    case CLOSE_REASONS.demoEnded:
      return { code: CLOSE_CODES.demoEnded, reason }
    case 'token-invalid':
      return { code: CLOSE_CODES.unauthorized, reason }
    case 'server-error':
      return { code: 1011, reason }
    default:
      return { code: CLOSE_CODES.forbidden, reason: CLOSE_REASONS.accessRevoked }
  }
}

/** Ask politely, then insist: a client that ignores the closing handshake must not hold a socket open. */
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
