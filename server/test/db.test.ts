import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { and, eq, sql } from 'drizzle-orm'
import { openDatabase, pgErrorCode, isUniqueViolation } from '../src/db/client'
import { invites, memberships, pageDocs, pages, sessions, users, workspaces } from '../src/db/schema'
import { Client, makeTeam, startTestServer, type Team, type TestServer } from './helpers'

/**
 * The database is the last line of defence: even a bug in the API should not
 * be able to create an owner invite, a duplicate account, or a half-deleted workspace.
 */

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})

/** Both database drivers answer raw SQL with { rows: [...] }. */
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows

const code = (promise: PromiseLike<unknown>) =>
  Promise.resolve(promise).then(
    () => 'no error',
    (error) => pgErrorCode(error) ?? `other: ${String(error)}`,
  )

describe('rules the database enforces by itself', () => {
  let crew: Team
  before(async () => {
    crew = await makeTeam(server)
  })

  it('an invite can never grant "owner" (check constraint)', async () => {
    const row = { workspaceId: crew.ws, role: 'owner' as const, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 1000), usesLeft: 1 }
    assert.equal(await code(server.db.insert(invites).values(row)), '23514')
  })

  it('an invite cannot have a negative number of uses left', async () => {
    const row = { workspaceId: crew.ws, role: 'viewer' as const, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 1000), usesLeft: -1 }
    assert.equal(await code(server.db.insert(invites).values(row)), '23514')
  })

  it('two accounts cannot share an email, whatever the capitals (unique index on lower(email))', async () => {
    const base = { passwordHash: 'x', displayName: 'Dupe', cursorColor: '#000000' }
    await server.db.insert(users).values({ ...base, email: 'Case@Example.com' })
    assert.equal(await code(server.db.insert(users).values({ ...base, email: 'case@example.com' })), '23505')
    assert.equal(isUniqueViolation(await server.db.insert(users).values({ ...base, email: 'CASE@EXAMPLE.COM' }).catch((error) => error)), true)
  })

  it('the same person cannot be a member of a workspace twice', async () => {
    assert.equal(await code(server.db.insert(memberships).values({ workspaceId: crew.ws, userId: crew.ids.viewer, role: 'owner' })), '23505')
    const [still] = await server.db.select().from(memberships).where(and(eq(memberships.workspaceId, crew.ws), eq(memberships.userId, crew.ids.viewer)))
    assert.equal(still.role, 'viewer')
  })

  it('only the three roles exist', async () => {
    const stranger = await new Client(server).signup('Stranger')
    const failure = await code(server.db.execute(sql`insert into memberships (workspace_id, user_id, role) values (${crew.ws}, ${stranger.user.id}, 'admin')`))
    assert.equal(failure, '22P02')
  })

  it('a membership needs a real workspace and a real person (foreign keys)', async () => {
    assert.equal(await code(server.db.insert(memberships).values({ workspaceId: randomUUID(), userId: crew.ids.viewer, role: 'viewer' })), '23503')
    assert.equal(await code(server.db.insert(memberships).values({ workspaceId: crew.ws, userId: randomUUID(), role: 'viewer' })), '23503')
    assert.equal(await code(server.db.insert(pages).values({ workspaceId: randomUUID(), title: 'orphan', position: 0 })), '23503')
  })

  it('session tokens are unique', async () => {
    const row = { tokenHash: 'a'.repeat(64), userId: crew.ids.owner, expiresAt: new Date(Date.now() + 60_000) }
    await server.db.insert(sessions).values(row)
    assert.equal(await code(server.db.insert(sessions).values(row)), '23505')
  })
})

describe('what goes when something is deleted', () => {
  it('deleting a workspace takes its members, pages, saved content and invites with it', async () => {
    const crew = await makeTeam(server)
    await server.db.insert(pageDocs).values({ pageId: crew.pageId, state: new Uint8Array([1]) })
    await crew.owner.post(`/api/workspaces/${crew.ws}/invites`, { role: 'viewer' })
    await server.db.delete(workspaces).where(eq(workspaces.id, crew.ws))
    for (const table of [memberships, pages, invites] as const) {
      assert.equal((await server.db.select().from(table).where(eq(table.workspaceId, crew.ws))).length, 0)
    }
    assert.equal((await server.db.select().from(pageDocs).where(eq(pageDocs.pageId, crew.pageId))).length, 0)
    // nobody else was touched
    assert.equal((await server.db.select().from(users).where(eq(users.id, crew.ids.editor))).length, 1)
  })

  it('deleting a person takes their sign-ins and memberships, but keeps what they made', async () => {
    const crew = await makeTeam(server)
    const made = await crew.editor.createPage(crew.ws, 'Written by the editor')
    await crew.editor.post('/api/workspaces', { name: 'Their own' })
    await server.db.delete(users).where(eq(users.id, crew.ids.editor))
    assert.equal((await server.db.select().from(sessions).where(eq(sessions.userId, crew.ids.editor))).length, 0)
    assert.equal((await server.db.select().from(memberships).where(eq(memberships.userId, crew.ids.editor))).length, 0)
    const [page] = await server.db.select().from(pages).where(eq(pages.id, made.id))
    assert.ok(page, 'the page is still there')
    assert.equal(page.createdBy, null, 'but it no longer points at a person who does not exist')
    assert.equal((await crew.owner.get(`/api/workspaces/${crew.ws}`)).status, 200)
  })

  it('deleting a parent page does not delete its children', async () => {
    const crew = await makeTeam(server)
    const child = await crew.owner.createPage(crew.ws, 'Child')
    await server.db.update(pages).set({ parentId: crew.pageId }).where(eq(pages.id, child.id))
    await server.db.delete(pages).where(eq(pages.id, crew.pageId))
    const [row] = await server.db.select().from(pages).where(eq(pages.id, child.id))
    assert.equal(row.parentId, null)
  })

  it('invites outlive the person who made them', async () => {
    const crew = await makeTeam(server)
    const made = await crew.owner.post(`/api/workspaces/${crew.ws}/invites`, { role: 'viewer' })
    await server.db.delete(users).where(eq(users.id, crew.ids.owner))
    // the workspace has no owner now, which only a direct database change can cause
    const [row] = await server.db.select().from(invites).where(eq(invites.id, made.body.invite.id))
    assert.equal(row.createdBy, null)
  })
})

describe('the schema', () => {
  it('runs on the database this test run asked for', async () => {
    const version = rowsOf<{ v: string }>(await server.db.execute(sql`select version() as v`))[0].v
    assert.match(version, /PostgreSQL/)
    if (process.env.TEST_DATABASE_URL) assert.equal(server.config.databaseUrl, null, 'the config is not what chose the database here; the helper did')
  })

  it('has exactly the tables the design calls for', async () => {
    const result = await server.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)
    const names = rowsOf<{ table_name: string }>(result).map((row) => row.table_name)
    assert.deepEqual(names, ['invites', 'memberships', 'page_docs', 'pages', 'sessions', 'users', 'workspaces'])
  })

  it('stores passwords and session tokens only as hashes: no column is called "password" or "token"', async () => {
    const result = await server.db.execute(sql`select column_name from information_schema.columns where table_schema = 'public'`)
    const columns = rowsOf<{ column_name: string }>(result).map((row) => row.column_name)
    assert.ok(columns.includes('password_hash') && columns.filter((name) => name === 'token_hash').length === 2)
    assert.ok(!columns.includes('password') && !columns.includes('token'))
  })
})

describe('starting up', () => {
  it('can be started again on the same folder: migrations are not applied twice, and data survives', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'conflux-migrate-'))
    try {
      const first = await openDatabase({ url: null, dataDir: dir })
      await first.db.insert(users).values({ email: 'kept@example.com', passwordHash: 'x', displayName: 'Kept', cursorColor: '#123456' })
      await first.close()

      const second = await openDatabase({ url: null, dataDir: dir })
      assert.equal((await second.db.select().from(users)).length, 1)
      const applied = await second.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      assert.equal(rowsOf<{ n: number }>(applied)[0].n, 1)
      await second.close()

      const third = await openDatabase({ url: null, dataDir: dir })
      assert.equal((await third.db.select().from(users).where(eq(users.email, 'kept@example.com'))).length, 1)
      await third.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says what it is using', async () => {
    const database = await openDatabase({ url: null, dataDir: 'memory://' })
    assert.equal(database.kind, 'pglite')
    assert.match(database.description, /PGlite/)
    await database.close()
  })
})
