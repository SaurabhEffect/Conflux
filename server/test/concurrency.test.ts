import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { LIMITS } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import { memberships, users, workspaces } from '../src/db/schema'
import { Client, holdOpen, onPostgres, sleep, startTestServer, type TestServer } from './helpers'

/**
 * Races between requests that arrive at the same moment. They need a real
 * Postgres (the embedded database runs one query at a time, so nothing can
 * overlap there): set TEST_DATABASE_URL. Each test pauses the server at the
 * exact point where two requests would collide, so the result does not depend on luck.
 */
describe('requests at the same moment', { skip: onPostgres ? false : 'needs TEST_DATABASE_URL (a real Postgres)' }, () => {
  let server: TestServer
  before(async () => {
    server = await startTestServer()
  })
  after(async () => {
    await server.close()
  })

  async function link(owner: Client, workspaceId: string) {
    const made = await owner.post(`/api/workspaces/${workspaceId}/invites`, { role: 'viewer' })
    assert.equal(made.status, 201)
    return made.body.token as string
  }

  it('two different links cannot push a workspace past its member limit', async () => {
    const owner = new Client(server)
    const { workspace } = await owner.signup('Owner')
    const [first, second] = [await link(owner, workspace.id), await link(owner, workspace.id)]
    // Fill the workspace up to one seat short of the limit (the owner holds one).
    const fakes = Array.from({ length: LIMITS.maxMembersPerWorkspace - 2 }, (_, i) => ({ email: `seat${i}-${workspace.id}@example.com`, passwordHash: 'x', displayName: `Seat ${i}`, cursorColor: '#000000' }))
    const rows = await server.db.insert(users).values(fakes).returning({ id: users.id })
    await server.db.insert(memberships).values(rows.map((row) => ({ workspaceId: workspace.id, userId: row.id, role: 'viewer' as const })))
    const a = new Client(server)
    const b = new Client(server)
    await a.signup('A')
    await b.signup('B')

    // Both requests count the members, then both want to add one. Hold the add-step shut until both are there.
    const held = await holdOpen(server, 'lock table memberships in share row exclusive mode')
    const pending = [a.post('/api/invites/accept', { token: first }), b.post('/api/invites/accept', { token: second })]
    await sleep(700)
    await held.release()
    const replies = await Promise.all(pending)

    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409], JSON.stringify(replies.map((reply) => reply.body)))
    const members = await server.db.select().from(memberships).where(eq(memberships.workspaceId, workspace.id))
    assert.equal(members.length, LIMITS.maxMembersPerWorkspace)
  })

  it('one person cannot go past the workspace limit by creating several at once', async () => {
    const person = new Client(server)
    await person.signup('Busy')
    for (let i = 1; i < LIMITS.maxOwnedWorkspaces - 1; i++) assert.equal((await person.post('/api/workspaces', { name: `W${i}` })).status, 201)

    const held = await holdOpen(server, 'lock table workspaces in share row exclusive mode')
    const pending = [person.post('/api/workspaces', { name: 'Race 1' }), person.post('/api/workspaces', { name: 'Race 2' })]
    await sleep(700)
    await held.release()
    const replies = await Promise.all(pending)

    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 403], JSON.stringify(replies.map((reply) => reply.body)))
    const mine = (await person.get('/api/auth/me')).body.workspaces.filter((w: { role: string }) => w.role === 'owner')
    assert.equal(mine.length, LIMITS.maxOwnedWorkspaces)
  })

  it('accepting a link while the workspace is being deleted ends cleanly, not in a deadlock', async () => {
    const owner = new Client(server)
    const { workspace } = await owner.signup('Doomed')
    const token = await link(owner, workspace.id)
    const guest = new Client(server)
    await guest.signup('Late')

    // The deletion has the workspace locked and is about to remove it, and its invites with it.
    const deletion = await holdOpen(server, `select id from workspaces where id = '${workspace.id}' for update`)
    const accepting = guest.post('/api/invites/accept', { token })
    await sleep(700)
    // Needs the invite's row, which the other request must not be holding while it waits for the workspace.
    await deletion.query(`delete from workspaces where id = '${workspace.id}'`)
    await deletion.release()

    const reply = await accepting
    assert.equal(reply.status, 404, JSON.stringify(reply.body))
    assert.equal(reply.body.error.code, 'invite_invalid')
    assert.equal((await server.db.select().from(workspaces).where(eq(workspaces.id, workspace.id))).length, 0)
    assert.equal((await server.db.select().from(memberships).where(eq(memberships.userId, (await guest.get('/api/auth/me')).body.user.id))).length, 1, 'only their own workspace')
  })
})
