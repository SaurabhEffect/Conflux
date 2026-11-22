import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { LIMITS } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import { invites, memberships, users } from '../src/db/schema'
import { Client, startTestServer, type TestServer } from './helpers'

let server: TestServer
before(async () => {
  server = await startTestServer()
})
after(async () => {
  await server.close()
})

/** An owner with a fresh workspace. */
async function team(name = 'Ola Owner') {
  const owner = new Client(server)
  const account = await owner.signup(name)
  return { owner, ws: account.workspace.id, ownerId: account.user.id }
}

async function link(owner: Client, ws: string, body: Record<string, unknown> = { role: 'viewer' }) {
  const reply = await owner.post(`/api/workspaces/${ws}/invites`, body)
  assert.equal(reply.status, 201, JSON.stringify(reply.body))
  return { token: reply.body.token as string, id: reply.body.invite.id as string, invite: reply.body.invite }
}

const INVALID = { status: 404, code: 'invite_invalid' }

describe('making invite links', () => {
  it('shows the secret once; the list never contains it and the database keeps only a hash', async () => {
    const { owner, ws } = await team()
    const made = await link(owner, ws, { role: 'editor' })
    assert.match(made.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(made.invite.role, 'editor')

    const listed = await owner.get(`/api/workspaces/${ws}/invites`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.invites.length, 1)
    assert.ok(!JSON.stringify(listed.body).includes(made.token))
    assert.equal(listed.body.invites[0].createdByName, 'Ola Owner')

    const [row] = await server.db.select().from(invites).where(eq(invites.id, made.id))
    assert.match(row.tokenHash, /^[0-9a-f]{64}$/)
    assert.ok(!JSON.stringify(row).includes(made.token))
  })

  it('defaults to 7 days and 10 uses, and accepts custom limits', async () => {
    const { owner, ws } = await team()
    const normal = await link(owner, ws)
    assert.equal(normal.invite.usesLeft, LIMITS.inviteDefaultUses)
    const days = (new Date(normal.invite.expiresAt).getTime() - Date.now()) / 86_400_000
    assert.ok(days > 6.99 && days <= 7)
    const custom = await link(owner, ws, { role: 'viewer', expiresInHours: 2, maxUses: 1 })
    assert.equal(custom.invite.usesLeft, 1)
    const hours = (new Date(custom.invite.expiresAt).getTime() - Date.now()) / 3_600_000
    assert.ok(hours > 1.99 && hours <= 2)
  })

  it('can never make someone an owner or accept odd numbers', async () => {
    const { owner, ws } = await team()
    const bad: unknown[] = [
      { role: 'owner' },
      { role: 'admin' },
      {},
      { role: 'viewer', maxUses: 0 },
      { role: 'viewer', maxUses: LIMITS.inviteMaxUses + 1 },
      { role: 'viewer', maxUses: 1.5 },
      { role: 'viewer', maxUses: '5' },
      { role: 'viewer', expiresInHours: 0 },
      { role: 'viewer', expiresInHours: LIMITS.inviteMaxHours + 1 },
      { role: 'viewer', expiresInHours: -3 },
      { role: 'viewer', usesLeft: 999 },
    ]
    for (const body of bad) assert.equal((await owner.post(`/api/workspaces/${ws}/invites`, body)).status, 400, JSON.stringify(body))
    assert.equal((await owner.get(`/api/workspaces/${ws}/invites`)).body.invites.length, 0)
  })

  it('caps the number of live links, and revoking frees a slot', async () => {
    const { owner, ws } = await team()
    const ids: string[] = []
    for (let i = 0; i < LIMITS.maxActiveInvites; i++) ids.push((await link(owner, ws)).id)
    const over = await owner.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' })
    assert.equal(over.status, 403)
    assert.equal(over.body.error.code, 'quota_exceeded')
    assert.equal((await owner.delete(`/api/workspaces/${ws}/invites/${ids[0]}`)).status, 204)
    assert.equal((await owner.post(`/api/workspaces/${ws}/invites`, { role: 'viewer' })).status, 201)
  })

  it('lists only live links, newest last, and hides expired or revoked ones', async () => {
    const { owner, ws } = await team()
    const a = await link(owner, ws)
    const b = await link(owner, ws)
    const c = await link(owner, ws)
    await owner.delete(`/api/workspaces/${ws}/invites/${b.id}`)
    await server.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, c.id))
    const listed = (await owner.get(`/api/workspaces/${ws}/invites`)).body.invites
    assert.deepEqual(listed.map((invite: { id: string }) => invite.id), [a.id])
  })

  it('revokes only once', async () => {
    const { owner, ws } = await team()
    const { id } = await link(owner, ws)
    assert.equal((await owner.delete(`/api/workspaces/${ws}/invites/${id}`)).status, 204)
    assert.equal((await owner.delete(`/api/workspaces/${ws}/invites/${id}`)).status, 404)
  })
})

describe('looking at a link before joining', () => {
  it('works without signing in and shows only the workspace name, the role and who invited you', async () => {
    const { owner, ws } = await team('Pat Inviter')
    await owner.patch(`/api/workspaces/${ws}`, { name: 'Design Team' })
    const { token } = await link(owner, ws, { role: 'editor' })
    const reply = await new Client(server).post('/api/invites/preview', { token })
    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body, { workspaceName: 'Design Team', role: 'editor', invitedBy: 'Pat Inviter' })
  })

  it('gives one identical answer for unknown, expired, revoked and used-up links', async () => {
    const { owner, ws } = await team()
    const expired = await link(owner, ws)
    await server.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.id))
    const revoked = await link(owner, ws)
    await owner.delete(`/api/workspaces/${ws}/invites/${revoked.id}`)
    const usedUp = await link(owner, ws, { role: 'viewer', maxUses: 1 })
    await new Client(server).signup('Taker')
    const taker = new Client(server)
    await taker.signup('Taker Two')
    await taker.post('/api/invites/accept', { token: usedUp.token })

    const unknown = 'B'.repeat(43)
    const replies = [unknown, expired.token, revoked.token, usedUp.token].map((token) => new Client(server).post('/api/invites/preview', { token }))
    const results = await Promise.all(replies)
    for (const reply of results) {
      assert.equal(reply.status, INVALID.status)
      assert.equal(reply.body.error.code, INVALID.code)
    }
    assert.equal(new Set(results.map((reply) => JSON.stringify(reply.body))).size, 1, 'the four answers are identical')
  })

  it('rejects things that cannot be a link token before touching the database', async () => {
    for (const token of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}%`, 123, null, ['A'.repeat(43)]]) {
      const reply = await new Client(server).post('/api/invites/preview', { token })
      assert.equal(reply.status, 400, JSON.stringify(token))
    }
    assert.equal((await new Client(server).post('/api/invites/preview', { token: 'A'.repeat(43), extra: 1 })).status, 400)
  })
})

describe('joining with a link', () => {
  it('adds you with the role on the link, and the workspace shows up for you', async () => {
    const { owner, ws } = await team()
    const { token } = await link(owner, ws, { role: 'editor' })
    const guest = new Client(server)
    await guest.signup('Guest')
    const joined = await guest.post('/api/invites/accept', { token })
    assert.equal(joined.status, 200)
    assert.equal(joined.body.id, ws)
    assert.equal(joined.body.role, 'editor')
    const mine = (await guest.get('/api/auth/me')).body.workspaces
    assert.ok(mine.some((workspace: { id: string; role: string }) => workspace.id === ws && workspace.role === 'editor'))
    assert.equal((await guest.get(`/api/workspaces/${ws}/pages`)).status, 200)
  })

  it('needs you to be signed in', async () => {
    const { owner, ws } = await team()
    const { token, id } = await link(owner, ws)
    assert.equal((await new Client(server).post('/api/invites/accept', { token })).status, 401)
    const [row] = await server.db.select().from(invites).where(eq(invites.id, id))
    assert.equal(row.usesLeft, LIMITS.inviteDefaultUses, 'no use was spent')
  })

  it('counts every use, and refuses once they are gone', async () => {
    const { owner, ws } = await team()
    const { token } = await link(owner, ws, { role: 'viewer', maxUses: 2 })
    const people = [new Client(server), new Client(server), new Client(server)]
    for (const person of people) await person.signup()
    assert.equal((await people[0].post('/api/invites/accept', { token })).status, 200)
    assert.equal((await people[1].post('/api/invites/accept', { token })).status, 200)
    const third = await people[2].post('/api/invites/accept', { token })
    assert.equal(third.status, INVALID.status)
    assert.equal(third.body.error.code, INVALID.code)
    assert.equal((await people[2].get(`/api/workspaces/${ws}`)).status, 404)
  })

  it('is safe to click twice: no extra use is spent', async () => {
    const { owner, ws } = await team()
    const { token, id } = await link(owner, ws, { role: 'viewer', maxUses: 3 })
    const guest = new Client(server)
    await guest.signup()
    for (let i = 0; i < 3; i++) assert.equal((await guest.post('/api/invites/accept', { token })).status, 200)
    const [row] = await server.db.select().from(invites).where(eq(invites.id, id))
    assert.equal(row.usesLeft, 2)
    assert.equal((await server.db.select().from(memberships).where(eq(memberships.workspaceId, ws))).length, 2)
  })

  it('never changes the role of someone who is already a member, up or down', async () => {
    const { owner, ws } = await team()
    const editorLink = await link(owner, ws, { role: 'editor' })
    const viewerLink = await link(owner, ws, { role: 'viewer' })

    const viewer = new Client(server)
    await viewer.signup('Vee')
    await viewer.post('/api/invites/accept', { token: viewerLink.token })
    const upgradeAttempt = await viewer.post('/api/invites/accept', { token: editorLink.token })
    assert.equal(upgradeAttempt.status, 200)
    assert.equal(upgradeAttempt.body.role, 'viewer', 'a link cannot promote you')

    const editor = new Client(server)
    await editor.signup('Ed')
    await editor.post('/api/invites/accept', { token: editorLink.token })
    assert.equal((await editor.post('/api/invites/accept', { token: viewerLink.token })).body.role, 'editor', 'a link cannot demote you')

    assert.equal((await owner.post('/api/invites/accept', { token: viewerLink.token })).body.role, 'owner', 'the owner stays owner')
  })

  it('refuses expired links', async () => {
    const { owner, ws } = await team()
    const { token, id } = await link(owner, ws)
    await server.db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, id))
    const guest = new Client(server)
    await guest.signup()
    assert.equal((await guest.post('/api/invites/accept', { token })).status, 404)
    assert.equal((await guest.get(`/api/workspaces/${ws}`)).status, 404)
  })

  it('refuses revoked links, even for someone who looked at the preview earlier', async () => {
    const { owner, ws } = await team()
    const { token, id } = await link(owner, ws)
    const guest = new Client(server)
    await guest.signup()
    assert.equal((await guest.post('/api/invites/preview', { token })).status, 200)
    await owner.delete(`/api/workspaces/${ws}/invites/${id}`)
    assert.equal((await guest.post('/api/invites/accept', { token })).status, 404)
  })

  it('lets a single-use link through to exactly one of five people clicking at once', async () => {
    const { owner, ws } = await team()
    const { token } = await link(owner, ws, { role: 'viewer', maxUses: 1 })
    const crowd = Array.from({ length: 5 }, () => new Client(server))
    for (const person of crowd) await person.signup()
    const replies = await Promise.all(crowd.map((person) => person.post('/api/invites/accept', { token })))
    assert.equal(replies.filter((reply) => reply.status === 200).length, 1)
    assert.equal(replies.filter((reply) => reply.status === 404).length, 4)
    assert.equal((await server.db.select().from(memberships).where(eq(memberships.workspaceId, ws))).length, 2)
  })

  it('stops at the member limit', async () => {
    const { owner, ws } = await team()
    const { token } = await link(owner, ws)
    const fakes = Array.from({ length: LIMITS.maxMembersPerWorkspace - 1 }, (_, i) => ({ email: `filler${i}-${ws}@example.com`, passwordHash: 'x', displayName: `Filler ${i}`, cursorColor: '#000000' }))
    const rows = await server.db.insert(users).values(fakes).returning({ id: users.id })
    await server.db.insert(memberships).values(rows.map((row) => ({ workspaceId: ws, userId: row.id, role: 'viewer' as const })))
    const latecomer = new Client(server)
    await latecomer.signup()
    const reply = await latecomer.post('/api/invites/accept', { token })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'workspace_full')
  })

  it('lets a removed member back in only with a link that is still valid', async () => {
    const { owner, ws } = await team()
    const first = await link(owner, ws, { role: 'editor', maxUses: 1 })
    const guest = new Client(server)
    const account = await guest.signup()
    await guest.post('/api/invites/accept', { token: first.token })
    await owner.delete(`/api/workspaces/${ws}/members/${account.user.id}`)
    assert.equal((await guest.post('/api/invites/accept', { token: first.token })).status, 404, 'the old, used-up link no longer works')
    const second = await link(owner, ws, { role: 'viewer' })
    assert.equal((await guest.post('/api/invites/accept', { token: second.token })).body.role, 'viewer')
  })

  it('stops working when the workspace is deleted', async () => {
    const { owner, ws } = await team()
    const extra = await owner.post('/api/workspaces', { name: 'Temporary' })
    const { token } = await link(owner, extra.body.id)
    assert.equal((await new Client(server).post('/api/invites/preview', { token })).status, 200)
    assert.equal((await owner.delete(`/api/workspaces/${extra.body.id}`)).status, 204)
    assert.equal((await new Client(server).post('/api/invites/preview', { token })).status, 404)
    assert.ok(ws)
  })
})

describe('guessing links', () => {
  it('is limited per address on both the public preview and accept', async () => {
    const limited = await startTestServer({ env: { CONFLUX_RATE_LIMIT_SCALE: '1' } })
    try {
      const guesser = new Client(limited)
      let blockedAfter = -1
      for (let i = 0; i < 40; i++) {
        const reply = await guesser.post('/api/invites/preview', { token: `${String(i).padStart(2, '0')}${'A'.repeat(41)}` })
        if (reply.status === 429) {
          blockedAfter = i
          break
        }
        assert.equal(reply.status, 404)
      }
      assert.equal(blockedAfter, 30, 'the 31st request in a minute is refused')
      // the same budget covers the signed-in endpoint
      const member = new Client(limited)
      await member.signup()
      assert.equal((await member.post('/api/invites/accept', { token: 'A'.repeat(43) })).status, 429)
    } finally {
      await limited.close()
    }
  })
})
