import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it, type TestContext } from 'node:test'
import { pageDocName, workspaceDocName } from '@conflux/shared'
import { and, eq } from 'drizzle-orm'
import { memberships, sessions, users } from '../src/db/schema'
import { Client, PASSWORD, RawClient, makeTeam, openDoc, settle, startTestServer, textOf, typeInto, untilClosed, waitFor, type Peer, type TestServer } from './helpers'

/**
 * PRD exit criterion: "a removed member loses live access within 5 seconds".
 *
 * Every test below starts with real people connected over real WebSockets,
 * then takes access away in one of the ways the product allows, and measures
 * how long the connection stays alive. There are two layers behind it:
 *   - the API tells the sync server the moment it changes access (milliseconds), and
 *   - a sweeper re-checks every connection against the database every 2 seconds,
 *     so it still works if something changed the database behind the API's back.
 * Tests of the second layer change the database directly.
 */

const LIMIT_MS = 5000
const FORBIDDEN = 4403
const SESSION_ENDED = 4401
const ROLE_CHANGED = 4430

let server: TestServer
const peers: Peer[] = []
const raws: RawClient[] = []

before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})
afterEach(() => {
  for (const peer of peers.splice(0)) peer.destroy()
  for (const raw of raws.splice(0)) raw.close()
})

const connect = (client: Client, doc: string) => {
  const peer = openDoc(server, client, doc)
  peers.push(peer)
  return peer
}
const connectAll = async (client: Client, docs: string[]) => {
  const opened = docs.map((doc) => connect(client, doc))
  await Promise.all(opened.map((peer) => peer.synced))
  return opened
}
const untouched = async (...list: Peer[]) => {
  await settle(1200)
  for (const peer of list) assert.deepEqual(peer.closes, [], 'a connection that should not have been touched was closed')
}
const timed = async (t: TestContext, what: string, started: number, work: Promise<unknown>) => {
  await work
  const took = Date.now() - started
  t.diagnostic(`${what}: ${took} ms (limit ${LIMIT_MS} ms)`)
  assert.ok(took < LIMIT_MS, `${what} took ${took} ms`)
  return took
}

describe('a removed member loses live access within 5 seconds', () => {
  for (const role of ['editor', 'viewer'] as const) {
    it(`when the owner removes a ${role}: every page and the workspace channel they had open, in one go`, async (t) => {
      const crew = await makeTeam(server)
      const second = await crew.owner.createPage(crew.ws, 'Second page')
      const member = crew[role]
      const memberId = crew.ids[role]
      const mine = await connectAll(member, [crew.doc, pageDocName(second.id), workspaceDocName(crew.ws)])
      const others = await connectAll(crew.owner, [crew.doc])
      const bystander = await connectAll(role === 'editor' ? crew.viewer : crew.editor, [crew.doc])

      const started = Date.now()
      const removal = await crew.owner.delete(`/api/workspaces/${crew.ws}/members/${memberId}`)
      assert.equal(removal.status, 204)
      await timed(t, 'API removal closed all three connections', started, Promise.all(mine.map((peer) => untilClosed(peer, FORBIDDEN, LIMIT_MS))))

      await untouched(...others, ...bystander)
      assert.equal((await member.get(`/api/workspaces/${crew.ws}`)).status, 404)
      assert.equal((await member.post('/api/sync-token', { doc: crew.doc })).status, 404, 'and no new token can be had')

      // Whatever the removed person types now goes nowhere.
      typeInto(mine[0], 'typed after removal')
      await settle(800)
      assert.equal(textOf(others[0]), '')
      assert.equal(textOf(bystander[0]), '')
    })
  }

  it('even when nothing tells the sync server: the 2-second sweeper notices a change made straight in the database', async (t) => {
    const crew = await makeTeam(server)
    const [page, channel] = await connectAll(crew.editor, [crew.doc, workspaceDocName(crew.ws)])
    const [bystander] = await connectAll(crew.owner, [crew.doc])

    const started = Date.now()
    await server.db.delete(memberships).where(and(eq(memberships.workspaceId, crew.ws), eq(memberships.userId, crew.ids.editor)))
    const took = await timed(t, 'sweeper closed both connections', started, Promise.all([untilClosed(page, FORBIDDEN, LIMIT_MS), untilClosed(channel, FORBIDDEN, LIMIT_MS)]))
    assert.ok(took >= 0)
    await untouched(bystander)
  })

  it('and for sessions that end behind the API\'s back: deleting the account', async (t) => {
    const crew = await makeTeam(server)
    const [peer] = await connectAll(crew.editor, [crew.doc])
    const started = Date.now()
    await server.db.delete(users).where(eq(users.id, crew.ids.editor))
    await timed(t, 'account deletion closed the connection', started, untilClosed(peer, SESSION_ENDED, LIMIT_MS))
  })

  it('a token fetched BEFORE the removal is useless AFTER it (tokens are only a first check)', async () => {
    const crew = await makeTeam(server)
    const token = (await crew.editor.post('/api/sync-token', { doc: crew.doc })).body.token as string
    await crew.owner.delete(`/api/workspaces/${crew.ws}/members/${crew.ids.editor}`)
    const raw = new RawClient(server.wsUrl, crew.doc)
    raws.push(raw)
    assert.deepEqual(await raw.authenticate(token), { kind: 'denied', reason: 'access-revoked' })
    await waitFor(() => raw.closed !== null)
    assert.equal(raw.closed?.code, FORBIDDEN)
  })

  it('and trying again, the ordinary way, never gets a single byte of the page', async () => {
    const crew = await makeTeam(server)
    const [owner] = await connectAll(crew.owner, [crew.doc])
    typeInto(owner, 'confidential')
    await waitFor(() => owner.provider.unsyncedChanges === 0)
    await crew.owner.delete(`/api/workspaces/${crew.ws}/members/${crew.ids.editor}`)

    const retry = connect(crew.editor, crew.doc)
    await waitFor(() => retry.denied.length > 0, 5000, 'the server to say no')
    await settle(500)
    assert.equal(textOf(retry), '')
    assert.equal(retry.provider.synced, false)
  })

  it('a person who is removed and invited again gets back in, with fresh access', async () => {
    const crew = await makeTeam(server)
    const [first] = await connectAll(crew.viewer, [crew.doc])
    await crew.owner.delete(`/api/workspaces/${crew.ws}/members/${crew.ids.viewer}`)
    await untilClosed(first, FORBIDDEN, LIMIT_MS)
    await crew.owner.invite(crew.ws, crew.viewer, 'viewer')
    const [again] = await connectAll(crew.viewer, [crew.doc])
    assert.equal(again.isReadOnly(), true)
  })

  it('leaving a workspace closes your own connections', async (t) => {
    const crew = await makeTeam(server)
    const mine = await connectAll(crew.viewer, [crew.doc, workspaceDocName(crew.ws)])
    const started = Date.now()
    assert.equal((await crew.viewer.delete(`/api/workspaces/${crew.ws}/members/${crew.ids.viewer}`)).status, 204)
    await timed(t, 'leaving closed both connections', started, Promise.all(mine.map((peer) => untilClosed(peer, FORBIDDEN, LIMIT_MS))))
  })
})

describe('other ways access ends', () => {
  it('deleting a page closes that page\'s connections and leaves the rest alone', async (t) => {
    const crew = await makeTeam(server)
    const second = await crew.owner.createPage(crew.ws, 'Second')
    const [doomed, bystander, channel] = await connectAll(crew.editor, [crew.doc, pageDocName(second.id), workspaceDocName(crew.ws)])
    const [ownerOnDoomed] = await connectAll(crew.owner, [crew.doc])

    const started = Date.now()
    assert.equal((await crew.owner.delete(`/api/pages/${crew.pageId}`)).status, 204)
    await timed(t, 'page deletion closed its connections', started, Promise.all([untilClosed(doomed, FORBIDDEN, LIMIT_MS), untilClosed(ownerOnDoomed, FORBIDDEN, LIMIT_MS)]))
    await untouched(bystander, channel)
  })

  it('deleting the workspace closes every connection of every member', async (t) => {
    const crew = await makeTeam(server)
    const all = [
      ...(await connectAll(crew.owner, [crew.doc, workspaceDocName(crew.ws)])),
      ...(await connectAll(crew.editor, [crew.doc, workspaceDocName(crew.ws)])),
      ...(await connectAll(crew.viewer, [crew.doc, workspaceDocName(crew.ws)])),
    ]
    const started = Date.now()
    assert.equal((await crew.owner.delete(`/api/workspaces/${crew.ws}`)).status, 204)
    await timed(t, 'workspace deletion closed six connections', started, Promise.all(all.map((peer) => untilClosed(peer, FORBIDDEN, LIMIT_MS))))
  })

  it('logging out closes that browser\'s connections, and only that browser\'s', async (t) => {
    const crew = await makeTeam(server)
    const email = (await crew.editor.get('/api/auth/me')).body.user.email
    const otherBrowser = new Client(server)
    assert.equal((await otherBrowser.post('/api/auth/login', { email, password: PASSWORD })).status, 200)

    const [thisTab] = await connectAll(crew.editor, [crew.doc])
    const [otherTab] = await connectAll(otherBrowser, [crew.doc])
    const started = Date.now()
    assert.equal((await crew.editor.post('/api/auth/logout')).status, 204)
    await timed(t, 'logout closed the connection', started, untilClosed(thisTab, SESSION_ENDED, LIMIT_MS))
    await untouched(otherTab)
    // ...and the other browser keeps working
    typeInto(otherTab, 'still here')
    await waitFor(() => otherTab.provider.unsyncedChanges === 0)
  })

  it('a session that expires is noticed by the sweeper', async (t) => {
    const crew = await makeTeam(server)
    const [peer] = await connectAll(crew.editor, [crew.doc])
    const started = Date.now()
    await server.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, crew.ids.editor))
    await timed(t, 'expiry closed the connection', started, untilClosed(peer, SESSION_ENDED, LIMIT_MS))
  })
})

describe('changes of role', () => {
  it('apply at once: a demoted editor comes back read-only, and a promoted viewer comes back able to write', async (t) => {
    const crew = await makeTeam(server)
    const [editor] = await connectAll(crew.editor, [crew.doc])
    const [owner] = await connectAll(crew.owner, [crew.doc])
    assert.equal(editor.isReadOnly(), false)

    // down
    let started = Date.now()
    assert.equal((await crew.owner.patch(`/api/workspaces/${crew.ws}/members/${crew.ids.editor}`, { role: 'viewer' })).status, 200)
    await timed(t, 'demotion restarted the connection', started, untilClosed(editor, ROLE_CHANGED, LIMIT_MS))
    await waitFor(() => editor.isReadOnly() && editor.provider.synced, LIMIT_MS, 'the connection to come back read-only')
    typeInto(editor, 'no longer allowed')
    await settle(800)
    assert.equal(textOf(owner), '', 'the demoted editor\'s typing is ignored')

    // and up again
    started = Date.now()
    assert.equal((await crew.owner.patch(`/api/workspaces/${crew.ws}/members/${crew.ids.editor}`, { role: 'editor' })).status, 200)
    await timed(t, 'promotion restarted the connection', started, waitFor(() => editor.closes.filter((close) => close.code === ROLE_CHANGED).length >= 2, LIMIT_MS))
    await waitFor(() => !editor.isReadOnly() && editor.provider.synced, LIMIT_MS, 'the connection to come back read-write')
    typeInto(editor, 'allowed again')
    await waitFor(() => textOf(owner).includes('allowed again'), 3000, 'the owner to see it')
  })

  it('are noticed by the sweeper too, when the database is changed directly', async (t) => {
    const crew = await makeTeam(server)
    const [editor] = await connectAll(crew.editor, [crew.doc])
    const started = Date.now()
    await server.db.update(memberships).set({ role: 'viewer' }).where(and(eq(memberships.workspaceId, crew.ws), eq(memberships.userId, crew.ids.editor)))
    await timed(t, 'sweeper restarted the connection', started, untilClosed(editor, ROLE_CHANGED, LIMIT_MS))
    await waitFor(() => editor.isReadOnly(), LIMIT_MS, 'read-only again')
  })
})

describe('under load', () => {
  it('still cuts one person off promptly while a crowd of other connections is busy typing', async (t) => {
    const crew = await makeTeam(server)
    const pages = [crew.doc, pageDocName((await crew.owner.createPage(crew.ws, 'B')).id), pageDocName((await crew.owner.createPage(crew.ws, 'C')).id)]
    const victimTabs = await connectAll(crew.editor, pages)

    const crowd: Peer[] = []
    for (let i = 0; i < 6; i++) {
      const person = new Client(server)
      await person.signup(`Crowd ${i}`)
      await crew.owner.invite(crew.ws, person, 'editor')
      crowd.push(...(await connectAll(person, pages)))
    }
    assert.equal(server.sync.stats().connections, 3 + 18)

    // Everyone types all the time.
    const typing = setInterval(() => {
      for (const peer of crowd) peer.doc.getText('t').insert(0, '.')
    }, 40)
    try {
      await settle(300)
      const started = Date.now()
      assert.equal((await crew.owner.delete(`/api/workspaces/${crew.ws}/members/${crew.ids.editor}`)).status, 204)
      await timed(t, 'removal under load closed all three of their connections', started, Promise.all(victimTabs.map((peer) => untilClosed(peer, FORBIDDEN, LIMIT_MS))))
    } finally {
      clearInterval(typing)
    }
    for (const peer of crowd) assert.deepEqual(peer.closes, [], 'nobody else was disturbed')

    // The busy pages converge to the same text everywhere.
    await waitFor(() => crowd.every((peer) => peer.provider.unsyncedChanges === 0), 5000, 'all edits to be acknowledged')
    const first = crowd.filter((_, i) => i % 3 === 0)
    await waitFor(() => first.every((peer) => textOf(peer) === textOf(first[0])), 5000, 'everyone to see the same text')
  })
})
