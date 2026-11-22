import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, describe, it } from 'node:test'
import { pageDocName, workspaceDocName } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import * as awarenessProtocol from 'y-protocols/awareness'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import { signSyncToken } from '../src/auth/syncToken'
import { pages, sessions } from '../src/db/schema'
import { Client, ORIGIN, RawClient, authFrame, frame, makeTeam, openDoc, settle, startTestServer, syncStep1Frame, textOf, typeInto, waitFor, type Peer, type Team, type TestServer } from './helpers'

/**
 * The front door of the sync server: who may open a WebSocket, and what a
 * connection has to prove before it gets to see or change anything.
 */

let server: TestServer
let team: Team
const raws: RawClient[] = []
const peers: Peer[] = []
afterEach(() => {
  for (const raw of raws.splice(0)) raw.close()
  for (const peer of peers.splice(0)) peer.destroy()
})

const tokenFor = async (client: Client, doc: string) => (await client.post('/api/sync-token', { doc })).body.token as string
const rawFor = (doc: string, target: TestServer = server) => {
  const raw = new RawClient(target.wsUrl, doc)
  raws.push(raw)
  return raw
}
const mint = (claims: { userId: string; sessionId: string; doc: string }, ttl = 60, target: TestServer = server) => signSyncToken(target.config.secret, claims, ttl).then((result) => result.token)
const sessionOf = async (userId: string) => (await server.db.select().from(sessions).where(eq(sessions.userId, userId)))[0].id

/** What happens when this exact token is presented for this document: the verdict and how the socket ended. */
async function present(doc: string, token: string) {
  const raw = rawFor(doc)
  const verdict = await raw.authenticate(token)
  if (verdict.kind === 'denied') await waitFor(() => raw.closed !== null, 3000, 'the server to hang up')
  return { verdict, raw }
}

before(async () => {
  server = await startTestServer()
  team = await makeTeam(server)
})
after(async () => {
  await server.close()
})

describe('sync tokens', () => {
  it('lets in a fresh token for the right page (control for everything below)', async () => {
    const { verdict } = await present(team.doc, await tokenFor(team.editor, team.doc))
    assert.deepEqual(verdict, { kind: 'authenticated', scope: 'read-write' })
  })

  it('refuses a token made for another page', async () => {
    const other = await team.owner.createPage(team.ws, 'Other')
    const token = await tokenFor(team.owner, pageDocName(other.id))
    const { verdict, raw } = await present(team.doc, token)
    assert.deepEqual(verdict, { kind: 'denied', reason: 'token-invalid' })
    assert.equal(raw.closed?.code, 4401)
  })

  it('refuses a page token for the workspace channel and the other way round', async () => {
    const channel = workspaceDocName(team.ws)
    assert.equal((await present(channel, await tokenFor(team.owner, team.doc))).verdict.kind, 'denied')
    assert.equal((await present(team.doc, await tokenFor(team.owner, channel))).verdict.kind, 'denied')
  })

  it('refuses empty, garbage and cut-off tokens', async () => {
    const good = await tokenFor(team.owner, team.doc)
    for (const token of ['', 'null', 'a.b.c', 'x'.repeat(4000), good.slice(0, -4), good.split('.').slice(0, 2).join('.'), `${good}x`]) {
      const { verdict, raw } = await present(team.doc, token)
      assert.deepEqual(verdict, { kind: 'denied', reason: 'token-invalid' }, token.slice(0, 20))
      assert.equal(raw.closed?.code, 4401)
    }
  })

  it('refuses tokens signed with a different secret', async () => {
    const forged = await signSyncToken(new TextEncoder().encode('not-the-real-secret-not-the-real-secret'), { userId: team.ids.owner, sessionId: await sessionOf(team.ids.owner), doc: team.doc }, 60)
    assert.equal((await present(team.doc, forged.token)).verdict.kind, 'denied')
  })

  it('refuses expired tokens', async () => {
    const token = await mint({ userId: team.ids.owner, sessionId: await sessionOf(team.ids.owner), doc: team.doc }, -5)
    assert.deepEqual((await present(team.doc, token)).verdict, { kind: 'denied', reason: 'token-invalid' })
  })

  it('refuses a perfectly signed token whose session has been logged out', async () => {
    const browser = new Client(server)
    await browser.post('/api/auth/login', { email: (await team.editor.get('/api/auth/me')).body.user.email, password: 'correct horse battery staple' })
    const token = await tokenFor(browser, team.doc)
    await browser.post('/api/auth/logout')
    const { verdict, raw } = await present(team.doc, token)
    assert.deepEqual(verdict, { kind: 'denied', reason: 'session-ended' })
    assert.equal(raw.closed?.code, 4401)
  })

  it('refuses a token that pairs one person with another person\'s session', async () => {
    const token = await mint({ userId: team.ids.viewer, sessionId: await sessionOf(team.ids.owner), doc: team.doc })
    assert.equal((await present(team.doc, token)).verdict.kind, 'denied')
  })

  it('refuses a perfectly signed token for someone who is not a member', async () => {
    const stranger = new Client(server)
    const account = await stranger.signup('Stranger')
    const token = await mint({ userId: account.user.id, sessionId: await sessionOf(account.user.id), doc: team.doc })
    const { verdict, raw } = await present(team.doc, token)
    assert.deepEqual(verdict, { kind: 'denied', reason: 'access-revoked' })
    assert.equal(raw.closed?.code, 4403)
  })

  it('refuses a perfectly signed token for a page that does not exist, or was deleted', async () => {
    const sessionId = await sessionOf(team.ids.owner)
    const missing = pageDocName(randomUUID())
    assert.equal((await present(missing, await mint({ userId: team.ids.owner, sessionId, doc: missing }))).verdict.kind, 'denied')

    const doomed = await team.owner.createPage(team.ws, 'Doomed')
    const doc = pageDocName(doomed.id)
    const token = await tokenFor(team.owner, doc)
    await team.owner.delete(`/api/pages/${doomed.id}`)
    assert.deepEqual((await present(doc, token)).verdict, { kind: 'denied', reason: 'access-revoked' })
  })

  it('refuses a token for a page that was deleted for good', async () => {
    const doomed = await team.owner.createPage(team.ws, 'Doomed for good')
    const doc = pageDocName(doomed.id)
    const token = await tokenFor(team.owner, doc)
    await server.db.delete(pages).where(eq(pages.id, doomed.id))
    assert.deepEqual((await present(doc, token)).verdict, { kind: 'denied', reason: 'access-revoked' })
  })
})

describe('document names', () => {
  it('hangs up at once on names this server never hands out', async () => {
    const token = await tokenFor(team.owner, team.doc)
    const names = ['admin', 'page', 'page.', 'page.not-a-uuid', team.doc.toUpperCase(), `${team.doc}.extra`, ` ${team.doc}`, `${team.doc}\n`, 'workspace', `page.${'a'.repeat(5000)}`, '../../etc/passwd', 'page.%00']
    for (const name of names) {
      const raw = rawFor(name)
      const verdict = await raw.authenticate(token)
      assert.deepEqual(verdict, { kind: 'denied', reason: 'unknown-document' }, JSON.stringify(name.slice(0, 30)))
      await waitFor(() => raw.closed !== null, 2000, 'the socket to close')
      assert.equal(raw.closed?.code, 4403)
    }
  })
})

describe('the WebSocket handshake', () => {
  const status = (url: string, headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { headers })
      ws.on('open', () => {
        ws.terminate()
        resolve(101)
      })
      ws.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
        ws.terminate()
      })
      ws.on('error', () => undefined)
    })

  it('accepts the app\'s own origin', async () => {
    assert.equal(await status(server.wsUrl, { Origin: ORIGIN }), 101)
    assert.equal(await status(`${server.wsUrl}?client=web`, { Origin: ORIGIN }), 101)
  })

  it('refuses other websites, a missing Origin, and look-alikes', async () => {
    for (const origin of ['http://evil.example', 'null', `${ORIGIN}.evil.example`, 'https://localhost:5173', 'http://localhost:5173/x']) {
      assert.equal(await status(server.wsUrl, { Origin: origin }), 403, origin)
    }
    assert.equal(await status(server.wsUrl, {}), 403, 'no Origin header')
  })

  it('answers 404 on any other path', async () => {
    const base = server.wsUrl.replace('/collab', '')
    for (const path of ['', '/', '/api', '/collab/x', '/collab/', '/COLLAB', '/health']) assert.equal(await status(base + path, { Origin: ORIGIN }), 404, path)
  })
})

describe('before a connection has proven who it is', () => {
  it('gets nothing back, and is hung up on at the deadline', async () => {
    const quick = await startTestServer({ patch: (config) => ({ ...config, authDeadlineMs: 500 }) })
    try {
      const raw = rawFor(team.doc, quick)
      await raw.opened()
      raw.send(syncStep1Frame(team.doc)) // "send me everything you have", without saying who I am
      await waitFor(() => raw.closed !== null, 3000, 'the deadline')
      assert.deepEqual(raw.closed, { code: 4401, reason: 'auth-timeout' })
      assert.deepEqual(raw.received, [], 'not one byte of any answer')
    } finally {
      await quick.close()
    }
  })

  it('cannot use access to one page to read another page on the same connection', async () => {
    const stranger = new Client(server)
    const account = await stranger.signup('Stranger')
    const mine = pageDocName(account.welcomePageId)

    const raw = rawFor(mine)
    const own = await tokenFor(stranger, mine)
    assert.deepEqual(await raw.authenticate(own), { kind: 'authenticated', scope: 'read-write' })
    await settle(300) // let the server's own opening messages arrive first
    const before = raw.received.length
    // The same socket now asks for the team's page: first without papers, then with the papers for its own page.
    raw.send(syncStep1Frame(team.doc))
    raw.send(authFrame(team.doc, own))
    await settle(600)
    const leaked = raw.received.slice(before).filter((message) => message.kind === 'sync' || message.kind === 'authenticated')
    assert.deepEqual(leaked, [])
  })

  it('is cut off when it floods the door with messages instead of a token', async () => {
    const raw = rawFor(team.doc)
    await raw.opened()
    const noise = syncStep1Frame(team.doc)
    for (let i = 0; i < 1500 && raw.closed === null; i++) raw.send(noise)
    await waitFor(() => raw.closed !== null, 5000, 'the flood to be cut off')
  })

  it('survives garbage without hurting anyone else', async () => {
    const peer = openDoc(server, team.editor, team.doc)
    peers.push(peer)
    await peer.synced
    for (const junk of [new Uint8Array([255, 255, 255, 255, 255]), new Uint8Array(0), new Uint8Array(1000).fill(7), Buffer.from('hello')]) {
      const raw = rawFor(team.doc)
      await raw.opened()
      raw.send(junk)
      await settle(50)
      raw.close()
    }
    const authed = rawFor(team.doc)
    await authed.authenticate(await tokenFor(team.viewer, team.doc))
    authed.send(new Uint8Array([9, 9, 9, 9, 9, 9, 9]))
    await settle(200)
    typeInto(peer, 'still working')
    await waitFor(() => peer.provider.unsyncedChanges === 0)
    assert.equal(textOf(peer), 'still working')
    assert.equal((await new Client(server).get('/health')).status, 200)
  })
})

describe('malformed messages from signed-in connections', () => {
  // A signed-in person can send any bytes at all. Whatever they are, the server must carry on for everybody else.
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('keeps serving everybody, from an editor and from a viewer, whatever bytes they send', async () => {
    const trouble: unknown[] = []
    const onTrouble = (error: unknown) => trouble.push(error)
    process.on('uncaughtException', onTrouble)
    process.on('unhandledRejection', onTrouble)
    // The sync library reports every refused message on the console, hundreds of lines here.
    const consoleError = console.error
    console.error = () => undefined
    try {
      const bystander = openDoc(server, team.owner, team.doc)
      peers.push(bystander)
      await bystander.synced

      // Frames a real client sends, to be damaged.
      const doc = new Y.Doc()
      doc.getText('t').insert(0, 'hello world')
      const someUpdate = Y.encodeStateAsUpdate(doc)
      const awareness = new awarenessProtocol.Awareness(new Y.Doc())
      awareness.setLocalState({ cursor: null })
      const state = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
      awareness.destroy()
      const good = (name: string): Uint8Array[] => [
        syncStep1Frame(name),
        frame(name, 0, (e) => { encoding.writeVarUint(e, 1); encoding.writeVarUint8Array(e, someUpdate) }),
        frame(name, 0, (e) => { encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, someUpdate) }),
        frame(name, 1, (e) => encoding.writeVarUint8Array(e, state)),
        frame(name, 3, () => undefined), // ask for everyone's presence
        frame(name, 5, (e) => encoding.writeVarString(e, 'hello')), // a message that is not an edit
        frame(name, 6, (e) => encoding.writeVarString(e, 'broadcast')), // one only servers may send
        frame(name, 2, (e) => { encoding.writeVarUint(e, 0); encoding.writeVarString(e, 'a token again') }),
        frame(name, 7, () => undefined),
      ]
      const random = mulberry(20261122)
      const damage = (bytes: Uint8Array): Uint8Array => {
        const copy = Uint8Array.from(bytes)
        switch (Math.floor(random() * 5)) {
          case 0: return copy.slice(0, Math.floor(random() * copy.length)) // cut off
          case 1: for (let i = 0; i < 3; i++) copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256); return copy // bytes changed
          case 2: return Uint8Array.from([...copy, ...Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * 256))]) // junk added
          case 3: { const at = 1 + Math.floor(random() * Math.max(1, copy.length - 1)); copy[at] = 255; return copy } // a huge length or number
          default: return copy
        }
      }

      for (const who of [team.editor, team.viewer]) {
        let raw = rawFor(team.doc)
        const reopen = async () => {
          raw = rawFor(team.doc)
          assert.equal((await raw.authenticate(await tokenFor(who, team.doc))).kind, 'authenticated')
        }
        await reopen()
        const frames = good(team.doc)
        for (let round = 0; round < 250; round++) {
          if (raw.closed !== null) await reopen() // the server may hang up on bad input; that is allowed
          raw.send(damage(frames[Math.floor(random() * frames.length)]))
          if (round % 25 === 24) {
            await settle(30)
            assert.equal((await new Client(server).get('/health')).status, 200, `health after round ${round}`)
          }
        }
        await settle(100)
      }

      // Everybody else carries on as if nothing happened.
      // (The editor's damaged frames include whole, valid edits, which an editor may make, so the page may hold more than this.)
      typeInto(bystander, 'still here')
      await waitFor(() => bystander.provider.unsyncedChanges === 0, 5000, 'the bystander to save')
      assert.match(textOf(bystander), /still here/)
      const late = openDoc(server, team.editor, team.doc)
      peers.push(late)
      await late.synced
      assert.equal(textOf(late), textOf(bystander), 'a new connection sees the same page')
      assert.equal((await new Client(server).get('/health')).status, 200)
      assert.deepEqual(trouble.map(String), [], 'no uncaught error escaped')
    } finally {
      console.error = consoleError
      process.off('uncaughtException', onTrouble)
      process.off('unhandledRejection', onTrouble)
    }
  })
})

describe('limits', () => {
  it('closes messages bigger than 4 MiB', async () => {
    const raw = rawFor(team.doc)
    assert.equal((await raw.authenticate(await tokenFor(team.editor, team.doc))).kind, 'authenticated')
    raw.send(new Uint8Array(5 * 1024 * 1024))
    await waitFor(() => raw.closed !== null, 5000, 'the oversized message to be refused')
    assert.equal(raw.closed?.code, 1009)
  })

  it('caps the connections one person can hold open', async () => {
    const small = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, socketsPerUser: 2 } }) })
    try {
      const crew = await makeTeam(small)
      const docs = [crew.doc, workspaceDocName(crew.ws)]
      const extra = await crew.owner.createPage(crew.ws, 'Third')
      const first = rawFor(docs[0], small)
      const second = rawFor(docs[1], small)
      assert.equal((await first.authenticate(await tokenFor(crew.editor, docs[0]))).kind, 'authenticated')
      assert.equal((await second.authenticate(await tokenFor(crew.editor, docs[1]))).kind, 'authenticated')
      await waitFor(() => small.sync.stats().connections === 2)

      const third = rawFor(pageDocName(extra.id), small)
      const verdict = await third.authenticate(await tokenFor(crew.editor, pageDocName(extra.id)))
      assert.deepEqual(verdict, { kind: 'denied', reason: 'too-many-connections' })
      await waitFor(() => third.closed !== null)
      assert.equal(third.closed?.code, 4429)

      // someone else is not affected by this person's limit
      const other = rawFor(docs[0], small)
      assert.equal((await other.authenticate(await tokenFor(crew.viewer, docs[0]))).kind, 'authenticated')

      // and closing one frees a slot
      first.close()
      await waitFor(() => small.sync.stats().connections === 2, 3000)
      const again = rawFor(pageDocName(extra.id), small)
      assert.equal((await again.authenticate(await tokenFor(crew.editor, pageDocName(extra.id)))).kind, 'authenticated')
    } finally {
      for (const raw of raws.splice(0)) raw.close()
      await small.close()
    }
  })

  it('caps the sockets one address can hold open', async () => {
    const small = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, socketsPerIp: 2 } }) })
    try {
      const status = (url: string) =>
        new Promise<{ code: number; ws?: WebSocket }>((resolve) => {
          const ws = new WebSocket(url, { headers: { Origin: ORIGIN } })
          ws.on('open', () => resolve({ code: 101, ws }))
          ws.on('unexpected-response', (_request, response) => {
            response.resume()
            resolve({ code: response.statusCode ?? 0 })
          })
          ws.on('error', () => undefined)
        })
      const held = [await status(small.wsUrl), await status(small.wsUrl)]
      assert.deepEqual(held.map((entry) => entry.code), [101, 101])
      assert.equal((await status(small.wsUrl)).code, 429)
      held[0].ws!.terminate()
      await waitFor(async () => (await status(small.wsUrl)).code === 101, 3000, 'a free slot')
      for (const entry of held) entry.ws?.terminate()
    } finally {
      await small.close()
    }
  })

  it('limits how fast one address may open new sockets', async () => {
    const small = await startTestServer({ patch: (config) => ({ ...config, limits: { ...config.limits, socketUpgrades: { max: 3, windowMs: 60_000 } } }) })
    try {
      const codes: number[] = []
      for (let i = 0; i < 5; i++) {
        codes.push(
          await new Promise<number>((resolve) => {
            const ws = new WebSocket(small.wsUrl, { headers: { Origin: ORIGIN } })
            ws.on('open', () => {
              ws.terminate()
              resolve(101)
            })
            ws.on('unexpected-response', (_request, response) => {
              response.resume()
              resolve(response.statusCode ?? 0)
            })
            ws.on('error', () => undefined)
          }),
        )
      }
      assert.deepEqual(codes, [101, 101, 101, 429, 429])
    } finally {
      await small.close()
    }
  })
})

describe('asking for sync tokens', () => {
  it('is limited per person', async () => {
    const strict = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
    try {
      const crew = await makeTeam(strict)
      let limitedAt = -1
      for (let i = 0; i < 400; i++) {
        const reply = await crew.editor.post('/api/sync-token', { doc: crew.doc })
        if (reply.status === 429) {
          limitedAt = i
          break
        }
      }
      assert.ok(limitedAt >= 250 && limitedAt <= 300, `limited at ${limitedAt}`)
      // another person is not affected
      assert.equal((await crew.viewer.post('/api/sync-token', { doc: crew.doc })).status, 200)
    } finally {
      await strict.close()
    }
  })

  it('rejects odd requests', async () => {
    for (const body of [{}, { doc: '' }, { doc: 5 }, { doc: 'admin' }, { doc: team.doc, extra: 1 }, { doc: `${team.doc}\n` }, { doc: ['x'] }]) {
      const reply = await team.owner.post('/api/sync-token', body)
      assert.ok(reply.status === 400 || reply.status === 404, JSON.stringify(body))
    }
  })

  it('hands out tokens that expire within a minute and name exactly one document', async () => {
    const reply = await team.owner.post('/api/sync-token', { doc: team.doc })
    assert.equal(reply.status, 200)
    const left = new Date(reply.body.expiresAt).getTime() - Date.now()
    assert.ok(left > 50_000 && left <= 60_000, `${left} ms`)
    const payload = JSON.parse(Buffer.from(reply.body.token.split('.')[1], 'base64url').toString())
    assert.equal(payload.doc, team.doc)
    assert.equal(payload.role, undefined)
  })
})
