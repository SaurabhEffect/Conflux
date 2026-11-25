import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, describe, it } from 'node:test'
import { demoDocName, workspaceDocName } from '@conflux/shared'
import { signSyncToken } from '../src/auth/syncToken'
import { Client, RawClient, makeTeam, startTestServer, waitFor, type Team, type TestServer } from './helpers'
import { makeDemo, sandboxIdOf, type Visitor } from './demo-helpers'

let server: TestServer
let team: Team
const raws: RawClient[] = []

before(async () => {
  server = await startTestServer()
  team = await makeTeam(server)
})
after(async () => {
  await server.close()
})
afterEach(() => {
  for (const raw of raws.splice(0)) raw.close()
})

const holding = (cookie: string | null) => {
  const client = new Client(server)
  client.cookie = cookie
  return client
}
const secretOf = (client: Client) => client.cookie!.split('=').slice(1).join('=')

const mint = (userId: string, sessionId: string, doc: string, kind: 'account' | 'demo') =>
  signSyncToken(server.config.secret, { userId, sessionId, doc, kind }, 60).then((result) => result.token)

async function present(doc: string, token: string) {
  const raw = new RawClient(server.wsUrl, doc)
  raws.push(raw)
  const verdict = await raw.authenticate(token)
  if (verdict.kind === 'denied') await waitFor(() => raw.closed !== null, 3000, 'the server to hang up')
  return { verdict, raw }
}

const demoTokenFor = async (visitor: Visitor, doc: string) => (await visitor.client.post('/api/demo/sync-token', { doc })).body.token as string

describe('a guest cannot touch a real account', () => {
  it('opens no account API with the guest cookie', async () => {
    const { host } = await makeDemo(server)
    const guest = holding(host.client.cookie)
    const attempts: [string, string, unknown?][] = [
      ['GET', '/api/auth/me'],
      ['GET', `/api/workspaces/${team.ws}`],
      ['GET', `/api/workspaces/${team.ws}/pages`],
      ['GET', `/api/workspaces/${team.ws}/members`],
      ['POST', '/api/sync-token', { doc: team.doc }],
      ['POST', '/api/workspaces', { name: 'Planted by a guest' }],
      ['POST', `/api/workspaces/${team.ws}/pages`, { title: 'Planted by a guest' }],
    ]
    for (const [method, url, body] of attempts) {
      const reply = await guest.request(method, url, body)
      assert.equal(reply.status, 401, `${method} ${url}`)
    }
  })

  it('does not take a guest secret for a sign-in, or a sign-in secret for a guest', async () => {
    const { host } = await makeDemo(server)
    const guestSecret = secretOf(host.client)
    const accountSecret = secretOf(team.owner)
    const asSession = await new Client(server).request('GET', '/api/auth/me', undefined, { Cookie: `conflux_session=${guestSecret}` })
    assert.equal(asSession.status, 401)
    const asGuest = await new Client(server).request('POST', '/api/demo/end', undefined, { Cookie: `conflux_demo=${accountSecret}` })
    assert.equal(asGuest.status, 401)
    assert.equal((await host.client.post('/api/demo/join', { ticket: 'A'.repeat(43) })).status, 404, 'and the demo is untouched')
  })

  it('cannot get a sync token for an account page, the workspace channel, or anything that is not a demo page', async () => {
    const { host } = await makeDemo(server)
    for (const doc of [team.doc, workspaceDocName(team.ws), 'page.not-a-uuid', 'demo.not-a-uuid', 'demo.', '']) {
      const reply = await host.client.post('/api/demo/sync-token', { doc })
      assert.ok(reply.status === 400 || reply.status === 404, `${doc}: ${reply.status}`)
      assert.equal(reply.body?.token, undefined)
    }
  })

  it('cannot open an account page or the workspace channel with a hand-made guest token', async () => {
    const { host } = await makeDemo(server)
    const me = host.state.me.id
    const demoId = await sandboxIdOf(server, host)
    for (const doc of [team.doc, workspaceDocName(team.ws)]) {
      const { verdict, raw } = await present(doc, await mint(me, demoId, doc, 'demo'))
      assert.deepEqual(verdict, { kind: 'denied', reason: 'token-invalid' }, doc)
      assert.equal(raw.closed?.code, 4401)
    }
  })
})

describe('an account cannot touch a demo', () => {
  it('opens no demo API with a sign-in cookie', async () => {
    const { host } = await makeDemo(server)
    const demoPage = demoDocName(host.state.pages[0].id)
    assert.equal((await team.owner.post('/api/demo/sync-token', { doc: demoPage })).status, 401)
    assert.equal((await team.owner.post('/api/demo/end')).status, 401)
    assert.equal((await team.owner.post('/api/demo/leave')).status, 401)
  })

  it('cannot get an account token for a demo page', async () => {
    const { host } = await makeDemo(server)
    const reply = await team.owner.post('/api/sync-token', { doc: demoDocName(host.state.pages[0].id) })
    assert.ok(reply.status === 400 || reply.status === 404, `status ${reply.status}`)
    assert.equal(reply.body?.token, undefined)
  })

  it('cannot open a demo page with a hand-made account token, even with a real account and session', async () => {
    const { host } = await makeDemo(server)
    const doc = demoDocName(host.state.pages[0].id)
    const [session] = await server.db.query.sessions.findMany({ where: (s, { eq }) => eq(s.userId, team.ids.owner) })
    const { verdict, raw } = await present(doc, await mint(team.ids.owner, session.id, doc, 'account'))
    assert.deepEqual(verdict, { kind: 'denied', reason: 'token-invalid' })
    assert.equal(raw.closed?.code, 4401)
  })

  it('cannot open a demo page with a real account token made for a different document', async () => {
    const { host } = await makeDemo(server)
    const { verdict } = await present(demoDocName(host.state.pages[0].id), (await team.owner.post('/api/sync-token', { doc: team.doc })).body.token)
    assert.deepEqual(verdict, { kind: 'denied', reason: 'token-invalid' })
  })
})

describe('one demo cannot reach another', () => {
  let a: Awaited<ReturnType<typeof makeDemo>>
  let b: Awaited<ReturnType<typeof makeDemo>>
  let aId: string
  let bId: string
  before(async () => {
    a = await makeDemo(server)
    b = await makeDemo(server)
    aId = await sandboxIdOf(server, a.host)
    bId = await sandboxIdOf(server, b.host)
  })

  it('gets no token for a page of another demo, or for a page that does not exist', async () => {
    for (const page of [b.host.state.pages[0].id, b.host.state.pages[2].id, randomUUID()]) {
      const reply = await a.host.client.post('/api/demo/sync-token', { doc: demoDocName(page) })
      assert.equal(reply.status, 404, page)
      assert.equal(reply.body.token, undefined)
    }
  })

  it('opens its own page (control for the refusals below)', async () => {
    const doc = demoDocName(a.host.state.pages[0].id)
    const { verdict } = await present(doc, await demoTokenFor(a.host, doc))
    assert.deepEqual(verdict, { kind: 'authenticated', scope: 'read-write' })
  })

  it('is refused when a hand-made token mixes one demo’s visitor with another demo’s page or id', async () => {
    const docA = demoDocName(a.host.state.pages[0].id)
    const docB = demoDocName(b.host.state.pages[0].id)
    const me = a.host.state.me.id
    const mixes: [string, string, string][] = [
      ['A’s visitor, A’s demo, B’s page', aId, docB],
      ['A’s visitor, B’s demo, B’s page', bId, docB],
      ['A’s visitor, B’s demo, A’s page', bId, docA],
      ['a stranger, A’s demo, A’s page', aId, docA],
    ]
    for (const [label, demoId, doc] of mixes) {
      const visitor = label.startsWith('a stranger') ? randomUUID() : me
      const { verdict, raw } = await present(doc, await mint(visitor, demoId, doc, 'demo'))
      assert.deepEqual(verdict, { kind: 'denied', reason: 'demo-ended' }, label)
      assert.equal(raw.closed?.code, 4410, label)
    }
  })

  it('cannot use another demo’s visitor either: B’s visitor does not open A’s page', async () => {
    const docA = demoDocName(a.host.state.pages[0].id)
    const { verdict } = await present(docA, await mint(b.host.state.me.id, bId, docA, 'demo'))
    assert.equal(verdict.kind, 'denied')
  })

  it('ends only the demo the cookie belongs to (there is no way to name another one)', async () => {
    assert.equal((await holding(b.host.client.cookie).post('/api/demo/end')).status, 204, 'B’s host ends B')
    const stillThere = await a.host.client.post('/api/demo/join', { ticket: a.ticket })
    assert.equal(stillThere.status, 200, 'A is untouched')
    assert.equal(stillThere.body.participants, 1)
    assert.equal((await new Client(server).post('/api/demo/join', { ticket: b.ticket })).status, 404, 'and B is gone')
  })
})
