import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { LIMITS } from '@conflux/shared'
import { eq, sql } from 'drizzle-orm'
import { invites, pageDocs, pages, sessions } from '../src/db/schema'
import { runMaintenance } from '../src/maintenance'
import { Client, startTestServer, type TestServer } from './helpers'

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})

async function owner(name = 'Page Owner') {
  const client = new Client(server)
  const account = await client.signup(name)
  return { client, ws: account.workspace.id, welcome: account.welcomePageId, id: account.user.id }
}

const titles = async (client: Client, ws: string) => ((await client.get(`/api/workspaces/${ws}/pages`)).body.pages as { title: string }[]).map((page) => page.title)

describe('pages', () => {
  it('start with a welcome page, and new pages go to the end of the list', async () => {
    const { client, ws } = await owner()
    await client.createPage(ws, 'Second')
    await client.createPage(ws, 'Third')
    const list = (await client.get(`/api/workspaces/${ws}/pages`)).body.pages as { title: string; position: number }[]
    assert.equal(list.length, 3)
    assert.deepEqual(list.map((page) => page.position), [0, 1, 2])
    assert.deepEqual(list.slice(1).map((page) => page.title), ['Second', 'Third'])
  })

  it('new pages go after the last remaining page, even when earlier ones were deleted', async () => {
    const { client, ws } = await owner()
    const a = await client.createPage(ws, 'A')
    const b = await client.createPage(ws, 'B')
    await client.delete(`/api/pages/${b.id}`)
    await client.createPage(ws, 'C')
    await client.delete(`/api/pages/${a.id}`)
    assert.deepEqual(await titles(client, ws), [(await titles(client, ws))[0], 'C'])
  })

  it('may have an empty title (shown as "Untitled" by the app)', async () => {
    const { client, ws } = await owner()
    const reply = await client.post(`/api/workspaces/${ws}/pages`, {})
    assert.equal(reply.status, 201)
    assert.equal(reply.body.title, '')
  })

  it('clean up titles, and reject hidden characters, long titles and unknown fields', async () => {
    const { client, ws } = await owner()
    assert.equal((await client.createPage(ws, '  Spaced    out  ')).title, 'Spaced out')
    for (const body of [{ title: 'x'.repeat(LIMITS.pageTitleMax + 1) }, { title: 'rtl‮trick' }, { title: 'nul\u0000' }, { title: 5 }, { title: null }, { title: 'ok', position: 0 }, { title: 'ok', parentId: null }]) {
      assert.equal((await client.post(`/api/workspaces/${ws}/pages`, body)).status, 400, JSON.stringify(body))
    }
  })

  it('keep emoji and other scripts in titles', async () => {
    const { client, ws } = await owner()
    assert.equal((await client.createPage(ws, '📚 नोट्स 笔记')).title, '📚 नोट्स 笔记')
  })

  it('are renamed in place, and the "updated" time moves', async () => {
    const { client, ws, welcome } = await owner()
    const before = (await client.get(`/api/workspaces/${ws}/pages`)).body.pages[0]
    await new Promise((resolve) => setTimeout(resolve, 20))
    const reply = await client.patch(`/api/pages/${welcome}`, { title: '  New   name ' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.title, 'New name')
    assert.equal(reply.body.id, welcome)
    assert.ok(new Date(reply.body.updatedAt).getTime() > new Date(before.updatedAt).getTime())
    assert.equal((await client.patch(`/api/pages/${welcome}`, { title: '' })).body.title, '')
    assert.equal((await client.patch(`/api/pages/${welcome}`, {})).status, 400)
  })

  it('are deleted softly: gone from every list and unreachable, but the row waits for housekeeping', async () => {
    const { client, ws } = await owner()
    const page = await client.createPage(ws, 'Doomed')
    assert.equal((await client.delete(`/api/pages/${page.id}`)).status, 204)
    assert.ok(!(await titles(client, ws)).includes('Doomed'))
    assert.equal((await client.patch(`/api/pages/${page.id}`, { title: 'zombie' })).status, 404)
    assert.equal((await client.delete(`/api/pages/${page.id}`)).status, 404)
    const [row] = await server.db.select().from(pages).where(eq(pages.id, page.id))
    assert.ok(row.deletedAt instanceof Date)
  })

  it('stop at the limit per workspace, and deleted pages do not count', async () => {
    const { client, ws, id } = await owner()
    const filler = Array.from({ length: LIMITS.maxPagesPerWorkspace - 1 }, (_, i) => ({ workspaceId: ws, title: `Filler ${i}`, position: i + 1, createdBy: id }))
    await server.db.insert(pages).values(filler)
    const over = await client.post(`/api/workspaces/${ws}/pages`, { title: 'One too many' })
    assert.equal(over.status, 403)
    assert.equal(over.body.error.code, 'quota_exceeded')
    const list = (await client.get(`/api/workspaces/${ws}/pages`)).body.pages
    assert.equal(list.length, LIMITS.maxPagesPerWorkspace)
    assert.equal((await client.delete(`/api/pages/${list[5].id}`)).status, 204)
    assert.equal((await client.post(`/api/workspaces/${ws}/pages`, { title: 'Now there is room' })).status, 201)
  })

  it('count per workspace, not per person', async () => {
    const a = await owner('A')
    const b = await owner('B')
    for (let i = 0; i < 5; i++) await a.client.createPage(a.ws, `A${i}`)
    assert.equal((await titles(b.client, b.ws)).length, 1)
  })
})

describe('housekeeping', () => {
  const day = 24 * 3600_000
  const ago = (ms: number) => new Date(Date.now() - ms)

  it('forgets expired sign-ins and keeps live ones', async () => {
    const live = await owner('Live')
    const stale = await owner('Stale')
    await server.db.update(sessions).set({ expiresAt: ago(1000) }).where(eq(sessions.userId, stale.id))
    await runMaintenance(server.db, server.app.log)
    assert.equal((await server.db.select().from(sessions).where(eq(sessions.userId, stale.id))).length, 0)
    assert.equal((await server.db.select().from(sessions).where(eq(sessions.userId, live.id))).length, 1)
    assert.equal((await live.client.get('/api/auth/me')).status, 200)
  })

  it('forgets invite links a week after they expired or were revoked, not before', async () => {
    const { client, ws } = await owner()
    const make = async () => (await client.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' })).body.invite.id as string
    const [freshlyExpired, longExpired, freshlyRevoked, longRevoked, live] = [await make(), await make(), await make(), await make(), await make()]
    await server.db.update(invites).set({ expiresAt: ago(1 * day) }).where(eq(invites.id, freshlyExpired))
    await server.db.update(invites).set({ expiresAt: ago(8 * day) }).where(eq(invites.id, longExpired))
    await server.db.update(invites).set({ revokedAt: ago(1 * day) }).where(eq(invites.id, freshlyRevoked))
    await server.db.update(invites).set({ revokedAt: ago(8 * day) }).where(eq(invites.id, longRevoked))
    await runMaintenance(server.db, server.app.log)
    const left = new Set((await server.db.select({ id: invites.id }).from(invites).where(eq(invites.workspaceId, ws))).map((row) => row.id))
    assert.deepEqual([freshlyExpired, longExpired, freshlyRevoked, longRevoked, live].map((id) => left.has(id)), [true, false, true, false, true])
  })

  it('deletes pages 30 days after they were deleted, together with their saved content', async () => {
    const { client, ws } = await owner()
    const recent = await client.createPage(ws, 'Deleted recently')
    const old = await client.createPage(ws, 'Deleted long ago')
    const alive = await client.createPage(ws, 'Still here')
    for (const page of [recent, old, alive]) await server.db.insert(pageDocs).values({ pageId: page.id, state: new Uint8Array([0, 0]) })
    await server.db.update(pages).set({ deletedAt: ago(29 * day) }).where(eq(pages.id, recent.id))
    await server.db.update(pages).set({ deletedAt: ago(31 * day) }).where(eq(pages.id, old.id))
    await runMaintenance(server.db, server.app.log)
    const exists = async (id: string) => (await server.db.select().from(pages).where(eq(pages.id, id))).length === 1
    const hasContent = async (id: string) => (await server.db.select().from(pageDocs).where(eq(pageDocs.pageId, id))).length === 1
    assert.deepEqual([await exists(recent.id), await exists(old.id), await exists(alive.id)], [true, false, true])
    assert.deepEqual([await hasContent(recent.id), await hasContent(old.id), await hasContent(alive.id)], [true, false, true])
  })

  it('does nothing, quietly, when there is nothing to do', async () => {
    await runMaintenance(server.db, server.app.log)
    await runMaintenance(server.db, server.app.log)
    assert.ok(server.db.execute(sql`select 1`))
  })
})
