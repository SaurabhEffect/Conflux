import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { CLOSE_CODES, CLOSE_REASONS, LIMITS, demoDocName } from '@conflux/shared'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { Client, RawClient, makeTeam, makeUpdate, settle, startTestServer, syncStep1Frame, untilClosed, waitFor, type Peer, type TestServer } from './helpers'
import { addParagraph, blocksOf, demoText, joinAs, makeDemo, openDemoDoc, rowsOfDemo, sandboxIdOf, savedDemoText, type Visitor } from './demo-helpers'

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

const open = (visitor: Visitor, pageId: string) => {
  const peer = openDemoDoc(server, visitor, pageId)
  peers.push(peer)
  return peer
}
const tokenFor = async (visitor: Visitor, doc: string) => (await visitor.client.post('/api/demo/sync-token', { doc })).body.token as string
const raw = (target: TestServer, doc: string) => {
  const client = new RawClient(target.wsUrl, doc)
  raws.push(client)
  return client
}

describe('editing together', () => {
  it('shows a new visitor the starter content of the page', async () => {
    const { host } = await makeDemo(server)
    const peer = open(host, host.state.pages[0].id)
    await peer.synced
    assert.match(demoText(peer), /Welcome to the Conflux demo/)
    assert.ok(blocksOf(peer).length >= 5)
  })

  it('carries each visitor’s typing to the other in both directions, and keeps it for the next visit', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const page = host.state.pages[1].id
    const a = open(host, page)
    const b = open(guest, page)
    await Promise.all([a.synced, b.synced])

    addParagraph(a, 'Typed by the host')
    await waitFor(() => demoText(b).includes('Typed by the host'), 5000, 'the host’s line to reach the guest')
    addParagraph(b, 'Typed by the guest')
    await waitFor(() => demoText(a).includes('Typed by the guest'), 5000, 'the guest’s line to reach the host')
    a.destroy()
    b.destroy()
    await waitFor(async () => /Typed by the host[\s\S]*Typed by the guest|Typed by the guest[\s\S]*Typed by the host/.test((await savedDemoText(server, page)) ?? ''), 10_000, 'the page to be saved')
    const later = open(host, page)
    await later.synced
    assert.match(demoText(later), /Typed by the host/)
    assert.match(demoText(later), /Typed by the guest/)
  })

  it('keeps two demos’ copies of the same starter page apart', async () => {
    const one = await makeDemo(server)
    const two = await makeDemo(server)
    const a = open(one.host, one.host.state.pages[0].id)
    const b = open(two.host, two.host.state.pages[0].id)
    await Promise.all([a.synced, b.synced])
    addParagraph(a, 'Only in the first demo')
    await waitFor(() => demoText(a).includes('Only in the first demo'))
    await settle(600)
    assert.ok(!demoText(b).includes('Only in the first demo'))
  })
})

describe('presence', () => {
  it('shows every visitor to the others under the name and colour the server gave them, not the ones the browser claims', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const page = host.state.pages[0].id
    const a = open(host, page)
    const b = open(guest, page)
    await Promise.all([a.synced, b.synced])

    a.provider.setAwarenessField('user', { name: 'Pretend Admin', color: '#ff0000' })
    const seenByGuest = () => [...b.provider.awareness!.getStates().values()].map((state) => state.user as { name: string; color: string } | undefined)
    await waitFor(() => seenByGuest().some((user) => user?.name === host.state.me.displayName), 5000, 'the host to show up for the guest')
    await settle(300)
    assert.ok(!seenByGuest().some((user) => user?.name === 'Pretend Admin'), 'the claimed name was replaced')
    const shown = seenByGuest().find((user) => user?.name === host.state.me.displayName)
    assert.equal(shown?.color, host.state.me.cursorColor)
  })
})

describe('what an anonymous visitor may not do', () => {
  it('can have four connections open, not a fifth', async () => {
    const { host } = await makeDemo(server)
    const page = host.state.pages[0].id
    const open4 = [0, 1, 2, 3].map(() => open(host, page))
    await Promise.all(open4.map((peer) => peer.synced))
    const fifth = open(host, page)
    await waitFor(() => fifth.denied.length > 0, 5000, 'the fifth connection to be refused')
    assert.deepEqual(fifth.denied, [CLOSE_REASONS.tooManyConnections])
    for (const peer of open4) assert.deepEqual(peer.closes, [], 'the first four are untouched')
  })

  it('is cut off for sending far more messages than typing ever could (accounts too)', async () => {
    const strict = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
    try {
      const { host } = await makeDemo(strict)
      const doc = demoDocName(host.state.pages[0].id)
      const flooder = raw(strict, doc)
      assert.equal((await flooder.authenticate(await tokenFor(host, doc))).kind, 'authenticated')
      for (let i = 0; i < 600; i += 1) flooder.send(syncStep1Frame(doc))
      await waitFor(() => flooder.closed !== null, 5000, 'the flood to be cut off')
      assert.deepEqual(flooder.closed, { code: CLOSE_CODES.tooManyConnections, reason: 'too-many-messages' })

      // An account's connection has the same protection.
      const team = await makeTeam(strict)
      const accountDoc = team.doc
      const account = raw(strict, accountDoc)
      const token = (await team.owner.post('/api/sync-token', { doc: accountDoc })).body.token
      assert.equal((await account.authenticate(token)).kind, 'authenticated')
      for (let i = 0; i < 600; i += 1) account.send(syncStep1Frame(accountDoc))
      await waitFor(() => account.closed !== null, 5000, 'the flood to be cut off')
      assert.equal(account.closed?.code, CLOSE_CODES.tooManyConnections)
    } finally {
      await strict.close()
    }
  })

  it('is cut off for sending one message that is bigger than any page could be', async () => {
    const { host } = await makeDemo(server)
    const doc = demoDocName(host.state.pages[0].id)
    const big = raw(server, doc)
    assert.equal((await big.authenticate(await tokenFor(host, doc))).kind, 'authenticated')
    big.sendUpdate(makeUpdate('x'.repeat(LIMITS.demoMessageMaxBytes + 1000)))
    await waitFor(() => big.closed !== null, 5000, 'the big message to be refused')
    assert.deepEqual(big.closed, { code: CLOSE_CODES.tooManyConnections, reason: 'message-too-large' })
  })

  it('may paste a lot (just under the limit) without being bothered', async () => {
    const { host } = await makeDemo(server)
    const page = host.state.pages[0].id
    const peer = open(host, page)
    await peer.synced
    addParagraph(peer, 'y'.repeat(100_000))
    await waitFor(async () => ((await savedDemoText(server, page)) ?? '').length > 100_000, 10_000, 'the big page to be saved')
    assert.deepEqual(peer.closes, [])
  })

  it('ends the whole demo when a page grows past its limit, and everyone is told within seconds', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const sandboxId = await sandboxIdOf(server, host)
    const a = open(host, host.state.pages[0].id)
    const b = open(guest, guest.state.pages[1].id)
    await Promise.all([a.synced, b.synced])

    addParagraph(a, 'z'.repeat(LIMITS.demoPageMaxBytes + 20_000))
    await Promise.all([untilClosed(a, CLOSE_CODES.demoEnded), untilClosed(b, CLOSE_CODES.demoEnded)])
    await waitFor(async () => (await rowsOfDemo(server, sandboxId)).demos === 0, 5000, 'the demo to be deleted')
    assert.deepEqual(await rowsOfDemo(server, sandboxId), { demos: 0, people: 0, pages: 0, docs: 0 })
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 404)
  })

  it('cannot get past the limit a little at a time either', async () => {
    const { host } = await makeDemo(server)
    const sandboxId = await sandboxIdOf(server, host)
    const peer = open(host, host.state.pages[0].id)
    await peer.synced
    // Each edit is far below the check threshold; together they pass the limit.
    for (let i = 0; i < 14 && peer.closes.length === 0; i += 1) {
      addParagraph(peer, String(i).repeat(1) + 'q'.repeat(30_000))
      await settle(60)
    }
    await untilClosed(peer, CLOSE_CODES.demoEnded)
    await waitFor(async () => (await rowsOfDemo(server, sandboxId)).demos === 0, 5000, 'the demo to be deleted')
  })
})

describe('the bot’s identity is not for sale', () => {
  const botClientId = (peer: Peer) => {
    for (const [clientId, state] of peer.provider.awareness!.getStates()) {
      if ((state.user as { name?: string } | undefined)?.name === 'Conflux Bot') return clientId
    }
    return null
  }

  /** An awareness message that says `state` about `clientId`, with a clock far ahead of anything real. */
  const awarenessAbout = (clientId: number, state: object | null) => {
    const doc = new Y.Doc()
    doc.clientID = clientId
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.meta.set(clientId, { clock: 1_000_000, lastUpdated: Date.now() })
    awareness.setLocalState(state)
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [clientId])
    awareness.destroy()
    doc.destroy()
    return update
  }

  it('cannot move, rename or remove the bot’s cursor by sending presence in its name (control: it can send its own)', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const page = host.state.pages[0].id
    const watcher = open(host, page)
    await watcher.synced
    await waitFor(() => botClientId(watcher) !== null, 8000, 'the bot to show up in the presence list')
    const botId = botClientId(watcher)!

    const doc = demoDocName(page)
    const forger = raw(server, doc)
    assert.equal((await forger.authenticate(await tokenFor(guest, doc))).kind, 'authenticated')

    // Control: presence sent in the visitor's own name is accepted (so the checks below are not passing on a broken message).
    const ownId = 424_242
    forger.sendAwareness(awarenessAbout(ownId, { user: { name: 'Anything' }, cursor: null }))
    await waitFor(() => watcher.provider.awareness!.getStates().has(ownId), 5000, 'the visitor’s own presence to arrive')
    assert.equal((watcher.provider.awareness!.getStates().get(ownId)!.user as { name: string }).name, guest.state.me.displayName)

    // Attacks: speak for the bot, then try to make it vanish.
    forger.sendAwareness(awarenessAbout(botId, { user: { name: 'Not the bot', color: '#ff0000' }, cursor: null }))
    forger.sendAwareness(awarenessAbout(botId, null))
    await settle(600)
    const state = watcher.provider.awareness!.getStates().get(botId)
    assert.ok(state, 'the bot is still there')
    assert.equal((state.user as { name: string }).name, 'Conflux Bot')
    assert.equal(forger.closed, null, 'the visitor is not even disconnected for trying (their update is simply dropped)')
  })
})
