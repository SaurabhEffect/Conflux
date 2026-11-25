import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { CLOSE_CODES, demoDocName } from '@conflux/shared'
import { eq, inArray } from 'drizzle-orm'
import { sandboxDocs, sandboxes } from '../src/db/schema'
import { purgeSandboxes } from '../src/demo/sandboxes'
import { purgeDemos, startMaintenance } from '../src/maintenance'
import { Client, sleep, startTestServer, untilClosed, waitFor, type Peer, type TestServer } from './helpers'
import { addParagraph, demoText, joinAs, makeDemo, openDemoDoc, rowsOfDemo, sandboxIdOf, savedDemoText, visit, type Visitor } from './demo-helpers'

const servers: TestServer[] = []
const peers: Peer[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy()
  for (const server of servers.splice(0)) await server.close()
})

async function shortLived(idleSeconds: number, maxSeconds: number) {
  const server = await startTestServer({ patch: (config) => ({ ...config, demo: { ...config.demo, idleSeconds, maxSeconds } }) })
  servers.push(server)
  return server
}

const open = (server: TestServer, visitor: Visitor, pageId: string) => {
  const peer = openDemoDoc(server, visitor, pageId)
  peers.push(peer)
  return peer
}

describe('ending by the clock', () => {
  it('hides a demo the moment it goes idle, before any clean-up has run, and says the same thing as for a wrong link', async () => {
    const server = await shortLived(2, 600)
    const { ticket, host } = await makeDemo(server)
    const sandboxId = await sandboxIdOf(server, host)
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 200)

    await sleep(2400)
    const link = await new Client(server).post('/api/demo/join', { ticket })
    assert.equal(link.status, 404)
    const wrong = await new Client(server).post('/api/demo/join', { ticket: 'B'.repeat(43) })
    assert.deepEqual(link.body, wrong.body, 'an expired link and a link that never existed look the same')

    const mine = await host.client.post('/api/demo/sync-token', { doc: demoDocName(host.state.pages[0].id) })
    assert.equal(mine.status, 404)
    assert.equal(mine.body.error.code, 'demo_ended')
    assert.ok(mine.setCookies.length > 0, 'the stale cookie is cleared')

    assert.equal((await rowsOfDemo(server, sandboxId)).demos, 1, 'the rows are still there: the clock hid them, not clean-up')
    assert.ok((await purgeSandboxes(server.db, server.config.demo)) >= 1)
    assert.deepEqual(await rowsOfDemo(server, sandboxId), { demos: 0, people: 0, pages: 0, docs: 0 })
  })

  it('keeps a demo alive for as long as somebody types, and ends it, with everybody told, once they stop', async () => {
    const server = await shortLived(3, 600)
    const { ticket, host } = await makeDemo(server)
    const peer = open(server, host, host.state.pages[0].id)
    await peer.synced

    const started = Date.now()
    while (Date.now() - started < 5600) {
      addParagraph(peer, 'still typing')
      await sleep(700)
    }
    assert.deepEqual(peer.closes, [], 'typing kept the connection open well past the idle time')
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 200)

    const stopped = Date.now()
    await untilClosed(peer, CLOSE_CODES.demoEnded, 9000)
    assert.ok(Date.now() - stopped < 8000)
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 404)
  })

  it('ends a demo at the latest after its maximum time, however busy it is', async () => {
    const server = await shortLived(600, 3)
    const { ticket, host } = await makeDemo(server)
    const peer = open(server, host, host.state.pages[0].id)
    await peer.synced
    const started = Date.now()
    while (peer.closes.length === 0 && Date.now() - started < 9000) {
      addParagraph(peer, 'busy')
      await sleep(250)
    }
    await untilClosed(peer, CLOSE_CODES.demoEnded, 1000)
    const took = Date.now() - started
    assert.ok(took < 7000, `the connection was closed after ${took} ms (limit 3 s, plus the 2 s sweep)`)
    assert.equal((await new Client(server).post('/api/demo/join', { ticket })).status, 404)
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')
  })
})

describe('ending on purpose', () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  it('disconnects everybody within a second when the host ends the demo, and nothing is saved afterwards', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const a = open(server, host, host.state.pages[0].id)
    const b = open(server, guest, guest.state.pages[1].id)
    await Promise.all([a.synced, b.synced])
    addParagraph(a, 'typed just before the end')

    const started = Date.now()
    assert.equal((await host.client.post('/api/demo/end')).status, 204)
    await Promise.all([untilClosed(a, CLOSE_CODES.demoEnded, 3000), untilClosed(b, CLOSE_CODES.demoEnded, 3000)])
    const took = Date.now() - started
    assert.ok(took < 1500, `everybody was disconnected after ${took} ms`)
    await waitFor(() => server.sync.stats().bots === 0, 8000, 'the bot to leave')
    await waitFor(() => server.sync.stats().documents === 0, 8000, 'the pages to be unloaded')
    const leftovers = await server.db.select().from(sandboxDocs).where(inArray(sandboxDocs.pageId, host.state.pages.map((page) => page.id)))
    assert.equal(leftovers.length, 0)
  })

  it('disconnects a visitor who leaves, and nobody else', async () => {
    const { ticket, host } = await makeDemo(server)
    const guest = await joinAs(server, ticket)
    const a = open(server, host, host.state.pages[0].id)
    const b = open(server, guest, guest.state.pages[0].id)
    await Promise.all([a.synced, b.synced])
    assert.equal((await guest.client.post('/api/demo/leave')).status, 204)
    await untilClosed(b, CLOSE_CODES.demoEnded, 3000)
    await sleep(500)
    assert.deepEqual(a.closes, [])
  })
})

describe('cleaning up', () => {
  it('removes only demos that timed out, and everything in them', async () => {
    const server = await startTestServer()
    servers.push(server)
    const alive = await makeDemo(server)
    const idle = await makeDemo(server)
    const old = await makeDemo(server)
    const ids = { alive: await sandboxIdOf(server, alive.host), idle: await sandboxIdOf(server, idle.host), old: await sandboxIdOf(server, old.host) }
    await server.db.update(sandboxes).set({ lastActiveAt: new Date(Date.now() - (server.config.demo.idleSeconds + 5) * 1000) }).where(eq(sandboxes.id, ids.idle))
    await server.db.update(sandboxes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sandboxes.id, ids.old))
    assert.equal(await purgeSandboxes(server.db, server.config.demo), 2)
    assert.deepEqual(await rowsOfDemo(server, ids.idle), { demos: 0, people: 0, pages: 0, docs: 0 })
    assert.deepEqual(await rowsOfDemo(server, ids.old), { demos: 0, people: 0, pages: 0, docs: 0 })
    assert.deepEqual(await rowsOfDemo(server, ids.alive), { demos: 1, people: 1, pages: 3, docs: 3 })
    assert.equal(await purgeSandboxes(server.db, server.config.demo), 0, 'a second run finds nothing')
  })

  it('runs by itself: once at start-up and then every minute (the first run is checked here)', async () => {
    const server = await shortLived(1, 600)
    const { host } = await makeDemo(server)
    const sandboxId = await sandboxIdOf(server, host)
    await sleep(1300)
    const stop = startMaintenance(server.db, server.app.log, server.config.demo)
    try {
      await waitFor(async () => (await rowsOfDemo(server, sandboxId)).demos === 0, 5000, 'the start-up clean-up')
    } finally {
      stop()
    }
    assert.equal(await purgeDemos(server.db, server.config.demo, server.app.log), 0)
  })
})

describe('restarts', () => {
  it('keeps a running demo across a server restart: same visitor, same host, same page', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'conflux-demo-restart-'))
    try {
      const first = await startTestServer({ dataDir: folder })
      const { ticket, host } = await makeDemo(first)
      const page = host.state.pages[0].id
      const peer = openDemoDoc(first, host, page)
      await peer.synced
      addParagraph(peer, 'Still here after a restart')
      await waitFor(async () => ((await savedDemoText(first, page)) ?? '').includes('Still here after a restart'), 10_000, 'the page to be saved')
      peer.destroy()
      await first.close()

      const second = await startTestServer({ dataDir: folder })
      try {
        const browser = new Client(second)
        browser.cookie = host.client.cookie
        const again = await visit(second, ticket, browser)
        assert.equal(again.state.me.id, host.state.me.id)
        assert.equal(again.state.me.isHost, true)
        assert.equal(again.state.participants, 1)
        const reopened = openDemoDoc(second, again, page)
        try {
          await reopened.synced
          assert.match(demoText(reopened), /Still here after a restart/)
        } finally {
          reopened.destroy()
        }
      } finally {
        await second.close()
      }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
